import { TCO } from '../util';
import { saisonZu, type SbDaten, type SbSpieler } from '../../server/sport/spielbericht-logik';

/** Spielberichte (Sport → Spielberichte): Pfade und Typen der Antworten */
export const SB = `${TCO}/sport/spielberichte`;
export const BERICHT_STATUS: Record<string, { text: string; state: 'None' | 'Information' | 'Positive' | 'Critical' }> = {
  kein: { text: 'kein Bericht', state: 'None' },
  entwurf: { text: 'Entwurf', state: 'Critical' },
  eingereicht: { text: 'eingereicht', state: 'Positive' },
};

export interface SpieltagZeile {
  id: number; saison: string; datum: string; uhrzeit: string | null; nr: string; halle: string; platz: string; liga: string; heim: string; gast: string;
  status: 'kein' | 'entwurf' | 'eingereicht'; punkte: [number, number] | null; fertig: number; anzahl: number; freigaben: number;
  listeHeim: number | null; listeGast: number | null;
}
export interface Spieltage { saisons: string[]; zeilen: SpieltagZeile[] }
export interface VorschauSpieltag {
  zeile: number; tag: string; datum: string; uhrzeit: string | null; nr: string; halle: string; platz: string; liga: string; heim: string; gast: string;
  fehler: string | null; saison: string; status: 'neu' | 'vorhanden' | 'fehler';
}
export interface ListeKopf { id: number; saison: string; verein: string; konkurrenz: string; spieler: number; stand: string }
export interface MeldeSpieler { rang: number; mannschaft: number | null; nachname: string; vorname: string; id_nr: string | null; lk: number | null; nation: string; adrnr?: string | null; zeile?: number }
export interface ListeDetail extends Omit<ListeKopf, 'spieler'> { spieler: MeldeSpieler[] }
export interface ListeVorschau { spieler: MeldeSpieler[]; fehler: { zeile: number; text: string }[]; ignoriert: number; konkurrenz: string | null }

export interface Freigabe { name: string; am: string; von: string }
export interface Seite {
  team: string; verein: string; nr: number;
  liste: { id: number; konkurrenz: string; verein: string } | null;
  spieler: (SbSpieler & { lk: number | null })[];
}
export interface BerichtAntwort {
  spieltag: { id: number; saison: string; datum: string; uhrzeit: string | null; nr: string; halle: string; platz: string; liga: string; heim: string; gast: string };
  heim: Seite; gast: Seite;
  daten: SbDaten; gespeichert: boolean; status: 'entwurf' | 'eingereicht'; stand: string | null;
  freigaben: { heim: Freigabe | null; gast: Freigabe | null; osr: Freigabe | null };
  eingereicht: { am: string; von: string } | null;
}

export const lkText = (v: number | null | undefined) => (v == null ? '' : `LK ${v.toFixed(1).replace('.', ',')}`);
export const zeitpunkt = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '');
/** Saison zu heute (gleiche Regel wie im Server) */
export const saisonHeute = () => saisonZu(new Date().toISOString().slice(0, 10));
