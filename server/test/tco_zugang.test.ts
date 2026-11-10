/**
 * Zugang (#10) und Mitgliedsantrag (#12):
 *  - Passwort vergessen / Einmal-Link (Kern), Benutzeranlage mit Einmal-Link
 *  - Registrierung extern (Double-Opt-In → sofort Hallennutzer) und als Mitglied (Abgleich, Freigabe durch den Kassenwart)
 *  - Online-Mitgliedsantrag (Familie, SEPA online) mit Übernahme: Mitglieder, Verträge, Mandat, Benutzer (Rolle Mitglied)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}
const admin = client();
const T = '/api/m/tco';
const mails: { an: string; betreff: string; text: string; absender?: string; absender_name?: string; antwort_an?: string; absender_ersatz?: string }[] = [];
let n8nAblehnen = false;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (n8nAblehnen) { res.writeHead(403); res.end('Authorization data is wrong!'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').startsWith('/webhook/mail')) mails.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.end(JSON.stringify({ status: 'gesendet', message_id: `m${mails.length}` }));
  });
});
const letzteMail = (an: string) => [...mails].reverse().find((m) => m.an.toLowerCase() === an.toLowerCase());
const token = (text: string, param: string) => new RegExp(`[?&]${param}=([A-Za-z0-9_-]+)`).exec(text)?.[1] ?? '';
const heute = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis) values ('mail', ${`http://127.0.0.1:${port}/webhook/mail`}, 'header', 'X-TCO-Key', 'k') on conflict (id) do update set url = excluded.url, auth_art = 'header', header_name = 'X-TCO-Key', geheimnis = excluded.geheimnis`;
  await sql`insert into tco.mitglieder (adrnr, mitglnrn, vorname, nachname, geburtsdatum, email, eintritt) values
            ('0000000501', '501', 'Maria', 'Mitglied', '1980-05-17', 'maria@example.org', '2015-01-01'),
            ('0000000502', '502', 'Otto', 'Ohnemail', '1975-02-02', null, '2015-01-01')`;
  await sql`insert into tco.beitrag (art, bezeichnung, turnus) values ('5', 'Erwachsene', 'jährlich'), ('3', 'Jugendliche', 'jährlich'),
            ('90', 'Jugendtraining', 'monatlich'), ('95', 'Spende', 'jährlich'), ('8', 'Mitgliedsbeitrag Familien', 'halbjährl.'), ('6', 'Mitgliedsbeitrag Inaktiv', 'halbjährl.')`;
  await sql`insert into tco.beitrag_pr (art, gueltig_ab, betrag) values ('5', '2000-01-01', 150), ('3', '2000-01-01', 60), ('90', '2000-01-01', 35), ('95', '2000-01-01', 10), ('8', '2000-01-01', 125), ('6', '2000-01-01', 32.5)`;
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

test('Passwort vergessen und Einmal-Link', async () => {
  // ohne Portal-Adresse kein Link (Schutz gegen Host-Header-Manipulation), Antwort trotzdem neutral
  await admin('POST', '/api/admin/users', { username: 'paula', displayName: 'Paula', email: 'paula@example.org', password: 'start-passwort', roles: [] });
  let r = await client()('POST', '/api/auth/passwort-vergessen', { konto: 'paula' });
  assert.equal(r.status, 200);
  assert.equal(letzteMail('paula@example.org'), undefined);

  r = await admin('PUT', '/api/settings', { 'portal.url': 'https://portal.example.org' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const neutral = (await client()('POST', '/api/auth/passwort-vergessen', { konto: 'gibt-es-nicht' })).body.text;
  r = await client()('POST', '/api/auth/passwort-vergessen', { konto: 'Paula@Example.org' });
  assert.equal(r.body.text, neutral, 'gleiche Antwort für vorhandene und unbekannte Konten');
  const m = letzteMail('paula@example.org')!;
  assert.match(m.text, /https:\/\/portal\.example\.org\/\?kennwort=/);
  const t = token(m.text, 'kennwort');
  const [h] = await sql`select token_hash from core.password_tokens where zweck = 'RESET'`;
  assert.notEqual(h.token_hash, t, 'nur der Hash ist gespeichert');

  const paula = client();
  await paula('POST', '/api/auth/login', { username: 'paula', password: 'start-passwort' });
  r = await client()('GET', `/api/auth/kennwort-link?token=${t}`);
  assert.deepEqual(r.body, { gueltig: true, zweck: 'RESET', username: 'paula' });
  assert.equal((await client()('POST', '/api/auth/kennwort-setzen', { token: t, passwort: 'kurz' })).status, 400);
  r = await client()('POST', '/api/auth/kennwort-setzen', { token: t, passwort: 'ganz-neues-kennwort' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await paula('GET', '/api/auth/me')).status, 401, 'Sitzungen beendet');
  assert.equal((await client()('POST', '/api/auth/kennwort-setzen', { token: t, passwort: 'noch-ein-kennwort' })).status, 400, 'Link nur einmal');
  assert.equal((await client()('GET', `/api/auth/kennwort-link?token=${t}`)).body.gueltig, false);
  r = await client()('POST', '/api/auth/login', { username: 'paula', password: 'ganz-neues-kennwort' });
  assert.equal(r.status, 200);
  const [u] = await sql`select must_change_password from core.users where username = 'paula'`;
  assert.equal(u.must_change_password, false);

  // Anlage durch den Verein mit Einmal-Link statt Startkennwort
  assert.equal((await admin('POST', '/api/admin/users', { username: 'ohne.mail', displayName: 'Ohne', roles: [], einmalLink: true })).status, 400);
  r = await admin('POST', '/api/admin/users', { username: 'lisa', displayName: 'Lisa', email: 'lisa@example.org', roles: [], einmalLink: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Link/);
  const t2 = token(letzteMail('lisa@example.org')!.text, 'kennwort');
  assert.equal((await client()('POST', '/api/auth/login', { username: 'lisa', password: 'irgendwas-langes' })).status, 401, 'kein bekanntes Kennwort');
  assert.equal((await client()('POST', '/api/auth/kennwort-setzen', { token: t2, passwort: 'lisas-kennwort-1' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'lisa', password: 'lisas-kennwort-1' })).status, 200);
  // nachträglich für einen bestehenden Benutzer
  const [p] = await sql`select id::text from core.users where username = 'paula'`;
  r = await admin('POST', `/api/admin/users/${p.id}/kennwort-link`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(letzteMail('paula@example.org')!.betreff, /Kennwort festlegen/);
});

test('Registrierung extern: E-Mail bestätigen, sofort Hallennutzer', async () => {
  const R = `${T}/platz/registrierung`;
  const gast = client();
  // Absender je Anwendung (Administration → Anbindungen → E-Mail-Versand); leere Zeilen werden ignoriert
  let s = await admin('PUT', '/api/verbindungen/mail', { einstellungen: { absender: [
    { anwendung: '*', email: 'info@tc-oberthal.de', name: 'TC Oberthal' },
    { anwendung: 'registrierung', email: 'portal@tc-oberthal.de', name: 'TCO Portal', antwort_an: 'platz@tc-oberthal.de' },
    { anwendung: '', email: '' },
  ] } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.einstellungen.absender.length, 2);
  assert.equal((await admin('GET', `${T}/verein`)).body.mail_absender.length, 2, 'Verein liest die Absender aus der Anbindung');
  s = await admin('PUT', '/api/verbindungen/mail', { einstellungen: { absender: [{ anwendung: '*', email: 'kein-mail' }] } });
  assert.equal(s.status, 400);
  assert.equal((await gast('GET', R)).body.mitglied, true);
  // Pflichtangaben Anrede und Anschrift
  const ohne = { art: 'EXTERN', vorname: 'Erik', nachname: 'Extern', email: 'erik@example.org', benutzername: 'erik', passwort: 'eriks-kennwort-1', datenschutz: true };
  assert.equal((await gast('POST', R, ohne)).status, 400);
  assert.equal((await gast('POST', R, { ...ohne, anrede: 'Herr', strasse: 'Ringstraße', plz: '66649', ort: 'Oberthal' })).status, 400, 'Hausnummer fehlt');
  let r = await gast('POST', R, { art: 'EXTERN', anrede: 'Herr', strasse: 'Ringstr. 5', plz: '66649', ort: 'Oberthal', vorname: 'Erik', nachname: 'Extern', email: 'erik@example.org', benutzername: 'erik', passwort: 'eriks-kennwort-1', datenschutz: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /bestätigen/);
  const m = letzteMail('erik@example.org')!;
  assert.match(m.text, /registrierung-bestaetigen\?token=/);
  assert.deepEqual([m.absender, m.absender_name, m.antwort_an], ['portal@tc-oberthal.de', 'TCO Portal', 'platz@tc-oberthal.de']);
  const t = token(m.text, 'token');
  // noch nicht freigeschaltet, nicht im Eingang der Platzverwaltung
  assert.equal((await client()('POST', '/api/auth/login', { username: 'erik', password: 'eriks-kennwort-1' })).status, 401);
  assert.ok(!(await admin('GET', `${T}/platz/admin/registrierungen`)).body.some((x: any) => x.benutzername === 'erik'));
  assert.equal((await gast('POST', R, { art: 'EXTERN', anrede: 'Herr', strasse: 'Ringstr. 5', plz: '66649', ort: 'Oberthal', vorname: 'E', nachname: 'X', email: 'x@example.org', benutzername: 'erik', passwort: 'eriks-kennwort-1', datenschutz: true })).status, 409, 'Name reserviert');

  assert.equal((await gast('POST', `${R}/bestaetigen`, { token: 'x'.repeat(40) })).status, 404);
  r = await gast('POST', `${R}/bestaetigen`, { token: t });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await gast('POST', `${R}/bestaetigen`, { token: t })).status, 404, 'Link nur einmal');
  const [u] = await sql`select u.id, array_agg(ur.role_id) as rollen from core.users u join core.user_roles ur on ur.user_id = u.id where u.username = 'erik' group by u.id`;
  assert.deepEqual(u.rollen, ['HALLENNUTZER']);
  const [k] = await sql`select zuid from tco.kunden where benutzer_id = ${u.id}`;
  assert.ok(k, 'eigener Kundenstammsatz');
  assert.match(letzteMail('erik@example.org')!.betreff, /freigeschaltet/);
  const [kd] = await sql`select strasse, plz, wohnort, geschlecht from tco.kunden where benutzer_id = ${u.id}`;
  assert.deepEqual({ ...kd }, { strasse: 'Ringstr. 5', plz: '66649', wohnort: 'Oberthal', geschlecht: 'M' });

  // Meine Daten: nur der eigene Kundenstammsatz
  const erik = client();
  assert.equal((await erik('POST', '/api/auth/login', { username: 'erik', password: 'eriks-kennwort-1' })).status, 200);
  r = await erik('GET', `${T}/meinkonto`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.anrede, r.body.strasse, r.body.ort], ['Herr', 'Ringstr. 5', 'Oberthal']);
  assert.equal((await erik('PUT', `${T}/meinkonto`, { ...r.body, plz: 'abc' })).status, 400);
  r = await erik('PUT', `${T}/meinkonto`, { ...r.body, strasse: 'Neue Str. 9', plz: '66640', ort: 'Namborn', email: 'erik.neu@example.org', telefon: '0151 1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [k2] = await sql`select strasse, plz, wohnort, email, telefonnummer from tco.kunden where benutzer_id = ${u.id}`;
  assert.deepEqual({ ...k2 }, { strasse: 'Neue Str. 9', plz: '66640', wohnort: 'Namborn', email: 'erik.neu@example.org', telefonnummer: '0151 1' });
  const [u2] = await sql`select email from core.users where id = ${u.id}`;
  assert.equal(u2.email, 'erik.neu@example.org');
  assert.equal((await erik('GET', `${T}/mitglieder/liste`)).status, 403, 'sonst nichts');
});

test('Registrierung Mitglied: Abgleich, Arbeitsvorrat, Freigabe durch den Kassenwart', async () => {
  const R = `${T}/platz/registrierung`;
  const basis = { art: 'MITGLIED', anrede: 'Frau', strasse: 'Lindenweg 2', plz: '66649', ort: 'Oberthal', vorname: 'Maria', nachname: 'Mitglied', email: 'maria@example.org', passwort: 'marias-kennwort', datenschutz: true };
  assert.equal((await client()('POST', R, { ...basis, benutzername: 'maria' })).status, 400, 'Nachweis fehlt');
  let r = await client()('POST', R, { ...basis, benutzername: 'maria', geburtsdatum: '1980-05-17' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(letzteMail('maria@example.org')!.betreff, /eingegangen/);
  r = await client()('POST', R, { ...basis, vorname: 'Otto', nachname: 'Ohnemail', email: 'otto@example.org', benutzername: 'otto', mitgliedsnr: '502' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Kassenwart-Rolle: nur Registrierungen und Übersicht
  await admin('POST', '/api/admin/roles', { id: 'KASSENWART', name: 'Kassenwart', permissions: ['tco.registrierung:mitglied', 'tco.dashboard:display'] });
  await admin('POST', '/api/admin/users', { username: 'kasse', displayName: 'Kassenwart', password: 'start-passwort', roles: ['KASSENWART'] });
  const kasse = client();
  await kasse('POST', '/api/auth/login', { username: 'kasse', password: 'start-passwort' });
  await kasse('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' });
  r = await kasse('GET', `${T}/registrierungen/mitglieder`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const maria = r.body.find((x: any) => x.benutzername === 'maria');
  const otto = r.body.find((x: any) => x.benutzername === 'otto');
  assert.equal(maria.vorschlaege[0].schluessel, '0000000501');
  assert.match(maria.vorschlaege[0].grund, /Geburtsdatum/);
  assert.equal(otto.vorschlaege[0].schluessel, '0000000502');
  assert.match(otto.vorschlaege[0].grund, /Mitgliedsnummer/);
  // nicht in der Platzverwaltung, aber im Arbeitsvorrat des Kassenwarts mit Vorschlag
  assert.ok(!(await admin('GET', `${T}/platz/admin/registrierungen`)).body.some((x: any) => x.benutzername === 'maria'));
  r = await kasse('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = (r.body.aufgaben ?? r.body).find((x: any) => x.key === `REG_MITGLIED:${maria.id}`);
  assert.ok(a, JSON.stringify(r.body));
  assert.match(a.text, /Maria Mitglied/);
  assert.equal((await kasse('POST', `${T}/platz/admin/registrierungen/${maria.id}/bestaetigen`, { zuordnung: { art: 'NEU' } })).status, 403);

  // Absender ist, wer auf „Freigeben“ drückt; Ersatz je Anwendung bzw. „*“ geht mit
  await sql`update core.users set email = 'kai.kasse@tc-oberthal.de' where username = 'kasse'`;
  r = await kasse('POST', `${T}/registrierungen/mitglieder/${maria.id}/freigeben`, { adrnr: '0000000501' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fm = letzteMail('maria@example.org')!;
  assert.deepEqual([fm.absender, fm.absender_name, fm.absender_ersatz, fm.antwort_an], ['kai.kasse@tc-oberthal.de', 'Kassenwart | Verein', 'portal@tc-oberthal.de', '']);
  assert.match(r.body.text, /Rolle Mitglied/);
  const [u] = await sql`select u.id, array_agg(ur.role_id) as rollen from core.users u join core.user_roles ur on ur.user_id = u.id where u.username = 'maria' group by u.id`;
  assert.deepEqual(u.rollen, ['MITGLIED']);
  const [z] = await sql`select benutzer_id from tco.mitgliedera where adrnr = '0000000501'`;
  assert.equal(z.benutzer_id, u.id);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'maria', password: 'marias-kennwort' })).status, 200);

  r = await kasse('POST', `${T}/registrierungen/mitglieder/${otto.id}/ablehnen`, { bemerkung: 'Bitte persönlich melden' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(letzteMail('otto@example.org')!.text, /Bitte persönlich melden/);
});

test('Mitgliedsantrag online: Familie mit SEPA, Übernahme legt Mitglieder und Benutzer an', async () => {
  const gast = client();
  let r = await gast('GET', `${T}/antrag`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.beitragsarten.map((b: any) => [b.art, b.betrag, b.kategorie, b.jugend]),
    [['3', 60, 'MITGLIEDSCHAFT', true], ['5', 150, 'MITGLIEDSCHAFT', false], ['8', 125, 'MITGLIEDSCHAFT', false], ['90', 35, 'TRAINING', false]], 'Spende und Inaktiv nicht im Antrag');
  assert.deepEqual(r.body.beitragsarten.filter((b: any) => b.familie).map((b: any) => b.art), ['8']);
  assert.match(r.body.kuendigung, /4 Wochen zum Jahresende.*30\.09\./);
  const antrag = {
    personen: [
      { anrede: 'Frau', vorname: 'Fiona', nachname: 'Familie', geburtsdatum: '1985-03-03', art: '8' } as Record<string, unknown>,
      { anrede: 'Herr', vorname: 'Felix', nachname: 'Familie', geburtsdatum: '2012-07-07', training: ['90', '90'] } as Record<string, unknown>,
    ],
    strasse: 'Am Platz 1', plz: '66649', ort: 'Oberthal', email: 'fiona@example.org', telefon: '0681 1',
    eintritt: heute(), satzung: true, datenschutz: true, bildrechte: true, kuendigung: true,
    bank: { kontoinhaber: 'Fiona Familie', iban: 'DE02 1203 0000 0000 2020 51', sepa: true },
  };
  assert.equal((await gast('POST', `${T}/antrag`, { ...antrag, bank: { ...antrag.bank, iban: 'DE00123' } })).status, 400);
  assert.equal((await gast('POST', `${T}/antrag`, { ...antrag, bank: { ...antrag.bank, sepa: false } })).status, 400);
  assert.equal((await gast('POST', `${T}/antrag`, { ...antrag, satzung: false })).status, 400);
  assert.equal((await gast('POST', `${T}/antrag`, { ...antrag, kuendigung: false })).status, 400, 'Kündigungsfristen bestätigen');
  const fiona = antrag.personen[0];
  let x = await gast('POST', `${T}/antrag`, { ...antrag, personen: [{ ...fiona, art: '3' }] });
  assert.match(x.body.message, /Jugendbeitrag/, 'ab 18 kein Jugendbeitrag');
  x = await gast('POST', `${T}/antrag`, { ...antrag, personen: [{ ...fiona, training: ['90'] }] });
  assert.match(x.body.message, /bis 21/, 'über 21 kein Jugendtraining');
  x = await gast('POST', `${T}/antrag`, { ...antrag, personen: [{ ...antrag.personen[1], training: ['90', '90', '90'] }] });
  assert.equal(x.status, 400, 'höchstens 2 Trainingseinheiten');
  x = await gast('POST', `${T}/antrag`, { ...antrag, personen: [{ ...antrag.personen[1], art: '90' }] });
  assert.equal(x.status, 400, 'Training ist keine Mitgliedschaft');
  x = await gast('POST', `${T}/antrag`, { ...antrag, personen: [{ ...fiona, art: '6' }] });
  assert.equal(x.status, 400, 'Inaktiv wird online nicht angeboten');
  x = await gast('POST', `${T}/antrag`, { ...antrag, personen: [{ ...fiona, art: '5' }, antrag.personen[1]] });
  assert.match(x.body.message, /nur mit dem Familienbeitrag/);
  x = await gast('POST', `${T}/antrag`, { ...antrag, personen: [fiona, { ...antrag.personen[1], art: '3' }] });
  assert.match(x.body.message, /über den Familienbeitrag/);
  r = await gast('POST', `${T}/antrag`, { ...antrag, website: 'spam' });
  assert.equal(r.status, 200);
  r = await gast('POST', `${T}/antrag`, antrag);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.nummer, /^MA-\d{4}-0001$/);
  assert.match(letzteMail('fiona@example.org')!.betreff, /eingegangen/);
  assert.equal(letzteMail('fiona@example.org')!.absender, 'info@tc-oberthal.de', 'Standardabsender *');
  const [{ n }] = await sql`select count(*)::int as n from tco.mitgliedsantraege`;
  assert.equal(n, 1, 'Honigtopf verwirft Bot-Anträge');

  // Verwaltung: Bankdaten nur mit Berechtigung im Klartext
  await admin('POST', '/api/admin/roles', { id: 'ANTRAG_LESER', name: 'Anträge lesen', permissions: ['tco.antraege:display'] });
  await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Leser', password: 'start-passwort', roles: ['ANTRAG_LESER'] });
  const leser = client();
  await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' });
  await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' });
  r = await leser('GET', `${T}/mitgliedsantraege`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.body[0].iban.includes('2020'), 'IBAN maskiert');
  const id = r.body[0].id;
  assert.equal((await leser('POST', `${T}/mitgliedsantraege/${id}/uebernehmen`, {})).status, 403);
  r = await admin('GET', `${T}/mitgliedsantraege`);
  assert.equal(r.body[0].iban, 'DE02120300000000202051');
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.ok((r.body.aufgaben ?? r.body).some((x: any) => x.key === 'MITGLIEDSANTRAG'));

  r = await admin('POST', `${T}/mitgliedsantraege/${id}/uebernehmen`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mitglieder.length, 2);
  const m = await sql`select adrnr, vorname, coalesce(nullif(adrnrkih, ''), adrnr) as zahler, iban1, zahlungsart, geburtsdatum::text from tco.mitglieder where nachname = 'Familie' order by geburtsdatum`;
  assert.equal(m.length, 2);
  assert.equal(m[1].zahler, m[0].adrnr, 'Kind zahlt über die Mutter');
  const v = await sql`select adrnr, art from tco.vertraege where adrnr = any(${m.map((x) => x.adrnr)}) order by adrnr`;
  assert.deepEqual(v.map((x) => x.art).sort(), ['8', '8', '90', '90'], 'Familienbeitrag; Felix darüber Mitglied plus 2 Trainingseinheiten');
  const fv = await sql`select art, betrag::float8 as betrag from tco.vertraege where adrnr = ${m[1].adrnr} order by vertragnr`;
  assert.deepEqual(fv.map((x) => [x.art, x.betrag]), [['8', 0], ['90', 35], ['90', 35]]);
  // Beginn: Mitgliedschaft zum nächsten 1.1./1.7., Training zum nächsten Monatsbeginn
  const { beginnFuer } = await import('../../modules/tco/server/antrag/logik.js');
  assert.equal(beginnFuer('2026-11-09', 'MITGLIEDSCHAFT'), '2027-01-01');
  assert.equal(beginnFuer('2026-03-15', 'MITGLIEDSCHAFT'), '2026-07-01');
  assert.equal(beginnFuer('2026-07-01', 'MITGLIEDSCHAFT'), '2026-07-01');
  assert.equal(beginnFuer('2026-11-09', 'TRAINING'), '2026-12-01');
  assert.equal(beginnFuer('2026-12-09', 'TRAINING'), '2027-01-01');
  const bg = await sql`select art, vertragbegin::text as b from tco.vertraege where adrnr = ${m[1].adrnr} order by vertragnr`;
  assert.deepEqual(bg.map((x) => x.b), [beginnFuer(heute(), 'MITGLIEDSCHAFT'), beginnFuer(heute(), 'TRAINING'), beginnFuer(heute(), 'TRAINING')]);
  const [s] = await sql`select mandatsnr from tco.sepa where adrnr = ${m[0].adrnr}`;
  assert.ok(s?.mandatsnr);
  const b = await sql`select u.username, ur.role_id, u.email from core.users u join core.user_roles ur on ur.user_id = u.id
                       join tco.mitgliedera a on a.benutzer_id = u.id where a.adrnr = any(${m.map((x) => x.adrnr)}) order by u.username`;
  assert.equal(b.length, 2);
  assert.ok(b.every((x) => x.role_id === 'MITGLIED'));
  // Einmal-Links und Aufnahmebestätigung
  assert.ok(mails.filter((x) => x.an === 'fiona@example.org' && /Kennwort festlegen/.test(x.betreff)).length >= 2);
  assert.ok(mails.some((x) => x.an === 'fiona@example.org' && /Willkommen/.test(x.betreff)));
  assert.equal((await admin('POST', `${T}/mitgliedsantraege/${id}/uebernehmen`, {})).status, 400, 'nur einmal');

  // zweiter Antrag derselben Person: Dublettenhinweis, Ablehnung mit Begründung
  r = await gast('POST', `${T}/antrag`, { ...antrag, personen: [antrag.personen[0]] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('GET', `${T}/mitgliedsantraege`);
  const zwei = r.body.find((x: any) => x.status === 'EINGANG');
  assert.match(zwei.hinweise[0], /bereits Mitglied/);
  r = await admin('POST', `${T}/mitgliedsantraege/${zwei.id}/ablehnen`, { grund: 'Bereits Mitglied' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(letzteMail('fiona@example.org')!.text, /Bereits Mitglied/);
});

test('Schnuppertraining (#86): Anmeldung als Kategorie im Mitgliederstamm, Betreuung, Beitritt übernimmt denselben Stammsatz', async () => {
  const gast = client();
  let r = await gast('GET', `${T}/schnupper`);
  assert.equal(r.status, 200);
  assert.equal(r.body.einheiten, 2);
  assert.match(r.body.text, /kostenlos/);
  const jahr = Number(heute().slice(0, 4));
  const lena = {
    vorname: 'Lena', nachname: 'Lob', alter: 12, gespielt: false, stufe: 'NEU', email: 'lars.lob@example.org', mobil: '0170 1234567',
    termine: { tage: ['Di', 'Do'], zeiten: ['nachmittags'], text: 'ab 16 Uhr' }, erziehungsberechtigt: 'Lars Lob', einwilligung: true,
  };
  assert.match((await gast('POST', `${T}/schnupper`, { ...lena, email: null, mobil: null })).body.message, /E-Mail-Adresse oder Handynummer/);
  assert.match((await gast('POST', `${T}/schnupper`, { ...lena, erziehungsberechtigt: null })).body.message, /Erziehungsberechtigten/);
  assert.equal((await gast('POST', `${T}/schnupper`, { ...lena, einwilligung: false })).status, 400);
  assert.equal((await gast('POST', `${T}/schnupper`, { ...lena, termine: { tage: [], zeiten: [] } })).status, 400, 'mögliche Termine nötig');
  r = await gast('POST', `${T}/schnupper`, { ...lena, website: 'spam' });
  assert.equal(r.status, 200);
  assert.equal((await sql`select count(*)::int as n from tco.schnupper`)[0].n, 0, 'Honigtopf verwirft Bots');
  r = await gast('POST', `${T}/schnupper`, lena);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nummer, `ST-${jahr}-0001`);
  assert.match(letzteMail('lars.lob@example.org')!.betreff, /Schnuppertraining/);
  assert.match((await gast('POST', `${T}/schnupper`, lena)).body.message, /bereits zum Schnuppertraining angemeldet/, 'keine Doppelanmeldung');

  // Kategorie im Mitgliederstamm: ohne Mitgliedsnummer/Eintritt, zählt nicht als aktives Mitglied
  const [st] = await sql`select s.adrnr, s.token, m.mitglnrn, m.eintritt, m.telefon6 from tco.schnupper s join tco.mitglieder m using (adrnr)`;
  assert.equal(st.mitglnrn, null);
  assert.equal(st.eintritt, null);
  r = await admin('GET', `${T}/mitglieder/liste?status=SCHNUPPER`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.anzahl.SCHNUPPER, 1);
  assert.deepEqual(r.body.zeilen.map((z: any) => [z.name, z.status_txt, z.schnupper]), [['Lob, Lena', 'Schnuppertraining', true]]);
  r = await admin('GET', `${T}/mitglieder/liste?status=AKTIV`);
  assert.ok(!r.body.zeilen.some((z: any) => z.adrnr === st.adrnr));
  r = await admin('GET', `${T}/mitglieder/m/${st.adrnr}`);
  assert.equal(r.body.schnupper.stufe, 'NEU');
  assert.equal(r.body.schnupper.alter, 12);
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.ok((r.body.aufgaben ?? r.body).some((x: any) => x.key === 'SCHNUPPER'));

  // Trainer: eigene Rechte, kein Zugriff auf den Mitgliederstamm
  await admin('POST', '/api/admin/roles', { id: 'SCHNUPPER_LESER', name: 'Schnuppern lesen', permissions: ['tco.schnupper:display'] });
  await admin('POST', '/api/admin/users', { username: 'schnuppertrainer', displayName: 'Trainer', password: 'start-passwort', roles: ['SCHNUPPER_LESER'] });
  const trainer = client();
  await trainer('POST', '/api/auth/login', { username: 'schnuppertrainer', password: 'start-passwort' });
  await trainer('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' });
  r = await trainer('GET', `${T}/schnuppertraining`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.zeilen[0].vorname, 'Lena');
  assert.equal(r.body.zeilen[0].whatsapp, '491701234567');
  assert.deepEqual(r.body.zeilen[0].termine, { tage: ['Di', 'Do'], zeiten: ['nachmittags'], text: 'ab 16 Uhr' });
  assert.equal((await trainer('PUT', `${T}/schnuppertraining/${st.adrnr}`, { status: 'KONTAKTIERT' })).status, 403);
  assert.equal((await trainer('GET', `${T}/mitglieder/liste`)).status, 403);

  // Betreuung: beide Einheiten → absolviert; „Mitglied“ nur über den Antrag
  assert.equal((await admin('PUT', `${T}/schnuppertraining/${st.adrnr}`, { status: 'MITGLIED' })).status, 400);
  assert.equal((await admin('PUT', `${T}/schnuppertraining/${st.adrnr}`, { status: 'TERMIN', einheit1: '2026-05-05', einheit2: '2026-05-01' })).status, 400);
  r = await admin('PUT', `${T}/schnuppertraining/${st.adrnr}`, { status: 'TERMIN', einheit1: '2026-05-05', einheit2: '2026-05-12', trainer: 'Tom Trainer', notiz: 'sehr motiviert' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /absolviert/);

  // Beitrittslink: vorbelegter Mitgliedsantrag
  r = await admin('POST', `${T}/schnuppertraining/${st.adrnr}/beitrittslink`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.link, `https://portal.example.org/beitritt?schnupper=${st.token}`);
  assert.ok(letzteMail('lars.lob@example.org')!.text.includes(r.body.link));
  r = await gast('GET', `${T}/schnupper/beitritt?token=${st.token}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.vorname, r.body.nachname, r.body.email, r.body.mobil], ['Lena', 'Lob', 'lars.lob@example.org', '0170 1234567']);
  assert.equal((await gast('GET', `${T}/schnupper/beitritt?token=${'x'.repeat(32)}`)).status, 404);

  r = await gast('POST', `${T}/antrag`, {
    personen: [{ anrede: 'Frau', vorname: 'Lena', nachname: 'Lob', geburtsdatum: `${jahr - 12}-01-15`, art: '3' }],
    strasse: 'Netzweg 2', plz: '66649', ort: 'Oberthal', email: 'lars.lob@example.org', telefon: '0170 1234567', erziehungsberechtigt: 'Lars Lob',
    eintritt: heute(), satzung: true, datenschutz: true, bildrechte: false, kuendigung: true, schnupper: st.token,
    bank: { kontoinhaber: 'Lars Lob', iban: 'DE02 1203 0000 0000 2020 51', sepa: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('GET', `${T}/mitgliedsantraege`);
  const ma = r.body.find((x: any) => x.status === 'EINGANG' && x.daten.personen[0].vorname === 'Lena');
  assert.ok(ma.hinweise.some((h: string) => /Schnuppertraining ST-/.test(h)), JSON.stringify(ma.hinweise));
  assert.ok(!ma.hinweise.some((h: string) => /gesperrt/.test(h)), 'Schnupperer ist keine Dublette');
  r = await admin('POST', `${T}/mitgliedsantraege/${ma.id}/uebernehmen`, { mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mitglieder[0].adrnr, st.adrnr, 'derselbe Stammsatz wird Mitglied');
  assert.match(r.body.text, /Schnuppertraining übernommen/);
  const leni = await sql`select adrnr, mitglnrn, eintritt::text, geburtsdatum::text, strasse, telefon6 from tco.mitglieder where vorname = 'Lena' and nachname = 'Lob'`;
  assert.equal(leni.length, 1, 'keine Dublette');
  assert.ok(leni[0].mitglnrn);
  assert.equal(leni[0].eintritt, heute());
  assert.equal(leni[0].strasse, 'Netzweg 2');
  assert.equal(leni[0].telefon6, '0170 1234567', 'Handynummer aus der Schnupper-Anmeldung bleibt');
  const [s2] = await sql`select status, antrag from tco.schnupper where adrnr = ${st.adrnr}`;
  assert.deepEqual([s2.status, s2.antrag], ['MITGLIED', ma.nummer]);
  assert.equal((await sql`select count(*)::int as n from tco.vertraege where adrnr = ${st.adrnr}`)[0].n, 1);
  r = await admin('GET', `${T}/mitglieder/liste?status=SCHNUPPER`);
  assert.equal(r.body.anzahl.SCHNUPPER, 0, 'Kategorie gewechselt');
  r = await admin('GET', `${T}/mitglieder/liste?status=AKTIV`);
  assert.ok(r.body.zeilen.some((z: any) => z.adrnr === st.adrnr));
  assert.equal((await gast('GET', `${T}/schnupper/beitritt?token=${st.token}`)).status, 404, 'Link nach dem Beitritt verbraucht');
  assert.equal((await admin('PUT', `${T}/schnuppertraining/${st.adrnr}`, { status: 'KONTAKTIERT' })).status, 400, 'Mitglied: keine Änderung mehr');
});

test('Einladung zum Vereinsportal: QR-Code per Mail/Brief und Schnellweg bei der Registrierung', async () => {
  await sql`insert into tco.mitglieder (adrnr, mitglnrn, vorname, nachname, geburtsdatum, email, eintritt, strasse, plz, ort) values
            ('0000000601', '601', 'Nina', 'Neu', '1990-06-06', 'nina@example.org', '2020-01-01', 'Weg 1', '66649', 'Oberthal'),
            ('0000000602', '602', 'Paul', 'Post', '1960-01-01', null, '2020-01-01', 'Gasse 2', '66649', 'Oberthal'),
            ('0000000603', '603', 'Sven', 'Schnell', '1999-09-09', 'sven@example.org', '2020-01-01', 'Platz 3', '66649', 'Oberthal')`;
  let r = await admin('GET', `${T}/mitglieder/einladungen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const adr = r.body.map((k: any) => k.adrnr);
  assert.ok(adr.includes('0000000601') && adr.includes('0000000602'));
  assert.ok(!adr.includes('0000000501'), 'Maria hat bereits einen Benutzer');

  r = await admin('POST', `${T}/mitglieder/einladungen`, { adrnrs: ['0000000601', '0000000602'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.gesendet, r.body.briefe], [1, 1]);
  assert.ok(Buffer.from(r.body.pdf, 'base64').subarray(0, 4).toString() === '%PDF');
  const m = mails.filter((x) => x.an === 'nina@example.org').pop() as any;
  assert.match(m.text, /\/einladung\?token=/);
  assert.equal(m.anhaenge[0].mime, 'image/png');
  const t = token(m.text, 'token');

  const gast = client();
  r = await gast('GET', `${T}/einladung?token=${t}`);
  assert.equal(r.body.gueltig, true);
  assert.equal(r.body.benutzername, 'nina@example.org');
  assert.equal((await gast('POST', `${T}/einladung`, { token: t, benutzername: 'nina', passwort: 'kurz', datenschutz: true })).status, 400);
  r = await gast('POST', `${T}/einladung`, { token: t, benutzername: 'nina', passwort: 'ninas-kennwort', datenschutz: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [u] = await sql`select u.id, array_agg(ur.role_id) as rollen from core.users u join core.user_roles ur on ur.user_id = u.id where u.username = 'nina' group by u.id`;
  assert.deepEqual(u.rollen, ['MITGLIED']);
  assert.equal((await sql`select benutzer_id from tco.mitgliedera where adrnr = '0000000601'`)[0].benutzer_id, u.id);
  assert.equal((await gast('POST', `${T}/einladung`, { token: t, benutzername: 'nina2', passwort: 'ninas-kennwort', datenschutz: true })).status, 410, 'nur einmal');
  assert.equal((await client()('POST', '/api/auth/login', { username: 'nina', password: 'ninas-kennwort' })).status, 200);

  // Schnellweg: E-Mail + Geburtsdatum
  const S = `${T}/platz/registrierung/schnell`;
  r = await gast('POST', S, { email: 'sven@example.org', geburtsdatum: '1999-09-10' });
  assert.equal(r.body.treffer, false);
  r = await gast('POST', S, { email: 'Sven@Example.org', geburtsdatum: '1999-09-09' });
  assert.equal(r.body.treffer, true, JSON.stringify(r.body));
  const t2 = token(letzteMail('sven@example.org')!.text, 'token');
  r = await gast('POST', `${T}/einladung`, { token: t2, benutzername: 'sven', passwort: 'svens-kennwort', datenschutz: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await gast('POST', S, { email: 'sven@example.org', geburtsdatum: '1999-09-09' })).body.treffer, false, 'hat jetzt einen Benutzer');
});

test('Registrierung in Schritten: Suche im Bestand, Übernahme von Name und Anschrift (#10)', async () => {
  const R = `${T}/platz/registrierung`;
  await sql`insert into tco.mitglieder (adrnr, mitglnrn, anrede, vorname, nachname, geburtsdatum, email, eintritt, strasse, plz, ort) values
            ('0000000801', '801', 'Frau', 'Berta', 'Bestand', '1970-07-07', 'berta@example.org', '2010-01-01', 'Weg 8', '66649', 'Oberthal')`;
  await sql`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname, strasse, plz, wohnort, geschlecht) values
            ('801', 'erwin.alt', 'enabled', 'erwin@example.org', 'Erwin', 'Alt', 'Halle 1', '66649', 'Oberthal', 'm')`;
  // eigene Absenderadresse: das Kontingent je IP (Schutz gegen Massenanmeldungen) haben die Tests davor schon genutzt
  const gast = async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { 'x-portal-request': '1' }, remoteAddress: '10.0.0.8' });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  // Mitglied: E-Mail + Geburtsdatum; zurück kommt nur Vorname und Anfangsbuchstabe
  let r = await gast('POST', `${R}/pruefen`, { art: 'MITGLIED', email: 'Berta@Example.org', geburtsdatum: '1970-07-07' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { treffer: true, name: 'Berta B.' }, 'ohne Vorschlag für den Benutzernamen');
  assert.equal((await gast('POST', `${R}/pruefen`, { art: 'MITGLIED', email: 'berta@example.org', geburtsdatum: '1970-07-08' })).body.treffer, false);
  assert.equal((await gast('POST', `${R}/pruefen`, { art: 'MITGLIED', email: 'berta@example.org' })).status, 400);
  const basis = { benutzername: 'berta@example.org', passwort: 'bertas-kennwort-1', datenschutz: true, ausBestand: true };
  assert.equal((await gast('POST', R, { ...basis, art: 'MITGLIED', email: 'berta@example.org', geburtsdatum: '1970-07-08' })).status, 400, 'kein Treffer → keine Übernahme');
  r = await gast('POST', R, { ...basis, art: 'MITGLIED', email: 'berta@example.org', geburtsdatum: '1970-07-07' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /prüft Ihre Mitgliedschaft/);
  const [rb] = await sql`select art, status, anrede, vorname, nachname, strasse, plz, ort, geburtsdatum::text from tco.registrierungen where benutzername = 'berta@example.org'`;
  assert.deepEqual({ ...rb }, { art: 'MITGLIED', status: 'OFFEN', anrede: 'Frau', vorname: 'Berta', nachname: 'Bestand', strasse: 'Weg 8', plz: '66649', ort: 'Oberthal', geburtsdatum: '1970-07-07' });
  assert.equal((await client()('POST', '/api/auth/login', { username: 'berta@example.org', password: 'bertas-kennwort-1' })).status, 401, 'erst nach Freigabe durch den Vorstand');

  // externer Hallennutzer: bisheriges Kundenkonto über die E-Mail; verknüpft wird erst mit dem Bestätigungslink
  r = await gast('POST', `${R}/pruefen`, { art: 'EXTERN', email: 'erwin@example.org' });
  assert.deepEqual(r.body, { treffer: true, name: 'Erwin A.' });
  assert.equal((await gast('POST', `${R}/pruefen`, { art: 'EXTERN', email: 'niemand@example.org' })).body.treffer, false);
  r = await gast('POST', R, { ...basis, art: 'EXTERN', email: 'erwin@example.org', benutzername: 'erwin@example.org', passwort: 'erwins-kennwort-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /bestätigen/);
  assert.equal((await sql`select benutzer_id from tco.kunden where zuid = '801'`)[0].benutzer_id, null, 'noch nicht verknüpft');
  r = await gast('POST', `${R}/bestaetigen`, { token: token(letzteMail('erwin@example.org')!.text, 'token') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [u] = await sql`select u.id, array_agg(ur.role_id) as rollen from core.users u join core.user_roles ur on ur.user_id = u.id where u.username = 'erwin@example.org' group by u.id`;
  assert.deepEqual(u.rollen, ['HALLENNUTZER']);
  assert.equal((await sql`select benutzer_id from tco.kunden where zuid = '801'`)[0].benutzer_id, u.id, 'bisheriges Kundenkonto übernommen');
  assert.equal((await sql`select count(*)::int as n from tco.kunden where lower(email) = 'erwin@example.org'`)[0].n, 1, 'kein zweiter Kundenstammsatz');
});

test('Mailprotokoll und Testmail', async () => {
  let r = await admin('POST', '/api/mail/test', { an: 'test@example.org' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /gesendet/);
  r = await admin('GET', '/api/mail/protokoll');
  assert.equal(r.status, 200);
  assert.equal(r.body[0].an, 'test@example.org', JSON.stringify(r.body.slice(0, 4)));
  assert.equal(r.body[0].status, 'gesendet');
  assert.ok(r.body.some((p: any) => p.anwendung === 'Registrierung' && p.status === 'gesendet'));
  // ohne Webhook-URL: Versuch wird mit Grund protokolliert
  const [alt] = await sql`select url from core.verbindungen where id = 'mail'`;
  await sql`update core.verbindungen set url = '' where id = 'mail'`;
  const { verbindungenCacheLeeren } = await import('../src/lib/verbindungen.js');
  verbindungenCacheLeeren();
  assert.equal((await admin('POST', '/api/mail/test', { an: 'test@example.org' })).status >= 400, true);
  r = await admin('GET', '/api/mail/protokoll');
  assert.equal(r.body[0].status, 'nicht_gesendet');
  await sql`update core.verbindungen set url = ${alt.url} where id = 'mail'`;
  verbindungenCacheLeeren();
  // Anmeldeseite: Registrierung heißt „Zum Vereinsportal registrieren“
  assert.equal((await client()('GET', '/api/settings/public')).body.registrierung.titel, 'Zum Vereinsportal registrieren');
});

test('Mailprotokoll: fehlgeschlagene E-Mails erneut senden', async () => {
  const gast = client();
  const P = '/api/mail/protokoll';
  // normale Mail: Inhalt wird beim Fehler gespeichert, aber nie ausgeliefert
  n8nAblehnen = true;
  let r = await admin('POST', '/api/mail/test', { an: 'wieder@example.org' });
  assert.equal(r.status, 502, 'Klartext statt „Interner Fehler“');
  assert.match(r.body.message, /X-TCO-Key/);
  r = await admin('GET', P);
  let p = r.body[0];
  // Wiederholung, solange n8n noch ablehnt: verständliche Meldung, Zeile bleibt wiederholbar
  r = await admin('POST', `${P}/${p.id}/erneut`);
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.message, /Webhook-Schlüssel abgelehnt/);
  n8nAblehnen = false;
  r = await admin('GET', P);
  p = r.body.find((x: any) => x.id === p.id);
  assert.equal(p.erneut_status, 'fehler');
  assert.deepEqual([p.an, p.status, p.erneut, p.erneut_neuer_link, p.nachricht], ['wieder@example.org', 'fehler', true, false, undefined]);
  assert.match(p.fehler, /Webhook-Schlüssel abgelehnt/);
  const vorher = mails.length;
  r = await admin('POST', `${P}/${p.id}/erneut`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mails.length, vorher + 1);
  assert.match(letzteMail('wieder@example.org')!.betreff, /Testmail/);
  r = await admin('GET', P);
  p = r.body.find((x: any) => x.id === p.id);
  assert.deepEqual([p.erneut_status, p.erneut, p.erneut_von], ['gesendet', false, 'Admin']);
  assert.equal((await sql`select nachricht from core.mail_protokoll where id = ${p.id}`)[0].nachricht, null, 'Inhalt nach Erfolg gelöscht');
  assert.equal((await admin('POST', `${P}/${p.id}/erneut`)).status, 400, 'nur einmal');

  // Bestätigungslink der Registrierung: wird nicht gespeichert, sondern neu erzeugt
  n8nAblehnen = true;
  const R = `${T}/platz/registrierung`;
  r = await gast('POST', R, { art: 'EXTERN', anrede: 'Frau', strasse: 'Hauptstr. 1', plz: '66649', ort: 'Oberthal', vorname: 'Wilma', nachname: 'Wieder', email: 'wilma@example.org', benutzername: 'wilma', passwort: 'wilmas-kennwort-1', datenschutz: true });
  n8nAblehnen = false;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('GET', P);
  p = r.body.find((x: any) => x.an === 'wilma@example.org');
  assert.deepEqual([p.status, p.erneut, p.erneut_neuer_link], ['fehler', true, true]);
  const [gesp] = await sql`select nachricht::text as n from core.mail_protokoll where id = ${p.id}`;
  assert.ok(!/token=|registrierung-bestaetigen/.test(gesp.n), 'kein Link gespeichert');
  r = await admin('POST', `${P}/${p.id}/erneut`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = token(letzteMail('wilma@example.org')!.text, 'token');
  assert.ok(t);
  r = await gast('POST', `${R}/bestaetigen`, { token: t });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Kennwort-Links: nicht wiederholbar, mit Hinweis
  n8nAblehnen = true;
  await client()('POST', '/api/auth/passwort-vergessen', { konto: 'wilma' });
  n8nAblehnen = false;
  r = await admin('GET', P);
  p = r.body.find((x: any) => x.an === 'wilma@example.org' && x.status === 'fehler' && !x.erneut_am);
  assert.ok(p, JSON.stringify(r.body.slice(0, 3)));
  assert.equal(p.erneut, false);
  assert.match(p.erneut_hinweis, /Kennwort-Link/);
  assert.equal((await admin('POST', `${P}/${p.id}/erneut`)).status, 400);
});

test('E-Mail-Protokoll: je Zeile erneut senden (auch gesendete), Absender in Kopie', async () => {
  const U = '/api/mail/uebersicht';
  const inhalt = { folge: null, mail: { modus: 'senden', anwendung: 'Test', objekt: 'KOPIE-1', an: 'kopie@example.org', cc: '', bcc: '', betreff: 'Hallo Kopie', text: 'Inhalt',
    html: false, antwort_an: '', absender: null, absender_name: null, persoenlich: false, organisation: null, anhaenge: [] } };
  const [neu] = await sql`insert into core.mail_protokoll (anwendung, objekt, an, betreff, absender, von, status, nachricht)
                          values ('Test', 'KOPIE-1', 'kopie@example.org', 'Hallo Kopie', 'wunsch@tc-test.de', 'Kasse | TC Test <kasse@tc-test.de>', 'gesendet', ${sql.json(inhalt as never)}) returning id`;
  let r = await admin('GET', `${U}?suche=kopie-1`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let p = r.body.zeilen.find((x: any) => String(x.id) === String(neu.id));
  assert.deepEqual([p.status, p.erneut, p.erneut_hinweis, p.erneut_neuer_link, p.cc], ['gesendet', true, null, false, 'kasse@tc-test.de']);
  assert.deepEqual([p.nachricht, p.inhalt], [undefined, undefined], 'Inhalt wird nie ausgeliefert');
  // gesendete E-Mail erneut: Empfänger wie zuvor, tatsächlicher Absender in Kopie – beliebig oft
  let vorher = mails.length;
  r = await admin('POST', `${U}/${p.id}/erneut`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Kopie \(CC\) an kasse@tc-test\.de/);
  assert.equal(mails.length, vorher + 1);
  let m = letzteMail('kopie@example.org') as any;
  assert.deepEqual([m.betreff, m.cc], ['Hallo Kopie', 'kasse@tc-test.de']);
  assert.equal((await admin('POST', `${U}/${p.id}/erneut`)).status, 200, 'mehrfach möglich');
  const [alt] = await sql`select erneut_status, erneut_von, nachricht is not null as da from core.mail_protokoll where id = ${p.id}`;
  assert.deepEqual([alt.erneut_status, alt.erneut_von, alt.da], ['gesendet', 'Admin', true]);
  // die neuen E-Mails stehen als eigene Zeilen im Protokoll und sind selbst wieder sendbar (Inhalt auch bei Erfolg gespeichert)
  r = await admin('GET', `${U}?suche=kopie-1`);
  assert.equal(r.body.zeilen.length, 3, JSON.stringify(r.body.zeilen));
  assert.ok(r.body.zeilen.every((x: any) => x.erneut === true));
  // ohne gespeicherten Inhalt (vor dem Update gesendet): Hinweis statt Versand
  const [leer] = await sql`insert into core.mail_protokoll (anwendung, objekt, an, betreff, status) values ('Test', 'KOPIE-2', 'kopie@example.org', 'alt', 'gesendet') returning id`;
  r = await admin('POST', `${U}/${leer.id}/erneut`);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.message, /nicht gespeichert/);
  // Bestätigungslink einer Registrierung: neuer Link, auch der geht in Kopie
  const [reg] = await sql`insert into tco.registrierungen (benutzername, anzeigename, vorname, nachname, email, passwort_hash, status, art)
                          values ('karla', 'Kopie, Karla', 'Karla', 'Kopie', 'karla@example.org', 'x', 'EMAIL', 'EXTERN') returning id`;
  const [link] = await sql`insert into core.mail_protokoll (anwendung, objekt, an, betreff, absender, status, nachricht)
                           values ('Registrierung', ${`REG-${reg.id}`}, 'karla@example.org', 'Bitte bestätigen', 'portal@tc-test.de', 'gesendet',
                                   ${sql.json({ wiederholung: { art: 'REG_BESTAETIGUNG', id: Number(reg.id) } } as never)}) returning id`;
  r = await admin('GET', `${U}?suche=karla`);
  p = r.body.zeilen.find((x: any) => String(x.id) === String(link.id));
  assert.deepEqual([p.erneut, p.erneut_neuer_link, p.cc], [true, true, 'portal@tc-test.de']);
  assert.match(p.person, /Karla Kopie \(Registrierung\)/);
  vorher = mails.length;
  r = await admin('POST', `${U}/${link.id}/erneut`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mails.length, vorher + 1);
  m = letzteMail('karla@example.org') as any;
  assert.equal(m.cc, 'portal@tc-test.de');
  assert.ok(token(m.text, 'token'), 'neuer Bestätigungslink');
  // ohne die Berechtigung zum Senden: nur lesen
  await admin('POST', '/api/admin/roles', { id: 'MAIL_LESER', name: 'E-Mail-Protokoll lesen', permissions: ['core.mail:display'] });
  r = await admin('POST', '/api/admin/users', { username: 'mailleser', displayName: 'Mail Leser', password: 'lesen-lesen-12', roles: ['MAIL_LESER'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await sql`update core.users set must_change_password = false where username = 'mailleser'`;
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'mailleser', password: 'lesen-lesen-12' })).status, 200);
  assert.equal((await leser('GET', `${U}?suche=kopie-1`)).status, 200);
  assert.equal((await leser('POST', `${U}/${neu.id}/erneut`)).status, 403);
});

test('E-Mail-Protokoll: Rückläufer, Abwesenheit und Antworten aus den Postfächern zuordnen', async () => {
  const U = '/api/mail/uebersicht';
  const eingang = async (body: unknown, key: string | null = 'k') => {
    const res = await app.inject({ method: 'POST', url: '/api/mail/eingang', payload: body as object, headers: { 'x-portal-request': '1', ...(key ? { 'x-tco-key': key } : {}) } });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };
  let r = await admin('POST', '/api/mail/test', { an: 'ruecklauf@example.org' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [p] = await sql`select id, message_id, betreff from core.mail_protokoll where an = 'ruecklauf@example.org' order by id desc limit 1`;
  assert.equal(p.message_id, `m${mails.length}`, 'Message-ID der gesendeten E-Mail festgehalten');
  const rueck = { postfach: 'TC Oberthal <info@tc-oberthal.de>', von: 'Mail Delivery System <Mailer-Daemon@mx.example.net>',
    betreff: 'Mail delivery failed: returning message to sender', datum: new Date().toISOString(), message_id: '<rueck1@mx.example.net>',
    text: 'The following address(es) failed:\n\n  ruecklauf@example.org\n    host mx00.example.net [192.0.2.1]\n    SMTP error from remote mail server after RCPT TO:<ruecklauf@example.org>:\n    550-Requested action not taken: mailbox unavailable' };
  // nur mit dem Webhook-Schlüssel der Anbindung
  assert.equal((await eingang(rueck, null)).status, 403);
  assert.equal((await eingang(rueck, 'falsch')).status, 403);
  r = await eingang(rueck);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.zugeordnet, r.body.art, String(r.body.protokoll), r.body.neu], [true, 'unzustellbar', String(p.id), true]);
  assert.equal((await eingang(rueck)).body.neu, false, 'dieselbe Meldung wird nicht doppelt verbucht');
  // Übersicht: Rückmeldung an der gesendeten E-Mail, Filter „unzustellbar“, Suche im Grund
  r = await admin('GET', `${U}?status=unzustellbar`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.zeilen.length, 1, JSON.stringify(r.body.zeilen));
  assert.deepEqual([String(r.body.zeilen[0].id), r.body.zeilen[0].status, r.body.zeilen[0].antworten.length, r.body.zeilen[0].antworten[0].art],
    [String(p.id), 'gesendet', 1, 'unzustellbar']);
  assert.match(r.body.zeilen[0].antworten[0].grund, /550-Requested action not taken: mailbox unavailable/);
  assert.equal((await admin('GET', `${U}?suche=mailbox%20unavailable`)).body.zeilen.length, 1);
  // Antwort mit demselben Betreff vom Empfänger; der Text wird nicht gespeichert
  r = await eingang({ postfach: 'info@tc-oberthal.de', von: 'Rita Rück <ruecklauf@example.org>', betreff: `AW: ${p.betreff}`, message_id: '<antwort1@example.org>', text: 'streng geheim' });
  assert.deepEqual([r.body.zugeordnet, r.body.art], [true, 'antwort'], JSON.stringify(r.body));
  // Abwesenheitsnotiz mit beliebigem Betreff
  r = await eingang({ von: 'ruecklauf@example.org', betreff: 'Bin im Urlaub', auto: 'auto-replied', message_id: '<abwesend1@example.org>' });
  assert.deepEqual([r.body.zugeordnet, r.body.art], [true, 'abwesenheit'], JSON.stringify(r.body));
  // Antwort von einer anderen Adresse: Zuordnung über die Message-ID der gesendeten E-Mail
  await sql`update core.mail_protokoll set message_id = 'abc123@n8n.test' where id = ${p.id}`;
  r = await eingang({ von: 'Vertretung <anders@example.org>', betreff: 'Ganz anderer Betreff', in_reply_to: '<ABC123@n8n.test>', message_id: '<antwort2@example.org>' });
  assert.deepEqual([r.body.zugeordnet, r.body.art, String(r.body.protokoll)], [true, 'antwort', String(p.id)], JSON.stringify(r.body));
  // fremde Mail im Posteingang: wird nicht gespeichert
  r = await eingang({ von: 'fremd@example.org', betreff: 'Hallo Verein', message_id: '<fremd1@example.org>', text: 'egal' });
  assert.deepEqual([r.status, r.body.zugeordnet], [200, false]);
  r = await eingang({ von: 'ruecklauf@example.org', betreff: 'Neue Frage ohne Bezug', message_id: '<fremd2@example.org>' });
  assert.equal(r.body.zugeordnet, false, 'gleicher Absender, aber anderer Betreff');
  const a = await sql`select art, grund, betreff from core.mail_antworten where protokoll_id = ${p.id} order by id`;
  assert.deepEqual(a.map((x) => x.art), ['unzustellbar', 'antwort', 'abwesenheit', 'antwort']);
  assert.ok(!JSON.stringify(a).includes('geheim'), 'kein Inhalt gespeichert');
});

test('Mailprotokoll: Filter nach Anwendung und Zeitraum, Leeren', async () => {
  const P = '/api/mail/protokoll';
  await sql`insert into core.mail_protokoll (zeit, anwendung, objekt, an, betreff, status) values
            ('2026-10-01 08:00+02', 'Hallenrechnung', 'R1', 'a@example.org', 'alt', 'gesendet'),
            ('2026-10-01 18:30+02', 'Hallenrechnung', 'R2', 'b@example.org', 'abends', 'fehler'),
            ('2026-10-02 09:00+02', 'Verzehr', 'V1', 'c@example.org', 'verzehr', 'gesendet')`;
  let r = await admin('GET', `${P}/anwendungen`);
  assert.ok(r.body.includes('Hallenrechnung') && r.body.includes('Verzehr'), JSON.stringify(r.body));
  r = await admin('GET', `${P}?anwendung=Hallenrechnung`);
  assert.deepEqual(r.body.map((x: any) => x.objekt), ['R2', 'R1']);
  // Tag und Uhrzeit (Ortszeit); „bis“ ohne Uhrzeit = ganzer Tag
  r = await admin('GET', `${P}?von=2026-10-01T12:00&bis=2026-10-02`);
  assert.deepEqual(r.body.map((x: any) => x.objekt), ['V1', 'R2']);
  r = await admin('GET', `${P}?von=2026-10-01&bis=2026-10-01T18:30`);
  assert.deepEqual(r.body.map((x: any) => x.objekt), ['R2', 'R1']);
  assert.equal((await admin('GET', `${P}?von=gestern`)).status, 400);
  // gefiltert löschen, dann alles
  r = await admin('DELETE', P, { anwendung: 'Hallenrechnung', bis: '2026-10-01T12:00' });
  assert.equal(r.body.anzahl, 1, JSON.stringify(r.body));
  r = await admin('GET', `${P}?anwendung=Hallenrechnung`);
  assert.deepEqual(r.body.map((x: any) => x.objekt), ['R2']);
  r = await admin('DELETE', P, {});
  assert.ok(r.body.anzahl >= 2);
  assert.equal((await admin('GET', P)).body.length, 0);
});

test('Zugangslinks an Personen aus einer eingefügten Liste: Abgleich, eigener Text, PDF-Anhang (#105)', async () => {
  assert.equal((await admin('POST', '/api/admin/users', { username: 'simone.w', displayName: 'Wilhelm, Simone', email: 'simone@example.org', password: 'start-passwort', roles: [] })).status, 200);
  await sql`insert into tco.mitglieder (adrnr, mitglnrn, vorname, nachname, email, eintritt) values ('0000000701', '701', 'Karl', 'Kein', 'karl@example.org', '2020-01-01')`;
  const Z = `${T}/mitglieder/zugang`;
  let r = await admin('GET', `${Z}/vorlage`);
  assert.equal(r.status, 200);
  assert.match(r.body.text, /\{Link\}/);

  // Tabelle aus der Zwischenablage: Kopfzeile, Trennzeile, Anzahl-Spalte, kommagetrennte Namensliste
  r = await admin('POST', `${Z}/abgleich`, { text: 'User | Anzahl\n-- | --\nSimone Wilhelm | 5\nKarl Kein, Niemand Da |  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((x: any) => [x.eingabe, x.treffer.map((t: any) => t.art)]),
    [['Simone Wilhelm', ['BENUTZER']], ['Karl Kein', ['EINLADUNG']], ['Niemand Da', []]]);
  const keys = r.body.flatMap((x: any) => x.treffer.map((t: any) => t.key));

  const pdf = { name: 'Anleitung.pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') };
  assert.equal((await admin('POST', `${Z}/senden`, { empfaenger: keys, betreff: 'Neustart', text: 'ohne Link', pdf })).status, 400);
  assert.equal((await admin('POST', `${Z}/senden`, { empfaenger: keys, betreff: 'Neustart', text: 'x {Link}', pdf: { name: 'a.pdf', data: 'aGFsbG8=' } })).status, 400, 'kein PDF');
  r = await admin('POST', `${Z}/senden`, { empfaenger: keys, betreff: 'Neustart für {Vorname}', text: 'Hallo {Vorname} ({Benutzername}): {Link} bis {GueltigBis}', tage: 7, pdf });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen.map((z: any) => z.ok), [true, true]);
  const ms = letzteMail('simone@example.org') as any;
  assert.equal(ms.betreff, 'Neustart für Simone');
  assert.match(ms.text, /Hallo Simone \(simone\.w\)/);
  assert.equal(ms.anhaenge[0].dateiname, 'Anleitung.pdf');
  const tk = token(ms.text, 'kennwort');
  assert.equal((await client()('POST', '/api/auth/kennwort-setzen', { token: tk, passwort: 'simones-kennwort-1' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'simone.w', password: 'simones-kennwort-1' })).status, 200);
  const [g] = await sql`select gueltig_bis > now() + interval '6 days' as lang from core.password_tokens where token_hash is not null order by gueltig_bis desc limit 1`;
  assert.equal(g.lang, true, 'Gültigkeit 7 Tage');
  assert.match((letzteMail('karl@example.org') as any).text, /\/einladung\?token=/);

  // „Mitglieder ohne Benutzer einladen“: Text vorgeschlagen und änderbar, Kopie an den Versender
  const E = `${T}/mitglieder/einladungen`;
  r = await admin('GET', `${E}/vorlage`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Hallo \{Vorname\},[\s\S]*\{Link\}[\s\S]*\{GueltigBis\}/);
  assert.equal(r.body.cc, null, 'Admin ohne E-Mail-Adresse');
  const eigen = { adrnrs: ['0000000701'], betreff: 'Zugang für {Vorname}', text: 'Hi {Name}: {Link} bis {GueltigBis}' };
  assert.equal((await admin('POST', E, { ...eigen, text: 'ohne Link' })).status, 400);
  assert.equal((await admin('POST', E, { ...eigen, cc: true })).status, 400, 'Kopie an mich ohne eigene Adresse');
  await sql`update core.users set email = 'admin@example.org' where username = 'admin'`;
  assert.equal((await admin('GET', `${E}/vorlage`)).body.cc, 'admin@example.org');
  r = await admin('POST', E, { ...eigen, cc: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.gesendet, 1);
  const mk = letzteMail('karl@example.org') as any;
  assert.deepEqual([mk.betreff, mk.cc], ['Zugang für Karl', 'admin@example.org']);
  assert.match(mk.text, /^Hi Karl Kein: \S+\/einladung\?token=\S+ bis \d/);
  assert.equal(mk.anhaenge[0].mime, 'image/png');
  // Zugangslink aus Liste: ebenfalls mit Kopie
  r = await admin('POST', `${Z}/senden`, { empfaenger: [keys[0]], betreff: 'Neustart', text: 'x {Link}', cc: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((letzteMail('simone@example.org') as any).cc, 'admin@example.org');
  await sql`update core.users set email = null where username = 'admin'`;
});
