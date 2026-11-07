import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { change, requireAuth, sha256 } from '../auth.js';
import { activeModules } from '../modules.js';
import { BusinessError } from '../errors.js';

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT').nullish().or(z.literal('').transform(() => null));

const keyBody = z.object({
  name: z.string().trim().min(2, 'Bitte einen Namen angeben.').max(60)
    .regex(/^[A-Za-z0-9 ._-]+$/, 'Name: nur Buchstaben, Ziffern, Leerzeichen und . _ -'),
  permissions: z.array(z.string()).default([]),
  expires_on: datum,
});

/** Prüft, dass nur Berechtigungen des gewählten Moduls vergeben werden. */
function modulRechte(module: string, perms: string[]): string[] {
  const m = activeModules().find((x) => x.id === module);
  if (!m) throw new BusinessError(`Modul „${module}“ ist nicht aktiv.`);
  const erlaubt = new Set(m.permissions.map((p) => p.id));
  const falsch = perms.filter((p) => !erlaubt.has(p));
  if (falsch.length) throw new BusinessError(`Berechtigungen gehören nicht zum Modul ${module}: ${falsch.join(', ')}`);
  return [...new Set(perms)].sort();
}

const neuerSchluessel = (module: string) => `pk_${module}_${crypto.randomBytes(32).toString('base64url')}`;

export async function apiKeyRoutes(app: FastifyInstance) {
  /** Für den Aufrufer: Infos zum eigenen Schlüssel (Verbindungstest). */
  app.get('/api/key', async (req, reply) => {
    if (!req.user?.apiKey) return reply.code(401).send({ message: 'Nur mit API-Schlüssel (Authorization: Bearer …).' });
    const [k] = await sql`select module, name, permissions, expires_on from core.api_keys where id = ${req.user.apiKey.id}`;
    return k;
  });

  app.get('/api/admin/api-keys', { preHandler: requireAuth('core.apikeys:display') }, async () => {
    const mods = new Map(activeModules().map((m) => [m.id, m.name]));
    const rows = await sql`
      select id, module, name, prefix, permissions, to_char(expires_on, 'YYYY-MM-DD') as expires_on, active,
             created_at, created_by, last_used_at, last_used_ip
        from core.api_keys order by module, name`;
    return rows.map((r) => ({
      ...r,
      moduleName: mods.get(r.module) ?? `${r.module} (inaktiv)`,
      status: !r.active ? 'Gesperrt' : r.expires_on && r.expires_on < new Date().toISOString().slice(0, 10) ? 'Abgelaufen' : 'Aktiv',
    }));
  });

  app.post('/api/admin/api-keys', { preHandler: requireAuth('core.apikeys:edit') }, async (req) => {
    const body = keyBody.extend({ module: z.string().min(1) }).parse(req.body);
    const perms = modulRechte(body.module, body.permissions);
    const key = neuerSchluessel(body.module);
    const prefix = key.slice(0, `pk_${body.module}_`.length + 4);
    const [r] = await change(req, (tx) => tx`
      insert into core.api_keys (module, name, prefix, key_hash, permissions, expires_on, created_by)
      values (${body.module}, ${body.name}, ${prefix}, ${sha256(key)}, ${perms}, ${body.expires_on ?? null}, ${req.user!.username})
      returning id`);
    return { id: r.id, key };
  });

  app.put('/api/admin/api-keys/:id', { preHandler: requireAuth('core.apikeys:edit') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = keyBody.parse(req.body);
    const [k] = await sql`select module from core.api_keys where id = ${id}`;
    if (!k) throw new BusinessError('API-Schlüssel nicht gefunden.');
    const perms = modulRechte(k.module, body.permissions);
    await change(req, (tx) => tx`
      update core.api_keys set name = ${body.name}, permissions = ${perms}, expires_on = ${body.expires_on ?? null}
       where id = ${id}`);
    return { ok: true };
  });

  /** Sperren / Entsperren – mit Begründung für den Änderungsbeleg. */
  app.post('/api/admin/api-keys/:id/active', { preHandler: requireAuth('core.apikeys:edit') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { active, reason } = z.object({ active: z.boolean(), reason: z.string().trim().min(1, 'Bitte eine Begründung angeben.') }).parse(req.body);
    const n = await change(req, (tx) => tx`update core.api_keys set active = ${active} where id = ${id}`,
      { action: active ? 'ENTSPERREN' : 'SPERREN', reason });
    if (!n.count) throw new BusinessError('API-Schlüssel nicht gefunden.');
    return { ok: true };
  });

  /** Neuen Schlüssel erzeugen – der alte ist sofort ungültig. */
  app.post('/api/admin/api-keys/:id/rotate', { preHandler: requireAuth('core.apikeys:edit') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [k] = await sql`select module from core.api_keys where id = ${id}`;
    if (!k) throw new BusinessError('API-Schlüssel nicht gefunden.');
    const key = neuerSchluessel(k.module);
    const prefix = key.slice(0, `pk_${k.module}_`.length + 4);
    await change(req, (tx) => tx`update core.api_keys set key_hash = ${sha256(key)}, prefix = ${prefix} where id = ${id}`,
      { action: 'NEUER_SCHLUESSEL' });
    return { key };
  });
}
