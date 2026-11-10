/**
 * Integrationstest Stammdaten-Anbindungen: Basic Auth aus Benutzer/Passwort, Masken, Verbindungstests je Endpunkt.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}

const BASIC = `Basic ${Buffer.from('test.user@example.org:geheim').toString('base64')}`;
const server = http.createServer((req, res) => {
  const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
  const u = req.url ?? '';
  if (u.startsWith('/webhook/stunden')) {
    if (req.headers.authorization !== BASIC) return send(403, 'Authorization data is wrong!');
    res.writeHead(200, { 'content-type': 'text/csv' });
    return res.end('User ID,User display name,Timestamp,TrainerIn,Datum,Stunden\n1,,x,Jan,2026-10-01,2\n2,,x,Jan,2026-10-02,1\n');
  }
  if (u.startsWith('/webhook/ferien')) return req.headers.authorization === BASIC ? send(200, { ferientage: [{ datum: '2026-10-12' }], feiertage: [] }) : send(403, {});
  if (u.startsWith('/webhook/mail')) {
    if (req.method === 'GET') return send(404, { code: 404, message: 'This webhook is not registered for GET requests. Did you mean to make a POST request?' });
    // Header-Auth wie n8n: falscher Schlüssel → 403; Prüfaufruf ohne Empfänger → 400 vom Workflow
    if (req.headers['x-tco-key'] !== undefined && req.headers['x-tco-key'] !== 'richtig') return send(403, 'Authorization data is wrong!');
    return send(400, { status: 'fehler', fehler: 'Kein Empfänger angegeben' });
  }
  send(404, { code: 404, message: 'The requested webhook "x" is not registered.' });
});

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => {
  await app?.close();
  await sql.end();
  server.close();
});

test('Anbindungen: Benutzer/Passwort, Masken, Verbindungstests', async () => {
  const port = (server.address() as { port: number }).port;
  const B = `http://127.0.0.1:${port}/webhook`;
  // Modulverbindungen sind angemeldet
  let r = await call('GET', '/api/verbindungen');
  const tco = r.body.gruppen.find((g: { modul: string }) => g.modul === 'tco');
  assert.deepEqual(tco.verbindungen.map((v: { id: string }) => v.id).sort(), ['tco.ep3', 'tco.ferien', 'tco.mailabruf', 'tco.nextcloud', 'tco.stunden']);

  // ungesichert prüfen: falsches Passwort → abgelehnt, richtiges → Daten
  const S = { url: `${B}/stunden`, auth_art: 'basic', auth_user: 'test.user@example.org' };
  r = await call('POST', '/api/verbindungen/tco.stunden/pruefen', { ...S, geheimnis: 'falsch' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.text, /Anmeldung abgelehnt/);
  r = await call('POST', '/api/verbindungen/tco.stunden/pruefen', { ...S, geheimnis: 'geheim' });
  assert.equal(r.body.ok, true, r.body.text);
  assert.match(r.body.text, /2 Rückmeldung/);

  // sichern: Passwort maskiert zurück, Benutzer sichtbar; der Verein liest den Authorization-Header
  r = await call('PUT', '/api/verbindungen/tco.stunden', { ...S, geheimnis: 'geheim' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.geheimnis, r.body.auth_user], ['********', 'test.user@example.org']);
  const [db] = await sql`select auth_user, geheimnis from core.verbindungen where id = 'tco.stunden'`;
  assert.deepEqual([db.auth_user, db.geheimnis], ['test.user@example.org', 'geheim']);
  r = await call('GET', '/api/m/tco/verein');
  assert.equal(r.body.n8n_stunden_auth, '********');
  assert.equal(r.body.n8n_stunden_user, 'test.user@example.org');
  assert.equal(r.body.n8n_stunden_url, `${B}/stunden`);

  // erneut sichern mit Maske → Passwort bleibt; Benutzer ändern ohne Passwort → Fehler
  r = await call('PUT', '/api/verbindungen/tco.stunden', { ...S, geheimnis: '********' });
  assert.equal(r.status, 200);
  const [db2] = await sql`select geheimnis from core.verbindungen where id = 'tco.stunden'`;
  assert.equal(db2.geheimnis, 'geheim');
  r = await call('PUT', '/api/verbindungen/tco.stunden', { ...S, auth_user: 'anderer', geheimnis: '********' });
  assert.equal(r.status, 400);

  // Ferien mit eigener Anmeldung (gespeichert), Mailversand zentral, Paperless fehlt, EP3 nicht erreichbar
  r = await call('PUT', '/api/verbindungen/tco.ferien', { url: `${B}/ferien`, auth_art: 'basic', auth_user: 'test.user@example.org', geheimnis: 'geheim' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', '/api/verbindungen/tco.ferien/pruefen', {});
  assert.equal(r.body.ok, true, r.body.text);
  assert.match(r.body.text, /1 Ferientage/);
  // Mailversand (zentral): anklopfen, Schlüssel prüfen, Platzhalter abweisen
  const M = { url: `${B}/mail`, auth_art: 'header', header_name: 'X-TCO-Key' };
  r = await call('POST', '/api/verbindungen/mail/pruefen', { ...M, auth_art: 'keine' });
  assert.equal(r.body.ok, true, r.body.text);
  assert.match(r.body.text, /Workflow aktiv/);
  r = await call('POST', '/api/verbindungen/mail/pruefen', { ...M, geheimnis: 'falsch' });
  assert.equal(r.body.ok, false, r.body.text);
  assert.match(r.body.text, /Schlüssel abgelehnt.*X-TCO-Key/);
  r = await call('POST', '/api/verbindungen/mail/pruefen', { ...M, geheimnis: '__n8n_BLANK_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(JSON.stringify(r.body), /Platzhalter/);
  r = await call('PUT', '/api/verbindungen/mail', { ...M, geheimnis: '__n8n_BLANK_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6' });
  assert.equal(r.status, 400, 'Platzhalter wird nicht gespeichert');
  r = await call('POST', '/api/verbindungen/mail/pruefen', { ...M, geheimnis: 'richtig' });
  assert.equal(r.body.ok, true, r.body.text);
  assert.match(r.body.text, /Schlüssel akzeptiert/);
  r = await call('POST', '/api/verbindungen/mail/pruefen', { ...M, url: `${B}/gibtsnicht` });
  assert.match(r.body.text, /Webhook nicht gefunden/);
  r = await call('POST', '/api/verbindungen/paperless/pruefen', {});
  assert.equal(r.body.ok, false);
  assert.match(r.body.text, /fehlen/);
  r = await call('POST', '/api/verbindungen/tco.ep3/pruefen', { url: 'http://127.0.0.1:1/webhook/ep3' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.text, /abgelehnt|erreichbar/);
});
