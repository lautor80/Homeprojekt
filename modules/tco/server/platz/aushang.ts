/**
 * Hinweise in der Hallenbuchung („Aushang“) – reine Logik ohne Datenbank.
 *
 * Ein Aushang ist eine Mitteilung des Vereins mit Text und Bildern (z. B. zur Hallenverschmutzung), die beim Aufruf von
 * „Platz buchen“ als Dialog erscheint. Sichtbar ist er, solange er aktiv ist und heute in seinem Gültigkeitszeitraum liegt
 * – für alle, die buchen dürfen, oder nur für Benutzer der gewählten Rollen. Von selbst geöffnet wird er
 *  - „einmal je Benutzer“ (EINMAL): bis der Benutzer ihn gesehen hat – mit Bestätigungspflicht bis zur Bestätigung,
 *  - „bei jedem Aufruf“ (IMMER): bei jedem Öffnen von „Platz buchen“, solange er gilt.
 * Die Reihenfolge: kritisch vor Warnung vor Information, dann der neueste zuerst.
 */

export const STILE = ['INFO', 'WARNUNG', 'KRITISCH'] as const;
export type Stil = (typeof STILE)[number];
export const ANZEIGEN = ['EINMAL', 'IMMER'] as const;
export type Anzeige = (typeof ANZEIGEN)[number];

export interface Aushang {
  id: number; titel: string; text: string; stil: Stil; gueltig_von: string; gueltig_bis: string | null;
  rollen: string[]; anzeige: Anzeige; bestaetigen: boolean; aktiv: boolean;
}
export interface Gesehen { gesehen: boolean; bestaetigt: boolean }

const RANG: Record<Stil, number> = { KRITISCH: 0, WARNUNG: 1, INFO: 2 };

/** gilt der Aushang heute für einen Benutzer mit diesen Rollen? */
export function gilt(a: Aushang, heute: string, rollen: string[]): boolean {
  if (!a.aktiv || a.gueltig_von > heute || (a.gueltig_bis && a.gueltig_bis < heute)) return false;
  return !a.rollen.length || a.rollen.some((r) => rollen.includes(r));
}

/** öffnet sich der (geltende) Aushang von selbst? */
export function oeffnetSich(a: Aushang, g: Gesehen | undefined): boolean {
  if (a.anzeige === 'IMMER') return true;
  return a.bestaetigen ? !g?.bestaetigt : !g?.gesehen;
}

export const sortieren = <T extends Pick<Aushang, 'stil' | 'gueltig_von' | 'id'>>(l: T[]): T[] =>
  [...l].sort((x, y) => RANG[x.stil] - RANG[y.stil] || y.gueltig_von.localeCompare(x.gueltig_von) || y.id - x.id);

/** Aushänge für einen Benutzer: alle geltenden (zum Nachlesen) und die, die sich jetzt von selbst öffnen */
export function fuerBenutzer<T extends Aushang>(alle: T[], d: { heute: string; rollen: string[]; gesehen: Map<number, Gesehen> }): { aktuell: T[]; oeffnen: T[] } {
  const aktuell = sortieren(alle.filter((a) => gilt(a, d.heute, d.rollen)));
  return { aktuell, oeffnen: aktuell.filter((a) => oeffnetSich(a, d.gesehen.get(a.id))) };
}

/** Gültigkeit prüfen; Fehlertext oder null */
export function pruefen(a: Pick<Aushang, 'titel' | 'gueltig_von' | 'gueltig_bis'>): string | null {
  if (!a.titel.trim()) return 'Bitte einen Titel angeben.';
  if (a.gueltig_bis && a.gueltig_bis < a.gueltig_von) return '„Gültig bis“ liegt vor „gültig ab“.';
  return null;
}

/** Text für ein Rundschreiben aus dem Aushang (Anrede vorn, Gruß hinten) */
export function rundschreibenText(a: Pick<Aushang, 'titel' | 'text'>, gruss: string): string {
  return `{Anrede},\n\n${a.text.trim() || a.titel.trim()}\n\nViele Grüße\n${gruss}`;
}

/** Stand je Aushang für die Verwaltung */
export function stand(a: Pick<Aushang, 'aktiv' | 'gueltig_von' | 'gueltig_bis'>, heute: string): 'AKTUELL' | 'GEPLANT' | 'ABGELAUFEN' | 'AUS' {
  if (!a.aktiv) return 'AUS';
  if (a.gueltig_von > heute) return 'GEPLANT';
  if (a.gueltig_bis && a.gueltig_bis < heute) return 'ABGELAUFEN';
  return 'AKTUELL';
}
