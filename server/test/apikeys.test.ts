/**
 * Integrationstest API-Schlüssel (je Modul) gegen eine LEERE Test-Datenbank.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'beispiel,transport';

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
/** Aufruf wie ein Fremdsystem: nur Bearer, kein Cookie, kein CSRF-Header */
async function ext(key: string, method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const T = '/api/m/transport';

before(async () => {
  await sql.unsafe(`drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => {
  await app.close();
  await sql.end();
});

test('API-Schlüssel: Anlage, Modulbindung, Rechte, Sperre, Änderungsbelege', async () => {
  // Fremde Berechtigungen werden abgelehnt
  let r = await call('POST', '/api/admin/api-keys', { module: 'transport', name: 'n8n', permissions: ['core.users:edit'] });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/admin/api-keys', {
    module: 'transport', name: 'n8n', permissions: ['transport.kontakte:edit', 'transport.auftraege:edit', 'transport.auftraege:display'],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const key: string = r.body.key;
  const id: string = r.body.id;
  assert.match(key, /^pk_transport_/);

  // Liste zeigt nie den Schlüssel
  r = await call('GET', '/api/admin/api-keys');
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].status, 'Aktiv');
  assert.ok(!JSON.stringify(r.body).includes(key));

  // Verbindungstest
  r = await ext(key, 'GET', '/api/key');
  assert.equal(r.status, 200);
  assert.equal(r.body.module, 'transport');

  // Kontakt und Auftrag anlegen, ohne Cookie und CSRF-Header
  r = await ext(key, 'POST', `${T}/adressen`, { kundenname: 'Brauerei Becker', land: 'de', plz: '66386', ort: 'St. Ingbert' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const adrnr = r.body.adrnr;
  assert.ok(adrnr);
  r = await ext(key, 'POST', `${T}/auftraege`, {
    typ: 'F', kunde: adrnr, anlagedatum: '2026-11-07', frachtpreis_ek: 450, frachtpreis_vk: 600, steuerrelevant: true, dok_fehlen: false,
    stops: [{ firma: 'Brauerei Becker', land: 'DE', plzort: '66386 St. Ingbert', firma_e: 'Kunde', land_e: 'DE', plzort_e: '66606 St. Wendel' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.auftragsnr, '2026_0001');

  // Änderungsbeleg trägt den Schlüsselnamen
  const [hdr] = await sql`select username, user_id from core.change_header where object_type = 'AUFTRAG' order by id limit 1`;
  assert.equal(hdr.username, 'api:n8n');
  assert.equal(hdr.user_id, null);

  // Nicht vergebene Berechtigung
  r = await ext(key, 'POST', `${T}/rechnungen`, { auftraege: ['2026_0001'], sammel: false });
  assert.equal(r.status, 403);
  // Anderes Modul und Basis-Schnittstellen sind gesperrt
  assert.equal((await ext(key, 'GET', '/api/m/beispiel/kontakte')).status, 403);
  assert.equal((await ext(key, 'GET', '/api/admin/users')).status, 403);
  assert.equal((await ext(key, 'GET', '/api/auth/me')).status, 403);
  // Falscher Schlüssel
  assert.equal((await ext(key.slice(0, -2) + 'xx', 'GET', '/api/key')).status, 401);

  // Rechte ändern
  r = await call('PUT', `/api/admin/api-keys/${id}`, { name: 'n8n', permissions: ['transport.auftraege:display'] });
  assert.equal(r.status, 200);
  assert.equal((await ext(key, 'POST', `${T}/adressen`, { kundenname: 'X' })).status, 403);
  assert.equal((await ext(key, 'GET', `${T}/auftraege?jahr=2026`)).status, 200);

  // Sperren braucht Begründung, dann 401
  assert.equal((await call('POST', `/api/admin/api-keys/${id}/active`, { active: false, reason: '' })).status, 400);
  assert.equal((await call('POST', `/api/admin/api-keys/${id}/active`, { active: false, reason: 'Test' })).status, 200);
  assert.equal((await ext(key, 'GET', '/api/key')).status, 401);
  await call('POST', `/api/admin/api-keys/${id}/active`, { active: true, reason: 'wieder frei' });

  // Neuer Schlüssel: alter ungültig, neuer gültig
  r = await call('POST', `/api/admin/api-keys/${id}/rotate`);
  assert.equal((await ext(key, 'GET', '/api/key')).status, 401);
  assert.equal((await ext(r.body.key, 'GET', '/api/key')).status, 200);

  // Ablauf
  await call('PUT', `/api/admin/api-keys/${id}`, { name: 'n8n', permissions: [], expires_on: '2020-01-01' });
  assert.equal((await ext(r.body.key, 'GET', '/api/key')).status, 401);

  // Historie des Schlüssels (Hash nie im Klartext)
  const docs = await sql`select h.action, h.reason, i.field, i.new_value from core.change_header h
                           left join core.change_item i on i.header_id = h.id where h.object_type = 'API_KEY'`;
  assert.ok(docs.some((d) => d.action === 'SPERREN' && d.reason === 'Test'));
  assert.ok(docs.filter((d) => d.field === 'key_hash').every((d) => d.new_value === '***'));
});
