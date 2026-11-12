/**
 * Integrationstest Spielerdaten aus nuLiga (#162): CSV lesen, mit aktiven Mitgliedern abgleichen, ID-Nr. und LK übernehmen;
 * die LK ändert sich im Folgejahr, eine fehlende ID-Nr. löscht die gespeicherte nicht.
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
const { lkLesen, nuligaLesen } = await import('../../modules/tco/server/sport/nuliga.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const S = '/api/m/tco/sport/spielerdaten';
// nuLiga liefert Windows-1252 mit Semikolon; Spalten wie im Download (weitere Spalten sind egal)
const csv = (zeilen: string[]) => Buffer.from(['Nachname;Vorname;Titel;Geburtsdatum;Nationalität;LK;ID-Nr;Geschlecht;Straße', ...zeilen].join('\r\n'), 'latin1').toString('base64');
const DATEI = csv([
  'Müller;Jürgen;;01.05.1970;GER;LK22,1;10204675;männlich;Hauptstr. 1',
  'Probe;Petra;Dr.;02.02.1985;GER;LK2,4;11081987;weiblich;Weg 2',
  'Ohne;Lizenz;;03.03.1990;GER;-;0;männlich;Weg 3',
  'Anders;Geboren;;04.04.1991;GER;LK25,0;17858053;männlich;Weg 4',
  'Kurz;Kathi;;05.05.2005;GER;LK20,8;19853492;weiblich;Weg 5',
  'Fremd;Gast;;06.06.1980;GER;LK6,2;17354181;männlich;Weg 6',
  'Alt;Ausgetreten;;07.07.1960;GER;LK25,0;10106748;männlich;Weg 7',
]);

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, geburtsdatum, eintritt, austritt, mitglnrn) values
    ('0000000301', 'Jürgen', 'Müller', '1970-05-01', '2010-01-01', null, '301'),
    ('0000000302', 'Petra', 'Probe', null, '2015-01-01', null, '302'),
    ('0000000303', 'Lizenz', 'Ohne', '1990-03-03', '2015-01-01', null, '303'),
    ('0000000304', 'Geboren', 'Anders', '1991-04-14', '2015-01-01', null, '304'),
    ('0000000305', 'Katharina', 'Kurz', '2005-05-05', '2015-01-01', null, '305'),
    ('0000000306', 'Nur', 'Portal', '1999-09-09', '2015-01-01', null, '306'),
    ('0000000307', 'Ausgetreten', 'Alt', '1960-07-07', '2000-01-01', '2020-12-31', '307')`;
  await sql`insert into tco.mitgliedera (adrnr, trainer) values ('0000000301', true)`;
});
after(async () => { await app?.close(); await sql.end(); });

test('nuLiga-Datei lesen: Spalten über die Kopfzeile, LK und ID-Nr.', () => {
  assert.equal(lkLesen('LK25,0'), 25);
  assert.equal(lkLesen('LK2,4'), 2.4);
  assert.equal(lkLesen('-'), null);
  const p = nuligaLesen(Buffer.from(DATEI, 'base64'));
  assert.equal(p.length, 7);
  assert.deepEqual(p[0], { zeile: 2, nachname: 'Müller', vorname: 'Jürgen', geburtsdatum: '1970-05-01', lk: 22.1, id_nr: '10204675' });
  assert.deepEqual([p[2].lk, p[2].id_nr], [null, null]);
  assert.throws(() => nuligaLesen(Buffer.from('Vorname;Ort\nA;B')), /Spalte „Nachname“ fehlt/);
});

test('Abgleich: sichere Treffer, Prüffälle, ohne Treffer – übernommen wird nur die Auswahl', async () => {
  let r = await call('POST', `${S}/abgleich`, { datei: DATEI });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = new Map<string, any>(r.body.treffer.map((x: any) => [x.adrnr, x]));
  assert.deepEqual([t.get('0000000301').art, t.get('0000000301').sicher, t.get('0000000301').id_neu, t.get('0000000301').lk_neu], ['NAME_GEB', true, '10204675', 22.1]);
  assert.deepEqual([t.get('0000000302').art, t.get('0000000302').sicher], ['NAME', true], 'ohne Geburtsdatum im Portal: eindeutiger Name');
  assert.deepEqual([t.get('0000000303').sicher, t.get('0000000303').aenderung], [true, false], 'ohne LK und ID-Nr.: nichts zu ändern');
  assert.deepEqual([t.get('0000000304').art, t.get('0000000304').sicher], ['PRUEFEN', false]);
  assert.match(t.get('0000000304').hinweis, /Geburtsdatum weicht ab/);
  assert.match(t.get('0000000305').hinweis, /Vorname weicht ab/);
  assert.deepEqual(r.body.ohneTreffer.map((m: any) => m.adrnr), ['0000000306']);
  assert.deepEqual(r.body.nurDatei.map((p: any) => p.name), ['Fremd, Gast', 'Alt, Ausgetreten'], 'ausgetretene Mitglieder werden nicht abgeglichen');
  assert.deepEqual(r.body.anzahl, { aenderungen: 2, unveraendert: 1, pruefen: 2, ohneTreffer: 1, nurDatei: 2 });
  assert.equal((await sql`select count(*)::int as n from tco.mitgliedera where id_nr is not null`)[0].n, 0, 'Vorschau schreibt nicht');

  // Auswahl, die der Abgleich nicht kennt, wird abgelehnt
  assert.equal((await call('POST', `${S}/uebernehmen`, { datei: DATEI, auswahl: [{ adrnr: '0000000306', zeile: 2 }] })).status, 400);
  const auswahl = ['0000000301', '0000000302', '0000000305'].map((a) => ({ adrnr: a, zeile: t.get(a).zeile }));
  r = await call('POST', `${S}/uebernehmen`, { datei: DATEI, name: 'Mitgliederdaten.csv', auswahl });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /3 Mitglieder abgeglichen: 3 ID-Nr\. und 3 LK/);
  const z = await sql`select adrnr, id_nr, lk::float8 as lk, trainer, lk_stand is not null as stand from tco.mitgliedera order by adrnr`;
  assert.deepEqual(z.map((x) => [x.adrnr, x.id_nr, x.lk, x.trainer, x.stand]), [
    ['0000000301', '10204675', 22.1, true, true], ['0000000302', '11081987', 2.4, false, true], ['0000000305', '19853492', 20.8, false, true],
  ]);

  // Anzeige: Stand der App und Stammsatz des Mitglieds
  r = await call('GET', S);
  assert.deepEqual(r.body.anzahl, { mitglieder: 6, mitId: 3, mitLk: 3 });
  r = await call('GET', '/api/m/tco/mitglieder/m/0000000301');
  assert.deepEqual([r.body.spieler.id_nr, r.body.spieler.lk], ['10204675', 22.1]);
});

test('Folgejahr: LK ändert sich, Treffer über die gespeicherte ID-Nr., fehlende ID-Nr. löscht nichts', async () => {
  await sql`update tco.mitglieder_lk set jahr = jahr - 1`;
  const neu = csv([
    'Mueller;Juergen;;;GER;LK21,3;10204675;männlich;Hauptstr. 1',       // andere Schreibweise, ohne Geburtsdatum: Treffer über ID-Nr.
    'Probe;Petra;Dr.;02.02.1985;GER;LK2,4;0;weiblich;Weg 2',            // ID-Nr. fehlt in der Datei
    'Portal;Nur;;09.09.1999;GER;LK24,0;10204675;männlich;Weg 9',        // ID-Nr. gehört schon zu Müller
  ]);
  let r = await call('POST', `${S}/abgleich`, { datei: neu });
  const t = new Map<string, any>(r.body.treffer.map((x: any) => [x.adrnr, x]));
  assert.deepEqual([t.get('0000000301').art, t.get('0000000301').lk_alt, t.get('0000000301').lk_neu], ['ID', 22.1, 21.3]);
  assert.deepEqual([t.get('0000000302').id_neu, t.get('0000000302').aenderung], ['11081987', false]);
  assert.equal(t.get('0000000306').sicher, false);
  assert.match(t.get('0000000306').hinweis, /bereits bei einem anderen Mitglied/);
  r = await call('POST', `${S}/uebernehmen`, { datei: neu, auswahl: [{ adrnr: '0000000301', zeile: 2 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', S);
  const m = r.body.zeilen.find((x: any) => x.adrnr === '0000000301');
  assert.equal(m.lk, 21.3);
  assert.deepEqual(m.verlauf.map((v: any) => v.lk), [21.3, 22.1], 'Verlauf je Jahr');
  // doppelte ID-Nr. wird auch bei ausdrücklicher Auswahl nicht gespeichert
  r = await call('POST', `${S}/uebernehmen`, { datei: neu, auswahl: [{ adrnr: '0000000306', zeile: 4 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits bei einem anderen Mitglied/);
});
