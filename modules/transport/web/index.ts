import type { WebModule } from '@core/platform';
import { AuftraegeListe } from './AuftraegeListe';
import { AuftragDetail } from './AuftragDetail';
import { FirmaLogo, FirmaTab, MailtexteTab, Stammdaten } from './Stammdaten';
import { Datenimport } from './Datenimport';
import { Kontakte } from './Kontakte';

/** Transportmodul (Euroflex Auftragsverwaltung) */
const mod: WebModule = {
  id: 'transport',
  name: 'Euroflex',
  icon: 'shipping-status',
  nav: [
    {
      text: 'Euroflex',
      children: [
        { text: 'Aufträge', icon: 'shipping-status', path: '/transport/auftraege', permission: 'transport.auftraege:display' },
        { text: 'Kontakte', icon: 'contacts', path: '/transport/kontakte', permission: 'transport.kontakte:display' },
        // fachliche Listen heißen „Stammdaten“ nur noch als Begriff (#232, E5/N7): Firma, Bank und Texte stehen in den Einstellungen
        { text: 'Produkte und Wertelisten', icon: 'database', path: '/transport/stammdaten', permission: 'transport.stammdaten:edit' },
      ],
    },
  ],
  // Kapitel „Euroflex“ der App Einstellungen (Administration → Einstellungen, #232 E1)
  // Abschnitte in der App Schnittstellen (Administration → Schnittstellen, #232 S1/S4)
  schnittstellen: [
    { reiter: 'SAP', id: 'sap', text: 'Datenimport aus SAP', permission: 'transport.import:execute', component: Datenimport },
  ],
  logos: [{ id: 'ausdrucke', text: 'Ausdrucke (Seitenverhältnis ca. 6:1)', permission: 'transport.stammdaten:edit', component: FirmaLogo }],
  einstellungen: [
    { id: 'firma', text: 'Firma und Bank', icon: 'building', permission: 'transport.stammdaten:edit', component: FirmaTab },
    { id: 'mailtexte', text: 'E-Mail-Texte', icon: 'email', permission: 'transport.stammdaten:edit', component: MailtexteTab },
  ],
  routes: [
    { path: '/transport/auftraege', component: AuftraegeListe, permission: 'transport.auftraege:display' },
    { path: '/transport/auftraege/neu/:typ', component: AuftragDetail, permission: 'transport.auftraege:edit' },
    { path: '/transport/auftraege/:nr', component: AuftragDetail, permission: 'transport.auftraege:display' },
    { path: '/transport/stammdaten', component: Stammdaten, permission: 'transport.stammdaten:edit' },
    { path: '/transport/kontakte', component: Kontakte, permission: 'transport.kontakte:display' },
  ],
  tiles: [
    { text: 'Auftragsverwaltung', subtitle: 'Fracht- und Holzträgeraufträge', icon: 'shipping-status', path: '/transport/auftraege', permission: 'transport.auftraege:display' },
    { text: 'Kontakte', subtitle: 'Kunden, Unternehmer, Rechnungsempfänger', icon: 'contacts', path: '/transport/kontakte', permission: 'transport.kontakte:display' },
    { text: 'Produkte und Wertelisten', subtitle: 'Produkte, Fahrzeugtypen, Ladegut, Ladeweisen', icon: 'database', path: '/transport/stammdaten', permission: 'transport.stammdaten:edit' },
  ],
};

export default mod;
