/**
 * Schnuppertraining (#86) – Inhalt des Druckberichts je Anmeldung: alle Angaben des Schnupperantrags und der Betreuung
 * als Abschnitte mit Zeilen „Angabe | Inhalt“. Reine Funktion ohne Datenbank und PDF (Test: server/test/tco_schnupper_bericht.test.ts);
 * gezeichnet wird in schnupper/pdf.ts im TCO-Layout.
 */
import type { SchnupperZeile } from './logik.js';

export interface BerichtEinheit { datum: string; trainer: string | null; erfasst_von: string | null }
/** Angaben, die nicht in der Liste der Verwaltung stehen */
export interface BerichtZusatz { einwilligung_am: string | null; einheiten: BerichtEinheit[] }
export interface BerichtAbschnitt { titel: string; zeilen: [string, string][] }

const TAG_LANG: Record<string, string> = { Mo: 'Montag', Di: 'Dienstag', Mi: 'Mittwoch', Do: 'Donnerstag', Fr: 'Freitag', Sa: 'Samstag', So: 'Sonntag' };
const LEER = '–';

/** JJJJ-MM-TT → TT.MM.JJJJ */
export const datumText = (d: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : LEER;
};
/** Zeitpunkt (ISO/Date) → TT.MM.JJJJ HH:MM Uhr in Berliner Zeit */
export const zeitpunktText = (z: string | Date | null | undefined) => {
  if (!z) return LEER;
  const d = new Date(z);
  if (Number.isNaN(d.getTime())) return LEER;
  const t = Object.fromEntries(new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${t.day}.${t.month}.${t.year} ${t.hour}:${t.minute} Uhr`;
};
const w = (s: string | null | undefined) => (s ?? '').trim() || LEER;

/** Alle Angaben einer Anmeldung als Abschnitte (leere Angaben als „–“, damit jede Angabe des Antrags sichtbar ist) */
export function berichtAbschnitte(z: SchnupperZeile, x: BerichtZusatz, einheitenKostenlos: number): BerichtAbschnitt[] {
  const minderjaehrig = z.alter != null && z.alter < 18;
  const a: BerichtAbschnitt[] = [
    {
      titel: 'Anmeldung',
      zeilen: [
        ['Anmeldenummer', z.nummer],
        ['Eingegangen am', zeitpunktText(z.eingang)],
        ['Status', z.status_txt],
        ['Einwilligung Kontaktdaten', x.einwilligung_am ? `erteilt am ${zeitpunktText(x.einwilligung_am)} (nur zur Kontaktaufnahme zum Schnuppertraining)` : 'nicht erfasst'],
      ],
    },
    {
      titel: 'Person und Kontakt',
      zeilen: [
        ['Vorname', w(z.vorname)],
        ['Nachname', w(z.nachname)],
        ['Alter', z.alter != null ? `${z.alter} Jahre${minderjaehrig ? ' (minderjährig)' : ''}` : LEER],
        ['Erziehungsberechtigte/r', minderjaehrig || z.erziehungsberechtigt ? w(z.erziehungsberechtigt) : 'nicht nötig (volljährig)'],
        ['E-Mail', w(z.email)],
        ['Handy', w(z.mobil)],
      ],
    },
    {
      titel: 'Tennis',
      zeilen: [
        ['Schon Tennis gespielt', z.gespielt ? 'ja' : 'nein'],
        ['Spielstärke', w(z.stufe_txt)],
      ],
    },
    {
      titel: 'Mögliche Termine',
      zeilen: [
        ['Tage', z.termine.tage.length ? z.termine.tage.map((t) => TAG_LANG[t] ?? t).join(', ') : LEER],
        ['Tageszeiten', z.termine.zeiten.length ? z.termine.zeiten.join(', ') : LEER],
        ['Hinweis zu Terminen', w(z.termine.text)],
      ],
    },
    { titel: 'Mitteilung', zeilen: [['Mitteilung an den Verein', w(z.mitteilung)]] },
    {
      titel: 'Betreuung',
      zeilen: [
        ['Trainer', w(z.trainer)],
        ['1. Einheit', datumText(z.einheit1)],
        ['2. Einheit', datumText(z.einheit2)],
        ['Geschnuppert laut Trainingszeiten', `${z.einheiten} von ${einheitenKostenlos} kostenlosen Einheiten${z.einheiten > einheitenKostenlos ? ' – mehr als kostenlos vorgesehen' : ''}`],
        ['Notiz', w(z.notiz)],
        ['Zuletzt bearbeitet', z.bearbeitet_von ? `${z.bearbeitet_von}${z.bearbeitet_am ? `, ${zeitpunktText(z.bearbeitet_am)}` : ''}` : LEER],
      ],
    },
    {
      titel: 'Beitritt',
      zeilen: [
        ['Mitgliedsantrag', z.antrag ? z.antrag : 'noch kein Mitgliedsantrag'],
        ['Mitgliedsnummer', w(z.mitglnrn)],
      ],
    },
  ];
  return a;
}

/** Einheiten aus „Meine Trainingszeiten“ als Tabellenzeilen: Datum, Trainer, erfasst von */
export function einheitenZeilen(x: BerichtZusatz): [string, string, string][] {
  return [...x.einheiten].sort((a, b) => a.datum.localeCompare(b.datum)).map((e) => [datumText(e.datum), w(e.trainer), w(e.erfasst_von)]);
}
