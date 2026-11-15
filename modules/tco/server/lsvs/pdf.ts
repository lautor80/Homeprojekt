import { Pdf, type TextOpts } from '../../../../server/src/lib/pdfdoc.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { dat, heute } from '../format.js';
import { C, fusszeile, kuerzen, LEFT, RIGHT } from '../pdf/layout.js';
import { logoWeiss, paperless, plAktiv, type Verein } from '../verein.js';
import { kontextAblegen } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';
import type { Bestand } from './logik.js';

/**
 * Ausdruck der LSVS-Bestandsmeldung im TCO-Layout (orangefarbenes Kopfband mit Logo, Kennzahlen,
 * Karten mit grauem Rand, Folgekopf, Fußzeile des Vereins): Kopfangaben der Austauschdatei,
 * Zahlen je Jahrgang und Geschlecht mit Summe und die nicht gemeldeten Mitglieder.
 * Ohne Lauf ist es die Voransicht (Wasserzeichen-Hinweis im Kopfband).
 */

export interface LaufInfo { id: number; erstellt_am: string; erstellt_von: string; dateiname: string }

const UNTEN = 268;
const OBEN = 24;
const SP = { jahrgang: 26, m: 90, w: 122, d: 154, gesamt: 186 };

export const lsvsTitel = (stichtag: string, lauf?: number | null) =>
  `LSVS-Bestandsmeldung ${stichtag.slice(0, 4)}${lauf ? ` (Lauf ${lauf})` : ' – Voransicht'}`;

class Druck {
  readonly p: Pdf;
  y = 0;
  karteTop = 0;

  constructor(readonly v: Verein, readonly titel: string) {
    this.p = new Pdf({ title: titel, author: v.name, creator: 'TCO Vereinsportal' });
    this.p.newPage();
  }

  txt(x: number, text: string, o: TextOpts = {}) { this.p.text(x, this.y, text, { size: 8, color: C.ink, ...o }); }

  kopfband(untertitel: string) {
    this.p.rect(0, 0, 210, 46, { fill: C.orange });
    this.p.text(LEFT, 31, 'LSVS-Bestandsmeldung', { size: 24, color: 'FFFFFF' });
    this.p.text(LEFT, 38.5, untertitel, { size: 10, color: 'FFFFFF' });
    this.p.image(logoWeiss(this.v), 137, 5.6, 57, 34.7);
  }

  kennzahl(x: number, label: string, wert: string) {
    this.p.text(x, 58, label, { size: 7, color: C.grau });
    this.p.text(x, 63, wert, { size: 9.5, bold: true, color: C.ink });
  }

  neueSeite() { this.p.newPage(); this.y = OBEN; }

  karte(titel: string, inhalt: () => void) {
    if (this.y + 30 > UNTEN) this.neueSeite();
    this.txt(LEFT, titel, { bold: true, color: C.orangeDk });
    this.y += 3;
    this.karteTop = this.y;
    this.y += 7;
    inhalt();
    this.p.rect(LEFT, this.karteTop, 174, this.y - this.karteTop, { stroke: C.rand, lw: 0.3, radius: 3 });
    this.y += 9;
  }

  /** Zeile innerhalb einer Karte; am Seitenende Karte schließen und auf der Folgeseite fortsetzen */
  zeile(kopf?: () => void, hoehe = 5.6) {
    if (this.y + hoehe > UNTEN) {
      this.p.rect(LEFT, this.karteTop, 174, this.y - this.karteTop, { stroke: C.rand, lw: 0.3, radius: 3 });
      this.neueSeite();
      this.karteTop = this.y;
      this.y += 7;
      kopf?.();
    }
  }

  feld(label: string, wert: string) {
    this.zeile();
    this.txt(24, label, { color: C.grau });
    this.txt(80, kuerzen(this.p, wert || '–', 8, 106));
    this.y += 5.6;
  }

  tabellenkopf() {
    const k = (x: number, t: string, align: 'L' | 'R' = 'R') => this.p.text(x, this.y, t, { size: 7, color: C.grau, align });
    k(SP.jahrgang, 'Jahrgang', 'L'); k(SP.m, 'männlich'); k(SP.w, 'weiblich'); k(SP.d, 'divers'); k(SP.gesamt, 'gesamt');
    this.p.line(20, this.y + 2.6, 190, this.y + 2.6, C.linie, 0.3);
    this.y += 7.5;
  }

  async render(): Promise<Buffer> {
    const n = this.p.pageCount();
    for (let s = 1; s <= n; s++) {
      this.p.setPage(s - 1);
      if (s > 1) {
        this.p.text(LEFT, 13, this.titel, { size: 9, bold: true, color: C.ink });
        this.p.text(RIGHT, 13, this.v.name, { size: 8, color: C.grau, align: 'R' });
        this.p.rect(LEFT, 15.5, 174, 0.6, { fill: C.orange });
      }
      fusszeile(this.p, this.v, s, n);
    }
    return this.p.render();
  }
}

export async function lsvsPdf(v: Verein, b: Bestand, lauf?: LaufInfo | null): Promise<{ pdf: Buffer; titel: string }> {
  const titel = lsvsTitel(b.stichtag, lauf?.id);
  const d = new Druck(v, titel);
  d.kopfband(`${v.name} · Stichtag ${dat(b.stichtag)}${lauf ? ` · Lauf ${lauf.id}` : ' · Voransicht (noch keine Datei erzeugt)'}`);
  d.kennzahl(LEFT, 'Stichtag', dat(b.stichtag));
  d.kennzahl(58, 'Mitglieder gemeldet', String(b.summe.gesamt));
  d.kennzahl(98, 'männlich', String(b.summe.m));
  d.kennzahl(128, 'weiblich', String(b.summe.w));
  d.kennzahl(158, 'nicht gemeldet', String(b.hinweise.length));
  d.y = 76;

  d.karte('Austauschdatei für das LSVSnet (DOSB-Schnittstelle „SV-LSB“)', () => {
    d.feld('Vereinsnummer', b.kopf.nummer);
    d.feld('Verein', b.kopf.bezeichnung);
    d.feld('Ansprechpartner', b.kopf.ansprechpartner);
    d.feld('Fachverband (B-Meldung)', `${b.kopf.fachverband} – Tennis`);
    d.feld('Software', b.kopf.schluessel);
    if (lauf) {
      d.feld('Datei', lauf.dateiname);
      d.feld('Erzeugt', `${new Date(lauf.erstellt_am).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' })} von ${lauf.erstellt_von}`);
    } else d.feld('Erstellt', `Voransicht vom ${dat(heute())}`);
  });

  d.karte('A-Meldung: Mitglieder je Jahrgang (B-Meldung Tennis mit denselben Zahlen)', () => {
    d.tabellenkopf();
    for (const z of b.zeilen) {
      d.zeile(() => d.tabellenkopf());
      const r = (x: number, t: string | number, bold = false) => d.p.text(x, d.y, String(t), { size: 8, color: C.ink, align: 'R', bold });
      d.txt(SP.jahrgang, String(z.jahrgang));
      r(SP.m, z.m); r(SP.w, z.w); r(SP.d, z.d); r(SP.gesamt, z.m + z.w + z.d);
      d.p.line(20, d.y + 2.2, 190, d.y + 2.2, C.linie, 0.2);
      d.y += 5.6;
    }
    d.zeile(() => d.tabellenkopf(), 7);
    d.p.rect(20, d.y - 4.2, 170, 6, { fill: C.orangeSoft, radius: 1.5 });
    const s = (x: number, t: number) => d.p.text(x, d.y, String(t), { size: 8, color: C.ink, align: 'R', bold: true });
    d.txt(SP.jahrgang, 'Summe', { bold: true });
    s(SP.m, b.summe.m); s(SP.w, b.summe.w); s(SP.d, b.summe.d); s(SP.gesamt, b.summe.gesamt);
    d.y += 4;
  });

  if (b.hinweise.length) {
    d.karte(`Nicht gemeldet – Angaben im Mitgliederstamm fehlen (${b.hinweise.length})`, () => {
      for (const h of b.hinweise) {
        d.zeile();
        d.txt(24, kuerzen(d.p, h.name, 8, 100));
        d.txt(130, h.grund, { color: C.grau });
        d.y += 5.6;
      }
    });
  }
  return { pdf: await d.render(), titel };
}

/** Ausdruck eines Laufs in Paperless ablegen (Kontext „LSVS-Bestandsmeldung“ der zentralen Zuordnung) */
export async function lsvsAblegen(v: Verein, b: Bestand, lauf: LaufInfo, benutzer: string) {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Schnittstellen).');
  const { pdf, titel } = await lsvsPdf(v, b, lauf);
  const werte = { titel, jahr: Number(b.stichtag.slice(0, 4)), stichtag: b.stichtag, lauf: lauf.id, anzahl: b.summe.gesamt, verein: v.name, heute: heute(), benutzer };
  const r = await kontextAblegen(paperless(v), K.lsvs, 'tco', werte, pdf, `${titel}.pdf`, { benutzer });
  return { id: r.id, warnungen: r.warnungen, titel };
}
