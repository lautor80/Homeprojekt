import { Pdf, type TextOpts } from '../../../../server/src/lib/pdfdoc.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { dat, heute, zahl } from '../format.js';
import { betragText, C, fusszeile, kuerzen, LEFT, RIGHT, umbruch } from '../pdf/layout.js';
import { logoWeiss, paperless, plAktiv, type Db, type Verein } from '../verein.js';
import { anlagenLesen, spiegelBerechnen, wertentwicklung, type Anlage, type Spiegel, type SpiegelSumme } from './anlagen.js';
import {
  bankBestaende, BEREICHE, bereichText, earBerechnen, jahreswerteLesen, ueberschussBerechnen, type Bankbestand, type Ear, type Jahreswert, type Ueberschuss,
} from './logik.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';

/**
 * Jahresabschluss als PDF – Port von ZCL_TCO_JAHRESABSCHLUSS_PDF (Layout wie Hallenrechnung /
 * Clubhausabrechnung: orangefarbenes Kopfband mit Logo, Karten mit grauem Rand, Folgekopf,
 * gleiche Fußzeile). Texte und Gliederung nach der Smartform ZTCO_EAR:
 *   - Einnahmen-Ausgaben-Rechnung: Tätigkeitsbereiche und Konten, Überschussrechnung mit
 *     zwei Vorjahren, Vermögensübersicht (Bankkonten 01.01. / 31.12.)
 *   - Steuererklärung: Bereiche/Konten und Bankkonten für drei Jahre, Überschussrechnung
 *   - Anlagevermögen: Anlagenspiegel und Wertentwicklung wie Excel „Werte Anlagevermögen“
 * Jeder Teil beginnt auf einer neuen Seite mit eigenem Kopfband.
 */

export interface Teile { ear: boolean; steuer: boolean; anlagen: boolean }

const ROT = 'B3261E';
const UNTEN = 268;   // untere Grenze des Inhalts (darunter Seitenzahl und Fußzeile)
const OBEN = 24;     // Beginn des Inhalts auf Folgeseiten (unter dem Folgekopf)
const MAX_SPALTEN = 6;

interface Spalte { x: number; text: string; align: 'L' | 'R' }

/** Titel für Voransicht / Paperless passend zur Auswahl */
export function abschlussTitel(jahr: number, t: Teile): string {
  const teile = [t.ear && 'EAR', t.steuer && 'Steuererklärung', t.anlagen && !t.steuer && 'Anlagevermögen'].filter(Boolean) as string[];
  if (!teile.length) return '';
  if (teile.length === 1) {
    return t.ear ? `Einnahmen-Ausgaben-Rechnung ${jahr}` : t.steuer ? `Steuererklärung ${jahr}` : `Anlagevermögen ${jahr}`;
  }
  return `Jahresabschluss ${jahr} (${teile.join(', ')})`;
}

class Abschlussdruck {
  readonly p: Pdf;
  y = 0;
  karteTop = 0;
  spalten: Spalte[] = [];
  teile: { von: number; titel: string }[] = [];

  constructor(readonly v: Verein, readonly jahr: number, titel: string) {
    this.p = new Pdf({ title: titel, author: v.name, creator: 'TCO Vereinsportal' });
  }

  // ---------------------------------------------------------------- Grundbausteine
  teilBeginnen(titel: string) {
    this.p.newPage();
    this.teile.push({ von: this.p.pageCount(), titel });
    this.y = 0;
  }

  kopfband(titel: string, untertitel: string) {
    this.p.rect(0, 0, 210, 46, { fill: C.orange });
    this.p.text(LEFT, 31, titel, { size: 24, color: 'FFFFFF' });
    this.p.text(LEFT, 38.5, untertitel, { size: 10, color: 'FFFFFF' });
    this.p.image(logoWeiss(this.v), 137, 5.6, 57, 34.7);
    this.y = 74;
  }

  kennzahl(x: number, label: string, wert: string, color = C.ink) {
    this.p.text(x, 58, label, { size: 7, color: C.grau });
    this.p.text(x, 63, wert, { size: 9.5, bold: true, color });
  }

  folgekopf(titel: string) {
    this.p.text(LEFT, 13, titel, { size: 9, bold: true, color: C.ink });
    this.p.text(RIGHT, 13, this.v.name, { size: 8, color: C.grau, align: 'R' });
    this.p.rect(LEFT, 15.5, 174, 0.6, { fill: C.orange });
  }

  platz(bedarf: number) {
    if (this.y + bedarf > UNTEN) { this.p.newPage(); this.y = OBEN; }
  }

  txt(x: number, text: string, o: TextOpts = {}) {
    this.p.text(x, this.y, text, { size: 8, color: C.ink, ...o });
  }

  karteBeginnen(titel: string, spalten: Spalte[]) {
    this.platz(32);
    this.spalten = spalten;
    this.txt(LEFT, titel, { bold: true, color: C.orangeDk });
    this.y += 3;
    this.karteTop = this.y;
    this.spaltenkopf();
  }

  spaltenkopf() {
    for (const s of this.spalten) this.p.text(s.x, this.y + 7, s.text, { size: 7, color: C.grau, align: s.align });
    this.p.line(20, this.y + 9.6, 190, this.y + 9.6, C.linie, 0.3);
    this.y += 14.5;
  }

  /** Platz für eine Zeile – sonst Karte schließen, neue Seite, Spaltenkopf wiederholen */
  zeilePlatz(bedarf = 5.6) {
    if (this.y + bedarf > UNTEN) {
      this.p.rect(LEFT, this.karteTop, 174, this.y - 4.4 - this.karteTop, { stroke: C.rand, lw: 0.3, radius: 3 });
      this.p.newPage();
      this.y = OBEN;
      this.karteTop = this.y;
      this.spaltenkopf();
    }
  }

  zeileLinie(hoehe = 5.6, color = C.linie, lw = 0.2) {
    this.p.line(20, this.y + 2.2, 190, this.y + 2.2, color, lw);
    this.y += hoehe;
  }

  karteBeenden(hinweis?: string) {
    const h = this.y + 5 - this.karteTop;
    this.p.rect(LEFT, this.karteTop, 174, h, { stroke: C.rand, lw: 0.3, radius: 3 });
    this.y = this.karteTop + h + 5;
    if (hinweis) {
      for (const z of umbruch(this.p, hinweis, 7, 172)) {
        this.platz(4);
        this.txt(LEFT, z, { size: 7, color: C.grau });
        this.y += 3.4;
      }
    }
    this.y += 6;
  }

  band() {
    this.p.rect(20, this.y - 4.2, 170, 6, { fill: C.orangeSoft, radius: 1.5 });
  }

  farbe(wert: number, color = C.ink) { return wert < 0 ? ROT : color; }
  kurz(text: string, breite: number, size = 8) { return kuerzen(this.p, text, size, breite); }

  // ---------------------------------------------------------------- Einnahmen-Ausgaben-Rechnung
  ear(ear: Ear, ueb: Ueberschuss, bank: Bankbestand[]) {
    this.kopfband('JAHRESABSCHLUSS', `Geschäftsjahr ${this.jahr} · Einnahmen-Ausgaben-Rechnung`);
    this.kennzahl(LEFT, 'ZEITRAUM', `01.01.${this.jahr} – 31.12.${this.jahr}`);
    this.kennzahl(66, 'EINNAHMEN', betragText(ear.ein));
    this.kennzahl(104, 'AUSGABEN', betragText(ear.aus));
    this.kennzahl(144, 'ÜBERSCHUSS / FEHLBETRAG', betragText(ear.ergebnis), this.farbe(ear.ergebnis, C.orangeDk));
    this.earBereiche(ear);
    this.ueberschuss(ueb);
    this.vermoegen(bank);
  }

  earBereiche(ear: Ear) {
    this.karteBeginnen('1. ÜBERSCHUSSRECHNUNG – TÄTIGKEITSBEREICHE UND KONTEN', [
      { x: 23, text: 'KONTO', align: 'L' }, { x: 37, text: 'BEZEICHNUNG', align: 'L' },
      { x: 138, text: 'EINNAHMEN', align: 'R' }, { x: 162, text: 'AUSGABEN', align: 'R' }, { x: 188, text: 'SALDO', align: 'R' },
    ]);
    for (const b of ear.bereiche) {
      this.zeilePlatz(14);
      this.band();
      this.txt(23, b.text, { bold: true, color: C.orangeDk });
      this.txt(138, zahl(b.ein), { bold: true, align: 'R' });
      this.txt(162, zahl(b.aus), { bold: true, align: 'R' });
      this.txt(188, zahl(b.ergebnis), { bold: true, align: 'R', color: this.farbe(b.ergebnis) });
      this.y += 6.4;
      for (const [einnahme, konten] of [[true, b.einnahmen], [false, b.ausgaben]] as const) {
        for (const k of konten) {
          this.zeilePlatz();
          const saldo = einnahme ? k.wert : -k.wert;
          this.txt(23, k.konto);
          this.txt(37, this.kurz(k.name, 76));
          this.txt(einnahme ? 138 : 162, zahl(k.wert), { align: 'R' });
          this.txt(188, zahl(saldo), { align: 'R', color: this.farbe(saldo) });
          this.zeileLinie();
        }
      }
      this.y += 1.4;
    }
    this.zeilePlatz(8);
    this.y += 0.6;
    this.txt(23, 'Summe aller Tätigkeitsbereiche', { size: 9, bold: true });
    this.txt(138, zahl(ear.ein), { bold: true, align: 'R' });
    this.txt(162, zahl(ear.aus), { bold: true, align: 'R' });
    this.txt(188, zahl(ear.ergebnis), { bold: true, align: 'R', color: this.farbe(ear.ergebnis, C.orangeDk) });
    this.karteBeenden('Beträge in EUR. Konten ohne Bewegung werden nicht ausgewiesen. Geld- und Darlehenskonten sind nicht Teil der Einnahmen-Ausgaben-Rechnung.');
  }

  werte3(w: number[], bold = false, farbe = false) {
    [138, 162, 188].forEach((x, i) => this.txt(x, zahl(w[i]), { bold, align: 'R', color: farbe ? this.farbe(w[i]) : C.ink }));
  }

  ueberschuss(u: Ueberschuss) {
    this.karteBeginnen('ÜBERSCHUSSRECHNUNG MIT VORJAHRESVERGLEICH', [
      { x: 23, text: 'POSITION', align: 'L' }, ...u.jahre.map((j, i) => ({ x: [138, 162, 188][i], text: String(j), align: 'R' as const })),
    ]);
    for (const a of u.arten) {
      this.zeilePlatz(14);
      this.band();
      this.txt(23, a.text, { bold: true, color: C.orangeDk });
      this.werte3(a.summe, true);
      this.y += 6.4;
      for (const k of a.konten) {
        this.zeilePlatz();
        this.txt(23, this.kurz(`${k.konto} ${k.name}`, 92));
        this.werte3(k.werte);
        this.zeileLinie();
      }
      this.y += 1.4;
    }
    this.zeilePlatz(8);
    this.y += 0.6;
    this.txt(23, 'Überschuss / Fehlbetrag', { size: 9, bold: true });
    [138, 162, 188].forEach((x, i) => this.txt(x, zahl(u.ergebnis[i]), { bold: true, align: 'R', color: this.farbe(u.ergebnis[i], i === 0 ? C.orangeDk : C.ink) }));
    this.karteBeenden('Beträge in EUR, Summe aller Tätigkeitsbereiche je Konto.');
  }

  /** 2. Überschussverwendung der Smartform: Guthaben der Bankkonten zum 01.01. und 31.12. */
  vermoegen(bank: Bankbestand[]) {
    if (!bank.length) return;
    this.karteBeginnen('2. ÜBERSCHUSSVERWENDUNG – VERMÖGENSÜBERSICHT BANKKONTEN', [
      { x: 23, text: 'KONTO', align: 'L' }, { x: 37, text: 'BEZEICHNUNG', align: 'L' },
      { x: 138, text: `GUTHABEN 01.01.${this.jahr}`, align: 'R' }, { x: 162, text: `GUTHABEN 31.12.${this.jahr}`, align: 'R' }, { x: 188, text: 'VERÄNDERUNG', align: 'R' },
    ]);
    let anfang = 0, ende = 0;
    for (const b of bank) {
      this.zeilePlatz();
      this.txt(23, b.konto);
      this.txt(37, this.kurz(b.name, 76));
      this.txt(138, zahl(b.anfang), { align: 'R' });
      this.txt(162, zahl(b.ende), { align: 'R' });
      this.txt(188, zahl(b.delta), { align: 'R', color: this.farbe(b.delta) });
      this.zeileLinie();
      anfang += b.anfang; ende += b.ende;
    }
    this.zeilePlatz(8);
    this.y += 0.6;
    this.txt(23, 'Summe', { size: 9, bold: true });
    this.txt(138, zahl(anfang), { bold: true, align: 'R' });
    this.txt(162, zahl(ende), { bold: true, align: 'R' });
    this.txt(188, zahl(ende - anfang), { bold: true, align: 'R', color: this.farbe(ende - anfang) });
    this.karteBeenden('Beträge in EUR. Darlehenskonten mit negativem Bestand.');
  }

  // ---------------------------------------------------------------- Steuererklärung (drei Jahre)
  steuer(jw: Jahreswert[], ueb: Ueberschuss, bank: Bankbestand[]) {
    const [j1, , j3] = ueb.jahre;
    this.kopfband('STEUERERKLÄRUNG', `Geschäftsjahre ${j3} – ${j1} · Einnahmen-Ausgaben-Rechnung`);
    this.kennzahl(LEFT, 'ZEITRAUM', `01.01.${j3} – 31.12.${j1}`);
    [66, 104, 144].forEach((x, i) => this.kennzahl(x, `ERGEBNIS ${ueb.jahre[i]}`, betragText(ueb.ergebnis[i]), this.farbe(ueb.ergebnis[i], i === 0 ? C.orangeDk : C.ink)));
    this.steuerBereiche(jw, ueb);
    this.ueberschuss(ueb);
    this.steuerBank(bank, ueb.jahre);
  }

  steuerBereiche(jw: Jahreswert[], ueb: Ueberschuss) {
    const [j1, , j3] = ueb.jahre;
    // Konten je Bereich und Art (A1, A2 …) über die drei Jahre verdichten
    const pos = new Map<string, { kz: string; konto: string; name: string; w: number[] }>();
    for (const x of jw) {
      if (!x.kennzahl || x.kennzahl.length < 2) continue;
      const kz = x.kennzahl.slice(0, 2);
      if (!BEREICHE.includes(kz[0] as never) || !'12'.includes(kz[1])) continue;
      const i = ueb.jahre.indexOf(x.jahr);
      if (i < 0) continue;
      const key = `${kz}|${x.konto}`;
      const p = pos.get(key) ?? { kz, konto: x.konto, name: x.name, w: [0, 0, 0] };
      p.w[i] += x.wert;
      pos.set(key, p);
    }
    const liste = [...pos.values()].sort((a, b) => a.kz.localeCompare(b.kz) || a.konto.localeCompare(b.konto));
    this.karteBeginnen(`TÄTIGKEITSBEREICHE UND KONTEN ${j3} – ${j1}`, [
      { x: 23, text: 'KONTO', align: 'L' }, { x: 37, text: 'BEZEICHNUNG', align: 'L' },
      ...ueb.jahre.map((j, i) => ({ x: [138, 162, 188][i], text: String(j), align: 'R' as const })),
    ]);
    const gruppe = (kz: string, titel: string, summe: number[]) => {
      if (summe.every((w) => w === 0)) return;
      this.zeilePlatz(12);
      this.txt(23, titel, { size: 7.5, bold: true, color: C.grau });
      this.y += 5;
      for (const p of liste.filter((x) => x.kz === kz && x.w.some((w) => w !== 0))) {
        this.zeilePlatz();
        this.txt(23, p.konto);
        this.txt(37, this.kurz(p.name, 76));
        this.werte3(p.w);
        this.zeileLinie();
      }
      this.zeilePlatz();
      this.txt(37, `Summe ${titel}`, { bold: true });
      this.werte3(summe, true);
      this.zeileLinie();
    };
    for (const b of ueb.bereiche) {
      this.zeilePlatz(20);
      this.band();
      this.txt(23, bereichText(b.bereich), { bold: true, color: C.orangeDk });
      this.werte3(b.ergebnis, true, true);
      this.y += 6.4;
      gruppe(`${b.bereich}1`, 'Einnahmen', b.ein);
      gruppe(`${b.bereich}2`, 'Ausgaben', b.aus);
      this.y += 1.4;
    }
    this.zeilePlatz(20);
    this.y += 0.6;
    this.txt(23, 'Einnahmen aller Tätigkeitsbereiche', { bold: true });
    this.werte3(ueb.ein, true);
    this.zeileLinie();
    this.txt(23, 'Ausgaben aller Tätigkeitsbereiche', { bold: true });
    this.werte3(ueb.aus, true);
    this.zeileLinie();
    this.txt(23, 'Überschuss / Fehlbetrag', { size: 9, bold: true });
    this.werte3(ueb.ergebnis, true, true);
    this.karteBeenden('Beträge in EUR. Bereichszeile = Ergebnis des Tätigkeitsbereichs (Einnahmen abzüglich Ausgaben). '
      + 'Konten ohne Bewegung in allen drei Jahren werden nicht ausgewiesen. Geld- und Darlehenskonten sind nicht Teil der Einnahmen-Ausgaben-Rechnung.');
  }

  steuerBank(bank: Bankbestand[], jahre: number[]) {
    if (!bank.length) return;
    this.karteBeginnen(`BANKKONTEN – ANFANGS- UND ENDBESTAND ${jahre[2]} – ${jahre[0]}`, [
      { x: 23, text: 'KONTO', align: 'L' }, { x: 37, text: 'BEZEICHNUNG', align: 'L' },
      { x: 138, text: 'ANFANG 01.01.', align: 'R' }, { x: 162, text: 'ENDE 31.12.', align: 'R' }, { x: 188, text: 'VERÄNDERUNG', align: 'R' },
    ]);
    for (const j of jahre) {
      const l = bank.filter((b) => b.jahr === j);
      if (!l.length) continue;
      const anfang = l.reduce((s, b) => s + b.anfang, 0), ende = l.reduce((s, b) => s + b.ende, 0);
      this.zeilePlatz(14);
      this.band();
      this.txt(23, `Geschäftsjahr ${j}`, { bold: true, color: C.orangeDk });
      this.txt(138, zahl(anfang), { bold: true, align: 'R' });
      this.txt(162, zahl(ende), { bold: true, align: 'R' });
      this.txt(188, zahl(ende - anfang), { bold: true, align: 'R', color: this.farbe(ende - anfang) });
      this.y += 6.4;
      for (const b of l) {
        this.zeilePlatz();
        this.txt(23, b.konto);
        this.txt(37, this.kurz(b.name, 76));
        this.txt(138, zahl(b.anfang), { align: 'R' });
        this.txt(162, zahl(b.ende), { align: 'R' });
        this.txt(188, zahl(b.delta), { align: 'R', color: this.farbe(b.delta) });
        this.zeileLinie();
      }
      this.y += 1.4;
    }
    this.karteBeenden('Beträge in EUR je Geschäftsjahr. Jahreszeile = Summe aller Konten. Darlehenskonten mit negativem Bestand.');
  }

  // ---------------------------------------------------------------- Anlagevermögen
  anlagen(alle: Anlage[], spiegel: Spiegel[], summe: SpiegelSumme) {
    this.kopfband('ANLAGEVERMÖGEN', `Geschäftsjahr ${this.jahr} · Anlagenspiegel und Abschreibungen`);
    this.kennzahl(LEFT, `BUCHWERT 01.01.${this.jahr}`, betragText(summe.bw_beginn));
    this.kennzahl(66, 'ZUGÄNGE', betragText(summe.zugang));
    this.kennzahl(104, `ABSCHREIBUNG ${this.jahr}`, betragText(summe.afa_jahr));
    this.kennzahl(144, `BUCHWERT 31.12.${this.jahr}`, betragText(summe.bw_ende), C.orangeDk);
    if (!spiegel.length) {
      this.txt(LEFT, `Bis ${this.jahr} sind keine Anlageobjekte erfasst.`, { size: 10 });
      return;
    }
    this.anlagenSpiegel(spiegel, summe);
    this.anlagenEntwicklung(alle, spiegel);
  }

  anlagenSpiegel(spiegel: Spiegel[], s: SpiegelSumme) {
    const k = { size: 7.5 };
    this.karteBeginnen(`ANLAGENSPIEGEL ${this.jahr}`, [
      { x: 20, text: 'NR.', align: 'L' }, { x: 29, text: 'BEZEICHNUNG', align: 'L' }, { x: 66, text: 'DATUM', align: 'L' },
      { x: 101, text: 'ANSCH.-WERT', align: 'R' }, { x: 110, text: 'ND', align: 'R' }, { x: 122, text: 'AFA %', align: 'R' },
      { x: 141, text: 'BW 01.01.', align: 'R' }, { x: 156, text: 'ZUGANG', align: 'R' }, { x: 172, text: `AFA ${this.jahr}`, align: 'R' }, { x: 190, text: 'BW 31.12.', align: 'R' },
    ]);
    for (const a of spiegel) {
      this.zeilePlatz();
      this.txt(20, String(a.anlnr).padStart(4, '0'), k);
      this.txt(29, this.kurz(a.bezeichnung, 35, 7.5), k);
      this.txt(66, dat(a.anschdat), k);
      this.txt(101, zahl(a.anschwert), { ...k, align: 'R' });
      this.txt(110, String(a.nutzdauer), { ...k, align: 'R' });
      this.txt(122, zahl(a.afa_satz), { ...k, align: 'R' });
      this.txt(141, zahl(a.bw_beginn), { ...k, align: 'R' });
      this.txt(156, zahl(a.zugang), { ...k, align: 'R' });
      this.txt(172, zahl(a.afa_jahr), { ...k, align: 'R' });
      this.txt(190, zahl(a.bw_ende), { ...k, bold: true, align: 'R' });
      this.zeileLinie();
    }
    this.zeilePlatz(8);
    this.y += 0.6;
    this.txt(29, 'Summe', { size: 9, bold: true });
    this.txt(101, zahl(s.anschwert), { ...k, bold: true, align: 'R' });
    this.txt(141, zahl(s.bw_beginn), { ...k, bold: true, align: 'R' });
    this.txt(156, zahl(s.zugang), { ...k, bold: true, align: 'R' });
    this.txt(172, zahl(s.afa_jahr), { ...k, bold: true, align: 'R' });
    this.txt(190, zahl(s.bw_ende), { ...k, bold: true, align: 'R', color: C.orangeDk });
    this.karteBeenden('Beträge in EUR. ND = Nutzungsdauer in Jahren. Lineare Abschreibung, im Anschaffungsjahr anteilig nach den je Objekt '
      + 'hinterlegten Monaten. Objekte, die vor dem Geschäftsjahr voll abgeschrieben waren, sind nicht enthalten. Die Abschreibung ist eine '
      + 'Information zum Jahresabschluss und verändert das Ergebnis der Einnahmen-Ausgaben-Rechnung nicht.');
  }

  /** Wertentwicklung wie Excel: Objekte als Spalten (max. 6 je Block), Buchwerte zum 31.12. je Jahr */
  anlagenEntwicklung(alle: Anlage[], spiegel: Spiegel[]) {
    const { objekte, jahre } = wertentwicklung(alle, spiegel, this.jahr);
    if (!objekte.length) return;
    const bloecke = Math.ceil(objekte.length / MAX_SPALTEN);
    for (let teil = 1; teil <= bloecke; teil++) {
      const von = (teil - 1) * MAX_SPALTEN;
      const block = objekte.slice(von, von + MAX_SPALTEN);
      const letzter = teil === bloecke;
      const rechts = letzter ? 166 : 190;
      const breite = (rechts - 46) / block.length;
      const xs = block.map((_, i) => 46 + breite * (i + 1));
      const spalten: Spalte[] = [{ x: 20, text: 'BEZEICHNUNG', align: 'L' },
        ...block.map((a, i) => ({ x: xs[i], text: this.kurz(a.bezeichnung.toUpperCase(), breite - 2, 7), align: 'R' as const }))];
      if (letzter) spalten.push({ x: 190, text: 'GESAMT', align: 'R' });
      this.karteBeginnen(bloecke > 1 ? `WERTE ZUM 31.12. DES JEWEILIGEN JAHRES (${teil}/${bloecke})` : 'WERTE ZUM 31.12. DES JEWEILIGEN JAHRES', spalten);

      const stamm: [string, (a: Anlage) => string][] = [
        ['Anschaffungsdatum', (a) => dat(a.anschdat)],
        ['Anschaffungswert (netto)', (a) => zahl(a.anschwert)],
        ['Nutzungsdauer in Jahren', (a) => String(a.nutzdauer)],
        ['Jährliche AfA %', (a) => (a.nutzdauer > 0 ? zahl(100 / a.nutzdauer) : '')],
        ['Jährliche AfA EUR', (a) => (a.nutzdauer > 0 ? zahl(a.anschwert / a.nutzdauer) : '')],
      ];
      for (const [label, fn] of stamm) {
        this.zeilePlatz(4.8);
        this.txt(20, label, { size: 7, bold: true });
        block.forEach((a, i) => this.txt(xs[i], fn(a), { size: 7, align: 'R' }));
        this.zeileLinie(4.8);
      }
      this.y += 1.2;
      for (const z of jahre) {
        this.zeilePlatz(4.8);
        const akt = z.jahr === this.jahr;
        if (akt) this.band();
        this.txt(20, String(z.jahr), { size: 7, bold: true, color: akt ? C.orangeDk : C.ink });
        block.forEach((_, i) => {
          const w = z.werte[von + i];
          if (w !== null) this.txt(xs[i], zahl(w), { size: 7, align: 'R' });
        });
        if (letzter) this.txt(190, zahl(z.summe), { size: 7, bold: true, align: 'R' });
        if (akt) this.y += 4.8; else this.zeileLinie(4.8);
      }
      this.y -= 4.8;
      this.karteBeenden(letzter ? 'Beträge in EUR. Buchwerte jeweils zum 31.12., Darstellung wie Excel „Werte Anlagevermögen“.' : undefined);
    }
  }

  // ---------------------------------------------------------------- Abschluss: Folgeköpfe und Fußzeilen
  async render(): Promise<Buffer> {
    const n = this.p.pageCount();
    for (let s = 1; s <= n; s++) {
      this.p.setPage(s - 1);
      let titel = '', erste = false;
      for (const t of this.teile) if (t.von <= s) { titel = t.titel; erste = t.von === s; }
      if (!erste) this.folgekopf(titel);
      fusszeile(this.p, this.v, s, n);
    }
    return this.p.render();
  }
}

/** PDF mit den gewählten Teilen */
export async function abschlussPdf(db: Db, v: Verein, jahr: number, t: Teile): Promise<{ pdf: Buffer; titel: string }> {
  if (!t.ear && !t.steuer && !t.anlagen) throw new BusinessError('Bitte mindestens einen Teil auswählen: EAR, Steuererklärung oder Anlagevermögen.');
  const titel = abschlussTitel(jahr, t);
  const d = new Abschlussdruck(v, jahr, titel);
  if (t.ear || t.steuer) {
    const { werte } = await jahreswerteLesen(db, jahr - 2, jahr);
    const ueb = ueberschussBerechnen(werte, jahr);
    if (t.ear) {
      d.teilBeginnen(`Einnahmen-Ausgaben-Rechnung ${jahr}`);
      d.ear(earBerechnen(werte, jahr), ueb, await bankBestaende(db, jahr));
    }
    if (t.steuer) {
      const bank = (await Promise.all(ueb.jahre.map((j) => bankBestaende(db, j)))).flat();
      d.teilBeginnen(`Steuererklärung ${jahr}`);
      d.steuer(werte, ueb, bank);
    }
  }
  // Anlagevermögen ist in der Steuererklärung enthalten
  if (t.anlagen || t.steuer) {
    const alle = await anlagenLesen(db);
    const { spiegel, summe } = spiegelBerechnen(alle, jahr);
    d.teilBeginnen(`Anlagevermögen ${jahr}`);
    d.anlagen(alle, spiegel, summe);
  }
  return { pdf: await d.render(), titel };
}

/**
 * Ablage in Paperless (wie in der SAP-App nach Prüfung der Voransicht): gibt es das Dokument mit
 * diesem Titel bereits, wird eine neue Version übertragen, sonst ein neues Dokument angelegt.
 */
export async function abschlussAblegen(v: Verein, jahr: number, titel: string, pdf: Buffer, ergebnis: number, benutzer: string) {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Anbindungen).');
  const pl = paperless(v);
  let id = Number((await pl.dokumenteSuchen({ title__iexact: titel }).catch(() => []))[0]?.id) || null;
  const neu = !id;
  if (id) await pl.warteAufDokument(await pl.uploadVersion(id, pdf, `${titel}.pdf`, `Neudruck ${dat(heute())}`), 15).catch(() => null);
  const werte = { titel, jahr, ergebnis, verein: v.name, heute: heute(), benutzer };
  const warnungen: string[] = [];
  if (!id) {
    const r = await kontextAblegen(pl, K.abschluss, 'tco', werte, pdf, `${titel}.pdf`, { benutzer });
    if (!r.id) throw new BusinessError('Hochgeladen, die DOKID ist aber noch nicht verfügbar – bitte in einer Minute erneut ablegen.');
    id = r.id;
    warnungen.push(...r.warnungen);
  }
  // Felder laut zentraler Paperless-Zuordnung (Kontext „Jahresabschluss“)
  warnungen.push(...(await kontextAktualisieren(pl, K.abschluss, 'tco', id, werte, { ohneNotiz: true })).warnungen);
  await pl.notizAnlegen(id, `${titel}, Ergebnis ${betragText(ergebnis)} – Portal ${benutzer}, ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`).catch(() => undefined);
  return { id, text: `${neu ? '„' + titel + '“ in Paperless abgelegt' : 'Neue Version nach Paperless übertragen'} (DOKID ${String(id).padStart(6, '0')}).`, warnungen };
}
