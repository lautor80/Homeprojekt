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

test('Verantwortliche immer mit Vornamen: Kürzel, Nach- und Vornamen, mehrere, Unklares bleibt', async () => {
  const { verantwortlicheAnzeigen } = await import('../../modules/tco/server/vorstand/regeln.js');
  const P = [
    { adrnr: '1', vorname: 'Torsten', nachname: 'Laub' }, { adrnr: '2', vorname: 'Christian', nachname: 'Kasper' },
    { adrnr: '3', vorname: 'Jan', nachname: 'Weißing' }, { adrnr: '4', vorname: 'Konstantin', nachname: 'Born' },
    { adrnr: '5', vorname: 'Johannes', nachname: 'Haab' }, { adrnr: '6', vorname: 'Benjamin', nachname: 'Hartyniuk' },
  ];
  assert.equal(verantwortlicheAnzeigen('weiß, kas, laub', P), 'Jan Weißing, Christian Kasper, Torsten Laub');
  assert.equal(verantwortlicheAnzeigen('laub', P), 'Torsten Laub');
  assert.equal(verantwortlicheAnzeigen('jan', P), 'Jan Weißing', 'Vorname');
  assert.equal(verantwortlicheAnzeigen('kons', P), 'Konstantin Born', 'Anfang des Vornamens');
  assert.equal(verantwortlicheAnzeigen('Laub, Torsten', P), 'Torsten Laub', '„Nachname, Vorname“ ist eine Person');
  assert.equal(verantwortlicheAnzeigen('Torsten Laub und born', P), 'Torsten Laub, Konstantin Born');
  assert.equal(verantwortlicheAnzeigen('ha', P), 'ha', 'mehrdeutig (Haab, Hartyniuk) bleibt');
  assert.equal(verantwortlicheAnzeigen('Platzwart', P), 'Platzwart');
  assert.equal(verantwortlicheAnzeigen('laub / Laub', P), 'Torsten Laub', 'doppelt nur einmal');
  assert.equal(verantwortlicheAnzeigen('  ', P), null);
});

// ---- Editor: gespeicherter Text ↔ bearbeitbarer Bereich (contenteditable), DOM im Test nachgebaut
import { knotenZuText, textZuKnoten, type DomKnoten, type Knoten } from '../../modules/tco/server/vorstand/format.js';

type El = { tag: string; attr?: Record<string, string>; style?: DomKnoten['style']; kinder?: (El | string)[] };
function dom(x: El | string): DomKnoten {
  if (typeof x === 'string') return { nodeType: 3, nodeName: '#text', textContent: x, childNodes: [] };
  return { nodeType: 1, nodeName: x.tag.toUpperCase(), textContent: null, childNodes: (x.kinder ?? []).map(dom), getAttribute: (n) => x.attr?.[n] ?? null, style: x.style ?? {} };
}
const ausKnoten = (k: Knoten): El | string => (typeof k === 'string' ? k
  : { tag: k.tag, attr: { ...(k.href ? { href: k.href } : {}), ...(k.start ? { start: String(k.start) } : {}) }, kinder: k.kinder.map(ausKnoten) });
const rund = (t: string) => knotenZuText(textZuKnoten(t).map(ausKnoten).map(dom));

test('Editor: gespeicherter Text bleibt nach dem Aufbau im Editor gleich', () => {
  for (const t of [
    'Zwei Angebote liegen vor.',
    'Zeile eins\nZeile zwei\n\nNeuer Absatz',
    '**Ergebnis:** Angebot *B* ist ~~teurer~~ günstiger.',
    '- Ausführung im **März**\n- Details: [Angebot](https://www.tc-oberthal.de/angebot) und https://www.nuliga.de\n1. erstens\n2. zweitens',
    'Text davor\n- a\n- b\n\nText danach',
    '3. drei\n4. vier',
    '**fett mit *kursiv***',
    'siehe www.tc-oberthal.de',
  ]) assert.equal(rund(t), t, t);
  assert.equal(rund('- a\n  weiter'), '- a weiter', 'Fortsetzungszeile wird Teil des Punkts');
  assert.equal(rund(''), '');
});

test('Editor: typische Browser-Strukturen → gespeicherter Text', () => {
  const t = (...k: (El | string)[]) => knotenZuText(k.map(dom));
  // erste Zeile als freier Text, weitere als div; leere Zeile = div mit br
  assert.equal(t('Erste', { tag: 'div', kinder: ['Zweite'] }, { tag: 'div', kinder: [{ tag: 'br' }] }, { tag: 'div', kinder: ['Dritte'] }), 'Erste\nZweite\n\nDritte');
  // Fett über b, strong und Inline-Stil; Leerzeichen am Rand außerhalb der Zeichen
  assert.equal(t({ tag: 'div', kinder: ['Das ', { tag: 'b', kinder: ['ist '] }, { tag: 'strong', kinder: ['wichtig'] }, '.'] }), 'Das **ist wichtig**.');
  assert.equal(t({ tag: 'div', kinder: [{ tag: 'span', style: { fontWeight: '700' }, kinder: ['F'] }, { tag: 'span', style: { fontStyle: 'italic' }, kinder: ['K'] }, { tag: 'span', style: { textDecorationLine: 'line-through' }, kinder: ['D'] }] }), '**F***K*~~D~~');
  // Aufzählung mit Formatierung und Link, nummerierte Liste mit Start
  assert.equal(t({ tag: 'ul', kinder: [{ tag: 'li', kinder: [{ tag: 'b', kinder: ['a'] }] }, { tag: 'li', kinder: [{ tag: 'a', attr: { href: 'https://x.de' }, kinder: ['Link'] }] }] },
    { tag: 'ol', attr: { start: '2' }, kinder: [{ tag: 'li', kinder: ['zwei'] }, { tag: 'li', kinder: ['drei'] }] }), '- **a**\n- [Link](https://x.de)\n2. zwei\n3. drei');
  // br in einer Zeile trennt, abschließendes br ist nur Platzhalter; unsichere Links werden Text
  assert.equal(t({ tag: 'div', kinder: ['a', { tag: 'br' }, 'b', { tag: 'br' }] }), 'a\nb');
  assert.equal(t({ tag: 'div', kinder: [{ tag: 'a', attr: { href: 'javascript:alert(1)' }, kinder: ['x'] }] }), 'x');
  // verschachtelte Liste wird flach, geschütztes Leerzeichen wird normales
  assert.equal(t({ tag: 'ul', kinder: [{ tag: 'li', kinder: ['a', { tag: 'ul', kinder: [{ tag: 'li', kinder: ['b'] }] }] }] }), '- a\n- b');
  assert.equal(t({ tag: 'div', kinder: ['a b'] }), 'a b');
});
