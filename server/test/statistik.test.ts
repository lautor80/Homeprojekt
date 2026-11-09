/**
 * Nutzungsstatistik: Anmeldungen je Benutzer und Monat, Aufrufe je App (höchstens einmal je Minute),
 * Berechtigung core.statistik:display.
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
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: String(res.headers['content-type']).includes('json') ? JSON.parse(res.body) : res.body };
  };
}

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await client()('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => { await app?.close(); await sql.end(); });

test('Anmeldungen und App-Aufrufe werden gezählt', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' })).status, 200);
  const zweit = client();
  assert.equal((await zweit('POST', '/api/auth/login', { username: 'ADMIN', password: 'geheim-geheim' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'admin', password: 'falsch' })).status, 401);

  for (const pfad of ['/tco/halle', '/tco/halle', '/tco/kalender']) assert.equal((await admin('POST', '/api/nutzung', { pfad })).status, 200);
  assert.equal((await admin('POST', '/api/nutzung', { pfad: '/' })).status, 200);
  assert.equal((await admin('POST', '/api/nutzung', { pfad: 'javascript:alert(1)' })).status, 400);
  assert.equal((await client()('POST', '/api/nutzung', { pfad: '/tco/halle' })).status, 401);

  const r = await admin('GET', '/api/statistik?monate=3');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.monate.length, 3);
  const monat = r.body.monate[2];
  assert.deepEqual(r.body.anmeldungen.map((a: any) => [a.username, a.gesamt, a.monate[monat]]), [['admin', 2, 2]]);
  assert.deepEqual(r.body.apps.map((a: any) => [a.pfad, a.gesamt, a.benutzer]), [['/tco/halle', 1, 1], ['/tco/kalender', 1, 1]]);
});

test('Statistik nur mit Berechtigung', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'LESER', name: 'Leser', permissions: ['core.users:display'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Leser', password: 'start-passwort', roles: ['LESER'] })).status, 200);
  const leser = client();
  await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' });
  await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' });
  assert.equal((await leser('GET', '/api/statistik')).status, 403);
  const r = await admin('GET', '/api/admin/permissions');
  assert.ok(JSON.stringify(r.body).includes('core.statistik:display'));
});
