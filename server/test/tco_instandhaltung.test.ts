/**
 * Integrationstest Instandhaltung / Schadensmeldung (#205): Melden durch Mitglieder, Anzeige im Arbeitsvorrat und in den
 * Kennzahlen der Vereinsübersicht, Bearbeitung mit Statuswechsel, Platzsperre, Benachrichtigungen, Eskalation, Stammdaten.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
const FOTO = `data:image/png;base64,${Buffer.from('kein-echtes-png-aber-bild').toString('base64')}`;
const ctx = { userId: null, username: 'test', action: 'TEST' };

async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}

let mia: Awaited<ReturnType<typeof anmelden>>, tom: Awaited<ReturnType<typeof anmelden>>;
let platz3 = 0, clubhaus = 0, netz = 0, sanitaer = 0, adminId = '';

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`update core.users set email = 'platzwart@tc-test.example' where username = 'admin'`;
  adminId = (await sql`select id from core.users where username = 'admin'`)[0].id;
  for (const u of ['mia', 'tom']) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u === 'mia' ? 'Mia Matchball' : 'Tom Tiebreak', password: 'start-passwort', roles: ['MITGLIED'] })).status, 200);
  }
  await sql`update core.users set email = 'mia@tc-test.example' where username = 'mia'`;
  mia = await anmelden('mia');
  tom = await anmelden('tom');
  await sql`insert into tco.plaetze (name, art, aliase, wochentage, zeit_von, zeit_bis, gueltig_von) values ('Platz 3', 'FREI', 'P3', '1234567', '08:00', '22:00', '2020-01-01')`;
  clubhaus = (await sql`select id from tco.ih_anlage where kuerzel = 'clubhaus'`)[0].id;
  sanitaer = (await sql`select id from tco.ih_anlage where kuerzel = 'sanitaer'`)[0].id;
  netz = (await sql`select id from tco.ih_kategorie where bezeichnung = 'Netz/Pfosten'`)[0].id;
});
after(async () => { await app?.close(); await sql.end(); });

test('Vorbelegung, Rolle Mitglied darf melden, Stammdaten pflegen', async () => {
  assert.ok((await sql`select count(*)::int as n from tco.ih_kategorie`)[0].n >= 10);
  assert.ok((await sql`select 1 from core.role_permissions where role_id = 'MITGLIED' and permission = 'tco.schaden:melden'`).length === 1);
  // Anlage für den Platz anlegen (mit Verknüpfung zur Platzbuchung), Kürzel eindeutig
  const [p] = await sql`select id from tco.plaetze where name = 'Platz 3'`;
  let r = await admin('POST', `${T}/instandhaltung/stamm/anlagen`, { kuerzel: 'Platz3', bezeichnung: 'Platz 3', typ: 'PLATZ', platz_id: p.id, sort: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  platz3 = r.body.id;
  assert.equal((await sql`select kuerzel from tco.ih_anlage where id = ${platz3}`)[0].kuerzel, 'platz3');
  assert.equal((await admin('POST', `${T}/instandhaltung/stamm/anlagen`, { kuerzel: 'platz3', bezeichnung: 'Doppelt', typ: 'PLATZ' })).status, 400);
  assert.equal((await admin('POST', `${T}/instandhaltung/stamm/anlagen`, { kuerzel: 'mit leer', bezeichnung: 'X', typ: 'PLATZ' })).status, 400);
  // Zuständiger für Netz/Pfosten: Platzwart (admin); Vorstand per E-Mail
  r = await admin('PUT', `${T}/instandhaltung/stamm/kategorien/${netz}`, { bezeichnung: 'Netz/Pfosten', zustaendig: adminId, sort: 30 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('PUT', `${T}/instandhaltung/stamm/einstellungen`, { vorstand_email: 'kaputt', foto_frist_monate: 24 })).status, 400);
  r = await admin('PUT', `${T}/instandhaltung/stamm/einstellungen`, { vorstand_email: 'vorstand@tc-test.example; vorstand@tc-test.example', foto_frist_monate: 24 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('GET', `${T}/instandhaltung/stamm/daten`);
  assert.equal(r.body.einstellungen.vorstand_email, 'vorstand@tc-test.example');
  assert.ok(r.body.bearbeiter.some((b: { id: string }) => b.id === adminId), 'Administrator (*) ist Bearbeiter');
  // Mitglied: keine Stammdaten, keine Bearbeitung
  assert.equal((await mia('GET', `${T}/instandhaltung/stamm/daten`)).status, 403);
  assert.equal((await mia('GET', `${T}/instandhaltung`)).status, 403);
});

let m1 = 0, m2 = 0, nr1 = '';
test('Mitglied meldet Schaden mit Foto – sofort im Arbeitsvorrat und in den Kennzahlen der Vereinsübersicht', async () => {
  let r = await mia('GET', `${T}/schaden/stamm`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.anlagen.some((a: { kuerzel: string }) => a.kuerzel === 'platz3'));
  assert.equal((await mia('POST', `${T}/schaden`, { anlage_id: platz3, kategorie_id: netz, beschreibung: 'x', auswirkung: 'SICHERHEIT' })).status, 400);
  assert.equal((await mia('POST', `${T}/schaden`, { anlage_id: platz3, kategorie_id: netz, beschreibung: 'Netz', auswirkung: 'SICHERHEIT', fotos: [{ name: 'a.pdf', data: 'data:application/pdf;base64,AAAA' }] })).status, 400);
  r = await mia('POST', `${T}/schaden`, {
    anlage_id: platz3, kategorie_id: netz, beschreibung: 'Netzpfosten wackelt stark, droht umzufallen', auswirkung: 'SICHERHEIT', fotos: [{ name: 'pfosten.png', data: FOTO }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  m1 = r.body.id; nr1 = r.body.nummer;
  assert.match(nr1, /^SM-\d{4}-\d{4}$/);
  const [m] = await sql`select status, melder_name, zustaendig from tco.ih_meldung where id = ${m1}`;
  assert.deepEqual([m.status, m.melder_name, m.zustaendig], ['NEU', 'Mia Matchball', adminId], 'Zuständiger aus der Kategorie');

  r = await tom('POST', `${T}/schaden`, { anlage_id: sanitaer, kategorie_id: netz, beschreibung: 'Wasserhahn tropft in der Herrenumkleide', auswirkung: 'OPTISCH' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  m2 = r.body.id;

  // Arbeitsvorrat der Vereinsübersicht: jede offene Meldung einzeln, Sicherheitsrisiko rot, zuerst
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ihA = r.body.filter((a: { bereich: string }) => a.bereich === 'Instandhaltung');
  assert.deepEqual(ihA.map((a: { key: string }) => a.key), [`SCHADEN:${m1}`, `SCHADEN:${m2}`]);
  assert.equal(ihA[0].state, 'Negative');
  assert.equal(ihA[1].state, 'Information');
  assert.match(ihA[0].titel, /^Sicherheitsrisiko: Platz 3 – Netz\/Pfosten$/);
  assert.match(ihA[0].text, /gemeldet von Mia Matchball/);
  assert.equal(ihA[0].pfad, `/tco/instandhaltung?id=${m1}`);
  // ohne Berechtigung Instandhaltung: kein Eintrag (Mitglied hat keine Vereinsübersicht)
  assert.equal((await mia('GET', `${T}/dashboard/arbeitsvorrat`)).status, 403);

  // Kennzahlen
  r = await admin('GET', `${T}/dashboard`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const kpis = r.body.bereiche.find((b: { key: string }) => b.key === 'INSTANDHALTUNG').kpis;
  const k = (key: string) => kpis.find((x: { key: string }) => x.key === key);
  assert.equal(k('IH_OFFEN').value, '2');
  assert.equal(k('IH_OFFEN').state, 'Negative');
  assert.equal(k('IH_SICHER').value, '1');
  assert.equal(k('IH_GESPERRT').value, '0');
});

test('Benachrichtigung: Zuständiger und bei Sicherheitsrisiko zusätzlich der Vorstand', async () => {
  const a = await ih.mailsNeu(sql as never, m1);
  assert.equal(a.length, 1);
  assert.equal(a[0].an, 'platzwart@tc-test.example, vorstand@tc-test.example');
  assert.match(a[0].betreff, /SICHERHEITSRISIKO/);
  assert.match(a[0].text, new RegExp(`\\{portal\\}/tco/instandhaltung\\?id=${m1}`));
  const b = await ih.mailsNeu(sql as never, m2);
  assert.equal(b[0].an, 'platzwart@tc-test.example', 'kein Sicherheitsrisiko: nur der Zuständige');
});

test('Doppelmeldungen, Meine Meldungen, Fotos nur für Melder und Bearbeiter', async () => {
  let r = await tom('GET', `${T}/schaden/offen?anlage=${platz3}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].nummer, nr1);
  assert.equal(r.body[0].melder_name, undefined, 'ohne Melder');
  r = await mia('GET', `${T}/schaden/meine`);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].status_txt, 'Neu');
  const fotoId = r.body[0].fotos[0].id;
  r = await mia('GET', `${T}/schaden/foto/${fotoId}`);
  assert.equal(r.status, 200);
  assert.equal(r.ct, 'image/png');
  assert.equal((await tom('GET', `${T}/schaden/foto/${fotoId}`)).status, 404);
  assert.equal((await admin('GET', `${T}/schaden/foto/${fotoId}`)).status, 200);
});

test('Bearbeiten: Statusregeln, Platzsperre, Kommentar, Abschluss mit Mail an den Melder', async () => {
  const P = `${T}/instandhaltung/${m1}`;
  assert.equal((await admin('PUT', P, { status: 'DUPLIKAT' })).status, 400);
  assert.equal((await admin('PUT', P, { status: 'ABGELEHNT' })).status, 400);
  assert.equal((await admin('PUT', P, { status: 'ZUGEWIESEN' })).status, 400, 'ohne Zuständigen');
  let r = await admin('PUT', P, { status: 'IN_ARBEIT', zustaendig: adminId, kommentar: 'Pfosten abgesperrt', fuer_melder: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Platz sperren → feste Belegung „Gesperrt“ ab heute; zweimal geht nicht
  r = await admin('POST', `${P}/sperre`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('POST', `${P}/sperre`)).status, 400);
  const [s] = await sql`select b.art, b.plaetze, b.datum_von::text from tco.platzbelegungen b join tco.ih_meldung m on m.sperre_id = b.id where m.id = ${m1}`;
  assert.equal(s.art, 'SPERRE');
  assert.equal(s.plaetze.length, 1);
  r = await admin('GET', P);
  assert.ok(r.body.sperre_id && r.body.verlauf.some((v: { text: string }) => /gesperrt/.test(v.text ?? '')));
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.match(r.body.find((a: { key: string }) => a.key === `SCHADEN:${m1}`).text, /Platz 3 gesperrt/);
  r = await admin('GET', `${T}/dashboard`);
  assert.equal(r.body.bereiche.find((b: { key: string }) => b.key === 'INSTANDHALTUNG').kpis.find((x: { key: string }) => x.key === 'IH_GESPERRT').value, '1');
  // Sperre ohne Platz geht nicht
  assert.equal((await admin('POST', `${T}/instandhaltung/${m2}/sperre`)).status, 400);
  // aufheben: heute angelegt → gelöscht
  r = await admin('DELETE', `${P}/sperre`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select count(*)::int as n from tco.platzbelegungen`)[0].n, 0);

  // Nachher-Foto, interner Kommentar
  assert.equal((await admin('POST', `${P}/fotos`, { fotos: [{ name: 'neu.png', data: FOTO }] })).status, 200);
  assert.equal((await admin('POST', `${P}/kommentar`, { text: 'Ersatzteil bestellt', fuer_melder: false })).status, 200);

  // Abschluss: Mail an den Melder, Meldung verschwindet aus dem Arbeitsvorrat
  const erg = await withChange(ctx, (tx) => ih.bearbeiten(tx as never, m1, {
    status: 'ERLEDIGT', zustaendig: adminId, duplikat_von: null, erledigung: 'Pfosten neu einbetoniert', kosten: 80, firma: null, paperless: null, stunden: 3,
    kommentar: null, fuer_melder: true,
  }, 'Admin'));
  assert.equal(erg.mails.length, 1);
  assert.equal(erg.mails[0].an, 'mia@tc-test.example');
  assert.match(erg.mails[0].betreff, /ist erledigt/);
  r = await admin('GET', `${T}/dashboard/arbeitsvorrat`);
  assert.ok(!r.body.some((a: { key: string }) => a.key === `SCHADEN:${m1}`));
  // Melder sieht Status und für ihn freigegebene Einträge – nicht den internen Kommentar
  r = await mia('GET', `${T}/schaden/meine`);
  assert.equal(r.body[0].status, 'ERLEDIGT');
  const texte = r.body[0].verlauf.map((v: { text: string | null }) => v.text);
  assert.ok(texte.includes('Pfosten abgesperrt'));
  assert.ok(!texte.includes('Ersatzteil bestellt'));
  // Kennzahl erledigt im Jahr mit Kosten
  r = await admin('GET', `${T}/dashboard`);
  const kpis = r.body.bereiche.find((b: { key: string }) => b.key === 'INSTANDHALTUNG').kpis;
  assert.equal(kpis.find((x: { key: string }) => x.key === 'IH_OFFEN').value, '1');
  assert.match(kpis.find((x: { key: string }) => x.key === 'IH_ERLEDIGT').details, /80,00/);
  // Abgeschlossen → anderer Endstatus nicht möglich, wieder öffnen schon
  assert.equal((await admin('PUT', P, { status: 'ABGELEHNT', erledigung: 'doch nicht' })).status, 400);
  // Duplikat
  r = await admin('PUT', `${T}/instandhaltung/${m2}`, { status: 'DUPLIKAT', duplikat_von: m1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('GET', `${T}/instandhaltung?filter=ALLE`);
  assert.equal(r.body.zeilen.length, 2);
  assert.equal((await admin('GET', `${T}/instandhaltung`)).body.zeilen.length, 0);
  // Änderungsbelege
  assert.ok((await sql`select 1 from core.change_header where object_type = 'SCHADEN' limit 1`).length === 1);
});

test('Lauf: Erinnerung bei Sicherheitsrisiko nach 24 h, Fotos erledigter Meldungen nach Frist löschen', async () => {
  const r = await mia('POST', `${T}/schaden`, { anlage_id: clubhaus, kategorie_id: netz, beschreibung: 'Stromkabel liegt offen an der Terrasse', auswirkung: 'SICHERHEIT' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let l = await withChange(ctx, (tx) => ih.lauf(tx as never));
  assert.deepEqual(l.erinnert, [], 'noch keine 24 h');
  await sql`update tco.ih_meldung set status_am = now() - interval '25 hours' where id = ${r.body.id}`;
  l = await withChange(ctx, (tx) => ih.lauf(tx as never));
  assert.deepEqual(l.erinnert, [r.body.nummer]);
  assert.equal(l.mails[0].an, 'platzwart@tc-test.example, vorstand@tc-test.example');
  l = await withChange(ctx, (tx) => ih.lauf(tx as never));
  assert.deepEqual(l.erinnert, [], 'nur einmal je 24 h');
  // Fotofrist
  const vorher = (await sql`select count(*)::int as n from tco.ih_anhang where meldung_id = ${m1}`)[0].n;
  assert.equal(vorher, 2);
  await sql`update tco.ih_meldung set erledigt_am = now() - interval '25 months' where id = ${m1}`;
  l = await withChange(ctx, (tx) => ih.lauf(tx as never));
  assert.equal(l.fotosGeloescht, 2);
  assert.equal((await sql`select count(*)::int as n from tco.ih_meldung where id = ${m1}`)[0].n, 1, 'Meldung bleibt');
});

test('QR-Codes: Portal-Adresse nötig, dann PDF', async () => {
  assert.equal((await admin('GET', `${T}/instandhaltung/stamm/qr.pdf`)).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { 'portal.url': 'https://portal.example.org' })).status, 200);
  const r = await admin('GET', `${T}/instandhaltung/stamm/qr.pdf?anlage=${platz3}`);
  assert.equal(r.status, 200);
  assert.equal(r.ct, 'application/pdf');
  assert.equal(r.raw.subarray(0, 4).toString(), '%PDF');
  assert.equal((await mia('GET', `${T}/instandhaltung/stamm/qr.pdf`)).status, 403);
});
