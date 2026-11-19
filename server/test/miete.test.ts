/**
 * Vermietung (Modul miete) gegen eine echte Test-Datenbank: Haus mit zwei Parteien (EG selbst bewohnt, OG vermietet),
 * gemeinsamer Heizstrom mit Unterzählern, Mieteingänge mit Aufteilung, Monatsübersicht, Abrechnung, Rechte, Arbeitsvorrat.
 * Paperless und PDF (Gotenberg) laufen in der CI nicht – geprüft wird nur, dass ohne Zugang eine klare Meldung kommt.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder Datenbankname enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'miete';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { modulAktiv } = await import('../src/config.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

function client() {
  let cookie = '';
  return async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let body: any = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    return { status: res.statusCode, body };
  };
}

const ALLE = ['tco', 'transport', 'beispiel', 'miete', 'core'];
before(async () => {
  await sql.unsafe(`${ALLE.map((s) => `drop schema if exists ${s} cascade;`).join(' ')} drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  await sql.unsafe('drop schema if exists miete cascade');
  await sql.end();
});

test('Vermietung ist nur aktiv, wenn ausdrücklich genannt', () => {
  assert.ok(modulAktiv('miete'));
});

test('Haus mit zwei Parteien: Einnahmen aufteilen, mit Kosten vergleichen, Nebenkosten abrechnen', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/setup', { orgName: 'Haus', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' })).status, 200);
  const M = '/api/m/miete';
  const ok = (r: { status: number; body: any }) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

  // Wohnungen: EG selbst bewohnt (2 Personen), OG vermietet
  const eg = ok(await admin('POST', `${M}/einheiten`, { kuerzel: 'EG', bezeichnung: 'Erdgeschoss', flaeche: 90, personen: 2, eigennutzung: true })).id;
  const og = ok(await admin('POST', `${M}/einheiten`, { kuerzel: 'OG', bezeichnung: 'Obergeschoss', flaeche: 60, personen: 0 })).id;
  // Mietverhältnis mit 600 € Kaltmiete und 150 € Abschlag
  const v = ok(await admin('POST', `${M}/vertraege`, { einheit_id: og, name: 'Erika Mieterin', beginn: '2024-01-01', personen: 1, kondition: { kaltmiete: 600, nk_abschlag: 150 } }));
  assert.match(v.nummer, /^MV\d{4}$/);
  assert.equal((await admin('POST', `${M}/vertraege`, { einheit_id: og, name: 'X', beginn: '2024-05-01', ende: '2024-04-01', personen: 1, kondition: { kaltmiete: 1, nk_abschlag: 1 } })).status, 400, 'Ende vor Beginn');

  // Zähler: Heizstrom (Hauptzähler) mit Unterzähler OG
  const hz = ok(await admin('POST', `${M}/zaehler`, { bezeichnung: 'Heizstrom Wärmepumpe', art: 'strom' })).id;
  const hzOg = ok(await admin('POST', `${M}/zaehler`, { bezeichnung: 'Wärmemenge OG', art: 'waerme', einheit_id: og, haupt_id: hz })).id;
  for (const [z, a, b] of [[hz, 0, 6000], [hzOg, 0, 2400]] as const) {
    ok(await admin('POST', `${M}/zaehler/${z}/ablesungen`, { datum: '2024-12-31', stand: a }));
    ok(await admin('POST', `${M}/zaehler/${z}/ablesungen`, { datum: '2025-12-31', stand: b }));
  }
  // Kostenart Heizstrom: Verbrauch über den Hauptzähler, 30 % Grundkosten
  const arten = ok(await admin('GET', `${M}/kostenarten`));
  const heiz = arten.find((a: any) => a.bezeichnung === 'Heizstrom');
  assert.equal((await admin('PUT', `${M}/kostenarten/${heiz.id}`, { ...heiz, zaehler_id: null })).status, 400, 'Verbrauch ohne Hauptzähler');
  ok(await admin('PUT', `${M}/kostenarten/${heiz.id}`, { ...heiz, zaehler_id: hz, grundanteil: 30 }));
  const grundsteuer = arten.find((a: any) => a.bezeichnung === 'Grundsteuer').id;
  const reparatur = arten.find((a: any) => !a.umlagefaehig).id;

  // Kosten 2025: Heizstrom-Jahresrechnung, Grundsteuer-Jahresbescheid (zeitanteilig), Reparatur (nicht umlagefähig)
  ok(await admin('POST', `${M}/kosten`, { kostenart_id: heiz.id, datum: '2025-12-31', von: '2025-01-01', bis: '2025-12-31', betrag: 1800, lieferant: 'Stadtwerke' }));
  ok(await admin('POST', `${M}/kosten`, { kostenart_id: grundsteuer, datum: '2025-02-15', von: '2025-01-01', bis: '2025-12-31', betrag: 300, lieferant: 'Gemeinde' }));
  ok(await admin('POST', `${M}/kosten`, { kostenart_id: reparatur, datum: '2025-06-10', betrag: 500 }));
  assert.equal((await admin('POST', `${M}/kosten`, { kostenart_id: grundsteuer, datum: '2025-01-01', von: '2025-01-01', betrag: 1 })).status, 400, 'Zeitraum nur halb');

  // Mieteingänge: Monat Januar einzeln (Teilzahlung → anteilig), restliche Monate über den Monatslauf
  const soll = ok(await admin('GET', `${M}/soll?monat=2025-01-15`));
  assert.deepEqual(soll.map((s: any) => [s.miete, s.nk, s.bezahlt]), [[600, 150, 0]]);
  ok(await admin('POST', `${M}/zahlungen`, { vertrag_id: v.id, datum: '2025-01-03', monat: '2025-01-01', betrag: 375 }));
  let z = ok(await admin('GET', `${M}/zahlungen?jahr=2025`));
  assert.deepEqual([z[0].anteil_miete, z[0].anteil_nk], [300, 75], 'Teilzahlung im Verhältnis des Solls');
  assert.equal((await admin('POST', `${M}/zahlungen`, { vertrag_id: v.id, datum: '2025-01-20', monat: '2025-01-01', betrag: 375, anteil_miete: 300, anteil_nk: 70 })).status, 400, 'Summe stimmt nicht');
  ok(await admin('POST', `${M}/zahlungen`, { vertrag_id: v.id, datum: '2025-01-20', monat: '2025-01-01', betrag: 375, anteil_miete: 300, anteil_nk: 75 }));
  for (let m = 2; m <= 12; m++) {
    const monat = `2025-${String(m).padStart(2, '0')}-01`;
    assert.equal(ok(await admin('POST', `${M}/zahlungen/monat`, { monat, datum: monat, vertrag_ids: [v.id] })).erfasst, 1);
  }
  assert.equal(ok(await admin('POST', `${M}/zahlungen/monat`, { monat: '2025-12-01', datum: '2025-12-01', vertrag_ids: [v.id] })).erfasst, 0, 'Monat schon erfasst');
  z = ok(await admin('GET', `${M}/zahlungen?jahr=2025`));
  assert.equal(z.reduce((s: number, x: any) => s + x.anteil_nk, 0), 1800);

  // Monatsübersicht: Grundsteuer 300 €/Jahr → 25,48 € im Januar (31/365), davon OG 40 %; Reparatur im Juni
  const u = ok(await admin('GET', `${M}/uebersicht?jahr=2025`));
  const jan = u.monate[0];
  assert.equal(jan.istMiete, 600);
  assert.equal(jan.istNk, 150);
  assert.equal(jan.sollNk, 150);
  assert.equal(u.monate[5].nichtUmlagefaehig, 500);
  assert.equal(u.offen[0].offen, 0);

  // Abrechnung 2025: OG trägt 40 % der Grundsteuer und beim Heizstrom 30 % × 40 % + 70 % × 3840/6000
  const abr = ok(await admin('GET', `${M}/abrechnung?jahr=2025`));
  assert.deepEqual(abr.verteilung.hinweise, []);
  const a = abr.abrechnungen[0];
  const heizOg = Math.round((1800 * 0.3 * 0.4 + 1800 * 0.7 * 3840 / 6000) * 100) / 100;
  assert.equal(a.kosten, Math.round((heizOg + 120) * 100) / 100);
  assert.equal(a.vorauszahlungen, 1800);
  assert.equal(a.ergebnis, Math.round((a.kosten - 1800) * 100) / 100);
  assert.equal(a.positionen.length, 2, 'Reparatur ist nicht umlagefähig');
  assert.ok(abr.vermieter > 0, 'Anteil der selbst bewohnten Wohnung bleibt beim Vermieter');
  assert.equal(abr.frist, '2026-12-31');

  // Festschreiben (nur abgeschlossene Jahre), doppelt nicht, wieder öffnen nur mit Begründung
  assert.equal((await admin('POST', `${M}/abrechnung/festschreiben`, { jahr: 2099, vertrag_id: v.id })).status, 400);
  const fest = ok(await admin('POST', `${M}/abrechnung/festschreiben`, { jahr: 2025, vertrag_id: v.id }));
  assert.equal((await admin('POST', `${M}/abrechnung/festschreiben`, { jahr: 2025, vertrag_id: v.id })).status, 400);
  const nachher = ok(await admin('GET', `${M}/abrechnung?jahr=2025`));
  assert.equal(nachher.abrechnungen[0].festgeschrieben.ergebnis, a.ergebnis);
  assert.equal((await admin('DELETE', `${M}/abrechnungen/${fest.id}`, {})).status, 400, 'Begründung fehlt');
  ok(await admin('DELETE', `${M}/abrechnungen/${fest.id}`, { reason: 'Heizstrom korrigiert' }));
  ok(await admin('POST', `${M}/abrechnung/festschreiben`, { jahr: 2025, vertrag_id: v.id }));

  // Paperless nicht eingerichtet: klare Meldung statt Absturz
  assert.equal(ok(await admin('GET', `${M}/paperless/status`)).eingerichtet, false);
  const pl = await admin('GET', `${M}/paperless/suche?q=Strom`);
  assert.equal(pl.status, 400);
  assert.match(pl.body.message, /Paperless ist für die Vermietung nicht eingerichtet/);

  // Löschen mit Abhängigkeiten wird abgelehnt
  assert.equal((await admin('DELETE', `${M}/vertraege/${v.id}`, { reason: 'Test' })).status, 400);
  assert.equal((await admin('DELETE', `${M}/einheiten/${og}`, { reason: 'Test' })).status, 400);
  assert.equal(eg > 0, true);

  // Änderungsbelege
  const [{ n }] = await sql`select count(*)::int as n from core.change_header where object_type = 'MIETZAHLUNG'`;
  assert.ok(n >= 13);

  // Arbeitsvorrat: Anlage „Vermietung“ liefert Einträge ohne Fehler (offene Miete im laufenden Jahr: keine Zahlungen erfasst)
  const av = ok(await admin('GET', '/api/arbeitsvorrat'));
  const gruppe = av.gruppen.find((g: any) => g.modul === 'miete');
  assert.ok(gruppe, 'Block Vermietung im Arbeitsvorrat');
  assert.ok(!gruppe.aufgaben.some((x: any) => /Störung|Fehler/.test(x.titel)), JSON.stringify(gruppe.aufgaben));

  // Rechte: nur Anzeige der Einnahmen
  ok(await admin('POST', '/api/admin/roles', { id: 'MIETE_LESEN', name: 'Mieten lesen', permissions: ['miete.zahlungen:display'] }));
  const u2 = ok(await admin('POST', '/api/admin/users', { username: 'leser', displayName: 'Leser', password: 'geheim-geheim', roles: ['MIETE_LESEN'] }));
  assert.ok(u2);
  const leser = client();
  ok(await leser('POST', '/api/auth/login', { username: 'leser', password: 'geheim-geheim' }));
  ok(await leser('POST', '/api/auth/password', { current: 'geheim-geheim', next: 'neu-geheim-geheim' }));
  assert.equal((await leser('GET', `${M}/zahlungen?jahr=2025`)).status, 200);
  assert.equal((await leser('POST', `${M}/zahlungen`, { vertrag_id: v.id, datum: '2025-01-03', monat: '2025-01-01', betrag: 1 })).status, 403);
  assert.equal((await leser('GET', `${M}/abrechnung?jahr=2025`)).status, 403);
  assert.equal((await leser('GET', `${M}/kostenarten`)).status, 403);
});
