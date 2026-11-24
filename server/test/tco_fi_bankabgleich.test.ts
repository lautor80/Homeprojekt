/**
 * Bankimport-Abgleich mit vorhandenen Buchungen: Zahler vor Betrag. Fall vom 23.11.2026 – Mueller (24 €) und Lermen (12 €)
 * waren gebucht, die neue Datei (neueste Umsätze oben) brachte zusätzlich Klimov (24 €) und Wilhelm (12 €).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abgleichen, nenntZahler, rechnungsNummern, type AbgleichUmsatz, type VorhandeneBuchung } from '../../modules/tco/server/fi/abgleich.js';

const um = (name: string, betrag: number, datum = '2030-03-23'): AbgleichUmsatz & { name: string } =>
  ({ datum, valuta: datum, name, betrag, status: 'neu', statusText: 'neu' });
const bu = (internenr: string, text: string, betrag: number, datum = '2030-03-23', belnr = internenr): VorhandeneBuchung =>
  ({ internenr, datum, betrag, belnr, text });

test('Zahler mit gleichem Betrag verbraucht nicht die Buchung eines anderen', () => {
  const u = [um('Oliver Wilhelm', 12), um('Yury Klimov', 24), um('Thomas Bernd Zibolowski', 24), um('Michael Mueller', 24), um('Jan Lermen', 12)];
  abgleichen(u, [bu('9000000001', 'Michael Mueller Rechnung 2030-112', 24), bu('9000000002', 'Jan Lermen Rechnung 2030.093', 12)]);
  assert.deepEqual(u.map((x) => [x.name, x.status]), [
    ['Oliver Wilhelm', 'neu'], ['Yury Klimov', 'neu'], ['Thomas Bernd Zibolowski', 'neu'], ['Michael Mueller', 'gebucht'], ['Jan Lermen', 'gebucht'],
  ]);
  assert.match(u[3].statusText, /9000000001/);
});

test('Doppelt gebuchte Buchung eines anderen Zahlers wird nicht einem neuen Umsatz zugeschlagen', () => {
  const u = [um('Yury Klimov', 24), um('Michael Mueller', 24)];
  abgleichen(u, [bu('9000000001', 'Michael Mueller Rechnung', 24), bu('9000000003', 'Michael Mueller Rechnung', 24)]);
  assert.deepEqual(u.map((x) => x.status), ['neu', 'gebucht']);
});

test('Geänderter Buchungstext: Abgleich nach Betrag und Datum bleibt', () => {
  const u = [um('Stadtwerke XY GmbH', -80.5), um('Erika Beispiel', 15, '2030-03-20')];
  abgleichen(u, [bu('9000000010', 'Strom März', -80.5), bu('9000000011', 'Hallenmiete', 15, '2030-03-24')]);
  assert.deepEqual(u.map((x) => x.status), ['gebucht', 'gebucht']);
});

test('Zahler-Abgleich auch bei abweichendem Datum (±7 Tage) und Umlauten', () => {
  const u = [um('Lea Löchel', 36, '2030-03-23'), um('Max Muster', 36, '2030-03-21')];
  abgleichen(u, [bu('9000000020', 'Max Muster Rechnung', 36, '2030-03-21'), bu('9000000021', 'LEA LOECHEL Rechnung', 36, '2030-03-18')]);
  assert.match(u[0].statusText, /9000000021/);
  assert.match(u[1].statusText, /9000000020/);
});

test('Sammelposition: mehrere Buchungen mit gleicher Belegnummer', () => {
  const u = [um('', 30)];
  abgleichen(u, [bu('9000000030', 'Teil A', 10, '2030-03-23', '777'), bu('9000000031', 'Teil B', 20, '2030-03-23', '777')]);
  assert.match(u[0].statusText, /Sammelposition 2 Belege/);
});

test('nenntZahler', () => {
  assert.equal(nenntZahler('Michael Mueller', 'Michael Mueller Rechnung 2026-112'), true);
  assert.equal(nenntZahler('Yury Klimov', 'Michael Mueller Rechnung 2026-112'), false);
  assert.equal(nenntZahler('', 'egal'), false);
});

test('Rechnungsnummer vor Zahler: Buchung mit falschem Text, aber richtiger Rechnung (Becker/Wilhelm 03.11.2026)', () => {
  const u = [
    { ...um('Thomas Becker', 12, '2030-11-03'), zweck: 'Rechnung 2030.083' },
    { ...um('Oliver Wilhelm', 12, '2030-11-03'), zweck: 'Rechnung 2030-065 EREF: OliverWilhelm' },
  ];
  abgleichen(u, [
    { ...bu('9000000030', 'Oliver Wilhelm Rechnung 2030-065', 12, '2030-11-03'), rgnr: '2030_065' },
    { ...bu('9000000031', 'Oliver Wilhelm Rechnung 2030-065', 12, '2030-11-03'), rgnr: '2030_083' },
  ]);
  assert.deepEqual(u.map((x) => x.status), ['gebucht', 'gebucht']);
  assert.match(u[0].statusText, /9000000031, Rechnung 2030_083/);
  assert.match(u[1].statusText, /9000000030/);
});

test('Rechnungsnummer allein reicht nicht: Betrag muss passen', () => {
  const u = [{ ...um('Thomas Becker', 24), zweck: 'Rechnung 2030.083' }];
  abgleichen(u, [{ ...bu('9000000032', 'Thomas Becker Rechnung', 12), rgnr: '2030_083' }]);
  assert.equal(u[0].status, 'neu');
});

test('Rechnungsnummern im Verwendungszweck', () => {
  assert.deepEqual(rechnungsNummern('Rechnung 2026.083'), ['2026_083']);
  assert.deepEqual(rechnungsNummern('Rechnungsnummer 2026 077 Hallenabo EREF: MOB.326.UE.POS00206899'), ['2026_077']);
  assert.deepEqual(rechnungsNummern('2026071'), ['2026_071']);
  assert.deepEqual(rechnungsNummern('RG.2026/--061 ABO'), ['2026_061']);
  assert.deepEqual(rechnungsNummern('Halle Oktober'), []);
});
