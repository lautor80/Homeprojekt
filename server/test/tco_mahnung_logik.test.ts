/**
 * Mahnwesen – Regeln ohne Datenbank: Fälligkeit, Stufen und nächster Schritt, Sperren, Mindestbetrag, Plan eines Laufs
 * (je Schuldner eine E-Mail, Obergrenze), Zeitplan der Automatik, Prüfung der Einstellungen, Werte der E-Mail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  automatikFaellig, CFG_SCHEMA, faelligkeit, lokal, MAHN_MAILTEXTE, mailtextSchluessel, mailWerte, naechsterLauf, notizText, planen, standErmitteln, STANDARD_STUFEN,
  type HistorieZeile, type OffenerPosten, type SperreZeile,
} from '../../modules/tco/server/mahnung/logik.js';
import { fuellen } from '../../modules/tco/server/mailtexte.js';

const CFG = { stufen: STANDARD_STUFEN, frist_tage: 10, mindestbetrag: 5, max_je_lauf: 50 };
const HEUTE = '2026-11-15';
const p = (nr: string, schuldner: string, betrag: number, faellig: string, art: 'HALLE' | 'VERZEHR' = 'HALLE'): OffenerPosten =>
  ({ art, nr, schuldner, name: `Name ${schuldner}`, betrag, gesamt: betrag, datum: '2026-09-01', faellig });
let hid = 0;
const h = (nr: string, stufe: number, status: HistorieZeile['status'], tag: string, mehr: Partial<HistorieZeile> = {}): HistorieZeile =>
  ({ id: ++hid, lauf_id: 1, art: 'HALLE', nr, stufe, stufe_name: STANDARD_STUFEN[stufe - 1]?.name ?? `Stufe ${stufe}`, status, tag, frist: null, an: 'a@b.example', meldung: null, weg: 'MAIL', ...mehr });
const einer = (posten: OffenerPosten, historie: HistorieZeile[] = [], sperren: SperreZeile[] = [], heute = HEUTE, adressen?: Map<string, string>) =>
  standErmitteln([posten], historie, sperren, CFG, heute, adressen)[0];

test('Fälligkeit: eigenes Datum des Belegs, sonst Rechnungs-/Versanddatum + Zahlungsziel', () => {
  assert.equal(faelligkeit('2026-10-01', null, 14), '2026-10-15');
  assert.equal(faelligkeit('2026-10-01', '2026-10-31', 14), '2026-10-31');
  assert.equal(faelligkeit('2026-12-25', undefined, 10), '2027-01-04');
});

test('Stufen: Erinnerung nach der Fälligkeit, jede weitere Stufe nach Zustellung der vorherigen', () => {
  // innerhalb des Zahlungsziels und in der Karenz nach Fälligkeit: keine Mahnung
  assert.equal(einer(p('R1', 'A', 50, '2026-11-15')).schritt, 'NICHT_FAELLIG');
  let s = einer(p('R1', 'A', 50, '2026-11-10'));
  assert.deepEqual([s.schritt, s.ab, s.stufe, s.naechste_name], ['WARTET', '2026-11-17', 0, 'Zahlungserinnerung']);
  // 7 Tage nach Fälligkeit: Zahlungserinnerung
  s = einer(p('R1', 'A', 50, '2026-11-08'));
  assert.deepEqual([s.schritt, s.naechste, s.ab], ['MAHNEN', 1, '2026-11-15']);
  // Erinnerung zugestellt: 1. Mahnung erst 14 Tage später
  s = einer(p('R1', 'A', 50, '2026-10-01'), [h('R1', 1, 'GESENDET', '2026-11-05')]);
  assert.deepEqual([s.schritt, s.stufe, s.stufe_name, s.gemahnt_am, s.naechste_name, s.ab], ['WARTET', 1, 'Zahlungserinnerung', '2026-11-05', '1. Mahnung', '2026-11-19']);
  s = einer(p('R1', 'A', 50, '2026-10-01'), [h('R1', 1, 'GESENDET', '2026-11-01')]);
  assert.deepEqual([s.schritt, s.naechste], ['MAHNEN', 2]);
  // eine nicht zugestellte Stufe zählt nicht: der Posten bleibt auf der erreichten Stufe
  s = einer(p('R1', 'A', 50, '2026-10-01'), [h('R1', 1, 'GESENDET', '2026-10-10'), h('R1', 2, 'NICHT_ERREICHBAR', '2026-10-25', { an: '', meldung: 'keine E-Mail-Adresse hinterlegt' })]);
  assert.deepEqual([s.schritt, s.stufe, s.naechste, s.versuch?.meldung], ['UNERREICHBAR', 1, 2, 'keine E-Mail-Adresse hinterlegt']);
  // Fälligkeit 0 Tage Karenz: frühestens am Tag nach der Fälligkeit
  const sofort = standErmitteln([p('R2', 'A', 50, HEUTE)], [], [], { ...CFG, stufen: [{ name: 'Erinnerung', tage: 0, gebuehr: 0 }] }, HEUTE)[0];
  assert.equal(sofort.schritt, 'NICHT_FAELLIG');
  assert.equal(standErmitteln([p('R2', 'A', 50, '2026-11-14')], [], [], { ...CFG, stufen: [{ name: 'Erinnerung', tage: 0, gebuehr: 0 }] }, HEUTE)[0].schritt, 'MAHNEN');
});

test('Nach der letzten Stufe: keine weitere Mahnung, nach Ablauf der Frist „manuell klären“', () => {
  const hist = [h('R1', 1, 'GESENDET', '2026-09-01'), h('R1', 2, 'GESENDET', '2026-09-20'), h('R1', 3, 'GESENDET', '2026-11-10', { frist: '2026-11-20' })];
  let s = einer(p('R1', 'A', 50, '2026-08-01'), hist);
  assert.deepEqual([s.schritt, s.stufe, s.naechste, s.ab], ['WARTET', 3, null, '2026-11-21']);
  s = einer(p('R1', 'A', 50, '2026-08-01'), hist, [], '2026-11-21');
  assert.equal(s.schritt, 'KLAEREN');
  assert.match(s.hinweis, /2\. Mahnung vom 10\.11\.2026 ohne Zahlung/);
  // wer „manuell klären“ ist, wird nie eingeplant
  assert.deepEqual(planen([s], CFG).mails, []);
});

test('Vorschlag, Fehlversuch und geänderte Adresse', () => {
  const posten = p('R1', 'A', 50, '2026-10-01');
  // offener Vorschlag: nicht noch einmal vorschlagen
  assert.equal(einer(posten, [h('R1', 1, 'VORSCHLAG', '2026-11-14')]).schritt, 'VORSCHLAG');
  // technischer Fehler: der nächste Lauf versucht es erneut
  assert.equal(einer(posten, [h('R1', 1, 'FEHLER', '2026-11-14', { meldung: 'n8n nicht erreichbar' })]).schritt, 'MAHNEN');
  // nicht erreichbar: erst wieder, wenn sich die Adresse geändert hat
  const nicht = [h('R1', 1, 'NICHT_ERREICHBAR', '2026-11-14', { an: 'alt@b.example', meldung: 'unzustellbar' })];
  assert.equal(einer(posten, nicht).schritt, 'UNERREICHBAR');
  assert.equal(einer(posten, nicht, [], HEUTE, new Map([['A', 'ALT@b.example']])).schritt, 'UNERREICHBAR');
  assert.equal(einer(posten, nicht, [], HEUTE, new Map([['A', 'neu@b.example']])).schritt, 'MAHNEN');
  // verworfene und entfallene Zeilen zählen nicht
  assert.equal(einer(posten, [h('R1', 1, 'VERWORFEN', '2026-11-14'), h('R1', 1, 'ENTFALLEN', '2026-11-14')]).schritt, 'MAHNEN');
});

test('Mahnsperre je Rechnung und je Schuldner, mit Ablaufdatum', () => {
  const posten = p('R1', 'A', 50, '2026-10-01');
  const rechnung: SperreZeile = { id: 1, ebene: 'RECHNUNG', art: 'HALLE', schluessel: 'R1', grund: 'strittig', bis: null };
  let s = einer(posten, [], [rechnung]);
  assert.deepEqual([s.schritt, s.sperre?.grund], ['GESPERRT', 'strittig']);
  // gleiche Nummer, andere Art: nicht gesperrt
  assert.equal(einer({ ...posten, art: 'VERZEHR' }, [], [rechnung]).schritt, 'MAHNEN');
  const person: SperreZeile = { id: 2, ebene: 'SCHULDNER', art: null, schluessel: 'A', grund: 'Ratenzahlung', bis: '2026-11-15' };
  s = einer(posten, [], [person]);
  assert.equal(s.schritt, 'GESPERRT');
  assert.match(s.hinweis, /Ratenzahlung \(bis 15\.11\.2026\)/);
  assert.equal(einer(posten, [], [person], '2026-11-16').schritt, 'MAHNEN', 'abgelaufene Sperre');
  assert.equal(einer({ ...posten, schuldner: 'B' }, [], [person]).schritt, 'MAHNEN');
});

test('Mindestbetrag je Schuldner und Plan: je Schuldner eine E-Mail, höchste Stufe bestimmt Text und Gebühr, Obergrenze', () => {
  const cfg = { ...CFG, stufen: [{ name: 'Zahlungserinnerung', tage: 7, gebuehr: 0 }, { name: '1. Mahnung', tage: 14, gebuehr: 2.5 }, { name: '2. Mahnung', tage: 14, gebuehr: 5 }] };
  const stand = standErmitteln([
    p('R1', 'A', 40, '2026-10-01'), p('V1', 'A', 12.5, '2026-09-15', 'VERZEHR'), p('R2', 'A', 99, '2026-11-14'),   // A: zwei fällige, einer nicht
    p('R3', 'B', 3, '2026-10-01'),                                                                                  // B: Kleinbetrag
    p('R4', 'C', 2.5, '2026-10-01'), p('R5', 'C', 2.5, '2026-10-02'),                                               // C: zusammen genau 5 €
    p('R6', 'D', 70, '2026-08-01'),
  ], [h('R1', 1, 'GESENDET', '2026-10-20')], [], cfg, HEUTE);
  assert.equal(stand.find((x) => x.nr === 'R3')!.schritt, 'KLEINBETRAG');
  assert.equal(stand.find((x) => x.nr === 'R4')!.schritt, 'MAHNEN');
  const plan = planen(stand, cfg);
  assert.deepEqual(plan.mails.map((m) => m.schuldner), ['D', 'A', 'C'], 'älteste Forderung zuerst');
  const a = plan.mails.find((m) => m.schuldner === 'A')!;
  assert.deepEqual([a.posten.map((x) => x.nr), a.stufe, a.stufe_name, a.summe, a.gebuehr], [['V1', 'R1'], 2, '1. Mahnung', 52.5, 2.5]);
  assert.deepEqual(a.posten.map((x) => x.naechste), [1, 2]);
  assert.equal(plan.mails.find((m) => m.schuldner === 'C')!.summe, 5);
  // Obergrenze: der Rest wartet auf den nächsten Lauf
  const klein = planen(stand, { ...cfg, max_je_lauf: 2 });
  assert.deepEqual([klein.mails.map((m) => m.schuldner), klein.zurueckgestellt.map((m) => m.schuldner)], [['D', 'A'], ['C']]);
});

test('Automatik: aus = nie fällig; Wochentag, Uhrzeit, einmal je Tag', () => {
  const sonntag0900 = new Date('2026-11-15T08:00:00Z'); // 09:00 Uhr in Oberthal, Sonntag
  assert.deepEqual(lokal(sonntag0900), { datum: '2026-11-15', zeit: '09:00', wochentag: 7 });
  const cfg = { aktiv: true, wochentage: '1,7', uhrzeit: '08:00', letzter_lauf: null as string | null };
  assert.equal(automatikFaellig({ ...cfg, aktiv: false }, sonntag0900), false, 'Automatik aus');
  assert.equal(automatikFaellig(cfg, sonntag0900), true);
  assert.equal(automatikFaellig({ ...cfg, uhrzeit: '09:01' }, sonntag0900), false, 'vor der Uhrzeit');
  assert.equal(automatikFaellig({ ...cfg, wochentage: '1,2,3' }, sonntag0900), false, 'falscher Wochentag');
  assert.equal(automatikFaellig({ ...cfg, wochentage: '' }, sonntag0900), false, 'kein Wochentag gewählt');
  assert.equal(automatikFaellig({ ...cfg, letzter_lauf: '2026-11-15T07:05:00Z' }, sonntag0900), false, 'heute schon gelaufen');
  assert.equal(automatikFaellig({ ...cfg, letzter_lauf: '2026-11-14T22:30:00Z' }, sonntag0900), true, 'gestern (Ortszeit) gelaufen');
  assert.equal(naechsterLauf(cfg, sonntag0900), '2026-11-15');
  assert.equal(naechsterLauf({ ...cfg, letzter_lauf: '2026-11-15T07:05:00Z' }, sonntag0900), '2026-11-16');
  assert.equal(naechsterLauf({ ...cfg, wochentage: '3' }, sonntag0900), '2026-11-18');
  assert.equal(naechsterLauf({ ...cfg, aktiv: false }, sonntag0900), null);
});

test('Einstellungen: Vorgaben und Prüfungen', () => {
  const gut = {
    aktiv: false, modus: 'VORSCHLAG', wochentage: [1], uhrzeit: '08:00', zahlungsziel_tage: '', frist_tage: 10, stufen: STANDARD_STUFEN, mindestbetrag: '5', max_je_lauf: 50,
    arten: ['HALLE', 'VERZEHR'], halle_gedruckt: false, anhang: true, absender: '', absender_name: '', antwort_an: '', kopie_an: '',
  };
  const ok = CFG_SCHEMA.parse(gut);
  assert.deepEqual([ok.wochentage, ok.zahlungsziel_tage, ok.arten, ok.mindestbetrag], ['1', null, 'HALLE,VERZEHR', 5]);
  assert.deepEqual(STANDARD_STUFEN.map((s) => [s.name, s.gebuehr]), [['Zahlungserinnerung', 0], ['1. Mahnung', 0], ['2. Mahnung', 0]], 'Vorgabe: drei Stufen ohne Gebühr');
  const fehler = (x: object) => CFG_SCHEMA.safeParse({ ...gut, ...x }).error?.issues[0]?.message ?? '';
  assert.match(fehler({ aktiv: true, wochentage: [] }), /mindestens einen Wochentag/);
  assert.match(fehler({ uhrzeit: '25:00' }), /HH:MM/);
  assert.match(fehler({ stufen: [] }), /Mindestens eine Stufe/);
  assert.match(fehler({ stufen: Array.from({ length: 5 }, (_x, i) => ({ name: `S${i}`, tage: 14, gebuehr: 0 })) }), /Höchstens 4 Stufen/);
  assert.match(fehler({ stufen: [STANDARD_STUFEN[0], { name: '1. Mahnung', tage: 5, gebuehr: 0 }] }), /mindestens 10 Tage nach der vorherigen Stufe/);
  assert.match(fehler({ stufen: [STANDARD_STUFEN[0], { ...STANDARD_STUFEN[1], name: 'zahlungserinnerung' }] }), /unterscheiden/);
  assert.match(fehler({ stufen: [{ name: 'X', tage: 7, gebuehr: 80 }] }), /höchstens 50/);
  assert.match(fehler({ kopie_an: 'kein-at' }), /gültige E-Mail-Adresse/);
  assert.equal(CFG_SCHEMA.parse({ ...gut, zahlungsziel_tage: 21, wochentage: [5, 1, 5], arten: ['VERZEHR'] }).wochentage, '1,5');
});

test('E-Mail: Platzhalter je Stufe, Posten, Gebühr und Bankverbindung', () => {
  const v = { name: 'TC Test', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'Testbank', ansprechpartner: 'Kai Kasse' };
  const posten = [{ ...p('2026_1', 'A', 70, '2026-10-01'), gesamt: 100 }, p('VZM-1', 'A', 12.5, '2026-09-15', 'VERZEHR')];
  const w = mailWerte(v, 'Mia', { posten: posten as never, stufe_name: '1. Mahnung', summe: 82.5, gebuehr: 2.5 }, '2026-11-25');
  assert.equal(w.Anrede, 'Hallo Mia');
  assert.equal(w.Rechnungsnummer, '2026_1, VZM-1');
  assert.equal(w.Betrag, '85,00 €');
  assert.equal(w.Gebuehr, 'Darin enthalten ist eine Mahngebühr von 2,50 €.');
  assert.deepEqual([w.Faelligkeit, w.Frist, w.Stufe], ['15.09.2026', '25.11.2026', '1. Mahnung']);
  assert.match(w.Posten, /Hallenrechnung 2026_1 vom 01\.09\.2026, fällig am 01\.10\.2026: 70,00 € \(Rest von 100,00 €\)\nVerzehrabrechnung VZM-1 /);
  assert.match(w.Bankverbindung, /IBAN: DE02 1203 0000 0000 2020 51\nBIC: BYLADEM1001\nBank: Testbank\nVerwendungszweck: 2026_1, VZM-1/);
  assert.equal(mailWerte(v, ' ', { posten: posten as never, stufe_name: 'x', summe: 82.5, gebuehr: 0 }, '2026-11-25').Anrede, 'Guten Tag');
  // je Stufe ein pflegbarer Text; alle Platzhalter des Standardtextes sind bekannt und werden ersetzt
  assert.deepEqual(MAHN_MAILTEXTE.map((d) => d.schluessel), ['mahnung.stufe1', 'mahnung.stufe2', 'mahnung.stufe3', 'mahnung.stufe4']);
  assert.equal(mailtextSchluessel(9), 'mahnung.stufe4');
  for (const d of MAHN_MAILTEXTE) {
    const t = d.standard(v as never);
    const text = fuellen(`${t.betreff}\n${t.text}`, w);
    assert.ok(!/\{[A-Za-z]+\}/.test(text), `${d.schluessel}: unersetzter Platzhalter in\n${text}`);
    assert.ok(text.includes('85,00 €') && text.includes('2026_1') && text.includes('25.11.2026') && text.includes('Kai Kasse'), d.schluessel);
    for (const pf of d.pflicht ?? []) assert.ok(t.text.includes(`{${pf}}`));
  }
  // ohne Gebühr bleibt keine Lücke
  const ohne = fuellen(MAHN_MAILTEXTE[0].standard(v as never).text, mailWerte(v, 'Mia', { posten: posten as never, stufe_name: 'Zahlungserinnerung', summe: 82.5, gebuehr: 0 }, '2026-11-25'));
  assert.ok(!ohne.includes('Mahngebühr') && !/\n{3,}/.test(ohne));
});

test('Paperless-Notiz: gesendet, nicht zugestellt und von Hand vermerkt', () => {
  const basis = { stufe_name: '1. Mahnung', zeitpunkt: '17.11.2026 10:15', wer: 'system (Mahnlauf)', betrag: 45, lauf_id: 7 };
  const g = notizText({ ...basis, ergebnis: 'GESENDET', an: 'max@tco-test.example', gebuehr: 5, frist: '2026-11-27', anhaenge: ['Rechnung_H-0815.pdf'] });
  assert.match(g, /^1\. Mahnung per E-Mail gesendet am 17\.11\.2026 10:15 an max@tco-test\.example \(Mahnlauf 7\)/);
  assert.match(g, /offen 45,00 €, Mahngebühr 5,00 €, neue Zahlungsfrist 27\.11\.2026, Anhang: Rechnung_H-0815\.pdf$/);
  assert.match(notizText({ ...basis, ergebnis: 'GESENDET', an: 'x@y.example' }), /ohne Anhang$/);
  const n = notizText({ ...basis, ergebnis: 'NICHT_ERREICHBAR', an: '', meldung: 'keine E-Mail-Adresse hinterlegt' });
  assert.match(n, /^1\. Mahnung nicht zugestellt am .*: keine E-Mail-Adresse hinterlegt – offen 45,00 €\. Die Stufe gilt nicht als erreicht\.$/);
  assert.doesNotMatch(n, / an  /);
  const z = notizText({ ...basis, lauf_id: null, ergebnis: 'ZUGESTELLT', weg: 'BRIEF', wer: 'Kassenwart', frist: '2026-11-27', meldung: 'Einschreiben' });
  assert.equal(z, '1. Mahnung per Brief zugestellt, vermerkt am 17.11.2026 10:15 durch Kassenwart – offen 45,00 €, neue Zahlungsfrist 27.11.2026 – Einschreiben');
});
