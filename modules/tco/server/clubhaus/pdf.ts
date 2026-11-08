import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { dat, heute, zahl } from '../format.js';
import { betragText, C, LEFT, RIGHT, alleFusszeilen } from '../pdf/layout.js';
import { logoWeiss, paperless, plAktiv, type Db, type Verein } from '../verein.js';
import { einzahlungenLesen, forderungenLesen, MONATE, type Ford } from './logik.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';

/** Clubhausabrechnung bis einschließlich Monat – Ersatz für die Smartform ZTCO_CLUBHAUSABRECHUNG2 */

export const chTitel = (jahr: number, monat: number) => `Clubhausabrechnung ${jahr}_${String(monat).padStart(2, '0')}`;
const eur = (v: number) => `${zahl(v)} €`;

export async function clubhausPdf(db: Db, v: Verein, jahr: number, monat: number): Promise<{ pdf: Buffer; op: number }> {
  const ford = (await forderungenLesen(db, jahr)).filter((f) => f.monat <= monat);
  const zeilen = ford.filter((f) => f.monat === 0 || (f.monat >= 1 && (f.vkbrutto || f.einzahlungen || f.reinigung || f.offene_posten)));
  if (!ford.some((f) => f.monat >= 1 && f.monat <= monat && (f.vkbrutto || f.einzahlungen || f.reinigung))) {
    throw new BusinessError('Für diesen Zeitraum ist noch nichts berechnet – bitte zuerst „Berechnen“.');
  }
  const op = ford.filter((f) => f.monat <= monat).at(-1)?.offene_posten ?? 0;
  const ein = await einzahlungenLesen(db, v, jahr, monat);

  const p = new Pdf({ title: chTitel(jahr, monat), author: v.name, creator: 'TCO Vereinsportal' });
  p.newPage();
  p.rect(0, 0, 210, 46, { fill: C.orange });
  p.text(LEFT, 31, 'CLUBHAUSABRECHNUNG', { size: 24, color: 'FFFFFF' });
  p.text(LEFT, 38.5, `${jahr} · Stand ${dat(heute())} · bis ${MONATE[monat - 1]}`, { size: 10, color: 'FFFFFF' });
  p.image(logoWeiss(v), 137, 5.6, 57, 34.7);

  let y = 60;
  p.text(LEFT, y, 'MONATSÜBERSICHT', { size: 8, bold: true, color: C.orangeDk });
  y += 7;
  const sp: [number, string][] = [[LEFT, 'Monat'], [LEFT + 62, 'VK Getränke'], [LEFT + 89, 'abzgl. Reinigung'], [LEFT + 118, 'Provision'], [LEFT + 146, 'Einzahlung'], [RIGHT, 'Offen']];
  sp.forEach(([x, t], i) => p.text(x, y, t, { size: 7.5, bold: true, color: C.grau, align: i ? 'R' : 'L' }));
  y += 2;
  p.line(LEFT, y, RIGHT, y, C.linie, 0.3);
  y += 5;
  const mname = (f: Ford) => (f.monat === 0 ? `Übertrag 31.12.${jahr - 1}` : MONATE[f.monat - 1]);
  let summeEin = 0;
  for (const f of zeilen) {
    const t = { size: 8.5, color: C.ink };
    p.text(LEFT, y, mname(f), t);
    if (f.monat > 0) {
      p.text(LEFT + 62, y, eur(f.vkbrutto), { ...t, align: 'R' });
      p.text(LEFT + 89, y, eur(f.reinigung), { ...t, align: 'R' });
      p.text(LEFT + 118, y, eur(f.provision), { ...t, align: 'R' });
      p.text(LEFT + 146, y, eur(f.einzahlungen), { ...t, align: 'R' });
      summeEin += f.einzahlungen;
    }
    p.text(RIGHT, y, eur(f.offene_posten), { size: 8.5, bold: true, color: C.ink, align: 'R' });
    p.line(LEFT, y + 1.8, RIGHT, y + 1.8, C.linie, 0.15);
    y += 6;
  }
  p.text(LEFT, y, 'Summe Einzahlungen', { size: 8.5, bold: true, color: C.ink });
  p.text(LEFT + 146, y, eur(summeEin), { size: 8.5, bold: true, color: C.ink, align: 'R' });
  y += 10;

  // Kontostand
  p.rect(LEFT, y, 174, 14, { fill: C.orangeSoft, radius: 3 });
  const zugunsten = op >= 0 ? `zugunsten des ${v.name.replace(/ e\.V\.$/, '')}` : `zugunsten ${v.ch_wirt}`;
  p.text(LEFT + 5, y + 8.7, `Der Kontostand zum ${dat(heute())} beträgt ${eur(Math.abs(op))} ${zugunsten}.`, { size: 9.5, bold: true, color: C.ink });
  y += 26;

  // Unterschriften
  p.text(LEFT, y, `${(v.plz_ort ?? '').replace(/^\d+\s*/, '') || 'Ort'}, ${dat(heute())}`, { size: 9, color: C.ink });
  y += 10;
  for (const [x, t] of [[LEFT, 'Ort und Datum'], [LEFT + 62, `Unterschrift ${v.name.replace(/ e\.V\.$/, '').replace(/^Tennisclub /, 'TC ')}`], [LEFT + 124, `Unterschrift ${v.ch_wirt}`]] as [number, string][]) {
    p.line(x, y, x + 50, y, '999999', 0.25);
    p.text(x, y + 4, t, { size: 7.5, color: C.grau });
  }
  y += 14;

  // Einzahlungsübersicht (bar / Überweisung)
  const block = (titel: string, l: typeof ein) => {
    if (!l.length) return;
    if (y > 250) { p.newPage(); y = 20; }
    p.text(LEFT, y, titel, { size: 8, bold: true, color: C.orangeDk });
    y += 6;
    p.text(LEFT, y, 'Datum', { size: 7.5, bold: true, color: C.grau });
    p.text(LEFT + 25, y, 'Buchungstext', { size: 7.5, bold: true, color: C.grau });
    p.text(RIGHT, y, 'Betrag', { size: 7.5, bold: true, color: C.grau, align: 'R' });
    y += 2;
    p.line(LEFT, y, RIGHT, y, C.linie, 0.3);
    y += 4.5;
    let s = 0;
    for (const e of l) {
      if (y > 270) { p.newPage(); y = 20; }
      p.text(LEFT, y, dat(e.datum), { size: 8, color: C.ink });
      p.text(LEFT + 25, y, (e.text ?? '').slice(0, 85), { size: 8, color: C.ink });
      p.text(RIGHT, y, eur(e.betrag), { size: 8, color: C.ink, align: 'R' });
      s += e.betrag;
      y += 4.8;
    }
    p.line(LEFT + 120, y - 2.5, RIGHT, y - 2.5, C.linie, 0.3);
    p.text(RIGHT, y + 1.5, eur(s), { size: 8.5, bold: true, color: C.ink, align: 'R' });
    y += 9;
  };
  p.text(LEFT, y, 'EINZAHLUNGSÜBERSICHT', { size: 8, bold: true, color: C.orangeDk });
  y += 7;
  block('Bar (Kasse)', ein.filter((e) => e.bar));
  block('Überweisung', ein.filter((e) => !e.bar));
  if (!ein.length) p.text(LEFT, y, 'Keine Einzahlungen im Zeitraum.', { size: 8.5, color: C.grau });

  alleFusszeilen(p, v);
  return { pdf: await p.render(), op };
}

export async function clubhausAblegen(db: Db, v: Verein, jahr: number, monat: number, pdf: Buffer, op: number, benutzer: string,
  schreiben: (fn: (tx: Db) => Promise<void>) => Promise<void>) {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Stammdaten → Anbindungen).');
  const pl = paperless(v);
  const titel = chTitel(jahr, monat);
  const [r] = await db`select rechnung from tco.forderungen where jahr = ${jahr} and monat = ${monat}`;
  let id = r?.rechnung && /^\d+$/.test(r.rechnung) ? Number(r.rechnung) : null;
  if (!id) id = Number((await pl.dokumenteSuchen({ title__iexact: titel }).catch(() => []))[0]?.id) || null;
  const neu = !id;
  if (id) await pl.warteAufDokument(await pl.uploadVersion(id, pdf, `${titel}.pdf`, `Neudruck ${dat(heute())}`), 15).catch(() => null);
  const werte = { titel, jahr, monat, kontostand: op, wirt: v.ch_wirt, verein: v.name, heute: heute(), benutzer };
  const warnungen: string[] = [];
  if (!id) {
    const r = await kontextAblegen(pl, K.clubhaus, 'tco', werte, pdf, `${titel}.pdf`, { benutzer });
    if (!r.id) throw new BusinessError('Hochgeladen, die DOKID ist aber noch nicht verfügbar – bitte in einer Minute erneut ablegen.');
    id = r.id;
    warnungen.push(...r.warnungen);
  }
  const docId = id;
  await schreiben(async (tx) => { await tx`update tco.forderungen set rechnung = ${String(docId)} where jahr = ${jahr} and monat = ${monat}`; });
  // Felder laut zentraler Paperless-Zuordnung (Kontext „Clubhausabrechnung“)
  warnungen.push(...(await kontextAktualisieren(pl, K.clubhaus, 'tco', docId, werte, { ohneNotiz: true })).warnungen);
  await pl.notizAnlegen(docId, `Clubhausabrechnung bis ${MONATE[monat - 1]} ${jahr}, Kontostand ${betragText(op)} – Portal ${benutzer}, ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`).catch(() => undefined);
  return { id: docId, text: `${neu ? 'In Paperless abgelegt' : 'Neue Version nach Paperless übertragen'} (DOKID ${String(docId).padStart(6, '0')}).`, warnungen };
}
