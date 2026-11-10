/**
 * „Meine Trainingszeiten“: Trainer melden nur für sich selbst zurück.
 * Prüft Zuordnung Benutzer ↔ Trainer, Isolation zwischen Trainern, Sperre bezahlter Monate,
 * Zeitnachweise und dass die Abrechnungs-App für Trainer gesperrt bleibt.
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
const MZ = '/api/m/tco/jt/meine';
const J = '/api/m/tco/jt';
const ANNA = '0000000301';
const BERT = '0000000302';

async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
const userId = async (name: string) => (await sql`select id::text as id from core.users where username = ${name}`)[0].id as string;

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt) values (${ANNA}, 'Anna', 'Trainerin', '2020-01-01'), (${BERT}, 'Bert', 'Coach', '2020-01-01')`;
  await sql`insert into tco.mitgliedera (adrnr, trainer, steuernummer) values (${ANNA}, true, '111/222/333'), (${BERT}, true, null)`;
  await sql`insert into tco.trentgelt (adrnr, valid_to, betrag) values (${ANNA}, '9999-12-31', 20), (${BERT}, '9999-12-31', 25)`;
  await sql`insert into tco.jrueckm (zalias, adrnr, datum, trainingsart, anzahl) values
    ('Anna Trainerin', ${ANNA}, '2026-10-06', 'Jugendtraining', 1.5),
    ('Bert Coach', ${BERT}, '2026-10-06', 'Jugendtraining', 2),
    ('Bert Coach', ${BERT}, '2026-10-08', 'Schnuppertraining', 1)`;
  // September: Annas Nachweis abgelegt und bezahlt → gesperrt
  await sql`insert into tco.jrueckm (zalias, adrnr, datum, trainingsart, anzahl) values ('Anna Trainerin', ${ANNA}, '2026-09-15', 'Jugendtraining', 2)`;
  await sql`insert into tco.jt_doku (adrnr, monat, belegnr, doc_id, erstellt_am, bezahlt_am, stunden, betrag, bezahlt_betrag)
            values (${ANNA}, '202609', 'JT_2026_09_TRAINERIN', 4711, '2026-10-01', '2026-10-05', 2, 40, 40)`;

  assert.equal((await admin('POST', '/api/admin/roles', { id: 'TRAINER', name: 'Trainer', permissions: ['tco.jtmeine:edit'] })).status, 200);
  // Schnuppertraining betreuen (#21): nur Bert
  assert.equal((await admin('POST', '/api/admin/roles', { id: 'SCHNUPPER', name: 'Schnuppertraining', permissions: ['tco.schnupper:display', 'tco.schnupper:edit'] })).status, 200);
  for (const u of ['anna', 'bert', 'ohne']) {
    assert.equal((await admin('POST', '/api/admin/users', { username: u, displayName: u, password: 'start-passwort', roles: u === 'bert' ? ['TRAINER', 'SCHNUPPER'] : ['TRAINER'] })).status, 200);
  }
});
after(async () => {
  await app?.close();
  await sql.end();
});

test('Zuordnung Benutzer ↔ Trainer in der Trainerpflege', async () => {
  let r = await admin('PUT', `${J}/trainer/benutzer`, { adrnr: ANNA, benutzer_id: await userId('anna') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin('PUT', `${J}/trainer/benutzer`, { adrnr: BERT, benutzer_id: await userId('bert') });
  assert.equal(r.status, 200);
  // ein Benutzer gehört zu höchstens einem Trainer
  r = await admin('PUT', `${J}/trainer/benutzer`, { adrnr: BERT, benutzer_id: await userId('anna') });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits Anna Trainerin zugeordnet/);
  r = await admin('GET', `${J}/entgelte`);
  assert.equal(r.body.trainer.find((t: any) => t.adrnr === ANNA).benutzer, 'anna');
  assert.ok(r.body.benutzer.some((u: any) => u.username === 'bert'));
});

test('Trainer sieht und ändert nur die eigenen Zeiten', async () => {
  const anna = await anmelden('anna');
  let r = await anna('GET', `${MZ}/monat?monat=202610`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.trainer.name, 'Anna Trainerin');
  assert.deepEqual(r.body.zeiten.map((z: any) => [z.datum, z.trainingsart, z.anzahl]), [['2026-10-06', 'Jugendtraining', 1.5]]);
  assert.equal(r.body.betrag, 30);
  assert.ok(!/Bert|Coach|0000000302/.test(r.text), 'fremder Trainer in der Antwort');
  assert.deepEqual(r.body.arten, ['Jugendtraining', 'Schnuppertraining', 'Schul-AG', 'Betreuung Spieltage']);

  // Schnuppertraining erfassen – eine mitgeschickte fremde Adressnummer wird ignoriert
  r = await anna('POST', `${MZ}/zeiten`, { adrnr: BERT, datum: '2026-10-08', trainingsart: 'Schnuppertraining', anzahl: 1.25 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const neu = await sql`select adrnr, anzahl::float8 as anzahl from tco.jrueckm where datum = '2026-10-08' order by adrnr`;
  assert.deepEqual(neu.map((x) => [x.adrnr, x.anzahl]), [[ANNA, 1.25], [BERT, 1]], 'Berts Zeit unverändert, Annas neu');

  // Trainingsart ändern (Jugend → Schnupper) und löschen – nur eigene Zeilen
  r = await anna('POST', `${MZ}/zeiten`, { datum: '2026-10-06', trainingsart: 'Schnuppertraining', anzahl: 1.5, altArt: 'Jugendtraining' });
  assert.equal(r.status, 200);
  r = await anna('POST', `${MZ}/zeiten/loeschen`, { datum: '2026-10-06', trainingsart: 'Jugendtraining' });
  assert.equal(r.status, 200);
  const tag6 = await sql`select adrnr, trainingsart from tco.jrueckm where datum = '2026-10-06' order by adrnr`;
  assert.deepEqual(tag6.map((x) => [x.adrnr, x.trainingsart]), [[ANNA, 'Schnuppertraining'], [BERT, 'Jugendtraining']]);

  // Trainingstage anlegen
  r = await anna('POST', `${MZ}/generieren`, { monat: '202610', wochentage: [1], trainingsart: 'Jugendtraining' });
  assert.equal(r.status, 200);
  assert.match(r.body.text, /Trainingstag\(e\) angelegt/);
  const [{ n }] = await sql`select count(*)::int as n from tco.jrueckm where adrnr = ${BERT}`;
  assert.equal(n, 2, 'keine Tage für andere Trainer angelegt');

  // Änderungsbeleg mit Aktion JT_RUECKMELDUNG
  const [{ c }] = await sql`select count(*)::int as c from core.change_header where action = 'JT_RUECKMELDUNG'`;
  assert.ok(c >= 3);

  // Voransicht Zeitnachweis (nur eigener)
  r = await anna('GET', `${MZ}/nachweis/pdf?monat=202610`);
  assert.equal(r.status, 200);
  assert.match(r.ct, /application\/pdf/);

  // Abrechnungs-App und fremde Endpunkte gesperrt
  assert.equal((await anna('GET', `${J}/monat?monat=202610`)).status, 403);
  assert.equal((await anna('POST', `${J}/zeiten`, { adrnr: BERT, datum: '2026-10-09', trainingsart: 'Jugendtraining', anzahl: 9 })).status, 403);
  assert.equal((await anna('GET', `${J}/nachweis/pdf?adrnr=${BERT}&monat=202610`)).status, 403);

  // Bert sieht Annas Änderungen nicht
  const bert = await anmelden('bert');
  r = await bert('GET', `${MZ}/monat?monat=202610`);
  assert.equal(r.body.trainer.name, 'Bert Coach');
  assert.ok(r.body.zeiten.every((z: any) => z.adrnr === BERT));
  assert.ok(!/Anna|Trainerin|0000000301/.test(r.text));
});

test('Bezahlte Monate gesperrt, Nachweise sichtbar', async () => {
  const anna = client();
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'neues-passwort' })).status, 200);
  let r = await anna('GET', `${MZ}/monat?monat=202609`);
  assert.equal(r.body.gesperrt, true);
  assert.equal(r.body.nachweis.bezahlt_am, '2026-10-05');
  r = await anna('POST', `${MZ}/zeiten`, { datum: '2026-09-16', trainingsart: 'Jugendtraining', anzahl: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bezahlt/);
  r = await anna('POST', `${MZ}/zeiten/loeschen`, { datum: '2026-09-15', trainingsart: 'Jugendtraining' });
  assert.equal(r.status, 400);

  r = await anna('GET', `${MZ}/nachweise`);
  assert.deepEqual(r.body.map((x: any) => [x.monat, x.bezahlt_am]), [['202609', '2026-10-05']]);
  // ohne Paperless: klare Meldung statt fremder Daten
  r = await anna('GET', `${MZ}/nachweis/dokument?monat=202610`);
  assert.equal(r.status, 400);
});

test('Benutzer ohne Trainerzuordnung bzw. ohne Berechtigung', async () => {
  const ohne = await anmelden('ohne');
  const r = await ohne('GET', `${MZ}/monat?monat=202610`);
  assert.equal(r.status, 403);
  assert.match(r.body.message, /keinem Trainer zugeordnet/);
  assert.equal((await ohne('POST', `${MZ}/zeiten`, { datum: '2026-10-10', trainingsart: 'Jugendtraining', anzahl: 1 })).status, 403);
  assert.equal((await client()('GET', `${MZ}/monat?monat=202610`)).status, 401);
});

test('Schnuppertraining: Übersicht und Teilnehmer je Einheit nur mit Berechtigung, Anzahl und Abgleich der Schnupper-Angaben (#21)', async () => {
  const LENA = '0000000401', MAX = '0000000402';
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, telefon6) values (${LENA}, 'Lena', 'Ball', '0171 1234567'), (${MAX}, 'Max', 'Netz', null)`;
  await sql`insert into tco.schnupper (adrnr, nummer, status, alter_jahre, termine, erziehungsberechtigt)
            values (${LENA}, 'ST-2026-0001', 'NEU', 8, ${sql.json({ tage: ['Mo', 'Mi'], zeiten: ['nachmittags'] } as never)}, 'Eva Ball'),
                   (${MAX}, 'ST-2026-0002', 'ABGESAGT', 9, '{}', 'Tom Netz')`;
  const login = async (u: string) => {
    const c = client();
    assert.equal((await c('POST', '/api/auth/login', { username: u, password: 'neues-passwort' })).status, 200);
    return c;
  };
  const anna = await login('anna');
  const bert = await login('bert');

  // ohne Berechtigung: keine Übersicht, keine Teilnehmer
  let r = await anna('GET', `${MZ}/monat?monat=202610`);
  assert.equal(r.body.schnupper, null);
  assert.equal((await anna('GET', `${MZ}/schnupper?monat=202610`)).status, 403);
  assert.equal((await anna('POST', `${MZ}/zeiten`, { datum: '2026-10-20', trainingsart: 'Schnuppertraining', anzahl: 1, teilnehmer: [LENA] })).status, 403);

  r = await bert('GET', `${MZ}/monat?monat=202610`);
  assert.deepEqual(r.body.schnupper, { edit: true });
  r = await bert('GET', `${MZ}/schnupper?monat=202610`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.teilnehmer.map((t: any) => [t.adrnr, t.einheiten, t.termine]), [[LENA, 0, 'Mo, Mi, nachmittags']], 'abgesagte nicht');
  assert.equal(r.body.kostenlos, 2);

  // 1. Einheit: Status „Termin vereinbart“, 1. Einheit und Trainer gesetzt
  r = await bert('POST', `${MZ}/zeiten`, { datum: '2026-10-20', trainingsart: 'Schnuppertraining', anzahl: 1, teilnehmer: [LENA] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const lena = async () => (await sql`select status, einheit1::text as e1, einheit2::text as e2, trainer from tco.schnupper where adrnr = ${LENA}`)[0];
  assert.deepEqual(await lena(), { status: 'TERMIN', e1: '2026-10-20', e2: null, trainer: 'Bert Coach' });
  // nicht mehr im Schnuppertraining
  r = await bert('POST', `${MZ}/zeiten`, { datum: '2026-10-20', trainingsart: 'Schnuppertraining', anzahl: 1, teilnehmer: [LENA, MAX] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Max Netz.*nicht mehr im Schnuppertraining/);

  // 2. Einheit: absolviert
  assert.equal((await bert('POST', `${MZ}/zeiten`, { datum: '2026-10-22', trainingsart: 'Schnuppertraining', anzahl: 1.5, teilnehmer: [LENA] })).status, 200);
  assert.deepEqual(await lena(), { status: 'ABSOLVIERT', e1: '2026-10-20', e2: '2026-10-22', trainer: 'Bert Coach' });
  r = await bert('GET', `${MZ}/schnupper?monat=202610`);
  assert.equal(r.body.teilnehmer[0].einheiten, 2);
  assert.deepEqual(r.body.tage, { '2026-10-20': [LENA], '2026-10-22': [LENA] });
  // ohne teilnehmer bleibt die Einheit unverändert (z. B. nur Dauer geändert)
  assert.equal((await bert('POST', `${MZ}/zeiten`, { datum: '2026-10-22', trainingsart: 'Schnuppertraining', anzahl: 2, altArt: 'Schnuppertraining' })).status, 200);
  assert.equal((await bert('GET', `${MZ}/schnupper?monat=202610`)).body.tage['2026-10-22'].length, 1);

  // Zeit löschen: Einheit entfällt, 2. Einheit wieder offen, Status bleibt
  assert.equal((await bert('POST', `${MZ}/zeiten/loeschen`, { datum: '2026-10-22', trainingsart: 'Schnuppertraining' })).status, 200);
  assert.deepEqual(await lena(), { status: 'ABSOLVIERT', e1: '2026-10-20', e2: null, trainer: 'Bert Coach' });
  // Trainingsart geändert: Einheit des Tages entfällt
  assert.equal((await bert('POST', `${MZ}/zeiten`, { datum: '2026-10-20', trainingsart: 'Jugendtraining', anzahl: 1, altArt: 'Schnuppertraining' })).status, 200);
  assert.equal((await sql`select count(*)::int as n from tco.schnupper_einheiten where schnupper_adrnr = ${LENA}`)[0].n, 0);

  // Anzahl auch in der App Schnuppertraining
  assert.equal((await bert('POST', `${MZ}/zeiten`, { datum: '2026-10-21', trainingsart: 'Schnuppertraining', anzahl: 1, teilnehmer: [LENA] })).status, 200);
  r = await admin('GET', '/api/m/tco/schnuppertraining?filter=ALLE');
  assert.equal(r.body.zeilen.find((z: any) => z.adrnr === LENA).einheiten, 1);
  assert.equal(r.body.zeilen.find((z: any) => z.adrnr === MAX).einheiten, 0);
});
