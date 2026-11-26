/**
 * Euroflex „Auftrag aus Beleg“: Routen mit Datenbank – Migration (Leseprofile), Rechte, Funktionsschalter, Leseprofile lesen
 * und ändern, Dokument aus dem Posteingang. Die Texterkennung der Dateien (pdftotext, tesseract) wird hier nicht gebraucht:
 * gelesen wird der im Posteingang gespeicherte Text. Auf konkrete Erkennungsergebnisse verlässt sich der Test nicht
 * (die stehen in transport_belegerkennung.test.ts, der Abgleich in transport_belegabgleich.test.ts). Alle Namen sind erfunden.
 *   TEST_DATABASE_URL=postgres://portal:portal@localhost:5432/portal_test npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const mitDb = !!url && /test/i.test(url.split('/').pop() ?? '');
const ohneDb = { skip: mitDb ? false : 'TEST_DATABASE_URL fehlt – Routen nur mit Datenbank' };

type Db = typeof import('../src/db.js');
let sql: Db['sql'];
let app: Awaited<ReturnType<typeof import('../src/app.js')['buildApp']>>;
let cookie = '';
const T = '/api/m/transport';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

interface Antwort { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any
async function admin(method: string, path: string, payload?: unknown): Promise<Antwort> {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') && res.body ? JSON.parse(res.body) : res.body };
}
/** Rolle und Benutzer anlegen, anmelden, Startpasswort ändern – liefert den Aufruf im Namen dieses Benutzers */
async function anmelden(rolle: string, rechte: string[]) {
  assert.equal((await admin('POST', '/api/admin/roles', { id: rolle, name: rolle, permissions: rechte })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: rolle.toLowerCase(), displayName: rolle, password: 'start-passwort', roles: [rolle] })).status, 200);
  let eigen = '';
  const als = async (method: string, path: string, payload?: unknown): Promise<Antwort> => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie: eigen, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) eigen = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') && res.body ? JSON.parse(res.body) : res.body };
  };
  assert.equal((await als('POST', '/api/auth/login', { username: rolle.toLowerCase(), password: 'start-passwort' })).status, 200);
  assert.equal((await als('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort-1' })).status, 200);
  return als;
}
const schalten = (id: string, aktiv: boolean) => admin('PUT', '/api/funktionen', { id, aktiv });

const BELEGTEXT = [
  'Beispielholz GmbH & Co. KG', 'Erfundene Straße 1', '12345 Musterstadt', '',
  'Transportauftrag Nr. PO-88201', 'Ladestelle: Lager Erfunden, 12345 Musterstadt, Ladedatum 01.04.2099',
  'Entladestelle: Empfang Ausgedacht, 54321 Nirgendheim', 'Fracht: 850,00 EUR', 'Fahrzeug: Planenauflieger',
].join('\n');
let dokMitText = 0;
let dokOhneAlles = 0;
let dokKeinBeleg = 0;

before(async () => {
  if (!mitDb) return;
  process.env.DATABASE_URL = url;
  process.env.PORTAL_MODULES = 'transport';
  ({ sql } = await import('../src/db.js'));
  const { migrate } = await import('../src/migrate.js');
  const { activeModules } = await import('../src/modules.js');
  const { buildApp } = await import('../src/app.js');
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'Euroflex', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });

  await sql`insert into transport.adressen (adrnr, kundenname, plz, ort) values
              (990201, 'Beispielholz GmbH & Co. KG', '12345', 'Musterstadt'), (990202, 'Spedition Erfunden', '54321', 'Nirgendheim')`;
  await sql`insert into transport.auftraege (auftragsnr, kunde, ordernummer) values ('2099_8201', 990201, 'PO-88201')`;
  const [v] = await sql`insert into transport.eing_vorgaenge (postfach, message_id, von, betreff, status)
                        values ('auftraege@beleg-test.test', 'beleg-1@kunde-beleg.test', 'einkauf@kunde-beleg.test', 'Transportauftrag PO-88201', 'pruefen') returning id`;
  const dok = async (datei: string, inhalt: string | null, ocr: string | null) => {
    const [d] = await sql`insert into transport.eing_dokumente (vorgang_id, art, datei, mime, groesse, inhalt, ocr_text, status)
                          values (${v.id}, 'anhang', ${datei}, 'application/pdf', 10, ${inhalt}, ${ocr}, 'neu') returning id::int as id`;
    return d.id as number;
  };
  // Inhalt schon gelöscht, Text aus dem Eingang noch da → wird wiederverwendet (keine Texterkennung nötig)
  dokMitText = await dok('Transportauftrag.pdf', null, BELEGTEXT);
  dokOhneAlles = await dok('Leer.pdf', null, null);
  // Inhalt ohne gespeicherten Text, aber weder PDF noch Bild
  dokKeinBeleg = await dok('Notiz.txt', b64('nur eine Notiz'), null);
});
after(async () => {
  if (!mitDb) return;
  await app?.close();
  await sql.end();
});

test('Migration: drei Leseprofile, Änderungsbelege eingerichtet', ohneDb, async () => {
  const rows = await sql`select layout, bezeichnung, aktiv, kunde from transport.beleg_profile order by layout`;
  assert.deepEqual(rows.map((r) => [r.layout, r.bezeichnung, r.aktiv, r.kunde]), [
    ['allgemein', 'Allgemein (Schlagworte)', true, null],
    ['bestellung', 'Bestellung über Frachtkosten', true, null],
    ['ladeauftrag', 'Ladeauftrag / Transportauftrag', true, null],
  ]);
  const [t] = await sql`select count(*)::int as n from pg_trigger where tgrelid = 'transport.beleg_profile'::regclass and tgname = 'zz_audit'`;
  assert.equal(t.n, 1);
  const { permissionCatalog } = await import('../src/modules.js');
  const ids = permissionCatalog().flatMap((g) => g.permissions.map((p) => p.id));
  for (const p of ['transport.belegerfassung:create', 'transport.belegeingang:create', 'transport.leseprofile:edit']) assert.ok(ids.includes(p), `${p} fehlt im Katalog`);
});

test('Recht fehlt → abgewiesen (jede Route mit ihrem eigenen Recht)', ohneDb, async () => {
  // darf Aufträge und Posteingang bearbeiten und Stammdaten pflegen – aber keines der drei neuen Rechte
  const ohne = await anmelden('BELEGOHNE', ['transport.auftraege:display', 'transport.auftraege:edit', 'transport.eingang:display', 'transport.eingang:edit', 'transport.stammdaten:edit']);
  let r = await ohne('POST', `${T}/auftraege/beleg/erkennen`, { name: 'a.pdf', inhalt: b64('%PDF-1.4 x') });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.match(r.body.message, /transport\.belegerfassung:create/);
  r = await ohne('POST', `${T}/eingang/dokumente/${dokMitText}/beleg`);
  assert.equal(r.status, 403);
  assert.match(r.body.message, /transport\.belegeingang:create/);
  r = await ohne('GET', `${T}/beleg/profile`);
  assert.equal(r.status, 403);
  assert.match(r.body.message, /transport\.leseprofile:edit/);
  r = await ohne('PUT', `${T}/beleg/profile/bestellung`, { bezeichnung: 'X', aktiv: false, kunde: null });
  assert.equal(r.status, 403);
  // „Auftrag aus Posteingang“ ohne das Recht, den Posteingang zu bearbeiten: das Dokument bleibt verschlossen
  const halb = await anmelden('BELEGHALB', ['transport.auftraege:display', 'transport.auftraege:edit', 'transport.belegeingang:create']);
  r = await halb('POST', `${T}/eingang/dokumente/${dokMitText}/beleg`);
  assert.equal(r.status, 403);
  assert.match(r.body.message, /transport\.eingang:edit/);
  // ohne Anmeldung
  const anonym = await app.inject({ method: 'POST', url: `${T}/auftraege/beleg/erkennen`, payload: { name: 'a.pdf', inhalt: 'x' }, headers: { 'x-portal-request': '1' } });
  assert.equal(anonym.statusCode, 401);
  const [p] = await sql`select bezeichnung, aktiv from transport.beleg_profile where layout = 'bestellung'`;
  assert.deepEqual([p.bezeichnung, p.aktiv], ['Bestellung über Frachtkosten', true], 'nichts geändert');
});

test('Funktion aus → abgewiesen, auch für den Administrator; wieder an → erreichbar', ohneDb, async () => {
  const routen: [string, string, string, unknown?][] = [
    ['transport.beleg.erfassung', 'POST', `${T}/auftraege/beleg/erkennen`, { name: 'a.txt', inhalt: b64('kein Beleg') }],
    ['transport.beleg.eingang', 'POST', `${T}/eingang/dokumente/${dokOhneAlles}/beleg`],
    ['transport.beleg.profile', 'GET', `${T}/beleg/profile`],
    ['transport.beleg.profile', 'PUT', `${T}/beleg/profile/bestellung`, { bezeichnung: 'X', aktiv: true, kunde: 1 }],
  ];
  for (const [id, methode, pfad, body] of routen) {
    assert.equal((await schalten(id, false)).status, 200, id);
    const aus = await admin(methode, pfad, body);
    assert.equal(aus.status, 403, `${methode} ${pfad}: ${JSON.stringify(aus.body)}`);
    assert.equal(aus.body.code, 'FUNKTION_AUS');
    assert.equal((await schalten(id, true)).status, 200, id);
    const an = await admin(methode, pfad, body);
    assert.notEqual(an.status, 403, `${methode} ${pfad}: ${JSON.stringify(an.body)}`);
    assert.notEqual(an.status, 500, `${methode} ${pfad}: ${JSON.stringify(an.body)}`);
  }
  const [p] = await sql`select bezeichnung from transport.beleg_profile where layout = 'bestellung'`;
  assert.equal(p.bezeichnung, 'Bestellung über Frachtkosten', 'der PUT mit unbekanntem Kontakt hat nichts geändert');
});

test('Leseprofile lesen und ändern: Bezeichnung, aktiv, bevorzugter Kunde – mit Änderungsbeleg', ohneDb, async () => {
  let r = await admin('GET', `${T}/beleg/profile`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, [
    { layout: 'bestellung', bezeichnung: 'Bestellung über Frachtkosten', aktiv: true, kunde: null, kunde_name: null },
    { layout: 'ladeauftrag', bezeichnung: 'Ladeauftrag / Transportauftrag', aktiv: true, kunde: null, kunde_name: null },
    { layout: 'allgemein', bezeichnung: 'Allgemein (Schlagworte)', aktiv: true, kunde: null, kunde_name: null },
  ]);
  r = await admin('PUT', `${T}/beleg/profile/bestellung`, { bezeichnung: '  Bestellung Beispielholz ', aktiv: true, kunde: 990201 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { layout: 'bestellung', bezeichnung: 'Bestellung Beispielholz', aktiv: true, kunde: 990201, kunde_name: 'Beispielholz GmbH & Co. KG' });
  r = await admin('GET', `${T}/beleg/profile`);
  assert.deepEqual(r.body[0], { layout: 'bestellung', bezeichnung: 'Bestellung Beispielholz', aktiv: true, kunde: 990201, kunde_name: 'Beispielholz GmbH & Co. KG' });
  const [beleg] = await sql`select count(*)::int as n from core.change_header where object_type = 'LESEPROFIL' and object_key = 'bestellung' and username = 'admin'`;
  assert.ok(beleg.n >= 1, 'Änderungsbeleg geschrieben');

  // Prüfungen
  assert.equal((await admin('PUT', `${T}/beleg/profile/gibtsnicht`, { bezeichnung: 'X', aktiv: true, kunde: null })).status, 400);
  assert.equal((await admin('PUT', `${T}/beleg/profile/bestellung`, { bezeichnung: ' ', aktiv: true, kunde: null })).status, 400);
  assert.equal((await admin('PUT', `${T}/beleg/profile/bestellung`, { bezeichnung: 'X', kunde: null })).status, 400, 'aktiv fehlt');
  r = await admin('PUT', `${T}/beleg/profile/bestellung`, { bezeichnung: 'X', aktiv: true, kunde: 998877 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Kontakt 998877 existiert nicht/);

  // abschalten: mindestens ein Profil bleibt aktiv
  assert.equal((await admin('PUT', `${T}/beleg/profile/ladeauftrag`, { bezeichnung: 'Ladeauftrag / Transportauftrag', aktiv: false, kunde: null })).status, 200);
  assert.equal((await admin('PUT', `${T}/beleg/profile/allgemein`, { bezeichnung: 'Allgemein (Schlagworte)', aktiv: false })).status, 200, 'kunde darf fehlen');
  r = await admin('PUT', `${T}/beleg/profile/bestellung`, { bezeichnung: 'Bestellung Beispielholz', aktiv: false, kunde: 990201 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Mindestens ein Leseprofil muss aktiv bleiben/);
  r = await admin('GET', `${T}/beleg/profile`);
  assert.deepEqual(r.body.map((p: { aktiv: boolean }) => p.aktiv), [true, false, false]);
  assert.equal((await admin('PUT', `${T}/beleg/profile/ladeauftrag`, { bezeichnung: 'Ladeauftrag / Transportauftrag', aktiv: true, kunde: null })).status, 200);
  assert.equal((await admin('PUT', `${T}/beleg/profile/allgemein`, { bezeichnung: 'Allgemein (Schlagworte)', aktiv: true, kunde: null })).status, 200);

  // gelöschter Kontakt: der bevorzugte Kunde wird leer, das Profil bleibt
  await sql`insert into transport.adressen (adrnr, kundenname) values (990203, 'Kurzlebig Erfunden')`;
  assert.equal((await admin('PUT', `${T}/beleg/profile/ladeauftrag`, { bezeichnung: 'Ladeauftrag / Transportauftrag', aktiv: true, kunde: '990203' })).status, 200, 'Zahl als Text');
  await sql`delete from transport.adressen where adrnr = 990203`;
  r = await admin('GET', `${T}/beleg/profile`);
  assert.deepEqual([r.body[1].kunde, r.body[1].kunde_name, r.body[1].aktiv], [null, null, true]);
});

test('Beleg hochladen: Eingaben geprüft, unlesbare Datei mit klarer Meldung – nichts wird angelegt', ohneDb, async () => {
  let r = await admin('POST', `${T}/auftraege/beleg/erkennen`, { name: 'a.pdf' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  r = await admin('POST', `${T}/auftraege/beleg/erkennen`, { name: '', inhalt: b64('x') });
  assert.equal(r.status, 400);
  r = await admin('POST', `${T}/auftraege/beleg/erkennen`, { name: 'leer.pdf', inhalt: 'data:application/pdf;base64,' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /leer/);
  // weder PDF noch Bild – auch wenn der Name auf .pdf endet (es zählt der Inhalt)
  r = await admin('POST', `${T}/auftraege/beleg/erkennen`, { name: 'Auftrag.pdf', inhalt: `data:text/plain;base64,${b64('Transportauftrag als reiner Text')}` });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Dateityp kann nicht gelesen werden/);
  const [n] = await sql`select count(*)::int as n from transport.auftraege`;
  assert.equal(n.n, 1);
});

test('Dokument aus dem Posteingang: gespeicherter Text wird wiederverwendet, Antwort ist ein Vorschlag – nichts wird angelegt oder geändert', ohneDb, async () => {
  let r = await admin('POST', `${T}/eingang/dokumente/987654/beleg`);
  assert.equal(r.status, 404, JSON.stringify(r.body));
  r = await admin('POST', `${T}/eingang/dokumente/${dokOhneAlles}/beleg`);
  assert.equal(r.status, 404);
  assert.match(r.body.message, /Leer\.pdf.*liegt nicht mehr im Portal/);
  r = await admin('POST', `${T}/eingang/dokumente/${dokKeinBeleg}/beleg`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Dateityp kann nicht gelesen werden/);

  r = await admin('POST', `${T}/eingang/dokumente/${dokMitText}/beleg`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body;
  assert.equal(v.text, BELEGTEXT);
  assert.equal(typeof v.istFrachtauftrag, 'boolean');
  assert.ok(['bestellung', 'ladeauftrag', 'allgemein'].includes(v.layout), v.layout);
  const profile = (await admin('GET', `${T}/beleg/profile`)).body as { layout: string; bezeichnung: string }[];
  assert.equal(v.profil, profile.find((p) => p.layout === v.layout)!.bezeichnung, 'Bezeichnung des Leseprofils zum erkannten Layout');
  // jedes Feld hält die Grundregel ein – welcher Zustand es ist, entscheidet die Erkennung
  const feldOk = (name: string, f: { status: string; wert: unknown; kandidaten: unknown[] }) => {
    assert.ok(f && ['eindeutig', 'unklar', 'fehlt'].includes(f.status), `${name}: ${JSON.stringify(f)}`);
    assert.ok(Array.isArray(f.kandidaten), name);
    if (f.status === 'eindeutig') assert.ok(f.wert !== null && f.wert !== undefined, `${name}: eindeutig ohne Wert`);
    else assert.equal(f.wert, null, `${name}: Wert nur bei „eindeutig“`);
    if (f.status === 'unklar') assert.ok(f.kandidaten.length >= 1, `${name}: unklar ohne Kandidaten`);
    if (f.status === 'fehlt') assert.equal(f.kandidaten.length, 0, name);
  };
  for (const f of ['kunde', 'ordernummer', 'leistungsdatum', 'frachtpreis_vk', 'gewicht', 'lademeter', 'fahrzeugtyp', 'ladegut', 'ladeweise', 'palettentausch', 'besonderheiten']) feldOk(f, v[f]);
  assert.ok(Array.isArray(v.stops) && v.stops.length <= 2);
  assert.ok(Array.isArray(v.kundeImBeleg) && Array.isArray(v.dubletten) && Array.isArray(v.hinweise));
  // der Abgleich liefert Kontakte und Schlüssel der Wertelisten, nie den Belegtext
  if (v.kunde.status === 'eindeutig') assert.ok([990201, 990202].includes(v.kunde.wert), `Kunde ${v.kunde.wert}`);
  for (const k of v.kunde.kandidaten) assert.ok([990201, 990202].includes(k.wert), `Kandidat ${k.wert}`);
  const werte = (await admin('GET', `${T}/werte`)).body as Record<string, { key: string }[]>;
  if (v.fahrzeugtyp.status === 'eindeutig') assert.ok(werte.FAHRZEUGTYP.some((w) => w.key === v.fahrzeugtyp.wert), `Fahrzeugtyp ${v.fahrzeugtyp.wert}`);
  for (const d of v.dubletten) assert.deepEqual(d, { auftragsnr: '2099_8201', anlagedatum: d.anlagedatum, kunde: 'Beispielholz GmbH & Co. KG' });

  const [n] = await sql`select count(*)::int as n from transport.auftraege`;
  assert.equal(n.n, 1, 'kein Auftrag angelegt');
  const [d] = await sql`select status, inhalt, ocr_text from transport.eing_dokumente where id = ${dokMitText}`;
  assert.deepEqual([d.status, d.inhalt, d.ocr_text], ['neu', null, BELEGTEXT], 'Dokument unverändert');
  const [vg] = await sql`select status, auftragsnr from transport.eing_vorgaenge where message_id = 'beleg-1@kunde-beleg.test'`;
  assert.deepEqual([vg.status, vg.auftragsnr], ['pruefen', null], 'Vorgang unverändert');
});
