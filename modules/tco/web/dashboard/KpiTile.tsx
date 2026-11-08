import { Icon } from '@ui5/webcomponents-react';
import type { Kpi } from './typen';

/**
 * KPI-Kachel wie sap.m.GenericTile (TwoByOne) mit NumericContent: Titel/Untertitel oben,
 * Wert groß mit Einheit, Veränderung und Trendpfeil, Fußzeile unten (Port von render_tile).
 */
export function KpiTile({ kpi, onPress }: { kpi: Kpi; onPress?: () => void }) {
  const state = kpi.todo ? 'None' : kpi.state;
  const trend = !kpi.todo && kpi.trend !== 'None' ? kpi.trend : null;
  const press = kpi.hasDetail && onPress ? onPress : undefined;
  const klasse = `portal-kpitile${press ? ' portal-kpitile--press' : ''}${kpi.todo ? ' portal-kpitile--todo' : ''}`;
  const inhalt = (
    <>
      <div>
        <div className="portal-kpitile__title">{kpi.title}</div>
        {kpi.subtitle && <div className="portal-kpitile__subtitle">{kpi.subtitle}</div>}
      </div>
      <div className="portal-kpitile__content">
        <div className="portal-kpitile__number">
          <span className={`portal-kpitile__value portal-kpitile__value--${state}`}>{kpi.value}</span>
          {kpi.delta && <span className="portal-kpitile__scale">{kpi.delta}</span>}
          {trend && <Icon name={trend === 'Up' ? 'trend-up' : 'trend-down'} className={`portal-kpitile__trend portal-kpitile__trend--${state}`} />}
        </div>
        {kpi.icon && <Icon name={kpi.icon} className="portal-kpitile__icon" />}
      </div>
      <div className="portal-kpitile__foot">
        <span className="portal-kpitile__footer" title={kpi.details}>{kpi.todo ? `${kpi.details} (Platzhalter)` : kpi.details}</span>
        {kpi.unit && <span className="portal-kpitile__unit">{kpi.unit}</span>}
      </div>
    </>
  );
  if (press) {
    return <button type="button" className={klasse} onClick={press} aria-label={`${kpi.title}: Details anzeigen`}>{inhalt}</button>;
  }
  return <div className={klasse}>{inhalt}</div>;
}
