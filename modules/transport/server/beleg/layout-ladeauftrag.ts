/**
 * Auftrag aus Beleg – Layout „ladeauftrag“: „Transport <Nr.>“ / „Ladeauftrag“, Beschriftung links, Wert rechts.
 *
 * Zwei Formen desselben Belegs:
 *  - Zeilenform (pdftotext -layout): „Beschriftung:   Wert“ in einer Zeile, Folgezeilen des Wertes darunter.
 *  - Blockform (Texterkennung eines Bildes): erst alle Beschriftungen untereinander, danach alle Werte in derselben Reihenfolge.
 *    Die Werte werden dann der Reihe nach UND nach ihrer Art (Anschrift bis PLZ/Ort, Datum, Betrag, Gewicht) zugeordnet; passt
 *    ein Wert nicht zur erwarteten Art, endet die Zuordnung dort und der Rest bleibt „fehlt“.
 */
import type { BelegErkennung } from './typen.js';
import {
  MAX, anschrift, ausFunden, betraege, betragText, blockAus, blockInStop, blockText, eindeutig, fehlt, gewichte, kurz, lademeter, leereErkennung, leererStop,
  meterText, nachLabel, nurBetrag, nurTermin, plzOrt, sauber, spalten, termine, terminFelder, textFeld, tonnenText,
  type Block, type Fund, type Gewicht, type Termin,
} from './erkennung-helfer.js';

type Name = 'fuer' | 'auftraggeber' | 'verladeadresse' | 'verladedatum' | 'anlieferdatum' | 'anlieferung' | 'frachtrate' | 'gesamtgewicht' | 'lkwart' | 'sicherung' | 'info';
const LABEL: [Name, RegExp][] = [
  ['fuer', /Transport\s?-?\s?Auftrag\s+f[üu]r/],
  ['auftraggeber', /Auftraggeber(?:\s*\/\s*Frachtzahler)?|Frachtzahler/],
  ['verladeadresse', /Verladeadresse|Ladeadresse/],
  ['verladedatum', /Verladedatum|Ladedatum/],
  ['anlieferdatum', /Anlieferdatum|Lieferdatum/],
  ['anlieferung', /Adresse(?:\(n\)|n)?\s+Anlieferung(?:\(en\)|en)?|Anlieferadresse(?:\(n\)|n)?/],
  ['frachtrate', /Frachtrate|Frachtpreis/],
  ['gesamtgewicht', /Gesamtgewicht(?:\s+der\s+Tour)?/],
  ['lkwart', /LKW\s?-?\s?Art|Fahrzeugart/],
  ['sicherung', /Ladungssicherung/],
  ['info', /Info(?:rmation(?:en)?)?/],
];
/** Werte dieser Beschriftungen können über mehrere Zeilen gehen */
const MEHRZEILIG: Name[] = ['fuer', 'auftraggeber', 'verladeadresse', 'anlieferung', 'sicherung', 'info'];
const GRUSS = /^\s*Mit\s+(freundliche[nm]|beste[nm])\s+Gr[üu](ß|ss)en/i;
const BRUTTO = /Bruttogewicht/;
const TITEL = /^(Transport\s+(?:Nr\.?\s*:?\s*)?\d{4,}|Ladeauftrag\b)/i;
const WIE_AUFTRAGGEBER = /^wie\s+Auftraggeber\b/i;
const ERREICHBAR = /^(fax|tel|telefon|mobil|e-?mail|mail)\b|@/i;

/** Beschriftung am Anfang einer Zeile bzw. Spalte (nicht mitten im Fließtext) */
function labelIn(zeile: string): { name: Name; rest: string } | null {
  const t = zeile.trim();
  for (const [name, re] of LABEL) {
    if (!new RegExp(`^(?:${re.source})(?![\\p{L}\\p{N}])`, 'iu').test(t)) continue;
    // „Info“ nur mit Doppelpunkt (sonst träfe es Fließtext wie „Info an Fahrer …“)
    if (name === 'info' && !/^Info\S*\s*:/i.test(t)) continue;
    return { name, rest: nachLabel(t, re) ?? '' };
  }
  return null;
}

interface Gelesen { werte: Map<Name, string[]>; nachGruss: string[]; hinweise: string[] }

function lesen(zeilen: string[]): Gelesen {
  const werte = new Map<Name, string[]>();
  const hinweise: string[] = [];
  const iGruss = zeilen.findIndex((z) => GRUSS.test(z));
  const kopf = iGruss >= 0 ? zeilen.slice(0, iGruss) : zeilen;
  const nachGruss = iGruss >= 0 ? zeilen.slice(iGruss + 1).map(sauber).filter(Boolean) : [];
  const labels = kopf.map((z) => labelIn(z));

  // Blockform: mindestens drei Beschriftungen ohne Wert direkt untereinander (Leerzeilen zählen nicht)
  const lauf: { name: Name; i: number }[] = [];
  let bester: { name: Name; i: number }[] = [];
  kopf.forEach((z, i) => {
    const l = labels[i];
    if (!z.trim()) return;
    if (l && !l.rest && l.name !== 'info' && l.name !== 'sicherung') { lauf.push({ name: l.name, i }); if (lauf.length > bester.length) bester = [...lauf]; }
    else lauf.length = 0;
  });
  const block = bester.length >= 3 ? bester : [];
  const iBlockEnde = block.length ? block[block.length - 1].i : -1;
  const imBlock = new Set(block.map((b) => b.i));

  // Zeilenform: Wert hinter der Beschriftung, Folgezeilen bis zur nächsten Beschriftung
  const strom: string[] = [];
  let offen: Name | null = null;
  for (let i = 0; i < kopf.length; i++) {
    const z = kopf[i];
    if (!z.trim() || imBlock.has(i)) { if (imBlock.has(i)) offen = null; continue; }
    const l = labels[i];
    if (l) {
      offen = null;
      if (werte.has(l.name)) { hinweise.push(`Die Beschriftung „${sauber(z).slice(0, 40)}“ steht mehrfach im Beleg – nur die erste wurde gelesen.`); continue; }
      werte.set(l.name, l.rest ? [l.rest] : []);
      if (MEHRZEILIG.includes(l.name)) offen = l.name;
      continue;
    }
    const t = spalten(z)[0] ?? '';
    // Werteblock der Blockform: alles hinter den Beschriftungen, bis eine Beschriftung mit eigenem Wert folgt
    if (block.length && i > iBlockEnde && !offen) { if (!TITEL.test(t)) strom.push(sauber(z)); continue; }
    // Anschriften: nur die erste Spalte der Zeile; Freitext (Ladungssicherung, Info): die ganze Zeile
    if (offen) werte.get(offen)?.push(offen === 'sicherung' || offen === 'info' ? sauber(z) : t);
  }
  if (block.length) blockZuordnen(block.map((b) => b.name), strom, werte, hinweise);
  return { werte, nachGruss, hinweise };
}

/** Blockform: Werte der Reihe nach und nach ihrer Art den Beschriftungen zuordnen */
function blockZuordnen(namen: Name[], strom: string[], werte: Map<Name, string[]>, hinweise: string[]): void {
  let p = 0;
  const istWert = (z: string) => nurTermin(z) || nurBetrag(z) || WIE_AUFTRAGGEBER.test(z);
  // Hat die Texterkennung eine Beschriftung verschluckt, verschieben sich die Werte. Erkennbar an der Anzahl: Es muss genau so
  // viele Terminzeilen wie Terminbeschriftungen geben – sonst wird nichts zugeordnet (lieber leer als falsch).
  const terminNamen = namen.filter((n) => (n === 'verladedatum' || n === 'anlieferdatum') && !werte.has(n)).length;
  const terminZeilen = strom.filter((z) => nurTermin(z)).length;
  if (terminNamen !== terminZeilen) {
    hinweise.push(`Beschriftungen und Werte stehen im Beleg getrennt und passen nicht zusammen (${terminNamen} Terminbeschriftung(en), ${terminZeilen} Termin(e)) – Anschriften, Termine und Beträge wurden nicht zugeordnet, bitte von Hand ergänzen.`);
    return;
  }
  /** Anschrift: Zeilen bis einschließlich PLZ/Ort (höchstens fünf), keine Datums-/Betragszeilen */
  const anschriftZeilen = (): string[] | null => {
    const z: string[] = [];
    for (let k = p; k < strom.length && z.length < 5; k++) {
      // Telefon-/Fax-/Mailzeilen gehören nie in eine Anschrift: dann ist die Reihenfolge verrutscht
      if (istWert(strom[k]) || nachLabel(strom[k], BRUTTO) !== null || ERREICHBAR.test(strom[k])) return null;
      z.push(strom[k]);
      if (plzOrt(strom[k])) { if (z.length < 2) return null; p = k + 1; return z; }
    }
    return null;
  };
  for (let n = 0; n < namen.length; n++) {
    const name = namen[n];
    if (werte.has(name)) continue;
    let w: string[] | null = null;
    if (name === 'fuer' || name === 'auftraggeber') {
      w = anschriftZeilen();
      if (w && name === 'fuer') while (p < strom.length && ERREICHBAR.test(strom[p])) p++;
    } else if (name === 'verladeadresse') {
      if (p < strom.length && WIE_AUFTRAGGEBER.test(strom[p])) w = [strom[p++]]; else w = anschriftZeilen();
    } else if (name === 'verladedatum' || name === 'anlieferdatum') {
      if (p < strom.length && nurTermin(strom[p])) w = [strom[p++]];
    } else if (name === 'anlieferung') {
      w = anschriftZeilen();
      while (w && p < strom.length) {
        if (nachLabel(strom[p], BRUTTO) !== null) { w.push(strom[p++]); continue; }
        if (istWert(strom[p]) || gewichte(strom[p]).length) break;
        const weitere = anschriftZeilen();
        if (!weitere) break;
        w.push(...weitere);
      }
    } else if (name === 'frachtrate') {
      if (p < strom.length && nurBetrag(strom[p]) && /EUR|€/i.test(strom[p])) w = [strom[p++]];
    } else if (name === 'gesamtgewicht') {
      if (p < strom.length && gewichte(strom[p]).length === 1 && strom[p].length <= 20) w = [strom[p++]];
    } else if (name === 'lkwart') {
      if (p < strom.length && !istWert(strom[p]) && strom[p].length <= 60) w = [strom[p++]];
    }
    if (!w) {
      const offen = namen.slice(n).filter((x) => !werte.has(x)).length;
      hinweise.push(`Beschriftungen und Werte stehen im Beleg getrennt; ab „${LABEL_TEXT[name]}“ ließen sich ${offen === 1 ? 'der Wert' : `${offen} Werte`} nicht sicher zuordnen – bitte von Hand ergänzen.`);
      return;
    }
    werte.set(name, w);
  }
}
const LABEL_TEXT: Record<Name, string> = {
  fuer: 'Transport-Auftrag für', auftraggeber: 'Auftraggeber / Frachtzahler', verladeadresse: 'Verladeadresse', verladedatum: 'Verladedatum',
  anlieferdatum: 'Anlieferdatum', anlieferung: 'Adresse(n) Anlieferung(en)', frachtrate: 'Frachtrate', gesamtgewicht: 'Gesamtgewicht der Tour',
  lkwart: 'LKW-Art', sicherung: 'Ladungssicherung', info: 'Info',
};

export function ladeauftragLesen(zeilen: string[]): BelegErkennung {
  const e = leereErkennung('ladeauftrag', true);
  const stop = e.stops[0];
  const { werte, nachGruss, hinweise } = lesen(zeilen);
  e.hinweise.push(...hinweise);
  const w = (n: Name) => werte.get(n) ?? [];
  const h = (n: Name, wert: string) => `${LABEL_TEXT[n]}: ${wert}`;

  // Transportnummer aus dem Titel
  const nr: Fund[] = [];
  for (const z of zeilen) for (const m of z.matchAll(/(?<![\p{L}\p{N}-])Transport\s+(?:Nr\.?\s*:?\s*)?(\d{4,})(?![\p{L}\p{N}])/giu)) nr.push({ wert: m[1], text: m[1], herkunft: sauber(m[0]) });
  const o = ausFunden(nr, 'Im Beleg stehen verschiedene Transportnummern.');
  e.ordernummer = o.status === 'eindeutig' && o.wert ? textFeld(o.wert, o.herkunft ?? o.wert, MAX.ordernummer, 'Transportnummer', e.hinweise) : o;

  // Auftraggeber = Kunde
  // Die eigene Firma (Empfänger des Ladeauftrags) ist nie der Kunde – steht sie dort, ist die Zuordnung verrutscht
  const agRoh = blockAus(w('auftraggeber'));
  const eigene = !!agRoh && /euro\s?-?\s?flex/i.test(anschrift(agRoh).name);
  const ag = eigene ? null : agRoh;
  if (eigene) e.hinweise.push('Als Auftraggeber wurde die eigene Firma gelesen – der Auftraggeber ließ sich nicht sicher zuordnen, bitte von Hand wählen.');
  if (ag) e.kunde = eindeutig(anschrift(ag), h('auftraggeber', blockText(ag)));

  // Verladeadresse: eigener Anschriftblock oder „wie Auftraggeber“
  const vl = w('verladeadresse');
  if (vl.length && WIE_AUFTRAGGEBER.test(vl[0])) {
    if (ag) blockInStop(stop, '', ag, 'Verladeadresse', e.hinweise, `Verladeadresse: wie Auftraggeber (${blockText(ag)})`);
    else e.hinweise.push('Verladeadresse „wie Auftraggeber“, aber die Anschrift des Auftraggebers wurde nicht gelesen.');
  } else { const b = blockAus(vl); if (b) blockInStop(stop, '', b, 'Verladeadresse', e.hinweise); }

  // Termine: 00:00:00 = keine Zeitvorgabe
  const termin = (n: Name) => w(n).flatMap((z) => termine(z).slice(0, 1).map((t): { termin: Termin; herkunft: string } => ({ termin: t, herkunft: h(n, z) })));
  const laden = terminFelder(termin('verladedatum'), 'Verladedatum');
  stop.datum = laden.datum;
  stop.zeit = laden.zeit;
  e.leistungsdatum = laden.datum.status === 'fehlt' ? fehlt() : { ...laden.datum };
  const liefern = terminFelder(termin('anlieferdatum'), 'Anlieferdatum');
  stop.datum_e = liefern.datum;
  stop.zeit_e = liefern.zeit;

  // Anlieferadresse(n): je Anschrift bis PLZ/Ort, dahinter ggf. „Bruttogewicht: …“
  const gruppen: Block[] = [];
  const brutto: Gewicht[] = [];
  let offen: string[] = [];
  let rest = false;
  for (const z of w('anlieferung')) {
    const b = nachLabel(z, BRUTTO);
    if (b !== null) { brutto.push(...gewichte(b)); continue; }
    offen.push(z);
    if (plzOrt(z)) { const g = blockAus(offen); if (g) gruppen.push(g); offen = []; }
  }
  if (offen.length) { if (!gruppen.length) { const g = blockAus(offen); if (g) gruppen.push(g); } else rest = true; }
  if (gruppen[0]) blockInStop(stop, '_e', gruppen[0], 'Anlieferadresse', e.hinweise);
  if (gruppen[1]) {
    const s2 = leererStop();
    blockInStop(s2, '_e', gruppen[1], '2. Anlieferadresse', e.hinweise);
    e.stops.push(s2);
    e.hinweise.push('Im Beleg stehen mehrere Anlieferadressen – die zweite wurde als zweiter Stop übernommen; Termin und Ladestelle des zweiten Stops bitte prüfen.');
  }
  if (gruppen.length > 2) e.hinweise.push(`Im Beleg stehen ${gruppen.length} Anlieferadressen – übernommen wurden nur die ersten zwei: ${gruppen.slice(2).map(blockText).join(' / ')} fehlt.`);
  if (rest) e.hinweise.push(`Weitere Angaben zur Anlieferung ließen sich nicht zuordnen: ${kurz(offen.join(', '), 120)}`);

  // Frachtrate
  const preis = w('frachtrate').flatMap((z) => betraege(z).map((b): Fund<number> => ({ wert: b, text: betragText(b), herkunft: h('frachtrate', z) })));
  e.frachtpreis_vk = ausFunden(preis, 'Im Beleg stehen verschiedene Frachtraten.');
  if (!preis.length && w('frachtrate').length) e.frachtpreis_vk = fehlt(`Die Frachtrate „${kurz(w('frachtrate').join(' '), 40)}“ ist kein Eurobetrag – bitte von Hand eintragen.`);

  // Gewicht: Gesamtgewicht der Tour und Bruttogewicht(e) der Anlieferung(en) müssen übereinstimmen
  const gesamt = w('gesamtgewicht').flatMap((z) => gewichte(z));
  const funde: Fund<number>[] = gesamt.map((g) => ({ wert: g.tonnen, text: `${tonnenText(g.tonnen)} (Gesamtgewicht der Tour)`, herkunft: h('gesamtgewicht', g.roh) }));
  if (brutto.length) {
    const summe = Number(brutto.reduce((s, g) => s + g.tonnen, 0).toFixed(3));
    funde.push({ wert: summe, text: `${tonnenText(summe)} (Bruttogewicht${brutto.length > 1 ? `, Summe aus ${brutto.length} Anlieferungen` : ''})`, herkunft: `Bruttogewicht: ${brutto.map((g) => g.roh).join(' + ')}` });
  }
  e.gewicht = ausFunden(funde, 'Gesamtgewicht der Tour und Bruttogewicht weichen voneinander ab.',
    [...gesamt, ...brutto].some((g) => !g.sicher) ? 'Die Gewichtsangabe ist nicht eindeutig lesbar (Punkt als Tausender- oder Dezimalzeichen?).' : null);
  if (e.gewicht.status === 'eindeutig' && e.gewicht.wert !== null) e.gewicht.herkunft = kurz(funde.map((f) => f.herkunft).join(' · '));

  // Fahrzeug: Text der LKW-Art; die Zahl darin ist die Fahrzeuglänge, kein Lademeter
  const art = sauber(w('lkwart').join(' '));
  if (art) e.fahrzeugtyp = eindeutig(art, h('lkwart', art));
  const lm = lademeter(zeilen.join('\n'));
  e.lademeter = ausFunden(lm.map((z) => ({ wert: z.wert, text: meterText(z.wert), herkunft: z.roh })), 'Im Beleg stehen verschiedene Lademeter.',
    lm.some((z) => !z.sicher) ? 'Die Lademeter-Angabe ist nicht eindeutig lesbar.' : null);
  if (e.lademeter.status === 'fehlt' && /\d/.test(art)) e.lademeter.hinweis = 'Im Beleg stehen keine Lademeter; die Zahl in der LKW-Art ist die Fahrzeuglänge.';

  // Besonderheiten: Ladungssicherung, Info, Hinweis zur Anmeldung (Fußtext)
  const bes: string[] = [];
  const sicherung = sauber(w('sicherung').join(' '));
  if (sicherung) bes.push(`Ladungssicherung: ${sicherung}`);
  const info = sauber(w('info').join(' '));
  if (info) bes.push(`Info: ${info}`);
  const anmeldung = nachGruss.filter((z) => /anmeld/i.test(z));
  if (anmeldung.length) bes.push(anmeldung[0]);
  if (bes.length) e.besonderheiten = eindeutig(bes.join('\n'), bes.join(' · '));
  return e;
}
