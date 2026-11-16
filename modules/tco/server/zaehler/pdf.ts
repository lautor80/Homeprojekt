import { dat, heute } from '../format.js';
import { C, LEFT } from '../pdf/layout.js';
import type { Verein } from '../verein.js';
import { Abschlussdruck } from '../abschluss/pdf.js';
import { zahlDe } from './logik.js';
import type { BogenZeile } from './daten.js';

/**
 * Ablesebogen der Zählerstände: alle aktiven Zähler mit dem letzten Stand und leeren Spalten „Datum“ und „Stand“ zum
 * Ausfüllen beim Rundgang – im Layout der übrigen Vereinsdrucke (Kopfband mit Logo, Karte, Folgekopf, Fußzeile).
 */
const ROT = 'B3261E';
const X = { nr: 21, bez: 36, znr: 92, letzt: 146, datum: 150, stand: 170 };
const B = { bez: 54, znr: 30 };
const HOEHE = 10;

class Ablesebogen extends Abschlussdruck {
  constructor(v: Verein, readonly zeilen: BogenZeile[], readonly stichtag: string) { super(v, Number(stichtag.slice(0, 4)), 'Ablesebogen Zählerstände'); }

  drucken() {
    const faellig = this.zeilen.filter((z) => z.ueberfaellig).length;
    this.teilBeginnen('Ablesebogen Zählerstände');
    this.kopfband('ABLESEBOGEN', 'Zählerstände');
    this.kennzahl(LEFT, 'STAND', dat(this.stichtag));
    this.kennzahl(60, 'ZÄHLER', String(this.zeilen.length));
    this.kennzahl(100, 'ÜBERFÄLLIG', String(faellig), faellig ? ROT : C.ink);
    this.kennzahl(140, 'ABGELESEN VON', '');
    this.p.line(140, 64, 190, 64, C.rand, 0.3);

    this.karteBeginnen('Zähler', [
      { x: X.nr, text: 'Nummer', align: 'L' }, { x: X.bez, text: 'Bezeichnung / Standort', align: 'L' },
      { x: X.znr, text: 'Zählernummer', align: 'L' }, { x: X.letzt, text: 'Letzter Stand', align: 'R' },
      { x: X.datum, text: 'Datum', align: 'L' }, { x: X.stand, text: 'Stand', align: 'L' },
    ]);
    if (!this.zeilen.length) { this.txt(X.bez, 'Es gibt keine aktiven Zähler.', { color: C.grau }); this.zeileLinie(); }
    for (const r of this.zeilen) {
      const z = r.zaehler;
      this.zeilePlatz(HOEHE);
      const y0 = this.y;
      this.txt(X.nr, z.nummer, { bold: true });
      this.txt(X.bez, this.kurz(z.bezeichnung, B.bez));
      if (z.standort) this.p.text(X.bez, y0 + 3.6, this.kurz(z.standort, B.bez, 7), { size: 7, color: C.grau });
      this.txt(X.znr, this.kurz(z.zaehlernummer ?? '', B.znr));
      if (r.letzte) {
        this.txt(X.letzt, `${zahlDe(r.letzte.stand)} ${z.einheit}`.trim(), { align: 'R' });
        this.p.text(X.letzt, y0 + 3.6, `am ${dat(r.letzte.datum)}`, { size: 7, color: r.ueberfaellig ? ROT : C.grau, align: 'R' });
      } else this.txt(X.letzt, '–', { align: 'R', color: C.grau });
      // Felder zum Ausfüllen
      this.p.line(X.datum, y0 + 3.4, X.datum + 17, y0 + 3.4, C.rand, 0.3);
      this.p.line(X.stand, y0 + 3.4, 189, y0 + 3.4, C.rand, 0.3);
      this.y = y0 + HOEHE - 5.6;
      this.zeileLinie();
    }
    this.karteBeenden(`Stand ${dat(heute())} · Rot: Ablesung überfällig. Die abgelesenen Stände bitte im Portal unter Instandhaltung → Zählerstände erfassen (auch per QR-Code am Zähler).`);
  }
}

export async function ablesebogenPdf(v: Verein, zeilen: BogenZeile[], stichtag: string): Promise<Buffer> {
  const d = new Ablesebogen(v, zeilen, stichtag);
  d.drucken();
  return d.render();
}
