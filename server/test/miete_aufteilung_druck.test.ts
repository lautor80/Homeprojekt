/**
 * Vermietung – Ausdruck Kostenaufteilung (Querformat): je Kostenart Gesamtbetrag, Verteilerschlüssel und je Wohnung
 * Betrag, Prozent und Rechengrundlage; Summen pro Jahr/Monat, nicht umgelegte Kosten getrennt. Ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verteilen, type Einheit, type Kostenart, type Vertrag, type Zaehler } from '../../modules/miete/server/logik.js';
import { aufteilungHtml, basisJeEinheit, schluesselBeschreibung, type AufteilungDruck } from '../../modules/miete/server/pdf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAMA: Einheit = { id: 81, kuerzel: 'EG Mama', flaeche: 75, personen: 1, eigennutzung: true };
const NS: Einheit = { id: 82, kuerzel: 'OG N&S', flaeche: 75, personen: 0, eigennutzung: false };
const V: Vertrag = { id: 91, einheit_id: 82, name: 'Nils & Sophia', beginn: '2025-01-01', ende: null, personen: 2 };
const abl = (bis: number) => [{ datum: '2025-12-31', stand: 0 }, { datum: '2026-12-31', stand: bis }];
const ZAEHLER: Zaehler[] = [
  { id: 801, bezeichnung: 'Hausanschluss', einheit_id: null, haupt_id: null, ablesungen: abl(5250) },
  { id: 802, bezeichnung: 'Strom Mama', einheit_id: 81, haupt_id: 801, ablesungen: abl(2250) },
  { id: 803, bezeichnung: 'Strom N&S', einheit_id: 82, haupt_id: 801, ablesungen: abl(3000) },
  { id: 804, bezeichnung: 'Waschküche', einheit_id: null, haupt_id: 803, ablesungen: abl(600) },
];
const ka = (id: number, bezeichnung: string, o: Partial<Kostenart>): Kostenart =>
  ({ id, bezeichnung, umlagefaehig: true, schluessel: 'flaeche', zaehler_id: null, grundanteil: 0, anteile: {}, p35a: false, ...o });
const ARTEN = [
  ka(1, 'Haushaltsstrom (gemeinsam)', { schluessel: 'verbrauch', zaehler_id: 801, gemeinsam_schluessel: 'personen' }),
  ka(2, 'Luftwärmepumpe', { schluessel: 'flaeche' }),
  ka(3, 'Telefon/Internet', { schluessel: 'einheiten' }),
  ka(4, 'Müllabfuhr', { schluessel: 'personen' }),
  ka(5, 'Grundsteuer', { umlagefaehig: false }),
];
const beleg = (kostenart_id: number, betrag: number) => ({ kostenart_id, datum: '2026-12-31', von: '2026-01-01', bis: '2026-12-31', betrag, einheit_id: null });
const vt = verteilen({
  von: '2026-01-01', bis: '2026-12-31', einheiten: [MAMA, NS], vertraege: [V], zaehler: ZAEHLER, kostenarten: ARTEN,
  kosten: [beleg(1, 1900), beleg(2, 2000), beleg(3, 480), beleg(4, 200), beleg(5, 558)],
});
const druck: AufteilungDruck = {
  jahr: 2026, von: '2026-01-01', bis: '2026-12-31', erstellt: '19.11.2026',
  objekt: { bezeichnung: 'Haus <Oberthal>', strasse: 'Hauptstraße 1', plz: '66649', ort: 'Oberthal', vermieter: 'Torsten' },
  einheiten: [{ ...MAMA, bezeichnung: 'Erdgeschoss', nutzer: [] }, { ...NS, bezeichnung: 'Obergeschoss', personen: 2, nutzer: ['Nils & Sophia'] }],
  arten: { 1: { gemeinsam: 'personen', grundanteil: 0 }, 2: { gemeinsam: null, grundanteil: 0 }, 3: { gemeinsam: null, grundanteil: 0 }, 4: { gemeinsam: null, grundanteil: 0 }, 5: { gemeinsam: null, grundanteil: 0 } },
  positionen: vt.positionen, hinweise: vt.hinweise,
  abrechnungen: [{ name: 'Nils & Sophia', einheit: 'OG N&S', von: '2026-01-01', bis: '2026-12-31', kosten: 2500, vorauszahlungen: 2383.32, ergebnis: 116.68, neuerAbschlag: 210 }],
};

test('Schlüsselbeschreibung: Verbrauch mit Teilung des gemeinsamen Verbrauchs und Grundkosten', () => {
  const p = vt.positionen.find((x) => x.kostenart_id === 1)!;
  assert.equal(schluesselBeschreibung(p, { gemeinsam: 'personen', grundanteil: 0 }), 'Verbrauch (Haupt- und Unterzähler) – gemeinsamer Verbrauch nach Personen');
  assert.equal(schluesselBeschreibung(p, { gemeinsam: 'flaeche', grundanteil: 30 }), 'Verbrauch (Haupt- und Unterzähler) – gemeinsamer Verbrauch nach Wohnfläche, 30 % Grundkosten nach Fläche');
  assert.equal(schluesselBeschreibung(vt.positionen.find((x) => x.kostenart_id === 3)!), 'Wohneinheiten (gleiche Teile)');
  assert.match(basisJeEinheit(p, 82)[0], /2\.400,0 eigener Verbrauch \+ 400,0 Anteil Gemeinschaft \(nach Personen\)/);
});

test('Ausdruck: Querformat, Wohnungen als Spalten, Beträge, Prozent und Rechenweg je Kostenart', () => {
  const h = aufteilungHtml(druck, '#2b7d2b');
  assert.match(h, /@page\{size:A4 landscape\}/);
  assert.match(h, /<h1>Kostenaufteilung 2026<\/h1>/);
  assert.ok(h.includes('Haus &lt;Oberthal&gt;'), 'maskiert');
  assert.ok(h.includes('EG Mama') && h.includes('Eigennutzung') && h.includes('Nils &amp; Sophia') && h.includes('75 m² · 2 Pers.'));
  // Haushaltsstrom 1900 nach Verbrauch: Mama 2450, N&S 2800 von 5250 kWh
  assert.ok(h.includes('886,67 €') && h.includes('1.013,33 €'));
  assert.ok(h.includes('46,7 %') && h.includes('53,3 %'));
  // Telefon hälftig, Müll 1 : 2 nach Personen
  assert.ok(h.includes('240,00 €') && h.includes('66,67 €') && h.includes('133,33 €'));
  // Summen umlagefähig pro Jahr und Monat; Grundsteuer getrennt als nicht berücksichtigt
  assert.ok(h.includes('Nebenkosten pro Jahr') && h.includes('4.580,00 €') && h.includes('381,67 €'));
  assert.ok(h.includes('In den Nebenkosten nicht berücksichtigt') && h.includes('Nicht berücksichtigt pro Monat') && h.includes('558,00 €') && h.includes('279,00 €'));
  assert.ok(h.includes('Nachzahlung 116,68 €') && h.includes('210,00 € / Monat'));
  assert.ok(h.includes('Personen × bewohnte Tage'), 'Erläuterung der Schlüssel');
});

test('Ausdruck ohne Kosten und ohne Mietverhältnis', () => {
  const h = aufteilungHtml({ ...druck, positionen: [], abrechnungen: [], hinweise: [] });
  assert.ok(h.includes('Keine Kosten in diesem Zeitraum.'));
  assert.ok(!h.includes('Abrechnung je Mietverhältnis'));
});

test('Route und Knopf vorhanden', () => {
  assert.ok(readFileSync(path.join(ROOT, 'modules/miete/server/index.ts'), 'utf8').includes("'/abrechnung/aufteilung/pdf'"));
  assert.ok(readFileSync(path.join(ROOT, 'modules/miete/web/Abrechnung.tsx'), 'utf8').includes('Kostenaufteilung drucken'));
});
