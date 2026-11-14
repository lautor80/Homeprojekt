/**
 * Integrationstest zentrale Anbindungen (Administration → Schnittstellen): Liste, Sichern mit Maske, Prüfen,
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
const { verbindungenCacheLeeren, paperlessFuer, paperlessAlle, paperlessDef, paperlessUebergang, uebernehmen, authHeader } = await import('../src/lib/verbindungen.js');
const PAPERLESS_DEF = paperlessDef('tco', 'TC Oberthal');

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

const ALTSPALTEN = ['paperless_url', 'paperless_token', 'n8n_mail_url', 'n8n_mail_key', 'mail_absender', 'n8n_ep3_url', 'n8n_ep3_auth', 'n8n_ep3_user',
  'n8n_stunden_url', 'n8n_stunden_auth', 'n8n_stunden_user', 'n8n_ferien_url'];
const spalten = async (tabelle: string) => (await sql`select column_name from information_schema.columns where table_schema || '.' || table_name = ${tabelle}`)
  .map((r) => r.column_name as string);

test('Migration: Altbestand wird übernommen (Verein hat Vorrang), danach entfallen Altspalten und alte Protokolltabelle', async () => {
  // frische Datenbank: die Altspalten gibt es nach allen Migrationen nicht mehr
  assert.ok(!(await spalten('tco.verein')).some((c) => ALTSPALTEN.includes(c)), 'Altspalten tco.verein entfernt');
  assert.ok(!(await spalten('transport.firma')).some((c) => c.startsWith('paperless_')), 'Altspalten transport.firma entfernt');
  assert.equal((await sql`select to_regclass('tco.mail_protokoll') as t`)[0].t, null, 'tco.mail_protokoll entfernt');

  // Altbestand nachstellen (Stand vor der Umstellung) und die Übernahme-Migrationen erneut laufen lassen
  await sql`delete from core.verbindungen`;
  await sql.unsafe(`
    alter table transport.firma add column paperless_url text not null default '', add column paperless_token text not null default '';
    alter table tco.verein add column paperless_url text, add column paperless_token text, add column n8n_mail_url text, add column n8n_mail_key text,
      add column mail_absender jsonb not null default '[]', add column n8n_ep3_url text, add column n8n_ep3_auth text, add column n8n_ep3_user text,
      add column n8n_stunden_url text, add column n8n_stunden_auth text, add column n8n_stunden_user text, add column n8n_ferien_url text;
    create table tco.mail_protokoll (id bigserial primary key, zeit timestamptz not null default now(), anwendung text, objekt text, an text, betreff text,
      absender text, von text, status text not null, fehler text, benutzer text, nachricht jsonb, erneut_am timestamptz, erneut_von text, erneut_status text);`);
  await sql`delete from public.schema_migrations where id in ('transport/004_paperless_zentral.sql', 'transport/005_altspalten_entfernen.sql',
            'tco/036_paperless_zentral.sql', 'tco/037_mail_zentral.sql', 'tco/038_webhooks_zentral.sql', 'tco/039_altspalten_entfernen.sql')`;
  await sql`update transport.firma set paperless_url = 'http://transport:8000', paperless_token = 't-transport' where id = 1`;
  await sql`update tco.verein set paperless_url = 'http://verein:8000,http://extern', paperless_token = 't-verein',
                                  n8n_mail_url = 'http://n8n:5678/webhook/tco-mailversand', n8n_mail_key = 'schluessel',
                                  mail_absender = '[{"anwendung":"*","email":"info@example.org","name":"Verein"}]'::jsonb,
                                  n8n_stunden_url = 'http://n8n:5678/webhook/TCO_N8N_STUNDEN', n8n_stunden_auth = 'Basic eDp5', n8n_stunden_user = 'x',
                                  n8n_ferien_url = 'http://n8n:5678/webhook/ferien-saarland',
                                  n8n_ep3_url = 'http://n8n:5678/webhook/ep3', n8n_ep3_auth = 'Bearer abc' where id = 1`;
  await sql`insert into tco.mail_protokoll (anwendung, objekt, an, betreff, status, fehler) values ('Test', 'ALT', 'alt@example.org', 'alt', 'fehler', 'alt')`;
  await migrate(activeModules(), () => {});
  verbindungenCacheLeeren();

  // Mailversand: Webhook, Schlüssel (Header) und Ersatzabsender in die Anbindung „mail“, Protokoll in den Kern
  const [m] = await sql`select url, auth_art, header_name, geheimnis, einstellungen from core.verbindungen where id = 'mail'`;
  assert.deepEqual([m.url, m.auth_art, m.header_name, m.geheimnis], ['http://n8n:5678/webhook/tco-mailversand', 'header', 'X-TCO-Key', 'schluessel']);
  assert.equal((m.einstellungen as { absender: { email: string }[] }).absender[0].email, 'info@example.org');
  assert.equal((await sql`select count(*)::int as n from core.mail_protokoll where objekt = 'ALT'`)[0].n, 1, 'Protokollzeile genau einmal übernommen');
  // Import-Webhooks: Basic-Header in Benutzer/Passwort zerlegt, Ferien erben die Anmeldung, anderer Header als „Authorization“
  const w = Object.fromEntries((await sql`select id, url, auth_art, auth_user, header_name, geheimnis from core.verbindungen where id like 'tco.%'`).map((r) => [r.id, r]));
  assert.deepEqual([w['tco.stunden'].auth_art, w['tco.stunden'].auth_user, w['tco.stunden'].geheimnis], ['basic', 'x', 'y']);
  assert.deepEqual([w['tco.ferien'].url, w['tco.ferien'].auth_art, w['tco.ferien'].auth_user, w['tco.ferien'].geheimnis], ['http://n8n:5678/webhook/ferien-saarland', 'basic', 'x', 'y']);
  assert.deepEqual([w['tco.ep3'].auth_art, w['tco.ep3'].header_name, w['tco.ep3'].geheimnis], ['header', 'Authorization', 'Bearer abc']);
  // Paperless: Verein hat Vorrang vor Transport
  const [v] = await sql`select url, auth_art, geheimnis from core.verbindungen where id = 'paperless'`;
  assert.deepEqual([v.url, v.auth_art, v.geheimnis], ['http://verein:8000,http://extern', 'token', 't-verein']);
  // Altspalten und alte Protokolltabelle sind wieder weg
  assert.ok(!(await spalten('tco.verein')).some((c) => ALTSPALTEN.includes(c)));
  assert.ok(!(await spalten('transport.firma')).some((c) => c.startsWith('paperless_')));
  assert.equal((await sql`select to_regclass('tco.mail_protokoll') as t`)[0].t, null);
  // Vereinsdaten lassen sich weiter sichern (Änderungsbeleg ohne entfallene Spalten)
  const vr = (await call('GET', '/api/m/tco/verein')).body;
  assert.equal((await call('PUT', '/api/m/tco/verein', { ...vr, ansprechpartner: 'Neu' })).status, 200);
  assert.equal((await call('PUT', '/api/m/transport/firma', { ...(await call('GET', '/api/m/transport/firma')).body, kontakt: 'Neu' })).status, 200);
});

test('Anbindungen: Liste, Sichern mit Maske, Prüfen, Lesen in den Modulen', async () => {
  let r = await call('GET', '/api/verbindungen');
  assert.equal(r.status, 200);
  const kern = r.body.gruppen.find((g: { modul: string }) => g.modul === 'core');
  // Paperless je Bereich (#232, S5): der bisherige gemeinsame Zugang gehört TC Oberthal, Euroflex hat einen eigenen (noch leer)
  assert.ok(!kern.verbindungen.some((v: { id: string }) => /paperless/.test(v.id)), 'der Kern hat keinen gemeinsamen Zugang mehr');
  const gruppe = (modul: string) => r.body.gruppen.find((g: { modul: string }) => g.modul === modul).verbindungen as { id: string; text: string; pruefbar: boolean; werte: { url: string; geheimnis: string }; stand: { eingerichtet: boolean; gestoert: boolean; text: string } }[];
  // App „Schnittstellen“ (#232, S1): jede Anbindung nennt den Reiter ihrer Schnittstelle – gleiche Schnittstelle, gleicher Reiter, je Bereich ein Block
  const reiter = (r.body.gruppen as { modul: string; verbindungen: { id: string; reiter: string }[] }[]).flatMap((g) => g.verbindungen.map((v) => `${v.reiter}: ${g.modul}/${v.id}`)).sort();
  assert.deepEqual(reiter, [
    'E-Mail: core/mail', 'E-Mail: tco/tco.mailabruf', 'E-Mail: transport/transport.mail', 'EP3: tco/tco.ep3', 'Nextcloud: core/nextcloud',
    'Paperless: tco/paperless', 'Paperless: transport/transport.paperless', 'Schulferien: tco/tco.ferien', 'Trainerstunden: tco/tco.stunden',
  ]);
  const pl = gruppe('tco').find((v) => v.id === 'paperless')!;
  assert.ok(pl && pl.pruefbar, 'Paperless des Vereins');
  assert.equal(pl.text, 'Paperless-ngx TC Oberthal');
  const plEuroflex = gruppe('transport').find((v) => v.id === 'transport.paperless')!;
  assert.deepEqual([plEuroflex.text, plEuroflex.pruefbar, plEuroflex.werte.url, plEuroflex.werte.geheimnis], ['Paperless-ngx Euroflex', true, '', '']);
  // Zeile „Stand“ (S1): eingerichtet und ohne offene Störung bzw. nicht eingerichtet
  assert.deepEqual(pl.stand, { eingerichtet: true, gestoert: false, text: 'keine Störung gemeldet', seit: null, anzahl: 0 });
  assert.deepEqual([plEuroflex.stand.eingerichtet, plEuroflex.stand.gestoert, plEuroflex.stand.text], [false, false, 'nicht eingerichtet']);
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
  const client = await paperlessFuer('tco');
  assert.ok(client, 'Client aus der Anbindung des Vereins');
  // Übergang: Euroflex hat noch kein eigenes Paperless und läuft weiter über den bisherigen Zugang – die Ablage steht nicht still
  assert.equal(await (await paperlessFuer('transport'))!.baseUrl(), `http://127.0.0.1:${port}`);
  assert.deepEqual([await paperlessUebergang('transport'), await paperlessUebergang('tco')], [true, false]);
  assert.equal(await client!.baseUrl(), `http://127.0.0.1:${port}`);
  r = await call('GET', '/api/m/tco/verein');
  assert.equal(r.body.paperless_url, `http://127.0.0.1:${port}`);
  assert.equal(r.body.n8n_mail_url, 'http://n8n:5678/webhook/tco-mailversand', 'Verein liest den Mail-Webhook aus der Anbindung');
  assert.equal(r.body.n8n_mail_key, '********');
  assert.equal(r.body.mail_absender[0].email, 'info@example.org');
  assert.equal(r.body.n8n_stunden_auth, '********');
  assert.equal(r.body.n8n_ep3_url, 'http://n8n:5678/webhook/ep3');
  assert.ok(kern.verbindungen.some((v: { id: string }) => v.id === 'mail'), 'Mailversand ist zentral angemeldet');
  assert.equal(r.body.paperless_token, '********', 'Token verlässt den Server auch über die Stammdaten nur maskiert');
  r = await call('GET', '/api/paperless/mapping/tco/listen');
  assert.equal(r.body.paperless, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.korrespondenten, ['A', 'B']);

  // --- Übergang: ohne eigenes Paperless nutzt Euroflex weiter den bisherigen Zugang – sichtbar in den Stammdaten und im Arbeitsvorrat
  const uebergangImVorrat = async () => ((await call('GET', '/api/arbeitsvorrat')).body.gruppen.find((g: { modul: string }) => g.modul === 'transport')?.aufgaben ?? [])
    .filter((a: { key: string }) => a.key === 'PAPERLESS_UEBERGANG') as { bereich: string; state: string; pfad: string; titel: string }[];
  r = await call('GET', '/api/m/transport/firma');
  assert.deepEqual([r.body.paperless, r.body.paperless_uebergang, r.body.paperless_token], [true, true, '********']);
  r = await call('GET', '/api/paperless/mapping/transport/listen');
  assert.deepEqual([r.body.paperless, r.body.korrespondenten], [true, ['A', 'B']]);
  assert.deepEqual(await uebergangImVorrat(), [{ ...(await uebergangImVorrat())[0], bereich: 'Administration', state: 'Critical', pfad: '/admin/schnittstellen', titel: 'Euroflex nutzt noch das Paperless von TC Oberthal' }]);
  // dieselbe Adresse wie der Verein wird abgelehnt – beim Sichern und beim Verbindungstest, auch mit anderer Schreibweise
  r = await call('PUT', '/api/verbindungen/transport.paperless', { url: `http://127.0.0.1:${port}`, geheimnis: 'anders' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.message, /ist schon bei der Anbindung „paperless“ eingetragen\. Jeder Bereich braucht sein eigenes Paperless/);
  r = await call('PUT', '/api/verbindungen/transport.paperless', { url: `http://euroflex-intern:8000,HTTPS://127.0.0.1:${port}/`, geheimnis: 'anders' });
  assert.equal(r.status, 400, 'eine von mehreren Adressen, https statt http, Schrägstrich am Ende');
  r = await call('PUT', '/api/verbindungen/transport.paperless', { url: 'http://euroflex-intern:8000', geheimnis: 'anders', einstellungen: { freigabe_url: `http://127.0.0.1:${port}` } });
  assert.equal(r.status, 400, 'auch als Adresse für Freigabelinks');
  r = await call('POST', '/api/verbindungen/transport.paperless/pruefen', { url: `http://127.0.0.1:${port}`, geheimnis: 'geheim' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.text, /zwei Bereiche zeigen nie auf dieselbe Adresse/);
  assert.equal((await sql`select count(*)::int as n from core.verbindungen where id = 'transport.paperless'`)[0].n, 0, 'nichts gesichert');
  // eigenes Paperless (zweite Attrappe): jetzt ist Euroflex eingerichtet, der Verein unverändert
  const zweite = http.createServer((req, res) => {
    res.writeHead(req.headers.authorization === 'Token euroflex' ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ id: 9, name: 'Spedition' }], next: null }));
  });
  await new Promise<void>((ok) => zweite.listen(0, '127.0.0.1', ok));
  const port2 = (zweite.address() as { port: number }).port;
  try {
    r = await call('PUT', '/api/verbindungen/transport.paperless', { url: `http://127.0.0.1:${port2}`, geheimnis: 'euroflex', einstellungen: { freigabe_url: 'https://dokumente.euroflex.example' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('POST', '/api/verbindungen/transport.paperless/pruefen', {});
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    r = await call('GET', '/api/m/transport/firma');
    assert.deepEqual([r.body.paperless, r.body.paperless_uebergang, r.body.paperless_token], [true, false, '********'], 'eigenes Paperless: der Übergang ist beendet');
    assert.deepEqual(await uebergangImVorrat(), [], 'Aufgabe erledigt');
    assert.equal(await paperlessUebergang('transport'), false);
    r = await call('GET', '/api/paperless/mapping/transport/listen');
    assert.deepEqual([r.body.paperless, r.body.korrespondenten], [true, ['Spedition']]);
    assert.deepEqual((await call('GET', '/api/paperless/mapping/tco/listen')).body.korrespondenten, ['A', 'B'], 'der Verein sieht weiter nur sein Paperless');
    assert.equal(await (await paperlessFuer('transport'))!.baseUrl(), `http://127.0.0.1:${port2}`);
    assert.equal(await (await paperlessFuer('tco'))!.baseUrl(), `http://127.0.0.1:${port}`);
    assert.equal((await paperlessAlle()).length, 2);
    // umgekehrt: der Verein kann die Adresse von Euroflex nicht übernehmen
    r = await call('PUT', '/api/verbindungen/paperless', { url: `http://127.0.0.1:${port2}` });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Anbindung „transport\.paperless“/);
  } finally { zweite.close(); }

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

test('Nextcloud: ein Zugang (#232, S2) – die Migration übernimmt den der Sicherung, sonst den der Dokumentenablage', async () => {
  const neu = async () => {
    await sql`delete from core.verbindungen where id = 'nextcloud'`;
    await sql`delete from public.schema_migrations where id like ${'%018_nextcloud_ein_zugang.sql'}`;
    await migrate(activeModules(), () => {});
    verbindungenCacheLeeren();
    const [v] = await sql`select url, auth_art, auth_user, geheimnis from core.verbindungen where id = 'nextcloud'`;
    return v ? [v.url, v.auth_art, v.auth_user, v.geheimnis] : null;
  };
  await sql`delete from core.verbindungen where id = 'tco.nextcloud'`;
  await sql`update core.backup_export set url = '', benutzer = '', passwort = '' where id = 1`;
  assert.equal(await neu(), null, 'nichts eingerichtet: kein Zugang');
  // nur die Dokumentenablage des Vereins war eingerichtet
  await sql`insert into core.verbindungen (id, url, auth_art, auth_user, geheimnis) values ('tco.nextcloud', 'https://cloud.example.org', 'basic', 'verein', 'ablage-pw')`;
  assert.deepEqual(await neu(), ['https://cloud.example.org', 'basic', 'verein', 'ablage-pw']);
  // beide eingerichtet: der Zugang der Sicherung gilt
  await sql`update core.backup_export set url = 'https://cloud.example.org', benutzer = 'vorstand', passwort = 'app-pw' where id = 1`;
  assert.deepEqual(await neu(), ['https://cloud.example.org', 'basic', 'vorstand', 'app-pw']);
  // ein vorhandener Zugang wird nicht überschrieben
  await sql`update core.verbindungen set auth_user = 'gepflegt' where id = 'nextcloud'`;
  await sql`delete from public.schema_migrations where id like ${'%018_nextcloud_ein_zugang.sql'}`;
  await migrate(activeModules(), () => {});
  assert.equal((await sql`select auth_user from core.verbindungen where id = 'nextcloud'`)[0].auth_user, 'gepflegt');
  await sql`update core.backup_export set url = '', benutzer = '', passwort = '' where id = 1`;
});
