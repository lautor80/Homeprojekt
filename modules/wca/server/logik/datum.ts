/**
 * WCA Zeitenkontrolle – Datums- und Zahlhilfen (rein, ISO-Zeichenketten JJJJ-MM-TT, Rechnung in UTC).
 * Wochentage: 0 = Mo … 6 = So.
 */

export const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const OFFEN = '9999-12-31';

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function iso(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

export function isoAus(j: number, m: number, t: number): string {
  return iso(new Date(Date.UTC(j, m - 1, t)));
}

export function gueltigesDatum(j: number, m: number, t: number): string | null {
  if (m < 1 || m > 12 || t < 1 || t > 31 || j < 1900 || j > 2999) return null;
  const s = isoAus(j, m, t);
  return Number(s.slice(8, 10)) === t ? s : null;
}

export function plusTage(tag: string, n: number): string {
  const x = d(tag);
  x.setUTCDate(x.getUTCDate() + n);
  return iso(x);
}

/** 0 = Mo … 6 = So */
export function wochentag(tag: string): number {
  return (d(tag).getUTCDay() + 6) % 7;
}

export function istWochenende(tag: string): boolean {
  return wochentag(tag) >= 5;
}

/** alle Tage von a bis b (einschließlich) */
export function tageVonBis(a: string, b: string): string[] {
  const r: string[] = [];
  for (let t = a; t <= b; t = plusTage(t, 1)) r.push(t);
  return r;
}

/** letzter Mo–Fr vor dem Tag */
export function vorherigerArbeitstag(tag: string): string {
  let t = plusTage(tag, -1);
  while (istWochenende(t)) t = plusTage(t, -1);
  return t;
}

/** Mo–Fr zwischen a (ausschließlich) und b (einschließlich) */
export function arbeitstageZwischen(a: string, b: string): number {
  let n = 0;
  for (let t = plusTage(a, 1); t <= b; t = plusTage(t, 1)) if (!istWochenende(t)) n++;
  return n;
}

/** ISO-Woche: { jahr, woche } */
export function isoWoche(tag: string): { jahr: number; woche: number } {
  const x = d(tag);
  x.setUTCDate(x.getUTCDate() + 3 - wochentag(tag)); // Donnerstag der Woche
  const jahr = x.getUTCFullYear();
  const tagImJahr = Math.round((x.getTime() - Date.UTC(jahr, 0, 1)) / 86400000);
  return { jahr, woche: Math.floor(tagImJahr / 7) + 1 };
}

export function isoWocheId(tag: string): string {
  const w = isoWoche(tag);
  return `${w.jahr}-W${String(w.woche).padStart(2, '0')}`;
}

/** Montag der ISO-Woche 'YYYY-Www' */
export function wocheMontag(jahr: number, woche: number): string {
  const vierter = isoAus(jahr, 1, 4);
  return plusTage(vierter, -wochentag(vierter) + (woche - 1) * 7);
}

export function monatsEnde(monat: string): string {
  const [j, m] = monat.split('-').map(Number);
  return iso(new Date(Date.UTC(j, m, 0)));
}

/** 'Mo 16.11.' */
export function tagKurz(tag: string): string {
  return `${WOCHENTAGE[wochentag(tag)]} ${tag.slice(8, 10)}.${tag.slice(5, 7)}.`;
}

/** '16.11.' */
export function ddmm(tag: string): string {
  return `${tag.slice(8, 10)}.${tag.slice(5, 7)}.`;
}

/** '20.11.2026' */
export function datumDe(tag: string): string {
  return `${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)}`;
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Zahl de-DE, max. 2 Nachkommastellen */
export function zahl(n: number): string {
  return r2(n).toLocaleString('de-DE', { maximumFractionDigits: 2 });
}
