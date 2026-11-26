/**
 * Auftrag aus Beleg: reine Helfer der Texterkennung (Felder, Zahlen, Datum, Anschriftblöcke). Ohne Datenbank, ohne Fremdpakete.
 *
 * Grundregel (siehe typen.ts): eindeutig gelesen → übernehmen; mehrere mögliche oder ein unsicherer Wert → „unklar“ mit
 * Kandidaten; nichts gefunden → „fehlt“. Es wird nie geraten.
 */
import type { BelegAnschrift, BelegErkennung, BelegLayout, BelegStop, Feld, Kandidat } from './typen.js';

/** Feldlängen der Erfassungsmaske */
export const MAX = { firma: 60, strasse: 60, plzort: 60, ladenummer: 30, zeit: 30, ordernummer: 40 } as const;

export const sauber = (s: string) => s.replace(/\s+/g, ' ').trim();
/** kurzer Textausschnitt für „herkunft“ */
export const kurz = (s: string, max = 80) => { const t = sauber(s); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
/** Vergleichsform: Kleinschrift ohne Umlaute, Akzente und Satzzeichen */
export const gleich = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ───────────────────────── Felder ─────────────────────────

export function fehlt<T = string>(hinweis: string | null = null): Feld<T> {
  return { status: 'fehlt', wert: null, kandidaten: [], herkunft: null, hinweis };
}
export function eindeutig<T = string>(wert: T, herkunft: string | null, hinweis: string | null = null): Feld<T> {
  return { status: 'eindeutig', wert, kandidaten: [], herkunft: herkunft === null ? null : kurz(herkunft), hinweis };
}
export function unklar<T = string>(kandidaten: Kandidat<T>[], hinweis: string): Feld<T> {
  return { status: 'unklar', wert: null, kandidaten, herkunft: null, hinweis };
}

/** Fundstelle eines Wertes im Beleg */
export interface Fund<T = string> { wert: T; text: string; herkunft: string }

/**
 * Aus allen Fundstellen ein Feld: keine → fehlt, alle gleich → eindeutig, verschiedene → unklar.
 * Unsichere Funde (z. B. Zahl ohne klares Dezimalzeichen) ergeben immer „unklar“.
 */
export function ausFunden<T>(funde: Fund<T>[], warumUnklar: string, unsicher: string | null = null): Feld<T> {
  const versch: Fund<T>[] = [];
  for (const f of funde) if (!versch.some((v) => JSON.stringify(v.wert) === JSON.stringify(f.wert))) versch.push(f);
  if (!versch.length) return fehlt<T>();
  const kandidaten = versch.map((f) => ({ wert: f.wert, text: f.text, herkunft: kurz(f.herkunft) }));
  if (unsicher) return unklar(kandidaten, unsicher);
  if (versch.length === 1) return eindeutig(versch[0].wert, versch[0].herkunft);
  return unklar(kandidaten, warumUnklar);
}

/** Text auf die Feldlänge der Maske kürzen; gekürzte Werte werden in den Hinweisen genannt */
export function textFeld(wert: string | null | undefined, herkunft: string, max: number, name: string, hinweise: string[]): Feld {
  const w = sauber(wert ?? '');
  if (!w) return fehlt();
  if (w.length <= max) return eindeutig(w, herkunft);
  hinweise.push(`${name} wurde auf ${max} Zeichen gekürzt (im Beleg: „${w}“).`);
  return eindeutig(w.slice(0, max).trim(), herkunft, `Auf ${max} Zeichen gekürzt – bitte prüfen.`);
}

export function leererStop(): BelegStop {
  return {
    firma: fehlt(), strasse: fehlt(), land: fehlt(), plzort: fehlt(), ladenummer: fehlt(), datum: fehlt(), zeit: fehlt(),
    firma_e: fehlt(), strasse_e: fehlt(), land_e: fehlt(), plzort_e: fehlt(), datum_e: fehlt(), zeit_e: fehlt(),
  };
}
export function leereErkennung(layout: BelegLayout, istFrachtauftrag = false): BelegErkennung {
  return {
    layout, istFrachtauftrag, kunde: fehlt<BelegAnschrift>(), ordernummer: fehlt(), leistungsdatum: fehlt(), frachtpreis_vk: fehlt<number>(),
    gewicht: fehlt<number>(), lademeter: fehlt<number>(), fahrzeugtyp: fehlt(), ladegut: fehlt(), ladeweise: fehlt(), palettentausch: fehlt(),
    besonderheiten: fehlt(), stops: [leererStop()], hinweise: [],
  };
}

// ───────────────────────── Zeilen ─────────────────────────

/** Text aus pdftotext/OCR vereinheitlichen: Zeilenenden, geschützte Leerzeichen, Tabulatoren, Seitenumbrüche */
export function zeilenAus(text: string): string[] {
  return text.slice(0, 60000).replace(/\r\n?/g, '\n').replace(/\f/g, '\n').replace(/[   ]/g, ' ').replace(/\t/g, '    ')
    .split('\n').map((z) => z.replace(/\s+$/, ''));
}
/** Spalten einer Zeile aus pdftotext -layout (mindestens drei Leerzeichen Abstand) */
export const spalten = (z: string) => z.trim().split(/\s{3,}/).map(sauber).filter(Boolean);

/**
 * Beschriftung in einer Zeile suchen (am Zeilenanfang oder nach Leerraum, nicht mitten im Wort) und den Rest der Zeile
 * dahinter liefern. null = Beschriftung steht nicht in der Zeile; '' = Beschriftung ohne Wert in derselben Zeile.
 */
export function nachLabel(zeile: string, label: RegExp): string | null {
  const re = new RegExp(`(?<![\\p{L}\\p{N}-])(?:${label.source})(?![\\p{L}\\p{N}])\\s*[.:]?`, 'iu');
  const m = re.exec(zeile);
  if (!m) return null;
  return sauber(zeile.slice(m.index + m[0].length).replace(/^[\s:.]+/, ''));
}
/** Nächste nicht leere Zeile ab Index (einschließlich) */
export function naechste(zeilen: string[], ab: number): number {
  for (let i = ab; i < zeilen.length; i++) if (zeilen[i].trim()) return i;
  return -1;
}

// ───────────────────────── Zahlen, Datum, Zeit ─────────────────────────

const ZAHL = '\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:,\\d+)?';
export interface Zahl { wert: number; /** false = „1.234“ ohne Komma: Tausenderpunkt oder Dezimalpunkt? */ sicher: boolean; roh: string }

/** Deutsche Zahl („1.275,00“, „18,250“, „6,2“) lesen */
export function zahl(roh: string): Zahl | null {
  const s = roh.trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return { wert: Number(s.replace(/\./g, '').replace(',', '.')), sicher: s.includes(','), roh: s };
  if (/^\d+(,\d+)?$/.test(s)) return { wert: Number(s.replace(',', '.')), sicher: true, roh: s };
  return null;
}
const runde = (n: number, stellen: number) => Number(n.toFixed(stellen));

/** Geldbeträge in Euro in einem Text („720,00 EUR“, „1.275,00 €“, „EUR 720,00“) */
export function betraege(text: string): number[] {
  const re = new RegExp(`(?<![\\d.,])(?:(?:EUR|€)\\s*(${ZAHL})(?![\\d.,])|(${ZAHL})\\s*(?:EUR\\b|€|Euro\\b))`, 'gi');
  const erg: number[] = [];
  for (const m of text.matchAll(re)) { const z = zahl(m[1] ?? m[2]); if (z) erg.push(runde(z.wert, 2)); }
  return erg;
}
export const betragText = (v: number) => `${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')} EUR`;
/** Zeile, die nur aus einem Eurobetrag besteht */
export const nurBetrag = (z: string) => new RegExp(`^(?:(?:EUR|€)\\s*)?(?:${ZAHL})\\s*(?:EUR|€|Euro)?$`, 'i').test(z.trim()) && betraege(z).length === 1;

export interface Gewicht { tonnen: number; sicher: boolean; roh: string }
/** Gewichtsangaben („900 kg“, „18,250 TO“, „24 t“) in Tonnen. Tonnen nur mit Einheit TO/to/t/Tonnen direkt hinter der Zahl. */
export function gewichte(text: string): Gewicht[] {
  const re = new RegExp(`(?<![\\d.,\\p{L}])(${ZAHL})\\s*(kg|kilo(?:gramm)?|to(?:nnen?)?|t)(?![\\p{L}\\d])`, 'giu');
  const erg: Gewicht[] = [];
  for (const m of text.matchAll(re)) {
    const z = zahl(m[1]);
    if (!z) continue;
    const kg = /^k/i.test(m[2]);
    // „1.200 kg“ ist ein Tausenderpunkt; „18.250 TO“ kann 18,250 t oder 18250 t bedeuten → unsicher
    erg.push({ tonnen: runde(kg ? z.wert / 1000 : z.wert, 3), sicher: kg || z.sicher, roh: sauber(m[0]) });
  }
  return erg;
}
export const tonnenText = (t: number) => `${String(t).replace('.', ',')} t`;

/** Lademeter („6,2 LM“, „13,6 Lademeter“, „LDM 6,2“, „Lademeter: 6,2“) */
export function lademeter(text: string): Zahl[] {
  const re = new RegExp(`(?<![\\d.,\\p{L}])(?:(${ZAHL})\\s*(?:ldm|lm|lademeter)(?![\\p{L}\\d])|(?:ldm|lm|lademeter)\\s*[.:]?\\s*(${ZAHL})(?![\\d.,]))`, 'giu');
  const erg: Zahl[] = [];
  for (const m of text.matchAll(re)) { const z = zahl(m[1] ?? m[2]); if (z) erg.push({ ...z, roh: sauber(m[0]) }); }
  return erg;
}
export const meterText = (m: number) => `${String(m).replace('.', ',')} m`;

export interface Termin { datum: string; /** HH:MM; null = keine Zeitvorgabe (auch 00:00) */ zeit: string | null; roh: string }
const DATUM = /(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?![\d])(?:\s*,?\s*(?:um\s*)?(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?(?:\s*Uhr)?(?![\d]))?/g;

/** Alle Datumsangaben TT.MM.JJJJ / TT.MM.JJ (optional mit Uhrzeit) eines Textes; ungültige Daten werden übergangen */
export function termine(text: string): Termin[] {
  const erg: Termin[] = [];
  for (const m of text.matchAll(DATUM)) {
    const t = Number(m[1]), mo = Number(m[2]);
    const j = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(j, mo - 1, t));
    if (mo < 1 || mo > 12 || t < 1 || d.getUTCDate() !== t || j < 2000 || j > 2099) continue;
    let zeit: string | null = null;
    if (m[4] !== undefined) {
      const h = Number(m[4]), min = Number(m[5]);
      if (h <= 23 && min <= 59 && (h !== 0 || min !== 0)) zeit = `${String(h).padStart(2, '0')}:${m[5]}`;
    }
    erg.push({ datum: `${j}-${String(mo).padStart(2, '0')}-${String(t).padStart(2, '0')}`, zeit, roh: sauber(m[0]) });
  }
  return erg;
}
export const datumText = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
/** Zeile, die nur aus einem Datum (ggf. mit Uhrzeit) besteht */
export const nurTermin = (z: string) => { const t = termine(z); return t.length === 1 && t[0].roh.length >= sauber(z).length - 1; };

/** Datum und Zeit eines Stops aus den Fundstellen einer Beschriftung */
export function terminFelder(funde: { termin: Termin; herkunft: string }[], name: string): { datum: Feld; zeit: Feld } {
  const datum = ausFunden(funde.map((f) => ({ wert: f.termin.datum, text: datumText(f.termin.datum), herkunft: f.herkunft })),
    `Im Beleg stehen verschiedene Angaben zum ${name}.`);
  if (datum.status !== 'eindeutig') return { datum, zeit: fehlt() };
  const zeit = ausFunden(funde.filter((f) => f.termin.zeit).map((f) => ({ wert: f.termin.zeit!, text: `${f.termin.zeit} Uhr`, herkunft: f.herkunft })),
    `Im Beleg stehen verschiedene Uhrzeiten zum ${name}.`);
  return { datum, zeit };
}

// ───────────────────────── Anschriften ─────────────────────────

/** Länderkennzeichen vor der Postleitzahl → ISO 3166-1 alpha-2 (wie stops.land im Portal) */
const LAND_KURZ: Record<string, string> = {
  D: 'DE', DE: 'DE', A: 'AT', AT: 'AT', CH: 'CH', F: 'FR', FR: 'FR', L: 'LU', LU: 'LU', B: 'BE', BE: 'BE', NL: 'NL', I: 'IT', IT: 'IT', PL: 'PL',
  CZ: 'CZ', DK: 'DK', E: 'ES', ES: 'ES', H: 'HU', HU: 'HU', SK: 'SK', SI: 'SI', SLO: 'SI', HR: 'HR', RO: 'RO', BG: 'BG', S: 'SE', SE: 'SE', P: 'PT', PT: 'PT',
  FL: 'LI', LI: 'LI', GR: 'GR', LT: 'LT', LV: 'LV', EE: 'EE', FI: 'FI', FIN: 'FI', N: 'NO', NO: 'NO', IE: 'IE', IRL: 'IE', GB: 'GB', UK: 'GB',
};
const PLZ_ORT = /^(?:([A-Z]{1,3})\s?[-–—]\s?)?(\d{5}|\d{4}\s?[A-Z]{2}(?=\s)|\d{2}-\d{3}|\d{4})\s+(\p{L}[\p{L}\p{M}\d .,'’()\/-]*)$/u;
export const FIRMA = /(?<![\p{L}\p{N}])(gmbh|mbh|ag|kg|ohg|ug|gbr|se|e\.\s?k\.|e\.\s?v\.|eg|kgaa|ltd\.?|limited|inc\.?|llc|b\.\s?v\.|n\.\s?v\.|s\.\s?a\.|s\.\s?a\.\s?r\.\s?l\.|sarl|sas|s\.\s?r\.\s?l\.|s\.\s?p\.\s?a\.|sp\.\s?z\s?o\.\s?o\.|s\.\s?r\.\s?o\.|a\.\s?s\.|aps|a\/s|ab|oy|d\.\s?o\.\s?o\.|kft|srl|bvba|nv)(?=$|[\s,.)&])/iu;

export interface PlzOrt { land: string | null; landPraefix: string | null; plz: string; ort: string }
export function plzOrt(zeile: string): PlzOrt | null {
  const m = PLZ_ORT.exec(sauber(zeile).replace(/[,;]+$/, ''));
  if (!m) return null;
  // „1275 Wien“ ja, aber keine Mengen- oder Preiszeilen
  if (/\b(EUR|kg|TO|St|Stk|LM)\b/.test(m[3])) return null;
  const p = m[1] ?? null;
  return { land: p ? LAND_KURZ[p] ?? null : null, landPraefix: p, plz: sauber(m[2]), ort: sauber(m[3]) };
}

/** Anschriftblock aus dem Beleg: Zeilen bis einschließlich „PLZ Ort“ */
export interface Block { name: string; zusatz: string[]; strasse: string | null; ort: PlzOrt | null; zeilen: string[] }

/** Zeilen (ohne Leerzeilen) zu einer Anschrift: erste Zeile Firma, letzte vor PLZ/Ort die Straße, dazwischen Namenszusätze */
export function blockAus(roh: string[]): Block | null {
  const z = roh.map(sauber).filter(Boolean);
  if (!z.length) return null;
  const iOrt = z.findIndex((x) => plzOrt(x));
  if (iOrt === 0) return null;
  if (iOrt < 0) return { name: z[0], zusatz: [], strasse: null, ort: null, zeilen: z.slice(0, 1) };
  const ort = plzOrt(z[iOrt]);
  const strasse = iOrt >= 2 ? z[iOrt - 1] : null;
  return { name: z[0], zusatz: z.slice(1, Math.max(1, iOrt - 1)), strasse, ort, zeilen: z.slice(0, iOrt + 1) };
}
export const blockText = (b: Block) => b.zeilen.join(', ');
export function anschrift(b: Block): BelegAnschrift {
  return { name: [b.name, ...b.zusatz].join(', '), strasse: b.strasse, land: b.ort?.land ?? null, plz: b.ort?.plz ?? null, ort: b.ort?.ort ?? null };
}
export const anschriftText = (a: BelegAnschrift) => [a.name, a.strasse, sauber(`${a.plz ?? ''} ${a.ort ?? ''}`)].filter(Boolean).join(', ');

/**
 * Land eines Stops: mit Länderkennzeichen vor der PLZ eindeutig. Ohne Kennzeichen wird nicht geraten – eine fünfstellige PLZ
 * (bzw. die niederländische/polnische Schreibweise) ergibt nur einen Vorschlag zum Bestätigen.
 */
export function landFeld(o: PlzOrt | null, herkunft: string): Feld {
  if (!o) return fehlt();
  if (o.land) return eindeutig(o.land, herkunft);
  if (o.landPraefix) return fehlt(`Länderkennzeichen „${o.landPraefix}“ ist nicht bekannt – bitte das Land eintragen.`);
  const vermutet = /^\d{5}$/.test(o.plz) ? 'DE' : /^\d{4}\s?[A-Z]{2}$/.test(o.plz) ? 'NL' : /^\d{2}-\d{3}$/.test(o.plz) ? 'PL' : null;
  if (!vermutet) return fehlt('Im Beleg steht kein Länderkennzeichen vor der Postleitzahl.');
  return unklar([{ wert: vermutet, text: vermutet, herkunft: kurz(herkunft) }],
    `Im Beleg steht kein Länderkennzeichen; ${vermutet} ist nur aus der Schreibweise der Postleitzahl vermutet.`);
}

type Seite = '' | '_e';
/** Anschriftblock in die Felder eines Stops schreiben (Absender oder Empfänger) */
export function blockInStop(stop: BelegStop, seite: Seite, b: Block, name: string, hinweise: string[], herkunft: string | null = null): void {
  const h = herkunft ?? blockText(b);
  const firma = textFeld([b.name, ...b.zusatz].join(', '), h, MAX.firma, `${name}: Firma`, hinweise);
  const strasse = b.strasse ? textFeld(b.strasse, h, MAX.strasse, `${name}: Straße`, hinweise) : fehlt();
  const plzort = b.ort ? textFeld(`${b.ort.plz} ${b.ort.ort}`, h, MAX.plzort, `${name}: PLZ/Ort`, hinweise) : fehlt();
  const land = landFeld(b.ort, h);
  if (seite === '') { stop.firma = firma; stop.strasse = strasse; stop.plzort = plzort; stop.land = land; }
  else { stop.firma_e = firma; stop.strasse_e = strasse; stop.plzort_e = plzort; stop.land_e = land; }
  if (!b.ort) hinweise.push(`${name}: Im Beleg wurde keine Zeile mit Postleitzahl und Ort gefunden.`);
}

/**
 * Mehrere Fundstellen derselben Anschrift: gleiche → in den Stop; verschiedene → alle vier Felder „unklar“ mit Kandidaten.
 */
export function bloeckeInStop(stop: BelegStop, seite: Seite, bloecke: Block[], name: string, hinweise: string[]): void {
  const versch: Block[] = [];
  for (const b of bloecke) if (!versch.some((v) => gleich(blockText(v)) === gleich(blockText(b)))) versch.push(b);
  if (!versch.length) return;
  if (versch.length === 1) { blockInStop(stop, seite, versch[0], name, hinweise); return; }
  const warum = `Im Beleg stehen ${versch.length} verschiedene Anschriften für „${name}“.`;
  const k = (f: (b: Block) => string | null): Feld => {
    const kand = versch.map((b) => ({ wert: f(b), herkunft: kurz(blockText(b)) })).filter((x): x is { wert: string; herkunft: string } => !!x.wert);
    return kand.length ? unklar(kand.map((x) => ({ wert: x.wert, text: x.wert, herkunft: x.herkunft })), warum) : fehlt();
  };
  const firma = k((b) => [b.name, ...b.zusatz].join(', ').slice(0, MAX.firma));
  const strasse = k((b) => b.strasse?.slice(0, MAX.strasse) ?? null);
  const plzort = k((b) => (b.ort ? `${b.ort.plz} ${b.ort.ort}`.slice(0, MAX.plzort) : null));
  const land = k((b) => b.ort?.land ?? null);
  if (seite === '') { stop.firma = firma; stop.strasse = strasse; stop.plzort = plzort; stop.land = land; }
  else { stop.firma_e = firma; stop.strasse_e = strasse; stop.plzort_e = plzort; stop.land_e = land; }
  hinweise.push(warum);
}

/**
 * Anschriftblock ab einer Zeile lesen: bis einschließlich der Zeile mit PLZ/Ort, höchstens `max` Zeilen; Leerzeilen innerhalb
 * werden übergangen (OCR), vor einer Zeile aus `ende` (nächste Beschriftung) ist Schluss. Liefert auch die Zeile danach.
 */
export function blockLesen(zeilen: string[], ab: number, ende: RegExp, erste: string | null = null, max = 5): { block: Block | null; weiter: number } {
  const z: string[] = erste ? [erste] : [];
  let i = ab;
  let leer = 0;
  for (; i < zeilen.length && z.length < max; i++) {
    const t = spalten(zeilen[i])[0] ?? '';
    if (!t) { if (z.length && ++leer > 2) break; continue; }
    if (ende.test(t) || /^[^:]{2,40}:\s*$/.test(t) && !plzOrt(t)) break;
    leer = 0;
    z.push(t);
    if (plzOrt(t)) { i++; break; }
  }
  return { block: blockAus(z), weiter: i };
}

/** Telefonnummer aus einem Wert („+49 6851 1234-56“) */
export function telefon(s: string): string | null {
  const m = /\+?\d[\d\s()\/.-]{5,24}\d/.exec(s);
  return m && m[0].replace(/\D/g, '').length >= 6 ? sauber(m[0]) : null;
}

/**
 * Genug Merkmale eines Frachtauftrags? Layout „allgemein“ (streng): mindestens eine Lade- oder Lieferanschrift UND Preis oder Termin.
 * Die eigenen Layouts sind schon an ihren Beschriftungen erkannt; dort genügt, dass überhaupt Anschrift, Preis oder Termin gelesen wurde.
 */
export function genugMerkmale(e: BelegErkennung): boolean {
  const da = (f: Feld<unknown>) => f.status !== 'fehlt';
  const s = e.stops[0];
  const adresse = !!s && [s.firma, s.plzort, s.firma_e, s.plzort_e].some(da);
  const preisOderTermin = da(e.frachtpreis_vk) || (!!s && (da(s.datum) || da(s.datum_e)));
  return e.layout === 'allgemein' ? adresse && preisOderTermin : adresse || preisOderTermin;
}
