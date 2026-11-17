/**
 * Vorschläge beim Erfassen der Stops: bekannte Lade-/Entladestellen und Zeitvorgaben aus früheren Aufträgen
 * (GET /stops/vorschlaege, Recht transport.vorschlaege:display). Reine Funktionen ohne React –
 * getestet in server/test/transport_stop_vorschlaege.test.ts.
 */

export interface Ort { firma: string; strasse: string | null; land: string | null; plzort: string | null; anzahl: number }
export interface Vorschlaege { orte: Ort[]; zeiten: string[] }

/** Vergleichsform: klein, ohne Akzente, ß → ss, Satzzeichen und Leerraum vereinheitlicht */
export function normal(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/[.,;:/\\\-_()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Mindestlänge, ab der Firma, Straße und PLZ/Ort Vorschläge zeigen */
export const MIN_ZEICHEN = 2;

/** Treffer, die mit der Eingabe (bzw. einem Wort) beginnen, vor Treffern mitten im Text; sonst Reihenfolge der Liste (jüngste zuerst) */
function rang(text: string, q: string): number {
  const t = normal(text);
  if (t.startsWith(q)) return 0;
  if (t.split(' ').some((w) => w.startsWith(q))) return 1;
  return t.includes(q) ? 2 : -1;
}

function sortiert<T>(liste: T[], text: (x: T) => string, eingabe: string, max: number): T[] {
  const q = normal(eingabe);
  if (q.length < MIN_ZEICHEN) return [];
  return liste
    .map((x, i) => ({ x, i, r: rang(text(x), q) }))
    .filter((y) => y.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, max)
    .map((y) => y.x);
}

/** Zusatz zum Vorschlag: „Edmund Meiser Straße 1 · DE 66839 Schmelz“ */
export function anschrift(o: Pick<Ort, 'strasse' | 'land' | 'plzort'>): string {
  return [o.strasse, [o.land, o.plzort].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

/** Firma: ganze Anschriften, auch über Straße und Ort auffindbar */
export function firmenTreffer(v: Vorschlaege | null, eingabe: string, max = 12): Ort[] {
  if (!v) return [];
  const q = normal(eingabe);
  if (q.length < MIN_ZEICHEN) return [];
  const nachFirma = sortiert(v.orte, (o) => o.firma, eingabe, max);
  if (nachFirma.length >= max) return nachFirma;
  const rest = v.orte.filter((o) => !nachFirma.includes(o) && normal(anschrift(o)).includes(q));
  return [...nachFirma, ...rest].slice(0, max);
}

/** Straße: eindeutige Straßen (mit ihrem Ort); passt PLZ/Ort schon, diese zuerst */
export function strassenTreffer(v: Vorschlaege | null, eingabe: string, plzort: string | null | undefined, max = 12) {
  if (!v) return [];
  const gesehen = new Set<string>();
  const eindeutig: { strasse: string; land: string | null; plzort: string | null }[] = [];
  for (const o of v.orte) {
    if (!o.strasse) continue;
    const k = `${normal(o.strasse)}|${normal(o.plzort)}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    eindeutig.push({ strasse: o.strasse, land: o.land, plzort: o.plzort });
  }
  const ort = normal(plzort);
  if (!ort) return sortiert(eindeutig, (x) => x.strasse, eingabe, max);
  const hier = sortiert(eindeutig.filter((x) => normal(x.plzort) === ort), (x) => x.strasse, eingabe, max);
  return [...hier, ...sortiert(eindeutig.filter((x) => normal(x.plzort) !== ort), (x) => x.strasse, eingabe, max)].slice(0, max);
}

/** PLZ/Ort: eindeutige Orte mit Land, über PLZ oder Ortsnamen */
export function ortTreffer(v: Vorschlaege | null, eingabe: string, max = 12) {
  if (!v) return [];
  const gesehen = new Set<string>();
  const eindeutig: { land: string | null; plzort: string }[] = [];
  for (const o of v.orte) {
    if (!o.plzort) continue;
    const k = `${o.land ?? ''}|${normal(o.plzort)}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    eindeutig.push({ land: o.land, plzort: o.plzort });
  }
  return sortiert(eindeutig, (x) => x.plzort, eingabe, max);
}

/** Zeitvorgabe: häufigste Angaben; ohne Eingabe die häufigsten überhaupt */
export function zeitTreffer(v: Vorschlaege | null, eingabe: string, max = 10): string[] {
  if (!v) return [];
  const q = normal(eingabe);
  if (!q) return v.zeiten.slice(0, max);
  return v.zeiten.filter((z) => normal(z).includes(q) && normal(z) !== q).slice(0, max);
}
