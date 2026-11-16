/**
 * Checklisten für Veranstaltungen: Terminbezug und Stand (reine Funktionen), Pflege über die Schnittstellen,
 * Gültigkeit für mehrere Veranstaltungen mit eigenem Stand, Kopieren von Checklisten und Schritten, PDF, Rechte.
 *
 * Eigene Testdaten: Veranstaltungen „CL-Test …“ im Jahr 2090, Kategorien „CL-Test …“.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { faelligAm, fortschritt, kopieTitel, stand, terminText } from '../../modules/tco/server/checklisten/logik.js';

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
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, roh: res.rawPayload, typ: ct };
  };
}
const call = client();
const C = '/api/m/tco/checklisten';
let ev1 = 0, ev2 = 0;

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await call('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  [{ id: ev1 }] = await sql`insert into tco.kal_events (titel, ort, beginn) values ('CL-Test Sommerfest', 'Clubhaus', '2090-07-15 14:00+02') returning id`;
  [{ id: ev2 }] = await sql`insert into tco.kal_events (titel, beginn) values ('CL-Test Herbstturnier', '2090-09-20 09:00+02') returning id`;
});
after(async () => {
  await app?.close();
  await sql.end();
});

// ---------------------------------------------------------------------------
// reine Funktionen
// ---------------------------------------------------------------------------

test('Fälligkeit: relativ zum Termin, festes Datum geht vor, ohne Angabe offen', () => {
  assert.equal(faelligAm({ tage_vor: 14, faellig: null }, '2090-07-15'), '2090-07-01');
  assert.equal(faelligAm({ tage_vor: 0, faellig: null }, '2090-07-15'), '2090-07-15');
  assert.equal(faelligAm({ tage_vor: -3, faellig: null }, '2090-07-30'), '2090-08-02');
  assert.equal(faelligAm({ tage_vor: 14, faellig: '2090-05-01' }, '2090-07-15'), '2090-05-01');
  assert.equal(faelligAm({ tage_vor: null, faellig: null }, '2090-07-15'), null);
  assert.equal(faelligAm({ tage_vor: 14, faellig: null }, null), null);
});

test('Terminbezug in Worten', () => {
  assert.equal(terminText({ tage_vor: 14, faellig: null }), '14 Tage vorher');
  assert.equal(terminText({ tage_vor: 1, faellig: null }), '1 Tag vorher');
  assert.equal(terminText({ tage_vor: 0, faellig: null }), 'am Tag der Veranstaltung');
  assert.equal(terminText({ tage_vor: -2, faellig: null }), '2 Tage danach');
  assert.equal(terminText({ tage_vor: null, faellig: '2090-03-01' }), 'bis 01.03.2090');
  assert.equal(terminText({ tage_vor: null, faellig: null }), '');
});

test('Stand eines Schritts und Fortschritt', () => {
  assert.equal(stand(true, '2090-01-01', '2090-06-01'), 'ERLEDIGT');
  assert.equal(stand(false, '2090-05-31', '2090-06-01'), 'UEBERFAELLIG');
  assert.equal(stand(false, '2090-06-01', '2090-06-01'), 'BALD');
  assert.equal(stand(false, '2090-06-08', '2090-06-01'), 'BALD');
  assert.equal(stand(false, '2090-06-09', '2090-06-01'), 'OFFEN');
  assert.equal(stand(false, null, '2090-06-01'), 'OFFEN');
  assert.deepEqual(fortschritt(['ERLEDIGT', 'UEBERFAELLIG', 'BALD', 'OFFEN', 'ERLEDIGT']), { gesamt: 5, erledigt: 2, ueberfaellig: 1, bald: 1 });
});

test('Titel einer Kopie ist frei', () => {
  assert.equal(kopieTitel('Sommerfest', ['Sommerfest']), 'Sommerfest (Kopie)');
  assert.equal(kopieTitel('Sommerfest', ['Sommerfest', 'sommerfest (kopie)']), 'Sommerfest (Kopie 2)');
  assert.equal(kopieTitel('Sommerfest (Kopie)', ['Sommerfest', 'Sommerfest (Kopie)']), 'Sommerfest (Kopie 2)');
});

// ---------------------------------------------------------------------------
// Pflege über die Schnittstellen
// ---------------------------------------------------------------------------

let kat = 0, cl = 0, s1 = 0, s2 = 0, s3 = 0;

test('Kategorien: anlegen, doppelte abgelehnt, umbenennen', async () => {
  let r = await call('POST', `${C}/kategorien`, { name: 'CL-Test Vereinsfest' });
  assert.equal(r.status, 200);
  kat = r.body.id;
  r = await call('POST', `${C}/kategorien`, { name: 'cl-test vereinsfest' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /gibt es schon/);
  r = await call('POST', `${C}/kategorien`, { id: kat, name: 'CL-Test Feste', aktiv: true });
  assert.equal(r.status, 200);
  const d = (await call('GET', C)).body;
  assert.deepEqual(d.kategorien.map((k: any) => k.name), ['CL-Test Feste']);
  assert.equal(d.pflege, true);
  assert.ok(d.events.some((e: any) => e.id === ev1 && e.termin === '2090-07-15'));
});

test('Checkliste mit verantwortlicher Person und Schritten', async () => {
  const [admin] = await sql`select id from core.users where username = 'admin'`;
  let r = await call('POST', C, { titel: 'CL-Test Sommerfest vorbereiten', kategorie_id: kat, verantwortlich: 'Admin', verantwortlich_id: admin.id, beschreibung: 'Ablauf wie jedes Jahr' });
  assert.equal(r.status, 200);
  cl = r.body.id;
  s1 = (await call('POST', `${C}/${cl}/schritte`, { titel: 'Getränke bestellen', tage_vor: 14, verantwortlich: 'Thekenwart' })).body.id;
  s2 = (await call('POST', `${C}/${cl}/schritte`, { titel: 'Zelt aufbauen', tage_vor: 1, beschreibung: 'Zelt liegt im Geräteraum' })).body.id;
  s3 = (await call('POST', `${C}/${cl}/schritte`, { titel: 'Abrechnung an den Kassenwart', tage_vor: -7 })).body.id;
  r = await call('POST', `${C}/${cl}/schritte`, { titel: 'beides', tage_vor: 3, faellig: '2090-01-01' });
  assert.equal(r.status, 400);
  const c = (await call('GET', `${C}/${cl}`)).body;
  assert.equal(c.kategorie, 'CL-Test Feste');
  assert.equal(c.verantwortlich, 'Admin');
  assert.equal(c.verantwortlich_id, admin.id);
  assert.deepEqual(c.schritte.map((s: any) => [s.titel, s.termin_text]), [
    ['Getränke bestellen', '14 Tage vorher'], ['Zelt aufbauen', '1 Tag vorher'], ['Abrechnung an den Kassenwart', '7 Tage danach'],
  ]);
  assert.deepEqual(c.bezuege, []);
});

test('Reihenfolge der Schritte ändern; unvollständige Liste wird abgelehnt', async () => {
  let r = await call('POST', `${C}/${cl}/reihenfolge`, { schritte: [s2, s1] });
  assert.equal(r.status, 409);
  r = await call('POST', `${C}/${cl}/reihenfolge`, { schritte: [s2, s1, s3] });
  assert.equal(r.status, 200);
  assert.deepEqual((await call('GET', `${C}/${cl}`)).body.schritte.map((s: any) => s.id), [s2, s1, s3]);
  await call('POST', `${C}/${cl}/reihenfolge`, { schritte: [s1, s2, s3] });
});

test('gültig für mehrere Veranstaltungen: Fälligkeit und Stand je Veranstaltung', async () => {
  let r = await call('POST', `${C}/${cl}/bezuege`, { events: [ev1, ev2] });
  assert.equal(r.body.anzahl, 2);
  r = await call('POST', `${C}/${cl}/bezuege`, { events: [ev1] });
  assert.equal(r.body.anzahl, 0, 'dieselbe Veranstaltung nicht doppelt');
  let c = (await call('GET', `${C}/${cl}`)).body;
  assert.deepEqual(c.bezuege.map((b: any) => [b.titel, b.termin, b.ort]), [['CL-Test Sommerfest', '2090-07-15', 'Clubhaus'], ['CL-Test Herbstturnier', '2090-09-20', null]]);
  const [b1, b2] = c.bezuege;
  assert.deepEqual(b1.schritte.map((z: any) => z.faellig), ['2090-07-01', '2090-07-14', '2090-07-22']);
  assert.deepEqual(b2.schritte.map((z: any) => z.faellig), ['2090-09-06', '2090-09-19', '2090-09-27']);

  // abhaken nur für das Sommerfest – das Herbstturnier bleibt offen
  r = await call('POST', `${C}/bezuege/${b1.id}/schritte/${s1}`, { erledigt: true, notiz: 'bei Getränke Müller' });
  assert.equal(r.status, 200);
  c = (await call('GET', `${C}/${cl}`)).body;
  assert.deepEqual(c.bezuege[0].fortschritt, { gesamt: 3, erledigt: 1, ueberfaellig: 0, bald: 0 });
  assert.equal(c.bezuege[0].schritte[0].stand, 'ERLEDIGT');
  assert.equal(c.bezuege[0].schritte[0].erledigt.von, 'Admin');
  assert.equal(c.bezuege[0].schritte[0].erledigt.notiz, 'bei Getränke Müller');
  assert.equal(c.bezuege[1].fortschritt.erledigt, 0);
  // wieder öffnen
  await call('POST', `${C}/bezuege/${b1.id}/schritte/${s1}`, { erledigt: false });
  assert.equal((await call('GET', `${C}/${cl}`)).body.bezuege[0].fortschritt.erledigt, 0);
  await call('POST', `${C}/bezuege/${b1.id}/schritte/${s1}`, { erledigt: true });
});

test('überfällig: Schritt eines vergangenen freien Termins', async () => {
  const r = await call('POST', `${C}/${cl}/bezuege`, { termin: '2020-05-10', bezeichnung: 'CL-Test Altes Fest' });
  assert.equal(r.body.anzahl, 1);
  const c = (await call('GET', `${C}/${cl}`)).body;
  const alt = c.bezuege[0];
  assert.equal(alt.titel, 'CL-Test Altes Fest');
  assert.equal(alt.event_id, null);
  assert.deepEqual(alt.schritte.map((z: any) => z.stand), ['UEBERFAELLIG', 'UEBERFAELLIG', 'UEBERFAELLIG']);
  assert.equal(alt.fortschritt.ueberfaellig, 3);
  assert.equal((await call('DELETE', `${C}/bezuege/${alt.id}`)).status, 200);
  assert.equal((await call('GET', `${C}/${cl}`)).body.bezuege.length, 2);
});

test('fremder Schritt lässt sich für eine Veranstaltung nicht abhaken', async () => {
  const andere = (await call('POST', C, { titel: 'CL-Test Andere' })).body.id;
  const fremd = (await call('POST', `${C}/${andere}/schritte`, { titel: 'Fremder Schritt' })).body.id;
  const b1 = (await call('GET', `${C}/${cl}`)).body.bezuege[0].id;
  assert.equal((await call('POST', `${C}/bezuege/${b1}/schritte/${fremd}`, { erledigt: true })).status, 404);
  assert.equal((await call('DELETE', `${C}/${andere}`)).status, 200);
});

test('Checkliste kopieren: Schritte ja, Stand nie, Veranstaltungen nur auf Wunsch', async () => {
  let r = await call('POST', `${C}/${cl}/kopieren`, {});
  assert.equal(r.status, 200);
  let k = (await call('GET', `${C}/${r.body.id}`)).body;
  assert.equal(k.titel, 'CL-Test Sommerfest vorbereiten (Kopie)');
  assert.equal(k.kopie_von, cl);
  assert.equal(k.kategorie, 'CL-Test Feste');
  assert.deepEqual(k.schritte.map((s: any) => [s.titel, s.tage_vor, s.verantwortlich]), [['Getränke bestellen', 14, 'Thekenwart'], ['Zelt aufbauen', 1, null], ['Abrechnung an den Kassenwart', -7, null]]);
  assert.deepEqual(k.bezuege, [], 'ohne Veranstaltungen: Vorlage');
  const kopie1 = k.id;

  r = await call('POST', `${C}/${cl}/kopieren`, { titel: 'CL-Test Sommerfest 2091', bezuege: true });
  k = (await call('GET', `${C}/${r.body.id}`)).body;
  assert.equal(k.titel, 'CL-Test Sommerfest 2091');
  assert.equal(k.bezuege.length, 2);
  assert.equal(k.bezuege[0].fortschritt.erledigt, 0, 'der Stand wird nicht kopiert');
  // das Original bleibt unverändert
  assert.equal((await call('GET', `${C}/${cl}`)).body.bezuege[0].fortschritt.erledigt, 1);
  await call('DELETE', `${C}/${k.id}`);

  // einzelne Schritte in eine andere Checkliste kopieren (ans Ende)
  r = await call('POST', `${C}/schritte/kopieren`, { schritte: [s3, s1], ziel: kopie1 });
  assert.equal(r.body.anzahl, 2);
  k = (await call('GET', `${C}/${kopie1}`)).body;
  assert.deepEqual(k.schritte.map((s: any) => s.titel), ['Getränke bestellen', 'Zelt aufbauen', 'Abrechnung an den Kassenwart', 'Getränke bestellen', 'Abrechnung an den Kassenwart']);
  assert.equal((await call('POST', `${C}/schritte/kopieren`, { schritte: [s1], ziel: 999999 })).status, 404);
  await call('DELETE', `${C}/${kopie1}`);
});

test('Schritt ändern und löschen; Kategorie in Verwendung bleibt', async () => {
  let r = await call('PUT', `${C}/schritte/${s2}`, { titel: 'Zelt und Bänke aufbauen', faellig: '2090-07-10' });
  assert.equal(r.status, 200);
  let c = (await call('GET', `${C}/${cl}`)).body;
  assert.equal(c.schritte[1].termin_text, 'bis 10.07.2090');
  assert.deepEqual(c.bezuege.map((b: any) => b.schritte[1].faellig), ['2090-07-10', '2090-07-10'], 'festes Datum gilt für jede Veranstaltung');
  assert.equal((await call('DELETE', `${C}/schritte/${s3}`)).status, 200);
  c = (await call('GET', `${C}/${cl}`)).body;
  assert.equal(c.schritte.length, 2);
  assert.equal(c.bezuege[0].fortschritt.gesamt, 2);
  r = await call('DELETE', `${C}/kategorien/${kat}`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /abschalten statt löschen/);
});

test('PDF: je Veranstaltung und für alle', async () => {
  const c = (await call('GET', `${C}/${cl}`)).body;
  let r = await call('GET', `${C}/${cl}/pdf?bezug=${c.bezuege[0].id}`);
  assert.equal(r.status, 200);
  assert.match(r.typ, /application\/pdf/);
  assert.equal(r.roh.subarray(0, 5).toString(), '%PDF-');
  const eine = r.roh.length;
  r = await call('GET', `${C}/${cl}/pdf`);
  assert.equal(r.status, 200);
  assert.ok(r.roh.length > eine, 'alle Veranstaltungen: mehr Seiten');
  // Vorlage ohne Veranstaltung
  const leer = (await call('POST', C, { titel: 'CL-Test Vorlage' })).body.id;
  r = await call('GET', `${C}/${leer}/pdf`);
  assert.equal(r.roh.subarray(0, 5).toString(), '%PDF-');
  await call('DELETE', `${C}/${leer}`);
});

test('wird die Veranstaltung im Kalender gelöscht, entfällt die Zuordnung samt Stand', async () => {
  await sql`delete from tco.kal_events where id = ${ev2}`;
  const c = (await call('GET', `${C}/${cl}`)).body;
  assert.deepEqual(c.bezuege.map((b: any) => b.titel), ['CL-Test Sommerfest']);
});

test('Rechte: ohne Pflege-Recht nur lesen, ohne Recht gar nicht', async () => {
  const gast = client();
  assert.equal((await gast('GET', C)).status, 401);
  const [rolle] = await sql`insert into core.roles (id, name, description) values ('CL_TEST_LESER', 'CL-Test Leser', '') returning id`;
  await sql`insert into core.role_permissions (role_id, permission) values (${rolle.id}, 'tco.checklisten:display')`;
  const r = await call('POST', '/api/admin/users', { username: 'cl-leser', displayName: 'CL Leser', password: 'geheim-geheim-1', roles: [rolle.id] });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  await sql`update core.users set must_change_password = false where username = 'cl-leser'`;
  assert.equal((await gast('POST', '/api/auth/login', { username: 'cl-leser', password: 'geheim-geheim-1' })).status, 200);
  const d = await gast('GET', C);
  assert.equal(d.status, 200);
  assert.equal(d.body.pflege, false);
  assert.equal((await gast('POST', C, { titel: 'nicht erlaubt' })).status, 403);
  assert.equal((await gast('GET', `${C}/${cl}/pdf`)).status, 200);

  await call('DELETE', `${C}/${cl}`);
  assert.equal((await call('GET', `${C}/${cl}`)).status, 404);
  assert.equal((await call('DELETE', `${C}/kategorien/${kat}`)).status, 200, 'unbenutzte Kategorie lässt sich löschen');
});
