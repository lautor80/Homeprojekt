import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import { mailVerfuegbar } from '../../../../server/src/lib/mail.js';
import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { DB, liste, paperless, vereinLesen, type Verein } from '../verein.js';
import { mailSenden } from '../kommunikation.js';
import {
  anlageSichern, anlagenLesen, bearbeiten, bearbeiterLesen, detailLesen, einstellungenLesen, einstellungenSichern, fotoLesenDb, fotoLoeschen,
  fotosAnhaengen, fotosMitDaten, kategorieSichern, kategorienLesen, kommentieren, kopfLesen, lauf, listeLesen, mailsNeu, matrixLesen, matrixSichern,
  meineLesen, meldungAnlegen, offeneZurAnlage, P_IH, protokoll, protokollLesen, sperreAufheben, sperreSetzen, zustaendigkeitAnlegen,
  zustaendigkeitenLesen, zustaendigkeitLoeschen, dokumenteLesen, dokumenteVerknuepfen, dokumentLoesen, dokumentVerknuepft,
  type DokumentInfo, type Einstellungen, type Ich, type Mail,
} from './logik.js';
import { formularAblegen, formularPdf, type FormularAngaben, type FormularDaten } from './formular.js';
import {
  ANLAGE_TYPEN, ANLASS, AUSWIRKUNG, DOK_ARTEN, PRIORITAET, STATUS, type AnlageTyp, type Anlass, type Auswirkung, type DokArt, type Prioritaet, type Status,
} from './regeln.js';
import { variantenLesen, varianteLoeschen, varianteSichern, varianteStandard, type Ansicht } from './varianten.js';

export { P_IH };

/**
 * Instandhaltung / Schadensmeldung (#205)
 *  - /schaden…        Mitglieder: melden, offene Meldungen zum Ort, „Meine Meldungen“, eigene Fotos
 *  - /instandhaltung… Bearbeitung (Platzwart, Hallenwart, Vorstand), Platzsperre, Formular/Paperless, Stammdaten, QR-Codes
 */
const txt = (max: number) => z.string().trim().max(max);
const foto = z.object({ name: z.string().max(200).default('foto'), data: z.string().max(3_000_000) });
const pId = z.object({ id: z.coerce.number().int().positive() });
const datumOpt = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT'), z.literal(''), z.null()]).optional()
  .transform((v) => (v === undefined ? undefined : v || null));
const geld = z.coerce.number().min(0).max(1_000_000).nullish().transform((v) => v ?? null);
const optId = z.coerce.number().int().positive().nullish().transform((v) => v ?? null);

const ich = (req: FastifyRequest): Ich => ({ id: req.user!.apiKey ? null : req.user!.id, name: req.user!.displayName || req.user!.username });

/** Mails senden (nicht kritisch: Fehler nur protokollieren) – {portal} wird durch die Portal-Adresse ersetzt; jede Mail ins Protokoll */
export async function mailsSenden(mails: Mail[], wer: Ich, log: FastifyBaseLogger): Promise<number> {
  if (!mails.length) return 0;
  try {
    if (!(await mailVerfuegbar())) return 0;
    const v = await vereinLesen();
    const url = (await portalUrl()) ?? '';
    let n = 0;
    for (const m of mails) {
      let ergebnis = '';
      try {
        await mailSenden(v, {
          modus: 'senden', anwendung: 'Instandhaltung', objekt: m.objekt, an: m.an, benutzer: wer.name, anhaenge: [], persoenlich: false,
          betreff: `${v.name}: ${m.betreff}`, text: `${m.text.replaceAll('{portal}', url)}\n\nViele Grüße\n${v.name}`,
        });
        n++;
        ergebnis = `an ${m.an}: ${m.betreff}`;
      } catch (e) {
        log.warn({ objekt: m.objekt, err: (e as Error).message }, 'Instandhaltung: E-Mail nicht gesendet');
        ergebnis = `NICHT gesendet an ${m.an} (${(e as Error).message}): ${m.betreff}`;
      }
      await withChange({ userId: wer.id, username: wer.name, action: 'IH_MAIL' }, (tx) => protokoll(tx, m.meldung_id, wer, 'MAIL', ergebnis))
        .catch((e) => log.warn(e, 'Instandhaltung: Protokoll E-Mail'));
    }
    return n;
  } catch (e) { log.warn({ err: (e as Error).message }, 'Instandhaltung: E-Mail-Versand nicht möglich'); return 0; }
}

let laufTimer: ReturnType<typeof setInterval> | null = null;

const formularSchema = z.object({
  anlass: z.enum(Object.keys(ANLASS) as [Anlass, ...Anlass[]]).default('ABSCHLUSS'),
  an: txt(200).nullish().transform((v) => v || null),
  bemerkung: txt(2000).nullish().transform((v) => v || null),
});

async function formularErzeugen(id: number, a: FormularAngaben) {
  if (a.anlass === 'WEITERGABE' && !a.an) throw new BusinessError('Bitte angeben, an wen die Meldung weitergegeben wird.');
  const kopf = await kopfLesen(DB, id);
  const daten = { ...kopf, protokoll: await protokollLesen(DB, id), dokumente: await dokumenteLesen(DB, id) } as unknown as FormularDaten & { formular_doc_id: number | null };
  const pdf = await formularPdf(await vereinLesen(), daten, await fotosMitDaten(DB, id), a);
  return { daten, pdf };
}

/**
 * Paperless-Dokumente, die mit einer Meldung verknüpft werden dürfen (Zugriffsschutz wie bei den FI-Belegen): Dokumenttyp oder
 * Speicherpfad aus den Einstellungen der Instandhaltung bzw. der FI-Belege, oder das Dokument ist bereits einer FI-Buchung oder
 * einer Meldung zugeordnet. So lassen sich keine beliebigen Dokumente (z. B. Aufnahmeanträge mit Bankdaten) durchreichen.
 */
async function bereich(v: Verein, cfg: Einstellungen) {
  const pl = paperless(v);
  const typen = await pl.ids('document_types', [...new Set([...liste(cfg.paperless_typen), ...liste(v.fi_beleg_typen)])]);
  const pfade = await pl.ids('storage_paths', [...new Set([...liste(cfg.paperless_pfade), ...liste(v.fi_beleg_pfad)])]);
  return { pl, typen, pfade };
}
async function dokumentImBereich(v: Verein, cfg: Einstellungen, id: number): Promise<DokumentInfo> {
  const { pl, typen, pfade } = await bereich(v, cfg);
  let d: Record<string, any>;
  try { d = await pl.dokument(id); } catch { throw new BusinessError(`Dokument ${id} wurde in Paperless nicht gefunden.`, 404); }
  const [fi] = await DB`select 1 from tco.fipapermap where ltrim(doknr, '0') = ${String(id)} limit 1`;
  const ok = fi || await dokumentVerknuepft(DB, id) || (d.document_type && typen.includes(Number(d.document_type))) || (d.storage_path && pfade.includes(Number(d.storage_path)));
  if (!ok) throw new BusinessError(`Dokument ${id} gehört nicht zur Instandhaltung oder zu den FI-Belegen (Dokumenttypen/Speicherpfade in den Stammdaten der Instandhaltung).`, 404);
  return { doc_id: id, titel: String(d.title ?? ''), korrespondent: await pl.korrespondentName(d.correspondent), datum: String(d.created_date ?? d.created ?? '').slice(0, 10) || null };
}

export async function instandhaltungRoutes(app: FastifyInstance) {
  // stündlich (nicht in Tests): Erinnerung bei Sicherheitsrisiko, Fotos nach Frist löschen
  if (!laufTimer && !process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test' && !process.env.TEST_DATABASE_URL) {
    laufTimer = setInterval(async () => {
      try {
        const r = await withChange({ userId: null, username: 'system (Instandhaltung)', action: 'IH_LAUF' }, (tx) => lauf(tx));
        if (r.erinnert.length || r.fotosGeloescht) app.log.info({ erinnert: r.erinnert, fotos: r.fotosGeloescht }, 'Instandhaltung: Lauf');
        await mailsSenden(r.mails, { id: null, name: 'system' }, app.log);
      } catch (e) { app.log.warn(e, 'Instandhaltung: Lauf fehlgeschlagen'); }
    }, 3_600_000);
    laufTimer.unref();
  }

  const melden = { preHandler: requireAuth(P_IH.melden) };
  const lesen = { preHandler: requireAuth(P_IH.display) };
  const schreiben = { preHandler: requireAuth(P_IH.edit) };
  const admin = { preHandler: requireAuth(P_IH.admin) };

  // ------------------------------------------------------------------ Melden (Mitglieder)
  app.get('/schaden/stamm', melden, async () => {
    const matrix = await matrixLesen(DB);
    return {
      anlagen: (await anlagenLesen(DB, true)).map(({ id, kuerzel, bezeichnung, gruppe, typ }) => ({
        id, kuerzel, bezeichnung, gruppe, typ, kategorien: matrix.filter((p) => p[0] === id).map((p) => p[1]),
      })),
      kategorien: (await kategorienLesen(DB, true)).map(({ id, bezeichnung }) => ({ id, bezeichnung })),
      auswirkungen: AUSWIRKUNG,
    };
  });

  app.get('/schaden/offen', melden, async (req) => {
    const { anlage } = z.object({ anlage: z.coerce.number().int().positive() }).parse(req.query);
    return offeneZurAnlage(DB, anlage);
  });

  app.post('/schaden', { ...melden, bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const b = z.object({
      anlage_id: z.coerce.number({ invalid_type_error: 'Bitte wählen, wo der Schaden ist.' }).int().positive('Bitte wählen, wo der Schaden ist.'),
      kategorie_id: z.coerce.number({ invalid_type_error: 'Bitte eine Kategorie wählen.' }).int().positive('Bitte eine Kategorie wählen.'),
      beschreibung: txt(2000).min(3, 'Bitte kurz beschreiben, was kaputt ist.'),
      auswirkung: z.enum(Object.keys(AUSWIRKUNG) as [Auswirkung, ...Auswirkung[]], { errorMap: () => ({ message: 'Bitte die Auswirkung wählen.' }) }),
      fotos: z.array(foto).max(3, 'Höchstens 3 Fotos.').default([]),
    }).parse(req.body);
    const wer = ich(req);
    const r = await change(req, (tx) => meldungAnlegen(tx, b, wer), { action: 'SCHADEN_MELDEN' });
    req.log.info({ schaden: r.nummer }, 'Schadensmeldung eingegangen');
    await mailsSenden(await mailsNeu(DB, r.id), wer, req.log);
    return r;
  });

  app.get('/schaden/meine', melden, async (req) => {
    if (!req.user?.id || req.user.apiKey) return [];
    return meineLesen(DB, req.user.id);
  });

  /** Foto: Bearbeiter alle, sonst nur die eigenen Meldungen */
  app.get('/schaden/foto/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = pId.parse(req.params);
    const darf = can(req, P_IH.display);
    if (!darf && !can(req, P_IH.melden)) throw new BusinessError('Keine Berechtigung.', 403);
    const f = await fotoLesenDb(DB, id, darf, req.user?.id ?? null);
    return reply.type(f.mime).header('cache-control', 'private, max-age=86400').send(f.daten);
  });

  // ------------------------------------------------------------------ Bearbeitung
  app.get('/instandhaltung', lesen, async (req) => {
    const q = z.object({ filter: z.enum(['OFFEN', 'ALLE']).default('OFFEN') }).parse(req.query);
    return {
      status: STATUS, auswirkungen: AUSWIRKUNG, typen: ANLAGE_TYPEN, anlaesse: ANLASS, prioritaeten: PRIORITAET, dokarten: DOK_ARTEN,
      anlagen: await anlagenLesen(DB), kategorien: await kategorienLesen(DB),
      bearbeiter: can(req, P_IH.edit) || can(req, P_IH.admin) ? (await bearbeiterLesen(DB)).map(({ id, name, rollen }) => ({ id, name, rollen })) : [],
      zeilen: await listeLesen(DB, q.filter),
    };
  });

  app.get('/instandhaltung/:id', lesen, async (req) => detailLesen(DB, pId.parse(req.params).id));

  app.put('/instandhaltung/:id', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({
      status: z.enum(Object.keys(STATUS) as [Status, ...Status[]]),
      // nicht angegeben = unverändert; leer/null = löschen
      prioritaet: z.enum(Object.keys(PRIORITAET) as [Prioritaet, ...Prioritaet[]]).optional(),
      geplant_bis: datumOpt, ende_ist: datumOpt,
      zustaendig: z.string().uuid().nullish().transform((v) => v ?? null),
      duplikat_von: optId,
      erledigung: txt(2000).nullish().transform((v) => v ?? null),
      kosten: geld, stunden: z.coerce.number().min(0).max(10_000).nullish().transform((v) => v ?? null),
      firma: txt(200).nullish().transform((v) => v ?? null), paperless: txt(300).nullish().transform((v) => v ?? null),
      kommentar: txt(2000).nullish().transform((v) => v ?? null), fuer_melder: z.boolean().default(false),
    }).parse(req.body);
    const wer = ich(req);
    const r = await change(req, (tx) => bearbeiten(tx, id, b, wer), { action: 'SCHADEN_BEARBEITEN', reason: String(id) });
    await mailsSenden(r.mails, wer, req.log);
    return { text: r.text };
  });

  app.post('/instandhaltung/:id/kommentar', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ text: txt(2000), fuer_melder: z.boolean().default(false) }).parse(req.body);
    return { text: await change(req, (tx) => kommentieren(tx, id, b.text, b.fuer_melder, ich(req)), { action: 'SCHADEN_KOMMENTAR', reason: String(id) }) };
  });

  app.post('/instandhaltung/:id/fotos', { ...schreiben, bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ fotos: z.array(foto).min(1).max(5), art: z.enum(['VORHER', 'NACHHER']).default('NACHHER') }).parse(req.body);
    return { text: await change(req, (tx) => fotosAnhaengen(tx, id, b.fotos, b.art, ich(req)), { action: 'SCHADEN_FOTO', reason: String(id) }) };
  });

  app.delete('/instandhaltung/foto/:id', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    return { text: await change(req, (tx) => fotoLoeschen(tx, id, ich(req)), { action: 'SCHADEN_FOTO_LOESCHEN', reason: String(id) }) };
  });

  /** Platz in der Platzbuchung sperren bzw. Sperre aufheben (feste Belegung „Gesperrt“) */
  app.post('/instandhaltung/:id/sperre', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    return { text: await change(req, (tx) => sperreSetzen(tx, id, ich(req)), { action: 'SCHADEN_SPERRE', reason: String(id) }) };
  });
  app.delete('/instandhaltung/:id/sperre', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    return { text: await change(req, (tx) => sperreAufheben(tx, id, ich(req)), { action: 'SCHADEN_SPERRE_AUF', reason: String(id) }) };
  });

  /** Formular (PDF) zur Ansicht/zum Druck – Anlass Abschluss oder Weitergabe */
  app.get('/instandhaltung/:id/formular.pdf', lesen, async (req, reply) => {
    const { id } = pId.parse(req.params);
    const q = formularSchema.parse(req.query);
    const { daten, pdf } = await formularErzeugen(id, { ...q, benutzer: ich(req).name });
    return reply.type('application/pdf').header('content-disposition', `inline; filename="Schadensmeldung_${daten.nummer}.pdf"`).send(pdf);
  });

  /** Formular in Paperless ablegen (Kontext „Schadensmeldung“; danach neue Version desselben Dokuments) */
  app.post('/instandhaltung/:id/formular', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const b = formularSchema.parse(req.body ?? {});
    const wer = ich(req);
    const a = { ...b, benutzer: wer.name };
    const { daten, pdf } = await formularErzeugen(id, a);
    const r = await formularAblegen(await vereinLesen(), daten, pdf, a);
    const dokid = String(r.id).padStart(6, '0');
    await change(req, async (tx) => {
      await tx`update tco.ih_meldung set formular_doc_id = ${r.id}, formular_am = now() where id = ${id}`;
      await tx`insert into tco.ih_dokument (meldung_id, doc_id, art, titel, von) values (${id}, ${r.id}, 'FORMULAR', ${`Schadensmeldung ${daten.nummer}`}, ${wer.name})
               on conflict (meldung_id, doc_id) do nothing`;
      await protokoll(tx, id, wer, 'FORMULAR', `Formular (${ANLASS[a.anlass]}${a.anlass === 'WEITERGABE' && a.an ? ` an ${a.an}` : ''}) in Paperless abgelegt – DOKID ${dokid}${r.neu ? '' : ', neue Version'}`);
    }, { action: 'SCHADEN_FORMULAR', reason: String(id) });
    return { text: `Formular in Paperless abgelegt (DOKID ${dokid}${r.neu ? '' : ', neue Version'}).`, dokid, warnungen: r.warnungen };
  });

  // ------------------------------------------------------------------ Paperless-Dokumente (Auswahldialog, per ID, Anzeige)
  /** Suche für den Auswahldialog: erste Treffer je Dokumenttyp/Speicherpfad der Instandhaltung und der FI-Belege */
  app.get('/instandhaltung/paperless/suche', schreiben, async (req) => {
    const { q } = z.object({ q: txt(100).default('') }).parse(req.query);
    const v = await vereinLesen();
    const { pl, typen, pfade } = await bereich(v, await einstellungenLesen(DB));
    const basis: Record<string, string> = { ordering: '-created', ...(q ? { title_content: q } : {}) };
    const treffer = new Map<number, Record<string, any>>();
    if (typen.length) for (const d of await pl.dokumenteErsteSeite({ ...basis, document_type__id__in: typen.join(',') })) treffer.set(Number(d.id), d);
    if (pfade.length) for (const d of await pl.dokumenteErsteSeite({ ...basis, storage_path__id__in: pfade.join(',') })) treffer.set(Number(d.id), d);
    const out = [];
    for (const d of treffer.values()) {
      out.push({ id: Number(d.id), titel: String(d.title ?? ''), korrespondent: await pl.korrespondentName(d.correspondent), datum: String(d.created_date ?? d.created ?? '').slice(0, 10) || null });
    }
    return out.sort((a, b) => (b.datum ?? '').localeCompare(a.datum ?? '') || b.id - a.id).slice(0, 80);
  });

  /** Ein Dokument per Paperless-ID prüfen (für den Dialog) */
  app.get('/instandhaltung/paperless/:id', schreiben, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive().max(99_999_999) }).parse(req.params);
    return dokumentImBereich(await vereinLesen(), await einstellungenLesen(DB), id);
  });

  /** mehrere Dokumente mit der Meldung verknüpfen (Auswahldialog oder Paperless-ID) */
  app.post('/instandhaltung/:id/dokumente', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({
      doc_ids: z.array(z.coerce.number().int().positive().max(99_999_999)).min(1, 'Bitte mindestens ein Dokument wählen.').max(30),
      art: z.enum(Object.keys(DOK_ARTEN) as [DokArt, ...DokArt[]]).default('SONSTIGES'),
    }).parse(req.body);
    const v = await vereinLesen();
    const cfg = await einstellungenLesen(DB);
    const docs: DokumentInfo[] = [];
    for (const d of [...new Set<number>(b.doc_ids)]) docs.push(await dokumentImBereich(v, cfg, d));
    return { text: await change(req, (tx) => dokumenteVerknuepfen(tx, id, docs, b.art, ich(req)), { action: 'SCHADEN_DOKUMENT', reason: String(id) }) };
  });

  app.delete('/instandhaltung/:id/dokumente/:doc', schreiben, async (req) => {
    const { id, doc } = z.object({ id: z.coerce.number().int().positive(), doc: z.coerce.number().int().positive() }).parse(req.params);
    return { text: await change(req, (tx) => dokumentLoesen(tx, id, doc, ich(req)), { action: 'SCHADEN_DOKUMENT', reason: String(id) }) };
  });

  /** Anzeige eines verknüpften Dokuments (nur Dokumente, die an einer Meldung hängen) */
  app.get('/instandhaltung/dokument/:doc/pdf', lesen, async (req, reply) => {
    const { doc } = z.object({ doc: z.coerce.number().int().positive() }).parse(req.params);
    if (!(await dokumentVerknuepft(DB, doc))) throw new BusinessError('Dieses Dokument ist mit keiner Schadensmeldung verknüpft.', 404);
    const d = await paperless(await vereinLesen()).download(doc);
    return reply.type(d.contentType).header('content-disposition', `inline; filename="${encodeURIComponent(d.filename)}"`).send(d.data);
  });

  // ------------------------------------------------------------------ Listenvarianten je Benutzer (Filter, Sortierung, Standard)
  const benutzer = (req: FastifyRequest) => req.user!.username;
  app.get('/instandhaltung/varianten', lesen, async (req) => ({
    varianten: await variantenLesen(DB, benutzer(req)), standard: await varianteStandard(DB, benutzer(req)),
  }));
  app.post('/instandhaltung/varianten', lesen, async (req) => {
    const b = z.object({
      name: txt(30).min(1, 'Bitte einen Namen für die Variante angeben.'), standard: z.boolean().default(false), global: z.boolean().default(false),
      ansicht: z.object({
        alle: z.boolean().default(false), suche: txt(100).default(''),
        filter: z.record(z.string().max(40), z.string().max(200)).default({}),
        sort: z.object({ k: z.string().max(40), ab: z.boolean() }).nullable().default(null),
      }),
    }).parse(req.body);
    if (b.global && !can(req, P_IH.admin)) throw new BusinessError('Globale Varianten darf nur anlegen, wer die Stammdaten der Instandhaltung pflegt.', 403);
    const v = await change(req, (tx) => varianteSichern(tx, benutzer(req), b, b.ansicht as Ansicht), { action: 'IH_VARIANTE' });
    return { text: `Variante „${v.name}“ gesichert${b.standard ? ' (Standard)' : ''}.`, variante: v };
  });
  app.delete('/instandhaltung/varianten', lesen, async (req) => {
    const { key } = z.object({ key: z.string().min(3).max(100) }).parse(req.body);
    if (key.startsWith('*/') && !can(req, P_IH.admin)) throw new BusinessError('Globale Varianten darf nur löschen, wer die Stammdaten der Instandhaltung pflegt.', 403);
    return { text: `Variante „${await change(req, (tx) => varianteLoeschen(tx, benutzer(req), key), { action: 'IH_VARIANTE' })}“ gelöscht.` };
  });

  // ------------------------------------------------------------------ Stammdaten
  app.get('/instandhaltung/stamm/daten', admin, async () => ({
    anlagen: await anlagenLesen(DB), kategorien: await kategorienLesen(DB), matrix: await matrixLesen(DB),
    zustaendigkeiten: await zustaendigkeitenLesen(DB), einstellungen: await einstellungenLesen(DB),
    bearbeiter: await bearbeiterLesen(DB), typen: ANLAGE_TYPEN,
    plaetze: await DB`select id, name from tco.plaetze order by sort, name`,
  }));

  const anlageSchema = z.object({
    kuerzel: txt(30).min(1, 'Bitte ein Kürzel angeben.'), bezeichnung: txt(80).min(1, 'Bitte eine Bezeichnung angeben.'), gruppe: txt(60).default(''),
    typ: z.enum(Object.keys(ANLAGE_TYPEN) as [AnlageTyp, ...AnlageTyp[]]),
    platz_id: optId, sort: z.coerce.number().int().default(0), aktiv: z.boolean().default(true),
  });
  app.post('/instandhaltung/stamm/anlagen', admin, async (req) => {
    const b = anlageSchema.parse(req.body);
    return change(req, (tx) => anlageSichern(tx, null, b), { action: 'IH_ANLAGE' });
  });
  app.put('/instandhaltung/stamm/anlagen/:id', admin, async (req) => {
    const { id } = pId.parse(req.params);
    const b = anlageSchema.parse(req.body);
    return change(req, (tx) => anlageSichern(tx, id, b), { action: 'IH_ANLAGE' });
  });

  const kategorieSchema = z.object({
    bezeichnung: txt(60).min(1, 'Bitte eine Bezeichnung angeben.'), sort: z.coerce.number().int().default(0), aktiv: z.boolean().default(true),
  });
  app.post('/instandhaltung/stamm/kategorien', admin, async (req) => {
    const b = kategorieSchema.parse(req.body);
    return change(req, (tx) => kategorieSichern(tx, null, b), { action: 'IH_KATEGORIE' });
  });
  app.put('/instandhaltung/stamm/kategorien/:id', admin, async (req) => {
    const { id } = pId.parse(req.params);
    const b = kategorieSchema.parse(req.body);
    return change(req, (tx) => kategorieSichern(tx, id, b), { action: 'IH_KATEGORIE' });
  });

  /** Matrix Kategorie × Ort: vollständige Liste der zugelassenen Paare */
  app.put('/instandhaltung/stamm/matrix', admin, async (req) => {
    const b = z.object({ paare: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).max(20_000) }).parse(req.body);
    return { text: await change(req, (tx) => matrixSichern(tx, b.paare), { action: 'IH_MATRIX' }) };
  });

  /** Zuständigkeit: Benutzer (mit Berechtigung über seine Rolle) für einen Ort, eine Kategorie oder beides */
  app.post('/instandhaltung/stamm/zustaendig', admin, async (req) => {
    const b = z.object({ benutzer_id: z.string().uuid('Bitte eine Person wählen.'), anlage_id: optId, kategorie_id: optId }).parse(req.body);
    return { text: await change(req, (tx) => zustaendigkeitAnlegen(tx, b), { action: 'IH_ZUSTAENDIG' }) };
  });
  app.delete('/instandhaltung/stamm/zustaendig/:id', admin, async (req) => {
    const { id } = pId.parse(req.params);
    return { text: await change(req, (tx) => zustaendigkeitLoeschen(tx, id), { action: 'IH_ZUSTAENDIG' }) };
  });

  app.put('/instandhaltung/stamm/einstellungen', admin, async (req) => {
    const b = z.object({
      vorstand_email: txt(500).default(''), foto_frist_monate: z.coerce.number().int().min(1).max(120),
      paperless_typen: txt(500).optional(), paperless_pfade: txt(500).optional(),
    }).parse(req.body);
    return { text: await change(req, (tx) => einstellungenSichern(tx, b), { action: 'IH_CFG' }) };
  });

  /** QR-Codes zum Aushängen: je Ort ein Schild (zwei je Seite), Link öffnet „Schaden melden“ mit vorbelegtem Ort */
  app.get('/instandhaltung/stamm/qr.pdf', admin, async (req, reply) => {
    const { anlage } = z.object({ anlage: z.coerce.number().int().positive().optional() }).parse(req.query);
    const url = await portalUrl();
    if (!url) throw new BusinessError('Die Portal-Adresse ist nicht eingerichtet (Administration → Einstellungen) – ohne sie funktionieren die QR-Codes nicht.');
    const anlagen = (await anlagenLesen(DB, true)).filter((a) => !anlage || a.id === anlage);
    if (!anlagen.length) throw new BusinessError('Kein aktiver Ort gefunden.', 404);
    const v = await vereinLesen();
    const p = new Pdf({ title: 'QR-Codes Schadensmeldung', author: v.name, creator: 'TCO Vereinsportal' });
    anlagen.forEach((a, i) => {
      if (i % 2 === 0) p.newPage();
      const y = i % 2 === 0 ? 15 : 160;
      if (i % 2 === 1) p.line(10, 148.5, 200, 148.5, 'B0B4B8', 0.3);
      const link = `${url}/tco/schaden?anlage=${encodeURIComponent(a.kuerzel)}`;
      p.text(105, y + 4, v.name, { size: 12, align: 'C', color: '6A6D70' });
      p.text(105, y + 16, 'Schaden entdeckt?', { size: 26, bold: true, align: 'C' });
      p.text(105, y + 28, a.gruppe ? `${a.gruppe} · ${a.bezeichnung}` : a.bezeichnung, { size: 18, align: 'C' });
      p.qr(link, 67.5, y + 36, 75);
      p.text(105, y + 117, 'QR-Code scannen, anmelden und kurz beschreiben – danke!', { size: 11, align: 'C' });
      p.text(105, y + 124, link, { size: 8, align: 'C', color: '6A6D70' });
    });
    const pdf = await p.render();
    return reply.type('application/pdf').header('content-disposition', 'inline; filename="qr-schadensmeldung.pdf"').send(pdf);
  });
}
