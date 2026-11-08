import { condense } from './format.js';
import { amt, el, esc, formatieren, rechnungsdaten, type Rechnungsdaten } from './xrechnung.js';

/**
 * ZUGFeRD 2.3 / Factur-X 1.0, Profil EN 16931: Rechnungsdaten als UN/CEFACT CII (CrossIndustryInvoice)
 * zum Einbetten in das Rechnungs-PDF (PDF/A-3b, Datei „factur-x.xml“, Beziehung „Alternative“).
 * Dieselben Daten wie die XRechnung (UBL) – nur die Syntax unterscheidet sich.
 */
export const FX_DATEI = 'factur-x.xml';
export const FX_PROFIL = 'EN 16931';
export const FX_GUIDELINE = 'urn:cen.eu:en16931:2017';

const datum102 = (iso: string) => `<udt:DateTimeString format="102">${iso.replace(/-/g, '')}</udt:DateTimeString>`;

export interface ZugferdXml { xml: string; hinweise: string[]; daten: Rechnungsdaten }

export function ciiXml(d: Rechnungsdaten): string {
  const { firma, buyer, buyerName, buyerKontakt, ustid, lines, tax, netto, steuer, brutto, ref, order, von, bis, hasO, fakturadatum, katSatz } = d;
  const E = 'currencyID="EUR"';
  const steuerXml = (kat: string, mitBetraegen?: { basis: number; steuer: number }) => {
    const x = ['<ram:ApplicableTradeTax>'];
    if (mitBetraegen) x.push(el('ram:CalculatedAmount', amt(mitBetraegen.steuer)));
    x.push(el('ram:TypeCode', 'VAT'));
    if (mitBetraegen) {
      if (kat === 'AE') x.push(el('ram:ExemptionReason', 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)'));
      if (kat === 'O') x.push(el('ram:ExemptionReason', 'Nicht im Inland steuerbare Leistung'));
      if (kat === 'E') x.push(el('ram:ExemptionReason', 'Steuerfreie Leistung'));
      x.push(el('ram:BasisAmount', amt(mitBetraegen.basis)));
    }
    x.push(el('ram:CategoryCode', kat));
    if (mitBetraegen && kat === 'AE') x.push(el('ram:ExemptionReasonCode', 'VATEX-EU-AE'));
    if (mitBetraegen && kat === 'O') x.push(el('ram:ExemptionReasonCode', 'VATEX-EU-O'));
    if (kat !== 'O') x.push(el('ram:RateApplicablePercent', amt(katSatz(kat))));
    x.push('</ram:ApplicableTradeTax>');
    return x.join('');
  };
  const partei = (tag: string, p: { name: string; strasse: string; plz: string; ort: string; land: string; email: string; ustid?: string; steuernr?: string; kontakt?: string; telefon?: string; gln?: string }) => [
    `<${tag}>`,
    p.gln ? el('ram:GlobalID', p.gln, 'schemeID="0088"') : '',
    el('ram:Name', p.name),
    p.kontakt || p.telefon || p.email
      ? `<ram:DefinedTradeContact>${el('ram:PersonName', p.kontakt)}${p.telefon ? `<ram:TelephoneUniversalCommunication>${el('ram:CompleteNumber', p.telefon)}</ram:TelephoneUniversalCommunication>` : ''}${p.email ? `<ram:EmailURIUniversalCommunication>${el('ram:URIID', p.email)}</ram:EmailURIUniversalCommunication>` : ''}</ram:DefinedTradeContact>`
      : '',
    '<ram:PostalTradeAddress>', el('ram:PostcodeCode', p.plz), el('ram:LineOne', p.strasse), el('ram:CityName', p.ort), el('ram:CountryID', p.land || 'DE'), '</ram:PostalTradeAddress>',
    p.email ? `<ram:URIUniversalCommunication>${el('ram:URIID', p.email, 'schemeID="EM"')}</ram:URIUniversalCommunication>` : '',
    p.steuernr ? `<ram:SpecifiedTaxRegistration>${el('ram:ID', p.steuernr, 'schemeID="FC"')}</ram:SpecifiedTaxRegistration>` : '',
    p.ustid ? `<ram:SpecifiedTaxRegistration>${el('ram:ID', p.ustid, 'schemeID="VA"')}</ram:SpecifiedTaxRegistration>` : '',
    `</${tag}>`,
  ].join('');

  const x: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"' +
      ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"' +
      ' xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"' +
      ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',
    '<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter>', el('ram:ID', FX_GUIDELINE), '</ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>',
    '<rsm:ExchangedDocument>', el('ram:ID', d.faktura), el('ram:TypeCode', '380'), `<ram:IssueDateTime>${datum102(fakturadatum)}</ram:IssueDateTime>`,
    d.anzahl > 1 ? `<ram:IncludedNote>${el('ram:Content', `Sammelrechnung über ${d.anzahl} Transportaufträge`)}</ram:IncludedNote>` : '',
    '</rsm:ExchangedDocument>',
    '<rsm:SupplyChainTradeTransaction>',
  ];
  lines.forEach((l, i) => {
    x.push(
      '<ram:IncludedSupplyChainTradeLineItem>',
      `<ram:AssociatedDocumentLineDocument>${el('ram:LineID', i + 1)}${l.note ? `<ram:IncludedNote>${el('ram:Content', l.note)}</ram:IncludedNote>` : ''}</ram:AssociatedDocumentLineDocument>`,
      '<ram:SpecifiedTradeProduct>', el('ram:SellerAssignedID', l.artikel), el('ram:Name', l.name), el('ram:Description', l.text), '</ram:SpecifiedTradeProduct>',
      `<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice>${el('ram:ChargeAmount', amt(l.preis))}</ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>`,
      `<ram:SpecifiedLineTradeDelivery>${el('ram:BilledQuantity', amt(l.menge), 'unitCode="C62"')}</ram:SpecifiedLineTradeDelivery>`,
      '<ram:SpecifiedLineTradeSettlement>', steuerXml(l.kat),
      `<ram:SpecifiedTradeSettlementLineMonetarySummation>${el('ram:LineTotalAmount', amt(l.netto))}</ram:SpecifiedTradeSettlementLineMonetarySummation>`,
      '</ram:SpecifiedLineTradeSettlement>',
      '</ram:IncludedSupplyChainTradeLineItem>',
    );
  });
  x.push(
    '<ram:ApplicableHeaderTradeAgreement>', el('ram:BuyerReference', ref),
    partei('ram:SellerTradeParty', {
      name: firma.name, strasse: firma.strasse, plz: firma.plz, ort: firma.ort, land: firma.land || 'DE', email: firma.email,
      ustid: hasO ? '' : firma.ustid, steuernr: firma.steuernr, kontakt: firma.kontakt, telefon: firma.telefon,
    }),
    partei('ram:BuyerTradeParty', {
      name: buyerName, strasse: condense(`${buyer.strasse ?? ''} ${buyer.hausnummer ?? ''}`), plz: buyer.plz ?? '', ort: buyer.ort ?? '', land: buyer.land ?? 'DE',
      email: buyer.email ?? '', ustid: hasO ? '' : ustid, kontakt: buyerKontakt, telefon: buyer.telefon ?? '', gln: condense(buyer.gln),
    }),
    d.anzahl === 1 && order ? `<ram:BuyerOrderReferencedDocument>${el('ram:IssuerAssignedID', order)}</ram:BuyerOrderReferencedDocument>` : '',
    '</ram:ApplicableHeaderTradeAgreement>',
    '<ram:ApplicableHeaderTradeDelivery>',
    von && von === bis ? `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime>${datum102(von)}</ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>` : '',
    '</ram:ApplicableHeaderTradeDelivery>',
    '<ram:ApplicableHeaderTradeSettlement>',
    el('ram:PaymentReference', d.faktura), el('ram:InvoiceCurrencyCode', 'EUR'),
    '<ram:SpecifiedTradeSettlementPaymentMeans>', el('ram:TypeCode', '58'), el('ram:Information', 'SEPA-Überweisung'),
    `<ram:PayeePartyCreditorFinancialAccount>${el('ram:IBANID', firma.iban.replace(/\s+/g, ''))}${el('ram:AccountName', firma.name)}</ram:PayeePartyCreditorFinancialAccount>`,
    firma.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution>${el('ram:BICID', firma.bic)}</ram:PayeeSpecifiedCreditorFinancialInstitution>` : '',
    '</ram:SpecifiedTradeSettlementPaymentMeans>',
  );
  for (const [k, t] of tax) x.push(steuerXml(k, t));
  if (von && bis && von !== bis) x.push(`<ram:BillingSpecifiedPeriod><ram:StartDateTime>${datum102(von)}</ram:StartDateTime><ram:EndDateTime>${datum102(bis)}</ram:EndDateTime></ram:BillingSpecifiedPeriod>`);
  x.push(
    `<ram:SpecifiedTradePaymentTerms>${el('ram:Description', d.zahlungsziel)}<ram:DueDateDateTime>${datum102(d.faellig)}</ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>`,
    '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    el('ram:LineTotalAmount', amt(netto)), el('ram:TaxBasisTotalAmount', amt(netto)), el('ram:TaxTotalAmount', amt(steuer), E),
    el('ram:GrandTotalAmount', amt(brutto)), el('ram:DuePayableAmount', amt(brutto)),
    '</ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    '</ram:ApplicableHeaderTradeSettlement>',
    '</rsm:SupplyChainTradeTransaction>',
    '</rsm:CrossIndustryInvoice>',
  );
  return formatieren(x.filter(Boolean).join(''));
}

export async function zugferdXml(faktura: string): Promise<ZugferdXml | null> {
  const d = await rechnungsdaten(faktura);
  if (!d) return null;
  return { xml: ciiXml(d), hinweise: d.hinweise.map((h) => h.replace('in der XRechnung', 'in der E-Rechnung')), daten: d };
}

/** XMP-Erweiterungsschema Factur-X (Pflicht in ZUGFeRD-PDFs, Anhang PDF/A-3 Extension Schema) */
export function facturXXmp(): string {
  return `
<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
  <pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
    <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
    <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
    <pdfaSchema:prefix>fx</pdfaSchema:prefix>
    <pdfaSchema:property><rdf:Seq>
      <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>name of the embedded XML invoice file</pdfaProperty:description></rdf:li>
      <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>
      <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the Factur-X XML schema</pdfaProperty:description></rdf:li>
      <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the embedded Factur-X data</pdfaProperty:description></rdf:li>
    </rdf:Seq></pdfaSchema:property>
  </rdf:li></rdf:Bag></pdfaExtension:schemas>
</rdf:Description>
<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
  <fx:DocumentType>INVOICE</fx:DocumentType>
  <fx:DocumentFileName>${esc(FX_DATEI)}</fx:DocumentFileName>
  <fx:Version>1.0</fx:Version>
  <fx:ConformanceLevel>${esc(FX_PROFIL)}</fx:ConformanceLevel>
</rdf:Description>`;
}

/** Lesbarer Nachweis für die Oberfläche */
export const zugferdText = (hinweise: string[]) =>
  (hinweise.length ? `E-Rechnung mit Hinweisen: ${hinweise.join(' ')}` : 'ZUGFeRD 2.3 (EN 16931): PDF/A-3 mit eingebetteter factur-x.xml');


/**
 * Strukturprüfung des erzeugten PDFs (ohne externen Validator): PDF/A-3b-Kennzeichnung, Ausgabeprofil,
 * eingebettete Schriften, factur-x.xml als „Alternative“, Factur-X-XMP. Ersetzt keinen vollständigen
 * Validator (veraPDF, Mustang, KoSIT) – dient als Selbsttest und Hinweis in der Oberfläche.
 */
export interface Pruefpunkt { punkt: string; ok: boolean; detail?: string }
export function pdfPruefen(pdf: Buffer, xml: string): { ok: boolean; punkte: Pruefpunkt[] } {
  const s = pdf.toString('latin1');
  const punkte: Pruefpunkt[] = [];
  const p = (punkt: string, ok: boolean, detail?: string) => punkte.push({ punkt, ok, detail });
  p('PDF-Version 1.7', s.startsWith('%PDF-1.7'));
  p('PDF/A-3b in den XMP-Metadaten', /<pdfaid:part>3<\/pdfaid:part>/.test(s) && /<pdfaid:conformance>B<\/pdfaid:conformance>/.test(s));
  p('Ausgabeprofil sRGB (OutputIntent)', /\/S \/GTS_PDFA1/.test(s) && /\/OutputIntents/.test(s));
  const standardFonts = (s.match(/\/BaseFont \/Helvetica(-Bold)?\b/g) ?? []).filter(() => !/\/FontFile2/.test(s)).length;
  p('Alle Schriften eingebettet', /\/FontFile2/.test(s) && standardFonts === 0, standardFonts ? `${standardFonts} Standardschrift(en) ohne Einbettung` : undefined);
  p('factur-x.xml eingebettet', /\/UF \(factur-x\.xml\)/.test(s) || /\/F \(factur-x\.xml\)/.test(s));
  p('Beziehung „Alternative“ (AFRelationship)', /\/AFRelationship \/Alternative/.test(s));
  p('Zugehörige Datei im Katalog (/AF)', /\/AF \[/.test(s));
  p('MIME-Typ text/xml', /\/Subtype \/text#2Fxml/.test(s) || /\/Subtype \/text\/xml/.test(s));
  p('Factur-X-XMP-Schema (EN 16931)', /<fx:ConformanceLevel>EN 16931<\/fx:ConformanceLevel>/.test(s) && /<fx:DocumentFileName>factur-x\.xml<\/fx:DocumentFileName>/.test(s));
  p('Dokumentsprache gesetzt', /\/Lang \(de-DE\)/.test(s));
  p('XML wohlgeformt (Grundprüfung)', wohlgeformt(xml));
  p('CII-Leitlinie EN 16931', xml.includes(`<ram:ID>${FX_GUIDELINE}</ram:ID>`));
  return { ok: punkte.every((x) => x.ok), punkte };
}

/** einfache Wohlgeformtheitsprüfung: öffnende und schließende Tags passen paarweise */
function wohlgeformt(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3] === '/') continue;
    if (m[1] === '/') { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0 && xml.trimStart().startsWith('<?xml');
}
