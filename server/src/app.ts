import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { sql } from './db.js';
import { registerAuth } from './auth.js';
import { apiKeyRoutes } from './routes/apikeys.js';
import { BusinessError } from './errors.js';
import { activeModules } from './modules.js';
import { setupRoutes } from './routes/setup.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { auditRoutes } from './routes/audit.js';
import { settingsRoutes } from './routes/settings.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cookie);
  registerAuth(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ');
      return reply.code(400).send({ message: msg });
    }
    if (err instanceof BusinessError) return reply.code(err.statusCode).send({ message: err.message });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.code(409).send({ message: 'Eintrag existiert bereits.' });
    if (pgCode === '23503') return reply.code(409).send({ message: 'Eintrag wird noch verwendet.' });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ message: e.message });
    req.log.error(err);
    return reply.code(500).send({ message: 'Interner Fehler. Details stehen im Server-Log.' });
  });

  app.get('/api/health', async () => {
    await sql`select 1`;
    return { status: 'ok' };
  });

  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(settingsRoutes);
  await app.register(adminRoutes);
  await app.register(auditRoutes);
  await app.register(apiKeyRoutes);

  for (const m of activeModules()) {
    if (m.routes) await app.register(async (scope) => m.routes!(scope), { prefix: `/api/m/${m.id}` });
  }

  // Oberfläche ausliefern (gebaute React-App), alle Nicht-API-Pfade -> index.html
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ message: 'Nicht gefunden.' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
