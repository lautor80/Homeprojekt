import type { Db } from '../verein.js';
import { condense } from '../format.js';
import { normName } from './logik.js';

/**
 * Port von ZCL_TCO_AUFNAHMEANTRAG: Aufnahmeantrag (Jotform-PDF) ohne KI auslesen.
 * Der Text kommt aus Paperless (Textlayer/OCR); die Zuordnung Bezeichnung → Feld,
 * Mitgliedschaft → Vertragsart und Ja/Nein-Bestätigungen steht in tco.antrag_map
 * (leer = Standardzuordnung).
 */

export interface Antrag {
  antragsdatum: string | null; nachname: string; vorname: string; geburtsdatum: string | null; strasse: string; plz: string; ort: string;
  telefon: string; mobil: string; email: string; kontoinhaber: string; bank: string; iban: string; bic: string;
  beitritt: boolean; datenschutz: boolean; bildrechte: boolean; sepa: boolean; mitgliedschaft: string;
}
export interface MapZeile { typ: 'FELD' | 'VART' | 'JANE'; muster: string; ziel: string; sortnr: number }

const STANDARD: MapZeile[] = ([
  ['FELD', 'Name', 'NACHNAME', 10], ['FELD', 'Vorname', 'VORNAME', 20], ['FELD', 'Geburtsdatum', 'GEBURTSDATUM', 30],
  ['FELD', 'Straße', 'STRASSE', 40], ['FELD', 'Hausnummer', 'HAUSNR', 50], ['FELD', 'PLZ', 'PLZ', 60], ['FELD', 'Wohnort', 'ORT', 70],
  ['FELD', 'Telefonnummer', 'TELEFON', 80], ['FELD', 'Email', 'EMAIL', 90], ['FELD', 'Welche Mitgliedschaft', 'MITGLIEDSCHAFT', 100],
  ['FELD', 'Kontoinhaber', 'KONTOINHABER', 110], ['FELD', 'Bank', 'BANK', 120], ['FELD', 'IBAN', 'IBAN', 130], ['FELD', 'BIC', 'BIC', 140],
  ['JANE', 'Zeitpunkt beizutreten', 'BEITRITT', 10], ['JANE', 'Satzung anzuerkennen', 'DATENSCHUTZ', 20],
  ['JANE', 'Konto einzuziehen', 'SEPA', 30], ['JANE', 'elektronischem Rahmen zu', 'BILDRECHTE', 40],
  ['VART', 'Jugendliche', '3', 10], ['VART', 'Jugendtraining', '90', 20], ['VART', 'Erwachsen', '5', 30], ['VART', 'Familie', '8', 40],
  ['VART', 'Inaktiv', '6', 50], ['VART', 'Passiv', '6', 60], ['VART', 'Teilmitglied', '7', 70],
] as const).map(([typ, muster, ziel, sortnr]) => ({ typ, muster, ziel, sortnr }));

export async function mapLesen(db: Db): Promise<MapZeile[]> {
  const rows = await db`select typ, muster, ziel, sortnr from tco.antrag_map`;
  const m = rows.length ? rows.map((r) => ({ typ: r.typ, muster: r.muster, ziel: r.ziel ?? '', sortnr: r.sortnr ?? 0 })) as MapZeile[] : STANDARD;
  return m.sort((a, b) => a.typ.localeCompare(b.typ) || a.sortnr - b.sortnr || a.muster.localeCompare(b.muster));
}

export const normIban = (s: unknown) => String(s ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
export const istMobil = (s: string) => /^(\+49|0049|49)?0?1[5-7][0-9]+$/.test(s.replace(/[^0-9+]/g, ''));
function normStrasse(s: unknown) {
  return normName(s).replace(/strasse/g, 'str').replace(/ /g, '') + String(s ?? '').replace(/[^0-9]/g, '');
}

function datumLesen(t: string): string | null {
  let r = /([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4})/.exec(t);
  let j: string, m: string, d: string;
  if (r) [, d, m, j] = r;
  else {
    r = /([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(t);
    if (!r) return null;
    [, j, m, d] = r;
  }
  const iso = `${j}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}

const MON_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_DE = ['januar', 'februar', 'maerz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];

/** Jotform-Kopf: „Monday, February 9, 2026“ bzw. „Montag, 9. Februar 2026“ */
function kopfdatum(lines: string[]): string | null {
  for (const l of lines.slice(0, 8)) {
    let mon = '', tag = '', jahr = '';
    const en = /([A-Za-z]+) ([0-9]{1,2}), ([0-9]{4})/.exec(l);
    if (en) [, mon, tag, jahr] = en;
    else {
      const de = /([0-9]{1,2})\. ([^ 0-9]+) ([0-9]{4})/.exec(l);
      if (de) [, tag, mon, jahr] = de;
    }
    if (!mon) continue;
    const n = normName(mon);
    let i = MON_EN.indexOf(n);
    if (i < 0) i = MON_DE.indexOf(n);
    if (i >= 0) return `${jahr}-${String(i + 1).padStart(2, '0')}-${tag.padStart(2, '0')}`;
  }
  return null;
}

const istLabel = (l: string, labels: string[]) => labels.some((x) => l.toUpperCase() === x.toUpperCase() || l.toUpperCase().startsWith(`${x.toUpperCase()} `));

/** Erste bzw. letzte Antwort Ja/Nein im Text; ende = Position hinter der Antwort */
function jaNein(t: string, letzte: boolean): { ans: '' | 'J' | 'N'; ende: number } {
  const re = /(^|[^A-Za-zÄÖÜäöüß])(Ja|Nein)(?=[^A-Za-zÄÖÜäöüß]|$)/g;
  const treffer = [...t.matchAll(re)];
  if (!treffer.length) return { ans: '', ende: 0 };
  const h = letzte ? treffer[treffer.length - 1] : treffer[0];
  const off = h.index! + h[1].length;
  return { ans: h[2] === 'Ja' ? 'J' : 'N', ende: off + h[2].length };
}

export function parse(text: string, map: MapZeile[]): { antrag: Antrag; vart: { art: string; text: string }[]; hinweise: string[] } {
  const a: Antrag = {
    antragsdatum: null, nachname: '', vorname: '', geburtsdatum: null, strasse: '', plz: '', ort: '', telefon: '', mobil: '', email: '',
    kontoinhaber: '', bank: '', iban: '', bic: '', beitritt: false, datenschutz: false, bildrechte: false, sepa: false, mitgliedschaft: '',
  };
  const vart: { art: string; text: string }[] = [];
  const hinweise: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/ /g, ' ').split('\n').map(condense).filter((l) => l && !l.includes('Jotform'));
  if (!lines.length) return { antrag: a, vart, hinweise: ['Das Dokument enthält keinen lesbaren Text.'] };
  a.antragsdatum = kopfdatum(lines);
  const felder = map.filter((m) => m.typ === 'FELD');
  const labels = felder.map((m) => condense(m.muster));
  let hausnr = '';
  for (const m of felder) {
    const label = condense(m.muster);
    let wert = '', start = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.toUpperCase() === label.toUpperCase()) {
        start = i;
        wert = lines[i + 1] ?? '';
        if (istLabel(wert, labels)) wert = '';
        break;
      }
      if (l.length > label.length && l.slice(0, label.length).toUpperCase() === label.toUpperCase() && l[label.length] === ' ') {
        start = i;
        wert = condense(l.slice(label.length));
        break;
      }
    }
    if (start < 0) continue;
    switch (m.ziel) {
      case 'NACHNAME': a.nachname = wert; break;
      case 'VORNAME': a.vorname = wert; break;
      case 'GEBURTSDATUM':
        a.geburtsdatum = datumLesen(wert);
        if (!a.geburtsdatum && wert) hinweise.push(`Geburtsdatum „${wert}“ nicht lesbar.`);
        break;
      case 'STRASSE': a.strasse = wert; break;
      case 'HAUSNR': hausnr = wert; break;
      case 'PLZ': a.plz = wert.replace(/[^0-9]/g, ''); break;
      case 'ORT': a.ort = wert; break;
      case 'TELEFON': if (istMobil(wert)) a.mobil = wert; else a.telefon = wert; break;
      case 'EMAIL': a.email = wert.replace(/ /g, ''); break;
      case 'KONTOINHABER': a.kontoinhaber = wert; break;
      case 'BANK': a.bank = wert; break;
      case 'IBAN': a.iban = normIban(wert); break;
      case 'BIC': a.bic = normIban(wert); break;
      case 'MITGLIEDSCHAFT': {
        let sec = wert;
        for (let i = start + 1; i < lines.length && !istLabel(lines[i], labels); i++) sec = `${sec} ${lines[i]}`;
        a.mitgliedschaft = condense(sec.replace(/m(ö|oe)chtest du/gi, '').replace(/beantragen\??/gi, ''));
        break;
      }
      default:
    }
  }
  if (hausnr) a.strasse = condense(`${a.strasse} ${hausnr}`);

  // Ja/Nein: erst direkt hinter dem Stichwort, sonst die letzte Antwort zwischen voriger Antwort und Stichwort
  const voll = lines.join(' ');
  const kw = map.filter((m) => m.typ === 'JANE').map((m) => {
    const i = voll.toLowerCase().indexOf(condense(m.muster).toLowerCase());
    return i < 0 ? null : { ziel: m.ziel, off: i, end: i + condense(m.muster).length };
  }).filter((x): x is { ziel: string; off: number; end: number } => !!x).sort((x, y) => x.off - y.off);
  let prev = 0;
  for (const k of kw) {
    let r = jaNein(voll.slice(k.end, k.end + 8), false);
    if (r.ans) prev = k.end + r.ende;
    else {
      if (k.off > prev) r = jaNein(voll.slice(prev, k.off), true);
      prev = k.end;
    }
    const ja = r.ans === 'J';
    if (k.ziel === 'BEITRITT') a.beitritt = ja;
    else if (k.ziel === 'DATENSCHUTZ') a.datenschutz = ja;
    else if (k.ziel === 'SEPA') a.sepa = ja;
    else if (k.ziel === 'BILDRECHTE') a.bildrechte = ja;
  }

  for (const m of map.filter((x) => x.typ === 'VART')) {
    const mu = condense(m.muster);
    if (!mu || !a.mitgliedschaft.toLowerCase().includes(mu.toLowerCase())) continue;
    if (!vart.some((v) => v.art === condense(m.ziel))) vart.push({ art: condense(m.ziel), text: mu });
  }
  if (!a.nachname || !a.vorname) hinweise.push('Name/Vorname wurden im Antrag nicht gefunden.');
  if (!a.antragsdatum) hinweise.push('Antragsdatum im Kopf des Antrags nicht gefunden.');
  if (a.mitgliedschaft && !vart.length) hinweise.push(`Mitgliedschaft „${a.mitgliedschaft}“ keiner Vertragsart zugeordnet – bitte in der Tabelle wählen.`);
  return { antrag: a, vart, hinweise };
}

export interface ZahlerErgebnis { modus: 'SELBST' | 'BESTEHEND' | 'NEU'; adrnr: string; vorname: string; nachname: string; kandidaten: string[]; hinweis: string }

/** Zahler zum Kontoinhaber: SELBST, BESTEHEND (eindeutig oder Kandidaten) oder NEU */
export async function zahlerErmitteln(db: Db, a: Antrag): Promise<ZahlerErgebnis> {
  const r: ZahlerErgebnis = { modus: 'SELBST', adrnr: '', vorname: '', nachname: '', kandidaten: [], hinweis: '' };
  const vn = normName(a.vorname), nn = normName(a.nachname), inh = normName(a.kontoinhaber);
  if (!inh || inh === condense(`${vn} ${nn}`) || inh === condense(`${nn} ${vn}`)) return r;

  const tok = condense(a.kontoinhaber).split(' ');
  if (tok.length > 1 && ['herr', 'frau'].includes(normName(tok[0]))) tok.shift();
  const n = Math.max(1, condense(a.nachname).split(' ').filter(Boolean).length);
  const inh2 = normName(tok.join(' '));
  if (tok.length === 1) r.nachname = tok[0];
  else if (nn && tok.length > n && inh2.length > nn.length && inh2.startsWith(`${nn} `)) {
    r.nachname = tok.slice(0, n).join(' ');
    r.vorname = tok.slice(n).join(' ');
  } else {
    const anz = nn && tok.length > n && inh2.length > nn.length && inh2.endsWith(` ${nn}`) ? n : 1;
    r.nachname = tok.slice(tok.length - anz).join(' ');
    r.vorname = tok.slice(0, tok.length - anz).join(' ');
  }

  const z1 = normName(`${r.vorname} ${r.nachname}`), z2 = normName(`${r.nachname} ${r.vorname}`);
  const iban = normIban(a.iban), str = normStrasse(a.strasse), mail = a.email.trim().toLowerCase();
  const p = await db`select adrnr, vorname, nachname, strasse, plz, email, iban1, adrnrkih from tco.mitglieder`;
  const sicher = new Set<string>(), kand = new Set<string>();
  let hinw = '';
  for (const x of p) {
    const pn = normName(`${x.vorname ?? ''} ${x.nachname ?? ''}`);
    const nameOk = pn === z1 || pn === z2;
    const ibanOk = !!iban && normIban(x.iban1) === iban;
    const adrOk = !!str && normStrasse(x.strasse) === str && condense(String(x.plz ?? '')) === a.plz;
    const mailOk = !!mail && String(x.email ?? '').trim().toLowerCase() === mail;
    if (nameOk && (ibanOk || adrOk)) sicher.add(x.adrnr);
    else if (nameOk) kand.add(x.adrnr);
    else if (ibanOk) {
      const kih = x.adrnrkih && x.adrnrkih !== x.adrnr ? p.find((y) => y.adrnr === x.adrnrkih) : null;
      const kn = kih ? normName(`${kih.vorname ?? ''} ${kih.nachname ?? ''}`) : '';
      if (kih && (kn === z1 || kn === z2)) { sicher.add(kih.adrnr); continue; }
      hinw += ` Die IBAN ist bereits bei ${condense(`${x.vorname ?? ''} ${x.nachname ?? ''}`)} hinterlegt.`;
    } else if (mailOk && pn !== normName(`${a.vorname} ${a.nachname}`)) kand.add(x.adrnr);
  }
  for (const s of sicher) kand.delete(s);
  if (sicher.size === 1) {
    r.modus = 'BESTEHEND';
    r.adrnr = [...sicher][0];
    const x = p.find((y) => y.adrnr === r.adrnr)!;
    r.hinweis = `Zahler ${condense(`${x.vorname ?? ''} ${x.nachname ?? ''}`)} ist bereits vorhanden und wurde ausgewählt.`;
  } else if (sicher.size || kand.size) {
    r.modus = 'BESTEHEND';
    r.kandidaten = [...sicher, ...kand];
    r.hinweis = `Mögliche vorhandene Zahler gefunden (${r.kandidaten.length}) – bitte prüfen und auswählen oder „Neuer Zahler“ wählen.`;
  } else r.modus = 'NEU';
  if (hinw) r.hinweis = condense(`${r.hinweis}${hinw}`);
  return r;
}
