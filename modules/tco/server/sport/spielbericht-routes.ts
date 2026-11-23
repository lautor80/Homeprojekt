import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { DB, vereinLesen } from '../verein.js';
import {
  berichtLesen, berichtSpeichern, einreichen, freigeben, listeLesen, listeLoeschen, listenLesen, listeSpeichern, listeVorschau,
  spieltageImportieren, spieltageLesen, spieltageVorschau, spieltagLoeschen, zuruecknehmen,
} from './spielbericht.js';
import { berichtPdf, berichtTitel } from './spielbericht-pdf.js';

/**
 * Spielberichte (Sport → Spielberichte): Mannschaftsspieltage, Meldelisten (Import aus STB.LIGA.NU) und Spielbericht je
 * Spieltag nach dem DTB-Formular. Ansehen · Erfassen/Freigeben/Einreichen · Spieltage und Meldelisten importieren.
 */
export const P_SB = { display: 'tco.spielbericht:display', edit: 'tco.spielbericht:edit', import: 'tco.spielbericht:import' };

const wer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const id = z.object({ id: z.coerce.number().int().positive() });
const text = z.string().max(200_000);
const kurz = (max: number, leer = 'Bitte ausfüllen.') => z.string().trim().min(1, leer).max(max);

const zahl = z.number().int().min(0).max(99).nullable();
const spieler = z.object({
  rang: z.number().int().min(1).max(999).nullable(), name: z.string().trim().min(1).max(120),
  id_nr: z.string().trim().max(20).nullable(), mannschaft: z.number().int().min(1).max(99).nullable().optional(),
}).nullable();
const match = (n: number) => z.object({
  a: z.array(spieler).length(n), b: z.array(spieler).length(n),
  saetze: z.array(z.tuple([zahl, zahl])).length(3),
  wertung: z.enum(['gespielt', 'aufgabe', 'wo']), sieger: z.enum(['a', 'b']).nullable(),
});
const zeit = z.string().regex(/^(\d{2}:\d{2})?$/, 'Uhrzeit im Format HH:MM');
const datenSchema = z.object({
  format: z.enum(['6er', '4er']),
  osr: z.string().trim().max(120), zuschauer: z.number().int().min(0).max(99_999).nullable(),
  beginn: zeit, ende: zeit, bemerkungen: z.string().max(2000),
  einzel: z.array(match(1)).min(4).max(6), doppel: z.array(match(2)).min(2).max(3),
}).refine((d) => (d.format === '6er' ? d.einzel.length === 6 && d.doppel.length === 3 : d.einzel.length === 4 && d.doppel.length === 2),
  'Anzahl der Einzel und Doppel passt nicht zum Format.');

const spieltagZeile = z.object({
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), uhrzeit: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  nr: z.string().max(20), halle: z.string().max(120), platz: z.string().max(60),
  liga: kurz(120, 'Liga fehlt'), heim: kurz(120, 'Heimmannschaft fehlt'), gast: kurz(120, 'Gastmannschaft fehlt'),
});

export async function spielberichtRoutes(app: FastifyInstance) {
  const ansehen = { preHandler: requireAuth(P_SB.display) };
  const pflege = { preHandler: requireAuth(P_SB.edit) };
  const imp = { preHandler: requireAuth(P_SB.import) };

  // ---------------------------------------------------------------- Spieltage
  app.get('/sport/spielberichte/spieltage', ansehen, async () => spieltageLesen(DB));
  /** eingefügten Spielplan aus STB.LIGA.NU lesen – schreibt nichts */
  app.post('/sport/spielberichte/spieltage/vorschau', imp, async (req) => spieltageVorschau(DB, z.object({ text }).parse(req.body).text));
  app.post('/sport/spielberichte/spieltage', imp, async (req) => {
    const b = z.object({ zeilen: z.array(spieltagZeile).min(1, 'Bitte mindestens einen Spieltag auswählen.').max(300) }).parse(req.body);
    return { text: await change(req, (tx) => spieltageImportieren(tx, b.zeilen), { action: 'SB_SPIELTAGE', reason: 'Import STB.LIGA.NU' }) };
  });
  app.delete('/sport/spielberichte/spieltage/:id', imp, async (req) => {
    const { id: n } = id.parse(req.params);
    return { text: await change(req, (tx) => spieltagLoeschen(tx, n), { action: 'SB_SPIELTAG_LOESCHEN' }) };
  });

  // ---------------------------------------------------------------- Meldelisten
  app.get('/sport/spielberichte/meldelisten', ansehen, async () => listenLesen(DB));
  app.get('/sport/spielberichte/meldelisten/:id', ansehen, async (req) => listeLesen(DB, id.parse(req.params).id));
  /** eingefügte Meldeliste lesen – schreibt nichts */
  app.post('/sport/spielberichte/meldelisten/vorschau', imp, async (req) => listeVorschau(z.object({ text }).parse(req.body).text));
  app.post('/sport/spielberichte/meldelisten', imp, async (req) => {
    const b = z.object({ saison: kurz(40, 'Bitte die Saison angeben.'), verein: kurz(120, 'Bitte den Verein angeben.'), konkurrenz: kurz(60, 'Bitte die Konkurrenz angeben (z. B. Herren 40).'), text }).parse(req.body);
    return change(req, (tx) => listeSpeichern(tx, b), { action: 'SB_MELDELISTE', reason: `${b.verein} ${b.konkurrenz}` });
  });
  app.delete('/sport/spielberichte/meldelisten/:id', imp, async (req) => {
    const { id: n } = id.parse(req.params);
    return { text: await change(req, (tx) => listeLoeschen(tx, n), { action: 'SB_MELDELISTE_LOESCHEN' }) };
  });

  // ---------------------------------------------------------------- Spielbericht
  app.get('/sport/spielberichte/:id', ansehen, async (req) => berichtLesen(DB, id.parse(req.params).id));
  app.put('/sport/spielberichte/:id', pflege, async (req) => {
    const { id: n } = id.parse(req.params);
    const { daten } = z.object({ daten: datenSchema }).parse(req.body);
    return { text: await change(req, (tx) => berichtSpeichern(tx, n, daten), { action: 'SB_BERICHT' }) };
  });
  /** Freigabe statt Unterschrift: name = null nimmt sie zurück */
  app.post('/sport/spielberichte/:id/freigabe', pflege, async (req) => {
    const { id: n } = id.parse(req.params);
    const b = z.object({ rolle: z.enum(['heim', 'gast', 'osr']), name: z.string().trim().min(2, 'Bitte den Namen angeben.').max(120).nullable() }).parse(req.body);
    return { text: await change(req, (tx) => freigeben(tx, n, b.rolle, b.name, wer(req)), { action: 'SB_FREIGABE', reason: b.rolle }) };
  });
  app.post('/sport/spielberichte/:id/einreichen', pflege, async (req) => {
    const { id: n } = id.parse(req.params);
    return { text: await change(req, (tx) => einreichen(tx, n, wer(req)), { action: 'SB_EINREICHEN' }) };
  });
  app.post('/sport/spielberichte/:id/zuruecknehmen', pflege, async (req) => {
    const { id: n } = id.parse(req.params);
    return { text: await change(req, (tx) => zuruecknehmen(tx, n), { action: 'SB_ZURUECKNEHMEN' }) };
  });
  app.get('/sport/spielberichte/:id/pdf', ansehen, async (req, reply) => {
    const b = await berichtLesen(DB, id.parse(req.params).id);
    const pdf = await berichtPdf(b, await vereinLesen(DB));
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${berichtTitel(b).replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf"`).send(pdf);
  });
}
