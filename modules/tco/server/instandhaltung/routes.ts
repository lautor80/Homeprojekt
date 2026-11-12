import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import { mailVerfuegbar } from '../../../../server/src/lib/mail.js';
import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { DB, vereinLesen } from '../verein.js';
import { mailSenden } from '../kommunikation.js';
import {
  anlageSichern, anlagenLesen, bearbeiten, bearbeiterLesen, detailLesen, einstellungenLesen, einstellungenSichern, fotoLesenDb, fotoLoeschen,
  fotosAnhaengen, kategorieSichern, kategorienLesen, kommentieren, lauf, listeLesen, mailsNeu, meineLesen, meldungAnlegen, offeneZurAnlage,
  P_IH, sperreAufheben, sperreSetzen, type Mail,
} from './logik.js';
import { ANLAGE_TYPEN, AUSWIRKUNG, STATUS, type AnlageTyp, type Auswirkung, type Status } from './regeln.js';

export { P_IH };

/**
 * Instandhaltung / Schadensmeldung (#205)
 *  - /schaden…        Mitglieder: melden, offene Meldungen zur Anlage, „Meine Meldungen“, eigene Fotos
 *  - /instandhaltung… Bearbeitung (Platzwart, Hallenwart, Vorstand), Platzsperre, Stammdaten, QR-Codes
 */
const txt = (max: number) => z.string().trim().max(max);
const foto = z.object({ name: z.string().max(200).default('foto'), data: z.string().max(3_000_000) });
const pId = z.object({ id: z.coerce.number().int().positive() });
const geld = z.coerce.number().min(0).max(1_000_000).nullish().transform((v) => v ?? null);

const wer = (req: FastifyRequest) => req.user!.displayName || req.user!.username;

/** Mails senden (nicht kritisch: Fehler nur protokollieren) – {portal} wird durch die Portal-Adresse ersetzt */
export async function mailsSenden(mails: Mail[], benutzer: string, log: FastifyBaseLogger): Promise<number> {
  if (!mails.length) return 0;
  try {
    if (!(await mailVerfuegbar())) return 0;
    const v = await vereinLesen();
    const url = (await portalUrl()) ?? '';
    let n = 0;
    for (const m of mails) {
      try {
        await mailSenden(v, {
          modus: 'senden', anwendung: 'Instandhaltung', objekt: m.objekt, an: m.an, benutzer, anhaenge: [], persoenlich: false,
          betreff: `${v.name}: ${m.betreff}`, text: `${m.text.replaceAll('{portal}', url)}\n\nViele Grüße\n${v.name}`,
        });
        n++;
      } catch (e) { log.warn({ objekt: m.objekt, err: (e as Error).message }, 'Instandhaltung: E-Mail nicht gesendet'); }
    }
    return n;
  } catch (e) { log.warn({ err: (e as Error).message }, 'Instandhaltung: E-Mail-Versand nicht möglich'); return 0; }
}

let laufTimer: ReturnType<typeof setInterval> | null = null;

export async function instandhaltungRoutes(app: FastifyInstance) {
  // stündlich (nicht in Tests): Erinnerung bei Sicherheitsrisiko, Fotos nach Frist löschen
  if (!laufTimer && !process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test' && !process.env.TEST_DATABASE_URL) {
    laufTimer = setInterval(async () => {
      try {
        const r = await withChange({ userId: null, username: 'system (Instandhaltung)', action: 'IH_LAUF' }, (tx) => lauf(tx));
        if (r.erinnert.length || r.fotosGeloescht) app.log.info({ erinnert: r.erinnert, fotos: r.fotosGeloescht }, 'Instandhaltung: Lauf');
        await mailsSenden(r.mails, 'system', app.log);
      } catch (e) { app.log.warn(e, 'Instandhaltung: Lauf fehlgeschlagen'); }
    }, 3_600_000);
    laufTimer.unref();
  }

  const melden = { preHandler: requireAuth(P_IH.melden) };
  const lesen = { preHandler: requireAuth(P_IH.display) };
  const schreiben = { preHandler: requireAuth(P_IH.edit) };
  const admin = { preHandler: requireAuth(P_IH.admin) };

  // ------------------------------------------------------------------ Melden (Mitglieder)
  app.get('/schaden/stamm', melden, async () => ({
    anlagen: (await anlagenLesen(DB, true)).map(({ id, kuerzel, bezeichnung, typ }) => ({ id, kuerzel, bezeichnung, typ })),
    kategorien: (await kategorienLesen(DB, true)).map(({ id, bezeichnung }) => ({ id, bezeichnung })),
    auswirkungen: AUSWIRKUNG,
  }));

  app.get('/schaden/offen', melden, async (req) => {
    const { anlage } = z.object({ anlage: z.coerce.number().int().positive() }).parse(req.query);
    return offeneZurAnlage(DB, anlage);
  });

  app.post('/schaden', { ...melden, bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const b = z.object({
      anlage_id: z.coerce.number({ invalid_type_error: 'Bitte den Ort wählen.' }).int().positive('Bitte den Ort wählen.'),
      kategorie_id: z.coerce.number({ invalid_type_error: 'Bitte eine Kategorie wählen.' }).int().positive('Bitte eine Kategorie wählen.'),
      beschreibung: txt(2000).min(3, 'Bitte kurz beschreiben, was kaputt ist.'),
      auswirkung: z.enum(Object.keys(AUSWIRKUNG) as [Auswirkung, ...Auswirkung[]], { errorMap: () => ({ message: 'Bitte die Auswirkung wählen.' }) }),
      fotos: z.array(foto).max(3, 'Höchstens 3 Fotos.').default([]),
    }).parse(req.body);
    const ich = { id: req.user!.apiKey ? null : req.user!.id, name: wer(req) };
    const r = await change(req, (tx) => meldungAnlegen(tx, b, ich), { action: 'SCHADEN_MELDEN' });
    req.log.info({ schaden: r.nummer }, 'Schadensmeldung eingegangen');
    await mailsSenden(await mailsNeu(DB, r.id), ich.name, req.log);
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
      status: STATUS, auswirkungen: AUSWIRKUNG, typen: ANLAGE_TYPEN,
      anlagen: await anlagenLesen(DB), kategorien: await kategorienLesen(DB),
      bearbeiter: can(req, P_IH.edit) || can(req, P_IH.admin) ? (await bearbeiterLesen(DB)).map(({ id, name }) => ({ id, name })) : [],
      zeilen: await listeLesen(DB, q.filter),
    };
  });

  app.get('/instandhaltung/:id', lesen, async (req) => detailLesen(DB, pId.parse(req.params).id));

  app.put('/instandhaltung/:id', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({
      status: z.enum(Object.keys(STATUS) as [Status, ...Status[]]),
      zustaendig: z.string().uuid().nullish().transform((v) => v ?? null),
      duplikat_von: z.coerce.number().int().positive().nullish().transform((v) => v ?? null),
      erledigung: txt(2000).nullish().transform((v) => v ?? null),
      kosten: geld, stunden: z.coerce.number().min(0).max(10_000).nullish().transform((v) => v ?? null),
      firma: txt(200).nullish().transform((v) => v ?? null), paperless: txt(300).nullish().transform((v) => v ?? null),
      kommentar: txt(2000).nullish().transform((v) => v ?? null), fuer_melder: z.boolean().default(false),
    }).parse(req.body);
    const r = await change(req, (tx) => bearbeiten(tx, id, b, wer(req)), { action: 'SCHADEN_BEARBEITEN', reason: String(id) });
    await mailsSenden(r.mails, wer(req), req.log);
    return { text: r.text };
  });

  app.post('/instandhaltung/:id/kommentar', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ text: txt(2000), fuer_melder: z.boolean().default(false) }).parse(req.body);
    return { text: await change(req, (tx) => kommentieren(tx, id, b.text, b.fuer_melder, wer(req)), { action: 'SCHADEN_KOMMENTAR', reason: String(id) }) };
  });

  app.post('/instandhaltung/:id/fotos', { ...schreiben, bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ fotos: z.array(foto).min(1).max(5), art: z.enum(['VORHER', 'NACHHER']).default('NACHHER') }).parse(req.body);
    return { text: await change(req, (tx) => fotosAnhaengen(tx, id, b.fotos, b.art, wer(req)), { action: 'SCHADEN_FOTO', reason: String(id) }) };
  });

  app.delete('/instandhaltung/foto/:id', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    return { text: await change(req, (tx) => fotoLoeschen(tx, id), { action: 'SCHADEN_FOTO_LOESCHEN', reason: String(id) }) };
  });

  /** Platz in der Platzbuchung sperren bzw. Sperre aufheben (feste Belegung „Gesperrt“) */
  app.post('/instandhaltung/:id/sperre', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    return { text: await change(req, (tx) => sperreSetzen(tx, id, wer(req)), { action: 'SCHADEN_SPERRE', reason: String(id) }) };
  });
  app.delete('/instandhaltung/:id/sperre', schreiben, async (req) => {
    const { id } = pId.parse(req.params);
    return { text: await change(req, (tx) => sperreAufheben(tx, id, wer(req)), { action: 'SCHADEN_SPERRE_AUF', reason: String(id) }) };
  });

  // ------------------------------------------------------------------ Stammdaten
  app.get('/instandhaltung/stamm/daten', admin, async () => ({
    anlagen: await anlagenLesen(DB), kategorien: await kategorienLesen(DB), einstellungen: await einstellungenLesen(DB),
    bearbeiter: (await bearbeiterLesen(DB)).map(({ id, name }) => ({ id, name })), typen: ANLAGE_TYPEN,
    plaetze: await DB`select id, name from tco.plaetze order by sort, name`,
  }));

  const anlageSchema = z.object({
    kuerzel: txt(30).min(1, 'Bitte ein Kürzel angeben.'), bezeichnung: txt(80).min(1, 'Bitte eine Bezeichnung angeben.'),
    typ: z.enum(Object.keys(ANLAGE_TYPEN) as [AnlageTyp, ...AnlageTyp[]]),
    platz_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? null), sort: z.coerce.number().int().default(0), aktiv: z.boolean().default(true),
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
    bezeichnung: txt(60).min(1, 'Bitte eine Bezeichnung angeben.'), zustaendig: z.string().uuid().nullish().transform((v) => v ?? null),
    sort: z.coerce.number().int().default(0), aktiv: z.boolean().default(true),
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

  app.put('/instandhaltung/stamm/einstellungen', admin, async (req) => {
    const b = z.object({ vorstand_email: txt(500).default(''), foto_frist_monate: z.coerce.number().int().min(1).max(120) }).parse(req.body);
    return { text: await change(req, (tx) => einstellungenSichern(tx, b), { action: 'IH_CFG' }) };
  });

  /** QR-Codes zum Aushängen: je Anlage ein Schild (zwei je Seite), Link öffnet „Schaden melden“ mit vorbelegtem Ort */
  app.get('/instandhaltung/stamm/qr.pdf', admin, async (req, reply) => {
    const { anlage } = z.object({ anlage: z.coerce.number().int().positive().optional() }).parse(req.query);
    const url = await portalUrl();
    if (!url) throw new BusinessError('Die Portal-Adresse ist nicht eingerichtet (Administration → Einstellungen) – ohne sie funktionieren die QR-Codes nicht.');
    const anlagen = (await anlagenLesen(DB, true)).filter((a) => !anlage || a.id === anlage);
    if (!anlagen.length) throw new BusinessError('Keine aktive Anlage gefunden.', 404);
    const v = await vereinLesen();
    const p = new Pdf({ title: 'QR-Codes Schadensmeldung', author: v.name, creator: 'TCO Vereinsportal' });
    anlagen.forEach((a, i) => {
      if (i % 2 === 0) p.newPage();
      const y = i % 2 === 0 ? 15 : 160;
      if (i % 2 === 1) p.line(10, 148.5, 200, 148.5, 'B0B4B8', 0.3);
      const link = `${url}/tco/schaden?anlage=${encodeURIComponent(a.kuerzel)}`;
      p.text(105, y + 4, v.name, { size: 12, align: 'C', color: '6A6D70' });
      p.text(105, y + 16, 'Schaden entdeckt?', { size: 26, bold: true, align: 'C' });
      p.text(105, y + 28, a.bezeichnung, { size: 18, align: 'C' });
      p.qr(link, 67.5, y + 36, 75);
      p.text(105, y + 117, 'QR-Code scannen, anmelden und kurz beschreiben – danke!', { size: 11, align: 'C' });
      p.text(105, y + 124, link, { size: 8, align: 'C', color: '6A6D70' });
    });
    const pdf = await p.render();
    return reply.type('application/pdf').header('content-disposition', 'inline; filename="qr-schadensmeldung.pdf"').send(pdf);
  });
}
