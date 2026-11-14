import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../auth.js';
import { sql, type Tx } from '../db.js';
import { BusinessError } from '../errors.js';
import { activeModules } from '../modules.js';
import { getSettings } from './settings.js';
import { eingangVerbuchen } from '../lib/maileingang-db.js';
import { authHeader } from '../lib/verbindungen.js';
import { adressen, passt, personenIndex, personenText, type MailPerson } from '../lib/mailuebersicht.js';
import { erneutSperre, mailErneutSenden, mailSenden, mailVerbindung, mailWiederholen, nichtWiederholbar, WIEDERHOLBAR, wiederholungsArt, type MailFolge, type Wiederholung } from '../lib/mail.js';

/** Mailprotokoll, Testmail und „Erneut senden“ (Administration → Schnittstellen → Anbindungen → E-Mail-Versand) */
const P = 'core.settings:edit';
/** App „E-Mail-Protokoll“: nur lesen (Empfänger, Betreff, Status – nie der Inhalt) */
const P_ANZEIGE = 'core.mail:display';
/** App „E-Mail-Protokoll“: je Zeile erneut senden (auch bereits gesendete), Kopie an den Absender */
const P_SENDEN = 'core.mail:edit';
const UEBERSICHT_MAX = 2000;
/** Kopie beim erneuten Senden: tatsächlicher Absender der ersten E-Mail, sonst der gewünschte, sonst wer jetzt sendet */
const kopieAn = (p: { von: string | null; absender: string | null }, eigene: string | null | undefined): string | null =>
  adressen(p.von)[0] ?? adressen(p.absender)[0] ?? adressen(eigene)[0] ?? null;
/** eingegangene Mail eines Absender-Postfachs (n8n-Workflow „TCO Maileingang“); der Text wird nur ausgewertet, nie gespeichert */
const eingang = z.object({
  postfach: z.string().max(500).nullish(), von: z.string().max(500).nullish(), betreff: z.string().max(1000).nullish(),
  datum: z.string().max(100).nullish(), message_id: z.string().max(500).nullish(), in_reply_to: z.string().max(2000).nullish(),
  references: z.string().max(20_000).nullish(), auto: z.string().max(200).nullish(),
  text: z.string().nullish().transform((x) => (x ?? '').slice(0, 100_000)),
});
const gleich = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

interface UebersichtRoh {
  id: number; zeit: string; anwendung: string | null; objekt: string | null; an: string | null; betreff: string | null; absender: string | null;
  von: string | null; status: string; fehler: string | null; benutzer: string | null; inhalt: boolean; w_art: string | null; w_hinweis: string | null;
  erneut_am: string | null; erneut_von: string | null; erneut_status: string | null;
}

// Filter: Anwendung, Zeitraum von/bis (Ortszeit, „JJJJ-MM-TTTHH:MM“ oder nur Datum)
const protoFilter = z.object({
  anwendung: z.string().trim().max(60).optional().transform((x) => x || null),
  von: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/, 'Zeitraum „von“ ungültig').optional().transform((x) => x || null),
  bis: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/, 'Zeitraum „bis“ ungültig').optional().transform((x) => x || null),
});
type ProtoFilter = z.infer<typeof protoFilter>;
// App „E-Mail-Protokoll“: zusätzlich Status und Freitext (Person, Empfänger, Vorgang, Betreff, Fehler …)
const uebersichtFilter = protoFilter.extend({
  status: z.enum(['gesendet', 'entwurf', 'fehler', 'nicht_gesendet', 'unzustellbar']).or(z.literal('')).optional().transform((x) => x || null),
  suche: z.string().trim().max(120).optional().transform((x) => x || null),
});
// „bis“ ohne Uhrzeit = ganzer Tag; mit Uhrzeit einschließlich dieser Minute
const bisGrenze = (b: string) => (b.length === 10 ? `${b}T23:59:59.999` : `${b.replace(' ', 'T')}:59.999`);
const protoWo = (db: Tx, f: ProtoFilter) => db`
  where true
    ${f.anwendung ? db`and anwendung = ${f.anwendung}` : db``}
    ${f.von ? db`and zeit >= (${f.von.replace(' ', 'T')}::timestamp at time zone 'Europe/Berlin')` : db``}
    ${f.bis ? db`and zeit <= (${bisGrenze(f.bis)}::timestamp at time zone 'Europe/Berlin')` : db``}`;

/** Wiederholung mit neuem Link bzw. Nachziehen: das erste zuständige Modul antwortet */
async function wiederholen(tx: Tx, w: Wiederholung, wer: string, cc?: string): Promise<string | null> {
  for (const m of activeModules()) {
    const t = await m.mailWiederholen?.(tx, w, wer, cc);
    if (t != null) return t;
  }
  return null;
}
async function folge(tx: Tx, f: MailFolge): Promise<string[] | null> {
  for (const m of activeModules()) {
    const t = await m.mailFolge?.(tx, f);
    if (t != null) return t;
  }
  return null;
}

export async function mailRoutes(app: FastifyInstance) {
  const DB = sql as unknown as Tx;
  app.get('/api/mail/protokoll/anwendungen', { preHandler: requireAuth(P) }, async () =>
    (await sql`select distinct anwendung from core.mail_protokoll where anwendung is not null order by 1`).map((r) => r.anwendung as string));

  /** Protokoll leeren – alles oder nur die gefilterten Einträge */
  app.delete('/api/mail/protokoll', { preHandler: requireAuth(P) }, async (req) => {
    const f = protoFilter.parse(req.body ?? {});
    const r = await change(req, (tx) => tx`delete from core.mail_protokoll ${protoWo(tx, f)}`, { action: 'MAILPROTOKOLL_LEEREN' });
    return { anzahl: r.count, text: `${r.count} Protokolleintrag/-einträge gelöscht.` };
  });

  app.get('/api/mail/protokoll', { preHandler: requireAuth(P) }, async (req) => {
    const f = protoFilter.parse(req.query);
    const rows = await DB`
      select id, to_char(zeit at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as zeit, anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer,
             nachricht, to_char(erneut_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as erneut_am, erneut_von, erneut_status
        from core.mail_protokoll ${protoWo(DB, f)} order by id desc limit ${f.anwendung || f.von || f.bis ? 500 : 50}`;
    // Inhalt nie ausliefern – nur, ob und warum (nicht) erneut gesendet werden kann
    return rows.map(({ nachricht, ...p }) => {
      const fehlgeschlagen = WIEDERHOLBAR.includes(p.status) && p.erneut_status !== 'gesendet' && p.erneut_status !== 'entwurf';
      const hinweis = fehlgeschlagen ? nichtWiederholbar({ status: p.status, nachricht, erneut_status: p.erneut_status }) : null;
      const w = wiederholungsArt(nachricht);
      return { ...p, erneut: fehlgeschlagen && !hinweis, erneut_hinweis: hinweis, erneut_neuer_link: !!w && w !== 'NEU_AUSLOESEN' };
    });
  });

  /**
   * App „E-Mail-Protokoll“: alle Versandversuche im Zeitraum als Tabelle, je Zeile mit der Person hinter der Empfängeradresse
   * (Benutzer aus dem Kern, Mitglieder/Kunden/Registrierungen aus den Modulen) – so findet die Suche nach einem Namen
   * auch die Mails an dessen Adresse. Der Inhalt wird nie ausgeliefert.
   */
  app.get('/api/mail/uebersicht', { preHandler: requireAuth(P_ANZEIGE) }, async (req) => {
    const f = uebersichtFilter.parse(req.query);
    const rows = await DB`
      select id, to_char(zeit at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as zeit, anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer,
             nachricht is not null as inhalt, nachricht->'wiederholung'->>'art' as w_art, nachricht->'wiederholung'->>'hinweis' as w_hinweis,
             to_char(erneut_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as erneut_am, erneut_von, erneut_status
        from core.mail_protokoll ${protoWo(DB, f)}
             ${f.status === 'unzustellbar' ? DB`and exists (select 1 from core.mail_antworten a where a.protokoll_id = core.mail_protokoll.id and a.art = 'unzustellbar')`
               : f.status ? DB`and status = ${f.status}` : DB``}
       order by id desc limit ${UEBERSICHT_MAX + 1}`;
    const gekuerzt = rows.length > UEBERSICHT_MAX;
    const liste = rows.slice(0, UEBERSICHT_MAX) as unknown as UebersichtRoh[];
    const emails: string[] = [...new Set(liste.flatMap((r) => adressen(r.an)))];
    const personen: MailPerson[] = [];
    if (emails.length) {
      for (const m of activeModules()) personen.push(...((await m.mailPersonen?.(DB, emails)) ?? []));
      const benutzer = await DB`select lower(btrim(email)) as email, display_name as name from core.users where lower(btrim(email)) = any(${emails}::text[])`;
      personen.push(...benutzer.map((b) => ({ email: b.email as string, name: b.name as string, art: 'Benutzer' })));
    }
    const index = personenIndex(personen);
    // Rückmeldungen: Unzustellbar-Meldungen, Abwesenheitsnotizen und Antworten je gesendeter E-Mail (ohne Inhalt)
    const antworten = new Map<string, { art: string; zeit: string; von: string | null; betreff: string | null; grund: string | null }[]>();
    if (liste.length) {
      const a = await DB`
        select protokoll_id, art, to_char(zeit at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as zeit, von, betreff, grund
          from core.mail_antworten where protokoll_id = any(${liste.map((r) => String(r.id))}::text[]::bigint[]) order by zeit, id`;
      for (const { protokoll_id, ...x } of a as unknown as ({ protokoll_id: string | number; art: string; zeit: string; von: string | null; betreff: string | null; grund: string | null })[]) {
        const k = String(protokoll_id);
        antworten.set(k, [...(antworten.get(k) ?? []), x]);
      }
    }
    const zeilen = liste.map(({ inhalt, w_art, w_hinweis, ...p }) => {
      // ob (und warum nicht) erneut gesendet werden kann – gleich welcher Status, ohne den gespeicherten Inhalt zu laden
      const sperre = erneutSperre(inhalt ? (w_art ? { wiederholung: { art: w_art, hinweis: w_hinweis ?? '' } } : { mail: true }) : null);
      return { ...p, person: personenText(p.an, index), erneut: !sperre, erneut_hinweis: sperre, erneut_neuer_link: !!w_art && w_art !== 'NEU_AUSLOESEN',
               cc: kopieAn(p, req.user!.email), antworten: antworten.get(String(p.id)) ?? [] };
    }).filter((z) => passt(f.suche, [z.person, z.an, z.objekt, z.anwendung, z.betreff, z.absender, z.von, z.benutzer, z.fehler,
      ...z.antworten.flatMap((a) => [a.art, a.von, a.grund])]));
    const anwendungen = (await sql`select distinct anwendung from core.mail_protokoll where anwendung is not null order by 1`).map((r) => r.anwendung as string);
    return { zeilen, anwendungen, gekuerzt };
  });

  /**
   * Rückmeldung zu einer gesendeten E-Mail verbuchen: n8n („TCO Maileingang“) meldet jede eingegangene Mail der Absender-Postfächer.
   * Ohne Anmeldung, aber nur mit dem Webhook-Schlüssel der Anbindung „E-Mail-Versand“ (derselbe Header wie zum Senden, z. B. X-TCO-Key).
   */
  app.post('/api/mail/eingang', async (req, reply) => {
    const erwartet = Object.entries(authHeader(await mailVerbindung()));
    if (!erwartet.length) return reply.code(403).send({ message: 'Für den Maileingang muss an der Anbindung „E-Mail-Versand“ ein Webhook-Schlüssel hinterlegt sein.' });
    const ok = erwartet.every(([name, wert]) => gleich(String(req.headers[name.toLowerCase()] ?? ''), wert));
    if (!ok) return reply.code(403).send({ message: 'Webhook-Schlüssel fehlt oder ist falsch.' });
    return eingangVerbuchen(DB, eingang.parse(req.body));
  });

  /** App „E-Mail-Protokoll“: E-Mail einer Zeile erneut senden (auch bereits gesendete) – der Absender der ersten E-Mail erhält eine Kopie (CC) */
  app.post('/api/mail/uebersicht/:id/erneut', { preHandler: requireAuth(P_SENDEN) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const wer = req.user!.displayName || req.user!.username;
    const [p] = await sql`select von, absender from core.mail_protokoll where id = ${id}`;
    if (!p) throw new BusinessError('Den Protokolleintrag gibt es nicht (mehr).', 404);
    const cc = kopieAn({ von: p.von as string | null, absender: p.absender as string | null }, req.user!.email);
    return change(req, (tx) => mailErneutSenden(tx, id, wer, { wiederholen, folge }, cc),
      { action: 'MAIL_ERNEUT', reason: `E-Mail-Protokoll ${id}${cc ? `, Kopie an ${cc}` : ''}` });
  });

  /** fehlgeschlagene E-Mail erneut senden (Zugangslinks werden dabei neu erzeugt) */
  app.post('/api/mail/protokoll/:id/erneut', { preHandler: requireAuth(P) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const wer = req.user!.displayName || req.user!.username;
    return change(req, (tx) => mailWiederholen(tx, id, wer, { wiederholen, folge }), { action: 'MAIL_ERNEUT', reason: `Mailprotokoll ${id}` });
  });

  app.post('/api/mail/test', { preHandler: requireAuth(P) }, async (req) => {
    const { an } = z.object({ an: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben.') }).parse(req.body);
    const org = String((await getSettings(['org.name']))['org.name'] ?? 'Portal');
    const wer = req.user!.displayName || req.user!.username;
    const r = await mailSenden({
      modus: 'senden', anwendung: 'Test', objekt: 'TESTMAIL', an, benutzer: wer, anhaenge: [],
      betreff: `${org}: Testmail aus dem Portal`,
      text: `Diese Testmail wurde von ${wer} im Portal ausgelöst (Administration → Schnittstellen → Anbindungen).\n\nWenn sie ankommt, funktioniert der Versand über n8n.`,
    });
    if (r.status === 'fehler') throw new BusinessError(`n8n meldet einen Fehler: ${r.fehler ?? 'unbekannt'}`);
    return { text: `Testmail an ${an} übergeben (${r.status}${r.von ? `, Absender ${r.von}` : ''}${r.hinweis ? ` – ${r.hinweis}` : ''}).` };
  });
}
