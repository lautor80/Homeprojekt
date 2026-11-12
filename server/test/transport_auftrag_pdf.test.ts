import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECHNUNGSHINWEIS, transportauftragAngaben } from '../../modules/transport/server/pdf/transportauftrag-angaben.js';

/** #170: Transportauftrag an den Unternehmer – ohne Kennzeichen/Ladenummer, Hinweis zur Auftrags-Nr., Preis des Unternehmers (VK) */
test('Transportauftrag: Infoblock und Frachtpreis', () => {
  const r = transportauftragAngaben({ auftragsnr: '2026_1323', frachtpreis_vk: 850 }, '12.11.2026');
  assert.deepEqual(r.info, [['Auftrags-Nr.', '2026_1323'], ['', RECHNUNGSHINWEIS], ['Datum', '12.11.2026']]);
  assert.ok(!r.info.some(([k]) => /Kennzeichen|Ladenummer/.test(k)));
  assert.match(RECHNUNGSHINWEIS, /auf der Rechnung/);
  assert.equal(r.frachtpreis, 850);
});
