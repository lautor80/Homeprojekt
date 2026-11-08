/**
 * Integrationstest Sollstellung: Vorschlag, Lauf mit pain.008, Verbuchung über den Bankimport, Storno.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'tco';

const { sql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { activeModules } = await import('../src/modules.js');
const { buildApp } = await import('../src/app.js');
const sepa = await import('../src/lib/sepa.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
async function call(method: string, path: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
  const set = res.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body, ct };
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const S = '/api/m/tco/soll';

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

test('SEPA-Prüfungen und TARGET2', () => {
  assert.ok(sepa.ibanGueltig('DE89 3704 0044 0532 0130 00'));
  assert.ok(!sepa.ibanGueltig('DE89370400440532013001'));
  assert.ok(sepa.glaeubigerIdGueltig('DE98ZZZ09999999999'));
  assert.ok(!sepa.glaeubigerIdGueltig('DE99ZZZ09999999999'));
  assert.ok(!sepa.istTarget2Tag('2027-03-26')); // Karfreitag 2027
  assert.ok(!sepa.istTarget2Tag('2027-01-01'));
  assert.ok(sepa.istTarget2Tag('2027-01-04'));
  assert.equal(sepa.sepaText('Müller & Söhne – Café'), 'Mueller + Soehne Cafe');
});

test('Sollstellung: Vorschlag, Lauf, Datei, Verbuchung in FI, Storno', async () => {
  const mg = 'ADRNR;VORNAME;NACHNAME;ZAHLUNGSART;IBAN1;BIC1;ADRNRKIH;EINZUGLASTMANDLIEGTVOR;AUSTRITT;MITGLNRN\n' +
    '0000000001;Max;Müller;L;DE89370400440532013000;COBADEFFXXX;;J;;101\n' +
    '0000000002;Lena;Müller;L;;;0000000001;J;;102\n' +            // Kind, Zahler = Vater
    '0000000003;Erika;Alt;L;DE02120300000000202051;;;J;20261231;103\n' + // ausgetreten
    '0000000004;Tom;Ohne;L;DE02500105170137075030;;;J;;104\n' +   // kein Mandat
    '0000000005;Bar;Zahler;B;DE02500105170137075030;;;J;;105\n';  // Barzahler
  const sp = 'ADRNR;MANDATSNR;STATUS;ANGELEGTAM;GUELTIGBIS\n0000000001;TCO-101;X;20200101;\n0000000003;TCO-103;X;20200101;\n';
  const vt = 'ADRNR;VERTRAGNR;ART;ARTNAME;MITGLNR;SOLLSTELLUNG;VERTRAGBEGIN;VERTRAGENDE;BETRAG;ZAHLER_ADRNR\n' +
    '0000000001;1;01;Erwachsene;101;halbjährlich;20200101;;60,00;\n' +
    '0000000001;2;100;Spende;101;jährlich;20200101;;25,00;\n' +
    '0000000002;1;90;Jugendtraining;102;monatlich;20250101;;35,00;0000000002\n' + // Vertrag nennt das Kind selbst → abweichender Zahler gilt
    '0000000002;2;03;Jugendliche;102;halbjährlich;20250101;;30,00;0000000000\n' +
    '0000000003;1;01;Erwachsene;103;halbjährlich;20200101;;60,00;\n' +
    '0000000004;1;01;Erwachsene;104;halbjährlich;20200101;;60,00;\n' +
    '0000000005;1;01;Erwachsene;105;halbjährlich;20200101;;60,00;\n';
  const bpr = 'ART;GUELTIG_AB;GUELTIG_BIS;BETRAG\n01;20200101;20261231;60,00\n01;20270101;;65,00\n';
  const kt = 'KONTO;NAME;KENNZAHL\n1200;Girokonto;BA\n8002;Mitgliedsbeiträge;\n8006;Jugendtraining;\n8100;Spenden;\n';
  // Import als ZIP wie aus dem SAP-Report ZTCO_PORTAL_EXPORT (deflate + stored gemischt)
  const zip = zipErzeugen([['MITGLIEDER.CSV', mg], ['SEPA.CSV', sp], ['VERTRAEGE.CSV', vt], ['BEITRAG_PR.CSV', bpr], ['FIKONTEN.CSV', kt]]);
  let r = await call('POST', '/api/m/tco/import/pruefen', { dateien: [{ name: 'TCO_PORTAL_EXPORT.zip', data: zip.toString('base64') }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', '/api/m/tco/import/ausfuehren', { modus: 'neu', dateien: [{ name: 'TCO_PORTAL_EXPORT.zip', data: zip.toString('base64') }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // ---- Gläubigerdaten
  r = await call('PUT', `${S}/cfg`, { gl_name: 'Tennisclub Oberthal e.V.', iban: 'DE02 1203 0000 0000 2020 51', bic: '', gl_id: 'DE99ZZZ09999999999', bankkonto: '1200', vorlauf: 2 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Gläubiger-ID/);
  r = await call('PUT', `${S}/cfg`, { gl_name: 'Tennisclub Oberthal e.V.', iban: 'DE02 1203 0000 0000 2020 51', bic: '', gl_id: 'DE98ZZZ09999999999', bankkonto: '1200', vorlauf: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', `${S}/init`);
  assert.deepEqual(r.body.fehlt, []);

  // ---- Vorschlag Januar 2027 (Beitragsmonat): MB + Spende + JT
  r = await call('GET', `${S}/faelligkeit?sollper=202701`);
  const faellig = r.body.faellig;
  assert.ok(faellig >= '2027-01-04', faellig);
  r = await call('POST', `${S}/vorschlag`, { sollper: '202701', mitMb: true, mitJt: true, faellig });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pos = r.body.pos;
  assert.equal(pos.length, 4); // Max MB + Spende, Lena JT + MB
  const maxMb = pos.find((p: any) => p.adrnr === '0000000001' && p.vertragnr === '1');
  assert.equal(maxMb.betrag, 65); // Beitragsstamm ab 2027
  assert.ok(pos.every((p: any) => p.zahler_adrnr === '0000000001'));
  assert.equal(r.body.tx.length, 1); // ein Zahler, ein Mandat
  assert.equal(r.body.tx[0].betrag, 65 + 25 + 35 + 30);
  const excl = r.body.excl.map((e: any) => [e.adrnr, e.meldung]);
  assert.ok(excl.some(([a, m]: string[]) => a === '0000000003' && /Ausgetreten zum 31.12.2026/.test(m)));
  assert.ok(excl.some(([a, m]: string[]) => a === '0000000004' && /Mandatsreferenz fehlt/.test(m)));
  assert.ok(excl.some(([a, m]: string[]) => a === '0000000005' && /Keine Lastschrift/.test(m)));
  assert.match(r.body.tx[0].zweck, /^TC OBERTHAL MUELLER (LENA\/MAX|MAX\/LENA) [A-Z/]+[A-Z] VIELEN DANK$/);

  // ---- Lauf erzeugen (Spende abgewählt)
  const ohne = ['0000000001|2'];
  r = await call('POST', `${S}/laeufe`, { sollper: '202701', mitMb: true, mitJt: true, faellig, ohne });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const lauf = r.body.laufid;
  assert.equal(lauf, '0000000001');
  r = await call('GET', `${S}/laeufe/1/datei`);
  assert.equal(r.status, 200);
  const xml = r.body as string;
  assert.match(xml, /urn:iso:std:iso:20022:tech:xsd:pain.008.001.02/);
  assert.match(xml, /<NbOfTxs>1<\/NbOfTxs>/);
  assert.match(xml, /<CtrlSum>130.00<\/CtrlSum>/);
  assert.match(xml, /<IBAN>DE89370400440532013000<\/IBAN>/);
  assert.match(xml, /<MndtId>TCO-101<\/MndtId>/);
  assert.match(xml, /<SeqTp>RCUR<\/SeqTp>/);
  assert.match(xml, /<EndToEndId>NOTPROVIDED<\/EndToEndId>/);
  assert.match(xml, new RegExp(`<ReqdColltnDt>${faellig}</ReqdColltnDt>`));

  // Doppeleinzug ausgeschlossen, Spende weiter offen
  r = await call('POST', `${S}/vorschlag`, { sollper: '202701', mitMb: true, mitJt: true, faellig });
  assert.deepEqual(r.body.pos.map((p: any) => p.vertragnr), ['2']);
  assert.ok(r.body.excl.some((e: any) => e.grund === 'Bereits eingezogen'));

  // PDF-Protokoll
  r = await call('GET', `${S}/laeufe/1/pdf`);
  assert.equal(r.ct, 'application/pdf');

  // ---- Bankimport erkennt die Sammelgutschrift und bucht sie je Position
  const d = faellig.split('-').reverse().join('.');
  const csv = 'Buchungstag;Valutadatum;Name Zahlungsbeteiligter;Buchungstext;Verwendungszweck;Betrag;Saldo nach Buchung\n' +
    `${d};${d};TC OBERTHAL;EINR.-LASTSCHRIFT;Sammler TCO;130,00;1130,00\n`;
  r = await call('POST', '/api/m/tco/fi/bank/lesen', { konto: '1200', data: b64(csv) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const u = r.body.umsaetze[0];
  assert.equal(u.laufid, lauf);
  assert.match(u.herkunft, /Sollstellung Lauf 1/);
  r = await call('POST', '/api/m/tco/fi/buchen', { konto: '1200', umsaetze: [{ datum: u.datum, text: u.buchungsText, betrag: u.betrag, positionen: u.positionen, laufid: u.laufid }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const nr = r.body.gebucht[0].internenr;
  const zeilen = await sql`select konto, posnr, haben::float8 as haben, soll::float8 as soll from tco.fibuchungen where internenr = ${nr} order by konto, posnr`;
  assert.deepEqual(zeilen.map((z) => [z.konto, z.posnr, z.soll || z.haben]), [['1200', 0, 130], ['8002', 0, 30], ['8002', 1, 65], ['8006', 0, 35]]);
  r = await call('GET', `${S}/laeufe/1`);
  assert.equal(r.body.kopf.status, 'V');
  assert.ok(r.body.pos.every((p: any) => p.internenr === nr && p.status === 'V'));

  // Storno des Laufs nicht mehr möglich; Storno in FI setzt den Lauf zurück
  r = await call('POST', `${S}/laeufe/1/storno`, { grund: 'Test' });
  assert.match(r.body.message, /bereits in FI verbucht/);
  r = await call('POST', '/api/m/tco/fi/storno', { internenr: nr, grund: 'Rücklastschrift' });
  assert.match(r.body.text, /Sollstellung Lauf 1 wieder offen/);
  r = await call('GET', `${S}/laeufe/1`);
  assert.equal(r.body.kopf.status, 'E');

  // ---- Lauf stornieren: Positionen wieder einziehbar
  r = await call('POST', `${S}/laeufe/1/storno`, { grund: 'Datei nicht eingereicht' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `${S}/vorschlag`, { sollper: '202701', mitMb: true, mitJt: true, faellig });
  assert.equal(r.body.pos.length, 4);
  r = await call('GET', `${S}/laeufe/1/datei`);
  assert.equal(r.status, 400);

  // ---- Juli: nur JT (Häkchen MB aus) – monatlich fällig
  r = await call('POST', `${S}/vorschlag`, { sollper: '202702', mitMb: false, mitJt: true, faellig: '2027-02-02' });
  assert.deepEqual(r.body.pos.map((p: any) => p.artname), ['Jugendtraining']);
});

/** Minimaler ZIP-Schreiber für den Test (gerade Einträge deflate, ungerade stored) */
function zipErzeugen(dateien: [string, string][]): Buffer {
  const lokal: Buffer[] = []; const zentral: Buffer[] = []; let off = 0;
  dateien.forEach(([name, text], i) => {
    const roh = Buffer.from(text, 'utf8'); const methode = i % 2 === 0 ? 8 : 0;
    const daten = methode === 8 ? zlib.deflateRawSync(roh) : roh; const n = Buffer.from(name);
    const crc = zlib.crc32(roh);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(methode, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(daten.length, 18); lh.writeUInt32LE(roh.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(methode, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(daten.length, 20); ch.writeUInt32LE(roh.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    lokal.push(lh, n, daten); zentral.push(ch, n); off += 30 + n.length + daten.length;
  });
  const cd = Buffer.concat(zentral); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(dateien.length, 8); e.writeUInt16LE(dateien.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...lokal, cd, e]);
}
