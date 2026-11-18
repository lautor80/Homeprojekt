import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateityp, typAusInhalt, typAusName } from '../src/lib/dateityp.js';

const b = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

test('Dateityp: Inhalt vor geliefertem Typ – PDF mit application/octet-stream wird application/pdf', () => {
  const pdf = b('%PDF-1.7\n%âãÏÓ\n1 0 obj');
  assert.equal(dateityp('300042946-9747702438088-0-POD-D58VUO00.PDF', 'application/octet-stream', pdf), 'application/pdf');
  assert.equal(dateityp('ohne-endung', null, pdf), 'application/pdf');
  assert.equal(dateityp('scan.pdf', 'image/png', pdf), 'application/pdf', 'falscher Typ der Mail wird korrigiert');
  // PDF-Kopf nach Vorspann (innerhalb der ersten 1024 Bytes)
  assert.equal(typAusInhalt(b(`${' '.repeat(500)}%PDF-1.4`)), 'application/pdf');
  assert.equal(typAusInhalt(b(`${' '.repeat(1100)}%PDF-1.4`)), null);
});

test('Dateityp: Bilder an der Signatur', () => {
  assert.equal(typAusInhalt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(typAusInhalt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(typAusInhalt(b('GIF89a....')), 'image/gif');
  assert.equal(typAusInhalt(b('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(typAusInhalt(new Uint8Array([0x49, 0x49, 0x2a, 0x00])), 'image/tiff');
});

test('Dateityp: ohne Signatur gelieferter Typ (wenn aussagekräftig), sonst Endung', () => {
  const t = b('Hallo');
  assert.equal(dateityp('x.bin', 'message/delivery-status', t), 'message/delivery-status');
  assert.equal(dateityp('a.txt', 'text/plain; charset=utf-8', t), 'text/plain');
  assert.equal(dateityp('Rechnung.XLSX', 'application/octet-stream', t), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(dateityp('Rechnung.PDF', 'binary/octet-stream', null), 'application/pdf', 'ohne Inhalt: Endung');
  assert.equal(dateityp('x', '', t), 'application/octet-stream');
  assert.equal(typAusName('foto.JPEG'), 'image/jpeg');
  assert.equal(typAusName('ohne'), null);
});
