/**
 * Vertragsangebot korrigieren (Mitgliedsanträge → Vertragsangebot „Ansehen“ → „Korrigieren…“): Inhalt eines offenen Angebots
 * ersetzen – gleiche Prüfung wie beim Erstellen, dieselbe Nummer, der alte Link wird ungültig, der neue zeigt den berichtigten Stand.
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
const { heute } = await import('../../modules/tco/server/format.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}
const A = '/api/m/tco/mitgliedsantraege/angebote';
const OEFFNEN = '/api/m/tco/antrag/angebot';
const DANA = '0000009701', TOM = '0000009702', LUCA = '0000009703';
const token = (link: string) => new URL(link).searchParams.get('angebot')!;
/** Eingabe wie aus dem Dialog: Familie, Luca mit `training` Trainingseinheiten */
const eingabe = (training: string[], mehr: Record<string, unknown> = {}) => ({
  personen: [{ adrnr: DANA, art: '8', training: [] }, { adrnr: TOM, training: [] }, { adrnr: LUCA, training }],
  eintritt: heute(), mail: false, ...mehr,
});

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  assert.equal((await call('PUT', '/api/settings', { 'portal.url': 'https://portal.example.org' })).status, 200);
  // Interessenten ohne Mitgliedschaft; Dana ohne Geburtsdatum im Stamm (wie im echten Fall)
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, geburtsdatum, email, strasse, plz, ort) values
            (${DANA}, 'Dana', 'Korrektur', null, 'dana.korrektur@example.org', 'Testweg 1', '66649', 'Oberthal'),
            (${TOM}, 'Tom', 'Korrektur', '1982-07-19', null, 'Testweg 1', '66649', 'Oberthal'),
            (${LUCA}, 'Luca', 'Korrektur', '2010-03-24', null, 'Testweg 1', '66649', 'Oberthal')`;
  await sql`insert into tco.beitrag (art, bezeichnung, turnus) values ('5', 'Erwachsene', 'jährlich'), ('8', 'Mitgliedsbeitrag Familien', 'halbjährl.'), ('90', 'Jugendtraining TCO', 'monatlich')`;
  await sql`insert into tco.beitrag_pr (art, gueltig_ab, betrag) values ('5', '2000-01-01', 150), ('8', '2000-01-01', 125), ('90', '2000-01-01', 28.5)`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Korrektur ersetzt den Inhalt: gleiche Nummer, alter Link ungültig, neuer Link zeigt den berichtigten Stand', async () => {
  // versehentlich zwei Trainingseinheiten für Luca
  let r = await call('POST', A, eingabe(['90', '90']));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const nummer = r.body.nummer as string;
  const alt = token(r.body.link);
  const id = ((await call('GET', `${A}?alle=1`)).body.liste as { id: number; nummer: string }[]).find((x) => x.nummer === nummer)!.id;

  // ohne Geburtsdatum der ersten Person öffnet der Link direkt – die Person sieht beide Einheiten
  r = await call('POST', OEFFNEN, { token: alt });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.daten.personen[2].training, ['90', '90']);
  r = await call('GET', `${A}/${id}`);
  assert.ok(r.body.geoeffnet_am, 'geöffnet vermerkt');
  assert.deepEqual(r.body.personen.map((p: { adrnr: string }) => p.adrnr), [DANA, TOM, LUCA]);

  // Korrektur: eine Einheit, Geburtsdatum für Dana nachgetragen (fehlt im Stamm), Hinweis
  r = await call('PUT', `${A}/${id}`, {
    ...eingabe(['90'], { bemerkung: 'berichtigt: eine Trainingseinheit' }),
    personen: [{ adrnr: DANA, art: '8', training: [], geburtsdatum: '1984-02-03', anrede: 'Frau' }, { adrnr: TOM, training: [] }, { adrnr: LUCA, training: ['90'] }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nummer, nummer, 'die Nummer bleibt');
  assert.match(r.body.text, /korrigiert/);
  const neu = token(r.body.link);
  assert.notEqual(neu, alt);

  assert.equal((await call('POST', OEFFNEN, { token: alt })).status, 404, 'der bisherige Link ist ungültig');
  r = await call('POST', OEFFNEN, { token: neu });
  assert.equal(r.body.geburtsdatumNoetig, true, 'mit Geburtsdatum wieder die zweite Abfrage');
  r = await call('POST', OEFFNEN, { token: neu, geburtsdatum: '1984-02-03' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.daten.personen[2].training, ['90']);
  assert.equal(r.body.daten.personen[0].anrede, 'Frau');
  assert.equal(r.body.daten.bemerkung, 'berichtigt: eine Trainingseinheit');

  r = await call('GET', `${A}/${id}`);
  assert.equal(r.body.status, 'OFFEN');
  assert.equal(r.body.personen[0].geburtsdatum, '1984-02-03');
  assert.equal(r.body.versuche, 0);
  assert.equal(((await call('GET', `${A}?alle=1`)).body.liste as unknown[]).length, 1, 'kein zweites Angebot');
});

test('Korrektur: gleiche Prüfung wie beim Erstellen, Bankverbindung behalten oder ersetzen, vergangener Eintritt bleibt zulässig', async () => {
  const id = ((await call('GET', `${A}?alle=1`)).body.liste as { id: number }[])[0].id;
  // Regeln des Antrags gelten weiter: weitere Personen nur mit dem Familienbeitrag
  let r = await call('PUT', `${A}/${id}`, { ...eingabe(['90']), personen: [{ adrnr: DANA, art: '5', training: [] }, { adrnr: LUCA, training: ['90'] }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Familienbeitrag/);
  r = await call('PUT', `${A}/${id}`, eingabe(['90'], { iban: 'DE00 0000' }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /IBAN/);
  assert.deepEqual((await call('GET', `${A}/${id}`)).body.personen[2].training, ['90'], 'abgelehnte Korrektur ändert nichts');

  // Bankverbindung vom Vorstand erfasst → bei der nächsten Korrektur behalten → ohne „behalten“ gilt wieder der Stamm (dort keine)
  r = await call('PUT', `${A}/${id}`, eingabe(['90'], { kontoinhaber: 'Dana Korrektur', iban: 'DE89 3704 0044 0532 0130 00' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await call('GET', `${A}/${id}`)).body.bank, 'Bankverbindung hinterlegt');
  assert.equal((await call('PUT', `${A}/${id}`, eingabe(['90'], { bankBehalten: true }))).status, 200);
  assert.ok((await call('GET', `${A}/${id}`)).body.bank, 'bleibt bei „behalten“');
  const [{ iban }] = await sql`select daten->'bank'->>'iban' as iban from tco.vertragsangebote where id = ${id}`;
  assert.equal(iban, 'DE89370400440532013000');
  assert.equal((await call('PUT', `${A}/${id}`, eingabe(['90']))).status, 200);
  assert.equal((await call('GET', `${A}/${id}`)).body.bank, null, 'ohne „behalten“ und ohne Eingabe: Stamm – dort keine');

  // Eintritt liegt inzwischen zurück: unverändert zulässig, ein anderes vergangenes Datum nicht
  await sql`update tco.vertragsangebote set daten = jsonb_set(daten, '{eintritt}', '"2020-03-01"') where id = ${id}`;
  assert.equal((await call('PUT', `${A}/${id}`, eingabe(['90'], { eintritt: '2020-03-01' }))).status, 200);
  r = await call('PUT', `${A}/${id}`, eingabe(['90'], { eintritt: '2020-03-02' }));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /frühestens heute/);
});

test('Korrektur nur bei offenen Angeboten', async () => {
  const id = ((await call('GET', `${A}?alle=1`)).body.liste as { id: number }[])[0].id;
  assert.equal((await call('PUT', `${A}/999999`, eingabe(['90']))).status, 404);
  assert.equal((await call('POST', `${A}/${id}/zurueckziehen`, {})).status, 200);
  const r = await call('PUT', `${A}/${id}`, eingabe(['90']));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /zurückgezogen – korrigieren lässt sich nur ein offenes Angebot/);
});
