import { nextcloudZugangSpeichern } from '../lib/nextcloud.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { change, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import { istZip } from '../backup-xml.js';
import { activeModules } from '../modules.js';
import { laufend as laufendJob, lesen as jobLesen, sicht } from '../backup-job.js';
import { cfgLesen, cfgPruefen, exportStarten, sicherungStarten, verbindungTesten, type ExportCfg } from '../backup-export.js';
import {
  aktiveSchemas, datei, dateipfad, dumps, dumpVerzeichnis, entpacken, istVerschluesselt, kurzinfo, liste, ordner, pruefen, ruecksichern, sichern, speichern, uebersicht,
} from '../backup.js';

/** Sicherung und Rücksicherung (Administration → System → Sicherung) */
export const P_BACKUP = { erstellen: 'core.backup:create', ruecksichern: 'core.backup:restore' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const name = z.string().regex(/^[\w.-]+\.(portal|zip)$/, 'Ungültiger Dateiname.');
const format = z.enum(['portal', 'zip']).default('portal');
const passwort = z.string().max(200).nullish().transform((x) => x || null);

async function lesen(n: string): Promise<Buffer> {
  const { pfad } = await ordner();
  try { return await fs.readFile(dateipfad(pfad, n)); } catch { throw new BusinessError('Sicherung nicht gefunden.', 404); }
}

export async function backupRoutes(app: FastifyInstance) {
  const erstellen = { preHandler: requireAuth(P_BACKUP.erstellen) };
  const zurueck = { preHandler: requireAuth(P_BACKUP.ruecksichern) };

  // Upload als Binärdatei (nur in diesem Plugin)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 1024 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get('/api/backup', erstellen, async () => {
    const [u, l, d] = await Promise.all([uebersicht(), liste(), dumps()]);
    const [letzte] = await sql`select value from core.settings where key = 'backup.letzte_ruecksicherung'`;
    return { ...u, ...l, nacht: d, letzteRuecksicherung: letzte?.value ?? null, laufend: (() => { const j = laufendJob(); return j ? sicht(j) : null; })() };
  });

  app.post('/api/backup', erstellen, async (req) => {
    const b = z.object({
      schemas: z.array(z.string()).default([]), mitAenderungsbelegen: z.boolean().default(true),
      notiz: z.string().max(300).default(''), passwort, format,
    }).parse(req.body ?? {});
    if (b.format === 'zip' && b.passwort) throw new BusinessError('Das ZIP/XML-Format ist unverschlüsselt – für eine verschlüsselte Sicherung bitte das Format .portal wählen.');
    const inhalt = await sichern({ schemas: b.schemas, mitAenderungsbelegen: b.mitAenderungsbelegen, von: benutzer(req), notiz: b.notiz });
    const r = await speichern(inhalt, b.passwort, b.format);
    req.log.info({ datei: r.name, von: benutzer(req) }, 'Portal-Sicherung erstellt');
    const z2 = inhalt.manifest.tabellen.reduce((s, t) => s + t.zeilen, 0);
    return {
      ...r, info: kurzinfo(inhalt.manifest, !!b.passwort),
      text: `Sicherung erstellt: ${inhalt.manifest.schemas.length} Bereich(e), ${inhalt.manifest.tabellen.length} Tabellen, ${z2.toLocaleString('de-DE')} Datensätze${b.passwort ? ', verschlüsselt' : ''}${b.format === 'zip' ? ', als ZIP mit XML' : ''}.`
        + (r.dauerhaft ? '' : ' Achtung: Der Sicherungsordner ist nicht dauerhaft – bitte die Datei herunterladen.'),
    };
  });

  /** Sicherung als Hintergrundauftrag – Fortschritt über /api/backup/job/:id */
  app.post('/api/backup/start', erstellen, async (req) => {
    const b = z.object({
      schemas: z.array(z.string()).default([]), mitAenderungsbelegen: z.boolean().default(true),
      notiz: z.string().max(300).default(''), passwort, format,
    }).parse(req.body ?? {});
    if (b.format === 'zip' && b.passwort) throw new BusinessError('Das ZIP/XML-Format ist unverschlüsselt – für eine verschlüsselte Sicherung bitte das Format .portal wählen.');
    if (b.passwort && b.passwort.length < 8) throw new BusinessError('Das Passwort für die Sicherung muss mindestens 8 Zeichen haben.');
    const j = sicherungStarten({ schemas: b.schemas, mitAenderungsbelegen: b.mitAenderungsbelegen, notiz: b.notiz, format: b.format, passwort: b.passwort }, benutzer(req));
    req.log.info({ job: j.id, von: benutzer(req) }, 'Portal-Sicherung gestartet');
    return sicht(j);
  });

  app.get('/api/backup/job/:id', erstellen, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const j = jobLesen(id);
    if (!j) throw new BusinessError('Der Sicherungsauftrag ist nicht (mehr) bekannt – bitte die Liste neu laden.', 404);
    return sicht(j);
  });

  // ---------------------------------------------------------------- Nextcloud-Export
  const MASKE = '********';
  const cfgSicht = async () => {
    const c = await cfgLesen();
    return { ...c, passwort: c.passwort ? MASKE : '', datei_passwort: c.datei_passwort ? MASKE : '', fehlt: cfgPruefen(c) };
  };
  const cfgSchema = z.object({
    // Zugang (#232, S2): gepflegt unter Schnittstellen → Nextcloud; wird er hier mitgegeben (Einrichten in einem Zug), landet er in derselben Anbindung
    aktiv: z.boolean(), url: z.string().trim().max(300).optional(), benutzer: z.string().trim().max(120).optional(), passwort: z.string().max(200).optional(),
    ordner: z.string().trim().max(300).transform((x) => `/${x.replace(/^\/+|\/+$/g, '')}`),
    uhrzeit: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM'),
    /** dateien = dateiweise Übertragung einzelner XML-Dateien ohne ZIP */
    format: z.enum(['portal', 'zip', 'dateien']).default('portal'),
    datei_passwort: z.string().max(200), mit_aenderungsbelegen: z.boolean(), aufbewahrung_tage: z.coerce.number().int().min(0).max(3650),
  });
  /** Formularwerte mit gespeicherten Geheimnissen ergänzen (Maske = unverändert) */
  const zusammen = async (b: z.infer<typeof cfgSchema>): Promise<ExportCfg> => {
    const alt = await cfgLesen();
    return {
      ...b, url: b.url ?? alt.url, benutzer: b.benutzer ?? alt.benutzer, passwort: b.passwort === undefined || b.passwort === MASKE ? alt.passwort : b.passwort,
      datei_passwort: b.datei_passwort === MASKE ? alt.datei_passwort : b.datei_passwort,
    };
  };

  app.get('/api/backup/nextcloud', erstellen, async () => cfgSicht());

  app.put('/api/backup/nextcloud', erstellen, async (req) => {
    const c = await zusammen(cfgSchema.parse(req.body));
    if (c.format !== 'portal' && c.datei_passwort) c.datei_passwort = '';
    const fehlt = cfgPruefen(c);
    if (c.aktiv && fehlt.length) throw new BusinessError(`Zum Aktivieren bitte ergänzen: ${fehlt.join(', ')}.`);
    const alt = await cfgLesen();
    await change(req, async (tx) => {
      await tx`update core.backup_export set aktiv = ${c.aktiv}, ordner = ${c.ordner},
                      uhrzeit = ${c.uhrzeit}, format = ${c.format}, datei_passwort = ${c.datei_passwort}, mit_aenderungsbelegen = ${c.mit_aenderungsbelegen},
                      aufbewahrung_tage = ${c.aufbewahrung_tage} where id = 1`;
      // der Zugang steht nur in der Anbindung „nextcloud“ – geändert wird er dort, auch wenn er von hier kommt
      if (c.url !== alt.url || c.benutzer !== alt.benutzer || c.passwort !== alt.passwort) {
        await nextcloudZugangSpeichern(tx, { url: c.url, benutzer: c.benutzer, passwort: c.passwort }, req.user?.username ?? 'system');
      }
    }, { action: 'BACKUP_EXPORT' });
    return { ...(await cfgSicht()), text: c.aktiv ? `Gespeichert – der Export läuft täglich ab ${c.uhrzeit} Uhr.` : 'Gespeichert – der tägliche Export ist ausgeschaltet.' };
  });

  app.post('/api/backup/nextcloud/testen', erstellen, async (req) => verbindungTesten(await zusammen(cfgSchema.parse(req.body))));

  app.post('/api/backup/nextcloud/jetzt', erstellen, async (req) => {
    const c = await cfgLesen();
    const fehlt = cfgPruefen(c);
    if (fehlt.length) throw new BusinessError(`Bitte zuerst den Export einrichten und speichern: ${fehlt.join(', ')}.`);
    return sicht(exportStarten(c, benutzer(req)));
  });

  app.get('/api/backup/datei/:name', erstellen, async (req, reply) => {
    const { name: n } = z.object({ name }).parse(req.params);
    const datei = await lesen(n);
    return reply.type('application/octet-stream').header('content-disposition', `attachment; filename="${n}"`).send(datei);
  });

  /** vorhandene Sicherung als ZIP mit XML-Dateien herunterladen (verschlüsselt: mit Passwort) */
  app.post('/api/backup/datei/:name/xml', erstellen, async (req, reply) => {
    const { name: n } = z.object({ name }).parse(req.params);
    const { passwort: pw } = z.object({ passwort }).parse(req.body ?? {});
    const roh = await lesen(n);
    const zip = istZip(roh) ? roh : datei(entpacken(roh, pw), 'zip');
    const ziel = n.replace(/\.(portal|zip)$/, '.zip');
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${ziel}"`).send(zip);
  });

  app.get('/api/backup/nacht/:name', erstellen, async (req, reply) => {
    const { name: n } = z.object({ name: z.string().regex(/^[\w.-]+\.dump$/) }).parse(req.params);
    const datei = await fs.readFile(path.join(dumpVerzeichnis(), n)).catch(() => { throw new BusinessError('Datei nicht gefunden.', 404); });
    return reply.type('application/octet-stream').header('content-disposition', `attachment; filename="${n}"`).send(datei);
  });

  app.delete('/api/backup/datei/:name', erstellen, async (req) => {
    const { name: n } = z.object({ name }).parse(req.params);
    const { pfad } = await ordner();
    await fs.unlink(dateipfad(pfad, n)).catch(() => { throw new BusinessError('Sicherung nicht gefunden.', 404); });
    await fs.unlink(dateipfad(pfad, n) + '.json').catch(() => undefined);
    return { text: `Sicherung ${n} gelöscht.` };
  });

  /** Datei hochladen (Binärdaten, Name im Kopf x-dateiname) – wird in den Sicherungsordner übernommen */
  app.post('/api/backup/hochladen', { ...zurueck, bodyLimit: 1024 * 1024 * 1024 }, async (req) => {
    const daten = req.body as Buffer;
    if (!Buffer.isBuffer(daten) || daten.length < 6) throw new BusinessError('Bitte eine Sicherungsdatei (.portal oder .zip) hochladen.');
    const zip = istZip(daten);
    if (!zip && !daten.subarray(0, 5).equals(Buffer.from('PSIC1'))) throw new BusinessError('Die Datei ist keine Portal-Sicherung (.portal oder ZIP mit XML). Nächtliche Datenbanksicherungen (.dump) werden mit restore.sh zurückgespielt.');
    const endung = zip ? 'zip' : 'portal';
    const { pfad } = await ordner();
    const roh = String(req.headers['x-dateiname'] ?? `hochgeladen.${endung}`).replace(/[^\w.-]/g, '_').replace(/\.(portal|zip)$/i, '');
    let n = `${roh || 'hochgeladen'}.${endung}`;
    for (let i = 2; await fs.stat(path.join(pfad, n)).then(() => true, () => false); i++) n = `${roh || 'hochgeladen'}_${i}.${endung}`;
    await fs.writeFile(dateipfad(pfad, n), daten, { mode: 0o600 });
    if (!istVerschluesselt(daten)) {
      try {
        const m = entpacken(daten).manifest;
        await fs.writeFile(dateipfad(pfad, n) + '.json', JSON.stringify(kurzinfo(m, false)), { mode: 0o600 });
      } catch (e) { await fs.unlink(dateipfad(pfad, n)).catch(() => undefined); throw e; }
    }
    return { name: n, verschluesselt: istVerschluesselt(daten), text: `Sicherung ${n} hochgeladen.` };
  });

  /** Inhalt und Verträglichkeit prüfen (verschlüsselt: mit Passwort) */
  app.post('/api/backup/datei/:name/pruefen', zurueck, async (req) => {
    const { name: n } = z.object({ name }).parse(req.params);
    const { passwort: pw } = z.object({ passwort }).parse(req.body ?? {});
    const inhalt = entpacken(await lesen(n), pw);
    const { pfad } = await ordner();
    await fs.writeFile(dateipfad(pfad, n) + '.json', JSON.stringify(kurzinfo(inhalt.manifest, !!pw)), { mode: 0o600 }).catch(() => undefined);
    const p = await pruefen(inhalt);
    return { ...p, manifest: { ...p.manifest }, aktiv: aktiveSchemas() };
  });

  /** Rücksicherung: vorher automatische Sicherheitskopie des aktuellen Stands */
  app.post('/api/backup/datei/:name/ruecksichern', zurueck, async (req) => {
    const { name: n } = z.object({ name }).parse(req.params);
    const b = z.object({ schemas: z.array(z.string()).min(1, 'Bitte mindestens einen Bereich wählen.'), passwort, bestaetigung: z.string() }).parse(req.body ?? {});
    if (b.bestaetigung.trim().toUpperCase() !== 'WIEDERHERSTELLEN') throw new BusinessError('Bitte zur Bestätigung WIEDERHERSTELLEN eingeben.');
    const inhalt = entpacken(await lesen(n), b.passwort);
    // Sicherheitskopie aller aktiven Bereiche (unverschlüsselt im Sicherungsordner)
    const vorher = await speichern(await sichern({ von: benutzer(req), notiz: `Automatisch vor Rücksicherung von ${n}`, art: 'vor-ruecksicherung' }));
    const r = await ruecksichern(inhalt, b.schemas);
    // Module stellen ihren festen Stand wieder her (Systemrollen, Pflichtberechtigungen)
    for (const m of activeModules()) await m.nachRuecksicherung?.().catch((e) => req.log.error(e, `nachRuecksicherung ${m.id}`));
    req.log.warn({ datei: n, schemas: b.schemas, von: benutzer(req) }, 'Portal-Rücksicherung durchgeführt');
    const protokoll = { zeitpunkt: new Date().toISOString(), datei: n, schemas: b.schemas, von: benutzer(req), sicherheitskopie: vorher.name };
    if (!r.abgemeldet) {
      await change(req, (tx) => tx`insert into core.settings (key, value) values ('backup.letzte_ruecksicherung', ${tx.json(protokoll as never)})
                                   on conflict (key) do update set value = excluded.value`, { action: 'RUECKSICHERUNG', reason: n });
    } else {
      // Basis wurde ersetzt (Benutzer/Sitzungen): Protokoll ohne Benutzerbezug
      await sql`insert into core.settings (key, value) values ('backup.letzte_ruecksicherung', ${sql.json(protokoll as never)})
                on conflict (key) do update set value = excluded.value`;
    }
    return { ...r, sicherheitskopie: vorher.name, text: `${r.text} Sicherheitskopie des vorherigen Stands: ${vorher.name}.` };
  });
}
