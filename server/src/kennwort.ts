import crypto from 'node:crypto';
import { sql, type Tx } from './db.js';
import { sha256 } from './auth.js';
import { activeModules } from './modules.js';
import { BusinessError } from './errors.js';

/**
 * Einmal-Links für Kennwörter:
 *  - RESET: „Passwort vergessen“ (60 Minuten gültig)
 *  - SETZEN: Benutzer ohne Startkennwort anlegen – der Link führt zum ersten eigenen Kennwort (48 Stunden gültig)
 * Der Token (32 Zufallsbytes) steht nur im Link; gespeichert wird sein SHA-256-Hash. Ein Link gilt genau einmal,
 * ein neuer Link macht ältere desselben Zwecks ungültig.
 */
export type Zweck = 'RESET' | 'SETZEN';
export const GUELTIG_STUNDEN: Record<Zweck, number> = { RESET: 1, SETZEN: 48 };
type Db = Tx;

/** Öffentliche Adresse des Portals für Links in E-Mails (Einstellungen → „Portal-Adresse“ oder PORTAL_URL) – nie aus dem Request */
export async function portalUrl(): Promise<string | null> {
  const [s] = await sql`select value from core.settings where key = 'portal.url'`;
  const url = (typeof s?.value === 'string' && s.value) || process.env.PORTAL_URL || '';
  return url ? url.replace(/\/+$/, '') : null;
}

export interface Mail { an: string; betreff: string; text: string; objekt: string; anwendung: string }

/** Mailversand über das erste aktive Fachmodul, das einen Versand anbietet (z. B. n8n beim TCO) */
export function mailVerfuegbar(): ((m: Mail) => Promise<void>) | null {
  const m = activeModules().find((x) => x.mailer);
  return m?.mailer ?? null;
}

export async function tokenErzeugen(db: Db, userId: string, zweck: Zweck, ip: string | null): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await db`delete from core.password_tokens where user_id = ${userId} and zweck = ${zweck} and verwendet_am is null`;
  await db`insert into core.password_tokens (user_id, zweck, token_hash, gueltig_bis, ip)
           values (${userId}, ${zweck}, ${sha256(token)}, now() + make_interval(hours => ${GUELTIG_STUNDEN[zweck]}), ${ip})`;
  return token;
}

/** gültigen Token lesen (nicht verwendet, nicht abgelaufen, Benutzer aktiv) */
export async function tokenLesen(db: Db, token: string) {
  if (!token || token.length < 20) return null;
  const [t] = await db`select t.id, t.user_id::text, t.zweck, u.username, u.display_name, u.email
                         from core.password_tokens t join core.users u on u.id = t.user_id
                        where t.token_hash = ${sha256(token)} and t.verwendet_am is null and t.gueltig_bis > now() and u.active`;
  return t ?? null;
}

/** sicherer Platzhalter-Hash für Benutzer ohne Startkennwort (niemand kennt das Kennwort) */
export async function unbekanntesKennwort(): Promise<string> {
  const { hashPassword } = await import('./auth.js');
  return hashPassword(crypto.randomBytes(32).toString('base64url'));
}

/**
 * Link erzeugen und per E-Mail senden. Wirft eine verständliche Meldung, wenn Portal-Adresse, Mailversand oder
 * E-Mail-Adresse fehlen (der Aufrufer entscheidet, ob er dann auf ein Startkennwort ausweicht).
 */
export async function kennwortLinkSenden(db: Db, userId: string, zweck: Zweck, ip: string | null, orgName?: string): Promise<string> {
  const url = await portalUrl();
  if (!url) throw new BusinessError('Für Kennwort-Links fehlt die Portal-Adresse (Administration → Einstellungen).');
  const mailer = mailVerfuegbar();
  if (!mailer) throw new BusinessError('Der E-Mail-Versand ist nicht eingerichtet.');
  const [u] = await db`select username, display_name, email from core.users where id = ${userId}`;
  if (!u?.email) throw new BusinessError('Für den Benutzer ist keine E-Mail-Adresse hinterlegt.');
  const token = await tokenErzeugen(db, userId, zweck, ip);
  const link = `${url}/?kennwort=${token}`;
  const org = orgName ?? ((await sql`select value from core.settings where key = 'org.name'`)[0]?.value as string | undefined) ?? 'Portal';
  const reset = zweck === 'RESET';
  await mailer({
    an: u.email, anwendung: 'Benutzer', objekt: u.username,
    betreff: reset ? `${org}: Kennwort zurücksetzen` : `${org}: Ihr Zugang – bitte Kennwort festlegen`,
    text: reset
      ? `Guten Tag ${u.display_name || u.username},\n\nfür Ihren Zugang (Benutzer ${u.username}) wurde das Zurücksetzen des Kennworts angefordert. `
        + `Über diesen Link vergeben Sie ein neues Kennwort (gültig ${GUELTIG_STUNDEN.RESET * 60} Minuten, nur einmal verwendbar):\n\n${link}\n\n`
        + `Haben Sie das nicht angefordert, können Sie diese E-Mail ignorieren – Ihr bisheriges Kennwort bleibt gültig.\n\nViele Grüße\n${org}`
      : `Guten Tag ${u.display_name || u.username},\n\nfür Sie wurde ein Zugang zum Portal angelegt.\n\nAnmeldename: ${u.username}\n\n`
        + `Bitte legen Sie über diesen Link Ihr eigenes Kennwort fest (gültig ${GUELTIG_STUNDEN.SETZEN} Stunden, nur einmal verwendbar):\n\n${link}\n\n`
        + `Danach melden Sie sich unter ${url} an.\n\nViele Grüße\n${org}`,
  });
  return u.email as string;
}
