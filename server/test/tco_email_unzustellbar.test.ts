/**
 * E-Mail-Adresse „unzustellbar“ im Mitgliederstamm (modules/tco/server/emailsperre.ts, server/src/lib/mailsperre.ts):
 *  - n8n meldet beim Senden einen dauerhaften Empfängerfehler → Vermerk am Mitglied (und an Mitgliedern mit derselben Adresse);
 *    Konfigurations-, vorübergehende und sonstige Fehler setzen nie einen Vermerk
 *  - Versand unterdrücken: an eine vermerkte Adresse geht nichts mehr an n8n – Ergebnis „fehler“, Protokoll „nicht_gesendet“;
 *    bei mehreren Empfängern fällt nur der gesperrte weg
 *  - Vermerk entfällt mit einer neuen E-Mail-Adresse (Stammdaten, „Meine Daten“, direkte Änderung, EP3-Kundenstamm)
 *  - von Hand setzen und zurücknehmen (mit Grund), Liste/Filter, Detail, Arbeitsvorrat des Kassenwarts
 *  - Rückläufer über den Maileingang (Zustellbericht bzw. Text mit zugeordneter E-Mail)
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
const { mailSenden, emailUnzustellbar, emailGesperrt } = await import('../../modules/tco/server/kommunikation.js');
const { vereinLesen } = await import('../../modules/tco/server/verein.js');
const { mailSenden: kernMailSenden } = await import('../src/lib/mail.js');

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
const T = '/api/m/tco/mitglieder';
const db = sql as never;

/** n8n-Attrappe: antwortet je Empfänger wie der Workflow „TCO Mailversand“ */
const mails: { an: string; cc: string; bcc: string; betreff: string }[] = [];
let n8nAblehnen = false;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (n8nAblehnen) { res.writeHead(403); res.end('Authorization data is wrong!'); return; }
    const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    mails.push(m);
    res.writeHead(200, { 'content-type': 'application/json' });
    const an = String(m.an).toLowerCase();
    if (an.includes('weg@')) res.end(JSON.stringify({ status: 'fehler', fehler: "Can't send mail - all recipients were rejected: 550 5.1.1 <weg@uz.example>: Recipient address rejected: User unknown in virtual mailbox table" }));
    else if (an.includes('voll@')) res.end(JSON.stringify({ status: 'fehler', fehler: '552 5.2.2 <voll@uz.example>: Mailbox full' }));
    else if (an.includes('spaeter@')) res.end(JSON.stringify({ status: 'fehler', fehler: '450 4.1.1 <spaeter@uz.example>: Recipient address rejected: unverified address, try again later' }));
    else if (an.includes('absender@')) res.end(JSON.stringify({ status: 'fehler', fehler: '550 5.7.1 Sender address rejected: not owned by user' }));
    else res.end(JSON.stringify({ status: 'gesendet', message_id: `<uz${mails.length}@n8n.test>` }));
  });
});

const A = { weg: '0000008401', familie: '0000008402', gut: '0000008403', voll: '0000008404', ohne: '0000008405', bounce: '0000008406', text: '0000008407', hand: '0000008408' };
const senden = async (an: string, mehr: { cc?: string; bcc?: string } = {}) => mailSenden(await vereinLesen(), {
  modus: 'senden', anwendung: 'TEST_UZ', objekt: 'UZ', an, ...mehr, betreff: `Test an ${an}`, text: 'Hallo', benutzer: 'test', persoenlich: false, anhaenge: [],
});
const vermerk = async (adrnr: string) => {
  const [m] = await sql`select email_unzustellbar_seit as seit, email_unzustellbar_grund as grund, email_unzustellbar_adresse as adresse, email_unzustellbar_quelle as quelle
                          from tco.mitglieder where adrnr = ${adrnr}`;
  return m;
};
const protokoll = async (an: string) => (await sql`select status, fehler, an from core.mail_protokoll where anwendung = 'TEST_UZ' and an = ${an} order by id desc limit 1`)[0];
const eingang = async (body: unknown) => {
  const res = await app.inject({ method: 'POST', url: '/api/mail/eingang', payload: body as object, headers: { 'x-portal-request': '1', 'x-tco-key': 'k' } });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis) values ('mail', ${`http://127.0.0.1:${port}/webhook/mail`}, 'header', 'X-TCO-Key', 'k')
            on conflict (id) do update set url = excluded.url, auth_art = 'header', header_name = 'X-TCO-Key', geheimnis = excluded.geheimnis`;
  await sql`insert into tco.mitglieder (adrnr, mitglnrn, vorname, nachname, geburtsdatum, email, eintritt) values
            (${A.weg}, '8401', 'Wanda', 'Weg', '1980-01-01', 'Weg@uz.example', '2015-01-01'),
            (${A.familie}, '8402', 'Willi', 'Weg', '2010-01-01', 'weg@uz.example ', '2018-01-01'),
            (${A.gut}, '8403', 'Gerda', 'Gut', '1981-01-01', 'gut@uz.example', '2015-01-01'),
            (${A.voll}, '8404', 'Volker', 'Voll', '1982-01-01', 'voll@uz.example', '2015-01-01'),
            (${A.ohne}, '8405', 'Olga', 'Ohneadresse', '1983-01-01', null, '2015-01-01'),
            (${A.bounce}, '8406', 'Bodo', 'Bounce', '1984-01-01', 'bounce@uz.example', '2015-01-01'),
            (${A.text}, '8407', 'Tina', 'Text', '1985-01-01', 'text@uz.example', '2015-01-01'),
            (${A.hand}, '8408', 'Hanna', 'Hand', '1986-01-01', 'hand@uz.example', '2015-01-01')`;
  await sql`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname) values ('8405', 'olga', 'active', 'olga@kunde.example', 'Olga', 'Ohneadresse')`;
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

test('Senden: dauerhafter Empfängerfehler vermerkt die Adresse – auch beim Familienmitglied mit derselben Adresse', async () => {
  assert.equal(await emailUnzustellbar(db, A.weg), null);
  const r = await senden('weg@uz.example');
  assert.equal(r.status, 'fehler');
  assert.match(r.fehler ?? '', /User unknown.*weg@uz\.example wurde als unzustellbar vermerkt/);
  assert.deepEqual(r.unzustellbar, ['weg@uz.example']);
  assert.equal(mails.length, 1, 'der erste Versuch ging an n8n');
  const v = await vermerk(A.weg);
  assert.ok(v.seit);
  assert.deepEqual([v.adresse, v.quelle], ['weg@uz.example', 'VERSAND']);
  assert.match(v.grund, /550 5\.1\.1 .*User unknown/);
  assert.deepEqual([(await vermerk(A.familie)).adresse, (await vermerk(A.gut)).seit], ['weg@uz.example', null]);
  assert.equal((await protokoll('weg@uz.example')).status, 'fehler');
  // Änderungsbeleg: Benutzer „system“, Aktion EMAIL_UNZUSTELLBAR
  const [beleg] = await sql`select username, action from core.change_header where object_type = 'MITGLIED' and object_key = ${A.weg} order by id desc limit 1`;
  assert.deepEqual([beleg.username, beleg.action], ['system', 'EMAIL_UNZUSTELLBAR']);
});

test('Hilfsfunktion: emailUnzustellbar nach Adressnummer und nach Adresse', async () => {
  const v = await emailUnzustellbar(db, A.weg);
  assert.deepEqual([v?.adrnr, v?.adresse, v?.quelle, v?.name], [A.weg, 'weg@uz.example', 'VERSAND', 'Wanda Weg']);
  assert.match(v?.seit ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await emailUnzustellbar(db, ' WEG@uz.example '))?.adresse, 'weg@uz.example');
  assert.equal(await emailUnzustellbar(db, A.gut), null);
  assert.equal(await emailUnzustellbar(db, 'gut@uz.example'), null);
  assert.equal(await emailUnzustellbar(db, ''), null);
  assert.equal(await emailUnzustellbar(db, '0000009999'), null, 'unbekannte Adressnummer');
  assert.deepEqual([...(await emailGesperrt(db, ['gut@uz.example', 'Weg@uz.example'])).keys()], ['weg@uz.example']);
});

test('Versand unterdrücken: an die vermerkte Adresse geht nichts mehr an n8n', async () => {
  const vorher = mails.length;
  const r = await senden('Wanda Weg <WEG@uz.example>');
  assert.equal(r.status, 'fehler');
  assert.match(r.fehler ?? '', /^Nicht gesendet: E-Mail-Adresse weg@uz\.example ist im Mitgliederstamm als unzustellbar vermerkt \(seit \d\d\.\d\d\.\d{4}: .*User unknown/);
  assert.deepEqual(r.unzustellbar, ['weg@uz.example']);
  assert.equal(mails.length, vorher, 'kein Aufruf von n8n');
  const p = await protokoll('Wanda Weg <WEG@uz.example>');
  assert.equal(p.status, 'nicht_gesendet');
  assert.match(p.fehler, /im Mitgliederstamm als unzustellbar vermerkt/);
  assert.ok(r.protokoll, 'Eintrag im E-Mail-Protokoll');
  // keine Störung „E-Mail nicht gesendet“ je unterdrückter Mail – dafür steht der Eintrag des Kassenwarts im Arbeitsvorrat
  const [h] = await sql`select count(*)::int as n from core.hinweise where quelle = 'MAIL_FEHLER' and titel like '%WEG@uz.example%'`;
  assert.equal(h.n, 0);
  // der zentrale Versand des Kerns (z. B. „Erneut senden“, Kennwort-Link) lehnt ebenso ab
  const k = await kernMailSenden({ modus: 'senden', anwendung: 'TEST_UZ', objekt: 'KERN', an: 'weg@uz.example', betreff: 'Kern', text: 'x', benutzer: 'test', persoenlich: false, anhaenge: [] });
  assert.equal(k.status, 'fehler');
  assert.equal(mails.length, vorher);
  // die Testmail der Administration geht bewusst trotzdem hinaus (prüfen, ob die Adresse wieder erreichbar ist)
  const t = await admin('POST', '/api/mail/test', { an: 'weg@uz.example' });
  assert.equal(t.status, 400, 'n8n meldet weiterhin den Empfängerfehler');
  assert.equal(mails.length, vorher + 1);
  // Mitglieder-App → Kommunikation: klare Meldung statt „gesendet“
  const m = await admin('POST', `${T}/m/${A.weg}/mail`, { an: 'weg@uz.example', betreff: 'Hallo', text: 'Text' });
  assert.equal(m.status, 400);
  assert.match(m.body.message, /als unzustellbar vermerkt/);
});

test('Mehrere Empfänger: nur der gesperrte fällt weg (an, CC, BCC); bleibt keiner in „an“, wird abgelehnt', async () => {
  let vorher = mails.length;
  let r = await senden('weg@uz.example; Gerda Gut <gut@uz.example>', { cc: 'weg@uz.example, kopie@uz.example', bcc: 'WEG@uz.example' });
  assert.equal(r.status, 'gesendet');
  assert.match(r.hinweis ?? '', /Nicht gesendet an weg@uz\.example \(als unzustellbar vermerkt\)/);
  assert.deepEqual(r.unzustellbar, ['weg@uz.example']);
  assert.equal(mails.length, vorher + 1);
  assert.deepEqual([mails.at(-1)!.an, mails.at(-1)!.cc, mails.at(-1)!.bcc], ['Gerda Gut <gut@uz.example>', 'kopie@uz.example', '']);
  const p = await protokoll('Gerda Gut <gut@uz.example>');
  assert.equal(p.status, 'gesendet');
  assert.match(p.fehler, /Nicht gesendet an weg@uz\.example/);
  // gesperrte Adresse nur in CC: E-Mail geht ohne die Kopie hinaus
  vorher = mails.length;
  r = await senden('gut@uz.example', { cc: 'weg@uz.example' });
  assert.equal(r.status, 'gesendet');
  assert.equal(mails.at(-1)!.cc, '');
  // nur gesperrte Empfänger in „an“ (CC hilft nicht) → abgelehnt
  vorher = mails.length;
  r = await senden('weg@uz.example', { cc: 'gut@uz.example' });
  assert.equal(r.status, 'fehler');
  assert.equal(mails.length, vorher);
  // Feld lässt sich nicht sicher zerlegen (Name mit Komma) → abgelehnt statt an die gesperrte Adresse zu senden
  r = await senden('"Weg, Wanda" <weg@uz.example>, gut@uz.example');
  assert.equal(r.status, 'fehler');
  assert.equal(mails.length, vorher);
});

test('Kein Vermerk bei vollem Postfach, vorübergehendem Fehler, Absenderfehler und abgelehntem Webhook', async () => {
  assert.equal((await senden('voll@uz.example')).status, 'fehler');
  assert.equal((await vermerk(A.voll)).seit, null);
  await sql`update tco.mitglieder set email = 'spaeter@uz.example' where adrnr = ${A.voll}`;
  assert.equal((await senden('spaeter@uz.example')).status, 'fehler');
  assert.equal((await vermerk(A.voll)).seit, null);
  await sql`update tco.mitglieder set email = 'absender@uz.example' where adrnr = ${A.voll}`;
  assert.equal((await senden('absender@uz.example')).status, 'fehler');
  assert.equal((await vermerk(A.voll)).seit, null);
  n8nAblehnen = true;
  try {
    await assert.rejects(() => senden('gut@uz.example'), /Webhook-Schlüssel abgelehnt/);
  } finally { n8nAblehnen = false; }
  assert.equal((await vermerk(A.gut)).seit, null);
  // Entwurf an eine Adresse mit Empfängerfehler: kein Versand, also kein Vermerk (hier meldet die Attrappe trotzdem den Fehler)
  await sql`update tco.mitglieder set email = 'weg@entwurf.uz.example' where adrnr = ${A.voll}`;
  const e = await mailSenden(await vereinLesen(), { modus: 'entwurf', anwendung: 'TEST_UZ', objekt: 'UZ', an: 'weg@entwurf.uz.example', betreff: 'Entwurf', text: 'x', benutzer: 'test', persoenlich: false, anhaenge: [] });
  assert.equal(e.status, 'fehler');
  assert.equal((await vermerk(A.voll)).seit, null);
  // ein Empfängerfehler ohne passendes Mitglied vermerkt nichts und meldet nichts
  const r = await senden('weg@fremd.uz.example');
  assert.equal(r.status, 'fehler');
  assert.equal(r.unzustellbar, undefined);
});

test('Neue E-Mail-Adresse hebt den Vermerk auf: Stammdatenpflege, direkte Änderung, EP3-Kundenstamm', async () => {
  // Stammdaten sichern ohne Änderung der Adresse (nur Schreibweise): Vermerk bleibt
  const kopf = { anrede: 'Frau', vorname: 'Wanda', nachname: 'Weg', strasse: '', plz: '', ort: '', telefon: '', mobil: '', email: 'WEG@uz.example', geburtsdatum: '1980-01-01', eintritt: '2015-01-01', datenschutz: true, bildrechte: false };
  let r = await admin('PUT', `${T}/m/${A.weg}/kopf`, kopf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await vermerk(A.weg)).seit, 'gleiche Adresse: Vermerk bleibt');
  // neue Adresse: Vermerk entfällt, an die neue Adresse wird gesendet
  r = await admin('PUT', `${T}/m/${A.weg}/kopf`, { ...kopf, email: 'wanda.neu@uz.example' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = await vermerk(A.weg);
  assert.deepEqual([v.seit, v.grund, v.adresse, v.quelle], [null, null, null, null]);
  assert.equal((await senden('wanda.neu@uz.example')).status, 'gesendet');
  // das Familienmitglied hat die alte Adresse noch – dort bleibt der Vermerk, die alte Adresse bleibt gesperrt
  assert.ok((await vermerk(A.familie)).seit);
  assert.equal((await senden('weg@uz.example')).status, 'fehler');
  // direkte Änderung in der Datenbank (Import, „Meine Daten“ – jeder Schreibweg): Trigger
  await sql`update tco.mitglieder set email = null where adrnr = ${A.familie}`;
  assert.equal((await vermerk(A.familie)).seit, null, 'Adresse entfernt: Vermerk entfällt');
  assert.equal(await emailUnzustellbar(db, 'weg@uz.example'), null);
  // Mitglied ohne eigene Adresse wird über den EP3-Kundenstamm angeschrieben: Vermerk zur Kundenadresse, entfällt mit deren Änderung
  r = await admin('POST', `${T}/m/${A.ohne}/email-unzustellbar`, { grund: 'Rückläufer per Post gemeldet' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await vermerk(A.ohne)).adresse, 'olga@kunde.example');
  assert.equal((await senden('olga@kunde.example')).status, 'fehler');
  await sql`update tco.kunden set vorname = 'Olga' where zuid = '8405'`;
  assert.ok((await vermerk(A.ohne)).seit, 'Kunde geändert, Adresse gleich: Vermerk bleibt');
  await sql`update tco.kunden set email = 'olga.neu@kunde.example' where zuid = '8405'`;
  assert.equal((await vermerk(A.ohne)).seit, null);
});

test('Von Hand vermerken und zurücknehmen: Grund Pflicht, Liste, Detail, Arbeitsvorrat', async () => {
  const U = `${T}/m/${A.hand}/email-unzustellbar`;
  assert.equal((await admin('POST', U, { grund: ' ' })).status, 400, 'ohne Grund nicht');
  assert.equal((await admin('POST', `${U}/aufheben`, { grund: 'egal' })).status, 400, 'nichts vermerkt');
  let r = await admin('POST', U, { grund: 'Mitglied meldet: Postfach gelöscht' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /hand@uz\.example ist als unzustellbar vermerkt/);
  const v = await vermerk(A.hand);
  assert.deepEqual([v.adresse, v.quelle, v.grund], ['hand@uz.example', 'MANUELL', 'Mitglied meldet: Postfach gelöscht']);
  const [beleg] = await sql`select username, action, reason from core.change_header where object_type = 'MITGLIED' and object_key = ${A.hand} order by id desc limit 1`;
  assert.deepEqual([beleg.username, beleg.action, beleg.reason], ['admin', 'EMAIL_UNZUSTELLBAR', 'Mitglied meldet: Postfach gelöscht']);
  assert.equal((await senden('hand@uz.example')).status, 'fehler');
  // Detail und Liste
  r = await admin('GET', `${T}/m/${A.hand}`);
  assert.deepEqual([r.body.emailUnzustellbar.adresse, r.body.emailUnzustellbar.quelle, r.body.emailUnzustellbar.adrnr], ['hand@uz.example', 'MANUELL', A.hand]);
  assert.equal((await admin('GET', `${T}/m/${A.gut}`)).body.emailUnzustellbar, null);
  r = await admin('GET', `${T}/liste?status=UNZUSTELLBAR`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen.map((z: { adrnr: string }) => z.adrnr), [A.hand]);
  assert.equal(r.body.anzahl.UNZUSTELLBAR, 1);
  r = await admin('GET', `${T}/liste?status=AKTIV`);
  assert.deepEqual(r.body.zeilen.filter((z: { email_unzustellbar: boolean }) => z.email_unzustellbar).map((z: { adrnr: string }) => z.adrnr), [A.hand]);
  // Arbeitsvorrat des Kassenwarts
  const eintrag = async () => ((await admin('GET', '/api/arbeitsvorrat')).body.gruppen as { aufgaben?: { key: string; titel: string; pfad: string; bereich: string }[] }[])
    .flatMap((g) => g.aufgaben ?? []).find((a) => a.key === 'EMAIL_UNZUSTELLBAR');
  const a = await eintrag();
  assert.ok(a, 'Eintrag im Arbeitsvorrat');
  assert.deepEqual([a.titel, a.pfad, a.bereich], ['1 Mitglied per E-Mail nicht erreichbar', '/tco/mitglieder?status=UNZUSTELLBAR', 'Kassenwart']);
  // zurücknehmen: mit Grund, danach wird wieder gesendet und der Eintrag verschwindet
  assert.equal((await admin('POST', `${U}/aufheben`, {})).status, 400, 'ohne Grund nicht');
  r = await admin('POST', `${U}/aufheben`, { grund: 'Adresse stimmt doch, Postfach war voll' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /an hand@uz\.example wird wieder gesendet/);
  assert.equal((await vermerk(A.hand)).seit, null);
  assert.equal((await senden('hand@uz.example')).status, 'gesendet');
  assert.equal(await eintrag(), undefined);
  // Mitglied ohne jede Adresse lässt sich nicht vermerken
  await sql`update tco.kunden set email = null where zuid = '8405'`;
  assert.equal((await admin('POST', `${T}/m/${A.ohne}/email-unzustellbar`, { grund: 'x' })).status, 400);
  // ohne Pflegerecht kein Zugriff
  assert.equal((await client()('POST', U, { grund: 'x' })).status, 401);
});

test('Rückläufer über den Maileingang: Zustellbericht vermerkt die Adresse, volles Postfach nicht', async () => {
  assert.equal((await senden('bounce@uz.example')).status, 'gesendet');
  const dsn = (adresse: string, status: string, diag: string) => ({
    postfach: 'TC Test <info@verein.example>', von: 'Mail Delivery Subsystem <MAILER-DAEMON@mail.verein.example>', betreff: 'Undelivered Mail Returned to Sender',
    datum: new Date().toISOString(), message_id: `<dsn-${adresse}-${status}@mail.verein.example>`,
    text: `This is the mail system at host mail.verein.example.\n\nI'm sorry to have to inform you that your message could not be delivered.\n\n`
      + `Reporting-MTA: dns; mail.verein.example\n\nFinal-Recipient: rfc822; ${adresse}\nAction: failed\nStatus: ${status}\nDiagnostic-Code: smtp; ${diag}\n`,
  });
  // Postfach voll: verbucht, aber kein Vermerk
  let r = await eingang(dsn('bounce@uz.example', '5.2.2', '552 5.2.2 Mailbox full'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.art, r.body.zugeordnet, r.body.vermerkt], ['unzustellbar', true, undefined]);
  assert.equal((await vermerk(A.bounce)).seit, null);
  // Adresse gibt es nicht: Vermerk mit Quelle RUECKLAEUFER
  r = await eingang(dsn('bounce@uz.example', '5.1.1', '550 5.1.1 <bounce@uz.example>: Recipient address rejected: User unknown'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.art, r.body.zugeordnet, r.body.vermerkt], ['unzustellbar', true, ['bounce@uz.example']]);
  const v = await vermerk(A.bounce);
  assert.deepEqual([v.adresse, v.quelle], ['bounce@uz.example', 'RUECKLAEUFER']);
  assert.match(v.grund, /Status: 5\.1\.1 .*User unknown/);
  const vorher = mails.length;
  assert.equal((await senden('bounce@uz.example')).status, 'fehler');
  assert.equal(mails.length, vorher);
  // Zustellbericht zu einer E-Mail, die nicht über das Portal lief (keine Zuordnung): die Adresse des Mitglieds wird trotzdem vermerkt
  r = await eingang(dsn('gut@uz.example', '5.1.1', '550 5.1.1 User unknown'));
  assert.deepEqual([r.body.zugeordnet, r.body.vermerkt], [true, ['gut@uz.example']], 'an gut@ wurde in diesem Test gesendet – zugeordnet');
  await sql`update tco.mitglieder set email = 'gerda.neu@uz.example' where adrnr = ${A.gut}`;
  r = await eingang(dsn('gerda.neu@uz.example', '5.1.1', '550 5.1.1 User unknown'));
  assert.deepEqual([r.body.zugeordnet, r.body.vermerkt], [false, ['gerda.neu@uz.example']]);
  assert.equal((await vermerk(A.gut)).quelle, 'RUECKLAEUFER');
  // verzögerte Zustellung (Action: delayed) vermerkt nichts
  await sql`update tco.mitglieder set email = 'gerda.drei@uz.example' where adrnr = ${A.gut}`;
  r = await eingang({ von: 'MAILER-DAEMON@mail.verein.example', betreff: 'Delivery Status Notification (Delay)', message_id: '<delay@mail.verein.example>',
    text: 'Final-Recipient: rfc822; gerda.drei@uz.example\nAction: delayed\nStatus: 4.4.1\nDiagnostic-Code: smtp; 451 4.4.1 try again later' });
  assert.equal(r.body.vermerkt, undefined);
  assert.equal((await vermerk(A.gut)).seit, null);
});

test('Rückläufer ohne Zustellbericht: nur Adressen der zugeordneten E-Mail, nur bei eindeutigem Fehler', async () => {
  assert.equal((await senden('text@uz.example')).status, 'gesendet');
  const rueck = (text: string, id: string) => ({
    postfach: 'info@verein.example', von: 'Mail Delivery System <Mailer-Daemon@mx.example.net>', betreff: 'Mail delivery failed: returning message to sender',
    datum: new Date().toISOString(), message_id: `<${id}@mx.example.net>`, text,
  });
  // Text nennt eine fremde Adresse eines Mitglieds, an die diese E-Mail gar nicht ging: kein Vermerk dort
  let r = await eingang(rueck('The following address(es) failed:\n\n  text@uz.example\n    SMTP error from remote mail server after RCPT TO:<text@uz.example>:\n    452 4.2.2 Mailbox full\n\nKopie an hand@uz.example', 'r1'));
  assert.deepEqual([r.body.zugeordnet, r.body.vermerkt], [true, undefined], 'vorübergehender Fehler');
  r = await eingang(rueck('The following address(es) failed:\n\n  text@uz.example\n    SMTP error from remote mail server after RCPT TO:<text@uz.example>:\n    550-Requested action not taken: mailbox unavailable\n\nIhre Nachricht ging auch an hand@uz.example', 'r2'));
  assert.deepEqual([r.body.zugeordnet, r.body.vermerkt], [true, ['text@uz.example']]);
  assert.equal((await vermerk(A.text)).quelle, 'RUECKLAEUFER');
  assert.equal((await vermerk(A.hand)).seit, null, 'nur Empfänger der zugeordneten E-Mail');
  // nicht zuordenbarer Rückläufer ohne Zustellbericht: nichts
  await sql`update tco.mitglieder set email = 'text.neu@uz.example' where adrnr = ${A.text}`;
  r = await eingang(rueck('The following address(es) failed:\n\n  text.neu@uz.example\n    550 mailbox unavailable', 'r3'));
  assert.deepEqual([r.body.zugeordnet, r.body.vermerkt], [false, undefined]);
  assert.equal((await vermerk(A.text)).seit, null);
});
