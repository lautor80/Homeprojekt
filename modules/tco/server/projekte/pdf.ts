import { BusinessError } from '../../../../server/src/errors.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { dat, heute, zahl } from '../format.js';
import { betragText, C, LEFT, RIGHT, umbruch } from '../pdf/layout.js';
import { K } from '../paperless-kontexte.js';
import { paperless, plAktiv, type Db, type Verein } from '../verein.js';
import { Abschlussdruck } from '../abschluss/pdf.js';
import { projektSicht, type ProjektSicht } from './logik.js';
import { tagNr } from './planung.js';

/**
 * Projektantrag als PDF – im Layout der übrigen Vereinsdrucke (Kopfband, Karten, Folgekopf, Fußzeile; Bausteine aus
 * abschluss/pdf.ts): Beschreibung, Kosten und Finanzierung, Terminplan mit Balkendiagramm, Arbeitseinsatz der
 * Mitglieder mit dem Wert zum externen Verrechnungssatz, Material, Verlauf der Genehmigung und Unterschriften.
 */

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const monat = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const ROT = 'B3261E';

export const antragTitel = (s: ProjektSicht) => `Projektantrag ${s.projekt.bezeichnung}`;

class Antragsdruck extends Abschlussdruck {
  constructor(v: Verein, readonly s: ProjektSicht, titel: string) { super(v, Number(s.projekt.beginn.slice(0, 4)), titel); }

  absatz(text: string, size = 8, color = C.ink) {
    for (const a of text.split(/\r?\n/)) for (const z of umbruch(this.p, a, size, 172)) { this.platz(4.5); this.txt(LEFT, z, { size, color }); this.y += size * 0.52; }
  }

  kopf() {
    const { projekt: p, planung: pl } = this.s;
    this.kopfband('PROJEKTANTRAG', this.kurz(p.bezeichnung, 112, 10));
    this.kennzahl(LEFT, 'ZEITRAUM', `${monat(p.beginn)} – ${monat(p.ende)}`);
    this.kennzahl(62, 'KOSTEN', betragText(p.budget.kosten));
    this.kennzahl(96, 'FINANZIERUNG', betragText(p.budget.finanzierung), p.budget.luecke > 0 ? ROT : C.ink);
    this.kennzahl(132, 'EIGENLEISTUNG', pl.summen.stunden ? `${zahl(pl.summen.stunden, 0)} Std.` : '–');
    this.kennzahl(164, 'STATUS', this.kurz(p.status_text, 28, 9.5));
    const zeile = [p.verantwortlich ? `Verantwortlich: ${p.verantwortlich}` : '', p.projektnr ? `Projektnummer: ${p.projektnr}` : '', p.bereich ? `Tätigkeitsbereich ${p.bereich}` : ''].filter(Boolean).join(' · ');
    if (zeile) { this.txt(LEFT, zeile, { color: C.grau }); this.y += 5.5; }
    if (p.beschreibung) { this.absatz(p.beschreibung); this.y += 4; }
  }

  kosten() {
    const p = this.s.projekt;
    this.karteBeginnen('Kosten und Finanzierung', [{ x: 22, text: 'Art', align: 'L' }, { x: 62, text: 'Bezeichnung', align: 'L' }, { x: 148, text: 'Zeitraum', align: 'L' }, { x: 188, text: 'Betrag', align: 'R' }]);
    if (!p.positionen.length) { this.txt(22, 'Noch keine Positionen geplant.', { color: C.grau }); this.zeileLinie(); }
    for (const x of p.positionen) {
      this.zeilePlatz();
      this.txt(22, this.kurz(x.art_text, 38));
      this.txt(62, this.kurz(x.bezeichnung ?? '', 84));
      this.txt(148, x.verteilung === 'JAEHRLICH' ? 'je Jahr' : x.von ? `${monat(x.von)}${x.bis && x.bis !== x.von ? ` – ${monat(x.bis)}` : ''}` : 'Laufzeit', { size: 7, color: C.grau });
      this.txt(188, zahl(x.betrag), { align: 'R' });
      this.zeileLinie();
    }
    const summe = (text: string, wert: number, color = C.ink) => { this.zeilePlatz(); this.txt(22, text, { bold: true }); this.txt(188, zahl(wert), { bold: true, align: 'R', color }); this.zeileLinie(); };
    summe('Kosten', p.budget.kosten);
    summe('Finanzierung', p.budget.finanzierung);
    if (p.budget.luecke > 0) summe('Noch nicht finanziert', p.budget.luecke, ROT);
    this.karteBeenden(p.budget.folge_jahr ? `Nach Abschluss ${p.budget.folge_jahr > 0 ? 'Folgekosten' : 'Einsparung'} von ${betragText(Math.abs(p.budget.folge_jahr))} je Jahr.` : undefined);
  }

  termine() {
    const { vorgaenge, termin } = this.s.planung;
    if (!vorgaenge.length) return;
    this.karteBeginnen('Terminplan', [{ x: 22, text: 'Nr.', align: 'L' }, { x: 30, text: 'Vorgang', align: 'L' }, { x: 104, text: 'Beginn', align: 'L' }, { x: 124, text: 'Ende', align: 'L' },
      { x: 150, text: 'Tage', align: 'R' }, { x: 154, text: 'nach', align: 'L' }, { x: 168, text: 'Verantwortlich', align: 'L' }]);
    for (const v of vorgaenge) {
      this.zeilePlatz();
      this.txt(22, String(v.nr), { color: C.grau });
      this.txt(30, this.kurz(v.bezeichnung, 72), { bold: v.kritisch });
      this.txt(104, dat(v.beginn));
      this.txt(124, v.dauer ? dat(v.ende) : 'Meilenstein', v.dauer ? {} : { color: C.grau, size: 7 });
      this.txt(150, v.dauer ? String(v.dauer) : '', { align: 'R' });
      this.txt(154, this.kurz(v.vorgaenger.map((x) => `${x.nr}${x.abstand ? `${x.abstand > 0 ? '+' : ''}${x.abstand}` : ''}`).join(', '), 12, 7), { size: 7, color: C.grau });
      this.txt(168, this.kurz(v.verantwortlich ?? '', 21, 7), { size: 7 });
      this.zeileLinie();
    }
    this.karteBeenden(`Gesamtdauer ${dat(termin.beginn)} – ${dat(termin.ende)} (${termin.tage} Tage). Fett: Vorgänge auf dem kritischen Weg – verschieben sie sich, verschiebt sich das Projektende.`);

    // Balkendiagramm: je Vorgang eine Zeile, Zeitachse über die Gesamtdauer
    const x0 = 72, breite = RIGHT - x0 - 2, t0 = tagNr(termin.beginn), spanne = Math.max(1, termin.tage);
    const zeile = 4.6;
    this.platz(18 + Math.min(vorgaenge.length, 12) * zeile);
    this.txt(LEFT, 'Balkenplan', { bold: true, color: C.orangeDk });
    this.y += 5;
    const achse = () => {
      this.txt(x0, dat(termin.beginn), { size: 6.5, color: C.grau });
      this.txt(x0 + breite, dat(termin.ende), { size: 6.5, color: C.grau, align: 'R' });
      this.y += 2.2;
      this.p.line(x0, this.y, x0 + breite, this.y, C.rand, 0.3);
      this.y += 3.6;
    };
    achse();
    for (const v of vorgaenge) {
      if (this.y + zeile > 268) { this.p.newPage(); this.y = 24; achse(); }
      const x = x0 + ((tagNr(v.beginn) - t0) / spanne) * breite;
      const w = Math.max(0.8, (v.dauer / spanne) * breite);
      this.txt(LEFT, this.kurz(`${v.nr}. ${v.bezeichnung}`, 50, 7), { size: 7 });
      if (v.dauer) {
        this.p.rect(x, this.y - 2.6, w, 2.8, { fill: v.kritisch ? C.orange : C.rand, radius: 0.6 });
        if (v.fertig > 0) this.p.rect(x, this.y - 2.6, (w * v.fertig) / 100, 2.8, { fill: v.kritisch ? C.orangeDk : C.grau, radius: 0.6 });
      } else this.p.circle(x, this.y - 1.2, 1.3, C.ink);
      this.y += zeile;
    }
    this.y += 3;
    this.txt(LEFT, 'Orange: kritischer Weg · dunkel: erledigter Anteil · Punkt: Meilenstein', { size: 6.5, color: C.grau });
    this.y += 9;
  }

  arbeit() {
    const { arbeit, summen, stundensatz } = this.s.planung;
    if (!arbeit.length) return;
    this.karteBeginnen('Arbeitseinsatz der Mitglieder', [{ x: 22, text: 'Wer', align: 'L' }, { x: 72, text: 'Tätigkeit', align: 'L' }, { x: 132, text: 'Pers.', align: 'R' },
      { x: 148, text: 'Std. je Pers.', align: 'R' }, { x: 166, text: 'Satz €/Std.', align: 'R' }, { x: 188, text: 'Wert', align: 'R' }]);
    for (const a of arbeit) {
      this.zeilePlatz();
      this.txt(22, this.kurz(a.name, 48));
      this.txt(72, this.kurz(a.taetigkeit ?? '', 50), { size: 7.5 });
      this.txt(132, String(a.personen), { align: 'R' });
      this.txt(148, zahl(a.stunden, a.stunden % 1 ? 1 : 0), { align: 'R' });
      this.txt(166, zahl(a.satz_gilt), { align: 'R' });
      this.txt(188, zahl(a.wert), { align: 'R' });
      this.zeileLinie();
    }
    this.zeilePlatz();
    this.txt(22, `Summe: ${zahl(summen.stunden, summen.stunden % 1 ? 1 : 0)} Stunden von ${summen.personen} Person${summen.personen === 1 ? '' : 'en'}`, { bold: true });
    this.txt(188, zahl(summen.eigenleistung), { bold: true, align: 'R' });
    this.zeileLinie();
    this.karteBeenden(`Wert der Eigenleistung zum externen Verrechnungssatz (Vorgabe ${betragText(stundensatz)} je Stunde): Das kostete die Arbeit, wenn eine Firma sie ausführte. Die Eigenleistung ist kein Geldabfluss und nicht in den Kosten enthalten.`);
  }

  material() {
    const { material, summen } = this.s.planung;
    if (!material.length) return;
    this.karteBeginnen('Material und Einkauf', [{ x: 22, text: 'Bezeichnung', align: 'L' }, { x: 92, text: 'Lieferant', align: 'L' }, { x: 138, text: 'Menge', align: 'R' }, { x: 141, text: 'Einheit', align: 'L' },
      { x: 168, text: 'Einzelpreis', align: 'R' }, { x: 188, text: 'Summe', align: 'R' }]);
    for (const m of material) {
      this.zeilePlatz();
      this.txt(22, this.kurz(m.bezeichnung, 68));
      this.txt(92, this.kurz(m.lieferant ?? '', 32, 7.5), { size: 7.5 });
      this.txt(138, zahl(m.menge, m.menge % 1 ? 2 : 0), { align: 'R' });
      this.txt(141, this.kurz(m.einheit ?? '', 12, 7.5), { size: 7.5 });
      this.txt(168, zahl(m.preis), { align: 'R' });
      this.txt(188, zahl(m.summe), { align: 'R' });
      this.zeileLinie();
    }
    this.zeilePlatz();
    this.txt(22, 'Summe Material', { bold: true });
    this.txt(188, zahl(summen.material), { bold: true, align: 'R' });
    this.zeileLinie();
    const k = this.s.projekt.budget.kosten;
    this.karteBeenden(k ? `Zum Vergleich: In der Kostenplanung stehen ${betragText(k)} Kosten${summen.material > k ? ' – das Material allein liegt darüber.' : '.'}` : undefined);
  }

  abschluss() {
    const p = this.s.projekt;
    if (p.verlauf.length) {
      this.platz(12 + p.verlauf.length * 4.4);
      this.txt(LEFT, 'Verlauf der Genehmigung', { bold: true, color: C.orangeDk });
      this.y += 5;
      for (const v of p.verlauf) { this.absatz(`${dat(v.am)} · ${v.von}: ${v.status_text}${v.grund ? ` – „${v.grund}“` : ''}`, 7.5); }
      this.y += 6;
    }
    this.platz(34);
    this.y += 16;
    for (const [x, text] of [[LEFT, 'Datum, Antragsteller'], [108, 'Datum, Vorstand']] as [number, string][]) {
      this.p.line(x, this.y, x + 78, this.y, C.grau, 0.3);
      this.p.text(x, this.y + 4, text, { size: 7, color: C.grau });
    }
    this.y += 10;
    this.txt(LEFT, `Stand ${dat(heute())}`, { size: 7, color: C.grau });
  }
}

export async function antragPdf(db: Db, v: Verein, id: number): Promise<{ pdf: Buffer; titel: string; sicht: ProjektSicht }> {
  const sicht = await projektSicht(db, id);
  const titel = antragTitel(sicht);
  const d = new Antragsdruck(v, sicht, titel);
  d.teilBeginnen(titel);
  d.kopf();
  d.kosten();
  d.termine();
  d.arbeit();
  d.material();
  d.abschluss();
  return { pdf: await d.render(), titel, sicht };
}

/** Ablage in Paperless wie beim Haushaltsplan: gleicher Titel → neue Version, sonst neues Dokument (Kontext „Projektantrag“) */
export async function antragAblegen(tx: Db, v: Verein, s: ProjektSicht, titel: string, pdf: Buffer, benutzer: string) {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Schnittstellen).');
  const pl = paperless(v);
  let id = s.planung.paperless?.id ?? (Number((await pl.dokumenteSuchen({ title__iexact: titel }).catch(() => []))[0]?.id) || null);
  const neu = !id;
  if (id) await pl.warteAufDokument(await pl.uploadVersion(id, pdf, `${titel}.pdf`, `Neudruck ${dat(heute())}`), 15).catch(() => null);
  const p = s.projekt;
  const werte = { titel, projekt: p.bezeichnung, projektnr: p.projektnr ?? '', status: p.status_text, kosten: p.budget.kosten, verein: v.name, heute: heute(), benutzer };
  const warnungen: string[] = [];
  if (!id) {
    const r = await kontextAblegen(pl, K.projekt, 'tco', werte, pdf, `${titel}.pdf`, { benutzer });
    if (!r.id) throw new BusinessError('Hochgeladen, die DOKID ist aber noch nicht verfügbar – bitte in einer Minute erneut ablegen.');
    id = r.id;
    warnungen.push(...r.warnungen);
  }
  warnungen.push(...(await kontextAktualisieren(pl, K.projekt, 'tco', id, werte, { ohneNotiz: true })).warnungen);
  await pl.notizAnlegen(id, `${titel}, Kosten ${betragText(p.budget.kosten)}, ${p.status_text} – Portal ${benutzer}, ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`).catch(() => undefined);
  await tx`update tco.hh_projekt set antrag_paperless_id = ${id}, antrag_paperless_am = now() where id = ${p.id}`;
  return { id, text: `${neu ? '„' + titel + '“ in Paperless abgelegt' : 'Neue Version nach Paperless übertragen'} (DOKID ${String(id).padStart(6, '0')}).`, warnungen };
}
