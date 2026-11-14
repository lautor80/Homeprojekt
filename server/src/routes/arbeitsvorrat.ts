import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { arbeitsvorratLesen } from '../lib/arbeitsvorrat.js';
import { hinweisGesehen } from '../lib/hinweise.js';

/** Arbeitsvorrat des Portals auf der Startseite (#232, V2) – für jeden angemeldeten Benutzer, Inhalt je nach Rechten */
export async function arbeitsvorratRoutes(app: FastifyInstance) {
  app.get('/api/arbeitsvorrat', { preHandler: requireAuth() }, async (req) => ({ gruppen: await arbeitsvorratLesen(req) }));

  /** Kästchen „gesehen“ an einem Hinweis (#232, V1): einzeln (id) oder alle einer Art – das Recht der zugehörigen App prüft hinweisGesehen */
  // Adresse wie HINWEIS_GESEHEN in lib/hinweise.ts
  app.post('/api/arbeitsvorrat/hinweis-gesehen', { preHandler: requireAuth() }, async (req) => {
    const b = z.union([
      z.object({ id: z.coerce.number().int().positive() }),
      z.object({ modul: z.string().min(1).max(40), quelle: z.string().min(1).max(60), bereich: z.string().max(80).optional() }),
    ]).parse(req.body);
    const n = await hinweisGesehen(req, b);
    return { text: n === 1 ? 'Als gesehen bestätigt.' : n ? `${n} Hinweise als gesehen bestätigt.` : 'Der Hinweis war schon bestätigt.' };
  });
}
