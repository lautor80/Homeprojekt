import { useEffect, useState } from 'react';
import {
  Bar, BusyIndicator, Button, ComboBox, ComboBoxItem, DatePicker, Dialog, Label, MessageStrip, ObjectStatus, Text,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { toast } from '@core/toast';
import { dat } from '../util';
import { DASH, type Detail } from './typen';
import { AuswahlBox } from '@core/components/AuswahlBox';

interface Props {
  kpiKey: string;
  jahr: number;
  edit: boolean;
  /** schließen; `geaendert` = Verträge wurden umgestellt, Kennzahlen neu laden */
  onClose: (geaendert: boolean) => void;
}

/**
 * Detail-Popup einer Kennzahl (Port von render_detail_popup): Tabelle mit Statusfarbe je Zeile,
 * beim Beitragsstufenwechsel zusätzlich Stichtag, Auswahl der neuen Beitragsstufe je Zeile und „Ausgewählte wechseln“.
 */
export function DetailDialog({ kpiKey, jahr, edit, onClose }: Props) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stichtag, setStichtag] = useState('');
  const [sel, setSel] = useState<Record<string, string>>({});
  const [frage, setFrage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [geaendert, setGeaendert] = useState(false);

  const laden = () => api.get<Detail>(`${DASH}/detail/${kpiKey}?jahr=${jahr}`)
    .then((x) => { setD(x); if (!stichtag && x.stichtag) setStichtag(x.stichtag); })
    .catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [kpiKey, jahr]); // eslint-disable-line react-hooks/exhaustive-deps

  const bsw = !!d && d.mode === 'BSW' && d.zeilen.length > 0;
  const gewaehlt = d?.zeilen.filter((z) => sel[`${z.adrnr}|${z.vertragnr}`]) ?? [];

  async function wechseln() {
    setFrage(false);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stichtag)) { setError('Bitte einen gültigen Stichtag angeben.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ ok: number; fehler: string[]; text: string }>(`${DASH}/beitragswechsel`, {
        stichtag, zeilen: gewaehlt.map((z) => ({ adrnr: z.adrnr, vertragnr: z.vertragnr, art: sel[`${z.adrnr}|${z.vertragnr}`], name: z.cols[0] })),
      });
      if (r.ok > 0) setGeaendert(true);
      if (r.fehler.length) setError(r.text); else toast(r.text, 6000);
      setSel({});
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const ab = /^\d{4}-\d{2}-\d{2}$/.test(stichtag) ? new Date(`${stichtag}T12:00:00Z`) : null;
  if (ab) ab.setUTCDate(ab.getUTCDate() + 1);

  return (
    <Dialog open headerText={d?.title ?? 'Details'} onClose={() => onClose(geaendert)} resizable style={{ width: 'min(60rem, 95vw)' }}
            footer={<Bar endContent={<>
              {bsw && edit && <Button design="Positive" icon="accept" disabled={!gewaehlt.length || busy} onClick={() => setFrage(true)}>Ausgewählte wechseln</Button>}
              <Button design="Emphasized" onClick={() => onClose(geaendert)}>Schließen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {!d && !error && <BusyIndicator active style={{ display: "block", width: "100%" }} />}
      {d && (
        <div className="portal-stack" style={{ gap: '0.75rem' }}>
          {d.info && <MessageStrip design="Information" hideCloseButton>{d.info}</MessageStrip>}
          {bsw && (
            <div className="portal-row">
              <Label>Jugendvertrag beenden zum (neuer Vertrag ab Folgetag):</Label>
              <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={stichtag} style={{ width: '10rem' }} onChange={(e) => setStichtag(e.detail.value)} />
              {!edit && <Text className="portal-muted">Zum Umstellen fehlt die Berechtigung „tco.dashboard:edit“.</Text>}
            </div>
          )}
          {d.zeilen.length > 0 && (
            <table className="portal-dash__table">
              <thead>
                <tr>
                  {d.head.map((h, i) => <th key={i} style={{ textAlign: i <= 1 ? 'left' : 'right' }}>{h}</th>)}
                  {bsw && <th style={{ textAlign: 'left', width: '18rem' }}>Neue Beitragsstufe</th>}
                </tr>
              </thead>
              <tbody>
                {d.zeilen.map((z, zi) => {
                  const k = `${z.adrnr}|${z.vertragnr}`;
                  return (
                    <tr key={zi} className={`portal-dash__row portal-dash__row--${z.state}`}>
                      {z.cols.map((c, ci) => (
                        <td key={ci} style={{ textAlign: ci <= 1 ? 'left' : 'right' }}>
                          {ci === z.cols.length - 1 ? <ObjectStatus state={z.state}>{c}</ObjectStatus> : c}
                        </td>
                      ))}
                      {bsw && (
                        <td>
                          <AuswahlBox wert={sel[k]} placeholder="Beitragsstufe wählen" style={{ width: '100%' }} disabled={!edit}
                                      eintraege={(d.stufen ?? []).map((s) => ({ key: s.key, text: s.text }))} onWaehle={(x) => setSel({ ...sel, [k]: x ?? '' })} />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      <ConfirmDialog open={frage} title="Beitragsstufenwechsel" confirmText="Wechseln"
                     text={`${gewaehlt.length} Jugendvertrag/-verträge zum ${dat(stichtag)} beenden und neue Verträge ab ${ab ? dat(ab.toISOString().slice(0, 10)) : '…'} anlegen?`}
                     onConfirm={wechseln} onCancel={() => setFrage(false)} />
    </Dialog>
  );
}
