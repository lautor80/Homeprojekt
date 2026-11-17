/**
 * Euroflex Sammelversand „Versenden…“ – Regeln ohne Datenbank (modules/transport/server/sammelversand-logik.ts):
 * eine E-Mail je Auftrag und Empfänger, Transportauftrag je Fahrt an deren Unternehmer, Rechnung nur einmal je Rechnungsnummer,
 * Mailtexte aus den Vorlagen, Modus je E-Mail, EML-Aufbau. Vertrag: docs/euroflex-mailworkflows.md, „Ausgang (Sammelversand)“.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anrede, artenOrdnen, emlBauen, emlDateiname, mailsPlanen, mailtext, modusFuer, schluesselBilden,
  type Empfaenger, type MailtextVorlage, type VersandDokument,
} from '../../modules/transport/server/sammelversand-logik.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const adr = (adrnr: number, email: string | null, x: Partial<Empfaenger> = {}): Empfaenger => ({
  adrnr, kundenname: `Firma ${adrnr}`, email, land: 'DE', anrede: null, vorname: null, name: null, ...x,
});
const KUNDE = adr(980001, 'einkauf@kunde.example');
const U1 = adr(980002, 'dispo@spedition1.example');
const U2 = adr(980003, 'dispo@spedition2.example');
const RE = adr(980004, 'rechnung@zentrale.example');

const VORLAGEN: MailtextVorlage[] = [
  { art: 'T', sprache: 'D', text: '{ANREDE},\nanbei Transportauftrag {AUFTRAG}.' },
  { art: 'L', sprache: 'D', text: '{ANREDE},\nanbei Lieferschein {AUFTRAG}.' },
  { art: 'R', sprache: 'D', text: '{ANREDE},\nanbei Rechnung {RECHNUNG} zu {AUFTRAG}.' },
  { art: 'T', sprache: 'E', text: '{ANREDE},\nplease find transport order {AUFTRAG}.' },
];

const T = (nr: string, u: Empfaenger | null, fahrt?: number): VersandDokument =>
  ({ auftragsnr: nr, art: 'T', ...(fahrt ? { fahrt } : {}), kennung: fahrt ? `${nr}-${fahrt}` : nr, faktura: null, empfaenger: u });
const L = (nr: string, k: Empfaenger | null): VersandDokument => ({ auftragsnr: nr, art: 'L', kennung: nr, faktura: null, empfaenger: k });
const R = (nr: string, f: string, e: Empfaenger | null): VersandDokument => ({ auftragsnr: nr, art: 'R', kennung: f, faktura: f, empfaenger: e });

test('eine E-Mail je Auftrag und Empfänger: T an Unternehmer, L an Kunde getrennt', () => {
  const m = mailsPlanen([T('2099_8001', U1), L('2099_8001', KUNDE)], VORLAGEN);
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x) => [x.schluessel, x.rolle, x.an, x.arten]), [
    ['2099_8001||unternehmer', 'unternehmer', U1.email, ['T']],
    ['2099_8001||kunde', 'kunde', KUNDE.email, ['L']],
  ]);
});

test('Arten an denselben Empfänger desselben Auftrags werden zusammengefasst (Betreff/Text der ersten Art)', () => {
  const m = mailsPlanen([L('2099_8002', KUNDE), R('2099_8002', '2099_R001', KUNDE)], VORLAGEN);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].arten, ['L', 'R']);
  assert.equal(m[0].dokumente.length, 2);
  assert.equal(m[0].betreff, 'Lieferschein 2099_8002');
  assert.equal(m[0].schluessel, '2099_8002||kunde');
  // gleiche Adresse unabhängig von Groß-/Kleinschreibung
  const m2 = mailsPlanen([L('2099_8002', KUNDE), R('2099_8002', '2099_R001', { ...RE, email: 'EINKAUF@kunde.example' })], VORLAGEN);
  assert.equal(m2.length, 1);
});

test('gleicher Empfänger in verschiedenen Aufträgen: getrennte E-Mails', () => {
  const m = mailsPlanen([L('2099_8003', KUNDE), L('2099_8004', KUNDE)], VORLAGEN);
  assert.deepEqual(m.map((x) => x.schluessel), ['2099_8003||kunde', '2099_8004||kunde']);
});

test('Transportauftrag je Fahrt an deren Unternehmer; gleicher Unternehmer für zwei Fahrten → eine E-Mail mit beiden PDFs', () => {
  const m = mailsPlanen([T('2099_8005', U1, 1), T('2099_8005', U2, 2), T('2099_8005', U1, 3)], VORLAGEN);
  assert.equal(m.length, 2);
  assert.equal(m[0].schluessel, '2099_8005|1|unternehmer');
  assert.equal(m[0].fahrt, 1);
  assert.deepEqual(m[0].dokumente.map((d) => d.kennung), ['2099_8005-1', '2099_8005-3']);
  assert.equal(m[0].betreff, 'Transportauftrag 2099_8005-1');
  assert.equal(m[1].schluessel, '2099_8005|2|unternehmer');
  assert.equal(m[1].an, U2.email);
});

test('Rechnung an den Rechnungsempfänger; Sammelrechnung nur einmal (beim ersten Auftrag)', () => {
  const m = mailsPlanen([R('2099_8006', '2099_R002', RE), R('2099_8007', '2099_R002', RE), R('2099_8008', '2099_R003', KUNDE)], VORLAGEN);
  assert.deepEqual(m.map((x) => [x.auftragsnr, x.rolle, x.an, x.betreff]), [
    ['2099_8006', 'rechnungsempfaenger', RE.email, 'Rechnung 2099_R002'],
    ['2099_8008', 'rechnungsempfaenger', KUNDE.email, 'Rechnung 2099_R003'],
  ]);
  assert.match(m[0].text, /Rechnung 2099_R002 zu 2099_8006/);
});

test('ohne E-Mail-Adresse: leeres An, Dokumente nur mit gleicher Adressnummer zusammen', () => {
  const ohne = adr(980005, null);
  const m = mailsPlanen([L('2099_8009', ohne), R('2099_8009', '2099_R004', ohne), T('2099_8009', null)], VORLAGEN);
  assert.equal(m.length, 2);
  assert.equal(m[0].an, '');
  assert.deepEqual(m[0].arten, ['L', 'R']);
  assert.equal(m[1].empfaenger, null);
});

test('Schlüssel sind eindeutig und deterministisch', () => {
  const docs = [T('2099_8010', U1, 1), T('2099_8010', U2, 2), L('2099_8010', KUNDE), R('2099_8010', '2099_R005', RE)];
  const a = mailsPlanen(docs, VORLAGEN).map((x) => x.schluessel);
  const b = mailsPlanen(docs, VORLAGEN).map((x) => x.schluessel);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.equal(schluesselBilden('2099_8010', undefined, 'kunde'), '2099_8010||kunde');
});

test('Mailtext: Anrede und Sprache wie POST /mails', () => {
  assert.equal(anrede(adr(1, 'a@b.de', { anrede: 'Herr', vorname: 'Max', name: 'Muster' })), 'Sehr geehrter Herr Max Muster');
  assert.equal(anrede(adr(1, 'a@b.de', { anrede: 'Frau', vorname: '', name: 'Beispiel' })), 'Sehr geehrte Frau Beispiel');
  assert.equal(anrede(adr(1, 'a@b.de')), 'Sehr geehrte Damen und Herren');
  assert.equal(anrede(adr(1, 'a@b.pl', { land: 'PL' })), 'Dear Sir or Madam');
  const t = mailtext(T('2099_8011', adr(1, 'a@b.pl', { land: 'PL' }), 2), VORLAGEN);
  assert.equal(t.betreff, 'Transportauftrag 2099_8011-2');
  assert.equal(t.text, 'Dear Sir or Madam,\nplease find transport order 2099_8011-2.');
  // fehlende Vorlage: leerer Text, Betreff bleibt
  assert.equal(mailtext(L('2099_8011', adr(1, 'a@b.pl', { land: 'PL' })), VORLAGEN).text, '');
});

test('Modus: erste Art, „senden“ nur wenn erlaubt und nicht „nur Entwürfe“', () => {
  const e = { T: { modus: 'senden' as const }, L: { modus: 'entwurf' as const }, R: { modus: 'senden' as const } };
  assert.equal(modusFuer(['T'], e, true), 'senden');
  assert.equal(modusFuer(['L', 'R'], e, true), 'entwurf');
  assert.equal(modusFuer(['R', 'L'], e, true), 'senden');
  assert.equal(modusFuer(['T'], e, false), 'entwurf');
  assert.equal(modusFuer(['T'], e, true, true), 'entwurf');
  assert.equal(modusFuer([], e, true), 'entwurf');
});

test('Arten in fester Reihenfolge ohne Doppelte', () => {
  assert.deepEqual(artenOrdnen(['R', 'T', 'R']), ['T', 'R']);
});

test('EML: Entwurf mit X-Unsent, Umlaute im Betreff kodiert, Anhänge base64', () => {
  const eml = emlBauen({
    an: 'a@b.de', cc: 'c@d.de', betreff: 'Lieferschein Größe', text: 'Zeile 1\nZeile 2',
    anhaenge: [{ name: 'Lieferschein_2099_8012.pdf', mime: 'application/pdf', daten: new Uint8Array([37, 80, 68, 70]) }],
  }, 'GRENZE');
  assert.match(eml, /^To: a@b\.de\r\nCc: c@d\.de\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\nX-Unsent: 1\r\n/);
  assert.ok(eml.includes('Content-Type: multipart/mixed; boundary="GRENZE"'));
  assert.ok(eml.includes(Buffer.from('Zeile 1\r\nZeile 2').toString('base64')));
  assert.ok(eml.includes('Content-Disposition: attachment; filename="Lieferschein_2099_8012.pdf"'));
  assert.ok(eml.includes('JVBERg=='));
  assert.ok(eml.endsWith('--GRENZE--\r\n'));
  const betreff = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(eml)![1];
  assert.equal(Buffer.from(betreff, 'base64').toString('utf8'), 'Lieferschein Größe');
  // ohne CC keine Cc-Zeile
  assert.ok(!emlBauen({ an: '', betreff: 'x', text: '', anhaenge: [] }).includes('Cc:'));
});

test('EML-Dateinamen eindeutig und ohne unzulässige Zeichen', () => {
  const v = new Set<string>();
  assert.equal(emlDateiname('Rechnung 2099/R1', v), 'Rechnung 2099_R1.eml');
  assert.equal(emlDateiname('Rechnung 2099/R1', v), 'Rechnung 2099_R1 (2).eml');
  assert.equal(emlDateiname('', v), 'E-Mail.eml');
});

test('Logik-Datei ist rein (keine Datenbank, kein Fastify, kein zod)', () => {
  const src = readFileSync(path.join(ROOT, 'modules/transport/server/sammelversand-logik.ts'), 'utf8');
  assert.ok(!/^import /m.test(src), 'sammelversand-logik.ts importiert nichts');
});

test('Routen des Sammelversands sind angemeldet und hängen am Funktionsschalter', () => {
  const src = readFileSync(path.join(ROOT, 'modules/transport/server/sammelversand.ts'), 'utf8');
  const fn = readFileSync(path.join(ROOT, 'modules/transport/server/funktionen.ts'), 'utf8');
  for (const [m, p] of [['post', '/versand/vorschau'], ['post', '/versand/ausfuehren'], ['post', '/versand/eml'], ['get', '/versand/einstellungen']]) {
    assert.ok(src.includes(`app.${m}('${p}', { preHandler: requireAuth(P_VERSAND)`), `${m.toUpperCase()} ${p} mit Recht transport.versand:execute`);
    assert.ok(fn.includes(`'${m.toUpperCase()} ${p}'`), `${m.toUpperCase()} ${p} im Funktionsschalter transport.versand.sammel`);
  }
  // „senden“ prüft der Server: Funktion „Automatisch senden“ und Recht
  assert.ok(/funktionAktiv\(F_MW\.versandAutomatisch\) && can\(req, P_MW\.versandSenden\)/.test(src));
});
