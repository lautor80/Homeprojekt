import { useEffect, useState } from 'react';
import { Icon } from '@ui5/webcomponents-react';
import type { HomeTile, TileKpi } from '../platform';

/**
 * Kachel der Startseite im Stil des Fiori Launchpad (Horizon):
 * Titel und Untertitel oben, Symbol unten links, optionale Kennzahl unten rechts.
 */
export function Tile({ tile, onOpen }: { tile: HomeTile; onOpen: () => void }) {
  const [kpi, setKpi] = useState<TileKpi | null | undefined>(tile.kpi ? undefined : null);

  useEffect(() => {
    if (!tile.kpi) return;
    let aktiv = true;
    tile.kpi().then((k) => aktiv && setKpi(k)).catch(() => aktiv && setKpi(null));
    return () => { aktiv = false; };
  }, [tile]);

  return (
    <button type="button" className="portal-tile" onClick={onOpen} aria-label={tile.text}>
      <div>
        <div className="portal-tile__title">{tile.text}</div>
        {tile.subtitle && <div className="portal-tile__subtitle">{tile.subtitle}</div>}
      </div>
      <div className="portal-tile__foot">
        <Icon name={tile.icon} className="portal-tile__icon" />
        {kpi === undefined && <div className="portal-tile__kpi"><div className="portal-tile__kpi-skeleton" /></div>}
        {kpi && (
          <div className="portal-tile__kpi">
            <div className={`portal-tile__kpi-value portal-tile__kpi-value--${kpi.state ?? 'None'}`}>{kpi.value}</div>
            {kpi.label && <div className="portal-tile__kpi-label">{kpi.label}</div>}
          </div>
        )}
      </div>
    </button>
  );
}
