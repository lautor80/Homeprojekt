import { fakturaAuftraege, firmaLesen, kaeufer } from './data.js';
import { condense, dat, eur, heute, katText, kategorie } from './format.js';

export interface XRechnung {
  faktura: string;
  filename: string;
  xml: string;
  hinweise: string[];
  html: string;
  xmlHtml: string;
}

interface Line {
  name: string;
  text: string;
  artikel: string;
  note: string;
  menge: number;
  preis: number;
  netto: number;
  kat: string;
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const amt = (v: number) => v.toFixed(2);
const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Element nur ausgeben, wenn ein Wert vorhanden ist */
function el(name: string, value: unknown, attr = ''): string {
  const v = condense(String(value ?? ''));
  if (!v) return '';
  return attr ? `<${name} ${attr}>${esc(v)}</${name}>` : `<${name}>${esc(v)}</${name}>`;
}

/**
 * E-Rechnung im Format XRechnung 3.0 (UBL 2.1 Invoice, EN 16931) zu einer Faktura.
 * Nachbau von ZCL_EU_XRECHNUNG – Endbetrag = gespeicherter Rechnungsbetrag (RGBETRAG),
 * Netto und USt daraus zurückgerechnet. Fehlende Pflichtangaben werden als Hinweise geliefert,
 * die XML wird trotzdem erzeugt.
 */
export async function xrechnungErzeugen(faktura: string): Promise<XRechnung> {
  const res: XRechnung = { faktura, filename: `XRechnung_${faktura}.xml`, xml: '', hinweise: [], html: '', xmlHtml: '' };
  const firma = await firmaLesen();
  const satz = firma.ust_satz;
  const katSatz = (k: string) => (k === 'S' ? satz : 0);

  const auftraege = await fakturaAuftraege(faktura);
  if (!auftraege.length) {
    res.hinweise.push(`Zur Rechnung ${faktura} wurden keine Aufträge gefunden.`);
    return res;
  }

  let fakturadatum = auftraege[0].fakturadatum;
  if (!fakturadatum) {
    fakturadatum = heute();
    res.hinweise.push('Fakturadatum fehlt - Tagesdatum als Rechnungsdatum verwendet.');
  }

  const buyer = { ...(kaeufer(auftraege[0]) ?? ({} as Record<string, never>)) } as NonNullable<ReturnType<typeof kaeufer>>;
  const lines: Line[] = [];
  let ref = '';
  let order = '';
  let von: string | null = null;
  let bis: string | null = null;
  let soll = 0;
  let hasO = false;

  for (const a of auftraege) {
    const s = a.stops[0];
    const kat = kategorie(a.steuerrelevant, buyer.land);
    if (kat === 'O') hasO = true;

    order = condense(a.ordernummer);
    if (order.toUpperCase() === 'FOLGT') order = '';
    if (!ref && order) ref = order;

    // Leistungsdatum: Leistungsdatum > Entladedatum > Ladedatum
    const datum = a.leistungsdatum ?? s.datum_e ?? s.datum ?? a.datumladen1;
    if (datum) {
      if (!von || datum < von) von = datum;
      if (!bis || datum > bis) bis = datum;
    }

    const route = condense(`${s.plzort ?? ''} → ${s.plzort_e ?? ''}`);
    let text = !s.plzort && !s.plzort_e ? 'Transportleistung' : `Transport ${route}`;
    if (datum) text += `, Leistungsdatum ${dat(datum)}`;
    if (a.kennzeichen && condense(a.kennzeichen).toUpperCase() !== 'BITTE ANGEBEN') text += `, Kennzeichen ${condense(a.kennzeichen)}`;
    const tr = a.traeger.filter((t) => t.menge >= 1).map((t) => `${t.menge} x ${t.prod_txt || t.produkt}`).join(', ');
    if (tr) text += `, Holzträger: ${tr}`;

    const posNetto = katSatz(kat) ? r2((a.rgbetrag * 100) / (100 + katSatz(kat))) : r2(a.rgbetrag);
    lines.push({
      name: `Auftrag ${a.auftragsnr}`,
      text,
      artikel: a.auftragsnr,
      note: order ? `Ihre Bestellung: ${order}` : '',
      menge: 1,
      preis: posNetto,
      netto: posNetto,
      kat,
    });
    soll += a.rgbetrag;
  }

  // Steuern je Kategorie
  const tax = new Map<string, { basis: number; steuer: number }>();
  let netto = 0;
  for (const l of lines) {
    netto += l.netto;
    const t = tax.get(l.kat) ?? { basis: 0, steuer: 0 };
    t.basis += l.netto;
    tax.set(l.kat, t);
  }
  let steuer = 0;
  for (const [k, t] of tax) {
    t.basis = r2(t.basis);
    t.steuer = r2((t.basis * katSatz(k)) / 100);
    steuer += t.steuer;
  }
  netto = r2(netto);
  steuer = r2(steuer);
  const brutto = r2(netto + steuer);

  // Plausibilitäten / Pflichtangaben
  if (Math.abs(brutto - soll) > 0.02) {
    res.hinweise.push(`Endbetrag ${amt(brutto)} EUR weicht vom gespeicherten Rechnungsbetrag ${amt(soll)} EUR ab.`);
  }
  if (!firma.email) res.hinweise.push('Eigene E-Mail-Adresse fehlt (Pflichtangabe BT-34/BT-43) – bitte unter Transport → Stammdaten → Firmendaten pflegen.');
  if (!firma.name || !firma.iban) res.hinweise.push('Firmendaten unvollständig (Name/IBAN) – bitte unter Stammdaten → Firmendaten pflegen.');
  if (!buyer.email) res.hinweise.push(`E-Mail-Adresse des Rechnungsempfängers ${buyer.kundenname ?? ''} fehlt (BT-49, Pflicht).`);
  if (!buyer.land) {
    buyer.land = 'DE';
    res.hinweise.push('Land des Rechnungsempfängers fehlt - DE angenommen.');
  }
  const ustid = condense(buyer.ustid).replace(/\s/g, '');
  if (tax.has('AE') && !ustid) res.hinweise.push('Reverse Charge: USt-IdNr. des Empfängers fehlt (BT-48, Pflicht bei Kategorie AE).');
  if (hasO && !firma.steuernr) res.hinweise.push('Nicht steuerbare Leistung: eigene Steuernummer fehlt (BT-32) - unter Firmendaten pflegen.');
  if (hasO && tax.size > 1) res.hinweise.push('Nicht steuerbare und steuerbare Aufträge in einer Rechnung sind in der XRechnung nicht zulässig.');
  if (!ref) ref = auftraege[0].auftragsnr;

  const katXml = (kat: string, tag: string) => {
    const x = [`<${tag}>`, el('cbc:ID', kat)];
    if (kat !== 'O') x.push(el('cbc:Percent', amt(katSatz(kat))));
    if (tag === 'cac:TaxCategory') {
      if (kat === 'AE') x.push(el('cbc:TaxExemptionReasonCode', 'VATEX-EU-AE'), el('cbc:TaxExemptionReason', 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)'));
      if (kat === 'O') x.push(el('cbc:TaxExemptionReasonCode', 'VATEX-EU-O'), el('cbc:TaxExemptionReason', 'Nicht im Inland steuerbare Leistung'));
      if (kat === 'E') x.push(el('cbc:TaxExemptionReason', 'Steuerfreie Leistung'));
    }
    x.push('<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>', `</${tag}>`);
    return x;
  };

  const buyerName = condense(`${buyer.kundenname ?? ''} ${buyer.kundenname2 ?? ''}`);
  const buyerKontakt = condense(`${buyer.vorname ?? ''} ${buyer.name ?? ''}`);
  const zahlungsziel = `Zahlbar innerhalb von ${firma.zahlungsziel_tage} Tagen nach Rechnungserhalt.`;
  const E = 'currencyID="EUR"';

  // XML (UBL 2.1 Invoice, Elementreihenfolge laut XSD)
  const x: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"' +
      ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
      ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    el('cbc:CustomizationID', 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0'),
    el('cbc:ProfileID', 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0'),
    el('cbc:ID', faktura),
    el('cbc:IssueDate', fakturadatum),
    el('cbc:InvoiceTypeCode', '380'),
    auftraege.length > 1 ? el('cbc:Note', `Sammelrechnung über ${auftraege.length} Transportaufträge`) : '',
    el('cbc:DocumentCurrencyCode', 'EUR'),
    el('cbc:BuyerReference', ref),
  ];
  if (von && von !== bis) x.push('<cac:InvoicePeriod>', el('cbc:StartDate', von), el('cbc:EndDate', bis), '</cac:InvoicePeriod>');
  if (auftraege.length === 1 && order) x.push('<cac:OrderReference>', el('cbc:ID', order), '</cac:OrderReference>');

  // Rechnungssteller
  x.push(
    '<cac:AccountingSupplierParty><cac:Party>',
    el('cbc:EndpointID', firma.email, 'schemeID="EM"'),
    `<cac:PartyName>${el('cbc:Name', firma.name)}</cac:PartyName>`,
    '<cac:PostalAddress>', el('cbc:StreetName', firma.strasse), el('cbc:CityName', firma.ort), el('cbc:PostalZone', firma.plz),
    `<cac:Country>${el('cbc:IdentificationCode', firma.land || 'DE')}</cac:Country>`, '</cac:PostalAddress>',
  );
  if (!hasO && firma.ustid) x.push('<cac:PartyTaxScheme>', el('cbc:CompanyID', firma.ustid), '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>', '</cac:PartyTaxScheme>');
  if (firma.steuernr) x.push('<cac:PartyTaxScheme>', el('cbc:CompanyID', firma.steuernr), '<cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme>', '</cac:PartyTaxScheme>');
  x.push(
    `<cac:PartyLegalEntity>${el('cbc:RegistrationName', firma.name)}</cac:PartyLegalEntity>`,
    '<cac:Contact>', el('cbc:Name', firma.kontakt), el('cbc:Telephone', firma.telefon), el('cbc:ElectronicMail', firma.email), '</cac:Contact>',
    '</cac:Party></cac:AccountingSupplierParty>',
  );

  // Rechnungsempfänger
  x.push('<cac:AccountingCustomerParty><cac:Party>', el('cbc:EndpointID', buyer.email, 'schemeID="EM"'));
  if (buyer.gln) x.push(`<cac:PartyIdentification>${el('cbc:ID', condense(buyer.gln), 'schemeID="0088"')}</cac:PartyIdentification>`);
  x.push(
    `<cac:PartyName>${el('cbc:Name', buyerName)}</cac:PartyName>`,
    '<cac:PostalAddress>', el('cbc:StreetName', condense(`${buyer.strasse ?? ''} ${buyer.hausnummer ?? ''}`)),
    el('cbc:CityName', buyer.ort), el('cbc:PostalZone', buyer.plz),
    `<cac:Country>${el('cbc:IdentificationCode', buyer.land)}</cac:Country>`, '</cac:PostalAddress>',
  );
  if (ustid && !hasO) x.push('<cac:PartyTaxScheme>', el('cbc:CompanyID', ustid), '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>', '</cac:PartyTaxScheme>');
  x.push(`<cac:PartyLegalEntity>${el('cbc:RegistrationName', buyerName)}</cac:PartyLegalEntity>`);
  if (buyerKontakt || buyer.telefon || buyer.email) {
    x.push('<cac:Contact>', el('cbc:Name', buyerKontakt), el('cbc:Telephone', buyer.telefon), el('cbc:ElectronicMail', buyer.email), '</cac:Contact>');
  }
  x.push('</cac:Party></cac:AccountingCustomerParty>');

  if (von && von === bis) x.push(`<cac:Delivery>${el('cbc:ActualDeliveryDate', von)}</cac:Delivery>`);

  // Zahlung: SEPA-Überweisung
  x.push(
    '<cac:PaymentMeans>', el('cbc:PaymentMeansCode', '58'), el('cbc:PaymentID', faktura),
    '<cac:PayeeFinancialAccount>', el('cbc:ID', firma.iban.replace(/\s+/g, '')), el('cbc:Name', firma.name),
    `<cac:FinancialInstitutionBranch>${el('cbc:ID', firma.bic)}</cac:FinancialInstitutionBranch>`,
    '</cac:PayeeFinancialAccount>', '</cac:PaymentMeans>',
    `<cac:PaymentTerms>${el('cbc:Note', zahlungsziel)}</cac:PaymentTerms>`,
  );

  // Steuern
  x.push('<cac:TaxTotal>', el('cbc:TaxAmount', amt(steuer), E));
  for (const [k, t] of tax) {
    x.push('<cac:TaxSubtotal>', el('cbc:TaxableAmount', amt(t.basis), E), el('cbc:TaxAmount', amt(t.steuer), E), ...katXml(k, 'cac:TaxCategory'), '</cac:TaxSubtotal>');
  }
  x.push('</cac:TaxTotal>');

  // Summen
  x.push(
    '<cac:LegalMonetaryTotal>',
    el('cbc:LineExtensionAmount', amt(netto), E),
    el('cbc:TaxExclusiveAmount', amt(netto), E),
    el('cbc:TaxInclusiveAmount', amt(brutto), E),
    el('cbc:PayableAmount', amt(brutto), E),
    '</cac:LegalMonetaryTotal>',
  );

  // Positionen
  lines.forEach((l, i) => {
    x.push(
      '<cac:InvoiceLine>', el('cbc:ID', i + 1), el('cbc:Note', l.note),
      el('cbc:InvoicedQuantity', amt(l.menge), 'unitCode="C62"'), el('cbc:LineExtensionAmount', amt(l.netto), E),
      '<cac:Item>', el('cbc:Description', l.text), el('cbc:Name', l.name),
      `<cac:SellersItemIdentification>${el('cbc:ID', l.artikel)}</cac:SellersItemIdentification>`,
      ...katXml(l.kat, 'cac:ClassifiedTaxCategory'), '</cac:Item>',
      `<cac:Price>${el('cbc:PriceAmount', amt(l.preis), E)}</cac:Price>`, '</cac:InvoiceLine>',
    );
  });
  x.push('</ubl:Invoice>');

  res.xml = formatieren(x.filter(Boolean).join(''));
  res.xmlHtml = xmlHtml(res.xml);

  // Lesbare Vorschau (HTML) – gleiche Daten wie die XML
  const td = 'padding:6px 8px;vertical-align:top';
  const zeit = !von ? '' : von === bis ? ` · Leistungsdatum ${dat(von)}` : ` · Leistungszeitraum ${dat(von)} – ${dat(bis)}`;
  const h: string[] = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:0.875rem;color:#32363a;padding:1rem 1.5rem;background:#fff">',
    `<div style="font-size:1.25rem;font-weight:bold">Rechnung ${esc(faktura)}</div>`,
    `<div style="color:#6a6d70;margin:0.25rem 0 1.25rem">Rechnungsdatum ${dat(fakturadatum)} · E-Rechnung XRechnung 3.0 (UBL)</div>`,
    '<table style="width:100%;border-collapse:collapse;margin-bottom:1.25rem"><tr>',
    `<td style="vertical-align:top;width:50%;padding-right:1rem"><div style="color:#6a6d70;font-size:0.75rem;margin-bottom:4px">RECHNUNGSSTELLER</div>` +
      `<b>${esc(firma.name)}</b><br>${esc(firma.strasse)}<br>${esc(firma.land)}-${esc(firma.plz)} ${esc(firma.ort)}` +
      `<br>USt-IdNr. ${esc(firma.ustid)}<br>${esc(firma.telefon)}${firma.email ? ` · ${esc(firma.email)}` : ''}</td>`,
    `<td style="vertical-align:top;width:50%"><div style="color:#6a6d70;font-size:0.75rem;margin-bottom:4px">RECHNUNGSEMPFÄNGER</div>` +
      `<b>${esc(buyerName)}</b><br>${esc(condense(`${buyer.strasse ?? ''} ${buyer.hausnummer ?? ''}`))}` +
      `<br>${esc(condense(`${buyer.land}-${buyer.plz ?? ''} ${buyer.ort ?? ''}`))}<br>${esc(buyer.email)}${ustid ? `<br>USt-IdNr. ${esc(ustid)}` : ''}</td>`,
    '</tr></table>',
    `<div style="margin-bottom:0.75rem">Ihre Referenz: <b>${esc(ref)}</b>${zeit}</div>`,
    '<table style="width:100%;border-collapse:collapse">',
    `<tr style="background:#f5f6f7;text-align:left;border-bottom:1px solid #d9d9d9"><th style="${td}">Pos.</th><th style="${td}">Bezeichnung</th>` +
      `<th style="${td};text-align:right">Menge</th><th style="${td};text-align:right">Einzelpreis</th>` +
      `<th style="${td};text-align:right">Netto</th><th style="${td};text-align:right">USt</th></tr>`,
  ];
  lines.forEach((l, i) => {
    h.push(
      `<tr style="border-bottom:1px solid #e5e5e5"><td style="${td}">${i + 1}</td>` +
        `<td style="${td}"><b>${esc(l.name)}</b><br><span style="color:#6a6d70">${esc(l.text)}</span>` +
        `${l.note ? `<br><span style="color:#6a6d70">${esc(l.note)}</span>` : ''}</td>` +
        `<td style="${td};text-align:right">${l.menge}</td>` +
        `<td style="${td};text-align:right;white-space:nowrap">${eur(l.preis)}</td>` +
        `<td style="${td};text-align:right;white-space:nowrap">${eur(l.netto)}</td>` +
        `<td style="${td};text-align:right;white-space:nowrap">${katText(l.kat, satz)}</td></tr>`,
    );
  });
  h.push('</table>', '<table style="margin:0.75rem 0 0 auto;border-collapse:collapse">',
    `<tr><td style="padding:3px 16px 3px 0">Summe netto</td><td style="padding:3px 8px;text-align:right">${eur(netto)}</td></tr>`);
  for (const [k, t] of tax) {
    h.push(`<tr><td style="padding:3px 16px 3px 0">USt ${katText(k, satz)} auf ${eur(t.basis)}</td><td style="padding:3px 8px;text-align:right">${eur(t.steuer)}</td></tr>`);
  }
  h.push(
    `<tr style="font-weight:bold;border-top:1px solid #32363a"><td style="padding:6px 16px 6px 0">Endbetrag</td><td style="padding:6px 8px;text-align:right">${eur(brutto)}</td></tr></table>`,
    `<div style="margin-top:1.25rem;color:#6a6d70">${esc(zahlungsziel)} Überweisung an ${esc(firma.bank)}, IBAN ${esc(firma.iban)}, BIC ${esc(firma.bic)}, Verwendungszweck ${esc(faktura)}.</div>`,
    '</div>',
  );
  res.html = h.join('');
  return res;
}

/** XML mit Einrückung je Hierarchieebene (2 Leerzeichen) */
function formatieren(xml: string): string {
  let out = '';
  let depth = 0;
  let last: 'D' | 'S' | 'E' | 'T' = 'D';
  for (const tok of xml.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (tok.startsWith('<?')) {
      out += tok;
      last = 'D';
    } else if (tok.startsWith('</')) {
      depth--;
      out += last === 'T' || last === 'S' ? tok : `\n${'  '.repeat(depth)}${tok}`;
      last = 'E';
    } else if (tok.startsWith('<')) {
      out += `\n${'  '.repeat(depth)}${tok}`;
      if (tok.endsWith('/>')) last = 'E';
      else {
        depth++;
        last = 'S';
      }
    } else if (tok.trim()) {
      out += tok;
      last = 'T';
    }
  }
  return out;
}

/** Eingerückte XML farbig als HTML (Tags blau, Attribute braun, Werte grün) */
function xmlHtml(xml: string): string {
  let h = xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  h = h.replace(/([A-Za-z_:]+)=&quot;([^&]*)&quot;/g, '<span style="color:#b04600">$1</span>=<span style="color:#107e3e">"$2"</span>');
  h = h.replace(/&lt;(\/?)([A-Za-z_]+:[A-Za-z_]+|[A-Za-z_]+)/g, '&lt;$1<span style="color:#0a6ed1;font-weight:bold">$2</span>');
  return `<pre style="font-family:Consolas,Menlo,'Courier New',monospace;font-size:0.8125rem;line-height:1.5;margin:0;padding:1rem 1.25rem;background:#fafafa;color:#32363a;white-space:pre;overflow:auto">${h}</pre>`;
}
