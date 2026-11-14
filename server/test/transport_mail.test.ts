/**
 * Euroflex: E-Mail zum Auftrag über Outlook 365 (#235) – Anbindung „transport.mail“, Route POST /auftraege/:nr/mail,
 * E-Mail-Protokoll. n8n (Workflow „Euroflex Mailversand“) und Paperless sind nachgestellt.
 *   TEST_DATABASE_URL=postgres://portal:portal@localhost:5432/portal_test npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'transport';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { einstellungenLesen, postfachFuer, postfaecherLesen } = await import('../../modules/transport/server/mailversand.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.rawPayload };
}
const T = '/api/m/transport';
const NR = '2026_9235';
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

// ---------------------------------------------------------------- nachgestellt: n8n-Webhook und Paperless
type Aufruf = { modus: string; absender: string; objekt: string; anhaenge: { id: string; dateiname: string; mime: string; inhalt_base64: string }[];
  mails: { nr: number; rolle: string; an: string[]; cc: string[]; betreff: string; text: string; anhaenge: string[] }[] };
const mock = {
  aufrufe: [] as Aufruf[],
  /** Antwort des Workflows; ohne Angabe: alles gesendet bzw. als Entwurf abgelegt */
  antwort: null as null | ((b: Aufruf) => { code: number; json: unknown }),
};
const standard = (b: Aufruf) => ({ code: 200, json: {
  status: b.modus === 'senden' ? 'gesendet' : 'entwurf', postfach: b.absender,
  mails: (b.mails ?? []).map((m) => ({ nr: m.nr, rolle: m.rolle, an: m.an.join(', '), status: b.modus === 'senden' ? 'gesendet' : 'entwurf', message_id: `<M${m.nr}-${mock.aufrufe.length}@Example.org>` })),
} });
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = req.url ?? '';
    if (u === '/webhook/euroflex-mailversand') {
      if (req.headers['x-euroflex-key'] !== 'k') return send(403, { message: 'Authorization data is wrong!' });
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Aufruf;
      mock.aufrufe.push(b);
      if (b.modus === 'pruefen') return send(200, { status: 'ok', postfach: b.absender || null });
      const a = (mock.antwort ?? standard)(b);
      return send(a.code, a.json);
    }
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    if (u.startsWith('/api/documents/77/download/')) {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="2026-11-14 CMR.pdf"' });
      return res.end(Buffer.from('%PDF-1.4 CMR'));
    }
    return send(200, {});
  });
});

before(async () => {
  await sql.unsafe(`drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'Euroflex', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  await sql`insert into transport.auftraege (auftragsnr) values (${NR})`;
  // 77: unterschriebenes Foto, in Paperless als PDF archiviert; 78 gehört zu keinem Auftrag
  await sql`insert into transport.auftrag_dokumente (auftragsnr, doc_id, titel, datei) values (${NR}, 77, 'Auftrag 2026_9235 – CMR', 'CMR.jpg')`;
});
after(async () => {
  await app.close();
  await new Promise((ok) => server.close(ok));
  await sql.end();
});

const mail = (extra: Record<string, unknown> = {}) => ({
  an: 'kunde@example.org', cc: 'einkauf@example.org', betreff: `Lieferschein ${NR}`, text: 'Guten Tag,\nanbei der Lieferschein.',
  dateien: [{ name: `Lieferschein_${NR}.pdf`, inhalt: `data:application/pdf;base64,${b64('%PDF-1.4 Lieferschein')}` }], dokumente: [77], ...extra,
});
const protokoll = () => sql`select an, betreff, absender, von, status, fehler, message_id, nachricht, benutzer from core.mail_protokoll
                             where anwendung = 'Euroflex' and objekt = ${NR} order by id`;

test('Postfach je Benutzer: Zuordnung in der Anbindung, sonst E-Mail-Adresse des Benutzers', () => {
  assert.deepEqual([...postfaecherLesen(' Admin = dispo@example.org ; lager=lager@example.org\n')], [['admin', 'dispo@example.org'], ['lager', 'lager@example.org']]);
  assert.throws(() => postfaecherLesen('admin'), /benutzername=adresse/);
  assert.throws(() => postfaecherLesen('admin=keine adresse'), /ungültig/);
  assert.throws(() => postfaecherLesen('a=a@example.org, A=b@example.org'), /doppelt/);
  const e = einstellungenLesen({ einstellungen: { kopie_an: ' ablage@example.org ', postfaecher: 'admin=dispo@example.org', max_mb: '' } });
  assert.equal(e.kopie_an, 'ablage@example.org');
  assert.equal(e.max_mb, 10);
  assert.equal(postfachFuer(e, { username: 'Admin', email: 'privat@example.org' }), 'dispo@example.org');
  assert.equal(postfachFuer(e, { username: 'lager', email: 'lager@example.org' }), 'lager@example.org');
  assert.equal(postfachFuer(e, { username: 'lager', email: null }), null);
  assert.equal(postfachFuer(e, null), null);
  assert.equal(einstellungenLesen({ einstellungen: { max_mb: 99 } }).max_mb, 25);
});

test('Ohne Anbindung: Dialog zeigt nur den bisherigen Entwurf, Senden wird abgelehnt', async () => {
  let r = await call('GET', `${T}/mail/info`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { eingerichtet: false, postfach: null, kopieAn: '', maxMb: 10 });
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail());
  assert.equal(r.status, 400);
  assert.match(r.body.message, /E-Mail-Versand über Outlook 365 ist nicht eingerichtet/);
});

test('Anbindung pflegen: feste zweite Adresse, Postfach je Benutzer, Größe; Verbindungstest', async () => {
  const port = (server.address() as AddressInfo).port;
  const basis = { url: `http://127.0.0.1:${port}/webhook/euroflex-mailversand`, auth_art: 'header', header_name: 'X-Euroflex-Key', geheimnis: 'k' };
  let r = await call('PUT', '/api/verbindungen/transport.mail', { ...basis, einstellungen: { kopie_an: 'a@example.org, b@example.org' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Feste zweite Adresse/);
  r = await call('PUT', '/api/verbindungen/transport.mail', { ...basis, einstellungen: { postfaecher: 'admin' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /benutzername=adresse/);
  r = await call('PUT', '/api/verbindungen/transport.mail', { ...basis, einstellungen: { max_mb: '40' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /1 bis 25/);

  // ohne Zuordnung und ohne E-Mail-Adresse am Benutzer: kein Postfach
  r = await call('PUT', '/api/verbindungen/transport.mail', { ...basis, einstellungen: { kopie_an: 'ablage@example.org' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${T}/mail/info`);
  assert.deepEqual(r.body, { eingerichtet: true, postfach: null, kopieAn: 'ablage@example.org', maxMb: 10 });
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail());
  assert.equal(r.status, 400);
  assert.match(r.body.message, /kein Postfach hinterlegt/);
  r = await call('POST', '/api/verbindungen/transport.mail/pruefen', {});
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.match(r.body.text, /kein Postfach hinterlegt/);

  r = await call('PUT', '/api/verbindungen/transport.mail', { ...basis, einstellungen: { kopie_an: ' ablage@example.org ', postfaecher: 'Admin = dispo@example.org', max_mb: '1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.einstellungen, { kopie_an: 'ablage@example.org', postfaecher: 'admin=dispo@example.org', max_mb: 1 });
  assert.equal(r.body.geheimnis, '********');
  r = await call('GET', `${T}/mail/info`);
  assert.deepEqual(r.body, { eingerichtet: true, postfach: 'dispo@example.org', kopieAn: 'ablage@example.org', maxMb: 1 });

  // Paperless (zentrale Anbindung) für die Dokumente des Auftrags
  // Paperless je Bereich (#232, S5): Euroflex hat seine eigene Anbindung
  assert.equal((await call('PUT', '/api/verbindungen/paperless', { url: `http://127.0.0.1:${port}`, geheimnis: 'geheim' })).status, 404, 'den gemeinsamen Zugang gibt es ohne Verein nicht');
  r = await call('PUT', '/api/verbindungen/transport.paperless', { url: `http://127.0.0.1:${port}`, geheimnis: 'geheim' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  mock.aufrufe.length = 0;
  r = await call('POST', '/api/verbindungen/transport.mail/pruefen', {});
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.match(r.body.text, /Webhook-Schlüssel akzeptiert, Postfach dispo@example\.org erreichbar/);
  assert.equal(mock.aufrufe[0].modus, 'pruefen');
  assert.equal(mock.aufrufe[0].absender, 'dispo@example.org');
  // falscher Schlüssel im Formular (ohne zu speichern)
  r = await call('POST', '/api/verbindungen/transport.mail/pruefen', { geheimnis: 'falsch' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.text, /X-Euroflex-Key/);

  // Anbindung steht in der Liste (Administration → Schnittstellen → Anbindungen) mit ihren Zusatzfeldern
  r = await call('GET', '/api/verbindungen');
  const def = r.body.gruppen.flatMap((g: { verbindungen: { id: string; zusatz?: { key: string }[] }[] }) => g.verbindungen).find((v: { id: string }) => v.id === 'transport.mail');
  assert.deepEqual(def.zusatz.map((z: { key: string }) => z.key), ['kopie_an', 'postfaecher', 'max_mb']);
});

test('Senden: E-Mail an den Kunden und parallel eigene E-Mail an die feste Adresse, Anhänge aus Ordner und Paperless', async () => {
  mock.aufrufe.length = 0;
  mock.antwort = null;
  const r = await call('POST', `${T}/auftraege/${NR}/mail`, mail());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'gesendet');
  assert.equal(r.body.postfach, 'dispo@example.org');
  assert.match(r.body.text, /^2 E-Mails mit 2 Anhängen aus dem Postfach dispo@example\.org gesendet \(kunde@example\.org · ablage@example\.org\)\.$/);
  assert.deepEqual(r.body.mails, [{ rolle: 'kunde', an: 'kunde@example.org', status: 'gesendet' }, { rolle: 'kopie', an: 'ablage@example.org', status: 'gesendet' }]);

  assert.equal(mock.aufrufe.length, 1, 'ein Aufruf für beide E-Mails');
  const b = mock.aufrufe[0];
  assert.equal(b.modus, 'senden');
  assert.equal(b.absender, 'dispo@example.org');
  assert.equal(b.objekt, NR);
  // jede Datei einmal; das Paperless-Dokument kommt als archiviertes PDF mit dem Namen von Paperless (abgelegt war ein .jpg)
  assert.deepEqual(b.anhaenge.map((a) => [a.id, a.dateiname, a.mime, Buffer.from(a.inhalt_base64, 'base64').toString()]), [
    ['a1', `Lieferschein_${NR}.pdf`, 'application/pdf', '%PDF-1.4 Lieferschein'],
    ['a2', '2026-11-14 CMR.pdf', 'application/pdf', '%PDF-1.4 CMR'],
  ]);
  assert.deepEqual(b.mails.map((m) => [m.nr, m.rolle, m.an, m.cc, m.betreff, m.anhaenge]), [
    [1, 'kunde', ['kunde@example.org'], ['einkauf@example.org'], `Lieferschein ${NR}`, ['a1', 'a2']],
    [2, 'kopie', ['ablage@example.org'], [], `Lieferschein ${NR}`, ['a1', 'a2']],
  ]);
  assert.equal(b.mails[1].text, b.mails[0].text);

  // E-Mail-Protokoll: je E-Mail eine Zeile, Inhalt wird nicht gespeichert
  const p = await protokoll();
  assert.deepEqual(p.map((x) => [x.an, x.absender, x.von, x.status, x.message_id, x.nachricht, x.benutzer]), [
    ['kunde@example.org, einkauf@example.org', 'dispo@example.org', 'dispo@example.org', 'gesendet', 'm1-1@example.org', null, 'Admin'],
    ['ablage@example.org', 'dispo@example.org', 'dispo@example.org', 'gesendet', 'm2-1@example.org', null, 'Admin'],
  ]);
});

test('Entwurf in Outlook; ohne Anhänge; mehrere Empfänger', async () => {
  mock.aufrufe.length = 0;
  const r = await call('POST', `${T}/auftraege/${NR}/mail`, mail({ modus: 'entwurf', an: 'kunde@example.org; zweiter@example.org', cc: '', dateien: [], dokumente: [] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'entwurf');
  assert.match(r.body.text, /2 E-Mails mit 0 Anhängen als Entwurf im Postfach dispo@example\.org abgelegt/);
  assert.equal(mock.aufrufe[0].modus, 'entwurf');
  assert.deepEqual(mock.aufrufe[0].mails[0].an, ['kunde@example.org', 'zweiter@example.org']);
  assert.deepEqual(mock.aufrufe[0].anhaenge, []);
  assert.deepEqual((await protokoll()).slice(-2).map((x) => x.status), ['entwurf', 'entwurf']);
});

test('Abgelehnt vor dem Aufruf: fremdes Dokument, Dateityp, Größe, Adresse, unbekannter Auftrag', async () => {
  mock.aufrufe.length = 0;
  const vorher = (await protokoll()).length;
  let r = await call('POST', `${T}/auftraege/${NR}/mail`, mail({ dokumente: [77, 78] }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Dokument 78 ist dem Auftrag 2026_9235 nicht zugeordnet/);
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail({ dateien: [{ name: 'programm.exe', inhalt: b64('MZ') }] }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Dateityp wird als Anhang nicht unterstützt/);
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail({ dateien: [{ name: 'foto.jpg', inhalt: b64(Buffer.alloc(1024 * 1024 + 10, 1)) }] }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /erlaubt sind 1 MB je Vorgang/);
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail({ an: 'kunde(at)example.org' }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Empfänger: „kunde\(at\)example\.org“ ist keine gültige E-Mail-Adresse/);
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail({ betreff: ' ' }));
  assert.equal(r.status, 400);
  r = await call('POST', `${T}/auftraege/2026_0000/mail`, mail());
  assert.equal(r.status, 404);
  assert.equal(mock.aufrufe.length, 0, 'n8n wurde nicht aufgerufen');
  assert.equal((await protokoll()).length, vorher, 'nichts protokolliert');
});

test('Teilerfolg: nur die fehlgeschlagene E-Mail wird erneut gesendet', async () => {
  mock.aufrufe.length = 0;
  mock.antwort = (b) => ({ code: 200, json: { status: 'teilweise', postfach: b.absender, mails: [
    { nr: 1, rolle: 'kunde', status: 'gesendet', message_id: '<kunde@example.org>' },
    { nr: 2, rolle: 'kopie', status: 'fehler', fehler: 'Entwurf anlegen fehlgeschlagen (HTTP 503): ServiceUnavailable' },
  ] } });
  let r = await call('POST', `${T}/auftraege/${NR}/mail`, mail());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'teilweise');
  assert.match(r.body.text, /Nur teilweise gesendet: E-Mail an den Empfänger \(kunde@example\.org\) ist erledigt\. Fehlgeschlagen: E-Mail an die feste zweite Adresse \(ablage@example\.org\): Entwurf anlegen fehlgeschlagen/);
  assert.deepEqual(r.body.mails.map((m: { rolle: string; status: string }) => [m.rolle, m.status]), [['kunde', 'gesendet'], ['kopie', 'fehler']]);
  let p = (await protokoll()).slice(-2);
  assert.deepEqual(p.map((x) => [x.an, x.status]), [['kunde@example.org, einkauf@example.org', 'gesendet'], ['ablage@example.org', 'fehler']]);
  assert.match(p[1].fehler, /HTTP 503/);

  mock.antwort = null;
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail({ nur: ['kopie'] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'gesendet');
  assert.match(r.body.text, /^1 E-Mail mit 2 Anhängen/);
  assert.deepEqual(mock.aufrufe[1].mails.map((m) => [m.nr, m.rolle, m.an]), [[2, 'kopie', ['ablage@example.org']]]);
  p = (await protokoll()).slice(-1);
  assert.deepEqual(p.map((x) => [x.an, x.status]), [['ablage@example.org', 'gesendet']]);
});

test('Fehler des Workflows: ungültiger Aufruf, Schlüssel abgelehnt, keine Antwort im erwarteten Format', async () => {
  mock.aufrufe.length = 0;
  mock.antwort = () => ({ code: 400, json: { status: 'fehler', fehler: 'E-Mail 1: kein Empfänger.' } });
  let r = await call('POST', `${T}/auftraege/${NR}/mail`, mail());
  assert.equal(r.status, 502);
  assert.match(r.body.message, /n8n hat den Aufruf abgelehnt: E-Mail 1: kein Empfänger\./);
  let p = (await protokoll()).slice(-2);
  assert.deepEqual(p.map((x) => x.status), ['fehler', 'fehler']);
  assert.match(p[0].fehler, /n8n hat den Aufruf abgelehnt/);

  mock.antwort = () => ({ code: 200, json: { message: 'Workflow was started' } });
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail());
  assert.equal(r.status, 502);
  assert.match(r.body.message, /Unerwartete Antwort von n8n/);

  // Schlüssel im Portal passt nicht mehr zu n8n
  const port = (server.address() as AddressInfo).port;
  r = await call('PUT', '/api/verbindungen/transport.mail', { url: `http://127.0.0.1:${port}/webhook/euroflex-mailversand`, auth_art: 'header', header_name: 'X-Euroflex-Key', geheimnis: 'alt' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const aufrufe = mock.aufrufe.length;
  r = await call('POST', `${T}/auftraege/${NR}/mail`, mail());
  assert.equal(r.status, 502);
  assert.match(r.body.message, /n8n hat den Webhook-Schlüssel abgelehnt.*X-Euroflex-Key/);
  assert.equal(mock.aufrufe.length, aufrufe);
  p = (await protokoll()).slice(-2);
  assert.deepEqual(p.map((x) => x.status), ['fehler', 'fehler']);
});

test('E-Mail-Protokoll nennt den Kontakt zur Empfängeradresse', async () => {
  await sql`insert into transport.adressen (adrnr, kundenname, email) values (9235, 'Holz Müller GmbH', 'Kunde@example.org')`;
  const mod = activeModules().find((m) => m.id === 'transport');
  const personen = await mod!.mailPersonen!(sql as never, ['kunde@example.org', 'niemand@example.org']);
  assert.deepEqual(personen, [{ email: 'kunde@example.org', name: 'Holz Müller GmbH', art: 'Kontakt Euroflex' }]);
});
