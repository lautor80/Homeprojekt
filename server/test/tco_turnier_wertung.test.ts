/**
 * Turniere: Ergebnisprüfung (2 Gewinnsätze, Match-Tiebreak bis 10), kampflos, Aufgabe, Spaßturnier, Bilanzen und Stärke-Rangliste.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bilanzen, einzelAuswerten, ergebnisText, spassAuswerten, satzSieger, tiebreakSieger } from '../../modules/tco/server/turnier/wertung.js';
import { nachStaerke } from '../../modules/tco/server/turnier/daten.js';

test('Sätze: 6:0 bis 6:4, 7:5, 7:6 gültig – 6:5, 7:4, 8:6 nicht', () => {
  for (const s of [[6, 0], [6, 4], [7, 5], [7, 6], [4, 6], [6, 7]] as [number, number][]) assert.ok(satzSieger(s), `${s}`);
  for (const s of [[6, 5], [7, 4], [8, 6], [5, 3], [7, 7]] as [number, number][]) assert.equal(satzSieger(s), null, `${s}`);
});

test('Match-Tiebreak: bis 10 mit 2 Punkten Abstand', () => {
  assert.equal(tiebreakSieger([10, 8]), 'a');
  assert.equal(tiebreakSieger([12, 14]), 'b');
  assert.equal(tiebreakSieger([10, 9]), null);
  assert.equal(tiebreakSieger([9, 7]), null);
  assert.equal(tiebreakSieger([13, 9]), null, 'über 10 nur mit genau 2 Punkten Abstand');
});

test('Einzel: Zwei-Satz-Sieg, Sieg im Match-Tiebreak, Spiele zählen MTB als 1:0', () => {
  assert.deepEqual(einzelAuswerten('gespielt', [[6, 4], [6, 3]]), { sieger: 'a', saetze: [2, 0], spiele: [12, 7] });
  assert.deepEqual(einzelAuswerten('gespielt', [[6, 4], [3, 6], [8, 10]]), { sieger: 'b', saetze: [1, 2], spiele: [9, 11] });
});

test('Einzel: unvollständig oder falsch → verständliche Meldung', () => {
  assert.throws(() => einzelAuswerten('gespielt', [[6, 4], [3, 6]]), /Match-Tiebreak eintragen/);
  assert.throws(() => einzelAuswerten('gespielt', [[6, 5], [6, 3]]), /Satz 1 6:5/);
  assert.throws(() => einzelAuswerten('gespielt', [[6, 4], [6, 3], [10, 2]]), /schon entschieden/);
  assert.throws(() => einzelAuswerten('gespielt', [[6, 4], [3, 6], [10, 9]]), /Match-Tiebreak 10:9/);
});

test('Kampflos zählt 6:0 6:0, Aufgabe mit Sieger, keine Wertung zählt für niemanden', () => {
  assert.deepEqual(einzelAuswerten('wo', null, 'b'), { sieger: 'b', saetze: [0, 2], spiele: [0, 12] });
  assert.throws(() => einzelAuswerten('wo', null, null), /wer gewinnt/);
  assert.deepEqual(einzelAuswerten('aufgabe', [[6, 4], [2, 1]], 'a'), { sieger: 'a', saetze: [1, 0], spiele: [8, 5] });
  assert.deepEqual(einzelAuswerten('keine', null), { sieger: null, saetze: [0, 0], spiele: [0, 0] });
});

test('Spaßturnier: Spiele je Team, Unentschieden möglich', () => {
  assert.equal(spassAuswerten(5, 3).sieger, 'a');
  assert.equal(spassAuswerten(4, 4).sieger, 'x');
  assert.throws(() => spassAuswerten(-1, 3), /ganze Zahl/);
});

test('Bilanzen: Einzel und Doppel, Siegquote mit halben Unentschieden', () => {
  const m = bilanzen([
    { feld: 'gruppe', a: [1], b: [2], saetze: [[6, 4], [6, 4]], wertung: 'gespielt', sieger: 'a' },
    { feld: 'gruppe', a: [1], b: [3], saetze: null, wertung: 'wo', sieger: 'b' },
    { feld: 'gruppe', a: [2], b: [3], saetze: null, wertung: 'keine', sieger: null },
    { feld: 'runde', a: [1, 2], b: [3, 4], saetze: [[4, 4]], wertung: 'gespielt', sieger: 'x' },
  ], [1, 2, 3, 4, 5]);
  const b1 = m.get(1)!;
  assert.deepEqual([b1.spiele, b1.siege, b1.niederlagen, b1.unentschieden], [3, 1, 1, 1]);
  assert.equal(b1.quote, 0.5);
  assert.deepEqual(b1.saetze, [2, 2]);
  assert.deepEqual(b1.spielstand, [12 + 0 + 4, 8 + 12 + 4]);
  assert.equal(m.get(5)!.spiele, 0);
  assert.equal(m.get(3)!.siege, 1);
});

test('Ergebnistext aus Sicht der Seite', () => {
  const s = { saetze: [[6, 4], [3, 6], [10, 8]] as [number, number][], wertung: 'gespielt' as const, sieger: 'a' as const };
  assert.equal(ergebnisText(s), '6:4 3:6 10:8');
  assert.equal(ergebnisText(s, 'b'), '4:6 6:3 8:10');
  assert.equal(ergebnisText({ saetze: null, wertung: 'wo', sieger: 'a' }), 'w.o.');
});

test('Stärke-Rangliste: LK aufsteigend, ohne LK ans Ende; manuell nach Rang', () => {
  const t = (id: number, lk: number | null, rang: number | null) => ({ id, lk, rang, angemeldet_am: `2027-01-0${id}` });
  const liste = [t(1, null, 1), t(2, 12.4, 3), t(3, 8.0, null), t(4, 12.4, 2)];
  assert.deepEqual(nachStaerke(liste, 'lk').map((x) => x.id), [3, 4, 2, 1]);
  assert.deepEqual(nachStaerke(liste, 'manuell').map((x) => x.id), [1, 4, 2, 3]);
});
