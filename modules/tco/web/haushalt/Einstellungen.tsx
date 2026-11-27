import { useEffect, useState } from 'react';
import { Button, MessageStrip } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { CheckField, FormGrid, TextField } from '@core/components/FormFields';
import { useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { HH, zahlLesen, zahlText, type Cfg } from './typen';

/**
 * Kapitel „Haushaltsplan“ der Einstellungen (Administration → Einstellungen → TC Oberthal): Toleranzen des Soll-Ist-
 * Vergleichs, Mindestreserve, Ausreißerschwelle, Grundlage ab Jahr, Vorgabe der Preissteigerung, Schritt „genehmigt“.
 */
export function HaushaltKapitel() {
  type Form = Record<'toleranz_gelb' | 'toleranz_rot' | 'mindestreserve' | 'ausreisser_prozent' | 'grundlage_ab' | 'preissteigerung', string> & { genehmigung_mv: boolean };
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ueberwachung = useFunktion()('tco.haushalt.ueberwachung');
  useEffect(() => {
    api.get<Cfg>(`${HH}/einstellungen`).then((c) => setF({
      toleranz_gelb: zahlText(c.toleranz_gelb), toleranz_rot: zahlText(c.toleranz_rot), mindestreserve: zahlText(c.mindestreserve),
      ausreisser_prozent: zahlText(c.ausreisser_prozent), grundlage_ab: c.grundlage_ab ? String(c.grundlage_ab) : '', preissteigerung: zahlText(c.preissteigerung),
      genehmigung_mv: c.genehmigung_mv,
    })).catch((e) => setError((e as Error).message));
  }, []);
  const s = (k: keyof Form) => (x: string) => f && setF({ ...f, [k]: x });
  async function sichern() {
    if (!f) return;
    setError(null);
    try {
      await api.put(`${HH}/einstellungen`, {
        toleranz_gelb: zahlLesen(f.toleranz_gelb) ?? 0, toleranz_rot: zahlLesen(f.toleranz_rot) ?? 0, mindestreserve: f.mindestreserve,
        ausreisser_prozent: zahlLesen(f.ausreisser_prozent) ?? 0, grundlage_ab: f.grundlage_ab.trim(), preissteigerung: zahlLesen(f.preissteigerung) ?? 0,
        genehmigung_mv: f.genehmigung_mv,
      });
      toast('Einstellungen gesichert');
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <div style={{ maxWidth: '48rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Der Haushaltsplan zeigt Abweichungen nur an{ueberwachung ? ' (App, Arbeitsvorrat des Kassenwarts, Kennzahl auf der Startseite)' : ' (die Überwachung im Arbeitsvorrat ist abgeschaltet)'} –
        in die Buchung greift er nicht ein. Die Toleranzen gelten für alle Pläne sofort.
      </MessageStrip>
      {f && (
        <FormGrid>
          <TextField label="Toleranz „beobachten“ ab (%)" required value={f.toleranz_gelb} onChange={s('toleranz_gelb')} />
          <TextField label="Toleranz „überschritten“ ab (%)" required value={f.toleranz_rot} onChange={s('toleranz_rot')} />
          <TextField label="Mindestreserve in € (leer = Geldbestand wird nicht bewertet)" value={f.mindestreserve} onChange={s('mindestreserve')} placeholder="z. B. 20.000" />
          <TextField label="Ausreißer: Abweichung vom Median ab (%)" required value={f.ausreisser_prozent} onChange={s('ausreisser_prozent')} />
          <TextField label="Grundlage ab Jahr (leer = alle Jahre, höchstens die letzten 6)" value={f.grundlage_ab} onChange={s('grundlage_ab')} placeholder="z. B. 2021" />
          <TextField label="Preissteigerung auf Ausgaben für neue Pläne (%)" required value={f.preissteigerung} onChange={s('preissteigerung')} />
          <CheckField label="Schritt „von der Mitgliederversammlung genehmigt“ anbieten" checked={f.genehmigung_mv} onChange={(v) => setF({ ...f, genehmigung_mv: v })} />
        </FormGrid>
      )}
      <FussLeiste style={{ marginTop: '1rem' }} endContent={<Button design="Emphasized" icon="save" disabled={!f} onClick={sichern}>Sichern</Button>} />
    </div>
  );
}
