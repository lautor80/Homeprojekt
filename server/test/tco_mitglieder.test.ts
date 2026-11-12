/**
 * Integrationstest Mitglieder: Liste, Objektseite, Neuanlage (Zahler/SEPA/Verträge), Austritt und
 * SEPA-Mandate, Verträge, Unterlagen-PDFs, Aufnahmeantrag aus Paperless und Ablage.
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
const { vertragsbeginn, normName } = await import('../../modules/tco/server/mitglieder/logik.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, raw: res.rawPayload, ct };
}
const M = '/api/m/tco/mitglieder';
const IBAN = 'DE89370400440532013000';
const IBAN2 = 'DE02120300000000202051';

// ---------------------------------------------------------------- Paperless-Attrappe
const ANTRAG = [
  'Aufnahmeantrag TC Oberthal', 'Monday, February 9, 2026', 'Name', 'Krämer', 'Vorname', 'Lena', 'Geburtsdatum', '03.04.2012',
  'Straße', 'Am Bach', 'Hausnummer', '7', 'PLZ', '66649', 'Wohnort', 'Oberthal', 'Telefonnummer', '0171 2345678', 'Email', 'lena@example.org',
  'Welche Mitgliedschaft möchtest du beantragen?', 'Jugendliche (bis 18 Jahre) Jugendtraining',
  'Kontoinhaber', 'Herr Peter Krämer', 'Bank', 'Sparkasse', 'IBAN', 'DE02 1203 0000 0000 2020 51', 'BIC', 'BYLADEM1001',
  'Ich erkläre mich bereit, zum gewählten Zeitpunkt beizutreten Ja', 'Ich bin bereit die Satzung anzuerkennen Ja',
  'Ich ermächtige den Verein, Zahlungen von meinem Konto einzuziehen Ja', 'Fotos dürfen im elektronischem Rahmen zu Vereinszwecken verwendet werden Nein',
].join('\n');
const mock = { docs: new Map<number, { versions: number[]; notes: string[]; meta: Record<string, any>; title: string }>(), next: 700, korr: [{ id: 5, name: 'Mueller Hans' }] };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = decodeURIComponent(req.url ?? '');
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    if (u.startsWith('/api/documents/?correspondent__id=5')) {
      const all = [...mock.docs].filter(([, d]) => d.meta.correspondent === 5).map(([id, d]) => ({ id, title: d.title, created_date: new Date().toLocaleDateString('sv-SE'), document_type: 9, notes: d.notes, original_file_name: 'x.pdf', mime_type: 'application/pdf' }));
      const t = /title__iexact=([^&]+)/.exec(u)?.[1];
      return send(200, { results: t ? all.filter((d) => d.title === t) : all, next: null });
    }
    if (u.startsWith('/api/documents/?')) return send(200, { results: [], next: null });
    if (u === '/api/documents/post_document/') {
      const id = mock.next++;
      mock.docs.set(id, { versions: [], notes: [], meta: {}, title: /name="title"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? '' });
      return send(200, `task-${id}`);
    }
    if ((m = /^\/api\/documents\/(\d+)\/update_version\/$/.exec(u))) { const vid = mock.next++; mock.docs.get(Number(m[1]))!.versions.push(vid); return send(200, `task-${vid}`); }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const art = u.split('/')[2];
      const lists: Record<string, unknown[]> = {
        correspondents: mock.korr, document_types: [{ id: 9, name: 'Aufnahmeantrag' }, { id: 10, name: 'Mitgliederinformation' }, { id: 13, name: 'SEPA-Mandat' }],
        storage_paths: [{ id: 2, name: 'Mitglieder' }], custom_fields: [], tags: [],
      };
      return send(200, { results: lists[art], next: null });
    }
    if (u === '/api/correspondents/' && req.method === 'POST') { const k = { id: 6, name: JSON.parse(body).name }; mock.korr.push(k); return send(201, k); }
    if ((m = /^\/api\/documents\/(\d+)\/notes\/$/.exec(u))) { mock.docs.get(Number(m[1]))?.notes.push(JSON.parse(body || '{}').note); return send(200, []); }
    if ((m = /^\/api\/documents\/(\d+)\/share_links\/$/.exec(u))) return send(200, req.method === 'POST' ? { slug: `s${m[1]}` } : []);
    if (u === '/api/share_links/' && req.method === 'POST') return send(201, { slug: `s${JSON.parse(body).document}`, expiration: null, created: '' });
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      const id = Number(m[1]);
      if (id === 42) return send(200, { id, title: 'Aufnahmeantrag Krämer', content: ANTRAG, created_date: '2026-02-10', versions: [{ id }] });
      const d = mock.docs.get(id);
      if (!d) return send(404, {});
      if (req.method === 'PATCH') { Object.assign(d.meta, JSON.parse(body)); return send(200, {}); }
      return send(200, { id, title: d.title, custom_fields: [], correspondent: d.meta.correspondent ?? null, document_type: d.meta.document_type ?? null, versions: [{ id }, ...d.versions.map((v) => ({ id: v }))] });
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
  await sql`insert into core.verbindungen (id, url, auth_art, geheimnis, einstellungen) values ('paperless', ${`http://127.0.0.1:${port}`}, 'token', 'geheim', ${sql.json({ freigabe_url: `http://127.0.0.1:${port}` })})`;
  await sql`insert into tco.mitglieder (adrnr, anrede, vorname, nachname, strasse, plz, ort, email, telefon6, geburtsdatum, eintritt, austritt, mitglnrn, zahlungsart, iban1, bic1, adrnrkih, mandatsrefenz, checkbox1) values
    ('0000000101', 'Herr', 'Hans', 'Müller', 'Hauptstr. 1', '66649', 'Oberthal', 'hans@example.org', '0171 1111111', '1970-05-01', '2020-01-01', null, '101', 'L', ${IBAN}, 'COBADEFFXXX', null, '101101', 'J'),
    ('0000000102', 'Frau', 'Mia', 'Müller', 'Hauptstr. 1', '66649', 'Oberthal', null, null, '2012-02-02', '2025-01-01', null, '102', 'L', null, null, '0000000101', null, 'J'),
    ('0000000103', 'Frau', 'Eva', 'Alt', 'Weg 2', '66649', 'Oberthal', null, null, '1950-01-01', '2010-01-01', '2024-12-31', '103', 'L', ${IBAN2}, null, null, '103103', 'J'),
    ('0000000104', 'Herr', 'Peter', 'Krämer', 'Am Bach 7', '66649', 'Oberthal', null, null, '1980-01-01', null, null, null, 'L', ${IBAN2}, null, null, null, null)`;
  await sql`insert into tco.sepa (adrnr, mandatsnr, mandkey, status, angelegtam) values ('0000000101', '1011011', '101101', 'X', '2020-01-01'), ('0000000103', '1031031', '103103', null, '2010-01-01')`;
  await sql`update tco.sepa set gueltigbis = '2024-12-31' where adrnr = '0000000103'`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, vertragende, betrag) values
    ('0000000101', '1', '5', 'Erwachsene', '101', 'halbjährlich', '2020-01-01', null, 60),
    ('0000000102', '1', '90', 'Jugendtraining', '102', 'monatlich', '2025-01-01', null, 35),
    ('0000000102', '2', '3', 'Jugendliche', '102', 'halbjährlich', '2025-01-01', null, 20),
    ('0000000103', '1', '5', 'Erwachsene', '103', 'halbjährlich', '2010-01-01', '2024-12-31', 55)`;
  await sql`update tco.vertraege set zahler_adrnr = '0000000000' where adrnr = '0000000102' and vertragnr = '2'`; // SAP-Initialwert
  await sql`insert into tco.mitgliedera (adrnr, trainer, zuid) values ('0000000101', false, '77')`;
});
after(async () => {
  await app?.close();
  await sql.end();
  server.close();
});

test('Vertragsbeginn und Namensvergleich', () => {
  assert.equal(vertragsbeginn('2026-03-15', '5'), '2026-07-01');
  assert.equal(vertragsbeginn('2026-07-01', '5'), '2026-07-01');
  assert.equal(vertragsbeginn('2026-08-02', '3'), '2027-01-01');
  assert.equal(vertragsbeginn('2026-12-05', '90'), '2027-01-01');
  assert.equal(vertragsbeginn('2026-05-01', '90'), '2026-05-01');
  assert.equal(normName('Frau Zoë Krämer-Weiß'), 'zoe kraemer weiss');
});

test('Mitglieder: Liste, Detail, Austritt/SEPA, Verträge, Bank', async () => {
  let r = await call('GET', `${M}/liste`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.anzahl, { AKTIV: 2, AUSGETRETEN: 1, SCHNUPPER: 0, KUNDEN: 1, ELTERN: 1, ALLE: 4 });
  assert.deepEqual(r.body.zeilen.map((z: any) => z.name), ['Müller, Hans', 'Müller, Mia']);
  r = await call('GET', `${M}/liste?status=ALLE&suche=kr`);
  assert.deepEqual(r.body.zeilen.map((z: any) => [z.name, z.info, z.status_txt]), [['Krämer, Peter', 'Zahler · 66649 Oberthal', 'Ohne Eintritt']]);
  r = await call('GET', `${M}/liste?status=ALLE&datumTyp=AUSGETRETEN&von=2024-01-01&bis=2024-12-31`);
  assert.deepEqual(r.body.zeilen.map((z: any) => z.adrnr), ['0000000103']);

  // Detail Mia: Zahler Hans, Mandatsreferenz des Zahlers, Familie
  r = await call('GET', `${M}/m/0000000102`);
  assert.equal(r.body.bank.mandatsref, '101101');
  assert.equal(r.body.bank.kontoinhaber, 'Hans Müller');
  assert.deepEqual(r.body.familie.map((p: any) => p.rolle), ['Mitglied', 'Abweichender Zahler']);
  assert.deepEqual(r.body.vertraege.map((v: any) => [v.zahler_adrnr, v.zahler]), [['', 'wie Mitglied (Müller, Hans)'], ['', 'wie Mitglied (Müller, Hans)']]);
  // Vertragsbaum: alle verknüpften Personen mit ihren Verträgen, Ebene über „zahlt über“
  assert.deepEqual(r.body.familie.map((p: any) => [p.adrnr, p.zahlt_ueber]), [['0000000102', '0000000101'], ['0000000101', '']]);
  assert.deepEqual(r.body.vertraegeFamilie.map((v: any) => [v.adrnr, v.vertragnr]), [['0000000102', '1'], ['0000000102', '2'], ['0000000101', '1']]);
  // Detail Hans: Verträge inkl. Mia, SEPA
  r = await call('GET', `${M}/m/0000000101`);
  assert.deepEqual(r.body.vertraege.map((v: any) => [v.person, v.vertragnr]), [['Hans Müller', '1'], ['Mia Müller', '1'], ['Mia Müller', '2']]);
  assert.equal(r.body.sepa[0].aktiv, true);
  assert.equal(r.body.zuid, '77');

  // Austritt: vor Eintritt abgelehnt, dann Mandat befristet, Entfernen stellt es wieder her
  r = await call('POST', `${M}/m/0000000101/austritt`, { austritt: '2019-12-31' });
  assert.equal(r.status, 400);
  r = await call('POST', `${M}/m/0000000101/austritt`, { austritt: '2025-06-30' });
  assert.match(r.body.text, /gültig bis 30\.06\.2025/);
  let [s] = await sql`select status, gueltigbis from tco.sepa where adrnr = '0000000101'`;
  assert.deepEqual([s.status, s.gueltigbis], [null, '2025-06-30']);
  // manuell aktivieren (Kinder zahlen weiter)
  r = await call('POST', `${M}/sepa/0000000101/manuell`, { aktiv: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${M}/auswahl`);
  assert.ok(r.body.vtZahler.some((z: any) => z.adrnr === '0000000101'));
  r = await call('POST', `${M}/sepa/0000000101/manuell`, { aktiv: false });
  [s] = await sql`select status, gueltigbis, manuell_aktiv from tco.sepa where adrnr = '0000000101'`;
  assert.deepEqual([s.status, s.gueltigbis, s.manuell_aktiv], [null, '2025-06-30', false]);
  r = await call('POST', `${M}/m/0000000101/austritt`, { austritt: null });
  [s] = await sql`select status, gueltigbis from tco.sepa where adrnr = '0000000101'`;
  assert.deepEqual([s.status, s.gueltigbis], ['X', null]);

  // Verträge: neuer Vertrag, Ende vor Beginn abgelehnt, Zahler nur mit aktivem Mandat
  r = await call('POST', `${M}/m/0000000102/vertraege`, { art: '5', beginn: '2026-07-01', turnus: 'halbjährlich', betrag: 60, zahler: '0000000103' });
  assert.equal(r.status, 400); // Eva ist ausgetreten, Mandat inaktiv
  r = await call('POST', `${M}/m/0000000102/vertraege`, { art: '5', beginn: '2026-07-01', turnus: 'halbjährlich', betrag: 60, zahler: '0000000101' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.text, 'Vertrag 3 angelegt.');
  r = await call('PUT', `${M}/vertraege/0000000102/3`, { ende: '2026-01-01' });
  assert.equal(r.status, 400);
  r = await call('PUT', `${M}/vertraege/0000000102/3`, { ende: '2026-12-31' });
  assert.match(r.body.text, /Laufzeitende 31\.12\.2026/);
  r = await call('PUT', `${M}/vertraege/0000000102/3`, { zahler: null });
  assert.match(r.body.text, /wie Mitglied/);
  // Vertragsbeginn (#33): immer änderbar, nicht nach dem Laufzeitende
  r = await call('PUT', `${M}/vertraege/0000000102/3`, { beginn: '2027-01-01' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nach dem Laufzeitende/);
  r = await call('PUT', `${M}/vertraege/0000000102/3`, { beginn: '2026-04-01' });
  assert.match(r.body.text, /Vertragsbeginn 01\.04\.2026/);
  assert.equal((await sql`select vertragbegin::text as b from tco.vertraege where adrnr = '0000000102' and vertragnr = '3'`)[0].b, '2026-04-01');
  r = await call('PUT', `${M}/vertraege/0000000102/3`, { beginn: '2026-07-01' });
  assert.equal(r.status, 200, 'zurück auf den ursprünglichen Beginn');

  // Bank: ungültige IBAN, BIC-Länge
  r = await call('PUT', `${M}/m/0000000102/bank`, { zahlungsart: 'L', iban: 'DE00123', bic: '', bank: '', abwkontoinh: '', adrnrkih: '0000000101' });
  assert.equal(r.status, 400);
  r = await call('PUT', `${M}/m/0000000102/bank`, { zahlungsart: 'L', zahlungsweise: 'monatlich', iban: IBAN, bic: 'COBADEFF', bank: 'Commerzbank', abwkontoinh: 'Herr Hans Müller', adrnrkih: '0000000101' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${M}/m/0000000102`);
  assert.equal(r.body.bank.kontoinhaber, 'Hans Müller');

  // Notizen, Trainer, Schlüssel, Änderungsbeleg
  r = await call('POST', `${M}/m/0000000102/notizen`, { text: 'Rückruf wegen Training' });
  assert.equal(r.status, 200);
  r = await call('POST', `${M}/m/0000000102/trainer`, { trainer: true });
  r = await call('POST', `${M}/m/0000000102/schluessel`, { ausgabe: '2026-03-01', ausgabebeleg: 'K12', ruecknahme: null, ruecknahmebeleg: '' });
  r = await call('GET', `${M}/m/0000000102`);
  assert.equal(r.body.notizen.length, 1);
  assert.equal(r.body.trainer, true);
  assert.equal(r.body.schluessel[0].ausgabebeleg, 'K12');
  r = await call('GET', '/api/audit/object/MITGLIED/0000000102');
  assert.ok(r.body.length >= 3, JSON.stringify(r.body).slice(0, 300));
});

test('Mitglieder: Neuanlage, Aufnahmeantrag, Unterlagen, Ablage, Kommunikation', async () => {
  // Aufnahmeantrag aus Paperless lesen (Dok-Nr. 42)
  let r = await call('POST', `${M}/neu/antrag`, { docid: 42 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.antrag;
  assert.deepEqual([a.nachname, a.vorname, a.geburtsdatum, a.strasse, a.mobil, a.iban, a.bic, a.sepa, a.datenschutz, a.bildrechte],
    ['Krämer', 'Lena', '2012-04-03', 'Am Bach 7', '0171 2345678', IBAN2, 'BYLADEM1001', true, true, false]);
  assert.equal(r.body.antrag.antragsdatum, '2026-02-09');
  assert.deepEqual(r.body.vart, ['3', '90']);
  assert.deepEqual([r.body.zahler.modus, r.body.zahler.adrnr], ['BESTEHEND', '0000000104']);
  assert.equal(r.body.existiert, false);

  // Neuanlage mit bestehendem Zahler ohne Mandat → neues Mandat beim Zahler
  const neu = {
    anrede: 'Frau', vorname: 'Lena', nachname: 'Krämer', strasse: 'Am Bach 7', plz: '66649', ort: 'Oberthal', telefon: '', mobil: '0171 2345678',
    email: 'lena@example.org', geburtsdatum: '2012-04-03', eintritt: '2026-02-10', datenschutz: true, bildrechte: false,
    zahlungsart: 'L', zahlungsweise: 'monatlich', iban: IBAN2, bic: 'BYLADEM1001', bank: 'Sparkasse', sepa: true, sepa_datum: '2026-02-09',
    zahler_modus: 'BESTEHEND', zahler_adrnr: '0000000104', vertraege: [{ art: '90', beginn: null, betrag: 35, turnus: 'monatlich' }, { art: '3', beginn: null, betrag: 20, turnus: '' }],
    antrag_docid: 42,
  };
  r = await call('POST', `${M}/neu`, { ...neu, iban: IBAN });
  assert.equal(r.status, 400); // IBAN weicht vom Zahler ab
  r = await call('POST', `${M}/neu`, neu);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.adrnr, r.body.mitglnrn, r.body.mandat, r.body.mandatNeu], ['0000000105', '104', '10411', true]);
  assert.match(r.body.text, /Mitglied Nr\. 104 angelegt, SEPA-Mandat 10411 erstellt/);
  const [m] = await sql`select adrnrkih, abwkontoinh, mandatsrefenz, checkbox2 from tco.mitglieder where adrnr = '0000000105'`;
  assert.deepEqual([m.adrnrkih, m.abwkontoinh, m.mandatsrefenz, m.checkbox2], ['0000000104', 'Herr Peter Krämer', '105104', 'N']);
  const vt = await sql`select vertragnr, art, vertragbegin, sollstellung from tco.vertraege where adrnr = '0000000105' order by vertragnr`;
  assert.deepEqual(vt.map((x) => [x.vertragnr, x.art, x.vertragbegin, x.sollstellung]), [['1', '90', '2026-03-01', 'monatlich'], ['2', '3', '2026-07-01', 'halbjährlich']]);
  r = await call('POST', `${M}/neu`, neu);
  assert.equal(r.status, 400); // Dublette
  r = await call('POST', `${M}/neu/antrag`, { docid: 42 });
  assert.equal(r.body.existiert, true);

  // zweites Kind mit neuem Zahler: Zahler-Datensatz ohne Mitgliedsnummer
  r = await call('POST', `${M}/neu`, { ...neu, vorname: 'Tom', geburtsdatum: '2014-01-01', zahler_modus: 'NEU', zahler_adrnr: null, z_anrede: 'Frau', z_vorname: 'Anna', z_nachname: 'Krämer', iban: IBAN, antrag_docid: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [z] = await sql`select adrnr, mitglnrn, iban1 from tco.mitglieder where vorname = 'Anna'`;
  assert.deepEqual([z.adrnr, z.mitglnrn, z.iban1], ['0000000107', null, IBAN]);
  const [zs] = await sql`select mandatsnr from tco.sepa where adrnr = '0000000107'`;
  assert.equal(zs.mandatsnr, '10711');

  // Unterlagen als PDF
  for (const art of ['1', '2', '3', '4', '5']) {
    r = await call('GET', `${M}/m/0000000101/unterlage/${art}`);
    assert.equal(r.ct, 'application/pdf', `Art ${art}: ${String(r.body).slice(0, 200)}`);
    assert.ok(r.raw.length > 3000);
  }
  // Ablage: neu, am selben Tag → neue Version
  r = await call('POST', `${M}/m/0000000101/unterlage/2/ablegen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Nach Paperless übertragen/);
  const id = r.body.id;
  assert.equal(mock.docs.get(id)!.meta.correspondent, 5);
  assert.equal(mock.docs.get(id)!.meta.document_type, 10);
  r = await call('POST', `${M}/m/0000000101/unterlage/2/ablegen`);
  assert.match(r.body.text, /neue Version/);
  r = await call('GET', `${M}/m/0000000101/dokumente`);
  assert.deepEqual(r.body.dokumente.map((d: any) => d.id), [id]);

  // Kommunikation mit Freigabelink
  r = await call('POST', `${M}/m/0000000101/komm`, { art: '2', ids: [id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.an, 'hans@example.org');
  assert.equal(r.body.mobil, '491711111111');
  assert.match(r.body.text, /^Deine Mitgliederinformation\n\nHallo Hans,/);
  assert.match(r.body.text, /\/share\/s\d+/);
});

test('Bankverbindung: IBAN prüfen, BIC/Kreditinstitut ermitteln, neues SEPA-Mandat', async () => {
  const { blzDateiLesen } = await import('../../modules/tco/server/mitglieder/bank.js');
  // Bankleitzahlendatei der Bundesbank: feste Spalten (168 Zeichen) und CSV
  const zeile = (blz: string, merkmal: string, name: string, ort: string, bic: string, loeschung = '0') =>
    `${blz}${merkmal}${name.padEnd(58)}50667${ort.padEnd(35)}${name.slice(0, 27).padEnd(27)}12345${bic.padEnd(11)}13000001U${loeschung}00000000`;
  const txt = [
    zeile('37040044', '1', 'Commerzbank', 'Köln', 'COBADEFFXXX'),
    zeile('37040044', '2', 'Commerzbank Filiale', 'Brühl', ''),
    zeile('59190000', '1', 'Bank 1 Saar', 'Saarbrücken', 'SABADE5SXXX'),
    zeile('11111111', '1', 'Gelöschte Bank', 'Nirgendwo', 'GELODEFFXXX', '1'),
  ].join('\r\n');
  assert.equal(txt.split('\r\n')[0].length, 168);
  const e = blzDateiLesen(Buffer.from(txt, 'latin1'));
  assert.deepEqual(e.map((x: any) => [x.blz, x.bic, x.name, x.ort]), [['37040044', 'COBADEFFXXX', 'Commerzbank', 'Köln'], ['59190000', 'SABADE5SXXX', 'Bank 1 Saar', 'Saarbrücken']]);
  const csvDatei = 'Bankleitzahl;Merkmal;Bezeichnung;PLZ;Ort;Kurzbezeichnung;PAN;BIC;Prüfzifferberechnungsmethode;Datensatznummer;Änderungskennzeichen;Bankleitzahllöschung;Nachfolge-Bankleitzahl\r\n'
    + '"37040044";"1";"Commerzbank";"50447";"Köln";"Commerzbank Köln";"24100";"COBADEFFXXX";"13";"000001";"U";"0";"00000000"\r\n';
  assert.deepEqual(blzDateiLesen(Buffer.from(csvDatei, 'utf8')).map((x: any) => [x.blz, x.bic, x.ort]), [['37040044', 'COBADEFFXXX', 'Köln']]);
  assert.throws(() => blzDateiLesen(Buffer.from('irgendein Text')), /keine Bankleitzahlen/);

  // IBAN verproben: ungültig mit Grund, gültig ohne Verzeichnis
  const P = `${M}/bank/pruefen`;
  let r = await call('POST', P, { iban: 'DE89 3704 0044 0532 0130 01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.gueltig, r.body.bic], [false, null]);
  assert.match(r.body.text, /Prüfziffer passt nicht/);
  r = await call('POST', P, { iban: 'DE8937040044053201300' });
  assert.match(r.body.text, /22 Stellen, eingegeben sind 21/);
  r = await call('POST', P, { iban: 'de02 1203 0000 0000 2020 51' });
  assert.deepEqual([r.body.gueltig, r.body.iban, r.body.anzeige, r.body.blz, r.body.bic, r.body.verzeichnis], [true, 'DE02120300000000202051', 'DE02 1203 0000 0000 2020 51', '12030000', null, 0]);
  assert.match(r.body.text, /Verzeichnis ist noch nicht geladen/);

  // ersatzweise aus dem eigenen Bestand: gleiche Bankleitzahl bei einer anderen Person
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, mitglnrn, zahlungsart, iban1, bic1, bank1)
            values ('0000000901', 'Berta', 'Bestand', '2020-01-01', '901', 'L', 'DE02370400440000000001', 'COBADEFFXXX', 'Commerzbank Köln')`;
  r = await call('POST', P, { iban: 'DE89370400440532013000' });
  assert.deepEqual([r.body.bic, r.body.quelle], ['COBADEFFXXX', 'BESTAND'], JSON.stringify(r.body));
  assert.ok(r.body.bank);

  // Verzeichnis laden: geht vor
  r = await call('POST', `${M}/bank/blz`, { datei: Buffer.from(txt, 'latin1').toString('base64') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /2 Kreditinstitute, 2 mit BIC/);
  assert.equal(r.body.anzahl, 2);
  r = await call('POST', P, { iban: 'DE89370400440532013000' });
  assert.deepEqual([r.body.bic, r.body.bank, r.body.quelle], ['COBADEFFXXX', 'Commerzbank, Köln', 'VERZEICHNIS']);
  // ausländische IBAN: gültig, ohne Ermittlung
  r = await call('POST', P, { iban: 'FR14 2004 1010 0505 0001 3M02 606' });
  assert.deepEqual([r.body.gueltig, r.body.bic], [true, null]);
  assert.equal((await call('POST', `${M}/bank/blz`, { datei: Buffer.from('x').toString('base64') })).status, 400);

  // Neues SEPA-Mandat: Lastschrift mit IBAN, kein aktives Mandat
  r = await call('POST', `${M}/m/0000000901/sepa`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mandat, '90190111');
  assert.match(r.body.text, /SEPA-Mandat 90190111 für Berta Bestand/);
  let [s] = await sql`select mandatsnr, mandkey, status, gueltigbis, lastschriftart from tco.sepa where adrnr = '0000000901'`;
  assert.deepEqual([s.mandatsnr, s.mandkey, s.status, s.gueltigbis, s.lastschriftart], ['90190111', '9019011', 'X', null, 'Basis']);
  r = await call('GET', `${M}/m/0000000901`);
  assert.equal(r.body.sepa[0].aktiv, true);
  assert.equal(r.body.bank.mandatsref, '901901');
  // ein aktives Mandat wird nicht ersetzt
  r = await call('POST', `${M}/m/0000000901/sepa`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits ein aktives SEPA-Mandat \(90190111\)/);
  // ohne Lastschrift bzw. ohne IBAN kein Mandat
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, mitglnrn, zahlungsart) values ('0000000902', 'Udo', 'Überweiser', '2020-01-01', '902', 'U')`;
  r = await call('POST', `${M}/m/0000000902/sepa`, {});
  assert.match(r.body.message, /nur bei Zahlungsart Lastschrift/);
  await sql`update tco.mitglieder set zahlungsart = 'L' where adrnr = '0000000902'`;
  r = await call('POST', `${M}/m/0000000902/sepa`, {});
  assert.match(r.body.message, /fehlt die IBAN/);
  // abweichender Zahler: das Mandat entsteht beim Zahler – der hat schon eines
  await sql`update tco.mitglieder set adrnrkih = '0000000901' where adrnr = '0000000902'`;
  r = await call('POST', `${M}/m/0000000902/sepa`, {});
  assert.match(r.body.message, /Für Berta Bestand besteht bereits ein aktives SEPA-Mandat/);
  await sql`delete from tco.sepa where adrnr = '0000000901'`;
  await sql`delete from tco.mitglieder where adrnr in ('0000000901', '0000000902')`;
});
