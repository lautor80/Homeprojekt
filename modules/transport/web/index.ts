import type { WebModule } from '@core/platform';
import { AuftraegeListe } from './AuftraegeListe';
import { AuftragDetail } from './AuftragDetail';
import { Stammdaten } from './Stammdaten';

/** Transportmodul (Euroflex Auftragsverwaltung) */
const mod: WebModule = {
  id: 'transport',
  name: 'Transport',
  nav: [
    {
      text: 'Euroflex',
      children: [
        { text: 'Aufträge', icon: 'shipping-status', path: '/transport/auftraege', permission: 'transport.auftraege:display' },
        { text: 'Stammdaten', icon: 'database', path: '/transport/stammdaten', permission: 'transport.stammdaten:edit' },
      ],
    },
  ],
  routes: [
    { path: '/transport/auftraege', component: AuftraegeListe, permission: 'transport.auftraege:display' },
    { path: '/transport/auftraege/neu/:typ', component: AuftragDetail, permission: 'transport.auftraege:edit' },
    { path: '/transport/auftraege/:nr', component: AuftragDetail, permission: 'transport.auftraege:display' },
    { path: '/transport/stammdaten', component: Stammdaten, permission: 'transport.stammdaten:edit' },
  ],
  tiles: [
    { text: 'Auftragsverwaltung', subtitle: 'Fracht- und Holzträgeraufträge', icon: 'shipping-status', path: '/transport/auftraege', permission: 'transport.auftraege:display' },
    { text: 'Stammdaten', subtitle: 'Firma, Produkte, Wertelisten, Texte', icon: 'database', path: '/transport/stammdaten', permission: 'transport.stammdaten:edit' },
  ],
};

export default mod;
