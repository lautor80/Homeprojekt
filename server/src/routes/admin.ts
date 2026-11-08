import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, type Tx } from '../db.js';
import { change, hashPassword, requireAuth, validatePassword } from '../auth.js';
import { permissionCatalog } from '../modules.js';
import { BusinessError } from '../errors.js';


/** Es muss immer mindestens ein aktiver Administrator übrig bleiben. */
async function assertAdminRemains(tx: Tx) {
  const [{ n }] = await tx`
    select count(*)::int as n
      from core.users u join core.user_roles ur on ur.user_id = u.id
     where u.active and ur.role_id = 'ADMIN'`;
  if (n === 0) throw new BusinessError('Es muss mindestens ein aktiver Administrator bestehen bleiben.');
}

async function setUserRoles(tx: Tx, userId: string, roles: string[]) {
  const current = (await tx`select role_id from core.user_roles where user_id = ${userId}`).map((r) => r.role_id as string);
  const remove = current.filter((r) => !roles.includes(r));
  const add = roles.filter((r) => !current.includes(r));
  if (remove.length) await tx`delete from core.user_roles where user_id = ${userId} and role_id = any(${remove})`;
  for (const r of add) await tx`insert into core.user_roles (user_id, role_id) values (${userId}, ${r})`;
}

async function setRolePermissions(tx: Tx, roleId: string, perms: string[]) {
  const current = (await tx`select permission from core.role_permissions where role_id = ${roleId}`).map((r) => r.permission as string);
  const remove = current.filter((p) => !perms.includes(p));
  const add = perms.filter((p) => !current.includes(p));
  if (remove.length) await tx`delete from core.role_permissions where role_id = ${roleId} and permission = any(${remove})`;
  for (const p of add) await tx`insert into core.role_permissions (role_id, permission) values (${roleId}, ${p})`;
}

const userBase = z.object({
  displayName: z.string().min(1).max(100),
  email: z.string().email().or(z.literal('')).nullable().optional(),
  roles: z.array(z.string()).default([]),
});

export async function adminRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ Benutzer
  app.get('/api/admin/users', { preHandler: requireAuth('core.users:display') }, async () => {
    return sql`
      select u.id, u.username, u.display_name as "displayName", u.email, u.active,
             u.must_change_password as "mustChangePassword", u.last_login_at as "lastLoginAt",
             u.created_at as "createdAt",
             coalesce(array_agg(ur.role_id order by ur.role_id) filter (where ur.role_id is not null), '{}') as roles
        from core.users u left join core.user_roles ur on ur.user_id = u.id
       group by u.id
       order by lower(u.username)`;
  });

  app.post('/api/admin/users', { preHandler: requireAuth('core.users:edit') }, async (req, reply) => {
    const body = userBase.extend({
      username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9._@+-]+$/, 'Nur Buchstaben, Ziffern, . _ - @'),
      password: z.string(),
    }).parse(req.body);
    const err = validatePassword(body.password);
    if (err) return reply.code(400).send({ message: err });
    const [exists] = await sql`select 1 from core.users where lower(username) = lower(${body.username})`;
    if (exists) return reply.code(409).send({ message: 'Benutzername ist bereits vergeben.' });

    const h = await hashPassword(body.password);
    const id = await change(req, async (tx) => {
      const [u] = await tx`
        insert into core.users (username, display_name, email, password_hash, must_change_password)
        values (${body.username}, ${body.displayName}, ${body.email || null}, ${h}, true)
        returning id`;
      await setUserRoles(tx, u.id, body.roles);
      return u.id as string;
    });
    return { id };
  });

  app.put('/api/admin/users/:id', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = userBase.extend({ active: z.boolean() }).parse(req.body);
    await change(req, async (tx) => {
      await tx`update core.users
                  set display_name = ${body.displayName}, email = ${body.email || null}, active = ${body.active}
                where id = ${id}`;
      await setUserRoles(tx, id, body.roles);
      await assertAdminRemains(tx);
      if (!body.active) await tx`delete from core.sessions where user_id = ${id}`;
    });
    return { ok: true };
  });

  /** Benutzer direkt aus der Tabelle sperren/entsperren */
  app.post('/api/admin/users/:id/aktiv', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { aktiv } = z.object({ aktiv: z.boolean() }).parse(req.body);
    if (!aktiv && id === req.user!.id) throw new BusinessError('Der eigene Benutzer kann nicht gesperrt werden.');
    const [u] = await change(req, async (tx) => {
      const r = await tx`update core.users set active = ${aktiv} where id = ${id} returning username, display_name`;
      if (!r.length) throw new BusinessError('Benutzer nicht gefunden.', 404);
      await assertAdminRemains(tx);
      if (!aktiv) await tx`delete from core.sessions where user_id = ${id}`;
      return r;
    }, { action: aktiv ? 'ENTSPERREN' : 'SPERREN' });
    return { text: `${u.display_name || u.username} ${aktiv ? 'entsperrt' : 'gesperrt – alle Sitzungen beendet'}.` };
  });

  app.post('/api/admin/users/:id/password', { preHandler: requireAuth('core.users:edit') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const err = validatePassword(password);
    if (err) return reply.code(400).send({ message: err });
    const h = await hashPassword(password);
    await change(req, async (tx) => {
      await tx`update core.users set password_hash = ${h}, must_change_password = true where id = ${id}`;
      await tx`delete from core.sessions where user_id = ${id}`;
    }, { action: 'PASSWORT_RESET' });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Rollen
  app.get('/api/admin/permissions', { preHandler: requireAuth('core.roles:display') }, async () => permissionCatalog());

  app.get('/api/admin/roles', { preHandler: requireAuth('core.roles:display') }, async () => {
    return sql`
      select r.id, r.name, r.description, r.system,
             coalesce((select array_agg(permission order by permission) from core.role_permissions p where p.role_id = r.id), '{}') as permissions,
             (select count(*)::int from core.user_roles ur where ur.role_id = r.id) as "userCount"
        from core.roles r
       order by r.system desc, r.id`;
  });

  const roleBody = z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullable().optional(),
    permissions: z.array(z.string()).default([]),
  });

  app.post('/api/admin/roles', { preHandler: requireAuth('core.roles:edit') }, async (req, reply) => {
    const body = roleBody.extend({
      id: z.string().min(2).max(40).regex(/^[A-Z0-9_]+$/, 'Nur Großbuchstaben, Ziffern und _'),
    }).parse(req.body);
    const [exists] = await sql`select 1 from core.roles where id = ${body.id}`;
    if (exists) return reply.code(409).send({ message: 'Rolle existiert bereits.' });
    await change(req, async (tx) => {
      await tx`insert into core.roles (id, name, description) values (${body.id}, ${body.name}, ${body.description ?? null})`;
      await setRolePermissions(tx, body.id, body.permissions.filter((p) => p !== '*'));
    });
    return { id: body.id };
  });

  app.put('/api/admin/roles/:id', { preHandler: requireAuth('core.roles:edit') }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = roleBody.parse(req.body);
    await change(req, async (tx) => {
      const [r] = await tx`select system from core.roles where id = ${id}`;
      if (!r) throw new BusinessError('Rolle nicht gefunden.');
      await tx`update core.roles set name = ${body.name}, description = ${body.description ?? null} where id = ${id}`;
      // Berechtigungen von Systemrollen (ADMIN) sind fest
      if (!r.system) await setRolePermissions(tx, id, body.permissions.filter((p) => p !== '*'));
    });
    return { ok: true };
  });

  /** Benutzer einer Rolle */
  app.get('/api/admin/roles/:id/users', { preHandler: requireAuth('core.roles:display') }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return sql`select u.id, u.username, u.display_name as "displayName", u.email, u.active, u.last_login_at as "lastLoginAt",
                      (select count(*)::int from core.user_roles x where x.user_id = u.id) as "rollen"
                 from core.user_roles ur join core.users u on u.id = ur.user_id
                where ur.role_id = ${id} order by lower(u.display_name), lower(u.username)`;
  });

  /** Rolle einzelnen Benutzern entziehen */
  app.post('/api/admin/roles/:id/entziehen', { preHandler: requireAuth('core.users:edit') }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { benutzer } = z.object({ benutzer: z.array(z.string().uuid()).min(1, 'Bitte mindestens einen Benutzer wählen.') }).parse(req.body);
    if (id === 'ADMIN') {
      if (benutzer.includes(req.user!.id)) throw new BusinessError('Die eigene Administratorrolle kann nicht entzogen werden.');
      const [{ n }] = await sql`select count(*)::int as n from core.user_roles ur join core.users u on u.id = ur.user_id
                                 where ur.role_id = 'ADMIN' and u.active and not (u.id = any(${benutzer}::uuid[]))`;
      if (!n) throw new BusinessError('Mindestens ein aktiver Administrator muss bleiben.');
    }
    const n = await change(req, async (tx) => (await tx`delete from core.user_roles where role_id = ${id} and user_id = any(${benutzer}::uuid[])`).count,
      { action: 'ROLLE_ENTZIEHEN', reason: id });
    return { text: `Rolle ${id} ${n} Benutzer(n) entzogen.` };
  });

  app.delete('/api/admin/roles/:id', { preHandler: requireAuth('core.roles:edit') }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return change(req, async (tx) => {
      const [r] = await tx`select system from core.roles where id = ${id}`;
      if (!r) throw new BusinessError('Rolle nicht gefunden.');
      if (r.system) throw new BusinessError('Systemrollen können nicht gelöscht werden.');
      await tx`delete from core.role_permissions where role_id = ${id}`;
      const n = (await tx`delete from core.user_roles where role_id = ${id}`).count;
      await tx`delete from core.roles where id = ${id}`;
      return n;
    }, { action: 'ROLLE_LOESCHEN', reason: id }).then((n) => ({ ok: true, text: `Rolle ${id} gelöscht${n ? ` und ${n} Benutzer(n) entzogen` : ''}.` }));
  });
}

