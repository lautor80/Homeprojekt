/**
 * Turniere – Monats-Gruppenliga: Gruppenschnitt, Spielplan, Gruppentabelle (Gleichstand, direkter Vergleich),
 * Auf-/Abstieg und Neueinsteiger (reine Logik) sowie der Ablauf über HTTP: Runde starten, Ergebnisse, „bemüht“,
 * Monatsabschluss (kampflos/keine Wertung), wieder öffnen, Runde 2 mit Auf-/Abstieg, Gesamtwertung nach Siegquote, Live öffentlich.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  einteilen, folgemonat, gesamtWertung, gruppenGroessen, gruppenSchneiden, gruppenTabelle, jederGegenJeden, monatAusStart, naechsteReihenfolge,
} from '../../modules/tco/server/turnier/liga-logik.js';
import type { Spiel } from '../../modules/tco/server/turnier/typen.js';

type SK = Pick<Spiel, 'feld' | 'a' | 'b' | 'saetze' | 'wertung' | 'sieger'>;
const sieg = (a: number, b: number, saetze: [number, number][] = [[6, 3], [6, 3]]): SK => ({ feld: 'gruppe', a: [a], b: [b], saetze, wertung: 'gespielt', sieger: 'a' });

// ------------------------------------------------------------------ reine Logik
test('Gruppenschnitt: 4..30 Personen, alle Gruppen 4 oder 5 (Sonderfälle 6, 7, 11 dokumentiert)', () => {
  for (const g of [4, 5] as const) {
    for (let n = 4; n <= 30; n++) {
      const gr = gruppenGroessen(n, g);
      assert.equal(gr.reduce((s, x) => s + x, 0), n, `Summe n=${n} g=${g}`);
      if (n === 6) assert.deepEqual(gr, [6]);
      else if (n === 7) assert.deepEqual(gr, [4, 3]);
      else if (n === 11) assert.deepEqual(gr, [4, 4, 3]);
      else assert.ok(gr.every((x) => x === 4 || x === 5), `n=${n} g=${g}: ${gr}`);
      // abweichende Gruppen stehen unten: Größen nur einmal wechselnd
      const wechsel = gr.slice(1).filter((x, i) => x !== gr[i]).length;
      assert.ok(wechsel <= 1, `n=${n} g=${g}: ${gr}`);
    }
  }
  assert.deepEqual(gruppenGroessen(13, 4), [4, 4, 5]);
  assert.deepEqual(gruppenGroessen(13, 5), [5, 4, 4]);
  assert.deepEqual(gruppenGroessen(20, 4), [4, 4, 4, 4, 4]);
  assert.deepEqual(gruppenGroessen(20, 5), [5, 5, 5, 5]);
  assert.deepEqual(gruppenGroessen(8, 5), [4, 4]);
  assert.deepEqual(gruppenGroessen(5, 4), [5]);
  assert.deepEqual(gruppenGroessen(3, 4), [3]);
  assert.deepEqual(gruppenGroessen(1, 4), []);
  assert.deepEqual(gruppenSchneiden([1, 2, 3, 4, 5, 6, 7, 8, 9], 4), [[1, 2, 3, 4], [5, 6, 7, 8, 9]]);
});

test('Jeder gegen jeden: alle Paarungen genau einmal', () => {
  for (const n of [3, 4, 5, 6, 7]) {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const p = jederGegenJeden(ids);
    assert.equal(p.length, (n * (n - 1)) / 2);
    assert.equal(new Set(p.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join('-'))).size, p.length);
  }
});

test('Gruppentabelle: Siege, Satzdifferenz, Spieldifferenz, direkter Vergleich, Startposition; ▲/▼', () => {
  // 1 und 2 je 2 Siege, gleiche Satz-/Spieldifferenz → direkter Vergleich: 2 schlug 1
  const sp: SK[] = [sieg(2, 1), sieg(1, 3), sieg(1, 4), sieg(2, 3, [[3, 6], [6, 3], [10, 5]]), sieg(4, 2, [[6, 3], [6, 3]]), sieg(3, 4, [[6, 0], [6, 0]])];
  // Spieldifferenzen ausgleichen ist hier nicht nötig: nur Reihenfolge prüfen
  const t = gruppenTabelle([1, 2, 3, 4], sp, { gruppe: 2, gruppen: 3 });
  assert.deepEqual(t.map((z) => z.siege), [2, 2, 1, 1]);
  assert.equal(t[0].kennzeichen, 'auf');
  assert.equal(t[3].kennzeichen, 'ab');
  // Dreier-Gleichstand (jeder ein Sieg)
  const gl: SK[] = [sieg(2, 1), sieg(1, 3), sieg(3, 2)];
  const t2 = gruppenTabelle([1, 2, 3], gl, { gruppe: 1, gruppen: 1 });
  assert.deepEqual(t2.map((z) => z.siege), [1, 1, 1]);
  assert.deepEqual(t2.map((z) => z.kennzeichen), [null, null, null], 'einzige Gruppe: kein Auf-/Abstieg');
  // Dreier-Gleichstand: Siege untereinander gleich → Startposition
  assert.deepEqual(t2.map((z) => z.teilnehmer_id), [1, 2, 3]);
  // ohne Spiele: Startposition
  assert.deepEqual(gruppenTabelle([7, 5, 6], [], { gruppe: 3, gruppen: 3 }).map((z) => [z.teilnehmer_id, z.kennzeichen, z.offen]), [[7, 'auf', 0], [5, null, 0], [6, null, 0]]);
  // Zweier-Gleichstand im direkten Vergleich: 4 schlug 3 trotz späterer Startposition
  const t3 = gruppenTabelle([3, 4], [sieg(4, 3)], { gruppe: 1, gruppen: 2 });
  assert.deepEqual(t3.map((z) => z.teilnehmer_id), [4, 3]);
  // echter Zweier-Gleichstand: gleiche Siege/Sätze/Spiele → direkter Vergleich
  const t4 = gruppenTabelle([1, 2, 3, 4], [sieg(1, 3), sieg(2, 4), sieg(2, 1), sieg(1, 4), sieg(3, 2), sieg(4, 3)], { gruppe: 1, gruppen: 2 });
  assert.deepEqual(t4.slice(0, 2).map((z) => [z.teilnehmer_id, z.siege]), [[2, 2], [1, 2]]);
  assert.equal(t4[3].kennzeichen, 'ab');
  // offene und „keine“ Spiele zählen nicht, offene werden gezählt
  const t5 = gruppenTabelle([1, 2], [{ feld: 'gruppe', a: [1], b: [2], saetze: null, wertung: 'offen', sieger: null }], { gruppe: 1, gruppen: 1 });
  assert.deepEqual(t5.map((z) => [z.spiele, z.offen]), [[0, 1], [0, 1]]);
});

test('Auf-/Abstieg, Abgemeldete, Neueinsteiger nach LK', () => {
  const p = (id: number, lk: number | null, rang: number | null = null) => ({ id, lk, rang });
  const aktive = [p(1, 1), p(2, 2), p(3, 3), p(4, 4), p(5, 5), p(6, 6), p(7, 7), p(8, 8), p(9, 9)];
  // Endstand: Gruppe 1 [4,3,2,1], Gruppe 2 [8,5,7,6,9]
  const r = naechsteReihenfolge([[4, 3, 2, 1], [8, 5, 7, 6, 9]], aktive, 'lk');
  assert.deepEqual(r.map((x) => x.id), [4, 3, 2, 8, 1, 5, 7, 6, 9]);
  assert.deepEqual(r.filter((x) => x.merkmal).map((x) => [x.id, x.merkmal]), [[8, 'auf'], [1, 'ab']]);
  // Abmeldung (5) und Neueinsteiger: Position = Anzahl mit gleicher/besserer LK; ohne LK ans Ende
  const r2 = naechsteReihenfolge([[4, 3, 2, 1], [8, 5, 7, 6, 9]], [...aktive.filter((x) => x.id !== 5), p(20, 7.5), p(21, null), p(22, 1.5)], 'lk');
  assert.deepEqual(r2.map((x) => x.id), [4, 22, 3, 2, 8, 1, 7, 20, 6, 9, 21]);
  assert.deepEqual(r2.filter((x) => x.merkmal === 'neu').map((x) => x.id), [22, 20, 21]);
  // Neueinsteiger 22 schiebt den Aufsteiger 8 über die Grenze – einteilen hält ihn in Gruppe 1 (tauscht mit 2)
  assert.deepEqual(gruppenSchneiden(r2.map((x) => x.id), 4), [[4, 22, 3, 2], [8, 1, 7, 20], [6, 9, 21]]);
  assert.deepEqual(einteilen(r2, 4).map((g) => g.map((x) => x.id)), [[4, 22, 3, 8], [2, 1, 7, 20], [6, 9, 21]]);
  // Abmeldung in Gruppe 1 würde den Absteiger 1 wieder hochziehen – er bleibt in Gruppe 2
  const r5 = naechsteReihenfolge([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12, 13]], [...Array(13)].map((_, i) => p(i + 1, i + 1)).filter((x) => x.id !== 2), 'lk');
  assert.deepEqual(gruppenSchneiden(r5.map((x) => x.id), 4), [[1, 3, 5, 4], [6, 7, 9, 8], [10, 11, 12, 13]]);
  assert.deepEqual(einteilen(r5, 4).map((g) => g.map((x) => x.id)), [[1, 3, 5, 6], [4, 7, 9, 10], [8, 11, 12, 13]]);
  // drei Gruppen: beide Grenzen tauschen
  const r3 = naechsteReihenfolge([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]], [...Array(12)].map((_, i) => p(i + 1, i + 1)), 'lk');
  assert.deepEqual(gruppenSchneiden(r3.map((x) => x.id), 4), [[1, 2, 3, 5], [4, 6, 7, 9], [8, 10, 11, 12]]);
  // manuelle Setzung: Rang des Neuen gegen Rang der Bestehenden
  const r4 = naechsteReihenfolge([[1, 2], [3, 4]], [p(1, null, 1), p(2, null, 2), p(3, null, 3), p(4, null, 4), p(5, null, 2)], 'manuell');
  assert.deepEqual(r4.map((x) => x.id), [1, 3, 5, 2, 4]);
});

test('Gesamtwertung nach Siegquote vor absoluten Siegen', () => {
  const sp: SK[] = [sieg(1, 2), sieg(1, 3), sieg(1, 4), sieg(5, 1), sieg(6, 7), sieg(6, 8),
    { feld: 'gruppe', a: [2], b: [3], saetze: null, wertung: 'keine', sieger: null }];
  const g = gesamtWertung(sp, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(g.slice(0, 3).map((x) => [x.teilnehmer_id, x.siege, x.quote]), [[6, 2, 1], [5, 1, 1], [1, 3, 0.75]], 'Quote vor Siegen; gleiche Quote: mehr Siege');
  assert.equal(g.at(-1)!.teilnehmer_id, 9, 'ohne Spiele ans Ende');
  assert.equal(monatAusStart('2027-04'), '2027-04-01');
  assert.equal(monatAusStart('2027-13'), null);
  assert.equal(folgemonat('2027-12-01'), '2028-01-01');
});

// ------------------------------------------------------------------ Ablauf über HTTP
const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown, ohneAnmeldung = false) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { ...(ohneAnmeldung ? {} : { cookie }), 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set && !ohneAnmeldung) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const T = '/api/m/tco/turniere';
const ok = (r: { status: number; body: any }) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => { await app?.close(); await sql.end(); });

test('Liga über HTTP: Runde 1, bemüht, Abschluss, Runde 2 mit Auf-/Abstieg, Gesamtwertung, Live', async () => {
  const basis = { name: 'Sommerliga', kennung: 'sommerliga-2027', modus: 'liga', status: 'anmeldung', einstellungen: { gruppengroesse: 4, setzung: 'lk', start: '2027-05', runden: 3 } };
  const { id } = ok(await call('POST', T, basis));
  const tn: number[] = [0]; // tn[k] = ID von Person k (LK k)
  for (let k = 1; k <= 13; k++) {
    tn.push(ok(await call('POST', `${T}/${id}/teilnehmer`, { vorname: `P${k}`, nachname: 'Test', lk: k })).id);
  }
  const P = (k: number) => tn[k];

  let v = ok(await call('GET', `${T}/${id}/liga/vorschau`));
  assert.equal(v.moeglich, true, v.hinweis);
  assert.equal(v.monat, '2027-05-01');
  assert.deepEqual(v.gruppen.map((g: any) => g.personen.length), [4, 4, 5]);
  assert.deepEqual(v.gruppen[0].personen.map((p: any) => p.id), [P(1), P(2), P(3), P(4)]);

  ok(await call('POST', `${T}/${id}/liga/runde`));
  assert.equal((await call('POST', `${T}/${id}/liga/runde`)).body.message, 'Monat 1 ist noch nicht abgeschlossen.');
  const d = ok(await call('GET', `${T}/${id}`));
  assert.equal(d.turnier.status, 'laeuft');
  assert.equal(d.spiele.length, 6 + 6 + 10);
  assert.ok(d.spiele.every((s: any) => s.feld === 'gruppe' && s.runde === 1 && s.runde_id === d.runden[0].id));
  assert.deepEqual(d.runden.map((r: any) => [r.nr, r.monat, r.status]), [[1, '2027-05-01', 'laeuft']]);
  // Neueinsteiger: Die Online-Anmeldung bleibt bei der Liga auch im laufenden Turnier offen
  const info = ok(await call('GET', `/api/m/tco/turnier/oeffentlich/sommerliga-2027`));
  assert.equal(info.offen, true);

  const spiel = (x: number, y: number) => d.spiele.find((s: any) => (s.a[0] === P(x) && s.b[0] === P(y)) || (s.a[0] === P(y) && s.b[0] === P(x)));
  const seite = (s: any, k: number) => (s.a[0] === P(k) ? 'a' : 'b');
  /** x schlägt y */
  async function gewinnt(x: number, y: number, saetze: [number, number][] = [[6, 2], [6, 3]]) {
    const s = spiel(x, y);
    const st = seite(s, x) === 'a' ? saetze : saetze.map(([p, q]) => [q, p]);
    ok(await call('POST', `${T}/${id}/spiele/${s.id}/ergebnis`, { wertung: 'gespielt', saetze: st }));
  }
  // Gruppe 1: 4 > 3 > 2 > 1
  await gewinnt(4, 3); await gewinnt(4, 2); await gewinnt(4, 1); await gewinnt(3, 2); await gewinnt(3, 1); await gewinnt(2, 1);
  // Gruppe 2: 8 gewinnt alles; 5–6 nur 5 bemüht (Verwaltung) → kampflos 5; 5–7 beide (persönliche Links) → keine; 6–7 keiner → keine
  await gewinnt(8, 5); await gewinnt(8, 6); await gewinnt(8, 7);
  const s56 = spiel(5, 6);
  ok(await call('PUT', `${T}/${id}/liga/spiele/${s56.id}/bemueht`, { bemueht: seite(s56, 5) }));
  const link = async (k: number) => (ok(await call('POST', `${T}/${id}/teilnehmer/${P(k)}/link`, { senden: false })).link as string).split('z=')[1];
  const z5 = await link(5), z7 = await link(7), z11 = await link(11), z1 = await link(1);
  const s57 = spiel(5, 7);
  assert.equal(ok(await call('POST', `/api/m/tco/turnier/liga/zugang/${z5}/bemueht`, { spiel_id: s57.id }, true)).bemueht, seite(s57, 5));
  assert.equal(ok(await call('POST', `/api/m/tco/turnier/liga/zugang/${z7}/bemueht`, { spiel_id: s57.id }, true)).bemueht, 'beide');
  assert.equal((await call('POST', `/api/m/tco/turnier/liga/zugang/${z1}/bemueht`, { spiel_id: s57.id }, true)).status, 404, 'fremdes Spiel');
  assert.match((await call('POST', `/api/m/tco/turnier/liga/zugang/${z1}/bemueht`, { spiel_id: spiel(4, 1).id }, true)).body.message, /schon ein Ergebnis/);
  // Gruppe 3: 9 schlägt 11, 12, 13; 10 schlägt 9 und 11; 11 bemüht sich gegen 12 → 11 gewinnt kampflos
  await gewinnt(9, 11); await gewinnt(9, 12); await gewinnt(9, 13); await gewinnt(10, 9); await gewinnt(10, 11);
  const s1112 = spiel(11, 12);
  assert.equal(ok(await call('POST', `/api/m/tco/turnier/liga/zugang/${z11}/bemueht`, { spiel_id: s1112.id }, true)).bemueht, seite(s1112, 11));

  // Abschluss
  let a = ok(await call('POST', `${T}/${id}/liga/runde/1/abschliessen`));
  assert.deepEqual(a, { kampflos: 2, keine: 22 - 14 - 2 });
  // wieder öffnen setzt die automatischen Wertungen zurück, erneut abschließen
  ok(await call('POST', `${T}/${id}/liga/runde/1/oeffnen`));
  let d1 = ok(await call('GET', `${T}/${id}`));
  assert.equal(d1.spiele.filter((s: any) => s.wertung === 'offen').length, 8);
  a = ok(await call('POST', `${T}/${id}/liga/runde/1/abschliessen`));
  assert.deepEqual(a, { kampflos: 2, keine: 6 });
  d1 = ok(await call('GET', `${T}/${id}`));
  const nach = (x: number, y: number) => d1.spiele.find((s: any) => s.id === spiel(x, y).id);
  assert.deepEqual([nach(5, 6).wertung, nach(5, 6).sieger], ['wo', seite(s56, 5)]);
  assert.deepEqual([nach(5, 7).wertung, nach(5, 7).sieger], ['keine', null]);
  assert.deepEqual([nach(6, 7).wertung, nach(6, 7).sieger], ['keine', null]);
  assert.deepEqual([nach(11, 12).wertung, nach(11, 12).sieger], ['wo', seite(s1112, 11)]);
  assert.match((await call('POST', `/api/m/tco/turnier/liga/zugang/${z11}/bemueht`, { spiel_id: spiel(11, 13).id }, true)).body.message, /abgeschlossen/);

  // Live (öffentlich, ohne Anmeldung): Tabellen und Kennzeichen
  let live = ok(await call('GET', '/api/m/tco/turnier/oeffentlich/sommerliga-2027/live', undefined, true));
  const L = live.daten;
  assert.equal(L.aktuell, 1);
  const r1 = L.runden[0];
  assert.deepEqual(r1.gruppen[0].tabelle.map((z: any) => z.teilnehmer_id), [P(4), P(3), P(2), P(1)]);
  assert.deepEqual(r1.gruppen[1].tabelle.map((z: any) => z.teilnehmer_id), [P(8), P(5), P(7), P(6)]);
  assert.deepEqual(r1.gruppen[1].tabelle.map((z: any) => z.kennzeichen), ['auf', null, null, 'ab']);
  assert.equal(r1.gruppen[0].tabelle[0].kennzeichen, null);
  assert.equal(r1.gruppen[2].tabelle[0].teilnehmer_id, P(9));
  assert.equal(r1.gruppen[2].tabelle.at(-1).kennzeichen, null, 'letzte Gruppe: kein Abstieg');
  assert.ok(!JSON.stringify(live).includes('email'), 'keine Kontaktdaten öffentlich');
  // Gesamtwertung: Quote vor Siegen – P10 (2/2) vor P9 (3/4); P4 und P8 3/3
  const gesamt = L.gesamt.map((z: any) => z.teilnehmer_id);
  assert.ok(gesamt.indexOf(P(10)) < gesamt.indexOf(P(9)));
  assert.deepEqual(L.gesamt.slice(0, 3).map((z: any) => z.quote), [1, 1, 1]);
  assert.equal(L.gesamt.find((z: any) => z.teilnehmer_id === P(9)).siege, 3);

  // Runde 2: P13 meldet sich ab, P20 mit LK 7,5 steigt neu ein
  ok(await call('PUT', `${T}/${id}/teilnehmer/${P(13)}`, { vorname: 'P13', nachname: 'Test', lk: 13, status: 'abgemeldet' }));
  const p20 = ok(await call('POST', `${T}/${id}/teilnehmer`, { vorname: 'P20', nachname: 'Neu', lk: 7.5 })).id;
  v = ok(await call('GET', `${T}/${id}/liga/vorschau`));
  assert.equal(v.moeglich, true, v.hinweis);
  assert.equal(v.monat, '2027-06-01');
  const ids = v.gruppen.map((g: any) => g.personen.map((p: any) => p.id));
  assert.deepEqual(ids[0], [P(4), P(3), P(2), P(8)]);
  // P20 (LK 7,5) kommt hinter 7 Bestehende mit besserer LK (Ende Gruppe 2); der Aufsteiger P9 bleibt trotzdem in Gruppe 2,
  // dafür beginnt P20 in Gruppe 3
  assert.deepEqual(ids[1], [P(1), P(5), P(7), P(9)]);
  assert.deepEqual(ids[2].slice(0, 3), [p20, P(6), P(10)]);
  assert.ok(!ids.flat().includes(P(13)));
  const merk = new Map(v.gruppen.flatMap((g: any) => g.personen.map((p: any) => [p.id, p.merkmal])));
  assert.deepEqual([merk.get(P(8)), merk.get(P(1)), merk.get(P(9)), merk.get(P(6)), merk.get(p20)], ['auf', 'ab', 'auf', 'ab', 'neu']);
  ok(await call('POST', `${T}/${id}/liga/runde`));
  assert.match((await call('POST', `${T}/${id}/liga/runde/1/oeffnen`)).body.message, /Folgemonat/);

  // Person verschieben (vor dem ersten Ergebnis) – Spiele beider Gruppen neu
  ok(await call('PUT', `${T}/${id}/liga/runde/2/einteilung`, { teilnehmer_id: p20, gruppe: 2 }));
  const d2 = ok(await call('GET', `${T}/${id}`));
  const r2spiele = d2.spiele.filter((s: any) => s.runde === 2);
  assert.equal(r2spiele.filter((s: any) => s.gruppe === 2).length, 10);
  assert.equal(r2spiele.filter((s: any) => s.gruppe === 3).length, 6);
  assert.ok(r2spiele.filter((s: any) => s.gruppe === 2).some((s: any) => s.a[0] === p20 || s.b[0] === p20));

  live = ok(await call('GET', `${T}/${id}/live`));
  assert.equal(live.daten.aktuell, 2);
  assert.deepEqual(live.daten.verlauf[P(8)].map((x: any) => x.gruppe), [2, 1]);
  assert.deepEqual(live.daten.verlauf[p20].map((x: any) => [x.nr, x.gruppe]), [[2, 2]]);
  assert.equal(live.daten.runden[1].offen, 6 + 10 + 6);

  // „beide“ über die Verwaltung, null setzt zurück
  const s = r2spiele[0];
  ok(await call('PUT', `${T}/${id}/liga/spiele/${s.id}/bemueht`, { bemueht: 'beide' }));
  ok(await call('PUT', `${T}/${id}/liga/spiele/${s.id}/bemueht`, { bemueht: null }));
  ok(await call('POST', `${T}/${id}/liga/runde/2/abschliessen`));
  ok(await call('POST', `${T}/${id}/liga/runde`));
  const v4 = ok(await call('GET', `${T}/${id}/liga/vorschau`));
  assert.equal(v4.moeglich, false);
  assert.match(v4.hinweis, /noch nicht abgeschlossen/);
  ok(await call('POST', `${T}/${id}/liga/runde/3/abschliessen`));
  assert.match(ok(await call('GET', `${T}/${id}/liga/vorschau`)).hinweis, /Alle 3 geplanten Monate/);
});
