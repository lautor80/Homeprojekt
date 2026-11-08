import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../../../server/src/auth.js';
import { vereinLesen } from '../verein.js';
import { DATEITYPEN, groesseText, hochladen, stammLesen, zielBereich } from './logik.js';

export const P_UP = { execute: 'tco.upload:execute' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const id = z.coerce.number().int().positive();
const metaSchema = z.object({
  titel: z.string().max(200).default(''), datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT'),
  doktyp: id.nullish().transform((x) => x ?? null), korrespondent: id.nullish().transform((x) => x ?? null), korrespondentNeu: z.string().max(100).default(''),
  tags: z.array(id).default([]), tagsNeu: z.array(z.string().trim().min(1).max(60)).default([]),
  speicherpfad: id.nullish().transform((x) => x ?? null), notiz: z.string().max(2000).default(''),
});

export async function uploadRoutes(app: FastifyInstance) {
  const recht = { preHandler: requireAuth(P_UP.execute) };

  /** Auswahlwerte aus Paperless, erlaubte Dateitypen */
  app.get('/upload/stamm', recht, async () => ({ ...await stammLesen(await vereinLesen()), dateitypen: DATEITYPEN }));

  /** Eine Datei (Base64-Daten-URL) mit Metadaten nach Paperless übertragen */
  app.post('/upload/datei', { ...recht, bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const b = z.object({ datei: z.string().min(1), inhalt: z.string().min(1, 'Die Datei ist leer.'), meta: metaSchema }).parse(req.body);
    const r = await hochladen(await vereinLesen(), b.datei, b.inhalt, b.meta, benutzer(req));
    const bytes = Buffer.byteLength(b.inhalt.replace(/^data:[^,]*,/, ''), 'base64');
    return { ...r, datei: b.datei, groesse: groesseText(bytes), bereich: zielBereich(b.datei) };
  });
}
