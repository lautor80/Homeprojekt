import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fahrtKennung, fahrtSicht, fahrtenBereinigen, kennungZerlegen, routenSchluessel, unternehmerText, zusammenfuehrenPruefen, type Kandidat,
} from '../../modules/transport/server/fahrten.js';

/** Mehrere Fahrten in einem Auftrag: reine Regeln (ohne Datenbank) */
test('Fahrten: Kennung – eine Fahrt behält die Auftragsnummer, mehrere bekommen „-Position“', () => {
  assert.equal(fahrtKennung('2026_1260', 1, 1), '2026_1260');
  assert.equal(fahrtKennung('2026_1260', 1, 2), '2026_1260-1');
  assert.equal(fahrtKennung('2026_1260', 2, 2), '2026_1260-2');
  assert.deepEqual(kennungZerlegen('2026_1260-2'), { auftragsnr: '2026_1260', pos: 2 });
  assert.deepEqual(kennungZerlegen('2026_1260'), { auftragsnr: '2026_1260', pos: null });
});

test('Fahrten: leere Zeilen entfallen, Positionen laufen ab 2', () => {
  const leer = { unternehmer: null, kennzeichen: '  ', fahrzeugtyp: '001', frachtpreis_vk: 0, ladedatum: null };
  const r = fahrtenBereinigen([leer, { ...leer, unternehmer: 7301, kennzeichen: ' SB-AB 1 ' }, { ...leer, frachtpreis_vk: 1200 }]);
  assert.deepEqual(r.map((f) => f.pos), [2, 3]);
  assert.equal(r[0].kennzeichen, 'SB-AB 1');
  assert.equal(r[1].frachtpreis_vk, 1200);
});

test('Fahrten: Unternehmer-Spalte der Liste', () => {
  assert.equal(unternehmerText(['ROL-HURT', null, '']), 'ROL-HURT');
  assert.equal(unternehmerText(['ROL-HURT', 'ROL-HURT']), 'ROL-HURT');
  assert.equal(unternehmerText(['Internationaal Transport', 'ROL-HURT']), '2 Unternehmer');
  assert.equal(unternehmerText([]), '');
});

test('Fahrten: Sicht einer Fahrt übernimmt Unternehmer, Fahrzeug, Preis und Ladedatum', () => {
  const a = {
    auftragsnr: '2026_1260', unternehmer: 7301, unternehmerAdr: { n: 'A' }, kennzeichen: 'SB-AB 1', fahrzeugtyp: '001', frachtpreis_vk: 1200,
    stops: [{ datum: '2026-10-30', firma: 'Lager' }, { datum: null, firma: null }], kunde: 7300,
    fahrten: [{ pos: 2, unternehmer: 7302, unternehmerAdr: { n: 'B' }, kennzeichen: 'WA 123', fahrzeugtyp: '002', frachtpreis_vk: 1150, ladedatum: '2026-10-31' }],
  };
  const eins = fahrtSicht(a, 1)!;
  assert.equal(eins.kennung, '2026_1260-1');
  assert.equal(eins.auftrag.unternehmer, 7301);
  const zwei = fahrtSicht(a, 2)!;
  assert.equal(zwei.kennung, '2026_1260-2');
  assert.deepEqual([zwei.auftrag.unternehmer, zwei.auftrag.unternehmerAdr, zwei.auftrag.kennzeichen, zwei.auftrag.fahrzeugtyp, zwei.auftrag.frachtpreis_vk],
    [7302, { n: 'B' }, 'WA 123', '002', 1150]);
  assert.equal(zwei.auftrag.stops[0].datum, '2026-10-31');
  assert.equal(zwei.auftrag.stops[0].firma, 'Lager');
  assert.equal(zwei.auftrag.kunde, 7300);
  assert.equal(a.stops[0].datum, '2026-10-30', 'der Auftrag selbst bleibt unverändert');
  assert.equal(fahrtSicht(a, 3), null);
  // ohne weitere Fahrten bleibt die Nummer, wie sie ist
  assert.equal(fahrtSicht({ ...a, fahrten: [] }, 1)!.kennung, '2026_1260');
});

const k = (x: Partial<Kandidat> & { auftragsnr: string }): Kandidat => ({
  typ: 'F', kunde: 7300, rechnungsempfaenger: null, faktura: null, abgeschlossen_am: null, steuerrelevant: true, steuerbefreiung: null,
  hatTraeger: false, route: 'a|b', ordernummer: null, ladenummer: null, ...x,
});

test('Zusammenführen: Ziel ist die kleinste Nummer, die übrigen werden Fahrten', () => {
  const r = zusammenfuehrenPruefen([k({ auftragsnr: '2026_1261' }), k({ auftragsnr: '2026_1260' })]);
  assert.deepEqual(r, { ziel: '2026_1260', quellen: ['2026_1261'], fehler: [], hinweise: [] });
});

test('Zusammenführen: abgelehnt bei Rechnung, Abschluss, anderem Kunden, anderer Route, Holzträgern, anderer Steuer', () => {
  const basis = k({ auftragsnr: '2026_1260' });
  const fehler = (x: Partial<Kandidat>) => zusammenfuehrenPruefen([basis, k({ auftragsnr: '2026_1261', ...x })]).fehler.join(' ');
  assert.match(zusammenfuehrenPruefen([basis]).fehler.join(' '), /mindestens zwei/);
  assert.match(fehler({ faktura: '2026_6205' }), /fakturiert \(2026_6205\)/);
  assert.match(fehler({ abgeschlossen_am: '2026-11-16' }), /wieder öffnen/);
  assert.match(fehler({ kunde: 7399 }), /anderen Kunden/);
  assert.match(fehler({ rechnungsempfaenger: 7398 }), /anderen Rechnungsempfänger/);
  assert.match(fehler({ route: 'a|c' }), /dieselbe Route/);
  assert.match(fehler({ typ: 'H' }), /Holzträger/);
  assert.match(fehler({ hatTraeger: true }), /Holzträger/);
  assert.match(fehler({ steuerrelevant: false, steuerbefreiung: 'RC' }), /Mehrwertsteuer/);
  assert.match(zusammenfuehrenPruefen([k({ auftragsnr: '2026_1260', kunde: null }), k({ auftragsnr: '2026_1261', kunde: null })]).fehler.join(' '), /keinen Kunden/);
});

test('Zusammenführen: abweichende Auftragsnr. Kunde und Ladenummer werden als Hinweis genannt', () => {
  const r = zusammenfuehrenPruefen([
    k({ auftragsnr: '2026_1260', ordernummer: 'BE-1', ladenummer: 'L-1' }),
    k({ auftragsnr: '2026_1261', ordernummer: 'BE-2', ladenummer: 'L-1' }),
    k({ auftragsnr: '2026_1262', ordernummer: null, ladenummer: 'L-9' }),
  ]);
  assert.deepEqual(r.fehler, []);
  assert.deepEqual(r.quellen, ['2026_1261', '2026_1262']);
  assert.equal(r.hinweise.length, 2);
  assert.match(r.hinweise[0], /„BE-2“ von 2026_1261 entfällt/);
  assert.match(r.hinweise[1], /Ladenummer „L-9“ von 2026_1262 entfällt/);
});

test('Route: Termine, Ladenummern, Groß-/Kleinschreibung und Leerzeichen zählen nicht', () => {
  const s = { firma: 'MEISER', strasse: 'Am Werk 1', land: 'DE', plzort: '66839 Limbach', firma_e: 'laut LFS', strasse_e: 'laut LFS', land_e: 'DE', plzort_e: '85354 Freising' };
  const leer = { firma: null, strasse: null, land: null, plzort: null, firma_e: null, strasse_e: null, land_e: null, plzort_e: null };
  const a = routenSchluessel([{ ...s, datum: '2026-10-30', ladenummer: 'L-1' } as typeof s, leer]);
  const b = routenSchluessel([{ ...s, firma: 'Meiser', plzort: '66839  limbach ' }, leer]);
  assert.equal(a, b);
  assert.notEqual(a, routenSchluessel([{ ...s, plzort_e: '80331 München' }, leer]));
});
