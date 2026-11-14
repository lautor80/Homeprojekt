/**
 * AuswahlBox (web/src/components/auswahlSuche.ts): Ein im Dropdown gewählter Eintrag muss auch dann übernommen werden,
 * wenn der Name im Stammsatz doppelte oder geschützte Leerzeichen enthält (Zuordnung „Anne Celik“ wurde verworfen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eintragZuText, normText } from '../../web/src/components/auswahlSuche.js';

const liste = [
  { key: '1', text: 'Anne  Celik' },
  { key: '2', text: 'Elina Rojin Celik ' },
  { key: '3', text: 'Luca Schneider (3)' },
  { key: '4', text: 'Luca Schneider (4)' },
  { key: '5', text: 'Zoé Brunk' },
];

test('Leerzeichen werden vereinheitlicht', () => {
  assert.equal(normText('  Anne   Celik '), 'Anne Celik');
  assert.equal(eintragZuText(liste, 'Anne  Celik'), '1');
  assert.equal(eintragZuText(liste, 'Anne Celik'), '1');
  assert.equal(eintragZuText(liste, 'Elina Rojin Celik'), '2');
  assert.equal(eintragZuText(liste, 'elina rojin celik'), '2');
});

test('Unicode-Schreibweisen gelten als gleich', () => {
  assert.equal(eintragZuText(liste, 'Zoé Brunk'), '5');
});

test('kein oder kein eindeutiger Treffer', () => {
  assert.equal(eintragZuText(liste, ''), undefined);
  assert.equal(eintragZuText(liste, 'Luca'), undefined);
  assert.equal(eintragZuText(liste, 'Luca Schneider (4)'), '4');
  assert.equal(eintragZuText([{ key: 'a', text: 'X' }, { key: 'b', text: 'X' }], 'X'), undefined);
});
