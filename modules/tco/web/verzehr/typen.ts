import { TCO } from '../util';

export const VZ = `${TCO}/verzehr`;

export type Rubrik = 'G' | 'S' | 'X';
export type Zahlart = 'BAR' | 'KARTE' | 'PAYPAL' | 'UEBERWEISUNG' | 'LASTSCHRIFT';
export interface Produkt { prod_key: string; rubrik: Rubrik; text: string; preis: number; preis_gast: number | null; valid_from: string; valid_to: string }
export interface Preisliste { rubriken: Record<Rubrik, string>; zahlarten: Record<Zahlart, string>; produkte: Produkt[]; paperless: boolean }
export interface Posten {
  id: number; datum: string; zeit: string; adrnr: string | null; rgnr: string | null; prod_key: string; text: string; anzahl: number; preis: number; betrag: number;
  selbst: boolean; erfasst_von: string | null; erfasst_am: string; storniert_am: string | null; storniert_von: string | null; storno_grund: string | null;
}
export interface Beleg {
  rgnr: string; art: 'GAST' | 'SAMMEL'; adrnr: string | null; gast_name: string | null; gast_gruppe: string | null; email?: string | null; mobil?: string | null;
  datum: string; monat: string | null; status: 'OFFEN' | 'GESTELLT' | 'BEZAHLT' | 'STORNIERT'; betrag: number; zahlart: Zahlart | null; faellig: string | null;
  bezahlt_am: string | null; doc_id: number | null; versand_am: string | null; versand_art: string | null; laufid: string | null; person?: string; posten?: number; mitglied_email?: string;
}
export type Mengen = Record<string, number>;

export const STATUS_TEXT: Record<string, string> = { OFFEN: 'offen', GESTELLT: 'abgerechnet', ABGERECHNET: 'abgerechnet', BEZAHLT: 'bezahlt', STORNIERT: 'storniert' };
export const STATUS_STATE: Record<string, 'None' | 'Information' | 'Positive' | 'Critical' | 'Negative'> = { OFFEN: 'Critical', GESTELLT: 'Information', ABGERECHNET: 'Information', BEZAHLT: 'Positive', STORNIERT: 'None' };
export const ZAHLART_TEXT: Record<Zahlart, string> = { BAR: 'Bar', KARTE: 'Karte', PAYPAL: 'PayPal', UEBERWEISUNG: 'Überweisung', LASTSCHRIFT: 'Lastschrift' };

export const isoHeute = () => new Date().toLocaleDateString('sv-SE');
export const aktMonat = () => isoHeute().slice(0, 7).replace('-', '');
export function monatVerschieben(m: string, n: number) {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(4, 6)) - 1 + n, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monatsname = (m: string) => `${MONATE[Number(m.slice(4, 6)) - 1]} ${m.slice(0, 4)}`;
export const summe = (produkte: Produkt[], mengen: Mengen, gast: boolean) =>
  Math.round(produkte.reduce((s, p) => s + (mengen[p.prod_key] ?? 0) * (gast && p.preis_gast != null ? p.preis_gast : p.preis), 0) * 100) / 100;
export const wuensche = (mengen: Mengen) => Object.entries(mengen).filter(([, n]) => n > 0).map(([prod_key, anzahl]) => ({ prod_key, anzahl }));
export const klein = () => window.matchMedia?.('(max-width: 700px)').matches ?? false;

/** Auf dem Handy PDFs im neuen Tab öffnen */
export async function pdfOeffnen(url: string, onError: (t: string) => void) {
  const w = window.open('', '_blank');
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(JSON.parse((await r.text()) || '{}').message ?? `Fehler ${r.status}`);
    const blobUrl = URL.createObjectURL(await r.blob());
    if (w) w.location.href = blobUrl; else window.location.href = blobUrl;
  } catch (e) { w?.close(); onError((e as Error).message); }
}
