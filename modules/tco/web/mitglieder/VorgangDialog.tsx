import { useEffect, useState } from 'react';
import { Button, CheckBox, MessageStrip, ObjectStatus, Text, Title } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FormGrid, TextField } from '@core/components/FormFields';
import { dat, eur } from '../util';
import { MG, type Vertrag } from './typen';
import { Auswahlfeld, Datum, Dlg } from './Dialoge';
import './vorgang.css';

/**
 * Geführte Vorgänge (#154): Beitragswechsel, Abschluss Jugendtraining, Kündigung – Schritt für Schritt
 * Angaben → Prüfen (geplante Änderungen und Hinweise vom Server) → Ergebnis (mit Unterlage zum Herunterladen).
 */
export type VorgangTyp = 'BEITRAGSWECHSEL' | 'JUGENDTRAINING' | 'KUENDIGUNG';
export const VORGANG_TEXT: Record<VorgangTyp, string> = {
  BEITRAGSWECHSEL: 'Beitragswechsel', JUGENDTRAINING: 'Abschluss Jugendtraining', KUENDIGUNG: 'Kündigung',
};
const ART_JUGEND = '90';

interface Kontext {
  person: { adrnr: string; name: string; mitglnrn: string; geburtsdatum: string | null; alter: number | null; eintritt: string | null; austritt: string | null; mitglied: boolean; email: string };
  vertraege: Vertrag[]; laufend: Vertrag[];
  arten: { art: string; name: string; betrag: number; turnus: string }[]; turnusse: string[];
  zahler: { adrnr: string; text: string }[]; zahlende: { adrnr: string; name: string }[];
  vorschlag: { wechselAb: string; jugendAb: string; eingang: string; endeMitgliedschaft: string; endeJugend: string };
  fristTage: number; mail: boolean; paperless: boolean;
}
interface Plan { text: string; schritte: string[]; warnungen: string[]; unterlage: string }
interface Unterlage { pdf: string; dateiname: string; titel: string; abgelegt: boolean; gesendet: boolean; an: string; hinweise: string[] }

type Ergebnis = Omit<Plan, 'unterlage'> & { unterlage: Unterlage | null };
const SCHRITTE = ['Angaben', 'Prüfen', 'Ergebnis'];
const zahl = (s: string) => (s.trim() === '' ? null : Number(s.replace(/\./g, '').replace(',', '.')));

export function VorgangDialog({ adrnr, typ, onClose }: { adrnr: string; typ: VorgangTyp; onClose: (geaendert: boolean) => void }) {
  const [k, setK] = useState<Kontext | null>(null);
  const [schritt, setSchritt] = useState(0);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Angaben (als Text für die Eingabefelder)
  const [f, setF] = useState({
    vertragnr: '', art: '', ab: '', beginn: '', turnus: '', betrag: '', zahler: '', notiz: '',
    umfang: 'MITGLIEDSCHAFT' as 'MITGLIEDSCHAFT' | 'VERTRAG', eingang: '', ende: '', grund: '', unterlage: true,
  });
  const set = (x: Partial<typeof f>) => setF((a) => ({ ...a, ...x }));

  useEffect(() => {
    api.get<Kontext>(`${MG}/m/${adrnr}/vorgang`).then((r) => {
      setK(r);
      const erster = r.laufend.find((v) => v.art !== ART_JUGEND) ?? r.laufend[0];
      const jt = r.laufend.find((v) => v.art === ART_JUGEND);
      set({
        vertragnr: typ === 'KUENDIGUNG' ? (jt && !r.person.mitglied ? jt.vertragnr : '') : erster?.vertragnr ?? '',
        ab: r.vorschlag.wechselAb, beginn: r.vorschlag.jugendAb, art: typ === 'JUGENDTRAINING' ? ART_JUGEND : '',
        eingang: r.vorschlag.eingang, ende: r.vorschlag.endeMitgliedschaft,
        umfang: r.person.mitglied && !r.person.austritt ? 'MITGLIEDSCHAFT' : 'VERTRAG',
        unterlage: r.mail || r.paperless,
      });
    }).catch((e) => setError(e.message));
  }, [adrnr, typ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vorschläge aus dem Beitragsstamm: Turnus und Betrag der gewählten Art
  const artWaehlen = (art: string) => {
    const a = k?.arten.find((x) => x.art === art);
    set({ art, turnus: a?.turnus ?? '', betrag: a ? String(a.betrag).replace('.', ',') : '' });
  };
  useEffect(() => { if (k && typ === 'JUGENDTRAINING' && f.art && !f.turnus) artWaehlen(f.art); }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  // Kündigung: Ende nach Frist je Umfang/Vertrag und Eingang
  useEffect(() => {
    if (!k || typ !== 'KUENDIGUNG' || !f.eingang) return;
    const vt = k.laufend.find((v) => v.vertragnr === f.vertragnr);
    const jugend = f.umfang === 'VERTRAG' && vt?.art === ART_JUGEND;
    set({ ende: fristEnde(f.eingang, jugend, k.fristTage) });
  }, [f.eingang, f.umfang, f.vertragnr]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = () => typ === 'BEITRAGSWECHSEL'
    ? { typ, adrnr, vertragnr: f.vertragnr, art: f.art, ab: f.ab, turnus: f.turnus || null, betrag: zahl(f.betrag), notiz: f.notiz || null, unterlage: f.unterlage }
    : typ === 'JUGENDTRAINING'
      ? { typ, adrnr, art: f.art || ART_JUGEND, beginn: f.beginn, turnus: f.turnus || null, betrag: zahl(f.betrag), zahler: f.zahler || null, notiz: f.notiz || null, unterlage: f.unterlage }
      : { typ, adrnr, umfang: f.umfang, vertragnr: f.umfang === 'VERTRAG' ? f.vertragnr : null, eingang: f.eingang, ende: f.ende, grund: f.grund || null, unterlage: f.unterlage };

  async function pruefen() {
    setBusy(true); setError(null);
    try { setPlan(await api.post<Plan>(`${MG}/vorgang/pruefen`, body())); setSchritt(1); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function ausfuehren() {
    setBusy(true); setError(null);
    try {
      setErgebnis(await api.post<Ergebnis>(`${MG}/vorgang`, body()));
      setSchritt(2);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const vollstaendig = typ === 'BEITRAGSWECHSEL' ? !!(f.vertragnr && f.art && f.ab && f.turnus && f.betrag)
    : typ === 'JUGENDTRAINING' ? !!(f.beginn && f.turnus && f.betrag)
      : !!(f.eingang && f.ende && (f.umfang === 'MITGLIEDSCHAFT' || f.vertragnr));

  const fuss = schritt === 0
    ? <Button design="Emphasized" disabled={busy || !k || !vollstaendig} onClick={pruefen}>Weiter: Prüfen</Button>
    : schritt === 1
      ? <><Button disabled={busy} onClick={() => setSchritt(0)}>Zurück</Button>
          <Button design={typ === 'KUENDIGUNG' ? 'Negative' : 'Emphasized'} disabled={busy} onClick={ausfuehren}>{VORGANG_TEXT[typ]} ausführen</Button></>
      : <Button design="Emphasized" onClick={() => onClose(true)}>Fertig</Button>;

  const altVertrag = k?.laufend.find((v) => v.vertragnr === f.vertragnr);
  return (
    <Dlg titel={`${VORGANG_TEXT[typ]}${k ? ` – ${k.person.name}` : ''}`} breite="min(820px, 95vw)" onClose={() => onClose(schritt === 2)} fuss={fuss}>
      <ol className="portal-vg__schritte" aria-label="Schritte">
        {SCHRITTE.map((s, i) => (
          <li key={s} className={i === schritt ? 'aktiv' : i < schritt ? 'fertig' : ''} aria-current={i === schritt ? 'step' : undefined}>
            <span className="portal-vg__nr">{i < schritt ? '✓' : i + 1}</span>{s}
          </li>
        ))}
      </ol>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {!k && !error && <Text>Lade …</Text>}

      {k && schritt === 0 && (
        <>
          <div className="portal-vg__person">
            <Text>
              {k.person.mitglnrn ? `Mitglied Nr. ${k.person.mitglnrn}` : 'kein Vereinsmitglied'}
              {k.person.alter != null && ` · ${k.person.alter} Jahre`}
              {k.person.eintritt && ` · Eintritt ${dat(k.person.eintritt)}`}
              {k.person.austritt && ` · Austritt ${dat(k.person.austritt)}`}
            </Text>
            {k.laufend.length > 0 && (
              <div className="portal-vg__vertraege">
                {k.laufend.map((v) => (
                  <ObjectStatus key={v.vertragnr} state={v.vertragende ? 'Critical' : 'Information'}>
                    {v.artname} · {eur(v.betrag)} {v.sollstellung}{v.vertragende ? ` · bis ${dat(v.vertragende)}` : ''}
                  </ObjectStatus>
                ))}
              </div>
            )}
          </div>

          {typ === 'BEITRAGSWECHSEL' && (
            <FormGrid>
              <Auswahlfeld label="Bisheriger Vertrag" required wide value={f.vertragnr}
                           optionen={[['', '– bitte wählen –'], ...k.laufend.map((v) => [v.vertragnr, `${v.artname} (${eur(v.betrag)} ${v.sollstellung}, seit ${dat(v.vertragbegin)})`] as [string, string])]}
                           onChange={(x) => set({ vertragnr: x })} />
              <Auswahlfeld label="Neue Beitragsart" required wide value={f.art}
                           optionen={[['', '– bitte wählen –'], ...k.arten.filter((a) => a.art !== altVertrag?.art).map((a) => [a.art, `${a.art} – ${a.name} (${eur(a.betrag)}, ${a.turnus})`] as [string, string])]}
                           onChange={artWaehlen} />
              <Datum label="Wechsel ab" required value={f.ab} onChange={(x) => set({ ab: x })} />
              <Auswahlfeld label="Turnus" required value={f.turnus} optionen={[['', ''], ...k.turnusse.map((t) => [t, t] as [string, string])]} onChange={(x) => set({ turnus: x })} />
              <TextField label="Betrag (laut Beitragsstamm)" required value={f.betrag} onChange={(x) => set({ betrag: x })} />
              <TextField label="Notiz (optional)" value={f.notiz} onChange={(x) => set({ notiz: x })} />
            </FormGrid>
          )}

          {typ === 'JUGENDTRAINING' && (
            <FormGrid>
              <Auswahlfeld label="Vertragsart" required wide value={f.art}
                           optionen={k.arten.filter((a) => Number(a.art) >= 90 || a.art === f.art).map((a) => [a.art, `${a.art} – ${a.name} (${eur(a.betrag)}, ${a.turnus})`] as [string, string])}
                           onChange={artWaehlen} />
              <Datum label="Beginn" required value={f.beginn} onChange={(x) => set({ beginn: x })} />
              <Auswahlfeld label="Turnus" required value={f.turnus} optionen={[['', ''], ...k.turnusse.map((t) => [t, t] as [string, string])]} onChange={(x) => set({ turnus: x })} />
              <TextField label="Betrag (laut Beitragsstamm)" required value={f.betrag} onChange={(x) => set({ betrag: x })} />
              <Auswahlfeld label="Zahler" value={f.zahler} optionen={[['', 'wie Person / Kontoinhaber'], ...k.zahler.filter((z) => z.adrnr !== adrnr).map((z) => [z.adrnr, z.text] as [string, string])]}
                           onChange={(x) => set({ zahler: x })} />
              <TextField label="Notiz (optional)" wide value={f.notiz} onChange={(x) => set({ notiz: x })} />
            </FormGrid>
          )}

          {typ === 'KUENDIGUNG' && (
            <FormGrid>
              <Auswahlfeld label="Was wird gekündigt?" required wide value={f.umfang}
                           optionen={[...(k.person.mitglied && !k.person.austritt ? [['MITGLIEDSCHAFT', 'die ganze Mitgliedschaft (Austritt, alle Verträge)'] as [string, string]] : []),
                             ['VERTRAG', 'einen einzelnen Vertrag (z. B. Jugendtraining)']]}
                           onChange={(x) => set({ umfang: x as 'MITGLIEDSCHAFT' | 'VERTRAG' })} />
              {f.umfang === 'VERTRAG' && (
                <Auswahlfeld label="Vertrag" required wide value={f.vertragnr}
                             optionen={[['', '– bitte wählen –'], ...k.laufend.filter((v) => !v.vertragende).map((v) => [v.vertragnr, `${v.artname} (${eur(v.betrag)} ${v.sollstellung})`] as [string, string])]}
                             onChange={(x) => set({ vertragnr: x })} />
              )}
              <Datum label="Kündigung eingegangen am" required value={f.eingang} onChange={(x) => set({ eingang: x })} />
              <Datum label="Ende zum" required value={f.ende} onChange={(x) => set({ ende: x })} />
              <TextField label="Grund (optional)" wide value={f.grund} onChange={(x) => set({ grund: x })} />
            </FormGrid>
          )}
          {typ === 'KUENDIGUNG' && (
            <MessageStrip hideCloseButton style={{ marginTop: '0.75rem' }}>
              Kündigungsfrist {k.fristTage / 7} Wochen: Mitgliedschaft zum 31.12., Jugendtraining zum 30.09. – das Ende wird aus dem Eingang
              vorgeschlagen und kann (z. B. bei Sonderkündigung) geändert werden.
              {k.zahlende.length > 0 && ` Über dieses Mitglied zahlen: ${k.zahlende.map((z) => z.name).join(', ')}.`}
            </MessageStrip>
          )}
          <CheckBox style={{ marginTop: '0.5rem' }} checked={f.unterlage} onChange={(e) => set({ unterlage: e.target.checked })}
                    text={`${typ === 'KUENDIGUNG' ? 'Kündigungsbestätigung' : 'Mitgliederinformation'} erzeugen${k.paperless ? ', ablegen' : ''}${k.mail ? ` und an ${k.person.email} senden` : ''}`} />
        </>
      )}

      {k && schritt === 1 && plan && (
        <>
          <Title level="H5" style={{ marginBottom: '0.5rem' }}>Das passiert beim Ausführen</Title>
          <ol className="portal-vg__liste">{plan.schritte.map((s) => <li key={s}>{s}</li>)}</ol>
          {plan.warnungen.map((w) => <MessageStrip key={w} design="Critical" hideCloseButton style={{ marginTop: '0.5rem' }}>{w}</MessageStrip>)}
        </>
      )}

      {schritt === 2 && ergebnis && (
        <>
          <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '0.75rem' }}>{ergebnis.text}</MessageStrip>
          <ol className="portal-vg__liste">{ergebnis.schritte.map((s) => <li key={s}>{s}</li>)}</ol>
          {ergebnis.unterlage && (
            <div style={{ marginTop: '0.75rem' }}>
              <Title level="H5">{ergebnis.unterlage.titel}</Title>
              <Text>
                {[ergebnis.unterlage.abgelegt && 'in der Mitgliederakte abgelegt', ergebnis.unterlage.gesendet && `per E-Mail an ${ergebnis.unterlage.an} gesendet`]
                  .filter(Boolean).join(', ') || 'nicht abgelegt oder gesendet'}
              </Text>
              {ergebnis.unterlage.hinweise.map((h) => <MessageStrip key={h} design="Critical" hideCloseButton style={{ marginTop: '0.5rem' }}>{h}</MessageStrip>)}
              <div style={{ marginTop: '0.5rem' }}>
                <Button icon="download" onClick={() => herunterladen(ergebnis.unterlage!)}>{ergebnis.unterlage.dateiname}</Button>
              </div>
            </div>
          )}
        </>
      )}
    </Dlg>
  );
}

/** wie der Server: frühestes Ende nach Eingang + Frist (Mitgliedschaft 31.12., Jugendtraining 30.09.) */
export function fristEnde(eingang: string, jugend: boolean, tage = 28): string {
  const d = new Date(`${eingang}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  const iso = d.toISOString().slice(0, 10);
  const j = Number(iso.slice(0, 4));
  if (!jugend) return `${j}-12-31`;
  return iso <= `${j}-09-30` ? `${j}-09-30` : `${j + 1}-09-30`;
}

function herunterladen(u: Unterlage) {
  const bin = atob(u.pdf);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = u.dateiname; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
