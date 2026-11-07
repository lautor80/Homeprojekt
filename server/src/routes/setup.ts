import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, withChange } from '../db.js';
import { createSession, hashPassword, validatePassword } from '../auth.js';

async function needsSetup(): Promise<boolean> {
  const [{ n }] = await sql`select count(*)::int as n from core.users`;
  return n === 0;
}

/**
 * Einrichtungsassistent: nur verfügbar, solange es noch keinen Benutzer gibt.
 * Legt Organisation und ersten Administrator an und meldet ihn direkt an.
 */
export async function setupRoutes(app: FastifyInstance) {
  app.get('/api/setup/status', async () => ({ needsSetup: await needsSetup() }));

  app.post('/api/setup', async (req, reply) => {
    const body = z.object({
      orgName: z.string().min(1).max(100),
      username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
      displayName: z.string().min(1).max(100),
      email: z.string().email().or(z.literal('')).optional(),
      password: z.string(),
    }).parse(req.body);

    const err = validatePassword(body.password);
    if (err) return reply.code(400).send({ message: err });

    const h = await hashPassword(body.password);
    const userId = await withChange({ userId: null, username: 'setup', action: 'EINRICHTUNG' }, async (tx) => {
      await tx`select pg_advisory_xact_lock(4712)`;
      const [{ n }] = await tx`select count(*)::int as n from core.users`;
      if (n > 0) return null;
      await tx`insert into core.settings (key, value) values ('org.name', ${tx.json(body.orgName)})
               on conflict (key) do update set value = excluded.value`;
      const [u] = await tx`insert into core.users (username, display_name, email, password_hash)
                           values (${body.username}, ${body.displayName}, ${body.email || null}, ${h})
                           returning id`;
      await tx`insert into core.user_roles (user_id, role_id) values (${u.id}, 'ADMIN')`;
      return u.id as string;
    });
    if (!userId) return reply.code(409).send({ message: 'Das System ist bereits eingerichtet.' });

    await createSession(req, reply, userId);
    return { ok: true };
  });
}
