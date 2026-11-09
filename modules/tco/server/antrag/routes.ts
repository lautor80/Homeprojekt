import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, vereinLesen } from '../verein.js';
import { mailSenden } from '../kommunikation.js';
import { bankSchutz } from '../bankdaten.js';
import { antragAblehnen, antragAnlegen, antraegeLesen, antragInfo, MAX_PERSONEN, uebernehmen } from './logik.js';

/**
 * Mitgliedsantrag online (#12): öffentlich /api/m/tco/antrag (Formular /beitritt), Verwaltung unter
 * /api/m/tco/mitgliedsantraege (Prüfen, Ablehnen, Übernehmen). Benachrichtigung des Kassenwarts über den Arbeitsvorrat.
 */
export const P_ANTRAG = { display: 'tco.antraege:display', edit: 'tco.antraege:edit' };

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const txt = (max: number) => z.string().trim().max(max);
const antragSchema = z.object({
  personen: z.array(z.object({
    anrede: z.enum(['Herr', 'Frau', 'Divers'], { errorMap: () => ({ message: 'Bitte die Anrede wählen.' }) }),
    vorname: txt(60).min(1, 'Bitte den Vornamen angeben.'), nachname: txt(60).min(1, 'Bitte den Nachnamen angeben.'),
    geburtsdatum: datum, email: txt(120).nullish(), telefon: txt(40).nullish(), mobil: txt(40).nullish(),
    art: txt(10).min(1, 'Bitte eine Mitgliedschaft wählen.'),
  })).min(1).max(MAX_PERSONEN),
  strasse: txt(80), plz: txt(10), ort: txt(60),
  email: txt(120), telefon: txt(40).nullish(),
  erziehungsberechtigt: txt(120).nullish(),
  eintritt: datum,
  satzung: z.boolean(), datenschutz: z.boolean(), bildrechte: z.boolean().default(false),
  bemerkung: txt(1000).nullish(),
  bank: z.object({ kontoinhaber: txt(120), iban: txt(40), bic: txt(15).nullish(), bank: txt(80).nullish(), sepa: z.boolean() }),
  /** Honigtopf gegen Bots – muss leer bleiben */
  website: z.string().max(200).optional(),
});

const versuche = new Map<string, { n: number; bis: number }>();
function limit(ip: string, max: number) {
  const jetzt = Date.now();
  const v = versuche.get(ip);
  const cur = v && v.bis > jetzt ? v : { n: 0, bis: jetzt + 60 * 60_000 };
  cur.n++;
  versuche.set(ip, cur);
  if (cur.n > max) throw new BusinessError('Zu viele Anträge von dieser Verbindung. Bitte später erneut versuchen.', 429);
}

export async function antragRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ öffentlich (ohne Anmeldung)
  app.get('/antrag', async () => antragInfo(DB, await vereinLesen()));

  app.post('/antrag', async (req) => {
    limit(req.ip, 5);
    const b = antragSchema.parse(req.body);
    if (b.website) return { nummer: 'MA', text: 'Vielen Dank für Ihren Antrag.' };   // Bot: still verwerfen
    const { bank, website: _w, ...d } = b;
    const r = await withChange({ userId: null, username: 'Online-Antrag', action: 'MITGLIEDSANTRAG' },
      (tx) => antragAnlegen(tx, { ...d, bildrechte: d.bildrechte ?? false }, { ...bank, bic: bank.bic ?? null, bank: bank.bank ?? null }, req.ip));
    req.log.info({ antrag: r.nummer, ip: req.ip }, 'Mitgliedsantrag eingegangen');
    // Eingangsbestätigung (nicht kritisch)
    try {
      const v = await vereinLesen();
      if (v.n8n_mail_url) {
        const p = d.personen[0];
        await mailSenden(v, {
          modus: 'senden', anwendung: 'Mitgliedsantrag', objekt: r.nummer, an: d.email, benutzer: 'Online-Antrag', anhaenge: [],
          betreff: `${v.name}: Ihr Mitgliedsantrag ${r.nummer} ist eingegangen`,
          text: `Guten Tag ${d.erziehungsberechtigt || `${p.vorname} ${p.nachname}`},\n\nvielen Dank für Ihren Mitgliedsantrag `
            + `(${d.personen.map((x) => `${x.vorname} ${x.nachname}`).join(', ')}). Ihre Antragsnummer: ${r.nummer}.\n\n`
            + 'Der Vorstand prüft den Antrag. Nach der Aufnahme erhalten Sie eine Bestätigung und die Zugangsdaten zum Mitgliederportal per E-Mail.\n\n'
            + `Viele Grüße\n${v.name}`,
        });
      }
    } catch (e) { req.log.warn({ antrag: r.nummer, err: (e as Error).message }, 'Mitgliedsantrag: Eingangsbestätigung nicht gesendet'); }
    return { nummer: r.nummer, text: `Vielen Dank! Ihr Antrag ${r.nummer} ist eingegangen. Sie erhalten eine Bestätigung per E-Mail; nach der Prüfung durch den Vorstand folgen Aufnahme und Zugangsdaten.` };
  });

  // ------------------------------------------------------------------ Verwaltung
  app.get('/mitgliedsantraege', { preHandler: requireAuth(P_ANTRAG.display) }, async (req) => {
    const q = z.object({ status: z.enum(['EINGANG', 'ALLE']).default('EINGANG') }).parse(req.query);
    const sb = bankSchutz(req);
    return (await antraegeLesen(DB, q.status)).map((a) => ({ ...a, iban: sb.iban(a.iban), bic: sb.bic(a.bic), kontoinhaber: sb.text(a.kontoinhaber) }));
  });

  app.post('/mitgliedsantraege/:id/uebernehmen', { preHandler: requireAuth(P_ANTRAG.edit) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ eintritt: datum.nullish(), mail: z.boolean().default(true) }).parse(req.body ?? {});
    const v = await vereinLesen();
    const wer = req.user!.displayName || req.user!.username;
    const r = await change(req, (tx) => uebernehmen(tx, v, id, wer, { eintritt: b.eintritt ?? null, mail: b.mail }), { action: 'MITGLIEDSANTRAG_UEBERNAHME', reason: String(id) });
    // Aufnahmebestätigung an den Antragsteller (Zugangslinks kommen je Person separat)
    if (b.mail && v.n8n_mail_url) {
      await mailSenden(v, {
        modus: 'senden', anwendung: 'Mitgliedsantrag', objekt: r.nummer, an: r.email, benutzer: wer, anhaenge: [],
        betreff: `${v.name}: Willkommen im Verein – Ihr Antrag ${r.nummer} ist angenommen`,
        text: `Guten Tag ${r.name},\n\nherzlich willkommen! Ihr Mitgliedsantrag ${r.nummer} wurde angenommen.\n\n`
          + r.mitglieder.map((m) => `${m.name}: Mitgliedsnummer ${m.mitglnrn}`).join('\n')
          + (r.mandat ? `\n\nDer Beitrag wird per SEPA-Lastschrift eingezogen (Mandatsreferenz ${r.mandat}).` : '')
          + '\n\nDie Zugänge zum Mitgliederportal erhalten Sie in separaten E-Mails.\n\nViele Grüße\n' + v.name,
      }).catch((e) => req.log.warn({ antrag: r.nummer, err: (e as Error).message }, 'Aufnahmebestätigung nicht gesendet'));
    }
    return {
      ...r,
      text: `Antrag ${r.nummer} übernommen: ${r.mitglieder.map((m) => `${m.name} (Nr. ${m.mitglnrn})`).join(', ')}`
        + `${r.mandat ? `, SEPA-Mandat ${r.mandat}` : ''}; ${r.benutzer.filter((x) => x.username).length} Benutzer angelegt.`,
    };
  });

  app.post('/mitgliedsantraege/:id/ablehnen', { preHandler: requireAuth(P_ANTRAG.edit) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ grund: z.string().trim().max(1000).nullish(), mail: z.boolean().default(true) }).parse(req.body ?? {});
    const wer = req.user!.displayName || req.user!.username;
    const r = await change(req, (tx) => antragAblehnen(tx, id, wer, b.grund || null), { action: 'MITGLIEDSANTRAG_ABLEHNUNG', reason: String(id) });
    let zusatz = '';
    if (b.mail) {
      try {
        const v = await vereinLesen();
        if (v.n8n_mail_url) {
          await mailSenden(v, {
            modus: 'senden', anwendung: 'Mitgliedsantrag', objekt: r.nummer, an: r.email, benutzer: wer, anhaenge: [],
            betreff: `${v.name}: Ihr Mitgliedsantrag ${r.nummer}`,
            text: `Guten Tag ${r.name},\n\nIhr Mitgliedsantrag ${r.nummer} konnte leider nicht angenommen werden.`
              + (b.grund ? `\n\nBegründung: ${b.grund}` : '') + `\n\nBei Fragen wenden Sie sich bitte an den Vorstand.\n\nViele Grüße\n${v.name}`,
          });
          zusatz = ' Antragsteller per E-Mail benachrichtigt.';
        }
      } catch (e) { zusatz = ` (E-Mail nicht gesendet: ${(e as Error).message})`; }
    }
    return { text: `Antrag ${r.nummer} abgelehnt.${zusatz}` };
  });
}
