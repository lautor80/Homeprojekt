/**
 * Push-Nachrichten aufs Handy (Web-Push): Geräte an- und abmelden, Arten je Benutzer ein- und ausschalten, Versand
 * verschlüsselt an den Push-Dienst (hier abgefangen), Hinweise im Arbeitsvorrat und Ereignisse des Vereins als Auslöser.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { HINWEIS_DB, hinweisMelden, hinweisPushNach } = await import('../src/lib/hinweise.js');
const { pushTransport, pushAnRecht } = await import('../src/lib/push.js');
const { entschluesseln } = await import('../src/lib/webpush.js');

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
const admin = client(), leser = client(), mia = client();

/** ein Gerät, wie es der Browser anmeldet – mit dem privaten Schlüssel zum Mitlesen im Test */
function geraet(name: string) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys, privat: ecdh.getPrivateKey().toString('base64url'), name };
}
const G_ADMIN = geraet('admin-handy'), G_LESER = geraet('leser-handy'), G_MIA = geraet('mia-handy');
const ALLE = [G_ADMIN, G_LESER, G_MIA];

/** abgefangener Versand: was bei welchem Gerät angekommen wäre (entschlüsselt) */
let post: { an: string; kopf: Record<string, string>; inhalt: { titel: string; text: string; pfad: string; art: string } }[] = [];
let antwort = 201;
const warten = async (bis: () => boolean, ms = 3000) => { const ende = Date.now() + ms; while (!bis() && Date.now() < ende) await new Promise((r) => setTimeout(r, 20)); };
const ruhe = () => new Promise((r) => setTimeout(r, 300));

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'Testverein', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'LESER', name: 'Leser', permissions: ['core.audit:display'] })).status, 200);
  for (const [c, name, rolle] of [[leser, 'leser', 'LESER'], [mia, 'mia', 'MITGLIED']] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: name, displayName: name, password: 'start-passwort', roles: [rolle] })).status, 200);
    assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
    assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  }
  hinweisPushNach(0);
  pushTransport(async (a) => {
    const g = ALLE.find((x) => x.endpoint === a.endpoint)!;
    post.push({ an: g.name, kopf: a.kopf, inhalt: JSON.parse(entschluesseln(a.rumpf, { ...g.keys, privat: g.privat }).toString()) });
    return antwort;
  });
});
after(async () => { pushTransport(); await app?.close(); await sql.end(); });

test('Einstellungen: nur angemeldet; Schlüssel bleibt gleich; Arten je nach Rechten; App-Beschreibung ohne Anmeldung', async () => {
  assert.equal((await client()('GET', '/api/push')).status, 401);
  const m = await client()('GET', '/api/push/manifest');
  assert.equal(m.status, 200);
  assert.equal(m.body.name, 'Testverein');
  assert.equal(m.body.display, 'standalone');
  // Home-Bildschirm: Symbol vom Modul TC Oberthal (Vereinswappen), ohne Anmeldung
  assert.deepEqual(m.body.icons.map((i: { src: string }) => i.src), ['/api/push/symbol-192.png', '/api/push/symbol-512.png']);
  for (const g of [180, 192, 512]) {
    const s = await app.inject({ method: 'GET', url: `/api/push/symbol-${g}.png` });
    assert.equal(s.statusCode, 200, `symbol-${g}`);
    assert.equal(s.headers['content-type'], 'image/png');
    assert.equal(s.rawPayload.readUInt32BE(16), g, 'Breite laut PNG-Kopf');
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/push/symbol-64.png' })).statusCode, 404);

  const a = await admin('GET', '/api/push');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(Buffer.from(a.body.schluessel, 'base64url').length, 65);
  assert.equal((await mia('GET', '/api/push')).body.schluessel, a.body.schluessel);
  assert.deepEqual(a.body.geraete, []);
  const ids = (r: { body: { arten: { id: string }[] } }) => r.body.arten.map((x) => x.id);
  // Administrator: alles; „Sonstige Hinweise“ steht am Ende
  for (const id of ['core:PAPERLESS', 'tco:KAL_EINLADUNG', 'tco:MITGLIEDSANTRAG', 'tco:MG_BANK', 'core:HINWEIS']) assert.ok(ids(a).includes(id), id);
  assert.equal(ids(a).at(-1), 'core:HINWEIS');
  assert.ok(a.body.arten.every((x: { an: boolean }) => x.an), 'ohne Abwahl ist alles eingeschaltet');
  // Mitglied: nur die Arten des Vereinskalenders – nichts aus Verwaltung und Arbeitsvorrat
  assert.deepEqual(ids(await mia('GET', '/api/push')), ['tco:KAL_EINLADUNG', 'tco:KAL_ABSAGE']);
  assert.deepEqual(ids(await leser('GET', '/api/push')), []);
});

test('Gerät anmelden: nur bekannte Push-Dienste und vollständige Schlüssel; Testnachricht kommt verschlüsselt an', async () => {
  const { privat: _p, ...g } = G_ADMIN;
  assert.equal((await admin('POST', '/api/push/geraet', { ...g, endpoint: 'https://intern.example/push' })).status, 400, 'fremde Adresse');
  assert.equal((await admin('POST', '/api/push/geraet', { ...g, endpoint: 'http://localhost:8080/x' })).status, 400);
  assert.equal((await admin('POST', '/api/push/geraet', { ...g, keys: { p256dh: 'AAAA', auth: g.keys.auth } })).status, 400, 'Schlüssel unvollständig');
  let r = await admin('POST', '/api/push/geraet', g);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.geraete.map((x: { name: string; endpoint: string }) => [x.name, x.endpoint]), [['admin-handy', G_ADMIN.endpoint]]);
  // noch einmal anmelden (z. B. nach dem Anmelden aufgefrischt): bleibt ein Gerät
  assert.equal((await admin('POST', '/api/push/geraet', g)).body.geraete.length, 1);

  assert.equal((await leser('POST', '/api/push/test')).status, 400, 'ohne Gerät');
  post = [];
  r = await admin('POST', '/api/push/test');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].inhalt, { titel: 'Testnachricht', text: 'Push-Nachrichten sind auf diesem Gerät eingeschaltet.', pfad: '/', art: 'core:TEST' });
  assert.match(post[0].kopf.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(post[0].kopf['content-encoding'], 'aes128gcm');
  const [z] = await sql`select zuletzt_am, fehler from core.push_geraete where endpoint = ${G_ADMIN.endpoint}`;
  assert.ok(z.zuletzt_am);
});

test('Hinweis im Arbeitsvorrat: Push an alle mit dem Recht – einmal je Hinweis, nicht bei Wiederholung, nicht ohne Recht', async () => {
  const { privat: _p, ...g } = G_LESER;
  assert.equal((await leser('POST', '/api/push/geraet', g)).status, 200);
  const stoerung = (objekt: string) => ({
    modul: 'core', quelle: 'TEST_STOERUNG', objekt, bereich: 'Administration', recht: 'core.settings:edit', art: 'Schnittstelle gestört',
    titel: `Anbindung ${objekt}`, text: 'Verbindung abgelehnt – Einzelheiten nur im Portal', pfad: '/admin/schnittstellen',
  });
  post = [];
  await hinweisMelden(HINWEIS_DB, stoerung('P'));
  await warten(() => post.length > 0);
  await ruhe();
  // nur der Administrator (Leser hat das Recht nicht); kurzer Hinweis ohne den ausführlichen Text
  assert.deepEqual(post.map((p) => [p.an, p.inhalt]), [['admin-handy', { titel: 'Schnittstelle gestört', text: 'Anbindung P', pfad: '/admin/schnittstellen', art: 'core:HINWEIS' }]]);
  await hinweisMelden(HINWEIS_DB, stoerung('P'));
  await ruhe();
  assert.equal(post.length, 1, 'Wiederholung zählt hoch, klingelt aber nicht erneut');

  // zurückgerollte Meldung: kein Hinweis, kein Push
  await assert.rejects(sql.begin(async (tx) => { await hinweisMelden(tx as never, stoerung('ROLLBACK')); throw new Error('abgebrochen'); }));
  await ruhe();
  assert.equal(post.length, 1);

  // Hinweis mit eigener Art im Katalog: „<modul>:<quelle>“
  await hinweisMelden(HINWEIS_DB, { ...stoerung('X'), quelle: 'PAPERLESS', art: 'Paperless gestört' });
  await warten(() => post.length > 1);
  assert.equal(post[1].inhalt.art, 'core:PAPERLESS');
});

test('Abwahl je Art: abgeschaltete Arten kommen nicht an; nur eigene, sichtbare Arten lassen sich schalten', async () => {
  let r = await admin('PUT', '/api/push/arten', { aus: ['core:HINWEIS', 'tco:MG_BANK', 'gibt-es-nicht'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.arten.filter((a: { an: boolean }) => !a.an).map((a: { id: string }) => a.id).sort(), ['core:HINWEIS', 'tco:MG_BANK']);
  // Mitglied: Arten der Verwaltung lassen sich nicht abwählen (sie betreffen es nicht) – eigene schon
  r = await mia('PUT', '/api/push/arten', { aus: ['tco:MG_BANK', 'tco:KAL_ABSAGE'] });
  assert.deepEqual(r.body.arten, [
    { id: 'tco:KAL_EINLADUNG', gruppe: 'Vereinskalender', text: 'Einladung zu einer Veranstaltung', an: true },
    { id: 'tco:KAL_ABSAGE', gruppe: 'Vereinskalender', text: 'Veranstaltung abgesagt', an: false },
  ]);
  assert.equal((await sql`select count(*)::int as n from core.push_abwahl`)[0].n, 3);

  post = [];
  assert.equal(await pushAnRecht('core.settings:edit', 'core:HINWEIS', { titel: 'abgewählt' }), 0);
  assert.equal(await pushAnRecht('core.settings:edit', 'tco:MG_KONTAKT', { titel: 'gewählt' }), 1);
  assert.deepEqual(post.map((p) => p.inhalt.titel), ['gewählt']);
  // die Testnachricht kommt unabhängig von der Abwahl
  assert.equal((await admin('POST', '/api/push/test')).status, 200);

  // wieder alles einschalten
  r = await admin('PUT', '/api/push/arten', { aus: [] });
  assert.ok(r.body.arten.every((a: { an: boolean }) => a.an));
  assert.equal((await mia('PUT', '/api/push/arten', { aus: [] })).status, 200);
});

test('Verein: abgesagte Veranstaltung geht an die Angemeldeten und ihre Familie; neuer Hinweis an den Kassenwart', async () => {
  const MIA = '0000000701', KIND = '0000000702', K = '/api/m/tco/kalender';
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, adrnrkih, geburtsdatum) values
    (${MIA}, 'Mia', 'Matchball', '2022-01-01', null, '1985-05-05'), (${KIND}, 'Kai', 'Matchball', '2022-01-01', ${MIA}, '2014-03-03')`;
  await sql`insert into tco.mitgliedera (adrnr) values (${MIA}) on conflict (adrnr) do nothing`;
  await sql`insert into tco.mitglied_benutzer (benutzer_id, adrnr) select id, ${MIA} from core.users where username = 'mia' on conflict (benutzer_id) do update set adrnr = excluded.adrnr`;
  const { privat: _p, ...g } = G_MIA;
  assert.equal((await mia('POST', '/api/push/geraet', g)).status, 200);

  let r = await admin('POST', K, { titel: 'Jugendturnier', beginn: new Date(Date.now() + 20 * 86_400_000).toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id as number;
  // nur das Kind ist angemeldet – die Nachricht geht an die Mutter (Familie), die den Zugang hat
  assert.equal((await mia('POST', `${K}/${id}/rueckmeldung-familie`, { dabei: [KIND] })).status, 200);
  const e = (await sql`select titel, beginn from tco.kal_events where id = ${id}`)[0];
  post = [];
  r = await admin('PUT', `${K}/${id}`, { titel: e.titel, beginn: new Date(e.beginn).toISOString(), abgesagt: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await warten(() => post.length > 0);
  await ruhe();
  assert.deepEqual(post.map((p) => [p.an, p.inhalt.titel, p.inhalt.art, p.inhalt.pfad]), [['mia-handy', 'Abgesagt: Jugendturnier', 'tco:KAL_ABSAGE', `/tco/kalender?veranstaltung=${id}`]]);
  // noch einmal speichern (bleibt abgesagt): keine zweite Nachricht
  assert.equal((await admin('PUT', `${K}/${id}`, { titel: e.titel, beginn: new Date(e.beginn).toISOString(), abgesagt: true })).status, 200);
  await ruhe();
  assert.equal(post.length, 1);

  // Hinweis des Vereins (Kassenwart): Art „tco:<Quelle>“, an alle mit dem Recht – das Mitglied bekommt ihn nicht
  post = [];
  await hinweisMelden(HINWEIS_DB, { modul: 'tco', quelle: 'MG_BANK', objekt: MIA, bereich: 'Kassenwart', recht: 'tco.mitglieder:display', art: 'Bankverbindung geändert', titel: 'Mia Matchball', pfad: `/tco/mitglieder?adrnr=${MIA}` });
  await warten(() => post.length > 0);
  await ruhe();
  assert.deepEqual(post.map((p) => [p.an, p.inhalt.art, p.inhalt.titel]), [['admin-handy', 'tco:MG_BANK', 'Bankverbindung geändert']]);
});

test('Geräte: abmelden, Wechsel des Benutzers am selben Gerät, vom Push-Dienst abgemeldete Geräte verschwinden', async () => {
  // fremdes Gerät lässt sich nicht abmelden
  assert.equal((await leser('POST', '/api/push/geraet/abmelden', { endpoint: G_ADMIN.endpoint })).body.geraete.length, 1);
  assert.equal((await admin('GET', '/api/push')).body.geraete.length, 1);
  // derselbe Browser, anderer Benutzer: das Gerät gehört danach diesem – der vorige bekommt dort nichts mehr
  const { privat: _p, ...g } = G_ADMIN;
  assert.equal((await leser('POST', '/api/push/geraet', g)).body.geraete.length, 2);
  assert.deepEqual((await admin('GET', '/api/push')).body.geraete, []);
  assert.equal((await leser('POST', '/api/push/geraet/abmelden', { endpoint: G_ADMIN.endpoint })).body.geraete.length, 1);

  // Push-Dienst meldet „gibt es nicht mehr“ (410): Gerät wird ausgetragen
  antwort = 410;
  assert.equal((await leser('POST', '/api/push/test')).status, 400);
  assert.deepEqual((await leser('GET', '/api/push')).body.geraete, []);
  antwort = 201;
});
