import { BusinessError } from '../../../../server/src/errors.js';
import { ibanGueltig, normalisieren } from '../../../../server/src/lib/sepa.js';
import type { Db, Verein } from '../verein.js';
import { condense, heute } from '../format.js';
import { emailGueltig, mitgliedNeu, normName, vertragsarten, type Neu } from '../mitglieder/logik.js';
import { mitgliederBenutzerAnlegen } from '../mitglieder/selbst.js';

/**
 * Online-Mitgliedsantrag (#12): öffentliches Formular ohne Anmeldung, auch für Familien (mehrere Personen,
 * ein Beitragszahler). Die Einzugsermächtigung (SEPA) wird online erteilt. Anträge landen im Eingang; erst die
 * Übernahme durch den Vorstand legt Mitglieder, Verträge, SEPA-Mandat und die Portalbenutzer (Rolle Mitglied) an.
 */
export interface Person {
  anrede: string; vorname: string; nachname: string; geburtsdatum: string; email?: string | null; telefon?: string | null; mobil?: string | null;
  /** Beitragsart (tco.beitrag) */
  art: string;
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
  bemerkung?: string | null;
}
export interface AntragBank { kontoinhaber: string; iban: string; bic?: string | null; bank?: string | null; sepa: boolean }

export const MAX_PERSONEN = 8;
const alter = (geb: string, stichtag = heute()) => {
  const [j, m, d] = geb.split('-').map(Number);
  const [sj, sm, sd] = stichtag.split('-').map(Number);
  return sj - j - (sm < m || (sm === m && sd < d) ? 1 : 0);
};

/** öffentliche Angaben für das Formular: Beitragsarten mit aktuellem Betrag */
export async function antragInfo(db: Db, v: Verein) {
  const { arten } = await vertragsarten(db, heute());
  return {
    verein: v.name, maxPersonen: MAX_PERSONEN,
    beitragsarten: arten.map((a) => ({ art: a.art, name: a.name, betrag: a.betrag, turnus: a.turnus })),
  };
}

export function pruefen(d: AntragDaten, b: AntragBank, arten: string[]): void {
  if (!d.personen.length) throw new BusinessError('Bitte mindestens eine Person angeben.');
  if (d.personen.length > MAX_PERSONEN) throw new BusinessError(`Höchstens ${MAX_PERSONEN} Personen je Antrag.`);
  for (const [i, p] of d.personen.entries()) {
    const wer = d.personen.length > 1 ? `Person ${i + 1}: ` : '';
    if (!['Herr', 'Frau', 'Divers'].includes(p.anrede)) throw new BusinessError(`${wer}Bitte die Anrede wählen.`);
    if (!condense(p.vorname) || !condense(p.nachname)) throw new BusinessError(`${wer}Bitte Vor- und Nachname angeben.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.geburtsdatum) || p.geburtsdatum > heute() || alter(p.geburtsdatum) > 120) throw new BusinessError(`${wer}Bitte ein gültiges Geburtsdatum angeben.`);
    if (!arten.includes(p.art)) throw new BusinessError(`${wer}Bitte eine Mitgliedschaft (Beitragsart) wählen.`);
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
  if (!b.sepa) throw new BusinessError('Der Beitrag wird per Lastschrift eingezogen – bitte das SEPA-Lastschriftmandat erteilen.');
  if (!condense(b.kontoinhaber)) throw new BusinessError('Bitte den Kontoinhaber angeben.');
  if (!ibanGueltig(normalisieren(b.iban))) throw new BusinessError('Die IBAN ist ungültig (Prüfziffer/Länge).');
}

export async function antragAnlegen(tx: Db, d: AntragDaten, b: AntragBank, ip: string): Promise<{ id: number; nummer: string }> {
  const { arten } = await vertragsarten(tx, heute());
  pruefen(d, b, arten.map((a) => a.art));
  const jahr = heute().slice(0, 4);
  const [{ n }] = await tx`select core.next_number('TCO_ANTRAG', ${Number(jahr)})::int as n`;
  const nummer = `MA-${jahr}-${String(n).padStart(4, '0')}`;
  const daten = {
    ...d,
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
      for (const p of d.personen) {
        const treffer = await db`select adrnr, mitglnrn, vorname, nachname, austritt::text from tco.mitglieder
                                  where (lower(vorname) = lower(${p.vorname}) and lower(nachname) = lower(${p.nachname})
                                         and geburtsdatum is not distinct from ${p.geburtsdatum}::date)
                                     or (${p.email ?? ''} <> '' and lower(trim(coalesce(email, ''))) = lower(${p.email ?? ''})
                                         and lower(vorname) = lower(${p.vorname}))`;
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
  for (const [i, p] of d.personen.entries()) {
    const art = arten.find((x) => x.art === p.art);
    if (!art) throw new BusinessError(`Die Beitragsart ${p.art} (${p.vorname} ${p.nachname}) ist nicht mehr aktiv.`);
    const n: Neu = {
      anrede: p.anrede, vorname: p.vorname, nachname: p.nachname, strasse: d.strasse, plz: d.plz, ort: d.ort,
      telefon: (i === 0 ? p.telefon || d.telefon : p.telefon) ?? '', mobil: p.mobil ?? '', email: p.email || d.email,
      geburtsdatum: p.geburtsdatum, eintritt, datenschutz: d.datenschutz, bildrechte: d.bildrechte,
      zahlungsart: 'L', zahlungsweise: '', iban: a.iban, bic: a.bic ?? '', bank: a.bank ?? '', sepa: true, sepa_datum: sepaDatum,
      zahler_modus: i === 0 ? (kiSelbst ? 'SELBST' : 'NEU') : 'BESTEHEND', zahler_adrnr: i === 0 ? null : zahler,
      z_anrede: '', z_vorname: ki.vorname, z_nachname: ki.nachname, z_strasse: d.strasse, z_plz: d.plz, z_ort: d.ort, z_email: d.email,
      vertraege: [{ art: art.art, beginn: null, betrag: art.betrag, turnus: art.turnus }],
    };
    const r = await mitgliedNeu(tx, n);
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
  const ergebnis = { mitglieder: angelegt, mandat, benutzer: benutzer.map(({ startkennwort: _s, ...b }) => b) };
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
