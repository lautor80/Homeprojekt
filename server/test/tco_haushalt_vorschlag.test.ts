/**
 * Haushaltsplan – Rechenkern (modules/tco/server/haushalt/vorschlag.ts): reine Funktionen ohne Datenbank.
 * Methoden, Jahresverlauf, Hochrechnung, rückwirkende Prüfung, Ausreißer, Preissteigerung, Monatsverteilung,
 * Bewertung und Liquidität – jeweils mit den Randfällen (leere Historie, ein Jahr, Nullwerte, Division durch 0,
 * Konto nur in manchen Jahren aktiv).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aufgelaufen, ausreisser, besteMethode, bewerten, GLEICHMAESSIG, hochrechnen, jahresverlauf, liquiditaet, median, methodenWerte, mittel,
  monatsverteilung, planwertAus, rueckpruefung, rundenPlan, treffer, trend, type JahrMonate,
} from '../../modules/tco/server/haushalt/vorschlag.js';

const gleich = (jahreswert: number) => Array.from({ length: 12 }, () => jahreswert / 12);
/** Jahr mit Jahreswert nach einem Verlauf (Anteile je Monat) */
const jahr = (j: number, wert: number, profil: number[] = GLEICHMAESSIG): JahrMonate => ({ jahr: j, monate: profil.map((p) => wert * p) });
const WINTER = [0.16, 0.14, 0.11, 0.06, 0.04, 0.03, 0.03, 0.03, 0.05, 0.09, 0.12, 0.14];
const nah = (a: number | null, b: number, eps = 0.01) => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('Mittel, Median, Trend – auch leer, ein Wert, gleiche Werte', () => {
  assert.equal(mittel([]), null);
  assert.equal(median([]), null);
  assert.equal(mittel([10, 20, 60]), 30);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 100]), 2.5);
  // Trend: lineare Fortschreibung um ein Jahr
  assert.equal(trend([100, 110, 120]), 130);
  assert.equal(trend([100, 100, 100, 100]), 100);
  nah(trend([38200, 39100, 40400, 41800, 43100]), 44270);
  // unter drei Werten kein Trend, fallende Reihe nie unter 0
  assert.equal(trend([]), null);
  assert.equal(trend([100]), null);
  assert.equal(trend([100, 200]), null);
  assert.equal(trend([300, 150, 0]), 0);
  assert.equal(trend([0, 0, 0]), 0);
});

test('Jahresverlauf: Anteile je Monat über die Jahre gemittelt, Jahre ohne Wert zählen nicht', () => {
  assert.equal(jahresverlauf([]), null);
  assert.equal(jahresverlauf([gleich(0)]), null);
  const p = jahresverlauf([jahr(1, 1000, WINTER).monate, jahr(2, 5000, WINTER).monate, gleich(0)])!;
  p.forEach((x, i) => nah(x, WINTER[i], 1e-9));
  nah(p.reduce((s, x) => s + x, 0), 1, 1e-9);
  // jedes Jahr zählt gleich – unabhängig von seiner Höhe
  const halb = [0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0];
  const q = jahresverlauf([jahr(1, 100, halb).monate, jahr(2, 100000, GLEICHMAESSIG).monate])!;
  nah(q[0], (0.5 + 1 / 12) / 2, 1e-9);
  // Storno über den Monatswechsel: negativer Monat zählt als 0, die Anteile ergeben wieder 1
  const s = jahresverlauf([[100, -20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20]])!;
  assert.equal(s[1], 0);
  nah(s.reduce((a, x) => a + x, 0), 1, 1e-9);
  // falsche Länge wird übergangen
  assert.equal(jahresverlauf([[1, 2, 3]]), null);
});

test('Hochrechnung: über den Jahresverlauf statt linear; kleine Anteile, kein Verlauf, nichts gebucht', () => {
  // Energie: bis Oktober sind üblicherweise 74 % des Jahres angefallen → 7.400 ÷ 0,74 = 10.000 (linear wären es 8.880)
  const h = hochrechnen(7400, 10, WINTER, 9000)!;
  assert.equal(h.art, 'VERLAUF');
  nah(h.wert, 10000);
  nah(h.anteil, 0.74, 1e-9);
  nah((7400 * 12) / 10, 8880);
  // Jahr vollständig: Ist
  assert.deepEqual(hochrechnen(1234.5, 12, WINTER, 1), { wert: 1234.5, art: 'IST', anteil: 1 });
  // kein gebuchter Monat: keine Hochrechnung
  assert.equal(hochrechnen(0, 0, WINTER, 100), null);
  // ohne Jahresverlauf (neues Konto): gleichmäßig
  assert.deepEqual(hochrechnen(500, 5, null, null), { wert: 1200, art: 'LINEAR', anteil: 5 / 12 });
  // Verbandsabgabe fällt im März an, Stand Februar: Anteil 0 – nicht teilen, sondern den üblichen Rest erwarten
  const maerz = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.deepEqual(hochrechnen(0, 2, maerz, 3000), { wert: 3000, art: 'REST', anteil: 0 });
  // kleiner Anteil (10 %): Ist + 90 % des Üblichen statt Ist × 10
  nah(hochrechnen(900, 2, [0.05, 0.05, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0], 2000)!.wert, 900 + 1800);
  // Anteil 0 und kein Vergleichswert: nichts zu rechnen
  assert.equal(hochrechnen(0, 2, maerz, null), null);
  // Versicherung im Januar bezahlt: Anteil 1 → Ist
  nah(hochrechnen(4650, 10, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4500)!.wert, 4650);
});

test('Methoden: Durchschnitt 3 Jahre, Median 5 Jahre, Trend, Hochrechnung – das laufende Jahr geht hochgerechnet ein', () => {
  const jahre = [jahr(2091, 9200, WINTER), jahr(2092, 12800, WINTER), jahr(2093, 15900, WINTER), jahr(2094, 14200, WINTER), jahr(2095, 13600, WINTER),
    // 2096 läuft: bis Oktober 9.700 gebucht
    { jahr: 2096, monate: WINTER.map((p, i) => (i < 10 ? (9700 * p) / 0.74 : 0)) }];
  const m = methodenWerte({ jahre, planjahr: 2097, standMonat: 10 });
  assert.equal(m.anzahlJahre, 5);
  nah(m.werte.HOCH, 9700 / 0.74);
  nah(m.hoch!.anteil, 0.74, 1e-9);
  const hoch = 9700 / 0.74;
  nah(m.werte.AVG3, (14200 + 13600 + hoch) / 3);
  nah(m.werte.MED5, 13600);                       // 12800, 15900, 14200, 13600, 13108 → Median 13600
  assert.ok(m.werte.TREND !== null);
  // Basisjahr abgeschlossen: Hochrechnung = Ist
  const voll = methodenWerte({ jahre: jahre.slice(0, 5), planjahr: 2096, standMonat: 12 });
  assert.equal(voll.werte.HOCH, 13600);
  assert.equal(voll.hoch!.art, 'IST');
  // Basisjahr noch ohne Buchung (Stand 0): keine Hochrechnung, die übrigen Methoden rechnen mit den Vorjahren
  const ohne = methodenWerte({ jahre: jahre.slice(0, 5), planjahr: 2097, standMonat: 0 });
  assert.equal(ohne.werte.HOCH, null);
  nah(ohne.werte.AVG3, (15900 + 14200 + 13600) / 3);
});

test('Methoden – Randfälle: leere Historie, ein Jahr, Nullwerte, Konto nur in manchen Jahren aktiv', () => {
  // gar nichts: keine Methode liefert, vorbelegt wird „Manuell“
  const leer = methodenWerte({ jahre: [], planjahr: 2097, standMonat: 10 });
  assert.deepEqual(leer.werte, { HOCH: null, AVG3: null, MED5: null, TREND: null });
  const pLeer = rueckpruefung({ jahre: [], planjahr: 2097, standMonat: 10 });
  assert.deepEqual(pLeer, { treffer: { HOCH: null, AVG3: null, MED5: null, TREND: null }, jahre: [], beste: null });
  assert.equal(besteMethode(leer, pLeer, null), 'MANUELL');

  // neues Konto: nur das laufende Jahr mit fünf Monaten – gleichmäßig hochgerechnet, kein Trend, keine Trefferquote
  const neu = { jahre: [{ jahr: 2096, monate: [100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0] }], planjahr: 2097, standMonat: 5 };
  const mNeu = methodenWerte(neu);
  assert.equal(mNeu.werte.HOCH, 1200);
  assert.equal(mNeu.hoch!.art, 'LINEAR');
  assert.equal(mNeu.werte.TREND, null);
  assert.equal(mNeu.anzahlJahre, 0);
  assert.equal(rueckpruefung(neu).beste, null);
  assert.equal(besteMethode(mNeu, rueckpruefung(neu), null), 'HOCH');

  // ein abgeschlossenes Jahr: Durchschnitt und Median sind dieses Jahr, kein Trend
  const eins = methodenWerte({ jahre: [jahr(2095, 600)], planjahr: 2097, standMonat: 0 });
  assert.deepEqual([eins.werte.HOCH, eins.werte.AVG3, eins.werte.MED5, eins.werte.TREND], [null, 600, 600, null]);
  assert.equal(besteMethode(eins, rueckpruefung({ jahre: [jahr(2095, 600)], planjahr: 2097, standMonat: 0 }), null), 'AVG3');

  // lauter Nullen: alles 0, nichts wird durch 0 geteilt
  const nullen = { jahre: [2092, 2093, 2094, 2095, 2096].map((j) => jahr(j, 0)), planjahr: 2097, standMonat: 10 };
  const mNull = methodenWerte(nullen);
  assert.equal(mNull.profil, null);
  assert.deepEqual([mNull.werte.HOCH, mNull.werte.AVG3, mNull.werte.MED5, mNull.werte.TREND], [0, 0, 0, 0]);
  const pNull = rueckpruefung(nullen);
  // im Herbst liegen vor dem jüngsten Prüfjahr nur zwei abgeschlossene Jahre – der Trend ist dort nicht prüfbar
  assert.deepEqual(pNull.treffer, { HOCH: 100, AVG3: 100, MED5: 100, TREND: null });
  for (const w of Object.values(mNull.werte)) assert.ok(Number.isFinite(w));

  // Konto nur 2091–2092 und wieder ab 2095 aktiv (2093/2094 zählen nicht): gerechnet wird mit den Jahren, die zählen
  const luecke = { jahre: [jahr(2091, 1000), jahr(2092, 1100), jahr(2095, 1300)], planjahr: 2097, standMonat: 0 };
  const mL = methodenWerte(luecke);
  nah(mL.werte.AVG3, (1000 + 1100 + 1300) / 3);
  nah(mL.werte.MED5, 1100);
  // geprüft wird nur ein Jahr, dessen Vorjahr zählt: 2092 (aus 2091) – 2095 nicht (2094 fehlt)
  assert.deepEqual(rueckpruefung(luecke).jahre, [2092]);
});

test('Treffer: 100 − Abweichung in Prozent, nie unter 0, keine Division durch 0', () => {
  assert.equal(treffer(100, 100), 100);
  assert.equal(treffer(90, 100), 90);
  assert.equal(treffer(110, 100), 90);
  assert.equal(treffer(500, 100), 0);
  assert.equal(treffer(0, 0), 100);
  assert.equal(treffer(50, 0), 0);
});

test('Rückwirkende Prüfung: gleichmäßig steigendes Konto → Trend trifft am besten; stabile Reihe mit Ausreißer → Median', () => {
  // +1.000 je Jahr, gleichmäßig über das Jahr
  const steigend = { jahre: [2090, 2091, 2092, 2093, 2094, 2095].map((j, i) => jahr(j, 10000 + i * 1000)), planjahr: 2097, standMonat: 0 };
  const p = rueckpruefung(steigend);
  assert.deepEqual(p.jahre, [2095, 2094, 2093]);
  assert.equal(p.beste, 'TREND');
  assert.equal(p.treffer.TREND, 100);
  assert.ok(p.treffer.AVG3! < p.treffer.HOCH! && p.treffer.HOCH! < 100, JSON.stringify(p.treffer));
  // Vorhersage 2095 aus 2090–2094: Vorjahr 14.000 → 93,3 %; im Mittel der drei Prüfjahre
  nah(p.treffer.HOCH, (treffer(14000, 15000) + treffer(13000, 14000) + treffer(12000, 13000)) / 3, 0.06);
  assert.equal(besteMethode(methodenWerte(steigend), p, null), 'TREND');
  // mit Fachdaten sind diese vorbelegt
  assert.equal(besteMethode(methodenWerte(steigend), p, 12345), 'FACH');

  // stabil um 3.000 mit einem Ausreißer: der Median lässt sich davon nicht beirren
  const stabil = { jahre: [jahr(2089, 3000), jahr(2090, 3100), jahr(2091, 2900), jahr(2092, 3000), jahr(2093, 21400), jahr(2094, 3050), jahr(2095, 3000)], planjahr: 2097, standMonat: 0 };
  const ps = rueckpruefung(stabil);
  assert.equal(ps.beste, 'MED5');
  assert.ok(ps.treffer.MED5! > ps.treffer.AVG3!);

  // zwei abgeschlossene Jahre: keine Trefferquote
  assert.deepEqual(rueckpruefung({ jahre: [jahr(2094, 1), jahr(2095, 2)], planjahr: 2097, standMonat: 0 }).treffer, { HOCH: null, AVG3: null, MED5: null, TREND: null });
});

test('Rückwirkende Prüfung im Herbst: geprüft wird mit dem Stück des Vorjahres, das auch heute vorliegt', () => {
  // Winterkonto, jedes Jahr 10.000. Stand Oktober: Die Hochrechnung trifft, eine lineare Rechnung läge bei 8.880.
  const e = { jahre: [2090, 2091, 2092, 2093, 2094, 2095, 2096].map((j) => jahr(j, 10000, WINTER)), planjahr: 2097, standMonat: 10 };
  const p = rueckpruefung(e);
  // 2093 wird nicht mehr geprüft: Dort hätte der Trend nur zwei abgeschlossene Jahre – verglichen wird über dieselben Jahre
  assert.deepEqual(p.jahre, [2095, 2094]);
  assert.deepEqual(p.treffer, { HOCH: 100, AVG3: 100, MED5: 100, TREND: 100 });
  assert.equal(p.treffer.HOCH, 100);
  assert.equal(p.beste, 'HOCH');
  nah(methodenWerte(e).werte.HOCH, 10000);
});

test('Ausreißer: Abweichung vom Median über der Schwelle, erst ab drei Jahren, nicht bei Median 0', () => {
  const j = [{ jahr: 2091, wert: 3100 }, { jahr: 2092, wert: 2800 }, { jahr: 2093, wert: 3600 }, { jahr: 2094, wert: 21400 }, { jahr: 2095, wert: 3300 }];
  const a = ausreisser(j, 50);
  assert.deepEqual(a.map((x) => x.jahr), [2094]);
  assert.equal(a[0].median, 3300);
  nah(a[0].abweichung, 548.5, 0.05);
  assert.deepEqual(ausreisser(j, 1000), []);
  assert.deepEqual(ausreisser(j.slice(0, 2), 50), []);
  assert.deepEqual(ausreisser([{ jahr: 1, wert: 0 }, { jahr: 2, wert: 0 }, { jahr: 3, wert: 500 }], 50), []);
  // auch nach unten
  assert.deepEqual(ausreisser([{ jahr: 1, wert: 1000 }, { jahr: 2, wert: 1000 }, { jahr: 3, wert: 100 }], 50).map((x) => x.jahr), [3]);
});

test('Planwert: Preissteigerung nur auf Ausgaben und nicht auf Fachdaten; Rundung auf 10 €', () => {
  assert.equal(rundenPlan(13108.4), 13110);
  assert.equal(planwertAus(13600, 'MED5', 'A', 2), 13870);
  assert.equal(planwertAus(13600, 'MED5', 'E', 2), 13600);
  assert.equal(planwertAus(45600, 'FACH', 'E', 2), 45600);
  assert.equal(planwertAus(1000, 'MANUELL', 'A', 5), 1000);
  assert.equal(planwertAus(null, 'TREND', 'A', 2), 0);
  assert.equal(planwertAus(-50, 'TREND', 'A', 2), 0);
  assert.equal(planwertAus(Number.NaN, 'AVG3', 'A', 2), 0);
});

test('Monatsverteilung: Summe stimmt auf den Cent, ohne Verlauf gleichmäßig', () => {
  const m = monatsverteilung(10000, WINTER);
  assert.equal(m.length, 12);
  assert.equal(Math.round(m.reduce((s, x) => s + x, 0) * 100), 1000000);
  assert.equal(m[0], 1600);
  const g = monatsverteilung(1000, null);
  assert.equal(Math.round(g.reduce((s, x) => s + x, 0) * 100), 100000);
  assert.ok(g.every((x) => Math.abs(x - 83.33) <= 0.05));
  assert.deepEqual(monatsverteilung(0, WINTER), Array(12).fill(0));
  // Verlauf aus lauter Nullen: gleichmäßig statt Division durch 0
  assert.equal(Math.round(monatsverteilung(120, Array(12).fill(0)).reduce((s, x) => s + x, 0)), 120);
  assert.deepEqual(aufgelaufen([10, 20, 30]), [10, 30, 60]);
});

test('Bewertung: Toleranz 5 % / 10 %, Ausgaben schlecht bei mehr, Einnahmen bei weniger; ohne Planwert', () => {
  const b = (art: 'E' | 'A', plan: number, wert: number) => bewerten(art, plan, wert, 5, 10);
  assert.deepEqual([b('A', 1000, 1040).stufe, b('A', 1000, 1040).state], ['IM_PLAN', 'Positive']);
  assert.deepEqual([b('A', 1000, 1080).stufe, b('A', 1000, 1080).state, b('A', 1000, 1080).text], ['BEOBACHTEN', 'Critical', 'beobachten']);
  assert.deepEqual([b('A', 1000, 1200).stufe, b('A', 1000, 1200).state, b('A', 1000, 1200).text], ['UEBERSCHRITTEN', 'Negative', 'Budget überschritten']);
  assert.equal(b('A', 1000, 1200).prozent, 20);
  assert.equal(b('A', 1000, 1200).abweichung, 200);
  // genau auf der Grenze ist noch im Rahmen
  assert.equal(b('A', 1000, 1050).stufe, 'IM_PLAN');
  assert.equal(b('A', 1000, 1100).stufe, 'BEOBACHTEN');
  // weniger Ausgaben sind gut, weniger Einnahmen schlecht
  assert.equal(b('A', 1000, 500).stufe, 'IM_PLAN');
  assert.deepEqual([b('E', 1000, 850).stufe, b('E', 1000, 850).text, b('E', 1000, 850).prozent], ['UEBERSCHRITTEN', 'deutlich unter Plan', -15]);
  assert.equal(b('E', 1000, 1500).stufe, 'IM_PLAN');
  // ohne Planwert: kein Prozentwert, ungeplante Ausgabe fällt auf, ungeplante Einnahme nicht
  assert.deepEqual([b('A', 0, 300).stufe, b('A', 0, 300).prozent, b('A', 0, 300).text], ['UEBERSCHRITTEN', null, 'nicht geplant']);
  assert.equal(b('E', 0, 300).stufe, 'IM_PLAN');
  assert.equal(b('A', 0, 0).stufe, 'IM_PLAN');
});

test('Liquidität: Geldbestand je Monatsende, tiefster Stand, Mindestreserve (leer = keine Bewertung)', () => {
  const e = [6000, 0, 0, 0, 0, 0, 6000, 0, 0, 0, 0, 0], a = Array(12).fill(1000), t = Array(12).fill(100);
  const l = liquiditaet(2000, e, a, t, 3000);
  assert.equal(l.monate[0].bestand, 6900);
  assert.equal(l.monate[5].bestand, 1400);
  assert.equal(l.monate[11].bestand, 800);
  assert.deepEqual([l.tiefster, l.tiefsterMonat], [800, 12]);
  assert.deepEqual(l.monate.map((m) => m.ausreichend), [true, true, true, true, false, false, true, true, true, true, false, false]);
  const ohne = liquiditaet(2000, e, a, t, null);
  assert.ok(ohne.monate.every((m) => m.ausreichend === null));
  assert.equal(ohne.mindestreserve, null);
  // fehlende Werte zählen als 0
  assert.equal(liquiditaet(100, [], [], [], null).monate[11].bestand, 100);
});
