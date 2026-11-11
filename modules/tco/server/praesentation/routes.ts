/**
 * App „Präsentationen“ (#146): PowerPoint aus eigenen Vorlagen (Option B) und aus dem Sammelkorb (Option C).
 * Dateien gehen als Base64 im JSON hin und zurück (wie die übrigen Uploads im Portal).
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { asset, DB } from '../verein.js';
import { heute } from '../format.js';
import { bekannt, datenLaden, katalog } from './bausteine.js';
import { ausKorb, ausVorlage, folienplan, type KorbEintrag } from './erzeugen.js';
import { lesen, platzhalter } from './pptx.js';

export const P_PRAES = { display: 'tco.praesentation:display', edit: 'tco.praesentation:edit' };
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const jahr = z.coerce.number().int().min(2000).max(2100);
const eingaben = z.object({
  jahr: jahr.default(() => Number(heute().slice(0, 4))),
  titel: z.string().max(200).nullish().transform((x) => x ?? undefined),
  untertitel: z.string().max(300).nullish().transform((x) => x ?? undefined),
  texte: z.record(z.string().max(200), z.string().max(4000)).default({}),
});
const eintrag = z.object({
  id: z.string().max(60).optional(),
  art: z.enum(['KPI', 'DIAGRAMM', 'TABELLE', 'TEXT', 'KAPITEL']),
  schluessel: z.string().max(60).nullish(),
  titel: z.string().max(200).nullish(),
  text: z.string().max(4000).nullish(),
});
const userId = (req: FastifyRequest) => req.user!.id;
const dateiname = (s: string) => `${s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Praesentation'}.pptx`;

async function korbLesen(uid: string): Promise<KorbEintrag[]> {
  const [r] = await DB`select eintraege from tco.praesentation_korb where user_id = ${uid}`;
  return (r?.eintraege as KorbEintrag[] | undefined) ?? [];
}
async function korbSchreiben(uid: string, l: KorbEintrag[]) {
  await DB`insert into tco.praesentation_korb (user_id, eintraege, geaendert_am) values (${uid}, ${DB.json(l as never)}, now())
           on conflict (user_id) do update set eintraege = excluded.eintraege, geaendert_am = now()`;
  return l;
}

export async function praesentationRoutes(app: FastifyInstance) {
  const sehen = { preHandler: requireAuth(P_PRAES.display) };
  const pflegen = { preHandler: requireAuth(P_PRAES.edit) };

  /** Inhalte zur Auswahl (Kennzahlen, Diagramme, Tabellen) */
  app.get('/praesentation/katalog', sehen, async (req) => {
    const q = z.object({ jahr: jahr.default(() => Number(heute().slice(0, 4))) }).parse(req.query);
    return katalog(DB, q.jahr);
  });

  // ---------------------------------------------------------------- Sammelkorb (Option C)
  app.get('/praesentation/korb', sehen, async (req) => korbLesen(userId(req)));
  app.put('/praesentation/korb', sehen, async (req) => {
    const l = z.array(eintrag).max(100).parse(req.body).map((e) => ({ ...e, id: e.id || crypto.randomUUID() })) as KorbEintrag[];
    return korbSchreiben(userId(req), l);
  });
  /** aus der Vereinsübersicht: „Zur Präsentation“ – hängt an (doppelte Kennzahlen/Diagramme werden nicht erneut angehängt) */
  app.post('/praesentation/korb', sehen, async (req) => {
    const e = eintrag.parse(req.body);
    const l = await korbLesen(userId(req));
    const da = e.schluessel && l.some((x) => x.art === e.art && x.schluessel === e.schluessel);
    if (!da) l.push({ ...e, id: crypto.randomUUID() } as KorbEintrag);
    if (l.length > 100) throw new BusinessError('Der Sammelkorb ist voll (höchstens 100 Einträge).');
    await korbSchreiben(userId(req), l);
    return { anzahl: l.length, text: da ? 'Ist bereits im Sammelkorb.' : `Zur Präsentation hinzugefügt (${l.length} im Sammelkorb).` };
  });
  /** Präsentation aus dem Sammelkorb in der TCO-Standardvorlage */
  app.post('/praesentation/korb/erzeugen', sehen, async (req) => {
    const e = eingaben.parse(req.body ?? {});
    const l = await korbLesen(userId(req));
    if (!l.length) throw new BusinessError('Der Sammelkorb ist leer – bitte zuerst Inhalte hinzufügen.');
    const datei = await ausKorb(DB, l, e);
    return { name: dateiname(e.titel || `Praesentation ${e.jahr}`), folien: folienplan(l).length + 2, datei: datei.toString('base64') };
  });

  // ---------------------------------------------------------------- Vorlagen (Option B)
  app.get('/praesentation/vorlagen', sehen, async () =>
    DB`select id, name, beschreibung, dateiname, platzhalter, angelegt_am, angelegt_von, octet_length(datei) as groesse
         from tco.praesentation_vorlagen order by name`);

  /** Platzhalter einer Vorlage mit Status: wird gefüllt (bekannt) oder als Text einzutragen */
  app.get('/praesentation/vorlagen/:id', sehen, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = z.object({ jahr: jahr.default(() => Number(heute().slice(0, 4))) }).parse(req.query);
    const [v] = await DB`select id, name, beschreibung, dateiname, platzhalter from tco.praesentation_vorlagen where id = ${id}`;
    if (!v) throw new BusinessError('Vorlage nicht gefunden.', 404);
    const d = await datenLaden(DB, q.jahr, {});
    return { ...v, platzhalter: (v.platzhalter as string[]).map((p) => ({ name: p, bekannt: bekannt(p, d) })) };
  });

  app.post('/praesentation/vorlagen', { ...pflegen, bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const b = z.object({ name: z.string().trim().min(1, 'Bitte einen Namen angeben.').max(120), beschreibung: z.string().max(1000).nullish(), dateiname: z.string().max(200), data: z.string() }).parse(req.body);
    const buf = Buffer.from(b.data.replace(/^data:[^,]*,/, ''), 'base64');
    let pl: string[];
    try { pl = platzhalter(lesen(buf)); } catch (e) { throw new BusinessError((e as Error).message); }
    const [r] = await change(req, (tx) => tx`insert into tco.praesentation_vorlagen (name, beschreibung, dateiname, datei, platzhalter)
                                              values (${b.name}, ${b.beschreibung ?? null}, ${b.dateiname}, ${buf}, ${tx.json(pl as never)}) returning id`,
    { action: 'PRAESENTATION_VORLAGE', reason: b.name });
    return { id: r.id, platzhalter: pl.length, text: `Vorlage „${b.name}“ gesichert – ${pl.length} Platzhalter erkannt.` };
  });

  app.delete('/praesentation/vorlagen/:id', pflegen, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    await change(req, (tx) => tx`delete from tco.praesentation_vorlagen where id = ${id}`, { action: 'PRAESENTATION_VORLAGE', reason: `löschen ${id}` });
    return { text: 'Vorlage gelöscht.' };
  });

  /** Originaldatei einer Vorlage bzw. die mitgelieferte Beispielvorlage (id „beispiel“) */
  app.get('/praesentation/vorlagen/:id/datei', sehen, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (id === 'beispiel') return { name: 'TCO_Beispielvorlage.pptx', datei: asset('praesentation_beispiel.pptx').toString('base64') };
    const [v] = await DB`select dateiname, datei from tco.praesentation_vorlagen where id = ${Number(id) || 0}`;
    if (!v) throw new BusinessError('Vorlage nicht gefunden.', 404);
    return { name: v.dateiname, datei: Buffer.from(v.datei).toString('base64') };
  });

  /** Präsentation aus einer Vorlage (id „beispiel“ = mitgelieferte Beispielvorlage) */
  app.post('/praesentation/vorlagen/:id/erzeugen', sehen, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const e = eingaben.parse(req.body ?? {});
    let datei: Buffer, name: string;
    if (id === 'beispiel') { datei = asset('praesentation_beispiel.pptx'); name = 'Beispielvorlage'; }
    else {
      const [v] = await DB`select name, datei from tco.praesentation_vorlagen where id = ${Number(id) || 0}`;
      if (!v) throw new BusinessError('Vorlage nicht gefunden.', 404);
      datei = Buffer.from(v.datei); name = v.name;
    }
    const r = await ausVorlage(DB, datei, e);
    return { name: dateiname(e.titel || `${name} ${e.jahr}`), datei: r.datei.toString('base64'), typ: PPTX };
  });
}
