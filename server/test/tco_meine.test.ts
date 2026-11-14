/**
 * Mitglieder als Benutzer (Administration → Benutzer und Rechte → Benutzer), Rolle MITGLIED, „Meine Mitgliedschaft“:
 * eigene Daten lesen/ändern, Bankverbindung, Kündigung – und nichts darüber hinaus.
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
const M = '/api/m/tco/mitglieder';
/** Hinweise im Arbeitsvorrat TC Oberthal (Startseite), Sammeleinträge aufgelöst */
interface Hinweis { key: string; bereich: string; titel: string; text: string; state: string; pfad: string; erledigen: { text: string; url: string; body: Record<string, unknown> }; kinder?: Hinweis[] }
const hinweise = async (c: ReturnType<typeof client> = admin): Promise<Hinweis[]> => {
  const r = await c('GET', '/api/arbeitsvorrat');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const liste: Hinweis[] = r.body.gruppen.find((g: { modul: string }) => g.modul === 'tco')?.aufgaben ?? [];
  return liste.filter((a) => a.key.startsWith('HINWEIS:')).flatMap((a) => a.kinder ?? [a]);
};
const jahr = new Date().getFullYear();

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, strasse, plz, ort, eintritt, zahlungsart, iban1, mitglnrn) values
    ('0000000501', 'Paula', 'Portal', 'paula@example.org', 'Weg 1', '66649', 'Oberthal', '2020-01-01', 'L', 'DE02120300000000202051', '501'),
    ('0000000502', 'Kim', 'Portal', 'paula@example.org', 'Weg 1', '66649', 'Oberthal', '2021-01-01', 'L', null, '502'),
    ('0000000503', 'Alt', 'Ausgetreten', 'alt@example.org', null, null, null, '2010-01-01', 'U', null, '503'),
    ('0000000504', 'Ohne', 'Mail', null, null, null, null, '2019-05-01', 'B', null, '504')`;
  await sql`update tco.mitglieder set austritt = '2022-12-31' where adrnr = '0000000503'`;
  await sql`update tco.mitglieder set adrnrkih = '0000000501' where adrnr = '0000000502'`; // Kim zahlt über Paula
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, sollstellung, vertragbegin, betrag) values
    ('0000000501', '1', '10', 'Erwachsene', 'jährlich', '2020-01-01', 120), ('0000000501', '2', '50', 'Schließfach', 'jährlich', '2023-01-01', 20),
    ('0000000502', '1', '90', 'Jugend', 'jährlich', '2021-01-01', 60)`;
  // EP3-Kunde mit Portalbenutzer (Hallennutzer), gleicher Name wie Mitglied 504
  await sql`insert into tco.kunden (zuid, zalias, status, vorname, nachname) values ('44', 'ohne.mail', 'enabled', 'Ohne', 'Mail')`;
  assert.equal((await admin('POST', '/api/admin/users', { username: 'ohne.mail', displayName: 'Ohne Mail', password: 'start-passwort', roles: ['HALLENNUTZER'] })).status, 200);
  const [u] = await sql`select id from core.users where username = 'ohne.mail'`;
  await sql`update tco.kunden set benutzer_id = ${u.id} where zuid = '44'`;
});
after(async () => { await app?.close(); await sql.end(); });

let start = '';
test('Mitglieder als Benutzer anlegen: E-Mail als Anmeldename, Familienadresse, Hochstufung, Rolle MITGLIED fest', async () => {
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'MITGLIED' order by 1`).map((x) => x.permission), ['tco.kalender:anmelden', 'tco.meinedaten:edit', 'tco.platzbuchung:edit', 'tco.schaden:melden', 'tco.verzehr:edit']);
  let r = await admin('POST', `${M}/benutzer-anlegen`, { mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hochgestuft, 1, 'Hallennutzer ohne.mail wird Mitglied 504');
  const namen = r.body.angelegt.map((a: { username: string }) => a.username).sort();
  assert.deepEqual(namen, ['kim.portal', 'paula.portal'], 'gemeinsame E-Mail → vorname.nachname; Ausgetretene nicht');
  const paula = r.body.angelegt.find((a: { username: string }) => a.username === 'paula.portal');
  assert.equal(paula.name, 'Portal, Paula');
  assert.ok(paula.startkennwort);
  start = paula.startkennwort;
  // Rollen
  for (const u of ['paula.portal', 'kim.portal', 'ohne.mail']) {
    assert.deepEqual((await sql`select ur.role_id from core.user_roles ur join core.users x on x.id = ur.user_id where x.username = ${u}`).map((x) => x.role_id), ['MITGLIED'], u);
  }
  assert.equal((await sql`select a.adrnr from tco.mitgliedera a join core.users u on u.id = a.benutzer_id where u.username = 'ohne.mail'`)[0].adrnr, '0000000504');
  // erneut: nichts doppelt
  r = await admin('POST', `${M}/benutzer-anlegen`, { mail: false });
  assert.equal(r.body.angelegt.length, 0);
  // keine Systemrolle mehr: nur ein Administrator ändert die Berechtigungen, keine Administrationsrechte, nicht löschbar
  const STANDARD = ['tco.kalender:anmelden', 'tco.meinedaten:edit', 'tco.platzbuchung:edit', 'tco.schaden:melden', 'tco.verzehr:edit'];
  const rolle = (await admin('GET', '/api/admin/roles')).body.find((x: { id: string }) => x.id === 'MITGLIED');
  assert.deepEqual([rolle.system, rolle.nurAdmin], [false, true]);
  r = await admin('PUT', '/api/admin/roles/MITGLIED', { name: 'Mitglied', permissions: [...STANDARD, 'tco.mitglieder:display'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await sql`select 1 from core.role_permissions where role_id = 'MITGLIED' and permission = 'tco.mitglieder:display'`).length === 1);
  r = await admin('PUT', '/api/admin/roles/MITGLIED', { name: 'Mitglied', permissions: [...STANDARD, 'core.users:edit'] });
  assert.equal(r.status, 400, 'keine Administrationsrechte');
  assert.equal((await admin('PUT', '/api/admin/roles/MITGLIED', { name: 'Mitglied', permissions: STANDARD })).status, 200);
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'MITGLIED' order by 1`).map((x) => x.permission), STANDARD);
  assert.equal((await admin('DELETE', '/api/admin/roles/MITGLIED')).status, 400);
  // Rollenpflege ohne Administratorrolle: andere Rollen ja, Mitglied/Hallennutzer nicht
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'ROLLENPFLEGE', name: 'Rollenpflege', permissions: ['core.roles:display', 'core.roles:edit'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'rollenpfleger', displayName: 'Rollenpfleger', password: 'start-passwort', roles: ['ROLLENPFLEGE'] })).status, 200);
  await sql`update core.users set must_change_password = false where username = 'rollenpfleger'`;
  const rp = client();
  assert.equal((await rp('POST', '/api/auth/login', { username: 'rollenpfleger', password: 'start-passwort' })).status, 200);
  assert.equal((await rp('PUT', '/api/admin/roles/HALLENNUTZER', { name: 'Hallennutzer', permissions: ['tco.platzbuchung:edit'] })).status, 403);
  assert.equal((await rp('PUT', '/api/admin/roles/ROLLENPFLEGE', { name: 'Rollenpflege neu', permissions: ['core.roles:display', 'core.roles:edit'] })).status, 200);
});

const paula = client();
test('Meine Mitgliedschaft: Anmeldung mit Startkennwort, nur eigene Daten, Kontakt und Bank ändern', async () => {
  let r = await paula('POST', '/api/auth/login', { username: 'paula.portal', password: start });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await paula('GET', `${M}/meine`)).status, 403, 'erst Kennwort ändern');
  assert.equal((await paula('POST', '/api/auth/password', { current: start, next: 'mein-neues-kennwort' })).status, 200);
  r = await paula('GET', '/api/auth/me');
  assert.deepEqual([...r.body.permissions].sort(), ['tco.kalender:anmelden', 'tco.meinedaten:edit', 'tco.platzbuchung:edit', 'tco.schaden:melden', 'tco.verzehr:edit']);

  r = await paula('GET', `${M}/meine`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mitglied.adrnr, '0000000501');
  assert.ok(!r.body.bank.iban.includes('2030000000'), 'IBAN maskiert');
  assert.equal(r.body.vertraege.length, 3, 'eigene 2 + Kim über Paula');
  assert.equal(r.body.kuendigung.mitgliedschaft, `${jahr}-12-31`);
  // keine fremden Daten
  assert.equal((await paula('GET', `${M}/liste?status=AKTIV`)).status, 403);
  assert.equal((await paula('GET', `${M}/m/0000000504`)).status, 403);
  assert.equal((await paula('GET', '/api/admin/users')).status, 403);

  r = await paula('PUT', `${M}/meine/kontakt`, { strasse: 'Neue Str. 5', plz: '66649', ort: 'Oberthal', telefon: '', mobil: '0170 1234567', email: 'paula.neu@example.org', bildrechte: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [m] = await sql`select strasse, telefon6, email, checkbox2, vorname from tco.mitglieder where adrnr = '0000000501'`;
  assert.equal(m.strasse, 'Neue Str. 5');
  assert.equal(m.email, 'paula.neu@example.org');
  assert.equal(m.checkbox2, 'J');
  assert.equal(m.vorname, 'Paula', 'Name unverändert');
  assert.equal((await sql`select email from core.users where username = 'paula.portal'`)[0].email, 'paula.neu@example.org');
  // Anmeldung mit neuer E-Mail
  assert.equal((await client()('POST', '/api/auth/login', { username: 'paula.neu@example.org', password: 'mein-neues-kennwort' })).status, 200);
  assert.equal((await paula('PUT', `${M}/meine/kontakt`, { strasse: '', plz: '', ort: '', telefon: '', mobil: '', email: 'x', bildrechte: false })).status, 400);

  r = await paula('PUT', `${M}/meine/bank`, { iban: 'DE00 1234', bic: '', bank: '' });
  assert.equal(r.status, 400);
  r = await paula('PUT', `${M}/meine/bank`, { iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', bank: 'Commerzbank' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select iban1 from tco.mitglieder where adrnr = '0000000501'`)[0].iban1, 'DE89370400440532013000');
  assert.ok((await sql`select count(*)::int as n from tco.mgnotiz where adrnr = '0000000501' and notiz like 'Bankverbindung%'`)[0].n >= 1);
  // Arbeitsvorrat (#232, V1): beide Änderungen stehen als Hinweis beim Kassenwart, bis jemand „gesehen“ bestätigt
  let h = await hinweise();
  assert.deepEqual(h.map((a) => a.key.split(':')[1]).sort(), ['MG_BANK', 'MG_KONTAKT'], 'abgelehnte Eingaben (400) melden nichts');
  const bank = h.find((a) => a.key.startsWith('HINWEIS:MG_BANK:'))!;
  assert.deepEqual([bank.bereich, bank.state, bank.pfad], ['Kassenwart', 'Critical', '/tco/mitglieder?adrnr=0000000501']);
  assert.match(bank.titel, /^Bankverbindung geändert: .+ \(Mitglied 0000000501\)$/);
  assert.match(bank.text, /über „Meine Mitgliedschaft“ eingetragen \(IBAN /);
  assert.ok(!bank.text.includes('DE89370400440532013000'), 'IBAN im Hinweis nur maskiert');
  assert.equal(bank.erledigen.text, 'gesehen');
  // die Vereinsübersicht zeigt dieselben Hinweise; das Mitglied selbst sieht sie nicht und kann nicht bestätigen
  assert.deepEqual((await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat')).body.filter((a: Hinweis) => a.key.startsWith('HINWEIS:')).map((a: Hinweis) => a.key).sort(), h.map((a) => a.key).sort());
  assert.deepEqual(await hinweise(paula), []);
  assert.equal((await paula('POST', bank.erledigen.url, bank.erledigen.body)).status, 403);
  // noch eine Änderung derselben Art: derselbe Hinweis zählt hoch
  assert.equal((await paula('PUT', `${M}/meine/kontakt`, { strasse: 'Neue Str. 5', plz: '66649', ort: 'Oberthal', telefon: '', mobil: '0170 1234567', email: 'paula.neu@example.org', bildrechte: true })).status, 200);
  assert.match((await hinweise()).find((a) => a.key.startsWith('HINWEIS:MG_KONTAKT:'))!.titel, /^Kontaktdaten geändert: .+ \(Mitglied 0000000501\) \(2×\)$/);
  // „gesehen“: verschwindet
  assert.equal((await admin('POST', bank.erledigen.url, bank.erledigen.body)).status, 200);
  h = await hinweise();
  assert.deepEqual(h.map((a) => a.key.split(':')[1]), ['MG_KONTAKT']);
  // Kim zahlt über Paula: keine eigene Bankverbindung änderbar
  const kim = client();
  await sql`update core.users set password_hash = (select password_hash from core.users where username = 'paula.portal'), must_change_password = false where username = 'kim.portal'`;
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim.portal', password: 'mein-neues-kennwort' })).status, 200);
  r = await kim('PUT', `${M}/meine/bank`, { iban: 'DE89 3704 0044 0532 0130 00', bic: '', bank: '' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /andere Person/);
  // Vertragsbaum: Kim sieht auch Paulas Verträge (Zahlerin), kündbar ist nur der eigene
  r = await kim('GET', `${M}/meine`);
  assert.deepEqual(r.body.familie.map((p: any) => [p.adrnr, p.zahlt_ueber]).sort(), [['0000000501', ''], ['0000000502', '0000000501']]);
  assert.deepEqual(r.body.vertraegeFamilie.map((v: any) => [v.adrnr, v.vertragnr, v.kuendbar]),
    [['0000000502', '1', true], ['0000000501', '1', false], ['0000000501', '2', false]]);
  // Paula: eigene Verträge und die von Kim (zahlt über Paula) – alle kündbar
  r = await paula('GET', `${M}/meine`);
  assert.equal(r.body.vertraegeFamilie.length, 3);
  assert.ok(r.body.vertraegeFamilie.every((v: any) => v.kuendbar));
});

test('Kündigung: einreichen, Freigabe durch den Vorstand, Bestätigung prüfen und senden – Jugendvertrag zum 30.09., Mitgliedschaft zum 31.12.', async () => {
  const h = new Date().toLocaleDateString('sv-SE');
  const jugendEnde = h <= `${jahr}-09-30` ? `${jahr}-09-30` : `${jahr + 1}-09-30`;
  const K = `${M}/kuendigungen`;
  interface Eintrag { key: string; bereich: string; titel: string; text: string; state: string; pfad: string; aktion?: { art: string; id: number } }
  /** Einträge „Kündigung“ im Arbeitsvorrat des Vorstands (Startseite) */
  const aufgaben = async (c: ReturnType<typeof client> = admin): Promise<Eintrag[]> =>
    ((await c('GET', '/api/arbeitsvorrat')).body.gruppen.find((g: { modul: string }) => g.modul === 'tco')?.aufgaben ?? []).filter((x: Eintrag) => x.key.startsWith('KUENDIGUNG:'));
  const ende = async (adrnr: string, nr: string) => (await sql`select vertragende::text as e from tco.vertraege where adrnr = ${adrnr} and vertragnr = ${nr}`)[0].e as string | null;
  const stand = async (id: number) => (await sql`select status, abgelegt, gesendet, bearbeitet_von from tco.kuendigungen where id = ${id}`)[0];

  let r = await paula('GET', `${M}/meine`);
  assert.equal(r.body.kuendigung.mitgliedschaft, `${jahr}-12-31`);
  assert.equal(r.body.kuendigung.jugend, jugendEnde);
  assert.equal(r.body.vertraege.find((v: { adrnr: string }) => v.adrnr === '0000000502').endeBei, jugendEnde, 'Jugendtraining von Kim');
  assert.deepEqual(r.body.kuendigungen, []);

  // --- 1. Einreichen: Vertrag der über mich zahlenden Person (Jugend). Es ändert sich noch nichts.
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'VERTRAG', adrnr: '0000000502', vertragnr: '1', bestaetigung: true, grund: 'Kim hört auf' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k1 = r.body.id as number;
  assert.equal(r.body.eingereicht, true);
  assert.match(r.body.text, /wird vom Vorstand freigegeben\. Danach erhältst du die Kündigungsbestätigung per E-Mail\. Eingereicht: Jugend \(.*Kim.*\) gekündigt am /);
  assert.equal(r.body.pdf, undefined, 'keine Bestätigung vor der Freigabe');
  assert.equal(await ende('0000000502', '1'), null, 'vor der Freigabe unverändert');
  assert.ok((await sql`select notiz from tco.mgnotiz where adrnr = '0000000502'`).some((n) => /eingereicht durch .* wartet auf die Freigabe.*Kim hört auf/.test(String(n.notiz))));
  assert.equal((await sql`select count(*)::int as n from core.change_header where object_type = 'MITGLIED' and action = 'KUENDIGUNG'`)[0].n, 0, 'am Mitglied noch nichts geändert');
  // das Mitglied sieht den Stand; derselbe Vertrag lässt sich nicht noch einmal kündigen
  r = await paula('GET', `${M}/meine`);
  assert.deepEqual(r.body.kuendigungen.map((k: any) => [k.id, k.status, k.eingang]), [[k1, 'OFFEN', h]]);
  assert.equal(r.body.vertraegeFamilie.find((v: any) => v.adrnr === '0000000502' && v.vertragnr === '1').kuendbar, false);
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'VERTRAG', adrnr: '0000000502', vertragnr: '1', bestaetigung: true });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits eingereicht und wartet auf die Freigabe/);

  // --- Arbeitsvorrat des Vorstands: freigeben – mit Knopf am Eintrag (aktion)
  let av = await aufgaben();
  assert.deepEqual(av.map((x) => [x.key, x.bereich, x.state, x.titel, x.pfad, x.aktion]),
    [[`KUENDIGUNG:${k1}`, 'Vorstand', 'Critical', 'Kündigung freigeben: Paula Portal', '/tco/mitglieder?adrnr=0000000501', { art: 'KUENDIGUNG', id: k1 }]]);
  assert.match(av[0].text, /gekündigt am .* Grund: Kim hört auf$/);
  assert.deepEqual(await aufgaben(paula), [], 'nur mit dem Recht, Mitglieder zu pflegen');
  assert.ok((await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat')).body.some((x: Eintrag) => x.key === `KUENDIGUNG:${k1}`), 'auch in der Vereinsübersicht');
  r = await admin('GET', `${K}/${k1}`);
  assert.deepEqual([r.status, r.body.status, r.body.name, r.body.mitglnrn, r.body.eingang, r.body.grund, r.body.gesendet], [200, 'OFFEN', 'Paula Portal', '501', h, 'Kim hört auf', false]);
  assert.equal((await paula('GET', `${K}/${k1}`)).status, 403);
  assert.equal((await paula('POST', `${K}/${k1}/freigeben`)).status, 403);
  assert.equal((await admin('GET', `${K}/${k1}/pdf`)).status, 409, 'Bestätigung erst nach der Freigabe');
  assert.equal((await admin('POST', `${K}/${k1}/senden`)).status, 409);
  assert.equal((await admin('GET', `${K}/999999`)).status, 404);

  // --- 2. Freigabe: jetzt wird ausgeführt – Kündigungsdatum ist der Tag des Eingangs, nicht der Tag der Freigabe
  // (die Freigabe kommt einen Tag später; am 1.10. und 1.1. gäbe das eine andere Frist – dann bleibt der Eingang heute)
  const gestern = new Date(Date.now() - 86_400_000).toLocaleDateString('sv-SE');
  const gj = Number(gestern.slice(0, 4));
  const eingang = (gestern <= `${gj}-09-30` ? `${gj}-09-30` : `${gj + 1}-09-30`) === jugendEnde ? gestern : h;
  const de = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  await sql`update tco.kuendigungen set eingang = ${eingang} where id = ${k1}`;
  r = await admin('POST', `${K}/${k1}/freigeben`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.text.startsWith('Freigegeben: Jugend ('), r.body.text);
  assert.ok(r.body.text.endsWith(`gekündigt am ${de(eingang)} zum ${de(jugendEnde)}. Bitte die Kündigungsbestätigung prüfen und senden.`), r.body.text);
  assert.equal(await ende('0000000502', '1'), jugendEnde);
  assert.deepEqual({ ...(await stand(k1)) }, { status: 'FREIGEGEBEN', abgelegt: false, gesendet: false, bearbeitet_von: 'Admin' });
  assert.equal((await admin('POST', `${K}/${k1}/freigeben`)).status, 409, 'nur einmal');
  assert.equal((await admin('POST', `${K}/${k1}/ablehnen`, { grund: 'zu spät' })).status, 409);
  av = await aufgaben();
  assert.deepEqual(av.map((x) => x.titel), ['Kündigungsbestätigung prüfen und senden: Paula Portal'], 'bleibt im Arbeitsvorrat, bis die Bestätigung verschickt ist');
  // der Kassenwart erfährt die ausgeführte Kündigung als Hinweis
  const kh = (await hinweise()).find((a) => a.key.startsWith('HINWEIS:MG_KUENDIGUNG:'))!;
  assert.ok(kh, 'Hinweis für den Kassenwart');
  assert.deepEqual([kh.bereich, kh.state, kh.pfad], ['Kassenwart', 'Critical', '/tco/mitglieder?adrnr=0000000501']);
  assert.match(kh.titel, /^Kündigung freigegeben: .+ \(Mitglied 0000000501\)$/);
  assert.match(kh.text, /Grund: Kim hört auf – freigegeben von Admin$/);

  // --- 3. Kündigungsbestätigung zur Prüfung, dann senden
  r = await admin('GET', `${K}/${k1}/pdf`);
  assert.equal(r.status, 200);
  assert.ok(String(r.body).startsWith('%PDF'), 'Kündigungsbestätigung als PDF');
  assert.equal((await paula('GET', `${K}/${k1}/pdf`)).status, 403);
  // Mailversand ist nicht eingerichtet: nicht gesendet, bleibt im Arbeitsvorrat
  r = await admin('POST', `${K}/${k1}/senden`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.fertig, r.body.gesendet], [false, false]);
  assert.ok(r.body.hinweise.some((x: string) => /Mailversand ist nicht eingerichtet/.test(x)), JSON.stringify(r.body.hinweise));
  assert.equal((await stand(k1)).status, 'FREIGEGEBEN');
  assert.equal((await aufgaben()).length, 1);
  // ohne E-Mail abschließen (Bestätigung selbst zustellen)
  r = await admin('POST', `${K}/${k1}/senden`, { ohneMail: true });
  assert.deepEqual([r.status, r.body.fertig, r.body.gesendet], [200, true, false]);
  assert.deepEqual({ ...(await stand(k1)) }, { status: 'ABGESCHLOSSEN', abgelegt: false, gesendet: false, bearbeitet_von: 'Admin' });
  assert.deepEqual(await aufgaben(), [], 'erledigt');
  assert.equal((await admin('POST', `${K}/${k1}/senden`)).status, 409);
  assert.deepEqual((await paula('GET', `${M}/meine`)).body.kuendigungen, []);

  /** einreichen und – wenn angenommen – freigeben und abschließen; liefert die Antwort der Freigabe bzw. die Ablehnung beim Einreichen */
  const kuendigen = async (eingabe: Record<string, unknown>) => {
    const e1 = await paula('POST', `${M}/meine/kuendigung`, eingabe);
    if (e1.status !== 200) return e1;
    const f = await admin('POST', `${K}/${e1.body.id}/freigeben`);
    assert.equal((await admin('POST', `${K}/${e1.body.id}/senden`, { ohneMail: true })).status, 200);
    return f;
  };

  // fremder Vertrag (Mitglied 504) nicht erreichbar – schon beim Einreichen abgelehnt
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, vertragbegin, betrag) values ('0000000504', '1', '10', 'Erwachsene', '2019-05-01', 120)`;
  r = await kuendigen({ art: 'VERTRAG', adrnr: '0000000504', vertragnr: '1', bestaetigung: true });
  assert.equal(r.status, 400);
  assert.equal(await ende('0000000504', '1'), null);

  // --- Ablehnung: nichts ändert sich, das Mitglied sieht den Grund und kann erneut kündigen
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'VERTRAG', adrnr: '0000000501', vertragnr: '2', bestaetigung: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k2 = r.body.id as number;
  assert.equal((await admin('POST', `${K}/${k2}/ablehnen`, { grund: '' })).status, 400, 'nur mit Grund');
  assert.equal((await paula('POST', `${K}/${k2}/ablehnen`, { grund: 'nein' })).status, 403);
  r = await admin('POST', `${K}/${k2}/ablehnen`, { grund: 'Schlüssel noch nicht zurückgegeben' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.hinweise.some((x: string) => /Mailversand ist nicht eingerichtet/.test(x)));
  assert.equal(await ende('0000000501', '2'), null);
  assert.equal((await stand(k2)).status, 'ABGELEHNT');
  assert.deepEqual(await aufgaben(), []);
  assert.equal((await admin('POST', `${K}/${k2}/freigeben`)).status, 409);
  assert.ok((await sql`select notiz from tco.mgnotiz where adrnr = '0000000501'`).some((n) => /nicht freigegeben\. Grund: Schlüssel noch nicht zurückgegeben/.test(String(n.notiz))));
  r = await paula('GET', `${M}/meine`);
  assert.deepEqual(r.body.kuendigungen.map((k: any) => [k.id, k.status, k.ablehnung]), [[k2, 'ABGELEHNT', 'Schlüssel noch nicht zurückgegeben']]);

  // Mehrfachauswahl: nur gültige (laufende, ungekündigte) Verträge; mehrere in einem Schritt
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, sollstellung, vertragbegin, betrag) values ('0000000502', '2', '90', 'Jugendtraining 2', 'monatlich', '2024-01-01', 30)`;
  const kb = r.body.vertraegeFamilie.filter((v: any) => v.kuendbar).map((v: any) => `${v.adrnr}|${v.vertragnr}|${v.mitgliedsbeitrag}`).sort();
  assert.deepEqual(kb, ['0000000501|1|true', '0000000501|2|false'], 'gekündigter Vertrag von Kim nicht mehr wählbar, abgelehnte Kündigung wieder möglich');
  assert.equal((await paula('POST', `${M}/meine/kuendigung`, { art: 'VERTRAG', bestaetigung: true, vertraege: [] })).status, 400);
  r = await kuendigen({ art: 'VERTRAG', bestaetigung: true, vertraege: [{ adrnr: '0000000502', vertragnr: '1' }] });
  assert.equal(r.status, 400, 'bereits gekündigt');
  r = await kuendigen({ art: 'VERTRAG', bestaetigung: true, vertraege: [{ adrnr: '0000000501', vertragnr: '2' }, { adrnr: '0000000504', vertragnr: '1' }] });
  assert.equal(r.status, 400, 'fremder Vertrag');
  assert.equal(await ende('0000000501', '2'), null, 'nichts halb ausgeführt');
  assert.equal((await sql`select count(*)::int as n from tco.kuendigungen where status = 'OFFEN'`)[0].n, 0, 'abgelehnte Eingaben hinterlassen nichts');
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'VERTRAG', bestaetigung: true, vertraege: [{ adrnr: '0000000501', vertragnr: '2' }, { adrnr: '0000000502', vertragnr: '2' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k3 = r.body.id as number;
  assert.equal(await ende('0000000501', '2'), null, 'die Prüfung beim Einreichen ändert nichts');
  assert.equal(await ende('0000000502', '2'), null);
  r = await admin('POST', `${K}/${k3}/freigeben`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Schließfach gekündigt am .* zum 31\.12\..*Jugendtraining 2 \(.*Kim.*\) gekündigt/);
  assert.equal((await admin('POST', `${K}/${k3}/senden`, { ohneMail: true })).status, 200);
  assert.equal((await hinweise()).filter((a) => a.key.startsWith('HINWEIS:MG_KUENDIGUNG:')).length, 2, 'je freigegebener Kündigung ein Hinweis – abgelehnte melden nichts');
  assert.equal(await ende('0000000501', '2'), `${jahr}-12-31`);
  assert.equal(await ende('0000000502', '2'), jugendEnde);
  assert.equal((await sql`select austritt from tco.mitglieder where adrnr = '0000000501'`)[0].austritt, null, 'kein Austritt ohne Mitgliedsbeitrag');

  // eigener Mitgliedsbeitrag in der Auswahl = Mitgliedschaft: Austritt 31.12. des laufenden Jahres, alle eigenen Verträge enden
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'VERTRAG', bestaetigung: true, vertraege: [{ adrnr: '0000000501', vertragnr: '1' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k4 = r.body.id as number;
  assert.match(r.body.text, /Eingereicht: Mitgliedschaft gekündigt am .* zum 31\.12\./);
  assert.equal((await sql`select art from tco.kuendigungen where id = ${k4}`)[0].art, 'MITGLIEDSCHAFT');
  r = await paula('GET', `${M}/meine`);
  assert.equal(r.body.gekuendigt, false, 'eingereicht, aber noch nicht ausgetreten');
  assert.ok(r.body.vertraege.every((v: any) => v.adrnr !== '0000000501' || !v.kuendbar), 'eigene Verträge warten mit der Mitgliedschaft');
  r = await paula('POST', `${M}/meine/kuendigung`, { art: 'MITGLIEDSCHAFT', bestaetigung: true });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Kündigung der Mitgliedschaft ist bereits eingereicht/);
  assert.equal((await sql`select austritt from tco.mitglieder where adrnr = '0000000501'`)[0].austritt, null);
  r = await admin('POST', `${K}/${k4}/freigeben`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Mitgliedschaft gekündigt am .* zum 31\.12\./);
  assert.equal((await admin('POST', `${K}/${k4}/senden`, { ohneMail: true })).status, 200);
  const [m] = await sql`select austritt::text as a from tco.mitglieder where adrnr = '0000000501'`;
  assert.equal(m.a, `${jahr}-12-31`);
  assert.ok((await sql`select vertragende::text as e from tco.vertraege where adrnr = '0000000501'`).every((v) => v.e === `${jahr}-12-31`));
  r = await paula('GET', `${M}/meine`);
  assert.equal(r.body.gekuendigt, true);
  assert.equal((await paula('POST', `${M}/meine/kuendigung`, { art: 'MITGLIEDSCHAFT', bestaetigung: true })).status, 400, 'nur einmal');
  assert.ok((await sql`select count(*)::int as n from core.change_header where object_type = 'MITGLIED' and action = 'KUENDIGUNG'`)[0].n >= 2);
  assert.ok((await sql`select count(*)::int as n from core.change_header where object_type = 'KUENDIGUNG'`)[0].n >= 4, 'Einreichen, Freigabe, Ablehnung und Abschluss mit Änderungsbeleg');
});

test('Sperre: eigenes Mitglied in „Meine Mitgliedschaft“ sperrbar, fremdes nicht; Vorstand und Mitglied blockieren sich gegenseitig', async () => {
  const S = '/api/sperren';
  const kim = client();
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim.portal', password: 'mein-neues-kennwort' })).status, 200);
  // Kim sperrt sich selbst – nicht Paula
  let r = await kim('POST', S, { objekt: 'MITGLIED', schluessel: '0000000502', bezeichnung: 'Mitglied Kim Portal (Meine Mitgliedschaft)' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id as number;
  assert.equal((await kim('POST', S, { objekt: 'MITGLIED', schluessel: '0000000501' })).status, 403);
  // Sperrübersicht zeigt die Sperre
  r = await admin('GET', S);
  assert.ok(r.body.some((s: { id: number; bezeichnung: string }) => s.id === id && /Meine Mitgliedschaft/.test(s.bezeichnung)));
  // Vorstand kann Kim gerade nicht bearbeiten
  assert.equal((await admin('POST', S, { objekt: 'MITGLIED', schluessel: '0000000502' })).status, 423);
  r = await admin('POST', `${M}/m/0000000502/kanal`, { kanal: 'E' });
  assert.equal(r.status, 423, JSON.stringify(r.body));
  await kim('POST', `${S}/freigeben`, { ids: [id] });
  // umgekehrt: Vorstand sperrt, Kim kann nicht speichern
  r = await admin('POST', S, { objekt: 'MITGLIED', schluessel: '0000000502' });
  assert.equal(r.status, 200);
  r = await kim('PUT', `${M}/meine/kontakt`, { strasse: 'Weg 2', plz: '66649', ort: 'Oberthal', telefon: '', mobil: '', email: 'kim@example.org', bildrechte: false });
  assert.equal(r.status, 423, JSON.stringify(r.body));
  assert.equal((await kim('POST', S, { objekt: 'MITGLIED', schluessel: '0000000502' })).status, 423);
});

test('Meine Dokumente: ohne Paperless leer mit Hinweis, fremde Dokumente nicht abrufbar', async () => {
  let r = await paula('GET', `${M}/meine/dokumente`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.dokumente, []);
  assert.match(r.body.hinweis, /nicht eingerichtet/);
  r = await paula('GET', `${M}/meine/dokumente/4711`);
  assert.ok([400, 404].includes(r.status), String(r.status));
});

test('Rollen: zugeordnete Benutzer anzeigen, einzeln entziehen, Rolle löschen entzieht allen', async () => {
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'TESTROLLE', name: 'Test', permissions: ['tco.mitglieder:display'] })).status, 200);
  const ids = (await sql`select id::text, username from core.users where username in ('kim.portal', 'paula.portal')`);
  for (const u of ids) await sql`insert into core.user_roles (user_id, role_id) values (${u.id}, 'TESTROLLE')`;
  let r = await admin('GET', '/api/admin/roles/TESTROLLE/users');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x: { username: string }) => x.username).sort(), ['kim.portal', 'paula.portal']);
  const kimId = ids.find((x) => x.username === 'kim.portal')!.id;
  r = await admin('POST', '/api/admin/roles/TESTROLLE/entziehen', { benutzer: [kimId] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await sql`select role_id from core.user_roles where user_id = ${kimId} order by 1`).map((x) => x.role_id), ['MITGLIED'], 'andere Rollen bleiben');
  assert.equal((await paula('POST', '/api/admin/roles/TESTROLLE/entziehen', { benutzer: [kimId] })).status, 403);
  // letzter Admin / eigene Adminrolle bleibt
  const [a] = await sql`select id::text from core.users where username = 'admin'`;
  r = await admin('POST', '/api/admin/roles/ADMIN/entziehen', { benutzer: [a.id] });
  assert.equal(r.status, 400);
  // Rolle löschen: wird allen entzogen; Systemrollen nicht löschbar
  r = await admin('DELETE', '/api/admin/roles/TESTROLLE');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /1 Benutzer\(n\) entzogen/);
  assert.equal((await sql`select count(*)::int as n from core.user_roles where role_id = 'TESTROLLE'`)[0].n, 0);
  assert.equal((await admin('DELETE', '/api/admin/roles/MITGLIED')).status, 400);
  assert.equal((await admin('DELETE', '/api/admin/roles/ADMIN')).status, 400);
});

test('Benutzer: Status direkt sperren, Einzelanlage aus Mitglied/EP3, Austritt sperrt den Benutzer', async () => {
  // Einzelanlage: Kandidaten enthalten Mitglied ohne Benutzer und EP3-Kunde ohne Benutzer
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, eintritt, mitglnrn) values ('0000000505', 'Eva', 'Einzeln', 'eva@example.org', '2024-01-01', '505')`;
  await sql`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname) values ('55', 'gast.g', 'enabled', 'gast@example.org', 'Gerd', 'Gast')`;
  let r = await admin('GET', `${M}/benutzer-kandidaten?suche=ein`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.some((k: { art: string; schluessel: string }) => k.art === 'MITGLIED' && k.schluessel === '0000000505'));
  r = await admin('GET', `${M}/benutzer-kandidaten?suche=gast`);
  assert.ok(r.body.some((k: { art: string; schluessel: string }) => k.art === 'EP3' && k.schluessel === '55'));
  assert.equal((await paula('GET', `${M}/benutzer-kandidaten?suche=a`)).status, 403);

  r = await admin('POST', `${M}/benutzer-einzeln`, { art: 'MITGLIED', schluessel: '0000000505', mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.username, 'eva@example.org');
  assert.ok(r.body.startkennwort);
  assert.deepEqual((await sql`select ur.role_id from core.user_roles ur join core.users u on u.id = ur.user_id where u.username = 'eva@example.org'`).map((x) => x.role_id), ['MITGLIED']);
  assert.equal((await admin('POST', `${M}/benutzer-einzeln`, { art: 'MITGLIED', schluessel: '0000000505' })).status, 400, 'nur einmal');
  r = await admin('POST', `${M}/benutzer-einzeln`, { art: 'EP3', schluessel: '55' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.username, 'gast@example.org');
  assert.deepEqual((await sql`select ur.role_id from core.user_roles ur join core.users u on u.id = ur.user_id where u.username = 'gast@example.org'`).map((x) => x.role_id), ['HALLENNUTZER']);

  // Status direkt sperren/entsperren
  const [eva] = await sql`select id::text from core.users where username = 'eva@example.org'`;
  r = await admin('POST', `/api/admin/users/${eva.id}/aktiv`, { aktiv: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select active from core.users where id = ${eva.id}`)[0].active, false);
  r = await admin('POST', `/api/admin/users/${eva.id}/aktiv`, { aktiv: true });
  assert.equal((await sql`select active from core.users where id = ${eva.id}`)[0].active, true);
  const [ad] = await sql`select id::text from core.users where username = 'admin'`;
  assert.equal((await admin('POST', `/api/admin/users/${ad.id}/aktiv`, { aktiv: false })).status, 400, 'nicht sich selbst');
  assert.equal((await paula('POST', `/api/admin/users/${eva.id}/aktiv`, { aktiv: false })).status, 403);

  // Austritt in der Vergangenheit (Verwaltung) → Benutzer sofort gesperrt
  r = await admin('POST', `${M}/m/0000000505/austritt`, { austritt: '2025-12-31' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Benutzer eva@example\.org gesperrt/);
  assert.equal((await sql`select active from core.users where id = ${eva.id}`)[0].active, false);
  // Kündigung zum Jahresende sperrt erst nach dem Austritt (täglicher Lauf)
  const { ausgetreteneSperren, ausgetreteneSperrenMelden } = await import('../../modules/tco/server/mitglieder/selbst.js');
  const r2 = await sql.begin((tx) => ausgetreteneSperren(tx as never));
  assert.ok(!r2.gesperrt.includes('paula.portal'), 'Paula: Austritt erst zum Jahresende');
  await sql`update tco.mitglieder set austritt = current_date - 1 where adrnr = '0000000501'`;
  // der Lauf meldet die Sperre im Arbeitsvorrat (#232, V1) – unter „Administration“, Absprung zu den Benutzern
  const r3 = await sql.begin((tx) => ausgetreteneSperrenMelden(tx as never));
  assert.ok(r3.gesperrt.includes('paula.portal'));
  const sperre = (await hinweise()).find((a) => a.key.startsWith('HINWEIS:MG_SPERRE:') && /paula\.portal$/.test(a.titel));
  assert.ok(sperre, 'Sperre im Arbeitsvorrat');
  assert.deepEqual([sperre.bereich, sperre.pfad], ['Administration', '/admin/benutzer']);
  assert.match(sperre.text, /ausgetreten – der Benutzer wurde automatisch gesperrt/);
  assert.equal((await paula('GET', `${M}/meine`)).status, 401, 'Sitzung beendet');
});

test('Benutzer ↔ Mitglied/EP3: einzeln zuordnen und initiales Mapping', async () => {
  // vorhandene Benutzer ohne Zuordnung (z. B. vor dem Portal angelegt)
  for (const [u, n, e] of [['ines', 'Ines Initial', 'ines@example.org'], ['kai.k', 'Kunde, Kai', null]] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: n, email: e, password: 'start-passwort', roles: [] })).status, 200);
  }
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, eintritt) values ('0000000506', 'Ines', 'Initial', 'ines@example.org', '2023-01-01')`;
  await sql`insert into tco.kunden (zuid, zalias, status, vorname, nachname) values ('66', 'kai.k', 'enabled', 'Kai', 'Kunde'), ('67', 'ines.ep3', 'enabled', 'Ines', 'Initial')`;
  let r = await admin('GET', `${M}/benutzer-mapping`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ines = r.body.find((v: { username: string }) => v.username === 'ines');
  const kai = r.body.find((v: { username: string }) => v.username === 'kai.k');
  assert.equal(ines.mitglied.adrnr, '0000000506');
  assert.equal(ines.mitglied.grund, 'gleiche E-Mail');
  assert.equal(ines.ep3.zuid, '67');
  assert.equal(kai.mitglied, null);
  assert.equal(kai.ep3.zuid, '66');
  assert.equal(kai.ep3.grund, 'gleicher Benutzername');
  r = await admin('POST', `${M}/benutzer-mapping`, { liste: [{ benutzerId: ines.benutzerId, adrnr: ines.mitglied.adrnr, zuid: ines.ep3.zuid }, { benutzerId: kai.benutzerId, zuid: '66' }], rolleMitglied: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /1 Mitglied\(er\) und 2 EP3-Kunde\(n\)/);
  r = await admin('GET', `${M}/benutzer/${ines.benutzerId}/zuordnung`);
  assert.equal(r.body.mitglied.adrnr, '0000000506');
  assert.deepEqual([r.body.ep3.zuid, r.body.ep3.ueber], ['67', 'MITGLIED']);
  assert.deepEqual((await sql`select role_id from core.user_roles where user_id = ${ines.benutzerId}`).map((x) => x.role_id), ['MITGLIED']);
  r = await admin('GET', `${M}/benutzer/${kai.benutzerId}/zuordnung`);
  assert.deepEqual([r.body.mitglied, r.body.ep3.ueber], [null, 'BENUTZER']);
  // danach keine Vorschläge mehr für beide
  r = await admin('GET', `${M}/benutzer-mapping`);
  assert.ok(!r.body.some((v: { username: string }) => ['ines', 'kai.k'].includes(v.username)));
  // einzeln ändern/entfernen; EP3-Kunde eines anderen Benutzers abgelehnt
  r = await admin('PUT', `${M}/benutzer/${kai.benutzerId}/zuordnung`, { zuid: '67' });
  assert.equal(r.status, 400);
  r = await admin('PUT', `${M}/benutzer/${kai.benutzerId}/zuordnung`, { zuid: null });
  assert.equal(r.status, 200);
  assert.equal((await admin('GET', `${M}/benutzer/${kai.benutzerId}/zuordnung`)).body.ep3, null);
  const kim = client();
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim.portal', password: 'mein-neues-kennwort' })).status, 200);
  assert.equal((await kim('GET', `${M}/benutzer-mapping`)).status, 403);
});

test('Benutzer löschen: nur ohne Buchungen, nicht sich selbst; Zuordnung zum EP3-Kunden wird gelöst', async () => {
  const anlegen = async (username: string) => {
    assert.equal((await admin('POST', '/api/admin/users', { username, displayName: username, password: 'start-passwort', roles: ['HALLENNUTZER'] })).status, 200);
    return (await sql`select id::text from core.users where username = ${username}`)[0].id as string;
  };
  // ohne Buchungen → löschbar, EP3-Zuordnung wird gelöst
  const leer = await anlegen('loesch.leer');
  await sql`insert into tco.kunden (zuid, zalias, status, vorname, nachname, benutzer_id) values ('77', 'loesch.leer', 'enabled', 'Lea', 'Leer', ${leer})`;
  let r = await admin('DELETE', `/api/admin/users/${leer}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select count(*)::int as n from core.users where id = ${leer}`)[0].n, 0);
  assert.equal((await sql`select benutzer_id from tco.kunden where zuid = '77'`)[0].benutzer_id, null);

  // eigene Portalbuchung (auch storniert) → nicht löschbar
  const portal = await anlegen('loesch.portal');
  await sql`insert into tco.bookings (bid, datum, status, benutzer_id, quelle) values ('LT1', '2026-01-10', '2', ${portal}, 'PORTAL')`;
  r = await admin('DELETE', `/api/admin/users/${portal}`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.message, /1 Platzbuchung vorhanden/);

  // EP3-Buchung des zugeordneten Kunden (über den Namen) → nicht löschbar
  const ep3 = await anlegen('loesch.ep3');
  await sql`insert into tco.kunden (zuid, zalias, status, vorname, nachname, benutzer_id) values ('78', 'loesch.ep3', 'enabled', 'Eddi', 'Drei', ${ep3})`;
  await sql`insert into tco.bookings (bid, datum, status, kunde) values ('LT2', '2025-02-01', '1', 'EDDI DREI'), ('LT2', '2025-02-08', '1', 'EDDI DREI')`;
  r = await admin('DELETE', `/api/admin/users/${ep3}`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.message, /1 Platzbuchung vorhanden/);

  // nicht sich selbst, nicht ohne Berechtigung, unbekannt → 404
  const [ad] = await sql`select id::text from core.users where username = 'admin'`;
  assert.equal((await admin('DELETE', `/api/admin/users/${ad.id}`, {})).status, 400);
  assert.equal((await admin('DELETE', '/api/admin/users/00000000-0000-0000-0000-000000000000', {})).status, 404);
});

test('Mitglieder-Benutzer haben immer das Recht für Hallenbuchungen', async () => {
  const rollen = async (adrnr: string) => (await sql`select ur.role_id from tco.mitgliedera a join core.user_roles ur on ur.user_id = a.benutzer_id where a.adrnr = ${adrnr} order by 1`).map((x) => x.role_id);
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, eintritt, mitglnrn) values
    ('0000000591', 'Hanna', 'Halle', 'hanna.halle@example.org', '2024-01-01', '591'), ('0000000592', 'Hugo', 'Halle', 'hugo.halle@example.org', '2024-01-01', '592')`;
  // Standard: die Rolle Mitglied enthält „Platz buchen“ – keine weitere Rolle nötig
  let r = await admin('POST', `${M}/benutzer-einzeln`, { art: 'MITGLIED', schluessel: '0000000591', mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await rollen('0000000591'), ['MITGLIED']);
  // Recht aus der Rolle Mitglied entfernt: neue Mitglieder-Benutzer bekommen zusätzlich die Rolle Hallennutzer
  await sql`delete from core.role_permissions where role_id = 'MITGLIED' and permission = 'tco.platzbuchung:edit'`;
  r = await admin('POST', `${M}/benutzer-einzeln`, { art: 'MITGLIED', schluessel: '0000000592', mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await rollen('0000000592'), ['HALLENNUTZER', 'MITGLIED']);
  assert.ok((await sql`select 1 from core.role_permissions where role_id = 'HALLENNUTZER' and permission = 'tco.platzbuchung:edit'`).length === 1);
  await sql`insert into core.role_permissions (role_id, permission) values ('MITGLIED', 'tco.platzbuchung:edit') on conflict do nothing`;
});
