/**
 * Migration lokaler Auftragsordner nach Paperless – reine Funktionen ohne Browser-APIs
 * (Test: server/test/transport_paperless_auftrag.test.ts; ausgeführt in PaperlessMigration.tsx).
 *
 * Regel: Ein Ordner, der nach der Auftragsnummer benannt ist, gibt diese Nummer an jede Datei darunter weiter – auch in
 * Unterordnern (z. B. 2026/2026_0153/Eingang/Lieferschein.pdf → 2026_0153). Maßgeblich ist der oberste solche Ordner im Pfad.
 */

/** Ordnername, der wie eine Auftragsnummer aussieht: JJJJ_NNNN, auch mit Zusatz nach einem Leerzeichen („2026_0153 Müller“) */
const MUSTER = /^(\d{4}_\d{3,6})(?=$|\s)/;

/** Auftragsnummer, die der Ordnername nennen könnte (exakter Name oder Nummer am Anfang) */
export function nummerAusName(name: string): string | null {
  return MUSTER.exec(name.trim())?.[1] ?? null;
}

/** alle Namen, die der Server als Auftrag prüfen soll: jeder Ordnername und die daraus gelesene Nummer */
export function kandidaten(ordnerPfade: string[][]): string[] {
  const s = new Set<string>();
  for (const p of ordnerPfade) for (const o of p) {
    const n = o.trim();
    if (!n) continue;
    s.add(n);
    const m = nummerAusName(n);
    if (m) s.add(m);
  }
  return [...s];
}

export interface Zuordnung { nr: string; /** im Portal als Auftrag vorhanden */ bekannt: boolean; /** Index des Ordners im Pfad */ ebene: number }

/**
 * Auftrag einer Datei aus ihren Ordnern (vom gewählten Ordner abwärts, ohne Dateinamen): der oberste Ordner, der ein Auftrag
 * im Portal ist; gibt es keinen, der oberste, der wie eine Auftragsnummer aussieht (bekannt: false). null = kein Auftrag.
 */
export function auftragFuer(ordner: string[], bekannt: ReadonlySet<string>): Zuordnung | null {
  for (let i = 0; i < ordner.length; i++) {
    const n = ordner[i].trim();
    if (bekannt.has(n)) return { nr: n, bekannt: true, ebene: i };
    const m = nummerAusName(n);
    if (m && bekannt.has(m)) return { nr: m, bekannt: true, ebene: i };
  }
  for (let i = 0; i < ordner.length; i++) {
    const m = nummerAusName(ordner[i]);
    if (m) return { nr: m, bekannt: false, ebene: i };
  }
  return null;
}

/** Ausstellungsdatum: Datum der Datei im lokalen Ordner (Ortszeit), JJJJ-MM-TT */
export function dateiDatum(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Dateitypen, die Paperless annimmt (wie DATEITYPEN im Server, dokumente.ts) */
export const MIGRATION_TYPEN = ['pdf', 'png', 'jpg', 'jpeg', 'heic', 'webp', 'gif', 'tif', 'tiff', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'eml'];
export const typErlaubt = (name: string) => MIGRATION_TYPEN.includes((/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase());
/** Systemdateien, die nie übertragen werden */
export const ignorieren = (name: string) => /^(\.|~\$|thumbs\.db$|desktop\.ini$)/i.test(name);

export type MigStatus = 'offen' | 'laeuft' | 'neu' | 'vorhanden' | 'verarbeitung' | 'fehler' | 'uebersprungen';
export interface MigEintrag {
  key: string;
  /** Pfad im gewählten Ordner, z. B. 2026/2026_0153/Eingang/Lieferschein.pdf */
  pfad: string;
  ordner: string[];
  datei: string;
  groesse: number;
  datum: string;
  nr: string | null;
  bekannt: boolean;
  status: MigStatus;
  text: string;
}

/** Ist der Eintrag für die Übertragung vorgesehen? (ohne Auftrag, falscher Typ, unbekannter Auftrag ohne Freigabe: nein) */
export function uebertragbar(e: MigEintrag, mitUnbekannten: boolean): boolean {
  return !!e.nr && typErlaubt(e.datei) && (e.bekannt || mitUnbekannten);
}

/** Zusammenfassung für die Kopfzeile */
export function zaehlen(l: MigEintrag[], mitUnbekannten: boolean) {
  const z = { dateien: l.length, auftraege: new Set(l.filter((e) => e.nr).map((e) => e.nr)).size, offen: 0, fertig: 0, fehler: 0, ohneAuftrag: 0, unbekannt: 0, typ: 0 };
  for (const e of l) {
    if (!e.nr) z.ohneAuftrag++;
    else if (!typErlaubt(e.datei)) z.typ++;
    else if (!e.bekannt && !mitUnbekannten) z.unbekannt++;
    if (e.status === 'neu' || e.status === 'vorhanden') z.fertig++;
    else if (e.status === 'fehler') z.fehler++;
    else if ((e.status === 'offen' || e.status === 'verarbeitung') && uebertragbar(e, mitUnbekannten)) z.offen++;
  }
  return z;
}
