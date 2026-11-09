/**
 * Integrationstest gegen eine echte, LEERE Test-Datenbank.
 *   TEST_DATABASE_URL=postgres://portal:portal@localhost:5432/portal_test npm test
 * Der Name der Datenbank muss "test" enthalten – sie wird zu Beginn geleert.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) {
  throw new Error('TEST_DATABASE_URL fehlt oder Datenbankname enthält nicht "test".');
}
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'beispiel';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

/** Kleiner Client, der Cookies wie ein Browser mitführt. */
function client() {
  let cookie = '';
  return async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: payload as object,
      headers: { cookie, 'x-portal-request': '1' },
    });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}

before(async () => {
  await sql.unsafe(`drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
});

after(async () => {
  await app.close();
  await sql.end();
});

test('Einrichtung, Anmeldung, Rechte und Änderungsbelege', async () => {
  const admin = client();

  assert.deepEqual((await admin('GET', '/api/setup/status')).body, { needsSetup: true });
  assert.equal((await admin('POST', '/api/setup', {
    orgName: 'Testverein', username: 'admin', displayName: 'Admin', password: 'kurz',
  })).status, 400, 'zu kurzes Passwort');
  assert.equal((await admin('POST', '/api/setup', {
    orgName: 'Testverein', username: 'admin', displayName: 'Admin', password: 'geheim-geheim',
  })).status, 200);
  assert.equal((await client()('POST', '/api/setup', {
    orgName: 'X', username: 'boese', displayName: 'X', password: 'geheim-geheim',
  })).status, 409, 'Setup nur einmal');

  const me = await admin('GET', '/api/auth/me');
  assert.equal(me.body.user.username, 'admin');
  assert.ok(me.body.permissions.includes('*'));
  assert.deepEqual(me.body.modules, ['beispiel']);
  assert.equal(me.body.settings['org.name'], 'Testverein');

  // CSRF-Schutz: schreibender Aufruf ohne Header wird abgelehnt
  const noHeader = await app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(noHeader.statusCode, 403);

  // Rolle nur mit Anzeige-Recht
  assert.equal((await admin('POST', '/api/admin/roles', {
    id: 'LESER', name: 'Nur lesen', permissions: ['beispiel.kontakte:display'],
  })).status, 200);
  const created = await admin('POST', '/api/admin/users', {
    username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['LESER'],
  });
  assert.equal(created.status, 200);

  // Kontakt anlegen + ändern (erzeugt Änderungsbelege)
  const k = await admin('POST', '/api/m/beispiel/kontakte', { name: 'Max Muster', email: 'max@example.org' });
  assert.equal(k.status, 200);
  assert.equal(k.body.nummer, 'K000001');
  assert.equal((await admin('PUT', `/api/m/beispiel/kontakte/${k.body.id}`, {
    name: 'Max Mustermann', email: 'max@example.org', aktiv: true,
  })).status, 200);

  // Leser: muss zuerst Passwort ändern
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'LESER', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('GET', '/api/m/beispiel/kontakte')).body.code, 'MUST_CHANGE_PASSWORD');
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);

  // darf lesen, aber nicht ändern und nicht in die Benutzerverwaltung
  const list = await leser('GET', '/api/m/beispiel/kontakte');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal((await leser('POST', '/api/m/beispiel/kontakte', { name: 'X' })).status, 403);
  assert.equal((await leser('GET', '/api/admin/users')).status, 403);
  assert.equal((await leser('GET', '/api/audit')).status, 403);

  // Rolle zeitraumbezogen deaktiviert: gewährt nichts mehr, auch nicht in der offenen Sitzung
  const heute = new Date().toLocaleDateString('sv-SE');
  const morgen = new Date(Date.now() + 86_400_000).toLocaleDateString('sv-SE');
  const rolle = { name: 'Nur lesen', permissions: ['beispiel.kontakte:display'] };
  assert.equal((await admin('PUT', '/api/admin/roles/LESER', { ...rolle, inaktivVon: morgen, inaktivBis: heute })).status, 400, 'bis vor von');
  assert.equal((await admin('PUT', '/api/admin/roles/LESER', { ...rolle, inaktivBis: morgen })).status, 400, 'bis ohne von');
  assert.equal((await admin('PUT', '/api/admin/roles/ADMIN', { name: 'Administrator', inaktivVon: heute })).status, 400, 'ADMIN nie deaktivierbar');
  assert.equal((await admin('PUT', '/api/admin/roles/LESER', { ...rolle, inaktivVon: morgen, inaktivGrund: 'Pause' })).status, 200);
  assert.equal((await leser('GET', '/api/m/beispiel/kontakte')).status, 200, 'geplante Deaktivierung wirkt noch nicht');
  assert.equal((await admin('PUT', '/api/admin/roles/LESER', { ...rolle, inaktivVon: heute, inaktivBis: morgen, inaktivGrund: 'Pause' })).status, 200);
  const leserRolle = (await admin('GET', '/api/admin/roles')).body.find((r: { id: string }) => r.id === 'LESER');
  assert.equal(leserRolle.inaktiv, true);
  assert.equal(leserRolle.inaktivBis, morgen);
  assert.equal((await leser('GET', '/api/m/beispiel/kontakte')).status, 403);
  assert.deepEqual((await leser('GET', '/api/auth/me')).body.permissions, []);
  // ohne Zeitraumfelder bleibt die Deaktivierung bestehen; mit leeren Feldern wird sie aufgehoben
  assert.equal((await admin('PUT', '/api/admin/roles/LESER', rolle)).status, 200);
  assert.equal((await leser('GET', '/api/m/beispiel/kontakte')).status, 403);
  assert.equal((await admin('PUT', '/api/admin/roles/LESER', { ...rolle, inaktivVon: null, inaktivBis: null })).status, 200);
  assert.equal((await leser('GET', '/api/m/beispiel/kontakte')).status, 200);

  // Objekthistorie mit Anzeige-Recht des Objekts sichtbar
  const hist = await leser('GET', '/api/audit/object/KONTAKT/K000001');
  assert.equal(hist.status, 200);
  assert.equal(hist.body.length, 2);
  const upd = hist.body[0];
  assert.equal(upd.changeInd, 'U');
  assert.equal(upd.username, 'admin');
  assert.deepEqual(upd.items, [{ field: 'name', oldValue: 'Max Muster', newValue: 'Max Mustermann' }]);
  assert.equal(hist.body[1].changeInd, 'I');

  // Löschen nur mit Begründung; Beleg enthält Aktion und Begründung
  assert.equal((await admin('DELETE', `/api/m/beispiel/kontakte/${k.body.id}`, {})).status, 400);
  assert.equal((await admin('DELETE', `/api/m/beispiel/kontakte/${k.body.id}`, { reason: 'Dublette' })).status, 200);
  const del = (await admin('GET', '/api/audit/object/KONTAKT/K000001')).body[0];
  assert.equal(del.changeInd, 'D');
  assert.equal(del.reason, 'Dublette');
  assert.equal(del.action, 'LOESCHEN');

  // Passwort-Hash wird im Änderungsbeleg maskiert
  const pw = (await admin('GET', '/api/audit?objectType=USER&objectKey=leser')).body
    .find((h: { action: string }) => h.action === 'PASSWORT_AENDERN');
  assert.ok(pw);
  assert.ok(pw.items.every((i: { field: string; oldValue: string }) => i.field !== 'password_hash' || i.oldValue === '***'));

  // Änderungsbelege sind unveränderlich
  await assert.rejects(sql`update core.change_header set username = 'x'`);
  await assert.rejects(sql`delete from core.change_item`);

  // letzter Administrator kann sich nicht selbst deaktivieren
  const adminId = me.body.user.id;
  const r = await admin('PUT', `/api/admin/users/${adminId}`, { displayName: 'Admin', active: false, roles: ['ADMIN'] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Administrator/);

  // Systemrolle kann nicht gelöscht werden
  assert.equal((await admin('DELETE', '/api/admin/roles/ADMIN')).status, 400);

  // Abmelden
  assert.equal((await admin('POST', '/api/auth/logout')).status, 200);
  assert.equal((await admin('GET', '/api/auth/me')).status, 401);
});
