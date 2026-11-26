/**
 * Euroflex: Belege beim Drucken und Versenden automatisch in Paperless ablegen (Funktion transport.paperless.automatisch).
 * Regeln ohne Datenbank; Ablauf mit nachgestelltem Paperless gegen die Test-Datenbank.
 *   TEST_DATABASE_URL=postgres://portal:portal@localhost:5432/portal_test npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ablegenNoetig, auftragAusKennung, belegAusDateiname, belegeEindeutig, belegName } from '../../modules/transport/server/archiv-logik.js';

// ---------------------------------------------------------------- Regeln (ohne Datenbank)
test('Belege erkennen: Dateiname, Auftrag zur Fahrt, eindeutig', () => {
  assert.deepEqual(belegAusDateiname('Transportauftrag_2026_9301-2.pdf'), { art: 'T', kennung: '2026_9301-2' });
  assert.deepEqual(belegAusDateiname('Lieferschein_2026_9301.pdf'), { art: 'L', kennung: '2026_9301' });
  assert.deepEqual(belegAusDateiname('rechnung_2026_9501.PDF'), { art: 'R', kennung: '2026_9501' });
  assert.equal(belegAusDateiname('CMR_2026_9301.pdf'), null);
  assert.equal(belegAusDateiname('Lieferschein_2026_9301.jpg'), null);
  assert.equal(belegName({ art: 'T', kennung: '2026_9301-2' }), 'Transportauftrag_2026_9301-2.pdf');
  assert.equal(auftragAusKennung('2026_9301-2'), '2026_9301');
  assert.equal(auftragAusKennung('2026_9301'), '2026_9301');
  assert.deepEqual(belegeEindeutig([{ art: 'L', kennung: 'a' }, { art: 'T', kennung: 'a' }, { art: 'L', kennung: 'a' }]), [{ art: 'L', kennung: 'a' }, { art: 'T', kennung: 'a' }]);
});

test('Ablegen nur beim ersten Mal und nach einer Änderung am Auftrag', () => {
  const t = (s: string) => new Date(`2026-11-19T${s}:00Z`);
  assert.equal(ablegenNoetig(null, t('10:00')), true);
  assert.equal(ablegenNoetig({ stand: t('10:00') }, t('10:00')), false);
  assert.equal(ablegenNoetig({ stand: t('10:00') }, t('09:00')), false);
  assert.equal(ablegenNoetig({ stand: t('10:00') }, t('10:05')), true);
  assert.equal(ablegenNoetig({ stand: t('10:00') }, t('09:00'), true), true, 'erzwingen (Versenden → Paperless)');
});

test('Druck, Versand und Funktionsschalter sind angebunden', () => {
  const lesen = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const index = lesen('modules/transport/server/index.ts');
  assert.match(index, /app\.post\('\/archiv'/);
  assert.match(index, /belegeImHintergrund\(versendeteBelege\(dateien\)/, 'E-Mail zum Auftrag');
  assert.equal(lesen('modules/transport/server/sammelversand.ts').match(/belegeImHintergrund\(versendet,/g)?.length, 2, 'Sammelversand und E-Mail-Dateien');
  assert.match(lesen('modules/transport/web/dialogs.tsx'), /belegeAblegen\(docs\./, 'PDF-Vorschau „Drucken“');
  assert.match(lesen('modules/transport/web/AuftragDetail.tsx'), /belegeAblegen\(\[\{ art: 'R'/, 'Rechnung drucken im Auftrag');
  assert.match(lesen('modules/transport/server/funktionen.ts'), /'transport\.paperless\.automatisch'/);
});

// ---------------------------------------------------------------- Ablauf mit Datenbank
const url = process.env.TEST_DATABASE_URL;
const mitDb = !!url && /test/i.test(url.split('/').pop() ?? '');
if (mitDb) {
  process.env.DATABASE_URL = url;
  process.env.PORTAL_MODULES = 'transport';
}
const NR = '2026_9301';

// nachgestellt: Paperless
const pl = { uploads: [] as { titel: string; datei: string; tags: string[]; correspondent: string | null }[], tags: [] as { id: number; name: string }[],
  korrespondenten: [] as { id: number; name: string }[], next: 900,
  versionen: [] as { doc: number; label: string; datei: string }[], geloescht: new Set<number>(), aktualisiert: [] as number[], rechte: [] as { doc: number; patch: Record<string, unknown> }[] };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = decodeURIComponent(req.url ?? '');
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    const feld = (n: string) => [...body.matchAll(new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)\\r\\n`, 'g'))].map((x) => x[1]);
    if (u === '/api/documents/post_document/') {
      const id = pl.next++;
      pl.uploads.push({ titel: Buffer.from(feld('title')[0] ?? '', 'latin1').toString('utf8'), datei: /filename="([^"]+)"/.exec(body)?.[1] ?? '', tags: feld('tags'), correspondent: feld('correspondent')[0] ?? null });
      return send(200, `task-${id}`);
    }
    if (req.method === 'POST' && (m = /^\/api\/documents\/(\d+)\/update_version\/$/.exec(u))) {
      if (pl.geloescht.has(Number(m[1]))) return send(404, { detail: 'Not found.' });
      const id = pl.next++;
      pl.versionen.push({ doc: Number(m[1]), label: Buffer.from(feld('version_label')[0] ?? '', 'latin1').toString('utf8'), datei: /filename="([^"]+)"/.exec(body)?.[1] ?? '' });
      return send(200, `task-${id}`);
    }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (req.method === 'GET' && (m = /^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.exec(u))) {
      const l: Record<string, unknown[]> = { correspondents: pl.korrespondenten, tags: pl.tags, document_types: [], storage_paths: [], custom_fields: [] };
      return send(200, { results: l[m[1]], next: null });
    }
    if (req.method === 'POST' && (m = /^\/api\/(correspondents|tags)\/$/.exec(u))) {
      const neu = { id: pl.next++, name: JSON.parse(Buffer.from(body, 'latin1').toString('utf8')).name as string };
      (m[1] === 'tags' ? pl.tags : pl.korrespondenten).push(neu);
      return send(201, neu);
    }
    if (/^\/api\/documents\/\d+\/notes\/$/.test(u)) return send(200, []);
    // Benutzer und Gruppen für die Berechtigungen (Eigentümer admin, Benutzer und Gruppe Euroflex)
    if (req.method === 'GET' && u.startsWith('/api/users/')) return send(200, { results: [{ id: 3, username: 'admin' }, { id: 7, username: 'euroflex' }], next: null });
    if (req.method === 'GET' && u.startsWith('/api/groups/')) return send(200, { results: [{ id: 5, name: 'Euroflex' }], next: null });
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      if (pl.geloescht.has(Number(m[1]))) return send(404, { detail: 'Not found.' });
      if (req.method === 'PATCH') {
        pl.aktualisiert.push(Number(m[1]));
        const patch = JSON.parse(Buffer.from(body, 'latin1').toString('utf8') || '{}') as Record<string, unknown>;
        if (patch.set_permissions) pl.rechte.push({ doc: Number(m[1]), patch });
      }
      return send(200, { id: Number(m[1]), custom_fields: [], tags: [] });
    }
    send(404, { u });
  });
});

if (mitDb) {
  const { sql } = await import('../src/db.js');
  const { migrate } = await import('../src/migrate.js');
  const { activeModules } = await import('../src/modules.js');
  const { buildApp } = await import('../src/app.js');
  const { ablageFertig } = await import('../../modules/transport/server/archiv.js');

  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = '';
  const call = async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: String(res.headers['content-type'] ?? '').includes('json') ? JSON.parse(res.body) : res.body };
  };
  const T = '/api/m/transport';
  const ablegen = async (belege: { art: 'T' | 'L'; kennung: string }[], anlass = 'druck') => {
    const r = await call('POST', `${T}/archiv`, { belege, anlass });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await ablageFertig();
    return r.body as { geplant: number };
  };

  before(async () => {
    await sql.unsafe(`drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                      drop table if exists public.schema_migrations;`);
    await migrate(activeModules(), () => {});
    app = await buildApp({ logger: false });
    await call('POST', '/api/setup', { orgName: 'Euroflex', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    await sql`insert into transport.adressen (adrnr, kundenname, ort, land) values (93011, 'Holzhandel Amsel', 'Oberthal', 'DE'), (93012, 'Spedition Kranich', 'Tholey', 'DE')`;
    await sql`insert into transport.auftraege (auftragsnr, kunde, unternehmer, kennzeichen, leistungsdatum) values (${NR}, 93011, 93012, 'WND-AM 1', '2026-11-18')`;
    await sql`insert into transport.stops (auftragsnr, pos, firma, plzort, firma_e, plzort_e) values (${NR}, 1, 'Holzhandel Amsel', '66649 Oberthal', 'Lager Zeder', '66636 Tholey')`;
  });
  after(async () => {
    await app?.close();
    await sql.end();
    server.close();
  });

  test('ohne eingerichtetes Paperless wird nichts abgelegt', async () => {
    assert.equal((await ablegen([{ art: 'L', kennung: NR }])).geplant, 0);
    assert.equal(pl.uploads.length, 0);
  });

  test('Drucken legt Transportauftrag und Lieferschein ab, ordnet sie dem Auftrag zu – erneut nur nach einer Änderung', async () => {
    const port = (server.address() as AddressInfo).port;
    const v = await call('PUT', '/api/verbindungen/transport.paperless', { url: `http://127.0.0.1:${port}`, geheimnis: 'geheim' });
    assert.equal(v.status, 200, JSON.stringify(v.body));

    assert.equal((await ablegen([{ art: 'T', kennung: NR }, { art: 'L', kennung: NR }, { art: 'L', kennung: NR }])).geplant, 2);
    assert.deepEqual(pl.uploads.map((x) => [x.titel, x.datei]), [[`Transportauftrag ${NR}`, `Transportauftrag_${NR}.pdf`], [`Lieferschein ${NR}`, `Lieferschein_${NR}.pdf`]]);
    // Korrespondent: Unternehmer beim Transportauftrag, Kunde beim Lieferschein; Tag „Auftrag …“
    const kName = (id: string | null) => pl.korrespondenten.find((k) => String(k.id) === id)?.name;
    assert.equal(kName(pl.uploads[0].correspondent), 'Spedition Kranich');
    // Berechtigungen jedes Euroflex-Dokuments: Eigentümer admin, Anzeigen/Bearbeiten Benutzer und Gruppe Euroflex
    for (const r of pl.rechte) {
      assert.deepEqual(r.patch, { owner: 3, set_permissions: { view: { users: [7], groups: [5] }, change: { users: [7], groups: [5] } } });
    }
    assert.ok(pl.rechte.length >= 2, 'für beide Belege');
    assert.equal(kName(pl.uploads[1].correspondent), 'Holzhandel Amsel');
    assert.equal(pl.tags.find((t) => String(t.id) === pl.uploads[0].tags[0])?.name, `Auftrag ${NR}`);
    const docs = await sql`select doc_id, datei from transport.auftrag_dokumente where auftragsnr = ${NR} order by doc_id`;
    assert.deepEqual(docs.map((d) => d.datei), [`Transportauftrag_${NR}.pdf`, `Lieferschein_${NR}.pdf`]);
    const belege = await sql`select art, kennung, doc_id, anlass from transport.paperless_belege order by art`;
    assert.deepEqual(belege.map((b) => [b.art, b.kennung, b.doc_id, b.anlass]), [['L', NR, docs[1].doc_id, 'druck'], ['T', NR, docs[0].doc_id, 'druck']]);

    // noch einmal drucken: unveränderter Auftrag – kein weiteres Dokument
    await ablegen([{ art: 'T', kennung: NR }, { art: 'L', kennung: NR }]);
    assert.equal(pl.uploads.length, 2);

    // Auftrag geändert → beim nächsten Versand neue Version am vorhandenen Dokument, kein zweites Dokument
    await new Promise((ok) => setTimeout(ok, 20));
    await sql`update transport.auftraege set kennzeichen = 'WND-AM 2' where auftragsnr = ${NR}`;
    await ablegen([{ art: 'L', kennung: NR }], 'versand');
    assert.equal(pl.uploads.length, 2, 'kein neues Dokument');
    assert.equal(pl.versionen.length, 1);
    assert.equal(pl.versionen[0].doc, docs[1].doc_id);
    assert.equal(pl.versionen[0].datei, `Lieferschein_${NR}.pdf`);
    assert.match(pl.versionen[0].label, /^Versand \d\d\.\d\d\.\d{4} \d\d:\d\d$/);
    assert.ok(pl.aktualisiert.includes(docs[1].doc_id), 'Metadaten am Dokument aktualisiert');
    const [l] = await sql`select anlass, doc_id from transport.paperless_belege where art = 'L' and kennung = ${NR}`;
    assert.equal(l.anlass, 'versand');
    assert.equal(l.doc_id, docs[1].doc_id);
    assert.equal((await sql`select 1 from transport.auftrag_dokumente where auftragsnr = ${NR}`).length, 2, 'im Auftrag weiterhin ein Eintrag je Beleg');

    // Neudruck nach weiterer Änderung: wieder Version, Bezeichnung „Neudruck …“
    await new Promise((ok) => setTimeout(ok, 20));
    await sql`update transport.auftraege set kennzeichen = 'WND-AM 3' where auftragsnr = ${NR}`;
    await ablegen([{ art: 'T', kennung: NR }]);
    assert.equal(pl.uploads.length, 2);
    assert.deepEqual(pl.versionen.map((x) => x.doc), [docs[1].doc_id, docs[0].doc_id]);
    assert.match(pl.versionen[1].label, /^Neudruck /);

    // Dokument in Paperless gelöscht → neues Dokument, Beleg zeigt darauf
    pl.geloescht.add(docs[0].doc_id);
    await new Promise((ok) => setTimeout(ok, 20));
    await sql`update transport.auftraege set kennzeichen = 'WND-AM 4' where auftragsnr = ${NR}`;
    await ablegen([{ art: 'T', kennung: NR }]);
    assert.equal(pl.uploads.length, 3);
    assert.equal(pl.uploads[2].datei, `Transportauftrag_${NR}.pdf`);
    const [t] = await sql`select doc_id from transport.paperless_belege where art = 'T' and kennung = ${NR}`;
    assert.notEqual(t.doc_id, docs[0].doc_id);
  });

  test('Funktion abgeschaltet: Drucken legt nichts ab', async () => {
    assert.equal((await call('PUT', '/api/funktionen', { id: 'transport.paperless.automatisch', aktiv: false })).status, 200);
    const r = await call('POST', `${T}/archiv`, { belege: [{ art: 'T', kennung: NR }] });
    assert.equal(r.status, 403);
    assert.equal((await call('PUT', '/api/funktionen', { id: 'transport.paperless.automatisch', aktiv: true })).status, 200);
  });
}
