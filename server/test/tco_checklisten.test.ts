/**
 * Checklisten für Veranstaltungen: Terminbezug und Stand (reine Funktionen), Pflege über die Schnittstellen,
 * Gültigkeit für mehrere Veranstaltungen mit eigenem Stand, Kopieren von Checklisten und Schritten, PDF, Rechte.
 *
 * Eigene Testdaten: Veranstaltungen „CL-Test …“ im Jahr 2090, Kategorien „CL-Test …“.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { baumOrdnen, faelligAm, fortschritt, gruppenStand, importLesen, importTermin, kopieTitel, stand, terminText } from '../../modules/tco/server/checklisten/logik.js';

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

test('Import: Termin einer Zeile', () => {
  assert.deepEqual(importTermin(''), { tage_vor: null, faellig: null });
  assert.deepEqual(importTermin('14'), { tage_vor: 14, faellig: null });
  assert.deepEqual(importTermin('-7'), { tage_vor: -7, faellig: null });
  assert.deepEqual(importTermin('14 Tage vorher'), { tage_vor: 14, faellig: null });
  assert.deepEqual(importTermin('1 Tag danach'), { tage_vor: -1, faellig: null });
  assert.deepEqual(importTermin('2 Wochen vorher'), { tage_vor: 14, faellig: null });
  assert.deepEqual(importTermin('am Tag der Veranstaltung'), { tage_vor: 0, faellig: null });
  assert.deepEqual(importTermin('1.3.2090'), { tage_vor: null, faellig: '2090-03-01' });
  assert.deepEqual(importTermin('bis 01.03.2090'), { tage_vor: null, faellig: '2090-03-01' });
  assert.deepEqual(importTermin('2090-03-01'), { tage_vor: null, faellig: '2090-03-01' });
  assert.equal(importTermin('31.02.2090'), null);
  assert.equal(importTermin('irgendwann'), null);
});

test('Import: Tabelle aus der Zwischenablage lesen', () => {
  // ohne Kopfzeile, feste Reihenfolge; leere Zellen übernehmen Kategorie und Checkliste von oben
  let g = importLesen('Fest\tSommerfest\tGetränke bestellen\tThekenwart\t14\tListe vom Vorjahr\r\n\t\tZelt aufbauen\t\t1 Tag vorher\t\n\n\tHerbstfest\tEinladen\t\t\t');
  assert.deepEqual(g.fehler, []);
  assert.equal(g.kopfzeile, false);
  assert.deepEqual(g.zeilen.map((z) => [z.zeile, z.kategorie, z.checkliste, z.schritt, z.verantwortlich, z.tage_vor, z.hinweise]), [
    [1, 'Fest', 'Sommerfest', 'Getränke bestellen', 'Thekenwart', 14, 'Liste vom Vorjahr'],
    [2, 'Fest', 'Sommerfest', 'Zelt aufbauen', '', 1, ''],
    [4, 'Fest', 'Herbstfest', 'Einladen', '', null, ''],
  ]);
  // mit Kopfzeile in anderer Reihenfolge und anderen Namen, Semikolon als Trenner
  g = importLesen('Aufgabe;Wer;Veranstaltung;Wann\nPlätze abziehen;Platzwart;Turnier;am Tag\nPokale;;;01.09.2090');
  assert.deepEqual(g.fehler, []);
  assert.equal(g.kopfzeile, true);
  assert.deepEqual(g.zeilen.map((z) => [z.kategorie, z.checkliste, z.schritt, z.verantwortlich, z.tage_vor, z.faellig]), [
    ['', 'Turnier', 'Plätze abziehen', 'Platzwart', 0, null], ['', 'Turnier', 'Pokale', '', null, '2090-09-01'],
  ]);
  // Fehler mit Zeilennummer
  g = importLesen('Fest\t\tOhne Checkliste\nFest\tSommerfest\tSchritt\t\tübermorgen');
  assert.equal(g.zeilen.length, 0);
  assert.match(g.fehler[0], /^Zeile 1: Es fehlt die Checkliste/);
  assert.match(g.fehler[1], /^Zeile 2: Termin „übermorgen“ nicht erkannt/);
  assert.match(importLesen('  \n ').fehler[0], /keine Zeilen/);
});

test('Stufen: Baumreihenfolge mit Gliederungsnummer, Stand einer Gruppe aus ihren Blättern', () => {
  const b = baumOrdnen([
    { id: 1, parent_id: null, pos: 2 }, { id: 2, parent_id: null, pos: 1 }, { id: 3, parent_id: 1, pos: 2 }, { id: 4, parent_id: 1, pos: 1 },
    { id: 5, parent_id: 4, pos: 1 }, { id: 6, parent_id: 99, pos: 1 },
  ]);
  assert.deepEqual(b.map((x) => [x.knoten.id, x.ebene, x.nr, x.blatt]), [[2, 1, '1', true], [6, 1, '2', true], [1, 1, '3', false], [4, 2, '3.1', false], [5, 3, '3.1.1', true], [3, 2, '3.2', true]]);
  assert.equal(gruppenStand(['ERLEDIGT', 'ERLEDIGT']), 'ERLEDIGT');
  assert.equal(gruppenStand(['ERLEDIGT', 'OFFEN', 'UEBERFAELLIG', 'BALD']), 'UEBERFAELLIG');
  assert.equal(gruppenStand(['ERLEDIGT', 'BALD']), 'BALD');
  assert.equal(gruppenStand(['ERLEDIGT', 'OFFEN']), 'OFFEN');
  assert.equal(gruppenStand([]), 'OFFEN');
});

test('Import: Unterschritte als Weg, höchstens fünf Stufen', () => {
  const g = importLesen('Fest\tSommerfest\tAufbau > Zelt >  Heringe einschlagen\t\t1\t\nFest\tSommerfest\ta > b > c > d > e > f');
  assert.deepEqual(g.zeilen.map((z) => [z.schritt, z.pfad]), [['Aufbau > Zelt > Heringe einschlagen', ['Aufbau', 'Zelt', 'Heringe einschlagen']]]);
  assert.match(g.fehler[0], /^Zeile 2: .* hat 6 Stufen – erlaubt sind höchstens 5/);
});

// ---------------------------------------------------------------------------
// Pflege über die Schnittstellen
// ---------------------------------------------------------------------------

let kat = 0, cl = 0, s1 = 0, s2 = 0, s3 = 0;
let stufen: Record<string, number> = {};

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

test('Baum: Checkliste in eine andere Kategorie, Schritt in eine andere Checkliste und an eine andere Stelle', async () => {
  const k2 = (await call('POST', `${C}/kategorien`, { name: 'CL-Test Turniere' })).body.id;
  const a = (await call('POST', C, { titel: 'CL-Test Baum A', kategorie_id: kat })).body.id;
  const b = (await call('POST', C, { titel: 'CL-Test Baum B' })).body.id;
  const ids: number[] = [];
  for (const t of ['A1', 'A2', 'A3']) ids.push((await call('POST', `${C}/${a}/schritte`, { titel: t })).body.id);
  const b1 = (await call('POST', `${C}/${b}/schritte`, { titel: 'B1' })).body.id;
  const titel = async (id: number) => (await call('GET', `${C}/${id}`)).body.schritte.map((s: any) => s.titel);

  // Kategorie wechseln und wieder lösen
  assert.equal((await call('POST', `${C}/${a}/kategorie`, { kategorie_id: k2 })).status, 200);
  assert.equal((await call('GET', `${C}/${a}`)).body.kategorie, 'CL-Test Turniere');
  await call('POST', `${C}/${a}/kategorie`, { kategorie_id: null });
  assert.equal((await call('GET', `${C}/${a}`)).body.kategorie, null);
  assert.equal((await call('POST', `${C}/${a}/kategorie`, { kategorie_id: 999999 })).status, 400);

  // innerhalb der Checkliste: A3 vor A1
  assert.equal((await call('POST', `${C}/schritte/${ids[2]}/verschieben`, { ziel: a, vor: ids[0] })).status, 200);
  assert.deepEqual(await titel(a), ['A3', 'A1', 'A2']);
  // ans Ende
  await call('POST', `${C}/schritte/${ids[2]}/verschieben`, { ziel: a });
  assert.deepEqual(await titel(a), ['A1', 'A2', 'A3']);

  // in eine andere Checkliste vor B1 – der Stand des Schritts entfällt
  await call('POST', `${C}/${a}/bezuege`, { termin: '2090-01-01', bezeichnung: 'CL-Test Baum' });
  const bz = (await call('GET', `${C}/${a}`)).body.bezuege[0].id;
  await call('POST', `${C}/bezuege/${bz}/schritte/${ids[1]}`, { erledigt: true });
  assert.equal((await call('POST', `${C}/schritte/${ids[1]}/verschieben`, { ziel: b, vor: b1 })).status, 200);
  assert.deepEqual(await titel(a), ['A1', 'A3']);
  assert.deepEqual(await titel(b), ['A2', 'B1']);
  assert.equal((await call('GET', `${C}/${a}`)).body.bezuege[0].fortschritt.erledigt, 0);
  const [{ n }] = await sql`select count(*)::int as n from tco.cl_erledigt where schritt_id = ${ids[1]}`;
  assert.equal(n, 0);
  // „vor“ muss in der Ziel-Checkliste liegen
  assert.equal((await call('POST', `${C}/schritte/${ids[0]}/verschieben`, { ziel: b, vor: ids[2] })).status, 409);

  await call('DELETE', `${C}/${a}`);
  await call('DELETE', `${C}/${b}`);
  assert.equal((await call('DELETE', `${C}/kategorien/${k2}`)).status, 200);
});

test('Import über die Schnittstelle: prüfen schreibt nichts, übernehmen legt an und fügt an bestehende an', async () => {
  const text = 'Kategorie\tCheckliste\tSchritt\tVerantwortlich\tTermin\tHinweise\n'
    + 'CL-Test Import\tCL-Test Importfest\tEinladungen\tSchriftführer\t21 Tage vorher\tper Rundschreiben\n'
    + '\t\tAufräumen\t\t1 Tag danach\t\n'
    + 'cl-test feste\tCL-Test Sommerfest vorbereiten\tMusik bestellen\t\t\t';
  let r = await call('POST', `${C}/import`, { text, pruefen: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.fehler, []);
  assert.equal(r.body.uebernommen, false);
  assert.deepEqual(r.body.ergebnis, { kategorien: ['CL-Test Import'], checklisten: ['CL-Test Importfest'], ergaenzt: ['CL-Test Sommerfest vorbereiten'], schritte: 3 });
  let d = (await call('GET', C)).body;
  assert.ok(!d.checklisten.some((c: any) => c.titel === 'CL-Test Importfest'), 'die Prüfung legt nichts an');
  assert.ok(!d.kategorien.some((k: any) => k.name === 'CL-Test Import'));

  // mit Fehler wird nichts übernommen
  r = await call('POST', `${C}/import`, { text: `${text}\nX\tY\tZ\t\tirgendwann`, pruefen: false });
  assert.equal(r.body.uebernommen, false);
  assert.equal(r.body.fehler.length, 1);
  assert.ok(!(await call('GET', C)).body.checklisten.some((c: any) => c.titel === 'CL-Test Importfest'));

  r = await call('POST', `${C}/import`, { text, pruefen: false });
  assert.equal(r.body.uebernommen, true);
  d = (await call('GET', C)).body;
  const neu = d.checklisten.find((c: any) => c.titel === 'CL-Test Importfest');
  assert.equal(neu.kategorie, 'CL-Test Import');
  assert.deepEqual(neu.schritte.map((s: any) => [s.titel, s.verantwortlich, s.tage_vor, s.beschreibung]), [['Einladungen', 'Schriftführer', 21, 'per Rundschreiben'], ['Aufräumen', null, -1, null]]);
  const alt = d.checklisten.find((c: any) => c.id === cl);
  assert.equal(alt.schritte.at(-1).titel, 'Musik bestellen', 'an die bestehende Checkliste angefügt');
  assert.equal(alt.kategorie, 'CL-Test Feste', 'bestehende Checkliste behält ihre Kategorie');
  assert.equal(d.checklisten.filter((c: any) => c.titel === 'CL-Test Sommerfest vorbereiten').length, 1);
  // aufräumen
  await call('DELETE', `${C}/schritte/${alt.schritte.at(-1).id}`);
  await call('DELETE', `${C}/${neu.id}`);
  await call('DELETE', `${C}/kategorien/${d.kategorien.find((k: any) => k.name === 'CL-Test Import').id}`);
});

test('Stufen: Unterschritte bis zur fünften Stufe, Fortschritt je Gruppe, Gruppe abhaken', async () => {
  const c = (await call('POST', C, { titel: 'CL-Test Stufen', verantwortlich: 'Festwart' })).body.id;
  const neu = async (titel: string, parent_id: number | null = null, mehr: object = {}) => (await call('POST', `${C}/${c}/schritte`, { titel, parent_id, ...mehr })).body.id as number;
  const aufbau = await neu('Aufbau');
  const zelt = await neu('Zelt', aufbau);
  const heringe = await neu('Heringe', zelt, { tage_vor: 1 });
  const plane = await neu('Plane', zelt, { tage_vor: 1 });
  const theke = await neu('Theke', aufbau, { tage_vor: 0 });
  const kasse = await neu('Kasse');
  // fünf Stufen gehen, die sechste nicht
  const s3 = await neu('Stufe 3', zelt), s4 = await neu('Stufe 4', s3), s5 = await neu('Stufe 5', s4);
  let r = await call('POST', `${C}/${c}/schritte`, { titel: 'Stufe 6', parent_id: s5 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /höchstens in 5 Stufen/);
  assert.equal((await call('DELETE', `${C}/schritte/${s3}`)).status, 200, 'löschen nimmt die Unterschritte mit');
  // Unterschritt nur in derselben Checkliste
  assert.equal((await call('POST', `${C}/${c}/schritte`, { titel: 'fremd', parent_id: s1 })).status, 400);

  let l = (await call('GET', `${C}/${c}`)).body;
  assert.deepEqual(l.schritte.map((x: any) => [x.nr, x.titel, x.ebene, x.blatt]), [
    ['1', 'Aufbau', 1, false], ['1.1', 'Zelt', 2, false], ['1.1.1', 'Heringe', 3, true], ['1.1.2', 'Plane', 3, true], ['1.2', 'Theke', 2, true], ['2', 'Kasse', 1, true],
  ]);
  assert.equal(l.schritte.find((x: any) => x.id === s4), undefined);

  // Fortschritt zählt nur Blätter; die Gruppe zeigt ihren Anteil und die früheste offene Fälligkeit
  await call('POST', `${C}/${c}/bezuege`, { termin: '2090-07-15', bezeichnung: 'CL-Test Stufenfest' });
  l = (await call('GET', `${C}/${c}`)).body;
  const bz = l.bezuege[0].id;
  assert.deepEqual(l.bezuege[0].fortschritt, { gesamt: 4, erledigt: 0, ueberfaellig: 0, bald: 0 });
  await call('POST', `${C}/bezuege/${bz}/schritte/${heringe}`, { erledigt: true });
  l = (await call('GET', `${C}/${c}`)).body;
  const z = (id: number) => l.bezuege[0].schritte.find((x: any) => x.schritt_id === id);
  assert.deepEqual([z(zelt).gruppe, z(zelt).stand, z(zelt).faellig, z(zelt).erledigt], [{ gesamt: 2, erledigt: 1, ueberfaellig: 0, bald: 0 }, 'OFFEN', '2090-07-14', null]);
  assert.deepEqual(z(aufbau).gruppe, { gesamt: 3, erledigt: 1, ueberfaellig: 0, bald: 0 });
  assert.equal(z(heringe).gruppe, undefined);
  assert.equal(l.bezuege[0].fortschritt.erledigt, 1);

  // Gruppe abhaken = alle Blätter darunter; bereits Erledigtes bleibt, wie es ist
  r = await call('POST', `${C}/bezuege/${bz}/schritte/${aufbau}`, { erledigt: true });
  assert.equal(r.status, 200);
  l = (await call('GET', `${C}/${c}`)).body;
  assert.deepEqual([z(aufbau).stand, z(aufbau).gruppe.erledigt, z(zelt).stand, z(theke).stand, z(kasse).stand], ['ERLEDIGT', 3, 'ERLEDIGT', 'ERLEDIGT', 'OFFEN']);
  assert.equal(l.bezuege[0].fortschritt.erledigt, 3);
  // Gruppe wieder öffnen
  await call('POST', `${C}/bezuege/${bz}/schritte/${zelt}`, { erledigt: false });
  l = (await call('GET', `${C}/${c}`)).body;
  assert.deepEqual([z(zelt).gruppe.erledigt, z(aufbau).gruppe.erledigt, z(theke).stand], [0, 1, 'ERLEDIGT']);

  // ein abgehakter Schritt bekommt einen Unterschritt: sein eigener Haken entfällt, es zählt der Unterschritt
  const zapfen = await neu('Zapfanlage', theke);
  l = (await call('GET', `${C}/${c}`)).body;
  assert.deepEqual([z(theke).gruppe, z(theke).stand, z(zapfen).stand], [{ gesamt: 1, erledigt: 0, ueberfaellig: 0, bald: 0 }, 'OFFEN', 'OFFEN']);
  stufen = { c, aufbau, zelt, heringe, plane, theke, kasse, zapfen, bz };
});

test('Stufen: verschieben mit Unterschritten – unter einen Schritt, vor einen Schritt, in eine andere Checkliste; Grenzen', async () => {
  const { c, aufbau, zelt, heringe, plane, theke, kasse, zapfen, bz } = stufen;
  const nrs = async (id = c) => (await call('GET', `${C}/${id}`)).body.schritte.map((x: any) => `${x.nr} ${x.titel}`);
  // Zelt (mit Heringe, Plane) unter Kasse
  let r = await call('POST', `${C}/schritte/${zelt}/verschieben`, { ziel: c, unter: kasse });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await nrs(), ['1 Aufbau', '1.1 Theke', '1.1.1 Zapfanlage', '2 Kasse', '2.1 Zelt', '2.1.1 Heringe', '2.1.2 Plane']);
  // nicht unter sich selbst oder einen eigenen Unterschritt
  assert.equal((await call('POST', `${C}/schritte/${kasse}/verschieben`, { ziel: c, unter: plane })).status, 400);
  assert.equal((await call('POST', `${C}/schritte/${kasse}/verschieben`, { ziel: c, vor: heringe })).status, 400);
  // vor einen Schritt = auf dessen Stufe: Plane vor Zapfanlage
  await call('POST', `${C}/schritte/${plane}/verschieben`, { ziel: c, vor: zapfen });
  assert.deepEqual(await nrs(), ['1 Aufbau', '1.1 Theke', '1.1.1 Plane', '1.1.2 Zapfanlage', '2 Kasse', '2.1 Zelt', '2.1.1 Heringe']);
  // Reihenfolge innerhalb der Stufe: nur die Geschwister
  assert.equal((await call('POST', `${C}/${c}/reihenfolge`, { schritte: [zapfen, plane] })).status, 200);
  assert.equal((await call('POST', `${C}/${c}/reihenfolge`, { schritte: [zapfen, heringe] })).status, 409, 'keine Geschwister');
  assert.deepEqual(await nrs(), ['1 Aufbau', '1.1 Theke', '1.1.1 Zapfanlage', '1.1.2 Plane', '2 Kasse', '2.1 Zelt', '2.1.1 Heringe']);
  // Stufengrenze beim Verschieben: Kasse (Höhe 3) unter Plane (Stufe 3) wären sechs Stufen
  const tief = (await call('POST', `${C}/${c}/schritte`, { titel: 'tief', parent_id: heringe })).body.id;
  r = await call('POST', `${C}/schritte/${kasse}/verschieben`, { ziel: c, unter: plane });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /höchstens in 5 Stufen .* wären es 7/);
  await call('DELETE', `${C}/schritte/${tief}`);

  // in eine andere Checkliste: der ganze Teilbaum wandert, sein Stand entfällt
  await call('POST', `${C}/bezuege/${bz}/schritte/${heringe}`, { erledigt: true });
  const andere = (await call('POST', C, { titel: 'CL-Test Stufen Ziel' })).body.id;
  r = await call('POST', `${C}/schritte/${kasse}/verschieben`, { ziel: andere });
  assert.equal(r.status, 200);
  assert.deepEqual(await nrs(andere), ['1 Kasse', '1.1 Zelt', '1.1.1 Heringe']);
  assert.deepEqual(await nrs(), ['1 Aufbau', '1.1 Theke', '1.1.1 Zapfanlage', '1.1.2 Plane']);
  const [{ n }] = await sql`select count(*)::int as n from tco.cl_erledigt where schritt_id = ${heringe}`;
  assert.equal(n, 0);
  // zurück auf die oberste Stufe der ersten Checkliste, vor Aufbau
  await call('POST', `${C}/schritte/${zelt}/verschieben`, { ziel: c, vor: aufbau });
  assert.deepEqual(await nrs(), ['1 Zelt', '1.1 Heringe', '2 Aufbau', '2.1 Theke', '2.1.1 Zapfanlage', '2.1.2 Plane']);
  assert.deepEqual(await nrs(andere), ['1 Kasse']);
  stufen.andere = andere;
});

test('Stufen: kopieren nimmt Unterschritte mit; Import hängt unter bestehende Gruppen', async () => {
  const { c, aufbau, theke, andere } = stufen;
  const titel = async (id: number) => (await call('GET', `${C}/${id}`)).body.schritte.map((x: any) => `${x.nr} ${x.titel}`);
  // Aufbau und sein Unterschritt Theke gewählt: Theke kommt nur einmal (mit Aufbau)
  let r = await call('POST', `${C}/schritte/kopieren`, { schritte: [theke, aufbau], ziel: andere });
  assert.equal(r.body.anzahl, 4);
  assert.deepEqual(await titel(andere), ['1 Kasse', '2 Aufbau', '2.1 Theke', '2.1.1 Zapfanlage', '2.1.2 Plane']);
  // ganze Checkliste kopieren: derselbe Baum
  r = await call('POST', `${C}/${c}/kopieren`, { titel: 'CL-Test Stufen Kopie' });
  assert.deepEqual(await titel(r.body.id), await titel(c));
  await call('DELETE', `${C}/${r.body.id}`);
  // PDF mit Stufen
  const pdf = await call('GET', `${C}/${c}/pdf`);
  assert.equal(pdf.roh.subarray(0, 5).toString(), '%PDF-');

  // Import: „Aufbau > Theke > …“ findet die bestehenden Gruppen, neue Wege werden angelegt
  const text = 'CL-Test Stufen\tAufbau > Theke > Gläser spülen\tThekenwart\t1 Tag vorher\n'
    + 'CL-Test Stufen\tAbbau\n'
    + 'CL-Test Stufen\tAbbau > Zelt abbauen\t\t1 Tag danach';
  const kopf = 'Checkliste\tSchritt\tVerantwortlich\tTermin\n';
  r = await call('POST', `${C}/import`, { text: kopf + text, pruefen: true });
  assert.deepEqual(r.body.fehler, []);
  assert.equal(r.body.ergebnis.schritte, 3);
  assert.deepEqual(await titel(c), ['1 Zelt', '1.1 Heringe', '2 Aufbau', '2.1 Theke', '2.1.1 Zapfanlage', '2.1.2 Plane'], 'die Prüfung schreibt nichts');
  r = await call('POST', `${C}/import`, { text: kopf + text, pruefen: false });
  assert.equal(r.body.uebernommen, true);
  assert.deepEqual(await titel(c), ['1 Zelt', '1.1 Heringe', '2 Aufbau', '2.1 Theke', '2.1.1 Zapfanlage', '2.1.2 Plane', '2.1.3 Gläser spülen', '3 Abbau', '3.1 Zelt abbauen']);
  const l = (await call('GET', `${C}/${c}`)).body;
  assert.deepEqual(l.schritte.filter((x: any) => x.titel === 'Gläser spülen').map((x: any) => [x.verantwortlich, x.tage_vor]), [['Thekenwart', 1]]);
  await call('DELETE', `${C}/${c}`);
  await call('DELETE', `${C}/${andere}`);
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
