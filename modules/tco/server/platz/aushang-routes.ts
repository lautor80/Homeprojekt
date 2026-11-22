import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { typAusInhalt } from '../../../../server/src/lib/dateityp.js';
import { DB, vereinLesen, type Db } from '../verein.js';
import { heute } from '../format.js';
import { ANHANG_ANZAHL, ANHANG_MAX, P_RS } from '../rundschreiben/routes.js';
import { AUSWAHL_LEER } from '../rundschreiben/empfaenger.js';
import { ANZEIGEN, fuerBenutzer, pruefen, rundschreibenText, stand, STILE, type Aushang, type Gesehen } from './aushang.js';

/**
 * Hinweise in der Hallenbuchung („Aushang“, Logik: ./aushang.ts).
 *  - Nutzer (Recht tco.platzbuchung:edit): geltende Aushänge abrufen, gesehen/bestätigt melden, Bilder laden.
 *  - Verwaltung (Platzverwaltung → Reiter „Aushang“, Recht tco.platz:aushang): anlegen, ändern, löschen, Bilder,
 *    wer hat gesehen/bestätigt, als Rundschreiben-Entwurf übernehmen (zusätzlich tco.rundschreiben:edit).
 */
export const P_AUSHANG = 'tco.platz:aushang';
const P_BUCHEN = 'tco.platzbuchung:edit';

/** Bilder: JPG, PNG, WebP – die Oberfläche verkleinert Fotos vor dem Hochladen */
export const BILD_MAX = 3 * 1024 * 1024;
export const BILD_ANZAHL = 6;
const BILD_TYPEN = new Set(['image/jpeg', 'image/png', 'image/webp']);

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const pId = z.object({ id: z.coerce.number().int().positive() });
const pBild = pId.extend({ bid: z.coerce.number().int().positive() });
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als JJJJ-MM-TT');
const schema = z.object({
  titel: z.string().trim().max(150, 'Der Titel darf höchstens 150 Zeichen haben.'),
  text: z.string().max(10_000, 'Der Text darf höchstens 10.000 Zeichen haben.'),
  stil: z.enum(STILE), anzeige: z.enum(ANZEIGEN), bestaetigen: z.boolean(), aktiv: z.boolean(),
  gueltig_von: datum, gueltig_bis: datum.nullish().transform((x) => x || null),
  rollen: z.array(z.string().trim().min(1).max(60)).max(50),
});

const zeile = (r: Record<string, unknown>): Aushang => ({
  id: Number(r.id), titel: r.titel as string, text: r.text as string, stil: r.stil as Aushang['stil'], gueltig_von: r.gueltig_von as string,
  gueltig_bis: (r.gueltig_bis as string | null) ?? null, rollen: (r.rollen as string[]) ?? [], anzeige: r.anzeige as Aushang['anzeige'],
  bestaetigen: !!r.bestaetigen, aktiv: !!r.aktiv,
});

async function bilderLesen(db: Db, ids: number[]): Promise<Map<number, { id: number; dateiname: string; groesse: number }[]>> {
  const out = new Map<number, { id: number; dateiname: string; groesse: number }[]>();
  if (!ids.length) return out;
  for (const b of await db`select id, aushang_id, dateiname, groesse from tco.aushang_bilder where aushang_id = any(${ids}) order by aushang_id, id`) {
    const l = out.get(Number(b.aushang_id)) ?? [];
    l.push({ id: Number(b.id), dateiname: b.dateiname as string, groesse: Number(b.groesse) });
    out.set(Number(b.aushang_id), l);
  }
  return out;
}
async function lesen(db: Db, id: number): Promise<Aushang> {
  const [r] = await db`select id, titel, text, stil, gueltig_von::text as gueltig_von, gueltig_bis::text as gueltig_bis, rollen, anzeige, bestaetigen, aktiv from tco.aushaenge where id = ${id}`;
  if (!r) throw new BusinessError('Den Aushang gibt es nicht (mehr).', 404);
  return zeile(r);
}

/** Bild ausliefern: Verwaltung immer, sonst nur, wenn der Aushang heute für den Benutzer gilt */
async function bildSenden(req: FastifyRequest, reply: import('fastify').FastifyReply) {
  const { id, bid } = pBild.parse(req.params);
  if (!can(req, P_AUSHANG)) {
    const { aktuell } = fuerBenutzer([await lesen(DB, id)], { heute: heute(), rollen: req.user?.roles ?? [], gesehen: new Map() });
    if (!aktuell.length) throw new BusinessError('Den Aushang gibt es nicht (mehr).', 404);
  }
  const [b] = await DB`select dateiname, mime, inhalt from tco.aushang_bilder where id = ${bid} and aushang_id = ${id}`;
  if (!b) throw new BusinessError('Das Bild gibt es nicht (mehr).', 404);
  return reply.type(b.mime as string).header('cache-control', 'private, max-age=3600')
    .header('content-disposition', `inline; filename="${encodeURIComponent(b.dateiname as string)}"`).send(Buffer.from(b.inhalt as Uint8Array));
}

export async function aushangRoutes(app: FastifyInstance) {
  const buchen = { preHandler: requireAuth(P_BUCHEN) };
  const pflegen = { preHandler: requireAuth(P_AUSHANG) };

  // ---------------------------------------------------------------- für Nutzer in „Platz buchen“
  /** geltende Aushänge (zum Nachlesen) und die, die sich jetzt von selbst öffnen (Ids, in Reihenfolge) */
  app.get('/platz/aushaenge', buchen, async (req) => {
    const uid = req.user?.id;
    const alle = (await DB`select id, titel, text, stil, gueltig_von::text as gueltig_von, gueltig_bis::text as gueltig_bis, rollen, anzeige, bestaetigen, aktiv from tco.aushaenge where aktiv`).map(zeile);
    const gesehen = new Map<number, Gesehen>();
    if (uid) {
      for (const g of await DB`select aushang_id, bestaetigt_am is not null as bestaetigt from tco.aushang_gesehen where user_id = ${uid}`) {
        gesehen.set(Number(g.aushang_id), { gesehen: true, bestaetigt: !!g.bestaetigt });
      }
    }
    const { aktuell, oeffnen } = fuerBenutzer(alle, { heute: heute(), rollen: req.user?.roles ?? [], gesehen });
    const bilder = await bilderLesen(DB, aktuell.map((a) => a.id));
    return {
      aktuell: aktuell.map((a) => ({
        id: a.id, titel: a.titel, text: a.text, stil: a.stil, bestaetigen: a.bestaetigen, gueltig_bis: a.gueltig_bis,
        bilder: bilder.get(a.id) ?? [], bestaetigt: !!gesehen.get(a.id)?.bestaetigt,
      })),
      oeffnen: oeffnen.map((a) => a.id),
    };
  });

  /** gesehen bzw. „Zur Kenntnis genommen“ – der erste Zeitpunkt bleibt stehen (Nachweis) */
  app.post('/platz/aushaenge/:id/gesehen', buchen, async (req) => {
    const { id } = pId.parse(req.params);
    const { bestaetigt } = z.object({ bestaetigt: z.boolean().default(false) }).parse(req.body ?? {});
    const uid = req.user?.id;
    if (!uid) return { ok: true };
    await lesen(DB, id);
    await DB`insert into tco.aushang_gesehen (aushang_id, user_id, bestaetigt_am) values (${id}, ${uid}, case when ${bestaetigt}::boolean then now() end)
             on conflict (aushang_id, user_id) do update set bestaetigt_am = coalesce(tco.aushang_gesehen.bestaetigt_am, excluded.bestaetigt_am)`;
    return { ok: true };
  });

  app.get('/platz/aushaenge/:id/bilder/:bid', { preHandler: requireAuth() }, async (req, reply) => {
    if (!can(req, P_BUCHEN) && !can(req, P_AUSHANG)) return reply.code(403).send({ message: `Keine Berechtigung (${P_BUCHEN}).` });
    return bildSenden(req, reply);
  });

  // ---------------------------------------------------------------- Verwaltung
  app.get('/aushaenge', pflegen, async (req) => {
    const h = heute();
    const liste = await DB`
      select id, titel, text, stil, gueltig_von::text as gueltig_von, gueltig_bis::text as gueltig_bis, rollen, anzeige, bestaetigen, aktiv, erstellt_von, geaendert_am::text as geaendert_am, geaendert_von,
             (select count(*)::int from tco.aushang_gesehen g where g.aushang_id = a.id) as gesehen,
             (select count(*)::int from tco.aushang_gesehen g where g.aushang_id = a.id and g.bestaetigt_am is not null) as bestaetigt
        from tco.aushaenge a order by gueltig_von desc, id desc`;
    const bilder = await bilderLesen(DB, liste.map((r) => Number(r.id)));
    const rollen = await DB`select id, name from core.roles order by name`;
    return {
      liste: liste.map((r) => {
        const a = zeile(r);
        return { ...a, stand: stand(a, h), bilder: bilder.get(a.id) ?? [], gesehen: Number(r.gesehen), bestaetigt: Number(r.bestaetigt),
          erstellt_von: r.erstellt_von, geaendert_am: r.geaendert_am, geaendert_von: r.geaendert_von };
      }),
      rollen: rollen.map((r) => ({ id: r.id as string, name: r.name as string })),
      heute: h, bild_max: BILD_MAX, bild_anzahl: BILD_ANZAHL, rundschreiben: can(req, P_RS.edit),
    };
  });

  app.post('/aushaenge', pflegen, async (req) => {
    const d = schema.parse(req.body);
    const f = pruefen(d);
    if (f) throw new BusinessError(f);
    const [r] = await change(req, (tx) => tx`
      insert into tco.aushaenge (titel, text, stil, gueltig_von, gueltig_bis, rollen, anzeige, bestaetigen, aktiv, erstellt_von, geaendert_von)
      values (${d.titel}, ${d.text}, ${d.stil}, ${d.gueltig_von}, ${d.gueltig_bis}, ${d.rollen}::text[], ${d.anzeige}, ${d.bestaetigen}, ${d.aktiv}, ${benutzer(req)}, ${benutzer(req)})
      returning id`);
    return { id: Number(r.id) };
  });

  /**
   * Ändern. Wird der Inhalt geändert (Titel, Text, Bestätigungspflicht), gilt er als neu: Alle sehen ihn noch einmal
   * (bisherige Kenntnisnahmen entfallen) – nur bei „neu anzeigen“ = true; sonst bleibt der Stand.
   */
  app.put('/aushaenge/:id', pflegen, async (req) => {
    const { id } = pId.parse(req.params);
    const d = schema.extend({ neu_anzeigen: z.boolean().default(false) }).parse(req.body);
    const f = pruefen(d);
    if (f) throw new BusinessError(f);
    await change(req, async (tx) => {
      await lesen(tx, id);
      await tx`update tco.aushaenge set titel = ${d.titel}, text = ${d.text}, stil = ${d.stil}, gueltig_von = ${d.gueltig_von}, gueltig_bis = ${d.gueltig_bis},
                      rollen = ${d.rollen}::text[], anzeige = ${d.anzeige}, bestaetigen = ${d.bestaetigen}, aktiv = ${d.aktiv}, geaendert_am = now(), geaendert_von = ${benutzer(req)}
                where id = ${id}`;
      if (d.neu_anzeigen) await tx`delete from tco.aushang_gesehen where aushang_id = ${id}`;
    });
    return { ok: true };
  });

  app.delete('/aushaenge/:id', pflegen, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, async (tx) => { await lesen(tx, id); await tx`delete from tco.aushaenge where id = ${id}`; });
    return { ok: true };
  });

  app.post('/aushaenge/:id/bilder', { ...pflegen, bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const { id } = pId.parse(req.params);
    const d = z.object({ dateiname: z.string().trim().min(1).max(150), data: z.string().min(1) }).parse(req.body);
    const inhalt = Buffer.from(d.data.replace(/^data:[^,]*,/, ''), 'base64');
    const mime = typAusInhalt(inhalt);
    if (!mime || !BILD_TYPEN.has(mime)) throw new BusinessError('Als Bild gehen JPG, PNG und WebP.');
    if (inhalt.length > BILD_MAX) throw new BusinessError(`Das Bild ist zu groß (${(inhalt.length / 1024 / 1024).toFixed(1)} MB, höchstens ${BILD_MAX / 1024 / 1024} MB).`);
    const dateiname = d.dateiname.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    await change(req, async (tx) => {
      await tx`select id from tco.aushaenge where id = ${id} for update`;
      await lesen(tx, id);
      const [s] = await tx`select count(*)::int as n from tco.aushang_bilder where aushang_id = ${id}`;
      if (s.n >= BILD_ANZAHL) throw new BusinessError(`Höchstens ${BILD_ANZAHL} Bilder je Aushang.`);
      await tx`insert into tco.aushang_bilder (aushang_id, dateiname, mime, groesse, inhalt) values (${id}, ${dateiname}, ${mime}, ${inhalt.length}, ${inhalt})`;
      await tx`update tco.aushaenge set geaendert_am = now(), geaendert_von = ${benutzer(req)} where id = ${id}`;
    });
    return { bilder: (await bilderLesen(DB, [id])).get(id) ?? [] };
  });

  app.delete('/aushaenge/:id/bilder/:bid', pflegen, async (req) => {
    const { id, bid } = pBild.parse(req.params);
    await change(req, async (tx) => {
      await tx`delete from tco.aushang_bilder where id = ${bid} and aushang_id = ${id}`;
      await tx`update tco.aushaenge set geaendert_am = now(), geaendert_von = ${benutzer(req)} where id = ${id}`;
    });
    return { bilder: (await bilderLesen(DB, [id])).get(id) ?? [] };
  });

  /** wer hat den Aushang gesehen bzw. bestätigt (Nachweis) */
  app.get('/aushaenge/:id/gesehen', pflegen, async (req) => {
    const { id } = pId.parse(req.params);
    await lesen(DB, id);
    return {
      zeilen: await DB`
        select coalesce(nullif(u.display_name, ''), u.username) as name, u.username, g.gesehen_am::text as gesehen_am, g.bestaetigt_am::text as bestaetigt_am
          from tco.aushang_gesehen g join core.users u on u.id = g.user_id
         where g.aushang_id = ${id} order by g.gesehen_am desc`,
    };
  });

  /**
   * Als Rundschreiben-Entwurf übernehmen: Betreff = Titel, Text mit Anrede, Bilder als Anhänge (soweit die Grenzen der
   * Rundschreiben reichen), Empfänger = die Rollen des Aushangs bzw. – für „alle, die buchen dürfen“ – alle Rollen mit dem
   * Recht „Platz buchen“. Senden geht wie immer in der App „Rundschreiben“.
   */
  app.post('/aushaenge/:id/rundschreiben', pflegen, async (req) => {
    if (!can(req, P_RS.edit)) throw new BusinessError(`Keine Berechtigung (${P_RS.edit}).`, 403);
    const { id } = pId.parse(req.params);
    const a = await lesen(DB, id);
    const v = await vereinLesen();
    const rollen = a.rollen.length ? a.rollen
      : (await DB`select distinct role_id from core.role_permissions where permission = ${P_BUCHEN} order by 1`).map((r) => r.role_id as string);
    const bilder = await DB`select dateiname, mime, groesse, inhalt from tco.aushang_bilder where aushang_id = ${id} order by id`;
    let summe = 0;
    const anhaenge = bilder.filter((b) => {
      if (summe + Number(b.groesse) > ANHANG_MAX) return false;
      summe += Number(b.groesse);
      return true;
    }).slice(0, ANHANG_ANZAHL);
    const neu = await change(req, async (tx) => {
      const auswahl = { ...AUSWAHL_LEER, rollen };
      const [r] = await tx`insert into tco.rundschreiben (betreff, text, auswahl, erstellt_von, geaendert_von)
                           values (${a.titel}, ${rundschreibenText(a, v.ansprechpartner || v.name)}, ${tx.json(auswahl as never)}, ${benutzer(req)}, ${benutzer(req)}) returning id`;
      for (const b of anhaenge) {
        await tx`insert into tco.rundschreiben_anhaenge (rundschreiben_id, dateiname, mime, groesse, inhalt) values (${r.id}, ${b.dateiname}, ${b.mime}, ${b.groesse}, ${b.inhalt})`;
      }
      return Number(r.id);
    });
    const fehlen = bilder.length - anhaenge.length;
    return { id: neu, text: `Rundschreiben-Entwurf ${neu} angelegt${fehlen ? ` – ${fehlen} Bild${fehlen === 1 ? '' : 'er'} passte${fehlen === 1 ? '' : 'n'} nicht mehr als Anhang` : ''}. Senden in der App „Rundschreiben“.` };
  });
}
