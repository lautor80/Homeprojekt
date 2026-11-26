import type { BelegErkennung, BelegLayout } from './typen.js';

/** Platzhalter – wird durch die Erkennung ersetzt. */
export function belegErkennen(_text: string, _aktiv: BelegLayout[] = ['bestellung', 'ladeauftrag', 'allgemein']): BelegErkennung {
  throw new Error('nicht umgesetzt');
}
