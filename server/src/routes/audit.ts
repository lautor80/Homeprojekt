import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { can, requireAuth } from '../auth.js';
import { auditObjects, sensitiveFields } from '../modules.js';
import { maskieren } from '../schutz.js';

/**
 * Maskierung geschützter Spalten: je Tabelle die Felder, deren Klartext der Benutzer nicht sehen darf.
 * Die Belege selbst bleiben unverändert gespeichert (Revisionssicherheit).
 */
function maskenFuer(req: FastifyRequest) {
  const m = new Map<string, Map<string, 'iban' | 'bic' | 'text'>>();
  for (const d of sensitiveFields()) {
    if (can(req, d.permission)) continue;
    const t = m.get(d.table) ?? new Map();
    for (const [f, art] of Object.entries(d.fields)) t.set(f, art);
    m.set(d.table, t);
  }
  return m;
}

async function loadDocs(req: FastifyRequest, where: { type?: string; key?: string; username?: string; from?: string; to?: string; limit: number }) {
  const masken = maskenFuer(req);
  const headers = await sql`
    select h.id, h.object_type as "objectType", h.object_key as "objectKey", h.table_name as "tableName",
           h.change_ind as "changeInd", h.action, h.reason, h.username, h.changed_at as "changedAt"
      from core.change_header h
     where true
       ${where.type ? sql`and h.object_type = ${where.type}` : sql``}
       ${where.key ? sql`and h.object_key = ${where.key}` : sql``}
       ${where.username ? sql`and lower(h.username) = lower(${where.username})` : sql``}
       ${where.from ? sql`and h.changed_at >= ${where.from}::date` : sql``}
       ${where.to ? sql`and h.changed_at < (${where.to}::date + 1)` : sql``}
     order by h.changed_at desc, h.id desc
     limit ${where.limit}`;
  if (!headers.length) return [];
  const items = await sql`
    select header_id as "headerId", field, old_value as "oldValue", new_value as "newValue"
      from core.change_item where header_id = any(${headers.map((h) => h.id)})
     order by id`;
  const tabelle = new Map(headers.map((h) => [String(h.id), String(h.tableName)]));
  const byHeader = new Map<string, unknown[]>();
  for (const i of items) {
    const k = String(i.headerId);
    if (!byHeader.has(k)) byHeader.set(k, []);
    const art = masken.get(tabelle.get(k) ?? '')?.get(String(i.field));
    byHeader.get(k)!.push(art
      ? { field: i.field, oldValue: maskieren(i.oldValue, art), newValue: maskieren(i.newValue, art), masked: true }
      : { field: i.field, oldValue: i.oldValue, newValue: i.newValue });
  }
  return headers.map((h) => ({ ...h, id: String(h.id), items: byHeader.get(String(h.id)) ?? [] }));
}

function mayDisplayObject(req: FastifyRequest, type: string): boolean {
  if (can(req, 'core.audit:display')) return true;
  const def = auditObjects().find((o) => o.type === type);
  return !!def && can(req, def.permission);
}

export async function auditRoutes(app: FastifyInstance) {
  app.get('/api/audit/object-types', { preHandler: requireAuth() }, async () => auditObjects());

  /** Freie Suche über alle Änderungsbelege (z. B. für Kassenprüfer). */
  app.get('/api/audit', { preHandler: requireAuth('core.audit:display') }, async (req) => {
    const q = z.object({
      objectType: z.string().optional(),
      objectKey: z.string().optional(),
      username: z.string().optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.coerce.number().int().min(1).max(2000).default(500),
    }).parse(req.query);
    return loadDocs(req, { type: q.objectType, key: q.objectKey, username: q.username, from: q.from, to: q.to, limit: q.limit });
  });

  /** Historie eines einzelnen Objekts – Button "Änderungshistorie" in den Fachanwendungen. */
  app.get('/api/audit/object/:type/:key', { preHandler: requireAuth() }, async (req, reply) => {
    const { type, key } = z.object({ type: z.string(), key: z.string() }).parse(req.params);
    if (!mayDisplayObject(req, type)) return reply.code(403).send({ message: 'Keine Berechtigung für diese Historie.' });
    return loadDocs(req, { type, key, limit: 1000 });
  });
}
