/**
 * Posteingang Euroflex – Typen und kleine Hilfen der Oberfläche. Vertrag: docs/euroflex-mailworkflows.md, „Prüfliste und Ablage“.
 * Die Antworten werden tolerant gelesen (normalisieren), damit kleine Abweichungen im Aufbau (Liste direkt oder in einem Objekt)
 * die Oberfläche nicht brechen.
 */
import { T } from '../util';

export const EING = `${T}/eingang`;

export type VorgangStatus = 'pruefen' | 'fehler' | 'abgelegt' | 'ignoriert';

export interface Begruendung { grund: string; punkte: number }

/** Zeile der Prüfliste: GET /eingang/vorgaenge?status=… */
export interface VorgangZeile {
  id: number;
  von: string | null;
  von_name: string | null;
  betreff: string | null;
  datum: string | null;
  status: VorgangStatus | string;
  auftragsnr: string | null;
  punkte: number | null;
  anzahl_dokumente: number;
  /** optional: Anzahl gleichwertiger Kandidaten (ohne eindeutigen Vorschlag) */
  anzahl_kandidaten?: number | null;
  /** Eingangspostfach, in dem die E-Mail ankam (z. B. info@ oder buchhaltung@) */
  postfach?: string | null;
  /** wer die Ablage bestätigt hat; „Posteingang (automatisch)“ = früher automatisch abgelegt */
  abgelegt_von?: string | null;
  /** bearbeitet und für die gesammelte Übergabe vorgemerkt (Auftrag = auftragsnr) */
  vorgemerkt?: boolean | null;
  vorgemerkt_von?: string | null;
}

/** Eingangspostfach mit Bezeichnung (Einstellungen → Mail-Workflows → Eingang) */
export interface EingangsPostfach { adresse: string; bezeichnung: string }

export interface Kandidat {
  auftragsnr: string;
  punkte?: number | null;
  kunde?: string | null;
  datum?: string | null;
  begruendung?: Begruendung[] | null;
}

export interface EingangDokument {
  id: number;
  /** 'mail' = die E-Mail selbst als PDF, sonst Anhang */
  art?: string | null;
  datei: string;
  mime: string | null;
  groesse: number;
  status: string;
  ziel: string | null;
  ocr_auszug?: string | null;
  /** Inhalt liegt (noch) im Portal */
  vorhanden?: boolean;
}

/** GET /eingang/vorgaenge/:id */
export interface Vorgang extends VorgangZeile {
  an?: string | null;
  /** für die Übergabe gewählte Dateien (null = alle offenen) */
  vorgemerkt_dokumente?: number[] | null;
  text?: string | null;
  begruendung?: Begruendung[] | null;
  kandidaten?: Kandidat[] | null;
  dokumente: EingangDokument[];
  /** optional: Schwelle für einen sicheren Vorschlag (sonst Standard 80) */
  abgeschlossen_am?: string | null;
  schwelle?: number | null;
  hinweis?: string | null;
}

/** GET /eingang/speicher */
export interface Speicher { bytes: number; dateien: number; warnungMb: number; warnung: boolean; aufbewahrtBytes?: number; aufbewahrtDateien?: number; aufbewahrenTage?: number; aufbewahrenDauerhaft?: boolean }

/** GET /auftraege/:nr/eingang */
export interface AuftragEingangDokument {
  id: number;
  datei: string;
  /** Dateiname im Ablageordner (Unterordner Eingang/), falls vom Browser gemeldet */
  ablage_name?: string | null;
  /** Inhalt liegt (noch) im Portal – wartend oder nach der Übernahme aufbewahrt */
  vorhanden?: boolean;
  mime: string | null;
  groesse: number;
  status: string;
  ziel: string | null;
  paperless_id?: number | null;
  von: string | null;
  betreff: string | null;
  datum: string | null;
}

export const SCHWELLE_STANDARD = 80;

export const STATUS_TEXT: Record<string, string> = {
  pruefen: 'zu prüfen', fehler: 'Fehler', abgelegt: 'abgelegt', ignoriert: 'ignoriert', neu: 'neu',
  wartet: 'wartet auf Übernahme', uebernommen: 'im Ablageordner', dublette: 'Dublette', paperless: 'in Paperless',
};

/** Liste aus einer Antwort lesen: direkt ein Array oder unter einem der Schlüssel */
export function liste<X>(r: unknown, ...schluessel: string[]): X[] {
  if (Array.isArray(r)) return r as X[];
  if (r && typeof r === 'object') {
    for (const k of schluessel) {
      const v = (r as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as X[];
    }
  }
  return [];
}

/** Text einer Aktion für den Toast: { text } vom Server oder Ersatztext */
export const antwortText = (r: unknown, sonst: string) =>
  (r && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string' ? (r as { text: string }).text : sonst);

export const groesse = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`);
export const mb = (b: number) => (b / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 });

/** „heute 08:12“, „gestern 17:40“, sonst „14.11. 09:03“ bzw. mit Jahr */
export function zeitText(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const uhr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const heute = new Date();
  const tag = (x: Date) => x.toDateString();
  if (tag(d) === tag(heute)) return `heute ${uhr}`;
  const gestern = new Date(heute); gestern.setDate(heute.getDate() - 1);
  if (tag(d) === tag(gestern)) return `gestern ${uhr}`;
  const datum = d.toLocaleDateString('de-DE', d.getFullYear() === heute.getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${datum} ${uhr}`;
}

/** Badge der Liste: Vorschlag (grün ab Schwelle, sonst orange), mehrere Kandidaten (orange) oder kein Treffer (grau) */
/** Bearbeiter der früheren automatischen Ablage (Server: SYSTEM in eingang/verarbeitung.ts) */
export const AUTOMATISCH = 'Posteingang (automatisch)';
export const automatischAbgelegt = (v: Pick<VorgangZeile, 'abgelegt_von'>) => v.abgelegt_von === AUTOMATISCH;

/** Kennzeichnung je E-Mail: abgelegt (am Auftrag, bestätigt oder früher automatisch), ignoriert oder Vorschlag/Kandidaten */
export function treffer(v: Pick<VorgangZeile, 'auftragsnr' | 'punkte' | 'anzahl_kandidaten'> & Partial<Pick<VorgangZeile, 'status' | 'abgelegt_von'>>, schwelle: number): { text: string; state: 'Positive' | 'Critical' | 'None' | 'Information' } {
  const p = v.punkte ?? 0;
  const k = v.anzahl_kandidaten ?? 0;
  if (v.status === 'abgelegt') {
    return automatischAbgelegt(v)
      ? { text: `Automatisch abgelegt · ${v.auftragsnr ?? '?'}`, state: 'Information' }
      : { text: `Abgelegt · ${v.auftragsnr ?? '?'}`, state: 'Positive' };
  }
  if (v.status === 'ignoriert') return { text: 'Ignoriert', state: 'None' };
  if (v.auftragsnr) return { text: `Vorschlag ${v.auftragsnr} · ${p}`, state: p >= schwelle ? 'Positive' : 'Critical' };
  if (k > 1) return { text: `${k} Kandidaten · ${p}`, state: 'Critical' };
  if (k === 1 || p > 0) return { text: `Kandidat · ${p}`, state: 'Critical' };
  return { text: 'kein Treffer', state: 'None' };
}

export const absender = (v: Pick<VorgangZeile, 'von' | 'von_name'>) => v.von_name || v.von || '(unbekannt)';
export const istPdf = (d: { datei: string; mime: string | null }) => d.mime === 'application/pdf' || /\.pdf$/i.test(d.datei);
export const dateiUrl = (id: number) => `${EING}/dokumente/${id}/datei`;
