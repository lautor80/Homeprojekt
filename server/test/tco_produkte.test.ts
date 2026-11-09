/**
 * Produkte pflegen (#26): Liste aller Bereiche, Ändern, neuer Preis ab Stichtag, Anlegen, Beenden, Erlöskonto, Berechtigung.
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
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}
const P = '/api/m/tco/produkte';
const heute = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
const plus = (t: number) => { const d = new Date(`${heute()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + t); return d.toISOString().slice(0, 10); };

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await client()('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('1200', 'Bank', 'BA'), ('8003', 'Hallenmiete', null), ('8005', 'Clubheim', null), ('8400', 'Verzehr', null)`;
  await sql`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ, menge) values
            ('001', '2026-01-01', '9999-12-31', 'Halle Einzel', 20, '2', null),
            ('101', '2026-01-01', '9999-12-31', 'PILS 0,3', 2.5, 'G', '0.3'),
            ('201', '2026-01-01', '9999-12-31', 'Bratwurst', 3, 'S', '1')`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Produkte: lesen, ändern, neuer Preis, anlegen, beenden', async () => {
  const a = client();
  await a('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  let r = await a('GET', P);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.produkte.map((p: any) => [p.prod_key, p.bereich, p.aktuell]), [['001', 'HALLE', true], ['101', 'GETRAENK', true], ['201', 'SPEISE', true]]);
  assert.ok(r.body.konten.some((k: any) => k.konto === '8005'));
  assert.ok(!r.body.konten.some((k: any) => k.konto === '1200'), 'keine Bankkonten als Erlöskonto');

  // Ändern: Hallenprodukt bekommt ein Erlöskonto, unbekanntes Konto wird abgewiesen
  r = await a('PUT', `${P}/001/2026-01-01`, { text: 'Halle Einzel', preis: 22, erloeskonto: '9999' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nicht im Kontenstamm/);
  r = await a('PUT', `${P}/001/2026-01-01`, { text: 'Halle Einzelstunde', preis: 22, erloeskonto: '8003' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let [p] = await sql`select text, preis::float8 as preis, erloeskonto, typ from tco.produkte where prod_key = '001'`;
  assert.deepEqual({ ...p }, { text: 'Halle Einzelstunde', preis: 22, erloeskonto: '8003', typ: '2' });
  // Hallenprodukte: neue Zeiträume nur in den Hallenpreisen
  r = await a('POST', `${P}/001/preis`, { ab: plus(1), text: 'x', preis: 1 });
  assert.equal(r.status, 400);

  // Neuer Preis ab morgen: alter Zeitraum endet heute
  r = await a('POST', `${P}/101/preis`, { ab: plus(1), text: 'PILS 0,3', preis: 2.8, preis_gast: 3.2, erloeskonto: '8005' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const z = await sql`select to_char(valid_from, 'YYYY-MM-DD') as von, to_char(valid_to, 'YYYY-MM-DD') as bis, preis::float8 as preis, preis_gast::float8 as gast, menge, erloeskonto
                        from tco.produkte where prod_key = '101' order by valid_from`;
  assert.deepEqual(z.map((x) => [x.von, x.bis, x.preis, x.gast, x.menge, x.erloeskonto]),
    [['2026-01-01', heute(), 2.5, null, '0.3', null], [plus(1), '9999-12-31', 2.8, 3.2, '0.3', '8005']]);
  r = await a('POST', `${P}/101/preis`, { ab: '2020-01-01', text: 'PILS', preis: 1 });
  assert.equal(r.status, 400);

  // Anlegen: nächster Schlüssel im Bereich, Dubletten werden abgewiesen
  r = await a('POST', P, { bereich: 'SPEISE', ab: heute(), text: 'Pommes', preis: '2,5'.replace(',', '.'), erloeskonto: '8400' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.prod_key, '202');
  [p] = await sql`select typ, menge, erloeskonto from tco.produkte where prod_key = '202'`;
  assert.deepEqual({ ...p }, { typ: 'S', menge: '1', erloeskonto: '8400' });
  r = await a('POST', P, { bereich: 'SPEISE', ab: heute(), text: 'pommes', preis: 3 });
  assert.equal(r.status, 400);
  r = await a('POST', P, { bereich: 'HALLE', ab: heute(), text: 'Neu', preis: 3 });
  assert.equal(r.status, 400);
  r = await a('POST', P, { bereich: 'ANDERE', ab: heute(), text: 'Vereinsshirt', preis: 15 });
  assert.equal(r.body.prod_key, '400');

  // Beenden: ab morgen nicht mehr gültig
  r = await a('POST', `${P}/201/beenden`, { ab: plus(1) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  [p] = await sql`select to_char(valid_to, 'YYYY-MM-DD') as bis from tco.produkte where prod_key = '201'`;
  assert.equal(p.bis, heute());

  // Massenpflege: Erlöskonto je Bereich (nurOhne lässt eigene Konten stehen)
  r = await a('POST', `${P}/bereich-konto`, { bereich: 'GETRAENK', erloeskonto: '8400', nurOhne: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let k = await sql`select to_char(valid_from, 'YYYY-MM-DD') as von, erloeskonto from tco.produkte where prod_key = '101' order by valid_from`;
  assert.deepEqual(k.map((x) => x.erloeskonto), ['8400', '8005'], 'eigenes Konto 8005 bleibt');
  r = await a('POST', `${P}/bereich-konto`, { bereich: 'GETRAENK', erloeskonto: '8400' });
  assert.equal(r.body.anzahl, 1);
  k = await sql`select distinct erloeskonto from tco.produkte where prod_key = '101'`;
  assert.deepEqual(k.map((x) => x.erloeskonto), ['8400']);
  assert.equal((await a('POST', `${P}/bereich-konto`, { bereich: 'SPEISE', erloeskonto: '9999' })).status, 400);
  r = await a('POST', `${P}/bereich-konto`, { bereich: 'SPEISE', erloeskonto: null });
  assert.equal((await sql`select count(*)::int as n from tco.produkte where prod_key like '2%' and erloeskonto is not null`)[0].n, 0);

  // Änderungsbelege
  const [h] = await sql`select count(*)::int as n from core.change_header where action like 'PRODUKT_%'`;
  assert.ok(h.n >= 4);
});

test('Produkte: Berechtigung', async () => {
  const a = client();
  await a('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  assert.equal((await a('POST', '/api/admin/roles', { id: 'PRODLESER', name: 'Produkte lesen', permissions: ['tco.produkte:display'] })).status, 200);
  assert.equal((await a('POST', '/api/admin/users', { username: 'prodleser', displayName: 'PL', password: 'start-passwort', roles: ['PRODLESER'] })).status, 200);
  const l = client();
  await l('POST', '/api/auth/login', { username: 'prodleser', password: 'start-passwort' });
  await l('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' });
  assert.equal((await l('GET', P)).status, 200);
  assert.equal((await l('POST', P, { bereich: 'SPEISE', ab: heute(), text: 'X', preis: 1 })).status, 403);
  assert.equal((await l('PUT', `${P}/101/2026-01-01`, { text: 'X', preis: 1 })).status, 403);
});
