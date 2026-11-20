import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import { jobEintrag, jobSicht, jobSichten, jobStarten, laeufeLesen, laufAbbrechen, laufLesen, planSetzen } from '../jobs.js';

/**
 * Jobs (Administration → System → Jobs), siehe server/src/jobs.ts:
 *   GET  /api/admin/jobs                      alle Jobs mit Plan, nächstem und letztem Lauf
 *   PUT  /api/admin/jobs/:id/plan             ein-/ausplanen und Plan ändern (Änderungsbeleg JOB)
 *   POST /api/admin/jobs/:id/standard         Plan auf den Standard zurücksetzen
 *   POST /api/admin/jobs/:id/ausfuehren       „Jetzt ausführen“ → { laufId } (409, wenn er gerade läuft)
 *   GET  /api/admin/jobs/laeufe               Läufe (Filter job, status, von, bis, limit)
 *   GET  /api/admin/jobs/laeufe/:id           ein Lauf mit Protokoll
 *   POST /api/admin/jobs/laeufe/:id/abbrechen laufenden Lauf abbrechen
 */
const P_ANZEIGEN = 'core.jobs:display';
const P_PLANEN = 'core.jobs:edit';
const P_AUSFUEHREN = 'core.jobs:execute';

const STATUS = ['LAEUFT', 'OK', 'WARNUNG', 'FEHLER', 'ABGEBROCHEN'] as const;
const tag = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const jobParam = z.object({ id: z.string().min(1).max(200) });
const laufParam = z.object({ id: z.coerce.number().int().positive() });

const darf = (req: FastifyRequest) => (recht: string) => can(req, recht);

export async function jobRoutes(app: FastifyInstance) {
  app.get('/api/admin/jobs', { preHandler: requireAuth(P_ANZEIGEN) }, async (req) => jobSichten(darf(req)));

  app.put('/api/admin/jobs/:id/plan', { preHandler: requireAuth(P_PLANEN) }, async (req) => {
    const { id } = jobParam.parse(req.params);
    const b = z.object({ eingeplant: z.boolean(), plan: z.unknown() }).parse(req.body ?? {});
    const { def } = jobEintrag(id);
    await change(req, (tx) => planSetzen(tx, id, b.eingeplant, b.plan, req.user?.username ?? 'system'),
      { action: b.eingeplant ? 'JOB_EINPLANEN' : 'JOB_AUSPLANEN', reason: def.text });
    return jobSicht(id, darf(req));
  });

  app.post('/api/admin/jobs/:id/standard', { preHandler: requireAuth(P_PLANEN) }, async (req) => {
    const { id } = jobParam.parse(req.params);
    const { def } = jobEintrag(id);
    await change(req, (tx) => planSetzen(tx, id, def.standardEingeplant ?? true, def.standardPlan, req.user?.username ?? 'system'),
      { action: 'JOB_STANDARD', reason: def.text });
    return jobSicht(id, darf(req));
  });

  app.post('/api/admin/jobs/:id/ausfuehren', { preHandler: requireAuth(P_AUSFUEHREN) }, async (req) => {
    const { id } = jobParam.parse(req.params);
    const { def } = jobEintrag(id);
    if (def.recht && !can(req, def.recht)) throw new BusinessError(`Keine Berechtigung (${def.recht}).`, 403);
    const laufId = await jobStarten(id, { id: req.user?.id || null, name: req.user?.username ?? 'unbekannt' }, req.log);
    return { laufId };
  });

  app.get('/api/admin/jobs/laeufe', { preHandler: requireAuth(P_ANZEIGEN) }, async (req) => {
    const q = z.object({
      job: z.string().max(200).optional(), status: z.enum(STATUS).optional(),
      von: tag.optional(), bis: tag.optional(), limit: z.coerce.number().int().min(1).max(1000).optional(),
    }).parse(Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, string>).filter(([, v]) => v !== '')));
    return laeufeLesen(q);
  });

  app.get('/api/admin/jobs/laeufe/:id', { preHandler: requireAuth(P_ANZEIGEN) }, async (req) => {
    const { id } = laufParam.parse(req.params);
    return laufLesen(id);
  });

  app.post('/api/admin/jobs/laeufe/:id/abbrechen', { preHandler: requireAuth(P_AUSFUEHREN) }, async (req) => {
    const { id } = laufParam.parse(req.params);
    return laufAbbrechen(id, req.user?.username ?? 'unbekannt');
  });
}
