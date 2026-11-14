import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { sql } from './db.js';
import { registerAuth } from './auth.js';
import { registerKontext } from './kontext.js';
import { apiKeyRoutes } from './routes/apikeys.js';
import { BusinessError } from './errors.js';
import { activeModules } from './modules.js';
import { setupRoutes } from './routes/setup.js';
import { authRoutes } from './routes/auth.js';
import { weltenwandlerRoutes } from './routes/weltenwandler.js';
import { adminRoutes } from './routes/admin.js';
import { auditRoutes } from './routes/audit.js';
import { settingsRoutes } from './routes/settings.js';
import { paperlessMappingRoutes } from './routes/paperless.js';
import { verbindungenRoutes } from './routes/verbindungen.js';
import { mailRoutes } from './routes/mail.js';
import { backupRoutes } from './routes/backup.js';
import { statistikRoutes } from './routes/statistik.js';
import { sperrRoutes } from './routes/sperren.js';
import { tabellenRoutes } from './routes/tabellen.js';
import { variantenRoutes } from './routes/varianten.js';
import { funktionenRoutes, registerFunktionen } from './routes/funktionen.js';
import { arbeitsvorratRoutes } from './routes/arbeitsvorrat.js';
import { schalterLaden } from './lib/funktionen.js';
import { GesperrtError } from './sperren.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cookie);
  registerKontext(app);
  registerAuth(app);
  registerFunktionen(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ');
      return reply.code(400).send({ message: msg });
    }
    if (err instanceof GesperrtError) return reply.code(423).send({ message: err.message, code: 'GESPERRT', inhaber: err.inhaber });
    if (err instanceof BusinessError) return reply.code(err.statusCode).send({ message: err.message });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === 'LK423') return reply.code(423).send({ message: (err as Error).message, code: 'GESPERRT' });
    // fachliche Sperre aus einem Datenbank-Trigger (z. B. abgeschlossene FI-Periode, #3): Meldung des Triggers anzeigen
    if (pgCode === 'FP409') return reply.code(409).send({ message: (err as Error).message });
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
  await app.register(weltenwandlerRoutes);
  await app.register(settingsRoutes);
  await app.register(paperlessMappingRoutes);
  await app.register(verbindungenRoutes);
  await app.register(mailRoutes);
  await app.register(backupRoutes);
  await app.register(statistikRoutes);
  await app.register(sperrRoutes);
  await app.register(tabellenRoutes);
  await app.register(variantenRoutes);
  await app.register(funktionenRoutes);
  await app.register(arbeitsvorratRoutes);
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

  // Funktionsschalter (#232, F1) schon beim Start laden – automatische Läufe fragen den Stand ab, bevor die erste Anfrage kommt
  await schalterLaden().catch((e) => app.log.warn(e, 'Funktionsschalter beim Start nicht ladbar'));

  return app;
}
