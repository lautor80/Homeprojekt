import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, plAktiv, vereinLesen } from '../verein.js';
import { kontenStamm } from '../abschluss/logik.js';
import { kontoart } from '../finanz/logik.js';
import { cfgLesen } from '../haushalt/logik.js';
import { ENTSCHEIDUNG, POSITION_TEXT, STATUS, STATUS_TEXT } from '../haushalt/projekt.js';
import { P_PROJEKT, projekteLesen, projektLoeschen, projektnummernVorschlag, projektSichern, projektStatus } from '../haushalt/projekte.js';
import { betragOpt, projektSchema } from '../haushalt/routes.js';
import { mitgliederLesen, planungKennzahlen, planungSichern, projektSicht } from './logik.js';
import { antragAblegen, antragPdf } from './pdf.js';

/**
 * Berechtigungsobjekte der App „Projekte“ (Projekte des Haushaltsplans mit Termin- und Ressourcenplanung):
 *  - tco.projekte:display  Projekte ansehen, Projektantrag als PDF
 *  - tco.projekte:edit     Projekte anlegen und planen: Stammdaten, Kosten und Finanzierung, Termine, Arbeitseinsatz,
 *                          Material, beantragen, Ablage in Paperless
 *  - tco.projekte:approve  über Anträge entscheiden (besteht schon, siehe Haushaltsplan)
 */
export const P_PROJ = { display: 'tco.projekte:display', edit: 'tco.projekte:edit', approve: P_PROJEKT.approve };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const pId = z.object({ id: z.coerce.number().int().positive() });
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const text = (max: number) => z.string().max(max).nullish();
const key = z.string().min(1).max(40);
/** Zahl oder deutsche Schreibweise („1.234,56“); leer = 0 */
const zahl = betragOpt.transform((v) => v ?? 0).refine((v) => v >= 0, 'Bitte keine negativen Werte');

const planungSchema = z.object({
  stundensatz: zahl,
  vorgaenge: z.array(z.object({
    key, bezeichnung: z.string().trim().min(1, 'Bitte den Vorgang benennen').max(160), beginn: datum.nullish().or(z.literal('').transform(() => null)),
    dauer: z.coerce.number().int('Die Dauer in ganzen Tagen angeben').min(0).max(3660), fertig: z.coerce.number().int().min(0).max(100).default(0),
    verantwortlich: text(100), notiz: text(1000),
    vorgaenger: z.array(z.object({ key, abstand: z.coerce.number().int().min(-366).max(3660).default(0) })).max(50).default([]),
  })).max(300),
  arbeit: z.array(z.object({
    vorgang: key.nullish(), adrnr: z.string().trim().max(20).nullish(), name: z.string().trim().min(1, 'Bitte angeben, wer arbeitet').max(120), taetigkeit: text(200),
    personen: z.coerce.number().int().min(1).max(500).default(1), stunden: zahl, satz: betragOpt.transform((v) => v ?? null).refine((v) => v === null || v >= 0, 'Bitte keinen negativen Satz'),
  })).max(500),
  material: z.array(z.object({
    vorgang: key.nullish(), bezeichnung: z.string().trim().min(1, 'Bitte das Material benennen').max(160), menge: zahl, einheit: text(20), preis: zahl,
    lieferant: text(120), beschafft: z.boolean().default(false),
  })).max(500),
});

export async function projekteRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_PROJ.display) };
  const planen = { preHandler: requireAuth(P_PROJ.edit) };

  /** Übersicht: alle Projekte mit Budget, Ist, Terminen und Ressourcen */
  app.get('/projekte', lesen, async (req) => {
    const projekte = await projekteLesen(DB, await cfgLesen(DB));
    const kz = await planungKennzahlen(DB, projekte);
    const stamm = await kontenStamm(DB);
    const pflege = can(req, P_PROJ.edit);
    return {
      projekte: projekte.map((p) => ({ ...p, ...kz.get(p.id)! })),
      darfGenehmigen: can(req, P_PROJ.approve), pflege, arten: POSITION_TEXT, status: STATUS_TEXT,
      projektnummern: pflege ? await projektnummernVorschlag(DB) : [],
      konten: [...stamm.values()].filter((k) => !k.verrechnung).map((k) => ({ konto: k.konto, name: k.name, art: kontoart(String(k.konto).trim(), k.kennzahl) }))
        .filter((k) => k.art === 'E' || k.art === 'A').sort((a, b) => Number(a.konto) - Number(b.konto)),
      mitglieder: pflege ? await mitgliederLesen(DB) : [],
      paperless: plAktiv(await vereinLesen()), jahr: new Date().getFullYear(),
    };
  });

  app.get('/projekte/:id', lesen, async (req) => projektSicht(DB, pId.parse(req.params).id));

  // ---------------------------------------------------------------- Stammdaten, Kosten, Genehmigung (Funktionen des Haushaltsplans)
  app.post('/projekte', planen, async (req) => {
    const b = projektSchema.parse(req.body);
    const id = await change(req, (tx) => projektSichern(tx, b, benutzer(req), can(req, P_PROJ.approve)));
    return { id, text: `Projekt „${b.bezeichnung}“ gesichert.` };
  });

  app.post('/projekte/:id/status', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ status: z.enum(STATUS), grund: z.string().trim().max(1000).nullish() }).parse(req.body);
    // entscheiden darf, wer genehmigen darf (auch ohne Planungsrecht) – alles andere braucht das Planungsrecht
    if (!ENTSCHEIDUNG.includes(b.status) && !can(req, P_PROJ.edit)) throw new BusinessError('Dafür fehlt das Recht „Projekte planen“.', 403);
    const p = await change(req, (tx) => projektStatus(tx, id, b.status, b.grund ?? null, benutzer(req), can(req, P_PROJ.approve)), { action: `HH_PROJEKT_${b.status}`, reason: b.grund ?? undefined });
    return { text: `Projekt „${p.bezeichnung}“: ${p.status_text}.` };
  });

  app.post('/projekte/:id/loeschen', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ grund: z.string().trim().min(1, 'Bitte eine Begründung angeben') }).parse(req.body);
    const name = await change(req, (tx) => projektLoeschen(tx, id), { action: 'LOESCHEN', reason: b.grund });
    return { text: `Projekt „${name}“ gelöscht.` };
  });

  // ---------------------------------------------------------------- Termine und Ressourcen
  app.put('/projekte/:id/planung', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = planungSchema.parse(req.body);
    await change(req, (tx) => planungSichern(tx, id, b), { action: 'HH_PROJEKT_PLANUNG' });
    return projektSicht(DB, id);
  });

  // ---------------------------------------------------------------- Projektantrag: PDF und Paperless
  app.get('/projekte/:id/pdf', lesen, async (req, reply) => {
    const { pdf, titel } = await antragPdf(DB, await vereinLesen(), pId.parse(req.params).id);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${titel.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf"`).send(pdf);
  });

  app.post('/projekte/:id/paperless', planen, async (req) => {
    const { id } = pId.parse(req.params);
    const v = await vereinLesen();
    const { pdf, titel, sicht } = await antragPdf(DB, v, id);
    return antragAblegen(DB, v, sicht, titel, pdf, benutzer(req));
  });
}
