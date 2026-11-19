import { esc } from '../../../server/src/pdf.js';
import { SCHLUESSEL_TEXT, type AbrechnungsPosition, type GemeinsamSchluessel, type Position, type Schluessel } from './logik.js';

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

/** Kostenaufteilung eines Jahres auf alle Wohnungen (Querformat) */
export interface AufteilungDruck {
  jahr: number;
  von: string;
  bis: string;
  objekt: { bezeichnung: string; strasse: string | null; plz: string | null; ort: string | null; vermieter: string | null };
  erstellt: string;
  einheiten: { id: number; kuerzel: string; bezeichnung: string; flaeche: number; personen: number; eigennutzung: boolean; nutzer: string[] }[];
  /** Kostenart → Teilung des gemeinsamen Verbrauchs (nur Schlüssel „verbrauch“) und Grundkosten in % */
  arten: Record<number, { gemeinsam: GemeinsamSchluessel | null; grundanteil: number }>;
  positionen: Position[];
  abrechnungen: { name: string; einheit: string; von: string; bis: string; kosten: number; vorauszahlungen: number; ergebnis: number; neuerAbschlag: number }[];
  hinweise: string[];
}

/** Erläuterung je Wohnung: die Rechengrundlagen ihrer Nutzungsabschnitte (doppelte zusammengefasst) */
export function basisJeEinheit(p: Position, einheitId: number): string[] {
  return [...new Set(p.anteile.filter((a) => a.einheit_id === einheitId && a.basis).map((a) => a.basis))];
}

/** Text zum Verteilerschlüssel einer Position, beim Verbrauch mit Teilung des gemeinsamen Verbrauchs */
export function schluesselBeschreibung(p: Position, art?: { gemeinsam: GemeinsamSchluessel | null; grundanteil: number }): string {
  const t = SCHLUESSEL_TEXT[p.schluessel] ?? p.schluessel;
  if (p.schluessel !== 'verbrauch') return t;
  const z = [art?.gemeinsam ? `gemeinsamer Verbrauch ${GEMEINSAM_NACH[art.gemeinsam]}` : ''];
  if (art?.grundanteil) z.push(`${zahl(art.grundanteil).replace(/,00$/, '')} % Grundkosten nach Fläche`);
  return `${t}${z.filter(Boolean).length ? ` – ${z.filter(Boolean).join(', ')}` : ''}`;
}

export function aufteilungHtml(a: AufteilungDruck, farbe = '#0a6ed1'): string {
  const anschrift = [a.objekt.strasse, [a.objekt.plz, a.objekt.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const E = a.einheiten;
  const pct = (v: number, g: number) => (Math.abs(g) < 0.005 ? '' : `${(v / g * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`);
  const zeile = (p: Position) => `
    <tr><td class="art">${esc(p.bezeichnung)}${p.p35a ? ' <span class="klein">*</span>' : ''}</td>
      <td class="schl">${esc(schluesselBeschreibung(p, a.arten[p.kostenart_id]))}</td>
      <td class="b gesamt">${eur(p.gesamt)}</td>
      ${E.map((e) => {
        const v = p.einheiten[e.id] ?? 0;
        return `<td class="b anteil"><b>${eur(v)}</b> <span class="pct">${pct(v, p.gesamt)}</span>${basisJeEinheit(p, e.id).map((b) => `<div class="basis">${esc(b)}</div>`).join('')}</td>`;
      }).join('')}</tr>`;
  const summen = (ps: Position[], titel: string, klasse: string, monat = true) => {
    const g = ps.reduce((s, p) => s + p.gesamt, 0);
    const je = (e: number) => ps.reduce((s, p) => s + (p.einheiten[e] ?? 0), 0);
    return `<tr class="${klasse}"><td colspan="2">${titel} pro Jahr</td><td class="b">${eur(g)}</td>${E.map((e) => `<td class="b">${eur(je(e.id))}</td>`).join('')}</tr>
      ${monat ? `<tr class="${klasse} monat"><td colspan="2">${titel} pro Monat</td><td class="b">${eur(g / 12)}</td>${E.map((e) => `<td class="b">${eur(je(e.id) / 12)}</td>`).join('')}</tr>` : ''}`;
  };
  const um = a.positionen.filter((p) => p.umlagefaehig);
  const nicht = a.positionen.filter((p) => !p.umlagefaehig);
  const kopfEinheit = (e: AufteilungDruck['einheiten'][number]) => `<th class="b einheit">${esc(e.kuerzel)}<div class="klein">${esc(e.nutzer.join(', ') || (e.eigennutzung ? 'Eigennutzung' : 'Leerstand'))}</div>
      <div class="klein">${zahl(e.flaeche).replace(/,00$/, '')} m² · ${zahl(e.personen).replace(/,00$/, '')} Pers.</div></th>`;
  const verwendete = [...new Set(a.positionen.map((p) => p.schluessel))];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4 landscape}
    body{font-family:Arial,Helvetica,sans-serif;font-size:8.5pt;color:#222;margin:0}
    .kopf{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid ${esc(farbe)};padding-bottom:6px;margin-bottom:10px}
    h1{font-size:15pt;margin:0 0 2px;color:${esc(farbe)}} h2{font-size:10pt;margin:14px 0 4px}
    .klein{font-size:7pt;color:#666;font-weight:normal}
    table{border-collapse:collapse;width:100%} th{text-align:left;padding:4px 5px;font-size:8pt;background:#eef2f6;border-bottom:1.5px solid #8a99a8;vertical-align:bottom}
    td{padding:4px 5px;border-bottom:1px solid #e1e5ea;vertical-align:top} tr{page-break-inside:avoid}
    .b{text-align:right;white-space:nowrap} .art{font-weight:bold;width:15%} .schl{width:17%;color:#444}
    .gesamt{background:#f7f7f7} .anteil{white-space:normal} .pct{font-size:7pt;color:#666}
    .basis{font-size:6.8pt;color:#666;line-height:1.25;margin-top:1px}
    th.einheit{background:${esc(farbe)}1f;border-bottom-color:${esc(farbe)}}
    .summe td{font-weight:bold;background:#f6dccb;border-bottom:none} .summe.monat td{background:#fbeee4}
    .nicht td{background:#dff0d2;font-weight:bold;border-bottom:none} .nicht.monat td{background:#eef7e8}
    .bereich td{background:#fff;font-weight:bold;color:${esc(farbe)};border-bottom:1px solid ${esc(farbe)};padding-top:10px}
    .raster{display:flex;gap:18px;align-items:flex-start} .raster>div{flex:1}
    .abr td,.abr th{font-size:8pt} ul{margin:2px 0 0 16px;padding:0} li{margin:1px 0}
    .fuss{margin-top:10px;font-size:7pt;color:#666}
  </style></head><body>
    <div class="kopf"><div><h1>Kostenaufteilung ${a.jahr}</h1>
      <div>${esc(a.objekt.bezeichnung)}${anschrift ? `, ${esc(anschrift)}` : ''} · Zeitraum ${dat(a.von)} – ${dat(a.bis)}</div></div>
      <div style="text-align:right">${esc(a.objekt.vermieter ?? '')}<div class="klein">Stand ${esc(a.erstellt)}</div></div></div>
    <table>
      <thead><tr><th>Kostenart</th><th>Verteilerschlüssel</th><th class="b">Gesamtkosten</th>${E.map(kopfEinheit).join('')}</tr></thead>
      <tbody>
        ${um.length ? `<tr class="bereich"><td colspan="${3 + E.length}">Umlagefähige Kosten (Nebenkosten)</td></tr>${um.map(zeile).join('')}${summen(um, 'Nebenkosten', 'summe')}` : ''}
        ${nicht.length ? `<tr class="bereich"><td colspan="${3 + E.length}">In den Nebenkosten nicht berücksichtigt (trägt der Vermieter)</td></tr>${nicht.map(zeile).join('')}${summen(nicht, 'Nicht berücksichtigt', 'nicht')}` : ''}
        ${!a.positionen.length ? `<tr><td colspan="${3 + E.length}">Keine Kosten in diesem Zeitraum.</td></tr>` : ''}
      </tbody>
    </table>
    <div class="raster">
      ${a.abrechnungen.length ? `<div><h2>Abrechnung je Mietverhältnis</h2><table class="abr">
        <thead><tr><th>Mieter</th><th>Zeitraum</th><th class="b">Nebenkosten</th><th class="b">Vorauszahlungen</th><th class="b">Ergebnis</th><th class="b">Vorschlag Abschlag</th></tr></thead>
        <tbody>${a.abrechnungen.map((x) => `<tr><td>${esc(x.name)} <span class="klein">${esc(x.einheit)}</span></td><td style="white-space:nowrap">${dat(x.von)} – ${dat(x.bis)}</td><td class="b">${eur(x.kosten)}</td>
          <td class="b">${eur(x.vorauszahlungen)}</td><td class="b"><b>${x.ergebnis > 0.005 ? `Nachzahlung ${eur(x.ergebnis)}` : x.ergebnis < -0.005 ? `Guthaben ${eur(-x.ergebnis)}` : 'ausgeglichen'}</b></td>
          <td class="b">${eur(x.neuerAbschlag)} / Monat</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div><h2>Verteilerschlüssel</h2><ul>${verwendete.map((s) => `<li><b>${esc(SCHLUESSEL_TEXT[s])}:</b> ${esc(SCHLUESSEL_ERKLAERUNG[s])}</li>`).join('')}</ul></div>
    </div>
    ${a.hinweise.length ? `<h2>Hinweise</h2><ul>${a.hinweise.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
    <div class="fuss">Beträge zeitanteilig für den Zeitraum; Leistungszeiträume der Belege werden tageweise zugeordnet. Der Anteil selbst genutzter und leerstehender Wohnungen bleibt beim Vermieter.${a.positionen.some((p) => p.p35a) ? ' * haushaltsnahe Dienstleistung bzw. Handwerkerleistung (§ 35a EStG).' : ''}</div>
  </body></html>`;
}

const GEMEINSAM_NACH: Record<GemeinsamSchluessel, string> = { flaeche: 'nach Wohnfläche', personen: 'nach Personen', einheiten: 'zu gleichen Teilen' };

const SCHLUESSEL_ERKLAERUNG: Record<Schluessel, string> = {
  flaeche: 'Anteil der Wohnfläche an der Gesamtfläche.',
  personen: 'Personen × bewohnte Tage (Personentage) im Verhältnis aller Personentage.',
  einheiten: 'zu gleichen Teilen je Wohnung.',
  anteil: 'fest vereinbarter Prozentsatz je Wohnung.',
  verbrauch: 'gemessener Verbrauch der eigenen Zähler; gemeinsamer Verbrauch (Gemeinschaftszähler, Rest des Hauptzählers) nach dem angegebenen Schlüssel.',
  direkt: 'Beleg ist einer Wohnung direkt zugeordnet.',
};
