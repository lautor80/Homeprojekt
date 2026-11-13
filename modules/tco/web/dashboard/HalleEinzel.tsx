import { useEffect, useState } from 'react';
import { BusyIndicator, Label, MessageStrip, Option, SegmentedButton, SegmentedButtonItem, Select, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { BarChart } from './Chart';
import { DASH, std } from './typen';

/**
 * Vereinsübersicht, Bereich Halle: Einzelbuchungen als Balkendiagramm. Das Jahr wird in der Auswahlliste gewählt, der Umschalter
 * summiert auf Tag, Woche, Monat oder Jahr (Jahr: alle Jahre nebeneinander, das gewählte betont).
 */
type Raster = 'TAG' | 'WOCHE' | 'MONAT' | 'JAHR';
const RASTER: [Raster, string][] = [['TAG', 'Tag'], ['WOCHE', 'Woche'], ['MONAT', 'Monat'], ['JAHR', 'Jahr']];
interface Punkt { key: string; label: string; titel: string; anzahl: number; stunden: number; zukunft: boolean }
interface Daten { raster: Raster; jahr: number; jahre: number[]; punkte: Punkt[]; summe: { anzahl: number; stunden: number; zukunft: number }; max: { titel: string; anzahl: number } | null }
const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

export function HalleEinzel({ neu, jahr: gj }: { neu: number; jahr: number }) {
  const [raster, setRaster] = useState<Raster>('TAG');
  const [jahr, setJahr] = useState<number>(gj);
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  // das Geschäftsjahr der Übersicht ist die Vorbelegung und zieht bei einem Wechsel mit
  useEffect(() => { setJahr(gj); }, [gj]);
  useEffect(() => {
    setError(null);
    api.get<Daten>(`${DASH}/halle-einzel?raster=${raster}&jahr=${jahr}`).then(setD).catch((e) => setError((e as Error).message));
  }, [raster, jahr, neu]);
  const p = d?.punkte ?? [];
  const je = raster === 'TAG' ? 'je Tag' : raster === 'WOCHE' ? 'je Woche' : raster === 'MONAT' ? 'je Monat' : 'je Jahr';
  return (
    <div className="portal-chartbox">
      <div className="portal-chartbox__sel">
        <Label showColon>Jahr</Label>
        <Select style={{ width: '7.5rem' }} accessibleName="Jahr der Einzelbuchungen" onChange={(e) => setJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
          {(d?.jahre ?? [jahr]).map((j) => <Option key={j} data-j={j} selected={j === (d?.jahr ?? jahr)}>{String(j)}</Option>)}
        </Select>
        <SegmentedButton accessibleName="Summierung" onSelectionChange={(e) => setRaster((e.detail.selectedItems[0] as HTMLElement).dataset.r as Raster)}>
          {RASTER.map(([k, t]) => <SegmentedButtonItem key={k} data-r={k} selected={raster === k}>{t}</SegmentedButtonItem>)}
        </SegmentedButton>
        {d && (
          <Text className="portal-muted">
            {d.summe.anzahl.toLocaleString('de-DE')} Einzelbuchungen · {std(d.summe.stunden)} Std
            {d.summe.zukunft ? ` · davon ${d.summe.zukunft.toLocaleString('de-DE')} noch nicht gespielt` : ''}
            {d.max && d.max.anzahl > 0 ? ` · Höchstwert ${d.max.anzahl.toLocaleString('de-DE')} (${d.max.titel})` : ''}
          </Text>
        )}
      </div>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {!d && !error && <BusyIndicator active size="S" />}
      {d && (d.summe.anzahl
        ? <BarChart title={d.raster === 'JAHR' ? 'Einzelbuchungen der Halle je Jahr' : `Einzelbuchungen der Halle ${d.jahr} ${je}`} name="Einzelbuchungen"
                    achse={d.raster === 'TAG' ? (b) => (b.key.endsWith('-01') ? MONATE[Number(b.key.slice(5, 7)) - 1] : null) : undefined}
                    data={p.map((x) => ({ key: x.key, label: x.label, titel: x.titel, wert: x.anzahl, zusatz: `${std(x.stunden)} Std`, blass: x.zukunft, hervor: d.raster === 'JAHR' && x.key === String(d.jahr) }))} />
        : <Text className="portal-muted">Keine Einzelbuchungen {d.raster === 'JAHR' ? '' : `im Jahr ${d.jahr}`}.</Text>)}
    </div>
  );
}
