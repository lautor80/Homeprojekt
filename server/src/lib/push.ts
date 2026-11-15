/**
 * Push-Nachrichten aufs Handy (Web-Push): Geräte der Benutzer, Arten zum Ein- und Ausschalten, Versand.
 *
 * Wer etwas mitzuteilen hat, ruft pushAnBenutzer() oder pushAnRecht() mit einer Art auf. Jede Art steht im Katalog
 * (PUSH_ARTEN_KERN bzw. `pushArten` des Moduls) – der Benutzer schaltet sie unter „Benachrichtigungen“ im Benutzermenü
 * je Art ein oder aus; ohne Abwahl ist eine Art eingeschaltet. Hinweise im Arbeitsvorrat (hinweise.ts) lösen von selbst
 * eine Nachricht an alle aus, die dem Hinweis nachgehen dürfen: Art „<modul>:<quelle>“, sonst „Sonstige Hinweise“.
 *
 * Der Versand wartet nicht und scheitert still: Push ist die schnelle Ergänzung, nicht der verlässliche Kanal. Auf dem
 * Sperrbildschirm steht nur ein kurzer Hinweis – Einzelheiten zeigt das Portal nach dem Antippen (pfad).
 * Technik (Verschlüsselung, Ausweis gegenüber dem Push-Dienst): webpush.ts.
 */
import type { FastifyRequest } from 'fastify';
import { can } from '../auth.js';
import { sql } from '../db.js';
import { BusinessError } from '../errors.js';
import { rechtAbgeschaltet } from '../funktionsschalter.js';
import { activeModules } from '../modules.js';
import { pushDienstErlaubt, vapidKopf, vapidSchluesselErzeugen, verschluesseln, type VapidSchluessel } from './webpush.js';

/** eine Art von Push-Nachricht, die der Benutzer ein- oder ausschalten kann */
export interface PushArt {
  /** eindeutig, z. B. „tco:KAL_EINLADUNG“; für Hinweise im Arbeitsvorrat „<modul>:<quelle>“ */
  id: string;
  /** Überschrift in den Einstellungen, z. B. „Vereinskalender“ */
  gruppe: string;
  text: string;
  /** nur wer dieses Recht hat, sieht die Art in seinen Einstellungen */
  recht?: string;
  /** Art gehört zu einem Hinweis im Arbeitsvorrat (id = „<modul>:<quelle>“) */
  hinweis?: boolean;
}

export const PUSH_SONSTIGE = 'core:HINWEIS';
export const PUSH_ARTEN_KERN: PushArt[] = [
  { id: 'core:PAPERLESS', gruppe: 'Administration', text: 'Paperless gestört', recht: 'core.settings:edit', hinweis: true },
  { id: 'core:MAIL_FEHLER', gruppe: 'Administration', text: 'E-Mail nicht gesendet', recht: 'core.mail:display', hinweis: true },
  { id: 'core:MAIL_RUECKLAUF', gruppe: 'Administration', text: 'Antwort oder Rückläufer auf eine E-Mail', recht: 'core.mail:display', hinweis: true },
  { id: PUSH_SONSTIGE, gruppe: 'Arbeitsvorrat', text: 'Sonstige Hinweise im Arbeitsvorrat' },
];

export const pushArten = (): PushArt[] => [...PUSH_ARTEN_KERN, ...activeModules().flatMap((m) => m.pushArten ?? [])];

/** Arten, die dieser Benutzer bekommen kann – „Sonstige Hinweise“ nur, wer überhaupt Hinweisen im Arbeitsvorrat nachgeht */
export function pushArtenFuer(req: FastifyRequest): PushArt[] {
  const sichtbar = pushArten().filter((a) => a.id !== PUSH_SONSTIGE && (!a.recht || can(req, a.recht)));
  return sichtbar.some((a) => a.hinweis) ? [...sichtbar, ...PUSH_ARTEN_KERN.filter((a) => a.id === PUSH_SONSTIGE)] : sichtbar;
}

export interface PushNachricht {
  titel: string;
  text?: string;
  /** Portalpfad, der sich beim Antippen öffnet */
  pfad?: string;
}

// ---------------------------------------------------------------- Schlüssel des Portals
let schluessel: VapidSchluessel | null = null;
export async function pushSchluessel(): Promise<VapidSchluessel> {
  if (schluessel) return schluessel;
  const neu = vapidSchluesselErzeugen();
  await sql`insert into core.push_schluessel (oeffentlich, privat) values (${neu.oeffentlich}, ${neu.privat}) on conflict (id) do nothing`;
  const [k] = await sql`select oeffentlich, privat from core.push_schluessel`;
  schluessel = { oeffentlich: k.oeffentlich as string, privat: k.privat as string };
  return schluessel;
}
/** nach einer Rücksicherung bzw. im Test: Schlüssel neu aus der Datenbank lesen */
export const pushSchluesselVergessen = (): void => { schluessel = null; };

// ---------------------------------------------------------------- Geräte
export interface PushGeraet { id: number; name: string; erstellt_am: string; zuletzt_am: string | null; endpoint: string }

export async function pushGeraete(userId: string): Promise<PushGeraet[]> {
  const rows = await sql`select id::int as id, name, erstellt_am, zuletzt_am, endpoint from core.push_geraete where user_id = ${userId} order by erstellt_am, id`;
  return rows as unknown as PushGeraet[];
}

/** Gerät anmelden – meldet sich derselbe Browser unter einem anderen Benutzer an, gehört das Gerät danach diesem */
export async function pushGeraetAnmelden(userId: string, g: { endpoint: string; p256dh: string; auth: string; name: string }): Promise<void> {
  if (!pushDienstErlaubt(g.endpoint)) throw new BusinessError('Dieser Browser nutzt einen Push-Dienst, den das Portal nicht kennt.');
  try { verschluesseln('', g); } catch { throw new BusinessError('Die Anmeldung des Geräts ist unvollständig. Bitte Benachrichtigungen aus- und wieder einschalten.'); }
  await sql`insert into core.push_geraete (user_id, endpoint, p256dh, auth, name) values (${userId}, ${g.endpoint}, ${g.p256dh}, ${g.auth}, ${g.name})
            on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, name = excluded.name, fehler = 0`;
}

export async function pushGeraetAbmelden(userId: string, g: { id?: number; endpoint?: string }): Promise<number> {
  const r = await sql`delete from core.push_geraete where user_id = ${userId} and ${g.id ? sql`id = ${g.id}` : sql`endpoint = ${g.endpoint ?? ''}`}`;
  return r.count;
}

// ---------------------------------------------------------------- Abwahl je Art
export async function pushAbwahl(userId: string): Promise<string[]> {
  return (await sql`select art from core.push_abwahl where user_id = ${userId}`).map((r) => r.art as string);
}

/** Abwahl ersetzen – nur für die Arten, die der Benutzer sieht (`sichtbar`); andere Einträge bleiben, wie sie sind */
export async function pushAbwahlSetzen(userId: string, sichtbar: string[], aus: string[]): Promise<void> {
  const neu = aus.filter((a) => sichtbar.includes(a));
  await sql.begin(async (tx) => {
    await tx`delete from core.push_abwahl where user_id = ${userId} and art = any(${sichtbar}::text[])`;
    if (neu.length) await tx`insert into core.push_abwahl (user_id, art) select ${userId}::uuid, unnest(${neu}::text[])`;
  });
}

// ---------------------------------------------------------------- Versand
export interface PushAnfrage { endpoint: string; kopf: Record<string, string>; rumpf: Buffer }
/** Antwort des Push-Dienstes: HTTP-Status (201 = angenommen, 404/410 = Gerät gibt es nicht mehr) */
export type PushTransport = (a: PushAnfrage) => Promise<number>;

const netz: PushTransport = async (a) => {
  const r = await fetch(a.endpoint, { method: 'POST', headers: a.kopf, body: new Uint8Array(a.rumpf), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  return r.status;
};
let transport: PushTransport = netz;
/** für Tests: Versand abfangen statt den Push-Dienst aufzurufen (ohne Angabe: wieder echtes Netz) */
export const pushTransport = (t?: PushTransport): void => { transport = t ?? netz; };

/** Gerät nach so vielen Fehlversuchen in Folge abmelden (der Benutzer schaltet es bei Bedarf wieder ein) */
const MAX_FEHLER = 20;

async function kontakt(): Promise<string> {
  const [s] = await sql`select value from core.settings where key = 'portal.url'`;
  const url = typeof s?.value === 'string' ? s.value.trim() : '';
  return /^https:\/\//.test(url) ? url : 'mailto:portal@example.org';
}

/** an bestimmte Geräte senden – Ergebnis: Anzahl der vom Push-Dienst angenommenen Nachrichten */
async function senden(geraete: { id: number; endpoint: string; p256dh: string; auth: string }[], art: string, n: PushNachricht): Promise<number> {
  if (!geraete.length) return 0;
  const k = await pushSchluessel();
  const sub = await kontakt();
  const daten = JSON.stringify({ titel: n.titel.slice(0, 120), text: (n.text ?? '').slice(0, 300), pfad: n.pfad ?? '/', art });
  let ok = 0;
  await Promise.all(geraete.map(async (g) => {
    let status = 0;
    try {
      if (!pushDienstErlaubt(g.endpoint)) status = 410;
      else status = await transport({
        endpoint: g.endpoint, rumpf: verschluesseln(daten, g),
        kopf: { authorization: vapidKopf(g.endpoint, k, sub), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' },
      });
    } catch { status = 0; }
    try {
      if (status >= 200 && status < 300) { ok++; await sql`update core.push_geraete set zuletzt_am = now(), fehler = 0 where id = ${g.id}`; }
      else if (status === 404 || status === 410) await sql`delete from core.push_geraete where id = ${g.id}`;
      else {
        await sql`update core.push_geraete set fehler = fehler + 1 where id = ${g.id}`;
        await sql`delete from core.push_geraete where id = ${g.id} and fehler >= ${MAX_FEHLER}`;
      }
    } catch { /* Buchführung über das Gerät ist nicht wichtiger als der Versand */ }
  }));
  return ok;
}

/** Nachricht einer Art an Benutzer – nur an die, die die Art nicht abgewählt haben. Ergebnis: angenommene Nachrichten */
export async function pushAnBenutzer(userIds: string[], art: string, n: PushNachricht): Promise<number> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const geraete = await sql`
    select g.id::int as id, g.endpoint, g.p256dh, g.auth
      from core.push_geraete g join core.users u on u.id = g.user_id and u.active
     where g.user_id = any(${ids}::uuid[])
       and not exists (select 1 from core.push_abwahl a where a.user_id = g.user_id and a.art = ${art})`;
  return senden(geraete as never, art, n);
}

/** Benutzer, die ein Recht haben (über ihre aktiven Rollen) */
export async function benutzerMitRecht(recht: string): Promise<string[]> {
  if (rechtAbgeschaltet(recht)) return [];
  const rows = await sql`
    select distinct u.id
      from core.users u
      join core.user_roles ur on ur.user_id = u.id
      join core.roles r on r.id = ur.role_id
      join core.role_permissions rp on rp.role_id = ur.role_id
     where u.active and not core.rolle_inaktiv(r.inaktiv_von, r.inaktiv_bis)
       and rp.permission = any(${['*', recht, `${recht.split(':')[0]}:*`]}::text[])`;
  return rows.map((r) => r.id as string);
}

/** Nachricht einer Art an alle, die ein Recht haben (Vorstand, Kassenwart, Administration …) */
export async function pushAnRecht(recht: string, art: string, n: PushNachricht, ohne?: string | null): Promise<number> {
  return pushAnBenutzer((await benutzerMitRecht(recht)).filter((id) => id !== ohne), art, n);
}

/** Testnachricht an die eigenen Geräte – unabhängig von der Abwahl */
export async function pushTest(userId: string): Promise<number> {
  const geraete = await sql`select id::int as id, endpoint, p256dh, auth from core.push_geraete where user_id = ${userId}`;
  return senden(geraete as never, 'core:TEST', { titel: 'Testnachricht', text: 'Push-Nachrichten sind auf diesem Gerät eingeschaltet.', pfad: '/' });
}

/** Art eines Hinweises im Arbeitsvorrat: eigene Art, wenn im Katalog, sonst „Sonstige Hinweise“ */
export const pushArtHinweis = (modul: string, quelle: string): string => (pushArten().some((a) => a.id === `${modul}:${quelle}`) ? `${modul}:${quelle}` : PUSH_SONSTIGE);

/** nicht warten, nicht scheitern: Push darf den eigentlichen Vorgang weder bremsen noch abbrechen */
export function pushStill(p: () => Promise<unknown>): void {
  void (async () => { try { await p(); } catch { /* Push ist Beigabe */ } })();
}
