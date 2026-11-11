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
