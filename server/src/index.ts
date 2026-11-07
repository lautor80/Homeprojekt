import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { activeModules } from './modules.js';
import { sql } from './db.js';

async function waitForDb(retries = 30) {
  for (let i = 1; i <= retries; i++) {
    try {
      await sql`select 1`;
      return;
    } catch (e) {
      if (i === retries) throw e;
      console.log(`Warte auf Datenbank (${i}/${retries}) ...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  await waitForDb();
  await migrate(activeModules(), (m) => console.log(m));
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Aktive Module: ${config.modules.join(', ') || '(keine)'}`);

  const stop = async () => {
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
