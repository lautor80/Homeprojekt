/** Preisaufschlüsselung über mehrere Preisklassen (Anzeige in Buchungsmaske und „Meine Buchungen“) */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgres://localhost/test';
const { preisBerechnen, preiszonen, preiswoche } = await import('../../modules/tco/server/halle/preis.js');

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

test('Preiszonen im Tagesverlauf: Einzelpreise des Wochentags, Sommer/Winter, Lücken und Gültigkeit', () => {
  const immer = { valid_from: '2020-01-01', valid_to: '9999-12-31' };
  const preise = {
    produkte: [
      { prod_key: '005', ...immer, text: 'Tagespreis', preis: 15, typ: null, menge: null },
      { prod_key: '006', ...immer, text: ' Abendpreis ', preis: 20, typ: null, menge: null },
      { prod_key: '007', valid_from: '2020-01-01', valid_to: '2025-12-31', text: 'Alt', preis: 99, typ: null, menge: null },
      { prod_key: '010', ...immer, text: null, preis: 8, typ: null, menge: null },
      { prod_key: '001', ...immer, text: 'Abo', preis: 12, typ: null, menge: null },
    ],
    matrix: [
      // Dienstag: Tagespreis 07–12 und 14–17 (Mittagspause ohne Preis), Abendpreis 17–24
      { prod_key: '005', ...immer, tag: 'DIENSTAG', zeit_von: '07:00:00', zeit_bis: '12:00:00' },
      { prod_key: '005', ...immer, tag: 'DIENSTAG', zeit_von: '14:00:00', zeit_bis: '17:00:00' },
      { prod_key: '006', ...immer, tag: 'DIENSTAG', zeit_von: '17:00:00', zeit_bis: '24:00:00' },
      { prod_key: '007', valid_from: '2020-01-01', valid_to: '2025-12-31', tag: 'DIENSTAG', zeit_von: '12:00:00', zeit_bis: '14:00:00' },
      { prod_key: '001', ...immer, tag: 'DIENSTAG', zeit_von: '07:00:00', zeit_bis: '23:00:00' },
      { prod_key: '006', ...immer, tag: 'MITTWOCH', zeit_von: '07:00:00', zeit_bis: '23:00:00' },
      { prod_key: '010', ...immer, tag: 'DIENSTAG', zeit_von: '08:00:00', zeit_bis: '22:00:00' },
    ],
  };
  // Winter, Dienstag 10.11.2026: abgelaufenes Produkt und Abo zählen nicht
  assert.deepEqual(preiszonen('2026-11-10', preise), [
    { prodKey: '005', text: 'Tagespreis', von: '07:00', bis: '12:00', stundenpreis: 15, farbe: 0 },
    { prodKey: '005', text: 'Tagespreis', von: '14:00', bis: '17:00', stundenpreis: 15, farbe: 0 },
    { prodKey: '006', text: 'Abendpreis', von: '17:00', bis: '24:00', stundenpreis: 20, farbe: 1 },
  ]);
  assert.deepEqual(preiszonen('2026-11-11', preise), [{ prodKey: '006', text: 'Abendpreis', von: '07:00', bis: '23:00', stundenpreis: 20, farbe: 1 }]);
  // Sommer, Dienstag 16.06.2026: eigener Einzelpreis; ohne Text der Schlüssel
  assert.deepEqual(preiszonen('2026-06-16', preise), [{ prodKey: '010', text: 'Preis 010', von: '08:00', bis: '22:00', stundenpreis: 8, farbe: 0 }]);
  // Tag ohne Preise
  assert.deepEqual(preiszonen('2026-11-12', preise), []);
  // Preisliste der Woche: Montag bis Sonntag, egal welcher Tag der Woche gefragt ist; Farbe = Position in der Preisgruppe
  for (const d of ['2026-11-09', '2026-11-12', '2026-11-15']) {
    const w = preiswoche(d, preise);
    assert.deepEqual(w.map((x) => x.datum), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    assert.deepEqual(w.map((x) => x.zonen.length), [0, 3, 1, 0, 0, 0, 0]);
  }
});
