/**
 * Pläne der Jobs (Administration → System → Jobs) – ohne Datenbank: Prüfung, Anzeigetext und nächster Start in
 * Europe/Berlin, auch über die Umstellung zwischen Sommer- und Winterzeit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naechsterLauf, planPruefen, planText } from '../src/job-plan.js';
import type { JobPlan } from '../src/job-typen.js';

const t = (p: JobPlan, ab: string) => naechsterLauf(p, new Date(ab)).toISOString();
const taeglich = (uhrzeit: string, wochentage: number[] = []): JobPlan => ({ art: 'taeglich', uhrzeit, wochentage });

test('Plan prüfen: Grenzen, Format und Vereinheitlichung', () => {
  assert.deepEqual(planPruefen({ art: 'intervall', minuten: 1 }), { art: 'intervall', minuten: 1 });
  assert.deepEqual(planPruefen({ art: 'intervall', minuten: 10080 }), { art: 'intervall', minuten: 10080 });
  for (const minuten of [0, -5, 10081, 1.5, '60']) assert.throws(() => planPruefen({ art: 'intervall', minuten }), `Intervall ${minuten}`);
  assert.deepEqual(planPruefen({ art: 'taeglich', uhrzeit: '02:30', wochentage: [5, 1, 3, 1] }), taeglich('02:30', [1, 3, 5]));
  assert.deepEqual(planPruefen({ art: 'taeglich', uhrzeit: '23:59' }), taeglich('23:59'), 'Wochentage fehlen = jeden Tag');
  for (const uhrzeit of ['24:00', '2:30', '12:60', '12.30', '']) assert.throws(() => planPruefen({ art: 'taeglich', uhrzeit, wochentage: [] }), `Uhrzeit ${uhrzeit}`);
  for (const tag of [0, 8, 2.5]) assert.throws(() => planPruefen({ art: 'taeglich', uhrzeit: '08:00', wochentage: [tag] }), `Wochentag ${tag}`);
  assert.throws(() => planPruefen({ art: 'woechentlich', minuten: 5 }));
  assert.throws(() => planPruefen(null));
});

test('Plan als Text', () => {
  assert.equal(planText({ art: 'intervall', minuten: 1 }), 'jede Minute');
  assert.equal(planText({ art: 'intervall', minuten: 15 }), 'alle 15 Minuten');
  assert.equal(planText({ art: 'intervall', minuten: 60 }), 'alle 60 Minuten');
  assert.equal(planText({ art: 'intervall', minuten: 90 }), 'alle 90 Minuten');
  assert.equal(planText({ art: 'intervall', minuten: 360 }), 'alle 6 Stunden');
  assert.equal(planText(taeglich('02:30')), 'täglich 02:30');
  assert.equal(planText(taeglich('02:30', [1, 2, 3, 4, 5, 6, 7])), 'täglich 02:30');
  assert.equal(planText(taeglich('02:30', [1, 2, 3, 4, 5])), 'täglich 02:30 (Mo–Fr)');
  assert.equal(planText(taeglich('07:05', [6, 7])), 'täglich 07:05 (Sa, So)');
  assert.equal(planText(taeglich('07:05', [1, 3, 5])), 'täglich 07:05 (Mo, Mi, Fr)');
  assert.equal(planText(taeglich('07:05', [1, 2, 3, 5, 6, 7])), 'täglich 07:05 (Mo–Mi, Fr–So)');
});

test('Intervall: ab + Minuten, auf die volle Minute abgerundet, immer später', () => {
  assert.equal(t({ art: 'intervall', minuten: 1 }, '2026-11-20T10:00:20.500Z'), '2026-11-20T10:01:00.000Z');
  assert.equal(t({ art: 'intervall', minuten: 60 }, '2026-11-20T10:00:00.000Z'), '2026-11-20T11:00:00.000Z');
  assert.equal(t({ art: 'intervall', minuten: 10080 }, '2026-11-20T10:00:59.000Z'), '2026-11-27T10:00:00.000Z');
});

test('täglich: Uhrzeit in Berlin, Winter- und Sommerzeit', () => {
  // Winterzeit (UTC+1): 03:20 Berlin = 02:20 UTC
  assert.equal(t(taeglich('03:20'), '2026-11-20T01:00:00Z'), '2026-11-20T02:20:00.000Z', 'heute noch');
  assert.equal(t(taeglich('03:20'), '2026-11-20T02:20:00Z'), '2026-11-21T02:20:00.000Z', 'genau zur Zeit: morgen (echt später)');
  // Sommerzeit (UTC+2): 03:20 Berlin = 01:20 UTC
  assert.equal(t(taeglich('03:20'), '2026-07-01T12:00:00Z'), '2026-07-02T01:20:00.000Z');
  // kurz vor Mitternacht Berlin, in UTC noch der Vortag
  assert.equal(t(taeglich('00:10'), '2026-11-20T23:05:00Z'), '2026-11-20T23:10:00.000Z');
  // Jahreswechsel
  assert.equal(t(taeglich('08:00'), '2026-12-31T12:00:00Z'), '2027-01-01T07:00:00.000Z');
});

test('täglich: Wochentage (1 = Montag … 7 = Sonntag)', () => {
  // Freitag, 20.11.2026, 12:00 Berlin → nächster Montag–Freitag-Termin 02:30 ist Montag, 23.11.
  assert.equal(t(taeglich('02:30', [1, 2, 3, 4, 5]), '2026-11-20T11:00:00Z'), '2026-11-23T01:30:00.000Z');
  // nur sonntags
  assert.equal(t(taeglich('18:00', [7]), '2026-11-20T11:00:00Z'), '2026-11-22T17:00:00.000Z');
  // nur freitags, heute schon vorbei → eine Woche später
  assert.equal(t(taeglich('08:00', [5]), '2026-11-20T11:00:00Z'), '2026-11-27T07:00:00.000Z');
});

test('täglich: Umstellung auf Sommerzeit (29.03.2026) – fehlende Uhrzeit läuft eine Stunde später', () => {
  // 02:30 gibt es am 29.03. nicht (02:00 → 03:00): Lauf um 03:30 Sommerzeit = 01:30 UTC
  assert.equal(t(taeglich('02:30'), '2026-03-28T12:00:00Z'), '2026-03-29T01:30:00.000Z');
  // 03:20 am Umstellungstag: 01:20 UTC
  assert.equal(t(taeglich('03:20'), '2026-03-28T12:00:00Z'), '2026-03-29T01:20:00.000Z');
  // 01:30 am Umstellungstag ist noch Winterzeit: 00:30 UTC
  assert.equal(t(taeglich('01:30'), '2026-03-28T12:00:00Z'), '2026-03-29T00:30:00.000Z');
  // Tag danach normal in Sommerzeit
  assert.equal(t(taeglich('02:30'), '2026-03-29T01:30:00Z'), '2026-03-30T00:30:00.000Z');
});

test('täglich: Umstellung auf Winterzeit (25.10.2026) – doppelte Uhrzeit läuft nur einmal', () => {
  // 02:30 gibt es zweimal (Sommerzeit 00:30 UTC, Winterzeit 01:30 UTC) – es gilt die erste
  assert.equal(t(taeglich('02:30'), '2026-10-24T12:00:00Z'), '2026-10-25T00:30:00.000Z');
  // nach dem ersten Lauf nicht noch einmal am selben Tag, sondern am nächsten in Winterzeit
  assert.equal(t(taeglich('02:30'), '2026-10-25T00:30:20Z'), '2026-10-26T01:30:00.000Z');
  // 03:20 am Umstellungstag ist schon Winterzeit: 02:20 UTC
  assert.equal(t(taeglich('03:20'), '2026-10-24T12:00:00Z'), '2026-10-25T02:20:00.000Z');
});
