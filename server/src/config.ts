import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sucht ab dem Ort dieser Datei aufwärts das Verzeichnis mit server/migrations. */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'server', 'migrations'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** Wurzelverzeichnis der Anwendung (enthält server/, modules/, web/dist). */
export const APP_ROOT = process.env.APP_ROOT ?? findRoot();

function list(v: string | undefined, fallback: string[]): string[] {
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://portal:portal@localhost:5432/portal',
  /** Aktive Fachmodule, z. B. "beispiel" oder "tco" bzw. "transport". */
  modules: list(process.env.PORTAL_MODULES, ['beispiel']),
  gotenbergUrl: process.env.GOTENBERG_URL ?? 'http://gotenberg:3000',
  /** Gültigkeit einer Sitzung in Stunden. */
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  /** Cookie nur über HTTPS senden (hinter Reverse Proxy mit TLS auf true setzen). */
  secureCookies: process.env.SECURE_COOKIES === 'true',
  webDist: path.join(APP_ROOT, 'web', 'dist'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
