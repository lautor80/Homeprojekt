import type { FastifyRequest } from 'fastify';
import { can } from './auth.js';

/**
 * Schutz sensibler Daten (Feldberechtigungen).
 *
 * Grundsatz: Ohne die passende Berechtigung verlässt ein geschützter Wert den Server nur maskiert –
 * in Listen, Detailseiten, PDFs zur Ansicht und in Änderungsbelegen. Die Maskierung passiert
 * immer serverseitig; die Oberfläche zeigt nur an, was sie bekommt.
 *
 * Maskierte Werte enthalten das Zeichen „•“. Schreibende Routen müssen maskierte Eingaben
 * ablehnen oder serverseitig durch den gespeicherten Wert ersetzen (`istMaskiert`).
 */
export const MASKE = '•';

export type Schutzart = 'iban' | 'bic' | 'text';

/** Ein geschütztes Feld einer Tabelle (für Änderungsbelege) */
export interface SensitiveFieldDef {
  /** Tabelle mit Schema, z. B. "tco.mitglieder" */
  table: string;
  /** Spalte → Art der Maskierung */
  fields: Record<string, Schutzart>;
  /** Berechtigung für den Klartext */
  permission: string;
}

export const istMaskiert = (s: string | null | undefined): boolean => !!s && s.includes(MASKE);

const ohneLeer = (s: string | null | undefined) => (s ?? '').replace(/\s/g, '').toUpperCase();

/** DE89370400440532013000 → DE••••••••••••••••3000 (Land und letzte 4 Stellen bleiben erkennbar) */
export function maskIban(s: string | null | undefined): string {
  const v = ohneLeer(s);
  if (!v) return '';
  if (istMaskiert(v)) return v;
  if (v.length <= 6) return MASKE.repeat(v.length);
  return `${v.slice(0, 2)}${MASKE.repeat(v.length - 6)}${v.slice(-4)}`;
}

/** COBADEFFXXX → COBA••••••• (Bankkürzel bleibt erkennbar, Länder-/Ortscode nicht) */
export function maskBic(s: string | null | undefined): string {
  const v = ohneLeer(s);
  if (!v) return '';
  if (istMaskiert(v)) return v;
  return `${v.slice(0, 4)}${MASKE.repeat(Math.max(v.length - 4, 0))}`;
}

/** „Maria Muster“ → „M•••• M•••••“ */
export function maskText(s: string | null | undefined): string {
  const v = (s ?? '').trim();
  if (!v) return '';
  if (istMaskiert(v)) return v;
  return v.split(/\s+/).map((w) => `${w.slice(0, 1)}${MASKE.repeat(Math.max(w.length - 1, 2))}`).join(' ');
}

const IBAN_IM_TEXT = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;

/** IBANs in Freitexten (Verwendungszweck, Meldungen) maskieren */
export function ibansImText(s: string | null | undefined): string {
  return (s ?? '').replace(IBAN_IM_TEXT, (m) => maskIban(m));
}

export function maskieren(wert: string | null | undefined, art: Schutzart): string {
  if (wert === null || wert === undefined || wert === '') return wert ?? '';
  return art === 'iban' ? maskIban(wert) : art === 'bic' ? maskBic(wert) : maskText(wert);
}

/**
 * Feldschutz für eine Anfrage: `klar` = Benutzer darf den Klartext sehen; die Methoden geben
 * den Wert unverändert (mit Berechtigung) oder maskiert (ohne) zurück.
 */
export function feldschutz(req: FastifyRequest, permission: string) {
  const klar = can(req, permission);
  return {
    klar,
    iban: (s: string | null | undefined) => (klar ? s ?? '' : maskIban(s)),
    bic: (s: string | null | undefined) => (klar ? s ?? '' : maskBic(s)),
    text: (s: string | null | undefined) => (klar ? s ?? '' : maskText(s)),
    freitext: (s: string | null | undefined) => (klar ? s ?? '' : ibansImText(s)),
  };
}
export type Feldschutz = ReturnType<typeof feldschutz>;
