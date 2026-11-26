/**
 * Auftrag aus Beleg – Layout „allgemein“: Rückfall über Schlagworte für Belege ohne eigenes Layout.
 * Hier besonders streng: Übernommen wird nur, was im Beleg klar beschriftet ist („Ladestelle: …“, „Liefertermin: …“);
 * alles andere bleibt „fehlt“ und wird von Hand nachgetragen.
 */
import type { BelegAnschrift, BelegErkennung } from './typen.js';
import {
  MAX, anschrift, anschriftText, ausFunden, betraege, betragText, blockLesen, blockText, bloeckeInStop, fehlt, gewichte, gleich, kurz, lademeter, leereErkennung,
  meterText, nachLabel, naechste, nurBetrag, sauber, spalten, termine, terminFelder, textFeld, tonnenText, unklar,
  type Block, type Fund, type Termin,
} from './erkennung-helfer.js';

const ABSENDER = /Ladestelle|Beladestelle|Absender|Verladeadresse|Ladeadresse|Abholadresse|Abholstelle/;
const EMPFAENGER = /Adresse(?:\(n\)|n)?\s+Anlieferung(?:\(en\)|en)?|Lieferadresse|Lieferanschrift|Entladestelle|Empf[äa]nger|Anlieferadresse|Anlieferung|Entladeadresse/;
const KUNDE = /Auftraggeber(?:\s*\/\s*Frachtzahler)?|Frachtzahler/;
const LADETERMIN = /Ladetermin|Verladedatum|Ladedatum|Abholdatum|Abholtermin/;
const LIEFERTERMIN = /Liefertermin|Anlieferdatum|Entladedatum|Lieferdatum|Entladetermin/;
const PREIS = /Frachtrate|Frachtpreis|Fracht|Gesamtpreis(?:\s*\(?netto\)?)?/;
const LADENR = /Ladenr|Ladenummer|Lade-Nr|Ladereferenz/;
const ORDER = /(?:Bestell(?:ung)?|Auftrags?|Transport(?:auftrags?)?)\s?-?\s?(?:Nr|Nummer|No)\.?/;
const GEWICHT = /(?:Brutto|Gesamt|Lade)?gewicht/i;
/** Zeilen, an denen ein Anschriftblock sicher endet (jede bekannte Beschriftung) */
const ENDE = new RegExp(`^(?:${[ABSENDER, EMPFAENGER, KUNDE, LADETERMIN, LIEFERTERMIN, PREIS, LADENR, ORDER].map((r) => r.source).join('|')}|Kontakt|Gewicht|Lademeter|Mit\\s+freundlich)`, 'i');

export function allgemeinLesen(zeilen: string[]): BelegErkennung {
  const e = leereErkennung('allgemein', true);
  const stop = e.stops[0];
  const ab: Block[] = [], an: Block[] = [], kunde: Block[] = [];
  const laden: { termin: Termin; herkunft: string }[] = [], liefern: { termin: Termin; herkunft: string }[] = [];
  const preis: Fund<number>[] = [], ladenr: Fund[] = [], order: Fund[] = [];

  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i];
    const h = z.trim();
    let rest: string | null;
    if ((rest = nachLabel(z, ORDER))) { const m = /^([A-Z0-9][A-Z0-9\/._-]*)/i.exec(rest); if (m && /\d/.test(m[1])) order.push({ wert: m[1], text: m[1], herkunft: h }); continue; }
    if ((rest = nachLabel(z, LADETERMIN))) { const t = termine(rest)[0]; if (t) laden.push({ termin: t, herkunft: h }); continue; }
    if ((rest = nachLabel(z, LIEFERTERMIN))) { const t = termine(rest)[0]; if (t) liefern.push({ termin: t, herkunft: h }); continue; }
    if ((rest = nachLabel(z, LADENR))) { const w = spalten(rest)[0]; if (w && /\d/.test(w)) ladenr.push({ wert: w, text: w, herkunft: h }); continue; }
    // Anschriften nur mit Doppelpunkt hinter der Beschriftung (sonst träfe es Fließtext wie „Absender haftet …“)
    const art = [[ABSENDER, ab], [EMPFAENGER, an], [KUNDE, kunde]] as const;
    let anschriftZeile = false;
    for (const [re, ziel] of art) {
      rest = nachLabel(z, re);
      if (rest === null || !new RegExp(`(?:${re.source})\\s*:`, 'i').test(z)) continue;
      const { block } = blockLesen(zeilen, i + 1, ENDE, rest || null);
      if (block?.ort) ziel.push(block);
      anschriftZeile = true;
      break;
    }
    if (anschriftZeile) continue;
    if ((rest = nachLabel(z, PREIS)) !== null) {
      let b = betraege(rest);
      let her = h;
      if (!rest) { const n = naechste(zeilen, i + 1); if (n >= 0 && nurBetrag(zeilen[n])) { b = betraege(zeilen[n]); her = `${h} ${zeilen[n].trim()}`; } }
      if (b.length === 1) preis.push({ wert: b[0], text: betragText(b[0]), herkunft: her });
    }
  }

  bloeckeInStop(stop, '', ab, 'Ladestelle', e.hinweise);
  bloeckeInStop(stop, '_e', an, 'Lieferadresse', e.hinweise);
  const l = terminFelder(laden, 'Ladetermin');
  stop.datum = l.datum;
  stop.zeit = l.zeit;
  e.leistungsdatum = l.datum.status === 'fehlt' ? fehlt() : { ...l.datum };
  const lt = terminFelder(liefern, 'Liefertermin');
  stop.datum_e = lt.datum;
  stop.zeit_e = lt.zeit;
  const nr = ausFunden(ladenr, 'Im Beleg stehen verschiedene Ladenummern bzw. Referenzen.');
  stop.ladenummer = nr.status === 'eindeutig' && nr.wert ? textFeld(nr.wert, nr.herkunft ?? nr.wert, MAX.ladenummer, 'Ladenummer', e.hinweise) : nr;
  const o = ausFunden(order, 'Im Beleg stehen verschiedene Auftrags- bzw. Bestellnummern.');
  e.ordernummer = o.status === 'eindeutig' && o.wert ? textFeld(o.wert, o.herkunft ?? o.wert, MAX.ordernummer, 'Auftragsnummer', e.hinweise) : o;
  e.frachtpreis_vk = ausFunden(preis, 'Im Beleg stehen verschiedene Preise.');

  const text = zeilen.join('\n');
  // Gewicht: Kilogramm überall, Tonnen nur in einer Zeile mit dem Wort „Gewicht“
  const gw = zeilen.flatMap((z) => gewichte(z).filter((g) => /kg|kilo/i.test(g.roh) || GEWICHT.test(z)));
  e.gewicht = ausFunden(gw.map((g) => ({ wert: g.tonnen, text: tonnenText(g.tonnen), herkunft: g.roh })), 'Im Beleg stehen verschiedene Gewichte.',
    gw.some((g) => !g.sicher) ? 'Die Gewichtsangabe ist nicht eindeutig lesbar (Punkt als Tausender- oder Dezimalzeichen?).' : null);
  const lm = lademeter(text);
  e.lademeter = ausFunden(lm.map((z) => ({ wert: z.wert, text: meterText(z.wert), herkunft: z.roh })), 'Im Beleg stehen verschiedene Lademeter.',
    lm.some((z) => !z.sicher) ? 'Die Lademeter-Angabe ist nicht eindeutig lesbar.' : null);

  // Kunde nur, wenn der Beleg ihn ausdrücklich als Auftraggeber/Frachtzahler beschriftet
  const versch: Block[] = [];
  for (const b of kunde) if (!versch.some((v) => gleich(blockText(v)) === gleich(blockText(b)))) versch.push(b);
  if (versch.length === 1) e.kunde = { status: 'eindeutig', wert: anschrift(versch[0]), kandidaten: [], herkunft: kurz(blockText(versch[0])), hinweis: null };
  else if (versch.length > 1) {
    e.kunde = unklar(versch.map((b) => { const a: BelegAnschrift = anschrift(b); return { wert: a, text: anschriftText(a), herkunft: kurz(blockText(b)) }; }),
      'Im Beleg stehen mehrere Auftraggeber.');
  }
  if (!sauber(text)) e.hinweise.push('Der Beleg enthält keinen lesbaren Text.');
  return e;
}
