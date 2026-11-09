import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { DB } from '../verein.js';
import { BEREICHE, erloeskontenLesen, neuerPreis, produktAnlegen, produktBeenden, produkteLesen, zeitraumAendern, type Bereich } from './logik.js';

export const P_PROD = { display: 'tco.produkte:display', edit: 'tco.produkte:edit' };

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const key = z.string().regex(/^\d{3}$/, 'Produktschlüssel dreistellig');
const preis = z.union([z.null(), z.literal(''), z.coerce.number()]).transform((v) => (v === '' || v == null ? null : Math.round(v * 100) / 100));
const eigenschaften = z.object({
  text: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben.').max(60),
  preis, preis_gast: preis.default(null),
  typ: z.string().trim().max(2).nullish(), menge: z.string().trim().max(10).nullish(),
  erloeskonto: z.string().trim().max(10).nullish().transform((v) => v || null),
});

export async function produkteRoutes(app: FastifyInstance) {
  app.get('/produkte', { preHandler: requireAuth(P_PROD.display) }, async () => ({
    produkte: await produkteLesen(DB),
    konten: await erloeskontenLesen(DB),
    bereiche: Object.entries(BEREICHE).map(([k, b]) => ({ key: k, text: b.text, von: b.von, bis: b.bis })),
  }));

  app.put('/produkte/:key/:ab', { preHandler: requireAuth(P_PROD.edit) }, async (req) => {
    const p = z.object({ key, ab: datum }).parse(req.params);
    const e = eigenschaften.parse(req.body);
    await change(req, (tx) => zeitraumAendern(tx, p.key, p.ab, e), { action: 'PRODUKT_AENDERN' });
    return { text: `Produkt ${p.key} gespeichert.` };
  });

  app.post('/produkte/:key/preis', { preHandler: requireAuth(P_PROD.edit) }, async (req) => {
    const p = z.object({ key }).parse(req.params);
    const b = eigenschaften.extend({ ab: datum }).parse(req.body);
    await change(req, (tx) => neuerPreis(tx, p.key, b.ab, b), { action: 'PRODUKT_PREIS' });
    return { text: `Neuer Preis für ${p.key} ab ${b.ab.split('-').reverse().join('.')} gespeichert.` };
  });

  app.post('/produkte', { preHandler: requireAuth(P_PROD.edit) }, async (req) => {
    const b = eigenschaften.extend({ ab: datum, bereich: z.enum(Object.keys(BEREICHE) as [Bereich, ...Bereich[]]) }).parse(req.body);
    const k = await change(req, (tx) => produktAnlegen(tx, b.bereich, b.ab, b), { action: 'PRODUKT_NEU' });
    return { prod_key: k, text: `Produkt ${k} „${b.text}“ angelegt.` };
  });

  app.post('/produkte/:key/beenden', { preHandler: requireAuth(P_PROD.edit) }, async (req) => {
    const p = z.object({ key }).parse(req.params);
    const b = z.object({ ab: datum }).parse(req.body);
    await change(req, (tx) => produktBeenden(tx, p.key, b.ab), { action: 'PRODUKT_BEENDEN' });
    return { text: `Produkt ${p.key} gilt bis ${b.ab.split('-').reverse().join('.')} (ausschließlich).` };
  });
}
