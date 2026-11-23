/**
 * Integrationstest Spielberichte (Sport → Spielberichte): Spieltage und Meldelisten aus STB.LIGA.NU (eingefügte Tabelle)
 * importieren, Spielbericht erfassen, Freigaben (werden bei Änderung zurückgesetzt), einreichen, sperren, PDF.
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
const { leererBericht } = await import('../../modules/tco/server/sport/spielbericht-logik.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const json = (res.headers['content-type'] ?? '').includes('json');
  return { status: res.statusCode, body: json && res.body ? JSON.parse(res.body) : res.body, raw: res.rawPayload };
}
const B = '/api/m/tco/sport/spielberichte';

// Spielplan wie in STB.LIGA.NU (Tabulator-getrennt, mit Kopfzeile)
const SPIELPLAN = [
  'Tag\tDatum\tUhrzeit\tNr.\tHalle\tPlatz\tLiga\tHeimmannschaft\tGastmannschaft',
  'Sa\t16.05.2026\t11:00\t4711\tAnlage TC Oberthal\t1-3\tHerren 40 Verbandsliga\tTC Oberthal 1\tTC Spielstadt 2',
  'Sa\t30.05.2026\t11:00\t4712\tAnlage Spielstadt\t\tHerren 40 Verbandsliga\tTC Spielstadt 2\tTC Oberthal 1',
  'Sa\t31.02.2026\t11:00\t4713\t\t\tHerren 40 Verbandsliga\tTC Oberthal 1\tTC Irgendwo',
].join('\n');
const liste = (praefix: string, idStart: number) => ['Rang\tMannschaft\tLK\tID-Nummer\tName, Vorname\tNation',
  ...[1, 2, 3, 4, 5, 6, 7].map((r) => `${r}\t${r <= 6 ? 1 : 2}\tLK ${10 + r},0\t${idStart + r}\t${praefix}${r}, Spieler\tGER`)].join('\n');

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => { await app?.close(); await sql.end(); });

let spieltag = 0;

test('Spieltage: Vorschau erkennt neu/Fehler, Import legt an, erneuter Import aktualisiert', async () => {
  const v = await call('POST', `${B}/spieltage/vorschau`, { text: SPIELPLAN });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(v.body.zeilen.map((z: { status: string }) => z.status), ['neu', 'neu', 'fehler']);
  assert.equal(v.body.zeilen[0].saison, 'Sommer 2026');
  const ok = v.body.zeilen.filter((z: { status: string }) => z.status !== 'fehler');
  const r = await call('POST', `${B}/spieltage`, { zeilen: ok });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /2 Spieltage angelegt, 0 aktualisiert/);
  const v2 = await call('POST', `${B}/spieltage/vorschau`, { text: SPIELPLAN.replace('11:00\t4711', '12:00\t4711') });
  assert.equal(v2.body.zeilen[0].status, 'vorhanden');
  const r2 = await call('POST', `${B}/spieltage`, { zeilen: [v2.body.zeilen[0]] });
  assert.match(r2.body.text, /0 Spieltage angelegt, 1 aktualisiert/);
  const l = await call('GET', `${B}/spieltage`);
  assert.equal(l.body.zeilen.length, 2);
  const heim = l.body.zeilen.find((z: { heim: string }) => z.heim === 'TC Oberthal 1');
  assert.equal(heim.uhrzeit, '12:00');
  assert.equal(heim.status, 'kein');
  spieltag = heim.id;
});

test('Meldelisten: Vorschau, Speichern, Fehler, Zuordnung zum Spieltag über Verein und Konkurrenz', async () => {
  const v = await call('POST', `${B}/meldelisten/vorschau`, { text: `Herren 40\n${liste('Heim', 18100000)}` });
  assert.equal(v.body.konkurrenz, 'Herren 40');
  assert.equal(v.body.spieler.length, 7);
  const f = await call('POST', `${B}/meldelisten`, { saison: 'Sommer 2026', verein: 'TC Oberthal', konkurrenz: 'Herren 40', text: `${liste('Heim', 18100000)}\n1\t1\tLK 9\t18199999\tDoppelt, Dora\tGER` });
  assert.equal(f.status, 400);
  assert.match(f.body.message, /Rang 1 kommt doppelt/);
  for (const [verein, p, idStart] of [['TC Oberthal', 'Heim', 18100000], ['TC Spielstadt', 'Gast', 18200000]] as const) {
    const r = await call('POST', `${B}/meldelisten`, { saison: 'Sommer 2026', verein, konkurrenz: 'Herren 40', text: liste(p, idStart) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.text, /7 Spielern gespeichert/);
  }
  // erneuter Import ersetzt die Liste
  const r = await call('POST', `${B}/meldelisten`, { saison: 'Sommer 2026', verein: 'TC Oberthal', konkurrenz: 'Herren 40', text: liste('Heim', 18100000) });
  const ls = await call('GET', `${B}/meldelisten`);
  assert.equal(ls.body.length, 2);
  const d = await call('GET', `${B}/meldelisten/${r.body.id}`);
  assert.equal(d.body.spieler.length, 7);
  assert.equal(d.body.spieler[6].mannschaft, 2);
  const sp = await call('GET', `${B}/spieltage`);
  const z = sp.body.zeilen.find((x: { id: number }) => x.id === spieltag);
  assert.ok(z.listeHeim && z.listeGast, 'beide Meldelisten zugeordnet');
});

function ausgefuellt(heim: { rang: number; name: string; id_nr: string; mannschaft: number }[], gast: typeof heim) {
  const d = leererBericht('6er');
  d.beginn = '11:00'; d.ende = '17:45'; d.zuschauer = 40;
  d.einzel.forEach((m, i) => { m.a = [heim[i]]; m.b = [gast[i]]; m.saetze = [[6, 3], [6, 4], [null, null]]; });
  const paare = [[0, 2], [1, 3], [4, 5]];
  d.doppel.forEach((m, i) => { m.a = paare[i].map((k) => heim[k]); m.b = paare[i].map((k) => gast[k]); m.saetze = [[4, 6], [3, 6], [null, null]]; });
  return d;
}

test('Spielbericht: erfassen, freigeben, Änderung setzt Freigaben zurück, einreichen, sperren, PDF, zurücknehmen', async () => {
  const g = await call('GET', `${B}/${spieltag}`);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.gespeichert, false);
  assert.equal(g.body.heim.spieler.length, 7);
  assert.equal(g.body.heim.spieler[0].name, 'Spieler Heim1');
  assert.equal(g.body.gast.nr, 2);
  const d = ausgefuellt(g.body.heim.spieler, g.body.gast.spieler);

  assert.equal((await call('POST', `${B}/${spieltag}/freigabe`, { rolle: 'heim', name: 'Max Muster' })).status, 400, 'erst sichern');
  const s = await call('PUT', `${B}/${spieltag}`, { daten: d });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await call('PUT', `${B}/${spieltag}`, { daten: d })).body.text, 'Keine Änderungen.');

  // einreichen ohne Freigaben → Liste der offenen Punkte
  const e1 = await call('POST', `${B}/${spieltag}/einreichen`);
  assert.equal(e1.status, 400);
  assert.match(e1.body.message, /beide Mannschaftsführer/);

  assert.equal((await call('POST', `${B}/${spieltag}/freigabe`, { rolle: 'heim', name: 'Max Muster' })).status, 200);
  assert.equal((await call('POST', `${B}/${spieltag}/freigabe`, { rolle: 'gast', name: 'Gerd Gast' })).status, 200);
  // Änderung am Ergebnis → Freigaben weg
  d.einzel[5].saetze = [[6, 3], [3, 6], [10, 8]];
  const s2 = await call('PUT', `${B}/${spieltag}`, { daten: d });
  assert.match(s2.body.text, /Freigaben wurden zurückgesetzt/);
  let b = await call('GET', `${B}/${spieltag}`);
  assert.equal(b.body.freigaben.heim, null);

  // ungültiges Ergebnis verhindert das Einreichen
  d.einzel[0].saetze = [[6, 5], [6, 4], [null, null]];
  await call('PUT', `${B}/${spieltag}`, { daten: d });
  await call('POST', `${B}/${spieltag}/freigabe`, { rolle: 'heim', name: 'Max Muster' });
  await call('POST', `${B}/${spieltag}/freigabe`, { rolle: 'gast', name: 'Gerd Gast' });
  assert.match((await call('POST', `${B}/${spieltag}/einreichen`)).body.message, /Ergebnisse gültig/);

  d.einzel[0].saetze = [[6, 3], [6, 4], [null, null]];
  await call('PUT', `${B}/${spieltag}`, { daten: d });
  await call('POST', `${B}/${spieltag}/freigabe`, { rolle: 'heim', name: 'Max Muster' });
  await call('POST', `${B}/${spieltag}/freigabe`, { rolle: 'gast', name: 'Gerd Gast' });
  const e2 = await call('POST', `${B}/${spieltag}/einreichen`);
  assert.equal(e2.status, 200, JSON.stringify(e2.body));
  assert.match(e2.body.text, /\(6:3\) eingereicht/);

  b = await call('GET', `${B}/${spieltag}`);
  assert.equal(b.body.status, 'eingereicht');
  assert.equal(b.body.freigaben.gast.name, 'Gerd Gast');
  assert.equal((await call('PUT', `${B}/${spieltag}`, { daten: d })).status, 400, 'eingereicht = gesperrt');
  const liste2 = await call('GET', `${B}/spieltage`);
  const z = liste2.body.zeilen.find((x: { id: number }) => x.id === spieltag);
  assert.deepEqual([z.status, z.punkte], ['eingereicht', [6, 3]]);

  const pdf = await call('GET', `${B}/${spieltag}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.raw.subarray(0, 4).toString(), '%PDF');

  assert.equal((await call('DELETE', `${B}/spieltage/${spieltag}`)).status, 400, 'Spieltag mit Bericht bleibt');
  assert.equal((await call('POST', `${B}/${spieltag}/zuruecknehmen`)).status, 200);
  assert.equal((await call('GET', `${B}/${spieltag}`)).body.status, 'entwurf');
  const [beleg] = await sql`select count(*)::int as n from core.change_header where object_type = 'SPIELBERICHT'`;
  assert.ok(beleg.n > 0, 'Änderungsbelege geschrieben');
});

test('Rechte: Sportwart bekommt alle drei Rechte der App', async () => {
  const [r] = await sql`select count(*)::int as n from core.role_permissions where role_id = 'SPORTWART' and permission like 'tco.spielbericht:%'`;
  assert.equal(r.n, 3);
});
