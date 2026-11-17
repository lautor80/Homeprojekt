/**
 * Auftragsliste Euroflex: Abrechnungsstatus (angelegt · abgerechnet · bezahlt, überfällig erst 3 Tage nach Fälligkeit)
 * und Lade-/Entladetermine für die zweite Zeile der Spalte Route. Reine Funktionen – ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KULANZ_TAGE, abrechnungsStatus, ladeTermine, plusTage, tageZwischen } from '../../modules/transport/server/abrechnung.js';

const auftrag = (x: Partial<{ faktura: string | null; fakturadatum: string | null; abgeschlossenAm: string | null; bezahltAm: string | null }> = {}) =>
  ({ faktura: null, fakturadatum: null, abgeschlossenAm: null, bezahltAm: null, ...x });

test('Datumsrechnung über Monats- und Jahresgrenzen', () => {
  assert.equal(plusTage('2026-12-20', 14), '2027-01-03');
  assert.equal(plusTage('2028-02-28', 1), '2028-02-29');
  assert.equal(tageZwischen('2026-10-30', '2026-11-02'), 3);
  assert.equal(tageZwischen('2026-11-02', '2026-10-30'), -3);
});

test('angelegt: ohne Rechnung und nicht abgeschlossen', () => {
  assert.deepEqual(abrechnungsStatus(auftrag(), 14, '2026-11-17'),
    { status: 'angelegt', faellig: null, tageUeberfaellig: 0, bezahltAm: null, ohneRechnung: false });
});

test('ohne Rechnung abgeschlossen (früher 0 Euro) gilt als bezahlt', () => {
  const a = abrechnungsStatus(auftrag({ abgeschlossenAm: '2026-11-05' }), 14, '2026-11-17');
  assert.equal(a.status, 'bezahlt');
  assert.equal(a.ohneRechnung, true);
  assert.equal(a.bezahltAm, '2026-11-05');
});

test('abgerechnet bis einschließlich 3 Tage nach Fälligkeit, danach überfällig', () => {
  assert.equal(KULANZ_TAGE, 3);
  const r = auftrag({ faktura: '2026_7001', fakturadatum: '2026-11-01' }); // fällig 15.11.
  const am = (heute: string) => abrechnungsStatus(r, 14, heute);
  assert.equal(am('2026-11-10').status, 'abgerechnet');
  assert.equal(am('2026-11-10').faellig, '2026-11-15');
  assert.equal(am('2026-11-15').status, 'abgerechnet', 'am Fälligkeitstag');
  assert.equal(am('2026-11-18').status, 'abgerechnet', '3 Tage nach Fälligkeit noch nicht');
  assert.deepEqual([am('2026-11-19').status, am('2026-11-19').tageUeberfaellig], ['ueberfaellig', 4]);
});

test('bezahlt: Zahlungseingang erfasst, auch wenn er spät kam', () => {
  const a = abrechnungsStatus(auftrag({ faktura: '2026_7002', fakturadatum: '2026-09-01', bezahltAm: '2026-10-20' }), 14, '2026-11-17');
  assert.deepEqual([a.status, a.bezahltAm, a.tageUeberfaellig, a.ohneRechnung], ['bezahlt', '2026-10-20', 0, false]);
});

test('Zahlungsziel 0 Tage: fällig am Rechnungsdatum', () => {
  const r = auftrag({ faktura: '2026_7003', fakturadatum: '2026-11-10' });
  assert.equal(abrechnungsStatus(r, 0, '2026-11-13').status, 'abgerechnet');
  assert.equal(abrechnungsStatus(r, 0, '2026-11-14').status, 'ueberfaellig');
});

test('Lade-/Entladetermine: erster Ladetermin, letzte Entladestelle', () => {
  const s1 = { datum: '2026-11-18', zeit: '07:00-08:30 ', datum_e: '2026-11-18', zeit_e: '12:30', plzort_e: '68159 Mannheim' };
  assert.deepEqual(ladeTermine(s1, null), { laden: { datum: '2026-11-18', zeit: '07:00-08:30' }, entladen: { datum: '2026-11-18', zeit: '12:30' } });
  // zweite Entladestelle gewinnt
  assert.deepEqual(ladeTermine(s1, { datum_e: '2026-11-19', zeit_e: null, plzort_e: 'L-1234 Luxemburg' }).entladen, { datum: '2026-11-19', zeit: null });
  // leerer zweiter Stop zählt nicht
  assert.deepEqual(ladeTermine(s1, { datum_e: null, zeit_e: '', plzort_e: '' }).entladen, { datum: '2026-11-18', zeit: '12:30' });
  // ohne Angaben: null
  assert.deepEqual(ladeTermine({ datum: null, zeit: ' ', datum_e: null, zeit_e: null, plzort_e: null }, null), { laden: null, entladen: null });
  assert.deepEqual(ladeTermine(null, null), { laden: null, entladen: null });
});

test('Anzeige: Termin „Mi 18.11. 07:00–08:30“ und Symbole der Spalte Abrechnung', async () => {
  const { terminText, symbole } = await import('../../modules/transport/web/termin.js');
  assert.equal(terminText({ datum: '2026-11-18', zeit: '07:00 - 08:30' }), 'Mi 18.11. 07:00–08:30');
  assert.equal(terminText({ datum: '2026-11-22', zeit: null }), 'So 22.11.');
  assert.equal(terminText({ datum: null, zeit: 'ab 6 Uhr' }), 'ab 6 Uhr');
  assert.equal(terminText(null), '');

  const ohne = symbole(abrechnungsStatus(auftrag({ abgeschlossenAm: '2026-11-05' }), 14, '2026-11-17'), null, null, '2026-11-01');
  assert.deepEqual(ohne.symbole.map((s) => s.zustand), ['erledigt', 'erledigt', 'bezahlt']);
  assert.equal(ohne.hinweis, 'ohne Rechnung');

  const spaet = symbole(abrechnungsStatus(auftrag({ faktura: '2026_7004', fakturadatum: '2026-10-20' }), 14, '2026-11-17'), '2026_7004', '2026-10-20', '2026-10-15');
  assert.deepEqual(spaet.symbole.map((s) => s.zustand), ['erledigt', 'erledigt', 'ueberfaellig']);
  assert.equal(spaet.hinweis, '14 Tage überfällig');
  assert.match(spaet.symbole[1].text, /Rechnung 2026_7004 vom 20\.10\.2026/);

  const neu = symbole(abrechnungsStatus(auftrag(), 14, '2026-11-17'), null, null, '2026-11-14');
  assert.deepEqual(neu.symbole.map((s) => s.zustand), ['erledigt', 'offen', 'offen']);
  assert.equal(neu.symbole[0].text, 'Angelegt am 14.11.2026');
});
