/**
 * Zuwendungsbestätigungen – Regeln ohne Datenbank: Betrag in Buchstaben (deutsche Zahlwörter mit Euro und Cent),
 * Gültigkeit des Bescheids (5 bzw. 3 Jahre), fehlende Pflichtangaben, Textbausteine, PDF (Einzel, Sammel mit Anlage).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { betragInWorten, zahlwort } from '../../modules/tco/server/zuwendung/zahlwort.js';
import { TEXTE, PLATZHALTER, texteMischen, textePruefen, fuellen } from '../../modules/tco/server/zuwendung/texte.js';

test('Zahlwort: Einer, Zehner, Besonderheiten (eins/ein, sechzehn, siebzig, dreißig)', () => {
  const erwartet: [number, string][] = [
    [0, 'null'], [1, 'eins'], [2, 'zwei'], [7, 'sieben'], [10, 'zehn'], [11, 'elf'], [12, 'zwölf'], [13, 'dreizehn'], [16, 'sechzehn'], [17, 'siebzehn'], [19, 'neunzehn'],
    [20, 'zwanzig'], [21, 'einundzwanzig'], [30, 'dreißig'], [36, 'sechsunddreißig'], [60, 'sechzig'], [66, 'sechsundsechzig'], [70, 'siebzig'], [77, 'siebenundsiebzig'], [99, 'neunundneunzig'],
    [100, 'einhundert'], [101, 'einhunderteins'], [110, 'einhundertzehn'], [111, 'einhundertelf'], [121, 'einhunderteinundzwanzig'], [200, 'zweihundert'], [999, 'neunhundertneunundneunzig'],
    [1000, 'eintausend'], [1001, 'eintausendeins'], [1100, 'eintausendeinhundert'], [2000, 'zweitausend'], [2026, 'zweitausendsechsundzwanzig'], [10000, 'zehntausend'],
    [21000, 'einundzwanzigtausend'], [100000, 'einhunderttausend'], [101000, 'einhunderteintausend'], [201001, 'zweihunderteintausendeins'],
    [999999, 'neunhundertneunundneunzigtausendneunhundertneunundneunzig'],
    [1000000, 'eine Million'], [1000001, 'eine Million eins'], [2000000, 'zwei Millionen'], [1200000, 'eine Million zweihunderttausend'],
    [21500030, 'einundzwanzig Millionen fünfhunderttausenddreißig'], [1000000000, 'eine Milliarde'], [3000000000, 'drei Milliarden'],
  ];
  for (const [n, wort] of erwartet) assert.equal(zahlwort(n), wort, String(n));
  assert.throws(() => zahlwort(-1), RangeError);
  assert.throws(() => zahlwort(1.5), RangeError);
  assert.throws(() => zahlwort(1e12), RangeError);
});

test('Betrag in Buchstaben: Euro und Cent, „ein Euro“, Rundung, keine negativen Beträge', () => {
  const erwartet: [number, string][] = [
    [0, 'null Euro'], [0.01, 'null Euro und ein Cent'], [0.5, 'null Euro und fünfzig Cent'], [1, 'ein Euro'], [1.01, 'ein Euro und ein Cent'], [2, 'zwei Euro'],
    [12.5, 'zwölf Euro und fünfzig Cent'], [21.21, 'einundzwanzig Euro und einundzwanzig Cent'], [50, 'fünfzig Euro'], [100, 'einhundert Euro'], [101, 'einhunderteins Euro'],
    [250, 'zweihundertfünfzig Euro'], [1000, 'eintausend Euro'], [1234.56, 'eintausendzweihundertvierunddreißig Euro und sechsundfünfzig Cent'],
    [19.99, 'neunzehn Euro und neunundneunzig Cent'], [1000000, 'eine Million Euro'], [1500000.3, 'eine Million fünfhunderttausend Euro und dreißig Cent'],
  ];
  for (const [b, wort] of erwartet) assert.equal(betragInWorten(b), wort, String(b));
  // Rundung auf Cent: Gleitkommareste und halbe Cent
  assert.equal(betragInWorten(0.1 + 0.2), 'null Euro und dreißig Cent');
  assert.equal(betragInWorten(1.005), 'ein Euro und ein Cent');
  assert.equal(betragInWorten(99.999), 'einhundert Euro');
  assert.equal(betragInWorten(33.3 * 3), 'neunundneunzig Euro und neunzig Cent');
  assert.throws(() => betragInWorten(-5), RangeError);
  assert.throws(() => betragInWorten(Number.NaN), RangeError);
  // jeder Cent-Betrag bis 2.000 € ergibt ein Wort ohne Lücken und doppelte Leerzeichen
  for (let c = 0; c <= 200000; c += 37) {
    const w = betragInWorten(c / 100);
    assert.match(w, /^[a-zäöüß]+( [A-Za-zäöüß]+)* Euro( und [a-zäöüß]+ Cent)?$/, `${c}: ${w}`);
  }
});

test('Textbausteine: Vorgaben vollständig, Platzhalter bekannt, eigene Texte geprüft und gemischt', () => {
  assert.equal(new Set(TEXTE.map((t) => t.schluessel)).size, TEXTE.length, 'Schlüssel eindeutig');
  for (const t of TEXTE) {
    assert.ok(t.standard.trim().length > 3, t.schluessel);
    const im = [...t.standard.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
    for (const p of im) assert.ok(p in PLATZHALTER, `${t.schluessel}: {${p}} ist beschrieben`);
    for (const p of t.pflicht ?? []) assert.ok(im.includes(p), `${t.schluessel}: Pflicht-Platzhalter {${p}} steht in der Vorgabe`);
  }
  // Pflichtangaben des Musters: Verzicht, Vermerk „kein Mitgliedsbeitrag“ (Sportverein), Haftung und Gültigkeit
  const s = texteMischen({});
  assert.match(s.verzicht, /Verzicht auf Erstattung von Aufwendungen/);
  assert.match(s.kein_beitrag, /nicht um einen Mitgliedsbeitrag handelt, dessen Abzug nach § 10b Abs\. 1 des Einkommensteuergesetzes ausgeschlossen ist/);
  assert.match(s.hinweis_haftung, /haftet für die entgangene Steuer/);
  assert.match(s.hinweis_gueltigkeit, /länger als 5 Jahre.*länger als 3 Jahre/);
  assert.match(s.freistellung, /§ 5 Abs\. 1 Nr\. 9 des Körperschaftsteuergesetzes/);
  assert.match(s.feststellung, /§ 60a AO gesondert festgestellt/);
  assert.match(s.sammel_keine_weiteren, /keine weiteren Bestätigungen/);

  // unverändert übernommene Vorgaben werden nicht gespeichert; leere Angabe = Vorgabe
  assert.deepEqual(textePruefen({ verwendung: s.verwendung, kein_beitrag: '  ' }), { texte: {}, fehler: [] });
  const eigen = textePruefen({ verwendung: 'Die Zuwendung wird nur zur {Zweck} verwendet.', unbekannt: 'x' });
  assert.deepEqual(eigen, { texte: { verwendung: 'Die Zuwendung wird nur zur {Zweck} verwendet.' }, fehler: [] });
  assert.equal(texteMischen(eigen.texte).verwendung, 'Die Zuwendung wird nur zur {Zweck} verwendet.');
  assert.equal(texteMischen(eigen.texte).kein_beitrag, s.kein_beitrag);
  assert.match(textePruefen({ verwendung: 'ohne Platzhalter' }).fehler[0], /Platzhalter \{Zweck\} fehlt/);
  assert.match(textePruefen({ kein_beitrag: 'Text mit {Unsinn}' }).fehler[0], /unbekannter Platzhalter \{Unsinn\}/);
  assert.equal(fuellen('wegen {Zweck} ({Fremd})', { Zweck: 'Förderung des Sports' }), 'wegen Förderung des Sports ({Fremd})');
});

const { bescheidPruefen, cfgFehlt, plusJahre, sperren, zbNummer } = await import('../../modules/tco/server/zuwendung/logik.js');
const { zuwendungPdf, zuwendungTitel } = await import('../../modules/tco/server/zuwendung/pdf.js');
type Cfg = import('../../modules/tco/server/zuwendung/logik.js').Cfg;
type Dokument = import('../../modules/tco/server/zuwendung/pdf.js').Dokument;

const verein = { name: 'TC Test e. V.', strasse: 'Am Netz 1', plz_ort: '66649 Oberthal' };
const cfg = (x: Partial<Cfg> = {}): Cfg => ({
  bescheid_art: 'FREISTELLUNG', finanzamt: 'St. Wendel', steuernummer: '030/140/12345', bescheid_datum: '2023-05-10', veranlagungszeitraum: '2019 bis 2021',
  zweck: 'Förderung des Sports', zweck_satzung: 'den Sport', unterzeichner: 'Karla Kasse', funktion: 'Kassenwartin', ort: 'Oberthal', unterschrift: null,
  spendenkonten: ['8100'], spendenarten: [], mail_erlaubt: false, texte: {}, muster_geprueft_am: '2026-01-02 10:00:00+00', muster_geprueft_von: 'Karla Kasse', ...x,
});

test('Bescheid: Freistellungsbescheid höchstens 5 Jahre, Feststellung nach § 60a AO höchstens 3 Jahre alt', () => {
  assert.equal(plusJahre('2021-11-15', 5), '2026-11-15');
  assert.equal(plusJahre('2024-02-29', 3), '2027-02-28');
  // Freistellungsbescheid vom 15.11.2021: am 15.11.2026 noch verwendbar, am 16.11.2026 nicht mehr
  const f = { bescheid_art: 'FREISTELLUNG' as const, bescheid_datum: '2021-11-15' };
  assert.deepEqual([bescheidPruefen(f, '2026-11-15').ok, bescheidPruefen(f, '2026-11-15').gueltig_bis], [true, '2026-11-15']);
  const zuAlt = bescheidPruefen(f, '2026-11-16');
  assert.equal(zuAlt.ok, false);
  assert.match(zuAlt.text, /Freistellungsbescheid.*vom 15\.11\.2021 ist älter als 5 Jahre \(gültig bis 15\.11\.2026\).*nicht mehr ausgestellt/);
  // Feststellungsbescheid: 3 Jahre
  const s = { bescheid_art: 'FESTSTELLUNG' as const, bescheid_datum: '2023-11-15' };
  assert.equal(bescheidPruefen(s, '2026-11-15').ok, true);
  assert.match(bescheidPruefen(s, '2026-11-16').text, /§ 60a AO vom 15\.11\.2023 ist älter als 3 Jahre/);
  // derselbe Bescheid als Freistellungsbescheid wäre noch gültig – die Art entscheidet
  assert.equal(bescheidPruefen({ ...s, bescheid_art: 'FREISTELLUNG' }, '2026-11-16').ok, true);
  assert.equal(bescheidPruefen({ bescheid_art: '', bescheid_datum: null }, '2026-11-15').ok, false);
  assert.match(bescheidPruefen({ ...f, bescheid_datum: '2027-01-01' }, '2026-11-15').text, /liegt in der Zukunft/);
});

test('Sperren: fehlende Pflichtangaben, abgelaufener Bescheid, Wortlaut nicht abgeglichen', () => {
  assert.deepEqual(sperren(cfg(), verein, '2026-11-15'), []);
  assert.deepEqual(cfgFehlt(cfg({ finanzamt: ' ', unterzeichner: '', veranlagungszeitraum: '' }), verein), ['Finanzamt', 'Veranlagungszeitraum', 'Unterzeichner']);
  // Veranlagungszeitraum nur beim Freistellungsbescheid, Zweck laut Satzung nur bei § 60a AO
  assert.deepEqual(cfgFehlt(cfg({ bescheid_art: 'FESTSTELLUNG', veranlagungszeitraum: '', zweck_satzung: '' }), verein), ['Zweck laut Satzung']);
  assert.deepEqual(cfgFehlt(cfg({ spendenkonten: [], spendenarten: [] }), { name: 'TC', strasse: null, plz_ort: null }), ['Anschrift des Vereins (Verein und Bank)', 'Spendenkonten oder Spenden-Beitragsarten']);
  assert.deepEqual(cfgFehlt(cfg({ spendenkonten: [], spendenarten: ['101'] }), verein), []);
  const leer = sperren(cfg({ bescheid_art: '', bescheid_datum: null, muster_geprueft_am: null }), verein, '2026-11-15');
  assert.equal(leer.length, 2);
  assert.match(leer[0], /In den Einstellungen fehlt: Art des Bescheids, Datum des Bescheids\./);
  assert.match(leer[1], /noch nicht mit dem amtlichen Muster des BMF abgeglichen/);
  assert.match(sperren(cfg({ bescheid_datum: '2020-01-01' }), verein, '2026-11-15')[0], /älter als 5 Jahre/);
  assert.equal(zbNummer(2026, 7), 'ZB-2026-0007');
  assert.equal(zbNummer(2026, 12345), 'ZB-2026-12345');
});

test('PDF: Einzelbestätigung eine Seite, Sammelbestätigung mit Anlage, Sammeldruck in einer Datei', async () => {
  const basis = {
    jahr: 2026, aussteller: verein, spender: { name: 'Mia Matchball', anschrift: ['Am Netz 1', '66649 Oberthal'] },
    bescheid: { art: 'FREISTELLUNG' as const, finanzamt: 'St. Wendel', steuernummer: '030/140/12345', datum: '2023-05-10', veranlagungszeitraum: '2019 bis 2021' },
    zweck: 'Förderung des Sports', zweck_satzung: 'den Sport', ort: 'Oberthal', datum: '2026-11-15', unterzeichner: 'Karla Kasse', funktion: 'Kassenwartin', unterschrift: null, texte: texteMischen({}),
  };
  const einzel: Dokument = { ...basis, nummer: 'ZB-2026-0001', art: 'EINZEL', betrag: 250, betrag_worte: betragInWorten(250), tag: '2026-03-14', zeitraum: null, verzicht: false, positionen: [{ datum: '2026-03-14', art: 'Geldspende', verzicht: false, betrag: 250 }] };
  const positionen = Array.from({ length: 60 }, (_x, i) => ({ datum: `2026-${String((i % 12) + 1).padStart(2, '0')}-10`, art: 'Geldspende', verzicht: i % 7 === 0, betrag: 10 + i }));
  const summe = positionen.reduce((s, p) => s + p.betrag, 0);
  const sammel: Dokument = { ...basis, nummer: null, art: 'SAMMEL', betrag: summe, betrag_worte: betragInWorten(summe), tag: null, zeitraum: { von: '2026-01-01', bis: '2026-11-15' }, verzicht: false, positionen };
  const seiten = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
  const v = { ...verein, iban: 'DE02120300000000202051', bank: 'Testbank', steuernr: '030/140/12345' } as never;
  const a = await zuwendungPdf(v, [einzel]);
  assert.equal(a.subarray(0, 5).toString(), '%PDF-');
  assert.equal(seiten(a), 1, 'Einzelbestätigung passt auf eine Seite');
  const b = await zuwendungPdf(v, [sammel]);
  assert.equal(seiten(b), 3, 'Sammelbestätigung: Bestätigung und zwei Seiten Anlage bei 60 Zuwendungen');
  assert.equal(seiten(await zuwendungPdf(v, [einzel, sammel, einzel])), 5, 'Sammeldruck');
  assert.equal(zuwendungTitel(einzel), 'Zuwendungsbestätigung ZB-2026-0001');
  assert.equal(zuwendungTitel(sammel), 'Sammelbestätigung 2026 – Vorschau');
});
