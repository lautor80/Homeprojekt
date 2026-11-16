import { SegmentedButton, SegmentedButtonItem } from '@ui5/webcomponents-react';
import { useSearchParams } from 'react-router-dom';
import { AppPage } from '@core/components/AppPage';
import { useCan } from '@core/session';
import { MeineZeiten } from '../jt/MeineZeiten';
import { MeineProjektzeiten } from './MeineProjektzeiten';

/**
 * Mein Bereich → „Meine Zeiten“: eine App für die eigene Zeiterfassung mit zwei Arten.
 *  - Training (Recht tco.jtmeine:edit, nur für Trainer): unverändert die bisherigen „Meine Trainingszeiten“.
 *  - Projekt (Recht tco.projektzeiten:edit): unbezahlte Arbeitsstunden auf Projekte melden.
 * Wer nur eines der Rechte hat, sieht nur diese Art – ohne Umschalter.
 */
export function MeineZeitenApp() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const training = can('tco.jtmeine:edit'), projekt = can('tco.projektzeiten:edit');
  const art = !training || (projekt && params.get('art') === 'projekt') ? 'projekt' : 'training';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {training && projekt && (
        <div style={{ padding: '0.75rem var(--portal-page-x, 1rem) 0' }}>
          <SegmentedButton onSelectionChange={(e) => setParams({ art: (e.detail.selectedItems[0] as HTMLElement).dataset.art! }, { replace: true })}>
            <SegmentedButtonItem data-art="training" selected={art === 'training'}>Training</SegmentedButtonItem>
            <SegmentedButtonItem data-art="projekt" selected={art === 'projekt'}>Projekt</SegmentedButtonItem>
          </SegmentedButton>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {art === 'training' ? <MeineZeiten /> : (
          <AppPage title="Meine Zeiten" subtitle="Arbeitsstunden auf Projekte melden – unbezahlt, zählen als Eigenleistung des Projekts"><MeineProjektzeiten /></AppPage>
        )}
      </div>
    </div>
  );
}
