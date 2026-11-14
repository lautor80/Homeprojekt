/**
 * Integrationstest Funktionsschalter (#232, F1; Administration → Einstellungen → Funktionen):
 * Verzeichnis, Abschalten von Funktion, App, Bereich und Anwendung, Wirkung auf Rechte (auch für den Administrator),
 * auf Routen und auf die Sitzung der Oberfläche, Folgen über vorausgesetzte Rechte, Schutz der Administration,
 * Änderungsbeleg, verwaiste Einträge.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco,transport';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { alleKnoten, baum, berechnen, folgen, routenSchluessel, schalterVergessen } = await import('../src/lib/funktionen.js');
const { appAktiv, appId, bereichId, funktionAktiv, modulId, rechtAbgeschaltet } = await import('../src/funktionsschalter.js');
const { hasPermission } = await import('../src/permissions.js');

interface Knoten { id: string; art: string; text: string; fest?: string; aktiv: boolean; wirksam: boolean; folgen: string[]; betroffen?: string; kinder: Knoten[] }

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown, ohneAnmeldung = false) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: ohneAnmeldung ? { 'x-portal-request': '1' } : { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set && !ohneAnmeldung) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}
const schalten = (id: string, aktiv: boolean) => call('PUT', '/api/funktionen', { id, aktiv });
const flach = (k: Knoten[]): Knoten[] => k.flatMap((x) => [x, ...flach(x.kinder)]);
const knoten = async (id: string) => {
  const r = await call('GET', '/api/funktionen');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k = flach(r.body.baum as Knoten[]).find((x) => x.id === id);
  assert.ok(k, `Knoten ${id} im Verzeichnis`);
  return k;
};
const ich = async () => (await call('GET', '/api/auth/me')).body as { permissions: string[]; aus: { rechte: string[]; ids: string[] } };

const EP3 = 'tco.halle.ep3import';
const ABGLEICH = '/api/m/tco/halle/import/abgleich';

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => {
  await app?.close();
  await sql.end();
});

test('Verzeichnis: Anwendung → Bereich → App → Funktion, alles an, Administration nur App für App', async () => {
  const r = await call('GET', '/api/funktionen');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const wurzeln = r.body.baum as Knoten[];
  assert.deepEqual(wurzeln.map((k) => k.id), [modulId('core'), modulId('transport'), modulId('tco')]);
  assert.deepEqual(r.body.verwaist, []);
  const alle = flach(wurzeln);
  assert.ok(alle.every((k) => k.aktiv && k.wirksam), 'frisch ist alles an');
  assert.ok(alle.every((k) => !k.betroffen), 'nichts betroffen');

  // Stufen
  const tco = wurzeln.find((k) => k.id === modulId('tco'))!;
  assert.equal(tco.art, 'modul');
  const halle = tco.kinder.find((k) => k.id === bereichId('tco', 'Tennishalle'))!;
  assert.equal(halle.art, 'bereich');
  const abr = halle.kinder.find((k) => k.id === appId('tco', 'Hallenabrechnung'))!;
  assert.equal(abr.art, 'app');
  assert.deepEqual(abr.kinder.map((k) => [k.id, k.art, k.text]), [[EP3, 'funktion', 'EP3-Import']]);
  assert.ok(abr.folgen.includes('Hallenpreise'), `Hallenpreise setzt „Hallenabrechnung anzeigen“ voraus: ${abr.folgen}`);
  const fi = alle.find((k) => k.id === appId('tco', 'FI-Belege'))!;
  assert.deepEqual(fi.kinder.map((k) => k.id), ['tco.fi.bankimport', 'tco.fi.manuell', 'tco.fi.geldkonto', 'tco.fi.storno', 'tco.fi.periode']);

  // Administration: Anwendung und Bereiche fest, dazu die Apps, ohne die sich das Portal nicht verwalten ließe
  const kern = wurzeln[0];
  assert.ok(kern.fest && kern.kinder.every((b) => b.fest), 'Administration und ihre Bereiche sind nicht abschaltbar');
  const fest = flach(kern.kinder).filter((k) => k.art === 'app' && k.fest).map((k) => k.text).sort();
  assert.deepEqual(fest, ['Benutzer', 'Einstellungen', 'Funktionen', 'Rollen und Rollenmatrix', 'Sicherung']);
  assert.ok(!alle.find((k) => k.id === appId('core', 'Tabellenansicht'))!.fest, 'Tabellenansicht ist abschaltbar');

  // ohne Anmeldung bzw. ohne Recht kein Zugriff
  assert.equal((await call('GET', '/api/funktionen', undefined, true)).status, 401);
  assert.equal((await call('PUT', '/api/funktionen', { id: EP3, aktiv: false }, true)).status, 401);
});

test('Funktion abschalten: Route wird abgewiesen, Sitzung meldet es, der Rest der App läuft weiter', async () => {
  assert.notEqual((await call('GET', ABGLEICH)).status, 403, 'vorher erreichbar');
  let r = await schalten(EP3, false);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let k = flach(r.body.baum as Knoten[]).find((x) => x.id === EP3)!;
  assert.deepEqual([k.aktiv, k.wirksam], [false, false]);
  assert.equal(funktionAktiv(EP3), false);

  // alle vier Routen der Funktion, auch für den Administrator
  for (const [m, p] of [['GET', ABGLEICH], ['GET', '/api/m/tco/halle/import/info'], ['POST', '/api/m/tco/halle/import/n8n'], ['POST', '/api/m/tco/halle/import/datei']]) {
    r = await call(m, p, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 403, `${m} ${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'FUNKTION_AUS');
    assert.match(r.body.message, /„EP3-Import“ ist abgeschaltet/);
  }
  // die App selbst und ihre Rechte bleiben
  const me = await ich();
  assert.ok(me.aus.ids.includes(EP3));
  assert.deepEqual(me.aus.rechte, [], 'EP3-Import hat kein eigenes Recht');
  assert.notEqual((await call('GET', '/api/m/tco/fi/init')).status, 403);
  assert.equal(appAktiv('tco', 'Hallenabrechnung'), true);

  // Änderungsbeleg
  const belege = await sql`select h.action, h.reason, i.field, i.new_value from core.change_item i join core.change_header h on h.id = i.header_id
                           where h.object_type = 'FUNKTION' and h.object_key = ${EP3}`;
  assert.ok(belege.some((b) => b.field === 'aktiv' && String(b.new_value) === 'false'), `Änderungsbeleg: ${JSON.stringify(belege)}`);
  assert.ok(belege.some((b) => b.action === 'FUNKTION_AUS' && b.reason === 'EP3-Import'));

  // der Stand überlebt das Neuladen (z. B. nach einem Neustart)
  schalterVergessen();
  assert.equal((await call('GET', ABGLEICH)).status, 403);

  // wieder einschalten stellt alles her
  r = await schalten(EP3, true);
  k = flach(r.body.baum as Knoten[]).find((x) => x.id === EP3)!;
  assert.deepEqual([k.aktiv, k.wirksam], [true, true]);
  assert.notEqual((await call('GET', ABGLEICH)).status, 403);
  assert.deepEqual((await ich()).aus, { rechte: [], ids: [] });
});

test('Funktion mit eigenem Recht: das Recht hat niemand mehr – auch der Administrator nicht', async () => {
  assert.ok((await ich()).permissions.includes('*'), 'Administrator hat „*“');
  await schalten('tco.fi.geldkonto', false);
  assert.equal(rechtAbgeschaltet('tco.fi:geldkonto'), true);
  assert.equal(hasPermission(new Set(['*']), 'tco.fi:geldkonto'), false);
  assert.equal(hasPermission(new Set(['tco.fi:*']), 'tco.fi:geldkonto'), false);
  assert.equal(hasPermission(new Set(['*']), 'tco.fi:display'), true);
  const r = await call('POST', '/api/m/tco/fi/geldkonto/tauschen', {});
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.code, 'FUNKTION_AUS');
  assert.deepEqual((await ich()).aus, { rechte: ['tco.fi:geldkonto'], ids: ['tco.fi.geldkonto'] });
  assert.notEqual((await call('GET', '/api/m/tco/fi/init')).status, 403, 'FI-Belege selbst laufen weiter');
  await schalten('tco.fi.geldkonto', true);
  assert.equal(hasPermission(new Set(['*']), 'tco.fi:geldkonto'), true);
});

test('App abschalten: alle Rechte der App, alles darunter und was ihre Rechte voraussetzt', async () => {
  const id = appId('tco', 'Hallenabrechnung');
  const r = await schalten(id, false);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = await ich();
  assert.ok(me.aus.ids.includes(id) && me.aus.ids.includes(EP3), 'App und ihre Funktion sind aus');
  assert.ok(me.aus.rechte.includes('tco.halle:display') && me.aus.rechte.includes('tco.halle:edit'));
  assert.ok(me.aus.rechte.includes('tco.halle:preise'), 'Hallenpreise pflegen setzt Hallenabrechnung anzeigen voraus');
  assert.equal(appAktiv('tco', 'Hallenabrechnung'), false);
  assert.equal(funktionAktiv(EP3), false);

  // Funktion darunter: eigener Schalter unverändert, aber nicht wirksam
  const ep3 = await knoten(EP3);
  assert.deepEqual([ep3.aktiv, ep3.wirksam], [true, false]);
  // Hallenpreise ist selbst an, aber ohne nutzbare Rechte
  const preise = await knoten(appId('tco', 'Hallenpreise'));
  assert.deepEqual([preise.aktiv, preise.wirksam, preise.betroffen], [true, true, 'ganz']);

  const abgewiesen = await call('GET', ABGLEICH);
  assert.equal(abgewiesen.status, 403);
  assert.equal(abgewiesen.body.code, 'FUNKTION_AUS');
  assert.notEqual((await call('GET', '/api/m/tco/fi/init')).status, 403, 'andere Apps laufen weiter');

  await schalten(id, true);
  assert.deepEqual((await ich()).aus, { rechte: [], ids: [] });
  assert.equal((await knoten(appId('tco', 'Hallenpreise'))).betroffen, undefined);
});

test('Bereich und Anwendung abschalten: gilt für alles darunter', async () => {
  await schalten(bereichId('tco', 'Clubhaus'), false);
  let me = await ich();
  for (const a of ['Clubhausabrechnung', 'Mein Verzehr', 'Theke', 'Verzehrbuch']) {
    assert.ok(me.aus.ids.includes(appId('tco', a)), `${a} ist mit aus`);
    assert.equal(appAktiv('tco', a), false);
  }
  assert.equal(appAktiv('tco', 'Mitglieder'), true);
  await schalten(bereichId('tco', 'Clubhaus'), true);

  await schalten(modulId('transport'), false);
  me = await ich();
  assert.ok(me.aus.ids.includes(appId('transport', 'Aufträge')) && me.aus.ids.includes('transport.import'));
  assert.ok(me.aus.rechte.includes('transport.auftraege:display'));
  const r = await call('GET', '/api/m/transport/auftraege');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'FUNKTION_AUS');
  assert.equal(funktionAktiv(modulId('tco')), true, 'das Vereinsmodul bleibt an');
  assert.notEqual((await call('GET', '/api/m/tco/fi/init')).status, 403);
  await schalten(modulId('transport'), true);
  assert.notEqual((await call('GET', '/api/m/transport/auftraege')).status, 403);
});

test('Schutz: Administration, unbekannte und verwaiste Einträge', async () => {
  for (const id of [modulId('core'), bereichId('core', 'System'), appId('core', 'Benutzer'), appId('core', 'Funktionen'), appId('core', 'Sicherung')]) {
    const r = await schalten(id, false);
    assert.equal(r.status, 400, `${id}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, /lässt sich nicht abschalten/);
  }
  assert.equal((await schalten('tco.gibt.es.nicht', false)).status, 404);

  // eine abschaltbare App der Administration
  await schalten(appId('core', 'Tabellenansicht'), false);
  assert.equal((await call('GET', '/api/admin/tabellen')).status, 403);
  await schalten(appId('core', 'Tabellenansicht'), true);

  // verwaist: abgeschaltet, aber nicht mehr im Verzeichnis – ohne Wirkung, lässt sich entfernen
  await sql`insert into core.funktionen (id, aktiv) values ('tco.frueher.einmal', false)`;
  let r = await call('GET', '/api/funktionen');
  assert.deepEqual(r.body.verwaist, ['tco.frueher.einmal']);
  assert.deepEqual((await ich()).aus, { rechte: [], ids: [] });
  r = await schalten('tco.frueher.einmal', true);
  assert.deepEqual(r.body.verwaist, []);
});

test('Berechnung ohne Datenbank: Hülle über vorausgesetzte Rechte, Routenschlüssel, Folgen', () => {
  const wurzeln = baum();
  const alle = alleKnoten(wurzeln);
  // Ids eindeutig
  assert.equal(new Set(alle.map((k) => k.id)).size, alle.length);
  assert.equal(routenSchluessel('tco', 'post /fi/bank/lesen'), 'POST /api/m/tco/fi/bank/lesen');
  assert.equal(routenSchluessel('core', 'GET /api/x'), 'GET /api/x');

  const z = berechnen(new Set(['tco.fi.bankimport', appId('tco', 'Mitglieder')]), wurzeln);
  assert.equal(z.routen.get('POST /api/m/tco/fi/bank/lesen'), 'Bankimport');
  assert.ok(z.rechte.has('tco.mitglieder:display') && z.rechte.has('tco.mitglieder:edit'));
  assert.ok(!z.rechte.has('tco.fi:display'), 'Bankimport nimmt den FI-Belegen kein Recht');
  // feste Knoten lassen sich auch rechnerisch nicht abschalten
  const fest = berechnen(new Set([modulId('core'), appId('core', 'Benutzer')]), wurzeln);
  assert.deepEqual([fest.ids.size, fest.rechte.size, fest.routen.size], [0, 0, 0]);
  // Folgen nennen nur Apps außerhalb des Knotens
  const mitglieder = alle.find((k) => k.id === appId('tco', 'Mitglieder'))!;
  assert.ok(!folgen(mitglieder, wurzeln).some((f) => f.startsWith('Mitglieder ') || f === 'Mitglieder'));
});
