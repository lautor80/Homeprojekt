/**
 * Formatierte Protokolltexte der Vorstandssitzungen (modules/tco/server/vorstand/format.ts) – reine Logik ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkPruefen, schlichterText, textLesen, zeileLesen } from '../../modules/tco/server/vorstand/format.js';

test('Zeile: fett, kursiv, durchgestrichen, verschachtelt', () => {
  assert.deepEqual(zeileLesen('Das ist **fett mit *kursiv*** und ~~weg~~.'), [
    { text: 'Das ist ' }, { text: 'fett mit ', fett: true }, { text: 'kursiv', fett: true, kursiv: true }, { text: ' und ' }, { text: 'weg', durch: true }, { text: '.' },
  ]);
  assert.deepEqual(zeileLesen('_kursiv_ und snake_case_wort bleibt'), [{ text: 'kursiv', kursiv: true }, { text: ' und snake_case_wort bleibt' }]);
  assert.deepEqual(zeileLesen('3 * 4 * 5 und ** nichts'), [{ text: '3 * 4 * 5 und ** nichts' }], 'einzelne Sternchen mit Leerzeichen bleiben Text');
});

test('Zeile: Verknüpfungen mit Bezeichnung und freie Adressen, nur http(s)/mailto', () => {
  assert.deepEqual(zeileLesen('siehe [Angebot **B**](https://x.de/a?b=1), www.tc-oberthal.de. und https://nuliga.de/x)'), [
    { text: 'siehe ' }, { text: 'Angebot ', href: 'https://x.de/a?b=1' }, { text: 'B', href: 'https://x.de/a?b=1', fett: true }, { text: ', ' },
    { text: 'www.tc-oberthal.de', href: 'https://www.tc-oberthal.de' }, { text: '. und ' }, { text: 'https://nuliga.de/x', href: 'https://nuliga.de/x' }, { text: ')' },
  ]);
  assert.deepEqual(zeileLesen('[böse](javascript:alert(1))'), [{ text: '[böse](javascript:alert(1))' }], 'kein Link mit javascript:');
  assert.deepEqual(zeileLesen('[Mail](mailto:vorstand@tc-oberthal.de)'), [{ text: 'Mail', href: 'mailto:vorstand@tc-oberthal.de' }]);
});

test('Text: Absätze, Aufzählung, nummerierte Liste, Fortsetzungszeile', () => {
  assert.deepEqual(textLesen('Zeile eins\nZeile zwei\n\n- Punkt **a**\n- Punkt b\n  weiter\n3. drei\n4. vier\n\nEnde'), [
    { art: 'absatz', zeilen: [[{ text: 'Zeile eins' }], [{ text: 'Zeile zwei' }]] },
    { art: 'liste', nummeriert: false, start: 1, punkte: [[{ text: 'Punkt ' }, { text: 'a', fett: true }], [{ text: 'Punkt b weiter' }]] },
    { art: 'liste', nummeriert: true, start: 3, punkte: [[{ text: 'drei' }], [{ text: 'vier' }]] },
    { art: 'absatz', zeilen: [[{ text: 'Ende' }]] },
  ]);
  assert.deepEqual(textLesen(''), []);
  assert.deepEqual(textLesen(null), []);
  assert.equal(schlichterText('**Fett**\n- a [x](https://y.de)\n1. b'), 'Fett\n\n– a x\n\n1. b');
});

test('Link-Anlage: Adresse prüfen', () => {
  assert.equal(linkPruefen('https://www.tc-oberthal.de/a b'), 'https://www.tc-oberthal.de/a%20b');
  assert.equal(linkPruefen('www.nuliga.de'), 'https://www.nuliga.de/');
  for (const x of ['javascript:alert(1)', 'ftp://x.de', 'https://intern', 'kein link', '']) assert.equal(linkPruefen(x), null, x);
});
