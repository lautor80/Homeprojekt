/**
 * Euroflex Posteingang (Outlook 365 → n8n → Portal): Zuordnung (reine Logik) und – mit Datenbank – Schnittstelle für n8n,
 * Idempotenz, automatische Ablage (lokal und Paperless), Prüfliste, Dubletten, Übernahme in den Ablageordner, Speicher,
 * „Jetzt abrufen“ und Rechte. Paperless, Gotenberg und n8n sind nachgestellt.
 *   reine Tests:  tsx --test server/test/transport_eingang.test.ts
 *   alle Tests:   TEST_DATABASE_URL=postgres://portal:portal@localhost:5432/portal_test npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as L from '../../modules/transport/server/eingang/logik.js';

const url = process.env.TEST_DATABASE_URL;
const mitDb = !!url && /test/i.test(url.split('/').pop() ?? '');
const ohneDb = { skip: mitDb ? false : 'TEST_DATABASE_URL fehlt – nur reine Tests' };

// ---------------------------------------------------------------- reine Logik
test('Auftragsnummern: Schreibweisen, Wortgrenze, Normalisierung', () => {
  assert.deepEqual(L.auftragsnummernFinden('AW: Lieferschein 2026_0153'), ['2026_0153']);
  assert.deepEqual(L.auftragsnummernFinden('Auftrag 2026-0153 und 2026/0154, Ref 20260155.'), ['2026_0153', '2026_0154', '2026_0155']);
  assert.deepEqual(L.auftragsnummernFinden('Lieferschein_2026_0153.pdf', 'Transportauftrag_2026_0153-2.pdf'), ['2026_0153']);
  assert.deepEqual(L.auftragsnummernFinden('X2026_0153 12026_0153 2026_01534 202601531 LS20260153 2026-11-17'), [], 'nur mit Wortgrenze');
  assert.deepEqual(L.auftragsnummernFinden(null, undefined, ''), []);
});

test('Referenzen, Message-IDs, Objekt aus dem Protokoll', () => {
  assert.equal(L.referenzImText('Ihre Bestellung PO-4711 vom', 'po-4711'), true);
  assert.equal(L.referenzImText('Ihre Bestellung PO-47112', 'PO-4711'), false, 'Wortgrenze');
  assert.equal(L.referenzImText('Rechnung 123 anbei', '123'), false, 'mindestens 4 Zeichen');
  assert.equal(L.referenzImText('Lade  nummer  LN 7788', 'LN 7788'), true, 'Leerraum egal');
  assert.equal(L.referenzTauglich('0000'), false);
  assert.equal(L.referenzTauglich('FOLGT'), false, 'Platzhalter ohne Ziffer');
  assert.equal(L.referenzTauglich('Muster'), false);
  assert.equal(L.referenzImText('Ihre Bestellung folgt in Kürze', 'FOLGT'), false);
  assert.equal(L.referenzTauglich('PO-1'), true);
  assert.deepEqual(L.messageIds('<A@B.de>', '<x@y> <A@b.de>, ohne-at'), ['a@b.de', 'x@y']);
  assert.equal(L.objektAuftrag('2026_0153-2'), '2026_0153');
  assert.equal(L.objektAuftrag('2026_0153'), '2026_0153');
  assert.equal(L.objektAuftrag('PRUEFEN'), null);
});

test('Nummernsuche: alle Fundstellen (Betreff, Mailtext, Dateiname, Texterkennung) und Vorrang vor schwachen Treffern', () => {
  const q = L.suchQuellen({
    betreff: 'AW: Rechnung 2099-0153', text: 'Anbei die Rechnung.', dateien: ['Rechnung_2099_0153.pdf', 'agb.pdf'],
    ocr: [{ datei: 'Rechnung_2099_0153.pdf', text: 'Rechnungsnummer: 2099_0153' }, { datei: 'agb.pdf', text: 'Allgemeine Bedingungen' }],
  });
  assert.deepEqual(L.herkunftNummer(q, '2099_0153'), [
    'Betreff: „AW: Rechnung 2099-0153“', 'Dateiname „Rechnung_2099_0153.pdf“', 'PDF „Rechnung_2099_0153.pdf“ (Texterkennung): „Rechnungsnummer: 2099_0153“',
  ]);
  assert.equal(L.herkunftText(['Betreff: „x“', 'Mailtext: „y“']), 'Herkunft: Betreff: „x“; Mailtext: „y“');
  // Texterkennung: nur JJJJ_NNNN mit Unterstrich – Leerzeichen, Bindestrich, Schrägstrich oder kompakt werden nicht angeboten
  assert.deepEqual(L.ocrAuftragsnummern('Rechnung Nr. 2099 9104, Auftrag 2099 _ 0153, 2099-0154, 2099/0155, 20990156, PLZ 2099 12345'), []);
  assert.deepEqual(L.ocrAuftragsnummern('Nr. 2099_9104 und X2099_0153, 2099_01534, Fahrt 2099_0157-2, wieder 2099_9104'), ['2099_9104', '2099_0157']);
  const ocr = L.suchQuellen({ betreff: '', text: 'Tel. 2099 9104', dateien: [], ocr: [{ datei: 's.png', text: 'Kopf\nIhre Referenz  2099 9104 vom 17.11.' }] });
  assert.deepEqual(L.quellenNummern(...ocr), [], 'Leerzeichen statt Unterstrich zählt weder im OCR-Text noch im Mailtext');
  assert.deepEqual(L.herkunftNummer(ocr, '2099_9104'), []);
  const ocr2 = L.suchQuellen({ betreff: '', text: '', dateien: [], ocr: [{ datei: 's.png', text: 'Ref 2099 9105 und 2099-9105\nAuftrag 2099_9105 vom 17.11.' }] });
  assert.deepEqual(L.quellenNummern(...ocr2), ['2099_9105']);
  assert.deepEqual(L.herkunftNummer(ocr2, '2099_9105'), ['Dokument „s.png“ (Texterkennung): „Ref 2099 9105 und 2099-9105 Auftrag 2099_9105 vom 17.11.“']);
  // Betreff, Mailtext und Dateiname behalten alle Schreibweisen
  assert.deepEqual(L.quellenNummern(...L.suchQuellen({ betreff: 'Auftrag 2099-0160', text: 'Ref 20990161', dateien: [], ocr: [{ datei: 'x.pdf', text: '2099-0162' }] })), ['2099_0160', '2099_0161']);
  assert.equal(L.ausschnitt('x'.repeat(100) + ' 2099_0153 ' + 'y'.repeat(100), 101, 110), `…${'x'.repeat(39)} 2099_0153 ${'y'.repeat(39)}…`);
  assert.deepEqual(L.herkunftReferenz(L.suchQuellen({ betreff: '', text: 'Bitte Order PO-4711 beachten', dateien: [], ocr: [] }), 'po-4711'), ['Mailtext: „Bitte Order PO-4711 beachten“']);
  assert.deepEqual(L.herkunftReferenz(q, 'PO-4711'), []);
  // JJJJMMTT im Dateinamen ist ein Datum, keine Auftragsnummer
  assert.deepEqual(L.auftragsnummernFinden('503_20261117_05032615464.PDF'), []);
  assert.deepEqual(L.auftragsnummernFinden('Ref 20261351 und 2026_1117'), ['2026_1117', '2026_1351']);
  assert.equal(L.istDatumMmTt('1117'), true);
  assert.equal(L.istDatumMmTt('1351'), false);

  const t: L.Treffer[] = [
    { auftragsnr: '2099_0153', art: 'nummer', punkte: 90, grund: 'Nr' },
    { auftragsnr: '2099_0153', art: 'absender', punkte: 30, grund: 'Absender' },
    { auftragsnr: '2099_0001', art: 'referenz', punkte: 70, grund: 'Ordernummer' },
    { auftragsnr: '2099_0002', art: 'absender', punkte: 30, grund: 'Absender' },
  ];
  assert.deepEqual(L.nummernVorrang(t).map((x) => [x.auftragsnr, x.art]), [['2099_0153', 'nummer'], ['2099_0153', 'absender']]);
  const ohne = t.filter((x) => x.art !== 'nummer');
  assert.deepEqual(L.nummernVorrang(ohne), ohne, 'ohne Nummer bleiben alle Treffer');
});

test('Texterkennung: gescanntes PDF ohne Textebene wird per pdftoppm + tesseract gelesen', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const da = (p: string) => { try { execFileSync('which', [p], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (!da('pdftoppm') || !da('tesseract')) return t.skip('pdftoppm oder tesseract fehlt');
  const { readFileSync } = await import('node:fs');
  const { pdfScanText, pdfText } = await import('../src/lib/texterkennung.js');
  const scan = readFileSync(new URL('./fixtures/eingang-scan.pdf', import.meta.url));
  assert.equal((await pdfText(scan)).trim(), '', 'keine Textebene');
  const text = await pdfScanText(scan);
  assert.match(text, /2099\s+9104/, text);
  assert.deepEqual(L.ocrAuftragsnummern(text), [], 'Leerzeichen statt Unterstrich wird nicht angeboten');
});

test('Punkte je Auftrag: Merkmale addiert, höchstens 100, je Merkmal einmal', () => {
  const k = L.bewerten([
    { auftragsnr: '2026_0001', art: 'nummer', punkte: 90, grund: 'Nr im Betreff' },
    { auftragsnr: '2026_0001', art: 'nummer', punkte: 90, grund: 'Nr im Dateinamen' },
    { auftragsnr: '2026_0001', art: 'absender', punkte: 30, grund: 'Absender' },
    { auftragsnr: '2026_0002', art: 'referenz', punkte: 70, grund: 'Ordernummer' },
    ...L.absenderTreffer(['2026_0002'], 'a@b.de'),
  ]);
  assert.deepEqual(k.map((x) => [x.auftragsnr, x.punkte, x.gruende.length]), [['2026_0002', 100, 2], ['2026_0001', 100, 2]], 'Gleichstand: neuere Nummer zuerst');
  assert.equal(k[1].gruende[0].grund, 'Nr im Betreff');
  assert.deepEqual(L.absenderTreffer(['a', 'b'], 'x@y.de').map((t) => t.punkte), [30, 30]);
  assert.deepEqual(L.absenderTreffer(['a'], 'x@y.de').map((t) => t.punkte), [50]);
});

test('Entscheidung: nie automatisch ablegen – eindeutig ab Schwelle ist ein Vorschlag zur Bestätigung', () => {
  const k = (nr: string, punkte: number): L.Kandidat => ({ auftragsnr: nr, punkte, gruende: [{ grund: 'x', punkte }] });
  const sicher = L.entscheiden([k('A', 90), k('B', 30)], 80);
  assert.deepEqual([sicher.status, sicher.auftragsnr, sicher.eindeutig], ['pruefen', 'A', true]);
  assert.match(sicher.hinweis ?? '', /bitte die Ablage bestätigen/);
  const unter = L.entscheiden([k('A', 70)], 80);
  assert.deepEqual([unter.status, unter.auftragsnr], ['pruefen', 'A'], 'Vorschlag bleibt stehen');
  assert.match(unter.hinweis ?? '', /unter der Schwelle/);
  const gleich = L.entscheiden([k('A', 30), k('B', 30)], 20);
  assert.deepEqual([gleich.status, gleich.auftragsnr, gleich.eindeutig], ['pruefen', null, false]);
  assert.match(gleich.hinweis ?? '', /Nicht eindeutig/);
  assert.deepEqual(L.entscheiden([], 80).status, 'pruefen');
});

test('Anhangfilter, Dateiname der E-Mail, Speicherwarnung', () => {
  assert.equal(L.relevanterAnhang({ name: 'logo.png', mime: 'image/png', groesse: 5000 }), false);
  assert.equal(L.relevanterAnhang({ name: 'termin.ics', mime: 'text/calendar', groesse: 5000 }), false);
  assert.equal(L.relevanterAnhang({ name: 'smime.p7s', mime: 'application/pkcs7-signature', groesse: 5000 }), false);
  assert.equal(L.relevanterAnhang({ name: 'CMR.pdf', mime: 'application/pdf', groesse: 5000 }), true);
  assert.equal(L.mailDateiname('2026-11-17', 'AW: Lieferschein 2026_0153'), '2026-11-17 AW Lieferschein 2026_0153.pdf');
  assert.equal(L.mailDateiname('2026-11-17', ''), '2026-11-17 E-Mail.pdf');
  assert.equal(L.speicherWarnung(1024 * 1024 * 11, 10), true);
  assert.equal(L.speicherWarnung(1024 * 1024 * 10, 10), false);
});

// ---------------------------------------------------------------- mit Datenbank
type Db = typeof import('../src/db.js');
let sql: Db['sql'];
let app: Awaited<ReturnType<typeof import('../src/app.js')['buildApp']>>;
let cacheLeeren: () => void;
let cookie = '';
let key = '';
let port = 0;
const T = '/api/m/transport';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

async function admin(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') && res.body ? JSON.parse(res.body) : res.body, headers: res.headers };
}
/** Aufruf wie n8n: nur Bearer, kein Cookie */
async function ext(k: string, method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { authorization: `Bearer ${k}` } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const mock = { docs: [] as string[], next: 900, abruf: [] as { key: string; body: string }[] };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = decodeURIComponent(req.url ?? '');
    if (u === '/forms/chromium/convert/html') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(`%PDF-1.4 Mail ${mock.next++}`); }
    if (u === '/webhook/euroflex-maileingang-abruf') {
      if (req.headers['x-euroflex-key'] !== 'k') return send(403, { message: 'Authorization data is wrong!' });
      mock.abruf.push({ key: String(req.headers['x-euroflex-key']), body });
      return send(200, { message: 'Workflow was started' });
    }
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    if (u === '/api/documents/post_document/') {
      mock.docs.push(/filename="([^"]+)"/.exec(body)?.[1] ?? '');
      return send(200, `task-${mock.next++}`);
    }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (req.method === 'GET' && /^\/api\/\w+\/(\?|$)/.test(u)) return send(200, { results: [], next: null });
    if (req.method === 'POST' && /^\/api\/(correspondents|tags|document_types|storage_paths)\/$/.test(u)) return send(201, { id: 40 + mock.next, name: JSON.parse(body).name });
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) return send(200, { id: Number(m[1]), custom_fields: [], notes: [] });
    send(200, {});
  });
});

const mail = (m: Record<string, unknown>) => ({
  postfach: 'Auftraege@euroflex-eingang.test', graph_id: 'AAMk', an: 'auftraege@euroflex-eingang.test', datum: '2026-11-17T06:12:00Z',
  von: 'Jemand <jemand@fremd-eingang.test>', text: 'Guten Tag, anbei die Unterlagen.', html: '', anhaenge: [], ...m,
});
const pdf = (name: string, inhalt: string) => ({ name, mime: 'application/pdf', inhalt: b64(`%PDF-1.4 ${inhalt}`) });
const einstellen = (e: Record<string, unknown>) => sql`
  update transport.workflow_einstellungen set eingang = ${sql.json({ ocr: false, ...e } as never)} where id = 1`;
const docs = (vorgang: number) => sql`select datei, art, status, ziel, inhalt is not null as inhalt, paperless_id from transport.eing_dokumente where vorgang_id = ${vorgang} order by id`;

before(async () => {
  if (!mitDb) return;
  process.env.DATABASE_URL = url;
  process.env.PORTAL_MODULES = 'transport';
  ({ sql } = await import('../src/db.js'));
  const { migrate } = await import('../src/migrate.js');
  const { activeModules } = await import('../src/modules.js');
  const { buildApp } = await import('../src/app.js');
  const { config } = await import('../src/config.js');
  cacheLeeren = (await import('../src/lib/verbindungen.js')).verbindungenCacheLeeren;
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'Euroflex', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  config.gotenbergUrl = `http://127.0.0.1:${port}`;

  await sql`insert into transport.adressen (adrnr, kundenname, email) values
              (990001, 'Holz Eingang GmbH', 'Einkauf@kunde-eingang.test; dispo@kunde-eingang.test'),
              (990002, 'Spedition Eingang', 'fahrer@spedition-eingang.test')`;
  await sql`insert into transport.auftraege (auftragsnr, kunde, unternehmer, ordernummer) values
              ('2099_9001', 990001, 990002, 'PO-99001'), ('2099_9002', 990001, null, null)`;
  await sql`insert into transport.auftraege (auftragsnr, kunde, faktura, fakturadatum) values ('2099_9003', 990002, 'R2099-95001', current_date)`;
  await sql`insert into transport.auftraege (auftragsnr, kunde, abgeschlossen_am) values ('2099_9005', 990001, current_date)`;
  await sql`insert into transport.stops (auftragsnr, pos, ladenummer) values ('2099_9003', 1, 'LN-77881')`;
  await sql`insert into core.mail_protokoll (anwendung, objekt, an, betreff, status, message_id) values ('Euroflex', '2099_9002-2', 'x@y.de', 'Transportauftrag', 'gesendet', 'out-1@portal.test')`;
  await einstellen({});
  const r = await admin('POST', '/api/admin/api-keys', { module: 'transport', name: 'n8n-maileingang', permissions: ['transport.eingang:execute'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  key = r.body.key;
});
after(async () => {
  if (!mitDb) return;
  await app?.close();
  await sql.end();
  server.close();
});

test('n8n: Auftragsnummer → Vorschlag, Bestätigung legt lokal ab, Logo gefiltert, Wiederholung „doppelt“', ohneDb, async () => {
  const r = await ext(key, 'POST', `${T}/eingang/mail`, mail({
    message_id: '<M1@Kunde-Eingang.test>', betreff: 'AW: Lieferschein 2099_9001',
    anhaenge: [pdf('Scan.pdf', 'Lieferschein unterschrieben'), { name: 'logo.png', mime: 'image/png', inhalt: b64('klein') }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // nie automatisch: eindeutiger Treffer über der Schwelle bleibt ein Vorschlag in der Prüfliste
  assert.deepEqual({ ...r.body, vorgang: 0 }, { vorgang: 0, status: 'pruefen', auftragsnr: '2099_9001', aktion: { ordner: null, gelesen: true } });
  const v1 = r.body.vorgang as number;
  assert.deepEqual((await docs(v1)).map((d) => [d.datei, d.art, d.status, d.ziel, d.inhalt]),
    [['Scan.pdf', 'anhang', 'neu', null, true], ['2026-11-17 AW Lieferschein 2099_9001.pdf', 'mail', 'neu', null, true]]);
  let [v] = await sql`select postfach, message_id, punkte, text, abgeschlossen_am is not null as fertig, begruendung, hinweis from transport.eing_vorgaenge where id = ${v1}`;
  assert.deepEqual([v.postfach, v.message_id, v.punkte, v.text, v.fertig], ['auftraege@euroflex-eingang.test', 'm1@kunde-eingang.test', 90, 'Guten Tag, anbei die Unterlagen.', false]);
  assert.equal(v.begruendung[0].grund, 'Auftragsnummer 2099_9001 – Herkunft: Betreff: „AW: Lieferschein 2099_9001“');
  assert.match(v.hinweis, /bitte die Ablage bestätigen/);

  // Bestätigen: ohne Auswahl alle offenen Dokumente
  const b = await admin('POST', `${T}/eingang/vorgaenge/${v1}/ablegen`, { auftragsnr: '2099_9001' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.status, 'abgelegt');
  assert.deepEqual((await docs(v1)).map((d) => [d.status, d.ziel]), [['wartet', 'lokal'], ['wartet', 'lokal']]);
  [v] = await sql`select text, abgeschlossen_am is not null as fertig, abgelegt_von from transport.eing_vorgaenge where id = ${v1}`;
  assert.deepEqual([v.text, v.fertig, v.abgelegt_von], [null, true, 'Admin']);
  const liste = await admin('GET', `${T}/eingang/vorgaenge?status=abgelegt`);
  assert.equal(liste.body.vorgaenge.find((x: any) => x.id === v1).abgelegt_von, 'Admin', 'Kennzeichnung in der Liste');

  // erneute Lieferung: „doppelt“ – nie verschieben, nur als gelesen markieren
  const n = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m1@kunde-eingang.test>', betreff: 'egal' }));
  assert.deepEqual(n.body, { vorgang: v1, status: 'doppelt', auftragsnr: '2099_9001', aktion: { ordner: null, gelesen: true } });
});

test('n8n: Absender mit zwei offenen Aufträgen → Prüfliste; Antwort auf eigene Mail → 100; Referenz unter Schwelle', ohneDb, async () => {
  let r = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m2@k>', von: 'Einkauf <einkauf@kunde-eingang.test>', betreff: 'Frage', anhaenge: [pdf('a.pdf', 'A')] }));
  assert.deepEqual([r.body.status, r.body.auftragsnr, r.body.aktion.ordner], ['pruefen', null, null]);
  const [v2] = await sql`select kandidaten, hinweis, text from transport.eing_vorgaenge where id = ${r.body.vorgang}`;
  assert.deepEqual(v2.kandidaten.map((k: L.Kandidat) => [k.auftragsnr, k.punkte]), [['2099_9002', 30], ['2099_9001', 30]], 'abgeschlossener Auftrag 2099_9005 zählt nicht');
  assert.match(v2.hinweis, /Nicht eindeutig/);
  assert.equal(v2.text, 'Guten Tag, anbei die Unterlagen.');

  r = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m3@k>', in_reply_to: '<OUT-1@portal.test>', betreff: 'AW: Transportauftrag', anhaenge: [pdf('cmr.pdf', 'CMR')] }));
  assert.deepEqual([r.body.status, r.body.auftragsnr], ['pruefen', '2099_9002']);
  assert.equal((await admin('POST', `${T}/eingang/vorgaenge/${r.body.vorgang}/ablegen`, { auftragsnr: '2099_9002' })).body.status, 'abgelegt');

  r = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m4@k>', betreff: 'Ladung', text: 'Bitte Ladenummer LN-77881 beachten.', anhaenge: [pdf('b.pdf', 'B')] }));
  assert.deepEqual([r.body.status, r.body.auftragsnr], ['pruefen', '2099_9003'], 'Vorschlag unter der Schwelle');
  const v4 = r.body.vorgang as number;

  // Prüfliste und Detail
  let l = await admin('GET', `${T}/eingang/vorgaenge?status=pruefen`);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.schwelle, 80);
  assert.ok(l.body.letzter_abruf);
  assert.ok(l.body.vorgaenge.some((x: any) => x.id === v4 && x.anzahl_dokumente === 2 && x.anzahl_kandidaten === 1 && x.punkte === 70));
  const d = await admin('GET', `${T}/eingang/vorgaenge/${v4}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.kandidaten[0].kunde, 'Spedition Eingang');
  assert.match(d.body.kandidaten[0].begruendung[0].grund, /Ladenummer LN-77881/);
  const dok = d.body.dokumente.find((x: any) => x.art === 'anhang');

  // von Hand ablegen
  r = await admin('POST', `${T}/eingang/vorgaenge/${v4}/ablegen`, { auftragsnr: '2099_9003', dokumente: [dok.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pruefen', 'die E-Mail als PDF ist noch offen');
  assert.ok(r.body.text);
  r = await admin('POST', `${T}/eingang/vorgaenge/${v4}/ignorieren`);
  assert.equal(r.body.status, 'abgelegt');
  assert.deepEqual((await docs(v4)).map((x) => [x.status, x.inhalt]), [['wartet', true], ['ignoriert', false]]);
  // an einen anderen Auftrag geht nichts mehr
  l = await admin('GET', `${T}/eingang/vorgaenge?status=pruefen`);
  const v2id = l.body.vorgaenge.find((x: any) => x.betreff === 'Frage').id;
  const hinweis = () => sql`select count(*)::int as n from core.hinweise where modul = 'transport' and quelle = 'EINGANG_PRUEFEN' and objekt = ${String(v2id)} and erledigt_am is null`;
  assert.equal((await hinweis())[0].n, 1, 'zu prüfende E-Mail steht im Arbeitsvorrat');
  r = await admin('POST', `${T}/eingang/vorgaenge/${v2id}/ignorieren`);
  assert.equal(r.body.status, 'ignoriert');
  assert.equal((await hinweis())[0].n, 0, 'Hinweis mit dem Abschluss behoben');
  assert.equal((await admin('POST', `${T}/eingang/vorgaenge/${v2id}/neu-bewerten`)).status, 400);
});

test('Dublette, Eingang am Auftrag, Datei, Übernahme, Speicher', ohneDb, async () => {
  let r = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m5@k>', betreff: 'nochmal 2099-9001', anhaenge: [pdf('Scan2.pdf', 'Lieferschein unterschrieben')] }));
  assert.equal(r.body.status, 'pruefen');
  assert.equal((await admin('POST', `${T}/eingang/vorgaenge/${r.body.vorgang}/ablegen`, { auftragsnr: '2099_9001' })).body.status, 'abgelegt');
  assert.deepEqual((await docs(r.body.vorgang)).map((d) => [d.datei, d.status, d.inhalt]).slice(0, 1), [['Scan2.pdf', 'dublette', true]], 'Dublette bleibt herunterladbar (dauerhafte Aufbewahrung)');

  const s0 = (await admin('GET', `${T}/eingang/speicher`)).body;
  assert.equal(s0.warnung, false);
  assert.ok(s0.dateien > 0 && s0.bytes > 0);
  const liste = await admin('GET', `${T}/auftraege/2099_9001/eingang`);
  assert.equal(liste.status, 200, JSON.stringify(liste.body));
  // Scan.pdf und die beiden E-Mails als PDF (Scan2.pdf ist die Dublette)
  assert.deepEqual(liste.body.map((x: any) => [x.datei, x.status]), [
    ['Scan.pdf', 'wartet'], ['2026-11-17 AW Lieferschein 2099_9001.pdf', 'wartet'], ['2026-11-17 nochmal 2099-9001.pdf', 'wartet']]);
  const id = liste.body[0].id as number;
  const f = await admin('GET', `${T}/eingang/dokumente/${id}/datei`);
  assert.equal(f.status, 200);
  assert.match(String(f.headers['content-security-policy']), /sandbox/);
  assert.equal(f.body, '%PDF-1.4 Lieferschein unterschrieben');
  // der Browser meldet den Namen im Ablageordner (bei gleichnamigen Dateien „Scan (2).pdf“) – kein Pfad erlaubt
  assert.equal((await admin('POST', `${T}/eingang/dokumente/${id}/uebernommen`, { ablage_name: '../Scan.pdf' })).status, 400);
  r = await admin('POST', `${T}/eingang/dokumente/${id}/uebernommen`, { ablage_name: 'Scan (2).pdf' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await admin('GET', `${T}/auftraege/2099_9001/eingang`)).body.map((x: any) => [x.status, x.ablage_name]).slice(0, 2),
    [['uebernommen', 'Scan (2).pdf'], ['wartet', null]]);
  assert.equal((await admin('POST', `${T}/eingang/dokumente/${id}/uebernommen`)).body.status, 'uebernommen', 'wiederholbar');
  // Inhalt bleibt nach der Übernahme aufbewahrt (Standard dauerhaft) – Herunterladen und „Erneut ablegen“
  const f2 = await admin('GET', `${T}/eingang/dokumente/${id}/datei`);
  assert.equal(f2.status, 200, 'nach der Übernahme aufbewahrt');
  assert.equal(f2.body, '%PDF-1.4 Lieferschein unterschrieben');
  assert.equal((await admin('GET', `${T}/auftraege/2099_9001/eingang`)).body[0].vorhanden, true);
  // erneut ablegen meldet den (neuen) Namen im Ordner nach
  r = await admin('POST', `${T}/eingang/dokumente/${id}/uebernommen`, { ablage_name: 'Scan.pdf' });
  assert.equal(r.body.status, 'uebernommen');
  assert.equal((await admin('GET', `${T}/auftraege/2099_9001/eingang`)).body[0].ablage_name, 'Scan.pdf');
  const s1 = (await admin('GET', `${T}/eingang/speicher`)).body;
  assert.equal(s1.dateien, s0.dateien - 1, 'aufbewahrte zählen nicht als wartend');
  assert.equal(s1.aufbewahrtDateien, 2, 'übernommene Datei und Dublette');
  assert.equal(s1.aufbewahrenDauerhaft, true);
  // dauerhaft: auch nach langer Zeit nicht aufgeräumt
  await sql`update transport.eing_dokumente set bearbeitet_am = now() - interval '5 years' where id = ${id}`;
  await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m5a@k>', betreff: 'Hallo' }));
  assert.equal((await admin('GET', `${T}/eingang/dokumente/${id}/datei`)).status, 200, 'dauerhaft aufbewahrt');

  // Speicherwarnung im Arbeitsvorrat; Aufbewahrung auf Tage umgestellt
  await einstellen({ speicherWarnungMb: 10, aufbewahrenDauerhaft: false });
  await sql`update transport.eing_dokumente set groesse = 20 * 1024 * 1024 where id = ${liste.body[1].id}`;
  const s2 = (await admin('GET', `${T}/eingang/speicher`)).body;
  assert.equal(s2.warnung, true);
  await admin('POST', `${T}/eingang/dokumente/${id}/uebernommen`);
  // Aufbewahrung abgelaufen: beim nächsten Eingang aufgeräumt
  await sql`update transport.eing_dokumente set bearbeitet_am = now() - interval '91 days' where id = ${id}`;
  await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m5b@k>', betreff: 'Hallo' }));
  assert.equal((await sql`select inhalt is null as weg from transport.eing_dokumente where id = ${id}`)[0].weg, true, 'nach Ablauf gelöscht');
  assert.equal((await admin('GET', `${T}/eingang/dokumente/${id}/datei`)).status, 404);
  const [h] = await sql`select titel from core.hinweise where modul = 'transport' and quelle = 'EINGANG_SPEICHER' and erledigt_am is null`;
  assert.ok(h, 'Hinweis gemeldet');
  // Aufbewahrung 0 Tage: Inhalt wird bei der Übernahme sofort gelöscht (bisheriges Verhalten)
  await einstellen({ speicherWarnungMb: 10, aufbewahrenTage: 0, aufbewahrenDauerhaft: false });
  await admin('POST', `${T}/eingang/dokumente/${liste.body[1].id}/uebernommen`);
  assert.equal((await sql`select inhalt is null as weg from transport.eing_dokumente where id = ${liste.body[1].id}`)[0].weg, true);
  assert.equal((await sql`select count(*)::int as n from core.hinweise where quelle = 'EINGANG_SPEICHER' and erledigt_am is null`)[0].n, 0, 'Hinweis behoben');
  await einstellen({});
});

test('Neu bewerten nach Anlage des Auftrags, Auftrag ändern, Abwesenheitsnotiz', ohneDb, async () => {
  let r = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m6@k>', betreff: 'Auftrag 2099_9004', anhaenge: [pdf('c.pdf', 'C')] }));
  assert.deepEqual([r.body.status, r.body.auftragsnr], ['pruefen', null]);
  const v6 = r.body.vorgang as number;
  await sql`insert into transport.auftraege (auftragsnr) values ('2099_9004')`;
  r = await admin('POST', `${T}/eingang/vorgaenge/${v6}/neu-bewerten`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.auftragsnr], ['pruefen', '2099_9004'], 'neu bewerten legt nicht ab – nur Vorschlag');
  r = await admin('POST', `${T}/eingang/vorgaenge/${v6}/ablegen`, { auftragsnr: '2099_9004' });
  assert.equal(r.body.status, 'abgelegt');
  // übernommen in den Ablageordner des alten Auftrags, dann Auftrag ändern
  const [c] = await sql`select id::int as id from transport.eing_dokumente where vorgang_id = ${v6} and datei = 'c.pdf'`;
  await admin('POST', `${T}/eingang/dokumente/${c.id}/uebernommen`, { ablage_name: 'c.pdf' });
  assert.equal((await admin('POST', `${T}/eingang/vorgaenge/${v6}/auftrag`, { auftragsnr: '2099_9004' })).status, 400, 'gleicher Auftrag');
  assert.equal((await admin('POST', `${T}/eingang/vorgaenge/${v6}/auftrag`, { auftragsnr: '2099_0000' })).status, 404);
  r = await admin('POST', `${T}/eingang/vorgaenge/${v6}/auftrag`, { auftragsnr: '2099_9002' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.auftragsnr, r.body.alt], ['abgelegt', '2099_9002', '2099_9004']);
  assert.deepEqual(r.body.entfernen.map((x: any) => [x.datei, x.ablage_name]), [['c.pdf', 'c.pdf']], 'alte Datei im Ordner von 2099_9004 entfernen');
  assert.deepEqual((await docs(v6)).map((d) => [d.datei, d.status, d.ziel, d.inhalt]), [['c.pdf', 'wartet', 'lokal', true], ['2026-11-17 Auftrag 2099_9004.pdf', 'wartet', 'lokal', true]]);
  assert.equal((await admin('GET', `${T}/auftraege/2099_9004/eingang`)).body.length, 0);
  assert.equal((await admin('GET', `${T}/auftraege/2099_9002/eingang`)).body.filter((x: any) => x.datei === 'c.pdf').length, 1);
  // ohne Inhalt geht es nicht (Hinweis auf erneutes Einlesen)
  await sql`update transport.eing_dokumente set inhalt = null where id = ${c.id}`;
  r = await admin('POST', `${T}/eingang/vorgaenge/${v6}/auftrag`, { auftragsnr: '2099_9004' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /als ungelesen markieren/);
  await sql`update transport.eing_dokumente set inhalt = ${b64('%PDF-1.4 C')} where id = ${c.id}`;

  r = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m8@k>', betreff: 'Automatische Antwort: Lieferschein 2099_9001' }));
  assert.deepEqual([r.body.status, r.body.auftragsnr, r.body.aktion.ordner], ['ignoriert', null, null]);
});

test('Ablageziel Paperless: Kontext auftrag.dokument, Verknüpfung, Inhalt bleibt herunterladbar', ohneDb, async () => {
  await sql`insert into core.verbindungen (id, url, auth_art, geheimnis) values ('transport.paperless', ${`http://127.0.0.1:${port}`}, 'token', 'geheim')`;
  cacheLeeren();
  await einstellen({ ablageziel: 'paperless', mailAlsPdf: false });
  const r = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<m9@k>', betreff: 'PO-99001', text: 'Lieferschein 2099_9001', anhaenge: [pdf('pl.pdf', 'Paperless')] }));
  assert.deepEqual([r.body.status, r.body.auftragsnr], ['pruefen', '2099_9001']);
  assert.deepEqual(mock.docs, [], 'vor der Bestätigung nichts in Paperless');
  assert.equal((await admin('POST', `${T}/eingang/vorgaenge/${r.body.vorgang}/ablegen`, { auftragsnr: '2099_9001' })).body.status, 'abgelegt');
  const [d] = await docs(r.body.vorgang);
  assert.deepEqual([d.status, d.ziel, d.inhalt, typeof d.paperless_id], ['abgelegt', 'paperless', true, 'number']);
  const [v] = await sql`select punkte from transport.eing_vorgaenge where id = ${r.body.vorgang}`;
  assert.equal(v.punkte, 100, '90 + 70, gedeckelt');
  assert.equal((await sql`select count(*)::int as n from transport.auftrag_dokumente where auftragsnr = '2099_9001' and doc_id = ${d.paperless_id}`)[0].n, 1);
  assert.deepEqual(mock.docs, ['pl.pdf']);
  // Auftrag ändern: Verknüpfung wandert, kein zweites Dokument in Paperless
  const a = await admin('POST', `${T}/eingang/vorgaenge/${r.body.vorgang}/auftrag`, { auftragsnr: '2099_9002' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body.entfernen, []);
  assert.deepEqual((await sql`select auftragsnr from transport.auftrag_dokumente where doc_id = ${d.paperless_id}`).map((x) => x.auftragsnr), ['2099_9002']);
  assert.deepEqual(mock.docs, ['pl.pdf']);
  await einstellen({});
});

test('Zugeordnete E-Mail: Inhalt fehlt → erneute Lieferung füllt ihn wieder auf', ohneDb, async () => {
  const m = mail({ message_id: '<m-nach@k>', betreff: 'Lieferschein 2099_9002', anhaenge: [pdf('Nach.pdf', 'Nachladen')] });
  let r = await ext(key, 'POST', `${T}/eingang/mail`, m);
  assert.deepEqual([r.body.status, r.body.auftragsnr], ['pruefen', '2099_9002']);
  const v = r.body.vorgang as number;
  assert.equal((await admin('POST', `${T}/eingang/vorgaenge/${v}/ablegen`, { auftragsnr: '2099_9002' })).body.status, 'abgelegt');
  // wie vor der dauerhaften Aufbewahrung: Inhalte nach der Übernahme gelöscht
  await sql`update transport.eing_dokumente set status = 'uebernommen', inhalt = null where vorgang_id = ${v}`;
  const ids = (await sql`select id::int as id from transport.eing_dokumente where vorgang_id = ${v} order by id`).map((x) => x.id as number);
  assert.equal((await admin('GET', `${T}/eingang/dokumente/${ids[0]}/datei`)).status, 404);
  r = await ext(key, 'POST', `${T}/eingang/mail`, m);
  assert.equal(r.body.status, 'doppelt');
  assert.deepEqual((await docs(v)).map((d) => [d.datei, d.status, d.inhalt]), [
    ['Nach.pdf', 'uebernommen', true], ['2026-11-17 Lieferschein 2099_9002.pdf', 'uebernommen', true]]);
  const f = await admin('GET', `${T}/eingang/dokumente/${ids[0]}/datei`);
  assert.equal(f.status, 200);
  assert.equal(f.body, '%PDF-1.4 Nachladen');
});

test('PDF als application/octet-stream geliefert: als PDF gespeichert und angezeigt; Altbestand', ohneDb, async () => {
  const inhalt = '%PDF-1.4 POD-Beleg \u00ff\u0000\u0001 Ende';
  const r = await ext(key, 'POST', `${T}/eingang/mail`, mail({
    message_id: '<m-oct@k>', betreff: 'Rechnung 300-GOH 2099_9003',
    anhaenge: [{ name: '300042946-9747702438088-0-POD-D58VUO00.PDF', mime: 'application/octet-stream', inhalt: Buffer.from(inhalt, 'latin1').toString('base64') }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [d] = await sql`select id::int as id, mime, groesse, sha256 from transport.eing_dokumente where vorgang_id = ${r.body.vorgang} and art = 'anhang'`;
  assert.equal(d.mime, 'application/pdf');
  const f = await admin('GET', `${T}/eingang/dokumente/${d.id}/datei`);
  assert.equal(f.status, 200);
  assert.match(String(f.headers['content-type']), /^application\/pdf/);
  assert.match(String(f.headers['content-disposition']), /^inline/);
  // Altbestand: gespeicherter Typ octet-stream → die Auslieferung erkennt das PDF am Inhalt
  await sql`update transport.eing_dokumente set mime = 'application/octet-stream' where id = ${d.id}`;
  const g = await admin('GET', `${T}/eingang/dokumente/${d.id}/datei`);
  assert.match(String(g.headers['content-type']), /^application\/pdf/);
  // Inhalt unverändert (Prüfsumme des Eingangs)
  const [x] = await sql`select encode(sha256(decode(inhalt, 'base64')), 'hex') as sha from transport.eing_dokumente where id = ${d.id}`;
  assert.equal(x.sha, d.sha256);
  assert.equal(d.groesse, Buffer.from(inhalt, 'latin1').length);
});

test('Vormerken und gesammelte Übergabe: bearbeiten je E-Mail, ablegen erst mit der Übergabe', ohneDb, async () => {
  await sql`insert into transport.auftraege (auftragsnr) values ('2099_9201'), ('2099_9202') on conflict do nothing`;
  // drei E-Mails: Vorschlag 2099_9201, ohne Treffer, und eine, die nicht vorgemerkt wird
  const a = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<vm1@k>', von: 'X <x@fremd-vm.test>', betreff: 'Unterlagen 2099_9201', anhaenge: [pdf('vm1.pdf', 'VM1'), pdf('vm1b.pdf', 'VM1B')] }));
  const b = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<vm2@k>', von: 'Y <y@fremd-vm.test>', betreff: 'Scan', anhaenge: [pdf('vm2.pdf', 'VM2')] }));
  const c = await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<vm3@k>', von: 'Z <z@fremd-vm.test>', betreff: 'Noch offen 2099_9202', anhaenge: [pdf('vm3.pdf', 'VM3')] }));
  for (const x of [a, b, c]) assert.deepEqual(x.body.aktion, { ordner: null, gelesen: true }, 'Outlook: nicht verschieben, nur als gelesen markieren');
  const [va, vb, vc] = [a.body.vorgang, b.body.vorgang, c.body.vorgang] as number[];
  const [vm1] = await sql`select id::int as id from transport.eing_dokumente where vorgang_id = ${va} and datei = 'vm1.pdf'` as unknown as { id: number }[];

  // Vormerken: Auftrag ändern (b) und Dateiauswahl (a: nur vm1.pdf) – nichts wird abgelegt
  let r = await admin('POST', `${T}/eingang/vorgaenge/${va}/vormerken`, { auftragsnr: '2099_9201', dokumente: [vm1.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vorgemerkt, true);
  r = await admin('POST', `${T}/eingang/vorgaenge/${vb}/vormerken`, { auftragsnr: '2099_9999' });
  assert.equal(r.status, 404, 'unbekannter Auftrag');
  r = await admin('POST', `${T}/eingang/vorgaenge/${vb}/vormerken`, { auftragsnr: '2099_9202' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await docs(va)).every((d) => d.status === 'neu'), 'noch nichts abgelegt');
  let liste = (await admin('GET', `${T}/eingang/vorgaenge?status=pruefen`)).body;
  assert.equal(liste.ablageziel, 'lokal');
  const zeile = (id: number) => liste.vorgaenge.find((x: any) => x.id === id);
  assert.deepEqual([zeile(va).vorgemerkt, zeile(va).auftragsnr, zeile(vb).vorgemerkt, zeile(vb).auftragsnr, zeile(vc).vorgemerkt], [true, '2099_9201', true, '2099_9202', false]);
  assert.equal((await admin('GET', `${T}/eingang/vorgaenge/${va}`)).body.vorgemerkt_dokumente[0], vm1.id);

  // „Posteingang abrufen“ bewertet vorgemerkte nicht neu – der von Hand gewählte Auftrag bleibt
  assert.equal((await admin('POST', `${T}/eingang/abruf`)).status, 200);
  const [nachAbruf] = await sql`select auftragsnr, vorgemerkt_am is not null as vm from transport.eing_vorgaenge where id = ${vb}`;
  assert.deepEqual([nachAbruf.auftragsnr, nachAbruf.vm], ['2099_9202', true]);

  // Vormerkung aufheben und wieder setzen
  assert.equal((await admin('DELETE', `${T}/eingang/vorgaenge/${vb}/vormerken`)).body.vorgemerkt, false);
  assert.equal((await admin('POST', `${T}/eingang/vorgaenge/${vb}/vormerken`, { auftragsnr: '2099_9202' })).status, 200);

  // gesammelte Übergabe: beide vorgemerkten, die dritte bleibt in der Prüfliste
  r = await admin('POST', `${T}/eingang/uebergabe`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // a: nur die gewählte Datei; b: Anhang und die E-Mail als PDF
  assert.deepEqual([r.body.emails, r.body.fehler, r.body.wartet], [2, 0, 3]);
  assert.deepEqual(r.body.ergebnisse.map((e: any) => [e.id, e.auftragsnr, e.ok]), [[va, '2099_9201', true], [vb, '2099_9202', true]]);
  assert.deepEqual((await docs(va)).map((d) => [d.datei, d.status]).filter(([n]) => String(n).startsWith('vm1')), [['vm1.pdf', 'wartet'], ['vm1b.pdf', 'neu']], 'nur die gewählte Datei');
  assert.ok((await docs(vb)).every((d) => d.status === 'wartet'));
  const st = await sql`select id::int as id, status, vorgemerkt_am is not null as vm, abgelegt_von from transport.eing_vorgaenge where id = any(${[va, vb, vc]}) order by id`;
  assert.deepEqual(st.map((x) => [x.status, x.vm]), [['pruefen', false], ['abgelegt', false], ['pruefen', false]], 'a hat noch eine offene Datei, c war nicht vorgemerkt');
  assert.equal(st[1].abgelegt_von, 'Admin');
  r = await admin('POST', `${T}/eingang/uebergabe`, {});
  assert.deepEqual([r.body.emails, r.body.text], [0, 'Keine vorgemerkten E-Mails.']);
});

test('Jetzt abrufen: ohne und mit Anbindung; Rechte', ohneDb, async () => {
  let r = await admin('POST', `${T}/eingang/abruf`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.abruf, false);
  await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis)
            values ('transport.maileingang', ${`http://127.0.0.1:${port}/webhook/euroflex-maileingang-abruf`}, 'header', 'X-Euroflex-Key', 'k')`;
  cacheLeeren();
  r = await admin('POST', `${T}/eingang/abruf`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.abruf, true);
  assert.equal(mock.abruf.length, 1);
  assert.equal(JSON.parse(mock.abruf[0].body).anwendung, 'Euroflex');

  assert.equal((await ext(key, 'GET', `${T}/eingang/vorgaenge`)).status, 403, 'n8n-Schlüssel sieht die Prüfliste nicht');
  const ohne = await admin('POST', '/api/admin/api-keys', { module: 'transport', name: 'ohne-rechte', permissions: [] });
  assert.equal((await ext(ohne.body.key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<x@k>', betreff: 'x' }))).status, 403);
  assert.equal((await ext(key, 'POST', `${T}/eingang/mail`, mail({ message_id: '<y@k>', anhaenge: Array.from({ length: 41 }, (_, i) => pdf(`${i}.pdf`, String(i))) }))).status, 400, 'höchstens 40 Anhänge');
});

test('Nummernsuche zuerst: Rechnungsnummer mit Fundstellen, Vorrang vor dem Absender, Platzhalter „FOLGT“ ohne Treffer', ohneDb, async () => {
  await sql`insert into transport.auftraege (auftragsnr, kunde, faktura, fakturadatum) values ('2099_9106', 990002, '2099_9104', current_date)`;
  await sql`insert into transport.auftraege (auftragsnr, ordernummer, ladenummer) values ('2099_9107', 'FOLGT', 'Muster')`;
  // Absender gehört zu zwei offenen Aufträgen (2099_9001, 2099_9002) – die Rechnungsnummer hat Vorrang
  let r = await ext(key, 'POST', `${T}/eingang/mail`, mail({
    message_id: '<m-nr1@k>', von: 'Einkauf <einkauf@kunde-eingang.test>', betreff: 'Ihre Rechnung 2099-9104',
    text: 'Zur Rechnung 2099_9104 folgt die Zahlung.', anhaenge: [pdf('Rechnung_2099_9104.pdf', 'R')],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let [v] = await sql`select auftragsnr, punkte, kandidaten, begruendung from transport.eing_vorgaenge where id = ${r.body.vorgang}`;
  assert.deepEqual(v.kandidaten.map((k: L.Kandidat) => k.auftragsnr), ['2099_9106'], 'nur der Auftrag zur Rechnungsnummer');
  assert.deepEqual([v.auftragsnr, v.punkte], ['2099_9106', 90]);
  assert.equal(v.begruendung[0].grund, 'Rechnungsnummer 2099_9104 (Auftrag 2099_9106) – Herkunft: Betreff: „Ihre Rechnung 2099-9104“; '
    + 'Mailtext: „Zur Rechnung 2099_9104 folgt die Zahlung.“; Dateiname „Rechnung_2099_9104.pdf“');

  // Werbemail: „Bestellung folgt“ trifft weder Ordernummer noch Ladenummer ohne Ziffer
  r = await ext(key, 'POST', `${T}/eingang/mail`, mail({
    message_id: '<m-nr2@k>', von: 'Shop <shop@fremd-eingang.test>', betreff: 'Deine Bestellung wurde versandt', text: 'Rechnung folgt. Muster gratis.',
    anhaenge: [pdf('werbung.pdf', 'W')],
  }));
  [v] = await sql`select auftragsnr, kandidaten from transport.eing_vorgaenge where id = ${r.body.vorgang}`;
  assert.deepEqual([v.auftragsnr, v.kandidaten], [null, []]);
});
