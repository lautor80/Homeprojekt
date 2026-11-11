import { useEffect, useState } from 'react';
import { BusyIndicator, MessageStrip, SegmentedButton, SegmentedButtonItem, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { LineChart } from './Chart';
import { DASH } from './typen';

/**
 * Vereinsübersicht (#30): Liniendiagramm der registrierten Portal-Benutzer über die Zeit – Tage (30), Wochen (26),
 * Monate (24), Jahre oder die gesamte Laufzeit; Linien „Benutzer gesamt“ und „davon Mitglieder“.
 */
type Zeitraum = 'TAG' | 'WOCHE' | 'MONAT' | 'JAHR' | 'GESAMT';
const ZEITRAEUME: [Zeitraum, string][] = [['TAG', 'Tage'], ['WOCHE', 'Wochen'], ['MONAT', 'Monate'], ['JAHR', 'Jahre'], ['GESAMT', 'Gesamt']];
interface Punkt { label: string; bis: string; gesamt: number; mitglieder: number; hallennutzer: number; neu: number }
interface Verlauf { zeitraum: Zeitraum; punkte: Punkt[]; gesamt: number; seit: string | null }

const datum = (s: string | null) => (s ? s.split('-').reverse().join('.') : '');
const titel: Record<Zeitraum, string> = {
  TAG: 'Registrierte Benutzer – letzte 30 Tage', WOCHE: 'Registrierte Benutzer – letzte 26 Wochen', MONAT: 'Registrierte Benutzer – letzte 24 Monate',
  JAHR: 'Registrierte Benutzer je Jahr', GESAMT: 'Registrierte Benutzer – gesamte Laufzeit',
};

export function BenutzerVerlauf({ neu }: { neu: number }) {
  const [zeitraum, setZeitraum] = useState<Zeitraum>('MONAT');
  const [d, setD] = useState<Verlauf | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    api.get<Verlauf>(`${DASH}/benutzer?zeitraum=${zeitraum}`).then(setD).catch((e) => setError((e as Error).message));
  }, [zeitraum, neu]);
  const p = d?.punkte ?? [];
  const neuImZeitraum = p.reduce((s, x) => s + x.neu, 0);
  const letzter = p[p.length - 1];
  return (
    <div className="portal-chartbox">
      <div className="portal-chartbox__sel">
        <SegmentedButton accessibleName="Zeitraum" onSelectionChange={(e) => setZeitraum((e.detail.selectedItems[0] as HTMLElement).dataset.z as Zeitraum)}>
          {ZEITRAEUME.map(([k, t]) => <SegmentedButtonItem key={k} data-z={k} selected={zeitraum === k}>{t}</SegmentedButtonItem>)}
        </SegmentedButton>
        {letzter && (
          <Text className="portal-muted">
            {letzter.gesamt} Benutzer · davon {letzter.mitglieder} Mitglieder, {letzter.hallennutzer} Hallennutzer · neu im Zeitraum: {neuImZeitraum}
            {d?.seit ? ` · erster Benutzer am ${datum(d.seit)}` : ''}
          </Text>
        )}
      </div>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {!d && !error && <BusyIndicator active size="S" />}
      {d && (p.length
        ? <LineChart title={titel[d.zeitraum]} name1="Benutzer gesamt" name2="davon Mitglieder" anzahl
                     data={p.map((x) => ({ label: x.label, val1: x.gesamt, val2: x.mitglieder }))} />
        : <Text className="portal-muted">Noch keine Benutzer.</Text>)}
    </div>
  );
}
