/**
 * Auftrag aus Beleg (Euroflex): reine Texterkennung eines Frachtauftrags. Reine Funktion, ohne Datenbank.
 * Die Belegtexte sind frei erfundene Nachbauten der beiden Layouts (Firmen, Nummern und Preise sind Muster),
 * jeweils in der Zeilenform von pdftotext -layout und in der Blockform der Texterkennung eines Bildes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belegErkennen, layoutErkennen } from '../../modules/transport/server/beleg/erkennung.js';
import { gewichte, lademeter, plzOrt, termine, zahl } from '../../modules/transport/server/beleg/erkennung-helfer.js';
import type { BelegErkennung, BelegStop, Feld } from '../../modules/transport/server/beleg/typen.js';

// ───────────────────────── Musterbelege ─────────────────────────

/** Layout „bestellung“, wie pdftotext -layout es liefert: Beschriftung und Wert in einer Zeile, Spalten mit Leerzeichen */
const BESTELLUNG_PDF = `
   MUSTER Verkehrstechnik GmbH - Musterallee 3, 12345 Musterstadt

      Euroflex Logistik GmbH                                    Bestellung Nr.    470011

      Beispielstraße 28                                         Datum             02.03.2027
                                                                Sachbearbeiter    Erika Mustermann
      D-66649 Oberthal                                          Tel.              +49 6000 1234-169

                                                                Lieferanten-Nr.   7001234
                                                                Lieferbedingung   frei Haus
                                                                Zahlungsbedingung Innerhalb 14 Tagen netto,
                                                                                  ohne Abzug
                                                                Lieferanten-Fax
                                                                Liefertermin      16.03.2027

 Wir bestellen zu den Ihnen bekannten Einkaufsbedingungen: (https://muster-verkehrstechnik.example/agb.html)

   Pos.     Menge   ME   Teil / Bezeichnung                                      Einzelpreis        Warenwert

    1,0      1,00   St   XY000001-AB                                              480,00 EUR       480,00  EUR
                         Frachtkosten - pauschal
                         00-U-000001

                         6,2 LM, ca. 1.200 kg

                         Ladenr.:    AB/27/03/11
                         Ladetermin: 15.03.2027
                         Ladestelle:
                         Musterhalle Nord
                         Werkstr. 1
                         D-12345 Musterstadt-Süd

                         Lieferadresse:
                         BEISPIEL S.A.
                         Rue de l'Exemple 38
                         B-1000 Exempelville

                         Kontakt: +32 2 555 01 31

                                                                Warenwert                    480,00   EUR
                                                                Rabatt / Zuschlag              0,00   EUR
                                                                Gesamtpreis (netto)          480,00   EUR

 Mit freundlichen Grüßen

 Muster Straßentechnik GmbH
`;

/** Layout „bestellung“ aus der Texterkennung eines Bildes: Kopfblock als Beschriftungs- und Werteblock, Summen umbrochen */
const BESTELLUNG_OCR = `N
„“ MUSTER
o
MUSTER Verkehrstechnik GmbH - Musterallee 3, 12345 Musterstadt

Euroflex Logistik GmbH

Beispielstraße 28

D-66649 Oberthal

Bestellung Nr.

Datum
Sachbearbeiter

Tel.

Lieferanten-Nr.

Lieferbedingung
Zahlungsbedingung

Lieferanten-Fax

Liefertermin

470011

02.03.2027
Erika Mustermann
+49 6000 1234-169

7001234

frei Haus

Innerhalb 14 Tagen netto,
ohne Abzug

16.03.2027

Wir bestellen zu den Ihnen bekannten Einkaufsbedingungen: (https://muster-verkehrstechnik.example/agb.html)

Pos. Menge ME Teil/ Bezeichnung

1,0

1,00 St XY000001-AB

Frachtkosten - pauschal
00-U-000001

6,2 LM, ca. 1.200 kg

Ladenr.: AB/27/03/11
Ladetermin: 15.03.2027
Ladestell
Musterhalle Nord
Werkstr. 1
D-12345 Musterstadt-Süd

Lieferadresse:
BEISPIEL S.A.
Rue de l'Exemple 38
B-1000 Exempelville

Kontakt: +32 2 555 01 31

Mit freundlichen Grüßen

Muster Straßentechnik GmbH

Einzelpreis Warenwert
480,00 EUR 480,00 EUR

Warenwert 480,00 EUR

Rabatt / Zuschlag 0,00 EUR

Gesamtpreis (netto)

480,00 EUR
`;

/** Layout „ladeauftrag“ aus pdftotext -layout: Beschriftung links, Wert rechts */
const LADEAUFTRAG_PDF = `
   MUSTERHOLZ                              Transport 88001234
                                           Ladeauftrag p. Mail

   Transport-Auftrag für:                  Euroflex Logistik GmbH
                                           Max Mustermann
                                           Beispielstraße 28
                                           66649 Oberthal
                                           fax: +49600012345
                                           email: dispo@euroflex.example

   Auftraggeber / Frachtzahler:            Musterholz GmbH & Co. KG
                                           Beispieler Strasse 109
                                           54321 Musterheim am See

   Verladeadresse:                         wie Auftraggeber
   Verladedatum:                           11.01.2027   00:00:00
   Anlieferdatum:                          14.01.2027   00:00:00

   Adresse(n) Anlieferung(en):             Beispiel Türenwerke GmbH
                                           Werk Probstadt
                                           Testweg 1-10
                                           98765 Probstadt
                                           Bruttogewicht: 18,250 TO

   Frachtrate:                             1.275,00 EUR
   Gesamtgewicht der Tour:                 18,250 TO
   LKW-Art:                                LKW mit Plane 13,6
   Ladungssicherung:                       mindestens 12 Spanngurte, Kantenschutz
                                           Auf dem Werksgelände Warnweste tragen.

   Info:                                   Avis 24 h vorher

   Mit freundlichen Grüßen,                MUSTER


                                 Digitale Anmeldung LKW nur noch per App
              Sie finden die App im AppStore unter dem Suchbegriff "Muster Navigation".
`;

/** Layout „ladeauftrag“ aus der Texterkennung: erst alle Beschriftungen, dann alle Werte */
const LADEAUFTRAG_OCR = `#f MUSTERHOLZ

Transport-Auftrag für:

Auftraggeber / Frachtzahler:

Verladeadresse:
Verladedatum:
Anlieferdatum:

Adresse(n) Anlieferung(en):

Frachtrate:
Gesamtgewicht der Tour:
LKW-Art:

Transport 88001234
Ladeauftrag p. Mail

Euroflex Logistik GmbH
Max Mustermann
Beispielstraße 28
66649 Oberthal

fax: +49600012345
email: dispo@euroflex.example

Musterholz GmbH & Co. KG
Beispieler Strasse 109
54321 Musterheim am See

wie Auftraggeber
11.01.2027 00:00:00
14.01.2027 00:00:00

Beispiel Türenwerke GmbH
Werk Probstadt

Testweg 1-10

98765 Probstadt
Bruttogewicht: 18,250 TO

1.275,00 EUR
18,250 TO
LKW mit Plane 13,6

Ladungssicherung: mindestens 12 Spanngurte, Kantenschutz
Auf dem Werksgelände Warnweste tragen.
Info:

Mit freundlichen Grüßen, MUSTER

Digitale Anmeldung LKW nur noch per App
Sie finden die App im AppStore unter dem Suchbegriff "Muster Navigation".
`;

const RECHNUNG = `Muster Logistik AG - Hafenstr. 5, 20457 Hamburg

Rechnung
Rechnungs-Nr.: 2027-00123          Datum: 05.02.2027
Lieferadresse:
Beispiel Handels GmbH
Am Markt 3
66606 St. Wendel

Pos. 1   Transport Musterstadt - Probstadt       720,00 EUR
Gesamtpreis (netto)                              720,00 EUR
zzgl. 19 % MwSt.                                 123,50 EUR
Zahlbar innerhalb 14 Tagen ohne Abzug.
`;

// ───────────────────────── Helfer der Tests ─────────────────────────

const st = (f: Feld<unknown>) => (f.status === 'eindeutig' ? f.wert : f.status);
/** Alle Felder kompakt: bei „eindeutig“ der Wert, sonst der Status */
function kompakt(e: BelegErkennung) {
  const stop = (s: BelegStop) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, st(v as Feld)]));
  return {
    layout: e.layout, istFrachtauftrag: e.istFrachtauftrag, kunde: st(e.kunde), ordernummer: st(e.ordernummer), leistungsdatum: st(e.leistungsdatum),
    frachtpreis_vk: st(e.frachtpreis_vk), gewicht: st(e.gewicht), lademeter: st(e.lademeter), fahrzeugtyp: st(e.fahrzeugtyp), ladegut: st(e.ladegut),
    ladeweise: st(e.ladeweise), palettentausch: st(e.palettentausch), besonderheiten: st(e.besonderheiten), stops: e.stops.map(stop),
  };
}
/** Vertrag der Felder: Wert nur bei „eindeutig“, Kandidaten nur bei „unklar“ (dann mit Hinweis) */
function vertragPruefen(e: BelegErkennung) {
  const felder: [string, Feld<unknown>][] = [];
  for (const [k, v] of Object.entries(e)) if (v && typeof v === 'object' && !Array.isArray(v) && 'status' in v) felder.push([k, v as Feld<unknown>]);
  e.stops.forEach((s, i) => { for (const [k, v] of Object.entries(s)) felder.push([`stop${i + 1}.${k}`, v as Feld<unknown>]); });
  assert.ok(e.stops.length >= 1 && e.stops.length <= 2, 'ein oder zwei Stops');
  for (const [name, f] of felder) {
    if (f.status === 'eindeutig') { assert.notEqual(f.wert, null, `${name}: Wert`); assert.deepEqual(f.kandidaten, [], `${name}: keine Kandidaten`); assert.ok(f.herkunft, `${name}: Herkunft`); }
    if (f.status === 'unklar') { assert.equal(f.wert, null, `${name}: kein Wert`); assert.ok(f.kandidaten.length >= 1, `${name}: Kandidaten`); assert.ok(f.hinweis, `${name}: Hinweis`); }
    if (f.status === 'fehlt') { assert.equal(f.wert, null, `${name}: kein Wert`); assert.deepEqual(f.kandidaten, [], `${name}: keine Kandidaten`); }
  }
}
const leer = (e: BelegErkennung) => {
  const k = kompakt(e);
  return [k.kunde, k.ordernummer, k.leistungsdatum, k.frachtpreis_vk, k.gewicht, k.lademeter, k.fahrzeugtyp, k.besonderheiten, ...k.stops.flatMap((s) => Object.values(s))].every((x) => x === 'fehlt');
};

const BESTELLUNG_SOLL = {
  layout: 'bestellung', istFrachtauftrag: true, kunde: 'unklar', ordernummer: '470011', leistungsdatum: '2027-03-15', frachtpreis_vk: 480, gewicht: 1.2, lademeter: 6.2,
  fahrzeugtyp: 'fehlt', ladegut: 'fehlt', ladeweise: 'fehlt', palettentausch: 'fehlt',
  besonderheiten: 'Kontakt Entladestelle: +32 2 555 01 31\nLieferbedingung: frei Haus',
  stops: [{
    firma: 'Musterhalle Nord', strasse: 'Werkstr. 1', land: 'DE', plzort: '12345 Musterstadt-Süd', ladenummer: 'AB/27/03/11', datum: '2027-03-15', zeit: 'fehlt',
    firma_e: 'BEISPIEL S.A.', strasse_e: "Rue de l'Exemple 38", land_e: 'BE', plzort_e: '1000 Exempelville', datum_e: '2027-03-16', zeit_e: 'fehlt',
  }],
};
const LADEAUFTRAG_SOLL = {
  layout: 'ladeauftrag', istFrachtauftrag: true,
  kunde: { name: 'Musterholz GmbH & Co. KG', strasse: 'Beispieler Strasse 109', land: null, plz: '54321', ort: 'Musterheim am See' },
  ordernummer: '88001234', leistungsdatum: '2027-01-11', frachtpreis_vk: 1275, gewicht: 18.25, lademeter: 'fehlt', fahrzeugtyp: 'LKW mit Plane 13,6',
  ladegut: 'fehlt', ladeweise: 'fehlt', palettentausch: 'fehlt',
  stops: [{
    firma: 'Musterholz GmbH & Co. KG', strasse: 'Beispieler Strasse 109', land: 'unklar', plzort: '54321 Musterheim am See', ladenummer: 'fehlt', datum: '2027-01-11', zeit: 'fehlt',
    firma_e: 'Beispiel Türenwerke GmbH, Werk Probstadt', strasse_e: 'Testweg 1-10', land_e: 'unklar', plzort_e: '98765 Probstadt', datum_e: '2027-01-14', zeit_e: 'fehlt',
  }],
};

// ───────────────────────── Layout „bestellung“ ─────────────────────────

for (const [form, text] of [['pdftotext', BESTELLUNG_PDF], ['Texterkennung', BESTELLUNG_OCR]] as const) {
  test(`Bestellung (${form}): alle Felder, zwei Firmen im Beleg → Kunde unklar`, () => {
    const e = belegErkennen(text);
    vertragPruefen(e);
    assert.deepEqual(kompakt(e), BESTELLUNG_SOLL);
    // Kunde: Briefkopf und Grußformel nennen verschiedene Firmen → nachfragen, nie die Empfängeranschrift (Euroflex)
    assert.deepEqual(e.kunde.kandidaten.map((k) => k.wert), [
      { name: 'MUSTER Verkehrstechnik GmbH', strasse: 'Musterallee 3', land: null, plz: '12345', ort: 'Musterstadt' },
      { name: 'Muster Straßentechnik GmbH', strasse: null, land: null, plz: null, ort: null },
    ]);
    assert.match(e.kunde.hinweis ?? '', /zwei Firmen/);
    assert.ok(e.hinweise.some((h) => /verschiedene Firmen/.test(h)));
    assert.match(e.frachtpreis_vk.herkunft ?? '', /Gesamtpreis \(netto\)/);
    assert.match(e.stops[0].ladenummer.herkunft ?? '', /Ladenr/);
    assert.match(e.gewicht.herkunft ?? '', /1\.200 kg/);
  });
}

test('Bestellung: dieselbe Firma in Briefkopf und Grußformel bzw. nur eine Firma → Kunde eindeutig', () => {
  const soll = { name: 'MUSTER Verkehrstechnik GmbH', strasse: 'Musterallee 3', land: null, plz: '12345', ort: 'Musterstadt' };
  for (const text of [BESTELLUNG_PDF, BESTELLUNG_OCR]) {
    const gleich = belegErkennen(text.replace('Muster Straßentechnik GmbH', 'Muster Verkehrstechnik GmbH'));
    assert.equal(gleich.kunde.status, 'eindeutig');
    assert.deepEqual(gleich.kunde.wert, soll);
    const ohneGruss = belegErkennen(text.replace('Muster Straßentechnik GmbH', ''));
    assert.deepEqual(ohneGruss.kunde.wert, soll);
    // nur die Firma der Grußformel: eindeutig, aber ohne Anschrift
    const ohneKopf = belegErkennen(text.replace('MUSTER Verkehrstechnik GmbH - Musterallee 3, 12345 Musterstadt', ''));
    assert.deepEqual(ohneKopf.kunde.wert, { name: 'Muster Straßentechnik GmbH', strasse: null, land: null, plz: null, ort: null });
    // ohne beide: fehlt – die Empfängeranschrift des Belegs (Euroflex) ist nie der Kunde
    const ohne = belegErkennen(text.replace('MUSTER Verkehrstechnik GmbH - Musterallee 3, 12345 Musterstadt', '').replace('Muster Straßentechnik GmbH', ''));
    assert.equal(ohne.kunde.status, 'fehlt');
    assert.equal(ohne.istFrachtauftrag, true);
  }
});

test('Bestellung: Gesamtpreis und Warenwert weichen ab → Preis unklar mit beiden Kandidaten', () => {
  const pdf = belegErkennen(BESTELLUNG_PDF.replace('Gesamtpreis (netto)          480,00   EUR', 'Gesamtpreis (netto)          455,00   EUR'));
  assert.equal(pdf.frachtpreis_vk.status, 'unklar');
  assert.deepEqual(pdf.frachtpreis_vk.kandidaten.map((k) => k.wert), [455, 480]);
  assert.match(pdf.frachtpreis_vk.hinweis ?? '', /weichen/);
  const ocr = belegErkennen(BESTELLUNG_OCR.replace('Gesamtpreis (netto)\n\n480,00 EUR', 'Gesamtpreis (netto)\n\n1.455,50 EUR'));
  assert.deepEqual(ocr.frachtpreis_vk.kandidaten.map((k) => k.wert), [1455.5, 480]);
  // Gesamtpreis nicht gelesen: der Warenwert wird nur vorgeschlagen, nicht übernommen
  const ohne = belegErkennen(BESTELLUNG_PDF.replace(/Gesamtpreis.*\n/, ''));
  assert.equal(ohne.frachtpreis_vk.status, 'unklar');
  assert.deepEqual(ohne.frachtpreis_vk.kandidaten.map((k) => k.wert), [480]);
});

test('Bestellung (Texterkennung): Kopfwerte ohne sichere Reihenfolge werden nicht geraten', () => {
  // Liefertermin leer: im Werteblock steht nur das Belegdatum → nachfragen statt das Belegdatum zu übernehmen
  const e = belegErkennen(BESTELLUNG_OCR.replace('ohne Abzug\n\n16.03.2027', 'ohne Abzug'));
  assert.equal(e.stops[0].datum_e.status, 'unklar');
  assert.deepEqual(e.stops[0].datum_e.kandidaten.map((k) => k.wert), ['2027-03-02']);
  assert.equal(e.stops[0].datum.wert, '2027-03-15', 'Ladetermin ist beschriftet und bleibt eindeutig');
  // Bestellnummer nicht an erster Stelle des Werteblocks → unklar mit den Nummern als Kandidaten
  const n = belegErkennen(BESTELLUNG_OCR.replace('Liefertermin\n\n470011\n', 'Liefertermin\n\nSeite 1\n\n470011\n'));
  assert.equal(n.ordernummer.status, 'unklar');
  assert.deepEqual(n.ordernummer.kandidaten.map((k) => k.wert), ['470011', '7001234']);
  vertragPruefen(e);
  vertragPruefen(n);
});

test('Bestellung: widersprüchliche Angaben im Freitext → unklar; fehlende → fehlt', () => {
  const e = belegErkennen(BESTELLUNG_PDF.replace('6,2 LM, ca. 1.200 kg', '6,2 LM, ca. 1.200 kg\n                         alternativ 7 LM / 900 kg'));
  assert.equal(e.lademeter.status, 'unklar');
  assert.deepEqual(e.lademeter.kandidaten.map((k) => k.wert), [6.2, 7]);
  assert.deepEqual(e.gewicht.kandidaten.map((k) => k.wert), [1.2, 0.9]);
  const o = belegErkennen(BESTELLUNG_OCR.replace('6,2 LM, ca. 1.200 kg', '').replace('Ladenr.: AB/27/03/11', '').replace('Kontakt: +32 2 555 01 31', ''));
  assert.deepEqual([o.lademeter.status, o.gewicht.status, o.stops[0].ladenummer.status], ['fehlt', 'fehlt', 'fehlt']);
  assert.equal(o.besonderheiten.wert, 'Lieferbedingung: frei Haus');
});

// ───────────────────────── Layout „ladeauftrag“ ─────────────────────────

for (const [form, text] of [['pdftotext', LADEAUFTRAG_PDF], ['Texterkennung', LADEAUFTRAG_OCR]] as const) {
  test(`Ladeauftrag (${form}): alle Felder, „wie Auftraggeber“, 00:00:00 = keine Zeitvorgabe`, () => {
    const e = belegErkennen(text);
    vertragPruefen(e);
    const { besonderheiten, ...rest } = kompakt(e);
    assert.deepEqual(rest, LADEAUFTRAG_SOLL);
    assert.equal(besonderheiten, `Ladungssicherung: mindestens 12 Spanngurte, Kantenschutz Auf dem Werksgelände Warnweste tragen.${form === 'pdftotext' ? '\nInfo: Avis 24 h vorher' : ''}\nDigitale Anmeldung LKW nur noch per App`);
    // ohne Länderkennzeichen wird das Land nicht gesetzt, sondern nur vorgeschlagen
    assert.deepEqual(e.stops[0].land.kandidaten.map((k) => k.wert), ['DE']);
    assert.match(e.stops[0].firma.herkunft ?? '', /wie Auftraggeber/);
    // die 13,6 der LKW-Art ist die Fahrzeuglänge, kein Lademeter
    assert.match(e.lademeter.hinweis ?? '', /Fahrzeuglänge/);
    assert.deepEqual(e.hinweise, []);
  });

  test(`Ladeauftrag (${form}): echte Uhrzeit wird als Zeit übernommen`, () => {
    const e = belegErkennen(text.replace(/11\.01\.2027\s+00:00:00/, '11.01.2027 07:30:00').replace(/14\.01\.2027\s+00:00:00/, '14.01.27 14:00'));
    assert.deepEqual([e.stops[0].datum.wert, e.stops[0].zeit.wert, e.stops[0].datum_e.wert, e.stops[0].zeit_e.wert], ['2027-01-11', '07:30', '2027-01-14', '14:00']);
    assert.equal(e.leistungsdatum.wert, '2027-01-11');
  });

  test(`Ladeauftrag (${form}): Bruttogewicht und Gesamtgewicht weichen ab → Gewicht unklar`, () => {
    const e = belegErkennen(text.replace('Bruttogewicht: 18,250 TO', 'Bruttogewicht: 17,900 TO'));
    assert.equal(e.gewicht.status, 'unklar');
    assert.deepEqual(e.gewicht.kandidaten.map((k) => k.wert), [18.25, 17.9]);
    assert.match(e.gewicht.hinweis ?? '', /weichen/);
    // nur eine der beiden Angaben → eindeutig
    assert.equal(belegErkennen(text.replace('Bruttogewicht: 18,250 TO', '')).gewicht.wert, 18.25);
  });

  test(`Ladeauftrag (${form}): eigene Verladeadresse mit Länderkennzeichen`, () => {
    const adr = form === 'pdftotext'
      ? 'Probe Sägewerk AG\n                                           Sägeweg 7\n                                           A-6020 Innsbruck'
      : 'Probe Sägewerk AG\nSägeweg 7\nA-6020 Innsbruck';
    const e = belegErkennen(text.replace('wie Auftraggeber', adr));
    const s = e.stops[0];
    assert.deepEqual([s.firma.wert, s.strasse.wert, s.land.wert, s.plzort.wert], ['Probe Sägewerk AG', 'Sägeweg 7', 'AT', '6020 Innsbruck']);
    assert.equal(e.kunde.wert?.name, 'Musterholz GmbH & Co. KG');
    assert.equal(s.firma_e.wert, 'Beispiel Türenwerke GmbH, Werk Probstadt');
    assert.equal(e.frachtpreis_vk.wert, 1275);
  });

  test(`Ladeauftrag (${form}): zwei Anlieferadressen → zweiter Stop, Gewichte summiert`, () => {
    const zweite = form === 'pdftotext'
      ? 'Bruttogewicht: 10,000 TO\n                                           Test Baumarkt GmbH\n                                           Ringstr. 4\n                                           L-1234 Testingen\n                                           Bruttogewicht: 8,250 TO'
      : 'Bruttogewicht: 10,000 TO\n\nTest Baumarkt GmbH\nRingstr. 4\nL-1234 Testingen\nBruttogewicht: 8,250 TO';
    const e = belegErkennen(text.replace('Bruttogewicht: 18,250 TO', zweite));
    vertragPruefen(e);
    assert.equal(e.stops.length, 2);
    assert.equal(e.stops[0].plzort_e.wert, '98765 Probstadt');
    const s = e.stops[1];
    assert.deepEqual([s.firma_e.wert, s.strasse_e.wert, s.land_e.wert, s.plzort_e.wert], ['Test Baumarkt GmbH', 'Ringstr. 4', 'LU', '1234 Testingen']);
    assert.deepEqual([s.firma.status, s.datum.status, s.datum_e.status], ['fehlt', 'fehlt', 'fehlt']);
    assert.equal(e.gewicht.wert, 18.25, '10,000 + 8,250 = Gesamtgewicht der Tour');
    assert.ok(e.hinweise.some((h) => /mehrere Anlieferadressen/.test(h)));
    assert.equal(e.frachtpreis_vk.wert, 1275);
  });
}

test('Ladeauftrag (Texterkennung): passt ein Wert nicht zur Beschriftung, endet die Zuordnung – der Rest bleibt leer', () => {
  // das Verladedatum fehlt im Werteblock: ab dort wird nichts mehr zugeordnet (kein Verrutschen der Werte)
  const e = belegErkennen(LADEAUFTRAG_OCR.replace('wie Auftraggeber\n11.01.2027 00:00:00\n14.01.2027 00:00:00', 'wie Auftraggeber\nnach Absprache\n14.01.2027 00:00:00'));
  vertragPruefen(e);
  assert.equal(e.kunde.wert?.name, 'Musterholz GmbH & Co. KG');
  assert.equal(e.stops[0].firma.wert, 'Musterholz GmbH & Co. KG');
  assert.deepEqual([e.stops[0].datum.status, e.stops[0].datum_e.status, e.stops[0].firma_e.status, e.frachtpreis_vk.status, e.fahrzeugtyp.status],
    ['fehlt', 'fehlt', 'fehlt', 'fehlt', 'fehlt']);
  assert.ok(e.hinweise.some((h) => /Verladedatum/.test(h) && /nicht sicher zuordnen/.test(h)));
  assert.equal(e.ordernummer.wert, '88001234');
});

test('zu lange Werte werden auf die Feldlänge der Maske gekürzt und in den Hinweisen genannt', () => {
  const lang = 'Beispiel Türenwerke und Holzverarbeitungsgesellschaft Mitteldeutschland GmbH';
  const e = belegErkennen(LADEAUFTRAG_PDF.replace('Beispiel Türenwerke GmbH', lang));
  assert.equal(e.stops[0].firma_e.status, 'eindeutig');
  assert.equal(e.stops[0].firma_e.wert?.length, 60);
  assert.ok(lang.startsWith(e.stops[0].firma_e.wert?.slice(0, 50) ?? '?'));
  assert.ok(e.hinweise.some((h) => /gekürzt/.test(h) && h.includes(lang)));
  const b = belegErkennen(BESTELLUNG_PDF.replace('AB/27/03/11', 'AB/27/03/11-NACHLIEFERUNG-TEIL-2-VON-3'));
  assert.equal(b.stops[0].ladenummer.wert, 'AB/27/03/11-NACHLIEFERUNG-TEIL');
  assert.ok(b.hinweise.some((h) => /Ladenummer.*30 Zeichen gekürzt/.test(h)));
});

// ───────────────────────── Layout-Wahl ─────────────────────────

test('Layout-Wahl: nur aktive Layouts; passendes Layout nicht aktiv → allgemein; nichts aktiv → kein Frachtauftrag', () => {
  assert.equal(layoutErkennen(BESTELLUNG_OCR), 'bestellung');
  assert.equal(layoutErkennen(LADEAUFTRAG_PDF), 'ladeauftrag');
  assert.equal(layoutErkennen(RECHNUNG), null);

  // „bestellung“ deaktiviert: gelesen wird über die allgemeinen Schlagworte (beschriftete Felder bleiben erhalten)
  const b = belegErkennen(BESTELLUNG_PDF, ['ladeauftrag', 'allgemein']);
  vertragPruefen(b);
  assert.equal(b.layout, 'allgemein');
  assert.equal(b.istFrachtauftrag, true);
  assert.deepEqual([b.ordernummer.wert, b.stops[0].firma.wert, b.stops[0].plzort_e.wert, b.stops[0].datum.wert, b.stops[0].datum_e.wert, b.frachtpreis_vk.wert],
    ['470011', 'Musterhalle Nord', '1000 Exempelville', '2027-03-15', '2027-03-16', 480]);
  assert.equal(b.kunde.status, 'fehlt', 'allgemein: kein beschrifteter Auftraggeber → kein Kunde');
  assert.ok(b.hinweise.some((h) => /nicht aktiv/.test(h)));

  const l = belegErkennen(LADEAUFTRAG_PDF, ['bestellung', 'allgemein']);
  assert.equal(l.layout, 'allgemein');
  assert.equal(l.istFrachtauftrag, true);
  assert.deepEqual([l.kunde.wert?.name, l.stops[0].datum.wert, l.frachtpreis_vk.wert, l.gewicht.wert], ['Musterholz GmbH & Co. KG', '2027-01-11', 1275, 18.25]);
  assert.equal(l.stops[0].firma.status, 'fehlt', '„wie Auftraggeber“ kennt nur das Layout ladeauftrag');
  assert.equal(l.fahrzeugtyp.status, 'fehlt');

  // passendes Layout und „allgemein“ deaktiviert bzw. gar nichts aktiv → leere Felder
  for (const aktiv of [['ladeauftrag'], []] as ('ladeauftrag')[][]) {
    const e = belegErkennen(BESTELLUNG_PDF, aktiv);
    vertragPruefen(e);
    assert.equal(e.istFrachtauftrag, false);
    assert.ok(leer(e));
    assert.ok(e.hinweise.length > 0);
  }
  assert.equal(belegErkennen(LADEAUFTRAG_OCR, ['ladeauftrag']).frachtpreis_vk.wert, 1275);
});

test('kein Frachtauftrag: Rechnung, Lieferschein, beliebiger Text, leerer Text', () => {
  const lieferschein = 'Lieferschein\nLieferschein-Nr. 4711\nLieferadresse:\nBeispiel Handels GmbH\nAm Markt 3\n66606 St. Wendel\nLiefertermin: 05.02.2027\n10 Pal. Musterware, 900 kg';
  const brief = 'Sehr geehrte Damen und Herren,\n\nvielen Dank für Ihre Anfrage vom 05.02.2027. Wir melden uns in Kürze.\n\nMit freundlichen Grüßen\nMuster Logistik AG';
  // Anschrift ohne Preis und Termin bzw. Preis ohne Anschrift: zu wenige Merkmale
  const nurAdresse = 'Ladestelle:\nMusterhalle Nord\nWerkstr. 1\nD-12345 Musterstadt';
  const nurPreis = 'Frachtpreis: 480,00 EUR\nLadetermin: 15.03.2027';
  for (const text of [RECHNUNG, lieferschein, brief, nurAdresse, nurPreis, '', '   \n \n']) {
    const e = belegErkennen(text);
    vertragPruefen(e);
    assert.equal(e.istFrachtauftrag, false, text.slice(0, 30));
    assert.ok(leer(e), text.slice(0, 30));
    assert.equal(e.layout, 'allgemein');
  }
  assert.ok(belegErkennen('').hinweise.some((h) => /keinen lesbaren Text/.test(h)));
});

// ───────────────────────── Layout „allgemein“ ─────────────────────────

const ALLGEMEIN = `Transportauftrag Nr.: TA-2027-0815

Auftraggeber:
Probe Handels GmbH
Hauptstr. 12
D-55555 Probhausen

Beladestelle: Musterlager Ost
Industriering 5
D-12345 Musterstadt
Ladedatum: 03.05.2027 08:00 Uhr
Ladenummer: REF-4711

Entladestelle:
Exempel B.V.
Voorbeeldlaan 9
NL-1234 AB Voorbeeld
Entladedatum: 04.05.27

Ware: 12 Paletten Musterware, 4.900 kg, 4,8 Lademeter
Frachtpreis: 890,00 EUR
`;

test('allgemeines Layout: beschriftete Felder werden gelesen', () => {
  const e = belegErkennen(ALLGEMEIN);
  vertragPruefen(e);
  assert.deepEqual(kompakt(e), {
    layout: 'allgemein', istFrachtauftrag: true,
    kunde: { name: 'Probe Handels GmbH', strasse: 'Hauptstr. 12', land: 'DE', plz: '55555', ort: 'Probhausen' },
    ordernummer: 'TA-2027-0815', leistungsdatum: '2027-05-03', frachtpreis_vk: 890, gewicht: 4.9, lademeter: 4.8,
    fahrzeugtyp: 'fehlt', ladegut: 'fehlt', ladeweise: 'fehlt', palettentausch: 'fehlt', besonderheiten: 'fehlt',
    stops: [{
      firma: 'Musterlager Ost', strasse: 'Industriering 5', land: 'DE', plzort: '12345 Musterstadt', ladenummer: 'REF-4711', datum: '2027-05-03', zeit: '08:00',
      firma_e: 'Exempel B.V.', strasse_e: 'Voorbeeldlaan 9', land_e: 'NL', plzort_e: '1234 AB Voorbeeld', datum_e: '2027-05-04', zeit_e: 'fehlt',
    }],
  });
});

test('allgemeines Layout ist streng: Unbeschriftetes bleibt leer, Widersprüche werden nachgefragt', () => {
  // Anschrift, Datum, Betrag und Tonnen ohne Beschriftung werden nicht zugeordnet
  const e = belegErkennen(`Anfrage Transport
Musterlager Ost, Industriering 5, D-12345 Musterstadt
nach
Exempel B.V., NL-1234 AB Voorbeeld
03.05.2027, 24 t, 890,00 EUR, Auftrag 4711

Entladestelle:
Exempel B.V.
Voorbeeldlaan 9
NL-1234 AB Voorbeeld
Entladedatum: 04.05.2027`);
  vertragPruefen(e);
  assert.equal(e.istFrachtauftrag, true);
  assert.deepEqual([e.stops[0].firma.status, e.stops[0].datum.status, e.frachtpreis_vk.status, e.gewicht.status, e.ordernummer.status, e.kunde.status],
    ['fehlt', 'fehlt', 'fehlt', 'fehlt', 'fehlt', 'fehlt']);
  assert.equal(e.stops[0].datum_e.wert, '2027-05-04');

  // zwei verschiedene Preise bzw. Ladestellen → unklar
  const w = belegErkennen(`${ALLGEMEIN}\nFrachtrate: 950,00 EUR\nLadestelle:\nAnderes Lager\nNebenweg 2\nD-54321 Anderstadt\nLadetermin: 06.05.2027`);
  vertragPruefen(w);
  assert.deepEqual(w.frachtpreis_vk.kandidaten.map((k) => k.wert), [890, 950]);
  assert.deepEqual(w.stops[0].firma.kandidaten.map((k) => k.wert), ['Musterlager Ost', 'Anderes Lager']);
  assert.deepEqual(w.stops[0].plzort.kandidaten.map((k) => k.wert), ['12345 Musterstadt', '54321 Anderstadt']);
  assert.deepEqual(w.stops[0].datum.kandidaten.map((k) => k.wert), ['2027-05-03', '2027-05-06']);
  assert.equal(w.leistungsdatum.status, 'unklar');
  assert.equal(w.stops[0].zeit.status, 'fehlt');
});

// ───────────────────────── Zahlen, Datum, Anschrift ─────────────────────────

test('Zahlen, Gewichte, Lademeter, Datum und PLZ/Ort im deutschen Format', () => {
  assert.deepEqual([zahl('1.275,00')?.wert, zahl('18,250')?.wert, zahl('4,5')?.wert, zahl('900')?.wert, zahl('12a')], [1275, 18.250, 4.5, 900, null]);
  assert.deepEqual(gewichte('ca. 900 kg').map((g) => g.tonnen), [0.9]);
  assert.deepEqual(gewichte('Bruttogewicht: 18,250 TO / 24 t / 1.200 kg').map((g) => [g.tonnen, g.sicher]), [[18.250, true], [24, true], [1.2, true]]);
  // „18.250 TO“: Tausender- oder Dezimalpunkt? → unsicher; Wörter mit t sind kein Gewicht
  assert.deepEqual(gewichte('18.250 TO').map((g) => g.sicher), [false]);
  assert.deepEqual(gewichte('Innerhalb 14 Tagen netto, 1,00 St, LKW mit Plane 13,6'), []);
  assert.deepEqual(lademeter('6,2 LM, 13,6 Lademeter, LDM: 7').map((z) => z.wert), [6.2, 13.6, 7]);
  assert.deepEqual(lademeter('LKW mit Plane 13,6 / 2 LKW'), []);
  assert.deepEqual(termine('08.12.2026 / 8.1.27 / 27.11.2026 00:00:00 / 27.11.2026 07:30:00 / 31.02.2027 / 1.2.3').map((t) => [t.datum, t.zeit]),
    [['2026-12-08', null], ['2027-01-08', null], ['2026-11-27', null], ['2026-11-27', '07:30']]);
  assert.deepEqual(plzOrt('D-66839 Musterstadt'), { land: 'DE', landPraefix: 'D', plz: '66839', ort: 'Musterstadt' });
  assert.deepEqual(plzOrt('B - 7940 Exempelville'), { land: 'BE', landPraefix: 'B', plz: '7940', ort: 'Exempelville' });
  assert.deepEqual(plzOrt('54321 Musterheim am See'), { land: null, landPraefix: null, plz: '54321', ort: 'Musterheim am See' });
  assert.equal(plzOrt('Musterstraße 12'), null);
  assert.equal(plzOrt('1275 EUR'), null);
});

test('Sonderfälle: unbekanntes Länderkennzeichen, vierstellige PLZ ohne Kennzeichen, Windows-Zeilenenden', () => {
  const e = belegErkennen(ALLGEMEIN.replace('D-12345 Musterstadt', 'XY-12345 Musterstadt').replace('NL-1234 AB Voorbeeld', '1234 Voorbeeld').replace(/\n/g, '\r\n'));
  vertragPruefen(e);
  assert.equal(e.stops[0].land.status, 'fehlt');
  assert.match(e.stops[0].land.hinweis ?? '', /XY/);
  assert.equal(e.stops[0].plzort.wert, '12345 Musterstadt');
  assert.equal(e.stops[0].land_e.status, 'fehlt');
  assert.equal(e.stops[0].plzort_e.wert, '1234 Voorbeeld');
  assert.equal(e.frachtpreis_vk.wert, 890);
});
