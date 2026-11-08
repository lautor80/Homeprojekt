import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { DB } from '../verein.js';
import { bestaendeLesen, bestandSpeichern, jahrVonStandard, speichern, uebersichtLesen, vorschlag } from './logik.js';

export const P_KONTEN = { display: 'tco.konten:display', edit: 'tco.konten:edit' };

const benutzer = (req: FastifyRequest) => req.user?.username || 'unbekannt';
const jahr = z.coerce.number().int().min(1990).max(2100);
/** Betrag oder null (= nicht gepflegt); null zuerst, damit coerce nicht 0 daraus macht */
const betrag = z.union([z.null(), z.coerce.number()]).optional().transform((v) => (v === undefined ? null : v));

const kontoSchema = z.object({
  konto: z.string().trim().max(10),
  name: z.string().max(30).default(''),
  kennzahl: z.string().max(2).default(''),
  profitcenter: z.string().max(30).default(''),
  neu: z.boolean().default(false),
  jahre: z.array(z.object({ jahr, aktiv: z.boolean() })).default([]),
});

export async function kontenRoutes(app: FastifyInstance) {
  /** Übersicht Konten × Jahresfenster (6 Jahre ab `von`) */
  app.get('/konten/uebersicht', { preHandler: requireAuth(P_KONTEN.display) }, async (req) => {
    const q = z.object({ von: jahr.optional() }).parse(req.query);
    return uebersichtLesen(DB, q.von ?? jahrVonStandard());
  });

  /** Geänderte und neue Konten sowie Jahreskennzeichen speichern */
  app.post('/konten/speichern', { preHandler: requireAuth(P_KONTEN.edit) }, async (req) => {
    const b = z.object({ zeilen: z.array(kontoSchema) }).parse(req.body);
    const r = await change(req, (tx) => speichern(tx, benutzer(req), b.zeilen));
    return { ...r, text: `Gespeichert: ${r.aenderungen} Änderung(en), ${r.neu} neue(s) Konto/Konten.` };
  });

  /** Vorschlag der Kontenverwendung für ein Jahr (nur Anzeige) */
  app.get('/konten/vorschlag', { preHandler: requireAuth(P_KONTEN.display) }, async (req) => {
    const q = z.object({ jahr }).parse(req.query);
    return vorschlag(DB, q.jahr);
  });

  // ---------------------------------------------------------------- Jahresanfangsbestände
  app.get('/konten/bestaende', { preHandler: requireAuth(P_KONTEN.display) }, async (req) => {
    const q = z.object({ jahr }).parse(req.query);
    return { jahr: q.jahr, zeilen: await bestaendeLesen(DB, q.jahr) };
  });

  app.put('/konten/bestand', { preHandler: requireAuth(P_KONTEN.edit) }, async (req) => {
    const b = z.object({ jahr, konto: z.string().trim().min(1), anfangsbestand: betrag, endbestand: betrag }).parse(req.body);
    const text = await change(req, (tx) => bestandSpeichern(tx, b));
    return { text };
  });
}
