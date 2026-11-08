import path from 'node:path';
import { z } from 'zod';
import type { ServerModule } from '../../../server/src/module.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { sql } from '../../../server/src/db.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { BusinessError } from '../../../server/src/errors.js';
import { esc, htmlToPdf } from '../../../server/src/pdf.js';
import { getPublicSettings } from '../../../server/src/routes/settings.js';

/**
 * Beispielmodul "Kontakte" – Vorlage für eigene Fachmodule.
 * Zeigt: Liste mit Suche, Anlegen/Ändern/Löschen, Nummernkreis,
 * Änderungsbelege, Berechtigungen und PDF-Ausgabe.
 */
const P = {
  display: 'beispiel.kontakte:display',
  edit: 'beispiel.kontakte:edit',
  delete: 'beispiel.kontakte:delete',
};

/** Leere Eingaben als NULL speichern (sauberere Daten und Änderungsbelege). */
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

const kontaktBody = z.object({
  name: z.string().trim().min(1, 'Pflichtfeld').max(200),
  firma: opt(200),
  email: opt(200).refine((v) => !v || z.string().email().safeParse(v).success, 'Keine gültige E-Mail'),
  telefon: opt(50),
  notiz: opt(5000),
  aktiv: z.boolean().default(true),
});

const cols = sql`id, nummer, name, firma, email, telefon, notiz, aktiv,
                 created_at as "createdAt", updated_at as "updatedAt"`;

const mod: ServerModule = {
  id: 'beispiel',
  name: 'Beispiel: Kontakte',
  migrationsDir: path.join(APP_ROOT, 'modules', 'beispiel', 'server', 'migrations'),
  permissions: [
    { app: 'Kontakte', id: P.display, text: 'Kontakte anzeigen' },
    { app: 'Kontakte', id: P.edit, text: 'Kontakte anlegen und ändern' },
    { app: 'Kontakte', id: P.delete, text: 'Kontakte löschen' },
  ],
  auditObjects: [{ type: 'KONTAKT', text: 'Kontakt', permission: P.display }],

  routes(app) {
    app.get('/kontakte', { preHandler: requireAuth(P.display) }, async (req) => {
      const { q } = z.object({ q: z.string().optional() }).parse(req.query);
      const like = q ? `%${q}%` : null;
      return sql`select ${cols} from beispiel.kontakte
                  ${like ? sql`where name ilike ${like} or firma ilike ${like} or nummer ilike ${like} or email ilike ${like}` : sql``}
                  order by nummer`;
    });

    app.get('/kontakte/:id', { preHandler: requireAuth(P.display) }, async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const [k] = await sql`select ${cols} from beispiel.kontakte where id = ${id}`;
      if (!k) throw new BusinessError('Kontakt nicht gefunden.', 404);
      return k;
    });

    app.post('/kontakte', { preHandler: requireAuth(P.edit) }, async (req) => {
      const b = kontaktBody.parse(req.body);
      return change(req, async (tx) => {
        const [{ n }] = await tx`select core.next_number('KONTAKT') as n`;
        const nummer = 'K' + String(n).padStart(6, '0');
        const [k] = await tx`
          insert into beispiel.kontakte (nummer, name, firma, email, telefon, notiz, aktiv)
          values (${nummer}, ${b.name}, ${b.firma}, ${b.email}, ${b.telefon}, ${b.notiz}, ${b.aktiv})
          returning id, nummer`;
        return k;
      });
    });

    app.put('/kontakte/:id', { preHandler: requireAuth(P.edit) }, async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = kontaktBody.parse(req.body);
      await change(req, async (tx) => {
        const r = await tx`
          update beispiel.kontakte
             set name = ${b.name}, firma = ${b.firma}, email = ${b.email},
                 telefon = ${b.telefon}, notiz = ${b.notiz}, aktiv = ${b.aktiv}
           where id = ${id}`;
        if (r.count === 0) throw new BusinessError('Kontakt nicht gefunden.', 404);
      });
      return { ok: true };
    });

    app.delete('/kontakte/:id', { preHandler: requireAuth(P.delete) }, async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { reason } = z.object({ reason: z.string().trim().min(1, 'Begründung ist Pflicht') }).parse(req.body ?? {});
      await change(req, (tx) => tx`delete from beispiel.kontakte where id = ${id}`, { action: 'LOESCHEN', reason });
      return { ok: true };
    });

    app.get('/kontakte/:id/pdf', { preHandler: requireAuth(P.display) }, async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const [k] = await sql`select ${cols} from beispiel.kontakte where id = ${id}`;
      if (!k) throw new BusinessError('Kontakt nicht gefunden.', 404);
      const s = await getPublicSettings();
      const color = (s['org.color'] as string) ?? '#0a6ed1';
      const logo = s['org.logo'] as string | undefined;
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#222}
        header{background:${esc(color)};color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center}
        header img{max-height:60px} h1{margin:0;font-size:20pt}
        table{border-collapse:collapse;margin-top:20px;width:100%} td{padding:6px 8px;border-bottom:1px solid #ddd}
        td:first-child{width:30%;color:#666}</style></head><body>
        <header><div><h1>Kontaktblatt</h1><div>${esc(s['org.name'])}</div></div>${logo ? `<img src="${esc(logo)}">` : ''}</header>
        <table>
          <tr><td>Nummer</td><td>${esc(k.nummer)}</td></tr>
          <tr><td>Name</td><td>${esc(k.name)}</td></tr>
          <tr><td>Firma</td><td>${esc(k.firma)}</td></tr>
          <tr><td>E-Mail</td><td>${esc(k.email)}</td></tr>
          <tr><td>Telefon</td><td>${esc(k.telefon)}</td></tr>
          <tr><td>Notiz</td><td>${esc(k.notiz).replace(/\n/g, '<br>')}</td></tr>
        </table></body></html>`;
      const pdf = await htmlToPdf(html);
      return reply.type('application/pdf').header('content-disposition', `inline; filename="${k.nummer}.pdf"`).send(pdf);
    });
  },
};

export default mod;
