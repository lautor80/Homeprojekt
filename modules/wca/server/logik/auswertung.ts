/**
 * WCA Zeitenkontrolle – Auswertung (rein, ohne Datenbank).
 *
 * Aus den zusammengeführten Rohdaten werden je Eintrag Typ, Account/Kunde, Team und Schlüssel abgeleitet,
 * je Person Standort, Arbeitstage, Soll je Tag und Zugehörigkeit (von–bis), Feiertage (berechnet, manuell,
 * erkannt), dann Soll/Ist/Offen je Tag, alle Prüfregeln, Fundgruppen, Personensummen und der Rückfrage-Text.
 */
import type {
  Auswertung, AuswEintrag, Einstellungen, Feiertag, FreigabeSchluessel, Fund, FundGruppe, Kategorie, PersonAuswertung, PersonVorgabe,
  RegelInfo, RohEintrag, TagStatus, Typ, Zeitraum,
} from '../typen.js';
import {
  MONATE, OFFEN, arbeitstageZwischen, datumDe, ddmm, isoWocheId, monatsEnde, plusTage, r2, tagKurz, tageVonBis,
  vorherigerArbeitstag, wocheMontag, wochentag, zahl,
} from './datum.js';
import { feiertageBerechnet, feiertageManuell } from './feiertage.js';
import { istErrorAccount, pruefen, type Eint, type PersonTag } from './regeln.js';
import { REGELN } from './standard.js';

export interface AuswertungEingabe {
  eintraege: RohEintrag[]; // bereits zusammengeführt (je Person+Tag gilt die neueste Datei – macht der Server beim Import)
  accKeys: Record<string, string>;
  berKeys: Record<string, string>;
  dateien: number;
  einstellungen: Einstellungen;
  vorgaben: PersonVorgabe[];
  heute: string; // ISO, für Stichtag-Vorschlag
  stichtag?: string;
  zeitraum?: string; // 'YYYY-MM' | 'YYYY-Www' | 'alle', mehrere kommagetrennt; Default Monat des Stichtags
  /** optional: Bereich der Tagesspalten aller Importe (von–bis); sonst aus den Buchungen */
  datenBereich?: { von: string | null; bis: string | null };
  /** freigegebene Texte: Funde dieser Regel zu Rückmeldungen mit diesem Account und Text werden nicht gemeldet */
  freigaben?: FreigabeSchluessel[];
}

/** Text für den Freigabe-Vergleich: getrimmt, Leerraum zusammengefasst, klein */
export const textNorm = (t: string) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Vergleichsschlüssel einer Freigabe (Regel, Account roh, normalisierter Text) */
export const freigabeSchluessel = (f: FreigabeSchluessel) => `${f.regel}\u0000${(f.acc || '').trim()}\u0000${textNorm(f.text)}`;

// ---------------------------------------------------------------------------
// Ableitungen je Eintrag
// ---------------------------------------------------------------------------

/** Team kürzen: Suffix „(#…)“ und Präfix „WCA |“ entfernen */
export function teamKurz(t: string): string {
  return (t || '').replace(/\s*\(#[^)]*\)\s*$/, '').trim().replace(/^WCA\s*\|\s*/, '').trim() || 'Ohne Team';
}

export function typAbleiten(kat: string, accName: string, pre: string, text: string): Typ {
  const abw = /^ATG Absence/i.test(accName) || pre === 'ATGABS' || /^absence:/i.test(text.trim());
  if (abw) return 'A';
  if (/^(abrechenbar|billable)/i.test(kat.trim())) return 'B';
  if (/PRESAL/i.test(pre) || /presales/i.test(accName)) return 'P';
  return 'I';
}

export function eintragAbleiten(r: RohEintrag, i: number, accKeys: Record<string, string>, berKeys: Record<string, string>, errorListe: string): Eint {
  const acc = (r.acc || '').trim();
  const p = acc.indexOf('|');
  const accName = (p >= 0 ? acc.slice(0, p) : acc).trim() || 'Kein Account';
  const kunde = p >= 0 ? acc.slice(p + 1).trim() : '';
  const pre = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(r.key || '')?.[1] ?? '';
  const ohneAccount = !acc || /^kein(\/e)? account$/i.test(acc);
  const tage = [...r.tage].filter(([, v]) => v !== 0).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return {
    i,
    person: r.person,
    team: teamKurz(r.team),
    kat: r.kat || '',
    acc,
    accName,
    kunde,
    accKey: accKeys[acc] ?? '',
    ber: r.ber || '',
    berKey: berKeys[r.ber] ?? '',
    key: r.key || '',
    pre,
    text: r.text || '',
    typ: typAbleiten(r.kat || '', accName, pre, r.text || ''),
    ohneAccount,
    errorAccount: !ohneAccount && istErrorAccount(accName, acc, errorListe),
    intern: !kunde || /internal|\bintern\b/i.test(kunde),
    tage,
    h: r2(tage.reduce((n, [, v]) => n + v, 0)),
  };
}

// ---------------------------------------------------------------------------
// Zeiträume
// ---------------------------------------------------------------------------

export function zeitraumLesen(id: string, minTag: string | null, stichtag: string): Zeitraum | null {
  let m = /^(\d{4})-(\d{2})$/.exec(id);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return { id, text: `${MONATE[Number(m[2]) - 1]} ${m[1]}`, von: `${id}-01`, bis: monatsEnde(id) };
  }
  m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 53) {
    const von = wocheMontag(Number(m[1]), Number(m[2]));
    const bis = plusTage(von, 6);
    return { id, text: `KW ${Number(m[2])} (${ddmm(von)}–${ddmm(bis)})`, von, bis };
  }
  if (id === 'alle') return { id, text: 'Alles bis Stichtag', von: minTag && minTag < stichtag ? minTag : stichtag, bis: stichtag };
  return null;
}

/**
 * Einen oder mehrere Zeiträume (kommagetrennt) lesen. Mehrere werden zu einem Zeitraum mit Teilbereichen
 * zusammengefasst (überlappende/angrenzende verschmolzen); „alle“ umfasst alles. Ungültige Teile entfallen.
 */
export function zeitraeumeLesen(ids: string, minTag: string | null, stichtag: string): Zeitraum | null {
  const liste: Zeitraum[] = [];
  for (const id of ids.split(',').map((x) => x.trim()).filter(Boolean)) {
    const z = zeitraumLesen(id, minTag, stichtag);
    if (z && !liste.some((x) => x.id === z.id)) liste.push(z);
  }
  if (!liste.length) return null;
  const alle = liste.find((x) => x.id === 'alle');
  if (alle) return alle;
  if (liste.length === 1) return liste[0];
  liste.sort((x, y) => (x.von < y.von ? -1 : x.von > y.von ? 1 : x.bis < y.bis ? -1 : 1));
  const teile: { von: string; bis: string }[] = [];
  for (const z of liste) {
    const l = teile[teile.length - 1];
    if (l && z.von <= plusTage(l.bis, 1)) { if (z.bis > l.bis) l.bis = z.bis; } else teile.push({ von: z.von, bis: z.bis });
  }
  return {
    id: liste.map((x) => x.id).join(','),
    text: liste.map((x) => x.text).join(' + '),
    von: teile[0].von,
    bis: teile.reduce((m, t) => (t.bis > m ? t.bis : m), teile[0].bis),
    teile,
  };
}

/** Liegt der Tag in einem der Teilbereiche (ohne Teile: zwischen von und bis)? */
export function imZeitraumTag(z: Zeitraum, tag: string): boolean {
  return z.teile ? z.teile.some((t) => tag >= t.von && tag <= t.bis) : tag >= z.von && tag <= z.bis;
}

function zeitraeumeListe(minTag: string | null, stichtag: string, buchMonate: Set<string>): Zeitraum[] {
  const r: Zeitraum[] = [];
  const stMonat = stichtag.slice(0, 7);
  const ab = (minTag && minTag < stichtag ? minTag : stichtag).slice(0, 7);
  for (let mo = stMonat; mo >= ab;) {
    if (mo === stMonat || buchMonate.has(mo)) r.push(zeitraumLesen(mo, minTag, stichtag)!);
    const [j, m] = mo.split('-').map(Number);
    mo = m === 1 ? `${j - 1}-12` : `${j}-${String(m - 1).padStart(2, '0')}`;
  }
  const wochen: string[] = [];
  for (let t = stichtag; t > plusTage(stichtag, -42); t = plusTage(t, -1)) {
    const w = isoWocheId(t);
    if (!wochen.includes(w)) wochen.push(w);
  }
  for (const w of wochen) r.push(zeitraumLesen(w, minTag, stichtag)!);
  r.push(zeitraumLesen('alle', minTag, stichtag)!);
  return r;
}

// ---------------------------------------------------------------------------
// Personenableitung
// ---------------------------------------------------------------------------

interface PersAbl {
  person: string;
  team: string;
  teams: string[];
  standort: string;
  standortAbgeleitet: string;
  sollTag: number;
  arbeitstage: number[];
  von: string;
  bis: string; // OFFEN = offen
  letzte: string | null;
  ausgeblendet: boolean;
}

const MO_FR = [0, 1, 2, 3, 4];

function standortAbleiten(eint: Eint[]): string {
  const g = new Map<string, number>();
  for (const x of eint) {
    let s = /^W([A-Z]{2})(INT|PRESAL)/.exec(x.pre)?.[1] ?? /^W([A-Z]{2})(INT|PRESAL)/.exec(x.accKey)?.[1] ?? '';
    if (!s) s = /Sdn\.? Bhd/i.test(x.kunde) ? 'MY' : /Consulting Asia/i.test(x.kunde) ? 'SG' : /Consulting Corp/i.test(x.kunde) ? 'US' : '';
    if (s) g.set(s, (g.get(s) ?? 0) + x.h);
  }
  const top = [...g.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'DE';
}

/** Arbeitstage und Soll je Tag aus den letzten (max. 10) Buchungswochen bis zum Stichtag */
function arbeitszeitAbleiten(tage: Map<string, PersonTag>, stichtag: string): { arbeitstage: number[]; sollTag: number } {
  const sortiert = [...tage.keys()].filter((t) => t <= stichtag && tage.get(t)!.t > 0).sort().reverse();
  const wochen = new Map<string, string[]>();
  for (const t of sortiert) {
    const w = isoWocheId(t);
    if (!wochen.has(w)) {
      if (wochen.size >= 10) break;
      wochen.set(w, []);
    }
    wochen.get(w)!.push(t);
  }
  const gueltig = [...wochen.values()].filter((l) => l.some((t) => { const p = tage.get(t)!; return p.t - p.A > 0; }));
  let arbeitstage = MO_FR;
  if (gueltig.length >= 4) {
    const wt: number[] = [];
    for (let d = 0; d < 7; d++) {
      const n = gueltig.filter((l) => l.some((t) => wochentag(t) === d)).length;
      if (n / gueltig.length >= (d < 5 ? 0.45 : 0.6)) wt.push(d);
    }
    arbeitstage = wt.length ? wt : MO_FR;
  }
  const tots = gueltig.flat().filter((t) => { const p = tage.get(t)!; return p.A === 0 && p.t > 0 && arbeitstage.includes(wochentag(t)); })
    .map((t) => tage.get(t)!.t).sort((a, b) => a - b);
  let sollTag = 8;
  if (tots.length >= 5) sollTag = Math.min(8, Math.max(2, Math.round(tots[Math.floor(tots.length / 2)] * 2) / 2));
  return { arbeitstage, sollTag };
}

// ---------------------------------------------------------------------------
// Feiertagskalender
// ---------------------------------------------------------------------------

class Kalender {
  private cache = new Map<string, Map<string, Feiertag>>();
  private manuell: { standort: string; tag: string; name: string }[];
  readonly erkannt = new Map<string, Map<string, Feiertag>>();
  constructor(private bundesland: string, manuellText: string) {
    this.manuell = feiertageManuell(manuellText);
  }
  private jahr(standort: string, jahr: number): Map<string, Feiertag> {
    const k = `${standort}|${jahr}`;
    let m = this.cache.get(k);
    if (!m) {
      m = new Map();
      for (const f of this.manuell) {
        if ((f.standort === '*' || f.standort === standort) && f.tag.startsWith(String(jahr))) m.set(f.tag, { standort, tag: f.tag, name: f.name, quelle: 'manuell' });
      }
      for (const f of feiertageBerechnet(standort, jahr, this.bundesland)) m.set(f.tag, { standort, tag: f.tag, name: f.name, quelle: 'berechnet' });
      this.cache.set(k, m);
    }
    return m;
  }
  get(standort: string, tag: string): Feiertag | undefined {
    return this.jahr(standort, Number(tag.slice(0, 4))).get(tag) ?? this.erkannt.get(standort)?.get(tag);
  }
  imBereich(standort: string, a: string, b: string): Feiertag[] {
    const r: Feiertag[] = [];
    for (const t of tageVonBis(a, b)) { const f = this.get(standort, t); if (f) r.push(f); }
    return r;
  }
}

// ---------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------

export function stichtagVorschlag(heute: string, minTag: string | null, maxTag: string | null): string {
  let st = vorherigerArbeitstag(heute);
  if (maxTag && st > maxTag) {
    st = maxTag;
    while (wochentag(st) >= 5 && (!minTag || st > minTag)) st = plusTage(st, -1);
  }
  if (minTag && st < minTag) st = minTag;
  return st;
}

function vorname(person: string): string {
  const n = person.includes(',') ? person.split(',')[1] : person;
  return n.trim().split(/\s+/)[0] ?? '';
}

export function auswerten(ein: AuswertungEingabe): Auswertung {
  const einst = ein.einstellungen;
  const tol = einst.toleranz;
  const alle = ein.eintraege.map((r, i) => eintragAbleiten(r, i, ein.accKeys, ein.berKeys, einst.errorAccounts));

  // Personentage und Datenbereich
  const personTage = new Map<string, Map<string, PersonTag>>();
  const jePerson = new Map<string, Eint[]>();
  let minTag: string | null = ein.datenBereich?.von ?? null;
  let maxTag: string | null = ein.datenBereich?.bis ?? null;
  const buchMonate = new Set<string>();
  for (const x of alle) {
    if (!jePerson.has(x.person)) jePerson.set(x.person, []);
    jePerson.get(x.person)!.push(x);
    let m = personTage.get(x.person);
    if (!m) personTage.set(x.person, (m = new Map()));
    for (const [t, v] of x.tage) {
      let pt = m.get(t);
      if (!pt) m.set(t, (pt = { t: 0, A: 0, B: 0, P: 0, I: 0, n: 0 }));
      pt.t = r2(pt.t + v);
      pt[x.typ] = r2(pt[x.typ] + v);
      pt.n++;
      if (!minTag || t < minTag) minTag = t;
      if (!maxTag || t > maxTag) maxTag = t;
      buchMonate.add(t.slice(0, 7));
    }
  }

  const vorschlag = stichtagVorschlag(ein.heute, minTag, maxTag);
  const stichtag = ein.stichtag && /^\d{4}-\d{2}-\d{2}$/.test(ein.stichtag) ? ein.stichtag : vorschlag;
  const zeitraum = (ein.zeitraum && zeitraeumeLesen(ein.zeitraum, minTag, stichtag)) || zeitraumLesen(stichtag.slice(0, 7), minTag, stichtag)!;
  const a = zeitraum.von;
  const e = zeitraum.bis < stichtag ? zeitraum.bis : stichtag;
  /** Tag im (ggf. zusammengesetzten) Zeitraum – ohne Stichtagsgrenze */
  const drin = (t: string) => imZeitraumTag(zeitraum, t);
  /** Tag im Zeitraum bis zum Stichtag */
  const zaehlt = (t: string) => t >= a && t <= e && drin(t);

  // Personen ableiten
  const vorgaben = new Map(ein.vorgaben.map((v) => [v.person, v]));
  const pers = new Map<string, PersAbl>();
  for (const [person, eint] of jePerson) {
    const tage = personTage.get(person)!;
    const gebucht = [...tage.keys()].filter((t) => tage.get(t)!.t !== 0).sort();
    const erste = gebucht[0] ?? eint[0]?.tage[0]?.[0] ?? a;
    const letzteAll = gebucht[gebucht.length - 1] ?? erste;
    const bisStichtag = gebucht.filter((t) => t <= stichtag);
    const letzte = bisStichtag[bisStichtag.length - 1] ?? null;
    const bis = letzteAll <= stichtag && arbeitstageZwischen(letzteAll, stichtag) > 15 ? letzteAll : OFFEN;
    // Team der jüngsten Buchung (bis Stichtag, sonst überhaupt); bei gleichem Datum mehr Stunden
    let teamTag = '', teamH = -1, team = 'Ohne Team';
    const grenze = letzte ?? letzteAll;
    for (const x of eint) for (const [t, v] of x.tage) {
      if (t > grenze) continue;
      if (t > teamTag || (t === teamTag && v > teamH)) { teamTag = t; teamH = v; team = x.team; }
    }
    const az = arbeitszeitAbleiten(tage, stichtag);
    const abg = standortAbleiten(eint);
    const v = vorgaben.get(person);
    pers.set(person, {
      person,
      team,
      teams: [...new Set(eint.map((x) => x.team))].sort((x, y) => x.localeCompare(y, 'de')),
      standortAbgeleitet: abg,
      standort: v?.standort ? v.standort.toUpperCase() : abg,
      sollTag: v?.sollTag != null && v.sollTag > 0 ? v.sollTag : az.sollTag,
      arbeitstage: v?.arbeitstage && v.arbeitstage.length ? [...v.arbeitstage].sort() : az.arbeitstage,
      von: v?.von || erste,
      bis: v?.bis || bis,
      letzte,
      ausgeblendet: !!v?.ausblenden,
    });
  }

  // Feiertage: berechnet + manuell, dann erkannt (kaum jemand gebucht)
  const kal = new Kalender(einst.bundesland, einst.feiertage);
  const standorte = [...new Set([...pers.values()].map((p) => p.standort))].sort();
  if (minTag) {
    const ende = vorherigerArbeitstag(vorherigerArbeitstag(stichtag));
    for (let t = minTag; t <= ende; t = plusTage(t, 1)) {
      const wt = wochentag(t);
      if (wt >= 5) continue;
      for (const s of standorte) {
        if (kal.get(s, t)) continue;
        const aktiv = [...pers.values()].filter((p) => p.standort === s && !p.ausgeblendet && p.von <= t && t <= p.bis && p.arbeitstage.includes(wt));
        if (aktiv.length < 3) continue;
        const mit = aktiv.filter((p) => (personTage.get(p.person)?.get(t)?.t ?? 0) > 0).length;
        if (mit / aktiv.length <= 0.2) {
          if (!kal.erkannt.has(s)) kal.erkannt.set(s, new Map());
          kal.erkannt.get(s)!.set(t, { standort: s, tag: t, name: 'vermutlich Feiertag (kaum jemand gebucht)', quelle: 'erkannt' });
        }
      }
    }
  }
  const imTeam = (p: string, t: string) => { const x = pers.get(p); return !!x && x.von <= t && t <= x.bis; };
  const feiertag = (p: string, t: string) => { const x = pers.get(p); return x ? kal.get(x.standort, t)?.name ?? null : null; };
  const istArbeit = (p: string, t: string) => {
    const x = pers.get(p);
    return !!x && x.arbeitstage.includes(wochentag(t)) && x.von <= t && t <= x.bis && !kal.get(x.standort, t);
  };

  // Account-Pflicht ab
  let accountAb = einst.accountPflichtAb;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(accountAb || '')) {
    const monate = new Map<string, { ohne: number; ges: number }>();
    for (const x of alle) {
      if (x.typ === 'A') continue;
      for (const [t, v] of x.tage) {
        const m = t.slice(0, 7);
        const o = monate.get(m) ?? { ohne: 0, ges: 0 };
        o.ges += v;
        if (x.ohneAccount) o.ohne += v;
        monate.set(m, o);
      }
    }
    let start = '';
    for (const m of [...monate.keys()].sort().reverse()) {
      const o = monate.get(m)!;
      if (o.ges > 0 && o.ohne / o.ges < 0.1) start = m; else break;
    }
    accountAb = start ? `${start}-01` : OFFEN;
  }

  // Vornamen aller Personen + ole, tom
  const vornamen = new Set(['ole', 'tom']);
  for (const p of jePerson.keys()) { const v = vorname(p).toLowerCase(); if (v.length >= 3) vornamen.add(v); }

  // Einträge im Zeitraum
  const imZeitraum = alle.filter((x) => x.tage.some(([t]) => zaehlt(t)));
  const index = new Map<number, number>();
  const eintraege: AuswEintrag[] = imZeitraum.map((x, j) => {
    index.set(x.i, j);
    const tage = x.tage.filter(([t]) => zaehlt(t));
    return {
      person: x.person, team: pers.get(x.person)?.team ?? x.team, typ: x.typ, kat: x.kat, accName: x.accName, kunde: x.kunde,
      accKey: x.accKey, ber: x.ber, berKey: x.berKey, key: x.key, text: x.text, acc: x.acc, errorAccount: x.errorAccount,
      ohneAccount: x.ohneAccount, intern: x.intern, tage, stunden: r2(tage.reduce((n, [, v]) => n + v, 0)),
    };
  });

  // Prüfen
  const roh = pruefen({ eintraege: alle, imZeitraum, personTage, vornamen, einst, a, e, drin, accountAb, istArbeit, feiertag, imTeam });
  const tippVon = (regel: string) => einst.wortRegeln?.[regel]?.tipp ?? REGELN.find((r) => r.id === regel)?.tipp ?? '';
  const freigabeSet = new Set((ein.freigaben ?? []).map(freigabeSchluessel));
  let freigegeben = 0;
  const funde: Fund[] = [];
  for (const f of roh) {
    if (f.ei !== null && freigabeSet.size) {
      const x = alle[f.ei];
      if (freigabeSet.has(freigabeSchluessel({ regel: f.regel, acc: x.acc, text: x.text }))) {
        if (!pers.get(f.person)?.ausgeblendet) freigegeben++;
        continue;
      }
    }
    let stunden = 0;
    if (f.ei !== null) {
      const x = alle[f.ei];
      if (f.tag) stunden = x.tage.find(([t]) => t === f.tag)?.[1] ?? 0;
      else stunden = x.tage.filter(([t]) => zaehlt(t) && (!f.ab || t >= f.ab)).reduce((n, [, v]) => n + v, 0);
    } else if (f.tag) stunden = personTage.get(f.person)?.get(f.tag)?.t ?? 0;
    funde.push({
      regel: f.regel, kategorie: f.kategorie, art: f.art, stufe: f.stufe, person: f.person,
      eintrag: f.ei === null ? null : index.get(f.ei) ?? null, tag: f.tag, stunden: r2(stunden), meldung: f.meldung, tipp: tippVon(f.regel),
      freigebbar: f.ei !== null,
    });
  }

  // Gruppieren: eine Rückmeldung bzw. ein Personentag = eine Gruppe; gleiche Regel+Tag nur einmal
  const gruppenMap = new Map<string, FundGruppe>();
  for (const f of funde) {
    const id = f.eintrag !== null ? `e${f.eintrag}` : `d${f.person}_${f.tag}`;
    let g = gruppenMap.get(id);
    if (!g) {
      g = { id, person: f.person, team: pers.get(f.person)?.team ?? 'Ohne Team', eintrag: f.eintrag, tag: f.eintrag !== null ? null : f.tag, stufe: f.stufe, stunden: 0, funde: [] };
      gruppenMap.set(id, g);
    }
    if (g.funde.some((x) => x.regel === f.regel && x.tag === f.tag)) continue;
    g.funde.push(f);
    if (f.stufe > g.stufe) g.stufe = f.stufe;
    if (f.stunden > g.stunden) g.stunden = f.stunden;
  }
  const gruppen = [...gruppenMap.values()];
  for (const g of gruppen) {
    if (g.eintrag !== null) g.stunden = Math.max(g.stunden, eintraege[g.eintrag].stunden);
    g.funde.sort((x, y) => y.stufe - x.stufe);
  }
  gruppen.sort((x, y) => y.stufe - x.stufe || y.stunden - x.stunden || x.person.localeCompare(y.person, 'de'));

  // Personensummen
  const personen: PersonAuswertung[] = [];
  for (const p of [...pers.values()].sort((x, y) => x.team.localeCompare(y.team, 'de') || x.person.localeCompare(y.person, 'de'))) {
    const tage = personTage.get(p.person) ?? new Map<string, PersonTag>();
    let soll = 0, ist = 0, offen = 0, fehltage = 0, sollTage = 0, B = 0, P = 0, I = 0, A = 0;
    const tageStatus: TagStatus[] = [];
    for (const t of tageVonBis(a, zeitraum.bis)) {
      if (!drin(t)) continue;
      const pt = tage.get(t) ?? { t: 0, A: 0, B: 0, P: 0, I: 0, n: 0 };
      const wt = wochentag(t);
      const arbeit = istArbeit(p.person, t);
      if (t <= e) {
        ist += pt.t; B += pt.B; P += pt.P; I += pt.I; A += pt.A;
        if (arbeit) {
          soll += p.sollTag;
          sollTage++;
          const diff = p.sollTag - pt.t;
          if (diff > tol) { offen += diff; fehltage++; }
        }
      }
      const ts: TagStatus = { tag: t, status: 'fehlt', soll: 0, B: pt.B, P: pt.P, I: pt.I, A: pt.A, ist: pt.t, offen: 0, hinweis: '' };
      const ft = kal.get(p.standort, t);
      if (t < p.von || t > p.bis) ts.status = 'ausserhalb';
      else if (t > stichtag) { ts.status = 'zukunft'; ts.soll = arbeit ? p.sollTag : 0; ts.hinweis = pt.A > 0 ? 'Abwesenheit' : ''; }
      else if (ft) { ts.status = 'feiertag'; ts.hinweis = ft.name; }
      else if (!p.arbeitstage.includes(wt)) {
        ts.status = pt.t > 0 ? 'frei_gebucht' : 'frei';
        ts.hinweis = wt >= 5 ? 'Wochenende' : 'kein Arbeitstag';
      } else {
        ts.soll = p.sollTag;
        if (pt.A > 0 && pt.A >= p.sollTag - tol && pt.A >= pt.t - 0.01) ts.status = 'abwesend';
        else if (p.sollTag - pt.t <= tol) ts.status = 'vollstaendig';
        else if (pt.t > 0) { ts.status = 'teilweise'; ts.offen = r2(p.sollTag - pt.t); }
        else { ts.status = 'fehlt'; ts.offen = p.sollTag; }
      }
      tageStatus.push(ts);
    }
    const gp = gruppen.filter((g) => g.person === p.person);
    const zaehl = (kats: Kategorie[]): [number, number, number, number] => {
      const r: [number, number, number, number] = [0, 0, 0, 0];
      for (const g of gp) {
        const f = g.funde.filter((x) => kats.includes(x.kategorie));
        if (!f.length) continue;
        r[0]++;
        r[Math.max(...f.map((x) => x.stufe))]++;
      }
      return r;
    };
    const ent = imZeitraum.filter((x) => x.person === p.person && x.typ !== 'A');
    const schlecht = ent.filter((x) => gp.some((g) => g.eintrag === index.get(x.i) && g.funde.some((f) => f.kategorie === 'T'))).length;
    const arbeitszeit = B + P + I;
    const pa: PersonAuswertung = {
      person: p.person, team: p.team, teams: p.teams, standort: p.standort, standortAbgeleitet: p.standortAbgeleitet,
      sollTag: p.sollTag, arbeitstage: p.arbeitstage, von: p.von, bis: p.bis === OFFEN ? null : p.bis, letzteBuchung: p.letzte,
      ausgeblendet: p.ausgeblendet, aktiv: sollTage > 0 || ist > 0,
      soll: r2(soll), ist: r2(ist), offen: r2(offen), fehltage, sollTage, vollstaendig: offen <= tol,
      B: r2(B), P: r2(P), I: r2(I), A: r2(A), billableQuote: arbeitszeit > 0 ? Math.round((B / arbeitszeit) * 10000) / 10000 : null,
      tageStatus, kontierung: zaehl(['K', 'P']), texte: zaehl(['T']), regelwerk: zaehl(['R']),
      eintraegeZeitraum: ent.length, texteUnauffaellig: ent.length ? 1 - schlecht / ent.length : null,
      rueckfrage: '',
    };
    pa.rueckfrage = rueckfrageText(pa, gp, eintraege, a, e, stichtag, zeitraum.teile);
    personen.push(pa);
  }

  // Feiertage im Zeitraum je Standort
  const feiertage: Feiertag[] = [];
  for (const s of standorte) feiertage.push(...kal.imBereich(s, a, zeitraum.bis).filter((f) => drin(f.tag)));

  // Regelinfos (ohne ausgeblendete Personen)
  const sichtbar = funde.filter((f) => !pers.get(f.person)?.ausgeblendet);
  const regelListe = REGELN.filter((r) => !r.id.startsWith('F_') || einst.wortRegeln?.[r.id]);
  for (const [id, w] of Object.entries(einst.wortRegeln ?? {})) {
    if (!regelListe.some((r) => r.id === id)) regelListe.push({ id, kategorie: 'T', art: w.art, name: w.name, erkennung: `Der Text enthält einen Begriff aus der Wortliste „${w.name}“.`, tipp: w.tipp });
  }
  const regeln: RegelInfo[] = regelListe.map((r) => {
    const w = einst.wortRegeln?.[r.id];
    const f = sichtbar.filter((x) => x.regel === r.id);
    return {
      id: r.id, kategorie: r.kategorie, art: w ? w.art : r.art, name: w ? w.name : r.name, erkennung: r.erkennung, tipp: w ? w.tipp : r.tipp,
      aktiv: !einst.aus?.[r.id], anzahl: f.length, stunden: r2(f.reduce((n, x) => n + x.stunden, 0)),
    };
  });

  return {
    stand: { minTag, maxTag, dateien: ein.dateien, personen: pers.size },
    stichtag,
    stichtagVorschlag: vorschlag,
    zeitraum,
    zeitraeume: zeitraeumeListe(minTag, stichtag, buchMonate),
    accountPflichtAb: accountAb,
    personen,
    eintraege,
    gruppen,
    feiertage,
    regeln,
    freigegeben,
  };
}

// ---------------------------------------------------------------------------
// Rückfrage-Text
// ---------------------------------------------------------------------------

function tageText(tage: [string, number][]): string {
  if (!tage.length) return '';
  if (tage.length <= 3) return tage.map(([t]) => tagKurz(t)).join(', ');
  return `${tagKurz(tage[0][0])} – ${tagKurz(tage[tage.length - 1][0])} (${tage.length} Tage)`;
}

function kuerzen(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function rueckfrageText(p: PersonAuswertung, gruppen: FundGruppe[], eintraege: AuswEintrag[], a: string, e: string, stichtag: string,
  teile?: { von: string; bis: string }[]): string {
  const z: string[] = [`Hallo ${vorname(p.person)},`, ''];
  const offen = p.tageStatus.filter((t) => t.tag <= e && (t.status === 'fehlt' || t.status === 'teilweise'));
  const ersterTag = (g: FundGruppe) => (g.eintrag !== null ? eintraege[g.eintrag].tage[0]?.[0] ?? '' : g.tag ?? '');
  const sortiert = [...gruppen].sort((x, y) => (ersterTag(x) < ersterTag(y) ? -1 : ersterTag(x) > ersterTag(y) ? 1 : y.stunden - x.stunden));
  const abschnitt = (kats: Kategorie[]) => {
    const r: string[] = [];
    for (const g of sortiert) {
      const f = g.funde.filter((x) => kats.includes(x.kategorie) && x.stufe >= 2);
      if (!f.length) continue;
      if (r.length >= 20) break;
      let kopf: string;
      if (g.eintrag !== null) {
        const x = eintraege[g.eintrag];
        kopf = `- ${tageText(x.tage)} · ${zahl(g.stunden)} h · ${x.accName}${x.key ? ` (${x.key})` : ''} · „${kuerzen(x.text, 90)}“`;
      } else kopf = `- ${tagKurz(g.tag!)} · ${zahl(g.stunden)} h · Tagessumme`;
      r.push([kopf, ...f.map((x) => `    → ${x.meldung}${x.tipp ? ` ${x.tipp}` : ''}`)].join('\n'));
    }
    return r;
  };
  const ko = abschnitt(['K', 'P']);
  const tx = abschnitt(['T', 'R']);
  const bereiche = teile ? teile.filter((t) => t.von <= e).map((t) => `${datumDe(t.von)}–${datumDe(t.bis < e ? t.bis : e)}`).join(', ') : `${datumDe(a)}–${datumDe(e)}`;
  const zr = `${bereiche}, Stand ${datumDe(stichtag)}`;
  if (!offen.length && !ko.length && !tx.length) {
    z.push(`bei der Prüfung deiner Zeiterfassung (${zr}) ist mir nichts aufgefallen.`, '', 'Alles in Ordnung – danke!');
    return z.join('\n');
  }
  z.push(`bei der Prüfung deiner Zeiterfassung (${zr}) sind mir folgende Punkte aufgefallen:`, '');
  if (offen.length) {
    z.push('Fehlende Zeiten:', ...offen.slice(0, 25).map((t) => `- ${tagKurz(t.tag)}: ${zahl(t.offen)} h offen`));
    if (offen.length > 25) z.push(`- … und ${offen.length - 25} weitere Tage`);
    z.push('');
  }
  if (ko.length) z.push('Kontierung:', ...ko, '');
  if (tx.length) z.push('Rückmeldetexte (bitte konkretisieren – was, woran, mit welchem Ergebnis):', ...tx, '');
  z.push('Danke dir!');
  return z.join('\n');
}
