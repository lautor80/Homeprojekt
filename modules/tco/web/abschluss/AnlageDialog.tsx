import { useEffect, useState } from 'react';
import { Bar, Button, DatePicker, Dialog, Input, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { toast } from '@core/toast';
import { SperrHinweis, useSperre } from '@core/sperre';
import { AB, anlnrText, type Anlage } from './typen';

/** Monatsregel wie ZCL_TCO_ANLAGEN=>MONATE_ERSTJAHR: Anschaffungsmonat bis Dezember */
const monateErstjahr = (datum: string) => (/^\d{4}-\d{2}-\d{2}$/.test(datum) ? 13 - Number(datum.slice(5, 7)) : 12);
const heute = () => new Date().toISOString().slice(0, 10);

interface Form { bezeichnung: string; anschdat: string; anschwert: string; nutzdauer: string; monate_ej: string; notiz: string }

/** Anlageobjekt erfassen / bearbeiten (Formular der SAP-App „Anlagevermögen“) */
export function AnlageDialog({ anlnr, edit: darf, onClose }: { anlnr: number | null; edit: boolean; onClose: (geaendert: boolean) => void }) {
  const [f, setF] = useState<Form>({ bezeichnung: '', anschdat: heute(), anschwert: '', nutzdauer: '10', monate_ej: String(monateErstjahr(heute())), notiz: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [frage, setFrage] = useState(false);
  const sperre = useSperre('ANLAGE', anlnr ? String(anlnr) : null, darf, { bezeichnung: anlnr ? `Anlageobjekt ${anlnrText(anlnr)}` : undefined });
  const edit = darf && sperre.eigen;
  const s = (k: keyof Form) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!anlnr) return;
    api.get<Anlage>(`${AB}/anlagen/${anlnr}`)
      .then((a) => setF({ bezeichnung: a.bezeichnung, anschdat: a.anschdat, anschwert: a.anschwert.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        nutzdauer: String(a.nutzdauer), monate_ej: String(a.monate_ej), notiz: a.notiz ?? '' }))
      .catch((e) => setError(e.message));
  }, [anlnr]);

  async function speichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ anlnr: number; text: string }>(`${AB}/anlagen`, { anlnr, ...f, notiz: f.notiz || null });
      toast(r.text, 5000);
      onClose(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function loeschen(grund: string) {
    setFrage(false); setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${AB}/anlagen/loeschen`, { anlnr, grund });
      toast(r.text, 5000);
      onClose(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText={anlnr ? `Anlageobjekt ${anlnrText(anlnr)} bearbeiten` : 'Neues Anlageobjekt'} onClose={() => onClose(false)}
            style={{ width: 'min(44rem, 95vw)' }}
            footer={<Bar startContent={anlnr ? <ChangeHistoryButton objectType="ANLAGE" objectKey={String(anlnr)} /> : undefined} endContent={<>
              {edit && anlnr && <Button design="Negative" icon="delete" disabled={busy} onClick={() => setFrage(true)}>Löschen</Button>}
              {edit && <Button design="Emphasized" icon="save" disabled={busy} onClick={speichern}>Speichern</Button>}
              <Button onClick={() => onClose(false)}>{edit ? 'Abbrechen' : 'Schließen'}</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <SperrHinweis s={sperre} />
      <FormGrid>
        <TextField label="Bezeichnung" required value={f.bezeichnung} onChange={s('bezeichnung')} readonly={!edit} wide />
        <FieldBox label="Anschaffungsdatum" required>
          <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.anschdat} readonly={!edit}
                      onChange={(e) => { const d = e.detail.value; setF((x) => ({ ...x, anschdat: d, monate_ej: d ? String(monateErstjahr(d)) : x.monate_ej })); }} />
        </FieldBox>
        <TextField label="Anschaffungswert netto (EUR)" required value={f.anschwert} onChange={s('anschwert')} readonly={!edit} />
        <TextField label="Nutzungsdauer in Jahren" required type="Number" value={f.nutzdauer} onChange={s('nutzdauer')} readonly={!edit} />
        <FieldBox label="AfA-Monate im Anschaffungsjahr">
          <Input style={{ width: '100%' }} type="Number" value={f.monate_ej} readonly={!edit} onInput={(e) => s('monate_ej')(e.target.value)} />
          <Text className="portal-small portal-muted">Vorschlag nach Monatsregel (Anschaffungsmonat bis Dezember). 0 = Abschreibung beginnt im Folgejahr.</Text>
        </FieldBox>
        <TextField label="Notiz" value={f.notiz} onChange={s('notiz')} readonly={!edit} wide />
      </FormGrid>
      <ConfirmDialog open={frage} title="Anlageobjekt löschen" danger askReason confirmText="Löschen"
                     text={`Das Anlageobjekt ${anlnr ? anlnrText(anlnr) : ''} „${f.bezeichnung}“ wird aus dem Anlagenverzeichnis entfernt.`}
                     onCancel={() => setFrage(false)} onConfirm={loeschen} />
    </Dialog>
  );
}
