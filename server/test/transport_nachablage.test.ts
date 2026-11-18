/**
 * Aufträge → „Neu ablegen“: welche PDFs für die markierten Aufträge entstehen und in welche Auftragsordner sie gehören
 * (modules/transport/web/nachablage-dokumente.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nachablageDokumente } from '../../modules/transport/web/nachablage-dokumente.js';

const A = { auftragsnr: '2099_0101', fahrten: 1, faktura: '2099_7001' };
const B = { auftragsnr: '2099_0102', fahrten: 2, faktura: null };
const C = { auftragsnr: '2099_0103', fahrten: 1, faktura: '2099_7001' }; // gleiche Sammelrechnung wie A, nicht markiert
const alle = [A, B, C];
const kurz = (d: ReturnType<typeof nachablageDokumente>) => d.map((x) => [x.filename, x.ablage.join('+')]);

test('Aufträge: Transportauftrag je Fahrt und Lieferschein in den eigenen Ordner', () => {
  assert.deepEqual(kurz(nachablageDokumente([A, B], alle, 'auftrag')), [
    ['Transportauftrag_2099_0101.pdf', '2099_0101'], ['Lieferschein_2099_0101.pdf', '2099_0101'],
    ['Transportauftrag_2099_0102-1.pdf', '2099_0102'], ['Transportauftrag_2099_0102-2.pdf', '2099_0102'], ['Lieferschein_2099_0102.pdf', '2099_0102'],
  ]);
  assert.equal(nachablageDokumente([B], alle, 'auftrag')[1].url, '/api/m/transport/pdf/T/2099_0102-2');
});

test('Rechnungen: je Rechnung ein PDF in den Ordner jedes ihrer Aufträge (Sammelrechnung), nicht fakturierte ohne', () => {
  assert.deepEqual(kurz(nachablageDokumente([A, B], alle, 'rechnung')), [['Rechnung_2099_7001.pdf', '2099_0101+2099_0103']]);
  assert.deepEqual(nachablageDokumente([B], alle, 'rechnung'), []);
  assert.equal(nachablageDokumente([A, C], alle, 'rechnung').length, 1, 'eine Sammelrechnung nur einmal');
});

test('Alles: Aufträge und Rechnungen', () => {
  assert.deepEqual(kurz(nachablageDokumente([A], alle, 'alles')).map((x) => x[0]),
    ['Transportauftrag_2099_0101.pdf', 'Lieferschein_2099_0101.pdf', 'Rechnung_2099_7001.pdf']);
});
