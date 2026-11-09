/**
 * Regelwerk der Mitgliedergruppen (#16): Altersprüfung – reine Rechenlogik ohne Importe.
 *
 * Ohne „Kalenderjahr zählt“ gilt das Alter am Stichtag (volle Jahre).
 * Mit „Kalenderjahr zählt“ zählt das ganze Jahr, in dem das Alter erreicht wird bzw. noch erreicht war:
 * Es genügt, wenn das Alter irgendwann im Kalenderjahr des Stichtags im Bereich liegt.
 *   Beispiel 6–7 Jahre: Wer im Dezember 6 wird, zählt ab Januar; wer im März 8 wird, zählt noch bis Jahresende.
 */
/** Geschlecht als Kriterium: '' = alle (gemischt), 'M' = männlich, 'W' = weiblich */
export type RegelGeschlecht = '' | 'M' | 'W';
export interface AltersRegel { alter_von: number | null; alter_bis: number | null; jahrgang: boolean; geschlecht?: RegelGeschlecht }

const teile = (iso: string) => iso.slice(0, 10).split('-').map(Number) as [number, number, number];

/** Alter in vollen Jahren am Stichtag (Datumsangaben JJJJ-MM-TT) */
export function alterAm(geburtsdatum: string, stichtag: string): number {
  const [gj, gm, gt] = teile(geburtsdatum);
  const [j, m, t] = teile(stichtag);
  return j - gj - (m < gm || (m === gm && t < gt) ? 1 : 0);
}

/** kleinstes und größtes Alter, das die Person im Kalenderjahr des Stichtags hat */
export function alterImJahr(geburtsdatum: string, stichtag: string): [number, number] {
  const [gj, gm, gt] = teile(geburtsdatum);
  const max = teile(stichtag)[0] - gj;
  // am 1. Januar Geborene sind das ganze Jahr gleich alt
  return [gm === 1 && gt === 1 ? max : max - 1, max];
}

/** `geschlecht` der Person: 'M', 'W' oder '' (nicht gepflegt) – wird nur geprüft, wenn die Regel ein Geschlecht verlangt */
export function passtZurRegel(geburtsdatum: string | null, r: AltersRegel, stichtag: string, geschlecht: RegelGeschlecht = ''): boolean {
  if (r.geschlecht && r.geschlecht !== geschlecht) return false;
  if (!geburtsdatum) return false;
  const [min, max] = r.jahrgang ? alterImJahr(geburtsdatum, stichtag) : [alterAm(geburtsdatum, stichtag), alterAm(geburtsdatum, stichtag)];
  if (max < 0) return false;
  return (r.alter_von == null || max >= r.alter_von) && (r.alter_bis == null || min <= r.alter_bis);
}

/** „6–7 Jahre“, „ab 40 Jahre“, „bis 10 Jahre“ */
export function regelText(r: AltersRegel): string {
  const a = r.alter_von != null && r.alter_bis != null ? (r.alter_von === r.alter_bis ? `${r.alter_von} Jahre` : `${r.alter_von}–${r.alter_bis} Jahre`)
    : r.alter_von != null ? `ab ${r.alter_von} Jahre` : `bis ${r.alter_bis} Jahre`;
  const g = r.geschlecht === 'M' ? ' · männlich' : r.geschlecht === 'W' ? ' · weiblich' : '';
  return `${r.jahrgang ? `${a} (Kalenderjahr zählt)` : a}${g}`;
}
