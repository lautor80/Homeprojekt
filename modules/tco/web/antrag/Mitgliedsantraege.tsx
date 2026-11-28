import { useEffect, useMemo, useState } from 'react';
import { feld } from '@core/components/Varianten';
import {
  Button, BusyIndicator, CheckBox, DatePicker, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { PdfDialog } from '@core/components/PdfDialog';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { useCan, useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import { portalAdresse } from '@core/branding';
import { BeitragsUebersicht, type Bestand } from './Beitritt';

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
  ergebnis: { mitglieder: { adrnr: string; mitglnrn: string; name: string; bestand?: boolean }[]; mandat: string; benutzer: { name: string; username: string; hinweis: string }[]; hinweise?: string[] } | null;
}
interface Ergebnis {
  text: string; startkennwoerter: { name: string; username: string; startkennwort: string | null }[];
  /** Mitgliederinformation je neuem Mitglied (#12) – zum Drucken, ggf. in Paperless abgelegt */
  unterlagen?: { adrnr: string; name: string; url: string; ablage: string }[];
}
const zeit = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const STATUS = { EINGANG: ['Eingang', 'Critical'], UEBERNOMMEN: ['übernommen', 'Positive'], ABGELEHNT: ['abgelehnt', 'Negative'] } as const;

export function Mitgliedsantraege() {
  const can = useCan();
  /** Funktionsschalter (#232, F1): das öffentliche Antragsformular lässt sich abschalten */
  const formularAn = useFunktion()('tco.antrag.formular');
  const edit = can('tco.antraege:edit');
  const [liste, setListe] = useState<Antrag[] | null>(null);
  const [arten, setArten] = useState<Record<string, string>>({});
  /** Beitragsarten mit Betrag und Turnus – für die Beitragsübersicht in „Vertragsangebot ansehen“ */
  const [beitragsarten, setBeitragsarten] = useState<Beitragsart[]>([]);
  const [alle, setAlle] = useState(false);
  const [offen, setOffen] = useState<Antrag | null>(null);
  const [weg, setWeg] = useState<Antrag | null>(null);
  const [start, setStart] = useState<Ergebnis | null>(null);
  const [druck, setDruck] = useState<NonNullable<Ergebnis['unterlagen']> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [angebotNeu, setAngebotNeu] = useState(false);
  const [angebotVersion, setAngebotVersion] = useState(0);
  const laden = () => api.get<Antrag[]>(`${A}?status=${alle ? 'ALLE' : 'EINGANG'}`).then(setListe).catch((e) => setError(e.message));
  useEffect(() => { setListe(null); laden(); }, [alle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.get<{ beitragsarten: Beitragsart[] }>(`${TCO}/antrag`).then((i) => { setBeitragsarten(i.beitragsarten); setArten(Object.fromEntries(i.beitragsarten.map((b) => [b.art, b.name]))); }).catch(() => undefined);
  }, []);

  async function ablehnen(a: Antrag, grund: string) {
    try {
      const r = await api.post<{ text: string }>(`${A}/${a.id}/ablehnen`, { grund });
      toast(r.text, 6000);
      laden();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <AppPage varianten={{ repid: 'tco.antraege', ansicht: { alle }, onAnwenden: (a) => { setAlle(feld(a, 'alle', alle)); } }} title="Mitgliedsanträge" subtitle="Online eingegangene Anträge (Formular /beitritt)"
             actions={<>
               {edit && <Button design="Emphasized" icon="email" disabled={!formularAn} onClick={() => setAngebotNeu(true)}
                                tooltip={formularAn ? undefined : 'Der Online-Mitgliedsantrag ist abgeschaltet – ein Vertragsangebot ließe sich nicht bestätigen'}>Vertragsangebot erstellen</Button>}
               {formularAn && <Button design="Transparent" icon="action" onClick={() => window.open('/beitritt', '_blank')}>Antragsformular öffnen</Button>}
               <Button design="Transparent" icon={alle ? 'filter' : 'history'} onClick={() => setAlle(!alle)}>{alle ? 'Nur Eingang' : 'Auch erledigte'}</Button>
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!formularAn && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Der Online-Mitgliedsantrag ist abgeschaltet (Administration → Einstellungen → Funktionen): Das Formular /beitritt nimmt keine Anträge an,
          offene Vertragsangebote lassen sich nicht bestätigen. Eingegangene Anträge können weiter bearbeitet werden.
        </MessageStrip>
      )}
      <Angebote alle={alle} edit={edit} arten={arten} beitragsarten={beitragsarten} version={angebotVersion} onError={setError} />
      {!liste ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : !liste.length ? (
        <MessageStrip hideCloseButton>Keine offenen Anträge.{formularAn && <> Link zum Formular für Website und Aushang: <b>{portalAdresse()}/beitritt</b></>}</MessageStrip>
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
          {a.hinweise.map((h) => <MessageStrip key={h} design={h.includes('Schnuppertraining') || h.includes('Vertragsangebot') ? 'Information' : 'Critical'} hideCloseButton style={{ marginTop: '0.5rem' }}>{h}</MessageStrip>)}
          {a.status === 'EINGANG' && edit && (
            <div className="portal-row" style={{ marginTop: '0.75rem' }}>
              <Button design="Emphasized" icon="accept" onClick={() => setOffen(a)}>Übernehmen…</Button>
              <Button design="Transparent" icon="decline" onClick={() => setWeg(a)}>Ablehnen</Button>
            </div>
          )}
          {a.status !== 'EINGANG' && (
            <Text className="portal-muted" style={{ display: 'block', marginTop: '0.5rem' }}>
              {a.status === 'UEBERNOMMEN' && a.ergebnis
                ? `Übernommen: ${a.ergebnis.mitglieder.map((m) => `${m.name} (Nr. ${m.mitglnrn}${m.bestand ? ', Vertragsänderung' : ''})`).join(', ')}${a.ergebnis.mandat ? ` · Mandat ${a.ergebnis.mandat}` : ''}${a.ergebnis.benutzer.length ? ` · Benutzer: ${a.ergebnis.benutzer.map((b) => b.username || b.hinweis).join(', ')}` : ''}${a.ergebnis.hinweise?.length ? ` · ${a.ergebnis.hinweise.join(' ')}` : ''}`
                : `Abgelehnt${a.bemerkung ? `: ${a.bemerkung}` : ''}`} – {a.bearbeitet_von}{a.bearbeitet_am ? `, ${zeit(a.bearbeitet_am)}` : ''}
            </Text>
          )}
        </Section>
      ))}
      {angebotNeu && <AngebotDialog onClose={() => setAngebotNeu(false)} onDone={() => { setAngebotNeu(false); setAngebotVersion((v) => v + 1); }} />}
      {offen && <UebernahmeDialog a={offen} onClose={() => setOffen(null)} onDone={(r) => { setOffen(null); toast(r.text, 8000); if (r.startkennwoerter.length) setStart(r); if (r.unterlagen?.length) setDruck(r.unterlagen); laden(); }} />}
      {druck && !start && <MitgliederinfoDruck liste={druck} onClose={() => setDruck(null)} />}
      <ConfirmDialog open={!!weg} danger askReason title="Antrag ablehnen" confirmText="Ablehnen"
                     text={`Antrag ${weg?.nummer ?? ''} ablehnen? Die Begründung wird dem Antragsteller per E-Mail mitgeteilt.`}
                     onCancel={() => setWeg(null)} onConfirm={(grund) => { const a = weg!; setWeg(null); ablehnen(a, grund); }} />
      {start && (
        <Dialog open headerText="Startkennwörter" onClose={() => setStart(null)} footer={<FussLeiste endContent={<Button design="Emphasized" onClick={() => setStart(null)}>Schließen</Button>} />}>
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
  const [unterlagen, setUnterlagen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function los() {
    setBusy(true); setError(null);
    try { onDone(await api.post<Ergebnis>(`${A}/${a.id}/uebernehmen`, { eintritt, mail, unterlagen })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`Antrag ${a.nummer} übernehmen`} style={{ width: 'min(34rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<>
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
        <CheckBox text="Mitgliederinformation erzeugen und zum Druck öffnen (mit Paperless: dort ablegen)" checked={unterlagen} onChange={(e) => setUnterlagen(e.target.checked)} />
        {!a.hinweise.every((h) => !h.includes('gesperrt')) && <MessageStrip design="Negative" hideCloseButton>Eine Person ist bereits Mitglied – Übernahme gesperrt. Bitte ablehnen oder den Bestand prüfen.</MessageStrip>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Vertragsangebote (#12): vorbereiteter Antrag per E-Mail-Link (Zufallsschlüssel, Öffnen mit Geburtsdatum, 30 Tage, einmalig)
// ---------------------------------------------------------------------------------------------------------------
interface AngebotZeile {
  id: number; nummer: string; status: 'OFFEN' | 'ANGENOMMEN' | 'ZURUECKGEZOGEN' | 'ABGELAUFEN'; email: string; gueltig_bis: string;
  erstellt_am: string; erstellt_von: string | null; geoeffnet_am: string | null; antrag: string | null; eintritt: string;
  personen: { name: string; stamm: boolean; art: string | null; training: string[] }[];
}
const A_STATUS = { OFFEN: ['offen', 'Information'], ANGENOMMEN: ['angenommen', 'Positive'], ZURUECKGEZOGEN: ['zurückgezogen', 'None'], ABGELAUFEN: ['abgelaufen', 'Critical'] } as const;

function Angebote({ alle, edit, arten, beitragsarten, version, onError }: { alle: boolean; edit: boolean; arten: Record<string, string>; beitragsarten: Beitragsart[]; version: number; onError: (t: string) => void }) {
  const [liste, setListe] = useState<AngebotZeile[] | null>(null);
  const [link, setLink] = useState<{ nummer: string; link: string; text: string } | null>(null);
  const [ansicht, setAnsicht] = useState<number | null>(null);
  /** Korrektur eines offenen Angebots: derselbe Dialog wie beim Erstellen, vorbelegt mit dem Inhalt */
  const [korrektur, setKorrektur] = useState<AngebotInhalt | null>(null);
  const laden = () => api.get<{ liste: AngebotZeile[] }>(`${A}/angebote?alle=${alle ? '1' : '0'}`).then((r) => setListe(r.liste)).catch((e) => onError(e.message));
  useEffect(() => { laden(); }, [alle, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const aktion = async (fn: () => Promise<{ text: string; link?: string; nummer?: string }>) => {
    try { const r = await fn(); toast(r.text, 6000); if (r.link && r.nummer) setLink({ nummer: r.nummer, link: r.link, text: r.text }); laden(); } catch (e) { onError((e as Error).message); }
  };
  if (!liste?.length) return null;
  return (
    <Section title="Vertragsangebote" count={liste.length}>
      {liste.map((g) => (
        <div key={g.id} className="portal-row" style={{ justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
          <div style={{ minWidth: 0 }}>
            <Text><b>{g.nummer}</b> · {g.personen.map((p) => p.name).join(', ')}</Text><br />
            <Text className="portal-muted portal-small">
              {g.personen.map((p) => [p.art ? arten[p.art] ?? p.art : 'über Familienbeitrag', ...p.training.map((t) => arten[t] ?? t)].join(' + ')).join(' · ')}
              {' '}· Eintritt {dat(g.eintritt)} · an {g.email} · gültig bis {dat(g.gueltig_bis)}
              {g.geoeffnet_am ? ` · geöffnet ${zeit(g.geoeffnet_am)}` : ' · noch nicht geöffnet'}{g.antrag ? ` · Antrag ${g.antrag}` : ''}
            </Text>
          </div>
          <div className="portal-row">
            <ObjectStatus state={A_STATUS[g.status][1]} inverted>{A_STATUS[g.status][0]}</ObjectStatus>
            <Button design="Transparent" icon="display" tooltip="Inhalt des Angebots ansehen" onClick={() => setAnsicht(g.id)}>Ansehen</Button>
            {edit && (g.status === 'OFFEN' || g.status === 'ABGELAUFEN') && <>
              <Button design="Transparent" icon="refresh" tooltip="Neuen Link senden (der alte wird ungültig, wieder 30 Tage gültig)"
                      onClick={() => aktion(() => api.post(`${A}/angebote/${g.id}/erneuern`, { mail: true }))}>Neu senden</Button>
              <Button design="Transparent" icon="decline" tooltip="Zurückziehen – der Link wird ungültig"
                      onClick={() => aktion(() => api.post(`${A}/angebote/${g.id}/zurueckziehen`, {}))} />
            </>}
          </div>
        </div>
      ))}
      {link && <LinkDialog {...link} onClose={() => setLink(null)} />}
      {ansicht !== null && <AngebotAnsicht id={ansicht} arten={arten} beitragsarten={beitragsarten} edit={edit} onClose={() => setAnsicht(null)}
                                           onKorrigieren={(a) => { setAnsicht(null); setKorrektur(a); }} />}
      {korrektur && <AngebotDialog bearbeiten={korrektur} onClose={() => setKorrektur(null)} onDone={() => { setKorrektur(null); laden(); }} />}
    </Section>
  );
}

interface AngebotInhalt {
  id: number; nummer: string; status: AngebotZeile['status']; email: string; gueltig_bis: string; erstellt_am: string; erstellt_von: string | null;
  geoeffnet_am: string | null; versuche: number; antrag: string | null; schnupper: string | null;
  personen: { adrnr: string | null; anrede: string; vorname: string; nachname: string; geburtsdatum: string | null; email: string | null; telefon: string | null; art: string | null; training: string[];
    /** aktives Mitglied: laufende Vertragsarten und Mitgliedschaften, die mit der Umstellung enden (nur bei offenen Angeboten) */
    bestand?: Bestand | null }[];
  strasse: string; plz: string; ort: string; telefon: string | null; erziehungsberechtigt: string | null; eintritt: string; bemerkung: string | null; vertragsaenderung: boolean;
  bank: { kontoinhaber: string; iban: string; bic: string | null; zahler: string | null } | null;
  versand: { zeit: string; an: string; betreff: string; status: string; fehler: string | null }[];
  /** z. B. Dublette: Person wird neu aufgenommen, ist aber unter anderem Stammsatz schon Mitglied */
  hinweise?: string[];
}

/** Alter am Stichtag (für „minderjährig“ wie im Formular) */
const alterAm = (geb: string, stichtag: string) => {
  const [j, m, d] = geb.split('-').map(Number);
  const [sj, sm, sd] = stichtag.split('-').map(Number);
  return sj - j - (sm < m || (sm === m && sd < d) ? 1 : 0);
};

/**
 * Inhalt eines Vertragsangebots – auch nach dem Versand einsehbar. Oben derselbe Aufbau wie bei der Person (Personen und Verträge,
 * Anschrift und Kontakt, Beiträge und Fälligkeit mit Beträgen, Bankverbindung), darunter die Verwaltungsangaben (Link, Versand).
 * Offene Angebote lassen sich von hier aus korrigieren – danach geht der berichtigte Stand mit neuem Link an die Person.
 */
function AngebotAnsicht({ id, arten, beitragsarten, edit, onClose, onKorrigieren }: {
  id: number; arten: Record<string, string>; beitragsarten: Beitragsart[]; edit: boolean; onClose: () => void; onKorrigieren: (a: AngebotInhalt) => void;
}) {
  const [a, setA] = useState<AngebotInhalt | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { api.get<AngebotInhalt>(`${A}/angebote/${id}`).then(setA).catch((e) => setFehler(e.message)); }, [id]);
  const zeile = (k: string, v: React.ReactNode) => v ? (
    <div className="portal-row" style={{ alignItems: 'flex-start', padding: '0.15rem 0' }}>
      <Label style={{ minWidth: '10rem' }}>{k}</Label><Text style={{ whiteSpace: 'pre-wrap' }}>{v}</Text>
    </div>) : null;
  const offen = !!a && (a.status === 'OFFEN' || a.status === 'ABGELAUFEN');
  // wie beim Öffnen des Links: ein inzwischen vergangener Eintritt wird für die Person zu „heute“
  const eintritt = a ? (offen && a.eintritt < heuteIso() ? heuteIso() : a.eintritt) : '';
  const minderjaehrig = !!a?.personen[0]?.geburtsdatum && alterAm(a.personen[0].geburtsdatum, heuteIso()) < 18;
  /** fehlt etwas davon, sieht die Person statt „Bestätigen“ das Formular und ergänzt selbst */
  const fehlt = !a ? [] : [
    ...a.personen.flatMap((p) => [!p.anrede && `Anrede ${p.vorname} ${p.nachname}`, !p.geburtsdatum && `Geburtsdatum ${p.vorname} ${p.nachname}`]),
    !(a.strasse && a.plz && a.ort) && 'Anschrift', minderjaehrig && !a.erziehungsberechtigt && 'Erziehungsberechtigte/r',
  ].filter((x): x is string => !!x);
  return (
    <Dialog open headerText={a ? `Vertragsangebot ${a.nummer}` : 'Vertragsangebot'} style={{ width: 'min(46rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<>
              {a && edit && offen && <Button icon="edit" tooltip="Inhalt berichtigen – die Person erhält den korrigierten Stand mit neuem Link" onClick={() => onKorrigieren(a)}>Korrigieren…</Button>}
              <Button design="Emphasized" onClick={onClose}>Schließen</Button>
            </>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton>{fehler}</MessageStrip>}
      {!a && !fehler && <BusyIndicator active />}
      {a && <>
        <div className="portal-row" style={{ marginBottom: '0.5rem' }}>
          <ObjectStatus state={A_STATUS[a.status][1]} inverted>{A_STATUS[a.status][0]}</ObjectStatus>
          {a.vertragsaenderung && <ObjectStatus state="Information">Vertragsänderung</ObjectStatus>}
        </div>
        {a.bemerkung && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Hinweis des Vereins (steht im Formular): {a.bemerkung}</MessageStrip>}
        {(a.hinweise ?? []).map((h) => <MessageStrip key={h} design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{h}</MessageStrip>)}
        {offen && fehlt.length > 0 && (
          <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
            Nicht vollständig vorbereitet – es fehlt: {fehlt.join(', ')}. Die Person sieht deshalb das Formular zum Ergänzen statt nur „Bestätigen“.
          </MessageStrip>
        )}

        <Title level="H5" style={{ marginBottom: '0.5rem' }}>Personen und Verträge</Title>
        {a.personen.map((p, i) => (
          <div key={i} style={{ marginBottom: '0.35rem' }}>
            <Text style={{ display: 'block' }}>
              <b>{[p.anrede, p.vorname, p.nachname].filter(Boolean).join(' ')}</b>, {p.geburtsdatum ? `geb. ${dat(p.geburtsdatum)}` : 'ohne Geburtsdatum'} –{' '}
              {[p.art ? arten[p.art] ?? p.art : (a.vertragsaenderung ? 'Mitgliedschaft unverändert' : 'über den Familienbeitrag'), ...p.training.map((t) => arten[t] ?? t)].join(' + ')}
            </Text>
            <Text className="portal-muted portal-small" style={{ display: 'block' }}>
              {[p.adrnr ? `Stamm ${p.adrnr}` : 'neu erfasst', p.bestand ? 'aktives Mitglied – Vertragsumstellung' : offen ? 'wird neu aufgenommen' : '', p.email, p.telefon].filter(Boolean).join(' · ')}
            </Text>
          </div>
        ))}

        <Title level="H5" style={{ margin: '0.75rem 0 0.25rem' }}>Anschrift und Kontakt</Title>
        <Text style={{ display: 'block' }}>
          {[[a.strasse, [a.plz, a.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || 'ohne Anschrift', a.email, a.telefon].filter(Boolean).join(' · ')}
        </Text>
        {a.erziehungsberechtigt && <Text style={{ display: 'block' }}>Erziehungsberechtigte/r: {a.erziehungsberechtigt}</Text>}
        <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
          Eintritt: {dat(eintritt)}{eintritt !== a.eintritt ? ` (erfasst ${dat(a.eintritt)} – liegt zurück, für die Person gilt der heutige Tag)` : ''}
        </Text>

        {beitragsarten.length ? (
          <BeitragsUebersicht info={{ beitragsarten }} eintritt={eintritt} aenderung={a.vertragsaenderung}
                              personen={a.personen.map((p) => ({ vorname: p.vorname, nachname: p.nachname, art: p.art ?? '', training: p.training, bestand: p.bestand }))} />
        ) : <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>Beiträge und Fälligkeit: Beitragsarten nicht verfügbar (Online-Mitgliedsantrag abgeschaltet).</Text>}

        <Title level="H5" style={{ margin: '0.5rem 0 0.25rem' }}>Bankverbindung (SEPA-Lastschrift)</Title>
        <Text style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
          {a.bank
            ? `${a.bank.kontoinhaber} · IBAN ${a.bank.iban}${a.bank.bic ? ` · ${a.bank.bic}` : ''}${a.bank.zahler ? `\nZahler: ${a.bank.zahler}` : ''}\nDie Person sieht die IBAN nur gekürzt und bestätigt das Mandat.`
            : 'keine hinterlegt – die Person gibt Kontoinhaber/in und IBAN beim Annehmen ein'}
        </Text>

        <Title level="H5" style={{ marginTop: '0.9rem' }}>Link und Versand</Title>
        {zeile('Erstellt', `${zeit(a.erstellt_am)}${a.erstellt_von ? ` von ${a.erstellt_von}` : ''}`)}
        {zeile('Link an', a.email)}
        {zeile('Gültig bis', dat(a.gueltig_bis))}
        {zeile('Geöffnet', a.geoeffnet_am ? zeit(a.geoeffnet_am) : 'noch nicht geöffnet')}
        {a.versuche > 0 && zeile('Fehlversuche', `${a.versuche} falsche Geburtsdaten`)}
        {zeile('Antrag', a.antrag)}
        {zeile('Schnuppertraining', a.schnupper)}
        {a.versand.length ? a.versand.map((v, i) => (
          <Text key={i} className="portal-small" style={{ display: 'block' }}>
            {zeit(v.zeit)} · an {v.an} · {v.betreff} · {v.status}{v.fehler ? ` (${v.fehler})` : ''}
          </Text>
        )) : <Text className="portal-muted portal-small">Kein Versand protokolliert (Link selbst weitergegeben oder Protokoll älter als 180 Tage).</Text>}
      </>}
    </Dialog>
  );
}

function LinkDialog({ nummer, link, text, onClose }: { nummer: string; link: string; text: string; onClose: () => void }) {
  return (
    <Dialog open headerText={`Vertragsangebot ${nummer}`} style={{ width: 'min(40rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<>
              <Button icon="copy" onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Link kopiert'))}>Link kopieren</Button>
              <Button design="Emphasized" onClick={onClose}>Schließen</Button>
            </>} />}>
      <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '0.5rem' }}>{text}</MessageStrip>
      <Text className="portal-muted portal-small">Persönlicher Link (z. B. für WhatsApp) – nur einmal verwendbar, Öffnen mit dem Geburtsdatum:</Text>
      <Input readonly value={link} style={{ width: '100%' }} />
    </Dialog>
  );
}

interface Beitragsart { art: string; name: string; betrag: number; turnus: string; kategorie: 'MITGLIEDSCHAFT' | 'TRAINING'; familie: boolean }
interface Kandidat {
  adrnr: string; name: string; geburtsdatum: string | null; ort: string; email: string; schnupper: string | null;
  /** Anrede aus dem Stamm ('' = keine) */
  anrede?: string | null;
  /** aktives Mitglied (Mitgliedsnummer) – Angebot = Vertragsänderung; Zahler, wenn nicht Selbstzahler; laufende Vertragsarten */
  mitglied: string | null; zahler: string | null; vertraege: string[]; vertragsnamen: string[];
}
/** Bankverbindung aus dem Stamm (bei abweichendem Zahler dessen) – IBAN nur gekürzt */
interface StammBank { kontoinhaber: string; iban: string; zahler: string | null }
interface APerson { adrnr: string | null; neu: boolean; anrede: string; vorname: string; nachname: string; geburtsdatum: string; email: string; art: string; training: string[]; info?: Kandidat }
const leerePerson = (): APerson => ({ adrnr: null, neu: false, anrede: '', vorname: '', nachname: '', geburtsdatum: '', email: '', art: '', training: [] });
const heuteIso = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
const ANREDEN = ['Frau', 'Herr', 'Divers'];
/** Stammsatz ohne (gültige) Anrede bzw. ohne Geburtsdatum – dann wird der Wert im Angebot erfasst */
const anredeFehlt = (k: Kandidat | undefined) => !!k && !ANREDEN.includes(k.anrede ?? '');
const geburtFehlt = (k: Kandidat | undefined) => !!k && !k.geburtsdatum;

/**
 * `start`: Aufruf aus der Schnupperverwaltung – Person 1 (Stammsatz) wird nach dem Laden der Kandidaten vorbelegt,
 * dazu E-Mail für den Link und Erziehungsberechtigte/r.
 */
export function AngebotDialog({ onClose, onDone, start, bearbeiten }: {
  onClose: () => void; onDone: () => void;
  start?: { adrnr: string; email?: string | null; erziehungsberechtigt?: string | null };
  /** Korrektur eines offenen Angebots: alle Felder mit dem Inhalt vorbelegt; Sichern ersetzt den Inhalt und verschickt einen neuen Link */
  bearbeiten?: AngebotInhalt;
}) {
  const [arten, setArten] = useState<Beitragsart[]>([]);
  const [personen, setPersonen] = useState<APerson[]>(() => (bearbeiten
    ? bearbeiten.personen.map((p, i) => ({
      adrnr: p.adrnr, neu: !p.adrnr, anrede: p.anrede ?? '', vorname: p.vorname, nachname: p.nachname, geburtsdatum: p.geburtsdatum ?? '',
      email: p.email ?? '', art: i === 0 ? p.art ?? '' : '', training: p.training ?? [],
    }))
    : [leerePerson()]));
  const [kandidaten, setKandidaten] = useState<Kandidat[]>([]);
  const [kontoinhaber, setKontoinhaber] = useState('');
  const [iban, setIban] = useState('');
  const [eintritt, setEintritt] = useState(bearbeiten?.eintritt ?? heuteIso());
  const [email, setEmail] = useState(bearbeiten?.email ?? start?.email ?? '');
  const [erz, setErz] = useState(bearbeiten?.erziehungsberechtigt ?? start?.erziehungsberechtigt ?? '');
  const [hinweis, setHinweis] = useState(bearbeiten?.bemerkung ?? '');
  const [mail, setMail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<{ nummer: string; link: string; text: string } | null>(null);
  /** Bankverbindung des Antragstellers aus dem Stamm (maskiert); „andere“ = Vorstand erfasst eine neue */
  const [stammBank, setStammBank] = useState<StammBank | null>(null);
  const [andereBank, setAndereBank] = useState(false);
  /** Korrektur: die im Angebot hinterlegte Bankverbindung behalten (solange der Antragsteller derselbe bleibt) */
  const [angebotsBank, setAngebotsBank] = useState(!!bearbeiten?.bank);
  /** E-Mail an die Person – Vorlage mit Platzhaltern, anpassbar */
  const [mailBetreff, setMailBetreff] = useState('');
  const [mailText, setMailText] = useState('');
  useEffect(() => { api.get<{ beitragsarten: Beitragsart[] }>(`${TCO}/antrag`).then((i) => setArten(i.beitragsarten)).catch((e) => setError(e.message)); }, []);
  useEffect(() => { api.get<{ betreff: string; text: string }>(`${A}/angebote/mailvorlage`).then((v) => { setMailBetreff(v.betreff); setMailText(v.text); }).catch(() => undefined); }, []);
  // Antragsteller aus dem Stamm: Bankverbindung (bzw. die des abweichenden Zahlers) maskiert anzeigen
  const erster = personen[0].neu ? null : personen[0].adrnr;
  useEffect(() => {
    setStammBank(null); setAndereBank(false);
    if (bearbeiten && erster !== (bearbeiten.personen[0].adrnr ?? null)) setAngebotsBank(false);
    if (erster) api.get<{ bank: StammBank | null }>(`${A}/angebote/personen/${erster}/bank`).then((r) => setStammBank(r.bank)).catch(() => undefined);
  }, [erster]);
  // alle Personen (ohne Mitgliedschaft und aktive Mitglieder) einmal laden – gesucht wird im Feld (schnell, ohne Neuladen beim Tippen)
  useEffect(() => {
    api.get<Kandidat[]>(`${A}/angebote/personen`).then((l) => {
      setKandidaten(l);
      // Korrektur: Stammangaben zu den Personen des Angebots nachladen (Mitglied, laufende Verträge, was im Stamm fehlt)
      if (bearbeiten) setPersonen((alt) => alt.map((p) => (p.adrnr && !p.neu && !p.info ? { ...p, info: l.find((x) => x.adrnr === p.adrnr) } : p)));
      if (!start) return;
      // Vorbelegung (Schnupperverwaltung): Person 1 = dieser Stammsatz, solange dort noch nichts gewählt wurde
      const info = l.find((x) => x.adrnr === start.adrnr);
      if (!info) { setError('Die Person steht nicht in der Auswahl (kein Stammsatz für ein Angebot) – bitte von Hand wählen oder neu erfassen.'); return; }
      setPersonen((alt) => alt.map((p, j) => (j === 0 && !p.neu && !p.adrnr ? { ...p, adrnr: info.adrnr, info, ...(info.mitglied ? { art: '', training: [] } : {}) } : p)));
      setEmail((alt) => alt || info.email || '');
    }).catch((e) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setP = (i: number, x: Partial<APerson>) => setPersonen((l) => l.map((p, j) => (j === i ? { ...p, ...x } : p)));
  const kandidatenEintraege = useMemo(() => kandidaten.map((k) => ({
    key: k.adrnr, text: k.name,
    zusatz: [k.geburtsdatum ? dat(k.geburtsdatum) : '', k.ort, k.mitglied ? `Mitglied ${k.mitglied}` : '', k.zahler ? `zahlt: ${k.zahler}` : '', k.schnupper ? `Schnupper ${k.schnupper}` : ''].filter(Boolean).join(' · '),
  })), [kandidaten]);
  const familie = !!arten.find((b) => b.art === personen[0].art)?.familie;
  const mitgliedschaften = arten.filter((b) => b.kategorie === 'MITGLIEDSCHAFT');
  const trainings = arten.filter((b) => b.kategorie === 'TRAINING');
  /** Erweiterung aktiver Mitglieder: Mitgliedschaft optional (z. B. nur Training), alle Personen sind Mitglieder */
  const erweiterung = !personen[0].neu && !!personen[0].info?.mitglied;
  const nurMitglieder = personen.every((p) => !p.neu && !!p.info?.mitglied);
  const ok = personen.every((p) => (p.neu ? p.vorname.trim() && p.nachname.trim() : p.adrnr))
    && (personen[0].art ? personen.length === 1 || familie : erweiterung && nurMitglieder && personen.some((p) => p.training.length > 0))
    && (email.trim() || (!personen[0].neu && personen[0].info?.email) || (personen[0].neu && personen[0].email.trim()));

  const ausAngebot = !!bearbeiten?.bank && angebotsBank;
  async function los() {
    setBusy(true); setError(null);
    try {
      const daten = {
        personen: personen.map((p, i) => (p.neu
          ? { anrede: p.anrede || null, vorname: p.vorname, nachname: p.nachname, geburtsdatum: p.geburtsdatum || null, email: p.email || null, art: i === 0 ? p.art : null, training: p.training }
          : {
            adrnr: p.adrnr, art: i === 0 ? p.art : null, training: p.training,
            // nur wenn im Stamm leer: hier erfasste Anrede/Geburtsdatum mitgeben (der Stammwert hat serverseitig Vorrang)
            ...(anredeFehlt(p.info) && p.anrede ? { anrede: p.anrede } : {}),
            ...(geburtFehlt(p.info) && p.geburtsdatum ? { geburtsdatum: p.geburtsdatum } : {}),
          })),
        eintritt, email: email.trim() || null, erziehungsberechtigt: erz.trim() || null, bemerkung: hinweis.trim() || null, mail,
        // ohne eigene Eingabe: Bankverbindung aus dem Stamm (wird serverseitig übernommen, nach außen nur gekürzt)
        kontoinhaber: ausAngebot || (stammBank && !andereBank) ? null : kontoinhaber.trim() || null, iban: ausAngebot || (stammBank && !andereBank) ? null : iban.trim() || null,
        mailBetreff: mail ? mailBetreff : null, mailText: mail ? mailText : null,
      };
      setErgebnis(bearbeiten
        ? await api.put<{ nummer: string; link: string; text: string }>(`${A}/angebote/${bearbeiten.id}`, { ...daten, bankBehalten: ausAngebot })
        : await api.post<{ nummer: string; link: string; text: string }>(`${A}/angebote`, daten));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (ergebnis) return <LinkDialog {...ergebnis} onClose={onDone} />;
  const sel = (wert: string, liste: Beitragsart[], leerText: string, onWahl: (x: string) => void, disabled = false) => (
    <Select style={{ width: '100%' }} disabled={disabled} onChange={(e) => onWahl((e.detail.selectedOption as HTMLElement).dataset.a ?? '')}>
      <Option data-a="" selected={!wert}>{leerText}</Option>
      {liste.map((b) => <Option key={b.art} data-a={b.art} selected={wert === b.art}>{b.name} – {b.betrag.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}{b.turnus ? ` (${b.turnus})` : ''}</Option>)}
    </Select>
  );
  return (
    <Dialog open headerText={bearbeiten ? `Vertragsangebot ${bearbeiten.nummer} korrigieren` : 'Vertragsangebot erstellen'} style={{ width: 'min(52rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<>
              <Button design="Emphasized" icon="email" loading={busy} disabled={!ok} onClick={los}>
                {bearbeiten ? (mail ? 'Sichern und neu senden' : 'Sichern (neuen Link anzeigen)') : mail ? 'Erstellen und per E-Mail senden' : 'Erstellen (Link anzeigen)'}
              </Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        {bearbeiten && (
          <MessageStrip design="Critical" hideCloseButton>
            Korrektur von {bearbeiten.nummer}: Der Inhalt wird durch die Angaben hier ersetzt, die Nummer bleibt. Der bisherige Link wird ungültig
            {bearbeiten.geoeffnet_am ? ' (die Person hat das Angebot bereits geöffnet)' : ''} – die Person erhält den berichtigten Stand mit einem neuen Link, wieder 30 Tage gültig.
          </MessageStrip>
        )}
        {(bearbeiten?.hinweise ?? []).map((h) => <MessageStrip key={h} design="Negative" hideCloseButton>{h}</MessageStrip>)}
        <MessageStrip hideCloseButton>
          Der Antrag wird vorbereitet und als persönlicher Link verschickt: keine Daten in der E-Mail, Öffnen nur mit dem Geburtsdatum, gültig 30 Tage, einmal verwendbar.
          Die Person ergänzt IBAN/SEPA-Mandat und bestätigt – der Antrag landet danach wie gewohnt im Eingang. Personen aus dem Stamm (ohne Mitgliedschaft) werden bei der Übernahme Mitglied, ohne Dublette; bei aktiven Mitgliedern werden nur die neuen Verträge ergänzt.
          Bankverbindung „aus dem Stamm“: wer nicht selbst zahlt, bekommt die des abweichenden Zahlers (Kontoinhaber = Zahler).
          {' '}Umstellung bestehender Mitglieder (z. B. auf den Familienbeitrag): die Mitglieder wählen und beim Antragsteller die neue Mitgliedschaft – die bisherigen Mitgliedschaften enden bei der Übernahme am Tag vor deren Beginn, laufende Trainingsverträge bleiben.
        </MessageStrip>
        {personen.map((p, i) => (
          <div key={i} style={{ padding: '0.6rem', border: '1px solid var(--sapList_BorderColor)', borderRadius: 'var(--portal-radius, 0.75rem)' }}>
            <div className="portal-row" style={{ justifyContent: 'space-between' }}>
              <Title level="H6">{i === 0 ? 'Antragsteller/in' : `Weitere Person ${i} (Familie)`}</Title>
              <div className="portal-row">
                <CheckBox text="neu erfassen (nicht im Stamm)" checked={p.neu} onChange={(e) => setP(i, { ...leerePerson(), neu: e.target.checked, art: p.art, training: p.training })} />
                {i > 0 && <Button design="Transparent" icon="delete" onClick={() => setPersonen((l) => l.filter((_, j) => j !== i))} />}
              </div>
            </div>
            {!p.neu ? (
              <>
                <Label>Person aus dem Mitgliederstamm (Interessent, Schnupperer oder aktives Mitglied)</Label>
                <AuswahlBox wert={p.adrnr ?? ''} placeholder="Name oder Ort eingeben" style={{ width: '100%' }} max={50}
                            eintraege={kandidatenEintraege}
                            onWaehle={(k) => {
                              const info = kandidaten.find((x) => x.adrnr === k);
                              // aktive Mitglieder: Mitgliedschaft optional – die laufenden Verträge werden als Vorschlag angezeigt
                              setP(i, { adrnr: k, info, anrede: '', geburtsdatum: '', ...(info?.mitglied ? { art: '', training: [] } : {}) });
                              if (i === 0 && info?.email && !email) setEmail(info.email);
                            }} />
                {p.info?.mitglied && (
                  <div className="portal-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem 0.5rem', marginTop: '0.25rem' }}>
                    <Text className="portal-muted portal-small">
                      Mitglied Nr. {p.info.mitglied} – Erweiterung/Vertragsänderung: Mitgliedschaft optional, bei der Übernahme werden nur neue Verträge ergänzt.
                      {' '}Aktuelle Verträge: {p.info.vertragsnamen.length ? p.info.vertragsnamen.join(', ') : 'keine'}.
                    </Text>
                    {p.info.vertraege.length > 0 && (
                      <Button design="Transparent" icon="copy" onClick={() => {
                        const lauf = p.info!.vertraege;
                        const ms = i === 0 ? lauf.find((x) => mitgliedschaften.some((b) => b.art === x)) ?? '' : '';
                        setP(i, { art: ms, training: lauf.filter((x) => trainings.some((b) => b.art === x)).slice(0, 2) });
                      }}>Aktuelle Verträge vorschlagen</Button>
                    )}
                  </div>
                )}
                {(anredeFehlt(p.info) || geburtFehlt(p.info)) && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem', marginTop: '0.25rem' }}>
                    {anredeFehlt(p.info) && (
                      <div><Label>Anrede (fehlt im Stamm)</Label>
                        <Select style={{ width: '100%' }} onChange={(e) => setP(i, { anrede: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
                          <Option data-a="" selected={!p.anrede}>–</Option>
                          {ANREDEN.map((x) => <Option key={x} data-a={x} selected={p.anrede === x}>{x}</Option>)}
                        </Select></div>
                    )}
                    {geburtFehlt(p.info) && (
                      <div><Label>Geburtsdatum (fehlt im Stamm – Schutz des Links)</Label>
                        <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={p.geburtsdatum} onChange={(e) => setP(i, { geburtsdatum: e.detail.value })} /></div>
                    )}
                  </div>
                )}
                {geburtFehlt(p.info) && !p.geburtsdatum && (
                  <Text className="portal-muted portal-small">
                    Kein Geburtsdatum im Stamm – bitte hier erfassen (es gilt nur für dieses Angebot, der Stamm bleibt unverändert). Ohne Geburtsdatum öffnet der Link ohne zweite Abfrage.
                  </Text>
                )}
              </>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }}>
                <div><Label>Anrede</Label>
                  <Select style={{ width: '100%' }} onChange={(e) => setP(i, { anrede: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
                    <Option data-a="" selected={!p.anrede}>–</Option>
                    {ANREDEN.map((x) => <Option key={x} data-a={x} selected={p.anrede === x}>{x}</Option>)}
                  </Select></div>
                <div><Label required>Vorname</Label><Input style={{ width: '100%' }} value={p.vorname} onInput={(e) => setP(i, { vorname: e.target.value })} /></div>
                <div><Label required>Nachname</Label><Input style={{ width: '100%' }} value={p.nachname} onInput={(e) => setP(i, { nachname: e.target.value })} /></div>
                <div><Label>Geburtsdatum (Schutz des Links)</Label>
                  <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={p.geburtsdatum} onChange={(e) => setP(i, { geburtsdatum: e.detail.value })} /></div>
                {i === 0 && <div><Label>E-Mail</Label><Input style={{ width: '100%' }} type="Email" value={p.email} onInput={(e) => setP(i, { email: e.target.value })} /></div>}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))', gap: '0.5rem', marginTop: '0.5rem' }}>
              {i === 0 ? <div><Label required={!erweiterung}>Mitgliedschaft{erweiterung ? ' (optional)' : ''}</Label>{sel(p.art, mitgliedschaften, erweiterung ? 'keine Änderung' : 'bitte wählen', (x) => setP(i, { art: x }))}</div>
                : <div><Label>Mitgliedschaft</Label><Text style={{ display: 'block', paddingTop: '0.5rem' }}>{!personen[0].art && p.info?.mitglied ? 'unverändert (Mitglied)' : 'über den Familienbeitrag'}</Text></div>}
              {trainings.length > 0 && [0, 1].map((n) => (
                <div key={n}><Label>Trainingseinheit {n + 1}</Label>
                  {sel(p.training[n] ?? '', trainings, 'keine', (x) => { const t = [...p.training]; if (x) t[n] = x; else t.splice(n, 1); setP(i, { training: t.filter(Boolean).slice(0, 2) }); }, n > 0 && !p.training[0])}
                </div>
              ))}
            </div>
          </div>
        ))}
        {(familie || (erweiterung && !personen[0].art)) && personen.length < 8 && <Button design="Transparent" icon="add-employee" onClick={() => setPersonen((l) => [...l, leerePerson()])}>Weitere Person (Familie)</Button>}
        {!familie && personen.length > 1 && !(erweiterung && !personen[0].art && nurMitglieder) && <MessageStrip design="Critical" hideCloseButton>Weitere Personen nur mit dem Familienbeitrag beim Antragsteller (ohne neue Mitgliedschaft nur bestehende Mitglieder).</MessageStrip>}
        {erweiterung && !personen[0].art && !personen.some((p) => p.training.length) && <MessageStrip design="Information" hideCloseButton>Für eine Erweiterung bitte mindestens eine Trainingseinheit wählen (oder eine Mitgliedschaft).</MessageStrip>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
          <div><Label required>Eintritt</Label><DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={eintritt} onChange={(e) => setEintritt(e.detail.value)} /></div>
          <div><Label>E-Mail für den Link</Label><Input style={{ width: '100%' }} type="Email" value={email} placeholder="aus dem Stamm" onInput={(e) => setEmail(e.target.value)} /></div>
          <div><Label>Erziehungsberechtigte/r (bei Minderjährigen)</Label><Input style={{ width: '100%' }} value={erz} onInput={(e) => setErz(e.target.value)} /></div>
        </div>
        {ausAngebot ? (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
              <div><Label>Kontoinhaber/in (im Angebot hinterlegt{bearbeiten!.bank!.zahler ? `, Zahler ${bearbeiten!.bank!.zahler}` : ''})</Label><Input style={{ width: '100%' }} readonly value={bearbeiten!.bank!.kontoinhaber} /></div>
              <div><Label>IBAN (im Angebot hinterlegt)</Label><Input style={{ width: '100%' }} readonly value={bearbeiten!.bank!.iban} /></div>
            </div>
            <div className="portal-row" style={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <Text className="portal-muted portal-small">Bleibt unverändert im Angebot; die Person sieht die IBAN nur gekürzt und bestätigt das Mandat.</Text>
              <Button design="Transparent" icon="edit" onClick={() => setAngebotsBank(false)}>Andere Bankverbindung</Button>
            </div>
          </div>
        ) : stammBank && !andereBank ? (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
              <div><Label>Kontoinhaber/in{stammBank.zahler ? ` (Zahler ${stammBank.zahler})` : ' (aus dem Stamm)'}</Label><Input style={{ width: '100%' }} readonly value={stammBank.kontoinhaber} /></div>
              <div><Label>IBAN (aus dem Stamm, maskiert)</Label><Input style={{ width: '100%' }} readonly value={stammBank.iban} /></div>
            </div>
            <div className="portal-row" style={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <Text className="portal-muted portal-small">Wird ins Angebot übernommen; die Person sieht die IBAN nur gekürzt und bestätigt das Mandat.</Text>
              <Button design="Transparent" icon="edit" onClick={() => setAndereBank(true)}>Andere Bankverbindung</Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
            <div><Label>Kontoinhaber/in (optional)</Label><Input style={{ width: '100%' }} value={kontoinhaber} onInput={(e) => setKontoinhaber(e.target.value)} /></div>
            <div><Label>IBAN (optional – sonst ergänzt die Person)</Label><Input style={{ width: '100%' }} value={iban} onInput={(e) => setIban(e.target.value)} /></div>
            {stammBank && <div><Button design="Transparent" icon="undo" onClick={() => { setAndereBank(false); setKontoinhaber(''); setIban(''); }}>Bankverbindung aus dem Stamm</Button></div>}
            {bearbeiten?.bank && erster === (bearbeiten.personen[0].adrnr ?? null) && <div><Button design="Transparent" icon="undo" onClick={() => { setAngebotsBank(true); setKontoinhaber(''); setIban(''); }}>Bankverbindung aus dem Angebot</Button></div>}
          </div>
        )}
        <Label>Hinweis an die Person (erscheint im Formular)</Label>
        <Input style={{ width: '100%' }} value={hinweis} maxlength={300} placeholder="z. B. Gruppe montags 17 Uhr bei Trainer Tom" onInput={(e) => setHinweis(e.target.value)} />
        <CheckBox text="Link per E-Mail senden (sonst nur anzeigen, z. B. für WhatsApp)" checked={mail} onChange={(e) => setMail(e.target.checked)} />
        {mail && (
          <div>
            <Label>Betreff</Label>
            <Input style={{ width: '100%' }} value={mailBetreff} maxlength={200} onInput={(e) => setMailBetreff(e.target.value)} />
            <Label>Nachricht</Label>
            <TextArea style={{ width: '100%' }} rows={8} value={mailText} maxlength={5000} onInput={(e) => setMailText(e.target.value)} />
            <Text className="portal-muted portal-small">
              Platzhalter: {'{Name}'}, {'{Link}'} (persönlicher Link – fehlt er, wird er angehängt), {'{GueltigBis}'}, {'{Verein}'}. Bitte keine Vertrags- oder Bankdaten in die E-Mail schreiben.
            </Text>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Nach der Übernahme: Mitgliederinformation je neuem Mitglied zum Drucken (#12) */
function MitgliederinfoDruck({ liste, onClose }: { liste: NonNullable<Ergebnis['unterlagen']>; onClose: () => void }) {
  const [offen, setOffen] = useState<number | null>(0);
  const u = offen !== null ? liste[offen] : null;
  return (
    <>
      <Dialog open={offen === null} headerText="Mitgliederinformation drucken" style={{ width: 'min(34rem, 96vw)' }} onClose={onClose}
              footer={<FussLeiste endContent={<Button design="Emphasized" onClick={onClose}>Fertig</Button>} />}>
        {liste.map((x, i) => (
          <div key={x.adrnr} className="portal-row" style={{ justifyContent: 'space-between', padding: '0.3rem 0' }}>
            <Text>{x.name}{x.ablage ? <span className="portal-muted portal-small"> · {x.ablage}</span> : null}</Text>
            <Button icon="print" design="Transparent" onClick={() => setOffen(i)}>Öffnen</Button>
          </div>
        ))}
      </Dialog>
      {u && <PdfDialog url={u.url} title={`Mitgliederinformation ${u.name}`} filename={`Mitgliederinformation_${u.name.replace(/\s+/g, '_')}.pdf`}
                       onClose={() => setOffen(offen !== null && offen + 1 < liste.length ? offen + 1 : null)} />}
    </>
  );
}
