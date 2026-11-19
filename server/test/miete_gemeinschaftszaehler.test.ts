/**
 * Vermietung – Gemeinschaftszähler im Zählerbaum: Waschküche/Keller bzw. Heizungsstrom wird im Zähler einer Partei
 * mitgemessen, von deren Verbrauch abgezogen und nach Fläche, Personen oder zu gleichen Teilen auf beide Parteien geteilt.
 * Ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unterzaehler, verteilen, zaehlerKreis, type Einheit, type Kostenart, type Vertrag, type Zaehler } from '../../modules/miete/server/logik.js';

const ka = (o: Partial<Kostenart> = {}): Kostenart =>
  ({ id: 71, bezeichnung: 'Haushaltsstrom', umlagefaehig: true, schluessel: 'verbrauch', zaehler_id: 701, grundanteil: 0, anteile: {}, p35a: false, ...o });

// zwei gleich große Wohnungen: Mama (Eigennutzung, 1 Person) und Nils & Sophia (Mietvertrag, 2 Personen)
const MAMA: Einheit = { id: 51, kuerzel: 'Mama', flaeche: 75, personen: 1, eigennutzung: true };
const NS: Einheit = { id: 52, kuerzel: 'N&S', flaeche: 75, personen: 0, eigennutzung: false };
const VERTRAG: Vertrag = { id: 61, einheit_id: 52, name: 'Nils & Sophia', beginn: '2025-01-01', ende: null, personen: 2 };
const abl = (bis: number) => [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: bis }];

// Hausanschluss 5250 kWh; Zähler Mama 2250; Zähler N&S 3000 – darin die Waschküche mit 600
const ZAEHLER: Zaehler[] = [
  { id: 701, bezeichnung: 'Haushaltsstrom (Haupt)', einheit_id: null, haupt_id: null, ablesungen: abl(5250) },
  { id: 702, bezeichnung: 'Strom Mama', einheit_id: 51, haupt_id: 701, ablesungen: abl(2250) },
  { id: 703, bezeichnung: 'Strom N&S', einheit_id: 52, haupt_id: 701, ablesungen: abl(3000) },
  { id: 704, bezeichnung: 'Waschküche', einheit_id: null, haupt_id: 703, ablesungen: abl(600) },
];
const basis = {
  von: '2026-01-01', bis: '2026-12-31', einheiten: [MAMA, NS], vertraege: [VERTRAG], zaehler: ZAEHLER,
  kosten: [{ kostenart_id: 71, datum: '2026-12-31', von: null, bis: null, betrag: 1900, einheit_id: null }],
};
const position = (o: Partial<Kostenart>, z = ZAEHLER) => verteilen({ ...basis, zaehler: z, kostenarten: [ka(o)] });

test('Waschküche im Zähler von N&S: abgezogen und nach Fläche halbiert (300/300)', () => {
  const v = position({ gemeinsam_schluessel: 'flaeche' });
  assert.deepEqual(v.hinweise, []);
  const p = v.positionen[0];
  // Mama 2250 + 300 = 2550, N&S 3000 − 600 + 300 = 2700 von 5250
  assert.deepEqual(p.einheiten, { 51: 922.86, 52: 977.14 });
  assert.match(p.anteile.find((a) => a.einheit_id === 52)!.basis, /2\.400,0 eigener Verbrauch \+ 300,0 Anteil Gemeinschaft \(nach Fläche\) von 5\.250,0/);
});

test('Ohne Angabe gilt Fläche; zu gleichen Teilen ergibt bei gleicher Fläche dasselbe', () => {
  assert.deepEqual(position({}).positionen[0].einheiten, { 51: 922.86, 52: 977.14 });
  assert.deepEqual(position({ gemeinsam_schluessel: 'einheiten' }).positionen[0].einheiten, { 51: 922.86, 52: 977.14 });
});

test('Nach Personen: 1 zu 2 – Mama 200, N&S 400 kWh der Waschküche', () => {
  const p = position({ gemeinsam_schluessel: 'personen' }).positionen[0];
  // Mama 2450, N&S 2800 von 5250
  assert.deepEqual(p.einheiten, { 51: 886.67, 52: 1013.33 });
  assert.match(p.anteile.find((a) => a.einheit_id === 51)!.basis, /200,0 Anteil Gemeinschaft \(nach Personen\)/);
});

test('Nach Personen ohne Personen: Rückfall auf Fläche mit Hinweis', () => {
  const v = verteilen({ ...basis, einheiten: [{ ...MAMA, personen: 0 }, NS], vertraege: [{ ...VERTRAG, personen: 0 }], kostenarten: [ka({ gemeinsam_schluessel: 'personen' })] });
  assert.deepEqual(v.positionen[0].einheiten, { 51: 922.86, 52: 977.14 });
  assert.match(v.hinweise[0], /keine Personen hinterlegt/);
});

test('Heizungsstrom als eigener Gemeinschaftszähler am Hausanschluss, Rest per Differenzmessung an Mama', () => {
  // nur N&S hat einen Zähler (3000 inkl. Waschküche 600), dazu Heizungsstrom 1000 direkt am Hausanschluss (5250)
  const z: Zaehler[] = [ZAEHLER[0], ZAEHLER[2], ZAEHLER[3], { id: 705, bezeichnung: 'Heizung', einheit_id: null, haupt_id: 701, ablesungen: abl(1000) }];
  const p = position({ rest_einheit_id: 51, gemeinsam_schluessel: 'flaeche' }, z).positionen[0];
  // Mama: 5250 − 3000 − 1000 = 1250 + 800 (Hälfte von 600 + 1000) = 2050; N&S 2400 + 800 = 3200
  assert.deepEqual(p.einheiten, { 51: r(1900 * 2050 / 5250), 52: r(1900 * 3200 / 5250) });
});

test('Zähler hinter einem Unterzähler zeigt mehr als dieser: Hinweis, kein negativer Verbrauch', () => {
  const z = ZAEHLER.map((x) => (x.id === 704 ? { ...x, ablesungen: abl(3500) } : x));
  const v = position({}, z);
  assert.match(v.hinweise.join(' '), /hinter „Strom N&S“/);
  const p = v.positionen[0];
  assert.equal(Math.round((p.einheiten[51] + p.einheiten[52]) * 100), 190000, 'vollständig verteilt');
});

test('Zählerbaum: Unterzähler beliebig tief, Kreise werden erkannt', () => {
  assert.deepEqual(unterzaehler(ZAEHLER, 701).map((z) => z.id), [702, 703, 704]);
  assert.deepEqual(unterzaehler(ZAEHLER, 703).map((z) => z.id), [704]);
  assert.equal(zaehlerKreis(ZAEHLER, 703, 704), true, 'N&S hinter die eigene Waschküche');
  assert.equal(zaehlerKreis(ZAEHLER, 704, 704), true, 'sich selbst');
  assert.equal(zaehlerKreis(ZAEHLER, 704, 702), false);
  assert.equal(zaehlerKreis(ZAEHLER, 704, null), false);
});

function r(x: number) { return Math.round(x * 100) / 100; }
