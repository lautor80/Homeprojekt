import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import {
  pushAbwahl, pushAbwahlSetzen, pushArtenFuer, pushGeraetAbmelden, pushGeraetAnmelden, pushGeraete, pushSchluessel, pushTest,
} from '../lib/push.js';
import { getSettings } from './settings.js';

/**
 * Push-Nachrichten aufs Handy (lib/push.ts): Jeder angemeldete Benutzer schaltet sie je Gerät selbst ein und aus und
 * wählt je Art, was er bekommen möchte (Benutzermenü → Benachrichtigungen).
 */
export async function pushRoutes(app: FastifyInstance) {
  const angemeldet = { preHandler: requireAuth() };
  const ich = (req: FastifyRequest): string => {
    if (!req.user?.id) throw new BusinessError('Bitte mit einem persönlichen Benutzer anmelden.', 403);
    return req.user.id;
  };
  const stand = async (req: FastifyRequest) => {
    const aus = await pushAbwahl(ich(req));
    return {
      schluessel: (await pushSchluessel()).oeffentlich,
      geraete: (await pushGeraete(ich(req))).map((g) => ({ id: g.id, name: g.name, erstellt_am: g.erstellt_am, zuletzt_am: g.zuletzt_am, endpoint: g.endpoint })),
      arten: pushArtenFuer(req).map((a) => ({ id: a.id, gruppe: a.gruppe, text: a.text, an: !aus.includes(a.id) })),
    };
  };

  /** Schlüssel für die Anmeldung im Browser, eigene Geräte, Arten mit Stand (an/aus) */
  app.get('/api/push', angemeldet, async (req) => stand(req));

  /** dieses Gerät anmelden (Angaben aus PushSubscription.toJSON() des Browsers) */
  app.post('/api/push/geraet', angemeldet, async (req) => {
    const b = z.object({
      endpoint: z.string().url().max(2000),
      keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
      name: z.string().trim().max(80).default(''),
    }).parse(req.body);
    await pushGeraetAnmelden(ich(req), { endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, name: b.name });
    return { ...(await stand(req)), text: 'Push-Nachrichten sind auf diesem Gerät eingeschaltet.' };
  });

  /** Gerät abmelden: dieses (endpoint) oder ein anderes eigenes (id) */
  app.post('/api/push/geraet/abmelden', angemeldet, async (req) => {
    const b = z.union([z.object({ id: z.coerce.number().int().positive() }), z.object({ endpoint: z.string().min(1).max(2000) })]).parse(req.body);
    await pushGeraetAbmelden(ich(req), b);
    return { ...(await stand(req)), text: 'Push-Nachrichten sind auf dem Gerät ausgeschaltet.' };
  });

  /** je Art ein- und ausschalten: `aus` = Arten, die der Benutzer nicht aufs Handy bekommen möchte */
  app.put('/api/push/arten', angemeldet, async (req) => {
    const b = z.object({ aus: z.array(z.string().max(80)).max(200) }).parse(req.body);
    await pushAbwahlSetzen(ich(req), pushArtenFuer(req).map((a) => a.id), b.aus);
    return { ...(await stand(req)), text: 'Auswahl gesichert.' };
  });

  /** Testnachricht an die eigenen Geräte */
  app.post('/api/push/test', angemeldet, async (req) => {
    const n = await pushTest(ich(req));
    if (!n) throw new BusinessError('Die Testnachricht ließ sich nicht senden. Bitte Push-Nachrichten auf diesem Gerät aus- und wieder einschalten.');
    return { text: n === 1 ? 'Testnachricht gesendet.' : `Testnachricht an ${n} Geräte gesendet.` };
  });

  /** App-Beschreibung für „Zum Home-Bildschirm“ (Name und Farbe der Organisation) – ohne Anmeldung, wie die Anmeldeseite */
  app.get('/api/push/manifest', async (_req, reply) => {
    const s = await getSettings(['org.name', 'org.color']);
    const name = (typeof s['org.name'] === 'string' && s['org.name'].trim()) || 'Portal';
    return reply.type('application/manifest+json').header('Cache-Control', 'no-cache').send({
      name, short_name: name.length > 12 ? 'Portal' : name, start_url: '/', scope: '/', display: 'standalone',
      background_color: '#ffffff', theme_color: typeof s['org.color'] === 'string' ? s['org.color'] : '#0a6ed1',
      icons: [
        { src: '/push-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/push-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    });
  });
}
