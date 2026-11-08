import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../../../server/src/auth.js';
import { DB } from '../verein.js';
import { forecast } from './logik.js';

/** Beitragsforecast – Port von Z2UI5_CL_TCO_BEITRAGSFORECAST (nur lesend) */
export const P_FORECAST = { display: 'tco.forecast:display' };

export async function forecastRoutes(app: FastifyInstance) {
  /** Hochrechnung Basisjahr / Folgejahr je Monat und Vertragsart; mitglieder=1 ergänzt die Mitglieder je Vertragsart */
  app.get('/forecast', { preHandler: requireAuth(P_FORECAST.display) }, async (req) => {
    const q = z.object({
      jahr: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
      mitglieder: z.enum(['0', '1']).default('0'),
    }).parse(req.query);
    return forecast(DB, q.jahr, q.mitglieder === '1');
  });
}
