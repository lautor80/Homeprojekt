/**
 * WCA Zeitenkontrolle – Prüfregeln K1–K8, P1–P3, T1–T9/T3b, F_*, R1/R2 (Stufen und Meldungen wie Vorlage V3).
 * Arbeitet auf bereits abgeleiteten Einträgen (Eint) und Personentagen; liefert Rohfunde mit globalem Eintragsindex.
 */
import type { Einstellungen, Kategorie, Art, Stufe, Typ } from '../typen.js';
import { WOCHENTAGE, r2, wochentag, zahl } from './datum.js';
import {
  ABS_AUSNAHME, ABS_RE, MAIL_RE, PH_RE, TK_RE, TRAVEL_RE, allgemeinPruefer, internRegex, kundenTreffer, kundenWoerterbuch,
  regelwerkAnalyse, textAnalyse, wortRegex, type KundenToken,
} from './text.js';

/** abgeleiteter Eintrag (alle Daten, nicht nur Zeitraum) */
export interface Eint {
  i: number;
  person: string;
  team: string;
  kat: string;
  acc: string;
  accName: string;
  kunde: string;
  accKey: string;
  ber: string;
  berKey: string;
  key: string;
  pre: string;
  text: string;
  typ: Typ;
  ohneAccount: boolean;
  errorAccount: boolean;
  intern: boolean;
  tage: [string, number][];
  h: number;
}

export interface PersonTag {
  t: number;
  A: number;
  B: number;
  P: number;
  I: number;
  n: number;
}

export interface RohFund {
  regel: string;
  kategorie: Kategorie;
  art: Art;
  stufe: Stufe;
  person: string;
  ei: number | null; // globaler Eintragsindex
  tag: string | null;
  ab: string | null; // Stunden zählen erst ab diesem Tag (K2, R1, R2)
  meldung: string;
}

export interface PruefKontext {
  eintraege: Eint[];
  imZeitraum: Eint[]; // Einträge mit Tagen in a..e
  personTage: Map<string, Map<string, PersonTag>>;
  vornamen: Set<string>;
  einst: Einstellungen;
  a: string;
  e: string; // min(Zeitraumende, Stichtag)
  /** optional: Tag im Zeitraum (bei mehreren Zeiträumen mit Lücken); ohne gilt a..e */
  drin?: (tag: string) => boolean;
  accountAb: string;
  /** Arbeitstag der Person? (Wochentag, im Team, kein Feiertag) */
  istArbeit: (person: string, tag: string) => boolean;
  /** Feiertagsname am Standort der Person */
  feiertag: (person: string, tag: string) => string | null;
  /** Person im Team (von–bis) */
  imTeam: (person: string, tag: string) => boolean;
}

const ERR_RE = /error account|please review|clean ?-?up account/i;

export function istErrorAccount(accName: string, accRoh: string, liste: string): boolean {
  if (!accRoh) return false;
  const l = new Set((liste || '').split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter(Boolean));
  return l.has(accName.toLowerCase()) || l.has(accRoh.toLowerCase()) || ERR_RE.test(accName);
}

export function pruefen(k: PruefKontext): RohFund[] {
  const { einst, a, e } = k;
  const aus = einst.aus || {};
  const funde: RohFund[] = [];
  const add = (f: Omit<RohFund, 'ab'> & { ab?: string | null }) => {
    if (aus[f.regel]) return;
    funde.push({ ab: null, ...f });
  };
  const intRe = internRegex(einst.internMuster);
  const recurRe = wortRegex(einst.regeltermine);
  const allgemein = allgemeinPruefer(einst.allgemeinZusatz);
  const istRegeltermin = (s: string) => !!recurRe && recurRe.test(s);
  const drin = k.drin ?? (() => true);
  const tageIn = (x: Eint) => x.tage.filter(([t]) => t >= a && t <= e && drin(t));

  // --- Lernschritte über alle Einträge ---------------------------------------------------------
  const byKey = new Map<string, Map<string, { h: number; x: Eint }>>();
  const byPre = new Map<string, Map<string, number>>();
  const custPre = new Set<string>();
  const kunden = new Set<string>();
  for (const x of k.eintraege) {
    if (x.kunde && !x.intern && !/timetoact/i.test(x.kunde)) kunden.add(x.kunde);
    if (x.typ === 'A' || x.errorAccount || x.ohneAccount || !x.key) continue;
    let m = byKey.get(x.key);
    if (!m) byKey.set(x.key, (m = new Map()));
    const v = m.get(x.acc);
    if (v) v.h += x.h; else m.set(x.acc, { h: x.h, x });
    if (x.pre) {
      let p = byPre.get(x.pre);
      if (!p) byPre.set(x.pre, (p = new Map()));
      const c = x.intern ? '(intern)' : x.kunde;
      p.set(c, (p.get(c) ?? 0) + x.h);
      if (x.typ === 'B' && !x.intern && !/timetoact/i.test(x.kunde) && !(intRe && intRe.test(x.pre))) custPre.add(x.pre);
    }
  }
  const preDom = new Map<string, { kunde: string; anteil: number }>();
  for (const [pre, m] of byPre) {
    const summe = [...m.values()].reduce((n, v) => n + v, 0);
    const [top, h] = [...m.entries()].sort((x, y) => y[1] - x[1])[0];
    if (summe >= 16 && h / summe >= 0.85 && top !== '(intern)') preDom.set(pre, { kunde: top, anteil: h / summe });
  }
  const wb: KundenToken[] = kundenWoerterbuch([...kunden], einst.aliasse);

  // T6: gleicher Text je Person über alle Einträge ohne A
  const gleich = new Map<string, { tage: Set<string>; h: number }>();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const x of k.eintraege) {
    if (x.typ === 'A' || !x.text.trim()) continue;
    const g = `${x.person}\u0000${norm(x.text)}`;
    let v = gleich.get(g);
    if (!v) gleich.set(g, (v = { tage: new Set(), h: 0 }));
    for (const [t, h] of x.tage) { v.tage.add(t); v.h += h; }
  }

  const wortRegeln = Object.entries(einst.wortRegeln || {}).map(([id, w]) => ({ id, w, re: wortRegex(w.woerter) }));

  // --- Eintragsregeln -----------------------------------------------------------------------------
  for (const x of k.imZeitraum) {
    const tz = tageIn(x);
    if (!tz.length) continue;
    const bill = x.typ === 'B';
    const p = x.person;
    const base = { person: p, ei: x.i, tag: null };
    const K = (regel: string, stufe: Stufe, meldung: string, ab?: string) =>
      add({ ...base, regel, kategorie: 'K', art: 'ko', stufe, meldung, ab: ab ?? null });
    const an = textAnalyse(x.text, k.vornamen, allgemein);
    const s = an.s;

    // K1
    if (x.errorAccount) K('K1', 3, `Account „${x.accName}“${x.accKey ? ` (${x.accKey})` : ''} ist ein Error-Account – auf den richtigen Account umbuchen.`);
    // K2
    if (x.ohneAccount && x.typ !== 'A' && tz.some(([t]) => t >= k.accountAb)) K('K2', 2, 'Buchung ohne Account.', k.accountAb);
    // K3
    if (x.typ !== 'A' && x.key && !x.errorAccount && !x.ohneAccount) {
      const m = byKey.get(x.key);
      if (m && m.size > 1) {
        const [topAcc, top] = [...m.entries()].sort((u, v) => v[1].h - u[1].h)[0];
        if (topAcc !== x.acc) {
          const mixB = (top.x.typ === 'B') !== bill;
          const custDiff = top.x.kunde !== x.kunde && !(top.x.intern && x.intern);
          if (mixB || custDiff) {
            K('K3', custDiff ? 3 : 2, `Ticket ${x.key} läuft sonst auf „${top.x.accName}${top.x.kunde ? ` | ${top.x.kunde}` : ''}“ (${zahl(top.h)} h)${custDiff ? ' – anderer Kunde' : ' – abrechenbar/nicht abrechenbar gemischt'}.`);
          }
        }
      }
    }
    // K4
    if (x.typ !== 'A' && x.typ !== 'P' && x.pre && !x.errorAccount && !x.ohneAccount) {
      const dom = preDom.get(x.pre);
      const eigen = x.intern ? '(intern)' : x.kunde;
      if (dom && eigen !== dom.kunde) {
        K('K4', x.intern ? 1 : 3, `Tickets aus ${x.ber || x.pre} laufen zu ${Math.round(dom.anteil * 100)} % auf ${dom.kunde}, diese Buchung auf ${x.intern ? 'ein internes Konto' : x.kunde}.`);
      }
    }
    // K5
    if (s && x.typ !== 'A' && x.typ !== 'P' && !x.ohneAccount && !x.errorAccount) {
      const tr = kundenTreffer(s, wb);
      if (tr.length && !tr.some((t) => t.kunde === x.kunde)) {
        const t = tr[0];
        K('K5', x.intern ? 2 : 3, x.intern
          ? `Text nennt „${t.token}“ (${t.kunde}), gebucht auf internes Konto „${x.accName}“ – evtl. abrechenbar.`
          : `Text nennt „${t.token}“ (${t.kunde}), gebucht auf ${x.kunde}.`);
      }
    }
    // K8
    if (s && x.typ !== 'A' && intRe && (intRe.test(x.accKey) || intRe.test(x.berKey) || intRe.test(x.pre))) {
      const proj = x.ber || x.berKey || x.pre || x.accKey;
      const tk = [...s.matchAll(TK_RE)].find((m) => custPre.has(m[1]));
      if (tk) K('K8', 3, `Text nennt Kundenticket ${tk[0]}, gebucht auf internes Projekt „${proj}“ (Account „${x.accName}“).`);
      else {
        const tr = kundenTreffer(s, wb);
        if (tr.length) K('K8', 2, `Text nennt „${tr[0].token}“ (${tr[0].kunde}), gebucht auf internes Projekt „${proj}“ (Account „${x.accName}“).`);
      }
    }
    // K6
    if (s && x.typ !== 'A') {
      const m = ABS_RE.exec(s);
      if (m && !ABS_AUSNAHME.test(s) && (/^(lunch|mittag|pause)/i.test(m[1]) || an.words <= 3 || m.index === 0)) {
        K('K6', bill ? 3 : 2, `Text enthält „${m[0]}“, gebucht auf ${bill ? 'abrechenbares Konto' : 'Arbeitskonto'} „${x.accName}“.`);
      }
    }
    // K7
    if (s && bill) {
      const m = TRAVEL_RE.exec(s);
      if (m && !/reise|travel/i.test(x.accName) && !/concur/i.test(s)) K('K7', 1, `Text nennt „${m[0]}“ auf „${x.accName}“.`);
    }
    // P2 (alle Typen)
    for (const [t, v] of tz) {
      if (v > einst.langeBuchung) add({ regel: 'P2', kategorie: 'P', art: 'pl', stufe: 1, person: p, ei: x.i, tag: t, meldung: `${zahl(v)} h in einer Buchung.` });
    }

    if (x.typ === 'A') continue;

    // --- Texte -----------------------------------------------------------------------------------
    const T = (regel: string, art: Art, stufe: number, meldung: string) =>
      add({ ...base, regel, kategorie: 'T', art, stufe: Math.max(1, Math.min(3, stufe)) as Stufe, meldung });
    const bump = bill ? 1 : 0;
    const maxDay = Math.max(...tz.map(([, v]) => v));
    let nsHit = false;
    if (!s || PH_RE.test(s)) { T('T1', 'ns', 2 + bump, s ? `Platzhalter „${s}“.` : 'Kein Text.'); nsHit = true; }
    else if (an.words === 0) { T('T2', 'ns', 2 + bump, 'Nur IDs oder Kürzel, keine Tätigkeit beschrieben.'); nsHit = true; }
    else if (an.spec === 0 && an.names === 0 && (an.ids || an.codes > 0)) T('T3b', 'ns', 1, 'ID vorhanden, Tätigkeit nur allgemein beschrieben.');
    else if (an.spec === 0 && an.names === 0) { T('T3', 'ns', 1 + bump + (maxDay >= einst.duennH ? 1 : 0), 'Nur Allgemeinbegriffe, kein konkreter Gegenstand.'); nsHit = true; }
    else if (an.spec === 0 && an.names > 0 && an.words <= 4) { T('T9', 'ns', 1 + bump, 'Nur Personenname(n), kein Thema.'); nsHit = true; }

    if (s && MAIL_RE.test(x.text)) T('T4', 'fr', 2 + bump, 'Einladungs- oder Mailtext statt Tätigkeitsbeschreibung.');

    const wortText = (w: number) => `${w} ${w === 1 ? 'Wort' : 'Worte'} für ${zahl(maxDay)} h an einem Tag.`;
    if (s && !nsHit && an.words <= einst.duennWoerter && maxDay >= einst.duennH) T('T5', 'ns', 2 + bump, wortText(an.words));
    else if (s && !nsHit && an.words <= 2 && maxDay >= 2) T('T5', 'ns', 1, wortText(an.words));

    if (s) {
      const g = gleich.get(`${p}\u0000${norm(x.text)}`);
      if (g && g.tage.size >= einst.wiederholungTage && g.h >= einst.wiederholungMinH && !istRegeltermin(s)) {
        T('T6', 'ns', 1 + bump, `Gleicher Text an ${g.tage.size} Tagen (${zahl(g.h)} h).`);
      }
    }

    if (s && !nsHit) {
      const nt = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const na = x.accName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (nt.length >= 3 && na.length >= 3 && (na.includes(nt) || (nt.includes(na) && nt.length - na.length <= 3))) {
        T('T8', 'ns', 1, `Text entspricht dem Account „${x.accName}“.`);
      }
    }

    if (s) {
      for (const { id, w, re } of wortRegeln) {
        if (!re || (w.nurAbrechenbar && !bill)) continue;
        const stufe = bill ? w.stufeBillable : w.stufeIntern;
        if (!stufe) continue;
        const m = re.exec(s);
        if (m) T(id, w.art, stufe, w.art === 'ns' ? `„${m[0]}“ sagt nichts über die Tätigkeit.` : `„${m[0]}“ lädt zu Rückfragen ein.`);
      }
    }

    // --- Regelwerk -------------------------------------------------------------------------------
    if (einst.regelwerkAn && s && tz.some(([t]) => t >= einst.regelwerkAb) && !istRegeltermin(s)) {
      const rw = regelwerkAnalyse(s);
      const R = (regel: string, stufe: Stufe, meldung: string) =>
        add({ ...base, regel, kategorie: 'R', art: 're', stufe, meldung, ab: einst.regelwerkAb });
      if (rw.wc < einst.regelwerkMinWoerter) R('R1', bill ? 2 : 1, `${rw.wc} ${rw.wc === 1 ? 'Wort' : 'Worte'} (mindestens ${einst.regelwerkMinWoerter}).`);
      if (einst.regelwerkIdBillable && bill && !rw.lead) R('R2', 2, 'Text beginnt nicht mit „<ID>: “.');
    }
  }

  // --- Tagesregeln P1, P3 ------------------------------------------------------------------------
  for (const [p, tage] of k.personTage) {
    for (const [t, pt] of tage) {
      if (t < a || t > e || !drin(t)) continue;
      if (pt.t > einst.langerTag) {
        add({ regel: 'P1', kategorie: 'P', art: 'pl', stufe: pt.t > einst.langerTag + 2 ? 2 : 1, person: p, ei: null, tag: t, meldung: `${zahl(pt.t)} h an einem Tag.` });
      }
      const arbeit = r2(pt.t - pt.A);
      if (arbeit > 0 && k.imTeam(p, t) && !k.istArbeit(p, t)) {
        const ft = k.feiertag(p, t);
        const wt = wochentag(t);
        const meldung = ft ? `${zahl(arbeit)} h an ${ft}.`
          : wt >= 5 ? `${zahl(arbeit)} h an einem Wochenende.`
            : `${zahl(arbeit)} h an einem freien Tag (${WOCHENTAGE[wt]}).`;
        add({ regel: 'P3', kategorie: 'P', art: 'pl', stufe: 1, person: p, ei: null, tag: t, meldung });
      }
    }
  }
  return funde;
}
