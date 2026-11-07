/**
 * Integrationstest Abrechnung Jugendtraining: Entgelte, Zeiten, Import (n8n/CSV), Ferien,
 * Zeitnachweis mit Paperless-Ablage, Bezahlt und Nachmeldung.
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
const J = '/api/m/tco/jt';

// ---------------------------------------------------------------- Paperless/n8n-Attrappe
const mock = { docs: new Map<number, { versions: number[]; notes: string[]; meta: Record<string, any> }>(), next: 100, auth: [] as string[] };
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const u = req.url ?? '';
    if (u.startsWith('/webhook/')) {
      mock.auth.push(String(req.headers.authorization ?? ''));
      if (u.startsWith('/webhook/ferien-saarland?jahr=2026')) {
        return send(200, {
          ferientage: [{ datum: '2026-10-12', ferien: 'Herbstferien' }, { datum: '2026-10-13', ferien: 'Herbstferien' }],
          feiertage: [{ datum: '2026-10-03', name: 'Tag der Deutschen Einheit' }, { datum: '2026-11-01', name: 'Allerheiligen' }],
        });
      }
      if (u.startsWith('/webhook/TCO_N8N_STUNDEN?format=csv')) {
        return send(200, { rueckmeldungen: [
          { submissionId: '1', eingereicht: '2026-10-06', TrainerIn: 'Yury Klimov', Datum: '2026-10-05', Stunden: '2' },
          { submissionId: '2', eingereicht: '2026-10-13', TrainerIn: 'YURY KLIMOV', Datum: '2026-10-12', Stunden: '1,5 Std.' },
          { submissionId: '3', eingereicht: '2026-10-13', TrainerIn: 'Jan Weißing', Datum: '2026-10-12', Stunden: '3' },
          { submissionId: '4', eingereicht: '2026-10-13', TrainerIn: 'Unbekannt Person', Datum: '2026-10-14', Stunden: '1' },
          { submissionId: '5', eingereicht: '2026-09-30', TrainerIn: 'Yury Klimov', Datum: '2026-09-29', Stunden: '2' },
          { submissionId: '6', eingereicht: '2026-10-20', TrainerIn: 'Yury Klimov', Datum: '2026-10-19', Stunden: 'viel' },
        ] });
      }
      return send(404, {});
    }
    if (req.headers.authorization !== 'Token geheim') return send(401, {});
    let m: RegExpExecArray | null;
    if (u === '/api/documents/post_document/') { const id = mock.next++; mock.docs.set(id, { versions: [], notes: [], meta: {} }); return send(200, `task-${id}`); }
    if ((m = /^\/api\/documents\/(\d+)\/update_version\/$/.exec(u))) {
      const d = mock.docs.get(Number(m[1]));
      if (!d) return send(404, {});
      const vid = mock.next++;
      d.versions.push(vid);
      return send(200, `task-${vid}`);
    }
    if ((m = /^\/api\/tasks\/\?task_id=task-(\d+)/.exec(u))) return send(200, [{ status: 'SUCCESS', related_document: m[1] }]);
    if (u.startsWith('/api/documents/?')) return send(200, { results: [], next: null });
    if (/^\/api\/(correspondents|document_types|storage_paths|custom_fields|tags)\//.test(u) && req.method === 'GET') {
      const art = u.split('/')[2];
      const lists: Record<string, unknown[]> = {
        correspondents: [], document_types: [{ id: 1, name: 'Abrechnung Jugendtraining' }], storage_paths: [{ id: 2, name: 'Buchhaltung' }],
        custom_fields: [{ id: 3, name: 'Betrag', data_type: 'monetary' }, { id: 4, name: 'DOKID', data_type: 'string' }], tags: [],
      };
      return send(200, { results: lists[art], next: null });
    }
    if (u === '/api/correspondents/' && req.method === 'POST') return send(201, { id: 7, name: JSON.parse(body).name });
    if ((m = /^\/api\/documents\/(\d+)\/notes\/$/.exec(u))) {
      const d = mock.docs.get(Number(m[1]))!;
      if (req.method === 'POST') { d.notes.push(JSON.parse(body).note); return send(200, []); }
      return send(200, []);
    }
    if ((m = /^\/api\/documents\/(\d+)\/share_links\/$/.exec(u))) return send(200, []);
    if (u === '/api/share_links/') return send(201, { slug: `slug${JSON.parse(body).document}` });
    if ((m = /^\/api\/documents\/(\d+)\/download\//.exec(u))) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 test'); }
    if ((m = /^\/api\/documents\/(\d+)\/$/.exec(u))) {
      const id = Number(m[1]);
      const d = mock.docs.get(id);
      if (!d) return send(404, {});
      if (req.method === 'PATCH') { d.meta = JSON.parse(body); return send(200, {}); }
      return send(200, { id, custom_fields: [], versions: [{ id }, ...d.versions.map((v) => ({ id: v, version_label: 'Neudruck' }))] });
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
  await sql`update tco.verein set paperless_url = ${`http://127.0.0.1:${port}`}, paperless_token = 'geheim',
                                  n8n_stunden_url = ${`http://127.0.0.1:${port}/webhook/TCO_N8N_STUNDEN`},
                                  n8n_ferien_url = ${`http://127.0.0.1:${port}/webhook/ferien-saarland`}, n8n_stunden_auth = 'Basic eDp5'`;
});
after(async () => {
  await app?.close();
  await sql.end();
  server.close();
});

test('Jugendtraining: Entgelte, Zeiten, Import, Nachweis, Bezahlt, Nachmeldung', async () => {
  const mg = 'ADRNR;VORNAME;NACHNAME;TELEFON6\n0000000533;Yury;Klimov;0171 1234567\n0000000281;Jan;Weißing;\n0000000063;Torsten;Laub;\n';
  let r = await call('POST', '/api/m/tco/import/ausfuehren', { modus: 'neu', dateien: [
    { name: 'ZTCO_MITGLIEDER.CSV', data: b64(mg) },
    { name: 'ZTCO_MITGLIEDERA.CSV', data: b64('ADRNR;TRAINER\n0000000533;X\n0000000281;X\n') },
    { name: 'ZTCO_TRENTGELT.CSV', data: b64('ADRNR;VALID_TO;BETRAG\n0000000533;20261015;30\n0000000533;99991231;32\n0000000281;99991231;20\n') },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // ---- Trainer: Steuernummer, neuer Trainer
  r = await call('PUT', `${J}/trainer`, { adrnr: '0000000533', aktiv: true, steuernummer: '060/239/09071' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${J}/entgelte`);
  assert.equal(r.body.trainer.length, 2);
  assert.equal(r.body.trainer.find((t: any) => t.adrnr === '0000000533').steuernummer, '060/239/09071');
  const yury = r.body.entgelte.filter((e: any) => e.adrnr === '0000000533');
  assert.deepEqual(yury.map((e: any) => [e.valid_from, e.valid_to, e.betrag]), [[null, '2026-10-15', 30], ['2026-10-16', '9999-12-31', 32]]);

  // ---- Neues Entgelt ab Stichtag grenzt den laufenden Satz ab
  r = await call('POST', `${J}/entgelte`, { adrnr: '0000000281', ab: '2027-01-01', betrag: 22 });
  assert.match(r.body.text, /abgegrenzt/);
  r = await call('GET', `${J}/entgelte`);
  assert.deepEqual(r.body.entgelte.filter((e: any) => e.adrnr === '0000000281').map((e: any) => [e.valid_to, e.betrag, e.status]),
    [['2026-12-31', 20, 'CUR'], ['9999-12-31', 22, 'FUT']]);

  // ---- Monat lädt Ferien automatisch über n8n
  r = await call('GET', `${J}/monat?monat=202610`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ferienFehler, null);
  assert.equal(r.body.ferien.filter((f: any) => f.ferien).length, 2);
  assert.equal(r.body.ferien.find((f: any) => f.datum === '2026-10-03').feiertag, 'Tag der Deutschen Einheit');
  assert.ok(mock.auth.includes('Basic eDp5'));

  // ---- Import aus Nextcloud über n8n
  r = await call('POST', `${J}/import/nextcloud`, { monat: '202610' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, 3);
  assert.equal(r.body.ungueltig, 1);
  assert.equal(r.body.prot.find((p: any) => p.trainer === 'Unbekannt Person').ergebnis, 'Kein Mitglied gefunden');
  assert.match(r.body.prot.find((p: any) => p.trainer === 'YURY KLIMOV').ergebnis, /Herbstferien/);
  assert.match(r.body.text, /1 Rückmeldung\(en\) anderer Monate/);
  // zweiter Lauf: alles schon da
  r = await call('POST', `${J}/import/nextcloud`, { monat: '202610' });
  assert.equal(r.body.ok, 0);

  // ---- CSV-Datei
  r = await call('POST', `${J}/import`, { monat: '202610', csv: `data:text/csv;base64,${b64('﻿a,b,c,TrainerIn,Datum,Stunden\r\n"1","","x","Klimov Yury","2026-10-19","2"\r\n')}` });
  assert.equal(r.body.ok, 1, JSON.stringify(r.body));

  // ---- manuelle Erfassung, Trainingsart ändern, generieren, löschen
  r = await call('POST', `${J}/zeiten`, { adrnr: '0000000533', datum: '2026-10-26', trainingsart: 'Schul-AG', anzahl: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${J}/zeiten`, { adrnr: '0000000533', datum: '2026-10-26', trainingsart: 'Jugendtraining', anzahl: 2, altArt: 'Schul-AG' });
  r = await call('POST', `${J}/zeiten/generieren`, { adrnr: '0000000281', monat: '202610', wochentage: [1], trainingsart: 'Jugendtraining' });
  assert.match(r.body.text, /^3 Trainingstag/); // Montage 5., 19., 26. Okt. (12. bereits importiert)
  r = await call('POST', `${J}/zeiten/loeschen`, { adrnr: '0000000281', datum: '2026-10-26', trainingsart: 'Jugendtraining' });
  r = await call('POST', `${J}/zeiten`, { adrnr: '0000000533', datum: '2026-10-26', trainingsart: 'Jugendtraining', anzahl: 30 });
  assert.equal(r.status, 400);

  r = await call('GET', `${J}/monat?monat=202610`);
  const zy = r.body.zeiten.filter((z: any) => z.adrnr === '0000000533');
  assert.deepEqual(zy.map((z: any) => [z.datum, z.trainingsart, z.anzahl, z.betrag]), [
    ['2026-10-05', 'Jugendtraining', 2, 60], ['2026-10-12', 'Jugendtraining', 1.5, 45],
    ['2026-10-19', 'Jugendtraining', 2, 64], ['2026-10-26', 'Jugendtraining', 2, 64],
  ]);
  let a = r.body.abrechnung.find((x: any) => x.adrnr === '0000000533');
  assert.equal(a.stunden, 7.5);
  assert.equal(a.betrag, 233);
  assert.equal(a.status, 'Nicht gedruckt');

  // ---- Zeitnachweis: Vorschau, Ablage, Bezahlt, Nachmeldung
  r = await call('GET', `${J}/nachweis/pdf?adrnr=0000000533&monat=202610`);
  assert.equal(r.ct, 'application/pdf');
  assert.ok(r.raw.subarray(0, 4).toString() === '%PDF');
  r = await call('POST', `${J}/nachweis/ablegen`, { adrnr: '0000000533', monat: '202610' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const docId = r.body.id;
  assert.match(r.body.text, /abgelegt \(DOKID 000/);
  assert.equal(mock.docs.get(docId)!.meta.title, '2026_10_TCO_YK');
  assert.equal(mock.docs.get(docId)!.meta.document_type, 1);
  assert.deepEqual(mock.docs.get(docId)!.meta.custom_fields.find((f: any) => f.field === 3), { field: 3, value: 'EUR233.00' });
  r = await call('GET', `${J}/monat?monat=202610`);
  a = r.body.abrechnung.find((x: any) => x.adrnr === '0000000533');
  assert.match(a.status, /^2026_10 abgelegt · DOKID/);
  assert.ok(a.bezahlbar);

  r = await call('POST', `${J}/nachweis/whatsapp`, { adrnr: '0000000533', monat: '202610' });
  assert.match(r.body.url, /^https:\/\/wa\.me\/491711234567\?text=.*slug/);

  r = await call('POST', `${J}/nachweis/bezahlt`, { adrnr: '0000000533', monat: '202610', datum: '2026-11-05' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mock.docs.get(docId)!.versions.length, 1);
  r = await call('GET', `${J}/monat?monat=202610`);
  a = r.body.abrechnung.find((x: any) => x.adrnr === '0000000533');
  assert.match(a.status, /bezahlt am 05\.11\.2026/);
  assert.equal(a.bezahlbar, false);
  r = await call('POST', `${J}/nachweis/bezahlt`, { adrnr: '0000000533', monat: '202610', datum: '2026-11-06' });
  assert.equal(r.status, 400);

  // Nachmeldung → wieder offen
  await call('POST', `${J}/zeiten`, { adrnr: '0000000533', datum: '2026-10-28', trainingsart: 'Betreuung Spieltage', anzahl: 1 });
  r = await call('GET', `${J}/monat?monat=202610`);
  a = r.body.abrechnung.find((x: any) => x.adrnr === '0000000533');
  assert.match(a.status, /Nachmeldung \+1 Std\./);
  r = await call('POST', `${J}/nachweis/ablegen`, { adrnr: '0000000533', monat: '202610' });
  assert.match(r.body.text, /Nachmeldung/);
  r = await call('GET', `${J}/monat?monat=202610`);
  a = r.body.abrechnung.find((x: any) => x.adrnr === '0000000533');
  assert.match(a.status, /wiedereröffnet, offen 32,00 €/);
  assert.ok(a.bezahlbar);
  r = await call('POST', `${J}/nachweis/bezahlt`, { adrnr: '0000000533', monat: '202610', datum: '2026-11-20' });
  assert.equal(r.status, 200);
  assert.match(mock.docs.get(docId)!.notes.at(-1)!, /Restzahlung/);
  const [d] = await sql`select bezahlt_betrag::float8 as b, to_char(bezahlt_am, 'YYYY-MM-DD') as am from tco.jt_doku where adrnr = '0000000533'`;
  assert.deepEqual(d, { b: 265, am: '2026-11-20' });

  r = await call('GET', `${J}/nachweis/dokument?adrnr=0000000533&monat=202610`);
  assert.equal(r.ct, 'application/pdf');

  // Änderungsbelege
  const [ch] = await sql`select count(*)::int as n from core.change_header where object_type = 'JT_ZEIT'`;
  assert.ok(ch.n > 0);
});
