/**
 * Vermietung – reine Rechenlogik ohne Datenbank (testbar mit tsx --test).
 *
 *  - Aufteilung eines Mieteingangs in Kaltmiete und Nebenkosten-Abschlag
 *  - Soll je Monat aus den Mietkonditionen (anteilig nach Tagen bei Ein- und Auszug)
 *  - Zeitanteil eines Kostenbelegs (Leistungszeitraum) für einen Zeitraum
 *  - Zählerstände: Stand an einem Stichtag (linear zwischen zwei Ablesungen) und Verbrauch im Zeitraum
 *  - Verteilung der Kosten auf Einheiten und Nutzer nach Verteilerschlüssel (Fläche, Personen, Einheiten,
 *    fester Anteil, Verbrauch über Haupt- und Unterzähler, direkte Zuordnung)
 *
 * Datumswerte sind ISO-Zeichenketten (JJJJ-MM-TT); Zeiträume schließen Anfang und Ende ein.
 */

export type Schluessel = 'flaeche' | 'personen' | 'einheiten' | 'anteil' | 'verbrauch' | 'direkt';

export const SCHLUESSEL_TEXT: Record<Schluessel, string> = {
  flaeche: 'Wohnfläche',
  personen: 'Personen (Personentage)',
  einheiten: 'Wohneinheiten (gleiche Teile)',
  anteil: 'Fester Anteil je Einheit',
  verbrauch: 'Verbrauch (Haupt- und Unterzähler)',
  direkt: 'Direkt einer Einheit zugeordnet',
};

/** auf Cent runden (kaufmännisch) */
export const r2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------- Datum
const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const TAG = 86_400_000;

/** Tage von … bis einschließlich (0, wenn bis vor von liegt) */
export const tage = (von: string, bis: string) => Math.max(0, Math.round((ms(bis) - ms(von)) / TAG) + 1);
export const plusTage = (d: string, n: number) => iso(ms(d) + n * TAG);
export const maxDatum = (a: string, b: string) => (a > b ? a : b);
export const minDatum = (a: string, b: string) => (a < b ? a : b);

/** gemeinsame Tage zweier Zeiträume (bis = null: unbefristet) */
export function ueberlappung(aVon: string, aBis: string | null, bVon: string, bBis: string | null): { von: string; bis: string; tage: number } | null {
  const von = maxDatum(aVon, bVon);
  const bis = aBis && bBis ? minDatum(aBis, bBis) : (aBis ?? bBis ?? '9999-12-31');
  return von <= bis ? { von, bis, tage: tage(von, bis) } : null;
}

export const monatsErster = (d: string) => `${d.slice(0, 7)}-01`;
export function monatsLetzter(d: string): string {
  const y = +d.slice(0, 4), m = +d.slice(5, 7);
  return iso(Date.UTC(y, m, 0));
}
/** die zwölf Monatsersten eines Jahres */
export const monateDesJahres = (jahr: number) => Array.from({ length: 12 }, (_, i) => `${jahr}-${String(i + 1).padStart(2, '0')}-01`);

// ---------------------------------------------------------------- Miete
export interface Kondition { gueltig_ab: string; kaltmiete: number; nk_abschlag: number }
export interface Vertrag {
  id: number;
  einheit_id: number;
  name: string;
  beginn: string;
  ende: string | null;
  personen: number;
  konditionen?: Kondition[];
}

/** gültige Kondition an einem Stichtag (jüngste mit gueltig_ab <= datum) */
export function konditionAm(konditionen: Kondition[], datum: string): Kondition | null {
  let k: Kondition | null = null;
  for (const x of konditionen) if (x.gueltig_ab <= datum && (!k || x.gueltig_ab > k.gueltig_ab)) k = x;
  return k;
}

/**
 * Soll eines Mietverhältnisses für einen Monat: Kaltmiete und Abschlag laut Kondition zum Monatsersten
 * (bzw. zum Einzug); bei Ein- oder Auszug im Monat anteilig nach Tagen.
 */
export function sollMonat(v: Vertrag, monat: string): { miete: number; nk: number } {
  const von = monatsErster(monat), bis = monatsLetzter(monat);
  const u = ueberlappung(v.beginn, v.ende, von, bis);
  if (!u) return { miete: 0, nk: 0 };
  const k = konditionAm(v.konditionen ?? [], u.von);
  if (!k) return { miete: 0, nk: 0 };
  const f = u.tage / tage(von, bis);
  return { miete: r2(Number(k.kaltmiete) * f), nk: r2(Number(k.nk_abschlag) * f) };
}

/**
 * Vorschlag zur Aufteilung eines Mieteingangs: Deckt der Betrag das Soll, bekommt der Nebenkosten-Abschlag sein Soll
 * und der Rest zählt als Miete (eine Überzahlung also zur Miete). Ein Teilbetrag wird im Verhältnis des Solls aufgeteilt.
 * Ohne Soll zählt alles zur Miete. Die Summe der Anteile ist immer der Betrag.
 */
export function aufteilen(betrag: number, sollMiete: number, sollNk: number): { miete: number; nk: number } {
  const soll = sollMiete + sollNk;
  if (soll <= 0 || betrag <= 0) return { miete: r2(betrag), nk: 0 };
  const nk = betrag >= soll ? r2(sollNk) : r2(betrag * sollNk / soll);
  return { miete: r2(betrag - nk), nk };
}

// ---------------------------------------------------------------- Kosten
export interface Kosten {
  id?: number;
  kostenart_id: number;
  datum: string;
  von: string | null;
  bis: string | null;
  betrag: number;
  einheit_id: number | null;
}

/**
 * Anteil eines Kostenbelegs an einem Zeitraum: mit Leistungszeitraum zeitanteilig nach Tagen
 * (z. B. Jahresbescheid Grundsteuer → 1/12 je Monat), ohne Leistungszeitraum ganz im Monat des Belegdatums.
 */
export function kostenAnteil(k: Kosten, von: string, bis: string): number {
  if (k.von && k.bis) {
    const u = ueberlappung(k.von, k.bis, von, bis);
    return u ? Number(k.betrag) * u.tage / tage(k.von, k.bis) : 0;
  }
  return k.datum >= von && k.datum <= bis ? Number(k.betrag) : 0;
}

// ---------------------------------------------------------------- Zähler
export interface Ablesung { datum: string; stand: number }
export interface Zaehler { id: number; bezeichnung: string; einheit_id: number | null; haupt_id: number | null; ablesungen: Ablesung[] }

/** Zählerstand an einem Tag: abgelesen oder linear zwischen der Ablesung davor und danach; null, wenn nicht eingegrenzt */
export function standAm(ablesungen: Ablesung[], datum: string): number | null {
  const a = [...ablesungen].sort((x, y) => x.datum.localeCompare(y.datum));
  const genau = a.find((x) => x.datum === datum);
  if (genau) return Number(genau.stand);
  let vor: Ablesung | null = null, nach: Ablesung | null = null;
  for (const x of a) {
    if (x.datum < datum) vor = x;
    else if (x.datum > datum && !nach) nach = x;
  }
  if (!vor || !nach) return null;
  const f = (ms(datum) - ms(vor.datum)) / (ms(nach.datum) - ms(vor.datum));
  return Number(vor.stand) + (Number(nach.stand) - Number(vor.stand)) * f;
}

/** Verbrauch von Beginn des ersten bis Ende des letzten Tages (Stand am Vortag von „von“ bis Stand am „bis“) */
export function verbrauch(ablesungen: Ablesung[], von: string, bis: string): number | null {
  // Ablesung am Vortag gilt als Stand zu Beginn des Zeitraums (z. B. 31.12. für das Folgejahr)
  const a = standAm(ablesungen, plusTage(von, -1)) ?? standAm(ablesungen, von);
  const b = standAm(ablesungen, bis) ?? standAm(ablesungen, plusTage(bis, 1));
  if (a === null || b === null) return null;
  return Math.round((b - a) * 1000) / 1000;
}

// ---------------------------------------------------------------- Verteilung
export interface Einheit { id: number; kuerzel: string; flaeche: number; personen: number; eigennutzung: boolean }
export interface Kostenart {
  id: number;
  bezeichnung: string;
  umlagefaehig: boolean;
  schluessel: Schluessel;
  zaehler_id: number | null;
  /** Grundkosten in Prozent (nach Wohnfläche), Rest nach Verbrauch – nur beim Schlüssel „verbrauch“ */
  grundanteil: number;
  /**
   * Schlüssel „verbrauch“: Wem gehört, was der Hauptzähler mehr zeigt als alle Unterzähler? null = gemeinsamer Verbrauch
   * (Treppenhaus, Waschkeller …) nach Wohnfläche; eine Wohnung = Differenzmessung (deren Verbrauch = Haupt − übrige Unterzähler).
   */
  rest_einheit_id?: number | null;
  /** Prozent je Einheit beim Schlüssel „anteil“ */
  anteile: Record<number, number>;
  p35a: boolean;
}

/** Wer nutzt eine Einheit wann: Mietverhältnis, Eigennutzung oder Leerstand */
export interface Segment { einheit_id: number; vertrag_id: number | null; art: 'miete' | 'eigen' | 'leer'; von: string; bis: string; tage: number; personen: number }

/** lückenlose Nutzungsabschnitte je Einheit im Zeitraum */
export function nutzung(einheiten: Einheit[], vertraege: Vertrag[], von: string, bis: string): Segment[] {
  const out: Segment[] = [];
  for (const e of einheiten) {
    const vs = vertraege.filter((v) => v.einheit_id === e.id)
      .map((v) => ({ v, u: ueberlappung(v.beginn, v.ende, von, bis) }))
      .filter((x): x is { v: Vertrag; u: NonNullable<ReturnType<typeof ueberlappung>> } => !!x.u)
      .sort((a, b) => a.u.von.localeCompare(b.u.von));
    let ab = von;
    const luecke = (bisTag: string) => {
      if (ab > bisTag) return;
      out.push({ einheit_id: e.id, vertrag_id: null, art: e.eigennutzung ? 'eigen' : 'leer', von: ab, bis: bisTag, tage: tage(ab, bisTag), personen: e.eigennutzung ? Number(e.personen) : 0 });
    };
    for (const { v, u } of vs) {
      const start = maxDatum(u.von, ab);
      if (start > u.bis) continue;
      luecke(plusTage(start, -1));
      out.push({ einheit_id: e.id, vertrag_id: v.id, art: 'miete', von: start, bis: u.bis, tage: tage(start, u.bis), personen: Number(v.personen) });
      ab = plusTage(u.bis, 1);
    }
    luecke(bis);
  }
  return out;
}

export interface Anteil { einheit_id: number; vertrag_id: number | null; art: Segment['art']; tage: number; betrag: number; basis: string }
export interface Position {
  kostenart_id: number;
  bezeichnung: string;
  umlagefaehig: boolean;
  schluessel: Schluessel;
  p35a: boolean;
  gesamt: number;
  /** Anteil je Einheit (ungerundet zusammengezählt, auf Cent gerundet) */
  einheiten: Record<number, number>;
  anteile: Anteil[];
  hinweise: string[];
}
export interface Verteilung { von: string; bis: string; positionen: Position[]; hinweise: string[] }

const zahl = (x: number, nk = 2) => x.toLocaleString('de-DE', { minimumFractionDigits: nk, maximumFractionDigits: nk });

export interface VerteilungEingabe {
  von: string;
  bis: string;
  einheiten: Einheit[];
  vertraege: Vertrag[];
  kostenarten: Kostenart[];
  kosten: Kosten[];
  zaehler: Zaehler[];
}

/** Kosten eines Zeitraums nach den Schlüsseln der Kostenarten auf Einheiten und Nutzungsabschnitte verteilen */
export function verteilen(x: VerteilungEingabe): Verteilung {
  const segmente = nutzung(x.einheiten, x.vertraege, x.von, x.bis);
  const gesamtTage = tage(x.von, x.bis);
  const F = x.einheiten.reduce((s, e) => s + Number(e.flaeche), 0);
  const hinweise: string[] = [];
  const positionen: Position[] = [];

  for (const ka of x.kostenarten) {
    const belege = x.kosten.filter((k) => k.kostenart_id === ka.id);
    const gesamt = belege.reduce((s, k) => s + kostenAnteil(k, x.von, x.bis), 0);
    if (Math.abs(gesamt) < 0.005) continue;
    const ph: string[] = [];
    // Anteil (0…1) und Erläuterung je Einheit
    let quote = new Map<number, { f: number; basis: string }>();
    const nachFlaeche = () => new Map(x.einheiten.map((e) => [e.id, { f: F ? Number(e.flaeche) / F : 1 / x.einheiten.length, basis: `${zahl(Number(e.flaeche))} m² von ${zahl(F)} m²` }]));

    // direkt zugeordnete Belege getrennt, der Rest nach Schlüssel
    const direkt = new Map<number, number>();
    let rest = gesamt;
    if (ka.schluessel === 'direkt') {
      for (const k of belege) {
        const a = kostenAnteil(k, x.von, x.bis);
        if (k.einheit_id && x.einheiten.some((e) => e.id === k.einheit_id)) { direkt.set(k.einheit_id, (direkt.get(k.einheit_id) ?? 0) + a); rest -= a; }
      }
      if (Math.abs(rest) >= 0.005) ph.push(`${ka.bezeichnung}: ${zahl(rest)} € ohne Einheit – nach Wohnfläche verteilt.`);
    }

    if (ka.schluessel === 'flaeche' || ka.schluessel === 'direkt') quote = nachFlaeche();
    else if (ka.schluessel === 'einheiten') quote = new Map(x.einheiten.map((e) => [e.id, { f: 1 / x.einheiten.length, basis: `1 von ${x.einheiten.length} Einheiten` }]));
    else if (ka.schluessel === 'anteil') {
      const summe = x.einheiten.reduce((s, e) => s + Number(ka.anteile[e.id] ?? 0), 0);
      if (summe <= 0) { ph.push(`${ka.bezeichnung}: keine Anteile hinterlegt – nach Wohnfläche verteilt.`); quote = nachFlaeche(); }
      else {
        if (Math.abs(summe - 100) > 0.01) ph.push(`${ka.bezeichnung}: Anteile ergeben ${zahl(summe)} % statt 100 % – im Verhältnis verteilt.`);
        quote = new Map(x.einheiten.map((e) => [e.id, { f: Number(ka.anteile[e.id] ?? 0) / summe, basis: `${zahl(Number(ka.anteile[e.id] ?? 0))} %` }]));
      }
    } else if (ka.schluessel === 'verbrauch') {
      const h = x.zaehler.find((z) => z.id === ka.zaehler_id);
      const vh = h ? verbrauch(h.ablesungen, x.von, x.bis) : null;
      const unter = h ? x.zaehler.filter((z) => z.haupt_id === h.id && z.einheit_id) : [];
      const vu = unter.map((z) => ({ z, v: verbrauch(z.ablesungen, x.von, x.bis) }));
      const fehlt = [...(h && vh === null ? [h] : []), ...vu.filter((u) => u.v === null).map((u) => u.z)];
      if (!h) { ph.push(`${ka.bezeichnung}: kein Hauptzähler hinterlegt – nach Wohnfläche verteilt.`); quote = nachFlaeche(); }
      else if (fehlt.length) { ph.push(`${ka.bezeichnung}: Zählerstände fehlen (${fehlt.map((z) => z.bezeichnung).join(', ')}) – nach Wohnfläche verteilt. Ablesungen zu Beginn und Ende des Zeitraums erfassen.`); quote = nachFlaeche(); }
      else {
        const je = new Map<number, number>();
        for (const u of vu) je.set(u.z.einheit_id!, (je.get(u.z.einheit_id!) ?? 0) + (u.v ?? 0));
        const summeUnter = [...je.values()].reduce((s, v) => s + v, 0);
        let V = vh!;
        if (summeUnter > V + 0.001) { ph.push(`${ka.bezeichnung}: Unterzähler (${zahl(summeUnter, 1)}) zeigen mehr als der Hauptzähler (${zahl(V, 1)}) – Hauptzähler prüfen.`); V = summeUnter; }
        if (V <= 0) { ph.push(`${ka.bezeichnung}: kein Verbrauch im Zeitraum – nach Wohnfläche verteilt.`); quote = nachFlaeche(); }
        else {
          const g = Math.min(100, Math.max(0, Number(ka.grundanteil))) / 100;
          const ohneZaehler = Math.max(0, V - summeUnter);
          const restBei = ka.rest_einheit_id && x.einheiten.some((e) => e.id === ka.rest_einheit_id) ? ka.rest_einheit_id : null;
          quote = new Map(x.einheiten.map((e) => {
            const fl = F ? Number(e.flaeche) / F : 1 / x.einheiten.length;
            let eigen = je.get(e.id) ?? 0;
            const gemeinsam = restBei ? 0 : ohneZaehler * fl;
            if (restBei === e.id) eigen += ohneZaehler;
            const f = g * fl + (1 - g) * (eigen + gemeinsam) / V;
            const teile = [`${zahl(eigen, 1)} ${restBei === e.id ? 'Verbrauch (Hauptzähler minus Unterzähler)' : 'eigener Verbrauch'}`];
            if (gemeinsam > 0) teile.push(`${zahl(gemeinsam, 1)} Anteil Gemeinschaft`);
            const basis = `${teile.join(' + ')} von ${zahl(V, 1)} gesamt${g ? `, ${zahl(g * 100, 0)} % Grundkosten nach Fläche` : ''}`;
            return [e.id, { f, basis }];
          }));
        }
      }
    }

    // Einheit → Nutzungsabschnitte; Personen: direkt nach Personentagen über alle Abschnitte
    const anteile: Anteil[] = [];
    if (ka.schluessel === 'personen') {
      const gewicht = segmente.reduce((s, sg) => s + sg.personen * sg.tage, 0);
      if (gewicht <= 0) {
        ph.push(`${ka.bezeichnung}: keine Personen hinterlegt – nach Wohnfläche verteilt.`);
        quote = nachFlaeche();
      } else {
        for (const sg of segmente) {
          anteile.push({ einheit_id: sg.einheit_id, vertrag_id: sg.vertrag_id, art: sg.art, tage: sg.tage,
            betrag: rest * sg.personen * sg.tage / gewicht, basis: `${zahl(sg.personen, 1)} Pers. × ${sg.tage} Tage von ${zahl(gewicht, 0)} Personentagen` });
        }
      }
    }
    if (!anteile.length) {
      for (const sg of segmente) {
        const q = quote.get(sg.einheit_id) ?? { f: 0, basis: '' };
        const d = (direkt.get(sg.einheit_id) ?? 0) * sg.tage / gesamtTage;
        anteile.push({ einheit_id: sg.einheit_id, vertrag_id: sg.vertrag_id, art: sg.art, tage: sg.tage,
          betrag: d + rest * q.f * sg.tage / gesamtTage,
          basis: ka.schluessel === 'direkt' && d ? 'direkt zugeordnet' : `${q.basis}${sg.tage < gesamtTage ? `, ${sg.tage} von ${gesamtTage} Tagen` : ''}` });
      }
    }
    const einheiten: Record<number, number> = {};
    for (const a of anteile) einheiten[a.einheit_id] = (einheiten[a.einheit_id] ?? 0) + a.betrag;
    for (const k of Object.keys(einheiten)) einheiten[+k] = r2(einheiten[+k]);
    positionen.push({ kostenart_id: ka.id, bezeichnung: ka.bezeichnung, umlagefaehig: ka.umlagefaehig, schluessel: ka.schluessel, p35a: ka.p35a,
      gesamt: r2(gesamt), einheiten, anteile: anteile.map((a) => ({ ...a, betrag: r2(a.betrag) })), hinweise: ph });
    hinweise.push(...ph);
  }
  return { von: x.von, bis: x.bis, positionen, hinweise };
}

// ---------------------------------------------------------------- Abrechnung je Mietverhältnis
export interface AbrechnungsPosition { kostenart_id: number; bezeichnung: string; schluessel: Schluessel; gesamt: number; anteil: number; basis: string; p35a: boolean }
export interface Abrechnung {
  vertrag_id: number;
  von: string;
  bis: string;
  tage: number;
  positionen: AbrechnungsPosition[];
  kosten: number;
  vorauszahlungen: number;
  /** positiv = Nachzahlung des Mieters, negativ = Guthaben */
  ergebnis: number;
  /** davon haushaltsnahe Dienstleistungen/Handwerkerleistungen (§ 35a EStG) */
  p35a: number;
  /** Vorschlag für den neuen monatlichen Abschlag (Kosten je Monat, auf volle Euro aufgerundet) */
  neuerAbschlag: number;
}

/** Nebenkostenabrechnung eines Mietverhältnisses aus der Verteilung (nur umlagefähige Kostenarten) */
export function abrechnen(v: Verteilung, vertrag: Vertrag, vorauszahlungen: number): Abrechnung {
  const u = ueberlappung(vertrag.beginn, vertrag.ende, v.von, v.bis);
  const positionen: AbrechnungsPosition[] = [];
  for (const p of v.positionen.filter((x) => x.umlagefaehig)) {
    const eigene = p.anteile.filter((a) => a.vertrag_id === vertrag.id);
    const anteil = r2(eigene.reduce((s, a) => s + a.betrag, 0));
    if (!eigene.length) continue;
    positionen.push({ kostenart_id: p.kostenart_id, bezeichnung: p.bezeichnung, schluessel: p.schluessel, gesamt: p.gesamt, anteil, basis: eigene.map((a) => a.basis).join('; '), p35a: p.p35a });
  }
  const kosten = r2(positionen.reduce((s, p) => s + p.anteil, 0));
  const tageMiete = u?.tage ?? 0;
  const monate = tageMiete / 30.4375;
  return {
    vertrag_id: vertrag.id, von: u?.von ?? v.von, bis: u?.bis ?? v.bis, tage: tageMiete, positionen, kosten,
    vorauszahlungen: r2(vorauszahlungen), ergebnis: r2(kosten - vorauszahlungen),
    p35a: r2(positionen.filter((p) => p.p35a).reduce((s, p) => s + p.anteil, 0)),
    neuerAbschlag: monate > 0 ? Math.ceil(kosten / monate) : 0,
  };
}

/** Frist für die Abrechnung (§ 556 Abs. 3 BGB): zwölf Monate nach Ende des Abrechnungszeitraums */
export const abrechnungsFrist = (bis: string) => `${+bis.slice(0, 4) + 1}${bis.slice(4)}`;
