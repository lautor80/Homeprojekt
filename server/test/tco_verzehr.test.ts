/**
 * Clubhaus-Verzehr: Mitglied schreibt auf das eigene Konto an (nur eigenes), Theke mit Gastbeleg und Kassieren,
 * Verzehrbuch, Monatsabschluss mit Sammelabrechnungen, Paperless-Ablage, Lastschrift über die Sollstellung,
 * Berechtigungsobjekte und Systemrolle MITGLIED.
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
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, text: res.body, ct, raw: res.rawPayload };
  };
}
const admin = client();
const V = '/api/m/tco/verzehr';
const MAX = '0000000401', PETRA = '0000000402', THEO = '0000000403';
const mails: any[] = [];
const mock = { docs: new Map<number, { versions: number[]; meta: Record<string, any> }>(), next: 500 };

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = req.url ?? '';
    if (u.startsWith('/webhook/mail')) { mails.push(JSON.parse(body)); return send(200, { status: 'gesendet', message_id: `m${mails.length}` }); }
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    if (u === '/api/documents/post_document/') { const id = mock.next++; mock.docs.set(id, { versions: [], meta: {} }); return send(200, `task-${id}`); }
    if ((m = /^\/api\/documents\/(\d+)\/update_version\/$/.exec(u))) { const d = mock.docs.get(Number(m[1])); if (!d) return send(404, {}); const vid = mock.next++; d.versions.push(vid); return send(200, `task-${vid}`); }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (u.startsWith('/api/documents/?')) return send(200, { results: [], next: null });
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const art = u.split('/')[2];
      const lists: Record<string, unknown[]> = { correspondents: [], document_types: [{ id: 1, name: 'Verzehrbeleg' }], storage_paths: [{ id: 2, name: 'Buchhaltung' }], custom_fields: [{ id: 3, name: 'Betrag', data_type: 'monetary' }, { id: 4, name: 'DOKID', data_type: 'string' }], tags: [] };
      return send(200, { results: lists[art], next: null });
    }
    if (u === '/api/correspondents/' && req.method === 'POST') return send(201, { id: 7, name: JSON.parse(body).name });
    if ((m = /^\/api\/documents\/(\d+)\/notes\/$/.exec(u))) return send(200, []);
    if ((m = /^\/api\/documents\/(\d+)\/share_links\/$/.exec(u))) return send(200, []);
    if (u === '/api/share_links/') return send(201, { slug: `slug${JSON.parse(body).document}` });
    if ((m = /^\/api\/documents\/(\d+)\/download\//.exec(u))) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 test'); }
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      const id = Number(m[1]); const d = mock.docs.get(id);
      if (!d) return send(404, {});
      if (req.method === 'PATCH') { d.meta = JSON.parse(body); return send(200, {}); }
      return send(200, { id, custom_fields: [], versions: [{ id }, ...d.versions.map((v) => ({ id: v }))] });
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
const userId = async (name: string) => (await sql`select id::text as id from core.users where username = ${name}`)[0].id as string;
const vormonat = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7).replace('-', ''); };
const tagImVormonat = (t: number) => `${vormonat().slice(0, 4)}-${vormonat().slice(4, 6)}-${String(t).padStart(2, '0')}`;
const heute = () => new Date().toLocaleDateString('sv-SE');

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`update tco.verein set paperless_url = ${`http://127.0.0.1:${port}`}, paperless_token = 'geheim', n8n_mail_url = ${`http://127.0.0.1:${port}/webhook/mail`}, n8n_mail_key = 'k'`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, email, zahlungsart, iban1, bic1, einzuglastmandliegtvor, strasse, plz, ort) values
    (${MAX}, 'Max', 'Mustermann', '2020-01-01', 'max@example.org', 'L', 'DE02120300000000202051', 'BYLADEM1001', 'J', 'Hauptstr. 1', '66649', 'Oberthal'),
    (${PETRA}, 'Petra', 'Lehmann', '2020-01-01', 'petra@example.org', 'U', null, null, null, '', '', ''),
    (${THEO}, 'Theo', 'Theke', '2020-01-01', '', 'U', null, null, null, '', '', '')`;
  await sql`insert into tco.sepa (adrnr, mandatsnr, status, angelegtam) values (${MAX}, 'TCO-401', 'X', '2020-01-01')`;
  await sql`insert into tco.mitgliedera (adrnr) values (${MAX}), (${PETRA}), (${THEO})`;
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('1200', 'Girokonto', 'BA'), ('8400', 'Clubhaus Verzehr', '')`;
  // Getränke (Clubhausabrechnung) und Speisen
  await sql`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, preis_gast, typ, menge) values
    ('100', '2020-01-01', '9999-12-31', 'BITBURGER 0,33', 2.00, 2.50, 'G', '24'),
    ('101', '2020-01-01', '9999-12-31', 'WASSER 0,5', 1.50, null, 'G', '12')`;
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'THEKE', name: 'Theke', permissions: ['tco.verzehr:theke'] })).status, 200);
  for (const [u, rollen] of [['max', ['MITGLIED']], ['petra', ['MITGLIED']], ['theo', ['THEKE']]] as [string, string[]][]) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles: rollen })).status, 200);
  }
  await sql`update tco.mitgliedera set benutzer_id = ${await userId('max')} where adrnr = ${MAX}`;
  await sql`update tco.mitgliedera set benutzer_id = ${await userId('petra')} where adrnr = ${PETRA}`;
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

test('Systemrolle MITGLIED enthält Mein Verzehr; Berechtigungsobjekte vorhanden', async () => {
  assert.deepEqual((await sql`select permission from core.role_permissions where role_id = 'MITGLIED' order by 1`).map((x) => x.permission), ['tco.kalender:anmelden', 'tco.meinedaten:edit', 'tco.platzbuchung:edit', 'tco.verzehr:edit']);
  const r = await admin('GET', '/api/admin/permissions');
  const ids = JSON.stringify(r.body);
  for (const p of ['tco.verzehr:edit', 'tco.verzehr:theke', 'tco.verzehr:display', 'tco.verzehr:admin']) assert.ok(ids.includes(p), p);
});

test('Preisliste: Speisen anlegen, Gästepreis, Getränke bleiben in der Clubhausabrechnung getrennt', async () => {
  let r = await admin('PUT', `${V}/produkte`, { rubrik: 'S', text: 'Bratwurst mit Brötchen', preis: 2.5, preis_gast: 3, ab: '2020-01-01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.prod_key, '200');
  r = await admin('PUT', `${V}/produkte`, { rubrik: 'S', text: 'Pommes', preis: 3, ab: '2020-01-01' });
  assert.equal(r.body.prod_key, '201');
  r = await admin('PUT', `${V}/produkte`, { rubrik: 'S', text: 'pommes', preis: 3 });
  assert.equal(r.status, 400);
  r = await admin('PUT', `${V}/produkte`, { rubrik: 'G', text: 'Neues Bier', preis: 3 });
  assert.equal(r.status, 400);
  r = await admin('GET', `${V}/preisliste`);
  assert.deepEqual(r.body.produkte.map((p: any) => [p.prod_key, p.rubrik, p.preis, p.preis_gast]), [['100', 'G', 2, 2.5], ['101', 'G', 1.5, null], ['200', 'S', 2.5, 3], ['201', 'S', 3, null]]);
  // Getränkeliste der Clubhausabrechnung enthält keine Speisen
  r = await admin('GET', '/api/m/tco/clubhaus/getraenke');
  assert.deepEqual(r.body.map((g: any) => g.prod_key), ['100', '101']);
});

test('Mitglied: nur eigenes Konto, Storno in der Frist, keine Gästepreise sichtbar', async () => {
  const max = await anmelden('max');
  let r = await max('GET', `${V}/preisliste`);
  assert.equal(r.status, 200);
  assert.ok(r.body.produkte.every((p: any) => p.preis_gast === null), 'Gästepreise für Mitglieder verborgen');
  r = await max('POST', `${V}/meine/buchen`, { positionen: [{ prod_key: '100', anzahl: 2 }, { prod_key: '201', anzahl: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.betrag, 7);
  // Vormonat (für den Abschluss)
  r = await max('POST', `${V}/meine/buchen`, { datum: tagImVormonat(5), positionen: [{ prod_key: '100', anzahl: 3 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await max('POST', `${V}/meine/buchen`, { datum: tagImVormonat(12), positionen: [{ prod_key: '200', anzahl: 2 }] });
  assert.equal(r.status, 200);
  r = await max('POST', `${V}/meine/buchen`, { datum: '2020-01-01', positionen: [{ prod_key: '100', anzahl: 1 }] });
  assert.equal(r.status, 400);
  r = await max('POST', `${V}/meine/buchen`, { positionen: [{ prod_key: '999', anzahl: 1 }] });
  assert.equal(r.status, 400);

  r = await max('GET', `${V}/meine`);
  assert.equal(r.body.adrnr, MAX);
  assert.equal(r.body.offen.length, 4);
  assert.equal(r.body.betrag, 7 + 6 + 5);
  assert.ok(r.body.offen.every((p: any) => p.stornierbar && p.selbst));
  const pommes = r.body.offen.find((p: any) => p.prod_key === '201');
  r = await max('POST', `${V}/meine/storno`, { id: pommes.id });
  assert.equal(r.status, 200);
  r = await max('GET', `${V}/meine`);
  assert.equal(r.body.betrag, 15);
  // fremde Position nicht stornierbar, Theke/Buch gesperrt
  const petra = await anmelden('petra');
  r = await petra('POST', `${V}/meine/storno`, { id: r.body.offen[0].id });
  assert.equal(r.status, 404);
  assert.equal((await petra('GET', `${V}/meine`)).body.offen.length, 0);
  assert.equal((await max('GET', `${V}/theke`)).status, 403);
  assert.equal((await max('GET', `${V}/buch`)).status, 403);
  assert.equal((await max('POST', `${V}/theke/mitglied`, { adrnr: PETRA, positionen: [{ prod_key: '100', anzahl: 1 }] })).status, 403);
  // Storno außerhalb der Frist
  await sql`update tco.vz_posten set erfasst_am = now() - interval '2 days' where adrnr = ${MAX} and prod_key = '200'`;
  r = await max('GET', `${V}/meine`);
  const alt = r.body.offen.find((p: any) => p.prod_key === '200');
  assert.equal(alt.stornierbar, false);
  r = await max('POST', `${V}/meine/storno`, { id: alt.id });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /12 Stunden/);
});

test('Theke: Gastbeleg mit Gästepreisen, kassieren, PDF, Mail, Mitglied anschreiben, Storno nur heute', async () => {
  const theo = await anmelden('theo');
  let r = await theo('GET', `${V}/theke`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.mitglieder.some((m: any) => m.adrnr === MAX && m.name === 'Mustermann, Max'));
  assert.ok(!r.text.includes('max@example.org') && !r.text.includes('DE0212'), 'Theke sieht keine Kontakt-/Bankdaten');
  assert.equal((await theo('GET', `${V}/meine`)).status, 403);
  assert.equal((await theo('GET', `${V}/buch`)).status, 403);

  r = await theo('POST', `${V}/theke/gast`, { gast_name: 'Familie Schneider', gast_gruppe: 'TC Tholey', email: 'gast@example.org', positionen: [{ prod_key: '100', anzahl: 4 }, { prod_key: '200', anzahl: 6 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rgnr = r.body.rgnr as string;
  assert.match(rgnr, /^VZG-\d{4}-00001$/);
  assert.equal(r.body.beleg.betrag, 4 * 2.5 + 6 * 3);
  assert.equal(r.body.beleg.status, 'OFFEN');
  // erweitern
  r = await theo('POST', `${V}/theke/gast`, { rgnr, gast_name: 'Familie Schneider', positionen: [{ prod_key: '101', anzahl: 2 }] });
  assert.equal(r.body.beleg.betrag, 28 + 3);
  // Storno einer Position am selben Tag
  const wasser = r.body.posten.find((p: any) => p.prod_key === '101');
  assert.equal((await theo('POST', `${V}/theke/storno`, { id: wasser.id })).status, 200);
  r = await theo('GET', `${V}/belege/${rgnr}`);
  assert.equal(r.body.beleg.betrag, 28);
  // Mitglied anschreiben über die Theke
  r = await theo('POST', `${V}/theke/mitglied`, { adrnr: PETRA, positionen: [{ prod_key: '100', anzahl: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.betrag, 2, 'Mitgliederpreis, kein Gästepreis');
  // kassieren → Paperless-Dokument
  r = await theo('POST', `${V}/theke/kassieren`, { rgnr, zahlart: 'KARTE' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /28,00 € karte kassiert/);
  assert.equal(r.body.beleg.status, 'BEZAHLT');
  assert.equal(r.body.beleg.zahlart, 'KARTE');
  assert.ok(r.body.beleg.doc_id);
  assert.equal(mock.docs.get(r.body.beleg.doc_id)!.meta.title, `Verzehr ${rgnr}`);
  assert.deepEqual(mock.docs.get(r.body.beleg.doc_id)!.meta.custom_fields.find((f: any) => f.field === 3), { field: 3, value: 'EUR28.00' });
  assert.equal((await theo('POST', `${V}/theke/kassieren`, { rgnr, zahlart: 'BAR' })).status, 400);
  assert.equal((await theo('POST', `${V}/theke/gast`, { rgnr, gast_name: 'x', positionen: [{ prod_key: '100', anzahl: 1 }] })).status, 400);
  r = await theo('GET', `${V}/belege/${rgnr}/pdf`);
  assert.equal(r.status, 200);
  assert.match(r.ct, /application\/pdf/);
  // E-Mail und WhatsApp
  r = await theo('POST', `${V}/belege/${rgnr}/mail`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mails.at(-1).an, 'gast@example.org');
  assert.equal(mails.at(-1).anwendung, 'VERZEHR');
  assert.equal(mails.at(-1).anhaenge[0].dateiname, `${rgnr}.pdf`);
  r = await theo('POST', `${V}/belege/${rgnr}/whatsapp`, { mobil: '0171 2345678' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/wa\.me\/491712345678\?text=.*slug/);
  // Storno einer älteren Position an der Theke nicht erlaubt
  const [p] = await sql`select id from tco.vz_posten where adrnr = ${MAX} and datum < current_date limit 1`;
  r = await theo('POST', `${V}/theke/storno`, { id: Number(p.id) });
  assert.equal(r.status, 400);
  // zweiter Gastbeleg bekommt die Folgenummer
  r = await theo('POST', `${V}/theke/gast`, { gast_gruppe: 'TC Marpingen', positionen: [{ prod_key: '201', anzahl: 2 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.rgnr, /-00002$/);
  // heutige Liste zeigt Mitglieder nur mit Namen
  r = await theo('GET', `${V}/theke/heute`);
  assert.ok(r.body.some((x: any) => x.person === 'Petra Lehmann' && !x.gast));
  assert.ok(r.body.some((x: any) => x.person === 'Familie Schneider' && x.gast));
});

test('Verzehrbuch, Arbeitsvorrat, Monatsabschluss mit Sammelabrechnungen und Lastschrift', async () => {
  let r = await admin('GET', `${V}/buch?von=${tagImVormonat(1)}&bis=${heute()}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.posten.length >= 8);
  assert.equal(r.body.kennzahlen.offenKonten.personen, 2);
  assert.equal(r.body.kennzahlen.gaeste.belege, 1);
  r = await admin('GET', `${V}/buch?von=${tagImVormonat(1)}&bis=${heute()}&status=STORNIERT`);
  assert.equal(r.body.posten.length, 2);
  r = await admin('GET', `${V}/buch?von=${tagImVormonat(1)}&bis=${heute()}&art=GAST`);
  assert.ok(r.body.posten.every((p: any) => p.gast));

  // Abschluss Vormonat: nur Positionen bis Monatsende, Petra (2 €) unter Mindestbetrag → Übertrag
  r = await admin('GET', `${V}/abschluss?monat=${vormonat()}`);
  assert.equal(r.body.moeglich, true);
  const maxZ = r.body.zeilen.find((z: any) => z.adrnr === MAX);
  assert.deepEqual([maxZ.betrag, maxZ.zahlart, maxZ.uebertrag, maxZ.posten], [11, 'LASTSCHRIFT', false, 2]);
  assert.ok(!r.body.zeilen.some((z: any) => z.adrnr === PETRA), 'Petras Verzehr ist von heute – nicht im Vormonat');
  assert.equal((await admin('POST', `${V}/abschluss`, { monat: new Date().toISOString().slice(0, 7).replace('-', '') })).status, 400);
  // Vorschau-PDF (alle und einzeln) legt keine Belege an
  r = await admin('GET', `${V}/abschluss/pdf?monat=${vormonat()}`);
  assert.equal(r.status, 200, r.text);
  assert.match(r.ct, /application\/pdf/);
  assert.equal((await admin('GET', `${V}/abschluss/pdf?monat=${vormonat()}&adrnr=${MAX}`)).status, 200);
  assert.equal((await admin('GET', `${V}/abschluss/pdf?monat=${vormonat()}&adrnr=${PETRA}`)).status, 400);
  assert.equal((await sql`select count(*)::int as n from tco.vz_belege where art = 'SAMMEL'`)[0].n, 0);
  r = await admin('POST', `${V}/abschluss`, { monat: vormonat(), versenden: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.belege.length, 1);
  const sammel = r.body.belege[0] as string;
  assert.match(sammel, new RegExp(`^VZM-${vormonat().slice(0, 4)}-${vormonat().slice(4, 6)}-0001$`));
  assert.equal(mails.at(-1).an, 'max@example.org');
  assert.match(mails.at(-1).text, /Lastschrift/);
  // zweiter Lauf: nichts mehr offen
  r = await admin('POST', `${V}/abschluss`, { monat: vormonat() });
  assert.equal(r.body.belege.length, 0);
  // Max sieht seine Abrechnung, die heutigen Positionen bleiben offen
  const max = client();
  assert.equal((await max('POST', '/api/auth/login', { username: 'max', password: 'neues-passwort' })).status, 200);
  r = await max('GET', `${V}/meine`);
  assert.equal(r.body.betrag, 4);
  assert.deepEqual(r.body.belege.map((b: any) => [b.rgnr, b.status, b.betrag, b.zahlart]), [[sammel, 'GESTELLT', 11, 'LASTSCHRIFT']]);
  assert.equal((await max('GET', `${V}/meine/beleg/${sammel}/pdf`)).status, 200);
  // Nachtrag in einen abgerechneten Monat wird abgewiesen
  r = await max('POST', `${V}/meine/buchen`, { datum: tagImVormonat(20), positionen: [{ prod_key: '100', anzahl: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits abgerechnet/);
  // Petra darf Max' Beleg nicht sehen
  const petra = client();
  assert.equal((await petra('POST', '/api/auth/login', { username: 'petra', password: 'neues-passwort' })).status, 200);
  assert.equal((await petra('GET', `${V}/meine/beleg/${sammel}/pdf`)).status, 404);

  // Sollstellung zieht die Sammelabrechnung ein
  const sp = new Date().toISOString().slice(0, 7).replace('-', '');
  r = await admin('POST', '/api/m/tco/soll/vorschlag', { sollper: sp, mitMb: false, mitJt: false, mitVz: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const vz = r.body.pos.find((p: any) => p.vertragnr === sammel);
  assert.ok(vz, JSON.stringify(r.body.excl));
  assert.equal(vz.beitragsart, 'VZ');
  assert.equal(vz.betrag, 11);
  assert.match(vz.artname, /Verzehr Clubhaus/);
  r = await admin('PUT', '/api/m/tco/soll/cfg', { gl_name: 'TC Test', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', gl_id: 'DE98ZZZ09999999999', bankkonto: '1200', vorlauf: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const faellig = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  r = await admin('POST', '/api/m/tco/soll/laeufe', { sollper: sp, mitMb: false, mitJt: false, mitVz: true, faellig, ohne: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body.meldungen));
  const [b] = await sql`select laufid, status from tco.vz_belege where rgnr = ${sammel}`;
  assert.equal(b.laufid, r.body.laufid);
  assert.equal(b.status, 'GESTELLT');
  // im Lauf: kein manuelles Bezahlt/Storno
  assert.equal((await admin('POST', `${V}/belege/${sammel}/storno`, { grund: 'x' })).status, 400);
  // Lauf stornieren gibt den Beleg frei
  r = await admin('POST', `/api/m/tco/soll/laeufe/${Number(r.body.laufid)}/storno`, { grund: 'Test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select laufid from tco.vz_belege where rgnr = ${sammel}`)[0].laufid, null);

  // Arbeitsvorrat: überfällige Abrechnung nach Fälligkeit, Monatsabschluss nicht mehr offen
  await sql`update tco.vz_belege set faellig = current_date - 1, zahlart = 'UEBERWEISUNG' where rgnr = ${sammel}`;
  r = await admin('GET', '/api/m/tco/dashboard/arbeitsvorrat');
  assert.ok(r.body.some((a: any) => a.key === 'VZ_UEBERFAELLIG' && a.betrag === 11), JSON.stringify(r.body));
  assert.ok(!r.body.some((a: any) => a.key === 'VZ_ABSCHLUSS'));

  // Bezahlt → neue Version in Paperless mit Zahlvermerk; Sammelbeleg stornieren macht Positionen wieder offen
  r = await admin('POST', `${V}/belege/${sammel}/bezahlt`, { datum: heute() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [bz] = await sql`select status, doc_id, to_char(bezahlt_am, 'YYYY-MM-DD') as am from tco.vz_belege where rgnr = ${sammel}`;
  assert.equal(bz.status, 'BEZAHLT');
  assert.equal(bz.am, heute());
  assert.equal(mock.docs.get(bz.doc_id)!.versions.length, 1, 'Zahlvermerk als neue Version');
  assert.equal((await admin('POST', `${V}/belege/${sammel}/bezahlt`, {})).status, 400);
  r = await admin('POST', `${V}/belege/${sammel}/storno`, { grund: 'Test' });
  assert.equal(r.status, 200);
  r = await admin('GET', `${V}/abschluss?monat=${vormonat()}`);
  assert.equal(r.body.zeilen.find((z: any) => z.adrnr === MAX).betrag, 11);
  // einzelnen Verbrauch der wieder offenen Positionen stornieren und den Monat für Max neu abrechnen
  r = await admin('GET', `${V}/buch?von=2000-01-01&bis=${tagImVormonat(28)}&adrnr=${MAX}&status=OFFEN`);
  assert.equal(r.body.posten.length, 2);
  const brat = r.body.posten.find((p: any) => p.prod_key === '200');
  assert.equal((await admin('POST', `${V}/storno`, { id: brat.id, grund: 'Rückmeldung Mitglied' })).status, 200);
  r = await admin('POST', `${V}/abschluss`, { monat: vormonat(), adrnrs: [MAX], versenden: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.belege.length, 1, JSON.stringify(r.body));
  assert.match(r.body.belege[0], /-0002$/);
  assert.equal((await sql`select betrag::float8 as b from tco.vz_belege where rgnr = ${r.body.belege[0]}`)[0].b, 6);

  // Admin-Storno einer beliebigen offenen Position, Änderungsbelege
  const [pos] = await sql`select id from tco.vz_posten where adrnr = ${PETRA} and storniert_am is null`;
  assert.equal((await admin('POST', `${V}/storno`, { id: Number(pos.id), grund: 'Fehlbuchung' })).status, 200);
  const [{ n }] = await sql`select count(*)::int as n from core.change_header where action in ('VZ_BUCHUNG', 'VZ_KASSIERT', 'VZ_ABSCHLUSS', 'VZ_STORNO')`;
  assert.ok(n >= 8);
});
