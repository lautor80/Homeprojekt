/**
 * Bankimport: Paperless-Dokument einer erkannten Hallenrechnung (rgkopf.doknr) wird als Beleg vorgeschlagen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rechnungsDok } from '../../modules/tco/server/fi/bank.js';

test('Rechnungs-PDF: doknr mit führenden Nullen, leer oder ungültig', () => {
  assert.equal(rechnungsDok('003291'), 3291);
  assert.equal(rechnungsDok(' 654 '), 654);
  assert.equal(rechnungsDok(3291), 3291);
  assert.equal(rechnungsDok(null), null);
  assert.equal(rechnungsDok(''), null);
  assert.equal(rechnungsDok('000'), null);
  assert.equal(rechnungsDok('PL-12'), null);
});
