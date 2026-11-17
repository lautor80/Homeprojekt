/**
 * Euroflex: Vorschläge beim Erfassen der Stops (Firma mit Anschrift, Straße, PLZ/Ort, Zeitvorgabe).
 * Reine Filterfunktionen aus modules/transport/web/vorschlaege.ts, ohne Datenbank; dazu Schalter/Recht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ZEICHEN, anschrift, firmenTreffer, normal, ortTreffer, strassenTreffer, zeitTreffer, type Vorschlaege } from '../../modules/transport/web/vorschlaege.js';
import { TRANSPORT_FUNKTIONEN } from '../../modules/transport/server/funktionen.js';

// jüngste zuerst (so liefert der Server)
const V: Vorschlaege = {
  orte: [
    { firma: 'MEISER GmbH', strasse: 'Edmund Meiser Straße 1', land: 'DE', plzort: '66839 Schmelz', anzahl: 12 },
    { firma: 'Wolfschmidt', strasse: null, land: 'DE', plzort: '98744 Unterweißbach', anzahl: 3 },
    { firma: 'Meiser Vogelsang', strasse: 'Hauptstraße 5', land: 'DE', plzort: '66839 Schmelz', anzahl: 1 },
    { firma: 'Baustoffe Schmelzer', strasse: 'Am Werk 2', land: 'DE', plzort: '66111 Saarbrücken', anzahl: 2 },
    { firma: 'MEISER GmbH', strasse: 'Industriestraße 9', land: 'PL', plzort: '95-100 Zgierz', anzahl: 1 },
  ],
  zeiten: ['bis 14:00 Uhr', '07:00-08:30', 'ab 6 Uhr', 'bis 12:00 Uhr'],
};

test('Vergleichsform ohne Akzente, ß, Satzzeichen', () => {
  assert.equal(normal('  Unterweißbach-Süd. '), 'unterweissbach sud');
  assert.equal(MIN_ZEICHEN, 2);
});

test('Firma: Anfang vor Wortanfang vor Mitte, gleiche Firma mit verschiedenen Anschriften einzeln', () => {
  assert.deepEqual(firmenTreffer(V, 'm'), [], 'erst ab 2 Zeichen');
  assert.deepEqual(firmenTreffer(V, 'mei').map((o) => `${o.firma}|${o.plzort}`),
    ['MEISER GmbH|66839 Schmelz', 'Meiser Vogelsang|66839 Schmelz', 'MEISER GmbH|95-100 Zgierz']);
  assert.deepEqual(firmenTreffer(V, 'schmel').map((o) => o.firma), ['Baustoffe Schmelzer', 'MEISER GmbH', 'Meiser Vogelsang'], 'Firma zuerst, dann über den Ort');
  assert.equal(anschrift(V.orte[0]), 'Edmund Meiser Straße 1 · DE 66839 Schmelz');
  assert.equal(anschrift(V.orte[1]), 'DE 98744 Unterweißbach');
  assert.deepEqual(firmenTreffer(null, 'mei'), []);
});

test('Straße: eindeutig, passender Ort zuerst', () => {
  assert.deepEqual(strassenTreffer(V, 'stra', null).map((x) => x.strasse), ['Edmund Meiser Straße 1', 'Hauptstraße 5', 'Industriestraße 9']);
  assert.deepEqual(strassenTreffer(V, 'stra', '95-100 Zgierz').map((x) => x.strasse)[0], 'Industriestraße 9');
});

test('PLZ/Ort: über PLZ oder Namen, mit Land, ohne Doppelte', () => {
  assert.deepEqual(ortTreffer(V, '668'), [{ land: 'DE', plzort: '66839 Schmelz' }]);
  assert.deepEqual(ortTreffer(V, 'weiss'), [{ land: 'DE', plzort: '98744 Unterweißbach' }]);
  assert.deepEqual(ortTreffer(V, 'zgi'), [{ land: 'PL', plzort: '95-100 Zgierz' }]);
});

test('Zeitvorgabe: ohne Eingabe die häufigsten, sonst enthält – nicht der schon fertige Wert', () => {
  assert.deepEqual(zeitTreffer(V, '', 2), ['bis 14:00 Uhr', '07:00-08:30']);
  assert.deepEqual(zeitTreffer(V, 'bis'), ['bis 14:00 Uhr', 'bis 12:00 Uhr']);
  assert.deepEqual(zeitTreffer(V, 'bis 14:00 Uhr'), []);
});

test('Funktionsschalter mit Recht und Route', () => {
  const f = TRANSPORT_FUNKTIONEN.find((x) => x.id === 'transport.stops.vorschlaege');
  assert.ok(f);
  assert.deepEqual(f!.permissions, ['transport.vorschlaege:display']);
  assert.deepEqual(f!.routen, ['GET /stops/vorschlaege']);
});
