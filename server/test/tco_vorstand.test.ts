/**
 * Vorstandssitzungen: Vorstand aus der Mitgliedergruppe, Sitzung mit Veranstaltung, Teilnahme, Tagesordnung, Beschlüsse
 * mit Nummern, Aufgaben (auch nach der Freigabe), Anlagen, PDF, Freigabe, Import alter Protokolle (Markdown), Rechte,
 * Arbeitsvorrat.
 *
 * Eigene Testdaten: Mitglieder „VST-…“, Gruppe „Vorstand“, Veranstaltungen und Sitzungen im Jahr 2090.
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
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, roh: res.rawPayload, typ: ct, kopf: res.headers };
  };
}
const call = client();
const V = '/api/m/tco/vorstand';
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let gruppe = 0;

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await call('POST', '/api/auth/login', { username: 'admin', password: 'geheim-geheim' });
  for (const [adrnr, vorname, nachname] of [['VST-1', 'Torsten', 'Laub'], ['VST-2', 'Erika', 'Muster'], ['VST-3', 'Hans', 'Beispiel'], ['VST-9', 'Karl', 'Ausgetreten']]) {
    await sql`insert into tco.mitglieder (adrnr, vorname, nachname, austritt) values (${adrnr}, ${vorname}, ${nachname}, ${adrnr === 'VST-9' ? '2000-12-31' : null})`;
  }
  [{ id: gruppe }] = await sql`insert into tco.kal_gruppen (name) values ('Vorstand') returning id`;
  const [{ id: kasse }] = await sql`insert into tco.kal_gruppen (name, parent_id) values ('Kassenwart', ${gruppe}) returning id`;
  await sql`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr, rolle) values (${gruppe}, 'VST-1', 'Schriftführer'), (${gruppe}, 'VST-2', null), (${gruppe}, 'VST-9', null)`;
  await sql`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr) values (${kasse}, 'VST-3')`;
});
after(async () => {
  await app?.close();
  await sql.end();
});

let sid = 0;

test('Vorstand: Gruppe „Vorstand“ samt Untergruppen, ohne Ausgetretene; Rolle aus Gruppe oder Untergruppe', async () => {
  const r = await call('GET', V);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.cfg, { gruppe_id: gruppe, gruppe: 'Vorstand', automatisch: true });
  assert.deepEqual(r.body.vorstand.map((m: any) => [m.adrnr, m.name, m.rolle]), [
    ['VST-3', 'Beispiel, Hans', 'Kassenwart'], ['VST-1', 'Laub, Torsten', 'Schriftführer'], ['VST-2', 'Muster, Erika', null],
  ]);
  assert.equal(r.body.pflege, true);
  assert.equal(r.body.freigabe, true);
});

test('Sitzung anlegen: Veranstaltung im Kalender, Vorstand als Teilnehmer, Tagesordnung vorgeschlagen', async () => {
  const r = await call('POST', `${V}/sitzungen`, { titel: 'Vorstandssitzung November', datum: '2090-11-25', beginn: '19:30', ort: 'Clubhaus', event_anlegen: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sid = r.body.id;
  const s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.equal(s.nr, 'VS 2090/01');
  assert.equal(s.status, 'GEPLANT');
  assert.equal(s.datum, '2090-11-25');
  assert.equal(s.beginn, '19:30');
  assert.ok(s.event, 'Veranstaltung verknüpft');
  const [ev] = await sql`select kategorie, gruppen, anmeldung, ort from tco.kal_events where id = ${s.event.id}`;
  assert.deepEqual([ev.kategorie, ev.gruppen, ev.anmeldung, ev.ort], ['SITZUNG', [gruppe], true, 'Clubhaus']);
  assert.deepEqual(s.teilnehmer.map((t: any) => [t.name, t.art, t.status]), [
    ['Beispiel, Hans', 'VORSTAND', 'OFFEN'], ['Laub, Torsten', 'VORSTAND', 'OFFEN'], ['Muster, Erika', 'VORSTAND', 'OFFEN'],
  ]);
  assert.deepEqual(s.tops.map((t: any) => t.titel), ['Begrüßung und Feststellung der Beschlussfähigkeit', 'Verschiedenes']);
  assert.equal(s.protokoll_von, 'Admin');

  // dieselbe Veranstaltung lässt sich nicht an eine zweite Sitzung hängen
  const zwei = await call('POST', `${V}/sitzungen`, { titel: 'Doppelt', datum: '2090-11-25', event_id: s.event.id });
  assert.equal(zwei.status, 400);
  assert.match(zwei.body.message, /schon mit einer anderen Sitzung/);
});

test('Veranstaltung: Termin im Kalender verschoben – die Sitzung zieht mit; Absagen werden „entschuldigt“; lösen behält die Daten', async () => {
  const s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  await sql`update tco.kal_events set beginn = '2090-11-26 18:00+01', ort = 'Halle' where id = ${s.event.id}`;
  await sql`insert into tco.kal_anmeldungen (event_id, adrnr, status) values (${s.event.id}, 'VST-2', 'ABSAGE'), (${s.event.id}, 'VST-1', 'ZUSAGE')`;
  const r = await call('POST', `${V}/sitzungen/${sid}/vorstand`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.absagen, 1);
  let d = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.deepEqual([d.datum, d.beginn, d.ort, d.event.zusagen, d.event.absagen], ['2090-11-26', '18:00', 'Halle', 1, 1]);
  assert.deepEqual(d.teilnehmer.map((t: any) => [t.name, t.status, t.rueckmeldung]), [
    ['Beispiel, Hans', 'OFFEN', null], ['Laub, Torsten', 'OFFEN', 'ZUSAGE'], ['Muster, Erika', 'ENTSCHULDIGT', 'ABSAGE'],
  ]);
  // lösen und wieder verknüpfen
  const ev = d.event.id;
  assert.equal((await call('POST', `${V}/sitzungen/${sid}/veranstaltung`, {})).status, 200);
  d = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.deepEqual([d.event, d.datum, d.beginn, d.ort], [null, '2090-11-26', '18:00', 'Halle']);
  assert.equal((await call('POST', `${V}/sitzungen/${sid}/veranstaltung`, { event_id: ev })).status, 200);
  assert.equal((await call('GET', `${V}/sitzungen/${sid}`)).body.event.id, ev);
});

let top = 0, aufgabe = 0;
test('Tagesordnung, Beschlüsse mit fortlaufender Nummer, Aufgaben, Gäste, Beschlussfähigkeit', async () => {
  let r = await call('POST', `${V}/sitzungen/${sid}/tops`, { titel: 'Sanierung Platz 4', verantwortlich: 'Platzwart', text: 'Zwei Angebote liegen vor.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  top = r.body.id;
  let s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.deepEqual(s.tops.map((t: any) => `${t.nr} ${t.titel}`), ['1 Begrüßung und Feststellung der Beschlussfähigkeit', '2 Sanierung Platz 4', '3 Verschiedenes'], 'vor „Verschiedenes“');

  r = await call('POST', `${V}/tops/${top}/eintraege`, { art: 'BESCHLUSS', text: 'Angebot B wird beauftragt.', ja: 2, nein: 0, enthaltung: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${V}/tops/${top}/eintraege`, { art: 'BESCHLUSS', text: 'Angebot A wird abgelehnt.', ja: 0, nein: 2 });
  r = await call('POST', `${V}/tops/${top}/eintraege`, { art: 'AUFGABE', text: 'Auftrag erteilen', verantwortlich: 'Platzwart', faellig: '2000-01-01', ja: 5 });
  aufgabe = r.body.id;
  await call('POST', `${V}/tops/${top}/eintraege`, { art: 'INFO', text: 'Gelder sind im Haushalt eingeplant.' });
  s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  const e = s.tops[1].eintraege;
  assert.deepEqual(e.map((x: any) => [x.art, x.nr, x.ergebnis, x.ja]), [
    ['BESCHLUSS', 'B 2090/001', 'ANGENOMMEN', 2], ['BESCHLUSS', 'B 2090/002', 'ABGELEHNT', 0], ['AUFGABE', null, null, null], ['INFO', null, null, null],
  ]);
  assert.equal(e[2].faellig, '2000-01-01');
  // aus einem Beschluss wird keine Aufgabe (die Nummer bleibt)
  r = await call('PUT', `${V}/eintraege/${e[0].id}`, { art: 'AUFGABE', text: 'x' });
  assert.equal(r.status, 400);

  // Teilnahme und Gäste
  const tn = s.teilnehmer;
  await call('PUT', `${V}/teilnehmer/${tn[0].id}`, { status: 'ANWESEND' });
  assert.equal((await call('GET', `${V}/sitzungen/${sid}`)).body.beschlussfaehig.ok, false);
  await call('POST', `${V}/sitzungen/${sid}/teilnahme`, { status: 'ANWESEND' });
  assert.equal((await call('POST', `${V}/sitzungen/${sid}/gaeste`, { name: 'Jugendtrainer', rolle: 'für TOP 4' })).status, 200);
  s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.deepEqual(s.beschlussfaehig, { anwesend: 2, gesamt: 3, ok: true });
  assert.deepEqual(s.teilnehmer.map((t: any) => [t.name, t.art, t.status]).at(-1), ['Jugendtrainer', 'GAST', 'ANWESEND']);

  // Reihenfolge
  const ids = s.tops.map((t: any) => t.id);
  assert.equal((await call('POST', `${V}/sitzungen/${sid}/reihenfolge`, { tops: [ids[1], ids[0], ids[2]] })).status, 200);
  assert.equal((await call('POST', `${V}/sitzungen/${sid}/reihenfolge`, { tops: [ids[1], ids[0]] })).status, 400);
  s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.equal(s.tops[0].titel, 'Sanierung Platz 4');

  // Beschlussregister und Aufgaben
  const b = (await call('GET', `${V}/beschluesse?jahr=2090`)).body.beschluesse;
  assert.deepEqual(b.map((x: any) => [x.nr, x.sitzung_nr, x.top]), [['B 2090/002', 'VS 2090/01', 'Sanierung Platz 4'], ['B 2090/001', 'VS 2090/01', 'Sanierung Platz 4']]);
  const a = (await call('GET', `${V}/aufgaben?offen=1`)).body.aufgaben;
  assert.deepEqual(a.map((x: any) => [x.text, x.stand]), [['Auftrag erteilen', 'UEBERFAELLIG']]);
});

test('Anlagen: zur Sitzung und zum Tagesordnungspunkt, Abruf, Löschen', async () => {
  let r = await call('POST', `${V}/sitzungen/${sid}/anlagen`, { dateien: [{ name: 'Einladung.pdf', data: b64(PDF) }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${V}/sitzungen/${sid}/anlagen`, { top_id: top, dateien: [{ name: 'Angebot B.pdf', data: `data:application/pdf;base64,${b64(PDF)}` }, { name: 'Notiz.txt', data: b64('Hallo') }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.deepEqual(s.anlagen.map((a: any) => [a.dateiname, a.mime, a.top_id]), [
    ['Einladung.pdf', 'application/pdf', null], ['Angebot B.pdf', 'application/pdf', top], ['Notiz.txt', 'text/plain', top],
  ]);
  const d = await call('GET', `${V}/sitzungen/${sid}/anlagen/${s.anlagen[1].id}`);
  assert.equal(d.typ, 'application/pdf');
  assert.equal(d.roh.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call('DELETE', `${V}/sitzungen/${sid}/anlagen/${s.anlagen[2].id}`)).status, 200);
  // falscher Tagesordnungspunkt
  r = await call('POST', `${V}/sitzungen/${sid}/anlagen`, { top_id: 999999, dateien: [{ name: 'x.pdf', data: b64(PDF) }] });
  assert.equal(r.status, 400);
});

test('Verantwortliche: Kürzel werden mit Vornamen angezeigt und so gesichert', async () => {
  // alter Bestand (z. B. Import): nur Kürzel in der Datenbank
  const [t] = await sql`insert into tco.vs_tops (sitzung_id, pos, titel, verantwortlich) values (${sid}, 99, 'Kürzel', 'laub, mus') returning id`;
  await sql`insert into tco.vs_eintraege (top_id, pos, art, text, verantwortlich) values (${t.id}, 0, 'AUFGABE', 'Altlast', 'beisp')`;
  let s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  const top9 = s.tops.find((x: any) => x.id === t.id);
  assert.equal(top9.verantwortlich, 'Torsten Laub, Erika Muster');
  assert.equal(top9.eintraege[0].verantwortlich, 'Hans Beispiel');
  const a = (await call('GET', `${V}/aufgaben`)).body.aufgaben.find((x: any) => x.text === 'Altlast');
  assert.equal(a.verantwortlich, 'Hans Beispiel', 'auch in der Aufgabenliste');
  // beim Sichern in die volle Form gebracht
  assert.equal((await call('PUT', `${V}/tops/${t.id}`, { titel: 'Kürzel', verantwortlich: 'erika', text: null, status: 'OFFEN' })).status, 200);
  assert.equal((await sql`select verantwortlich from tco.vs_tops where id = ${t.id}`)[0].verantwortlich, 'Erika Muster');
  assert.equal((await call('DELETE', `${V}/tops/${t.id}`)).status, 200);
  s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.equal(s.tops.find((x: any) => x.titel === 'Sanierung Platz 4').verantwortlich, 'Platzwart', 'Rollen bleiben');
});

test('Links als Anlage und formatierter Protokolltext (auch im PDF)', async () => {
  let r = await call('POST', `${V}/sitzungen/${sid}/links`, { top_id: top, url: 'https://www.tc-oberthal.de/platz4', bezeichnung: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${V}/sitzungen/${sid}/links`, { url: 'www.nuliga.de', bezeichnung: 'Spielplan  nuLiga' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const url of ['javascript:alert(1)', 'ftp://x.de/a', 'kein link']) {
    assert.equal((await call('POST', `${V}/sitzungen/${sid}/links`, { url })).status, 400, url);
  }
  assert.equal((await call('POST', `${V}/sitzungen/${sid}/links`, { top_id: 999999, url: 'https://x.de' })).status, 400, 'fremder TOP');
  const s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  const links = s.anlagen.filter((a: any) => a.url);
  assert.deepEqual(links.map((a: any) => [a.dateiname, a.url, a.top_id, a.groesse]), [
    ['tc-oberthal.de', 'https://www.tc-oberthal.de/platz4', top, 0], ['Spielplan nuLiga', 'https://www.nuliga.de/', null, 0],
  ]);
  // Abruf einer Link-Anlage leitet weiter
  const w = await call('GET', `${V}/sitzungen/${sid}/anlagen/${links[0].id}`);
  assert.equal(w.status, 302);
  assert.equal(w.kopf.location, 'https://www.tc-oberthal.de/platz4');
  // formatierter Text wird gespeichert, wie er ist, und im PDF gesetzt (Prüfung unten beim PDF)
  await sql`update tco.vs_tops set text = ${'**Ergebnis:** Angebot *B* ist ~~teurer~~ günstiger.\n\n- Ausführung im **März**\n- Details: [Angebot](https://www.tc-oberthal.de/angebot) und https://www.nuliga.de\n1. erstens\n2. zweitens'} where id = ${top}`;
  const pdf = await call('GET', `${V}/sitzungen/${sid}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.roh.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.roh.toString('latin1').includes('/URI (https://www.tc-oberthal.de/angebot)'), 'Verknüpfung im PDF anklickbar');
});

test('Arbeitsvorrat: überfällige Aufgabe und Protokoll zur Freigabe, abhaken aus dem Arbeitsvorrat', async () => {
  await call('POST', `${V}/sitzungen/${sid}/status`, { status: 'LAEUFT' });
  assert.equal((await call('POST', `${V}/sitzungen/${sid}/status`, { status: 'ENTWURF' })).status, 200);
  const keys = JSON.stringify((await call('GET', '/api/arbeitsvorrat')).body);
  assert.ok(keys.includes(`VS_AUFGABE:${aufgabe}`), 'überfällige Aufgabe im Arbeitsvorrat');
  assert.ok(keys.includes(`VS_FREIGABE:${sid}`), 'Protokoll zur Freigabe im Arbeitsvorrat');
  assert.ok(keys.includes(`/tco/vorstand?sitzung=${sid}`));
});

test('Freigabe: nur vollständig, danach schreibgeschützt (Aufgaben abhaken geht), zurücknehmen, PDF', async () => {
  // ein offener Teilnehmer verhindert die Freigabe
  await call('POST', `${V}/sitzungen/${sid}/vorstand`);
  await sql`insert into tco.vs_teilnehmer (sitzung_id, adrnr, name, art) values (${sid}, 'VST-X', 'Offen, Otto', 'VORSTAND')`;
  let r = await call('POST', `${V}/sitzungen/${sid}/status`, { status: 'FREIGEGEBEN' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /fehlt noch die Teilnahme/);
  await sql`delete from tco.vs_teilnehmer where adrnr = 'VST-X'`;
  r = await call('POST', `${V}/sitzungen/${sid}/status`, { status: 'FREIGEGEBEN' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.equal(s.status, 'FREIGEGEBEN');
  assert.equal(s.freigegeben_von, 'Admin');
  assert.deepEqual(s.naechste, ['ENTWURF']);

  r = await call('POST', `${V}/sitzungen/${sid}/tops`, { titel: 'Nachtrag' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /freigegeben/);
  assert.equal((await call('DELETE', `${V}/sitzungen/${sid}`)).status, 400);
  r = await call('POST', `${V}/aufgaben/${aufgabe}/erledigt`, { erledigt: true });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', `${V}/aufgaben?offen=1`)).body.aufgaben.length, 0);

  const pdf = await call('GET', `${V}/sitzungen/${sid}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.typ, 'application/pdf');
  assert.equal(pdf.roh.subarray(0, 5).toString(), '%PDF-');

  r = await call('POST', `${V}/sitzungen/${sid}/status`, { status: 'ENTWURF', grund: 'Tippfehler' });
  assert.equal(r.status, 200);
  s = (await call('GET', `${V}/sitzungen/${sid}`)).body;
  assert.deepEqual([s.status, s.freigegeben_am], ['ENTWURF', null]);
  await call('POST', `${V}/sitzungen/${sid}/status`, { status: 'FREIGEGEBEN' });
});

const MD = `---
datum: 2090-03-04
ort: Clubhaus
anwesend: Laub, Torsten, Muster, Erika
entschuldigt: Hans Beispiel
gäste: Fremder Gast
---
# Vorstandssitzung März

## TOP 1 Hallenpreise
Diskussion, siehe [Preisliste](anlagen/Preisliste.pdf).

**Beschluss:** Preise bleiben unverändert. (5/0/1)

- [ ] Aushang aktualisieren @Hallenwart bis 10.3.
- [x] Preise prüfen @Kassenwart

## TOP 2 Verschiedenes
Nichts. [Fehlt](anlagen/gibtsnicht.pdf)
`;

test('Import: prüfen schreibt nichts, übernehmen legt freigegebene Sitzungen mit Anlagen an, Duplikate werden übersprungen', async () => {
  const dateien = [
    { name: '2090-03-04_Vorstand.md', data: b64(MD) },
    { name: 'Preisliste.pdf', data: b64(PDF) },
    { name: 'ohne-datum.md', data: b64('# Notiz\n\n## Punkt\nText') },
    { name: '2090-03-04 Kopie.md', data: b64(MD) },
  ];
  let r = await call('POST', `${V}/import`, { dateien });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.zeilen.map((z: any) => [z.datei, z.status]), [
    ['2090-03-04 Kopie.md', 'PRUEFEN'], ['2090-03-04_Vorstand.md', 'DUPLIKAT'], ['ohne-datum.md', 'FEHLER'],
  ]);
  const z0 = r.body.zeilen[0];
  assert.deepEqual([z0.tops, z0.beschluesse, z0.aufgaben, z0.anlagen_gefunden, z0.anlagen_fehlen, z0.zugeordnet, z0.unklar],
    [2, 1, 2, 1, ['gibtsnicht.pdf'], 3, []]);
  assert.equal((await sql`select count(*)::int as n from tco.vs_sitzungen where importiert`)[0].n, 0, 'Prüfen schreibt nichts');

  r = await call('POST', `${V}/import`, { dateien, uebernehmen: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.uebernommen, 1);
  const id = r.body.zeilen[0].sitzung_id;
  const s = (await call('GET', `${V}/sitzungen/${id}`)).body;
  assert.deepEqual([s.nr, s.status, s.importiert, s.titel, s.datum, s.ort], ['VS 2090/01', 'FREIGEGEBEN', true, 'Vorstandssitzung März', '2090-03-04', 'Clubhaus']);
  // Nummern folgen dem Datum: das importierte März-Protokoll liegt vor der November-Sitzung
  assert.equal((await call('GET', `${V}/sitzungen/${sid}`)).body.nr, 'VS 2090/02');
  assert.ok(s.event, 'Veranstaltung angelegt');
  assert.equal((await sql`select anmeldung from tco.kal_events where id = ${s.event.id}`)[0].anmeldung, false, 'vergangene Sitzung ohne An-/Abmeldung');
  assert.deepEqual(s.teilnehmer.map((t: any) => [t.name, t.art, t.status]), [
    ['Beispiel, Hans', 'VORSTAND', 'ENTSCHULDIGT'], ['Laub, Torsten', 'VORSTAND', 'ANWESEND'], ['Muster, Erika', 'VORSTAND', 'ANWESEND'], ['Fremder Gast', 'GAST', 'ANWESEND'],
  ]);
  const e = s.tops[0].eintraege;
  // Beschlussnummern laufen je Jahr weiter
  assert.deepEqual(e.map((x: any) => [x.art, x.nr, x.ja, x.enthaltung, x.faellig, !!x.erledigt_am]), [
    ['BESCHLUSS', 'B 2090/003', 5, 1, null, false], ['AUFGABE', null, null, null, '2090-03-10', false], ['AUFGABE', null, null, null, null, true],
  ]);
  assert.deepEqual(s.anlagen.map((a: any) => [a.dateiname, a.top_id === s.tops[0].id, a.mime]), [
    ['Preisliste.pdf', true, 'application/pdf'], ['2090-03-04 Kopie.md', false, 'text/markdown'],
  ]);
  // noch einmal: jetzt ist auch diese Datei ein Duplikat
  r = await call('POST', `${V}/import`, { dateien: dateien.slice(0, 1), uebernehmen: true });
  assert.deepEqual(r.body.zeilen.map((z: any) => z.status), ['DUPLIKAT']);
  assert.equal(r.body.uebernommen, 0);
});

test('Einstellung: andere Vorstandsgruppe; Löschen im Entwurf', async () => {
  const [{ id: neu }] = await sql`insert into tco.kal_gruppen (name) values ('Geschäftsführender Vorstand') returning id`;
  await sql`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr) values (${neu}, 'VST-1')`;
  assert.equal((await call('PUT', `${V}/einstellungen`, { gruppe_id: neu })).status, 200);
  const l = (await call('GET', V)).body;
  assert.deepEqual([l.cfg.gruppe, l.cfg.automatisch, l.vorstand.length], ['Geschäftsführender Vorstand', false, 1]);
  const r = await call('POST', `${V}/sitzungen`, { titel: 'Kurzsitzung', datum: '2090-12-01', vorlage: false });
  const s = (await call('GET', `${V}/sitzungen/${r.body.id}`)).body;
  assert.deepEqual([s.nr, s.teilnehmer.length, s.tops.length, s.event], ['VS 2090/03', 1, 0, null]);
  assert.equal((await call('DELETE', `${V}/sitzungen/${r.body.id}`)).status, 200);
  await call('PUT', `${V}/einstellungen`, { gruppe_id: null });
  // Liste mit Suche
  const such = (await call('GET', `${V}?suche=Hallenpreise`)).body.sitzungen;
  assert.deepEqual(such.map((x: any) => x.titel), ['Vorstandssitzung März']);
});

async function benutzer(name: string, rechte: string[]) {
  const rolle = `VS_TEST_${name.toUpperCase()}`;
  await sql`insert into core.roles (id, name, description) values (${rolle}, ${`VS-Test ${name}`}, '')`;
  for (const p of rechte) await sql`insert into core.role_permissions (role_id, permission) values (${rolle}, ${p})`;
  const r = await call('POST', '/api/admin/users', { username: `vs-${name}`, displayName: `VS ${name}`, password: 'geheim-geheim-1', roles: [rolle] });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  await sql`update core.users set must_change_password = false where username = ${`vs-${name}`}`;
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: `vs-${name}`, password: 'geheim-geheim-1' })).status, 200);
  return c;
}

test('Rechte: ansehen, protokollieren, freigeben', async () => {
  assert.equal((await client()('GET', V)).status, 401);
  const ohne = await benutzer('ohne', ['tco.checklisten:display']);
  assert.equal((await ohne('GET', V)).status, 403);
  const leser = await benutzer('leser', ['tco.vorstand:display']);
  const l = await leser('GET', V);
  assert.equal(l.status, 200);
  assert.deepEqual([l.body.pflege, l.body.freigabe], [false, false]);
  assert.equal((await leser('GET', `${V}/sitzungen/${sid}/pdf`)).status, 200);
  assert.equal((await leser('POST', `${V}/sitzungen`, { titel: 'x', datum: '2090-01-01' })).status, 403);
  const schreiber = await benutzer('schreiber', ['tco.vorstand:display', 'tco.vorstand:edit']);
  const r = await schreiber('POST', `${V}/sitzungen`, { titel: 'Schreiber', datum: '2090-12-10', vorlage: false });
  assert.equal(r.status, 200);
  await schreiber('POST', `${V}/sitzungen/${r.body.id}/tops`, { titel: 'Punkt' });
  await schreiber('POST', `${V}/sitzungen/${r.body.id}/status`, { status: 'ENTWURF' });
  const f = await schreiber('POST', `${V}/sitzungen/${r.body.id}/status`, { status: 'FREIGEGEBEN' });
  assert.equal(f.status, 403, 'freigeben nur mit dem Recht zur Freigabe');
  assert.equal((await schreiber('POST', `${V}/sitzungen/${sid}/status`, { status: 'ENTWURF' })).status, 403, 'zurücknehmen auch nicht');
});

test('Nummern der Sitzungen folgen dem Datum – beim Anlegen, Verschieben ins andere Jahr und Löschen', async () => {
  const nr = async (id: number) => (await call('GET', `${V}/sitzungen/${id}`)).body.nr as string;
  const neu = async (titel: string, datum: string) => {
    const r = await call('POST', `${V}/sitzungen`, { titel, datum, vorlage: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
  };
  const c = await neu('Nr C', '2089-09-01');
  const a = await neu('Nr A', '2089-01-15');
  const b = await neu('Nr B', '2089-05-10');
  assert.deepEqual([await nr(a), await nr(b), await nr(c)], ['VS 2089/01', 'VS 2089/02', 'VS 2089/03']);
  // Datum ändern: B nach hinten
  const kopf = (await call('GET', `${V}/sitzungen/${b}`)).body;
  assert.equal((await call('PUT', `${V}/sitzungen/${b}`, { titel: kopf.titel, art: kopf.art, datum: '2089-12-01' })).status, 200);
  assert.deepEqual([await nr(a), await nr(c), await nr(b)], ['VS 2089/01', 'VS 2089/02', 'VS 2089/03']);
  // ins Vorjahr: Jahr und Nummer folgen dem Datum
  assert.equal((await call('PUT', `${V}/sitzungen/${b}`, { titel: kopf.titel, art: kopf.art, datum: '2088-06-01' })).status, 200);
  assert.equal(await nr(b), 'VS 2088/01');
  assert.deepEqual([await nr(a), await nr(c)], ['VS 2089/01', 'VS 2089/02']);
  // Löschen schließt die Lücke
  assert.equal((await call('DELETE', `${V}/sitzungen/${a}`)).status, 200);
  assert.equal(await nr(c), 'VS 2089/01');
  for (const id of [b, c]) assert.equal((await call('DELETE', `${V}/sitzungen/${id}`)).status, 200);
});
