/**
 * Integrationstest Zuwendungsbestätigungen: Einstellungen und Sperren, Quellen (nur Spenden, nur Zugeflossenes: verbuchte
 * Lastschrift, kein Mitgliedsbeitrag, kein Storno, keine Rücklastschrift, kein Zufluss ohne Geldkonto), Zuordnung von Hand,
 * Einzel- und Sammelbestätigung mit fortlaufender Nummer, keine Doppelbestätigung, Unveränderlichkeit, Storno und
 * Neuausstellung, Ablage in Paperless, Versand per E-Mail (jedes Ergebnis ungleich „gesendet“ = bitte drucken), Druck,
 * Jahreslauf, Gültigkeit des Bescheids, Berechtigungen. Paperless und Mail-Webhook sind Attrappen.
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
const { umsaetzeBuchen, stornieren: fiStorno } = await import('../../modules/tco/server/fi/buchen.js');
const { heute } = await import('../../modules/tco/server/format.js');
const { plusJahre } = await import('../../modules/tco/server/zuwendung/logik.js');

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
const Z = '/api/m/tco/zuwendung';

// Paperless und Mail-Webhook (n8n) als Attrappe – nichts verlässt den Test
const mails: { an: string; betreff: string; text: string; objekt: string; anhaenge: { dateiname: string; inhalt_base64: string }[] }[] = [];
const mock = { next: 900, uploads: [] as string[], notizen: [] as { id: number; text: string }[], aus: false };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const roh = Buffer.concat(chunks);
    const body = roh.toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = req.url ?? '';
    if (u.startsWith('/webhook/mail')) {
      const m = JSON.parse(body);
      // so meldet sich der zentrale Versand bei einer als unzustellbar vermerkten Adresse: irgendein Status ungleich „gesendet“
      if (m.an === 'unzustellbar@tc-test.example') return send(200, { status: 'abgelehnt', fehler: 'Adresse ist als unzustellbar vermerkt' });
      if (m.an === 'kaputt@tc-test.example') return send(500, { message: 'Workflow error' });
      mails.push(m);
      return send(200, { status: 'gesendet', message_id: `m${mails.length}` });
    }
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    if (mock.aus) return send(503, { detail: 'Paperless nicht erreichbar' });
    let m: RegExpExecArray | null;
    if (u === '/api/documents/post_document/') { mock.uploads.push(roh.toString('latin1')); return send(200, `task-${mock.next++}`); }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const art = u.split('/')[2];
      const lists: Record<string, unknown[]> = {
        correspondents: [], document_types: [{ id: 1, name: 'Zuwendungsbestätigung' }], storage_paths: [{ id: 2, name: 'Buchhaltung' }],
        custom_fields: [{ id: 4, name: 'DOKID', data_type: 'string' }, { id: 5, name: 'Betrag', data_type: 'monetary' }], tags: [],
      };
      return send(200, { results: lists[art], next: null });
    }
    if ((u === '/api/correspondents/' || u === '/api/tags/') && req.method === 'POST') return send(201, { id: 9, name: JSON.parse(body).name });
    if ((m = /^\/api\/documents\/(\d+)\/notes\/$/.exec(u))) { if (req.method === 'POST') mock.notizen.push({ id: Number(m[1]), text: JSON.parse(body).note }); return send(200, []); }
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      if (req.method === 'PATCH') return send(200, {});
      return send(200, { id: Number(m[1]), title: '', document_type: null, storage_path: null, created: '2026-11-10', custom_fields: [], versions: [] });
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

// eigene Stammdaten dieses Tests: Adressnummern 71x, Konten 12xx/81xx/80xx, Beitragsarten 001/002/101, Läufe 71/72
const MIA = '0000000711', TOM = '0000000712', LEA = '0000000713', OTTO = '0000000714';
// Spenden des Vorjahrs (J) und des Jahres davor (VJ): unabhängig vom Tag, an dem der Test läuft, liegt nichts in der Zukunft
const J = Number(heute().slice(0, 4)) - 1;
const VJ = J - 1;
const H = heute();
const tag = (monat: number, t: number) => `${J}-${String(monat).padStart(2, '0')}-${String(t).padStart(2, '0')}`;
const ctx = { userId: null as never, username: 'Test', action: 'TEST' };
type Pos = { gkonto: string; betrag: number; text?: string };
const buchen = async (datum: string, text: string, betrag: number, positionen: Pos[], konto = '1271', laufid?: string) =>
  (await withChange(ctx, (tx) => umsaetzeBuchen(tx, [{ konto, datum, text, betrag, positionen: positionen.map((p) => ({ ...p, rgnr: null })), laufid }], 'Test')))[0].internenr;
const k = (internenr: string, konto = '8171', posnr = 0) => `${internenr}|${konto}|${posnr}`;

interface Q { key: string; betrag: number; datum: string; herkunft: string; spender: string | null; zbnr: string | null; sperre: string | null; verzicht: boolean; vorschlag: { adrnr: string; name: string } | null; ausschluss: string | null }
interface Sp { key: string; name: string; anschrift: string[]; email: string; fehlt: string[]; offen: Q[]; bestaetigt: Q[]; gesperrt: Q[]; summe_offen: number }
interface V { sperren: string[]; spender: Sp[]; ohne_spender: Q[]; ausgeschlossen: Q[]; rueckbuchungen: { key: string; betrag: number; kandidaten: string[] }[]; summe_offen: number; anzahl_offen: number }
const vorschlag = async (jahr = J, c = admin): Promise<V> => { const r = await c('GET', `${Z}/vorschlag?jahr=${jahr}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const spender = (v: V, key: string) => v.spender.find((s) => s.key === key);
const einstellungen = (x: Record<string, unknown> = {}) => ({
  bescheid_art: 'FREISTELLUNG', finanzamt: 'St. Wendel', steuernummer: '030/140/12345', bescheid_datum: plusJahre(H, -2), veranlagungszeitraum: `${J - 5} bis ${J - 3}`,
  zweck: 'Förderung des Sports', zweck_satzung: 'den Sport', unterzeichner: 'Karla Kasse', funktion: 'Kassenwartin', ort: 'Oberthal', unterschrift: null,
  spendenkonten: ['8171'], spendenarten: ['101'], mail_erlaubt: false, texte: {}, muster_geprueft: true, ...x,
});

let leser: Awaited<ReturnType<typeof anmelden>>, kasse: Awaited<ReturnType<typeof anmelden>>, mitglied: Awaited<ReturnType<typeof anmelden>>;

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into core.verbindungen (id, url, auth_art, geheimnis, einstellungen) values ('paperless', ${`http://127.0.0.1:${port}`}, 'token', 'geheim', ${sql.json({})})`;
  await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis) values ('mail', ${`http://127.0.0.1:${port}/webhook/mail`}, 'header', 'X-TCO-Key', 'k')
            on conflict (id) do update set url = excluded.url, auth_art = 'header', header_name = 'X-TCO-Key', geheimnis = 'k'`;
  await sql`update tco.verein set name = 'TC Test e. V.', strasse = 'Am Netz 1', plz_ort = '66649 Oberthal', iban = 'DE02120300000000202051', bank = 'Testbank' where id = 1`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, strasse, plz, ort, email) values
    (${MIA}, 'Mia', 'Matchball', '2020-01-01', 'Am Netz 1', '66649', 'Oberthal', 'mia@tc-test.example'),
    (${TOM}, 'Tom', 'Tiebreak', '2020-01-01', 'Grundlinie 2', '66649', 'Oberthal', 'unzustellbar@tc-test.example'),
    (${LEA}, 'Lea', 'Lob', '2015-01-01', 'T-Feld 3', '66649', 'Oberthal', null),
    (${OTTO}, 'Otto', 'Ohneadresse', '2015-01-01', null, null, null, 'kaputt@tc-test.example')`;
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('1271', 'Bank Test', 'BA'), ('8171', 'Spenden', 'AE'), ('8072', 'Mitgliedsbeiträge', 'AE'), ('8073', 'Verzehr', 'CE')
            on conflict (konto) do update set name = excluded.name, kennzahl = excluded.kennzahl`;
  await sql`insert into tco.beitrag (art, bezeichnung, turnus, erloeskonto) values ('001', 'Erwachsene', 'jährlich', '8072'), ('002', 'Förderbeitrag', 'jährlich', '8171'), ('101', 'Spende', 'jährlich', '8171')`;
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'ZUWLESER', name: 'Zuwendung lesen', permissions: ['tco.zuwendung:display'] })).status, 200);
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'ZUWKASSE', name: 'Zuwendung ausstellen', permissions: ['tco.zuwendung:display', 'tco.zuwendung:execute'] })).status, 200);
  for (const [name, rolle] of [['leser', 'ZUWLESER'], ['kasse', 'ZUWKASSE'], ['mitglied', 'MITGLIED']]) {
    assert.equal((await admin('POST', '/api/admin/users', { username: name, displayName: `Test ${name}`, password: 'start-passwort', roles: [rolle] })).status, 200);
  }
  leser = await anmelden('leser'); kasse = await anmelden('kasse'); mitglied = await anmelden('mitglied');
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

test('Berechtigungen: ohne Recht keine App, Anzeigen stellt nicht aus, Einstellungen nur mit Admin-Recht', async () => {
  for (const pfad of ['vorschlag?jahr=2026', 'bestaetigungen', 'personen', 'einstellungen']) assert.equal((await mitglied('GET', `${Z}/${pfad}`)).status, 403, pfad);
  assert.equal((await leser('GET', `${Z}/vorschlag?jahr=${J}`)).status, 200);
  assert.equal((await leser('GET', `${Z}/bestaetigungen`)).status, 200);
  assert.equal((await leser('POST', `${Z}/bestaetigungen`, { art: 'EINZEL', jahr: J, spender: `M:${MIA}` })).status, 403);
  assert.equal((await leser('POST', `${Z}/jahreslauf`, { jahr: J })).status, 403);
  assert.equal((await leser('PUT', `${Z}/quelle`, { key: '1|8171|0', verzicht: true })).status, 403);
  assert.equal((await leser('POST', `${Z}/spender`, { name: 'Firma', strasse: 'Weg 1', plz: '66649', ort: 'Oberthal' })).status, 403);
  assert.equal((await leser('POST', `${Z}/bestaetigungen/ZB-2026-0001/storno`, { grund: 'Test' })).status, 403);
  assert.equal((await leser('POST', `${Z}/bestaetigungen/ZB-2026-0001/senden`, {})).status, 403);
  assert.equal((await leser('POST', `${Z}/bestaetigungen/gedruckt`, { nummern: ['ZB-2026-0001'] })).status, 403);
  assert.equal((await kasse('GET', `${Z}/einstellungen`)).status, 403);
  assert.equal((await kasse('PUT', `${Z}/einstellungen`, einstellungen())).status, 403);
  // Katalog: drei Rechte der App im Bereich Finanzen, Ausstellen und Einstellungen setzen das Anzeigen voraus
  const kat = (await admin('GET', '/api/admin/permissions')).body;
  const text = JSON.stringify(kat);
  for (const id of ['tco.zuwendung:display', 'tco.zuwendung:execute', 'tco.zuwendung:admin']) assert.ok(text.includes(id), id);
});

test('Einstellungen: Vorgaben, Prüfungen (Konto, Geldkonto, Beitragsart, Platzhalter), Sperre bis alles gepflegt und der Wortlaut abgeglichen ist', async () => {
  let r = await admin('GET', `${Z}/einstellungen`);
  assert.equal(r.status, 200);
  assert.equal(r.body.zweck, 'Förderung des Sports');
  assert.equal(r.body.muster_geprueft_am, null);
  assert.equal(r.body.mail_erlaubt, false);
  assert.ok(r.body.fehlt.includes('Finanzamt') && r.body.fehlt.includes('Spendenkonten oder Spenden-Beitragsarten'));
  assert.ok(r.body.konten.some((x: { konto: string; vorschlag: boolean }) => x.konto === '8171' && x.vorschlag), 'Konto „Spenden“ als Vorschlag');
  assert.ok(!r.body.konten.some((x: { konto: string }) => x.konto === '1271'), 'Geldkonten stehen nicht zur Wahl');
  assert.ok(r.body.arten.some((x: { art: string; vorschlag: boolean }) => x.art === '101' && x.vorschlag));
  assert.match(r.body.texte.kein_beitrag, /nicht um einen Mitgliedsbeitrag/);
  assert.ok(r.body.textbausteine.length > 20);

  const v = await vorschlag();
  assert.equal(v.sperren.length, 2);
  assert.match(v.sperren[0], /In den Einstellungen fehlt:.*Art des Bescheids.*Finanzamt.*Steuernummer.*Datum des Bescheids.*Unterzeichner.*Ort.*Spendenkonten/);
  assert.match(v.sperren[1], /amtlichen Muster/);

  assert.match((await admin('PUT', `${Z}/einstellungen`, einstellungen({ spendenkonten: ['8999'] }))).body.message, /Konto nicht im Kontenstamm: 8999/);
  assert.match((await admin('PUT', `${Z}/einstellungen`, einstellungen({ spendenkonten: ['1271'] }))).body.message, /Geldkonten können keine Spendenkonten sein: 1271/);
  assert.match((await admin('PUT', `${Z}/einstellungen`, einstellungen({ spendenarten: ['777'] }))).body.message, /Beitragsart nicht im Beitragsstamm: 777/);
  assert.match((await admin('PUT', `${Z}/einstellungen`, einstellungen({ texte: { verwendung: 'ohne Zweck' } }))).body.message, /Platzhalter \{Zweck\} fehlt/);
  assert.match((await admin('PUT', `${Z}/einstellungen`, einstellungen({ bescheid_datum: plusJahre(H, 1) }))).body.message, /Zukunft/);
  assert.equal((await admin('PUT', `${Z}/einstellungen`, einstellungen({ bescheid_art: 'SONSTWAS' }))).status, 400);

  // alles gepflegt, aber der Wortlaut ist noch nicht abgeglichen: weiter gesperrt
  r = await admin('PUT', `${Z}/einstellungen`, einstellungen({ muster_geprueft: false }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Konto 8171 ist auch Erlöskonto der Beitragsart 002 (keine Spende): Warnung
  assert.match(r.body.warnungen[0], /Konto 8171.*Beitragsart 2 „Förderbeitrag“.*keine Spende/);
  assert.deepEqual((await vorschlag()).sperren.map((s) => /amtlichen Muster/.test(s)), [true]);
  assert.equal((await admin('PUT', `${Z}/einstellungen`, einstellungen())).status, 200);
  assert.deepEqual((await vorschlag()).sperren, []);
  const [c] = await sql`select muster_geprueft_von, muster_geprueft_am, spendenarten from tco.zuw_cfg`;
  assert.equal(c.muster_geprueft_von, 'Admin');
  assert.equal(c.spendenarten, '101');
  // geänderter Wortlaut: die Bestätigung des Abgleichs gilt nur mit erneuter Bestätigung (neuer Zeitpunkt)
  await new Promise((ok) => setTimeout(ok, 15));
  assert.equal((await admin('PUT', `${Z}/einstellungen`, einstellungen({ texte: { hinweis_titel: 'Hinweise:' } }))).status, 200);
  const [c2] = await sql`select muster_geprueft_am, texte from tco.zuw_cfg`;
  assert.ok(c2.muster_geprueft_am > c.muster_geprueft_am, 'neu bestätigt');
  assert.deepEqual(c2.texte, { hinweis_titel: 'Hinweise:' });
  assert.equal((await admin('PUT', `${Z}/einstellungen`, einstellungen())).status, 200);
});

let bMia200 = '', bFirma = '', bUmbuchung = '', bStorniert = '', bLauf = '', firma = '';
test('Quellen: Lastschrift-Spende erst nach Verbuchung, kein Mitgliedsbeitrag, kein Storno, kein Zufluss ohne Geldkonto', async () => {
  // Sollstellung Lauf 71: Mitgliedsbeitrag, Förderbeitrag (kein Spenden-Art, aber auf dem Spendenkonto), zwei Spenden (eine vom abweichenden Zahler)
  await sql`insert into tco.soll_kopf (laufid, sollper, status, anz_pos, anz_tx, summe, faellig) values ('0000000071', ${`${J}01`}, 'E', 4, 3, 215, ${tag(1, 5)})`;
  await sql`insert into tco.soll_pos (sollper, adrnr, vertragnr, laufid, art, artname, beitragsart, betrag, konto, mitglied_name, zahler_adrnr, zahler_name, fi_name, status) values
    (${`${J}01`}, ${MIA}, '1', '0000000071', '001', 'Erwachsene', 'MB', 120, '8072', 'Matchball, Mia', ${MIA}, 'Matchball, Mia', 'Mia Matchball', ''),
    (${`${J}01`}, ${MIA}, '2', '0000000071', '002', 'Förderbeitrag', 'MB', 15, '8171', 'Matchball, Mia', ${MIA}, 'Matchball, Mia', 'Mia Matchball', ''),
    (${`${J}01`}, ${MIA}, '3', '0000000071', '101', 'Spende', 'SP', 50, '8171', 'Matchball, Mia', ${MIA}, 'Matchball, Mia', 'Mia Matchball', ''),
    (${`${J}01`}, ${TOM}, '1', '0000000071', '0101', 'Spende', 'SP', 30, '8171', 'Tiebreak, Tom', ${LEA}, 'Lob, Lea', 'Lea Lob', '')`;
  // nur gestellt, noch nicht verbucht: nichts zu bestätigen
  let v = await vorschlag();
  assert.deepEqual([v.spender.length, v.ohne_spender.length, v.anzahl_offen], [0, 0, 0]);

  bLauf = await buchen(tag(1, 5), 'Sammelgutschrift Lastschrift', 215, [], '1271', '0000000071');
  bMia200 = await buchen(tag(2, 3), 'Spende Mia Matchball Vereinsfest', 200, [{ gkonto: '8171', betrag: 200 }]);
  bFirma = await buchen(tag(2, 4), 'Spende Holzbau Hobel GmbH', 500, [{ gkonto: '8171', betrag: 500 }]);
  // Eingang auf einem anderen Erlöskonto: keine Spende
  await buchen(tag(2, 5), 'Verzehr Mia Matchball', 12, [{ gkonto: '8073', betrag: 12 }]);
  // Umbuchung zwischen Erlöskonten: Haben auf dem Spendenkonto, aber kein Geld geflossen
  bUmbuchung = await buchen(tag(2, 6), 'Umbuchung Beitrag auf Spende', 40, [{ gkonto: '8171', betrag: 40 }], '8072');
  // stornierte Spende: nicht zugeflossen
  bStorniert = await buchen(tag(2, 7), 'Spende Lea Lob Irrtum', 75, [{ gkonto: '8171', betrag: 75 }]);
  await withChange(ctx, (tx) => fiStorno(tx, bStorniert, 'Fehlbuchung', 'Test'));

  v = await vorschlag();
  const mia = spender(v, `M:${MIA}`)!;
  assert.deepEqual(mia.offen.map((q) => [q.betrag, q.herkunft]), [[50, 'SOLL']], 'nur die Spende der Lastschrift – weder Beitrag (8072) noch Förderbeitrag auf dem Spendenkonto');
  assert.deepEqual([mia.name, mia.anschrift, mia.email, mia.fehlt], ['Mia Matchball', ['Am Netz 1', '66649 Oberthal'], 'mia@tc-test.example', []]);
  // Spende für Tom, gezahlt von Lea: Zuwendende ist die Zahlerin
  assert.equal(spender(v, `M:${TOM}`), undefined);
  assert.deepEqual(spender(v, `M:${LEA}`)!.offen.map((q) => q.betrag), [30]);
  // Buchungen ohne erkannten Spender: mit Vorschlag aus dem Buchungstext, wenn genau ein Mitglied passt
  const ohne = new Map(v.ohne_spender.map((q) => [q.key, q]));
  assert.deepEqual([...ohne.keys()].sort(), [k(bMia200), k(bFirma), k(bUmbuchung)].sort(), 'stornierte Buchung und Storno fehlen');
  assert.deepEqual(ohne.get(k(bMia200))!.vorschlag, { adrnr: MIA, name: 'Mia Matchball' });
  assert.equal(ohne.get(k(bFirma))!.vorschlag, null);
  assert.match(ohne.get(k(bUmbuchung))!.sperre!, /Gegenkonto 8072 ist kein Geldkonto – kein Zufluss/);
  assert.equal(v.summe_offen, 80);
  assert.deepEqual(v.rueckbuchungen, []);
  // im Vorjahr gibt es nichts
  assert.equal((await vorschlag(VJ)).spender.length, 0);
});

test('Zuordnung von Hand: Mitglied, Spender ohne Mitgliedschaft mit Name und Anschrift, Verzicht, Ausschluss mit Grund', async () => {
  const p = (await kasse('GET', `${Z}/personen`)).body;
  assert.ok(p.mitglieder.some((m: { key: string; name: string }) => m.key === `M:${MIA}` && m.name === 'Matchball, Mia'));
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(bMia200), spender: `M:${MIA}` })).status, 200);
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(bMia200), spender: 'M:0000009999' })).status, 400, 'unbekanntes Mitglied');
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: '0000099999|8171|0', spender: `M:${MIA}` })).status, 404, 'unbekannte Buchung');
  // Spender ohne Mitgliedschaft: Name und Anschrift sind Pflicht
  assert.equal((await kasse('POST', `${Z}/spender`, { name: 'Holzbau Hobel GmbH', strasse: '', plz: '66649', ort: 'Oberthal' })).status, 400);
  const s = await kasse('POST', `${Z}/spender`, { name: 'Holzbau Hobel GmbH', zusatz: 'z. Hd. Hanna Hobel', strasse: 'Sägeweg 4', plz: '66649', ort: 'Oberthal', email: 'kaputt@tc-test.example' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  firma = s.body.key;
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(bFirma), spender: firma, verzicht: true })).status, 200);
  // Ausschluss braucht einen Grund
  assert.match((await kasse('PUT', `${Z}/quelle`, { key: k(bUmbuchung), ausschluss: 'KEINE_SPENDE' })).body.message, /Grund/);
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(bUmbuchung), ausschluss: 'KEINE_SPENDE', grund: 'Umbuchung, kein Geldeingang' })).status, 200);

  const v = await vorschlag();
  assert.deepEqual(spender(v, `M:${MIA}`)!.offen.map((q) => q.betrag), [50, 200]);
  const f = spender(v, firma)!;
  assert.deepEqual([f.name, f.anschrift, f.offen[0].betrag, f.offen[0].verzicht], ['Holzbau Hobel GmbH, z. Hd. Hanna Hobel', ['Sägeweg 4', '66649 Oberthal'], 500, true]);
  assert.deepEqual(v.ohne_spender, []);
  assert.deepEqual(v.ausgeschlossen.map((q) => [q.key, q.ausschluss]), [[k(bUmbuchung), 'KEINE_SPENDE']]);
  // Ausschluss zurücknehmen und wieder setzen
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(bUmbuchung), ausschluss: null })).status, 200);
  assert.equal((await vorschlag()).ohne_spender.length, 1);
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(bUmbuchung), ausschluss: 'KEINE_SPENDE', grund: 'Umbuchung' })).status, 200);
});

test('Rücklastschrift: ungeklärte Rückbuchung sperrt die Spende; geklärt wird sie ausgeschlossen', async () => {
  // Bank belastet das Konto: 30 € zurück an Lea (Gegenkonto Spendenkonto)
  const rueck = await buchen(tag(2, 20), 'RETOURE Lastschrift Lea Lob', -30, [{ gkonto: '8171', betrag: -30 }]);
  let v = await vorschlag();
  assert.deepEqual(v.rueckbuchungen.map((r) => [r.key, r.betrag, r.kandidaten]), [[k(rueck), 30, [k(bLauf, '8171', 0)]]]);
  const lea = spender(v, `M:${LEA}`)!;
  assert.equal(lea.offen.length, 0);
  assert.match(lea.gesperrt[0].sperre!, /Rückbuchung vom .* über 30,00 € .*ungeklärt – Rücklastschrift\?/);
  assert.equal((await kasse('POST', `${Z}/bestaetigungen`, { art: 'EINZEL', jahr: J, spender: `M:${LEA}`, quellen: [lea.gesperrt[0].key] })).status, 409, 'gesperrte Spende wird nicht bestätigt');
  // klären ohne Angabe geht nicht
  assert.equal((await kasse('POST', `${Z}/rueckbuchung`, { key: k(rueck) })).status, 400);
  assert.equal((await kasse('POST', `${Z}/rueckbuchung`, { key: k(rueck), betrifft: lea.gesperrt[0].key })).status, 200);
  v = await vorschlag();
  assert.deepEqual(v.rueckbuchungen, []);
  assert.equal(spender(v, `M:${LEA}`), undefined, 'Lea hat keine bestätigungsfähige Spende mehr');
  const aus = v.ausgeschlossen.find((q) => q.key === k(bLauf, '8171', 0))!;
  assert.equal(aus.ausschluss, 'RUECKLAST');
  assert.match(aus.sperre!, /Rücklastschrift – nicht zugeflossen: Rückbuchung vom/);
  assert.equal(v.summe_offen, 750);
});

let zb1 = '', zb2 = '';
test('Einzelbestätigung: Vorschau, fortlaufende Nummer, PDF gespeichert, Ablage in Paperless, keine Doppelbestätigung', async () => {
  const pv = await leser('GET', `${Z}/vorschau/pdf?art=EINZEL&jahr=${J}&spender=${encodeURIComponent(`M:${MIA}`)}&quellen=${encodeURIComponent(k(bMia200))}`);
  assert.equal(pv.status, 200);
  assert.equal(pv.raw.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await sql`select count(*)::int as n from tco.zuw_kopf`)[0].n, 0, 'die Vorschau stellt nichts aus');
  // Einzelbestätigung braucht genau eine Spende
  assert.match((await kasse('POST', `${Z}/bestaetigungen`, { art: 'EINZEL', jahr: J, spender: `M:${MIA}` })).body.message, /genau eine Spende/);
  // fremde Spende beim falschen Spender
  assert.equal((await kasse('POST', `${Z}/bestaetigungen`, { art: 'EINZEL', jahr: J, spender: `M:${MIA}`, quellen: [k(bFirma)] })).status, 409);

  const r = await kasse('POST', `${Z}/bestaetigungen`, { art: 'EINZEL', jahr: J, spender: `M:${MIA}`, quellen: [k(bMia200)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  zb1 = r.body.zbnr;
  assert.equal(zb1, `ZB-${J}-0001`);
  assert.equal(r.body.paperless.abgelegt, true, r.body.paperless.text);
  const [kopf] = await sql`select *, tag::text as tag_txt, ausgestellt_am::text as am from tco.zuw_kopf where zbnr = ${zb1}`;
  assert.deepEqual([kopf.art, kopf.status, Number(kopf.betrag), kopf.betrag_worte, kopf.tag_txt, kopf.am, kopf.spender_name, kopf.spender_anschrift, kopf.ausgestellt_von, kopf.verzicht],
    ['EINZEL', 'A', 200, 'zweihundert Euro', tag(2, 3), H, 'Mia Matchball', 'Am Netz 1\n66649 Oberthal', 'Test kasse', false]);
  assert.equal(kopf.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(kopf.pdf_sha256, /^[0-9a-f]{64}$/);
  assert.ok(kopf.paperless_id >= 900);
  // Druckdaten: Bescheid, Zweck, Vermerk „kein Mitgliedsbeitrag“ und Hinweise sind festgehalten
  assert.equal(kopf.daten.bescheid.finanzamt, 'St. Wendel');
  assert.equal(kopf.daten.zweck, 'Förderung des Sports');
  assert.match(kopf.daten.texte.kein_beitrag, /nicht um einen Mitgliedsbeitrag/);
  assert.match(kopf.daten.texte.hinweis_haftung, /haftet/);
  // Paperless: Titel und Datei laut Kontext „Zuwendungsbestätigung“
  assert.ok(new RegExp(`name="title"\\r\\n\\r\\nZuwendungsbest.{1,2}tigung ${zb1} Mia Matchball\\r\\n`).test(mock.uploads.at(-1)!), 'Titel des Doppels in Paperless');
  // das gespeicherte PDF kommt unverändert zurück
  const pdf = await leser('GET', `${Z}/bestaetigungen/${zb1}/pdf`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.raw.equals(kopf.pdf));

  // keine Doppelbestätigung: über die App …
  const doppelt = await kasse('POST', `${Z}/bestaetigungen`, { art: 'EINZEL', jahr: J, spender: `M:${MIA}`, quellen: [k(bMia200)] });
  assert.equal(doppelt.status, 409);
  assert.match(doppelt.body.message, new RegExp(`bereits mit ${zb1} bestätigt`));
  // … in der Datenbank (eindeutiger Index je Buchungszeile) …
  await assert.rejects(sql`insert into tco.zuw_pos (zbnr, lfd, internenr, konto, posnr, datum, betrag) values (${zb1}, 2, ${bMia200}, '8171', 0, ${H}, 200)`, /zuw_pos_quelle/);
  // … und Merkmale einer bestätigten Spende lassen sich nicht mehr ändern
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(bMia200), spender: firma })).status, 409);
  const v = await vorschlag();
  assert.deepEqual(spender(v, `M:${MIA}`)!.bestaetigt.map((q) => [q.key, q.zbnr]), [[k(bMia200), zb1]]);
  assert.deepEqual(spender(v, `M:${MIA}`)!.offen.map((q) => q.betrag), [50]);
});

test('Sammelbestätigung: mindestens zwei Spenden, Anlage mit Verzicht ja/nein, nächste Nummer', async () => {
  // eine einzige offene Spende: keine Sammelbestätigung
  assert.match((await kasse('POST', `${Z}/bestaetigungen`, { art: 'SAMMEL', jahr: J, spender: `M:${MIA}` })).body.message, /mindestens zwei Spenden/);
  const b25 = await buchen(tag(3, 1), 'Spende Mia Matchball Jugend', 25.5, [{ gkonto: '8171', betrag: 25.5 }]);
  assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(b25), spender: `M:${MIA}`, verzicht: true })).status, 200);
  const r = await kasse('POST', `${Z}/bestaetigungen`, { art: 'SAMMEL', jahr: J, spender: `M:${MIA}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  zb2 = r.body.zbnr;
  assert.equal(zb2, `ZB-${J}-0002`);
  const [kopf] = await sql`select art, betrag::float8 as betrag, betrag_worte, tag, zeitraum_von::text as von, zeitraum_bis::text as bis, daten from tco.zuw_kopf where zbnr = ${zb2}`;
  assert.deepEqual([kopf.art, kopf.betrag, kopf.betrag_worte, kopf.tag, kopf.von, kopf.bis], ['SAMMEL', 75.5, 'fünfundsiebzig Euro und fünfzig Cent', null, `${J}-01-01`, `${J}-12-31`]);
  assert.deepEqual(kopf.daten.positionen, [
    { datum: tag(1, 5), art: 'Geldspende', verzicht: false, betrag: 50 },
    { datum: tag(3, 1), art: 'Geldspende', verzicht: true, betrag: 25.5 },
  ]);
  const pos = await sql`select internenr, konto, posnr, betrag::float8 as betrag, verzicht, aktiv from tco.zuw_pos where zbnr = ${zb2} order by lfd`;
  assert.deepEqual(pos.map((p) => [p.internenr, p.konto, p.posnr, p.betrag, p.verzicht, p.aktiv]), [[bLauf, '8171', 2, 50, false, true], [b25, '8171', 0, 25.5, true, true]]);
  const liste = (await leser('GET', `${Z}/bestaetigungen?jahr=${J}`)).body;
  assert.deepEqual(liste.map((x: { zbnr: string; anzahl: number; status_txt: string; versand_txt: string }) => [x.zbnr, x.anzahl, x.status_txt, x.versand_txt]),
    [[zb2, 2, 'Ausgestellt', 'Offen'], [zb1, 1, 'Ausgestellt', 'Offen']]);
});

test('Unveränderlich: Bestätigung und Positionen lassen sich weder ändern noch löschen', async () => {
  await assert.rejects(sql`update tco.zuw_kopf set betrag = 999 where zbnr = ${zb1}`, /können nicht geändert werden/);
  await assert.rejects(sql`update tco.zuw_kopf set spender_name = 'Jemand anders' where zbnr = ${zb1}`, /können nicht geändert werden/);
  await assert.rejects(sql`update tco.zuw_kopf set pdf = ${Buffer.from('x')} where zbnr = ${zb1}`, /können nicht geändert werden/);
  await assert.rejects(sql`delete from tco.zuw_kopf where zbnr = ${zb1}`, /können nicht gelöscht werden/);
  await assert.rejects(sql`update tco.zuw_pos set betrag = 1 where zbnr = ${zb1}`, /können nicht geändert werden/);
  await assert.rejects(sql`delete from tco.zuw_pos where zbnr = ${zb1}`, /können nicht gelöscht werden/);
  await assert.rejects(sql`update tco.zuw_kopf set status = 'S' where zbnr = ${zb1}`, /nur mit Grund/);
});

test('Versand: nur „gesendet“ zählt – unzustellbar, Fehler und fehlende Adresse heißen „nicht versendet – bitte drucken“', async () => {
  // E-Mail-Versand ist erst nach Freigabe in den Einstellungen möglich
  let r = await kasse('POST', `${Z}/bestaetigungen/${zb1}/senden`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.message, /nicht zugelassen – bitte drucken/);
  assert.equal((await admin('PUT', `${Z}/einstellungen`, einstellungen({ mail_erlaubt: true }))).status, 200);

  r = await kasse('POST', `${Z}/bestaetigungen/${zb1}/senden`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.versendet, r.body.an], [true, 'mia@tc-test.example']);
  const m = mails.at(-1)!;
  assert.deepEqual([m.an, m.objekt, m.anhaenge.length], ['mia@tc-test.example', zb1, 1]);
  assert.match(m.betreff, new RegExp(`Zuwendungsbestätigung ${J}`));
  assert.match(m.text, new RegExp(`Guten Tag Mia Matchball,[\\s\\S]*${zb1} \\(Einzelbestätigung\\) über 200,00 €`));
  assert.equal(Buffer.from(m.anhaenge[0].inhalt_base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  let [kopf] = await sql`select versand_status, versand_an from tco.zuw_kopf where zbnr = ${zb1}`;
  assert.deepEqual([kopf.versand_status, kopf.versand_an], ['GESENDET', 'mia@tc-test.example']);

  // Adresse im Mitgliederstamm als unzustellbar vermerkt: der zentrale Versand liefert einen Status ungleich „gesendet“
  await sql`update tco.mitglieder set email = 'unzustellbar@tc-test.example' where adrnr = ${MIA}`;
  const vorher = mails.length;
  r = await kasse('POST', `${Z}/bestaetigungen/${zb2}/senden`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.versendet, false);
  assert.match(r.body.text, /nicht versendet – bitte drucken\. Adresse ist als unzustellbar vermerkt/);
  [kopf] = await sql`select versand_status, versand_hinweis from tco.zuw_kopf where zbnr = ${zb2}`;
  assert.deepEqual([kopf.versand_status, kopf.versand_hinweis], ['NICHT_VERSENDET', 'Adresse ist als unzustellbar vermerkt – bitte drucken']);
  // Fehler des Versands (Ausnahme) und fehlende Adresse: ebenso
  await sql`update tco.mitglieder set email = 'kaputt@tc-test.example' where adrnr = ${MIA}`;
  r = await kasse('POST', `${Z}/bestaetigungen/${zb2}/senden`, {});
  assert.deepEqual([r.status, r.body.versendet], [200, false]);
  await sql`update tco.mitglieder set email = null where adrnr = ${MIA}`;
  r = await kasse('POST', `${Z}/bestaetigungen/${zb2}/senden`, {});
  assert.equal(r.body.versendet, false);
  assert.match(r.body.text, /Keine E-Mail-Adresse hinterlegt/);
  assert.equal(mails.length, vorher, 'nichts gesendet');
  const liste = (await leser('GET', `${Z}/bestaetigungen?jahr=${J}`)).body;
  assert.equal(liste.find((x: { zbnr: string }) => x.zbnr === zb2).versand_txt, 'Nicht versendet – bitte drucken');

  // Druck: mehrere Bestätigungen in einer Datei, danach als gedruckt vermerken – versendete bleiben „versendet“
  const druck = await leser('GET', `${Z}/bestaetigungen/druck?nummern=${zb1},${zb2}`);
  assert.equal(druck.status, 200);
  assert.equal((druck.raw.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, 3, 'Einzelbestätigung + Sammelbestätigung mit Anlage');
  r = await kasse('POST', `${Z}/bestaetigungen/gedruckt`, { nummern: [zb1, zb2] });
  assert.deepEqual([r.status, r.body.anzahl], [200, 1]);
  const st = await sql`select zbnr, versand_status from tco.zuw_kopf order by zbnr`;
  assert.deepEqual(st.map((x) => x.versand_status), ['GESENDET', 'GEDRUCKT']);
  await sql`update tco.mitglieder set email = 'mia@tc-test.example' where adrnr = ${MIA}`;
});

test('Storno und Neuausstellung: Grund ist Pflicht, das Doppel bleibt, die Spenden werden frei, neue Nummer', async () => {
  assert.equal((await kasse('POST', `${Z}/bestaetigungen/${zb2}/storno`, { grund: '' })).status, 400);
  assert.equal((await kasse('POST', `${Z}/bestaetigungen/ZB-${J}-0999/storno`, { grund: 'gibt es nicht' })).status, 404);
  const r = await kasse('POST', `${Z}/bestaetigungen/${zb2}/storno`, { grund: 'Anschrift falsch' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [kopf] = await sql`select status, storno_grund, storno_von, storno_am, paperless_id from tco.zuw_kopf where zbnr = ${zb2}`;
  assert.deepEqual([kopf.status, kopf.storno_grund, kopf.storno_von, !!kopf.storno_am], ['S', 'Anschrift falsch', 'Test kasse', true]);
  assert.deepEqual((await sql`select aktiv from tco.zuw_pos where zbnr = ${zb2}`).map((p) => p.aktiv), [false, false]);
  // Vermerk am Doppel in Paperless, das PDF bleibt abrufbar
  assert.deepEqual(mock.notizen.filter((n) => n.id === kopf.paperless_id && n.text.startsWith('STORNIERT')).map((n) => /^STORNIERT am .* durch Test kasse: Anschrift falsch$/.test(n.text)), [true]);
  assert.equal((await leser('GET', `${Z}/bestaetigungen/${zb2}/pdf`)).status, 200);
  // zweimal stornieren, Storno zurücknehmen, stornierte versenden oder drucken: nicht möglich
  assert.equal((await kasse('POST', `${Z}/bestaetigungen/${zb2}/storno`, { grund: 'noch einmal' })).status, 409);
  await assert.rejects(sql`update tco.zuw_kopf set status = 'A', storno_grund = null, storno_am = null, storno_von = null where zbnr = ${zb2}`, /Storno kann nicht zurückgenommen werden/);
  await assert.rejects(sql`update tco.zuw_pos set aktiv = true where zbnr = ${zb2}`, /können nicht geändert werden/);
  assert.equal((await kasse('POST', `${Z}/bestaetigungen/${zb2}/senden`, {})).status, 409);
  assert.equal((await leser('GET', `${Z}/bestaetigungen/druck?nummern=${zb2}`)).status, 404);

  // die Spenden stehen wieder in der Vorschlagsliste; Neuausstellung mit neuer Nummer (die alte wird nicht wiederverwendet)
  const v = await vorschlag();
  assert.deepEqual(spender(v, `M:${MIA}`)!.offen.map((q) => q.betrag), [50, 25.5]);
  const neu = await kasse('POST', `${Z}/bestaetigungen`, { art: 'SAMMEL', jahr: J, spender: `M:${MIA}` });
  assert.equal(neu.status, 200, JSON.stringify(neu.body));
  assert.equal(neu.body.zbnr, `ZB-${J}-0003`);
  const liste = (await leser('GET', `${Z}/bestaetigungen?jahr=${J}`)).body;
  assert.deepEqual(liste.map((x: { zbnr: string; status: string }) => [x.zbnr, x.status]), [[`ZB-${J}-0003`, 'A'], [zb2, 'S'], [zb1, 'A']]);
  assert.equal(liste[1].storno_grund, 'Anschrift falsch');
});

test('Bestätigte Buchung später in FI storniert: Hinweis in der Liste', async () => {
  await withChange(ctx, (tx) => fiStorno(tx, bMia200, 'Bank hat zurückgebucht', 'Test'));
  const liste = (await leser('GET', `${Z}/bestaetigungen?jahr=${J}`)).body;
  assert.match(liste.find((x: { zbnr: string }) => x.zbnr === zb1).hinweis, /in FI storniert – bitte die Bestätigung stornieren/);
  assert.equal(liste.find((x: { zbnr: string }) => x.zbnr === `ZB-${J}-0003`).hinweis, null);
});

test('Paperless nicht erreichbar: die Bestätigung bleibt bestehen und lässt sich später ablegen', async () => {
  mock.aus = true;
  const r = await kasse('POST', `${Z}/bestaetigungen`, { art: 'EINZEL', jahr: J, spender: firma, quellen: [k(bFirma)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paperless.abgelegt, false);
  assert.match(r.body.paperless.text, /fehlgeschlagen/);
  const [kopf] = await sql`select paperless_id, verzicht, spender_id, spender_name from tco.zuw_kopf where zbnr = ${r.body.zbnr}`;
  assert.deepEqual([kopf.paperless_id, kopf.verzicht, kopf.spender_name], [null, true, 'Holzbau Hobel GmbH, z. Hd. Hanna Hobel']);
  assert.equal((await kasse('POST', `${Z}/bestaetigungen/${r.body.zbnr}/paperless`, {})).status, 400);
  mock.aus = false;
  const p = await kasse('POST', `${Z}/bestaetigungen/${r.body.zbnr}/paperless`, {});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.ok((await sql`select paperless_id from tco.zuw_kopf where zbnr = ${r.body.zbnr}`)[0].paperless_id > 0);
});

test('Jahreslauf: je Spender eine Sammelbestätigung (eine Spende: Einzelbestätigung), Unvollständige übersprungen, eigene Nummern je Jahr', async () => {
  const d = (m: number, t: number) => `${VJ}-${String(m).padStart(2, '0')}-${String(t).padStart(2, '0')}`;
  const b: Record<string, string> = {};
  for (const [name, datum, betrag] of [['mia1', d(3, 1), 100], ['mia2', d(6, 1), 60], ['mia3', d(12, 31), 40], ['tom', d(5, 5), 80], ['otto', d(7, 7), 10], ['lea1', d(4, 4), 20], ['lea2', d(11, 11), 20]] as const) {
    b[name] = await buchen(datum, `Spende ${name}`, betrag, [{ gkonto: '8171', betrag }]);
  }
  for (const [name, adr] of [['mia1', MIA], ['mia2', MIA], ['mia3', MIA], ['tom', TOM], ['otto', OTTO], ['lea1', LEA], ['lea2', LEA]]) {
    assert.equal((await kasse('PUT', `${Z}/quelle`, { key: k(b[name]), spender: `M:${adr}` })).status, 200);
  }
  // Rückbuchung im Januar des Folgejahres betrifft Leas Spende vom November: Lea wird übersprungen
  await buchen(`${J}-01-05`, 'RETOURE Lea Lob', -20, [{ gkonto: '8171', betrag: -20 }]);
  const v = await vorschlag(VJ);
  assert.deepEqual(spender(v, `M:${OTTO}`)!.fehlt, ['Straße', 'PLZ/Ort']);
  assert.equal(spender(v, `M:${LEA}`)!.gesperrt.length, 1, 'nur die Spende innerhalb der Frist vor der Rückbuchung');

  // abgelaufener Bescheid sperrt den Lauf
  assert.equal((await admin('PUT', `${Z}/einstellungen`, einstellungen({ bescheid_art: 'FESTSTELLUNG', bescheid_datum: plusJahre(H, -4), mail_erlaubt: true }))).status, 200);
  let r = await kasse('POST', `${Z}/jahreslauf`, { jahr: VJ });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Ausstellung gesperrt:.*§ 60a AO.*älter als 3 Jahre/);
  assert.equal((await kasse('POST', `${Z}/bestaetigungen`, { art: 'EINZEL', jahr: VJ, spender: `M:${TOM}` })).status, 409);
  assert.equal((await admin('PUT', `${Z}/einstellungen`, einstellungen({ mail_erlaubt: true }))).status, 200);

  r = await kasse('POST', `${Z}/jahreslauf`, { jahr: VJ });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.ausgestellt, [
    { zbnr: `ZB-${VJ}-0001`, betrag: 200, name: 'Mia Matchball', art: 'SAMMEL' },
    { zbnr: `ZB-${VJ}-0002`, betrag: 80, name: 'Tom Tiebreak', art: 'EINZEL' },
  ]);
  assert.deepEqual(r.body.uebersprungen.map((u: { name: string }) => u.name), ['Lea Lob', 'Otto Ohneadresse']);
  assert.match(r.body.uebersprungen[0].grund, /Rückbuchung vom 05\.01\.\d{4} über 20,00 € .* ungeklärt/);
  assert.match(r.body.uebersprungen[1].grund, /Anschrift unvollständig \(Straße, PLZ\/Ort\)/);
  const [mia] = await sql`select zeitraum_von::text as von, zeitraum_bis::text as bis, (select count(*)::int from tco.zuw_pos p where p.zbnr = k.zbnr) as n from tco.zuw_kopf k where zbnr = ${`ZB-${VJ}-0001`}`;
  assert.deepEqual([mia.von, mia.bis, mia.n], [`${VJ}-01-01`, `${VJ}-12-31`, 3]);
  // zweiter Lauf: nichts mehr offen – nichts doppelt
  r = await kasse('POST', `${Z}/jahreslauf`, { jahr: VJ });
  assert.deepEqual([r.status, r.body.ausgestellt.length, r.body.uebersprungen.length], [200, 0, 2]);
  assert.equal((await sql`select count(*)::int as n from tco.zuw_kopf where jahr = ${VJ}`)[0].n, 2);
  // Versand nach dem Lauf: Tom ist als unzustellbar vermerkt → bitte drucken
  const s = await kasse('POST', `${Z}/bestaetigungen/ZB-${VJ}-0002/senden`, {});
  assert.deepEqual([s.status, s.body.versendet], [200, false]);
  // Änderungsbelege: Ausstellung und Storno stehen im Protokoll der Bestätigung
  const belege = await sql`select distinct object_type, action from core.change_header where object_type like 'ZUW%'`;
  for (const [typ, aktion] of [['ZUWENDUNG', 'ZUWENDUNG'], ['ZUWENDUNG', 'ZUWENDUNG_STORNO'], ['ZUWENDUNG', 'ZUWENDUNG_LAUF'], ['ZUW_QUELLE', 'ZUW_QUELLE'], ['ZUW_CFG', null], ['ZUW_SPENDER', null]]) {
    assert.ok(belege.some((x) => x.object_type === typ && (aktion == null || x.action === aktion)), `Änderungsbeleg ${typ} ${aktion ?? ''}`);
  }
});
