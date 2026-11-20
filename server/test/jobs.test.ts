/**
 * Integrationstest Jobs (Administration → System → Jobs): Verzeichnis, Plan ändern (ein-/ausplanen, Standard, Beleg),
 * „Jetzt ausführen“ mit Protokoll, Fehlerlauf mit Störung im Arbeitsvorrat (und Schließen beim nächsten Erfolg),
 * leere Planläufe werden nicht aufbewahrt, ein Lauf je Job, Abbruch, verwaiste Läufe, Planer (atomar beansprucht),
 * Kern-Jobs (Aufräumen, Nextcloud-Export ohne Einrichtung) und Rechte.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { jobAusfuehren, jobVerzeichnis, planerDurchlauf, testJobRegistrieren } = await import('../src/jobs.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };
}
const admin = client();
const leser = client();
const ausfuehrer = client();
const J = '/api/admin/jobs';

// ---------------------------------------------------------------- Testjobs
let fehlerKaputt = true;
let okMitWarnung = false;
const warten = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  testJobRegistrieren({
    id: 'test.ok', text: 'Test: klappt', beschreibung: 'schreibt zwei Zeilen', bereich: 'Test', standardPlan: { art: 'intervall', minuten: 60 },
    async ausfuehren(ctx) {
      ctx.log('eins');
      if (okMitWarnung) ctx.log('Achtung', 'warnung');
      ctx.log(`zwei (${ctx.manuell ? 'von Hand' : 'nach Plan'}, ${ctx.von.name})`);
      return 'fertig';
    },
  });
  testJobRegistrieren({
    id: 'test.fehler', text: 'Test: scheitert', beschreibung: 'wirft', bereich: 'Test', standardPlan: { art: 'taeglich', uhrzeit: '04:00', wochentage: [] },
    async ausfuehren(ctx) {
      ctx.log('vor dem Fehler');
      if (fehlerKaputt) throw new Error('kaputt');
      return 'wieder gut';
    },
  });
  testJobRegistrieren({
    id: 'test.leer', text: 'Test: nichts zu tun', beschreibung: 'nach Plan leer', bereich: 'Test', standardPlan: { art: 'intervall', minuten: 1 },
    async ausfuehren(ctx) {
      ctx.log('geprüft');
      if (!ctx.manuell) return ctx.leer();
      return 'von Hand';
    },
  });
  testJobRegistrieren({
    id: 'test.lang', text: 'Test: lang', beschreibung: 'wartet auf Abbruch', bereich: 'Test', standardPlan: { art: 'intervall', minuten: 5 }, standardEingeplant: false,
    async ausfuehren(ctx) {
      ctx.log('wartet');
      for (let i = 0; i < 100 && !ctx.signal.aborted; i++) await warten(50);
      if (ctx.signal.aborted) throw new Error('abgebrochen');
      return 'ohne Abbruch';
    },
  });
  testJobRegistrieren({
    id: 'test.recht', text: 'Test: eigenes Recht', beschreibung: 'braucht Rücksicherung', bereich: 'Test', standardPlan: { art: 'intervall', minuten: 60 },
    recht: 'core.backup:restore', async ausfuehren() { return 'ok'; },
  });
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await admin('POST', '/api/admin/roles', { id: 'JOB_LESER', name: 'Jobs ansehen', permissions: ['core.jobs:display'] });
  await admin('POST', '/api/admin/roles', { id: 'JOB_AUSFUEHRER', name: 'Jobs ausführen', permissions: ['core.jobs:display', 'core.jobs:execute'] });
  for (const [u, rolle] of [['leser', 'JOB_LESER'], ['ausfuehrer', 'JOB_AUSFUEHRER']] as const) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles: [rolle] })).status, 200);
    await sql`update core.users set must_change_password = false where username = ${u}`;
  }
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await ausfuehrer('POST', '/api/auth/login', { username: 'ausfuehrer', password: 'start-passwort' })).status, 200);
});
after(async () => { await app?.close(); await sql.end(); });

/** auf das Ende eines Laufs warten (der Lauf läuft im Hintergrund) */
async function fertig(laufId: number) {
  for (let i = 0; i < 200; i++) {
    const r = await admin('GET', `${J}/laeufe/${laufId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.lauf.status !== 'LAEUFT') return r.body as { lauf: any; protokoll: { nr: number; zeit: string; stufe: string; text: string }[] };
    await warten(50);
  }
  throw new Error(`Lauf ${laufId} wird nicht fertig`);
}
const job = async (id: string) => ((await admin('GET', J)).body as any[]).find((j) => j.id === id);

test('Verzeichnis: Kern-, Modul- und Testjobs mit Zeile, Plan und nächstem Start', async () => {
  const ids = [...jobVerzeichnis().keys()];
  assert.ok(ids.includes('core.backup.nextcloud') && ids.includes('core.jobs.aufraeumen'));
  assert.ok(ids.every((id) => /^[a-z]+\./.test(id)));
  const r = await admin('GET', J);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((j: any) => j.id).sort(), [...ids].sort());
  const zeilen = await sql`select id from core.jobs`;
  assert.equal(zeilen.length, ids.length, 'je Job eine Zeile');
  const nc = r.body.find((j: any) => j.id === 'core.backup.nextcloud');
  assert.equal(nc.modul, 'core');
  assert.equal(nc.planText, 'jede Minute');
  assert.equal(nc.eingeplant, true);
  assert.ok(nc.naechsterLauf);
  const auf = r.body.find((j: any) => j.id === 'core.jobs.aufraeumen');
  assert.equal(auf.planText, 'täglich 03:20');
  const lang = r.body.find((j: any) => j.id === 'test.lang');
  assert.deepEqual([lang.eingeplant, lang.naechsterLauf, lang.standardEingeplant], [false, null, false]);
  assert.equal(r.body.find((j: any) => j.id === 'test.ok').darfAusfuehren, true);
});

test('Plan ändern: ausplanen, einplanen mit Wochentagen, Änderungsbeleg, Standard, Prüfung', async () => {
  let r = await admin('PUT', `${J}/test.ok/plan`, { eingeplant: false, plan: { art: 'intervall', minuten: 60 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.eingeplant, r.body.naechsterLauf, r.body.geaendertVon], [false, null, 'admin']);
  r = await admin('PUT', `${J}/test.ok/plan`, { eingeplant: true, plan: { art: 'taeglich', uhrzeit: '03:00', wochentage: [5, 1, 2, 3, 4] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.planText, 'täglich 03:00 (Mo–Fr)');
  assert.deepEqual(r.body.plan.wochentage, [1, 2, 3, 4, 5]);
  assert.ok(new Date(r.body.naechsterLauf).getTime() > Date.now());
  const belege = await sql`select h.action, h.reason, i.field from core.change_header h join core.change_item i on i.header_id = h.id
                            where h.object_type = 'JOB' and h.object_key = 'test.ok' and h.change_ind = 'U' order by h.id`;
  assert.deepEqual([...new Set(belege.map((b) => b.action))], ['JOB_AUSPLANEN', 'JOB_EINPLANEN']);
  assert.ok(belege.every((b) => b.reason === 'Test: klappt'));
  assert.ok(belege.some((b) => b.field === 'plan') && belege.some((b) => b.field === 'eingeplant'));
  assert.ok(!belege.some((b) => b.field === 'naechster_lauf'), 'der nächste Start ist kein Beleg');
  // ungültige Pläne
  for (const plan of [{ art: 'intervall', minuten: 0 }, { art: 'intervall', minuten: 10081 }, { art: 'taeglich', uhrzeit: '25:00', wochentage: [] }, { art: 'taeglich', uhrzeit: '03:00', wochentage: [8] }]) {
    assert.equal((await admin('PUT', `${J}/test.ok/plan`, { eingeplant: true, plan })).status, 400, JSON.stringify(plan));
  }
  assert.equal((await admin('PUT', `${J}/gibt.es.nicht/plan`, { eingeplant: true, plan: { art: 'intervall', minuten: 5 } })).status, 404);
  // Standard
  r = await admin('POST', `${J}/test.ok/standard`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.eingeplant, r.body.plan, r.body.planText], [true, { art: 'intervall', minuten: 60 }, 'alle 60 Minuten']);
});

test('Jetzt ausführen: Lauf im Hintergrund, Protokoll, Status OK und WARNUNG, Läufe filtern', async () => {
  let r = await admin('POST', `${J}/test.ok/ausfuehren`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { lauf, protokoll } = await fertig(r.body.laufId);
  assert.deepEqual([lauf.jobId, lauf.jobText, lauf.ausloeser, lauf.gestartetVon, lauf.status, lauf.ergebnis, lauf.warnungen, lauf.fehler],
    ['test.ok', 'Test: klappt', 'MANUELL', 'admin', 'OK', 'fertig', 0, 0]);
  assert.ok(lauf.beendetAm && lauf.dauerSekunden !== null);
  assert.deepEqual(protokoll.map((p) => p.text), ['Von Hand gestartet (admin).', 'eins', 'zwei (von Hand, admin)']);
  assert.deepEqual(protokoll.map((p) => p.nr), [1, 2, 3]);
  assert.ok(protokoll.every((p) => p.stufe === 'info' && !Number.isNaN(Date.parse(p.zeit))));

  okMitWarnung = true;
  const w = await jobAusfuehren('test.ok');
  okMitWarnung = false;
  assert.equal(w.status, 'WARNUNG');
  r = await admin('GET', `${J}/laeufe/${w.laufId}`);
  assert.deepEqual([r.body.lauf.warnungen, r.body.protokoll.find((p: any) => p.stufe === 'warnung')?.text], [1, 'Achtung']);

  // Liste und Filter
  r = await admin('GET', `${J}/laeufe?job=test.ok`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((l: any) => l.status), ['WARNUNG', 'OK'], 'neueste zuerst');
  r = await admin('GET', `${J}/laeufe?job=test.ok&status=OK&limit=1`);
  assert.deepEqual(r.body.map((l: any) => l.id), [lauf.id]);
  const heute = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  assert.equal((await admin('GET', `${J}/laeufe?job=test.ok&von=${heute}&bis=${heute}`)).body.length, 2);
  assert.equal((await admin('GET', `${J}/laeufe?job=test.ok&bis=2020-01-01`)).body.length, 0);
  assert.equal((await admin('GET', `${J}/laeufe?von=gestern`)).status, 400);
  assert.equal((await admin('GET', `${J}/laeufe/999999`)).status, 404);
  // in der Übersicht: letzter Lauf
  const j = await job('test.ok');
  assert.deepEqual([j.letzterLauf.id, j.letzterLauf.status, j.laeuft], [w.laufId, 'WARNUNG', null]);
});

test('Fehlerlauf nach Plan: Status FEHLER, Meldung im Protokoll, Störung im Arbeitsvorrat bis zum nächsten Erfolg', async () => {
  const f = await jobAusfuehren('test.fehler', { manuell: false });
  assert.equal(f.status, 'FEHLER');
  const r = await admin('GET', `${J}/laeufe/${f.laufId}`);
  assert.deepEqual([r.body.lauf.status, r.body.lauf.ergebnis, r.body.lauf.ausloeser, r.body.lauf.gestartetVon, r.body.lauf.fehler],
    ['FEHLER', 'kaputt', 'PLAN', 'system (Jobplanung)', 1]);
  assert.deepEqual(r.body.protokoll.map((p: any) => [p.stufe, p.text]), [['info', 'vor dem Fehler'], ['fehler', 'kaputt']]);
  let h = await sql`select recht, pfad, titel, text, state from core.hinweise where modul = 'core' and quelle = 'JOB' and objekt = 'test.fehler' and erledigt_am is null`;
  assert.equal(h.length, 1, 'Störung im Arbeitsvorrat');
  assert.deepEqual([h[0].recht, h[0].pfad, h[0].titel, h[0].text, h[0].state], ['core.jobs:display', '/admin/jobs?job=test.fehler', 'Test: scheitert', 'kaputt', 'Negative']);
  // von Hand gescheitert: keine weitere Meldung (zählt nicht hoch)
  assert.equal((await jobAusfuehren('test.fehler')).status, 'FEHLER');
  assert.equal((await sql`select anzahl from core.hinweise where quelle = 'JOB' and objekt = 'test.fehler' and erledigt_am is null`)[0].anzahl, 1);
  // nächster Lauf klappt: Störung schließt sich
  fehlerKaputt = false;
  assert.equal((await jobAusfuehren('test.fehler', { manuell: false })).status, 'OK');
  h = await sql`select 1 from core.hinweise where quelle = 'JOB' and objekt = 'test.fehler' and erledigt_am is null`;
  assert.equal(h.length, 0, 'Störung geschlossen');
});

test('leer(): Planläufe ohne Arbeit werden nicht aufbewahrt, von Hand schon', async () => {
  const vorher = (await sql`select count(*)::int as n from core.job_laeufe where job_id = 'test.leer'`)[0].n;
  const l = await jobAusfuehren('test.leer', { manuell: false });
  assert.equal(l.status, 'LEER');
  assert.equal((await sql`select count(*)::int as n from core.job_laeufe where job_id = 'test.leer'`)[0].n, vorher);
  assert.equal((await sql`select count(*)::int as n from core.job_protokoll where lauf_id = ${l.laufId}`)[0].n, 0, 'auch kein Protokoll');
  const m = await jobAusfuehren('test.leer');
  assert.equal(m.status, 'OK');
  assert.equal((await admin('GET', `${J}/laeufe/${m.laufId}`)).body.lauf.ergebnis, 'von Hand');
});

test('ein Lauf je Job gleichzeitig, Abbruch, verwaiste Läufe', async () => {
  let r = await admin('POST', `${J}/test.lang/ausfuehren`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const laufId = r.body.laufId;
  assert.equal((await admin('POST', `${J}/test.lang/ausfuehren`)).status, 409, 'läuft schon');
  assert.equal((await job('test.lang')).laeuft, laufId);
  assert.equal((await leser('POST', `${J}/laeufe/${laufId}/abbrechen`)).status, 403);
  r = await admin('POST', `${J}/laeufe/${laufId}/abbrechen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Abbruch/);
  const { lauf } = await fertig(laufId);
  assert.equal(lauf.status, 'ABGEBROCHEN');
  assert.equal((await admin('POST', `${J}/laeufe/${laufId}/abbrechen`)).status, 409, 'schon beendet');

  // Server-Neustart: Lauf ohne Lebenszeichen gilt als abgebrochen, der Job ist wieder frei
  const [v] = await sql`insert into core.job_laeufe (job_id, ausloeser, gestartet_von, gestartet_am, lebenszeichen)
                        values ('test.lang', 'PLAN', 'system (Jobplanung)', now() - interval '20 minutes', now() - interval '10 minutes') returning id`;
  r = await admin('GET', `${J}/laeufe/${v.id}`);
  assert.equal(r.body.lauf.status, 'LAEUFT');
  r = await admin('GET', `${J}/laeufe?job=test.lang`);
  assert.equal(r.body.find((l: any) => l.id === Number(v.id)).status, 'ABGEBROCHEN');
  r = await admin('GET', `${J}/laeufe/${v.id}`);
  assert.match(r.body.lauf.ergebnis, /neu gestartet/);
  assert.equal(r.body.lauf.dauerSekunden, 600);
});

test('Planer: fällige Jobs atomar beanspruchen, nächster Start rückt weiter', async () => {
  // nur test.ok soll fällig sein
  await sql`update core.jobs set eingeplant = false, naechster_lauf = null where id <> 'test.ok'`;
  const faellig = new Date(Date.now() - 60_000);
  await sql`update core.jobs set eingeplant = true, plan = ${sql.json({ art: 'intervall', minuten: 60 })}, naechster_lauf = ${faellig} where id = 'test.ok'`;
  const vorher = (await sql`select count(*)::int as n from core.job_laeufe where job_id = 'test.ok' and ausloeser = 'PLAN'`)[0].n;
  // zwei Instanzen gleichzeitig: nur eine startet den Lauf
  await Promise.all([planerDurchlauf(), planerDurchlauf()]);
  for (let i = 0; i < 100 && (await sql`select 1 from core.job_laeufe where job_id = 'test.ok' and status = 'LAEUFT'`).length; i++) await warten(50);
  const laeufe = await sql`select status, gestartet_von from core.job_laeufe where job_id = 'test.ok' and ausloeser = 'PLAN' order by id`;
  assert.equal(laeufe.length - vorher, 1, 'genau ein Lauf');
  assert.deepEqual([laeufe.at(-1)!.status, laeufe.at(-1)!.gestartet_von], ['OK', 'system (Jobplanung)']);
  const [z] = await sql`select naechster_lauf from core.jobs where id = 'test.ok'`;
  assert.ok(new Date(z.naechster_lauf).getTime() > Date.now() + 58 * 60_000, 'nächster Start in einer Stunde');
  // nicht fällig: nichts passiert
  await planerDurchlauf();
  assert.equal((await sql`select count(*)::int as n from core.job_laeufe where job_id = 'test.ok' and ausloeser = 'PLAN'`)[0].n, vorher + 1);
});

test('Kern-Jobs: Aufräumen nach 90 Tagen, Nextcloud-Export ohne Einrichtung', async () => {
  const [alt] = await sql`insert into core.job_laeufe (job_id, ausloeser, gestartet_von, gestartet_am, beendet_am, lebenszeichen, status)
                          values ('test.ok', 'PLAN', 'x', now() - interval '91 days', now() - interval '91 days', now() - interval '91 days', 'OK') returning id`;
  await sql`insert into core.job_protokoll (lauf_id, nr, zeit, stufe, text) values (${alt.id}, 1, now() - interval '91 days', 'info', 'alt')`;
  const a = await jobAusfuehren('core.jobs.aufraeumen', { manuell: false });
  assert.equal(a.status, 'OK');
  assert.equal((await sql`select 1 from core.job_laeufe where id = ${alt.id}`).length, 0);
  assert.equal((await sql`select 1 from core.job_protokoll where lauf_id = ${alt.id}`).length, 0, 'Protokoll mit gelöscht');
  assert.ok((await sql`select 1 from core.job_laeufe where job_id = 'test.ok'`).length > 0, 'neuere Läufe bleiben');

  // Nextcloud-Export: nach Plan ohne Einrichtung nichts zu tun, von Hand Fehler mit Meldung
  assert.equal((await jobAusfuehren('core.backup.nextcloud', { manuell: false })).status, 'LEER');
  const n = await jobAusfuehren('core.backup.nextcloud');
  assert.equal(n.status, 'FEHLER');
  const r = await admin('GET', `${J}/laeufe/${n.laufId}`);
  assert.match(r.body.lauf.ergebnis, /unvollständig eingerichtet/);
});

test('Rechte: ansehen, planen und ausführen getrennt, Zusatzrecht des Jobs', async () => {
  assert.equal((await leser('GET', J)).status, 200);
  assert.equal((await leser('GET', `${J}/laeufe`)).status, 200);
  assert.equal((await leser('PUT', `${J}/test.ok/plan`, { eingeplant: false, plan: { art: 'intervall', minuten: 5 } })).status, 403);
  assert.equal((await leser('POST', `${J}/test.ok/standard`)).status, 403);
  let r = await leser('POST', `${J}/test.ok/ausfuehren`);
  assert.equal(r.status, 403);
  assert.match(r.body.message, /core\.jobs:execute/);
  assert.equal(((await leser('GET', J)).body as any[]).find((j) => j.id === 'test.ok').darfAusfuehren, false);

  const liste = (await ausfuehrer('GET', J)).body as any[];
  assert.equal(liste.find((j) => j.id === 'test.ok').darfAusfuehren, true);
  assert.equal(liste.find((j) => j.id === 'test.recht').darfAusfuehren, false, 'Zusatzrecht fehlt');
  r = await ausfuehrer('POST', `${J}/test.recht/ausfuehren`);
  assert.equal(r.status, 403);
  assert.match(r.body.message, /core\.backup:restore/);
  r = await ausfuehrer('POST', `${J}/test.ok/ausfuehren`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await fertig(r.body.laufId)).lauf.gestartetVon, 'ausfuehrer');
  assert.equal((await ausfuehrer('PUT', `${J}/test.ok/plan`, { eingeplant: false, plan: { art: 'intervall', minuten: 5 } })).status, 403);
  r = await admin('POST', `${J}/test.recht/ausfuehren`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await fertig(r.body.laufId)).lauf.status, 'OK');
});
