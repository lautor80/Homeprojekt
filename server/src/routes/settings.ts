import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { activeModules } from '../modules.js';
import { sql } from '../db.js';
import { change, requireAuth } from '../auth.js';

/** Einstellungen, die jeder angemeldete Benutzer (und die Login-Seite) sehen darf. */
const PUBLIC_KEYS = ['org.name', 'org.logo', 'org.color'] as const;

export async function getSettings(keys?: readonly string[]): Promise<Record<string, unknown>> {
  const rows = keys
    ? await sql`select key, value from core.settings where key = any(${keys as string[]})`
    : await sql`select key, value from core.settings order by key`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getPublicSettings(): Promise<Record<string, unknown>> {
  const s = await getSettings(PUBLIC_KEYS);
  const reg = activeModules().find((m) => m.registrierung)?.registrierung ?? null;
  return { ...s, registrierung: reg };
}

const settingsSchema = z.object({
  'org.name': z.string().min(1).max(100).optional(),
  // Logo als Data-URL (PNG/JPEG/SVG), max. ca. 300 KB
  'org.logo': z.string().max(400_000).regex(/^data:image\/(png|jpeg|svg\+xml);base64,/).nullable().optional(),
  'org.color': z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  'org.address': z.string().max(500).optional(),
  'integration.paperless.url': z.string().url().or(z.literal('')).optional(),
  'integration.n8n.url': z.string().url().or(z.literal('')).optional(),
});

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings/public', async () => getPublicSettings());

  app.get('/api/settings', { preHandler: requireAuth('core.settings:edit') }, async () => getSettings());

  app.put('/api/settings', { preHandler: requireAuth('core.settings:edit') }, async (req) => {
    const body = settingsSchema.parse(req.body);
    await change(req, async (tx) => {
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        if (value === null) {
          await tx`delete from core.settings where key = ${key}`;
          continue;
        }
        await tx`insert into core.settings (key, value) values (${key}, ${tx.json(value as never)})
                 on conflict (key) do update set value = excluded.value`;
      }
    });
    return getSettings();
  });
}
