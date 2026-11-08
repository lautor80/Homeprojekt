/**
 * Sicherung und Rücksicherung über alle Bereiche: Erstellen, Download/Upload, Verschlüsselung,
 * Rücksicherung einzelner Bereiche und komplett, neuere Sicherung abgelehnt, Berechtigungen.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco,transport';
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sicherung-test-'));

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, p: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: method as 'GET', url: p, payload: payload as object, headers: { cookie, 'x-portal-request': '1', ...headers } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.rawPayload };
  };
}
let admin = client();
const B = '/api/backup';
const zahl = async (q: string) => Number((await sql.unsafe(q))[0].n);

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Sicherung', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) values ('0000000901', 'Hanna', 'Sicher', '2020-01-01'), ('0000000902', 'Otto', 'Kopie', '2021-05-01')`;
  await sql`insert into transport.adressen (adrnr, kundenname, ort) values (9001, 'Spedition Test', 'Oberthal')`;
  await sql`insert into core.settings (key, value) values ('org.address', ${sql.json('Alte Straße 1')}) on conflict (key) do update set value = excluded.value`;
});
after(async () => {
  await app?.close();
  await sql.end();
});

let datei = '';
let geheim = '';

test('Sicherung erstellen: Übersicht, alle Bereiche, verschlüsselt', async () => {
  let r = await admin('GET', B);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.schemas.map((s: any) => s.schema), ['core', 'transport', 'tco']);
  assert.equal(r.body.dauerhaft, true);

  r = await admin('POST', B, { notiz: 'Test komplett' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  datei = r.body.name;
  assert.match(datei, /^portal_\d{4}-\d{2}-\d{2}_\d{6}\.portal$/);
  assert.deepEqual(r.body.info.schemas, ['core', 'transport', 'tco']);
  assert.ok(r.body.info.zeilen > 0);

  r = await admin('POST', B, { passwort: 'kurz' });
  assert.equal(r.status, 400);
  r = await admin('POST', B, { passwort: 'sehr-geheim-123', schemas: ['tco'], notiz: 'nur Verein' });
  assert.equal(r.status, 200);
  geheim = r.body.name;
  assert.equal(r.body.info.verschluesselt, true);

  r = await admin('GET', B);
  assert.equal(r.body.dateien.length, 2);
  const d = (await admin('GET', `${B}/datei/${datei}`)).body as Buffer;
  assert.equal(d.subarray(0, 5).toString(), 'PSIC1');
  // Pfad-Tricks abgelehnt
  assert.equal((await admin('GET', `${B}/datei/..%2F..%2Fetc%2Fpasswd`)).status, 400);
});

test('Prüfen und Rücksichern einzelner Bereiche (tco), Zähler und Änderungsbelege', async () => {
  await sql`delete from tco.mitglieder where adrnr = '0000000902'`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname) values ('0000000903', 'Neu', 'Nachher')`;
  await sql`update transport.adressen set ort = 'Geändert' where adrnr = 9001`;

  let r = await admin('POST', `${B}/datei/${datei}/pruefen`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.schemas.every((s: any) => s.status === 'gleich'));

  r = await admin('POST', `${B}/datei/${datei}/ruecksichern`, { schemas: ['tco'], bestaetigung: 'falsch' });
  assert.equal(r.status, 400);
  const auditVorher = await zahl('select count(*) as n from core.change_header');
  r = await admin('POST', `${B}/datei/${datei}/ruecksichern`, { schemas: ['tco'], bestaetigung: 'wiederherstellen' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.abgemeldet, false);
  assert.match(r.body.sicherheitskopie, /_vor-ruecksicherung\.portal$/);
  assert.deepEqual((await sql`select adrnr from tco.mitglieder order by adrnr`).map((x) => x.adrnr), ['0000000901', '0000000902']);
  assert.equal((await sql`select ort from transport.adressen where adrnr = 9001`)[0].ort, 'Geändert', 'Euroflex nicht angefasst');
  // Rücksicherung erzeugt keine Änderungsbelege je Datensatz (nur das Protokoll)
  assert.ok(await zahl('select count(*) as n from core.change_header') - auditVorher <= 2);
  // Sicherheitskopie enthält den Stand davor
  r = await admin('POST', `${B}/datei/${r.body.sicherheitskopie}/pruefen`, {});
  assert.equal(r.status, 200);
});

test('verschlüsselte Sicherung: falsches Passwort, Upload, Rücksicherung', async () => {
  let r = await admin('POST', `${B}/datei/${geheim}/pruefen`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.message, /verschlüsselt/);
  r = await admin('POST', `${B}/datei/${geheim}/pruefen`, { passwort: 'falsch-falsch' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Passwort ist falsch/);
  // Download und erneuter Upload
  const bytes = (await admin('GET', `${B}/datei/${geheim}`)).body as Buffer;
  r = await admin('POST', `${B}/hochladen`, bytes, { 'content-type': 'application/octet-stream', 'x-dateiname': 'kopie.portal' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, 'kopie.portal');
  assert.equal(r.body.verschluesselt, true);
  r = await admin('POST', `${B}/hochladen`, Buffer.from('kein backup'), { 'content-type': 'application/octet-stream', 'x-dateiname': 'x.portal' });
  assert.equal(r.status, 400);
  await sql`delete from tco.mitglieder`;
  r = await admin('POST', `${B}/datei/kopie.portal/ruecksichern`, { schemas: ['tco'], passwort: 'sehr-geheim-123', bestaetigung: 'WIEDERHERSTELLEN' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await zahl('select count(*) as n from tco.mitglieder'), 2);
  // Bereich nicht in der Sicherung
  r = await admin('POST', `${B}/datei/kopie.portal/ruecksichern`, { schemas: ['transport'], passwort: 'sehr-geheim-123', bestaetigung: 'WIEDERHERSTELLEN' });
  assert.equal(r.status, 400);
});

test('Sicherung eines neueren Portalstands wird abgelehnt', async () => {
  await sql`insert into public.schema_migrations (id) values ('tco/999_zukunft.sql')`;
  const r1 = await admin('POST', B, { schemas: ['tco'] });
  await sql`delete from public.schema_migrations where id = 'tco/999_zukunft.sql'`;
  let r = await admin('POST', `${B}/datei/${r1.body.name}/pruefen`, {});
  assert.equal(r.body.schemas[0].status, 'neuer');
  r = await admin('POST', `${B}/datei/${r1.body.name}/ruecksichern`, { schemas: ['tco'], bestaetigung: 'WIEDERHERSTELLEN' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /neueren Portalstand/);
});

test('Komplette Rücksicherung inkl. Basis: Einstellungen und Benutzer, Abmeldung', async () => {
  // Änderungen nach der Sicherung: Einstellung, neuer Benutzer mit Rolle ohne Sicherungsrecht
  await sql`update core.settings set value = ${sql.json('Neue Straße 2')} where key = 'org.address'`;
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'LESER', name: 'Leser', permissions: ['tco.mitglieder:display'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea', password: 'start-passwort', roles: ['LESER'] })).status, 200);
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('GET', B)).status, 403);

  const r = await admin('POST', `${B}/datei/${datei}/ruecksichern`, { schemas: ['core', 'transport', 'tco'], bestaetigung: 'WIEDERHERSTELLEN' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.abgemeldet, true);
  assert.equal((await sql`select value from core.settings where key = 'org.address'`)[0].value, 'Alte Straße 1');
  assert.equal(await zahl(`select count(*) as n from core.users where username = 'leser'`), 0);
  assert.equal((await sql`select ort from transport.adressen where adrnr = 9001`)[0].ort, 'Oberthal');
  // alle Sitzungen beendet; Anmeldung mit den Daten der Sicherung
  assert.equal((await admin('GET', B)).status, 401);
  admin = client();
  assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' })).status, 200);
  const l = await admin('GET', B);
  assert.equal(l.status, 200);
  assert.ok(l.body.letzteRuecksicherung?.datei === datei);
  // neue Datensätze nach der Rücksicherung bekommen freie Nummern (Zähler zurückgesetzt)
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'NACH', name: 'Danach', permissions: [] })).status, 200);
});
