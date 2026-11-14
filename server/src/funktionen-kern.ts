import type { FunktionDef } from './funktionsschalter.js';

/** Einzelne abschaltbare Funktionen der Administration (#232, F1) – reine Daten ohne weitere Importe */
export const KERN_FUNKTIONEN: FunktionDef[] = [
  {
    id: 'core.tabellen.aendern', app: 'Tabellenansicht', text: 'Werte ändern',
    beschreibung: 'Einzelne Werte eines Datensatzes direkt in der Tabellenansicht ändern.',
    permissions: ['core.tabellen:edit'],
  },
  {
    id: 'core.tabellen.loeschen', app: 'Tabellenansicht', text: 'Datensätze löschen',
    beschreibung: 'Datensätze in der Tabellenansicht löschen und aus dem Papierkorb wiederherstellen.',
    permissions: ['core.tabellen:delete'],
  },
];
