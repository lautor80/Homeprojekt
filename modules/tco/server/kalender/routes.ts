import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { hasPermission } from '../../../../server/src/permissions.js';
import { DB, type Db } from '../verein.js';
import { addTage } from '../format.js';
import {
  eventLesen, eventSpeichern, eventsLesen, gruppeLoeschen, gruppenLesen, gruppenMitgliedEntfernen, gruppenMitgliedSetzen, gruppeSpeichern,
  KATEGORIEN, meineGruppen, mitgliederAuswahl, rueckmelden, rueckmeldungLoeschen, teilnehmer, teilnehmerCsv, type Kategorie,
} from './logik.js';
import { gruppeZurLiga, spielplanEvent, spielplanLesen } from './spielplan.js';
import { eventRegelnAnwenden, eventRegelnLesen, eventRegelnSpeichern, eventsMasseAendern, gruppeNachRegeln, REGEL_FELDER, type RegelFeld } from './zuordnung.js';

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
      // eigene Gruppen einschließlich der Gruppen darüber – für den Filter „Nur meine Gruppen“
      meineGruppen: await meineGruppen(DB, adrnr),
      gruppen: (await gruppenLesen(DB)).map((g) => ({ id: g.id, name: g.pfad, aktiv: g.aktiv })),
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

  // ---------------------------------------------------------------- Massenanlage aus eingefügtem Text (#16)
  /** Eingefügten Spielplan lesen und auf Veranstaltungen abbilden – legt noch nichts an */
  app.post('/kalender/masse/vorschau', pflege, async (req) => {
    const b = z.object({ text: z.string().max(200_000), praefix: z.string().trim().max(60).default('Winterhallenrunde') }).parse(req.body);
    const { zeilen, ignoriert } = spielplanLesen(b.text);
    if (zeilen.length > 200) throw new BusinessError(`Der Text enthält ${zeilen.length} Termine – höchstens 200 je Lauf.`);
    const gruppen = (await gruppenLesen(DB)).filter((g) => g.aktiv);
    // Gruppe: zuerst das Regelwerk („Text in Spalte => Gruppe“), sonst die Gruppe, deren Name in der Liga vorkommt
    const regeln = await eventRegelnLesen(DB);
    return {
      ignoriert,
      zeilen: zeilen.map((x) => {
        const e = spielplanEvent(x, b.praefix);
        return { ...x, ...e, gruppe: gruppeNachRegeln(e, regeln) ?? gruppeZurLiga(x.liga, gruppen)?.id ?? null };
      }),
    };
  });

  /** Freigegebene Veranstaltungen anlegen – gleiche Veranstaltung (Titel und Beginn) wird nicht doppelt angelegt; Protokoll je Zeile */
  app.post('/kalender/masse', pflege, async (req) => {
    const { events } = z.object({ events: z.array(eventSchema).min(1, 'Bitte mindestens eine Veranstaltung auswählen.').max(200) }).parse(req.body);
    const zeilen = await change(req, async (tx) => {
      const out: { quelle: string; ok: boolean; text: string }[] = [];
      for (const b of events) {
        const quelle = `${new Date(b.beginn).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' })} · ${b.titel}`;
        const [da] = await tx`select id from tco.kal_events where titel = ${b.titel} and beginn = ${b.beginn} limit 1`;
        if (da) { out.push({ quelle, ok: false, text: 'bereits vorhanden – nicht noch einmal angelegt' }); continue; }
        await eventSpeichern(tx, null, { ...b, beschreibung: b.beschreibung ?? null, ort: b.ort ?? null, ende: b.ende ?? null, anmeldeschluss: b.anmeldeschluss ?? null, max_teilnehmer: b.max_teilnehmer ?? null }, wer(req));
        out.push({ quelle, ok: true, text: 'angelegt' });
      }
      return out;
    }, { action: 'KAL_EVENT', reason: 'Massenanlage' });
    const n = zeilen.filter((x) => x.ok).length;
    return { zeilen, angelegt: n, text: `${n} Veranstaltung(en) angelegt${zeilen.length - n ? `, ${zeilen.length - n} bereits vorhanden` : ''}.` };
  });

  // ---------------------------------------------------------------- Tabelle: Massenbearbeitung und Regelwerk (#16)
  /** Massenbearbeitung: nur die angegebenen Felder bei allen gewählten Veranstaltungen setzen */
  app.post('/kalender/masse/aendern', pflege, async (req) => {
    const { ids, ...d } = z.object({
      ids: z.array(z.number().int().positive()).min(1, 'Bitte mindestens eine Veranstaltung auswählen.').max(2000),
      titel: z.string().trim().min(1).max(120).optional(), ort: z.string().max(120).nullable().optional(),
      kategorie: z.enum(Object.keys(KATEGORIEN) as [Kategorie, ...Kategorie[]]).optional(),
      gruppen: z.array(z.number().int().positive()).optional(), anmeldung: z.boolean().optional(),
    }).parse(req.body);
    const n = await change(req, (tx) => eventsMasseAendern(tx, ids, d), { action: 'KAL_EVENT', reason: 'Massenbearbeitung' });
    return { geaendert: n, text: `${n} Veranstaltung(en) geändert.` };
  });

  /** Massenlöschung: alle gewählten Veranstaltungen samt Rückmeldungen löschen */
  /** angemeldet = Zusage oder „vielleicht“; Absagen zählen nicht */
  const ANGEMELDET = (tx: Db) => tx`exists (select 1 from tco.kal_anmeldungen a where a.event_id = e.id and a.status in ('ZUSAGE', 'VIELLEICHT'))`;
  app.post('/kalender/masse/loeschen', pflege, async (req) => {
    const { ids } = z.object({
      ids: z.array(z.number().int().positive()).min(1, 'Bitte mindestens eine Veranstaltung auswählen.').max(2000),
    }).parse(req.body);
    // gelöscht wird nur, wozu niemand angemeldet ist (Zusage oder „vielleicht“) – die übrigen bleiben stehen und werden genannt
    const r = await change(req, async (tx) => {
      const belegt = await tx`select e.id, e.titel from tco.kal_events e where e.id = any(${ids}) and ${ANGEMELDET(tx)} order by e.beginn`;
      const n = (await tx`delete from tco.kal_events e where e.id = any(${ids}) and not ${ANGEMELDET(tx)}`).count;
      return { n, belegt: belegt.map((x) => x.titel as string) };
    }, { action: 'KAL_EVENT', reason: 'Massenlöschung' });
    return { geloescht: r.n, nicht_geloescht: r.belegt.length,
      text: `${r.n} Veranstaltung(en) gelöscht.${r.belegt.length ? ` ${r.belegt.length} nicht gelöscht, weil Anmeldungen vorliegen: ${r.belegt.slice(0, 5).map((t) => `„${t}“`).join(', ')}${r.belegt.length > 5 ? ' …' : ''}.` : ''}` };
  });

  /** Regelwerk „Text in Spalte => Gruppe“ */
  app.get('/kalender/regeln', pflege, async () => ({ regeln: await eventRegelnLesen(DB), felder: REGEL_FELDER }));
  app.put('/kalender/regeln', pflege, async (req) => {
    const { regeln } = z.object({
      regeln: z.array(z.object({
        feld: z.enum(Object.keys(REGEL_FELDER) as [RegelFeld, ...RegelFeld[]]), text: z.string().trim().min(1, 'Bitte einen Text angeben.').max(120),
        gruppe_id: z.number().int().positive(), aktiv: z.boolean().default(true),
      })).max(200),
    }).parse(req.body);
    const n = await change(req, (tx) => eventRegelnSpeichern(tx, regeln), { action: 'KAL_EVENT', reason: 'Regelwerk' });
    return { regeln: await eventRegelnLesen(DB), text: n === 1 ? '1 Regel gesichert.' : `${n} Regeln gesichert.` };
  });
  /** Regelwerk anwenden: Standardzuordnung für Veranstaltungen ohne Gruppe (ueberschreiben = auch bereits zugeordnete) */
  app.post('/kalender/regeln/anwenden', pflege, async (req) => {
    const b = z.object({
      ids: z.array(z.number().int().positive()).max(2000).optional(), ueberschreiben: z.boolean().default(false), simulation: z.boolean().default(false),
    }).parse(req.body ?? {});
    const zeilen = b.simulation ? await eventRegelnAnwenden(DB, b)
      : await change(req, (tx) => eventRegelnAnwenden(tx, b), { action: 'KAL_EVENT', reason: 'Regelwerk angewendet' });
    return { zeilen, text: `${zeilen.length} Veranstaltung(en) ${b.simulation ? 'würden zugeordnet' : 'einer Gruppe zugeordnet'}.` };
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
    await change(req, async (tx) => {
      const [a] = await tx`select count(*)::int as n from tco.kal_anmeldungen where event_id = ${eid} and status in ('ZUSAGE', 'VIELLEICHT')`;
      if (a.n) throw new BusinessError(`„${e.titel}“ kann nicht gelöscht werden: ${a.n} Anmeldung${a.n === 1 ? '' : 'en'} (Zusage oder „vielleicht“). Bitte die Veranstaltung absagen oder die Anmeldungen zuerst entfernen.`);
      await tx`delete from tco.kal_events where id = ${eid}`;
    }, { action: 'KAL_EVENT', reason: 'gelöscht' });
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

  /** Auswahl zum Eintragen einer Rückmeldung; mit ?event=<id> nur die Mitglieder der Gruppen dieser Veranstaltung */
  app.get('/kalender/pflege/mitglieder', pflege, async (req) => {
    const { event } = z.object({ event: z.coerce.number().int().positive().optional() }).parse(req.query);
    return mitgliederAuswahl(DB, event ? (await eventLesen(DB, event)).gruppen : []);
  });
  app.get('/kalender/pflege/gruppen', pflege, async () => gruppenLesen(DB));

  app.post('/kalender/pflege/gruppen', pflege, async (req) => {
    const b = z.object({ id: z.number().int().nullish(), name: z.string().max(80), beschreibung: z.string().max(500).nullish(), aktiv: z.boolean().default(true), parent_id: z.number().int().positive().nullish() }).parse(req.body);
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
    await change(req, async (tx) => { if (b.entfernen) await gruppenMitgliedEntfernen(tx, gid, b.adrnr); else await gruppenMitgliedSetzen(tx, gid, b.adrnr, b.rolle ?? null); }, { action: 'KAL_GRUPPE' });
    return { text: b.entfernen ? 'Aus der Gruppe entfernt.' : 'Gespeichert.' };
  });
}
