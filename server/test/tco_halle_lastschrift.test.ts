/**
 * Hallenrechnungen per SEPA-Lastschrift: Entscheidung im Portal (Hallenbucher mit eigenem Mandat, Mitglied mit dem Mandat
 * der Mitgliedschaft), Rechnung als Vorabankündigung, separater Lauf mit pain.008, Verbuchung über den Bankimport,
 * Rücklastschrift mit Gebühr auf der Rechnung, Storno.
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
const { istTarget2Tag, plusTage } = await import('../src/lib/sepa.js');
const { heute } = await import('../../modules/tco/server/format.js');
const { rueckZuUmsatz, halleLastschriften } = await import('../../modules/tco/server/halle/lastschrift.js');

let app: Awaited<ReturnType<typeof buildApp>>;
function client() {
  let cookie = '';
  return async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, ct };
  };
}
const admin = client();
const T = '/api/m/tco';
const L = `${T}/halle/lastschrift`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const MIA = '0000000611';           // Mitglied mit Lastschrift-Mandat
const HUGO = '9990000711';          // reiner Hallenbucher, im Portal registriert (Kunde 90000711)

async function anmelden(name: string) {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: name, password: 'start-passwort' })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort' })).status, 200);
  return c;
}
async function benutzer(name: string) {
  const r = await admin('POST', '/api/admin/users', { username: name, displayName: name, email: `${name}@example.org`, password: 'start-passwort', roles: ['HALLENNUTZER'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (await sql`select id::text as id from core.users where username = ${name}`)[0].id as string;
}
/** nächster TARGET2-Tag ab heute + n */
function bankTag(n: number) {
  let d = plusTage(heute(), n);
  while (!istTarget2Tag(d)) d = plusTage(d, 1);
  return d;
}
const de = (iso: string) => iso.split('-').reverse().join('.');

before(async () => {
  await sql.unsafe(`drop schema if exists tco cascade; drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await admin('POST', '/api/setup', { orgName: 'TC Oberthal', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
  await sql`update tco.verein set iban = 'DE02120300000000202051', name = 'Tennisclub Oberthal e.V.' where id = 1`;
  await sql`insert into tco.fikonten (konto, name, kennzahl) values ('1200', 'Girokonto', 'BA'), ('8003', 'Hallenmiete', null), ('8005', 'Sonstige Erlöse', null),
            ('4970', 'Nebenkosten Geldverkehr', null) on conflict (konto) do nothing`;
  await sql`delete from tco.produkte where prod_key in ('001', '093')`;
  await sql`insert into tco.produkte (prod_key, valid_from, valid_to, text, preis, typ, erloeskonto) values
            ('001', '2020-01-01', '9999-12-31', 'Halle', 20, '2', null), ('093', '2020-01-01', '9999-12-31', 'Sonstiges', 0, '4', '8005')`;
  await sql`insert into tco.mitglieder (adrnr, vorname, nachname, zahlungsart, iban1, bic1, einzuglastmandliegtvor, mitglnrn, strasse, plz, ort)
            values (${MIA}, 'Mia', 'Mandat', 'L', 'DE89370400440532013000', 'COBADEFFXXX', 'J', '611', 'Hauptstr. 1', '66649', 'Oberthal')`;
  await sql`insert into tco.mitgliedera (adrnr) values (${MIA}) on conflict do nothing`;
  await sql`insert into tco.sepa (adrnr, mandatsnr, status, angelegtam) values (${MIA}, 'TCO-611', 'X', '2020-01-01')`;
  await sql`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname, strasse, plz, wohnort)
            values ('90000711', 'hugo', 'portal', 'hugo@example.org', 'Hugo', 'Halle', 'Weg 2', '66649', 'Oberthal')`;
});
after(async () => { await app?.close(); await sql.end(); });

test('Reine Funktionen: Rücklastschrift an der End-to-End-Referenz, Lastschriften je Person', () => {
  const k = [{ laufid: '0000000012', e2e: 'TCOH12-1', betrag: 75, rechnungen: ['2026_1'], name: '' },
    { laufid: '0000000012', e2e: 'TCOH12-10', betrag: 20, rechnungen: ['2026_2'], name: '' }];
  assert.equal(rueckZuUmsatz(k, { betrag: -78, zweck: 'RETOURE EREF+TCOH12-1 MREF+X' })?.e2e, 'TCOH12-1');
  assert.equal(rueckZuUmsatz(k, { betrag: -23, zweck: 'Rücklastschrift EREF: TCOH12-10 SVWZ' })?.e2e, 'TCOH12-10', 'TCOH12-1 steckt nicht in TCOH12-10');
  assert.equal(rueckZuUmsatz(k, { betrag: 75, zweck: 'TCOH12-1' }), null, 'Gutschrift ist keine Rücklastschrift');
  assert.equal(rueckZuUmsatz(k, { betrag: -50, zweck: 'TCOH12-1' }), null, 'Belastung kleiner als der Einzug');
  const p = { kontoinhaber: 'A', iban: 'DE1', bic: '', mandatsref: 'M1', mandatsdatum: '2026-01-01', sequenz: 'RCUR' as const };
  const tx = halleLastschriften([{ ...p, adrnr: '1', betrag: 10, rgnr: '2026_002' }, { ...p, adrnr: '1', betrag: 5, rgnr: '2026_001' },
    { ...p, adrnr: '2', mandatsref: 'M2', betrag: 7, rgnr: '2026_003' }], '0000000003');
  assert.deepEqual(tx.map((t) => [t.e2e_id, t.betrag, t.zweck]), [['TCOH3-1', 15, 'TC OBERTHAL HALLENRECHNUNG 2026 001 2026 002'], ['TCOH3-2', 7, 'TC OBERTHAL HALLENRECHNUNG 2026 003']]);
});

test('Hallen-Lastschrift: Entscheidung, Rechnung, Lauf, Bankimport, Rücklastschrift, Storno', async () => {
  const miaId = await benutzer('mia');
  const hugoId = await benutzer('hugo');
  await sql`insert into tco.mitglied_benutzer (benutzer_id, adrnr) values (${miaId}, ${MIA})`;
  await sql`update tco.kunden set benutzer_id = ${hugoId} where zuid = '90000711'`;
  const mia = await anmelden('mia');
  const hugo = await anmelden('hugo');

  // ---- ausgeschaltet: niemand wird gefragt; ohne Gläubiger-ID lässt es sich nicht einschalten
  let r = await hugo('GET', `${T}/halle/zahlart/ich`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fragen, false);
  const cfg = { aktiv: true, vorankuendigung: 5, gebuehr: null, gebuehr_konto: '4970' };
  r = await admin('PUT', `${L}/cfg`, cfg);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Gläubiger-ID/);
  r = await admin('PUT', `${T}/soll/cfg`, { gl_name: 'Tennisclub Oberthal e.V.', gl_id: 'DE98ZZZ09999999999', bankkonto: '1200', vorlauf: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('PUT', `${L}/cfg`, { ...cfg, gebuehr_konto: '9999' })).status, 400, 'Gebührenkonto muss im Kontenstamm stehen');
  r = await admin('PUT', `${L}/cfg`, cfg);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // ---- Hallenbucher: Popup, Mandat online erteilen
  r = await hugo('GET', `${T}/halle/zahlart/ich`);
  assert.equal(r.body.fragen, true);
  assert.equal(r.body.mitglied, null);
  assert.match(r.body.mandatstext, /DE98ZZZ09999999999/);
  r = await hugo('POST', `${T}/halle/zahlart/ich`, { zahlart: 'LASTSCHRIFT', kontoinhaber: 'Hugo Halle', iban: 'DE02 1203 0000 0000 2020 51' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Lastschriftmandat bestätigen/);
  r = await hugo('POST', `${T}/halle/zahlart/ich`, { zahlart: 'LASTSCHRIFT', kontoinhaber: 'Hugo Halle', iban: 'DE02120300000000202052', zustimmung: true });
  assert.match(r.body.message, /IBAN ist ungültig/);
  r = await hugo('POST', `${T}/halle/zahlart/ich`, { zahlart: 'LASTSCHRIFT', kontoinhaber: 'Hugo Halle', iban: 'DE02 5001 0517 0137 0750 30', zustimmung: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mandatsref, 'TCOH-9990000711-1');
  r = await hugo('GET', `${T}/halle/zahlart/ich`);
  assert.deepEqual([r.body.fragen, r.body.zahlart, r.body.iban], [false, 'LASTSCHRIFT', 'DE02 •••• 5030']);
  const [z] = await sql`select ip, benutzer_id::text as b, mandatsdatum::text as d, mandatstext from tco.halle_zahlart where adrnr = ${HUGO}`;
  assert.deepEqual([z.b, z.d], [hugoId, heute()]);
  assert.match(z.mandatstext, /Rücklastschrift/);

  // ---- Mitglied: erst mit Hallenrechnung gefragt, nimmt das Mandat der Mitgliedschaft
  assert.equal((await mia('GET', `${T}/halle/zahlart/ich`)).body.fragen, false);
  const rechnung = async (nr: string, adrnr: string, kunde: string, pos: [string, number, string][]) => {
    await sql`insert into tco.rgkopf (rgnr_txt, jahr, rgnr, kunde, betrag, status, angelegt_am, adrnr) values (${nr}, 2026, ${Number(nr.slice(5))}, ${kunde}, 0, '1', ${heute()}, ${adrnr})`;
    for (const [i, [key, preis, dauer]] of pos.entries()) {
      await sql`insert into tco.rgpos (rgnr_txt, rgpos, bid, datum, dauer, prod_key, preis, description)
                values (${nr}, ${i + 1}, ${key === '001' ? `B${nr}${i}` : null}, ${heute()}, ${dauer}, ${key}, ${preis}, ${key === '093' ? 'Bälle' : null})`;
    }
    await sql`update tco.rgkopf set betrag = (select sum(case when bid is null then preis * dauer::numeric else preis end) from tco.rgpos where rgnr_txt = ${nr}) where rgnr_txt = ${nr}`;
  };
  await rechnung('2026_801', HUGO, 'HUGO HALLE', [['001', 60, '60'], ['093', 15, '1']]);
  await rechnung('2026_802', MIA, 'MIA MANDAT', [['001', 40, '60']]);
  r = await mia('GET', `${T}/halle/zahlart/ich`);
  assert.deepEqual([r.body.fragen, r.body.mitglied?.iban], [true, 'DE89 •••• 3000']);
  r = await mia('POST', `${T}/halle/zahlart/ich`, { zahlart: 'LASTSCHRIFT', mitglied: true, zustimmung: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mandatsref, 'TCO-611');

  // ---- Rechnung: Vorschau schreibt nichts fest, der Druck kündigt den Einzug an
  r = await admin('GET', `${T}/halle/rechnungen/2026_801/pdf`);
  assert.equal(r.ct, 'application/pdf');
  assert.equal((await sql`select zahlart from tco.rgkopf where rgnr_txt = '2026_801'`)[0].zahlart, null);
  for (const nr of ['2026_801', '2026_802']) {
    r = await admin('POST', `${T}/halle/rechnungen/${nr}/drucken`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const ab = plusTage(heute(), 5);
  const kopf = await sql`select rgnr_txt, zahlart, einzug_ab::text as einzug_ab, status from tco.rgkopf where rgnr_txt in ('2026_801', '2026_802') order by 1`;
  assert.deepEqual(kopf.map((k) => [k.zahlart, k.einzug_ab, k.status]), [['LASTSCHRIFT', ab, '2'], ['LASTSCHRIFT', ab, '2']]);
  r = await admin('GET', `${T}/halle/rechnungen/2026_801/mailtext`);
  assert.match(r.body.text, /per SEPA-Lastschrift von deinem Konto eingezogen/);

  // ---- Vorschlag: vor dem angekündigten Tag nichts, danach beide (Hugo Erstlastschrift)
  r = await admin('POST', `${L}/vorschlag`, { faellig: plusTage(heute(), 1) });
  assert.equal(r.body.pos.length, 0);
  assert.ok(r.body.excl.every((e: any) => /Einzug angekündigt ab/.test(e.meldung)));
  const faellig = bankTag(5);
  r = await admin('POST', `${L}/vorschlag`, { faellig });
  assert.deepEqual(r.body.pos.map((p: any) => [p.rgnr, p.betrag, p.sequenz, p.mandatsref]),
    [['2026_801', 75, 'FRST', 'TCOH-9990000711-1'], ['2026_802', 40, 'RCUR', 'TCO-611']]);

  // ---- Lauf
  r = await admin('POST', `${L}/laeufe`, { faellig, ohne: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const lauf = r.body.laufid as string;
  const n = Number(lauf);
  r = await admin('GET', `${L}/laeufe/${n}/datei`);
  const xml = r.body as string;
  assert.match(xml, /<CtrlSum>115.00<\/CtrlSum>/);
  assert.match(xml, /<SeqTp>FRST<\/SeqTp>/);
  assert.match(xml, /<SeqTp>RCUR<\/SeqTp>/);
  assert.match(xml, new RegExp(`<EndToEndId>TCOH${n}-1</EndToEndId>`));
  assert.match(xml, new RegExp(`<EndToEndId>TCOH${n}-2</EndToEndId>`));
  assert.match(xml, /<MndtId>TCOH-9990000711-1<\/MndtId>/);
  assert.match(xml, /<IBAN>DE89370400440532013000<\/IBAN>/);
  assert.deepEqual((await sql`select laufid from tco.rgkopf where rgnr_txt in ('2026_801', '2026_802')`).map((x) => x.laufid), [lauf, lauf]);
  assert.equal((await admin('POST', `${L}/vorschlag`, { faellig })).body.pos.length, 0, 'kein Doppeleinzug');
  assert.ok(!(await admin('GET', `${T}/soll/init`)).body.laeufe.some((l: any) => l.laufid === lauf), 'nicht in der Sollstellung');

  // ---- Bankimport: Sammelgutschrift → Rechnungen bezahlt, Aufteilung nach Erlöskonten
  const csv = (zeilen: string[]) => 'Buchungstag;Valutadatum;Name Zahlungsbeteiligter;Buchungstext;Verwendungszweck;Betrag;Saldo nach Buchung\n' + zeilen.join('\n') + '\n';
  r = await admin('POST', `${T}/fi/bank/lesen`, { konto: '1200', data: b64(csv([`${de(faellig)};${de(faellig)};TC OBERTHAL;EINR.-LASTSCHRIFT;Sammler;115,00;`])) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let u = r.body.umsaetze[0];
  assert.equal(u.laufid, lauf);
  assert.match(u.herkunft, /Hallen-Lastschrift Lauf/);
  r = await admin('POST', `${T}/fi/buchen`, { konto: '1200', umsaetze: [{ datum: u.datum, text: u.buchungsText, betrag: u.betrag, positionen: u.positionen, laufid: u.laufid }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const einzug = r.body.gebucht[0].internenr;
  let zeilen = await sql`select konto, sum(soll - haben)::float8 as b from tco.fibuchungen where internenr = ${einzug} group by konto order by konto`;
  assert.deepEqual(zeilen.map((x) => [x.konto, x.b]), [['1200', 115], ['8003', -100], ['8005', -15]]);
  assert.deepEqual((await sql`select status from tco.rgkopf where rgnr_txt in ('2026_801', '2026_802') order by 1`).map((x) => x.status), ['4', '4']);

  // ---- Rücklastschrift Hugo: 75 + 3,00 Bankgebühr (Referenz aus dem Lauf)
  const eref = (await admin('GET', `${L}/laeufe/${n}`)).body.pos.find((p: any) => p.rgnr === '2026_801').e2e_id as string;
  assert.match(eref, new RegExp(`^TCOH${n}-[12]$`));
  const rueck = csv([`${de(faellig)};${de(faellig)};Hugo Halle;RETOURE;Rücklastschrift EREF+${eref} MREF+TCOH-9990000711-1 Konto erloschen;-78,00;`]);
  r = await admin('POST', `${T}/fi/bank/lesen`, { konto: '1200', data: b64(rueck) });
  u = r.body.umsaetze[0];
  assert.deepEqual([u.rueck?.e2e, u.rueck?.rechnungen, u.rueck?.gebuehr], [eref, ['2026_801'], 3]);
  assert.deepEqual(u.positionen.map((p: any) => [p.gkonto, p.betrag]), [['8003', -60], ['8005', -15], ['4970', -3]]);
  const rueckBuchen = () => admin('POST', `${T}/fi/buchen`, { konto: '1200', umsaetze: [{ datum: u.datum, text: u.buchungsText, betrag: u.betrag, positionen: [{ gkonto: '8003', betrag: u.betrag }], rueck: { laufid: u.rueck.laufid, e2e: u.rueck.e2e } }] });
  r = await rueckBuchen();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Hallenrechnung 2026_801 wieder offen/);
  let rb = r.body.gebucht[0].internenr;
  zeilen = await sql`select konto, sum(soll - haben)::float8 as b from tco.fibuchungen where internenr = ${rb} group by konto order by konto`;
  assert.deepEqual(zeilen.map((x) => [x.konto, x.b]), [['1200', -78], ['4970', 3], ['8003', 60], ['8005', 15]]);
  let [k] = await sql`select status, zahlart, betrag::float8 as betrag, laufid, bezahlt from tco.rgkopf where rgnr_txt = '2026_801'`;
  assert.deepEqual([k.status, k.zahlart, k.betrag, k.laufid, k.bezahlt], ['1', 'UEBERWEISUNG', 78, null, null]);
  const [g] = await sql`select preis::float8 as preis, erloeskonto, description from tco.rgpos where rgnr_txt = '2026_801' order by rgpos desc limit 1`;
  assert.deepEqual([g.preis, g.erloeskonto], [3, '4970']);
  assert.match(g.description, /Rücklastschriftgebühr/);
  assert.equal((await sql`select status from tco.rgkopf where rgnr_txt = '2026_802'`)[0].status, '4', 'Mias Rechnung bleibt bezahlt');
  r = await admin('GET', `${L}/laeufe/${n}`);
  assert.equal(r.body.pos.find((p: any) => p.rgnr === '2026_801').rueck_gebuehr, 3);
  // Rücklastschrift ist erkannt und nicht noch einmal vorgeschlagen
  r = await admin('POST', `${T}/fi/bank/lesen`, { konto: '1200', data: b64(rueck) });
  assert.equal(r.body.umsaetze[0].status, 'gebucht');

  // Storno der Sammelgutschrift ist gesperrt, solange die Rücklastschrift gebucht ist
  r = await admin('POST', `${T}/fi/storno`, { internenr: einzug, grund: 'Test' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Rücklastschrift/);

  // Storno der Rückbuchung: Rechnung wieder bezahlt, Gebühr weg
  r = await admin('POST', `${T}/fi/storno`, { internenr: rb, grund: 'falsch erkannt' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /wieder bezahlt/);
  [k] = await sql`select status, zahlart, betrag::float8 as betrag, laufid from tco.rgkopf where rgnr_txt = '2026_801'`;
  assert.deepEqual([k.status, k.zahlart, k.betrag, k.laufid], ['4', 'LASTSCHRIFT', 75, lauf]);

  // feste Gebühr laut Einstellung statt der Bankgebühr
  assert.equal((await admin('PUT', `${L}/cfg`, { ...cfg, gebuehr: 5 })).status, 200);
  r = await rueckBuchen();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  rb = r.body.gebucht[0].internenr;
  assert.equal((await sql`select betrag::float8 as b from tco.rgkopf where rgnr_txt = '2026_801'`)[0].b, 80);
  // nach erneutem Versand lässt sich die Rückbuchung nicht mehr stornieren
  await sql`update tco.rgkopf set status = '3', versendet = current_date where rgnr_txt = '2026_801'`;
  r = await admin('POST', `${T}/fi/storno`, { internenr: rb, grund: 'Test' });
  assert.match(r.body.message, /bereits erneut versendet/);

  // ---- Lauf stornieren (nur vor der Verbuchung) und Mandat widerrufen
  r = await admin('POST', `${L}/laeufe/${n}/storno`, { grund: 'Test' });
  assert.match(r.body.message, /bereits in FI verbucht/);
  await rechnung('2026_803', MIA, 'MIA MANDAT', [['001', 20, '60']]);
  assert.equal((await admin('POST', `${T}/halle/rechnungen/2026_803/drucken`, {})).status, 200);
  r = await admin('POST', `${L}/laeufe`, { faellig, ohne: [] });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const lauf2 = Number(r.body.laufid);
  r = await admin('POST', `${L}/laeufe/${lauf2}/storno`, { grund: 'Datei nicht eingereicht' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sql`select laufid from tco.rgkopf where rgnr_txt = '2026_803'`)[0].laufid, null);
  r = await admin('POST', `${L}/zahlarten/${MIA}/widerruf`, { grund: 'Widerspruch per Telefon' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /1 angekündigte Lastschrift/);
  [k] = await sql`select zahlart, status from tco.rgkopf where rgnr_txt = '2026_803'`;
  assert.deepEqual([k.zahlart, k.status], ['UEBERWEISUNG', '2']);

  // Übersicht der Zahlarten; Verwaltung erfasst ein Papiermandat für Mia
  r = await admin('GET', `${L}/zahlarten`);
  assert.deepEqual(r.body.zahlarten.map((x: any) => [x.adrnr, x.status, x.mandatsref]), [['9990000711', 'AKTIV', 'TCOH-9990000711-1'], [MIA, 'WIDERRUFEN', 'TCO-611']]);
  r = await admin('POST', `${L}/zahlarten`, { adrnr: MIA, zahlart: 'LASTSCHRIFT', kontoinhaber: 'Mia Mandat', iban: 'DE02500105170137075030', mandatsdatum: '2026-01-15' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [mz] = await sql`select quelle, status, mandatsdatum::text as d, erfasst_ueber from tco.halle_zahlart where adrnr = ${MIA}`;
  assert.deepEqual([mz.quelle, mz.status, mz.d, mz.erfasst_ueber], ['EIGEN', 'AKTIV', '2026-01-15', 'VERWALTUNG']);
  // Hallenbucher dürfen die Verwaltung nicht aufrufen
  assert.equal((await hugo('GET', `${L}/zahlarten`)).status, 403);
});
