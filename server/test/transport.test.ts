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
  // Auftragsbedingungen (#170): vorbelegt, bleiben ohne Feld erhalten, lassen sich ändern
  let fi = (await call('GET', `${T}/firma`)).body;
  assert.match(fi.auftragsbedingungen, /mindestens 18 geeignete Gurte/);
  assert.match(fi.auftragsbedingungen, /Mindestlohngesetzes \(MiLoG\)/);
  const agb = fi.auftragsbedingungen;
  assert.equal((await call('PUT', `${T}/firma`, { ...fi, auftragsbedingungen: 'Absatz 1\r\n\r\nAbsatz 2  ' })).status, 200);
  assert.equal((await call('GET', `${T}/firma`)).body.auftragsbedingungen, 'Absatz 1\n\nAbsatz 2');
  assert.equal((await call('PUT', `${T}/firma`, { ...fi, auftragsbedingungen: agb })).status, 200);
  fi = (await call('GET', `${T}/firma`)).body;
  assert.equal(fi.auftragsbedingungen, agb);

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
  // alle Aufträge der Sammelrechnung – die Oberfläche speichert das PDF in den Ablageordner jedes dieser Aufträge
  assert.equal(xr.auftraege.length, 2);
  assert.deepEqual(xr.auftraege, [...xr.auftraege].sort());
  assert.deepEqual((await sql`select auftragsnr from transport.auftraege where faktura = ${`${jahr}_5001`} order by 1`).map((r) => r.auftragsnr), xr.auftraege);
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
  // nach der Faktura korrigierbar: Reverse Charge statt Drittland (nur Text/Kategorie, Beträge bleiben)
  const a3 = (await call('GET', `${T}/auftraege/${f3.body.auftragsnr}`)).body;
  const pu = await call('PUT', `${T}/auftraege/${f3.body.auftragsnr}`, { ...a3, typ: 'F', steuerbefreiung: 'RC', frachtpreis_ek: 999 });
  assert.equal(pu.status, 200, JSON.stringify(pu.body));
  const a3n = (await call('GET', `${T}/auftraege/${f3.body.auftragsnr}`)).body;
  assert.deepEqual([a3n.steuerbefreiung, a3n.frachtpreis_ek], ['RC', a3.frachtpreis_ek], 'Grund geändert, Preis gesperrt');
  const xr3b = (await call('GET', `${T}/xrechnung/${er3.body.fakturen[0]}`)).body;
  assert.match(xr3b.xml, /VATEX-EU-AE/);
  assert.match(xr3b.xml, /Übergang der Steuerschuld auf den Leistungsempfänger \(Reverse Charge\)/);
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

  // ---- Rechnung entfernen (#170): ganze Rechnung, bei Sammelrechnung alle Aufträge; Nummer wird nicht neu vergeben ----
  let re = await call('POST', `${T}/rechnungen/entfernen`, { auftraege: [h.body.auftragsnr], pruefen: true });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.deepEqual(re.body, { rechnungen: [{ faktura: `${jahr}_5001`, auftraege: [h.body.auftragsnr, f2.body.auftragsnr].sort() }], zusaetzlich: [f2.body.auftragsnr] });
  assert.equal((await call('POST', `${T}/rechnungen/entfernen`, { auftraege: [h.body.auftragsnr] })).status, 400, 'ohne Grund');
  assert.equal((await call('POST', `${T}/rechnungen/entfernen`, { auftraege: ['2099_0001'], grund: 'x' })).status, 400, 'nichts fakturiert');
  re = await call('POST', `${T}/rechnungen/entfernen`, { auftraege: [h.body.auftragsnr, '2025_0042'], grund: 'Testrechnungen' });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.deepEqual(re.body.rechnungen.map((x: any) => x.faktura), [`${jahr}_5001`, `${jahr}_5002`]);
  const offenJetzt = await sql`select auftragsnr, faktura, fakturadatum from transport.auftraege where auftragsnr = any(${[h.body.auftragsnr, f2.body.auftragsnr, '2025_0042']})`;
  assert.ok(offenJetzt.every((r) => r.faktura === null && r.fakturadatum === null), JSON.stringify(offenJetzt));
  const hist2 = (await call('GET', `/api/audit/object/AUFTRAG/${h.body.auftragsnr}`)).body;
  assert.ok(hist2.some((d: { action: string; reason?: string }) => d.action === 'RECHNUNG_ENTFERNT'), JSON.stringify(hist2.map((d: any) => d.action)));
  const neuR = await call('POST', `${T}/rechnungen`, { auftraege: ['2025_0042'], sammel: false });
  assert.equal(neuR.status, 200, JSON.stringify(neuR.body));
  assert.notDeepEqual(neuR.body.fakturen, [`${jahr}_5002`], 'Nummer wird nicht neu vergeben');
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

test('Kontakte: eigenes Recht für die App (#232, N7) – lesen darf, wer Kontakte oder Aufträge sieht', async () => {
  const anmelden = async (rolle: string, rechte: string[]) => {
    assert.equal((await call('POST', '/api/admin/roles', { id: rolle, name: rolle, permissions: rechte })).status, 200);
    assert.equal((await call('POST', '/api/admin/users', { username: rolle.toLowerCase(), displayName: rolle, password: 'start-passwort', roles: [rolle] })).status, 200);
    let cookie = '';
    const als = async (method: string, path: string, payload?: unknown) => {
      const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie, 'x-portal-request': '1' } });
      const set = res.headers['set-cookie'];
      if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
      return res.statusCode;
    };
    assert.equal(await als('POST', '/api/auth/login', { username: rolle.toLowerCase(), password: 'start-passwort' }), 200);
    assert.equal(await als('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort-1' }), 200);
    return als;
  };
  // nur Kontakte: die App lässt sich lesen, Aufträge nicht, ändern auch nicht
  const kontakte = await anmelden('NURKONTAKTE', ['transport.kontakte:display']);
  assert.equal(await kontakte('GET', `${T}/kontakte/liste`), 200);
  assert.equal(await kontakte('GET', `${T}/auftraege`), 403);
  assert.equal(await kontakte('POST', `${T}/adressen`, {}), 403);
  // nur Aufträge: Kontakte bleiben lesbar (Auswahl im Auftrag) – wie bisher
  const auftraege = await anmelden('NURAUFTRAEGE', ['transport.auftraege:display']);
  assert.equal(await auftraege('GET', `${T}/kontakte/liste`), 200);
  // ohne beides: kein Zugriff
  const nichts = await anmelden('NURSTAMM', ['transport.stammdaten:edit']);
  assert.equal(await nichts('GET', `${T}/kontakte/liste`), 403);
  // Rollenpflege: App „Kontakte“ mit beiden Rechten, „Produkte und Wertelisten“ statt „Stammdaten“
  const { permissionCatalog } = await import('../src/modules.js');
  const katalog = permissionCatalog();
  const apps = katalog.find((g) => g.module === 'transport')!.areas.flatMap((a) => a.apps);
  assert.deepEqual(apps.map((a) => a.name), ['Aufträge', 'Posteingang', 'Kontakte', 'Produkte und Wertelisten']);
  assert.deepEqual(apps.find((a) => a.name === 'Kontakte')!.permissions.map((p) => p.id), ['transport.kontakte:display', 'transport.kontakte:edit']);
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

test('Mehrere Fahrten in einem Auftrag: speichern, Transportauftrag und E-Mail je Fahrt, zusammenführen, ohne Rechnung abschließen', async () => {
  const adr = async (kundenname: string, email: string) => {
    const r = await call('POST', `${T}/adressen`, { kundenname, land: 'DE', plz: '66839', ort: 'Schmelz', email, force: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.adrnr as number;
  };
  const kunde = await adr('Fahrtentest Kunde GmbH', 'kunde@fahrtentest.example');
  const u1 = await adr('Fahrtentest Unternehmer Eins', 'eins@fahrtentest.example');
  const u2 = await adr('Fahrtentest Unternehmer Zwei', 'zwei@fahrtentest.example');
  const neuF = (await call('GET', `${T}/neu/F`)).body;
  assert.deepEqual(neuF.fahrten, []);
  neuF.stops[0] = { ...neuF.stops[0], firma: 'Fahrtentest Werk', plzort: '66839 Limbach', land: 'DE', firma_e: 'laut LFS', plzort_e: '85354 Freising', land_e: 'DE', datum: '2026-10-30' };
  const anlegen = async (x: Record<string, unknown>) => {
    const r = await call('POST', `${T}/auftraege`, { ...neuF, kunde, ...x });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.auftragsnr as string;
  };

  // ---- ein Auftrag mit zwei Fahrten ----
  const nr = await anlegen({
    unternehmer: u1, kennzeichen: 'FT-EINS 1', frachtpreis_ek: 400, frachtpreis_vk: 250,
    fahrten: [
      { unternehmer: null, kennzeichen: '', fahrzeugtyp: null, frachtpreis_vk: 0, ladedatum: null }, // leere Zeile entfällt
      { unternehmer: u2, kennzeichen: 'FT-ZWEI 2', fahrzeugtyp: '001', frachtpreis_vk: 275.5, ladedatum: '2026-10-31' },
    ],
  });
  let a = (await call('GET', `${T}/auftraege/${nr}`)).body;
  assert.equal(a.fahrten.length, 1);
  assert.deepEqual([a.fahrten[0].pos, a.fahrten[0].unternehmer, a.fahrten[0].kennzeichen, a.fahrten[0].frachtpreis_vk, a.fahrten[0].ladedatum],
    [2, u2, 'FT-ZWEI 2', 275.5, '2026-10-31']);
  assert.equal(a.fahrten[0].unternehmerAdr.kundenname, 'Fahrtentest Unternehmer Zwei');
  assert.equal(a.rgbetrag, 476, 'Rechnungsbetrag kommt weiter allein aus dem Frachtpreis EK (400 × 1,19)');
  let zeile = (await call('GET', `${T}/auftraege?jahr=ALL&fakt=ALL`)).body.find((r: any) => r.auftragsnr === nr);
  assert.equal(zeile.unternehmer, '2 Unternehmer');
  assert.match(zeile.unternehmerNamen, /Eins.*Zwei/);
  assert.equal(zeile.fahrten, 2);
  assert.equal(zeile.vk, 525.5);
  // Transportauftrag je Fahrt; eine Fahrt, die es nicht gibt, ist ein Fehler
  for (const id of [nr, `${nr}-1`, `${nr}-2`]) {
    const p = await call('GET', `${T}/pdf/T/${id}`);
    assert.equal(p.status, 200, id);
    assert.match(p.ct, /pdf/);
  }
  assert.equal((await call('GET', `${T}/pdf/T/${nr}-3`)).status, 404);
  // E-Mail: je Fahrt eine an deren Unternehmer, mit der Nummer der Fahrt
  let mails = (await call('POST', `${T}/mails`, { art: 'T', auftraege: [nr] })).body;
  assert.deepEqual(mails.map((m: any) => [m.auftragsnr, m.auftrag, m.an, m.betreff]), [
    [`${nr}-1`, nr, 'eins@fahrtentest.example', `Transportauftrag ${nr}-1`],
    [`${nr}-2`, nr, 'zwei@fahrtentest.example', `Transportauftrag ${nr}-2`],
  ]);
  mails = (await call('POST', `${T}/mails`, { art: 'T', auftraege: [`${nr}-2`] })).body;
  assert.equal(mails.length, 1);
  assert.equal(mails[0].an, 'zwei@fahrtentest.example');
  // Kontakte: der Unternehmer der zweiten Fahrt sieht den Auftrag und lässt sich nicht löschen
  const kd = (await call('GET', `${T}/kontakte/${u2}`)).body;
  assert.ok(kd.auftraege.some((x: any) => x.auftragsnr === nr && x.rollen.includes('Unternehmer')));
  assert.equal((await call('DELETE', `${T}/kontakte/${u2}`)).status, 400);
  // Ändern ohne das Feld „fahrten“ lässt die Fahrten stehen, mit leerer Liste entfallen sie
  const { fahrten: _f, ...ohne } = a;
  assert.equal((await call('PUT', `${T}/auftraege/${nr}`, { ...ohne, kennzeichen: 'FT-EINS 9' })).status, 200);
  assert.equal((await call('GET', `${T}/auftraege/${nr}`)).body.fahrten.length, 1);
  assert.equal((await call('PUT', `${T}/auftraege/${nr}`, { ...ohne, fahrten: [] })).status, 200);
  a = (await call('GET', `${T}/auftraege/${nr}`)).body;
  assert.deepEqual(a.fahrten, []);
  assert.equal((await call('POST', `${T}/mails`, { art: 'T', auftraege: [nr] })).body[0].auftragsnr, nr, 'eine Fahrt: Nummer ohne Endung');

  // ---- zusammenführen: zwei einzelne Aufträge desselben Transports ----
  const q = await anlegen({ unternehmer: u2, kennzeichen: 'FT-ZWEI 2', frachtpreis_ek: 300, frachtpreis_vk: 275.5, besonderheiten: 'Rampe 4' });
  const fremd = await anlegen({ kunde: u1, unternehmer: u2 });
  let z = await call('POST', `${T}/auftraege/zusammenfuehren`, { auftraege: [nr, fremd], pruefen: true });
  assert.equal(z.status, 200, JSON.stringify(z.body));
  assert.match(z.body.fehler.join(' '), /anderen Kunden/);
  z = await call('POST', `${T}/auftraege/zusammenfuehren`, { auftraege: [nr, fremd] });
  assert.equal(z.status, 400);
  z = await call('POST', `${T}/auftraege/zusammenfuehren`, { auftraege: [q, nr], pruefen: true });
  assert.deepEqual([z.body.ziel, z.body.quellen, z.body.fehler, z.body.fahrten], [nr, [q], [], 2]);
  assert.equal((await call('GET', `${T}/auftraege/${q}`)).status, 200, 'Prüfen ändert nichts');
  z = await call('POST', `${T}/auftraege/zusammenfuehren`, { auftraege: [q, nr] });
  assert.equal(z.status, 200, JSON.stringify(z.body));
  assert.deepEqual([z.body.ziel, z.body.quellen, z.body.fahrten], [nr, [q], 2]);
  assert.equal((await call('GET', `${T}/auftraege/${q}`)).status, 404, 'die Quelle ist kein eigener Auftrag mehr');
  a = (await call('GET', `${T}/auftraege/${nr}`)).body;
  assert.deepEqual([a.fahrten.length, a.fahrten[0].pos, a.fahrten[0].unternehmer, a.fahrten[0].frachtpreis_vk, a.fahrten[0].ladedatum], [1, 2, u2, 275.5, '2026-10-30']);
  assert.equal(a.frachtpreis_ek, 700);
  assert.equal(a.rgbetrag, 833);
  assert.equal(a.besonderheiten, 'Rampe 4');

  // ---- ohne Rechnung abschließen und wieder öffnen ----
  assert.equal((await call('POST', `${T}/auftraege/abschliessen`, { auftraege: [fremd], grund: '' })).status, 400);
  let ab = await call('POST', `${T}/auftraege/abschliessen`, { auftraege: [fremd, '2025_0041'], grund: 'Leerfahrt, nichts zu berechnen' });
  assert.equal(ab.status, 200, JSON.stringify(ab.body));
  assert.deepEqual(ab.body, { abgeschlossen: [fremd], ignoriert: 1 });
  zeile = (await call('GET', `${T}/auftraege?jahr=ALL&fakt=ALL`)).body.find((r: any) => r.auftragsnr === fremd);
  assert.equal(zeile.status, 'Ohne Rechnung');
  assert.equal(zeile.abgeschlossenGrund, 'Leerfahrt, nichts zu berechnen');
  const det = (await call('GET', `${T}/auftraege/${fremd}`)).body;
  assert.ok(det.abgeschlossen_am);
  // keine Rechnung, kein Zusammenführen, solange abgeschlossen
  const re = await call('POST', `${T}/rechnungen`, { auftraege: [fremd], sammel: false });
  assert.equal(re.status, 400);
  assert.match(re.body.message, /Keine offenen Aufträge/);
  assert.equal((await call('POST', `${T}/auftraege/abschliessen`, { auftraege: [fremd], grund: 'nochmal' })).status, 400);
  ab = await call('POST', `${T}/auftraege/oeffnen`, { auftraege: [fremd] });
  assert.deepEqual(ab.body, { geoeffnet: [fremd] });
  assert.equal((await call('GET', `${T}/auftraege?jahr=ALL&fakt=ALL`)).body.find((r: any) => r.auftragsnr === fremd).status, 'Offen');
  assert.equal((await call('POST', `${T}/auftraege/oeffnen`, { auftraege: [fremd] })).status, 400);
});

test('Auftragsliste: Lade-/Entladezeiten in der Route und Abrechnungsstatus mit Zahlungseingang', async () => {
  const r0 = await call('POST', `${T}/adressen`, { kundenname: 'Zahltest Kunde KG', land: 'DE', plz: '66625', ort: 'Nohfelden', email: 'kunde@zahltest.example', force: true });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const kunde = r0.body.adrnr as number;
  const neu = (await call('GET', `${T}/neu/F`)).body;
  neu.stops[0] = { ...neu.stops[0], firma: 'Zahltest Werk', plzort: '66625 Nohfelden', land: 'DE', datum: '2026-11-18', zeit: '07:00-08:30',
    firma_e: 'Zahltest Lager', plzort_e: '68159 Mannheim', land_e: 'DE', datum_e: '2026-11-18', zeit_e: '12:30' };
  const anlegen = async () => {
    const r = await call('POST', `${T}/auftraege`, { ...neu, kunde, unternehmer: kunde, kennzeichen: 'ZT-1', frachtpreis_ek: 100, frachtpreis_vk: 80 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.auftragsnr as string;
  };
  const [a1, a2, a3] = [await anlegen(), await anlegen(), await anlegen()];
  const zeile = async (nr: string) => (await call('GET', `${T}/auftraege?jahr=ALL&fakt=ALL`)).body.find((r: any) => r.auftragsnr === nr);

  // Admin: Termine und Status „angelegt“
  let z = await zeile(a1);
  assert.deepEqual([z.laden, z.entladen], [{ datum: '2026-11-18', zeit: '07:00-08:30' }, { datum: '2026-11-18', zeit: '12:30' }]);
  assert.equal(z.abrechnung.status, 'angelegt');

  // Rechnung: abgerechnet, fällig nach Zahlungsziel (14 Tage aus den Firmendaten)
  const re = await call('POST', `${T}/rechnungen`, { auftraege: [a1, a2], sammel: true });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  const faktura = re.body.fakturen[0] as string;
  z = await zeile(a1);
  assert.equal(z.abrechnung.status, 'abgerechnet');
  // überfällig erst mehr als 3 Tage nach Fälligkeit
  const ziel = Number((await call('GET', `${T}/firma`)).body.zahlungsziel_tage);
  await sql`update transport.auftraege set fakturadatum = current_date - ${ziel + 3}::int where faktura = ${faktura}`;
  assert.equal((await zeile(a1)).abrechnung.status, 'abgerechnet', 'genau 3 Tage nach Fälligkeit');
  await sql`update transport.auftraege set fakturadatum = current_date - ${ziel + 4}::int where faktura = ${faktura}`;
  z = await zeile(a1);
  assert.deepEqual([z.abrechnung.status, z.abrechnung.tageUeberfaellig], ['ueberfaellig', 4]);

  // Zahlungseingang: gilt für die ganze Sammelrechnung; nicht in der Zukunft, nicht vor dem Rechnungsdatum
  const morgen = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await call('POST', `${T}/zahlungen`, { auftraege: [a1], bezahltAm: morgen })).status, 400);
  assert.equal((await call('POST', `${T}/zahlungen`, { auftraege: [a1], bezahltAm: '2020-01-01' })).status, 400);
  assert.equal((await call('POST', `${T}/zahlungen`, { auftraege: [a3], bezahltAm: null })).status, 400, 'kein fakturierter Auftrag');
  const gestern = (await sql`select (current_date - 1)::text as d`)[0].d as string;
  let zp = await call('POST', `${T}/zahlungen`, { auftraege: [a1], bezahltAm: gestern });
  assert.equal(zp.status, 200, JSON.stringify(zp.body));
  assert.deepEqual(zp.body, { rechnungen: [faktura], auftraege: [a1, a2].sort() });
  z = await zeile(a2);
  assert.deepEqual([z.abrechnung.status, z.abrechnung.bezahltAm], ['bezahlt', gestern]);
  zp = await call('POST', `${T}/zahlungen`, { auftraege: [a2], bezahltAm: null });
  assert.equal(zp.status, 200);
  assert.equal((await zeile(a1)).abrechnung.status, 'ueberfaellig');
  // Rechnung entfernen löscht auch den Zahlungseingang
  await call('POST', `${T}/zahlungen`, { auftraege: [a1], bezahltAm: gestern });
  assert.equal((await call('POST', `${T}/rechnungen/entfernen`, { auftraege: [a1], grund: 'Zahltest' })).status, 200);
  assert.equal((await sql`select count(*)::int as n from transport.auftraege where bezahlt_am is not null and auftragsnr = any(${[a1, a2]})`)[0].n, 0);

  // ohne Rechnung abgeschlossen (früher 0 Euro) gilt als bezahlt
  assert.equal((await call('POST', `${T}/auftraege/abschliessen`, { auftraege: [a3], grund: 'Zahltest ohne Rechnung' })).status, 200);
  z = await zeile(a3);
  assert.deepEqual([z.abrechnung.status, z.abrechnung.ohneRechnung], ['bezahlt', true]);

  // Rechte: ohne transport.ladezeiten:display / transport.abrechnung:display keine Felder, ohne transport.zahlungen:edit keine Zahlung
  assert.equal((await call('POST', '/api/admin/roles', { id: 'ZAHLTEST', name: 'ZAHLTEST', permissions: ['transport.auftraege:display'] })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { username: 'zahltest', displayName: 'Zahltest', password: 'start-passwort', roles: ['ZAHLTEST'] })).status, 200);
  let c2 = '';
  const als = async (method: string, path: string, payload?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: path, payload: payload as object, headers: { cookie: c2, 'x-portal-request': '1' } });
    const set = res.headers['set-cookie'];
    if (set) c2 = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: String(res.headers['content-type'] ?? '').includes('json') ? JSON.parse(res.body) : null };
  };
  assert.equal((await als('POST', '/api/auth/login', { username: 'zahltest', password: 'start-passwort' })).status, 200);
  assert.equal((await als('POST', '/api/auth/password', { current: 'start-passwort', next: 'neues-passwort-1' })).status, 200);
  const ohne = (await als('GET', `${T}/auftraege?jahr=ALL&fakt=ALL`)).body.find((r: any) => r.auftragsnr === a3);
  assert.ok(ohne && !('laden' in ohne) && !('abrechnung' in ohne));
  assert.equal((await als('POST', `${T}/zahlungen`, { auftraege: [a1], bezahltAm: null })).status, 403);
  // Rechtekatalog: neue Rechte in der App „Aufträge“
  const { permissionCatalog } = await import('../src/modules.js');
  const ids = permissionCatalog().find((g) => g.module === 'transport')!.areas.flatMap((a) => a.apps).find((a) => a.name === 'Aufträge')!.permissions.map((p) => p.id);
  for (const p of ['transport.ladezeiten:display', 'transport.abrechnung:display', 'transport.zahlungen:edit']) assert.ok(ids.includes(p), p);
});

test('Tabellen anpassen: Recht im Katalog, Spalten/Filter/Sortierung in der Variante der Auftragsliste', async () => {
  const { permissionCatalog } = await import('../src/modules.js');
  const ids = permissionCatalog().find((g) => g.module === 'transport')!.areas.flatMap((a) => a.apps).find((a) => a.name === 'Aufträge')!.permissions.map((p) => p.id);
  assert.ok(ids.includes('transport.tabellen:edit'));
  const spalten = {
    liste: { aus: ['art', 'unternehmer'], filter: [{ id: 'kunde', value: 'Zahltest' }], sortierung: [{ id: 'auftragsnr', desc: true }] },
    baum: { aus: ['saldo'], filter: [], sortierung: [] },
  };
  const r = await call('POST', '/api/varianten/transport.auftraege', { name: 'Tabellentest', standard: false, global: false, ansicht: { status: 'ALL', spalten } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = (await call('GET', '/api/varianten/transport.auftraege')).body.varianten.find((x: any) => x.name === 'Tabellentest');
  assert.deepEqual(v.ansicht.spalten, spalten);
});

test('Stop-Vorschläge: bekannte Lade-/Entladestellen und Zeitvorgaben, „laut LFS“ zählt nicht', async () => {
  const r = await call('GET', `${T}/stops/vorschlaege`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const werk = r.body.orte.filter((o: any) => o.firma === 'Zahltest Werk');
  assert.equal(werk.length, 1, 'je Firma + Straße + Ort nur einmal');
  assert.equal(werk[0].plzort, '66625 Nohfelden');
  assert.ok(werk[0].anzahl >= 3);
  assert.ok(r.body.orte.some((o: any) => o.firma === 'Zahltest Lager' && o.plzort === '68159 Mannheim'));
  assert.ok(!r.body.orte.some((o: any) => String(o.firma).toLowerCase() === 'laut lfs'));
  assert.ok(r.body.zeiten.includes('07:00-08:30'));
});

test('Rechnung korrigieren: wieder öffnen, bearbeiten, mit derselben Nummer und demselben Datum neu erzeugen, Vermerk auf der Rechnung', async () => {
  const r0 = await call('POST', `${T}/adressen`, { kundenname: 'Korrekturtest Spedition GmbH', land: 'DE', plz: '66606', ort: 'St. Wendel', email: 'rechnung@korrekturtest.example', force: true });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const kunde = r0.body.adrnr as number;
  const neu = (await call('GET', `${T}/neu/F`)).body;
  neu.stops[0] = { ...neu.stops[0], firma: 'Korrekturtest Werk', plzort: '66606 St. Wendel', land: 'DE', firma_e: 'Korrekturtest Lager', plzort_e: '54290 Trier', land_e: 'DE' };
  const anlegen = async () => {
    const r = await call('POST', `${T}/auftraege`, { ...neu, kunde, unternehmer: kunde, kennzeichen: 'KT-1', frachtpreis_ek: 200, frachtpreis_vk: 150 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.auftragsnr as string;
  };
  const [k1, k2, k3] = [await anlegen(), await anlegen(), await anlegen()];
  const re = await call('POST', `${T}/rechnungen`, { auftraege: [k1, k2], sammel: true });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  const faktura = re.body.fakturen[0] as string;
  await sql`update transport.auftraege set fakturadatum = '2026-11-02' where faktura = ${faktura}`;
  const gestern = (await sql`select (current_date - 1)::text as d`)[0].d as string;
  assert.equal((await call('POST', `${T}/zahlungen`, { auftraege: [k1], bezahltAm: gestern })).status, 200);
  // fakturiert: nur eingeschränkt änderbar
  let a = (await call('GET', `${T}/auftraege/${k1}`)).body;
  assert.equal((await call('PUT', `${T}/auftraege/${k1}`, { ...a, frachtpreis_ek: 999 })).status, 200);
  assert.equal(Number((await call('GET', `${T}/auftraege/${k1}`)).body.frachtpreis_ek), 200);

  // prüfen: ganze Sammelrechnung; ohne Vermerk nicht; ohne Rechnung nicht
  let ko = await call('POST', `${T}/rechnungen/korrigieren`, { auftraege: [k1], pruefen: true });
  assert.deepEqual(ko.body, { rechnungen: [{ faktura, auftraege: [k1, k2].sort() }], zusaetzlich: [k2] });
  assert.equal((await call('POST', `${T}/rechnungen/korrigieren`, { auftraege: [k1] })).status, 400, 'ohne Vermerk');
  assert.equal((await call('POST', `${T}/rechnungen/korrigieren`, { auftraege: [k3], vermerk: 'x' })).status, 400, 'nicht fakturiert');
  ko = await call('POST', `${T}/rechnungen/korrigieren`, { auftraege: [k1], vermerk: 'Frachtpreis nach Absprache angepasst' });
  assert.equal(ko.status, 200, JSON.stringify(ko.body));
  a = (await call('GET', `${T}/auftraege/${k1}`)).body;
  assert.deepEqual([a.faktura, a.faktura_reserviert, a.fakturadatum_reserviert, a.rechnung_vermerk], [null, faktura, '2026-11-02', 'Frachtpreis nach Absprache angepasst']);
  const zeile = (await call('GET', `${T}/auftraege?jahr=ALL&fakt=ALL`)).body.find((r: any) => r.auftragsnr === k2);
  assert.deepEqual([zeile.status, zeile.fakturaReserviert], ['Offen', faktura]);
  // jetzt voll bearbeitbar; nicht ohne Rechnung abschließbar, nicht zusammenführbar
  assert.equal((await call('PUT', `${T}/auftraege/${k1}`, { ...a, frachtpreis_ek: 250 })).status, 200);
  assert.equal(Number((await call('GET', `${T}/auftraege/${k1}`)).body.frachtpreis_ek), 250);
  assert.equal((await call('POST', `${T}/auftraege/abschliessen`, { auftraege: [k1], grund: 'nein' })).status, 400);
  assert.equal((await call('POST', `${T}/auftraege/zusammenfuehren`, { auftraege: [k1, k3] })).status, 400);

  // neu erzeugen: Auswahl k1 + k3 als Einzelrechnungen → Sammelrechnung kommt vollständig mit derselben Nummer, k3 neue Nummer
  const nr = await call('POST', `${T}/rechnungen`, { auftraege: [k1, k3], sammel: false });
  assert.equal(nr.status, 200, JSON.stringify(nr.body));
  assert.equal(nr.body.fakturen[0], faktura);
  assert.equal(nr.body.fakturen.length, 2);
  assert.notEqual(nr.body.fakturen[1], faktura);
  assert.deepEqual(nr.body.korrigiert, [{ faktura, auftraege: [k1, k2].sort() }]);
  const rows = await sql`select auftragsnr, faktura, fakturadatum::text as d, faktura_reserviert, bezahlt_am is not null as bezahlt, rechnung_korrigiert_am is not null as korr
                           from transport.auftraege where auftragsnr = any(${[k1, k2]}) order by auftragsnr`;
  assert.ok(rows.every((r) => r.faktura === faktura && r.d === '2026-11-02' && !r.faktura_reserviert && r.bezahlt && r.korr), JSON.stringify(rows));
  // Vermerk in der E-Rechnung
  const xr = (await call('GET', `${T}/xrechnung/${faktura}`)).body;
  assert.match(xr.xml, /<cbc:Note>Korrigierte Rechnung vom \d{2}\.\d{2}\.\d{4}: Frachtpreis nach Absprache angepasst<\/cbc:Note>/);
  assert.equal((await call('GET', `${T}/pdf/R/${faktura}`)).status, 200);
  const hist = (await call('GET', `/api/audit/object/AUFTRAG/${k2}`)).body;
  assert.ok(hist.some((d: { action: string }) => d.action === 'RECHNUNG_ZUR_KORREKTUR_GEOEFFNET'), JSON.stringify(hist.map((d: any) => d.action)));

  // erneut öffnen und dann entfernen: vorgemerkte Nummer verfällt
  assert.equal((await call('POST', `${T}/rechnungen/korrigieren`, { auftraege: [k2], vermerk: 'doch storniert' })).status, 200);
  const ent = await call('POST', `${T}/rechnungen/entfernen`, { auftraege: [k2], grund: 'Korrektur verworfen' });
  assert.equal(ent.status, 200, JSON.stringify(ent.body));
  assert.deepEqual(ent.body.rechnungen, [{ faktura, auftraege: [k1, k2].sort() }]);
  const leer = await sql`select count(*)::int as n from transport.auftraege where auftragsnr = any(${[k1, k2]}) and (faktura is not null or faktura_reserviert is not null or rechnung_vermerk is not null)`;
  assert.equal(leer[0].n, 0);
});
