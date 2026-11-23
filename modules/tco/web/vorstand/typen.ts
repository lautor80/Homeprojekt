import { TCO } from '../util';

export const VS = `${TCO}/vorstand`;

export type Status = 'GEPLANT' | 'LAEUFT' | 'ENTWURF' | 'FREIGEGEBEN';
export type Teilnahme = 'OFFEN' | 'ANWESEND' | 'ENTSCHULDIGT' | 'FEHLT';
export type Ergebnis = 'ANGENOMMEN' | 'ABGELEHNT';
export type Stand = 'ERLEDIGT' | 'UEBERFAELLIG' | 'BALD' | 'OFFEN';

export interface EventKurz { id: number; titel: string; beginn: string; ende: string | null; ort: string | null; abgesagt: boolean; zusagen: number; absagen: number }
export interface Sitzung {
  id: number; nr: string; jahr: number; lfd: number; titel: string; art: 'VORSTAND' | 'ERWEITERT'; art_text: string;
  datum: string; beginn: string | null; ende: string | null; ort: string | null;
  status: Status; status_text: string; leitung: string | null; protokoll_von: string | null; bemerkung: string | null; importiert: boolean;
  freigegeben_am: string | null; freigegeben_von: string | null; geaendert_am: string; geaendert_von: string | null; event: EventKurz | null;
}
export interface SitzungZeile extends Sitzung { tops: number; beschluesse: number; aufgaben_offen: number; anlagen: number; anwesend: number; vorstand: number }
export interface Teilnehmer { id: number; adrnr: string | null; name: string; rolle: string | null; art: 'VORSTAND' | 'GAST'; status: Teilnahme; rueckmeldung: string | null }
export interface Eintrag {
  id: number; top_id: number; pos: number; art: 'BESCHLUSS' | 'AUFGABE' | 'INFO'; text: string;
  nr: string | null; ja: number | null; nein: number | null; enthaltung: number | null; ergebnis: Ergebnis | null;
  verantwortlich: string | null; faellig: string | null; erledigt_am: string | null; erledigt_von: string | null;
}
export interface Top { id: number; pos: number; nr: number; titel: string; verantwortlich: string | null; text: string | null; status: 'OFFEN' | 'ERLEDIGT' | 'VERTAGT'; eintraege: Eintrag[] }
export interface Anlage { id: number; top_id: number | null; dateiname: string; mime: string; groesse: number; url: string | null; erstellt_am: string; erstellt_von: string | null }
export interface SitzungDetail extends Sitzung {
  teilnehmer: Teilnehmer[]; tops: Top[]; anlagen: Anlage[];
  beschlussfaehig: { anwesend: number; gesamt: number; ok: boolean | null };
  naechste: Status[]; pflege: boolean; freigabe: boolean;
}
export interface EventWahl { id: number; titel: string; kategorie: string; beginn: string; ort: string | null; abgesagt: boolean; sitzung_id: number | null }
export interface Uebersicht {
  sitzungen: SitzungZeile[]; jahre: number[];
  cfg: { gruppe_id: number | null; gruppe: string | null; automatisch: boolean };
  vorstand: { adrnr: string; name: string; rolle: string | null }[];
  events: EventWahl[]; gruppen: { id: number; name: string; parent_id: number | null }[];
  status_text: Record<Status, string>; teilnahme_text: Record<Teilnahme, string>; pflege: boolean; freigabe: boolean;
}
export interface BeschlussZeile extends Eintrag { sitzung_id: number; sitzung_nr: string; sitzung_titel: string; datum: string; top: string }
export interface AufgabeZeile extends Eintrag { sitzung_id: number; sitzung_nr: string; datum: string; top: string; stand: Stand }

export const STATUS_STATE: Record<Status, 'None' | 'Information' | 'Critical' | 'Positive'> = {
  GEPLANT: 'None', LAEUFT: 'Information', ENTWURF: 'Critical', FREIGEGEBEN: 'Positive',
};
export const STAND_STATE: Record<Stand, 'Positive' | 'Negative' | 'Critical' | 'None'> = { ERLEDIGT: 'Positive', UEBERFAELLIG: 'Negative', BALD: 'Critical', OFFEN: 'None' };
export const STAND_TEXT: Record<Stand, string> = { ERLEDIGT: 'erledigt', UEBERFAELLIG: 'überfällig', BALD: 'bald fällig', OFFEN: 'offen' };

export const uhrzeit = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
export const tagIso = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
export const abstimmung = (e: { ja: number | null; nein: number | null; enthaltung: number | null; ergebnis: Ergebnis | null }) => {
  const z = [e.ja != null && `Ja ${e.ja}`, e.nein != null && `Nein ${e.nein}`, e.enthaltung != null && `Enth. ${e.enthaltung}`].filter(Boolean).join(' · ');
  return z;
};
