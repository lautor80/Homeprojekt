import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { can, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';

/**
 * Ansichtsvarianten für alle Apps mit Tabellen (Vorbild: Hallenschlüssel/Instandhaltung): Die Oberfläche sichert die aktuelle
 * Auswahl einer App (Filter, Suche, Sortierung, Zeitraum …) unter einem Namen – je Benutzer, optional als Standard (wird beim
 * Öffnen geladen) oder „für alle“ (nur mit `core.settings:edit`). Der Inhalt gehört der jeweiligen App und wird hier nicht gedeutet.
 *   GET    /api/varianten/:repid   eigene und globale Varianten, dazu die Standardvariante (eigene vor globaler)
 *   POST   /api/varianten/:repid   sichern { name, standard, global, ansicht }
 *   DELETE /api/varianten/:repid   löschen { key }
 */
export const P_VARIANTEN_GLOBAL = 'core.settings:edit';
const MAX_INHALT = 20_000;
const zRepid = z.object({ repid: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,59}$/i, 'Ungültige Kennung der Liste.') });

export interface Variante { key: string; name: string; global: boolean; standard: boolean; ansicht: Record<string, unknown> }

export function variantenName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 30 || n.includes('/')) throw new BusinessError('Der Variantenname darf höchstens 30 Zeichen lang sein und keinen Schrägstrich enthalten.');
  return n;
}

export async function variantenLesen(repid: string, user: string): Promise<Variante[]> {
  const rows = await sql`select uname, name, standard, inhalt from core.varianten where repid = ${repid} and (uname = ${user} or uname = '*')
                          order by case when uname = '*' then 1 else 0 end, name`;
  return rows.map((r) => ({
    key: `${r.uname}/${r.name}`, name: r.name as string, global: r.uname === '*', standard: !!r.standard,
    ansicht: r.inhalt && typeof r.inhalt === 'object' && !Array.isArray(r.inhalt) ? r.inhalt as Record<string, unknown> : {},
  }));
}

export async function variantenRoutes(app: FastifyInstance) {
  const angemeldet = { preHandler: requireAuth() };

  app.get('/api/varianten/:repid', angemeldet, async (req) => {
    const { repid } = zRepid.parse(req.params);
    const varianten = await variantenLesen(repid, req.user!.username);
    return { varianten, standard: varianten.find((v) => v.standard && !v.global) ?? varianten.find((v) => v.standard && v.global) ?? null, global: can(req, P_VARIANTEN_GLOBAL) };
  });

  app.post('/api/varianten/:repid', angemeldet, async (req) => {
    const { repid } = zRepid.parse(req.params);
    const b = z.object({
      name: z.string().max(60), standard: z.boolean().default(false), global: z.boolean().default(false), ansicht: z.record(z.string().max(60), z.unknown()),
    }).parse(req.body);
    const name = variantenName(b.name);
    if (b.global && !can(req, P_VARIANTEN_GLOBAL)) throw new BusinessError('Varianten für alle darf nur anlegen, wer die Systemeinstellungen ändern darf.', 403);
    const inhalt = JSON.stringify(b.ansicht);
    if (inhalt.length > MAX_INHALT) throw new BusinessError('Die Variante ist zu groß.');
    const uname = b.global ? '*' : req.user!.username;
    await sql.begin(async (tx) => {
      await tx`insert into core.varianten (repid, uname, name, standard, inhalt) values (${repid}, ${uname}, ${name}, ${b.standard}, ${tx.json(b.ansicht as never)})
               on conflict (repid, uname, name) do update set standard = excluded.standard, inhalt = excluded.inhalt, geaendert = now()`;
      if (b.standard) await tx`update core.varianten set standard = false where repid = ${repid} and uname = ${uname} and name <> ${name} and standard`;
    });
    return { text: `Variante „${name}“ gesichert${b.standard ? ' (Standard)' : ''}.`, variante: { key: `${uname}/${name}`, name, global: b.global, standard: b.standard, ansicht: b.ansicht } };
  });

  app.delete('/api/varianten/:repid', angemeldet, async (req) => {
    const { repid } = zRepid.parse(req.params);
    const { key } = z.object({ key: z.string().min(3).max(100) }).parse(req.body);
    const [uname, ...rest] = key.split('/');
    const name = rest.join('/');
    if (uname === '*' ? !can(req, P_VARIANTEN_GLOBAL) : uname !== req.user!.username) throw new BusinessError(uname === '*' ? 'Varianten für alle darf nur löschen, wer die Systemeinstellungen ändern darf.' : 'Diese Variante gehört einem anderen Benutzer.', 403);
    const r = await sql`delete from core.varianten where repid = ${repid} and uname = ${uname} and name = ${name}`;
    if (!r.count) throw new BusinessError('Variante nicht gefunden.', 404);
    return { text: `Variante „${name}“ gelöscht.` };
  });
}
