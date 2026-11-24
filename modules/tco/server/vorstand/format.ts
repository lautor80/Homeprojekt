/**
 * Formatierte Protokolltexte (Vorstandssitzungen) – reine Logik ohne Importe, genutzt von Oberfläche und PDF.
 *
 * Gespeichert wird einfacher Text mit wenigen Markdown-Zeichen, damit er überall lesbar bleibt:
 *   **fett** · *kursiv* (auch _kursiv_) · ~~durchgestrichen~~ · [Bezeichnung](https://…) · https://… (wird von selbst
 *   zur Verknüpfung) · Zeilen mit „- “ oder „* “ = Aufzählung · „1. “ = nummerierte Liste. Leerzeilen trennen Absätze.
 * Verknüpfungen nur mit http(s) und mailto – alles andere bleibt Text. Kein HTML: Die Oberfläche baut daraus Elemente.
 */

export interface Stueck { text: string; fett?: boolean; kursiv?: boolean; durch?: boolean; href?: string }
export type Block =
  | { art: 'absatz'; zeilen: Stueck[][] }
  | { art: 'liste'; nummeriert: boolean; start: number; punkte: Stueck[][] };

// Reihenfolge: Verknüpfung mit Bezeichnung, freie Adresse, fett, durchgestrichen, kursiv (*…* oder _…_)
const MUSTER = /\[([^\]\n]+)\]\(<?((?:https?:\/\/|mailto:)[^\s)>]+)>?\)|((?:https?:\/\/|www\.)[^\s<>"]*[^\s<>".,;:!?)\]'])|\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/gu;

type Stil = Omit<Stueck, 'text'>;
const gleicherStil = (a: Stueck, b: Stueck) => !!a.fett === !!b.fett && !!a.kursiv === !!b.kursiv && !!a.durch === !!b.durch && a.href === b.href;

/** eine Zeile in Stücke mit Stil zerlegen (auch verschachtelt: **fett mit *kursiv***) */
export function zeileLesen(text: string, stil: Stil = {}): Stueck[] {
  const out: Stueck[] = [];
  const dazu = (x: Stueck) => {
    if (!x.text) return;
    const l = out[out.length - 1];
    if (l && gleicherStil(l, x)) l.text += x.text;
    else out.push({ ...x });
  };
  let pos = 0;
  for (const m of text.matchAll(MUSTER)) {
    dazu({ ...stil, text: text.slice(pos, m.index) });
    const [, bez, ziel, frei, fett, durch, kursiv1, kursiv2] = m;
    const innen: Stueck[] = bez != null ? zeileLesen(bez, { ...stil, href: ziel })
      : frei != null ? [{ ...stil, text: frei, href: frei.startsWith('www.') ? `https://${frei}` : frei }]
        : fett != null ? zeileLesen(fett, { ...stil, fett: true })
          : durch != null ? zeileLesen(durch, { ...stil, durch: true })
            : zeileLesen(kursiv1 ?? kursiv2 ?? '', { ...stil, kursiv: true });
    innen.forEach(dazu);
    pos = (m.index ?? 0) + m[0].length;
  }
  dazu({ ...stil, text: text.slice(pos) });
  return out;
}

const PUNKT = /^\s{0,3}[-*•]\s+(.*)$/;
const NUMMER = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;

/** Text in Absätze und Listen gliedern */
export function textLesen(text: string | null | undefined): Block[] {
  type Roh = { art: 'absatz'; zeilen: string[] } | { art: 'liste'; nummeriert: boolean; start: number; punkte: string[] };
  const roh: Roh[] = [];
  let leer = true;
  for (const z of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const letzter = roh[roh.length - 1];
    const p = PUNKT.exec(z), n = p ? null : NUMMER.exec(z);
    if (p || n) {
      const nummeriert = !!n, inhalt = (p ? p[1] : n![2]).trim();
      if (!leer && letzter?.art === 'liste' && letzter.nummeriert === nummeriert) letzter.punkte.push(inhalt);
      else roh.push({ art: 'liste', nummeriert, start: n ? Number(n[1]) : 1, punkte: [inhalt] });
      leer = false;
    } else if (!z.trim()) {
      leer = true;
    } else if (!leer && letzter?.art === 'liste' && /^\s{2,}\S/.test(z)) {
      letzter.punkte[letzter.punkte.length - 1] += ` ${z.trim()}`;       // eingerückte Fortsetzung eines Listenpunkts
    } else if (!leer && letzter?.art === 'absatz') {
      letzter.zeilen.push(z);
    } else {
      roh.push({ art: 'absatz', zeilen: [z] });
      leer = false;
    }
  }
  return roh.map((b) => (b.art === 'absatz'
    ? { art: 'absatz' as const, zeilen: b.zeilen.map((x) => zeileLesen(x)) }
    : { art: 'liste' as const, nummeriert: b.nummeriert, start: b.start, punkte: b.punkte.map((x) => zeileLesen(x)) }));
}

/** Text ohne Formatzeichen (Listen, Tabellen, Suche) – Verknüpfungen als Bezeichnung */
export function schlichterText(text: string | null | undefined): string {
  return textLesen(text).map((b) => (b.art === 'absatz'
    ? b.zeilen.map((z) => z.map((s) => s.text).join('')).join('\n')
    : b.punkte.map((z, i) => `${b.nummeriert ? `${b.start + i}.` : '–'} ${z.map((s) => s.text).join('')}`).join('\n'))).join('\n\n');
}

/** prüft eine Adresse für eine Link-Anlage: nur http(s), mit Rechnername */
export function linkPruefen(url: string): string | null {
  const t = url.trim();
  const mitSchema = /^www\./i.test(t) ? `https://${t}` : t;
  if (!/^https?:\/\//i.test(mitSchema)) return null;
  try {
    const u = new URL(mitSchema);
    return u.hostname.includes('.') || u.hostname === 'localhost' ? u.toString() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- Editor (Formatierung direkt beim Schreiben)
//
// Der Editor der Oberfläche (FormatText.tsx) ist ein bearbeitbarer Bereich (contenteditable). Er wird aus dem gespeicherten
// Text aufgebaut (textZuKnoten) und beim Tippen zurück in diesen Text gewandelt (knotenZuText). Gespeichert wird also
// weiterhin das schlichte Format oben – alte Protokolle, PDF und Import bleiben unverändert.

/** Baum für den Editor: Zeilen als div, Aufzählungen als ul/ol mit li, Stile b/i/s, Verknüpfung a */
export type Knoten = string | { tag: 'div' | 'ul' | 'ol' | 'li' | 'b' | 'i' | 's' | 'a' | 'br'; href?: string; start?: number; kinder: Knoten[] };

function inlineKnoten(z: Stueck[]): Knoten[] {
  return z.map((s) => {
    let k: Knoten = s.text;
    if (s.durch) k = { tag: 's', kinder: [k] };
    if (s.kursiv) k = { tag: 'i', kinder: [k] };
    if (s.fett) k = { tag: 'b', kinder: [k] };
    if (s.href) k = { tag: 'a', href: s.href, kinder: [k] };
    return k;
  });
}

/** gespeicherter Text → Editor-Baum (eine Zeile = ein div, Leerzeile = div mit br, Listenzeilen = ul/ol) */
export function textZuKnoten(text: string | null | undefined): Knoten[] {
  const out: Knoten[] = [];
  for (const z of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const letzter = out[out.length - 1];
    const p = PUNKT.exec(z), n = p ? null : NUMMER.exec(z);
    if (p || n) {
      const tag = n ? 'ol' : 'ul';
      const li: Knoten = { tag: 'li', kinder: inlineKnoten(zeileLesen((p ? p[1] : n![2]).trim())) };
      if (typeof letzter === 'object' && letzter.tag === tag) letzter.kinder.push(li);
      else out.push(n && Number(n[1]) !== 1 ? { tag, start: Number(n[1]), kinder: [li] } : { tag, kinder: [li] });
    } else if (typeof letzter === 'object' && (letzter.tag === 'ul' || letzter.tag === 'ol') && /^\s{2,}\S/.test(z)) {
      const li = letzter.kinder[letzter.kinder.length - 1] as Exclude<Knoten, string>;
      li.kinder.push(' ', ...inlineKnoten(zeileLesen(z.trim())));
    } else {
      out.push({ tag: 'div', kinder: z.trim() ? inlineKnoten(zeileLesen(z)) : [{ tag: 'br', kinder: [] }] });
    }
  }
  // ohne Text eine leere Zeile, damit der Editor eine Schreibstelle hat
  while (out.length > 1 && isLeer(out[out.length - 1])) out.pop();
  return out.length ? out : [{ tag: 'div', kinder: [{ tag: 'br', kinder: [] }] }];
}
const isLeer = (k: Knoten) => typeof k === 'object' && k.tag === 'div' && k.kinder.length === 1 && typeof k.kinder[0] === 'object' && k.kinder[0].tag === 'br';

/** das Nötigste eines DOM-Knotens (im Browser ein echter Node; im Test nachgebaut) */
export interface DomKnoten {
  nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<DomKnoten>;
  getAttribute?: (name: string) => string | null;
  style?: { fontWeight?: string; fontStyle?: string; textDecoration?: string; textDecorationLine?: string };
}
const BLOCK = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE']);
const LINK_OK = /^(https?:\/\/|mailto:)/i;

/** Inhalt eines Inline-Bereichs als Stücke mit Stil (Fett/Kursiv/Durch über Tags oder Inline-Stil) */
function stueckeAus(n: DomKnoten, stil: Stil, out: Stueck[]) {
  if (n.nodeType === 3) { out.push({ ...stil, text: (n.textContent ?? '').replace(/ /g, ' ') }); return; }
  if (n.nodeType !== 1) return;
  const name = n.nodeName.toUpperCase();
  if (name === 'BR') { out.push({ text: '\n' }); return; }
  const s = { ...stil };
  const st = n.style ?? {};
  if (name === 'B' || name === 'STRONG' || /^(bold|[6-9]00)$/.test(st.fontWeight ?? '')) s.fett = true;
  if (name === 'I' || name === 'EM' || st.fontStyle === 'italic') s.kursiv = true;
  if (name === 'S' || name === 'STRIKE' || name === 'DEL' || /line-through/.test(`${st.textDecoration ?? ''} ${st.textDecorationLine ?? ''}`)) s.durch = true;
  if (name === 'A') { const h = n.getAttribute?.('href') ?? ''; if (LINK_OK.test(h)) s.href = h; }
  for (const k of Array.from(n.childNodes)) stueckeAus(k, s, out);
}

/** Stücke → Text mit Formatzeichen: Leerzeichen außerhalb der Zeichen, Stile sauber verschachtelt, Verknüpfung außen */
export function stueckeZuText(stuecke: Stueck[]): string {
  const runs: Stueck[] = [];
  const dazu = (x: Stueck) => {
    if (!x.text) return;
    const l = runs[runs.length - 1];
    if (l && gleicherStil(l, x)) l.text += x.text; else runs.push({ ...x });
  };
  for (const r of stuecke) dazu(r);
  const ZEICHEN = { fett: '**', kursiv: '*', durch: '~~' } as const;
  const ORDNUNG = ['fett', 'kursiv', 'durch'] as const;
  // Zeichen öffnen/schließen; Leerzeichen am Rand bleiben außerhalb („**a** b“ statt „**a **b“)
  const stile = (rs: Stueck[]) => {
    let s = '';
    let offen: (typeof ORDNUNG[number])[] = [];
    const schliessen = (bis: number) => {
      const zu = offen.slice(bis).reverse().map((k) => ZEICHEN[k]).join('');
      if (!zu) return;
      const ws = /\s*$/.exec(s)![0];
      s = s.slice(0, s.length - ws.length) + zu + ws;
      offen = offen.slice(0, bis);
    };
    for (const r of rs) {
      if (!r.text.trim()) { s += r.text; continue; }
      const will = ORDNUNG.filter((k) => r[k]);
      let gleich = 0;
      while (gleich < offen.length && will.includes(offen[gleich])) gleich++;
      schliessen(gleich);
      const auf = will.filter((k) => !offen.includes(k));
      const ws = auf.length ? /^\s*/.exec(r.text)![0] : '';
      s += ws + auf.map((k) => ZEICHEN[k]).join('') + r.text.slice(ws.length);
      offen.push(...auf);
    }
    schliessen(0);
    return s;
  };
  let out = '';
  for (let i = 0; i < runs.length;) {
    const href = runs[i].href;
    let j = i;
    while (j < runs.length && runs[j].href === href) j++;
    const innen = stile(runs.slice(i, j));
    const nackt = runs.slice(i, j).map((x) => x.text).join('');
    // freie Adresse bleibt freie Adresse
    out += !href ? innen : (nackt === href || `https://${nackt}` === href) && innen === nackt ? nackt : `[${innen}](${href})`;
    i = j;
  }
  return out;
}

/** Editor-Inhalt → gespeicherter Text (Zeilen, Leerzeilen, Aufzählungen, Stile, Verknüpfungen) */
export function knotenZuText(kinder: ArrayLike<DomKnoten>): string {
  const zeilen: string[] = [];
  const zeilenAus = (liste: ArrayLike<DomKnoten>) => {
    let lauf: Stueck[] | null = null;
    const fertig = () => { if (lauf) { zeilen.push(stueckeZuText(lauf)); lauf = null; } };
    const alle = Array.from(liste);
    alle.forEach((n, i) => {
      const name = n.nodeType === 1 ? n.nodeName.toUpperCase() : '';
      if (BLOCK.has(name)) {
        fertig();
        const vorher = zeilen.length;
        zeilenAus(n.childNodes);
        if (zeilen.length === vorher) zeilen.push('');
      } else if (name === 'UL' || name === 'OL') {
        fertig();
        const start = Number(n.getAttribute?.('start') ?? 1) || 1;
        let nr = start;
        for (const li of Array.from(n.childNodes)) {
          if (li.nodeType !== 1) continue;
          if (li.nodeName.toUpperCase() !== 'LI') { if (BLOCK.has(li.nodeName.toUpperCase()) || /^[UO]L$/i.test(li.nodeName)) zeilenAus([li]); continue; }
          // verschachtelte Listen im Punkt werden zu eigenen Punkten
          const eigen = Array.from(li.childNodes).filter((x) => !/^[UO]L$/i.test(x.nodeName));
          const st: Stueck[] = [];
          for (const x of eigen) stueckeAus(x, {}, st);
          const text = stueckeZuText(st.map((x) => (x.text === '\n' ? { ...x, text: ' ' } : x))).replace(/\s+/g, ' ').trim();
          zeilen.push(`${name === 'OL' ? `${nr}.` : '-'} ${text}`.trimEnd());
          nr++;
          for (const x of Array.from(li.childNodes)) if (/^[UO]L$/i.test(x.nodeName)) zeilenAus([x]);
        }
      } else if (name === 'BR') {
        // abschließendes br in einer Zeile ist nur Platzhalter des Browsers
        if (i === alle.length - 1 && lauf) fertig();
        else { zeilen.push(lauf ? stueckeZuText(lauf) : ''); lauf = null; }
      } else {
        const st: Stueck[] = [];
        stueckeAus(n, {}, st);
        // br innerhalb von Stil-Tags trennt Zeilen
        for (const x of st) {
          if (x.text === '\n') { zeilen.push(stueckeZuText(lauf ?? [])); lauf = []; continue; }
          (lauf ??= []).push(x);
        }
      }
    });
    fertig();
  };
  zeilenAus(kinder);
  while (zeilen.length && !zeilen[zeilen.length - 1].trim()) zeilen.pop();
  return zeilen.map((z) => z.replace(/\s+$/, '')).join('\n');
}
