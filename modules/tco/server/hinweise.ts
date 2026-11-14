/**
 * Ereignisse des Vereins im Arbeitsvorrat melden (#232, V1) – erscheinen im Block „TC Oberthal“ auf der Startseite
 * und in der Vereinsübersicht, bis jemand mit dem Recht der zugehörigen App „gesehen“ bestätigt.
 * Technik: server/src/lib/hinweise.ts.
 */
import { hinweisMelden, type HinweisNeu } from '../../../server/src/lib/hinweise.js';
import type { Db } from './verein.js';

export const tcoHinweis = (db: Db, h: Omit<HinweisNeu, 'modul'>): Promise<void> => hinweisMelden(db, { modul: 'tco', ...h });
