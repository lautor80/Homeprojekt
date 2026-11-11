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
