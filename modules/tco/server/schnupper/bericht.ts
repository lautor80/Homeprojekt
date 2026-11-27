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
const ANTRAG_STATUS = { EINGANG: 'in Prüfung', UEBERNOMMEN: 'übernommen', ABGELEHNT: 'abgelehnt' } as const;
/** Vertragsangebot aus der Schnupperverwaltung: Nummer und Stand */
const angebotText = (a: SchnupperZeile['angebot']) => (!a ? 'kein Vertragsangebot'
  : a.status === 'ANGENOMMEN' ? `${a.nummer} angenommen`
    : a.status === 'ZURUECKGEZOGEN' ? `${a.nummer} zurückgezogen`
      : a.abgelaufen ? `${a.nummer} abgelaufen am ${datumText(a.gueltig_bis)}` : `${a.nummer} offen bis ${datumText(a.gueltig_bis)}`);

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
        ['Hat angefangen', z.angefangen === true ? `ja${z.angefangen_am ? `, seit ${datumText(z.angefangen_am)}` : ''}` : z.angefangen === false ? 'nein' : 'offen'],
        ['Vertragsangebot', angebotText(z.angebot)],
        ['Mitgliedsantrag', z.antrag ? z.antrag : z.antrag_nr ? `${z.antrag_nr}${z.antrag_status ? ` (${ANTRAG_STATUS[z.antrag_status]})` : ''}` : 'noch kein Mitgliedsantrag'],
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

// ---------------------------------------------------------------------------- Liste: je Interessent ein paar Zeilen
/** Spalten der kompakten Liste (Querformat) */
export const LISTE_SPALTEN = ['Anmeldung', 'Interessent', 'Kontakt', 'Tennis und Wunschtermine', 'Stand und Betreuung'] as const;

export interface ListenEintrag {
  /** je Spalte die Zeilen (leere entfallen) */
  spalten: string[][];
  /** Mitteilung und Notiz als Zusatzzeile unter dem Eintrag (leer = keine) */
  bemerkung: string;
}

const kurzDatum = (d: string | null) => (d ? datumText(d).slice(0, 6) : 'offen');

/** Ein Interessent in ein paar Zeilen: Anmeldung, Person, Kontakt, Tennis/Termine, Stand/Betreuung, darunter Mitteilung/Notiz */
export function listenEintrag(z: SchnupperZeile, einheitenKostenlos: number): ListenEintrag {
  const nicht = (s: string | null | undefined) => !!(s ?? '').trim();
  const termine = [z.termine.tage.join(', '), z.termine.zeiten.join(', ')].filter(Boolean).join(' · ');
  const spalten = [
    [z.nummer, `Eingang ${zeitpunktText(z.eingang).replace(' Uhr', '')}`],
    [`${z.vorname} ${z.nachname}`.trim(), z.alter != null ? `${z.alter} Jahre` : '', nicht(z.erziehungsberechtigt) ? `Erziehungsberechtigt: ${z.erziehungsberechtigt!.trim()}` : ''],
    [z.email.trim(), z.mobil.trim(), !z.email.trim() && !z.mobil.trim() ? LEER : ''],
    [`${z.gespielt ? 'hat schon gespielt' : 'noch nie gespielt'} · ${z.stufe_txt}`, termine ? `Wunsch: ${termine}` : 'Wunsch: –', nicht(z.termine.text) ? z.termine.text!.trim() : ''],
    [
      z.status_txt,
      `Einheiten: 1. ${kurzDatum(z.einheit1)} · 2. ${kurzDatum(z.einheit2)} · ${z.einheiten}/${einheitenKostenlos} geschnuppert`,
      [nicht(z.trainer) ? `Trainer: ${z.trainer!.trim()}` : '', z.antrag ? `Antrag ${z.antrag}${z.mitglnrn ? ` · Nr. ${z.mitglnrn}` : ''}` : ''].filter(Boolean).join(' · '),
    ],
  ].map((s) => s.filter((x) => x.trim()));
  const bemerkung = [nicht(z.mitteilung) ? `Mitteilung: ${z.mitteilung!.trim()}` : '', nicht(z.notiz) ? `Notiz: ${z.notiz!.trim()}` : '']
    .filter(Boolean).join('  ·  ').replace(/\s*\r?\n\s*/g, ' / ');
  return { spalten, bemerkung };
}
