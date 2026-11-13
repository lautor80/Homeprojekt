/**
 * Ansichtsvarianten für alle Apps mit Tabellen: je Benutzer sichern, Standard, „für alle“ nur mit Systemrecht, löschen.
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
const admin = client(), leser = client();

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await client()('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' })).status, 200);
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'LESER', name: 'Nur lesen', permissions: ['tco.konten:display'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['LESER'] })).status, 200);
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
});
after(async () => { await app?.close(); await sql.end(); });

const V = '/api/varianten/tco.konten';

test('Varianten: je Benutzer sichern, Standard wechselt, Inhalt bleibt wie gesichert', async () => {
  assert.equal((await client()('GET', V)).status, 401);
  let r = await leser('GET', V);
  assert.deepEqual([r.status, r.body.varianten, r.body.standard, r.body.global], [200, [], null, false]);
  const a1 = { suche: 'bank', nurBebucht: true, sort: { k: 'konto', ab: false }, jahre: [2024, 2025] };
  r = await leser('POST', V, { name: ' Bankkonten ', standard: true, ansicht: a1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.variante, { key: 'leser/Bankkonten', name: 'Bankkonten', global: false, standard: true, ansicht: a1 });
  assert.equal((await leser('POST', V, { name: 'Alle', standard: true, ansicht: { suche: '' } })).status, 200);
  r = await leser('GET', V);
  assert.deepEqual(r.body.varianten.map((v: { name: string; standard: boolean }) => [v.name, v.standard]), [['Alle', true], ['Bankkonten', false]], 'nur eine Standardvariante je Benutzer');
  assert.deepEqual(r.body.varianten[1].ansicht, a1);
  assert.equal(r.body.standard.name, 'Alle');
  // erneut sichern überschreibt
  assert.equal((await leser('POST', V, { name: 'Bankkonten', ansicht: { suche: 'kasse' } })).status, 200);
  assert.deepEqual((await leser('GET', V)).body.varianten[1].ansicht, { suche: 'kasse' });
  // andere Liste, anderer Benutzer: getrennt
  assert.deepEqual((await leser('GET', '/api/varianten/tco.produkte')).body.varianten, []);
  assert.deepEqual((await admin('GET', V)).body.varianten, []);
  // Eingaben
  for (const name of ['', 'a/b', 'x'.repeat(31)]) assert.equal((await leser('POST', V, { name, ansicht: {} })).status, 400, name);
  assert.equal((await leser('POST', V, { name: 'Zu groß', ansicht: { t: 'x'.repeat(21000) } })).status, 400);
  assert.equal((await leser('POST', V, { name: 'Liste', ansicht: [1, 2] })).status, 400);
  assert.equal((await leser('GET', '/api/varianten/a b')).status, 400);
});

test('Varianten für alle: nur mit Systemrecht; eigene Standardvariante geht der globalen vor', async () => {
  assert.equal((await leser('POST', V, { name: 'Für alle', global: true, ansicht: {} })).status, 403);
  let r = await admin('POST', V, { name: 'Für alle', global: true, standard: true, ansicht: { suche: 'x' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.variante.key, '*/Für alle');
  r = await leser('GET', V);
  assert.deepEqual(r.body.varianten.map((v: { key: string }) => v.key), ['leser/Alle', 'leser/Bankkonten', '*/Für alle']);
  assert.equal(r.body.standard.key, 'leser/Alle');
  assert.deepEqual([(await admin('GET', V)).body.standard.key, (await admin('GET', V)).body.global], ['*/Für alle', true]);
  // löschen: fremde und globale nicht, eigene schon
  assert.equal((await leser('DELETE', V, { key: '*/Für alle' })).status, 403);
  assert.equal((await admin('DELETE', V, { key: 'leser/Alle' })).status, 403);
  assert.equal((await leser('DELETE', V, { key: 'leser/Alle' })).status, 200);
  assert.equal((await leser('DELETE', V, { key: 'leser/Alle' })).status, 404);
  assert.equal((await leser('GET', V)).body.standard.key, '*/Für alle', 'ohne eigene gilt die globale Standardvariante');
  assert.equal((await admin('DELETE', V, { key: '*/Für alle' })).status, 200);
});
