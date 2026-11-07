import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { C, adressZeilen, anschrift, folgeKopf, fusszeilen, ibanFormat, infoBlock, kopf, titel } from './layout.js';
import { fakturaAuftraege, firmaLesen, kaeufer } from '../data.js';
import { addTage, condense, dat, eur, heute, kategorie, netto } from '../format.js';

export interface RechnungPdf {
  faktura: string;
  datum: string;
  kunde: string;
  title: string;
  filename: string;
  pdf: Buffer;
}

interface Pos {
  nr: string;
  ref: string;
  von: string;
  nach: string;
  datL: string | null;
  datE: string | null;
  info: string;
  netto: number;
  kat: string;
}

const ROW_H = 11.5;

/**
 * Rechnungs-PDF (Einzel- oder Sammelrechnung) – Nachbau von ZCL_EU_RECHNUNG_PDF.
 * Endbetrag = gespeicherter Rechnungsbetrag (RGBETRAG), Netto und USt daraus zurückgerechnet.
 * Zahlungsblock mit GiroCode (EPC-QR).
 */
export async function rechnungPdf(faktura: string): Promise<RechnungPdf | null> {
  const auftraege = await fakturaAuftraege(faktura);
  if (!auftraege.length) return null;
  const firma = await firmaLesen();
  const satz = firma.ust_satz;

  const datum = auftraege[0].fakturadatum ?? heute();
  const buyer = kaeufer(auftraege[0]);
  const pos: Pos[] = [];
  let summeNetto = 0;
  let nettoS = 0;
  let von: string | null = null;
  let bis: string | null = null;

  for (const a of auftraege) {
    const [s1, s2] = a.stops;
    let ref = condense(a.ordernummer);
    if (ref.toUpperCase() === 'FOLGT') ref = '';
    const p: Pos = {
      nr: a.auftragsnr,
      ref,
      von: s1.plzort ? condense(`${s1.land ?? ''}${s1.land ? '-' : ''}${s1.plzort}`) : '',
      nach: '',
      datL: s1.datum,
      datE: null,
      info: '',
      netto: 0,
      kat: kategorie(a.steuerrelevant, buyer?.land),
    };
    if (s2.plzort_e) {
      p.nach = condense(`${s2.land_e ?? ''}${s2.land_e ? '-' : ''}${s2.plzort_e}`);
      p.datE = s2.datum_e;
    } else {
      p.nach = condense(`${s1.land_e ?? ''}${s1.land_e ? '-' : ''}${s1.plzort_e ?? ''}`);
      p.datE = s1.datum_e;
    }
    if (/^[\s-]*$/.test(p.nach)) p.nach = '';
    p.info = a.traeger.filter((t) => t.menge >= 1).map((t) => `${t.menge} x ${t.prod_txt || t.produkt}`).join(', ');
    p.netto = netto(a.rgbetrag, p.kat, satz);
    summeNetto += p.netto;
    if (p.kat === 'S') nettoS += p.netto;

    const ld = a.leistungsdatum ?? p.datE ?? p.datL;
    if (ld) {
      if (!von || ld < von) von = ld;
      if (!bis || ld > bis) bis = ld;
    }
    pos.push(p);
  }

  const ust = Math.round(nettoS * satz) / 100;
  const brutto = Math.round((summeNetto + ust) * 100) / 100;
  const faellig = addTage(datum, firma.zahlungsziel_tage);
  const multi = pos.length > 1;
  const titelText = multi ? 'Sammelrechnung' : 'Rechnung';
  const kunde = condense(`${buyer?.kundenname ?? ''} ${buyer?.kundenname2 ?? ''}`);

  const p = new Pdf({ title: `${titelText} ${faktura}`, author: firma.name });

  // ---- Seite 1: Kopf ----
  p.newPage();
  kopf(p, firma);
  anschrift(p, firma, adressZeilen(buyer));
  const leistung = !von ? '' : von === bis ? dat(von) : `${von.slice(8, 10)}.${von.slice(5, 7)}.–${dat(bis)}`;
  infoBlock(p, [
    ['Rechnungs-Nr.', faktura],
    ['Rechnungsdatum', dat(datum)],
    ['Leistung', leistung],
    ['Ihre Referenz', multi ? `${pos.length} Bestellungen` : pos[0].ref],
    ['Fällig am', dat(faellig)],
  ]);
  titel(p, titelText, `${pos.length} ${multi ? 'Transportaufträge' : 'Transportauftrag'}`.toUpperCase(), 'Transportrechnung · Freight Invoice');
  p.text(C.left, 127, 'Sehr geehrte Damen und Herren,');
  p.text(C.left, 131.5, 'für die folgenden Transportleistungen erlauben wir uns zu berechnen:');

  // ---- Positionen ----
  const kopfzeile = (y: number) => {
    const o = { size: 7, bold: true, color: C.muted };
    p.text(22, y, 'POS.', o);
    p.text(31, y, 'AUFTRAG / IHRE REFERENZ', o);
    p.text(75, y, 'ROUTE', o);
    p.text(190, y, 'NETTO', { ...o, align: 'R' });
    p.line(C.left, y + 2, C.right, y + 2, C.ink, 0.4);
  };
  let y = 139;
  kopfzeile(y);
  y += 6;
  pos.forEach((ps, idx) => {
    const i = idx + 1;
    if (y + ROW_H > C.bottom) {
      p.newPage();
      folgeKopf(p, `${titelText} ${faktura}`);
      y = 20;
      kopfzeile(y);
      y += 6;
    }
    if (i % 2 === 0) p.rect(C.left, y, C.right - C.left, ROW_H, { fill: C.soft });
    p.line(C.left, y + ROW_H, C.right, y + ROW_H, C.line);
    p.text(22, y + 4.8, String(i).padStart(2, '0'), { color: C.muted });
    p.text(31, y + 4.8, ps.nr, { bold: true });
    p.text(31, y + 8.8, ps.ref, { size: 8, color: C.muted });
    if (ps.von || ps.nach) {
      p.text(75, y + 4.8, ps.von);
      if (ps.datL) p.text(75, y + 8.8, `Ladung ${dat(ps.datL)}`, { size: 7.5, color: C.muted });
      p.line(112, y + 3.6, 115.5, y + 3.6, C.accent, 0.4);
      p.line(114.3, y + 2.6, 115.5, y + 3.6, C.accent, 0.4);
      p.line(114.3, y + 4.6, 115.5, y + 3.6, C.accent, 0.4);
      p.text(118, y + 4.8, ps.nach);
      if (ps.datE) p.text(118, y + 8.8, `Lieferung ${dat(ps.datE)}`, { size: 7.5, color: C.muted });
    } else {
      p.text(75, y + 4.8, 'Transportleistung');
      p.text(75, y + 8.8, ps.info, { size: 7.5, color: C.muted });
    }
    p.text(190, y + 4.8, eur(ps.netto), { bold: true, align: 'R' });
    y += ROW_H;
  });

  // ---- Summen, Zahlung, Hinweis (bleiben zusammen) ----
  const nichtS = pos.find((x) => x.kat !== 'S');
  const katText = !nichtS ? '' :
    nichtS.kat === 'AE' ? 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)' :
    nichtS.kat === 'O' ? 'Nicht im Inland steuerbare Leistung' : 'Steuerfreie Leistung';

  if (y + 80 > C.bottom) {
    p.newPage();
    folgeKopf(p, `${titelText} ${faktura}`);
    y = 20;
  }
  y += 7;
  p.text(116, y, 'Summe netto');
  p.text(190, y, eur(summeNetto), { align: 'R' });
  y += 5;
  if (nettoS > 0) {
    p.text(116, y, `zzgl. ${String(satz).replace('.', ',')} % USt`);
    p.text(190, y, eur(ust), { align: 'R' });
    y += 5;
  }
  if (katText) {
    p.text(116, y, 'USt 0 %');
    p.text(190, y, eur(0), { align: 'R' });
    y += 5;
  }
  p.rect(114, y - 2.5, 78, 9, { fill: C.ink, radius: 1.5 });
  p.text(116, y + 3.4, 'Rechnungsbetrag', { size: 11, bold: true, color: 'FFFFFF' });
  p.text(190, y + 3.4, eur(brutto), { size: 11, bold: true, color: 'FFFFFF', align: 'R' });
  y += 10;
  if (katText) {
    p.text(190, y, katText, { size: 7.5, color: C.muted, align: 'R' });
    y += 4;
  }

  // Zahlungsblock mit GiroCode (EPC069-12, Version 002)
  y += 5;
  p.rect(C.left, y, C.right - C.left, 32, { stroke: C.line, lw: 0.3, radius: 2 });
  const epc = ['BCD', '002', '1', 'SCT', firma.bic, firma.name.slice(0, 70), firma.iban.replace(/\s+/g, ''),
    `EUR${brutto.toFixed(2)}`, '', '', `Rechnung ${faktura}`].join('\n');
  if (firma.iban) p.qr(epc, 25, y + 4, 24);
  let px = 55;
  const t1 = 'Bitte überweisen Sie ';
  const t2 = eur(brutto);
  const t3 = ` bis zum ${dat(faellig)}.`;
  const b = { size: 10, bold: true };
  p.text(px, y + 9, t1, b);
  px += p.textWidth(t1, b);
  p.text(px, y + 9, t2, { ...b, color: C.accent });
  px += p.textWidth(t2, b);
  p.text(px, y + 9, t3, b);
  p.text(55, y + 14, `${firma.bank} · IBAN ${ibanFormat(firma.iban)} · BIC ${firma.bic}`, { size: 8.5 });
  p.text(55, y + 18, 'Verwendungszweck: ', { size: 8.5 });
  p.text(55 + p.textWidth('Verwendungszweck: ', { size: 8.5 }), y + 18, `Rechnung ${faktura}`, { size: 8.5, bold: true });
  p.text(55, y + 24, 'Einfach den QR-Code (GiroCode) mit Ihrer Banking-App scannen -', { size: 7.5, color: C.muted });
  p.text(55, y + 27.5, 'Betrag und Verwendungszweck sind schon ausgefüllt.', { size: 7.5, color: C.muted });
  y += 32 + 7;

  // Hinweis E-Rechnung
  p.rect(C.left, y - 3.3, 18, 4.6, { fill: C.soft, stroke: C.line, lw: 0.25, radius: 1 });
  p.text(29, y, 'E-Rechnung', { size: 7.5, bold: true, align: 'C' });
  p.text(41, y, 'Diese Rechnung erhalten Sie zusätzlich als XRechnung 3.0 (EN 16931) im XML-Format.', { size: 7.5, color: C.muted });
  p.text(C.left, y + 9, 'Vielen Dank für Ihren Auftrag!');

  fusszeilen(p, firma);

  return {
    faktura,
    datum,
    kunde,
    title: `${titelText} ${faktura} - ${buyer?.kundenname ?? ''}`,
    filename: `Rechnung_${faktura}.pdf`,
    pdf: await p.render(),
  };
}
