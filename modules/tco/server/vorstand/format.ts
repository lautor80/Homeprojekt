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
