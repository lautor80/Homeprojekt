/**
 * Vermietung – Kostenerfassung mit Jahreswert: Umrechnung auf den Leistungszeitraum (je Monat 1/12, angebrochen tageweise)
 * oder auf einen Monat. Ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jahrAufMonat, jahrAufZeitraum, monate, monatZeitraum } from '../../modules/miete/web/jahreswert.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Monate im Zeitraum: volle Monate 1, angebrochene tageweise, Jahreswechsel', () => {
  assert.equal(monate('2026-01-01', '2026-12-31'), 12);
  assert.equal(monate('2026-10-01', '2026-12-31'), 3);
  assert.equal(monate('2026-02-01', '2026-02-28'), 1);
  assert.equal(monate('2026-10-01', '2026-10-30'), 30 / 31);
  assert.equal(monate('2026-11-16', '2027-01-31'), 15 / 30 + 2);
  assert.equal(monate('2026-05-01', '2026-04-30'), null, 'Ende vor Beginn');
  assert.equal(monate('', '2026-04-30'), null);
});

test('Jahreswert auf den Leistungszeitraum', () => {
  assert.equal(jahrAufZeitraum(1900, '2026-01-01', '2026-12-31'), 1900);
  assert.equal(jahrAufZeitraum(1900, '2026-10-01', '2026-12-31'), 475);
  assert.equal(jahrAufZeitraum(558, '2026-07-01', '2026-09-30'), 139.5);
  assert.equal(jahrAufZeitraum(1200, '2026-02-01', '2026-03-15'), 148.39, 'Februar voll + 15/31 März');
  assert.equal(jahrAufZeitraum(1200, '2026-03-01', ''), null);
});

test('Jahreswert auf einen Monat, Zeitraum = Kalendermonat', () => {
  assert.equal(jahrAufMonat(2000), 166.67);
  assert.equal(jahrAufMonat(480), 40);
  assert.deepEqual(monatZeitraum('2026-11-19'), { von: '2026-11-01', bis: '2026-11-30' });
  assert.deepEqual(monatZeitraum('2028-02-10'), { von: '2028-02-01', bis: '2028-02-29' });
});

test('Oberfläche: Jahreswert und Umrechnungsart im Kostendialog', () => {
  const s = readFileSync(path.join(ROOT, 'modules/miete/web/Kosten.tsx'), 'utf8');
  assert.ok(s.includes('label="Jahreswert"'));
  assert.ok(s.includes("key: 'zeitraum'") && s.includes("key: 'monat'"));
  assert.ok(s.includes('setF(rechne({ ...f, von: v }))') && s.includes('setF(rechne({ ...f, bis: v }))'), 'Datum ändern rechnet neu');
});
