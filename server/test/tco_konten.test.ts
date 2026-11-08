/**
 * Integrationstest Finanzen-Stamm: Kontenstamm (Konten, Kontenverwendung je Jahr, Vorschlag,
 * Jahresanfangsbestände) und Einnahmen & Ausgaben (Monate, Jahre, Konten, Geldkonten, Liquidität, Verlauf).
 * Voraussetzung: kontenRoutes/finanzRoutes sind in modules/tco/server/index.ts registriert.
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
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
  };
}
const call = client();
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const K = '/api/m/tco/konten';
const F = '/api/m/tco/finanz';
const JAHR = new Date().getFullYear();

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => {
  await app?.close();
  await sql.end();
});

test('Kontenstamm: Übersicht, Speichern, Vorschlag, Anfangsbestände', async () => {
  const konten = 'KONTO;NAME;KENNZAHL\n1200;Girokonto Bank 1 Saar;BA\n1000;Kasse;BA\n654;Darlehen;BK\n2300;Versicherungen;\n8003;Hallenmiete;\n8100;Spenden;\n8200;Bestand Getränke;BA\n';
  const bankab = `JAHR;KONTO;ANFANGSBESTAND;ENDBESTAND\n${JAHR};1200;1.000,00;\n${JAHR};1000;50,00;\n`;
  let r = await call('POST', '/api/m/tco/import/ausfuehren', { modus: 'neu', dateien: [
    { name: 'ZTCO_FIKONTEN.CSV', data: b64(konten) }, { name: 'ZTCO_FIBANKAB.CSV', data: b64(bankab) },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Buchungen: Versicherung Okt/Nov (Ausgabe 2 × 120), Hallenmiete Nov (Einnahme 80), Darlehenstilgung Nov (kein Ergebnis)
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, belnr, gkonto, soll, haben) values
    ('0000000100', '1200', 0, ${JAHR}, 10, ${`${JAHR}-10-05`}, 'Allianz Versicherung', 120, '55', '2300', 0, 120),
    ('0000000100', '2300', 0, ${JAHR}, 10, ${`${JAHR}-10-05`}, 'Allianz Versicherung', 120, '55', '1200', 120, 0),
    ('0000000101', '1200', 0, ${JAHR}, 11, ${`${JAHR}-11-02`}, 'Allianz Versicherung', 120, '56', '2300', 0, 120),
    ('0000000101', '2300', 0, ${JAHR}, 11, ${`${JAHR}-11-02`}, 'Allianz Versicherung', 120, '56', '1200', 120, 0),
    ('0000000102', '1200', 0, ${JAHR}, 11, ${`${JAHR}-11-03`}, 'Hallenmiete Muster', 80, '57', '8003', 80, 0),
    ('0000000102', '8003', 0, ${JAHR}, 11, ${`${JAHR}-11-03`}, 'Hallenmiete Muster', 80, '57', '1200', 0, 80),
    ('0000000103', '1200', 0, ${JAHR}, 11, ${`${JAHR}-11-10`}, 'Tilgung Darlehen', 200, '58', '654', 0, 200),
    ('0000000103', '654', 0, ${JAHR}, 11, ${`${JAHR}-11-10`}, 'Tilgung Darlehen', 200, '58', '1200', 200, 0)`;

  // ---- Übersicht: Fenster 4 Vorjahre, aktuelles Jahr, Folgejahr
  r = await call('GET', `${K}/uebersicht`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.von, JAHR - 4);
  assert.equal(r.body.bis, JAHR + 1);
  assert.equal(r.body.zeilen.length, 7);
  assert.deepEqual(r.body.zeilen.map((z: any) => z.konto), ['654', '1000', '1200', '2300', '8003', '8100', '8200'], 'numerisch sortiert');
  const k1200 = r.body.zeilen.find((z: any) => z.konto === '1200');
  assert.equal(k1200.jahre.length, 6);
  assert.equal(k1200.gruppe, '1 · Bank-, Kassen- und Kreditkonten');
  assert.equal(k1200.letzte, `${JAHR}-11-10`);
  const j = k1200.jahre.find((x: any) => x.jahr === JAHR);
  assert.deepEqual([j.aktiv, j.anz, j.saldo], [true, 4, -360]);
  assert.equal(r.body.zeilen.find((z: any) => z.konto === '8100').bebucht, false);
  assert.equal(r.body.zeilen.find((z: any) => z.konto === '2300').gruppe, '2 · Aufwandskonten');

  // ---- Blättern
  r = await call('GET', `${K}/uebersicht?von=${JAHR - 5}`);
  assert.equal(r.body.bis, JAHR);

  // ---- Speichern: neues Konto, Bezeichnung ändern, Verwendung abwählen
  r = await call('POST', `${K}/speichern`, { zeilen: [
    { konto: '4100', name: 'Porto', kennzahl: '', profitcenter: 'Vereinsbetrieb', neu: true, jahre: [{ jahr: JAHR, aktiv: true }] },
    { konto: '2300', name: 'Versicherungen Verein', kennzahl: '', profitcenter: '', neu: false, jahre: [{ jahr: JAHR, aktiv: true }] },
    { konto: '8100', name: 'Spenden', kennzahl: '', profitcenter: '', neu: false, jahre: [{ jahr: JAHR, aktiv: false }, { jahr: JAHR + 1, aktiv: false }] },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.aenderungen, r.body.neu], [3, 1]);
  assert.match(r.body.text, /^Gespeichert: 3 Änderung/);
  const [kj] = await sql`select aktiv, geaendert_von from tco.fikontojahr where konto = '8100' and jahr = ${JAHR}`;
  assert.deepEqual([kj.aktiv, kj.geaendert_von], [false, 'admin']);
  assert.equal((await sql`select count(*)::int as n from tco.fikontojahr`)[0].n, 2, 'nur Abweichungen vom Standard „aktiv“ werden gespeichert');
  r = await call('GET', `${K}/uebersicht`);
  const k8100 = r.body.zeilen.find((z: any) => z.konto === '8100');
  assert.equal(k8100.aktAktiv, false);
  assert.equal(k8100.jahre.find((x: any) => x.jahr === JAHR).aktiv, false);
  assert.equal(r.body.zeilen.find((z: any) => z.konto === '4100').profitcenter, 'Vereinsbetrieb');
  // Wirkung in FI Belege: abgewähltes Konto ist im Jahr inaktiv
  r = await call('GET', `/api/m/tco/fi/init?jahr=${JAHR}`);
  assert.equal(r.body.konten.find((k: any) => k.konto === '8100').aktiv, false);
  assert.equal(r.body.konten.find((k: any) => k.konto === '4100').aktiv, true);

  // ---- Fehler: doppelt, ungültige Nummer, unbekanntes Profit-Center – nichts wird geschrieben
  r = await call('POST', `${K}/speichern`, { zeilen: [{ konto: '2300', name: 'X', kennzahl: '', profitcenter: '', neu: true, jahre: [] }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bereits vorhanden/);
  r = await call('POST', `${K}/speichern`, { zeilen: [{ konto: '12345', name: 'X', kennzahl: '', profitcenter: '', neu: true, jahre: [] }] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /bis zu 4 Ziffern/);
  r = await call('POST', `${K}/speichern`, { zeilen: [
    { konto: '4200', name: 'Neu', kennzahl: '', profitcenter: '', neu: true, jahre: [] },
    { konto: '2300', name: 'Versicherungen Verein', kennzahl: '', profitcenter: 'Weltall', neu: false, jahre: [] },
  ] });
  assert.equal(r.status, 400);
  assert.equal((await sql`select count(*)::int as n from tco.fikonten where konto = '4200'`)[0].n, 0, 'Transaktion zurückgerollt');

  // ---- Vorschlag: Geldkonten bleiben, bebuchte Konten bleiben, Rest abgewählt
  r = await call('GET', `${K}/vorschlag?jahr=${JAHR + 1}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.aktiv['1200'], true, 'Bankkonto');
  assert.equal(r.body.aktiv['2300'], true, 'im Vorjahr bebucht');
  assert.equal(r.body.aktiv['8100'], false);
  assert.equal(r.body.aktiv['8200'], true, 'Kennzahl BA');
  assert.equal(r.body.abgewaehlt, 2);
  assert.match(r.body.text, new RegExp(`Vorschlag ${JAHR + 1}: 2 Konten`));

  // ---- Jahresanfangsbestände der Geldkonten
  r = await call('GET', `${K}/bestaende?jahr=${JAHR}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen.map((z: any) => z.konto), ['654', '1000', '1200', '8200']);
  const b1200 = r.body.zeilen.find((z: any) => z.konto === '1200');
  assert.deepEqual([b1200.anfangsbestand, b1200.endbestand, b1200.rechnerisch, b1200.kontostand, b1200.differenz], [1000, null, 1000, 640, null]);
  const b654 = r.body.zeilen.find((z: any) => z.konto === '654');
  assert.deepEqual([b654.anfangsbestand, b654.rechnerisch, b654.kontostand], [null, 0, 200]);
  r = await call('PUT', `${K}/bestand`, { jahr: JAHR, konto: '654', anfangsbestand: -5000, endbestand: -4800 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${K}/bestaende?jahr=${JAHR}`);
  const b654b = r.body.zeilen.find((z: any) => z.konto === '654');
  assert.deepEqual([b654b.anfangsbestand, b654b.endbestand, b654b.kontostand, b654b.differenz], [-5000, -4800, -4800, 0]);
  r = await call('PUT', `${K}/bestand`, { jahr: JAHR, konto: '2300', anfangsbestand: 1 });
  assert.equal(r.status, 400, 'kein Geldkonto');
  r = await call('PUT', `${K}/bestand`, { jahr: JAHR, konto: '654', anfangsbestand: null, endbestand: null });
  assert.match(r.body.text, /entfernt/);
  assert.equal((await sql`select count(*)::int as n from tco.fibankab where konto = '654'`)[0].n, 0);
});

test('Einnahmen & Ausgaben: Übersicht, Geldkonten, Konten, Liquidität, Verlauf', async () => {
  let r = await call('GET', `${F}/jahre`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.jahre.includes(JAHR));
  assert.deepEqual(r.body.geldkonten.map((k: any) => k.konto), ['1000', '1200'], 'nur 1000–1299, nicht 654 oder 8200');

  r = await call('GET', `${F}/uebersicht?jahr=${JAHR}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = r.body.ergebnis;
  assert.deepEqual([e.einnahmen, e.ausgaben, e.gewinn], [80, 240, -160]);
  // Geldkonten: 1200 AB 1000 +80 −440 = 640, Kasse 1000 AB 50 ohne Bewegung → 690; Tilgung ist keine Ausgabe → Differenz −200
  assert.deepEqual([e.geld_ab, e.geld_eb, e.geld_delta, e.differenz], [1050, 690, -360, -200]);
  assert.equal(e.letzte_bu, `${JAHR}-11-10`);
  assert.equal(r.body.info, null);

  assert.equal(r.body.monate.length, 12);
  const okt = r.body.monate[9], nov = r.body.monate[10], dez = r.body.monate[11];
  assert.deepEqual([okt.einnahmen, okt.ausgaben, okt.ergebnis, okt.kumuliert], [0, 120, -120, -120]);
  assert.deepEqual([nov.einnahmen, nov.ausgaben, nov.ergebnis, nov.kumuliert], [80, 120, -40, -160]);
  assert.deepEqual([dez.ergebnis, dez.kumuliert], [0, -160]);

  const g = r.body.geldkonten;
  assert.deepEqual(g.map((x: any) => x.konto), ['1000', '1200']);
  assert.deepEqual(g[1], { konto: '1200', name: 'Girokonto Bank 1 Saar', anfangsbestand: 1000, zugang: 80, abgang: 440, endbestand: 640 });

  assert.equal(r.body.jahre.length, 5);
  assert.equal(r.body.jahre[0].jahr, JAHR, 'absteigend');
  assert.deepEqual([r.body.jahre[0].ergebnis, r.body.jahre[0].geld_eb], [-160, 690]);
  assert.deepEqual([r.body.jahre[4].jahr, r.body.jahre[4].einnahmen], [JAHR - 4, 0]);

  assert.deepEqual(r.body.einnahmen, [{ art: 'E', konto: '8003', name: 'Hallenmiete', wert: 80, wert_vj: 0 }]);
  assert.deepEqual(r.body.ausgaben, [{ art: 'A', konto: '2300', name: 'Versicherungen Verein', wert: 240, wert_vj: 0 }]);

  // Liquidität: Geld 690 + Forderungen 0 + Kredit 654 (Saldo +200 nach Tilgung, kein AB) = 890
  const l = r.body.liquiditaet;
  assert.deepEqual([l.geld, l.forderung, l.kredit, l.liquiditaet], [690, 0, 200, 890]);
  assert.equal(l.monat, new Date().getMonth() + 1);

  // Forderungen Clubhaus fließen ein (jüngster Stand <= Monat)
  await sql`insert into tco.forderungen (jahr, monat, offene_posten) values (${JAHR - 1}, 12, 150), (${JAHR}, 1, 99)`;
  r = await call('GET', `${F}/uebersicht?jahr=${JAHR - 1}`);
  assert.deepEqual([r.body.liquiditaet.forderung, r.body.liquiditaet.ford_stand], [150, `12/${JAHR - 1}`]);
  assert.equal(r.body.info, `Für ${JAHR - 1} liegen keine Buchungen vor.`);
  r = await call('GET', `${F}/uebersicht?jahr=${JAHR}`);
  assert.deepEqual([r.body.liquiditaet.forderung, r.body.liquiditaet.ford_stand], [99, `01/${JAHR}`]);

  // ---- Monatsverlauf: Einnahmen/Ausgaben über das Gegenkonto, Kontostand zum Monatsende
  r = await call('GET', `${F}/verlauf?jahre=${JAHR - 1},${JAHR}&konten=1200`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.verlauf.length, 24);
  assert.equal(r.body.anfangsbestand, 0, 'Anfangsbestand des ersten Jahres: im Vorjahr weder Bestand noch Bewegung (wie SAP)');
  const v = r.body.verlauf.filter((x: any) => x.jahr === JAHR);
  assert.deepEqual([v[9].ausgaben, v[9].bestand], [120, 880]);
  assert.deepEqual([v[10].einnahmen, v[10].ausgaben, v[10].bestand], [80, 120, 640]);
  assert.equal(v[11].bestand, 640);
  assert.equal(v[11].zukunft, new Date().getMonth() + 1 < 12);
  // Kasse allein: keine Bewegung, Bestand bleibt 50
  r = await call('GET', `${F}/verlauf?jahre=${JAHR}&konten=1000`);
  assert.deepEqual([r.body.anfangsbestand, r.body.verlauf[11].bestand, r.body.verlauf[10].einnahmen], [50, 50, 0]);
  // alle Geldkonten
  r = await call('GET', `${F}/verlauf?jahre=${JAHR}`);
  assert.equal(r.body.verlauf[11].bestand, 690);
});

test('Berechtigungen: Anzeige ohne Pflege, kein Zugriff ohne Recht', async () => {
  assert.equal((await call('POST', '/api/admin/roles', { id: 'KONTEN_LESER', name: 'Konten lesen', permissions: ['tco.konten:display'] })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { username: 'leser', displayName: 'Lea Leser', password: 'start-passwort', roles: ['KONTEN_LESER'] })).status, 200);
  const leser = client();
  assert.equal((await leser('POST', '/api/auth/login', { username: 'leser', password: 'start-passwort' })).status, 200);
  assert.equal((await leser('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  assert.equal((await leser('GET', `${K}/uebersicht`)).status, 200);
  assert.equal((await leser('GET', `${K}/bestaende?jahr=${JAHR}`)).status, 200);
  assert.equal((await leser('POST', `${K}/speichern`, { zeilen: [] })).status, 403);
  assert.equal((await leser('PUT', `${K}/bestand`, { jahr: JAHR, konto: '1200', anfangsbestand: 1 })).status, 403);
  assert.equal((await leser('GET', `${F}/uebersicht?jahr=${JAHR}`)).status, 403);
  assert.equal((await leser('GET', `${F}/verlauf?jahre=${JAHR}`)).status, 403);
});
