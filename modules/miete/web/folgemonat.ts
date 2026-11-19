/**
 * Mieteingang in den Folgemonat kopieren: Leistungsmonat +1, Eingangsdatum +1 Monat (am Monatsende gekappt),
 * Betrag, Aufteilung und Notiz übernommen. Weicht der Betrag ab, bleibt die Kaltmiete immer gleich –
 * die Abweichung geht vollständig in den Nebenkosten-Abschlag.
 */

export interface KopierQuelle { vertrag_id: number; datum: string; monat: string; betrag: number; anteil_miete: number; anteil_nk: number; notiz: string | null }

const r2 = (v: number) => Math.round(v * 100) / 100;
const zwei = (n: number) => String(n).padStart(2, '0');

/** Erster des Folgemonats zu einem Datum JJJJ-MM-TT */
export function naechsterMonat(iso: string): string {
  const j = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return m === 12 ? `${j + 1}-01-01` : `${j}-${zwei(m + 1)}-01`;
}

/** Gleicher Tag im Folgemonat; gibt es den Tag nicht (31. → Februar), der letzte Tag des Folgemonats */
export function datumFolgemonat(iso: string): string {
  const n = naechsterMonat(iso);
  const j = +n.slice(0, 4), m = +n.slice(5, 7);
  const letzter = new Date(Date.UTC(j, m, 0)).getUTCDate();
  return `${n.slice(0, 8)}${zwei(Math.min(+iso.slice(8, 10), letzter))}`;
}

/** Aufteilung bei fester Kaltmiete: Abweichungen vom bisherigen Betrag gehen in den Nebenkosten-Abschlag */
export function aufteilungFesteMiete(betrag: number, miete: number): { miete: number; nk: number } {
  return { miete: r2(miete), nk: r2(betrag - miete) };
}

/** Vorbelegung des neuen Eingangs im Folgemonat (ohne id – wird neu angelegt) */
export function folgemonatVorlage(q: KopierQuelle) {
  return {
    vertrag_id: q.vertrag_id, monat: naechsterMonat(q.monat), datum: datumFolgemonat(q.datum),
    betrag: r2(q.betrag), anteil_miete: r2(q.anteil_miete), anteil_nk: r2(q.anteil_nk), notiz: q.notiz,
  };
}
