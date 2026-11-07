/**
 * SEPA-Basislastschrift (pain.008) – Port von ZCL_SEPA_PAIN008.
 *  - Variante TCO02: pain.008.001.02 im Layout der bisherigen Linear-Datei (Gläubiger-ID je Transaktion,
 *    Zahlerbank bei EWR-IBAN „NOTPROVIDED“, BIC-Tag „BIC“)
 *  - Variante DK08: pain.008.001.08 nach DFÜ-Abkommen
 * Prüfungen: Gläubiger, Fälligkeit (TARGET2), IBAN/BIC, Mandat, Betrag, Zeichensatz, Anschrift außerhalb EWR, Doppelmandate.
 */

export type Variante = 'TCO02' | 'DK08';
export interface Glaeubiger { name: string; iban: string; bic?: string | null; glaeubigerId: string }
export interface Lastschrift {
  zahlerNr: string;            // für Meldungen
  name: string;
  iban: string;
  bic?: string | null;
  mandat: string;
  mandatsdatum: string;        // JJJJ-MM-TT
  betrag: number;
  zweck: string;
  endToEndId?: string;
  sequenz?: 'FRST' | 'RCUR' | 'OOFF' | 'FNAL';
  strasse?: string; hausnr?: string; plz?: string; ort?: string; land?: string;
}
export interface Meldung { zeile: number; zahlerNr: string; schwere: 'E' | 'W'; feld: string; text: string }
export interface Ergebnis { xml: string | null; anzahl: number; summe: number; meldungen: Meldung[]; fehler: boolean }

const EWR = ' AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IS IT LI LT LU LV MT NL NO PL PT RO SE SI SK ';
const IBAN_LAENGE: Record<string, number> = {
  NO: 15, BE: 16, DK: 18, FI: 18, NL: 18, SI: 19, AT: 20, EE: 20, LT: 20, LU: 20, CH: 21, HR: 21, LI: 21, LV: 21,
  BG: 22, DE: 22, GB: 22, IE: 22, VA: 22, AD: 24, CZ: 24, ES: 24, RO: 24, SE: 24, SK: 24, PT: 25, IS: 26,
  FR: 27, GR: 27, IT: 27, MC: 27, SM: 27, CY: 28, HU: 28, PL: 28, MT: 31,
};

export const normalisieren = (s: string | null | undefined) => (s ?? '').replace(/\s/g, '').toUpperCase();
export const istEwr = (land: string) => land.length === 2 && EWR.includes(` ${land} `);

function mod97(s: string): number {
  let r = 0;
  for (const c of s) {
    const v = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(c);
    if (v < 0) return -1;
    r = v < 10 ? (r * 10 + v) % 97 : (r * 100 + v) % 97;
  }
  return r;
}

export function ibanGueltig(iban: string | null | undefined): boolean {
  const i = normalisieren(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(i)) return false;
  const soll = IBAN_LAENGE[i.slice(0, 2)];
  if (soll && i.length !== soll) return false;
  return mod97(i.slice(4) + i.slice(0, 4)) === 1;
}

export const bicGueltig = (bic: string | null | undefined) => /^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalisieren(bic));

/** Gläubiger-ID: Land(2) + Prüfziffer(2) + Geschäftsbereich(3) + nationale Kennung */
export function glaeubigerIdGueltig(ci: string | null | undefined): boolean {
  const c = normalisieren(ci);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9+?/:().,'-]{4,31}$/.test(c)) return false;
  if (c.startsWith('DE') && c.length !== 18) return false;
  const rest = mod97(c.slice(7).replace(/[^A-Z0-9]/g, '') + c.slice(0, 2) + '00');
  return rest >= 0 && 98 - rest === Number(c.slice(2, 4));
}

export function referenzGueltig(v: string | null | undefined, leerzeichen = false): boolean {
  const s = v ?? '';
  if (!s || s.length > 35) return false;
  if (!(leerzeichen ? /^[A-Za-z0-9+?/:().,' -]+$/ : /^[A-Za-z0-9+?/:().,'-]+$/).test(s)) return false;
  return !(s.startsWith('/') || s.endsWith('/') || s.includes('//'));
}

/** Text in den SEPA-Zeichensatz umsetzen (Umlaute ausschreiben, Sonderzeichen → Leerzeichen) */
export function sepaText(t: string, max = 100000): string {
  let s = t.replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ä/g, 'ae').replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/&/g, '+');
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^A-Za-z0-9/?:().,'+ -]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

// ---------------------------------------------------------------- Kalender
function ostersonntag(j: number): Date {
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mon = Math.floor((h + l - 7 * m + 114) / 31), tag = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(j, mon - 1, tag));
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
export function plusTage(datum: string, n: number): string {
  const d = new Date(`${datum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** TARGET2-Geschäftstag: nicht Sa/So, 1.1., 1.5., 25./26.12., Karfreitag, Ostermontag */
export function istTarget2Tag(datum: string): boolean {
  const d = new Date(`${datum}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const wt = d.getUTCDay();
  if (wt === 0 || wt === 6) return false;
  const md = datum.slice(5);
  if (['01-01', '05-01', '12-25', '12-26'].includes(md)) return false;
  const o = ostersonntag(d.getUTCFullYear());
  return datum !== plusTage(iso(o), -2) && datum !== plusTage(iso(o), 1);
}

/** Fälligkeit-Vorschlag: erster TARGET2-Tag ab max(heute + Vorlauf TARGET2-Tage, 1. des Sollmonats) */
export function faelligkeitVorschlag(heute: string, vorlauf: number, sollper: string): string {
  let min = heute;
  for (let n = 0; n < vorlauf;) {
    min = plusTage(min, 1);
    if (istTarget2Tag(min)) n++;
  }
  const erster = `${sollper.slice(0, 4)}-${sollper.slice(4, 6)}-01`;
  let d = erster > min ? erster : min;
  while (!istTarget2Tag(d)) d = plusTage(d, 1);
  return d;
}

// ---------------------------------------------------------------- Datei
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const betrag = (n: number) => n.toFixed(2);

export function pain008(opts: {
  glaeubiger: Glaeubiger; faellig: string; posten: Lastschrift[]; heute: string; zeit: string;
  variante?: Variante; nachrichtenId?: string; pmtInfPrefix?: string; lastschriftart?: 'CORE' | 'B2B';
}): Ergebnis {
  const v = opts.variante ?? 'TCO02';
  const m: Meldung[] = [];
  const add = (zeile: number, zahlerNr: string, feld: string, text: string, schwere: 'E' | 'W' = 'E') => m.push({ zeile, zahlerNr, schwere, feld, text });
  const txt = (zeile: number, nr: string, feld: string, t: string, max: number) => {
    const s = sepaText(t);
    if (s.length > max) { add(zeile, nr, feld, `${feld} wird auf ${max} Zeichen gekürzt`, 'W'); return s.slice(0, max).trim(); }
    return s;
  };

  // Gläubiger
  const g = { name: txt(0, '', 'Gläubigername', opts.glaeubiger.name, 70), iban: normalisieren(opts.glaeubiger.iban), bic: normalisieren(opts.glaeubiger.bic), ci: normalisieren(opts.glaeubiger.glaeubigerId) };
  if (!g.name) add(0, '', 'Gläubigername', 'Name des Gläubigers fehlt');
  if (!ibanGueltig(g.iban)) add(0, '', 'Gläubiger-IBAN', `Gläubiger-IBAN "${g.iban}" ist ungültig`);
  if (g.bic && !bicGueltig(g.bic)) add(0, '', 'Gläubiger-BIC', `Gläubiger-BIC "${g.bic}" ist ungültig`);
  if (!glaeubigerIdGueltig(g.ci)) add(0, '', 'Gläubiger-ID', `Gläubiger-ID "${g.ci}" ist ungültig (Format/Prüfziffer)`);
  // Fälligkeit
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.faellig)) add(0, '', 'Fälligkeit', 'Fälligkeitsdatum fehlt oder ist ungültig');
  else if (opts.faellig <= opts.heute) add(0, '', 'Fälligkeit', `Fälligkeitsdatum ${opts.faellig.split('-').reverse().join('.')} muss nach dem heutigen Tag liegen`);
  else if (!istTarget2Tag(opts.faellig)) add(0, '', 'Fälligkeit', `${opts.faellig.split('-').reverse().join('.')} ist kein TARGET2-Geschäftstag – Belastung erst am nächsten Geschäftstag`, 'W');
  const msgId = opts.nachrichtenId ?? `SDD${opts.heute.replace(/-/g, '')}${opts.zeit.replace(/:/g, '')}`;
  if (!referenzGueltig(msgId)) add(0, '', 'MsgId', `Nachrichten-ID "${msgId}" ist ungültig`);
  if (!opts.posten.length) add(0, '', 'Positionen', 'Keine Lastschriften übergeben');

  const posten = opts.posten.map((p, i) => {
    const z = i + 1;
    const nr = p.zahlerNr;
    const q = {
      ...p, name: txt(z, nr, 'Name', p.name, 70), iban: normalisieren(p.iban), bic: normalisieren(p.bic), mandat: (p.mandat ?? '').trim(),
      zweck: txt(z, nr, 'Verwendungszweck', p.zweck ?? '', 140), sequenz: p.sequenz ?? 'RCUR',
      strasse: txt(z, nr, 'Straße', p.strasse ?? '', 70), hausnr: txt(z, nr, 'Hausnummer', p.hausnr ?? '', 16),
      plz: txt(z, nr, 'PLZ', p.plz ?? '', 16), ort: txt(z, nr, 'Ort', p.ort ?? '', 35), land: (p.land ?? '').trim().toUpperCase(),
    };
    if (!q.name) add(z, nr, 'Name', 'Name des Zahlungspflichtigen fehlt');
    if (!q.iban) add(z, nr, 'IBAN', 'IBAN fehlt');
    else if (!ibanGueltig(q.iban)) add(z, nr, 'IBAN', `IBAN "${q.iban}" ist ungültig (Länge oder Prüfziffer)`);
    if (q.bic && !bicGueltig(q.bic)) add(z, nr, 'BIC', `BIC "${q.bic}" ist ungültig`);
    if (!q.mandat) add(z, nr, 'Mandatsreferenz', 'Mandatsreferenz fehlt');
    else if (!referenzGueltig(q.mandat)) add(z, nr, 'Mandatsreferenz', `Mandatsreferenz "${q.mandat}" ungültig: max. 35 Zeichen, keine Leerzeichen/Umlaute, nicht mit / beginnen oder enden, kein //`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.mandatsdatum ?? '')) add(z, nr, 'Mandatsdatum', 'Datum der Mandatsunterschrift fehlt oder ist ungültig');
    else if (q.mandatsdatum > opts.heute) add(z, nr, 'Mandatsdatum', `Mandatsdatum ${q.mandatsdatum.split('-').reverse().join('.')} liegt in der Zukunft`);
    if (!(q.betrag > 0)) add(z, nr, 'Betrag', 'Betrag muss größer 0 sein');
    else if (q.betrag > 999999999.99) add(z, nr, 'Betrag', 'Betrag überschreitet 999.999.999,99 EUR');
    if (q.land && !/^[A-Z]{2}$/.test(q.land)) add(z, nr, 'Land', `Land "${q.land}" ist kein ISO-Ländercode (z. B. DE)`);
    const ibanLand = q.iban.slice(0, 2);
    if (ibanLand && !istEwr(ibanLand)) {
      if (!q.bic) add(z, nr, 'BIC', `BIC ist für Konten in ${ibanLand} (außerhalb EWR) Pflicht`);
      if (!q.ort || !q.land) add(z, nr, 'Anschrift', `Ort und Land sind für Konten in ${ibanLand} (außerhalb EWR) Pflicht`);
    }
    if (q.endToEndId && !referenzGueltig(q.endToEndId, true)) add(z, nr, 'EndToEndId', `End-to-End-Referenz "${q.endToEndId}" ist ungültig`);
    return q;
  });
  // doppelte Mandate zum selben Termin
  const gesehen = new Map<string, number>();
  posten.forEach((p, i) => {
    if (!p.mandat) return;
    const vor = gesehen.get(p.mandat);
    if (vor) add(i + 1, p.zahlerNr, 'Mandatsreferenz', `Mandat ${p.mandat} wird mehrfach zum selben Termin eingezogen (auch Satz ${vor}) – Doppelbuchung?`, 'W');
    else gesehen.set(p.mandat, i + 1);
  });

  const fehler = m.some((x) => x.schwere === 'E');
  const summe = Math.round(posten.reduce((s, p) => s + p.betrag, 0) * 100) / 100;
  if (fehler) return { xml: null, anzahl: posten.length, summe, meldungen: m, fehler };

  // XML schreiben
  const ns = v === 'TCO02' ? 'urn:iso:std:iso:20022:tech:xsd:pain.008.001.02' : 'urn:iso:std:iso:20022:tech:xsd:pain.008.001.08';
  const xsd = v === 'TCO02' ? 'pain.008.001.02.xsd' : 'pain.008.001.08.xsd';
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  let ebene = 0;
  const auf = (tag: string, attr = '') => { out.push(`${'  '.repeat(ebene)}<${tag}${attr ? ` ${attr}` : ''}>`); ebene++; };
  const zu = (tag: string) => { ebene--; out.push(`${'  '.repeat(ebene)}</${tag}>`); };
  const el = (tag: string, wert: string, attr = '') => out.push(`${'  '.repeat(ebene)}<${tag}${attr ? ` ${attr}` : ''}>${esc(wert)}</${tag}>`);
  const schemeId = () => {
    auf('CdtrSchmeId'); auf('Id'); auf('PrvtId'); auf('Othr');
    el('Id', g.ci); auf('SchmeNm'); el('Prtry', 'SEPA'); zu('SchmeNm');
    zu('Othr'); zu('PrvtId'); zu('Id'); zu('CdtrSchmeId');
  };
  const agent = (tag: string, bic: string) => {
    auf(tag); auf('FinInstnId');
    if (bic) el(v === 'TCO02' ? 'BIC' : 'BICFI', bic);
    else { auf('Othr'); el('Id', 'NOTPROVIDED'); zu('Othr'); }
    zu('FinInstnId'); zu(tag);
  };

  auf('Document', `xmlns="${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${ns} ${xsd}"`);
  auf('CstmrDrctDbtInitn');
  auf('GrpHdr');
  el('MsgId', msgId);
  el('CreDtTm', `${opts.heute}T${opts.zeit}`);
  el('NbOfTxs', String(posten.length));
  el('CtrlSum', betrag(summe));
  auf('InitgPty'); el('Nm', g.name); zu('InitgPty');
  zu('GrpHdr');

  const gruppen = [...new Set(posten.map((p) => p.sequenz))];
  gruppen.forEach((seq, gi) => {
    const tx = posten.filter((p) => p.sequenz === seq);
    auf('PmtInf');
    let pid = v === 'TCO02' && opts.pmtInfPrefix ? `${opts.pmtInfPrefix}-${opts.heute}T${opts.zeit}` : `${msgId.slice(0, 30)}-${gi + 1}`;
    if (v === 'TCO02' && opts.pmtInfPrefix && gi > 0) pid += `-${gi + 1}`;
    el('PmtInfId', pid);
    el('PmtMtd', 'DD');
    el('BtchBookg', 'true');
    el('NbOfTxs', String(tx.length));
    el('CtrlSum', betrag(tx.reduce((s, p) => s + p.betrag, 0)));
    auf('PmtTpInf');
    auf('SvcLvl'); el('Cd', 'SEPA'); zu('SvcLvl');
    auf('LclInstrm'); el('Cd', opts.lastschriftart ?? 'CORE'); zu('LclInstrm');
    el('SeqTp', seq);
    zu('PmtTpInf');
    el('ReqdColltnDt', opts.faellig);
    auf('Cdtr'); el('Nm', g.name); zu('Cdtr');
    auf('CdtrAcct'); auf('Id'); el('IBAN', g.iban); zu('Id'); zu('CdtrAcct');
    agent('CdtrAgt', g.bic);
    el('ChrgBr', 'SLEV');
    if (v !== 'TCO02') schemeId();
    for (const p of tx) {
      auf('DrctDbtTxInf');
      auf('PmtId'); el('EndToEndId', p.endToEndId || 'NOTPROVIDED'); zu('PmtId');
      el('InstdAmt', betrag(p.betrag), 'Ccy="EUR"');
      auf('DrctDbtTx'); auf('MndtRltdInf'); el('MndtId', p.mandat); el('DtOfSgntr', p.mandatsdatum); zu('MndtRltdInf');
      if (v === 'TCO02') schemeId();
      zu('DrctDbtTx');
      agent('DbtrAgt', v === 'TCO02' && istEwr(p.iban.slice(0, 2)) ? '' : p.bic);
      auf('Dbtr'); el('Nm', p.name);
      if (p.ort && p.land) {
        auf('PstlAdr');
        if (p.strasse) el('StrtNm', p.strasse);
        if (p.hausnr) el('BldgNb', p.hausnr);
        if (p.plz) el('PstCd', p.plz);
        el('TwnNm', p.ort); el('Ctry', p.land);
        zu('PstlAdr');
      }
      zu('Dbtr');
      auf('DbtrAcct'); auf('Id'); el('IBAN', p.iban); zu('Id'); zu('DbtrAcct');
      if (p.zweck) { auf('RmtInf'); el('Ustrd', p.zweck); zu('RmtInf'); }
      zu('DrctDbtTxInf');
    }
    zu('PmtInf');
  });
  zu('CstmrDrctDbtInitn');
  zu('Document');
  return { xml: out.join('\n'), anzahl: posten.length, summe, meldungen: m, fehler: false };
}
