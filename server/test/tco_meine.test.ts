/**
 * Mitglieder als Benutzer (Administration → Benutzer), Rolle MITGLIED, „Meine Mitgliedschaft“:
 * eigene Daten lesen/ändern, Bankverbindung, Kündigung – und nichts darüber hinaus.
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
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
  };
}
const admin = client();
const M = '/api/m/tco/mitglieder';
const jahr = new Date().getFullYear();

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, strasse, plz, ort, eintritt, zahlungsart, iban1, mitglnrn) values
    ('0000000501', 'Paula', 'Portal', 'paula@example.org', 'Weg 1', '66649', 'Oberthal', '2020-01-01', 'L', 'DE02120300000000202051', '501'),
    ('0000000502', 'Kim', 'Portal', 'paula@example.org', 'Weg 1', '66649', 'Oberthal', '2021-01-01', 'L', null, '502'),
    ('0000000503', 'Alt', 'Ausgetreten', 'alt@example.org', null, null, null, '2010-01-01', 'U', null, '503'),
    ('0000000504', 'Ohne', 'Mail', null, null, null, null, '2019-05-01', 'B', null, '504')`;
  await sql`update tco.mitglieder set austritt = '2022-12-31' where adrnr = '0000000503'`;
  await sql`update tco.mitglieder set adrnrkih = '0000000501' where adrnr = '0000000502'`; // Kim zahlt über Paula
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, sollstellung, vertragbegin, betrag) values
    ('0000000501', '1', '10', 'Erwachsene', 'jährlich', '2020-01-01', 120), ('0000000501', '2', '50', 'Schließfach', 'jährlich', '2023-01-01', 20),
    ('0000000502', '1', '90', 'Jugend', 'jährlich', '2021-01-01', 60)`;
  // EP3-Kunde mit Portalbenutzer (Hallennutzer), gleicher Name wie Mitglied 504
  await sql`insert into tco.kunden (zuid, zalias, status, vorname, nachname) values ('44', 'ohne.mail', 'enabled', 'Ohne', 'Mail')`;
  assert.equal((await admin('POST', '/api/admin/users', { username: 'ohne.mail', displayName: 'Ohne Mail', password: 'start-passwort', roles: ['HALLENNUTZER'] })).status, 200);
  const [u] = await sql`select id from core.users where username = 'ohne.mail'`;
  await sql`update tco.kunden set benutzer_id = ${u.id} where zuid = '44'`;
});
after(async () => { await app?.close(); await sql.end(); });

let start = '';
test('Mitglieder als Benutzer anlegen: E-Mail als Anmeldename, Familienadresse, Hochstufung, Rolle MITGLIED fest', async () => {
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'MITGLIED' order by 1`).map((x) => x.permission), ['tco.meinedaten:edit', 'tco.platzbuchung:edit']);
  let r = await admin('POST', `${M}/benutzer-anlegen`, { mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hochgestuft, 1, 'Hallennutzer ohne.mail wird Mitglied 504');
  const namen = r.body.angelegt.map((a: { username: string }) => a.username).sort();
  assert.deepEqual(namen, ['kim.portal', 'paula.portal'], 'gemeinsame E-Mail → vorname.nachname; Ausgetretene nicht');
  const paula = r.body.angelegt.find((a: { username: string }) => a.username === 'paula.portal');
  assert.equal(paula.name, 'Portal, Paula');
  assert.ok(paula.startkennwort);
  start = paula.startkennwort;
  // Rollen
  for (const u of ['paula.portal', 'kim.portal', 'ohne.mail']) {
    assert.deepEqual((await sql`select ur.role_id from core.user_roles ur join core.users x on x.id = ur.user_id where x.username = ${u}`).map((x) => x.role_id), ['MITGLIED'], u);
  }
  assert.equal((await sql`select a.adrnr from tco.mitgliedera a join core.users u on u.id = a.benutzer_id where u.username = 'ohne.mail'`)[0].adrnr, '0000000504');
  // erneut: nichts doppelt
  r = await admin('POST', `${M}/benutzer-anlegen`, { mail: false });
  assert.equal(r.body.angelegt.length, 0);
  // Systemrolle nicht erweiterbar
  await admin('PUT', '/api/admin/roles/MITGLIED', { name: 'Mitglied', permissions: ['tco.meinedaten:edit', 'tco.platzbuchung:edit', 'tco.mitglieder:display'] });
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'MITGLIED' order by 1`).map((x) => x.permission), ['tco.meinedaten:edit', 'tco.platzbuchung:edit']);
  assert.equal((await admin('DELETE', '/api/admin/roles/MITGLIED')).status, 400);
});

const paula = client();
test('Meine Mitgliedschaft: Anmeldung mit Startkennwort, nur eigene Daten, Kontakt und Bank ändern', async () => {
  let r = await paula('POST', '/api/auth/login', { username: 'paula.portal', password: start });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await paula('GET', `${M}/meine`)).status, 403, 'erst Kennwort ändern');
  assert.equal((await paula('POST', '/api/auth/password', { current: start, next: 'mein-neues-kennwort' })).status, 200);
  r = await paula('GET', '/api/auth/me');
  assert.deepEqual([...r.body.permissions].sort(), ['tco.meinedaten:edit', 'tco.platzbuchung:edit']);

  r = await paula('GET', `${M}/meine`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mitglied.adrnr, '0000000501');
  assert.ok(!r.body.bank.iban.includes('2030000000'), 'IBAN maskiert');
  assert.equal(r.body.vertraege.length, 3, 'eigene 2 + Kim über Paula');
  assert.equal(r.body.kuendigung.mitgliedschaft, `${jahr}-12-31`);
  // keine fremden Daten
  assert.equal((await paula('GET', `${M}/liste?status=AKTIV`)).status, 403);
  assert.equal((await paula('GET', `${M}/m/0000000504`)).status, 403);
  assert.equal((await paula('GET', '/api/admin/users')).status, 403);

  r = await paula('PUT', `${M}/meine/kontakt`, { strasse: 'Neue Str. 5', plz: '66649', ort: 'Oberthal', telefon: '', mobil: '0170 1234567', email: 'paula.neu@example.org', bildrechte: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [m] = await sql`select strasse, telefon6, email, checkbox2, vorname from tco.mitglieder where adrnr = '0000000501'`;
  assert.equal(m.strasse, 'Neue Str. 5');
  assert.equal(m.email, 'paula.neu@example.org');
  assert.equal(m.checkbox2, 'J');
  assert.equal(m.vorname, 'Paula', 'Name unverändert');
  assert.equal((await sql`select email from core.users where username = 'paula.portal'`)[0].email, 'paula.neu@example.org');
  // Anmeldung mit neuer E-Mail
  assert.equal((await client()('POST', '/api/auth/login', { username: 'paula.neu@example.org', password: 'mein-neues-kennwort' })).status, 200);
  assert.equal((await paula('PUT', `${M}/meine/kontakt`, { strasse: '', plz: '', ort: '', telefon: '', mobil: '', email: 'x', bildrechte: false })).status, 400);

  r = await paula('PUT', `${M}/meine/bank`, { iban: 'DE00 1234', bic: '', bank: '' });
  assert.equal(r.status, 400);
  r = await paula('PUT', `${M}/meine/bank`, { iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', bank: 'Commerzbank' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select iban1 from tco.mitglieder where adrnr = '0000000501'`)[0].iban1, 'DE89370400440532013000');
  assert.ok((await sql`select count(*)::int as n from tco.mgnotiz where adrnr = '0000000501' and notiz like 'Bankverbindung%'`)[0].n >= 1);
  // Kim zahlt über Paula: keine eigene Bankverbindung änderbar
  const kim = client();
  await sql`update core.users set password_hash = (select password_hash from core.users where username = 'paula.portal'), must_change_password = false where username = 'kim.portal'`;
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim.portal', password: 'mein-neues-kennwort' })).status, 200);
  r = await kim('PUT', `${M}/meine/bank`, { iban: 'DE89 3704 0044 0532 0130 00', bic: '', bank: '' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /andere Person/);
});

test('Kündigung: Jugendvertrag zum nächsten 30.09., Mitgliedschaft zum 31.12., Bestätigung als PDF', async () => {
  const h = new Date().toLocaleDateString('sv-SE');
  const jugendEnde = h <= `${jahr}-09-30` ? `${jahr}-09-30` : `${jahr + 1}-09-30`;
  let r = await paula('GET', `${M}/meine`);
  assert.equal(r.body.kuendigung.mitgliedschaft, `${jahr}-12-31`);
  assert.equal(r.body.kuendigung.jugend, jugendEnde);
  assert.equal(r.body.vertraege.find((v: { adrnr: string }) => v.adrnr === '0000000502').endeBei, jugendEnde, 'Jugendtraining von Kim');

  // Vertrag der über mich zahlenden Person (Jugend) → nächster 30.09.
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'VERTRAG', adrnr: '0000000502', vertragnr: '1', bestaetigung: true, grund: 'Kim hört auf' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select vertragende::text as e from tco.vertraege where adrnr = '0000000502' and vertragnr = '1'`)[0].e, jugendEnde);
  assert.ok((await sql`select notiz from tco.mgnotiz where adrnr = '0000000502'`).some((n) => String(n.notiz).includes('Kim hört auf')));
  assert.ok(r.body.pdf && Buffer.from(r.body.pdf, 'base64').subarray(0, 4).toString() === '%PDF', 'Kündigungsbestätigung als PDF');
  assert.match(r.body.dateiname, /^Kuendigungsbestaetigung_Portal_Kim\.pdf$/);
  assert.ok(r.body.hinweise.some((x: string) => /Mailversand ist nicht eingerichtet/.test(x)), JSON.stringify(r.body.hinweise));
  // fremder Vertrag (Mitglied 504) nicht erreichbar
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, vertragbegin, betrag) values ('0000000504', '1', '10', 'Erwachsene', '2019-05-01', 120)`;
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'VERTRAG', adrnr: '0000000504', vertragnr: '1', bestaetigung: true });
  assert.equal(r.status, 400);
  assert.equal((await sql`select vertragende from tco.vertraege where adrnr = '0000000504'`)[0].vertragende, null);

  // Mitgliedschaft: Austritt 31.12. des laufenden Jahres, alle eigenen Verträge enden
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'MITGLIEDSCHAFT', bestaetigung: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Mitgliedschaft gekündigt am .* zum 31\.12\./);
  const [m] = await sql`select austritt::text as a from tco.mitglieder where adrnr = '0000000501'`;
  assert.equal(m.a, `${jahr}-12-31`);
  assert.ok((await sql`select vertragende::text as e from tco.vertraege where adrnr = '0000000501'`).every((v) => v.e === `${jahr}-12-31`));
  assert.ok(r.body.pdf);
  r = await paula('GET', `${M}/meine`);
  assert.equal(r.body.gekuendigt, true);
  assert.equal((await paula('POST', `${M}/meine/kuendigung`, { art: 'MITGLIEDSCHAFT', bestaetigung: true })).status, 400, 'nur einmal');
  assert.ok((await sql`select count(*)::int as n from core.change_header where object_type = 'MITGLIED' and action = 'KUENDIGUNG'`)[0].n >= 2);
});
