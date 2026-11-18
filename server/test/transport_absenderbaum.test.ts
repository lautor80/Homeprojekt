/**
 * Posteingang Euroflex – Absenderbaum (modules/transport/web/eingang/absenderbaum.ts), reine Funktionen ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OHNE_ADRESSE, OHNE_POSTFACH, absenderBaum, absenderFiltern, adresseVon, domainVon, filterGueltig, gleicherFilter, postfachBaum,
} from '../../modules/transport/web/eingang/absenderbaum.js';

const INFO = 'info@eigen-firma.example';
const BUCH = 'buchhaltung@eigen-firma.example';
const z = (id: number, von: string | null, von_name: string | null = null, postfach: string | null = INFO) => ({ id, von, von_name, postfach });
const zeilen = [
  z(1, 'Dispo@Spedition-Nord.example', 'Dispo Nord'),
  z(2, 'dispo@spedition-nord.example', null, 'Buchhaltung@Eigen-Firma.example'),
  z(3, 'buchhaltung@spedition-nord.example', 'Buchhaltung', BUCH),
  z(4, 'Max Muster <max@kunde-sued.example>'),
  z(5, null, null, null),
  z(6, 'anna@kunde-sued.example', 'Anna'),
];
const postfaecher = [{ adresse: INFO, bezeichnung: 'Info' }, { adresse: BUCH, bezeichnung: 'Buchhaltung' }];

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

test('Postfachbaum: eigene Postfächer getrennt, Reihenfolge und Bezeichnung aus den Einstellungen', () => {
  const b = postfachBaum(zeilen, postfaecher);
  assert.deepEqual(b.map((p) => [p.postfach, p.bezeichnung, p.anzahl]), [[INFO, 'Info', 3], [BUCH, 'Buchhaltung', 2], [OHNE_POSTFACH, OHNE_POSTFACH, 1]]);
  assert.deepEqual(b[0].domains.map((d) => [d.domain, d.anzahl]), [['kunde-sued.example', 2], ['spedition-nord.example', 1]]);
  // dieselbe Adresse erscheint je Postfach getrennt
  assert.deepEqual(b[1].domains[0].adressen.map((a) => [a.adresse, a.anzahl]), [['buchhaltung@spedition-nord.example', 1], ['dispo@spedition-nord.example', 1]]);
  // unbekanntes Postfach nach den eingestellten, ohne Bezeichnung die Adresse
  const c = postfachBaum([z(7, 'a@x.example', null, 'zentrale@eigen-firma.example'), z(8, 'b@x.example', null, BUCH)], postfaecher);
  assert.deepEqual(c.map((p) => [p.postfach, p.bezeichnung]), [[BUCH, 'Buchhaltung'], ['zentrale@eigen-firma.example', 'zentrale@eigen-firma.example']]);
  assert.deepEqual(postfachBaum([]), []);
});

test('Filtern nach Postfach, Domain und Adresse, ungültiger Filter', () => {
  assert.deepEqual(absenderFiltern(zeilen, null).map((x) => x.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(absenderFiltern(zeilen, { domain: 'spedition-nord.example' }).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(absenderFiltern(zeilen, { adresse: 'max@kunde-sued.example' }).map((x) => x.id), [4]);
  assert.deepEqual(absenderFiltern(zeilen, { domain: OHNE_ADRESSE }).map((x) => x.id), [5]);
  assert.deepEqual(absenderFiltern(zeilen, { postfach: BUCH }).map((x) => x.id), [2, 3]);
  assert.deepEqual(absenderFiltern(zeilen, { postfach: INFO, domain: 'spedition-nord.example' }).map((x) => x.id), [1]);
  assert.deepEqual(absenderFiltern(zeilen, { postfach: BUCH, domain: 'spedition-nord.example', adresse: 'dispo@spedition-nord.example' }).map((x) => x.id), [2]);
  assert.deepEqual(absenderFiltern(zeilen, { postfach: OHNE_POSTFACH }).map((x) => x.id), [5]);
  const b = postfachBaum(zeilen, postfaecher);
  assert.equal(filterGueltig(b, null), true);
  assert.equal(filterGueltig(b, { adresse: 'anna@kunde-sued.example' }), true);
  assert.equal(filterGueltig(b, { postfach: INFO, adresse: 'anna@kunde-sued.example' }), true);
  assert.equal(filterGueltig(b, { postfach: BUCH, adresse: 'anna@kunde-sued.example' }), false);
  assert.equal(filterGueltig(b, { domain: 'gibts-nicht.example' }), false);
  assert.equal(gleicherFilter(null, {}), true);
  assert.equal(gleicherFilter({ postfach: INFO }, { postfach: INFO, domain: 'x' }), false);
});
