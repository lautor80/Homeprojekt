/**
 * Rundschreiben: Empfänger ermitteln.
 *
 * Rundschreiben sind Vereinsinformation an Mitglieder – keine Werbung an Dritte. Empfänger sind deshalb nur aktive
 * Mitglieder (Eintritt gesetzt, Austritt leer oder noch nicht erreicht): alle oder die Mitglieder gewählter Gruppen
 * samt Untergruppen, eingegrenzt nach Altersgruppe und Beitragsart. Einzeln hinzufügen lassen sich aktive Mitglieder
 * und Personen, die für ein aktives Mitglied zahlen (Eltern ohne eigene Mitgliedschaft). Ausgetretene und reine
 * Schnupper-Kontakte sind nie dabei – ihre Kontaktdaten sind nicht für Vereinspost bestimmt.
 *
 * Adresse je Person:
 *  - Minderjährige (Geburtsdatum bekannt, unter 18): Adresse des Zahlers (Stammsatz des abweichenden Zahlers), sonst die
 *    beim Mitglied hinterlegte Adresse des Kontoinhabers, sonst die eigene, sonst die eines Erwachsenen der Familie.
 *  - alle anderen: die eigene Adresse, sonst die des Kontoinhabers, sonst die des Zahlers.
 * Je E-Mail-Adresse entsteht genau ein Empfänger (Familien mit gemeinsamer Adresse) – mit gemeinsamer Anrede.
 *
 * Der Rechenteil (empfaengerErmitteln) kommt ohne Datenbank aus.
 */
import type { Db } from '../verein.js';
import { condense } from '../format.js';
import { alterAm } from '../gruppen/alter.js';
import { mitUntergruppen } from '../gruppen/logik.js';

export const ALTER = ['', 'ERWACHSENE', 'JUGEND'] as const;
export type Altersgruppe = (typeof ALTER)[number];
export interface Auswahl {
  /** alle aktiven Mitglieder (sonst nur die der Gruppen) */
  alle: boolean;
  /** Mitgliedergruppen – Untergruppen zählen mit */
  gruppen: number[];
  alter: Altersgruppe;
  /** nur Mitglieder mit laufendem Vertrag einer dieser Beitragsarten (leer = alle) */
  arten: string[];
  /** einzelne Personen zusätzlich */
  dazu: string[];
  /** einzelne Personen nie */
  ohne: string[];
}
export const AUSWAHL_LEER: Auswahl = { alle: false, gruppen: [], alter: '', arten: [], dazu: [], ohne: [] };

/** Auswahl aus der Datenbank (jsonb) – fehlende Angaben wie „nichts gewählt“ */
export function auswahlAus(roh: unknown): Auswahl {
  const a = (roh && typeof roh === 'object' ? roh : {}) as Partial<Auswahl>;
  const texte = (l: unknown) => (Array.isArray(l) ? [...new Set(l.map((x) => String(x)))] : []);
  return {
    alle: !!a.alle, gruppen: Array.isArray(a.gruppen) ? [...new Set(a.gruppen.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [],
    alter: ALTER.includes(a.alter as Altersgruppe) ? (a.alter as Altersgruppe) : '', arten: texte(a.arten), dazu: texte(a.dazu), ohne: texte(a.ohne),
  };
}

export interface Person {
  adrnr: string; vorname: string; nachname: string; email: string; emailkih: string;
  /** abweichender Zahler ('' = keiner) */
  zahler: string;
  geburtsdatum: string | null; eintritt: string | null; austritt: string | null;
  strasse: string; plz: string; ort: string;
  /** offene Anmeldung zum Schnuppertraining ohne Eintritt */
  schnupper: boolean;
}
export type Weg = 'EIGEN' | 'ZAHLER' | 'KONTOINHABER' | 'FAMILIE';
export const WEG_TEXT: Record<Weg, string> = {
  EIGEN: 'eigene Adresse', ZAHLER: 'Adresse des Zahlers', KONTOINHABER: 'Adresse des Kontoinhabers', FAMILIE: 'Adresse der Familie',
};
export interface Empfaenger {
  /** E-Mail-Adresse, wie sie im Stamm steht (verglichen wird ohne Groß-/Kleinschreibung) */
  email: string; adrnrs: string[]; namen: string; anrede: string; vorname: string; nachname: string; weg: Weg;
}
export interface OhneMail { adrnr: string; name: string; grund: string; strasse: string; plz: string; ort: string }
export interface Ergebnis {
  empfaenger: Empfaenger[];
  ohneMail: OhneMail[];
  /** Personen, für die das Rundschreiben bestimmt ist (mit und ohne Adresse) */
  personen: number;
  /** E-Mails, die wegfallen, weil sich mehrere Personen eine Adresse teilen */
  dubletten: number;
  /** ausdrücklich ausgeschlossene Personen, die sonst dabei wären */
  ausgeschlossen: number;
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const sauber = (s: unknown) => (s == null ? '' : String(s).trim());
/** Adressverweis (Zahler): leer oder Initialwert „0000000000“ = kein Verweis */
const verweis = (s: unknown) => (/^0*$/.test(sauber(s)) ? '' : sauber(s));

export const istAktiv = (p: Pick<Person, 'eintritt' | 'austritt'>, heute: string) => !!p.eintritt && (!p.austritt || p.austritt >= heute);
export const istMinderjaehrig = (p: Pick<Person, 'geburtsdatum'>, heute: string) => !!p.geburtsdatum && alterAm(p.geburtsdatum, heute) < 18;
export const personName = (p: Pick<Person, 'adrnr' | 'vorname' | 'nachname'>) => condense(`${p.vorname} ${p.nachname}`) || p.adrnr;

/** „A“, „A und B“, „A, B und C“ */
export const aufzaehlung = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} und ${l[l.length - 1]}` : l[0] ?? '');

/** Familien: Personen, die über den Zahler oder eine Familienverknüpfung zusammenhängen (wie mitglieder/familie.ts) */
function familien(personen: Map<string, Person>, verknuepfungen: [string, string][]): Map<string, string> {
  const wurzel = new Map<string, string>();
  const finde = (a: string): string => {
    let w = a;
    while (wurzel.get(w) !== undefined && wurzel.get(w) !== w) w = wurzel.get(w)!;
    wurzel.set(a, w);
    return w;
  };
  const verbinde = (a: string, b: string) => { const x = finde(a), y = finde(b); if (x !== y) wurzel.set(x, y); };
  for (const p of personen.values()) if (p.zahler && p.zahler !== p.adrnr && personen.has(p.zahler)) verbinde(p.adrnr, p.zahler);
  for (const [a, b] of verknuepfungen) if (personen.has(a) && personen.has(b)) verbinde(a, b);
  const out = new Map<string, string>();
  for (const a of personen.keys()) out.set(a, finde(a));
  return out;
}

/** liefert je Person die Adresse, an die das Rundschreiben geht (Regeln siehe oben); null = keine gültige Adresse */
function adressFinder(d: { personen: Person[]; verknuepfungen: [string, string][]; heute: string }): (p: Person) => { email: string; weg: Weg } | null {
  const { heute } = d;
  const alle = new Map(d.personen.map((p) => [p.adrnr, p]));
  const fam = familien(alle, d.verknuepfungen);
  const gueltig = (s: string) => (EMAIL.test(s) ? s : '');
  return (p) => {
    const z = p.zahler && p.zahler !== p.adrnr ? alle.get(p.zahler) : undefined;
    const eigen = gueltig(p.email), zahler = gueltig(z?.email ?? ''), inhaber = gueltig(p.emailkih);
    if (istMinderjaehrig(p, heute)) {
      if (zahler) return { email: zahler, weg: 'ZAHLER' };
      if (inhaber) return { email: inhaber, weg: 'KONTOINHABER' };
      if (eigen) return { email: eigen, weg: 'EIGEN' };
      const erwachsen = d.personen.filter((x) => x.adrnr !== p.adrnr && fam.get(x.adrnr) === fam.get(p.adrnr) && !istMinderjaehrig(x, heute)
        && !x.schnupper && (!x.austritt || x.austritt >= heute) && gueltig(x.email)).sort((x, y) => x.adrnr.localeCompare(y.adrnr))[0];
      return erwachsen ? { email: erwachsen.email, weg: 'FAMILIE' } : null;
    }
    if (eigen) return { email: eigen, weg: 'EIGEN' };
    if (inhaber) return { email: inhaber, weg: 'KONTOINHABER' };
    if (zahler) return { email: zahler, weg: 'ZAHLER' };
    return null;
  };
}

/**
 * Empfänger aus dem Bestand berechnen.
 * @param inGruppen  Personen der gewählten Gruppen samt Untergruppen
 * @param arten      laufende Beitragsarten je Person
 */
export function empfaengerErmitteln(d: {
  personen: Person[]; auswahl: Auswahl; inGruppen: Set<string>; arten: Map<string, Set<string>>; verknuepfungen: [string, string][]; heute: string;
}): Ergebnis {
  const { auswahl: a, heute } = d;
  const alle = new Map(d.personen.map((p) => [p.adrnr, p]));
  const zahltFuerAktive = new Set(d.personen.filter((p) => p.zahler && istAktiv(p, heute)).map((p) => p.zahler));

  // 1. Auswahl: alle bzw. Gruppen, eingegrenzt nach Altersgruppe und Beitragsart
  const gewaehlt = new Set<string>();
  for (const p of d.personen) {
    if (!istAktiv(p, heute)) continue;
    if (!a.alle && !d.inGruppen.has(p.adrnr)) continue;
    if (a.alter === 'JUGEND' && !istMinderjaehrig(p, heute)) continue;
    if (a.alter === 'ERWACHSENE' && istMinderjaehrig(p, heute)) continue;
    if (a.arten.length && !a.arten.some((x) => d.arten.get(p.adrnr)?.has(x))) continue;
    gewaehlt.add(p.adrnr);
  }
  // 2. einzeln hinzugefügt: nur aktive Mitglieder und Zahler aktiver Mitglieder (nie Ausgetretene, nie Schnupper-Kontakte)
  for (const adrnr of a.dazu) {
    const p = alle.get(adrnr);
    if (p && einzelnErlaubt(p, zahltFuerAktive, heute)) gewaehlt.add(adrnr);
  }
  // 3. Ausschlüsse gehen vor
  let ausgeschlossen = 0;
  for (const adrnr of a.ohne) if (gewaehlt.delete(adrnr)) ausgeschlossen++;

  // 4. Adresse je Person
  const adresse = adressFinder(d);

  // 5. je Adresse ein Empfänger
  const sortiert = [...gewaehlt].map((x) => alle.get(x)!).sort((x, y) => x.nachname.localeCompare(y.nachname, 'de') || x.vorname.localeCompare(y.vorname, 'de') || x.adrnr.localeCompare(y.adrnr));
  const jeAdresse = new Map<string, { email: string; personen: { p: Person; weg: Weg }[] }>();
  const ohneMail: OhneMail[] = [];
  for (const p of sortiert) {
    const ad = adresse(p);
    if (!ad) {
      const ungueltig = [p.email, p.emailkih].map(sauber).filter(Boolean)[0];
      ohneMail.push({ adrnr: p.adrnr, name: personName(p), grund: ungueltig ? `E-Mail-Adresse ungültig (${ungueltig})` : 'keine E-Mail-Adresse', strasse: p.strasse, plz: p.plz, ort: p.ort });
      continue;
    }
    const k = ad.email.toLowerCase();
    const e = jeAdresse.get(k) ?? { email: ad.email, personen: [] };
    e.personen.push({ p, weg: ad.weg });
    jeAdresse.set(k, e);
  }
  const empfaenger: Empfaenger[] = [...jeAdresse.values()].map((e) => {
    // Erwachsene zuerst (Eltern vor Kindern), dann nach Vorname
    const l = [...e.personen].sort((x, y) => Number(istMinderjaehrig(x.p, heute)) - Number(istMinderjaehrig(y.p, heute)) || x.p.vorname.localeCompare(y.p.vorname, 'de'));
    const vornamen = [...new Set(l.map((x) => x.p.vorname).filter(Boolean))];
    const nachnamen = [...new Set(l.map((x) => x.p.nachname).filter(Boolean))];
    // nur Kinder, und die Adresse gehört nicht ihnen selbst: die Eltern ansprechen
    const eltern = l.every((x) => istMinderjaehrig(x.p, heute) && x.weg !== 'EIGEN');
    const namen = aufzaehlung(vornamen);
    return {
      email: e.email, adrnrs: l.map((x) => x.p.adrnr), namen: l.map((x) => personName(x.p)).join(', '),
      anrede: !namen ? 'Hallo zusammen' : eltern ? `Liebe Eltern von ${namen}` : `Hallo ${namen}`,
      vorname: namen, nachname: nachnamen.join(' / '), weg: l.find((x) => x.weg !== 'EIGEN')?.weg ?? 'EIGEN',
    };
  }).sort((x, y) => x.namen.localeCompare(y.namen, 'de'));

  const mitAdresse = empfaenger.reduce((n, e) => n + e.adrnrs.length, 0);
  return { empfaenger, ohneMail, personen: mitAdresse + ohneMail.length, dubletten: mitAdresse - empfaenger.length, ausgeschlossen };
}

/** darf die Person einzeln hinzugefügt werden? Aktives Mitglied oder Zahler eines aktiven Mitglieds – nie ausgetreten, nie Schnupper-Kontakt */
function einzelnErlaubt(p: Person, zahltFuerAktive: Set<string>, heute: string): boolean {
  if (istAktiv(p, heute)) return true;
  if (p.schnupper || (p.austritt && p.austritt < heute)) return false;
  return zahltFuerAktive.has(p.adrnr);
}

/** Platzhalter {Anrede}, {Vorname}, {Nachname}, {Verein} ersetzen – unbekannte bleiben stehen */
export function einsetzen(vorlage: string, e: Pick<Empfaenger, 'anrede' | 'vorname' | 'nachname'>, verein: string): string {
  const werte: Record<string, string> = { anrede: e.anrede, vorname: e.vorname, nachname: e.nachname, verein };
  return vorlage.replace(/\{([A-Za-z]+)\}/g, (ganz, k: string) => werte[k.toLowerCase()] ?? ganz);
}
export const PLATZHALTER: Record<string, string> = {
  Anrede: 'Anrede mit Vornamen, z. B. „Hallo Anna“, bei gemeinsamer Adresse „Hallo Anna und Ben“, bei Kindern „Liebe Eltern von Carl“',
  Vorname: 'Vorname(n) der Empfänger', Nachname: 'Nachname(n) der Empfänger', Verein: 'Name des Vereins',
};

// ---------------------------------------------------------------- Datenbank
interface Bestand { personen: Person[]; arten: Map<string, Set<string>>; verknuepfungen: [string, string][]; heute: string }

async function bestandLesen(db: Db): Promise<Bestand> {
  const [{ heute }] = await db`select to_char(current_date, 'YYYY-MM-DD') as heute`;
  const rows = await db`
    select m.adrnr, m.vorname, m.nachname, m.email, m.emailkih, m.adrnrkih, m.geburtsdatum, m.eintritt, m.austritt, m.strasse, m.plz, m.ort,
           (s.adrnr is not null and m.eintritt is null and s.status not in ('MITGLIED', 'ABGESAGT')) as schnupper
      from tco.mitglieder m left join tco.schnupper s on s.adrnr = m.adrnr`;
  const personen: Person[] = rows.map((r) => ({
    adrnr: r.adrnr as string, vorname: condense(sauber(r.vorname)), nachname: condense(sauber(r.nachname)), email: sauber(r.email), emailkih: sauber(r.emailkih),
    zahler: verweis(r.adrnrkih), geburtsdatum: (r.geburtsdatum as string | null) ?? null, eintritt: (r.eintritt as string | null) ?? null,
    austritt: (r.austritt as string | null) ?? null, strasse: sauber(r.strasse), plz: sauber(r.plz), ort: sauber(r.ort), schnupper: !!r.schnupper,
  }));
  const arten = new Map<string, Set<string>>();
  for (const r of await db`select adrnr, art from tco.vertraege
                            where coalesce(art, '') <> '' and (vertragbegin is null or vertragbegin <= current_date) and (vertragende is null or vertragende >= current_date)`) {
    arten.set(r.adrnr as string, (arten.get(r.adrnr as string) ?? new Set()).add(sauber(r.art)));
  }
  const verknuepfungen = (await db`select adrnr_a, adrnr_b from tco.familienverknuepfungen`).map((r) => [r.adrnr_a, r.adrnr_b] as [string, string]);
  return { personen, arten, verknuepfungen, heute: heute as string };
}

/** Empfänger eines Rundschreibens aus dem aktuellen Bestand */
export async function empfaengerLesen(db: Db, auswahl: Auswahl): Promise<Ergebnis> {
  const b = await bestandLesen(db);
  const ids = await mitUntergruppen(db, auswahl.gruppen);
  const inGruppen = new Set(ids.length
    ? (await db`select distinct adrnr from tco.kal_gruppe_mitglieder where gruppe_id = any(${ids})`).map((r) => r.adrnr as string) : []);
  return empfaengerErmitteln({ ...b, auswahl, inGruppen });
}

/** aktuelle Adresse einzelner Personen (für „erneut senden“, wenn der Stamm inzwischen berichtigt wurde); null = keine */
export async function adressenLesen(db: Db, adrnrs: string[]): Promise<Map<string, string | null>> {
  const b = await bestandLesen(db);
  const adresse = adressFinder(b);
  const alle = new Map(b.personen.map((p) => [p.adrnr, p]));
  return new Map(adrnrs.map((a) => [a, (alle.get(a) && adresse(alle.get(a)!)?.email) || null]));
}

/** Was sich im Entwurf wählen lässt: Gruppen, Beitragsarten und die Personen zum Hinzufügen bzw. Ausschließen */
export async function auswahlWerte(db: Db) {
  const b = await bestandLesen(db);
  const zahltFuerAktive = new Set(b.personen.filter((p) => p.zahler && istAktiv(p, b.heute)).map((p) => p.zahler));
  const personen = b.personen.filter((p) => einzelnErlaubt(p, zahltFuerAktive, b.heute))
    .map((p) => ({ adrnr: p.adrnr, name: condense(`${p.nachname}, ${p.vorname}`).replace(/^, |, $/g, '') || p.adrnr, mitglied: istAktiv(p, b.heute) }))
    .sort((x, y) => x.name.localeCompare(y.name, 'de'));
  const arten = await db`
    select v.art, coalesce(nullif(trim(max(bt.bezeichnung)), ''), nullif(trim(max(v.artname)), ''), v.art) as text, count(distinct v.adrnr)::int as anzahl
      from tco.vertraege v join tco.mitglieder m on m.adrnr = v.adrnr left join tco.beitrag bt on bt.art = v.art
     where coalesce(v.art, '') <> '' and (v.vertragbegin is null or v.vertragbegin <= current_date) and (v.vertragende is null or v.vertragende >= current_date)
       and m.eintritt is not null and (m.austritt is null or m.austritt >= current_date)
     group by v.art order by 2`;
  return { personen, arten: arten.map((r) => ({ art: sauber(r.art), text: r.text as string, anzahl: Number(r.anzahl) })) };
}
