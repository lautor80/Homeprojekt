/**
 * Kontakterkennung Euroflex (#158): eingefügter Text → Feldvorschläge. Reine Funktion, ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { kontaktErkennen, strasseTeilen } from '../../modules/transport/server/kontakterkennung.js';
import { bildart, bildText, pdfText } from '../src/lib/texterkennung.js';

/** Texterkennung nur prüfen, wo tesseract installiert ist (im Container; in der CI ohne tesseract übersprungen) */
const tesseract = (() => { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('E-Mail-Signatur: Firma, Ansprechpartner, Anschrift, Telefon/Fax, USt-IdNr.', () => {
  const r = kontaktErkennen(`Mit freundlichen Grüßen

Max Mustermann
Disposition

Spedition Mustermann GmbH & Co. KG
Industriestraße 12a
66649 Oberthal
Tel.: +49 6854 1234-0
Fax: +49 6854 1234-99
Mobil: 0171 1234567
E-Mail: Max.Mustermann@spedition-mustermann.example
www.spedition-mustermann.example
Geschäftsführer: Erika Mustermann · Amtsgericht Saarbrücken HRB 12345 · USt-IdNr.: DE 123456789`);
  assert.deepEqual(r.felder, {
    kundenname: 'Spedition Mustermann GmbH & Co. KG', vorname: 'Max', name: 'Mustermann', strasse: 'Industriestraße', hausnummer: '12a',
    plz: '66649', ort: 'Oberthal', land: 'DE', telefon: '+49 6854 1234-0', fax: '+49 6854 1234-99',
    email: 'max.mustermann@spedition-mustermann.example', ustid: 'DE123456789',
  });
  assert.ok(r.unklar.includes('Mobil: 0171 1234567'), 'Mobilnummer bleibt sichtbar');
  assert.ok(r.unklar.includes('Disposition'));
});

test('eine Zeile mit Trennern, Länderkennzeichen vor der PLZ', () => {
  const r = kontaktErkennen('Muster Logistik AG | Hafenstr. 5-7 | D-20457 Hamburg | Tel 040 123456 Fax 040 123457 | info@muster-logistik.example');
  assert.deepEqual(r.felder, {
    kundenname: 'Muster Logistik AG', strasse: 'Hafenstr.', hausnummer: '5-7', plz: '20457', ort: 'Hamburg', land: 'DE',
    telefon: '040 123456', fax: '040 123457', email: 'info@muster-logistik.example',
  });
  assert.deepEqual(r.unklar, []);
});

test('Impressum mit Kommas, Namenszusatz, Ansprechpartner mit Anrede und Titel, GLN', () => {
  const f = kontaktErkennen(`Beispiel Handels GmbH
Niederlassung Saar
Am Markt 3, 66606 St. Wendel, Deutschland
Telefon 06851 99887
Ansprechpartner: Frau Dr. Petra Probe
p.probe@beispiel-handel.example
GLN: 4012345000009`).felder;
  assert.equal(f.kundenname2, 'Niederlassung Saar');
  assert.deepEqual([f.anrede, f.vorname, f.name], ['Frau', 'Petra', 'Probe']);
  assert.deepEqual([f.strasse, f.hausnummer, f.plz, f.ort, f.land], ['Am Markt', '3', '66606', 'St. Wendel', 'DE']);
  assert.equal(f.gln, '4012345000009');
});

test('Ausland: Frankreich (Hausnummer vorn), Niederlande, Österreich', () => {
  let f = kontaktErkennen('Transports Dupont SARL\nMonsieur Jean Dupont\n12 rue de la Gare\nF-57000 Metz\nTél: +33 3 87 00 00 00\nj.dupont@dupont.example').felder;
  assert.deepEqual([f.strasse, f.hausnummer, f.plz, f.ort, f.land, f.anrede, f.name, f.telefon], ['rue de la Gare', '12', '57000', 'Metz', 'FR', 'Herr', 'Dupont', '+33 3 87 00 00 00']);
  f = kontaktErkennen('Van Dijk Transport B.V.\nt.a.v. Pieter van Dijk\nHavenweg 22\n3011 AB Rotterdam\nNederland\nT: +31 10 1234567').felder;
  assert.deepEqual([f.kundenname, f.vorname, f.name, f.plz, f.ort, f.land], ['Van Dijk Transport B.V.', 'Pieter', 'van Dijk', '3011 AB', 'Rotterdam', 'NL']);
  f = kontaktErkennen('Alpen Fracht GmbH\nz. Hd. Herrn Mag. Josef Huber\nBahnhofstraße 1/3\nA-6020 Innsbruck\nUID: ATU12345678').felder;
  assert.deepEqual([f.land, f.plz, f.hausnummer, f.ustid, f.anrede, f.vorname, f.name], ['AT', '6020', '1/3', 'ATU12345678', 'Herr', 'Josef', 'Huber']);
});

test('Visitenkarte (.vcf)', () => {
  const r = kontaktErkennen(`BEGIN:VCARD
VERSION:3.0
N:Beispiel;Hannes;;Herr;
FN:Hannes Beispiel
ORG:Beispiel Transporte GmbH;Fuhrpark
ADR;TYPE=WORK:;;Lindenstraße 7;Beispielstadt;;54321;Germany
TEL;TYPE=WORK,VOICE:+49 651 000000
TEL;TYPE=CELL:+49 151 0000000
TEL;TYPE=WORK,FAX:+49 651 000001
EMAIL;TYPE=INTERNET:hannes@beispiel.example
END:VCARD`);
  assert.deepEqual(r.felder, {
    kundenname: 'Beispiel Transporte GmbH', kundenname2: 'Fuhrpark', anrede: 'Herr', vorname: 'Hannes', name: 'Beispiel', strasse: 'Lindenstraße', hausnummer: '7',
    plz: '54321', ort: 'Beispielstadt', land: 'DE', telefon: '+49 651 000000', fax: '+49 651 000001', email: 'hannes@beispiel.example',
  });
  assert.deepEqual(r.unklar, ['Mobil: +49 151 0000000']);
});

test('Privatperson: Name wird auch Kontaktname; Fließtext ohne Kontaktdaten ergibt keinen Vorschlag', () => {
  const f = kontaktErkennen('Erika Musterfrau\nAhornweg 4\n12345 Musterhausen\n0151 2223344').felder;
  assert.deepEqual([f.kundenname, f.vorname, f.name, f.telefon], ['Erika Musterfrau', 'Erika', 'Musterfrau', '0151 2223344']);
  const r = kontaktErkennen('Hallo, wie geht es dir?\nBis morgen');
  assert.deepEqual(r.felder, {});
  assert.match(r.hinweise[0], /keine Kontaktdaten/);
});

test('Straße teilen und Feldlängen', () => {
  assert.deepEqual(strasseTeilen('Musterstraße 12 a'), { strasse: 'Musterstraße', hausnummer: '12 a' });
  assert.deepEqual(strasseTeilen('Industriegebiet Nord'), { strasse: 'Industriegebiet Nord' });
  const f = kontaktErkennen(`${'Sehr lange Firma '.repeat(6)}GmbH\nWeg 1\n54321 Ort`).felder;
  assert.equal(f.kundenname!.length, 60);
});

test('Unternehmensprofil aus einem Screenshot (Text wie von der Texterkennung, zweispaltig mit Symbolen)', () => {
  const r = kontaktErkennen(`TIMOCOM

Unternehmensprofil Details

Unternehmen                                                         TC ID: 123456         USt-IdNr.: BG123456789
Unternehmen                                                 @ www.balkansped.example
Balkan Sped Trans OOD                                     @ office@balkansped.example

@ +359880000000
B ST     Hausanschrift               ®-

blvd. Primerna 12
BG, 1220 Sofia`);
  assert.deepEqual(r.felder, {
    kundenname: 'Balkan Sped Trans OOD', strasse: 'blvd. Primerna', hausnummer: '12', plz: '1220', ort: 'Sofia', land: 'BG',
    ustid: 'BG123456789', email: 'office@balkansped.example', telefon: '+359880000000',
  });
  assert.ok(r.unklar.includes('TC ID: 123456'));
});

test('Bildart und PDF-Prüfung', async () => {
  assert.equal(bildart(readFileSync(new URL('./fixtures/kontakt-profil.png', import.meta.url))), 'png');
  assert.equal(bildart(Buffer.from('kein Bild')), null);
  await assert.rejects(bildText(Buffer.from('kein Bild')), /PNG oder JPEG/);
  await assert.rejects(pdfText(Buffer.from('kein PDF')), /kein PDF/);
});

test('Screenshot lesen: Texterkennung und Vorschlag der Felder', { skip: tesseract ? false : 'tesseract ist hier nicht installiert' }, async () => {
  const text = await bildText(readFileSync(new URL('./fixtures/kontakt-profil.png', import.meta.url)));
  const f = kontaktErkennen(text).felder;
  assert.deepEqual([f.kundenname, f.plz, f.ort, f.land, f.hausnummer, f.ustid, f.email, f.telefon],
    ['Balkan Sped Trans OOD', '1220', 'Sofia', 'BG', '12', 'BG123456789', 'office@balkansped.example', '+359880000000']);
});
