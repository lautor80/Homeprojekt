import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { dat } from '../format.js';
import { betragText, C, fusszeile, LEFT, RIGHT } from '../pdf/layout.js';
import type { Verein } from '../verein.js';
import { fuellen, type Texte } from './texte.js';

/**
 * Zuwendungsbestätigung für Geldzuwendungen als PDF – Aufbau und Reihenfolge nach dem amtlichen Muster des BMF
 * (Einzelbestätigung bzw. Sammelbestätigung mit Anlage). Alle festen Texte kommen aus den Textbausteinen der
 * Einstellungen (texte.ts); hier steht nur die Anordnung. Mehrere Dokumente ergeben eine Datei (Sammeldruck).
 * Ohne Nummer ist es die Vorschau und als solche gekennzeichnet.
 */

export interface Dokument {
  /** null = Vorschau */
  nummer: string | null;
  art: 'EINZEL' | 'SAMMEL';
  jahr: number;
  aussteller: { name: string; strasse: string; plz_ort: string };
  spender: { name: string; anschrift: string[] };
  betrag: number;
  betrag_worte: string;
  tag: string | null;
  zeitraum: { von: string; bis: string } | null;
  verzicht: boolean;
  bescheid: { art: 'FREISTELLUNG' | 'FESTSTELLUNG'; finanzamt: string; steuernummer: string; datum: string; veranlagungszeitraum: string };
  zweck: string;
  zweck_satzung: string;
  ort: string;
  datum: string;
  unterzeichner: string;
  funktion: string;
  unterschrift: string | null;
  texte: Texte;
  positionen: { datum: string; art: string; verzicht: boolean; betrag: number }[];
}

export const zuwendungTitel = (d: Pick<Dokument, 'nummer' | 'art' | 'jahr'>) =>
  `${d.art === 'SAMMEL' ? 'Sammelbestätigung' : 'Zuwendungsbestätigung'} ${d.nummer ?? `${d.jahr} – Vorschau`}`;

/** Standardschriften kennen nur WinAnsi: Zeichen außerhalb weglassen */
const ws = (s: string) => s.replace(/→/g, '»').replace(/−/g, '-').replace(/[^\u0000-ÿ€–—„“”‚‘’•…‹›]/g, '');
const BREITE = RIGHT - LEFT;
const UNTEN = 270;
const INK = { color: C.ink };

function kaestchen(p: Pdf, x: number, y: number, an: boolean) {
  p.rect(x, y, 3.2, 3.2, { stroke: C.ink, lw: 0.3 });
  if (an) {
    p.line(x + 0.6, y + 0.6, x + 2.6, y + 2.6, C.ink, 0.45);
    p.line(x + 2.6, y + 0.6, x + 0.6, y + 2.6, C.ink, 0.45);
  }
}

function eines(p: Pdf, d: Dokument) {
  const t = d.texte;
  const werte = {
    Zweck: d.zweck, ZweckSatzung: d.zweck_satzung, Finanzamt: d.bescheid.finanzamt, Steuernummer: d.bescheid.steuernummer,
    Bescheiddatum: dat(d.bescheid.datum), Veranlagungszeitraum: d.bescheid.veranlagungszeitraum,
  };
  const sammel = d.art === 'SAMMEL';
  p.newPage();
  let y = 13;
  const absatz = (text: string, o: { size?: number; bold?: boolean; x?: number; w?: number; nach?: number } = {}) => {
    const x = o.x ?? LEFT;
    const h = p.textBlock(x, y, o.w ?? RIGHT - x, ws(text), { size: o.size ?? 9, bold: o.bold, color: C.ink, lineGap: 0.4 });
    y += h + (o.nach ?? 2.5);
  };
  const angekreuzt = (an: boolean, text: string, nach = 2.5) => {
    kaestchen(p, LEFT, y + 0.2, an);
    absatz(text, { x: LEFT + 6, nach });
  };
  const kasten = (x: number, w: number, h: number, label: string) => {
    p.rect(x, y, w, h, { stroke: C.rand, lw: 0.3 });
    p.text(x + 2, y + 4, ws(label), { size: 7, color: C.grau });
  };

  if (!d.nummer) p.text(RIGHT, 9, 'VORSCHAU – keine gültige Zuwendungsbestätigung', { size: 8, bold: true, color: 'BB0000', align: 'R' });

  // Aussteller
  kasten(LEFT, BREITE, 21, t.aussteller_label);
  p.text(LEFT + 2, y + 9.5, ws(d.aussteller.name), { size: 11, bold: true, ...INK });
  p.text(LEFT + 2, y + 14.5, ws(d.aussteller.strasse), { size: 9.5, ...INK });
  p.text(LEFT + 2, y + 19, ws(d.aussteller.plz_ort), { size: 9.5, ...INK });
  p.text(RIGHT - 2, y + 9.5, d.nummer ? `Nr. ${d.nummer}` : 'Nr. – (Vorschau)', { size: 9, ...INK, align: 'R' });
  y += 28;

  // Titel
  absatz(sammel ? t.titel_sammel : t.titel_einzel, { size: 13, bold: true, nach: 1.5 });
  absatz(t.untertitel, { size: 9, nach: 5 });

  // Zuwendender
  const zeilen = [d.spender.name, ...d.spender.anschrift];
  const hSp = 8 + zeilen.length * 4.8;
  kasten(LEFT, BREITE, hSp, t.zuwendender_label);
  zeilen.forEach((z, i) => p.text(LEFT + 2, y + 9.5 + i * 4.8, ws(z), { size: 10.5, bold: i === 0, ...INK }));
  y += hSp + 4;

  // Betrag in Ziffern / in Buchstaben / Tag bzw. Zeitraum
  const w1 = sammel ? 56 : 42, w3 = sammel ? 48 : 44, w2 = BREITE - w1 - w3;
  const worte = `- ${d.betrag_worte} -`;
  const hWorte = p.blockHeight(w2 - 4, worte, { size: 9.5, lineGap: 0.4 });
  const hB = Math.max(15, 8 + hWorte + 2);
  kasten(LEFT, w1, hB, sammel ? t.betrag_label_sammel : t.betrag_label);
  kasten(LEFT + w1, w2, hB, t.worte_label);
  kasten(LEFT + w1 + w2, w3, hB, sammel ? t.zeitraum_label : t.tag_label);
  p.text(LEFT + 2, y + 11, betragText(d.betrag), { size: 10.5, bold: true, ...INK });
  p.textBlock(LEFT + w1 + 2, y + 7, w2 - 4, worte, { size: 9.5, color: C.ink, lineGap: 0.4 });
  p.text(LEFT + w1 + w2 + 2, y + 11, sammel ? `${dat(d.zeitraum?.von)} – ${dat(d.zeitraum?.bis)}` : dat(d.tag), { size: sammel ? 9 : 10.5, bold: true, ...INK });
  y += hB + 5;

  // Verzicht auf Erstattung von Aufwendungen (Einzelbestätigung: Ja/Nein; Sammelbestätigung: siehe Anlage)
  if (!sammel) {
    p.text(LEFT, y + 3, ws(t.verzicht), { size: 9, ...INK });
    const x = LEFT + p.textWidth(ws(t.verzicht), { size: 9 }) + 6;
    p.text(x, y + 3, 'Ja', { size: 9, ...INK }); kaestchen(p, x + 5, y + 0.3, d.verzicht);
    p.text(x + 14, y + 3, 'Nein', { size: 9, ...INK }); kaestchen(p, x + 23, y + 0.3, !d.verzicht);
    y += 8.5;
  }

  // Steuerbegünstigung: beide Alternativen des Musters, die zutreffende angekreuzt
  angekreuzt(d.bescheid.art === 'FREISTELLUNG', fuellen(t.freistellung, d.bescheid.art === 'FREISTELLUNG' ? werte : { ...werte, Finanzamt: '…', Steuernummer: '…', Bescheiddatum: '…', Veranlagungszeitraum: '…' }));
  angekreuzt(d.bescheid.art === 'FESTSTELLUNG', fuellen(t.feststellung, d.bescheid.art === 'FESTSTELLUNG' ? werte : { ...werte, Finanzamt: '…', Steuernummer: '…', Bescheiddatum: '…' }), 4);

  absatz(fuellen(t.verwendung, werte), { bold: true, nach: 4 });
  absatz(t.nur_fuer, { size: 8, nach: 1.5 });
  angekreuzt(true, t.kein_beitrag, 4);
  if (sammel) {
    absatz(t.sammel_keine_weiteren);
    absatz(t.sammel_verzicht, { nach: 4 });
  }

  // Ort, Datum, Unterschrift
  y += 12;
  if (d.unterschrift) p.image(d.unterschrift, LEFT + 62, y - 15, 55, 15);
  p.text(LEFT, y - 1.5, ws(`${d.ort}, ${dat(d.datum)}`), { size: 10, ...INK });
  p.line(LEFT, y, LEFT + 120, y, C.ink, 0.3);
  p.text(LEFT, y + 3.5, ws(t.unterschrift_label), { size: 7, color: C.grau });
  p.text(LEFT + 62, y + 7.5, ws([d.unterzeichner, d.funktion].filter(Boolean).join(', ')), { size: 8, ...INK });
  y += 14;

  // Hinweise
  if (y + 30 > UNTEN) { p.newPage(); y = 20; }
  absatz(t.hinweis_titel, { size: 7.5, bold: true, nach: 1 });
  absatz(t.hinweis_haftung, { size: 7.5, nach: 1.8 });
  absatz(t.hinweis_gueltigkeit, { size: 7.5 });

  if (sammel) anlage(p, d);
}

/** Anlage zur Sammelbestätigung: je Zuwendung Datum, Art, Verzicht ja/nein, Betrag; Gesamtsumme */
function anlage(p: Pdf, d: Dokument) {
  const t = d.texte;
  const X = { datum: LEFT + 2, art: LEFT + 40, verzicht: LEFT + 100, betrag: RIGHT - 2 };
  let y = 0;
  const kopf = (erste: boolean) => {
    p.newPage();
    y = 18;
    p.text(LEFT, y, ws(`${t.anlage_titel}${erste ? '' : ' (Fortsetzung)'}`), { size: 13, bold: true, ...INK });
    p.text(RIGHT, y, d.nummer ? `Nr. ${d.nummer}` : 'Vorschau', { size: 9, ...INK, align: 'R' });
    y += 6;
    p.text(LEFT, y, ws(`${d.spender.name} · ${dat(d.zeitraum?.von)} – ${dat(d.zeitraum?.bis)} · ${d.aussteller.name}`), { size: 9, color: C.grau });
    y += 8;
    const h = Math.max(p.blockHeight(56, ws(t.anlage_art), { size: 7.5 }), p.blockHeight(46, ws(t.anlage_verzicht), { size: 7.5 }), 4);
    p.rect(LEFT, y - 2, BREITE, h + 4, { fill: C.fuss });
    p.textBlock(X.datum, y, 36, ws(t.anlage_datum), { size: 7.5, bold: true, color: C.ink });
    p.textBlock(X.art, y, 56, ws(t.anlage_art), { size: 7.5, bold: true, color: C.ink });
    p.textBlock(X.verzicht, y, 46, ws(t.anlage_verzicht), { size: 7.5, bold: true, color: C.ink });
    p.text(X.betrag, y + 2.8, ws(t.anlage_betrag), { size: 7.5, bold: true, ...INK, align: 'R' });
    y += h + 7;
  };
  kopf(true);
  for (const z of d.positionen) {
    if (y + 6 > UNTEN) kopf(false);
    p.text(X.datum, y, dat(z.datum), { size: 9, ...INK });
    p.text(X.art, y, ws(z.art), { size: 9, ...INK });
    p.text(X.verzicht, y, z.verzicht ? 'ja' : 'nein', { size: 9, ...INK });
    p.text(X.betrag, y, betragText(z.betrag), { size: 9, ...INK, align: 'R' });
    p.line(LEFT, y + 2, RIGHT, y + 2, C.linie, 0.2);
    y += 6;
  }
  if (y + 9 > UNTEN) kopf(false);
  p.rect(LEFT, y - 4, BREITE, 6.5, { fill: C.orangeSoft });
  p.text(X.datum, y, ws(t.anlage_summe), { size: 9.5, bold: true, ...INK });
  p.text(X.betrag, y, betragText(d.betrag), { size: 9.5, bold: true, ...INK, align: 'R' });
}

/** Ein oder mehrere Dokumente als eine PDF-Datei; Fußzeile des Vereins und Seitenzahl je Dokument */
export async function zuwendungPdf(v: Verein, dokumente: Dokument[]): Promise<Buffer> {
  const erstes = dokumente[0];
  const p = new Pdf({
    title: dokumente.length === 1 ? zuwendungTitel(erstes) : `Zuwendungsbestätigungen (${dokumente.length})`, author: v.name, creator: 'TCO Vereinsportal',
    subject: dokumente.length === 1 ? erstes.nummer ?? 'Vorschau' : undefined,
  });
  const grenzen: [number, number][] = [];
  for (const d of dokumente) {
    const von = p.pageCount();
    eines(p, d);
    grenzen.push([von, p.pageCount()]);
  }
  for (const [von, bis] of grenzen) {
    for (let i = von; i < bis; i++) {
      p.setPage(i);
      fusszeile(p, v, i - von + 1, bis - von);
    }
  }
  return p.render();
}
