/**
 * Integrationstest Beiträge (Beitragsstamm) und Beitragsforecast:
 * Erstbefüllung aus Verträgen, Zeiträume (einfügen, entfernen, Prüfungen), Sichern, Aktiv-Schalter,
 * Neuanlage, Hochrechnung je Monat/Vertragsart und Berechtigungsprüfung.
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

/** Client mit eigenem Cookie (wie ein Browser) */
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
  };
}
const call = client();
const B = '/api/m/tco/beitraege';
const F = '/api/m/tco/forecast';
const JAHR = new Date().getFullYear();

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.fikonten (konto, name) values ('8002', 'Mitgliedsbeiträge'), ('8006', 'Jugendtraining'), ('8100', 'Spenden'), ('1200', 'Bank')`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, austritt, mitglnrn) values
    ('0000000101', 'Hans', 'Müller', '2020-01-01', null, '101'),
    ('0000000102', 'Mia', 'Müller', '2025-01-01', null, '102'),
    ('0000000103', 'Eva', 'Alt', '2010-01-01', '2024-12-31', '103')`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, vertragende, betrag) values
    ('0000000101', '1', '5', 'Erwachsene', '101', 'halbjährl.', '2020-01-01', null, 60),
    ('0000000102', '1', '90', 'Jugendtraining', '102', 'monatlich', '2025-01-01', null, 35),
    ('0000000102', '2', '3', 'Jugendliche', '102', 'halbjährl.', '2025-01-01', null, 20),
    ('0000000103', '1', '5', 'Erwachsene', '103', 'halbjährl.', '2010-01-01', '2024-12-31', 55)`;
});
after(async () => {
  await app?.close();
  await sql.end();
});

test('Beiträge: Erstbefüllung, Zeiträume, Sichern, Aktiv, Neuanlage', async () => {
  // leerer Stamm → Erstbefüllung (erst Testlauf, dann echt)
  let r = await call('GET', B);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.leer, true);
  r = await call('POST', `${B}/initial`, { test: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.log.at(-1).startsWith('Testlauf'));
  assert.equal((await call('GET', B)).body.leer, true);
  r = await call('POST', `${B}/initial`, { test: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.log.at(-1), 'Gesichert.');
  assert.ok(r.body.log.some((l: string) => l.startsWith('Art 5 Erwachsene: 60,00 EUR, halbjährl., Konto 8002')));
  assert.ok(r.body.log.some((l: string) => l.startsWith('Art 90 Jugendtraining: 35,00 EUR, monatlich, Konto 8006')));
  assert.equal((await call('POST', `${B}/initial`, { test: false })).status, 400, 'nur einmal');
  // abweichender Betrag (Eva, 55) → individuell
  const [eva] = await sql`select betrag_indiv from tco.vertraege where adrnr = '0000000103'`;
  assert.equal(eva.betrag_indiv, true);

  r = await call('GET', B);
  assert.equal(r.body.leer, false);
  assert.deepEqual(r.body.zeilen.map((z: any) => [z.art, z.betrag, z.vertraege, z.aktiv, z.gruppe]), [
    ['3', 20, 1, true, '3 · halbjährlich'], ['5', 60, 1, true, '3 · halbjährlich'], ['90', 35, 1, true, '1 · monatlich'],
  ]);
  assert.equal(r.body.zeilen[1].seit, 'Beginn');

  // Detail mit Zeiträumen und Verträgen
  r = await call('GET', `${B}/5`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vertraege_txt, '1 laufende Verträge');
  assert.deepEqual(r.body.preise.map((p: any) => [p.ab_txt, p.bis_txt, p.betrag, p.info]), [['Beginn', 'offen', 60, 'gilt heute']]);
  assert.equal(r.body.vertraege.length, 2);
  assert.deepEqual(r.body.vertraege.map((v: any) => [v.name, v.laeuft, v.betrag_heute]), [['Müller, Hans', true, 60], ['Alt, Eva', false, 55]]);
  assert.ok(r.body.konten.every((k: any) => k.key.startsWith('8')));

  // neuen Betrag ab 1.1. nächstes Jahr einfügen (deutsche Schreibweise), Zeitraum wird geteilt
  const ab = `${JAHR + 1}-01-01`;
  const pr = r.body.preise;
  r = await call('POST', `${B}/zeitraum`, { art: '5', preise: pr, aktion: 'einfuegen', ab, betrag: '65,00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fehler, '');
  assert.deepEqual(r.body.preise.map((p: any) => [p.gueltig_ab, p.gueltig_bis, p.betrag, p.info]), [
    ['1900-01-01', `${JAHR}-12-31`, 60, 'gilt heute'], [ab, '9999-12-31', 65, 'geplant'],
  ]);
  const zwei = r.body.preise;
  // entfernen → Vorgänger wird verlängert
  r = await call('POST', `${B}/zeitraum`, { art: '5', preise: zwei, aktion: 'entfernen', ab });
  assert.deepEqual(r.body.preise.map((p: any) => [p.gueltig_ab, p.gueltig_bis, p.betrag]), [['1900-01-01', '9999-12-31', 60]]);
  // ungültiger Betrag
  assert.equal((await call('POST', `${B}/zeitraum`, { art: '5', preise: pr, aktion: 'einfuegen', ab, betrag: 'abc' })).status, 400);

  // Sichern mit Lücke → Fehler; mit offenem Ende fehlend → Fehler
  r = await call('POST', B, { art: '5', bezeichnung: 'Erwachsene', turnus: 'halbjährl.', konto: '8002', aktiv: true,
    preise: [{ gueltig_ab: '1900-01-01', gueltig_bis: `${JAHR}-12-30`, betrag: 60 }, { gueltig_ab: ab, gueltig_bis: '9999-12-31', betrag: 65 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Lücke/);
  r = await call('POST', B, { art: '5', bezeichnung: 'Erwachsene', turnus: 'halbjährl.', konto: '8002', aktiv: true,
    preise: [{ gueltig_ab: '1900-01-01', gueltig_bis: `${JAHR}-12-31`, betrag: 60 }] });
  assert.match(r.body.message, /offen sein/);
  // noch nicht übernommener neuer Betrag
  r = await call('POST', B, { art: '5', bezeichnung: 'Erwachsene', turnus: 'halbjährl.', konto: '8002', aktiv: true, preise: zwei, neu_betrag: '70' });
  assert.match(r.body.message, /noch nicht übernommen/);
  // Erlöskonto nicht im Kontenstamm
  r = await call('POST', B, { art: '5', bezeichnung: 'Erwachsene', turnus: 'halbjährl.', konto: '8999', aktiv: true, preise: zwei });
  assert.match(r.body.message, /Kontenstamm/);

  // Sichern mit zwei Zeiträumen
  r = await call('POST', B, { art: '5', bezeichnung: 'Erwachsene', turnus: 'halbjährl.', konto: '8002', aktiv: true, preise: zwei });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.text, 'Beitrag 5 "Erwachsene" gesichert.');
  assert.equal(r.body.warnung, null);
  r = await call('GET', B);
  const z5 = r.body.zeilen.find((z: any) => z.art === '5');
  assert.equal(z5.betrag, 60);
  assert.equal(z5.naechst, `ab 01.01.${JAHR + 1}: 65,00 €`);
  const db = await sql`select gueltig_ab::text as ab, gueltig_bis::text as bis, betrag::float8 as betrag from tco.beitrag_pr where art = '5' order by gueltig_ab`;
  assert.deepEqual(db.map((p) => [p.ab, p.bis, p.betrag]), [['1900-01-01', `${JAHR}-12-31`, 60], [ab, '9999-12-31', 65]]);

  // Hinweis auf bestehende Sollstellungspositionen bei Änderung eines Zeitraums
  await sql`insert into tco.soll_pos (sollper, adrnr, vertragnr, art, betrag) values (${`${JAHR + 1}01`}, '0000000101', '1', '5', 65)`;
  r = await call('POST', B, { art: '5', bezeichnung: 'Erwachsene', turnus: 'halbjährl.', konto: '8002', aktiv: true,
    preise: [zwei[0], { ...zwei[1], betrag: '66,00' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.warnung, /1 Sollstellungsposition/);
  r = await call('POST', B, { art: '5', bezeichnung: 'Erwachsene', turnus: 'halbjährl.', konto: '8002', aktiv: true, preise: zwei });
  assert.equal(r.status, 200);

  // Aktiv-Schalter
  r = await call('POST', `${B}/3/aktiv`, { aktiv: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /inaktiv/);
  assert.equal((await call('GET', B)).body.zeilen.find((z: any) => z.art === '3').aktiv, false);
  // inaktive Art ist für neue Verträge gesperrt (Mitglieder-App)
  r = await call('POST', '/api/m/tco/mitglieder/m/0000000101/vertraege', { art: '3', beginn: `${JAHR}-01-01`, turnus: 'halbjährl.', betrag: 20 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nicht \(mehr\) aktiv/);
  assert.equal((await call('POST', `${B}/3/aktiv`, { aktiv: true })).status, 200);
  assert.equal((await call('POST', `${B}/99/aktiv`, { aktiv: true })).status, 400);

  // Neuanlage: Vorschlag (1 ist frei), Pflichtfelder, Doppelanlage
  r = await call('GET', `${B}/neu`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.art, '1');
  assert.equal(r.body.konto, '8002');
  assert.equal(r.body.turnus, 'halbjährl.');
  r = await call('POST', B, { neu: true, art: '1', bezeichnung: 'Passiv', turnus: 'jährlich', konto: '8002', aktiv: true, preise: [] });
  assert.match(r.body.message, /mindestens ein Zeitraum/);
  r = await call('POST', B, { neu: true, art: '1', bezeichnung: '', turnus: 'jährlich', konto: '8002', aktiv: true, preise: [{ gueltig_ab: `${JAHR}-01-01`, gueltig_bis: '9999-12-31', betrag: '30' }] });
  assert.match(r.body.message, /Bezeichnung/);
  r = await call('POST', B, { neu: true, art: '1', bezeichnung: 'Passiv', turnus: 'jährlich', konto: '8002', aktiv: true, preise: [{ gueltig_ab: `${JAHR}-01-01`, gueltig_bis: '9999-12-31', betrag: '30' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', B, { neu: true, art: '1', bezeichnung: 'Passiv', turnus: 'jährlich', konto: '8002', aktiv: true, preise: [{ gueltig_ab: `${JAHR}-01-01`, gueltig_bis: '9999-12-31', betrag: '30' }] });
  assert.match(r.body.message, /gibt es bereits/);
  r = await call('POST', B, { neu: true, art: '7', bezeichnung: 'X', turnus: 'jährlich', konto: '8002', aktiv: true, preise: [{ gueltig_ab: `${JAHR}-01-01`, gueltig_bis: '9999-12-31', betrag: '30' }] });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', `${B}/neu`)).body.art, '2');
  // Konto-Vorschlag für Spenden
  assert.equal((await call('GET', `${B}/101`)).status, 400, 'nicht vorhanden');

  // Änderungsbelege zur Beitragsart
  r = await call('GET', '/api/audit/object/BEITRAG/5');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 2);
});

test('Beitragsforecast: Monate, Vertragsarten, Mitglieder', async () => {
  let r = await call('GET', `${F}?jahr=${JAHR}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.jahr, JAHR);
  assert.equal(r.body.jahr2, JAHR + 1);
  assert.equal(r.body.monate.length, 12);
  assert.equal(r.body.jahre[0], JAHR + 1);
  assert.equal(r.body.jahre.length, 6);
  // Januar: Erwachsene 60 + Jugendliche 20 + Jugendtraining 35; Februar nur Jugendtraining; Juli wie Januar
  const m = (i: number) => r.body.monate[i - 1];
  assert.equal(m(1).wert1, 115);
  assert.equal(m(2).wert1, 35);
  assert.equal(m(7).wert1, 115);
  assert.equal(m(1).mtext, 'Januar');
  // Folgejahr: Erwachsene laut Beitragsstamm 65 ab 1.1.
  assert.equal(m(1).wert2, 120);
  assert.equal(m(1).delta, 5);
  assert.equal(m(1).state, 'Positive');
  assert.equal(r.body.summen.sum1, 2 * 115 + 10 * 35);
  assert.equal(r.body.summen.sum2, 2 * 120 + 10 * 35);
  assert.equal(r.body.summen.delta, 10);
  assert.equal(r.body.summen.state, 'Positive');
  assert.equal(r.body.chart.length, 12);
  assert.equal(r.body.chart[0].label, '01');
  // Vertragsarten: Kategorie → Art
  const arten = r.body.knoten.filter((k: any) => k.ebene === 2);
  assert.deepEqual(arten.map((k: any) => [k.kategorie, k.text, k.anzahl, k.wert1, k.wert2]), [
    ['Jugendtraining', 'Jugendtraining', 1, 420, 420], ['Mitgliedsbeitrag', 'Erwachsene', 1, 120, 130], ['Mitgliedsbeitrag', 'Jugendliche', 1, 40, 40],
  ]);
  const erw = arten.find((k: any) => k.text === 'Erwachsene');
  assert.equal(erw.preis, 60);                      // Stamm zum Jahresende des Basisjahres
  assert.equal(erw.peinh, 'EUR halbjährl.');
  const kat = r.body.knoten.filter((k: any) => k.ebene === 1);
  assert.deepEqual(kat.map((k: any) => [k.text, k.anzahl, k.wert1]), [['Jugendtraining', 1, 420], ['Mitgliedsbeitrag', 2, 160]]);
  assert.equal(r.body.knoten.filter((k: any) => k.ebene === 3).length, 0);

  // Mitglieder als dritte Stufe
  r = await call('GET', `${F}?jahr=${JAHR}&mitglieder=1`);
  assert.equal(r.status, 200);
  const mg = r.body.knoten.filter((k: any) => k.ebene === 3);
  assert.deepEqual(mg.map((k: any) => [k.text, k.wert1, k.wert2]), [['Müller, Mia', 420, 420], ['Müller, Hans', 120, 130], ['Müller, Mia', 40, 40]]);

  // Jahr ohne Verträge
  r = await call('GET', `${F}?jahr=2001`);
  assert.equal(r.status, 200);
  assert.match(r.body.info, /keine Beiträge/);
});

test('Berechtigungen: Anzeige ohne Bearbeiten, Forecast ohne Recht', async () => {
  assert.equal((await call('POST', '/api/admin/roles', { id: 'BT_LESER', name: 'Beiträge lesen', permissions: ['tco.beitraege:display'] })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['BT_LESER'] })).status, 200);
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  assert.equal((await leser('GET', B)).status, 200);
  assert.equal((await leser('GET', `${B}/5`)).status, 200);
  assert.equal((await leser('POST', `${B}/zeitraum`, { art: '5', preise: [], aktion: 'einfuegen', ab: '2030-01-01', betrag: '1' })).status, 200);
  assert.equal((await leser('POST', B, { art: '5', bezeichnung: 'X', turnus: 'x', konto: '8002', aktiv: true, preise: [] })).status, 403);
  assert.equal((await leser('POST', `${B}/5/aktiv`, { aktiv: false })).status, 403);
  assert.equal((await leser('POST', `${B}/initial`, { test: true })).status, 403);
  assert.equal((await leser('GET', `${F}?jahr=${JAHR}`)).status, 403);
  // Anzeige-Recht Beiträge erlaubt auch die Objekthistorie der Beitragsart (auditObjects-Eintrag BEITRAG)
  assert.equal((await call('GET', '/api/audit/object/BEITRAG/5')).status, 200);
});
