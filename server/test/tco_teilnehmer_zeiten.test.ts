/**
 * Teilnehmer Jugendtraining: Trainingszeiten je Saison (Sommer/Winter) pflegen, in der Liste anzeigen, aus dem Vorjahr
 * übernehmen, Berechtigung tco.teilnehmer:edit – und Ausweis „Familienbeitrag“, wenn die Eltern (Zahler bzw.
 * Familienverknüpfung) einen Familienbeitrag haben.
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
const call = client();
const T = '/api/m/tco/teilnehmer';
const jahr = Number(new Date().toISOString().slice(0, 4));

// Testpersonen 0000007xxx:
//  701 Vater mit Familienbeitrag, 702 Kind (Zahler 701) nur Jugendtraining → Familienbeitrag
//  703 Mutter (verknüpft mit 701), 704 Kind (Zahler 703) nur Jugendtraining → Familienbeitrag über zwei Schritte
//  705 Kind mit eigener Jugend-Mitgliedschaft → Ja, 706 Kind ohne Mitgliedschaft → Nein
//  707 Kind mit eigenem Familienvertrag (Betrag 0) → Familienbeitrag
//  708 Mutter mit beendetem Familienbeitrag, 709 Kind (Zahler 708) → Nein
before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, geburtsdatum, eintritt, austritt, adrnrkih) values
    ('0000000701', 'Frank', 'Vogel', 'frank@example.org', '1980-01-01', '2015-01-01', null, null),
    ('0000000702', 'Mia', 'Vogel', '', ${`${jahr - 10}-05-05`}, '2020-01-01', null, '0000000701'),
    ('0000000703', 'Sara', 'Vogel', 'sara@example.org', '1982-02-02', '2015-01-01', null, null),
    ('0000000704', 'Ben', 'Vogel', '', ${`${jahr - 8}-05-05`}, '2020-01-01', null, '0000000703'),
    ('0000000705', 'Ole', 'Adler', 'ole@example.org', ${`${jahr - 12}-01-01`}, '2020-01-01', null, null),
    ('0000000706', 'Ida', 'Fink', 'ida@example.org', ${`${jahr - 11}-01-01`}, '2020-01-01', null, null),
    ('0000000707', 'Lia', 'Specht', 'lia@example.org', ${`${jahr - 9}-01-01`}, '2020-01-01', null, null),
    ('0000000708', 'Nora', 'Meise', 'nora@example.org', '1979-01-01', '2010-01-01', null, null),
    ('0000000709', 'Tom', 'Meise', '', ${`${jahr - 13}-01-01`}, '2020-01-01', null, '0000000708')`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, sollstellung, vertragbegin, vertragende, betrag) values
    ('0000000701', '1', '30', 'Familienbeitrag', 'jährlich', '2015-01-01', null, 180),
    ('0000000702', '1', '90', 'Jugendtraining', 'monatlich', '2020-01-01', null, 30),
    ('0000000703', '1', '10', 'Erwachsene', 'jährlich', '2015-01-01', null, 100),
    ('0000000704', '1', '90', 'Jugendtraining', 'monatlich', '2020-01-01', null, 30),
    ('0000000705', '1', '20', 'Jugendliche', 'jährlich', '2020-01-01', null, 50),
    ('0000000705', '2', '90', 'Jugendtraining', 'monatlich', '2020-01-01', null, 30),
    ('0000000706', '1', '90', 'Jugendtraining', 'monatlich', '2020-01-01', null, 30),
    ('0000000707', '1', '30', 'Familienbeitrag', 'jährlich', '2020-01-01', null, 0),
    ('0000000707', '2', '90', 'Jugendtraining', 'monatlich', '2020-01-01', null, 30),
    ('0000000708', '1', '30', 'Familienbeitrag', 'jährlich', '2010-01-01', '2020-12-31', 180),
    ('0000000709', '1', '90', 'Jugendtraining', 'monatlich', '2020-01-01', null, 30)`;
  await sql`insert into tco.familienverknuepfungen (adrnr_a, adrnr_b) values ('0000000701', '0000000703')`;
});

after(async () => {
  await app?.close();
  await sql.end();
});

test('Familienbeitrag: Kinder, deren Familie einen laufenden Familienbeitrag hat, sind Mitglied als „Familienbeitrag“', async () => {
  const r = await call('GET', T);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = new Map<string, any>(r.body.teilnehmer.map((t: any) => [t.adrnr, t]));
  assert.deepEqual([...m.keys()].sort(), ['0000000702', '0000000704', '0000000705', '0000000706', '0000000707', '0000000709']);
  assert.deepEqual([m.get('0000000702').mitglied_text, m.get('0000000702').familie_von, m.get('0000000702').mitglied], ['Familienbeitrag', 'Frank Vogel', true]);
  assert.deepEqual([m.get('0000000704').mitglied_text, m.get('0000000704').familie_von], ['Familienbeitrag', 'Frank Vogel'], 'über Mutter ↔ Vater');
  assert.equal(m.get('0000000705').mitglied_text, 'Ja');
  assert.equal(m.get('0000000706').mitglied_text, 'Nein');
  assert.deepEqual([m.get('0000000707').mitglied_text, m.get('0000000707').familie_von], ['Familienbeitrag', 'Lia Specht']);
  assert.deepEqual([m.get('0000000709').mitglied_text, m.get('0000000709').mitglied_state], ['Nein', 'Critical'], 'beendeter Familienbeitrag zählt nicht');
  assert.equal(r.body.mitglieder, 4);
  assert.equal(r.body.nichtmitglieder, 2);

  const d = await call('GET', `${T}/0000000702`);
  assert.deepEqual([d.body.familienbeitrag, d.body.familie_von, d.body.mitglied], [true, 'Frank Vogel', true]);
  const pdf = await call('GET', `${T}/pdf?filter=MEMBER`);
  assert.equal(pdf.status, 200);
});

test('Trainingszeiten je Saison: speichern, Liste, Prüfung, Übernahme aus dem Vorjahr', async () => {
  const sommer = { jahr: 2031, saison: 'SOMMER' };
  let r = await call('PUT', `${T}/0000000702/zeiten`, { ...sommer, zeiten: [
    { wochentag: 3, von: '17:00', bis: '18:00', bemerkung: 'Gruppe B' },
    { wochentag: 1, von: '16:00', bis: '17:00' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.zeiten_text, 'Mo 16:00–17:00, Mi 17:00–18:00');
  assert.equal(r.body.text, 'Sommer 2031');

  r = await call('GET', `${T}/0000000702/zeiten?jahr=2031&saison=SOMMER`);
  assert.deepEqual(r.body.zeiten.map((z: any) => [z.wochentag, z.von, z.bis, z.bemerkung]), [[1, '16:00', '17:00', ''], [3, '17:00', '18:00', 'Gruppe B']]);
  r = await call('GET', `${T}/0000000702/zeiten?jahr=2031&saison=WINTER`);
  assert.deepEqual(r.body.zeiten, [], 'Winter ist eine eigene Saison');
  assert.equal(r.body.text, 'Winter 2031/32');

  r = await call('GET', `${T}?jahr=2031&saison=SOMMER`);
  const mia = r.body.teilnehmer.find((t: any) => t.adrnr === '0000000702');
  assert.equal(mia.zeiten_text, 'Mo 16:00–17:00, Mi 17:00–18:00');
  assert.equal(r.body.mit_zeiten, 1);
  assert.deepEqual(r.body.vorjahr, { jahr: 2030, saison: 'SOMMER', text: 'Sommer 2030' });
  // ohne Angabe: Saison zum heutigen Tag
  r = await call('GET', T);
  assert.ok(['SOMMER', 'WINTER'].includes(r.body.saison.saison));

  // Prüfungen
  r = await call('PUT', `${T}/0000000702/zeiten`, { ...sommer, zeiten: [
    { wochentag: 2, von: '16:00', bis: '17:30' }, { wochentag: 2, von: '17:00', bis: '18:00' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /überschneiden sich/);
  assert.equal((await call('PUT', `${T}/0000000702/zeiten`, { ...sommer, zeiten: [{ wochentag: 2, von: '18:00', bis: '17:00' }] })).status, 400);
  assert.equal((await call('PUT', `${T}/0000000702/zeiten`, { jahr: 2031, saison: 'HERBST', zeiten: [] })).status, 400);
  assert.equal((await call('PUT', `${T}/0000009999/zeiten`, { ...sommer, zeiten: [] })).status, 400);
  r = await call('GET', `${T}/0000000702/zeiten?jahr=2031&saison=SOMMER`);
  assert.equal(r.body.zeiten.length, 2, 'fehlerhafte Eingabe ändert nichts');

  // Übernahme Sommer 2031 → Sommer 2032: nur Teilnehmer ohne Zeiten in der Zielsaison
  await call('PUT', `${T}/0000000705/zeiten`, { ...sommer, zeiten: [{ wochentag: 5, von: '15:00', bis: '16:00' }] });
  await call('PUT', `${T}/0000000705/zeiten`, { jahr: 2032, saison: 'SOMMER', zeiten: [{ wochentag: 6, von: '10:00', bis: '11:00' }] });
  r = await call('POST', `${T}/zeiten/uebernehmen`, { von: sommer, nach: { jahr: 2032, saison: 'SOMMER' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.personen, r.body.zeiten, r.body.uebersprungen], [1, 2, 1]);
  r = await call('GET', `${T}?jahr=2032&saison=SOMMER`);
  const z = new Map<string, string>(r.body.teilnehmer.map((t: any) => [t.adrnr, t.zeiten_text]));
  assert.equal(z.get('0000000702'), 'Mo 16:00–17:00, Mi 17:00–18:00');
  assert.equal(z.get('0000000705'), 'Sa 10:00–11:00', 'vorhandene Zeiten bleiben unverändert');
  assert.equal((await call('POST', `${T}/zeiten/uebernehmen`, { von: sommer, nach: sommer })).status, 400);

  // leere Liste entfernt die Zeiten der Saison
  r = await call('PUT', `${T}/0000000705/zeiten`, { jahr: 2032, saison: 'SOMMER', zeiten: [] });
  assert.equal(r.body.zeiten_text, '');
  const [n] = await sql`select count(*)::int as n from tco.tn_trainingszeit where adrnr = '0000000705' and jahr = 2032`;
  assert.equal(n.n, 0);
});

test('Berechtigung: tco.teilnehmer:display sieht die Zeiten, ändern nur mit tco.teilnehmer:edit', async () => {
  assert.equal((await call('POST', '/api/admin/roles', { id: 'TNZ', name: 'Teilnehmer lesen', permissions: ['tco.teilnehmer:display'] })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { username: 'tnleser', displayName: 'Tina Leser', password: 'start-passwort', roles: ['TNZ'] })).status, 200);
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'tnleser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  assert.equal((await leser('GET', `${T}?jahr=2031&saison=SOMMER`)).status, 200);
  assert.equal((await leser('GET', `${T}/0000000702/zeiten?jahr=2031&saison=SOMMER`)).status, 200);
  assert.equal((await leser('PUT', `${T}/0000000702/zeiten`, { jahr: 2031, saison: 'SOMMER', zeiten: [] })).status, 403);
  assert.equal((await leser('POST', `${T}/zeiten/uebernehmen`, { von: { jahr: 2031, saison: 'SOMMER' }, nach: { jahr: 2033, saison: 'SOMMER' } })).status, 403);
});
