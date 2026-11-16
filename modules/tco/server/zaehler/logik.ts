/**
 * Zählerstände (Bereich Instandhaltung): reine Rechenregeln ohne Datenbank – Verbrauch, Verteilung auf Monate/Jahre,
 * Kennzahlen, Plausibilitätsprüfung einer Ablesung sowie CSV lesen und schreiben. Getestet in server/test/tco_zaehler.test.ts.
 *
 * Grundsätze:
 *  - Ein Stand gilt zu Beginn seines Tages. Der Abschnitt zwischen zwei aufeinanderfolgenden Ständen deckt also die Tage
 *    [Datum a, Datum b) ab – Ablesungen jeweils am Monatsersten ergeben genau den Monatsverbrauch.
 *  - Verbrauch eines Abschnitts = (b − a) × Faktor. Ist b ein EINBAU (Zählerwechsel), beginnt ein neuer Zähler: kein Verbrauch.
 *    Ist b kleiner als a und die Stellenzahl des Zählwerks bekannt, wird ein Überlauf (999999 → 000000) angenommen, wenn
 *    der übergelaufene Verbrauch höchstens ein Zehntel des Zählbereichs ausmacht.
 *  - Für Monate/Jahre wird jeder Abschnitt gleichmäßig auf seine Tage verteilt (lineare Interpolation). Perioden ohne
 *    Abdeckung durch einen Abschnitt haben keinen Wert (null), teilweise abgedeckte den anteiligen.
 *  - Der Stichtag wird immer übergeben (nicht „heute“ im Code) – so sind Kennzahlen und Prüfung testbar.
 */
import type { Kennzahlen, Pruefung, StandArt, ZaehlerStamm } from '../../web/zaehler/typen.js';

export const STAND_ARTEN_KEYS = ['ABLESUNG', 'SCHAETZUNG', 'AUSBAU', 'EINBAU'] as const satisfies readonly StandArt[];
export const MEDIEN_KEYS = ['STROM', 'GAS', 'WASSER', 'WAERME', 'PV', 'OEL', 'SONSTIGES'] as const;

/** ein Zählerstand für die Berechnung */
export interface Stand { id?: number; datum: string; stand: number; art: StandArt }
/** was die Berechnung vom Zähler braucht */
export type ZaehlerRechnen = Pick<ZaehlerStamm, 'faktor' | 'stellen'>;

/** Abschnitt zwischen zwei aufeinanderfolgenden Ständen */
export interface Abschnitt { von: Stand; bis: Stand; tage: number; verbrauch: number | null }

// ---------------------------------------------------------------- Datum

const TAG = 86_400_000;
/** Tagesnummer (Tage seit 1970-01-01, UTC) */
export const tagNr = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / TAG);
export const isoAus = (nr: number) => new Date(nr * TAG).toISOString().slice(0, 10);
export const tageZwischen = (a: string, b: string) => tagNr(b) - tagNr(a);
export const plusTage = (iso: string, n: number) => isoAus(tagNr(iso) + n);
/** gültiges Kalenderdatum JJJJ-MM-TT? */
export function datumGueltig(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  return isoAus(tagNr(iso)) === iso;
}
const dat = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export const r3 = (v: number) => Math.round((v + Number.EPSILON) * 1000) / 1000;
export const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
/** deutsches Zahlenformat ohne Tausenderpunkte (für Texte und CSV) */
export const zahlDe = (v: number, nk = 3) => String(Number(v.toFixed(nk))).replace('.', ',');

// ---------------------------------------------------------------- Verbrauch

/** Rang innerhalb eines Tages: Ablesung/Schätzung, dann Ausbau, dann Einbau */
const RANG: Record<StandArt, number> = { ABLESUNG: 0, SCHAETZUNG: 0, AUSBAU: 1, EINBAU: 2 };
export function sortieren<T extends Stand>(staende: T[]): T[] {
  return [...staende].sort((a, b) => a.datum.localeCompare(b.datum) || RANG[a.art] - RANG[b.art] || (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
}

/** Überlauf des Zählwerks plausibel? (b < a, beide im Zählbereich, übergelaufener Verbrauch ≤ 10 % des Bereichs) */
export function ueberlaufMoeglich(a: number, b: number, stellen: number | null): boolean {
  if (!stellen || b >= a) return false;
  const bereich = 10 ** stellen;
  if (a >= bereich || b < 0) return false;
  return b + bereich - a <= bereich / 10;
}

/** Verbrauch zwischen zwei aufeinanderfolgenden Ständen (× Faktor); null, wenn b ein Einbau ist (neuer Zähler) */
export function abschnittVerbrauch(a: Stand, b: Stand, z: ZaehlerRechnen): number | null {
  if (b.art === 'EINBAU') return null;
  let diff = b.stand - a.stand;
  if (diff < 0 && ueberlaufMoeglich(a.stand, b.stand, z.stellen)) diff += 10 ** z.stellen!;
  return r3(diff * z.faktor);
}

/** alle Abschnitte in zeitlicher Reihenfolge (die Stände werden sortiert) */
export function abschnitte(staende: Stand[], z: ZaehlerRechnen): Abschnitt[] {
  const s = sortieren(staende);
  const out: Abschnitt[] = [];
  for (let i = 1; i < s.length; i++) {
    out.push({ von: s[i - 1], bis: s[i], tage: tageZwischen(s[i - 1].datum, s[i].datum), verbrauch: abschnittVerbrauch(s[i - 1], s[i], z) });
  }
  return out;
}

/** Verbrauch und Ø je Tag seit dem vorigen Stand – für die Liste der Stände (gleiche Reihenfolge wie sortieren) */
export function mitVerbrauch<T extends Stand>(staende: T[], z: ZaehlerRechnen): (T & { verbrauch: number | null; tagesverbrauch: number | null })[] {
  const s = sortieren(staende);
  return s.map((x, i) => {
    const v = i ? abschnittVerbrauch(s[i - 1], x, z) : null;
    const t = i ? tageZwischen(s[i - 1].datum, x.datum) : 0;
    return { ...x, verbrauch: v, tagesverbrauch: v != null && t > 0 ? r3(v / t) : null };
  });
}

// ---------------------------------------------------------------- Verteilung auf Perioden

export type Raster = 'monat' | 'jahr';
const periodeVon = (nr: number, raster: Raster) => (raster === 'jahr' ? isoAus(nr).slice(0, 4) : isoAus(nr).slice(0, 7));
/** erster Tag der nächsten Periode nach dem Tag nr */
function naechstePeriode(nr: number, raster: Raster): number {
  const d = isoAus(nr);
  const j = +d.slice(0, 4), m = +d.slice(5, 7);
  return raster === 'jahr' ? Math.round(Date.UTC(j + 1, 0, 1) / TAG) : Math.round(Date.UTC(j, m, 1) / TAG);
}

/**
 * Verbrauch je Periode (YYYY-MM bzw. YYYY): jeder Abschnitt gleichmäßig auf seine Tage [von, bis) verteilt. Ein Abschnitt
 * ohne Tage (zwei Stände am selben Tag) zählt ganz zu diesem Tag. In der Map stehen nur abgedeckte Perioden.
 */
export function verteilen(ab: Abschnitt[], raster: Raster): Map<string, number> {
  const out = new Map<string, number>();
  const add = (p: string, v: number) => out.set(p, (out.get(p) ?? 0) + v);
  for (const a of ab) {
    if (a.verbrauch == null) continue;
    const s = tagNr(a.von.datum), e = tagNr(a.bis.datum);
    if (e <= s) { add(periodeVon(s, raster), a.verbrauch); continue; }
    const jeTag = a.verbrauch / (e - s);
    for (let cur = s; cur < e;) {
      const ende = Math.min(naechstePeriode(cur, raster), e);
      add(periodeVon(cur, raster), jeTag * (ende - cur));
      cur = ende;
    }
  }
  for (const [k, v] of out) out.set(k, r3(v));
  return out;
}

/** Perioden von … bis (einschließlich): YYYY-MM bzw. YYYY */
export function perioden(von: string, bis: string, raster: Raster): string[] {
  const out: string[] = [];
  if (raster === 'jahr') {
    for (let j = +von.slice(0, 4); j <= +bis.slice(0, 4); j++) out.push(String(j));
    return out;
  }
  let j = +von.slice(0, 4), m = +von.slice(5, 7);
  const ende = +bis.slice(0, 4) * 12 + +bis.slice(5, 7);
  while (j * 12 + m <= ende) {
    out.push(`${j}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; j++; }
  }
  return out;
}

/** Verbrauch je Periode als Reihe (null = keine Daten) */
export function reihe(staende: Stand[], z: ZaehlerRechnen, liste: string[], raster: Raster): (number | null)[] {
  const v = verteilen(abschnitte(staende, z), raster);
  return liste.map((p) => (v.has(p) ? v.get(p)! : null));
}

/** Verbrauch und abgedeckte Tage im Zeitraum [von, bis) (Tagesnummern) */
function imFenster(ab: Abschnitt[], von: number, bis: number): { summe: number; tage: number; abgedeckt: boolean } {
  let summe = 0, tage = 0, abgedeckt = false;
  for (const a of ab) {
    if (a.verbrauch == null) continue;
    const s = tagNr(a.von.datum), e = tagNr(a.bis.datum);
    if (e <= s) { if (s >= von && s < bis) { summe += a.verbrauch; abgedeckt = true; } continue; }
    const lo = Math.max(s, von), hi = Math.min(e, bis);
    if (hi <= lo) continue;
    summe += (a.verbrauch / (e - s)) * (hi - lo);
    tage += hi - lo;
    abgedeckt = true;
  }
  return { summe, tage, abgedeckt };
}

/** Ø Verbrauch je Tag der letzten 365 Tage bis zum letzten Stand (bzw. seit dem ersten); null ohne abgedeckte Tage */
export function tagesdurchschnitt(staende: Stand[], z: ZaehlerRechnen): number | null {
  const ab = abschnitte(staende, z);
  if (!ab.length) return null;
  const ende = tagNr(ab[ab.length - 1].bis.datum);
  const f = imFenster(ab, ende - 365, ende);
  return f.tage > 0 ? r3(f.summe / f.tage) : null;
}

// ---------------------------------------------------------------- Kennzahlen

type ZaehlerKennzahlen = Pick<ZaehlerStamm, 'faktor' | 'stellen' | 'intervall_tage' | 'arbeitspreis' | 'grundpreis_monat' | 'jahresziel' | 'aktiv'>;

/** Kennzahlen eines Zählers zum Stichtag (YYYY-MM-DD) */
export function kennzahlen(z: ZaehlerKennzahlen, staende: Stand[], stichtag: string): Kennzahlen {
  const s = sortieren(staende);
  const letzte = s.length ? s[s.length - 1] : null;
  const faelligAm = letzte && z.intervall_tage ? plusTage(letzte.datum, z.intervall_tage) : null;
  const ab = abschnitte(s, z);
  const td = tagesdurchschnitt(s, z);
  const jahr = +stichtag.slice(0, 4);
  const jahrAnfang = tagNr(`${jahr}-01-01`), jahrEnde = tagNr(`${jahr + 1}-01-01`);
  const lfd = imFenster(ab, jahrAnfang, jahrEnde);
  const vj = imFenster(ab, tagNr(`${jahr - 1}-01-01`), jahrAnfang);
  const verbrauchJahr = lfd.abgedeckt ? r3(lfd.summe) : null;
  const verbrauchVorjahr = vj.abgedeckt ? r3(vj.summe) : null;

  // Hochrechnung: Ist bis zur letzten Ablesung + Ø je Tag × verbleibende Tage bis 31.12.
  let prognoseJahr: number | null = null;
  if (td != null && letzte) {
    const ab0 = Math.min(Math.max(tagNr(letzte.datum), jahrAnfang), jahrEnde);
    prognoseJahr = r3((verbrauchJahr ?? 0) + td * (jahrEnde - ab0));
  }
  const ohnePreis = z.arbeitspreis == null && z.grundpreis_monat == null;
  const kostenPrognoseJahr = ohnePreis || prognoseJahr == null ? null : r2((z.arbeitspreis ?? 0) * prognoseJahr + 12 * (z.grundpreis_monat ?? 0));
  const veraenderungProzent = prognoseJahr != null && verbrauchVorjahr ? Math.round(((prognoseJahr - verbrauchVorjahr) / verbrauchVorjahr) * 1000) / 10 : null;
  return {
    letzteAblesung: letzte ? { datum: letzte.datum, stand: letzte.stand } : null,
    faelligAm,
    ueberfaellig: !!(z.aktiv && faelligAm && faelligAm < stichtag),
    tagesdurchschnitt: td,
    verbrauchJahr, verbrauchVorjahr, prognoseJahr, kostenPrognoseJahr, veraenderungProzent,
    zielUeberschritten: z.jahresziel != null && prognoseJahr != null && prognoseJahr > z.jahresziel,
  };
}

/** Monatsverbrauch der letzten 12 vollen Monate vor dem Monat des Stichtags (ältester zuerst; ohne Daten 0) */
export function verlauf12(staende: Stand[], z: ZaehlerRechnen, stichtag: string): number[] {
  const bis = isoAus(tagNr(`${stichtag.slice(0, 7)}-01`) - 1).slice(0, 7);
  const j = +bis.slice(0, 4), m = +bis.slice(5, 7);
  const von = m === 12 ? `${j}-01` : `${j - 1}-${String(m + 1).padStart(2, '0')}`;
  return reihe(staende, z, perioden(von, bis, 'monat'), 'monat').map((v) => v ?? 0);
}

/** Monatsverbrauch je Kalenderjahr – bis zu 5 Jahre mit Daten, neuestes zuletzt */
export function jahresvergleich(staende: Stand[], z: ZaehlerRechnen, anzahl = 5): { jahr: number; monate: (number | null)[]; summe: number }[] {
  const v = verteilen(abschnitte(staende, z), 'monat');
  const jahre = [...new Set([...v.keys()].map((k) => +k.slice(0, 4)))].sort((a, b) => a - b).slice(-anzahl);
  return jahre.map((jahr) => {
    const monate = Array.from({ length: 12 }, (_, i) => v.get(`${jahr}-${String(i + 1).padStart(2, '0')}`) ?? null);
    return { jahr, monate, summe: r3(monate.reduce<number>((n, x) => n + (x ?? 0), 0)) };
  });
}

// ---------------------------------------------------------------- Plausibilitätsprüfung

/**
 * Prüft einen neuen (oder geänderten) Stand gegen die vorhandenen – `staende` ohne den Satz selbst.
 *  Fehler:   Datum in der Zukunft; gleiche Art am selben Tag schon erfasst; Stand kleiner als der vorige (außer Überlauf
 *            bzw. Einbau); Stand größer als der folgende (bei nachträglicher Erfassung, außer der folgende ist ein Einbau).
 *  Warnung:  Überlauf angenommen; Ø je Tag mehr als dreimal so hoch wie üblich (erst ab drei bisherigen Abschnitten);
 *            kein (oder negativer) Verbrauch über mehr als 60 Tage.
 */
export function pruefen(z: ZaehlerRechnen, staende: Stand[], neu: Stand, stichtag: string): Pruefung {
  const s = sortieren(staende);
  const marke: Stand = { ...neu, id: undefined };
  const alle = sortieren([...s, marke]);
  const i = alle.indexOf(marke);
  const vor = i > 0 ? alle[i - 1] : null;
  const nach = i < alle.length - 1 ? alle[i + 1] : null;
  const vorher = vor ? { datum: vor.datum, stand: vor.stand } : null;
  const verbrauch = vor ? abschnittVerbrauch(vor, neu, z) : null;
  const tage = vor ? tageZwischen(vor.datum, neu.datum) : 0;
  const tagesverbrauch = verbrauch != null && tage > 0 ? r3(verbrauch / tage) : null;
  const ergebnis = (fehler: string | null, warnung: string | null = null): Pruefung => ({ fehler, warnung, verbrauch, tagesverbrauch, vorher });

  if (!datumGueltig(neu.datum)) return ergebnis('Bitte ein gültiges Datum angeben.');
  if (neu.datum > stichtag) return ergebnis(`Das Datum ${dat(neu.datum)} liegt in der Zukunft.`);
  if (!Number.isFinite(neu.stand) || neu.stand < 0) return ergebnis('Der Stand muss eine Zahl ab 0 sein.');
  if (s.some((x) => x.datum === neu.datum && x.art === neu.art)) {
    return ergebnis(`Für den ${dat(neu.datum)} ist bereits ein Stand dieser Art erfasst – bitte den vorhandenen ändern.`);
  }
  let ueberlauf = false;
  if (vor && neu.art !== 'EINBAU' && neu.stand < vor.stand) {
    if (!ueberlaufMoeglich(vor.stand, neu.stand, z.stellen)) {
      return ergebnis(`Der Stand ist kleiner als der vorige (${zahlDe(vor.stand)} am ${dat(vor.datum)}). Bei einem Zählerwechsel bitte „Ausbau“ und „Einbau“ erfassen.`);
    }
    ueberlauf = true;
  }
  if (nach && nach.art !== 'EINBAU' && neu.stand > nach.stand && !ueberlaufMoeglich(neu.stand, nach.stand, z.stellen)) {
    return ergebnis(`Der Stand ist größer als der folgende (${zahlDe(nach.stand)} am ${dat(nach.datum)}).`);
  }
  if (neu.art === 'EINBAU' || verbrauch == null) return ergebnis(null);
  if (ueberlauf) return ergebnis(null, `Der Stand ist kleiner als der vorige – angenommen wird ein Überlauf des Zählwerks (Verbrauch ${zahlDe(verbrauch)}). Bitte bestätigen.`);
  if (verbrauch <= 0 && tage > 60) return ergebnis(null, `Seit dem ${dat(vor!.datum)} (${tage} Tage) kein Verbrauch – ist der Zähler in Ordnung? Bitte bestätigen.`);
  // üblicher Verbrauch: aus den bisherigen Abschnitten (ohne den neuen Stand)
  const bisher = abschnitte(s, z).filter((a) => a.verbrauch != null && a.tage > 0);
  if (bisher.length >= 3 && tagesverbrauch != null) {
    const td = tagesdurchschnitt(s, z);
    if (td != null && td > 0 && tagesverbrauch > 3 * td) {
      return ergebnis(null, `Der Verbrauch ist mit ${zahlDe(tagesverbrauch)} je Tag mehr als dreimal so hoch wie üblich (Ø ${zahlDe(td)} je Tag). Bitte prüfen und bestätigen.`);
    }
  }
  return ergebnis(null);
}

// ---------------------------------------------------------------- CSV

export interface CsvZeile { zeile: number; zaehler: string; datum: string; stand: number; art: StandArt; notiz: string | null; fehler: string | null }

/** eine CSV-Zeile in Felder zerlegen (Anführungszeichen, verdoppelte Anführungszeichen) */
function felder(zeile: string, trenner: string): string[] {
  const out: string[] = [];
  let f = '', q = false;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (q) {
      if (c === '"' && zeile[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"') q = true;
    else if (c === trenner) { out.push(f); f = ''; } else f += c;
  }
  out.push(f);
  return out.map((x) => x.trim());
}

/** Datum TT.MM.JJJJ (auch T.M.JJJJ) oder JJJJ-MM-TT → JJJJ-MM-TT; null, wenn ungültig */
export function datumLesen(t: string): string | null {
  let iso: string | null = null;
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t.trim());
  if (de) iso = `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(t.trim())) iso = t.trim();
  return iso && datumGueltig(iso) ? iso : null;
}

/** Zahl lesen: mit Komma deutsch (Punkte = Tausender), sonst mit Dezimalpunkt; null, wenn keine Zahl */
export function zahlLesen(t: string): number | null {
  let s = t.trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const ART_TEXTE: Record<string, StandArt> = {
  '': 'ABLESUNG', ABLESUNG: 'ABLESUNG', A: 'ABLESUNG', SCHAETZUNG: 'SCHAETZUNG', 'SCHÄTZUNG': 'SCHAETZUNG', S: 'SCHAETZUNG',
  AUSBAU: 'AUSBAU', EINBAU: 'EINBAU',
};
export const ART_TEXT: Record<StandArt, string> = { ABLESUNG: 'Ablesung', SCHAETZUNG: 'Schätzung', AUSBAU: 'Ausbau', EINBAU: 'Einbau' };

/**
 * CSV-Import lesen: Trenner „;“ oder „,“ (nach der ersten Zeile), Kopfzeile mit den Spalten Zähler ; Datum ; Stand ;
 * Art (optional) ; Notiz (optional) – Spalten werden über die Kopfzeile erkannt, ohne Kopfzeile gilt diese Reihenfolge.
 * Zähler = Nummer, Zählernummer oder Bezeichnung (aufgelöst in den Routen).
 */
export function csvLesen(text: string): CsvZeile[] {
  const zeilen = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const erste = zeilen.find((z) => z.trim()) ?? '';
  const anzahl = (c: string) => erste.split(c).length - 1;
  const trenner = anzahl('\t') > 0 ? '\t' : anzahl(';') > 0 && anzahl(';') >= anzahl(',') ? ';' : anzahl(',') > 0 ? ',' : ';';
  let spalten = { zaehler: 0, datum: 1, stand: 2, art: 3, notiz: 4 };
  const out: CsvZeile[] = [];
  let erstGelesen = false;
  zeilen.forEach((roh, idx) => {
    if (!roh.trim()) return;
    const f = felder(roh, trenner);
    if (!erstGelesen) {
      erstGelesen = true;
      // Kopfzeile: Spalten über ihre Namen erkennen (Umlaute als ae/oe/ue)
      const namen = f.map((x) => x.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z]/g, ''));
      const exakt = (...n: string[]) => namen.findIndex((x) => n.includes(x));
      if (exakt('datum') >= 0 && exakt('stand', 'zaehlerstand') >= 0) {
        spalten = {
          zaehler: Math.max(0, exakt('zaehler', 'nummer', 'zaehlernummer', 'bezeichnung')), datum: exakt('datum'),
          stand: exakt('stand', 'zaehlerstand'), art: exakt('art'), notiz: exakt('notiz', 'bemerkung'),
        };
        return;
      }
      if (!datumLesen(f[1] ?? '')) return; // Kopfzeile mit anderen Namen: Reihenfolge Zähler ; Datum ; Stand ; Art ; Notiz
    }
    const zaehler = f[spalten.zaehler] ?? '';
    const datumRoh = f[spalten.datum] ?? '';
    const datum = datumLesen(datumRoh);
    const stand = zahlLesen(f[spalten.stand] ?? '');
    const artRoh = spalten.art >= 0 ? (f[spalten.art] ?? '').toUpperCase() : '';
    const art = ART_TEXTE[artRoh];
    const notiz = spalten.notiz >= 0 ? (f[spalten.notiz] ?? '').slice(0, 500) || null : null;
    const fehler = !zaehler ? 'Zähler fehlt.'
      : !datum ? `Datum „${datumRoh}“ ungültig (TT.MM.JJJJ oder JJJJ-MM-TT).`
      : stand == null || stand < 0 ? `Stand „${f[spalten.stand] ?? ''}“ ist keine Zahl ab 0.`
      : !art ? `Art „${f[spalten.art]}“ unbekannt (Ablesung, Schätzung, Ausbau, Einbau).` : null;
    out.push({ zeile: idx + 1, zaehler, datum: datum ?? datumRoh, stand: stand ?? 0, art: art ?? 'ABLESUNG', notiz, fehler });
  });
  return out;
}

/** CSV-Feld: in Anführungszeichen, wenn nötig */
const feld = (v: string) => (/[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export interface CsvExportZeile {
  nummer: string; bezeichnung: string; zaehlernummer: string | null; medium: string; einheit: string;
  datum: string; stand: number; art: StandArt; verbrauch: number | null; notiz: string | null;
}
/** CSV-Export der Stände: Semikolon, deutsches Zahlenformat, TT.MM.JJJJ, UTF-8 mit BOM – wieder einlesbar (Spalten Zähler, Datum, Stand, Art, Notiz) */
export function csvSchreiben(zeilen: CsvExportZeile[]): string {
  const kopf = ['Zähler', 'Bezeichnung', 'Zählernummer', 'Medium', 'Einheit', 'Datum', 'Stand', 'Art', 'Verbrauch', 'Notiz'];
  const daten = zeilen.map((z) => [
    z.nummer, z.bezeichnung, z.zaehlernummer ?? '', z.medium, z.einheit, dat(z.datum), zahlDe(z.stand), ART_TEXT[z.art],
    z.verbrauch == null ? '' : zahlDe(z.verbrauch), z.notiz ?? '',
  ].map(feld).join(';'));
  return `\uFEFF${[kopf.join(';'), ...daten].join('\r\n')}\r\n`;
}
