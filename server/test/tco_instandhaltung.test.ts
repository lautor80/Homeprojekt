/**
 * Integrationstest Instandhaltung / Schadensmeldung (#205): Stammdaten (Wo mit Gruppen, Matrix Kategorie × Ort,
 * Zuständigkeit je Benutzer mit Berechtigung), Melden durch Mitglieder, Anzeige im Arbeitsvorrat und in den Kennzahlen der
 * Vereinsübersicht, Bearbeitung mit Protokoll (Zeitstempel, Benutzer, Aktion), Platzsperre, E-Mails, Formular (PDF mit Fotos)
 * und Ablage in Paperless, Eskalation, Fotofrist, QR-Codes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql, withChange } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const ih = await import('../../modules/tco/server/instandhaltung/logik.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, ct, raw: res.rawPayload };
  };
}
const admin = client();
const T = '/api/m/tco';
// echtes 1×1-PNG (für das Formular-PDF)
const FOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Paperless und Mail-Webhook (n8n) als Attrappe
const mails: { an: string; betreff: string; text: string }[] = [];
const mock = { docs: new Map<number, { versions: number[]; meta: Record<string, unknown>; title?: string; typ?: number; pfad?: number }>(), next: 700, uploads: [] as string[] };
// vorhandene Paperless-Dokumente: FI-Eingangsrechnung, Angebot (Instandhaltung), Aufnahmeantrag (darf nicht verknüpft werden)
mock.docs.set(501, { versions: [], meta: {}, title: 'Rechnung Netzbau GmbH 4711', typ: 3 });
mock.docs.set(503, { versions: [], meta: {}, title: 'Angebot Netzbau GmbH', typ: 5 });
mock.docs.set(502, { versions: [], meta: {}, title: 'Aufnahmeantrag Max Muster', typ: 99 });
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const roh = Buffer.concat(chunks);
    const body = roh.toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = req.url ?? '';
    if (u.startsWith('/webhook/mail')) { mails.push(JSON.parse(body)); return send(200, { status: 'gesendet', message_id: `m${mails.length}` }); }
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    if (u === '/api/documents/post_document/') { mock.uploads.push(roh.toString('latin1')); const id = mock.next++; mock.docs.set(id, { versions: [], meta: {} }); return send(200, `task-${id}`); }
    if ((m = /^\/api\/documents\/(\d+)\/update_version\/$/.exec(u))) { const d = mock.docs.get(Number(m[1])); if (!d) return send(404, {}); const vid = mock.next++; d.versions.push(vid); return send(200, `task-${vid}`); }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (u.startsWith('/api/documents/?')) {
      const q = new URLSearchParams(u.split('?')[1]);
      const typen = (q.get('document_type__id__in') ?? '').split(',').filter(Boolean).map(Number);
      const pfade = (q.get('storage_path__id__in') ?? '').split(',').filter(Boolean).map(Number);
      const t = (q.get('title_content') ?? '').toLowerCase();
      const results = [...mock.docs.entries()].filter(([, d]) => d.title && ((d.typ && typen.includes(d.typ)) || (d.pfad && pfade.includes(d.pfad))) && d.title.toLowerCase().includes(t))
        .map(([id, d]) => ({ id, title: d.title, document_type: d.typ, created: '2026-11-10', custom_fields: [] }));
      return send(200, { results, next: null });
    }
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const art = u.split('/')[2];
      const lists: Record<string, unknown[]> = {
        correspondents: [], document_types: [{ id: 1, name: 'Schadensmeldung' }, { id: 3, name: 'Eingangsrechnung' }, { id: 5, name: 'Angebot' }],
        storage_paths: [{ id: 2, name: 'Instandhaltung' }],
        custom_fields: [{ id: 4, name: 'DOKID', data_type: 'string' }], tags: [],
      };
      return send(200, { results: lists[art], next: null });
    }
    if ((u === '/api/correspondents/' || u === '/api/tags/') && req.method === 'POST') return send(201, { id: 9, name: JSON.parse(body).name });
    if ((m = /^\/api\/documents\/(\d+)\/notes\/$/.exec(u))) return send(200, []);
    if ((m = /^\/api\/documents\/(\d+)\/download\//.exec(u))) { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="beleg.pdf"' }); return res.end('%PDF-1.4 test'); }
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      const id = Number(m[1]); const d = mock.docs.get(id);
      if (!d) return send(404, {});
      if (req.method === 'PATCH') { d.meta = { ...d.meta, ...JSON.parse(body) }; return send(200, {}); }
      return send(200, { id, title: d.title ?? '', document_type: d.typ ?? null, storage_path: d.pfad ?? null, created: '2026-11-10', custom_fields: [], versions: [{ id }, ...d.versions.map((v) => ({ id: v }))] });
    }
    send(404, { u });
  });
});

// je Benutzer eine Sitzung: das Startpasswort lässt sich nur einmal ändern
const sitzungen = new Map<string, ReturnType<typeof client>>();
async function anmelden(name: string) {
  const offen = sitzungen.get(name);
  if (offen) return offen;
  const c = client();
  sitzungen.set(name, c);
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
const uid = async (name: string) => (await sql`select id::text as id from core.users where username = ${name}`)[0].id as string;
const protokollVon = async (id: number) => sql`select v.aktion, v.text, v.von, v.benutzer_id::text as benutzer_id, v.am from tco.ih_verlauf v where meldung_id = ${id} order by am, v.id`;

let mia: Awaited<ReturnType<typeof anmelden>>, tom: Awaited<ReturnType<typeof anmelden>>;
let platz3 = 0, clubhaus = 0, sanitaer = 0, netz = 0, sanKat = 0, adminId = '', hansId = '', tomId = '', miaId = '';

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into core.verbindungen (id, url, auth_art, geheimnis, einstellungen) values ('paperless', ${`http://127.0.0.1:${port}`}, 'token', 'geheim', ${sql.json({ freigabe_url: `http://127.0.0.1:${port}` })})`;
  await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis) values ('mail', ${`http://127.0.0.1:${port}/webhook/mail`}, 'header', 'X-TCO-Key', 'k') on conflict (id) do update set url = excluded.url, auth_art = 'header', header_name = 'X-TCO-Key', geheimnis = excluded.geheimnis`;
  await sql`update core.users set email = 'platzwart@tc-test.example' where username = 'admin'`;
  // Rolle Hallenwart mit der Berechtigung „Schadensmeldungen bearbeiten“
  let r = await admin('POST', '/api/admin/roles', { id: 'IH_HALLENWART', name: 'Hallenwart', permissions: ['tco.instandhaltung:display', 'tco.instandhaltung:edit'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const [u, name, rollen] of [['mia', 'Mia Matchball', ['MITGLIED']], ['tom', 'Tom Tiebreak', ['MITGLIED']], ['hans', 'Hans Hallenwart', ['IH_HALLENWART']]] as const) {
    r = await admin('POST', '/api/admin/users', { username: u, displayName: name, password: 'start-passwort', roles: rollen });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  await sql`update core.users set email = 'mia@tc-test.example' where username = 'mia'`;
  await sql`update core.users set email = 'hans@tc-test.example' where username = 'hans'`;
  adminId = await uid('admin'); hansId = await uid('hans'); tomId = await uid('tom'); miaId = await uid('mia');
  mia = await anmelden('mia');
  tom = await anmelden('tom');
  await sql`insert into tco.plaetze (name, art, aliase, wochentage, zeit_von, zeit_bis, gueltig_von) values ('Platz 3', 'FREI', 'P3', '1234567', '08:00', '22:00', '2020-01-01')`;
  clubhaus = (await sql`select id from tco.ih_anlage where kuerzel = 'clubhaus'`)[0].id;
  sanitaer = (await sql`select id from tco.ih_anlage where kuerzel = 'sanitaer'`)[0].id;
  netz = (await sql`select id from tco.ih_kategorie where bezeichnung = 'Netz/Pfosten'`)[0].id;
  sanKat = (await sql`select id from tco.ih_kategorie where bezeichnung = 'Sanitär'`)[0].id;
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

test('Stammdaten: Wo mit Gruppe, Matrix Kategorie × Ort, Zuständigkeit nur mit Berechtigung', async () => {
  assert.ok((await sql`select 1 from core.role_permissions where role_id = 'MITGLIED' and permission = 'tco.schaden:melden'`).length === 1);
  assert.equal((await sql`select gruppe from tco.ih_anlage where id = ${clubhaus}`)[0].gruppe, 'Clubhaus', 'Gruppe aus dem Typ vorbelegt');
  const [p] = await sql`select id from tco.plaetze where name = 'Platz 3'`;
  let r = await admin('POST', `${T}/instandhaltung/stamm/anlagen`, { kuerzel: 'Platz3', bezeichnung: 'Platz 3', gruppe: 'Außenplätze', typ: 'PLATZ', platz_id: p.id, sort: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  platz3 = r.body.id;
  assert.equal((await admin('POST', `${T}/instandhaltung/stamm/anlagen`, { kuerzel: 'platz3', bezeichnung: 'Doppelt', typ: 'PLATZ' })).status, 400);
  assert.equal((await admin('POST', `${T}/instandhaltung/stamm/anlagen`, { kuerzel: 'mit leer', bezeichnung: 'X', typ: 'PLATZ' })).status, 400);

  // Matrix: neuer Ort hat alle Kategorien; Sanitär auf dem Platz abwählen
  r = await admin('GET', `${T}/instandhaltung/stamm/daten`);
  const paare: [number, number][] = r.body.matrix;
  assert.ok(paare.some(([a, k]) => a === platz3 && k === sanKat));
  r = await admin('PUT', `${T}/instandhaltung/stamm/matrix`, { paare: paare.filter(([a, k]) => !(a === platz3 && k === sanKat)) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select count(*)::int as n from tco.ih_anlage_kategorie where anlage_id = ${platz3} and kategorie_id = ${sanKat}`)[0].n, 0);
  assert.equal((await admin('PUT', `${T}/instandhaltung/stamm/matrix`, { paare: [[99999, netz]] })).status, 400);
  r = await mia('GET', `${T}/schaden/stamm`);
  const p3 = r.body.anlagen.find((a: { id: number }) => a.id === platz3);
  assert.equal(p3.gruppe, 'Außenplätze');
  assert.ok(p3.kategorien.includes(netz) && !p3.kategorien.includes(sanKat));

  // Zuständigkeiten: Platzwart (admin) für Netz/Pfosten überall, Hallenwart für Netz auf Platz 3 (spezifischer)
  assert.equal((await admin('POST', `${T}/instandhaltung/stamm/zustaendig`, { benutzer_id: adminId, kategorie_id: netz })).status, 200);
  assert.equal((await admin('POST', `${T}/instandhaltung/stamm/zustaendig`, { benutzer_id: hansId, anlage_id: platz3, kategorie_id: netz })).status, 200);
  assert.equal((await admin('POST', `${T}/instandhaltung/stamm/zustaendig`, { benutzer_id: hansId, anlage_id: platz3, kategorie_id: netz })).status, 400, 'doppelt');
  r = await admin('POST', `${T}/instandhaltung/stamm/zustaendig`, { benutzer_id: tomId, kategorie_id: netz });
  assert.equal(r.status, 400, 'ohne Berechtigung');
  assert.match(r.body.message, /Berechtigung/);
  assert.equal((await admin('POST', `${T}/instandhaltung/stamm/zustaendig`, { benutzer_id: hansId })).status, 400, 'weder Ort noch Kategorie');
  r = await admin('GET', `${T}/instandhaltung/stamm/daten`);
  assert.equal(r.body.zustaendigkeiten.length, 2);
  assert.deepEqual(r.body.bearbeiter.map((b: { name: string }) => b.name).sort(), ['Admin', 'Hans Hallenwart']);
  assert.ok(r.body.bearbeiter.find((b: { name: string }) => b.name === 'Hans Hallenwart').rollen.includes('Hallenwart'));
  const z = await ih.zustaendigeFuer(sql as never, platz3, netz);
  assert.deepEqual(z.map((x) => x.name), ['Hans Hallenwart', 'Admin'], 'Ort+Kategorie vor nur Kategorie');

  assert.equal((await admin('PUT', `${T}/instandhaltung/stamm/einstellungen`, { vorstand_email: 'kaputt', foto_frist_monate: 24 })).status, 400);
  r = await admin('PUT', `${T}/instandhaltung/stamm/einstellungen`, { vorstand_email: 'vorstand@tc-test.example; vorstand@tc-test.example', foto_frist_monate: 24 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await mia('GET', `${T}/instandhaltung/stamm/daten`)).status, 403);
  assert.equal((await mia('GET', `${T}/instandhaltung`)).status, 403);
});

let m1 = 0, m2 = 0, nr1 = '';
test('Melden: Matrix wird geprüft, Zuständige per E-Mail, sofort im Arbeitsvorrat und in den Kennzahlen', async () => {
  let r = await mia('POST', `${T}/schaden`, { anlage_id: platz3, kategorie_id: sanKat, beschreibung: 'Wasser läuft', auswirkung: 'OPTISCH' });
  assert.equal(r.status, 400, 'Sanitär ist auf Platz 3 nicht zugelassen');
  assert.equal((await mia('POST', `${T}/schaden`, { anlage_id: platz3, kategorie_id: netz, beschreibung: 'Netz', auswirkung: 'SICHERHEIT', fotos: [{ name: 'a.pdf', data: 'data:application/pdf;base64,AAAA' }] })).status, 400);
  r = await mia('POST', `${T}/schaden`, {
    anlage_id: platz3, kategorie_id: netz, beschreibung: 'Netzpfosten wackelt stark, droht umzufallen', auswirkung: 'SICHERHEIT', fotos: [{ name: 'pfosten.png', data: FOTO }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  m1 = r.body.id; nr1 = r.body.nummer;
  assert.match(nr1, /^SM-\d{4}-\d{4}$/);
  const [m] = await sql`select status, melder_name, zustaendig::text as zustaendig from tco.ih_meldung where id = ${m1}`;
  assert.deepEqual([m.status, m.melder_name, m.zustaendig], ['NEU', 'Mia Matchball', hansId], 'Hauptzuständiger: Ort + Kategorie');
  // E-Mail an alle Zuständigen und (Sicherheitsrisiko) den Vorstand – im Protokoll vermerkt
  const neu = mails.at(-1)!;
  assert.equal(neu.an, 'hans@tc-test.example, platzwart@tc-test.example, vorstand@tc-test.example');
  assert.match(neu.betreff, /SICHERHEITSRISIKO/);
  const prot = await protokollVon(m1);
  assert.deepEqual(prot.map((x) => x.aktion), ['ANGELEGT', 'ZUSTAENDIG', 'FOTO', 'MAIL']);
  assert.equal(prot[0].benutzer_id, miaId, 'Benutzer im Protokoll');
  assert.ok(prot.every((x) => x.am instanceof Date), 'Zeitstempel');

  r = await tom('POST', `${T}/schaden`, { anlage_id: sanitaer, kategorie_id: sanKat, beschreibung: 'Wasserhahn tropft in der Herrenumkleide', auswirkung: 'OPTISCH' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  m2 = r.body.id;
  assert.equal(mails.at(-1)!.an, 'vorstand@tc-test.example', 'ohne Zuständigkeit an den Vorstand');

  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ihA = r.body.filter((a: { bereich: string }) => a.bereich === 'Instandhaltung');
  assert.deepEqual(ihA.map((a: { key: string }) => a.key), [`SCHADEN:${m1}`, `SCHADEN:${m2}`]);
  assert.equal(ihA[0].state, 'Negative');
  assert.match(ihA[0].titel, /^Sicherheitsrisiko: Platz 3 – Netz\/Pfosten$/);
  assert.match(ihA[0].text, /zuständig: Hans Hallenwart/);
  assert.equal((await mia('GET', `${T}/dashboard/arbeitsvorrat`)).status, 403);
  // Arbeitsvorrat der Startseite (#232, V2): ohne das Recht der Vereinsübersicht – jeder sieht die Einträge seiner Apps
  assert.equal((await client()('GET', '/api/arbeitsvorrat')).status, 401, 'nur angemeldet');
  const hansSitzung = await anmelden('hans');
  const hansStart = await hansSitzung('GET', '/api/arbeitsvorrat');
  assert.equal(hansStart.status, 200, JSON.stringify(hansStart.body));
  assert.deepEqual(hansStart.body.gruppen.map((g: { modul: string; name: string }) => [g.modul, g.name]), [['tco', 'TC Oberthal']], 'Gruppen ohne Einträge entfallen');
  assert.deepEqual(hansStart.body.gruppen[0].aufgaben.map((a: { key: string }) => a.key), [`SCHADEN:${m1}`, `SCHADEN:${m2}`]);
  assert.equal((await hansSitzung('GET', `${T}/dashboard/arbeitsvorrat`)).status, 403, 'die Vereinsübersicht bleibt an ihr Recht gebunden');
  const miaStart = await mia('GET', '/api/arbeitsvorrat');
  assert.deepEqual([miaStart.status, miaStart.body], [200, { gruppen: [] }], 'Mitglied ohne Bearbeiter-Apps: leer');
  const adminStart = await admin('GET', '/api/arbeitsvorrat');
  assert.deepEqual(adminStart.body.gruppen.find((g: { modul: string }) => g.modul === 'tco').aufgaben.map((a: { key: string }) => a.key),
    r.body.map((a: { key: string }) => a.key), 'dieselben Einträge wie in der Vereinsübersicht');
  r = await admin('GET', `${T}/dashboard`);
  const k = (key: string) => r.body.bereiche.find((b: { key: string }) => b.key === 'INSTANDHALTUNG').kpis.find((x: { key: string }) => x.key === key);
  assert.equal(k('IH_OFFEN').value, '2');
  assert.equal(k('IH_SICHER').value, '1');
});

test('Doppelmeldungen, Meine Meldungen, Fotos nur für Melder und Bearbeiter', async () => {
  let r = await tom('GET', `${T}/schaden/offen?anlage=${platz3}`);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].melder_name, undefined, 'ohne Melder');
  r = await mia('GET', `${T}/schaden/meine`);
  assert.equal(r.body.length, 1);
  const fotoId = r.body[0].fotos[0].id;
  assert.equal((await mia('GET', `${T}/schaden/foto/${fotoId}`)).ct, 'image/png');
  assert.equal((await tom('GET', `${T}/schaden/foto/${fotoId}`)).status, 404);
  assert.equal((await admin('GET', `${T}/schaden/foto/${fotoId}`)).status, 200);
});

test('Bearbeiten: jede Änderung im Protokoll, Zuständiger nur mit Berechtigung, Platzsperre', async () => {
  const P = `${T}/instandhaltung/${m1}`;
  assert.equal((await admin('PUT', P, { status: 'DUPLIKAT' })).status, 400);
  assert.equal((await admin('PUT', P, { status: 'ABGELEHNT' })).status, 400);
  assert.equal((await admin('PUT', P, { status: 'IN_ARBEIT', zustaendig: tomId })).status, 400, 'Tom hat keine Berechtigung');
  const vorher = (await protokollVon(m1)).length;
  let r = await admin('PUT', P, { status: 'IN_ARBEIT', zustaendig: hansId, kosten: 80, firma: 'Netzbau GmbH', kommentar: 'Pfosten abgesperrt', fuer_melder: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const neu = (await protokollVon(m1)).slice(vorher);
  assert.deepEqual(neu.map((x) => [x.aktion, x.text]), [
    ['STATUS', 'Neu → In Arbeit'], ['FELD', 'Istkosten: – → 80,00 €'], ['FELD', 'Fremdfirma: – → Netzbau GmbH'], ['KOMMENTAR', 'Pfosten abgesperrt'],
  ]);
  assert.ok(neu.every((x) => x.benutzer_id === adminId && x.von === 'Admin'));

  r = await admin('POST', `${P}/sperre`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('POST', `${P}/sperre`)).status, 400);
  r = await admin('GET', P);
  assert.ok(r.body.sperre_id);
  assert.equal(r.body.protokoll.at(-1).aktion_txt, 'Platzsperre');
  assert.deepEqual(r.body.zustaendige.map((z: { name: string }) => z.name), ['Hans Hallenwart', 'Admin']);
  assert.equal((await admin('POST', `${T}/instandhaltung/${m2}/sperre`)).status, 400, 'kein Platz');
  r = await admin('DELETE', `${P}/sperre`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select count(*)::int as n from tco.platzbelegungen`)[0].n, 0);
  assert.equal((await admin('POST', `${P}/fotos`, { fotos: [{ name: 'neu.png', data: FOTO }] })).status, 200);
  assert.equal((await admin('POST', `${P}/kommentar`, { text: 'Ersatzteil bestellt', fuer_melder: false })).status, 200);
});

test('Priorität, geplantes Ende (überfällig), Paperless-Dokumente mit FI-Verknüpfung', async () => {
  const P = `${T}/instandhaltung/${m1}`;
  assert.equal((await sql`select prioritaet from tco.ih_meldung where id = ${m1}`)[0].prioritaet, 'SEHR_HOCH', 'aus der Auswirkung vorbelegt');
  const vorher = (await protokollVon(m1)).length;
  let r = await admin('PUT', P, { status: 'IN_ARBEIT', zustaendig: hansId, kosten: 80, firma: 'Netzbau GmbH', prioritaet: 'HOCH', geplant_bis: '2020-01-01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await protokollVon(m1)).slice(vorher).map((x) => x.text), ['Priorität: Sehr hoch → Hoch', 'Geplantes Ende: – → 01.01.2020']);
  assert.equal((await admin('PUT', P, { status: 'IN_ARBEIT', zustaendig: hansId, ende_ist: '2020-01-02' })).status, 400, 'Enddatum erst beim Abschluss');
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.match(r.body.find((a: { key: string }) => a.key === `SCHADEN:${m1}`).text, /Priorität Hoch.*überfällig seit 01\.01\.2020/);
  r = await admin('GET', `${T}/instandhaltung`);
  const z = r.body.zeilen.find((x: { id: number }) => x.id === m1);
  assert.deepEqual([z.prioritaet_txt, z.geplant_bis, z.ueberfaellig], ['Hoch', '2020-01-01', true]);

  // Auswahldialog: nur Dokumente der Instandhaltung und FI-Belege
  r = await admin('GET', `${T}/instandhaltung/paperless/suche?q=netzbau`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((d: { id: number }) => d.id).sort(), [501, 503]);
  assert.equal((await admin('GET', `${T}/instandhaltung/paperless/502`)).status, 404, 'Aufnahmeantrag gehört nicht dazu');
  assert.equal((await admin('POST', `${P}/dokumente`, { doc_ids: [502] })).status, 404);
  assert.equal((await mia('GET', `${T}/instandhaltung/paperless/suche`)).status, 403);
  // Rechnung ist zugleich einer FI-Buchung zugeordnet
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, soll, haben) values ('0000000777', '1000', 0, 2026, 11, '2026-11-12', 'Netzbau GmbH Rechnung 4711', 80, 0, 80)`;
  await sql`insert into tco.fipapermap (internenr, konto, doknr) values ('0000000777', '', '000501')`;
  r = await admin('POST', `${P}/dokumente`, { doc_ids: [501, 503, 501], art: 'RECHNUNG' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('GET', P);
  const doks = r.body.dokumente;
  assert.deepEqual(doks.map((d: { doc_id: number }) => d.doc_id), [501, 503]);
  assert.deepEqual(doks.find((d: { doc_id: number }) => d.doc_id === 501).fi, ['0000000777']);
  assert.equal(doks[0].titel, 'Rechnung Netzbau GmbH 4711');
  assert.ok(r.body.protokoll.some((x: { aktion: string; text: string }) => x.aktion === 'DOKUMENT' && /000501 \(Rechnung\)/.test(x.text)));
  // FI-Beleg zeigt die Meldung als verknüpftes Objekt mit Absprung
  r = await admin('GET', `${T}/fi/buchung/0000000777`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.objekte.map((o: { nummer: string; pfad: string }) => [o.nummer, o.pfad]), [[nr1, `/tco/instandhaltung?id=${m1}`]]);
  // Anzeige nur verknüpfter Dokumente
  r = await admin('GET', `${T}/instandhaltung/dokument/503/pdf`);
  assert.equal(r.status, 200, String(r.body));
  assert.equal((await admin('GET', `${T}/instandhaltung/dokument/502/pdf`)).status, 404);
  // lösen
  assert.equal((await admin('DELETE', `${P}/dokumente/503`)).status, 200);
  assert.deepEqual((await admin('GET', P)).body.dokumente.map((d: { doc_id: number }) => d.doc_id), [501]);
});

test('Listenvarianten je Benutzer: sichern, Standard, laden, global nur mit Stammdatenrecht', async () => {
  const hans = await anmelden('hans');
  const ansicht = { alle: true, suche: 'netz', filter: { prioritaet: 'Hoch' }, sort: { k: 'geplant', ab: true } };
  let r = await hans('POST', `${T}/instandhaltung/varianten`, { name: 'Meine Plätze', standard: true, ansicht });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await hans('POST', `${T}/instandhaltung/varianten`, { name: 'Für alle', global: true, ansicht })).status, 403);
  r = await hans('POST', `${T}/instandhaltung/varianten`, { name: 'Zweite', standard: true, ansicht: { ...ansicht, alle: false } });
  assert.equal(r.status, 200);
  r = await hans('GET', `${T}/instandhaltung/varianten`);
  assert.deepEqual(r.body.varianten.map((v: { name: string; standard: boolean }) => [v.name, v.standard]), [['Meine Plätze', false], ['Zweite', true]]);
  assert.equal(r.body.standard.name, 'Zweite');
  assert.deepEqual(r.body.varianten[0].ansicht, ansicht);
  // andere Benutzer sehen die Varianten nicht, globale Varianten (Admin) schon
  assert.equal((await admin('GET', `${T}/instandhaltung/varianten`)).body.varianten.length, 0);
  assert.equal((await admin('POST', `${T}/instandhaltung/varianten`, { name: 'Alle offenen', global: true, standard: true, ansicht })).status, 200);
  r = await hans('GET', `${T}/instandhaltung/varianten`);
  assert.equal(r.body.varianten.length, 3);
  assert.equal(r.body.standard.name, 'Zweite', 'eigene Standardvariante vor globaler');
  assert.equal((await hans('DELETE', `${T}/instandhaltung/varianten`, { key: '*/Alle offenen' })).status, 403);
  assert.equal((await hans('DELETE', `${T}/instandhaltung/varianten`, { key: 'hans/Zweite' })).status, 200);
  assert.equal((await hans('GET', `${T}/instandhaltung/varianten`)).body.standard.name, 'Alle offenen');
});

test('Formular: PDF im TCO-Design mit Fotos, Weitergabe und Abschluss in Paperless (neue Version)', async () => {
  const P = `${T}/instandhaltung/${m1}`;
  assert.equal((await admin('GET', `${P}/formular.pdf?anlass=WEITERGABE`)).status, 400, 'Empfänger fehlt');
  let r = await admin('GET', `${P}/formular.pdf?anlass=WEITERGABE&an=${encodeURIComponent('Netzbau GmbH')}&bemerkung=Bitte%20bis%20Freitag`);
  assert.equal(r.status, 200, String(r.body));
  assert.equal(r.ct, 'application/pdf');
  assert.equal(r.raw.subarray(0, 4).toString(), '%PDF');
  assert.ok(r.raw.length > 3000);
  assert.equal((await mia('GET', `${P}/formular.pdf`)).status, 403);

  r = await admin('POST', `${P}/formular`, { anlass: 'WEITERGABE', an: 'Netzbau GmbH', bemerkung: 'Bitte bis Freitag' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const doc = Number(r.body.dokid);
  assert.ok(mock.docs.has(doc));
  assert.ok(mock.uploads.at(-1)!.includes('%PDF'));
  assert.match(JSON.stringify(mock.docs.get(doc)!.meta), new RegExp(nr1));
  assert.equal((await sql`select formular_doc_id from tco.ih_meldung where id = ${m1}`)[0].formular_doc_id, doc);
  let prot = await protokollVon(m1);
  assert.equal(prot.at(-1)!.aktion, 'FORMULAR');
  assert.match(prot.at(-1)!.text, /Weitergabe an Netzbau GmbH.*DOKID/);

  // Abschluss: Status Erledigt (Mail an Melder), Formular wird neue Version desselben Dokuments
  const vorher = mails.length;
  r = await admin('PUT', P, { status: 'ERLEDIGT', zustaendig: hansId, erledigung: 'Pfosten neu einbetoniert', kosten: 80, firma: 'Netzbau GmbH', stunden: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mails.length, vorher + 1);
  assert.equal(mails.at(-1)!.an, 'mia@tc-test.example');
  assert.match(mails.at(-1)!.betreff, /ist erledigt/);
  r = await admin('POST', `${P}/formular`, { anlass: 'ABSCHLUSS' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Number(r.body.dokid), doc);
  assert.equal(mock.docs.get(doc)!.versions.length, 1);
  prot = await protokollVon(m1);
  assert.match(prot.at(-1)!.text, /Abschluss.*neue Version/);

  // Melder sieht Status und freigegebene Einträge – nicht interne Kommentare
  r = await mia('GET', `${T}/schaden/meine`);
  assert.equal(r.body[0].status, 'ERLEDIGT');
  const texte = r.body[0].verlauf.map((v: { text: string | null }) => v.text);
  assert.ok(texte.includes('Pfosten abgesperrt'));
  assert.ok(!texte.includes('Ersatzteil bestellt'));
  assert.ok(!texte.some((t: string | null) => /DOKID/.test(t ?? '')), 'Formular ist intern');
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.ok(!r.body.some((a: { key: string }) => a.key === `SCHADEN:${m1}`));
  assert.equal((await admin('PUT', P, { status: 'ABGELEHNT', erledigung: 'doch nicht' })).status, 400);
  r = await admin('PUT', `${T}/instandhaltung/${m2}`, { status: 'DUPLIKAT', duplikat_von: m1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('GET', `${T}/instandhaltung`)).body.zeilen.length, 0);
  assert.ok((await sql`select 1 from core.change_header where object_type = 'SCHADEN' limit 1`).length === 1);
  assert.ok((await sql`select 1 from core.change_header where object_type = 'IH_ZUSTAENDIG' limit 1`).length === 1);
});

test('Lauf: Erinnerung bei Sicherheitsrisiko nach 24 h, Fotos erledigter Meldungen nach Frist löschen – beides im Protokoll', async () => {
  const r = await mia('POST', `${T}/schaden`, { anlage_id: clubhaus, kategorie_id: netz, beschreibung: 'Stromkabel liegt offen an der Terrasse', auswirkung: 'SICHERHEIT' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ctx = { userId: null, username: 'test', action: 'TEST' };
  let l = await withChange(ctx, (tx) => ih.lauf(tx as never));
  assert.deepEqual(l.erinnert, []);
  await sql`update tco.ih_meldung set status_am = now() - interval '25 hours' where id = ${r.body.id}`;
  l = await withChange(ctx, (tx) => ih.lauf(tx as never));
  assert.deepEqual(l.erinnert, [r.body.nummer]);
  assert.equal(l.mails[0].an, 'platzwart@tc-test.example, vorstand@tc-test.example');
  l = await withChange(ctx, (tx) => ih.lauf(tx as never));
  assert.deepEqual(l.erinnert, []);
  assert.equal((await sql`select count(*)::int as n from tco.ih_anhang where meldung_id = ${m1}`)[0].n, 2);
  await sql`update tco.ih_meldung set erledigt_am = now() - interval '25 months' where id = ${m1}`;
  l = await withChange(ctx, (tx) => ih.lauf(tx as never));
  assert.equal(l.fotosGeloescht, 2);
  assert.equal((await protokollVon(m1)).at(-1)!.aktion, 'FOTOFRIST');
  assert.ok((await protokollVon(r.body.id)).some((x) => x.aktion === 'ERINNERUNG'));
});

test('QR-Codes: Portal-Adresse nötig, dann PDF', async () => {
  assert.equal((await admin('GET', `${T}/instandhaltung/stamm/qr.pdf`)).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { 'portal.url': 'https://portal.example.org' })).status, 200);
  const r = await admin('GET', `${T}/instandhaltung/stamm/qr.pdf?anlage=${platz3}`);
  assert.equal(r.status, 200);
  assert.equal(r.raw.subarray(0, 4).toString(), '%PDF');
  assert.equal((await mia('GET', `${T}/instandhaltung/stamm/qr.pdf`)).status, 403);
});
