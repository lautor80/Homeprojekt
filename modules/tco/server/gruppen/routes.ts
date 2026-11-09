import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { DB } from '../verein.js';
import { aufnahmeMitglieder, gruppeLoeschen, gruppenLesen, gruppenMitgliedEntfernen, gruppenMitgliederAufnehmen, gruppenMitgliedSetzen, gruppeSpeichern } from './logik.js';

/**
 * Berechtigungsobjekte Mitgliedergruppen:
 *  - tco.gruppen:display  Baum der Gruppen mit den zugeordneten Mitgliedern anzeigen
 *  - tco.gruppen:edit     Gruppen anlegen, ändern, verschieben, löschen und Mitglieder zuordnen
 * Die Zuordnung eines einzelnen Mitglieds im Mitgliedsstamm läuft über tco.mitglieder:edit (mitglieder/routes.ts).
 */
export const P_GR = { display: 'tco.gruppen:display', edit: 'tco.gruppen:edit' };

const id = z.object({ id: z.coerce.number().int().positive() });

/** angemeldet und mindestens eine der Berechtigungen */
function eine(...perms: string[]) {
  return [requireAuth(), async (req: FastifyRequest, reply: FastifyReply) => {
    if (!perms.some((p) => can(req, p))) return reply.code(403).send({ message: `Keine Berechtigung (${perms.join(' oder ')}).` });
  }];
}

export async function gruppenRoutes(app: FastifyInstance) {
  // Der Baum wird auch im Mitgliedsstamm (Reiter Gruppen, Filter der Liste) gebraucht
  const lesen = { preHandler: eine(P_GR.display, 'tco.mitglieder:display') };
  const pflege = { preHandler: requireAuth(P_GR.edit) };

  app.get('/gruppen', lesen, async (req) => ({ gruppen: await gruppenLesen(DB), pflege: can(req, P_GR.edit) }));

  /** Mitglieder zur Auswahl (nicht ausgetreten) mit Geschlecht, Jahrgang und Alter für die Filter */
  app.get('/gruppen/mitglieder', pflege, async () => aufnahmeMitglieder(DB));

  app.post('/gruppen', pflege, async (req) => {
    const b = z.object({
      id: z.number().int().positive().nullish(), parent_id: z.number().int().positive().nullable().optional(),
      name: z.string().max(80), beschreibung: z.string().max(500).nullish(), aktiv: z.boolean().default(true),
    }).parse(req.body);
    const n = await change(req, (tx) => gruppeSpeichern(tx, b.id ?? null, b), { action: 'GRUPPE' });
    return { id: n, text: `Gruppe „${b.name.trim()}“ gespeichert.` };
  });

  app.delete('/gruppen/:id', pflege, async (req) => {
    const { id: gid } = id.parse(req.params);
    const name = await change(req, (tx) => gruppeLoeschen(tx, gid), { action: 'GRUPPE', reason: 'gelöscht' });
    return { text: `Gruppe „${name}“ gelöscht.` };
  });

  /** Mitglieder aufnehmen (mehrere), Rolle eines Mitglieds setzen oder Mitglied entfernen */
  app.post('/gruppen/:id/mitglieder', pflege, async (req) => {
    const { id: gid } = id.parse(req.params);
    const b = z.object({
      adrnrs: z.array(z.string().min(1).max(20)).min(1, 'Bitte mindestens ein Mitglied wählen.').max(500),
      rolle: z.string().max(60).nullish(), entfernen: z.boolean().default(false),
    }).parse(req.body);
    if (b.entfernen) {
      await change(req, async (tx) => { for (const a of b.adrnrs) await gruppenMitgliedEntfernen(tx, gid, a); }, { action: 'GRUPPE' });
      return { text: b.adrnrs.length === 1 ? 'Aus der Gruppe entfernt.' : `${b.adrnrs.length} Mitglieder aus der Gruppe entfernt.` };
    }
    if (b.rolle !== undefined) {
      await change(req, async (tx) => { for (const a of b.adrnrs) await gruppenMitgliedSetzen(tx, gid, a, b.rolle ?? null); }, { action: 'GRUPPE' });
      return { text: 'Gespeichert.' };
    }
    const r = await change(req, (tx) => gruppenMitgliederAufnehmen(tx, gid, b.adrnrs), { action: 'GRUPPE' });
    return {
      ...r,
      text: (r.neu === 1 ? '1 Mitglied aufgenommen' : `${r.neu} Mitglieder aufgenommen`)
        + (r.ueberUntergruppe ? `, ${r.ueberUntergruppe} nicht – bereits über eine Untergruppe enthalten` : '')
        + (r.ausUebergeordneter ? `, ${r.ausUebergeordneter} Zuordnung${r.ausUebergeordneter === 1 ? '' : 'en'} in übergeordneten Gruppen entfernt` : '') + '.',
    };
  });
}
