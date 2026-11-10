import { TCO } from '../util';

export const EING = `${TCO}/eingang`;

export interface Bedingung { feld: string; op: string; wert: string; nicht?: boolean }
export interface Extraktion { name: string; quelle: string; muster: string; pflicht?: boolean }
export interface PaperlessZiel { aktiv: boolean; titel?: string; korrespondent?: string; dokumenttyp?: string; speicherpfad?: string; tags?: string; datum?: string; notiz?: string }
export type MailArt = 'keine' | 'verschieben' | 'loeschen';
export interface MailAktion { art: MailArt; ordner?: string; gelesen?: boolean }
export interface Aktionen {
  paperless?: PaperlessZiel;
  nextcloud?: { aktiv: boolean; pfad: string; dateiname: string };
  mail?: MailAktion;
  aufgabe?: { aktiv: boolean; titel: string; faellig_tage?: number | null };
}
export interface RegelEingabe {
  name: string; beschreibung: string; status: 'aktiv' | 'testlauf' | 'aus'; prioritaet: number; gilt_fuer: 'anhang' | 'mail'; verknuepfung: 'und' | 'oder';
  bedingungen: Bedingung[]; extraktion: Extraktion[]; aktionen: Aktionen; automatik: 'immer' | 'pruefen';
}
export interface Regel extends RegelEingabe { id: number; version: number; treffer: number; letzter: string | null }

export interface Stamm {
  felder: Record<string, string>; operatoren: Record<string, string>; quellen: Record<string, string>; platzhalter: { name: string; text: string }[];
  paperless: { eingerichtet: boolean; korrespondenten: string[]; dokumenttypen: string[]; speicherpfade: string[]; tags: string[] };
  nextcloud: { eingerichtet: boolean };
  abruf: { eingerichtet: boolean };
}

export interface Zuordnung { title: string; created?: string; correspondent: string; documentType: string; storagePath: string; tags: string[]; notiz: string }
export interface Dokument {
  id: number; art: 'anhang' | 'mail'; datei: string; mime: string | null; groesse: number; status: string; hinweis: string | null;
  regel_id: number | null; regel_name: string | null;
  zuordnung: { zuordnung: Zuordnung | null; nextcloud: { pfad: string; dateiname: string } | null; felder?: Record<string, string> } | null;
  paperless_id: number | null; nextcloud_pfad: string | null; vorhanden: boolean; bearbeitet_am: string | null; bearbeitet_von: string | null;
}
export interface Vorgang {
  id: number; postfach: string; von: string | null; von_name: string | null; betreff: string | null; datum: string | null; eingang_am: string;
  status: string; hinweis: string | null; korrespondent: string | null; mitglied_adrnr: string | null; mail_aktion: MailAktion | null; mail_erledigt: boolean;
  dokumente: Dokument[];
}
export interface VorgangListe { vorgaenge: Vorgang[]; gekuerzt: boolean; offen: { pruefen: number; fehler: number } }
export interface Korrespondent { id: number; name: string; kurz: string; adressen: string }

export const STATUS_TEXT: Record<string, string> = {
  neu: 'neu', pruefen: 'zu prüfen', fehler: 'Fehler', abgelegt: 'abgelegt', dublette: 'bereits vorhanden', ignoriert: 'nicht abgelegt', ohne_regel: 'ohne Regel',
};
export const STATUS_STATE: Record<string, 'None' | 'Information' | 'Positive' | 'Critical' | 'Negative'> = {
  neu: 'Information', pruefen: 'Critical', fehler: 'Negative', abgelegt: 'Positive', dublette: 'Positive', ignoriert: 'None', ohne_regel: 'None',
};
export const REGEL_STATUS: Record<string, string> = { aktiv: 'aktiv', testlauf: 'Testlauf', aus: 'aus' };

export const leereRegel = (): RegelEingabe => ({
  name: '', beschreibung: '', status: 'testlauf', prioritaet: 100, gilt_fuer: 'anhang', verknuepfung: 'und',
  bedingungen: [{ feld: 'korrespondent', op: 'ist', wert: '' }], extraktion: [],
  aktionen: {
    // Ablage in Paperless und Nextcloud ist zunächst aus und wird bei Bedarf in der Regel eingeschaltet
    paperless: { aktiv: false, titel: '{datei|ohneEndung}', korrespondent: '{korrespondent}', dokumenttyp: '', speicherpfad: '', tags: 'Maileingang', datum: '{datum}', notiz: '' },
    nextcloud: { aktiv: false, pfad: '', dateiname: '{datum}_{kurz}_{datei}' },
    mail: { art: 'keine', ordner: '', gelesen: false },
    aufgabe: { aktiv: false, titel: '', faellig_tage: null },
  },
  automatik: 'immer',
});

export function mailText(a: MailAktion | null | undefined): string {
  if (!a) return '';
  const teile = [a.art === 'verschieben' ? `verschieben nach „${a.ordner ?? ''}“` : a.art === 'loeschen' ? 'in den Papierkorb' : '', a.gelesen ? 'als gelesen markieren' : ''].filter(Boolean);
  return teile.join(', ') || 'bleibt unverändert';
}

export const zelle = { padding: '0.3rem 0.5rem', verticalAlign: 'top' } as const;
export const kopf = { ...zelle, textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--sapList_BorderColor)' } as const;
