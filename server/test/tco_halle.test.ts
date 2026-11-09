/**
 * Integrationstest TCO Hallenabrechnung gegen eine LEERE Test-Datenbank.
 * Paperless-ngx und n8n werden durch einen lokalen HTTP-Server nachgebildet.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { preisBerechnen } = await import('../../modules/tco/server/halle/preis.js');
const { mobilnummer } = await import('../../modules/tco/server/kommunikation.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.rawPayload, ct };
}
const H = '/api/m/tco/halle';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------- Paperless/n8n-Attrappe
const mock = { docs: new Map<number, { versions: number[]; notes: string[]; meta: Record<string, unknown>; title?: string; content?: string }>(), next: 100, mails: [] as any[], uploads: 0, versionUploads: 0, ocr: '' };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = req.url ?? '';
    if (req.headers.authorization !== 'Token geheim' && !u.startsWith('/webhook')) return send(401, {});
    let m: RegExpExecArray | null;
    if (u === '/api/documents/post_document/') {
      const id = mock.next++;
      const titel = /name="title"\r\n\r\n([^\r]*)\r\n/.exec(Buffer.from(body, 'latin1').toString('utf8'))?.[1];
      const bild = /Content-Type: image\//i.test(body);
      mock.docs.set(id, { versions: [], notes: [], meta: {}, title: titel, content: bild ? mock.ocr : '' });
      mock.uploads++;
      return send(200, `task-${id}`);
    }
    if ((m = /^\/api\/documents\/(\d+)\/update_version\/$/.exec(u))) {
      const d = mock.docs.get(Number(m[1]));
      if (!d) return send(404, {});
      const vid = mock.next++;
      d.versions.push(vid);
      mock.versionUploads++;
      return send(200, `task-${vid}`);
    }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) {
      const id = Number(m[1]);
      const root = [...mock.docs].find(([k, d]) => k === id || d.versions.includes(id))?.[0];
      return send(200, [{ status: 'SUCCESS', related_document: String(root === id ? id : id) }]);
    }
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const art = u.split('/')[2];
      const lists: Record<string, unknown[]> = {
        correspondents: [], document_types: [{ id: 1, name: 'Hallenrechnung' }], storage_paths: [{ id: 2, name: 'Buchhaltung' }],
        custom_fields: [{ id: 3, name: 'Betrag', data_type: 'monetary' }, { id: 4, name: 'DOKID', data_type: 'string' }], tags: [],
      };
      return send(200, { results: lists[art], next: null });
    }
    if (u === '/api/correspondents/' && req.method === 'POST') return send(201, { id: 7, name: JSON.parse(body).name });
    if ((m = /^\/api\/documents\/(\d+)\/notes\/$/.exec(u))) {
      const d = mock.docs.get(Number(m[1]))!;
      if (req.method === 'POST') { d.notes.push(JSON.parse(Buffer.from(body, 'latin1').toString('utf8')).note); return send(200, []); }
      return send(200, d.notes.map((n, i) => ({ id: i, note: n, created: '2026-11-07T10:00:00Z' })));
    }
    if ((m = /^\/api\/documents\/(\d+)\/share_links\/$/.exec(u))) return send(200, []);
    if (u === '/api/share_links/') return send(201, { slug: `slug${JSON.parse(body).document}` });
    if ((m = /^\/api\/documents\/(\d+)\/download\//.exec(u))) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 test'); }
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      const id = Number(m[1]);
      const d = mock.docs.get(id);
      if (!d) return send(404, {});
      if (req.method === 'PATCH') { d.meta = JSON.parse(body); return send(200, {}); }
      if (req.method === 'DELETE') { mock.docs.delete(id); res.writeHead(204); return res.end(); }
      return send(200, { id, title: d.title ?? '', content: d.content ?? '', custom_fields: [], versions: [{ id }, ...d.versions.map((v) => ({ id: v, version_label: 'Neudruck' }))] });
    }
    if (u === '/webhook/tco-mailversand') {
      const j = JSON.parse(Buffer.from(body, 'latin1').toString('utf8'));
      mock.mails.push(j);
      return send(200, { status: j.modus === 'entwurf' ? 'entwurf' : 'gesendet', message_id: 'm1' });
    }
    if (u === '/api/trash/') return send(200, {});
    if (u === '/webhook/ep3') return send(200, { bookings_csv: 'BID;DATUM;TIME_START;TIME_ENDE;KUNDE;STATUS\n900;03.11.2026;10:00;11:00;Erika Muster;single\n' });
    send(404, { u });
  });
});
let port = 0;

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: process.env.TEST_LOG ? { level: 'error' } : false } as never);
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => {
  await app?.close();
  await sql.end();
  server.close();
});

test('Preisfindung und Mobilnummern', () => {
  const p = {
    produkte: [
      { prod_key: '005', valid_from: '2026-01-01', valid_to: '9999-12-31', text: 'Winter Tag', preis: 15, typ: '2', menge: null },
      { prod_key: '006', valid_from: '2026-01-01', valid_to: '9999-12-31', text: 'Winter Abend', preis: 20, typ: '2', menge: null },
    ],
    matrix: [
      { prod_key: '005', valid_from: '2026-01-01', valid_to: '9999-12-31', tag: 'MONTAG', zeit_von: '07:00:00', zeit_bis: '17:00:00' },
      { prod_key: '006', valid_from: '2026-01-01', valid_to: '9999-12-31', tag: 'MONTAG', zeit_von: '17:00:00', zeit_bis: '22:00:00' },
    ],
  };
  // Montag 02.11.2026 16:00–18:00 → 15 + 20
  let r = preisBerechnen({ datum: '2026-11-02', time_start: '16:00:00', time_ende: '18:00:00', status: '1' }, p);
  assert.deepEqual([r.betrag, r.dauer, r.fehler], [35, 120, null]);
  // 16:30–17:15 → 15/2 + 20/4 = 12,50; Leitprodukt 005 (30 Min.)
  r = preisBerechnen({ datum: '2026-11-02', time_start: '16:30:00', time_ende: '17:15:00', status: '1' }, p);
  assert.deepEqual([r.betrag, r.prodKey], [12.5, '005']);
  // Lücke nach 22 Uhr
  r = preisBerechnen({ datum: '2026-11-02', time_start: '21:30:00', time_ende: '22:30:00', status: '1' }, p);
  assert.match(r.fehler!, /Kein Hallenpreis für Montag 22:00 bis 22:30/);
  assert.equal(r.betrag, 0);
  // storniert: kein Preis, kein Fehler
  r = preisBerechnen({ datum: '2026-11-02', time_start: '10:00:00', time_ende: '11:00:00', status: '2' }, p);
  assert.deepEqual([r.betrag, r.fehler], [0, null]);
  // Dienstag ohne Fenster
  r = preisBerechnen({ datum: '2026-11-03', time_start: '10:00:00', time_ende: '11:00:00', status: '1' }, p);
  assert.match(r.fehler!, /Dienstag/);

  assert.equal(mobilnummer('0171-1234567'), '491711234567');
  assert.equal(mobilnummer('+49 (0)171 1234567'), '491711234567');
  assert.equal(mobilnummer('06854 1234'), '');
  assert.equal(mobilnummer('+33 6 12 34 56 78'), '33612345678');
});

test('Hallenabrechnung: Import, Zuordnung, Rechnung, Druck, Versand', async () => {
  // ---- Vereinsdaten mit Paperless- und n8n-Attrappe
  let r = await call('GET', '/api/m/tco/verein');
  const v = r.body;
  r = await call('PUT', '/api/m/tco/verein', {
    ...v, paperless_url: `http://127.0.0.1:${port}`, paperless_token: 'geheim',
    n8n_mail_url: `http://127.0.0.1:${port}/webhook/tco-mailversand`, n8n_mail_key: 'k', n8n_ep3_url: `http://127.0.0.1:${port}/webhook/ep3`,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', '/api/m/tco/verein');
  assert.equal(r.body.paperless_token, '********');
  r = await call('POST', '/api/m/tco/verein/paperless-test');
  assert.equal(r.body.ok, true, r.body.text);

  // ---- SAP-Übernahme: Mitglieder (generischer Import)
  const mg = 'MANDT;ADRNR;ANREDE;VORNAME;NACHNAME;STRASSE;PLZ;ORT;EMAIL;GESCHLECHT;TELEFON6;EINTRITT;AUSTRITT\n' +
    '100;0000000012;Herr;Max;Meier-Lüdenscheid;Hauptstr. 1;66649;Oberthal;max@example.org;M;0171 1234567;20100101;00000000\n';
  r = await call('POST', '/api/m/tco/import/pruefen', { dateien: [{ name: 'ZTCO_MITGLIEDER.CSV', data: b64(mg) }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body[0].tabelle, r.body[0].saetze, r.body[0].neu], ['mitglieder', 1, 1]);
  r = await call('POST', '/api/m/tco/import/ausfuehren', { dateien: [{ name: 'ZTCO_MITGLIEDER.CSV', data: b64(mg) }], modus: 'neu' });
  assert.equal(r.body[0].geschrieben, 1);
  const [m] = await sql`select eintritt::text, austritt from tco.mitglieder where adrnr = '0000000012'`;
  assert.deepEqual([m.eintritt, m.austritt], ['2010-01-01', null]);

  // ---- Hallenpreise pflegen
  const produkte = [
    { prod_key: '001', valid_from: '2026-01-01', text: 'Abo', preis: 300, typ: '1' },
    { prod_key: '005', valid_from: '2026-01-01', text: 'Einzel Winter Tag', preis: 15, typ: '2' },
    { prod_key: '006', valid_from: '2026-01-01', text: 'Einzel Winter Abend', preis: 20, typ: '2' },
    { prod_key: '008', valid_from: '2026-01-01', text: 'Hallenschlüssel Pfand', preis: 50, typ: '3' },
    { prod_key: '093', valid_from: '2026-01-01', text: 'Sonstiges', preis: 0, typ: '4' },
  ];
  const tage = ['MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG'];
  const fenster = tage.flatMap((tag) => [
    { prod_key: '005', valid_from: '2026-01-01', tag, zeit_von: '07:00', zeit_bis: '12:00' },
    { prod_key: '005', valid_from: '2026-01-01', tag, zeit_von: '12:00', zeit_bis: '17:00' },
    { prod_key: '006', valid_from: '2026-01-01', tag, zeit_von: '17:00', zeit_bis: '23:00' },
    { prod_key: '001', valid_from: '2026-01-01', tag, zeit_von: '07:00', zeit_bis: '23:00' },
  ]);
  r = await call('POST', `${H}/preise/pruefen`, { produkte, fenster: [...fenster, { prod_key: '006', valid_from: '2026-01-01', tag: 'MONTAG', zeit_von: '16:00', zeit_bis: '18:00' }] });
  assert.ok(r.body.some((b: any) => b.art === 'Fehler' && /unterschiedlichem Preis/.test(b.text)), JSON.stringify(r.body));
  r = await call('PUT', `${H}/preise`, { produkte, fenster });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /21 Zeitblöcke, 5 Produktpreise/);
  const [{ n: blocks }] = await sql`select count(*)::int as n from tco.prmatrix where prod_key = '005'`;
  assert.equal(blocks, 7); // 07–12 und 12–17 zusammengefasst

  // ---- EP3-Import: Kunden, Texte, Buchungen
  const kunden = 'ZUID;ZALIAS;STATUS;EMAIL;KEY;VALUE\n' +
    '17;erika;enabled;erika@example.org;firstname;Erika\n17;erika;enabled;erika@example.org;lastname;Muster\n' +
    '17;erika;enabled;erika@example.org;street;Weg 2\n17;erika;enabled;erika@example.org;zip;66111\n17;erika;enabled;erika@example.org;city;Saarbrücken\n' +
    '17;erika;enabled;erika@example.org;phone;0151 2223334\n17;erika;enabled;erika@example.org;gender;female\n';
  r = await call('POST', `${H}/import/datei`, { name: 'EP3_USER.CSV', data: b64(kunden) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Kunden: 7 gelesen, 1 übertragen/);
  r = await call('POST', `${H}/import/datei`, { name: 'EP3_TEXTE.CSV', data: b64('BID;TEXT\n501;"Training\nmit Ballmaschine"\n') });
  assert.match(r.body.text, /1 übertragen/);
  const bookings = 'BID;DATUM;TIME_START;TIME_ENDE;KUNDE;TEXT;STATUS;PREIS\n' +
    '501;02.11.2026;16:00;18:00;Erika Muster;;single;0\n' +            // Montag, 35 €
    '502;2026-11-03;10:00;11:00;erika muster;;single;0\n' +           // Dienstag, 15 €
    '503;04.11.2026;19:00;20:00;Max Meier-Lüdenscheid;;single;0\n' +  // Mitglied, 20 €
    '600;05.11.2026;18:00;19:00;Max Meier-Lüdenscheid;;subscription;0\n' +
    '600;12.11.2026;18:00;19:00;Max Meier-Lüdenscheid;;subscription;0\n' +
    '504;06.11.2026;10:00;11:00;Erika Muster;;cancelled;0\n' +
    '505;01.12.2099;10:00;11:00;Erika Muster;;single;0\n' +          // Zukunft
    '506;09.11.2026;10:00;11:00;Unbekannt Gast;;single;0\n';          // kein Mitglied, kein EP3-Kunde
  r = await call('POST', `${H}/import/datei`, { name: 'EP3_BOOKINGS.CSV', data: b64(bookings) });
  assert.match(r.body.text, /Buchungen: 8 gelesen, 8 neu/);

  // ---- Übersicht
  r = await call('GET', `${H}/personen?status=1,2,3,5`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const erika = r.body.personen.find((p: any) => p.kunde === 'ERIKA MUSTER');
  assert.deepEqual([erika.offeneBuchungen, erika.betrag, erika.gruppe], [3, 65, '0 – Ohne Rechnung']);
  const max = r.body.personen.find((p: any) => p.kunde === 'MAX MEIER-LÜDENSCHEID');
  assert.equal(max.offeneBuchungen, 2); // Einzel + Abo (eine Serie)
  // Probleme direkt in der Personenliste (#20/#18)
  assert.deepEqual(max.probleme, []);
  assert.deepEqual(erika.probleme, []);
  const gast = r.body.personen.find((p: any) => p.kunde === 'UNBEKANNT GAST');
  assert.deepEqual(gast.probleme.map((x: any) => [x.art, x.schwere]), [['KONTAKT', 'Negative']]);
  assert.match(gast.probleme[0].text, /kein Mitglied und keinen EP3-Kunden/);
  r = await call('GET', `${H}/person?kunde=${encodeURIComponent('UNBEKANNT GAST')}`);
  assert.equal(r.body.probleme[0].art, 'KONTAKT');
  await sql`delete from tco.bookings where bid = '0000000506'`;

  r = await call('GET', `${H}/person?kunde=${encodeURIComponent('MAX MEIER-LÜDENSCHEID')}`);
  assert.equal(r.body.adrnr, '0000000012');
  assert.equal(r.body.kontakt.mobil, '491711234567');
  assert.equal(r.body.kanal, 'E');
  const abo = r.body.buchungen.find((b: any) => b.bid === '0000000600');
  assert.deepEqual([abo.art, abo.termine, abo.betrag], ['Abo', 2, 300]);

  r = await call('GET', `${H}/person?kunde=${encodeURIComponent('ERIKA MUSTER')}`);
  assert.equal(r.body.adrnr, '9900000017');
  const ebs = r.body.buchungen;
  assert.equal(ebs.find((b: any) => b.bid === '0000000501').text, 'Training mit Ballmaschine');

  // ---- Zuordnen (neue Rechnung), Zukunft wird abgewiesen
  r = await call('POST', `${H}/zuordnen`, { rgnr: 'NEU', kunde: 'ERIKA MUSTER', buchungen: ebs.map((b: any) => ({ bid: b.bid, datum: b.datum })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rg = r.body.rgnr_txt;
  assert.match(rg, /^2026_001$/);
  assert.equal(r.body.anzahl, 2);
  assert.equal(r.body.zukunft, 1);
  let [k] = await sql`select betrag::float8 as betrag, status, adrnr from tco.rgkopf where rgnr_txt = ${rg}`;
  assert.deepEqual([k.betrag, k.status, k.adrnr], [50, '1', '9900000017']);

  // ---- manuelle Positionen: Schlüssel (Schlüsselliste), Sonstiges mit freiem Preis
  r = await call('POST', `${H}/rechnungen/${rg}/positionen`, { prod_key: '008', menge: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Schlüsselausgabe/);
  r = await call('POST', `${H}/rechnungen/${rg}/positionen`, { prod_key: '093', menge: '1,5', preis: -10, beschreibung: 'Gutschrift' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  [k] = await sql`select betrag::float8 as betrag from tco.rgkopf where rgnr_txt = ${rg}`;
  assert.equal(k.betrag, 85); // 50 + 50 − 15
  r = await call('POST', `${H}/rechnungen/${rg}/positionen`, { prod_key: '093', menge: 1 });
  assert.equal(r.status, 400); // Beschreibung/Preis fehlt

  r = await call('GET', `${H}/rechnungen/${rg}`);
  const pos = r.body.positionen;
  assert.equal(pos.length, 4);
  const p1 = pos.find((p: any) => p.bid === '0000000501');
  assert.deepEqual([p1.anzahl, p1.ep, p1.betrag], [2, 17.5, 35]);
  assert.ok(p1.beschreibung.startsWith('Einzelbuchung\tMontag\t02.11.2026\t16:00 - 18:00 Uhr'));
  const pg = pos.find((p: any) => p.prod_key === '093');
  assert.deepEqual([pg.anzahl, pg.ep, pg.betrag, pg.beschreibung], [1.5, -10, -15, 'Gutschrift']);

  // ---- Position entfernen gibt die Buchung frei
  r = await call('DELETE', `${H}/rechnungen/${rg}/positionen/${p1.rgpos}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  [k] = await sql`select betrag::float8 as betrag from tco.rgkopf where rgnr_txt = ${rg}`;
  assert.equal(k.betrag, 50);
  const [b501] = await sql`select assigned from tco.bookings where bid = '0000000501'`;
  assert.equal(b501.assigned, '');
  r = await call('POST', `${H}/zuordnen`, { rgnr: rg, kunde: 'ERIKA MUSTER', buchungen: [{ bid: '0000000501', datum: '2026-11-02' }] });
  assert.equal(r.body.anzahl, 1);
  r = await call('POST', `${H}/rechnungen/${rg}/nummerieren`);
  assert.match(r.body.text, /4 Positionen/);

  // ---- PDF-Vorschau
  r = await call('GET', `${H}/rechnungen/${rg}/pdf`);
  assert.equal(r.status, 200);
  assert.ok((r.body as Buffer).subarray(0, 4).toString() === '%PDF');
  if (process.env.PDF_OUT) fs.writeFileSync(`${process.env.PDF_OUT}/Hallenrechnung_${rg}.pdf`, r.body as Buffer);

  // ---- Drucken → Paperless (neu), Metadaten, Freigabelink
  r = await call('POST', `${H}/rechnungen/${rg}/drucken`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /nach Paperless gedruckt \(Dokument 100\)/);
  assert.equal(r.body.link, `http://127.0.0.1:${port}/share/slug100`);
  assert.deepEqual(mock.docs.get(100)!.meta, {
    title: `Hallenrechnung ${rg}`, correspondent: 7, document_type: 1, storage_path: 2, created: new Date().toLocaleDateString('sv-SE'),
    custom_fields: [{ field: 3, value: 'EUR85.00' }, { field: 4, value: rg }],
  });
  [k] = await sql`select status, doknr, gedruckt from tco.rgkopf where rgnr_txt = ${rg}`;
  assert.deepEqual([k.status, k.doknr], ['2', '100']);

  // ---- E-Mail mit Neudruck → neue Version, Status versendet, Notiz
  r = await call('GET', `${H}/rechnungen/${rg}/mailtext`);
  assert.equal(r.body.an, 'erika@example.org');
  assert.match(r.body.text, /Hallo Erika/);
  r = await call('POST', `${H}/mail`, { rgnrs: [rg], an: r.body.an, betreff: r.body.betreff, text: r.body.text, neudruck: true, entwurf: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'gesendet');
  assert.equal(mock.versionUploads, 1);
  assert.equal(mock.mails[0].anwendung, 'HALLENRECHNUNG');
  assert.equal(mock.mails[0].anhaenge[0].dateiname, `Rechnung_${rg}.pdf`);
  assert.match(mock.docs.get(100)!.notes[0], /E-Mail gesendet/);
  [k] = await sql`select status from tco.rgkopf where rgnr_txt = ${rg}`;
  assert.equal(k.status, '3');

  // ---- versendet: keine Positionen mehr; Wiedereröffnen nur mit Begründung
  r = await call('POST', `${H}/rechnungen/${rg}/positionen`, { prod_key: '008', menge: 1 });
  assert.equal(r.status, 400);
  r = await call('POST', `${H}/rechnungen/${rg}/status`, { aktion: 'entsperren' });
  assert.equal(r.status, 400);
  r = await call('POST', `${H}/rechnungen/${rg}/status`, { aktion: 'entsperren', begruendung: 'Korrektur Termin' });
  assert.equal(r.status, 200);
  assert.match(mock.docs.get(100)!.notes.at(-1)!, /wieder eröffnet.*Korrektur Termin/);
  r = await call('DELETE', `${H}/rechnungen/${rg}/positionen/1`, {});
  assert.equal(r.status, 400); // Begründung Pflicht nach Versand
  r = await call('DELETE', `${H}/rechnungen/${rg}/positionen/1`, { begruendung: 'falsch gebucht' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // ---- WhatsApp
  r = await call('POST', `${H}/whatsapp`, { rgnrs: [rg], nummer: '+49 151 2223334', text: 'Hallo\n[LINKS]', neudruck: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/wa\.me\/491512223334\?text=Hallo/);
  r = await call('POST', `${H}/whatsapp/bestaetigen`, { nummer: '491512223334', links: r.body.links });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // ---- Abo: Zuordnung sperrt die Serie, neue Termine erben die Sperre
  r = await call('POST', `${H}/zuordnen`, { rgnr: 'NEU', kunde: 'MAX MEIER-LÜDENSCHEID', buchungen: [{ bid: '0000000600', datum: '2026-11-05' }] });
  assert.equal(r.body.anzahl, 1);
  const rg2 = r.body.rgnr_txt;
  const offen600 = await sql`select count(*)::int as n from tco.bookings where bid = '0000000600' and coalesce(assigned, '') = ''`;
  assert.equal(offen600[0].n, 0);
  r = await call('POST', `${H}/import/datei`, { name: 'b.csv', data: b64('BID;DATUM;TIME_START;TIME_ENDE;KUNDE;STATUS\n600;19.11.2026;18:00;19:00;Max Meier-Lüdenscheid;subscription\n') });
  assert.match(r.body.text, /automatisch mitgesperrt/);
  // Reparatur: ein früherer Import hat einen Termin der bezahlten Serie offen angelegt (Serie verschoben)
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, assigned)
            values ('0000000600', '2026-11-26', '18:00', '19:00', 'MAX MEIER-LÜDENSCHEID', '3', '')`;
  r = await call('POST', `${H}/import/datei`, { name: 'b.csv', data: b64('BID;DATUM;TIME_START;TIME_ENDE;KUNDE;STATUS\n600;26.11.2026;18:00;19:00;Max Meier-Lüdenscheid;subscription\n') });
  assert.match(r.body.text, /nachträglich gesperrt/);
  const offen600b = await sql`select count(*)::int as n from tco.bookings where bid = '0000000600' and coalesce(assigned, '') = ''`;
  assert.equal(offen600b[0].n, 0);
  [k] = await sql`select betrag::float8 as betrag, adrnr from tco.rgkopf where rgnr_txt = ${rg2}`;
  assert.deepEqual([k.betrag, k.adrnr], [300, '0000000012']);

  // ---- Buchung irrelevant / wieder offen
  r = await call('POST', `${H}/buchungen/aktion`, { bid: '0000000503', datum: '2026-11-04', aktion: 'irrelevant' });
  assert.equal(r.status, 200);
  r = await call('GET', `${H}/irrelevant?kunde=${encodeURIComponent('MAX MEIER-LÜDENSCHEID')}`);
  assert.equal(r.body.length, 1);
  r = await call('POST', `${H}/buchungen/aktion`, { bid: '0000000503', datum: '2026-11-04', aktion: 'relevant' });
  assert.equal(r.status, 200);

  // ---- automatische Zuordnung
  r = await call('GET', `${H}/auto`);
  const maxAuto = r.body.find((x: any) => x.kunde === 'MAX MEIER-LÜDENSCHEID');
  assert.equal(maxAuto.ziel, rg2); // jüngste Rechnung „In Bearbeitung“
  assert.equal(maxAuto.zielInfo.find((z: any) => z.rgnr === rg2).status, '1');
  r = await call('POST', `${H}/auto`, { kunden: r.body.map((x: any) => ({ kunde: x.kunde, ziel: x.ziel, buchungen: x.buchungen.filter((b: any) => b.auswahl).map((b: any) => ({ bid: b.bid, datum: b.datum })) })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /2 Buchung\(en\) zugeordnet: 1 neue Rechnung\(en\), 1 bestehende ergänzt/);

  // ---- gezahlt, Zahlungen, Änderungsbelege
  r = await call('POST', `${H}/rechnungen/${rg2}/status`, { aktion: 'bezahlt' });
  assert.equal(r.status, 200);
  r = await call('GET', `/api/audit/object/RECHNUNG/${rg2}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.some((d: any) => d.username === 'admin'));

  // ---- EP3 über n8n
  r = await call('POST', `${H}/import/n8n`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body[0].text, /1 neu/);
});

test('Hallenabrechnung: BID-Format SAP/EP3, Abo als Einzel, Sommer-Abos', async () => {
  // Bestand aus SAP (10-stellige BID): abgerechnet, irrelevant, Abo als Einzel
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, assigned) values
    ('0000007001', '2026-10-10', '10:00', '11:00', 'ANDREAS THEWES', '1', 'X'),
    ('0000007002', '2026-10-11', '10:00', '11:00', 'EVA SCHEID', '1', 'Y'),
    ('0000007100', '2026-10-09', '18:00', '19:00', 'TINA NOACK', '3', '')`;
  await sql`insert into tco.bookings_ch (bid, status_abw) values ('0000007100', '1')`;
  // früherer Portal-Import ohne führende Nullen → Duplikate; Migration 009 räumt auf
  await sql`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, assigned) values
    ('7001', '2026-10-10', '10:00', '11:00', 'ANDREAS THEWES', '1', ''),
    ('7002', '2026-10-11', '10:00', '11:00', 'EVA SCHEID', '1', ''),
    ('7100', '2026-10-16', '18:00', '19:00', 'TINA NOACK', '3', '')`;
  const mig = fs.readFileSync(new URL('../../modules/tco/server/migrations/009_bid_format.sql', import.meta.url), 'utf8');
  await sql.unsafe(mig);
  const rest = await sql`select bid, datum::text, assigned from tco.bookings where bid like '%70%' or bid like '%71%' order by bid, datum`;
  assert.deepEqual(rest.map((x) => [x.bid, x.datum, x.assigned]), [
    ['0000007001', '2026-10-10', 'X'], ['0000007002', '2026-10-11', 'Y'], ['0000007100', '2026-10-09', ''], ['0000007100', '2026-10-16', ''],
  ]);

  // EP3-Import ohne führende Nullen trifft den SAP-Satz
  let r = await call('POST', `${H}/import/datei`, { name: 'b.csv', data: b64('BID;DATUM;TIME_START;TIME_ENDE;KUNDE;STATUS;SQUARE\n7002;11.10.2026;10:00;11:00;Eva Scheid;single;Halle\n7100;23.10.2026;18:00;19:00;Tina Noack;subscription;Halle\n') });
  assert.match(r.body.text, /1 neu, 0 aktualisiert, 1 bereits abgerechnet/);
  r = await call('GET', `${H}/person?kunde=${encodeURIComponent('EVA SCHEID')}`);
  assert.equal(r.body.buchungen.length, 0);
  r = await call('GET', `${H}/person?kunde=${encodeURIComponent('ANDREAS THEWES')}`);
  assert.equal(r.body.buchungen.length, 0);
  // Abo als Einzel: jeder Termin einzeln (16.10. fehlt im EP3-Export dieses Zeitraums → entfallen)
  r = await call('GET', `${H}/person?kunde=${encodeURIComponent('TINA NOACK')}`);
  assert.deepEqual(r.body.buchungen.map((b: any) => [b.bid, b.datum, b.art]), [
    ['0000007100', '2026-10-09', 'Einzel'], ['0000007100', '2026-10-23', 'Einzel']]);

  // Sommer-Abos: Außenplatz entfällt, Halle wird abgerechnet
  r = await call('POST', `${H}/import/datei`, { name: 'b.csv', data: b64('BID;DATUM;TIME_START;TIME_ENDE;KUNDE;STATUS;SQUARE\n' +
    '8001;14.09.2026;18:00;19:00;Yury Klimov;subscription;Platz 1\n8001;21.09.2026;18:00;19:00;Yury Klimov;subscription;Platz 1\n' +
    '8002;15.09.2026;18:00;19:00;Yury Klimov;subscription;Halle\n' +
    '8003;28.09.2026;18:00;19:00;Yury Klimov;subscription;\n8003;05.10.2026;18:00;19:00;Yury Klimov;subscription;\n') });
  r = await call('GET', `${H}/person?kunde=${encodeURIComponent('YURY KLIMOV')}`);
  assert.deepEqual(r.body.buchungen.map((b: any) => [b.bid, b.datum, b.termine]), [['0000008002', '2026-09-15', 1], ['0000008003', '2026-10-05', 1]]);
});

test('Rechnungen ohne Hallenbuchung: Namensabgleich, neuer Kunde, je Person eine Rechnung (#18)', async () => {
  let r = await call('GET', `${H}/sammel/kandidaten`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.some((k: any) => k.key === 'M:0000000012' && k.name === 'Max Meier-Lüdenscheid'));
  assert.ok(r.body.some((k: any) => k.key === 'K:17' && k.info.startsWith('EP3-Kunde')));

  r = await call('POST', `${H}/sammel/namen`, { text: '1. Meier-Lüdenscheid, Max\nErika Muster\nErka Mustr\nHans Neu\n\nErika Muster' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((t: any) => [t.zeile, t.vorschlaege[0]?.key ?? null, t.vorschlaege[0]?.punkte ?? null]), [
    ['Meier-Lüdenscheid, Max', 'M:0000000012', 100],
    ['Erika Muster', 'K:17', 100],
    ['Erka Mustr', 'K:17', 70],            // Tippfehler aus der Texterkennung → Vorschlag zur Prüfung
    ['Hans Neu', null, null],
  ]);
  assert.deepEqual([r.body[3].vorname, r.body[3].nachname], ['Hans', 'Neu']);

  assert.equal((await call('POST', `${H}/sammel/bild`, { bild: 'data:text/plain;base64,eA==' })).status, 400);

  r = await call('POST', `${H}/sammel`, {
    position: { prod_key: '093', beschreibung: 'Teilnahme Winterhallenrunde', menge: '1', preis: '25' }, anhaengen: false,
    empfaenger: [{ key: 'M:0000000012' }, { key: 'K:17' }, { neu: { vorname: 'Hans', nachname: 'Neu', email: 'hans@example.org' } }, { key: 'M:0000000012' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rechnungen.length, 3, 'doppelte Person nur einmal');
  assert.match(r.body.text, /3 neue Rechnung\(en\), 1 Kunde\(n\) neu angelegt/);
  const [kunde] = await sql`select zuid, nachname, email, status from tco.kunden where nachname = 'Neu'`;
  assert.ok(Number(kunde.zuid) >= 90_000_000);
  assert.deepEqual([kunde.email, kunde.status], ['hans@example.org', 'portal']);
  const hans = r.body.rechnungen.find((x: any) => x.name === 'Hans Neu');
  const [k] = await sql`select kunde, adrnr, betrag::float8 as betrag, status from tco.rgkopf where rgnr_txt = ${hans.rgnr}`;
  assert.deepEqual({ ...k }, { kunde: 'HANS NEU', adrnr: `99${kunde.zuid}`, betrag: 25, status: '1' });

  // erneut mit „anhängen“: dieselbe Person bekommt die Position auf ihre offene Rechnung
  r = await call('POST', `${H}/sammel`, { position: { prod_key: '093', beschreibung: 'Ballkauf', menge: '2', preis: '3,50' }, anhaengen: true, empfaenger: [{ key: `K:${kunde.zuid}` }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rechnungen[0].rgnr, hans.rgnr);
  assert.equal(r.body.rechnungen[0].neu, false);
  assert.equal((await sql`select betrag::float8 as b from tco.rgkopf where rgnr_txt = ${hans.rgnr}`)[0].b, 32);

  // Person erscheint in der Liste – mit Anschrift-Hinweis (Kunde ohne Straße)
  r = await call('GET', `${H}/personen?status=1`);
  const p = r.body.personen.find((x: any) => x.kunde === 'HANS NEU');
  assert.ok(p, JSON.stringify(r.body.personen.map((x: any) => x.kunde)));
  assert.deepEqual(p.probleme.map((x: any) => x.art), ['ANSCHRIFT']);
});

test('Sammelrechnung: Mannschaftsaufstellung (nuLiga) mit Rang, Position und LK', async () => {
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) values
    ('0000000701', 'Alexander', 'Groß', '2015-01-01'), ('0000000702', 'Timo', 'Hinsberger', '2015-01-01'),
    ('0000000703', 'Benjamin', 'Hartyniuk', '2015-01-01'), ('0000000704', 'Torsten', 'Schläfke', '2015-01-01')`;
  // so kommt die Aufstellung aus der Zwischenablage bzw. der Texterkennung
  const text = 'TC Oberthal 1\n1\tGross, Alexander (1, LK5,3)\n2\tHinsberger, Timo (3, LK7,2)\n3 Hartyniuk, Benjamin (9, LK12,7)\n4  Schläfke, Torsten (19, LK20,7)\n';
  let r = await call('POST', `${H}/sammel/namen`, { text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((t: any) => [t.zeile, t.vorschlaege[0]?.key, t.vorschlaege[0]?.punkte]), [
    ['Gross, Alexander', 'M:0000000701', 100],      // „Gross“ = „Groß“
    ['Hinsberger, Timo', 'M:0000000702', 100],
    ['Hartyniuk, Benjamin', 'M:0000000703', 100],
    ['Schläfke, Torsten', 'M:0000000704', 100],
  ], 'Überschrift „TC Oberthal 1“ übergangen, Rang/Position/LK entfernt');
  // jeder bekommt eine Position (eigene Rechnung)
  r = await call('POST', `${H}/sammel`, {
    position: { prod_key: '093', beschreibung: 'Teilnahme Winterhallenrunde', menge: '1', preis: '40' }, anhaengen: false,
    empfaenger: r.body.map((t: any) => ({ key: t.vorschlaege[0].key })),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rechnungen.map((x: any) => x.name), ['Alexander Groß', 'Timo Hinsberger', 'Benjamin Hartyniuk', 'Torsten Schläfke']);
  const k = await sql`select adrnr, betrag::float8 as betrag from tco.rgkopf where rgnr_txt = any(${r.body.rechnungen.map((x: any) => x.rgnr)}) order by adrnr`;
  assert.deepEqual(k.map((x) => [x.adrnr, x.betrag]), [['0000000701', 40], ['0000000702', 40], ['0000000703', 40], ['0000000704', 40]]);
});

test('Sammelrechnung: Screenshot in Paperless, erneut lesen per DOKID, Verknüpfung mit den Positionen', async () => {
  mock.ocr = 'TC Oberthal 1\n1 Gross, Alexander (1, LK5,3)\n2 Hinsberger, Timo (3, LK7,2)\n';
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let r = await call('POST', `${H}/sammel/bild`, { bild: png });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const docId = r.body.docId;
  assert.match(String(mock.docs.get(docId)!.title), /^Sammelrechnung Namensliste/);
  assert.deepEqual(r.body.treffer.map((t: any) => t.vorschlaege[0].key), ['M:0000000701', 'M:0000000702']);

  // erneut lesen per DOKID
  r = await call('POST', `${H}/sammel/dokid`, { dokid: docId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.treffer.map((t: any) => t.zeile), ['Gross, Alexander', 'Hinsberger, Timo']);
  assert.equal((await call('POST', `${H}/sammel/dokid`, { dokid: 99999 })).status, 404);
  // Dokument ohne erkannten Text
  mock.docs.set(98765, { versions: [], notes: [], meta: {}, title: 'Leer', content: '' });
  r = await call('POST', `${H}/sammel/dokid`, { dokid: 98765 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /keinen erkannten Text/);

  // Sichern: Beleg an jeder Position, Notiz im Beleg
  r = await call('POST', `${H}/sammel`, {
    position: { prod_key: '093', beschreibung: 'Winterhallenrunde', menge: '1', preis: '40' }, anhaengen: false, belegDocId: docId,
    empfaenger: [{ key: 'M:0000000701' }, { key: 'M:0000000702' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rg = r.body.rechnungen[0].rgnr;
  const [p] = await sql`select beleg_doc_id from tco.rgpos where rgnr_txt = ${rg}`;
  assert.equal(p.beleg_doc_id, docId);
  assert.match(mock.docs.get(docId)!.notes.at(-1)!, new RegExp(`Grundlage für 2 Rechnung\\(en\\) „Winterhallenrunde“: ${rg} \\(Alexander Groß\\)`));
  r = await call('GET', `${H}/rechnungen/${rg}`);
  assert.equal(r.body.positionen[0].beleg_doc_id, docId);
  assert.equal((await call('GET', `${H}/paperless/${docId}/pdf`)).status, 200, 'verknüpfter Beleg darf geöffnet werden');

  // Verwerfen: verknüpfter Beleg bleibt, unbenutzter neuer Beleg wird gelöscht, fremde Dokumente nie
  await call('POST', `${H}/sammel/verwerfen`, { dokid: docId });
  assert.ok(mock.docs.has(docId));
  r = await call('POST', `${H}/sammel/bild`, { bild: png });
  const neu = r.body.docId;
  await call('POST', `${H}/sammel/verwerfen`, { dokid: neu });
  assert.ok(!mock.docs.has(neu), 'unbenutzter Screenshot gelöscht');
  await call('POST', `${H}/sammel/verwerfen`, { dokid: 98765 });
  assert.ok(mock.docs.has(98765), 'fremdes Dokument bleibt');
});
