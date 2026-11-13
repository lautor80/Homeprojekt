/**
 * Integrationstest FI-Perioden (#3): vergangene Monate abschließen – danach keine Buchungen, Stornos oder Wertänderungen
 * darin (auch nicht direkt in der Datenbank), Wiederöffnen mit Grund.
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

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const F = '/api/m/tco/fi';
const kasse = (datum: string, betrag: number) => ({ datum, text: 'Spende', betrag, positionen: [{ gkonto: '8100', betrag }] });

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('1000', 'Kasse', 'BK'), ('8100', 'Spenden', null)`;
});
after(async () => { await app?.close(); await sql.end(); });

test('FI-Perioden: abschließen, Sperre für Buchen/Storno/Ändern, wieder öffnen', async () => {
  // Buchungen im August, September und Oktober 2026
  let r = await call('POST', `${F}/buchen`, { konto: '1000', modus: 'manuell', umsaetze: [kasse('2026-08-10', 10), kasse('2026-09-10', 20), kasse('2026-10-10', 30)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [aug, , okt] = r.body.gebucht.map((g: { internenr: string }) => g.internenr);

  r = await call('GET', `${F}/perioden?jahr=2026`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.monate.length, 12);
  assert.equal(r.body.monate[7].buchungen, 1);
  assert.equal(r.body.abgeschlossenBis, null);

  // laufender Monat bleibt offen
  const h = new Date();
  r = await call('POST', `${F}/perioden/abschliessen`, { jahr: h.getFullYear(), monat: h.getMonth() + 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Nur vergangene Perioden/);

  // bis September abschließen: ab der ersten Buchung (August) lückenlos
  r = await call('POST', `${F}/perioden/abschliessen`, { jahr: 2026, monat: 9 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /08\/2026 bis 09\/2026 abgeschlossen \(2 Monate\)/);
  assert.equal((await call('GET', `${F}/init?jahr=2026`)).body.abgeschlossenBis, '2026-09');
  r = await call('GET', `${F}/perioden?jahr=2026`);
  assert.deepEqual(r.body.monate.map((m: { geschlossen: boolean }) => m.geschlossen).slice(6, 10), [false, true, true, false]);
  assert.equal(r.body.monate[7].geschlossen_von, 'admin');

  // keine Buchung, kein Storno in abgeschlossenen Perioden
  r = await call('POST', `${F}/buchen`, { konto: '1000', modus: 'manuell', umsaetze: [kasse('2026-09-15', 5)] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Periode 09\/2026 ist abgeschlossen/);
  r = await call('POST', `${F}/storno`, { internenr: aug, grund: 'Test' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /abgeschlossenen Periode 08\/2026/);

  // die Datenbank sperrt auch direkte Änderungen der Werte (Trigger), Verweise bleiben pflegbar
  await assert.rejects(sql`update tco.fibuchungen set betrag = 99 where internenr = ${aug}`, /abgeschlossen/);
  await assert.rejects(sql`delete from tco.fibuchungen where internenr = ${aug}`, /abgeschlossen/);
  await assert.rejects(sql`update tco.fibuchungen set datum = '2026-10-01', monat = 10 where internenr = ${aug}`, /abgeschlossen/);
  await sql`update tco.fibuchungen set projekt = 'Sommerfest' where internenr = ${aug}`;

  // offene Perioden: buchen und stornieren wie gewohnt
  r = await call('POST', `${F}/buchen`, { konto: '1000', modus: 'manuell', umsaetze: [kasse('2026-10-15', 5)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${F}/storno`, { internenr: okt, grund: 'Test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // bereits abgeschlossen
  r = await call('POST', `${F}/perioden/abschliessen`, { jahr: 2026, monat: 8 });
  assert.equal(r.status, 400);

  // wieder öffnen: Grund Pflicht, öffnet auch alle späteren
  assert.equal((await call('POST', `${F}/perioden/oeffnen`, { jahr: 2026, monat: 8 })).status, 400);
  r = await call('POST', `${F}/perioden/oeffnen`, { jahr: 2026, monat: 8, grund: 'Korrektur Kasse' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /08\/2026 und 1 spätere wieder geöffnet/);
  assert.equal((await call('GET', `${F}/init?jahr=2026`)).body.abgeschlossenBis, null);
  r = await call('POST', `${F}/storno`, { internenr: aug, grund: 'Test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Änderungsbeleg
  const [n] = await sql`select count(*)::int as n from core.change_header where object_type = 'FIPERIODE'`;
  assert.ok(n.n >= 2);
});

test('Geldkonto gebuchter Belege austauschen: markierte Belege umkontieren, ohne Änderungsbeleg, Periodenschutz bleibt', async () => {
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('1001', 'Bank', 'BA')`;
  let r = await call('POST', `${F}/buchen`, { konto: '1000', modus: 'manuell', umsaetze: [kasse('2025-03-10', 40), kasse('2025-03-20', 60), kasse('2025-06-05', 15)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [a, b, c] = r.body.gebucht.map((g: { internenr: string }) => g.internenr);
  // Auswahl: Konto 1000 mit Gegenkonto 8100 im Jahr 2025
  r = await call('GET', `${F}/geldkonto/kandidaten?konto=1000&gkonto=8100&von=2025-01-01&bis=2025-12-31`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen.map((z: any) => [z.internenr, z.betrag, z.gkonten, z.geschlossen]), [[a, 40, ['8100'], false], [b, 60, ['8100'], false], [c, 15, ['8100'], false]]);
  assert.equal(r.body.summe, 115);
  assert.equal((await call('GET', `${F}/geldkonto/kandidaten?konto=1000&gkonto=9999&von=2025-01-01&bis=2025-12-31`)).body.zeilen.length, 0);
  assert.equal((await call('GET', `${F}/geldkonto/kandidaten?konto=7777`)).status, 400);
  // Eingaben
  assert.equal((await call('POST', `${F}/geldkonto/tauschen`, { internenrn: [a], von: '1000', nach: '8100' })).status, 400, 'kein Geldkonto');
  assert.equal((await call('POST', `${F}/geldkonto/tauschen`, { internenrn: [a], von: '1000', nach: '1000' })).status, 400);
  assert.equal((await call('POST', `${F}/geldkonto/tauschen`, { internenrn: [], von: '1000', nach: '1001' })).status, 400);
  // umkontieren: Geldzeile auf 1001, Gegenzeile verweist auf 1001; nicht markierte Belege unverändert; kein Änderungsbeleg
  const belege = async () => (await sql`select count(*)::int as n from core.change_header`)[0].n;
  const vorher = await belege();
  r = await call('POST', `${F}/geldkonto/tauschen`, { internenrn: [a, b], von: '1000', nach: '1001' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.belege, 2);
  const zeilen = async (nr: string) => (await sql`select konto, gkonto, soll::float8 as soll, haben::float8 as haben from tco.fibuchungen where internenr = ${nr} order by konto`).map((x) => [x.konto, x.gkonto, x.soll, x.haben]);
  assert.deepEqual(await zeilen(a), [['1001', '8100', 40, 0], ['8100', '1001', 0, 40]]);
  assert.deepEqual(await zeilen(c), [['1000', '8100', 15, 0], ['8100', '1000', 0, 15]]);
  assert.equal(await belege(), vorher);
  // nochmals: nicht mehr auf 1000 gebucht
  assert.equal((await call('POST', `${F}/geldkonto/tauschen`, { internenrn: [a], von: '1000', nach: '1001' })).status, 409);
  // der Änderungsschutz der Belege gilt danach unverändert
  await assert.rejects(sql`update tco.fibuchungen set text = 'x' where internenr = ${c}`, /können nicht geändert werden/);
  // abgeschlossene Periode: gekennzeichnet und geschützt
  await sql`insert into tco.fiperioden (jahr, monat) values (2025, 6)`;
  r = await call('GET', `${F}/geldkonto/kandidaten?konto=1000&von=2025-06-01&bis=2025-06-30`);
  assert.deepEqual(r.body.zeilen.map((z: any) => [z.internenr, z.geschlossen]), [[c, true]]);
  r = await call('POST', `${F}/geldkonto/tauschen`, { internenrn: [c], von: '1000', nach: '1001' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.message, /Periode 06\/2025 ist abgeschlossen/);
  assert.deepEqual(await zeilen(c), [['1000', '8100', 15, 0], ['8100', '1000', 0, 15]]);
  await sql`delete from tco.fiperioden where jahr = 2025 and monat = 6`;
  // Storno: das Gegenstück wird mit getauscht
  r = await call('POST', `${F}/storno`, { internenr: c, grund: 'Test Geldkonto' });
  if (r.status === 200) {
    r = await call('POST', `${F}/geldkonto/tauschen`, { internenrn: [c], von: '1000', nach: '1001' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.belege, 2);
    assert.equal((await sql`select count(*)::int as n from tco.fibuchungen where konto = '1000' and (internenr = ${c} or storno_zu = ${c})`)[0].n, 0);
  }
});
