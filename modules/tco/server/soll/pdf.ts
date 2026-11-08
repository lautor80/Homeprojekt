import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { logoWeiss, paperless, type Verein } from '../verein.js';
import { dat, heute, runden } from '../format.js';
import { betragText, C, kuerzen, LEFT, RIGHT } from '../pdf/layout.js';
import { BEITRAGSART_TEXT, STATUS } from './logik.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';

/** Protokoll eines Lastschriftlaufs (Port von ZCL_TCO_SOLL_PDF) */

interface Kopf { laufid: string; sollper: string; faellig: string | null; status: string; anz_tx: number; ernam: string | null; erdat: string | null; erzeit: string | null; mit_mb: boolean; mit_jt: boolean; zahl_datum: string | null }
interface Pos { mitglied_name: string; mitglnr: string; artname: string; beitragsart: string; zahler_name: string; iban: string; betrag: number; internenr: string | null }

export const ibanMaske = (iban: string | null) => (iban && iban.length > 6 ? `${iban.slice(0, 2)}•• •••• ${iban.slice(-4)}` : iban ?? '');
export const sollTitel = (k: Pick<Kopf, 'sollper' | 'laufid'>) => `${k.sollper.slice(0, 4)}_${k.sollper.slice(4, 6)}_TCO_SOLLSTELLUNG_LAUF${Number(k.laufid)}`;
const monat = (sollper: string) => `${sollper.slice(4, 6)}/${sollper.slice(0, 4)}`;

export async function sollPdf(v: Verein, k: Kopf, pos: Pos[]): Promise<Buffer> {
  const p = new Pdf({ title: sollTitel(k), author: v.name, creator: 'TCO Vereinsportal' });
  p.newPage();
  const grau = { size: 7, color: C.grau };
  const fett = { size: 9.5, bold: true, color: C.ink };
  const normal = { size: 8.5, color: C.ink };

  // Kopfband
  p.rect(0, 0, 210, 46, { fill: C.orange });
  p.text(LEFT, 31, 'SOLLSTELLUNG', { size: 24, color: 'FFFFFF' });
  p.text(LEFT, 38.5, `Lauf ${Number(k.laufid)} · Sollmonat ${monat(k.sollper)}`, { size: 10, color: 'FFFFFF' });
  p.image(logoWeiss(v), 137, 5.6, 57, 34.7);

  const summe = runden(pos.reduce((s, x) => s + x.betrag, 0));
  const kopf: [string, string][] = [
    ['LAUF', String(Number(k.laufid))], ['SOLLMONAT', monat(k.sollper)], ['FÄLLIG / EINZUG', dat(k.faellig)],
    ['STATUS', STATUS[k.status]?.text ?? k.status],
  ];
  kopf.forEach(([l, w], i) => { p.text(LEFT + i * 44, 58, l, grau); p.text(LEFT + i * 44, 63, w, fett); });
  p.text(LEFT, 70, 'ERSTELLT', grau);
  p.text(LEFT, 75, `${dat(k.erdat)} ${k.erzeit?.slice(0, 5) ?? ''}${k.ernam ? ` · ${k.ernam}` : ''}`, normal);
  p.text(LEFT + 88, 70, 'BEITRAGSARTEN', grau);
  p.text(LEFT + 88, 75, [k.mit_mb && 'Mitgliedsbeiträge und Spenden', k.mit_jt && 'Jugendtraining'].filter(Boolean).join(', ') || '–', normal);

  // Übersicht
  let y = 86;
  p.rect(LEFT, y, 174, 18, { fill: C.orangeSoft, radius: 3 });
  [['BUCHUNGEN', String(pos.length)], ['LASTSCHRIFTEN', String(k.anz_tx ?? 0)], ['SUMME', betragText(summe)]].forEach(([l, w], i) => {
    p.text(LEFT + 6 + i * 58, y + 7, l, { size: 7, bold: true, color: C.orangeDk });
    p.text(LEFT + 6 + i * 58, y + 13.5, w, { size: 12, bold: true, color: C.ink });
  });
  y += 27;

  // Aufteilung nach Vertragsart
  p.text(LEFT, y, 'AUFTEILUNG NACH VERTRAGSART', { size: 8, bold: true, color: C.orangeDk });
  y += 6;
  for (const ba of ['MB', 'JT', 'SP']) {
    const g = pos.filter((x) => x.beitragsart === ba);
    if (!g.length) continue;
    const arten = new Map<string, { n: number; s: number }>();
    for (const x of g) {
      const a = arten.get(x.artname) ?? { n: 0, s: 0 };
      a.n++; a.s = runden(a.s + x.betrag);
      arten.set(x.artname, a);
    }
    p.text(LEFT, y, ba === 'MB' ? 'Mitgliedschaft' : BEITRAGSART_TEXT[ba], { size: 8.5, bold: true, color: C.ink });
    p.text(RIGHT - 30, y, `${g.length}`, { ...normal, align: 'R' });
    p.text(RIGHT, y, betragText(runden(g.reduce((s, x) => s + x.betrag, 0))), { size: 8.5, bold: true, color: C.ink, align: 'R' });
    y += 4.8;
    for (const [a, w] of [...arten].sort((x, z) => x[0].localeCompare(z[0], 'de'))) {
      p.text(LEFT + 5, y, kuerzen(p, a || '–', 8, 110), { size: 8, color: C.grau });
      p.text(RIGHT - 30, y, String(w.n), { size: 8, color: C.grau, align: 'R' });
      p.text(RIGHT, y, betragText(w.s), { size: 8, color: C.grau, align: 'R' });
      y += 4.3;
    }
    y += 1.5;
  }
  p.line(LEFT, y, RIGHT, y, C.linie, 0.3);
  y += 5;
  p.text(LEFT, y, 'Gesamt', { size: 9, bold: true, color: C.ink });
  p.text(RIGHT - 30, y, String(pos.length), { size: 9, bold: true, color: C.ink, align: 'R' });
  p.text(RIGHT, y, betragText(summe), { size: 9, bold: true, color: C.ink, align: 'R' });
  y += 11;

  // Buchungen im Einzelnen
  const kopfzeile = () => {
    p.text(LEFT, y, 'BUCHUNGEN IM EINZELNEN', { size: 8, bold: true, color: C.orangeDk });
    y += 6;
    const sp: [number, string, 'L' | 'R'][] = [[LEFT, 'MITGLIED', 'L'], [LEFT + 50, 'NR.', 'L'], [LEFT + 62, 'VERTRAGSART', 'L'], [LEFT + 102, 'ZAHLER', 'L'], [LEFT + 142, 'IBAN', 'L'], [RIGHT, 'BETRAG', 'R']];
    for (const [x, t, a] of sp) p.text(x, y, t, { ...grau, align: a });
    y += 2;
    p.line(LEFT, y, RIGHT, y, C.linie, 0.3);
    y += 4.5;
  };
  kopfzeile();
  const sortiert = [...pos].sort((a, b) => a.zahler_name.localeCompare(b.zahler_name, 'de') || a.mitglied_name.localeCompare(b.mitglied_name, 'de'));
  for (const x of sortiert) {
    if (y > 268) { p.newPage(); y = 18; kopfzeile(); }
    p.text(LEFT, y, kuerzen(p, x.mitglied_name, 8, 48), { size: 8, color: C.ink });
    p.text(LEFT + 50, y, x.mitglnr || '', { size: 8, color: C.ink });
    p.text(LEFT + 62, y, kuerzen(p, x.artname, 8, 38), { size: 8, color: C.ink });
    p.text(LEFT + 102, y, kuerzen(p, x.zahler_name, 8, 38), { size: 8, color: C.ink });
    p.text(LEFT + 142, y, ibanMaske(x.iban), { size: 8, color: C.ink });
    p.text(RIGHT, y, betragText(x.betrag), { size: 8, color: C.ink, align: 'R' });
    y += 4.6;
  }
  y += 4;
  if (y > 270) { p.newPage(); y = 18; }
  p.text(LEFT, y, 'Datenschutz: IBAN nur verkürzt. Vollständige Bankverbindungen stehen in der Lastschriftdatei bzw. im Mitgliederstamm.', { size: 7, color: C.grau });

  // Fußzeilen ohne Vereins-IBAN
  const n = p.pageCount();
  for (let i = 0; i < n; i++) {
    p.setPage(i);
    p.rect(0, 282, 210, 15, { fill: C.fuss });
    p.rect(0, 281.2, 210, 1, { fill: C.orange });
    p.text(LEFT, 290.5, `${v.name} · Interner Beleg Sollstellung`, { size: 7, color: C.grau });
    p.text(RIGHT, 290.5, `${sollTitel(k)} · Seite ${i + 1} von ${n}`, { size: 7, color: C.grau, align: 'R' });
  }
  return p.render();
}

/** Protokoll nach Paperless (erste Ablage oder neue Version), Metadaten und Notiz */
export async function sollAblegen(v: Verein, k: Kopf & { pl_doc_id: number | null; summe: number }, pdf: Buffer, benutzer: string) {
  const pl = paperless(v);
  const titel = sollTitel(k);
  const datei = `${titel}.pdf`;
  let id = k.pl_doc_id;
  let text = `Neue Version nach Paperless übertragen (DOKID ${id}).`;
  if (id) {
    const task = await pl.uploadVersion(id, pdf, datei, `Neudruck ${dat(heute())}`);
    await pl.warteAufDokument(task, 15).catch(() => null);
  }
  const werte = { titel, laufid: Number(k.laufid), periode: k.sollper, summe: k.summe, anzahl: k.anz_tx, verein: v.name, heute: heute(), benutzer };
  const warnungen: string[] = [];
  if (!id) {
    const r = await kontextAblegen(pl, K.sollLauf, 'tco', werte, pdf, datei, { benutzer });
    if (!r.id) return { id: null, text: 'Hochgeladen, DOKID noch nicht verfügbar – bitte später erneut übertragen.', warnungen: [] as string[] };
    id = r.id;
    warnungen.push(...r.warnungen);
    text = `Sollstellung nach Paperless übertragen (DOKID ${id}).`;
  }
  // Felder laut zentraler Paperless-Zuordnung (Kontext „Sollstellung“)
  warnungen.push(...(await kontextAktualisieren(pl, K.sollLauf, 'tco', id, werte, { ohneNotiz: true })).warnungen);
  await pl.notizAnlegen(id, `Sollstellung Lauf ${Number(k.laufid)} ${monat(k.sollper)}: ${k.anz_tx} Lastschriften, ${betragText(k.summe)}, Status ${STATUS[k.status]?.text ?? k.status} – ${benutzer}, ${new Date().toLocaleString('de-DE')}`).catch(() => undefined);
  return { id, text, warnungen };
}
