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
  // Löschen nur, wenn niemand angemeldet ist (Zusage oder „vielleicht“) – Absagen stehen dem nicht im Weg
  await sql`insert into tco.kal_anmeldungen (event_id, adrnr, status) values (${fest}, '0000000999', 'VIELLEICHT') on conflict do nothing`;
  r = await admin('DELETE', `${K}/${fest}`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /kann nicht gelöscht werden: \d+ Anmeldung/);
  r = await admin('POST', `${K}/masse/loeschen`, { ids: [fest] });
  assert.deepEqual([r.body.geloescht, r.body.nicht_geloescht], [0, 1]);
  assert.match(r.body.text, /nicht gelöscht, weil Anmeldungen vorliegen/);
  await sql`update tco.kal_anmeldungen set status = 'ABSAGE' where event_id = ${fest}`;
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

test('Tabelle: Massenbearbeitung und Regelwerk „Text in Spalte => Gruppe“ (#16)', async () => {
  const R = `${K}/regeln`;
  const [{ id: h40 }] = await sql`select id from tco.kal_gruppen where name = 'Herren 40'`;
  const [{ id: andere }] = await sql`insert into tco.kal_gruppen (name) values ('Tabellentest') returning id`;
  const neu = async (titel: string, beschreibung: string) => {
    const x = await admin('POST', K, { titel, beschreibung, kategorie: 'MANNSCHAFT', beginn: '2027-05-01T10:00:00.000Z' });
    assert.equal(x.status, 200, JSON.stringify(x.body));
    return x.body.id as number;
  };
  const a = await neu('Sommerrunde Herren 40 VL', 'TC Limbach 1 – TC Oberthal 1');
  const b = await neu('Sommerrunde Damen LL', 'TC Oberthal 1 – SG Niedtal 1');
  const ev = async (id: number) => (await sql`select titel, ort, kategorie, anmeldung, gruppen from tco.kal_events where id = ${id}`)[0];

  // Regelwerk pflegen
  assert.equal((await admin('PUT', R, { regeln: [{ feld: 'titel', text: ' ', gruppe_id: h40 }] })).status, 400);
  assert.equal((await admin('PUT', R, { regeln: [{ feld: 'titel', text: 'x', gruppe_id: 99999 }] })).status, 400);
  assert.equal((await admin('PUT', R, { regeln: [{ feld: 'spalte', text: 'x', gruppe_id: h40 }] })).status, 400);
  let r = await admin('PUT', R, { regeln: [{ feld: 'titel', text: 'herren  40', gruppe_id: h40 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('GET', R);
  assert.deepEqual([r.body.regeln.length, r.body.regeln[0].text, typeof r.body.felder.titel], [1, 'herren 40', 'string']);

  // Vorschau ändert nichts; Anwenden ordnet Veranstaltungen ohne Gruppe zu (ohne Rücksicht auf Groß-/Kleinschreibung)
  r = await admin('POST', `${R}/anwenden`, { ids: [a, b], simulation: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen.map((x: any) => [x.id, x.neu]), [[a, 'Herren 40']]);
  assert.deepEqual((await ev(a)).gruppen, []);
  r = await admin('POST', `${R}/anwenden`, { ids: [a, b] });
  assert.match(r.body.text, /1 Veranstaltung\(en\) einer Gruppe zugeordnet/);
  assert.deepEqual([(await ev(a)).gruppen.map(Number), (await ev(b)).gruppen], [[h40], []]);

  // erste passende Regel gilt; bereits zugeordnete nur mit „überschreiben“
  r = await admin('PUT', R, { regeln: [{ feld: 'beschreibung', text: 'TC Limbach', gruppe_id: andere }, { feld: 'titel', text: 'Herren 40', gruppe_id: h40 }, { feld: 'titel', text: 'Damen', gruppe_id: h40, aktiv: false }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${R}/anwenden`, { ids: [a, b] });
  assert.equal(r.body.zeilen.length, 0, 'a ist schon zugeordnet, die Regel für b ist inaktiv');
  r = await admin('POST', `${R}/anwenden`, { ids: [a, b], ueberschreiben: true });
  assert.deepEqual(r.body.zeilen.map((x: any) => [x.id, x.bisher]), [[a, 'Herren 40']]);
  assert.deepEqual((await ev(a)).gruppen.map(Number), [andere]);

  // „Mehrere anlegen“ schlägt die Gruppe nach dem Regelwerk vor
  r = await admin('POST', `${K}/masse/vorschau`, { text: 'Sa | 07.11.2026 | 17:00 | 161 | Halle Homburg | 1+2 | Herren 40 VL | TC Limbach 1 | TC Oberthal 1' });
  assert.equal(r.body.zeilen[0].gruppe, andere, 'Regel auf die Begegnung geht dem Gruppennamen vor');

  // Massenbearbeitung: nur die angegebenen Felder
  assert.equal((await admin('POST', `${K}/masse/aendern`, { ids: [a] })).status, 400, 'kein Feld');
  assert.equal((await admin('POST', `${K}/masse/aendern`, { ids: [a], gruppen: [99999] })).status, 400);
  r = await admin('POST', `${K}/masse/aendern`, { ids: [a, b], ort: 'Halle Illingen', kategorie: 'TRAINING', anmeldung: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.geaendert, 2);
  const [ea, eb] = [await ev(a), await ev(b)];
  assert.deepEqual([ea.titel, ea.ort, ea.kategorie, ea.anmeldung, ea.gruppen.map(Number)], ['Sommerrunde Herren 40 VL', 'Halle Illingen', 'TRAINING', false, [andere]]);
  assert.deepEqual([eb.titel, eb.ort, eb.kategorie], ['Sommerrunde Damen LL', 'Halle Illingen', 'TRAINING']);
  assert.equal((await admin('POST', `${K}/masse/aendern`, { ids: [a, b], gruppen: [] })).status, 200);
  assert.deepEqual((await ev(a)).gruppen, []);

  // nur mit Pflegerecht
  const anna = client();
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'neues-passwort' })).status, 200);
  assert.equal((await anna('GET', R)).status, 403);
  assert.equal((await anna('POST', `${K}/masse/aendern`, { ids: [a], ort: 'x' })).status, 403);

  // Massenlöschung: nur mit Pflegerecht, nur die gewählten Veranstaltungen
  assert.equal((await anna('POST', `${K}/masse/loeschen`, { ids: [a] })).status, 403);
  assert.equal((await admin('POST', `${K}/masse/loeschen`, { ids: [] })).status, 400, 'keine Auswahl');
  r = await admin('POST', `${K}/masse/loeschen`, { ids: [a] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.geloescht, 1);
  assert.deepEqual([await ev(a), (await ev(b))?.titel], [undefined, 'Sommerrunde Damen LL']);
  assert.equal((await admin('POST', `${K}/masse/loeschen`, { ids: [a, b] })).body.geloescht, 1, 'bereits gelöschte zählen nicht');
  assert.equal((await admin('PUT', R, { regeln: [] })).status, 200);
});


test('Weitere Personen: bei Veranstaltung und Arbeitseinsatz immer, sonst nur mit Schalter; zählen bei der Gesamtzahl mit (#16)', async () => {
  const anna = client();
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'neues-passwort' })).status, 200);
  const anlegen = async (kategorie: string, titel: string) => {
    const r = await admin('POST', K, { titel, kategorie, beginn: tage(200), max_teilnehmer: 4 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
  };
  const einsatz = await anlegen('ARBEITSEINSATZ', 'Platzaufbau');
  const training = await anlegen('TRAINING', 'Konditionstraining');
  assert.equal((await anna('POST', `${K}/${einsatz}/rueckmeldung`, { status: 'ZUSAGE', begleitung: 2 })).status, 200);
  assert.equal((await anna('POST', `${K}/${training}/rueckmeldung`, { status: 'ZUSAGE', begleitung: 2 })).status, 200);
  const r = await anna('GET', `${K}?von=${tag(199)}&bis=${tag(201)}`);
  const je = Object.fromEntries(r.body.events.map((e: any) => [e.titel, [e.begleitung_moeglich, e.zusagen, e.begleitpersonen]]));
  assert.deepEqual(je, { Platzaufbau: [true, 1, 2], Konditionstraining: [false, 1, 0] });
  // Gesamtzahl inkl. weiterer Personen gegen die Höchstzahl (4): Anna + 4 weitere = 5
  const r2 = await anna('POST', `${K}/${einsatz}/rueckmeldung`, { status: 'ZUSAGE', begleitung: 4 });
  assert.equal(r2.status, 400);
  assert.match(r2.body.message, /ausgebucht/);
  await sql`delete from tco.kal_events where id in (${einsatz}, ${training})`;
});

test('Familiensicht: Veranstaltungen aller verknüpften Personen, Rückmeldung per Mehrfachauswahl (alle / keiner)', async () => {
  const KIM = '0000000511', LEO = '0000000512';
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, adrnrkih, geburtsdatum) values
    (${KIM}, 'Kim', 'Netz', '2022-01-01', ${BEN}, '2014-03-03'), (${LEO}, 'Leo', 'Netz', '2022-01-01', ${BEN}, '2016-04-04')`;
  let r = await admin('POST', `${K}/pflege/gruppen`, { name: 'Jugend U12 Familie' });
  const u12 = r.body.id as number;
  assert.equal((await admin('POST', `${K}/pflege/gruppen/${u12}/mitglieder`, { adrnr: KIM })).status, 200);
  r = await admin('POST', K, { titel: 'Jugendturnier U12', kategorie: 'MANNSCHAFT', beginn: tage(40), gruppen: [u12] });
  const turnier = r.body.id as number;
  r = await admin('POST', K, { titel: 'Familientag', beginn: tage(41) });
  const familientag = r.body.id as number;
  const ben = client();
  assert.equal((await ben('POST', '/api/auth/login', { username: 'ben', password: 'neues-passwort' })).status, 200);
  const Z = `von=${tag(39)}&bis=${tag(42)}`;
  // ohne Familiensicht: das Turnier der Tochter ist für Ben nicht sichtbar – die Familie wird aber angeboten
  r = await ben('GET', `${K}?${Z}`);
  assert.deepEqual(r.body.events.map((e: any) => e.titel), ['Familientag']);
  assert.deepEqual(r.body.familie.map((f: any) => f.name), ['Ben Netz', 'Kim Netz', 'Leo Netz']);
  assert.equal(r.body.familiensicht, false);
  // mit Familiensicht: beide Veranstaltungen; je Veranstaltung nur die Personen, für die sie gilt
  r = await ben('GET', `${K}?${Z}&familie=1`);
  assert.equal(r.body.familiensicht, true);
  assert.deepEqual(r.body.events.map((e: any) => [e.titel, e.familie.map((f: any) => f.name)]),
    [['Jugendturnier U12', ['Kim Netz']], ['Familientag', ['Ben Netz', 'Kim Netz', 'Leo Netz']]]);
  // Mehrfachauswahl: Gewählte sagen zu, die übrigen ab
  r = await ben('POST', `${K}/${familientag}/rueckmeldung-familie`, { dabei: [BEN, LEO] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /angemeldet: Ben Netz, Leo Netz/);
  const stand = async (id: number) => Object.fromEntries((await sql`select adrnr, status from tco.kal_anmeldungen where event_id = ${id}`).map((x) => [x.adrnr, x.status]));
  assert.deepEqual(await stand(familientag), { [BEN]: 'ZUSAGE', [KIM]: 'ABSAGE', [LEO]: 'ZUSAGE' });
  // alle / keiner
  assert.equal((await ben('POST', `${K}/${familientag}/rueckmeldung-familie`, { dabei: [BEN, KIM, LEO] })).status, 200);
  assert.deepEqual(await stand(familientag), { [BEN]: 'ZUSAGE', [KIM]: 'ZUSAGE', [LEO]: 'ZUSAGE' });
  assert.equal((await ben('POST', `${K}/${familientag}/rueckmeldung-familie`, { dabei: [] })).status, 200);
  assert.deepEqual(await stand(familientag), { [BEN]: 'ABSAGE', [KIM]: 'ABSAGE', [LEO]: 'ABSAGE' });
  // Gruppenveranstaltung: nur für Kim; Ben selbst oder Fremde lassen sich nicht anmelden
  assert.equal((await ben('POST', `${K}/${turnier}/rueckmeldung-familie`, { dabei: [KIM] })).status, 200);
  assert.deepEqual(await stand(turnier), { [KIM]: 'ZUSAGE' });
  assert.equal((await ben('POST', `${K}/${turnier}/rueckmeldung-familie`, { dabei: [BEN] })).status, 400, 'nicht in der Gruppe');
  assert.equal((await ben('POST', `${K}/${familientag}/rueckmeldung-familie`, { dabei: [CARL] })).status, 403, 'nicht in der Familie');
  r = await ben('GET', `${K}?${Z}&familie=1`);
  assert.deepEqual(r.body.events[0].familie, [{ adrnr: KIM, name: 'Kim Netz', status: 'ZUSAGE' }]);
  await sql`delete from tco.kal_events where id in (${turnier}, ${familientag})`;
  await sql`delete from tco.mitglieder where adrnr in (${KIM}, ${LEO})`;
});

test('Einladungslink: Vorschau, Versand je E-Mail-Adresse, Hinweis für Empfänger ohne Zugang, Verlauf', async () => {
  const http = await import('node:http');
  const { verbindungenCacheLeeren } = await import('../src/lib/verbindungen.js');
  const mails: { an: string; betreff: string; text: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      mails.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'gesendet', message_id: `kal${mails.length}` }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  const mailAn = (an: string) => mails.filter((m) => m.an.toLowerCase() === an);
  try {
    // Anna hat einen Zugang, Carl nicht; Dora und Emil teilen sich eine Adresse (Familie), Finn hat keine
    const DORA = '0000000571', EMIL = '0000000572', FINN = '0000000573';
    await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, eintritt) values
              (${DORA}, 'Dora', 'Volley', 'familie@example.org', '2020-01-01'), (${EMIL}, 'Emil', 'Volley', 'Familie@Example.org', '2020-01-01'), (${FINN}, 'Finn', 'Ohnemail', null, '2020-01-01')`;
    await sql`insert into tco.mitgliedera (adrnr) values (${DORA}), (${EMIL}), (${FINN})`;
    await sql`update tco.mitglieder set email = 'anna@example.org' where adrnr = ${ANNA}`;
    await sql`update tco.mitglieder set email = 'carl@example.org' where adrnr = ${CARL}`;
    let r = await admin('POST', `${K}/pflege/gruppen`, { name: 'Einladungsrunde' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const g = r.body.id;
    for (const a of [ANNA, CARL, DORA, EMIL, FINN]) assert.equal((await admin('POST', `${K}/pflege/gruppen/${g}/mitglieder`, { adrnr: a })).status, 200);
    r = await admin('POST', K, { titel: 'Saisoneröffnung', ort: 'Clubhaus', beginn: tage(20), gruppen: [g], anmeldeschluss: tage(15) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ev = r.body.id;
    const E = `${K}/${ev}/einladung`;

    // nur mit Pflegerecht
    const anna = client();
    assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'neues-passwort' })).status, 200);
    assert.equal((await anna('GET', E)).status, 403);
    assert.equal((await anna('POST', E, { an: 'ALLE', betreff: 'x', text: 'y' })).status, 403);

    // ohne Portal-Adresse: kein Link, kein Versand
    delete process.env.PORTAL_URL;
    await sql`delete from core.settings where key = 'portal.url'`;
    r = await admin('GET', E);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.link, null);
    assert.equal(r.body.senden, false);
    assert.match(r.body.grund, /Portal-Adresse/);
    assert.equal((await admin('POST', E, { an: 'ALLE', betreff: 'x', text: 'y' })).status, 400);

    // mit Portal-Adresse, aber ohne Mailversand: Link zum Kopieren, Versand gesperrt
    assert.equal((await admin('PUT', '/api/settings', { 'portal.url': 'https://portal.example.org' })).status, 200);
    await sql`update core.verbindungen set url = '' where id = 'mail'`;
    verbindungenCacheLeeren();
    const link = `https://portal.example.org/tco/kalender?veranstaltung=${ev}`;
    r = await admin('GET', E);
    assert.equal(r.body.link, link);
    assert.equal(r.body.senden, false);
    assert.match(r.body.grund, /Mailversand/);
    assert.equal((await admin('POST', E, { an: 'ALLE', betreff: 'x', text: link })).status, 400);

    await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis) values ('mail', ${`http://127.0.0.1:${port}/webhook/mail`}, 'header', 'X-TCO-Key', 'k')
              on conflict (id) do update set url = excluded.url, auth_art = 'header', header_name = 'X-TCO-Key', geheimnis = excluded.geheimnis`;
    verbindungenCacheLeeren();
    r = await admin('GET', E);
    assert.equal(r.body.senden, true, JSON.stringify(r.body.grund));
    assert.match(r.body.betreff, /Einladung – Saisoneröffnung/);
    for (const teil of [link, 'Saisoneröffnung', 'Ort: Clubhaus', 'Bitte melden Sie sich bis', '{Vorname}', '{Zugang}']) assert.ok(r.body.text.includes(teil), `Vorbelegung enthält „${teil}“`);
    assert.deepEqual(r.body.personen, [
      { name: 'Anna Aufschlag', mail: true, zugang: true, offen: true }, { name: 'Carl Linie', mail: true, zugang: false, offen: true },
      { name: 'Finn Ohnemail', mail: false, zugang: false, offen: true }, { name: 'Dora Volley', mail: true, zugang: false, offen: true },
      { name: 'Emil Volley', mail: true, zugang: false, offen: true },
    ]);
    assert.deepEqual(r.body.verlauf, []);
    const vorlage = { betreff: r.body.betreff as string, text: r.body.text as string };

    // „ohne Rückmeldung“: Anna hat zugesagt und bekommt nichts; die Familie eine Nachricht; ohne Zugang mit Hinweis auf die Registrierung
    assert.equal((await anna('POST', `${K}/${ev}/rueckmeldung`, { status: 'ZUSAGE' })).status, 200);
    r = await admin('POST', E, { an: 'OFFEN', ...vorlage });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.gesendet, 2);
    assert.deepEqual(r.body.fehler, []);
    assert.deepEqual(r.body.ohneMail, ['Finn Ohnemail']);
    assert.equal(r.body.text, '2 Einladungen gesendet, 1 ohne E-Mail-Adresse.');
    assert.equal(mails.length, 2);
    assert.equal(mailAn('anna@example.org').length, 0);
    const carl = mailAn('carl@example.org')[0];
    assert.match(carl.text, /^Hallo Carl,/);
    assert.ok(carl.text.includes(link));
    assert.match(carl.text, /Noch kein Zugang zum Vereinsportal\?.*registrieren/s);
    assert.doesNotMatch(carl.text, /\{[A-Za-z]+\}/, 'kein Platzhalter bleibt stehen');
    assert.match(mailAn('familie@example.org')[0].text, /^Hallo Dora und Emil,/);

    // der Link muss im Text stehen
    r = await admin('POST', E, { an: 'ALLE', betreff: 'Einladung', text: 'Hallo {Vorname}, kommt alle!' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /fehlt der Link/);
    assert.equal(mails.length, 2);

    // „alle“ mit eigenem Text: Anna (mit Zugang) ohne den Hinweis
    r = await admin('POST', E, { an: 'ALLE', betreff: 'Erinnerung: {Titel}', text: 'Hallo {Vorname}, bitte hier an- oder abmelden: {Link}\n\n{Zugang}' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.gesendet, 3);
    const an = mailAn('anna@example.org')[0];
    assert.equal(an.betreff, 'Erinnerung: Saisoneröffnung');
    assert.equal(an.text, `Hallo Anna, bitte hier an- oder abmelden: ${link}`);
    assert.match(mailAn('carl@example.org')[1].text, /registrieren/);

    r = await admin('GET', E);
    assert.deepEqual(r.body.verlauf.map((x: any) => [x.an, x.gesendet, x.fehler, x.von]), [['ALLE', 3, 0, 'Admin'], ['OFFEN', 2, 0, 'Admin']]);
    assert.equal(r.body.personen.find((p: any) => p.name === 'Anna Aufschlag').offen, false);

    // abgesagt: keine Einladung mehr
    await sql`update tco.kal_events set abgesagt = true where id = ${ev}`;
    r = await admin('GET', E);
    assert.equal(r.body.senden, false);
    assert.match(r.body.grund, /abgesagt/);
    assert.equal((await admin('POST', E, { an: 'ALLE', ...vorlage })).status, 400);
    assert.equal(mails.length, 5);

    // der Text lässt sich unter Einstellungen → E-Mail-Texte vorbelegen
    await sql`update tco.kal_events set abgesagt = false where id = ${ev}`;
    r = await admin('PUT', '/api/m/tco/mailtexte/kalender.einladung', { betreff: 'Komm zu {Titel}', text: 'Hallo {Vorname},\n\n{Termin}\n\n{Link}' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await admin('GET', E);
    assert.equal(r.body.betreff, 'Komm zu Saisoneröffnung');
    assert.match(r.body.text, new RegExp(`^Hallo \\{Vorname\\},\\n\\n.+ Uhr\\n\\n${link.replace(/[.?]/g, '\\$&')}$`));
    assert.equal((await admin('PUT', '/api/m/tco/mailtexte/kalender.einladung', { betreff: 'x', text: 'ohne Link' })).status, 400, 'der Link ist Pflicht');

    await sql`delete from tco.kal_events where id = ${ev}`;
    assert.equal(Number((await sql`select count(*)::int as n from tco.kal_einladungen where event_id = ${ev}`)[0].n), 0, 'Verlauf geht mit der Veranstaltung');
    await sql`delete from tco.mitglieder where adrnr in (${DORA}, ${EMIL}, ${FINN})`;
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
