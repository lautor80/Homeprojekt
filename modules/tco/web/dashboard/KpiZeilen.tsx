import { Icon } from '@ui5/webcomponents-react';
import { Section } from '@core/components/Section';
import type { Kpi } from './typen';

const STATE_KLASSE: Record<Kpi['state'], string> = { Positive: 'Positive', Critical: 'Critical', Negative: 'Negative', None: 'None' };

/**
 * Kennzahlen eines Bereichs zeilenweise – im selben Layout wie der Arbeitsvorrat
 * (Symbol, Titel, Erläuterung, Wert rechts). Kennzahlen mit Detail öffnen per Klick das Detail-Popup.
 */
export function KpiZeilen({ titel, kpis, onDetail, onOeffnen }: { titel: string; kpis: Kpi[]; onDetail: (key: string) => void; onOeffnen?: () => void }) {
  if (!kpis.length) return null;
  return (
    <Section title={titel} flush>
      <div className="portal-av">
        {kpis.map((k) => {
          const klick = k.hasDetail ? () => onDetail(k.key) : onOeffnen;
          const inhalt = (
            <>
              <Icon name={k.icon || 'kpi-managing-my-area'} className="portal-av__icon" />
              <div className="portal-av__inhalt">
                <div className="portal-av__titel">{k.title}</div>
                <div className="portal-av__text">{[k.subtitle, k.details].filter(Boolean).join(' · ')}</div>
              </div>
              <div className={`portal-kz__wert portal-kz__wert--${STATE_KLASSE[k.state]}`}>
                <span className="portal-kz__zahl">{k.value}</span>
                {k.delta && <span className="portal-kz__delta">{k.delta}</span>}
                {k.unit && <span className="portal-kz__einheit">{k.unit}</span>}
              </div>
              {klick ? <Icon name="navigation-right-arrow" className="portal-av__pfeil" /> : <span />}
            </>
          );
          return klick
            ? <button key={k.key} type="button" className={`portal-av__eintrag portal-av__eintrag--kz portal-av__eintrag--${k.todo ? 'Critical' : 'None'}`} onClick={klick}>{inhalt}</button>
            : <div key={k.key} className="portal-av__eintrag portal-av__eintrag--kz portal-av__eintrag--None">{inhalt}</div>;
        })}
      </div>
    </Section>
  );
}
