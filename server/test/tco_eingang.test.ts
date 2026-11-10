/**
 * Dokumenteneingang: Regelwerk (reine Logik), Schnittstelle für n8n (API-Schlüssel), Ablage in Paperless und Nextcloud,
 * Dubletten, Prüfliste (Regel/von Hand/ignorieren/neu bewerten), Fehlerfall und Berechtigungen.
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
const L = await import('../../modules/tco/server/eingang/logik.js');
const { config } = await import('../src/config.js');
const { customFeldWert } = await import('../src/lib/paperless.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') && res.body ? JSON.parse(res.body) : res.body, ct, headers: res.headers };
  };
}
/** Aufruf wie n8n: nur Bearer, kein Cookie, kein CSRF-Header */
async function ext(key: string, method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const E = '/api/m/tco/eingang';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------- Attrappe für Paperless und Nextcloud (WebDAV)
const mock = {
  docs: new Map<number, { title: string; datei: string; correspondent: string | null; documentType: string | null; tags: string[] }>(),
  next: 700, kaputt: true,
  korr: [] as { id: number; name: string }[], tags: [] as { id: number; name: string }[],
  dav: [] as string[],
  abruf: [] as { auth: string; body: string }[],
  merge: [] as string[][], mergeKaputt: false, patches: [] as { id: number; body: any }[],
};
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = decodeURIComponent(req.url ?? '');
    // Gotenberg: Bild → PDF und PDFs zusammenfügen (Inhalte werden nur verkettet)
    if (u === '/forms/chromium/convert/html') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF Bildseite'); }
    if (u === '/forms/pdfengines/merge') {
      if (mock.mergeKaputt) { res.writeHead(400); return res.end('encrypted'); }
      const teile = [...body.matchAll(/filename="(\d+)\.pdf"\r\nContent-Type: application\/pdf\r\n\r\n([\s\S]*?)\r\n--/g)].sort((a, b) => a[1].localeCompare(b[1])).map((x) => x[2]);
      mock.merge.push(teile);
      res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(teile.join('\n'));
    }
    if (u === '/webhook/tco-dokumenteneingang-alle') {
      if (req.headers.authorization !== 'Bearer abruf-geheim') return send(403, { message: 'Authorization data is wrong!' });
      mock.abruf.push({ auth: String(req.headers.authorization), body });
      return send(200, { message: 'Workflow was started' });
    }
    if (u.startsWith('/remote.php/dav/files/nc')) {
      if (req.headers.authorization !== `Basic ${Buffer.from('nc:app-pw').toString('base64')}`) { res.writeHead(401); return res.end(); }
      if (req.method === 'PUT') mock.dav.push(u.replace('/remote.php/dav/files/nc', ''));
      res.writeHead(201); return res.end();
    }
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    if (u === '/api/documents/post_document/') {
      const datei = /filename="([^"]+)"/.exec(body)?.[1] ?? '';
      if (datei === 'kaputt.pdf' && mock.kaputt) return send(500, { detail: 'Speicher voll' });
      const feld = (n: string) => new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1] ?? null;
      const id = mock.next++;
      mock.docs.set(id, { title: feld('title') ?? '', datei, correspondent: feld('correspondent'), documentType: feld('document_type'), tags: [...body.matchAll(/name="tags"\r\n\r\n([^\r]*)/g)].map((x) => x[1]) });
      return send(200, `task-${id}`);
    }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const lists: Record<string, unknown[]> = {
        correspondents: mock.korr, document_types: [{ id: 9, name: 'Abrechnung' }], storage_paths: [{ id: 2, name: 'Mitglieder' }], tags: mock.tags,
        custom_fields: [{ id: 3, name: 'Betrag', data_type: 'monetary' }, { id: 5, name: 'Art', data_type: 'select', extra_data: { select_options: [{ id: 'a1', label: 'Beleg' }, { id: 'a2', label: 'Vertrag' }] } }],
      };
      return send(200, { results: lists[u.split('/')[2]], next: null });
    }
    if (u === '/api/correspondents/' && req.method === 'POST') { const k = { id: 50 + mock.korr.length, name: JSON.parse(body).name as string }; mock.korr.push(k); return send(201, k); }
    if (u === '/api/tags/' && req.method === 'POST') { const t = { id: 80 + mock.tags.length, name: JSON.parse(body).name as string }; mock.tags.push(t); return send(201, t); }
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      if (req.method === 'PATCH') mock.patches.push({ id: Number(m[1]), body: JSON.parse(body) });
      return send(200, { id: Number(m[1]), custom_fields: [] });
    }
    send(404, { u });
  });
});

const admin = client();
let key = '';
const ids: Record<string, number> = {};

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  await sql`insert into core.verbindungen (id, url, auth_art, geheimnis) values ('paperless', ${`http://127.0.0.1:${port}`}, 'token', 'geheim')`;
  config.gotenbergUrl = `http://127.0.0.1:${port}`;
  await sql`insert into core.verbindungen (id, url, auth_art, auth_user, geheimnis) values ('tco.nextcloud', ${`http://127.0.0.1:${port}`}, 'basic', 'nc', 'app-pw')`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, email) values ('0000000101', 'Hans', 'Müller', 'Hans@Example.org')`;
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

const bed = (feld: string, op: string, wert: string, nicht = false) => ({ feld, op, wert, nicht });
const regel = (r: Record<string, unknown>) => ({
  beschreibung: '', status: 'aktiv', prioritaet: 100, gilt_fuer: 'anhang', verknuepfung: 'und', extraktion: [], aktionen: {}, automatik: 'immer', ...r,
});
const mail = (m: Record<string, unknown>) => ({
  postfach: 'info@tc-test.de', ordner: 'INBOX', an: 'info@tc-test.de', datum: '2025-03-03T10:00:00+01:00', text: 'Guten Tag, anbei das Dokument.', anhaenge: [], ...m,
});

test('Regelwerk: Bedingungen, Auswahl nach Priorität, Extraktion, Korrespondenten', () => {
  assert.deepEqual(L.absender('"SumUp Payments" <No-Reply@sumup.com>'), { adresse: 'no-reply@sumup.com', name: 'SumUp Payments', domain: 'sumup.com' });
  const korr = [{ id: 1, name: 'SumUp', kurz: 'SUMUP', adressen: 'sumup.com' }, { id: 2, name: 'Muster', kurz: '', adressen: 'muster@sumup.com' }];
  assert.equal(L.korrespondentFinden(korr, 'x@mail.sumup.com')?.name, 'SumUp');
  assert.equal(L.korrespondentFinden(korr, 'muster@sumup.com')?.name, 'Muster', 'genaue Adresse schlägt Domain');
  assert.equal(L.korrespondentFinden(korr, 'a@notsumup.com'), null);
  const k = { korrespondent: 'SumUp', datei: 'Abrechnung_2026-10.pdf', doktext: 'Rechnungsnummer: RE-4711', mitglied: 'nein' };
  const r = {
    id: 1, name: 'A', status: 'aktiv' as const, prioritaet: 10, gilt_fuer: 'anhang' as const, verknuepfung: 'und' as const, automatik: 'immer' as const, version: 1, aktionen: {},
    bedingungen: [{ feld: 'korrespondent' as const, op: 'ist' as const, wert: 'sumup' }, { feld: 'datei' as const, op: 'muster' as const, wert: '^abrechnung_.*\\.pdf$' },
      { feld: 'mitglied' as const, op: 'ist' as const, wert: 'ja', nicht: true }],
    extraktion: [{ name: 'rgnr', quelle: 'doktext' as const, muster: 'Rechnungsnummer:\\s*(\\S+)', pflicht: true }, { name: 'x', quelle: 'betreff' as const, muster: 'fehlt', pflicht: true }],
  };
  assert.equal(L.regelPasst(r, k), true);
  assert.equal(L.regelPasst({ ...r, bedingungen: [] }, k), false, 'ohne Bedingungen passt nichts');
  assert.equal(L.waehlen([{ ...r, id: 2, prioritaet: 5, status: 'aus' }, { ...r, id: 3, prioritaet: 20 }, r], k, 'anhang')?.id, 1);
  assert.equal(L.waehlen([r], k, 'mail'), null);
  assert.deepEqual(L.extrahieren(r.extraktion, k), { felder: { rgnr: 'RE-4711', x: '' }, fehlend: ['x'] });
  assert.equal(L.relevanterAnhang({ name: 'logo.png', mime: 'image/png', groesse: 5000 }), false);
  assert.equal(L.relevanterAnhang({ name: 'scan.png', mime: 'image/png', groesse: 500_000 }), true);
  assert.equal(L.pfadSicher('Rechnungen/../2026//SumUp '), 'Rechnungen/2026/SumUp');
  assert.equal(L.vorgangStatus([], false), 'ohne_regel');
  assert.equal(L.vorgangStatus(['abgelegt', 'fehler', 'pruefen'], false), 'fehler');
  assert.equal(L.vorgangStatus(['dublette', 'ignoriert'], false), 'abgelegt');
});

test('Regeln und Korrespondenten pflegen, Rolle, API-Schlüssel', async () => {
  const rolle = await sql`select permission from core.role_permissions where role_id = 'DOKUMENTENEINGANG' order by 1`;
  assert.deepEqual(rolle.map((r) => r.permission), ['tco.eingang:display', 'tco.eingang:edit']);

  let r = await admin('POST', `${E}/korrespondenten`, { name: 'SumUp', kurz: 'SUMUP', adressen: 'sumup.com' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('POST', `${E}/korrespondenten`, { name: 'sumup', adressen: '' })).status, 400, 'Name doppelt');

  r = await admin('POST', `${E}/regeln`, regel({ name: 'kaputt', bedingungen: [bed('von', 'muster', '(')] }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Ungültiges Muster/);
  r = await admin('POST', `${E}/regeln`, regel({ name: 'Mail mit Datei', gilt_fuer: 'mail', bedingungen: [bed('datei', 'endet', '.pdf')] }));
  assert.equal(r.status, 400);
  assert.equal((await admin('POST', `${E}/regeln`, regel({ name: 'leer', bedingungen: [] }))).status, 400);

  r = await admin('POST', `${E}/regeln`, regel({
    name: 'SumUp Abrechnung', prioritaet: 10,
    bedingungen: [bed('korrespondent', 'ist', 'SumUp'), bed('datei', 'endet', '.pdf')],
    extraktion: [{ name: 'nr', quelle: 'doktext', muster: 'Abrechnung Nr\\.?\\s*(\\d+)', pflicht: true }],
    aktionen: {
      paperless: { aktiv: true, titel: 'SumUp Abrechnung {feld.nr}', korrespondent: '{korrespondent}', dokumenttyp: 'Abrechnung', tags: 'Maileingang', datum: '{datum}' },
      nextcloud: { aktiv: true, pfad: 'Belege/{jahr}', dateiname: '{datum}_{kurz}_{feld.nr}' },
      mail: { art: 'verschieben', ordner: 'Erledigt', gelesen: true },
      aufgabe: { aktiv: false, titel: 'Beleg prüfen' },
    },
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ids.sumup = r.body.id;
  r = await admin('POST', `${E}/regeln`, regel({ name: 'Werbung', prioritaet: 20, gilt_fuer: 'mail', bedingungen: [bed('domain', 'ist', 'werbung.example')], aktionen: { mail: { art: 'verschieben', ordner: 'Werbung' } } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${E}/regeln`, regel({
    name: 'Mitglieder-Post', status: 'testlauf', prioritaet: 30, bedingungen: [bed('mitglied', 'ist', 'ja')],
    aktionen: { paperless: { aktiv: true, titel: '{datei|ohneEndung}', korrespondent: '{mitglied}', speicherpfad: 'Mitglieder' } },
  }));
  ids.mitglied = r.body.id;
  r = await admin('GET', `${E}/regeln`);
  assert.deepEqual(r.body.map((x: any) => [x.name, x.status, x.version, x.treffer]), [['SumUp Abrechnung', 'aktiv', 1, 0], ['Werbung', 'aktiv', 1, 0], ['Mitglieder-Post', 'testlauf', 1, 0]]);
  // Mailaktion „verschieben“ verlangt einen Ordner
  assert.equal((await admin('POST', `${E}/regeln`, regel({ name: 'ohne Ordner', bedingungen: [bed('von', 'ist', 'a@b.de')], aktionen: { mail: { art: 'verschieben' } } }))).status, 400);

  // Probe: Regel gegen eine Beispiel-E-Mail prüfen, nichts wird gespeichert
  const [db] = await sql`select name, beschreibung, status, prioritaet, gilt_fuer, verknuepfung, bedingungen, extraktion, aktionen, automatik from tco.eing_regeln where id = ${ids.sumup}`;
  r = await admin('POST', `${E}/regeln/test`, { regel: { ...db }, probe: { von: 'SumUp <noreply@mail.sumup.com>', betreff: 'Abrechnung', datei: 'abr.pdf', doktext: 'Abrechnung Nr. 99' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.passt, true);
  assert.deepEqual(r.body.bedingungen, [true, true]);
  assert.equal(r.body.paperless.title, 'SumUp Abrechnung 99');
  assert.equal(r.body.nextcloud.pfad, `Belege/${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 4)}`);

  r = await admin('GET', `${E}/stamm`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.paperless.dokumenttypen, ['Abrechnung']);
  assert.equal(r.body.nextcloud.eingerichtet, true);

  // API-Schlüssel für n8n: nur die Schnittstelle
  r = await admin('POST', '/api/admin/api-keys', { module: 'tco', name: 'n8n-eingang', permissions: ['tco.eingang:melden'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  key = r.body.key;
  r = await admin('POST', '/api/admin/api-keys', { module: 'tco', name: 'ohne-rechte', permissions: [] });
  assert.equal((await ext(r.body.key, 'POST', `${E}/mail`, mail({ von: 'a@b.de', betreff: 'x', message_id: '<x@b>' }))).status, 403);
  assert.equal((await ext(key, 'GET', `${E}/regeln`)).status, 403, 'Schnittstellen-Schlüssel sieht das Regelwerk nicht');
});

test('n8n: Abgleich, Ablage in Paperless und Nextcloud, Wiederholung, Dublette, Werbung, ohne Regel', async () => {
  let r = await ext(key, 'POST', `${E}/abgleich`, { postfach: 'info@tc-test.de', mails: [{ message_id: '<m1@sumup.com>', uid: 11 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { neu: [{ message_id: '<m1@sumup.com>', uid: '11' }], aktionen: [] });

  const pdf = { name: 'Abrechnung_2025-02.pdf', mime: 'application/pdf', inhalt: b64('%PDF-1.4 Abrechnung Februar'), text: 'SumUp Abrechnung Nr. 4711 Summe 120,00' };
  const logo = { name: 'logo.png', mime: 'image/png', inhalt: b64('klein'), text: '' };
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'SumUp <noreply@sumup.com>', betreff: 'Ihre Abrechnung', message_id: '<m1@sumup.com>', uid: 11, anhaenge: [pdf, logo] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.neu, true);
  assert.equal(r.body.status, 'abgelegt');
  assert.deepEqual(r.body.dokumente.map((d: any) => [d.datei, d.status, d.regel, d.paperless_id, d.nextcloud_pfad]),
    [['Abrechnung_2025-02.pdf', 'abgelegt', 'SumUp Abrechnung', 700, 'Belege/2025/2025-03-03_SUMUP_4711.pdf']]);
  assert.deepEqual(r.body.mail, { art: 'verschieben', ordner: 'Erledigt', gelesen: true, quelle: 'INBOX', uid: '11' });
  assert.deepEqual(r.body.aufgaben, [], 'Aufgabe ist an der Regel deaktiviert');
  const v1 = r.body.vorgang as number;
  const doc = mock.docs.get(700)!;
  assert.equal(doc.title, 'SumUp Abrechnung 4711');
  assert.equal(doc.documentType, '9');
  assert.equal(mock.korr.find((k) => String(k.id) === doc.correspondent)?.name, 'SumUp', 'Korrespondent in Paperless angelegt');
  assert.deepEqual(mock.tags.map((t) => t.name), ['Maileingang']);
  assert.deepEqual(mock.dav, ['/Belege/2025/2025-03-03_SUMUP_4711.pdf']);
  // nach der Ablage bleiben keine Inhalte im Portal
  const [d1] = await sql`select d.inhalt, d.kontext, v.text from tco.eing_dokumente d join tco.eing_vorgaenge v on v.id = d.vorgang_id where v.id = ${v1}`;
  assert.deepEqual({ ...d1 }, { inhalt: null, kontext: null, text: null });

  // dieselbe E-Mail noch einmal: kein zweiter Vorgang, kein zweiter Upload
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'SumUp <noreply@sumup.com>', betreff: 'Ihre Abrechnung', message_id: '<M1@sumup.com>', uid: 11, anhaenge: [pdf] }));
  assert.equal(r.body.neu, false);
  assert.equal(r.body.vorgang, v1);
  assert.equal(mock.docs.size, 1);

  // Behandlung der E-Mail steht aus, bis n8n sie als erledigt meldet
  r = await ext(key, 'POST', `${E}/abgleich`, { postfach: 'info@tc-test.de', mails: [{ message_id: '<m1@sumup.com>', uid: 11 }] });
  assert.deepEqual(r.body.neu, []);
  assert.deepEqual(r.body.aktionen.map((a: any) => [a.vorgang, a.uid, a.art, a.ordner, a.gelesen]), [[v1, '11', 'verschieben', 'Erledigt', true]]);
  r = await ext(key, 'GET', `${E}/mailaktionen?postfach=${encodeURIComponent('info@tc-test.de')}`);
  assert.deepEqual(r.body.map((a: any) => [a.vorgang, a.message_id, a.uid, a.quelle, a.art, a.ordner]), [[v1, 'm1@sumup.com', '11', 'INBOX', 'verschieben', 'Erledigt']]);
  assert.deepEqual((await ext(key, 'GET', `${E}/mailaktionen?postfach=anderes`)).body, []);
  assert.equal((await ext(key, 'POST', `${E}/vorgaenge/${v1}/mail-erledigt`)).status, 200);
  r = await ext(key, 'POST', `${E}/abgleich`, { postfach: 'info@tc-test.de', mails: [{ message_id: '<m1@sumup.com>', uid: 11 }] });
  assert.deepEqual(r.body, { neu: [], aktionen: [] });

  // gleiche Datei in einer zweiten E-Mail: Dublette, kein Upload
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'noreply@sumup.com', betreff: 'Erinnerung', message_id: '<m2@sumup.com>', anhaenge: [pdf] }));
  assert.deepEqual(r.body.dokumente.map((d: any) => [d.status, d.paperless_id]), [['dublette', 700]]);
  assert.equal(r.body.status, 'abgelegt');
  assert.equal(mock.docs.size, 1);

  // Werbung: Regel für die E-Mail selbst, keine Ablage, nur verschieben
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'news@werbung.example', betreff: 'Angebote', message_id: '<m3@w>' }));
  assert.equal(r.body.status, 'abgelegt');
  assert.deepEqual(r.body.dokumente, []);
  assert.equal(r.body.mail.ordner, 'Werbung');

  // keine Regel, kein Anhang: bleibt unangetastet im Postfach
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'jemand@privat.example', betreff: 'Frage zum Training', message_id: '<m4@p>' }));
  assert.equal(r.body.status, 'ohne_regel');
  assert.equal(r.body.mail, null);
  const [v4] = await sql`select text, hinweis from tco.eing_vorgaenge where id = ${r.body.vorgang}`;
  assert.deepEqual({ ...v4 }, { text: null, hinweis: 'Keine Regel passt.' }, 'Mailtext ohne Vorgang in der Prüfliste wird nicht gespeichert');

  // erneut geliefert („Posteingang abrufen“), weiterhin ohne Regel: derselbe Vorgang bleibt
  const v4Id = r.body.vorgang as number;
  const ohne = mail({ von: 'jemand@privat.example', betreff: 'Frage zum Training', message_id: '<m4@p>', uid: 44 });
  r = await ext(key, 'POST', `${E}/mail`, ohne);
  assert.deepEqual([r.body.neu, r.body.vorgang, r.body.status], [false, v4Id, 'ohne_regel']);
  const vorher = v4Id;
  // nach einer neuen Regel wird die E-Mail neu bewertet: Behandlung aus der Regel, keine Ablage
  const nr = await admin('POST', `${E}/regeln`, regel({ name: 'Privat', prioritaet: 90, gilt_fuer: 'mail', bedingungen: [bed('von', 'ist', 'jemand@privat.example')], aktionen: { mail: { art: 'loeschen', gelesen: true } } }));
  assert.equal(nr.status, 200, JSON.stringify(nr.body));
  r = await ext(key, 'POST', `${E}/mail`, ohne);
  assert.equal(r.body.neu, true);
  assert.equal(r.body.status, 'abgelegt');
  assert.deepEqual(r.body.mail, { art: 'loeschen', ordner: '', gelesen: true, quelle: 'INBOX', uid: '44' });
  assert.equal((await sql`select count(*)::int as n from tco.eing_vorgaenge where id = ${vorher}`)[0].n, 0, 'alter Vorgang „ohne Regel“ ersetzt');
  assert.equal((await sql`select count(*)::int as n from tco.eing_vorgaenge where message_id = 'm4@p'`)[0].n, 1);
  // bekannte, bereits abgelegte E-Mails bleiben bei erneuter Lieferung unverändert
  r = await ext(key, 'POST', `${E}/mail`, ohne);
  assert.equal(r.body.neu, false);
  assert.equal(await ext(key, 'POST', `${E}/vorgaenge/${r.body.vorgang}/mail-erledigt`).then((x) => x.status), 200);
  assert.equal((await admin('DELETE', `${E}/regeln/${nr.body.id}`)).status, 200);
});

test('Prüfliste: Testlauf-Vorschlag, Ablage mit Regel und von Hand, ignorieren, neu bewerten, Fehlerfall', async () => {
  // Mitglied schreibt: Regel im Testlauf → Vorschlag in der Prüfliste, nichts abgelegt
  let r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'Hans Müller <hans@example.org>', betreff: 'Bescheinigung', message_id: '<m5@e>', uid: 15,
    text: 'Hallo, anbei die Bescheinigung.', anhaenge: [{ name: 'bescheinigung.pdf', mime: 'application/pdf', inhalt: b64('%PDF Bescheinigung') }] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pruefen');
  assert.equal(r.body.mail, null);
  const v5 = r.body.vorgang as number;
  const dok5 = r.body.dokumente[0].id as number;
  const vorher = mock.docs.size;

  r = await admin('GET', `${E}/vorgaenge?status=offen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.offen, { pruefen: 1, fehler: 0 });
  const zeile = r.body.vorgaenge[0];
  assert.equal(zeile.id, v5);
  assert.equal(zeile.mitglied_adrnr, '0000000101');
  assert.match(zeile.dokumente[0].hinweis, /Testlauf: Regel „Mitglieder-Post“/);
  assert.equal(zeile.dokumente[0].zuordnung.zuordnung.correspondent, 'Müller Hans');
  assert.equal(zeile.dokumente[0].vorhanden, true);
  assert.equal((await admin('GET', `${E}/vorgaenge/${v5}/text`)).body.text, 'Hallo, anbei die Bescheinigung.');
  const datei5 = await admin('GET', `${E}/dokumente/${dok5}/datei`);
  assert.equal(datei5.status, 200);
  assert.match(datei5.ct, /application\/pdf/);
  assert.match(String(datei5.headers['content-security-policy']), /sandbox/);

  // Ablage mit der vorgeschlagenen Regel, E-Mail nur als gelesen markieren
  r = await admin('POST', `${E}/dokumente/${dok5}/ablegen`, { regel_id: ids.mitglied, mail: { art: 'keine', gelesen: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'abgelegt');
  assert.equal(mock.docs.size, vorher + 1);
  const letzte = [...mock.docs.values()].pop()!;
  assert.equal(letzte.title, 'bescheinigung');
  assert.equal(mock.korr.find((k) => String(k.id) === letzte.correspondent)?.name, 'Müller Hans');
  assert.equal((await admin('POST', `${E}/dokumente/${dok5}/ablegen`, { regel_id: ids.mitglied })).status, 400, 'bereits erledigt');
  assert.equal((await admin('GET', `${E}/dokumente/${dok5}/datei`)).status, 404, 'Datei liegt nicht mehr im Portal');
  r = await ext(key, 'POST', `${E}/abgleich`, { postfach: 'info@tc-test.de', mails: [{ message_id: '<m5@e>', uid: 15 }] });
  assert.deepEqual(r.body.aktionen.map((a: any) => [a.vorgang, a.art, a.gelesen]), [[v5, 'keine', true]]);

  // unbekannter Absender mit Anhang: Prüfliste ohne Vorschlag → von Hand ablegen
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'buero@partner.example', betreff: 'Vertrag', message_id: '<m6@p>', anhaenge: [
    { name: 'vertrag.pdf', mime: 'application/pdf', inhalt: b64('%PDF Vertrag') }, { name: 'anlage.html', mime: 'text/html', inhalt: b64('<script>alert(1)</script>') }] }));
  assert.equal(r.body.status, 'pruefen');
  const [a, b] = r.body.dokumente.map((d: any) => d.id as number);
  const v6 = r.body.vorgang as number;
  assert.equal((await admin('POST', `${E}/dokumente/${a}/ablegen`, {})).status, 400, 'ohne Regel und ohne Angaben');
  r = await admin('POST', `${E}/dokumente/${a}/ablegen`, { paperless: { titel: 'Vertrag {von_name}', dokumenttyp: 'Abrechnung' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pruefen', 'zweites Dokument noch offen');
  assert.equal([...mock.docs.values()].pop()!.title, 'Vertrag buero@partner.example');
  // fremdes HTML wird nie im Browser angezeigt
  const dateiB = await admin('GET', `${E}/dokumente/${b}/datei`);
  assert.match(dateiB.ct, /application\/octet-stream/);
  assert.match(String(dateiB.headers['content-disposition']), /^attachment/);
  r = await admin('POST', `${E}/dokumente/${b}/ignorieren`);
  assert.equal(r.body.status, 'abgelegt');
  const [s6] = await sql`select status, text, mail_aktion from tco.eing_vorgaenge where id = ${v6}`;
  assert.deepEqual({ ...s6 }, { status: 'abgelegt', text: null, mail_aktion: null });

  // Paperless-Fehler: Vorgang „fehler“, Inhalt bleibt; neue Regel + neu bewerten legt ab
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'buero@partner.example', betreff: 'Nachtrag', message_id: '<m7@p>', uid: 17, anhaenge: [{ name: 'kaputt.pdf', mime: 'application/pdf', inhalt: b64('%PDF Nachtrag') }] }));
  const v7 = r.body.vorgang as number;
  assert.equal(r.body.status, 'pruefen');
  r = await admin('POST', `${E}/regeln`, regel({ name: 'Partner', prioritaet: 40, bedingungen: [bed('domain', 'ist', 'partner.example')],
    aktionen: { paperless: { aktiv: true, titel: 'Partner {datei|ohneEndung}' }, mail: { art: 'loeschen' } } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${E}/vorgaenge/${v7}/neu-bewerten`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'fehler');
  r = await admin('GET', `${E}/vorgaenge?status=fehler`);
  assert.match(r.body.vorgaenge[0].dokumente[0].hinweis, /HTTP 500/);
  assert.equal(r.body.vorgaenge[0].dokumente[0].vorhanden, true);
  assert.equal((await ext(key, 'GET', `${E}/vorgaenge/${v7}`)).body.mail, null, 'keine Mailaktion, solange die Ablage fehlt');
  mock.kaputt = false;
  r = await admin('POST', `${E}/vorgaenge/${v7}/neu-bewerten`);
  assert.equal(r.body.status, 'abgelegt');
  r = await ext(key, 'GET', `${E}/vorgaenge/${v7}`);
  assert.deepEqual(r.body.mail, { art: 'loeschen', ordner: '', gelesen: false, quelle: 'INBOX', uid: '17' });
  assert.equal([...mock.docs.values()].pop()!.title, 'Partner kaputt');

  // Vorgang ohne Ablage schließen; verwerfen = wird neu eingelesen
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'x@unbekannt.example', betreff: 'Flyer', message_id: '<m8@u>', anhaenge: [{ name: 'flyer.pdf', mime: 'application/pdf', inhalt: b64('%PDF Flyer') }] }));
  const v8 = r.body.vorgang as number;
  r = await admin('POST', `${E}/vorgaenge/${v8}/ignorieren`);
  assert.equal(r.body.status, 'ignoriert');
  assert.equal((await admin('DELETE', `${E}/vorgaenge/${v8}`)).status, 200);
  r = await ext(key, 'POST', `${E}/abgleich`, { postfach: 'info@tc-test.de', mails: [{ message_id: '<m8@u>' }] });
  assert.equal(r.body.neu.length, 1);

  // Trefferzahl und Version der Regeln
  r = await admin('PUT', `${E}/regeln/${ids.mitglied}`, regel({ name: 'Mitglieder-Post', status: 'aktiv', prioritaet: 30, bedingungen: [bed('mitglied', 'ist', 'ja')],
    aktionen: { paperless: { aktiv: true, titel: '{datei|ohneEndung}', korrespondent: '{mitglied}' } } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('GET', `${E}/regeln`);
  const m = r.body.find((x: any) => x.id === ids.mitglied);
  assert.deepEqual([m.status, m.version, m.treffer], ['aktiv', 2, 1]);
  const belege = await sql`select count(*)::int as n from core.change_header where object_type = 'EING_REGEL'`;
  assert.ok(belege[0].n >= 5, 'Änderungsbelege für Regeln');
});

test('Berechtigungen: Anzeigen sieht keine Inhalte und pflegt nichts', async () => {
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'EINGLESER', name: 'Eingang lesen', permissions: ['tco.eingang:display'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['EINGLESER'] })).status, 200);
  const leser = client();
  await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' });
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort-1' })).status, 200);
  let r = await leser('GET', `${E}/vorgaenge`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.vorgaenge.length >= 6);
  assert.ok(r.body.vorgaenge.every((v: any) => !('text' in v) && v.dokumente.every((d: any) => !('inhalt' in d))));
  assert.equal((await leser('GET', `${E}/vorgaenge/${r.body.vorgaenge[0].id}/text`)).status, 403);
  assert.equal((await leser('POST', `${E}/regeln`, regel({ name: 'x', bedingungen: [bed('von', 'ist', 'a@b.de')] }))).status, 403);
  assert.equal((await leser('POST', `${E}/vorgaenge/${r.body.vorgaenge[0].id}/ignorieren`)).status, 403);
  assert.equal((await leser('POST', `${E}/mail`, mail({ von: 'a@b.de', betreff: 'x', message_id: '<z@b>' }))).status, 403);
});

test('Rückmeldungen: Rückläufer wird im E-Mail-Protokoll verbucht und nicht abgelegt, Antwort mit Anhang geht in die Prüfliste', async () => {
  const [p] = await sql`insert into core.mail_protokoll (anwendung, objekt, an, betreff, status, message_id)
                        values ('Test', 'RG-1', 'kunde@example.org', 'Ihre Rechnung 2026_015', 'gesendet', 'gesendet-1@portal.example') returning id`;
  const vorher = mock.docs.size;
  let r = await ext(key, 'POST', `${E}/mail`, mail({
    von: 'Mail Delivery System <MAILER-DAEMON@mx.example>', betreff: 'Undelivered Mail Returned to Sender', message_id: '<bounce-1@mx.example>', uid: 21,
    text: 'This is the mail system.\n<kunde@example.org>: host mx.example said: 550 5.1.1 User unknown\n\nMessage-ID: <gesendet-1@portal.example>',
    anhaenge: [{ name: 'original.eml', mime: 'message/rfc822', inhalt: b64('From: portal\r\nSubject: Ihre Rechnung\r\n\r\n'.repeat(5)) }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'ignoriert');
  assert.deepEqual(r.body.dokumente, []);
  assert.equal(r.body.mail, null);
  assert.deepEqual({ art: r.body.rueckmeldung.art, zugeordnet: r.body.rueckmeldung.zugeordnet }, { art: 'unzustellbar', zugeordnet: true });
  assert.match(r.body.hinweis, /Unzustellbar-Meldung – im E-Mail-Protokoll verbucht/);

  r = await ext(key, 'POST', `${E}/mail`, mail({
    von: 'Kunde <kunde@example.org>', betreff: 'AW: Ihre Rechnung 2026_015', message_id: '<antwort-1@example.org>', uid: 22, in_reply_to: '<gesendet-1@portal.example>',
    anhaenge: [{ name: 'ueberweisung.pdf', mime: 'application/pdf', inhalt: b64('%PDF Überweisungsbeleg') }],
  }));
  assert.equal(r.body.rueckmeldung.art, 'antwort');
  assert.equal(r.body.status, 'pruefen', 'Anhang einer Antwort wird wie jeder andere behandelt');
  assert.match(r.body.hinweis, /Antwort auf eine E-Mail des Portals/);
  assert.equal(mock.docs.size, vorher, 'nichts automatisch abgelegt');

  const antworten = await sql`select art, grund from core.mail_antworten where protokoll_id = ${p.id} order by id`;
  assert.deepEqual(antworten.map((a) => a.art), ['unzustellbar', 'antwort']);
  assert.match(antworten[0].grund as string, /550 5\.1\.1/);

  // Abwesenheitsnotiz ohne Anhang: nicht in der Prüfliste, auch wenn sie keiner gesendeten E-Mail zuzuordnen ist
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'fremd@example.net', betreff: 'Automatische Antwort: Urlaub', message_id: '<ooo-1@example.net>', auto: 'auto-replied' }));
  assert.equal(r.body.status, 'ignoriert');
  assert.equal(r.body.rueckmeldung.zugeordnet, false);
});

test('Posteingang abrufen: offene Vorgänge neu bewerten und n8n anstoßen', async () => {
  // ohne Anbindung: nur neu bewerten
  let r = await admin('POST', `${E}/abruf`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.abruf, false);
  assert.match(r.body.text, /neu bewertet|Keine offenen Dokumente/);
  assert.match(r.body.text, /Anbindung „Maileingang jetzt abrufen \(n8n\)“ ist nicht eingerichtet/);
  assert.equal((await admin('GET', `${E}/stamm`)).body.abruf.eingerichtet, false);
  assert.equal(mock.abruf.length, 0);

  const port = (server.address() as { port: number }).port;
  await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis)
            values ('tco.mailabruf', ${`http://127.0.0.1:${port}/webhook/tco-dokumenteneingang-alle`}, 'header', 'Authorization', 'Bearer falsch')`;
  const { verbindungenCacheLeeren } = await import('../src/lib/verbindungen.js');
  verbindungenCacheLeeren();
  r = await admin('POST', `${E}/abruf`);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.message, /Abruf aus dem Postfach fehlgeschlagen: Anmeldung abgelehnt/);

  await sql`update core.verbindungen set geheimnis = 'Bearer abruf-geheim' where id = 'tco.mailabruf'`;
  verbindungenCacheLeeren();
  r = await admin('POST', `${E}/abruf`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.abruf, true);
  assert.match(r.body.text, /n8n liest den Posteingang jetzt ein/);
  assert.equal(mock.abruf.length, 1);
  assert.equal(JSON.parse(mock.abruf[0].body).alle, true);
  assert.equal((await admin('GET', `${E}/stamm`)).body.abruf.eingerichtet, true);
});

test('Custom Fields: Werte je Feldtyp für Paperless', () => {
  const f = (data_type: string, extra?: object) => ({ id: 1, name: 'F', data_type, extra_data: extra as never });
  assert.deepEqual(customFeldWert(f('monetary'), '1.234,56 €'), { ok: true, wert: 'EUR1234.56' });
  assert.deepEqual(customFeldWert(f('monetary'), 12.5), { ok: true, wert: 'EUR12.50' });
  assert.deepEqual(customFeldWert(f('monetary'), 'EUR12.50'), { ok: true, wert: 'EUR12.50' });
  assert.deepEqual(customFeldWert(f('date'), '3.11.2026'), { ok: true, wert: '2026-11-03' });
  assert.deepEqual(customFeldWert(f('boolean'), 'Ja'), { ok: true, wert: true });
  assert.deepEqual(customFeldWert(f('integer'), '4711'), { ok: true, wert: 4711 });
  assert.deepEqual(customFeldWert(f('select', { select_options: [{ id: 'x9', label: 'Beleg' }] }), 'beleg'), { ok: true, wert: 'x9' });
  assert.deepEqual(customFeldWert(f('select', { select_options: ['Alt', 'Neu'] }), 'Neu'), { ok: true, wert: 1 });
  assert.equal(customFeldWert(f('select', { select_options: ['Alt'] }), 'Fremd').ok, false);
  assert.equal(customFeldWert(f('date'), 'gestern').ok, false);
  assert.deepEqual(customFeldWert(f('string'), 'R-1'), { ok: true, wert: 'R-1' });
});

test('Zusammenfassen: passende Anhänge als ein PDF ablegen, Custom Fields, Dublette, Fehlerfall', async () => {
  let r: { status: number; body: any } = await admin('POST', `${E}/regeln`, regel({
    name: 'Sammelbelege', prioritaet: 5,
    bedingungen: [bed('domain', 'ist', 'sammel.example')],
    extraktion: [{ name: 'betrag', quelle: 'text', muster: 'Betrag:\\s*([\\d.,]+)' }],
    aktionen: {
      zusammenfassen: { aktiv: true, dateiname: '{datum}_Sammel_{anzahl}', reihenfolge: 'name' },
      paperless: { aktiv: true, titel: '{datei|ohneEndung}', felder: { Betrag: '{feld.betrag}', Art: 'Beleg' } },
      mail: { art: 'verschieben', ordner: 'Belege' },
    },
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ids.sammel = r.body.id;
  const stamm = await admin('GET', `${E}/stamm`);
  assert.deepEqual(stamm.body.paperless.felder, [{ name: 'Art', typ: 'select', optionen: ['Beleg', 'Vertrag'] }, { name: 'Betrag', typ: 'monetary', optionen: [] }]);

  const pdfB = { name: 'b.pdf', mime: 'application/pdf', inhalt: b64('%PDF Teil B') };
  const pdfA = { name: 'a.pdf', mime: 'application/pdf', inhalt: b64('%PDF Teil A') };
  const bild = { name: 'scan.jpg', mime: 'image/jpeg', inhalt: b64('x'.repeat(40_000)) };
  const vorher = mock.docs.size;
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'Belege <belege@sammel.example>', betreff: 'Belege', message_id: '<s1@sammel>', text: 'Betrag: 12,50', anhaenge: [pdfB, pdfA, bild] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'abgelegt', JSON.stringify(r.body));
  assert.equal(r.body.dokumente.length, 1);
  assert.equal(r.body.dokumente[0].datei, '2025-03-03_Sammel_3.pdf');
  assert.match(r.body.dokumente[0].hinweis, /^Zusammengefasst aus 3 Anhängen: a\.pdf, b\.pdf, scan\.jpg\./);
  assert.deepEqual(mock.merge.at(-1), ['%PDF Teil A', '%PDF Teil B', '%PDF Bildseite'], 'Reihenfolge nach Dateiname, Bild als Seite');
  assert.equal(mock.docs.size, vorher + 1);
  const id = r.body.dokumente[0].paperless_id as number;
  assert.equal(mock.docs.get(id)!.datei, '2025-03-03_Sammel_3.pdf');
  const patch = mock.patches.filter((p) => p.id === id && p.body.custom_fields).at(-1);
  assert.deepEqual([...(patch?.body.custom_fields ?? [])].sort((x: any, y: any) => x.field - y.field), [{ field: 3, value: 'EUR12.50' }, { field: 5, value: 'a1' }]);

  // dieselben Teile in einer weiteren E-Mail: Dublette, kein zweiter Upload
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'belege@sammel.example', betreff: 'Belege nochmal', message_id: '<s2@sammel>', anhaenge: [pdfA, pdfB, bild] }));
  assert.deepEqual(r.body.dokumente.map((d: any) => [d.status, d.paperless_id]), [['dublette', id]]);
  assert.equal(mock.docs.size, vorher + 1);

  // Zusammenfügen schlägt fehl: Teile einzeln in die Prüfliste, nichts abgelegt
  mock.mergeKaputt = true;
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'belege@sammel.example', betreff: 'Belege verschlüsselt', message_id: '<s3@sammel>',
    anhaenge: [{ name: 'c.pdf', mime: 'application/pdf', inhalt: b64('%PDF C') }, { name: 'd.pdf', mime: 'application/pdf', inhalt: b64('%PDF D') }] }));
  mock.mergeKaputt = false;
  assert.equal(r.body.status, 'pruefen');
  assert.deepEqual(r.body.dokumente.map((d: any) => d.status), ['pruefen', 'pruefen']);
  assert.match(r.body.dokumente[0].hinweis, /Zusammenfassen fehlgeschlagen/);
  assert.equal(mock.docs.size, vorher + 1);
});

test('Prüfliste: bestehende Regel zuordnen (je Anhang mit Zusammenfassen, E-Mail-Regel, Testlauf, Fehler)', async () => {
  // zwei Anhänge, keine Regel passt
  let r: { status: number; body: any } = await ext(key, 'POST', `${E}/mail`, mail({ von: 'kasse@zuordnen.example', betreff: 'Belege Oktober', message_id: '<z1@zu>', uid: 71,
    anhaenge: [{ name: 'z2.pdf', mime: 'application/pdf', inhalt: b64('%PDF Z2') }, { name: 'z1.pdf', mime: 'application/pdf', inhalt: b64('%PDF Z1') }] }));
  assert.equal(r.body.status, 'pruefen', JSON.stringify(r.body));
  const vz = r.body.vorgang as number;

  r = await admin('GET', `${E}/vorgaenge/${vz}/regeln`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sammel = r.body.find((x: any) => x.id === ids.sammel);
  assert.deepEqual([sammel.passt, sammel.anwendbar], [false, true], 'Bedingungen passen nicht, anwendbar ist sie trotzdem');
  assert.equal(r.body.find((x: any) => x.name === 'Werbung').anwendbar, true);

  const vorher = mock.docs.size;
  r = await admin('POST', `${E}/vorgaenge/${vz}/regel`, { regel_id: ids.sammel });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'abgelegt');
  assert.match(r.body.text, /Regel „Sammelbelege“ zugeordnet: 1 Dokument angewendet/);
  assert.deepEqual(mock.merge.at(-1), ['%PDF Z1', '%PDF Z2']);
  assert.equal(mock.docs.size, vorher + 1);
  r = await admin('GET', `${E}/vorgaenge?suche=${encodeURIComponent('Belege Oktober')}`);
  const v = r.body.vorgaenge.find((x: any) => x.id === vz);
  assert.deepEqual(v.dokumente.map((d: any) => [d.datei, d.status]), [['z2.pdf', 'ignoriert'], ['z1.pdf', 'ignoriert'], ['2025-03-03_Sammel_2.pdf', 'abgelegt']]);
  assert.deepEqual(v.mail_aktion, { art: 'verschieben', ordner: 'Belege', gelesen: false, aufgaben: [] });
  assert.match(v.hinweis, /Regel „Sammelbelege“ von Hand zugeordnet \(Admin\)/);

  // E-Mail ohne Regel und ohne Anhang: Behandlung aus einer E-Mail-Regel
  r = await ext(key, 'POST', `${E}/mail`, mail({ von: 'info@shop.example', betreff: 'Rabatt', message_id: '<z2@zu>', uid: 72 }));
  assert.equal(r.body.status, 'ohne_regel');
  const vo = r.body.vorgang as number;
  const werbung = (await admin('GET', `${E}/regeln`)).body.find((x: any) => x.name === 'Werbung');
  r = await admin('POST', `${E}/vorgaenge/${vo}/regel`, { regel_id: werbung.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'abgelegt');
  r = await ext(key, 'GET', `${E}/mailaktionen`);
  assert.deepEqual(r.body.filter((a: any) => a.vorgang === vo).map((a: any) => [a.art, a.ordner, a.uid]), [['verschieben', 'Werbung', '72']]);

  // ausstehende Behandlung ändern (falscher Zielordner), danach ausgeführt: keine Änderung mehr
  r = await admin('PUT', `${E}/vorgaenge/${vo}/mail`, { mail: { art: 'verschieben', ordner: 'INBOX.Belege.SumUp', gelesen: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await ext(key, 'GET', `${E}/mailaktionen`);
  assert.deepEqual(r.body.filter((a: any) => a.vorgang === vo).map((a: any) => [a.art, a.ordner, a.gelesen]), [['verschieben', 'INBOX.Belege.SumUp', true]]);
  assert.equal((await admin('PUT', `${E}/vorgaenge/${vo}/mail`, { mail: { art: 'verschieben' } })).status, 400, 'Zielordner fehlt');
  assert.equal((await ext(key, 'POST', `${E}/vorgaenge/${vo}/mail-erledigt`)).status, 200);
  r = await admin('PUT', `${E}/vorgaenge/${vo}/mail`, { mail: null });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits ausgeführt/);

  // Testlauf-Regel je Anhang auf einen Vorgang ohne Anhang: abgelehnt
  r = await admin('POST', `${E}/vorgaenge/${vo}/regel`, { regel_id: ids.mitglied });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /keine offenen Anhänge/);
  assert.equal((await admin('POST', `${E}/vorgaenge/${vo}/regel`, { regel_id: 99999 })).status, 404);
});

