import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import type { Verein } from '../verein.js';
import { ibanFormat, zahl } from '../format.js';

/** TCO-Druckformat (Farben und Fußzeile wie ZCL_TCO_RECHNUNG_PDF) */
export const C = {
  orange: 'E2701F',
  orangeDk: 'B9561A',
  orangeSoft: 'FDF0E6',
  ink: '1F1F1F',
  grau: '6B6B6B',
  linie: 'E3E3E3',
  rand: 'C8C8C8',
  fuss: 'F6F4F2',
};
export const LEFT = 18;
export const RIGHT = 192;

export const betragText = (v: number) => `${zahl(v)} €`;

export function fusszeile(p: Pdf, v: Verein, seite: number, seiten: number) {
  p.rect(0, 282, 210, 15, { fill: C.fuss });
  p.rect(0, 281.2, 210, 1, { fill: C.orange });
  const links = `${v.name} · ${v.strasse ?? ''} · ${v.plz_ort ?? ''}`;
  const rechts = `${v.bank ?? ''} · IBAN ${ibanFormat(v.iban)}`;
  const mitte = (LEFT + p.textWidth(links, { size: 7 }) + RIGHT - p.textWidth(rechts, { size: 7 })) / 2;
  p.text(LEFT, 290.5, links, { size: 7, color: C.grau });
  if (v.steuernr) p.text(mitte, 290.5, `Steuernummer ${v.steuernr}`, { size: 7, color: C.grau, align: 'C' });
  p.text(RIGHT, 290.5, rechts, { size: 7, color: C.grau, align: 'R' });
  if (seiten > 1) p.text(RIGHT, 277, `Seite ${seite} von ${seiten}`, { size: 7, color: C.grau, align: 'R' });
}

export function alleFusszeilen(p: Pdf, v: Verein) {
  const n = p.pageCount();
  for (let i = 0; i < n; i++) {
    p.setPage(i);
    fusszeile(p, v, i + 1, n);
  }
}

export function umbruch(p: Pdf, text: string, size: number, breite: number): string[] {
  const zeilen: string[] = [];
  let z = '';
  for (const w of text.split(' ')) {
    const t = z ? `${z} ${w}` : w;
    if (z && p.textWidth(t, { size }) > breite) {
      zeilen.push(z);
      z = w;
    } else z = t;
  }
  if (z) zeilen.push(z);
  return zeilen;
}

export function kuerzen(p: Pdf, text: string, size: number, breite: number): string {
  if (p.textWidth(text, { size }) <= breite) return text;
  let t = text;
  while (t.length > 1 && p.textWidth(`${t}…`, { size }) > breite) t = t.slice(0, -1);
  return `${t}…`;
}

/** Nutzdaten des GiroCodes (EPC069-12, Version 002, ohne BIC) */
export function girocode(v: Verein, betrag: number, zweck: string): string {
  return ['BCD', '002', '1', 'SCT', '', v.name, (v.iban ?? '').replace(/\s/g, ''), `EUR${betrag.toFixed(2)}`, '', '', zweck].join('\n');
}
