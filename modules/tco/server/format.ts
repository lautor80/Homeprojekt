/** Formatierungen wie in den ABAP-Klassen (deutsche Schreibweise) */

export const heute = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function addTage(iso: string, tage: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

export const dat = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');

export const zeit = (t: string | null | undefined) => (t ? t.slice(0, 5) : '');

export function zahl(v: number, nk = 2): string {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: nk, maximumFractionDigits: nk }).format(v);
}

export const eur = (v: number) => `${zahl(v)} €`;

export const runden = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export const WOCHENTAGE = ['SONNTAG', 'MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG'] as const;
export const WOCHENTAG_TEXT: Record<string, string> = {
  MONTAG: 'Montag', DIENSTAG: 'Dienstag', MITTWOCH: 'Mittwoch', DONNERSTAG: 'Donnerstag',
  FREITAG: 'Freitag', SAMSTAG: 'Samstag', SONNTAG: 'Sonntag',
};

export function wochentag(iso: string): string {
  return WOCHENTAGE[new Date(`${iso}T12:00:00Z`).getUTCDay()];
}

export function ibanFormat(iban: string | null | undefined): string {
  return (iban ?? '').replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/** "MAX MUSTERMANN" → "Max Mustermann" (auch Bindestriche) */
export function nameSchoen(n: string | null | undefined): string {
  return (n ?? '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

export const condense = (s: string) => s.replace(/\s+/g, ' ').trim();
