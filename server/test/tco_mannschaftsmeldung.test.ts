/**
 * Integrationstest Mannschaftsmeldung / Anmeldematrix: Abfrage mit Mannschaften aus den Mitgliedergruppen anlegen, Mitglied
 * meldet sich und sein Kind (Familie) mit 1/2/3, fremde Personen und abgelaufene Frist werden abgewiesen, Matrix mit Summen,
 * Sportwart trägt nach, abgewählte Mannschaft verliert ihre Angaben, CSV, Entwurf für Mitglieder unsichtbar.
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
const { zaehlen, antwortMoeglich } = await import('../../modules/tco/server/mannschaftsmeldung/logik.js');

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
const M = '/api/m/tco/mannschaftsmeldung';
const ANNA = '0000000701', KIND = '0000000702', BEN = '0000000703';
let herren = 0, damen = 0, jugend = 0;

async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, geburtsdatum, geschlecht, adrnrkih) values
    (${ANNA}, 'Anna', 'Aufschlag', '2020-01-01', '1984-03-01', 'W', null),
    (${KIND}, 'Kai', 'Aufschlag', '2020-01-01', '2012-06-01', 'M', ${ANNA}),
    (${BEN}, 'Ben', 'Netz', '2020-01-01', '1982-02-01', 'M', null)`;
  await sql`insert into tco.mitgliedera (adrnr) values (${ANNA}), (${KIND}), (${BEN})`;
  for (const [u, a] of [['anna', ANNA], ['ben', BEN]]) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles: ['MITGLIED'] })).status, 200);
    await sql`insert into tco.mitglied_benutzer (benutzer_id, adrnr) select id, ${a} from core.users where username = ${u}`;
  }
  const [p] = await sql`insert into tco.kal_gruppen (name) values ('MM Mannschaften') returning id`;
  [{ id: herren }] = await sql`insert into tco.kal_gruppen (name, parent_id) values ('MM Herren 40', ${p.id}) returning id`;
  [{ id: damen }] = await sql`insert into tco.kal_gruppen (name, parent_id) values ('MM Damen 30', ${p.id}) returning id`;
  [{ id: jugend }] = await sql`insert into tco.kal_gruppen (name, parent_id) values ('MM U12', ${p.id}) returning id`;
  await sql`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr) values (${herren}, ${BEN})`;
});
after(async () => { await app?.close(); await sql.end(); });

test('reine Logik: Zählung und Frist', () => {
  const z = zaehlen([{ gruppe_id: 1 }, { gruppe_id: 2 }], [{ wahl: { 1: 1, 2: 3 } }, { wahl: { 1: 2 } }, { wahl: {} }]);
  assert.deepEqual(z, [{ gruppe_id: 1, fest: 1, ersatz: 1, nicht: 0, offen: 1 }, { gruppe_id: 2, fest: 0, ersatz: 0, nicht: 1, offen: 2 }]);
  assert.equal(antwortMoeglich({ status: 'offen', frist: '2026-05-01' }, '2026-05-01'), true, 'Frist einschließlich');
  assert.equal(antwortMoeglich({ status: 'offen', frist: '2026-05-01' }, '2026-05-02'), false);
  assert.equal(antwortMoeglich({ status: 'geschlossen', frist: null }, '2026-05-02'), false);
});

let abfrage = 0;

test('Abfrage anlegen: Mannschaften aus den Gruppen, Entwurf für Mitglieder unsichtbar', async () => {
  const g = await admin('GET', `${M}/gruppen`);
  assert.equal(g.status, 200);
  const vorschlag = g.body.filter((x: { vorschlag: boolean }) => x.vorschlag).map((x: { id: number }) => x.id);
  for (const id of [herren, damen, jugend]) assert.ok(vorschlag.includes(id), 'Blätter unter „Mannschaften“ vorgeschlagen');
  const r = await admin('POST', `${M}/abfragen`, { titel: 'Mannschaftsmeldung Sommer 2027', saison: 'Sommer 2027', frist: null, hinweis: 'Bitte bis Januar', status: 'entwurf', gruppen: [herren, damen, jugend] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  abfrage = r.body.id;
  const anna = await anmelden('anna');
  assert.equal((await anna('GET', `${M}/meine`)).body.abfragen.length, 0, 'Entwurf unsichtbar');
  assert.equal((await anna('GET', `${M}/abfragen`)).status, 403, 'Matrix nur für den Sportwart');
  await admin('PUT', `${M}/abfragen/${abfrage}`, { titel: 'Mannschaftsmeldung Sommer 2027', saison: 'Sommer 2027', frist: null, hinweis: 'Bitte bis Januar', status: 'offen', gruppen: [herren, damen, jugend] });
});

test('Mitglied meldet sich und die Familie, nicht fremde Personen', async () => {
  const anna = client();
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'neues-passwort' })).status, 200);
  const d = await anna('GET', `${M}/meine`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const a = d.body.abfragen[0];
  assert.equal(a.bearbeitbar, true);
  assert.deepEqual(a.mannschaften.map((x: { gruppe_id: number }) => x.gruppe_id), [herren, damen, jugend]);
  assert.deepEqual(a.personen.map((p: { adrnr: string }) => p.adrnr), [ANNA, KIND]);

  let r = await anna('POST', `${M}/meine/${abfrage}`, { adrnr: ANNA, bemerkung: 'im Juni Urlaub', wahl: [{ gruppe_id: herren, wahl: 3 }, { gruppe_id: damen, wahl: 1 }, { gruppe_id: jugend, wahl: null }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /für Anna gesichert \(2 von 3/);
  r = await anna('POST', `${M}/meine/${abfrage}`, { adrnr: KIND, wahl: [{ gruppe_id: jugend, wahl: 2 }] });
  assert.equal(r.status, 200, 'Kind über die Familie');
  assert.equal((await anna('POST', `${M}/meine/${abfrage}`, { adrnr: BEN, wahl: [{ gruppe_id: herren, wahl: 1 }] })).status, 403, 'fremde Person');
  assert.equal((await anna('POST', `${M}/meine/${abfrage}`, { adrnr: ANNA, wahl: [{ gruppe_id: herren, wahl: 4 }] })).status, 400, 'nur 1, 2, 3');
  // Änderung und Entfernen einer Angabe
  r = await anna('POST', `${M}/meine/${abfrage}`, { adrnr: ANNA, bemerkung: 'im Juni Urlaub', wahl: [{ gruppe_id: herren, wahl: 2 }, { gruppe_id: damen, wahl: null }, { gruppe_id: jugend, wahl: null }] });
  assert.match(r.body.text, /\(1 von 3/);
  const neu = (await anna('GET', `${M}/meine`)).body.abfragen[0].personen[0];
  assert.deepEqual([neu.wahl, neu.bemerkung], [{ [herren]: 2 }, 'im Juni Urlaub']);
});

test('Matrix: Personen der Gruppen und mit Angabe, Summen, Nachtragen, Frist, CSV, Mannschaft abwählen', async () => {
  let m = await admin('GET', `${M}/abfragen/${abfrage}`);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.deepEqual(m.body.zeilen.map((z: { adrnr: string }) => z.adrnr), [ANNA, KIND, BEN]);
  const ben = m.body.zeilen.find((z: { adrnr: string }) => z.adrnr === BEN);
  assert.deepEqual([ben.inGruppe, ben.wahl], [true, {}]);
  assert.deepEqual(m.body.summen.find((s: { gruppe_id: number }) => s.gruppe_id === herren), { gruppe_id: herren, fest: 0, ersatz: 1, nicht: 0, offen: 2 });
  assert.deepEqual(m.body.anzahl, { personen: 3, mitRueckmeldung: 2 });

  // Frist abgelaufen: Mitglied nicht mehr, Sportwart schon
  await sql`update tco.mm_abfragen set frist = current_date - 1 where id = ${abfrage}`;
  const benC = await anmelden('ben');
  const r = await benC('POST', `${M}/meine/${abfrage}`, { adrnr: BEN, wahl: [{ gruppe_id: herren, wahl: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Frist/);
  assert.equal((await benC('GET', `${M}/meine`)).body.abfragen[0].bearbeitbar, false);
  assert.equal((await admin('POST', `${M}/abfragen/${abfrage}/angabe`, { adrnr: BEN, wahl: [{ gruppe_id: herren, wahl: 1 }] })).status, 200);
  m = await admin('GET', `${M}/abfragen/${abfrage}`);
  assert.equal(m.body.summen.find((s: { gruppe_id: number }) => s.gruppe_id === herren).fest, 1);

  const csv = await admin('GET', `${M}/abfragen/${abfrage}/csv`);
  assert.equal(csv.status, 200);
  assert.match(String(csv.body), /Name;Jahrgang;Mitgl\.-Nr\. \(Adr\.\);MM Herren 40;MM Damen 30;MM U12;Bemerkung/);
  assert.match(String(csv.body), /Aufschlag, Anna;1984;0000000701;2;;;im Juni Urlaub/);

  // Mannschaft abwählen: Angaben dazu entfallen
  const s = await admin('PUT', `${M}/abfragen/${abfrage}`, { titel: 'Mannschaftsmeldung Sommer 2027', saison: 'Sommer 2027', frist: null, hinweis: '', status: 'geschlossen', gruppen: [damen, herren] });
  assert.match(s.body.text, /1 Angabe zu entfernten Mannschaften gelöscht/);
  m = await admin('GET', `${M}/abfragen/${abfrage}`);
  assert.deepEqual(m.body.mannschaften.map((x: { gruppe_id: number }) => x.gruppe_id), [damen, herren], 'Reihenfolge wie übergeben');
  const [n] = await sql`select count(*)::int as n from core.change_header where object_type = 'MANNSCHAFTSMELDUNG'`;
  assert.ok(n.n > 0, 'Änderungsbelege');
});

test('Rechte: Rolle Mitglied darf melden', async () => {
  const [r] = await sql`select 1 as x from core.role_permissions where role_id = 'MITGLIED' and permission = 'tco.mannschaftsmeldung:melden'`;
  assert.ok(r);
});
