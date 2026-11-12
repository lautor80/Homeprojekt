/**
 * Hallenschlüssel (#11): Die Halle ist grundsätzlich verschlossen. Wer am Buchungstag keinen ausgegebenen Hallenschlüssel hat
 * (tco.schluessel: Ausgabe am/vor dem Tag, nicht zurückgenommen), bekommt den Hinweis, den Hallenwart zum Aufsperren anzurufen;
 * der Hallenwart sieht diese Buchungen im Arbeitsvorrat.
 */
import type { Db } from '../verein.js';

export const HALLENWART = { name: 'Ben Hartyniuk', telefon: '+49 1512 1594305' };
export const HALLE_HINWEIS = `Die Halle ist grundsätzlich verschlossen. Bitte vor deinem Termin ${HALLENWART.name} (${HALLENWART.telefon}) anrufen, damit die Halle aufgesperrt wird.`;

/** Adressnummer zu einem Portal-Benutzer: Mitglied, sonst EP3-Kunde (99…) */
export const ADRNR_ZU_BENUTZER = (spalte: string) => `coalesce(
  (select a.adrnr from tco.mitgliedera a where a.benutzer_id = ${spalte} limit 1),
  (select '99' || lpad((k.zuid::bigint)::text, 8, '0') from tco.kunden k where k.benutzer_id = ${spalte} and k.zuid ~ '^[0-9]+$' order by k.zalias limit 1))`;

/** Hallenschlüssel am Tag ausgegeben (und nicht zurückgenommen)? */
export async function hatSchluessel(db: Db, adrnr: string | null | undefined, datum: string): Promise<boolean> {
  if (!adrnr) return false;
  const [r] = await db`select 1 from tco.schluessel where adrnr = ${adrnr} and ausgabe is not null and ausgabe <= ${datum}::date
                         and (ruecknahme is null or ruecknahme > ${datum}::date)`;
  return !!r;
}
