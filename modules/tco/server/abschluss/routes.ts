import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, plAktiv, vereinLesen } from '../verein.js';
import { abschlussLesen, earBerechnen, jahreswerteLesen } from './logik.js';
import {
  anlageLesen, anlageLoeschen, anlagenLesen, anlageSpeichern, initialbestandAnlegen, monateErstjahr, spiegelBerechnen, wertentwicklung,
} from './anlagen.js';
import { abschlussAblegen, abschlussPdf, abschlussTitel, type Teile } from './pdf.js';

/** Jahresabschluss: Einnahmen-Ausgaben-Rechnung, Vermögensübersicht, Anlagevermögen (Port von Z2UI5_CL_TCO_JAHRESABSCHLUSS) */
export const P_ABSCHLUSS = { display: 'tco.abschluss:display', edit: 'tco.abschluss:edit' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const jahr = z.coerce.number().int().min(2000).max(2100);
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const flag = z.union([z.boolean(), z.string()]).optional().transform((v) => v === true || v === '1' || v === 'true');
const teileSchema = z.object({ jahr, ear: flag, steuer: flag, anlagen: flag });
const teile = (q: z.infer<typeof teileSchema>): Teile => ({ ear: q.ear, steuer: q.steuer, anlagen: q.anlagen });

/** Betrag aus Zahl oder deutscher Schreibweise („1.234,56“) – ungültig → NaN, wird in der Prüfung abgewiesen */
const zahlLesen = (v: number | string): number => {
  if (typeof v === 'number') return v;
  const s = v.trim();
  return s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
};

const anlageSchema = z.object({
  anlnr: z.coerce.number().int().positive().nullish(),
  bezeichnung: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben.').max(60),
  anschdat: datum,
  anschwert: z.union([z.number(), z.string()]).transform(zahlLesen),
  nutzdauer: z.coerce.number({ invalid_type_error: 'Die Nutzungsdauer muss zwischen 1 und 99 Jahren liegen.' }).int('Die Nutzungsdauer bitte in ganzen Jahren angeben.'),
  monate_ej: z.coerce.number({ invalid_type_error: 'Die AfA-Monate im Anschaffungsjahr müssen zwischen 0 und 12 liegen.' }).int('Die AfA-Monate bitte als ganze Zahl angeben.'),
  notiz: z.string().max(255).nullish(),
});

export async function abschlussRoutes(app: FastifyInstance) {
  /** Gesamtbild eines Geschäftsjahres: EAR, Überschussrechnung mit Vorjahren, Bankbestände, Anlagenspiegel */
  app.get('/abschluss/init', { preHandler: requireAuth(P_ABSCHLUSS.display) }, async (req) => {
    const q = z.object({ jahr: jahr.default(new Date().getFullYear()) }).parse(req.query);
    const v = await vereinLesen();
    return { ...(await abschlussLesen(DB, q.jahr)), paperless: plAktiv(v) };
  });

  // ---------------------------------------------------------------- Anlagevermögen
  app.get('/abschluss/anlagen', { preHandler: requireAuth(P_ABSCHLUSS.display) }, async (req) => {
    const q = z.object({ jahr }).parse(req.query);
    const alle = await anlagenLesen(DB);
    const { spiegel, summe } = spiegelBerechnen(alle, q.jahr);
    return { spiegel, summe, leer: !alle.length, entwicklung: wertentwicklung(alle, spiegel, q.jahr) };
  });

  app.get('/abschluss/anlagen/:anlnr', { preHandler: requireAuth(P_ABSCHLUSS.display) }, async (req) => {
    const { anlnr } = z.object({ anlnr: z.coerce.number().int().positive() }).parse(req.params);
    const a = await anlageLesen(DB, anlnr);
    if (!a) throw new BusinessError(`Anlageobjekt ${anlnr} nicht gefunden.`, 404);
    return a;
  });

  /** Vorschlag der AfA-Monate im Anschaffungsjahr (Monatsregel) */
  app.get('/abschluss/anlagen-monate', { preHandler: requireAuth(P_ABSCHLUSS.display) }, async (req) => {
    const q = z.object({ datum }).parse(req.query);
    return { monate_ej: monateErstjahr(q.datum) };
  });

  app.post('/abschluss/anlagen', { preHandler: requireAuth(P_ABSCHLUSS.edit) }, async (req) => {
    const b = anlageSchema.parse(req.body);
    const anlnr = await change(req, (tx) => anlageSpeichern(tx, { ...b, anlnr: b.anlnr ?? null, notiz: b.notiz ?? null }, benutzer(req)));
    return { anlnr, text: `Anlageobjekt ${String(anlnr).padStart(4, '0')} „${b.bezeichnung}“ gespeichert.` };
  });

  app.post('/abschluss/anlagen/loeschen', { preHandler: requireAuth(P_ABSCHLUSS.edit) }, async (req) => {
    const b = z.object({ anlnr: z.coerce.number().int().positive(), grund: z.string().trim().min(1, 'Bitte eine Begründung angeben.') }).parse(req.body);
    const a = await change(req, (tx) => anlageLoeschen(tx, b.anlnr), { action: 'LOESCHEN', reason: b.grund });
    return { text: `Anlageobjekt ${String(a.anlnr).padStart(4, '0')} „${a.bezeichnung}“ gelöscht.` };
  });

  /** Bestand aus der Excel „Werte Anlagevermögen“ übernehmen (nur in ein leeres Verzeichnis) */
  app.post('/abschluss/anlagen/initialbestand', { preHandler: requireAuth(P_ABSCHLUSS.edit) }, async (req) => {
    const n = await change(req, (tx) => initialbestandAnlegen(tx, benutzer(req)), { action: 'ANLAGEN_INIT' });
    return { text: `${n} Anlageobjekte aus der Excel „Werte Anlagevermögen“ übernommen.` };
  });

  // ---------------------------------------------------------------- PDF und Paperless
  app.get('/abschluss/pdf', { preHandler: requireAuth(P_ABSCHLUSS.display) }, async (req, reply) => {
    const q = teileSchema.parse(req.query);
    const t = teile(q);
    if (!t.ear && !t.steuer && !t.anlagen) t.ear = true;
    const { pdf, titel } = await abschlussPdf(DB, await vereinLesen(), q.jahr, t);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${titel.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf"`).send(pdf);
  });

  app.post('/abschluss/paperless', { preHandler: requireAuth(P_ABSCHLUSS.edit) }, async (req) => {
    const b = teileSchema.parse(req.body);
    const t = teile(b);
    const v = await vereinLesen();
    const { pdf } = await abschlussPdf(DB, v, b.jahr, t);
    const { werte } = await jahreswerteLesen(DB, b.jahr, b.jahr);
    return abschlussAblegen(v, b.jahr, abschlussTitel(b.jahr, t), pdf, earBerechnen(werte, b.jahr).ergebnis, benutzer(req));
  });
}
