/**
 * Turniere – Doppel-/Mixed-Spaßturnier: Auslosung (keine Partnerwiederholung, gleich viele Spiele, Pausenwünsche, Laufzeit),
 * Rangliste und der Ablauf über HTTP (auslosen, starten, Ergebnis über Verwaltung und Platz-QR, abschließen, nächste Runde).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  historieAus, paarSchluessel, rangliste, rundeAuslosen, zufallMitStart, type Auslosung,
} from '../../modules/tco/server/turnier/spass-logik.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');

// ------------------------------------------------------------------ reine Logik

/** mehrere Runden hintereinander auslosen (wunsch: je Runde die Pausenwünsche) */
function simulieren(personen: number[], plaetze: number, runden: number, seed: number, wunsch: (r: number) => number[] = () => []) {
  const rnd = zufallMitStart(seed);
  const spiele: { a: number[]; b: number[] }[] = [];
  const pausen: number[] = [];
  const ergebnisse: Auslosung[] = [];
  for (let r = 0; r < runden; r++) {
    const los = rundeAuslosen({ personen, pauseWunsch: wunsch(r), historie: historieAus(spiele, pausen), plaetze, rnd });
    ergebnisse.push(los);
    for (const s of los.spiele) spiele.push({ a: s.a, b: s.b });
    pausen.push(...los.pause);
  }
  return { spiele, pausen, ergebnisse, historie: historieAus(spiele, pausen) };
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test('Auslosung: Spielende, Plätze 1…n, jede Person genau einmal', () => {
  const los = rundeAuslosen({ personen: ids(19), pauseWunsch: [], historie: historieAus([], []), plaetze: 4, rnd: zufallMitStart(1) });
  assert.equal(los.spiele.length, 4);
  assert.deepEqual(los.spiele.map((s) => s.platz), [1, 2, 3, 4]);
  assert.equal(los.pause.length, 3);
  const alle = [...los.spiele.flatMap((s) => [...s.a, ...s.b]), ...los.pause].sort((x, y) => x - y);
  assert.deepEqual(alle, ids(19));
  // mehr Plätze als nötig: 10 Personen → 2 Doppel
  const w = rundeAuslosen({ personen: ids(10), pauseWunsch: [], historie: historieAus([], []), plaetze: 6, rnd: zufallMitStart(2) });
  assert.deepEqual([w.spiele.length, w.pause.length], [2, 2]);
  // zu wenige
  assert.equal(rundeAuslosen({ personen: ids(3), pauseWunsch: [], historie: historieAus([], []), plaetze: 2, rnd: zufallMitStart(3) }).spiele.length, 0);
});

test('Auslosung: 16 Personen / 4 Plätze über 7 Runden ohne Partnerwiederholung', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { historie } = simulieren(ids(16), 4, 7, seed);
    const max = Math.max(...historie.partner.values());
    assert.equal(max, 1, `Seed ${seed}: Partner doppelt`);
    assert.ok([...historie.gegner.values()].every((n) => n <= 2), `Seed ${seed}: Gegner zu oft`);
    for (const id of ids(16)) assert.equal(historie.gespielt.get(id), 7);
  }
});

test('Auslosung: 18 Personen / 4 Plätze über 9 Runden – alle spielen gleich oft (max − min ≤ 1)', () => {
  for (const seed of [7, 8, 9]) {
    const { historie } = simulieren(ids(18), 4, 9, seed);
    const g = ids(18).map((id) => historie.gespielt.get(id) ?? 0);
    assert.ok(Math.max(...g) - Math.min(...g) <= 1, `Seed ${seed}: ${g}`);
    assert.equal(g.reduce((x, y) => x + y, 0), 9 * 16);
    assert.equal(Math.max(...historie.partner.values()), 1, 'keine Partnerwiederholung');
  }
});

test('Auslosung: Pausenwunsch wird respektiert, erzwungene Pausen gleichen danach aus', () => {
  const { ergebnisse, historie } = simulieren(ids(17), 4, 6, 11, (r) => (r === 0 ? [5, 6] : r === 2 ? [5] : []));
  assert.ok(ergebnisse[0].pause.includes(5) && ergebnisse[0].pause.includes(6));
  assert.deepEqual(ergebnisse[0].pauseGewuenscht.sort(), [5, 6]);
  assert.ok(!ergebnisse[0].spiele.some((s) => [...s.a, ...s.b].includes(5)));
  assert.ok(ergebnisse[2].pause.includes(5));
  // 17 Personen, 2 Wünsche in Runde 1 → 15 verfügbar → 12 spielen
  assert.equal(ergebnisse[0].spiele.length, 3);
  // wer gewünscht pausiert hat, wird danach nicht noch zusätzlich zwangspausiert, solange andere mehr gespielt haben
  const g = ids(17).filter((id) => id !== 5 && id !== 6).map((id) => historie.gespielt.get(id) ?? 0);
  assert.ok(Math.max(...g) - Math.min(...g) <= 1, `${g}`);
});

test('Auslosung: 64 Personen / 16 Plätze schnell (< 300 ms je Runde)', () => {
  const personen = ids(64);
  const rnd = zufallMitStart(42);
  const spiele: { a: number[]; b: number[] }[] = [];
  let langsamste = 0;
  for (let r = 0; r < 8; r++) {
    const t0 = performance.now();
    const los = rundeAuslosen({ personen, pauseWunsch: [], historie: historieAus(spiele, []), plaetze: 16, rnd });
    langsamste = Math.max(langsamste, performance.now() - t0);
    assert.equal(los.spiele.length, 16);
    spiele.push(...los.spiele.map((s) => ({ a: s.a, b: s.b })));
  }
  assert.ok(langsamste < 300, `${langsamste.toFixed(0)} ms`);
  assert.equal(Math.max(...historieAus(spiele, []).partner.values()), 1);
});

test('Rangliste: Quote, dann Siege, dann Spieldifferenz; Unentschieden halb; Runden/Pausen', () => {
  const s = (a: number[], b: number[], x: number, y: number) => ({ feld: 'runde' as const, a, b, saetze: [[x, y]] as [number, number][], wertung: 'gespielt' as const, sieger: (x > y ? 'a' : y > x ? 'b' : 'x') as 'a' | 'b' | 'x' });
  const spiele = [
    s([1, 2], [3, 4], 6, 2),
    s([1, 3], [2, 4], 4, 4),
    s([1, 4], [2, 3], 3, 5),
    { feld: 'runde' as const, a: [5, 6], b: [7, 8], saetze: null, wertung: 'offen' as const, sieger: null },
  ];
  const h = historieAus(spiele, [9]);
  const r = rangliste(spiele, ids(9), h);
  const z = new Map(r.map((x) => [x.teilnehmer_id, x]));
  assert.equal(z.get(1)!.quote, 0.5);           // S, U, N
  assert.equal(z.get(2)!.quote, 2.5 / 3);       // S (6:2), U (4:4), S (5:3)
  assert.equal(z.get(2)!.siege, 2);
  assert.equal(r[0].teilnehmer_id, 2, 'beste Quote vorn');
  assert.equal(z.get(5)!.spiele, 0, 'offene Spiele zählen nicht');
  assert.equal(z.get(5)!.runden, 1);
  assert.equal(z.get(9)!.pausen, 1);
  assert.equal(z.get(1)!.differenz, (6 + 4 + 3) - (2 + 4 + 5));
  // Gleichstand bei Quote und Siegen → Spieldifferenz entscheidet; völliger Gleichstand → gleicher Rang
  const r2 = rangliste([s([1, 2], [3, 4], 6, 0), s([5, 6], [7, 8], 6, 5)], ids(8), historieAus([], []));
  assert.deepEqual(r2.slice(0, 4).map((x) => x.teilnehmer_id), [1, 2, 5, 6]);
  assert.deepEqual(r2.slice(0, 4).map((x) => x.rang), [1, 1, 3, 3]);
  assert.equal(paarSchluessel(5, 2), '2-5');
});

// ------------------------------------------------------------------ Ablauf über HTTP

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown, ohneAnmeldung = false) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { ...(ohneAnmeldung ? {} : { cookie }), 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set && !ohneAnmeldung) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const T = '/api/m/tco/turniere';
const TO = '/api/m/tco/turnier';

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => { await app?.close(); await sql.end(); });

test('Spaßturnier über HTTP: auslosen, starten, Ergebnisse, Platz-QR, abschließen, nächste Runde, Rangliste, Live', async () => {
  let r = await call('POST', T, { name: 'Sommer-Spaßturnier', kennung: 'spass-2027', modus: 'spass', status: 'anmeldung', einstellungen: { plaetze: 2, minuten: 15, runden: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id as number;
  const tn: number[] = [];
  for (let i = 1; i <= 10; i++) {
    r = await call('POST', `${T}/${id}/teilnehmer`, { vorname: `Vor${i}`, nachname: `Nach${i}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    tn.push(r.body.id);
  }
  // Pausenwunsch für Runde 1 über die Verwaltung
  r = await call('PUT', `${T}/${id}/spass/pause`, { teilnehmer_id: tn[0], pause: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await call('POST', `${T}/${id}/spass/runde`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { nr: 1, spiele: 2, pausen: 2 });
  r = await call('POST', `${T}/${id}/spass/runde`);
  assert.equal(r.status, 400);
  assert.match(r.body.error ?? r.body.message, /Runde 1 abschließen/);

  let live = (await call('GET', `${T}/${id}/live`)).body;
  assert.equal(live.turnier.status, 'laeuft', 'mit der ersten Auslosung läuft das Turnier');
  let d = live.daten;
  assert.equal(d.runde.nr, 1);
  assert.equal(d.runde.status, 'geplant');
  assert.equal(d.runde.minuten, 15);
  assert.ok(d.runde.pausen.includes(tn[0]));
  assert.deepEqual(d.runde.pausen_gewuenscht, [tn[0]]);
  assert.deepEqual(d.pause_naechste, [], 'Wunsch ist verbraucht');

  // neu losen: Runde löschen → Wunsch lebt wieder auf
  r = await call('DELETE', `${T}/${id}/spass/runde/1`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await call('GET', `${T}/${id}/live`)).body.daten.pause_naechste, [tn[0]]);
  r = await call('POST', `${T}/${id}/spass/runde`);
  assert.equal(r.body.nr, 1);

  d = (await call('GET', `${T}/${id}/live`)).body.daten;
  const [p1, p2] = d.runde.plaetze;
  // vor dem Start kein Ergebnis
  r = await call('POST', `${T}/${id}/spiele/${p1.spiel_id}/ergebnis`, { wertung: 'gespielt', saetze: [[5, 3]] });
  assert.equal(r.status, 400);
  assert.match(r.body.error ?? r.body.message, /noch nicht gestartet/);

  r = await call('POST', `${T}/${id}/spass/runde/1/start`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.endeUm);
  assert.equal(new Date(r.body.endeUm).getTime() - new Date(r.body.beginn).getTime(), 15 * 60_000);

  // Ergebnis über die Verwaltung
  r = await call('POST', `${T}/${id}/spiele/${p1.spiel_id}/ergebnis`, { wertung: 'gespielt', saetze: [[5, 3]] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sieger, 'a');

  // Platz-QR
  r = await call('POST', `${T}/${id}/spass/qr`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.qr, /^data:image\/svg\+xml;base64,/);
  const k = new URL(r.body.link, 'http://x').searchParams.get('k')!;
  assert.ok(k);
  r = await call('GET', `${TO}/spass/platz/spass-2027?k=falsch-falsch-falsch`, undefined, true);
  assert.equal(r.status, 404);
  r = await call('POST', `${TO}/spass/platz/spass-2027/ergebnis`, { k: 'falsch-falsch-falsch', spiel_id: p2.spiel_id, spiele_a: 4, spiele_b: 4 }, true);
  assert.equal(r.status, 404);
  r = await call('GET', `${TO}/spass/platz/spass-2027?k=${encodeURIComponent(k)}`, undefined, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.runde.plaetze.length, 2);
  assert.match(r.body.runde.plaetze[0].namen_a[0], /^Vor\d+ N\.$/, 'öffentlich nur Kurznamen');
  r = await call('POST', `${TO}/spass/platz/spass-2027/ergebnis`, { k, spiel_id: p2.spiel_id, spiele_a: 4, spiele_b: 4 }, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [sp2] = await sql`select wertung, sieger, saetze, eingetragen_von from tco.turnier_spiele where id = ${p2.spiel_id}`;
  assert.deepEqual([sp2.wertung, sp2.sieger, sp2.saetze, sp2.eingetragen_von], ['gespielt', 'x', [[4, 4]], 'Platz 2']);

  // Pausenwunsch über den persönlichen Link
  r = await call('POST', `${T}/${id}/teilnehmer/${tn[3]}/link`, { senden: false });
  const z = new URL(r.body.link, 'http://x').searchParams.get('z')!;
  r = await call('POST', `${TO}/spass/zugang/${z}/pause`, { pause: true }, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${TO}/spass/zugang/${z}`, undefined, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pause_naechste, true);
  assert.equal(r.body.runde.nr, 1);
  assert.equal(!!r.body.platz, !r.body.runde.pause);

  r = await call('POST', `${T}/${id}/spass/runde/1/abschliessen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.offen, 0);
  // nach Abschluss keine Eingabe am Platz mehr
  r = await call('POST', `${TO}/spass/platz/spass-2027/ergebnis`, { k, spiel_id: p2.spiel_id, spiele_a: 5, spiele_b: 4 }, true);
  assert.equal(r.status, 400);

  // Runde 2
  r = await call('POST', `${T}/${id}/spass/runde`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nr, 2);
  live = (await call('GET', `${TO}/oeffentlich/spass-2027/live`, undefined, true)).body;
  d = live.daten;
  assert.equal(d.runde.nr, 2);
  assert.ok(d.runde.pausen.includes(tn[3]), 'Wunsch über den Link');
  assert.ok(!d.runde.pausen.includes(tn[0]) || d.runde.pausen.length > 2, 'wer gewünscht pausiert hat, spielt jetzt');
  assert.equal(d.runden.length, 2);
  assert.deepEqual([d.runden[0].spiele, d.runden[0].gewertet], [2, 2]);
  // Rangliste: Sieger von Platz 1 vorn mit Quote 1
  const sieger = new Set(p1.a as number[]);
  assert.ok(sieger.has(d.rangliste[0].teilnehmer_id));
  assert.equal(d.rangliste[0].quote, 1);
  const unent = d.rangliste.find((x: any) => p2.a.includes(x.teilnehmer_id));
  assert.deepEqual([unent.unentschieden, unent.quote], [1, 0.5]);
  assert.equal(d.rangliste.find((x: any) => x.teilnehmer_id === tn[0]).pausen, 1);
  assert.ok(live.teilnehmer.every((x: any) => /\.$/.test(x.name)), 'öffentlich Kurznamen');

  // Partner aus Runde 1 werden in Runde 2 nicht wieder zusammen gelost
  const spiele = await sql<{ runde: number; a: number[]; b: number[] }[]>`select runde, a, b from tco.turnier_spiele where turnier_id = ${id} order by runde, platz`;
  const partner = new Set(spiele.filter((s) => s.runde === 1).flatMap((s) => [paarSchluessel(s.a[0], s.a[1]), paarSchluessel(s.b[0], s.b[1])]));
  for (const s of spiele.filter((x) => x.runde === 2)) {
    assert.ok(!partner.has(paarSchluessel(s.a[0], s.a[1])) && !partner.has(paarSchluessel(s.b[0], s.b[1])));
  }

  // Runde 2 abschließen ohne Ergebnisse → offene bleiben ungewertet; Rundenzahl 3 begrenzt
  await call('POST', `${T}/${id}/spass/runde/2/start`);
  r = await call('POST', `${T}/${id}/spass/runde/2/abschliessen`);
  assert.equal(r.body.offen, 2);
  r = await call('DELETE', `${T}/${id}/spass/runde/2`);
  assert.equal(r.status, 400, 'gestartete Runde lässt sich nicht löschen');
  assert.equal((await call('POST', `${T}/${id}/spass/runde`)).status, 200);
  await call('POST', `${T}/${id}/spass/runde/3/abschliessen`);
  r = await call('POST', `${T}/${id}/spass/runde`);
  assert.equal(r.status, 400);
  assert.match(r.body.error ?? r.body.message, /Alle 3 Runden/);
  assert.equal((await call('GET', `${T}/${id}/live`)).body.daten.fertig, true);

  // ohne Anmeldung keine Verwaltung
  assert.equal((await call('POST', `${T}/${id}/spass/runde`, undefined, true)).status, 401);
});
