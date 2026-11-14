/**
 * E-Mail-Texte des Vereins vorbelegen (#232): Administration → Einstellungen → TC Oberthal → E-Mail-Texte.
 *
 * Jeder Anlass, zu dem das Portal eine E-Mail verschickt, steht hier im Verzeichnis – mit Standardtext und den
 * Platzhaltern, die beim Versand ersetzt werden. Legt der Verein einen eigenen Text fest (tco.mailtexte), gilt dieser:
 * als fester Text automatischer E-Mails und als Vorbelegung dort, wo der Text vor dem Senden noch änderbar ist
 * (Einladung, Zugangslink). Ohne eigenen Text bleibt alles wie bisher.
 *
 * Neuer Anlass: hier eintragen und an der Sendestelle mailtext() bzw. mailtextEigen() verwenden.
 */
import { BusinessError } from '../../../server/src/errors.js';
import type { Db, Verein } from './verein.js';
import type { Art } from './mitglieder/pdf.js';
import { mailText as unterlagenText, unterlagenZeilen } from './mitglieder/dokumente.js';
import { einladungVorlage } from './mitglieder/einladung.js';
import { vorlage as zugangVorlage } from './mitglieder/zugangslink.js';

export interface MailVorlage { betreff: string; text: string }
export interface MailtextDef {
  schluessel: string;
  /** Fachbereich, unter dem der Text in den Einstellungen steht */
  bereich: string;
  name: string;
  /** wann die E-Mail verschickt wird */
  wann: string;
  /** Platzhalter (ohne Klammern) → Bedeutung */
  platzhalter: Record<string, string>;
  /** Platzhalter, die im Text stehen müssen, damit die E-Mail ihren Zweck erfüllt (z. B. der persönliche Link) */
  pflicht?: string[];
  standard: (v: Verein) => MailVorlage;
}

/** Standardtext der abgelehnten Kündigung – mit Platzhaltern */
export const kuendigungAbgelehntVorlage = (v: Verein): MailVorlage => ({
  betreff: `${v.name}: Ihre Kündigung vom {Eingang}`,
  text: `Hallo {Vorname},\n\nIhre Kündigung vom {Eingang} konnten wir nicht freigeben.\n\nEingereicht: {Eingereicht}\nGrund: {Grund}\n\nBei Fragen melden Sie sich bitte beim Vorstand.\n\n${v.name}`,
});

/** Standardtext der Einladung zu einer Veranstaltung (Vereinskalender → Veranstaltung → Einladen) – mit Platzhaltern */
export const kalenderEinladungVorlage = (v: Verein): MailVorlage => ({
  betreff: `${v.name}: Einladung – {Titel}`,
  text: 'Hallo {Vorname},\n\nwir laden herzlich ein:\n\n{Titel}\n{Termin}\n{Ort}\n\n{Anmeldeschluss}\n\n'
    + 'Über diesen Link melden Sie sich im Vereinsportal an oder ab:\n\n{Link}\n\n{Zugang}\n\n'
    + `Viele Grüße\n${v.ansprechpartner || v.name}`,
});

const UNTERLAGE = { Vorname: 'Vorname des Mitglieds', Unterlagen: 'Liste der Unterlagen mit ihren Links (leer, wenn die Unterlage als Anhang mitgeht)' };
const unterlage = (art: '' | '1' | '2' | '3' | '4' | '5', name: string, wann: string): MailtextDef => ({
  schluessel: `mitglied.unterlage.${art || '0'}`, bereich: 'Mitglieder', name, wann, platzhalter: UNTERLAGE,
  standard: (v) => unterlagenText(v, art, '{Vorname}', [], '{Unterlagen}'),
});

export const MAILTEXTE: MailtextDef[] = [
  // (Namen und Standardtexte bewusst erst beim Aufruf ermittelt – das Verzeichnis hängt an keinem Ladezeitpunkt anderer Dateien)
  unterlage('1', 'Aufnahmebestätigung', 'Mitglieder → Unterlagen versenden; Übernahme eines Mitgliedsantrags'),
  unterlage('2', 'Mitgliederinformation', 'Mitglieder → Unterlagen versenden; nach Beitragswechsel und Anmeldung zum Jugendtraining'),
  unterlage('3', 'Mitgliedschaftsbestätigung', 'Mitglieder → Unterlagen versenden'),
  unterlage('4', 'Kündigungsbestätigung', 'nach der Freigabe einer Kündigung (Arbeitsvorrat → An das Mitglied senden); Austritt in der Mitgliederpflege'),
  unterlage('5', 'SEPA-Lastschriftmandat', 'Mitglieder → Unterlagen versenden'),
  unterlage('', 'Mitgliederunterlagen (mehrere oder ohne Art)', 'Mitglieder → Dokumente per E-Mail senden'),
  {
    schluessel: 'mitglied.kuendigung.abgelehnt', bereich: 'Mitglieder', name: 'Kündigung nicht freigegeben', wann: 'Arbeitsvorrat → Kündigung ablehnen',
    platzhalter: { Vorname: 'Vorname des Mitglieds', Eingang: 'Datum, an dem die Kündigung einging', Eingereicht: 'was gekündigt werden sollte', Grund: 'Grund der Ablehnung' },
    pflicht: ['Grund'], standard: (v) => kuendigungAbgelehntVorlage(v),
  },
  {
    schluessel: 'mitglied.einladung', bereich: 'Zugang zum Portal', name: 'Einladung zum Vereinsportal',
    wann: 'Mitglieder → Einladen (Vorbelegung im Dialog, dort noch änderbar); Registrierung eines bekannten Mitglieds (fester Text)',
    platzhalter: { Vorname: 'Vorname', Name: 'Vor- und Nachname', Link: 'persönlicher Link', GueltigBis: 'Ende der Gültigkeit' },
    pflicht: ['Link'], standard: (v) => einladungVorlage(v),
  },
  {
    schluessel: 'mitglied.zugangslink', bereich: 'Zugang zum Portal', name: 'Zugangslink (neues Kennwort)',
    wann: 'Mitglieder → Zugangslinks senden (Vorbelegung im Dialog, dort noch änderbar)',
    platzhalter: { Vorname: 'Vorname', Name: 'Vor- und Nachname', Benutzername: 'Benutzername im Portal', Link: 'persönlicher Link', GueltigBis: 'Ende der Gültigkeit' },
    pflicht: ['Link'], standard: (v) => zugangVorlage(v),
  },
  // ---- Mitgliedsantrag (automatische E-Mails; die Werte setzt die Sendestelle in antrag/routes.ts)
  {
    schluessel: 'antrag.eingang', bereich: 'Mitgliedsantrag', name: 'Antrag eingegangen', wann: 'sofort nach dem Online-Mitgliedsantrag',
    platzhalter: { Name: 'Antragsteller bzw. Erziehungsberechtigte', Personen: 'Namen der angemeldeten Personen', Nummer: 'Antragsnummer' },
    standard: (v) => ({
      betreff: `${v.name}: Ihr Mitgliedsantrag {Nummer} ist eingegangen`,
      text: 'Guten Tag {Name},\n\nvielen Dank für Ihren Mitgliedsantrag ({Personen}). Ihre Antragsnummer: {Nummer}.\n\n'
        + 'Der Vorstand prüft den Antrag. Nach der Aufnahme erhalten Sie eine Bestätigung und die Zugangsdaten zum Mitgliederportal per E-Mail.\n\n'
        + `Viele Grüße\n${v.name}`,
    }),
  },
  {
    schluessel: 'antrag.willkommen', bereich: 'Mitgliedsantrag', name: 'Antrag angenommen (Willkommen)', wann: 'Mitgliedsanträge → Übernehmen (neue Mitglieder)',
    platzhalter: { Name: 'Antragsteller', Nummer: 'Antragsnummer', Mitglieder: 'je Person eine Zeile „Name: Mitgliedsnummer …“', Mandat: 'Satz zum SEPA-Lastschriftmandat (leer ohne Mandat)' },
    standard: (v) => ({
      betreff: `${v.name}: Willkommen im Verein – Ihr Antrag {Nummer} ist angenommen`,
      text: 'Guten Tag {Name},\n\nherzlich willkommen! Ihr Mitgliedsantrag {Nummer} wurde angenommen.\n\n{Mitglieder}\n\n{Mandat}\n\n'
        + `Die Zugänge zum Mitgliederportal erhalten Sie in separaten E-Mails.\n\nViele Grüße\n${v.name}`,
    }),
  },
  {
    schluessel: 'antrag.aenderung', bereich: 'Mitgliedsantrag', name: 'Vertragsänderung bestätigt', wann: 'Mitgliedsanträge → Übernehmen (nur bestehende Mitglieder)',
    platzhalter: { Name: 'Antragsteller', Nummer: 'Antragsnummer', Mitglieder: 'je Person eine Zeile „Name: Mitgliedsnummer …“', Mandat: 'Satz zum SEPA-Lastschriftmandat (leer ohne Mandat)' },
    standard: (v) => ({
      betreff: `${v.name}: Ihre Vertragsänderung {Nummer} ist bestätigt`,
      text: `Guten Tag {Name},\n\nvielen Dank – Ihre Vertragsänderung {Nummer} wurde übernommen.\n\n{Mitglieder}\n\n{Mandat}\n\nViele Grüße\n${v.name}`,
    }),
  },
  {
    schluessel: 'antrag.abgelehnt', bereich: 'Mitgliedsantrag', name: 'Antrag abgelehnt', wann: 'Mitgliedsanträge → Ablehnen (mit E-Mail)',
    platzhalter: { Name: 'Antragsteller', Nummer: 'Antragsnummer', Begruendung: 'Zeile „Begründung: …“ (leer ohne Begründung)' },
    standard: (v) => ({
      betreff: `${v.name}: Ihr Mitgliedsantrag {Nummer}`,
      text: 'Guten Tag {Name},\n\nIhr Mitgliedsantrag {Nummer} konnte leider nicht angenommen werden.\n\n{Begruendung}\n\n'
        + `Bei Fragen wenden Sie sich bitte an den Vorstand.\n\nViele Grüße\n${v.name}`,
    }),
  },
  // ---- Registrierung (platz/routes.ts)
  {
    schluessel: 'registrierung.eingegangen', bereich: 'Registrierung', name: 'Registrierung eingegangen', wann: 'nach einer Registrierung, die der Verein erst prüft',
    platzhalter: { Name: 'Vor- und Nachname', Benutzername: 'gewählter Benutzername', Pruefung: 'Satzanfang „Wir prüfen Ihre Mitgliedschaft“ bzw. „Wir prüfen Ihre Angaben“' },
    standard: (v) => ({
      betreff: `${v.name}: Ihre Registrierung ist eingegangen`,
      text: 'Guten Tag {Name},\n\nvielen Dank für Ihre Registrierung (Benutzername {Benutzername}). {Pruefung} und benachrichtigen Sie, sobald Ihr Zugang freigeschaltet ist.\n\n'
        + `Viele Grüße\n${v.name}`,
    }),
  },
  {
    schluessel: 'registrierung.bestaetigen', bereich: 'Registrierung', name: 'E-Mail-Adresse bestätigen (Hallennutzer)', wann: 'nach der Registrierung eines externen Hallennutzers; Mailprotokoll → Erneut senden',
    platzhalter: { Name: 'Vor- und Nachname', Benutzername: 'gewählter Benutzername', Stunden: 'Gültigkeit des Links in Stunden', Link: 'persönlicher Bestätigungslink' },
    pflicht: ['Link'],
    standard: (v) => ({
      betreff: `${v.name}: Bitte bestätigen Sie Ihre Registrierung`,
      text: 'Guten Tag {Name},\n\nvielen Dank für Ihre Registrierung (Benutzername {Benutzername}). '
        + 'Bitte bestätigen Sie Ihre E-Mail-Adresse über diesen Link ({Stunden} Stunden gültig):\n\n{Link}\n\n'
        + 'Danach ist Ihr Zugang sofort freigeschaltet und Sie können Hallen- und Freiplätze buchen.\n\n'
        + `Haben Sie sich nicht registriert, ignorieren Sie diese E-Mail – ohne Bestätigung wird nichts angelegt.\n\nViele Grüße\n${v.name}`,
    }),
  },
  {
    schluessel: 'registrierung.freigeschaltet', bereich: 'Registrierung', name: 'Zugang freigeschaltet', wann: 'Registrierungen → Freischalten',
    platzhalter: {
      Name: 'Anzeigename', Adresse: '„ unter <Portal-Adresse>“ – mit führendem Leerzeichen, leer ohne Portal-Adresse',
      Kennwort: 'Satzende zum Kennwort (bisheriges EP3-Kennwort bzw. bei der Registrierung gewähltes)', Hinweis: 'Satz für Mitglieder bzw. für Hallennutzer',
    },
    standard: (v) => ({
      betreff: `${v.name}: Ihr Zugang ist freigeschaltet`,
      text: `Guten Tag {Name},\n\nIhr Zugang zum Portal ist freigeschaltet. Sie können sich jetzt{Adresse} anmelden – {Kennwort}\n\n{Hinweis}\n\nViele Grüße\n${v.name}`,
    }),
  },
  {
    schluessel: 'registrierung.abgelehnt', bereich: 'Registrierung', name: 'Registrierung abgelehnt', wann: 'Registrierungen → Ablehnen',
    platzhalter: { Name: 'Anzeigename', Begruendung: 'Zeile „Begründung: …“ (leer ohne Begründung)' },
    standard: (v) => ({
      betreff: `${v.name}: Ihre Registrierung`,
      text: 'Guten Tag {Name},\n\nIhre Registrierung konnte leider nicht freigeschaltet werden.\n\n{Begruendung}\n\n'
        + `Bei Fragen wenden Sie sich bitte an den Verein.\n\nViele Grüße\n${v.name}`,
    }),
  },
  // ---- Schnuppertraining (schnupper/routes.ts)
  {
    schluessel: 'schnupper.eingang', bereich: 'Schnuppertraining', name: 'Anmeldung eingegangen', wann: 'sofort nach der Online-Anmeldung zum Schnuppertraining',
    platzhalter: { Name: 'Vorname bzw. Erziehungsberechtigte', Kind: '„ von <Vorname Nachname>“ – mit führendem Leerzeichen, leer bei eigener Anmeldung', Einheiten: 'Zahl der kostenlosen Einheiten', Nummer: 'Nummer der Anmeldung' },
    standard: (v) => ({
      betreff: `${v.name}: Deine Anmeldung zum Schnuppertraining ({Nummer})`,
      text: 'Hallo {Name},\n\nvielen Dank für die Anmeldung{Kind} zum Schnuppertraining.\n\n'
        + 'Wir bieten {Einheiten} Einheiten Schnuppertraining kostenlos an. Einer unserer Vereinstrainer meldet sich in den nächsten Tagen, '
        + 'um einen Termin abzustimmen. Danach bieten wir gerne an, einer Trainingsgruppe beizutreten.\n\n'
        + 'Die Kontaktdaten nutzen wir nur für die Kontaktaufnahme zum Schnuppertraining.\n\n'
        + `Viele Grüße\n${v.name}`,
    }),
  },
  {
    schluessel: 'schnupper.beitritt', bereich: 'Schnuppertraining', name: 'Beitrittslink nach dem Schnuppertraining', wann: 'Schnuppertraining → Beitrittslink senden',
    platzhalter: { Name: 'Vorname bzw. Erziehungsberechtigte', Dabei: '„du beim Schnuppertraining dabei warst“ bzw. „<Vorname> beim Schnuppertraining dabei war“', Link: 'persönlicher Beitrittslink' },
    pflicht: ['Link'],
    standard: (v) => ({
      betreff: `${v.name}: Jetzt Mitglied werden`,
      text: 'Hallo {Name},\n\nschön, dass {Dabei}! '
        + 'Wenn es gefallen hat, geht die Anmeldung als Mitglied (und zu einer Trainingsgruppe) ganz einfach – die bekannten Angaben sind schon eingetragen:\n\n'
        + `{Link}\n\nViele Grüße\n${v.name}`,
    }),
  },
  {
    schluessel: 'kalender.einladung', bereich: 'Vereinskalender', name: 'Einladung zu einer Veranstaltung',
    wann: 'Vereinskalender → Veranstaltung → Einladen (Vorbelegung im Dialog, dort noch änderbar)',
    platzhalter: {
      Vorname: 'Vorname (bei gemeinsamer E-Mail-Adresse einer Familie alle Vornamen)', Titel: 'Titel der Veranstaltung', Termin: 'Wochentag, Datum und Uhrzeit',
      Ort: 'Zeile „Ort: …“ (leer ohne Ort)', Anmeldeschluss: 'Satz mit dem Anmeldeschluss (leer ohne Anmeldeschluss)', Link: 'Link zur Veranstaltung im Portal',
      Zugang: 'Hinweis auf die Registrierung – nur für Empfänger ohne Zugang zum Portal, sonst leer',
    },
    pflicht: ['Link'], standard: (v) => kalenderEinladungVorlage(v),
  },
];

const def = (schluessel: string): MailtextDef => {
  const d = MAILTEXTE.find((x) => x.schluessel === schluessel);
  if (!d) throw new BusinessError('Diesen E-Mail-Text gibt es nicht.', 404);
  return d;
};

/** eigener Text des Vereins – null, wenn keiner festgelegt ist */
export async function mailtextEigen(db: Db, schluessel: string): Promise<MailVorlage | null> {
  const [r] = await db`select betreff, text from tco.mailtexte where schluessel = ${schluessel}`;
  return r ? { betreff: r.betreff as string, text: r.text as string } : null;
}

/** Vorbelegung: der eigene Text, sonst der Standardtext – beides mit Platzhaltern */
export async function mailtextVorlage(db: Db, v: Verein, schluessel: string): Promise<MailVorlage> {
  return (await mailtextEigen(db, schluessel)) ?? def(schluessel).standard(v);
}

/** Platzhalter {Name} ersetzen; leere Blöcke hinterlassen keine Lücke aus Leerzeilen */
export function fuellen(vorlage: string, werte: Record<string, string>): string {
  return vorlage.replace(/\{([A-Za-z]+)\}/g, (ganz, k: string) => (k in werte ? werte[k] : ganz)).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Text einer automatischen E-Mail, deren Standardtext im Verzeichnis steht: eigener Text des Vereins, sonst der
 * Standardtext – mit den Werten der Sendestelle gefüllt. Bedingte Teile (Begründung, Mandat …) liefert die Sendestelle als Wert.
 */
export async function mailtextFuellen(db: Db, v: Verein, schluessel: string, werte: Record<string, string>): Promise<MailVorlage> {
  const t = await mailtextVorlage(db, v, schluessel);
  return { betreff: fuellen(t.betreff, werte), text: fuellen(t.text, werte) };
}

/**
 * Text einer automatischen E-Mail: Hat der Verein einen eigenen Text festgelegt, wird er mit den Werten gefüllt –
 * sonst gilt der Text, den die Sendestelle wie bisher erzeugt hat (standard).
 */
export async function mailtext(db: Db, schluessel: string, werte: Record<string, string>, standard: MailVorlage): Promise<MailVorlage> {
  def(schluessel);
  const eigen = await mailtextEigen(db, schluessel);
  return eigen ? { betreff: fuellen(eigen.betreff, werte), text: fuellen(eigen.text, werte) } : standard;
}

/** Text einer Unterlagen-Mail (Aufnahme, Kündigungsbestätigung …): eigener Text des Vereins, sonst der Standardtext */
export function unterlagenMail(db: Db, v: Verein, art: Art | '', vorname: string, links: { titel: string; link: string }[]): Promise<MailVorlage> {
  return mailtext(db, `mitglied.unterlage.${art || '0'}`, { Vorname: vorname || 'zusammen', Unterlagen: unterlagenZeilen(links).join('\n') }, unterlagenText(v, art, vorname, links));
}

/** Verzeichnis für die Einstellungen: je Anlass Standardtext, eigener Text und Platzhalter */
export async function mailtexteLesen(db: Db, v: Verein) {
  const eigene = new Map((await db`select schluessel, betreff, text, geaendert_von, to_char(geaendert_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am from tco.mailtexte`)
    .map((r) => [r.schluessel as string, r]));
  return MAILTEXTE.map((d) => {
    const e = eigene.get(d.schluessel);
    return {
      schluessel: d.schluessel, bereich: d.bereich, name: d.name, wann: d.wann, pflicht: d.pflicht ?? [],
      platzhalter: Object.entries(d.platzhalter).map(([name, text]) => ({ name, text })),
      standard: d.standard(v), eigen: e ? { betreff: e.betreff as string, text: e.text as string } : null,
      geaendert: e ? { von: e.geaendert_von as string, am: e.am as string } : null,
    };
  });
}

export async function mailtextSichern(tx: Db, schluessel: string, t: MailVorlage, wer: string): Promise<void> {
  const d = def(schluessel);
  if (!t.betreff.trim() || !t.text.trim()) throw new BusinessError('Bitte Betreff und Text angeben.');
  const fehlt = (d.pflicht ?? []).filter((p) => !t.text.includes(`{${p}}`));
  if (fehlt.length) throw new BusinessError(`Im Text ${fehlt.length === 1 ? 'fehlt der Platzhalter' : 'fehlen die Platzhalter'} ${fehlt.map((p) => `{${p}}`).join(', ')}.`);
  const unbekannt = [...new Set([...`${t.betreff}\n${t.text}`.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]))].filter((k) => !(k in d.platzhalter));
  if (unbekannt.length) throw new BusinessError(`Unbekannte Platzhalter: ${unbekannt.map((k) => `{${k}}`).join(', ')}. Möglich sind ${Object.keys(d.platzhalter).map((k) => `{${k}}`).join(', ')}.`);
  await tx`insert into tco.mailtexte (schluessel, betreff, text, geaendert_am, geaendert_von) values (${schluessel}, ${t.betreff.trim()}, ${t.text.trim()}, now(), ${wer})
           on conflict (schluessel) do update set betreff = excluded.betreff, text = excluded.text, geaendert_am = now(), geaendert_von = excluded.geaendert_von`;
}

/** zurück zum Standardtext */
export async function mailtextLoeschen(tx: Db, schluessel: string): Promise<void> {
  def(schluessel);
  await tx`delete from tco.mailtexte where schluessel = ${schluessel}`;
}
