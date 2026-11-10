import { SegmentedButton, SegmentedButtonItem } from '@ui5/webcomponents-react';
import type { Kpi } from './typen';

/** Auswahl innerhalb einer Kachel/Card, z. B. Zeitraum der Belegungsquote: Monat / Saison / Jahr (#103) */
export function KpiVarianten({ kpi, onVariante }: { kpi: Kpi; onVariante?: (key: string) => void }) {
  if (!kpi.varianten?.length || !onVariante) return null;
  return (
    // Klicks nicht an eine anklickbare Kachel weiterreichen
    <div className="portal-kpi__varianten" onClick={(e) => e.stopPropagation()}>
      <SegmentedButton accessibleName={`Zeitraum ${kpi.title}`}
                       onSelectionChange={(e) => onVariante((e.detail.selectedItems[0] as HTMLElement).dataset.v!)}>
        {kpi.varianten.map((v) => <SegmentedButtonItem key={v.key} data-v={v.key} selected={v.key === kpi.variante}>{v.text}</SegmentedButtonItem>)}
      </SegmentedButton>
    </div>
  );
}
