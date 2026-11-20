/**
 * WCA Zeitenkontrolle (Modul wca) gegen eine echte Test-Datenbank: Tempo-Teamreport (anonymisierte Fixture) prüfen
 * und übernehmen, erneuter Import ersetzt je Person und Tag statt zu verdoppeln, Auswertung, Einstellungen,
 * Personenvorgaben, Import löschen mit Begründung, Rechte.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder Datenbankname enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'wca';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { modulAktiv } = await import('../src/config.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

function client() {
  let cookie = '';
  return async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let body: any = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    return { status: res.statusCode, body };
  };
}

const ALLE = ['tco', 'transport', 'beispiel', 'miete', 'wca', 'core'];
before(async () => {
  await sql.unsafe(`${ALLE.map((s) => `drop schema if exists ${s} cascade;`).join(' ')} drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  await sql.unsafe('drop schema if exists wca cascade');
  await sql.end();
});

const CSV = readFileSync(new URL('./fixtures/wca/teamreport_nov26.csv', import.meta.url), 'utf8');
const DATEI = 'teamreport_nov26.csv';
const M = '/api/m/wca';
const AUSW = `${M}/auswertung?stichtag=2026-11-20&zeitraum=2026-11`;

test('WCA Zeitenkontrolle ist aktiv', () => {
  assert.ok(modulAktiv('wca'));
});

test('Tempo-Export prüfen, übernehmen, ersetzen, auswerten; Einstellungen, Vorgaben, Löschen, Rechte', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/setup', { orgName: 'Zeiten', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' })).status, 200);
  const ok = (r: { status: number; body: any }) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const max = async () => {
    const a = ok(await admin('GET', AUSW));
    const p = a.personen.find((x: any) => x.person === 'Max Muster');
    assert.ok(p, 'Max Muster in der Auswertung');
    return { a, p };
  };

  // Leere Auswertung ohne Daten läuft
  ok(await admin('GET', AUSW));
  assert.equal((await admin('GET', `${M}/auswertung?zeitraum=2026-13x`)).status, 400, 'ungültiger Zeitraum');

  // Prüflauf: zeigt Kennzahlen, schreibt nichts
  const pruef = ok(await admin('POST', `${M}/import`, { dateien: [{ name: DATEI, csv: CSV }], uebernehmen: false }));
  assert.equal(pruef.uebernommen, false);
  assert.equal(pruef.dateien.length, 1);
  const d0 = pruef.dateien[0];
  assert.equal(d0.fehler, undefined, JSON.stringify(d0));
  assert.deepEqual([d0.personen, d0.eintraege, d0.stunden, d0.von, d0.bis, d0.ersetzt], [1, 29, 80, '2026-11-01', '2026-11-30', 0]);
  assert.deepEqual(d0.warnungen, [], 'Kontrollsumme stimmt');
  assert.deepEqual(ok(await admin('GET', `${M}/importe`)), [], 'Prüflauf schreibt nichts');

  // Unlesbare Datei: Fehler je Datei, die übrigen laufen weiter
  const kaputt = ok(await admin('POST', `${M}/import`, { dateien: [{ name: 'leer.csv', csv: '' }, { name: DATEI, csv: CSV }] }));
  assert.ok(kaputt.dateien[0].fehler, 'leere Datei meldet Fehler');
  assert.equal(kaputt.dateien[1].eintraege, 29);

  // Übernahme (als Daten-URL, wie aus dem Browser)
  const dataUrl = `data:text/csv;base64,${Buffer.from(CSV, 'utf8').toString('base64')}`;
  const ueb = ok(await admin('POST', `${M}/import`, { dateien: [{ name: DATEI, csv: dataUrl, geaendert: '2026-11-20T08:00:00.000Z' }], uebernehmen: true }));
  assert.equal(ueb.uebernommen, true);
  assert.deepEqual([ueb.dateien[0].eintraege, ueb.dateien[0].stunden, ueb.dateien[0].ersetzt], [29, 80, 0]);
  let importe = ok(await admin('GET', `${M}/importe`));
  assert.equal(importe.length, 1);
  assert.deepEqual([importe[0].datei, importe[0].personen, importe[0].eintraege, importe[0].stunden, importe[0].von, importe[0].bis, importe[0].importiertVon],
    [DATEI, 1, 29, 80, '2026-11-01', '2026-11-30', 'Admin']);
  const ersterImport = importe[0].id;

  // Auswertung: Stichtag 20.11., November → Soll 15 × 8 h, Ist 80 h, Billable 19,5 h
  let { a, p } = await max();
  assert.equal(a.stichtag, '2026-11-20');
  assert.equal(a.zeitraum.id, '2026-11');
  assert.equal(a.stand.dateien, 1);
  assert.deepEqual([p.ist, p.soll, p.B, p.P, p.A], [80, 120, 19.5, 2, 8]);
  assert.equal(typeof p.ist, 'number');

  // Erneuter Import derselben Datei: Prüflauf meldet 10 ersetzte Buchungstage, Übernahme verdoppelt nicht
  const nochmal = ok(await admin('POST', `${M}/import`, { dateien: [{ name: DATEI, csv: CSV }] }));
  assert.equal(nochmal.dateien[0].ersetzt, 10);
  ok(await admin('POST', `${M}/import`, { dateien: [{ name: DATEI, csv: CSV }], uebernehmen: true }));
  ({ p } = await max());
  assert.equal(p.ist, 80, 'ersetzt statt verdoppelt');
  importe = ok(await admin('GET', `${M}/importe`));
  assert.equal(importe.length, 2, 'der ältere Import bleibt mit 0 Einträgen stehen');
  const alt = importe.find((i: any) => i.id === ersterImport);
  assert.deepEqual([alt.eintraege, alt.stunden], [0, 0]);
  assert.equal(importe.find((i: any) => i.id !== ersterImport).eintraege, 29);

  // Einstellungen lesen und ändern (Unbekanntes wird verworfen)
  const e = ok(await admin('GET', `${M}/einstellungen`));
  assert.deepEqual(e.einstellungen, e.standard, 'ohne Änderung gilt der Standard');
  assert.deepEqual(e.personen, ['Max Muster']);
  assert.deepEqual(e.vorgaben, []);
  ok(await admin('PUT', `${M}/einstellungen`, { ...e.einstellungen, langerTag: 9, toleranz: 0.5, unbekannt: 'weg' }));
  const e2 = ok(await admin('GET', `${M}/einstellungen`));
  assert.equal(e2.einstellungen.langerTag, 9);
  assert.equal(e2.einstellungen.toleranz, 0.5);
  assert.equal('unbekannt' in e2.einstellungen, false);
  assert.equal(e2.standard.langerTag, e.standard.langerTag);
  assert.equal((await admin('PUT', `${M}/einstellungen`, { ...e.einstellungen, toleranz: 'viel' })).status, 400);
  assert.equal((await admin('PUT', `${M}/einstellungen`, { ...e.einstellungen, accountPflichtAb: '1.11.2026' })).status, 400);
  ok(await admin('PUT', `${M}/einstellungen`, e.standard));

  // Personenvorgabe: 4 h je Tag → Soll halbiert
  const person = `${M}/personen/${encodeURIComponent('Max Muster')}`;
  ok(await admin('PUT', person, { standort: 'de', sollTag: 4, arbeitstage: null, von: null, bis: null, ausblenden: false }));
  ({ p } = await max());
  assert.equal(p.sollTag, 4);
  assert.equal(p.soll, 60);
  assert.equal(p.standort, 'DE');
  const v = ok(await admin('GET', `${M}/einstellungen`)).vorgaben;
  assert.deepEqual(v, [{ person: 'Max Muster', standort: 'DE', sollTag: 4, arbeitstage: null, von: null, bis: null, ausblenden: false }]);
  assert.equal((await admin('PUT', person, { sollTag: 4, von: '2026-11-10', bis: '2026-11-01' })).status, 400, 'Bis vor Von');
  ok(await admin('PUT', person, { sollTag: null, arbeitstage: [4, 0, 1, 2, 3, 3], ausblenden: false }));
  assert.deepEqual(ok(await admin('GET', `${M}/einstellungen`)).vorgaben[0].arbeitstage, [0, 1, 2, 3, 4]);
  ok(await admin('DELETE', person));
  ({ p } = await max());
  assert.equal(p.soll, 120);

  // Änderungsbelege für Einstellungen und Personenvorgaben
  const [{ n }] = await sql`select count(*)::int as n from core.change_header where object_type in ('WCA_EINST', 'WCA_PERSON')`;
  assert.ok(n >= 4, `Änderungsbelege: ${n}`);

  // Import löschen: nur mit Begründung
  assert.equal((await admin('DELETE', `${M}/importe/${ersterImport}`, {})).status, 400);
  ok(await admin('DELETE', `${M}/importe/${ersterImport}`, { reason: 'Doppelt importiert' }));
  assert.equal((await admin('DELETE', `${M}/importe/${ersterImport}`, { reason: 'nochmal' })).status, 404);
  importe = ok(await admin('GET', `${M}/importe`));
  assert.equal(importe.length, 1);
  ({ p } = await max());
  assert.equal(p.ist, 80, 'der leere ältere Import trug nichts mehr bei');
  const [beleg] = await sql`select action, reason from core.change_header where object_type = 'WCA_IMPORT' and change_ind = 'D'`;
  assert.deepEqual([beleg?.action, beleg?.reason], ['LOESCHEN', 'Doppelt importiert']);
  const [{ imp }] = await sql`select count(*)::int as imp from core.change_header where object_type = 'WCA_IMPORT' and action = 'WCA_IMPORT'`;
  assert.equal(imp, 2, 'zwei Übernahmen mit Aktion WCA_IMPORT');

  // Neuesten Import löschen → keine Buchungen mehr
  ok(await admin('DELETE', `${M}/importe/${importe[0].id}`, { reason: 'Test' }));
  const leer = ok(await admin('GET', AUSW));
  assert.equal(leer.eintraege.length, 0);
  ok(await admin('POST', `${M}/import`, { dateien: [{ name: DATEI, csv: CSV }], uebernehmen: true }));

  // Rechte: nur Auswertung anzeigen
  ok(await admin('POST', '/api/admin/roles', { id: 'WCA_LESEN', name: 'Zeiten lesen', permissions: ['wca.auswertung:display'] }));
  ok(await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Leser', password: 'geheim-geheim', roles: ['WCA_LESEN'] }));
  const leser = client();
  ok(await leser('POST', '/api/auth/login', { username: 'leser', password: 'geheim-geheim' }));
  ok(await leser('POST', '/api/auth/password', { current: 'geheim-geheim', next: 'neu-geheim-geheim' }));
  assert.equal((await leser('GET', AUSW)).status, 200);
  assert.equal((await leser('POST', `${M}/import`, { dateien: [{ name: DATEI, csv: CSV }], uebernehmen: false })).status, 403);
  assert.equal((await leser('GET', `${M}/importe`)).status, 403);
  assert.equal((await leser('GET', `${M}/einstellungen`)).status, 403);
  assert.equal((await leser('PUT', `${M}/einstellungen`, {})).status, 403);
});
