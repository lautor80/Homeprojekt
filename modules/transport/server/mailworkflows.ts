import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../../../server/src/db.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { funktionAktiv } from '../../../server/src/funktionsschalter.js';
import { adressListe, rechnungsVersandAus } from './sammelversand-logik.js';

/**
 * Euroflex Mail-Workflows – gemeinsame Einstellungen und Schnittstellentypen für Eingang und Sammelversand.
 * Fachliche Beschreibung: docs/euroflex-mailworkflows.md
 */

export const P_MW = {
  /** App Posteingang: Prüfliste ansehen */
  eingangDisplay: 'transport.eingang:display',
  /** Prüfliste bearbeiten: ablegen, ignorieren, Auftrag zuordnen, neu bewerten */
  eingangEdit: 'transport.eingang:edit',
  /** nur für den API-Schlüssel von n8n: E-Mails liefern und deren Behandlung abholen */
  eingangMelden: 'transport.eingang:execute',
  /** Sammelversand direkt senden statt Entwurf */
  versandSenden: 'transport.versandsenden:execute',
} as const;

/** Funktionsschalter (Administration → Funktionen) */
export const F_MW = {
  eingang: 'transport.eingang',
  eingangN8n: 'transport.eingang.n8n',
  versandSammel: 'transport.versand.sammel',
  versandAutomatisch: 'transport.versand.automatisch',
} as const;

export type Dokumentart = 'T' | 'L' | 'R';
export const DOKUMENTARTEN: Dokumentart[] = ['T', 'L', 'R'];

export interface EingangEinstellungen {
  /** lokal = im Portal bis zur Übernahme in den Ablageordner (Unterordner Eingang/); paperless = Kontext auftrag.dokument */
  ablageziel: 'lokal' | 'paperless';
  /** ab diesem Trefferwert (0–100) wird automatisch abgelegt – nur bei eingeschalteter Funktion „Automatisch ablegen“ */
  schwelle: number;
  /** Outlook-Ordner, in die n8n die Mail nach der Verarbeitung verschiebt */
  ordnerZugeordnet: string;
  ordnerPruefen: string;
  /** die E-Mail selbst zusätzlich als PDF ablegen */
  mailAlsPdf: boolean;
  /** Texterkennung (pdftotext / Tesseract) für Anhänge */
  ocr: boolean;
  /** Warnung, wenn noch nicht übernommene Dateien mehr als so viele MB belegen */
  speicherWarnungMb: number;
  /**
   * Inhalte nach der Übernahme in den Ablageordner so viele Tage im Portal behalten – damit „Erneut ablegen“ die Datei wieder
   * in den Ordner schreiben kann (z. B. auf einem anderen PC oder nach dem Löschen). 0 = sofort löschen (bisheriges Verhalten).
   * Gilt nur ohne „aufbewahrenDauerhaft“.
   */
  aufbewahrenTage: number;
  /**
   * Inhalte zugeordneter E-Mails (übernommen, in Paperless abgelegt, Dublette) dauerhaft im Portal behalten – jede zugeordnete
   * Datei bleibt im Posteingang und am Auftrag herunterladbar (Standard). Aus: Löschen nach „aufbewahrenTage“.
   */
  aufbewahrenDauerhaft: boolean;
  /**
   * Eingangspostfächer (z. B. info@ und buchhaltung@) mit Bezeichnung für die App „Posteingang“ (Anzeige und Filter). Abgerufen
   * werden die Postfächer, die im n8n-Workflow unter POSTFAECHER stehen; Mails aus einem hier nicht eingetragenen Postfach
   * werden trotzdem angenommen und mit ihrer Adresse angezeigt.
   */
  postfaecher: EingangsPostfach[];
}
export interface EingangsPostfach { adresse: string; bezeichnung: string }

/**
 * Je Dokumentart: Vorauswahl im Dialog „Versenden…“, Modus, festes Absender-Postfach und BCC.
 * absender/bcc leer = Postfach des Benutzers bzw. kein BCC; wirken nur mit eingeschalteter Funktion F_RECHNUNG
 * („Versand: Absender je Dokumentart und BCC“). BCC bietet die Oberfläche nur für Rechnungen an (z. B. DATEV-Upload).
 */
export interface VersandArtEinstellung { vorauswahl: boolean; modus: 'entwurf' | 'senden'; absender: string; bcc: string }
export type VersandEinstellungen = Record<Dokumentart, VersandArtEinstellung>;

export const EINGANG_STANDARD: EingangEinstellungen = {
  ablageziel: 'lokal', schwelle: 80, ordnerZugeordnet: 'Portal/Zugeordnet', ordnerPruefen: 'Portal/Prüfen',
  mailAlsPdf: true, ocr: true, speicherWarnungMb: 1024, aufbewahrenTage: 90, aufbewahrenDauerhaft: true, postfaecher: [],
};
export const VERSAND_STANDARD: VersandEinstellungen = {
  T: { vorauswahl: true, modus: 'entwurf', absender: '', bcc: '' },
  L: { vorauswahl: true, modus: 'entwurf', absender: '', bcc: '' },
  R: { vorauswahl: false, modus: 'entwurf', absender: '', bcc: '' },
};

/**
 * Rechnungsversand (ältere Ablage, Spalte `rechnung`): Absender und BCC für Rechnungen. Seit „Absender je Dokumentart“ stehen
 * die Werte in versand.R; die Spalte wird beim Sichern weiter mitgeschrieben und dient nur noch als Rückfall beim Lesen.
 */
export interface RechnungEinstellungen { absender: string; bcc: string }
export const RECHNUNG_STANDARD: RechnungEinstellungen = { absender: '', bcc: '' };
/** Funktionsschalter „Versand: Absender-Postfach je Dokumentart und BCC“ (früher nur für Rechnungen) */
export const F_RECHNUNG = 'transport.versand.rechnung';

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const rechnungSchema = z.object({
  absender: z.string().trim().max(200).refine((x) => !x || EMAIL_RE.test(x), 'Absender: bitte genau eine gültige E-Mail-Adresse angeben.'),
  bcc: z.string().trim().max(1000).refine((x) => adressListe(x).every((a) => EMAIL_RE.test(a)), 'BCC: eine oder mehrere gültige E-Mail-Adressen, durch Komma getrennt.')
    .transform((x) => adressListe(x).join(', ')),
});

const emailFeld = (name: string) => z.string().trim().max(200).refine((x) => !x || EMAIL_RE.test(x), `${name}: bitte genau eine gültige E-Mail-Adresse angeben.`);
const bccFeld = z.string().trim().max(1000).refine((x) => adressListe(x).every((a) => EMAIL_RE.test(a)), 'BCC: eine oder mehrere gültige E-Mail-Adressen, durch Komma getrennt.')
  .transform((x) => adressListe(x).join(', '));
const postfachSchema = z.object({
  adresse: z.string().trim().toLowerCase().refine((x) => EMAIL_RE.test(x), 'Eingangspostfach: bitte eine gültige E-Mail-Adresse angeben.'),
  bezeichnung: z.string().trim().max(60).default(''),
});

const eingangSchema = z.object({
  ablageziel: z.enum(['lokal', 'paperless']),
  schwelle: z.coerce.number().int().min(1).max(100),
  ordnerZugeordnet: z.string().trim().min(1).max(200),
  ordnerPruefen: z.string().trim().min(1).max(200),
  mailAlsPdf: z.boolean(),
  ocr: z.boolean(),
  speicherWarnungMb: z.coerce.number().int().min(10).max(100_000),
  aufbewahrenTage: z.coerce.number().int().min(0).max(3650).default(90),
  aufbewahrenDauerhaft: z.boolean().default(true),
  postfaecher: z.array(postfachSchema).max(20).default([])
    .refine((l) => new Set(l.map((x) => x.adresse)).size === l.length, 'Eingangspostfach doppelt eingetragen.'),
});
const artSchema = z.object({
  vorauswahl: z.boolean(), modus: z.enum(['entwurf', 'senden']),
  absender: emailFeld('Absender').default(''), bcc: bccFeld.default(''),
});
const versandSchema = z.object({ T: artSchema, L: artSchema, R: artSchema });

/** Gespeicherte Werte über die Standardwerte legen – fehlende oder ungültige Felder fallen auf den Standard zurück */
export function einstellungenMischen(eingang: unknown, versand: unknown, rechnung?: unknown): { eingang: EingangEinstellungen; versand: VersandEinstellungen; rechnung: RechnungEinstellungen } {
  const e = { ...EINGANG_STANDARD, ...(typeof eingang === 'object' && eingang ? eingang : {}) };
  const ep = eingangSchema.safeParse(e);
  const rp = rechnungSchema.safeParse({ ...RECHNUNG_STANDARD, ...(typeof rechnung === 'object' && rechnung ? rechnung : {}) });
  const r = rp.success ? rp.data : RECHNUNG_STANDARD;
  const v: Record<string, unknown> = { ...VERSAND_STANDARD };
  if (typeof versand === 'object' && versand) for (const a of DOKUMENTARTEN) {
    const x = (versand as Record<string, unknown>)[a];
    if (typeof x === 'object' && x) v[a] = { ...VERSAND_STANDARD[a], ...x };
  }
  // ältere Ablage: Absender/BCC der Rechnung standen nur in der Spalte rechnung
  const vr = v.R as Record<string, unknown>;
  if (!('absender' in (((versand as Record<string, unknown> | null)?.R ?? {}) as object))) v.R = { ...vr, absender: r.absender, bcc: r.bcc };
  // je Art einzeln prüfen: ein kaputter Wert setzt nur diese Art auf den Standard zurück
  for (const a of DOKUMENTARTEN) {
    const p = artSchema.safeParse(v[a]);
    v[a] = p.success ? p.data : VERSAND_STANDARD[a];
  }
  const vp = versandSchema.safeParse(v);
  const versandOk = vp.success ? vp.data : VERSAND_STANDARD;
  return { eingang: ep.success ? ep.data : EINGANG_STANDARD, versand: versandOk, rechnung: { absender: versandOk.R.absender, bcc: versandOk.R.bcc } };
}

export async function workflowEinstellungen(): Promise<{ eingang: EingangEinstellungen; versand: VersandEinstellungen; rechnung: RechnungEinstellungen }> {
  const [r] = await sql`select eingang, versand, rechnung from transport.workflow_einstellungen where id = 1`;
  return einstellungenMischen(r?.eingang, r?.versand, r?.rechnung);
}

/** Absender und BCC je Dokumentart (leer = Postfach des Benutzers, kein BCC); alles leer bei ausgeschalteter Funktion F_RECHNUNG */
export type VersandRegeln = Record<Dokumentart, { absender: string | null; bcc: string[] }>;
export async function versandRegeln(): Promise<VersandRegeln> {
  const { versand } = await workflowEinstellungen();
  const aktiv = funktionAktiv(F_RECHNUNG);
  return Object.fromEntries(DOKUMENTARTEN.map((a) => [a, rechnungsVersandAus(aktiv, versand[a])])) as VersandRegeln;
}

/** Absender und BCC für E-Mails mit Rechnung (Dokumentart R) */
export async function rechnungsVersand(): Promise<{ absender: string | null; bcc: string[] }> {
  return (await versandRegeln()).R;
}

/** Einstellungen der Mail-Workflows (Administration → Einstellungen → Euroflex → Mail-Workflows) */
export async function mailworkflowRoutes(app: FastifyInstance, stammdaten: string) {
  app.get('/workflow-einstellungen', { preHandler: requireAuth(stammdaten) }, async () => workflowEinstellungen());

  app.put('/workflow-einstellungen', { preHandler: requireAuth(stammdaten) }, async (req) => {
    // rechnung fehlt bei älteren Oberflächen: dann bleiben die gespeicherten Werte
    // rechnung (ältere Oberfläche): Absender/BCC der Rechnung, wenn versand.R sie nicht mitbringt
    const roh = req.body as { versand?: { R?: Record<string, unknown> } };
    const b = z.object({ eingang: eingangSchema, versand: versandSchema, rechnung: rechnungSchema.optional() }).parse(req.body);
    if (b.rechnung && !(roh.versand?.R && 'absender' in roh.versand.R)) b.versand.R = { ...b.versand.R, absender: b.rechnung.absender, bcc: b.rechnung.bcc };
    const rechnung = { absender: b.versand.R.absender, bcc: b.versand.R.bcc };
    await change(req, async (tx) => {
      await tx`update transport.workflow_einstellungen set eingang = ${tx.json(b.eingang as never)}, versand = ${tx.json(b.versand as never)},
                      rechnung = ${tx.json(rechnung as never)} where id = 1`;
    });
    return { ok: true };
  });
}
