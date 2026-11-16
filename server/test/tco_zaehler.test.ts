/**
 * Zählerstände (Bereich Instandhaltung): Rechenregeln (Verbrauch, Überlauf, Zählerwechsel, Verteilung auf Monate/Jahre,
 * Kennzahlen mit Hochrechnung, Plausibilitätsprüfung, CSV lesen/schreiben) und die Schnittstellen (Zähler pflegen, Stände
 * erfassen mit Fehler und Warnung, Auswertung, Jahresvergleich, Export, Import, Löschen mit Begründung, Rechte, Arbeitsvorrat).
 *
 * Eigene Testdaten: Zähler „ZT-Test …“, Rollen „ZT_TEST_…“.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  abschnitte, csvLesen, csvSchreiben, jahresvergleich, kennzahlen, mitVerbrauch, perioden, pruefen, reihe, ueberlaufMoeglich, verlauf12, verteilen,
  type Stand,
} from '../../modules/tco/server/zaehler/logik.js';
import { addTage, heute } from '../../modules/tco/server/format.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');

const { zeitraum } = await import('../../modules/tco/server/zaehler/daten.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, p: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: p, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, roh: res.rawPayload, typ: ct };
  };
}
const call = client();
const Z = '/api/m/tco/zaehler';

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await call('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
});
after(async () => {
  await app?.close();
  await sql.end();
});

// ---------------------------------------------------------------------------
// reine Funktionen
// ---------------------------------------------------------------------------
const EINFACH = { faktor: 1, stellen: null };
const s = (datum: string, stand: number, art: Stand['art'] = 'ABLESUNG', id?: number): Stand => ({ datum, stand, art, id });

test('Verbrauch: Differenz × Faktor', () => {
  const ab = abschnitte([s('2025-02-01', 1310), s('2025-01-01', 1000)], EINFACH);
  assert.equal(ab.length, 1);
  assert.deepEqual([ab[0].von.datum, ab[0].bis.datum, ab[0].tage, ab[0].verbrauch], ['2025-01-01', '2025-02-01', 31, 310]);
  assert.equal(abschnitte([s('2025-01-01', 1000), s('2025-02-01', 1310)], { faktor: 10.5, stellen: null })[0].verbrauch, 3255);
});

test('Überlauf des Zählwerks: nur mit Stellenzahl und wenn plausibel', () => {
  assert.equal(ueberlaufMoeglich(999_800, 200, 6), true);
  assert.equal(ueberlaufMoeglich(500_000, 100, 6), false, 'mehr als 10 % des Zählbereichs – kein Überlauf');
  assert.equal(ueberlaufMoeglich(999_800, 200, null), false);
  assert.equal(abschnitte([s('2025-01-01', 999_800), s('2025-02-01', 200)], { faktor: 1, stellen: 6 })[0].verbrauch, 400);
  assert.equal(abschnitte([s('2025-01-01', 999_800), s('2025-02-01', 200)], EINFACH)[0].verbrauch, -999_600);
});

test('Zählerwechsel: Ausbau vor Einbau am selben Tag, ab dem Einbau neuer Zähler ohne Verbrauch dazwischen', () => {
  const liste = mitVerbrauch([s('2025-03-01', 0, 'EINBAU', 3), s('2025-01-01', 1000, 'ABLESUNG', 1), s('2025-04-01', 200, 'ABLESUNG', 4), s('2025-03-01', 1500, 'AUSBAU', 2)], EINFACH);
  assert.deepEqual(liste.map((x) => x.art), ['ABLESUNG', 'AUSBAU', 'EINBAU', 'ABLESUNG']);
  assert.deepEqual(liste.map((x) => x.verbrauch), [null, 500, null, 200]);
  assert.deepEqual(liste.map((x) => x.tagesverbrauch), [null, 8.475, null, 6.452]);
  // Monate: Januar/Februar vom alten, März vom neuen Zähler
  assert.deepEqual(reihe(liste, EINFACH, ['2025-01', '2025-02', '2025-03', '2025-04'], 'monat'), [262.712, 237.288, 200, null]);
});

test('Verteilung: gleichmäßig über Monats- und Jahresgrenzen, ohne Abdeckung null', () => {
  // 15.01. → 15.03.: 59 Tage, 590 → 10 je Tag: Januar 17 Tage, Februar 28, März 14
  const st = [s('2025-01-15', 0), s('2025-03-15', 590)];
  assert.deepEqual(reihe(st, EINFACH, perioden('2024-12', '2025-04', 'monat'), 'monat'), [null, 170, 280, 140, null]);
  assert.deepEqual(perioden('2024-11', '2025-02', 'monat'), ['2024-11', '2024-12', '2025-01', '2025-02']);
  assert.deepEqual(perioden('2023-05', '2025-01', 'jahr'), ['2023', '2024', '2025']);
  const jahr = verteilen(abschnitte([s('2024-12-22', 0), s('2025-01-11', 200)], EINFACH), 'jahr');
  assert.deepEqual([...jahr], [['2024', 100], ['2025', 100]]);
  // zwei Stände am selben Tag: ganz zu diesem Tag
  assert.deepEqual([...verteilen(abschnitte([s('2025-05-31', 10), s('2025-05-31', 15, 'AUSBAU')], EINFACH), 'monat')], [['2025-05', 5]]);
});

test('Kennzahlen: Ø je Tag, laufendes Jahr, Vorjahr, Hochrechnung, Kosten, Ziel, Fälligkeit', () => {
  const z = { faktor: 1, stellen: null, intervall_tage: 30, arbeitspreis: 0.3, grundpreis_monat: 10, jahresziel: 3000, aktiv: true };
  const st = [s('2025-01-01', 0), s('2026-01-01', 3650), s('2026-07-01', 5460)];
  const k = kennzahlen(z, st, '2026-11-16');
  assert.deepEqual(k.letzteAblesung, { datum: '2026-07-01', stand: 5460 });
  assert.equal(k.tagesdurchschnitt, 10);
  assert.equal(k.verbrauchJahr, 1810);           // 181 Tage bis 01.07.
  assert.equal(k.verbrauchVorjahr, 3650);
  assert.equal(k.prognoseJahr, 1810 + 184 * 10); // + Ø × Tage 01.07. – 31.12.
  assert.equal(k.kostenPrognoseJahr, 1215);      // 0,30 × 3650 + 12 × 10
  assert.equal(k.veraenderungProzent, 0);
  assert.equal(k.zielUeberschritten, true);
  assert.equal(k.faelligAm, '2026-07-31');
  assert.equal(k.ueberfaellig, true);
  assert.equal(kennzahlen({ ...z, aktiv: false }, st, '2026-11-16').ueberfaellig, false, 'inaktive Zähler sind nie überfällig');
  assert.equal(kennzahlen(z, st, '2026-07-20').ueberfaellig, false);
  const ohne = kennzahlen({ ...z, intervall_tage: null, arbeitspreis: null, grundpreis_monat: null, jahresziel: null }, [], '2026-11-16');
  assert.deepEqual(ohne, {
    letzteAblesung: null, faelligAm: null, ueberfaellig: false, tagesdurchschnitt: null, verbrauchJahr: null, verbrauchVorjahr: null,
    prognoseJahr: null, kostenPrognoseJahr: null, veraenderungProzent: null, zielUeberschritten: false,
  });
  // Sparkline: 12 volle Monate vor dem Stichtagsmonat, ohne Daten 0
  const v = verlauf12(st, z, '2026-11-16');
  assert.equal(v.length, 12);
  assert.equal(v[0], 300);                       // November 2025: 30 Tage × 10
  assert.deepEqual(v.slice(-4), [0, 0, 0, 0]);   // Juli bis Oktober 2026 (nach der letzten Ablesung)
  const jv = jahresvergleich(st, z);
  assert.deepEqual(jv.map((j) => [j.jahr, j.summe]), [[2025, 3650], [2026, 1810]]);
  assert.deepEqual(jv[1].monate.slice(5, 8), [300, null, null]);
});

test('Plausibilität: Fehler und Warnungen', () => {
  const st = [s('2026-01-01', 100, 'ABLESUNG', 1), s('2026-02-01', 200, 'ABLESUNG', 2), s('2026-03-01', 300, 'ABLESUNG', 3), s('2026-04-01', 400, 'ABLESUNG', 4)];
  const T = '2026-11-16';
  assert.match(pruefen(EINFACH, st, s('2026-11-17', 900), T).fehler!, /Zukunft/);
  assert.match(pruefen(EINFACH, st, s('2026-05-01', 350), T).fehler!, /kleiner als der vorige \(400 am 01\.04\.2026\)/);
  assert.match(pruefen(EINFACH, st, s('2026-02-15', 350), T).fehler!, /größer als der folgende \(300 am 01\.03\.2026\)/);
  assert.equal(pruefen(EINFACH, st, s('2026-02-15', 250), T).fehler, null, 'nachträglich zwischen zwei Ständen');
  assert.match(pruefen(EINFACH, st, s('2026-04-01', 400), T).fehler!, /bereits ein Stand dieser Art/);
  assert.equal(pruefen(EINFACH, st, s('2026-04-01', 400, 'SCHAETZUNG'), T).fehler, null, 'andere Art am selben Tag');
  // normal
  const ok = pruefen(EINFACH, st, s('2026-05-01', 500), T);
  assert.deepEqual(ok, { fehler: null, warnung: null, verbrauch: 100, tagesverbrauch: 3.333, vorher: { datum: '2026-04-01', stand: 400 } });
  // mehr als dreimal so hoch wie üblich (Ø 300 / 90 Tage)
  const hoch = pruefen(EINFACH, st, s('2026-05-01', 900), T);
  assert.equal(hoch.fehler, null);
  assert.match(hoch.warnung!, /dreimal so hoch/);
  assert.equal(pruefen(EINFACH, st.slice(0, 3), s('2026-04-01', 2000), T).warnung, null, 'erst ab drei bisherigen Abschnitten');
  // kein Verbrauch über mehr als 60 Tage
  assert.match(pruefen(EINFACH, st, s('2026-06-15', 400), T).warnung!, /kein Verbrauch/);
  assert.equal(pruefen(EINFACH, st, s('2026-05-15', 400), T).warnung, null, '44 Tage ohne Verbrauch sind unauffällig');
  // Zählerwechsel: Einbau darf kleiner sein, danach zählt der neue Zähler
  const ein = pruefen(EINFACH, st, s('2026-05-01', 0, 'EINBAU'), T);
  assert.deepEqual([ein.fehler, ein.warnung, ein.verbrauch], [null, null, null]);
  assert.equal(pruefen(EINFACH, [...st, s('2026-05-01', 0, 'EINBAU', 5)], s('2026-04-15', 450), T).fehler, null, 'vor einem Einbau keine Prüfung gegen dessen Stand');
  // Überlauf: kein Fehler, aber zu bestätigen
  const ue = pruefen({ faktor: 1, stellen: 3 }, [s('2026-01-01', 990, 'ABLESUNG', 1)], s('2026-02-01', 5), T);
  assert.equal(ue.fehler, null);
  assert.equal(ue.verbrauch, 15);
  assert.match(ue.warnung!, /Überlauf/);
});

test('CSV lesen: Trenner, Kopfzeile, Datumsformate, deutsches Komma, Art, Fehler je Zeile', () => {
  const z = csvLesen('\uFEFFZähler;Datum;Stand;Art;Notiz\r\nZ0001;01.02.2026;1.234,5;Schätzung;geschätzt\r\n\r\nZ0002;2026-02-30;5;;\nZ0003;2026-02-01;abc\n;01.01.2026;1\nZ0004;1.3.2026;7;Einbau\nZ0005;01.03.2026;8;Zwischenstand\n');
  assert.deepEqual(z[0], { zeile: 2, zaehler: 'Z0001', datum: '2026-02-01', stand: 1234.5, art: 'SCHAETZUNG', notiz: 'geschätzt', fehler: null });
  assert.match(z[1].fehler!, /Datum „2026-02-30“ ungültig/);
  assert.equal(z[1].zeile, 4);
  assert.match(z[2].fehler!, /Stand „abc“/);
  assert.match(z[3].fehler!, /Zähler fehlt/);
  assert.deepEqual([z[4].datum, z[4].stand, z[4].art, z[4].fehler], ['2026-03-01', 7, 'EINBAU', null]);
  assert.match(z[5].fehler!, /Art „Zwischenstand“ unbekannt/);
  // Komma als Trenner, Spalten in anderer Reihenfolge über die Kopfzeile
  const k = csvLesen('Datum,Stand,Zählernummer\n2026-01-01,12.5,ABC-1\n');
  assert.deepEqual([k[0].zaehler, k[0].datum, k[0].stand, k[0].art], ['ABC-1', '2026-01-01', 12.5, 'ABLESUNG']);
  // ohne erkennbare Kopfzeile: erste Zeile mit Datum ist schon Daten
  assert.equal(csvLesen('Z1;01.01.2026;7\nZ1;01.02.2026;8').length, 2);
  assert.equal(csvLesen('Was;Wann;Wie viel\nZ1;01.01.2026;7').length, 1);
});

test('CSV schreiben: Semikolon, deutsches Zahlenformat, BOM – und wieder einlesbar', () => {
  const csv = csvSchreiben([
    { nummer: 'Z0001', bezeichnung: 'Strom; Halle', zaehlernummer: 'A1', medium: 'STROM', einheit: 'kWh', datum: '2026-02-01', stand: 1234.5, art: 'SCHAETZUNG', verbrauch: 12.25, notiz: 'mit "Zitat"' },
    { nummer: 'Z0001', bezeichnung: 'Strom; Halle', zaehlernummer: 'A1', medium: 'STROM', einheit: 'kWh', datum: '2026-01-01', stand: 1000, art: 'ABLESUNG', verbrauch: null, notiz: null },
  ]);
  assert.ok(csv.startsWith('\uFEFFZähler;Bezeichnung;Zählernummer;Medium;Einheit;Datum;Stand;Art;Verbrauch;Notiz\r\n'));
  assert.ok(csv.includes('Z0001;"Strom; Halle";A1;STROM;kWh;01.02.2026;1234,5;Schätzung;12,25;"mit ""Zitat"""\r\n'));
  const zurueck = csvLesen(csv);
  assert.deepEqual(zurueck.map((x) => [x.zaehler, x.datum, x.stand, x.art, x.notiz, x.fehler]), [
    ['Z0001', '2026-02-01', 1234.5, 'SCHAETZUNG', 'mit "Zitat"', null],
    ['Z0001', '2026-01-01', 1000, 'ABLESUNG', null, null],
  ]);
});

// ---------------------------------------------------------------------------
// Schnittstellen
// ---------------------------------------------------------------------------
const stamm = (x: Record<string, unknown> = {}) => ({
  bezeichnung: 'ZT-Test Strom Halle', medium: 'STROM', einheit: 'kWh', standort: 'Halle', zaehlernummer: 'ZT-4711', faktor: 1,
  verbrauchseinheit: null, stellen: 6, intervall_tage: 30, arbeitspreis: 0.3, grundpreis_monat: 10, jahresziel: 1000, aktiv: true, notiz: null, ...x,
});
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let zid = 0;
const sid: Record<string, number> = {};

test('Gegenprüfung: Ändern am Tag mit zwei Ständen, mehrzeilige Notiz, Datumsfehler in Zeile 1, Monatsraster „bis JJJJ“', () => {
  // Ändern: Schätzung (id 3) und Ablesung (id 7) am selben Tag – geprüft wird gegen den gespeicherten Vorgänger 400, nicht gegen 500
  const st: Stand[] = [{ id: 1, datum: '2025-04-01', stand: 400, art: 'ABLESUNG' }, { id: 7, datum: '2025-05-01', stand: 500, art: 'ABLESUNG' }];
  const p = pruefen({ faktor: 1, stellen: null }, st, { id: 3, datum: '2025-05-01', stand: 450, art: 'SCHAETZUNG' }, '2026-11-16');
  assert.equal(p.fehler, null);
  assert.equal(p.verbrauch, 50);
  // mehrzeilige Notiz übersteht Export und Import
  const csv = csvSchreiben([{ nummer: 'Z0001', bezeichnung: 'ZT', zaehlernummer: null, medium: 'STROM', einheit: 'kWh', datum: '2025-01-01', stand: 1, art: 'ABLESUNG', verbrauch: null, notiz: 'Zeile1\nZeile2' }]);
  const l = csvLesen(csv);
  assert.equal(l.length, 1);
  assert.equal(l[0].notiz, 'Zeile1\nZeile2');
  assert.equal(l[0].fehler, null);
  // ohne Kopfzeile: ungültiges Datum in Zeile 1 wird als Fehler gemeldet, nicht verschluckt
  const ohneKopf = csvLesen('Z0001;32.01.2025;100\nZ0001;01.02.2025;200');
  assert.equal(ohneKopf.length, 2);
  assert.match(ohneKopf[0].fehler ?? '', /32\.01\.2025/);
  assert.equal(ohneKopf[1].zeile, 2);
  // Monatsraster mit bis = Jahr: zwölf Monate dieses Jahres
  assert.deepEqual(zeitraum('monat', undefined, '2025', '2026-11-16'), { von: '2025-01', bis: '2025-12' });
  assert.deepEqual(zeitraum('monat', undefined, '2025-06', '2026-11-16'), { von: '2024-07', bis: '2025-06' });
});

test('Zähler anlegen und ändern (Nummernkreis Z…, Prüfung der Eingaben)', async () => {
  let r = await call('POST', Z, stamm());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nummer, 'Z0001');
  zid = r.body.id;
  r = await call('POST', Z, stamm({ bezeichnung: '' }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Bezeichnung/);
  assert.equal((await call('POST', Z, stamm({ medium: 'LUFT' }))).status, 400);
  assert.equal((await call('POST', Z, stamm({ faktor: 0 }))).status, 400);
  r = await call('PUT', `${Z}/${zid}`, stamm({ standort: 'Halle, Technikraum', stellen: '' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await call('GET', `${Z}/${zid}`);
  assert.equal(d.status, 200);
  assert.deepEqual([d.body.zaehler.standort, d.body.zaehler.stellen, d.body.zaehler.faktor, d.body.zaehler.arbeitspreis], ['Halle, Technikraum', null, 1, 0.3]);
  assert.equal((await call('GET', `${Z}/abc`)).status, 400);
  assert.equal((await call('GET', `${Z}/99999`)).status, 404);
  // Änderungsbeleg mit dem Objekt ZAEHLER
  const [b] = await sql`select count(*)::int as n from core.change_header where object_type = 'ZAEHLER' and object_key = 'Z0001'`;
  assert.equal(b.n, 2, 'Änderungsbelege ZAEHLER: Anlage und Änderung');
});

test('Stände erfassen: Prüfung, Fehler 400, Warnung 409 bis zur Bestätigung, Foto', async () => {
  for (const [datum, stand] of [['2025-01-01', 1000], ['2025-02-01', 1310], ['2025-03-01', 1590], ['2025-04-01', 1900]] as const) {
    const r = await call('POST', `${Z}/${zid}/staende`, { datum, stand, art: 'ABLESUNG', notiz: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    sid[datum] = r.body.id;
  }
  // Prüfen ohne Speichern
  let r = await call('POST', `${Z}/${zid}/staende/pruefen`, { datum: '2025-05-01', stand: '2.200,5'.replace('.', '').replace(',', '.'), art: 'ABLESUNG', notiz: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { fehler: null, warnung: null, verbrauch: 300.5, tagesverbrauch: 10.017, vorher: { datum: '2025-04-01', stand: 1900 } });
  // Fehler
  r = await call('POST', `${Z}/${zid}/staende`, { datum: '2025-05-01', stand: 1800, art: 'ABLESUNG', notiz: null });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /kleiner als der vorige/);
  r = await call('POST', `${Z}/${zid}/staende`, { datum: addTage(heute(), 2), stand: 5000, art: 'ABLESUNG', notiz: null });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Zukunft/);
  r = await call('POST', `${Z}/${zid}/staende`, { datum: '2025-04-01', stand: 1900, art: 'ABLESUNG', notiz: null });
  assert.equal(r.status, 400);
  // Warnung: erst mit Bestätigung
  r = await call('POST', `${Z}/${zid}/staende`, { datum: '2025-05-01', stand: 5000, art: 'ABLESUNG', notiz: null });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /dreimal so hoch/);
  r = await call('POST', `${Z}/${zid}/staende`, { datum: '2025-05-01', stand: 5000, art: 'ABLESUNG', notiz: 'Heizlüfter', bestaetigt: true, foto: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.pruefung.warnung, /dreimal/);
  sid['2025-05-01'] = r.body.id;
  // Foto
  const f = await call('GET', `${Z}/staende/${sid['2025-05-01']}/foto`);
  assert.equal(f.status, 200);
  assert.equal(f.typ, 'image/png');
  assert.equal(f.roh.subarray(1, 4).toString(), 'PNG');
  assert.equal((await call('GET', `${Z}/staende/${sid['2025-01-01']}/foto`)).status, 404);
  r = await call('POST', `${Z}/${zid}/staende`, { datum: '2025-05-02', stand: 5001, art: 'ABLESUNG', notiz: null, foto: 'data:text/plain;base64,QUJD' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /JPEG-, PNG- oder WebP/);
  // erfasst von
  const d = await call('GET', `${Z}/${zid}`);
  assert.deepEqual(d.body.staende.map((x: any) => x.datum), ['2025-05-01', '2025-04-01', '2025-03-01', '2025-02-01', '2025-01-01'], 'neueste zuerst');
  assert.deepEqual(d.body.staende.map((x: any) => x.verbrauch), [3100, 310, 280, 310, null]);
  assert.deepEqual([d.body.staende[0].hatFoto, d.body.staende[0].erfasstVon, d.body.staende[1].hatFoto], [true, 'Admin', false]);
});

test('Stand ändern (Prüfung ohne den eigenen Satz) und löschen nur mit Begründung', async () => {
  let r = await call('PUT', `${Z}/staende/${sid['2025-05-01']}`, { datum: '2025-05-01', stand: 2200, art: 'ABLESUNG', notiz: 'korrigiert', foto: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pruefung.verbrauch, 300);
  assert.equal((await call('GET', `${Z}/staende/${sid['2025-05-01']}/foto`)).status, 404, 'Foto entfernt');
  r = await call('PUT', `${Z}/staende/${sid['2025-04-01']}`, { datum: '2025-04-01', stand: 1500, art: 'ABLESUNG', notiz: null });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /kleiner als der vorige \(1590 am 01\.03\.2025\)/);
  r = await call('PUT', `${Z}/staende/${sid['2025-04-01']}`, { datum: '2025-04-01', stand: 2300, art: 'ABLESUNG', notiz: null });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /größer als der folgende/);
  // Löschen
  const neu = await call('POST', `${Z}/${zid}/staende`, { datum: '2025-05-10', stand: 2250, art: 'SCHAETZUNG', notiz: null });
  assert.equal(neu.status, 200, JSON.stringify(neu.body));
  r = await call('DELETE', `${Z}/staende/${neu.body.id}`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Begründung/);
  r = await call('DELETE', `${Z}/staende/${neu.body.id}`, { reason: 'falsch erfasst' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('DELETE', `${Z}/staende/${neu.body.id}`, { reason: 'nochmal' })).status, 404);
});

test('Übersicht, Auswertung, Jahresvergleich, Export, QR-Code, Ablesebogen', async () => {
  let r = await call('GET', Z);
  assert.equal(r.status, 200);
  const zeile = r.body.zeilen.find((x: any) => x.id === zid);
  assert.equal(zeile.nummer, 'Z0001');
  assert.equal(zeile.verlauf12.length, 12);
  assert.deepEqual(zeile.kennzahlen.letzteAblesung, { datum: '2025-05-01', stand: 2200 });
  assert.equal(zeile.kennzahlen.faelligAm, '2025-05-31');
  assert.equal(zeile.kennzahlen.ueberfaellig, true);

  r = await call('GET', `${Z}/auswertung?ids=${zid}&von=2024-12&bis=2025-05&raster=monat`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.perioden, ['2024-12', '2025-01', '2025-02', '2025-03', '2025-04', '2025-05']);
  const reihe0 = r.body.reihen[0];
  assert.deepEqual([reihe0.zaehlerId, reihe0.einheit, reihe0.medium], [zid, 'kWh', 'STROM']);
  assert.deepEqual(reihe0.verbrauch, [null, 310, 280, 310, 300, null]);
  assert.deepEqual(reihe0.kosten, [null, 103, 94, 103, 100, null]);
  assert.deepEqual([reihe0.summe, reihe0.kostenSumme], [1200, 400]);
  r = await call('GET', `${Z}/auswertung?ids=${zid}&von=2025&bis=2025&raster=jahr`);
  assert.deepEqual([r.body.perioden, r.body.reihen[0].verbrauch, r.body.reihen[0].kosten], [['2025'], [1200], [480]]);
  assert.equal((await call('GET', `${Z}/auswertung?von=2025-05&bis=2025-01`)).status, 400);
  assert.equal((await call('GET', `${Z}/auswertung?ids=x`)).status, 400);

  r = await call('GET', `${Z}/${zid}/jahresvergleich`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.jahre.map((j: any) => [j.jahr, j.summe]), [[2025, 1200]]);
  assert.deepEqual(r.body.jahre[0].monate.slice(0, 5), [310, 280, 310, 300, null]);

  r = await call('GET', `${Z}/export.csv?ids=${zid}&von=2025-02&bis=2025-04`);
  assert.equal(r.status, 200);
  assert.match(r.typ, /text\/csv/);
  const csv = r.roh.toString('utf8');
  assert.ok(csv.startsWith('\uFEFFZähler;Bezeichnung'));
  assert.ok(csv.includes('Z0001;ZT-Test Strom Halle;ZT-4711;STROM;kWh;01.02.2025;1310;Ablesung;310;\r\n'), csv);
  assert.equal(csv.trim().split('\r\n').length, 4, 'Kopf + Februar bis April');

  assert.equal((await call('GET', `${Z}/${zid}/qr`)).status, 400, 'ohne Portal-Adresse');
  assert.equal((await call('PUT', '/api/settings', { 'portal.url': 'https://portal.example.org' })).status, 200);
  r = await call('GET', `${Z}/${zid}/qr`);
  assert.equal(r.status, 200);
  assert.match(r.typ, /image\/svg\+xml/);
  assert.match(String(r.roh), /<svg/);

  r = await call('GET', `${Z}/ablesebogen.pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.typ, 'application/pdf');
  assert.equal(r.roh.subarray(0, 4).toString(), '%PDF');
});

test('Import: prüfen ändert nichts, übernehmen nur fehlerfreie Zeilen – abschaltbare Funktion', async () => {
  const csv = 'Zähler;Datum;Stand;Art;Notiz\nZ0001;01.06.2025;2.510,5;;Rundgang\nZT-4711;01.07.2025;2000\nUnbekannt;01.07.2025;1\nzt-test strom halle;01.07.2025;2810,5\n';
  const vorher = (await sql`select count(*)::int as n from tco.zaehlerstand where zaehler_id = ${zid}`)[0].n;
  let r = await call('POST', `${Z}/import`, { csv, uebernehmen: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.uebernommen, 0);
  assert.deepEqual(r.body.zeilen.map((z: any) => [z.zeile, z.zaehler, z.datum, z.stand, z.art, !!z.fehler]), [
    [2, 'Z0001 ZT-Test Strom Halle', '2025-06-01', 2510.5, 'ABLESUNG', false],
    [3, 'Z0001 ZT-Test Strom Halle', '2025-07-01', 2000, 'ABLESUNG', true],
    [4, 'Unbekannt', '2025-07-01', 1, 'ABLESUNG', true],
    [5, 'Z0001 ZT-Test Strom Halle', '2025-07-01', 2810.5, 'ABLESUNG', false],
  ]);
  assert.match(r.body.zeilen[1].fehler, /kleiner als der vorige \(2510,5 am 01\.06\.2025\)/, 'gegen die vorige Zeile der Datei geprüft');
  assert.match(r.body.zeilen[2].fehler, /nicht gefunden/);
  assert.equal((await sql`select count(*)::int as n from tco.zaehlerstand where zaehler_id = ${zid}`)[0].n, vorher);
  r = await call('POST', `${Z}/import`, { csv, uebernehmen: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.uebernommen, 2);
  assert.equal((await sql`select count(*)::int as n from tco.zaehlerstand where zaehler_id = ${zid}`)[0].n, vorher + 2);
  // nochmal: jetzt Dubletten
  r = await call('POST', `${Z}/import`, { csv, uebernehmen: true });
  assert.equal(r.body.uebernommen, 0);
  assert.match(r.body.zeilen[0].fehler, /bereits/);
  assert.equal((await call('POST', `${Z}/import`, { csv: '', uebernehmen: false })).status, 400);
  // Funktionsschalter
  const f = readFileSync(path.join(ROOT, 'modules/tco/server/funktionen.ts'), 'utf8');
  assert.match(f, /id: F_ZAEHLER_IMPORT, app: 'Zählerstände'[\s\S]*?routen: \['POST \/zaehler\/import'\]/);
});

test('Zähler löschen: nur ohne Ablesungen und mit Begründung', async () => {
  let r = await call('DELETE', `${Z}/${zid}`, { reason: 'weg' });
  assert.equal(r.status, 400);
  assert.equal(r.body.message, 'Zähler hat Ablesungen – bitte deaktivieren');
  const neu = await call('POST', Z, stamm({ bezeichnung: 'ZT-Test Wasser alt', medium: 'WASSER', einheit: 'm³', zaehlernummer: null }));
  assert.equal(neu.body.nummer, 'Z0002');
  r = await call('DELETE', `${Z}/${neu.body.id}`, {});
  assert.equal(r.status, 400);
  r = await call('DELETE', `${Z}/${neu.body.id}`, { reason: 'doppelt angelegt' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('GET', `${Z}/${neu.body.id}`)).status, 404);
  const [beleg] = await sql`select reason, action from core.change_header where object_type = 'ZAEHLER' and object_key = 'Z0002' and change_ind = 'D'`;
  assert.deepEqual([beleg.reason, beleg.action], ['doppelt angelegt', 'ZAEHLER_LOESCHEN']);
  // inaktive nur mit ?alle=1
  const inaktiv = await call('POST', Z, stamm({ bezeichnung: 'ZT-Test Gas stillgelegt', medium: 'GAS', aktiv: false, zaehlernummer: null }));
  assert.ok(!(await call('GET', Z)).body.zeilen.some((x: any) => x.id === inaktiv.body.id));
  assert.ok((await call('GET', `${Z}?alle=1`)).body.zeilen.some((x: any) => x.id === inaktiv.body.id));
});

async function benutzer(name: string, rechte: string[]) {
  const rolle = `ZT_TEST_${name.toUpperCase()}`;
  await sql`insert into core.roles (id, name, description) values (${rolle}, ${`ZT-Test ${name}`}, '')`;
  for (const p of rechte) await sql`insert into core.role_permissions (role_id, permission) values (${rolle}, ${p})`;
  const r = await call('POST', '/api/admin/users', { username: `zt-${name}`, displayName: `ZT ${name}`, password: 'geheim-geheim-1', roles: [rolle] });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  await sql`update core.users set must_change_password = false where username = ${`zt-${name}`}`;
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: `zt-${name}`, password: 'geheim-geheim-1' })).status, 200);
  return c;
}

test('Rechte: ansehen, erfassen, pflegen', async () => {
  assert.equal((await client()('GET', Z)).status, 401);
  const ohne = await benutzer('ohne', ['tco.checklisten:display']);
  assert.equal((await ohne('GET', Z)).status, 403);
  assert.equal((await ohne('GET', `${Z}/${zid}`)).status, 403);
  const leser = await benutzer('leser', ['tco.zaehler:display']);
  assert.equal((await leser('GET', Z)).status, 200);
  assert.equal((await leser('GET', `${Z}/ablesebogen.pdf`)).status, 200);
  assert.equal((await leser('POST', `${Z}/${zid}/staende`, { datum: '2025-08-01', stand: 3000, art: 'ABLESUNG', notiz: null })).status, 403);
  assert.equal((await leser('POST', `${Z}/import`, { csv: 'x', uebernehmen: false })).status, 403);
  const erfasser = await benutzer('erfasser', ['tco.zaehler:display', 'tco.zaehler:edit']);
  assert.equal((await erfasser('POST', Z, stamm({ bezeichnung: 'ZT-Test nicht erlaubt' }))).status, 403);
  assert.equal((await erfasser('DELETE', `${Z}/${zid}`, { reason: 'x' })).status, 403);
});

test('Arbeitsvorrat: überfällige Ablesung für Erfasser, überschrittenes Jahresziel für Leser', async () => {
  // Hochrechnung des laufenden Jahres aus dem Ø (≈ 10 je Tag) liegt über dem Ziel 1000; letzte Ablesung 01.07.2025 + 30 Tage
  const erfasser = await benutzer('av-erfasser', ['tco.zaehler:display', 'tco.zaehler:edit']);
  const leser = await benutzer('av-leser', ['tco.zaehler:display']);
  const keys = async (c: ReturnType<typeof client>) => {
    const r = await c('GET', '/api/arbeitsvorrat');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body.gruppen.find((g: any) => g.modul === 'tco')?.aufgaben ?? []).filter((a: any) => a.key.startsWith('ZAEHLER_'));
  };
  const e = await keys(erfasser);
  assert.deepEqual(e.map((a: any) => a.key).sort(), [`ZAEHLER_ABLESEN:${zid}`, `ZAEHLER_ZIEL:${zid}`]);
  const ab = e.find((a: any) => a.key === `ZAEHLER_ABLESEN:${zid}`);
  assert.equal(ab.titel, 'Zähler ablesen: ZT-Test Strom Halle – fällig seit 31.07.2025');
  assert.deepEqual([ab.bereich, ab.pfad, ab.datum], ['Instandhaltung', `/tco/zaehler/erfassen?zaehler=${zid}`, '2025-07-31']);
  const l = await keys(leser);
  assert.deepEqual(l.map((a: any) => [a.key, a.pfad]), [[`ZAEHLER_ZIEL:${zid}`, `/tco/zaehler/${zid}`]]);
  // nach einer aktuellen Ablesung nicht mehr fällig
  const r = await call('POST', `${Z}/${zid}/staende`, { datum: heute(), stand: 999_999, art: 'ABLESUNG', notiz: null, bestaetigt: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await keys(erfasser)).map((a: any) => a.key), [`ZAEHLER_ZIEL:${zid}`]);
});

test('Migration: wer die Stammdaten der Instandhaltung pflegt, bekommt die Zählerstände', async () => {
  await sql`insert into core.roles (id, name, description) values ('ZT_TEST_IH', 'ZT-Test Instandhaltung', '')`;
  await sql`insert into core.role_permissions (role_id, permission) values ('ZT_TEST_IH', 'tco.instandhaltung:admin'), ('ZT_TEST_IH', 'tco.zaehler:display')`;
  const datei = readFileSync(path.join(ROOT, 'modules/tco/server/migrations/095_zaehler.sql'), 'utf8');
  const stmt = datei.slice(datei.lastIndexOf('insert into core.role_permissions'));
  await sql.unsafe(stmt);
  const rechte = (await sql`select permission from core.role_permissions where role_id = 'ZT_TEST_IH' order by permission`).map((x) => x.permission);
  assert.deepEqual(rechte, ['tco.instandhaltung:admin', 'tco.zaehler:admin', 'tco.zaehler:display', 'tco.zaehler:edit']);
  const [n] = await sql`select last_value::int as n, prefix from core.number_ranges where id = 'ZAEHLER'`;
  assert.deepEqual([n.n, n.prefix], [3, 'Z']);
});
