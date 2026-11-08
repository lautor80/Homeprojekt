/**
 * Integrationstest Jahresabschluss: Einnahmen-Ausgaben-Rechnung je Tätigkeitsbereich,
 * Überschussrechnung mit Vorjahren, Bankbestände, Anlagenspiegel/AfA, PDF und Berechtigungen.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { buchwert, spiegelBerechnen, monateErstjahr } = await import('../../modules/tco/server/abschluss/anlagen.js');

let app: Awaited<ReturnType<typeof buildApp>>;

/** Kleiner Client, der Cookies wie ein Browser mitführt */
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, raw: res.rawPayload, ct };
  };
}
const call = client();
const A = '/api/m/tco/abschluss';

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => {
  await app?.close();
  await sql.end();
});

test('Anlagen: AfA-Rechenbeispiel wie Excel „Werte Anlagevermögen“', () => {
  // Einsandgerät Sandy 2: AW 976,18 – ND 5 Jahre – Anschaffung 01.03.2016 – 9 Monate im Erstjahr
  const sandy = { anlnr: 2, bezeichnung: 'Einsandgerät Sandy 2', anschdat: '2016-03-01', anschwert: 976.18, nutzdauer: 5, monate_ej: 9, notiz: null, erstellt_von: null, erstellt_am: null, geaendert_am: null };
  assert.equal(monateErstjahr('2016-03-01'), 10);        // Monatsregel März–Dezember (in der Excel sind 9 hinterlegt)
  assert.equal(monateErstjahr(null), 12);
  assert.equal(buchwert(sandy, 2015), 0);                 // vor der Anschaffung
  assert.equal(buchwert(sandy, 2016), 829.75);            // 976,18 − 195,236 × 9/12
  assert.equal(buchwert(sandy, 2017), 634.52);            // 976,18 − 195,236 × 1,75
  assert.equal(buchwert(sandy, 2020), 48.81);
  assert.equal(buchwert(sandy, 2021), 0);                 // Restbetrag im letzten Jahr, nie unter 0
  assert.equal(buchwert(sandy, 2030), 0);

  // Hallensanierung: AW 47.897,55 – ND 20 – 0 Monate im Erstjahr (AfA beginnt im Folgejahr)
  const halle = { ...sandy, anlnr: 1, bezeichnung: 'Hallensanierung', anschdat: '2013-10-30', anschwert: 47897.55, nutzdauer: 20, monate_ej: 0 };
  assert.equal(buchwert(halle, 2013), 47897.55);
  assert.equal(buchwert(halle, 2014), 45502.67);

  // Spiegel 2016: Halle aktiv, Sandy Zugang
  let s = spiegelBerechnen([halle, sandy], 2016);
  assert.deepEqual(s.spiegel.map((x) => [x.anlnr, x.status, x.bw_beginn, x.zugang, x.afa_jahr, x.bw_ende, x.ende_jahr]), [
    [1, 'aktiv', 43107.8, 0, 2394.88, 40712.92, 2033],
    [2, 'Zugang', 0, 976.18, 146.43, 829.75, 2021],
  ]);
  assert.deepEqual(s.summe, { anschwert: 48873.73, bw_beginn: 43107.8, zugang: 976.18, afa_jahr: 2541.31, bw_ende: 41542.67 });
  // 2021: letzte AfA für Sandy, 2022: nicht mehr ausgewiesen
  s = spiegelBerechnen([halle, sandy], 2021);
  assert.deepEqual(s.spiegel.map((x) => [x.anlnr, x.status, x.afa_jahr, x.bw_ende]), [[1, 'aktiv', 2394.88, 28738.53], [2, 'letzte AfA', 48.81, 0]]);
  s = spiegelBerechnen([halle, sandy], 2022);
  assert.deepEqual(s.spiegel.map((x) => x.anlnr), [1]);
});

test('Jahresabschluss: EAR, Überschussrechnung, Bankbestände, Anlagen, PDF', async () => {
  // Kontenstamm mit Kennzahlen; 4301 wird auf 4300 verdichtet (Verrechnungskonto)
  await sql`insert into tco.fikonten (konto, name, kennzahl, verrechnung) values
    ('1200', 'Sparkasse Giro', 'BA', null), ('1000', 'Kasse', 'BA', null), ('1300', 'Darlehen', 'BK', null),
    ('8000', 'Mitgliedsbeiträge', 'A1', null), ('8100', 'Spenden', 'A1', null), ('4000', 'Verbandsabgaben', 'A2', null),
    ('8200', 'Zinsen', 'B1', null), ('8300', 'Hallenmiete', 'C1', null), ('4300', 'Energie Halle', 'C2', null), ('4301', 'Gas Halle', 'C2', '4300'),
    ('8500', 'Clubhaus Einnahmen', 'D1', null), ('4500', 'Clubhaus Wareneinkauf', 'D2', null), ('8012', 'Sonderkonto', 'D1', null), ('9999', 'Ohne Kennzahl', null, null)`;
  await sql`insert into tco.fibankab (jahr, konto, anfangsbestand) values (2025, '1200', 1000), (2025, '1300', -5000)`;
  const b = (nr: string, konto: string, datum: string, soll: number, haben: number, gkonto: string) =>
    sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, soll, haben, gkonto)
        values (${nr}, ${konto}, 0, ${Number(datum.slice(0, 4))}, ${Number(datum.slice(5, 7))}, ${datum}, 'Test', ${soll - haben}, ${soll}, ${haben}, ${gkonto})`;
  // 2025: Beiträge 500, Verbandsabgabe 100
  await b('0000000001', '1200', '2025-02-01', 500, 0, '8000'); await b('0000000001', '8000', '2025-02-01', 0, 500, '1200');
  await b('0000000002', '1200', '2025-03-01', 0, 100, '4000'); await b('0000000002', '4000', '2025-03-01', 100, 0, '1200');
  // 2026: Beiträge 1200, Spende 50, Verbandsabgabe 150, Zinsen 10, Hallenmiete 800, Gas 300 (→ 4300) + Strom 120, Clubhaus 400 / Ware 250
  await b('0000000010', '1200', '2026-01-10', 1200, 0, '8000'); await b('0000000010', '8000', '2026-01-10', 0, 1200, '1200');
  await b('0000000011', '1200', '2026-02-10', 50, 0, '8100'); await b('0000000011', '8100', '2026-02-10', 0, 50, '1200');
  await b('0000000012', '1200', '2026-03-10', 0, 150, '4000'); await b('0000000012', '4000', '2026-03-10', 150, 0, '1200');
  await b('0000000013', '1200', '2026-04-10', 10, 0, '8200'); await b('0000000013', '8200', '2026-04-10', 0, 10, '1200');
  await b('0000000014', '1200', '2026-05-10', 800, 0, '8300'); await b('0000000014', '8300', '2026-05-10', 0, 800, '1200');
  await b('0000000015', '1200', '2026-06-10', 0, 300, '4301'); await b('0000000015', '4301', '2026-06-10', 300, 0, '1200');
  await b('0000000016', '1200', '2026-06-11', 0, 120, '4300'); await b('0000000016', '4300', '2026-06-11', 120, 0, '1200');
  await b('0000000017', '1000', '2026-07-10', 400, 0, '8500'); await b('0000000017', '8500', '2026-07-10', 0, 400, '1000');
  await b('0000000018', '1000', '2026-07-12', 0, 250, '4500'); await b('0000000018', '4500', '2026-07-12', 250, 0, '1000');
  // Konto 8012: nur die Haben-Seite zählt (Soll 30 bleibt außen vor), Konto ohne Kennzahl erscheint als Hinweis
  await b('0000000019', '8012', '2026-08-01', 30, 100, '1000'); await b('0000000020', '9999', '2026-08-02', 0, 5, '1000');

  let r = await call('GET', `${A}/init?jahr=2026`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.jahre.slice(0, 2), [2026, 2025]);
  const ear = r.body.ear;
  const bereich = (k: string) => ear.bereiche.find((x: any) => x.bereich === k);
  assert.deepEqual(bereich('A').einnahmen.map((k: any) => [k.konto, k.wert]), [['8000', 1200], ['8100', 50]]);
  assert.deepEqual([bereich('A').ein, bereich('A').aus, bereich('A').ergebnis], [1250, 150, 1100]);
  assert.deepEqual([bereich('B').ein, bereich('B').aus], [10, 0]);
  // Verrechnung: 4301 steckt in 4300
  assert.deepEqual(bereich('C').ausgaben, [{ konto: '4300', name: 'Energie Halle', wert: 420 }]);
  assert.deepEqual([bereich('C').ein, bereich('C').ergebnis], [800, 380]);
  assert.deepEqual(bereich('D').einnahmen.map((k: any) => [k.konto, k.wert]), [['8012', 100], ['8500', 400]]);
  assert.deepEqual([ear.ein, ear.aus, ear.ergebnis], [2560, 820, 1740]);
  assert.match(r.body.hinweise.join(' '), /9999/);

  // Überschussrechnung: Spalten 2026, 2025, 2024
  const u = r.body.ueberschuss;
  assert.deepEqual(u.jahre, [2026, 2025, 2024]);
  assert.deepEqual(u.ein, [2560, 500, 0]);
  assert.deepEqual(u.aus, [820, 100, 0]);
  assert.deepEqual(u.ergebnis, [1740, 400, 0]);
  assert.deepEqual(u.arten[0].konten.find((k: any) => k.konto === '8000').werte, [1200, 500, 0]);

  // Bankbestände: Anfangsbestand 2025 fortgeschrieben, Darlehen negativ, Kasse ohne Anfangsbestand
  const bank = Object.fromEntries(r.body.bank.map((x: any) => [x.konto, [x.anfang, x.ende, x.delta]]));
  assert.deepEqual(bank['1200'], [1400, 2890, 1490]);
  assert.deepEqual(bank['1000'], [0, 150, 150]);
  assert.deepEqual(bank['1300'], [-5000, -5000, 0]);

  // Anlagen: leer → Initialbestand, dann neues Objekt, ändern, löschen mit Begründung
  assert.equal(r.body.anlagen.leer, true);
  r = await call('POST', `${A}/anlagen/initialbestand`);
  assert.match(r.body.text, /^7 Anlageobjekte/);
  r = await call('POST', `${A}/anlagen/initialbestand`);
  assert.equal(r.status, 400);
  r = await call('GET', `${A}/anlagen?jahr=2026`);
  assert.deepEqual(r.body.spiegel.map((x: any) => x.anlnr), [1, 4, 5, 6, 7]);   // Sandy und Räumfix sind seit 2021 abgeschrieben
  assert.deepEqual(r.body.summe, { anschwert: 99885.93, bw_beginn: 57540.45, zugang: 0, afa_jahr: 5653.57, bw_ende: 51886.88 });
  assert.equal(r.body.entwicklung.jahre[0].jahr, 2013);
  assert.equal(r.body.entwicklung.jahre.at(-1).summe, 51886.88);

  r = await call('POST', `${A}/anlagen`, { bezeichnung: 'Rasenmäher', anschdat: '2026-05-15', anschwert: '1.200,00', nutzdauer: 8, monate_ej: 8 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.anlnr, 8);
  r = await call('POST', `${A}/anlagen`, { bezeichnung: '', anschdat: '2026-05-15', anschwert: 1, nutzdauer: 8, monate_ej: 8 });
  assert.equal(r.status, 400);
  r = await call('POST', `${A}/anlagen`, { bezeichnung: 'X', anschdat: '2026-05-15', anschwert: 1, nutzdauer: 100, monate_ej: 8 });
  assert.match(r.body.message, /Nutzungsdauer/);
  r = await call('GET', `${A}/anlagen-monate?datum=2026-05-15`);
  assert.equal(r.body.monate_ej, 8);
  r = await call('GET', `${A}/anlagen?jahr=2026`);
  const neu = r.body.spiegel.find((x: any) => x.anlnr === 8);
  assert.deepEqual([neu.status, neu.zugang, neu.afa_satz, neu.afa_jahr, neu.bw_ende], ['Zugang', 1200, 12.5, 100, 1100]);
  r = await call('POST', `${A}/anlagen`, { anlnr: 8, bezeichnung: 'Rasenmäher Honda', anschdat: '2026-05-15', anschwert: 1200, nutzdauer: 8, monate_ej: 8, notiz: 'Rechnung 4711' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${A}/anlagen/8`);
  assert.deepEqual([r.body.bezeichnung, r.body.notiz, r.body.anschwert], ['Rasenmäher Honda', 'Rechnung 4711', 1200]);
  r = await call('POST', `${A}/anlagen/loeschen`, { anlnr: 8 });
  assert.equal(r.status, 400);   // ohne Begründung
  r = await call('POST', `${A}/anlagen/loeschen`, { anlnr: 8, grund: 'Doppelt erfasst' });
  assert.match(r.body.text, /gelöscht/);
  const [doc] = await sql`select action, reason from core.change_header where object_type = 'ANLAGE' and object_key = '8' and change_ind = 'D' order by changed_at desc limit 1`;
  assert.deepEqual([doc?.action, doc?.reason], ['LOESCHEN', 'Doppelt erfasst']);

  // PDF: alle Teile, nur Anlagen; ohne Teil → EAR
  r = await call('GET', `${A}/pdf?jahr=2026&ear=1&steuer=1&anlagen=1`);
  assert.equal(r.status, 200);
  assert.equal(r.ct, 'application/pdf');
  assert.ok(Buffer.from(r.raw).subarray(0, 5).toString() === '%PDF-');
  assert.match(String(r.body), /Count 3|\/Type \/Pages/);
  r = await call('GET', `${A}/pdf?jahr=2026&anlagen=1`);
  assert.equal(r.ct, 'application/pdf');
  r = await call('GET', `${A}/pdf?jahr=2026`);
  assert.equal(r.ct, 'application/pdf');
  // Paperless nicht eingerichtet
  r = await call('POST', `${A}/paperless`, { jahr: 2026, ear: true });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Paperless/);
});

test('Jahresabschluss: Berechtigungen', async () => {
  assert.equal((await call('POST', '/api/admin/roles', { id: 'ABSCHLUSS_LESER', name: 'Abschluss lesen', permissions: ['tco.abschluss:display'] })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['ABSCHLUSS_LESER'] })).status, 200);
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  assert.equal((await leser('GET', `${A}/init?jahr=2026`)).status, 200);
  assert.equal((await leser('GET', `${A}/pdf?jahr=2026&ear=1`)).status, 200);
  assert.equal((await leser('POST', `${A}/anlagen`, { bezeichnung: 'X', anschdat: '2026-01-01', anschwert: 1, nutzdauer: 5, monate_ej: 12 })).status, 403);
  assert.equal((await leser('POST', `${A}/anlagen/initialbestand`)).status, 403);
  assert.equal((await leser('POST', `${A}/paperless`, { jahr: 2026, ear: true })).status, 403);
});
