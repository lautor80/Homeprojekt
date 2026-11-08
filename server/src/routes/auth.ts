import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, withChange } from '../db.js';
import {
  createSession, destroySession, hashPassword, istAltesHashformat, requireAuth, validatePassword, verifyPassword, changeCtx,
} from '../auth.js';
import { getPublicSettings } from './settings.js';
import { activeModuleIds } from '../modules.js';

// einfacher Schutz gegen Passwort-Raten: max. 10 Fehlversuche je Benutzer/IP in 15 Minuten
const failures = new Map<string, { count: number; until: number }>();
const WINDOW = 15 * 60_000;

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const key = `${body.username.toLowerCase()}|${req.ip}`;
    const f = failures.get(key);
    if (f && f.count >= 10 && f.until > Date.now()) {
      return reply.code(429).send({ message: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
    }

    const [u] = await sql`select id, password_hash, active from core.users
                          where lower(username) = lower(${body.username})`;
    const ok = u && u.active && (await verifyPassword(u.password_hash, body.password));
    if (!ok) {
      const cur = f && f.until > Date.now() ? f : { count: 0, until: Date.now() + WINDOW };
      cur.count++;
      failures.set(key, cur);
      return reply.code(401).send({ message: 'Benutzername oder Passwort falsch.' });
    }
    failures.delete(key);
    await sql`update core.users set last_login_at = now() where id = ${u.id}`;
    // übernommenes EP3-Kennwort: jetzt im aktuellen Verfahren speichern
    if (istAltesHashformat(u.password_hash)) await sql`update core.users set password_hash = ${await hashPassword(body.password)} where id = ${u.id}`;
    await createSession(req, reply, u.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  /** Alles, was die Oberfläche nach dem Login braucht. */
  app.get('/api/auth/me', { preHandler: requireAuth() }, async (req) => {
    const u = req.user!;
    return {
      user: {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        mustChangePassword: u.mustChangePassword,
        roles: u.roles,
      },
      permissions: [...u.permissions],
      modules: activeModuleIds(),
      settings: await getPublicSettings(),
    };
  });

  app.post('/api/auth/password', { preHandler: requireAuth() }, async (req, reply) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const [u] = await sql`select password_hash from core.users where id = ${req.user!.id}`;
    if (!(await verifyPassword(u.password_hash, body.current))) {
      return reply.code(400).send({ message: 'Das aktuelle Passwort ist falsch.' });
    }
    const err = validatePassword(body.next);
    if (err) return reply.code(400).send({ message: err });
    const h = await hashPassword(body.next);
    await withChange(changeCtx(req, { action: 'PASSWORT_AENDERN' }), (tx) =>
      tx`update core.users set password_hash = ${h}, must_change_password = false where id = ${req.user!.id}`);
    return { ok: true };
  });
}
