/**
 * Vereinskalender: Berechtigungsobjekte, Veranstaltungen anlegen/ändern/absagen, An-/Abmeldung nur für das
 * eigene Mitglied, Gruppen (Mannschaftsplanung) mit Sichtbarkeit und offenen Rückmeldungen,
 * Anmeldeschluss, Teilnehmerbegrenzung, Teilnehmerliste (CSV), Systemrolle MITGLIED.
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
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, text: res.body, ct };
  };
}
const admin = client();
const K = '/api/m/tco/kalender';
const ANNA = '0000000501', BEN = '0000000502', CARL = '0000000503';
const tage = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const tag = (n: number) => tage(n).slice(0, 10);

async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) values (${ANNA}, 'Anna', 'Aufschlag', '2020-01-01'), (${BEN}, 'Ben', 'Netz', '2020-01-01'), (${CARL}, 'Carl', 'Linie', '2020-01-01')`;
  await sql`insert into tco.mitgliedera (adrnr) values (${ANNA}), (${BEN}), (${CARL})`;
  for (const u of ['anna', 'ben', 'ohne']) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles: ['MITGLIED'] })).status, 200);
  }
  await sql`update tco.mitgliedera set benutzer_id = (select id from core.users where username = 'anna') where adrnr = ${ANNA}`;
  await sql`update tco.mitgliedera set benutzer_id = (select id from core.users where username = 'ben') where adrnr = ${BEN}`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Berechtigungsobjekte und Systemrolle', async () => {
  const r = await admin('GET', '/api/admin/permissions');
  assert.ok(JSON.stringify(r.body).includes('tco.kalender:anmelden') && JSON.stringify(r.body).includes('tco.kalender:edit'));
  const rechte = (await sql`select permission from core.role_permissions where role_id = 'MITGLIED' order by 1`).map((x) => x.permission);
  assert.ok(rechte.includes('tco.kalender:anmelden') && !rechte.includes('tco.kalender:edit'));
});

let fest = 0, spiel = 0;
test('Veranstaltungen und Gruppen pflegen', async () => {
  let r = await admin('POST', `${K}/pflege/gruppen`, { name: 'Herren 40' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const h40 = r.body.id;
  assert.equal((await admin('POST', `${K}/pflege/gruppen`, { name: 'herren 40' })).status, 400);
  assert.equal((await admin('POST', `${K}/pflege/gruppen/${h40}/mitglieder`, { adrnr: BEN, rolle: 'Mannschaftsführer' })).status, 200);
  assert.equal((await admin('POST', `${K}/pflege/gruppen/${h40}/mitglieder`, { adrnr: CARL })).status, 200);

  r = await admin('POST', K, { titel: 'Sommerfest', beschreibung: 'Grillen und Doppel', ort: 'Clubhaus', beginn: tage(10), ende: tage(10.25), max_teilnehmer: 3, begleitung: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  fest = r.body.id;
  r = await admin('POST', K, { titel: 'Medenspiel H40', kategorie: 'MANNSCHAFT', beginn: tage(5), gruppen: [h40], teilnehmer_sichtbar: false, anmeldeschluss: tage(3) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  spiel = r.body.id;
  assert.equal((await admin('POST', K, { titel: 'x', beginn: tage(2), ende: tage(1) })).status, 400);
  assert.equal((await admin('POST', K, { titel: 'x', beginn: tage(2), gruppen: [999] })).status, 400);
  assert.equal((await admin('DELETE', `${K}/pflege/gruppen/${h40}`)).status, 400, 'Gruppe noch kommenden Veranstaltungen zugeordnet');
});

test('Mitglieder: nur eigene An-/Abmeldung, Gruppen-Sichtbarkeit, Begrenzung', async () => {
  const anna = await anmelden('anna');
  const ben = await anmelden('ben');
  const ohne = await anmelden('ohne');

  // Anna sieht das Fest, aber nicht das Mannschaftsspiel (nicht in der Gruppe)
  let r = await anna('GET', `${K}?von=${tag(0)}&bis=${tag(30)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.events.map((e: any) => e.titel), ['Sommerfest']);
  assert.equal(r.body.pflege, false);
  assert.equal((await anna('GET', `${K}/${spiel}`)).status, 404);
  assert.equal((await anna('POST', `${K}/${spiel}/rueckmeldung`, { status: 'ZUSAGE' })).status, 403);
  // Pflege gesperrt
  assert.equal((await anna('POST', K, { titel: 'x', beginn: tage(2) })).status, 403);
  assert.equal((await anna('POST', `${K}/${fest}/teilnehmer`, { adrnr: BEN, status: 'ABSAGE' })).status, 403);
  assert.equal((await anna('GET', `${K}/pflege/mitglieder`)).status, 403);

  // Zusage mit Begleitung; eine mitgeschickte fremde Adressnummer gibt es nicht
  r = await anna('POST', `${K}/${fest}/rueckmeldung`, { status: 'ZUSAGE', begleitung: 1, kommentar: 'mit Partner', adrnr: BEN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await sql`select adrnr, status, begleitung from tco.kal_anmeldungen`).map((x) => [x.adrnr, x.status, x.begleitung]), [[ANNA, 'ZUSAGE', 1]]);

  // Ben: Mannschaftsspiel sichtbar, Zusage; Fest: Platz 3 von 3 → ausgebucht für weitere
  r = await ben('GET', `${K}?von=${tag(0)}&bis=${tag(30)}`);
  assert.deepEqual(r.body.events.map((e: any) => e.titel), ['Medenspiel H40', 'Sommerfest']);
  assert.equal((await ben('POST', `${K}/${spiel}/rueckmeldung`, { status: 'ZUSAGE' })).status, 200);
  r = await ben('POST', `${K}/${fest}/rueckmeldung`, { status: 'ZUSAGE', begleitung: 1 });
  assert.equal(r.status, 400, 'Anna + 1 + Ben + 1 > 3');
  assert.match(r.body.message, /ausgebucht/);
  assert.equal((await ben('POST', `${K}/${fest}/rueckmeldung`, { status: 'ZUSAGE' })).status, 200);
  r = await ben('GET', `${K}/${fest}`);
  assert.deepEqual(r.body.teilnehmer.zusagen.map((z: any) => [z.name, z.begleitung]), [['Anna Aufschlag', 1], ['Ben Netz', 0]]);
  assert.deepEqual(r.body.teilnehmer.liste, [], 'Mitglieder sehen keine Kommentare/Absagen');
  assert.ok(!r.text.includes('mit Partner'));
  assert.equal(r.body.event.voll, true);
  // Mannschaftsspiel: Teilnehmer nur für Organisatoren
  r = await ben('GET', `${K}/${spiel}`);
  assert.deepEqual(r.body.teilnehmer.zusagen, []);

  // Benutzer ohne Mitglied: sehen, aber nicht anmelden
  r = await ohne('GET', `${K}?von=${tag(0)}&bis=${tag(30)}`);
  assert.equal(r.body.mitglied, false);
  assert.equal((await ohne('POST', `${K}/${fest}/rueckmeldung`, { status: 'ZUSAGE' })).status, 403);
  assert.equal((await client()('GET', `${K}?von=${tag(0)}&bis=${tag(1)}`)).status, 401);
});

test('Organisator: offene Rückmeldungen, Pflege, CSV, Absage und Anmeldeschluss', async () => {
  let r = await admin('GET', `${K}/${spiel}`);
  assert.deepEqual(r.body.teilnehmer.liste.map((t: any) => [t.name, t.status]), [['Ben Netz', 'ZUSAGE']]);
  assert.deepEqual(r.body.teilnehmer.offen.map((t: any) => t.name), ['Carl Linie']);
  assert.equal((await admin('POST', `${K}/${spiel}/teilnehmer`, { adrnr: CARL, status: 'ABSAGE', kommentar: 'verletzt' })).status, 200);
  r = await admin('GET', `${K}/${spiel}`);
  assert.deepEqual(r.body.teilnehmer.offen, []);
  r = await admin('GET', `${K}/${spiel}/csv`);
  assert.equal(r.status, 200);
  assert.match(r.ct, /text\/csv/);
  assert.match(r.text, /"Carl Linie";"Absage";"0";"verletzt"/);

  // Anmeldeschluss vorbei → Mitglied kann nicht mehr ändern, Organisator schon
  await sql`update tco.kal_events set anmeldeschluss = now() - interval '1 hour' where id = ${spiel}`;
  const ben = client();
  assert.equal((await ben('POST', '/api/auth/login', { username: 'ben', password: 'neues-passwort' })).status, 200);
  r = await ben('POST', `${K}/${spiel}/rueckmeldung`, { status: 'ABSAGE' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Anmeldeschluss/);
  assert.equal((await admin('POST', `${K}/${spiel}/teilnehmer`, { adrnr: BEN, status: 'ABSAGE' })).status, 200);

  // Absage der Veranstaltung
  const e = (await admin('GET', `${K}/${fest}`)).body.event;
  r = await admin('PUT', `${K}/${fest}`, { ...e, abgesagt: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /abgesagt/);
  r = await ben('POST', `${K}/${fest}/rueckmeldung`, { status: 'ABSAGE' });
  assert.match(r.body.message, /abgesagt/);
  r = await admin('DELETE', `${K}/${fest}`);
  assert.equal(r.status, 200);
  assert.equal((await sql`select count(*)::int as n from tco.kal_anmeldungen where event_id = ${fest}`)[0].n, 0);
  const [{ n }] = await sql`select count(*)::int as n from core.change_header where object_type in ('KAL_EVENT', 'KAL_ANMELDUNG', 'KAL_GRUPPE')`;
  assert.ok(n >= 6);
});

test('Massenanlage: Spielplan einfügen, Vorschau mit Mapping und Gruppe, anlegen ohne Doppelte (#16)', async () => {
  const { spielplanLesen } = await import('../../modules/tco/server/kalender/spielplan.js');
  const plan = [
    '<!--StartFragment-->',
    'Tag | Datum | Uhrzeit | Nr. | Halle | Platz | Liga | Heimmannschaft | Gastmannschaft',
    '-- | -- | -- | -- | -- | -- | -- | -- | --',
    'Sa | 05.12.2026 | 17:00 | 164 | Halle Homburg | 1+2 | Herren 40 VL | TC Oberthal 1 | TV Scheidt , Abt. Tennis 1',
    'So | 14.03.2027 | 14:00 | 10 | Tennisclub TuS 1860 Neunkirchen | 1+2 | Ju U15 | TC Oberthal 1 | SG Heiligenw/LW-Reden 1',
    'Sa | 31.02.2027 | 17:00 | 1 | Halle | 1 | Damen LL | A | B',
    'Hinweis ohne Datum',
    '<!--EndFragment-->',
  ].join('\n');
  // reine Textlogik: Tabulator ohne Kopfzeile, zweistelliges Jahr, ohne Uhrzeit = ganztägig
  const t = spielplanLesen('Sa\t07.11.26\t\t161\tHalle Homburg\t1+2\tHerren 40 VL\tTC Limbach 1\tTC Oberthal 1');
  assert.deepEqual([t.zeilen[0].datum, t.zeilen[0].uhrzeit, t.zeilen[0].liga, t.zeilen[0].gast, t.zeilen[0].fehler], ['2026-11-07', null, 'Herren 40 VL', 'TC Oberthal 1', null]);

  // Gruppe „Herren 40“ gibt es aus dem Test oben
  const [{ id: h40 }] = await sql`select id from tco.kal_gruppen where name = 'Herren 40'`;
  let r;

  // Vorschau: Mapping laut Anforderung, Gruppe zur Liga, fehlerhafte Zeile markiert, nichts angelegt
  const [{ n: vorher }] = await sql`select count(*)::int as n from tco.kal_events`;
  r = await admin('POST', `${K}/masse/vorschau`, { text: plan });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.zeilen.length, 3);
  assert.equal(r.body.ignoriert, 1);
  const z = r.body.zeilen[0];
  assert.deepEqual([z.titel, z.kategorie, z.ort, z.beginn_lokal, z.ganztags, z.gruppe, z.fehler],
    ['Winterhallenrunde Herren 40 VL', 'MANNSCHAFT', 'Halle Homburg | 1+2', '2026-12-05T17:00', false, h40, null]);
  assert.equal(z.beschreibung, 'TC Oberthal 1 – TV Scheidt , Abt. Tennis 1\nSpiel-Nr. 164');
  assert.deepEqual([r.body.zeilen[1].titel, r.body.zeilen[1].gruppe], ['Winterhallenrunde Ju U15', null]);
  assert.match(r.body.zeilen[2].fehler, /gibt es nicht/);
  assert.equal((await admin('POST', `${K}/masse/vorschau`, { text: plan, praefix: 'Sommerrunde' })).body.zeilen[0].titel, 'Sommerrunde Herren 40 VL');
  assert.equal((await sql`select count(*)::int as n from tco.kal_events`)[0].n, vorher);

  // Anlegen: zwei Veranstaltungen; erneut → als vorhanden übersprungen
  const events = r.body.zeilen.slice(0, 2).map((x: any) => ({
    titel: x.titel, ort: x.ort, kategorie: x.kategorie, beschreibung: x.beschreibung, beginn: new Date(`${x.beginn_lokal}:00+01:00`).toISOString(),
    ganztags: x.ganztags, anmeldung: true, gruppen: x.gruppe ? [x.gruppe] : [],
  }));
  assert.equal((await admin('POST', `${K}/masse`, { events: [] })).status, 400);
  r = await admin('POST', `${K}/masse`, { events });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.angelegt, 2);
  assert.match(r.body.text, /2 Veranstaltung\(en\) angelegt\./);
  assert.deepEqual(r.body.zeilen.map((x: any) => x.ok), [true, true]);
  const [e] = await sql`select titel, ort, kategorie, gruppen, anmeldung, beschreibung from tco.kal_events where titel = 'Winterhallenrunde Herren 40 VL'`;
  assert.deepEqual([e.ort, e.kategorie, e.gruppen.map(Number), e.anmeldung], ['Halle Homburg | 1+2', 'MANNSCHAFT', [h40], true]);
  r = await admin('POST', `${K}/masse`, { events });
  assert.equal(r.body.angelegt, 0);
  assert.match(r.body.zeilen[0].text, /bereits vorhanden/);
  assert.equal((await sql`select count(*)::int as n from tco.kal_events`)[0].n, vorher + 2);

  // nur mit Pflegerecht
  const anna = client();
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'neues-passwort' })).status, 200);
  assert.equal((await anna('POST', `${K}/masse/vorschau`, { text: plan })).status, 403);
  assert.equal((await anna('POST', `${K}/masse`, { events })).status, 403);
});

test('Gruppen-Veranstaltung: Rückmeldungen nur für Mitglieder der Gruppe, Auswahl ohne andere Personen (#16)', async () => {
  // Auswahl zum Eintragen: bei einer Veranstaltung für „Herren 40“ nur deren Mitglieder
  let r = await admin('GET', `${K}/pflege/mitglieder?event=${spiel}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((m: any) => m.adrnr).sort(), [BEN, CARL]);
  r = await admin('GET', `${K}/pflege/mitglieder`);
  assert.ok(r.body.some((m: any) => m.adrnr === ANNA), 'ohne Veranstaltung alle Mitglieder');
  // auch der Organisator trägt für Personen außerhalb der Gruppe nichts ein
  r = await admin('POST', `${K}/${spiel}/teilnehmer`, { adrnr: ANNA, status: 'ZUSAGE' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /gehört nicht zu den Gruppen/);
  assert.equal((await sql`select count(*)::int as n from tco.kal_anmeldungen where event_id = ${spiel} and adrnr = ${ANNA}`)[0].n, 0);
  assert.equal((await admin('POST', `${K}/${spiel}/teilnehmer`, { adrnr: CARL, status: 'ZUSAGE' })).status, 200);
});

