import { useState } from 'react';
import { Button, DatePicker, Dialog, Label, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { TCO, dat } from '../util';

/**
 * „Hat angefangen“ am Schnuppertraining: ja (optional mit Datum) / nein / offen. In jedem Status pflegbar –
 * auch später am Mitglied (Mitgliederdetail) und bei erledigten Anmeldungen (Schnupperverwaltung).
 */
export type AngefangenWahl = 'offen' | 'ja' | 'nein';
export const ANGEFANGEN_WAHL: Record<AngefangenWahl, string> = { offen: 'offen', ja: 'ja', nein: 'nein' };
export const angefangenWahl = (a: boolean | null | undefined): AngefangenWahl => (a === true ? 'ja' : a === false ? 'nein' : 'offen');
export const angefangenWert = (w: AngefangenWahl): boolean | null => (w === 'ja' ? true : w === 'nein' ? false : null);
export const angefangenText = (a: boolean | null | undefined, am: string | null | undefined) =>
  (a === true ? `ja${am ? ` (seit ${dat(am)})` : ''}` : a === false ? 'nein' : 'offen');

export function AngefangenDialog({ adrnr, titel, angefangen, angefangen_am, onClose, onDone }: {
  adrnr: string; titel: string; angefangen: boolean | null | undefined; angefangen_am: string | null | undefined;
  onClose: () => void; onDone: (text: string) => void;
}) {
  const [wahl, setWahl] = useState<AngefangenWahl>(angefangenWahl(angefangen));
  const [am, setAm] = useState(angefangen_am ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function sichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ text: string }>(`${TCO}/schnuppertraining/${adrnr}/angefangen`, { angefangen: angefangenWert(wahl), angefangen_am: wahl === 'ja' ? am || null : null });
      onDone(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={titel} style={{ width: 'min(26rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<>
              <Button design="Emphasized" icon="save" loading={busy} onClick={sichern}>Sichern</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon>Hat angefangen</Label>
        <Select onChange={(e) => setWahl(((e.detail.selectedOption as HTMLElement).dataset.w ?? 'offen') as AngefangenWahl)}>
          {(Object.keys(ANGEFANGEN_WAHL) as AngefangenWahl[]).map((w) => <Option key={w} data-w={w} selected={wahl === w}>{ANGEFANGEN_WAHL[w]}</Option>)}
        </Select>
        {wahl === 'ja' && <>
          <Label showColon>Angefangen am</Label>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={am} onChange={(e) => setAm(e.detail.value)} />
        </>}
        <Text className="portal-muted portal-small">Hält fest, ob die Person nach dem Schnuppern im Verein angefangen hat. Das Datum ist freiwillig.</Text>
      </div>
    </Dialog>
  );
}
