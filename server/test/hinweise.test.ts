/**
 * Hinweise im Arbeitsvorrat (#232, V1): melden, zusammenfassen, „gesehen“ einzeln und für alle einer Art,
 * Sichtbarkeit und Bestätigung nur mit dem Recht der zugehörigen App, Störungen schließen sich nach dem nächsten Erfolg;
 * überwachte Schnittstellen, nicht gesendete E-Mails, Paperless.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { HINWEIS_DB, HINWEIS_GESEHEN, hinweisBeheben, hinweisMelden, stoerungMelden, ueberwacht } = await import('../src/lib/hinweise.js');
const { Paperless } = await import('../src/lib/paperless.js');

interface Aufgabe { key: string; bereich: string; titel: string; text: string; datum: string | null; state: string; pfad: string; icon: string; erledigen?: { text: string; url: string; body: Record<string, unknown> }; kinder?: Aufgabe[] }

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };
}
const admin = client();
const leser = client();
/** Einträge des Blocks einer Anwendung auf der Startseite */
const block = async (c: ReturnType<typeof client>, modul: string): Promise<Aufgabe[]> => {
  const r = await c('GET', '/api/arbeitsvorrat');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.gruppen as { modul: string; aufgaben: Aufgabe[] }[]).find((g) => g.modul === modul)?.aufgaben ?? [];
};
const anbindung = (objekt: string, text = 'Verbindung abgelehnt') => ({
  modul: 'core', quelle: 'TEST_STOERUNG', objekt, bereich: 'Administration', recht: 'core.settings:edit', art: 'Schnittstelle gestört',
  titel: `Anbindung ${objekt}`, text, pfad: '/admin/anbindungen',
});

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  // Benutzer, der nur Belege lesen darf – sieht keine Hinweise der Anbindungen
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'LESER', name: 'Leser', permissions: ['core.audit:display'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['LESER'] })).status, 200);
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
});
after(async () => { await app?.close(); await sql.end(); });

test('Hinweis melden: steht im Block der Anwendung, Wiederholung zählt hoch, „gesehen“ nur mit dem Recht der App', async () => {
  assert.deepEqual(await block(admin, 'core'), [], 'frisch: nichts gemeldet');
  await hinweisMelden(HINWEIS_DB, anbindung('A'));
  let [h, ...rest] = await block(admin, 'core');
  assert.deepEqual(rest, []);
  const [{ id }] = await sql`select id::int as id from core.hinweise where objekt = 'A'`;
  assert.deepEqual(h, {
    key: `HINWEIS:TEST_STOERUNG:${id}`, bereich: 'Administration', icon: 'message-information', state: 'Information', pfad: '/admin/anbindungen',
    datum: h.datum, titel: 'Schnittstelle gestört: Anbindung A', text: 'Verbindung abgelehnt',
    erledigen: { text: 'gesehen', url: HINWEIS_GESEHEN, body: { id } },
  });
  assert.match(h.datum ?? '', /^\d{4}-\d{2}-\d{2}$/);

  // dasselbe Ereignis noch einmal: kein zweiter Eintrag, neuer Text, Zähler
  await hinweisMelden(HINWEIS_DB, anbindung('A', 'Zeitüberschreitung'));
  [h, ...rest] = await block(admin, 'core');
  assert.deepEqual(rest, []);
  assert.equal(h.titel, 'Schnittstelle gestört: Anbindung A (2×)');
  assert.equal(h.text, 'Zeitüberschreitung');
  assert.equal(h.key, `HINWEIS:TEST_STOERUNG:${id}`, 'derselbe Hinweis');

  // ohne das Recht der App: unsichtbar, Bestätigen abgelehnt
  assert.deepEqual(await block(leser, 'core'), []);
  assert.equal((await leser('POST', HINWEIS_GESEHEN, { id })).status, 403);
  assert.equal((await client()('POST', HINWEIS_GESEHEN, { id })).status, 401);
  assert.equal((await admin('POST', HINWEIS_GESEHEN, {})).status, 400);

  // gesehen: verschwindet; wer bestätigt hat, steht in der Zeile; doppelt schadet nicht
  let r = await admin('POST', HINWEIS_GESEHEN, { id });
  assert.deepEqual([r.status, r.body.text], [200, 'Als gesehen bestätigt.']);
  assert.deepEqual(await block(admin, 'core'), []);
  const [z] = await sql`select erledigt_von, erledigt_am, anzahl from core.hinweise where id = ${id}`;
  assert.deepEqual([z.erledigt_von, z.anzahl, z.erledigt_am instanceof Date], ['Admin', 2, true]);
  r = await admin('POST', HINWEIS_GESEHEN, { id });
  assert.deepEqual([r.status, r.body.text], [200, 'Der Hinweis war schon bestätigt.']);

  // danach wieder dasselbe Ereignis: ein neuer Hinweis, der alte bleibt als Protokoll
  await hinweisMelden(HINWEIS_DB, anbindung('A'));
  [h] = await block(admin, 'core');
  assert.notEqual(h.key, `HINWEIS:TEST_STOERUNG:${id}`);
  assert.equal(h.titel, 'Schnittstelle gestört: Anbindung A');
  assert.equal((await sql`select count(*)::int as n from core.hinweise where objekt = 'A'`)[0].n, 2);
});

test('Mehrere Hinweise einer Art: gesammelt unter einem Eintrag, dringendste Farbe, alle auf einmal bestätigen', async () => {
  await hinweisMelden(HINWEIS_DB, anbindung('B'));
  await hinweisMelden(HINWEIS_DB, { ...anbindung('C'), state: 'Negative' });
  // andere Art im Block der Anwendung TC Oberthal – bleibt für sich
  await hinweisMelden(HINWEIS_DB, { modul: 'tco', quelle: 'TEST_VEREIN', objekt: '1', bereich: 'Kassenwart', recht: 'tco.mitglieder:display', art: 'Probe', titel: 'Mitglied 1', pfad: '/tco/mitglieder' });
  const liste = await block(admin, 'core');
  assert.equal(liste.length, 1);
  const g = liste[0];
  assert.deepEqual([g.key, g.titel, g.bereich, g.state], ['HINWEIS:TEST_STOERUNG', 'Schnittstelle gestört (3)', 'Administration', 'Negative']);
  assert.deepEqual(g.kinder!.map((k) => k.titel).sort(), ['Anbindung A', 'Anbindung B', 'Anbindung C']);
  assert.ok(g.kinder!.every((k) => k.erledigen?.text === 'gesehen' && typeof k.erledigen.body.id === 'number'));
  assert.deepEqual(g.erledigen, { text: 'alle gesehen', url: HINWEIS_GESEHEN, body: { modul: 'core', quelle: 'TEST_STOERUNG', bereich: 'Administration' } });
  // Block TC Oberthal: auf der Startseite und in der Vereinsübersicht, „gesehen“ mit vollständiger Adresse
  const tco = (await block(admin, 'tco')).filter((a) => a.key.startsWith('HINWEIS:'));
  assert.deepEqual(tco.map((a) => [a.titel, a.bereich, a.erledigen?.url]), [['Probe: Mitglied 1', 'Kassenwart', HINWEIS_GESEHEN]]);
  const vu = await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat');
  assert.deepEqual((vu.body as Aufgabe[]).filter((a) => a.key.startsWith('HINWEIS:')), tco);

  // einen einzeln, dann den Rest auf einmal – der Leser darf beides nicht
  assert.equal((await leser('POST', HINWEIS_GESEHEN, g.erledigen!.body)).body.text, 'Der Hinweis war schon bestätigt.', 'ohne Recht: nichts bestätigt');
  assert.equal((await block(admin, 'core'))[0].kinder!.length, 3);
  assert.equal((await admin('POST', HINWEIS_GESEHEN, g.kinder![0].erledigen!.body)).status, 200);
  assert.equal((await block(admin, 'core'))[0].kinder!.length, 2);
  const r = await admin('POST', HINWEIS_GESEHEN, g.erledigen!.body);
  assert.deepEqual([r.status, r.body.text], [200, '2 Hinweise als gesehen bestätigt.']);
  assert.deepEqual(await block(admin, 'core'), []);
  assert.equal((await block(admin, 'tco')).filter((a) => a.key.startsWith('HINWEIS:')).length, 1, 'andere Art unberührt');
});

test('Störung: rot gemeldet, nach dem nächsten Erfolg von selbst behoben; Melden verdeckt den eigentlichen Fehler nie', async () => {
  await stoerungMelden(anbindung('D'));
  await stoerungMelden(anbindung('E'));
  let [g] = await block(admin, 'core');
  assert.deepEqual([g.state, g.kinder!.length, g.kinder![0].icon], ['Negative', 2, 'error']);
  await hinweisBeheben('core', 'TEST_STOERUNG', 'D');
  [g] = await block(admin, 'core');
  assert.equal(g.titel, 'Schnittstelle gestört: Anbindung E', 'nur noch eine – ohne Sammeleintrag');
  await hinweisBeheben('core', 'TEST_STOERUNG');
  assert.deepEqual(await block(admin, 'core'), []);
  assert.deepEqual((await sql`select distinct erledigt_von from core.hinweise where objekt in ('D', 'E')`).map((x) => x.erledigt_von), ['behoben']);
  // unbrauchbare Meldung (Farbe gibt es nicht): kein Fehler nach außen, nur ein Vermerk im Log
  const log: string[] = [];
  await stoerungMelden({ ...anbindung('F'), state: 'Lila' as never }, { warn: (_e, text) => { log.push(text); } });
  assert.deepEqual(log, ['Hinweis core/TEST_STOERUNG nicht gespeichert']);
  assert.deepEqual(await block(admin, 'core'), []);
});

test('Überwachter Aufruf einer Schnittstelle: Fehler geht weiter und steht im Arbeitsvorrat, der nächste Erfolg schließt ihn', async () => {
  const h = { modul: 'core', quelle: 'TEST_ABRUF', objekt: 'x', bereich: 'Administration', recht: 'core.settings:edit', art: 'Schnittstelle gestört', titel: 'Probe-Webhook', pfad: '/admin/anbindungen' };
  await assert.rejects(() => ueberwacht(h, async () => { throw new Error('n8n antwortet\nmit HTTP 502'); }), /HTTP 502/);
  let [a] = await block(admin, 'core');
  assert.deepEqual([a.titel, a.text, a.state, a.icon], ['Schnittstelle gestört: Probe-Webhook', 'n8n antwortet mit HTTP 502', 'Negative', 'error']);
  await assert.rejects(() => ueberwacht(h, async () => { throw new Error('Zeitüberschreitung'); }), /Zeitüberschreitung/);
  [a] = await block(admin, 'core');
  assert.deepEqual([a.titel, a.text], ['Schnittstelle gestört: Probe-Webhook (2×)', 'Zeitüberschreitung']);
  assert.equal(await ueberwacht(h, async () => 42), 42, 'das Ergebnis des Aufrufs kommt unverändert zurück');
  assert.deepEqual(await block(admin, 'core'), [], 'behoben');
  // weitere Erfolge fragen die Datenbank nicht mehr: ein von Hand offener Hinweis bleibt stehen, bis wieder eine Störung kam
  await hinweisMelden(HINWEIS_DB, h);
  await ueberwacht(h, async () => 1);
  assert.equal((await block(admin, 'core')).length, 1);
  await assert.rejects(() => ueberwacht(h, async () => { throw new Error('wieder gestört'); }));
  await ueberwacht(h, async () => 1);
  assert.deepEqual(await block(admin, 'core'), []);
});

test('E-Mail nicht gesendet: steht unter „Administration“, zählt hoch, bleibt bis „gesehen“', async () => {
  // Mailversand ist nicht eingerichtet – jeder Versuch scheitert und wird protokolliert
  assert.equal((await admin('POST', '/api/mail/test', { an: 'niemand@example.org' })).status, 400);
  let [a] = await block(admin, 'core');
  assert.deepEqual([a.titel, a.bereich, a.state, a.icon, a.pfad], ['E-Mail nicht gesendet: an niemand@example.org', 'Administration', 'Negative', 'email', '/admin/mailprotokoll']);
  assert.match(a.text, /Testmail aus dem Portal – .*nicht eingerichtet/);
  assert.equal((await admin('POST', '/api/mail/test', { an: 'zweite@example.org' })).status, 400);
  [a] = await block(admin, 'core');
  assert.equal(a.titel, 'E-Mail nicht gesendet: an zweite@example.org (2×)');
  assert.deepEqual(await block(leser, 'core'), [], 'ohne Recht für das E-Mail-Protokoll unsichtbar');
  assert.equal((await admin('POST', a.erledigen!.url, a.erledigen!.body)).status, 200);
  assert.deepEqual(await block(admin, 'core'), []);
});

test('Paperless: Störung je Zugang im Arbeitsvorrat, nach der nächsten Antwort behoben; 4xx ist keine Störung', async () => {
  const antworten: number[] = [];
  const server = http.createServer((req, res) => {
    const status = antworten.shift() ?? 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? JSON.stringify({ id: 7, title: 'Probe' }) : JSON.stringify({ detail: 'nein' }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  try {
    const pl = new Paperless({ url: `http://127.0.0.1:${port}`, token: 'geheim' });
    antworten.push(503);
    await assert.rejects(() => pl.dokument(7), /HTTP 503/);
    let [a] = await block(admin, 'core');
    assert.deepEqual([a.titel, a.bereich, a.state, a.pfad], [`Paperless gestört: 127.0.0.1:${port}`, 'Administration', 'Negative', '/admin/anbindungen']);
    assert.match(a.text, /Paperless-Fehler HTTP 503/);
    antworten.push(401);
    await assert.rejects(() => pl.dokument(7), /lehnt die Anmeldung ab/);
    [a] = await block(admin, 'core');
    assert.match(a.titel, /\(2×\)$/);
    assert.match(a.text, /API-Token prüfen/);
    // Paperless antwortet wieder: Hinweis weg
    assert.equal((await pl.dokument(7)).title, 'Probe');
    assert.deepEqual(await block(admin, 'core'), []);
    // 404 betrifft nur diese Anfrage – keine Störung
    antworten.push(404);
    await assert.rejects(() => pl.dokument(8), /HTTP 404/);
    assert.deepEqual(await block(admin, 'core'), []);
    // nicht erreichbar: eigener Hinweis je Zugang
    const weg = new Paperless({ url: 'http://127.0.0.1:1', token: 'geheim', timeoutMs: 2000 });
    await assert.rejects(() => weg.dokument(1), /nicht erreichbar/);
    [a] = await block(admin, 'core');
    assert.equal(a.titel, 'Paperless gestört: 127.0.0.1:1');
  } finally { server.close(); }
});
