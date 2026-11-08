/**
 * Datenschutz: Bankdaten von Personen nur mit `tco.bankdaten:display` im Klartext.
 * Prüft Mitglieder-Detail, Zahlerauswahl, Unterlagen-Voransicht, Sollstellung (Positionen, SEPA-Datei),
 * Änderungsbelege und das Ändern der Bankverbindung (`tco.bankdaten:edit`).
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
const { maskIban, maskBic, maskText, ibansImText, istMaskiert } = await import('../src/schutz.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, text: res.body, raw: res.rawPayload };
  };
}
const admin = client();
const M = '/api/m/tco/mitglieder';
const S = '/api/m/tco/soll';
const IBAN = 'DE89370400440532013000';
const IBAN2 = 'DE02120300000000202051';
/** Kommt irgendwo eine vollständige IBAN der Testdaten vor? */
const klartext = (s: string) => [IBAN, IBAN2, 'DE89 3704 0044 0532 0130 00', 'COBADEFFXXX', 'Erika Beispiel'].some((x) => s.includes(x));

async function benutzer(name: string, rechte: string[]) {
  assert.equal((await admin('POST', '/api/admin/roles', { id: name.toUpperCase(), name, permissions: rechte })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { username: name, displayName: name, password: 'start-passwort', roles: [name.toUpperCase()] })).status, 200);
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.mitglieder (adrnr, anrede, vorname, nachname, eintritt, mitglnrn, zahlungsart, iban1, bic1, bank1, abwkontoinh, mandatsrefenz) values
    ('0000000201', 'Herr', 'Max', 'Muster', '2020-01-01', '201', 'L', ${IBAN}, 'COBADEFFXXX', 'Commerzbank', 'Erika Beispiel', '201201'),
    ('0000000202', 'Frau', 'Mia', 'Muster', '2021-01-01', '202', 'L', ${IBAN2}, null, 'Testbank', null, '202202')`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, vertragende, betrag)
            values ('0000000201', '1', '5', 'Erwachsene', '201', 'halbjährlich', '2020-01-01', null, 60)`;
  await sql`insert into tco.soll_kopf (laufid, sollper, status, xml, anz_pos, anz_tx, summe) values ('0000000001', '202601', 'E', ${`<Document><IBAN>${IBAN}</IBAN></Document>`}, 1, 1, 60)`;
  await sql`insert into tco.soll_pos (sollper, adrnr, vertragnr, laufid, betrag, mitglied_name, zahler_adrnr, zahler_name, fi_name, iban, bic, mandatsref, status)
            values ('202601', '0000000201', '1', '0000000001', 60, 'Muster, Max', '0000000201', 'Muster, Max', 'MUSTER MAX', ${IBAN}, 'COBADEFFXXX', '201201', '')`;
});
after(async () => {
  await app?.close();
  await sql.end();
});

test('Maskierung: Formate', () => {
  assert.equal(maskIban(IBAN), 'DE••••••••••••••••3000');
  assert.equal(maskIban('DE89 3704 0044 0532 0130 00'), 'DE••••••••••••••••3000');
  assert.equal(maskBic('COBADEFFXXX'), 'COBA•••••••');
  assert.equal(maskText('Erika Beispiel'), 'E•••• B•••••••');
  assert.equal(ibansImText(`SVWZ Beitrag IBAN+${IBAN} Danke`), 'SVWZ Beitrag IBAN+DE••••••••••••••••3000 Danke');
  assert.ok(istMaskiert(maskIban(IBAN)));
  assert.equal(maskIban(''), '');
});

test('Ohne Bankdaten-Berechtigung: nur maskiert, Ändern gesperrt', async () => {
  const leser = await benutzer('leser', ['tco.mitglieder:display', 'tco.mitglieder:edit', 'tco.soll:display', 'tco.soll:edit', 'core.audit:display']);

  let r = await leser('GET', `${M}/m/0000000201`);
  assert.equal(r.status, 200);
  assert.equal(r.body.bankKlar, false);
  assert.equal(r.body.bank.iban, 'DE••••••••••••••••3000');
  assert.equal(r.body.bank.bic, 'COBA•••••••');
  assert.equal(r.body.bank.bank, 'Commerzbank', 'Kreditinstitut bleibt sichtbar');
  assert.ok(!klartext(r.text), 'Detail enthält Klartext');

  r = await leser('GET', `${M}/auswahl`);
  assert.ok(!klartext(r.text), 'Zahlerauswahl enthält Klartext');
  r = await leser('GET', `${M}/neu/zahler/0000000202`);
  assert.equal(r.body.iban, maskIban(IBAN2));

  // Unterlagen-Voransicht (SEPA-Mandat) bleibt möglich – mit maskierter Bankverbindung
  r = await leser('GET', `${M}/m/0000000201/unterlage/5`);
  assert.equal(r.status, 200);

  // Bankverbindung ändern: verboten
  r = await leser('PUT', `${M}/m/0000000201/bank`, { zahlungsart: 'L', zahlungsweise: '', iban: IBAN2, bic: '', bank: '', abwkontoinh: '', adrnrkih: '' });
  assert.equal(r.status, 403);

  // Sollstellung: Positionen maskiert, SEPA-Datei gesperrt
  r = await leser('GET', `${S}/laeufe/1`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bankKlar, false);
  assert.equal(r.body.pos[0].iban, maskIban(IBAN));
  assert.ok(!klartext(r.text), 'Lauf enthält Klartext');
  r = await leser('GET', `${S}/laeufe/1/datei`);
  assert.equal(r.status, 403);

  // Änderungsbelege: Bankfelder maskiert (Admin ändert, Leser schaut)
  r = await admin('PUT', `${M}/m/0000000202/bank`, { zahlungsart: 'L', zahlungsweise: '', iban: IBAN, bic: 'COBADEFFXXX', bank: 'Commerzbank', abwkontoinh: '', adrnrkih: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await leser('GET', '/api/audit/object/MITGLIED/0000000202');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const items = r.body.flatMap((h: any) => h.items);
  const ibanItem = items.find((i: any) => i.field === 'iban1');
  assert.ok(ibanItem, 'Änderung der IBAN protokolliert');
  assert.equal(ibanItem.masked, true);
  assert.ok(!klartext(r.text), 'Änderungsbeleg enthält Klartext');
  r = await leser('GET', '/api/audit?objectType=MITGLIED');
  assert.ok(!klartext(r.text), 'Belegsuche enthält Klartext');
});

test('Mit Bankdaten-Berechtigung: Klartext, Ändern mit edit, maskierte Eingaben abgelehnt', async () => {
  const kasse = await benutzer('kasse', ['tco.mitglieder:display', 'tco.mitglieder:edit', 'tco.soll:display', 'tco.soll:edit', 'tco.bankdaten:display', 'tco.bankdaten:edit']);
  let r = await kasse('GET', `${M}/m/0000000201`);
  assert.equal(r.body.bankKlar, true);
  assert.equal(r.body.bank.iban, IBAN);
  assert.equal(r.body.bank.abwkontoinh, 'Erika Beispiel');

  r = await kasse('PUT', `${M}/m/0000000201/bank`, { zahlungsart: 'L', zahlungsweise: '', iban: maskIban(IBAN), bic: '', bank: '', abwkontoinh: '', adrnrkih: '' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Maskierte Bankdaten/);
  r = await kasse('PUT', `${M}/m/0000000201/bank`, { zahlungsart: 'L', zahlungsweise: '', iban: IBAN2, bic: '', bank: 'Testbank', abwkontoinh: '', adrnrkih: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [m] = await sql`select iban1 from tco.mitglieder where adrnr = '0000000201'`;
  assert.equal(m.iban1, IBAN2);

  r = await kasse('GET', `${S}/laeufe/1/datei`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(IBAN));
});

test('Neuanlage ohne Berechtigung: maskierte Zahler-IBAN wird serverseitig übernommen', async () => {
  const c = await benutzer('erfasser', ['tco.mitglieder:display', 'tco.mitglieder:edit']);
  const vorschlag = await c('GET', `${M}/neu/zahler/0000000202`);
  assert.ok(istMaskiert(vorschlag.body.iban));
  const r = await c('POST', `${M}/neu`, {
    anrede: 'Herr', vorname: 'Tom', nachname: 'Muster', strasse: '', plz: '', ort: '', telefon: '', mobil: '', email: '', geburtsdatum: '2010-01-01',
    eintritt: '2026-01-01', datenschutz: true, bildrechte: false, zahlungsart: 'L', zahlungsweise: 'halbjährlich',
    iban: vorschlag.body.iban, bic: vorschlag.body.bic, bank: '', sepa: false, sepa_datum: null,
    zahler_modus: 'BESTEHEND', zahler_adrnr: '0000000202', z_anrede: '', z_vorname: '', z_nachname: '', z_strasse: '', z_plz: '', z_ort: '', z_email: '',
    vertraege: [{ art: '5', beginn: '2026-01-01', betrag: 60, turnus: 'halbjährlich' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [neu] = await sql`select iban1 from tco.mitglieder where vorname = 'Tom' and nachname = 'Muster'`;
  const [zahler] = await sql`select iban1 from tco.mitglieder where adrnr = '0000000202'`;
  assert.equal(neu.iban1, zahler.iban1, 'Klartext-IBAN des Zahlers übernommen');
  assert.ok(!istMaskiert(neu.iban1));

  // Maskierte IBAN ohne Quelle → Fehler statt Speichern
  const f = await c('POST', `${M}/neu`, {
    anrede: 'Frau', vorname: 'Ida', nachname: 'Ohnequelle', strasse: '', plz: '', ort: '', telefon: '', mobil: '', email: '', geburtsdatum: null,
    eintritt: '2026-01-01', datenschutz: true, bildrechte: false, zahlungsart: 'L', zahlungsweise: '', iban: maskIban(IBAN), bic: '', bank: '',
    sepa: false, sepa_datum: null, zahler_modus: 'SELBST', zahler_adrnr: null, z_anrede: '', z_vorname: '', z_nachname: '', z_strasse: '', z_plz: '', z_ort: '', z_email: '',
    vertraege: [{ art: '5', beginn: '2026-01-01', betrag: 60, turnus: 'halbjährlich' }],
  });
  assert.equal(f.status, 400);
  assert.match(f.body.message, /maskiert/);
});
