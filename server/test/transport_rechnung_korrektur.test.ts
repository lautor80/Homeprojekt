/**
 * Euroflex: Rechnung zur Korrektur öffnen und mit derselben Nummer neu erzeugen – reine Planungs- und Textlogik ohne Datenbank.
 * Den Ablauf über die API prüft server/test/transport.test.ts („Rechnung korrigieren …“).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { korrekturVermerk, rechnungenPlanen, type PlanZeile } from '../../modules/transport/server/rechnung-korrektur.js';

const zeile = (auftragsnr: string, x: Partial<PlanZeile> = {}): PlanZeile => ({
  auftragsnr, faktura: null, abgeschlossen_am: null, faktura_reserviert: null, fakturadatum_reserviert: null, ...x,
});

test('Planen: offene Aufträge bekommen neue Nummern, fakturierte und abgeschlossene werden ignoriert', () => {
  const p = rechnungenPlanen([
    zeile('2026_0902'), zeile('2026_0901'), zeile('2026_0903', { faktura: '2026_5001' }), zeile('2026_0904', { abgeschlossen_am: '2026-11-01' }),
  ], ['2026_0901', '2026_0902', '2026_0903', '2026_0904']);
  assert.deepEqual(p, { korrekturen: [], neu: ['2026_0901', '2026_0902'], ignoriert: 2 });
});

test('Planen: vorgemerkte Nummer kommt mit ihrem Rechnungsdatum zurück – Sammelrechnung vollständig, auch nicht ausgewählte Aufträge', () => {
  const p = rechnungenPlanen([
    zeile('2026_0912', { faktura_reserviert: '2026_5010', fakturadatum_reserviert: '2026-11-02' }),
    zeile('2026_0911', { faktura_reserviert: '2026_5010', fakturadatum_reserviert: '2026-11-02' }),
    zeile('2026_0913'),
  ], ['2026_0911', '2026_0913']);
  assert.deepEqual(p.korrekturen, [{ faktura: '2026_5010', datum: '2026-11-02', auftraege: ['2026_0911', '2026_0912'] }]);
  assert.deepEqual(p.neu, ['2026_0913']);
  assert.equal(p.ignoriert, 0);
});

test('Planen: nicht ausgewählte offene Aufträge ohne Vormerkung bleiben unberührt', () => {
  const p = rechnungenPlanen([zeile('2026_0921', { faktura_reserviert: '2026_5020' }), zeile('2026_0922')], ['2026_0921']);
  assert.deepEqual(p.neu, []);
  assert.equal(p.korrekturen.length, 1);
});

test('Vermerk: mit Datum der Korrektur, Leerraum zusammengefasst, ohne Korrektur leer', () => {
  assert.equal(korrekturVermerk('Frachtpreis  angepasst\n(Absprache)', '2026-11-23'), 'Korrigierte Rechnung vom 23.11.2026: Frachtpreis angepasst (Absprache)');
  assert.equal(korrekturVermerk('', '2026-11-23'), 'Korrigierte Rechnung vom 23.11.2026.');
  assert.equal(korrekturVermerk('Anschrift geändert', null), 'Korrigierte Rechnung: Anschrift geändert');
  assert.equal(korrekturVermerk(null, null), '');
});
