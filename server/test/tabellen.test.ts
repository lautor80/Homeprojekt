/**
 * Tabellenansicht (Administration → Tabellenansicht): Tabellenliste, Struktur, Selektion, Gruppierung –
 * Geheimnisse nie sichtbar (auch nicht über Filter), Bankdaten nur mit Berechtigung, nur lesend.
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
const leser = client();
const ohne = client();
const T = '/api/admin/tabellen';

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await admin('POST', '/api/admin/roles', { id: 'TAB_LESER', name: 'Tabellen lesen', permissions: ['core.tabellen:display'] });
  for (const [u, rollen] of [['leser', ['TAB_LESER']], ['ohne', []]] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles: rollen })).status, 200);
    await sql`update core.users set must_change_password = false where username = ${u}`;
  }
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await ohne('POST', '/api/auth/login', { username: 'ohne', password: 'start-passwort' })).status, 200);
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, zahlungsart, iban1, mitglnrn) values
    ('0000000701', 'Tina', 'Tabelle', '2020-01-01', 'L', 'DE02120300000000202051', '701'),
    ('0000000702', 'Tom', 'Tabelle', '2021-06-01', 'B', null, '702')`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Tabellenliste und Struktur: nur core und aktive Module, Schutz je Spalte', async () => {
  assert.equal((await ohne('GET', T)).status, 403);
  let r = await leser('GET', T);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const namen = r.body.map((t: { schema: string; tabelle: string }) => `${t.schema}.${t.tabelle}`);
  assert.ok(namen.includes('core.users') && namen.includes('tco.mitglieder'));
  assert.ok(!namen.some((n: string) => n.startsWith('pg_') || n.startsWith('public.') || n.startsWith('information_schema.')));

  r = await leser('GET', `${T}/core/users`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sp = (n: string) => r.body.spalten.find((s: { name: string }) => s.name === n);
  assert.equal(sp('password_hash').schutz, 'GEHEIM');
  assert.equal(sp('id').schluessel, 1);
  assert.equal((await leser('GET', `${T}/tco/mitglieder`)).body.spalten.find((s: { name: string }) => s.name === 'iban1').schutz, 'iban');
  assert.equal((await leser('GET', `${T}/pg_catalog/pg_authid`)).status, 404);
  assert.equal((await leser('GET', `${T}/core/gibtsnicht`)).status, 404);
});

test('Daten: Geheimnisse maskiert und nicht über Filter erratbar, Bankdaten nur mit Berechtigung', async () => {
  let r = await leser('POST', `${T}/core/users/daten`, { felder: ['username', 'password_hash'], filter: [{ spalte: 'username', op: 'EQ', wert: 'admin' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen, [['admin', '•••']]);
  r = await leser('POST', `${T}/core/users/daten`, { filter: [{ spalte: 'password_hash', op: 'CP', wert: '$argon*' }] });
  assert.equal(r.body.gesamt, 0, 'Filter arbeitet auf dem maskierten Wert');
  r = await leser('POST', `${T}/core/sessions/daten`, { felder: ['token_hash'] });
  assert.ok(r.body.zeilen.length > 0 && r.body.zeilen.every((z: string[]) => z[0] === '•••'));

  r = await leser('POST', `${T}/tco/mitglieder/daten`, { felder: ['adrnr', 'iban1'], filter: [{ spalte: 'adrnr', op: 'EQ', wert: '0000000701' }] });
  assert.deepEqual(r.body.zeilen, [['0000000701', 'DE••••••••••••••••2051']]);
  r = await admin('POST', `${T}/tco/mitglieder/daten`, { felder: ['adrnr', 'iban1'], filter: [{ spalte: 'adrnr', op: 'EQ', wert: '0000000701' }] });
  assert.deepEqual(r.body.zeilen, [['0000000701', 'DE02120300000000202051']]);
  // Änderungsbelege: IBAN ohne Berechtigung maskiert
  await sql`update tco.mitglieder set iban1 = 'DE12500105170648489890' where adrnr = '0000000701'`;
  r = await leser('POST', `${T}/core/change_item/daten`, { felder: ['field', 'new_value'], filter: [{ spalte: 'field', op: 'EQ', wert: 'iban1' }] });
  assert.ok(r.body.zeilen.length > 0, JSON.stringify(r.body));
  assert.ok(r.body.zeilen.every((z: string[]) => !z[1] || z[1].includes('•')), JSON.stringify(r.body.zeilen));
});

test('Selektion: Operatoren, Sortierung, Gruppierung mit Kennzahlen, verständliche Fehler', async () => {
  const D = `${T}/tco/mitglieder/daten`;
  let r = await leser('POST', D, { felder: ['adrnr'], filter: [{ spalte: 'eintritt', op: 'BT', wert: '2021-01-01', bis: '2021-12-31' }] });
  assert.deepEqual(r.body.zeilen, [['0000000702']]);
  r = await leser('POST', D, { felder: ['vorname'], filter: [{ spalte: 'nachname', op: 'CP', wert: 'tab' }], sortierung: [{ spalte: 'vorname', absteigend: true }] });
  assert.deepEqual(r.body.zeilen, [['Tom'], ['Tina']]);
  r = await leser('POST', D, { felder: ['adrnr'], filter: [{ spalte: 'mitglnrn', op: 'IN', wert: '701; 999' }] });
  assert.deepEqual(r.body.zeilen, [['0000000701']]);
  r = await leser('POST', D, { felder: ['adrnr'], filter: [{ spalte: 'adrnr', op: 'CP', wert: '00000007*' }, { spalte: 'austritt', op: 'NULL' }], limit: 1 });
  assert.equal(r.body.zeilen.length, 1);
  assert.equal(r.body.gesamt, 2);
  assert.equal(r.body.mehr, true);

  r = await leser('POST', D, { gruppierung: { nach: ['zahlungsart'], summen: [{ fn: 'MIN', spalte: 'eintritt' }] }, sortierung: [{ spalte: 'zahlungsart', absteigend: false }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.spalten.map((s: { text: string }) => s.text), ['zahlungsart', 'Anzahl', 'Minimum eintritt']);
  assert.deepEqual(r.body.zeilen, [['B', '1', '2021-06-01'], ['L', '1', '2020-01-01']]);
  r = await leser('POST', D, { gruppierung: { nach: [], summen: [{ fn: 'SUM', spalte: 'nachname' }] } });
  assert.equal(r.status, 400, 'Summe nur über Zahlen');

  assert.equal((await leser('POST', D, { filter: [{ spalte: 'eintritt', op: 'EQ', wert: 'kein-datum' }] })).status, 400);
  assert.equal((await leser('POST', D, { felder: ['gibtsnicht'] })).status, 400);
  assert.equal((await leser('POST', D, { felder: ['adrnr"; drop table core.users; --'] })).status, 400);
  assert.equal(Number((await sql`select count(*)::int as n from core.users`)[0].n), 3);
});

test('Löschen markierter Sätze mit Papierkorb und Wiederherstellung (#34)', async () => {
  const D = `${T}/tco/mitglieder/daten`;
  // Schlüssel je Zeile kommen nur ungruppiert und nur für Tabellen mit verwendbarem Primärschlüssel
  let r = await admin('POST', D, { felder: ['vorname'], filter: [{ spalte: 'adrnr', op: 'EQ', wert: '0000000702' }] });
  assert.deepEqual([r.body.schluesselSpalten, r.body.schluessel], [['adrnr'], [['0000000702']]]);
  assert.deepEqual(r.body.zeilen, [['Tom']], 'Schlüssel nicht in den Anzeigezeilen');
  r = await admin('POST', `${T}/core/sessions/daten`, { felder: ['user_id'] });
  assert.equal(r.body.schluessel, null, 'Schlüssel mit Geheimnis (token_hash) – nicht löschbar');

  // nur mit core.tabellen:delete
  assert.equal((await leser('POST', `${T}/tco/mitglieder/loeschen`, { schluessel: [['0000000702']] })).status, 403);
  assert.equal((await leser('GET', `${T}/papierkorb`)).status, 403);
  assert.equal((await admin('POST', `${T}/core/change_item/loeschen`, { schluessel: [['1']] })).status, 400, 'Änderungsbelege nie');

  // abhängige Einträge (ON DELETE CASCADE) werden gemeldet statt still mitgelöscht
  const [lu] = await sql`select id::text from core.users where username = 'leser'`;
  r = await admin('POST', `${T}/core/users/loeschen`, { schluessel: [[lu.id]] });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.message, /abhängige Einträge: .*core\.user_roles/);
  assert.equal(Number((await sql`select count(*)::int as n from core.users where username = 'leser'`)[0].n), 1);

  r = await admin('POST', `${T}/tco/mitglieder/loeschen`, { schluessel: [['0000000702'], ['0000009999']], grund: 'Test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.geloescht, 1);
  assert.equal((await sql`select 1 from tco.mitglieder where adrnr = '0000000702'`).length, 0);

  r = await admin('GET', `${T}/papierkorb`);
  const e = r.body.find((x: any) => x.tabelle === 'mitglieder' && x.schluessel.adrnr === '0000000702');
  assert.ok(e, JSON.stringify(r.body));
  assert.deepEqual([e.schema, e.geloescht_von, e.grund], ['tco', 'admin', 'Test']);
  // die gesicherte Zeile ist in der Tabellenansicht maskiert
  r = await admin('POST', `${T}/core/tabellen_papierkorb/daten`, { felder: ['zeile'] });
  assert.ok(r.body.zeilen.every((z: string[]) => z[0] === '•••'));

  // Wiederherstellen: Satz wieder da, Eintrag aus dem Papierkorb entfernt; zweites Mal nichts mehr zu tun
  r = await admin('POST', `${T}/papierkorb/wiederherstellen`, { ids: [e.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen.map((z: any) => z.ok), [true], JSON.stringify(r.body));
  const [tom] = await sql`select vorname, eintritt::text, zahlungsart from tco.mitglieder where adrnr = '0000000702'`;
  assert.deepEqual([tom.vorname, tom.eintritt, tom.zahlungsart], ['Tom', '2021-06-01', 'B']);
  assert.equal((await admin('GET', `${T}/papierkorb`)).body.some((x: any) => x.id === e.id), false);

  // Konflikt: Schlüssel inzwischen wieder vorhanden → Meldung, Eintrag bleibt
  await admin('POST', `${T}/tco/mitglieder/loeschen`, { schluessel: [['0000000702']] });
  const id2 = (await admin('GET', `${T}/papierkorb`)).body[0].id;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) values ('0000000702', 'Tom', 'Neu', '2022-01-01')`;
  r = await admin('POST', `${T}/papierkorb/wiederherstellen`, { ids: [id2] });
  assert.deepEqual([r.body.zeilen[0].ok, /bereits vorhanden/.test(r.body.zeilen[0].text)], [false, true]);
  // nach 7 Tagen verfallen
  await sql`update core.tabellen_papierkorb set geloescht_am = now() - interval '8 days' where id = ${id2}`;
  assert.equal((await admin('GET', `${T}/papierkorb`)).body.some((x: any) => x.id === id2), false);
});
