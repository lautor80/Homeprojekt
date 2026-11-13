/**
 * Upload „Überweisung an Einreicher“: Inhalt des QR-Codes für die Banking-App (EPC/GiroCode) – reine Regeln, ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epcText } from '../../modules/tco/server/upload/epc.js';
import { folgeText, optionWert, sapLeer, statusOffen } from '../../modules/tco/server/fi/ueberweisung-regeln.js';

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

test('FI-Belege „Überweisung an Einreicher“: Text der Folgeaktion (Auswahlfeld), Feld SAP leer', () => {
  const neu = [{ id: 'a1', label: 'Bezahlen' }, { id: 'b2', label: 'Überweisung an Einreicher' }];
  assert.equal(folgeText('b2', neu), 'Überweisung an Einreicher');
  assert.equal(folgeText('Überweisung an Einreicher', neu), 'Überweisung an Einreicher', 'Textfeld: der Wert selbst');
  assert.equal(folgeText(1, ['Bezahlen', 'Überweisung an Einreicher']), 'Überweisung an Einreicher', 'ältere Auswahlfelder: Index');
  assert.deepEqual([folgeText(null), folgeText(undefined, neu), folgeText('zz', neu)], ['', '', 'zz']);
  assert.deepEqual([null, undefined, '', ' ', false, 'false'].map(sapLeer), [true, true, true, true, true, true]);
  assert.deepEqual([true, 'X', 'true', 1].map(sapLeer), [false, false, false, false]);
});

test('Überweisung an Einreicher: Status „Offen“ in der Selektion, „gezahlt“ als Wert der Bestätigung', () => {
  const opts = [{ id: 's1', label: 'Offen' }, { id: 's2', label: 'Gezahlt' }];
  assert.deepEqual([statusOffen(folgeText('s1', opts)), statusOffen(folgeText('s2', opts)), statusOffen(folgeText(null, opts)), statusOffen(' OFFEN ')], [true, false, false, true]);
  assert.equal(optionWert(opts, 'gezahlt'), 's2', 'Auswahlfeld: Kennung der Option, Schreibweise egal');
  assert.equal(optionWert(['Offen', 'gezahlt'], 'gezahlt'), 1, 'ältere Auswahlfelder: Index');
  assert.equal(optionWert(opts, 'storniert'), null);
});
