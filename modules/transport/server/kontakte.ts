import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../../../server/src/db.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { hasPermission } from '../../../server/src/permissions.js';
import { rechtAbgeschaltet } from '../../../server/src/funktionsschalter.js';
import { BusinessError } from '../../../server/src/errors.js';
import { PaperlessError } from '../../../server/src/lib/paperless.js';
import { adresseLesen, firmaLesen, isoDate } from './data.js';
import { condense } from './format.js';
import { DATEITYPEN, paperlessFirma } from './dokumente.js';
import { kontextAblegen } from '../../../server/src/lib/paperless-mapping.js';
import { K } from './paperless-kontexte.js';

/**
 * Kontakte (Euroflex) im Layout der Mitglieder: Liste mit Rollen-Filter und Kennzahlen,
 * Detail mit Stammdaten, Aufträgen (als Kunde, Unternehmer, Rechnungsempfänger) und
 * Dokumenten in Paperless (Korrespondent = Kontakt).
 */
type P = { display: string; kontakte: string; kontakteDisplay: string };
export const FILTER = { ALLE: 'Alle Kontakte', KUNDEN: 'Kunden', UNTERNEHMER: 'Unternehmer', RE: 'Rechnungsempfänger', OHNE: 'Ohne Aufträge' } as const;
type Filter = keyof typeof FILTER;

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const name = (a: { kundenname?: string | null; kundenname2?: string | null }) => condense(`${a.kundenname ?? ''} ${a.kundenname2 ?? ''}`);
const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';

export async function kontaktRoutes(app: FastifyInstance, P: P) {
  // lesen darf, wer Aufträge sieht (Auswahl im Auftrag) oder die App „Kontakte“ öffnen darf (#232, N7)
  const lesen = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      const darf = req.user && [P.display, P.kontakteDisplay].some((r) => hasPermission(req.user!.permissions, r) && !rechtAbgeschaltet(r));
      return requireAuth(darf ? undefined : P.kontakteDisplay)(req, reply);
    },
  };

  app.get('/kontakte/liste', lesen, async (req) => {
    const q = z.object({ filter: z.enum(Object.keys(FILTER) as [Filter, ...Filter[]]).default('ALLE'), suche: z.string().max(100).default('') }).parse(req.query);
    const rows = await sql`
      select a.adrnr, a.kundenname, a.kundenname2, a.land, a.plz, a.ort, a.email, a.telefon,
             count(*) filter (where o.kunde = a.adrnr)::int as als_kunde,
             count(*) filter (where o.unternehmer = a.adrnr)::int as als_unternehmer,
             count(*) filter (where o.rechnungsempfaenger = a.adrnr)::int as als_re,
             count(*) filter (where o.auftragsnr is not null and o.faktura is null and (o.kunde = a.adrnr or o.rechnungsempfaenger = a.adrnr))::int as offen,
             max(o.anlagedatum) as letzter
        from transport.adressen a
        left join transport.auftraege o on a.adrnr in (o.kunde, o.unternehmer, o.rechnungsempfaenger)
       where (coalesce(a.kundenname, '') <> '' or coalesce(a.kundenname2, '') <> '')
       group by a.adrnr
       order by lower(a.kundenname), lower(coalesce(a.kundenname2, '')), a.ort`;
    const s = q.suche.trim().toLowerCase();
    const alle = rows.map((r) => {
      const rollen = [r.als_kunde && 'Kunde', r.als_unternehmer && 'Unternehmer', r.als_re && 'Rechnungsempfänger'].filter(Boolean) as string[];
      return {
        adrnr: r.adrnr as number, name: name(r), ort: condense(`${r.land ?? ''} ${r.plz ?? ''} ${r.ort ?? ''}`),
        rollen, auftraege: r.als_kunde + r.als_unternehmer + r.als_re, offen: r.offen as number, letzter: isoDate(r.letzter),
        als_kunde: r.als_kunde as number, als_unternehmer: r.als_unternehmer as number, als_re: r.als_re as number,
        suchtext: `${name(r)} ${r.ort ?? ''} ${r.plz ?? ''} ${r.email ?? ''} ${r.telefon ?? ''} ${r.adrnr}`.toLowerCase(),
      };
    });
    const passt: Record<Filter, (x: (typeof alle)[number]) => boolean> = {
      ALLE: () => true, KUNDEN: (x) => x.als_kunde > 0, UNTERNEHMER: (x) => x.als_unternehmer > 0, RE: (x) => x.als_re > 0, OHNE: (x) => !x.auftraege,
    };
    const anzahl = Object.fromEntries((Object.keys(FILTER) as Filter[]).map((f) => [f, alle.filter(passt[f]).length]));
    return {
      anzahl, filter: FILTER,
      zeilen: alle.filter(passt[q.filter]).filter((x) => !s || x.suchtext.includes(s)).map(({ suchtext: _s, ...x }) => x),
    };
  });

  app.get('/kontakte/:nr', lesen, async (req) => {
    const { nr } = z.object({ nr: z.coerce.number().int() }).parse(req.params);
    const a = await adresseLesen(nr);
    if (!a) throw new BusinessError('Kontakt nicht gefunden.', 404);
    const rows = await sql`
      select o.auftragsnr, o.anlagedatum, o.leistungsdatum, o.kennzeichen, o.frachtpreis_ek, o.frachtpreis_vk, o.rgbetrag, o.faktura, o.fakturadatum,
             o.kunde, o.unternehmer, o.rechnungsempfaenger, k.kundenname as kunde_txt, u.kundenname as unternehmer_txt,
             s1.plzort as von, coalesce(s2.plzort_e, s1.plzort_e) as nach
        from transport.auftraege o
        left join transport.adressen k on k.adrnr = o.kunde
        left join transport.adressen u on u.adrnr = o.unternehmer
        left join transport.stops s1 on s1.auftragsnr = o.auftragsnr and s1.pos = 1
        left join transport.stops s2 on s2.auftragsnr = o.auftragsnr and s2.pos = 2
       where ${nr} in (o.kunde, o.unternehmer, o.rechnungsempfaenger)
       order by o.auftragsnr desc`;
    const auftraege = rows.map((r) => ({
      auftragsnr: r.auftragsnr as string, anlagedatum: isoDate(r.anlagedatum), leistungsdatum: isoDate(r.leistungsdatum), kennzeichen: r.kennzeichen,
      rollen: [r.kunde === nr && 'Kunde', r.unternehmer === nr && 'Unternehmer', r.rechnungsempfaenger === nr && 'Rechnungsempfänger'].filter(Boolean),
      kunde: r.kunde_txt ?? '', unternehmer: r.unternehmer_txt ?? '',
      route: [r.von, r.nach].filter(Boolean).join(' → '),
      ek: num(r.frachtpreis_ek), vk: num(r.frachtpreis_vk), betrag: num(r.rgbetrag),
      faktura: r.faktura, fakturadatum: isoDate(r.fakturadatum), status: r.faktura ? 'Fakturiert' : 'Offen',
    }));
    const kunde = auftraege.filter((x) => x.rollen.includes('Kunde') || x.rollen.includes('Rechnungsempfänger'));
    const jahr = String(new Date().getFullYear());
    return {
      adresse: a, titel: name(a),
      kennzahlen: {
        auftraege: auftraege.length,
        offen: kunde.filter((x) => x.status === 'Offen').length,
        umsatzJahr: kunde.filter((x) => (x.fakturadatum ?? x.anlagedatum ?? '').startsWith(jahr)).reduce((s, x) => s + x.betrag, 0),
        umsatzGesamt: kunde.reduce((s, x) => s + x.betrag, 0),
        ekGesamt: auftraege.filter((x) => x.rollen.includes('Unternehmer')).reduce((s, x) => s + x.ek, 0),
        letzter: auftraege[0]?.anlagedatum ?? null,
      },
      auftraege,
    };
  });

  /** Kontakt löschen – nur ohne Aufträge */
  app.delete('/kontakte/:nr', { preHandler: requireAuth(P.kontakte) }, async (req) => {
    const { nr } = z.object({ nr: z.coerce.number().int() }).parse(req.params);
    const [o] = await sql`select count(*)::int as n from transport.auftraege where ${nr} in (kunde, unternehmer, rechnungsempfaenger)`;
    if (o.n) throw new BusinessError(`Der Kontakt ist in ${o.n} Auftrag/Aufträgen eingetragen und kann nicht gelöscht werden.`);
    const r = await change(req, (tx) => tx`delete from transport.adressen where adrnr = ${nr}`, { action: 'KONTAKT_LOESCHEN' });
    if (!r.count) throw new BusinessError('Kontakt nicht gefunden.', 404);
    return { text: 'Kontakt gelöscht.' };
  });

  // ---------------------------------------------------------------- Dokumente (Paperless, Korrespondent = Kontakt)
  async function korrespondent(nr: number, anlegen: boolean) {
    const a = await adresseLesen(nr);
    if (!a) throw new BusinessError('Kontakt nicht gefunden.', 404);
    const pl = paperlessFirma(await firmaLesen());
    const k = await pl.korrespondent(name(a), anlegen);
    return { pl, k, name: name(a) };
  }
  const paperlessFehler = (e: unknown) => { if (e instanceof PaperlessError) throw new BusinessError(e.message); throw e; };

  app.get('/kontakte/:nr/dokumente', lesen, async (req) => {
    const { nr } = z.object({ nr: z.coerce.number().int() }).parse(req.params);
    const f = await firmaLesen();
    if (!f.paperless_url || !f.paperless_token) return { paperless: false, korrespondent: null, dokumente: [] };
    try {
      const { pl, k, name: n } = await korrespondent(nr, false);
      if (!k) return { paperless: true, korrespondent: null, soll: n, dokumente: [] };
      const docs = await pl.dokumenteSuchen({ correspondent__id: String(k), ordering: '-created' });
      const typen = new Map((await pl.dokumenttypen()).map((t) => [t.id, t.name]));
      return {
        paperless: true, korrespondent: k, soll: n,
        dokumente: docs.map((d) => ({
          id: d.id as number, titel: d.title ?? '', typ: typen.get(d.document_type) ?? '', erstellt: String(d.created_date ?? d.created ?? '').slice(0, 10),
          datei: d.original_file_name ?? '',
        })),
      };
    } catch (e) { return paperlessFehler(e); }
  });

  app.post('/kontakte/:nr/dokumente', { preHandler: requireAuth(P.kontakte), bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const { nr } = z.object({ nr: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ datei: z.string().min(1).max(200), inhalt: z.string().min(1, 'Die Datei ist leer.') }).parse(req.body);
    const datei = b.datei.split(/[\\/]/).pop()!.trim();
    const e = (/\.([a-z0-9]+)$/i.exec(datei)?.[1] ?? '').toLowerCase();
    if (!DATEITYPEN.includes(e)) throw new BusinessError(`Dateityp „${e || '?'}“ wird nicht unterstützt.`);
    const daten = Buffer.from(b.inhalt.replace(/^data:[^,]*,/, ''), 'base64');
    if (!daten.length) throw new BusinessError('Die Datei ist leer.');
    const mime = /^data:([^;,]+)/.exec(b.inhalt)?.[1] ?? 'application/octet-stream';
    try {
      const { pl, name: n } = await korrespondent(nr, false);
      // Felder laut zentraler Paperless-Zuordnung (Kontext „Dokument zum Kontakt“)
      const r = await kontextAblegen(pl, K.kontaktDokument, 'transport', { kontakt: n, adrnr: nr, datei, heute: new Date().toISOString().slice(0, 10), benutzer: benutzer(req) }, daten, datei, { mime });
      return { id: r.id, text: r.id ? `„${datei}“ in Paperless abgelegt (Dokument ${r.id}, Korrespondent ${n})${r.warnungen.length ? ` – ${r.warnungen.join('; ')}` : ''}` : 'Übertragen – Paperless verarbeitet die Datei noch' };
    } catch (x) { return paperlessFehler(x); }
  });

  /** Datei nur, wenn das Dokument diesem Kontakt (Korrespondent) gehört */
  app.get('/kontakte/:nr/dokumente/:id/datei', lesen, async (req, reply) => {
    const p = z.object({ nr: z.coerce.number().int(), id: z.coerce.number().int().positive() }).parse(req.params);
    try {
      const { pl, k } = await korrespondent(p.nr, false);
      const d = await pl.dokument(p.id);
      if (!k || d.correspondent !== k) throw new BusinessError('Dokument nicht gefunden.', 404);
      const f = await pl.download(p.id);
      return reply.type(f.contentType).header('content-disposition', `inline; filename="${encodeURIComponent(f.filename)}"`).send(f.data);
    } catch (e) { return paperlessFehler(e); }
  });
}
