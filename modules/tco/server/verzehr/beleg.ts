import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { logoWeiss, paperless, plAktiv, type Db, type Verein } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { kontaktLesen, mailSenden, mobilnummer, whatsappLink, type Kontakt } from '../kommunikation.js';
import { alleFusszeilen, betragText, C, girocode, kuerzen, LEFT, umbruch } from '../pdf/layout.js';
import { K } from '../paperless-kontexte.js';
import { belegLesen, belegPosten, monatsname, ZAHLART_TEXT, type Beleg, type Posten } from './logik.js';

/**
 * Verzehrbeleg als PDF (Gastbeleg bzw. Sammelabrechnung), Ablage in Paperless (Neudruck = neue Version),
 * Versand per E-Mail (n8n) oder WhatsApp-Link. Layout wie die Hallenrechnung.
 */

export interface Empfaenger { name: string; vorname: string; nachname: string; strasse: string; plz_ort: string; email: string; mobil: string; zusatz: string }

export async function empfaenger(db: Db, b: Beleg): Promise<Empfaenger> {
  if (b.adrnr) {
    const k: Kontakt | null = await kontaktLesen(db, b.adrnr);
    if (k) {
      const g = (k.geschlecht ?? '').toUpperCase();
      const anrede = ['M', '1'].includes(g) ? 'Herr' : ['W', 'F', '2'].includes(g) ? 'Frau' : '';
      return { name: condense(`${anrede} ${k.vorname} ${k.nachname}`), vorname: k.vorname, nachname: k.nachname, strasse: k.strasse, plz_ort: condense(`${k.plz} ${k.ort}`), email: k.email, mobil: k.mobil, zusatz: '' };
    }
  }
  const name = condense(b.gast_name ?? '') || condense(b.gast_gruppe ?? '') || 'Gast';
  const teile = name.split(' ');
  return {
    name, vorname: teile.length > 1 ? teile[0] : '', nachname: teile.length > 1 ? teile.slice(1).join(' ') : name,
    strasse: b.gast_name && b.gast_gruppe ? condense(b.gast_gruppe) : '', plz_ort: '', email: b.email ?? '', mobil: mobilnummer(b.mobil), zusatz: 'Gast',
  };
}

export const belegTitel = (b: Beleg) => (b.art === 'GAST' ? 'Verzehrbeleg' : `Verzehrabrechnung ${monatsname(b.monat ?? '')}`);

export async function belegPdf(v: Verein, b: Beleg, e: Empfaenger, pos: Posten[]): Promise<Buffer> {
  const p = new Pdf({ title: `${belegTitel(b)} ${b.rgnr}`, author: v.name, creator: 'TCO Vereinsportal' });
  belegZeichnen(p, v, b, e, pos);
  alleFusszeilen(p, v);
  return p.render();
}

/** Monatsabschluss-Vorschau: alle künftigen Sammelabrechnungen in einem PDF, Kennzeichnung „VORSCHAU“ */
export async function vorschauPdf(v: Verein, teile: { beleg: Beleg; empfaenger: Empfaenger; pos: Posten[] }[]): Promise<Buffer> {
  const p = new Pdf({ title: `Vorschau Verzehrabrechnung ${teile[0] ? monatsname(teile[0].beleg.monat ?? '') : ''}`, author: v.name, creator: 'TCO Vereinsportal' });
  for (const t of teile) belegZeichnen(p, v, t.beleg, t.empfaenger, t.pos, true);
  alleFusszeilen(p, v);
  return p.render();
}

/** Ein Beleg ab einer neuen Seite im Vereinslayout (Kopfband, Positionen, Zahlkarte) */
function belegZeichnen(p: Pdf, v: Verein, b: Beleg, e: Empfaenger, pos: Posten[], vorschau = false) {
  p.newPage();
  const bezahlt = b.status === 'BEZAHLT';
  const zweck = vorschau ? `Verzehr ${monatsname(b.monat ?? '')}` : `Verzehr ${b.rgnr}`;

  p.rect(0, 0, 210, 46, { fill: C.orange });
  p.text(LEFT, 31, b.art === 'GAST' ? 'BELEG' : 'ABRECHNUNG', { size: 24, color: 'FFFFFF' });
  p.text(LEFT, 38.5, `${belegTitel(b)} · ${vorschau ? 'Vorschau – noch nicht erzeugt' : `Nr. ${b.rgnr}`} · ${dat(b.datum)}`, { size: 10, color: 'FFFFFF' });
  p.image(logoWeiss(v), 137, 5.6, 57, 34.7);
  if (vorschau) {
    p.rect(104, 48, 88, 7, { fill: C.orangeSoft, radius: 2 });
    p.text(148, 53, 'VORSCHAU – Belegnummer wird beim Abschluss vergeben', { size: 7, bold: true, color: C.orangeDk, align: 'C' });
  }

  const grau = { size: 7, color: C.grau };
  const fett = { size: 9.5, bold: true, color: C.ink };
  p.text(LEFT, 58, b.art === 'GAST' ? 'GAST' : 'MITGLIED', grau);
  p.text(66, 58, bezahlt ? 'BEZAHLT AM' : 'ZAHLUNGSZIEL', grau);
  p.text(104, 58, 'ZAHLUNGSART', grau);
  p.text(144, 58, 'ANSPRECHPARTNER', grau);
  p.text(LEFT, 63, kuerzen(p, e.name, 9.5, 46), fett);
  if (e.strasse) p.text(LEFT, 67.5, kuerzen(p, e.strasse, 9, 46), { size: 9, color: C.ink });
  if (e.plz_ort) p.text(LEFT, 72, e.plz_ort, { size: 9, color: C.ink });
  p.text(66, 63, bezahlt ? dat(b.bezahlt_am) : b.faellig ? dat(b.faellig) : '–', fett);
  p.text(104, 63, b.zahlart ? ZAHLART_TEXT[b.zahlart] : 'Rechnung', fett);
  p.text(144, 63, v.ansprechpartner ?? '', fett);

  let top = 80;
  let y = tabellenkopf(p, top);
  for (const [i, ps] of pos.entries()) {
    if (y > 262) {
      p.rect(LEFT, top, 174, y - 4.4 - top, { stroke: C.rand, lw: 0.3, radius: 3 });
      p.newPage();
      top = 18;
      y = tabellenkopf(p, top);
    }
    const t = { size: 9, color: C.ink };
    p.text(23, y, String(i + 1), t);
    p.text(31, y, dat(ps.datum), t);
    p.text(52, y, kuerzen(p, ps.text, 9, 78), t);
    p.text(146, y, betragText(ps.preis), { ...t, align: 'R' });
    p.text(164, y, ps.anzahl.toLocaleString('de-DE', { maximumFractionDigits: 2 }), { ...t, align: 'R' });
    p.text(187, y, betragText(ps.betrag), { ...t, align: 'R' });
    p.line(22, y + 2.7, 188, y + 2.7, C.linie, 0.25);
    y += 7;
  }
  y += 1.5;
  p.text(23, y, 'Gesamtbetrag', { size: 11, bold: true, color: C.ink });
  p.text(187, y, betragText(b.betrag), { size: 11, bold: true, color: C.ink, align: 'R' });
  const h = y + 5 - top;
  p.rect(LEFT, top, 174, h, { stroke: C.rand, lw: 0.3, radius: 3 });

  y = top + h + 9;
  if (y + 66 > 278) { p.newPage(); y = 18; }
  const absaetze = bezahlt
    ? [`Vielen Dank für deinen Besuch im Clubhaus. Der Betrag wurde am ${dat(b.bezahlt_am)} ${b.zahlart ? `per ${ZAHLART_TEXT[b.zahlart]} ` : ''}bezahlt.`, 'Dieser Beleg dient als Quittung.']
    : b.zahlart === 'LASTSCHRIFT'
      ? [`Deine Verzehrpositionen aus dem ${monatsname(b.monat ?? '')} im Überblick.`, 'Der Betrag wird mit der nächsten Lastschrift von deinem Konto eingezogen – du musst nichts weiter tun.']
      : [`Deine Verzehrpositionen aus dem ${monatsname(b.monat ?? '')} im Überblick.`, `Wir bitten um Überweisung bis zum ${dat(b.faellig)} – am einfachsten mit dem QR-Code rechts.`, 'Bitte gib bei der Überweisung die Belegnummer an.'];
  let ty = y + 4;
  for (const a of absaetze) {
    for (const z of umbruch(p, a, 9, 80)) { p.text(LEFT, ty, z, { size: 9, color: C.grau }); ty += 4.3; }
    ty += 1.8;
  }
  ty += 3;
  p.text(LEFT, ty, 'Viele Grüße', { size: 9, color: C.ink });
  p.text(LEFT, ty + 4.3, v.ansprechpartner ?? '', { size: 9, color: C.ink });

  p.rect(104, y, 88, 64, { fill: 'FFFFFF', radius: 3 });
  p.rect(104, y, 88, 13, { fill: C.orangeSoft, radius: 3 });
  p.rect(104, y + 7, 88, 6, { fill: C.orangeSoft });
  p.rect(104, y, 88, 64, { stroke: C.orange, lw: 0.45, radius: 3 });
  p.text(109, y + 8.6, bezahlt ? 'BEZAHLT' : b.zahlart === 'LASTSCHRIFT' ? 'WIRD EINGEZOGEN' : 'ZU ZAHLEN', { size: 8, bold: true, color: C.orangeDk });
  p.text(187, y + 9.3, betragText(b.betrag), { size: 15, bold: true, color: C.orangeDk, align: 'R' });
  if (!bezahlt && b.zahlart !== 'LASTSCHRIFT' && b.betrag > 0) p.qr(girocode(v, b.betrag, zweck), 109, y + 18, 31);
  const tx = bezahlt || b.zahlart === 'LASTSCHRIFT' ? 109 : 146;
  p.text(tx, y + 22, kuerzen(p, v.name, 9, 44), { size: 9, bold: true, color: C.ink });
  p.text(tx, y + 25.8, v.bank ?? '', { size: 7.5, color: C.grau });
  p.text(tx, y + 32, (v.iban ?? '').replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim(), { size: 8, bold: true, color: C.ink });
  p.text(tx, y + 35.8, 'IBAN', { size: 7.5, color: C.grau });
  p.text(tx, y + 42, zweck, { size: 9, bold: true, color: C.ink });
  p.text(tx, y + 45.8, 'Verwendungszweck', { size: 7.5, color: C.grau });
  if (!bezahlt && b.zahlart !== 'LASTSCHRIFT') p.text(109, y + 58.5, 'GiroCode – funktioniert mit allen gängigen Banking-Apps', { size: 7, color: C.grau });
}

function tabellenkopf(p: Pdf, y0: number): number {
  const y = y0 + 7;
  const g = { size: 7, color: C.grau };
  p.text(23, y, 'POS', g);
  p.text(31, y, 'DATUM', g);
  p.text(52, y, 'POSITION', g);
  p.text(146, y, 'PREIS', { ...g, align: 'R' });
  p.text(164, y, 'ANZAHL', { ...g, align: 'R' });
  p.text(187, y, 'SUMME', { ...g, align: 'R' });
  p.line(22, y0 + 9.6, 188, y0 + 9.6, C.linie, 0.3);
  return y0 + 15.5;
}

export async function belegErzeugen(db: Db, v: Verein, rgnr: string) {
  const b = await belegLesen(db, rgnr);
  if (!b) throw new BusinessError(`Beleg ${rgnr} nicht gefunden.`);
  const pos = (await belegPosten(db, rgnr)).filter((p) => !p.storniert_am);
  const e = await empfaenger(db, b);
  return { beleg: b, pos, empfaenger: e, pdf: await belegPdf(v, b, e, pos) };
}

export type Schreiber = (fn: (tx: Db) => Promise<void>) => Promise<void>;

/**
 * PDF erzeugen und in Paperless ablegen (ohne Paperless: nur PDF). Ein vorhandenes Dokument bekommt nur mit
 * `neuVersion` eine neue Fassung (Kassieren, Zahlvermerk, Neudruck) – der reine Versand lädt nichts erneut hoch.
 */
export async function belegAblegen(db: Db, v: Verein, rgnr: string, benutzer: string, w: Schreiber, o: { neuVersion?: boolean } = {}) {
  const { beleg: b, pdf, empfaenger: e } = await belegErzeugen(db, v, rgnr);
  const warnungen: string[] = [];
  let docId = b.doc_id;
  if (plAktiv(v)) {
    const pl = paperless(v);
    const datei = `${rgnr}.pdf`;
    const werte = { rgnr, person: condense(`${e.nachname} ${e.vorname}`), art: b.art === 'GAST' ? 'Gastbeleg' : 'Sammelabrechnung', monat: b.monat ?? '', betrag: b.betrag, datum: b.datum, heute: heute(), benutzer, verein: v.name };
    if (docId && !o.neuVersion) {
      // vorhandene Fassung weiterverwenden
    } else if (docId) {
      const task = await pl.uploadVersion(docId, pdf, datei, `Neudruck ${dat(heute())}`);
      await pl.warteAufDokument(task, 15).catch(() => null);
      warnungen.push(...(await kontextAktualisieren(pl, K.verzehr, 'tco', docId, werte, { ohneNotiz: true })).warnungen);
    } else {
      const r = await kontextAblegen(pl, K.verzehr, 'tco', werte, pdf, datei, { benutzer });
      if (!r.id) throw new BusinessError('Hochgeladen, die Dokument-ID lag aber noch nicht vor – bitte in einer Minute erneut drucken.');
      docId = r.id;
      warnungen.push(...r.warnungen);
      await w(async (tx) => { await tx`update tco.vz_belege set doc_id = ${docId} where rgnr = ${rgnr}`; });
    }
  }
  return { pdf, docId, warnungen, beleg: b, empfaenger: e };
}

export function mailText(v: Verein, b: Beleg, e: Empfaenger) {
  const anrede = e.vorname || e.name;
  const betreff = `${belegTitel(b)} ${b.rgnr} – ${v.name}`;
  const text = b.status === 'BEZAHLT'
    ? [`Hallo ${anrede},`, '', `vielen Dank für deinen Besuch in unserem Clubhaus. Anbei dein Beleg ${b.rgnr} über ${betragText(b.betrag)} (bezahlt${b.zahlart ? ` per ${ZAHLART_TEXT[b.zahlart]}` : ''}).`, '', 'Viele Grüße', v.ansprechpartner ?? v.name]
    : b.zahlart === 'LASTSCHRIFT'
      ? [`Hallo ${anrede},`, '', `anbei deine Verzehrabrechnung ${b.rgnr} für den ${monatsname(b.monat ?? '')} über ${betragText(b.betrag)}. Der Betrag wird mit der nächsten Lastschrift eingezogen.`, '', 'Viele Grüße', v.ansprechpartner ?? v.name]
      : [`Hallo ${anrede},`, '', `anbei deine Verzehrabrechnung ${b.rgnr} für den ${monatsname(b.monat ?? '')} über ${betragText(b.betrag)} mit der Bitte um Überweisung bis zum ${dat(b.faellig)} auf unser Vereinskonto (Verwendungszweck: Verzehr ${b.rgnr}).`, '', 'Viele Grüße', v.ansprechpartner ?? v.name];
  return { betreff, text: text.join('\n') };
}

/** E-Mail mit dem Beleg als Anhang (n8n) */
export async function belegMailen(db: Db, v: Verein, rgnr: string, an: string | null, benutzer: string, w: Schreiber) {
  const r = await belegAblegen(db, v, rgnr, benutzer, w);
  const ziel = (an ?? r.empfaenger.email).trim();
  if (!ziel) throw new BusinessError('Keine E-Mail-Adresse vorhanden.');
  const { betreff, text } = mailText(v, r.beleg, r.empfaenger);
  const erg = await mailSenden(v, {
    modus: 'senden', anwendung: 'VERZEHR', objekt: rgnr, an: ziel, betreff, text, benutzer,
    anhaenge: [{ dateiname: `${rgnr}.pdf`, inhalt: r.pdf, paperless_root_id: r.docId ?? null, objekt: rgnr }],
  });
  if (erg.status === 'fehler') throw new BusinessError(`Versand fehlgeschlagen: ${erg.fehler ?? ''}`);
  await w(async (tx) => { await tx`update tco.vz_belege set versand_am = now(), versand_art = 'MAIL', email = coalesce(email, ${ziel}) where rgnr = ${rgnr}`; });
  return { text: `Beleg ${rgnr} per E-Mail an ${ziel} gesendet.`, warnungen: r.warnungen };
}

/** WhatsApp: Freigabelink aus Paperless (30 Tage) */
export async function belegWhatsapp(db: Db, v: Verein, rgnr: string, mobil: string | null, benutzer: string, w: Schreiber) {
  if (!plAktiv(v)) throw new BusinessError('Für den WhatsApp-Versand wird Paperless benötigt (Freigabelink).');
  const r = await belegAblegen(db, v, rgnr, benutzer, w);
  const nr = mobilnummer(mobil) || r.empfaenger.mobil;
  if (!nr) throw new BusinessError('Keine Mobilnummer vorhanden.');
  const pl = paperless(v);
  const link = await pl.freigabelink(await pl.neuesteVersion(r.docId!), 30);
  const b = r.beleg;
  const text = `Hallo ${r.empfaenger.vorname || r.empfaenger.name},\n\n${b.status === 'BEZAHLT' ? `danke für deinen Besuch im Clubhaus – hier dein Beleg ${rgnr} über ${betragText(b.betrag)}` : `hier deine Verzehrabrechnung ${rgnr} über ${betragText(b.betrag)}`}:\n${link}\n\nViele Grüße\n${v.name.replace(/ e\.V\.$/, '')}`;
  await w(async (tx) => { await tx`update tco.vz_belege set versand_am = now(), versand_art = 'WHATSAPP', mobil = coalesce(mobil, ${mobil}) where rgnr = ${rgnr}`; });
  return { url: whatsappLink(nr, text) };
}
