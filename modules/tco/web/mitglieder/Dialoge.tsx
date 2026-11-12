import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, Button, CheckBox, DatePicker, Dialog, Link, MessageStrip, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { dateiLesen, eur } from '../util';
import { MG, type Auswahl, type Detail } from './typen';

export function Dlg({ titel, children, onClose, fuss, breite = 'min(760px, 95vw)' }: { titel: string; children: ReactNode; onClose: () => void; fuss: ReactNode; breite?: string }) {
  return createPortal(
    <Dialog open headerText={titel} onClose={onClose} resizable style={{ width: breite }}
            footer={<Bar endContent={<>{fuss}<Button onClick={onClose}>Abbrechen</Button></>} />}>
      {children}
    </Dialog>,
    document.body,
  );
}

export function Datum({ label, value, onChange, required }: { label: string; value: string | null | undefined; onChange: (v: string) => void; required?: boolean }) {
  return (
    <FieldBox label={label} required={required}>
      <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={value ?? ''} onChange={(e) => onChange(e.detail.value)} />
    </FieldBox>
  );
}

export function Auswahlfeld({ label, value, optionen, onChange, required, wide }: {
  label: string; value: string; optionen: [string, string][]; onChange: (v: string) => void; required?: boolean; wide?: boolean;
}) {
  return (
    <FieldBox label={label} required={required} wide={wide}>
      <Select style={{ width: '100%' }} onChange={(e) => onChange((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
        {optionen.map(([k, t]) => <Option key={k} data-k={k} selected={k === value}>{t}</Option>)}
      </Select>
    </FieldBox>
  );
}

const Fehler = ({ text, onClose }: { text: string | null; onClose: () => void }) =>
  (text ? <MessageStrip design="Negative" onClose={onClose} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{text}</MessageStrip> : null);

function useSenden<T>(fn: () => Promise<T>, ok: (r: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const los = async () => {
    setBusy(true);
    setError(null);
    try { ok(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return { busy, error, setError, los };
}

// ---------------------------------------------------------------- Kontakt
export function KopfDialog({ d, onClose }: { d: Detail; onClose: (ok: boolean) => void }) {
  const m = d.mitglied;
  const [v, setV] = useState({
    anrede: m.anrede, vorname: m.vorname, nachname: m.nachname, strasse: m.strasse, plz: m.plz, ort: m.ort, telefon: m.telefon, mobil: m.mobil,
    email: m.email, geburtsdatum: m.geburtsdatum, eintritt: m.eintritt, datenschutz: m.datenschutz, bildrechte: m.bildrechte,
  });
  const s = useSenden(() => api.put(`${MG}/m/${m.adrnr}/kopf`, v), () => onClose(true));
  const f = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  return (
    <Dlg titel={`Stammdaten – ${d.titel}`} onClose={() => onClose(false)}
         fuss={<Button design="Emphasized" disabled={s.busy || !v.nachname.trim()} onClick={s.los}>Sichern</Button>}>
      <Fehler text={s.error} onClose={() => s.setError(null)} />
      <FormGrid>
        <Auswahlfeld label="Anrede" value={v.anrede} optionen={[['', ''], ['Herr', 'Herr'], ['Frau', 'Frau']]} onChange={f('anrede')} />
        <TextField label="Vorname" value={v.vorname} onChange={f('vorname')} />
        <TextField label="Nachname" required value={v.nachname} onChange={f('nachname')} />
        <Datum label="Geburtsdatum" value={v.geburtsdatum} onChange={f('geburtsdatum')} />
        <TextField label="Straße" value={v.strasse} onChange={f('strasse')} wide />
        <TextField label="PLZ" value={v.plz} onChange={f('plz')} />
        <TextField label="Ort" value={v.ort} onChange={f('ort')} />
        <TextField label="Telefon" type="Tel" value={v.telefon} onChange={f('telefon')} />
        <TextField label="Mobil" type="Tel" value={v.mobil} onChange={f('mobil')} />
        <TextField label="E-Mail" type="Email" value={v.email} onChange={f('email')} wide />
        <Datum label="Eintritt" value={v.eintritt} onChange={f('eintritt')} />
        <FieldBox label="Einwilligungen">
          <CheckBox text="Datenverarbeitung" checked={v.datenschutz} onChange={(e) => setV({ ...v, datenschutz: e.target.checked })} />
          <CheckBox text="Verwendung Bild/Name" checked={v.bildrechte} onChange={(e) => setV({ ...v, bildrechte: e.target.checked })} />
        </FieldBox>
      </FormGrid>
    </Dlg>
  );
}

// ---------------------------------------------------------------- Bank
interface IbanErgebnis { gueltig: boolean; iban: string; anzeige: string; blz: string | null; bic: string | null; bank: string | null; quelle: string | null; text: string; verzeichnis: number }

/**
 * „IBAN prüfen“: verprobt die IBAN auf dem Server (Länge, Prüfziffer) und übernimmt BIC und Kreditinstitut,
 * soweit sie sich ermitteln lassen. Fehlt das Bankleitzahlen-Verzeichnis, lässt es sich hier laden.
 */
export function IbanPruefung({ iban, onErgebnis, ladenErlaubt = true }: { iban: string; onErgebnis: (r: { iban: string; bic: string | null; bank: string | null }) => void; ladenErlaubt?: boolean }) {
  const [r, setR] = useState<IbanErgebnis | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [geladen, setGeladen] = useState<string | null>(null);
  useEffect(() => { setR(null); setFehler(null); }, [iban]);
  async function pruefen() {
    setBusy(true); setFehler(null);
    try {
      const e = await api.post<IbanErgebnis>(`${MG}/bank/pruefen`, { iban });
      setR(e);
      if (e.gueltig) onErgebnis({ iban: e.anzeige, bic: e.bic, bank: e.bank });
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }
  async function laden(f: File | undefined) {
    if (!f) return;
    setBusy(true); setFehler(null);
    try {
      const d = await api.post<{ text: string }>(`${MG}/bank/blz`, { datei: (await dateiLesen(f)).replace(/^data:[^,]*,/, '') });
      setGeladen(d.text);
      if (iban.trim()) await pruefen();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }
  const ohneBank = r?.gueltig && !r.bic && !!r.blz;
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <Button icon="validate" disabled={busy || !iban.trim() || iban.includes('•')} onClick={pruefen}>IBAN prüfen</Button>
      {r && <MessageStrip design={!r.gueltig ? 'Negative' : r.bic ? 'Positive' : 'Critical'} hideCloseButton style={{ marginTop: '0.5rem' }}>{r.text}</MessageStrip>}
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginTop: '0.5rem' }}>{fehler}</MessageStrip>}
      {geladen && <MessageStrip design="Positive" hideCloseButton style={{ marginTop: '0.5rem' }}>{geladen}</MessageStrip>}
      {ladenErlaubt && (ohneBank || (r && r.verzeichnis === 0)) && (
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          Für BIC und Banknamen die Bankleitzahlendatei der Deutschen Bundesbank (bundesbank.de → „Bankleitzahlen“ → Download, Text oder CSV) einmalig laden:{' '}
          <label style={{ color: 'var(--sapLinkColor)', cursor: 'pointer' }}>
            Datei auswählen
            <input type="file" hidden accept=".txt,.csv,text/plain,text/csv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; laden(f); }} />
          </label>
        </Text>
      )}
    </div>
  );
}

export function BankDialog({ d, aw, onClose }: { d: Detail; aw: Auswahl; onClose: (ok: boolean) => void }) {
  const b = d.bank;
  const [v, setV] = useState({ zahlungsart: b.zahlungsart || 'L', zahlungsweise: b.zahlungsweise, iban: b.iban, bic: b.bic, bank: b.bank, abwkontoinh: b.abwkontoinh, adrnrkih: b.adrnrkih });
  const s = useSenden(() => api.put(`${MG}/m/${d.mitglied.adrnr}/bank`, v), () => onClose(true));
  const f = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  const zahler = aw.zahler.find((z) => z.adrnr === v.adrnrkih);
  return (
    <Dlg titel={`Bankverbindung – ${d.titel}`} onClose={() => onClose(false)}
         fuss={<Button design="Emphasized" disabled={s.busy} onClick={s.los}>Sichern</Button>}>
      <Fehler text={s.error} onClose={() => s.setError(null)} />
      <FormGrid>
        <Auswahlfeld label="Zahlungsart" required value={v.zahlungsart} optionen={Object.entries(aw.zahlungsarten)} onChange={f('zahlungsart')} />
        <Auswahlfeld label="Zahlungsweise" value={v.zahlungsweise} optionen={[['', ''], ...Object.entries(aw.zahlungsweisen)]} onChange={f('zahlungsweise')} />
        <TextField label="IBAN" required={v.zahlungsart === 'L'} value={v.iban} onChange={f('iban')} />
        <TextField label="BIC" value={v.bic} onChange={f('bic')} />
        <TextField label="Kreditinstitut" value={v.bank} onChange={f('bank')} wide />
        <IbanPruefung iban={v.iban} onErgebnis={(r) => setV((o) => ({ ...o, iban: r.iban, bic: r.bic ?? o.bic, bank: r.bank ?? o.bank }))} />
        <Auswahlfeld label="Abweichender Zahler" wide value={v.adrnrkih}
                     optionen={[['', '– kein abweichender Zahler –'], ...aw.zahler.map((z) => [z.adrnr, z.text] as [string, string]),
                       ...(b.zahler && !aw.zahler.some((z) => z.adrnr === b.zahler!.adrnr) ? [[b.zahler.adrnr, `${b.zahler.name} (ausgetreten)`] as [string, string]] : [])]}
                     onChange={f('adrnrkih')} />
        <TextField label="Kontoinhaber (Freitext)" wide value={v.abwkontoinh} onChange={f('abwkontoinh')}
                   placeholder={zahler ? zahler.text.split(',')[0] : `${d.mitglied.vorname} ${d.mitglied.nachname}`} />
      </FormGrid>
      {zahler && zahler.iban && v.iban && zahler.iban.replace(/\s/g, '') !== v.iban.replace(/\s/g, '').toUpperCase() && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.75rem' }}>Die IBAN weicht von der beim Zahler hinterlegten IBAN ab.</MessageStrip>
      )}
    </Dlg>
  );
}

// ---------------------------------------------------------------- Vertrag
/** Personen, für die auf der Seite des Mitglieds Verträge angelegt werden können: das Mitglied und wer über es zahlt */
export const vertragPersonen = (d: Detail) => d.familie.filter((p) => p.adrnr === d.mitglied.adrnr || (!p.austritt && p.rolle === 'Zahlt über dieses Mitglied'));

export function VertragDialog({ d, aw, adrnr, onClose }: { d: Detail; aw: Auswahl; /** vorbelegte Person (Vertragsbaum) */ adrnr?: string; onClose: (text: string | null) => void }) {
  const personen = vertragPersonen(d);
  const [v, setV] = useState({ adrnr: adrnr && personen.some((p) => p.adrnr === adrnr) ? adrnr : d.mitglied.adrnr, art: '', beginn: '', ende: '', turnus: '', betrag: '', zahler: '' });
  const [stamm, setStamm] = useState(false);
  const person = d.familie.find((p) => p.adrnr === v.adrnr);
  useEffect(() => {
    if (!v.art) return;
    const a = aw.arten.find((x) => x.art === v.art);
    const ein = person?.eintritt ?? new Date().toLocaleDateString('sv-SE');
    const heute = new Date().toLocaleDateString('sv-SE');
    api.get<{ beginn: string | null; betrag: number | null }>(`${MG}/vertragsbeginn?eintritt=${ein > heute ? ein : heute}&art=${encodeURIComponent(v.art)}`)
      .then((r) => {
        setStamm(r.betrag != null);
        setV((x) => ({ ...x, beginn: r.beginn ?? x.beginn, turnus: a?.turnus ?? x.turnus, betrag: String(r.betrag ?? a?.betrag ?? '').replace('.', ',') }));
      }).catch(() => undefined);
  }, [v.art, v.adrnr]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useSenden(() => api.post<{ text: string }>(`${MG}/m/${v.adrnr}/vertraege`, {
    art: v.art, beginn: v.beginn, ende: v.ende || null, turnus: v.turnus, betrag: Number(v.betrag.replace(',', '.')), zahler: v.zahler || null,
  }), (r) => onClose(r.text));
  const f = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  return (
    <Dlg titel="Vertrag hinzufügen" onClose={() => onClose(null)}
         fuss={<Button design="Emphasized" disabled={s.busy || !v.art || !v.beginn || !v.turnus || v.betrag === ''} onClick={s.los}>Anlegen</Button>}>
      <Fehler text={s.error} onClose={() => s.setError(null)} />
      <FormGrid>
        {personen.length > 1 && <Auswahlfeld label="Für" wide value={v.adrnr} optionen={personen.map((p) => [p.adrnr, p.name])} onChange={f('adrnr')} />}
        <Auswahlfeld label="Vertragsart" required wide value={v.art} optionen={[['', '– bitte wählen –'], ...aw.arten.map((a) => [a.art, `${a.art} – ${a.name} (${eur(a.betrag)}, ${a.turnus})`] as [string, string])]} onChange={f('art')} />
        <Datum label="Beginn" required value={v.beginn} onChange={f('beginn')} />
        <Datum label="Ende (leer = unbefristet)" value={v.ende} onChange={f('ende')} />
        <Auswahlfeld label="Turnus" required value={v.turnus} optionen={[['', ''], ...aw.turnusse.map((t) => [t, t] as [string, string])]} onChange={f('turnus')} />
        <TextField label={stamm ? 'Betrag (laut Beitragsstamm)' : 'Betrag'} required value={v.betrag} onChange={f('betrag')} />
        <Auswahlfeld label="Zahler" wide value={v.zahler} optionen={[['', 'wie Mitglied'], ...aw.vtZahler.filter((z) => z.adrnr !== v.adrnr).map((z) => [z.adrnr, z.text] as [string, string])]} onChange={f('zahler')} />
      </FormGrid>
      <MessageStrip hideCloseButton style={{ marginTop: '0.75rem' }}>
        Mitgliedsbeiträge beginnen zum nächsten Halbjahr (1.1./1.7.), das Jugendtraining zum nächsten Monatsersten. Als Zahler stehen Personen mit aktivem SEPA-Mandat zur Wahl.
      </MessageStrip>
    </Dlg>
  );
}

// ---------------------------------------------------------------- Kommunikation
interface Komm { an: string; mobil: string; kanal: string; betreff: string; text: string; links: { id: number; titel: string; link: string }[]; mailto: string; whatsapp: string; n8n: boolean }

export function KommDialog({ d, art: artStart, unterlagen, docs, edit, onClose }: {
  d: Detail; art: string; unterlagen: Record<string, string>; docs: number[]; edit: boolean; onClose: (text: string | null) => void;
}) {
  const [art, setArt] = useState(artStart === '5' ? '' : artStart);
  const [k, setK] = useState<Komm | null>(null);
  const [an, setAn] = useState('');
  const [betreff, setBetreff] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setK(null);
    api.post<Komm>(`${MG}/m/${d.mitglied.adrnr}/komm`, { art, ids: docs })
      .then((r) => { setK(r); setAn(r.an); setBetreff(r.betreff); setText(r.text); }).catch((e) => setError(e.message));
  }, [art]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useSenden(() => api.post<{ text: string }>(`${MG}/m/${d.mitglied.adrnr}/mail`, { an, betreff, text }), (r) => onClose(r.text));
  const mobil = k?.mobil ?? '';
  return (
    <Dlg titel={`Kommunikation – ${d.titel}`} breite="min(900px, 95vw)" onClose={() => onClose(null)}
         fuss={<>
           {mobil && <Button icon="discussion" onClick={() => window.open(`https://wa.me/${mobil}?text=${encodeURIComponent(text)}`, '_blank')}>WhatsApp öffnen</Button>}
           {an && <Button icon="email" onClick={() => { window.location.href = `mailto:${an}?subject=${encodeURIComponent(betreff)}&body=${encodeURIComponent(text)}`; }}>E-Mail-Programm</Button>}
           {edit && k?.n8n && <Button design="Emphasized" icon="paper-plane" disabled={s.busy || !an} onClick={s.los}>E-Mail senden</Button>}
         </>}>
      <Fehler text={error ?? s.error} onClose={() => { setError(null); s.setError(null); }} />
      <FormGrid>
        <Auswahlfeld label="Anlass" value={art} optionen={[['', 'Unterlagen allgemein'], ...Object.entries(unterlagen).filter(([x]) => x !== '5')]} onChange={setArt} />
        <FieldBox label="Bevorzugter Versandweg"><Text>{k ? (k.kanal === 'W' ? 'WhatsApp' : k.kanal === 'E' ? 'E-Mail' : 'keiner') : ''}</Text></FieldBox>
        <TextField label="An (E-Mail)" type="Email" value={an} onChange={setAn} />
        <FieldBox label="Mobilnummer (WhatsApp)"><Text>{mobil ? `+${mobil}` : 'keine Mobilnummer hinterlegt'}</Text></FieldBox>
        <TextField label="Betreff" wide value={betreff} onChange={setBetreff} />
        <FieldBox label="Text" wide>
          <TextArea rows={16} value={text} onInput={(e) => setText(e.target.value)} style={{ width: '100%' }} />
        </FieldBox>
      </FormGrid>
      {k && (k.links.length
        ? <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>{k.links.length} Dokument(e) werden als Freigabelink (30 Tage) eingefügt: {k.links.map((l) => <Link key={l.id} href={l.link} target="_blank">{l.titel} </Link>)}</MessageStrip>
        : <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.5rem' }}>Kein Dokument verlinkt – bitte unter „Dokumente“ markieren oder zuerst eine Unterlage ablegen.</MessageStrip>)}
    </Dlg>
  );
}

