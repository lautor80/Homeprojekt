/**
 * Euroflex „Auftrag aus Beleg“: Abgleich der Erkennung mit Kontakten, Wertelisten, Aufträgen und Leseprofilen – reine Logik
 * ohne Datenbank (modules/transport/server/beleg/abgleich.ts). Alle Namen sind erfunden.
 *   tsx --test server/test/transport_belegabgleich.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  belegAbgleichen, dublettenFinden, kontaktStufe, kontaktText, kundeAbgleichen, listenTreffer, namensWoerter, normal, wertAbgleichen, wirksameProfile,
  type Kontakt, type Listenwert, type Wertelisten,
} from '../../modules/transport/server/beleg/abgleich.js';
import type { BelegAnschrift, BelegErkennung, BelegProfil, BelegStop, Feld } from '../../modules/transport/server/beleg/typen.js';
import { TRANSPORT_FUNKTIONEN } from '../../modules/transport/server/funktionen.js';

const eins = <T>(wert: T, herkunft: string | null = null): Feld<T> => ({ status: 'eindeutig', wert, kandidaten: [], herkunft, hinweis: null });
const leer = <T = string>(): Feld<T> => ({ status: 'fehlt', wert: null, kandidaten: [], herkunft: null, hinweis: null });
const mehrere = <T>(werte: T[], text: (w: T) => string): Feld<T> => ({
  status: 'unklar', wert: null, kandidaten: werte.map((w) => ({ wert: w, text: text(w), herkunft: null })), herkunft: null, hinweis: 'Mehrere Möglichkeiten im Beleg.',
});
const firma = (name: string, plz: string | null = null, ort: string | null = null): BelegAnschrift => ({ name, strasse: null, land: null, plz, ort });
const kontakt = (adrnr: number, kundenname: string, plz: string | null = null, ort: string | null = null, kundenname2: string | null = null): Kontakt =>
  ({ adrnr, kundenname, kundenname2, strasse: null, plz, ort });

const KONTAKTE: Kontakt[] = [
  kontakt(990101, 'Beispielholz GmbH & Co. KG', '12345', 'Musterstadt'),
  kontakt(990102, 'Fantasie Logistik S.A.', '1234', 'Exempelville'),
  kontakt(990103, 'Spedition Erfunden', '54321', 'Nirgendheim'),
  kontakt(990104, 'Spedition Erfunden', '99999', 'Anderswo'),
  kontakt(990105, 'Müller-Phantasie Transporte e. K.', '11111', 'Beispielort'),
  kontakt(990106, 'Erdachte Werke Nord GmbH', '22222', 'Testhausen'),
  kontakt(990107, 'Kunstname', null, null, 'Niederlassung Süd'),
];

test('Vergleichsform: Groß/Klein, Umlaute und ß, Rechtsformen, Satzzeichen', () => {
  assert.equal(normal('  Größe-Über.Maß '), 'groesse ueber mass');
  assert.equal(normal('Société Générale'), 'societe generale');
  assert.deepEqual(namensWoerter('Beispielholz GmbH & Co. KG'), ['beispielholz']);
  assert.deepEqual(namensWoerter('BEISPIELHOLZ GMBH + CO KG'), ['beispielholz']);
  assert.deepEqual(namensWoerter('Fantasie Logistik S.A.'), ['fantasie', 'logistik']);
  assert.deepEqual(namensWoerter('Fantasie Logistik SA'), ['fantasie', 'logistik']);
  assert.deepEqual(namensWoerter('Mueller Phantasie Transporte e.K.'), ['mueller', 'phantasie', 'transporte']);
  assert.deepEqual(namensWoerter('Müller-Phantasie Transporte e. K.'), ['mueller', 'phantasie', 'transporte']);
  assert.deepEqual(namensWoerter('Polska Fikcja Sp. z o.o.'), ['polska', 'fikcja']);
  assert.deepEqual(namensWoerter('Müller und Sohn'), namensWoerter('Müller & Sohn'));
  assert.deepEqual(namensWoerter('AG'), ['ag'], 'nur Rechtsform: bleibt stehen');
  assert.equal(kontaktText(KONTAKTE[0]), 'Beispielholz GmbH & Co. KG, 12345 Musterstadt');
  assert.equal(kontaktText(KONTAKTE[6]), 'Kunstname Niederlassung Süd');
});

test('Kunde eindeutig: der Beleg nennt eine Firma, genau ein Kontakt passt mit Name und PLZ/Ort', () => {
  const r = kundeAbgleichen(eins(firma('BEISPIELHOLZ GmbH + Co KG', '12345', 'Musterstadt'), 'Kopf: BEISPIELHOLZ'), KONTAKTE);
  assert.deepEqual([r.kunde.status, r.kunde.wert, r.kunde.herkunft, r.kunde.hinweis], ['eindeutig', 990101, 'Kopf: BEISPIELHOLZ', null]);
  assert.deepEqual(r.kunde.kandidaten, []);
  assert.deepEqual(r.kundeImBeleg.map((a) => a.name), ['BEISPIELHOLZ GmbH + Co KG']);
  // Umlaut ausgeschrieben, Rechtsform fehlt im Beleg, PLZ mit Länderkennzeichen
  assert.equal(kundeAbgleichen(eins(firma('Mueller Phantasie Transporte', 'D-11111')), KONTAKTE).kunde.wert, 990105);
  // dieselbe Firma zweimal im Beleg zählt einmal
  const doppelt = mehrere([firma('Beispielholz GmbH & Co. KG', '12345'), firma('BEISPIELHOLZ GMBH & CO KG', '12345')], (a) => a.name);
  assert.deepEqual([kundeAbgleichen(doppelt, KONTAKTE).kunde.status, kundeAbgleichen(doppelt, KONTAKTE).kunde.wert], ['eindeutig', 990101]);
});

test('Kunde: gleicher Name ohne bestätigten Ort oder mit anderer Rechtsform → nur Vorschlag zur Bestätigung', () => {
  // ohne Ortsangabe im Beleg
  const ohneOrt = kundeAbgleichen(eins(firma('Fantasie Logistik SA')), KONTAKTE);
  assert.deepEqual([ohneOrt.kunde.status, ohneOrt.kunde.wert, ohneOrt.kunde.kandidaten.map((k) => k.wert)], ['unklar', null, [990102]]);
  assert.match(ohneOrt.kunde.hinweis ?? '', /Kein Kontakt passt sicher/);
  // Kontakt ohne Anschrift
  const ohneAnschrift = kundeAbgleichen(eins(firma('Kunstname Niederlassung Süd', '44444', 'Irgendwo')), KONTAKTE);
  assert.deepEqual([ohneAnschrift.kunde.status, ohneAnschrift.kunde.kandidaten.map((k) => k.wert)], ['unklar', [990107]]);
  // gleiche Namenswörter und gleiche PLZ, aber andere Rechtsform: zwei verschiedene Firmen
  const andereForm = kundeAbgleichen(eins(firma('Beispielholz AG', '12345', 'Musterstadt')), KONTAKTE);
  assert.deepEqual([andereForm.kunde.status, andereForm.kunde.kandidaten.map((k) => k.wert)], ['unklar', [990101]]);
});

test('Kunde: zwei Firmen im Beleg → immer Rückfrage, Kandidaten sind Kontakte', () => {
  const feld = mehrere([firma('Beispielholz GmbH & Co. KG', '12345', 'Musterstadt'), firma('Fantasie Logistik S.A.', '1234', 'Exempelville')], (a) => a.name);
  const r = kundeAbgleichen(feld, KONTAKTE);
  assert.equal(r.kunde.status, 'unklar');
  assert.equal(r.kunde.wert, null);
  assert.deepEqual(r.kunde.kandidaten.map((k) => [k.wert, k.text, k.herkunft]), [
    [990101, 'Beispielholz GmbH & Co. KG, 12345 Musterstadt', 'Beispielholz GmbH & Co. KG'],
    [990102, 'Fantasie Logistik S.A., 1234 Exempelville', 'Fantasie Logistik S.A.'],
  ]);
  assert.match(r.kunde.hinweis ?? '', /mehrere Firmen/);
  assert.equal(r.kundeImBeleg.length, 2);
  // zwei Firmen, aber nur eine in den Kontakten → trotzdem nachfragen (ein Kandidat)
  const eine = kundeAbgleichen(mehrere([firma('Beispielholz GmbH & Co. KG', '12345'), firma('Unbekannt Ausgedacht AG', '77777', 'Fernweg')], (a) => a.name), KONTAKTE);
  assert.deepEqual([eine.kunde.status, eine.kunde.wert, eine.kunde.kandidaten.map((k) => k.wert)], ['unklar', null, [990101]]);
  assert.match(eine.kunde.hinweis ?? '', /nur diese ist in den Kontakten/);
  assert.equal(eine.kundeImBeleg.length, 2);
});

const ZWILLINGE: Kontakt[] = [...KONTAKTE, kontakt(990109, 'Doppelt Erdacht GmbH', '55555', 'Zwillingen'), kontakt(990110, 'Doppelt Erdacht GmbH', '55555', 'Zwillingen')];

test('Kunde: zwei Kontakte gleichen Namens → unklar; PLZ oder Ort im Beleg entscheidet', () => {
  const r = kundeAbgleichen(eins(firma('Spedition Erfunden')), KONTAKTE);
  assert.equal(r.kunde.status, 'unklar');
  assert.deepEqual(r.kunde.kandidaten.map((k) => k.wert), [990103, 990104]);
  assert.deepEqual(r.kunde.kandidaten.map((k) => k.text), ['Spedition Erfunden, 54321 Nirgendheim', 'Spedition Erfunden, 99999 Anderswo']);
  assert.equal(kundeAbgleichen(eins(firma('Spedition Erfunden', '99999')), KONTAKTE).kunde.wert, 990104, 'PLZ bestätigt');
  assert.equal(kundeAbgleichen(eins(firma('Spedition Erfunden', null, 'NIRGENDHEIM')), KONTAKTE).kunde.wert, 990103, 'Ort bestätigt');
  // gleicher Name, aber anderer Ort als alle Kontakte: nur Kandidaten
  const fremd = kundeAbgleichen(eins(firma('Spedition Erfunden', '10101', 'Drittstadt')), KONTAKTE);
  assert.equal(fremd.kunde.status, 'unklar');
  assert.deepEqual(fremd.kunde.kandidaten.map((k) => k.wert), [990103, 990104]);
  // zwei Kontakte mit gleichem Namen und gleicher Anschrift
  const zwei = kundeAbgleichen(eins(firma('Doppelt Erdacht GmbH', '55555')), ZWILLINGE);
  assert.deepEqual([zwei.kunde.status, zwei.kunde.kandidaten.map((k) => k.wert)], ['unklar', [990109, 990110]]);
  assert.match(zwei.kunde.hinweis ?? '', /Mehrere Kontakte passen/);
});

test('Kunde: bevorzugter Kunde des Leseprofils entscheidet nur unter sicheren Treffern', () => {
  const r = kundeAbgleichen(eins(firma('Doppelt Erdacht GmbH', '55555'), 'Absender'), ZWILLINGE, 990110);
  assert.deepEqual([r.kunde.status, r.kunde.wert, r.kunde.herkunft], ['eindeutig', 990110, 'Absender']);
  assert.match(r.kunde.hinweis ?? '', /im Leseprofil hinterlegte Kunde/);
  assert.deepEqual(r.kunde.kandidaten, []);
  // zwei Firmen im Beleg, beide in den Kontakten
  const zwei = mehrere([firma('Beispielholz GmbH & Co. KG', '12345'), firma('Fantasie Logistik S.A.', '1234')], (a) => a.name);
  assert.equal(kundeAbgleichen(zwei, KONTAKTE, 990102).kunde.wert, 990102);
  // zwei Firmen im Beleg, nur eine in den Kontakten – und die ist hinterlegt
  const eine = mehrere([firma('Beispielholz GmbH & Co. KG', '12345'), firma('Unbekannt Ausgedacht AG', '77777')], (a) => a.name);
  assert.deepEqual([kundeAbgleichen(eine, KONTAKTE, 990101).kunde.status, kundeAbgleichen(eine, KONTAKTE, 990101).kunde.wert], ['eindeutig', 990101]);
  // bevorzugter Kunde nicht unter den Treffern: bleibt unklar bzw. der einzige Treffer gilt ohne Hinweis
  assert.equal(kundeAbgleichen(zwei, KONTAKTE, 990105).kunde.status, 'unklar');
  const einer = kundeAbgleichen(eins(firma('Beispielholz GmbH & Co. KG', '12345')), KONTAKTE, 990105);
  assert.deepEqual([einer.kunde.wert, einer.kunde.hinweis], [990101, null]);
  // nur Teilname oder Name ohne Ort: auch der bevorzugte Kunde wird nicht geraten
  assert.equal(kundeAbgleichen(eins(firma('Erdachte Werke')), KONTAKTE, 990106).kunde.status, 'unklar');
  assert.equal(kundeAbgleichen(eins(firma('Spedition Erfunden')), KONTAKTE, 990104).kunde.status, 'unklar');
});

test('Kunde: kein Treffer → fehlt mit Hinweis; kein Auftraggeber im Beleg', () => {
  const r = kundeAbgleichen(eins(firma('Ganz Andere Firma GmbH', '12345', 'Musterstadt')), KONTAKTE);
  assert.deepEqual([r.kunde.status, r.kunde.wert, r.kunde.kandidaten.length], ['fehlt', null, 0]);
  assert.equal(r.kunde.hinweis, 'Kunde nicht in den Kontakten gefunden – bitte von Hand wählen oder Kontakt anlegen');
  assert.deepEqual(r.kundeImBeleg.map((a) => a.name), ['Ganz Andere Firma GmbH']);
  const ohne = kundeAbgleichen(leer<BelegAnschrift>(), KONTAKTE, 990101);
  assert.equal(ohne.kunde.status, 'fehlt');
  assert.match(ohne.kunde.hinweis ?? '', /kein Auftraggeber erkannt/);
  assert.deepEqual(ohne.kundeImBeleg, []);
  // allgemeine Wörter allein sind keine Übereinstimmung
  assert.equal(kundeAbgleichen(eins(firma('Spedition')), KONTAKTE).kunde.status, 'fehlt');
  assert.equal(kundeAbgleichen(eins(firma('GmbH')), KONTAKTE).kunde.status, 'fehlt');
});

test('Kunde: nur Teilname → immer nur Kandidat, auch mit passender PLZ', () => {
  const ohne = kundeAbgleichen(eins(firma('Erdachte Werke')), KONTAKTE);
  assert.equal(ohne.kunde.status, 'unklar');
  assert.deepEqual(ohne.kunde.kandidaten.map((k) => [k.wert, k.text]), [[990106, 'Erdachte Werke Nord GmbH, 22222 Testhausen']]);
  assert.match(ohne.kunde.hinweis ?? '', /Kein Kontakt passt sicher/);
  const mit = kundeAbgleichen(eins(firma('Erdachte Werke', '22222')), KONTAKTE);
  assert.deepEqual([mit.kunde.status, mit.kunde.wert, mit.kunde.kandidaten.map((k) => k.wert)], ['unklar', null, [990106]]);
  // der Beleg nennt mehr als der Kontakt
  assert.equal(kundeAbgleichen(eins(firma('Beispielholz Verwaltung GmbH')), KONTAKTE).kunde.status, 'unklar');
  // voller Treffer verdrängt den Teilnamen-Kandidaten derselben Firma
  const beide = [...KONTAKTE, kontakt(990108, 'Beispielholz Verwaltung GmbH', '12345', 'Musterstadt')];
  assert.equal(kundeAbgleichen(eins(firma('Beispielholz GmbH & Co. KG', '12345')), beide).kunde.wert, 990101);
  assert.deepEqual([kontaktStufe(firma('Erdachte Werke Nord'), KONTAKTE[5]), kontaktStufe(firma('Erdachte Werke Nord', '22222'), KONTAKTE[5]),
    kontaktStufe(firma('Erdachte Werke Nord', '10000', 'Woanders'), KONTAKTE[5]), kontaktStufe(firma('Erdachte'), KONTAKTE[5]), kontaktStufe(firma('Nichts'), KONTAKTE[5])], [2, 3, 1, 1, 0]);
});

const FAHRZEUGE: Listenwert[] = [
  { key: '001', text: 'Planenauflieger', aktiv: true },
  { key: '002', text: 'Kühlauflieger', aktiv: true },
  { key: '003', text: 'Jumbo', aktiv: true },
  { key: '004', text: 'Planen-Hängerzug', aktiv: false },
  { key: 'KW', text: 'Kleinwagen', aktiv: true },
];

test('Wertelisten: gleiche Bezeichnung oder gleicher Schlüssel ist eindeutig, ein ähnliches Wort nur ein Vorschlag', () => {
  const gleich = wertAbgleichen(eins('planenauflieger', 'Fahrzeug: Planenauflieger'), FAHRZEUGE, 'Fahrzeugtyp');
  assert.deepEqual(gleich, { status: 'eindeutig', wert: '001', kandidaten: [], herkunft: 'Fahrzeug: Planenauflieger', hinweis: null });
  assert.equal(wertAbgleichen(eins('kw'), FAHRZEUGE, 'Fahrzeugtyp').wert, 'KW', 'Schlüssel');
  const wort = wertAbgleichen(eins('LKW mit Plane 13,6'), FAHRZEUGE, 'Fahrzeugtyp');
  assert.deepEqual([wort.status, wort.wert, wort.kandidaten], ['unklar', null, [{ wert: '001', text: 'Planenauflieger', herkunft: 'LKW mit Plane 13,6' }]]);
  assert.match(wort.hinweis ?? '', /^Im Beleg: LKW mit Plane 13,6 – ähnlich einem Wert der Liste Fahrzeugtyp/);
  assert.deepEqual(wertAbgleichen(eins('Kuehl-LKW'), FAHRZEUGE, 'Fahrzeugtyp').kandidaten.map((k) => k.wert), ['002']);
  // „LKW“ allein verbindet nichts: kein falscher Treffer über ein allgemeines Wort
  assert.equal(wertAbgleichen(eins('LKW mit Plane 13,6'), [{ key: 'K', text: 'Kühl-LKW' }, { key: 'X', text: 'Koffer' }], 'Fahrzeugtyp').status, 'fehlt');
  assert.deepEqual(listenTreffer('Planen-Hängerzug', FAHRZEUGE).treffer.map((w) => w.key), ['001'], 'inaktive Werte werden nicht vorgeschlagen');
});

test('Wertelisten mehrdeutig: mehrere Werte passen → unklar mit Kandidaten', () => {
  const r = wertAbgleichen(eins('Plane oder Kühlauflieger', 'Zeile 12'), FAHRZEUGE, 'Fahrzeugtyp');
  assert.equal(r.status, 'unklar');
  assert.equal(r.wert, null);
  assert.deepEqual(r.kandidaten, [
    { wert: '001', text: 'Planenauflieger', herkunft: 'Zeile 12' },
    { wert: '002', text: 'Kühlauflieger', herkunft: 'Zeile 12' },
  ]);
  assert.match(r.hinweis ?? '', /^Im Beleg: Plane oder Kühlauflieger – mehrere Werte der Liste Fahrzeugtyp passen/);
  // die Erkennung war sich schon nicht sicher: auch ein einzelner passender Wert wird nur vorgeschlagen
  const zwei = wertAbgleichen(mehrere(['Jumbo', 'Tieflader'], (x) => x), FAHRZEUGE, 'Fahrzeugtyp');
  assert.deepEqual([zwei.status, zwei.wert, zwei.kandidaten.map((k) => k.wert)], ['unklar', null, ['003']]);
  assert.match(zwei.hinweis ?? '', /^Im Beleg: Jumbo \/ Tieflader/);
  // doppelte Bezeichnung in der Liste
  const doppelt = wertAbgleichen(eins('Ja'), [{ key: '1', text: 'Ja' }, { key: '2', text: 'ja' }, { key: '3', text: 'Nein' }], 'Palettentausch');
  assert.deepEqual([doppelt.status, doppelt.kandidaten.map((k) => k.wert)], ['unklar', ['1', '2']]);
});

test('Wertelisten kein Treffer → fehlt, der Hinweis nennt den Belegtext', () => {
  const r = wertAbgleichen(eins('Tieflader 3-achsig'), FAHRZEUGE, 'Fahrzeugtyp');
  assert.deepEqual([r.status, r.wert, r.kandidaten.length, r.herkunft], ['fehlt', null, 0, null]);
  assert.match(r.hinweis ?? '', /^Im Beleg: Tieflader 3-achsig – kein passender Wert in der Liste Fahrzeugtyp/);
  assert.deepEqual(wertAbgleichen(leer(), FAHRZEUGE, 'Fahrzeugtyp'), leer());
  assert.equal(wertAbgleichen(eins('Jumbo'), [], 'Fahrzeugtyp').status, 'fehlt', 'leere Liste');
  assert.equal(wertAbgleichen(eins('LKW mit 13,6'), FAHRZEUGE, 'Fahrzeugtyp').status, 'fehlt', 'Füllwörter und Zahlen zählen nicht');
  assert.equal(wertAbgleichen(mehrere(['Silo', 'Tank'], (x) => x), FAHRZEUGE, 'Fahrzeugtyp').status, 'fehlt');
});

const AUFTRAEGE = [
  { auftragsnr: '2099_8101', anlagedatum: '2099-03-01', ordernummer: ' po-88001 ', kunde: 'Beispielholz GmbH & Co. KG' },
  { auftragsnr: '2099_8102', anlagedatum: '2099-03-02', ordernummer: 'PO-88002', kunde: null },
  { auftragsnr: '2099_8103', anlagedatum: null, ordernummer: 'PO-88001', kunde: 'Spedition Erfunden' },
  { auftragsnr: '2099_8104', anlagedatum: '2099-03-04', ordernummer: null, kunde: null },
];

test('Dubletten: gleiche Auftragsnr. des Kunden, getrimmt und ohne Groß/Klein', () => {
  assert.deepEqual(dublettenFinden(eins(' PO-88001'), AUFTRAEGE), [
    { auftragsnr: '2099_8101', anlagedatum: '2099-03-01', kunde: 'Beispielholz GmbH & Co. KG' },
    { auftragsnr: '2099_8103', anlagedatum: null, kunde: 'Spedition Erfunden' },
  ]);
  assert.deepEqual(dublettenFinden(eins('PO-8800'), AUFTRAEGE), [], 'kein Teilvergleich');
  assert.deepEqual(dublettenFinden(leer(), AUFTRAEGE), [], 'ohne Nummer keine Dubletten – auch nicht die Aufträge ohne Nummer');
  assert.deepEqual(dublettenFinden(eins('  '), AUFTRAEGE), []);
  assert.deepEqual(dublettenFinden(mehrere(['po-88002', 'X-1'], (x) => x), AUFTRAEGE).map((d) => d.auftragsnr), ['2099_8102'], 'unklare Nummer: jeder Kandidat wird geprüft');
});

const WERTE: Wertelisten = {
  FAHRZEUGTYP: FAHRZEUGE,
  LADEGUT: [{ key: '010', text: 'Schnittholz' }, { key: '011', text: 'Paletten' }],
  LADEWEISE: [{ key: '020', text: 'seitlich' }, { key: '021', text: 'von hinten' }],
  PALETTENTAUSCH: [{ key: 'J', text: 'Ja' }, { key: 'N', text: 'Nein' }],
};
const stop = (): BelegStop => ({
  firma: eins('Ladestelle Erfunden'), strasse: leer(), land: eins('DE'), plzort: eins('12345 Musterstadt'), ladenummer: leer(), datum: eins('2099-04-01'), zeit: leer(),
  firma_e: mehrere(['Empfang A', 'Empfang B'], (x) => x), strasse_e: leer(), land_e: leer(), plzort_e: leer(), datum_e: leer(), zeit_e: eins('bis 14:00 Uhr'),
});

test('Vorschlag: Kunde und Wertelisten abgeglichen, alles andere unverändert durchgereicht', () => {
  const e: BelegErkennung = {
    layout: 'bestellung', istFrachtauftrag: true,
    kunde: eins(firma('Beispielholz GmbH & Co. KG', '12345', 'Musterstadt')),
    ordernummer: eins('PO-88002'), leistungsdatum: eins('2099-04-01'), frachtpreis_vk: eins(1234.5), gewicht: eins(24), lademeter: eins(13.6),
    fahrzeugtyp: eins('LKW mit Plane 13,6'), ladegut: eins('Schnittholz'), ladeweise: eins('Kran'), palettentausch: eins('nein'),
    besonderheiten: eins('Zeile 1\nZeile 2'), stops: [stop()], hinweise: ['Seite 2 nicht gelesen'],
  };
  const v = belegAbgleichen(e, { kontakte: KONTAKTE, werte: WERTE, auftraege: AUFTRAEGE, profil: { bezeichnung: 'Bestellung über Frachtkosten', kunde: null }, text: 'gelesener Text' });
  assert.deepEqual([v.kunde.status, v.kunde.wert], ['eindeutig', 990101]);
  assert.deepEqual(v.kundeImBeleg, [firma('Beispielholz GmbH & Co. KG', '12345', 'Musterstadt')]);
  assert.deepEqual([v.fahrzeugtyp.status, v.fahrzeugtyp.kandidaten.map((k) => k.wert), v.ladegut.wert, v.ladeweise.status, v.palettentausch.wert], ['unklar', ['001'], '010', 'fehlt', 'N']);
  assert.match(v.ladeweise.hinweis ?? '', /^Im Beleg: Kran/);
  assert.deepEqual(v.dubletten, [{ auftragsnr: '2099_8102', anlagedatum: '2099-03-02', kunde: null }]);
  assert.deepEqual([v.profil, v.text, v.layout, v.istFrachtauftrag], ['Bestellung über Frachtkosten', 'gelesener Text', 'bestellung', true]);
  // unverändert – dieselben Objekte, Zahlen bleiben Zahlen
  assert.equal(v.ordernummer, e.ordernummer);
  assert.equal(v.leistungsdatum, e.leistungsdatum);
  assert.equal(v.frachtpreis_vk, e.frachtpreis_vk);
  assert.equal(v.gewicht, e.gewicht);
  assert.equal(v.lademeter, e.lademeter);
  assert.equal(v.besonderheiten, e.besonderheiten);
  assert.equal(v.stops, e.stops);
  assert.equal(v.hinweise, e.hinweise);
  assert.equal(typeof v.frachtpreis_vk.wert, 'number');
  assert.equal(typeof v.lademeter.wert, 'number');
  // die Erkennung selbst bleibt unberührt
  assert.equal(e.fahrzeugtyp.wert, 'LKW mit Plane 13,6');
  assert.equal(e.kunde.wert?.name, 'Beispielholz GmbH & Co. KG');

  // kein Frachtauftrag: leere Felder ergeben einen leeren Vorschlag, nichts wird geraten
  const kein: BelegErkennung = {
    layout: 'allgemein', istFrachtauftrag: false, kunde: leer(), ordernummer: leer(), leistungsdatum: leer(), frachtpreis_vk: leer(), gewicht: leer(), lademeter: leer(),
    fahrzeugtyp: leer(), ladegut: leer(), ladeweise: leer(), palettentausch: leer(), besonderheiten: leer(), stops: [], hinweise: [],
  };
  const k = belegAbgleichen(kein, { kontakte: KONTAKTE, werte: WERTE, auftraege: AUFTRAEGE, profil: { bezeichnung: 'Allgemein (Schlagworte)', kunde: 990101 }, text: 'Speisekarte' });
  assert.deepEqual([k.istFrachtauftrag, k.kunde.status, k.fahrzeugtyp.status, k.dubletten.length, k.kundeImBeleg.length], [false, 'fehlt', 'fehlt', 0, 0]);
});

test('Leseprofile: abgeschaltete Pflege = alle Layouts aktiv, kein bevorzugter Kunde', () => {
  const gespeichert: BelegProfil[] = [
    { layout: 'allgemein', bezeichnung: 'Allgemein', aktiv: false, kunde: null, kunde_name: null },
    { layout: 'bestellung', bezeichnung: 'Bestellung Beispielholz', aktiv: true, kunde: 990101, kunde_name: 'Beispielholz GmbH & Co. KG' },
  ];
  const an = wirksameProfile(gespeichert, true);
  assert.deepEqual(an.map((p) => [p.layout, p.aktiv, p.kunde]), [['bestellung', true, 990101], ['ladeauftrag', true, null], ['allgemein', false, null]]);
  assert.equal(an[1].bezeichnung, 'Ladeauftrag / Transportauftrag', 'fehlende Zeile: Standard');
  const aus = wirksameProfile(gespeichert, false);
  assert.deepEqual(aus.map((p) => [p.layout, p.aktiv, p.kunde, p.kunde_name]), [['bestellung', true, null, null], ['ladeauftrag', true, null, null], ['allgemein', true, null, null]]);
  assert.equal(aus[0].bezeichnung, 'Bestellung Beispielholz', 'die Bezeichnung bleibt');
});

test('Funktionsschalter mit Rechten und Routen', () => {
  const f = (id: string) => TRANSPORT_FUNKTIONEN.find((x) => x.id === id);
  assert.deepEqual([f('transport.beleg.erfassung')?.app, f('transport.beleg.erfassung')?.permissions, f('transport.beleg.erfassung')?.routen],
    ['Aufträge', ['transport.belegerfassung:create'], ['POST /auftraege/beleg/erkennen']]);
  assert.deepEqual([f('transport.beleg.eingang')?.app, f('transport.beleg.eingang')?.permissions, f('transport.beleg.eingang')?.routen],
    ['Posteingang', ['transport.belegeingang:create'], ['POST /eingang/dokumente/:id/beleg']]);
  assert.deepEqual([f('transport.beleg.profile')?.permissions, f('transport.beleg.profile')?.routen],
    [['transport.leseprofile:edit'], ['GET /beleg/profile', 'PUT /beleg/profile/:layout']]);
});
