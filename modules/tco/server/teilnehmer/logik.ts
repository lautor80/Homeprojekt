import { BusinessError } from '../../../../server/src/errors.js';
import { heute, runden } from '../format.js';
import type { Db } from '../verein.js';
import { leer } from '../mitglieder/logik.js';

/**
 * Teilnehmer Jugendtraining – Port von Z2UI5_CL_TCO_JUGENDTRAINING mit der Datenbasis
 * ZTCO_MITGLIEDER_REPORT=>TRAININGSTEILNEHMER_LESEN:
 *  - alle laufenden Verträge (Vertragsende leer) aller aktiven Personen (Austritt leer)
 *  - Vertragsart 90 = Jugendtraining: jeder laufende Vertrag ist eine gebuchte Einheit
 *  - eine Vertragsart < 90 macht die Person zum Vereinsmitglied
 *  - gelistet werden nur Personen mit mindestens einer Trainingseinheit
 *  - Familienbeitrag: Hat die Person selbst oder jemand aus ihrer Familie (Eltern/Zahler bzw. Familienverknüpfung,
 *    siehe mitglieder/familie.ts) einen laufenden Mitgliedsvertrag mit „Famil…“ in der Bezeichnung, ist sie darüber
 *    Vereinsmitglied – Ausweis „Familienbeitrag“ statt „Ja“
 */

export const ART_JUGEND = 90;

export interface Teilnehmer {
  adrnr: string; nachname: string; vorname: string; name: string; email: string; geburtsdatum: string | null; alter: number | null;
  einheiten: number; trainingsbeitrag: number; mitglied: boolean; mitglied_text: 'Ja' | 'Nein' | 'Familienbeitrag'; mitglied_state: 'Positive' | 'Critical';
  /** Mitglied über einen Familienbeitrag; familie_von = Name der Person mit dem Familienbeitrag */
  familienbeitrag: boolean; familie_von: string;
}

/** Vertrag ist ein Familienbeitrag (Mitgliedsvertrag, Bezeichnung enthält „Famil…“ – wie im Online-Antrag) */
export const istFamilienVertrag = (art: unknown, artname: unknown) => artKlasse(art) === 'MITGLIED' && /famil/i.test(leer(artname));

/**
 * Familienbeiträge zu den angegebenen Personen: je Person der Name dessen, der in ihrer Familie (Person selbst,
 * Zahler/Eltern, Familienverknüpfung – über mehrere Schritte) einen laufenden Familienbeitrag hat. Nur aktive Personen.
 */
export async function familienbeitraege(db: Db, adrnrs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!adrnrs.length) return out;
  const rows = await db`
    with recursive kanten as (
      select adrnr as a, adrnrkih as b from tco.mitglieder
       where adrnrkih is not null and ltrim(trim(adrnrkih), '0') <> '' and adrnrkih <> adrnr
      union
      select adrnr_a, adrnr_b from tco.familienverknuepfungen
    ), beide as (
      select a, b from kanten union select b, a from kanten
    ), fam(start, adrnr) as (
      select x, x from unnest(${adrnrs}::text[]) as t(x)
      union
      select f.start, k.b from fam f join beide k on k.a = f.adrnr
    )
    select f.start, f.adrnr, m.nachname, m.vorname, v.art, v.artname
      from fam f join tco.mitglieder m on m.adrnr = f.adrnr and m.austritt is null
                 join tco.vertraege v on v.adrnr = f.adrnr and v.vertragende is null
     where v.artname ilike '%famil%'
     order by f.start, (f.adrnr = f.start) desc, f.adrnr`;
  for (const r of rows) {
    if (out.has(r.start) || !istFamilienVertrag(r.art, r.artname)) continue;
    out.set(r.start, `${leer(r.vorname)} ${leer(r.nachname)}`.trim());
  }
  return out;
}

const artNorm = (a: unknown) => leer(a).replace(/^0+(?=\d)/, '');

/** Vertragsart im Vergleich zu 90 (ABAP vergleicht die Zeichenkette – hier numerisch, Text als Rückfall) */
function artKlasse(art: unknown): 'JUGEND' | 'MITGLIED' | 'SONST' {
  const a = artNorm(art);
  const n = Number(a);
  if (a && Number.isFinite(n)) return n === ART_JUGEND ? 'JUGEND' : n < ART_JUGEND ? 'MITGLIED' : 'SONST';
  return a < String(ART_JUGEND) ? 'MITGLIED' : 'SONST';
}

/**
 * Lebensalter in vollen Jahren zum Stichtag.
 * Abweichung zu SAP: dort ( sy-datum - geburtsdatum ) / 365 mit kaufmännischer Rundung
 * auf Integer – ab 17 Jahren und 6 Monaten wurde also schon 18 angezeigt.
 */
export function alterAm(geburtsdatum: string | null, stichtag = heute()): number | null {
  if (!geburtsdatum) return null;
  let a = Number(stichtag.slice(0, 4)) - Number(geburtsdatum.slice(0, 4));
  if (stichtag.slice(5) < geburtsdatum.slice(5)) a--;
  return Math.max(0, a);
}

export async function teilnehmerLesen(db: Db, stichtag = heute()): Promise<Teilnehmer[]> {
  const rows = await db`
    select a.adrnr, a.nachname, a.vorname, a.geburtsdatum::text as geburtsdatum, a.email, b.art, coalesce(b.betrag, 0)::float8 as betrag
      from tco.mitglieder a join tco.vertraege b on b.adrnr = a.adrnr
     where a.austritt is null and b.vertragende is null
     order by a.adrnr, b.art`;
  const m = new Map<string, Teilnehmer>();
  for (const r of rows) {
    let t = m.get(r.adrnr);
    if (!t) {
      t = {
        adrnr: r.adrnr, nachname: leer(r.nachname), vorname: leer(r.vorname), name: `${leer(r.nachname)}, ${leer(r.vorname)}`, email: leer(r.email),
        geburtsdatum: r.geburtsdatum, alter: alterAm(r.geburtsdatum, stichtag), einheiten: 0, trainingsbeitrag: 0,
        mitglied: false, mitglied_text: 'Nein', mitglied_state: 'Critical', familienbeitrag: false, familie_von: '',
      };
      m.set(r.adrnr, t);
    }
    const k = artKlasse(r.art);
    if (k === 'JUGEND') { t.einheiten++; t.trainingsbeitrag = runden(t.trainingsbeitrag + Number(r.betrag)); }
    else if (k === 'MITGLIED') t.mitglied = true;
  }
  const out = [...m.values()].filter((t) => t.einheiten > 0);
  const fam = await familienbeitraege(db, out.map((t) => t.adrnr));
  for (const t of out) {
    const von = fam.get(t.adrnr);
    if (von !== undefined) { t.familienbeitrag = true; t.familie_von = von; t.mitglied = true; }
    t.mitglied_text = t.familienbeitrag ? 'Familienbeitrag' : t.mitglied ? 'Ja' : 'Nein';
    t.mitglied_state = t.mitglied ? 'Positive' : 'Critical';
  }
  return out.sort((a, b) => a.nachname.localeCompare(b.nachname, 'de') || a.vorname.localeCompare(b.vorname, 'de'));
}

export interface TeilnehmerVertrag { vertragnr: string; art: string; artname: string; sollstellung: string; vertragbegin: string | null; vertragende: string | null; betrag: number; jugend: boolean; laeuft: boolean }

/** Detail: Person mit allen Verträgen (laufende zuerst) und Kontaktdaten */
export async function teilnehmerDetail(db: Db, adrnr: string, stichtag = heute()) {
  const [m] = await db`select adrnr, anrede, nachname, vorname, strasse, plz, ort, email, telefon, telefon6, geburtsdatum::text as geburtsdatum,
                              eintritt::text as eintritt, austritt::text as austritt, mitglnrn, adrnrkih
                         from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError('Person nicht gefunden.');
  const v = await db`select vertragnr, art, artname, sollstellung, vertragbegin::text as vertragbegin, vertragende::text as vertragende, coalesce(betrag, 0)::float8 as betrag
                       from tco.vertraege where adrnr = ${adrnr} order by vertragende nulls first, vertragbegin desc`;
  const vertraege: TeilnehmerVertrag[] = v.map((x) => ({
    vertragnr: x.vertragnr, art: artNorm(x.art), artname: leer(x.artname), sollstellung: leer(x.sollstellung), vertragbegin: x.vertragbegin,
    vertragende: x.vertragende, betrag: Number(x.betrag), jugend: artKlasse(x.art) === 'JUGEND', laeuft: !x.vertragende || x.vertragende >= stichtag,
  }));
  const zahler = m.adrnrkih && !/^0*$/.test(leer(m.adrnrkih))
    ? (await db`select adrnr, nachname, vorname, email, telefon6 from tco.mitglieder where adrnr = ${m.adrnrkih}`)[0] ?? null : null;
  const einheiten = vertraege.filter((x) => x.jugend && !x.vertragende).length;
  const familie = (await familienbeitraege(db, [adrnr])).get(adrnr);
  return {
    adrnr: m.adrnr, name: `${leer(m.nachname)}, ${leer(m.vorname)}`, anrede: leer(m.anrede), vorname: leer(m.vorname), nachname: leer(m.nachname),
    strasse: leer(m.strasse), plz: leer(m.plz), ort: leer(m.ort), email: leer(m.email), telefon: leer(m.telefon), mobil: leer(m.telefon6),
    geburtsdatum: m.geburtsdatum as string | null, alter: alterAm(m.geburtsdatum, stichtag), eintritt: m.eintritt as string | null, austritt: m.austritt as string | null,
    mitglnr: leer(m.mitglnrn).replace(/^0+(?=\d)/, ''),
    mitglied: familie !== undefined || vertraege.some((x) => !x.vertragende && artKlasse(x.art) === 'MITGLIED'),
    familienbeitrag: familie !== undefined, familie_von: familie ?? '',
    einheiten, trainingsbeitrag: runden(vertraege.filter((x) => x.jugend && !x.vertragende).reduce((s, x) => s + x.betrag, 0)),
    zahler: zahler ? { adrnr: zahler.adrnr, name: `${leer(zahler.nachname)}, ${leer(zahler.vorname)}`, email: leer(zahler.email), mobil: leer(zahler.telefon6) } : null,
    vertraege,
  };
}

/** mailto-Link mit allen Adressen im BCC (BUILD_SELECTION_INFO) */
export function mailtoLink(emails: string[], betreff = 'Jugendtraining TC Oberthal'): string | null {
  const l = [...new Set(emails.map((e) => e.trim()).filter(Boolean))];
  return l.length ? `mailto:?bcc=${encodeURIComponent(l.join(','))}&subject=${encodeURIComponent(betreff)}` : null;
}
