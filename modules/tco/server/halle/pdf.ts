import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { logoWeiss, type Verein } from '../verein.js';
import { addTage, condense, dat } from '../format.js';
import type { Kontakt } from '../kommunikation.js';
import { alleFusszeilen, betragText, C, girocode, kuerzen, LEFT, umbruch } from '../pdf/layout.js';
import type { DruckPosition } from './daten.js';

/**
 * Hallenrechnung als PDF (Port von ZCL_TCO_RECHNUNG_PDF, Layout „Modern, Logo weiß“):
 * orangefarbenes Kopfband mit Logo, Positionstabelle, Zahlkarte mit GiroCode.
 * „ZU ZAHLEN“ ist der volle Rechnungsbetrag (Anzahlungen stehen nicht auf der Rechnung).
 */
export async function rechnungPdf(v: Verein, k: { rgnr_txt: string; angelegt_am: string | null; betrag: number }, kunde: Kontakt, pos: DruckPosition[]): Promise<Buffer> {
  const p = new Pdf({ title: `Rechnung ${k.rgnr_txt}`, author: v.name, creator: 'TCO Vereinsportal' });
  p.newPage();
  const datum = k.angelegt_am ?? new Date().toISOString().slice(0, 10);
  const ziel = addTage(datum, v.zahlungsziel_tage);
  const zweck = `Rechnung ${k.rgnr_txt}`;
  const g = (kunde.geschlecht ?? '').toUpperCase();
  const anrede = ['M', '1'].includes(g) ? 'Herr' : ['W', 'F', '2'].includes(g) ? 'Frau' : '';
  const name = condense(`${anrede} ${kunde.vorname} ${kunde.nachname}`);

  // Kopfband mit weißem Logo
  p.rect(0, 0, 210, 46, { fill: C.orange });
  p.text(LEFT, 31, 'RECHNUNG', { size: 24, color: 'FFFFFF' });
  p.text(LEFT, 38.5, `Nr. ${k.rgnr_txt} · ${dat(datum)}`, { size: 10, color: 'FFFFFF' });
  p.image(logoWeiss(v), 137, 5.6, 57, 34.7);

  // Kopfdaten
  const grau = { size: 7, color: C.grau };
  const fett = { size: 9.5, bold: true, color: C.ink };
  p.text(LEFT, 58, 'RECHNUNG AN', grau);
  p.text(66, 58, 'ZAHLUNGSZIEL', grau);
  p.text(104, 58, 'ANSPRECHPARTNER', grau);
  p.text(144, 58, 'STEUERNUMMER', grau);
  p.text(LEFT, 63, kuerzen(p, name, 9.5, 46), fett);
  p.text(LEFT, 67.5, kuerzen(p, kunde.strasse, 9, 46), { size: 9, color: C.ink });
  p.text(LEFT, 72, condense(`${kunde.plz} ${kunde.ort}`), { size: 9, color: C.ink });
  p.text(66, 63, dat(ziel), fett);
  p.text(66, 69.5, 'ZAHLUNGSART', grau);
  p.text(66, 74, 'Rechnung', fett);
  p.text(104, 63, v.ansprechpartner ?? '', fett);
  p.text(144, 63, v.steuernr ?? '', fett);

  // Positionen
  let top = 84;
  let y = tabellenkopf(p, top);
  for (const ps of pos) {
    if (y > 262) {
      p.rect(LEFT, top, 174, y - 4.4 - top, { stroke: C.rand, lw: 0.3, radius: 3 });
      p.newPage();
      top = 18;
      y = tabellenkopf(p, top);
    }
    const t = { size: 9, color: C.ink };
    p.text(23, y, String(ps.rgpos), t);
    if (ps.beschreibung.includes('\t')) {
      const [art, tag, datumT, uhr] = ps.beschreibung.split('\t');
      p.text(34, y, art, t);
      p.text(57, y, tag, t);
      p.text(76, y, datumT, t);
      p.text(95, y, uhr, t);
    } else p.text(34, y, kuerzen(p, ps.beschreibung, 9, 94), t);
    p.text(146, y, betragText(ps.ep), { ...t, align: 'R' });
    p.text(164, y, ps.anzahl.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), { ...t, align: 'R' });
    p.text(187, y, betragText(ps.betrag), { ...t, align: 'R' });
    p.line(22, y + 2.7, 188, y + 2.7, C.linie, 0.25);
    y += 7;
  }
  y += 1.5;
  p.text(23, y, 'Rechnungsbetrag', { size: 11, bold: true, color: C.ink });
  p.text(187, y, betragText(k.betrag), { size: 11, bold: true, color: C.ink, align: 'R' });
  const h = y + 5 - top;
  p.rect(LEFT, top, 174, h, { stroke: C.rand, lw: 0.3, radius: 3 });

  // Hinweistext links, Zahlkarte rechts
  y = top + h + 9;
  if (y + 66 > 278) {
    p.newPage();
    y = 18;
  }
  const absaetze = [
    'Vielen Dank für Ihre Buchung in unserer Tennishalle.',
    `Wir bitten um Überweisung des Rechnungsbetrages bis zum ${dat(ziel)}. Am einfachsten geht es mit dem QR-Code rechts – einfach in der Banking-App scannen.`,
    'Bitte geben Sie bei der Überweisung die Rechnungsnummer an.',
  ];
  let ty = y + 4;
  for (const a of absaetze) {
    for (const z of umbruch(p, a, 9, 80)) {
      p.text(LEFT, ty, z, { size: 9, color: C.grau });
      ty += 4.3;
    }
    ty += 1.8;
  }
  ty += 3;
  p.text(LEFT, ty, 'Mit freundlichen Grüßen', { size: 9, color: C.ink });
  p.text(LEFT, ty + 4.3, v.ansprechpartner ?? '', { size: 9, color: C.ink });

  p.rect(104, y, 88, 64, { fill: 'FFFFFF', radius: 3 });
  p.rect(104, y, 88, 13, { fill: C.orangeSoft, radius: 3 });
  p.rect(104, y + 7, 88, 6, { fill: C.orangeSoft });
  p.rect(104, y, 88, 64, { stroke: C.orange, lw: 0.45, radius: 3 });
  p.text(109, y + 8.6, 'ZU ZAHLEN', { size: 8, bold: true, color: C.orangeDk });
  p.text(187, y + 9.3, betragText(k.betrag), { size: 15, bold: true, color: C.orangeDk, align: 'R' });
  if (k.betrag > 0) p.qr(girocode(v, k.betrag, zweck), 109, y + 18, 31);
  p.text(146, y + 22, kuerzen(p, v.name, 9, 44), { size: 9, bold: true, color: C.ink });
  p.text(146, y + 25.8, v.bank ?? '', { size: 7.5, color: C.grau });
  p.text(146, y + 32, (v.iban ?? '').replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim(), { size: 8, bold: true, color: C.ink });
  p.text(146, y + 35.8, 'IBAN', { size: 7.5, color: C.grau });
  p.text(146, y + 42, zweck, { size: 9, bold: true, color: C.ink });
  p.text(146, y + 45.8, 'Verwendungszweck', { size: 7.5, color: C.grau });
  p.text(109, y + 58.5, 'GiroCode – funktioniert mit allen gängigen Banking-Apps', { size: 7, color: C.grau });

  alleFusszeilen(p, v);
  return p.render();
}

function tabellenkopf(p: Pdf, y0: number): number {
  const y = y0 + 7;
  const g = { size: 7, color: C.grau };
  p.text(23, y, 'POS', g);
  p.text(34, y, 'BESCHREIBUNG', g);
  p.text(146, y, 'PREIS', { ...g, align: 'R' });
  p.text(164, y, 'ANZAHL', { ...g, align: 'R' });
  p.text(187, y, 'SUMME', { ...g, align: 'R' });
  p.line(22, y0 + 9.6, 188, y0 + 9.6, C.linie, 0.3);
  return y0 + 15.5;
}
