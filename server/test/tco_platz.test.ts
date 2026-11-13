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

test('#83: Abo mit Einzelabrechnung – Nutzer storniert einzelne Termine selbst, das Abo bleibt', async () => {
  const body = { platz_id: halleId, adrnr: ANNA, ab: tag(8), bis_datum: tag(36), von: '20:00', bis: '21:00', text: null };
  let r = await admin('POST', `${A}/abos`, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bid = r.body.bid as string;
  const [t1, t2] = (await sql`select datum::text as d from tco.bookings where bid = ${bid} order by datum`).map((x) => x.d as string);

  // Abo wird mit dem Abo abgerechnet: kein Einzelstorno
  r = await anna('DELETE', `${P}/buchungen/${bid}/termine/${t1}`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /mit dem Abo abgerechnet/);

  // als Einzelbuchungen abrechnen (Hallenabrechnung)
  await sql`insert into tco.bookings_ch (bid, status_abw) values (${bid}, '1')`;
  r = await anna('GET', `${P}/meine`);
  let abo = r.body.abos.find((a: { bid: string }) => a.bid === bid);
  assert.equal(abo.einzelabrechnung, true);
  assert.equal(abo.kommende_termine.length, 5);
  assert.ok(abo.kommende_termine.every((t: { stornierbar: boolean }) => t.stornierbar));
  assert.equal(abo.preis.betrag, 20, 'Einzelpreis je Termin');

  // fremde Nutzer: nicht gefunden
  assert.equal((await bert('DELETE', `${P}/buchungen/${bid}/termine/${t1}`)).status, 404);

  r = await anna('DELETE', `${P}/buchungen/${bid}/termine/${t1}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Abo bleibt bestehen/);
  const st = await sql`select datum::text as d, status, storno_portal is not null as portal from tco.bookings where bid = ${bid} order by datum`;
  assert.deepEqual(st.map((x) => x.status), ['2', '3', '3', '3', '3']);
  assert.equal(st[0].portal, true);
  assert.equal((await anna('DELETE', `${P}/buchungen/${bid}/termine/${t1}`)).body.message, 'Der Termin ist bereits storniert.');

  // das Abo bleibt mit 4 Terminen, der stornierte Termin steht beim Abo (nicht bei den Einzelbuchungen)
  r = await anna('GET', `${P}/meine`);
  abo = r.body.abos.find((a: { bid: string }) => a.bid === bid);
  assert.equal(abo.termine, 4);
  assert.equal(abo.storniert, 1);
  assert.equal(abo.naechster, t2);
  assert.equal(abo.kommende_termine.find((t: { datum: string }) => t.datum === t1).storniert, true);
  assert.ok(!r.body.einzel.some((e: { bid: string }) => e.bid === bid));
  // der Platz ist an dem Tag wieder frei
  r = await bert('GET', `${P}/tag?datum=${t1}`);
  assert.ok(!r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.some((b: { von: string }) => b.von === '20:00'));
  await admin('POST', `${A}/abos/${bid}/beenden`, { ab: tag(0) });
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

test('Serienbuchung (Hallenwart): Verfügbarkeit, Kombinationen, Abo über mehrere Plätze', async () => {
  for (const name of ['Platz 2', 'Platz 3']) {
    assert.equal((await admin('POST', `${A}/plaetze`, { ...PLATZ1, name })).status, 200);
  }
  const p2 = (await admin('GET', `${A}/plaetze`)).body.plaetze.find((p: { name: string }) => p.name === 'Platz 2').id;
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, platz) values ('0000004713', ${tag(15)}, '18:00', '19:00', 'EVA EXTERN', '1', 'Platz 2')`;
  const S = `${P}/serie`;
  const anfrage = { ab: tag(8), bis_datum: tag(22), von: '18:00', bis: '20:00', rhythmus: 'WOECHENTLICH', anzahl: 2, art: 'FREI' };

  // nur Hallenwart (hier: Admin), nicht Mitglieder
  assert.equal((await anna('POST', `${S}/pruefen`, anfrage)).status, 403);
  let r = await admin('POST', `${S}/pruefen`, anfrage);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.termine.length, 3);
  const v2 = r.body.plaetze.find((p: { id: number }) => p.id === p2);
  assert.equal(v2.frei, 2);
  assert.match(v2.termine[1], /belegt 18:00–19:00/);
  assert.deepEqual(r.body.kombinationen[0].namen, ['Platz 1', 'Platz 3']);
  assert.equal(r.body.kombinationen[0].vollstaendig, true);

  // monatlich am gleichen Wochentag (2. Dienstag)
  r = await admin('POST', `${S}/pruefen`, { ...anfrage, ab: '2026-11-10', bis_datum: '2027-02-28', rhythmus: 'MONATLICH', anzahl: 1 });
  assert.deepEqual(r.body.termine.map((t: { datum: string }) => t.datum), ['2026-11-10', '2026-12-08', '2027-01-12', '2027-02-09']);
  assert.match(r.body.rhythmus, /jeden 2\. Dienstag/);

  // belegter Termin ohne „auslassen“ → Fehler
  const buchung = { ...anfrage, adrnr: ANNA, text: 'Mannschaftstraining' };
  r = await admin('POST', S, { ...buchung, plaetze: [platz1Id, p2] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nicht frei/);
  r = await admin('POST', S, { ...buchung, plaetze: [platz1Id, p2], ueberspringen: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bids.length, 2);
  assert.match(r.body.text, /5 Buchung\(en\).*1 belegte Termin/);
  const rows = await sql`select status, coalesce(assigned, '') as assigned, kunde from tco.bookings where bid = any(${r.body.bids})`;
  assert.equal(rows.length, 5);
  assert.ok(rows.every((x) => x.status === '3' && x.assigned === 'X' && x.kunde === 'ANNA SPIELERIN'));
  // Anna sieht die Serien als eigene Abos
  const meine = await anna('GET', `${P}/meine`);
  assert.equal(meine.body.abos.filter((a: { bid: string }) => r.body.bids.includes(a.bid)).length, 2);

  // einmalig, vereinsintern über mehrere Stunden in der Halle → ohne Rechnung
  r = await admin('POST', S, { ab: tag(9), von: '10:00', bis: '13:00', rhythmus: 'EINMALIG', anzahl: 1, plaetze: [halleId], intern: 'Medenspiel Herren 40', ueberspringen: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [m] = await sql`select status, coalesce(assigned, '') as assigned, kunde from tco.bookings where bid = ${r.body.bids[0]}`;
  assert.deepEqual(m, { status: '1', assigned: 'X', kunde: 'MEDENSPIEL HERREN 40' });
});

test('Platzverwaltung: Massenänderung und Raster direkt', async () => {
  const plaetze = (await admin('GET', `${A}/plaetze`)).body.plaetze as { id: number; name: string; art: string; storno_frist: number; raster: number; dauer_min: number }[];
  const frei = plaetze.filter((p) => p.art === 'FREI').map((p) => p.id);
  let r = await admin('PUT', `${A}/plaetze-massen`, { ids: frei, felder: { storno_frist: 6, hinweis: 'Nur mit Sandplatzschuhen' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /3 Platz\/Plätze geändert/);
  const neu = (await admin('GET', `${A}/plaetze`)).body.plaetze.filter((p: { art: string }) => p.art === 'FREI');
  assert.ok(neu.every((p: { storno_frist: number; hinweis: string }) => p.storno_frist === 6 && p.hinweis === 'Nur mit Sandplatzschuhen'));
  // Raster 60 passt nicht zur Höchstdauer 90 → nichts gespeichert
  r = await admin('PUT', `${A}/plaetze-massen`, { ids: [frei[0]], felder: { raster: 60 } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Vielfaches des Zeitrasters/);
  r = await admin('PUT', `${A}/plaetze-massen`, { ids: [frei[0]], felder: { raster: 15 } });
  assert.equal(r.status, 200);
  // Bezeichnung lässt sich nicht per Masse ändern
  r = await admin('PUT', `${A}/plaetze-massen`, { ids: frei, felder: { name: 'X' } });
  assert.equal(r.status, 400);
  assert.equal((await bert('PUT', `${A}/plaetze-massen`, { ids: frei, felder: { aktiv: false } })).status, 403);
});

test('Sperre: ausgewählte Platzzeit ist für andere blockiert, bevor gebucht ist', async () => {
  const d = tag(4);
  const S = '/api/sperren';
  const zeit = (v: string, b: string) => ({ objekt: 'PLATZZEIT', schluessel: String(halleId), von: `${d}T${v}`, bis: `${d}T${b}`, bezeichnung: 'Halle' });
  let r = await anna('POST', S, zeit('15:00', '16:00'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const annaSperre = r.body.id as number;
  // erneut (z. B. Dialog neu gerendert): gleiche Sperre, nur verlängert
  assert.equal((await anna('POST', S, zeit('15:00', '16:00'))).body.id, annaSperre);

  // Bert: überlappende Auswahl abgelehnt – ohne Namen
  r = await bert('POST', S, zeit('15:00', '17:00'));
  assert.equal(r.status, 423);
  assert.match(r.body.message, /wird gerade von jemand anderem gebucht/);
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes('anna'));
  // angrenzende Zeit geht
  r = await bert('POST', S, zeit('16:00', '17:00'));
  assert.equal(r.status, 200);
  const bertSperre = r.body.id as number;

  // Kalender: bei Bert als „wird gerade gebucht“, bei Anna nicht (eigene Auswahl)
  r = await bert('GET', `${P}/tag?datum=${d}`);
  type B = { von: string; reserviert?: boolean };
  const res = (body: { plaetze: { id: number; belegt: B[] }[] }) => body.plaetze.find((p) => p.id === halleId)!.belegt.filter((b) => b.von >= '15:00');
  assert.deepEqual(res(r.body), [{ von: '15:00', bis: '16:00', eigen: false, reserviert: true }]);
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes('anna'));
  r = await anna('GET', `${P}/tag?datum=${d}`);
  assert.deepEqual(res(r.body), [{ von: '16:00', bis: '17:00', eigen: false, reserviert: true }]);
  // Verwaltung sieht, wer gerade bucht
  r = await admin('GET', `${A}/tag?datum=${d}`);
  assert.equal(r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.filter((b: { reserviert?: boolean }) => b.reserviert).length, 2);

  // Bert kann die von Anna ausgewählte Zeit weder prüfen noch buchen
  r = await bert('POST', `${P}/pruefen`, { platz_id: halleId, datum: d, von: '15:00', bis: '16:00' });
  assert.match(r.body.fehler, /jemand anderem/);
  r = await bert('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '15:00', bis: '16:00' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /wird gerade von jemand anderem gebucht/);
  // Anna bucht ihre Auswahl
  r = await anna('POST', `${P}/pruefen`, { platz_id: halleId, datum: d, von: '15:00', bis: '16:00' });
  assert.equal(r.body.fehler, null);
  r = await anna('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '15:00', bis: '16:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Lebenszeichen und Freigabe
  r = await anna('POST', `${S}/verlaengern`, { ids: [annaSperre, bertSperre] });
  assert.deepEqual(r.body.aktiv, [annaSperre], 'fremde Sperren werden nicht verlängert');
  assert.equal((await bert('POST', `${S}/freigeben`, { ids: [annaSperre] })).body.freigegeben, 0, 'fremde Sperre nicht freigebbar');
  assert.equal((await anna('POST', `${S}/freigeben`, { ids: [annaSperre] })).body.freigegeben, 1);
  assert.equal((await bert('POST', `${S}/freigeben`, { ids: [bertSperre] })).body.freigegeben, 1);
  r = await bert('GET', `${P}/tag?datum=${d}`);
  assert.deepEqual(res(r.body), [{ von: '15:00', bis: '16:00', eigen: false }]);

  // abgelaufene Sperre blockiert nicht mehr
  r = await anna('POST', S, zeit('18:00', '19:00'));
  await sql`update core.sperren set ablauf = now() - interval '1 second' where id = ${r.body.id}`;
  assert.equal((await bert('POST', S, zeit('18:00', '19:00'))).status, 200);
  // ohne Buchungsrecht keine Platzsperre; unbekannte Objekte abgelehnt
  const leer = client();
  assert.equal((await leer('POST', S, zeit('20:00', '21:00'))).status, 401);
  assert.equal((await bert('POST', S, { objekt: 'GIBTSNICHT', schluessel: '1' })).status, 400);
  assert.equal((await bert('POST', S, { objekt: 'MITGLIED', schluessel: ANNA })).status, 403);
});

test('Sperre: Objekt in Bearbeitung – Änderungen anderer werden in der Datenbank abgelehnt', async () => {
  assert.equal((await admin('POST', '/api/admin/users', { username: 'wart', displayName: 'Hallenwart Willi', password: 'start-passwort', roles: ['ADMIN'] })).status, 200);
  const wart = await anmelden('wart');
  const S = '/api/sperren';
  let r = await wart('POST', S, { objekt: 'PLATZ', schluessel: String(halleId), bezeichnung: 'Platz Halle' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id as number;
  // Admin will denselben Platz bearbeiten: Sperre und Speichern abgelehnt
  r = await admin('POST', S, { objekt: 'PLATZ', schluessel: String(halleId) });
  assert.equal(r.status, 423);
  assert.match(r.body.message, /Platz Halle wird gerade von Hallenwart Willi bearbeitet/);
  assert.equal(r.body.inhaber.benutzer, 'Hallenwart Willi');
  r = await admin('POST', S, { objekt: 'PLATZ', schluessel: '*' });
  assert.equal(r.status, 423, 'Tabellensperre kollidiert mit Einzelsperre');
  r = await admin('PUT', `${A}/plaetze/${halleId}`, { ...HALLE, hinweis: 'vom Admin' });
  assert.equal(r.status, 423, JSON.stringify(r.body));
  assert.match(r.body.message, /Hallenwart Willi/);
  assert.equal((await sql`select hinweis from tco.plaetze where id = ${halleId}`)[0].hinweis, 'Hallenschuhe!');
  // anderer Platz ist frei
  r = await admin('PUT', `${A}/plaetze/${platz1Id}`, { ...PLATZ1, hinweis: 'frei bearbeitbar' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Inhaber darf speichern
  r = await wart('PUT', `${A}/plaetze/${halleId}`, { ...HALLE, hinweis: 'vom Hallenwart' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Administration: Sperrliste und Aufheben
  r = await admin('GET', S);
  assert.equal(r.status, 200);
  assert.ok(r.body.some((s: { id: number; objektText: string }) => s.id === id && s.objektText === 'Platz'));
  assert.equal((await bert('GET', S)).status, 403);
  r = await admin('DELETE', `${S}/${id}`);
  assert.equal(r.status, 200);
  r = await admin('PUT', `${A}/plaetze/${halleId}`, { ...HALLE });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Abmelden gibt alle Sperren der Sitzung frei
  r = await wart('POST', S, { objekt: 'PLATZ', schluessel: '*' });
  assert.equal(r.status, 200);
  assert.equal((await admin('POST', S, { objekt: 'PLATZ', schluessel: String(platz1Id) })).status, 423);
  await wart('POST', '/api/auth/logout');
  assert.equal((await admin('POST', S, { objekt: 'PLATZ', schluessel: String(platz1Id) })).status, 200);
});

test('Registrierung: Freigabe mit Mitgliedszuordnung, Rolle Hallennutzer nur Einzelbuchung', async () => {
  const R = `${P}/registrierung`;
  const gast = client();
  let r = await gast('GET', R);
  assert.equal(r.status, 200);
  assert.equal(r.body.ep3, false, 'noch keine EP3-Kennwörter importiert');
  // Anmeldeseite kennt die Registrierung
  r = await gast('GET', '/api/settings/public');
  assert.equal(r.body.registrierung?.pfad, R);

  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, eintritt) values ('0000000403', 'Carla', 'Neu', 'carla@example.org', '2024-01-01')`;
  const eingabe = { anrede: 'Frau', strasse: 'Hauptstr. 3', plz: '66649', ort: 'Oberthal', vorname: 'Carla', nachname: 'Neu', email: 'Carla@example.org', benutzername: 'carla.neu', passwort: 'ganz-geheim-123', datenschutz: true, nachricht: 'Bin seit 2024 Mitglied' };
  assert.equal((await gast('POST', R, { ...eingabe, passwort: 'kurz' })).status, 400);
  assert.equal((await gast('POST', R, { ...eingabe, datenschutz: false })).status, 400);
  assert.equal((await gast('POST', R, { ...eingabe, benutzername: 'anna' })).status, 409, 'vorhandener Benutzer');
  r = await gast('POST', R, eingabe);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ep3, false);
  assert.equal((await gast('POST', R, eingabe)).status, 409, 'doppelte Registrierung');
  assert.equal((await gast('GET', `${R}/frei?benutzername=carla.neu`)).body.frei !== null, true);
  // noch kein Benutzer, keine Anmeldung
  assert.equal((await client()('POST', '/api/auth/login', { username: 'carla.neu', password: 'ganz-geheim-123' })).status, 401);

  // Platzverwaltung sieht die Registrierung mit Vorschlag (gleiche E-Mail und gleicher Name)
  assert.equal((await bert('GET', `${A}/registrierungen`)).status, 403);
  r = await admin('GET', `${A}/registrierungen`);
  assert.equal(r.status, 200);
  const reg = r.body.find((x: { benutzername: string }) => x.benutzername === 'carla.neu');
  assert.ok(reg);
  assert.equal(reg.vorschlaege[0].art, 'MITGLIED');
  assert.equal(reg.vorschlaege[0].schluessel, '0000000403');
  assert.ok(!JSON.stringify(r.body).includes('passwort_hash'));

  r = await admin('POST', `${A}/registrierungen/${reg.id}/bestaetigen`, { zuordnung: { art: 'MITGLIED', adrnr: '0000000403' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Rolle Hallennutzer/);
  assert.equal((await admin('POST', `${A}/registrierungen/${reg.id}/bestaetigen`, { zuordnung: { art: 'NEU' } })).status, 400, 'nur einmal');

  // genau eine Rolle mit genau einer Berechtigung
  const [u] = await sql`select id from core.users where username = 'carla.neu'`;
  assert.deepEqual((await sql`select role_id from core.user_roles where user_id = ${u.id}`).map((x) => x.role_id), ['HALLENNUTZER']);
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'HALLENNUTZER' order by 1`).map((x) => x.permission), ['tco.meinkonto:edit', 'tco.platzbuchung:edit']);
  // Rolle „nur Admin“: der Administrator kann die Rechte ändern (aber keine Administrationsrechte), löschen geht nicht
  r = await admin('PUT', '/api/admin/roles/HALLENNUTZER', { name: 'Hallennutzer', permissions: ['tco.meinkonto:edit', 'tco.platzbuchung:edit', 'tco.mitglieder:display'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'HALLENNUTZER' order by 1`).map((x) => x.permission), ['tco.meinkonto:edit', 'tco.mitglieder:display', 'tco.platzbuchung:edit']);
  assert.equal((await admin('PUT', '/api/admin/roles/HALLENNUTZER', { name: 'Hallennutzer', permissions: ['tco.platzbuchung:edit', 'core.users:display'] })).status, 400);
  assert.equal((await admin('PUT', '/api/admin/roles/HALLENNUTZER', { name: 'Hallennutzer', permissions: ['tco.meinkonto:edit', 'tco.platzbuchung:edit'] })).status, 200);
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'HALLENNUTZER' order by 1`).map((x) => x.permission), ['tco.meinkonto:edit', 'tco.platzbuchung:edit']);
  assert.equal((await admin('DELETE', '/api/admin/roles/HALLENNUTZER')).status, 400);

  // Anmeldung und Zugriff: nur Platz buchen
  const carla = client();
  r = await carla('POST', '/api/auth/login', { username: 'carla.neu', password: 'ganz-geheim-123' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await carla('GET', '/api/auth/me');
  assert.equal(r.body.user.mustChangePassword, false);
  assert.deepEqual([...r.body.permissions].sort(), ['tco.meinkonto:edit', 'tco.platzbuchung:edit']);
  r = await carla('GET', `${P}/tag?datum=${tag(2)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ich.name, 'Carla Neu');
  assert.equal((await carla('GET', `${A}/plaetze`)).status, 403);
  assert.equal((await carla('GET', `${P}/serie/stamm`)).status, 403);
  assert.equal((await carla('POST', `${A}/abos/vorschau`, {})).status, 403);
  assert.equal((await carla('GET', '/api/m/tco/mitglieder/liste?status=AKTIV')).status, 403);
  // #27: Hallennutzer mit Mitgliedszuordnung pflegt die eigenen Daten im Mitgliedsstamm
  r = await carla('GET', '/api/m/tco/meinkonto');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.quelle, 'MITGLIED');
  r = await carla('PUT', '/api/m/tco/meinkonto', { ...r.body, anrede: 'Frau', strasse: 'Neue Str. 1', plz: '66649', ort: 'Oberthal', telefon: '06854 1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [cm] = await sql`select strasse, ort, telefon, anrede from tco.mitglieder where adrnr = '0000000403'`;
  assert.deepEqual({ ...cm }, { strasse: 'Neue Str. 1', ort: 'Oberthal', telefon: '06854 1', anrede: 'Frau' });
  assert.equal((await carla('GET', '/api/admin/users')).status, 403);
  assert.equal((await carla('GET', `${A}/registrierungen`)).status, 403);
  r = await carla('POST', `${P}/buchungen`, { platz_id: platz1Id, datum: tag(2), von: '09:00', bis: '10:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('Registrierung mit EP3-Konto: Kennwort wird übernommen, Buchungen zugeordnet, Import erhält die Zuordnung', async () => {
  const { hashSync } = await import('../src/vendor/bcryptjs/index.js');
  const { ep3Importieren } = await import('../../modules/tco/server/halle/ep3.js');
  // EP3-Kundenexport mit Kennwort-Spalte (bs_users.pw, bcrypt $2y$ wie Zend\Crypt Bcrypt in ep3-bs)
  const hash = hashSync('EP3geheim!', 6).replace(/^\$2b\$/, '$2y$');
  const csv = ['ZUID;ZALIAS;STATUS;EMAIL;PW;KEY;VALUE',
    `77;dennis77;enabled;dennis@example.org;${hash};firstname;Dennis`, `77;dennis77;enabled;dennis@example.org;${hash};lastname;Gast`,
    `78;erika;enabled;erika@example.org;${hashSync('erika-pw-1', 6)};firstname;Erika`, `78;erika;enabled;erika@example.org;${hashSync('erika-pw-1', 6)};lastname;Extern`].join('\n');
  // EP3-Buchung von Dennis (Name in Großschrift, wie der Import sie anlegt) – Erika hat keine
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, platz) values ('0000007701', ${tag(5)}, '18:00', '19:00', 'DENNIS GAST', '1', 'Halle')`;
  let imp = await sql.begin((tx) => ep3Importieren(tx as never, csv));
  assert.match(imp.text, /2 Kennwörter übernommen/);

  // Import legt die Benutzer direkt an (nur mit Buchung in den letzten 12 Monaten): Anmeldename = E-Mail, Anzeigename „Nachname, Vorname“, Rolle Hallennutzer
  assert.match(imp.text, /1 Benutzer angelegt/);
  assert.match(imp.text, /1 ohne Buchung in den letzten 12 Monaten nicht übernommen/);
  assert.equal((await sql`select count(*)::int as n from core.users where username = 'erika@example.org'`)[0].n, 0, 'Erika ohne Buchung wird nicht übernommen');
  const [ud] = await sql`select id, username, display_name, must_change_password from core.users where username = 'dennis@example.org'`;
  assert.ok(ud, 'Benutzer mit E-Mail als Anmeldename');
  assert.equal(ud.display_name, 'Gast, Dennis');
  assert.equal(ud.must_change_password, false);
  assert.deepEqual((await sql`select role_id from core.user_roles where user_id = ${ud.id}`).map((x) => x.role_id), ['HALLENNUTZER']);
  assert.equal((await sql`select benutzer_id from tco.kunden where zuid = '77'`)[0].benutzer_id, ud.id);

  // Registrierung mit diesem EP3-Konto ist nicht mehr nötig – Hinweis auf vorhandenen Zugang
  const R = `${P}/registrierung`;
  const gast = client();
  assert.equal((await gast('GET', R)).body.ep3, true);
  let r = await gast('POST', R, { anrede: 'Herr', strasse: 'Am Weiher 7', plz: '66640', ort: 'Namborn', vorname: 'Dennis', nachname: 'Gast', email: 'dennis@example.org', benutzername: 'dennis.gast', datenschutz: true, ep3_konto: 'dennis77', ep3_passwort: 'falsch' });
  assert.equal(r.status, 401, 'falsches EP3-Kennwort');
  r = await gast('POST', R, { anrede: 'Herr', strasse: 'Am Weiher 7', plz: '66640', ort: 'Namborn', vorname: 'Dennis', nachname: 'Gast', email: 'dennis@example.org', benutzername: 'dennis.gast', datenschutz: true, ep3_konto: 'dennis77', ep3_passwort: 'EP3geheim!' });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /bereits einen Portalzugang/);

  // Anmeldung mit E-Mail und EP3-Kennwort; danach liegt der Hash im Portalverfahren vor
  const dennis = client();
  assert.equal((await dennis('POST', '/api/auth/login', { username: 'dennis@example.org', password: 'anderes' })).status, 401);
  r = await dennis('POST', '/api/auth/login', { username: 'Dennis@Example.org', password: 'EP3geheim!' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [u] = await sql`select password_hash from core.users where username = 'dennis@example.org'`;
  assert.match(u.password_hash, /^\$argon2/);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'dennis@example.org', password: 'EP3geheim!' })).status, 200, 'weiterhin gleiches Kennwort');
  // bucht als EP3-Kunde (Adressnummer 99…), alte EP3-Buchung ist eigene
  r = await dennis('GET', `${P}/tag?datum=${tag(5)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ich.name, 'Dennis Gast');
  const eigen = r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.find((b: { von: string }) => b.von === '18:00');
  assert.equal(eigen.eigen, true);
  assert.equal(eigen.bid, '0000007701');
  r = await dennis('GET', `${P}/meine?zeitraum=kommend`);
  assert.ok(r.body.einzel.some((e: { bid: string }) => e.bid === '0000007701'));
  assert.equal((await dennis('GET', `${A}/plaetze`)).status, 403);
  assert.equal((await dennis('GET', `${A}/registrierungen`)).status, 403);

  // erneuter Kundenimport (ohne PW-Spalte) behält Zuordnung und Kennwort, legt nichts doppelt an
  imp = await sql.begin((tx) => ep3Importieren(tx as never, ['ZUID;ZALIAS;STATUS;EMAIL;KEY;VALUE', '77;dennis77;enabled;dennis@example.org;firstname;Dennis', '77;dennis77;enabled;dennis@example.org;lastname;Gast',
    '78;erika;enabled;erika@example.org;firstname;Erika', '78;erika;enabled;erika@example.org;lastname;Extern'].join('\n')));
  assert.equal(imp.ok, true);
  assert.doesNotMatch(imp.text, /Benutzer angelegt/);
  const [k] = await sql`select benutzer_id, pw_hash from tco.kunden where zuid = '77'`;
  assert.ok(k.benutzer_id && k.pw_hash);
  assert.equal(Number((await sql`select count(*)::int as n from core.users where username like '%@example.org'`)[0].n), 1, 'nur Dennis');

  // Erika bekommt eine Buchung → „Alle mit Buchung anlegen“ legt sie an, Anmeldung mit E-Mail und EP3-Kennwort
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, platz) values ('0000007801', ${tag(-10)}, '09:00', '10:00', 'ERIKA EXTERN', '1', 'Halle')`;
  r = await admin('POST', `${A}/ep3/anlegen-alle`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.angelegt, 1);
  assert.equal((await sql`select count(*)::int as n from core.users where username = 'erika@example.org'`)[0].n, 1, JSON.stringify(r.body));
  assert.equal((await client()('POST', '/api/auth/login', { username: 'erika@example.org', password: 'erika-pw-1' })).status, 200);
  // Anmeldung per E-Mail-Adresse auch für Benutzer mit anderem Anmeldenamen (Carla aus der Registrierung)
  assert.equal((await client()('POST', '/api/auth/login', { username: 'carla@example.org', password: 'ganz-geheim-123' })).status, 200);

  // Kunde ohne Kennwort und ohne E-Mail: Alias als Anmeldename, Kennwort muss gesetzt werden; ohne Buchung bleibt er außen vor
  await sql`insert into tco.kunden (zuid, zalias, status, vorname, nachname) values ('80', 'fritz.f', 'enabled', 'Fritz', 'Fremd')`;
  r = await admin('POST', `${A}/ep3/anlegen-alle`, {});
  assert.equal(r.body.angelegt, 0);
  assert.equal(r.body.ohneBuchung, 1);
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, platz) values ('0000008001', ${tag(-3)}, '09:00', '10:00', 'FRITZ FREMD', '1', 'Halle')`;
  r = await admin('POST', `${A}/ep3/anlegen-alle`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.angelegt, 1);
  assert.equal(r.body.ohneKennwort, 1);
  const [uf] = await sql`select username, must_change_password from core.users where username = 'fritz.f'`;
  assert.equal(uf.must_change_password, true);

  // EP3-Abgleich zeigt die Zuordnungen
  r = await admin('GET', `${A}/ep3`);
  assert.equal(r.status, 200);
  assert.equal(r.body.find((x: { zuid: string }) => x.zuid === '77').benutzer, 'dennis@example.org');
  assert.equal(r.body.find((x: { zuid: string }) => x.zuid === '78').benutzer, 'erika@example.org');

  // Verknüpfen eines EP3-Kunden mit vorhandenem Mitglied-Benutzer: ZUID landet am Mitglied
  await sql`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname) values ('79', 'anna.s', 'enabled', null, 'Anna', 'Spielerin')`;
  r = await admin('GET', `${A}/ep3`);
  const k79 = r.body.find((x: { zuid: string }) => x.zuid === '79');
  assert.ok(k79.treffer.some((t: { art: string; grund: string }) => t.art === 'BENUTZER' && t.grund === 'gleicher Name'));
  r = await admin('POST', `${A}/ep3/79/verknuepfen`, { benutzer_id: await userId('anna') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select zuid from tco.mitgliedera where adrnr = ${ANNA}`)[0].zuid, '79');
});

test('Feste Belegungen (Jugendtraining) blockieren und erscheinen für alle; nur freigegebene Plätze im Kalender', async () => {
  const d = tag(6);
  const wt = String(((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1);
  // Jugendtraining wöchentlich am Wochentag von d auf Platz 1, 16–18 Uhr
  let r = await admin('POST', `${A}/feste`, { bezeichnung: 'Jugendtraining', art: 'TRAINING', plaetze: [platz1Id], wochentage: wt, datum_von: tag(0), datum_bis: tag(60), zeit_von: '16:00', zeit_bis: '18:00', hinweis: 'U12' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const festId = r.body.id;
  assert.equal((await bert('POST', `${A}/feste`, { bezeichnung: 'X', art: 'SPERRE', wochentage: '1', datum_von: d, datum_bis: d, zeit_von: '10:00', zeit_bis: '11:00' })).status, 403);
  // Sperrzeit für alle Plätze (einmalig)
  r = await admin('POST', `${A}/feste`, { bezeichnung: 'Platzpflege', art: 'SPERRE', plaetze: [], wochentage: '1234567', datum_von: d, datum_bis: d, zeit_von: '08:00', zeit_bis: '09:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await bert('GET', `${P}/tag?datum=${d}`);
  const p1 = r.body.plaetze.find((p: { id: number }) => p.id === platz1Id);
  const training = p1.belegt.find((b: { von: string }) => b.von === '16:00');
  assert.deepEqual(training, { von: '16:00', bis: '18:00', eigen: false, fest: { art: 'TRAINING', bezeichnung: 'Jugendtraining', hinweis: 'U12' } });
  assert.ok(r.body.plaetze.every((p: { belegt: { von: string; fest?: { bezeichnung: string } }[] }) => p.belegt.some((b) => b.von === '08:00' && b.fest?.bezeichnung === 'Platzpflege')), 'Sperrzeit auf allen Plätzen');
  // an einem anderen Wochentag kein Training
  r = await bert('GET', `${P}/tag?datum=${tag(7)}`);
  assert.ok(!r.body.plaetze.find((p: { id: number }) => p.id === platz1Id).belegt.some((b: { fest?: unknown }) => b.fest));

  // Buchung/Prüfung im Training abgelehnt
  r = await bert('POST', `${P}/pruefen`, { platz_id: platz1Id, datum: d, von: '17:00', bis: '18:00' });
  assert.match(r.body.fehler, /Jugendtraining/);
  r = await bert('POST', `${P}/buchungen`, { platz_id: platz1Id, datum: d, von: '16:30', bis: '17:30' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /durch „Jugendtraining“ belegt/);
  // Serienbuchung sieht das Training als belegt
  r = await admin('POST', `${P}/serie/pruefen`, { ab: d, von: '16:00', bis: '17:00', rhythmus: 'EINMALIG', anzahl: 1, plaetze: [platz1Id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.plaetze.find((p: { id: number }) => p.id === platz1Id).termine[0], /Jugendtraining/);

  // deaktivieren → wieder buchbar
  r = await admin('GET', `${A}/feste`);
  const f = r.body.liste.find((x: { id: number }) => x.id === festId);
  r = await admin('PUT', `${A}/feste/${festId}`, { ...f, aktiv: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await bert('POST', `${P}/pruefen`, { platz_id: platz1Id, datum: d, von: '17:00', bis: '18:00' });
  assert.equal(r.body.fehler, null);

  // nur freigegebene Plätze: Platz nur am Wochenende / erst ab später gültig
  const andererTag = wt === '7' ? '1' : String(Number(wt) + 1);
  r = await admin('POST', `${A}/plaetze`, { ...PLATZ1, name: 'Platz Spezial', wochentage: andererTag });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const spezial = r.body.id;
  r = await admin('POST', `${A}/plaetze`, { ...PLATZ1, name: 'Platz Zukunft', gueltig_von: tag(30) });
  const zukunft = r.body.id;
  r = await bert('GET', `${P}/tag?datum=${d}`);
  assert.ok(!r.body.plaetze.some((p: { id: number }) => p.id === spezial || p.id === zukunft), 'geschlossene Plätze ausgeblendet');
  r = await admin('GET', `${A}/tag?datum=${d}`);
  assert.ok(!r.body.plaetze.some((p: { id: number }) => p.id === spezial));
  r = await bert('GET', `${P}/tag?datum=${tag(7)}`);
  assert.ok(r.body.plaetze.some((p: { id: number }) => p.id === spezial), 'am freigegebenen Wochentag sichtbar');
  await admin('PUT', `${A}/plaetze-massen`, { ids: [spezial, zukunft], felder: { aktiv: false } });
});

test('EP3-Events werden als feste Belegungen übernommen (ersetzen sich beim nächsten Import)', async () => {
  const { ep3Importieren } = await import('../../modules/tco/server/halle/ep3.js');
  const d = tag(8);
  const csv = ['EID;PLATZ;DATETIME_START;DATETIME_END;NAME;STATUS',
    `501;Tennishalle;${d} 15:00;${d} 17:00;Jugendtraining Mittwoch;enabled`,
    `502;;${d} 07:00;${d} 08:00;Hallenreinigung;enabled`,
    `503;Unbekannter Platz;${d} 10:00;${d} 11:00;Turnier;enabled`].join('\n');
  let imp = await sql.begin((tx) => ep3Importieren(tx as never, csv));
  assert.equal(imp.typ, 'EVENTS');
  assert.match(imp.text, /2 als feste Belegungen übernommen, 1 ohne bekannten Platz/);
  let r = await bert('GET', `${P}/tag?datum=${d}`);
  const halle = r.body.plaetze.find((p: { id: number }) => p.id === halleId);
  assert.ok(halle.belegt.some((b: { von: string; fest?: { bezeichnung: string; art: string } }) => b.von === '15:00' && b.fest?.bezeichnung === 'Jugendtraining Mittwoch' && b.fest.art === 'TRAINING'));
  assert.ok(halle.belegt.some((b: { von: string; fest?: { art: string } }) => b.von === '07:00' && b.fest?.art === 'SPERRE'));
  // EP3-Belegungen sind im Portal nicht änderbar
  r = await admin('GET', `${A}/feste`);
  const ep3 = r.body.liste.find((x: { quelle: string }) => x.quelle === 'EP3');
  assert.equal((await admin('DELETE', `${A}/feste/${ep3.id}`)).status, 404);
  // erneuter Import ersetzt
  imp = await sql.begin((tx) => ep3Importieren(tx as never, ['EID;PLATZ;DATETIME_START;DATETIME_END;NAME;STATUS', `601;Halle;${d} 18:00;${d} 19:00;Training Erwachsene;enabled`].join('\n')));
  r = await admin('GET', `${A}/feste`);
  assert.deepEqual(r.body.liste.filter((x: { quelle: string }) => x.quelle === 'EP3').map((x: { ext_id: string }) => x.ext_id), ['601']);
});

test('Platz buchen für Admin/Hallenwart (#11): Namen sehen, für andere buchen, Schnuppertraining eintragen', async () => {
  const CARL = '0000000411';
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) values (${CARL}, 'Carl', 'Wart', '2020-01-01') on conflict do nothing`;
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'HALLENWART_T', name: 'Hallenwart Test', permissions: ['tco.platzbuchung:edit', 'tco.platzbuchung:verwalten'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'hwart11', displayName: 'Hallenwart 11', password: 'start-passwort', roles: ['HALLENWART_T'] })).status, 200);
  assert.equal((await admin('PUT', `${A}/benutzer`, { benutzer_id: await userId('hwart11'), adrnr: CARL })).status, 200);
  const wart = await anmelden('hwart11');
  const d = tag(11);

  let r = await bert('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '10:00', bis: '11:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Hallenwart sieht den Namen, Mitglieder weiterhin nur „belegt“
  r = await wart('GET', `${P}/tag?datum=${d}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rechte.verwalten, true);
  let b = r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.find((x: { von: string }) => x.von === '10:00');
  assert.equal(b.kunde, 'BERT SPIELER');
  assert.equal(b.eigen, false);
  r = await anna('GET', `${P}/tag?datum=${d}`);
  assert.equal(r.body.rechte.verwalten, false);
  b = r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.find((x: { von: string }) => x.von === '10:00');
  assert.deepEqual(b, { von: '10:00', bis: '11:00', eigen: false });

  // Schnuppertraining direkt im Kalender; Überschneidung abgelehnt; ohne Recht 403
  r = await wart('POST', `${P}/verwalten/belegung`, { platz_id: halleId, datum: d, von: '15:00', bis: '16:00', art: 'SCHNUPPER', bezeichnung: 'Schnuppertraining', text: 'Trainer Max' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await wart('POST', `${P}/verwalten/belegung`, { platz_id: halleId, datum: d, von: '10:30', bis: '11:30', art: 'TRAINING', bezeichnung: 'Jugendtraining' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits belegt/);
  assert.equal((await bert('POST', `${P}/verwalten/belegung`, { platz_id: halleId, datum: d, von: '17:00', bis: '18:00', art: 'SPERRE', bezeichnung: 'X' })).status, 403);
  r = await anna('GET', `${P}/tag?datum=${d}`);
  b = r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.find((x: { von: string }) => x.von === '15:00');
  assert.deepEqual(b.fest, { art: 'SCHNUPPER', bezeichnung: 'Schnuppertraining', hinweis: 'Trainer Max' });

  // Buchung für ein anderes Mitglied – erscheint bei Anna als eigene Buchung
  assert.equal((await wart('GET', `${P}/verwalten/mitglieder`)).body.some((m: { adrnr: string }) => m.adrnr === ANNA), true);
  r = await wart('POST', `${P}/verwalten/buchung`, { platz_id: halleId, datum: d, von: '12:00', bis: '13:00', adrnr: ANNA });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await anna('GET', `${P}/tag?datum=${d}`);
  b = r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.find((x: { von: string }) => x.von === '12:00');
  assert.equal(b.eigen, true);
  // für sich selbst bucht der Hallenwart wie bisher
  r = await wart('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '13:00', bis: '14:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Platzverwaltung: Schnuppertraining auch dort als Art
  r = await admin('POST', `${A}/feste`, { bezeichnung: 'Schnuppertraining Kinder', art: 'SCHNUPPER', plaetze: [], wochentage: '6', datum_von: d, datum_bis: tag(40), zeit_von: '09:00', zeit_bis: '10:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('Platzverwaltung → Belegung: freie Zeit direkt eintragen (#11)', async () => {
  const d = tag(12);
  let r = await admin('POST', `${A}/buchung`, { platz_id: halleId, datum: d, von: '08:00', bis: '10:00', intern: 'Medenspiel Damen' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${A}/buchung`, { platz_id: halleId, datum: d, von: '10:00', bis: '11:00', adrnr: ANNA, text: 'mit Bert' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${A}/belegung`, { platz_id: halleId, datum: d, von: '14:00', bis: '15:30', art: 'VERANSTALTUNG', bezeichnung: 'Vereinsturnier' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${A}/belegung`, { platz_id: halleId, datum: d, von: '09:00', bis: '09:30', art: 'SPERRE', bezeichnung: 'Sperrzeit' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits belegt/);
  assert.equal((await bert('POST', `${A}/belegung`, { platz_id: halleId, datum: d, von: '16:00', bis: '17:00', art: 'SPERRE', bezeichnung: 'X' })).status, 403);
  assert.equal((await bert('POST', `${A}/buchung`, { platz_id: halleId, datum: d, von: '16:00', bis: '17:00', intern: 'X' })).status, 403);
  r = await admin('GET', `${A}/tag?datum=${d}`);
  const halle = r.body.plaetze.find((p: { id: number }) => p.id === halleId);
  const zeiten = halle.belegt.map((b: { von: string; kunde?: string; fest?: { bezeichnung: string } }) => `${b.von} ${b.fest?.bezeichnung ?? b.kunde}`);
  assert.ok(zeiten.includes('08:00 MEDENSPIEL DAMEN'), JSON.stringify(zeiten));
  assert.ok(zeiten.includes('10:00 ANNA SPIELERIN'), JSON.stringify(zeiten));
  assert.ok(zeiten.includes('14:00 Vereinsturnier'), JSON.stringify(zeiten));
  // Anna sieht die für sie angelegte Buchung als eigene
  r = await anna('GET', `${P}/tag?datum=${d}`);
  assert.equal(r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.find((b: { von: string }) => b.von === '10:00').eigen, true);
});

test('Platzverwaltung → Belegung: Termin ändern und kopieren (#11)', async () => {
  const d = tag(13);
  const d2 = tag(14);
  let r = await admin('POST', `${A}/buchung`, { platz_id: halleId, datum: d, von: '09:00', bis: '10:00', adrnr: ANNA, text: 'Einzel' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${A}/belegung`, { platz_id: halleId, datum: d, von: '12:00', bis: '13:00', art: 'SCHNUPPER', bezeichnung: 'Schnuppertraining', text: 'Tom' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const belegt = async (datum: string) => (await admin('GET', `${A}/tag?datum=${datum}`)).body.plaetze.find((p: { id: number }) => p.id === halleId).belegt as any[];
  let liste = await belegt(d);
  const buchung = liste.find((b) => b.von === '09:00');
  assert.deepEqual([buchung.portal, buchung.abgerechnet, buchung.kunde], [true, false, 'ANNA SPIELERIN']);
  // Detail (#11): Benutzer der Buchung und Zeitpunkt/angelegt von
  assert.match(buchung.angelegt.benutzer, /\(anna\)$/, JSON.stringify(buchung.angelegt));
  assert.match(buchung.angelegt.um, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(buchung.angelegt.von, 'admin');
  const schnupper = liste.find((b) => b.von === '12:00');
  assert.equal(schnupper.fest.einmalig, true);
  assert.equal(schnupper.fest.portal, true);
  assert.ok(schnupper.fest.id > 0);

  // Buchung verschieben (ohne Buchungsregeln), Überschneidung abgelehnt
  r = await admin('PUT', `${A}/buchung/${buchung.bid}`, { alt_datum: d, platz_id: halleId, datum: d, von: '12:00', bis: '13:00' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Schnuppertraining/);
  r = await admin('PUT', `${A}/buchung/${buchung.bid}`, { alt_datum: d, platz_id: halleId, datum: d, von: '10:00', bis: '12:00', text: 'verlegt' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  liste = await belegt(d);
  assert.ok(liste.some((b) => b.bid === buchung.bid && b.von === '10:00' && b.bis === '12:00' && b.text === 'verlegt'), JSON.stringify(liste));
  assert.equal((await bert('PUT', `${A}/buchung/${buchung.bid}`, { alt_datum: d, platz_id: halleId, datum: d, von: '08:00', bis: '09:00' })).status, 403);

  // Buchung kopieren: neue Einzelbuchung für dieselbe Person, Anna sieht sie als eigene
  r = await admin('POST', `${A}/buchung/${buchung.bid}/kopie`, { alt_datum: d, platz_id: halleId, datum: d2, von: '20:00', bis: '21:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.bid, buchung.bid);
  assert.match(r.body.text, /Kopie angelegt: ANNA SPIELERIN/);
  r = await admin('POST', `${A}/buchung/${buchung.bid}/kopie`, { alt_datum: d, platz_id: halleId, datum: d2, von: '20:00', bis: '21:00' });
  assert.equal(r.status, 400, 'Überschneidung');
  r = await anna('GET', `${P}/tag?datum=${d2}`);
  const kopie = r.body.plaetze.find((p: { id: number }) => p.id === halleId).belegt.find((b: { von: string }) => b.von === '20:00');
  assert.equal(kopie.eigen, true);
  assert.equal(kopie.text, 'verlegt');

  // Schnuppertraining ändern (einzelner Tag) und kopieren
  r = await admin('PUT', `${A}/belegung/${schnupper.fest.id}`, { platz_id: halleId, datum: d, von: '13:00', bis: '14:00', art: 'SCHNUPPER', bezeichnung: 'Schnuppertraining Kinder', text: 'Tom' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${A}/belegung`, { platz_id: halleId, datum: d2, von: '13:00', bis: '14:00', art: 'SCHNUPPER', bezeichnung: 'Schnuppertraining Kinder', text: 'Tom' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  liste = await belegt(d);
  assert.ok(liste.some((b) => b.von === '13:00' && b.fest?.bezeichnung === 'Schnuppertraining Kinder'), JSON.stringify(liste));
  assert.ok((await belegt(d2)).some((b) => b.von === '13:00' && b.fest?.art === 'SCHNUPPER'));

  // auf einen anderen Tag verschieben (Buchung und Schnuppertraining)
  // nicht auf einen Samstag (wiederkehrendes Schnuppertraining 09:00–10:00)
  const d3 = [15, 16].map(tag).find((x) => new Date(`${x}T12:00:00Z`).getUTCDay() !== 6)!;
  r = await admin('PUT', `${A}/belegung/${schnupper.fest.id}`, { platz_id: halleId, datum: d3, von: '09:00', bis: '10:00', art: 'SCHNUPPER', bezeichnung: 'Schnuppertraining Kinder', text: 'Tom' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, new RegExp(`am ${d3.split('-').reverse().join('\\.')}`));
  r = await admin('PUT', `${A}/buchung/${buchung.bid}`, { alt_datum: d, platz_id: halleId, datum: d3, von: '10:00', bis: '11:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  liste = await belegt(d);
  assert.ok(!liste.some((b) => b.bid === buchung.bid || b.fest?.id === schnupper.fest.id), JSON.stringify(liste));
  const neu = await belegt(d3);
  assert.ok(neu.some((b) => b.bid === buchung.bid && b.von === '10:00'), JSON.stringify(neu));
  assert.ok(neu.some((b) => b.fest?.id === schnupper.fest.id && b.von === '09:00'), JSON.stringify(neu));

  // wiederkehrende Belegung: nur unter „Training & Sperrzeiten“ änderbar
  r = await admin('POST', `${A}/feste`, { bezeichnung: 'Wintertraining', art: 'TRAINING', plaetze: [halleId], wochentage: '1234567', datum_von: tag(40), datum_bis: tag(41), zeit_von: '08:00', zeit_bis: '09:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fid = r.body.id;
  r = await admin('PUT', `${A}/belegung/${fid}`, { platz_id: halleId, datum: tag(40), von: '09:00', bis: '10:00', art: 'TRAINING', bezeichnung: 'Wintertraining' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /wiederkehrend/);
  await admin('DELETE', `${A}/feste/${fid}`);
});

test('Halle verschlossen (#11): Hinweis ohne Hallenschlüssel, Arbeitsvorrat für den Hallenwart, Einzelbuchungen heute', async () => {
  await sql`delete from tco.schluessel where adrnr in (${ANNA}, ${BERT})`;
  const d = tag(5);
  // ohne Schlüssel: Hinweis im Kalender und bei der Buchungsbestätigung
  let r = await anna('GET', `${P}/tag?datum=${d}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.hallenhinweis, /grundsätzlich verschlossen.*Ben Hartyniuk \(\+49 1512 1594305\)/);
  r = await anna('POST', `${P}/buchungen`, { platz_id: halleId, datum: d, von: '19:00', bis: '20:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ohne = r.body.bid;
  assert.match(r.body.hinweis, /verschlossen/);
  // Freiplatz: kein Hinweis
  r = await anna('POST', `${P}/buchungen`, { platz_id: platz1Id, datum: d, von: '19:00', bis: '20:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hinweis, undefined);

  // Arbeitsvorrat: Tag „Hallenwart“ für die Buchung ohne Schlüssel, Zahl der heute erfassten Hallen-Einzelbuchungen
  r = await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const hw = r.body.find((a: any) => a.key === `HALLENWART:${ohne}:${d}`);
  assert.ok(hw, JSON.stringify(r.body.map((a: any) => a.key)));
  assert.equal(hw.bereich, 'Hallenwart');
  assert.match(hw.titel, /Halle aufsperren: .* 19:00–20:00 Uhr/);
  const heute = r.body.find((a: any) => a.key === 'HALLE_HEUTE');
  const [{ n }] = await sql`select count(*)::int as n from tco.bookings where status = '1' and erstellt = ${tag(0)} and platz = 'Halle'`;
  assert.ok(n >= 1);
  assert.match(heute.titel, new RegExp(`^Heute ${n} Hallenbuchung`));
  // Kassenwart: die einzelnen Buchungen als Unterpunkte mit Absprung in die Buchungsmaske
  assert.equal(heute.bereich, 'Kassenwart');
  assert.equal(heute.kinder.length, n);
  const kind = heute.kinder.find((k: any) => k.key === `HALLE_HEUTE:${ohne}:${d}`);
  assert.ok(kind, JSON.stringify(heute.kinder));
  assert.match(kind.titel, /19:00–20:00 Uhr · /);
  assert.equal(kind.pfad, `/tco/platzverwaltung?tab=belegung&datum=${d}`);
  assert.equal(hw.pfad, `/tco/platzverwaltung?tab=belegung&datum=${d}`);
  // Klärung mit dem Kunden bestätigen: Eintrag verschwindet, bleibt aber bei „heute erfasst“ (Kassenwart)
  assert.deepEqual(hw.erledigen, { text: 'mit dem Kunden geklärt', url: '/dashboard/arbeitsvorrat/halle-geklaert', body: { bid: ohne, datum: d } });
  assert.equal((await bert('POST', '/api/m/tco/dashboard/arbeitsvorrat/halle-geklaert', hw.erledigen.body)).status, 403);
  assert.equal((await admin('POST', '/api/m/tco/dashboard/arbeitsvorrat/halle-geklaert', { bid: 'gibtsnicht', datum: d })).status, 404);
  r = await admin('POST', '/api/m/tco/dashboard/arbeitsvorrat/halle-geklaert', hw.erledigen.body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('POST', '/api/m/tco/dashboard/arbeitsvorrat/halle-geklaert', hw.erledigen.body)).status, 200, 'doppelt bestätigen schadet nicht');
  r = await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat');
  assert.ok(!r.body.some((a: any) => a.key === `HALLENWART:${ohne}:${d}`), 'geklärt: nicht mehr im Arbeitsvorrat');
  assert.ok(r.body.find((a: any) => a.key === 'HALLE_HEUTE').kinder.some((k: any) => k.key === `HALLE_HEUTE:${ohne}:${d}`));
  await sql`delete from tco.halle_geklaert where bid = ${ohne}`;
  const rb = await bert('GET', '/api/m/tco/dashboard/arbeitsvorrat');
  assert.ok(rb.status !== 200 || !rb.body.some((a: any) => a.bereich === 'Hallenwart'), 'nur mit Platzverwaltung');

  // Schlüssel ausgegeben: kein Hinweis, kein Arbeitsvorrat-Eintrag; zurückgenommen bzw. erst später ausgegeben: wieder Hinweis
  await sql`insert into tco.schluessel (adrnr, counter, ausgabe) values (${ANNA}, 'H1', ${tag(0)})`;
  r = await anna('GET', `${P}/tag?datum=${d}`);
  assert.equal(r.body.hallenhinweis, null);
  r = await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat');
  assert.ok(!r.body.some((a: any) => a.key === `HALLENWART:${ohne}:${d}`));
  await sql`update tco.schluessel set ruecknahme = ${tag(4)} where adrnr = ${ANNA}`;
  assert.match((await anna('GET', `${P}/tag?datum=${d}`)).body.hallenhinweis, /verschlossen/);
  await sql`insert into tco.schluessel (adrnr, counter, ausgabe) values (${BERT}, 'H2', ${tag(6)})`;
  assert.match((await bert('GET', `${P}/tag?datum=${d}`)).body.hallenhinweis, /verschlossen/);
  assert.equal((await bert('GET', `${P}/tag?datum=${tag(6)}`)).body.hallenhinweis, null);
  await sql`delete from tco.schluessel where adrnr in (${ANNA}, ${BERT})`;
});

test('Meine Rechnungen: nur eigene – jüngste zuerst, aktuelle und frühere; PDF nur für eigene, gestellte', async () => {
  await sql`insert into tco.rgkopf (rgnr_txt, jahr, rgnr, kunde, betrag, status, angelegt_am, versendet, bezahlt, adrnr) values
    ('2025_007', 2025, 7, 'ANNA SPIELERIN', 40, '4', '2025-03-01', '2025-03-02', '2025-03-20', ${ANNA}),
    ('2026_003', 2026, 3, 'ANNA SPIELERIN', 24, '3', '2026-02-01', '2026-02-02', null, ${ANNA}),
    ('2026_011', 2026, 11, 'ANNA SPIELERIN', 12, '1', '2026-05-01', null, null, ${ANNA}),
    ('2026_012', 2026, 12, 'BERT SPIELER', 99, '3', '2026-05-01', '2026-05-02', null, ${BERT})`;
  let r = await anna('GET', `${P}/rechnungen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // aktuell = noch nicht versendet oder offen; bezahlte sind „frühere“
  assert.deepEqual(r.body.rechnungen.map((x: any) => [x.rgnr, x.jahr, x.betrag, x.status, x.datum, x.dokument, x.aktuell, x.entwurf]),
    [['2026_011', 2026, 12, 'noch nicht versendet', '2026-05-01', false, true, true], ['2026_003', 2026, 24, 'offen', '2026-02-02', false, true, false],
      ['2025_007', 2025, 40, 'bezahlt', '2025-03-02', false, false, false]], 'ohne fremde');
  assert.equal((await anna('GET', `${P}/rechnungen/2026_012/pdf`)).status, 404, 'fremde Rechnung');
  assert.equal((await anna('GET', `${P}/rechnungen/2026_011/pdf`)).status, 404, 'Entwurf');
  r = await anna('GET', `${P}/rechnungen/2026_003/pdf`);
  assert.equal(r.status, 404);
  assert.match(r.body.message, /kein Dokument abgelegt/);
  await sql`delete from tco.rgkopf where rgnr_txt in ('2025_007', '2026_003', '2026_011', '2026_012')`;
});

test('Abo-Bewerbung (#11): Bestätigung, Warteliste mit Position, Erinnerung, Nachrücken – ein Abo entsteht nur durch die Freigabe', async () => {
  const { withChange } = await import('../src/db.js');
  const { aboLauf } = await import('../../modules/tco/server/platz/abowunsch.js');
  const lauf = (heute: string) => withChange({ userId: null, username: 'test', action: 'ABO_LAUF' }, (tx) => aboLauf(tx, heute));
  const abos = async (kunde: string) => (await sql`select count(*)::int as n from tco.bookings where status = '3' and kunde = ${kunde} and datum >= ${tag(30)}`)[0].n as number;
  const annaId = await userId('anna');
  // Abos des Vorjahres: Anna dienstags und mittwochs 18–19 Uhr in der Halle
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, description, preis, erstellt, assigned, platz, benutzer_id, quelle) values
    ('9770000001', '2026-01-06', '18:00', '19:00', 'ANNA SPIELERIN', '3', 'Abo', 18, '2025-09-01', '', 'Halle', ${annaId}, 'PORTAL'),
    ('9770000001', '2026-01-13', '18:00', '19:00', 'ANNA SPIELERIN', '3', 'Abo', 18, '2025-09-01', '', 'Halle', ${annaId}, 'PORTAL'),
    ('9770000002', '2026-01-07', '18:00', '19:00', 'ANNA SPIELERIN', '3', 'Abo', 18, '2025-09-01', '', 'Halle', ${annaId}, 'PORTAL'),
    ('9770000009', '2026-01-08', '15:00', '17:00', 'JUGENDTRAINING', '3', 'Abo', 0, '2025-09-01', '', 'Halle', null, 'PORTAL')`;
  assert.equal((await anna('GET', `${P}/abowunsch`)).body.saison, null);
  assert.equal((await bert('POST', `${P}/abowunsch`, { platz_id: halleId, wochentag: 2, von: '18:00', bis: '20:00' })).status, 400, 'keine Saison');
  const saison = { name: 'Test 27/28', von: tag(30), bis: tag(90), bestaetigen_bis: tag(10), nachruecken_ab: tag(20), annahme_tage: 7 };
  assert.equal((await anna('POST', `${P}/admin/abosaison`, { ...saison, vorjahr_von: '2026-01-05', vorjahr_bis: '2026-01-20' })).status, 403);
  assert.equal((await admin('POST', `${P}/admin/abosaison`, { ...saison, nachruecken_ab: tag(5), vorjahr_von: '2026-01-05', vorjahr_bis: '2026-01-20' })).status, 400, 'Fristen');
  // ohne E-Mail (Rückfrage verneint): keine Ausnahme im Arbeitsvorrat
  let r = await admin('POST', `${P}/admin/abosaison`, { ...saison, vorjahr_von: '2026-01-05', vorjahr_bis: '2026-01-20', mail: false });
  assert.match(r.body.text, /ohne E-Mail/);
  assert.equal((await sql`select count(*)::int as n from tco.abo_wunsch where mail_fehler is not null`)[0].n, 0);
  r = await admin('POST', `${P}/admin/abosaison`, { ...saison, vorjahr_von: '2026-01-05', vorjahr_bis: '2026-01-20', mail: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /2 Abos des Vorjahres zur Bestätigung vorgemerkt und per E-Mail angeschrieben/);
  // Fristen sind einstellbar
  r = await admin('GET', `${P}/admin/abosaison`);
  assert.equal((await admin('PUT', `${P}/admin/abosaison/${r.body.saison.id}`, { ...saison, annahme_tage: 5 })).status, 200);

  // Anna sieht beide Abos zur Bestätigung; ohne E-Mail-Adresse steht die Ausnahme am Eintrag
  r = await anna('GET', `${P}/abowunsch`);
  assert.deepEqual(r.body.meine.map((m: any) => [m.text, m.status]), [['Dienstag 18:00–19:00 Uhr', 'OFFEN'], ['Mittwoch 18:00–19:00 Uhr', 'OFFEN']]);
  const [di, mi] = r.body.meine.map((m: any) => m.id as number);
  const fo = r.body.felder.find((f: any) => f.platz_id === halleId && f.wochentag === 2 && f.von === 1080);
  assert.deepEqual([fo.status, fo.preis], ['offen', 18], 'vor der Saison: Abo-Preis je Einheit');
  assert.equal((await sql`select count(*)::int as n from tco.abo_wunsch where mail_fehler is not null`)[0].n, 2);
  assert.equal((await anna('POST', `${P}/abowunsch/${mi}/bestaetigen`)).status, 200);
  assert.equal((await bert('POST', `${P}/abowunsch/${mi}/abgeben`)).status, 404, 'fremder Eintrag');
  assert.equal((await admin('POST', `${P}/admin/abowunsch/freigeben`, { id: di })).status, 400, 'unbestätigt wird nicht freigegeben');

  // Bert bewirbt sich für zwei Stunden am Stück; ein Nichtmitglied war früher da – Mitglieder stehen trotzdem vorn
  await sql`insert into tco.abo_wunsch (saison_id, art, adrnr, name, mitglied, platz_id, wochentag, von, bis, status, angelegt)
            select id, 'BEWERBUNG', '9900000555', 'Gabi Gast', false, ${halleId}, 2, 1080, 1140, 'WARTET', now() - interval '1 day' from tco.abo_saison where aktiv`;
  assert.equal((await bert('POST', `${P}/abowunsch`, { platz_id: halleId, wochentag: 2, von: '18:30', bis: '20:00' })).status, 400, 'volle Stunden');
  r = await bert('POST', `${P}/abowunsch`, { platz_id: halleId, wochentag: 2, von: '18:00', bis: '20:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Position 1 von 2/);
  assert.equal((await bert('POST', `${P}/abowunsch`, { platz_id: halleId, wochentag: 2, von: '19:00', bis: '20:00' })).status, 400, 'überschneidet eigene Bewerbung');
  r = await bert('GET', `${P}/abowunsch`);
  const f18 = r.body.felder.find((f: any) => f.platz_id === halleId && f.wochentag === 2 && f.von === 1080);
  const f19 = r.body.felder.find((f: any) => f.platz_id === halleId && f.wochentag === 2 && f.von === 1140);
  assert.deepEqual([f18.status, f18.wartende, f18.position, f19.status, f19.wartende, f19.position], ['bewerbung', 2, 1, 'bewerbung', 1, 1]);
  const bw = r.body.meine[0].id as number;
  assert.equal(await abos('BERT SPIELER'), 0, 'Bewerbung bucht nichts');

  // nach der Frist: Erinnerung genau einmal; vor dem Nachrück-Termin wird nichts angeboten
  assert.deepEqual(await lauf(tag(9)), { erinnert: 0, verfallen: 0, angeboten: 0 });
  // E-Mail-Pause: der automatische Lauf ruht bis einschließlich des Datums
  const sid = (await sql`select id from tco.abo_saison where aktiv`)[0].id;
  assert.equal((await admin('PUT', `${P}/admin/abosaison/${sid}`, { ...saison, annahme_tage: 5, mail_pause_bis: tag(11) })).status, 200);
  assert.deepEqual(await lauf(tag(11)), { erinnert: 0, verfallen: 0, angeboten: 0 });
  assert.equal((await admin('PUT', `${P}/admin/abosaison/${sid}`, { ...saison, annahme_tage: 5, mail_pause_bis: null })).status, 200);
  assert.deepEqual(await lauf(tag(11)), { erinnert: 1, verfallen: 0, angeboten: 0 });
  assert.deepEqual(await lauf(tag(12)), { erinnert: 0, verfallen: 0, angeboten: 0 });
  // Ausnahme im Arbeitsvorrat: Erinnerung nicht zustellbar; bestätigtes Abo wartet auf Freigabe
  r = await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const keys = JSON.stringify(r.body);
  assert.ok(keys.includes(`ABO_MAIL:${di}`) && keys.includes(`ABO_FREIGABE:${mi}`), keys.slice(0, 400));
  // Bewerbungen stehen als Gruppe im Arbeitsvorrat (Bert und der Gast)
  const bew = r.body.find((a: any) => a.key === 'ABO_BEWERBUNG');
  assert.equal(bew.kinder.length, 2);
  assert.match(bew.kinder.find((k: any) => /Bert/.test(k.titel)).text, /Position 1/);
  assert.match(bew.kinder.find((k: any) => /Gabi/.test(k.titel)).text, /Position 2/);
  // Ausnahme erledigen: Fehler gelöscht und für diesen Eintrag nicht mehr angezeigt – auch nicht nach einem weiteren Versandversuch
  assert.equal((await anna('POST', `${P}/admin/abowunsch/mail-erledigt`, { id: di })).status, 403);
  assert.equal((await admin('POST', `${P}/admin/abowunsch/mail-erledigt`, { id: di })).status, 200);
  assert.ok(!JSON.stringify((await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat')).body).includes('ABO_MAIL'));
  assert.deepEqual((await sql`select mail_fehler, mail_ignorieren from tco.abo_wunsch where id = ${di}`)[0], { mail_fehler: null, mail_ignorieren: true });

  // Nachrück-Termin: Annas unbestätigter Dienstag verfällt, Bert (Mitglied) bekommt das Angebot, der Gast wartet weiter
  assert.deepEqual(await lauf(tag(20)), { erinnert: 0, verfallen: 1, angeboten: 1 });
  assert.deepEqual(await lauf(tag(20)), { erinnert: 0, verfallen: 0, angeboten: 0 });
  assert.equal((await sql`select status from tco.abo_wunsch where id = ${bw}`)[0].status, 'ANGEBOTEN');
  assert.equal((await sql`select status from tco.abo_wunsch where name = 'Gabi Gast'`)[0].status, 'WARTET');
  assert.equal((await admin('POST', `${P}/admin/abowunsch/freigeben`, { id: bw })).status, 400, 'Angebot noch nicht angenommen');
  assert.equal((await bert('POST', `${P}/abowunsch/${bw}/annehmen`)).status, 200);
  assert.equal(await abos('BERT SPIELER'), 0, 'auch die Annahme bucht nichts');

  // erst die Freigabe legt das Abo für die ganze Saison an
  r = await admin('POST', `${P}/admin/abowunsch/freigeben`, { id: bw });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await abos('BERT SPIELER')) >= 7);
  const [b] = await sql`select to_char(time_start, 'HH24:MI') as von, to_char(time_ende, 'HH24:MI') as bis, min(datum)::text as erster, max(datum)::text as letzter
                          from tco.bookings where status = '3' and kunde = 'BERT SPIELER' and datum >= ${tag(30)} group by 1, 2`;
  assert.deepEqual([b.von, b.bis], ['18:00', '20:00']);
  assert.ok(b.erster >= tag(30) && b.letzter <= tag(90));
  assert.equal((await admin('POST', `${P}/admin/abowunsch/freigeben`, { id: mi })).status, 200);
  assert.ok((await abos('ANNA SPIELERIN')) >= 7);
  assert.equal((await admin('POST', `${P}/admin/abowunsch/freigeben`, { id: mi })).status, 400, 'nicht doppelt');
  // abgelaufenes Angebot verfällt nach der Annahmefrist (hier: der Gast rückt nicht nach, weil die Stunde vergeben ist)
  assert.deepEqual(await lauf(tag(40)), { erinnert: 0, verfallen: 0, angeboten: 0 });
  await sql`delete from tco.bookings where bid in ('9770000001', '9770000002', '9770000009') or (status = '3' and datum >= ${tag(30)} and kunde in ('BERT SPIELER', 'ANNA SPIELERIN'))`;
  await sql`delete from tco.abo_saison`;

  // ---- unterjährig: Saison läuft bereits – keine Vormerkung, laufende Abos sind vergeben, freie Stunden zum Einzelpreis je Einheit
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, description, preis, erstellt, assigned, platz, benutzer_id, quelle)
            select '9770000003', d::date, '10:00', '11:00', 'ANNA SPIELERIN', '3', 'Abo', 18, '2026-01-01', '', 'Halle', ${annaId}::uuid, 'PORTAL'
              from generate_series(${tag(20)}::date, ${tag(41)}::date, interval '7 days') d`;
  const laeuft = { name: 'Test laufend', von: tag(-30), bis: tag(45), bestaetigen_bis: tag(-60), nachruecken_ab: tag(-50), annahme_tage: 7 };
  r = await admin('POST', `${P}/admin/abosaison`, { ...laeuft, vorjahr_von: '2026-01-05', vorjahr_bis: '2026-01-20', mail: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /keine Abos zur Bestätigung vorgemerkt/);
  const wt = ((new Date(`${tag(20)}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  r = await bert('GET', `${P}/abowunsch`);
  assert.equal(r.body.unterjaehrig, true);
  const zelle = r.body.felder.find((f: any) => f.platz_id === halleId && f.wochentag === wt && f.von === 660);
  assert.equal(zelle.preis, 20, 'unterjährig: Einzelpreis');
  assert.ok(zelle.einheiten >= 1 && zelle.einheiten <= 7 && zelle.gesamt === zelle.einheiten * 20, `Gesamtwert = Einheiten × Einzelpreis: ${JSON.stringify(zelle)}`);
  // feste Belegung (Jugendtraining) über die ganze Saison: Stunde ist gesperrt und nicht bewerbbar; Training wird nicht vorgemerkt
  await sql`insert into tco.platzbelegungen (bezeichnung, art, plaetze, wochentage, datum_von, datum_bis, zeit_von, zeit_bis, aktiv, quelle)
            values ('Jugendtraining Abo-Test', 'TRAINING', ${[halleId]}, ${String(wt)}, ${tag(-30)}, ${tag(45)}, '15:00', '17:00', true, 'PORTAL')`;
  const g = (await bert('GET', `${P}/abowunsch`)).body.felder.find((f: any) => f.platz_id === halleId && f.wochentag === wt && f.von === 900);
  assert.deepEqual([g.status, g.hinweis], ['gesperrt', 'Jugendtraining Abo-Test']);
  assert.equal((await bert('POST', `${P}/abowunsch`, { platz_id: halleId, wochentag: wt, von: '16:00', bis: '18:00' })).status, 400, 'fest belegt');
  await sql`delete from tco.platzbelegungen where bezeichnung = 'Jugendtraining Abo-Test'`;
  assert.equal(r.body.felder.find((f: any) => f.platz_id === halleId && f.wochentag === wt && f.von === 600).status, 'vergeben', 'laufendes Abo');
  assert.equal((await anna('GET', `${P}/abowunsch`)).body.felder.find((f: any) => f.platz_id === halleId && f.wochentag === wt && f.von === 600).status, 'freigegeben');
  // Bert bewirbt sich auf die freie Stunde danach und – als Warteliste – auf Annas Stunde
  r = await bert('POST', `${P}/abowunsch`, { platz_id: halleId, wochentag: wt, von: '11:00', bis: '12:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Unterjährig ab .* Einheit(en)? zum Einzelpreis = /);
  // schon die wartende Bewerbung reserviert die Stunde: keine Einzelbuchung mehr, Anzeige „reserviert“
  const naechster = [1, 2, 3, 4, 5, 6, 7].map((n) => tag(n)).find((d) => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1 === wt)!;
  assert.match((await anna('POST', `${P}/pruefen`, { platz_id: halleId, datum: naechster, von: '11:00', bis: '12:00' })).body.fehler, /für ein Abo reserviert/, 'Warteliste reserviert');
  assert.equal((await bert('POST', `${P}/abowunsch`, { platz_id: halleId, wochentag: wt, von: '10:00', bis: '11:00' })).status, 200);
  r = await admin('POST', `${P}/admin/abosaison/lauf`, { mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.angeboten, 1, 'nur die freie Stunde – Annas Abo läuft');
  const frei = (await sql`select id from tco.abo_wunsch where status = 'ANGEBOTEN'`)[0].id as number;
  // während der Reservierung (Angebot läuft / angenommen): keine Einzelbuchung auf dieser Zeit, Anzeige „reserviert“
  const termine: string[] = [];
  for (let n = 1; n <= 45; n++) if (((new Date(`${tag(n)}T12:00:00Z`).getUTCDay() + 6) % 7) + 1 === wt) termine.push(tag(n));
  r = await anna('POST', `${P}/pruefen`, { platz_id: halleId, datum: termine[0], von: '11:00', bis: '12:00' });
  assert.match(r.body.fehler, /für ein Abo reserviert/);
  assert.equal((await anna('POST', `${P}/buchungen`, { platz_id: halleId, datum: termine[0], von: '11:00', bis: '12:00' })).status, 400, 'reserviert');
  r = await anna('GET', `${P}/tag?datum=${termine[0]}`);
  assert.ok(JSON.stringify(r.body).includes('"abo":true'), 'Anzeige als reserviert');
  assert.equal((await bert('POST', `${P}/abowunsch/${frei}/annehmen`)).status, 200);
  // eine bestehende Einzelbuchung in der Folgewoche: das Abo beginnt erst in der Woche danach
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, description, preis, erstellt, assigned, platz, quelle)
            values ('9770000009', ${termine[0]}, '11:00', '12:00', 'CARLA EINZEL', '1', 'Einzel', 20, '2026-01-01', '', 'Halle', 'PORTAL')`;
  // der Restwert rechnet ab der Woche nach der Einzelbuchung
  const de = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  r = await admin('GET', `${P}/admin/abosaison`);
  assert.ok(String(r.body.wuensche.find((x: any) => x.id === frei).kosten).startsWith(`ab ${de(termine[1])}: `), JSON.stringify(r.body.wuensche.find((x: any) => x.id === frei)));
  r = await admin('POST', `${P}/admin/abowunsch/freigeben`, { id: frei });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Beginn erst am .* weil bis .* noch Einzelbuchungen bestehen/);
  assert.equal((await sql`select min(datum)::text as d from tco.bookings where status = '3' and kunde = 'BERT SPIELER'`)[0].d, termine[1], 'Beginn in der Woche nach der Einzelbuchung');
  await sql`delete from tco.bookings where bid = '9770000009'`;
  assert.match(r.body.text, /Unterjährig: \d+ Einheit(en)? zum Einzelpreis = /);
  const neu = await sql`select b.datum::text as datum, b.preis::float8 as preis, c.status_abw from tco.bookings b left join tco.bookings_ch c on c.bid = b.bid
                         where b.status = '3' and b.kunde = 'BERT SPIELER' order by b.datum`;
  assert.ok(neu.length >= 1 && neu.length <= 7, String(neu.length));
  assert.ok(neu.every((x) => x.preis === 20 && x.status_abw === '1' && x.datum <= tag(45) && x.datum >= tag(0)), JSON.stringify(neu));
  await sql`delete from tco.bookings_ch where bid in (select bid from tco.bookings where kunde = 'BERT SPIELER' and status = '3')`;
  await sql`delete from tco.bookings where bid = '9770000003' or (status = '3' and kunde = 'BERT SPIELER')`;
  await sql`delete from tco.abo_saison`;
});

test('Arbeitsvorrat Kassenwart: Upload mit Folgeaktion „Überweisung an Einreicher“ – Gruppe mit Dokumenten, erledigen', async () => {
  const { withChange } = await import('../src/db.js');
  const { uploadMerken, istUeberweisungEinreicher } = await import('../../modules/tco/server/upload/logik.js');
  assert.deepEqual([istUeberweisungEinreicher('Überweisung an Einreicher'), istUeberweisungEinreicher('Bezahlen')], [true, false]);
  await withChange({ userId: null, username: 'test', action: 'UPLOAD' }, async (tx) => {
    await uploadMerken(tx, { dok_id: 4711, titel: 'Bälle Sport Müller', datei: 'baelle.pdf', folgeaktion: 'Überweisung an Einreicher', einreicher: 'Anna Spielerin' });
    await uploadMerken(tx, { dok_id: null, titel: '', datei: 'netz.pdf', folgeaktion: 'Überweisung an Einreicher', einreicher: 'Bert Spieler' });
    await uploadMerken(tx, { dok_id: 4712, titel: 'Stromrechnung', datei: 'strom.pdf', folgeaktion: 'Bezahlen', einreicher: 'Bert Spieler' });
    await uploadMerken(tx, { dok_id: 4713, titel: 'Ablage', datei: 'x.pdf', folgeaktion: '', einreicher: 'Bert Spieler' });
  });
  const A = '/api/m/tco/dashboard/arbeitsvorrat';
  let r = await admin('GET', A);
  const g = r.body.find((a: any) => a.key === 'UPLOAD_UEBERWEISUNG');
  assert.equal(g.bereich, 'Kassenwart');
  assert.match(g.titel, /^2 neue Dokumente: Überweisung an Einreicher/);
  assert.deepEqual(g.kinder.map((k: any) => k.titel), ['Überweisung an Anna Spielerin: Bälle Sport Müller', 'Überweisung an Bert Spieler: netz.pdf']);
  assert.match(g.kinder[0].text, /Dokument 4711/);
  // Zahlungsdaten und QR-Code: Bankverbindung des Einreichers aus dem Mitgliederstamm
  assert.deepEqual(g.kinder.map((k: any) => typeof k.zahlung?.id), ['number', 'number']);
  const Z = `${A}/upload-zahlung/${g.kinder[0].zahlung.id}`;
  assert.equal((await anna('GET', Z)).status, 403);
  let z = await admin('GET', Z);
  assert.equal(z.status, 200, JSON.stringify(z.body));
  assert.ok('qr' in z.body && 'empfaenger' in z.body && z.body.titel === 'Bälle Sport Müller');
  // Einreicher mit Benutzer und Bankverbindung im Mitgliederstamm
  const [einreicher] = await sql`insert into core.users (username, display_name, password_hash) values ('vera.vorstand', 'Vera Vorstand', 'x') returning id`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, iban1, bic1, bank1) values ('0000009901', 'Vera', 'Vorstand', '2010-01-01', 'DE89 3704 0044 0532 0130 00', 'COBADEFFXXX', 'Commerzbank')`;
  await sql`insert into tco.mitgliedera (adrnr, benutzer_id) values ('0000009901', ${einreicher.id}) on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id`;
  await withChange({ userId: null, username: 'test', action: 'UPLOAD' }, async (tx) => {
    await uploadMerken(tx, { dok_id: 4720, titel: 'Pokale Sporthaus', datei: 'pokale.pdf', folgeaktion: 'Überweisung an Einreicher', einreicher: 'Vera Vorstand', benutzer_id: einreicher.id });
  });
  const [vf] = await sql`select id from tco.upload_folge where dok_id = 4720`;
  z = await admin('GET', `${A}/upload-zahlung/${vf.id}`);
  assert.equal(z.status, 200, JSON.stringify(z.body));
  assert.deepEqual([z.body.empfaenger, z.body.iban, z.body.iban_text, z.body.bic, z.body.betrag, z.body.zweck],
    ['Vera Vorstand', 'DE89370400440532013000', 'DE89 3704 0044 0532 0130 00', 'COBADEFFXXX', null, 'Erstattung Pokale Sporthaus']);
  assert.equal(z.body.epc, 'BCD\n002\n1\nSCT\nCOBADEFFXXX\nVera Vorstand\nDE89370400440532013000\n\n\n\nErstattung Pokale Sporthaus');
  assert.match(z.body.qr, /^data:image\/png;base64,/);
  z = await admin('GET', `${A}/upload-zahlung/${vf.id}?betrag=1.249,90&zweck=${encodeURIComponent('Pokale Vereinsmeisterschaft')}`);
  assert.deepEqual([z.body.betrag, z.body.hinweis], [1249.9, null]);
  assert.equal(z.body.epc, 'BCD\n002\n1\nSCT\nCOBADEFFXXX\nVera Vorstand\nDE89370400440532013000\nEUR1249.90\n\n\nPokale Vereinsmeisterschaft');
  assert.equal((await admin('GET', `${A}/upload-zahlung/${vf.id}?betrag=abc`)).status, 400);
  assert.equal((await admin('GET', `${A}/upload-zahlung/999999`)).status, 404);
  // ungültige IBAN: Daten ja, QR-Code nein
  await sql`update tco.mitglieder set iban1 = 'DE00123' where adrnr = '0000009901'`;
  z = await admin('GET', `${A}/upload-zahlung/${vf.id}`);
  assert.deepEqual([z.body.qr, z.body.empfaenger], [null, 'Vera Vorstand']);
  assert.match(z.body.hinweis, /IBAN im Mitgliederstamm ist ungültig/);
  // Einreicher ohne Portal-Benutzer: über den Namen des Mitglieds; sonst von Hand gewähltes Mitglied (Live-Suche)
  await sql`update tco.mitglieder set iban1 = 'DE89370400440532013000' where adrnr = '0000009901'`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, iban1) values ('0000009902', 'Karl', 'Kasse', '2010-01-01', 'DE02120300000000202051')`;
  await withChange({ userId: null, username: 'test', action: 'UPLOAD' }, async (tx) => {
    await uploadMerken(tx, { dok_id: 4721, titel: 'Netze', datei: 'netze.pdf', folgeaktion: 'Überweisung an Einreicher', einreicher: 'Kasse, Karl' });
    await uploadMerken(tx, { dok_id: 4722, titel: 'Linien', datei: 'linien.pdf', folgeaktion: 'Überweisung an Einreicher', einreicher: 'Niemand Bekannt' });
  });
  const [kf] = await sql`select id from tco.upload_folge where dok_id = 4721`;
  const [nf] = await sql`select id from tco.upload_folge where dok_id = 4722`;
  z = await admin('GET', `${A}/upload-zahlung/${kf.id}`);
  assert.deepEqual([z.body.empfaenger, z.body.adrnr, z.body.iban], ['Karl Kasse', '0000009902', 'DE02120300000000202051'], 'Name des Mitglieds genügt');
  z = await admin('GET', `${A}/upload-zahlung/${nf.id}`);
  assert.deepEqual([z.body.empfaenger, z.body.qr], [null, null]);
  assert.match(z.body.hinweis, /keinem Mitglied eindeutig zuordnen – bitte das Mitglied wählen/);
  z = await admin('GET', `${A}/upload-zahlung/${nf.id}?adrnr=0000009901`);
  assert.deepEqual([z.body.empfaenger, z.body.adrnr, z.body.einreicher], ['Vera Vorstand', '0000009901', 'Niemand Bekannt']);
  assert.match(z.body.qr, /^data:image\/png;base64,/);
  assert.equal((await admin('GET', `${A}/upload-zahlung/${nf.id}?adrnr=0000000000`)).status, 404);
  const suche = await admin('GET', '/api/m/tco/fi/ueberweisungen/mitglieder?q=kas%20karl');
  assert.equal(suche.status, 200, JSON.stringify(suche.body));
  assert.deepEqual(suche.body.map((m: any) => [m.adrnr, m.name]), [['0000009902', 'Karl Kasse']]);
  assert.deepEqual((await admin('GET', '/api/m/tco/fi/ueberweisungen/mitglieder?q=')).body, []);
  assert.equal((await anna('GET', '/api/m/tco/fi/ueberweisungen/mitglieder?q=karl')).status, 403);
  await sql`delete from tco.upload_folge where dok_id in (4720, 4721, 4722)`;
  assert.equal((await anna('POST', `${A}/upload-erledigt`, g.kinder[0].erledigen.body)).status, 403);
  assert.equal((await admin('POST', `${A}/upload-erledigt`, g.kinder[0].erledigen.body)).status, 200);
  r = await admin('GET', A);
  assert.match(r.body.find((a: any) => a.key === 'UPLOAD_UEBERWEISUNG').titel, /^1 neues Dokument/);
  assert.equal((await admin('POST', `${A}/upload-erledigt`, {})).status, 200);
  assert.ok(!(await admin('GET', A)).body.some((a: any) => a.key === 'UPLOAD_UEBERWEISUNG'));
  assert.equal((await sql`select count(*)::int as n from tco.upload_folge where erledigt_am is null`)[0].n, 1, 'andere Folgeaktionen bleiben unberührt');
  await sql`delete from tco.upload_folge`;
});
