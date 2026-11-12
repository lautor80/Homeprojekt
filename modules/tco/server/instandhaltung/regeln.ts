/**
 * Instandhaltung / Schadensmeldung (#205) – fachliche Regeln ohne Datenbank (lokal testbar).
 */

export const STATUS = {
  NEU: 'Neu', GESICHTET: 'Gesichtet', ZUGEWIESEN: 'Zugewiesen', IN_ARBEIT: 'In Arbeit', WARTET: 'Wartet (Material/Fremdfirma)',
  ERLEDIGT: 'Erledigt', ABGELEHNT: 'Abgelehnt', DUPLIKAT: 'Duplikat',
} as const;
export type Status = keyof typeof STATUS;
export const STATUS_OFFEN: Status[] = ['NEU', 'GESICHTET', 'ZUGEWIESEN', 'IN_ARBEIT', 'WARTET'];
export const STATUS_ENDE: Status[] = ['ERLEDIGT', 'ABGELEHNT', 'DUPLIKAT'];
export const istOffen = (s: string) => (STATUS_OFFEN as string[]).includes(s);

export const AUSWIRKUNG = {
  SICHERHEIT: 'Sicherheitsrisiko', UNBESPIELBAR: 'Platz unbespielbar / nicht nutzbar', EINGESCHRAENKT: 'Eingeschränkt nutzbar', OPTISCH: 'Nur optisch',
} as const;
export type Auswirkung = keyof typeof AUSWIRKUNG;

export const ANLAGE_TYPEN = { PLATZ: 'Platz', HALLE: 'Halle', GEBAEUDE: 'Gebäude', AUSSEN: 'Außenanlage', SONSTIGES: 'Sonstiges' } as const;
export type AnlageTyp = keyof typeof ANLAGE_TYPEN;

/** Darstellung im Arbeitsvorrat: Sicherheitsrisiko rot, unbespielbar orange, sonst neutral */
export function aufgabeState(a: string): 'Negative' | 'Critical' | 'Information' {
  return a === 'SICHERHEIT' ? 'Negative' : a === 'UNBESPIELBAR' ? 'Critical' : 'Information';
}

/** Meldungsnummer SM-JJJJ-NNNN */
export const meldungsNummer = (jahr: number, id: number) => `SM-${jahr}-${String(id).padStart(4, '0')}`;

/** Text kürzen (Arbeitsvorrat, Betreff) – an Wortgrenze, mit „…“ */
export function kurz(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const s = t.slice(0, max - 1);
  const w = s.lastIndexOf(' ');
  return `${(w > max * 0.6 ? s.slice(0, w) : s).trimEnd()}…`;
}

/**
 * Statuswechsel prüfen. Liefert eine Fehlermeldung oder null.
 * Von „Erledigt/Abgelehnt/Duplikat“ geht es nur zurück in die Bearbeitung (Wiedereröffnen) – nicht in einen anderen Endstatus.
 */
export function wechselFehler(alt: string, neu: string, o: { duplikatVon?: number | null; erledigung?: string | null } = {}): string | null {
  if (!(neu in STATUS)) return `Unbekannter Status „${neu}“.`;
  if (alt !== neu && !istOffen(alt) && !istOffen(neu)) return 'Eine abgeschlossene Meldung kann nur wieder geöffnet werden.';
  if (neu === 'DUPLIKAT' && !o.duplikatVon) return 'Bitte die Meldung angeben, von der diese ein Duplikat ist.';
  if (neu === 'ABGELEHNT' && !o.erledigung?.trim()) return 'Bitte einen Grund für die Ablehnung angeben.';
  return null;
}

/** Eskalation: Sicherheitsrisiko, offen und seit 24 h kein Statuswechsel und keine Erinnerung */
export function eskalationFaellig(m: { auswirkung: string; status: string; status_am: Date | string; erinnert_am: Date | string | null }, jetzt = new Date()): boolean {
  if (m.auswirkung !== 'SICHERHEIT' || !istOffen(m.status)) return false;
  const tag = 24 * 3600_000;
  const seit = (d: Date | string) => jetzt.getTime() - new Date(d).getTime();
  if (seit(m.status_am) < tag) return false;
  return !m.erinnert_am || seit(m.erinnert_am) >= tag;
}

/** Empfängerliste (Komma/Semikolon), ohne Dubletten und ohne leere Einträge */
export function empfaenger(...listen: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const l of listen) {
    for (const x of (l ?? '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && !out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x);
    }
  }
  return out;
}

/** Foto als Data-URL prüfen: nur JPEG/PNG/WebP, höchstens maxBytes */
export function fotoLesen(dataUrl: string, maxBytes = 1_500_000): { mime: string; daten: Buffer } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw new Error('Bitte nur Fotos (JPEG, PNG oder WebP) anhängen.');
  const daten = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!daten.length) throw new Error('Das Foto ist leer.');
  if (daten.length > maxBytes) throw new Error(`Das Foto ist zu groß (${(daten.length / 1024 / 1024).toFixed(1)} MB, höchstens ${(maxBytes / 1024 / 1024).toFixed(1)} MB).`);
  return { mime: m[1], daten };
}
