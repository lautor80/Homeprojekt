/**
 * Bankverbindung: IBAN auf Knopfdruck verproben und BIC/Kreditinstitut ermitteln; neues SEPA-Mandat anlegen.
 *
 * BIC und Kreditinstitut kommen – ohne Abfrage bei fremden Diensten, die IBAN verlässt das Portal nicht – aus
 *  1. dem Bankleitzahlen-Verzeichnis der Deutschen Bundesbank (tco.bankleitzahlen, als Datei geladen),
 *  2. ersatzweise aus dem eigenen Bestand: Bankverbindungen anderer Personen mit derselben Bankleitzahl.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import { csvParse, dekodieren } from '../../../../server/src/lib/sapcsv.js';
import { ibanGueltig, normalisieren } from '../../../../server/src/lib/sepa.js';
import type { Db } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { leer, mitgliedLesen, sepaAnlegen, verweis } from './logik.js';

export interface Blz { blz: string; bic: string | null; name: string; ort: string | null }

/**
 * Bankleitzahlendatei der Bundesbank lesen: Textdatei mit festen Spalten (168 Zeichen je Zeile) oder CSV mit Kopfzeile.
 * Je Bankleitzahl ein Eintrag – der bankleitzahlführende (Merkmal 1) bzw. der erste mit BIC; zur Löschung vorgemerkte entfallen.
 */
export function blzDateiLesen(datei: Buffer): Blz[] {
  const text = dekodieren(datei);
  const erste = text.split(/\r?\n/, 1)[0] ?? '';
  const roh: { blz: string; merkmal: string; name: string; ort: string; bic: string; loeschung: string }[] = [];
  if (erste.includes(';')) {
    const zeilen = csvParse(text, ';');
    const kopf = (zeilen.shift() ?? []).map((k) => k.trim().toLowerCase());
    const spalte = (...namen: string[]) => kopf.findIndex((k) => namen.some((n) => k === n || k.startsWith(n)));
    const s = { blz: spalte('bankleitzahl', 'blz'), merkmal: spalte('merkmal'), name: spalte('bezeichnung'), ort: spalte('ort'), bic: spalte('bic'), loeschung: spalte('bankleitzahllöschung', 'bankleitzahlloeschung') };
    if (s.blz < 0 || s.name < 0 || s.bic < 0) throw new BusinessError('Das ist keine Bankleitzahlendatei der Bundesbank (Spalten Bankleitzahl, Bezeichnung und BIC erwartet).');
    for (const z of zeilen) {
      roh.push({ blz: (z[s.blz] ?? '').trim(), merkmal: s.merkmal >= 0 ? (z[s.merkmal] ?? '').trim() : '1', name: z[s.name] ?? '', ort: s.ort >= 0 ? z[s.ort] ?? '' : '', bic: z[s.bic] ?? '', loeschung: s.loeschung >= 0 ? (z[s.loeschung] ?? '').trim() : '0' });
    }
  } else {
    for (const l of text.split(/\r?\n/)) {
      if (l.length < 150) continue;
      roh.push({ blz: l.slice(0, 8), merkmal: l.slice(8, 9), name: l.slice(9, 67), ort: l.slice(72, 107), bic: l.slice(139, 150), loeschung: l.slice(159, 160) });
    }
  }
  const out = new Map<string, Blz>();
  for (const r of roh) {
    if (!/^\d{8}$/.test(r.blz) || r.loeschung === '1') continue;
    const e: Blz = { blz: r.blz, bic: normalisieren(r.bic) || null, name: condense(r.name), ort: condense(r.ort) || null };
    if (!e.name) continue;
    const alt = out.get(r.blz);
    if (!alt || (!alt.bic && e.bic) || (r.merkmal === '1' && e.bic)) out.set(r.blz, e);
  }
  if (!out.size) throw new BusinessError('Die Datei enthält keine Bankleitzahlen. Bitte die Bankleitzahlendatei der Bundesbank (Text oder CSV) laden.');
  return [...out.values()];
}

/** Verzeichnis vollständig ersetzen */
export async function blzImport(tx: Db, eintraege: Blz[]): Promise<string> {
  await tx`delete from tco.bankleitzahlen`;
  for (let i = 0; i < eintraege.length; i += 1000) {
    const t = eintraege.slice(i, i + 1000);
    await tx`insert into tco.bankleitzahlen (blz, bic, name, ort)
             select * from unnest(${t.map((e) => e.blz)}::text[], ${t.map((e) => e.bic)}::text[], ${t.map((e) => e.name)}::text[], ${t.map((e) => e.ort)}::text[])`;
  }
  return `Bankleitzahlen-Verzeichnis geladen: ${eintraege.length} Kreditinstitute, ${eintraege.filter((e) => e.bic).length} mit BIC.`;
}

export async function blzStand(db: Db): Promise<{ anzahl: number; stand: string | null }> {
  const [r] = await db`select count(*)::int as n, max(importiert_am)::date::text as d from tco.bankleitzahlen`;
  return { anzahl: Number(r?.n ?? 0), stand: r?.d ?? null };
}

export interface IbanPruefung {
  gueltig: boolean;
  /** normalisierte IBAN ohne Leerzeichen */
  iban: string;
  /** IBAN in Viererblöcken */
  anzeige: string;
  blz: string | null; bic: string | null; bank: string | null;
  /** Herkunft von BIC/Kreditinstitut */
  quelle: 'VERZEICHNIS' | 'BESTAND' | null;
  text: string;
  /** Anzahl Einträge im Bankleitzahlen-Verzeichnis (0 = noch nicht geladen) */
  verzeichnis: number;
}

/** IBAN verproben (Länge je Land, Prüfziffer) und zu deutschen IBANs BIC und Kreditinstitut ermitteln */
export async function ibanPruefen(db: Db, eingabe: string): Promise<IbanPruefung> {
  const iban = normalisieren(eingabe);
  const { anzahl } = await blzStand(db);
  const basis = { iban, anzeige: iban.replace(/(.{4})/g, '$1 ').trim(), blz: null, bic: null, bank: null, quelle: null, verzeichnis: anzahl };
  if (!iban) return { ...basis, gueltig: false, text: 'Bitte eine IBAN eingeben.' };
  if (!ibanGueltig(iban)) {
    const grund = !/^[A-Z]{2}[0-9]{2}/.test(iban) ? 'Sie muss mit Länderkennzeichen und zwei Prüfziffern beginnen (z. B. DE12 …).'
      : iban.startsWith('DE') && iban.length !== 22 ? `Eine deutsche IBAN hat 22 Stellen, eingegeben sind ${iban.length}.`
        : 'Die Prüfziffer passt nicht – bitte auf Zahlendreher prüfen.';
    return { ...basis, gueltig: false, text: `Die IBAN ist ungültig. ${grund}` };
  }
  if (!iban.startsWith('DE')) return { ...basis, gueltig: true, text: 'Die IBAN ist gültig. BIC und Kreditinstitut werden nur für deutsche IBANs ermittelt – bitte von Hand eintragen.' };
  const blz = iban.slice(4, 12);
  const [v] = await db`select bic, name, ort from tco.bankleitzahlen where blz = ${blz}`;
  if (v) {
    const bank = condense(`${v.name}${leer(v.ort) && !String(v.name).includes(leer(v.ort)) ? `, ${leer(v.ort)}` : ''}`);
    return { ...basis, gueltig: true, blz, bic: leer(v.bic) || null, bank, quelle: 'VERZEICHNIS', text: `Die IBAN ist gültig: ${bank}${leer(v.bic) ? ` (BIC ${leer(v.bic)})` : ''}.` };
  }
  // eigener Bestand: häufigste Angabe zu derselben Bankleitzahl
  const [b] = await db`
    select upper(replace(bic1, ' ', '')) as bic, max(bank1) as bank, count(*)::int as n from tco.mitglieder
     where upper(replace(iban1, ' ', '')) like ${`DE__${blz}%`} and coalesce(bic1, '') <> ''
     group by 1 order by n desc, 1 limit 1`;
  if (b) {
    return { ...basis, gueltig: true, blz, bic: leer(b.bic), bank: leer(b.bank) || null, quelle: 'BESTAND', text: `Die IBAN ist gültig. BIC${leer(b.bank) ? ' und Kreditinstitut' : ''} aus dem Mitgliederbestand übernommen (Bankleitzahl ${blz}) – bitte kurz prüfen.` };
  }
  return {
    ...basis, gueltig: true, blz,
    text: anzahl ? `Die IBAN ist gültig. Die Bankleitzahl ${blz} steht nicht im Bankleitzahlen-Verzeichnis – BIC und Kreditinstitut bitte von Hand eintragen oder das Verzeichnis aktualisieren.`
      : `Die IBAN ist gültig. BIC und Kreditinstitut konnten nicht ermittelt werden: Das Bankleitzahlen-Verzeichnis ist noch nicht geladen (Bankleitzahl ${blz}).`,
  };
}

/**
 * Neues SEPA-Mandat für den Zahler des Mitglieds (abweichender Zahler, sonst das Mitglied selbst).
 * Voraussetzung: Zahlungsart Lastschrift und eine gültige IBAN; ein aktives Mandat wird nicht ersetzt.
 */
export async function sepaNeu(tx: Db, adrnr: string, datum: string | null): Promise<{ text: string; mandat: string }> {
  const m = await mitgliedLesen(tx, adrnr);
  if (leer(m.zahlungsart) !== 'L') throw new BusinessError('Ein SEPA-Mandat gibt es nur bei Zahlungsart Lastschrift – bitte zuerst die Bankverbindung anpassen.');
  const zahler = verweis(m.adrnrkih) || adrnr;
  const [z] = await tx`select adrnr, vorname, nachname, mitglnrn, iban1, mandatsrefenz from tco.mitglieder where adrnr = ${zahler}`;
  if (!z) throw new BusinessError('Der abweichende Zahler existiert nicht mehr – bitte die Bankverbindung prüfen.');
  const iban = normalisieren(leer(z.iban1) || leer(m.iban1));
  if (!iban) throw new BusinessError('Für das SEPA-Mandat fehlt die IBAN – bitte zuerst die Bankverbindung erfassen.');
  if (!ibanGueltig(iban)) throw new BusinessError('Die hinterlegte IBAN ist ungültig – bitte zuerst die Bankverbindung korrigieren.');
  const name = condense(`${leer(z.vorname)} ${leer(z.nachname)}`);
  const basis = leer(z.mandatsrefenz) || (leer(z.mitglnrn) ? `${Number(zahler)}${leer(z.mitglnrn)}` : String(Number(zahler)));
  const tag = datum || heute();
  const r = await sepaAnlegen(tx, zahler, basis, tag);
  if (!r.neu) throw new BusinessError(`Für ${name} besteht bereits ein aktives SEPA-Mandat (${r.mandatsnr}). Ein neues Mandat ist erst möglich, wenn das bestehende beendet ist.`);
  await tx`update tco.mitglieder set mandatsrefenz = coalesce(nullif(mandatsrefenz, ''), ${basis}) where adrnr = ${zahler}`;
  return {
    mandat: r.mandatsnr,
    text: `SEPA-Mandat ${r.mandatsnr} für ${name}${zahler === adrnr ? '' : ' (Zahler)'} zum ${dat(tag)} angelegt. Das Formular zur Unterschrift: Unterlage „SEPA-Lastschriftmandat“.`,
  };
}
