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
  eingangAutomatik: 'transport.eingang.automatik',
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
}

export interface VersandArtEinstellung { vorauswahl: boolean; modus: 'entwurf' | 'senden' }
export type VersandEinstellungen = Record<Dokumentart, VersandArtEinstellung>;

export const EINGANG_STANDARD: EingangEinstellungen = {
  ablageziel: 'lokal', schwelle: 80, ordnerZugeordnet: 'Portal/Zugeordnet', ordnerPruefen: 'Portal/Prüfen',
  mailAlsPdf: true, ocr: true, speicherWarnungMb: 1024,
};
export const VERSAND_STANDARD: VersandEinstellungen = {
  T: { vorauswahl: true, modus: 'entwurf' },
  L: { vorauswahl: true, modus: 'entwurf' },
  R: { vorauswahl: false, modus: 'entwurf' },
};

/**
 * Rechnungsversand: festes Absender-Postfach und feste BCC-Adresse(n) für jede E-Mail mit einer Rechnung.
 * Leer = wie bisher (Postfach des Benutzers, kein BCC). Wirkt nur mit eingeschalteter Funktion F_RECHNUNG.
 */
export interface RechnungEinstellungen { absender: string; bcc: string }
export const RECHNUNG_STANDARD: RechnungEinstellungen = { absender: '', bcc: '' };
/** Funktionsschalter „Rechnungen aus dem Buchhaltungspostfach mit BCC“ */
export const F_RECHNUNG = 'transport.versand.rechnung';

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const rechnungSchema = z.object({
  absender: z.string().trim().max(200).refine((x) => !x || EMAIL_RE.test(x), 'Absender: bitte genau eine gültige E-Mail-Adresse angeben.'),
  bcc: z.string().trim().max(1000).refine((x) => adressListe(x).every((a) => EMAIL_RE.test(a)), 'BCC: eine oder mehrere gültige E-Mail-Adressen, durch Komma getrennt.')
    .transform((x) => adressListe(x).join(', ')),
});

const eingangSchema = z.object({
  ablageziel: z.enum(['lokal', 'paperless']),
  schwelle: z.coerce.number().int().min(1).max(100),
  ordnerZugeordnet: z.string().trim().min(1).max(200),
  ordnerPruefen: z.string().trim().min(1).max(200),
  mailAlsPdf: z.boolean(),
  ocr: z.boolean(),
  speicherWarnungMb: z.coerce.number().int().min(10).max(100_000),
});
const artSchema = z.object({ vorauswahl: z.boolean(), modus: z.enum(['entwurf', 'senden']) });
const versandSchema = z.object({ T: artSchema, L: artSchema, R: artSchema });

/** Gespeicherte Werte über die Standardwerte legen – fehlende oder ungültige Felder fallen auf den Standard zurück */
export function einstellungenMischen(eingang: unknown, versand: unknown, rechnung?: unknown): { eingang: EingangEinstellungen; versand: VersandEinstellungen; rechnung: RechnungEinstellungen } {
  const e = { ...EINGANG_STANDARD, ...(typeof eingang === 'object' && eingang ? eingang : {}) };
  const ep = eingangSchema.safeParse(e);
  const v: Record<string, unknown> = { ...VERSAND_STANDARD };
  if (typeof versand === 'object' && versand) for (const a of DOKUMENTARTEN) {
    const x = (versand as Record<string, unknown>)[a];
    if (typeof x === 'object' && x) v[a] = { ...VERSAND_STANDARD[a], ...x };
  }
  const vp = versandSchema.safeParse(v);
  const rp = rechnungSchema.safeParse({ ...RECHNUNG_STANDARD, ...(typeof rechnung === 'object' && rechnung ? rechnung : {}) });
  return { eingang: ep.success ? ep.data : EINGANG_STANDARD, versand: vp.success ? vp.data : VERSAND_STANDARD, rechnung: rp.success ? rp.data : RECHNUNG_STANDARD };
}

export async function workflowEinstellungen(): Promise<{ eingang: EingangEinstellungen; versand: VersandEinstellungen; rechnung: RechnungEinstellungen }> {
  const [r] = await sql`select eingang, versand, rechnung from transport.workflow_einstellungen where id = 1`;
  return einstellungenMischen(r?.eingang, r?.versand, r?.rechnung);
}

export async function rechnungsVersand(): Promise<{ absender: string | null; bcc: string[] }> {
  const { rechnung } = await workflowEinstellungen();
  return rechnungsVersandAus(funktionAktiv(F_RECHNUNG), rechnung);
}

/** Einstellungen der Mail-Workflows (Administration → Einstellungen → Euroflex → Mail-Workflows) */
export async function mailworkflowRoutes(app: FastifyInstance, stammdaten: string) {
  app.get('/workflow-einstellungen', { preHandler: requireAuth(stammdaten) }, async () => workflowEinstellungen());

  app.put('/workflow-einstellungen', { preHandler: requireAuth(stammdaten) }, async (req) => {
    // rechnung fehlt bei älteren Oberflächen: dann bleiben die gespeicherten Werte
    const b = z.object({ eingang: eingangSchema, versand: versandSchema, rechnung: rechnungSchema.optional() }).parse(req.body);
    await change(req, async (tx) => {
      await tx`update transport.workflow_einstellungen set eingang = ${tx.json(b.eingang as never)}, versand = ${tx.json(b.versand as never)} where id = 1`;
      if (b.rechnung) await tx`update transport.workflow_einstellungen set rechnung = ${tx.json(b.rechnung as never)} where id = 1`;
    });
    return { ok: true };
  });
}
