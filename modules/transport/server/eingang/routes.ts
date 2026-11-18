import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, requireAuth } from '../../../../server/src/auth.js';
import { sql } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { P_MW, workflowEinstellungen } from '../mailworkflows.js';
import { postfachListe, type Grund, type Kandidat } from './logik.js';
import {
  abrufAnstossen, letzterAbrufLesen, mailVerarbeiten, neuBewerten, offeneNeuBewerten, speicherStand, uebernommen, vonHandAblegen, vorgangIgnorieren,
} from './verarbeitung.js';

/**
 * Euroflex Posteingang (Outlook 365 → n8n → Portal): Schnittstelle für n8n und Prüfliste.
 * Vertrag: docs/euroflex-mailworkflows.md, Abschnitt „Eingang“.
 *  - transport.eingang:display  Prüfliste und Speicherbelegung ansehen
 *  - transport.eingang:edit     ablegen, ignorieren, neu bewerten, „Jetzt abrufen“
 *  - transport.eingang:execute  nur für den API-Schlüssel von n8n: E-Mails liefern
 *  - Aufträge: Eingangsdokumente am Auftrag (anzeigen) und Übernahme in den Ablageordner melden (ändern)
 */
const P_AUFTRAG = { display: 'transport.auftraege:display', edit: 'transport.auftraege:edit' };

const wer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const idParam = z.object({ id: z.coerce.number().int().positive() });
const leer = (max: number) => z.string().max(max).nullish().transform((x) => x ?? '');
const optional = (max: number) => z.string().max(max).nullish().transform((x) => x || null);

const eingang = z.object({
  postfach: leer(300),
  graph_id: optional(1000),
  message_id: leer(1000),
  in_reply_to: optional(2000),
  references: optional(20_000),
  auto: optional(200),
  von: leer(1000), an: leer(4000), betreff: leer(2000),
  datum: optional(100),
  text: z.string().nullish().transform((x) => (x ?? '').slice(0, 200_000)),
  html: z.string().nullish().transform((x) => (x ?? '').slice(0, 500_000)),
  anhaenge: z.array(z.object({
    name: z.string().min(1).max(500),
    mime: optional(200),
    inhalt: z.string(),
  })).max(40, 'Höchstens 40 Anhänge je E-Mail.').default([]),
});

/** Dateitypen, die der Browser gefahrlos anzeigen darf – alles andere wird als Download geliefert */
const ANZEIGBAR = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/i;

export async function eingangRoutes(app: FastifyInstance) {
  const sehen = { preHandler: requireAuth(P_MW.eingangDisplay) };
  const pflegen = { preHandler: requireAuth(P_MW.eingangEdit) };
  const melden = { preHandler: requireAuth(P_MW.eingangMelden) };

  // ---------------------------------------------------------------- Schnittstelle für n8n
  /** E-Mail samt Anhängen liefern; Antwort: Vorgang, Status, Auftrag und der Outlook-Ordner, in den n8n die Mail verschiebt */
  app.post('/eingang/mail', { ...melden, bodyLimit: 80 * 1024 * 1024 }, async (req) => mailVerarbeiten(eingang.parse(req.body)));

  // ---------------------------------------------------------------- Prüfliste
  app.get('/eingang/vorgaenge', sehen, async (req) => {
    const q = z.object({
      status: z.enum(['pruefen', 'fehler', 'abgelegt', 'ignoriert']).or(z.literal('')).optional().transform((x) => x || null),
      // Eingangspostfach (z. B. info@ oder buchhaltung@), leer = alle
      postfach: z.string().trim().toLowerCase().max(300).optional().transform((x) => x || null),
    }).parse(req.query);
    const rows = await sql`
      select v.id::int as id, v.postfach, v.von, v.von_name, v.betreff, to_char(v.datum at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as datum, to_char(v.eingang_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as eingang_am,
             case when v.status = 'neu' then 'pruefen' else v.status end as status, v.hinweis, v.auftragsnr, v.punkte,
             jsonb_array_length(v.kandidaten)::int as anzahl_kandidaten,
             (select count(*)::int from transport.eing_dokumente d where d.vorgang_id = v.id) as anzahl_dokumente
        from transport.eing_vorgaenge v
       where true ${q.status === 'pruefen' ? sql`and v.status in ('neu', 'pruefen')` : q.status ? sql`and v.status = ${q.status}` : sql``}
         ${q.postfach ? sql`and v.postfach = ${q.postfach}` : sql``}
       order by v.id desc limit 500`;
    const [letzter, e, gesehen] = await Promise.all([
      letzterAbrufLesen(), workflowEinstellungen(),
      sql`select distinct postfach from transport.eing_vorgaenge where postfach <> '' order by postfach`,
    ]);
    return {
      vorgaenge: rows, letzter_abruf: letzter, schwelle: e.eingang.schwelle,
      postfaecher: postfachListe(e.eingang.postfaecher, gesehen.map((r) => r.postfach as string)),
    };
  });

  app.get('/eingang/vorgaenge/:id', sehen, async (req) => {
    const { id } = idParam.parse(req.params);
    const [v] = await sql`
      select id::int as id, postfach, von, von_name, an, betreff, to_char(datum at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as datum, to_char(eingang_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as eingang_am,
             case when status = 'neu' then 'pruefen' else status end as status, hinweis, text, auftragsnr, punkte, begruendung, kandidaten,
             mail_aktion, to_char(abgeschlossen_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as abgeschlossen_am, bearbeitet_von
        from transport.eing_vorgaenge where id = ${id}`;
    if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
    const kand = (v.kandidaten ?? []) as Kandidat[];
    const info: Record<string, unknown>[] = kand.length ? [...await sql`
      select a.auftragsnr, a.anlagedatum, a.ordernummer, a.faktura, nullif(btrim(concat_ws(' ', k.kundenname, k.kundenname2)), '') as kunde
        from transport.auftraege a left join transport.adressen k on k.adrnr = a.kunde
       where a.auftragsnr = any(${kand.map((k) => k.auftragsnr)})`] : [];
    const je = new Map(info.map((r): [string, Record<string, unknown>] => [r.auftragsnr as string, r]));
    const dokumente = await sql`
      select id::int as id, art, datei, mime, groesse, status, ziel, paperless_id, hinweis, inhalt is not null as vorhanden,
             left(coalesce(ocr_text, ''), 500) as ocr_auszug
        from transport.eing_dokumente where vorgang_id = ${id} order by id`;
    const e = await workflowEinstellungen();
    return {
      ...v,
      schwelle: e.eingang.schwelle,
      kandidaten: kand.map((k) => {
        const a = je.get(k.auftragsnr);
        const gruende: Grund[] = k.gruende ?? [];
        return {
          auftragsnr: k.auftragsnr, punkte: k.punkte, begruendung: gruende, gruende,
          kunde: (a?.kunde as string | null) ?? null, datum: (a?.anlagedatum as string | null) ?? null,
          ordernummer: (a?.ordernummer as string | null) ?? null, faktura: (a?.faktura as string | null) ?? null, vorhanden: !!a,
        };
      }),
      dokumente,
    };
  });

  /**
   * Datei eines Dokuments, solange der Inhalt im Portal liegt. Posteingang bearbeiten – oder Aufträge ändern, wenn das Dokument
   * auf die Übernahme in den Ablageordner wartet (der Browser holt sie beim Öffnen des Auftrags).
   */
  app.get('/eingang/dokumente/:id/datei', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [d] = await sql`select datei, mime, status, inhalt from transport.eing_dokumente where id = ${id}`;
    // wartende und aufbewahrte (übernommene) Inhalte darf auch laden, wer Aufträge ändern darf – für Übernahme und „Erneut ablegen“
    const darf = can(req, P_MW.eingangEdit) || ((d?.status === 'wartet' || d?.status === 'uebernommen') && can(req, P_AUFTRAG.edit));
    if (!darf) return reply.code(403).send({ message: `Keine Berechtigung (${P_MW.eingangEdit}).` });
    if (!d?.inhalt) throw new BusinessError('Die Datei liegt nicht (mehr) im Portal.', 404);
    const mime = (d.mime as string | null) ?? 'application/octet-stream';
    const anzeigen = ANZEIGBAR.test(mime);
    return reply
      .type(anzeigen ? mime : 'application/octet-stream')
      .header('content-disposition', `${anzeigen ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.datei as string)}`)
      .header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(d.inhalt as string, 'base64'));
  });

  app.post('/eingang/vorgaenge/:id/ablegen', pflegen, async (req, reply) => {
    if (!can(req, P_AUFTRAG.display)) return reply.code(403).send({ message: `Keine Berechtigung (${P_AUFTRAG.display}).` });
    const { id } = idParam.parse(req.params);
    const b = z.object({
      auftragsnr: z.string().trim().min(1, 'Bitte einen Auftrag wählen.').max(40),
      dokumente: z.array(z.coerce.number().int().positive()).min(1, 'Bitte mindestens ein Dokument wählen.').max(100),
    }).parse(req.body);
    return vonHandAblegen(id, b.auftragsnr, b.dokumente, wer(req));
  });

  app.post('/eingang/vorgaenge/:id/ignorieren', pflegen, async (req) => vorgangIgnorieren(idParam.parse(req.params).id, wer(req)));
  app.post('/eingang/vorgaenge/:id/neu-bewerten', pflegen, async (req) => neuBewerten(idParam.parse(req.params).id, wer(req)));

  /** „Jetzt abrufen“: offene Vorgänge neu bewerten und – falls eingerichtet – den n8n-Workflow anstoßen */
  app.post('/eingang/abruf', pflegen, async (req) => {
    const b = await offeneNeuBewerten(wer(req));
    const bewertet = b.vorgaenge
      ? `${b.vorgaenge} offene${b.vorgaenge === 1 ? 'r Vorgang' : ' Vorgänge'} neu bewertet${b.abgelegt ? `, ${b.abgelegt} abgelegt` : ''}.`
      : 'Keine offenen Vorgänge.';
    let abruf: string | null;
    try {
      abruf = await abrufAnstossen(`Portal (${wer(req)})`);
    } catch (e) {
      throw new BusinessError(`${bewertet} Abruf aus dem Postfach fehlgeschlagen: ${(e as Error).message}`, 502);
    }
    if (!abruf) {
      return { abruf: false, ...b, text: `${bewertet} Kein Abruf aus dem Postfach: Die Anbindung „Euroflex Maileingang jetzt abrufen (n8n)“ ist nicht eingerichtet (Administration → Schnittstellen).` };
    }
    return { abruf: true, ...b, text: `${bewertet} ${abruf}` };
  });

  /** Belegung durch noch nicht übernommene Inhalte */
  app.get('/eingang/speicher', sehen, async () => speicherStand());

  // ---------------------------------------------------------------- am Auftrag (Ablageordner)
  app.get('/auftraege/:nr/eingang', { preHandler: requireAuth(P_AUFTRAG.display) }, async (req) => {
    const { nr } = z.object({ nr: z.string().max(40) }).parse(req.params);
    return sql`
      select d.id::int as id, d.datei, d.ablage_name, d.inhalt is not null as vorhanden, d.mime, d.groesse, d.status, d.ziel, d.paperless_id, v.von, v.von_name, v.betreff, to_char(v.datum at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as datum
        from transport.eing_dokumente d join transport.eing_vorgaenge v on v.id = d.vorgang_id
       where v.auftragsnr = ${nr} and d.status in ('wartet', 'uebernommen', 'abgelegt')
       order by d.id`;
  });

  /** Browser hat die Datei in den Ablageordner (Unterordner Eingang/) geschrieben → Inhalt löschen, Status „uebernommen“ */
  app.post('/eingang/dokumente/:id/uebernommen', { preHandler: requireAuth(P_AUFTRAG.edit) }, async (req) => {
    // ablage_name: tatsächlicher Dateiname im Ordner (ohne Pfad), damit die Datei am Auftrag direkt geöffnet werden kann
    const b = z.object({ ablage_name: z.string().trim().min(1).max(255).regex(/^[^\\/:*?"<>|]+$/, 'Ungültiger Dateiname.').nullish() }).parse(req.body ?? {});
    return uebernommen(idParam.parse(req.params).id, wer(req), b.ablage_name);
  });
}
