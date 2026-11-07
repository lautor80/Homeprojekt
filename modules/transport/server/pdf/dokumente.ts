import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { C, abschnitt, adressZeilen, anschrift, folgeKopf, fusszeilen, infoBlock, kopf, titel } from './layout.js';
import { auftragLesen, firmaLesen, wertText, type Stop } from '../data.js';
import { condense, dat, eur, heute } from '../format.js';

/**
 * Lieferschein – Inhalt wie Smartform ZEU_LIEFERSCHEIN:
 * An (Kunde), Lieferanschrift (Empfänger erster Stop), Auftrags-Nr., LS-Datum,
 * GLN/Markt des Kunden, Trägerpositionen, Hinweis Verpackungsfolie.
 */
export async function lieferscheinPdf(nr: string): Promise<Buffer> {
  const a = await auftragLesen(nr);
  const firma = await firmaLesen();
  const p = new Pdf({ title: `Lieferschein ${nr}`, author: firma.name });
  p.newPage();
  kopf(p, firma);
  anschrift(p, firma, adressZeilen(a.kundeAdr));

  const info: [string, string][] = [
    ['Auftrags-Nr.', nr],
    ['LS-Datum', dat(a.leistungsdatum ?? a.anlagedatum)],
  ];
  if (a.kundeAdr?.gln) info.push(['GLN', a.kundeAdr.gln]);
  if (a.kundeAdr?.markt) info.push(['Markt', a.kundeAdr.markt]);
  if (a.ordernummer) info.push(['Ihre Referenz', a.ordernummer]);
  infoBlock(p, info);
  titel(p, 'Lieferschein', null, 'Delivery Note');

  let y = 128;
  const s1 = a.stops[0];
  if (s1.firma_e || s1.plzort_e) {
    abschnitt(p, y, 'Lieferanschrift');
    y += 7;
    for (const z of [s1.firma_e, s1.strasse_e, condense(`${s1.land_e ?? ''}${s1.land_e ? '-' : ''}${s1.plzort_e ?? ''}`)]) {
      if (z) {
        p.text(C.left, y, z, { bold: true });
        y += 4.6;
      }
    }
    y += 6;
  }

  abschnitt(p, y, 'Lieferumfang');
  y += 6;
  const kopfzeile = (yy: number) => {
    const o = { size: 7, bold: true, color: C.muted };
    p.text(22, yy, 'POS.', o);
    p.text(35, yy, 'PRODUKTBEZEICHNUNG', o);
    p.text(190, yy, 'MENGE', { ...o, align: 'R' });
    p.line(C.left, yy + 2, C.right, yy + 2, C.line, 0.3);
  };
  kopfzeile(y);
  y += 7;
  const pos = a.traeger.filter((t) => t.menge >= 1);
  if (!pos.length) {
    p.text(35, y, 'Keine Positionen erfasst.', { color: C.muted });
    y += 7;
  }
  pos.forEach((t, i) => {
    if (y + 8 > C.bottom) {
      p.newPage();
      folgeKopf(p, `Lieferschein ${nr}`);
      y = 22;
      kopfzeile(y);
      y += 7;
    }
    if ((i + 1) % 2 === 0) p.rect(C.left, y - 4.8, C.right - C.left, 7.5, { fill: C.soft });
    p.text(22, y, String(i + 1).padStart(2, '0'), { color: C.muted });
    p.text(35, y, t.prod_txt || t.produkt || '');
    p.text(190, y, String(t.menge), { bold: true, align: 'R' });
    y += 7.5;
  });

  y += 8;
  if (y + 30 > C.bottom) {
    p.newPage();
    folgeKopf(p, `Lieferschein ${nr}`);
    y = 24;
  }
  p.rect(C.left, y - 5, C.right - C.left, 19, { fill: C.soft, stroke: C.line, lw: 0.25, radius: 2 });
  p.text(25, y, 'Bitte unbedingt beachten:', { bold: true });
  p.text(25, y + 5, 'Bitte entfernen Sie zeitnah die Verpackungsfolie!');
  p.text(25, y + 9.5, 'Durch Temperaturschwankungen könnte sich Schwitzwasser bilden!');
  y += 26;
  p.text(C.left, y, 'Ware vollständig und unbeschädigt erhalten:', { size: 8, color: C.muted });
  p.line(C.left, y + 14, 90, y + 14, C.ink, 0.3);
  p.line(110, y + 14, C.right, y + 14, C.ink, 0.3);
  p.text(C.left, y + 18, 'Datum', { size: 7, color: C.muted });
  p.text(110, y + 18, 'Unterschrift / Stempel Empfänger', { size: 7, color: C.muted });

  fusszeilen(p, firma);
  return p.render();
}

/**
 * Transportauftrag an den Unternehmer (Frachtführer):
 * Fahrzeug und Ladung, Lade-/Entladestellen, vereinbarter Frachtpreis, Besonderheiten.
 * (Das Smartform ZEU_SPEDITIONSAUFTRAG lag nicht im Paket – Inhalt aus den Auftragsdaten.)
 */
export async function transportauftragPdf(nr: string): Promise<Buffer> {
  const a = await auftragLesen(nr);
  const firma = await firmaLesen();
  const p = new Pdf({ title: `Transportauftrag ${nr}`, author: firma.name });
  p.newPage();
  kopf(p, firma);
  anschrift(p, firma, adressZeilen(a.unternehmerAdr));
  infoBlock(p, [
    ['Auftrags-Nr.', nr],
    ['Datum', dat(a.anlagedatum ?? heute())],
    ['Kennzeichen', a.kennzeichen && a.kennzeichen !== 'Bitte angeben' ? a.kennzeichen : ''],
    ['Ladenummer', a.ladenummer ?? ''],
  ]);
  titel(p, 'Transportauftrag', null, 'Transport Order');
  p.text(C.left, 127, 'Sehr geehrte Damen und Herren,');
  p.text(C.left, 131.5, 'hiermit beauftragen wir Sie mit dem folgenden Transport:');

  let y = 140;
  abschnitt(p, y, 'Fahrzeug und Ladung');
  y += 7;
  const felder: [string, string][] = [
    ['Fahrzeugtyp', await wertText('FAHRZEUGTYP', a.fahrzeugtyp)],
    ['Ladegut', await wertText('LADEGUT', a.ladegut)],
    ['Gewicht', a.gewicht ?? ''],
    ['Ladeweise', await wertText('LADEWEISE', a.ladeweise)],
    ['Palettentausch', await wertText('PALETTENTAUSCH', a.palettentausch)],
  ];
  felder.forEach(([k, v], i) => {
    const x = i % 2 === 0 ? C.left : 108;
    if (i % 2 === 0 && i > 0) y += 5;
    p.text(x, y, k, { size: 8.5, color: C.muted });
    p.text(x + 30, y, v || '–', { size: 8.5, bold: true });
  });
  y += 10;

  const stopBlock = (s: Stop, nrStop: number) => {
    if (!(s.firma || s.plzort || s.firma_e || s.plzort_e)) return;
    if (y + 34 > C.bottom) {
      p.newPage();
      folgeKopf(p, `Transportauftrag ${nr}`);
      y = 24;
    }
    abschnitt(p, y, `${nrStop}. Stop`);
    y += 7;
    const spalte = (x: number, ueber: string, firmaT: string | null, str: string | null, land: string | null, plzort: string | null,
      datum: string | null, zeit: string | null, extra?: string | null) => {
      let yy = y;
      p.text(x, yy, ueber, { size: 7, bold: true, color: C.accent });
      yy += 5;
      for (const z of [firmaT, str, condense(`${land ?? ''}${land ? '-' : ''}${plzort ?? ''}`)]) {
        if (z) {
          p.text(x, yy, z, { bold: z === firmaT });
          yy += 4.4;
        }
      }
      const termin = condense(`${dat(datum)} ${zeit ?? ''}`);
      if (termin) {
        p.text(x, yy, `Termin: ${termin}`, { size: 8.5 });
        yy += 4.4;
      }
      if (extra) {
        p.text(x, yy, `Ladenummer: ${extra}`, { size: 8.5 });
        yy += 4.4;
      }
      return yy;
    };
    const y1 = spalte(C.left, 'BELADESTELLE', s.firma, s.strasse, s.land, s.plzort, s.datum, s.zeit, s.ladenummer);
    const y2 = spalte(108, 'ENTLADESTELLE', s.firma_e, s.strasse_e, s.land_e, s.plzort_e, s.datum_e, s.zeit_e);
    y = Math.max(y1, y2) + 5;
  };
  stopBlock(a.stops[0], 1);
  stopBlock(a.stops[1], 2);

  if (y + 22 > C.bottom) {
    p.newPage();
    folgeKopf(p, `Transportauftrag ${nr}`);
    y = 24;
  }
  abschnitt(p, y, 'Frachtpreis');
  y += 8;
  p.text(C.left, y, 'Vereinbarter Frachtpreis');
  p.text(C.right, y, `${eur(a.frachtpreis_ek)} zzgl. USt`, { bold: true, align: 'R' });
  y += 10;

  if (a.besonderheiten) {
    const h = p.blockHeight(C.right - C.left, a.besonderheiten, { size: 9 });
    if (y + h + 12 > C.bottom) {
      p.newPage();
      folgeKopf(p, `Transportauftrag ${nr}`);
      y = 24;
    }
    abschnitt(p, y, 'Besonderheiten');
    y += 5;
    y += p.textBlock(C.left, y, C.right - C.left, a.besonderheiten, { size: 9 }) + 6;
  }
  if (y + 10 > C.bottom) {
    p.newPage();
    folgeKopf(p, `Transportauftrag ${nr}`);
    y = 24;
  }
  p.text(C.left, y + 4, 'Vielen Dank für die gute Zusammenarbeit!');

  fusszeilen(p, firma);
  return p.render();
}
