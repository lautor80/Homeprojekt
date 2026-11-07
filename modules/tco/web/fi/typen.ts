import { TCO } from '../util';

export const F = `${TCO}/fi`;

export interface Konto { konto: string; name: string; kennzahl: string | null; gruppe: string; aktiv: boolean }
export interface FiInit { konten: Konto[]; bankkonten: string[]; manuellKonten: string[]; paperless: boolean }

export interface Zeile {
  key: string; internenr: string | null; konto: string; posnr: number; datum: string; text: string; betrag: number;
  gkonto: string | null; gkontoName: string; kontoName: string; belnr: string; rgnr_txt: string | null; split: string | null;
  anhaenge: number; notizen: number; letzteNotiz: string | null; storniert: string | null; stornoZu: string | null;
  sammel: number; hallenmiete: boolean;
}
export interface Salden { jahresanfang: number; quelle: string; tag: Record<string, number>; aktuell: number; aktuellDatum: string | null }
export interface OffeneRechnung { rgnr_txt: string; kunde: string; betrag: number; gezahlt: number; offen: number; status: string }
export interface Liste { zeilen: Zeile[]; salden: Salden | null; rechnungen: OffeneRechnung[] }

export interface Beleg { id: number; titel: string; korrespondent: string; datum: string | null; betrag: number | null; zugeordnet?: string[] }

export interface Position { gkonto: string; betrag: number; text?: string | null; rgnr?: string | null }
export interface BankUmsatz {
  id: number; datum: string; valuta: string | null; name: string; zweck: string; buchungstext: string; betrag: number;
  saldo: number | null; status: 'neu' | 'gebucht'; statusText: string; positionen: Position[]; herkunft: string;
  art: 'regel' | 'historie' | 'keine'; belegVorschlag: { doks: number[]; text: string } | null; buchungsText: string;
}
export interface BankDatei {
  konto: string; info: string; iban: string | null; von: string; bis: string; endsaldo: number | null; saldoFi: number;
  umsaetze: BankUmsatz[]; hinweise: string[];
}

/** Betragseingabe „1.234,56“, „-50“, „12.50“ */
export function betragParse(s: string): number | null {
  let t = s.replace(/[€\s+]/g, '').trim();
  if (!t || t === '-') return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (!/^-?\d+(\.\d{1,2})?$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
export const betragText = (v: number) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Betragsfarbe: Konto < 2000 Soll grün/Haben rot, sonst umgekehrt */
export function betragFarbe(konto: string, betrag: number): 'Positive' | 'Negative' | 'None' {
  const n = Number(konto);
  if (!Number.isFinite(n) || betrag === 0) return 'None';
  if (n < 2000) return betrag > 0 ? 'Positive' : 'Negative';
  return betrag > 0 ? 'Negative' : 'Positive';
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const heute = () => iso(new Date());

export const ZEITRAEUME = [
  { key: 'monat', text: 'Aktueller Monat' }, { key: 'vormonat', text: 'Vorheriger Monat' },
  { key: 'quartal', text: 'Aktuelles Quartal' }, { key: 'vorquartal', text: 'Vorheriges Quartal' },
  { key: 'jahr', text: 'Aktuelles Jahr' }, { key: 'j1', text: 'Vor 1 Jahr' }, { key: 'j2', text: 'Vor 2 Jahren' },
  { key: 'j3', text: 'Vor 3 Jahren' }, { key: 'frei', text: '– Freie Eingabe –' },
] as const;

export function zeitraum(key: string): [string, string] | null {
  const h = new Date();
  const y = h.getFullYear();
  const m = h.getMonth();
  const q = Math.floor(m / 3);
  switch (key) {
    case 'monat': return [iso(new Date(y, m, 1)), iso(h)];
    case 'vormonat': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case 'quartal': return [iso(new Date(y, q * 3, 1)), iso(new Date(y, q * 3 + 3, 0))];
    case 'vorquartal': return [iso(new Date(y, q * 3 - 3, 1)), iso(new Date(y, q * 3, 0))];
    case 'jahr': return [`${y}-01-01`, `${y}-12-31`];
    case 'j1': case 'j2': case 'j3': {
      const j = y - Number(key[1]);
      return [`${j}-01-01`, `${j}-12-31`];
    }
    default: return null;
  }
}
