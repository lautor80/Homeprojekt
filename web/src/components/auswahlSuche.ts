/**
 * Abgleich von eingegebenem bzw. ausgewähltem Text mit den Einträgen einer AuswahlBox.
 * Leerzeichen werden vereinheitlicht (doppelte, geschützte oder abschließende Leerzeichen aus dem Stammsatz),
 * sonst passt der in der ComboBox übernommene Text nicht mehr zum Eintrag und die Auswahl wird verworfen.
 */
export const normText = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

export function eintragZuText<T extends { key: string; text: string }>(eintraege: T[], t: string): string | undefined {
  const v = normText(t);
  if (!v) return undefined;
  const genau = eintraege.filter((e) => normText(e.text) === v);
  if (genau.length === 1) return genau[0].key;
  if (genau.length > 1) return undefined;
  const klein = eintraege.filter((e) => normText(e.text).toLowerCase() === v.toLowerCase());
  return klein.length === 1 ? klein[0].key : undefined;
}
