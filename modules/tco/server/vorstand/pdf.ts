import { dat, heute } from '../format.js';
import { C, LEFT, umbruch } from '../pdf/layout.js';
import type { Db, Verein } from '../verein.js';
import { Abschlussdruck } from '../abschluss/pdf.js';
import { sitzungLesen, type SitzungDetail } from './logik.js';
import { abstimmungText, ART_TEXT, verlaufKurz } from './regeln.js';
import { textLesen, type Stueck } from './format.js';

/**
 * Protokoll einer Vorstandssitzung als PDF – im Layout der übrigen Vereinsdrucke (Kopfband, Karten, Folgekopf, Fußzeile).
 * Kopf mit Datum, Zeit, Ort und Stand; Teilnehmer; je Tagesordnungspunkt Text, Beschlüsse mit Nummer und Abstimmung,
 * Aufgaben mit Verantwortlichen und Frist; Anlagen; Freigabevermerk bzw. Zeilen für die Unterschriften.
 * Protokolltexte erscheinen formatiert (fett, kursiv, durchgestrichen, Listen, anklickbare Verknüpfungen – format.ts).
 */
const ROT = 'B3261E';
const GRUEN = '2E7D32';
const BLAU = '0057BD';
/** Anlage im Druck: Datei mit Namen, Link als anklickbare Bezeichnung mit Adresse */
const anlageText = (a: { dateiname: string; url: string | null }) => (a.url ? `[${a.dateiname.replace(/[[\]]/g, '')}](${a.url}) (${a.url})` : a.dateiname);

class Protokolldruck extends Abschlussdruck {
  constructor(v: Verein, readonly s: SitzungDetail, titel: string) { super(v, Number(s.datum.slice(0, 4)), titel); }

  absatz(text: string, o: { size?: number; color?: string; bold?: boolean; einzug?: number } = {}) {
    const size = o.size ?? 8.5, x = LEFT + (o.einzug ?? 0), breite = 172 - (o.einzug ?? 0);
    for (const roh of text.split(/\r?\n/)) {
      const fett = /^\*\*(.*)\*\*$/.exec(roh.trim());
      const zeilen = umbruch(this.p, (fett ? fett[1] : roh).replace(/\*\*|__/g, ''), size, breite);
      if (!zeilen.length) { this.y += size * 0.25; continue; }
      for (const z of zeilen) { this.platz(size * 0.5); this.txt(x, z, { size, color: o.color ?? C.ink, bold: o.bold || !!fett }); this.y += size * 0.47; }
    }
  }

  /** formatierter Text (format.ts): Absätze, Aufzählungen, fett/kursiv/durchgestrichen, Verknüpfungen blau und anklickbar */
  formatiert(text: string, o: { size?: number; color?: string; bold?: boolean; einzug?: number } = {}) {
    const size = o.size ?? 8.5, x0 = LEFT + (o.einzug ?? 0), breite = 172 - (o.einzug ?? 0), farbe = o.color ?? C.ink;
    textLesen(text).forEach((b, i) => {
      if (i > 0) this.y += size * 0.25;
      if (b.art === 'absatz') for (const z of b.zeilen) this.zeileDrucken(z, x0, breite, size, farbe, !!o.bold);
      else b.punkte.forEach((z, k) => this.zeileDrucken(z, x0 + 5, breite - 5, size, farbe, !!o.bold, { text: b.nummeriert ? `${b.start + k}.` : '•', x: x0 + 1 }));
    });
  }

  private zeileDrucken(stuecke: Stueck[], x0: number, breite: number, size: number, farbe: string, fett: boolean, marke?: { text: string; x: number }) {
    const worte = stuecke.flatMap((s) => s.text.split(/(\s+)/).filter(Boolean).map((t) => ({ t, s })));
    const stil = (s: Stueck) => ({ size, bold: fett || !!s.fett, italic: !!s.kursiv, color: s.href ? BLAU : farbe });
    let zeile: typeof worte = [], w = 0, erste = true;
    const ausgeben = () => {
      while (zeile.length && !zeile[zeile.length - 1].t.trim()) zeile.pop();
      this.platz(size * 0.5);
      if (erste && marke) this.txt(marke.x, marke.text, { size, color: farbe });
      let x = x0;
      for (const { t, s } of zeile) {
        const o = stil(s), tw = this.p.textWidth(t, o);
        if (t.trim()) {
          this.txt(x, t, o);
          if (s.durch) this.p.line(x, this.y - size * 0.12, x + tw, this.y - size * 0.12, o.color, 0.25);
          if (s.href) { this.p.line(x, this.y + 0.6, x + tw, this.y + 0.6, BLAU, 0.2); this.p.link(x, this.y - size * 0.35, tw, size * 0.45, s.href); }
        }
        x += tw;
      }
      this.y += size * 0.47;
      zeile = []; w = 0; erste = false;
    };
    if (!worte.length) { this.y += size * 0.25; return; }
    for (const wort of worte) {
      if (!wort.t.trim() && !zeile.length) continue;
      const tw = this.p.textWidth(wort.t, stil(wort.s));
      if (w + tw > breite && zeile.length) { ausgeben(); if (!wort.t.trim()) continue; }
      zeile.push(wort); w += tw;
    }
    if (zeile.length) ausgeben();
  }

  drucken() {
    const s = this.s;
    this.teilBeginnen(`Protokoll ${s.nr}`);
    this.kopfband('PROTOKOLL', this.kurz(`${s.nr} · ${s.titel}`, 112, 10));
    this.kennzahl(LEFT, 'DATUM', dat(s.datum));
    this.kennzahl(52, 'ZEIT', s.beginn ? `${s.beginn}${s.ende ? `–${s.ende}` : ''} Uhr` : '–');
    this.kennzahl(86, 'ORT', this.kurz(s.ort ?? '–', 36, 9.5));
    this.kennzahl(126, 'ART', this.kurz(ART_TEXT[s.art], 30, 9.5));
    this.kennzahl(160, 'STAND', s.status === 'FREIGEGEBEN' ? 'freigegeben' : 'Entwurf', s.status === 'FREIGEGEBEN' ? GRUEN : ROT);

    // Teilnehmer
    const gruppe = (status: string, art?: 'GAST') => s.teilnehmer.filter((t) => t.status === status && (art ? t.art === art : t.art === 'VORSTAND'))
      .map((t) => `${t.name}${t.rolle ? ` (${t.rolle})` : ''}`).join('; ');
    const zeilen: [string, string][] = [
      ['Anwesend', gruppe('ANWESEND')], ['Entschuldigt', gruppe('ENTSCHULDIGT')], ['Es fehlten', gruppe('FEHLT')],
      ['Gäste', s.teilnehmer.filter((t) => t.art === 'GAST' && t.status === 'ANWESEND').map((t) => `${t.name}${t.rolle ? ` (${t.rolle})` : ''}`).join('; ')],
      ['Sitzungsleitung', s.leitung ?? ''], ['Protokoll', s.protokoll_von ?? ''],
    ];
    this.txt(LEFT, 'Teilnehmer', { bold: true, color: C.orangeDk });
    this.y += 6;
    for (const [k, w] of zeilen.filter(([, w]) => w)) {
      const teile = umbruch(this.p, w, 8.5, 140);
      this.platz(teile.length * 4 + 1);
      this.txt(LEFT, k, { size: 8, color: C.grau });
      teile.forEach((z, i) => this.p.text(LEFT + 32, this.y + i * 4, z, { size: 8.5, color: C.ink }));
      this.y += teile.length * 4 + 1;
    }
    const bf = s.beschlussfaehig;
    if (bf.ok != null) {
      this.txt(LEFT + 32, `${bf.anwesend} von ${bf.gesamt} Vorstandsmitgliedern anwesend – ${bf.ok ? 'beschlussfähig' : 'nicht beschlussfähig'}`,
        { size: 8, color: bf.ok ? GRUEN : ROT });
      this.y += 5;
    }
    this.y += 4;
    if (s.bemerkung) { this.formatiert(s.bemerkung); this.y += 3; }

    // Tagesordnung
    this.txt(LEFT, 'Tagesordnung', { bold: true, color: C.orangeDk });
    this.y += 6;
    for (const t of s.tops) this.absatz(`${t.nr}. ${t.titel}${t.status === 'VERTAGT' ? ' (vertagt)' : ''}`, { size: 8.5, einzug: 2 });
    this.y += 4;

    for (const t of s.tops) {
      this.platz(16);
      this.p.rect(LEFT, this.y - 4.4, 174, 6.4, { fill: C.orangeSoft, radius: 1.5 });
      this.txt(LEFT + 2, this.kurz(`TOP ${t.nr}  ${t.titel}`, 130, 9.5), { size: 9.5, bold: true });
      if (t.verantwortlich) this.p.text(190, this.y, this.kurz(t.verantwortlich, 38, 7.5), { size: 7.5, color: C.grau, align: 'R' });
      this.y += 7;
      // Verlauf: frühere Behandlungen des Themas
      if (t.verlauf_vorher.length) this.absatz(`Bisher behandelt: ${verlaufKurz(t.verlauf_vorher)}`, { size: 7.5, color: C.grau, einzug: 2 });
      if (t.status === 'VERTAGT') { this.absatz('Der Punkt wurde vertagt.', { color: C.grau }); }
      if (t.text) { this.formatiert(t.text); this.y += 1.5; }
      for (const e of t.eintraege) {
        this.platz(10);
        if (e.art === 'BESCHLUSS') {
          this.txt(LEFT + 2, `Beschluss ${e.nr}`, { size: 8, bold: true, color: BLAU });
          this.y += 4.2;
          this.formatiert(e.text, { einzug: 2, bold: true });
          const a = abstimmungText(e);
          if (a) this.absatz(`Abstimmung: ${a}`, { einzug: 2, size: 8, color: e.ergebnis === 'ABGELEHNT' ? ROT : C.grau });
        } else if (e.art === 'AUFGABE') {
          const wer = [e.verantwortlich, e.faellig && `bis ${dat(e.faellig)}`].filter(Boolean).join(', ');
          this.formatiert(`Aufgabe: ${e.text}${wer ? ` (${wer})` : ''}${e.erledigt_am ? ` – erledigt ${dat(e.erledigt_am.slice(0, 10))}` : ''}`, { einzug: 2 });
        } else {
          this.formatiert(`Info: ${e.text}`, { einzug: 2, color: C.grau });
        }
        this.y += 1.5;
      }
      const anl = s.anlagen.filter((a) => a.top_id === t.id);
      if (anl.length) this.formatiert(`Anlagen: ${anl.map(anlageText).join('; ')}`, { einzug: 2, size: 7.5, color: C.grau });
      this.y += 4;
    }

    const allg = s.anlagen.filter((a) => a.top_id == null && !(s.importiert && a.mime === 'text/markdown'));
    if (allg.length) {
      this.platz(12);
      this.txt(LEFT, 'Anlagen', { bold: true, color: C.orangeDk });
      this.y += 6;
      for (const a of allg) this.formatiert(`– ${anlageText(a)}`, { size: 8 });
      this.y += 4;
    }

    // Freigabe bzw. Unterschriften
    this.platz(30);
    this.y += 4;
    if (s.status === 'FREIGEGEBEN' && s.freigegeben_am) {
      this.absatz(`Das Protokoll wurde am ${dat(s.freigegeben_am.slice(0, 10))} von ${s.freigegeben_von ?? 'unbekannt'} im Vereinsportal freigegeben.`, { color: GRUEN });
    } else {
      this.y += 10;
      this.p.line(LEFT, this.y, LEFT + 70, this.y, C.grau, 0.3);
      this.p.line(LEFT + 100, this.y, LEFT + 170, this.y, C.grau, 0.3);
      this.y += 4;
      this.txt(LEFT, `Protokoll${s.protokoll_von ? `: ${s.protokoll_von}` : ''}`, { size: 7.5, color: C.grau });
      this.txt(LEFT + 100, `Sitzungsleitung${s.leitung ? `: ${s.leitung}` : ''}`, { size: 7.5, color: C.grau });
      this.y += 6;
    }
    this.absatz(`Stand ${dat(heute())}${s.importiert ? ' · aus einem älteren Protokoll übernommen' : ''}`, { size: 7, color: C.grau });
  }
}

export async function protokollPdf(db: Db, v: Verein, id: number): Promise<{ pdf: Buffer; titel: string }> {
  const s = await sitzungLesen(db, id);
  const titel = `Protokoll ${s.nr} ${s.titel} ${dat(s.datum)}`;
  const d = new Protokolldruck(v, s, titel);
  d.drucken();
  return { pdf: await d.render(), titel };
}
