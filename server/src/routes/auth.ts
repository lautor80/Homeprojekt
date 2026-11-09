import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, withChange } from '../db.js';
import {
  createSession, destroySession, hashPassword, istAltesHashformat, requireAuth, validatePassword, verifyPassword, changeCtx,
} from '../auth.js';
import { getPublicSettings } from './settings.js';
import { loginErfassen } from './statistik.js';
import { activeModuleIds } from '../modules.js';
import { kennwortLinkSenden, tokenLesen } from '../kennwort.js';

// einfacher Schutz gegen Passwort-Raten: max. 10 Fehlversuche je Benutzer/IP in 15 Minuten
const failures = new Map<string, { count: number; until: number }>();
const WINDOW = 15 * 60_000;
// „Passwort vergessen“: höchstens 10 Anfragen je IP und 3 je Konto in der Stunde
const vergessen = new Map<string, { n: number; bis: number }>();
function vergessenZaehlen(key: string, max: number): boolean {
  const jetzt = Date.now();
  const v = vergessen.get(key);
  const cur = v && v.bis > jetzt ? v : { n: 0, bis: jetzt + 60 * 60_000 };
  cur.n++;
  vergessen.set(key, cur);
  return cur.n <= max;
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const key = `${body.username.toLowerCase()}|${req.ip}`;
    const f = failures.get(key);
    if (f && f.count >= 10 && f.until > Date.now()) {
      return reply.code(429).send({ message: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
    }

    // Benutzername oder (eindeutige) E-Mail-Adresse
    let [u] = await sql`select id, password_hash, active from core.users where lower(username) = lower(${body.username})`;
    if (!u && body.username.includes('@')) {
      const treffer = await sql`select id, password_hash, active from core.users where lower(email) = lower(${body.username.trim()}) and active`;
      if (treffer.length === 1) u = treffer[0];
    }
    const ok = u && u.active && (await verifyPassword(u.password_hash, body.password));
    if (!ok) {
      const cur = f && f.until > Date.now() ? f : { count: 0, until: Date.now() + WINDOW };
      cur.count++;
      failures.set(key, cur);
      return reply.code(401).send({ message: 'Benutzername oder Passwort falsch.' });
    }
    failures.delete(key);
    await sql`update core.users set last_login_at = now() where id = ${u.id}`;
    // übernommenes EP3-Kennwort: jetzt im aktuellen Verfahren speichern
    if (istAltesHashformat(u.password_hash)) await sql`update core.users set password_hash = ${await hashPassword(body.password)} where id = ${u.id}`;
    await createSession(req, reply, u.id);
    await loginErfassen(u.id).catch((e) => req.log.warn(e, 'Nutzungsstatistik'));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  /** Alles, was die Oberfläche nach dem Login braucht. */
  app.get('/api/auth/me', { preHandler: requireAuth() }, async (req) => {
    const u = req.user!;
    return {
      user: {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        mustChangePassword: u.mustChangePassword,
        roles: u.roles,
      },
      permissions: [...u.permissions],
      modules: activeModuleIds(),
      settings: await getPublicSettings(),
    };
  });

  /**
   * Passwort vergessen: Link zum Zurücksetzen an die hinterlegte E-Mail. Die Antwort ist immer gleich – ob es das
   * Konto gibt, verrät sie nicht.
   */
  app.post('/api/auth/passwort-vergessen', async (req, reply) => {
    const { konto } = z.object({ konto: z.string().trim().min(1).max(120) }).parse(req.body);
    const antwort = { text: 'Falls zu diesen Angaben ein Zugang mit E-Mail-Adresse besteht, erhalten Sie in Kürze eine E-Mail mit einem Link zum Zurücksetzen des Kennworts. Bitte prüfen Sie auch den Spam-Ordner.' };
    if (!vergessenZaehlen(`ip|${req.ip}`, 10)) return reply.code(429).send({ message: 'Zu viele Anfragen. Bitte später erneut versuchen.' });
    if (!vergessenZaehlen(`konto|${konto.toLowerCase()}`, 3)) return antwort;
    let [u] = await sql`select id from core.users where lower(username) = lower(${konto}) and active`;
    if (!u && konto.includes('@')) {
      const t = await sql`select id from core.users where lower(email) = lower(${konto}) and active`;
      if (t.length === 1) u = t[0];
    }
    if (u) {
      try {
        await kennwortLinkSenden(sql, u.id, 'RESET', req.ip);
        req.log.info({ user: u.id }, 'Link zum Zurücksetzen des Kennworts gesendet');
      } catch (e) { req.log.warn({ user: u.id, err: (e as Error).message }, 'Passwort vergessen: kein Link gesendet'); }
    }
    return antwort;
  });

  /** Einmal-Link prüfen (Anzeige der Seite „Kennwort festlegen“) */
  app.get('/api/auth/kennwort-link', async (req) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(req.query);
    const t = await tokenLesen(sql, token);
    return t ? { gueltig: true, zweck: t.zweck, username: t.username } : { gueltig: false };
  });

  /** Kennwort über den Einmal-Link setzen: Link wird verbraucht, alle Sitzungen des Benutzers enden */
  app.post('/api/auth/kennwort-setzen', async (req, reply) => {
    const b = z.object({ token: z.string().max(100), passwort: z.string().max(200) }).parse(req.body);
    if (!vergessenZaehlen(`setzen|${req.ip}`, 20)) return reply.code(429).send({ message: 'Zu viele Versuche. Bitte später erneut versuchen.' });
    const t = await tokenLesen(sql, b.token);
    if (!t) return reply.code(400).send({ message: 'Der Link ist ungültig oder abgelaufen. Bitte fordern Sie über „Passwort vergessen“ einen neuen an.' });
    const err = validatePassword(b.passwort);
    if (err) return reply.code(400).send({ message: err });
    const h = await hashPassword(b.passwort);
    await withChange({ userId: t.user_id, username: t.username, action: t.zweck === 'RESET' ? 'PASSWORT_VERGESSEN' : 'PASSWORT_FESTLEGEN' }, async (tx) => {
      const r = await tx`update core.password_tokens set verwendet_am = now() where id = ${t.id} and verwendet_am is null returning id`;
      if (!r.length) throw new Error('Link bereits verwendet');
      await tx`update core.users set password_hash = ${h}, must_change_password = false where id = ${t.user_id}`;
      await tx`delete from core.password_tokens where user_id = ${t.user_id} and verwendet_am is null`;
      await tx`delete from core.sessions where user_id = ${t.user_id}`;
    });
    return { text: 'Ihr Kennwort ist gespeichert. Sie können sich jetzt anmelden.', username: t.username };
  });

  app.post('/api/auth/password', { preHandler: requireAuth() }, async (req, reply) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const [u] = await sql`select password_hash from core.users where id = ${req.user!.id}`;
    if (!(await verifyPassword(u.password_hash, body.current))) {
      return reply.code(400).send({ message: 'Das aktuelle Passwort ist falsch.' });
    }
    const err = validatePassword(body.next);
    if (err) return reply.code(400).send({ message: err });
    const h = await hashPassword(body.next);
    await withChange(changeCtx(req, { action: 'PASSWORT_AENDERN' }), (tx) =>
      tx`update core.users set password_hash = ${h}, must_change_password = false where id = ${req.user!.id}`);
    return { ok: true };
  });
}
