/**
 * Vereinskalender – Massenanlage aus eingefügtem Text (#16): Ein Spielplan (z. B. aus STB.LIGA.NU, per Screenshot von
 * Claude in Spalten aufgeteilt) wird zeilenweise gelesen und auf Veranstaltungen abgebildet.
 *
 * Erwartete Spalten: Tag | Datum | Uhrzeit | Nr. | Halle | Platz | Liga | Heimmannschaft | Gastmannschaft.
 * Trenner: Tabulator, „|“ (Markdown-Tabelle) oder Semikolon. Mit Kopfzeile gelten deren Spaltennamen,
 * ohne Kopfzeile die Reihenfolge ab der Datumsspalte.
 *
 * Diese Datei hat bewusst keine Importe – reine Textlogik.
 */

export interface SpielplanZeile {
  /** Zeilennummer im eingefügten Text (ab 1) */
  zeile: number;
  tag: string;
  /** JJJJ-MM-TT */
  datum: string;
  /** HH:MM oder null (dann ganztägig) */
  uhrzeit: string | null;
  nr: string;
  halle: string;
  platz: string;
  liga: string;
  heim: string;
  gast: string;
  fehler: string | null;
}

type Feld = 'tag' | 'datum' | 'uhrzeit' | 'nr' | 'halle' | 'platz' | 'liga' | 'heim' | 'gast';
const FELDER: Feld[] = ['tag', 'datum', 'uhrzeit', 'nr', 'halle', 'platz', 'liga', 'heim', 'gast'];
const KOPF: [Feld, RegExp][] = [
  ['tag', /^(tag|wochentag|wt)$/], ['datum', /^datum$/], ['uhrzeit', /^(uhrzeit|zeit|beginn|uhr)$/], ['nr', /^(nr|spielnr|spielnummer|spiel)$/],
  ['halle', /^(halle|ort|spielort|anlage)$/], ['platz', /^(platz|plätze|plaetze|court)$/], ['liga', /^(liga|klasse|gruppe|spielklasse|mannschaft)$/],
  ['heim', /^heim/], ['gast', /^gast/],
];
const DATUM = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})$/;
const ZEIT = /^(\d{1,2})[:.](\d{2})(?:\s*uhr)?$/i;
const zwei = (n: number) => String(n).padStart(2, '0');
const sauber = (s: string) => s.replace(/\s+/g, ' ').trim();

function zellen(zeile: string): string[] {
  if (zeile.includes('\t')) return zeile.split('\t').map(sauber);
  if (zeile.includes('|')) return zeile.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(sauber);
  if (zeile.includes(';')) return zeile.split(';').map(sauber);
  return [sauber(zeile)];
}

function datumLesen(s: string): string | null {
  const m = DATUM.exec(s);
  if (!m) return null;
  const [t, mo, j] = [Number(m[1]), Number(m[2]), m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])];
  const d = new Date(Date.UTC(j, mo - 1, t));
  if (d.getUTCFullYear() !== j || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== t) return null;
  return `${j}-${zwei(mo)}-${zwei(t)}`;
}

function zeitLesen(s: string): string | null | undefined {
  if (!s) return null;
  const m = ZEIT.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return `${zwei(Number(m[1]))}:${m[2]}`;
}

/** eingefügten Text in Spielplan-Zeilen lesen; Zeilen ohne Datum (Kopf, Trennlinien, Leerzeilen, HTML) werden übergangen */
export function spielplanLesen(text: string): { zeilen: SpielplanZeile[]; ignoriert: number } {
  const zeilen: SpielplanZeile[] = [];
  let ignoriert = 0;
  let spalten: Partial<Record<Feld, number>> | null = null;
  text.replace(/\r\n?/g, '\n').split('\n').forEach((roh, i) => {
    if (!roh.trim() || /^\s*</.test(roh)) return;
    const z = zellen(roh);
    if (z.every((c) => !c || /^:?-{2,}:?$/.test(c))) return;
    // Kopfzeile: Spaltennamen merken
    if (z.some((c) => /^datum$/i.test(c))) {
      spalten = {};
      z.forEach((c, n) => {
        const name = c.toLowerCase().replace(/[.\s-]/g, '');
        const f = KOPF.find(([feld, re]) => re.test(name) && spalten![feld] === undefined);
        if (f) spalten![f[0]] = n;
      });
      return;
    }
    const d = z.findIndex((c) => DATUM.test(c));
    if (d < 0) { ignoriert += 1; return; }
    // ohne Kopfzeile: Reihenfolge ab der Datumsspalte, der Tag steht davor
    const pos = spalten?.datum !== undefined ? spalten : Object.fromEntries(FELDER.map((f, n) => [f, d - 1 + n])) as Record<Feld, number>;
    const w = (f: Feld) => { const n = pos[f]; return n !== undefined && n >= 0 ? z[n] ?? '' : ''; };
    const datum = datumLesen(w('datum') || z[d]);
    const uhrzeit = zeitLesen(w('uhrzeit'));
    const fehler = !datum ? `Datum „${w('datum') || z[d]}“ gibt es nicht`
      : uhrzeit === undefined ? `Uhrzeit „${w('uhrzeit')}“ nicht erkannt`
        : !w('liga') ? 'Liga fehlt' : null;
    zeilen.push({
      zeile: i + 1, tag: w('tag'), datum: datum ?? '', uhrzeit: uhrzeit ?? null, nr: w('nr'), halle: w('halle'), platz: w('platz'),
      liga: w('liga'), heim: w('heim'), gast: w('gast'), fehler,
    });
  });
  return { zeilen, ignoriert };
}

export interface SpielplanEvent {
  titel: string; ort: string; kategorie: 'MANNSCHAFT';
  /** lokale Zeit JJJJ-MM-TTTHH:MM – der Browser rechnet in den Zeitpunkt um */
  beginn_lokal: string; ganztags: boolean; beschreibung: string;
}

/** Mapping: Titel = „<Präfix> <Liga>“, Art = Mannschaft / Spieltag, Ort = „<Halle> | <Platz>“, Beginn = Datum + Uhrzeit */
export function spielplanEvent(z: SpielplanZeile, praefix: string): SpielplanEvent {
  const begegnung = [z.heim, z.gast].filter(Boolean).join(' – ');
  return {
    titel: sauber(`${praefix} ${z.liga}`).slice(0, 120),
    ort: [z.halle, z.platz].filter(Boolean).join(' | ').slice(0, 120),
    kategorie: 'MANNSCHAFT',
    beginn_lokal: z.datum ? `${z.datum}T${z.uhrzeit ?? '00:00'}` : '',
    ganztags: !z.uhrzeit,
    beschreibung: [begegnung, z.nr ? `Spiel-Nr. ${z.nr}` : ''].filter(Boolean).join('\n'),
  };
}

/** Gruppe zur Liga vorschlagen: die Gruppe mit dem längsten Namen, der in der Liga vorkommt („Herren 40“ in „Herren 40 VL“) */
export function gruppeZurLiga<T extends { name: string }>(liga: string, gruppen: T[]): T | null {
  const l = sauber(liga).toLowerCase();
  let beste: T | null = null;
  for (const g of gruppen) {
    const n = sauber(g.name).toLowerCase();
    if (n.length >= 3 && l.includes(n) && (!beste || n.length > sauber(beste.name).length)) beste = g;
  }
  return beste;
}
