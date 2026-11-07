import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, withChange, type ChangeContext, type Tx } from './db.js';
import { config, modulAktiv } from './config.js';
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
  /** gesetzt, wenn die Anfrage mit einem API-Schlüssel kommt */
  apiKey?: { id: string; module: string; name: string };
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

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

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

    // API-Schlüssel: kein Cookie, daher kein CSRF-Risiko; nur Modul-Schnittstellen
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) return apiKeyAuth(req, reply, authz.slice(7).trim());

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

const API_KEY_RE = /^pk_([a-z0-9_]+?)_[A-Za-z0-9_-]{32,}$/;
const keyFailures = new Map<string, { count: number; until: number }>();

async function apiKeyAuth(req: FastifyRequest, reply: FastifyReply, key: string) {
  const f = keyFailures.get(req.ip);
  if (f && f.count >= 20 && f.until > Date.now()) {
    return reply.code(429).send({ message: 'Zu viele ungültige API-Schlüssel. Bitte später erneut versuchen.' });
  }
  const [k] = API_KEY_RE.test(key)
    ? await sql`select id, module, name, permissions from core.api_keys
                 where key_hash = ${sha256(key)} and active
                   and (expires_on is null or expires_on >= current_date)`
    : [];
  if (!k || !modulAktiv(k.module)) {
    const n = f && f.until > Date.now() ? f.count + 1 : 1;
    keyFailures.set(req.ip, { count: n, until: Date.now() + 15 * 60_000 });
    return reply.code(401).send({ message: 'Ungültiger, gesperrter oder abgelaufener API-Schlüssel.' });
  }
  const path = req.url.split('?')[0];
  if (path !== '/api/key' && !path.startsWith(`/api/m/${k.module}/`)) {
    return reply.code(403).send({ message: `Dieser API-Schlüssel gilt nur für das Modul „${k.module}“.` });
  }
  // nur Berechtigungen des eigenen Moduls zählen
  const perms = (k.permissions as string[]).filter((p) => p.startsWith(`${k.module}.`));
  req.user = {
    id: '',
    username: `api:${k.name}`,
    displayName: `API-Schlüssel ${k.name}`,
    email: null,
    mustChangePassword: false,
    roles: [],
    permissions: new Set(perms),
    apiKey: { id: k.id, module: k.module, name: k.name },
  };
  await sql`update core.api_keys set last_used_at = now(), last_used_ip = ${req.ip}
             where id = ${k.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
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
  return { userId: req.user?.id || null, username: req.user?.username ?? 'anonym', ...extra };
}

/** Kurzform: Transaktion mit Änderungsbeleg im Namen des angemeldeten Benutzers. */
export function change<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>, extra: Partial<ChangeContext> = {}) {
  return withChange(changeCtx(req, extra), fn);
}
