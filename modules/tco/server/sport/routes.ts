import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { DB } from '../verein.js';
import { abgleich, standLesen, uebernehmen } from './nuliga.js';

/** Sport (#162): Spielerdaten aus nuLiga – ID-Nr. und LK mit den Mitgliedern abgleichen */
export const P_SPORT = { display: 'tco.sport:display', edit: 'tco.sport:edit' };

export async function sportRoutes(app: FastifyInstance) {
  const datei = z.string().min(1, 'Bitte die Datei aus nuLiga ablegen.').max(7_000_000).transform((s) => Buffer.from(s, 'base64'));
  app.get('/sport/spielerdaten', { preHandler: requireAuth(P_SPORT.display) }, async () => standLesen(DB));
  /** Vorschau: liest die Datei und gleicht ab – schreibt nichts */
  app.post('/sport/spielerdaten/abgleich', { preHandler: requireAuth(P_SPORT.edit), bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = z.object({ datei }).parse(req.body);
    return abgleich(DB, b.datei);
  });
  app.post('/sport/spielerdaten/uebernehmen', { preHandler: requireAuth(P_SPORT.edit), bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = z.object({ datei, name: z.string().max(200).default(''), auswahl: z.array(z.object({ adrnr: z.string().min(1), zeile: z.number().int().min(2) })).min(1, 'Bitte mindestens einen Treffer auswählen.').max(5000) }).parse(req.body);
    return { text: await change(req, (tx) => uebernehmen(tx, b.datei, b.auswahl), { action: 'NULIGA_ABGLEICH', reason: b.name || 'nuLiga-Mitgliederdaten' }) };
  });
}
