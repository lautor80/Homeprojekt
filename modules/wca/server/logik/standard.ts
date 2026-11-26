/**
 * WCA Zeitenkontrolle – Standard-Einstellungen, Wortlisten der F-Regeln und Regelkatalog (Name, Erkennung, Tipp).
 */
import type { Art, Einstellungen, Kategorie, WortRegel } from '../typen.js';

export const STANDARD_WORTREGELN: Record<string, WortRegel> = {
  F_pauschal: {
    name: 'Sammelbegriff ohne Inhalt', art: 'ns', nurAbrechenbar: false, stufeIntern: 2, stufeBillable: 3,
    woerter: 'diverses, diverse themen, div., sonstiges, sonstige themen, allerlei, kleinkram, kleinigkeiten, verschiedenes, allgemeine themen, various, misc, miscellaneous, stuff, general topics, diverse topics, several topics, other topics, sundry, sundries, odds and ends, bits and pieces',
    tipp: 'Die einzelnen Themen konkret aufzählen statt eines Sammelbegriffs.',
  },
  F_versuch: {
    name: 'Versuch ohne Ergebnis', art: 'fr', nurAbrechenbar: false, stufeIntern: 1, stufeBillable: 2,
    woerter: 'versucht*, probiert*, ausprobiert*, rumprobiert*, rumgespielt*, herumgespielt*, keine ahnung, irgendwie, trial and error, tried, trying to, playing around, attempt*, no idea, somehow, guesswork',
    tipp: 'Vorgehen und Ergebnis beschreiben: was wurde geprüft, was kam heraus.',
  },
  F_nacharbeit: {
    name: 'Nacharbeit / eigener Fehler', art: 'fr', nurAbrechenbar: true, stufeIntern: null, stufeBillable: 2,
    woerter: 'rework, nochmal*, noch mal, nachbesser*, redo, vergessen*, forgot*, versehentlich*, accidentally, mein fehler, eigener fehler, unser fehler, fehler von mir, my mistake, own mistake, our mistake, my fault, our fault, by mistake, mistakenly, once more, had to redo',
    tipp: 'Nacharbeit wegen eigener Fehler nicht dem Kunden berechnen; sonst den Anlass sachlich beschreiben.',
  },
  F_warten: {
    name: 'Warten / Bereitschaft', art: 'fr', nurAbrechenbar: false, stufeIntern: 1, stufeBillable: 3,
    woerter: 'warten, gewartet, wartezeit, waiting, wait for, standby, stand by, stand-by, bereitschaft, leerlauf, idle, keine aufgaben, nichts zu tun, no tasks, waiting time, awaiting, on hold, nothing to do, no work assigned',
    tipp: 'Wartezeit nur buchen, wenn vertraglich vereinbart; sonst die erledigte Arbeit beschreiben.',
  },
  F_lernen: {
    name: 'Lernen / Einarbeitung auf Kundenkonto', art: 'fr', nurAbrechenbar: true, stufeIntern: null, stufeBillable: 2,
    woerter: 'einarbeitung, eingearbeitet, einlesen, eingelesen, self study, self-study, selbststudium, learning hub, sap learning, learning journey, tutorial, zertifizierungsvorbereitung, certification prep*, exam prep*, lernen, gelernt, familiari*, getting familiar, getting up to speed, ramp-up, ramp up, reading up, self-learning, self learning, e-learning, certification exam',
    tipp: 'Einarbeitung und Weiterbildung auf das interne Trainingskonto buchen, außer sie ist mit dem Kunden vereinbart.',
  },
  F_intern: {
    name: 'Interne Tätigkeit auf Kundenkonto', art: 'fr', nurAbrechenbar: true, stufeIntern: null, stufeBillable: 1,
    woerter: 'zeiterfassung, zeiten buchen, zeiten gebucht, timesheet, time sheet, time recording, time tracking, interne abstimmung*, interne absprache*, interne besprechung*, internes meeting, internal alignment, internal meeting, internal discussion, halbjahresgespräch, mitarbeitergespräch, townhall, recruiting, bewerbungsgespräch, internal sync, internal call, internal coordination, internal handover, internal review, performance review, job interview, all hands, timesheets, time booking, booking hours',
    tipp: 'Interne Tätigkeiten auf das passende interne Konto buchen.',
  },
  F_ton: {
    name: 'Umgangssprache / Wertung', art: 'fr', nurAbrechenbar: false, stufeIntern: 1, stufeBillable: 2,
    woerter: 'chaos, mist, nervig, genervt, sinnlos, ärger*, mal wieder, wie immer, katastrophe, desaster, keine lust, sucks, crap, annoying, pointless, useless, nightmare, as always, once again, wtf, damn, re:\\?\\?+, re:!!!+',
    tipp: 'Sachlich formulieren – der Text kann beim Kunden auf der Rechnung stehen.',
  },
};

export const STANDARD_EINSTELLUNGEN: Einstellungen = {
  toleranz: 0.25,
  bundesland: 'BW',
  errorAccounts: 'Unknown - please review\nATG Error Account\nATG-Clean Up Account',
  accountPflichtAb: '',
  regelwerkAn: true,
  regelwerkAb: '2026-11-01',
  regelwerkMinWoerter: 5,
  regelwerkIdBillable: true,
  regelwerkOhneIdMuster: 'WCMS',
  wiederholungTage: 5,
  wiederholungMinH: 8,
  langerTag: 10,
  langeBuchung: 8,
  duennH: 4,
  duennWoerter: 3,
  aliasse: 'GT = Grant Thornton\nR-Bio = R-Biopharm\nRBio = R-Biopharm\nEbner Stolz = RSM\nEbnerStolz = RSM\nKLV = Kelvion\nqbeyond = q.beyond',
  allgemeinZusatz: '',
  regeltermine: 'daily, weekly, bi-weekly, biweekly, jour fixe, jf, regeltermin, standup, stand-up, status meeting, statusmeeting, teammeeting, team meeting, townhall, retro, sprint review, sprintplanung, sprint planning, all hands, knowledge cafe',
  feiertage: '',
  internMuster: 'W??INT*',
  aus: {},
  wortRegeln: STANDARD_WORTREGELN,
};

export interface RegelBeschreibung {
  id: string;
  kategorie: Kategorie;
  art: Art;
  name: string;
  erkennung: string;
  tipp: string;
}

const R = (id: string, kategorie: Kategorie, art: Art, name: string, erkennung: string, tipp: string): RegelBeschreibung =>
  ({ id, kategorie, art, name, erkennung, tipp });

/** Alle Regeln in Anzeigereihenfolge (F-Regeln mit den Standard-Wortlisten) */
export const REGELN: RegelBeschreibung[] = [
  R('K1', 'K', 'ko', 'Error-Account gebucht', 'Der Account steht in der Liste der Error-Accounts oder heißt „Error Account“, „please review“ oder „Clean up Account“.', 'Auf den richtigen Account umbuchen; bei Unklarheit Projektleitung fragen.'),
  R('K2', 'K', 'ko', 'Kein Account', 'Die Buchung hat keinen Account (ab dem Datum der Account-Pflicht, Abwesenheiten ausgenommen).', 'Ticket einem Account zuordnen lassen oder auf das passende interne Konto umbuchen.'),
  R('K3', 'K', 'ko', 'Ticket auf mehreren Accounts', 'Dasselbe Ticket läuft sonst überwiegend auf einem anderen Account mit anderem Kunden oder anderer Abrechenbarkeit.', 'Prüfen, ob der seltenere Account stimmt; sonst umbuchen.'),
  R('K4', 'K', 'ko', 'Ticket bei untypischem Kunden', 'Tickets dieses Jira-Projekts laufen zu mindestens 85 % (ab 16 h) auf einen Kunden, diese Buchung auf einen anderen oder ein internes Konto.', 'Kunde und Account prüfen; interne Kontierung eines Kundentickets ist möglicherweise verlorener Umsatz.'),
  R('K5', 'K', 'ko', 'Text nennt anderen Kunden', 'Der Text nennt einen Kunden aus dem Datenbestand, die Buchung liegt aber auf einem anderen Kunden oder internen Konto.', 'Account prüfen; bei Kundenarbeit auf internem Konto möglicherweise abrechenbar.'),
  R('K6', 'K', 'ko', 'Abwesenheit / Privates auf Arbeitskonto', 'Der Text nennt Urlaub, Krankheit, Arzt, Pause o. Ä., gebucht ist aber auf ein Arbeitskonto.', 'Abwesenheit als Abwesenheit erfassen; Pausen nicht buchen.'),
  R('K7', 'K', 'ko', 'Reisezeit auf Kundenkonto', 'Ein abrechenbarer Eintrag nennt Reise, Anfahrt oder Flug, der Account ist kein Reisezeit-Konto.', 'Reisezeit-Regel des Vertrags prüfen und ggf. auf das Reisezeit-Konto buchen.'),
  R('K8', 'K', 'ko', 'Kundenarbeit auf internem Projekt', 'Eine Buchung auf einem internen Projekt nennt ein Kundenticket oder einen Kundennamen.', 'Prüfen, ob die Zeit auf das Kundenprojekt gehört (abrechenbar oder dessen Non-billable-Account). Echte interne Themen (Angebot, Staffing, Eskalation) so benennen.'),
  R('P1', 'P', 'pl', 'Tag mit sehr vielen Stunden', 'Die Tagessumme liegt über der Grenze für lange Tage (Standard 10 h).', 'Prüfen, ob Stunden doppelt oder am falschen Tag gebucht sind.'),
  R('P2', 'P', 'pl', 'Lange Einzelbuchung', 'Eine einzelne Buchung an einem Tag liegt über der Grenze (Standard 8 h).', 'Lange Blöcke aufteilen und je Tätigkeit beschreiben.'),
  R('P3', 'P', 'pl', 'Buchung an freiem Tag', 'Arbeitszeit an einem Feiertag, Wochenende oder sonst freien Tag der Person.', 'Nur zur Info: Datum prüfen, Mehrarbeit ggf. freigeben.'),
  R('T1', 'T', 'ns', 'Leer oder Platzhalter', 'Kein Text oder nur ein Platzhalter wie „x“, „tbd“, „siehe oben“, „dito“.', 'Jede Buchung braucht eine eigene Beschreibung.'),
  R('T2', 'T', 'ns', 'Nur Kürzel oder Ticketnummer', 'Der Text besteht nur aus IDs, Ticketnummern oder Kürzeln.', 'Hinter die ID schreiben, was getan wurde: z. B. „Fehler in Preisfindung analysiert, Korrektur getestet“.'),
  R('T3', 'T', 'ns', 'Nur Allgemeinbegriffe', 'Der Text enthält nur Allgemeinbegriffe wie Meeting, Abstimmung, Support, Analyse, ohne konkreten Gegenstand.', 'Gegenstand und Ergebnis ergänzen: z. B. „Abstimmung Mahnlauf mit Buchhaltung, Customizing angepasst“.'),
  R('T3b', 'T', 'ns', 'ID, aber Tätigkeit allgemein', 'Neben einer ID oder einem Kürzel stehen nur Allgemeinbegriffe.', 'Nach der ID die konkrete Tätigkeit nennen.'),
  R('T9', 'T', 'ns', 'Nur Personenname', 'Der Text nennt nur Vornamen von Kolleginnen und Kollegen, aber kein Thema.', 'Thema der Absprache nennen: z. B. „Abstimmung mit Ole zur Schnittstelle Lieferavis“.'),
  R('T4', 'T', 'fr', 'Kalender- oder Mailtext kopiert', 'Der Text enthält typische Teile von Einladungen oder Mails (Hallo zusammen, Von:, Teams-Besprechung …).', 'Nur den Termin-Titel plus Ergebnis: z. B. „Statusmeeting Rollout – offene Punkte priorisiert“. Einladungstexte gehören nicht auf die Rechnung.'),
  R('T5', 'T', 'ns', 'Kurzer Text für lange Buchung', 'Sehr wenige Wörter für viele Stunden an einem Tag (Standard: höchstens 3 Wörter ab 4 h, höchstens 2 Wörter ab 2 h).', 'Bei langen Blöcken die Teilschritte nennen, ab 4 h mindestens zwei konkrete Punkte.'),
  R('T6', 'T', 'ns', 'Gleicher Text an vielen Tagen', 'Derselbe Text steht an vielen Tagen mit vielen Stunden (Standard ab 5 Tagen und 8 h), Regeltermine ausgenommen.', 'Pro Tag beschreiben, was neu war: z. B. „Testfälle 12–18 durchgeführt, 2 Fehler gemeldet“.'),
  R('T8', 'T', 'ns', 'Text wiederholt nur den Account', 'Der Text entspricht im Wesentlichen dem Namen des Accounts.', 'Der Account sagt schon, wofür; der Text soll sagen, was genau.'),
  ...Object.entries(STANDARD_WORTREGELN).map(([id, w]) =>
    R(id, 'T', w.art, w.name, `Der Text enthält einen Begriff aus der Wortliste „${w.name}“${w.nurAbrechenbar ? ' (nur abrechenbare Einträge)' : ''}.`, w.tipp)),
  R('R1', 'R', 're', 'Regelwerk: zu wenige Wörter', 'Nach der führenden ID stehen weniger Wörter als vom Regelwerk verlangt (Standard 5); Regeltermine ausgenommen.', 'Kurz, klar, spezifisch: mindestens fünf Wörter.'),
  R('R2', 'R', 're', 'Regelwerk: ID am Anfang fehlt', 'Ein abrechenbarer Text beginnt nicht mit einer ID (z. B. „ID: “, „<ID> “, „<<ID>> “, „[ID] – “); Regeltermine und AMS-Tickets ausgenommen.', 'Format „<ID>: Beschreibung mit mehr als fünf Wörtern“.'),
];

/** fehlende Felder mit dem Standard füllen (Wortregeln je Regel zusammenführen) */
export function einstellungenErgaenzen(teil: Partial<Einstellungen> | null): Einstellungen {
  const t = (teil ?? {}) as Partial<Einstellungen>;
  const e: Einstellungen = { ...STANDARD_EINSTELLUNGEN };
  for (const k of Object.keys(STANDARD_EINSTELLUNGEN) as (keyof Einstellungen)[]) {
    const v = t[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== typeof STANDARD_EINSTELLUNGEN[k]) continue;
    (e as unknown as Record<string, unknown>)[k] = v;
  }
  e.aus = { ...(t.aus && typeof t.aus === 'object' ? t.aus : {}) };
  const wr: Record<string, WortRegel> = {};
  for (const [id, std] of Object.entries(STANDARD_WORTREGELN)) wr[id] = { ...std, ...(t.wortRegeln?.[id] ?? {}) };
  for (const [id, w] of Object.entries(t.wortRegeln ?? {})) if (!wr[id] && w && typeof w === 'object') wr[id] = { ...STANDARD_WORTREGELN.F_pauschal, ...w };
  e.wortRegeln = wr;
  return e;
}
