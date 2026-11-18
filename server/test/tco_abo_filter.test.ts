/**
 * Platzverwaltung → Abos: Schnellfilter (modules/tco/web/platz/aboFilter.ts), reine Funktionen ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEERER_ABO_FILTER, aboFilterAktiv, aboFilterLesen, aboPlaetze, aboTitel, abosFiltern, type AboFilter, type AboFilterZeile,
} from '../../modules/tco/web/platz/aboFilter.js';

const z = (bid: string, kunde: string, platz: string, kommend: number, abgerechnet: number, quelle: 'Portal' | 'EP3', text: string | null = null): AboFilterZeile =>
  ({ bid, kunde, platz, kommend, abgerechnet, quelle, text });

const ABOS = [
  z('1001', 'Brandt, Anna', 'Halle 1', 5, 0, 'Portal', 'Doppel mit Partner'),
  z('1002', 'Müller, Karl', 'Halle 2', 0, 1, 'EP3'),
  z('1003', 'Schmidt, Eva', 'Halle 1', 3, 1, 'EP3', 'Jugend'),
  z('1004', 'Brandt, Tom', 'Platz 10', 0, 0, 'Portal'),
];
const f = (x: Partial<AboFilter>): AboFilter => ({ ...LEERER_ABO_FILTER, ...x });
const ids = (l: AboFilterZeile[]) => l.map((a) => a.bid);

test('ohne Filter: alle Abos in unveränderter Reihenfolge', () => {
  assert.deepEqual(ids(abosFiltern(ABOS, LEERER_ABO_FILTER)), ['1001', '1002', '1003', '1004']);
  assert.equal(aboFilterAktiv(LEERER_ABO_FILTER), false);
});

test('Suche: Mitglied, Abo-Nr. und Notiz, ohne Groß-/Kleinschreibung, alle Wörter', () => {
  assert.deepEqual(ids(abosFiltern(ABOS, f({ suche: 'brandt' }))), ['1001', '1004']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ suche: '1003' }))), ['1003']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ suche: 'PARTNER' }))), ['1001']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ suche: '  brandt   tom ' }))), ['1004']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ suche: 'gibtsnicht' }))), []);
  assert.equal(aboFilterAktiv(f({ suche: '   ' })), false);
});

test('Status: laufend = kommende Termine, beendet = keine', () => {
  assert.deepEqual(ids(abosFiltern(ABOS, f({ status: 'laufend' }))), ['1001', '1003']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ status: 'beendet' }))), ['1002', '1004']);
});

test('Herkunft, Platz und Abrechnung – auch kombiniert', () => {
  assert.deepEqual(ids(abosFiltern(ABOS, f({ herkunft: 'EP3' }))), ['1002', '1003']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ herkunft: 'Portal' }))), ['1001', '1004']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ platz: 'Halle 1' }))), ['1001', '1003']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ abrechnung: 'abgerechnet' }))), ['1002', '1003']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ abrechnung: 'offen' }))), ['1001', '1004']);
  assert.deepEqual(ids(abosFiltern(ABOS, f({ platz: 'Halle 1', herkunft: 'EP3', status: 'laufend' }))), ['1003']);
  assert.equal(aboFilterAktiv(f({ platz: 'Halle 1' })), true);
});

test('aboFilterLesen: gespeicherte Variante prüfen, Unbrauchbares fällt auf die Vorgabe', () => {
  assert.deepEqual(aboFilterLesen(undefined), LEERER_ABO_FILTER);
  assert.deepEqual(aboFilterLesen([1, 2]), LEERER_ABO_FILTER);
  assert.deepEqual(aboFilterLesen({ suche: 'x', status: 'laufend', herkunft: 'EP3', platz: 'Halle 1', abrechnung: 'offen', spalten: {} }),
    { suche: 'x', status: 'laufend', herkunft: 'EP3', platz: 'Halle 1', abrechnung: 'offen' });
  assert.deepEqual(aboFilterLesen({ suche: 3, status: 'irgendwas', herkunft: 'ep3', platz: null, abrechnung: true }), LEERER_ABO_FILTER);
});

test('aboPlaetze: aus den Daten, sortiert, gewählter bleibt wählbar', () => {
  assert.deepEqual(aboPlaetze(ABOS), ['Halle 1', 'Halle 2', 'Platz 10']);
  assert.deepEqual(aboPlaetze([{ platz: 'Platz 10' }, { platz: 'Platz 2' }, { platz: 'Platz 2' }]), ['Platz 2', 'Platz 10']);
  assert.deepEqual(aboPlaetze([], 'Halle 3'), ['Halle 3']);
});

test('aboTitel: „Abos (n)“ bzw. „Abos (12 von 40)“', () => {
  assert.equal(aboTitel(40, 40, false), 'Abos (40)');
  assert.equal(aboTitel(12, 40, true), 'Abos (12 von 40)');
});
