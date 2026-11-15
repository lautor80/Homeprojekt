/**
 * Rundschreiben: E-Mails an alle Mitglieder oder an Mitgliedergruppen – Empfängerermittlung (Gruppen mit Untergruppen,
 * je Adresse eine E-Mail, Minderjährige über die Eltern, Ausschlüsse, nie Ausgetretene oder Schnupper-Kontakte),
 * Entwurf mit Anhängen, Testmail, Versand im Hintergrund ohne Doppelversand, Wiederaufnahme, Protokoll, Berechtigungen.
 * Der Mailversand ist nie echt: Ein lokaler Server spielt den n8n-Webhook (und Paperless).
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
const { verbindungenCacheLeeren } = await import('../src/lib/verbindungen.js');
const { empfaengerErmitteln, einsetzen, AUSWAHL_LEER } = await import('../../modules/tco/server/rundschreiben/empfaenger.js');
const { versandAusloesen, versandLauf, versandWarten, versandWiederaufnehmen, ABBRUCH_NACH, UNTERBROCHEN } = await import('../../modules/tco/server/rundschreiben/versand.js');
type Person = import('../../modules/tco/server/rundschreiben/empfaenger.js').Person;

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, roh: res.rawPayload };
  };
}
const admin = client();
const R = '/api/m/tco/rundschreiben';
const ANNA = '0000000801', BEN = '0000000802', CARL = '0000000803', DORA = '0000000804', EMIL = '0000000805', KIM = '0000000806', PAUL = '0000000807',
  LIA = '0000000808', KAI = '0000000809', EX = '0000000810', SCHNUPPI = '0000000811', GUS = '0000000812', FRIDA = '0000000813';
const tag = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const KIND = `${new Date().getFullYear() - 10}-01-15`;

// ---------------------------------------------------------------- n8n-Webhook und Paperless als lokaler Server
interface Mail { an: string; cc: string; bcc: string; betreff: string; text: string; absender?: string; absender_name?: string; antwort_an: string; anwendung: string; anhaenge: { dateiname: string; mime: string; inhalt_base64: string }[] }
const mails: Mail[] = [];
/** was der Webhook je Adresse antwortet: nichts = gesendet */
const verhalten = { fehler: new Map<string, string>(), http500: false, verzoegerung: 0 };
const paperlessDocs: { title: string }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof data === 'string' && code >= 500 ? data : JSON.stringify(data)); };
    const u = decodeURIComponent(req.url ?? '');
    if (u === '/webhook/mail') {
      const m = JSON.parse(body) as Mail;
      setTimeout(() => {
        if (verhalten.http500) return send(500, 'Workflow abgestürzt');
        const f = verhalten.fehler.get(m.an.toLowerCase());
        if (f) return send(200, { status: 'fehler', fehler: f });
        mails.push(m);
        send(200, { status: 'gesendet', message_id: `rs${mails.length}` });
      }, verhalten.verzoegerung);
      return;
    }
    // Paperless (nur was die Ablage braucht)
    if (u === '/api/documents/post_document/') {
      paperlessDocs.push({ title: /name="title"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? '' });
      return send(200, `task-${700 + paperlessDocs.length}`);
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') return send(200, { results: [], next: null });
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\/$/.test(u) && req.method === 'POST') return send(201, { id: 50 + Math.floor(Math.random() * 1000), ...JSON.parse(body) });
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) return send(200, { id: Number(m[1]), title: '', custom_fields: [] });
    if (/^\/api\/documents\/\d+\/notes\/$/.test(u)) return send(200, []);
    send(404, { u });
  });
});
const mailAn = (an: string) => mails.filter((m) => m.an.toLowerCase() === an.toLowerCase());
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF').toString('base64')}`;

async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
const ALLE = { alle: true, gruppen: [] as number[], alter: '', arten: [] as string[], dazu: [] as string[], ohne: [] as string[] };
/** Entwurf anlegen und sichern */
async function entwurf(auswahl: Partial<typeof ALLE>, betreff = 'Rundbrief', text = '{Anrede},\n\nes gibt Neues im {Verein}.\n\nViele Grüße') {
  const r = await admin('POST', R);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id as number;
  const s = await admin('PUT', `${R}/${id}`, { betreff, text, antwort_an: null, auswahl: { ...ALLE, ...auswahl } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return id;
}
const vorschau = async (id: number) => (await admin('GET', `${R}/${id}/empfaenger`)).body as {
  empfaenger: { email: string; namen: string; anrede: string; personen: number; weg: string }[]; ohne_mail: { adrnr: string; name: string; grund: string }[];
  anzahl: { personen: number; mails: number; ohne_mail: number; dubletten: number; ausgeschlossen: number }; beispiel: { an: string; betreff: string; text: string } | null;
};
const protokoll = async (id: number) => (await admin('GET', `${R}/${id}/protokoll`)).body as {
  zeilen: { id: number; email: string | null; namen: string; status: string; fehler: string | null; versuche: number }[];
  zaehler: { gesamt: number; offen: number; gesendet: number; fehler: number; ohne_mail: number };
};
const status = async (id: number) => (await admin('GET', `${R}/${id}`)).body.status as string;

let gSpiel = 0, gHerren = 0, gH40 = 0;

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`update tco.verein set name = 'TC Test' where id = 1`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email, emailkih, adrnrkih, geburtsdatum, eintritt, austritt, strasse, plz, ort) values
    (${ANNA}, 'Anna', 'Aufschlag', 'anna@rs.example', null, null, '1980-05-05', '2020-01-01', null, 'Am Platz 1', '66649', 'Oberthal'),
    (${BEN}, 'Ben', 'Netz', 'ben@rs.example', null, null, '1975-03-03', '2020-01-01', null, null, null, null),
    (${CARL}, 'Carl', 'Linie', null, null, null, '1950-01-01', '2020-01-01', null, 'Grundlinie 7', '66649', 'Oberthal'),
    (${DORA}, 'Dora', 'Volley', 'familie@rs.example', null, null, '1982-02-02', '2020-01-01', null, null, null, null),
    (${EMIL}, 'Emil', 'Volley', 'Familie@RS.example', null, null, '1981-02-02', '2020-01-01', null, null, null, null),
    (${KIM}, 'Kim', 'Lob', 'kim@rs.example', null, ${PAUL}, ${KIND}, '2023-01-01', null, null, null, null),
    (${PAUL}, 'Paul', 'Lob', 'papa@rs.example', null, null, '1979-09-09', null, null, null, null, null),
    (${LIA}, 'Lia', 'Stopp', null, 'mama@rs.example', null, ${KIND}, '2023-01-01', null, null, null, null),
    (${KAI}, 'Kai', 'Aufschlag', null, null, null, ${KIND}, '2023-01-01', null, null, null, null),
    (${EX}, 'Ex', 'Mitglied', 'ex@rs.example', null, null, '1970-01-01', '2010-01-01', ${tag(-30)}, null, null, null),
    (${SCHNUPPI}, 'Susi', 'Schnupper', 'schnupper@rs.example', null, null, '1990-01-01', null, null, null, null, null),
    (${GUS}, 'Gus', 'Kaputt', 'kaputt', null, null, '1960-01-01', '2020-01-01', null, 'Netzweg 3', '66649', 'Oberthal'),
    (${FRIDA}, 'Frida', 'Bald-Weg', 'frida@rs.example', null, null, '1965-01-01', '2015-01-01', ${tag(60)}, null, null, null)`;
  await sql`insert into tco.schnupper (adrnr, nummer, status) values (${SCHNUPPI}, 'ST-2026-0801', 'NEU')`;
  await sql`insert into tco.familienverknuepfungen (adrnr_a, adrnr_b) values (${ANNA}, ${KAI})`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, vertragbegin) values (${ANNA}, '1', '10', 'Erwachsene', '2020-01-01'), (${BEN}, '1', '20', 'Passiv', '2020-01-01')`;
  // Gruppenbaum: Spielbetrieb (Anna) › Herren (Ben) › Herren 40 (Dora)
  [{ id: gSpiel }] = await sql`insert into tco.kal_gruppen (name) values ('RS Spielbetrieb') returning id`;
  [{ id: gHerren }] = await sql`insert into tco.kal_gruppen (name, parent_id) values ('RS Herren', ${gSpiel}) returning id`;
  [{ id: gH40 }] = await sql`insert into tco.kal_gruppen (name, parent_id) values ('RS Herren 40', ${gHerren}) returning id`;
  await sql`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr) values (${gSpiel}, ${ANNA}), (${gHerren}, ${BEN}), (${gH40}, ${DORA}), (${gH40}, ${EX})`;
  for (const [id, permissions] of [['RSLESER', ['tco.rundschreiben:display']], ['RSAUTOR', ['tco.rundschreiben:display', 'tco.rundschreiben:edit']],
                                     ['RSSENDER', ['tco.rundschreiben:display', 'tco.rundschreiben:execute']], ['MGLESER', ['tco.mitglieder:display']]] as const) {
    assert.equal((await admin('POST', '/api/admin/roles', { id, name: id, permissions })).status, 200);
  }
  for (const [u, roles] of [['rsleser', ['RSLESER']], ['rsautor', ['RSAUTOR']], ['rssender', ['RSSENDER']], ['mgleser', ['MGLESER']]] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles })).status, 200);
  }
  await sql`update core.users set email = 'vorstand@tc-test.example' where username = 'admin'`;
  await sql`update core.users set email = 'autor@tc-test.example' where username = 'rsautor'`;
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

async function mailEinrichten() {
  const port = (server.address() as { port: number }).port;
  await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis) values ('mail', ${`http://127.0.0.1:${port}/webhook/mail`}, 'header', 'X-TCO-Key', 'k')
            on conflict (id) do update set url = excluded.url, auth_art = 'header', header_name = 'X-TCO-Key', geheimnis = excluded.geheimnis`;
  verbindungenCacheLeeren();
}

// ---------------------------------------------------------------- Rechenteil ohne Datenbank
test('Empfängerermittlung (Rechenteil): Anrede, Platzhalter, Minderjährige, Dubletten', () => {
  const p = (adrnr: string, vorname: string, nachname: string, rest: Partial<Person> = {}): Person => ({
    adrnr, vorname, nachname, email: '', emailkih: '', zahler: '', geburtsdatum: '1980-01-01', eintritt: '2020-01-01', austritt: null, strasse: '', plz: '', ort: '', schnupper: false, ...rest,
  });
  const personen = [
    p('1', 'Max', 'Muster', { email: 'max@x.example' }), p('2', 'Mia', 'Muster', { email: 'MAX@x.example' }),
    p('3', 'Tom', 'Muster', { geburtsdatum: '2016-06-01', zahler: '1', email: 'tom@x.example' }),
    p('4', 'Ida', 'Solo', { geburtsdatum: '2016-06-01', email: 'ida@x.example' }),
    p('5', 'Uwe', 'Ohne'),
    p('6', 'Eva', 'Zahlt', { eintritt: null, email: 'eva@x.example' }), p('7', 'Jan', 'Zahlt', { geburtsdatum: '2015-01-01', zahler: '6' }),
    p('8', 'Alt', 'Weg', { austritt: '2026-01-01', email: 'alt@x.example' }),
  ];
  const r = empfaengerErmitteln({ personen, auswahl: { ...AUSWAHL_LEER, alle: true }, inGruppen: new Set(), arten: new Map(), verknuepfungen: [], heute: '2026-11-15' });
  assert.deepEqual(r.empfaenger.map((e) => [e.email.toLowerCase(), e.anrede, e.adrnrs.join(',')]).sort(), [
    ['eva@x.example', 'Liebe Eltern von Jan', '7'],
    ['ida@x.example', 'Hallo Ida', '4'],
    ['max@x.example', 'Hallo Max, Mia und Tom', '1,2,3'],
  ]);
  assert.deepEqual(r.ohneMail.map((o) => o.name), ['Uwe Ohne']);
  assert.equal(r.personen, 6);
  assert.equal(r.dubletten, 2, 'drei Personen, eine Adresse: zwei E-Mails weniger');
  const familie = r.empfaenger.find((e) => e.adrnrs.length === 3)!;
  assert.equal(einsetzen('{Anrede}, {Vorname} {Nachname} – {Verein} {Unbekannt}', familie, 'TC Test'), 'Hallo Max, Mia und Tom, Max, Mia und Tom Muster – TC Test {Unbekannt}');
  // am Tag des Austritts noch Mitglied, danach nicht mehr
  const tagGenau = empfaengerErmitteln({ personen, auswahl: { ...AUSWAHL_LEER, alle: true }, inGruppen: new Set(), arten: new Map(), verknuepfungen: [], heute: '2026-01-01' });
  assert.ok(tagGenau.empfaenger.some((e) => e.email === 'alt@x.example'));
});

// ---------------------------------------------------------------- Berechtigungen
test('Berechtigungen: ansehen, verfassen und senden sind getrennt', async () => {
  const katalog = JSON.stringify((await admin('GET', '/api/admin/permissions')).body);
  for (const p of ['tco.rundschreiben:display', 'tco.rundschreiben:edit', 'tco.rundschreiben:execute']) assert.ok(katalog.includes(p), p);

  const id = await entwurf({});
  const fremd = await anmelden('mgleser'), leser = await anmelden('rsleser'), autor = await anmelden('rsautor'), sender = await anmelden('rssender');
  // ohne Recht: nichts
  for (const [m, p] of [['GET', R], ['GET', `${R}/${id}`], ['GET', `${R}/${id}/protokoll`], ['GET', `${R}/${id}/empfaenger`], ['POST', R], ['POST', `${R}/${id}/senden`]] as const) {
    assert.equal((await fremd(m, p, {})).status, 403, `${m} ${p}`);
  }
  // nur ansehen
  assert.equal((await leser('GET', R)).status, 200);
  assert.equal((await leser('GET', `${R}/${id}`)).status, 200);
  assert.equal((await leser('GET', `${R}/${id}/protokoll`)).status, 200);
  for (const [m, p] of [['POST', R], ['PUT', `${R}/${id}`], ['DELETE', `${R}/${id}`], ['POST', `${R}/${id}/kopieren`], ['POST', `${R}/${id}/anhaenge`], ['POST', `${R}/${id}/test`],
                        ['GET', `${R}/auswahl`], ['GET', `${R}/${id}/empfaenger`], ['POST', `${R}/${id}/senden`], ['POST', `${R}/${id}/erneut`], ['POST', `${R}/${id}/anhalten`],
                        ['POST', `${R}/${id}/fortsetzen`], ['POST', `${R}/${id}/paperless`]] as const) {
    assert.equal((await leser(m, p, {})).status, 403, `Leser ${m} ${p}`);
  }
  // verfassen, aber nicht senden
  assert.equal((await autor('GET', `${R}/auswahl`)).status, 200);
  assert.equal((await autor('GET', `${R}/${id}/empfaenger`)).status, 200);
  assert.equal((await autor('PUT', `${R}/${id}`, { betreff: 'Vom Autor', text: 'Hallo', antwort_an: null, auswahl: ALLE })).status, 200);
  for (const p of ['senden', 'erneut', 'anhalten', 'fortsetzen', 'paperless']) assert.equal((await autor('POST', `${R}/${id}/${p}`, { mails: 6 })).status, 403, `Autor ${p}`);
  // senden, aber nicht verfassen – die Empfänger darf der Sender prüfen
  assert.equal((await sender('GET', `${R}/${id}/empfaenger`)).status, 200);
  assert.equal((await sender('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: ALLE })).status, 403);
  assert.equal((await sender('POST', R)).status, 403);
  // der Sender scheitert hier nicht am Recht, sondern am fehlenden Mailversand
  const r = await sender('POST', `${R}/${id}/senden`, { mails: 6 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Mailversand ist nicht eingerichtet/);
  assert.equal(await status(id), 'ENTWURF');
  assert.equal((await admin('DELETE', `${R}/${id}`)).status, 200);
});

// ---------------------------------------------------------------- Empfänger
test('Empfänger: alle aktiven Mitglieder – je Adresse eine E-Mail, Minderjährige über die Eltern, ohne Adresse, nie Ausgetretene/Schnupper', async () => {
  const id = await entwurf({});
  const v = await vorschau(id);
  assert.deepEqual(v.empfaenger.map((e) => [e.email.toLowerCase(), e.anrede, e.weg]).sort(), [
    ['anna@rs.example', 'Hallo Anna und Kai', 'FAMILIE'],      // Kai (minderjährig, ohne Adresse, Familienverknüpfung) über Anna
    ['ben@rs.example', 'Hallo Ben', 'EIGEN'],
    ['familie@rs.example', 'Hallo Dora und Emil', 'EIGEN'],    // gleiche Adresse in anderer Schreibweise
    ['frida@rs.example', 'Hallo Frida', 'EIGEN'],              // Austritt erst in der Zukunft
    ['mama@rs.example', 'Liebe Eltern von Lia', 'KONTOINHABER'],
    ['papa@rs.example', 'Liebe Eltern von Kim', 'ZAHLER'],     // nicht an kim@…, sondern an den Zahler
  ]);
  assert.deepEqual(v.ohne_mail.map((o) => [o.name, o.grund]), [['Gus Kaputt', 'E-Mail-Adresse ungültig (kaputt)'], ['Carl Linie', 'keine E-Mail-Adresse']]);
  assert.deepEqual(v.anzahl, { personen: 10, mails: 6, ohne_mail: 2, dubletten: 2, ausgeschlossen: 0 });
  const alleAdressen = JSON.stringify(v);
  for (const nie of ['ex@rs.example', 'schnupper@rs.example', 'kim@rs.example']) assert.ok(!alleAdressen.includes(nie), nie);
  // Vorschau mit echten Werten: erster Empfänger bzw. der gewählte
  assert.equal(v.beispiel!.text, `${v.empfaenger[0].anrede},\n\nes gibt Neues im TC Test.\n\nViele Grüße`);
  const fuer = (await admin('GET', `${R}/${id}/empfaenger?fuer=papa@rs.example`)).body.beispiel;
  assert.equal(fuer.an, 'papa@rs.example');
  assert.match(fuer.text, /^Liebe Eltern von Kim,/);

  // Ausschlüsse gehen vor; einzeln hinzufügen: Zahler eines Mitglieds ja, Ausgetretene und Schnupper-Kontakte nie
  let r = await admin('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: { ...ALLE, ohne: [BEN, KAI, CARL], dazu: [PAUL, EX, SCHNUPPI, BEN] } });
  assert.equal(r.status, 200);
  const a = await vorschau(id);
  assert.deepEqual(a.empfaenger.map((e) => [e.email.toLowerCase(), e.anrede]).sort(), [
    ['anna@rs.example', 'Hallo Anna'], ['familie@rs.example', 'Hallo Dora und Emil'], ['frida@rs.example', 'Hallo Frida'],
    ['mama@rs.example', 'Liebe Eltern von Lia'], ['papa@rs.example', 'Hallo Paul und Kim'],
  ]);
  assert.deepEqual(a.ohne_mail.map((o) => o.name), ['Gus Kaputt']);
  assert.equal(a.anzahl.ausgeschlossen, 3);

  // Altersgruppen und Beitragsart
  await admin('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: { ...ALLE, alter: 'JUGEND' } });
  assert.deepEqual((await vorschau(id)).empfaenger.map((e) => [e.email, e.anrede]).sort(), [
    ['anna@rs.example', 'Liebe Eltern von Kai'], ['mama@rs.example', 'Liebe Eltern von Lia'], ['papa@rs.example', 'Liebe Eltern von Kim']]);
  await admin('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: { ...ALLE, alter: 'ERWACHSENE' } });
  const erw = await vorschau(id);
  assert.deepEqual(erw.empfaenger.map((e) => e.email.toLowerCase()).sort(), ['anna@rs.example', 'ben@rs.example', 'familie@rs.example', 'frida@rs.example']);
  assert.equal(erw.anzahl.ohne_mail, 2);
  await admin('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: { ...ALLE, arten: ['20'] } });
  assert.deepEqual((await vorschau(id)).empfaenger.map((e) => e.email), ['ben@rs.example']);

  // Auswahlwerte: Gruppenbaum, Beitragsarten, Personen (ohne Ausgetretene und Schnupper-Kontakte)
  r = await admin('GET', `${R}/auswahl`);
  assert.deepEqual(r.body.gruppen.map((g: { pfad: string; gesamt: number }) => [g.pfad, g.gesamt]), [['RS Spielbetrieb', 4], ['RS Spielbetrieb › RS Herren', 3], ['RS Spielbetrieb › RS Herren › RS Herren 40', 2]]);
  assert.deepEqual(r.body.arten.map((x: { art: string; anzahl: number }) => [x.art, x.anzahl]), [['10', 1], ['20', 1]]);
  const wahl = r.body.personen.map((x: { adrnr: string }) => x.adrnr);
  assert.ok(wahl.includes(PAUL) && wahl.includes(ANNA));
  assert.ok(!wahl.includes(EX) && !wahl.includes(SCHNUPPI));
  assert.equal((await admin('DELETE', `${R}/${id}`)).status, 200);
});

test('Empfänger: Mitgliedergruppen schließen ihre Untergruppen ein, Ausgetretene der Gruppe bleiben draußen', async () => {
  const id = await entwurf({ alle: false, gruppen: [gSpiel] });
  assert.deepEqual((await vorschau(id)).empfaenger.map((e) => [e.email, e.anrede]), [['anna@rs.example', 'Hallo Anna'], ['ben@rs.example', 'Hallo Ben'], ['familie@rs.example', 'Hallo Dora']]);
  await admin('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: { ...ALLE, alle: false, gruppen: [gHerren] } });
  assert.deepEqual((await vorschau(id)).empfaenger.map((e) => e.email), ['ben@rs.example', 'familie@rs.example']);
  await admin('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: { ...ALLE, alle: false, gruppen: [gH40, gSpiel] } });
  assert.equal((await vorschau(id)).anzahl.mails, 3, 'mehrere Gruppen: jede Person nur einmal');
  // weder „alle“ noch eine Gruppe: niemand
  await admin('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: { ...ALLE, alle: false } });
  const leer = await vorschau(id);
  assert.equal(leer.anzahl.mails, 0);
  assert.equal(leer.beispiel, null);
  assert.equal((await admin('DELETE', `${R}/${id}`)).status, 200);
});

// ---------------------------------------------------------------- Entwurf
let vorlage = 0;
test('Entwurf: sichern, Anhänge mit Grenzen, kopieren, löschen', async () => {
  let r = await admin('POST', R);
  const id = r.body.id as number;
  r = await admin('GET', `${R}/${id}`);
  assert.equal(r.body.status, 'ENTWURF');
  assert.match(r.body.text, /^\{Anrede\},/);
  assert.equal(r.body.auswahl.alle, true);
  assert.equal((await admin('PUT', `${R}/${id}`, { betreff: 'B', text: 'T', antwort_an: 'keine adresse', auswahl: ALLE })).status, 400);
  assert.equal((await admin('PUT', `${R}/${id}`, { betreff: 'Sommerfest', text: '{Anrede},\n\nkommt alle!', antwort_an: 'vorstand@tc-test.example', auswahl: { ...ALLE, alle: false, gruppen: [gSpiel] } })).status, 200);

  // Anhänge: PDF und Bilder, höchstens 5 MB zusammen
  r = await admin('POST', `${R}/${id}/anhaenge`, { dateiname: 'Einladung.pdf', data: PDF });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.anhaenge.map((a: { dateiname: string; mime: string }) => [a.dateiname, a.mime]), [['Einladung.pdf', 'application/pdf']]);
  r = await admin('POST', `${R}/${id}/anhaenge`, { dateiname: 'skript.exe', data: `data:application/octet-stream;base64,${Buffer.from('MZ-kein-pdf').toString('base64')}` });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nur PDF-Dateien und Bilder/);
  const gross = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
  r = await admin('POST', `${R}/${id}/anhaenge`, { dateiname: 'riesig.pdf', data: gross });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /zu groß/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]).toString('base64');
  r = await admin('POST', `${R}/${id}/anhaenge`, { dateiname: 'plan.png', data: png });
  assert.equal(r.body.anhaenge.length, 2);
  const bild = r.body.anhaenge[1].id as number;
  r = await admin('GET', `${R}/${id}/anhaenge/${bild}`);
  assert.equal(r.status, 200);
  assert.equal(r.roh.subarray(1, 4).toString(), 'PNG');
  r = await admin('DELETE', `${R}/${id}/anhaenge/${bild}`);
  assert.equal(r.body.anhaenge.length, 1);

  // als Vorlage kopieren: Text, Auswahl, Antwortadresse und Anhänge
  r = await admin('POST', `${R}/${id}/kopieren`);
  assert.equal(r.status, 200);
  const kopie = (await admin('GET', `${R}/${r.body.id}`)).body;
  assert.equal(kopie.betreff, 'Sommerfest');
  assert.equal(kopie.kopie_von, id);
  assert.equal(kopie.antwort_an, 'vorstand@tc-test.example');
  assert.deepEqual(kopie.auswahl.gruppen, [gSpiel]);
  assert.deepEqual(kopie.anhaenge.map((a: { dateiname: string }) => a.dateiname), ['Einladung.pdf']);
  assert.equal((await admin('DELETE', `${R}/${kopie.id}`)).status, 200);
  assert.equal((await admin('GET', `${R}/${kopie.id}`)).status, 404);
  // ein neuer Entwurf übernimmt die zuletzt verwendete Antwortadresse
  r = await admin('POST', R);
  assert.equal((await admin('GET', `${R}/${r.body.id}`)).body.antwort_an, 'vorstand@tc-test.example');
  await admin('DELETE', `${R}/${r.body.id}`);
  vorlage = id;
});

// ---------------------------------------------------------------- Testmail und Versand
test('Testmail an mich selbst: eigene Adresse, echte Platzhalterwerte, Anhänge – kein Versand an Mitglieder', async () => {
  assert.equal((await admin('POST', `${R}/${vorlage}/test`)).status, 400, 'ohne Mailversand');
  await mailEinrichten();
  const autor = client();
  assert.equal((await autor('POST', '/api/auth/login', { username: 'rsautor', password: 'neues-passwort' })).status, 200);
  const r = await autor('POST', `${R}/${vorlage}/test`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Testmail an autor@tc-test\.example gesendet/);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].an, 'autor@tc-test.example');
  assert.equal(mails[0].betreff, '[Test] Sommerfest');
  assert.match(mails[0].text, /^Hallo Anna,\n\nkommt alle!/);
  assert.deepEqual(mails[0].anhaenge.map((a) => a.dateiname), ['Einladung.pdf']);
  assert.equal(await status(vorlage), 'ENTWURF');
  assert.equal((await protokoll(vorlage)).zeilen.length, 0);
  // ohne eigene Adresse geht es nicht
  await sql`update core.users set email = null where username = 'rsautor'`;
  const ohne = await autor('POST', `${R}/${vorlage}/test`);
  assert.equal(ohne.status, 400);
  assert.match(ohne.body.message, /fehlt Ihre E-Mail-Adresse/);
  assert.equal(mails.length, 1);
  mails.length = 0;
});

test('Versand: je Adresse genau eine E-Mail, nie mehrere Adressen in An/CC, Fehler mit Grund, erneut senden ohne Doppelversand', async () => {
  const id = vorlage;
  // Empfänger: Gruppe Spielbetrieb samt Untergruppen (Anna, Ben, Dora) und Carl (ohne Adresse)
  await admin('PUT', `${R}/${id}`, { betreff: 'Sommerfest bei {Verein}', text: '{Anrede},\n\nkommt alle, {Vorname} {Nachname}!', antwort_an: null, auswahl: { ...ALLE, alle: false, gruppen: [gSpiel], dazu: [CARL] } });
  const v = await vorschau(id);
  assert.deepEqual(v.anzahl, { personen: 4, mails: 3, ohne_mail: 1, dubletten: 0, ausgeschlossen: 0 });
  // Bestätigung mit falscher Zahl: nichts geht hinaus
  let r = await admin('POST', `${R}/${id}/senden`, { mails: 7 });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Empfängerliste hat sich geändert/);
  assert.equal((await admin('POST', `${R}/${id}/senden`, {})).status, 400);
  assert.equal(mails.length, 0);

  verhalten.fehler.set('ben@rs.example', '550 mailbox unavailable');
  // zweimal gleichzeitig ausgelöst: nur einer gewinnt
  const beide = await Promise.all([admin('POST', `${R}/${id}/senden`, { mails: 3 }), admin('POST', `${R}/${id}/senden`, { mails: 3 })]);
  assert.deepEqual(beide.map((x) => x.status).sort(), [200, 409]);
  await versandWarten(id);
  assert.equal(await status(id), 'FERTIG');

  assert.equal(mails.length, 2);
  for (const m of mails) {
    assert.ok(!/[,; ]/.test(m.an.trim()), `genau eine Adresse in An: ${m.an}`);
    assert.equal(m.cc, '');
    assert.equal(m.bcc, '');
    assert.equal(m.anwendung, 'Rundschreiben');
    assert.equal(m.betreff, 'Sommerfest bei TC Test');
    assert.deepEqual(m.anhaenge.map((a) => a.dateiname), ['Einladung.pdf']);
    // Absender ist, wer gesendet hat; Antworten gehen an ihn, solange keine Antwortadresse vorgegeben ist
    assert.equal(m.absender, 'vorstand@tc-test.example');
    assert.equal(m.absender_name, 'Admin | TC Test');
    assert.equal(m.antwort_an, 'vorstand@tc-test.example');
  }
  assert.equal(mailAn('anna@rs.example')[0].text, 'Hallo Anna,\n\nkommt alle, Anna Aufschlag!');
  assert.equal(mailAn('familie@rs.example')[0].text, 'Hallo Dora,\n\nkommt alle, Dora Volley!');

  let p = await protokoll(id);
  assert.deepEqual(p.zaehler, { gesamt: 3, offen: 0, gesendet: 2, fehler: 1, ohne_mail: 1 });
  assert.deepEqual(p.zeilen.map((z) => [z.namen, z.status, z.fehler]), [
    ['Ben Netz', 'FEHLER', '550 mailbox unavailable'], ['Carl Linie', 'OHNE_MAIL', 'keine E-Mail-Adresse'],
    ['Anna Aufschlag', 'GESENDET', null], ['Dora Volley', 'GESENDET', null],
  ]);
  // gesendet ist gesendet: nicht mehr änderbar, nicht löschbar, nicht noch einmal sendbar
  assert.equal((await admin('PUT', `${R}/${id}`, { betreff: 'x', text: 'y', antwort_an: null, auswahl: ALLE })).status, 409);
  assert.equal((await admin('DELETE', `${R}/${id}`)).status, 409);
  assert.equal((await admin('POST', `${R}/${id}/anhaenge`, { dateiname: 'spaet.pdf', data: PDF })).status, 409);
  assert.equal((await admin('POST', `${R}/${id}/senden`, { mails: 3 })).status, 409);
  // Inhalt und Anhänge stehen nicht je Empfänger im Mailprotokoll
  const proto = await sql`select status, nachricht from core.mail_protokoll where anwendung = 'Rundschreiben' and objekt = ${`RS-${id}`}`;
  assert.equal(proto.length, 3);
  for (const x of proto) assert.deepEqual(Object.keys(x.nachricht as object), ['wiederholung']);

  // Liste der nicht Erreichten (CSV) und Ausdruck
  r = await admin('GET', `${R}/${id}/nicht-erreicht.csv`);
  assert.equal(r.status, 200);
  assert.match(r.body, /"Ben Netz";"";"";"";"ben@rs\.example";"550 mailbox unavailable"/);
  assert.match(r.body, /"Carl Linie";"Grundlinie 7";"66649";"Oberthal";"";"keine E-Mail-Adresse"/);
  assert.ok(!/Anna/.test(r.body));
  r = await admin('GET', `${R}/${id}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.roh.subarray(0, 5).toString(), '%PDF-');

  // Stamm berichtigt: Ben hat eine neue Adresse, Carl jetzt eine – erneut senden nimmt die neuen, die Gesendeten bleiben unberührt
  verhalten.fehler.clear();
  await sql`update tco.mitglieder set email = 'ben.neu@rs.example' where adrnr = ${BEN}`;
  await sql`update tco.mitglieder set email = 'carl@rs.example' where adrnr = ${CARL}`;
  r = await admin('POST', `${R}/${id}/erneut`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vorgemerkt, 2);
  assert.equal(r.body.nachgetragen, 1);
  await versandWarten(id);
  assert.equal(await status(id), 'FERTIG');
  assert.equal(mails.length, 4);
  for (const an of ['anna@rs.example', 'familie@rs.example', 'ben.neu@rs.example', 'carl@rs.example']) assert.equal(mailAn(an).length, 1, an);
  assert.equal(mailAn('ben@rs.example').length, 0);
  p = await protokoll(id);
  assert.deepEqual(p.zaehler, { gesamt: 4, offen: 0, gesendet: 4, fehler: 0, ohne_mail: 0 });
  assert.equal(p.zeilen.find((z) => z.namen === 'Ben Netz')!.versuche, 2);
  // nichts mehr zu wiederholen
  assert.equal((await admin('POST', `${R}/${id}/erneut`, {})).status, 400);
  assert.equal(mails.length, 4);
  // in der Liste mit Zählern
  r = await admin('GET', R);
  const zeile = r.body.liste.find((x: { id: number }) => x.id === id);
  assert.equal(zeile.status, 'FERTIG');
  assert.equal(zeile.zaehler.gesendet, 4);
  assert.equal(zeile.gesendet_von, 'Admin');
  await sql`update tco.mitglieder set email = 'ben@rs.example' where adrnr = ${BEN}`;
  await sql`update tco.mitglieder set email = null where adrnr = ${CARL}`;
  mails.length = 0;
});

test('Versand hält nach Fehlschlägen in Folge an und lässt sich fortsetzen; angehalten von Hand', async () => {
  const id = await entwurf({}, 'Störung');
  await admin('PUT', `${R}/${id}`, { betreff: 'Störung', text: '{Anrede}, hallo', antwort_an: 'antwort@tc-test.example', auswahl: ALLE });
  verhalten.http500 = true;
  let r = await admin('POST', `${R}/${id}/senden`, { mails: 6 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await versandWarten(id);
  let k = (await admin('GET', `${R}/${id}`)).body;
  assert.equal(k.status, 'ANGEHALTEN');
  assert.match(k.hinweis, new RegExp(`${ABBRUCH_NACH} E-Mails in Folge sind fehlgeschlagen`));
  assert.deepEqual(k.zaehler, { gesamt: 6, offen: 1, gesendet: 0, fehler: 5, ohne_mail: 2 });
  assert.equal(mails.length, 0);
  // fortsetzen: der offene Empfänger geht hinaus, die fehlgeschlagenen erst mit „erneut senden“
  verhalten.http500 = false;
  assert.equal((await admin('POST', `${R}/${id}/fortsetzen`)).status, 200);
  await versandWarten(id);
  assert.equal(await status(id), 'FERTIG');
  assert.equal(mails.length, 1);
  assert.equal((await admin('POST', `${R}/${id}/fortsetzen`)).status, 409);
  r = await admin('POST', `${R}/${id}/erneut`, {});
  assert.equal(r.body.vorgemerkt, 5);
  await versandWarten(id);
  k = (await admin('GET', `${R}/${id}`)).body;
  assert.equal(k.status, 'FERTIG');
  assert.deepEqual(k.zaehler, { gesamt: 6, offen: 0, gesendet: 6, fehler: 0, ohne_mail: 2 });
  assert.equal(mails.length, 6);
  assert.equal(new Set(mails.map((m) => m.an.toLowerCase())).size, 6, 'jede Adresse genau einmal');
  assert.ok(mails.every((m) => m.antwort_an === 'antwort@tc-test.example'), 'eingestellte Antwortadresse');
  assert.equal(mailAn('papa@rs.example')[0].text, 'Liebe Eltern von Kim, hallo');
  // nach dem Abschluss liegt der Ausdruck in Paperless (sobald eingerichtet) – hier noch nicht
  assert.equal(k.paperless_id, null);
  mails.length = 0;

  // von Hand anhalten: die übrigen bleiben offen
  const id2 = await entwurf({}, 'Anhalten');
  verhalten.verzoegerung = 80;
  assert.equal((await admin('POST', `${R}/${id2}/senden`, { mails: 6 })).status, 200);
  assert.equal((await admin('POST', `${R}/${id2}/anhalten`)).status, 200);
  await versandWarten(id2);
  verhalten.verzoegerung = 0;
  k = (await admin('GET', `${R}/${id2}`)).body;
  assert.equal(k.status, 'ANGEHALTEN');
  assert.match(k.hinweis, /angehalten von Admin/);
  assert.ok(k.zaehler.offen >= 1 && k.zaehler.gesendet + k.zaehler.offen === 6, JSON.stringify(k.zaehler));
  assert.equal((await admin('POST', `${R}/${id2}/fortsetzen`)).status, 200);
  await versandWarten(id2);
  assert.equal(await status(id2), 'FERTIG');
  assert.equal(mails.length, 6);
  assert.equal(new Set(mails.map((m) => m.an.toLowerCase())).size, 6);
  mails.length = 0;
});

test('Kein Doppelversand: mehrere Läufe gleichzeitig senden jede Adresse nur einmal', async () => {
  const id = await entwurf({}, 'Parallel');
  await sql.begin((tx) => versandAusloesen(tx as never, id, { name: 'Test', email: null }, 6));
  verhalten.verzoegerung = 15;
  await Promise.all([versandLauf(id), versandLauf(id), versandLauf(id), versandLauf(id)]);
  verhalten.verzoegerung = 0;
  assert.equal(await status(id), 'FERTIG');
  assert.equal(mails.length, 6);
  assert.equal(new Set(mails.map((m) => m.an.toLowerCase())).size, 6);
  // ohne persönlichen Absender (z. B. API-Schlüssel): Ersatzabsender der Anwendung, kein Absender im Aufruf
  assert.ok(mails.every((m) => m.absender === undefined));
  const p = await protokoll(id);
  assert.ok(p.zeilen.filter((z) => z.status === 'GESENDET').every((z) => z.versuche === 1));
  // die Datenbank lässt je Rundschreiben und Adresse nur eine Zeile zu
  await assert.rejects(sql`insert into tco.rundschreiben_empfaenger (rundschreiben_id, email, adrnrs, namen) values (${id}, 'ANNA@rs.example', ${[ANNA]}, 'Anna')`, /rundschreiben_empfaenger_adresse_uq/);
  mails.length = 0;
});

test('Wiederaufnahme nach Neustart: Offene gehen weiter, die beim Abbruch bearbeitete Zeile wird nicht noch einmal gesendet', async () => {
  const id = await entwurf({}, 'Neustart');
  await sql.begin((tx) => versandAusloesen(tx as never, id, { name: 'Admin', email: 'vorstand@tc-test.example' }, 6));
  // Stand wie nach einem Absturz: eine Zeile war gerade in Arbeit, eine schon gesendet
  const zeilen = await sql`select id, email from tco.rundschreiben_empfaenger where rundschreiben_id = ${id} and status = 'OFFEN' order by id`;
  await sql`update tco.rundschreiben_empfaenger set status = 'GESENDET', gesendet_am = now(), versuche = 1 where id = ${zeilen[0].id}`;
  await sql`update tco.rundschreiben_empfaenger set status = 'SENDET', versuche = 1 where id = ${zeilen[1].id}`;
  assert.deepEqual(await versandWiederaufnehmen(), [id]);
  await versandWarten(id);
  assert.equal(await status(id), 'FERTIG');
  assert.equal(mails.length, 4, 'nur die vier offenen');
  assert.equal(mailAn(zeilen[0].email as string).length, 0);
  assert.equal(mailAn(zeilen[1].email as string).length, 0);
  // der Absender bleibt, wer den Versand ausgelöst hat
  assert.ok(mails.every((m) => m.absender === 'vorstand@tc-test.example' && m.absender_name === 'Admin | TC Test'));
  const p = await protokoll(id);
  const unklar = p.zeilen.find((z) => z.id === Number(zeilen[1].id))!;
  assert.equal(unklar.status, 'FEHLER');
  assert.equal(unklar.fehler, UNTERBROCHEN);
  assert.deepEqual(p.zaehler, { gesamt: 6, offen: 0, gesendet: 5, fehler: 1, ohne_mail: 2 });
  // abgeschlossene Rundschreiben fasst die Wiederaufnahme nicht an
  assert.deepEqual(await versandWiederaufnehmen(), []);
  assert.equal(mails.length, 4);
  mails.length = 0;
});

test('Funktionsschalter „Rundschreiben senden“: abgeschaltet hält ein laufender Versand an', async () => {
  const { schalterSetzen, schalterZustand } = await import('../src/funktionsschalter.js');
  const id = await entwurf({}, 'Schalter');
  await sql.begin((tx) => versandAusloesen(tx as never, id, { name: 'Admin', email: null }, 6));
  const vorher = schalterZustand();
  schalterSetzen({ ...vorher, ids: new Set([...vorher.ids, 'tco.rundschreiben.versand']) });
  try {
    await versandLauf(id);
  } finally { schalterSetzen(vorher); }
  const k = (await admin('GET', `${R}/${id}`)).body;
  assert.equal(k.status, 'ANGEHALTEN');
  assert.match(k.hinweis, /abgeschaltet/);
  assert.equal(mails.length, 0);
  assert.equal(k.zaehler.offen, 6);
});

test('Paperless: Ausdruck des gesendeten Rundschreibens ablegen – von selbst nach dem Versand und auf Knopfdruck', async () => {
  const port = (server.address() as { port: number }).port;
  await sql`insert into core.verbindungen (id, url, auth_art, geheimnis) values ('paperless', ${`http://127.0.0.1:${port}`}, 'token', 'geheim')
            on conflict (id) do update set url = excluded.url, auth_art = 'token', geheimnis = excluded.geheimnis`;
  verbindungenCacheLeeren();
  const id = await entwurf({ alle: false, gruppen: [gH40] }, 'Mannschaftsmeldung');
  let r = await admin('POST', `${R}/${id}/paperless`);
  assert.equal(r.status, 400, 'Entwurf wird nicht abgelegt');
  assert.equal((await admin('POST', `${R}/${id}/senden`, { mails: 1 })).status, 200);
  await versandWarten(id);
  const k = (await admin('GET', `${R}/${id}`)).body;
  assert.equal(k.status, 'FERTIG');
  assert.ok(k.paperless_id, 'nach dem Versand abgelegt');
  assert.deepEqual(paperlessDocs.map((d) => d.title), [`Rundschreiben ${id} – Mannschaftsmeldung`]);
  r = await admin('POST', `${R}/${id}/paperless`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /in Paperless abgelegt \(DOKID \d{6}\)/);
  assert.equal(paperlessDocs.length, 2);
});
