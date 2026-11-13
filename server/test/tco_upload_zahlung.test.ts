/**
 * Upload „Überweisung an Einreicher“: Inhalt des QR-Codes für die Banking-App (EPC/GiroCode) – reine Regeln, ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epcText } from '../../modules/tco/server/upload/epc.js';

test('EPC-QR-Code: Aufbau, Betrag, optionale Felder, Längen', () => {
  const z = { empfaenger: 'Vera Vorstand', iban: 'DE89 3704 0044 0532 0130 00', bic: 'cobadeffxxx', betrag: 49.9, zweck: 'Erstattung Bälle' };
  assert.equal(epcText(z), 'BCD\n002\n1\nSCT\nCOBADEFFXXX\nVera Vorstand\nDE89370400440532013000\nEUR49.90\n\n\nErstattung Bälle');
  // ohne BIC, ohne Betrag, ohne Zweck: leere Zeilen am Ende entfallen
  assert.equal(epcText({ ...z, bic: '', betrag: null, zweck: '' }), 'BCD\n002\n1\nSCT\n\nVera Vorstand\nDE89370400440532013000');
  // Zeilenumbrüche und Überlängen
  const lang = epcText({ ...z, empfaenger: `A${'b'.repeat(100)}`, zweck: `Zeile 1\nZeile 2 ${'x'.repeat(200)}` }).split('\n');
  assert.equal(lang.length, 11);
  assert.deepEqual([lang[5].length, lang[10].length, lang[10].startsWith('Zeile 1 Zeile 2')], [70, 140, true]);
  assert.throws(() => epcText({ ...z, iban: 'DE00 1234' }), /IBAN/);
  assert.throws(() => epcText({ ...z, betrag: 0 }), /Betrag/);
  assert.throws(() => epcText({ ...z, empfaenger: '  ' }), /Name/);
});
