import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import { DB, vereinLesen, type Db } from '../verein.js';
import { mailSenden } from '../kommunikation.js';
import {
  aktiveTeilnehmer, ergebnisSpeichern, P_TURNIER, platzSchluesselErzeugen, rundenLesen, spieleLesen, teilnehmerLesen,
  teilnehmerZumZugang, turnierLesen, turnierZurKennung, zugangErzeugen, type ModusDef,
} from './daten.js';
import { kurzname, MODUS_TEXT, STANDARD_EINSTELLUNGEN, vollname, type Modus, type Teilnehmer, type Turnier } from './typen.js';
import { KO } from './ko.js';
import { LIGA } from './liga.js';
import { SPASS } from './spass.js';

/**
 * Turniere (Sport → Turniere): Verwaltung unter /api/m/tco/turniere, öffentlich unter /api/m/tco/turnier/…
 *  - Anmeldung:   GET/POST /turnier/oeffentlich/:kennung(/anmeldung)   – Formular /turnier?t=<kennung>
 *  - Live:        GET /turnier/oeffentlich/:kennung/live               – Seite /turnier-live?t=<kennung>
 *  - Mein Link:   GET /turnier/zugang/:schluessel, POST …/ergebnis, …/abmelden – Seite /turnier-mein?z=<schlüssel>
 * Modusspezifisches (Auslosung, Gruppen, Runden) bringen ko.ts, liga.ts und spass.ts mit.
 */
export { P_TURNIER };
export const MODI: Record<Modus, ModusDef> = { ko: KO, liga: LIGA, spass: SPASS };

const txt = (max: number) => z.string().trim().max(max);
const optTxt = (max: number) => txt(max).nullish().transform((v) => v || null);
const lkSchema = z.union([z.number(), z.string()]).nullish().transform((v, ctx) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/^LK\s*/i, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 1 || n > 25) { ctx.addIssue({ code: 'custom', message: 'Die LK liegt zwischen 1 und 25.' }); return z.NEVER; }
  return Math.round(n * 10) / 10;
});
const idParam = z.object({ id: z.coerce.number().int().positive() });
const tnParam = z.object({ id: z.coerce.number().int().positive(), tid: z.coerce.number().int().positive() });
const satz = z.tuple([z.number().int().min(0).max(99), z.number().int().min(0).max(99)]);
const ergebnisSchema = z.object({
  wertung: z.enum(['gespielt', 'aufgabe', 'wo', 'keine']),
  saetze: z.array(satz).max(3).nullish(),
  sieger: z.enum(['a', 'b']).nullish(),
});

const turnierSchema = z.object({
  name: txt(120).min(1, 'Bitte einen Namen angeben.'),
  kennung: txt(60).toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,59}$/, 'Kennung: Kleinbuchstaben, Ziffern und Bindestrich (z. B. clubmeisterschaft-2027).'),
  modus: z.enum(['ko', 'liga', 'spass']),
  status: z.enum(['entwurf', 'anmeldung', 'laeuft', 'beendet']).default('entwurf'),
  beschreibung: optTxt(2000),
  meldeschluss: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('')).transform((v) => v || null),
  max_teilnehmer: z.coerce.number().int().min(2).max(256).nullish().or(z.literal('')).transform((v) => (v === '' ? null : v ?? null)),
  einstellungen: z.record(z.unknown()).default({}),
});

const teilnehmerSchema = z.object({
  vorname: txt(60).min(1, 'Bitte den Vornamen angeben.'),
  nachname: txt(60).min(1, 'Bitte den Nachnamen angeben.'),
  geburtsjahr: z.coerce.number().int().min(1900).max(2100).nullish().or(z.literal('')).transform((v) => (v === '' ? null : v ?? null)),
  geschlecht: z.enum(['w', 'm', 'd']).nullish().or(z.literal('')).transform((v) => v || null),
  email: optTxt(120).refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Bitte eine gültige E-Mail-Adresse angeben.'),
  telefon: optTxt(40),
  lk: lkSchema,
  bemerkung: optTxt(500),
});

const verwaltSchema = teilnehmerSchema.extend({
  adrnr: optTxt(20),
  rang: z.coerce.number().int().min(1).max(999).nullish().or(z.literal('')).transform((v) => (v === '' ? null : v ?? null)),
  setzplatz: z.coerce.number().int().min(1).max(64).nullish().or(z.literal('')).transform((v) => (v === '' ? null : v ?? null)),
  status: z.enum(['gemeldet', 'warteliste', 'abgemeldet']).default('gemeldet'),
});

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'Turnierleitung';

const versuche = new Map<string, { n: number; bis: number }>();
function limit(schluessel: string, max: number) {
  const jetzt = Date.now();
  const v = versuche.get(schluessel);
  const cur = v && v.bis > jetzt ? v : { n: 0, bis: jetzt + 60 * 60_000 };
  cur.n++;
  versuche.set(schluessel, cur);
  if (cur.n > max) throw new BusinessError('Zu viele Versuche – bitte später erneut versuchen.', 429);
}

/** öffentliche Sicht auf das Turnier (ohne interne Felder) */
function oeffentlich(t: Turnier) {
  return { kennung: t.kennung, name: t.name, modus: t.modus, modus_text: MODUS_TEXT[t.modus], status: t.status, beschreibung: t.beschreibung,
    meldeschluss: t.meldeschluss, max_teilnehmer: t.max_teilnehmer, einstellungen: t.einstellungen };
}

const heute = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const anmeldungOffen = (t: Turnier) => t.status === 'anmeldung' && (!t.meldeschluss || t.meldeschluss >= heute());

/** Mitglied zu Name + Geburtsjahr finden (für die LK aus nuLiga); bei mehreren Treffern keines */
async function mitgliedFinden(db: Db, vorname: string, nachname: string, geburtsjahr: number | null): Promise<{ adrnr: string; lk: number | null } | null> {
  const r = await db<{ adrnr: string; lk: number | null }[]>`
    select m.adrnr, a.lk::float as lk from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
    where lower(m.vorname) = lower(${vorname}) and lower(m.nachname) = lower(${nachname})
      and (${geburtsjahr}::int is null or extract(year from m.geburtsdatum) = ${geburtsjahr}::int)
      and (m.austritt is null or m.austritt >= current_date)`;
  return r.length === 1 ? r[0] : null;
}

async function linkUrl(schluessel: string) {
  const basis = await portalUrl();
  return `${basis ?? ''}/turnier-mein?z=${schluessel}`;
}

/** Bestätigung mit persönlichem Link per E-Mail (Fehler beim Versand brechen die Anmeldung nicht ab) */
async function linkSenden(req: FastifyRequest, t: Turnier, tn: Pick<Teilnehmer, 'vorname' | 'email' | 'id'>, schluessel: string, warteliste: boolean, wer: string) {
  if (!tn.email) return false;
  try {
    const v = await vereinLesen();
    const link = await linkUrl(schluessel);
    const text = [
      `Hallo ${tn.vorname},`, '',
      warteliste
        ? `deine Meldung für „${t.name}“ ist eingegangen. Das Feld ist bereits voll – du stehst auf der Warteliste und rückst nach, sobald ein Platz frei wird.`
        : `deine Anmeldung für „${t.name}“ ist eingegangen.`,
      '', 'Über deinen persönlichen Link siehst du deine Spiele, trägst Ergebnisse ein oder meldest dich ab:', link, '',
      'Bitte gib den Link nicht weiter.', '', `Sportliche Grüße`, v.name,
    ].join('\n');
    await mailSenden(v, { modus: 'senden', anwendung: 'Turniere', objekt: `${t.kennung}/${tn.id}`, an: tn.email, benutzer: wer, anhaenge: [], betreff: `Anmeldung ${t.name}`, text });
    return true;
  } catch (e) {
    req.log.warn({ turnier: t.kennung, err: (e as Error).message }, 'Turnier: Bestätigung nicht gesendet');
    return false;
  }
}

/** Live-Daten mit Namensliste (öffentlich: „Vorname N.“) */
async function liveDaten(db: Db, t: Turnier, oeffentlichAnzeigen: boolean) {
  const tn = await teilnehmerLesen(db, t.id);
  return {
    turnier: oeffentlich(t),
    teilnehmer: tn.filter((x) => x.status !== 'abgemeldet').map((x) => ({ id: x.id, name: oeffentlichAnzeigen ? kurzname(x) : vollname(x), lk: x.lk, status: x.status })),
    daten: await MODI[t.modus].live(db, t),
    stand: new Date().toISOString(),
  };
}

export async function turnierRoutes(app: FastifyInstance) {
  const anzeigen = { preHandler: requireAuth(P_TURNIER.display) };
  const pflegen = { preHandler: requireAuth(P_TURNIER.edit) };

  // ------------------------------------------------------------------ Verwaltung
  app.get('/turniere', anzeigen, async () => DB`
    select t.id, t.kennung, t.name, t.modus, t.status, t.meldeschluss, t.max_teilnehmer, t.created_at,
           (select count(*)::int from tco.turnier_teilnehmer x where x.turnier_id = t.id and x.status = 'gemeldet') as gemeldet,
           (select count(*)::int from tco.turnier_teilnehmer x where x.turnier_id = t.id and x.status = 'warteliste') as warteliste
    from tco.turniere t order by t.created_at desc`);

  app.post('/turniere', pflegen, async (req) => {
    const d = turnierSchema.parse(req.body);
    const einst = { ...STANDARD_EINSTELLUNGEN[d.modus], ...d.einstellungen };
    return change(req, async (tx) => {
      const [dup] = await tx`select 1 from tco.turniere where kennung = ${d.kennung}`;
      if (dup) throw new BusinessError(`Die Kennung „${d.kennung}“ ist schon vergeben.`);
      const [t] = await tx<{ id: number }[]>`insert into tco.turniere (kennung, name, modus, status, beschreibung, meldeschluss, max_teilnehmer, einstellungen)
        values (${d.kennung}, ${d.name}, ${d.modus}, ${d.status}, ${d.beschreibung}, ${d.meldeschluss}, ${d.max_teilnehmer}, ${tx.json(einst as never)}) returning id`;
      return { id: t.id };
    }, { action: 'TURNIER_ANLEGEN' });
  });

  app.get('/turniere/:id', anzeigen, async (req) => {
    const { id } = idParam.parse(req.params);
    const t = await turnierLesen(DB, id);
    return { turnier: t, teilnehmer: await teilnehmerLesen(DB, id), runden: await rundenLesen(DB, id), spiele: await spieleLesen(DB, id), url: await portalUrl() };
  });

  app.put('/turniere/:id', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = turnierSchema.parse(req.body);
    return change(req, async (tx) => {
      const alt = await turnierLesen(tx, id);
      if (alt.modus !== d.modus) {
        const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_spiele where turnier_id = ${id}`;
        if (n) throw new BusinessError('Der Modus lässt sich nicht mehr ändern – es gibt bereits Spiele.');
      }
      const [dup] = await tx`select 1 from tco.turniere where kennung = ${d.kennung} and id <> ${id}`;
      if (dup) throw new BusinessError(`Die Kennung „${d.kennung}“ ist schon vergeben.`);
      const einst = { ...STANDARD_EINSTELLUNGEN[d.modus], ...(alt.modus === d.modus ? alt.einstellungen : {}), ...d.einstellungen };
      await tx`update tco.turniere set kennung = ${d.kennung}, name = ${d.name}, modus = ${d.modus}, status = ${d.status}, beschreibung = ${d.beschreibung},
                 meldeschluss = ${d.meldeschluss}, max_teilnehmer = ${d.max_teilnehmer}, einstellungen = ${tx.json(einst as never)} where id = ${id}`;
      return { ok: true };
    }, { action: 'TURNIER_AENDERN' });
  });

  app.delete('/turniere/:id', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    return change(req, async (tx) => {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_spiele where turnier_id = ${id} and wertung not in ('offen', 'freilos')`;
      if (n) throw new BusinessError(`Das Turnier hat bereits ${n} Ergebnis${n === 1 ? '' : 'se'} – bitte stattdessen auf „beendet“ setzen.`);
      await tx`delete from tco.turniere where id = ${id}`;
      return { ok: true };
    }, { action: 'TURNIER_LOESCHEN' });
  });

  /** Mitglieder mit LK suchen (Teilnehmer aus dem Mitgliederstamm hinzufügen) */
  app.get('/turniere/mitglieder', anzeigen, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(60) }).parse(req.query);
    const muster = `%${q.toLowerCase()}%`;
    return DB`select m.adrnr, m.vorname, m.nachname, extract(year from m.geburtsdatum)::int as geburtsjahr, m.email, coalesce(m.telefon6, m.telefon) as telefon,
                     case lower(coalesce(m.geschlecht, '')) when 'w' then 'w' when 'weiblich' then 'w' when 'm' then 'm' when 'männlich' then 'm' else null end as geschlecht,
                     a.lk::float as lk
              from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
              where (m.austritt is null or m.austritt >= current_date)
                and (lower(m.vorname || ' ' || m.nachname) like ${muster} or lower(m.nachname || ' ' || m.vorname) like ${muster})
              order by m.nachname, m.vorname limit 30`;
  });

  app.post('/turniere/:id/teilnehmer', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = verwaltSchema.parse(req.body);
    return change(req, async (tx) => {
      await turnierLesen(tx, id);
      const [r] = await tx<{ id: number }[]>`insert into tco.turnier_teilnehmer (turnier_id, vorname, nachname, geburtsjahr, geschlecht, email, telefon, adrnr, lk, rang, setzplatz, status, bemerkung)
        values (${id}, ${d.vorname}, ${d.nachname}, ${d.geburtsjahr}, ${d.geschlecht}, ${d.email}, ${d.telefon}, ${d.adrnr}, ${d.lk}, ${d.rang}, ${d.setzplatz}, ${d.status}, ${d.bemerkung}) returning id`;
      return { id: r.id };
    }, { action: 'TURNIER_TEILNEHMER' });
  });

  app.put('/turniere/:id/teilnehmer/:tid', pflegen, async (req) => {
    const { id, tid } = tnParam.parse(req.params);
    const d = verwaltSchema.parse(req.body);
    return change(req, async (tx) => {
      const r = await tx`update tco.turnier_teilnehmer set vorname = ${d.vorname}, nachname = ${d.nachname}, geburtsjahr = ${d.geburtsjahr}, geschlecht = ${d.geschlecht},
                           email = ${d.email}, telefon = ${d.telefon}, adrnr = ${d.adrnr}, lk = ${d.lk}, rang = ${d.rang}, setzplatz = ${d.setzplatz}, status = ${d.status}, bemerkung = ${d.bemerkung}
                         where id = ${tid} and turnier_id = ${id}`;
      if (!r.count) throw new BusinessError('Teilnehmer nicht gefunden.', 404);
      return { ok: true };
    }, { action: 'TURNIER_TEILNEHMER' });
  });

  /** Stärke-Reihenfolge (manueller Rang) für alle auf einmal speichern: ids in Reihenfolge stärkste → schwächste */
  app.put('/turniere/:id/rangliste', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(512) }).parse(req.body);
    return change(req, async (tx) => {
      await tx`update tco.turnier_teilnehmer set rang = null where turnier_id = ${id}`;
      for (let i = 0; i < ids.length; i++) await tx`update tco.turnier_teilnehmer set rang = ${i + 1} where id = ${ids[i]} and turnier_id = ${id}`;
      return { ok: true };
    }, { action: 'TURNIER_RANGLISTE' });
  });

  app.delete('/turniere/:id/teilnehmer/:tid', pflegen, async (req) => {
    const { id, tid } = tnParam.parse(req.params);
    return change(req, async (tx) => {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_spiele where turnier_id = ${id} and (${tid} = any(a) or ${tid} = any(b))`;
      if (n) throw new BusinessError('Diese Person ist bereits ausgelost – bitte stattdessen abmelden.');
      await tx`delete from tco.turnier_teilnehmer where id = ${tid} and turnier_id = ${id}`;
      return { ok: true };
    }, { action: 'TURNIER_TEILNEHMER' });
  });

  /** neuen persönlichen Link erzeugen und (falls E-Mail vorhanden) senden; der Link wird auch zurückgegeben */
  app.post('/turniere/:id/teilnehmer/:tid/link', pflegen, async (req) => {
    const { id, tid } = tnParam.parse(req.params);
    const { senden } = z.object({ senden: z.boolean().default(true) }).parse(req.body ?? {});
    const t = await turnierLesen(DB, id);
    const [tn] = (await teilnehmerLesen(DB, id)).filter((x) => x.id === tid);
    if (!tn) throw new BusinessError('Teilnehmer nicht gefunden.', 404);
    const schluessel = await change(req, (tx) => zugangErzeugen(tx, tid), { action: 'TURNIER_LINK' });
    const gesendet = senden ? await linkSenden(req, t, tn, schluessel, tn.status === 'warteliste', benutzer(req)) : false;
    return { link: await linkUrl(schluessel), text: gesendet ? `Link an ${tn.email} gesendet.` : 'Neuer Link erzeugt (nicht per E-Mail gesendet).' };
  });

  app.post('/turniere/:id/spiele/:sid/ergebnis', pflegen, async (req) => {
    const { id, sid } = z.object({ id: z.coerce.number().int().positive(), sid: z.coerce.number().int().positive() }).parse(req.params);
    const e = ergebnisSchema.parse(req.body);
    return change(req, (tx) => ergebnisSpeichern(tx, MODI, sid, e, { von: benutzer(req), turnierId: id }), { action: 'TURNIER_ERGEBNIS' });
  });

  /** Ergebnis zurücksetzen (Tippfehler) – nur ohne Folgespiele, die schon gewertet sind (prüft der Modus über nachErgebnis) */
  app.delete('/turniere/:id/spiele/:sid/ergebnis', pflegen, async (req) => {
    const { id, sid } = z.object({ id: z.coerce.number().int().positive(), sid: z.coerce.number().int().positive() }).parse(req.params);
    return change(req, async (tx) => {
      const t = await turnierLesen(tx, id);
      const [s] = await tx`update tco.turnier_spiele set wertung = 'offen', saetze = null, sieger = null, eingetragen_von = ${benutzer(req)}, eingetragen_am = now()
                           where id = ${sid} and turnier_id = ${id} and wertung <> 'freilos' returning *`;
      if (!s) throw new BusinessError('Spiel nicht gefunden.', 404);
      await MODI[t.modus].nachErgebnis?.(tx, t, s as never);
      return { ok: true };
    }, { action: 'TURNIER_ERGEBNIS' });
  });

  app.get('/turniere/:id/live', anzeigen, async (req) => {
    const { id } = idParam.parse(req.params);
    return liveDaten(DB, await turnierLesen(DB, id), false);
  });

  /** Platz-Link (Spaßturnier: QR-Code am Platz zum Eintragen der Spiele) neu erzeugen */
  app.post('/turniere/:id/platzlink', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const t = await turnierLesen(DB, id);
    const s = await change(req, (tx) => platzSchluesselErzeugen(tx, id), { action: 'TURNIER_PLATZLINK' });
    return { link: `${(await portalUrl()) ?? ''}/turnier-platz?t=${t.kennung}&k=${s}` };
  });

  // ------------------------------------------------------------------ öffentlich
  app.get('/turnier/oeffentlich/:kennung', async (req) => {
    const { kennung } = z.object({ kennung: z.string().max(60) }).parse(req.params);
    const t = await turnierZurKennung(DB, kennung);
    const gemeldet = (await aktiveTeilnehmer(DB, t.id)).length;
    return { turnier: oeffentlich(t), gemeldet, frei: t.max_teilnehmer ? Math.max(0, t.max_teilnehmer - gemeldet) : null, offen: anmeldungOffen(t) };
  });

  app.post('/turnier/oeffentlich/:kennung/anmeldung', async (req) => {
    limit(`${req.ip}|turnier`, 20);
    const { kennung } = z.object({ kennung: z.string().max(60) }).parse(req.params);
    const d = teilnehmerSchema.extend({ einwilligung: z.boolean(), website: z.string().max(200).optional() }).parse(req.body);
    if (d.website) return { status: 'gemeldet', text: 'Vielen Dank!' }; // Honigtopf
    if (!d.einwilligung) throw new BusinessError('Bitte der Anzeige von Name und Ergebnissen auf der Turnierseite zustimmen.');
    const t = await turnierZurKennung(DB, kennung);
    if (!anmeldungOffen(t)) throw new BusinessError('Die Anmeldung für dieses Turnier ist geschlossen.');
    const r = await withChange({ userId: null, username: 'online-anmeldung', action: 'TURNIER_ANMELDUNG' }, async (tx) => {
      await tx`select id from tco.turniere where id = ${t.id} for update`;
      const [dup] = await tx`select 1 from tco.turnier_teilnehmer where turnier_id = ${t.id} and status <> 'abgemeldet'
                               and lower(vorname) = lower(${d.vorname}) and lower(nachname) = lower(${d.nachname})
                               and coalesce(geburtsjahr, 0) = coalesce(${d.geburtsjahr}::int, 0)`;
      if (dup) throw new BusinessError('Du bist für dieses Turnier bereits angemeldet. Den persönlichen Link findest du in der Bestätigungs-E-Mail.');
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_teilnehmer where turnier_id = ${t.id} and status = 'gemeldet'`;
      const status = t.max_teilnehmer && n >= t.max_teilnehmer ? 'warteliste' : 'gemeldet';
      const mg = await mitgliedFinden(tx, d.vorname, d.nachname, d.geburtsjahr);
      const [tn] = await tx<{ id: number }[]>`insert into tco.turnier_teilnehmer (turnier_id, vorname, nachname, geburtsjahr, geschlecht, email, telefon, adrnr, lk, status, bemerkung)
        values (${t.id}, ${d.vorname}, ${d.nachname}, ${d.geburtsjahr}, ${d.geschlecht}, ${d.email}, ${d.telefon}, ${mg?.adrnr ?? null}, ${d.lk ?? mg?.lk ?? null}, ${status}, ${d.bemerkung}) returning id`;
      return { id: tn.id, status, schluessel: await zugangErzeugen(tx, tn.id) };
    });
    const gesendet = await linkSenden(req, t, { id: r.id, vorname: d.vorname, email: d.email }, r.schluessel, r.status === 'warteliste', 'Online-Anmeldung');
    return {
      status: r.status,
      link: `/turnier-mein?z=${r.schluessel}`,
      text: r.status === 'warteliste'
        ? `Das Feld ist bereits voll – du stehst auf der Warteliste für „${t.name}“.${gesendet ? ' Eine Bestätigung mit deinem persönlichen Link kommt per E-Mail.' : ''}`
        : `Vielen Dank! Du bist für „${t.name}“ angemeldet.${gesendet ? ' Eine Bestätigung mit deinem persönlichen Link kommt per E-Mail.' : ''}`,
    };
  });

  app.get('/turnier/oeffentlich/:kennung/live', async (req) => {
    const { kennung } = z.object({ kennung: z.string().max(60) }).parse(req.params);
    return liveDaten(DB, await turnierZurKennung(DB, kennung), true);
  });

  /** persönlicher Link: eigene Daten, eigene Spiele (mit Namen der Gegner) */
  app.get('/turnier/zugang/:schluessel', async (req) => {
    limit(`${req.ip}|turnierlink`, 600);
    const { schluessel } = z.object({ schluessel: z.string().max(80) }).parse(req.params);
    const ich = await teilnehmerZumZugang(DB, schluessel);
    const t = await turnierLesen(DB, ich.turnier_id);
    const alle = await teilnehmerLesen(DB, t.id);
    const name = new Map(alle.map((x) => [x.id, vollname(x)]));
    const spiele = (await spieleLesen(DB, t.id)).filter((s) => s.a.includes(ich.id) || s.b.includes(ich.id))
      .map((s) => ({ ...s, namen_a: s.a.map((i) => name.get(i) ?? '?'), namen_b: s.b.map((i) => name.get(i) ?? '?'), meine_seite: s.a.includes(ich.id) ? 'a' : 'b' }));
    return { turnier: oeffentlich(t), ich: { id: ich.id, vorname: ich.vorname, nachname: ich.nachname, status: ich.status, lk: ich.lk }, spiele, runden: await rundenLesen(DB, t.id) };
  });

  app.post('/turnier/zugang/:schluessel/ergebnis', async (req) => {
    limit(`${req.ip}|turnierlink-post`, 120);
    const { schluessel } = z.object({ schluessel: z.string().max(80) }).parse(req.params);
    const d = ergebnisSchema.extend({ spiel_id: z.number().int().positive() }).parse(req.body);
    const ich = await teilnehmerZumZugang(DB, schluessel);
    const s = await withChange({ userId: null, username: `turnier:${ich.id}`, action: 'TURNIER_ERGEBNIS', reason: `persönlicher Link ${vollname(ich)}` },
      (tx) => ergebnisSpeichern(tx, MODI, d.spiel_id, d, { von: vollname(ich), turnierId: ich.turnier_id, nurTeilnehmer: ich.id }));
    return { ok: true, spiel: s };
  });

  app.post('/turnier/zugang/:schluessel/abmelden', async (req) => {
    limit(`${req.ip}|turnierlink-post`, 120);
    const { schluessel } = z.object({ schluessel: z.string().max(80) }).parse(req.params);
    const ich = await teilnehmerZumZugang(DB, schluessel);
    await withChange({ userId: null, username: `turnier:${ich.id}`, action: 'TURNIER_ABMELDUNG' }, async (tx) => {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tco.turnier_spiele where turnier_id = ${ich.turnier_id} and (${ich.id} = any(a) or ${ich.id} = any(b))`;
      if (n) throw new BusinessError('Du bist bereits ausgelost – bitte melde dich direkt bei der Turnierleitung ab.');
      await tx`update tco.turnier_teilnehmer set status = 'abgemeldet' where id = ${ich.id}`;
      // erste Person der Warteliste rückt nach
      await tx`update tco.turnier_teilnehmer set status = 'gemeldet' where id = (
                 select id from tco.turnier_teilnehmer where turnier_id = ${ich.turnier_id} and status = 'warteliste' order by angemeldet_am, id limit 1)
               and ${ich.status} = 'gemeldet'`;
    });
    return { ok: true, text: 'Du bist abgemeldet.' };
  });

  for (const m of Object.values(MODI)) await m.routes?.(app);
}
