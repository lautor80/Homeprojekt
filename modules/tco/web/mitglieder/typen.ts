import { TCO } from '../util';

export const MG = `${TCO}/mitglieder`;

export type Status = 'AKTIV' | 'AUSGETRETEN' | 'KUNDEN' | 'ELTERN' | 'ALLE';
export interface ListZeile {
  adrnr: string; name: string; mitglnrn: string; info: string; ort: string; eintritt: string | null; austritt: string | null;
  status_txt: string; state: 'Positive' | 'Negative' | 'Critical'; kunde: boolean; eltern: boolean; zahler: boolean;
}
export interface Liste { zeilen: ListZeile[]; anzahl: Record<Status, number> }

export interface Mitglied {
  adrnr: string; anrede: string; vorname: string; nachname: string; strasse: string; plz: string; ort: string; telefon: string; mobil: string;
  email: string; geburtsdatum: string | null; geschlecht: string; geschlecht_txt: string; eintritt: string | null; austritt: string | null;
  mitglnrn: string; datenschutz: boolean; bildrechte: boolean; aktiv: boolean;
}
export interface Bank {
  zahlungsart: string; zahlungsart_txt: string; zahlungsweise: string; zahlungsweise_txt: string; iban: string; bic: string; bank: string;
  abwkontoinh: string; adrnrkih: string; kontoinhaber: string; mandatsref: string;
  zahler: { adrnr: string; name: string; austritt: string | null; iban: string } | null;
}
export interface Person { adrnr: string; name: string; mitglnrn: string; geburtsdatum: string | null; eintritt: string | null; austritt: string | null; rolle: string }
export interface Vertrag {
  adrnr: string; person: string; vertragnr: string; art: string; artname: string; sollstellung: string; vertragbegin: string | null;
  vertragende: string | null; betrag: number; zahler_adrnr: string; zahler: string; laeuft: boolean; eigen: boolean;
}
export interface Sepa {
  adrnr: string; inhaber: string; mandatsnr: string; lastschriftart: string; typ: string; angelegtam: string | null; gueltigbis: string | null;
  status: string; manuell_aktiv: boolean; aktiv: boolean; austritt: string | null; eigen: boolean;
}
export interface Detail {
  mitglied: Mitglied; titel: string; bank: Bank; trainer: boolean; zuid: string; kanal: string;
  /** false = Bankdaten kommen maskiert (Berechtigung tco.bankdaten:display fehlt) */
  bankKlar: boolean;
  familie: Person[]; vertraege: Vertrag[]; sepa: Sepa[];
  schluessel: { counter: string; ausgabe: string | null; ausgabebeleg: string | null; ruecknahme: string | null; ruecknahmebeleg: string | null }[];
  notizen: { notiz_id: string; erstellt_am: string; erstellt_von: string | null; notiz: string }[];
  /** direkt zugeordnete Mitgliedergruppen */
  gruppen: { id: number; rolle: string | null }[];
}
export interface VertragsArt { art: string; name: string; betrag: number; turnus: string }
export interface Auswahl {
  zahler: { adrnr: string; text: string; iban: string }[]; vtZahler: { adrnr: string; text: string }[]; arten: VertragsArt[]; turnusse: string[];
  zahlungsarten: Record<string, string>; zahlungsweisen: Record<string, string>; unterlagen: Record<string, string>; paperless: boolean;
}
export interface Dok { id: number; titel: string; erstellt: string; typ: string; notizen: number; datei: string; mime: string; /** enthält Bankdaten, Berechtigung fehlt */ gesperrt?: boolean }
