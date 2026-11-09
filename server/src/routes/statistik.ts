import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Nutzungsstatistik: Anmeldungen je Benutzer und Monat, Aufrufe je App (und Monat).
 * Erfasst werden erfolgreiche Anmeldungen (Login) und das Öffnen einer App (Route) – höchstens
 * einmal je Benutzer, App und Minute. Rohdaten älter als 25 Monate werden beim Erfassen gelöscht.
 */
export const P_STAT = 'core.statistik:display';

let aufgeraeumt = 0;
async function aufraeumen() {
  if (Date.now() - aufgeraeumt < 86_400_000) return;
  aufgeraeumt = Date.now();
  await sql`delete from core.nutzung where zeit < now() - interval '25 months'`;
}

export async function loginErfassen(userId: string) {
  await sql`insert into core.nutzung (user_id, art) values (${userId}, 'LOGIN')`;
  await aufraeumen().catch(() => undefined);
}

export async function statistikRoutes(app: FastifyInstance) {
  /** App aufgerufen (Shell meldet die Route beim Öffnen) */
  app.post('/api/nutzung', { preHandler: requireAuth() }, async (req) => {
    const { pfad } = z.object({ pfad: z.string().regex(/^\/[\w\-/:]*$/).max(120) }).parse(req.body);
    if (pfad === '/' || !req.user?.id) return { ok: true };
    // API-Schlüssel und Ähnliches haben keinen Benutzer – dann still nichts erfassen
    await sql`insert into core.nutzung (user_id, art, pfad)
              select ${req.user.id}::uuid, 'APP', ${pfad}
               where exists (select 1 from core.users where id::text = ${req.user.id})
                 and not exists (select 1 from core.nutzung where user_id::text = ${req.user.id} and art = 'APP' and pfad = ${pfad} and zeit > now() - interval '1 minute')`.catch(() => undefined);
    return { ok: true };
  });

  /** Benutzer mit Rolle ADMIN (für den Filter „Administratoren ausblenden“) */
  const ohneAdmin = (aus: boolean) => (aus
    ? sql`and not exists (select 1 from core.user_roles ur where ur.user_id = n.user_id and ur.role_id = 'ADMIN')`
    : sql``);
  const monateBilden = async (anzahl: number) =>
    (await sql`select to_char(date_trunc('month', now() at time zone 'Europe/Berlin') - (g || ' months')::interval, 'YYYY-MM') as m
                 from generate_series(0, ${anzahl - 1}) g order by 1 desc`).map((r) => r.m as string);
  const ja = z.preprocess((v) => v === '1' || v === 'true' || v === true, z.boolean()).default(false);

  app.get('/api/statistik', { preHandler: requireAuth(P_STAT) }, async (req) => {
    const q = z.object({ monate: z.coerce.number().int().min(1).max(24).default(12), ohneAdmin: ja }).parse(req.query);
    // neuester Monat zuerst – der laufende Monat steht direkt neben „Gesamt“
    const monate = await monateBilden(q.monate);
    const von = `${monate[monate.length - 1]}-01`;
    const logins = await sql`
      select u.id::text as id, u.username, u.display_name, to_char(n.zeit at time zone 'Europe/Berlin', 'YYYY-MM') as monat, count(*)::int as anzahl
        from core.nutzung n join core.users u on u.id = n.user_id
       where n.art = 'LOGIN' and n.zeit >= ${von}::date ${ohneAdmin(q.ohneAdmin)}
       group by u.id, u.username, u.display_name, monat`;
    const apps = await sql`
      select n.pfad, to_char(n.zeit at time zone 'Europe/Berlin', 'YYYY-MM') as monat, count(*)::int as anzahl
        from core.nutzung n
       where n.art = 'APP' and n.zeit >= ${von}::date ${ohneAdmin(q.ohneAdmin)}
       group by n.pfad, monat`;
    const benutzer = new Map<string, { id: string; username: string; name: string; monate: Record<string, number>; gesamt: number }>();
    for (const r of logins) {
      const b = benutzer.get(r.id) ?? { id: r.id as string, username: r.username as string, name: (r.display_name || r.username) as string, monate: {} as Record<string, number>, gesamt: 0 };
      b.monate[r.monat as string] = Number(r.anzahl);
      b.gesamt += Number(r.anzahl);
      benutzer.set(r.id, b);
    }
    const appListe = new Map<string, { pfad: string; monate: Record<string, number>; gesamt: number; benutzer: number }>();
    for (const r of apps) {
      const a = appListe.get(r.pfad) ?? { pfad: r.pfad as string, monate: {} as Record<string, number>, gesamt: 0, benutzer: 0 };
      a.monate[r.monat as string] = Number(r.anzahl);
      a.gesamt += Number(r.anzahl);
      appListe.set(r.pfad, a);
    }
    const [{ seit }] = await sql`select to_char(min(zeit) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as seit from core.nutzung`;
    const nutzer = await sql`select n.pfad, count(distinct n.user_id)::int as n from core.nutzung n
                              where n.art = 'APP' and n.zeit >= ${von}::date ${ohneAdmin(q.ohneAdmin)} group by n.pfad`;
    for (const r of nutzer) { const a = appListe.get(r.pfad); if (a) a.benutzer = Number(r.n); }
    return {
      monate, seit,
      anmeldungen: [...benutzer.values()].sort((a, b) => b.gesamt - a.gesamt || a.name.localeCompare(b.name, 'de')),
      apps: [...appListe.values()].sort((a, b) => b.gesamt - a.gesamt),
    };
  });

  /**
   * Aufschlüsselung einer Zelle: welche Benutzer welche App aufgerufen haben – wahlweise für eine App,
   * einen Benutzer und/oder einen Monat (ohne Monat: gesamter Zeitraum der Auswahl).
   */
  app.get('/api/statistik/details', { preHandler: requireAuth(P_STAT) }, async (req) => {
    const q = z.object({
      monate: z.coerce.number().int().min(1).max(24).default(12), ohneAdmin: ja,
      monat: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      pfad: z.string().max(120).optional(),
      user: z.string().uuid().optional(),
    }).parse(req.query);
    const monate = await monateBilden(q.monate);
    const von = q.monat ? `${q.monat}-01` : `${monate[monate.length - 1]}-01`;
    const bis = q.monat ? sql`and n.zeit < (${von}::date + interval '1 month')` : sql``;
    const rows = await sql`
      select u.id::text as id, u.username, coalesce(nullif(u.display_name, ''), u.username) as name, n.pfad,
             count(*)::int as anzahl, to_char(max(n.zeit) at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as zuletzt
        from core.nutzung n join core.users u on u.id = n.user_id
       where n.art = 'APP' and n.zeit >= ${von}::date ${bis} ${ohneAdmin(q.ohneAdmin)}
         ${q.pfad ? sql`and n.pfad = ${q.pfad}` : sql``}
         ${q.user ? sql`and n.user_id = ${q.user}::uuid` : sql``}
       group by u.id, u.username, u.display_name, n.pfad
       order by anzahl desc, name, n.pfad`;
    return rows.map((r) => ({ id: r.id, username: r.username, name: r.name, pfad: r.pfad, anzahl: Number(r.anzahl), zuletzt: r.zuletzt }));
  });
}
