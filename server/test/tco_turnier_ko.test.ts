/**
 * Turniere – KO-Modus: Setzschema, Freilose, Nebenrunde (erste Runde / alle mit Feed-in), Abgleich nach Korrekturen
 * (reine Logik) sowie der Ablauf über die HTTP-Routen (Auslosung, Ergebnisse bis zum Finale, Nebenrunde, Zurücksetzen, Live).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  abgleichen, auslosen, gegenlinie, linienReihenfolge, mischen, rundenTitel, schluessel, setzlisteBilden, strukturBilden,
  type IstSpiel, type Nebenrunde, type Struktur,
} from '../../modules/tco/server/turnier/ko-logik.js';

/** deterministischer Zufall (mulberry32) */
function zufall(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ids = (n: number) => [...Array(n).keys()].map((i) => ({ id: i + 1, setzplatz: null as number | null }));

// ------------------------------------------------------------------ reine Logik

test('Setzschema 8/16/32/64: 1 oben, 2 unten, 3/4 in freie Viertel, 5–8 in freie Achtel, 9–16 in freie Sechzehntel', () => {
  for (const n of [8, 16, 32, 64]) {
    for (let seed = 1; seed <= 20; seed++) {
      const l = linienReihenfolge(n, zufall(seed));
      assert.equal(l.length, n / 2);
      assert.equal(new Set(l.map((x) => Math.floor(x / 2))).size, n / 2, 'jeder Vorzugsplatz in einem anderen Spiel');
      assert.equal(l[0], 0);
      assert.equal(l[1], n - 1);
      assert.deepEqual(new Set(l.slice(2, 4).map((x) => Math.floor(x / (n / 4)))), new Set([1, 2]), 'Setzplätze 3/4 in Viertel 2 und 3');
      assert.deepEqual(new Set(l.slice(2, 4)), new Set([n / 4, (3 * n) / 4 - 1]));
      if (n >= 16) {
        const achtel = new Set(l.slice(0, 4).map((x) => Math.floor(x / (n / 8))));
        const frei = [0, 1, 2, 3, 4, 5, 6, 7].filter((s) => !achtel.has(s));
        assert.deepEqual(new Set(l.slice(4, 8).map((x) => Math.floor(x / (n / 8)))), new Set(frei), `${n}: 5–8 in den freien Achteln`);
      }
      if (n >= 32) {
        const sech = new Set(l.slice(0, 8).map((x) => Math.floor(x / (n / 16))));
        assert.equal(sech.size, 8);
        assert.ok(l.slice(8, 16).every((x) => !sech.has(Math.floor(x / (n / 16)))), `${n}: 9–16 in freien Sechzehnteln`);
        assert.equal(new Set(l.slice(8, 16).map((x) => Math.floor(x / (n / 16)))).size, 8);
      }
    }
  }
  // 32er-Feld wie im üblichen Schema (1-basiert): 1, 32, 9/24, 8/16/17/25
  const l32 = linienReihenfolge(32, zufall(7)).map((x) => x + 1);
  assert.deepEqual(l32.slice(0, 2), [1, 32]);
  assert.deepEqual(new Set(l32.slice(2, 4)), new Set([9, 24]));
  assert.deepEqual(new Set(l32.slice(4, 8)), new Set([8, 16, 17, 25]));
  // 8er-Feld: 1, 8, 3/6
  assert.deepEqual(new Set(linienReihenfolge(8, zufall(3)).slice(2).map((x) => x + 1)), new Set([3, 6]));
  // die Auslosung von 3/4 ist wirklich gelost
  const varianten = new Set([...Array(30).keys()].map((s) => linienReihenfolge(16, zufall(s + 1))[2]));
  assert.equal(varianten.size, 2);
});

test('Setzliste: manuelle Setzplätze haben Vorrang, Rest nach Stärke; höchstens N/2', () => {
  const st = ids(10);
  assert.deepEqual(setzlisteBilden(st, 4, 16), [1, 2, 3, 4]);
  st[6].setzplatz = 1; // Nr. 7 manuell auf 1
  st[8].setzplatz = 3;
  assert.deepEqual(setzlisteBilden(st, 4, 16), [7, 1, 9, 2]);
  assert.deepEqual(setzlisteBilden(st, 0, 16), [7, 9], 'manuell Gesetzte zählen auch ohne Einstellung');
  assert.deepEqual(setzlisteBilden(ids(3), 4, 4), [1, 2], 'im 4er-Feld höchstens zwei Gesetzte');
});

function pruefeAuslosung(n: number, gesetzte: number, seed: number) {
  const st = ids(n);
  const a = auslosen(st, gesetzte, zufall(seed));
  const belegt = a.linien.filter((x): x is number => x != null);
  assert.equal(belegt.length, n);
  assert.equal(new Set(belegt).size, n, 'jede/r genau einmal');
  assert.equal(a.freilose, a.feld - n);
  for (let p = 0; p < a.feld / 2; p++) assert.ok(a.linien[2 * p] != null || a.linien[2 * p + 1] != null, 'kein Spiel mit zwei Freilosen');
  // Freilose an die Bestgesetzten, danach an die nächststärksten
  const mitFreilos = new Set(belegt.filter((id) => a.linien[gegenlinie(a.linien.indexOf(id))] == null));
  const erwartet = [...a.gesetzte, ...st.map((x) => x.id).filter((id) => !a.gesetzte.includes(id))].slice(0, a.freilose);
  assert.deepEqual(mitFreilos, new Set(erwartet));
  return a;
}

test('Freilose bei 5, 11, 33 Teilnehmenden (und weitere Größen)', () => {
  const a5 = pruefeAuslosung(5, 4, 1);
  assert.deepEqual([a5.feld, a5.freilose], [8, 3]);
  assert.equal(a5.linien[0], 1, 'Setzplatz 1 oben');
  assert.equal(a5.linien[1], null, 'Setzplatz 1 hat Freilos');
  assert.equal(a5.linien[7], 2);
  assert.equal(a5.linien[6], null);
  const a11 = pruefeAuslosung(11, 4, 2);
  assert.deepEqual([a11.feld, a11.freilose], [16, 5]);
  const a33 = pruefeAuslosung(33, 16, 3);
  assert.deepEqual([a33.feld, a33.freilose], [64, 31]);
  for (const n of [2, 3, 4, 6, 7, 9, 16, 17, 31, 32, 48, 63, 64]) for (const g of [0, 2, 4, 8, 16]) pruefeAuslosung(n, g, n * 31 + g);
  assert.throws(() => auslosen(ids(65), 4), /höchstens 64/);
  assert.throws(() => auslosen(ids(1), 4), /mindestens zwei/);
  assert.equal(auslosen(ids(3), 2).feld, 4);
  assert.deepEqual(mischen([1, 2, 3], () => 0.999).length, 3);
});

/** Turnier ohne Datenbank durchspielen: jeweils gewinnt die kleinere ID (= stärker) bzw. nach Regel */
function durchspielen(s: Struktur, regel: (a: number, b: number) => 'a' | 'b' = (a, b) => (a < b ? 'a' : 'b')) {
  const ist = new Map<string, IstSpiel>(s.spiele.map((x) => [schluessel(x), {
    feld: x.feld, runde: x.runde, pos: x.pos, wertung: 'offen', sieger: null,
    a: x.a.art === 'start' && x.a.id != null ? [x.a.id] : [], b: x.b.art === 'start' && x.b.id != null ? [x.b.id] : [],
  }]));
  for (let i = 0; i < 500; i++) {
    const { aenderungen, konflikte } = abgleichen(s, [...ist.values()]);
    assert.deepEqual(konflikte, []);
    for (const x of aenderungen) ist.set(schluessel(x), { ...x });
    const offen = [...ist.values()].filter((x) => x.wertung === 'offen' && x.a.length && x.b.length);
    if (!offen.length && !aenderungen.length) break;
    for (const x of offen) { x.wertung = 'gespielt'; x.sieger = regel(x.a[0], x.b[0]); }
  }
  return ist;
}
const teil = (ist: Map<string, IstSpiel>, feld: string) => new Set([...ist.values()].filter((x) => x.feld === feld).flatMap((x) => [...x.a, ...x.b]));
/** erwartete Nebenrunden-Teilnehmende aus dem Hauptfeld */
function erwartetNeben(ist: Map<string, IstSpiel>, k: number, art: Nebenrunde) {
  const haupt = [...ist.values()].filter((x) => x.feld === 'haupt' && x.a.length && x.b.length).sort((x, y) => x.runde - y.runde);
  const res = new Set<number>();
  const schonGespielt = new Set<number>();
  for (const x of haupt) {
    const verl = x.sieger === 'a' ? x.b[0] : x.a[0];
    const erstes = !schonGespielt.has(verl);
    if (x.runde <= k - 2 && (art === 'alle' || erstes)) res.add(verl);
    schonGespielt.add(x.a[0]); schonGespielt.add(x.b[0]);
  }
  return res;
}

test('Nebenrunde „erste Runde“: Verlierer des ersten echten Spiels (auch nach Freilos), Freilose automatisch', () => {
  for (const [n, seed] of [[11, 1], [5, 2], [13, 3], [16, 4], [33, 5], [40, 6], [64, 7], [9, 8]] as const) {
    const a = auslosen(ids(n), 4, zufall(seed));
    const k = Math.log2(a.feld);
    for (const regel of [(x: number, y: number) => (x < y ? 'a' : 'b'), (x: number, y: number) => (x > y ? 'a' : 'b'), () => 'b'] as const) {
      const s = strukturBilden(a.linien, 'erste_runde');
      const ist = durchspielen(s, regel as (a: number, b: number) => 'a' | 'b');
      const ohneNeben = !s.spiele.some((x) => x.feld === 'neben');
      const erw = ohneNeben ? new Set<number>() : erwartetNeben(ist, k, 'erste_runde');
      if (ohneNeben) assert.ok(erwartetNeben(ist, k, 'erste_runde').size < 2, `${n}: Nebenrunde fehlt`);
      assert.deepEqual(teil(ist, 'neben'), erw, `${n} Teilnehmende`);
      const nf = [...ist.values()].filter((x) => x.feld === 'neben');
      if (erw.size >= 2) {
        const finale = nf.reduce((m, x) => (x.runde > m.runde ? x : m));
        assert.ok(finale.sieger === 'a' || finale.sieger === 'b', `${n}: Nebenrunde hat einen Sieger`);
        assert.ok(finale.a.length && finale.b.length || finale.wertung === 'freilos');
      }
      // alle Spiele erledigt
      assert.ok([...ist.values()].every((x) => x.wertung !== 'offen'), `${n}: alles gespielt`);
    }
  }
  // 11 Teilnehmende, Stärkere gewinnen: 3 echte Erstrundenspiele + die Freilos-Spieler, die in Runde 2 verlieren
  const a = auslosen(ids(11), 4, zufall(11));
  const s = strukturBilden(a.linien, 'erste_runde');
  assert.equal(s.runden.filter((r) => r.feld === 'neben')[0].spiele, 4, '3 sichere + bis zu 5 bedingte Plätze → 8er-Feld');
  // 4er-Feld: keine Nebenrunde (Halbfinal-Verlierer)
  assert.equal(strukturBilden(auslosen(ids(4), 2, zufall(1)).linien, 'erste_runde').spiele.filter((x) => x.feld === 'neben').length, 0);
  assert.equal(strukturBilden(auslosen(ids(16), 2, zufall(1)).linien, 'keine').spiele.filter((x) => x.feld === 'neben').length, 0);
});

test('Nebenrunde „alle“: Feed-in je Runde, Halbfinal-/Finalverlierer steigen nicht ein', () => {
  const s16 = strukturBilden(auslosen(ids(16), 4, zufall(1)).linien, 'alle');
  assert.deepEqual(s16.runden.filter((r) => r.feld === 'neben').map((r) => [r.titel, r.spiele, r.einstieg]),
    [['1. Runde', 4, 1], ['Viertelfinale', 4, 2], ['Halbfinale', 2, null], ['Finale', 1, null]]);
  assert.deepEqual(s16.runden.filter((r) => r.feld === 'haupt').map((r) => r.titel), ['Achtelfinale', 'Viertelfinale', 'Halbfinale', 'Finale']);
  const s64 = strukturBilden(auslosen(ids(64), 16, zufall(1)).linien, 'alle');
  assert.deepEqual(s64.runden.filter((r) => r.feld === 'neben').map((r) => r.spiele), [16, 16, 8, 8, 4, 4, 2, 1]);
  assert.deepEqual(s64.runden.filter((r) => r.feld === 'haupt').map((r) => r.titel), ['1. Runde', '2. Runde', 'Achtelfinale', 'Viertelfinale', 'Halbfinale', 'Finale']);
  for (const [n, seed] of [[16, 1], [11, 2], [33, 3], [64, 4], [8, 5], [6, 6], [27, 7]] as const) {
    const a = auslosen(ids(n), 8, zufall(seed));
    const k = Math.log2(a.feld);
    for (const regel of [(x: number, y: number) => (x < y ? 'a' : 'b'), () => 'a', (x: number, y: number) => ((x * 7 + y) % 2 ? 'a' : 'b')] as const) {
      const ist = durchspielen(strukturBilden(a.linien, 'alle'), regel as (a: number, b: number) => 'a' | 'b');
      const erw = erwartetNeben(ist, k, 'alle');
      assert.deepEqual(teil(ist, 'neben'), erw, `${n} Teilnehmende`);
      assert.ok([...ist.values()].every((x) => x.wertung !== 'offen'), `${n}: alles gespielt`);
      // Halbfinal-/Finalverlierer nicht in der Nebenrunde
      const hf = [...ist.values()].filter((x) => x.feld === 'haupt' && x.runde >= k - 1).flatMap((x) => [...x.a, ...x.b]);
      for (const id of hf) assert.ok(!teil(ist, 'neben').has(id));
      // kein Feed-in-Spiel als sofortige Wiederholung des Erstrundenspiels
    }
  }
});

test('Abgleich: Korrektur nimmt Folgeeinträge zurück, gewertetes Folgespiel ist ein Konflikt', () => {
  const a = auslosen(ids(8), 2, zufall(9));
  const s = strukturBilden(a.linien, 'erste_runde');
  const ist = durchspielen(s);
  const r1 = ist.get('haupt|1|1')!;
  // Ergebnis der 1. Runde zurücksetzen → Halbfinale schon gewertet → Konflikt
  r1.wertung = 'offen'; r1.sieger = null;
  const k = abgleichen(s, [...ist.values()]);
  assert.ok(k.konflikte.some((x) => x.feld === 'haupt' && x.runde === 2 && x.pos === 0));
  assert.ok(k.konflikte.some((x) => x.feld === 'neben'), 'Nebenrunde ebenfalls betroffen');
  // ohne gewertete Folgespiele: Folgeeintrag wird geleert
  const frisch = durchspielen(s, () => 'a');
  for (const x of frisch.values()) if (!(x.feld === 'haupt' && x.runde === 1)) { if (x.wertung !== 'freilos') { x.wertung = 'offen'; x.sieger = null; } }
  const neu = abgleichen(s, [...frisch.values()]);
  for (const x of neu.aenderungen) frisch.set(schluessel(x), { ...x });
  const x0 = frisch.get('haupt|1|0')!;
  x0.wertung = 'offen'; x0.sieger = null;
  const z = abgleichen(s, [...frisch.values()]);
  assert.deepEqual(z.konflikte, []);
  const hf = z.aenderungen.find((x) => x.feld === 'haupt' && x.runde === 2 && x.pos === 0);
  assert.ok(hf && hf.a.length === 0, 'Sieger aus dem Halbfinale genommen');
  assert.equal(rundenTitel(8, 1), 'Achtelfinale');
  assert.equal(rundenTitel(16, 2), '2. Runde');
});

// ------------------------------------------------------------------ Datenbank / HTTP

const url = process.env.TEST_DATABASE_URL;
const mitDb = !!url && /test/i.test(url.split('/').pop() ?? '');
let app: any;
let cookie = '';
let sql: any;
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method, url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c: string) => c.split(';')[0]).join('; ');
  return { status: res.statusCode as number, body: res.body ? JSON.parse(res.body) : null };
}
const T = '/api/m/tco/turniere';

before(async () => {
  if (!mitDb) return;
  process.env.DATABASE_URL = url;
  process.env.PORTAL_MODULES = 'tco';
  ({ sql } = await import('../src/db.js'));
  const { migrate } = await import('../src/migrate.js');
  const { activeModules } = await import('../src/modules.js');
  const { buildApp } = await import('../src/app.js');
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => { await app?.close(); await sql?.end(); });

test('HTTP: anlegen, auslosen, Ergebnisse bis zum Finale, Nebenrunde, Zurücksetzen, Live', { skip: !mitDb && 'TEST_DATABASE_URL fehlt' }, async () => {
  const basis = { name: 'Clubmeisterschaft', kennung: 'cm-2027', modus: 'ko', status: 'anmeldung', beschreibung: null, meldeschluss: null, max_teilnehmer: null,
    einstellungen: { nebenrunde: 'erste_runde', setzung: 'lk', gesetzte: 4 } };
  let r = await call('POST', T, basis);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  // zu wenige
  r = await call('POST', `${T}/${id}/ko/auslosen`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /mindestens zwei/);
  for (let i = 1; i <= 11; i++) {
    r = await call('POST', `${T}/${id}/teilnehmer`, { vorname: `Spieler${i}`, nachname: `Test`, lk: 5 + i, setzplatz: i === 11 ? 2 : null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  await call('POST', `${T}/${id}/teilnehmer`, { vorname: 'Warte', nachname: 'Liste', lk: 1, status: 'warteliste' });
  const tn = (await call('GET', `${T}/${id}`)).body.teilnehmer as { id: number; vorname: string; status: string }[];
  const idVon = (i: number) => tn.find((x) => x.vorname === `Spieler${i}`)!.id;

  r = await call('GET', `${T}/${id}/ko/vorschau`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.anzahl, r.body.feld, r.body.freilose], [11, 16, 5]);
  const vs = r.body.staerke as { id: number; setzplatz: number | null; freilos: boolean }[];
  assert.deepEqual(vs.filter((x) => x.setzplatz).sort((x, y) => x.setzplatz! - y.setzplatz!).map((x) => x.id), [idVon(1), idVon(11), idVon(2), idVon(3)], 'manueller Setzplatz 2 hat Vorrang');
  assert.equal(vs.filter((x) => x.freilos).length, 5);

  r = await call('POST', `${T}/${id}/ko/auslosen`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.feld, r.body.freilose], [16, 5]);
  let d = (await call('GET', `${T}/${id}`)).body;
  assert.equal(d.turnier.status, 'laeuft');
  const haupt = d.spiele.filter((s: any) => s.feld === 'haupt');
  assert.equal(haupt.length, 15);
  assert.equal(haupt.filter((s: any) => s.runde === 1 && s.wertung === 'freilos').length, 5);
  assert.equal(d.spiele.filter((s: any) => s.runde === 2 && s.feld === 'haupt' && (s.a.length + s.b.length) > 0).length >= 3, true, 'Freilos-Sieger sind vorgerückt');
  assert.ok(!d.spiele.some((s: any) => s.a.includes(tn.find((x) => x.status === 'warteliste')!.id)), 'Warteliste nicht ausgelost');
  const s1 = haupt.find((s: any) => s.runde === 1 && s.pos === 0);
  assert.deepEqual([s1.a, s1.b, s1.wertung], [[idVon(1)], [], 'freilos'], 'Setzplatz 1 oben mit Freilos');

  // erneut auslosen geht (noch keine Ergebnisse), Aufheben ebenso – danach wieder auslosen
  assert.equal((await call('DELETE', `${T}/${id}/ko/auslosung`)).status, 200);
  assert.equal((await call('GET', `${T}/${id}`)).body.spiele.length, 0);
  assert.equal((await call('POST', `${T}/${id}/ko/auslosen`)).status, 200);

  // Ergebnisse eintragen: stärkere LK (kleinere ID-Nr. im Namen) gewinnt
  const nr = (tid: number) => Number(tn.find((x) => x.id === tid)!.vorname.replace('Spieler', ''));
  for (let runde = 0; runde < 40; runde++) {
    d = (await call('GET', `${T}/${id}`)).body;
    const offen = d.spiele.filter((s: any) => s.wertung === 'offen' && s.a.length && s.b.length);
    if (!offen.length) break;
    for (const s of offen) {
      const aGewinnt = nr(s.a[0]) < nr(s.b[0]);
      r = await call('POST', `${T}/${id}/spiele/${s.id}/ergebnis`, { wertung: 'gespielt', saetze: aGewinnt ? [[6, 3], [6, 4]] : [[6, 3], [6, 7], [5, 10]] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  }
  d = (await call('GET', `${T}/${id}`)).body;
  assert.ok(d.spiele.every((s: any) => s.wertung !== 'offen'), 'alle Spiele erledigt');
  const finale = d.spiele.find((s: any) => s.feld === 'haupt' && s.runde === 4);
  assert.equal(finale.sieger === 'a' ? finale.a[0] : finale.b[0], idVon(1));
  const neben = d.spiele.filter((s: any) => s.feld === 'neben');
  const nebenTn = new Set(neben.flatMap((s: any) => [...s.a, ...s.b]));
  assert.ok(nebenTn.size >= 3, 'Nebenrunde gefüllt');
  // Verlierer der 1. Runde stehen in der Nebenrunde
  for (const s of d.spiele.filter((x: any) => x.feld === 'haupt' && x.runde === 1 && x.wertung === 'gespielt')) {
    assert.ok(nebenTn.has(s.sieger === 'a' ? s.b[0] : s.a[0]));
  }
  const nebenFinale = neben.reduce((m: any, x: any) => (x.runde > m.runde ? x : m));
  assert.ok(nebenFinale.sieger);

  // Zurücksetzen eines Erstrundenspiels: Folgespiel gewertet → Fehler, nichts geändert
  const r1 = d.spiele.find((s: any) => s.feld === 'haupt' && s.runde === 1 && s.wertung === 'gespielt');
  r = await call('DELETE', `${T}/${id}/spiele/${r1.id}/ergebnis`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Folgespiel .* hat bereits ein Ergebnis/);
  assert.equal((await call('GET', `${T}/${id}`)).body.spiele.find((s: any) => s.id === r1.id).wertung, 'gespielt', 'Transaktion zurückgerollt');
  // Ergebnis ändern (anderer Sieger) mit gewertetem Folgespiel → ebenso Fehler
  r = await call('POST', `${T}/${id}/spiele/${r1.id}/ergebnis`, { wertung: 'wo', sieger: r1.sieger === 'a' ? 'b' : 'a' });
  assert.equal(r.status, 400);
  // gleicher Sieger, anderes Ergebnis → geht
  r = await call('POST', `${T}/${id}/spiele/${r1.id}/ergebnis`, { wertung: 'wo', sieger: r1.sieger });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Finale zurücksetzen geht, dann neu eintragen
  r = await call('DELETE', `${T}/${id}/spiele/${finale.id}/ergebnis`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Aufheben mit Ergebnissen → Fehler
  r = await call('DELETE', `${T}/${id}/ko/auslosung`);
  assert.equal(r.status, 400);
  r = await call('POST', `${T}/${id}/ko/auslosen`);
  assert.equal(r.status, 400);

  // Live
  r = await call('GET', `${T}/${id}/live`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const live = r.body.daten;
  assert.equal(live.ausgelost, true);
  assert.equal(live.feld, 16);
  assert.deepEqual(live.haupt.runden.map((x: any) => x.titel), ['Achtelfinale', 'Viertelfinale', 'Halbfinale', 'Finale']);
  assert.equal(live.haupt.sieger, null, 'Finale zurückgesetzt');
  assert.ok(live.neben.runden.length >= 2);
  assert.ok(live.neben.sieger);
  assert.equal(live.gesetzte[idVon(1)], 1);
  assert.equal(live.gesetzte[idVon(11)], 2);
  const fs = live.haupt.runden[3].spiele[0];
  assert.ok(fs.a && fs.b && fs.wertung === 'offen');
  r = await call('GET', '/api/m/tco/turnier/oeffentlich/cm-2027/live');
  assert.equal(r.status, 200);
  assert.equal(r.body.daten.haupt.runden.length, 4);

  // „alle“: neues Turnier mit 16, Nebenrunde mit Einstieg
  r = await call('POST', T, { ...basis, kennung: 'cm-alle', einstellungen: { nebenrunde: 'alle', setzung: 'manuell', gesetzte: 8 } });
  const id2 = r.body.id;
  for (let i = 1; i <= 16; i++) await call('POST', `${T}/${id2}/teilnehmer`, { vorname: `S${i}`, nachname: 'X', rang: i });
  assert.equal((await call('POST', `${T}/${id2}/ko/auslosen`)).status, 200);
  const l2 = (await call('GET', `${T}/${id2}/live`)).body.daten;
  assert.deepEqual(l2.neben.runden.map((x: any) => [x.spiele.length, x.einstieg]), [[4, 1], [4, 2], [2, null], [1, null]]);
  assert.equal(Object.keys(l2.gesetzte).length, 8);
  // Einstellungen ändern ändert das laufende Tableau nicht
  r = await call('PUT', `${T}/${id2}`, { ...basis, kennung: 'cm-alle', status: 'laeuft', einstellungen: { nebenrunde: 'keine' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('GET', `${T}/${id2}/live`)).body.daten.neben.runden.length, 4);

  // mehr als 64
  r = await call('POST', T, { ...basis, kennung: 'cm-gross' });
  const id3 = r.body.id;
  await sql`insert into tco.turnier_teilnehmer (turnier_id, vorname, nachname) select ${id3}, 'V' || g, 'N' from generate_series(1, 65) g`;
  r = await call('POST', `${T}/${id3}/ko/auslosen`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /höchstens 64/);
});
