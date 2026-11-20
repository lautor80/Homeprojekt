import type { TileKpi, WebModule } from '@core/platform';
import { api } from '@core/api';
import type { Auswertung } from '../server/typen';
import { Importe } from './Importe';
import { Pruefregeln } from './Pruefregeln';
import { Zeitenkontrolle } from './Zeitenkontrolle';

/** Kachel-Kennzahl: vollständig gebuchte Personen im aktuellen Zeitraum */
async function kpiVollstaendig(): Promise<TileKpi> {
  const a = await api.get<Auswertung>('/api/m/wca/auswertung');
  const ps = a.personen.filter((p) => !p.ausgeblendet && p.aktiv);
  const ok = ps.filter((p) => p.vollstaendig).length;
  return { value: `${ok} / ${ps.length}`, label: `vollständig · ${a.zeitraum.text}`, state: ok === ps.length ? 'Positive' : 'Critical' };
}

/** WCA Zeitenkontrolle: Tempo-Zeitexporte importieren und Zeitbuchungen eines Teams prüfen */
const mod: WebModule = {
  id: 'wca',
  name: 'WCA Zeitenkontrolle',
  icon: 'time-entry-request',
  nav: [
    {
      text: 'WCA Zeitenkontrolle',
      children: [
        { text: 'Zeitenkontrolle', icon: 'time-entry-request', path: '/wca', permission: 'wca.auswertung:display' },
        { text: 'Importe', icon: 'upload', path: '/wca/importe', permission: 'wca.import:display' },
        { text: 'Prüfregeln', icon: 'action-settings', path: '/wca/einstellungen', permission: 'wca.einstellungen:display' },
      ],
    },
  ],
  routes: [
    { path: '/wca', component: Zeitenkontrolle, permission: 'wca.auswertung:display' },
    { path: '/wca/importe', component: Importe, permission: 'wca.import:display' },
    { path: '/wca/einstellungen', component: Pruefregeln, permission: 'wca.einstellungen:display' },
  ],
  tiles: [
    { text: 'Zeitenkontrolle', subtitle: 'Tempo-Zeitbuchungen des Teams prüfen', icon: 'time-entry-request', path: '/wca', permission: 'wca.auswertung:display', kpi: kpiVollstaendig },
    { text: 'WCA Importe', subtitle: 'Importierte Tempo-Zeitexporte', icon: 'upload', path: '/wca/importe', permission: 'wca.import:display' },
    { text: 'WCA Prüfregeln', subtitle: 'Schwellen, Wortlisten, Vorgaben je Person', icon: 'action-settings', path: '/wca/einstellungen', permission: 'wca.einstellungen:display' },
  ],
};

export default mod;
