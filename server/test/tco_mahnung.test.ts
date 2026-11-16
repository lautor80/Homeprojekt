/**
 * Integrationstest Mahnwesen: mahnfähige Posten (Hallenrechnungen mit Rest, gestellte Verzehrabrechnungen), Automatik aus
 * nach der Installation (keine E-Mail), Vorschlag und Freigabe mit erneuter Prüfung des Zahlungsstands, je Schuldner eine
 * E-Mail, nicht erreichbare Empfänger, Schutz gegen Doppelläufe, Stufen bis „manuell klären“, Mahnsperren, Einstellungen,
 * eigener E-Mail-Text, Mahnstufe an der Hallenrechnung. Der Mailversand (n8n) ist eine Attrappe – es geht nie eine echte E-Mail hinaus.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const { heute, addTage } = await import('../../modules/tco/server/format.js');
const { automatikPruefen, cfgLesen } = await import('../../modules/tco/server/mahnung/lauf.js');
const { rechnungenLesen } = await import('../../modules/tco/server/halle/daten.js');
const { verbindungenCacheLeeren } = await import('../src/lib/verbindungen.js');

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
const admin = client();
const T = '/api/m/tco';
const M = `${T}/mahnung`;

// Mail-Webhook (n8n) als Attrappe: Adressen mit „unzustellbar“ lehnt der Versand ab (Ergebnis ungleich „gesendet“),
// mit `stoerung` antwortet er wie ein ausgefallener Workflow
interface Mail { an: string; bcc: string; betreff: string; text: string; anwendung: string; objekt: string; benutzer: string; absender?: string; antwort_an: string; anhaenge: { dateiname: string; inhalt_base64: string }[] }
const mails: Mail[] = [];
let stoerung = false;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    if (!(req.url ?? '').startsWith('/webhook/mail')) return send(404, {});
    if (stoerung) return send(500, 'Workflow abgestuerzt');
    const m = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Mail;
    mails.push(m);
    if (m.an.includes('unzustellbar')) return send(200, { status: 'fehler', fehler: 'Adresse ist als unzustellbar vermerkt' });
    return send(200, { status: 'gesendet', message_id: `m${mails.length}` });
  });
});
const log = { info: () => undefined, warn: () => undefined };

const ANNA = '0000000851', BERND = '0000000852', CLARA = '0000000853', DORA = '0000000854', EMIL = '0000000855';
let H = '';
const tag = (n: number) => addTage(H, n);
const zeilen = async (lauf: number) => (await sql`select nr, schuldner, stufe, status, an, meldung, betrag::float8 as betrag, gebuehr::float8 as gebuehr, weg from tco.mahn_posten where lauf_id = ${lauf} order by nr`) as unknown as
  { nr: string; schuldner: string; stufe: number; status: string; an: string | null; meldung: string | null; betrag: number; gebuehr: number; weg: string | null }[];
const laeufe = async () => Number((await sql`select count(*)::int as n from tco.mahn_lauf`)[0].n);
const uebersicht = async () => (await admin('GET', M)).body as {
  posten: { nr: string; betrag: number; faellig: string; schritt: string; stufe: number; stufe_name: string; naechste_name: string; hinweis: string; versuch: { id: number; meldung: string } | null }[];
  plan: { mails: { schuldner: string; summe: number; gebuehr: number; stufe_name: string; posten: { nr: string }[] }[]; zurueckgestellt: number };
  vorschlag: { id: number; zeilen: { id: number; nr: string }[] } | null; unerreichbar: { nr: string; kontakt: { anschrift: string } | null; versuch: { id: number; meldung: string } | null }[];
  automatik: { aktiv: boolean; modus: string; naechster: string | null }; kennzahlen: { offen: number; klaeren: number };
};
const posten = async (nr: string) => (await uebersicht()).posten.find((p) => p.nr === nr);
const einstellungen = async (mehr: Record<string, unknown> = {}) => {
  const c = (await admin('GET', `${M}/einstellungen`)).body;
  return admin('PUT', `${M}/einstellungen`, { ...c, zahlungsziel_tage: c.zahlungsziel_tage ?? '', ...mehr });
};
/** Zustellung einer Stufe zurückdatieren (als wäre sie vor n Tagen zugestellt worden) */
const zurueckdatieren = (nr: string, stufe: number, tage: number) => sql`
  update tco.mahn_posten set erledigt_am = now() - make_interval(days => ${tage}), frist = (current_date - ${tage}::int + 10) where nr = ${nr} and stufe = ${stufe} and status = 'GESENDET'`;

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Test', username: 'admin', displayName: 'Kai Kasse', password: 'geheim-geheim' });
  await sql`insert into core.verbindungen (id, url, auth_art, header_name, geheimnis) values ('mail', ${`http://127.0.0.1:${port}/webhook/mail`}, 'header', 'X-TCO-Key', 'k')
            on conflict (id) do update set url = excluded.url, auth_art = 'header', header_name = 'X-TCO-Key', geheimnis = excluded.geheimnis`;
  await sql`update tco.verein set iban = 'DE02120300000000202051', bic = 'BYLADEM1001', bank = 'Testbank', zahlungsziel_tage = 14, ansprechpartner = 'Kai Kasse' where id = 1`;
  H = heute();
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, eintritt, strasse, plz, ort, email, telefon) values
    (${ANNA}, 'Anna', 'Aufschlag', '2020-01-01', 'Am Netz 1', '66649', 'Oberthal', 'anna@mahn-test.example', null),
    (${BERND}, 'Bernd', 'Becker', '2020-01-01', 'Grundlinie 2', '66649', 'Oberthal', null, '06854 12345'),
    (${CLARA}, 'Clara', 'Cross', '2020-01-01', 'T-Feld 3', '66649', 'Oberthal', 'clara-unzustellbar@mahn-test.example', null),
    (${DORA}, 'Dora', 'Doppel', '2020-01-01', 'Platz 4', '66649', 'Oberthal', 'dora@mahn-test.example', null),
    (${EMIL}, 'Emil', 'Einstand', '2020-01-01', 'Platz 5', '66649', 'Oberthal', 'emil@mahn-test.example', null)`;
  await sql`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ) values ('851', '2015-01-01', '9999-12-31', 'Hallenstunde Mahntest', 25, '1')`;
  // Hallenrechnungen: versendet vor 40 Tagen → fällig vor 26 Tagen (Zahlungsziel 14), Erinnerung seit 19 Tagen fällig
  await sql`insert into tco.rgkopf (rgnr_txt, jahr, rgnr, kunde, adrnr, betrag, status, angelegt_am, gedruckt, versendet) values
    ('2026_8501', 2026, 8501, 'ANNA AUFSCHLAG', ${ANNA}, 100, '5', ${tag(-45)}, ${tag(-40)}, ${tag(-40)}),
    ('2026_8502', 2026, 8502, 'ANNA AUFSCHLAG', ${ANNA}, 50, '3', ${tag(-6)}, ${tag(-5)}, ${tag(-5)}),
    ('2026_8503', 2026, 8503, 'BERND BECKER', ${BERND}, 60, '3', ${tag(-45)}, ${tag(-40)}, ${tag(-40)}),
    ('2026_8504', 2026, 8504, 'CLARA CROSS', ${CLARA}, 80, '3', ${tag(-45)}, ${tag(-40)}, ${tag(-40)}),
    ('2026_8505', 2026, 8505, 'DORA DOPPEL', ${DORA}, 3, '3', ${tag(-45)}, ${tag(-40)}, ${tag(-40)}),
    ('2026_8506', 2026, 8506, 'EMIL EINSTAND', ${EMIL}, 200, '1', ${tag(-60)}, null, null),
    ('2026_8507', 2026, 8507, 'EMIL EINSTAND', ${EMIL}, 200, '4', ${tag(-60)}, ${tag(-60)}, ${tag(-60)}),
    ('2026_8508', 2026, 8508, 'EMIL EINSTAND', ${EMIL}, 200, '6', ${tag(-60)}, ${tag(-60)}, ${tag(-60)}),
    ('2026_8509', 2026, 8509, 'EMIL EINSTAND', ${EMIL}, 40, '2', ${tag(-45)}, ${tag(-40)}, null),
    ('2026_8510', 2026, 8510, 'UNBEKANNT FREMD', null, 45, '3', ${tag(-45)}, ${tag(-40)}, ${tag(-40)})`;
  await sql`insert into tco.rgpos (rgnr_txt, rgpos, bid, datum, time_start, time_ende, dauer, prod_key, preis) values ('2026_8501', 1, null, ${tag(-50)}, '18:00', '19:00', '60', '851', 100)`;
  await sql`insert into tco.rgtz (rgnr_txt, fibeleg, betrag) values ('2026_8501', 'F8501', 30)`;
  // Verzehr: eigene Fälligkeit; Lastschrift und Bezahltes werden nie gemahnt
  await sql`insert into tco.vz_belege (rgnr, art, adrnr, datum, monat, status, betrag, zahlart, faellig, bezahlt_am) values
    ('VZM-85-1', 'SAMMEL', ${ANNA}, ${tag(-44)}, '2026-09', 'GESTELLT', 25, 'UEBERWEISUNG', ${tag(-30)}, null),
    ('VZM-85-2', 'SAMMEL', ${EMIL}, ${tag(-44)}, '2026-09', 'GESTELLT', 30, 'LASTSCHRIFT', ${tag(-30)}, null),
    ('VZM-85-3', 'SAMMEL', ${EMIL}, ${tag(-44)}, '2026-09', 'BEZAHLT', 30, 'UEBERWEISUNG', ${tag(-30)}, ${tag(-20)})`;
});
after(async () => { await app?.close(); await sql.end(); server.close(); });

test('Nach der Installation: Automatik aus, Modus „nur Vorschlag“ – es geht keine E-Mail hinaus', async () => {
  const c = await cfgLesen();
  assert.deepEqual([c.aktiv, c.modus, c.stufen.map((s) => `${s.name}/${s.tage}/${s.gebuehr}`), c.mindestbetrag, c.arten],
    [false, 'VORSCHLAG', ['Zahlungserinnerung/7/0', '1. Mahnung/14/0', '2. Mahnung/14/0'], 5, 'HALLE,VERZEHR']);
  // fällige Posten sind da – trotzdem tut die Automatik nichts, auch nicht mit passendem Zeitplan
  assert.ok((await uebersicht()).plan.mails.length > 0);
  assert.equal(await automatikPruefen(log), null);
  await sql`update tco.mahn_cfg set wochentage = '1,2,3,4,5,6,7', uhrzeit = '00:00', modus = 'SENDEN'`;
  assert.equal(await automatikPruefen(log), null, 'Zeitplan passt, aber Automatik aus');
  assert.deepEqual([await laeufe(), mails.length], [0, 0]);
  await sql`update tco.mahn_cfg set modus = 'VORSCHLAG'`;
  const u = await uebersicht();
  assert.deepEqual([u.automatik.aktiv, u.automatik.naechster], [false, null]);
  // Rechte: ohne Berechtigung keine App, kein Lauf
  await admin('POST', '/api/admin/users', { username: 'gast85', displayName: 'Gast', password: 'start-passwort', roles: ['MITGLIED'] });
  const gast = client();
  assert.equal((await gast('POST', '/api/auth/login', { username: 'gast85', password: 'start-passwort' })).status, 200);
  assert.equal((await gast('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  for (const [m, p] of [['GET', M], ['POST', `${M}/lauf`], ['GET', `${M}/einstellungen`], ['POST', `${M}/sperren`]]) assert.equal((await gast(m, p, {})).status, 403, `${m} ${p}`);
});

test('Mahnfähige Posten: Rest nach Teilzahlung, eigene Fälligkeit, nie „In Bearbeitung“, bezahlt, ausgefallen oder Lastschrift', async () => {
  const u = await uebersicht();
  assert.deepEqual(u.posten.map((p) => p.nr).sort(), ['2026_8501', '2026_8502', '2026_8503', '2026_8504', '2026_8505', '2026_8510', 'VZM-85-1']);
  const p = (nr: string) => u.posten.find((x) => x.nr === nr)!;
  assert.deepEqual([p('2026_8501').betrag, p('2026_8501').faellig, p('2026_8501').schritt, p('2026_8501').naechste_name], [70, tag(-26), 'MAHNEN', 'Zahlungserinnerung']);
  assert.deepEqual([p('VZM-85-1').faellig, p('VZM-85-1').schritt], [tag(-30), 'MAHNEN']);
  assert.deepEqual([p('2026_8502').faellig, p('2026_8502').schritt], [tag(9), 'NICHT_FAELLIG']);
  assert.equal(p('2026_8505').schritt, 'KLEINBETRAG');
  // Vorschau: je Schuldner eine E-Mail mit allen fälligen Posten
  assert.deepEqual(u.plan.mails.map((m) => [m.schuldner, m.posten.map((x) => x.nr), m.summe]),
    [[ANNA, ['VZM-85-1', '2026_8501'], 95], [BERND, ['2026_8503'], 60], [CLARA, ['2026_8504'], 80], ['K:UNBEKANNT FREMD', ['2026_8510'], 45]]);
  // Zahlungsziel des Mahnwesens übersteuert das des Vereins; gedruckte Rechnungen nur auf Wunsch
  assert.equal((await einstellungen({ zahlungsziel_tage: 60, halle_gedruckt: true })).status, 200);
  assert.deepEqual([(await posten('2026_8501'))!.schritt, (await posten('VZM-85-1'))!.schritt, (await posten('2026_8509'))!.schritt], ['NICHT_FAELLIG', 'MAHNEN', 'NICHT_FAELLIG']);
  assert.equal((await einstellungen({ zahlungsziel_tage: '', halle_gedruckt: false, arten: ['HALLE'] })).status, 200);
  assert.equal(await posten('VZM-85-1'), undefined, 'Verzehr abgewählt');
  assert.equal((await einstellungen({ arten: ['HALLE', 'VERZEHR'] })).status, 200);
});

test('Einstellungen: Prüfungen, Automatik einschalten', async () => {
  let r = await einstellungen({ aktiv: true, wochentage: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /mindestens einen Wochentag/);
  r = await einstellungen({ stufen: [{ name: 'Zahlungserinnerung', tage: 7, gebuehr: 0 }, { name: '1. Mahnung', tage: 3, gebuehr: 0 }] });
  assert.match(r.body.message, /mindestens 10 Tage nach der vorherigen Stufe/);
  assert.equal((await cfgLesen()).aktiv, false, 'abgelehnte Eingaben ändern nichts');
  r = await einstellungen({
    aktiv: true, modus: 'VORSCHLAG', wochentage: [1, 2, 3, 4, 5, 6, 7], uhrzeit: '00:00', max_je_lauf: 3, kopie_an: 'kasse@mahn-test.example', antwort_an: 'kasse@mahn-test.example',
    stufen: [{ name: 'Zahlungserinnerung', tage: 7, gebuehr: 0 }, { name: '1. Mahnung', tage: 14, gebuehr: '2.5' }, { name: '2. Mahnung', tage: 14, gebuehr: 5 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /erzeugt nur einen Vorschlag/);
  const c = (await admin('GET', `${M}/einstellungen`)).body;
  assert.deepEqual([c.aktiv, c.wochentage.length, c.stufen[1].gebuehr, c.naechster, c.verein_zahlungsziel], [true, 7, 2.5, H, 14]);
  // Änderungsbeleg der Einstellungen
  const [b] = await sql`select h.action, i.old_value, i.new_value from core.change_item i join core.change_header h on h.id = i.header_id
                         where h.object_type = 'MAHN_CFG' and i.field = 'aktiv' order by i.id desc limit 1`;
  assert.ok(b && b.action === 'MAHN_EINSTELLUNGEN' && /^f/.test(b.old_value) && /^t/.test(b.new_value), `Änderungsbeleg für das Einschalten der Automatik: ${JSON.stringify(b)}`);
});

let vorschlag = 0;
test('Automatik im Modus „nur Vorschlag“: Vorschlag im Arbeitsvorrat, keine E-Mail, kein zweiter Lauf am selben Tag, Obergrenze', async () => {
  const r = await automatikPruefen(log);
  assert.ok(r, 'Lauf gestartet');
  assert.deepEqual([r!.status, r!.modus, r!.schuldner, r!.posten, r!.gesendet, r!.zurueckgestellt], ['VORSCHLAG', 'VORSCHLAG', 3, 4, 0, 1]);
  vorschlag = r!.id;
  assert.equal(mails.length, 0, 'ein Vorschlag sendet nichts');
  assert.deepEqual((await zeilen(vorschlag)).map((z) => [z.nr, z.status, z.stufe]), [['2026_8501', 'VORSCHLAG', 1], ['2026_8503', 'VORSCHLAG', 1], ['2026_8504', 'VORSCHLAG', 1], ['VZM-85-1', 'VORSCHLAG', 1]]);
  const [l] = await sql`select art, gestartet_von from tco.mahn_lauf where id = ${vorschlag}`;
  assert.deepEqual([l.art, l.gestartet_von], ['AUTO', 'system (Mahnlauf)']);
  // Doppellauf-Schutz: am selben Tag startet die Automatik nicht noch einmal
  assert.equal(await automatikPruefen(log), null);
  assert.equal(await automatikPruefen(log), null);
  assert.equal(await laeufe(), 1);
  const av = (await admin('GET', `${T}/dashboard/arbeitsvorrat`)).body as { key: string; bereich: string; text: string }[];
  const e = av.find((x) => x.key === `MAHN_VORSCHLAG:${vorschlag}`);
  assert.ok(e && e.bereich === 'Kassenwart' && /3 Schuldner/.test(e.text), JSON.stringify(av.map((x) => x.key)));
  const u = await uebersicht();
  assert.equal(u.vorschlag?.id, vorschlag);
  assert.equal(u.posten.find((p) => p.nr === '2026_8501')!.schritt, 'VORSCHLAG');
  assert.deepEqual(u.plan.mails.map((m) => m.schuldner), ['K:UNBEKANNT FREMD'], 'Vorgeschlagenes wird nicht noch einmal eingeplant');
});

test('Freigabe: erneute Prüfung gegen den Zahlungsstand, je Schuldner eine E-Mail, nicht erreichbare Empfänger', async () => {
  // zwischen Vorschlag und Freigabe geht die Zahlung der Verzehrabrechnung ein
  await sql`update tco.vz_belege set status = 'BEZAHLT', bezahlt_am = ${H} where rgnr = 'VZM-85-1'`;
  const r = await admin('POST', `${M}/laeufe/${vorschlag}/freigeben`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.gesendet, r.body.nicht_erreichbar, r.body.entfallen], ['FERTIG', 1, 2, 1]);
  const z = Object.fromEntries((await zeilen(vorschlag)).map((x) => [x.nr, x]));
  assert.deepEqual([z['VZM-85-1'].status, z['VZM-85-1'].meldung], ['ENTFALLEN', 'inzwischen bezahlt bzw. nicht mehr offen']);
  assert.deepEqual([z['2026_8501'].status, z['2026_8501'].an, z['2026_8501'].weg, z['2026_8501'].betrag], ['GESENDET', 'anna@mahn-test.example', 'MAIL', 70]);
  assert.deepEqual([z['2026_8503'].status, z['2026_8503'].meldung], ['NICHT_ERREICHBAR', 'keine E-Mail-Adresse hinterlegt']);
  assert.deepEqual([z['2026_8504'].status, z['2026_8504'].meldung], ['NICHT_ERREICHBAR', 'Adresse ist als unzustellbar vermerkt']);
  // genau eine E-Mail an Anna (nur der noch offene Posten), ein abgelehnter Versuch an Clara
  assert.deepEqual(mails.map((m) => m.an), ['anna@mahn-test.example', 'clara-unzustellbar@mahn-test.example']);
  const m = mails[0];
  assert.deepEqual([m.anwendung, m.objekt, m.bcc, m.antwort_an, m.benutzer], ['MAHNUNG', '2026_8501', 'kasse@mahn-test.example', 'kasse@mahn-test.example', 'Kai Kasse']);
  assert.equal(m.absender, undefined, 'Systemabsender – nicht die Adresse des angemeldeten Benutzers');
  assert.match(m.betreff, /Zahlungserinnerung zu 2026_8501/);
  assert.match(m.text, /^Hallo Anna,/);
  assert.match(m.text, /Hallenrechnung 2026_8501 vom .*: 70,00 € \(Rest von 100,00 €\)/);
  assert.ok(m.text.includes('Offener Betrag: 70,00 €') && m.text.includes(`bis zum ${tag(10).split('-').reverse().join('.')}`) && m.text.includes('IBAN: DE02 1203 0000 0000 2020 51'));
  assert.ok(!m.text.includes('VZM-85-1') && !m.text.includes('Mahngebühr'));
  assert.deepEqual(m.anhaenge.map((a) => a.dateiname), ['Rechnung_2026_8501.pdf']);
  assert.equal(Buffer.from(m.anhaenge[0].inhalt_base64, 'base64').subarray(0, 4).toString(), '%PDF');
  // freigegeben ist freigegeben
  assert.equal((await admin('POST', `${M}/laeufe/${vorschlag}/freigeben`, {})).status, 409);
  assert.equal((await admin('POST', `${M}/laeufe/${vorschlag}/verwerfen`, {})).status, 409);
  const l = (await admin('GET', `${M}/laeufe/${vorschlag}`)).body;
  assert.deepEqual([l.status, l.freigegeben_von, l.zeilen.length, l.gesendet, l.nicht_erreichbar], ['FERTIG', 'Kai Kasse', 4, 1, 2]);
  // Änderungsbeleg (über den Trigger der Tabelle) und Historie je Posten
  const [cb] = await sql`select count(*)::int as n from core.change_header where object_type = 'MAHNUNG' and action = 'MAHNLAUF' and username = 'Kai Kasse'`;
  assert.ok(cb.n >= 4, 'Änderungsbelege der Posten');
  const hist = (await admin('GET', `${M}/historie?art=HALLE&nr=2026_8501`)).body as { status: string; stufe_name: string }[];
  assert.deepEqual(hist.map((x) => [x.stufe_name, x.status]), [['Zahlungserinnerung', 'GESENDET']]);
  // Mailprotokoll: Mahnungen werden nie unverändert wiederholt
  const [mp] = await sql`select nachricht from core.mail_protokoll where anwendung = 'MAHNUNG' order by id limit 1`;
  assert.equal((mp.nachricht as { wiederholung?: { art: string } }).wiederholung?.art, 'NEU_AUSLOESEN');
});

test('Schutz gegen Doppelläufe: je Posten und Stufe nur einmal, nur ein Lauf gleichzeitig', async () => {
  const vorher = mails.length;
  // zweiter Lauf am selben Tag: Anna wartet auf die Frist, Bernd und Clara bleiben „nicht erreichbar“ – niemand bekommt eine zweite E-Mail
  let r = await admin('POST', `${M}/lauf`, { modus: 'SENDEN' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.gesendet, r.body.schuldner, r.body.nicht_erreichbar], [0, 1, 1], 'nur der zurückgestellte Schuldner ohne Stammsatz');
  assert.equal(mails.length, vorher);
  assert.deepEqual((await zeilen(r.body.id)).map((z) => [z.nr, z.status]), [['2026_8510', 'NICHT_ERREICHBAR']]);
  r = await admin('POST', `${M}/lauf`, { modus: 'SENDEN' });
  assert.deepEqual([r.body.posten, r.body.text], [0, 'Nichts zu mahnen – es wurde keine E-Mail gesendet.']);
  assert.equal(mails.length, vorher);
  // die Datenbank lässt keine zweite zugestellte Mahnung derselben Stufe zu
  await assert.rejects(sql`insert into tco.mahn_posten (lauf_id, art, nr, schuldner, name, betrag, faellig, stufe, stufe_name, status)
                           values (${vorschlag}, 'HALLE', '2026_8501', ${ANNA}, 'Anna', 70, ${H}, 1, 'Zahlungserinnerung', 'GESENDET')`, /mahn_posten_einmal/);
  // läuft schon ein Lauf, wird kein zweiter gestartet
  const [lf] = await sql`insert into tco.mahn_lauf (art, modus, status, stichtag, gestartet_von) values ('AUTO', 'SENDEN', 'LAEUFT', ${H}, 'system') returning id`;
  r = await admin('POST', `${M}/lauf`, { modus: 'SENDEN' });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /läuft bereits ein Mahnlauf/);
  assert.equal((await uebersicht() as unknown as { laeuft: boolean }).laeuft, true);
  // ein hängengebliebener Lauf (Absturz) gibt die Sperre nach 30 Minuten frei
  await sql`update tco.mahn_lauf set gestartet_am = now() - interval '45 minutes' where id = ${lf.id}`;
  assert.equal((await admin('POST', `${M}/lauf`, { modus: 'VORSCHLAG' })).status, 200);
  assert.equal((await sql`select status from tco.mahn_lauf where id = ${lf.id}`)[0].status, 'FEHLER');
});

test('Nicht per E-Mail erreichbar: Liste mit Anschrift, Zustellung vermerken, neue Adresse, erneut versuchen', async () => {
  let u = await uebersicht();
  assert.deepEqual(u.unerreichbar.map((p) => p.nr).sort(), ['2026_8503', '2026_8504', '2026_8510']);
  const bernd = u.unerreichbar.find((p) => p.nr === '2026_8503')!;
  assert.equal(bernd.kontakt?.anschrift, 'Grundlinie 2, 66649 Oberthal');
  assert.equal(u.unerreichbar.find((p) => p.nr === '2026_8510')!.kontakt, null);
  assert.equal(u.posten.find((p) => p.nr === '2026_8503')!.stufe, 0, 'nicht zugestellt = Stufe nicht erreicht');
  const av = (await admin('GET', `${T}/dashboard/arbeitsvorrat`)).body as { key: string; titel: string }[];
  assert.match(av.find((x) => x.key === 'MAHN_UNERREICHBAR')!.titel, /3 Schuldner nicht per E-Mail erreichbar/);
  // Brief verschickt: Stufe gilt als zugestellt
  let r = await admin('POST', `${M}/posten/${bernd.versuch!.id}/zugestellt`, { weg: 'BRIEF', bemerkung: 'eingeworfen' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('POST', `${M}/posten/${bernd.versuch!.id}/zugestellt`, { weg: 'BRIEF' })).status, 409);
  const b = (await posten('2026_8503'))!;
  assert.deepEqual([b.stufe, b.stufe_name, b.schritt], [1, 'Zahlungserinnerung', 'WARTET']);
  // Clara bekommt eine neue Adresse: der nächste Lauf versucht es von selbst erneut
  assert.equal((await posten('2026_8504'))!.schritt, 'UNERREICHBAR');
  await sql`update tco.mitglieder set email = 'clara@mahn-test.example' where adrnr = ${CLARA}`;
  assert.equal((await posten('2026_8504'))!.schritt, 'MAHNEN');
  const vorher = mails.length;
  r = await admin('POST', `${M}/lauf`, { modus: 'SENDEN' });
  assert.deepEqual([r.body.gesendet, mails.length - vorher, mails.at(-1)!.an], [1, 1, 'clara@mahn-test.example']);
  // „Erneut versuchen“ ohne Stammsatz: wieder nicht erreichbar, aber ohne E-Mail
  const fremd = (await uebersicht()).unerreichbar.find((p) => p.nr === '2026_8510')!;
  assert.equal((await admin('POST', `${M}/posten/${fremd.versuch!.id}/erneut`, {})).status, 200);
  assert.equal((await posten('2026_8510'))!.schritt, 'MAHNEN');
  r = await admin('POST', `${M}/lauf`, { modus: 'SENDEN' });
  assert.deepEqual([r.body.gesendet, r.body.nicht_erreichbar, mails.length - vorher], [0, 1, 1]);
  u = await uebersicht();
  assert.deepEqual(u.unerreichbar.map((p) => p.nr), ['2026_8510']);
});

test('Stufen: 1. Mahnung mit Gebühr, 2. Mahnung, danach keine E-Mail mehr – „Forderung manuell klären“ im Arbeitsvorrat', async () => {
  // Erinnerung vor 15 Tagen zugestellt → 1. Mahnung (14 Tage) fällig; neue Verzehrabrechnung derselben Schuldnerin in Stufe 1
  await zurueckdatieren('2026_8501', 1, 15);
  await sql`insert into tco.vz_belege (rgnr, art, adrnr, datum, monat, status, betrag, zahlart, faellig) values ('VZM-85-4', 'SAMMEL', ${ANNA}, ${tag(-30)}, '2026-10', 'GESTELLT', 12, 'UEBERWEISUNG', ${tag(-16)})`;
  let vorher = mails.length;
  let r = await admin('POST', `${M}/lauf`, { modus: 'SENDEN' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.gesendet, mails.length - vorher], [1, 1], 'eine E-Mail für beide Posten');
  let m = mails.at(-1)!;
  assert.match(m.betreff, /1\. Mahnung zu 2026_8501, VZM-85-4/);
  assert.ok(m.text.includes('Offener Betrag: 84,50 €') && m.text.includes('Darin enthalten ist eine Mahngebühr von 2,50 €.'), m.text);
  assert.deepEqual(m.anhaenge.map((a) => a.dateiname).sort(), ['Rechnung_2026_8501.pdf', 'Verzehrabrechnung_VZM-85-4.pdf']);
  let z = (await zeilen(r.body.id)).map((x) => [x.nr, x.stufe, x.status, x.gebuehr]);
  assert.deepEqual(z, [['2026_8501', 2, 'GESENDET', 2.5], ['VZM-85-4', 1, 'GESENDET', 0]], 'Gebühr einmal je E-Mail');
  // Mahnstufe an der Hallenrechnung
  const [rg] = await rechnungenLesen(sql as never, null, undefined, '2026_8501');
  assert.deepEqual([rg.mahnstufe, rg.gemahnt_am], ['1. Mahnung', H]);
  assert.equal((await rechnungenLesen(sql as never, null, undefined, '2026_8502'))[0].mahnstufe, null);
  // 2. Mahnung
  await zurueckdatieren('2026_8501', 2, 14);
  await sql`update tco.vz_belege set status = 'BEZAHLT', bezahlt_am = ${H} where rgnr = 'VZM-85-4'`;
  r = await admin('POST', `${M}/lauf`, { modus: 'SENDEN' });
  m = mails.at(-1)!;
  assert.match(m.betreff, /2\. Mahnung zu 2026_8501/);
  assert.ok(m.text.includes('Offener Betrag: 75,00 €') && m.text.includes('wendet sich der Vorstand persönlich'), m.text);
  let p = (await posten('2026_8501'))!;
  assert.deepEqual([p.stufe, p.stufe_name, p.schritt], [3, '2. Mahnung', 'WARTET'], 'Frist der letzten Stufe läuft');
  // Frist der letzten Stufe verstrichen: keine weitere E-Mail, Eintrag beim Kassenwart
  await zurueckdatieren('2026_8501', 3, 11);
  p = (await posten('2026_8501'))!;
  assert.equal(p.schritt, 'KLAEREN');
  vorher = mails.length;
  r = await admin('POST', `${M}/lauf`, { modus: 'SENDEN' });
  assert.equal(mails.length, vorher, 'nach der letzten Stufe keine E-Mail');
  const av = (await admin('GET', `${T}/dashboard/arbeitsvorrat`)).body as { key: string; bereich: string; titel: string; betrag: number }[];
  const e = av.find((x) => x.key === 'MAHN_KLAEREN:HALLE:2026_8501');
  assert.deepEqual([e?.bereich, e?.titel, e?.betrag], ['Kassenwart', 'Forderung manuell klären: Anna Aufschlag', 70]);
  assert.equal((await uebersicht()).kennzahlen.klaeren, 1);
  assert.deepEqual(((await admin('GET', `${M}/historie?art=HALLE&nr=2026_8501`)).body as { stufe_name: string; status: string }[]).map((x) => `${x.stufe_name}:${x.status}`),
    ['Zahlungserinnerung:GESENDET', '1. Mahnung:GESENDET', '2. Mahnung:GESENDET']);
  // bezahlt: der Eintrag verschwindet von selbst
  await sql`update tco.rgkopf set status = '4', bezahlt = ${H} where rgnr_txt = '2026_8501'`;
  assert.ok(!((await admin('GET', `${T}/dashboard/arbeitsvorrat`)).body as { key: string }[]).some((x) => x.key.startsWith('MAHN_KLAEREN')));
});

test('Mahnsperre je Rechnung und je Mitglied, mit Grund und Ablaufdatum – auch zwischen Vorschlag und Freigabe', async () => {
  await sql`insert into tco.rgkopf (rgnr_txt, jahr, rgnr, kunde, adrnr, betrag, status, angelegt_am, gedruckt, versendet) values
    ('2026_8511', 2026, 8511, 'DORA DOPPEL', ${DORA}, 90, '3', ${tag(-45)}, ${tag(-40)}, ${tag(-40)})`;
  assert.equal((await posten('2026_8511'))!.schritt, 'MAHNEN');
  assert.equal((await posten('2026_8505'))!.schritt, 'MAHNEN', 'zusammen über dem Mindestbetrag');
  // je Rechnung
  assert.equal((await admin('POST', `${M}/sperren`, { ebene: 'RECHNUNG', art: 'HALLE', schluessel: '2026_8511', grund: '' })).status, 400, 'Grund ist Pflicht');
  let r = await admin('POST', `${M}/sperren`, { ebene: 'RECHNUNG', art: 'HALLE', schluessel: '2026_8511', name: 'Dora Doppel', grund: 'Rechnung strittig' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s1 = r.body.id;
  assert.equal((await admin('POST', `${M}/sperren`, { ebene: 'RECHNUNG', art: 'HALLE', schluessel: '2026_8511', grund: 'noch einmal' })).status, 409);
  let p = (await posten('2026_8511'))!;
  assert.deepEqual([p.schritt, p.hinweis], ['GESPERRT', 'Rechnung strittig']);
  assert.equal((await posten('2026_8505'))!.schritt, 'KLEINBETRAG', 'ohne die gesperrte Rechnung unter dem Mindestbetrag');
  assert.ok(!(await uebersicht()).plan.mails.some((m) => m.schuldner === DORA));
  assert.equal((await admin('POST', `${M}/sperren/${s1}/aufheben`, {})).status, 200);
  assert.equal((await admin('POST', `${M}/sperren/${s1}/aufheben`, {})).status, 409);
  assert.equal((await posten('2026_8511'))!.schritt, 'MAHNEN');
  // je Mitglied, mit Ablaufdatum – gesetzt zwischen Vorschlag und Freigabe
  r = await admin('POST', `${M}/lauf`, { modus: 'VORSCHLAG' });
  assert.deepEqual([r.body.status, r.body.schuldner], ['VORSCHLAG', 1]);
  const lauf = r.body.id;
  assert.equal((await admin('POST', `${M}/sperren`, { ebene: 'SCHULDNER', schluessel: DORA, name: 'Dora Doppel', grund: 'Ratenzahlung', bis: tag(-1) })).status, 400, 'Ablauf in der Vergangenheit');
  r = await admin('POST', `${M}/sperren`, { ebene: 'SCHULDNER', schluessel: DORA, name: 'Dora Doppel', grund: 'Ratenzahlung vereinbart', bis: tag(5) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const vorher = mails.length;
  r = await admin('POST', `${M}/laeufe/${lauf}/freigeben`, {});
  assert.deepEqual([r.body.gesendet, r.body.entfallen, mails.length - vorher], [0, 2, 0]);
  assert.deepEqual((await zeilen(lauf)).map((z) => [z.status, z.meldung]), [['ENTFALLEN', 'Mahnsperre: Ratenzahlung vereinbart'], ['ENTFALLEN', 'Mahnsperre: Ratenzahlung vereinbart']]);
  p = (await posten('2026_8511'))!;
  assert.deepEqual([p.schritt, p.hinweis], ['GESPERRT', `Ratenzahlung vereinbart (bis ${tag(5).split('-').reverse().join('.')})`]);
  // Liste der Sperren mit Stand; nach dem Ablaufdatum wird wieder gemahnt
  const liste = (await admin('GET', `${M}/sperren?alle=1`)).body as { ebene: string; grund: string; aufgehoben_von: string | null }[];
  assert.deepEqual(liste.map((x) => [x.ebene, x.grund, x.aufgehoben_von]), [['SCHULDNER', 'Ratenzahlung vereinbart', null], ['RECHNUNG', 'Rechnung strittig', 'Kai Kasse']]);
  await sql`update tco.mahn_sperre set bis = ${tag(-1)} where ebene = 'SCHULDNER'`;
  assert.equal((await posten('2026_8511'))!.schritt, 'MAHNEN');
  assert.equal(((await admin('GET', `${M}/sperren`)).body as unknown[]).length, 0);
  assert.ok(((await admin('GET', `${M}/schuldner?q=dora`)).body as { schluessel: string }[]).some((x) => x.schluessel === DORA));
});

test('Vorschlag bearbeiten und verwerfen; eigener E-Mail-Text; technischer Fehler wird im nächsten Lauf wiederholt; Automatik „senden“', async () => {
  // Vorschlag: einen Posten herausnehmen, Rest verwerfen – nichts geht hinaus
  let r = await admin('POST', `${M}/lauf`, { modus: 'VORSCHLAG' });
  const lauf = r.body.id;
  const u = await uebersicht();
  assert.equal(u.vorschlag?.id, lauf);
  const z8505 = u.vorschlag!.zeilen.find((z) => z.nr === '2026_8505')!;
  assert.equal((await admin('POST', `${M}/posten/${z8505.id}/verwerfen`, {})).status, 200);
  assert.equal((await admin('POST', `${M}/posten/${z8505.id}/verwerfen`, {})).status, 409);
  const vorher = mails.length;
  assert.equal((await admin('POST', `${M}/laeufe/${lauf}/verwerfen`, {})).status, 200);
  assert.deepEqual((await zeilen(lauf)).map((z) => z.status), ['VERWORFEN', 'VERWORFEN']);
  assert.equal(mails.length, vorher);
  assert.equal((await posten('2026_8511'))!.schritt, 'MAHNEN', 'Verworfenes kann wieder vorgeschlagen werden');
  // ein neuer Lauf ersetzt einen offenen Vorschlag
  const alt = (await admin('POST', `${M}/lauf`, { modus: 'VORSCHLAG' })).body.id;
  const neu = (await admin('POST', `${M}/lauf`, { modus: 'VORSCHLAG' })).body.id;
  assert.deepEqual([(await sql`select status from tco.mahn_lauf where id = ${alt}`)[0].status, (await sql`select status from tco.mahn_lauf where id = ${neu}`)[0].status], ['VERWORFEN', 'VORSCHLAG']);
  // eigener Text der Stufe 1 (Einstellungen → E-Mail-Texte)
  r = await admin('PUT', `${T}/mailtexte/mahnung.stufe1`, { betreff: 'Bitte denk an {Rechnungsnummer}', text: '{Anrede}!\n\nOffen: {Betrag} bis {Frist}.\n\n{Posten}' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('PUT', `${T}/mailtexte/mahnung.stufe1`, { betreff: 'x', text: 'ohne Platzhalter' })).status, 400, 'Pflicht-Platzhalter');
  // technischer Fehler (n8n ausgefallen): Stufe nicht erreicht, der nächste Lauf versucht es erneut
  stoerung = true;
  r = await admin('POST', `${M}/laeufe/${neu}/freigeben`, {});
  assert.deepEqual([r.body.gesendet, r.body.fehler], [0, 1]);
  assert.deepEqual((await zeilen(neu)).map((z) => z.status), ['FEHLER', 'FEHLER']);
  assert.equal((await posten('2026_8511'))!.stufe, 0);
  stoerung = false;
  // Automatik im Modus „automatisch senden“ – am nächsten Tag (heute lief sie schon)
  assert.equal((await einstellungen({ modus: 'SENDEN' })).status, 200);
  assert.equal(await automatikPruefen(log), null, 'heute schon gelaufen');
  await sql`update tco.mahn_cfg set letzter_lauf = now() - interval '1 day'`;
  const a = await automatikPruefen(log);
  assert.deepEqual([a?.status, a?.modus, a?.gesendet], ['FERTIG', 'SENDEN', 1]);
  const m = mails.at(-1)!;
  assert.deepEqual([m.an, m.betreff, m.benutzer], ['dora@mahn-test.example', 'Bitte denk an 2026_8505, 2026_8511', 'system (Mahnlauf)']);
  assert.match(m.text, /^Hallo Dora!\n\nOffen: 93,00 € bis /);
  // Mailversand nicht eingerichtet: der Lauf endet mit Fehler und steht im Arbeitsvorrat
  await sql`update tco.mahn_cfg set letzter_lauf = null`;
  const [verb] = await sql`select url from core.verbindungen where id = 'mail'`;
  await sql`update core.verbindungen set url = '' where id = 'mail'`;
  verbindungenCacheLeeren();
  assert.equal(await automatikPruefen(log), null);
  assert.equal((await admin('POST', `${M}/lauf`, { modus: 'SENDEN' })).status, 400, 'auch von Hand kein Versand');
  const av = (await admin('GET', `${T}/dashboard/arbeitsvorrat`)).body as { key: string; text: string }[];
  assert.match(av.find((x) => x.key.startsWith('MAHN_LAUF:'))?.text ?? '', /E-Mail-Versand ist nicht eingerichtet/);
  await sql`update core.verbindungen set url = ${verb.url} where id = 'mail'`;
  verbindungenCacheLeeren();
});
