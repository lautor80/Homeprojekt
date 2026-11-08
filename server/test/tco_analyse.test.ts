/**
 * Integrationstest Paket Mitglieder-Analyse: Analyse (Filter, Gruppierung, Kennzahlen, Diagramme, CSV, Varianten),
 * Teilnehmer Jugendtraining (Liste, Detail, mailto) und Dokumenten-Upload nach Paperless (Attrappe), Berechtigungen.
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
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, raw: res.rawPayload, ct, headers: res.headers };
  };
}
const call = client();
const A = '/api/m/tco/analyse';
const T = '/api/m/tco/teilnehmer';
const U = '/api/m/tco/upload';
const heute = new Date().toISOString().slice(0, 10);
const jahr = Number(heute.slice(0, 4));

// ---------------------------------------------------------------- Paperless-Attrappe
const mock = { docs: new Map<number, { title: string; created: string; tags: string[]; type: string; corr: string; notes: string[] }>(), next: 900, tags: [{ id: 1, name: 'Beleg' }], korr: [{ id: 5, name: 'Getränke Becker' }] };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = decodeURIComponent(req.url ?? '');
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    const form = (n: string) => new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`, 'g');
    if (u === '/api/documents/post_document/') {
      const id = mock.next++;
      const alle = (n: string) => [...body.matchAll(form(n))].map((x) => x[1]);
      if (/filename="dublette\.pdf"/.test(body)) return send(200, 'task-dup');
      mock.docs.set(id, { title: alle('title')[0] ?? '', created: alle('created')[0] ?? '', tags: alle('tags'), type: alle('document_type')[0] ?? '', corr: alle('correspondent')[0] ?? '', notes: [] });
      return send(200, `task-${id}`);
    }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\w+)/.exec(u))) {
      if (m[1] === 'dup') return send(200, [{ status: 'FAILURE', related_document: null, result: 'Not consuming dublette.pdf: It is a duplicate of Beleg (#12)' }]);
      return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    }
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const art = u.split('/')[2];
      const lists: Record<string, unknown[]> = {
        correspondents: mock.korr, document_types: [{ id: 9, name: 'Rechnung' }, { id: 10, name: 'Quittung' }], storage_paths: [{ id: 2, name: 'Buchhaltung' }], custom_fields: [], tags: mock.tags,
      };
      return send(200, { results: lists[art], next: null });
    }
    if (u === '/api/correspondents/' && req.method === 'POST') { const k = { id: 6, name: JSON.parse(body).name }; mock.korr.push(k); return send(201, k); }
    if (u === '/api/tags/' && req.method === 'POST') { const k = { id: mock.tags.length + 1, name: JSON.parse(body).name }; mock.tags.push(k); return send(201, k); }
    if ((m = /^\/api\/documents\/(\d+)\/notes\/$/.exec(u))) { mock.docs.get(Number(m[1]))?.notes.push(JSON.parse(body || '{}').note); return send(200, []); }
    send(404, { u });
  });
});

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`update tco.verein set paperless_url = ${`http://127.0.0.1:${port}`}, paperless_token = 'geheim'`;

  // Testdaten: 4 Mitglieder (eins ausgetreten, eins ohne Eintritt), Verträge Erwachsene (10) und Jugendtraining (90), Beitragsstamm
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, plz, ort, email, geschlecht, geburtsdatum, eintritt, austritt, mitglnrn, zahlungsart, zahlungsweise) values
    ('0000000101', 'Hans', 'Müller', '66649', 'Oberthal', 'hans@example.org', '1', ${`${jahr - 45}-03-10`}, '2010-01-01', null, '000123', 'L', 'jährlich'),
    ('0000000102', 'Lena', 'Krämer', '66649', 'Oberthal', 'lena@example.org', '2', ${`${jahr - 12}-06-01`}, ${`${jahr - 2}-04-01`}, null, '000200', 'L', 'jährlich'),
    ('0000000103', 'Paul', 'Schmidt', '66606', 'St. Wendel', 'paul@example.org', '1', ${`${jahr - 30}-01-01`}, '2005-01-01', ${`${jahr - 1}-12-31`}, '000050', 'U', 'jährlich'),
    ('0000000104', 'Tim', 'Gast', '66649', 'Oberthal', '', '1', ${`${jahr - 10}-09-09`}, ${`${jahr}-01-15`}, null, '000300', 'B', 'jährlich'),
    ('0000000105', 'Eva', 'Zahler', '66649', 'Oberthal', 'eva@example.org', '2', null, null, null, '', 'L', '')`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, vertragende, betrag, betrag_indiv) values
    ('0000000101', '1', '10', 'Erwachsene', '000123', 'jährlich', '2010-01-01', null, 100, false),
    ('0000000102', '1', '20', 'Jugendliche', '000200', 'jährlich', ${`${jahr - 2}-04-01`}, null, 50, false),
    ('0000000102', '2', '90', 'Jugendtraining', '000200', 'monatlich', ${`${jahr - 1}-01-01`}, null, 30, false),
    ('0000000102', '3', '90', 'Jugendtraining', '000200', 'monatlich', ${`${jahr - 1}-01-01`}, null, 30, true),
    ('0000000103', '1', '10', 'Erwachsene', '000050', 'jährlich', '2005-01-01', ${`${jahr - 1}-12-31`}, 100, false),
    ('0000000104', '1', '90', 'Jugendtraining', '000300', 'monatlich', ${`${jahr}-01-15`}, null, 30, false)`;
  await sql`insert into tco.beitrag (art, bezeichnung, turnus) values ('10', 'Erwachsene', 'jährlich'), ('90', 'Jugendtraining', 'monatlich')`;
  await sql`insert into tco.beitrag_pr (art, gueltig_ab, gueltig_bis, betrag) values ('10', '2000-01-01', '2019-12-31', 100), ('10', '2020-01-01', null, 120), ('90', '2000-01-01', null, 35)`;
});
after(async () => {
  await app?.close();
  await sql.end();
  server.close();
});

test('Analyse: Standardsicht, Gruppierung, Filter, Varianten, CSV', async () => {
  let r = await call('GET', `${A}/init`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.werte.orte, ['Oberthal', 'St. Wendel']);
  assert.deepEqual(r.body.werte.vertragsarten, ['Erwachsene', 'Jugendliche', 'Jugendtraining']);
  assert.equal(r.body.variante, null);
  const sicht = r.body.sicht;
  assert.equal(sicht.filter.status, 'A');

  // Standard: nur aktive Mitglieder mit Eintritt (101, 102, 104), nur aktive Verträge
  r = await call('POST', `${A}/daten`, sicht);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kpi.mitglieder, 3);
  assert.equal(r.body.kpi.aktiv, 3);
  assert.equal(r.body.kpi.vertraege, 5);
  // Beitragsstamm: Erwachsene 120 (statt 100 im Vertrag), Jugendliche 50 (kein Stamm), Jugendtraining 35 + 30 (individuell) + 35
  assert.equal(r.body.kpi.betrag, 270);
  const rows = r.body.rows;
  assert.equal(rows[rows.length - 1].rowtype, 'T');
  assert.equal(rows[rows.length - 1].vertraege_betrag, '270,00 EUR');
  const d = rows.filter((x: any) => x.rowtype === 'D');
  assert.deepEqual(d.map((x: any) => x.nachname), ['Gast', 'Krämer', 'Müller']);
  const kraemer = d.find((x: any) => x.nachname === 'Krämer');
  assert.equal(kraemer.altersgruppe, 'bis 18 Jahre');
  assert.equal(kraemer.vertraege_anzahl, '3');
  assert.equal(kraemer.zahlungsart, 'Lastschrift');
  assert.equal(rows.filter((x: any) => x.rowtype === 'V').length, 2);
  assert.equal(r.body.titel, 'Mitglieder-Analyse (3)');
  assert.equal(r.body.filterCount, 2);
  // Diagramme
  assert.equal(r.body.diagramme.alter.find((x: any) => x.label === 'bis 18 Jahre').wert, 2);
  assert.equal(r.body.diagramme.geschlecht.find((x: any) => x.label === 'männlich').wert, 2);
  assert.deepEqual(r.body.diagramme.vertragsarten[0], { label: 'Jugendtraining', anzahl: 3, betrag: 100 });
  assert.equal(r.body.diagramme.orte[0].label, 'Oberthal');

  // Alle Mitglieder, gruppiert nach Status ohne Details: nur Gruppenköpfe und Summe
  r = await call('POST', `${A}/daten`, { ...sicht, group_by: 'STATUS', details: false, filter: { ...sicht.filter, status: '', vertrag_scope: '' } });
  assert.equal(r.body.kpi.mitglieder, 4);
  assert.equal(r.body.kpi.aktiv, 3);
  assert.deepEqual(r.body.rows.map((x: any) => [x.rowtype, x.gruppe, x.anzahl]), [['G', 'aktiv', '3'], ['G', 'ausgetreten', '1'], ['T', 'Gesamt', '4']]);
  // Ausgetretener: Vertrag beendet → Beitrag laut Stamm zum Vertragsende (Jahr-1 → 120)
  assert.equal(r.body.rows[1].vertraege_betrag, '120,00 EUR');
  assert.equal(r.body.diagramme.jahre.find((x: any) => x.jahr === jahr - 1).austritte, 1);

  // Gruppierung nach Vertragsart mit Filter Vertragsart, Sortierung Alter absteigend, Suche
  r = await call('POST', `${A}/daten`, { ...sicht, group_by: 'VERTRAGSART', filter: { ...sicht.filter, vertragsart: 'Jugendtraining', sort_by: 'ALTER', sort_desc: true } });
  assert.equal(r.body.kpi.mitglieder, 2);
  assert.deepEqual(r.body.rows.filter((x: any) => x.rowtype === 'D').map((x: any) => x.nachname), ['Krämer', 'Gast']);
  r = await call('POST', `${A}/daten`, { ...sicht, search: 'wendel', filter: { ...sicht.filter, status: '' } });
  assert.equal(r.body.kpi.mitglieder, 1);
  r = await call('POST', `${A}/daten`, { ...sicht, filter: { ...sicht.filter, vertragsbest: 'O' } });
  assert.equal(r.body.kpi.mitglieder, 0);
  r = await call('POST', `${A}/daten`, { ...sicht, filter: { ...sicht.filter, alter_von: '40', eintritt_bis: '2015' } });
  assert.deepEqual(r.body.rows.filter((x: any) => x.rowtype === 'D').map((x: any) => x.nachname), ['Müller']);

  // CSV-Export mit BOM und Semikolon, nur sichtbare Spalten
  r = await call('GET', `${A}/export?s=${encodeURIComponent(JSON.stringify({ ...sicht, cols: ['nachname', 'vorname', 'vertraege_betrag'] }))}`);
  assert.equal(r.status, 200);
  assert.match(r.ct, /^text\/csv; charset=utf-8/);
  const csv = r.raw.toString('utf8');
  assert.ok(csv.startsWith('\uFEFFNachname;Vorname;Beitrag gesamt\r\n'));
  assert.match(csv, /\r\nMüller;Hans;120,00 EUR\r\n/);
  assert.match(csv, /\r\n;;270,00 EUR\r\n$/);

  // Varianten: sichern (Vorschlag), Liste, Init lädt sie, laden, löschen
  r = await call('POST', `${A}/varianten`, { name: 'jugend', descr: 'Nur Jugendtraining', isdef: true, sicht: { ...sicht, group_by: 'VERTRAGSART', cols: ['nachname', 'unbekannt'], filter: { ...sicht.filter, vertragsart: 'Jugendtraining' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.variante.key, 'admin/JUGEND');
  assert.equal(r.body.varianten.length, 1);
  r = await call('POST', `${A}/varianten`, { name: 'ALLE', global: true, sicht: { ...sicht, filter: { ...sicht.filter, status: '' } } });
  assert.deepEqual(r.body.varianten.map((v: any) => v.key).sort(), ['*/ALLE', 'admin/JUGEND']);
  r = await call('GET', `${A}/init`);
  assert.equal(r.body.variante.name, 'JUGEND');
  assert.equal(r.body.sicht.group_by, 'VERTRAGSART');
  assert.deepEqual(r.body.sicht.cols, ['nachname']);
  r = await call('GET', `${A}/varianten/laden?key=${encodeURIComponent("*/ALLE")}`);
  assert.equal(r.body.sicht.filter.status, '');
  r = await call('POST', `${A}/varianten`, { name: 'ALLE', global: true, isdef: true, sicht });
  r = await call('GET', `${A}/init`);
  assert.equal(r.body.variante.name, 'JUGEND', 'eigene Vorschlagsvariante geht vor');
  r = await call('POST', `${A}/varianten/loeschen`, { key: 'admin/JUGEND' });
  assert.equal(r.status, 200);
  r = await call('GET', `${A}/init`);
  assert.equal(r.body.variante.name, 'ALLE');
  r = await call('GET', `${A}/varianten/laden?key=fremd/X`);
  assert.equal(r.status, 400);
});

test('Teilnehmer Jugendtraining: Liste, Detail, mailto', async () => {
  let r = await call('GET', T);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 102 (Mitglied, 2 Einheiten) und 104 (Nichtmitglied, 1 Einheit); 103 ausgetreten
  assert.deepEqual(r.body.teilnehmer.map((t: any) => [t.name, t.einheiten, t.trainingsbeitrag, t.mitglied_text]), [['Gast, Tim', 1, 30, 'Nein'], ['Krämer, Lena', 2, 60, 'Ja']]);
  assert.equal(r.body.einheiten, 3);
  assert.equal(r.body.mitglieder, 1);
  assert.equal(r.body.nichtmitglieder, 1);
  const lena = r.body.teilnehmer[1];
  assert.equal(lena.alter, heute.slice(5) >= '06-01' ? 12 : 11);
  assert.equal(lena.mitglied_state, 'Positive');

  r = await call('GET', `${T}/0000000102`);
  assert.equal(r.status, 200);
  assert.equal(r.body.vertraege.length, 3);
  assert.equal(r.body.einheiten, 2);
  assert.equal(r.body.mitglied, true);
  assert.equal(r.body.mitglnr, '200');
  r = await call('GET', `${T}/0000009999`);
  assert.equal(r.status, 400);

  r = await call('POST', `${T}/mailto`, { adrnrs: ['0000000102', '0000000104'] });
  assert.equal(r.body.url, `mailto:?bcc=${encodeURIComponent('lena@example.org')}&subject=${encodeURIComponent('Jugendtraining TC Oberthal')}`);
  assert.deepEqual(r.body.ohneEmail, ['Gast, Tim']);
  r = await call('POST', `${T}/mailto`, { adrnrs: ['0000000104'] });
  assert.equal(r.body.url, null);

  // PDF im Vereinslayout mit derselben Auswahl wie die App
  r = await call('GET', `${T}/pdf`);
  assert.equal(r.status, 200);
  assert.match(r.ct, /application\/pdf/);
  assert.equal(r.raw.subarray(0, 5).toString(), '%PDF-');
  r = await call('GET', `${T}/pdf?filter=MEMBER&suche=kr`);
  assert.equal(r.status, 200);
  r = await call('GET', `${T}/pdf?adrnrs=0000000104`);
  assert.equal(r.status, 200);
  r = await call('GET', `${T}/pdf?filter=UNSINN`);
  assert.equal(r.status, 400);
});

test('Teilnehmer: Auswahl für das PDF entspricht der Trefferliste', async () => {
  const { auswaehlen } = await import('../../modules/tco/server/teilnehmer/pdf.js');
  const { teilnehmerLesen } = await import('../../modules/tco/server/teilnehmer/logik.js');
  const { DB } = await import('../../modules/tco/server/verein.js');
  const alle = await teilnehmerLesen(DB);
  const namen = (f: Parameters<typeof auswaehlen>[1]) => auswaehlen(alle, f).map((t) => t.name);
  assert.deepEqual(namen({ filter: 'ALL', suche: '', adrnrs: [] }), ['Gast, Tim', 'Krämer, Lena']);
  assert.deepEqual(namen({ filter: 'NONMEMBER', suche: '', adrnrs: [] }), ['Gast, Tim']);
  assert.deepEqual(namen({ filter: 'ALL', suche: 'lena@', adrnrs: [] }), ['Krämer, Lena']);
  assert.deepEqual(namen({ filter: 'ALL', suche: '', adrnrs: ['0000000104'] }), ['Gast, Tim']);
});

test('Upload: Stammdaten, Übertragung mit Metadaten, Fehlerfälle', async () => {
  let r = await call('GET', `${U}/stamm`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paperless, true);
  assert.deepEqual(r.body.dokumenttypen.map((x: any) => x.name), ['Quittung', 'Rechnung']);
  assert.ok(r.body.dateitypen.includes('pdf'));

  const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`;
  const meta = { titel: 'Getränke Oktober', datum: '2026-10-07', doktyp: 9, korrespondent: null, korrespondentNeu: 'Brauerei Becker', tags: [1], tagsNeu: ['Clubhaus'], notiz: 'per Upload' };
  r = await call('POST', `${U}/datei`, { datei: 'C:\\Belege\\rechnung_okt.pdf', inhalt: pdf, meta });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'Positive');
  assert.equal(r.body.id, 900);
  assert.equal(r.body.bereich, 'FI Belege');
  assert.equal(r.body.groesse, '13 B');
  const doc = mock.docs.get(900)!;
  assert.equal(doc.title, 'Getränke Oktober');
  assert.equal(doc.created, '2026-10-07');
  assert.equal(doc.type, '9');
  assert.equal(doc.corr, '6', 'neuer Korrespondent angelegt');
  assert.deepEqual(doc.tags, ['1', '2'], 'vorhandener und neu angelegter Tag');
  assert.match(doc.notes[0], /^per Upload \(Admin, Vereinsportal\)$/);

  // Titel aus dem Dateinamen, Bild als Dateityp, Hinweis auf Ziel-Bereich bei CSV
  r = await call('POST', `${U}/datei`, { datei: 'quittung.jpg', inhalt: `data:image/jpeg;base64,${Buffer.from('bild').toString('base64')}`, meta: { ...meta, titel: '', korrespondentNeu: '', tagsNeu: [], notiz: '' } });
  assert.equal(r.body.state, 'Positive');
  assert.equal(mock.docs.get(901)!.title, 'quittung');
  r = await call('POST', `${U}/datei`, { datei: 'jugend_oktober.csv', inhalt: `data:text/csv;base64,${Buffer.from('a;b').toString('base64')}`, meta });
  assert.equal(r.body.bereich, 'Jugendabrechnung');

  // Duplikat: Paperless meldet FAILURE → Statuszeile Negative, kein Abbruch
  r = await call('POST', `${U}/datei`, { datei: 'dublette.pdf', inhalt: pdf, meta });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'Negative');
  assert.match(r.body.text, /duplicate/);
  // unerlaubter Dateityp, leere Datei, fehlendes Datum
  r = await call('POST', `${U}/datei`, { datei: 'virus.exe', inhalt: pdf, meta });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Dateityp/);
  r = await call('POST', `${U}/datei`, { datei: 'leer.pdf', inhalt: 'data:application/pdf;base64,', meta });
  assert.equal(r.status, 400);
  r = await call('POST', `${U}/datei`, { datei: 'x.pdf', inhalt: pdf, meta: { ...meta, datum: '7.10.2026' } });
  assert.equal(r.status, 400);

  // ---- FI-Beleg per Ablage: offen (ohne Buchung) und direkt zu einer Buchung, Screenshot als PNG
  await sql`update tco.verein set fi_beleg_typen = 'Rechnung', fi_beleg_pfad = 'Buchhaltung'`;
  const png = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
  r = await call('POST', '/api/m/tco/fi/belege/hochladen', { datei: 'Screenshot 2026-11-08 16-56.png', inhalt: png });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /offen, wird beim Bankimport vorgeschlagen/);
  const offen = mock.docs.get(r.body.id)!;
  assert.equal(offen.type, '9', 'Dokumenttyp aus den Stammdaten (FI-Belegtypen)');
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, soll, haben)
            values ('0000000999', '1200', 0, 2026, 11, '2026-11-08', 'Test', 10, 10, 0)`;
  r = await call('POST', '/api/m/tco/fi/belege/hochladen', { datei: 'quittung.pdf', inhalt: pdf, internenr: ['0000000999'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zugeordnet, ['0000000999']);
  const [map] = await sql`select count(*)::int as n from tco.fipapermap where internenr = '0000000999' and ltrim(doknr, '0') = ${String(r.body.id)}`;
  assert.equal(map.n, 1);
  r = await call('POST', '/api/m/tco/fi/belege/hochladen', { datei: 'x.pdf', inhalt: pdf, internenr: ['0000004711'] });
  assert.equal(r.status, 400);
});

test('Berechtigungen: Leser ohne Rechte bekommt 403', async () => {
  assert.equal((await call('POST', '/api/admin/roles', { id: 'TN', name: 'Nur Teilnehmer', permissions: ['tco.teilnehmer:display'] })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['TN'] })).status, 200);
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  assert.equal((await leser('GET', T)).status, 200);
  assert.equal((await leser('GET', `${A}/init`)).status, 403);
  assert.equal((await leser('POST', `${A}/daten`, {})).status, 403);
  assert.equal((await leser('GET', `${U}/stamm`)).status, 403);
  assert.equal((await leser('POST', `${U}/datei`, {})).status, 403);
});
