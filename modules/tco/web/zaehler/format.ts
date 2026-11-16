import { TCO } from '../util';
import { MEDIEN, STAND_ARTEN, type Kennzahlen, type Medium, type StandArt, type Zaehler } from './typen';

/** Hilfen der App „Zählerstände“: Adressen, Zahlenformat, Symbole und Status */
export const Z = `${TCO}/zaehler`;
export const FOTO_URL = (sid: number) => `${Z}/staende/${sid}/foto`;
export const QR_URL = (id: number) => `${Z}/${id}/qr`;
/** Adresse zum Erfassen am Zähler (Inhalt des QR-Codes) */
export const ERFASSEN_PFAD = (id?: number) => `/tco/zaehler/erfassen${id ? `?zaehler=${id}` : ''}`;

export const MEDIUM_ICON: Record<Medium, string> = {
  STROM: 'lightbulb', GAS: 'heating-cooling', WASSER: 'weather-proofing', WAERME: 'temperature',
  PV: 'energy-saving-lightbulb', OEL: 'lab', SONSTIGES: 'measure',
};
export const mediumText = (m: Medium) => MEDIEN.find((x) => x.key === m)?.text ?? m;
export const artText = (a: StandArt) => STAND_ARTEN.find((x) => x.key === a)?.text ?? a;
export const ART_KURZ: Record<StandArt, string> = { ABLESUNG: 'Ablesung', SCHAETZUNG: 'Schätzung', AUSBAU: 'Ausbau', EINBAU: 'Einbau' };

/** Einheit des Verbrauchs (nach Faktor) */
export const vEinheit = (z: Pick<Zaehler, 'einheit' | 'verbrauchseinheit'>) => z.verbrauchseinheit || z.einheit;

/** Zahl deutsch formatiert; Nachkommastellen nach Größe (bis 3) */
export function zahl(v: number | null | undefined, stellen?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const d = stellen ?? (Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  return v.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
export const mitEinheit = (v: number | null | undefined, einheit: string, stellen?: number) =>
  (v === null || v === undefined ? '–' : `${zahl(v, stellen)}${einheit ? ` ${einheit}` : ''}`);
/** Zählerstand: alle Nachkommastellen zeigen, die erfasst wurden (höchstens 3) */
export const standText = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 3 });
export const prozent = (v: number | null | undefined) =>
  (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`);

/**
 * Eingabe eines Zählerstands mit deutschem Komma: „12.345,6“ → 12345.6; ohne Komma gilt ein einzelner Punkt als
 * Dezimalzeichen (Ziffernblock am Handy). Leer oder ungültig → null.
 */
export function zahlLesen(s: string): number | null {
  let t = s.trim().replace(/\s/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if ((t.match(/\./g) ?? []).length > 1) t = t.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** Zahl als Eingabetext (deutsches Komma, ohne Tausenderpunkte) */
export const zahlEingabe = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

export const heute = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const tageBis = (iso: string) => Math.round((new Date(`${iso}T12:00:00`).getTime() - new Date(`${heute()}T12:00:00`).getTime()) / 86_400_000);

export type Ampel = 'Negative' | 'Critical' | 'Positive' | 'None';
/** Fälligkeit der nächsten Ablesung: überfällig = Negative, in höchstens 7 Tagen = Critical, sonst Positive; ohne Intervall None */
export function faelligkeit(k: Kennzahlen): { state: Ampel; text: string } {
  if (k.ueberfaellig) return { state: 'Negative', text: k.faelligAm ? `überfällig seit ${datKurz(k.faelligAm)}` : 'überfällig' };
  if (!k.faelligAm) return { state: 'None', text: k.letzteAblesung ? 'ohne Ableseintervall' : 'noch keine Ablesung' };
  const t = tageBis(k.faelligAm);
  if (t < 0) return { state: 'Negative', text: `überfällig seit ${datKurz(k.faelligAm)}` };
  if (t <= 7) return { state: 'Critical', text: t === 0 ? 'heute fällig' : `fällig in ${t} ${t === 1 ? 'Tag' : 'Tagen'}` };
  return { state: 'Positive', text: `fällig am ${datKurz(k.faelligAm)}` };
}
const datKurz = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const MONATE = MON;
/** 'YYYY-MM' → „Mär 26“, 'YYYY' bleibt */
export const periodeText = (p: string, lang = false) => {
  if (p.length < 7) return p;
  const m = MON[Number(p.slice(5, 7)) - 1] ?? p;
  return lang ? `${m} ${p.slice(0, 4)}` : `${m} ${p.slice(2, 4)}`;
};
/** Monat 'YYYY-MM' um n Monate verschieben */
export function monatPlus(p: string, n: number): string {
  const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}
export const dieserMonat = () => heute().slice(0, 7);
