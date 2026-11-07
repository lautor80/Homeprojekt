import type { WebModule } from '@core/platform';
import { KontakteList } from './KontakteList';
import { KontaktDetail } from './KontaktDetail';

/** Beispielmodul "Kontakte" – Vorlage für eigene Fachmodule. */
const mod: WebModule = {
  id: 'beispiel',
  name: 'Beispiel',
  nav: [
    {
      text: 'Stammdaten',
      children: [{ text: 'Kontakte', icon: 'contacts', path: '/beispiel/kontakte', permission: 'beispiel.kontakte:display' }],
    },
  ],
  routes: [
    { path: '/beispiel/kontakte', component: KontakteList, permission: 'beispiel.kontakte:display' },
    { path: '/beispiel/kontakte/:id', component: KontaktDetail, permission: 'beispiel.kontakte:display' },
  ],
  tiles: [
    { text: 'Kontakte', subtitle: 'Beispielanwendung', icon: 'contacts', path: '/beispiel/kontakte', permission: 'beispiel.kontakte:display' },
  ],
};

export default mod;
