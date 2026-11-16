/**
 * Euroflex: E-Mail aus Outlook (.eml) in den Auftrag ziehen – Zerlegen der E-Mail im Browser (modules/transport/web/eml.ts)
 * und Einbindung in die Ablage des Auftrags. Ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emlLesen, istEml, kopfDekodieren, parameter } from '../../modules/transport/web/eml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const enc = new TextEncoder();
const b64 = (s: string | Uint8Array) => Buffer.from(typeof s === 'string' ? enc.encode(s) : s).toString('base64').replace(/.{76}/g, '$&\r\n');
const text = (b: Uint8Array) => new TextDecoder().decode(b);
/** kleines PDF mit Bytes über 0x7F – prüft, dass Binärdaten unverfälscht bleiben */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x00, 0xff, 0x80]);

/** so, wie Outlook (neu/Web) eine E-Mail mit Signaturlogo, zwei Anhängen und weitergeleiteter Mail speichert */
const OUTLOOK = [
  'From: =?utf-8?Q?J=C3=BCrgen_M=C3=BCller?= <jm@example.com>',
  'To: dispo@example.com',
  'Subject: =?utf-8?B?TGllZmVyc2NoZWluIHVuZCBDTVIgZsO8cg==?=',
  ' =?utf-8?B?IEF1ZnRyYWcgMjAyNl8wMTUz?=',
  'Date: Mon, 16 Nov 2026 10:12:00 +0100',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed;',
  '\tboundary="_004_GRUEN_"',
  '',
  '--_004_GRUEN_',
  'Content-Type: multipart/related; boundary="_003_BLAU_"; type="multipart/alternative"',
  '',
  '--_003_BLAU_',
  'Content-Type: multipart/alternative; boundary="_000_ROT_"',
  '',
  '--_000_ROT_',
  'Content-Type: text/plain; charset="iso-8859-1"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hallo, anbei der Lieferschein f=FCr den Auftrag.',
  '',
  '--_000_ROT_',
  'Content-Type: text/html; charset="iso-8859-1"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Hallo</p><img src=3D"cid:image001.png@01DB">',
  '',
  '--_000_ROT_--',
  '',
  '--_003_BLAU_',
  'Content-Type: image/png; name="image001.png"',
  'Content-Description: image001.png',
  'Content-Disposition: inline; filename="image001.png"; size=4',
  'Content-ID: <image001.png@01DB>',
  'Content-Transfer-Encoding: base64',
  '',
  b64('LOGO'),
  '',
  '--_003_BLAU_--',
  '',
  '--_004_GRUEN_',
  'Content-Type: application/pdf; name="=?utf-8?B?TGllZmVyc2NoZWluIDIwMjZfMDE1My5wZGY=?="',
  'Content-Description: Lieferschein',
  'Content-Disposition: attachment;',
  '\tfilename="=?utf-8?B?TGllZmVyc2NoZWluIDIwMjZfMDE1My5wZGY=?="; size=17',
  'Content-Transfer-Encoding: base64',
  '',
  b64(PDF),
  '',
  '--_004_GRUEN_',
  'Content-Type: image/jpeg; name="CMR.jpg"',
  "Content-Disposition: attachment; filename*=utf-8''CMR%20R%C3%BCckseite.jpg",
  'Content-Transfer-Encoding: base64',
  '',
  b64('JPEGDATEN'),
  '',
  '--_004_GRUEN_',
  'Content-Type: message/rfc822',
  'Content-Disposition: attachment; filename="AW: Abholung.eml"',
  '',
  'From: a@example.com',
  'Subject: AW: Abholung',
  '',
  'Weitergeleitet.',
  '',
  '--_004_GRUEN_',
  'Content-Type: application/ms-tnef; name="winmail.dat"',
  'Content-Disposition: attachment; filename="winmail.dat"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('TNEF'),
  '',
  '--_004_GRUEN_--',
  '',
].join('\r\n');

const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

test('Outlook-E-Mail: Anhänge mit Namen und Inhalt, Signaturbild und winmail.dat übersprungen', () => {
  const m = emlLesen(bytes(OUTLOOK));
  assert.equal(m.betreff, 'Lieferschein und CMR für Auftrag 2026_0153');
  assert.equal(m.von, 'Jürgen Müller <jm@example.com>');
  assert.equal(m.datum, 'Mon, 16 Nov 2026 10:12:00 +0100');
  assert.deepEqual(m.anhaenge.map((a) => a.name), ['Lieferschein 2026_0153.pdf', 'CMR Rückseite.jpg', 'AW_ Abholung.eml']);
  assert.deepEqual([...m.anhaenge[0].daten], [...PDF], 'Binärdaten unverfälscht');
  assert.equal(m.anhaenge[0].typ, 'application/pdf');
  assert.equal(text(m.anhaenge[1].daten), 'JPEGDATEN');
  assert.match(text(m.anhaenge[2].daten), /^From: a@example\.com\r\nSubject: AW: Abholung\r\n\r\nWeitergeleitet\.\r\n$/, 'weitergeleitete E-Mail bleibt eine .eml');
  assert.equal(m.eingebettet, 1);
});

test('E-Mail ohne Anhänge, Mail nur aus einem Anhang, gleiche Namen, Anhang ohne Namen, LF-Zeilenenden', () => {
  assert.equal(emlLesen(bytes('Subject: Hallo\r\nContent-Type: text/plain\r\n\r\nNur Text')).anhaenge.length, 0);

  const einzeln = emlLesen(bytes(`Subject: Scan\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}\r\n`));
  assert.deepEqual(einzeln.anhaenge.map((a) => a.name), ['Anhang 1.pdf']);
  assert.deepEqual([...einzeln.anhaenge[0].daten], [...PDF]);

  const doppelt = [
    'Subject: Fotos', 'Content-Type: multipart/mixed; boundary=XYZ', '',
    '--XYZ', 'Content-Type: text/plain', '', 'Text',
    '--XYZ', 'Content-Type: image/jpeg', 'Content-Disposition: attachment; filename=foto.jpg', 'Content-Transfer-Encoding: base64', '', b64('A'),
    '--XYZ', 'Content-Type: image/jpeg', 'Content-Disposition: attachment; filename=foto.jpg', 'Content-Transfer-Encoding: base64', '', b64('B'),
    '--XYZ', 'Content-Type: application/pdf', 'Content-Disposition: attachment', 'Content-Transfer-Encoding: base64', '', b64('C'),
    '--XYZ', 'Content-Type: text/plain; name="Notiz: wichtig?.txt"', 'Content-Transfer-Encoding: quoted-printable', '', 'Gr=C3=BC=C3=9Fe', '',
    '--XYZ--', 'Nachspann wird ignoriert', '',
  ].join('\n');
  const m = emlLesen(bytes(doppelt));
  assert.deepEqual(m.anhaenge.map((a) => a.name), ['foto.jpg', 'foto (2).jpg', 'Anhang 3.pdf', 'Notiz_ wichtig_.txt']);
  // die Leerzeile vor der Grenze gehört nach MIME zum Inhalt
  assert.deepEqual(m.anhaenge.map((a) => text(a.daten)), ['A', 'B', 'C', 'Grüße\n']);
});

test('Kopfzeilen: RFC 2047 (B/Q, ISO-8859-1), RFC 2231 mit Fortsetzungen, Erkennung der Datei', () => {
  assert.equal(kopfDekodieren('=?iso-8859-1?Q?R=FCcksendung_Pal?= =?iso-8859-1?Q?ette?='), 'Rücksendung Palette');
  assert.equal(kopfDekodieren('Re: =?UTF-8?B?w4RuZGVydW5n?= Termin'), 'Re: Änderung Termin');
  assert.equal(parameter('attachment; filename*0*=utf-8\'\'Lieferschein%20M; filename*1*=%C3%BCller.pdf', 'filename'), 'Lieferschein Müller.pdf');
  assert.equal(parameter('multipart/mixed; boundary="a;b"; charset=x', 'boundary'), 'a;b');
  assert.equal(parameter('text/plain', 'charset'), null);
  assert.ok(istEml({ name: 'Auftrag.EML', type: '' }));
  assert.ok(istEml({ name: 'nachricht', type: 'message/rfc822' }));
  assert.ok(!istEml({ name: 'Auftrag.msg', type: 'application/vnd.ms-outlook' }));
});

test('Auftrag → Dokumente: E-Mails werden zerlegt, die .eml selbst nur im Ablageordner', () => {
  const q = readFileSync(path.join(ROOT, 'modules/transport/web/AuftragDokumente.tsx'), 'utf8');
  assert.ok(q.includes("import { emlLesen, istEml } from './eml';"));
  assert.ok(q.includes('if (!istEml(f)) { files.push(f); continue; }'));
  assert.ok(q.includes('if (d?.paperless && !nurOrdner.has(f))'), 'Paperless bekommt nur die Anhänge');
  assert.ok(q.includes('eine E-Mail aus Outlook (.eml) wird zerlegt'), 'Hinweis auf der Ablagefläche');
});
