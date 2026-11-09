/**
 * Integrationstest zentrale Anbindungen (Administration → Anbindungen): Liste, Sichern mit Maske, Prüfen,
 * Übernahme der Paperless-Werte aus den Modul-Stammdaten durch die Migration, Lesen in den Modulen.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco,transport';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { verbindungenCacheLeeren, paperlessZentral, uebernehmen, PAPERLESS_DEF, authHeader } = await import('../src/lib/verbindungen.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}

// Paperless-Attrappe: /api/ und Korrespondenten
const server = http.createServer((req, res) => {
  const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.headers.authorization !== 'Token geheim') return send(401, { detail: 'Invalid token.' });
  if ((req.url ?? '').startsWith('/api/correspondents')) return send(200, { count: 2, next: null, results: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] });
  send(200, { count: 0, next: null, results: [] });
});
let port = 0;

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; ok(); }));
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  // Altbestand nachstellen: Kern und Module bis vor die Übernahme migrieren, Paperless in beiden Modul-Stammdaten eintragen
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => {
  await app?.close();
  await sql.end();
  server.close();
});

test('Migration: Vereinswerte haben Vorrang, Modulspalten werden geleert', async () => {
  // Übernahme-Migrationen erneut laufen lassen, als läge der Altbestand noch in den Modulen
  await sql`delete from core.verbindungen`;
  await sql`delete from public.schema_migrations where id in ('transport/004_paperless_zentral.sql', 'tco/036_paperless_zentral.sql', 'tco/037_mail_zentral.sql')`;
  await sql`update transport.firma set paperless_url = 'http://transport:8000', paperless_token = 't-transport' where id = 1`;
  await sql`update tco.verein set paperless_url = 'http://verein:8000,http://extern', paperless_token = 't-verein',
                                  n8n_mail_url = 'http://n8n:5678/webhook/tco-mailversand', n8n_mail_key = 'schluessel',
                                  mail_absender = '[{"anwendung":"*","email":"info@example.org","name":"Verein"}]'::jsonb where id = 1`;
  await sql`insert into tco.mail_protokoll (anwendung, objekt, an, betreff, status, fehler) values ('Test', 'ALT', 'alt@example.org', 'alt', 'fehler', 'alt')`;
  await migrate(activeModules(), () => {});
  verbindungenCacheLeeren();
  // Mailversand: Webhook, Schlüssel (Header) und Ersatzabsender in die Anbindung „mail“, Protokoll in den Kern
  const [m] = await sql`select url, auth_art, header_name, geheimnis, einstellungen from core.verbindungen where id = 'mail'`;
  assert.deepEqual([m.url, m.auth_art, m.header_name, m.geheimnis], ['http://n8n:5678/webhook/tco-mailversand', 'header', 'X-TCO-Key', 'schluessel']);
  assert.equal((m.einstellungen as { absender: { email: string }[] }).absender[0].email, 'info@example.org');
  assert.equal((await sql`select count(*)::int as n from core.mail_protokoll where objekt = 'ALT'`)[0].n, 1);
  assert.equal((await sql`select count(*)::int as n from tco.mail_protokoll`)[0].n, 0);
  const [tvm] = await sql`select n8n_mail_url, n8n_mail_key, mail_absender from tco.verein where id = 1`;
  assert.deepEqual([tvm.n8n_mail_url, tvm.n8n_mail_key, tvm.mail_absender], [null, null, []]);
  const [v] = await sql`select url, auth_art, geheimnis from core.verbindungen where id = 'paperless'`;
  assert.deepEqual([v.url, v.auth_art, v.geheimnis], ['http://verein:8000,http://extern', 'token', 't-verein']);
  const [t] = await sql`select paperless_url, paperless_token from transport.firma where id = 1`;
  assert.deepEqual([t.paperless_url, t.paperless_token], ['', '']);
  const [tv] = await sql`select paperless_url, paperless_token from tco.verein where id = 1`;
  assert.deepEqual([tv.paperless_url, tv.paperless_token], [null, null]);
});

test('Anbindungen: Liste, Sichern mit Maske, Prüfen, Lesen in den Modulen', async () => {
  let r = await call('GET', '/api/verbindungen');
  assert.equal(r.status, 200);
  const kern = r.body.gruppen.find((g: { modul: string }) => g.modul === 'core');
  const pl = kern.verbindungen.find((v: { id: string }) => v.id === 'paperless');
  assert.ok(pl && pl.pruefbar, 'Paperless ist zentral angemeldet');
  assert.equal(pl.werte.geheimnis, '********', 'Geheimnis kommt maskiert');
  assert.equal(pl.werte.url, 'http://verein:8000,http://extern');

  // Prüfen mit Formularwerten ohne zu sichern: falscher Token → Fehler, richtiger → ok
  r = await call('POST', '/api/verbindungen/paperless/pruefen', { url: `http://127.0.0.1:${port}`, geheimnis: 'falsch' });
  assert.equal(r.body.ok, false);
  r = await call('POST', '/api/verbindungen/paperless/pruefen', { url: `http://127.0.0.1:${port}`, geheimnis: 'geheim' });
  assert.equal(r.body.ok, true, r.body.text);
  assert.match(r.body.text, /2 Korrespondenten/);
  const [unveraendert] = await sql`select geheimnis from core.verbindungen where id = 'paperless'`;
  assert.equal(unveraendert.geheimnis, 't-verein', 'Prüfen speichert nichts');

  // Sichern: Maske lässt das Geheimnis stehen, neuer Wert ersetzt es; ungültige Adresse und n8n-Platzhalter werden abgewiesen
  r = await call('PUT', '/api/verbindungen/paperless', { url: `http://127.0.0.1:${port}`, geheimnis: '********' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let [db] = await sql`select url, geheimnis from core.verbindungen where id = 'paperless'`;
  assert.deepEqual([db.url, db.geheimnis], [`http://127.0.0.1:${port}`, 't-verein']);
  r = await call('PUT', '/api/verbindungen/paperless', { geheimnis: 'geheim' });
  assert.equal(r.status, 200);
  assert.equal(r.body.geheimnis, '********');
  [db] = await sql`select url, geheimnis from core.verbindungen where id = 'paperless'`;
  assert.deepEqual([db.url, db.geheimnis], [`http://127.0.0.1:${port}`, 'geheim']);
  r = await call('PUT', '/api/verbindungen/paperless', { url: 'paperless:8000' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/verbindungen/paperless', { geheimnis: '__n8n_BLANK_VALUE_abc' });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /Platzhalter/);
  r = await call('PUT', '/api/verbindungen/gibtsnicht', { url: 'http://x' });
  assert.equal(r.status, 404);

  // Module lesen die zentrale Verbindung
  const client = await paperlessZentral();
  assert.ok(client, 'Client aus der zentralen Verbindung');
  assert.equal(await client!.baseUrl(), `http://127.0.0.1:${port}`);
  r = await call('GET', '/api/m/tco/verein');
  assert.equal(r.body.paperless_url, `http://127.0.0.1:${port}`);
  assert.equal(r.body.n8n_mail_url, 'http://n8n:5678/webhook/tco-mailversand', 'Verein liest den Mail-Webhook aus der Anbindung');
  assert.equal(r.body.n8n_mail_key, '********');
  assert.equal(r.body.mail_absender[0].email, 'info@example.org');
  assert.ok(kern.verbindungen.some((v: { id: string }) => v.id === 'mail'), 'Mailversand ist zentral angemeldet');
  assert.equal(r.body.paperless_token, '********', 'Token verlässt den Server auch über die Stammdaten nur maskiert');
  r = await call('GET', '/api/m/transport/firma');
  assert.equal(r.body.paperless, true);
  assert.equal(r.body.paperless_token, '********');
  r = await call('GET', '/api/paperless/mapping/tco/listen');
  assert.equal(r.body.paperless, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.korrespondenten, ['A', 'B']);

  // Änderungsbeleg ohne Geheimnis
  const belege = await sql`select i.field, i.new_value from core.change_item i join core.change_header h on h.id = i.header_id
                           where h.object_type = 'VERBINDUNG' and h.object_key = 'paperless'`;
  assert.ok(belege.some((b) => b.field === 'url'), 'URL im Änderungsbeleg');
  assert.ok(!belege.some((b) => String(b.new_value ?? '').includes('geheim') || String(b.new_value ?? '').includes('t-verein')), 'Geheimnis nicht im Änderungsbeleg');

  // Zusammenführen und Header direkt
  const b = uebernehmen({ ...PAPERLESS_DEF, id: 'x', auth: ['basic', 'header'] }, { id: 'x', url: '', auth_art: 'keine', auth_user: null, header_name: null, geheimnis: null, einstellungen: {} },
    { url: 'http://h', auth_art: 'basic', auth_user: 'u', geheimnis: 'p' });
  assert.deepEqual(authHeader(b), { Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` });
  assert.throws(() => uebernehmen({ ...PAPERLESS_DEF, id: 'x', auth: ['basic'] }, b, { auth_user: 'anders', geheimnis: '********' }), /Passwort neu/);
  assert.throws(() => uebernehmen({ ...PAPERLESS_DEF, id: 'x', auth: ['basic'] }, b, { auth_user: '', geheimnis: 'nur-pw' }), /Benutzer und Passwort/);
});
