/**
 * Mehrere Fahrten in einem Auftrag – reine Funktionen ohne Datenbank (testbar).
 *
 * Ein Kundentransport kann mit mehreren Fahrzeugen bzw. Unternehmern gefahren werden. Der Auftrag bleibt EINER
 * (Kunde, Route, Frachtpreis EK = Preis des Kunden, eine Rechnung); jede Fahrt hat ihren Unternehmer, ihr Fahrzeug,
 * ihren Frachtpreis VK (Preis des Unternehmers) und ihren eigenen Transportauftrag.
 *
 * Fahrt 1 steht wie bisher im Auftrag selbst (unternehmer, kennzeichen, fahrzeugtyp, frachtpreis_vk) – Bestandsdaten
 * bleiben unverändert. Weitere Fahrten (ab Position 2) stehen in transport.fahrten.
 */

/** Weitere Fahrt eines Auftrags (Position ≥ 2) */
export interface Fahrt {
  pos: number;
  unternehmer: number | null;
  kennzeichen: string | null;
  fahrzeugtyp: string | null;
  frachtpreis_vk: number;
  /** abweichendes Ladedatum dieser Fahrt; leer = Termin des ersten Stops */
  ladedatum: string | null;
}

/** Kennung einer Fahrt auf Transportauftrag und in der E-Mail: bei nur einer Fahrt die Auftragsnummer, sonst „Nummer-Position“ */
export function fahrtKennung(auftragsnr: string, pos: number, anzahlFahrten: number): string {
  return anzahlFahrten > 1 ? `${auftragsnr}-${pos}` : auftragsnr;
}

/** „2026_1260-2“ → Auftrag 2026_1260, Fahrt 2; ohne Endung ist es die Auftragsnummer selbst */
export function kennungZerlegen(id: string): { auftragsnr: string; pos: number | null } {
  const m = /^(.+)-(\d{1,3})$/.exec(id);
  return m ? { auftragsnr: m[1], pos: Number(m[2]) } : { auftragsnr: id, pos: null };
}

/** Eingegebene Fahrten: ganz leere Zeilen entfallen, die übrigen werden ab Position 2 durchnummeriert */
export function fahrtenBereinigen(eingabe: Omit<Fahrt, 'pos'>[]): Fahrt[] {
  return eingabe
    .filter((f) => f.unternehmer || (f.kennzeichen ?? '').trim() || f.frachtpreis_vk || f.ladedatum)
    .map((f, i) => ({ ...f, kennzeichen: (f.kennzeichen ?? '').trim() || null, pos: i + 2 }));
}

/** Spalte „Unternehmer“ der Auftragsliste: ein Name, bei verschiedenen Unternehmern deren Anzahl */
export function unternehmerText(namen: (string | null | undefined)[]): string {
  const n = [...new Set(namen.map((x) => (x ?? '').trim()).filter(Boolean))];
  return n.length > 1 ? `${n.length} Unternehmer` : n[0] ?? '';
}

interface AuftragFuerSicht<A, S extends { datum: string | null }> {
  auftragsnr: string;
  unternehmer: number | null;
  unternehmerAdr: A | null;
  kennzeichen: string | null;
  fahrzeugtyp: string | null;
  frachtpreis_vk: number;
  stops: S[];
  fahrten: (Fahrt & { unternehmerAdr: A | null })[];
}

/**
 * Der Auftrag aus Sicht einer Fahrt – für Transportauftrag (PDF) und E-Mail an deren Unternehmer:
 * Unternehmer, Fahrzeug, Frachtpreis VK und ggf. das Ladedatum kommen von der Fahrt, alles andere vom Auftrag.
 * Liefert null, wenn es die Fahrt nicht gibt.
 */
export function fahrtSicht<A, S extends { datum: string | null }, T extends AuftragFuerSicht<A, S>>(a: T, pos: number): { auftrag: T; kennung: string } | null {
  const anzahl = 1 + a.fahrten.length;
  const kennung = fahrtKennung(a.auftragsnr, pos, anzahl);
  if (pos === 1) return { auftrag: a, kennung };
  const f = a.fahrten.find((x) => x.pos === pos);
  if (!f) return null;
  const stops = f.ladedatum && a.stops.length ? [{ ...a.stops[0], datum: f.ladedatum }, ...a.stops.slice(1)] : a.stops;
  return {
    auftrag: { ...a, unternehmer: f.unternehmer, unternehmerAdr: f.unternehmerAdr, kennzeichen: f.kennzeichen, fahrzeugtyp: f.fahrzeugtyp, frachtpreis_vk: f.frachtpreis_vk, stops } as T,
    kennung,
  };
}

// ---------------------------------------------------------------------------
// Zusammenführen: mehrere offene Aufträge desselben Transports werden Fahrten eines Auftrags
// ---------------------------------------------------------------------------
export interface Kandidat {
  auftragsnr: string;
  typ: 'F' | 'H';
  kunde: number | null;
  rechnungsempfaenger: number | null;
  faktura: string | null;
  abgeschlossen_am: string | null;
  steuerrelevant: boolean;
  steuerbefreiung: string | null;
  hatTraeger: boolean;
  /** Lade- und Entladestellen ohne Termine und Ladenummern, siehe routenSchluessel */
  route: string;
  ordernummer: string | null;
  ladenummer: string | null;
}

interface StopOrte {
  firma: string | null; strasse: string | null; land: string | null; plzort: string | null;
  firma_e: string | null; strasse_e: string | null; land_e: string | null; plzort_e: string | null;
}

/** Vergleichswert der Route: Orte der Stops ohne Groß-/Kleinschreibung und Mehrfach-Leerzeichen; Termine und Ladenummern zählen nicht */
export function routenSchluessel(stops: StopOrte[]): string {
  const n = (v: string | null) => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return stops.map((s) => [s.firma, s.strasse, s.land, s.plzort, s.firma_e, s.strasse_e, s.land_e, s.plzort_e].map(n).join('|')).join('||');
}

/**
 * Prüft, ob sich die Aufträge zusammenführen lassen. Ziel ist der Auftrag mit der kleinsten Nummer; die übrigen werden
 * seine Fahrten und entfallen als eigene Aufträge. `hinweise` nennt, was dabei nicht übernommen wird.
 */
export function zusammenfuehrenPruefen(k: Kandidat[]): { ziel: string; quellen: string[]; fehler: string[]; hinweise: string[] } {
  const sortiert = [...k].sort((a, b) => a.auftragsnr.localeCompare(b.auftragsnr));
  const fehler: string[] = [];
  const hinweise: string[] = [];
  const z = sortiert[0];
  if (sortiert.length < 2) return { ziel: z?.auftragsnr ?? '', quellen: [], fehler: ['Bitte mindestens zwei Aufträge auswählen.'], hinweise };
  for (const a of sortiert) {
    if (a.faktura) fehler.push(`Auftrag ${a.auftragsnr} ist fakturiert (${a.faktura}).`);
    else if (a.abgeschlossen_am) fehler.push(`Auftrag ${a.auftragsnr} ist ohne Rechnung abgeschlossen – bitte zuerst wieder öffnen.`);
    if (a.typ !== 'F' || a.hatTraeger) fehler.push(`Auftrag ${a.auftragsnr} enthält Holzträger – zusammenführen lassen sich nur Frachtaufträge.`);
  }
  if (!z.kunde) fehler.push(`Auftrag ${z.auftragsnr} hat keinen Kunden.`);
  for (const a of sortiert.slice(1)) {
    if (a.kunde !== z.kunde) fehler.push(`Auftrag ${a.auftragsnr} hat einen anderen Kunden als ${z.auftragsnr}.`);
    else if (a.rechnungsempfaenger !== z.rechnungsempfaenger) fehler.push(`Auftrag ${a.auftragsnr} hat einen anderen Rechnungsempfänger als ${z.auftragsnr}.`);
    if (a.steuerrelevant !== z.steuerrelevant || (!a.steuerrelevant && (a.steuerbefreiung ?? '') !== (z.steuerbefreiung ?? ''))) {
      fehler.push(`Auftrag ${a.auftragsnr} wird bei der Mehrwertsteuer anders behandelt als ${z.auftragsnr}.`);
    }
    if (a.route !== z.route) fehler.push(`Auftrag ${a.auftragsnr} hat andere Lade- oder Entladestellen als ${z.auftragsnr} – alle Fahrten eines Auftrags fahren dieselbe Route.`);
    if (a.ordernummer && z.ordernummer && a.ordernummer !== z.ordernummer) hinweise.push(`Auftragsnr. Kunde „${a.ordernummer}“ von ${a.auftragsnr} entfällt (es gilt „${z.ordernummer}“).`);
    if (a.ladenummer && z.ladenummer && a.ladenummer !== z.ladenummer) hinweise.push(`Ladenummer „${a.ladenummer}“ von ${a.auftragsnr} entfällt (es gilt „${z.ladenummer}“).`);
  }
  return { ziel: z.auftragsnr, quellen: sortiert.slice(1).map((a) => a.auftragsnr), fehler, hinweise };
}
