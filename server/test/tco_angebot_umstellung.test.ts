/**
 * Vertragsangebot an bestehende Mitglieder – Umstellung der Mitgliedschaft (z. B. Einzelbeiträge → Familienbeitrag):
 * Die bisherigen Mitgliedschaften enden bei der Übernahme am Tag vor dem Beginn der neuen, laufende Trainingsverträge bleiben,
 * Nummer und Mandat bleiben. Dazu: Zahler ohne Mitgliedschaft wird Mitglied (Mandat bleibt), Anzeige des Bestands im Angebot,
 * Hinweis auf eine Dublette (Person wird neu aufgenommen, ist unter anderem Stammsatz aber schon Mitglied).
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
const { addTage, heute } = await import('../../modules/tco/server/format.js');
const { beginnFuer } = await import('../../modules/tco/server/antrag/logik.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}
const M = '/api/m/tco/mitgliedsantraege';
const A = `${M}/angebote`;
const token = (link: string) => new URL(link).searchParams.get('angebot')!;
// Familie 1: alle sind Mitglied – Dora (Familienbeitrag, zahlt für Lia), Theo (Aktiv), Lia (Jugendliche + 2 × Jugendtraining)
const DORA = '0000009801', THEO = '0000009802', LIA = '0000009803';
// Familie 2: Zoe ist nur Zahlerin (kein Mitglied, aktives Mandat), Kim ist Mitglied und zahlt über Zoe
const ZOE = '0000009811', KIM = '0000009812';
// Dublette: Dora noch einmal ohne Mitgliedschaft (z. B. aus einer Schnupper-Anmeldung)
const DORA2 = '0000009821';
const vertraege = (adrnr: string) => sql`select vertragnr, art, vertragbegin::text as beginn, vertragende::text as ende, betrag::float as betrag, zahler_adrnr as zahler
                                           from tco.vertraege where adrnr = ${adrnr} order by vertragnr::int`;

/** Angebot erstellen, mit dem Geburtsdatum öffnen, als Antrag bestätigen und übernehmen – wie Vorstand und Familie es tun */
async function durchlauf(personen: Record<string, unknown>[], geburtsdatum: string) {
  let r = await call('POST', A, { personen, eintritt: heute(), mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const angebot = token(r.body.link);
  const id = ((await call('GET', `${A}?alle=1`)).body.liste as { id: number; nummer: string }[]).find((x) => x.nummer === r.body.nummer)!.id;
  const ansicht = (await call('GET', `${A}/${id}`)).body;
  assert.equal((await call('POST', '/api/m/tco/antrag/angebot', { token: angebot })).body.geburtsdatumNoetig, true);
  r = await call('POST', '/api/m/tco/antrag/angebot', { token: angebot, geburtsdatum });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.daten;
  r = await call('POST', '/api/m/tco/antrag', {
    personen: d.personen.map((p: Record<string, unknown>, i: number) => ({
      anrede: p.anrede, vorname: p.vorname, nachname: p.nachname, geburtsdatum: p.geburtsdatum, art: i === 0 ? p.art : null, training: p.training,
    })),
    strasse: d.strasse, plz: d.plz, ort: d.ort, email: d.email, eintritt: d.eintritt,
    satzung: true, datenschutz: true, kuendigung: true, bank: { sepa: true, ausAngebot: true }, angebot,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const antrag = ((await call('GET', M)).body as { id: number; nummer: string }[]).find((x) => x.nummer === r.body.nummer)!;
  r = await call('POST', `${M}/${antrag.id}/uebernehmen`, { mail: false, unterlagen: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ansicht, offen: d, ergebnis: r.body as { text: string; hinweise: string[]; mitglieder: { adrnr: string; bestand?: boolean }[] } };
}

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  assert.equal((await call('PUT', '/api/settings', { 'portal.url': 'https://portal.example.org' })).status, 200);
  await sql`insert into tco.beitrag (art, bezeichnung, turnus) values ('2', 'Mitgliedsbeitrag Aktiv', 'halbjährl.'), ('3', 'Mitgliedsbeitrag Jugendliche', 'halbjährl.'),
            ('8', 'Mitgliedsbeitrag Familien', 'halbjährl.'), ('90', 'Jugendtraining TCO', 'monatlich')`;
  await sql`insert into tco.beitrag_pr (art, gueltig_ab, betrag) values ('2', '2000-01-01', 75), ('3', '2000-01-01', 30), ('8', '2000-01-01', 125), ('90', '2000-01-01', 28.5)`;
  await sql`insert into tco.mitglieder (adrnr, mitglnrn, anrede, vorname, nachname, geburtsdatum, email, strasse, plz, ort, eintritt, iban1, mandatsrefenz, einzuglastmandliegtvor, adrnrkih) values
            (${DORA}, '9801', 'Frau', 'Dora', 'Umsteller', '1984-02-03', 'dora.umsteller@example.org', 'Wechselweg 2', '66649', 'Oberthal', '2020-01-01', 'DE89370400440532013000', '98011', 'J', null),
            (${THEO}, '9802', 'Herr', 'Theo', 'Umsteller', '1982-07-19', null, 'Wechselweg 2', '66649', 'Oberthal', '2020-01-01', null, null, null, null),
            (${LIA}, '9803', 'Frau', 'Lia', 'Umsteller', '2010-03-24', null, 'Wechselweg 2', '66649', 'Oberthal', '2020-01-01', null, null, null, ${DORA}),
            (${ZOE}, null, 'Frau', 'Zoe', 'Zahlerin', '1980-01-01', 'zoe.zahlerin@example.org', 'Zahlweg 3', '66649', 'Oberthal', null, 'DE02120300000000202051', '98111', 'J', null),
            (${KIM}, '9812', 'Herr', 'Kim', 'Zahlerin', '2011-05-05', null, 'Zahlweg 3', '66649', 'Oberthal', '2021-01-01', null, null, null, ${ZOE}),
            (${DORA2}, null, 'Frau', 'Dora', 'Umsteller', null, 'dora.umsteller@example.org', 'Wechselweg 2', '66649', 'Oberthal', null, null, null, null, null)`;
  await sql`insert into tco.sepa (adrnr, mandatsnr, mandkey, lastschriftart, typ, status, angelegtam) values
            (${DORA}, '980111', '98011', 'Basis', 'W', 'X', '2020-01-01'), (${ZOE}, '981111', '98111', 'Basis', 'W', 'X', '2021-01-01')`;
  await sql`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, betrag, zahler_adrnr) values
            (${DORA}, '1', '8', 'Mitgliedsbeitrag Familien', '9801', 'halbjährl.', '2020-01-01', 125, null),
            (${THEO}, '1', '2', 'Mitgliedsbeitrag Aktiv', '9802', 'halbjährl.', '2020-01-01', 75, null),
            (${LIA}, '1', '3', 'Mitgliedsbeitrag Jugendliche', '9803', 'halbjährl.', '2020-01-01', 30, ${DORA}),
            (${LIA}, '2', '90', 'Jugendtraining TCO', '9803', 'monatlich', '2022-05-01', 28.5, ${DORA}),
            (${LIA}, '3', '90', 'Jugendtraining TCO', '9803', 'monatlich', '2023-05-01', 28.5, ${DORA}),
            (${KIM}, '1', '3', 'Mitgliedsbeitrag Jugendliche', '9812', 'halbjährl.', '2021-01-01', 30, ${ZOE})`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Dublette: Person wird neu aufgenommen, ist unter anderem Stammsatz aber schon Mitglied – Hinweis in der Ansicht', async () => {
  let r = await call('POST', A, { personen: [{ adrnr: DORA2, art: '8', training: [], geburtsdatum: '1984-02-03' }, { adrnr: THEO, training: [] }], eintritt: heute(), mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = ((await call('GET', `${A}?alle=1`)).body.liste as { id: number }[])[0].id;
  r = await call('GET', `${A}/${id}`);
  assert.equal(r.body.hinweise.length, 1);
  assert.match(r.body.hinweise[0], /Dora Umsteller wird hier neu aufgenommen \(Stamm 0000009821\), ist aber bereits aktives Mitglied Nr\. 9801 \(Stamm 0000009801\)/);
  assert.equal(r.body.personen[0].bestand, null);
  // Korrektur auf das bestehende Mitglied: kein Hinweis mehr, die Umstellung ist ausgewiesen
  r = await call('PUT', `${A}/${id}`, { personen: [{ adrnr: DORA, art: '8', training: [] }, { adrnr: THEO, training: [] }], eintritt: heute(), mail: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${A}/${id}`);
  assert.deepEqual(r.body.hinweise, []);
  assert.deepEqual(r.body.personen.map((p: { bestand: unknown }) => p.bestand), [{ laufend: ['8'], endet: [] }, { laufend: ['2'], endet: ['Mitgliedsbeitrag Aktiv'] }]);
  assert.equal((await call('POST', `${A}/${id}/zurueckziehen`, {})).status, 200);
});

test('Umstellung auf den Familienbeitrag: bisherige Mitgliedschaften enden, Training und Nummern bleiben', async () => {
  const beginn = beginnFuer(heute(), 'MITGLIEDSCHAFT');
  const bis = addTage(beginn, -1);
  const { ansicht, offen, ergebnis } = await durchlauf([{ adrnr: DORA, art: '8', training: [] }, { adrnr: THEO, training: [] }, { adrnr: LIA, training: ['90', '90'] }], '1984-02-03');

  // Ansicht (Vorstand) und Formular (Familie) weisen aus, was läuft und was endet
  assert.deepEqual(ansicht.personen[2].bestand, { laufend: ['3', '90', '90'], endet: ['Mitgliedsbeitrag Jugendliche'] });
  assert.deepEqual(offen.personen.map((p: { bestand: { endet: string[] } }) => p.bestand.endet), [[], ['Mitgliedsbeitrag Aktiv'], ['Mitgliedsbeitrag Jugendliche']]);
  assert.equal(offen.personen[0].adrnr, undefined, 'keine Adressnummern nach außen');

  assert.ok(ergebnis.mitglieder.every((m) => m.bestand), 'niemand wird neu angelegt');
  assert.match(ergebnis.text, new RegExp(`Theo Umsteller: bisherige Mitgliedschaft „Mitgliedsbeitrag Aktiv“ \\(Vertrag 1\\) endet am ${bis.split('-').reverse().join('\\.')} – Umstellung auf den Familienbeitrag`));
  assert.match(ergebnis.text, /Lia Umsteller: Jugendtraining TCO \(Vertrag 2\) läuft bereits – unverändert/);

  assert.deepEqual((await vertraege(DORA)).map((v) => [v.art, v.ende]), [['8', null]], 'Antragstellerin: Familienbeitrag läuft – unverändert');
  assert.deepEqual((await vertraege(THEO)).map((v) => [v.art, v.beginn, v.ende, v.betrag]), [['2', '2020-01-01', bis, 75], ['8', beginn, null, 0]]);
  assert.deepEqual((await vertraege(LIA)).map((v) => [v.art, v.beginn, v.ende, v.betrag, v.zahler]), [
    ['3', '2020-01-01', bis, 30, DORA], ['90', '2022-05-01', null, 28.5, DORA], ['90', '2023-05-01', null, 28.5, DORA], ['8', beginn, null, 0, DORA],
  ]);
  const m = await sql`select adrnr, mitglnrn, austritt, eintritt::text as eintritt from tco.mitglieder where adrnr in (${DORA}, ${THEO}, ${LIA}) order by adrnr`;
  assert.deepEqual(m.map((x) => [x.mitglnrn, x.austritt, x.eintritt]), [['9801', null, '2020-01-01'], ['9802', null, '2020-01-01'], ['9803', null, '2020-01-01']]);
});

test('Zahlerin ohne Mitgliedschaft wird Mitglied: Mandat und Mandatsreferenz bleiben, das Kind wechselt in den Familienbeitrag', async () => {
  const beginn = beginnFuer(heute(), 'MITGLIEDSCHAFT');
  const bis = addTage(beginn, -1);
  const { ansicht, ergebnis } = await durchlauf([{ adrnr: ZOE, art: '8', training: [] }, { adrnr: KIM, training: [] }], '1980-01-01');
  assert.deepEqual(ansicht.personen.map((p: { bestand: unknown }) => p.bestand), [null, { laufend: ['3'], endet: ['Mitgliedsbeitrag Jugendliche'] }]);
  assert.deepEqual(ergebnis.mitglieder.map((x) => [x.adrnr, !!x.bestand]), [[ZOE, false], [KIM, true]]);

  const [zoe] = await sql`select mitglnrn, eintritt::text as eintritt, mandatsrefenz, iban1 from tco.mitglieder where adrnr = ${ZOE}`;
  assert.ok(zoe.mitglnrn, 'Mitgliedsnummer vergeben');
  assert.equal(zoe.eintritt, heute());
  assert.equal(zoe.mandatsrefenz, '98111', 'Mandatsreferenz der Zahlerin bleibt');
  assert.equal(zoe.iban1, 'DE02120300000000202051');
  const [s] = await sql`select mandatsnr, status from tco.sepa where adrnr = ${ZOE}`;
  assert.deepEqual([s.mandatsnr, s.status], ['981111', 'X'], 'aktives Mandat wird weiterverwendet');
  assert.deepEqual((await vertraege(ZOE)).map((v) => [v.art, v.beginn, v.betrag]), [['8', beginn, 125]]);
  assert.deepEqual((await vertraege(KIM)).map((v) => [v.art, v.ende, v.betrag, v.zahler]), [['3', bis, 30, ZOE], ['8', null, 0, ZOE]]);
});
