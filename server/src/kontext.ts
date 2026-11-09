import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Anfragekontext: gibt Funktionen tief im Aufrufbaum Zugriff auf den angemeldeten Benutzer, ohne ihn durch jede
 * Signatur zu reichen (z. B. Mailversand mit dem Absender dessen, der auf „Senden“ drückt).
 * Muss vor registerAuth registriert werden; der Store hält die Anfrage, req.user setzt die Anmeldung danach.
 */
const als = new AsyncLocalStorage<{ req: FastifyRequest }>();

export function registerKontext(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => als.run({ req }, done));
}

/** angemeldeter Benutzer der laufenden Anfrage – null bei öffentlichen Aufrufen und Hintergrundläufen */
export function aktuellerBenutzer(): { id: string; username: string; displayName: string; email: string | null } | null {
  const u = als.getStore()?.req.user;
  return u ? { id: u.id, username: u.username, displayName: u.displayName, email: u.email } : null;
}
