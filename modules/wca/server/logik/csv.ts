/**
 * WCA Zeitenkontrolle – Tempo-Teamreport („Gebuchte Zeit“-Export) lesen.
 *
 *  - BOM wird entfernt, Trennzeichen aus der Kopfzeile (; wenn mehr Teile als mit ,)
 *  - Spaltenerkennung tolerant (DE/EN, Synonyme); jede Kopfspalte, die als Datum lesbar ist, ist eine Tagesspalte
 *  - der hierarchische Report (Benutzer → Kategorietyp → Projekt → Account → Team → Bereich → Zeitnachweis)
 *    wird in Blattzeilen zerlegt; Zwischenzeilen mit Schlüssel liefern Account- und Bereichsschlüssel
 *  - Kontrollsumme je Person gegen die Benutzer-Summenzeile (Abweichung > 0,02 h → Warnung)
 */
import { csvParse } from '../../../../server/src/lib/sapcsv.js';
import type { ImportErgebnis, RohEintrag } from '../typen.js';
import { gueltigesDatum, r2 } from './datum.js';
import { ISSUE_RE } from './text.js';

const MONMAP: Record<string, number> = {
  jan: 1, feb: 2, 'mär': 3, mae: 3, mrz: 3, mar: 3, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9,
  okt: 10, oct: 10, nov: 11, dez: 12, dec: 12,
};

const jahr = (j: string) => (j.length === 2 ? 2000 + Number(j) : Number(j));

/** Kopfspalte als Datum lesen (01/Nov./26, 1-Nov-2026, 01.11.26, 2026-11-01, 01/11/2026) → ISO oder null */
export function tagesSpalte(kopf: string): string | null {
  const h = kopf.trim();
  let m = /^(\d{1,2})[/.\- ]([A-Za-zÄÖÜäöü]+)\.?[/.\- ](\d{2,4})$/.exec(h);
  if (m) {
    const mon = MONMAP[m[2].slice(0, 3).toLowerCase()];
    return mon ? gueltigesDatum(jahr(m[3]), mon, Number(m[1])) : null;
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(h);
  if (m) return gueltigesDatum(jahr(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(h);
  if (m) return gueltigesDatum(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(h); // TT/MM/JJJJ
  if (m) return gueltigesDatum(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

/** Stundenwert: 8h, 0.5h, 1,5, 1h 30m, 90m → Stunden */
export function stundenLesen(v: string): number {
  let n = 0;
  for (const m of (v || '').matchAll(/(\d+(?:[.,]\d+)?)\s*([hm]?)/gi)) {
    const x = Number(m[1].replace(',', '.'));
    n += m[2].toLowerCase() === 'm' ? x / 60 : x;
  }
  return Math.round(n * 10000) / 10000;
}

type Feld = 'user' | 'kat' | 'proj' | 'acc' | 'team' | 'ber' | 'text' | 'key' | 'erf';

const EXAKT: Record<Feld, string[]> = {
  user: ['benutzer', 'user', 'mitarbeiter', 'username', 'user name', 'full name', 'worker', 'author', 'person'],
  kat: ['kategorietyp', 'kategorie', 'category type', 'account category type', 'category', 'account category', 'kontokategorie'],
  proj: ['projektname', 'projekt', 'project', 'project name'],
  acc: ['account', 'accounts', 'tempo-account', 'tempo account', 'konto', 'account name'],
  team: ['team', 'team name', 'teamname'],
  ber: ['bereich', 'jira-projekt', 'jira projekt', 'jira project', 'area'],
  text: ['zeitnachweis', 'beschreibung', 'worklog', 'description', 'arbeitsprotokoll', 'work description', 'worklog description', 'kommentar', 'comment'],
  key: ['schlüssel', 'key', 'issue key', 'vorgang', 'vorgangsschlüssel', 'issue', 'ticket'],
  erf: ['erfasst', 'logged', 'gesamt', 'total', 'summe', 'sum'],
};

/** zweiter Durchgang: Teilstring (Reihenfolge wichtig: Jira-Projekt vor Projekt) */
const ENTHAELT: [Feld, string[]][] = [
  ['user', ['benutzer', 'mitarbeiter', 'user']],
  ['ber', ['bereich', 'jira-projekt', 'jira projekt', 'jira project']],
  ['kat', ['kategorie', 'category']],
  ['acc', ['account', 'konto']],
  ['team', ['team']],
  ['text', ['zeitnachweis', 'beschreibung', 'worklog', 'description', 'arbeitsprotokoll', 'kommentar']],
  ['key', ['schlüssel', 'issue key', 'vorgang']],
  ['proj', ['projekt', 'project']],
  ['erf', ['erfasst', 'logged']],
];

export function tempoCsvLesen(text: string, datei: string): ImportErgebnis {
  const t = (text || '').replace(/^﻿/, '');
  if (!t.trim()) throw new Error('Datei ist leer');
  const nl = t.indexOf('\n');
  const erste = nl < 0 ? t : t.slice(0, nl);
  const sep = erste.split(';').length > erste.split(',').length ? ';' : ',';
  const zeilen = csvParse(t, sep);
  if (!zeilen.length) throw new Error('Datei ist leer');

  const kopf = zeilen[0].map((x) => x.trim().toLowerCase().replace(/\s+/g, ' '));
  const tagSp: { i: number; tag: string }[] = [];
  kopf.forEach((h, i) => {
    const tag = tagesSpalte(zeilen[0][i]);
    if (tag) tagSp.push({ i, tag });
  });
  const istTag = new Set(tagSp.map((x) => x.i));
  const sp: Partial<Record<Feld, number>> = {};
  const belegt = new Set<number>();
  for (const f of Object.keys(EXAKT) as Feld[]) {
    const i = kopf.findIndex((h, j) => !belegt.has(j) && !istTag.has(j) && EXAKT[f].includes(h));
    if (i >= 0) { sp[f] = i; belegt.add(i); }
  }
  for (const [f, liste] of ENTHAELT) {
    if (sp[f] !== undefined) continue;
    const i = kopf.findIndex((h, j) => !belegt.has(j) && !istTag.has(j) && liste.some((x) => h.includes(x)));
    if (i >= 0) { sp[f] = i; belegt.add(i); }
  }
  if (sp.user === undefined || !tagSp.length) throw new Error('keine Tempo-Ansicht mit Spalte „Benutzer“ und Tagesspalten');

  const warnungen: string[] = [];
  if (sp.acc === undefined) warnungen.push(`${datei}: keine Spalte Account – Kontierungsprüfungen eingeschränkt.`);
  if (sp.team === undefined) warnungen.push(`${datei}: keine Spalte Team – Personen stehen unter „Ohne Team“.`);

  const hier = (['kat', 'proj', 'acc', 'team', 'ber', 'text'] as Feld[])
    .filter((f) => sp[f] !== undefined).sort((a, b) => sp[a]! - sp[b]!);
  const hierOhneText = hier.filter((f) => f !== 'text');
  const zelle = (z: string[], f: Feld) => (sp[f] === undefined ? '' : (z[sp[f]!] ?? '').replace(/\r/g, '').trim());

  const eintraege: RohEintrag[] = [];
  const accKeys: Record<string, string> = {};
  const berKeys: Record<string, string> = {};
  const summen: Record<string, number> = {};
  const personen = new Set<string>();

  for (let zi = 1; zi < zeilen.length; zi++) {
    const z = zeilen[zi];
    const u = zelle(z, 'user');
    if (!u) continue;
    personen.add(u);
    if (hier.every((f) => zelle(z, f) === '')) {
      summen[u] = r2((summen[u] ?? 0) + tagSp.reduce((n, s) => n + stundenLesen(z[s.i] ?? ''), 0));
      continue;
    }
    const txt = zelle(z, 'text');
    const key = zelle(z, 'key');
    const blatt = txt !== '' || (ISSUE_RE.test(key) && hierOhneText.every((f) => zelle(z, f) !== ''));
    if (!blatt) {
      if (key) {
        const ber = zelle(z, 'ber');
        const acc = zelle(z, 'acc');
        if (ber) berKeys[ber] = key;
        else if (acc && !zelle(z, 'team')) accKeys[acc] = key;
      }
      continue;
    }
    const tage: [string, number][] = [];
    for (const s of tagSp) {
      const v = stundenLesen(z[s.i] ?? '');
      if (v !== 0) tage.push([s.tag, v]);
    }
    if (!tage.length) continue;
    tage.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    eintraege.push({
      person: u, kat: zelle(z, 'kat'), proj: zelle(z, 'proj'), acc: zelle(z, 'acc'), team: zelle(z, 'team'),
      ber: zelle(z, 'ber'), text: txt, key, zeile: zi + 1, tage,
    });
  }

  // Kontrollsumme je Person
  for (const [u, soll] of Object.entries(summen)) {
    const ist = r2(eintraege.filter((e) => e.person === u).reduce((n, e) => n + e.tage.reduce((m, x) => m + x[1], 0), 0));
    if (Math.abs(ist - soll) > 0.02) warnungen.push(`${datei}: ${u}: Σ ${ist} h ≠ ${soll} h`);
  }

  return {
    datei,
    tage: [...new Set(tagSp.map((x) => x.tag))].sort(),
    eintraege,
    accKeys,
    berKeys,
    personen: [...personen].sort((a, b) => a.localeCompare(b, 'de')),
    summen,
    hatAccount: sp.acc !== undefined,
    hatTeam: sp.team !== undefined,
    hatBereich: sp.ber !== undefined,
    warnungen,
  };
}
