import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { hasPermission } from '../../../../server/src/permissions.js';
import { DB } from '../verein.js';
import { addTage } from '../format.js';
import {
  eventLesen, eventSpeichern, eventsLesen, gruppeLoeschen, gruppenLesen, gruppenMitgliedEntfernen, gruppenMitgliedSetzen, gruppeSpeichern,
  KATEGORIEN, mitgliederAuswahl, rueckmelden, rueckmeldungLoeschen, teilnehmer, teilnehmerCsv, type Kategorie,
} from './logik.js';

/**
 * Berechtigungsobjekte Vereinskalender:
 *  - tco.kalender:anmelden  Kalender anzeigen und sich selbst an-/abmelden (Mitglied, Systemrolle MITGLIED)
 *  - tco.kalender:edit      Veranstaltungen anlegen/ändern/absagen, Teilnehmerlisten, Rückmeldungen für Mitglieder, Gruppen pflegen
 */
export const P_KAL = { anmelden: 'tco.kalender:anmelden', edit: 'tco.kalender:edit' };

const wer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const zeitpunkt = z.string().datetime({ offset: true, message: 'Ungültiger Zeitpunkt.' });
const id = z.object({ id: z.coerce.number().int().positive() });

/** Adressnummer des angemeldeten Benutzers (oder null, wenn keinem Mitglied zugeordnet) */
async function eigeneAdrnr(req: FastifyRequest): Promise<string | null> {
  if (!req.user?.id) return null;
  const [a] = await DB`select adrnr from tco.mitgliedera where benutzer_id = ${req.user.id}`;
  return (a?.adrnr as string) ?? null;
}

function eine(...perms: string[]) {
  return async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!req.user) return reply.code(401).send({ message: 'Nicht angemeldet' });
    if (!perms.some((p) => hasPermission(req.user!.permissions, p))) return reply.code(403).send({ message: 'Keine Berechtigung' });
  };
}

const eventSchema = z.object({
  titel: z.string().trim().min(1, 'Bitte einen Titel angeben.').max(120), beschreibung: z.string().max(5000).nullish(), ort: z.string().max(120).nullish(),
  kategorie: z.enum(Object.keys(KATEGORIEN) as [Kategorie, ...Kategorie[]]).default('VERANSTALTUNG'),
  beginn: zeitpunkt, ende: zeitpunkt.nullish(), ganztags: z.boolean().default(false),
  anmeldung: z.boolean().default(true), anmeldeschluss: zeitpunkt.nullish(), max_teilnehmer: z.coerce.number().int().positive().nullish(),
  begleitung: z.boolean().default(false), teilnehmer_sichtbar: z.boolean().default(true), gruppen: z.array(z.number().int()).default([]), abgesagt: z.boolean().default(false),
});

export async function kalenderRoutes(app: FastifyInstance) {
  const lesen = { preHandler: eine(P_KAL.anmelden, P_KAL.edit) };
  const pflege = { preHandler: requireAuth(P_KAL.edit) };

  app.get('/kalender', lesen, async (req) => {
    const q = z.object({ von: datum, bis: datum }).parse(req.query);
    const adrnr = await eigeneAdrnr(req);
    const alles = can(req, P_KAL.edit);
    return {
      events: await eventsLesen(DB, q, { adrnr, alles }), kategorien: KATEGORIEN, mitglied: !!adrnr, pflege: alles,
      gruppen: (await gruppenLesen(DB)).map((g) => ({ id: g.id, name: g.name, aktiv: g.aktiv })),
    };
  });

  app.get('/kalender/:id', lesen, async (req) => {
    const { id: eid } = id.parse(req.params);
    const adrnr = await eigeneAdrnr(req);
    const alles = can(req, P_KAL.edit);
    const e = await eventLesen(DB, eid);
    const sichtbar = (await eventsLesen(DB, { von: addTage(e.beginn.slice(0, 10), -1), bis: addTage((e.ende ?? e.beginn).slice(0, 10), 1) }, { adrnr, alles })).find((x) => x.id === eid);
    if (!sichtbar) throw new BusinessError('Veranstaltung nicht gefunden.', 404);
    return { event: sichtbar, teilnehmer: await teilnehmer(DB, e, { alles }) };
  });

  /** eigene Rückmeldung (nur für das dem Benutzer zugeordnete Mitglied) */
  app.post('/kalender/:id/rueckmeldung', lesen, async (req) => {
    const { id: eid } = id.parse(req.params);
    const b = z.object({ status: z.enum(['ZUSAGE', 'ABSAGE', 'VIELLEICHT']), begleitung: z.coerce.number().int().min(0).max(20).default(0), kommentar: z.string().max(300).nullish() }).parse(req.body);
    const adrnr = await eigeneAdrnr(req);
    if (!adrnr) throw new BusinessError('Dein Benutzer ist keinem Mitglied zugeordnet – An- und Abmelden ist nur für Mitglieder möglich.', 403);
    const e = await eventLesen(DB, eid);
    await change(req, (tx) => rueckmelden(tx, e, adrnr, b, wer(req), false), { action: 'KAL_RUECKMELDUNG' });
    return { text: b.status === 'ZUSAGE' ? `Du bist für „${e.titel}“ angemeldet.` : b.status === 'ABSAGE' ? `Du hast für „${e.titel}“ abgesagt.` : `Rückmeldung „vielleicht“ für „${e.titel}“ gespeichert.` };
  });

  // ---------------------------------------------------------------- Pflege
  app.post('/kalender', pflege, async (req) => {
    const b = eventSchema.parse(req.body);
    const n = await change(req, (tx) => eventSpeichern(tx, null, { ...b, beschreibung: b.beschreibung ?? null, ort: b.ort ?? null, ende: b.ende ?? null, anmeldeschluss: b.anmeldeschluss ?? null, max_teilnehmer: b.max_teilnehmer ?? null }, wer(req)), { action: 'KAL_EVENT' });
    return { id: n, text: `„${b.titel}“ angelegt.` };
  });

  app.put('/kalender/:id', pflege, async (req) => {
    const { id: eid } = id.parse(req.params);
    const b = eventSchema.parse(req.body);
    await change(req, (tx) => eventSpeichern(tx, eid, { ...b, beschreibung: b.beschreibung ?? null, ort: b.ort ?? null, ende: b.ende ?? null, anmeldeschluss: b.anmeldeschluss ?? null, max_teilnehmer: b.max_teilnehmer ?? null }, wer(req)), { action: 'KAL_EVENT' });
    return { id: eid, text: b.abgesagt ? `„${b.titel}“ ist abgesagt.` : `„${b.titel}“ gespeichert.` };
  });

  app.delete('/kalender/:id', pflege, async (req) => {
    const { id: eid } = id.parse(req.params);
    const e = await eventLesen(DB, eid);
    await change(req, async (tx) => { await tx`delete from tco.kal_events where id = ${eid}`; }, { action: 'KAL_EVENT', reason: 'gelöscht' });
    return { text: `„${e.titel}“ gelöscht.` };
  });

  /** Rückmeldung für ein Mitglied setzen oder entfernen (Pflege, z. B. Mannschaftsführer) */
  app.post('/kalender/:id/teilnehmer', pflege, async (req) => {
    const { id: eid } = id.parse(req.params);
    const b = z.object({
      adrnr: z.string().min(1), status: z.enum(['ZUSAGE', 'ABSAGE', 'VIELLEICHT']).nullable(),
      begleitung: z.coerce.number().int().min(0).max(20).default(0), kommentar: z.string().max(300).nullish(),
    }).parse(req.body);
    const e = await eventLesen(DB, eid);
    await change(req, (tx) => (b.status ? rueckmelden(tx, e, b.adrnr, { status: b.status, begleitung: b.begleitung, kommentar: b.kommentar }, wer(req), true) : rueckmeldungLoeschen(tx, eid, b.adrnr)),
      { action: 'KAL_RUECKMELDUNG', reason: 'Pflege' });
    return { text: 'Rückmeldung gespeichert.' };
  });

  app.get('/kalender/:id/csv', pflege, async (req, reply) => {
    const { id: eid } = id.parse(req.params);
    const e = await eventLesen(DB, eid);
    const t = await teilnehmer(DB, e, { alles: true });
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="Teilnehmer_${eid}.csv"`).send(teilnehmerCsv(e, t.liste, t.offen));
  });

  app.get('/kalender/pflege/mitglieder', pflege, async () => mitgliederAuswahl(DB));
  app.get('/kalender/pflege/gruppen', pflege, async () => gruppenLesen(DB));

  app.post('/kalender/pflege/gruppen', pflege, async (req) => {
    const b = z.object({ id: z.number().int().nullish(), name: z.string().max(80), beschreibung: z.string().max(500).nullish(), aktiv: z.boolean().default(true) }).parse(req.body);
    const n = await change(req, (tx) => gruppeSpeichern(tx, b.id ?? null, b), { action: 'KAL_GRUPPE' });
    return { id: n, text: `Gruppe „${b.name}“ gespeichert.` };
  });
  app.delete('/kalender/pflege/gruppen/:id', pflege, async (req) => {
    const { id: gid } = id.parse(req.params);
    await change(req, (tx) => gruppeLoeschen(tx, gid), { action: 'KAL_GRUPPE' });
    return { text: 'Gruppe gelöscht.' };
  });
  app.post('/kalender/pflege/gruppen/:id/mitglieder', pflege, async (req) => {
    const { id: gid } = id.parse(req.params);
    const b = z.object({ adrnr: z.string().min(1), rolle: z.string().max(60).nullish(), entfernen: z.boolean().default(false) }).parse(req.body);
    await change(req, (tx) => (b.entfernen ? gruppenMitgliedEntfernen(tx, gid, b.adrnr) : gruppenMitgliedSetzen(tx, gid, b.adrnr, b.rolle ?? null)), { action: 'KAL_GRUPPE' });
    return { text: b.entfernen ? 'Aus der Gruppe entfernt.' : 'Gespeichert.' };
  });
}
