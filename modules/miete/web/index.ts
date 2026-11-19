import type { WebModule } from '@core/platform';
import { Uebersicht } from './Uebersicht';
import { Einnahmen } from './Einnahmen';
import { LaufendeKosten } from './Kosten';
import { ZaehlerSeite } from './Zaehler';
import { Abrechnung } from './Abrechnung';
import { HausUndMieter } from './HausUndMieter';

/** Vermietung: Mieteinnahmen, laufende Kosten, Zähler und Nebenkostenabrechnung eines Hauses */
const mod: WebModule = {
  id: 'miete',
  name: 'Vermietung',
  icon: 'home',
  nav: [
    {
      text: 'Vermietung',
      children: [
        { text: 'Übersicht', icon: 'bar-chart', path: '/miete/uebersicht', permission: 'miete.uebersicht:display' },
        { text: 'Mieteinnahmen', icon: 'lead', path: '/miete/einnahmen', permission: 'miete.zahlungen:display' },
        { text: 'Laufende Kosten', icon: 'receipt', path: '/miete/kosten', permission: 'miete.kosten:display' },
        { text: 'Zähler', icon: 'measure', path: '/miete/zaehler', permission: 'miete.zaehler:display' },
        { text: 'Nebenkostenabrechnung', icon: 'accounting-document-verification', path: '/miete/abrechnung', permission: 'miete.abrechnung:display' },
        { text: 'Haus und Mieter', icon: 'home', path: '/miete/haus', permission: 'miete.stammdaten:display' },
      ],
    },
  ],
  routes: [
    { path: '/miete/uebersicht', component: Uebersicht, permission: 'miete.uebersicht:display' },
    { path: '/miete/einnahmen', component: Einnahmen, permission: 'miete.zahlungen:display' },
    { path: '/miete/kosten', component: LaufendeKosten, permission: 'miete.kosten:display' },
    { path: '/miete/zaehler', component: ZaehlerSeite, permission: 'miete.zaehler:display' },
    { path: '/miete/abrechnung', component: Abrechnung, permission: 'miete.abrechnung:display' },
    { path: '/miete/haus', component: HausUndMieter, permission: 'miete.stammdaten:display' },
  ],
  tiles: [
    { text: 'Vermietung', subtitle: 'Einnahmen gegen laufende Kosten je Monat', icon: 'bar-chart', path: '/miete/uebersicht', permission: 'miete.uebersicht:display' },
    { text: 'Mieteinnahmen', subtitle: 'Kaltmiete und Nebenkosten-Abschlag', icon: 'lead', path: '/miete/einnahmen', permission: 'miete.zahlungen:display' },
    { text: 'Laufende Kosten', subtitle: 'Rechnungen und Belege (Paperless)', icon: 'receipt', path: '/miete/kosten', permission: 'miete.kosten:display' },
    { text: 'Zähler', subtitle: 'Heizstrom, Hausstrom, Unterzähler', icon: 'measure', path: '/miete/zaehler', permission: 'miete.zaehler:display' },
    { text: 'Nebenkostenabrechnung', subtitle: 'Jährlich je Mietverhältnis', icon: 'accounting-document-verification', path: '/miete/abrechnung', permission: 'miete.abrechnung:display' },
    { text: 'Haus und Mieter', subtitle: 'Wohnungen, Mietverhältnisse, Kostenarten', icon: 'home', path: '/miete/haus', permission: 'miete.stammdaten:display' },
  ],
};

export default mod;
