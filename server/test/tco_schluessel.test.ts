/**
 * Integrationstest Hallenschlüssel (#215): Ausgabe mit Rechnungsposition, Beleg in Paperless und Quittungslink; Online-Quittung
 * des Kunden; Rückgabe mit Gutschrift (negativer Betrag) und Empfangsbestätigung des TCO; Storno; Vorgang aus der Hallenabrechnung;
 * Altdaten per Copy & Paste mit Buchung auf das Kassenkonto und Belegverknüpfung; Arbeitsvorrat; Berechtigungen;
 * Abgleich mit früheren Kontobewegungen (FI-Belege) auf zwei Konten.
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
const halle = await import('../../modules/tco/server/halle/daten.js');
const { heute, addTage } = await import('../../modules/tco/server/format.js');

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
// Paperless und Mail-Webhook (n8n) als Attrappe
const mails: { an: string; betreff: string; text: string }[] = [];
const mock = { docs: new Map<number, { versions: number[]; meta: Record<string, unknown>; title?: string; typ?: number; pfad?: number }>(), next: 700, uploads: [] as string[] };
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
        correspondents: [], document_types: [{ id: 1, name: 'Hallenschlüssel' }],
        storage_paths: [{ id: 2, name: 'Tennishalle' }],
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


async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
const S = `${T}/schluessel`;
const MIA = '0000000301', TOM = '0000000302', LEA = '0000000303';
const protokollVon = async (id: number) => (await sql`select aktion from tco.schluessel_verlauf where vorgang_id = ${id} order by am, id`).map((r) => r.aktion as string);
const vorgang = async (id: number) => (await sql`select *, datum::text as tag from tco.schluessel_vorgang where id = ${id}`)[0];
const bestand = async (adrnr: string) => {
  const [b] = await sql`select ausgabe::text as ausgabe, ruecknahme::text as ruecknahme, ausgabebeleg, ruecknahmebeleg from tco.schluessel where adrnr = ${adrnr}`;
  return b ? { ausgabe: b.ausgabe, ruecknahme: b.ruecknahme, ausgabebeleg: b.ausgabebeleg, ruecknahmebeleg: b.ruecknahmebeleg } : undefined;
};
let mia: Awaited<ReturnType<typeof anmelden>>;
let H = '';

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
  assert.equal((await admin('PUT', '/api/settings', { 'portal.url': 'https://portal.example.org' })).status, 200);
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, strasse, plz, ort, email) values
    (${MIA}, 'Mia', 'Matchball', '2020-01-01', 'Am Netz 1', '66649', 'Oberthal', 'mia@tc-test.example'),
    (${TOM}, 'Tom', 'Tiebreak', '2020-01-01', 'Grundlinie 2', '66649', 'Oberthal', null),
    (${LEA}, 'Lea', 'Lob', '2015-01-01', 'T-Feld 3', '66649', 'Oberthal', null)`;
  await sql`insert into tco.fikonten (konto, name) values ('1000', 'Kasse'), ('1590', 'Pfand Hallenschlüssel') on conflict do nothing`;
  await sql`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ, erloeskonto) values
    ('008', '2015-01-01', '9999-12-31', 'Hallenschlüssel Pfand Ausgabe', 25, '3', '1590'), ('009', '2015-01-01', '9999-12-31', 'Hallenschlüssel Pfand Rücknahme', 25, '3', '1590')`;
  const r = await admin('POST', '/api/admin/users', { username: 'mia', displayName: 'Mia Matchball', password: 'start-passwort', roles: ['MITGLIED'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await sql`insert into tco.mitgliedera (adrnr, benutzer_id) select ${MIA}, id from core.users where username = 'mia'
            on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id`;
  mia = await anmelden('mia');
  H = heute();
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

let a1 = 0, token = '', rg = '', doc = 0;
test('Ausgabe: Rechnungsposition 008 mit Pfand aus dem Produkt, Beleg in Paperless, Quittungslink per E-Mail', async () => {
  assert.equal((await mia('GET', S)).status, 403, 'Mitglieder sehen die App nicht');
  let r = await admin('GET', `${S}/personen`);
  assert.ok(r.body.some((p: { adrnr: string; hat: boolean }) => p.adrnr === MIA && !p.hat));
  assert.equal((await admin('POST', `${S}/ausgabe`, { adrnr: MIA, datum: addTage(H, 1) })).status, 400, 'Zukunft');
  r = await admin('POST', `${S}/ausgabe`, { adrnr: MIA, datum: H, ausgegeben_von: 'Ben Hallenwart' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  a1 = r.body.id;
  assert.match(r.body.nummer, /^SV-\d{4}-\d{4}$/);
  const v = await vorgang(a1);
  assert.deepEqual([v.art, v.status, v.tco_name, Number(v.pfand), v.quelle, v.schluessel_nr], ['AUSGABE', 'WARTET', 'Ben Hallenwart', 25, 'APP', null]);
  token = v.token; rg = v.rgnr; doc = v.doc_id;
  assert.ok(token && rg && doc, 'Token, Rechnung und Beleg');
  const [pos] = await sql`select p.prod_key, p.preis::float8 as preis, k.adrnr, k.betrag::float8 as betrag from tco.rgpos p join tco.rgkopf k on k.rgnr_txt = p.rgnr_txt where p.rgnr_txt = ${rg} and p.rgpos = ${v.rgpos}`;
  assert.deepEqual([pos.prod_key, pos.preis, pos.adrnr, pos.betrag], ['008', 25, MIA, 25]);
  // Bestand (Mitgliederstamm, „Halle aufsperren“) fortgeschrieben, Beleg verknüpft
  assert.deepEqual(await bestand(MIA), { ausgabe: H, ruecknahme: null, ausgabebeleg: String(doc), ruecknahmebeleg: null });
  assert.ok(mock.docs.has(doc) && mock.uploads.at(-1)!.includes('%PDF'));
  const m = mails.at(-1)!;
  assert.equal(m.an, 'mia@tc-test.example');
  assert.ok(m.text.includes(`https://portal.example.org/schluessel-quittung?token=${token}`));
  assert.deepEqual(await protokollVon(a1), ['ANGELEGT', 'RECHNUNG', 'BELEG', 'MAIL']);
  // ein Schlüssel je Person
  r = await admin('POST', `${S}/ausgabe`, { adrnr: MIA, datum: H });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits einen Hallenschlüssel/);
  r = await admin('GET', `${S}/${a1}/beleg.pdf`);
  assert.equal(r.raw.subarray(0, 4).toString(), '%PDF');
  r = await admin('GET', S);
  const z = r.body.zeilen.find((x: { id: number }) => x.id === a1);
  assert.deepEqual([z.ausgegeben, z.status_txt, z.ueberfaellig], [true, 'Wartet auf Quittung', false]);
  assert.equal(r.body.pfand.ausgabe, 25);
});

test('Kunde quittiert online: Link bzw. „Meine Mitgliedschaft“, Beleg wird neue Version', async () => {
  const anonym = client();
  assert.equal((await anonym('GET', `${S}/quittung?token=${'x'.repeat(48)}`)).status, 404);
  let r = await anonym('GET', `${S}/quittung?token=${token}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.person, r.body.quittiert, r.body.ausgegeben_von, r.body.pfand], ['Mia Matchball', false, 'Ben Hallenwart', 25]);
  assert.match(r.body.bedingungen, /Spielregeln/);
  assert.equal(r.body.id, undefined);
  assert.equal((await anonym('POST', `${S}/quittung`, { token, name: 'Mia', zustimmung: false })).status, 400);
  // angemeldet: Hinweis in „Meine Mitgliedschaft“ und Quittung mit Benutzer als Nachweis
  r = await mia('GET', `${S}/meine`);
  assert.deepEqual(r.body.map((x: { token: string }) => x.token), [token]);
  r = await mia('POST', `${S}/quittung`, { token, zustimmung: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = await vorgang(a1);
  assert.deepEqual([v.status, v.quittiert_art, v.quittiert_von, v.nachweis], ['QUITTIERT', 'KUNDE', 'Mia Matchball', 'Portal-Benutzer mia']);
  assert.equal(mock.docs.get(doc)!.versions.length, 1, 'Beleg mit Quittung als neue Version');
  assert.equal((await mia('GET', `${S}/meine`)).body.length, 0);
  r = await anonym('POST', `${S}/quittung`, { token, name: 'Mia', zustimmung: true });
  assert.match(r.body.text, /bereits quittiert/);
});

let r1 = 0;
test('Rückgabe: Gutschrift mit negativem Betrag, TCO bestätigt den Empfang', async () => {
  assert.equal((await admin('POST', `${S}/rueckgabe`, { adrnr: TOM, datum: H })).status, 400, 'kein Schlüssel ausgegeben');
  let r = await admin('POST', `${S}/rueckgabe`, { adrnr: MIA, datum: H, zustand: 'OK', bestaetigt: false, empfangen_von: 'Anna Vorstand' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r1 = r.body.id;
  let v = await vorgang(r1);
  assert.deepEqual([v.art, v.status, v.tco_name, v.zustand, v.rgnr], ['RUECKGABE', 'WARTET', 'Anna Vorstand', 'OK', rg]);
  const [pos] = await sql`select p.prod_key, p.preis::float8 as preis, k.betrag::float8 as betrag from tco.rgpos p join tco.rgkopf k on k.rgnr_txt = p.rgnr_txt where p.rgnr_txt = ${rg} and p.rgpos = ${v.rgpos}`;
  assert.deepEqual([pos.prod_key, pos.preis, pos.betrag], ['009', -25, 0], 'Gutschrift gleicht das Pfand aus');
  assert.equal((await bestand(MIA))?.ruecknahme, H);
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.ok(r.body.some((x: { key: string }) => x.key === `SCHLUESSEL:E:${r1}`), 'unbestätigte Rückgabe im Arbeitsvorrat');
  const vorher = mails.length;
  r = await admin('POST', `${S}/${r1}/empfang`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  v = await vorgang(r1);
  assert.deepEqual([v.status, v.quittiert_art, v.quittiert_von], ['QUITTIERT', 'TCO', 'Admin']);
  assert.ok(v.doc_id && v.doc_id !== doc, 'eigener Rückgabebeleg');
  assert.equal((await bestand(MIA))?.ruecknahmebeleg, String(v.doc_id));
  assert.equal(mails.length, vorher + 1);
  assert.match(mails.at(-1)!.betreff, /zurückgegeben/);
  assert.equal((await admin('POST', `${S}/${r1}/empfang`)).status, 400);
  assert.equal((await admin('POST', `${S}/${a1}/empfang`)).status, 400, 'Ausgabe quittiert der Kunde');
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.ok(!r.body.some((x: { key: string }) => x.key.startsWith('SCHLUESSEL:')));
});

test('Ohne E-Mail: Link im Vorgang; Storno setzt den Bestand zurück', async () => {
  let r = await admin('POST', `${S}/ausgabe`, { adrnr: TOM, datum: H, mit_rechnung: false, schluessel_nr: 'H-7' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  assert.ok(r.body.hinweise.some((h: string) => /Keine E-Mail-Adresse/.test(h)));
  r = await admin('GET', `${S}/${id}`);
  assert.match(r.body.link, /^https:\/\/portal\.example\.org\/schluessel-quittung\?token=[0-9a-f]{48}$/);
  assert.deepEqual([r.body.schluessel_nr, r.body.rgnr, r.body.pfand], ['H-7', null, null]);
  assert.equal((await bestand(TOM))?.ausgabe, H);
  assert.equal((await admin('POST', `${S}/${id}/storno`, { grund: '' })).status, 400);
  r = await admin('POST', `${S}/${id}/storno`, { grund: 'Falsche Person' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await vorgang(id)).status, 'STORNIERT');
  assert.equal(await bestand(TOM), undefined);
  assert.equal((await admin('POST', `${S}/${a1}/storno`, { grund: 'Test' })).status, 400, 'nur der letzte Vorgang der Person');
});

let t1 = 0;
test('Position 008 direkt in der Hallenabrechnung legt den Vorgang an; Arbeitsvorrat: Quittung überfällig, ausgetreten', async () => {
  const ctx = { userId: null, username: 'test', action: 'TEST' };
  const hinweise = await withChange(ctx, async (tx) => {
    const rgnr = await halle.rechnungAnlegen(tx as never, 'TOM TIEBREAK');
    return (await halle.manuellePosition(tx as never, rgnr, { prod_key: '008', menge: 1 })).hinweise;
  });
  assert.match(hinweise[0], /Schlüsselausgabe zum/);
  const [v] = await sql`select id, status, quelle, token, pfand::float8 as pfand, person from tco.schluessel_vorgang where adrnr = ${TOM} and status <> 'STORNIERT'`;
  assert.deepEqual([v.status, v.quelle, v.pfand, v.person, !!v.token], ['WARTET', 'RECHNUNG', 25, 'Tom Tiebreak', true]);
  t1 = v.id;
  let r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.ok(!r.body.some((x: { key: string }) => x.key === `SCHLUESSEL:Q:${t1}`), 'innerhalb der Frist kein Hinweis');
  await sql`update tco.schluessel_vorgang set datum = current_date - 10 where id = ${t1}`;
  await sql`update tco.mitglieder set austritt = current_date - 1 where adrnr = ${TOM}`;
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  const keys = r.body.map((x: { key: string }) => x.key);
  assert.ok(keys.includes(`SCHLUESSEL:Q:${t1}`) && keys.includes(`SCHLUESSEL:A:${t1}`));
  // Link erneuern: ohne E-Mail-Adresse nur Hinweis
  r = await admin('POST', `${S}/${t1}/link`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /keine E-Mail-Adresse/);
});

test('Altdaten per Copy & Paste: Prüfung, Buchung direkt auf das Kassenkonto mit Belegverknüpfung, keine Dubletten', async () => {
  const text = 'Lea Lob\t01.10.2019\tBen H.\t25,00\t15.03.2022\tAnna V.\t501\t502\t\tAltbestand';
  let r = await admin('POST', `${S}/altdaten/pruefen`, { text: `${text}\nNie Mand\t01.01.2020` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen.map((z: { adrnr: string | null; fehler: string[] }) => [z.adrnr, z.fehler.length]), [[LEA, 0], [null, 1]]);
  assert.equal((await admin('POST', `${S}/altdaten`, { text: `${text}\nNie Mand\t01.01.2020` })).status, 400, 'mit Fehlern keine Übernahme');
  assert.equal((await mia('POST', `${S}/altdaten/pruefen`, { text })).status, 403);
  r = await admin('POST', `${S}/altdaten`, { text, buchen: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.uebernommen, r.body.buchungen.length], [2, 2]);
  const vs = await sql`select art, datum::text as datum, status, quittiert_art, quelle, tco_name, doc_id, internenr from tco.schluessel_vorgang where adrnr = ${LEA} order by datum`;
  assert.deepEqual(vs.map((v) => [v.art, v.datum, v.status, v.quittiert_art, v.quelle, v.tco_name, v.doc_id]), [
    ['AUSGABE', '2019-10-01', 'QUITTIERT', 'ALTFALL', 'IMPORT', 'Ben H.', 501], ['RUECKGABE', '2022-03-15', 'QUITTIERT', 'ALTFALL', 'IMPORT', 'Anna V.', 502],
  ]);
  // FI: Eingang bzw. Auszahlung auf der Kasse gegen das Konto des Hallenprodukts, Beleg verknüpft
  const fi = await sql`select internenr, konto, soll::float8 as soll, haben::float8 as haben, gkonto, datum::text as datum from tco.fibuchungen where konto = '1000' order by datum`;
  assert.deepEqual(fi.map((b) => [b.internenr, b.soll, b.haben, b.gkonto, b.datum]), [[vs[0].internenr, 25, 0, '1590', '2019-10-01'], [vs[1].internenr, 0, 25, '1590', '2022-03-15']]);
  const map = await sql`select internenr, doknr from tco.fipapermap order by doknr`;
  assert.deepEqual(map.map((x) => [x.internenr, x.doknr]), [[vs[0].internenr, '501'], [vs[1].internenr, '502']]);
  assert.deepEqual(await bestand(LEA), { ausgabe: '2019-10-01', ruecknahme: '2022-03-15', ausgabebeleg: '501', ruecknahmebeleg: '502' });
  // erneut einfügen: übersprungen
  r = await admin('POST', `${S}/altdaten`, { text, buchen: true });
  assert.deepEqual([r.body.uebernommen, r.body.uebersprungen], [0, 1]);
  assert.equal((await sql`select count(*)::int as n from tco.fibuchungen where konto = '1000'`)[0].n, 2);
});

test('Einstellungen und Varianten', async () => {
  let r = await admin('GET', `${S}/einstellungen/daten`);
  assert.deepEqual([r.body.quittung_tage, r.body.link_tage, r.body.kassenkonto, r.body.pfand.kontoAusgabe], [7, 30, '1000', '1590']);
  assert.equal((await admin('PUT', `${S}/einstellungen/daten`, { bedingungen: 'Bitte abschließen.', quittung_tage: 14, link_tage: 30, kassenkonto: '9999' })).status, 400);
  assert.equal((await admin('PUT', `${S}/einstellungen/daten`, { bedingungen: 'Bitte abschließen.', quittung_tage: 14, link_tage: 30, kassenkonto: '1000' })).status, 200);
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.ok(!r.body.some((x: { key: string }) => x.key === `SCHLUESSEL:Q:${t1}`), 'Frist 14 Tage');
  const ansicht = { alle: true, suche: '', filter: { art: 'Ausgabe' }, sort: { k: 'datum', ab: false } };
  assert.equal((await admin('POST', `${S}/varianten/liste`, { name: 'Alle Ausgaben', standard: true, ansicht })).status, 200);
  r = await admin('GET', `${S}/varianten/liste`);
  assert.equal(r.body.standard.name, 'Alle Ausgaben');
  assert.equal((await admin('GET', `${T}/instandhaltung/varianten`)).body.varianten.length, 0, 'getrennt von der Instandhaltung');
  assert.ok((await sql`select 1 from core.change_header where object_type = 'SCHLUESSELVORGANG' limit 1`).length === 1);
});

test('FI-Abgleich: Buchungen auf zwei Konten, Vorschlag über Name/Betrag/Datum, verknüpfen, lösen, Altfall aus Buchung', async () => {
  const UDO = '0000000304';
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, ort) values (${UDO}, 'Udo', 'Unterschnitt', '2018-01-01', 'Oberthal'), ('0000000305', 'Vera', 'Volley', '2018-01-01', 'Oberthal')`;
  let r = await admin('POST', `${S}/altdaten`, { text: 'Udo Unterschnitt\t05.05.2021\tBen H.\t25,00\t\t\t611', buchen: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [udo] = await sql`select id, internenr from tco.schluessel_vorgang where adrnr = ${UDO}`;
  assert.equal(udo.internenr, null);
  // frühere Kontobewegungen: Kasse (Eingang im Soll) und Pfandkonto (Haben), eine davon storniert
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, soll, haben, gkonto) values
    ('0000009001', '1000', 0, 2021, 5, '2021-05-06', 'Pfand Hallenschlüssel Udo Unterschnitt', 25, 25, 0, '1590'),
    ('0000009001', '1590', 0, 2021, 5, '2021-05-06', 'Pfand Hallenschlüssel Udo Unterschnitt', 25, 0, 25, '1000'),
    ('0000009002', '1590', 0, 2018, 3, '2018-03-03', 'Schlüssel Volley, Vera', 25, 0, 25, '1000'),
    ('0000009003', '1590', 0, 2018, 4, '2018-04-04', 'Schlüsselpfand Fehlbuchung', 25, 0, 25, '1000'),
    ('0000009005', '1590', 0, 2017, 1, '2017-01-10', 'Pfand unbekannt', 25, 0, 25, '1000')`;
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, soll, haben, gkonto, storno_zu) values
    ('0000009004', '1590', 0, 2018, 4, '2018-04-04', 'Storno Schlüsselpfand Fehlbuchung', 25, 25, 0, '1000', '0000009003')`;
  assert.equal((await mia('GET', `${S}/abgleich/daten`)).status, 403);
  r = await admin('GET', `${S}/abgleich/daten`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Vorgabe: Konto des Hallenprodukts und (weil 008 und 009 dasselbe Konto haben) das Kassenkonto
  assert.deepEqual([r.body.konto1, r.body.konto2], ['1590', '1000']);
  type Z = { internenr: string; status: string; richtung: string; konto: string; vorgang: { id: number } | null; person: { adrnr: string } | null; grund: string };
  const z = (nr: string) => (r.body.zeilen as Z[]).filter((x) => x.internenr === nr);
  assert.deepEqual(z('0000009001').map((x) => [x.status, x.richtung, x.konto, x.vorgang?.id]), [['VORSCHLAG', 'AUSGABE', '1590', udo.id]], 'je Buchung eine Zeile');
  assert.match(z('0000009001')[0].grund, /Name im Buchungstext.*Betrag = Pfand.*Datum passt/);
  assert.deepEqual(z('0000009002').map((x) => [x.status, x.person?.adrnr]), [['OFFEN', '0000000305']], 'Person aus dem Buchungstext');
  assert.deepEqual(z('0000009005').map((x) => [x.status, x.person]), [['OFFEN', null]]);
  assert.equal(z('0000009003').length + z('0000009004').length, 0, 'stornierte Buchungen bleiben außen vor');
  // die Altdaten-Buchungen von Lea sind bereits verknüpft
  assert.equal((r.body.zeilen as Z[]).filter((x) => x.status === 'VERKNUEPFT').length, 2);
  assert.ok(r.body.ohneBuchung.every((v: { id: number }) => v.id !== udo.id), 'Vorgang mit Vorschlag zählt nicht als „ohne Buchung“');

  // Konten: nur aus dem Kontenstamm
  assert.equal((await admin('PUT', `${S}/abgleich/konten`, { konto1: '1590', konto2: '9999' })).status, 400);
  assert.equal((await admin('PUT', `${S}/abgleich/konten`, { konto1: '1000', konto2: '1590' })).status, 200);
  r = await admin('GET', `${S}/abgleich/daten`);
  assert.deepEqual([r.body.konto1, z('0000009001')[0].konto, z('0000009001')[0].richtung], ['1000', '1000', 'AUSGABE'], 'Kasse: Eingang im Soll = Ausgabe');

  // verknüpfen: FI-Buchung am Vorgang, Beleg des Vorgangs an der Buchung, nichts neu gebucht
  const vorher = (await sql`select count(*)::int as n from tco.fibuchungen`)[0].n;
  assert.equal((await mia('POST', `${S}/abgleich/verknuepfen`, { paare: [{ internenr: '0000009001', vorgang_id: udo.id }] })).status, 403);
  assert.equal((await admin('POST', `${S}/abgleich/verknuepfen`, { paare: [{ internenr: '0000009003', vorgang_id: udo.id }] })).status, 400, 'stornierte Buchung');
  r = await admin('POST', `${S}/abgleich/verknuepfen`, { paare: [{ internenr: '0000009001', vorgang_id: udo.id }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await vorgang(udo.id)).internenr, '0000009001');
  assert.ok((await protokollVon(udo.id)).includes('BUCHUNG'));
  assert.deepEqual((await sql`select doknr from tco.fipapermap where internenr = '0000009001'`).map((x) => Number(x.doknr)), [611]);
  assert.equal((await sql`select count(*)::int as n from tco.fibuchungen`)[0].n, vorher);
  assert.equal((await admin('POST', `${S}/abgleich/verknuepfen`, { paare: [{ internenr: '0000009002', vorgang_id: udo.id }] })).status, 400, 'bereits verknüpft');
  r = await admin('GET', `${S}/abgleich/daten`);
  assert.deepEqual(z('0000009001').map((x) => [x.status, x.vorgang?.id]), [['VERKNUEPFT', udo.id]]);
  // lösen und erneut als Vorschlag
  assert.equal((await admin('POST', `${S}/abgleich/loesen`, { vorgang_id: udo.id })).status, 200);
  assert.equal((await vorgang(udo.id)).internenr, null);
  r = await admin('GET', `${S}/abgleich/daten`);
  assert.equal(z('0000009001')[0].status, 'VORSCHLAG');

  // Buchung ohne Vorgang: Altfall anlegen (Datum und Pfand aus der Buchung), Bestand fortgeschrieben
  r = await admin('POST', `${S}/abgleich/anlegen`, { internenr: '0000009002', richtung: 'AUSGABE', adrnr: '0000000305' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [vera] = await sql`select art, datum::text as datum, pfand::float8 as pfand, status, quittiert_art, quelle, internenr from tco.schluessel_vorgang where adrnr = '0000000305'`;
  assert.deepEqual([vera.art, vera.datum, vera.pfand, vera.status, vera.quittiert_art, vera.quelle, vera.internenr], ['AUSGABE', '2018-03-03', 25, 'QUITTIERT', 'ALTFALL', 'IMPORT', '0000009002']);
  assert.equal((await bestand('0000000305'))?.ausgabe, '2018-03-03');
  assert.equal((await admin('POST', `${S}/abgleich/anlegen`, { internenr: '0000009002', richtung: 'AUSGABE', adrnr: '0000000305' })).status, 400, 'nicht doppelt');
  assert.equal((await admin('POST', `${S}/abgleich/anlegen`, { internenr: '0000009005', richtung: 'RUECKGABE', adrnr: '0000000305' })).status, 400, 'Richtung passt nicht');
});
