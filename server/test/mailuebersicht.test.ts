/**
 * E-Mail-Protokoll (Administration → E-Mail-Protokoll): Hilfsfunktionen ohne Datenbank –
 * Empfängeradressen, Zuordnung Adresse → Person, Freitextsuche.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adressen, passt, personenIndex, personenText } from '../src/lib/mailuebersicht.js';

test('Empfängeradressen: mehrere, mit Namen, ohne Dubletten, klein geschrieben', () => {
  assert.deepEqual(adressen('Erika.Muster@Example.org'), ['erika.muster@example.org']);
  assert.deepEqual(adressen('A <a@x.de>; b@y.de, a@x.de'), ['a@x.de', 'b@y.de']);
  assert.deepEqual(adressen(null), []);
});

test('Person je Adresse: Arten zusammengefasst, Familien mit gemeinsamer Adresse alle genannt', () => {
  const index = personenIndex([
    { email: 'A@x.de', name: 'Erika  Muster', art: 'Registrierung' },
    { email: 'a@x.de', name: 'Erika Muster', art: 'Benutzer' },
    { email: 'a@x.de', name: 'Max Muster', art: 'Mitglied' },
  ]);
  assert.equal(index.get('a@x.de'), 'Erika Muster (Registrierung, Benutzer) · Max Muster (Mitglied)');
  assert.equal(personenText('a@x.de, fremd@z.de', index), 'Erika Muster (Registrierung, Benutzer) · Max Muster (Mitglied)');
  assert.equal(personenText('fremd@z.de', index), '');
});

test('Suche: jedes Wort muss vorkommen, Groß-/Kleinschreibung egal', () => {
  assert.ok(passt('erika MUSTER', ['x', 'Erika Muster (Benutzer)']));
  assert.ok(passt('muster reg-12', ['Erika Muster', 'REG-12']));
  assert.ok(!passt('erika meier', ['Erika Muster']));
  assert.ok(passt('', []));
});
