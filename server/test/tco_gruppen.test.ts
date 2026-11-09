/**
 * Mitgliedergruppen (Issue #33): Baum der Gruppen (Kategorie → Gruppe → Mannschaft), ein Mitglied in mehreren
 * Gruppen, Pflege in der eigenen App und im Mitgliedsstamm, Filter der Mitgliederliste, Berechtigungen und
 * Zusammenspiel mit dem Vereinskalender (Untergruppen zählen zur Gruppe darüber).
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
const G = '/api/m/tco/gruppen';
const M = '/api/m/tco/mitglieder';
const K = '/api/m/tco/kalender';
const ANNA = '0000000601', BEN = '0000000602', CARL = '0000000603', DORA = '0000000604';
const tage = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const tag = (n: number) => tage(n).slice(0, 10);

async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
const neu = async (name: string, parent_id: number | null = null) => {
  const r = await admin('POST', G, { name, parent_id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
const baum = async () => (await admin('GET', G)).body.gruppen as { id: number; parent_id: number | null; name: string; pfad: string; ebene: number; gesamt: number; mitglieder: { adrnr: string; rolle: string | null }[] }[];

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, mitglnrn, eintritt) values
              (${ANNA}, 'Anna', 'Aufschlag', '601', '2020-01-01'), (${BEN}, 'Ben', 'Netz', '602', '2020-01-01'),
              (${CARL}, 'Carl', 'Linie', '603', '2020-01-01'), (${DORA}, 'Dora', 'Volley', '604', '2020-01-01')`;
  await sql`insert into tco.mitgliedera (adrnr) values (${ANNA}), (${BEN}), (${CARL}), (${DORA})`;
  for (const [id, permissions] of [['GRLESER', ['tco.gruppen:display']], ['MGLESER', ['tco.mitglieder:display']], ['MGPFLEGE', ['tco.mitglieder:display', 'tco.mitglieder:edit']]] as const) {
    assert.equal((await admin('POST', '/api/admin/roles', { id, name: id, permissions })).status, 200);
  }
  for (const [u, roles] of [['grleser', ['GRLESER']], ['mgleser', ['MGLESER']], ['mgpflege', ['MGPFLEGE']], ['anna', ['MITGLIED']], ['ben', ['MITGLIED']]] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles })).status, 200);
  }
  await sql`update tco.mitgliedera set benutzer_id = (select id from core.users where username = 'anna') where adrnr = ${ANNA}`;
  await sql`update tco.mitgliedera set benutzer_id = (select id from core.users where username = 'ben') where adrnr = ${BEN}`;
});
after(async () => { await app?.close(); await sql.end(); });

let spielbetrieb = 0, mannschaften = 0, h40 = 0, ohne = 0, halle = 0;

test('Berechtigungsobjekte', async () => {
  const r = await admin('GET', '/api/admin/permissions');
  assert.ok(JSON.stringify(r.body).includes('tco.gruppen:display') && JSON.stringify(r.body).includes('tco.gruppen:edit'));
});

test('Baum pflegen: Kategorien, Untergruppen, Namen je Ebene, Verschieben', async () => {
  spielbetrieb = await neu('Spielbetrieb');
  mannschaften = await neu('Mannschaftsspieler', spielbetrieb);
  h40 = await neu('Herren 40', mannschaften);
  ohne = await neu('Ohne Teilnahme am Spielbetrieb', spielbetrieb);
  halle = await neu('Reine Hallennutzer');

  // gleicher Name auf derselben Ebene nicht, auf einer anderen schon
  assert.equal((await admin('POST', G, { name: 'herren 40', parent_id: mannschaften })).status, 400);
  const doppelt = await neu('Herren 40', halle);
  assert.equal((await admin('POST', G, { name: '  ' })).status, 400);
  assert.equal((await admin('POST', G, { name: 'x', parent_id: 99999 })).status, 400);

  let b = await baum();
  assert.deepEqual(b.map((g) => `${g.ebene}:${g.pfad}`), [
    '0:Reine Hallennutzer', '1:Reine Hallennutzer › Herren 40',
    '0:Spielbetrieb', '1:Spielbetrieb › Mannschaftsspieler', '2:Spielbetrieb › Mannschaftsspieler › Herren 40', '1:Spielbetrieb › Ohne Teilnahme am Spielbetrieb',
  ]);

  // nicht unter sich selbst oder eine eigene Untergruppe hängen
  assert.equal((await admin('POST', G, { id: spielbetrieb, name: 'Spielbetrieb', parent_id: h40 })).status, 400);
  assert.equal((await admin('POST', G, { id: spielbetrieb, name: 'Spielbetrieb', parent_id: spielbetrieb })).status, 400);
  // verschieben und umbenennen; ohne parent_id bleibt die Ebene
  assert.equal((await admin('POST', G, { id: doppelt, name: 'Hallenrunde', parent_id: null })).status, 200);
  assert.equal((await admin('POST', G, { id: h40, name: 'Herren 40', beschreibung: 'Medenrunde' })).status, 200);
  b = await baum();
  assert.equal(b.find((g) => g.id === doppelt)!.pfad, 'Hallenrunde');
  assert.equal(b.find((g) => g.id === h40)!.pfad, 'Spielbetrieb › Mannschaftsspieler › Herren 40');

  // löschen: nicht mit Untergruppen
  assert.equal((await admin('DELETE', `${G}/${mannschaften}`)).status, 400);
  assert.equal((await admin('DELETE', `${G}/${doppelt}`)).status, 200);
  assert.equal((await admin('DELETE', `${G}/${doppelt}`)).status, 404);
});

test('Mitglieder zuordnen: mehrere Gruppen je Mitglied, Rolle, Zählung mit Untergruppen', async () => {
  let r = await admin('POST', `${G}/${h40}/mitglieder`, { adrnrs: [BEN, CARL] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /2 Mitglieder/);
  // erneut aufnehmen ändert nichts, die Rolle bleibt
  assert.equal((await admin('POST', `${G}/${h40}/mitglieder`, { adrnrs: [BEN], rolle: 'Mannschaftsführer' })).status, 200);
  r = await admin('POST', `${G}/${h40}/mitglieder`, { adrnrs: [BEN, CARL] });
  assert.match(r.body.text, /0 Mitglieder/);
  // Hierarchie: Ben gehört über „Herren 40“ schon zu den Mannschaftsspielern und wird dort nicht noch einmal aufgenommen
  r = await admin('POST', `${G}/${mannschaften}/mitglieder`, { adrnrs: [BEN, DORA] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.neu, r.body.ueberUntergruppe, r.body.ausUebergeordneter], [1, 1, 0]);
  assert.match(r.body.text, /1 Mitglied aufgenommen, 1 nicht – bereits über eine Untergruppe enthalten/);
  assert.equal((await admin('POST', `${G}/${halle}/mitglieder`, { adrnrs: [BEN] })).status, 200);
  assert.equal((await admin('POST', `${G}/${ohne}/mitglieder`, { adrnrs: [ANNA] })).status, 200);
  assert.equal((await admin('POST', `${G}/${halle}/mitglieder`, { adrnrs: ['9999999999'] })).status, 400);
  assert.equal((await admin('POST', `${G}/99999/mitglieder`, { adrnrs: [BEN] })).status, 404);
  assert.equal((await admin('POST', `${G}/${halle}/mitglieder`, { adrnrs: [] })).status, 400);

  const b = await baum();
  const g = (id: number) => b.find((x) => x.id === id)!;
  assert.deepEqual(g(h40).mitglieder.map((m) => [m.adrnr, m.rolle]), [[CARL, null], [BEN, 'Mannschaftsführer']]);
  assert.equal(g(h40).gesamt, 2);
  assert.deepEqual(g(mannschaften).mitglieder.map((m) => m.adrnr), [DORA]);
  assert.equal(g(mannschaften).gesamt, 3, 'Mitglieder der Untergruppe gehören zur Gruppe darüber');
  assert.equal(g(spielbetrieb).mitglieder.length, 0);
  assert.equal(g(spielbetrieb).gesamt, 4);

  // entfernen
  assert.equal((await admin('POST', `${G}/${mannschaften}/mitglieder`, { adrnrs: [DORA], entfernen: true })).status, 200);
  assert.equal((await baum()).find((x) => x.id === spielbetrieb)!.gesamt, 3);
  assert.equal((await admin('GET', `${G}/mitglieder`)).body.length, 4);
});

test('Mitgliedsstamm: Gruppen des Mitglieds, Zuordnung und Filter der Liste', async () => {
  let r = await admin('GET', `${M}/m/${BEN}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.gruppen.map((x: any) => x.id).sort(), [h40, halle].sort());
  assert.equal(r.body.gruppen.find((x: any) => x.id === h40).rolle, 'Mannschaftsführer');

  assert.equal((await admin('POST', `${M}/m/${DORA}/gruppen`, { gruppe: h40, rolle: ' Ersatz ' })).status, 200);
  assert.deepEqual((await admin('GET', `${M}/m/${DORA}`)).body.gruppen, [{ id: h40, rolle: 'Ersatz' }]);
  assert.equal((await admin('POST', `${M}/m/${DORA}/gruppen`, { gruppe: h40, rolle: '' })).status, 200);
  assert.deepEqual((await admin('GET', `${M}/m/${DORA}`)).body.gruppen, [{ id: h40, rolle: null }]);
  assert.equal((await admin('POST', `${M}/m/${DORA}/gruppen`, { gruppe: 99999 })).status, 404);
  assert.equal((await admin('POST', `${M}/m/${DORA}/gruppen`, { gruppe: h40, entfernen: true })).status, 200);
  assert.deepEqual((await admin('GET', `${M}/m/${DORA}`)).body.gruppen, []);

  // Filter: Gruppe einschließlich ihrer Untergruppen
  const namen = async (q: string) => (await admin('GET', `${M}/liste?status=ALLE${q}`)).body.zeilen.map((z: any) => z.adrnr).sort();
  assert.deepEqual(await namen(''), [ANNA, BEN, CARL, DORA]);
  assert.deepEqual(await namen(`&gruppe=${spielbetrieb}`), [ANNA, BEN, CARL]);
  assert.deepEqual(await namen(`&gruppe=${mannschaften}`), [BEN, CARL]);
  assert.deepEqual(await namen(`&gruppe=${halle}`), [BEN]);
  assert.deepEqual(await namen(`&gruppe=${halle}&suche=xyz`), []);
  r = await admin('GET', `${M}/liste?status=ALLE&gruppe=${halle}`);
  assert.equal(r.body.anzahl.ALLE, 4, 'Zähler der Statusauswahl bleiben ungefiltert');
});

test('Hierarchie: je Linie nur eine Zuordnung, parallele Gruppen mehrfach', async () => {
  const direkt = async (adrnr: string) => (await admin('GET', `${M}/m/${adrnr}`)).body.gruppen.map((x: any) => x.id).sort();
  const damen = await neu('Damen', mannschaften);
  // Ausgangslage: Ben in Herren 40 und (parallel) Reine Hallennutzer, Carl in Herren 40, Anna in „Ohne Teilnahme“
  assert.deepEqual(await direkt(BEN), [h40, halle].sort());

  // nach oben: nicht noch einmal in einer Gruppe darüber (Mitgliedsstamm und Gruppen-App, auch zwei Ebenen höher)
  let r = await admin('POST', `${M}/m/${BEN}/gruppen`, { gruppe: mannschaften });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /über die Untergruppe „Herren 40“ bereits zu „Mannschaftsspieler“/);
  assert.equal((await admin('POST', `${M}/m/${BEN}/gruppen`, { gruppe: spielbetrieb })).status, 400);
  r = await admin('POST', `${G}/${spielbetrieb}/mitglieder`, { adrnrs: [BEN, CARL, ANNA] });
  assert.deepEqual([r.body.neu, r.body.ueberUntergruppe], [0, 3]);
  assert.deepEqual(await direkt(BEN), [h40, halle].sort());
  // die Rolle in der eigenen Gruppe bleibt änderbar
  assert.equal((await admin('POST', `${M}/m/${BEN}/gruppen`, { gruppe: h40, rolle: 'Mannschaftsführer' })).status, 200);

  // parallel: Ben zusätzlich in einer Schwestergruppe
  assert.equal((await admin('POST', `${M}/m/${BEN}/gruppen`, { gruppe: damen })).status, 200);
  assert.deepEqual(await direkt(BEN), [h40, halle, damen].sort());
  assert.equal((await admin('POST', `${M}/m/${BEN}/gruppen`, { gruppe: damen, entfernen: true })).status, 200);

  // nach unten: Dora steht in „Mannschaftsspieler“ und kommt in „Damen“ – die Zuordnung darüber entfällt
  assert.equal((await admin('POST', `${M}/m/${DORA}/gruppen`, { gruppe: mannschaften })).status, 200);
  r = await admin('POST', `${M}/m/${DORA}/gruppen`, { gruppe: damen });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /übergeordneten Gruppe entfällt/);
  assert.deepEqual(await direkt(DORA), [damen]);
  // dasselbe gesammelt in der Gruppen-App
  assert.equal((await admin('POST', `${G}/${damen}/mitglieder`, { adrnrs: [DORA], entfernen: true })).status, 200);
  assert.equal((await admin('POST', `${G}/${spielbetrieb}/mitglieder`, { adrnrs: [DORA] })).body.neu, 1);
  r = await admin('POST', `${G}/${damen}/mitglieder`, { adrnrs: [DORA] });
  assert.deepEqual([r.body.neu, r.body.ausUebergeordneter], [1, 1]);
  assert.deepEqual(await direkt(DORA), [damen]);
  let b = await baum();
  assert.equal(b.find((x) => x.id === spielbetrieb)!.gesamt, 4, 'Anna, Ben, Carl, Dora – jede Person einmal');
  assert.equal(b.find((x) => x.id === spielbetrieb)!.mitglieder.length, 0);

  // Verschieben: „Reine Hallennutzer“ (Ben) unter „Herren 40“ – Ben steht danach nur noch in der Untergruppe
  assert.equal((await admin('POST', G, { id: halle, name: 'Reine Hallennutzer', parent_id: h40 })).status, 200);
  assert.deepEqual(await direkt(BEN), [halle]);
  b = await baum();
  assert.deepEqual(b.find((x) => x.id === h40)!.mitglieder.map((m) => m.adrnr), [CARL]);
  assert.equal(b.find((x) => x.id === h40)!.gesamt, 2);
  // zurück auf die oberste Ebene und Ausgangslage wiederherstellen
  assert.equal((await admin('POST', G, { id: halle, name: 'Reine Hallennutzer', parent_id: null })).status, 200);
  assert.equal((await admin('POST', `${M}/m/${BEN}/gruppen`, { gruppe: h40, rolle: 'Mannschaftsführer' })).status, 200);
  assert.equal((await admin('POST', `${G}/${damen}/mitglieder`, { adrnrs: [DORA], entfernen: true })).status, 200);
  assert.equal((await admin('DELETE', `${G}/${damen}`)).status, 200);
  assert.deepEqual(await direkt(BEN), [h40, halle].sort());
  assert.deepEqual(await direkt(DORA), []);
});

test('Berechtigungen: Anzeige, Pflege, Zuordnung im Mitgliedsstamm', async () => {
  const grleser = await anmelden('grleser');
  const mgleser = await anmelden('mgleser');
  const mgpflege = await anmelden('mgpflege');
  const anna = await anmelden('anna');

  let r = await grleser('GET', G);
  assert.equal(r.status, 200);
  assert.equal(r.body.pflege, false);
  assert.equal((await mgleser('GET', G)).status, 200, 'Baum für Reiter und Filter im Mitgliedsstamm');
  assert.equal((await anna('GET', G)).status, 403);
  for (const c of [grleser, mgleser, mgpflege, anna]) {
    assert.equal((await c('POST', G, { name: 'x' })).status, 403);
    assert.equal((await c('DELETE', `${G}/${halle}`)).status, 403);
    assert.equal((await c('POST', `${G}/${halle}/mitglieder`, { adrnrs: [ANNA] })).status, 403);
    assert.equal((await c('GET', `${G}/mitglieder`)).status, 403);
  }
  assert.equal((await mgleser('POST', `${M}/m/${ANNA}/gruppen`, { gruppe: halle })).status, 403);
  assert.equal((await mgpflege('POST', `${M}/m/${ANNA}/gruppen`, { gruppe: halle })).status, 200);
  assert.equal((await mgpflege('POST', `${M}/m/${ANNA}/gruppen`, { gruppe: halle, entfernen: true })).status, 200);
});

test('Vereinskalender: Untergruppen gehören zur Gruppe darüber', async () => {
  // Veranstaltung für die Kategorie „Spielbetrieb“: Anna (Ohne Teilnahme) und Ben (Herren 40) sehen sie, beide sind „offen“
  let r = await admin('POST', K, { titel: 'Saisoneröffnung', beginn: tage(7), gruppen: [spielbetrieb] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const saison = r.body.id;
  r = await admin('POST', K, { titel: 'Medenspiel H40', kategorie: 'MANNSCHAFT', beginn: tage(5), gruppen: [h40] });
  const spiel = r.body.id;

  const anna = client(), ben = client();
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'neues-passwort' })).status, 200);
  assert.equal((await ben('POST', '/api/auth/login', { username: 'ben', password: 'start-passwort' })).status, 200);
  assert.equal((await ben('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);

  r = await anna('GET', `${K}?von=${tag(0)}&bis=${tag(30)}`);
  assert.deepEqual(r.body.events.map((e: any) => e.titel), ['Saisoneröffnung']);
  assert.equal((await anna('POST', `${K}/${spiel}/rueckmeldung`, { status: 'ZUSAGE' })).status, 403);
  r = await ben('GET', `${K}?von=${tag(0)}&bis=${tag(30)}`);
  assert.deepEqual(r.body.events.map((e: any) => e.titel), ['Medenspiel H40', 'Saisoneröffnung']);
  assert.equal((await ben('POST', `${K}/${saison}/rueckmeldung`, { status: 'ZUSAGE' })).status, 200);

  r = await admin('GET', `${K}/${saison}`);
  assert.deepEqual(r.body.teilnehmer.offen.map((x: any) => x.adrnr).sort(), [ANNA, CARL]);
  // Auswahl im Kalender zeigt den Pfad
  r = await admin('GET', `${K}?von=${tag(0)}&bis=${tag(30)}`);
  assert.ok(r.body.gruppen.some((g: any) => g.name === 'Spielbetrieb › Mannschaftsspieler › Herren 40'));

  // Gruppe mit kommender Veranstaltung nicht löschbar; Löschen entfernt die Zuordnungen
  assert.equal((await admin('DELETE', `${G}/${h40}`)).status, 400);
  assert.equal((await admin('DELETE', `${G}/${halle}`)).status, 200);
  assert.deepEqual((await admin('GET', `${M}/m/${BEN}`)).body.gruppen.map((x: any) => x.id), [h40]);
});

test('Änderungsbelege', async () => {
  const [{ n }] = await sql`select count(*)::int as n from core.change_header where object_type = 'KAL_GRUPPE'`;
  assert.ok(n >= 5, `Änderungsbelege zu Gruppen: ${n}`);
});

test('Mitglieder zur Aufnahme: Geschlecht, Jahrgang und Alter für die Filter', async () => {
  const jahr = new Date().getFullYear();
  await sql`update tco.mitglieder set geschlecht = '1', geburtsdatum = ${`${jahr - 45}-01-01`} where adrnr = ${BEN}`;
  await sql`update tco.mitglieder set geschlecht = '2', geburtsdatum = ${`${jahr - 30}-01-01`} where adrnr = ${ANNA}`;
  const r = await admin('GET', `${G}/mitglieder`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const je = new Map((r.body as { adrnr: string; name: string; geschlecht: string; jahrgang: number | null; alter: number | null }[]).map((m) => [m.adrnr, m]));
  assert.deepEqual(je.get(BEN), { adrnr: BEN, name: 'Netz, Ben', geschlecht: 'M', jahrgang: jahr - 45, alter: 45 });
  assert.deepEqual(je.get(ANNA), { adrnr: ANNA, name: 'Aufschlag, Anna', geschlecht: 'W', jahrgang: jahr - 30, alter: 30 });
  // ohne Geburtsdatum und Geschlecht: leer statt 0
  assert.deepEqual(je.get(CARL), { adrnr: CARL, name: 'Linie, Carl', geschlecht: '', jahrgang: null, alter: null });
});
