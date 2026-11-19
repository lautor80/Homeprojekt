/**
 * Automatische Ablage von Belegen (Transportauftrag, Lieferschein, Rechnung) in Paperless beim Drucken und Versenden –
 * reine Regeln ohne Datenbank. Ablauf und Datenbank: archiv.ts.
 */
export type BelegArt = 'T' | 'L' | 'R';
export interface Beleg { art: BelegArt; kennung: string }
export type Anlass = 'druck' | 'versand';

const NAMEN: Record<BelegArt, string> = { T: 'Transportauftrag', L: 'Lieferschein', R: 'Rechnung' };
export const belegName = (b: Beleg) => `${NAMEN[b.art]}_${b.kennung}.pdf`;
export const belegText = (b: Beleg) => `${NAMEN[b.art]} ${b.kennung}`;

/** Beleg aus dem Dateinamen eines Anhangs („Transportauftrag_2026_0153-2.pdf“) – andere Dateien: null */
export function belegAusDateiname(name: string): Beleg | null {
  const m = /^(Transportauftrag|Lieferschein|Rechnung)_([A-Za-z0-9_./-]+)\.pdf$/i.exec(name.trim());
  if (!m) return null;
  const art = (Object.keys(NAMEN) as BelegArt[]).find((a) => NAMEN[a].toLowerCase() === m[1].toLowerCase())!;
  return { art, kennung: m[2] };
}

/** Auftragsnummer zu Transportauftrag/Lieferschein: „Auftrag-Fahrt“ → Auftrag (Rechnungen: über die Faktura) */
export const auftragAusKennung = (kennung: string) => kennung.replace(/-\d+$/, '');

/** Jeder Beleg einmal, Reihenfolge bleibt */
export function belegeEindeutig<T extends Beleg>(liste: T[]): T[] {
  const gesehen = new Set<string>();
  return liste.filter((b) => {
    const k = `${b.art}:${b.kennung}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
}

/**
 * Muss der Beleg (erneut) abgelegt werden? Ja, wenn er noch nie abgelegt wurde oder der Auftrag seit der letzten Ablage
 * geändert wurde – sonst entstünde bei jedem Druck ein weiteres gleiches Dokument in Paperless.
 */
export function ablegenNoetig(bisher: { stand: Date | string } | null | undefined, stand: Date | string | null, erzwingen = false): boolean {
  if (erzwingen || !bisher) return true;
  if (!stand) return false;
  return new Date(stand).getTime() > new Date(bisher.stand).getTime();
}
