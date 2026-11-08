import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { change, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import {
  aktiveSchemas, dateipfad, dumps, dumpVerzeichnis, entpacken, istVerschluesselt, kurzinfo, liste, ordner, pruefen, ruecksichern, sichern, speichern, uebersicht,
} from '../backup.js';

/** Sicherung und Rücksicherung (Administration → Sicherung) */
export const P_BACKUP = { erstellen: 'core.backup:create', ruecksichern: 'core.backup:restore' };

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const name = z.string().regex(/^[\w.-]+\.portal$/, 'Ungültiger Dateiname.');
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
    return { ...u, ...l, nacht: d, letzteRuecksicherung: letzte?.value ?? null };
  });

  app.post('/api/backup', erstellen, async (req) => {
    const b = z.object({
      schemas: z.array(z.string()).default([]), mitAenderungsbelegen: z.boolean().default(true),
      notiz: z.string().max(300).default(''), passwort,
    }).parse(req.body ?? {});
    const inhalt = await sichern({ schemas: b.schemas, mitAenderungsbelegen: b.mitAenderungsbelegen, von: benutzer(req), notiz: b.notiz });
    const r = await speichern(inhalt, b.passwort);
    req.log.info({ datei: r.name, von: benutzer(req) }, 'Portal-Sicherung erstellt');
    const z2 = inhalt.manifest.tabellen.reduce((s, t) => s + t.zeilen, 0);
    return {
      ...r, info: kurzinfo(inhalt.manifest, !!b.passwort),
      text: `Sicherung erstellt: ${inhalt.manifest.schemas.length} Bereich(e), ${inhalt.manifest.tabellen.length} Tabellen, ${z2.toLocaleString('de-DE')} Datensätze${b.passwort ? ', verschlüsselt' : ''}.`
        + (r.dauerhaft ? '' : ' Achtung: Der Sicherungsordner ist nicht dauerhaft – bitte die Datei herunterladen.'),
    };
  });

  app.get('/api/backup/datei/:name', erstellen, async (req, reply) => {
    const { name: n } = z.object({ name }).parse(req.params);
    const datei = await lesen(n);
    return reply.type('application/octet-stream').header('content-disposition', `attachment; filename="${n}"`).send(datei);
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
    if (!Buffer.isBuffer(daten) || daten.length < 6) throw new BusinessError('Bitte eine Sicherungsdatei (.portal) hochladen.');
    if (!daten.subarray(0, 5).equals(Buffer.from('PSIC1'))) throw new BusinessError('Die Datei ist keine Portal-Sicherung (.portal). Nächtliche Datenbanksicherungen (.dump) werden mit restore.sh zurückgespielt.');
    const { pfad } = await ordner();
    const roh = String(req.headers['x-dateiname'] ?? 'hochgeladen.portal').replace(/[^\w.-]/g, '_');
    let n = roh.endsWith('.portal') ? roh : `${roh}.portal`;
    for (let i = 2; await fs.stat(path.join(pfad, n)).then(() => true, () => false); i++) n = n.replace(/(_\d+)?\.portal$/, `_${i}.portal`);
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
