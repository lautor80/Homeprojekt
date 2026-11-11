/**
 * Integrationstest App „Präsentationen“ (#146): Sammelkorb (Option C) und eigene Vorlagen (Option B).
 * Prüft, dass gültige PPTX-Dateien entstehen, Platzhalter ersetzt und Diagramme/Tabellen gefüllt werden.
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
const { lesen, platzhalter, folienPfade } = await import('../../modules/tco/server/praesentation/pptx.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}
const admin = client();
const anonym = client();
const P = '/api/m/tco/praesentation';
const J = new Date().getFullYear();

/** sichtbare Folientexte einer PPTX (<a:t>, nur Folien, ohne Layouts und Objektnamen) */
function folienText(b64: string) {
  const t = lesen(Buffer.from(b64, 'base64'));
  const pfade = folienPfade(t);
  const text = pfade.map((p) => [...t.get(p)!.toString('utf8').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ')).join('\n');
  return { t, pfade, text };
}

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, geburtsdatum, eintritt, austritt, mitglnrn) values
            ('1', 'Anna', 'Alt', '1980-05-05', '2010-01-01', null, '0001'),
            ('2', 'Bernd', 'Bach', '1975-02-02', ${`${J - 1}-03-01`}, null, '0002')`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Präsentationen: ohne Anmeldung kein Zugriff', async () => {
  assert.equal((await anonym('GET', `${P}/katalog`)).status, 401);
});

test('Katalog liefert Kennzahlen, Diagramme und Tabellen', async () => {
  const r = await admin('GET', `${P}/katalog?jahr=${J}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.kpis.some((k: { key: string }) => k.key === 'MTG_GESAMT'));
  assert.ok(r.body.diagramme.some((k: { key: string }) => k.key === 'MTG_MONATE'));
  assert.ok(r.body.tabellen.some((k: { key: string }) => k.key === 'HAL_ABR'));
});

test('Sammelkorb (Option C): anhängen, keine Doppelten, PowerPoint erzeugen', async () => {
  assert.equal((await admin('POST', `${P}/korb/erzeugen`, { jahr: J })).status, 400, 'leerer Korb');
  let r = await admin('POST', `${P}/korb`, { art: 'KPI', schluessel: 'MTG_GESAMT' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('POST', `${P}/korb`, { art: 'KPI', schluessel: 'MTG_GESAMT' });
  assert.match(r.body.text, /bereits/);
  await admin('POST', `${P}/korb`, { art: 'DIAGRAMM', schluessel: 'MTG_MONATE', text: 'Leichtes Wachstum' });
  await admin('POST', `${P}/korb`, { art: 'TABELLE', schluessel: 'HAL_ABR' });
  await admin('POST', `${P}/korb`, { art: 'TEXT', titel: 'Ausblick', text: 'Neue Plätze & mehr' });
  const korb = (await admin('GET', `${P}/korb`)).body;
  assert.equal(korb.length, 4);
  assert.ok(korb.every((e: { id: string }) => e.id));

  r = await admin('POST', `${P}/korb/erzeugen`, { jahr: J, titel: 'Mitgliederversammlung', untertitel: 'Bericht' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.name, /^Mitgliederversammlung\.pptx$/);
  const { t, pfade, text } = folienText(r.body.datei);
  assert.equal(pfade.length, 6, 'Titel + 4 Inhalte + Ende');
  assert.match(text, /Mitgliederversammlung/);
  assert.match(text, /Ausblick/);
  assert.match(text, /Neue Plätze &amp; mehr/);
  assert.doesNotMatch(text, /\{\{(folie|K\d|praesentation)/, 'keine offenen Platzhalter');
  assert.ok([...t.keys()].some((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k)), 'Diagramm vorhanden');

  // Reihenfolge per PUT ändern, Kapitel ergänzen
  r = await admin('PUT', `${P}/korb`, [{ art: 'KAPITEL', titel: 'Finanzen' }, ...korb.reverse()]);
  assert.equal(r.status, 200);
  assert.equal(r.body[0].art, 'KAPITEL');
});

test('Vorlagen (Option B): Beispielvorlage hochladen, Platzhalter erkennen, füllen, löschen', async () => {
  const bsp = await admin('GET', `${P}/vorlagen/beispiel/datei`);
  assert.equal(bsp.status, 200);
  const pl = platzhalter(lesen(Buffer.from(bsp.body.datei, 'base64')));
  assert.ok(pl.includes('MTG_GESAMT') && pl.includes('praesentation.titel'), pl.join(','));

  assert.equal((await admin('POST', `${P}/vorlagen`, { name: 'Kaputt', dateiname: 'x.pptx', data: Buffer.from('kein zip').toString('base64') })).status, 400);
  let r = await admin('POST', `${P}/vorlagen`, { name: 'MV', dateiname: 'mv.pptx', data: bsp.body.datei });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.platzhalter, pl.length);
  const id = r.body.id;

  r = await admin('GET', `${P}/vorlagen/${id}?jahr=${J}`);
  const st = new Map(r.body.platzhalter.map((p: { name: string; bekannt: boolean }) => [p.name, p.bekannt]));
  assert.equal(st.get('MTG_GESAMT'), true);
  const eigene = [...st].filter(([, b]) => !b).map(([n]) => n as string);

  r = await admin('POST', `${P}/vorlagen/${id}/erzeugen`, { jahr: J, titel: 'MV 2026', texte: Object.fromEntries(eigene.map((n) => [n, `Text ${n}`])) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { text } = folienText(r.body.datei);
  assert.match(text, /MV 2026/);
  assert.doesNotMatch(text, /\{\{/, 'alle Platzhalter gefüllt');

  r = await admin('POST', `${P}/vorlagen/beispiel/erzeugen`, { jahr: J });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal((await admin('DELETE', `${P}/vorlagen/${id}`)).status, 200);
  assert.equal((await admin('GET', `${P}/vorlagen`)).body.length, 0);
});
