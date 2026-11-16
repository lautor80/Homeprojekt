import { dat, heute } from '../format.js';
import { C, LEFT, umbruch } from '../pdf/layout.js';
import type { Db, Verein } from '../verein.js';
import { Abschlussdruck } from '../abschluss/pdf.js';
import { checklisteLesen, type Bezug, type Checkliste } from './logik.js';

/**
 * Checkliste als PDF zum Ausdrucken und Abhaken – im Layout der übrigen Vereinsdrucke (Kopfband, Karte, Folgekopf,
 * Fußzeile; Bausteine aus abschluss/pdf.ts). Je Veranstaltung bzw. Termin ein eigener Teil mit dem Stand der Schritte;
 * ohne Zuordnung die Vorlage mit dem Terminbezug in Worten.
 */

const GRUEN = '2E7D32';
const ROT = 'B3261E';
const X = { box: 21.5, titel: 28, wer: 112, faellig: 148, erledigt: 168 };
const B = { titel: 80, wer: 33, erledigt: 22 };

const tag = (z: string | Date) => {
  const d = new Date(z);
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
};

class Checklistendruck extends Abschlussdruck {
  constructor(v: Verein, readonly c: Checkliste, titel: string) { super(v, Number(heute().slice(0, 4)), titel); }

  teil(b: Bezug | null) {
    const c = this.c;
    this.teilBeginnen(b ? `${c.titel} – ${b.titel}` : c.titel);
    this.kopfband('CHECKLISTE', this.kurz(c.titel, 112, 10));
    this.kennzahl(LEFT, b ? 'VERANSTALTUNG' : 'KATEGORIE', this.kurz(b ? b.titel : c.kategorie ?? '–', 62, 9.5));
    this.kennzahl(84, 'TERMIN', b ? `${dat(b.termin)}${b.abgesagt ? ' (abgesagt)' : ''}` : 'Vorlage');
    this.kennzahl(118, 'VERANTWORTLICH', this.kurz(c.verantwortlich ?? '–', 38, 9.5));
    this.kennzahl(160, 'STAND', b ? `${b.fortschritt.erledigt} von ${b.fortschritt.gesamt}` : `${c.schritte.filter((x) => x.blatt).length} Schritte`,
      b && b.fortschritt.ueberfaellig ? ROT : C.ink);

    const kopf = [b && c.kategorie ? `Kategorie: ${c.kategorie}` : '', b?.ort ? `Ort: ${b.ort}` : ''].filter(Boolean).join(' · ');
    if (kopf) { this.txt(LEFT, kopf, { color: C.grau }); this.y += 5; }
    if (c.beschreibung) {
      for (const absatz of c.beschreibung.split(/\r?\n/)) {
        for (const z of umbruch(this.p, absatz, 8, 172)) { this.platz(4.5); this.txt(LEFT, z); this.y += 4.2; }
      }
      this.y += 4;
    }

    this.karteBeginnen('Schritte', [
      { x: X.titel, text: 'Schritt', align: 'L' }, { x: X.wer, text: 'Verantwortlich', align: 'L' },
      { x: X.faellig, text: b ? 'Fällig' : 'Termin', align: 'L' }, { x: X.erledigt, text: 'Erledigt', align: 'L' },
    ]);
    if (!c.schritte.length) { this.txt(X.titel, 'Diese Checkliste hat noch keine Schritte.', { color: C.grau }); this.zeileLinie(); }
    for (const s of c.schritte) {
      const z = b?.schritte.find((x) => x.schritt_id === s.id);
      // Unterschritte eingerückt; ein Schritt mit Unterschritten ist eine Gruppe ohne eigenes Kästchen
      const ein = (s.ebene - 1) * 4;
      const breite = B.titel - ein;
      const titel = umbruch(this.p, `${s.nr} ${s.titel}`, 8, breite);
      const text = (s.beschreibung ?? '').split(/\r?\n/).flatMap((a) => umbruch(this.p, a, 7, breite)).filter(Boolean);
      const hoehe = Math.max(5.6, titel.length * 4 + text.length * 3.4 + (text.length ? 2.6 : 1.6));
      this.zeilePlatz(hoehe);
      const y0 = this.y;
      if (s.blatt) {
        // Kästchen zum Abhaken – erledigte mit Haken
        this.p.rect(X.box + ein, y0 - 3, 3.4, 3.4, { stroke: z?.erledigt ? GRUEN : C.grau, lw: 0.3, radius: 0.5 });
        if (z?.erledigt) {
          this.p.line(X.box + ein + 0.7, y0 - 1.3, X.box + ein + 1.4, y0 - 0.5, GRUEN, 0.5);
          this.p.line(X.box + ein + 1.4, y0 - 0.5, X.box + ein + 2.8, y0 - 2.4, GRUEN, 0.5);
        }
      }
      titel.forEach((t, j) => this.p.text(X.titel + ein, y0 + j * 4, t, { size: 8, bold: !s.blatt || s.ebene === 1, color: C.ink }));
      text.forEach((t, j) => this.p.text(X.titel + ein, y0 + titel.length * 4 + j * 3.4, t, { size: 7, color: C.grau }));
      this.txt(X.wer, this.kurz(s.verantwortlich ?? (s.blatt ? c.verantwortlich ?? '' : ''), B.wer));
      if (b) this.txt(X.faellig, z?.faellig ? dat(z.faellig) : '', { color: z?.stand === 'UEBERFAELLIG' ? ROT : C.ink, bold: z?.stand === 'UEBERFAELLIG' });
      else if (s.blatt) this.txt(X.faellig, this.kurz(s.termin_text, 19, 7), { size: 7 });
      if (z?.gruppe) this.txt(X.erledigt, `${z.gruppe.erledigt} von ${z.gruppe.gesamt}`, { color: z.stand === 'ERLEDIGT' ? GRUEN : C.grau, bold: z.stand === 'ERLEDIGT' });
      else if (z?.erledigt) {
        this.txt(X.erledigt, tag(z.erledigt.am), { color: GRUEN });
        if (z.erledigt.von) this.p.text(X.erledigt, y0 + 3.4, this.kurz(z.erledigt.von, B.erledigt, 6.5), { size: 6.5, color: C.grau });
      }
      this.y = y0 + hoehe - 5.6;
      this.zeileLinie();
    }
    this.karteBeenden(`Stand ${dat(heute())} · Kästchen zum Abhaken von Hand; im Portal erledigte Schritte sind mit Datum und Namen eingetragen. Bei Schritten mit Unterschritten steht, wie viele davon erledigt sind.`);
  }
}

/** PDF einer Checkliste: alle Veranstaltungen/Termine (je ein Teil) oder nur `bezug`; ohne Zuordnung die Vorlage */
export async function checklistePdf(db: Db, v: Verein, id: number, bezug?: number | null): Promise<{ pdf: Buffer; titel: string }> {
  const c = await checklisteLesen(db, id);
  const bezuege = bezug ? c.bezuege.filter((b) => b.id === bezug) : c.bezuege;
  const titel = `Checkliste ${c.titel}${bezuege.length === 1 ? ` – ${bezuege[0].titel} ${dat(bezuege[0].termin)}` : ''}`;
  const d = new Checklistendruck(v, c, titel);
  if (bezuege.length) for (const b of bezuege) d.teil(b);
  else d.teil(null);
  return { pdf: await d.render(), titel };
}
