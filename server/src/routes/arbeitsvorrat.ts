import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { arbeitsvorratLesen } from '../lib/arbeitsvorrat.js';

/** Arbeitsvorrat des Portals auf der Startseite (#232, V2) – für jeden angemeldeten Benutzer, Inhalt je nach Rechten */
export async function arbeitsvorratRoutes(app: FastifyInstance) {
  app.get('/api/arbeitsvorrat', { preHandler: requireAuth() }, async (req) => ({ gruppen: await arbeitsvorratLesen(req) }));
}
