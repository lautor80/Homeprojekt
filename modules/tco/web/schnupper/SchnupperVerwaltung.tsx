import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { feld } from '@core/components/Varianten';
import {
  Button, BusyIndicator, DatePicker, Dialog, Input, Label, Link, MessageStrip, ObjectStatus, Option, Select, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { PdfDialog } from '@core/components/PdfDialog';
import { Section } from '@core/components/Section';
import { useCan, useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import { portalAdresse } from '@core/branding';
import { AngebotDialog } from '../antrag/Mitgliedsantraege';
import { ANGEFANGEN_WAHL, AngefangenDialog, angefangenText, angefangenWahl, angefangenWert, type AngefangenWahl } from './AngefangenDialog';

/**
 * Schnuppertraining (#86) für Trainer: Anmeldungen aus /schnuppertraining mit Kontakt und Wunschterminen, Status und
 * Einheiten pflegen, Beitrittslink (vorbelegter Mitgliedsantrag) senden. Eigene Rechte, kein Zugriff auf den Mitgliederstamm nötig.
 */
const S = `${TCO}/schnuppertraining`;
type Status = 'NEU' | 'KONTAKTIERT' | 'TERMIN' | 'ABSOLVIERT' | 'MITGLIED' | 'ABGESAGT';
/** Durchgängiger Prozess je Schnupperer: Anfrage → Schnuppern → Vertragsangebot → Mitgliedsantrag → Mitglied (vom Server berechnet) */
interface ProzessSchritt { schritt: 'ANFRAGE' | 'SCHNUPPERN' | 'ANGEBOT' | 'ANTRAG' | 'MITGLIED'; titel: string; zustand: 'erledigt' | 'aktiv' | 'offen' | 'abgebrochen'; info: string | null }
interface Angebot { id: number; nummer: string; status: 'OFFEN' | 'ANGENOMMEN' | 'ZURUECKGEZOGEN'; gueltig_bis: string; abgelaufen: boolean; antrag: string | null }
interface Zeile {
  adrnr: string; nummer: string; status: Status; status_txt: string; eingang: string;
  vorname: string; nachname: string; email: string; mobil: string; whatsapp: string; alter: number | null; gespielt: boolean; stufe: string; stufe_txt: string;
  termine: { tage: string[]; zeiten: string[]; text?: string | null }; erziehungsberechtigt: string | null; mitteilung: string | null;
  einheit1: string | null; einheit2: string | null; trainer: string | null; notiz: string | null; antrag: string | null;
  bearbeitet_am: string | null; bearbeitet_von: string | null; mitglnrn: string;
  /** Tage mit Schnuppertraining laut „Meine Trainingszeiten“ (#21) */
  einheiten: number;
  /** nach dem Schnuppern im Verein angefangen: true = ja, false = nein, null = offen */
  angefangen: boolean | null; angefangen_am: string | null;
  /** jüngstes Vertragsangebot zu diesem Schnupperer */
  angebot: Angebot | null;
  antrag_nr: string | null; antrag_status: 'EINGANG' | 'UEBERNOMMEN' | 'ABGELEHNT' | null;
  /** fehlt bei älterem Serverstand */
  prozess?: ProzessSchritt[];
}
interface Daten { status: Record<Status, string>; stufen: Record<string, string>; einheiten: number; zeilen: Zeile[] }
const STATE: Record<Status, 'Critical' | 'Information' | 'Positive' | 'Negative' | 'None'> = {
  NEU: 'Critical', KONTAKTIERT: 'Information', TERMIN: 'Information', ABSOLVIERT: 'Positive', MITGLIED: 'Positive', ABGESAGT: 'Negative',
};
const zeit = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const P_STATE: Record<ProzessSchritt['zustand'], 'Critical' | 'Information' | 'Positive' | 'Negative' | 'None'> = {
  erledigt: 'Positive', aktiv: 'Information', offen: 'None', abgebrochen: 'Negative',
};
const angebotOffen = (g: Angebot | null | undefined) => !!g && g.status === 'OFFEN' && !g.abgelaufen;
const angebotText = (g: Angebot) => `Vertragsangebot ${g.nummer} ${angebotOffen(g) ? `offen bis ${dat(g.gueltig_bis)}`
  : g.status === 'ANGENOMMEN' ? 'angenommen' : g.status === 'ZURUECKGEZOGEN' ? 'zurückgezogen' : `abgelaufen (${dat(g.gueltig_bis)})`}`;

/** Kompakte Prozessleiste: je Schritt Titel mit Zustand (Farbe/Symbol), darunter die Zusatzinfo */
function ProzessLeiste({ schritte }: { schritte: ProzessSchritt[] }) {
  if (!schritte.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(8.5rem, 1fr))', gap: '0.25rem 0.75rem', marginBottom: '0.75rem', paddingBottom: '0.5rem', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
      {schritte.map((p, i) => (
        <div key={p.schritt} style={{ minWidth: 0 }}>
          <ObjectStatus state={P_STATE[p.zustand]} showDefaultIcon title={`${p.titel}: ${p.zustand}`}>{`${i + 1}. ${p.titel}`}</ObjectStatus>
          <Text className="portal-muted portal-small" style={{ display: 'block' }}>{p.info || (p.zustand === 'erledigt' ? '' : p.zustand)}</Text>
        </div>
      ))}
    </div>
  );
}

export function SchnupperVerwaltung() {
  const can = useCan();
  const edit = can('tco.schnupper:edit');
  const navigate = useNavigate();
  /** Vertragsangebot nur mit Recht auf die Mitgliedsanträge und eingeschaltetem Online-Antrag (sonst ließe es sich nicht bestätigen) */
  const formularAn = useFunktion()('tco.antrag.formular');
  const angebotDarf = can('tco.antraege:edit') && formularAn;
  const antraegeSehen = can('tco.antraege:display');
  const [daten, setDaten] = useState<Daten | null>(null);
  const [alle, setAlle] = useState(false);
  const [offen, setOffen] = useState<Zeile | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [angebotFuer, setAngebotFuer] = useState<Zeile | null>(null);
  const [angefangenFuer, setAngefangenFuer] = useState<Zeile | null>(null);
  // Bericht zum Ausdrucken (PDF im TCO-Layout): eine Anmeldung oder die ganze Liste
  const [pdf, setPdf] = useState<{ url: string; titel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Daten>(`${S}?filter=${alle ? 'ALLE' : 'OFFEN'}`).then(setDaten).catch((e) => setError(e.message));
  useEffect(() => { setDaten(null); laden(); }, [alle]); // eslint-disable-line react-hooks/exhaustive-deps

  async function beitrittslink(z: Zeile) {
    setError(null);
    try {
      const r = await api.post<{ link: string; text: string }>(`${S}/${z.adrnr}/beitrittslink`, { mail: true });
      toast(r.text, 6000);
      setLink(r.link);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <AppPage varianten={{ repid: 'tco.schnupper', ansicht: { alle }, onAnwenden: (a) => { setAlle(feld(a, 'alle', alle)); } }} title="Schnuppertraining" subtitle={daten ? `${daten.einheiten} kostenlose Einheiten · Anmeldungen über das Formular /schnuppertraining` : ''}
             actions={<>
               <Button design="Transparent" icon="action" onClick={() => window.open('/schnuppertraining', '_blank')}>Anmeldeformular öffnen</Button>
               <Button design="Transparent" icon={alle ? 'filter' : 'history'} onClick={() => setAlle(!alle)}>{alle ? 'Nur offene' : 'Auch erledigte'}</Button>
               {!!daten?.zeilen.length && <>
                 <Button design="Transparent" icon="list" tooltip="Alle angezeigten Interessenten als Liste – je Interessent ein paar Zeilen, Querformat"
                         onClick={() => setPdf({ url: `${S}/pdf?art=liste&filter=${alle ? 'ALLE' : 'OFFEN'}`, titel: `Schnuppertraining – Interessenten (${alle ? 'alle' : 'offene'})` })}>
                   Liste drucken
                 </Button>
                 <Button design="Transparent" icon="print" tooltip="Alle angezeigten Anmeldungen als Einzelberichte (je Anmeldung eine Seite mit allen Angaben)"
                         onClick={() => setPdf({ url: `${S}/pdf?filter=${alle ? 'ALLE' : 'OFFEN'}`, titel: `Schnuppertraining – ${alle ? 'alle' : 'offene'} Anmeldungen` })}>
                   Alle Einzelberichte
                 </Button>
               </>}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!daten ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : !daten.zeilen.length ? (
        <MessageStrip hideCloseButton>Keine offenen Anmeldungen. Link zum Formular für Website und Aushang: <b>{portalAdresse()}/schnuppertraining</b></MessageStrip>
      ) : daten.zeilen.map((z) => {
        const termine = [[...z.termine.tage, ...z.termine.zeiten].join(', '), z.termine.text].filter(Boolean).join(' · ');
        const fertig = z.status === 'MITGLIED' || z.status === 'ABGESAGT';
        // neues Angebot: nicht bei offenem Angebot und nicht, solange ein angenommenes Angebot noch als Antrag läuft
        const angebotNeu = angebotDarf && !fertig && !angebotOffen(z.angebot) && !(z.angebot?.status === 'ANGENOMMEN' && z.antrag_status !== 'ABGELEHNT');
        return (
          <Section key={z.adrnr} title={`${z.nummer} · ${z.vorname} ${z.nachname}${z.alter != null ? ` (${z.alter})` : ''}`}
                   status={<ObjectStatus state={STATE[z.status]} inverted>{z.status_txt}</ObjectStatus>}>
            <ProzessLeiste schritte={z.prozess ?? []} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '0.75rem 1.5rem' }}>
              <div>
                <Label>Angemeldet</Label><br /><Text>{zeit(z.eingang)}</Text><br />
                <Label>Kontakt</Label><br />
                <Text>
                  {z.email && <Link href={`mailto:${z.email}`}>{z.email}</Link>}
                  {z.email && z.mobil && ' · '}
                  {z.mobil && <Link href={`tel:${z.mobil}`}>{z.mobil}</Link>}
                  {z.whatsapp && <> · <Link href={`https://wa.me/${z.whatsapp}`} target="_blank">WhatsApp</Link></>}
                </Text>
                {z.erziehungsberechtigt && <><br /><Label>Erziehungsberechtigt</Label><br /><Text>{z.erziehungsberechtigt}</Text></>}
              </div>
              <div>
                <Label>Tennis</Label><br /><Text>{z.gespielt ? 'hat schon gespielt' : 'noch nie gespielt'} · {z.stufe_txt}</Text><br />
                <Label>Mögliche Termine</Label><br /><Text>{termine || '–'}</Text>
              </div>
              <div>
                <Label>Einheiten</Label><br />
                <Text>{z.einheit1 ? `1. am ${dat(z.einheit1)}` : '1. offen'} · {z.einheit2 ? `2. am ${dat(z.einheit2)}` : '2. offen'}</Text><br />
                <ObjectStatus state={z.einheiten > daten.einheiten ? 'Critical' : z.einheiten === daten.einheiten ? 'Positive' : z.einheiten ? 'Information' : 'None'}
                              title="Tage, an denen ein Trainer das Kind in „Meine Trainingszeiten“ eingetragen hat">
                  {z.einheiten}× geschnuppert{z.einheiten > daten.einheiten ? ` – mehr als ${daten.einheiten} kostenlose Einheiten` : ''}
                </ObjectStatus><br />
                <Label>Trainer</Label><br /><Text>{z.trainer || '–'}</Text><br />
                <Label>Hat angefangen</Label><br /><Text>{angefangenText(z.angefangen, z.angefangen_am)}</Text>
                {z.antrag && <><br /><Label>Beitritt</Label><br /><Text>Mitgliedsantrag {z.antrag}{z.mitglnrn ? ` · Mitglied Nr. ${z.mitglnrn}` : ''}</Text></>}
                {z.angebot && <><br /><Label>Vertragsangebot</Label><br /><Text>{angebotText(z.angebot)}</Text></>}
              </div>
            </div>
            {z.mitteilung && <MessageStrip design="Information" hideCloseButton style={{ marginTop: '0.5rem' }}>Mitteilung: {z.mitteilung}</MessageStrip>}
            {z.notiz && <Text style={{ display: 'block', marginTop: '0.5rem', whiteSpace: 'pre-line' }}><b>Notiz:</b> {z.notiz}</Text>}
            <div className="portal-row" style={{ marginTop: '0.75rem' }}>
              {edit && !fertig && <>
                <Button design="Emphasized" icon="edit" onClick={() => setOffen(z)}>Bearbeiten…</Button>
                <Button design="Transparent" icon="paper-plane" onClick={() => beitrittslink(z)}>Beitrittslink senden</Button>
              </>}
              {edit && fertig && <Button design="Transparent" icon="edit" onClick={() => setAngefangenFuer(z)}>Angefangen…</Button>}
              {angebotNeu && <Button design="Transparent" icon="email" onClick={() => setAngebotFuer(z)}>Vertragsangebot erstellen…</Button>}
              {z.angebot && antraegeSehen && <Button design="Transparent" icon="personnel-view" onClick={() => navigate('/tco/mitgliedsantraege')}>Zu den Mitgliedsanträgen</Button>}
              <Button design="Transparent" icon="print" onClick={() => setPdf({ url: `${S}/pdf?adrnrs=${z.adrnr}`, titel: `Schnuppertraining ${z.nummer} ${z.vorname} ${z.nachname}` })}>
                Drucken
              </Button>
            </div>
            {z.bearbeitet_von && (
              <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
                Zuletzt bearbeitet von {z.bearbeitet_von}{z.bearbeitet_am ? `, ${zeit(z.bearbeitet_am)}` : ''}
              </Text>
            )}
          </Section>
        );
      })}
      {offen && daten && <BearbeitenDialog z={offen} status={daten.status} onClose={() => setOffen(null)}
                                            onDone={(t) => { setOffen(null); toast(t, 5000); laden(); }} />}
      {angefangenFuer && <AngefangenDialog adrnr={angefangenFuer.adrnr} titel={`${angefangenFuer.nummer} · ${angefangenFuer.vorname} ${angefangenFuer.nachname}`}
                                           angefangen={angefangenFuer.angefangen} angefangen_am={angefangenFuer.angefangen_am} onClose={() => setAngefangenFuer(null)}
                                           onDone={(t) => { setAngefangenFuer(null); toast(t, 5000); laden(); }} />}
      {angebotFuer && <AngebotDialog start={{ adrnr: angebotFuer.adrnr, email: angebotFuer.email, erziehungsberechtigt: angebotFuer.erziehungsberechtigt }}
                                     onClose={() => setAngebotFuer(null)} onDone={() => { setAngebotFuer(null); laden(); }} />}
      <PdfDialog url={pdf?.url ?? null} title={pdf?.titel ?? 'Schnuppertraining'} filename={`${pdf?.titel ?? 'Schnuppertraining'}.pdf`} onClose={() => setPdf(null)} />
      {link && (
        <Dialog open headerText="Beitrittslink" onClose={() => setLink(null)}
                footer={<FussLeiste endContent={<>
                  <Button icon="copy" onClick={() => { navigator.clipboard?.writeText(link).then(() => toast('Link kopiert.')).catch(() => undefined); }}>Kopieren</Button>
                  <Button design="Emphasized" onClick={() => setLink(null)}>Schließen</Button>
                </>} />}>
          <Text style={{ display: 'block', marginBottom: '0.5rem' }}>Der Mitgliedsantrag ist mit Name und Kontakt vorbelegt. Bei der Übernahme wird derselbe Stammsatz zum Mitglied.</Text>
          <Text style={{ wordBreak: 'break-all' }}><b>{link}</b></Text>
        </Dialog>
      )}
    </AppPage>
  );
}

function BearbeitenDialog({ z, status, onClose, onDone }: { z: Zeile; status: Record<Status, string>; onClose: () => void; onDone: (text: string) => void }) {
  const [f, setF] = useState({ status: z.status, einheit1: z.einheit1 ?? '', einheit2: z.einheit2 ?? '', trainer: z.trainer ?? '', notiz: z.notiz ?? '' });
  const [angefangen, setAngefangen] = useState<AngefangenWahl>(angefangenWahl(z.angefangen));
  const [angefangenAm, setAngefangenAm] = useState(z.angefangen_am ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function sichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ text: string }>(`${S}/${z.adrnr}`, {
        ...f, einheit1: f.einheit1 || null, einheit2: f.einheit2 || null,
        angefangen: angefangenWert(angefangen), angefangen_am: angefangen === 'ja' ? angefangenAm || null : null,
      });
      onDone(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={`${z.nummer} · ${z.vorname} ${z.nachname}`} style={{ width: 'min(30rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<>
              <Button design="Emphasized" icon="save" loading={busy} onClick={sichern}>Sichern</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon>Status</Label>
        <Select onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.s as Status })}>
          {(Object.keys(status) as Status[]).filter((s) => s !== 'MITGLIED').map((s) => <Option key={s} data-s={s} selected={f.status === s}>{status[s]}</Option>)}
        </Select>
        <Label showColon>1. Einheit</Label>
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.einheit1} onChange={(e) => setF({ ...f, einheit1: e.detail.value })} />
        <Label showColon>2. Einheit</Label>
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.einheit2} onChange={(e) => setF({ ...f, einheit2: e.detail.value })} />
        <Label showColon>Trainer</Label>
        <Input value={f.trainer} maxlength={120} onInput={(e) => setF({ ...f, trainer: e.target.value })} />
        <Label showColon>Hat angefangen</Label>
        <Select onChange={(e) => setAngefangen(((e.detail.selectedOption as HTMLElement).dataset.w ?? 'offen') as AngefangenWahl)}>
          {(Object.keys(ANGEFANGEN_WAHL) as AngefangenWahl[]).map((w) => <Option key={w} data-w={w} selected={angefangen === w}>{ANGEFANGEN_WAHL[w]}</Option>)}
        </Select>
        {angefangen === 'ja' && <>
          <Label showColon>Angefangen am</Label>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={angefangenAm} onChange={(e) => setAngefangenAm(e.detail.value)} />
        </>}
        <Label showColon>Notiz</Label>
        <TextArea rows={3} value={f.notiz} maxlength={2000} onInput={(e) => setF({ ...f, notiz: e.target.value })} />
        <Title level="H6">Hinweis</Title>
        <Text className="portal-muted portal-small">Sind beide Einheiten eingetragen, wechselt der Status auf „Schnuppern absolviert“. „Mitglied geworden“ setzt die Übernahme des Mitgliedsantrags.</Text>
      </div>
    </Dialog>
  );
}
