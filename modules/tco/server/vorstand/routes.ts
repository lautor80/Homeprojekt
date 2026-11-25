import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { dateityp } from '../../../../server/src/lib/dateityp.js';
import { entpacken, istZip } from '../../../../server/src/lib/zip.js';
import { DB, vereinLesen } from '../verein.js';
import {
  anlageAnlegen, anlageLoeschen, linkAnlegen, aufgabeErledigt, aufgabenLesen, beschluesseLesen, cfgLesen, cfgSpeichern, eintragAendern, eintragAnlegen,
  eintragLoeschen, eventSetzen, eventsZurAuswahl, gastAnlegen, importAusfuehren, P_VS, rueckmeldungenUebernehmen, sitzungAendern, sitzungAnlegen,
  sitzungenLesen, sitzungLesen, sitzungLoeschen, statusSetzen, teilnahmeAlle, teilnahmeSetzen, teilnehmerLoeschen, topAendern, topAnlegen,
  topLoeschen, topsOrdnen, vorstandEintragen, vorstandLesen,
} from './logik.js';
import { markdownLesen } from './markdown.js';
import { protokollPdf } from './pdf.js';
import { STATUS_TEXT, TEILNAHME_TEXT } from './regeln.js';
import {
  themaAbschliessen, themaAendern, themaAnlageAnlegen, themaAnlageLoeschen, themaAnlegen, themaLesen, themaLoeschen, themaParken, themenFuerSitzung,
  themenLesen, themenZuordnen,
} from './themen.js';
import { heute } from '../format.js';

/**
 * Berechtigungsobjekte Vorstandssitzungen:
 *  - tco.vorstand:display  Sitzungen, Protokolle, Beschlüsse, Aufgaben und Anlagen ansehen, PDF
 *  - tco.vorstand:edit     Sitzungen anlegen und protokollieren, Veranstaltung verknüpfen, Anlagen, Aufgaben abhaken, Import
 *  - tco.vorstand:approve  Protokolle freigeben und die Freigabe zurücknehmen
 * Themenparkplatz: Themen einreichen und eigene ändern mit display; fremde ändern, zuordnen und wieder parken mit edit.
 */
export { P_VS };

const wer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const nr = z.coerce.number().int().positive();
const pId = z.object({ id: nr });
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const uhr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM').nullish().or(z.literal('').transform(() => null));
const text = (max: number) => z.string().max(max).nullish();
const teilnahme = z.enum(['OFFEN', 'ANWESEND', 'ENTSCHULDIGT', 'FEHLT']);
const anzahl = z.coerce.number().int().min(0).max(999).nullish();

const kopfSchema = z.object({
  titel: z.string().trim().min(1, 'Bitte einen Titel angeben.').max(160), art: z.enum(['VORSTAND', 'ERWEITERT']).default('VORSTAND'),
  datum, beginn: uhr, ende: uhr, ort: text(120), leitung: text(120), protokoll_von: text(120), bemerkung: text(20_000),
});
const topSchema = z.object({
  titel: z.string().trim().min(1, 'Bitte den Tagesordnungspunkt benennen.').max(200), verantwortlich: text(120), text: text(100_000),
  status: z.enum(['OFFEN', 'ERLEDIGT', 'VERTAGT']).default('OFFEN'),
});
const eintragSchema = z.object({
  art: z.enum(['BESCHLUSS', 'AUFGABE', 'INFO']), text: z.string().trim().min(1, 'Bitte einen Text angeben.').max(20_000),
  ja: anzahl, nein: anzahl, enthaltung: anzahl, ergebnis: z.enum(['ANGENOMMEN', 'ABGELEHNT']).nullish(),
  verantwortlich: text(120), faellig: datum.nullish().or(z.literal('').transform(() => null)), erledigt: z.boolean().optional(),
});
const themaSchema = z.object({
  titel: z.string().trim().min(1, 'Bitte das Thema benennen.').max(200), beschreibung: text(100_000),
  prioritaet: z.coerce.number().int().min(1).max(3).default(2).transform((p) => p as 1 | 2 | 3), einreicher: text(120),
  von: datum, bis: datum,
});
const linkSchema = z.object({ url: z.string().trim().min(1, 'Bitte die Adresse angeben.').max(2000), bezeichnung: z.string().max(200).nullish() });
const dateienSchema = z.array(z.object({ name: z.string().trim().min(1).max(250), data: z.string() })).min(1, 'Bitte mindestens eine Datei wählen.').max(500);

/** base64 (auch als data:-URL) dekodieren; ZIP-Archive werden entpackt */
function dekodiert(d: { name: string; data: string }[]) {
  return d.flatMap((x) => {
    const inhalt = Buffer.from(x.data.replace(/^data:[^,]*,/, ''), 'base64');
    if (!istZip(inhalt)) return [{ name: x.name, inhalt }];
    try {
      return entpacken(inhalt).filter((e) => !/(^|\/)(__MACOSX|\.)/.test(e.name));
    } catch (e) {
      throw new BusinessError(`${x.name}: ${(e as Error).message}`);
    }
  });
}

export async function vorstandRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_VS.display) };
  const pflege = { preHandler: requireAuth(P_VS.edit) };
  const rechte = (req: FastifyRequest) => ({ pflege: can(req, P_VS.edit), freigabe: can(req, P_VS.approve) });

  app.get('/vorstand', lesen, async (req) => {
    const q = z.object({ jahr: z.coerce.number().int().min(1900).max(2999).optional(), suche: z.string().max(200).optional() }).parse(req.query);
    const cfg = await cfgLesen(DB);
    const jahre = (await DB`select distinct jahr from tco.vs_sitzungen order by jahr desc`).map((r) => Number(r.jahr));
    return {
      sitzungen: await sitzungenLesen(DB, { jahr: q.jahr ?? null, suche: q.suche ?? null }), jahre, cfg,
      vorstand: await vorstandLesen(DB, cfg.gruppe_id), events: await eventsZurAuswahl(DB),
      gruppen: (await DB`select id, name, parent_id from tco.kal_gruppen where aktiv order by lower(name), id`).map((g) => ({ id: Number(g.id), name: g.name as string, parent_id: g.parent_id == null ? null : Number(g.parent_id) })),
      status_text: STATUS_TEXT, teilnahme_text: TEILNAHME_TEXT, ...rechte(req),
    };
  });

  app.get('/vorstand/beschluesse', lesen, async (req) => {
    const q = z.object({ jahr: z.coerce.number().int().optional(), suche: z.string().max(200).optional() }).parse(req.query);
    return { beschluesse: await beschluesseLesen(DB, { jahr: q.jahr ?? null, suche: q.suche ?? null }) };
  });

  app.get('/vorstand/aufgaben', lesen, async (req) => {
    const q = z.object({ offen: z.enum(['0', '1']).optional() }).parse(req.query);
    return { aufgaben: await aufgabenLesen(DB, { offen: q.offen === '1' }) };
  });

  app.put('/vorstand/einstellungen', pflege, async (req) => {
    const b = z.object({ gruppe_id: nr.nullable() }).parse(req.body);
    await change(req, (tx) => cfgSpeichern(tx, b.gruppe_id), { action: 'VS_CFG' });
    return { text: 'Gesichert.' };
  });

  // ---------------------------------------------------------------- Sitzung
  app.post('/vorstand/sitzungen', pflege, async (req) => {
    const b = kopfSchema.extend({ event_id: nr.nullish(), event_anlegen: z.boolean().default(false), vorlage: z.boolean().default(true) }).parse(req.body);
    const id = await change(req, (tx) => sitzungAnlegen(tx, b, wer(req)), { action: 'VS_ANLEGEN' });
    return { id, text: `Sitzung „${b.titel}“ angelegt.` };
  });

  app.get('/vorstand/sitzungen/:id', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    return { ...(await sitzungLesen(DB, id)), ...rechte(req) };
  });

  app.put('/vorstand/sitzungen/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = kopfSchema.parse(req.body);
    await change(req, (tx) => sitzungAendern(tx, id, b, wer(req)), { action: 'VS_AENDERN' });
    return { text: 'Gesichert.' };
  });

  app.delete('/vorstand/sitzungen/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => sitzungLoeschen(tx, id), { action: 'VS_LOESCHEN' });
    return { text: 'Sitzung gelöscht.' };
  });

  app.post('/vorstand/sitzungen/:id/status', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ status: z.enum(['GEPLANT', 'LAEUFT', 'ENTWURF', 'FREIGEGEBEN']), grund: text(500) }).parse(req.body);
    await change(req, (tx) => statusSetzen(tx, id, b.status, wer(req), can(req, P_VS.approve)), { action: 'VS_STATUS', reason: b.grund ?? null });
    return { text: `Status: ${STATUS_TEXT[b.status]}.` };
  });

  app.post('/vorstand/sitzungen/:id/veranstaltung', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ event_id: nr.nullish(), anlegen: z.boolean().default(false) }).parse(req.body);
    const ev = await change(req, (tx) => eventSetzen(tx, id, b, wer(req)), { action: 'VS_VERANSTALTUNG' });
    return { event_id: ev, text: ev ? (b.anlegen ? 'Veranstaltung im Vereinskalender angelegt und verknüpft.' : 'Veranstaltung verknüpft.') : 'Verknüpfung gelöst.' };
  });

  // ---------------------------------------------------------------- Teilnehmer
  app.post('/vorstand/sitzungen/:id/vorstand', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const r = await change(req, async (tx) => {
      const [s] = await tx`select status from tco.vs_sitzungen where id = ${id}`;
      if (!s) throw new BusinessError('Die Sitzung gibt es nicht (mehr).', 404);
      if (s.status === 'FREIGEGEBEN') throw new BusinessError('Das Protokoll ist freigegeben.');
      return { neu: await vorstandEintragen(tx, id), absagen: await rueckmeldungenUebernehmen(tx, id) };
    }, { action: 'VS_TEILNEHMER' });
    return { ...r, text: `${r.neu} Vorstandsmitglied${r.neu === 1 ? '' : 'er'} ergänzt${r.absagen ? `, ${r.absagen} Absage${r.absagen === 1 ? '' : 'n'} als entschuldigt übernommen` : ''}.` };
  });

  app.post('/vorstand/sitzungen/:id/teilnahme', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ status: teilnahme }).parse(req.body);
    await change(req, (tx) => teilnahmeAlle(tx, id, b.status, wer(req)), { action: 'VS_TEILNEHMER' });
    return { text: 'Gesichert.' };
  });

  app.put('/vorstand/teilnehmer/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ status: teilnahme }).parse(req.body);
    await change(req, (tx) => teilnahmeSetzen(tx, id, b.status, wer(req)), { action: 'VS_TEILNEHMER' });
    return { text: 'Gesichert.' };
  });

  app.post('/vorstand/sitzungen/:id/gaeste', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1, 'Bitte einen Namen angeben.').max(120), rolle: text(120), status: teilnahme.optional() }).parse(req.body);
    return { id: await change(req, (tx) => gastAnlegen(tx, id, b, wer(req)), { action: 'VS_TEILNEHMER' }), text: 'Gast eingetragen.' };
  });

  app.delete('/vorstand/teilnehmer/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => teilnehmerLoeschen(tx, id, wer(req)), { action: 'VS_TEILNEHMER' });
    return { text: 'Teilnehmer entfernt.' };
  });

  // ---------------------------------------------------------------- Tagesordnung
  app.post('/vorstand/sitzungen/:id/tops', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = topSchema.parse(req.body);
    return { id: await change(req, (tx) => topAnlegen(tx, id, b, wer(req)), { action: 'VS_TOP' }) };
  });

  app.put('/vorstand/tops/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = topSchema.parse(req.body);
    await change(req, (tx) => topAendern(tx, id, b, wer(req)), { action: 'VS_TOP' });
    return { text: 'Gesichert.' };
  });

  app.delete('/vorstand/tops/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => topLoeschen(tx, id, wer(req)), { action: 'VS_TOP' });
    return { text: 'Tagesordnungspunkt gelöscht.' };
  });

  app.post('/vorstand/sitzungen/:id/reihenfolge', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ tops: z.array(nr).max(200) }).parse(req.body);
    await change(req, (tx) => topsOrdnen(tx, id, b.tops, wer(req)), { action: 'VS_TOP' });
    return { text: 'Reihenfolge gesichert.' };
  });

  // ---------------------------------------------------------------- Beschlüsse, Aufgaben, Infos
  app.post('/vorstand/tops/:id/eintraege', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = eintragSchema.parse(req.body);
    return { id: await change(req, (tx) => eintragAnlegen(tx, id, b, wer(req)), { action: 'VS_EINTRAG' }) };
  });

  app.put('/vorstand/eintraege/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = eintragSchema.parse(req.body);
    await change(req, (tx) => eintragAendern(tx, id, b, wer(req)), { action: 'VS_EINTRAG' });
    return { text: 'Gesichert.' };
  });

  app.delete('/vorstand/eintraege/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => eintragLoeschen(tx, id, wer(req)), { action: 'VS_EINTRAG' });
    return { text: 'Eintrag gelöscht.' };
  });

  /** Aufgabe abhaken – auch nach der Freigabe und aus dem Arbeitsvorrat */
  app.post('/vorstand/aufgaben/:id/erledigt', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ erledigt: z.boolean() }).parse(req.body);
    await change(req, (tx) => aufgabeErledigt(tx, id, b.erledigt, wer(req)), { action: 'VS_AUFGABE' });
    return { text: b.erledigt ? 'Erledigt.' : 'Wieder offen.' };
  });

  // ---------------------------------------------------------------- Anlagen
  app.post('/vorstand/sitzungen/:id/anlagen', { ...pflege, bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ top_id: nr.nullish(), dateien: dateienSchema.max(20) }).parse(req.body);
    const dateien = b.dateien.map((d) => ({ name: d.name, inhalt: Buffer.from(d.data.replace(/^data:[^,]*,/, ''), 'base64') }));
    await change(req, async (tx) => {
      for (const d of dateien) await anlageAnlegen(tx, id, { top_id: b.top_id ?? null, dateiname: d.name, mime: dateityp(d.name, null, d.inhalt), inhalt: d.inhalt }, wer(req));
    }, { action: 'VS_ANLAGE' });
    return { text: `${dateien.length} Anlage${dateien.length === 1 ? '' : 'n'} gesichert.` };
  });

  /** Verknüpfung (URL) als Anlage zur Sitzung oder zum Tagesordnungspunkt */
  app.post('/vorstand/sitzungen/:id/links', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ top_id: nr.nullish(), url: z.string().trim().min(1, 'Bitte die Adresse angeben.').max(2000), bezeichnung: z.string().max(200).nullish() }).parse(req.body);
    await change(req, (tx) => linkAnlegen(tx, id, { top_id: b.top_id ?? null, url: b.url, bezeichnung: b.bezeichnung ?? null }, wer(req)), { action: 'VS_ANLAGE' });
    return { text: 'Verknüpfung hinzugefügt.' };
  });

  app.get('/vorstand/sitzungen/:id/anlagen/:aid', lesen, async (req, reply) => {
    const p = z.object({ id: nr, aid: nr }).parse(req.params);
    const [a] = await DB`select dateiname, mime, inhalt, url from tco.vs_anlagen where id = ${p.aid} and sitzung_id = ${p.id}`;
    if (!a) throw new BusinessError('Die Anlage gibt es nicht (mehr).', 404);
    if (a.url) return reply.redirect(a.url as string);
    const mime = a.mime === 'text/markdown' ? 'text/plain; charset=utf-8' : (a.mime as string);
    return reply.type(mime).header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.dateiname as string)}`).send(Buffer.from(a.inhalt as Uint8Array));
  });

  app.delete('/vorstand/sitzungen/:id/anlagen/:aid', pflege, async (req) => {
    const p = z.object({ id: nr, aid: nr }).parse(req.params);
    await change(req, (tx) => anlageLoeschen(tx, p.id, p.aid, wer(req)), { action: 'VS_ANLAGE' });
    return { text: 'Anlage gelöscht.' };
  });

  // ---------------------------------------------------------------- Themenparkplatz
  const person = (req: FastifyRequest) => ({ name: wer(req), userId: req.user?.id ?? null, alle: can(req, P_VS.edit) });
  const datei = (d: { name: string; data: string }) => {
    const inhalt = Buffer.from(d.data.replace(/^data:[^,]*,/, ''), 'base64');
    return { dateiname: d.name, mime: dateityp(d.name, null, inhalt), inhalt };
  };

  app.get('/vorstand/themen', lesen, async (req) => {
    const q = z.object({ offen: z.enum(['0', '1']).optional() }).parse(req.query);
    const cfg = await cfgLesen(DB);
    return {
      themen: await themenLesen(DB, { offen: q.offen !== '0', userId: req.user?.id ?? null, stichtag: heute() }),
      // Vorschläge für den Einreicher
      vorstand: (await vorstandLesen(DB, cfg.gruppe_id)).map((m) => (m.name.includes(',') ? m.name.split(',').map((x) => x.trim()).reverse().join(' ') : m.name)),
      ich: wer(req), ...rechte(req),
    };
  });

  app.get('/vorstand/themen/:id', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    return themaLesen(DB, id, req.user?.id ?? null, heute());
  });

  /** Thema einreichen – samt Anlagen (Dateien und Links) */
  app.post('/vorstand/themen', { ...lesen, bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const b = themaSchema.extend({ dateien: z.array(z.object({ name: z.string().trim().min(1).max(250), data: z.string() })).max(20).default([]), links: z.array(linkSchema).max(20).default([]) }).parse(req.body);
    const p = person(req);
    const id = await change(req, async (tx) => {
      const id = await themaAnlegen(tx, b, p);
      // der Einreicher darf seine Anlagen immer anhängen
      for (const d of b.dateien) await themaAnlageAnlegen(tx, id, datei(d), { ...p, alle: true });
      for (const l of b.links) await themaAnlageAnlegen(tx, id, l, { ...p, alle: true });
      return id;
    }, { action: 'VS_THEMA' });
    return { id, text: `Thema „${b.titel}“ geparkt.` };
  });

  app.put('/vorstand/themen/:id', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = themaSchema.parse(req.body);
    await change(req, (tx) => themaAendern(tx, id, b, person(req)), { action: 'VS_THEMA' });
    return { text: 'Gesichert.' };
  });

  app.post('/vorstand/themen/:id/abschliessen', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ abgeschlossen: z.boolean(), grund: text(500) }).parse(req.body);
    await change(req, (tx) => themaAbschliessen(tx, id, b.abgeschlossen, b.grund ?? null, person(req)), { action: 'VS_THEMA', reason: b.grund ?? null });
    return { text: b.abgeschlossen ? 'Thema abgeschlossen.' : 'Thema wieder geparkt.' };
  });

  app.delete('/vorstand/themen/:id', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => themaLoeschen(tx, id, person(req)), { action: 'VS_THEMA' });
    return { text: 'Thema gelöscht.' };
  });

  app.post('/vorstand/themen/:id/anlagen', { ...lesen, bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ dateien: dateienSchema.max(20) }).parse(req.body);
    await change(req, async (tx) => { for (const d of b.dateien) await themaAnlageAnlegen(tx, id, datei(d), person(req)); }, { action: 'VS_THEMA' });
    return { text: `${b.dateien.length} Anlage${b.dateien.length === 1 ? '' : 'n'} gesichert.` };
  });

  app.post('/vorstand/themen/:id/links', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    const b = linkSchema.parse(req.body);
    await change(req, (tx) => themaAnlageAnlegen(tx, id, b, person(req)), { action: 'VS_THEMA' });
    return { text: 'Verknüpfung hinzugefügt.' };
  });

  app.get('/vorstand/themen/:id/anlagen/:aid', lesen, async (req, reply) => {
    const p = z.object({ id: nr, aid: nr }).parse(req.params);
    const [a] = await DB`select dateiname, mime, inhalt, url from tco.vs_themen_anlagen where id = ${p.aid} and thema_id = ${p.id}`;
    if (!a) throw new BusinessError('Die Anlage gibt es nicht (mehr).', 404);
    if (a.url) return reply.redirect(a.url as string);
    const mime = a.mime === 'text/markdown' ? 'text/plain; charset=utf-8' : (a.mime as string);
    return reply.type(mime).header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.dateiname as string)}`).send(Buffer.from(a.inhalt as Uint8Array));
  });

  app.delete('/vorstand/themen/:id/anlagen/:aid', lesen, async (req) => {
    const p = z.object({ id: nr, aid: nr }).parse(req.params);
    await change(req, (tx) => themaAnlageLoeschen(tx, p.id, p.aid, person(req)), { action: 'VS_THEMA' });
    return { text: 'Anlage gelöscht.' };
  });

  /** Themen für eine Sitzung: vorgeschlagen (Sitzung im Zeitraum) und weitere geparkte */
  app.get('/vorstand/sitzungen/:id/themen', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    return themenFuerSitzung(DB, id, req.user?.id ?? null, heute());
  });

  /** Themen als Tagesordnungspunkte übernehmen */
  app.post('/vorstand/sitzungen/:id/themen', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ ids: z.array(nr).min(1, 'Bitte mindestens ein Thema wählen.').max(100) }).parse(req.body);
    const n = await change(req, (tx) => themenZuordnen(tx, id, b.ids, wer(req)), { action: 'VS_THEMA' });
    return { zugeordnet: n, text: n ? `${n} Thema${n === 1 ? '' : 'en'} in die Tagesordnung übernommen.` : 'Keines der Themen ist noch geparkt.' };
  });

  /** zugeordnetes Thema wieder parken (nicht dazu gekommen) */
  app.post('/vorstand/themen/:id/parken', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const r = await change(req, (tx) => themaParken(tx, id, wer(req)), { action: 'VS_THEMA' });
    return { ergebnis: r, text: r === 'ENTFERNT' ? 'Thema wieder geparkt – aus der Tagesordnung entfernt.' : 'Thema wieder geparkt – der Punkt ist als vertagt markiert.' };
  });

  // ---------------------------------------------------------------- PDF
  app.get('/vorstand/sitzungen/:id/pdf', lesen, async (req, reply) => {
    const { id } = pId.parse(req.params);
    const { pdf, titel } = await protokollPdf(DB, await vereinLesen(), id);
    return reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(`${titel}.pdf`)}`).send(pdf);
  });

  // ---------------------------------------------------------------- Import alter Protokolle (Markdown, auch als ZIP mit Anlagen)
  app.post('/vorstand/import', { ...pflege, bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    const b = z.object({
      dateien: dateienSchema, uebernehmen: z.boolean().default(false), veranstaltung: z.boolean().default(true), freigeben: z.boolean().default(true),
    }).parse(req.body);
    const dateien = dekodiert(b.dateien);
    const zeilen = await change(req, (tx) => importAusfuehren(tx, dateien, { schreiben: b.uebernehmen, veranstaltung: b.veranstaltung, freigeben: b.freigeben }, wer(req), markdownLesen),
      { action: 'VS_IMPORT', reason: b.dateien.map((d) => d.name).join(', ').slice(0, 500) });
    const n = zeilen.filter((z) => z.sitzung_id).length;
    return { zeilen, uebernommen: n, text: b.uebernehmen ? `${n} Protokoll${n === 1 ? '' : 'e'} übernommen.` : undefined };
  });
}
