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

test('Sperre: eigenes Mitglied in „Meine Mitgliedschaft“ sperrbar, fremdes nicht; Vorstand und Mitglied blockieren sich gegenseitig', async () => {
  const S = '/api/sperren';
  const kim = client();
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim.portal', password: 'mein-neues-kennwort' })).status, 200);
  // Kim sperrt sich selbst – nicht Paula
  let r = await kim('POST', S, { objekt: 'MITGLIED', schluessel: '0000000502', bezeichnung: 'Mitglied Kim Portal (Meine Mitgliedschaft)' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id as number;
  assert.equal((await kim('POST', S, { objekt: 'MITGLIED', schluessel: '0000000501' })).status, 403);
  // Sperrübersicht zeigt die Sperre
  r = await admin('GET', S);
  assert.ok(r.body.some((s: { id: number; bezeichnung: string }) => s.id === id && /Meine Mitgliedschaft/.test(s.bezeichnung)));
  // Vorstand kann Kim gerade nicht bearbeiten
  assert.equal((await admin('POST', S, { objekt: 'MITGLIED', schluessel: '0000000502' })).status, 423);
  r = await admin('POST', `${M}/m/0000000502/kanal`, { kanal: 'E' });
  assert.equal(r.status, 423, JSON.stringify(r.body));
  await kim('POST', `${S}/freigeben`, { ids: [id] });
  // umgekehrt: Vorstand sperrt, Kim kann nicht speichern
  r = await admin('POST', S, { objekt: 'MITGLIED', schluessel: '0000000502' });
  assert.equal(r.status, 200);
  r = await kim('PUT', `${M}/meine/kontakt`, { strasse: 'Weg 2', plz: '66649', ort: 'Oberthal', telefon: '', mobil: '', email: 'kim@example.org', bildrechte: false });
  assert.equal(r.status, 423, JSON.stringify(r.body));
  assert.equal((await kim('POST', S, { objekt: 'MITGLIED', schluessel: '0000000502' })).status, 423);
});

test('Meine Dokumente: ohne Paperless leer mit Hinweis, fremde Dokumente nicht abrufbar', async () => {
  let r = await paula('GET', `${M}/meine/dokumente`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.dokumente, []);
  assert.match(r.body.hinweis, /nicht eingerichtet/);
  r = await paula('GET', `${M}/meine/dokumente/4711`);
  assert.ok([400, 404].includes(r.status), String(r.status));
});

test('Rollen: zugeordnete Benutzer anzeigen, einzeln entziehen, Rolle löschen entzieht allen', async () => {
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'TESTROLLE', name: 'Test', permissions: ['tco.mitglieder:display'] })).status, 200);
  const ids = (await sql`select id::text, username from core.users where username in ('kim.portal', 'paula.portal')`);
  for (const u of ids) await sql`insert into core.user_roles (user_id, role_id) values (${u.id}, 'TESTROLLE')`;
  let r = await admin('GET', '/api/admin/roles/TESTROLLE/users');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x: { username: string }) => x.username).sort(), ['kim.portal', 'paula.portal']);
  const kimId = ids.find((x) => x.username === 'kim.portal')!.id;
  r = await admin('POST', '/api/admin/roles/TESTROLLE/entziehen', { benutzer: [kimId] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await sql`select role_id from core.user_roles where user_id = ${kimId} order by 1`).map((x) => x.role_id), ['MITGLIED'], 'andere Rollen bleiben');
  assert.equal((await paula('POST', '/api/admin/roles/TESTROLLE/entziehen', { benutzer: [kimId] })).status, 403);
  // letzter Admin / eigene Adminrolle bleibt
  const [a] = await sql`select id::text from core.users where username = 'admin'`;
  r = await admin('POST', '/api/admin/roles/ADMIN/entziehen', { benutzer: [a.id] });
  assert.equal(r.status, 400);
  // Rolle löschen: wird allen entzogen; Systemrollen nicht löschbar
  r = await admin('DELETE', '/api/admin/roles/TESTROLLE');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /1 Benutzer\(n\) entzogen/);
  assert.equal((await sql`select count(*)::int as n from core.user_roles where role_id = 'TESTROLLE'`)[0].n, 0);
  assert.equal((await admin('DELETE', '/api/admin/roles/MITGLIED')).status, 400);
  assert.equal((await admin('DELETE', '/api/admin/roles/ADMIN')).status, 400);
});

test('Benutzer: Status direkt sperren, Einzelanlage aus Mitglied/EP3, Austritt sperrt den Benutzer', async () => {
  // Einzelanlage: Kandidaten enthalten Mitglied ohne Benutzer und EP3-Kunde ohne Benutzer
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, eintritt, mitglnrn) values ('0000000505', 'Eva', 'Einzeln', 'eva@example.org', '2024-01-01', '505')`;
  await sql`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname) values ('55', 'gast.g', 'enabled', 'gast@example.org', 'Gerd', 'Gast')`;
  let r = await admin('GET', `${M}/benutzer-kandidaten?suche=ein`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.some((k: { art: string; schluessel: string }) => k.art === 'MITGLIED' && k.schluessel === '0000000505'));
  r = await admin('GET', `${M}/benutzer-kandidaten?suche=gast`);
  assert.ok(r.body.some((k: { art: string; schluessel: string }) => k.art === 'EP3' && k.schluessel === '55'));
  assert.equal((await paula('GET', `${M}/benutzer-kandidaten?suche=a`)).status, 403);

  r = await admin('POST', `${M}/benutzer-einzeln`, { art: 'MITGLIED', schluessel: '0000000505', mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.username, 'eva@example.org');
  assert.ok(r.body.startkennwort);
  assert.deepEqual((await sql`select ur.role_id from core.user_roles ur join core.users u on u.id = ur.user_id where u.username = 'eva@example.org'`).map((x) => x.role_id), ['MITGLIED']);
  assert.equal((await admin('POST', `${M}/benutzer-einzeln`, { art: 'MITGLIED', schluessel: '0000000505' })).status, 400, 'nur einmal');
  r = await admin('POST', `${M}/benutzer-einzeln`, { art: 'EP3', schluessel: '55' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.username, 'gast@example.org');
  assert.deepEqual((await sql`select ur.role_id from core.user_roles ur join core.users u on u.id = ur.user_id where u.username = 'gast@example.org'`).map((x) => x.role_id), ['HALLENNUTZER']);

  // Status direkt sperren/entsperren
  const [eva] = await sql`select id::text from core.users where username = 'eva@example.org'`;
  r = await admin('POST', `/api/admin/users/${eva.id}/aktiv`, { aktiv: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select active from core.users where id = ${eva.id}`)[0].active, false);
  r = await admin('POST', `/api/admin/users/${eva.id}/aktiv`, { aktiv: true });
  assert.equal((await sql`select active from core.users where id = ${eva.id}`)[0].active, true);
  const [ad] = await sql`select id::text from core.users where username = 'admin'`;
  assert.equal((await admin('POST', `/api/admin/users/${ad.id}/aktiv`, { aktiv: false })).status, 400, 'nicht sich selbst');
  assert.equal((await paula('POST', `/api/admin/users/${eva.id}/aktiv`, { aktiv: false })).status, 403);

  // Austritt in der Vergangenheit (Verwaltung) → Benutzer sofort gesperrt
  r = await admin('POST', `${M}/m/0000000505/austritt`, { austritt: '2025-12-31' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Benutzer eva@example\.org gesperrt/);
  assert.equal((await sql`select active from core.users where id = ${eva.id}`)[0].active, false);
  // Kündigung zum Jahresende sperrt erst nach dem Austritt (täglicher Lauf)
  const { ausgetreteneSperren } = await import('../../modules/tco/server/mitglieder/selbst.js');
  const r2 = await sql.begin((tx) => ausgetreteneSperren(tx as never));
  assert.ok(!r2.gesperrt.includes('paula.portal'), 'Paula: Austritt erst zum Jahresende');
  await sql`update tco.mitglieder set austritt = current_date - 1 where adrnr = '0000000501'`;
  const r3 = await sql.begin((tx) => ausgetreteneSperren(tx as never));
  assert.ok(r3.gesperrt.includes('paula.portal'));
  assert.equal((await paula('GET', `${M}/meine`)).status, 401, 'Sitzung beendet');
});

test('Benutzer ↔ Mitglied/EP3: einzeln zuordnen und initiales Mapping', async () => {
  // vorhandene Benutzer ohne Zuordnung (z. B. vor dem Portal angelegt)
  for (const [u, n, e] of [['ines', 'Ines Initial', 'ines@example.org'], ['kai.k', 'Kunde, Kai', null]] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: n, email: e, password: 'start-passwort', roles: [] })).status, 200);
  }
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, eintritt) values ('0000000506', 'Ines', 'Initial', 'ines@example.org', '2023-01-01')`;
  await sql`insert into tco.kunden (zuid, zalias, status, vorname, nachname) values ('66', 'kai.k', 'enabled', 'Kai', 'Kunde'), ('67', 'ines.ep3', 'enabled', 'Ines', 'Initial')`;
  let r = await admin('GET', `${M}/benutzer-mapping`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ines = r.body.find((v: { username: string }) => v.username === 'ines');
  const kai = r.body.find((v: { username: string }) => v.username === 'kai.k');
  assert.equal(ines.mitglied.adrnr, '0000000506');
  assert.equal(ines.mitglied.grund, 'gleiche E-Mail');
  assert.equal(ines.ep3.zuid, '67');
  assert.equal(kai.mitglied, null);
  assert.equal(kai.ep3.zuid, '66');
  assert.equal(kai.ep3.grund, 'gleicher Benutzername');
  r = await admin('POST', `${M}/benutzer-mapping`, { liste: [{ benutzerId: ines.benutzerId, adrnr: ines.mitglied.adrnr, zuid: ines.ep3.zuid }, { benutzerId: kai.benutzerId, zuid: '66' }], rolleMitglied: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /1 Mitglied\(er\) und 2 EP3-Kunde\(n\)/);
  r = await admin('GET', `${M}/benutzer/${ines.benutzerId}/zuordnung`);
  assert.equal(r.body.mitglied.adrnr, '0000000506');
  assert.deepEqual([r.body.ep3.zuid, r.body.ep3.ueber], ['67', 'MITGLIED']);
  assert.deepEqual((await sql`select role_id from core.user_roles where user_id = ${ines.benutzerId}`).map((x) => x.role_id), ['MITGLIED']);
  r = await admin('GET', `${M}/benutzer/${kai.benutzerId}/zuordnung`);
  assert.deepEqual([r.body.mitglied, r.body.ep3.ueber], [null, 'BENUTZER']);
  // danach keine Vorschläge mehr für beide
  r = await admin('GET', `${M}/benutzer-mapping`);
  assert.ok(!r.body.some((v: { username: string }) => ['ines', 'kai.k'].includes(v.username)));
  // einzeln ändern/entfernen; EP3-Kunde eines anderen Benutzers abgelehnt
  r = await admin('PUT', `${M}/benutzer/${kai.benutzerId}/zuordnung`, { zuid: '67' });
  assert.equal(r.status, 400);
  r = await admin('PUT', `${M}/benutzer/${kai.benutzerId}/zuordnung`, { zuid: null });
  assert.equal(r.status, 200);
  assert.equal((await admin('GET', `${M}/benutzer/${kai.benutzerId}/zuordnung`)).body.ep3, null);
  assert.equal((await paula('GET', `${M}/benutzer-mapping`)).status, 403);
});
