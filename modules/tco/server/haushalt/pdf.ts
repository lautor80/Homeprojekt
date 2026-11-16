import { BusinessError } from '../../../../server/src/errors.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { dat, heute, zahl } from '../format.js';
import { betragText, C, LEFT, umbruch } from '../pdf/layout.js';
import { K } from '../paperless-kontexte.js';
import { paperless, plAktiv, type Db, type Verein } from '../verein.js';
import { Abschlussdruck } from '../abschluss/pdf.js';
import { planLesen, type PlanSicht, type Position } from './logik.js';

/**
 * Haushaltsplan als PDF für die Mitgliederversammlung – im Layout des Jahresabschlusses (Kopfband, Karten, Folgekopf,
 * Fußzeile; Bausteine aus abschluss/pdf.ts): Tätigkeitsbereiche und Konten mit zwei Vorjahren, einmalige Vorhaben,
 * Liquiditätsvorschau und Erläuterungen.
 */

const MON = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export const haushaltTitel = (s: PlanSicht) =>
  `Haushaltsplan ${s.plan.jahr}${s.plan.fassung > 1 ? ` (${s.plan.fassung - 1}. Nachtrag)` : ''}${s.plan.status === 'ENTWURF' ? ' – Entwurf' : ''}`;

class Haushaltsdruck extends Abschlussdruck {
  constructor(v: Verein, readonly s: PlanSicht, titel: string) { super(v, s.plan.jahr, titel); }

  /** Wert des Basisjahres: Hochrechnung, solange das Jahr läuft */
  basis(p: Position): number { return p.grundlage?.hoch?.wert ?? p.grundlage?.ist[this.s.basisjahr] ?? 0; }
  vorjahr(p: Position): number { return p.grundlage?.ist[this.s.basisjahr - 1] ?? 0; }

  drei(w: [number, number, number], bold = false, farbe = false) {
    [138, 162, 188].forEach((x, i) => this.txt(x, zahl(w[i]), { bold, align: 'R', color: farbe ? this.farbe(w[i]) : C.ink }));
  }

  plan() {
    const { plan, summen, basisjahr, stand_monat } = this.s;
    const status = plan.status === 'ENTWURF' ? 'Entwurf' : plan.status === 'BESCHLOSSEN' ? `beschlossen am ${dat(plan.beschlossen_am)}` : `genehmigt am ${dat(plan.genehmigt_am)}`;
    this.kopfband('HAUSHALTSPLAN', `Geschäftsjahr ${plan.jahr} · Fassung ${plan.fassung} · ${status}`);
    this.kennzahl(LEFT, 'ZEITRAUM', `01.01.${plan.jahr} – 31.12.${plan.jahr}`);
    this.kennzahl(66, 'EINNAHMEN PLAN', betragText(summen.einnahmen));
    this.kennzahl(104, 'AUSGABEN PLAN', betragText(summen.ausgaben));
    this.kennzahl(144, 'ÜBERSCHUSS / FEHLBETRAG PLAN', betragText(summen.ergebnis), this.farbe(summen.ergebnis, C.orangeDk));

    const laufend = stand_monat < 12;
    this.karteBeginnen('1. HAUSHALTSPLAN – TÄTIGKEITSBEREICHE UND KONTEN', [
      { x: 23, text: 'KONTO', align: 'L' }, { x: 37, text: 'BEZEICHNUNG', align: 'L' },
      { x: 138, text: `IST ${basisjahr - 1}`, align: 'R' }, { x: 162, text: `${laufend ? 'HOCHR.' : 'IST'} ${basisjahr}`, align: 'R' }, { x: 188, text: `PLAN ${plan.jahr}`, align: 'R' },
    ]);
    const sum = (l: Position[]): [number, number, number] => [
      l.reduce((a, p) => a + this.vorjahr(p), 0), l.reduce((a, p) => a + this.basis(p), 0), l.reduce((a, p) => a + p.planwert, 0),
    ];
    for (const b of this.s.bereiche) {
      const pos = this.s.positionen.filter((p) => p.bereich === b.bereich);
      if (!pos.length) continue;
      const e = sum(pos.filter((p) => p.art === 'E')), a = sum(pos.filter((p) => p.art === 'A'));
      this.zeilePlatz(14);
      this.band();
      this.txt(23, b.text, { bold: true, color: C.orangeDk });
      this.drei([e[0] - a[0], e[1] - a[1], e[2] - a[2]], true, true);
      this.y += 6.4;
      for (const [text, art, s] of [['Einnahmen', 'E', e], ['Ausgaben', 'A', a]] as const) {
        const l = pos.filter((p) => p.art === art);
        if (!l.length) continue;
        this.zeilePlatz(12);
        this.txt(23, text, { bold: true });
        this.drei(s, true);
        this.zeileLinie();
        for (const p of l) {
          this.zeilePlatz();
          this.txt(23, p.konto);
          this.txt(37, this.kurz(p.name, 76));
          this.drei([this.vorjahr(p), this.basis(p), p.planwert]);
          this.zeileLinie();
        }
      }
      this.y += 1.4;
    }
    const alle = this.s.positionen;
    const e = sum(alle.filter((p) => p.art === 'E')), a = sum(alle.filter((p) => p.art === 'A'));
    if (summen.vorhaben_e || summen.vorhaben_a) {
      this.zeilePlatz(14);
      this.band();
      this.txt(23, 'Einmalige Vorhaben (siehe 2.)', { bold: true, color: C.orangeDk });
      this.txt(188, zahl(summen.vorhaben_e - summen.vorhaben_a), { bold: true, align: 'R', color: this.farbe(summen.vorhaben_e - summen.vorhaben_a) });
      this.y += 6.4;
    }
    this.zeilePlatz(20);
    this.y += 0.6;
    this.txt(23, 'Summe Einnahmen', { bold: true });
    this.drei([e[0], e[1], summen.einnahmen], true);
    this.zeileLinie();
    this.txt(23, 'Summe Ausgaben', { bold: true });
    this.drei([a[0], a[1], summen.ausgaben], true);
    this.zeileLinie();
    this.y += 0.6;
    this.txt(23, 'Überschuss / Fehlbetrag', { size: 9, bold: true });
    this.drei([e[0] - a[0], e[1] - a[1], summen.ergebnis], true, true);
    this.karteBeenden(`Beträge in EUR. ${laufend ? `${basisjahr} ist noch nicht abgeschlossen: Der Wert ist aus den Buchungen ${stand_monat ? `bis ${MON[stand_monat - 1]}` : 'der Vorjahre'} `
      + 'mit dem üblichen Jahresverlauf des Kontos hochgerechnet. ' : ''}Die Planwerte sind aus den Buchungen der Vorjahre abgeleitet und vom Vorstand geprüft.`);

    this.vorhaben();
    this.liquiditaet();
    this.erlaeuterungen();
  }

  vorhaben() {
    const v = this.s.vorhaben.filter((x) => x.eingeplant);
    if (!v.length) return;
    this.karteBeginnen('2. EINMALIGE VORHABEN', [
      { x: 23, text: 'VORHABEN', align: 'L' }, { x: 118, text: 'MONAT', align: 'L' }, { x: 162, text: 'EINNAHME', align: 'R' }, { x: 188, text: 'AUSGABE', align: 'R' },
    ]);
    for (const x of v) {
      this.zeilePlatz();
      this.txt(23, this.kurz(`${x.bezeichnung}${x.konto ? ` (Konto ${x.konto})` : ''}`, 92));
      this.txt(118, MON[x.monat - 1]);
      this.txt(x.art === 'E' ? 162 : 188, zahl(x.betrag), { align: 'R' });
      this.zeileLinie();
    }
    this.zeilePlatz(8);
    this.y += 0.6;
    this.txt(23, 'Summe', { size: 9, bold: true });
    this.txt(162, zahl(this.s.summen.vorhaben_e), { bold: true, align: 'R' });
    this.txt(188, zahl(this.s.summen.vorhaben_a), { bold: true, align: 'R' });
    this.karteBeenden('Einmalige Vorhaben stehen neben den laufenden Konten und sind in den Summen des Haushaltsplans enthalten.');
  }

  liquiditaet() {
    const l = this.s.liquiditaet;
    this.karteBeginnen(`${this.s.vorhaben.some((x) => x.eingeplant) ? '3' : '2'}. LIQUIDITÄTSVORSCHAU – GELDBESTAND JE MONATSENDE`, [
      { x: 23, text: 'MONAT', align: 'L' }, { x: 90, text: 'EINNAHMEN', align: 'R' }, { x: 122, text: 'AUSGABEN', align: 'R' },
      { x: 154, text: 'TILGUNG', align: 'R' }, { x: 188, text: 'GELDBESTAND', align: 'R' },
    ]);
    this.txt(23, `Anfangsbestand 01.01.${this.s.plan.jahr}`, { bold: true });
    this.txt(188, zahl(l.anfang), { bold: true, align: 'R', color: this.farbe(l.anfang) });
    this.zeileLinie();
    for (const m of l.monate) {
      this.zeilePlatz();
      const knapp = m.ausreichend === false;
      this.txt(23, MON[m.monat - 1]);
      this.txt(90, zahl(m.einnahmen), { align: 'R' });
      this.txt(122, zahl(m.ausgaben), { align: 'R' });
      this.txt(154, zahl(m.tilgung), { align: 'R' });
      this.txt(188, zahl(m.bestand), { align: 'R', bold: knapp, color: knapp || m.bestand < 0 ? 'B3261E' : C.ink });
      this.zeileLinie();
    }
    const res = l.mindestreserve === null ? 'Eine Mindestreserve ist nicht hinterlegt.'
      : `Mindestreserve ${betragText(l.mindestreserve)}${l.tiefster < l.mindestreserve ? ' – in den rot gedruckten Monaten unterschritten.' : ' – in allen Monaten eingehalten.'}`;
    this.karteBeenden(`Planwerte nach dem Jahresverlauf der Vorjahre auf die Monate verteilt. Anfangsbestand: ${l.anfang_herkunft.text}. `
      + `Tiefster Geldbestand ${betragText(l.tiefster)} Ende ${MON[l.tiefsterMonat - 1]}. ${res}`);
  }

  erlaeuterungen() {
    const zeilen: string[] = [];
    const sonder = this.s.positionen.flatMap((p) => (p.grundlage?.sonder ?? []).map((x) => `${p.konto} ${p.name}: ${x.jahr} – ${x.grund}`));
    if (sonder.length) zeilen.push('Sondereffekte (zählen nicht in die Grundlage): ' + sonder.join('; ') + '.');
    const notizen = this.s.positionen.filter((p) => p.notiz).map((p) => `${p.konto} ${p.name}: ${p.notiz}`);
    if (notizen.length) zeilen.push('Anmerkungen zu einzelnen Konten: ' + notizen.join('; ') + '.');
    if (this.s.plan.begruendung) zeilen.push(`Begründung des Nachtrags: ${this.s.plan.begruendung}`);
    if (this.s.plan.notiz) zeilen.push(this.s.plan.notiz);
    if (!zeilen.length) return;
    this.platz(20);
    this.txt(LEFT, 'ERLÄUTERUNGEN', { bold: true, color: C.orangeDk });
    this.y += 5;
    for (const z of zeilen) {
      for (const t of umbruch(this.p, z, 8, 172)) { this.platz(4.5); this.txt(LEFT, t); this.y += 4.2; }
      this.y += 2;
    }
  }
}

export async function haushaltPdf(db: Db, v: Verein, planId: number): Promise<{ pdf: Buffer; titel: string; sicht: PlanSicht }> {
  const sicht = await planLesen(db, planId);
  const titel = haushaltTitel(sicht);
  const d = new Haushaltsdruck(v, sicht, titel);
  d.teilBeginnen(titel);
  d.plan();
  return { pdf: await d.render(), titel, sicht };
}

/** Ablage in Paperless wie beim Jahresabschluss: gleicher Titel → neue Version, sonst neues Dokument (Kontext „Haushaltsplan“) */
export async function haushaltAblegen(v: Verein, s: PlanSicht, titel: string, pdf: Buffer, benutzer: string) {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Schnittstellen).');
  const pl = paperless(v);
  let id = Number((await pl.dokumenteSuchen({ title__iexact: titel }).catch(() => []))[0]?.id) || null;
  const neu = !id;
  if (id) await pl.warteAufDokument(await pl.uploadVersion(id, pdf, `${titel}.pdf`, `Neudruck ${dat(heute())}`), 15).catch(() => null);
  const werte = { titel, jahr: s.plan.jahr, fassung: s.plan.fassung, status: s.plan.status_text, ergebnis: s.summen.ergebnis, verein: v.name, heute: heute(), benutzer };
  const warnungen: string[] = [];
  if (!id) {
    const r = await kontextAblegen(pl, K.haushalt, 'tco', werte, pdf, `${titel}.pdf`, { benutzer });
    if (!r.id) throw new BusinessError('Hochgeladen, die DOKID ist aber noch nicht verfügbar – bitte in einer Minute erneut ablegen.');
    id = r.id;
    warnungen.push(...r.warnungen);
  }
  warnungen.push(...(await kontextAktualisieren(pl, K.haushalt, 'tco', id, werte, { ohneNotiz: true })).warnungen);
  await pl.notizAnlegen(id, `${titel}, Ergebnis ${betragText(s.summen.ergebnis)} – Portal ${benutzer}, ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`).catch(() => undefined);
  return { id, text: `${neu ? '„' + titel + '“ in Paperless abgelegt' : 'Neue Version nach Paperless übertragen'} (DOKID ${String(id).padStart(6, '0')}).`, warnungen };
}
