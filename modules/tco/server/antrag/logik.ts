import { BusinessError } from '../../../../server/src/errors.js';
import { ibanGueltig, normalisieren } from '../../../../server/src/lib/sepa.js';
import type { Db, Verein } from '../verein.js';
import { condense, heute } from '../format.js';
import { emailGueltig, mitgliedNeu, normName, vertragsarten, type Neu } from '../mitglieder/logik.js';
import { mitgliederBenutzerAnlegen } from '../mitglieder/selbst.js';
import { adrnrZumToken, alsMitgliedMarkieren, schnupperFuerPerson } from '../schnupper/logik.js';

/**
 * Online-Mitgliedsantrag (#12): öffentliches Formular ohne Anmeldung, auch für Familien (mehrere Personen,
 * ein Beitragszahler). Die Einzugsermächtigung (SEPA) wird online erteilt. Anträge landen im Eingang; erst die
 * Übernahme durch den Vorstand legt Mitglieder, Verträge, SEPA-Mandat und die Portalbenutzer (Rolle Mitglied) an.
 */
export interface Person {
  anrede: string; vorname: string; nachname: string; geburtsdatum: string; email?: string | null; telefon?: string | null; mobil?: string | null;
  /** Mitgliedschaft (Beitragsart < 90) – genau eine; bei weiteren Personen eines Familienantrags leer (über den Familienbeitrag) */
  art?: string | null;
  /** Trainingseinheiten (Jugendtraining, Art 90 bzw. „…training“) – bis zu 2, je Einheit ein Vertrag */
  training?: string[];
}
export interface AntragDaten {
  personen: Person[];
  strasse: string; plz: string; ort: string;
  /** Kontakt des Antragstellers (erste Person) */
  email: string; telefon?: string | null;
  /** Erziehungsberechtigte(r), wenn die erste Person minderjährig ist */
  erziehungsberechtigt?: string | null;
  eintritt: string;
  satzung: boolean; datenschutz: boolean; bildrechte: boolean;
  /** Kündigungsfristen zur Kenntnis genommen (Mitgliedschaft 4 Wochen zum Jahresende, Training zum 30.09.) */
  kuendigung: boolean;
  bemerkung?: string | null;
  /** Beitrittslink aus dem Schnuppertraining (#86): Token beim Absenden, gespeichert wird der Stammsatz */
  schnupper?: string | null;
  schnupper_adrnr?: string | null;
}

export const MAX_TRAINING = 2;
/** Alter, ab dem kein Jugendbeitrag mehr möglich ist bzw. bis zu dem Jugendtraining angeboten wird (am Eintrittsdatum) */
export const ALTER_JUGENDBEITRAG_BIS = 17;
export const ALTER_TRAINING_BIS = 21;
export const KUENDIGUNG_TEXT = 'Die Vereinsmitgliedschaft kann mit einer Frist von 4 Wochen zum Jahresende gekündigt werden, '
  + 'die Teilnahme am Training zum 30.09. eines jeden Jahres.';

export type Kategorie = 'MITGLIEDSCHAFT' | 'TRAINING';
/** Mitgliedschaft: Art < 90; Training: Art 90 oder Bezeichnung mit „Training“ (ab 90); übrige (z. B. Spende, „Inaktiv“) nicht im Antrag */
export function kategorieVon(art: string, name: string): Kategorie | null {
  const n = Number(art);
  // nicht online angeboten: inaktive Mitgliedschaft (Wechsel nur über den Vorstand)
  if (/inaktiv/i.test(name)) return null;
  if (/training/i.test(name) || art === '90') return 'TRAINING';
  if (Number.isFinite(n) && n < 90) return 'MITGLIEDSCHAFT';
  return null;
}
export const istJugendbeitrag = (name: string) => /jugend/i.test(name);

/**
 * Vertragsbeginn = erste Fälligkeit: Mitgliedsbeiträge zum nächsten 1.1. bzw. 1.7., Training zum nächsten Monatsbeginn
 * (jeweils der Eintritt selbst, wenn er auf diesen Tag fällt) – wie im Formular angezeigt.
 */
export function beginnFuer(eintritt: string, kategorie: Kategorie): string {
  const j = Number(eintritt.slice(0, 4)), m = Number(eintritt.slice(5, 7)), t = eintritt.slice(8, 10);
  if (kategorie === 'TRAINING') return t === '01' ? eintritt : m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, '0')}-01`;
  const md = eintritt.slice(5);
  if (md === '01-01' || md === '07-01') return eintritt;
  return m <= 6 ? `${j}-07-01` : `${j + 1}-01-01`;
}
/** Familienbeitrag: deckt die Mitgliedschaft aller weiteren Personen des Antrags ab – nur dann sind weitere Personen möglich */
export const istFamilienbeitrag = (name: string) => /famil/i.test(name);
export interface AntragBank { kontoinhaber: string; iban: string; bic?: string | null; bank?: string | null; sepa: boolean }

export const MAX_PERSONEN = 8;
export const alter = (geb: string, stichtag = heute()) => {
  const [j, m, d] = geb.split('-').map(Number);
  const [sj, sm, sd] = stichtag.split('-').map(Number);
  return sj - j - (sm < m || (sm === m && sd < d) ? 1 : 0);
};

/** öffentliche Angaben für das Formular: Beitragsarten mit aktuellem Betrag */
export async function antragInfo(db: Db, v: Verein) {
  const { arten } = await vertragsarten(db, heute());
  return {
    verein: v.name, maxPersonen: MAX_PERSONEN, maxTraining: MAX_TRAINING,
    alterJugendbeitragBis: ALTER_JUGENDBEITRAG_BIS, alterTrainingBis: ALTER_TRAINING_BIS, kuendigung: KUENDIGUNG_TEXT,
    beitragsarten: arten.map((a) => ({ art: a.art, name: a.name, betrag: a.betrag, turnus: a.turnus, kategorie: kategorieVon(a.art, a.name), jugend: kategorieVon(a.art, a.name) === 'MITGLIEDSCHAFT' && istJugendbeitrag(a.name),
      familie: kategorieVon(a.art, a.name) === 'MITGLIEDSCHAFT' && istFamilienbeitrag(a.name) }))
      .filter((a) => a.kategorie),
  };
}

export function pruefen(d: AntragDaten, b: AntragBank, artenListe: { art: string; name: string }[]): void {
  const arten = new Map(artenListe.map((a) => [a.art, { ...a, kategorie: kategorieVon(a.art, a.name) }]));
  if (!d.personen.length) throw new BusinessError('Bitte mindestens eine Person angeben.');
  if (d.personen.length > MAX_PERSONEN) throw new BusinessError(`Höchstens ${MAX_PERSONEN} Personen je Antrag.`);
  for (const [i, p] of d.personen.entries()) {
    const wer = d.personen.length > 1 ? `Person ${i + 1}: ` : '';
    if (!['Herr', 'Frau', 'Divers'].includes(p.anrede)) throw new BusinessError(`${wer}Bitte die Anrede wählen.`);
    if (!condense(p.vorname) || !condense(p.nachname)) throw new BusinessError(`${wer}Bitte Vor- und Nachname angeben.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.geburtsdatum) || p.geburtsdatum > heute() || alter(p.geburtsdatum) > 120) throw new BusinessError(`${wer}Bitte ein gültiges Geburtsdatum angeben.`);
    const a = /^\d{4}-\d{2}-\d{2}$/.test(d.eintritt) ? alter(p.geburtsdatum, d.eintritt) : alter(p.geburtsdatum);
    if (i === 0) {
      const m = arten.get(p.art ?? '');
      if (!m || m.kategorie !== 'MITGLIEDSCHAFT') throw new BusinessError(`${wer}Bitte eine Mitgliedschaft wählen.`);
      if (istJugendbeitrag(m.name) && a > ALTER_JUGENDBEITRAG_BIS) throw new BusinessError(`${wer}Ab 18 Jahren ist kein Jugendbeitrag möglich – bitte eine andere Mitgliedschaft wählen.`);
      if (d.personen.length > 1 && !istFamilienbeitrag(m.name)) throw new BusinessError('Weitere Personen sind nur mit dem Familienbeitrag möglich.');
    } else if (p.art) throw new BusinessError(`${wer}Weitere Personen sind über den Familienbeitrag Mitglied – keine eigene Mitgliedschaft.`);
    const tr = p.training ?? [];
    if (tr.length > MAX_TRAINING) throw new BusinessError(`${wer}Höchstens ${MAX_TRAINING} Trainingseinheiten.`);
    for (const t of tr) if (arten.get(t)?.kategorie !== 'TRAINING') throw new BusinessError(`${wer}Unbekannte Trainingseinheit.`);
    if (tr.length && a > ALTER_TRAINING_BIS) throw new BusinessError(`${wer}Jugendtraining gibt es nur bis 21 Jahre.`);
    if (p.email && !emailGueltig(p.email.trim())) throw new BusinessError(`${wer}Die E-Mail-Adresse ist ungültig.`);
  }
  const namen = d.personen.map((p) => `${normName(`${p.vorname} ${p.nachname}`)}|${p.geburtsdatum}`);
  if (new Set(namen).size !== namen.length) throw new BusinessError('Eine Person ist doppelt im Antrag.');
  if (!condense(d.strasse) || !condense(d.plz) || !condense(d.ort)) throw new BusinessError('Bitte die vollständige Anschrift angeben.');
  if (!d.email || !emailGueltig(d.email.trim())) throw new BusinessError('Bitte eine gültige E-Mail-Adresse angeben.');
  if (alter(d.personen[0].geburtsdatum) < 18 && !condense(d.erziehungsberechtigt ?? '')) {
    throw new BusinessError('Für Minderjährige bitte den Namen der/des Erziehungsberechtigten angeben (stellt den Antrag).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.eintritt) || d.eintritt < heute()) throw new BusinessError('Der Eintritt kann frühestens heute sein.');
  if (!d.satzung || !d.datenschutz) throw new BusinessError('Bitte Satzung/Beitragsordnung und Datenschutzhinweise bestätigen.');
  if (!d.kuendigung) throw new BusinessError('Bitte die Kündigungsfristen bestätigen.');
  if (!b.sepa) throw new BusinessError('Der Beitrag wird per Lastschrift eingezogen – bitte das SEPA-Lastschriftmandat erteilen.');
  if (!condense(b.kontoinhaber)) throw new BusinessError('Bitte den Kontoinhaber angeben.');
  if (!ibanGueltig(normalisieren(b.iban))) throw new BusinessError('Die IBAN ist ungültig (Prüfziffer/Länge).');
}

export async function antragAnlegen(tx: Db, d: AntragDaten, b: AntragBank, ip: string): Promise<{ id: number; nummer: string }> {
  const { arten } = await vertragsarten(tx, heute());
  pruefen(d, b, arten);
  const jahr = heute().slice(0, 4);
  const [{ n }] = await tx`select core.next_number('TCO_ANTRAG', ${Number(jahr)})::int as n`;
  const nummer = `MA-${jahr}-${String(n).padStart(4, '0')}`;
  const { schnupper: token, ...rest } = d;
  const daten = {
    ...rest,
    schnupper_adrnr: await adrnrZumToken(tx, token),
    personen: d.personen.map((p) => ({ ...p, vorname: condense(p.vorname), nachname: condense(p.nachname), email: p.email?.trim() || null })),
    strasse: condense(d.strasse), plz: condense(d.plz), ort: condense(d.ort), email: d.email.trim(),
  };
  const [r] = await tx`insert into tco.mitgliedsantraege (nummer, daten, kontoinhaber, iban, bic, bank, sepa_am, ip)
                       values (${nummer}, ${tx.json(daten as never)}, ${condense(b.kontoinhaber)}, ${normalisieren(b.iban)}, ${normalisieren(b.bic ?? '') || null},
                               ${condense(b.bank ?? '') || null}, now(), ${ip}) returning id`;
  return { id: Number(r.id), nummer };
}

export async function antraegeLesen(db: Db, status: 'EINGANG' | 'ALLE') {
  const rows = await db`select id, nummer, status, eingang, daten, kontoinhaber, iban, bic, bank, sepa_am, bearbeitet_am, bearbeitet_von, bemerkung, ergebnis
                          from tco.mitgliedsantraege ${status === 'ALLE' ? db`` : db`where status = 'EINGANG'`}
                         order by status = 'EINGANG' desc, eingang desc limit 300`;
  const out: (Record<string, any> & { id: number; hinweise: string[] })[] = [];
  for (const r of rows) {
    const d = r.daten as AntragDaten;
    // Dublettenprüfung: gleicher Name + Geburtsdatum (auch ausgetretene) bzw. gleiche E-Mail
    const hinweise: string[] = [];
    if (r.status === 'EINGANG') {
      const vergeben = new Set<string>();
      for (const [i, p] of d.personen.entries()) {
        // Schnupperer (#86): derselbe Stammsatz wird bei der Übernahme Mitglied – keine Dublette
        const st = await schnupperFuerPerson(db, p, i === 0 ? d.schnupper_adrnr ?? null : null, vergeben);
        if (st) {
          vergeben.add(st.adrnr);
          hinweise.push(`${p.vorname} ${p.nachname}: Schnuppertraining ${st.nummer} – wird bei der Übernahme Mitglied (gleicher Stammsatz, Kategorie wechselt).`);
        }
        const treffer = await db`select adrnr, mitglnrn, vorname, nachname, austritt::text from tco.mitglieder
                                  where adrnr <> ${st?.adrnr ?? ''}
                                    and ((lower(vorname) = lower(${p.vorname}) and lower(nachname) = lower(${p.nachname})
                                          and geburtsdatum is not distinct from ${p.geburtsdatum}::date)
                                      or (${p.email ?? ''} <> '' and lower(trim(coalesce(email, ''))) = lower(${p.email ?? ''})
                                          and lower(vorname) = lower(${p.vorname})))`;
        for (const t of treffer) {
          hinweise.push(`${p.vorname} ${p.nachname}: bereits ${t.austritt ? `ehemaliges Mitglied (Austritt ${t.austritt})` : 'Mitglied'} Nr. ${t.mitglnrn || t.adrnr} – ${t.austritt ? 'Wiedereintritt prüfen' : 'Übernahme gesperrt'}.`);
        }
      }
    }
    out.push({ ...(r as Record<string, any>), id: Number(r.id), hinweise });
  }
  return out;
}

const teilen = (voll: string) => {
  const t = condense(voll).split(' ');
  return t.length > 1 ? { vorname: t.slice(0, -1).join(' '), nachname: t[t.length - 1] } : { vorname: '', nachname: t[0] ?? '' };
};

/**
 * Übernahme: Mitglieder in Antragsreihenfolge anlegen (erste Person bzw. abweichender Kontoinhaber ist Zahler, weitere
 * Personen zahlen über ihn), SEPA-Mandat zum Zeitpunkt der Online-Erteilung, danach Portalbenutzer mit Rolle Mitglied
 * (Einmal-Link per E-Mail, sonst Startkennwort).
 */
export async function uebernehmen(tx: Db, v: Verein, id: number, wer: string, o: { eintritt?: string | null; mail: boolean }) {
  const [a] = await tx`select * from tco.mitgliedsantraege where id = ${id} for update`;
  if (!a) throw new BusinessError('Antrag nicht gefunden.', 404);
  if (a.status !== 'EINGANG') throw new BusinessError(`Der Antrag ${a.nummer} ist bereits ${a.status === 'UEBERNOMMEN' ? 'übernommen' : 'abgelehnt'}.`);
  const d = a.daten as AntragDaten;
  const eintritt = o.eintritt || d.eintritt;
  const { arten } = await vertragsarten(tx, eintritt);
  const sepaDatum = new Date(a.sepa_am ?? a.eingang).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  const erster = d.personen[0];
  const kiSelbst = normName(a.kontoinhaber) === normName(`${erster.vorname} ${erster.nachname}`);
  const ki = teilen(a.kontoinhaber);
  const angelegt: { adrnr: string; mitglnrn: string; name: string }[] = [];
  let zahler: string | null = null;
  let mandat = '';
  const vergeben = new Set<string>();
  const schnupperer: { adrnr: string; nummer: string }[] = [];
  for (const [i, p] of d.personen.entries()) {
    // Schnupperer (#86): bestehenden Stammsatz zum Mitglied machen statt neu anlegen
    const st = await schnupperFuerPerson(tx, p, i === 0 ? d.schnupper_adrnr ?? null : null, vergeben);
    if (st) vergeben.add(st.adrnr);
    // weitere Personen: Mitgliedschaft über den Familienbeitrag (Vertrag der Familienart ohne Betrag), dazu ihre Trainingseinheiten
    const familie = i > 0 ? d.personen[0].art! : null;
    const gewaehlt = [familie ?? p.art!, ...(p.training ?? [])].map((x) => {
      const a = arten.find((y) => y.art === x);
      if (!a) throw new BusinessError(`Die Beitragsart ${x} (${p.vorname} ${p.nachname}) ist nicht mehr aktiv.`);
      return a;
    });
    const n: Neu = {
      anrede: p.anrede, vorname: p.vorname, nachname: p.nachname, strasse: d.strasse, plz: d.plz, ort: d.ort,
      telefon: (i === 0 ? p.telefon || d.telefon : p.telefon) ?? '', mobil: p.mobil || st?.mobil || '', email: p.email || d.email,
      geburtsdatum: p.geburtsdatum, eintritt, datenschutz: d.datenschutz, bildrechte: d.bildrechte,
      zahlungsart: 'L', zahlungsweise: '', iban: a.iban, bic: a.bic ?? '', bank: a.bank ?? '', sepa: true, sepa_datum: sepaDatum,
      zahler_modus: i === 0 ? (kiSelbst ? 'SELBST' : 'NEU') : 'BESTEHEND', zahler_adrnr: i === 0 ? null : zahler,
      z_anrede: '', z_vorname: ki.vorname, z_nachname: ki.nachname, z_strasse: d.strasse, z_plz: d.plz, z_ort: d.ort, z_email: d.email,
      vertraege: gewaehlt.map((a, j) => ({ art: a.art, beginn: beginnFuer(eintritt, j === 0 ? 'MITGLIEDSCHAFT' : 'TRAINING'), betrag: familie && j === 0 ? 0 : a.betrag, turnus: a.turnus })),
      bestehend: st?.adrnr ?? null,
    };
    const r = await mitgliedNeu(tx, n);
    if (st) {
      await alsMitgliedMarkieren(tx, st.adrnr, a.nummer, wer);
      schnupperer.push(st);
    }
    if (i === 0) {
      const [m] = await tx`select coalesce(nullif(adrnrkih, ''), adrnr) as zahler from tco.mitglieder where adrnr = ${r.adrnr}`;
      zahler = m.zahler;
      mandat = r.mandat;
    }
    angelegt.push({ adrnr: r.adrnr, mitglnrn: r.mitglnrn, name: `${p.vorname} ${p.nachname}` });
  }
  // Portalbenutzer (Rolle Mitglied) für jede Person
  const benutzer: { name: string; username: string; hinweis: string; startkennwort: string | null }[] = [];
  for (const m of angelegt) {
    const r = await mitgliederBenutzerAnlegen(tx, v, { mail: o.mail, adrnr: m.adrnr });
    for (const b of r.angelegt) benutzer.push({ name: b.name, username: b.username, hinweis: b.hinweis, startkennwort: b.startkennwort });
    for (const u of r.uebersprungen) benutzer.push({ name: m.name, username: '', hinweis: u, startkennwort: null });
  }
  const ergebnis = { mitglieder: angelegt, mandat, benutzer: benutzer.map(({ startkennwort: _s, ...b }) => b), schnupper: schnupperer.map((x) => x.nummer) };
  await tx`update tco.mitgliedsantraege set status = 'UEBERNOMMEN', bearbeitet_am = now(), bearbeitet_von = ${wer}, ergebnis = ${tx.json(ergebnis as never)}
           where id = ${id}`;
  return { nummer: a.nummer as string, email: d.email, name: `${erster.vorname} ${erster.nachname}`, ...ergebnis, startkennwoerter: benutzer.filter((b) => b.startkennwort) };
}

export async function antragAblehnen(tx: Db, id: number, wer: string, grund: string | null) {
  const [a] = await tx`update tco.mitgliedsantraege set status = 'ABGELEHNT', bearbeitet_am = now(), bearbeitet_von = ${wer}, bemerkung = ${grund}
                       where id = ${id} and status = 'EINGANG' returning nummer, daten`;
  if (!a) throw new BusinessError('Antrag nicht gefunden oder bereits bearbeitet.', 404);
  const d = a.daten as AntragDaten;
  return { nummer: a.nummer as string, email: d.email, name: `${d.personen[0].vorname} ${d.personen[0].nachname}` };
}
