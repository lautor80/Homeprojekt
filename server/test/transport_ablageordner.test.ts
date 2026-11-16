/**
 * Euroflex: Ablageordner je Benutzer (Schlüssel und Wahl des Ordners – reine Funktionen) und Kürzen langer Texte in den
 * Ausdrucken (Route der Rechnung ohne Pfeil). Ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDNER_ALT, ordnerSchluessel, ordnerWahl } from '../../modules/transport/web/ordner-schluessel.js';
import { kuerzen } from '../../modules/transport/server/pdf/layout.js';
import { Pdf } from '../src/lib/pdfdoc.js';

test('Ablageordner: jeder Benutzer hat seinen eigenen Schlüssel', () => {
  assert.equal(ordnerSchluessel('a1'), 'ordner:a1');
  assert.notEqual(ordnerSchluessel('a1'), ordnerSchluessel('b2'));
  assert.equal(ordnerSchluessel(null), ORDNER_ALT);
  assert.equal(ordnerSchluessel(''), ORDNER_ALT);
});

test('Ablageordner: eigener Ordner geht vor, sonst der bisher gemeinsame; „nicht mehr verwenden“ gilt nur für den Benutzer', () => {
  assert.deepEqual(ordnerWahl('Eigen', 'Gemeinsam'), { ordner: 'Eigen', quelle: 'EIGEN' });
  assert.deepEqual(ordnerWahl(undefined, 'Gemeinsam'), { ordner: 'Gemeinsam', quelle: 'GEMEINSAM' });
  assert.deepEqual(ordnerWahl(undefined, undefined), { ordner: null, quelle: 'KEINER' });
  assert.deepEqual(ordnerWahl(false, 'Gemeinsam'), { ordner: null, quelle: 'KEINER' });
});

test('Ausdruck: lange Ortsnamen enden vor der nächsten Spalte', () => {
  const p = new Pdf({ title: 'Test' });
  const breite = 40;
  assert.equal(kuerzen(p, 'NL-5711 Someren', breite), 'NL-5711 Someren');
  const lang = kuerzen(p, 'DE-66679 Losheim am See, Gewerbegebiet Nord', breite);
  assert.ok(lang.endsWith('…') && lang.startsWith('DE-66679 Losheim'), lang);
  assert.ok(p.textWidth(lang, { size: 9 }) <= breite);
  assert.equal(kuerzen(p, '', breite), '');
});
