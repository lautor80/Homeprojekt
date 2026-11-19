/**
 * Integrationstest Turniere (Basisrouten): Turnier anlegen, öffentliche Anmeldung mit Warteliste und Mitglied-Erkennung,
 * persönlicher Link, Abmelden mit Nachrücken, Rechte, Ergebnis über den Link (fremdes Spiel, ungültiges Ergebnis),
 * Stärke-Rangliste. Die Bestätigungs-Mail scheitert mangels Mailanbindung – die Anmeldung muss trotzdem klappen.
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
type Antwort = { status: number; body: any };

function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown): Promise<Antwort> => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let body: any = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    return { status: res.statusCode, body };
  };
}
const admin = client();
const gast = client();
const ok = (r: Antwort) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const T = '/api/m/tco/turniere';
const TO = '/api/m/tco/turnier';
const schluesselAus = (link: string) => new URLSearchParams(link.split('?')[1]).get('z')!;

const person = (vorname: string, nachname: string, extra: Record<string, unknown> = {}) => ({
  vorname, nachname, geburtsjahr: 1990, email: `${vorname.toLowerCase()}@example.org`, telefon: null, lk: null, bemerkung: null,
  einwilligung: true, website: '', ...extra,
});

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists miete cascade;
                    drop schema if exists core cascade; drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  ok(await admin('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' }));
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, geburtsdatum, eintritt, austritt, mitglnrn) values
    ('0000000401', 'Moritz', 'Mitglied', '1990-04-01', '2010-01-01', null, '401')`;
  await sql`insert into tco.mitgliedera (adrnr, lk) values ('0000000401', 14.3)`;
});
after(async () => { await app?.close(); await sql.end(); });

let turnierId = 0;
const ids: Record<string, number> = {};
const links: Record<string, string> = {};

test('Turnier anlegen: Kennung eindeutig, Standard-Einstellungen, Entwurf öffentlich unsichtbar', async () => {
  const neu = { name: 'Clubmeisterschaft 2027', kennung: 'clubmeisterschaft-2027', modus: 'liga', beschreibung: 'Monatsliga', meldeschluss: null, max_teilnehmer: 3, einstellungen: {} };
  turnierId = ok(await admin('POST', T, neu)).id;
  assert.ok(turnierId > 0);
  const dup = await admin('POST', T, { ...neu, name: 'Nochmal' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.message, /schon vergeben/);
  const falsch = await admin('POST', T, { ...neu, kennung: 'Mit Leerzeichen' });
  assert.equal(falsch.status, 400);

  const d = ok(await admin('GET', `${T}/${turnierId}`));
  assert.equal(d.turnier.status, 'entwurf');
  assert.equal(d.turnier.einstellungen.gruppengroesse, 4, 'Standard-Einstellungen des Modus');
  assert.deepEqual(d.teilnehmer, []);

  // Entwurf: öffentlich nicht sichtbar
  assert.equal((await gast('GET', `${TO}/oeffentlich/clubmeisterschaft-2027`)).status, 404);
  assert.equal((await gast('GET', `${TO}/oeffentlich/clubmeisterschaft-2027/live`)).status, 404);
  assert.equal((await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('Anna', 'Frueh'))).status, 404);

  const liste = ok(await admin('GET', T));
  assert.deepEqual(liste.map((x: any) => [x.kennung, x.gemeldet, x.warteliste]), [['clubmeisterschaft-2027', 0, 0]]);
});

test('Rechte: ohne Anmeldung keine Verwaltungsrouten', async () => {
  for (const [m, p] of [['GET', T], ['GET', `${T}/${turnierId}`], ['POST', T], ['PUT', `${T}/${turnierId}/rangliste`], ['GET', `${T}/mitglieder?q=mo`], ['GET', `${T}/${turnierId}/live`]] as const) {
    const r = await gast(m, p, m === 'GET' ? undefined : { ids: [] });
    assert.equal(r.status, 401, `${m} ${p}: ${JSON.stringify(r.body)}`);
  }
});

test('Status „Anmeldung offen“: öffentliche Info und Anmeldung (Mail-Fehler bricht nicht ab)', async () => {
  const d = ok(await admin('GET', `${T}/${turnierId}`));
  ok(await admin('PUT', `${T}/${turnierId}`, { ...d.turnier, status: 'anmeldung' }));
  const nach = ok(await admin('GET', `${T}/${turnierId}`));
  assert.equal(nach.turnier.status, 'anmeldung');
  assert.deepEqual(nach.turnier.einstellungen, d.turnier.einstellungen, 'Einstellungen bleiben beim Ändern erhalten');

  let info = ok(await gast('GET', `${TO}/oeffentlich/clubmeisterschaft-2027`));
  assert.deepEqual([info.turnier.name, info.turnier.modus_text, info.gemeldet, info.frei, info.offen], ['Clubmeisterschaft 2027', 'Monats-Gruppenliga', 0, 3, true]);
  assert.equal(info.turnier.id, undefined, 'keine internen Felder');

  // ohne Einwilligung keine Anmeldung
  const ohne = await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('Anna', 'Erste', { einwilligung: false }));
  assert.equal(ohne.status, 400);
  // Honigtopf: freundliche Antwort, aber nichts gespeichert
  ok(await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('Bot', 'Spam', { website: 'http://spam' })));

  // Bestätigungs-Mail scheitert (keine Mailanbindung) – Anmeldung gilt trotzdem
  const a = ok(await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('Anna', 'Erste', { lk: '18,5', geschlecht: 'w' })));
  assert.equal(a.status, 'gemeldet');
  assert.match(a.text, /angemeldet/);
  assert.doesNotMatch(a.text, /Bestätigung/, 'Mail konnte nicht gesendet werden');
  assert.match(a.link, /^\/turnier-mein\?z=[A-Za-z0-9_-]{20,}$/);
  links.anna = schluesselAus(a.link);

  // Mitglied wird über Name + Geburtsjahr erkannt, LK aus dem Mitgliederstamm
  const m = ok(await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('moritz', 'MITGLIED', { email: null })));
  assert.equal(m.status, 'gemeldet');
  links.moritz = schluesselAus(m.link);

  const b = ok(await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('Bernd', 'Zweiter')));
  assert.equal(b.status, 'gemeldet');
  links.bernd = schluesselAus(b.link);

  // Doppelanmeldung (gleicher Name und Jahrgang, andere Schreibweise)
  const dup = await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('anna', 'erste'));
  assert.equal(dup.status, 400);
  assert.match(dup.body.message, /bereits angemeldet/);

  // max_teilnehmer = 3 erreicht → Warteliste
  info = ok(await gast('GET', `${TO}/oeffentlich/clubmeisterschaft-2027`));
  assert.deepEqual([info.gemeldet, info.frei], [3, 0]);
  const w = ok(await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('Wilma', 'Warte')));
  assert.equal(w.status, 'warteliste');
  assert.match(w.text, /Warteliste/);
  links.wilma = schluesselAus(w.link);

  const tn = ok(await admin('GET', `${T}/${turnierId}`)).teilnehmer as any[];
  for (const x of tn) ids[x.vorname.toLowerCase()] = x.id;
  assert.deepEqual(tn.map((x) => [x.vorname, x.status]), [['Anna', 'gemeldet'], ['moritz', 'gemeldet'], ['Bernd', 'gemeldet'], ['Wilma', 'warteliste']]);
  const anna = tn.find((x) => x.vorname === 'Anna');
  assert.deepEqual([anna.lk, anna.geschlecht, anna.adrnr], [18.5, 'w', null]);
  const moritz = tn.find((x) => x.vorname === 'moritz');
  assert.deepEqual([moritz.adrnr, moritz.lk], ['0000000401', 14.3], 'Mitglied erkannt, LK übernommen');
  assert.equal(tn.some((x) => x.vorname === 'Bot'), false, 'Honigtopf speichert nichts');

  const liste = ok(await admin('GET', T));
  assert.deepEqual([liste[0].gemeldet, liste[0].warteliste], [3, 1]);
});

test('persönlicher Link: eigene Daten; Abmelden lässt die Warteliste nachrücken', async () => {
  const z = ok(await gast('GET', `${TO}/zugang/${links.bernd}`));
  assert.deepEqual([z.ich.vorname, z.ich.nachname, z.ich.status], ['Bernd', 'Zweiter', 'gemeldet']);
  assert.equal(z.turnier.kennung, 'clubmeisterschaft-2027');
  assert.deepEqual(z.spiele, []);
  assert.equal((await gast('GET', `${TO}/zugang/ungueltiger-schluessel-1234567890`)).status, 404);
  assert.equal((await gast('GET', `${TO}/zugang/kurz`)).status, 404);

  const r = ok(await gast('POST', `${TO}/zugang/${links.bernd}/abmelden`));
  assert.match(r.text, /abgemeldet/);
  assert.equal((await gast('GET', `${TO}/zugang/${links.bernd}`)).status, 404, 'Link nach Abmeldung ungültig');
  const tn = ok(await admin('GET', `${T}/${turnierId}`)).teilnehmer as any[];
  assert.equal(tn.find((x) => x.id === ids.bernd).status, 'abgemeldet');
  assert.equal(tn.find((x) => x.id === ids.wilma).status, 'gemeldet', 'Wilma rückt nach');
  assert.equal(ok(await gast('GET', `${TO}/zugang/${links.wilma}`)).ich.status, 'gemeldet');

  // Wer auf der Warteliste steht und sich abmeldet, lässt niemanden nachrücken
  const w2 = ok(await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('Walter', 'Warte')));
  assert.equal(w2.status, 'warteliste');
  const w3 = ok(await gast('POST', `${TO}/oeffentlich/clubmeisterschaft-2027/anmeldung`, person('Wanda', 'Warte')));
  assert.equal(w3.status, 'warteliste');
  ok(await gast('POST', `${TO}/zugang/${schluesselAus(w2.link)}/abmelden`));
  const nach = ok(await admin('GET', `${T}/${turnierId}`)).teilnehmer as any[];
  assert.equal(nach.find((x: any) => x.vorname === 'Wanda').status, 'warteliste');
  assert.equal(nach.filter((x: any) => x.status === 'gemeldet').length, 3);
  ids.wanda = nach.find((x: any) => x.vorname === 'Wanda').id;
});

test('Verwaltung: Teilnehmer manuell, neuer Link (Mail scheitert), Mitgliedersuche', async () => {
  const neu = ok(await admin('POST', `${T}/${turnierId}/teilnehmer`, { vorname: 'Gerd', nachname: 'Gast', geburtsjahr: '1975', lk: 'LK 21,0', status: 'warteliste', email: 'gerd@example.org' }));
  ids.gerd = neu.id;
  const l = ok(await admin('POST', `${T}/${turnierId}/teilnehmer/${ids.gerd}/link`, { senden: true }));
  assert.match(l.link, /\/turnier-mein\?z=/);
  assert.match(l.text, /nicht per E-Mail/);
  assert.equal(ok(await gast('GET', `${TO}/zugang/${schluesselAus(l.link)}`)).ich.lk, 21);
  const treffer = ok(await admin('GET', `${T}/mitglieder?q=mitgl`));
  assert.deepEqual(treffer.map((x: any) => [x.adrnr, x.lk, x.geburtsjahr]), [['0000000401', 14.3, 1990]]);
});

test('Ergebnis über den persönlichen Link: fremdes Spiel 403, ungültiges Ergebnis 400', async () => {
  // Liga-Spiel Anna gegen Moritz direkt anlegen (ohne Auslosung)
  const [s] = await sql<{ id: number }[]>`insert into tco.turnier_spiele (turnier_id, feld, runde, gruppe, a, b)
    values (${turnierId}, 'gruppe', 1, 1, ${[ids.anna]}, ${[ids.moritz]}) returning id`;
  const fremd = await gast('POST', `${TO}/zugang/${links.wilma}/ergebnis`, { spiel_id: s.id, wertung: 'gespielt', saetze: [[6, 4], [6, 4]] });
  assert.equal(fremd.status, 403);
  assert.match(fremd.body.message, /nicht mit/);

  const falsch = await gast('POST', `${TO}/zugang/${links.anna}/ergebnis`, { spiel_id: s.id, wertung: 'gespielt', saetze: [[6, 5], [6, 4]] });
  assert.equal(falsch.status, 400);
  assert.match(falsch.body.message, /Satz 1 6:5 ist kein gültiges Ergebnis/);
  const unvollstaendig = await gast('POST', `${TO}/zugang/${links.anna}/ergebnis`, { spiel_id: s.id, wertung: 'gespielt', saetze: [[6, 4], [4, 6]] });
  assert.equal(unvollstaendig.status, 400);
  assert.match(unvollstaendig.body.message, /Match-Tiebreak/);

  // Spiel bleibt offen
  let z = ok(await gast('GET', `${TO}/zugang/${links.anna}`));
  assert.deepEqual(z.spiele.map((x: any) => [x.wertung, x.meine_seite, x.namen_b]), [['offen', 'a', ['moritz MITGLIED']]]);

  // gültig: 6:4 3:6 10:8 aus Sicht von Moritz (Seite b) eingetragen
  ok(await gast('POST', `${TO}/zugang/${links.moritz}/ergebnis`, { spiel_id: s.id, wertung: 'gespielt', saetze: [[6, 4], [3, 6], [10, 8]] }));
  z = ok(await gast('GET', `${TO}/zugang/${links.anna}`));
  assert.deepEqual([z.spiele[0].wertung, z.spiele[0].sieger, z.spiele[0].saetze, z.spiele[0].eingetragen_von], ['gespielt', 'a', [[6, 4], [3, 6], [10, 8]], 'moritz MITGLIED']);

  // ausgelost: Abmelden über den Link nicht mehr möglich, Löschen in der Verwaltung auch nicht
  const ab = await gast('POST', `${TO}/zugang/${links.anna}/abmelden`);
  assert.equal(ab.status, 400);
  assert.match(ab.body.message, /bereits ausgelost/);
  assert.equal((await admin('DELETE', `${T}/${turnierId}/teilnehmer/${ids.anna}`)).status, 400);
  // mit Ergebnis lässt sich das Turnier nicht löschen
  const del = await admin('DELETE', `${T}/${turnierId}`);
  assert.equal(del.status, 400);
  assert.match(del.body.message, /beendet/);
});

test('Stärke-Rangliste speichern', async () => {
  ok(await admin('PUT', `${T}/${turnierId}/rangliste`, { ids: [ids.wilma, ids.moritz, ids.anna] }));
  let tn = ok(await admin('GET', `${T}/${turnierId}`)).teilnehmer as any[];
  const rang = (id: number) => tn.find((x) => x.id === id).rang;
  assert.deepEqual([rang(ids.wilma), rang(ids.moritz), rang(ids.anna), rang(ids.wanda)], [1, 2, 3, null]);
  // erneut speichern ersetzt die alte Reihenfolge vollständig
  ok(await admin('PUT', `${T}/${turnierId}/rangliste`, { ids: [ids.anna, ids.wanda] }));
  tn = ok(await admin('GET', `${T}/${turnierId}`)).teilnehmer as any[];
  assert.deepEqual([rang(ids.anna), rang(ids.wanda), rang(ids.wilma), rang(ids.moritz)], [1, 2, null, null]);
});

test('Live-Daten: öffentlich gekürzte Namen, Verwaltung volle Namen; Löschen ohne Ergebnisse', async () => {
  const pub = ok(await gast('GET', `${TO}/oeffentlich/clubmeisterschaft-2027/live`));
  assert.equal(pub.turnier.modus, 'liga');
  const anna = pub.teilnehmer.find((x: any) => x.id === ids.anna);
  assert.equal(anna.name, 'Anna E.');
  assert.equal(pub.teilnehmer.some((x: any) => x.id === ids.bernd), false, 'Abgemeldete fehlen');
  const intern = ok(await admin('GET', `${T}/${turnierId}/live`));
  assert.equal(intern.teilnehmer.find((x: any) => x.id === ids.anna).name, 'Anna Erste');

  const leer = ok(await admin('POST', T, { name: 'Spaß', kennung: 'spass-1', modus: 'spass' }));
  ok(await admin('DELETE', `${T}/${leer.id}`));
  assert.equal((await admin('GET', `${T}/${leer.id}`)).status, 404);
});
