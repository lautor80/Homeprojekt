/**
 * Integrationstest Clubhausabrechnung: Getränke, Rechnungen, Belegtext, Forderungsliste,
 * Paperless-Belege über die FI-Zuordnung, PDF und Ablage.
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
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, raw: res.rawPayload, ct };
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const C = '/api/m/tco/clubhaus';


// ---------------------------------------------------------------- Paperless-Attrappe
const json = JSON.stringify({ auftragsnummer: 'R-4711', datum: '2026-10-07', positionen: [{ menge: 10, text: 'Karlsberg Urpils 20x0,5', preis: 14, gesamt: 140 }] });
const mock = { docs: new Map<number, { versions: number[]; notes: string[]; meta: Record<string, any> }>(), next: 500 };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = decodeURIComponent(req.url ?? '');
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/documents\/\?id__in=([0-9,]+)/.exec(u))) {
      const all = [
        { id: 301, title: 'Getränke Rechnung R-4711', created: '2026-10-08', custom_fields: [{ field: 3, value: 'EUR151.60' }, { field: 8, value: json }] },
        { id: 302, title: 'Getränke Rechnung ohne JSON', created: '2026-10-20', custom_fields: [{ field: 3, value: 'EUR99.00' }] },
      ];
      return send(200, { results: all.filter((d) => m![1].split(',').includes(String(d.id))), next: null });
    }
    if (u.startsWith('/api/documents/?')) return send(200, { results: [], next: null });
    if (u === '/api/documents/post_document/') { const id = mock.next++; mock.docs.set(id, { versions: [], notes: [], meta: {} }); return send(200, `task-${id}`); }
    if ((m = /^\/api\/documents\/(\d+)\/update_version\/$/.exec(u))) { const vid = mock.next++; mock.docs.get(Number(m[1]))!.versions.push(vid); return send(200, `task-${vid}`); }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const art = u.split('/')[2];
      const lists: Record<string, unknown[]> = {
        correspondents: [], document_types: [], storage_paths: [{ id: 2, name: 'Buchhaltung' }],
        custom_fields: [{ id: 3, name: 'Betrag', data_type: 'monetary' }, { id: 4, name: 'DOKID', data_type: 'string' }, { id: 8, name: 'JSON', data_type: 'string' }], tags: [],
      };
      return send(200, { results: lists[art], next: null });
    }
    if (u === '/api/correspondents/' && req.method === 'POST') return send(201, { id: 7, name: JSON.parse(body).name });
    if ((m = /^\/api\/documents\/(\d+)\/notes\/$/.exec(u))) { mock.docs.get(Number(m[1]))?.notes.push(JSON.parse(body || '{}').note); return send(200, []); }
    if ((m = /^\/api\/documents\/(\d+)\/download\//.exec(u))) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 test'); }
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      const id = Number(m[1]);
      const d = mock.docs.get(id);
      if (!d) return send(200, { id, custom_fields: [], versions: [{ id }] });
      if (req.method === 'PATCH') { d.meta = JSON.parse(body); return send(200, {}); }
      return send(200, { id, custom_fields: [], versions: [{ id }, ...d.versions.map((v) => ({ id: v }))] });
    }
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
});
after(async () => {
  await app?.close();
  await sql.end();
  server.close();
});

test('Clubhaus: Getränke, Rechnung, Forderungsliste, Belege, PDF', async () => {
  let r = await call('POST', '/api/m/tco/import/ausfuehren', { modus: 'neu', dateien: [
    { name: 'ZTCO_PRODUKTE.CSV', data: b64('PROD_KEY;VALID_FROM;VALID_TO;TEXT;PREIS;TYP;MENGE\n101;20200101;99991231;Karlsberg Urpils;1,50;G;20\n191;20200101;99991231;Pfandrückgabe;0;G;1\n') },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // neues Getränk und neuer Preis ab Stichtag
  r = await call('POST', `${C}/getraenke`, { text: 'Malzbier', menge: 24, preis: 1.2, ab: '2020-01-01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${C}/getraenke`, { prod_key: '101', text: 'Karlsberg Urpils', menge: 20, preis: 1.6, ab: '2026-12-01' });
  assert.match(r.body.text, /Neuer Preis/);
  r = await call('GET', `${C}/getraenke`);
  assert.equal(r.body.filter((g: any) => g.prod_key === '101').length, 2);

  // Vorlage und Belegtext (OCR)
  r = await call('GET', `${C}/rechnung`);
  assert.deepEqual(r.body.pos.map((p: any) => p.produkt), ['KARLSBERG URPILS', 'MALZBIER', 'PFANDRÜCKGABE']);
  r = await call('POST', `${C}/belegtext`, { text: '1 10 Karlsberg Ur-Pils 20x0,5 14,00 140,00\n2 5 Leergut Rückgabe 3,00 15,00\nWerbeartikel 1 9,99', pos: r.body.pos });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.info, /^2 Positionen übernommen/);
  const pos = r.body.pos;
  assert.deepEqual(pos.find((p: any) => p.produkt === 'PFANDRÜCKGABE'), { produkt: 'PFANDRÜCKGABE', anzahl: 5, ekpreis: -3, ekpreis_vor: 3, pospreis: -15, brutto: -15 });
  assert.equal(pos.find((p: any) => p.produkt === 'KARLSBERG URPILS').brutto, 166.6);

  // Einzahlung der Wirtin im Oktober, dann Rechnung speichern → Forderungsliste ab Oktober
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, gkonto) values
            ('0000009001', '8005', 1, 2026, 10, '2026-10-15', 'Einzahlung Clubhaus', 100, '1000'),
            ('0000009002', '3200', 1, 2026, 10, '2026-10-10', 'Getränke Karlsberg', -151.6, '1200')`;
  await sql`insert into tco.fipapermap (internenr, konto, doknr, betrag) values ('0000009002', '3200', '000301', 151.6), ('0000009002', '3200', '302', 99)`;
  r = await call('POST', `${C}/rechnung`, { rgnr: 'R-4711', datum: '2026-10-07', pos });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${C}/rechnung`, { rgnr: 'R-4711', datum: '2026-10-07', pos });
  assert.equal(r.status, 400); // Neuanlage mit vorhandener Nummer
  r = await call('GET', `${C}/init?jahr=2026`);
  assert.deepEqual(r.body.rechnungen.map((x: any) => [x.rgnr, x.brutto]), [['R-4711', 151.6]]);
  const okt = r.body.forderungen.find((f: any) => f.monat === 10);
  assert.deepEqual([okt.vkbrutto, okt.reinigung, okt.provision, okt.forderung, okt.einzahlungen, okt.offene_posten], [300, -104, -60, 136, -100, 36]);
  assert.equal(r.body.forderungen.find((f: any) => f.monat === 12).offene_posten, -198);
  assert.equal(r.body.forderungen.find((f: any) => f.monat === 13).offene_posten, -198);

  // Paperless-Beleg automatisch (Auftragsnummer), zweiter manuell per ID
  r = await call('GET', `${C}/belege/kandidaten?jahr=2026&datum=2026-10-07`);
  assert.deepEqual(r.body.kandidaten.map((k: any) => k.doknr), ['301', '302']);
  r = await call('POST', `${C}/belege/alle`, { jahr: 2026 });
  assert.match(r.body.text, /^1 Rechnung/);
  r = await call('POST', `${C}/belege/zuordnen`, { rgnr: 'R-4711', art: 'I', doknr: '301', jahr: 2026 });
  assert.equal(r.status, 400);
  r = await call('POST', `${C}/belege/zuordnen`, { rgnr: 'R-4711', art: 'I', doknr: '302', jahr: 2026 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${C}/rechnung?rgnr=R-4711`);
  assert.deepEqual(r.body.belege.map((b: any) => [b.doknr, b.zuord_art, b.betrag]), [['301', 'A', 151.6], ['302', 'I', 99]]);
  await call('POST', `${C}/belege/loesen`, { rgnr: 'R-4711', doknr: '302' });

  // Umbenennen der Rechnung nimmt die Belege mit
  r = await call('POST', `${C}/rechnung`, { rgnrAlt: 'R-4711', rgnr: 'R-4711A', datum: '2026-11-03', pos });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${C}/init?jahr=2026`);
  assert.equal(r.body.forderungen.find((f: any) => f.monat === 10).vkbrutto, 0);
  assert.equal(r.body.forderungen.find((f: any) => f.monat === 11).vkbrutto, 300);
  r = await call('GET', `${C}/rechnung?rgnr=R-4711A`);
  assert.equal(r.body.belege.length, 1);

  // PDF und Ablage
  r = await call('GET', `${C}/pdf?jahr=2026&monat=11`);
  assert.equal(r.ct, 'application/pdf');
  r = await call('POST', `${C}/paperless`, { jahr: 2026, monat: 11 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /In Paperless abgelegt/);
  r = await call('POST', `${C}/paperless`, { jahr: 2026, monat: 11 });
  assert.match(r.body.text, /Neue Version/);

  // Absatz und Löschen
  r = await call('GET', `${C}/absatz`);
  assert.deepEqual(r.body.rows.map((x: any) => [x.jahr, x.produkt, x.anzahl, x.flaschen]), [[2026, 'KARLSBERG URPILS', 10, 200], [2026, 'PFANDRÜCKGABE', 5, 5]]);
  r = await call('POST', `${C}/rechnung/loeschen`, { rgnr: 'R-4711A' });
  assert.equal(r.status, 200);
  const [n] = await sql`select count(*)::int as n from tco.werg_beleg`;
  assert.equal(n.n, 0);
});
