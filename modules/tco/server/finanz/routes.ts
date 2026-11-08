import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../../../server/src/auth.js';
import { DB } from '../verein.js';
import { kontoart, jahreLesen, monatsverlauf, uebersicht } from './logik.js';

export const P_FINANZ = { display: 'tco.finanz:display' };

const jahr = z.coerce.number().int().min(1990).max(2100);

export async function finanzRoutes(app: FastifyInstance) {
  /** Geschäftsjahre mit Buchungen und Geldkonten für die Auswahl */
  app.get('/finanz/jahre', { preHandler: requireAuth(P_FINANZ.display) }, async () => {
    const konten = await DB`select konto, coalesce(name, '') as name, kennzahl from tco.fikonten order by konto`;
    return {
      jahre: await jahreLesen(DB),
      geldkonten: konten.filter((k) => kontoart(String(k.konto).trim(), k.kennzahl) === 'G').map((k) => ({ konto: String(k.konto).trim(), name: k.name })),
    };
  });

  /** Einnahmen/Ausgaben, Gewinn, Geldkonten, Jahresvergleich, Konten mit Vorjahr, Liquidität */
  app.get('/finanz/uebersicht', { preHandler: requireAuth(P_FINANZ.display) }, async (req) => {
    const q = z.object({ jahr: jahr.default(new Date().getFullYear()) }).parse(req.query);
    return uebersicht(DB, q.jahr);
  });

  /** Monatsverlauf über mehrere Jahre für gewählte Geldkonten (leer = alle) */
  app.get('/finanz/verlauf', { preHandler: requireAuth(P_FINANZ.display) }, async (req) => {
    const q = z.object({ jahre: z.string().min(1), konten: z.string().default('') }).parse(req.query);
    const js = q.jahre.split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x >= 1990 && x <= 2100);
    const konten = q.konten.split(',').map((x) => x.trim()).filter(Boolean);
    return monatsverlauf(DB, js, konten);
  });
}
