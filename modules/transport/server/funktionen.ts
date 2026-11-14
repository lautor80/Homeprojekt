import type { FunktionDef } from '../../../server/src/funktionsschalter.js';

/** Einzelne abschaltbare Funktionen von Euroflex (#232, F1) – reine Daten ohne weitere Importe */
export const TRANSPORT_FUNKTIONEN: FunktionDef[] = [
  {
    id: 'transport.import', app: 'Stammdaten', text: 'Datenimport aus SAP',
    beschreibung: 'Reiter „Datenimport“ in den Stammdaten: Kontakte, Produkte und Aufträge als CSV aus SAP einlesen.',
    permissions: ['transport.import:execute'],
  },
];
