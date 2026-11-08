import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB } from '../verein.js';
import {
  auswerten, csvExport, datenLesen, GRUPPEN, sichtStandard, SORTIERUNGEN, SPALTEN, varianteLesen, varianteLoeschen, varianteSichern,
  varianteStandard, variantenLesen, wertehilfen, type Sicht,
} from './logik.js';

export const P_AN = { display: 'tco.analyse:display' };

const benutzer = (req: FastifyRequest) => req.user?.username || 'unbekannt';
const txt = z.string().default('');
const filterSchema = z.object({
  status: z.enum(['', 'A', 'X']).default('A'),
  geschlecht: txt, altersgruppe: txt, ort: txt, plz: txt, zahlungsart: txt, zahlweise: txt,
  eintritt_von: txt, eintritt_bis: txt, alter_von: txt, alter_bis: txt, vertragsart: txt,
  vertrag_scope: z.enum(['', 'A', 'B']).default('A'), vertragsbest: z.enum(['', 'M', 'O']).default(''),
  sort_by: z.string().default('NACHNAME'), sort_desc: z.boolean().default(false),
});
const sichtSchema = z.object({
  filter: filterSchema.default({}), group_by: z.string().default(''), details: z.boolean().default(true), search: z.string().default(''),
  cols: z.array(z.string()).optional(),
}).transform((s): Sicht => ({
  ...s, cols: (s.cols ?? sichtStandard().cols).filter((c) => SPALTEN.some((x) => x.field === c)),
}));
const sichtAusQuery = (q: unknown) => {
  const { s } = z.object({ s: z.string().min(1, 'Sicht fehlt') }).parse(q);
  let j: unknown;
  try { j = JSON.parse(s); } catch { throw new BusinessError('Die Sicht ist nicht lesbar.'); }
  return sichtSchema.parse(j);
};

export async function analyseRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_AN.display) };

  /** Wertehilfen, Spalten, Varianten und (falls vorhanden) die Vorschlagsvariante */
  app.get('/analyse/init', lesen, async (req) => {
    const d = await datenLesen(DB);
    const std = await varianteStandard(DB, benutzer(req));
    return {
      werte: wertehilfen(d), spalten: SPALTEN, gruppen: GRUPPEN, sortierungen: SORTIERUNGEN,
      varianten: await variantenLesen(DB, benutzer(req)),
      variante: std?.v ?? null, sicht: std?.sicht ?? sichtStandard(),
    };
  });

  /** Auswertung zur übergebenen Sicht (Zeilen, Kennzahlen, Diagramme) */
  app.post('/analyse/daten', lesen, async (req) => auswerten(await datenLesen(DB), sichtSchema.parse(req.body ?? {})));

  /** CSV-Export der Trefferliste (UTF-8 mit BOM, Semikolon) */
  app.get('/analyse/export', lesen, async (req, reply) => {
    const s = sichtAusQuery(req.query);
    const e = auswerten(await datenLesen(DB), s);
    const name = `Mitglieder-Analyse_${new Date().toISOString().slice(0, 10)}.csv`;
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(csvExport(e.rows, s.cols));
  });

  // ---------------------------------------------------------------- Varianten
  app.get('/analyse/varianten', lesen, async (req) => variantenLesen(DB, benutzer(req)));

  app.get('/analyse/varianten/laden', lesen, async (req) => {
    const { key } = z.object({ key: z.string().min(1) }).parse(req.query);
    const r = await varianteLesen(DB, benutzer(req), key);
    if (!r) throw new BusinessError('Variante nicht gefunden.');
    return { variante: r.v, sicht: r.sicht };
  });

  app.post('/analyse/varianten', lesen, async (req) => {
    const b = z.object({
      name: z.string(), descr: z.string().max(60).default(''), global: z.boolean().default(false), isdef: z.boolean().default(false), sicht: sichtSchema,
    }).parse(req.body);
    const v = await change(req, (tx) => varianteSichern(tx, benutzer(req), b, b.sicht), { action: 'VARIANTE' });
    return { variante: v, varianten: await variantenLesen(DB, benutzer(req)), text: `Variante ${v.name} gesichert` };
  });

  app.post('/analyse/varianten/loeschen', lesen, async (req) => {
    const { key } = z.object({ key: z.string().min(1, 'Bitte eine Variante wählen.') }).parse(req.body);
    const name = await change(req, (tx) => varianteLoeschen(tx, benutzer(req), key), { action: 'VARIANTE' });
    return { varianten: await variantenLesen(DB, benutzer(req)), text: `Variante ${name} gelöscht` };
  });
}
