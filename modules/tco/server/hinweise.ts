/**
 * Ereignisse des Vereins im Arbeitsvorrat melden (#232, V1) – erscheinen im Block „TC Oberthal“ auf der Startseite
 * und in der Vereinsübersicht, bis jemand mit dem Recht der zugehörigen App „gesehen“ bestätigt.
 * Technik: server/src/lib/hinweise.ts.
 */
import { hinweisMelden, ueberwacht, type HinweisNeu } from '../../../server/src/lib/hinweise.js';
import type { Db } from './verein.js';

export const tcoHinweis = (db: Db, h: Omit<HinweisNeu, 'modul'>): Promise<void> => hinweisMelden(db, { modul: 'tco', ...h });

/**
 * Aufruf einer Anbindung des Vereins überwachen (#232, V1): Scheitert er, steht die Störung unter „Administration“ im
 * Arbeitsvorrat (Absprung zu den Anbindungen); der nächste erfolgreiche Aufruf schließt sie. id = Id der Anbindung.
 * „Nicht eingerichtet“ ist keine Störung – diese Prüfung gehört vor den Aufruf.
 */
export const tcoSchnittstelle = <T>(id: string, name: string, fn: () => Promise<T>): Promise<T> => ueberwacht({
  modul: 'tco', quelle: 'SCHNITTSTELLE', objekt: id, bereich: 'Administration', recht: 'core.settings:edit', art: 'Schnittstelle gestört', titel: name, pfad: '/admin/anbindungen',
}, fn);
