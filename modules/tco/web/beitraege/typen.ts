import { TCO } from '../util';

export const BT = `${TCO}/beitraege`;

export interface KeyText { key: string; text: string }

export interface Zeile {
  art: string; bezeichnung: string; turnus: string; konto: string; betrag: number; seit: string; naechst: string;
  vertraege: number; aktiv: boolean; status: string; state: 'Positive' | 'Critical'; gruppe: string;
}
export interface Uebersicht { leer: boolean; zeilen: Zeile[]; turnusse: KeyText[]; heute: string }

export interface Preis {
  art: string; gueltig_ab: string; gueltig_bis: string; betrag: number | string; aenam: string | null; aedat: string | null;
  ab_txt: string; bis_txt: string; info: string; state: 'Positive' | 'Information' | 'None'; loeschbar: boolean;
}
export interface Vertrag {
  adrnr: string; vertragnr: string; name: string; mitglnr: string; vertragbegin: string | null; vertragende: string | null;
  betrag: number; betrag_indiv: boolean; betrag_heute: number; sollstellung: string; laeuft: boolean;
}
export interface Detail {
  neu: boolean; art: string; bezeichnung: string; turnus: string; konto: string; aktiv: boolean;
  ernam?: string | null; erdat?: string | null; aenam?: string | null; aedat?: string | null;
  vertraege_txt: string; vertraege: Vertrag[]; preise: Preis[]; neu_ab: string; turnusse: KeyText[]; konten: KeyText[];
}
