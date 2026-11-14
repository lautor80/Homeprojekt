import type { FunktionDef } from '../../../server/src/funktionsschalter.js';

/** Einzelne abschaltbare Funktionen von Euroflex (#232, F1) – reine Daten ohne weitere Importe */
export const TRANSPORT_FUNKTIONEN: FunktionDef[] = [
  {
    id: 'transport.rechnung.erstellen', app: 'Aufträge', text: 'Rechnungen erstellen',
    beschreibung: 'Aus Aufträgen Rechnungen erstellen.',
    permissions: ['transport.rechnungen:create'],
  },
  {
    id: 'transport.rechnung.entfernen', app: 'Aufträge', text: 'Rechnungen entfernen',
    beschreibung: 'Rechnungen wieder entfernen – die Aufträge sind danach wieder offen.',
    permissions: ['transport.rechnungen:delete'],
  },
  {
    id: 'transport.versand', app: 'Aufträge', text: 'Versand (E-Mail, Paperless)',
    beschreibung: 'Aufträge und Rechnungen per E-Mail versenden und in Paperless ablegen.',
    permissions: ['transport.versand:execute'],
  },
  {
    id: 'transport.import', app: 'Stammdaten', text: 'Datenimport aus SAP',
    beschreibung: 'Reiter „Datenimport“ in den Stammdaten: Kontakte, Produkte und Aufträge als CSV aus SAP einlesen.',
    permissions: ['transport.import:execute'],
  },
];
