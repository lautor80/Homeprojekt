import { Button, Icon } from '@ui5/webcomponents-react';
import type { Kpi } from './typen';

/** KPI als Card (sap.f.Card, 19rem): Titel, Untertitel, Wert mit Einheit, Symbol + Zusatztext, Button „Details anzeigen“ (Port von render_card) */
export function KpiCard({ kpi, onDetail }: { kpi: Kpi; onDetail?: () => void }) {
  return (
    <div className="portal-kpicard">
      <h4 className="portal-kpicard__title">{kpi.title}</h4>
      <div className="portal-kpicard__subtitle">{kpi.subtitle}</div>
      <div className="portal-kpicard__number">
        <span className={`portal-kpicard__value portal-kpicard__value--${kpi.state}`}>{kpi.value}{kpi.delta ? ` ${kpi.delta}` : ''}</span>
        {kpi.unit && <span className="portal-muted">{kpi.unit}</span>}
      </div>
      <div className={`portal-kpicard__line${kpi.todo ? ' portal-kpicard__line--todo' : ''}`}>
        {kpi.icon && <Icon name={kpi.icon} />}
        <span>{kpi.details}</span>
      </div>
      {kpi.hasDetail && onDetail && (
        <div className="portal-kpicard__actions">
          <Button design="Transparent" endIcon="slim-arrow-right" onClick={onDetail}>Details anzeigen</Button>
        </div>
      )}
    </div>
  );
}
