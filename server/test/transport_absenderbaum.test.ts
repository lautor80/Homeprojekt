/**
 * Posteingang Euroflex – Absenderbaum (modules/transport/web/eingang/absenderbaum.ts), reine Funktionen ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OHNE_ADRESSE, absenderBaum, absenderFiltern, adresseVon, domainVon, filterGueltig,
} from '../../modules/transport/web/eingang/absenderbaum.js';

const z = (id: number, von: string | null, von_name: string | null = null) => ({ id, von, von_name });
const zeilen = [
  z(1, 'Dispo@Spedition-Nord.example', 'Dispo Nord'),
  z(2, 'dispo@spedition-nord.example'),
  z(3, 'buchhaltung@spedition-nord.example', 'Buchhaltung'),
  z(4, 'Max Muster <max@kunde-sued.example>'),
  z(5, null),
  z(6, 'anna@kunde-sued.example', 'Anna'),
];

test('Adresse und Domain: Kleinbuchstaben, spitze Klammern, ohne Adresse', () => {
  assert.equal(adresseVon(' Dispo@Spedition-Nord.example '), 'dispo@spedition-nord.example');
  assert.equal(adresseVon('Max <MAX@kunde-sued.example>'), 'max@kunde-sued.example');
  assert.equal(adresseVon(''), OHNE_ADRESSE);
  assert.equal(adresseVon(null), OHNE_ADRESSE);
  assert.equal(domainVon('a@b.example'), 'b.example');
  assert.equal(domainVon(OHNE_ADRESSE), OHNE_ADRESSE);
  assert.equal(domainVon('kein-at'), 'kein-at');
});

test('Baum: Domain → Adresse, nach Anzahl absteigend, Namen übernommen', () => {
  const b = absenderBaum(zeilen);
  assert.deepEqual(b.map((d) => [d.domain, d.anzahl]), [['spedition-nord.example', 3], ['kunde-sued.example', 2], [OHNE_ADRESSE, 1]]);
  assert.deepEqual(b[0].adressen, [
    { adresse: 'dispo@spedition-nord.example', name: 'Dispo Nord', anzahl: 2 },
    { adresse: 'buchhaltung@spedition-nord.example', name: 'Buchhaltung', anzahl: 1 },
  ]);
  // Gleichstand: alphabetisch
  assert.deepEqual(b[1].adressen.map((a) => a.adresse), ['anna@kunde-sued.example', 'max@kunde-sued.example']);
  assert.deepEqual(absenderBaum([]), []);
});

test('Filtern nach Domain und Adresse, ungültiger Filter', () => {
  assert.deepEqual(absenderFiltern(zeilen, null).map((x) => x.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(absenderFiltern(zeilen, { art: 'domain', wert: 'spedition-nord.example' }).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(absenderFiltern(zeilen, { art: 'adresse', wert: 'max@kunde-sued.example' }).map((x) => x.id), [4]);
  assert.deepEqual(absenderFiltern(zeilen, { art: 'domain', wert: OHNE_ADRESSE }).map((x) => x.id), [5]);
  const b = absenderBaum(zeilen);
  assert.equal(filterGueltig(b, null), true);
  assert.equal(filterGueltig(b, { art: 'adresse', wert: 'anna@kunde-sued.example' }), true);
  assert.equal(filterGueltig(b, { art: 'domain', wert: 'gibts-nicht.example' }), false);
});
