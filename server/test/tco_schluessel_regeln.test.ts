/** Hallenschlüssel (#215): Regeln ohne Datenbank – Altdaten aus der Zwischenablage, Datum/Betrag, Fristen */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abgleichEindeutig, abgleichTreffer, altdatenLesen, betragLesen, datumLesen, dokLesen, nameImText, normText, quittungUeberfaellig, vorgangsNummer } from '../../modules/tco/server/schluessel/regeln.js';

test('Datum, Betrag, Dokumentnummer, Vorgangsnummer', () => {
  assert.equal(datumLesen('03.11.2019'), '2019-11-03');
  assert.equal(datumLesen('3.1.21'), '2021-01-03');
  assert.equal(datumLesen('2020-02-29'), '2020-02-29');
  assert.equal(datumLesen('31.02.2020'), null);
  assert.equal(datumLesen('irgendwann'), null);
  assert.equal(betragLesen('25,00 €'), 25);
  assert.equal(betragLesen('-1.234,56'), 1234.56);
  assert.equal(betragLesen(''), null);
  assert.ok(Number.isNaN(betragLesen('abc')));
  assert.equal(dokLesen('000123'), 123);
  assert.equal(dokLesen('DOKID 45'), 45);
  assert.ok(Number.isNaN(dokLesen('ohne')));
  assert.equal(vorgangsNummer(2026, 12), 'SV-2026-0012');
});

test('Altdaten ohne Kopfzeile: feste Spaltenfolge, Tabulator', () => {
  const z = altdatenLesen('Max Muster\t01.10.2019\tBen H.\t25,00\t15.03.2022\tAnna V.\t501\t502\t\tAltbestand\n0000000042\t05.01.2023\t\t30');
  assert.equal(z.length, 2);
  assert.deepEqual([z[0].person, z[0].ausgabe, z[0].ausgegeben_von, z[0].pfand, z[0].rueckgabe, z[0].empfangen_von, z[0].doc_ausgabe, z[0].doc_rueckgabe, z[0].bemerkung],
    ['Max Muster', '2019-10-01', 'Ben H.', 25, '2022-03-15', 'Anna V.', 501, 502, 'Altbestand']);
  assert.deepEqual(z[0].fehler, []);
  assert.deepEqual([z[1].person, z[1].ausgabe, z[1].pfand, z[1].rueckgabe], ['0000000042', '2023-01-05', 30, null]);
});

test('Altdaten mit Kopfzeile: Spalten in beliebiger Reihenfolge, Semikolon, Fehler je Zeile', () => {
  const z = altdatenLesen('Rückgabe am;Name;Pfand;Ausgabe am;Beleg Rückgabe\n01.02.2020;Mia Matchball;20;01.03.2020;77\n;Tom Tiebreak;x;;\n;;;01.01.2020;');
  assert.equal(z.length, 3);
  assert.deepEqual([z[0].person, z[0].ausgabe, z[0].rueckgabe, z[0].doc_rueckgabe], ['Mia Matchball', '2020-03-01', '2020-02-01', 77]);
  assert.deepEqual(z[0].fehler, ['Die Rückgabe liegt vor der Ausgabe']);
  assert.ok(z[1].fehler.some((f) => /kein Betrag/.test(f)));
  assert.deepEqual(z[2].fehler, ['Person fehlt']);
});

test('Quittung überfällig erst nach der Frist', () => {
  const v = { art: 'AUSGABE', status: 'WARTET', datum: '2026-11-01' };
  assert.equal(quittungUeberfaellig(v, '2026-11-08', 7), false);
  assert.equal(quittungUeberfaellig(v, '2026-11-09', 7), true);
  assert.equal(quittungUeberfaellig({ ...v, status: 'QUITTIERT' }, '2026-12-01', 7), false);
  assert.equal(quittungUeberfaellig({ ...v, art: 'RUECKGABE' }, '2026-12-01', 7), false);
});

test('FI-Abgleich: Name im Buchungstext, Betrag, Datum, Rechnung', () => {
  assert.equal(normText('Jörg Groß-Müller'), 'JOERG GROSS MUELLER');
  assert.equal(nameImText('Lea Lob', 'Schluesselpfand LOB, LEA bar'), 2);
  assert.equal(nameImText('Lea Lob', 'Pfand Lob'), 1);
  assert.equal(nameImText('Lea Lob', 'Pfand Lobinger'), 0, 'nur ganze Wörter');
  const vorgaenge = [
    { id: 1, art: 'AUSGABE', person: 'Lea Lob', datum: '2019-10-01', pfand: 25, rgnr: null },
    { id: 2, art: 'RUECKGABE', person: 'Lea Lob', datum: '2022-03-15', pfand: 25, rgnr: null },
    { id: 3, art: 'AUSGABE', person: 'Tom Lob', datum: '2019-10-02', pfand: 25, rgnr: '2019_007' },
  ];
  let t = abgleichTreffer({ datum: '2019-10-03', betrag: 25, richtung: 'AUSGABE', text: 'Schlüsselpfand Lea Lob', rgnr: null }, vorgaenge);
  assert.deepEqual(t.map((x) => x.id), [1, 3], 'voller Name vor nur Nachname');
  assert.equal(abgleichEindeutig(t), false, 'gleicher Nachname, ähnliches Datum: bitte wählen');
  t = abgleichTreffer({ datum: '2022-03-20', betrag: 25, richtung: 'RUECKGABE', text: 'Pfand zurück Lob', rgnr: null }, vorgaenge);
  assert.deepEqual(t.map((x) => x.id), [2]);
  assert.equal(abgleichEindeutig(t), true);
  t = abgleichTreffer({ datum: '2019-11-20', betrag: 25, richtung: 'AUSGABE', text: 'Zahlung Rechnung', rgnr: '2019_007' }, vorgaenge);
  assert.deepEqual(t.map((x) => x.id), [3], 'über die Rechnung auch ohne Namen');
  assert.deepEqual(abgleichTreffer({ datum: '2019-10-01', betrag: 40, richtung: 'AUSGABE', text: 'Hallenmiete Lob', rgnr: null }, vorgaenge), [], 'anderer Betrag, nur Nachname');
  assert.deepEqual(abgleichTreffer({ datum: '2019-10-01', betrag: 25, richtung: 'AUSGABE', text: 'Pfand bar', rgnr: null }, vorgaenge), [], 'ohne Namen kein Vorschlag');
});

test('Strg+V: Text in ein Eingabefeld einfügen legt das von Excel mitkopierte Bild nicht ab', async () => {
  const { einfuegenAblegen, imEingabefeld } = await import('../../web/src/ablage-regel.js');
  assert.equal(imEingabefeld([{ tagName: 'TEXTAREA' }, { tagName: 'UI5-TEXTAREA' }, { tagName: 'DIV' }]), true);
  assert.equal(imEingabefeld([{ tagName: 'DIV', isContentEditable: true }]), true);
  assert.equal(imEingabefeld([{ tagName: 'DIV' }, { tagName: 'BODY' }]), false);
  assert.equal(einfuegenAblegen(1, 'Max Muster\t01.10.2019', true), false, 'Excel-Zellen ins Textfeld: nur der Text');
  assert.equal(einfuegenAblegen(1, '', true), true, 'Screenshot (ohne Text) wird abgelegt, auch aus einem Feld heraus');
  assert.equal(einfuegenAblegen(1, 'Text', false), true, 'außerhalb eines Feldes wie bisher');
  assert.equal(einfuegenAblegen(0, 'Text', true), false);
});
