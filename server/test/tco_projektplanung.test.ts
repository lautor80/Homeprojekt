/**
 * App „Projekte“: Terminrechnung (Abhängigkeiten, Puffer, kritischer Weg) und Ressourcensummen als reine Funktionen;
 * über die Schnittstellen Projekt mit Kostenplanung, Termin- und Ressourcenplanung, Projektantrag als PDF, Rechte.
 *
 * Eigene Testdaten: Konto 4581, Mitglieder mit Adressnummern 0000081xxx, Projekte „PP-Test …“ im Jahr 2081.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { arbeitWert, materialSumme, PlanungFehler, ressourcenSummen, terminieren, type VorgangEin } from '../../modules/tco/server/projekte/planung.js';
import { zeitenSummen } from '../../modules/tco/server/projekte/zeiten.js';

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
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, roh: res.rawPayload, typ: ct };
  };
}
const call = client();
const P = '/api/m/tco/projekte';

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await call('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('4581', 'Instandhaltung Plätze Test', 'C2')`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname) values ('0000081001', 'Anna', 'Bauer'), ('0000081002', 'Ben', 'Schmitt'), ('0000081003', 'Clara', 'Weber')`;
});
after(async () => {
  await app?.close();
  await sql.end();
});

// ---------------------------------------------------------------------------
// Rechenkern
// ---------------------------------------------------------------------------

const V = (key: string, dauer: number, vor: (string | [string, number])[] = [], beginn: string | null = null): VorgangEin =>
  ({ key, bezeichnung: key, dauer, beginn, vorgaenger: vor.map((x) => (typeof x === 'string' ? { key: x, abstand: 0 } : { key: x[0], abstand: x[1] })) });
const zeile = (pl: ReturnType<typeof terminieren>, k: string) => { const t = pl.termine.get(k)!; return [t.beginn, t.ende, t.puffer, t.kritisch]; };

test('Terminrechnung: Kette, Abstand, Meilenstein', () => {
  const pl = terminieren('2081-03-01', [V('A', 5), V('B', 3, ['A']), V('C', 2, [['B', 4]]), V('M', 0, ['C'])]);
  assert.deepEqual(zeile(pl, 'A'), ['2081-03-01', '2081-03-05', 0, true]);
  assert.deepEqual(zeile(pl, 'B'), ['2081-03-06', '2081-03-08', 0, true]);
  assert.deepEqual(zeile(pl, 'C'), ['2081-03-13', '2081-03-14', 0, true], '4 Tage nach dem Ende von B');
  assert.deepEqual(zeile(pl, 'M'), ['2081-03-15', '2081-03-15', 0, true], 'Meilenstein am Tag nach dem letzten Vorgang');
  assert.equal(pl.beginn, '2081-03-01');
  assert.equal(pl.ende, '2081-03-14');
  assert.equal(pl.tage, 14);
});

test('Terminrechnung: zwei Wege – Puffer auf dem kürzeren, kritischer Weg auf dem längeren', () => {
  const pl = terminieren('2081-03-01', [V('Start', 2), V('Lang', 10, ['Start']), V('Kurz', 4, ['Start']), V('Ende', 1, ['Lang', 'Kurz'])]);
  assert.deepEqual(zeile(pl, 'Lang'), ['2081-03-03', '2081-03-12', 0, true]);
  assert.deepEqual(zeile(pl, 'Kurz'), ['2081-03-03', '2081-03-06', 6, false]);
  assert.deepEqual(zeile(pl, 'Ende'), ['2081-03-13', '2081-03-13', 0, true]);
  assert.equal(pl.tage, 13);
});

test('Terminrechnung: frühester Beginn von Hand schiebt, Vorgänger gehen vor, wenn sie später enden', () => {
  let pl = terminieren('2081-03-01', [V('A', 5), V('B', 2, ['A'], '2081-03-20')]);
  assert.deepEqual(zeile(pl, 'B'), ['2081-03-20', '2081-03-21', 0, true]);
  assert.equal(zeile(pl, 'A')[2], 14, 'A hat Puffer bis zum festen Beginn von B');
  pl = terminieren('2081-03-01', [V('A', 5), V('B', 2, ['A'], '2081-03-02')]);
  assert.equal(zeile(pl, 'B')[0], '2081-03-06');
  // Vorgang ohne Vorgänger und ohne Datum beginnt mit dem Projekt; ein früheres Datum zieht den Planbeginn vor
  pl = terminieren('2081-03-01', [V('Vorarbeit', 3, [], '2081-02-20'), V('A', 1)]);
  assert.equal(pl.beginn, '2081-02-20');
  assert.equal(pl.termine.get('A')!.beginn, '2081-03-01');
});

test('Terminrechnung: Kreis und unbekannter Vorgänger werden abgelehnt', () => {
  assert.throws(() => terminieren('2081-03-01', [V('A', 1, ['C']), V('B', 1, ['A']), V('C', 1, ['B'])]), (e: Error) => e instanceof PlanungFehler && /im Kreis/.test(e.message));
  assert.throws(() => terminieren('2081-03-01', [V('A', 1, ['X'])]), PlanungFehler);
  assert.throws(() => terminieren('2081-03-01', [V('A', 1, ['A'])]), PlanungFehler);
  const leer = terminieren('2081-03-01', []);
  assert.equal(leer.beginn, '2081-03-01');
});

test('Ressourcen: Wert der Eigenleistung zum externen Satz, Materialsummen', () => {
  assert.equal(arbeitWert({ name: 'Helfer', personen: 4, stunden: 6, satz: null }, 45), 1080);
  assert.equal(arbeitWert({ name: 'Elektriker', personen: 1, stunden: 8, satz: 72.5 }, 45), 580);
  assert.equal(materialSumme({ menge: 2.5, preis: 19.99 }), 49.98);
  assert.deepEqual(ressourcenSummen(
    [{ adrnr: '1', name: 'Anna', personen: 1, stunden: 8, satz: null }, { adrnr: '1', name: 'Anna', personen: 1, stunden: 4, satz: 60 }, { name: 'Helfer', personen: 3, stunden: 5, satz: null }],
    [{ menge: 10, preis: 12.5, beschafft: true }, { menge: 1, preis: 300 }], 40,
  ), { stunden: 27, eigenleistung: 8 * 40 + 4 * 60 + 15 * 40, personen: 4, material: 425, material_beschafft: 125 });
});

test('Soll-Ist der Stunden: nur bestätigte zählen, Wert zum Satz der Person', () => {
  const s = zeitenSummen(
    [{ adrnr: '1', name: 'Anna', stunden: 4, status: 'BESTAETIGT' }, { adrnr: '1', name: 'Anna', stunden: 3.5, status: 'GEMELDET' }, { adrnr: '2', name: 'Ben', stunden: 2, status: 'BESTAETIGT' },
      { adrnr: null, name: 'Helfer', stunden: 12, status: 'BESTAETIGT' }, { adrnr: '3', name: 'Clara', stunden: 1, status: 'ABGELEHNT' }, { adrnr: '3', name: 'Clara', stunden: 2, status: 'BESTAETIGT' }],
    [{ adrnr: '1', name: 'Anna', personen: 1, stunden: 8, satz: null }, { adrnr: '2', name: 'Ben', personen: 1, stunden: 4.5, satz: 60 }, { adrnr: null, name: 'Helfer', personen: 4, stunden: 6, satz: null }], 45,
  );
  assert.equal(s.stunden, 20);
  assert.equal(s.gemeldet, 3.5);
  assert.equal(s.wert, 4 * 45 + 2 * 60 + 12 * 45 + 2 * 45);
  assert.deepEqual(s.personen, [
    { name: 'Anna', adrnr: '1', geplant: 8, gemeldet: 3.5, bestaetigt: 4, offen: 4 }, { name: 'Ben', adrnr: '2', geplant: 4.5, gemeldet: 0, bestaetigt: 2, offen: 2.5 },
    { name: 'Clara', adrnr: '3', geplant: 0, gemeldet: 0, bestaetigt: 2, offen: 0 }, { name: 'Helfer', adrnr: null, geplant: 24, gemeldet: 0, bestaetigt: 12, offen: 12 },
  ]);
});

// ---------------------------------------------------------------------------
// Schnittstellen
// ---------------------------------------------------------------------------

let id = 0;
const planung = () => ({
  stundensatz: '45',
  vorgaenge: [
    { key: 'a', bezeichnung: 'Angebote einholen', dauer: 14, fertig: 100, vorgaenger: [] },
    { key: 'b', bezeichnung: 'Alten Belag abtragen', dauer: 3, fertig: 0, verantwortlich: 'Platzwart', vorgaenger: [{ key: 'a', abstand: 7 }] },
    { key: 'c', bezeichnung: 'Neuen Belag einbauen', dauer: 5, fertig: 0, vorgaenger: [{ key: 'b', abstand: 0 }] },
    { key: 'd', bezeichnung: 'Linien setzen', dauer: 1, fertig: 0, vorgaenger: [{ key: 'c', abstand: 0 }] },
    { key: 'e', bezeichnung: 'Zaun streichen', dauer: 2, fertig: 0, vorgaenger: [{ key: 'a', abstand: 0 }] },
    { key: 'f', bezeichnung: 'Abnahme', dauer: 0, fertig: 0, vorgaenger: [{ key: 'd', abstand: 0 }, { key: 'e', abstand: 0 }] },
  ],
  arbeit: [
    { vorgang: 'b', adrnr: '0000081001', name: 'Bauer, Anna', taetigkeit: 'Belag abtragen', personen: 1, stunden: '8', satz: '' },
    { vorgang: 'b', adrnr: null, name: 'Helfer', taetigkeit: 'Schubkarren', personen: 4, stunden: '6', satz: null },
    { vorgang: 'd', adrnr: '0000081002', name: 'Schmitt, Ben', taetigkeit: 'Linien', personen: 1, stunden: '4,5', satz: '60' },
  ],
  material: [
    { vorgang: 'c', bezeichnung: 'Ziegelmehl', menge: '2,5', einheit: 't', preis: '180', lieferant: 'Baustoff Müller', beschafft: false },
    { vorgang: 'd', bezeichnung: 'Linienband', menge: 2, einheit: 'Satz', preis: '1.250,00', beschafft: true },
  ],
});

test('Projekt anlegen (Kostenplanung wie im Haushaltsplan) und in der Übersicht finden', async () => {
  let r = await call('POST', P, {
    bezeichnung: 'PP-Test Platz 3 sanieren', verantwortlich: 'Sportwart', beginn: '2081-03', ende: '2081-05', bereich: 'C',
    positionen: [{ art: 'KOSTEN', bezeichnung: 'Belag und Linien', betrag: '4.000', konto: '4581', verteilung: 'GLEICH' }, { art: 'ZUSCHUSS', bezeichnung: 'Sportbund', betrag: 1500, verteilung: 'MONAT', von: '2081-05' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  id = r.body.id;
  r = await call('GET', P);
  assert.equal(r.status, 200);
  const p = r.body.projekte.find((x: any) => x.id === id);
  assert.equal(p.budget.kosten, 4000);
  assert.equal(p.budget.luecke, 2500);
  assert.equal(p.vorgaenge, 0);
  assert.deepEqual(p.termin, { beginn: '2081-03-01', ende: '2081-05-31', tage: 0, fertig: 0 }, 'ohne Vorgänge die Laufzeit des Projekts');
  assert.equal(r.body.pflege, true);
  assert.ok(r.body.mitglieder.some((m: any) => m.adrnr === '0000081001' && m.name === 'Bauer, Anna'));
  assert.ok(r.body.konten.some((k: any) => k.konto === '4581' && k.art === 'A'));
  // dasselbe Projekt steht im Haushaltsplan
  const hh = await call('GET', '/api/m/tco/haushalt/projekte');
  assert.ok(hh.body.projekte.some((x: any) => x.id === id));
});

test('Termin- und Ressourcenplanung sichern: Termine, Puffer, kritischer Weg, Summen', async () => {
  const r = await call('PUT', `${P}/${id}/planung`, planung());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pl = r.body.planung;
  assert.deepEqual(pl.vorgaenge.map((v: any) => [v.nr, v.bezeichnung, v.beginn, v.ende, v.puffer, v.kritisch]), [
    [1, 'Angebote einholen', '2081-03-01', '2081-03-14', 0, true],
    [2, 'Alten Belag abtragen', '2081-03-22', '2081-03-24', 0, true],
    [3, 'Neuen Belag einbauen', '2081-03-25', '2081-03-29', 0, true],
    [4, 'Linien setzen', '2081-03-30', '2081-03-30', 0, true],
    [5, 'Zaun streichen', '2081-03-15', '2081-03-16', 14, false],
    [6, 'Abnahme', '2081-03-31', '2081-03-31', 0, true],
  ]);
  assert.deepEqual(pl.vorgaenge[1].vorgaenger.map((x: any) => [x.nr, x.abstand]), [[1, 7]]);
  assert.deepEqual(pl.vorgaenge[5].vorgaenger.map((x: any) => x.nr), [4, 5]);
  assert.deepEqual(pl.termin, { beginn: '2081-03-01', ende: '2081-03-30', tage: 30, fertig: Math.round((14 * 100) / 26) });
  assert.equal(pl.stundensatz, 45);
  assert.deepEqual(pl.arbeit.map((a: any) => [a.name, a.personen, a.stunden, a.satz, a.satz_gilt, a.wert]), [
    ['Bauer, Anna', 1, 8, null, 45, 360], ['Helfer', 4, 6, null, 45, 1080], ['Schmitt, Ben', 1, 4.5, 60, 60, 270],
  ]);
  assert.equal(pl.arbeit[0].vorgang_id, pl.vorgaenge[1].id, 'Ressource hängt am Vorgang');
  assert.deepEqual(pl.material.map((m: any) => [m.bezeichnung, m.menge, m.preis, m.summe, m.beschafft]), [['Ziegelmehl', 2.5, 180, 450, false], ['Linienband', 2, 1250, 2500, true]]);
  assert.deepEqual(pl.summen, { stunden: 36.5, eigenleistung: 1710, personen: 6, material: 2950, material_beschafft: 2500 });
  // die Kostenplanung bleibt unberührt
  assert.equal(r.body.projekt.budget.kosten, 4000);
  assert.equal(r.body.projekt.positionen.length, 2);
  // Übersicht zeigt die Kennzahlen
  const p = (await call('GET', P)).body.projekte.find((x: any) => x.id === id);
  assert.equal(p.vorgaenge, 6);
  assert.equal(p.summen.eigenleistung, 1710);
});

test('erneut sichern mit den Kennungen vom Server; Vorgang entfernen löst die Ressource', async () => {
  const s = (await call('GET', `${P}/${id}`)).body.planung;
  const key = (v: number | null) => (v === null ? null : String(v));
  const body = {
    stundensatz: s.stundensatz,
    vorgaenge: s.vorgaenge.filter((v: any) => v.nr !== 5).map((v: any) => ({ key: String(v.id), bezeichnung: v.bezeichnung, beginn: v.beginn_fix, dauer: v.dauer, fertig: v.fertig, verantwortlich: v.verantwortlich,
      vorgaenger: v.vorgaenger.filter((x: any) => x.nr !== 5).map((x: any) => ({ key: String(x.id), abstand: x.abstand })) })),
    arbeit: s.arbeit.map((a: any) => ({ vorgang: key(a.vorgang_id), adrnr: a.adrnr, name: a.name, taetigkeit: a.taetigkeit, personen: a.personen, stunden: a.stunden, satz: a.satz })),
    material: s.material.map((m: any) => ({ vorgang: key(m.vorgang_id), bezeichnung: m.bezeichnung, menge: m.menge, einheit: m.einheit, preis: m.preis, lieferant: m.lieferant, beschafft: m.beschafft })),
  };
  const r = await call('PUT', `${P}/${id}/planung`, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.planung.vorgaenge.map((v: any) => v.bezeichnung), ['Angebote einholen', 'Alten Belag abtragen', 'Neuen Belag einbauen', 'Linien setzen', 'Abnahme']);
  assert.deepEqual(r.body.planung.summen, s.summen);
  assert.equal(r.body.planung.arbeit[0].vorgang_id, r.body.planung.vorgaenge[1].id);
  // Vorgänge behalten ihre Kennung – gemeldete Stunden hängen daran
  assert.deepEqual(r.body.planung.vorgaenge.map((v: any) => v.id), s.vorgaenge.filter((v: any) => v.nr !== 5).map((v: any) => v.id));
});

test('Fehler: Kreis in den Abhängigkeiten, unbekanntes Mitglied, Ressource an fehlendem Vorgang – nichts wird geändert', async () => {
  const vorher = (await call('GET', `${P}/${id}`)).body.planung;
  const b = planung();
  b.vorgaenge[0].vorgaenger = [{ key: 'd', abstand: 0 }];
  let r = await call('PUT', `${P}/${id}/planung`, b);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /im Kreis/);
  const c = planung();
  c.arbeit[0].adrnr = '0000099999';
  r = await call('PUT', `${P}/${id}/planung`, c);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /gibt es nicht/);
  const d = planung();
  d.material[0].vorgang = 'zzz';
  assert.equal((await call('PUT', `${P}/${id}/planung`, d)).status, 400);
  const e = planung();
  (e.vorgaenge[0] as any).dauer = 2.5;
  assert.equal((await call('PUT', `${P}/${id}/planung`, e)).status, 400);
  assert.deepEqual((await call('GET', `${P}/${id}`)).body.planung, vorher);
});

test('Projektantrag als PDF – mit und ohne Planung', async () => {
  let r = await call('GET', `${P}/${id}/pdf`);
  assert.equal(r.status, 200);
  assert.match(r.typ, /application\/pdf/);
  assert.equal(r.roh.subarray(0, 5).toString(), '%PDF-');
  const voll = r.roh.length;
  const leer = (await call('POST', P, { bezeichnung: 'PP-Test leer', beginn: '2081-06', ende: '2081-06', positionen: [] })).body.id;
  r = await call('GET', `${P}/${leer}/pdf`);
  assert.equal(r.roh.subarray(0, 5).toString(), '%PDF-');
  assert.ok(voll > r.roh.length, 'mit Terminen, Arbeit und Material ist der Antrag länger');
  // ohne Paperless-Einrichtung meldet die Ablage das verständlich
  r = await call('POST', `${P}/${id}/paperless`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Paperless ist nicht eingerichtet/);
  assert.equal((await call('POST', `${P}/${leer}/loeschen`, { grund: 'Test' })).status, 200);
});

test('Material als Kostenposition übernehmen: anlegen, dann auf die neue Summe setzen', async () => {
  let r = await call('POST', `${P}/${id}/material-uebernehmen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let pos = r.body.projekt.positionen.find((x: any) => x.bezeichnung === 'Material laut Ressourcenplanung');
  assert.equal(pos.art, 'KOSTEN');
  assert.equal(pos.betrag, 2950);
  assert.equal(r.body.projekt.budget.kosten, 6950);
  const b = planung();
  b.material[0].preis = '200';
  await call('PUT', `${P}/${id}/planung`, b);
  r = await call('POST', `${P}/${id}/material-uebernehmen`);
  pos = r.body.projekt.positionen.filter((x: any) => x.bezeichnung === 'Material laut Ressourcenplanung');
  assert.equal(pos.length, 1, 'keine zweite Position');
  assert.equal(pos[0].betrag, 3000);
  await call('PUT', `${P}/${id}/planung`, planung());
});

// ---------------------------------------------------------------------------
// Zeiten: Mitglieder melden selbst, der Planer bestätigt
// ---------------------------------------------------------------------------

const MZ = `${P}/meine-zeiten`;
const anna = client(), ben = client(), clara = client(), ohne = client();
async function benutzer(c: ReturnType<typeof client>, name: string, adrnr: string | null) {
  const r = await call('POST', '/api/admin/users', { username: name, displayName: name, password: 'geheim-geheim-1', roles: ['PP_TEST_MITGLIED'] });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  await sql`update core.users set must_change_password = false where username = ${name}`;
  if (adrnr) await sql`insert into tco.mitgliedera (adrnr, benutzer_id) select ${adrnr}, id from core.users where username = ${name} on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id`;
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'geheim-geheim-1' })).status, 200);
}

test('Meine Zeiten: melden erst, wenn das Projekt genehmigt ist – und nur, wer eingeplant ist', async () => {
  await sql`insert into core.roles (id, name, description) values ('PP_TEST_MITGLIED', 'PP-Test Mitglied', '')`;
  await sql`insert into core.role_permissions (role_id, permission) values ('PP_TEST_MITGLIED', 'tco.projektzeiten:edit')`;
  await benutzer(anna, 'pp-anna', '0000081001');
  await benutzer(ben, 'pp-ben', '0000081002');
  await benutzer(clara, 'pp-clara', '0000081003');
  await benutzer(ohne, 'pp-ohne', null);

  // Projekt noch Entwurf: nichts zu melden
  let r = await anna('GET', MZ);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.mitglied, { adrnr: '0000081001', name: 'Bauer, Anna' });
  assert.deepEqual(r.body.projekte, []);
  const s = (await call('GET', `${P}/${id}`)).body.planung;
  const vAbtragen = s.vorgaenge[1].id;
  assert.equal((await anna('POST', MZ, { projekt_id: id, datum: '2020-03-22', stunden: 4 })).status, 403);

  assert.equal((await call('POST', `${P}/${id}/status`, { status: 'BEANTRAGT' })).status, 200);
  assert.equal((await call('POST', `${P}/${id}/status`, { status: 'GENEHMIGT' })).status, 200);
  r = await anna('GET', MZ);
  assert.deepEqual(r.body.projekte.map((p: any) => [p.bezeichnung, p.eingeplant, p.vorgaenge.length]), [['PP-Test Platz 3 sanieren', true, 6]]);

  // Anna meldet – die Person kommt aus der Anmeldung, eine mitgeschickte Adressnummer wird nicht beachtet
  r = await anna('POST', MZ, { projekt_id: id, vorgang_id: vAbtragen, datum: '2020-03-22', stunden: '4,5', taetigkeit: 'Belag abgetragen', adrnr: '0000081002', name: 'Schmitt, Ben' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeiten.map((z: any) => [z.name, z.adrnr, z.stunden, z.status, z.vorgang, z.projekt]), [['Bauer, Anna', '0000081001', 4.5, 'GEMELDET', 'Alten Belag abtragen', 'PP-Test Platz 3 sanieren']]);
  // Datum in der Zukunft, Vorgang eines anderen Projekts, zu viele Stunden
  assert.equal((await anna('POST', MZ, { projekt_id: id, datum: '2099-01-01', stunden: 2 })).status, 400);
  assert.equal((await anna('POST', MZ, { projekt_id: id, vorgang_id: 999999, datum: '2020-03-22', stunden: 2 })).status, 400);
  assert.equal((await anna('POST', MZ, { projekt_id: id, datum: '2020-03-22', stunden: 30 })).status, 400);

  // Clara ist Mitglied, aber nicht eingeplant; „ohne“ ist keinem Mitglied zugeordnet
  assert.deepEqual((await clara('GET', MZ)).body.projekte, []);
  assert.equal((await clara('POST', MZ, { projekt_id: id, datum: '2020-03-22', stunden: 2 })).status, 403);
  r = await ohne('GET', MZ);
  assert.equal(r.body.mitglied, null);
  assert.match(r.body.hinweis, /keinem Mitglied zugeordnet/);
  assert.equal((await ohne('POST', MZ, { projekt_id: id, datum: '2020-03-22', stunden: 2 })).status, 403);
  // fremde Meldungen sieht niemand
  assert.deepEqual((await ben('GET', MZ)).body.zeiten, []);
  // ohne das Recht kein Zugriff – auch nicht mit dem Leserecht der Projekte
  assert.equal((await client()('GET', MZ)).status, 401);
});

test('offen für alle: auch nicht eingeplante Mitglieder melden', async () => {
  const b = { ...planung(), offen_fuer_alle: true };
  const s = (await call('GET', `${P}/${id}`)).body.planung;
  // mit den Kennungen des Servers sichern, damit Annas Meldung am Vorgang bleibt
  const key = (v: number | null) => (v === null ? null : String(v));
  const r0 = await call('PUT', `${P}/${id}/planung`, {
    stundensatz: s.stundensatz, offen_fuer_alle: true,
    vorgaenge: s.vorgaenge.map((v: any) => ({ key: String(v.id), bezeichnung: v.bezeichnung, beginn: v.beginn_fix, dauer: v.dauer, fertig: v.fertig, verantwortlich: v.verantwortlich, vorgaenger: v.vorgaenger.map((x: any) => ({ key: String(x.id), abstand: x.abstand })) })),
    arbeit: s.arbeit.map((a: any) => ({ vorgang: key(a.vorgang_id), adrnr: a.adrnr, name: a.name, taetigkeit: a.taetigkeit, personen: a.personen, stunden: a.stunden, satz: a.satz })),
    material: s.material.map((m: any) => ({ vorgang: key(m.vorgang_id), bezeichnung: m.bezeichnung, menge: m.menge, einheit: m.einheit, preis: m.preis, lieferant: m.lieferant, beschafft: m.beschafft })),
  });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  assert.equal(r0.body.planung.offen_fuer_alle, true);
  assert.equal(r0.body.planung.zeiten[0].vorgang, 'Alten Belag abtragen', 'die Meldung hängt weiter am Vorgang');
  assert.ok(b);
  let r = await clara('GET', MZ);
  assert.deepEqual(r.body.projekte.map((p: any) => [p.bezeichnung, p.eingeplant]), [['PP-Test Platz 3 sanieren', false]]);
  r = await clara('POST', MZ, { projekt_id: id, datum: '2020-03-23', stunden: 2, taetigkeit: 'Zaun gestrichen' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('Planer: bestätigen, zurückweisen mit Begründung, für Helfer erfassen – Soll-Ist zählt nur Bestätigtes', async () => {
  let s = (await call('GET', `${P}/${id}`)).body.planung;
  assert.deepEqual([s.ist.stunden, s.ist.gemeldet, s.ist.wert], [0, 6.5, 0]);
  const zAnna = s.zeiten.find((z: any) => z.adrnr === '0000081001').id, zClara = s.zeiten.find((z: any) => z.adrnr === '0000081003').id;
  let r = await call('POST', `${P}/zeiten/${zAnna}/status`, { status: 'BESTAETIGT' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.planung.ist.stunden, r.body.planung.ist.gemeldet, r.body.planung.ist.wert], [4.5, 2, 202.5]);
  assert.equal((await call('POST', `${P}/zeiten/${zClara}/status`, { status: 'ABGELEHNT' })).status, 400, 'ohne Begründung nicht');
  r = await call('POST', `${P}/zeiten/${zClara}/status`, { status: 'ABGELEHNT', grund: 'Der Zaun gehört nicht zum Projekt' });
  assert.equal(r.status, 200);
  assert.equal(r.body.planung.ist.gemeldet, 0);
  // der Planer erfasst für Helfer ohne Zugang und für ein Mitglied – gleich bestätigt
  r = await call('POST', `${P}/${id}/zeiten`, { name: 'Helfer', datum: '2020-03-22', stunden: 12, taetigkeit: '3 Helfer je 4 Stunden' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${P}/${id}/zeiten`, { adrnr: '0000081002', datum: '2020-03-30', stunden: '2', taetigkeit: 'Linien' });
  assert.equal(r.status, 200);
  s = r.body.planung;
  assert.deepEqual([s.ist.stunden, s.ist.wert], [18.5, 4.5 * 45 + 12 * 45 + 2 * 60]);
  assert.deepEqual(s.ist.personen.map((x: any) => [x.name, x.geplant, x.bestaetigt, x.offen]), [['Bauer, Anna', 8, 4.5, 3.5], ['Helfer', 24, 12, 12], ['Schmitt, Ben', 4.5, 2, 2.5], ['Weber, Clara', 0, 0, 0]]);
  assert.equal((await call('POST', `${P}/${id}/zeiten`, { adrnr: '0000099999', datum: '2020-03-30', stunden: 2 })).status, 400);
  // Übersicht zeigt die geleisteten Stunden
  const p = (await call('GET', P)).body.projekte.find((x: any) => x.id === id);
  assert.deepEqual(p.ist, { stunden: 18.5, gemeldet: 0, wert: s.ist.wert });

  // das Mitglied sieht Status und Begründung; Bestätigtes zieht es nicht mehr zurück, Zurückgewiesenes schon – und nur Eigenes
  const c = (await clara('GET', MZ)).body.zeiten[0];
  assert.deepEqual([c.status, c.grund], ['ABGELEHNT', 'Der Zaun gehört nicht zum Projekt']);
  assert.equal((await anna('POST', `${MZ}/${zAnna}/loeschen`)).status, 400);
  assert.equal((await anna('POST', `${MZ}/${zClara}/loeschen`)).status, 404, 'fremde Meldung');
  assert.equal((await clara('POST', `${MZ}/${zClara}/loeschen`)).status, 200);
  // bestätigen und erfassen darf nur der Planer
  assert.equal((await anna('POST', `${P}/zeiten/${zAnna}/status`, { status: 'GEMELDET' })).status, 403);
  assert.equal((await anna('POST', `${P}/${id}/zeiten`, { name: 'Helfer', datum: '2020-03-22', stunden: 2 })).status, 403);
  // Entscheidung zurücknehmen, Meldung löschen
  r = await call('POST', `${P}/zeiten/${zAnna}/status`, { status: 'GEMELDET' });
  assert.equal(r.body.planung.ist.gemeldet, 4.5);
  await call('POST', `${P}/zeiten/${zAnna}/status`, { status: 'BESTAETIGT' });
  const helfer = r.body.planung.zeiten.find((z: any) => z.name === 'Helfer').id;
  r = await call('POST', `${P}/zeiten/${helfer}/loeschen`);
  assert.equal(r.body.planung.zeiten.some((z: any) => z.id === helfer), false);
});

test('Antrag und Genehmigung laufen wie im Haushaltsplan; ein abgeschlossenes Projekt wird nicht mehr umgeplant', async () => {
  // die Terminplanung lebt in der Umsetzung weiter
  assert.equal((await call('POST', `${P}/${id}/status`, { status: 'UMSETZUNG' })).status, 200);
  const b = planung();
  b.vorgaenge[1].fertig = 50;
  let r = await call('PUT', `${P}/${id}/planung`, b);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.planung.vorgaenge[1].fertig, 50);
  assert.equal((await call('POST', `${P}/${id}/status`, { status: 'ABGESCHLOSSEN' })).status, 200);
  r = await call('PUT', `${P}/${id}/planung`, planung());
  assert.equal(r.status, 400);
  assert.match(r.body.message, /abgeschlossen/);
  // auf ein abgeschlossenes Projekt meldet niemand mehr
  assert.deepEqual((await anna('GET', MZ)).body.projekte, []);
  assert.equal((await anna('POST', MZ, { projekt_id: id, datum: '2020-03-22', stunden: 1 })).status, 403);
  assert.equal((await call('POST', `${P}/${id}/zeiten`, { name: 'Helfer', datum: '2020-03-22', stunden: 1 })).status, 400);
});

test('Rechte: nur ansehen – kein Planen, keine Mitgliederliste; ohne Recht kein Zugriff', async () => {
  const gast = client();
  assert.equal((await gast('GET', P)).status, 401);
  await sql`insert into core.roles (id, name, description) values ('PP_TEST_LESER', 'PP-Test Leser', '')`;
  await sql`insert into core.role_permissions (role_id, permission) values ('PP_TEST_LESER', 'tco.projekte:display')`;
  const r = await call('POST', '/api/admin/users', { username: 'pp-leser', displayName: 'PP Leser', password: 'geheim-geheim-1', roles: ['PP_TEST_LESER'] });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  await sql`update core.users set must_change_password = false where username = 'pp-leser'`;
  assert.equal((await gast('POST', '/api/auth/login', { username: 'pp-leser', password: 'geheim-geheim-1' })).status, 200);
  const d = await gast('GET', P);
  assert.equal(d.status, 200);
  assert.equal(d.body.pflege, false);
  assert.deepEqual(d.body.mitglieder, []);
  assert.equal((await gast('GET', `${P}/${id}`)).status, 200);
  assert.equal((await gast('GET', `${P}/${id}/pdf`)).status, 200);
  assert.equal((await gast('PUT', `${P}/${id}/planung`, planung())).status, 403);
  assert.equal((await gast('POST', P, { bezeichnung: 'nein', beginn: '2081-01', ende: '2081-02', positionen: [] })).status, 403);
  assert.equal((await gast('POST', `${P}/${id}/status`, { status: 'BEANTRAGT' })).status, 403);
  // der Haushaltsplan bleibt mit dem Projekte-Recht allein verschlossen
  assert.equal((await gast('GET', '/api/m/tco/haushalt/projekte')).status, 403);
});
