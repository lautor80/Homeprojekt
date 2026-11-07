import type { WebModule } from '@core/platform';
import { Hallenabrechnung } from './Hallenabrechnung';
import { Hallenpreise } from './Hallenpreise';
import { TcoStammdaten } from './Stammdaten';

/** TC Oberthal – Vereinsportal (Port der abap2UI5-Apps) */
const mod: WebModule = {
  id: 'tco',
  name: 'TC Oberthal',
  nav: [
    {
      text: 'Abrechnungen',
      children: [
        { text: 'Hallenabrechnung', icon: 'sales-order', path: '/tco/halle', permission: 'tco.halle:display' },
        { text: 'Hallenpreise', icon: 'lead', path: '/tco/hallenpreise', permission: 'tco.halle:display' },
      ],
    },
    {
      text: 'Verein',
      children: [
        { text: 'Stammdaten', icon: 'database', path: '/tco/stammdaten', permission: 'tco.stammdaten:edit' },
      ],
    },
  ],
  routes: [
    { path: '/tco/halle', component: Hallenabrechnung, permission: 'tco.halle:display' },
    { path: '/tco/hallenpreise', component: Hallenpreise, permission: 'tco.halle:display' },
    { path: '/tco/stammdaten', component: TcoStammdaten, permission: 'tco.stammdaten:edit' },
  ],
  tiles: [
    { text: 'Hallenabrechnung', subtitle: 'EP3-Buchungen abrechnen', icon: 'sales-order', path: '/tco/halle', permission: 'tco.halle:display' },
    { text: 'Hallenpreise', subtitle: 'Produkte und Preismatrix', icon: 'lead', path: '/tco/hallenpreise', permission: 'tco.halle:display' },
    { text: 'Stammdaten', subtitle: 'Verein, Anbindungen, SAP-Übernahme', icon: 'database', path: '/tco/stammdaten', permission: 'tco.stammdaten:edit' },
  ],
};

export default mod;
