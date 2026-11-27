/**
 * Platzverwaltung → Belegung: gewählter Tag – reine Funktionen ohne React.
 * Der Tag im Datumsfeld und die angezeigte Belegung müssen immer zusammenpassen: Wer den 04.12. wählt, darf nicht die
 * Belegung von heute sehen (gleicher Wochentag, gleiches Abo – der Unterschied fällt erst im Termin-Dialog auf).
 * Test: server/test/tco_belegung_datum.test.ts
 */

/** gültiges ISO-Datum (JJJJ-MM-TT), das es im Kalender gibt */
function gueltig(iso: string): boolean {
  const t = Date.parse(`${iso}T12:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso;
}

/**
 * Eingabe des Datumsfelds lesen: ISO („2026-12-04“) oder so, wie das Feld sie anzeigt („Fr., 04.12.2026“, „4.12.2026“).
 * Das Feld meldet je nach Gerät den Wert im Anzeigeformat und/oder als „ungültig“ (Wochentagskürzel) – deshalb wird der
 * Tag hier selbst gelesen statt sich auf diese Meldung zu verlassen. Unlesbar ⇒ null (der bisherige Tag bleibt).
 */
export function datumLesen(roh: string | null | undefined): string | null {
  const r = (roh ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(r)) return gueltig(r) ? r : null;
  const m = /(?:^|[^\d])(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/.exec(r);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return gueltig(iso) ? iso : null;
}

/** Passt die geladene Belegung zu den gewählten Tagen? (sonst: nicht anzeigen – eine ältere Antwort kam später an) */
export function passtZuTagen(geladen: { datum: string }[] | null, tage: string[]): boolean {
  return !!geladen && geladen.length === tage.length && geladen.every((t, i) => t.datum.slice(0, 10) === tage[i]);
}
