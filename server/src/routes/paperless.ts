import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import { paperlessKontexte } from '../modules.js';
import { eigeneRegelLesen, mappingCacheLeeren, REGEL_FELDER, vorschau, zusammenfuehren, type Regel } from '../lib/paperless-mapping.js';

/** Zentrale Paperless-Zuordnung (Administration → Einstellungen): Regeln je Modul und Ablagekontext */
const P = 'core.settings:edit';
const vorlage = z.string().max(300);
const regelSchema = z.object({
  titel: vorlage.optional(), korrespondent: vorlage.optional(), dokumenttyp: vorlage.optional(), speicherpfad: vorlage.optional(),
  tags: vorlage.optional(), datum: vorlage.optional(), notiz: z.string().max(500).optional(),
  felder: z.record(z.string().max(80), vorlage).optional(), anlegen: z.boolean().optional(),
});

function finden(modul: string, kontext: string) {
  const m = paperlessKontexte().find((x) => x.modul === modul);
  const k = m?.kontexte.find((x) => x.id === kontext);
  if (!m || !k) throw new BusinessError('Ablagekontext nicht gefunden.', 404);
  return { m, k };
}

export async function paperlessMappingRoutes(app: FastifyInstance) {
  /** alle Kontexte mit Standard, gespeicherter Regel, wirksamer Regel und Vorschau */
  app.get('/api/paperless/mapping', { preHandler: requireAuth(P) }, async () => {
    const out = [];
    for (const m of paperlessKontexte()) {
      const kontexte = [];
      for (const k of m.kontexte) {
        const eigene = await eigeneRegelLesen(m.modul, k.id);
        const wirksam = zusammenfuehren(k.standard, eigene);
        kontexte.push({ ...k, eigene, wirksam, vorschau: vorschau(k, wirksam), geaendert: !!eigene });
      }
      out.push({ modul: m.modul, name: m.name, kontexte });
    }
    return { module: out, felder: REGEL_FELDER };
  });

  /** Auswahllisten aus Paperless (Dokumenttypen, Speicherpfade, Tags, Korrespondenten, Custom Fields) je Modul */
  app.get('/api/paperless/mapping/:modul/listen', { preHandler: requireAuth(P) }, async (req) => {
    const { modul } = z.object({ modul: z.string() }).parse(req.params);
    const m = paperlessKontexte().find((x) => x.modul === modul);
    if (!m) throw new BusinessError('Modul nicht gefunden.', 404);
    const pl = await m.client?.().catch(() => null);
    if (!pl) return { paperless: false, dokumenttypen: [], speicherpfade: [], tags: [], korrespondenten: [], felder: [] };
    try {
      const felder = (await pl.liste('custom_fields')) as { id: number; name: string; data_type?: string }[];
      return {
        paperless: true,
        dokumenttypen: (await pl.dokumenttypen()).map((x) => x.name).sort(),
        speicherpfade: (await pl.speicherpfade()).map((x) => x.name).sort(),
        tags: (await pl.tags()).map((x) => x.name).sort(),
        korrespondenten: (await pl.korrespondenten()).map((x) => x.name).sort().slice(0, 500),
        felder: felder.map((f) => ({ name: f.name, typ: f.data_type ?? '' })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (e) {
      return { paperless: true, fehler: (e as Error).message, dokumenttypen: [], speicherpfade: [], tags: [], korrespondenten: [], felder: [] };
    }
  });

  /** Vorschau einer (noch nicht gespeicherten) Regel mit Beispielwerten */
  app.post('/api/paperless/mapping/:modul/:kontext/vorschau', { preHandler: requireAuth(P) }, async (req) => {
    const p = z.object({ modul: z.string(), kontext: z.string() }).parse(req.params);
    const regel = regelSchema.parse(req.body ?? {});
    const { k } = finden(p.modul, p.kontext);
    return vorschau(k, regel as Regel);
  });

  /** Regel speichern (nur Abweichungen vom Standard) bzw. löschen = zurück zum Standard */
  app.put('/api/paperless/mapping/:modul/:kontext', { preHandler: requireAuth(P) }, async (req) => {
    const p = z.object({ modul: z.string(), kontext: z.string() }).parse(req.params);
    const regel = regelSchema.parse(req.body ?? {});
    const { k } = finden(p.modul, p.kontext);
    // nur Felder behalten, die vom Standard abweichen
    const abw: Regel = {};
    for (const f of REGEL_FELDER) if (regel[f] !== undefined && regel[f] !== (k.standard[f] ?? '')) abw[f] = regel[f];
    if (regel.anlegen !== undefined && regel.anlegen !== (k.standard.anlegen !== false)) abw.anlegen = regel.anlegen;
    if (regel.felder && JSON.stringify(regel.felder) !== JSON.stringify(k.standard.felder ?? {})) abw.felder = regel.felder;
    const benutzer = req.user?.displayName || req.user?.username || 'unbekannt';
    await change(req, async (tx) => {
      if (!Object.keys(abw).length) await tx`delete from core.paperless_mapping where modul = ${p.modul} and kontext = ${p.kontext}`;
      else {
        await tx`insert into core.paperless_mapping (modul, kontext, regel, geaendert_von) values (${p.modul}, ${p.kontext}, ${tx.json(abw as never)}, ${benutzer})
                 on conflict (modul, kontext) do update set regel = excluded.regel, geaendert_am = now(), geaendert_von = excluded.geaendert_von`;
      }
    }, { action: 'PAPERLESS_MAPPING' });
    mappingCacheLeeren();
    return { text: Object.keys(abw).length ? `Zuordnung „${k.text}“ gespeichert.` : `Zuordnung „${k.text}“ auf Standard zurückgesetzt.`, standard: !Object.keys(abw).length };
  });

  app.delete('/api/paperless/mapping/:modul/:kontext', { preHandler: requireAuth(P) }, async (req) => {
    const p = z.object({ modul: z.string(), kontext: z.string() }).parse(req.params);
    finden(p.modul, p.kontext);
    await change(req, (tx) => tx`delete from core.paperless_mapping where modul = ${p.modul} and kontext = ${p.kontext}`, { action: 'PAPERLESS_MAPPING' });
    mappingCacheLeeren();
    return { text: 'Zuordnung auf Standard zurückgesetzt.' };
  });

}
