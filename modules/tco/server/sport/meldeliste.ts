/**
 * Meldeliste aus STB.LIGA.NU (nuLiga) als eingefügte Tabelle lesen – ohne Importe, reine Textlogik.
 *
 * In nuLiga steht je Konkurrenz (z. B. „Herren 40“) die namentliche Mannschaftsmeldung des Vereins mit den Spalten
 * Rang | Mannschaft | LK | ID-Nummer | Name, Vorname | Nation (weitere Spalten werden übergangen). Die Tabelle wird markiert
 * und mit Strg+V eingefügt; Trenner Tabulator, „|“ (Markdown-Tabelle, z. B. aus einem von Claude aufgeteilten Screenshot)
 * oder Semikolon. Mit Kopfzeile gelten deren Spaltennamen, ohne Kopfzeile wird jede Zelle an ihrem Inhalt erkannt
 * (Zahl = Rang, dann Mannschaft; 7–8 Ziffern = ID-Nr.; „LK 12,3“ = LK; Text = Name).
 * Eine Zeile wie „Herren 40“ über der Tabelle wird als Vorschlag für die Konkurrenz zurückgegeben.
 */

export interface MeldeSpieler {
  /** Zeilennummer im eingefügten Text (ab 1) */
  zeile: number;
  rang: number;
  mannschaft: number | null;
  nachname: string;
  vorname: string;
  id_nr: string | null;
  lk: number | null;
  nation: string;
}
export interface MeldelisteGelesen {
  spieler: MeldeSpieler[];
  fehler: { zeile: number; text: string }[];
  ignoriert: number;
  /** aus einer Überschrift wie „Herren 40“ */
  konkurrenz: string | null;
}

type Feld = 'rang' | 'mannschaft' | 'lk' | 'id_nr' | 'name' | 'vorname' | 'nation';
const KOPF: [Feld, RegExp][] = [
  ['rang', /^(rang|pos|position|meldepos|nr|lfdnr|platz)$/], ['mannschaft', /^(mannschaft|mannsch|team|ms|mnr)$/], ['lk', /^(lk|leistungsklasse)$/],
  ['id_nr', /^(idnr|idnummer|id|dtbid|spielerid|idnrspieler)$/], ['vorname', /^vorname$/], ['name', /^(name|namevorname|nachname|spieler|spielerin)$/],
  ['nation', /^(nation|nat|nationalitaet|land)$/],
];
const KONKURRENZ = /^(herren|damen|junioren|juniorinnen|knaben|mädchen|maedchen|mixed|bambini|jugend|u\d{1,2})\b/i;
const sauber = (s: string) => s.replace(/\s+/g, ' ').trim();
const kopfName = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/[^a-z0-9]/g, '');

function zellen(zeile: string): string[] {
  if (zeile.includes('\t')) return zeile.split('\t').map(sauber);
  if (zeile.includes('|')) return zeile.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(sauber);
  if (zeile.includes(';')) return zeile.split(';').map(sauber);
  return [sauber(zeile)];
}

/** „LK12,3“, „12.3“, „LK 25“ → Zahl; sonst null */
export function lkAus(v: string): number | null {
  const m = /^(?:lk\s*)?(\d{1,2})(?:[.,](\d))?$/i.exec(v.replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(`${m[1]}.${m[2] ?? '0'}`);
  return n >= 1 && n <= 25 ? n : null;
}
const istId = (v: string) => /^\d{7,8}$/.test(v.replace(/\s/g, ''));
const istZahl = (v: string) => /^\d{1,3}\.?$/.test(v);
const istName = (v: string) => /[a-zäöüß]{2}/i.test(v) && !/^lk\s*\d/i.test(v);

function nameTeilen(name: string, vorname: string): [string, string] {
  if (vorname) return [name, vorname];
  if (name.includes(',')) { const [n, ...v] = name.split(','); return [sauber(n), sauber(v.join(' '))]; }
  // „Vorname Nachname“ ohne Komma: letztes Wort ist der Nachname
  const t = name.split(' ');
  return t.length > 1 ? [t[t.length - 1], t.slice(0, -1).join(' ')] : [name, ''];
}

export function meldelisteLesen(text: string): MeldelisteGelesen {
  const spieler: MeldeSpieler[] = [];
  const fehler: { zeile: number; text: string }[] = [];
  let ignoriert = 0, konkurrenz: string | null = null;
  let spalten: Partial<Record<Feld, number>> | null = null;
  text.replace(/\r\n?/g, '\n').split('\n').forEach((roh, i) => {
    const zeile = i + 1;
    if (!roh.trim() || /^\s*</.test(roh)) return;
    const z = zellen(roh);
    if (z.every((c) => !c || /^:?-{2,}:?$/.test(c))) return;
    const k = z.map(kopfName);
    // Kopfzeile: Spaltennamen merken
    if (k.some((c) => /^(rang|pos|position|meldepos)$/.test(c)) && k.some((c) => /name|spieler/.test(c))) {
      spalten = {};
      k.forEach((c, n) => { const f = KOPF.find(([feld, re]) => re.test(c) && spalten![feld] === undefined); if (f) spalten![f[0]] = n; });
      return;
    }
    // Überschrift „Herren 40“ o. ä.
    const belegt = z.filter(Boolean);
    if (belegt.length === 1 && KONKURRENZ.test(belegt[0]) && !/\d{7}/.test(belegt[0])) { konkurrenz ??= belegt[0].replace(/[:–-]+\s*$/, '').trim(); return; }

    let rang: number | null = null, mannschaft: number | null = null, lk: number | null = null, id: string | null = null;
    let name = '', vorname = '', nation = '';
    if (spalten) {
      const w = (f: Feld) => { const n = spalten![f]; return n !== undefined ? z[n] ?? '' : ''; };
      rang = istZahl(w('rang')) ? parseInt(w('rang'), 10) : null;
      mannschaft = istZahl(w('mannschaft')) ? parseInt(w('mannschaft'), 10) : null;
      lk = lkAus(w('lk'));
      id = istId(w('id_nr')) ? w('id_nr').replace(/\s/g, '') : null;
      name = w('name'); vorname = w('vorname'); nation = w('nation');
    } else {
      // ohne Kopfzeile: Inhalt erkennen
      for (const c of z) {
        if (!c) continue;
        if (id == null && istId(c)) id = c.replace(/\s/g, '');
        else if (/^lk/i.test(c.replace(/\s/g, '')) && lk == null) lk = lkAus(c);
        else if (istZahl(c) && rang == null) rang = parseInt(c, 10);
        else if (istZahl(c) && mannschaft == null) mannschaft = parseInt(c, 10);
        else if (/^[A-Z]{3}$/.test(c) && !nation) nation = c;
        else if (!name && istName(c)) name = c;
        else if (lk == null && lkAus(c) != null && /[.,]/.test(c)) lk = lkAus(c);
      }
    }
    // ohne Rang und ohne ID-Nr. ist es keine Spielerzeile (Summen, Fußnoten, Legende)
    if (!name || !istName(name) || (rang == null && id == null)) { ignoriert += 1; return; }
    const [nachname, vn] = nameTeilen(sauber(name), sauber(vorname));
    if (rang == null) { fehler.push({ zeile, text: `${nachname}: Rang fehlt` }); return; }
    spieler.push({ zeile, rang, mannschaft, nachname, vorname: vn, id_nr: id, lk, nation });
  });
  // Rang doppelt
  const gesehen = new Map<number, number>();
  for (const s of spieler) {
    if (gesehen.has(s.rang)) fehler.push({ zeile: s.zeile, text: `Rang ${s.rang} kommt doppelt vor (auch Zeile ${gesehen.get(s.rang)})` });
    else gesehen.set(s.rang, s.zeile);
  }
  spieler.sort((a, b) => a.rang - b.rang);
  return { spieler, fehler, ignoriert, konkurrenz };
}

/** Konkurrenz zur Liga: die längste Konkurrenz, deren Name in der Liga vorkommt („Herren 40“ in „Herren 40 Verbandsliga“) */
export function konkurrenzZurLiga<T extends { konkurrenz: string }>(liga: string, listen: T[]): T | null {
  const l = sauber(liga).toLowerCase();
  let beste: T | null = null;
  for (const x of listen) {
    const n = sauber(x.konkurrenz).toLowerCase();
    if (n.length >= 3 && new RegExp(`(^|\\W)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(l) && (!beste || n.length > sauber(beste.konkurrenz).length)) beste = x;
  }
  return beste;
}
