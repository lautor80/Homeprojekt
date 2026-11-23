/**
 * Spielbericht als PDF (A4 quer) im Aufbau des DTB-Spielberichts: Kopf mit Wettbewerb, Heim/Gast, Datum und OSR,
 * Einzel und Doppel mit Melde-Pos., ID-Nr., Sätzen, Spielen, Sätzen und Match-Punkten, Summen, Sieger, Zuschauer,
 * Beginn/Ende, Bemerkungen und – statt der Unterschriften – die Freigaben mit Name und Zeitpunkt.
 */
import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { dat } from '../format.js';
import { C, kuerzen } from '../pdf/layout.js';
import type { Verein } from '../verein.js';
import { berichtWerten, type MatchErgebnis, type SbMatch, type SbSpieler } from './spielbericht-logik.js';
import type { berichtLesen } from './spielbericht.js';

type Bericht = Awaited<ReturnType<typeof berichtLesen>>;
const L = 12, R = 285;
const zeitpunkt = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }) : '');

export const berichtTitel = (b: Bericht) => `Spielbericht ${dat(b.spieltag.datum)} ${b.spieltag.heim} - ${b.spieltag.gast}`;

export async function berichtPdf(b: Bericht, v: Verein): Promise<Buffer> {
  const d = b.daten;
  const w = berichtWerten(d, { a: b.heim.nr, b: b.gast.nr });
  const p = new Pdf({ title: berichtTitel(b), author: v.name, creator: 'TCO Vereinsportal' });
  p.newPage(true);

  // Kopf
  p.rect(0, 0, 297, 24, { fill: C.orange });
  p.text(L, 11, 'SPIELBERICHT', { size: 18, bold: true, color: 'FFFFFF' });
  p.text(L, 18.5, `${b.spieltag.liga} · Saison ${b.spieltag.saison}`, { size: 9.5, color: 'FFFFFF' });
  p.text(R, 11, `${dat(b.spieltag.datum)}${b.spieltag.uhrzeit ? `, ${b.spieltag.uhrzeit} Uhr` : ''}`, { size: 11, bold: true, color: 'FFFFFF', align: 'R' });
  p.text(R, 18.5, [b.spieltag.nr ? `Spiel-Nr. ${b.spieltag.nr}` : '', [b.spieltag.halle, b.spieltag.platz].filter(Boolean).join(', ')].filter(Boolean).join(' · '), { size: 9, color: 'FFFFFF', align: 'R' });
  if (b.status !== 'eingereicht') p.text(148.5, 18.5, 'ENTWURF – NICHT EINGEREICHT', { size: 9, bold: true, color: 'FFFFFF', align: 'C' });

  let y = 33;
  p.text(L, y, 'HEIM (Mannschaft A, Gastgeber)', { size: 7, bold: true, color: C.grau });
  p.text(150, y, 'GAST (Mannschaft B)', { size: 7, bold: true, color: C.grau });
  y += 5.5;
  p.text(L, y, b.heim.team, { size: 12, bold: true, color: C.ink });
  p.text(150, y, b.gast.team, { size: 12, bold: true, color: C.ink });
  p.text(R, y, d.osr ? `OSR: ${d.osr}` : '', { size: 8.5, color: C.grau, align: 'R' });
  y += 8;

  // Spalten: Nr | Heim (Pos, ID, Name) | Gast (Pos, ID, Name) | Satz 1 | Satz 2 | MTB | Spiele | Sätze | Punkte
  const X = { nr: L, hPos: L + 8, hId: L + 17, hName: L + 37, gPos: L + 103, gId: L + 112, gName: L + 132, s1: 210, s2: 222, s3: 234, sp: 250, sa: 263, pu: 276 };
  const kopf = (titel: string) => {
    p.rect(L, y - 4.2, R - L, 6, { fill: C.orangeSoft });
    const t = { size: 7, bold: true, color: C.orangeDk };
    p.text(X.nr, y, titel, t);
    p.text(X.hPos, y, 'Pos.', t); p.text(X.hId, y, 'ID-Nr.', t); p.text(X.hName, y, 'Heim', t);
    p.text(X.gPos, y, 'Pos.', t); p.text(X.gId, y, 'ID-Nr.', t); p.text(X.gName, y, 'Gast', t);
    p.text(X.s1, y, 'Satz 1', { ...t, align: 'C' }); p.text(X.s2, y, 'Satz 2', { ...t, align: 'C' }); p.text(X.s3, y, 'MTB', { ...t, align: 'C' });
    p.text(X.sp, y, 'Spiele', { ...t, align: 'C' }); p.text(X.sa, y, 'Sätze', { ...t, align: 'C' }); p.text(X.pu, y, 'Punkte', { ...t, align: 'C' });
    y += 6;
  };
  const satz = (m: SbMatch, j: number) => {
    if (m.wertung === 'wo') return j === 0 ? 'w.o.' : '';
    const s = m.saetze[j];
    return s && s[0] != null && s[1] != null ? `${s[0]}:${s[1]}` : '';
  };
  const werte = (m: SbMatch, e: MatchErgebnis, yy: number) => {
    const t = { size: 8.5, color: C.ink, align: 'C' as const };
    p.text(X.s1, yy, satz(m, 0), t); p.text(X.s2, yy, satz(m, 1), t); p.text(X.s3, yy, satz(m, 2), t);
    const fertig = e.status === 'fertig';
    p.text(X.sp, yy, fertig ? `${e.spiele[0]}:${e.spiele[1]}` : '', t);
    p.text(X.sa, yy, fertig ? `${e.saetze[0]}:${e.saetze[1]}` : '', t);
    p.text(X.pu, yy, fertig ? (e.sieger === 'a' ? '1:0' : '0:1') : '', { ...t, bold: true });
    if (m.wertung === 'aufgabe') p.text(X.s3 + 6, yy, 'Aufg.', { size: 6.5, color: C.grau });
  };
  const spieler = (s: SbSpieler | null, xPos: number, xId: number, xName: number, breite: number, yy: number) => {
    if (!s) return;
    p.text(xPos, yy, s.rang != null ? String(s.rang) : '', { size: 8.5, color: C.ink });
    p.text(xId, yy, s.id_nr ?? '', { size: 8, color: C.grau });
    p.text(xName, yy, kuerzen(p, s.name, 8.5, breite), { size: 8.5, color: C.ink });
  };
  const summe = (s: { punkte: [number, number]; saetze: [number, number]; spiele: [number, number] }, text: string) => {
    p.text(X.s3 - 6, y, text, { size: 8, bold: true, color: C.ink, align: 'R' });
    const t = { size: 8.5, bold: true, color: C.ink, align: 'C' as const };
    p.text(X.sp, y, `${s.spiele[0]}:${s.spiele[1]}`, t); p.text(X.sa, y, `${s.saetze[0]}:${s.saetze[1]}`, t); p.text(X.pu, y, `${s.punkte[0]}:${s.punkte[1]}`, t);
    y += 8;
  };

  kopf('Einzel');
  d.einzel.forEach((m, i) => {
    p.text(X.nr, y, String(i + 1), { size: 8.5, bold: true, color: C.ink });
    spieler(m.a[0], X.hPos, X.hId, X.hName, 63, y);
    spieler(m.b[0], X.gPos, X.gId, X.gName, 63, y);
    werte(m, w.einzel[i], y);
    p.line(L, y + 2, R, y + 2, C.linie, 0.15);
    y += 6.5;
  });
  summe(w.summeEinzel, 'Einzel');

  kopf('Doppel');
  d.doppel.forEach((m, i) => {
    p.text(X.nr, y, String(i + 1), { size: 8.5, bold: true, color: C.ink });
    for (const [s, xPos, xName] of [['a', X.hPos, X.hName], ['b', X.gPos, X.gName]] as const) {
      const [a, c] = m[s];
      const pos = a?.rang != null && c?.rang != null ? `${a.rang}+${c.rang}=${a.rang + c.rang}` : '';
      p.text(xPos, y, pos, { size: 8, color: C.ink });
      p.text(xName, y, kuerzen(p, [a?.name, c?.name].filter(Boolean).join(' / '), 8.5, 63), { size: 8.5, color: C.ink });
      p.text(xName, y + 4, [a?.id_nr, c?.id_nr].filter(Boolean).join(' / '), { size: 6.5, color: C.grau });
    }
    werte(m, w.doppel[i], y);
    p.line(L, y + 6, R, y + 6, C.linie, 0.15);
    y += 10;
  });
  summe(w.summeDoppel, 'Doppel');

  // Ergebnis, Angaben, Bemerkungen, Freigaben
  y += 2;
  const boxY = y, boxH = 30;
  p.rect(L, boxY, 80, boxH, { stroke: C.rand, lw: 0.3, radius: 2 });
  p.text(L + 4, boxY + 7, 'ERGEBNIS', { size: 7, bold: true, color: C.orangeDk });
  const zeile = (text: string, wert: string, yy: number, fett = false) => {
    p.text(L + 4, yy, text, { size: 8.5, color: C.ink, bold: fett });
    p.text(L + 76, yy, wert, { size: 8.5, color: C.ink, bold: true, align: 'R' });
  };
  zeile('Match-Punkte', `${w.summe.punkte[0]} : ${w.summe.punkte[1]}`, boxY + 12);
  zeile('Sätze', `${w.summe.saetze[0]} : ${w.summe.saetze[1]}`, boxY + 17);
  zeile('Spiele', `${w.summe.spiele[0]} : ${w.summe.spiele[1]}`, boxY + 22);
  const sieger = w.sieger === 'a' ? b.heim.team : w.sieger === 'b' ? b.gast.team : w.sieger === 'x' ? 'Unentschieden' : 'noch offen';
  zeile('Sieger', kuerzen(p, sieger, 8.5, 48), boxY + 27, true);

  p.rect(L + 84, boxY, 60, boxH, { stroke: C.rand, lw: 0.3, radius: 2 });
  p.text(L + 88, boxY + 7, 'ANGABEN', { size: 7, bold: true, color: C.orangeDk });
  p.text(L + 88, boxY + 12, `Zuschauer: ${d.zuschauer ?? '–'}`, { size: 8.5, color: C.ink });
  p.text(L + 88, boxY + 17, `Beginn: ${d.beginn || '–'} Uhr`, { size: 8.5, color: C.ink });
  p.text(L + 88, boxY + 22, `Ende: ${d.ende || '–'} Uhr`, { size: 8.5, color: C.ink });

  p.rect(L + 148, boxY, R - L - 148, boxH, { stroke: C.rand, lw: 0.3, radius: 2 });
  p.text(L + 152, boxY + 7, 'BEMERKUNGEN', { size: 7, bold: true, color: C.orangeDk });
  if (d.bemerkungen) p.textBlock(L + 152, boxY + 9.5, R - L - 156, d.bemerkungen.slice(0, 450), { size: 8, color: C.ink });

  y = boxY + boxH + 7;
  p.text(L, y, 'FREIGABE STATT UNTERSCHRIFT', { size: 7, bold: true, color: C.orangeDk });
  y += 6;
  const fr = (titel: string, f: Bericht['freigaben']['heim'], x: number) => {
    p.text(x, y, titel, { size: 7, color: C.grau });
    p.text(x, y + 5, f ? f.name : '—', { size: 9, bold: true, color: C.ink });
    p.text(x, y + 9.5, f ? `freigegeben ${zeitpunkt(f.am)}` : 'nicht freigegeben', { size: 7, color: C.grau });
  };
  fr('Mannschaftsführer Heim', b.freigaben.heim, L);
  fr('Mannschaftsführer Gast', b.freigaben.gast, L + 92);
  fr('Oberschiedsrichter', b.freigaben.osr, L + 184);
  p.text(L, 204, b.eingereicht ? `Eingereicht am ${zeitpunkt(b.eingereicht.am)} von ${b.eingereicht.von} · ${v.name}` : `Erstellt im Vereinsportal ${v.name}`, { size: 7, color: C.grau });
  return p.render();
}
