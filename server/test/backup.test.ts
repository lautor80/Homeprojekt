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

test('XML-Format: Werte mit Steuerzeichen, Tabs, Zeilenumbrüchen, Backslash und NULL bleiben erhalten', async () => {
  const { tabelleXml, tabelleAusXml, copyText, copyZeilen, zipSchreiben, zipLesen } = await import('../src/backup-xml.js');
  const werte = [['a\tb', 'Zeile1\nZeile2\r\n', 'C:\\pfad\\n', null, 'Steuer\u0001zeichen', 'Ümlaut & <tag> "x" 🎾', '']];
  const text = copyText(werte);
  assert.deepEqual(copyZeilen(text), werte);
  const spalten = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name, typ: 'text' }));
  const xml = tabelleXml('tco.test', spalten, text);
  assert.match(xml, /b64="1"/);
  assert.match(xml, /<wert spalte="d" null="1"\/>/);
  const zurueck = tabelleAusXml(xml, 'test.xml');
  assert.equal(zurueck.text, text);
  assert.equal(zurueck.zeilen, 1);
  const zip = zipSchreiben([{ name: 'ä/x.xml', daten: Buffer.from(xml) }, { name: 'leer.txt', daten: Buffer.alloc(0) }]);
  const gelesen = zipLesen(zip);
  assert.equal(gelesen.get('ä/x.xml')!.toString(), xml);
  assert.equal(gelesen.get('leer.txt')!.length, 0);
});

test('Sicherung als ZIP mit XML: erstellen, bearbeiten, hochladen, zurücksichern; .portal umwandeln', async () => {
  const { zipLesen, zipSchreiben } = await import('../src/backup-xml.js');
  let r = await admin('POST', B, { schemas: ['tco'], format: 'zip', passwort: 'sehr-geheim-123' });
  assert.equal(r.status, 400, 'ZIP ist nie verschlüsselt');
  r = await admin('POST', B, { schemas: ['tco'], format: 'zip', notiz: 'als XML' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const name = r.body.name as string;
  assert.match(name, /\.zip$/);
  const liste = await admin('GET', B);
  assert.equal(liste.body.dateien.find((f: any) => f.name === name)?.format, 'zip');

  const roh = (await admin('GET', `${B}/datei/${name}`)).body as Buffer;
  const dateien = zipLesen(roh);
  assert.ok(dateien.has('manifest.xml'));
  assert.ok(dateien.has('LIESMICH.txt'));
  assert.match(dateien.get('manifest.xml')!.toString(), /<sicherung format="portal-sicherung"[\s\S]*<bereich>tco<\/bereich>/);
  const mxml = dateien.get('daten/tco/mitglieder.xml')!.toString();
  assert.match(mxml, /<wert spalte="vorname">Hanna<\/wert>/);

  // unverändert prüfbar
  r = await admin('POST', `${B}/datei/${name}/pruefen`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.schemas[0].status, 'gleich');

  // bearbeiten (Wert mit Sonderzeichen), in Unterordner neu packen, hochladen, zurücksichern
  dateien.set('daten/tco/mitglieder.xml', Buffer.from(mxml.replace('>Hanna<', '>Johanna &amp; Co<')));
  const neu = zipSchreiben([...dateien].map(([n, d]) => ({ name: `export/${n}`, daten: d })));
  r = await admin('POST', `${B}/hochladen`, neu, { 'content-type': 'application/octet-stream', 'x-dateiname': 'bearbeitet.zip' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, 'bearbeitet.zip');
  r = await admin('POST', `${B}/datei/bearbeitet.zip/ruecksichern`, { schemas: ['tco'], bestaetigung: 'WIEDERHERSTELLEN' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select vorname from tco.mitglieder where adrnr = '0000000901'`)[0].vorname, 'Johanna & Co');

  // fehlende Tabellendatei wird erkannt
  const kaputt = new Map(dateien);
  kaputt.delete('daten/tco/mitglieder.xml');
  r = await admin('POST', `${B}/hochladen`, zipSchreiben([...kaputt].map(([n, d]) => ({ name: n, daten: d }))), { 'content-type': 'application/octet-stream', 'x-dateiname': 'kaputt.zip' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /fehlt die Tabellendatei/);

  // vorhandene .portal-Sicherungen als XML (ZIP) umwandeln – verschlüsselt nur mit Passwort
  r = await admin('POST', `${B}/datei/${geheim}/xml`, {});
  assert.equal(r.status, 400);
  r = await admin('POST', `${B}/datei/${geheim}/xml`, { passwort: 'sehr-geheim-123' });
  assert.equal(r.status, 200);
  assert.ok(zipLesen(r.body as Buffer).has('daten/tco/mitglieder.xml'));
  r = await admin('POST', `${B}/datei/${datei}/xml`, {});
  assert.equal(r.status, 200);
  assert.ok(zipLesen(r.body as Buffer).has('daten/core/settings.xml'));
});

test('Vollständigkeit: jede Tabelle und jede Spalte aller aktiven Bereiche ist in der Sicherung (außer bewusst ausgeschlossenen)', async () => {
  const { sichern, aktiveSchemas } = await import('../src/backup.js');
  const schemas = aktiveSchemas();
  const inhalt = await sichern({ von: 'Test' });
  const gesichert = new Map(inhalt.manifest.tabellen.map((t) => [t.name, t.spalten.map((s) => s.name).sort()]));
  const ist = await sql`
    select n.nspname || '.' || c.relname as name,
           array_agg(a.attname::text order by a.attname) as spalten
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     where c.relkind in ('r', 'p') and n.nspname = any(${schemas})
     group by 1 order by 1`;
  const fehlen: string[] = [];
  for (const t of ist) {
    if (inhalt.manifest.ausgeschlossen.includes(t.name)) continue;
    const g = gesichert.get(t.name);
    if (!g) { fehlen.push(`Tabelle ${t.name}`); continue; }
    for (const sp of t.spalten as string[]) if (!g.includes(sp)) fehlen.push(`Spalte ${t.name}.${sp}`);
  }
  assert.deepEqual(fehlen, []);
  assert.deepEqual([...inhalt.manifest.ausgeschlossen].sort(), ['core.sessions', 'core.sperren']);
  // Tabellen außerhalb der Bereiche gibt es nicht (außer der Migrationsliste)
  const fremd = await sql`select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and not (n.nspname = any(${schemas}))`;
  assert.deepEqual(fremd.map((x) => x.name), ['public.schema_migrations']);
  // neuere Tabellen sind dabei
  for (const t of ['tco.platzbelegungen', 'tco.registrierungen', 'tco.plaetze', 'core.paperless_mapping']) assert.ok(gesichert.has(t), t);
  assert.ok(gesichert.get('tco.kunden')!.includes('pw_hash') && gesichert.get('tco.kunden')!.includes('benutzer_id'));
});

test('Rücksicherung eines Bereichs: Verweise auf inzwischen gelöschte Benutzer werden geleert statt abzubrechen', async () => {
  assert.equal((await admin('POST', '/api/admin/users', { username: 'weg.user', displayName: 'Weg', password: 'start-passwort', roles: [] })).status, 200);
  const [u] = await sql`select id from core.users where username = 'weg.user'`;
  await sql`insert into tco.kunden (zuid, zalias, status, benutzer_id) values ('88', 'weg', 'enabled', ${u.id})`;
  await sql`insert into tco.platzbelegungen (bezeichnung, datum_von, datum_bis, zeit_von, zeit_bis) values ('Jugendtraining', '2026-01-01', '2026-12-31', '16:00', '18:00')`;
  let r = await admin('POST', B, { schemas: ['tco'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const name = r.body.name;
  // Benutzer danach gelöscht
  await sql`delete from core.users where id = ${u.id}`;
  await sql`delete from tco.platzbelegungen`;
  r = await admin('POST', `${B}/datei/${name}/ruecksichern`, { schemas: ['tco'], bestaetigung: 'WIEDERHERSTELLEN' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select benutzer_id from tco.kunden where zuid = '88'`)[0].benutzer_id, null);
  assert.equal(Number((await sql`select count(*)::int as n from tco.platzbelegungen`)[0].n), 1);
  // Systemrollen sind nach der Rücksicherung vorhanden
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'MITGLIED' order by 1`).map((x) => x.permission), ['tco.meinedaten:edit', 'tco.platzbuchung:edit']);
});
