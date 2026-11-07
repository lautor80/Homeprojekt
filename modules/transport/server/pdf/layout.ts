import { Pdf } from './base.js';
import type { Adresse, Firma } from '../data.js';
import { condense } from '../format.js';

/** Farben und Maße wie ZCL_EU_RECHNUNG_PDF */
export const C = {
  accent: 'EF7D00',
  ink: '1F2328',
  muted: '6B7280',
  line: 'E6E8EB',
  soft: 'F6F7F8',
  dark: '3A3F45',
  left: 20,
  right: 192,
  bottom: 266,
};

/** Farbige Leiste oben auf jeder Seite */
export function topBar(p: Pdf) {
  p.rect(0, 0, 80, 3, { fill: C.accent });
  p.rect(80, 0, 130, 3, { fill: C.dark });
}

/** Seite 1: Leiste, Logo und Punktraster rechts */
export function kopf(p: Pdf, firma: Firma) {
  topBar(p);
  if (firma.logo) p.image(firma.logo, C.left, 11, 67.8, 11);
  else p.text(C.left, 19, firma.name, { size: 16, bold: true });
  const orange = [4, 5, 10, 11, 17, 23, 28];
  for (let k = 0; k < 30; k++) {
    p.circle(171 + (k % 6) * 3.5 + 1.1, 10 + Math.floor(k / 6) * 3.5 + 1.1, 1.1, orange.includes(k) ? C.accent : 'D5D8DC');
  }
}

/** Folgeseite: Leiste und Titelzeile */
export function folgeKopf(p: Pdf, titel: string) {
  topBar(p);
  p.text(C.left, 14, `${titel} · Fortsetzung`, { size: 8, color: C.muted });
}

/** Absenderzeile und Anschrift im Fenster (DIN 5008) */
export function anschrift(p: Pdf, firma: Firma, zeilen: string[]) {
  p.text(C.left, 47.5, `${firma.name} · ${firma.strasse} · ${firma.plz} ${firma.ort}`, { size: 6.5, color: C.muted });
  let y = 54.5;
  zeilen.filter(Boolean).forEach((z, i) => {
    p.text(C.left, y, z, { size: 10, bold: i === 0 });
    y += 4.6;
  });
}

export function adressZeilen(a: Adresse | null): string[] {
  if (!a) return [];
  return [
    condense(a.kundenname),
    condense(a.kundenname2),
    condense(`${a.anrede ?? ''} ${a.vorname ?? ''} ${a.name ?? ''}`),
    condense(`${a.strasse ?? ''} ${a.hausnummer ?? ''}`),
    condense(`${a.land ?? ''}${a.land ? '-' : ''}${a.plz ?? ''} ${a.ort ?? ''}`),
  ].filter(Boolean);
}

/** Infoblock rechts: Paare (Bezeichnung, Wert) mit Akzentlinie */
export function infoBlock(p: Pdf, paare: [string, string][]) {
  p.line(125, 45, 125, 45 + Math.max(25, paare.length * 4.8 + 1), C.accent, 0.6);
  let y = 49;
  for (const [k, v] of paare) {
    p.text(129, y, k, { size: 8.5, color: C.muted });
    p.text(C.right, y, v, { size: 8.5, bold: true, align: 'R' });
    y += 4.8;
  }
}

/** Titel mit Badge (z. B. "RECHNUNG  [1 TRANSPORTAUFTRAG]") */
export function titel(p: Pdf, text: string, badge: string | null, unter: string | null) {
  p.text(C.left, 112, text, { size: 22, bold: true });
  if (badge) {
    const bx = C.left + p.textWidth(text, { size: 22, bold: true }) + 4;
    const bw = p.textWidth(badge, { size: 7, bold: true }) + 5;
    p.rect(bx, 106.6, bw, 5.2, { stroke: C.accent, lw: 0.3, radius: 2.6 });
    p.text(bx + 2.5, 110.2, badge, { size: 7, bold: true, color: C.accent });
  }
  if (unter) p.text(C.left, 118, unter, { color: C.muted });
}

/** Fußzeile mit Firmendaten auf allen Seiten */
export function fusszeilen(p: Pdf, firma: Firma) {
  const n = p.pageCount();
  for (let i = 0; i < n; i++) {
    p.setPage(i);
    p.line(C.left, 276, C.right, 276, C.line);
    const s = { size: 6.5, color: C.muted };
    p.text(C.left, 280, firma.name, { size: 6.5, bold: true });
    p.text(C.left, 283, firma.strasse, s);
    p.text(C.left, 286, `${firma.plz} ${firma.ort}`, s);
    if (firma.telefon) p.text(70, 280, `Tel. ${firma.telefon}`, s);
    if (firma.fax) p.text(70, 283, `Fax ${firma.fax}`, s);
    p.text(70, 286, firma.email, s);
    p.text(112, 280, firma.bank, s);
    if (firma.iban) p.text(112, 283, `IBAN ${ibanFormat(firma.iban)}`, s);
    if (firma.bic) p.text(112, 286, `BIC ${firma.bic}`, s);
    if (firma.ustid) p.text(C.right, 280, `USt-IdNr. ${firma.ustid}`, { ...s, align: 'R' });
    p.text(C.right, 286, `Seite ${i + 1} / ${n}`, { ...s, align: 'R' });
  }
}

export const ibanFormat = (iban: string) => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

/** Kleiner Abschnittstitel in Versalien mit Linie darunter */
export function abschnitt(p: Pdf, y: number, text: string) {
  p.text(C.left, y, text.toUpperCase(), { size: 7, bold: true, color: C.muted });
  p.line(C.left, y + 2, C.right, y + 2, C.ink, 0.4);
}
