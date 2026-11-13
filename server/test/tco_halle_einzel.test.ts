/**
 * Vereinsübersicht, Halle: Einzelbuchungen je Tag, summiert auf Woche, Monat, Jahr (reine Rechenregeln, ohne Datenbank).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { einzelRaster, kalenderwoche, type EinzelTag } from '../../modules/tco/server/dashboard/halle-einzel.js';

const TAGE: EinzelTag[] = [
  { datum: '2023-12-30', anzahl: 9, stunden: 9 },
  { datum: '2024-01-01', anzahl: 2, stunden: 2.5 }, { datum: '2024-01-07', anzahl: 1, stunden: 1 }, { datum: '2024-01-08', anzahl: 3, stunden: 3 },
  { datum: '2024-02-29', anzahl: 4, stunden: 6 }, { datum: '2024-12-30', anzahl: 5, stunden: 5 }, { datum: '2024-12-31', anzahl: 1, stunden: 1.5 },
];

test('Einzelbuchungen je Tag: lückenlos über das Jahr (Schaltjahr), Zukunft markiert', () => {
  const p = einzelRaster(TAGE, 'TAG', 2024, [2024, 2023], '2024-12-30');
  assert.equal(p.length, 366);
  assert.deepEqual([p[0].key, p[0].anzahl, p[0].titel], ['2024-01-01', 2, 'Mo 01.01.2024']);
  assert.equal(p[1].anzahl, 0);
  assert.deepEqual(p.find((x) => x.key === '2024-02-29'), { key: '2024-02-29', label: '29.02.', titel: 'Do 29.02.2024', anzahl: 4, stunden: 6, zukunft: false });
  assert.deepEqual([p[364].zukunft, p[365].zukunft], [false, true]);
  assert.equal(p.reduce((s, x) => s + x.anzahl, 0), 16, 'das Vorjahr zählt nicht');
});

test('Einzelbuchungen je Woche: Montag bis Sonntag, am Jahresrand nur die Tage des Jahres', () => {
  assert.deepEqual([kalenderwoche('2024-01-01'), kalenderwoche('2024-12-30'), kalenderwoche('2021-01-03'), kalenderwoche('2023-01-01')], [1, 1, 53, 52]);
  const p = einzelRaster(TAGE, 'WOCHE', 2024, [2024], '2024-06-15');
  assert.deepEqual(p.slice(0, 2).map((x) => [x.label, x.anzahl, x.stunden]), [['KW 1', 3, 3.5], ['KW 2', 3, 3]]);
  const letzte = p[p.length - 1];
  assert.deepEqual([letzte.label, letzte.anzahl, letzte.titel, letzte.zukunft], ['KW 1', 6, 'KW 1 (30.12.2024 – 31.12.2024)', true]);
  assert.equal(p.reduce((s, x) => s + x.anzahl, 0), 16);
  // 2023 beginnt an einem Sonntag: die erste Woche ist der Rest der KW 52 und beginnt am 01.01.
  const q = einzelRaster([{ datum: '2023-01-01', anzahl: 1, stunden: 1 }, { datum: '2023-01-02', anzahl: 2, stunden: 2 }], 'WOCHE', 2023, [2023], '2023-12-31');
  assert.deepEqual(q.slice(0, 2).map((x) => [x.key, x.label, x.anzahl]), [['2023-01-01', 'KW 52', 1], ['2023-01-02', 'KW 1', 2]]);
});

test('Einzelbuchungen je Monat und je Jahr', () => {
  const m = einzelRaster(TAGE, 'MONAT', 2024, [2024, 2023], '2024-06-15');
  assert.deepEqual(m.map((x) => x.anzahl), [6, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
  assert.deepEqual([m[0].label, m[0].titel, m[5].zukunft, m[6].zukunft], ['Jan', 'Januar 2024', false, true]);
  const j = einzelRaster(TAGE, 'JAHR', 2024, [2024, 2023, 2022], '2024-06-15');
  assert.deepEqual(j.map((x) => [x.label, x.anzahl, x.stunden]), [['2022', 0, 0], ['2023', 9, 9], ['2024', 16, 19]]);
});
