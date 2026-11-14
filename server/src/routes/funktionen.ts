import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import { alleKnoten, schalterAktuell, schalterLaden, schalterSpeichern, stand } from '../lib/funktionen.js';
import { FUNKTION_AUS, funktionAusText, routeAbgeschaltet } from '../funktionsschalter.js';

/** Funktionsschalter (#232, F1): Pflege unter Administration → Einstellungen → Funktionen und die Durchsetzung an den Routen */
const P = 'core.funktionen:edit';

/** Vor jeder Anfrage: Zustand aktuell halten und Routen abgeschalteter Funktionen abweisen – auch ohne Anmeldung (öffentliche Formulare) */
export function registerFunktionen(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    try { await schalterAktuell(); } catch (e) { req.log.warn(e, 'Funktionsschalter nicht ladbar – letzter Stand gilt weiter'); }
    const muster = req.routeOptions?.url;
    if (!muster) return;
    const funktion = routeAbgeschaltet(req.method, muster);
    if (funktion) return reply.code(403).send({ message: funktionAusText(funktion, !!req.user), code: FUNKTION_AUS });
  });
}

export async function funktionenRoutes(app: FastifyInstance) {
  /** das ganze Verzeichnis mit Stand je Knoten */
  app.get('/api/funktionen', { preHandler: requireAuth(P) }, async () => {
    await schalterLaden();
    return stand();
  });

  /** einen Schalter setzen – wirkt sofort für alle Benutzer */
  app.put('/api/funktionen', { preHandler: requireAuth(P) }, async (req) => {
    const b = z.object({ id: z.string().min(1).max(300), aktiv: z.boolean() }).parse(req.body);
    const k = alleKnoten().find((x) => x.id === b.id);
    // Unbekannte Ids (umbenannte oder entfallene Funktionen) lassen sich nur noch einschalten, also aufräumen
    if (!k && !b.aktiv) throw new BusinessError('Diese Funktion gibt es nicht.', 404);
    if (k?.fest && !b.aktiv) throw new BusinessError(`„${k.text}“ lässt sich nicht abschalten: ${k.fest}`);
    await change(req, (tx) => schalterSpeichern(tx, b.id, b.aktiv, req.user?.username ?? 'system'),
      { action: b.aktiv ? 'FUNKTION_AN' : 'FUNKTION_AUS', reason: k?.text ?? b.id });
    await schalterLaden();
    return stand();
  });
}
