/**
 * Mitgliedergruppen: Selbsteintrag in „Meine Mitgliedschaft“ auf Berechtigungsgruppen beschränken (z. B. Gruppe „Vorstand“
 * nur für die Berechtigungsgruppe „Vorstand“). Reiner Rechenteil ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selbstSperre } from '../../modules/tco/server/gruppen/logik.js';

const g = (id: number, parent_id: number | null, name: string, nur_rollen: string[] = []) => ({ id, parent_id, name, nur_rollen });
const baum = [
  g(1, null, 'Vorstand', ['VORSTAND']),
  g(2, 1, 'Kassenprüfer'),
  g(3, null, 'Spielbetrieb'),
  g(4, 3, 'Mannschaftsführer', ['MF', 'VORSTAND']),
  g(5, 4, 'Herren 40 MF', ['SPORTWART']),
];

test('ohne Beschränkung darf jedes Mitglied', () => {
  assert.equal(selbstSperre(baum, 3, []), null);
  assert.equal(selbstSperre(baum, 3, ['MITGLIED']), null);
});

test('Gruppe „Vorstand“: nur mit der Berechtigungsgruppe Vorstand', () => {
  assert.equal(selbstSperre(baum, 1, ['MITGLIED'])?.id, 1);
  assert.equal(selbstSperre(baum, 1, []), baum[0]);
  assert.equal(selbstSperre(baum, 1, ['MITGLIED', 'VORSTAND']), null);
});

test('die Beschränkung gilt auch für die Untergruppen', () => {
  assert.equal(selbstSperre(baum, 2, ['MITGLIED'])?.name, 'Vorstand');
  assert.equal(selbstSperre(baum, 2, ['VORSTAND']), null);
});

test('eine der Rollen genügt; jede beschränkte Ebene muss erfüllt sein', () => {
  assert.equal(selbstSperre(baum, 4, ['MF']), null);
  assert.equal(selbstSperre(baum, 4, ['VORSTAND']), null);
  assert.equal(selbstSperre(baum, 5, ['MF'])?.id, 5, 'untere Ebene fehlt');
  assert.equal(selbstSperre(baum, 5, ['SPORTWART'])?.id, 4, 'obere Ebene fehlt');
  assert.equal(selbstSperre(baum, 5, ['SPORTWART', 'MF']), null);
});

test('unbekannte Gruppe und Ring im Baum führen nicht zu einer Sperre bzw. Endlosschleife', () => {
  assert.equal(selbstSperre(baum, 99, []), null);
  assert.equal(selbstSperre([g(7, 8, 'A'), g(8, 7, 'B')], 7, []), null);
});
