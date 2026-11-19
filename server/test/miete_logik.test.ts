/**
 * Vermietung (Modul miete): Rechenlogik ohne Datenbank – Aufteilung der Mieteingänge, Soll je Monat,
 * Zeitanteile, Zählerverbrauch und Verteilung der Nebenkosten auf zwei Parteien.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abrechnen, abrechnungsFrist, aufteilen, kostenAnteil, nutzung, sollMonat, standAm, tage, verbrauch, verteilen,
  type Einheit, type Kostenart, type Vertrag, type Zaehler,
} from '../../modules/miete/server/logik.js';

const ka = (id: number, bezeichnung: string, schluessel: Kostenart['schluessel'], o: Partial<Kostenart> = {}): Kostenart =>
  ({ id, bezeichnung, umlagefaehig: true, schluessel, zaehler_id: null, grundanteil: 0, anteile: {}, p35a: false, ...o });

const EG: Einheit = { id: 1, kuerzel: 'EG', flaeche: 90, personen: 2, eigennutzung: true };
const OG: Einheit = { id: 2, kuerzel: 'OG', flaeche: 60, personen: 0, eigennutzung: false };
const MIETER: Vertrag = { id: 10, einheit_id: 2, name: 'Mieter OG', beginn: '2020-01-01', ende: null, personen: 1,
  konditionen: [{ gueltig_ab: '2020-01-01', kaltmiete: 600, nk_abschlag: 150 }, { gueltig_ab: '2026-07-01', kaltmiete: 620, nk_abschlag: 170 }] };

test('Zahlung aufteilen: volles Soll, Teilzahlung im Verhältnis, Überzahlung zur Miete', () => {
  assert.deepEqual(aufteilen(750, 600, 150), { miete: 600, nk: 150 });
  assert.deepEqual(aufteilen(375, 600, 150), { miete: 300, nk: 75 });
  assert.deepEqual(aufteilen(800, 600, 150), { miete: 650, nk: 150 });
  assert.deepEqual(aufteilen(100, 0, 0), { miete: 100, nk: 0 });
  const t = aufteilen(333.33, 600, 150);
  assert.equal(Math.round((t.miete + t.nk) * 100), 33333, 'Summe der Anteile = Betrag');
});

test('Soll je Monat: Konditionswechsel und anteiliger Einzug', () => {
  assert.deepEqual(sollMonat(MIETER, '2026-06-01'), { miete: 600, nk: 150 });
  assert.deepEqual(sollMonat(MIETER, '2026-07-01'), { miete: 620, nk: 170 });
  const neu: Vertrag = { ...MIETER, beginn: '2026-11-16' };
  assert.deepEqual(sollMonat(neu, '2026-11-01'), { miete: 310, nk: 85 }, '15 von 30 Tagen');
  assert.deepEqual(sollMonat(neu, '2026-10-01'), { miete: 0, nk: 0 });
});

test('Kosten zeitanteilig: Jahresbescheid je Monat, Beleg ohne Zeitraum im Belegmonat', () => {
  const grundsteuer = { kostenart_id: 1, datum: '2026-02-15', von: '2026-01-01', bis: '2026-12-31', betrag: 365, einheit_id: null };
  assert.equal(kostenAnteil(grundsteuer, '2026-03-01', '2026-03-31'), 31);
  const rechnung = { kostenart_id: 1, datum: '2026-03-10', von: null, bis: null, betrag: 99, einheit_id: null };
  assert.equal(kostenAnteil(rechnung, '2026-03-01', '2026-03-31'), 99);
  assert.equal(kostenAnteil(rechnung, '2026-04-01', '2026-04-30'), 0);
});

test('Zähler: Stand zwischen zwei Ablesungen, Verbrauch ab Ablesung am Vortag', () => {
  const a = [{ datum: '2025-12-31', stand: 1000 }, { datum: '2026-12-31', stand: 4650 }];
  assert.equal(standAm(a, '2026-07-02'), 1000 + 3650 * 183 / 365);
  assert.equal(verbrauch(a, '2026-01-01', '2026-12-31'), 3650);
  assert.equal(verbrauch(a, '2027-01-01', '2027-12-31'), null, 'nicht eingegrenzt');
  assert.equal(tage('2026-01-01', '2026-12-31'), 365);
});

test('Nutzung: Eigennutzung, Leerstand und Mieterwechsel lückenlos', () => {
  const alt: Vertrag = { ...MIETER, id: 11, beginn: '2020-01-01', ende: '2026-03-31' };
  const neu: Vertrag = { ...MIETER, id: 12, beginn: '2026-05-01', ende: null, personen: 2 };
  const s = nutzung([EG, OG], [alt, neu], '2026-01-01', '2026-12-31');
  assert.deepEqual(s.map((x) => [x.einheit_id, x.art, x.von, x.bis]), [
    [1, 'eigen', '2026-01-01', '2026-12-31'],
    [2, 'miete', '2026-01-01', '2026-03-31'],
    [2, 'leer', '2026-04-01', '2026-04-30'],
    [2, 'miete', '2026-05-01', '2026-12-31'],
  ]);
  assert.equal(s.filter((x) => x.einheit_id === 2).reduce((n, x) => n + x.tage, 0), 365);
});

test('Verteilung: Heizstrom nach Unterzähler, Haushaltsstrom mit Gemeinschaftsanteil, Fläche, Personen, fester Anteil', () => {
  const zaehler: Zaehler[] = [
    { id: 1, bezeichnung: 'Heizstrom (Haupt)', einheit_id: null, haupt_id: null, ablesungen: [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: 6000 }] },
    { id: 2, bezeichnung: 'Heizstrom OG', einheit_id: 2, haupt_id: 1, ablesungen: [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: 2400 }] },
    { id: 3, bezeichnung: 'Hausstrom (Haupt)', einheit_id: null, haupt_id: null, ablesungen: [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: 5000 }] },
    { id: 4, bezeichnung: 'Hausstrom EG', einheit_id: 1, haupt_id: 3, ablesungen: [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: 2500 }] },
    { id: 5, bezeichnung: 'Hausstrom OG', einheit_id: 2, haupt_id: 3, ablesungen: [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: 1500 }] },
  ];
  const kostenarten = [
    ka(1, 'Heizstrom', 'verbrauch', { zaehler_id: 1, grundanteil: 30 }),
    ka(2, 'Allgemeinstrom', 'verbrauch', { zaehler_id: 3 }),
    ka(3, 'Grundsteuer', 'flaeche'),
    ka(4, 'Müllabfuhr', 'personen'),
    ka(5, 'Gartenpflege', 'anteil', { anteile: { 1: 50, 2: 50 }, p35a: true }),
    ka(6, 'Reparaturen', 'flaeche', { umlagefaehig: false }),
  ];
  const kosten = [
    { kostenart_id: 1, datum: '2026-12-31', von: '2026-01-01', bis: '2026-12-31', betrag: 1800, einheit_id: null },
    { kostenart_id: 2, datum: '2026-12-31', von: null, bis: null, betrag: 1500, einheit_id: null },
    { kostenart_id: 3, datum: '2026-02-15', von: '2026-01-01', bis: '2026-12-31', betrag: 300, einheit_id: null },
    { kostenart_id: 4, datum: '2026-01-10', von: null, bis: null, betrag: 300, einheit_id: null },
    { kostenart_id: 5, datum: '2026-06-01', von: null, bis: null, betrag: 400, einheit_id: null },
    { kostenart_id: 6, datum: '2026-06-01', von: null, bis: null, betrag: 1000, einheit_id: null },
  ];
  const v = verteilen({ von: '2026-01-01', bis: '2026-12-31', einheiten: [EG, OG], vertraege: [MIETER], kostenarten, kosten, zaehler });
  assert.deepEqual(v.hinweise, []);
  const pos = (id: number) => v.positionen.find((p) => p.kostenart_id === id)!;
  // Heizstrom: 30 % nach Fläche (OG 60/150), 70 % nach Verbrauch: OG 2400 eigen + 3600 ohne Unterzähler × 0,4 = 3840 von 6000
  assert.equal(pos(1).einheiten[2], Math.round((1800 * 0.3 * 0.4 + 1800 * 0.7 * 3840 / 6000) * 100) / 100);
  // Hausstrom: 1000 kWh Gemeinschaft (5000 − 2500 − 1500) nach Fläche → OG 1500 + 400 = 1900 von 5000
  assert.equal(pos(2).einheiten[2], 570);
  assert.equal(pos(2).einheiten[1], 930);
  assert.equal(pos(3).einheiten[2], 120);
  assert.equal(pos(4).einheiten[2], 100, '1 von 3 Personen');
  assert.equal(pos(5).einheiten[2], 200);
  for (const p of v.positionen) {
    assert.equal(Math.round(Object.values(p.einheiten).reduce((s, x) => s + x, 0) * 100), Math.round(p.gesamt * 100), `${p.bezeichnung}: vollständig verteilt`);
  }
  const a = abrechnen(v, MIETER, 12 * 150 + 0);
  assert.equal(a.positionen.length, 5, 'nicht umlagefähige Reparaturen fehlen');
  assert.equal(a.kosten, Math.round((pos(1).einheiten[2] + 570 + 120 + 100 + 200) * 100) / 100);
  assert.equal(a.ergebnis, Math.round((a.kosten - 1800) * 100) / 100);
  assert.equal(a.p35a, 200);
  assert.equal(a.neuerAbschlag, Math.ceil(a.kosten / 12));
});

test('Verteilung: Differenzmessung – nur das OG hat einen Unterzähler, der Rest gehört dem EG', () => {
  const zaehler: Zaehler[] = [
    { id: 1, bezeichnung: 'Heizstrom', einheit_id: null, haupt_id: null, ablesungen: [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: 5000 }] },
    { id: 2, bezeichnung: 'Heizstrom OG', einheit_id: 2, haupt_id: 1, ablesungen: [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: 2000 }] },
  ];
  const kosten = [{ kostenart_id: 1, datum: '2026-12-31', von: null, bis: null, betrag: 1500, einheit_id: null }];
  const basis = { von: '2026-01-01', bis: '2026-12-31', einheiten: [EG, OG], vertraege: [MIETER], kosten, zaehler };
  const diff = verteilen({ ...basis, kostenarten: [ka(1, 'Heizstrom', 'verbrauch', { zaehler_id: 1, rest_einheit_id: 1 })] }).positionen[0];
  assert.deepEqual(diff.einheiten, { 1: 900, 2: 600 }, '3000 von 5000 kWh beim EG, 2000 beim OG');
  assert.match(diff.anteile.find((a) => a.einheit_id === 1)!.basis, /Hauptzähler minus Unterzähler/);
  // ohne Angabe: Rest ist gemeinsamer Verbrauch nach Fläche (OG 40 %)
  const gemeinsam = verteilen({ ...basis, kostenarten: [ka(1, 'Heizstrom', 'verbrauch', { zaehler_id: 1 })] }).positionen[0];
  assert.equal(gemeinsam.einheiten[2], (2000 + 3000 * 0.4) / 5000 * 1500);
});

test('Verteilung: fehlende Zählerstände fallen auf Wohnfläche zurück und werden gemeldet', () => {
  const v = verteilen({
    von: '2026-01-01', bis: '2026-12-31', einheiten: [EG, OG], vertraege: [MIETER],
    kostenarten: [ka(1, 'Heizstrom', 'verbrauch', { zaehler_id: 1 })],
    kosten: [{ kostenart_id: 1, datum: '2026-12-31', von: null, bis: null, betrag: 1500, einheit_id: null }],
    zaehler: [{ id: 1, bezeichnung: 'Heizstrom (Haupt)', einheit_id: null, haupt_id: null, ablesungen: [{ datum: '2026-06-30', stand: 5 }] }],
  });
  assert.equal(v.positionen[0].einheiten[2], 600);
  assert.match(v.hinweise[0], /Zählerstände fehlen/);
});

test('Mieterwechsel: jeder Mieter trägt seine Tage, der Leerstand bleibt beim Vermieter', () => {
  const alt: Vertrag = { ...MIETER, id: 11, ende: '2026-06-30' };
  const v = verteilen({
    von: '2026-01-01', bis: '2026-12-31', einheiten: [EG, OG], vertraege: [alt],
    kostenarten: [ka(3, 'Grundsteuer', 'flaeche')],
    kosten: [{ kostenart_id: 3, datum: '2026-02-15', von: null, bis: null, betrag: 365, einheit_id: null }], zaehler: [],
  });
  const a = abrechnen(v, alt, 900);
  assert.equal(a.tage, 181);
  assert.equal(a.kosten, Math.round(365 * 0.4 * 181 / 365 * 100) / 100);
  assert.equal(abrechnungsFrist('2026-12-31'), '2027-12-31');
});
