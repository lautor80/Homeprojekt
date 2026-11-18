/**
 * Haushaltsplan – Projekte: Verteilung über die Zeit (reine Funktionen), Planung und Genehmigung, Simulation im Plan
 * (ohne/mit, Beitrag je Projekt, mehrjährig, beim Beschluss festgeschrieben), Soll-Ist je Projekt aus den FI-Buchungen
 * mit der Projektnummer – ohne Doppelzählung im Konto und ohne Wirkung auf die Grundlage künftiger Vorschläge.
 *
 * Eigene Testdaten: Konten mit der Endung 71, Geschäftsjahre 2071–2079, Projektnummern P71/P72.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { budget, einrechnenVorgabe, laufzeit, positionMonate, UEBERGAENGE, wirktIm, wirkung, type ProjektPosition } from '../../modules/tco/server/haushalt/projekt.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql, withChange } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { jahreswerteLesen } = await import('../../modules/tco/server/abschluss/logik.js');
const hh = await import('../../modules/tco/server/haushalt/logik.js');
const pr = await import('../../modules/tco/server/haushalt/projekte.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const db = sql as any;
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
const H = '/api/m/tco/haushalt';
const tx = <T>(fn: (t: any) => Promise<T>) => withChange({ userId: null, username: 'test' }, fn as any) as Promise<T>;
const nah = (a: number, b: number, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const sum = (a: number[]) => Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100;

let nr = 0;
async function buche(konto: string, datum: string, betrag: number, einnahme: boolean, projekt: string | null = null) {
  const n = `7${String(++nr).padStart(9, '0')}`, j = Number(datum.slice(0, 4)), m = Number(datum.slice(5, 7));
  await sql`insert into tco.fibuchungen (internenr, konto, posnr, jahr, monat, datum, text, betrag, soll, haben, gkonto, projekt)
            values (${n}, ${konto}, 0, ${j}, ${m}, ${datum}, 'Projekttest', ${betrag}, ${einnahme ? 0 : betrag}, ${einnahme ? betrag : 0}, '1271', ${projekt}),
                   (${n}, '1271', 1, ${j}, ${m}, ${datum}, 'Projekttest', ${betrag}, ${einnahme ? betrag : 0}, ${einnahme ? 0 : betrag}, ${konto}, ${projekt})`;
}

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('1271', 'Testbank', 'BA'), ('8171', 'Zuschüsse Test', 'A1'), ('4571', 'Instandhaltung Halle Test', 'C2'), ('4171', 'Energie Test', 'C2')`;
  await sql`insert into tco.fibankab (jahr, konto, anfangsbestand) values (2071, '1271', 20000)`;
  await sql`insert into tco.projekte (projektnr, jahr) values ('P71', 2077)`;
  // laufender Betrieb 2071–2076 (2076 bis Oktober): Zuschuss 3.000 im Mai, Instandhaltung 200 und Energie 500 je Monat
  for (let j = 2071; j <= 2076; j++) {
    for (let m = 1; m <= (j === 2076 ? 10 : 12); m++) {
      const d = `${j}-${String(m).padStart(2, '0')}-10`;
      if (m === 5) await buche('8171', d, 3000, true);
      await buche('4571', d, 200, false);
      await buche('4171', d, 500, false);
    }
  }
});
after(async () => {
  await app?.close();
  await sql.end();
});

// ---------------------------------------------------------------------------
// Rechenkern
// ---------------------------------------------------------------------------

const Z = { beginn: '2077-03', ende: '2077-06' };
const LED: ProjektPosition[] = [
  { art: 'KOSTEN', betrag: 18000, verteilung: 'GLEICH', konto: '4571' },
  { art: 'ZUSCHUSS', betrag: 6000, verteilung: 'MONAT', von: '2077-08', konto: '8171' },
  { art: 'DARLEHEN', betrag: 8000, verteilung: 'MONAT', von: '2077-03' },
  { art: 'TILGUNG', betrag: 8000, verteilung: 'GLEICH', von: '2077-07', bis: '2078-10' },
  { art: 'EIGENMITTEL', betrag: 4000, verteilung: 'GLEICH' },
  { art: 'EINSPARUNG', betrag: 1200, verteilung: 'JAEHRLICH', konto: '4171' },
];

test('Verteilung einer Position: gleichmäßig, in einem Monat, von Hand, jährlich wiederkehrend – auch über den Jahreswechsel', () => {
  assert.equal(laufzeit('2077-03', '2077-06'), 4);
  assert.equal(laufzeit('2077-10', '2078-03'), 6);
  assert.equal(laufzeit('2077-05', '2077-05'), 1);
  // gleichmäßig über die Laufzeit
  assert.deepEqual(positionMonate(LED[0], Z, 2077), [0, 0, 4500, 4500, 4500, 4500, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(positionMonate(LED[0], Z, 2078), Array(12).fill(0));
  // Rest im letzten Monat: 1.000 über drei Monate
  const drittel = positionMonate({ art: 'KOSTEN', betrag: 1000, verteilung: 'GLEICH' }, { beginn: '2077-01', ende: '2077-03' }, 2077);
  assert.deepEqual(drittel.slice(0, 3), [333.33, 333.33, 333.34]);
  // an einem Monat (eigener Zeitpunkt, auch nach dem Projektende)
  assert.equal(positionMonate(LED[1], Z, 2077)[7], 6000);
  assert.equal(sum(positionMonate(LED[1], Z, 2078)), 0);
  // über den Jahreswechsel: die Summe aller Jahre ist der Betrag
  const mehr = { beginn: '2077-10', ende: '2078-03' }, k = { art: 'KOSTEN' as const, betrag: 12000, verteilung: 'GLEICH' as const };
  assert.deepEqual([sum(positionMonate(k, mehr, 2077)), sum(positionMonate(k, mehr, 2078)), sum(positionMonate(k, mehr, 2079))], [6000, 6000, 0]);
  assert.deepEqual(positionMonate(k, mehr, 2078).slice(0, 4), [2000, 2000, 2000, 0]);
  // eigener Zeitraum der Position: Tilgung 16 Monate zu 500
  assert.deepEqual([sum(positionMonate(LED[3], Z, 2077)), sum(positionMonate(LED[3], Z, 2078)), positionMonate(LED[3], Z, 2078)[9], positionMonate(LED[3], Z, 2078)[10]], [3000, 5000, 500, 0]);
  // von Hand je Monat
  const hand: ProjektPosition = { art: 'KOSTEN', betrag: 0, verteilung: 'HAND', monate: { '2077-04': 700, '2078-01': 300, '2077-12': 50 } };
  assert.deepEqual([positionMonate(hand, Z, 2077)[3], positionMonate(hand, Z, 2077)[11], positionMonate(hand, Z, 2078)[0]], [700, 50, 300]);
  // jährlich wiederkehrend: ohne „von“ ab dem Monat nach dem Projektende, unbefristet; volles Jahr = Jahresbetrag
  assert.deepEqual(positionMonate(LED[5], Z, 2077), [0, 0, 0, 0, 0, 0, 100, 100, 100, 100, 100, 100]);
  assert.equal(sum(positionMonate(LED[5], Z, 2078)), 1200);
  assert.equal(sum(positionMonate(LED[5], Z, 2090)), 1200);
  assert.equal(sum(positionMonate({ ...LED[5], betrag: 1000 }, Z, 2078)), 1000);                 // 83,33 × 11 + Rest
  assert.equal(sum(positionMonate({ ...LED[5], bis: '2078-06' }, Z, 2078)), 600);
  assert.equal(sum(positionMonate(LED[5], Z, 2076)), 0);
  // Laufzeit „rückwärts“ oder Betrag 0 führt zu keiner Division durch 0
  assert.equal(sum(positionMonate({ art: 'KOSTEN', betrag: 500, verteilung: 'GLEICH', von: '2077-05', bis: '2077-02' }, Z, 2077)), 500);
  assert.equal(sum(positionMonate({ art: 'KOSTEN', betrag: 0, verteilung: 'GLEICH' }, Z, 2077)), 0);
});

test('Wirkung eines Projekts je Geschäftsjahr: Ergebnis ohne Darlehen, Liquidität mit Zufluss und Tilgung; Budget und Lücke', () => {
  const p = { ...Z, positionen: LED };
  const w = wirkung(p, 2077);
  assert.deepEqual(w.sum, { einnahmen: 6000, ausgaben: 17400, ergebnis: -11400, darlehen: 8000, tilgung: 3000, liquiditaet: -6400 });
  assert.equal(w.ausgaben[2], 4500);
  assert.equal(w.ausgaben[6], -100);                       // Einsparung mindert die Ausgaben
  assert.equal(w.darlehen[2], 8000);
  assert.deepEqual(w.konten.map((k) => [k.konto, k.art, sum(k.monate)]), [['4571', 'A', 18000], ['8171', 'E', 6000], ['4171', 'A', -600]]);
  // Folgejahr: nur noch Einsparung und Tilgung
  assert.deepEqual(wirkung(p, 2078).sum, { einnahmen: 0, ausgaben: -1200, ergebnis: 1200, darlehen: 0, tilgung: 5000, liquiditaet: -3800 });
  assert.equal(wirktIm(wirkung(p, 2076)), false);
  assert.equal(wirktIm(wirkung(p, 2085)), true);           // die Einsparung läuft weiter
  assert.equal(wirktIm(wirkung({ ...Z, positionen: [] }, 2077)), false);
  // Budget: Kosten 18.000 = Zuschuss 6.000 + Eigenmittel 4.000 + Darlehen 8.000
  assert.deepEqual(budget(LED), { kosten: 18000, finanzierung: 18000, zuschuss: 6000, spende: 0, eigenmittel: 4000, darlehen: 8000, luecke: 0, folge_jahr: -1200 });
  assert.equal(budget(LED.slice(0, 2)).luecke, 12000);
  assert.deepEqual(budget([]), { kosten: 0, finanzierung: 0, zuschuss: 0, spende: 0, eigenmittel: 0, darlehen: 0, luecke: 0, folge_jahr: 0 });
  // Vorgabe „einrechnen“ und Statusfolge
  assert.deepEqual(['IDEE', 'BEANTRAGT', 'GENEHMIGT', 'ABGELEHNT', 'ZURUECKGESTELLT', 'UMSETZUNG', 'ABGESCHLOSSEN'].map((s) => einrechnenVorgabe(s as never)), [false, false, true, false, false, true, true]);
  assert.deepEqual(UEBERGAENGE.BEANTRAGT, ['GENEHMIGT', 'ABGELEHNT', 'ZURUECKGESTELLT', 'IDEE']);
  assert.deepEqual(UEBERGAENGE.ABGESCHLOSSEN, []);
});

// ---------------------------------------------------------------------------
// Planung, Genehmigung, Simulation
// ---------------------------------------------------------------------------

const HEUTE = '2076-11-15';
let led = 0, platz = 0, plan = 0;
let planer: ReturnType<typeof client>, genehmiger: ReturnType<typeof client>;

test('Projekt planen und genehmigen: Statusfolge mit Begründung, eigenes Recht, Verlauf, Arbeitsvorrat', async () => {
  for (const [rolle, rechte] of [['HHP_PLANER', ['tco.haushalt:display', 'tco.haushalt:edit']], ['HHP_VORSTAND', ['tco.haushalt:display', 'tco.projekte:approve']]] as const) {
    assert.equal((await call('POST', '/api/admin/roles', { id: rolle, name: rolle, permissions: rechte })).status, 200);
  }
  const anmelden = async (name: string, rolle: string) => {
    assert.equal((await call('POST', '/api/admin/users', { username: name, displayName: name, password: 'start-passwort', roles: [rolle] })).status, 200);
    const c = client();
    assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
    assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
    return c;
  };
  planer = await anmelden('paula', 'HHP_PLANER');
  genehmiger = await anmelden('volker', 'HHP_VORSTAND');

  let r = await planer('POST', `${H}/projekte`, {
    projektnr: 'P71', bezeichnung: 'LED-Beleuchtung Halle', beschreibung: 'Umrüstung der Hallenbeleuchtung', verantwortlich: 'Hallenwart', beginn: Z.beginn, ende: Z.ende, bereich: 'C',
    positionen: LED.map((p) => ({ ...p, betrag: String(p.betrag) })),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  led = r.body.id;
  r = await planer('POST', `${H}/projekte`, { bezeichnung: 'Sanierung Platz 3', beginn: '2077-10', ende: '2078-03', positionen: [{ art: 'KOSTEN', betrag: 12000, verteilung: 'GLEICH', konto: '4571' }] });
  platz = r.body.id;
  // Prüfungen: Konto passt nicht zur Art, Ende vor Beginn, „jährlich“ nur für Folgekosten
  assert.equal((await planer('POST', `${H}/projekte`, { bezeichnung: 'X', beginn: '2077-05', ende: '2077-01', positionen: [] })).status, 400);
  r = await planer('POST', `${H}/projekte`, { bezeichnung: 'X', beginn: '2077-01', ende: '2077-02', positionen: [{ art: 'ZUSCHUSS', betrag: 1, verteilung: 'MONAT', konto: '4571' }] });
  assert.match(r.body.message, /kein Einnahmekonto/);
  r = await planer('POST', `${H}/projekte`, { bezeichnung: 'X', beginn: '2077-01', ende: '2077-02', positionen: [{ art: 'KOSTEN', betrag: 1, verteilung: 'JAEHRLICH' }] });
  assert.match(r.body.message, /nur für Folgekosten/);
  assert.equal((await genehmiger('POST', `${H}/projekte`, { bezeichnung: 'X', beginn: '2077-01', ende: '2077-02', positionen: [] })).status, 403);

  r = await planer('GET', `${H}/projekte`);
  assert.equal(r.status, 200);
  assert.equal(r.body.darfGenehmigen, false);
  assert.ok(r.body.projektnummern.includes('P71'));
  const p = r.body.projekte.find((x: any) => x.id === led);
  assert.deepEqual([p.status, p.beginn, p.ende, p.positionen.length, p.budget.kosten, p.budget.luecke, p.ist.kosten, p.uebergaenge], ['IDEE', '2077-03', '2077-06', 6, 18000, 0, 0, ['BEANTRAGT']]);

  // genehmigen geht erst nach dem Antrag – und nur mit dem Recht dazu
  assert.equal((await genehmiger('POST', `${H}/projekte/${led}/status`, { status: 'GENEHMIGT' })).status, 400);
  assert.equal((await genehmiger('POST', `${H}/projekte/${led}/status`, { status: 'BEANTRAGT' })).status, 403);
  assert.equal((await planer('POST', `${H}/projekte/${led}/status`, { status: 'BEANTRAGT' })).status, 200);
  r = await planer('POST', `${H}/projekte/${led}/status`, { status: 'GENEHMIGT' });
  assert.equal(r.status, 403);
  assert.match(r.body.message, /Projekte genehmigen/);
  // nach dem Antrag ändert der Antragsteller nichts mehr
  r = await planer('POST', `${H}/projekte`, { id: led, bezeichnung: 'LED teurer', beginn: Z.beginn, ende: Z.ende, positionen: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /beantragt/);

  // Antrag im Arbeitsvorrat der Genehmiger, nicht beim Antragsteller
  r = await genehmiger('GET', '/api/arbeitsvorrat');
  assert.equal(r.status, 200);
  assert.ok(JSON.stringify(r.body).includes(`HHPROJEKT:${led}`), JSON.stringify(r.body).slice(0, 300));
  assert.equal(JSON.stringify((await planer('GET', '/api/arbeitsvorrat')).body).includes('HHPROJEKT:'), false);
  const a = (await pr.projektAufgaben(db, { genehmiger: true, leser: true, ueberwachung: true }, { toleranz_gelb: 5, toleranz_rot: 10 }))[0];
  assert.deepEqual([a.key, a.bereich, a.pfad, a.betrag], [`HHPROJEKT:${led}`, 'Vorstand', '/tco/haushalt?tab=projekte', 18000]);

  // zurückstellen und ablehnen brauchen eine Begründung
  assert.equal((await genehmiger('POST', `${H}/projekte/${led}/status`, { status: 'ZURUECKGESTELLT' })).status, 400);
  assert.equal((await genehmiger('POST', `${H}/projekte/${led}/status`, { status: 'ZURUECKGESTELLT', grund: 'Angebot fehlt' })).status, 200);
  assert.equal((await planer('POST', `${H}/projekte/${led}/status`, { status: 'BEANTRAGT' })).status, 200);
  assert.equal((await genehmiger('POST', `${H}/projekte/${led}/status`, { status: 'GENEHMIGT', grund: 'Vorstandssitzung 12.11.' })).status, 200);
  const g = await pr.projektLesen(db, led);
  assert.deepEqual([g.status, g.status_text, g.status_von, g.status_grund], ['GENEHMIGT', 'vom Vorstand genehmigt', 'volker', 'Vorstandssitzung 12.11.']);
  assert.deepEqual(g.verlauf.map((v: any) => [v.status, v.von, v.grund]), [['IDEE', 'paula', null], ['BEANTRAGT', 'paula', null], ['ZURUECKGESTELLT', 'volker', 'Angebot fehlt'], ['BEANTRAGT', 'paula', null], ['GENEHMIGT', 'volker', 'Vorstandssitzung 12.11.']]);
  assert.equal(JSON.stringify((await genehmiger('GET', '/api/arbeitsvorrat')).body).includes('HHPROJEKT:'), false);
  // Änderungsbelege zum Projekt, die Entscheidung als Aktion
  const [b] = await sql`select count(*)::int as n from core.change_header where object_type = 'HH_PROJEKT' and action = 'HH_PROJEKT_GENEHMIGT' and reason = 'Vorstandssitzung 12.11.'`;
  assert.ok(b.n > 0);
  // löschen: nur Ideen und Abgelehntes
  assert.equal((await planer('POST', `${H}/projekte/${led}/loeschen`, { grund: 'x' })).status, 400);
  r = await planer('POST', `${H}/projekte`, { bezeichnung: 'Verworfen', beginn: '2077-01', ende: '2077-02', positionen: [] });
  assert.equal((await planer('POST', `${H}/projekte/${r.body.id}/status`, { status: 'BEANTRAGT' })).status, 400);       // ohne Kosten kein Antrag
  assert.equal((await planer('POST', `${H}/projekte/${r.body.id}/loeschen`, { grund: 'doch nicht' })).status, 200);
});

test('Simulation im Plan: einrechnen ja/nein, Ergebnis und tiefster Geldbestand ohne/mit, Beitrag je Projekt, mehrjährig', async () => {
  plan = await tx((t) => hh.planAnlegen(t, 2077, 'test', HEUTE));
  let s = await hh.planLesen(db, plan, HEUTE);
  // beide Projekte wirken 2077; Vorgabe: genehmigt ja, Idee nein
  assert.deepEqual(s.projekte.map((p) => [p.id, p.status, p.einrechnen, p.vorgabe, p.gewaehlt]), [[led, 'GENEHMIGT', true, true, false], [platz, 'IDEE', false, false, false]]);
  const ohne = s.summen.ohne;
  nah(ohne.einnahmen, s.positionen.filter((p) => p.art === 'E').reduce((a, p) => a + p.planwert, 0));
  // mit dem LED-Projekt: Einnahmen +6.000, Ausgaben +17.400 (Kosten − Einsparung), Ergebnis −11.400
  assert.deepEqual([s.summen.projekte_e, s.summen.projekte_a], [6000, 17400]);
  nah(s.summen.einnahmen, ohne.einnahmen + 6000);
  nah(s.summen.ausgaben, ohne.ausgaben + 17400);
  nah(s.summen.ergebnis, ohne.ergebnis - 11400);
  // Liquidität: Darlehen fließt im März zu, Tilgung ab Juli – nur hier, nicht im Ergebnis
  const mitLiq = s.liquiditaet;
  nah(mitLiq.monate[11].bestand, ohne.jahresende - 6400);
  const ledP = s.projekte[0];
  assert.deepEqual([ledP.beitrag.ergebnis, ledP.beitrag.jahresende], [-11400, -6400]);
  nah(ledP.beitrag.tiefster, mitLiq.tiefster - ohne.tiefster);
  assert.ok(mitLiq.tiefster < ohne.tiefster);
  // Monat März: +4.500 Ausgaben, +8.000 Zufluss; Juli: Tilgung +500
  const basis = await tx(async (t) => { await hh.projektEinrechnen(t, plan, led, false); const x = await hh.planLesen(t, plan, HEUTE); await hh.projektEinrechnen(t, plan, led, null); return x; });
  nah(mitLiq.monate[2].ausgaben, basis.liquiditaet.monate[2].ausgaben + 4500);
  nah(mitLiq.monate[2].einnahmen, basis.liquiditaet.monate[2].einnahmen + 8000);
  nah(mitLiq.monate[6].tilgung, basis.liquiditaet.monate[6].tilgung + 500);
  // ausgerechnet: mit = ohne; der Beitrag zeigt, was das Projekt bewirken würde
  assert.deepEqual([basis.summen.ergebnis, basis.liquiditaet.tiefster, basis.projekte[0].einrechnen, basis.projekte[0].gewaehlt], [ohne.ergebnis, ohne.tiefster, false, true]);
  assert.equal(basis.projekte[0].beitrag.ergebnis, -11400);

  // die Idee „Sanierung Platz 3“ probeweise einrechnen: anteilig 6.000 im Jahr 2077 (Okt–Dez)
  assert.equal((await planer('PUT', `${H}/plan/${plan}/projekt`, { projekt_id: platz, einrechnen: true })).status, 200);
  s = await hh.planLesen(db, plan, HEUTE);
  assert.deepEqual([s.summen.projekte_a, s.projekte[1].einrechnen, s.projekte[1].gewaehlt, s.projekte[1].wirkung.sum.ausgaben], [23400, true, true, 6000]);
  nah(s.summen.ergebnis, ohne.ergebnis - 17400);
  assert.equal((await planer('PUT', `${H}/plan/${plan}/projekt`, { projekt_id: platz, einrechnen: null })).status, 200);
  assert.equal((await planer('PUT', `${H}/plan/${plan}/projekt`, { projekt_id: 999999, einrechnen: true })).status, 404);

  // spätere Pläne: 2078 wirken Einsparung, Tilgung und der Rest der Platzsanierung; 2080 nur noch die Einsparung
  const p78 = await tx((t) => hh.planAnlegen(t, 2078, 'test', HEUTE));
  const s78 = await hh.planLesen(db, p78, HEUTE);
  assert.deepEqual(s78.projekte.map((p) => [p.id, p.wirkung.sum.ausgaben, p.wirkung.sum.tilgung, p.einrechnen]), [[led, -1200, 5000, true], [platz, 6000, 0, false]]);
  nah(s78.summen.ergebnis, s78.summen.ohne.ergebnis + 1200);
  const p80 = await tx((t) => hh.planAnlegen(t, 2080, 'test', HEUTE));
  assert.deepEqual((await hh.planLesen(db, p80, HEUTE)).projekte.map((p) => [p.id, p.wirkung.sum.ausgaben]), [[led, -1200]]);
  await tx((t) => hh.planLoeschen(t, p80));
  await tx((t) => hh.planLoeschen(t, p78));
});

test('Beschluss friert ein, welche Projekte mit welchen Werten eingerechnet waren; Nachtrag übernimmt die Auswahl', async () => {
  const vorher = await hh.planLesen(db, plan, HEUTE);
  await tx((t) => hh.statusSetzen(t, plan, 'BESCHLOSSEN', '2076-12-01', 'Vorstand', HEUTE));
  // das Projekt wird danach teurer und die Idee genehmigt – die beschlossene Fassung bleibt, wie sie war
  await tx((t) => pr.projektSichern(t, { id: led, projektnr: 'P71', bezeichnung: 'LED-Beleuchtung Halle (erweitert)', beginn: Z.beginn, ende: Z.ende, positionen: LED.map((p) => (p.art === 'KOSTEN' ? { ...p, betrag: 25000 } : p)) }, 'volker', true));
  await tx((t) => pr.projektStatus(t, platz, 'BEANTRAGT', null, 'paula', false));
  await tx((t) => pr.projektStatus(t, platz, 'GENEHMIGT', null, 'volker', true));
  const fest = await hh.planLesen(db, plan, '2077-02-01');
  assert.deepEqual(fest.projekte.map((p) => [p.id, p.bezeichnung, p.status, p.einrechnen, p.fest, p.wirkung.sum.ausgaben]),
    [[led, 'LED-Beleuchtung Halle', 'GENEHMIGT', true, true, 17400], [platz, 'Sanierung Platz 3', 'IDEE', false, true, 6000]]);
  assert.deepEqual([fest.summen.projekte_a, fest.summen.ergebnis, fest.summen.ohne.ergebnis], [17400, vorher.summen.ergebnis, vorher.summen.ohne.ergebnis]);
  // weder über die Anwendung noch an ihr vorbei änderbar; ein festgehaltenes Projekt lässt sich nicht löschen
  assert.equal((await planer('PUT', `${H}/plan/${plan}/projekt`, { projekt_id: platz, einrechnen: true })).status, 400);
  await assert.rejects(sql`update tco.hh_plan_projekt set einrechnen = false where plan_id = ${plan}`, /beschlossen/);
  await assert.rejects(sql`delete from tco.hh_plan_projekt where plan_id = ${plan}`, /beschlossen/);
  // Nachtrag: rechnet wieder mit dem heutigen Stand der Projekte, die Auswahl der Vorfassung bleibt gesetzt
  const n = await tx((t) => hh.nachtragAnlegen(t, plan, 'Projekt LED erweitert', 'Kassenwart', '2077-02-01'));
  const nach = await hh.planLesen(db, n, '2077-02-01');
  assert.deepEqual(nach.projekte.map((p) => [p.id, p.einrechnen, p.gewaehlt, p.fest, p.wirkung.sum.ausgaben]), [[led, true, true, false, 24400], [platz, false, true, false, 6000]]);
  await tx((t) => hh.planLoeschen(t, n));
  // zurück auf das genehmigte Budget für den Soll-Ist-Test
  await tx((t) => pr.projektSichern(t, { id: led, projektnr: 'P71', bezeichnung: 'LED-Beleuchtung Halle', beginn: Z.beginn, ende: Z.ende, positionen: LED }, 'volker', true));
  await assert.rejects(tx((t) => pr.projektSichern(t, { id: led, bezeichnung: 'X', beginn: Z.beginn, ende: Z.ende, positionen: [] }, 'paula', false)), /nur, wer Projekte genehmigen darf/);
});

test('Soll-Ist je Projekt aus FI; keine Doppelzählung im Konto, kein Einfluss auf künftige Vorschläge', async () => {
  // 2077: laufender Betrieb wie geplant, dazu das Projekt P71 mit 19.900 auf dem Instandhaltungskonto und 6.000 Zuschuss
  for (let m = 1; m <= 12; m++) {
    const d = `2077-${String(m).padStart(2, '0')}-10`;
    await buche('4571', d, 200, false);
    await buche('4171', d, 500, false);
    if (m === 5) await buche('8171', d, 3000, true);
  }
  await buche('4571', '2077-04-15', 9900, false, 'P71');
  await buche('4571', '2077-06-15', 10000, false, 'P71');
  await buche('8171', '2077-08-20', 6000, true, 'P71');
  await tx((t) => pr.projektStatus(t, led, 'UMSETZUNG', null, 'paula', false));

  const s = await hh.sollIst(db, 2077, '2078-01-20');
  const z = s.zeilen.find((x) => x.konto === '4571')!;
  // das Konto zeigt den laufenden Betrieb; der Projektanteil steht daneben und sprengt das Budget des Kontos nicht
  assert.deepEqual([z.ist, z.projekt, z.hochrechnung], [2400, 19900, 2400]);
  assert.equal(z.bewertung.stufe, 'IM_PLAN');
  assert.deepEqual([s.zeilen.find((x) => x.konto === '8171')!.ist, s.zeilen.find((x) => x.konto === '8171')!.projekt], [3000, 6000]);
  nah(s.summen.A.ist, 2400 + 6000);
  // das Projekt: Budget 18.000, gebucht 19.900 → +10,6 % → überschritten; Einnahmen 6.000 wie geplant
  const p = s.projekte.find((x) => x.id === led)!;
  assert.deepEqual([p.budget, p.ist, p.plan_jahr, p.ist_jahr, p.einnahmen_plan, p.einnahmen_ist, p.bewertung.stufe, p.bewertung.prozent, p.bewertung.state],
    [18000, 19900, 18000, 19900, 6000, 6000, 'UEBERSCHRITTEN', 10.6, 'Negative']);
  // die Platzsanierung ist geplant (6.000 im Jahr), aber noch ohne Buchung
  assert.deepEqual(s.projekte.filter((x) => x.id === platz).map((x) => [x.plan_jahr, x.ist, x.bewertung.stufe]), [[6000, 0, 'IM_PLAN']]);
  // Arbeitsvorrat: das Projektbudget, nicht das Konto
  assert.deepEqual((await hh.aufgaben(db, '2077-12-20')).map((a) => a.key), []);
  const av = await pr.projektAufgaben(db, { genehmiger: false, leser: true, ueberwachung: true }, s.cfg, '2077-12-20');
  assert.deepEqual(av.map((a) => [a.key, a.bereich, a.state, a.betrag]), [[`HHPROJEKTBUDGET:${led}`, 'Kassenwart', 'Negative', 1900]]);
  // abwählen: gilt für das Projekt über alle Jahre, im Soll-Ist vermerkt; wieder anzeigen
  assert.deepEqual(av[0].erledigen?.body, { schluessel: `HHPROJEKTBUDGET:${led}`, jahr: 0, aus: true });
  await sql.begin((t) => pr.hinweisSetzen(t as never, `HHPROJEKTBUDGET:${led}`, 2077, true, 'Test'));
  assert.deepEqual(await pr.projektAufgaben(db, { genehmiger: false, leser: true, ueberwachung: true }, s.cfg, '2078-01-10'), []);
  assert.ok((await hh.sollIst(db, 2077, '2077-12-20')).ausgeblendet.includes(`HHPROJEKTBUDGET:${led}`));
  await sql.begin((t) => pr.hinweisSetzen(t as never, `HHPROJEKTBUDGET:${led}`, 0, false, 'Test'));
  assert.equal((await pr.projektAufgaben(db, { genehmiger: false, leser: true, ueberwachung: true }, s.cfg, '2077-12-20')).length, 1);
  assert.deepEqual(await pr.projektAufgaben(db, { genehmiger: false, leser: true, ueberwachung: false }, s.cfg), []);

  // Grundlage für 2079 (Stand Anfang 2078): „Ist 2077“ wie im Jahresabschluss einschließlich Projekt – gerechnet wird ohne es
  const g = await hh.grundlageLesen(db, 2079, '2078-02-01');
  const k = g.konten.find((x) => x.konto === '4571')!;
  const { werte } = await jahreswerteLesen(db, 2077, 2077);
  assert.equal(k.ist[2077], werte.find((w) => w.konto === '4571')!.wert);
  assert.deepEqual([k.ist[2077], k.ist_projekt[2077], k.ist_projekt[2076]], [22300, 19900, undefined]);
  nah(k.werte.AVG3!, (2400 + 2000 + 2400) / 3);              // 2075, 2076 (in den Testdaten nur zehn Monate), 2077 – ohne die 19.900 des Projekts
  nah(k.werte.MED5!, 2400);
  assert.deepEqual(k.ausreisser, []);                         // kein Ausreißer: der Projektanteil ist schon herausgerechnet
  nah(g.konten.find((x) => x.konto === '8171')!.werte.AVG3!, 3000);
  // ohne Projektnummer am Projekt gäbe es keine Trennung – die Buchungen zählten als laufender Betrieb
  const ohneNr = await hh.monatswerteLesen(db, 2077, 2077, []);
  assert.equal(ohneNr.konten.get('4571')!.projekt.size, 0);
  assert.equal((await hh.monatswerteLesen(db, 2077, 2077, ['P71'])).konten.get('4571')!.projekt.get(2077)![3], 9900);

  // PDF mit Projekten, Projektliste über die API mit Ist und Bewertung
  let r = await call('GET', `${H}/plan/${plan}/pdf`);
  assert.equal(r.status, 200);
  r = await call('GET', `${H}/projekte`);
  const lp = r.body.projekte.find((x: any) => x.id === led);
  assert.deepEqual([r.body.darfGenehmigen, lp.status, lp.ist.kosten, lp.ist.einnahmen, lp.bewertung.stufe], [true, 'UMSETZUNG', 19900, 6000, 'UEBERSCHRITTEN']);
  assert.equal((await call('POST', `${H}/projekte/${led}/status`, { status: 'ABGESCHLOSSEN' })).status, 200);
  assert.equal((await call('POST', `${H}/projekte/${led}/status`, { status: 'IDEE' })).status, 400);
  // FI wurde nur gelesen
  const [n] = await sql`select count(*)::int as n from tco.fibuchungen`;
  assert.equal(n.n, nr * 2);
});
