/** Abo-Verwaltung (#11): Wochentag und Uhrzeit getrennt, sortierbar */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uhrzeitOrdnung, uhrzeitText, wochentagText } from '../../modules/tco/web/platz/abospalten.js';

test('Wochentag und Uhrzeit als eigene Spaltenwerte', () => {
  assert.equal(wochentagText(4), 'Donnerstag');
  assert.equal(wochentagText(7), 'Sonntag');
  assert.equal(uhrzeitText('11:00:00', '12:00:00'), '11:00–12:00 Uhr');
  const z = [['18:00', '19:00'], ['09:00', '11:00'], ['09:00', '10:00']].map(([v, b]) => uhrzeitOrdnung(v, b)).sort();
  assert.deepEqual(z, ['09:0010:00', '09:0011:00', '18:0019:00']);
});
