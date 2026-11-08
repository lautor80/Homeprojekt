import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { can, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import { alle, DAUER_S, freigeben, sperrDef, sperren, verlaengern } from '../sperren.js';

/**
 * Sperren gegen gleichzeitige Bearbeitung (Oberfläche):
 *   POST /api/sperren               Sperre setzen/verlängern (423 mit Inhaber, wenn fremd gesperrt)
 *   POST /api/sperren/verlaengern   Lebenszeichen für eigene Sperren
 *   POST /api/sperren/freigeben     eigene Sperren aufheben
 *   GET  /api/sperren               alle aktiven Sperren (Administration)
 *   DELETE /api/sperren/:id         Sperre eines anderen Benutzers aufheben (Administration)
 */
export const P_SPERREN = 'core.sperren:admin';

const zeit = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/).nullish();
const ids = z.object({ ids: z.array(z.coerce.number().int().positive()).max(200) });

export async function sperrRoutes(app: FastifyInstance) {
  const angemeldet = { preHandler: requireAuth() };

  app.post('/api/sperren', angemeldet, async (req) => {
    const b = z.object({
      objekt: z.string().min(1).max(40), schluessel: z.string().min(1).max(200),
      von: zeit, bis: zeit, bezeichnung: z.string().max(200).nullish(),
    }).parse(req.body ?? {});
    if (!req.sitzung) throw new BusinessError('Sperren sind nur für angemeldete Benutzer der Oberfläche möglich.', 403);
    const def = sperrDef(b.objekt);
    if (!def) throw new BusinessError(`Unbekannter Objekttyp „${b.objekt}“.`);
    if (!def.permission.split('|').some((x) => can(req, x)) && !can(req, P_SPERREN)) throw new BusinessError(`Keine Berechtigung (${def.permission}).`, 403);
    const r = await sperren({
      sitzung: req.sitzung, benutzerId: req.user!.id || null, benutzer: req.user!.displayName || req.user!.username,
      objekt: b.objekt, schluessel: b.schluessel, von: b.von, bis: b.bis, bezeichnung: b.bezeichnung,
    });
    return { ...r, dauer: DAUER_S };
  });

  app.post('/api/sperren/verlaengern', angemeldet, async (req) => {
    const b = ids.parse(req.body ?? {});
    return { aktiv: req.sitzung ? await verlaengern(req.sitzung, b.ids) : [] };
  });

  app.post('/api/sperren/freigeben', angemeldet, async (req) => {
    const b = ids.parse(req.body ?? {});
    return { freigegeben: req.sitzung ? await freigeben(req.sitzung, b.ids) : 0 };
  });

  app.get('/api/sperren', { preHandler: requireAuth(P_SPERREN) }, async () => {
    const liste = await alle();
    return liste.map((s) => ({ ...s, id: Number(s.id), objektText: sperrDef(String(s.objekt))?.text ?? s.objekt }));
  });

  app.delete('/api/sperren/:id', { preHandler: requireAuth(P_SPERREN) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const [s] = await sql`delete from core.sperren where id = ${id} returning objekt, schluessel, benutzer`;
    if (!s) throw new BusinessError('Sperre nicht gefunden (bereits aufgehoben oder abgelaufen).', 404);
    req.log.warn({ sperre: s, von: req.user?.username }, 'Sperre durch Administration aufgehoben');
    return { text: `Sperre von ${s.benutzer} auf ${sperrDef(s.objekt)?.text ?? s.objekt} ${s.schluessel === '*' ? '' : s.schluessel} aufgehoben.`.replace('  ', ' ') };
  });
}
