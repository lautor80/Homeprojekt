import { useEffect, useState } from 'react';
import { Button, CheckBox, MessageStrip, ObjectStatus, Text, Title } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FormGrid, TextField } from '@core/components/FormFields';
import { TCO, dat, eur } from '../util';
import type { Vertrag } from './typen';
import { Auswahlfeld, Dlg } from './Dialoge';
import './vorgang.css';

/**
 * Geführte Vorgänge in „Meine Mitgliedschaft“ (#154): Beitrag wechseln, Jugendtraining abschließen, kündigen –
 * jeweils Angaben → Prüfen → Ergebnis. Mitglieder wählen nur aus dem, was der Server anbietet (feste Termine und Beträge).
 */
export type MeinTyp = 'BEITRAGSWECHSEL' | 'JUGENDTRAINING' | 'KUENDIGUNG';
export const MEIN_TITEL: Record<MeinTyp, string> = { BEITRAGSWECHSEL: 'Beitrag wechseln', JUGENDTRAINING: 'Jugendtraining abschließen', KUENDIGUNG: 'Kündigen' };
const MG = `${TCO}/mitglieder/meine`;

interface Art { art: string; name: string; betrag: number; turnus: string }
interface SPerson {
  adrnr: string; name: string; ich: boolean; alter: number | null; vertraege: Vertrag[];
  wechsel: { vertragnr: string; artname: string; betrag: number; turnus: string; arten: Art[] } | null; wechselHinweis: string | null;
  training: Art[]; trainingHinweis: string | null;
}
interface Kontext { personen: SPerson[]; ab: string; trainingAb: string; maxTraining: number }
interface Unterlage { pdf: string; dateiname: string; titel: string; gesendet: boolean; hinweise: string[] }
interface Ergebnis { text: string; schritte: string[]; unterlage: Unterlage | null }
export type KVertrag = Vertrag & { kuendbar: boolean; endeBei: string; /** eigener Mitgliedsbeitrag: Kündigung = Austritt */ mitgliedsbeitrag?: boolean };
/** Angaben für die Kündigung aus der Seite „Meine Mitgliedschaft“ */
export interface KuendigungDaten { gekuendigt: boolean; ende: string; eigene: KVertrag[]; kuendbar: KVertrag[] }

const SCHRITTE = ['Angaben', 'Prüfen', 'Ergebnis'];

export function MeinVorgangDialog({ typ, kuendigung, gesperrt, onClose }: {
  typ: MeinTyp; kuendigung: KuendigungDaten; /** Meldung, wenn der Vorstand das Mitglied gerade bearbeitet */ gesperrt: string | null; onClose: (geaendert: boolean) => void;
}) {
  const [k, setK] = useState<Kontext | null>(null);
  const [schritt, setSchritt] = useState(0);
  const [plan, setPlan] = useState<{ schritte: string[]; warnungen: string[] } | null>(null);
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adrnr, setAdrnr] = useState('');
  const [art, setArt] = useState('');
  const [wahl, setWahl] = useState<Set<string>>(new Set()); // Kündigung: gewählte Verträge (adrnr|vertragnr), Mehrfachauswahl
  const [grund, setGrund] = useState('');
  const [ok, setOk] = useState(false);

  const moeglich = (p: SPerson) => (typ === 'BEITRAGSWECHSEL' ? !!p.wechsel : p.training.length > 0);
  useEffect(() => {
    if (typ === 'KUENDIGUNG') return;
    api.get<Kontext>(`${MG}/vorgang`).then((r) => { setK(r); setAdrnr((r.personen.find(moeglich) ?? r.personen[0])?.adrnr ?? ''); }).catch((e) => setError(e.message));
  }, [typ]); // eslint-disable-line react-hooks/exhaustive-deps

  const person = k?.personen.find((p) => p.adrnr === adrnr);
  const arten = person ? (typ === 'BEITRAGSWECHSEL' ? person.wechsel?.arten ?? [] : person.training) : [];
  const gewaehlt = arten.find((a) => a.art === art);
  const hinweis = person ? (typ === 'BEITRAGSWECHSEL' ? person.wechselHinweis : person.trainingHinweis) : null;
  useEffect(() => { setArt(arten.length === 1 ? arten[0].art : ''); }, [adrnr, k]); // eslint-disable-line react-hooks/exhaustive-deps

  const kkey = (v: KVertrag) => `${v.adrnr}|${v.vertragnr}`;
  const gewaehlte = kuendigung.kuendbar.filter((v) => wahl.has(kkey(v)));
  // eigener Mitgliedsbeitrag gewählt ⇒ die Mitgliedschaft endet (Austritt), alle eigenen Verträge enden mit
  const austritt = !kuendigung.gekuendigt && gewaehlte.some((v) => v.eigen && v.mitgliedsbeitrag);
  /** Kündigung: was beim Ausführen passiert (wie der Server rechnet) */
  function kuendigungsPlan() {
    const out: string[] = [];
    if (austritt) {
      out.push(`Die Mitgliedschaft endet am ${dat(kuendigung.ende)} (Austritt)`,
        ...kuendigung.eigene.filter((v) => v.laeuft && !v.vertragende).map((v) => `Vertrag „${v.artname || v.art}“ endet am ${dat(v.endeBei < kuendigung.ende ? v.endeBei : kuendigung.ende)}`));
    }
    for (const v of gewaehlte) {
      if (austritt && v.eigen) continue;
      out.push(`Vertrag „${v.artname || v.art}“${v.eigen ? '' : ` von ${v.person}`} endet am ${dat(v.endeBei)}`);
    }
    return [...out, 'Kündigungsbestätigung wird erzeugt und per E-Mail gesendet; der Vorstand erhält eine Kopie'];
  }

  async function pruefen() {
    setError(null); setOk(false);
    if (typ === 'KUENDIGUNG') { setPlan({ schritte: kuendigungsPlan(), warnungen: [] }); setSchritt(1); return; }
    setBusy(true);
    try { setPlan(await api.post<{ schritte: string[]; warnungen: string[] }>(`${MG}/vorgang/pruefen`, { typ, adrnr, art })); setSchritt(1); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function ausfuehren() {
    setBusy(true); setError(null);
    try {
      if (typ === 'KUENDIGUNG') {
        const r = await api.post<{ text: string; pdf: string; dateiname: string; gesendet: boolean; hinweise: string[] }>(`${MG}/kuendigung`, {
          art: 'VERTRAG', grund: grund || null, bestaetigung: true, vertraege: gewaehlte.map((v) => ({ adrnr: v.adrnr, vertragnr: v.vertragnr })),
        });
        setErgebnis({ text: r.text, schritte: plan?.schritte.slice(0, -1) ?? [], unterlage: { pdf: r.pdf, dateiname: r.dateiname, titel: 'Kündigungsbestätigung', gesendet: r.gesendet, hinweise: r.hinweise } });
      } else setErgebnis(await api.post<Ergebnis>(`${MG}/vorgang`, { typ, adrnr, art }));
      setSchritt(2);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const vollstaendig = typ === 'KUENDIGUNG' ? gewaehlte.length > 0 : !!(adrnr && art);
  const fuss = schritt === 0
    ? <Button design="Emphasized" disabled={busy || !!gesperrt || !vollstaendig} onClick={pruefen}>Weiter: Prüfen</Button>
    : schritt === 1
      ? <><Button disabled={busy} onClick={() => setSchritt(0)}>Zurück</Button>
          <Button design={typ === 'KUENDIGUNG' ? 'Negative' : 'Emphasized'} disabled={busy || !!gesperrt || !ok} onClick={ausfuehren}>
            {typ === 'KUENDIGUNG' ? 'Verbindlich kündigen' : typ === 'JUGENDTRAINING' ? 'Verbindlich abschließen' : 'Verbindlich wechseln'}</Button></>
      : <Button design="Emphasized" onClick={() => onClose(true)}>Fertig</Button>;

  const personenWahl = k && k.personen.length > 1
    ? <Auswahlfeld label="Für wen?" required wide value={adrnr} optionen={k.personen.map((p) => [p.adrnr, `${p.name}${p.ich ? ' (ich)' : ''}${p.alter != null ? `, ${p.alter} Jahre` : ''}`] as [string, string])} onChange={setAdrnr} />
    : null;

  return (
    <Dlg titel={MEIN_TITEL[typ]} breite="min(760px, 96vw)" onClose={() => onClose(schritt === 2)} fuss={fuss}>
      <ol className="portal-vg__schritte" aria-label="Schritte">
        {SCHRITTE.map((s, i) => (
          <li key={s} className={i === schritt ? 'aktiv' : i < schritt ? 'fertig' : ''} aria-current={i === schritt ? 'step' : undefined}>
            <span className="portal-vg__nr">{i < schritt ? '✓' : i + 1}</span>{s}
          </li>
        ))}
      </ol>
      {(gesperrt || error) && <MessageStrip design="Negative" hideCloseButton={!!gesperrt} onClose={() => setError(null)} style={{ marginBottom: '0.75rem', whiteSpace: 'pre-line' }}>{gesperrt || error}</MessageStrip>}
      {typ !== 'KUENDIGUNG' && !k && !error && <Text>Lade …</Text>}

      {schritt === 0 && typ !== 'KUENDIGUNG' && k && (
        <>
          <FormGrid>
            {personenWahl}
            {person && person.vertraege.length > 0 && (
              <div style={{ gridColumn: '1 / -1' }} className="portal-vg__vertraege">
                {person.vertraege.map((v) => (
                  <ObjectStatus key={v.vertragnr} state={v.vertragende ? 'Critical' : 'Information'}>
                    {v.artname} · {eur(v.betrag)} {v.sollstellung}{v.vertragende ? ` · bis ${dat(v.vertragende)}` : ''}
                  </ObjectStatus>
                ))}
              </div>
            )}
            {arten.length > 0 && (
              <Auswahlfeld label={typ === 'BEITRAGSWECHSEL' ? 'Neuer Mitgliedsbeitrag' : 'Trainingseinheit'} required wide value={art}
                           optionen={[['', '– bitte wählen –'], ...arten.map((a) => [a.art, `${a.name} – ${eur(a.betrag)} ${a.turnus}`] as [string, string])]} onChange={setArt} />
            )}
          </FormGrid>
          {hinweis && <MessageStrip design="Information" hideCloseButton style={{ marginTop: '0.75rem' }}>{hinweis}</MessageStrip>}
          {arten.length > 0 && (
            <MessageStrip hideCloseButton style={{ marginTop: '0.75rem' }}>
              {typ === 'BEITRAGSWECHSEL'
                ? `Der Wechsel gilt ab dem nächsten Halbjahr (${dat(k.ab)}); bis dahin läuft „${person?.wechsel?.artname}“ weiter.${gewaehlt ? ` Neuer Beitrag: ${eur(gewaehlt.betrag)} ${gewaehlt.turnus}.` : ''} Familienbeitrag und ruhende Mitgliedschaft bitte über den Vorstand.`
                : `Das Training beginnt am ${dat(k.trainingAb)} und läuft unbefristet; kündbar zum 30.09. eines Jahres.${gewaehlt ? ` Beitrag: ${eur(gewaehlt.betrag)} ${gewaehlt.turnus}, Einzug per SEPA-Lastschrift.` : ''} Je Person sind bis zu ${k.maxTraining} Einheiten möglich.`}
            </MessageStrip>
          )}
        </>
      )}

      {schritt === 0 && typ === 'KUENDIGUNG' && (
        <>
          <Title level="H5" style={{ marginBottom: '0.25rem' }}>Was möchtest du kündigen?</Title>
          {kuendigung.kuendbar.length === 0
            ? <MessageStrip design="Information" hideCloseButton>Es gibt keinen laufenden Vertrag, der noch gekündigt werden kann.</MessageStrip>
            : (
              <div className="portal-vg__wahl" role="group" aria-label="Verträge">
                {kuendigung.kuendbar.map((v) => (
                  <CheckBox key={kkey(v)} wrappingType="Normal" checked={wahl.has(kkey(v))}
                            text={`${v.artname || v.art}${v.eigen ? '' : ` – ${v.person}`} · ${eur(v.betrag)} ${v.sollstellung} · endet zum ${dat(v.endeBei)}`}
                            onChange={(e) => { const n = new Set(wahl); if (e.target.checked) n.add(kkey(v)); else n.delete(kkey(v)); setWahl(n); }} />
                ))}
              </div>
            )}
          {austritt && (
            <MessageStrip design="Critical" hideCloseButton style={{ margin: '0.5rem 0' }}>
              Mit deinem Mitgliedsbeitrag kündigst du die Mitgliedschaft: Austritt zum {dat(kuendigung.ende)}, alle deine Verträge enden.
            </MessageStrip>
          )}
          <FormGrid>
            <TextField label="Grund (freiwillig)" wide value={grund} onChange={setGrund} />
          </FormGrid>
          <MessageStrip hideCloseButton style={{ marginTop: '0.75rem' }}>
            Mitgliedschaft und Verträge enden zum 31.12. des laufenden Jahres, das Jugendtraining zum nächsten 30.09. Kündigungsdatum ist heute.
          </MessageStrip>
        </>
      )}

      {schritt === 1 && plan && (
        <>
          <Title level="H5" style={{ marginBottom: '0.5rem' }}>Das passiert, wenn du bestätigst</Title>
          <ol className="portal-vg__liste">{plan.schritte.filter((s) => !s.startsWith('Notiz am Mitglied')).map((s) => <li key={s}>{s}</li>)}</ol>
          {plan.warnungen.map((w) => <MessageStrip key={w} design="Critical" hideCloseButton style={{ marginTop: '0.5rem' }}>{w}</MessageStrip>)}
          <CheckBox style={{ marginTop: '0.75rem', marginLeft: '-0.5rem' }} wrappingType="Normal" checked={ok} onChange={(e) => setOk(e.target.checked)}
                    text={typ === 'KUENDIGUNG' ? 'Ja, ich möchte verbindlich kündigen.'
                      : typ === 'JUGENDTRAINING' ? 'Ich schließe das Training verbindlich ab, bin mit dem Einzug per SEPA-Lastschrift einverstanden und habe die Kündigungsfrist (zum 30.09.) zur Kenntnis genommen.'
                        : 'Ich möchte den Beitrag verbindlich wechseln; der neue Beitrag wird wie bisher eingezogen.'} />
        </>
      )}

      {schritt === 2 && ergebnis && (
        <>
          <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '0.75rem' }}>{ergebnis.text}</MessageStrip>
          <ol className="portal-vg__liste">{ergebnis.schritte.filter((s) => !s.startsWith('Notiz am Mitglied')).map((s) => <li key={s}>{s}</li>)}</ol>
          {ergebnis.unterlage && (
            <div style={{ marginTop: '0.75rem' }}>
              <Title level="H5">{ergebnis.unterlage.titel}</Title>
              {ergebnis.unterlage.gesendet && <Text>Per E-Mail gesendet – der Vorstand hat eine Kopie erhalten.</Text>}
              {ergebnis.unterlage.hinweise.map((h) => <MessageStrip key={h} design="Critical" hideCloseButton style={{ marginTop: '0.5rem' }}>{h}</MessageStrip>)}
              <div style={{ marginTop: '0.5rem' }}><Button icon="download" onClick={() => herunterladen(ergebnis.unterlage!)}>{ergebnis.unterlage.dateiname}</Button></div>
            </div>
          )}
        </>
      )}
    </Dlg>
  );
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
