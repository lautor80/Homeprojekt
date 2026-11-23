/**
 * Spielbericht (Sport → Spielberichte): Wertung der Spiele, Prüfungen der Aufstellung, Sieger, Meldeliste und Saison –
 * reine Logik ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  berichtWerten, ergebnisText, formatAnpassen, leererBericht, leeresMatch, matchWerten, saisonZu, vereinUndNummer,
  type SbDaten, type SbMatch, type SbSpieler,
} from '../../modules/tco/server/sport/spielbericht-logik.js';
import * as wertung from '../../modules/tco/server/turnier/wertung.js';
import * as sb from '../../modules/tco/server/sport/spielbericht-logik.js';
import { konkurrenzZurLiga, lkAus, meldelisteLesen } from '../../modules/tco/server/sport/meldeliste.js';

type Satz = [number | null, number | null];
const LEER: Satz = [null, null];
const m = (saetze: Satz[], extra: Partial<SbMatch> = {}): SbMatch => ({ ...leeresMatch(false), saetze: [...saetze, LEER, LEER, LEER].slice(0, 3), ...extra });
const sp = (rang: number, name: string, mannschaft: number | null = 1): SbSpieler => ({ rang, name, id_nr: String(18000000 + rang), mannschaft });

test('Match: gespielt in zwei Sätzen, mit Match-Tiebreak, laufend', () => {
  assert.deepEqual(matchWerten(m([[6, 2], [6, 3]])), { status: 'fertig', sieger: 'a', saetze: [2, 0], spiele: [12, 5], satzFehler: [false, false, false], fehler: null, mtbNoetig: false });
  const mtb = matchWerten(m([[6, 4], [3, 6], [8, 10]]));
  assert.equal(mtb.sieger, 'b');
  assert.deepEqual(mtb.saetze, [1, 2]);
  assert.deepEqual(mtb.spiele, [9, 11], 'Match-Tiebreak zählt 1 Spiel');
  assert.equal(matchWerten(m([[6, 1], [5, null]])).status, 'laeuft');
  assert.equal(matchWerten(m([[6, 4], [3, 6]])).mtbNoetig, true);
  assert.equal(matchWerten(m([])).status, 'offen');
});

test('Match: ungültige Eingaben werden markiert', () => {
  const a = matchWerten(m([[6, 5], [6, 3]]));
  assert.equal(a.status, 'fehler');
  assert.deepEqual(a.satzFehler, [true, false, false]);
  const b = matchWerten(m([[6, 2], [6, 3], [10, 4]]));
  assert.equal(b.status, 'fehler');
  assert.match(b.fehler!, /nur bei 1:1/);
  assert.equal(matchWerten(m([[6, 2], [3, 6], [10, 9]])).status, 'fehler', 'MTB braucht 2 Punkte Abstand');
  assert.equal(matchWerten(m([[7, 6], [6, 7], [12, 10]])).status, 'fertig');
});

test('Match: kampflos und Aufgabe', () => {
  const wo = matchWerten(m([], { wertung: 'wo', sieger: 'b' }));
  assert.deepEqual([wo.sieger, wo.saetze, wo.spiele], ['b', [0, 2], [0, 12]]);
  assert.equal(matchWerten(m([], { wertung: 'wo' })).status, 'laeuft', 'ohne Sieger noch nicht fertig');
  // Aufgabe Gast bei 6:3 2:1 → Heim bekommt den 2. Satz als 6:1
  const a = matchWerten(m([[6, 3], [2, 1]], { wertung: 'aufgabe', sieger: 'a' }));
  assert.deepEqual([a.status, a.saetze, a.spiele], ['fertig', [2, 0], [12, 4]]);
  // Aufgabe Heim bei 3:6 6:5 → Gast gewinnt, der 2. Satz wird für ihn zu 7:6 gezählt
  const b = matchWerten(m([[3, 6], [6, 5]], { wertung: 'aufgabe', sieger: 'b' }));
  assert.deepEqual([b.saetze, b.spiele], [[0, 2], [9, 13]]);
  // Aufgabe nach 1:1 vor dem Match-Tiebreak → Match-Tiebreak 1:0
  const c = matchWerten(m([[6, 3], [4, 6]], { wertung: 'aufgabe', sieger: 'b' }));
  assert.deepEqual([c.saetze, c.spiele], [[1, 2], [10, 10]]);
  // Aufgabe im ersten Satz → fehlender Satz 6:0
  const d = matchWerten(m([[1, 2]], { wertung: 'aufgabe', sieger: 'b' }));
  assert.deepEqual([d.saetze, d.spiele], [[0, 2], [1, 12]]);
  assert.equal(matchWerten(m([[6, 3], [6, 2]], { wertung: 'aufgabe', sieger: 'b' })).status, 'fehler', 'schon entschieden');
  assert.equal(ergebnisText(m([[6, 3], [2, 1]], { wertung: 'aufgabe', sieger: 'a' })), '6:3 2:1 Aufg.');
});

function bericht(): SbDaten {
  const d = leererBericht('6er');
  d.beginn = '11:00'; d.ende = '17:30';
  const erg: [number, number][][] = [[[6, 4], [6, 4]], [[6, 2], [6, 3]], [[4, 6], [6, 7]], [[7, 5], [6, 4]], [[2, 6], [6, 3], [8, 10]], [[6, 1], [6, 0]]];
  d.einzel.forEach((x, i) => { x.a = [sp(i + 1, `Heim ${i + 1}`)]; x.b = [sp(i + 1, `Gast ${i + 1}`)]; x.saetze = [...erg[i], LEER, LEER].slice(0, 3); });
  const paare = [[1, 3], [2, 4], [5, 6]];
  d.doppel.forEach((x, i) => {
    x.a = paare[i].map((r) => sp(r, `Heim ${r}`)); x.b = paare[i].map((r) => sp(r, `Gast ${r}`));
    x.saetze = [[6, 3], [6, 4], [null, null]];
  });
  return d;
}

test('Bericht: Summen, Sieger und Prüfungen', () => {
  const r = berichtWerten(bericht());
  assert.deepEqual(r.summeEinzel.punkte, [4, 2]);
  assert.deepEqual(r.summe.punkte, [7, 2]);
  assert.equal(r.sieger, 'a');
  assert.equal(r.vollstaendig, true, JSON.stringify(r.pruefungen.filter((p) => !p.ok)));
  assert.equal(r.fertig, 9);
});

test('Bericht: Reihenfolge, doppelte Spieler, Doppel-Summen, Mannschaft', () => {
  const d = bericht();
  [d.einzel[0].a[0], d.einzel[1].a[0]] = [d.einzel[1].a[0], d.einzel[0].a[0]];
  d.doppel[1].b = [sp(1, 'Gast 1'), sp(2, 'Gast 2')];          // Gast 1 in zwei Doppeln, Summe 3 nach 4
  d.einzel[5].b[0] = { ...sp(7, 'Gast 7'), mannschaft: 1 };
  const r = berichtWerten(d, { b: 2 });
  const p = Object.fromEntries(r.pruefungen.map((x) => [x.id, x.ok]));
  assert.equal(p.einzel_reihe, false);
  assert.equal(p.doppel_voll, false);
  assert.equal(p.doppel_reihe, false);
  assert.ok(r.hinweiseEinzel.some((h) => h.includes('Gast 7') && h.includes('1. Mannschaft')));
  assert.equal(r.vollstaendig, false);
  // unentschieden nach Punkten → Sätze entscheiden; Sieger steht vorzeitig fest
  const e = leererBericht('4er');
  e.einzel.forEach((x) => { x.saetze = [[6, 0], [6, 0], [null, null]]; });
  const r2 = berichtWerten(e);
  assert.equal(r2.anzahl, 6);
  assert.equal(r2.entschieden, true);
  assert.equal(r2.sieger, 'a');
});

test('Format wechseln, Saison, Verein und Mannschaft', () => {
  const d = formatAnpassen(bericht(), '4er');
  assert.equal(d.einzel.length, 4);
  assert.equal(d.doppel.length, 2);
  assert.equal(formatAnpassen(d, '6er').einzel[5].a[0], null);
  assert.equal(saisonZu('2026-05-16'), 'Sommer 2026');
  assert.equal(saisonZu('2026-11-28'), 'Winter 2026/27');
  assert.equal(saisonZu('2027-02-06'), 'Winter 2026/27');
  assert.deepEqual(vereinUndNummer('TC Oberthal 2'), { verein: 'TC Oberthal', nr: 2 });
  assert.deepEqual(vereinUndNummer('TV Ensheim II'), { verein: 'TV Ensheim', nr: 2 });
  assert.deepEqual(vereinUndNummer('TC Blau-Weiß St. Ingbert'), { verein: 'TC Blau-Weiß St. Ingbert', nr: 1 });
});

test('Meldeliste: mit Kopfzeile (Tabulator), ohne Kopfzeile (Markdown), Überschrift als Konkurrenz', () => {
  const mitKopf = meldelisteLesen([
    'Herren 40',
    'Rang\tMannschaft\tLK\tID-Nummer\tName, Vorname\tNation',
    '1\t1\tLK 8,4\t17845502\tVogel, Andreas\tGER',
    '2\t1\tLK 10,2\t18001239\tFrank, Christian\tGER',
    '3\t2\tLK 14\t18160884\tRoth, Sebastian\tAUT',
  ].join('\n'));
  assert.equal(mitKopf.konkurrenz, 'Herren 40');
  assert.equal(mitKopf.spieler.length, 3);
  assert.deepEqual(mitKopf.spieler[2], { zeile: 5, rang: 3, mannschaft: 2, nachname: 'Roth', vorname: 'Sebastian', id_nr: '18160884', lk: 14, nation: 'AUT' });
  const ohne = meldelisteLesen([
    '| 2 | 1 | LK 12,0 | 18120477 | Weber, Markus | GER |',
    '|---|---|---|---|---|---|',
    '| 1 | 1 | LK 9,5 | 18034521 | Hoffmann, Jan | GER |',
    'Summe 2 Spieler',
    '| 1 | 1 | LK 9,0 | 18999999 | Doppelt, Dora | GER |',
  ].join('\n'));
  assert.deepEqual(ohne.spieler.map((s) => [s.rang, s.nachname, s.lk]), [[1, 'Hoffmann', 9.5], [1, 'Doppelt', 9], [2, 'Weber', 12]]);
  assert.equal(ohne.fehler.length, 1);
  assert.match(ohne.fehler[0].text, /Rang 1 kommt doppelt/);
  assert.equal(ohne.ignoriert, 1);
  assert.equal(lkAus('LK25'), 25);
  assert.equal(lkAus('abc'), null);
  const listen = [{ konkurrenz: 'Herren' }, { konkurrenz: 'Herren 40' }, { konkurrenz: 'Damen 40' }];
  assert.equal(konkurrenzZurLiga('Herren 40 Verbandsliga', listen)?.konkurrenz, 'Herren 40');
  assert.equal(konkurrenzZurLiga('Herren 1. Bezirksliga', listen)?.konkurrenz, 'Herren');
  assert.equal(konkurrenzZurLiga('Herren 400', [{ konkurrenz: 'Herren 40' }]), null);
});

test('Satzprüfung entspricht den Turnieren (turnier/wertung.ts)', () => {
  for (let x = 0; x <= 14; x++) for (let y = 0; y <= 14; y++) {
    assert.equal(sb.satzSieger([x, y]), wertung.satzSieger([x, y]), `Satz ${x}:${y}`);
    assert.equal(sb.tiebreakSieger([x, y]), wertung.tiebreakSieger([x, y]), `MTB ${x}:${y}`);
  }
});
