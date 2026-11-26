/**
 * Auftrag aus Beleg – Layout „bestellung“: Bestellung eines Kunden über Frachtkosten.
 * Kopfblock (Bestellung Nr., Datum, Lieferbedingung, Liefertermin …), Position mit Freitext (LM, kg, Ladenr., Ladetermin,
 * Ladestelle, Lieferadresse, Kontakt) und Summenblock (Warenwert, Gesamtpreis netto).
 *
 * Der Kopfblock kommt aus pdftotext als „Beschriftung   Wert“ in einer Zeile, aus der Texterkennung eines Bildes dagegen oft als
 * Block aller Beschriftungen, gefolgt von einem Block aller Werte. Im zweiten Fall wird nur zugeordnet, was nach Reihenfolge UND
 * Art des Wertes zweifelsfrei ist – sonst „unklar“.
 */
import type { BelegAnschrift, BelegErkennung, Feld } from './typen.js';
import {
  FIRMA, MAX, anschriftText, ausFunden, betraege, betragText, blockLesen, bloeckeInStop, datumText, eindeutig, fehlt, gewichte, gleich, kurz, lademeter,
  leereErkennung, meterText, nachLabel, naechste, nurBetrag, nurTermin, plzOrt, sauber, spalten, telefon, termine, terminFelder, textFeld, tonnenText, unklar,
  type Block, type Fund, type Termin,
} from './erkennung-helfer.js';

const KOPF: [string, RegExp][] = [
  ['nr', /Bestellung\s*Nr\.?/], ['datum', /Datum/], ['sachbearbeiter', /Sachbearbeiter(?:in)?/], ['tel', /Tel(?:efon)?\.?/], ['lieferantnr', /Lieferanten\s?-?\s?Nr\.?/],
  ['lieferbedingung', /Lieferbedingung(?:en)?/], ['zahlungsbedingung', /Zahlungsbedingung(?:en)?/], ['fax', /Lieferanten\s?-?\s?Fax/], ['liefertermin', /Liefertermin/],
];
const LADESTELLE = /(?:Ladestelle|Ladestell|Beladestelle)/;
const LIEFERADRESSE = /(?:Lieferadresse|Lieferanschrift|Entladestelle)/;
/** Zeilen, an denen ein Anschriftblock sicher endet */
const BLOCK_ENDE = /^(Ladenr|Ladenummer|Ladetermin|Ladestell|Beladestelle|Lieferadresse|Lieferanschrift|Entladestelle|Kontakt|Warenwert|Rabatt|Gesamtpreis|Einzelpreis|Mit\s+freundlich|Pos\.)/i;
const TABELLE = /^(Wir\s+bestellen|Pos\.?\s|.*\bMenge\b.*\bBezeichnung\b)/i;
const KENNUNG = /^[A-Z0-9][A-Z0-9\/._-]{2,29}$/i;
/** Lieferbedingungen, die im Werteblock ohne Beschriftung sicher als solche erkennbar sind */
const LIEFERBEDINGUNG = /^(frei\s+(Haus|Werk|Baustelle|Bordsteinkante|Verwendungsstelle)|ab\s+Werk|unfrei|EXW|FCA|CPT|CIP|DAP|DPU|DDP|FOB|CFR|CIF)\b/i;

interface Kopf { nr: Feld; liefertermin: Fund<Termin>[]; lieferterminUnsicher: string | null; lieferbedingung: string | null }

function kopfLesen(zeilen: string[]): Kopf {
  const k: Kopf = { nr: fehlt(), liefertermin: [], lieferterminUnsicher: null, lieferbedingung: null };
  const iTabelle = zeilen.findIndex((z) => TABELLE.test(z.trim()));
  const ende = iTabelle >= 0 ? iTabelle : zeilen.length;
  /** Beschriftungen ohne Wert in derselben Zeile (Blockform der Texterkennung), in der Reihenfolge des Belegs */
  const blank: { name: string; i: number }[] = [];
  const nrFunde: Fund[] = [];
  for (let i = 0; i < ende; i++) {
    for (const [name, re] of KOPF) {
      // nachLabel trifft nur ganze Beschriftungen: „Datum“ nicht in „Lieferdatum“, „Tel.“ nicht in „Lieferanten-Tel.“
      const rest = nachLabel(zeilen[i], re);
      if (rest === null) continue;
      if (!rest) { blank.push({ name, i }); break; }
      if (name === 'nr') {
        const m = /^([A-Z0-9][A-Z0-9\/._-]*)/i.exec(rest);
        if (m && /\d/.test(m[1])) nrFunde.push({ wert: m[1], text: m[1], herkunft: zeilen[i].trim() });
      } else if (name === 'liefertermin') {
        const t = termine(rest)[0];
        if (t) k.liefertermin.push({ wert: t, text: datumText(t.datum), herkunft: zeilen[i].trim() });
      } else if (name === 'lieferbedingung') k.lieferbedingung ??= spalten(rest)[0] ?? null;
      break;
    }
  }
  // Blockform: Werte stehen hinter der letzten Beschriftung ohne Wert, bis zur Positionstabelle
  const werte: string[] = [];
  if (blank.length) {
    const letzte = Math.max(...blank.map((b) => b.i));
    for (let i = letzte + 1; i < ende; i++) { const t = sauber(zeilen[i]); if (t) werte.push(t); }
  }
  const hat = (n: string) => blank.some((b) => b.name === n);
  if (hat('nr') && !nrFunde.length) {
    const kennung = (w: string | undefined) => !!w && KENNUNG.test(w) && /\d/.test(w) && !nurTermin(w);
    const reihenfolgeKlar = blank[0].name === 'nr' && kennung(werte[0]) && (blank[1]?.name !== 'datum' || nurTermin(werte[1] ?? ''));
    if (reihenfolgeKlar) k.nr = textFeld(werte[0], `Bestellung Nr. … ${werte[0]}`, MAX.ordernummer, 'Bestellnummer', []);
    else {
      const kand = werte.filter((w) => /^\d{3,}$/.test(w));
      if (kand.length) k.nr = unklar(kand.map((w) => ({ wert: w, text: w, herkunft: w })), 'Die Bestellnummer steht im Beleg getrennt von ihrer Beschriftung und ließ sich nicht sicher zuordnen.');
    }
  } else k.nr = ausFunden(nrFunde, 'Im Beleg stehen verschiedene Bestellnummern.');
  if (hat('liefertermin') && !k.liefertermin.length) {
    const daten = werte.filter(nurTermin).map((w) => ({ t: termine(w)[0], w }));
    const erwartet = hat('datum') ? 2 : 1;
    const letzterWertIstDatum = werte.length > 0 && nurTermin(werte[werte.length - 1]);
    const funde = (d: typeof daten) => d.map((x) => ({ wert: x.t, text: datumText(x.t.datum), herkunft: `Liefertermin … ${x.w}` }));
    // Liefertermin ist die letzte Beschriftung des Kopfblocks → das letzte Datum des Werteblocks
    if (daten.length === erwartet && blank[blank.length - 1].name === 'liefertermin' && letzterWertIstDatum) k.liefertermin = funde(daten.slice(-1));
    else if (daten.length) {
      k.liefertermin = funde(daten);
      k.lieferterminUnsicher = 'Der Liefertermin steht im Beleg getrennt von seiner Beschriftung und ließ sich nicht sicher zuordnen (Belegdatum oder Liefertermin?).';
    }
  }
  if (hat('lieferbedingung') && !k.lieferbedingung) {
    const kand = werte.filter((w) => LIEFERBEDINGUNG.test(w));
    if (kand.length === 1) k.lieferbedingung = kand[0];
  }
  return k;
}

/** Firma des Bestellers: Absenderzeile im Briefkopf („Firma - Straße, PLZ Ort“) und Firma unter der Grußformel */
function kundeLesen(zeilen: string[], hinweise: string[]): Feld<BelegAnschrift> {
  const funde: Fund<BelegAnschrift>[] = [];
  const eigene = (name: string) => /euro\s?-?\s?flex/i.test(name);
  const iTabelle = zeilen.findIndex((z) => TABELLE.test(z.trim()));
  for (let i = 0; i < (iTabelle >= 0 ? iTabelle : Math.min(zeilen.length, 25)); i++) {
    for (const sp of spalten(zeilen[i])) {
      const teile = sp.split(/\s+[-–—·|•]\s+|\s*,\s+/).map(sauber).filter(Boolean);
      const iOrt = teile.findIndex((t) => plzOrt(t));
      if (teile.length < 2 || iOrt < 1 || !FIRMA.test(teile[0]) || eigene(teile[0])) continue;
      const o = plzOrt(teile[iOrt])!;
      funde.push({ wert: { name: teile[0], strasse: iOrt >= 2 ? teile[iOrt - 1] : null, land: o.land, plz: o.plz, ort: o.ort }, text: '', herkunft: sp });
    }
  }
  const iGruss = zeilen.findIndex((z) => /^\s*Mit\s+(freundliche[nm]|beste[nm])\s+Gr[üu](ß|ss)en/i.test(z));
  if (iGruss >= 0) {
    const rest = sauber(zeilen[iGruss].replace(/^\s*Mit\s+\S+\s+\S+[,.]?/i, ''));
    let name = rest && FIRMA.test(rest) ? rest : '';
    // Firma in einer der nächsten drei nicht leeren Zeilen (davor steht ggf. der Name des Sachbearbeiters)
    for (let n = naechste(zeilen, iGruss + 1), k = 0; !name && n >= 0 && k < 3; n = naechste(zeilen, n + 1), k++) {
      const z = spalten(zeilen[n])[0] ?? '';
      if (FIRMA.test(z) && !plzOrt(z) && !/\d{3}/.test(z)) name = z;
    }
    if (name && FIRMA.test(name) && !eigene(name) && name.length <= 80) {
      funde.push({ wert: { name, strasse: null, land: null, plz: null, ort: null }, text: '', herkunft: `Mit freundlichen Grüßen … ${name}` });
    }
  }
  // gleiche Firma (Briefkopf und Grußformel) nur einmal; die Fundstelle mit Anschrift gewinnt
  const versch: Fund<BelegAnschrift>[] = [];
  for (const f of funde) {
    const j = versch.findIndex((v) => gleich(v.wert.name) === gleich(f.wert.name));
    if (j < 0) versch.push(f); else if (!versch[j].wert.plz && f.wert.plz) versch[j] = f;
  }
  if (!versch.length) return fehlt('Im Beleg wurde kein Absender der Bestellung erkannt.');
  if (versch.length === 1) return eindeutig(versch[0].wert, versch[0].herkunft);
  hinweise.push(`Im Beleg stehen ${versch.length} verschiedene Firmen als Besteller: ${versch.map((v) => v.wert.name).join(' / ')}.`);
  return unklar(versch.map((v) => ({ wert: v.wert, text: anschriftText(v.wert), herkunft: kurz(v.herkunft) })),
    'Im Beleg stehen zwei Firmen (Briefkopf und Grußformel) – bitte den Auftraggeber wählen.');
}

/** Betrag hinter einer Beschriftung: in derselben Zeile oder allein in der nächsten nicht leeren Zeile */
function betragZu(zeilen: string[], label: RegExp, nurMitWert = false): Fund<number>[] {
  const erg: Fund<number>[] = [];
  zeilen.forEach((z, i) => {
    const rest = nachLabel(z, label);
    if (rest === null) return;
    let b = betraege(rest);
    let h = z.trim();
    if (!b.length && !rest && !nurMitWert) {
      const n = naechste(zeilen, i + 1);
      if (n >= 0 && nurBetrag(zeilen[n])) { b = betraege(zeilen[n]); h = `${z.trim()} ${zeilen[n].trim()}`; }
    }
    if (b.length === 1) erg.push({ wert: b[0], text: betragText(b[0]), herkunft: h });
  });
  return erg;
}

export function bestellungLesen(zeilen: string[]): BelegErkennung {
  const e = leereErkennung('bestellung', true);
  const stop = e.stops[0];
  const kopf = kopfLesen(zeilen);
  e.ordernummer = kopf.nr;
  e.kunde = kundeLesen(zeilen, e.hinweise);

  // Preis: Gesamtpreis (netto); weicht der Warenwert ab (Rabatt/Zuschlag), wird nachgefragt
  const gesamt = betragZu(zeilen, /Gesamtpreis(?:\s*\(?netto\)?)?/);
  const waren = betragZu(zeilen, /Warenwert/, true);
  const gesamtFeld = ausFunden(gesamt, 'Im Beleg stehen verschiedene Gesamtpreise.');
  const abweichend = waren.filter((w) => gesamt.length > 0 && gesamt.every((g) => g.wert !== w.wert));
  if (gesamtFeld.status === 'eindeutig' && !abweichend.length) e.frachtpreis_vk = gesamtFeld;
  else if (gesamt.length) e.frachtpreis_vk = ausFunden([...gesamt, ...abweichend], 'Gesamtpreis (netto) und Warenwert weichen voneinander ab.');
  else if (waren.length) e.frachtpreis_vk = ausFunden(waren, 'Im Beleg stehen verschiedene Warenwerte.', 'Der Gesamtpreis (netto) wurde nicht gelesen; im Beleg steht nur der Warenwert.');

  const text = zeilen.join('\n');
  const lm = lademeter(text);
  e.lademeter = ausFunden(lm.map((z) => ({ wert: z.wert, text: meterText(z.wert), herkunft: z.roh })), 'Im Beleg stehen verschiedene Lademeter.',
    lm.some((z) => !z.sicher) ? 'Die Lademeter-Angabe ist nicht eindeutig lesbar (Punkt als Tausender- oder Dezimalzeichen?).' : null);
  const gw = gewichte(text);
  e.gewicht = ausFunden(gw.map((g) => ({ wert: g.tonnen, text: tonnenText(g.tonnen), herkunft: g.roh })), 'Im Beleg stehen verschiedene Gewichte.',
    gw.some((g) => !g.sicher) ? 'Die Gewichtsangabe ist nicht eindeutig lesbar (Punkt als Tausender- oder Dezimalzeichen?).' : null);

  const ladenr: Fund[] = [];
  const ladetermin: { termin: Termin; herkunft: string }[] = [];
  const laden: Block[] = [];
  const liefern: Block[] = [];
  let kontakt: string | null = null;
  let zuletzt: 'laden' | 'liefern' | null = null;
  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i];
    let rest = nachLabel(z, /(?:Ladenr|Ladenummer|Lade-Nr)\.?/);
    if (rest) { const w = spalten(rest)[0]; if (w) ladenr.push({ wert: w, text: w, herkunft: z.trim() }); continue; }
    rest = nachLabel(z, /(?:Ladetermin|Ladedatum)/);
    if (rest) { const t = termine(rest)[0]; if (t) ladetermin.push({ termin: t, herkunft: z.trim() }); continue; }
    const art = nachLabel(z, LADESTELLE) !== null ? 'laden' : nachLabel(z, LIEFERADRESSE) !== null ? 'liefern' : null;
    if (art) {
      const erste = nachLabel(z, art === 'laden' ? LADESTELLE : LIEFERADRESSE);
      const { block } = blockLesen(zeilen, i + 1, BLOCK_ENDE, erste || null);
      if (block) { (art === 'laden' ? laden : liefern).push(block); zuletzt = art; }
      continue;
    }
    rest = nachLabel(z, /Kontakt/);
    if (rest && !kontakt) {
      const t = telefon(rest);
      if (t) kontakt = `${zuletzt === 'liefern' ? 'Kontakt Entladestelle' : zuletzt === 'laden' ? 'Kontakt Ladestelle' : 'Kontakt'}: ${t}`;
    }
  }
  bloeckeInStop(stop, '', laden, 'Ladestelle', e.hinweise);
  bloeckeInStop(stop, '_e', liefern, 'Lieferadresse', e.hinweise);
  const nr = ausFunden(ladenr, 'Im Beleg stehen verschiedene Ladenummern.');
  stop.ladenummer = nr.status === 'eindeutig' && nr.wert ? textFeld(nr.wert, nr.herkunft ?? nr.wert, MAX.ladenummer, 'Ladenummer', e.hinweise) : nr;
  const l = terminFelder(ladetermin, 'Ladetermin');
  stop.datum = l.datum;
  stop.zeit = l.zeit;
  e.leistungsdatum = l.datum.status === 'fehlt' ? fehlt() : { ...l.datum };
  const lt = terminFelder(kopf.liefertermin.map((f) => ({ termin: f.wert, herkunft: f.herkunft })), 'Liefertermin');
  if (kopf.lieferterminUnsicher && lt.datum.status !== 'fehlt') {
    stop.datum_e = unklar(kopf.liefertermin.map((f) => ({ wert: f.wert.datum, text: f.text, herkunft: kurz(f.herkunft) })), kopf.lieferterminUnsicher);
  } else { stop.datum_e = lt.datum; stop.zeit_e = lt.zeit; }

  const bes = [kontakt, kopf.lieferbedingung ? `Lieferbedingung: ${kopf.lieferbedingung}` : null].filter((x): x is string => !!x);
  if (bes.length) e.besonderheiten = eindeutig(bes.join('\n'), bes.join(' · '));
  return e;
}
