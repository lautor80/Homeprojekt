import { TCO } from '../util';

export const KO = `${TCO}/konten`;

export interface JahrInfo { jahr: number; aktiv: boolean; anz: number; saldo: number }

export interface KontoZeile {
  konto: string; name: string; kennzahl: string; profitcenter: string; gruppe: string;
  letzte: string | null; bebucht: boolean; aktAktiv: boolean; jahre: JahrInfo[];
  /** nur in der Oberfläche: noch nicht gespeichertes Konto */
  neu?: boolean;
  /** nur in der Oberfläche: eindeutiger Schlüssel für neue Zeilen */
  key?: string;
}

export interface Uebersicht { von: number; bis: number; aktJahr: number; profitcenter: { key: string; text: string }[]; zeilen: KontoZeile[] }

export interface Bestand {
  konto: string; name: string; kennzahl: string;
  anfangsbestand: number | null; endbestand: number | null;
  rechnerisch: number; quelle: string; kontostand: number; differenz: number | null;
}

export const GRUPPE_NEU = '0 · Neue Konten (noch nicht gespeichert)';
