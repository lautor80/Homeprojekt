import type { WebModule } from '@core/platform';
import { Hallenabrechnung } from './Hallenabrechnung';
import { Hallenpreise } from './Hallenpreise';
import { TcoStammdaten } from './Stammdaten';
import { FiBelege } from './fi/FiBelege';
import { Sollstellung } from './soll/Sollstellung';

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
        { text: 'Sollstellung', icon: 'collections-insight', path: '/tco/sollstellung', permission: 'tco.soll:display' },
      ],
    },
    {
      text: 'Finanzen',
      children: [
        { text: 'FI Belege', icon: 'accounting-document-verification', path: '/tco/fi', permission: 'tco.fi:display' },
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
    { path: '/tco/sollstellung', component: Sollstellung, permission: 'tco.soll:display' },
    { path: '/tco/fi', component: FiBelege, permission: 'tco.fi:display' },
    { path: '/tco/stammdaten', component: TcoStammdaten, permission: 'tco.stammdaten:edit' },
  ],
  tiles: [
    { text: 'Hallenabrechnung', subtitle: 'EP3-Buchungen abrechnen', icon: 'sales-order', path: '/tco/halle', permission: 'tco.halle:display' },
    { text: 'Hallenpreise', subtitle: 'Produkte und Preismatrix', icon: 'lead', path: '/tco/hallenpreise', permission: 'tco.halle:display' },
    { text: 'Sollstellung', subtitle: 'Beitragseinzug per SEPA-Lastschrift', icon: 'collections-insight', path: '/tco/sollstellung', permission: 'tco.soll:display' },
    { text: 'FI Belege', subtitle: 'Bankimport, Belege, Storno', icon: 'accounting-document-verification', path: '/tco/fi', permission: 'tco.fi:display' },
    { text: 'Stammdaten', subtitle: 'Verein, Anbindungen, SAP-Übernahme', icon: 'database', path: '/tco/stammdaten', permission: 'tco.stammdaten:edit' },
  ],
};

export default mod;
