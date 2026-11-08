import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../../../server/src/auth.js';
import { DB, vereinLesen } from '../verein.js';
import { auswaehlen, teilnehmerPdf, teilnehmerTitel } from './pdf.js';
import { mailtoLink, teilnehmerDetail, teilnehmerLesen } from './logik.js';

/** Die App zeigt nur an; eine Pflege gibt es (wie in SAP) nicht – Stammdaten werden unter „Mitglieder“ geändert. */
export const P_TN = { display: 'tco.teilnehmer:display' };

export async function teilnehmerRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_TN.display) };

  /** Trefferliste aller Teilnehmer (Filter, Suche und Sortierung laufen in der Oberfläche) */
  app.get('/teilnehmer', lesen, async () => {
    const t = await teilnehmerLesen(DB);
    return {
      teilnehmer: t, einheiten: t.reduce((s, x) => s + x.einheiten, 0),
      mitglieder: t.filter((x) => x.mitglied).length, nichtmitglieder: t.filter((x) => !x.mitglied).length,
    };
  });

  /** Teilnehmerliste als PDF im Vereinslayout – gleiche Auswahl wie in der App (Filter, Suche, Markierung) */
  app.get('/teilnehmer/pdf', lesen, async (req, reply) => {
    const q = z.object({
      filter: z.enum(['ALL', 'MEMBER', 'NONMEMBER']).default('ALL'),
      suche: z.string().max(100).default(''),
      adrnrs: z.string().max(20000).default(''),
    }).parse(req.query);
    const auswahl = { filter: q.filter, suche: q.suche, adrnrs: q.adrnrs.split(',').map((x) => x.trim()).filter(Boolean) };
    const rows = auswaehlen(await teilnehmerLesen(DB), auswahl);
    const pdf = await teilnehmerPdf(await vereinLesen(), rows, auswahl);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${teilnehmerTitel()}.pdf"`).send(pdf);
  });

  app.get('/teilnehmer/:adrnr', lesen, async (req) => {
    const { adrnr } = z.object({ adrnr: z.string().min(1).max(20) }).parse(req.params);
    return teilnehmerDetail(DB, adrnr);
  });

  /** mailto-Link für die markierten Teilnehmer (BCC) */
  app.post('/teilnehmer/mailto', lesen, async (req) => {
    const b = z.object({ adrnrs: z.array(z.string().min(1)).min(1, 'Bitte mindestens einen Teilnehmer markieren.') }).parse(req.body);
    const t = (await teilnehmerLesen(DB)).filter((x) => b.adrnrs.includes(x.adrnr));
    const url = mailtoLink(t.map((x) => x.email));
    return { url, anzahl: t.length, ohneEmail: t.filter((x) => !x.email).map((x) => x.name) };
  });
}
