/**
 * Weltenwandler: Benutzer mit der Rolle WELTENWANDLER wechseln ohne neue Anmeldung zu anderen Benutzern mit dieser Rolle –
 * die Sitzung bleibt, nur der Benutzer der Sitzung wechselt. Schranke: zu einem Administrator (Rolle ADMIN) nur, wenn die
 * Sitzung von einem Administrator begonnen wurde oder es der ursprüngliche Benutzer ist (Rückweg).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';

export const WELTENWANDLER = 'WELTENWANDLER';

async function sitzung(req: FastifyRequest) {
  if (!req.sitzung || !req.user?.roles.includes(WELTENWANDLER)) return null;
  const [s] = await sql`select coalesce(ursprung_user_id, user_id)::text as ursprung from core.sessions where token_hash = ${req.sitzung}`;
  if (!s) return null;
  const [a] = await sql`select exists(select 1 from core.user_roles where user_id = ${s.ursprung} and role_id = 'ADMIN') as admin`;
  return { ursprung: s.ursprung as string, ursprungAdmin: !!a?.admin };
}

/** Benutzer, zu denen gewechselt werden darf (aktiv, Rolle WELTENWANDLER, kein Pflicht-Kennwortwechsel) */
async function ziele(req: FastifyRequest) {
  const s = await sitzung(req);
  if (!s) return [];
  const rows = await sql`
    select u.id::text as id, u.username, u.display_name as name,
           exists(select 1 from core.user_roles a where a.user_id = u.id and a.role_id = 'ADMIN') as admin,
           (select string_agg(r.name, ', ' order by r.name) from core.user_roles x join core.roles r on r.id = x.role_id
             where x.user_id = u.id and x.role_id <> ${WELTENWANDLER}) as rollen
      from core.users u join core.user_roles ur on ur.user_id = u.id and ur.role_id = ${WELTENWANDLER}
     where u.active and not u.must_change_password
     order by u.display_name, u.username`;
  return rows
    .filter((r) => r.id === s.ursprung || s.ursprungAdmin || !r.admin)
    .map((r) => ({ id: r.id as string, username: r.username as string, name: r.name as string, rollen: (r.rollen as string | null) ?? '', ursprung: r.id === s.ursprung }));
}

export async function weltenwandlerRoutes(app: FastifyInstance) {
  app.get('/api/auth/weltenwandler', { preHandler: requireAuth() }, async (req) => ({
    aktiv: !!(await sitzung(req)), benutzer: await ziele(req),
  }));

  app.post('/api/auth/weltenwandler', { preHandler: requireAuth() }, async (req) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const s = await sitzung(req);
    if (!s) throw new BusinessError('Benutzer wechseln dürfen nur Benutzer mit der Rolle Weltenwandler.', 403);
    const ziel = (await ziele(req)).find((u) => u.id === userId);
    if (!ziel) throw new BusinessError('Zu diesem Benutzer kann nicht gewechselt werden (inaktiv, ohne Rolle Weltenwandler, Kennwortwechsel offen oder Administrator).');
    await sql`update core.sessions set ursprung_user_id = coalesce(ursprung_user_id, user_id), user_id = ${userId} where token_hash = ${req.sitzung}`;
    req.log.info({ von: req.user!.username, nach: ziel.username }, 'Weltenwandler: Benutzer gewechselt');
    return { ok: true, name: ziel.name };
  });
}
