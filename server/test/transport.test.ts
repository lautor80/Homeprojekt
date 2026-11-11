/**
 * Integrationstest Transportmodul gegen eine LEERE Test-Datenbank.
 *   TEST_DATABASE_URL=postgres://portal:portal@localhost:5432/portal_test npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url.split('/').pop() ?? '')) throw new Error('TEST_DATABASE_URL fehlt oder enthält nicht "test".');
process.env.DATABASE_URL = url;
process.env.PORTAL_MODULES = 'transport';

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
  const ct = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.rawPayload, ct, text: res.body };
}
const T = '/api/m/transport';
const b64 = (s: string, enc: BufferEncoding = 'utf8') => Buffer.from(s, enc).toString('base64');

before(async () => {
  await sql.unsafe(`drop schema if exists transport cascade; drop schema if exists beispiel cascade; drop schema if exists core cascade;
                    drop table if exists public.schema_migrations;`);
  await migrate(activeModules(), () => {});
  app = await buildApp({ logger: false });
  await call('POST', '/api/setup', { orgName: 'Euroflex', username: 'admin', displayName: 'Admin', password: 'geheim-geheim' });
});
after(async () => {
  await app.close();
  await sql.end();
});

test('Transport: Import, Auftrag, Rechnung, Dokumente', async () => {
  // ---- Firmendaten ----
  assert.equal((await call('PUT', `${T}/firma`, {
    name: 'Benjamin Hartyniuk Euroflex', strasse: 'Schwimmbadstraße 28', plz: '66649', ort: 'Oberthal', land: 'DE',
    ustid: 'DE814480003', kontakt: 'Benjamin Hartyniuk', telefon: '+49 6854 909711', fax: '+49 6854 909713',
    email: 'info@euroflex.de', bank: 'Kreissparkasse St. Wendel', iban: 'DE85592510200000015644', bic: 'SALADE51WND',
    zahlungsziel_tage: 14, ust_satz: 19, rechnung_startnr: 5001,
    logo: process.env.TEST_LOGO ? `data:image/jpeg;base64,${fs.readFileSync(process.env.TEST_LOGO).toString('base64')}` : null,
  })).status, 200);

  // ---- Import (Windows-1252, SAP-Formate) ----
  const adr = 'MANDT;ADRNR;KUNDENNAME;KUNDENNAME2;ANREDE;NAME;VORNAME;STRASSE;HAUSNUMMER;LAND;PLZ;ORT;TELEFON;FAX;EMAIL;GLN;MARKT\n' +
    '100;0000000792;Getränke Müller GmbH;;Herr;Müller;Hans;Hauptstraße;5;DE;66606;St. Wendel;0685112;;einkauf@mueller.de;4012345000009;M12\n' +
    '100;0000000793;Spedition Schmitt;;Frau;Schmitt;Anna;Industriestr.;12;DE;66111;Saarbrücken;;;dispo@schmitt.de;;\n' +
    '100;0000000794;"Brasserie ""Le Nord""";;;;;Rue de Metz;3;FR;57000;Metz;;;achat@lenord.fr;;\n';
  const auf = 'RGNR_TXT;RGANLAGDAT;KUNDE;UNTERNEHMER;RE;RGBETRAG;KENNZEICHEN;ART;FRACHTPREIS_EK;FRACHTPREIS_VK;LADENUMMER;LADEGUT;GEWICHT;LADEWEISE;PALETTENTAUSCH;ORDERNUMMER;FAKTURA;FAKTURADATUM;STEUERRELEVANT;DOK_FEHLEN;LEISTUNGSDATUM;UNBEKANNT\n' +
    '2025_0041;20251103;0000000792;0000000793;0000000000;1.071,00;SB-XY 12;001;900,00;1.100,00;;002;24;001;099;BE-4711;2025_5012;20251110;X;;20251105;egal\n' +
    '2025_0042;20251104;0000000794;0000000793;0000000000;850,00;;001;850,00;950,00;;002;;001;099;FOLGT;;00000000;;X;00000000;\n';
  const pos = 'MANDT;RGNR_TXT;POS;FIRMA;STRASSE;PLZORT;LAND;LADENUMMER;DATUM;ZEIT;FIRMA_E;STRASSE_E;PLZORT_E;LAND_E;DATUM_E;ZEIT_E\n' +
    '100;2025_0041;1;Brauerei Becker;Am Brauhaus 1;66386 St. Ingbert;DE;L-77;20251104;08:00;Getränke Müller GmbH;Hauptstraße 5;66606 St. Wendel;DE;20251105;10-12 Uhr\n' +
    '100;2025_0042;1;Euroflex;Schwimmbadstraße 28;66649 Oberthal;DE;;20251104;;Brasserie Le Nord;Rue de Metz 3;57000 Metz;FR;20251105;\n';
  const werte = 'DOMNAME;DOMVALUE_L;VALPOS;DDTEXT\nZEU_LADEART;001;0001;Sattelzug\nZEU_LADEART;002;0002;Kühlzug\nZEU_LADEGUT;002;0002;Getränke\n' +
    'ZEU_LADEWEISE;001;0001;Palette\nZEU_PALETTENTAUSCH;099;0099;kein Tausch\n';
  const prod = 'PROD_KEY;TEXT;PREIS;VALID_TO\n901;6er Holzträger geflammt;4,40;99991231\n902;60cm Holzträger geflammt;7,50;99991231\n';
  const dateien = [
    { name: 'Adressen.csv', data: b64(adr.replace(/\n/g, '\r\n'), 'latin1') },
    { name: 'Aufträge.csv', data: b64(auf) },
    { name: 'Aufträge_POs.csv', data: b64(pos) },
    { name: 'Werte.csv', data: b64(werte) },
    { name: 'Produkte.csv', data: b64(prod) },
  ];
  const pr = await call('POST', `${T}/import/pruefen`, { dateien });
  assert.equal(pr.status, 200);
  const st = Object.fromEntries(pr.body.map((s: { key: string }) => [s.key, s]));
  assert.equal(st.ADR.anzahl, 3);
  assert.equal(st.AUF.neu, 2);
  assert.match(st.AUF.hinweis, /UNBEKANNT/);
  const im = await call('POST', `${T}/import/ausfuehren`, { dateien });
  assert.equal(im.status, 200, JSON.stringify(im.body));
  assert.match(im.body.text, /2 Aufträge, 2 Stops, 3 Adressen/);
  assert.match(im.body.text, /Nummernkreise angepasst: 2025 A → 0042, 2025 R → 5012/);
  // zweiter Import ändert nichts
  assert.match((await call('POST', `${T}/import/ausfuehren`, { dateien })).body.text, /Neu angelegt: 0 Aufträge/);

  const a41 = (await call('GET', `${T}/auftraege/2025_0041`)).body;
  assert.equal(a41.kundeAdr.kundenname, 'Getränke Müller GmbH');
  assert.equal(a41.rgbetrag, 1071);
  assert.equal(a41.stops[0].datum, '2025-11-04');
  assert.equal(a41.fakturadatum, '2025-11-10');
  const a42 = (await call('GET', `${T}/auftraege/2025_0042`)).body;
  assert.equal(a42.kundeAdr.kundenname, 'Brasserie "Le Nord"');
  assert.equal(a42.fakturadatum, null);
  assert.equal(a42.dok_fehlen, true);

  // ---- Neuer Holzträgerauftrag ----
  const neuH = (await call('GET', `${T}/neu/H`)).body;
  assert.equal(neuH.traeger.length, 2);
  const jahr = new Date().getFullYear();
  assert.equal(neuH.nummerVorschau, `${jahr}_0001`);
  const leer = await call('POST', `${T}/auftraege`, { ...neuH, kunde: 792, traeger: neuH.traeger });
  assert.equal(leer.status, 400);
  assert.match(leer.body.message, /mindestens eine Menge/);
  neuH.traeger[0].menge = 100;
  neuH.traeger[1].menge = 20;
  const h = await call('POST', `${T}/auftraege`, { ...neuH, kunde: 792, unternehmer: 793, frachtpreis_ek: 120 });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.auftragsnr, `${jahr}_0001`);
  const hDet = (await call('GET', `${T}/auftraege/${h.body.auftragsnr}`)).body;
  assert.equal(hDet.typ, 'H');
  // (100 × 4,40 + 20 × 7,50 + 120) × 1,19 = 844,90
  assert.equal(hDet.rgbetrag, 844.9);

  // ---- Neuer Frachtauftrag: Pflichtprüfung Empfangsort ----
  const neuF = (await call('GET', `${T}/neu/F`)).body;
  neuF.stops[0] = { ...neuF.stops[0], firma: 'Lager A', plzort: '66649 Oberthal', firma_e: 'Kunde B' };
  const f1 = await call('POST', `${T}/auftraege`, { ...neuF, kunde: 794, unternehmer: 793 });
  assert.equal(f1.status, 400);
  assert.match(f1.body.message, /ersten Stop/);
  neuF.stops[0].plzort_e = '57000 Metz';
  neuF.stops[0].land_e = 'FR';
  neuF.frachtpreis_ek = 500;
  neuF.steuerrelevant = false;
  const f2 = await call('POST', `${T}/auftraege`, { ...neuF, kunde: 794, unternehmer: 793 });
  assert.equal(f2.status, 200, JSON.stringify(f2.body));
  assert.equal(f2.body.auftragsnr, `${jahr}_0002`);

  // ---- Liste ----
  const liste = (await call('GET', `${T}/auftraege?jahr=ALL&fakt=ALL`)).body;
  assert.equal(liste.length, 4);
  const lH = liste.find((r: { auftragsnr: string }) => r.auftragsnr === h.body.auftragsnr);
  assert.equal(lH.art, 'Holzträger');
  assert.equal(lH.status, 'Offen');
  const l41 = liste.find((r: { auftragsnr: string }) => r.auftragsnr === '2025_0041');
  assert.equal(l41.route, '66386 St. Ingbert → 66606 St. Wendel');
  assert.equal(l41.status, 'Fakturiert');

  // ---- Sammelrechnung über die beiden neuen Aufträge ----
  const sr = await call('POST', `${T}/rechnungen`, { auftraege: [h.body.auftragsnr, f2.body.auftragsnr, '2025_0041'], sammel: true });
  assert.equal(sr.status, 200, JSON.stringify(sr.body));
  assert.deepEqual(sr.body.fakturen, [`${jahr}_5001`]);
  assert.equal(sr.body.ignoriert, 1);
  // Einzelrechnung für 2025_0042
  const er = await call('POST', `${T}/rechnungen`, { auftraege: ['2025_0042'], sammel: false });
  assert.deepEqual(er.body.fakturen, [`${jahr}_5002`]);
  // erneut: nichts mehr offen
  assert.equal((await call('POST', `${T}/rechnungen`, { auftraege: ['2025_0042'], sammel: false })).status, 400);

  // ---- PDFs ----
  for (const [art, id] of [['R', `${jahr}_5001`], ['R', '2025_5012'], ['L', '2025_0041'], ['T', '2025_0041'], ['T', h.body.auftragsnr]]) {
    const r = await call('GET', `${T}/pdf/${art}/${id}`);
    assert.equal(r.status, 200, `${art} ${id}`);
    assert.equal(r.ct, 'application/pdf');
    const buf = r.body as Buffer;
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    if (process.env.PDF_OUT) fs.writeFileSync(`${process.env.PDF_OUT}/${art}_${id}.pdf`, buf);
  }

  // ---- XRechnung ----
  const xr = (await call('GET', `${T}/xrechnung/${jahr}_5001`)).body;
  assert.equal(xr.anzahlAuftraege, 2);
  assert.match(xr.xml, /<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0<\/cbc:CustomizationID>/);
  assert.match(xr.xml, /<cbc:Note>Sammelrechnung über 2 Transportaufträge<\/cbc:Note>/);
  // Holzträgerauftrag S (844,90 brutto → 710,00 netto), Frachtauftrag ohne Steuer (Empfänger = Kunde 792, DE → E)
  assert.match(xr.xml, /<cbc:TaxableAmount currencyID="EUR">710.00<\/cbc:TaxableAmount>/);
  assert.match(xr.xml, /<cbc:PayableAmount currencyID="EUR">1344.90<\/cbc:PayableAmount>/);
  assert.ok(xr.html.includes('RECHNUNGSEMPFÄNGER'));
  if (process.env.PDF_OUT) fs.writeFileSync(`${process.env.PDF_OUT}/xrechnung.xml`, xr.xml);
  // Reverse Charge (Kunde FR, nicht steuerrelevant) → Hinweis USt-IdNr.
  const xr2 = (await call('GET', `${T}/xrechnung/${jahr}_5002`)).body;
  assert.match(xr2.xml, /VATEX-EU-AE/);
  assert.ok(xr2.hinweise.some((h: string) => /BT-48/.test(h)));

  // ---- ZUGFeRD: Rechnungs-PDF ist PDF/A-3 mit eingebetteter factur-x.xml ----
  const zpdf = (await call('GET', `${T}/pdf/R/${jahr}_5001`)).body as Buffer;
  const roh = zpdf.toString('latin1');
  assert.ok(roh.startsWith('%PDF-1.7'), 'PDF 1.7');
  assert.match(roh, /<pdfaid:part>3<\/pdfaid:part>/);
  assert.match(roh, /<pdfaid:conformance>B<\/pdfaid:conformance>/);
  assert.match(roh, /\/AFRelationship \/Alternative/);
  assert.match(roh, /\/UF \(factur-x\.xml\)/);
  assert.match(roh, /<fx:ConformanceLevel>EN 16931<\/fx:ConformanceLevel>/);
  assert.match(roh, /\/FontFile2/, 'Schriften eingebettet');
  assert.doesNotMatch(roh, /\/BaseFont \/Helvetica/, 'keine Standardschriften in PDF/A');
  assert.match(roh, /\/GTS_PDFA1/);
  const zpr = (await call('GET', `${T}/zugferd/${jahr}_5001/pruefung`)).body;
  assert.equal(zpr.ok, true, JSON.stringify(zpr.punkte.filter((x: any) => !x.ok)));
  const cii = (await call('GET', `${T}/zugferd/${jahr}_5001/datei`));
  assert.equal(cii.status, 200);
  assert.match(cii.text, /<rsm:CrossIndustryInvoice/);
  assert.match(cii.text, /<ram:ID>urn:cen.eu:en16931:2017<\/ram:ID>/);
  assert.match(cii.text, /<ram:BasisAmount>710.00<\/ram:BasisAmount>/);
  assert.match(cii.text, /<ram:DuePayableAmount>1344.90<\/ram:DuePayableAmount>/);
  assert.match(cii.text, /<ram:TaxTotalAmount currencyID="EUR">134.90<\/ram:TaxTotalAmount>/);
  assert.equal((cii.text.match(/<ram:IncludedSupplyChainTradeLineItem>/g) ?? []).length, 2);
  // Reihenfolge laut CII-Schema: PaymentMeans vor ApplicableTradeTax vor PaymentTerms vor MonetarySummation
  const reihe = ['SpecifiedTradeSettlementPaymentMeans', 'ApplicableTradeTax', 'SpecifiedTradePaymentTerms', 'SpecifiedTradeSettlementHeaderMonetarySummation']
    .map((t) => cii.text.lastIndexOf(`<ram:${t}>`));
  assert.ok(reihe.every((x: number, i: number) => x >= 0 && (i === 0 || x > reihe[i - 1])), 'Elementreihenfolge CII');
  // ---- Ohne MwSt: Grund wählbar (#121) – Drittland-Transport statt Ableitung aus dem Land ----
  const f3 = await call('POST', `${T}/auftraege`, { ...neuF, kunde: 794, unternehmer: 793, steuerbefreiung: 'DRITTLAND' });
  assert.equal(f3.status, 200, JSON.stringify(f3.body));
  assert.equal((await call('GET', `${T}/auftraege/${f3.body.auftragsnr}`)).body.steuerbefreiung, 'DRITTLAND');
  const er3 = await call('POST', `${T}/rechnungen`, { auftraege: [f3.body.auftragsnr], sammel: false });
  assert.equal(er3.status, 200, JSON.stringify(er3.body));
  const xr3 = (await call('GET', `${T}/xrechnung/${er3.body.fakturen[0]}`)).body;
  assert.match(xr3.xml, /<cbc:ID>E<\/cbc:ID>/);
  assert.match(xr3.xml, /Umsatzsteuerfreier Transport in ein Drittland gem\. § 4 Nr\. 3 Buchst\. a Unterbuchstabe aa UStG/);
  assert.doesNotMatch(xr3.xml, /VATEX-EU-AE/);
  assert.equal((await call('GET', `${T}/pdf/R/${er3.body.fakturen[0]}`)).status, 200);
  // mit MwSt wird der Grund verworfen
  const f4 = await call('POST', `${T}/auftraege`, { ...neuF, steuerrelevant: true, kunde: 794, unternehmer: 793, steuerbefreiung: 'RC' });
  assert.equal((await call('GET', `${T}/auftraege/${f4.body.auftragsnr}`)).body.steuerbefreiung, null);

  // Lieferschein/Transportauftrag bleiben normale PDFs
  assert.doesNotMatch(((await call('GET', `${T}/pdf/L/2025_0041`)).body as Buffer).toString('latin1'), /factur-x/);

  // ---- Mails ----
  const mails = (await call('POST', `${T}/mails`, { art: 'R', auftraege: ['2025_0041', h.body.auftragsnr] })).body;
  assert.equal(mails.length, 2);
  assert.match(mails[0].mailto, /^mailto:einkauf@mueller.de\?subject=Rechnung%202025_5012/);
  assert.match(decodeURIComponent(mails[0].mailto), /Sehr geehrter Herr Hans Müller/);
  // Entwurf mit Anhängen im Auftrag (#121): Empfänger und Text einzeln
  assert.equal(mails[0].an, 'einkauf@mueller.de');
  assert.match(mails[0].text, /Sehr geehrter Herr Hans Müller/);

  // ---- Kontakte: Dublettenprüfung ----
  const k1 = await call('POST', `${T}/adressen`, { kundenname: 'spedition schmitt', ort: 'Saarbrücken' });
  assert.equal(k1.status, 409);
  assert.equal(k1.body.code, 'DUBLETTE');
  const k2 = await call('POST', `${T}/adressen`, { kundenname: 'spedition schmitt', ort: 'Saarbrücken', force: true });
  assert.equal(k2.body.adrnr, 795);

  // ---- Wertelisten ----
  const w = await call('POST', `${T}/werte`, { typ: 'FAHRZEUGTYP', text: 'Planensattel' });
  assert.equal(w.body.key, '003');

  // ---- Änderungsbelege am Auftrag (inkl. Stops/Träger) ----
  const hist = (await call('GET', `/api/audit/object/AUFTRAG/${h.body.auftragsnr}`)).body;
  assert.ok(hist.some((d: { tableName: string }) => d.tableName === 'transport.traeger'));
  assert.ok(hist.some((d: { action: string }) => d.action === 'SAMMELRECHNUNG'));
});

test('Dokumente zum Auftrag: ohne Paperless Hinweis statt Fehler beim Lesen', async () => {
  let r = await call('GET', `${T}/auftraege/2025_0041/dokumente`);
  assert.equal(r.status, 200);
  assert.equal(r.body.paperless, false);
  assert.deepEqual(r.body.dokumente, []);
  r = await call('POST', `${T}/auftraege/2025_0041/dokumente`, { datei: 'lieferschein.jpg', inhalt: `data:image/jpeg;base64,${b64('x')}` });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Paperless ist nicht eingerichtet/);
  r = await call('GET', `${T}/auftraege/2025_0041/dokumente/5/datei`);
  assert.equal(r.status, 404);
});

test('Kontakte: Liste mit Rollen, Detail mit Aufträgen, Löschen nur ohne Aufträge', async () => {
  let r = await call('GET', `${T}/kontakte/liste`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k792 = r.body.zeilen.find((z: any) => z.adrnr === 792);
  assert.ok(k792.rollen.includes('Kunde'));
  assert.ok(k792.auftraege >= 1);
  assert.ok(r.body.anzahl.ALLE >= r.body.anzahl.KUNDEN);
  r = await call('GET', `${T}/kontakte/liste?filter=UNTERNEHMER`);
  assert.ok(r.body.zeilen.every((z: any) => z.rollen.includes('Unternehmer')));
  r = await call('GET', `${T}/kontakte/792`);
  assert.equal(r.status, 200);
  assert.ok(r.body.auftraege.length >= 1);
  assert.ok(r.body.auftraege.every((a: any) => a.rollen.length > 0));
  assert.equal(typeof r.body.kennzahlen.umsatzGesamt, 'number');
  // Löschen: mit Aufträgen gesperrt, ohne möglich
  r = await call('DELETE', `${T}/kontakte/792`);
  assert.equal(r.status, 400);
  const neu = await call('POST', `${T}/adressen`, { kundenname: 'Löschtest GmbH', land: 'DE', ort: 'Nirgendwo', force: true });
  assert.equal(neu.status, 200, JSON.stringify(neu.body));
  r = await call('DELETE', `${T}/kontakte/${neu.body.adrnr}`);
  assert.equal(r.status, 200);
  r = await call('GET', `${T}/kontakte/${neu.body.adrnr}/dokumente`);
  assert.equal(r.body.paperless, false);
});

test('Import Neuaufbau (#121): Tabellen leeren, neu anlegen, Nummernkreise aus ZEU_RGNRKREIS', async () => {
  const adr = 'ADRNR;KUNDENNAME;KUNDENNAME2;ANREDE;NAME;VORNAME;STRASSE;HAUSNUMMER;LAND;PLZ;ORT;TELEFON;FAX;EMAIL;GLN;MARKT\r\n' +
    '0000000002;EUROTRANS GMBH;;Herr;Holthaus;Luca;;;DE;33;Rietberg;;;lh@example.de;;\r\n' +
    '0000000003;BLG;;Herr;Finke;Patrick;;;DE;28197;Bremen;;;pf@example.de;;\r\n';
  const auf = 'RGNR_TXT;RGANLAGDAT;KUNDE;UNTERNEHMER;RE;RGBETRAG;KENNZEICHEN;ART;FRACHTPREIS_EK;FRACHTPREIS_VK;LADENUMMER;LADEGUT;GEWICHT;LADEWEISE;PALETTENTAUSCH;ORDERNUMMER;DATUMLADEN1;DATUMENTLADEN1;BESONDERHEITEN;FAKTURA;FAKTURADATUM;STEUERRELEVANT;DOK_FEHLEN;LEISTUNGSDATUM;LADEMETER\r\n' +
    '2025_0041;20251103;0000000002;0000000003;0000000000;119.0000 ;SB-OR1412;001;42.0000 ;100.0000 ;;002;18;001;099;OR1;00000000;00000000;;2025_6288;20251110;X;;00000000;13.6\r\n' +
    '2026_0007;00000000;0000000003;0000000002;0000000000;0.0000 ;;001;0.0000 ;0.0000 ;;;;;;;00000000;00000000;;;00000000;;;00000000;0.0\r\n';
  const pos = 'MANDT;RGNR_TXT;POS;FIRMA;STRASSE;PLZORT;LAND;LADENUMMER;DATUM;ZEIT;FIRMA_E;STRASSE_E;PLZORT_E;LAND_E;DATUM_E;ZEIT_E\r\n' +
    '001;;;Ohne Auftrag;;;;;20231125;;;;;;00000000;\r\n' +
    '001;2025_0041;1;Brauerei;;66386 St. Ingbert;DE;;20251104;;Markt;;66606 St. Wendel;DE;20251105;\r\n' +
    '001;2026_0007;1;;;;;;00000000;;;;;;00000000;\r\n';
  const trg = 'RGNR_TXT;RGNR_POS;PRODUKT;MENGE;PREIS;PROD_TXT\r\n2026_0007;01;901;20;4.40 ;\r\n2026_0007;02;902;;7.50 ;\r\n';
  const nrk = 'CLIENT;GJAHR;TYP;NUMMER\r\n001;2025;A;1369\r\n001;2025;R;6288\r\n001;2026;A;1314\r\n001;2026;R;6194\r\n001;2023;X;0073\r\n';
  const dossier = 'CLIENT;RGNR_TXT;RGNR_POS;KUNDE;UNTERNEHMER;RGBETRAG;KENNZEICHEN;ART;FRACHTPREIS_EK;FRACHTPREIS_VK;LADENUMMER;GEWICHT;LADEWEISE;PALETTENTAUSCH;ORDERNUMMER;DATUMLADEN1;DATUMENTLADEN1\r\n';
  const cust = 'APPL;BENUTZER;DRUCKPFAD\r\nZEU1;;C:\\Users\\Downloads\r\n';
  const alv = 'REPID;SCREEN;ALV_NAME;FIELDNAME;COLTEXT\r\nZEU_AUFTRAGSVERWALTUNG;2000;GRID2;KUNDE;Kunde\r\n';
  const ladegut = 'IDENT;LADEGUT\r\n';
  const dateien = [
    { name: 'Adressen.csv', data: b64(adr, 'latin1') },
    { name: 'Auftr_ge.csv', data: b64(auf, 'latin1') },
    { name: 'Auftr_ge_POs.csv', data: b64(pos, 'latin1') },
    { name: 'ZEU_TRAEGER.csv', data: b64(trg, 'latin1') },
    { name: 'ZEU_RGNRKREIS.csv', data: b64(nrk) },
    { name: 'ZEU_DOSSIER.csv', data: b64(dossier) },
    { name: 'ZGN_CUST.csv', data: b64(cust) },
    { name: 'ZGN_ALV_FIELDS.csv', data: b64(alv) },
    { name: 'ZEU_LADEGUT_T.csv', data: b64(ladegut) },
  ];
  // Dokumentverknüpfung zu einem Auftrag, der in der Datei wieder vorkommt, und zu einem, der wegfällt
  const vorher = (await sql`select auftragsnr from transport.auftraege where auftragsnr <> '2025_0041' limit 1`)[0].auftragsnr as string;
  await sql`insert into transport.auftrag_dokumente (auftragsnr, doc_id, titel) values ('2025_0041', 77, 'CMR'), (${vorher}, 78, 'weg')`;

  // ZEU_DOSSIER darf die Aufträge nicht verdrängen (gleiche Felder RGNR_TXT/KUNDE)
  let r = await call('POST', `${T}/import/pruefen`, { dateien, modus: 'ersetzen' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const st = Object.fromEntries(r.body.filter((s: any) => s.key !== 'IGN').map((s: any) => [s.key, s]));
  assert.equal(st.AUF.anzahl, 2);
  assert.match(st.AUF.hinweis, /vorher geleert/);
  assert.match(st.AUF.hinweis, /gehen verloren/);
  assert.match(st.POS.hinweis, /1 Zeile\(n\) ohne Schlüssel/);
  assert.equal(st.NRK.anzahl, 4);
  assert.match(st.NRK.hinweis, /Typ X wird ignoriert/);
  const ign = r.body.filter((s: any) => s.key === 'IGN');
  assert.deepEqual(ign.map((s: any) => s.tabelle).sort(), ['ZEU_DOSSIER', 'ZEU_LADEGUT_T', 'ZGN_ALV_FIELDS', 'ZGN_CUST']);
  assert.ok(ign.every((s: any) => s.status === 'nicht benötigt'));

  // ohne Begründung bzw. ohne Pflichtdatei kein Neuaufbau
  r = await call('POST', `${T}/import/ausfuehren`, { dateien, modus: 'ersetzen' });
  assert.equal(r.status, 400);
  r = await call('POST', `${T}/import/ausfuehren`, { dateien: dateien.filter((d) => d.name !== 'ZEU_TRAEGER.csv'), modus: 'ersetzen', reason: 'Test' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Träger\.csv/);

  r = await call('POST', `${T}/import/ausfuehren`, { dateien, modus: 'ersetzen', reason: 'Neuaufbau aus SAP' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Neuaufbau: Aufträge, Stops, Adressen, Holzträger wurden geleert/);
  assert.match(r.body.text, /Neu angelegt: 2 Aufträge, 2 Stops, 2 Adressen, 2 Trägerpositionen/);
  assert.match(r.body.text, /1 Dokumentverknüpfung\(en\) zu Aufträgen übernommen/);
  assert.match(r.body.text, /1 Dokumentverknüpfung\(en\) entfallen/);

  assert.deepEqual((await sql`select auftragsnr from transport.auftraege order by 1`).map((x) => x.auftragsnr), ['2025_0041', '2026_0007']);
  assert.equal((await sql`select count(*)::int as n from transport.adressen`)[0].n, 2);
  assert.deepEqual((await sql`select doc_id from transport.auftrag_dokumente`).map((x) => x.doc_id), [77]);
  const a = (await call('GET', `${T}/auftraege/2026_0007`)).body;
  assert.equal(a.anlagedatum, '2026-01-01');
  assert.equal(a.traeger.length, 2);
  // Nummernkreise genau auf SAP-Stand – auch wenn der Portalstand höher war
  const nr = Object.fromEntries((await sql`select id, year, last_value from core.number_ranges where id like 'TRANSPORT_%'`)
    .map((x) => [`${x.id}|${x.year}`, Number(x.last_value)]));
  assert.equal(nr['TRANSPORT_AUFTRAG|2025'], 1369);
  assert.equal(nr['TRANSPORT_RECHNUNG|2025'], 6288);
  assert.equal(nr['TRANSPORT_AUFTRAG|2026'], 1314);
  assert.equal(nr['TRANSPORT_RECHNUNG|2026'], 6194);

  // normaler Import danach: nichts doppelt, Nummernkreise nur hoch
  r = await call('POST', `${T}/import/ausfuehren`, { dateien });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /Neu angelegt: 0 Aufträge/);
  assert.doesNotMatch(r.body.text, /Nummernkreise/);
});

test('Wertelisten: mehrere Werte per Copy & Paste anlegen (#121)', async () => {
  const vorher = (await call('GET', `${T}/werte`)).body.LADEWEISE as { key: string; text: string }[];
  const vorhanden = vorher[0]?.text ?? 'Palette';
  let r = await call('POST', `${T}/werte/masse`, {
    typ: 'LADEWEISE',
    zeilen: [{ text: 'Seitenladung' }, { key: '050', text: 'Hecklader' }, { text: vorhanden.toUpperCase() }, { text: 'Kran' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.neu, vorher.some((w) => w.text.toLowerCase() === vorhanden.toLowerCase()) ? 3 : 4);
  const nachher = (await call('GET', `${T}/werte`)).body.LADEWEISE as { key: string; text: string }[];
  assert.equal(nachher.find((w) => w.text === 'Hecklader')?.key, '050');
  assert.equal(nachher.find((w) => w.text === 'Kran')?.key, '051', 'fortlaufend nach dem höchsten Schlüssel');
  // zweites Einfügen: alles schon da
  r = await call('POST', `${T}/werte/masse`, { typ: 'LADEWEISE', zeilen: [{ text: 'kran' }, { key: '050', text: 'Anders' }] });
  assert.deepEqual(r.body, { neu: 0, uebersprungen: 2 });
  r = await call('POST', `${T}/werte/masse`, { typ: 'LADEWEISE', zeilen: [{ text: 'x'.repeat(61) }] });
  assert.equal(r.status, 400);
});

test('Fakturierte Aufträge: nur „Dokumente fehlen“ und Besonderheiten änderbar (#121)', async () => {
  const a = (await call('GET', `${T}/auftraege/2025_0041`)).body;
  assert.ok(a.faktura, 'Auftrag ist fakturiert');
  const r = await call('PUT', `${T}/auftraege/2025_0041`, {
    ...a, kennzeichen: 'GEÄNDERT', frachtpreis_ek: 999, dok_fehlen: !a.dok_fehlen, besonderheiten: 'CMR fehlt noch',
    stops: a.stops.map((s: any) => ({ ...s, firma: 'Andere Firma' })),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = (await call('GET', `${T}/auftraege/2025_0041`)).body;
  assert.equal(b.kennzeichen, a.kennzeichen);
  assert.equal(b.frachtpreis_ek, a.frachtpreis_ek);
  assert.equal(b.rgbetrag, a.rgbetrag);
  assert.equal(b.stops[0].firma, a.stops[0].firma);
  assert.equal(b.dok_fehlen, !a.dok_fehlen);
  assert.equal(b.besonderheiten, 'CMR fehlt noch');

  // offener Auftrag bleibt voll änderbar
  const o = (await call('GET', `${T}/auftraege/2026_0007`)).body;
  assert.ok(!o.faktura);
  assert.equal((await call('PUT', `${T}/auftraege/2026_0007`, { ...o, kennzeichen: 'SB-NEU 1' })).status, 200);
  assert.equal((await call('GET', `${T}/auftraege/2026_0007`)).body.kennzeichen, 'SB-NEU 1');
});
