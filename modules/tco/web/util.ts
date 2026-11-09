export const TCO = '/api/m/tco';
export const H = `${TCO}/halle`;

export const betrag = (v: number | null | undefined) =>
  (v ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const eur = (v: number | null | undefined) => `${betrag(v)} €`;

export function dat(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
export const zeit = (t: string | null | undefined) => (t ? t.slice(0, 5) : '');
const TAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const wtag = (iso: string) => TAGE[new Date(`${iso}T12:00:00`).getDay()];

export const RG_STATUS: Record<string, string> = {
  '1': 'In Bearbeitung', '2': 'Gedruckt', '3': 'Versendet', '4': 'Bezahlt', '5': 'Teilbezahlt', '6': 'Forderung ausgefallen',
};
export const RG_STATE: Record<string, 'None' | 'Information' | 'Positive' | 'Critical' | 'Negative'> = {
  '1': 'Information', '2': 'None', '3': 'Critical', '4': 'Positive', '5': 'Critical', '6': 'Negative',
};

export function dateiLesen(f: File): Promise<string> {
  return new Promise((ok, err) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => err(r.error);
    r.readAsDataURL(f);
  });
}

export interface Kontakt {
  adrnr: string; anrede: string; vorname: string; nachname: string; strasse: string; plz: string; ort: string;
  email: string; telefon: string; mobil: string; geschlecht: string;
}
export interface Rechnung {
  rgnr_txt: string; kunde: string; adrnr: string | null; betrag: number; status: string; angelegt_am: string | null;
  gedruckt: string | null; versendet: string | null; bezahlt: string | null; doknr: string | null; anzahl: number;
  gezahlt: number; offen: number; aenderbar: boolean; wiedereroeffnet: boolean;
}
export interface Buchung {
  bid: string; datum: string; time_start: string; time_ende: string; kunde: string; status: string; art: 'Abo' | 'Einzel';
  text: string | null; termine: number; betrag: number; dauer: number; prodKey: string | null; fehler: string | null;
  vergangen: boolean; zukunft: boolean;
}
export interface Person {
  kunde: string; name: string; offeneBuchungen: number; betragBuchungen: number;
  rechnungen: { rgnr_txt: string; status: string; betrag: number; offen: number; versendet: string | null }[]; offenRechnungen: number; betrag: number; gruppe: string;
  probleme: Problem[];
}
/** Hinweis, der Rechnung oder Versand behindert */
export interface Problem { art: 'KONTAKT' | 'ANSCHRIFT' | 'VERSAND' | 'PREIS'; schwere: 'Negative' | 'Critical'; text: string }
export const PROBLEM_ICON: Record<Problem['art'], string> = { KONTAKT: 'person-placeholder', ANSCHRIFT: 'addresses', VERSAND: 'email-read', PREIS: 'lead' };
export interface PersonDetail {
  kunde: string; name: string; adrnr: string | null; kontakt: Kontakt | null; kanal: 'E' | 'W' | '';
  rechnungen: Rechnung[]; buchungen: Buchung[]; offeneRechnungen: number; gezahlt: number; offenRechnungen: number; betragBuchungen: number; probleme: Problem[];
}
export interface Position {
  rgpos: number; bid: string | null; datum: string | null; time_start: string | null; time_ende: string | null; prod_key: string | null;
  art: string; beschreibung: string; anzahl: number; ep: number; betrag: number; storno: boolean; manuell: boolean;
  /** verknüpfter Paperless-Beleg (z. B. Namensliste einer Sammelrechnung) */
  beleg_doc_id?: number | null;
}
export interface PaperlessInfo {
  doknr: string | null; link: string | null; notizen: { id: number; note: string; created: string }[];
  versionen: { id: number; label: string | null; added: string | null; isRoot: boolean }[]; ansicht: string | null; fehler?: string;
}

/** Buchungsnummer ohne führende Nullen anzeigen (gespeichert im SAP-Format, 10-stellig) */
export const bidText = (bid: string | null | undefined) => (bid ?? '').replace(/^0+(?=\d)/, '');
