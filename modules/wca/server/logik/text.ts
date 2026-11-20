/**
 * WCA Zeitenkontrolle – Textanalyse der Rückmeldetexte (Wörter, Inhaltswörter, Namen, Kürzel, IDs),
 * Wortlisten-Regex und Kundenwörterbuch. Konstanten wörtlich aus der Vorlage „Tempo-Prüfung V3“.
 */

export const ISSUE_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

const STOP = new Set(
  ('und oder der die das den dem des ein eine einer eines einem einen mit für fuer von vom zu zum zur im in am an auf bei aus nach über ueber unter vor als auch sowie inkl inkl. bzw bzw. etc etc. ggf ggf. z.b. zb u. u.a. ua via per je mit/ohne sowie bis ab and or the of for to with on in at by from a an as is are be re: wg: aw: fw: fwd: about regarding after before into during some all this that it its our my their we was were been have has had not no also incl including e.g. eg i.e. vs & + - / –')
    .split(' '),
);

const GENERIC_STEMS = 'meeting besprech abstimm absprach termin call telko telefon phone jour daily dailys weekly sync standup stand-up status update review workshop ws mail e-mail email chat teams nachricht message kommunik communic organis organiz orga admin verwalt dokument doku document support unterstütz unterstuetz analys investig recherch research prüf pruef check test konfig config customiz einstell setup einricht vorbereit prep nachbereit follow nacharbeit bearbeit process handling ticket closure aufgab task todo arbeit work tätigkeit taetigkeit thema themen topic divers allgemein general sonstig misc intern extern team koordin coordin steuer planung plan projekt project kunde kunden customer fehler error issue problem lösung loesung solution entwickl develop umsetz implement migration learning lernen training schulung weiterbild einarbeit enablement self study zertifi certif exam prepar abklär abklaer klärung klaerung austausch exchange discuss diskuss alignment abgleich sitzung runde gespräch gespraech info information kontrolle monitoring überwach betreuung begleitung beratung consulting coaching hilfe help frage fragen question anfrage request anforderung requirement offen punkte punkt item items liste list sap s/4 s4 s/4hana hana cloud system systeme daten data stuff zeiten zeit time buchen buchung erfass recording sheet standby warten waiting mittag lunch pause diverse weiteres weitere allg allgemeine neu new vorbereitung nacharbeiten meetings call calls align analyz learn client manag activit thing various several other correspond answer reply respon query queries troubleshoot debug fixing bugfix maintain maintenance adjust change creat kickoff kick-off monthly biweekly bi-weekly retro course reading schedul catch-up catchup touchpoint huddle talk conversation session briefing handover clarif';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export const GEN_RE = new RegExp(`^(${GENERIC_STEMS.split(' ').map(esc).join('|')})`, 'i');

const ID_RES = [
  /\b\d{1,3}-\d{3,6}\b/, /\b[A-Z][A-Z0-9_]{1,14}-\d{1,7}\b/, /\b\d{5,}\/\d{4}\b/, /\b(INC|RITM|REQ|CHG|SR|CS|TASK|PRB)\d{4,}\b/i, /\b\d{6,}\b/,
];

export const LEAD_ID = /^\s*(?:\[?(?:\d{1,3}-\d{1,6}|[A-Za-z][A-Za-z0-9_]{1,14}-\d{1,7}|\d{5,}\/\d{4}|(?:INC|RITM|REQ|CHG|SR|CS)\d{4,})\]?\s*[,/&]?\s*)+:/;

export const MAIL_RE = /hallo zusammen|hallo liebe|hallo,|hi all|hi team|hello (all|everyone|team|my dear)|liebe kolleg|dear (all|colleagues|team)|(^|\s)von:\s|gesendet:|(^|\s)from:\s|sent:\s|ursprüngliche nachricht|original message|_{6,}|microsoft teams|besprechungs-id|meeting[- ]id|join (the )?meeting|an der besprechung teilnehmen|teams-besprechung|zoom\.us|webex|(^|\s)(wg|aw|fw|fwd):\s/i;
export const ABS_RE = /(?<![\p{L}])(urlaub|krank\p{L}*|arzt\p{L}*|zahnarzt|feiertag|public holiday|replacement leave|sick|mittagspause|lunch\p{L}*|elternzeit|sonderurlaub|überstundenabbau|gleittag|vacation|annual leave|sick leave|parental leave|maternity leave|paternity leave|doctor\p{L}*|dentist|day off|bank holiday|out of office|pto)(?![\p{L}])/iu;
export const ABS_AUSNAHME = /(nach|vor|after|before|wegen|aus|due to|because of|post|from|following|prior to)\s+(\p{L}+\s+)?(urlaub|krank\p{L}*|elternzeit|feiertag|holidays?|leave|vacation|sick\p{L}*|illness|absence|pto)/iu;
export const TRAVEL_RE = /(?<![\p{L}])(reisezeit|anreise|abreise|rückreise|hinreise|fahrtzeit|fahrt|zugfahrt|flug|travel ?time|travelling|traveling|journey|business trip|return trip|flight|train ride|commute|drive to|travel to|travel from|travel back)(?![\p{L}])/iu;
export const PH_RE = /^(x+|tbd|todo|to do|test|n\/?a|na|siehe oben|s\.\s?o\.?|so|dito|wie gestern|wie oben|wie vortag|see above|as above|same as above|same as yesterday|as yesterday|ditto|same|idem|none|nothing|n\.a\.|\.+|-+|\?+)$/i;
export const TK_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9_]{2,20})-\d{1,6}(?![A-Za-z0-9])/g;

export function hatId(s: string): boolean {
  return ID_RES.some((r) => r.test(s));
}

/** Muster für interne Projekte ('W??INT*'): ? = [A-Z0-9], * = .*; mehrere durch Komma/Leerzeichen */
export function internRegex(muster: string): RegExp | null {
  const teile = (muster || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  if (!teile.length) return null;
  return new RegExp(teile.map((p) => '^' + p.toUpperCase().split('').map((c) => (c === '?' ? '[A-Z0-9]' : c === '*' ? '.*' : esc(c))).join('')).join('|'));
}

/**
 * Wortliste → Regex: kommagetrennt; * am Ende = Wortanfang; sonst ganzes Wort; Leerzeichen = \s+; „re:“ = roher Regex.
 * Case-insensitiv, Unicode. Leere Liste → null.
 */
export function wortRegex(liste: string): RegExp | null {
  const teile: string[] = [];
  for (const roh of (liste || '').split(',')) {
    const w = roh.trim();
    if (!w) continue;
    if (w.startsWith('re:')) {
      const r = w.slice(3);
      try { new RegExp(r, 'iu'); teile.push(`(?:${r})`); } catch { /* ungültiger Regex wird ignoriert */ }
      continue;
    }
    const stern = w.endsWith('*');
    const kern = (stern ? w.slice(0, -1) : w).trim().split(/\s+/).map(esc).join('\\s+');
    if (!kern) continue;
    teile.push(stern ? `(?<![\\p{L}\\p{N}])${kern}\\p{L}*` : `(?<![\\p{L}\\p{N}])${kern}(?![\\p{L}\\p{N}])`);
  }
  return teile.length ? new RegExp(teile.join('|'), 'iu') : null;
}

export interface TextAnalyse {
  s: string;
  words: number;
  spec: number;
  names: number;
  codes: number;
  specW: string[];
  ids: boolean;
}

/** zusätzliche Allgemeinbegriffe: kommagetrennt, * am Ende = Wortanfang */
export function allgemeinPruefer(zusatz: string): (w: string) => boolean {
  const ganz = new Set<string>();
  const anfang: string[] = [];
  for (const roh of (zusatz || '').split(',')) {
    const w = roh.trim().toLowerCase();
    if (!w) continue;
    if (w.endsWith('*')) anfang.push(w.slice(0, -1));
    else ganz.add(w);
  }
  return (w) => ganz.has(w) || anfang.some((a) => a && w.startsWith(a));
}

export function textAnalyse(text: string, vornamen: Set<string>, allgemein: (w: string) => boolean): TextAnalyse {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  let words = 0, spec = 0, names = 0, codes = 0;
  const specW: string[] = [];
  for (const roh of s.split(/[\s,;:()[\]{}"„“'!?|<>=+]+/)) {
    const t = roh.replace(/^[-–./*#]+|[-–./*#]+$/g, '');
    if (!t) continue;
    if (ISSUE_RE.test(t) || /^\d{1,3}-\d{1,6}$/.test(t) || /^[\d.,:/-]+$/.test(t)) continue;
    const hatBuchst = /\p{L}/u.test(t);
    if (/\d/.test(t) && /[A-Za-z]/.test(t) && /^[A-Za-z0-9._/-]+$/.test(t)) { codes++; continue; }
    if (!hatBuchst) continue;
    const lw = t.toLowerCase();
    if (STOP.has(lw)) continue;
    words++;
    if (vornamen.has(lw)) names++;
    else if (allgemein(lw) || GEN_RE.test(t)) { /* allgemein */ }
    else if (/^[A-ZÄÖÜ0-9&/]{2,6}$/.test(t) || (/\p{Ll}/u.test(t) && (t.match(/\p{L}/gu)?.length ?? 0) >= 3)) { spec++; specW.push(t); }
  }
  return { s, words, spec, names, codes, specW, ids: hatId(s) };
}

/** Regelwerk: führende ID und Wortzahl danach */
export function regelwerkAnalyse(s: string): { lead: boolean; wc: number } {
  const m = LEAD_ID.exec(s);
  const rest = m ? s.slice(m[0].length) : s;
  const wc = rest.split(/\s+/).filter((x) => /\p{L}/u.test(x)).length;
  return { lead: !!m, wc };
}

// ---------------------------------------------------------------------------
// Kundenwörterbuch (K5, K8)
// ---------------------------------------------------------------------------

const LEGAL = /^(ag|gmbh|mbh|kg|co\.?|&|s\.?a\.?s\.?|b\.?v\.?|s\.?|l\.?|se|ug|inc\.?|ltd\.?|corp\.?|gesellschaft.*|wirtschaftsprüfungsgesellschaf.*|wp,?|stb,?|ra|partnerschaft|mdb|services?|group|software|consulting|integrierte|dienste|corporate|medizinisches|versorungszentrum|versorgungszentrum|mvz|für|organisation,?|beratung|und|serviceleistungen|internal)$/i;
const STOPTOK = new Set(['united', 'internet', 'walldorf', 'timetoact', 'atvantage', 'gesellschaft', 'sap', 'group', 'alois']);
const K8_GEN = /^(management|partner|leasing|forms|deutsche|technology|construction|services?|consulting|software|group|corporate|international|digital|solutions?|systems?)$/i;

export interface KundenToken {
  token: string;
  kunde: string;
  re: RegExp;
}

function tokenRegex(tok: string): RegExp {
  const cs = tok.length <= 5 || tok === tok.toUpperCase();
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc(tok)}(?![\\p{L}])`, cs ? 'u' : 'iu');
}

function istGross(w: string): boolean {
  return /^\p{Lu}/u.test(w);
}

/** Wörterbuch aus allen externen Kunden plus Aliasse („Kürzel = Kundenname“) */
export function kundenWoerterbuch(kunden: string[], aliasse: string): KundenToken[] {
  const r: KundenToken[] = [];
  const gesehen = new Set<string>();
  const add = (tok: string, kunde: string) => {
    const t = tok.trim();
    if (t.length < 2 || STOPTOK.has(t.toLowerCase()) || K8_GEN.test(t)) return;
    const k = `${kunde}\u0000${t}`;
    if (gesehen.has(k)) return;
    gesehen.add(k);
    r.push({ token: t, kunde, re: tokenRegex(t) });
  };
  const ersteTokens = new Map<string, string>();
  for (const kunde of kunden) {
    const w = kunde.split(/\s+/).filter((x) => x && !LEGAL.test(x));
    if (!w.length) continue;
    ersteTokens.set(kunde, w[0]);
    add(w[0], kunde);
    if (w[1] && istGross(w[1]) && w[1].length >= 6) add(w[1], kunde);
    if (w[1] && istGross(w[1])) add(`${w[0]} ${w[1]}`, kunde);
  }
  for (const z of (aliasse || '').split(/\r?\n/)) {
    const m = /^(.+?)\s*=\s*(.+)$/.exec(z.trim());
    if (!m) continue;
    const ziel = m[2].trim().toLowerCase();
    for (const kunde of kunden) {
      if (kunde.toLowerCase().startsWith(ziel) || (ersteTokens.get(kunde) ?? '').toLowerCase() === ziel) add(m[1].trim(), kunde);
    }
  }
  return r;
}

export function kundenTreffer(text: string, wb: KundenToken[]): KundenToken[] {
  return wb.filter((k) => k.re.test(text));
}
