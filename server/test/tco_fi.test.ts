/**
 * Integrationstest FI Belege (Bankimport, Buchen, Rechnung, Belege, Storno, Unveränderlichkeit).
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
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const b64 = (s: string, enc: BufferEncoding = 'utf8') => Buffer.from(s, enc).toString('base64');
const F = '/api/m/tco/fi';

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

test('FI Belege: Bankimport, Buchen, Rechnung, Storno', async () => {
  // ---- Stammdaten aus SAP
  const konten = 'KONTO;NAME;KENNZAHL\n1200;Girokonto Testbank;BA\n1000;Kasse;BK\n654;Darlehen;BA\n4970;Kosten Geldverkehr;\n8003;Hallenmiete;\n8005;Clubheimerträge;\n2300;Versicherungen;\n8100;Spenden;\n';
  const bankab = 'JAHR;KONTO;ANFANGSBESTAND;ENDBESTAND\n2026;1200;1.000,00;\n';
  const rg = 'RGNR_TXT;JAHR;RGNR;KUNDE;BETRAG;STATUS;ANGELEGT_AM;VERSENDET;ADRNR;DOKNR\n' +
    '2026_014;2026;14;ERIKA MUSTER;80,00;3;20261001;20261002;9900000017;000321\n' +
    '2026_015;2026;15;MAX MEIER;100,00;3;20261001;20261002;0000000012;\n';
  const alt = 'INTERNENR;KONTO;POSNR;JAHR;MONAT;DATUM;TEXT;BETRAG;BELNR;GKONTO;SOLL;HABEN\n' +
    '0000000100;1200;000;2026;10;20261005;Allianz Versicherung Beitrag;120,00;55;2300;0;120,00\n' +
    '0000000100;2300;000;2026;10;20261005;Allianz Versicherung Beitrag;120,00;55;1200;120,00;0\n' +
    '0000000101;1200;000;2026;11;20261102;Allianz Versicherung Beitrag;120,00;56;2300;0;120,00\n' +
    '0000000101;2300;000;2026;11;20261102;Allianz Versicherung Beitrag;120,00;56;1200;120,00;0\n';
  const map = 'INTERNENR;KONTO;DOKNR\n0000000100;;000777\n0000000101;;000777\n';
  let r = await call('POST', '/api/m/tco/import/ausfuehren', { modus: 'neu', dateien: [
    { name: 'ZTCO_FIKONTEN.CSV', data: b64(konten) }, { name: 'ZTCO_FIBANKAB.CSV', data: b64(bankab) },
    { name: 'ZTCO_RGKOPF.CSV', data: b64(rg) }, { name: 'ZTCO_FIBUCHUNGEN.CSV', data: b64(alt) }, { name: 'ZTCO_FIPAPERMAP.CSV', data: b64(map) },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // ---- Liste und Salden
  r = await call('GET', `${F}/buchungen?von=2026-10-01&bis=2026-11-30&konto=1200`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.zeilen.length, 2);
  assert.deepEqual([r.body.salden.jahresanfang, r.body.salden.aktuell], [1000, 760]);
  assert.equal(r.body.zeilen[0].anhaenge, 1);

  // ---- Bankimport: Hallenrechnung, SumUp, bereits gebucht, Historie mit Dauerbeleg, unbekannt
  const csv = 'sep=;\nBezeichnung Auftragskonto;IBAN Auftragskonto;Bankname Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;Buchungstext;Verwendungszweck;Betrag;Saldo nach Buchung\n' +
    'Girokonto;DE02120300000000202051;Testbank;03.11.2026;03.11.2026;Erika Muster;DE11;Gutschrift;"Rechnung 2026 014\nHalle";80,00;920,00\n' +
    'Girokonto;DE02120300000000202051;Testbank;02.11.2026;02.11.2026;Allianz Versicherung;DE22;Lastschrift;Beitrag;-120,00;760,00\n' +
    'Girokonto;DE02120300000000202051;Testbank;04.11.2026;04.11.2026;SumUp Payments;DE33;Gutschrift;Auszahlung;95,50;1.015,50\n' +
    'Girokonto;DE02120300000000202051;Testbank;04.11.2026;04.11.2026;Max Meier;DE44;Gutschrift;Hallenmiete 2026_015 Teil;40,00;1.055,50\n' +
    'Girokonto;DE02120300000000202051;Testbank;05.11.2026;05.11.2026;Allianz Versicherung;DE22;Lastschrift;Beitrag Dezember;-120,00;935,50\n' +
    'Girokonto;DE02120300000000202051;Testbank;05.11.2026;05.11.2026;Unbekannt GmbH;DE55;Gutschrift;Spende;50,00;985,50\n';
  r = await call('POST', `${F}/bank/lesen`, { konto: '1200', data: b64(csv, 'latin1') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.iban, 'DE02120300000000202051');
  assert.equal(d.endsaldo, 985.5);
  const u = (name: string, zweck?: string) => d.umsaetze.find((x: any) => x.name === name && (!zweck || x.zweck.startsWith(zweck)));
  assert.equal(u('Erika Muster').zweck, 'Rechnung 2026 014 Halle'); // Zeilenumbruch → Leerzeichen
  assert.deepEqual([u('Erika Muster').positionen[0].gkonto, u('Erika Muster').positionen[0].rgnr], ['8003', '2026_014']);
  assert.match(u('Allianz Versicherung', 'Beitrag').statusText, /bereits gebucht \(intern 0000000101\)/);
  assert.deepEqual(u('SumUp Payments').positionen.map((p: any) => p.gkonto), ['8005', '4970']);
  const allianz = u('Allianz Versicherung', 'Beitrag Dezember');
  assert.equal(allianz.status, 'neu');
  assert.equal(allianz.positionen[0].gkonto, '2300');
  assert.equal(allianz.art, 'historie');
  assert.deepEqual(allianz.belegVorschlag.doks, [777]);
  assert.equal(u('Unbekannt GmbH').positionen.length, 0);

  // ---- falsches Konto: IBAN gehört zu 1200
  await sql`insert into tco.fibankiban (konto, iban) values ('1200', 'DE02120300000000202051')`;
  r = await call('POST', `${F}/bank/lesen`, { konto: '654', data: b64(csv) });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /gehört zu Konto 1200/);

  // ---- Prüfung: Gegenkonto fehlt → nichts gebucht
  const neu = d.umsaetze.filter((x: any) => x.status === 'neu');
  const zuBuchen = (x: any) => ({ datum: x.datum, text: x.buchungsText, betrag: x.betrag, positionen: x.positionen, belege: x.belegVorschlag?.doks ?? [] });
  r = await call('POST', `${F}/buchen`, { konto: '1200', umsaetze: neu.map(zuBuchen) });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Gegenkonto fehlt/);

  // SumUp: Gebühr 4,50 → 8005 100,00 / 4970 −4,50; Unbekannt → 8100; Teilzahlung Meier auf 8003
  u('SumUp Payments').positionen = [{ gkonto: '8005', betrag: 100 }, { gkonto: '4970', betrag: -4.5, text: 'SumUp Gebühren' }];
  u('Unbekannt GmbH').positionen = [{ gkonto: '8100', betrag: 50 }];
  u('Max Meier').positionen = [{ gkonto: '8003', betrag: 40, rgnr: '2026_015' }];
  r = await call('POST', `${F}/buchen`, { konto: '1200', iban: d.iban, umsaetze: neu.map(zuBuchen).concat([]).map((x: any) => {
    const o = neu.find((y: any) => y.buchungsText === x.text && y.betrag === x.betrag);
    return { ...x, positionen: o.positionen, notiz: o.name === 'Unbekannt GmbH' ? 'Spende Sommerfest' : null };
  }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.gebucht.length, 5);
  assert.match(r.body.text, /5 Buchung\(en\) erstellt/);

  // Nummern fortlaufend, Belegnummer je Konto/Jahr ab 57
  const g = r.body.gebucht;
  assert.deepEqual(g.map((x: any) => x.internenr), ['0000000102', '0000000103', '0000000104', '0000000105', '0000000106']);
  assert.equal(g[0].belnr, '57');

  // Hallenrechnung: Vollzahlung → Status 4, Rechnungs-PDF als Beleg
  let [k] = await sql`select status, bezahlt::text from tco.rgkopf where rgnr_txt = '2026_014'`;
  assert.deepEqual([k.status, k.bezahlt], ['4', '2026-11-03']);
  const [m1] = await sql`select count(*)::int as n from tco.fipapermap where internenr = '0000000102' and ltrim(doknr,'0') = '321'`;
  assert.equal(m1.n, 1);
  // Teilzahlung → Status 5, rgtz
  [k] = await sql`select status from tco.rgkopf where rgnr_txt = '2026_015'`;
  assert.equal(k.status, '5');
  r = await call('GET', `${F}/zahlungen?rgnr=2026_015`);
  assert.deepEqual([r.body[0].gezahlt, r.body[0].offen], [40, 60]);

  // SumUp-Split: Bankseite 95,50 Soll, Gegenseite 8005 Haben 100, 4970 Soll 4,50
  const sumup = await sql`select konto, posnr, soll::float8, haben::float8, gkonto from tco.fibuchungen where internenr = '0000000103' order by konto`;
  assert.deepEqual(sumup.map((x) => [x.konto, x.soll, x.haben, x.gkonto]), [['1200', 95.5, 0, '8005'], ['4970', 4.5, 0, '1200'], ['8005', 0, 100, '1200']]);

  // Notiz auch ohne Beleg gespeichert (E10)
  const [n1] = await sql`select notiz from tco.finotiz where internenr = '0000000106'`;
  assert.equal(n1.notiz, 'Spende Sommerfest');

  // Saldo nach Buchung = Bank
  r = await call('GET', `${F}/buchungen?von=2026-11-01&bis=2026-11-30&konto=1200`);
  assert.equal(r.body.salden.aktuell, 905.5);

  // ---- Unveränderlichkeit
  await assert.rejects(sql`update tco.fibuchungen set betrag = 1 where internenr = '0000000102'`, /nicht geändert/);
  await assert.rejects(sql`delete from tco.fibuchungen where internenr = '0000000102'`, /nicht gelöscht/);

  // ---- Storno der Teilzahlung: Rechnung wieder offen (E12)
  r = await call('POST', `${F}/storno`, { internenr: '0000000104', grund: '' });
  assert.equal(r.status, 400);
  r = await call('POST', `${F}/storno`, { internenr: '0000000104', grund: 'Falsche Rechnung' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.internenr, '0000000107');
  assert.match(r.body.text, /Rechnung 2026_015 wieder offen/);
  [k] = await sql`select status, bezahlt from tco.rgkopf where rgnr_txt = '2026_015'`;
  assert.deepEqual([k.status, k.bezahlt], ['3', null]);
  const st = await sql`select konto, soll::float8, haben::float8, storno_zu from tco.fibuchungen where internenr = '0000000107' order by konto`;
  assert.deepEqual(st.map((x) => [x.konto, x.soll, x.haben, x.storno_zu]), [['1200', 0, 40, '0000000104'], ['8003', 40, 0, '0000000104']]);
  r = await call('POST', `${F}/storno`, { internenr: '0000000104', grund: 'nochmal' });
  assert.match(r.body.message, /bereits storniert/);
  r = await call('POST', `${F}/storno`, { internenr: '0000000107', grund: 'Storno vom Storno' });
  assert.match(r.body.message, /selbst ein Storno/);
  r = await call('GET', `${F}/buchung/0000000104`);
  assert.equal(r.body.storniertDurch, '0000000107');
  assert.match(r.body.notizen[0].notiz, /Storniert durch 0000000107: Falsche Rechnung/);

  // ---- nur in den Stammdaten hinterlegte Geldkonten, nur im Geschäftsjahr verwendete Konten
  const kassenUmsatz = { datum: '2026-11-05', text: 'Einzahlung', betrag: 20, positionen: [{ gkonto: '8005', betrag: 20 }] };
  r = await call('POST', `${F}/buchen`, { konto: '1000', modus: 'bank', umsaetze: [kassenUmsatz] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nicht als Konto mit Bankdatei hinterlegt/);
  r = await call('POST', `${F}/buchen`, { konto: '1200', modus: 'manuell', umsaetze: [kassenUmsatz] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nicht für manuelle Buchungen hinterlegt/);
  r = await call('POST', `${F}/buchen`, { konto: '8005', umsaetze: [{ ...kassenUmsatz, positionen: [{ gkonto: '1000', betrag: 20 }] }] });
  assert.equal(r.status, 400, 'Erlöskonto ist kein Geldkonto');
  await sql`insert into tco.fikontojahr (konto, jahr, aktiv) values ('8005', 2026, false)`;
  r = await call('POST', `${F}/buchen`, { konto: '1000', modus: 'manuell', umsaetze: [kassenUmsatz] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /nicht in Verwendung: 8005 \(2026\)/);
  await sql`delete from tco.fikontojahr where konto = '8005' and jahr = 2026`;

  // ---- Rechnung nachträglich an Buchung zuordnen (Liste)
  r = await call('POST', `${F}/buchen`, { konto: '1000', umsaetze: [{ datum: '2026-11-06', text: 'Barzahlung Meier Halle', betrag: 100, positionen: [{ gkonto: '8003', betrag: 100 }] }] });
  const kasse = r.body.gebucht[0].internenr;
  r = await call('POST', `${F}/rechnung`, { internenr: kasse, konto: '8003', posnr: 0, rgnr: '2026_015' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, '4');
  r = await call('POST', `${F}/rechnung`, { internenr: kasse, konto: '8003', posnr: 0, rgnr: '2026_015' });
  assert.equal(r.status, 400);

  // ---- Belege: zuordnen, entfernen mit Begründung
  r = await call('POST', `${F}/belege/zuordnen`, { internenr: ['0000000106'], doks: [888, 889] });
  assert.match(r.body.text, /2 Zuordnung/);
  r = await call('POST', `${F}/belege/entfernen`, { internenr: '0000000106', dok: 889, grund: '' });
  assert.equal(r.status, 400);
  r = await call('POST', `${F}/belege/entfernen`, { internenr: '0000000106', dok: 889, grund: 'falscher Beleg' });
  assert.equal(r.status, 200);
  r = await call('POST', `${F}/belege/uebernehmen`, { internenr: '0000000106', von: '0000000100' });
  assert.match(r.body.text, /1 Beleg/);

  // ---- Notizen: nur eigene löschen
  r = await call('GET', `${F}/buchung/0000000106`);
  assert.deepEqual(r.body.belege.sort(), [777, 888]);
  const nid = r.body.notizen.find((x: any) => x.notiz === 'Spende Sommerfest').id;
  r = await call('DELETE', `${F}/notiz`, { internenr: '0000000106', id: nid });
  assert.equal(r.status, 200);

  // ---- Änderungsbeleg
  const [h] = await sql`select count(*)::int as n from core.change_header where object_type = 'FIBELEG' and action = 'STORNO'`;
  assert.ok(h.n >= 1);
});
