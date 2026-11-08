/** Preisaufschlüsselung über mehrere Preisklassen (Anzeige in Buchungsmaske und „Meine Buchungen“) */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgres://localhost/test';
const { preisBerechnen } = await import('../../modules/tco/server/halle/preis.js');

test('Buchung über zwei Preisklassen: Abschnitte mit Dauer, Stundenpreis und Betrag', () => {
  const tage = ['MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG'];
  const preise = {
    produkte: [
      { prod_key: '005', valid_from: '2020-01-01', valid_to: '9999-12-31', text: 'Tagespreis', preis: 15, typ: null, menge: null },
      { prod_key: '006', valid_from: '2020-01-01', valid_to: '9999-12-31', text: 'Abendpreis', preis: 20, typ: null, menge: null },
    ],
    matrix: tage.flatMap((tag) => [
      { prod_key: '005', valid_from: '2020-01-01', valid_to: '9999-12-31', tag, zeit_von: '07:00:00', zeit_bis: '17:00:00' },
      { prod_key: '006', valid_from: '2020-01-01', valid_to: '9999-12-31', tag, zeit_von: '17:00:00', zeit_bis: '23:00:00' },
    ]),
  };
  const r = preisBerechnen({ datum: '2026-11-10', time_start: '16:00', time_ende: '17:30', status: '1' }, preise);
  assert.equal(r.fehler, null);
  assert.equal(r.betrag, 25);
  assert.deepEqual(r.teile, [
    { prodKey: '005', text: 'Tagespreis', von: '16:00', bis: '17:00', minuten: 60, stundenpreis: 15, betrag: 15 },
    { prodKey: '006', text: 'Abendpreis', von: '17:00', bis: '17:30', minuten: 30, stundenpreis: 20, betrag: 10 },
  ]);
  const e = preisBerechnen({ datum: '2026-11-10', time_start: '18:00', time_ende: '19:30', status: '1' }, preise);
  assert.equal(e.teile!.length, 1);
  assert.equal(e.betrag, 30);
});
