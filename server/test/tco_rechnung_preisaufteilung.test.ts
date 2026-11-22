/** Hallenrechnung: Buchung über mehrere Preisklassen als Aufteilung in der Position statt Durchschnittspreis */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgres://localhost/test';
const { positionAufteilen } = await import('../../modules/tco/server/halle/preis.js');
const { rechnungsBaum } = await import('../../modules/tco/server/platz/rechnungsbaum.js');

const immer = { valid_from: '2020-01-01', valid_to: '9999-12-31' };
const tage = ['MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG'];
const preise = (tag: number, abend: number) => ({
  produkte: [
    { prod_key: '005', ...immer, text: 'Einzel Winter Tag', preis: tag, typ: null, menge: null },
    { prod_key: '006', ...immer, text: 'Einzel Winter Abend', preis: abend, typ: null, menge: null },
  ],
  matrix: tage.flatMap((t) => [
    { prod_key: '005', ...immer, tag: t, zeit_von: '07:00:00', zeit_bis: '14:00:00' },
    { prod_key: '006', ...immer, tag: t, zeit_von: '14:00:00', zeit_bis: '23:00:00' },
  ]),
});
const pos = { datum: '2026-11-16', time_start: '13:00:00', time_ende: '14:30:00', prod_key: '005' };

test('Position über zwei Preisklassen: Stunden × Stundenpreis je Preisklasse, Summe = Positionsbetrag', () => {
  const teile = positionAufteilen({ ...pos, betrag: 20 }, preise(12, 16));
  assert.deepEqual(teile, [
    { text: 'Einzel Winter Tag', von: '13:00', bis: '14:00', stunden: 1, stundenpreis: 12, betrag: 12 },
    { text: 'Einzel Winter Abend', von: '14:00', bis: '14:30', stunden: 0.5, stundenpreis: 16, betrag: 8 },
  ]);
});

test('Rundungscent gehen an den größten Teil', () => {
  const p = preise(14.99, 10.01);
  const kurz = { ...pos, time_start: '13:40:00', time_ende: '14:20:00' };
  // 20 min × 14,99 = 4,9967 · 20 min × 10,01 = 3,3367 · gesamt 8,3333 → 8,33
  const teile = positionAufteilen({ ...kurz, betrag: 8.33 }, p)!;
  assert.deepEqual(teile.map((t) => t.betrag), [4.99, 3.34]);
  assert.equal(Math.round(teile.reduce((s, t) => s + t.betrag, 0) * 100) / 100, 8.33);
});

test('keine Aufteilung: eine Preisklasse, geänderte Preise, manuelle Position', () => {
  assert.equal(positionAufteilen({ ...pos, time_start: '10:00:00', time_ende: '11:30:00', betrag: 18 }, preise(12, 16)), undefined);
  assert.equal(positionAufteilen({ ...pos, betrag: 19 }, preise(12, 16)), undefined, 'Preise seit der Zuordnung geändert');
  assert.equal(positionAufteilen({ ...pos, prod_key: '093', betrag: 20 }, preise(12, 16)), undefined);
  assert.equal(positionAufteilen({ ...pos, prod_key: null, betrag: 20 }, preise(12, 16)), undefined);
});

test('Meine Rechnungen und PDF zeigen die Aufteilung statt des Durchschnitts', () => {
  const teile = positionAufteilen({ ...pos, betrag: 20 }, preise(12, 16))!;
  const basis = { rgpos: 1, bid: 'B1', ...pos, art: 'Einzel', beschreibung: 'Einzelbuchung\tMontag\t16.11.2026\t13:00 - 14:30 Uhr', anzahl: 1.5,
    ep: 13.33, betrag: 20, storno: false, manuell: false, konto: '4000', konto_name: '' };
  const [g] = rechnungsBaum([{ ...basis, teile }]);
  assert.equal(g.positionen[0].menge, '1 Std. × 12,00 € + 0,5 Std. × 16,00 €');
  assert.equal(rechnungsBaum([basis])[0].positionen[0].menge, '1,5 Std. × 13,33 €', 'ohne Aufteilung wie bisher');

  const pdf = readFileSync(new URL('../../modules/tco/server/halle/pdf.ts', import.meta.url), 'utf8');
  assert.match(pdf, /if \(!teile\.length\) p\.text\(146, y, betragText\(ps\.ep\)/, 'kein Durchschnittspreis in der Hauptzeile');
  assert.match(pdf, /betragText\(tl\.stundenpreis\)/);
  const daten = readFileSync(new URL('../../modules/tco/server/halle/daten.ts', import.meta.url), 'utf8');
  assert.match(daten, /positionAufteilen\(\{ datum: p\.datum/);
});
