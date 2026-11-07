import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, withChange, type ChangeContext, type Tx } from './db.js';
import { config } from './config.js';
import { hasPermission } from './permissions.js';

export const SESSION_COOKIE = 'portal_sid';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  mustChangePassword: boolean;
  roles: string[];
  permissions: Set<string>;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);

export function validatePassword(pw: string): string | null {
  if (pw.length < 10) return 'Das Passwort muss mindestens 10 Zeichen lang sein.';
  return null;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600_000);
  await sql`insert into core.sessions (token_hash, user_id, expires_at, ip, user_agent)
            values (${sha256(token)}, ${userId}, ${expires}, ${req.ip}, ${req.headers['user-agent'] ?? null})`;
  await sql`delete from core.sessions where expires_at < now()`;
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    expires,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await sql`delete from core.sessions where token_hash = ${sha256(token)}`;
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function loadUser(userId: string): Promise<AuthUser | null> {
  const [u] = await sql`
    select id, username, display_name, email, must_change_password
      from core.users where id = ${userId} and active`;
  if (!u) return null;
  const roles = await sql`select role_id from core.user_roles where user_id = ${userId} order by role_id`;
  const perms = await sql`
    select distinct rp.permission
      from core.user_roles ur join core.role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = ${userId}`;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    mustChangePassword: u.must_change_password,
    roles: roles.map((r) => r.role_id as string),
    permissions: new Set(perms.map((p) => p.permission as string)),
  };
}

/** Plugin: Sitzung auflösen, CSRF-Schutz, Hilfsfunktionen. */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    req.user = null;
    if (!req.url.startsWith('/api/')) return;

    // CSRF: schreibende Aufrufe nur mit eigenem Header (kann eine fremde Seite nicht setzen)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-portal-request'] !== '1') {
      return reply.code(403).send({ message: 'Ungültige Anfrage (CSRF-Schutz).' });
    }

    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const [s] = await sql`select user_id from core.sessions
                          where token_hash = ${sha256(token)} and expires_at > now()`;
    if (s) req.user = await loadUser(s.user_id);
  });
}

/** preHandler: angemeldet sein (und ggf. Berechtigung besitzen). */
export function requireAuth(permission?: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ message: 'Nicht angemeldet.' });
    if (req.user.mustChangePassword && !req.url.startsWith('/api/auth/')) {
      return reply.code(403).send({ message: 'Bitte zuerst das Passwort ändern.', code: 'MUST_CHANGE_PASSWORD' });
    }
    if (permission && !hasPermission(req.user.permissions, permission)) {
      return reply.code(403).send({ message: `Keine Berechtigung (${permission}).` });
    }
  };
}

/** Prüfung innerhalb eines Handlers, z. B. für Feldberechtigungen. */
export function can(req: FastifyRequest, permission: string): boolean {
  return !!req.user && hasPermission(req.user.permissions, permission);
}

/** Änderungskontext aus der Anfrage – für withChange(). */
export function changeCtx(req: FastifyRequest, extra: Partial<ChangeContext> = {}): ChangeContext {
  return { userId: req.user?.id ?? null, username: req.user?.username ?? 'anonym', ...extra };
}

/** Kurzform: Transaktion mit Änderungsbeleg im Namen des angemeldeten Benutzers. */
export function change<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>, extra: Partial<ChangeContext> = {}) {
  return withChange(changeCtx(req, extra), fn);
}
