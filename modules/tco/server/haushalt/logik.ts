import { BusinessError } from '../../../../server/src/errors.js';
import { funktionAktiv } from '../../../../server/src/funktionsschalter.js';
import type { Aufgabe } from '../../../../server/src/lib/arbeitsvorrat.js';
import { heute as heuteText, runden } from '../format.js';
import type { Db } from '../verein.js';
import { BEREICH_NAME, BEREICHE, KONTO_NUR_HABEN, kontenStamm, type Bereich } from '../abschluss/logik.js';
import { artenRoh, preiseLesen } from '../beitraege/logik.js';
import { geldkonten, kontoart } from '../finanz/logik.js';
import { einnahmenBerechnen, vertraegeLesen } from '../forecast/logik.js';
import {
  aufgelaufen, ausreisser, besteMethode, bewerten, jahresverlauf, liquiditaet, METHODE_TEXT, methodenWerte, MIN_HISTORIE, monatsverteilung,
  planwertAus, RECHEN_METHODEN, rueckpruefung, rundenPlan,
  type Ausreisser, type Bewertung, type Hochrechnung, type JahrMonate, type Liquiditaet, type Methode, type RechenMethode,
} from './vorschlag.js';
import {
  planProjekte, planProjekteFestschreiben, planProjekteKopieren, planProjektSetzen, projekteSollIst, projektnummern, type PlanProjekt, type ProjektSollIst,
} from './projekte.js';

/**
 * Haushaltsplan – Daten und Abläufe (docs/haushaltsplan/konzept.md). Der Haushaltsplan LIEST FI nur:
 * Ist-Werte werden nach denselben Regeln gebildet wie im Jahresabschluss (`jahreswerteLesen`: Verrechnungskonten
 * verdichtet, Konto 8012 nur Haben, Jahr ersatzweise aus dem Datum), die Kontoart kommt aus `kontoart()` der App
 * „Einnahmen und Ausgaben“. Gerechnet wird in vorschlag.ts; hier stehen Lesen, Speichern und die Statusfolge.
 */

export const F_UEBERWACHUNG = 'tco.haushalt.ueberwachung';
/** So viele abgeschlossene Jahre vor dem Basisjahr gehen höchstens in die Grundlage ein */
export const MAX_JAHRE = 6;

export type Status = 'ENTWURF' | 'BESCHLOSSEN' | 'GENEHMIGT';
export const STATUS_TEXT: Record<Status, string> = {
  ENTWURF: 'Entwurf', BESCHLOSSEN: 'vom Vorstand beschlossen', GENEHMIGT: 'von der Mitgliederversammlung genehmigt',
};
const MON = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const null12 = () => Array.from({ length: 12 }, () => 0);
const summe = (a: number[]) => runden(a.reduce((s, x) => s + x, 0));
const zahlOderNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

export interface Cfg {
  toleranz_gelb: number; toleranz_rot: number; mindestreserve: number | null; ausreisser_prozent: number;
  grundlage_ab: number | null; preissteigerung: number; genehmigung_mv: boolean;
}

export async function cfgLesen(db: Db): Promise<Cfg> {
  const [c] = await db`select toleranz_gelb::float8 as toleranz_gelb, toleranz_rot::float8 as toleranz_rot, mindestreserve::float8 as mindestreserve,
                              ausreisser_prozent::float8 as ausreisser_prozent, grundlage_ab, preissteigerung::float8 as preissteigerung, genehmigung_mv
                         from tco.hh_cfg where id = 1`;
  return {
    toleranz_gelb: c?.toleranz_gelb ?? 5, toleranz_rot: c?.toleranz_rot ?? 10, mindestreserve: zahlOderNull(c?.mindestreserve),
    ausreisser_prozent: c?.ausreisser_prozent ?? 50, grundlage_ab: zahlOderNull(c?.grundlage_ab), preissteigerung: c?.preissteigerung ?? 0,
    genehmigung_mv: c?.genehmigung_mv ?? true,
  };
}

export async function cfgSichern(tx: Db, c: Cfg): Promise<void> {
  if (c.toleranz_rot < c.toleranz_gelb) throw new BusinessError('Die Toleranz „überschritten“ darf nicht kleiner sein als die Toleranz „beobachten“.');
  await tx`update tco.hh_cfg set toleranz_gelb = ${c.toleranz_gelb}, toleranz_rot = ${c.toleranz_rot}, mindestreserve = ${c.mindestreserve},
                  ausreisser_prozent = ${c.ausreisser_prozent}, grundlage_ab = ${c.grundlage_ab}, preissteigerung = ${c.preissteigerung},
                  genehmigung_mv = ${c.genehmigung_mv} where id = 1`;
}

// ---------------------------------------------------------------------------
// Ist-Werte je Konto, Jahr und Monat (nur lesend)
// ---------------------------------------------------------------------------

export interface KontoIst {
  konto: string; name: string; kennzahl: string | null; art: 'E' | 'A' | 'G' | '';
  /** Jahr → zwölf Monatswerte; die Summe eines Jahres ist der Jahreswert des Jahresabschlusses */
  jahre: Map<number, number[]>;
  /** davon auf Projekte des Haushaltsplans gebucht (tco.fibuchungen.projekt) – in `jahre` enthalten */
  projekt: Map<number, number[]>;
}
export interface IstDaten {
  konten: Map<string, KontoIst>;
  /** Bewegung (Soll − Haben) aller Geldkonten je Jahr und Monat */
  geld: Map<number, number[]>;
  /** Bewegung (Soll − Haben) der Darlehenskonten (Kennzahl BK) je Jahr und Monat – positiv = Tilgung */
  darlehen: Map<number, number[]>;
}

/**
 * Monatswerte je Konto für die Jahre von..bis – dieselben Regeln wie `jahreswerteLesen` im Jahresabschluss, nur je Monat:
 * Konten mit Verrechnungskonto werden auf dieses verdichtet; der Jahreswert je gebuchtem Konto ist |Soll − Haben|
 * (Konto 8012: Haben). Die Monate tragen das Vorzeichen so, dass ihre Summe genau diesen Jahreswert ergibt –
 * ein Storno zählt also in dem Monat, in dem es gebucht wurde.
 */
export async function monatswerteLesen(db: Db, von: number, bis: number, projektNrn: string[] = []): Promise<IstDaten> {
  const stamm = await kontenStamm(db);
  const rows = await db`
    select coalesce(jahr, extract(year from datum)::int) as jahr, coalesce(monat, extract(month from datum)::int) as monat, konto,
           (trim(coalesce(projekt, '')) = any(${projektNrn}::text[])) as p,
           coalesce(sum(soll), 0)::float8 as soll, coalesce(sum(haben), 0)::float8 as haben
      from tco.fibuchungen
     where coalesce(jahr, extract(year from datum)::int) between ${von} and ${bis}
     group by 1, 2, 3, 4 order by 1, 3, 2`;
  // je gebuchtem Konto und Jahr: Monatsbeträge und der Jahresbetrag (für das Vorzeichen)
  const roh = new Map<string, { jahr: number; quelle: string; ziel: string; monate: number[]; pmonate: number[]; jahr_betrag: number }>();
  const geld = new Map<number, number[]>(), darlehen = new Map<number, number[]>();
  const hole = (m: Map<number, number[]>, j: number) => { let a = m.get(j); if (!a) { a = null12(); m.set(j, a); } return a; };
  for (const r of rows) {
    const jahr = Number(r.jahr);
    const mi = Number(r.monat) >= 1 && Number(r.monat) <= 12 ? Number(r.monat) - 1 : 11;
    const s = stamm.get(r.konto);
    const ziel = s?.verrechnung && stamm.has(s.verrechnung) ? s.verrechnung : r.konto;
    const betrag = ziel === KONTO_NUR_HABEN ? Number(r.haben) : Number(r.soll) - Number(r.haben);
    const key = `${jahr}|${r.konto}`;
    let e = roh.get(key);
    if (!e) { e = { jahr, quelle: r.konto, ziel, monate: null12(), pmonate: null12(), jahr_betrag: 0 }; roh.set(key, e); }
    e.monate[mi] += betrag;
    if (r.p) e.pmonate[mi] += betrag;
    e.jahr_betrag += betrag;
    const kz = s?.kennzahl ?? null;
    if (kontoart(String(r.konto).trim(), kz) === 'G') hole(geld, jahr)[mi] += Number(r.soll) - Number(r.haben);
    if (kz === 'BK') hole(darlehen, jahr)[mi] += Number(r.soll) - Number(r.haben);
  }
  const konten = new Map<string, KontoIst>();
  for (const e of roh.values()) {
    const k = stamm.get(e.ziel);
    let ki = konten.get(e.ziel);
    if (!ki) {
      const kennzahl = k?.kennzahl ?? null;
      ki = { konto: e.ziel, name: k?.name || e.ziel, kennzahl, art: kontoart(String(e.ziel).trim(), kennzahl), jahre: new Map(), projekt: new Map() };
      konten.set(e.ziel, ki);
    }
    const vz = e.jahr_betrag < 0 ? -1 : 1;
    const m = hole(ki.jahre, e.jahr);
    e.monate.forEach((x, i) => { m[i] += x * vz; });
    if (e.pmonate.some((x) => x !== 0)) { const pm = hole(ki.projekt, e.jahr); e.pmonate.forEach((x, i) => { pm[i] += x * vz; }); }
  }
  for (const k of konten.values()) for (const m of [k.jahre, k.projekt]) for (const [j, a] of m) m.set(j, a.map(runden));
  for (const m of [geld, darlehen]) for (const [j, a] of m) m.set(j, a.map(runden));
  return { konten, geld, darlehen };
}

// ---------------------------------------------------------------------------
// Fachdaten: Beitragsforecast je Erlöskonto
// ---------------------------------------------------------------------------

export interface Fachdaten {
  /** Erlöskonto → Monatswerte des Planjahres aus den laufenden Verträgen */
  konten: Map<string, { monate: number[]; arten: string[] }>;
  /** warum es für ein Konto keine Fachdaten gibt (nicht eindeutig) */
  hinweise: string[];
}

/**
 * Beitragsforecast des Planjahres je Erlöskonto. Die Zuordnung steht im Beitragsstamm (tco.beitrag.erloeskonto –
 * dasselbe Konto, auf das die Sollstellung bucht). Fachdaten gibt es nur, wo sie das Konto eindeutig erklären:
 * Zeigt auch eine Beitragsart auf das Konto, die der Forecast nicht rechnet, oder ist es zugleich Erlöskonto eines
 * Produkts (Halle, Verzehr), bleibt es bei den Methoden aus der Vergangenheit.
 */
export async function fachdatenLesen(db: Db, planjahr: number): Promise<Fachdaten> {
  const stamm = await kontenStamm(db);
  const ziel = (k: string) => { const s = stamm.get(k); return s?.verrechnung && stamm.has(s.verrechnung) ? s.verrechnung : k; };
  const arten = await artenRoh(db);
  const werte = einnahmenBerechnen(await vertraegeLesen(db, `${planjahr}-01-01`, `${planjahr}-12-31`), await preiseLesen(db), planjahr);
  const gerechnet = new Set(werte.map((w) => w.art));
  const konten = new Map<string, { monate: number[]; arten: string[] }>();
  const ohneKonto = new Set<string>();
  for (const w of werte) {
    const konto = arten.find((a) => a.art === w.art)?.erloeskonto ?? '';
    if (!konto) { ohneKonto.add(w.art); continue; }
    const z = ziel(konto);
    let e = konten.get(z);
    if (!e) { e = { monate: null12(), arten: [] }; konten.set(z, e); }
    e.monate[w.monat - 1] = runden(e.monate[w.monat - 1] + w.wert);
    if (!e.arten.includes(w.art)) e.arten.push(w.art);
  }
  const hinweise: string[] = [];
  if (ohneKonto.size) hinweise.push(`Beitragsarten ohne Erlöskonto im Beitragsstamm (keine Fachdaten möglich): ${[...ohneKonto].sort().join(', ')}.`);
  const produkte = new Set((await db`select distinct trim(erloeskonto) as k from tco.produkte where coalesce(trim(erloeskonto), '') <> ''`).map((r) => ziel(String(r.k))));
  for (const [konto] of [...konten]) {
    const fremd = arten.filter((a) => a.erloeskonto && ziel(a.erloeskonto) === konto && a.aktiv && !gerechnet.has(a.art)).map((a) => a.art);
    const grund = produkte.has(konto) ? 'es ist zugleich Erlöskonto eines Produkts'
      : fremd.length ? `auch die Beitragsart${fremd.length > 1 ? 'en' : ''} ${fremd.join(', ')} zeig${fremd.length > 1 ? 'en' : 't'} darauf, die der Beitragsforecast nicht rechnet` : '';
    if (grund) { konten.delete(konto); hinweise.push(`Konto ${konto}: keine Fachdaten, denn ${grund}.`); }
  }
  return { konten, hinweise };
}

// ---------------------------------------------------------------------------
// Grundlage des Vorschlags
// ---------------------------------------------------------------------------

export interface KontoGrundlage {
  konto: string; name: string; kennzahl: string | null; art: 'E' | 'A'; bereich: Bereich | '';
  /** Jahreswerte aller betrachteten Jahre (auch Sondereffekte, einschließlich Projektbuchungen) – für die Anzeige, wie im Jahresabschluss */
  ist: Record<number, number>;
  /** davon auf Projekte gebucht – zählt wie ein Sondereffekt nicht in die Grundlage und nicht ins Soll-Ist des Kontos */
  ist_projekt: Record<number, number>;
  /** Ist des Basisjahres bis zum Stand-Monat bzw. insgesamt – ohne Projektbuchungen */
  ist_stand: number; ist_basis: number; monate_basis: number[];
  sonder: { jahr: number; grund: string }[];
  /** Jahre, die in die Rechnung eingehen */
  zaehlt: number[];
  werte: Record<RechenMethode, number | null>;
  treffer: Record<RechenMethode, number | null>;
  pruefjahre: number[];
  hoch: Hochrechnung | null;
  fach: number | null;
  beste: Methode;
  /** weniger als drei abgeschlossene Jahre: kein Trend, keine Trefferquote */
  wenig_historie: boolean;
  jahre_anzahl: number;
  /** Jahresverlauf für die Monatsverteilung (Fachdaten: Verlauf laut Verträgen); null = gleichmäßig */
  profil: number[] | null;
  profil_fach: number[] | null;
  ausreisser: Ausreisser[];
  vorgaenger: { konto: string; ab_jahr: number } | null;
}

export interface Grundlage {
  planjahr: number; basisjahr: number;
  /** bis zu diesem Monat zählt das Basisjahr als gebucht (12 = abgeschlossen, 0 = nichts) */
  stand_monat: number; stand: string;
  /** betrachtete Jahre, aufsteigend, einschließlich Basisjahr */
  jahre: number[];
  konten: KontoGrundlage[];
  hinweise: string[];
  daten: IstDaten;
}

const bereichVon = (kennzahl: string | null): Bereich | '' =>
  (kennzahl && (BEREICHE as readonly string[]).includes(kennzahl[0]) ? (kennzahl[0] as Bereich) : '');

/** Bis zu welchem Monat das Jahr als gebucht gilt: Vergangenheit 12, Zukunft 0, laufendes Jahr der letzte abgelaufene und gebuchte Monat */
export function standMonat(jahr: number, heute: string, letzterGebuchter: number): number {
  const hj = Number(heute.slice(0, 4)), hm = Number(heute.slice(5, 7));
  if (jahr < hj) return 12;
  if (jahr > hj) return 0;
  return Math.max(0, Math.min(hm - 1, letzterGebuchter));
}

/**
 * Alles, was der Vorschlag für ein Planjahr braucht: Ist-Werte der Vorjahre, Hochrechnung des Basisjahres,
 * Werte und Treffsicherheit je Methode, Fachdaten, Ausreißer. `heute` bestimmt, wie weit das Basisjahr zählt.
 */
export async function grundlageLesen(db: Db, planjahr: number, heute = heuteText(), cfg?: Cfg): Promise<Grundlage> {
  const c = cfg ?? await cfgLesen(db);
  const basisjahr = planjahr - 1;
  const von = Math.max(basisjahr - MAX_JAHRE, c.grundlage_ab ?? 0);
  const daten = await monatswerteLesen(db, Math.min(von, basisjahr), planjahr, await projektnummern(db));
  const eaKonten = [...daten.konten.values()].filter((k) => k.art === 'E' || k.art === 'A');
  // betrachtet wird ab dem ersten Jahr, in dem überhaupt etwas gebucht ist
  const gebucht = eaKonten.flatMap((k) => [...k.jahre.keys()]);
  const erstesJahr = Math.min(basisjahr, Math.max(von, gebucht.length ? Math.min(...gebucht) : basisjahr));
  const jahre: number[] = [];
  for (let j = erstesJahr; j <= basisjahr; j++) jahre.push(j);
  let letzter = 0;
  for (const k of eaKonten) (k.jahre.get(basisjahr) ?? []).forEach((w, i) => { if (Math.abs(w) > 0.004) letzter = Math.max(letzter, i + 1); });
  const stand_monat = standMonat(basisjahr, heute, letzter);

  const sonderRows = await db`select konto, jahr, grund from tco.hh_sondereffekt`;
  const vorgRows = await db`select konto, vorgaenger, ab_jahr from tco.hh_konto_vorgaenger`;
  const inaktiv = new Set((await db`select konto, jahr from tco.fikontojahr where aktiv = false and jahr between ${jahre[0]} and ${planjahr}`).map((r) => `${r.konto}|${r.jahr}`));
  const fach = await fachdatenLesen(db, planjahr);

  const konten: KontoGrundlage[] = [];
  for (const k of eaKonten) {
    if (inaktiv.has(`${k.konto}|${planjahr}`)) continue;
    const vorg = vorgRows.find((v) => v.konto === k.konto);
    // Monatswerte je Jahr; vor „ab Jahr“ kommen sie aus dem Vorgängerkonto dazu
    const monate = (j: number): number[] => {
      const eigen = k.jahre.get(j) ?? null12();
      if (!vorg || j >= Number(vorg.ab_jahr)) return eigen;
      const v = daten.konten.get(String(vorg.vorgaenger))?.jahre.get(j);
      return v ? eigen.map((x, i) => runden(x + v[i])) : eigen;
    };
    // Projektbuchungen sind einmalig: Sie zählen nicht in die Grundlage und werden im Soll-Ist getrennt ausgewiesen
    const pm = (j: number) => k.projekt.get(j) ?? null12();
    const rein = (j: number) => { const m = monate(j), p = pm(j); return m.map((x, i) => runden(x - p[i])); };
    const mitWert = jahre.filter((j) => monate(j).some((w) => Math.abs(w) > 0.004));
    if (!mitWert.length) continue;
    const erstes = mitWert[0];
    const sonder = sonderRows.filter((s) => s.konto === k.konto).map((s) => ({ jahr: Number(s.jahr), grund: String(s.grund) })).sort((a, b) => a.jahr - b.jahr);
    const istSonder = (j: number) => sonder.some((s) => s.jahr === j);
    // ab dem ersten Gebrauch zählt jedes Jahr (auch mit 0), außer Sondereffekte und Jahre, in denen das Konto nicht verwendet wird
    const zaehlt = jahre.filter((j) => j >= erstes && !istSonder(j) && !inaktiv.has(`${k.konto}|${j}`) && (j < basisjahr || stand_monat > 0));
    const reihe: JahrMonate[] = zaehlt.map((j) => ({ jahr: j, monate: rein(j) }));
    const eingabe = { jahre: reihe, planjahr, standMonat: stand_monat };
    const m = methodenWerte(eingabe);
    const p = rueckpruefung(eingabe);
    const f = k.art === 'E' ? fach.konten.get(k.konto) : undefined;
    const fachWert = f ? summe(f.monate) : null;
    const mb = rein(basisjahr);
    const ist: Record<number, number> = {}, ist_projekt: Record<number, number> = {};
    for (const j of jahre) { ist[j] = summe(monate(j)); const p = summe(pm(j)); if (p) ist_projekt[j] = p; }
    const voll = jahre.filter((j) => j >= erstes && j < basisjahr && !inaktiv.has(`${k.konto}|${j}`)).map((j) => ({ jahr: j, wert: runden(ist[j] - (ist_projekt[j] ?? 0)) }));
    konten.push({
      konto: k.konto, name: k.name, kennzahl: k.kennzahl, art: k.art as 'E' | 'A', bereich: bereichVon(k.kennzahl),
      ist, ist_projekt, ist_stand: summe(mb.slice(0, stand_monat)), ist_basis: summe(mb), monate_basis: mb,
      sonder, zaehlt, werte: m.werte, treffer: p.treffer, pruefjahre: p.jahre, hoch: m.hoch, fach: fachWert,
      beste: besteMethode(m, p, fachWert), wenig_historie: m.anzahlJahre < MIN_HISTORIE, jahre_anzahl: m.anzahlJahre,
      profil: m.profil ?? (stand_monat >= 12 ? jahresverlauf([mb]) : null),
      profil_fach: f && fachWert ? f.monate.map((x) => x / fachWert) : null,
      ausreisser: ausreisser(voll, c.ausreisser_prozent).filter((a) => !istSonder(a.jahr)),
      vorgaenger: vorg ? { konto: String(vorg.vorgaenger), ab_jahr: Number(vorg.ab_jahr) } : null,
    });
  }
  konten.sort((a, b) => (a.art === b.art ? Number(a.konto) - Number(b.konto) || a.konto.localeCompare(b.konto) : a.art === 'E' ? -1 : 1));

  const hinweise = [...fach.hinweise];
  // Konten mit Kennzahl A–D, die nach ihrem Nummernbereich weder Einnahme noch Ausgabe sind, fehlen im Plan – das soll man wissen
  const fremd = [...daten.konten.values()].filter((k) => k.art === '' && bereichVon(k.kennzahl) && jahre.some((j) => summe(k.jahre.get(j) ?? []) !== 0)).map((k) => k.konto).sort();
  if (fremd.length) hinweise.push(`Konten mit Tätigkeitsbereich, aber außerhalb der Kontenbereiche für Einnahmen (8001–8999) und Ausgaben (2001–7999) – nicht im Haushaltsplan: ${fremd.join(', ')}.`);
  const ohneBereich = konten.filter((k) => !k.bereich).map((k) => k.konto);
  if (ohneBereich.length) hinweise.push(`Konten ohne Tätigkeitsbereich (Kennzahl A–D im Kontenstamm): ${ohneBereich.join(', ')}.`);
  return { planjahr, basisjahr, stand_monat, stand: heute, jahre, konten, hinweise, daten };
}

/** Wert der Methode für ein Konto (ohne Preissteigerung, noch nicht gerundet) */
export function methodenWert(k: KontoGrundlage, methode: Methode): number | null {
  if (methode === 'FACH') return k.fach;
  if (methode === 'MANUELL') return null;
  return k.werte[methode];
}

// ---------------------------------------------------------------------------
// Pläne lesen
// ---------------------------------------------------------------------------

export interface PlanKopf {
  id: number; jahr: number; fassung: number; status: Status; status_text: string; begruendung: string | null;
  beschlossen_am: string | null; beschlossen_von: string | null; genehmigt_am: string | null; genehmigt_von: string | null;
  preissteigerung: number; mindestreserve: number | null; tilgung: number | null; anfangsbestand: number | null;
  stand: string | null; notiz: string | null; paperless_id: number | null; angelegt_von: string | null;
}

const kopf = (r: Record<string, any>): PlanKopf => ({
  id: Number(r.id), jahr: Number(r.jahr), fassung: Number(r.fassung), status: r.status, status_text: STATUS_TEXT[r.status as Status],
  begruendung: r.begruendung ?? null, beschlossen_am: r.beschlossen_am ?? null, beschlossen_von: r.beschlossen_von ?? null,
  genehmigt_am: r.genehmigt_am ?? null, genehmigt_von: r.genehmigt_von ?? null, preissteigerung: Number(r.preissteigerung),
  mindestreserve: zahlOderNull(r.mindestreserve), tilgung: zahlOderNull(r.tilgung), anfangsbestand: zahlOderNull(r.anfangsbestand),
  stand: r.stand ?? null, notiz: r.notiz ?? null, paperless_id: zahlOderNull(r.paperless_id), angelegt_von: r.angelegt_von ?? null,
});

const PLAN_FELDER = `id, jahr, fassung, status, begruendung, beschlossen_am::text as beschlossen_am, beschlossen_von, genehmigt_am::text as genehmigt_am,
  genehmigt_von, preissteigerung::float8 as preissteigerung, mindestreserve::float8 as mindestreserve, tilgung::float8 as tilgung,
  anfangsbestand::float8 as anfangsbestand, stand::text as stand, notiz, paperless_id, angelegt_von`;

export async function planListe(db: Db): Promise<PlanKopf[]> {
  return (await db.unsafe(`select ${PLAN_FELDER} from tco.hh_plan order by jahr desc, fassung desc`)).map(kopf);
}

async function kopfLesen(db: Db, id: number): Promise<PlanKopf> {
  const [r] = await db.unsafe(`select ${PLAN_FELDER} from tco.hh_plan where id = $1`, [id]);
  if (!r) throw new BusinessError(`Haushaltsplan ${id} nicht gefunden.`, 404);
  return kopf(r);
}

/** Die Fassung, die für ein Jahr gilt: die jüngste beschlossene, sonst – als Vorschau – der jüngste Entwurf */
export async function gueltigerPlan(db: Db, jahr: number): Promise<PlanKopf | null> {
  const [r] = await db.unsafe(`select ${PLAN_FELDER} from tco.hh_plan where jahr = $1 order by (status <> 'ENTWURF') desc, fassung desc limit 1`, [jahr]);
  return r ? kopf(r) : null;
}

export interface Position {
  konto: string; name: string; art: 'E' | 'A'; bereich: Bereich | ''; bereich_text: string;
  methode: Methode; methode_text: string; vorschlag: number | null; planwert: number; zuschlag: number | null; notiz: string | null; manuell: boolean;
  /** Monatswerte des Planwerts; monate_fest = gespeichert (von Hand oder beim Beschluss festgeschrieben) */
  monate: number[]; monate_fest: boolean; monate_von_hand: boolean;
  /** Grundlage (live): fehlt, wenn das Konto keine Buchungen in den betrachteten Jahren hat */
  grundlage: Omit<KontoGrundlage, 'konto' | 'name' | 'art' | 'bereich' | 'kennzahl'> | null;
}

export interface Vorhaben { id: number; bezeichnung: string; art: 'E' | 'A'; monat: number; betrag: number; konto: string | null; projekt: string | null; eingeplant: boolean }

export interface Tilgung { monate: number[]; summe: number; quelle: 'PLAN' | 'DARLEHEN' | 'KEINE'; hinweis: string | null }
export interface Anfang { betrag: number; quelle: 'PLAN' | 'IST' | 'HOCHRECHNUNG' | 'HEUTE'; text: string }

export interface PlanSicht {
  plan: PlanKopf;
  aenderbar: boolean;
  basisjahr: number; stand_monat: number; stand_text: string; jahre: number[];
  positionen: Position[];
  vorhaben: Vorhaben[];
  /** Projekte, die im Planjahr wirken – mit „einrechnen“ und ihrem Beitrag (Simulation) */
  projekte: (PlanProjekt & { beitrag: { ergebnis: number; jahresende: number; tiefster: number } })[];
  /** einnahmen/ausgaben/ergebnis MIT den eingerechneten Projekten; `ohne` = dieselben Werte ohne Projekte */
  summen: {
    einnahmen: number; ausgaben: number; ergebnis: number; vorhaben_e: number; vorhaben_a: number; basis_e: number; basis_a: number;
    projekte_e: number; projekte_a: number;
    ohne: { einnahmen: number; ausgaben: number; ergebnis: number; tiefster: number; tiefsterMonat: number; jahresende: number };
  };
  bereiche: { bereich: Bereich | ''; text: string; einnahmen: number; ausgaben: number; ergebnis: number }[];
  liquiditaet: Liquiditaet & { tilgung: Tilgung; anfang_herkunft: Anfang; ist: (number | null)[] };
  hinweise: string[];
  fassungen: PlanKopf[];
  cfg: Cfg;
  /** Konten mit Buchungen, die im Plan noch fehlen (z. B. nach dem Anlegen neu bebucht) */
  fehlende: { konto: string; name: string }[];
}

export const bereichName = (b: Bereich | '') => (b ? `${b} ${BEREICH_NAME[b]}` : 'Ohne Tätigkeitsbereich');

/** Tilgung des Planjahres: Eingabe am Plan, sonst die Bewegung der Darlehenskonten (Kennzahl BK) der letzten zwölf bekannten Monate */
export function tilgungErmitteln(plan: PlanKopf, g: Grundlage): Tilgung {
  if (plan.tilgung !== null) {
    return { monate: monatsverteilung(plan.tilgung, null), summe: runden(plan.tilgung), quelle: 'PLAN', hinweis: null };
  }
  const basis = g.daten.darlehen.get(g.basisjahr), davor = g.daten.darlehen.get(g.basisjahr - 1);
  if (!basis && !davor) return { monate: null12(), summe: 0, quelle: 'KEINE', hinweis: null };
  // je Kalendermonat der jüngste bekannte Wert: bis zum Stand aus dem Basisjahr, danach aus dem Jahr davor
  const roh = Array.from({ length: 12 }, (_, i) => (i < g.stand_monat ? basis?.[i] ?? 0 : (davor ?? basis)?.[i] ?? 0));
  const aufnahme = roh.some((x) => x < -0.004);
  const monate = roh.map((x) => Math.max(0, runden(x)));
  return {
    monate, summe: summe(monate), quelle: 'DARLEHEN',
    hinweis: aufnahme ? 'In den letzten zwölf Monaten wurde ein Darlehen aufgenommen oder umgebucht – bitte die Tilgung am Plan eintragen.' : null,
  };
}

/** Geldbestand zum 01.01. des Planjahres */
async function anfangErmitteln(db: Db, plan: PlanKopf, g: Grundlage, tilgungBasis: number[]): Promise<Anfang> {
  if (plan.anfangsbestand !== null) return { betrag: plan.anfangsbestand, quelle: 'PLAN', text: 'am Plan eingetragen' };
  const hj = Number(g.stand.slice(0, 4));
  if (plan.jahr <= hj) {
    const ab = summe((await geldkonten(db, plan.jahr)).map((x) => x.anfangsbestand));
    return { betrag: ab, quelle: 'IST', text: `Anfangsbestand der Geldkonten zum 01.01.${plan.jahr}` };
  }
  const geld = await geldkonten(db, g.basisjahr <= hj ? g.basisjahr : hj);
  if (plan.jahr > hj + 1) {
    return { betrag: summe(geld.map((x) => x.endbestand)), quelle: 'HEUTE', text: 'heutiger Geldbestand – das Planjahr liegt mehr als ein Jahr voraus, bitte den Anfangsbestand am Plan eintragen' };
  }
  // Bestand zum Ende des Stand-Monats + erwartetes Ergebnis der restlichen Monate − deren Tilgung
  const bew = g.daten.geld.get(g.basisjahr) ?? null12();
  const bestand = runden(summe(geld.map((x) => x.anfangsbestand)) + summe(bew.slice(0, g.stand_monat)));
  let rest = 0;
  for (const k of g.konten) {
    const erwartet = Math.max(0, (k.hoch?.wert ?? k.ist_stand) - k.ist_stand);
    rest += k.art === 'E' ? erwartet : -erwartet;
  }
  const tilg = summe(tilgungBasis.slice(g.stand_monat));
  const monat = g.stand_monat ? `Ende ${MON[g.stand_monat - 1]} ${g.basisjahr}` : `01.01.${g.basisjahr}`;
  return {
    betrag: runden(bestand + rest - tilg), quelle: 'HOCHRECHNUNG',
    text: `Geldbestand ${monat} ${runden(bestand).toLocaleString('de-DE', { minimumFractionDigits: 2 })} € + erwartetes Ergebnis der restlichen Monate `
      + `${runden(rest).toLocaleString('de-DE', { minimumFractionDigits: 2 })} € − Tilgung ${tilg.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
  };
}

const standText = (g: Grundlage) => (g.stand_monat >= 12 ? `Buchungen ${g.jahre[0]} bis ${g.basisjahr}`
  : g.stand_monat > 0 ? `Buchungen ${g.jahre[0]} bis ${MON[g.stand_monat - 1]} ${g.basisjahr}`
    : g.jahre.length > 1 ? `Buchungen ${g.jahre[0]} bis ${g.basisjahr - 1}` : 'noch keine Buchungen');

/** Ein Plan mit allem, was die Oberfläche und das PDF zeigen */
export async function planLesen(db: Db, id: number, heute = heuteText()): Promise<PlanSicht> {
  const plan = await kopfLesen(db, id);
  const cfg = await cfgLesen(db);
  const g = await grundlageLesen(db, plan.jahr, heute, cfg);
  const pos = await db`select konto, methode, vorschlag::float8 as vorschlag, planwert::float8 as planwert, zuschlag::float8 as zuschlag, notiz, manuell
                         from tco.hh_position where plan_id = ${id}`;
  const mon = await db`select konto, monat, betrag::float8 as betrag, von_hand from tco.hh_monat where plan_id = ${id}`;
  const stamm = await kontenStamm(db);
  const positionen: Position[] = pos.map((p) => {
    const k = g.konten.find((x) => x.konto === p.konto);
    const s = stamm.get(p.konto);
    const art = (k?.art ?? kontoart(String(p.konto).trim(), s?.kennzahl ?? null)) as 'E' | 'A';
    const bereich = k?.bereich ?? bereichVon(s?.kennzahl ?? null);
    const fest = mon.filter((m) => m.konto === p.konto);
    const methode = p.methode as Methode;
    const planwert = Number(p.planwert);
    const monate = fest.length ? Array.from({ length: 12 }, (_, i) => Number(fest.find((m) => Number(m.monat) === i + 1)?.betrag ?? 0))
      : monatsverteilung(planwert, (methode === 'FACH' ? k?.profil_fach : null) ?? k?.profil ?? null);
    let grundlage: Position['grundlage'] = null;
    if (k) { const { konto: _k, name: _n, art: _a, bereich: _b, kennzahl: _z, ...rest } = k; grundlage = rest; }
    return {
      konto: p.konto, name: k?.name ?? s?.name ?? p.konto, art, bereich, bereich_text: bereichName(bereich),
      methode, methode_text: METHODE_TEXT[methode], vorschlag: zahlOderNull(p.vorschlag), planwert, zuschlag: zahlOderNull(p.zuschlag),
      notiz: p.notiz ?? null, manuell: !!p.manuell, monate, monate_fest: fest.length > 0, monate_von_hand: fest.some((m) => m.von_hand), grundlage,
    };
  }).sort((a, b) => (a.art === b.art ? Number(a.konto) - Number(b.konto) || a.konto.localeCompare(b.konto) : a.art === 'E' ? -1 : 1));

  const vorhaben: Vorhaben[] = (await db`select id, bezeichnung, art, monat, betrag::float8 as betrag, konto, projekt, eingeplant
                                           from tco.hh_vorhaben where plan_id = ${id} order by monat, id`)
    .map((v) => ({ id: Number(v.id), bezeichnung: v.bezeichnung, art: v.art, monat: Number(v.monat), betrag: Number(v.betrag), konto: v.konto ?? null, projekt: v.projekt ?? null, eingeplant: !!v.eingeplant }));
  const vor = (art: 'E' | 'A') => summe(vorhaben.filter((v) => v.eingeplant && v.art === art).map((v) => v.betrag));
  const sumArt = (art: 'E' | 'A') => summe(positionen.filter((p) => p.art === art).map((p) => p.planwert));
  const basis = (art: 'E' | 'A') => summe(positionen.filter((p) => p.art === art).map((p) => p.grundlage?.hoch?.wert ?? p.grundlage?.ist[g.basisjahr] ?? 0));
  const ohneE = runden(sumArt('E') + vor('E')), ohneA = runden(sumArt('A') + vor('A'));
  const planPr = await planProjekte(db, plan);
  const drin = planPr.filter((x) => x.einrechnen);
  const projekte_e = summe(drin.map((x) => x.wirkung.sum.einnahmen)), projekte_a = summe(drin.map((x) => x.wirkung.sum.ausgaben));
  const einnahmen = runden(ohneE + projekte_e), ausgaben = runden(ohneA + projekte_a);

  const bereiche = ([...BEREICHE, ''] as (Bereich | '')[]).map((b) => {
    const e = summe(positionen.filter((p) => p.bereich === b && p.art === 'E').map((p) => p.planwert));
    const a = summe(positionen.filter((p) => p.bereich === b && p.art === 'A').map((p) => p.planwert));
    return { bereich: b, text: bereichName(b), einnahmen: e, ausgaben: a, ergebnis: runden(e - a) };
  }).filter((b) => b.bereich || b.einnahmen || b.ausgaben);

  // Liquidität: Monatswerte der Konten + Vorhaben in ihrem Monat, Tilgung, Anfangsbestand
  const mE = null12(), mA = null12();
  for (const p of positionen) p.monate.forEach((w, i) => { if (p.art === 'E') mE[i] += w; else mA[i] += w; });
  for (const v of vorhaben) if (v.eingeplant) { if (v.art === 'E') mE[v.monat - 1] += v.betrag; else mA[v.monat - 1] += v.betrag; }
  const tilgung = tilgungErmitteln(plan, g);
  // Tilgung der restlichen Monate des Basisjahres: wie im Jahr davor
  const tilgBasis = (g.daten.darlehen.get(g.basisjahr - 1) ?? null12()).map((x) => Math.max(0, x));
  const anfang = await anfangErmitteln(db, plan, g, tilgBasis);
  const reserve = plan.mindestreserve ?? cfg.mindestreserve;
  /** Liquidität mit einer Auswahl von Projekten: Darlehen fließen zu, ihre Tilgung fließt ab – beides nur hier, nicht im Ergebnis */
  const liqMit = (auswahl: PlanProjekt[]) => {
    const e = [...mE], a = [...mA], t = [...tilgung.monate];
    for (const x of auswahl) for (let i = 0; i < 12; i++) { e[i] += x.wirkung.einnahmen[i] + x.wirkung.darlehen[i]; a[i] += x.wirkung.ausgaben[i]; t[i] += x.wirkung.tilgung[i]; }
    return liquiditaet(anfang.betrag, e, a, t, reserve);
  };
  const liqOhne = liqMit([]);
  const liq = liqMit(drin);
  // Beitrag je Projekt: was sich ändert, wenn genau dieses Projekt ein- bzw. ausgerechnet wird
  const projekte = planPr.map((x) => {
    const andere = liqMit(x.einrechnen ? drin.filter((y) => y.id !== x.id) : drin), mitDiesem = liqMit(x.einrechnen ? drin : [...drin, x]);
    return { ...x, beitrag: { ergebnis: x.wirkung.sum.ergebnis, jahresende: runden(mitDiesem.monate[11].bestand - andere.monate[11].bestand), tiefster: runden(mitDiesem.tiefster - andere.tiefster) } };
  });
  // tatsächlicher Geldbestand je Monatsende, soweit das Planjahr schon läuft
  const hj = Number(heute.slice(0, 4)), hm = Number(heute.slice(5, 7));
  const ist: (number | null)[] = Array.from({ length: 12 }, () => null);
  if (plan.jahr <= hj) {
    const bew = g.daten.geld.get(plan.jahr) ?? null12();
    let b = summe((await geldkonten(db, plan.jahr)).map((x) => x.anfangsbestand));
    for (let i = 0; i < 12; i++) { b = runden(b + bew[i]); if (plan.jahr < hj || i < hm) ist[i] = b; }
  }

  const hinweise = [...g.hinweise];
  if (tilgung.hinweis) hinweise.push(tilgung.hinweis);
  const fehlende = g.konten.filter((k) => !positionen.some((p) => p.konto === k.konto)).map((k) => ({ konto: k.konto, name: k.name }));
  return {
    plan, aenderbar: plan.status === 'ENTWURF', basisjahr: g.basisjahr, stand_monat: g.stand_monat, stand_text: standText(g), jahre: g.jahre,
    positionen, vorhaben, projekte,
    summen: {
      einnahmen, ausgaben, ergebnis: runden(einnahmen - ausgaben), vorhaben_e: vor('E'), vorhaben_a: vor('A'), basis_e: basis('E'), basis_a: basis('A'),
      projekte_e, projekte_a,
      ohne: { einnahmen: ohneE, ausgaben: ohneA, ergebnis: runden(ohneE - ohneA), tiefster: liqOhne.tiefster, tiefsterMonat: liqOhne.tiefsterMonat, jahresende: liqOhne.monate[11].bestand },
    },
    bereiche, liquiditaet: { ...liq, tilgung, anfang_herkunft: anfang, ist }, hinweise,
    fassungen: (await planListe(db)).filter((p) => p.jahr === plan.jahr), cfg, fehlende,
  };
}

// ---------------------------------------------------------------------------
// Pläne anlegen und bearbeiten (nur im Entwurf)
// ---------------------------------------------------------------------------

async function entwurf(tx: Db, id: number): Promise<PlanKopf> {
  const [r] = await tx.unsafe(`select ${PLAN_FELDER} from tco.hh_plan where id = $1 for update`, [id]);
  if (!r) throw new BusinessError(`Haushaltsplan ${id} nicht gefunden.`, 404);
  const p = kopf(r);
  if (p.status !== 'ENTWURF') throw new BusinessError(`Der Haushaltsplan ${p.jahr} (Fassung ${p.fassung}) ist ${p.status_text} und kann nicht mehr geändert werden – bitte einen Nachtrag anlegen.`);
  return p;
}

const vorschlagRund = (k: KontoGrundlage, methode: Methode) => { const w = methodenWert(k, methode); return w === null ? null : rundenPlan(w); };

/** Plan für ein Geschäftsjahr anlegen: alle Konten mit Buchungen bekommen die treffsicherste Methode und deren Vorschlag */
export async function planAnlegen(tx: Db, jahr: number, benutzer: string, heute = heuteText()): Promise<number> {
  const [da] = await tx`select fassung, status from tco.hh_plan where jahr = ${jahr} order by fassung desc limit 1`;
  if (da) throw new BusinessError(`Für ${jahr} gibt es bereits einen Haushaltsplan (Fassung ${da.fassung}). Änderungen an einem beschlossenen Plan laufen als Nachtrag.`);
  const cfg = await cfgLesen(tx);
  const [p] = await tx`insert into tco.hh_plan (jahr, fassung, status, preissteigerung, stand, angelegt_von)
                       values (${jahr}, 1, 'ENTWURF', ${cfg.preissteigerung}, ${heute}, ${benutzer}) returning id`;
  const g = await grundlageLesen(tx, jahr, heute, cfg);
  if (g.konten.length) {
    const z = g.konten.map((k) => { const v = vorschlagRund(k, k.beste); return { konto: k.konto, methode: k.beste, vorschlag: v, planwert: planwertAus(v, k.beste, k.art, cfg.preissteigerung) }; });
    await tx`insert into tco.hh_position (plan_id, konto, methode, vorschlag, planwert)
             select ${p.id}, * from unnest(${z.map((x) => x.konto)}::text[], ${z.map((x) => x.methode)}::text[],
                                           ${z.map((x) => x.vorschlag)}::numeric[], ${z.map((x) => x.planwert)}::numeric[])`;
  }
  return Number(p.id);
}

/**
 * Vorschlag neu berechnen. `methode`: 'BESTE' = je Konto die treffsicherste, sonst diese Methode für alle Konten, für die
 * sie einen Wert liefert (Konten mit Fachdaten behalten sie, wie im Mockup). Von Hand geänderte Planwerte bleiben, außer
 * `auchManuelle` ist gesetzt. Konten, die seit dem Anlegen neu bebucht wurden, kommen dazu.
 */
export async function neuBerechnen(tx: Db, id: number, o: { methode: 'BESTE' | 'BEHALTEN' | RechenMethode; auchManuelle: boolean }, heute = heuteText()): Promise<number> {
  const plan = await entwurf(tx, id);
  const g = await grundlageLesen(tx, plan.jahr, heute);
  const pos = await tx`select konto, methode, zuschlag::float8 as zuschlag, manuell from tco.hh_position where plan_id = ${id}`;
  let n = 0;
  for (const k of g.konten) {
    const p = pos.find((x) => x.konto === k.konto);
    let methode: Methode = o.methode === 'BEHALTEN' ? (p?.methode as Methode | undefined) ?? k.beste
      : o.methode === 'BESTE' || k.beste === 'FACH' || k.werte[o.methode] === null ? k.beste : o.methode;
    if (p?.methode === 'MANUELL' && !o.auchManuelle) methode = 'MANUELL';
    // liefert die Methode (inzwischen) nichts, gilt wieder die treffsicherste
    else if (methode === 'MANUELL' || methodenWert(k, methode) === null) methode = k.beste;
    const v = vorschlagRund(k, methode);
    if (!p) {
      await tx`insert into tco.hh_position (plan_id, konto, methode, vorschlag, planwert) values (${id}, ${k.konto}, ${methode}, ${v}, ${planwertAus(v, methode, k.art, plan.preissteigerung)})`;
    } else if (p.manuell && !o.auchManuelle) {
      // der Planwert bleibt, der Vorschlag daneben wird aktualisiert
      await tx`update tco.hh_position set vorschlag = ${methode === 'MANUELL' ? null : v} where plan_id = ${id} and konto = ${k.konto}`;
      continue;
    } else {
      await tx`update tco.hh_position set methode = ${methode}, vorschlag = ${v}, planwert = ${planwertAus(v, methode, k.art, p.zuschlag ?? plan.preissteigerung)}, manuell = false
                where plan_id = ${id} and konto = ${k.konto}`;
    }
    n++;
  }
  await tx`update tco.hh_plan set stand = ${heute} where id = ${id}`;
  return n;
}

export interface PositionEingabe { methode?: Methode; planwert?: number | null; zuschlag?: number | null; notiz?: string | null }

/** Eine Position ändern: Methode wechseln (setzt den Planwert auf den Vorschlag), Planwert überschreiben, Zuschlag, Notiz */
export async function positionAendern(tx: Db, id: number, konto: string, e: PositionEingabe, heute = heuteText()): Promise<void> {
  const plan = await entwurf(tx, id);
  const [p] = await tx`select methode, vorschlag::float8 as vorschlag, planwert::float8 as planwert, zuschlag::float8 as zuschlag, manuell from tco.hh_position where plan_id = ${id} and konto = ${konto}`;
  if (!p) throw new BusinessError(`Konto ${konto} ist im Haushaltsplan nicht enthalten.`, 404);
  const stamm = await kontenStamm(tx);
  const art = kontoart(konto.trim(), stamm.get(konto)?.kennzahl ?? null) as 'E' | 'A';
  let methode = p.methode as Methode, vorschlag = zahlOderNull(p.vorschlag), planwert = Number(p.planwert), manuell = !!p.manuell;
  const zuschlag = e.zuschlag === undefined ? zahlOderNull(p.zuschlag) : e.zuschlag;
  const neuRechnen = (e.methode !== undefined && e.methode !== methode) || (e.zuschlag !== undefined && e.zuschlag !== zahlOderNull(p.zuschlag) && !manuell);
  if (e.methode !== undefined && e.methode !== methode) {
    methode = e.methode;
    if (methode === 'MANUELL') { vorschlag = null; manuell = true; }
    else {
      const k = (await grundlageLesen(tx, plan.jahr, heute)).konten.find((x) => x.konto === konto);
      const w = k ? vorschlagRund(k, methode) : null;
      if (w === null) throw new BusinessError(`${METHODE_TEXT[methode]} liefert für Konto ${konto} keinen Wert${methode === 'TREND' ? ' (weniger als drei abgeschlossene Jahre)' : ''}.`);
      vorschlag = w; manuell = false;
    }
  }
  if (neuRechnen && methode !== 'MANUELL') planwert = planwertAus(vorschlag, methode, art, zuschlag ?? plan.preissteigerung);
  if (e.planwert !== undefined && e.planwert !== null) {
    if (!(e.planwert >= 0)) throw new BusinessError('Der Planwert darf nicht negativ sein.');
    if (runden(e.planwert) !== runden(planwert) || methode === 'MANUELL') { planwert = runden(e.planwert); manuell = true; }
  }
  const notiz = e.notiz === undefined ? undefined : (e.notiz?.trim() || null);
  await tx`update tco.hh_position set methode = ${methode}, vorschlag = ${vorschlag}, planwert = ${planwert}, zuschlag = ${zuschlag}, manuell = ${manuell},
                  notiz = ${notiz === undefined ? tx`notiz` : notiz} where plan_id = ${id} and konto = ${konto}`;
  // von Hand verteilte Monate passen nicht mehr zum neuen Planwert – anteilig mitziehen
  const fest = await tx`select monat, betrag::float8 as betrag from tco.hh_monat where plan_id = ${id} and konto = ${konto} order by monat`;
  if (fest.length && runden(summe(fest.map((m) => Number(m.betrag)))) !== runden(planwert)) {
    const alt = Array.from({ length: 12 }, (_, i) => Number(fest.find((m) => Number(m.monat) === i + 1)?.betrag ?? 0));
    await monateSchreiben(tx, id, konto, monatsverteilung(planwert, summe(alt) > 0 ? alt.map((x) => Math.max(0, x)) : null), true);
  }
}

async function monateSchreiben(tx: Db, id: number, konto: string, betraege: number[], vonHand: boolean): Promise<void> {
  await tx`delete from tco.hh_monat where plan_id = ${id} and konto = ${konto}`;
  await tx`insert into tco.hh_monat (plan_id, konto, monat, betrag, von_hand)
           select ${id}, ${konto}, m, b, ${vonHand} from unnest(${betraege.map((_, i) => i + 1)}::int[], ${betraege.map(runden)}::numeric[]) as t(m, b)`;
}

/** Monatsverlauf eines Kontos von Hand festlegen (zwölf Beträge, Summe = Planwert) oder mit null wieder berechnen lassen */
export async function monateSetzen(tx: Db, id: number, konto: string, betraege: number[] | null): Promise<void> {
  await entwurf(tx, id);
  const [p] = await tx`select planwert::float8 as planwert from tco.hh_position where plan_id = ${id} and konto = ${konto}`;
  if (!p) throw new BusinessError(`Konto ${konto} ist im Haushaltsplan nicht enthalten.`, 404);
  if (betraege === null) { await tx`delete from tco.hh_monat where plan_id = ${id} and konto = ${konto}`; return; }
  if (betraege.length !== 12) throw new BusinessError('Bitte zwölf Monatsbeträge angeben.');
  if (Math.abs(summe(betraege) - Number(p.planwert)) > 0.005) {
    throw new BusinessError(`Die Monatsbeträge ergeben ${summe(betraege).toLocaleString('de-DE', { minimumFractionDigits: 2 })} €, der Planwert ist ${Number(p.planwert).toLocaleString('de-DE', { minimumFractionDigits: 2 })} €.`);
  }
  await monateSchreiben(tx, id, konto, betraege, true);
}

/** Konto von Hand in den Plan aufnehmen (z. B. ein neues Konto ohne Buchungen) */
export async function positionHinzufuegen(tx: Db, id: number, konto: string, heute = heuteText()): Promise<void> {
  const plan = await entwurf(tx, id);
  const s = (await kontenStamm(tx)).get(konto);
  if (!s) throw new BusinessError(`Konto ${konto} gibt es im Kontenstamm nicht.`);
  if (s.verrechnung) throw new BusinessError(`Konto ${konto} wird auf das Verrechnungskonto ${s.verrechnung} verdichtet – bitte dieses planen.`);
  const art = kontoart(konto.trim(), s.kennzahl);
  if (art !== 'E' && art !== 'A') throw new BusinessError(`Konto ${konto} ist weder Einnahme- noch Ausgabekonto.`);
  const [da] = await tx`select 1 from tco.hh_position where plan_id = ${id} and konto = ${konto}`;
  if (da) throw new BusinessError(`Konto ${konto} ist bereits im Haushaltsplan.`);
  const k = (await grundlageLesen(tx, plan.jahr, heute)).konten.find((x) => x.konto === konto);
  const methode: Methode = k?.beste ?? 'MANUELL';
  const v = k ? vorschlagRund(k, methode) : null;
  await tx`insert into tco.hh_position (plan_id, konto, methode, vorschlag, planwert, manuell)
           values (${id}, ${konto}, ${methode}, ${v}, ${planwertAus(v, methode, art, plan.preissteigerung)}, ${methode === 'MANUELL'})`;
}

export async function positionEntfernen(tx: Db, id: number, konto: string): Promise<void> {
  await entwurf(tx, id);
  await tx`delete from tco.hh_position where plan_id = ${id} and konto = ${konto}`;
}

export interface KopfEingabe { preissteigerung?: number; mindestreserve?: number | null; tilgung?: number | null; anfangsbestand?: number | null; notiz?: string | null }

/** Angaben am Plan; eine geänderte Preissteigerung rechnet die nicht von Hand geänderten Ausgaben neu */
export async function kopfAendern(tx: Db, id: number, e: KopfEingabe): Promise<void> {
  const plan = await entwurf(tx, id);
  const n = { ...plan, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) } as PlanKopf;
  await tx`update tco.hh_plan set preissteigerung = ${n.preissteigerung}, mindestreserve = ${n.mindestreserve}, tilgung = ${n.tilgung},
                  anfangsbestand = ${n.anfangsbestand}, notiz = ${n.notiz?.trim() || null} where id = ${id}`;
  if (n.preissteigerung !== plan.preissteigerung) {
    const stamm = await kontenStamm(tx);
    const pos = await tx`select konto, methode, vorschlag::float8 as vorschlag from tco.hh_position where plan_id = ${id} and not manuell and zuschlag is null and methode <> 'MANUELL'`;
    for (const p of pos) {
      const art = kontoart(String(p.konto).trim(), stamm.get(p.konto)?.kennzahl ?? null) as 'E' | 'A';
      if (art !== 'A') continue;
      await tx`update tco.hh_position set planwert = ${planwertAus(zahlOderNull(p.vorschlag), p.methode, art, n.preissteigerung)} where plan_id = ${id} and konto = ${p.konto}`;
    }
  }
}

export interface VorhabenEingabe { id?: number | null; bezeichnung: string; art: 'E' | 'A'; monat: number; betrag: number; konto?: string | null; projekt?: string | null; eingeplant: boolean }

export async function vorhabenSichern(tx: Db, planId: number, e: VorhabenEingabe): Promise<number> {
  await entwurf(tx, planId);
  const konto = e.konto?.trim() || null;
  if (konto) {
    const s = (await kontenStamm(tx)).get(konto);
    if (!s) throw new BusinessError(`Konto ${konto} gibt es im Kontenstamm nicht.`);
    if (kontoart(konto, s.kennzahl) !== e.art) throw new BusinessError(`Konto ${konto} ist kein ${e.art === 'E' ? 'Einnahme' : 'Ausgabe'}konto.`);
  }
  if (e.id) {
    const r = await tx`update tco.hh_vorhaben set bezeichnung = ${e.bezeichnung.trim()}, art = ${e.art}, monat = ${e.monat}, betrag = ${runden(e.betrag)}, konto = ${konto},
                              projekt = ${e.projekt?.trim() || null}, eingeplant = ${e.eingeplant} where id = ${e.id} and plan_id = ${planId} returning id`;
    if (!r.length) throw new BusinessError('Vorhaben nicht gefunden.', 404);
    return e.id;
  }
  const [r] = await tx`insert into tco.hh_vorhaben (plan_id, bezeichnung, art, monat, betrag, konto, projekt, eingeplant)
                       values (${planId}, ${e.bezeichnung.trim()}, ${e.art}, ${e.monat}, ${runden(e.betrag)}, ${konto}, ${e.projekt?.trim() || null}, ${e.eingeplant}) returning id`;
  return Number(r.id);
}

export async function vorhabenLoeschen(tx: Db, planId: number, vorhabenId: number): Promise<void> {
  await entwurf(tx, planId);
  await tx`delete from tco.hh_vorhaben where id = ${vorhabenId} and plan_id = ${planId}`;
}

/** Sondereffekt: Jahr eines Kontos mit Begründung aus der Grundlage nehmen (grund leer = wieder aufnehmen). Gilt für alle Pläne. */
export async function sondereffektSetzen(tx: Db, konto: string, jahr: number, grund: string | null, benutzer: string): Promise<void> {
  if (!grund?.trim()) { await tx`delete from tco.hh_sondereffekt where konto = ${konto} and jahr = ${jahr}`; return; }
  await tx`insert into tco.hh_sondereffekt (konto, jahr, grund, erfasst_von) values (${konto}, ${jahr}, ${grund.trim()}, ${benutzer})
           on conflict (konto, jahr) do update set grund = excluded.grund, erfasst_von = excluded.erfasst_von, erfasst_am = now()`;
}

/** Vorgängerkonto zuordnen (vorgaenger leer = Zuordnung aufheben) */
export async function vorgaengerSetzen(tx: Db, konto: string, vorgaenger: string | null, abJahr: number | null): Promise<void> {
  if (!vorgaenger?.trim()) { await tx`delete from tco.hh_konto_vorgaenger where konto = ${konto}`; return; }
  const v = vorgaenger.trim();
  if (v === konto) throw new BusinessError('Ein Konto kann nicht sein eigener Vorgänger sein.');
  const stamm = await kontenStamm(tx);
  if (!stamm.has(v)) throw new BusinessError(`Konto ${v} gibt es im Kontenstamm nicht.`);
  if (!abJahr) throw new BusinessError('Bitte angeben, ab welchem Jahr das neue Konto gilt.');
  await tx`insert into tco.hh_konto_vorgaenger (konto, vorgaenger, ab_jahr) values (${konto}, ${v}, ${abJahr})
           on conflict (konto) do update set vorgaenger = excluded.vorgaenger, ab_jahr = excluded.ab_jahr`;
}

// ---------------------------------------------------------------------------
// Statusfolge und Nachtrag
// ---------------------------------------------------------------------------

/**
 * Beschließen (Entwurf → vom Vorstand beschlossen) bzw. genehmigen (→ von der Mitgliederversammlung genehmigt).
 * Mit dem Beschluss wird der berechnete Monatsverlauf festgeschrieben – die Fassung ändert sich danach nicht mehr,
 * auch wenn neue Buchungen den Jahresverlauf verschieben.
 */
export async function statusSetzen(tx: Db, id: number, ziel: 'BESCHLOSSEN' | 'GENEHMIGT', datum: string, benutzer: string, heute = heuteText()): Promise<PlanKopf> {
  const [r] = await tx.unsafe(`select ${PLAN_FELDER} from tco.hh_plan where id = $1 for update`, [id]);
  if (!r) throw new BusinessError(`Haushaltsplan ${id} nicht gefunden.`, 404);
  const plan = kopf(r);
  if (ziel === 'BESCHLOSSEN') {
    if (plan.status !== 'ENTWURF') throw new BusinessError(`Der Haushaltsplan ${plan.jahr} ist bereits ${plan.status_text}.`);
    const sicht = await planLesen(tx, id, heute);
    if (!sicht.positionen.length) throw new BusinessError('Ein Haushaltsplan ohne Konten kann nicht beschlossen werden.');
    for (const p of sicht.positionen) if (!p.monate_fest) await monateSchreiben(tx, id, p.konto, p.monate, false);
    // welche Projekte mit welchen Werten eingerechnet sind, gehört zur Fassung
    await planProjekteFestschreiben(tx, plan);
    await tx`update tco.hh_plan set status = 'BESCHLOSSEN', beschlossen_am = ${datum}, beschlossen_von = ${benutzer} where id = ${id}`;
  } else {
    if (plan.status !== 'BESCHLOSSEN') throw new BusinessError(plan.status === 'ENTWURF' ? 'Der Haushaltsplan muss zuerst vom Vorstand beschlossen werden.' : `Der Haushaltsplan ${plan.jahr} ist bereits genehmigt.`);
    await tx`update tco.hh_plan set status = 'GENEHMIGT', genehmigt_am = ${datum}, genehmigt_von = ${benutzer} where id = ${id}`;
  }
  return kopfLesen(tx, id);
}

/** Nachtrag: neue Fassung als Entwurf mit Begründung, übernimmt Positionen, Monatswerte und Vorhaben der beschlossenen Fassung */
export async function nachtragAnlegen(tx: Db, id: number, begruendung: string, benutzer: string, heute = heuteText()): Promise<number> {
  const plan = await kopfLesen(tx, id);
  if (plan.status === 'ENTWURF') throw new BusinessError('Ein Entwurf wird direkt geändert – ein Nachtrag ist erst nach dem Beschluss nötig.');
  if (!begruendung.trim()) throw new BusinessError('Bitte den Nachtrag begründen.');
  const [neueste] = await tx`select id, fassung, status from tco.hh_plan where jahr = ${plan.jahr} order by fassung desc limit 1`;
  if (neueste.status === 'ENTWURF') throw new BusinessError(`Für ${plan.jahr} gibt es bereits einen Nachtrag im Entwurf (Fassung ${neueste.fassung}).`);
  if (Number(neueste.id) !== id) throw new BusinessError(`Ein Nachtrag geht von der jüngsten Fassung aus (Fassung ${neueste.fassung}).`);
  const [n] = await tx`insert into tco.hh_plan (jahr, fassung, status, begruendung, preissteigerung, mindestreserve, tilgung, anfangsbestand, stand, notiz, angelegt_von)
                       values (${plan.jahr}, ${plan.fassung + 1}, 'ENTWURF', ${begruendung.trim()}, ${plan.preissteigerung}, ${plan.mindestreserve}, ${plan.tilgung},
                               ${plan.anfangsbestand}, ${heute}, ${plan.notiz}, ${benutzer}) returning id`;
  await tx`insert into tco.hh_position (plan_id, konto, methode, vorschlag, planwert, zuschlag, notiz, manuell)
           select ${n.id}, konto, methode, vorschlag, planwert, zuschlag, notiz, manuell from tco.hh_position where plan_id = ${id}`;
  // Der Monatsverlauf der beschlossenen Fassung bleibt die Grundlage des Nachtrags – als festgelegter Verlauf
  await tx`insert into tco.hh_monat (plan_id, konto, monat, betrag, von_hand) select ${n.id}, konto, monat, betrag, von_hand from tco.hh_monat where plan_id = ${id}`;
  await tx`insert into tco.hh_vorhaben (plan_id, bezeichnung, art, monat, betrag, konto, projekt, eingeplant)
           select ${n.id}, bezeichnung, art, monat, betrag, konto, projekt, eingeplant from tco.hh_vorhaben where plan_id = ${id} order by id`;
  await planProjekteKopieren(tx, id, Number(n.id));
  return Number(n.id);
}

/** Projekt im Entwurf ein- oder ausrechnen (null = Vorgabe nach dem Status des Projekts) */
export async function projektEinrechnen(tx: Db, id: number, projektId: number, einrechnen: boolean | null): Promise<void> {
  await entwurf(tx, id);
  await planProjektSetzen(tx, id, projektId, einrechnen);
}

/** Nur ein Entwurf lässt sich löschen */
export async function planLoeschen(tx: Db, id: number): Promise<PlanKopf> {
  const plan = await entwurf(tx, id);
  await tx`delete from tco.hh_vorhaben where plan_id = ${id}`;
  await tx`delete from tco.hh_position where plan_id = ${id}`;
  await tx`delete from tco.hh_plan where id = ${id}`;
  return plan;
}

// ---------------------------------------------------------------------------
// Soll-Ist im laufenden Jahr
// ---------------------------------------------------------------------------

export interface SollIstZeile {
  konto: string; name: string; art: 'E' | 'A'; bereich: Bereich | ''; bereich_text: string;
  /** ist und hochrechnung ohne Projektbuchungen; projekt = im Jahr auf Projekte gebucht (getrennt ausgewiesen, zählt nicht gegen das Budget des Kontos) */
  plan: number; ist: number; projekt: number; hochrechnung: number; hoch_art: Hochrechnung['art'] | 'KEINE'; geplant: boolean; bewertung: Bewertung;
}
export interface SollIst {
  jahr: number; plan: PlanKopf | null; vorlaeufig: boolean; stand_monat: number; stand_text: string;
  zeilen: SollIstZeile[];
  summen: Record<'E' | 'A', { plan: number; ist: number; hochrechnung: number; bewertung: Bewertung }>;
  ergebnis: { plan: number; ist: number; hochrechnung: number };
  /** aufgelaufene Monatswerte: Plan für alle zwölf Monate, Ist bis zum laufenden Monat */
  verlauf: Record<'E' | 'A', { plan: number[]; ist: (number | null)[] }>;
  ueberschritten: number; beobachten: number;
  /** Soll-Ist je Projekt: Ist-Kosten aus den FI-Buchungen mit der Projektnummer gegen das Projektbudget */
  projekte: ProjektSollIst[];
  cfg: Cfg;
}

/** Plan gegen Ist und Hochrechnung zum Jahresende – für die gültige Fassung des Jahres */
export async function sollIst(db: Db, jahr: number, heute = heuteText()): Promise<SollIst> {
  const cfg = await cfgLesen(db);
  const plan = await gueltigerPlan(db, jahr);
  // Grundlage des Folgejahres: ihr Basisjahr ist das betrachtete Jahr – mit Ist, Stand und Hochrechnung
  const g = await grundlageLesen(db, jahr + 1, heute, cfg);
  const sicht = plan ? await planLesen(db, plan.id, heute) : null;
  const hj = Number(heute.slice(0, 4)), hm = Number(heute.slice(5, 7));
  const bisMonat = jahr < hj ? 12 : jahr > hj ? 0 : hm;
  const zeilen: SollIstZeile[] = [];
  const mPlan = { E: null12(), A: null12() }, mIst = { E: null12(), A: null12() };
  const konten = new Set([...(sicht?.positionen.map((p) => p.konto) ?? []), ...g.konten.filter((k) => Math.abs(k.ist_basis) > 0.004 || k.ist_projekt[jahr]).map((k) => k.konto)]);
  for (const konto of konten) {
    const p = sicht?.positionen.find((x) => x.konto === konto);
    const k = g.konten.find((x) => x.konto === konto);
    const art = (p?.art ?? k!.art);
    const vor = sicht?.vorhaben.filter((v) => v.eingeplant && v.konto === konto && v.art === art) ?? [];
    const planwert = runden((p?.planwert ?? 0) + summe(vor.map((v) => v.betrag)));
    const ist = k?.ist_basis ?? 0;
    // die Hochrechnung liegt nie unter dem, was schon gebucht ist
    const hoch = Math.max(k?.hoch?.wert ?? ist, ist);
    (p?.monate ?? null12()).forEach((w, i) => { mPlan[art][i] += w; });
    (k?.monate_basis ?? null12()).forEach((w, i) => { mIst[art][i] += w; });
    const bereich = p?.bereich ?? k?.bereich ?? '';
    zeilen.push({
      konto, name: p?.name ?? k?.name ?? konto, art, bereich, bereich_text: bereichName(bereich), plan: planwert, ist, projekt: k?.ist_projekt[jahr] ?? 0, hochrechnung: runden(hoch),
      hoch_art: k?.hoch?.art ?? 'KEINE', geplant: !!p, bewertung: bewerten(art, planwert, hoch, cfg.toleranz_gelb, cfg.toleranz_rot),
    });
  }
  // Vorhaben stehen im Plan in ihrem Monat – auch die ohne Konto
  for (const v of sicht?.vorhaben ?? []) if (v.eingeplant) mPlan[v.art][v.monat - 1] += v.betrag;
  zeilen.sort((a, b) => (a.art === b.art ? Number(a.konto) - Number(b.konto) || a.konto.localeCompare(b.konto) : a.art === 'E' ? -1 : 1));
  const sum = (art: 'E' | 'A') => {
    const z = zeilen.filter((x) => x.art === art);
    const ohneKonto = summe((sicht?.vorhaben ?? []).filter((v) => v.eingeplant && v.art === art && !v.konto).map((v) => v.betrag));
    const pl = runden(summe(z.map((x) => x.plan)) + ohneKonto), h = summe(z.map((x) => x.hochrechnung));
    return { plan: pl, ist: summe(z.map((x) => x.ist)), hochrechnung: h, bewertung: bewerten(art, pl, h, cfg.toleranz_gelb, cfg.toleranz_rot) };
  };
  const E = sum('E'), A = sum('A');
  const verlauf = (art: 'E' | 'A') => ({
    plan: aufgelaufen(mPlan[art].map(runden)),
    ist: aufgelaufen(mIst[art].map(runden)).map((w, i) => (i < bisMonat ? w : null)),
  });
  return {
    jahr, plan, vorlaeufig: !!plan && plan.status === 'ENTWURF', stand_monat: g.stand_monat,
    stand_text: g.stand_monat >= 12 ? `Jahr ${jahr} abgeschlossen` : g.stand_monat > 0 ? `Hochrechnung aus den Buchungen bis ${MON[g.stand_monat - 1]} ${jahr}` : `noch kein abgeschlossener Monat in ${jahr}`,
    zeilen, summen: { E, A },
    ergebnis: { plan: runden(E.plan - A.plan), ist: runden(E.ist - A.ist), hochrechnung: runden(E.hochrechnung - A.hochrechnung) },
    verlauf: { E: verlauf('E'), A: verlauf('A') },
    ueberschritten: zeilen.filter((z) => z.bewertung.stufe === 'UEBERSCHRITTEN').length,
    beobachten: zeilen.filter((z) => z.bewertung.stufe === 'BEOBACHTEN').length, projekte: await projekteSollIst(db, jahr, cfg), cfg,
  };
}

// ---------------------------------------------------------------------------
// Überwachung: Arbeitsvorrat und Kennzahl (nur Anzeige – in die FI-Buchung wird nicht eingegriffen)
// ---------------------------------------------------------------------------

/** Überschrittene Budgets des laufenden Jahres – nur gegen eine beschlossene Fassung, ein Entwurf ist noch kein Maßstab */
export async function ueberschreitungen(db: Db, heute = heuteText()): Promise<{ jahr: number; plan: PlanKopf | null; zeilen: SollIstZeile[]; beobachten: number }> {
  const jahr = Number(heute.slice(0, 4));
  const plan = await gueltigerPlan(db, jahr);
  if (!plan || plan.status === 'ENTWURF' || !funktionAktiv(F_UEBERWACHUNG)) return { jahr, plan: null, zeilen: [], beobachten: 0 };
  const s = await sollIst(db, jahr, heute);
  return { jahr, plan, zeilen: s.zeilen.filter((z) => z.bewertung.stufe === 'UEBERSCHRITTEN' && z.art === 'A'), beobachten: s.beobachten };
}

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Arbeitsvorrat des Kassenwarts: je überschrittenem Ausgabenbudget ein Eintrag */
export async function aufgaben(db: Db, heute = heuteText()): Promise<Aufgabe[]> {
  const u = await ueberschreitungen(db, heute);
  return u.zeilen.map((z) => ({
    key: `HH:${z.konto}`, bereich: 'Kassenwart', icon: 'expense-report', state: 'Negative' as const,
    titel: `Budget überschritten: ${z.konto} ${z.name}`,
    text: z.geplant
      ? `Plan ${u.jahr}: ${eur(z.plan)} € · gebucht ${eur(z.ist)} € · Hochrechnung ${eur(z.hochrechnung)} €${z.bewertung.prozent !== null ? ` (${z.bewertung.prozent > 0 ? '+' : ''}${z.bewertung.prozent.toLocaleString('de-DE')} %)` : ''}`
      : `Im Haushaltsplan ${u.jahr} nicht geplant · gebucht ${eur(z.ist)} €`,
    datum: heute, pfad: '/tco/haushalt?tab=sollist', betrag: runden(z.hochrechnung - z.plan),
  }));
}
