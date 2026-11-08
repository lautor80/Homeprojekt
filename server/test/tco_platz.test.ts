/**
 * Platzbuchung (Freiplätze und Halle): Platzpflege mit Regeln, eigene Buchungen mit Preisen,
 * Isolation (fremde Buchungen nur „belegt“), Fristen, Abos nur über die Platzverwaltung.
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
const P = '/api/m/tco/platz';
const A = `${P}/admin`;
const ANNA = '0000000401';
const BERT = '0000000402';

/** heute in Oberthal + n Tage */
function tag(n: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + n, 12));
  return d.toISOString().slice(0, 10);
}

async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
const userId = async (name: string) => (await sql`select id::text as id from core.users where username = ${name}`)[0].id as string;

const HALLE = {
  name: 'Halle', art: 'HALLE', aliase: 'Tennishalle', sort: 1, gueltig_von: '2026-01-01', gueltig_bis: '9999-12-31', wochentage: '1234567',
  zeit_von: '08:00', zeit_bis: '22:00', raster: 60, dauer_min: 60, dauer_max: 120, vorlauf_min: 1, vorlauf_max: 14, storno_frist: 24,
  max_offen: 0, abrechnen: true, aktiv: true, hinweis: 'Hallenschuhe!',
};
const PLATZ1 = { ...HALLE, name: 'Platz 1', art: 'FREI', aliase: '', sort: 2, raster: 30, dauer_min: 60, dauer_max: 90, storno_frist: 2, abrechnen: false, hinweis: null };
let halleId = 0;
let platz1Id = 0;
let anna: ReturnType<typeof client>;
let bert: ReturnType<typeof client>;
let ohne: ReturnType<typeof client>;

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) values (${ANNA}, 'Anna', 'Spielerin', '2020-01-01'), (${BERT}, 'Bert', 'Spieler', '2020-01-01')`;
  // Hallenpreise: Einzel 20 €/Std. (Winter und Sommer), Abo 18 €/Std., täglich 07–23 Uhr
  for (const [key, preis] of [['001', 18], ['005', 20], ['010', 20]] as const) {
    await sql`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ) values (${key}, '2020-01-01', '9999-12-31', ${`Test ${key}`}, ${preis}, '2')`;
    for (const t of ['MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG']) {
      await sql`insert into tco.prmatrix (prod_key, valid_from, valid_to, tag, zeit_von, zeit_bis) values (${key}, '2020-01-01', '9999-12-31', ${t}, '07:00', '23:00')`;
    }
  }
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'SPIELER', name: 'Spieler', permissions: ['tco.platzbuchung:edit'] })).status, 200);
  for (const u of ['anna', 'bert', 'ohne']) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles: ['SPIELER'] })).status, 200);
  }
  anna = await anmelden('anna');
  bert = await anmelden('bert');
  ohne = await anmelden('ohne');
});
after(async () => {
  await app?.close();
  await sql.end();
});

test('Platzverwaltung: Plätze mit Regeln anlegen, Prüfungen, Benutzer zuordnen', async () => {
  let r = await admin('POST', `${A}/plaetze`, { ...HALLE, dauer_min: 45 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Vielfaches des Zeitrasters/);
  r = await admin('POST', `${A}/plaetze`, { ...HALLE, zeit_von: '22:00', zeit_bis: '08:00' });
  assert.equal(r.status, 400);
  r = await admin('POST', `${A}/plaetze`, HALLE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  halleId = r.body.id;
  r = await admin('POST', `${A}/plaetze`, PLATZ1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  platz1Id = r.body.id;
  r = await admin('POST', `${A}/plaetze`, { ...PLATZ1, name: 'halle' });
  assert.equal(r.status, 400, 'Bezeichnung eindeutig');

  // Benutzer ↔ Mitglied
  assert.equal((await admin('PUT', `${A}/benutzer`, { benutzer_id: await userId('anna'), adrnr: ANNA })).status, 200);
  assert.equal((await admin('PUT', `${A}/benutzer`, { benutzer_id: await userId('bert'), adrnr: BERT })).status, 200);
  r = await admin('PUT', `${A}/benutzer`, { benutzer_id: await userId('ohne'), adrnr: ANNA });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits dem Benutzer anna zugeordnet/);
  r = await admin('GET', `${A}/benutzer`);
  assert.equal(r.body.benutzer.find((b: { username: string }) => b.username === 'anna').adrnr, ANNA);

  // ohne Verwaltungsrecht keine Verwaltung
  assert.equal((await bert('GET', `${A}/plaetze`)).status, 403);
  assert.equal((await bert('GET', `${A}/tag?datum=${tag(1)}`)).status, 403);
});

test('ohne Mitgliedszuordnung keine Buchung', async () => {
  const r = await ohne('GET', `${P}/tag?datum=${tag(1)}`);
  assert.equal(r.status, 403);
  assert.match(r.body.message, /keinem Mitglied zugeordnet/);
});

let annaBid = '';
test('Einzelbuchung mit Preis; fremde Buchungen nur als „belegt“', async () => {
  const d = tag(3);
  let r = await anna('POST', `${P}/pruefen`, { platz_id: halleId, datum: d, von: '10:00', bis: '11:00' });
  assert.equal(r.status, 200);
  assert.equal(r.body.fehler, null);
  assert.equal(r.body.preis.betrag, 20);

  r = await anna('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '10:00', bis: '11:00', text: 'Training mit Bert' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  annaBid = r.body.bid;
  assert.match(annaBid, /^9\d{9}$/);
  const [b] = await sql`select kunde, status, preis::float8 as preis, coalesce(assigned, '') as assigned, quelle, platz from tco.bookings where bid = ${annaBid}`;
  assert.deepEqual(b, { kunde: 'ANNA SPIELERIN', status: '1', preis: 20, assigned: '', quelle: 'PORTAL', platz: 'Halle' });

  // Überschneidung
  r = await bert('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '10:00', bis: '12:00' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits belegt/);

  // Berts Kalender: nur Zeitraum, keine Details
  r = await bert('GET', `${P}/tag?datum=${d}`);
  const halle = r.body.plaetze.find((p: { id: number }) => p.id === halleId);
  assert.deepEqual(halle.belegt, [{ von: '10:00', bis: '11:00', eigen: false }]);
  assert.ok(!JSON.stringify(r.body).includes('Training mit Bert'));
  assert.ok(!JSON.stringify(r.body).includes('ANNA'));
  // Annas Kalender: eigene Buchung mit Preis
  r = await anna('GET', `${P}/tag?datum=${d}`);
  const eigen = r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt[0];
  assert.equal(eigen.eigen, true);
  assert.equal(eigen.bid, annaBid);
  assert.equal(eigen.betrag, 20);
  assert.equal(eigen.aenderbar, true);

  // fremde Buchung weder änderbar noch stornierbar
  assert.equal((await bert('PUT', `${P}/buchungen/${annaBid}`, { platz_id: halleId, datum: d, von: '12:00', bis: '13:00' })).status, 404);
  assert.equal((await bert('DELETE', `${P}/buchungen/${annaBid}`)).status, 404);
  // Admin sieht den Namen
  r = await admin('GET', `${A}/tag?datum=${d}`);
  assert.equal(r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt[0].kunde, 'ANNA SPIELERIN');
});

test('Regeln: Dauer, Raster, Vorlauf, Öffnungszeit', async () => {
  const d = tag(3);
  const fall = async (body: object, muster: RegExp) => {
    const r = await anna('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.message, muster);
  };
  await fall({ von: '14:00', bis: '17:00' }, /Höchstdauer/);
  await fall({ von: '14:30', bis: '15:30' }, /Raster/);
  await fall({ von: '21:00', bis: '23:00' }, /von 08:00 bis 22:00/);
  await fall({ datum: tag(20), von: '10:00', bis: '11:00' }, /höchstens 14 Tage/);
  await fall({ datum: tag(-1), von: '10:00', bis: '11:00' }, /Vergangenheit/);
});

test('Ändern, Freiplatz kostenfrei, Stornofrist', async () => {
  const d = tag(3);
  let r = await anna('PUT', `${P}/buchungen/${annaBid}`, { platz_id: halleId, datum: d, von: '12:00', bis: '14:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await anna('GET', `${P}/meine`);
  assert.equal(r.body.einzel.length, 1);
  assert.equal(r.body.einzel[0].von, '12:00');
  assert.equal(r.body.einzel[0].preis.betrag, 40);
  assert.equal(r.body.einzel[0].aenderbar, true);

  // Freiplatz: kostenfrei, ohne Rechnung (ASSIGNED = X)
  r = await bert('POST', `${P}/buchungen`, { platz_id: platz1Id, datum: d, von: '10:00', bis: '11:30' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [b] = await sql`select coalesce(assigned, '') as assigned from tco.bookings where bid = ${r.body.bid}`;
  assert.equal(b.assigned, 'X');
  r = await bert('GET', `${P}/meine`);
  assert.equal(r.body.einzel.length, 1, 'Bert sieht nur die eigene Buchung');
  assert.equal(r.body.einzel[0].preis.kostenfrei, true);

  // Stornofrist verlängern → Annas Buchung nicht mehr änderbar
  assert.equal((await admin('PUT', `${A}/plaetze/${halleId}`, { ...HALLE, storno_frist: 24 * 14 })).status, 200);
  r = await anna('DELETE', `${P}/buchungen/${annaBid}`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nur bis 336 Stunde/);
  assert.equal((await admin('PUT', `${A}/plaetze/${halleId}`, HALLE)).status, 200);
  r = await anna('DELETE', `${P}/buchungen/${annaBid}`);
  assert.equal(r.status, 200);
  const [s] = await sql`select status from tco.bookings where bid = ${annaBid}`;
  assert.equal(s.status, '2');
});

test('Abos nur über die Platzverwaltung', async () => {
  const ab = tag(7);
  const body = { platz_id: halleId, adrnr: ANNA, ab, bis_datum: tag(35), von: '18:00', bis: '19:00', text: 'Medenspiel-Training' };
  let r = await admin('POST', `${A}/abos/vorschau`, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.termine.length, 5);
  assert.equal(r.body.preis.betrag, 18);

  // Mitglieder können keine Abos anlegen
  assert.equal((await anna('POST', `${A}/abos`, body)).status, 403);

  r = await admin('POST', `${A}/abos`, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const aboBid = r.body.bid;
  const [n] = await sql`select count(*)::int as n from tco.bookings where bid = ${aboBid} and status = '3'`;
  assert.equal(n.n, 5);

  // zweites Abo zur gleichen Zeit: Konflikte
  r = await admin('POST', `${A}/abos`, { ...body, adrnr: BERT });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nicht frei/);

  // Anna sieht ihr Abo mit Preis, kann es aber nicht stornieren
  r = await anna('GET', `${P}/meine`);
  assert.equal(r.body.abos.length, 1);
  assert.equal(r.body.abos[0].termine, 5);
  assert.equal(r.body.abos[0].preis.betrag, 18);
  r = await anna('DELETE', `${P}/buchungen/${aboBid}`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Abos werden über die Platzverwaltung/);
  // Bert sieht den Abo-Termin nur als belegt
  r = await bert('GET', `${P}/tag?datum=${ab}`);
  assert.deepEqual(r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt, [{ von: '18:00', bis: '19:00', eigen: false }]);
  assert.equal((await bert('GET', `${P}/meine`)).body.abos.length, 0);

  // Abo beenden
  r = await admin('POST', `${A}/abos/${aboBid}/beenden`, { ab: tag(21) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /3 Termin/);
  r = await admin('GET', `${A}/abos`);
  assert.equal(r.body.find((a: { bid: string }) => a.bid === aboBid).termine, 2);
});

test('EP3-Buchungen belegen den Platz über die Aliase', async () => {
  const d = tag(4);
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, platz) values ('0000004711', ${d}, '09:00', '11:00', 'CARLA EXTERN', '1', 'Tennishalle')`;
  const r = await anna('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '10:00', bis: '11:00' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /09:00 bis 11:00 Uhr bereits belegt/);
  const t = await anna('GET', `${P}/tag?datum=${d}`);
  assert.deepEqual(t.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt, [{ von: '09:00', bis: '11:00', eigen: false }]);
});

test('EP3-Buchungen ohne Platzangabe belegen den einzigen Hallenplatz', async () => {
  const d = tag(5);
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status) values ('0000004712', ${d}, '15:00', '16:00', 'DORA EXTERN', '1')`;
  const t = await anna('GET', `${P}/tag?datum=${d}`);
  assert.deepEqual(t.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt, [{ von: '15:00', bis: '16:00', eigen: false }]);
  assert.deepEqual(t.body.plaetze.find((p: { id: number }) => p.id === platz1Id).belegt, []);
  const r = await anna('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '15:00', bis: '16:00' });
  assert.equal(r.status, 400);
});
