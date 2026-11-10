import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { DB } from '../verein.js';
import { regelnAnwenden, regelnLesen, regelnSpeichern } from './regeln.js';
import { aufnahmeMitglieder, gruppeLoeschen, gruppenLesen, gruppenMitgliedEntfernen, gruppenMitgliederAufnehmen, gruppenMitgliedSetzen, gruppenMitgliedVerschieben, gruppeSpeichern } from './logik.js';

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

  /** Aktive Mitglieder zur Auswahl mit Geschlecht, Jahrgang und Alter für die Filter */
  app.get('/gruppen/mitglieder', pflege, async () => aufnahmeMitglieder(DB));

  // ---------------------------------------------------------------- Regelwerk (#16)
  app.get('/gruppen/regeln', pflege, async () => ({ regeln: await regelnLesen(DB) }));

  /** Regelwerk als Ganzes sichern */
  app.put('/gruppen/regeln', pflege, async (req) => {
    const alter = z.number().int().min(0, 'Das Alter darf nicht negativ sein.').max(120, 'Das Alter darf höchstens 120 sein.').nullable();
    const { regeln, gruppe_id } = z.object({
      // nur das Regelwerk dieser Gruppe ersetzen (sonst das gesamte Regelwerk)
      gruppe_id: z.number().int().positive().optional(),
      regeln: z.array(z.object({
        gruppe_id: z.number().int().positive(), alter_von: alter, alter_bis: alter,
        jahrgang: z.boolean().default(false), geschlecht: z.enum(['', 'M', 'W']).default(''), andere_entfernen: z.boolean().default(false), aktiv: z.boolean().default(true),
      })).max(200),
    }).parse(req.body);
    const n = await change(req, (tx) => regelnSpeichern(tx, regeln, gruppe_id), { action: 'GRUPPE', reason: 'Regelwerk' });
    return { regeln: await regelnLesen(DB), text: n === 1 ? '1 Regel gesichert.' : `${n} Regeln gesichert.` };
  });

  /**
   * Regelwerk anwenden – von Hand oder durch einen Job (API-Schlüssel mit tco.gruppen:edit).
   * simulation = true ermittelt nur, was sich ändern würde.
   */
  app.post('/gruppen/regeln/anwenden', pflege, async (req) => {
    // gruppe_id: nur diesen Knoten neu berechnen (Gruppe und ihre Untergruppen)
    const { simulation, gruppe_id } = z.object({ simulation: z.boolean().default(false), gruppe_id: z.number().int().positive().optional() }).parse(req.body ?? {});
    const gruppen = simulation ? await regelnAnwenden(DB, { simulation: true, gruppeId: gruppe_id })
      : await change(req, (tx) => regelnAnwenden(tx, { simulation: false, gruppeId: gruppe_id }), { action: 'GRUPPE', reason: 'Regelwerk angewendet' });
    const auf = gruppen.reduce((s, g) => s + g.aufgenommen.length, 0);
    const weg = gruppen.reduce((s, g) => s + g.entfernt.length, 0);
    return {
      simulation, gruppen, aufgenommen: auf, entfernt: weg,
      text: !gruppen.length ? (gruppe_id ? 'Für diese Gruppe und ihre Untergruppen gibt es keine aktive Regel.' : 'Es gibt keine aktive Regel.')
        : `${simulation ? 'Vorschau' : 'Neu berechnet'}: ${auf} ${simulation ? 'würden aufgenommen' : 'aufgenommen'}, ${weg} ${simulation ? 'würden entfernt' : 'entfernt'} (${gruppen.length} Gruppe${gruppen.length === 1 ? '' : 'n'}).`,
    };
  });

  app.post('/gruppen', pflege, async (req) => {
    const b = z.object({
      id: z.number().int().positive().nullish(), parent_id: z.number().int().positive().nullable().optional(),
      // Position innerhalb der Ebene; weglassen = nicht ändern
      position: z.number().int().min(0, 'Die Position darf nicht negativ sein.').max(9999).nullable().optional(),
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

  /** Mitglied aus einer anderen Gruppe hierher verschieben (Ziehen und Ablegen im Baum), die Rolle wandert mit */
  app.post('/gruppen/:id/mitglieder/verschieben', pflege, async (req) => {
    const { id: gid } = id.parse(req.params);
    const b = z.object({ adrnr: z.string().min(1).max(20), von: z.number().int().positive() }).parse(req.body);
    const name = await change(req, (tx) => gruppenMitgliedVerschieben(tx, b.von, gid, b.adrnr), { action: 'GRUPPE', reason: 'verschoben' });
    return { text: `Nach „${name}“ verschoben.` };
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
