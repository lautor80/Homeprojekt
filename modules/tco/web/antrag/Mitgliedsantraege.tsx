import { useEffect, useState } from 'react';
import {
  Bar, Button, BusyIndicator, CheckBox, DatePicker, Dialog, Label, MessageStrip, ObjectStatus, Text, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';

/**
 * Mitgliedsanträge (online, /beitritt): Eingang prüfen (Dubletten, Angaben, Bankdaten nur mit Berechtigung im Klartext),
 * ablehnen mit Begründung oder übernehmen – legt Mitglieder, Verträge, SEPA-Mandat und Portalbenutzer (Rolle Mitglied) an.
 */
const A = `${TCO}/mitgliedsantraege`;
interface Person { anrede: string; vorname: string; nachname: string; geburtsdatum: string; email: string | null; telefon: string | null; art: string | null; training?: string[] }
interface Antrag {
  id: number; nummer: string; status: 'EINGANG' | 'UEBERNOMMEN' | 'ABGELEHNT'; eingang: string;
  daten: { personen: Person[]; strasse: string; plz: string; ort: string; email: string; telefon: string | null; erziehungsberechtigt: string | null;
    eintritt: string; satzung: boolean; datenschutz: boolean; bildrechte: boolean; kuendigung?: boolean; bemerkung: string | null };
  kontoinhaber: string; iban: string; bic: string | null; bank: string | null; sepa_am: string | null;
  bearbeitet_am: string | null; bearbeitet_von: string | null; bemerkung: string | null; hinweise: string[];
  ergebnis: { mitglieder: { adrnr: string; mitglnrn: string; name: string }[]; mandat: string; benutzer: { name: string; username: string; hinweis: string }[] } | null;
}
interface Ergebnis { text: string; startkennwoerter: { name: string; username: string; startkennwort: string | null }[] }
const zeit = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const STATUS = { EINGANG: ['Eingang', 'Critical'], UEBERNOMMEN: ['übernommen', 'Positive'], ABGELEHNT: ['abgelehnt', 'Negative'] } as const;

export function Mitgliedsantraege() {
  const can = useCan();
  const edit = can('tco.antraege:edit');
  const [liste, setListe] = useState<Antrag[] | null>(null);
  const [arten, setArten] = useState<Record<string, string>>({});
  const [alle, setAlle] = useState(false);
  const [offen, setOffen] = useState<Antrag | null>(null);
  const [weg, setWeg] = useState<Antrag | null>(null);
  const [start, setStart] = useState<Ergebnis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Antrag[]>(`${A}?status=${alle ? 'ALLE' : 'EINGANG'}`).then(setListe).catch((e) => setError(e.message));
  useEffect(() => { setListe(null); laden(); }, [alle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.get<{ beitragsarten: { art: string; name: string }[] }>(`${TCO}/antrag`).then((i) => setArten(Object.fromEntries(i.beitragsarten.map((b) => [b.art, b.name])))).catch(() => undefined);
  }, []);

  async function ablehnen(a: Antrag, grund: string) {
    try {
      const r = await api.post<{ text: string }>(`${A}/${a.id}/ablehnen`, { grund });
      toast(r.text, 6000);
      laden();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <AppPage title="Mitgliedsanträge" subtitle="Online eingegangene Anträge (Formular /beitritt)"
             actions={<>
               <Button design="Transparent" icon="action" onClick={() => window.open('/beitritt', '_blank')}>Antragsformular öffnen</Button>
               <Button design="Transparent" icon={alle ? 'filter' : 'history'} onClick={() => setAlle(!alle)}>{alle ? 'Nur Eingang' : 'Auch erledigte'}</Button>
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!liste ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : !liste.length ? (
        <MessageStrip hideCloseButton>Keine offenen Anträge. Link zum Formular für Website und Aushang: <b>{window.location.origin}/beitritt</b></MessageStrip>
      ) : liste.map((a) => (
        <Section key={a.id} title={`${a.nummer} · ${a.daten.personen.map((p) => `${p.vorname} ${p.nachname}`).join(', ')}`}
                 status={<ObjectStatus state={STATUS[a.status][1]} inverted>{STATUS[a.status][0]}</ObjectStatus>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '0.75rem 1.5rem' }}>
            <div>
              <Label>Eingang</Label><br /><Text>{zeit(a.eingang)} · Eintritt ab {dat(a.daten.eintritt)}</Text><br />
              <Label>Anschrift</Label><br /><Text>{a.daten.strasse}, {a.daten.plz} {a.daten.ort}</Text><br />
              <Label>Kontakt</Label><br /><Text>{a.daten.email}{a.daten.telefon ? ` · ${a.daten.telefon}` : ''}</Text>
              {a.daten.erziehungsberechtigt && <><br /><Label>Erziehungsberechtigt</Label><br /><Text>{a.daten.erziehungsberechtigt}</Text></>}
            </div>
            <div>
              <Label>Personen</Label>
              {a.daten.personen.map((p, i) => (
                <div key={i}><Text>{p.anrede} {p.vorname} {p.nachname}, geb. {dat(p.geburtsdatum)} – {p.art ? arten[p.art] ?? `Beitragsart ${p.art}` : 'über Familienbeitrag'}{p.training?.length ? ` + ${p.training.map((t) => arten[t] ?? t).join(' + ')}` : ''}{p.email && p.email !== a.daten.email ? ` · ${p.email}` : ''}</Text></div>
              ))}
            </div>
            <div>
              <Label>SEPA-Mandat (online erteilt{a.sepa_am ? ` am ${zeit(a.sepa_am)}` : ''})</Label><br />
              <Text>{a.kontoinhaber} · {a.iban}{a.bic ? ` · ${a.bic}` : ''}{a.bank ? ` · ${a.bank}` : ''}</Text><br />
              <Label>Zustimmungen</Label><br />
              <Text>Satzung {a.daten.satzung ? '✓' : '✗'} · Datenschutz {a.daten.datenschutz ? '✓' : '✗'} · Kündigungsfristen {a.daten.kuendigung ? '✓' : '✗'} · Fotos {a.daten.bildrechte ? '✓' : '✗'}</Text>
            </div>
          </div>
          {a.daten.bemerkung && <MessageStrip design="Information" hideCloseButton style={{ marginTop: '0.5rem' }}>Mitteilung: {a.daten.bemerkung}</MessageStrip>}
          {a.hinweise.map((h) => <MessageStrip key={h} design={h.includes('Schnuppertraining') ? 'Information' : 'Critical'} hideCloseButton style={{ marginTop: '0.5rem' }}>{h}</MessageStrip>)}
          {a.status === 'EINGANG' && edit && (
            <div className="portal-row" style={{ marginTop: '0.75rem' }}>
              <Button design="Emphasized" icon="accept" onClick={() => setOffen(a)}>Übernehmen…</Button>
              <Button design="Transparent" icon="decline" onClick={() => setWeg(a)}>Ablehnen</Button>
            </div>
          )}
          {a.status !== 'EINGANG' && (
            <Text className="portal-muted" style={{ display: 'block', marginTop: '0.5rem' }}>
              {a.status === 'UEBERNOMMEN' && a.ergebnis
                ? `Übernommen: ${a.ergebnis.mitglieder.map((m) => `${m.name} (Nr. ${m.mitglnrn})`).join(', ')}${a.ergebnis.mandat ? ` · Mandat ${a.ergebnis.mandat}` : ''} · Benutzer: ${a.ergebnis.benutzer.map((b) => b.username || b.hinweis).join(', ')}`
                : `Abgelehnt${a.bemerkung ? `: ${a.bemerkung}` : ''}`} – {a.bearbeitet_von}{a.bearbeitet_am ? `, ${zeit(a.bearbeitet_am)}` : ''}
            </Text>
          )}
        </Section>
      ))}
      {offen && <UebernahmeDialog a={offen} onClose={() => setOffen(null)} onDone={(r) => { setOffen(null); toast(r.text, 8000); if (r.startkennwoerter.length) setStart(r); laden(); }} />}
      <ConfirmDialog open={!!weg} danger askReason title="Antrag ablehnen" confirmText="Ablehnen"
                     text={`Antrag ${weg?.nummer ?? ''} ablehnen? Die Begründung wird dem Antragsteller per E-Mail mitgeteilt.`}
                     onCancel={() => setWeg(null)} onConfirm={(grund) => { const a = weg!; setWeg(null); ablehnen(a, grund); }} />
      {start && (
        <Dialog open headerText="Startkennwörter" onClose={() => setStart(null)} footer={<Bar endContent={<Button design="Emphasized" onClick={() => setStart(null)}>Schließen</Button>} />}>
          <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Diese Kennwörter werden nur jetzt angezeigt – bitte sicher weitergeben (Pflichtänderung bei der ersten Anmeldung).</MessageStrip>
          {start.startkennwoerter.map((s) => <div key={s.username}><Text>{s.name}: <b>{s.username}</b> / <code>{s.startkennwort}</code></Text></div>)}
        </Dialog>
      )}
    </AppPage>
  );
}

function UebernahmeDialog({ a, onClose, onDone }: { a: Antrag; onClose: () => void; onDone: (r: Ergebnis) => void }) {
  const [eintritt, setEintritt] = useState(a.daten.eintritt);
  const [mail, setMail] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function los() {
    setBusy(true); setError(null);
    try { onDone(await api.post<Ergebnis>(`${A}/${a.id}/uebernehmen`, { eintritt, mail })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`Antrag ${a.nummer} übernehmen`} style={{ width: 'min(34rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="accept" loading={busy} disabled={!a.hinweise.every((h) => !h.includes('gesperrt'))} onClick={los}>Übernehmen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Title level="H6">Es wird angelegt</Title>
        <Text>
          {a.daten.personen.length === 1 ? 'Ein Mitglied' : `${a.daten.personen.length} Mitglieder (Familie, ein Beitragszahler)`} mit Vertrag je Beitragsart,
          SEPA-Mandat zum Zeitpunkt der Online-Erteilung und je Person ein Portalbenutzer mit der Rolle „Mitglied“.
        </Text>
        <Label showColon>Eintritt</Label>
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={eintritt} onChange={(e) => setEintritt(e.detail.value)} />
        <CheckBox text="Per E-Mail benachrichtigen (Aufnahmebestätigung, Link zum Festlegen des Kennworts)" checked={mail} onChange={(e) => setMail(e.target.checked)} />
        {!a.hinweise.every((h) => !h.includes('gesperrt')) && <MessageStrip design="Negative" hideCloseButton>Eine Person ist bereits Mitglied – Übernahme gesperrt. Bitte ablehnen oder den Bestand prüfen.</MessageStrip>}
      </div>
    </Dialog>
  );
}
