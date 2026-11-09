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
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
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
  await sql`update tco.verein set n8n_mail_url = ${`http://127.0.0.1:${port}/webhook/mail`}, n8n_mail_key = 'k'`;
  await sql`insert into tco.mitglieder (adrnr, mitglnrn, vorname, nachname, geburtsdatum, email, eintritt) values
            ('0000000501', '501', 'Maria', 'Mitglied', '1980-05-17', 'maria@example.org', '2015-01-01'),
            ('0000000502', '502', 'Otto', 'Ohnemail', '1975-02-02', null, '2015-01-01')`;
  await sql`insert into tco.beitrag (art, bezeichnung, turnus) values ('5', 'Erwachsene', 'jährlich'), ('3', 'Jugendliche', 'jährlich')`;
  await sql`insert into tco.beitrag_pr (art, gueltig_ab, betrag) values ('5', '2000-01-01', 150), ('3', '2000-01-01', 60)`;
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
  // Absender je Anwendung (Stammdaten); leere Zeilen werden ignoriert
  const v = (await admin('GET', `${T}/verein`)).body;
  let s = await admin('PUT', `${T}/verein`, { ...v, mail_absender: [
    { anwendung: '*', email: 'info@tc-oberthal.de', name: 'TC Oberthal' },
    { anwendung: 'registrierung', email: 'portal@tc-oberthal.de', name: 'TCO Portal', antwort_an: 'platz@tc-oberthal.de' },
    { anwendung: '', email: '' },
  ] });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  s = await admin('PUT', `${T}/verein`, { ...v, mail_absender: [{ anwendung: '*', email: 'kein-mail' }] });
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
  assert.deepEqual(r.body.beitragsarten.map((b: any) => [b.art, b.betrag]), [['3', 60], ['5', 150]]);
  const antrag = {
    personen: [
      { anrede: 'Frau', vorname: 'Fiona', nachname: 'Familie', geburtsdatum: '1985-03-03', art: '5' },
      { anrede: 'Herr', vorname: 'Felix', nachname: 'Familie', geburtsdatum: '2012-07-07', art: '3' },
    ],
    strasse: 'Am Platz 1', plz: '66649', ort: 'Oberthal', email: 'fiona@example.org', telefon: '0681 1',
    eintritt: heute(), satzung: true, datenschutz: true, bildrechte: true,
    bank: { kontoinhaber: 'Fiona Familie', iban: 'DE02 1203 0000 0000 2020 51', sepa: true },
  };
  assert.equal((await gast('POST', `${T}/antrag`, { ...antrag, bank: { ...antrag.bank, iban: 'DE00123' } })).status, 400);
  assert.equal((await gast('POST', `${T}/antrag`, { ...antrag, bank: { ...antrag.bank, sepa: false } })).status, 400);
  assert.equal((await gast('POST', `${T}/antrag`, { ...antrag, satzung: false })).status, 400);
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
  assert.deepEqual(v.map((x) => x.art).sort(), ['3', '5']);
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
