import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB } from '../verein.js';
import {
  abfrageLoeschen, abfrageSpeichern, abfragenLesen, angabeSpeichern, gruppenAuswahl, matrixCsv, matrixLesen, meineLesen, zurFamilie,
} from './logik.js';

/**
 * Mannschaftsmeldung / Anmeldematrix: Abfrage je Saison mit den Mannschaften aus den Mitgliedergruppen; jedes Mitglied gibt
 * je Mannschaft 1 = fest, 2 = Ersatz, 3 = nicht an (Mein Bereich → Mannschaftsmeldung), der Sportwart sieht und pflegt die
 * Matrix (Sport → Anmeldematrix).
 */
export const P_MM = { melden: 'tco.mannschaftsmeldung:melden', display: 'tco.anmeldematrix:display', edit: 'tco.anmeldematrix:edit' };

const wer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const id = z.object({ id: z.coerce.number().int().positive() });
const angabe = z.object({
  adrnr: z.string().min(1).max(20),
  wahl: z.array(z.object({ gruppe_id: z.number().int().positive(), wahl: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable() })).max(100),
  bemerkung: z.string().max(500).default(''),
});
const abfrage = z.object({
  titel: z.string().trim().min(1, 'Bitte einen Titel angeben.').max(120),
  saison: z.string().trim().max(40).default(''),
  frist: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  hinweis: z.string().max(2000).default(''),
  status: z.enum(['entwurf', 'offen', 'geschlossen']),
  gruppen: z.array(z.number().int().positive()).max(60),
});

async function eigeneAdrnr(req: FastifyRequest): Promise<string> {
  const [a] = req.user?.id ? await DB`select adrnr from tco.mitglied_benutzer where benutzer_id = ${req.user.id}` : [];
  if (!a) throw new BusinessError('Ihr Benutzer ist keinem Mitglied zugeordnet – die Mannschaftsmeldung ist nur für Mitglieder möglich.', 403);
  return a.adrnr as string;
}

export async function mannschaftsmeldungRoutes(app: FastifyInstance) {
  const melden = { preHandler: requireAuth(P_MM.melden) };
  const ansehen = { preHandler: requireAuth(P_MM.display) };
  const pflege = { preHandler: requireAuth(P_MM.edit) };

  // ---------------------------------------------------------------- Mein Bereich
  app.get('/mannschaftsmeldung/meine', melden, async (req) => meineLesen(DB, await eigeneAdrnr(req)));
  /** eigene Angabe oder die eines Familienmitglieds */
  app.post('/mannschaftsmeldung/meine/:id', melden, async (req) => {
    const { id: n } = id.parse(req.params);
    const b = angabe.parse(req.body);
    await zurFamilie(DB, await eigeneAdrnr(req), b.adrnr);
    return { text: await change(req, (tx) => angabeSpeichern(tx, n, b, wer(req), { verwaltung: false }), { action: 'MM_ANGABE' }) };
  });

  // ---------------------------------------------------------------- Anmeldematrix (Sportwart)
  app.get('/mannschaftsmeldung/abfragen', ansehen, async () => abfragenLesen(DB));
  app.get('/mannschaftsmeldung/gruppen', pflege, async () => gruppenAuswahl(DB));
  app.get('/mannschaftsmeldung/abfragen/:id', ansehen, async (req) => matrixLesen(DB, id.parse(req.params).id));
  app.get('/mannschaftsmeldung/abfragen/:id/csv', ansehen, async (req, reply) => {
    const { name, csv } = await matrixCsv(DB, id.parse(req.params).id);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.csv"`).send(csv);
  });
  app.post('/mannschaftsmeldung/abfragen', pflege, async (req) => {
    const b = abfrage.parse(req.body);
    return change(req, (tx) => abfrageSpeichern(tx, null, b), { action: 'MM_ABFRAGE' });
  });
  app.put('/mannschaftsmeldung/abfragen/:id', pflege, async (req) => {
    const { id: n } = id.parse(req.params);
    const b = abfrage.parse(req.body);
    return change(req, (tx) => abfrageSpeichern(tx, n, b), { action: 'MM_ABFRAGE' });
  });
  app.delete('/mannschaftsmeldung/abfragen/:id', pflege, async (req) => {
    const { id: n } = id.parse(req.params);
    return { text: await change(req, (tx) => abfrageLoeschen(tx, n), { action: 'MM_ABFRAGE_LOESCHEN' }) };
  });
  /** Angabe für ein Mitglied eintragen (z. B. auf Papier abgegeben) – auch nach der Frist */
  app.post('/mannschaftsmeldung/abfragen/:id/angabe', pflege, async (req) => {
    const { id: n } = id.parse(req.params);
    const b = angabe.parse(req.body);
    const [m] = await DB`select 1 from tco.mitglieder where adrnr = ${b.adrnr}`;
    if (!m) throw new BusinessError('Mitglied nicht gefunden.', 404);
    return { text: await change(req, (tx) => angabeSpeichern(tx, n, b, wer(req), { verwaltung: true }), { action: 'MM_ANGABE', reason: 'Sportwart' }) };
  });
}
