/**
 * Kostenerfassung mit Jahreswert: Betrag aus einem Jahreswert errechnen –
 *  - auf den Leistungszeitraum: je volle Monat ein Zwölftel, angebrochene Monate tageweise,
 *  - auf einen Monat: ein Zwölftel, Leistungszeitraum = Kalendermonat.
 */

export type JahreswertModus = 'zeitraum' | 'monat';

const r2 = (v: number) => Math.round(v * 100) / 100;
const zwei = (n: number) => String(n).padStart(2, '0');
const tageImMonat = (j: number, m: number) => new Date(Date.UTC(j, m, 0)).getUTCDate();

/** Anzahl Monate im Zeitraum von–bis (einschließlich): volle Monate zählen 1, angebrochene tageweise; null bei ungültigem Zeitraum */
export function monate(von: string, bis: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(von) || !/^\d{4}-\d{2}-\d{2}$/.test(bis) || bis < von) return null;
  let j = +von.slice(0, 4), m = +von.slice(5, 7);
  const jb = +bis.slice(0, 4), mb = +bis.slice(5, 7);
  let summe = 0;
  while (j < jb || (j === jb && m <= mb)) {
    const t = tageImMonat(j, m);
    const ab = j === +von.slice(0, 4) && m === +von.slice(5, 7) ? +von.slice(8, 10) : 1;
    const bisTag = j === jb && m === mb ? +bis.slice(8, 10) : t;
    summe += (bisTag - ab + 1) / t;
    if (m === 12) { j++; m = 1; } else m++;
  }
  return summe;
}

/** Betrag für den Leistungszeitraum aus einem Jahreswert; null ohne gültigen Zeitraum */
export function jahrAufZeitraum(jahreswert: number, von: string, bis: string): number | null {
  const n = monate(von, bis);
  return n === null ? null : r2(jahreswert / 12 * n);
}

/** Monatsbetrag aus einem Jahreswert */
export const jahrAufMonat = (jahreswert: number) => r2(jahreswert / 12);

/** Kalendermonat, in dem ein Datum liegt */
export function monatZeitraum(datum: string): { von: string; bis: string } {
  const j = +datum.slice(0, 4), m = +datum.slice(5, 7);
  return { von: `${j}-${zwei(m)}-01`, bis: `${j}-${zwei(m)}-${zwei(tageImMonat(j, m))}` };
}
