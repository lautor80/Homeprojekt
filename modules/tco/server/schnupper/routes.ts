import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import { DB, vereinLesen } from '../verein.js';
import { mailSenden } from '../kommunikation.js';
import {
  anmeldungAnlegen, beitrittVorbelegung, EINHEITEN_KOSTENLOS, schnupperInfo, schnupperLesen, schnupperSichern, STATUS, STUFEN, TAGE, ZEITEN,
  type SchnupperStatus, type Stufe,
} from './logik.js';

/**
 * Schnuppertraining (#86): öffentlich /api/m/tco/schnupper (Formular /schnuppertraining), Verwaltung für Trainer unter
 * /api/m/tco/schnuppertraining (eigene Rechte – ohne Zugriff auf den übrigen Mitgliederstamm).
 */
export const P_SCHNUPPER = { display: 'tco.schnupper:display', edit: 'tco.schnupper:edit' };

const txt = (max: number) => z.string().trim().max(max);
const anmeldungSchema = z.object({
  vorname: txt(60).min(1, 'Bitte den Vornamen angeben.'), nachname: txt(60).min(1, 'Bitte den Nachnamen angeben.'),
  alter: z.coerce.number({ invalid_type_error: 'Bitte das Alter angeben.' }).int('Bitte das Alter in Jahren angeben.'),
  gespielt: z.boolean(),
  stufe: z.enum(Object.keys(STUFEN) as [Stufe, ...Stufe[]], { errorMap: () => ({ message: 'Bitte die Spielstärke wählen.' }) }),
  email: txt(120).nullish(), mobil: txt(40).nullish(),
  termine: z.object({
    tage: z.array(z.enum(TAGE)).max(7).default([]),
    zeiten: z.array(z.enum(ZEITEN)).max(3).default([]),
    text: txt(500).nullish(),
  }),
  erziehungsberechtigt: txt(120).nullish(),
  mitteilung: txt(1000).nullish(),
  einwilligung: z.boolean(),
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
  if (cur.n > max) throw new BusinessError('Zu viele Anmeldungen von dieser Verbindung. Bitte später erneut versuchen.', 429);
}

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const pAdr = z.object({ adrnr: z.string().regex(/^[0-9]{1,10}$/) });

export async function schnupperRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ öffentlich (ohne Anmeldung)
  app.get('/schnupper', async () => schnupperInfo((await vereinLesen()).name));

  app.post('/schnupper', async (req) => {
    limit(req.ip, 10);
    const b = anmeldungSchema.parse(req.body);
    if (b.website) return { nummer: 'ST', text: 'Vielen Dank für deine Anmeldung.' };   // Bot: still verwerfen
    const { website: _w, ...d } = b;
    const r = await withChange({ userId: null, username: 'Online-Schnuppertraining', action: 'SCHNUPPER_ANMELDUNG' },
      (tx) => anmeldungAnlegen(tx, d, req.ip));
    req.log.info({ schnupper: r.nummer, ip: req.ip }, 'Anmeldung Schnuppertraining eingegangen');
    // Eingangsbestätigung (nicht kritisch)
    if (d.email) {
      try {
        const v = await vereinLesen();
        if (v.n8n_mail_url) {
          await mailSenden(v, {
            modus: 'senden', anwendung: 'Schnuppertraining', objekt: r.nummer, an: d.email, benutzer: 'Online-Schnuppertraining', anhaenge: [],
            betreff: `${v.name}: Deine Anmeldung zum Schnuppertraining (${r.nummer})`,
            text: `Hallo ${d.erziehungsberechtigt || d.vorname},\n\nvielen Dank für die Anmeldung${d.erziehungsberechtigt ? ` von ${d.vorname} ${d.nachname}` : ''} zum Schnuppertraining.\n\n`
              + `Wir bieten ${EINHEITEN_KOSTENLOS} Einheiten Schnuppertraining kostenlos an. Einer unserer Vereinstrainer meldet sich in den nächsten Tagen, `
              + 'um einen Termin abzustimmen. Danach bieten wir gerne an, einer Trainingsgruppe beizutreten.\n\n'
              + 'Die Kontaktdaten nutzen wir nur für die Kontaktaufnahme zum Schnuppertraining.\n\n'
              + `Viele Grüße\n${v.name}`,
          });
        }
      } catch (e) { req.log.warn({ schnupper: r.nummer, err: (e as Error).message }, 'Schnuppertraining: Eingangsbestätigung nicht gesendet'); }
    }
    return {
      nummer: r.nummer,
      text: `Vielen Dank! Deine Anmeldung ${r.nummer} ist eingegangen. Einer unserer Vereinstrainer meldet sich bei dir${d.email ? ' – eine Bestätigung kommt per E-Mail' : ''}.`,
    };
  });

  /** Vorbelegung des Mitgliedsantrags über den Beitrittslink */
  app.get('/schnupper/beitritt', async (req) => {
    const { token } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Der Link ist ungültig.') }).parse(req.query);
    limit(req.ip, 60);
    return beitrittVorbelegung(DB, token);
  });

  // ------------------------------------------------------------------ Verwaltung (Trainer)
  app.get('/schnuppertraining', { preHandler: requireAuth(P_SCHNUPPER.display) }, async (req) => {
    const q = z.object({ filter: z.enum(['OFFEN', 'ALLE']).default('OFFEN') }).parse(req.query);
    return { status: STATUS, stufen: STUFEN, einheiten: EINHEITEN_KOSTENLOS, zeilen: await schnupperLesen(DB, q.filter) };
  });

  app.put('/schnuppertraining/:adrnr', { preHandler: requireAuth(P_SCHNUPPER.edit) }, async (req) => {
    const { adrnr } = pAdr.parse(req.params);
    const b = z.object({
      status: z.enum(Object.keys(STATUS) as [SchnupperStatus, ...SchnupperStatus[]]),
      einheit1: datum.nullish(), einheit2: datum.nullish(), trainer: txt(120).nullish(), notiz: txt(2000).nullish(),
    }).parse(req.body);
    const wer = req.user!.displayName || req.user!.username;
    const text = await change(req, (tx) => schnupperSichern(tx, adrnr, b, wer), { action: 'SCHNUPPER_BEARBEITEN', reason: adrnr });
    return { text };
  });

  /** Beitrittslink: Mitgliedsantrag mit vorbelegten Angaben – per E-Mail an den Schnupperer, Link zusätzlich zurück (z. B. für WhatsApp) */
  app.post('/schnuppertraining/:adrnr/beitrittslink', { preHandler: requireAuth(P_SCHNUPPER.edit) }, async (req) => {
    const { adrnr } = pAdr.parse(req.params);
    const { mail } = z.object({ mail: z.boolean().default(true) }).parse(req.body ?? {});
    const [s] = await DB`select s.nummer, s.token, s.status, s.erziehungsberechtigt, m.vorname, m.nachname, m.email, m.eintritt
                           from tco.schnupper s join tco.mitglieder m on m.adrnr = s.adrnr where s.adrnr = ${adrnr}`;
    if (!s) throw new BusinessError('Schnupper-Anmeldung nicht gefunden.', 404);
    if (s.status === 'MITGLIED' || s.status === 'ABGESAGT' || s.eintritt) throw new BusinessError(`${s.nummer}: Für diesen Status wird kein Beitrittslink mehr versendet.`);
    const url = await portalUrl();
    if (!url) throw new BusinessError('Die Portal-Adresse ist nicht eingerichtet (Administration → Einstellungen) – der Link kann nicht erzeugt werden.');
    const link = `${url}/beitritt?schnupper=${s.token}`;
    const wer = req.user!.displayName || req.user!.username;
    if (!mail) return { link, text: 'Beitrittslink erzeugt.' };
    if (!s.email) return { link, text: 'Keine E-Mail-Adresse hinterlegt – bitte den Link anders weitergeben (z. B. WhatsApp).' };
    const v = await vereinLesen();
    if (!v.n8n_mail_url) return { link, text: 'Der Mailversand ist nicht eingerichtet – bitte den Link anders weitergeben.' };
    await mailSenden(v, {
      modus: 'senden', anwendung: 'Schnuppertraining', objekt: s.nummer, an: s.email, benutzer: wer, anhaenge: [],
      betreff: `${v.name}: Jetzt Mitglied werden`,
      text: `Hallo ${s.erziehungsberechtigt || s.vorname},\n\nschön, dass ${s.erziehungsberechtigt ? `${s.vorname}` : 'du'} beim Schnuppertraining dabei ${s.erziehungsberechtigt ? 'war' : 'warst'}! `
        + 'Wenn es gefallen hat, geht die Anmeldung als Mitglied (und zu einer Trainingsgruppe) ganz einfach – die bekannten Angaben sind schon eingetragen:\n\n'
        + `${link}\n\nViele Grüße\n${v.name}`,
    });
    return { link, text: `Beitrittslink an ${s.email} gesendet.` };
  });
}
