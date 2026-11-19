import { esc } from '../../../server/src/pdf.js';
import { SCHLUESSEL_TEXT, type AbrechnungsPosition, type Schluessel } from './logik.js';

const zahl = (v: number) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v: number) => `${zahl(v)} €`;
const dat = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export interface AbrechnungDruck {
  jahr: number;
  objekt: { bezeichnung: string; strasse: string | null; plz: string | null; ort: string | null; vermieter: string | null; vermieter_anschrift: string | null; iban: string | null };
  mieter: { name: string; anschrift: string | null; einheit: string };
  von: string;
  bis: string;
  tage: number;
  positionen: AbrechnungsPosition[];
  kosten: number;
  vorauszahlungen: number;
  ergebnis: number;
  p35a: number;
  neuerAbschlag: number;
  erstellt: string;
}

/** Nebenkostenabrechnung als HTML (für Gotenberg → PDF) */
export function abrechnungHtml(a: AbrechnungDruck, farbe = '#0a6ed1'): string {
  const anschrift = [a.objekt.strasse, [a.objekt.plz, a.objekt.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const zeilen = a.positionen.map((p) => `
    <tr><td>${esc(p.bezeichnung)}${p.p35a ? ' *' : ''}</td><td>${esc(SCHLUESSEL_TEXT[p.schluessel as Schluessel] ?? p.schluessel)}<div class="klein">${esc(p.basis)}</div></td>
        <td class="b">${eur(p.gesamt)}</td><td class="b">${eur(p.anteil)}</td></tr>`).join('');
  const ergebnisText = a.ergebnis > 0
    ? `Nachzahlung: <b>${eur(a.ergebnis)}</b>. Bitte überweisen Sie den Betrag innerhalb von 30 Tagen${a.objekt.iban ? ` auf das Konto ${esc(a.objekt.iban)}` : ''}.`
    : a.ergebnis < 0 ? `Guthaben: <b>${eur(-a.ergebnis)}</b>. Der Betrag wird Ihnen erstattet bzw. mit der nächsten Miete verrechnet.` : 'Kosten und Vorauszahlungen sind ausgeglichen.';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#222;margin:0}
    .kopf{display:flex;justify-content:space-between;border-bottom:3px solid ${esc(farbe)};padding-bottom:8px;margin-bottom:18px}
    h1{font-size:16pt;margin:0 0 4px} .klein{font-size:8pt;color:#666}
    table{border-collapse:collapse;width:100%;margin-top:12px} th{text-align:left;border-bottom:1px solid #999;padding:5px;font-size:9pt}
    td{padding:5px;border-bottom:1px solid #ddd;vertical-align:top} .b{text-align:right;white-space:nowrap}
    tfoot td{font-weight:bold;border-top:1px solid #999} .summe td{border:none;padding:3px 5px}
    .ergebnis{margin-top:14px;padding:10px;background:#f4f4f4}
  </style></head><body>
    <div class="kopf"><div><b>${esc(a.objekt.vermieter ?? '')}</b><br>${esc(a.objekt.vermieter_anschrift ?? '')}</div>
      <div style="text-align:right">${esc(a.erstellt)}</div></div>
    <div style="margin-bottom:18px">${esc(a.mieter.name)}<br>${esc(a.mieter.anschrift ?? anschrift).replace(/\n/g, '<br>')}</div>
    <h1>Betriebskostenabrechnung ${a.jahr}</h1>
    <div>${esc(a.objekt.bezeichnung)}${anschrift ? `, ${esc(anschrift)}` : ''} – Wohnung ${esc(a.mieter.einheit)}</div>
    <div>Abrechnungszeitraum ${dat(`${a.jahr}-01-01`)} – ${dat(`${a.jahr}-12-31`)}; Ihr Nutzungszeitraum ${dat(a.von)} – ${dat(a.bis)} (${a.tage} Tage)</div>
    <table><thead><tr><th>Kostenart</th><th>Verteilerschlüssel / Ihr Anteil</th><th class="b">Gesamtkosten</th><th class="b">Ihr Anteil</th></tr></thead>
      <tbody>${zeilen}</tbody>
      <tfoot><tr><td colspan="3">Ihre Kosten</td><td class="b">${eur(a.kosten)}</td></tr></tfoot></table>
    <table class="summe" style="width:50%;margin-left:50%">
      <tr><td>Ihre Kosten</td><td class="b">${eur(a.kosten)}</td></tr>
      <tr><td>abzüglich geleistete Vorauszahlungen</td><td class="b">− ${eur(a.vorauszahlungen)}</td></tr>
      <tr><td><b>${a.ergebnis >= 0 ? 'Nachzahlung' : 'Guthaben'}</b></td><td class="b"><b>${eur(Math.abs(a.ergebnis))}</b></td></tr>
    </table>
    <div class="ergebnis">${ergebnisText}${a.neuerAbschlag ? `<br>Vorschlag für die monatliche Vorauszahlung ab sofort: <b>${eur(a.neuerAbschlag)}</b>.` : ''}</div>
    ${a.p35a ? `<p class="klein">* Darin enthaltene Aufwendungen für haushaltsnahe Dienstleistungen bzw. Handwerkerleistungen nach § 35a EStG (Ihr Anteil): ${eur(a.p35a)}.</p>` : ''}
    <p class="klein">Die Belege können nach Absprache eingesehen werden. Einwendungen gegen die Abrechnung sind spätestens bis zum Ablauf des zwölften Monats nach Zugang mitzuteilen (§ 556 Abs. 3 BGB).</p>
  </body></html>`;
}
