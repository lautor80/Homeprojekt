/**
 * Integrationstest geführte Vorgänge der Mitgliederverwaltung (#154): Beitragswechsel, Abschluss Jugendtraining, Kündigung.
 * Prüfen ändert nichts; Ausführen legt Verträge an bzw. beendet sie, setzt den Austritt und schreibt eine Notiz.
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
const { fristEnde, wechselAb } = await import('../../modules/tco/server/mitglieder/vorgaenge.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const M = '/api/m/tco/mitglieder';
const tagVorher = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const vertraege = (adrnr: string) => sql`select vertragnr, art, vertragbegin::text as beginn, vertragende::text as ende, betrag::float8 as betrag, sollstellung
                                          from tco.vertraege where adrnr = ${adrnr} order by vertragnr::int`;

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, geburtsdatum, eintritt, mitglnrn, zahlungsart, iban1, email) values
    ('0000000201', 'Hans', 'Alt', '1970-05-01', '2020-01-01', '201', 'L', 'DE02120300000000202051', 'hans@example.org'),
    ('0000000202', 'Lea', 'Jung', '2008-03-01', '2020-01-01', '202', 'L', 'DE02120300000000202051', null),
    ('0000000203', 'Tim', 'Klein', '2014-06-01', '2024-01-01', '203', 'L', 'DE02120300000000202051', null),
    ('0000000204', 'Nina', 'Neu', '2016-04-01', null, null, 'L', 'DE02120300000000202051', null),
    ('0000000205', 'Paula', 'Eltern', '1980-02-02', '2021-01-01', '205', 'L', 'DE02120300000000202051', 'paula@example.org'),
    ('0000000206', 'Kim', 'Eltern', '2015-09-09', '2021-01-01', '206', 'L', null, null),
    ('0000000207', 'Otto', 'Passiv', '1960-01-01', '2000-01-01', '207', 'L', 'DE02120300000000202051', null)`;
  await sql`update tco.mitglieder set adrnrkih = '0000000205' where adrnr = '0000000206'`;
  // „Meine Mitgliedschaft“: der angemeldete Benutzer ist Paula Eltern, Kim zahlt über sie
  await sql`insert into tco.mitgliedera (adrnr, benutzer_id) select '0000000205', id from core.users where username = 'admin'`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, vertragende, betrag) values
    ('0000000201', '1', '5', 'Erwachsene', '201', 'halbjährlich', '2020-01-01', null, 60),
    ('0000000202', '1', '3', 'Jugendliche', '202', 'halbjährlich', '2020-01-01', null, 20),
    ('0000000203', '1', '3', 'Jugendliche', '203', 'halbjährlich', '2024-01-01', null, 20),
    ('0000000203', '2', '90', 'Jugendtraining', '203', 'monatlich', '2024-01-01', null, 35),
    ('0000000205', '1', '5', 'Erwachsene', '205', 'halbjährlich', '2021-01-01', null, 60),
    ('0000000206', '1', '3', 'Jugendliche', '206', 'halbjährlich', '2021-01-01', null, 20),
    ('0000000207', '1', '7', 'Passive Mitglieder', '207', 'halbjährlich', '2000-01-01', null, 30),
    ('0000000207', '2', '91', 'Jugendtraining 2. Einheit', '207', 'monatlich', '2000-01-01', null, 30)`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Fristen: 4 Wochen zum 31.12. bzw. 30.09., Wechsel zum Halbjahr', () => {
  assert.equal(fristEnde('2026-11-12', false), '2026-12-31');
  assert.equal(fristEnde('2026-12-10', false), '2027-12-31');
  assert.equal(fristEnde('2026-08-15', true), '2026-09-30');
  assert.equal(fristEnde('2026-09-10', true), '2027-09-30');
  assert.equal(wechselAb('2026-11-12'), '2027-01-01');
  assert.equal(wechselAb('2026-03-05'), '2026-07-01');
});

test('Beitragswechsel: prüfen ändert nichts, ausführen beendet den alten und legt den neuen Vertrag an', async () => {
  let r = await call('GET', `${M}/m/0000000202/vorgang`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ab = r.body.vorschlag.wechselAb as string;
  assert.equal(r.body.laufend.length, 1);
  assert.ok(r.body.arten.some((a: { art: string }) => a.art === '5'));

  const g = { typ: 'BEITRAGSWECHSEL', adrnr: '0000000202', vertragnr: '1', art: '5', ab };
  assert.equal((await call('POST', `${M}/vorgang/pruefen`, { ...g, art: '3' })).status, 400, 'gleiche Art');
  r = await call('POST', `${M}/vorgang/pruefen`, g);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.schritte.length, 3);
  assert.match(r.body.schritte[0], /„Jugendliche“.*endet am/);
  assert.match(r.body.schritte[1], /„Erwachsene“.*60,00 € halbjährlich/);
  assert.equal((await vertraege('0000000202')).length, 1, 'prüfen schreibt nicht');

  r = await call('POST', `${M}/vorgang`, { ...g, unterlage: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /^Beitragswechsel ausgeführt:/);
  assert.equal(r.body.unterlage, null);
  const v = await vertraege('0000000202');
  assert.deepEqual(v.map((x) => [x.art, x.beginn, x.ende, x.betrag]), [['3', '2020-01-01', tagVorher(ab), 20], ['5', ab, null, 60]]);
  const [n] = await sql`select notiz from tco.mgnotiz where adrnr = '0000000202'`;
  assert.match(n.notiz, /Beitragswechsel \(geführter Vorgang\) durch Admin/);
  // zweiter Wechsel aus dem beendeten Vertrag: nicht möglich
  assert.equal((await call('POST', `${M}/vorgang`, g)).status, 400);
});

test('Jugendtraining: Nichtmitglied mit Hinweis, kein zweiter laufender Vertrag', async () => {
  let r = await call('GET', `${M}/m/0000000204/vorgang`);
  const beginn = r.body.vorschlag.jugendAb as string;
  assert.equal(beginn.slice(8), '01');
  const g = { typ: 'JUGENDTRAINING', adrnr: '0000000204', beginn };
  r = await call('POST', `${M}/vorgang/pruefen`, g);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.warnungen.some((w: string) => /kein Vereinsmitglied/.test(w)));
  r = await call('POST', `${M}/vorgang`, g);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await vertraege('0000000204')).map((x) => [x.art, x.beginn, x.ende, x.betrag, x.sollstellung]), [['90', beginn, null, 35, 'monatlich']]);
  r = await call('POST', `${M}/vorgang/pruefen`, g);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits ein Vertrag „Jugendtraining“/);
});

test('Kündigung: einzelner Vertrag mit Fristhinweis, Mitgliedschaft mit Austritt und Kündigungsbestätigung', async () => {
  let r = await call('GET', `${M}/m/0000000203/vorgang`);
  const eingang = r.body.vorschlag.eingang as string;
  // Jugendtraining früher als fristgerecht beenden: erlaubt, aber mit Hinweis
  const frueh = eingang;
  r = await call('POST', `${M}/vorgang/pruefen`, { typ: 'KUENDIGUNG', adrnr: '0000000203', umfang: 'VERTRAG', vertragnr: '2', eingang, ende: frueh });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.warnungen.some((w: string) => /Fristgerecht wäre der 30\.09\./.test(w)), JSON.stringify(r.body.warnungen));
  const endeJt = fristEnde(eingang, true);
  r = await call('POST', `${M}/vorgang`, { typ: 'KUENDIGUNG', adrnr: '0000000203', umfang: 'VERTRAG', vertragnr: '2', eingang, ende: endeJt });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await vertraege('0000000203'))[1].ende, endeJt);

  r = await call('GET', `${M}/m/0000000201/vorgang`);
  const ende = r.body.vorschlag.endeMitgliedschaft as string;
  const g = { typ: 'KUENDIGUNG', adrnr: '0000000201', umfang: 'MITGLIEDSCHAFT', eingang, ende, grund: 'Umzug', unterlage: true };
  r = await call('POST', `${M}/vorgang/pruefen`, g);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.schritte.some((s: string) => /^Austritt zum/.test(s)));
  assert.ok(r.body.schritte.some((s: string) => /Kündigungsbestätigung erzeugen/.test(s)));
  r = await call('POST', `${M}/vorgang`, g);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [m] = await sql`select austritt::text as austritt from tco.mitglieder where adrnr = '0000000201'`;
  assert.equal(m.austritt, ende);
  assert.equal((await vertraege('0000000201'))[0].ende, ende);
  // Kündigungsbestätigung: PDF erzeugt, ohne Paperless/Mailversand mit Hinweisen
  assert.equal(r.body.unterlage.titel, 'Kündigungsbestätigung');
  assert.ok(Buffer.from(r.body.unterlage.pdf, 'base64').subarray(0, 4).toString() === '%PDF');
  assert.equal(r.body.unterlage.gesendet, false);
  assert.ok(r.body.unterlage.hinweise.some((h: string) => /Paperless ist nicht eingerichtet/.test(h)));
  const [n] = await sql`select notiz from tco.mgnotiz where adrnr = '0000000201'`;
  assert.match(n.notiz, /Grund: Umzug/);
  r = await call('POST', `${M}/vorgang`, g);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits zum .* gekündigt/);
});

test('Meine Mitgliedschaft: Beitrag wechseln und Jugendtraining selbst abschließen – nur das Angebotene, auch für Kinder', async () => {
  const S = `${M}/meine/vorgang`;
  let r = await call('GET', S);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [ich, kim] = r.body.personen;
  assert.equal(r.body.personen.length, 2);
  assert.equal(ich.ich, true);
  // Erwachsene: Wechsel in „Passive Mitglieder“ möglich, nicht in den Jugendbeitrag; kein Jugendtraining
  assert.deepEqual(ich.wechsel.arten.map((a: { art: string }) => a.art), ['7']);
  assert.equal(ich.training.length, 0);
  assert.match(ich.trainingHinweis, /bis 21 Jahre/);
  assert.deepEqual(kim.training.map((a: { art: string }) => a.art), ['90', '91']);

  assert.equal((await call('POST', `${S}/pruefen`, { typ: 'BEITRAGSWECHSEL', adrnr: '0000000205', art: '3' })).status, 400, 'Jugendbeitrag für Erwachsene');
  assert.equal((await call('POST', `${S}/pruefen`, { typ: 'JUGENDTRAINING', adrnr: '0000000205', art: '90' })).status, 400, 'Training über 21');
  assert.equal((await call('POST', `${S}/pruefen`, { typ: 'JUGENDTRAINING', adrnr: '0000000203', art: '91' })).status, 403, 'fremde Person');

  // Jugendtraining für das Kind: prüfen schreibt nicht, ausführen legt den Vertrag zum nächsten Monatsersten an
  r = await call('POST', `${S}/pruefen`, { typ: 'JUGENDTRAINING', adrnr: '0000000206', art: '90' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await vertraege('0000000206')).length, 1);
  r = await call('POST', S, { typ: 'JUGENDTRAINING', adrnr: '0000000206', art: '90' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /^Abschluss Jugendtraining ausgeführt/);
  assert.equal(r.body.unterlage.titel, 'Mitgliederinformation');
  assert.ok(Buffer.from(r.body.unterlage.pdf, 'base64').subarray(0, 4).toString() === '%PDF');
  let v = await vertraege('0000000206');
  assert.deepEqual(v.map((x) => [x.art, x.betrag, x.ende]), [['3', 20, null], ['90', 35, null]]);
  assert.equal(v[1].beginn.slice(8), '01');
  const [n] = await sql`select notiz, erstellt_von from tco.mgnotiz where adrnr = '0000000206'`;
  assert.equal(n.erstellt_von, 'Portal');
  assert.match(n.notiz, /Admin über „Meine Mitgliedschaft“/);
  // dieselbe Einheit nicht doppelt, die zweite Einheit schon – danach ist Schluss (höchstens zwei)
  assert.equal((await call('POST', S, { typ: 'JUGENDTRAINING', adrnr: '0000000206', art: '90' })).status, 400);
  r = await call('POST', S, { typ: 'JUGENDTRAINING', adrnr: '0000000206', art: '91' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', S);
  assert.match(r.body.personen[1].trainingHinweis, /bereits 2 Trainingseinheiten/);

  // Beitragswechsel zum nächsten Halbjahr
  const ab = r.body.ab as string;
  r = await call('POST', S, { typ: 'BEITRAGSWECHSEL', adrnr: '0000000205', art: '7' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  v = await vertraege('0000000205');
  assert.deepEqual(v.map((x) => [x.art, x.beginn, x.ende, x.betrag]), [['5', '2021-01-01', tagVorher(ab), 60], ['7', ab, null, 30]]);
});
