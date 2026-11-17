/**
 * Abrechnungsstatus eines Auftrags für die Auftragsliste (Spalte „Abrechnung“): angelegt · abgerechnet · bezahlt.
 *
 *  - angelegt     Auftrag ohne Rechnung, nicht abgeschlossen
 *  - abgerechnet  Rechnung erstellt, Zahlung offen
 *  - ueberfaellig Rechnung erstellt, Zahlung offen und mehr als KULANZ_TAGE nach Fälligkeit
 *                 (Fälligkeit = Rechnungsdatum + Zahlungsziel aus den Firmendaten)
 *  - bezahlt      Zahlungseingang erfasst – oder ohne Rechnung abgeschlossen (früher „mit 0 Euro ausgebucht“):
 *                 solche Aufträge brauchen keine Zahlung und gelten als bezahlt
 *
 * Reine Funktionen ohne Datenbank – getestet in server/test/transport_abrechnung.test.ts.
 */

export type AbrechnungStatus = 'angelegt' | 'abgerechnet' | 'ueberfaellig' | 'bezahlt';

/** Erst so viele Tage nach der Fälligkeit gilt eine offene Rechnung als überfällig */
export const KULANZ_TAGE = 3;

export interface Abrechnung {
  status: AbrechnungStatus;
  /** Fälligkeit der Rechnung (ISO), sonst null */
  faellig: string | null;
  /** Tage seit Fälligkeit, nur bei überfällig > 0 */
  tageUeberfaellig: number;
  /** Datum des Zahlungseingangs; bei „ohne Rechnung“ das Abschlussdatum */
  bezahltAm: string | null;
  /** ohne Rechnung abgeschlossen – gilt als bezahlt, hat aber keinen Zahlungseingang */
  ohneRechnung: boolean;
}

const tag = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const TAG_MS = 86_400_000;

/** ISO-Datum + n Tage */
export function plusTage(iso: string, n: number): string {
  return new Date(tag(iso) + n * TAG_MS).toISOString().slice(0, 10);
}

/** ganze Tage von a nach b (b − a) */
export function tageZwischen(a: string, b: string): number {
  return Math.round((tag(b) - tag(a)) / TAG_MS);
}

export function abrechnungsStatus(
  a: { faktura: string | null; fakturadatum: string | null; abgeschlossenAm: string | null; bezahltAm: string | null },
  zahlungszielTage: number,
  heute: string,
): Abrechnung {
  if (!a.faktura) {
    if (a.abgeschlossenAm) return { status: 'bezahlt', faellig: null, tageUeberfaellig: 0, bezahltAm: a.abgeschlossenAm, ohneRechnung: true };
    return { status: 'angelegt', faellig: null, tageUeberfaellig: 0, bezahltAm: null, ohneRechnung: false };
  }
  const faellig = a.fakturadatum ? plusTage(a.fakturadatum, Math.max(0, zahlungszielTage || 0)) : null;
  if (a.bezahltAm) return { status: 'bezahlt', faellig, tageUeberfaellig: 0, bezahltAm: a.bezahltAm, ohneRechnung: false };
  const tage = faellig ? tageZwischen(faellig, heute) : 0;
  return { status: tage > KULANZ_TAGE ? 'ueberfaellig' : 'abgerechnet', faellig, tageUeberfaellig: tage > KULANZ_TAGE ? tage : 0, bezahltAm: null, ohneRechnung: false };
}

/** Lade- bzw. Entladetermin für die zweite Zeile der Spalte Route */
export interface Termin { datum: string | null; zeit: string | null }

const leer = (t: Termin): boolean => !t.datum && !t.zeit?.trim();

/**
 * Laden = Ladetermin des ersten Stops, Entladen = Entladetermin des letzten Stops mit Entladestelle (wie die Route:
 * Stop 1 → Entladestelle 1 → Entladestelle 2). Ohne Datum und Zeit: null.
 */
export function ladeTermine(
  s1: { datum: string | null; zeit: string | null; datum_e: string | null; zeit_e: string | null; plzort_e: string | null } | null,
  s2: { datum_e: string | null; zeit_e: string | null; plzort_e: string | null } | null,
): { laden: Termin | null; entladen: Termin | null } {
  const norm = (datum: string | null, zeit: string | null): Termin | null => {
    const t = { datum: datum || null, zeit: zeit?.trim() || null };
    return leer(t) ? null : t;
  };
  const laden = s1 ? norm(s1.datum, s1.zeit) : null;
  const zweiter = s2 && (s2.plzort_e?.trim() || s2.datum_e || s2.zeit_e?.trim()) ? norm(s2.datum_e, s2.zeit_e) : null;
  const entladen = zweiter ?? (s1 ? norm(s1.datum_e, s1.zeit_e) : null);
  return { laden, entladen };
}
