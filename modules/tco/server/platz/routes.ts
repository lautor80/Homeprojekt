import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth, sha256 } from '../../../../server/src/auth.js';
import { withChange } from '../../../../server/src/db.js';
import { appAktiv } from '../../../../server/src/funktionsschalter.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import { schnellwegPruefen } from '../mitglieder/einladung.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { randomBytes } from 'node:crypto';
import { DB, type Db, type Verein } from '../verein.js';
import { addTage } from '../format.js';
import {
  aboAnlegen, aboBeenden, massenAendern, abosLesen, aboVorschau, belegungLesen, benutzerListe, benutzerZuordnen, einzelAendern, einzelAnlegen,
  einzelStornieren, aboTerminStornieren, hhmm, ichLesen, jetzt, meineLesen, platzLesen, platzLoeschen, plaetzeLesen, platzSpeichern, preisVon, regelnPruefen,
  tagLesen, verwaltungAendern, verwaltungKopieren, verwaltungStornieren, ARTEN, type Ich,
} from './logik.js';
import { minuten, preiseLesen, preiswoche, preiszonen } from '../halle/preis.js';
import { RHYTHMEN, serieBuchen, verfuegbarkeit } from './serie.js';
import {
  ablehnen, benutzernameFrei, bestaetigen, bestandFinden, emailBestaetigen, EMAIL_STUNDEN, geschlechtVon, ROLLE, ROLLE_MITGLIED, ep3Abgleich, ep3Anlegen, ep3BenutzerAnlegen, ep3Mitglied, ep3Verknuepfen, registrieren, registrierungenLesen, rolleSicherstellen,
} from './registrierung.js';
import { vereinLesen } from '../verein.js';
import { BELEGUNG_ARTEN, festeLesen, festeLoeschen, festeSpeichern } from './belegungen.js';
import { mailProtokoll, mailSenden } from '../kommunikation.js';
import { tcoHinweis } from '../hinweise.js';
import { mailFehlerErledigen, abweisen, aboLauf, aktion, bewerben, freigeben, rasterLesen, saisonAendern, saisonEroeffnen, verwaltungLesen } from './abowunsch.js';

/**
 * Platzbuchung (Freiplätze und Halle).
 *
 * „Platz buchen“ (tco.platzbuchung:edit): Das Mitglied wird AUSSCHLIESSLICH aus dem angemeldeten Benutzer
 * ermittelt (tco.mitgliedera.benutzer_id). Eigene Buchungen mit Preis anzeigen, anlegen, ändern, stornieren;
 * fremde Buchungen erscheinen nur als „belegt“ (ohne Name, Nummer, Text). Abos sind nur lesbar.
 *
 * „Platzverwaltung“ (tco.platz:admin): Plätze und Buchungsregeln, Belegung mit Namen, Abos, Benutzerzuordnung.
 *
 * „Platz buchen“ für Admin/Hallenwart (tco.platzbuchung:verwalten, #11): Namen der Buchenden sehen, für ein anderes
 * Mitglied bzw. vereinsintern buchen und Training, Schnuppertraining, Sperrzeiten, Veranstaltungen direkt im Kalender eintragen.
 */
import { hatSchluessel, HALLE_HINWEIS } from './schluessel.js';
import { paperless, plAktiv } from '../verein.js';

export const P_PLATZ = { buchen: 'tco.platzbuchung:edit', admin: 'tco.platz:admin', serie: 'tco.platz:serie', verwalten: 'tco.platzbuchung:verwalten' };

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const uhr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Uhrzeit im Format HH:MM');
const buchung = z.object({ platz_id: z.coerce.number().int().positive(), datum, von: uhr, bis: uhr, text: z.string().max(200).nullish() });
const platz = z.object({
  name: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben.').max(60),
  art: z.enum(['HALLE', 'FREI']),
  aliase: z.string().max(300).default(''),
  sort: z.coerce.number().int().default(0),
  gueltig_von: datum,
  gueltig_bis: datum.default('9999-12-31'),
  wochentage: z.string().regex(/^[1-7]{1,7}$/, 'Bitte mindestens einen Wochentag wählen.'),
  zeit_von: uhr, zeit_bis: uhr,
  raster: z.coerce.number().refine((x) => [15, 30, 60].includes(x), 'Zeitraster 15, 30 oder 60 Minuten'),
  dauer_min: z.coerce.number().int().min(15).max(1440),
  dauer_max: z.coerce.number().int().min(15).max(1440),
  vorlauf_min: z.coerce.number().int().min(0).max(24 * 14),
  vorlauf_max: z.coerce.number().int().min(0).max(400),
  storno_frist: z.coerce.number().int().min(0).max(24 * 14),
  max_offen: z.coerce.number().int().min(0).max(100),
  abrechnen: z.boolean(),
  aktiv: z.boolean(),
  hinweis: z.string().max(500).nullish().transform((x) => x ?? null),
});
const abo = z.object({
  platz_id: z.coerce.number().int().positive(), adrnr: z.string().min(1, 'Bitte ein Mitglied wählen.'),
  ab: datum, bis_datum: datum, von: uhr, bis: uhr, text: z.string().max(200).nullish(),
});

/** Mitglied des angemeldeten Benutzers – sonst 403 */
async function ich(req: FastifyRequest): Promise<Ich> {
  const id = req.user?.id;
  if (!id) throw new BusinessError('Bitte mit einem persönlichen Benutzer anmelden.', 403);
  const i = await ichLesen(DB, id);
  if (!i) throw new BusinessError('Ihr Benutzer ist keinem Mitglied zugeordnet. Bitte beim Vorstand melden (Zuordnung unter Tennishalle → Platzverwaltung → Benutzer).', 403);
  return i;
}

const serieAnfrage = z.object({
  ab: datum, bis_datum: datum.nullish(), von: uhr, bis: uhr,
  rhythmus: z.enum(['EINMALIG', 'WOECHENTLICH', 'ZWEIWOECHENTLICH', 'MONATLICH']),
  anzahl: z.coerce.number().int().min(1).max(20),
  art: z.enum(['HALLE', 'FREI']).nullish(),
  plaetze: z.array(z.coerce.number().int().positive()).default([]),
});

/** Registrierung: Schutz gegen Massenanmeldungen und Kennwort-Raten je IP */
const regVersuche = new Map<string, { n: number; bis: number }>();
function regLimit(ip: string, max: number) {
  const jetztMs = Date.now();
  const v = regVersuche.get(ip);
  const cur = v && v.bis > jetztMs ? v : { n: 0, bis: jetztMs + 60 * 60_000 };
  cur.n++;
  regVersuche.set(ip, cur);
  if (cur.n > max) throw new BusinessError('Zu viele Versuche. Bitte später erneut versuchen.', 429);
}

const registrierung = z.object({
  benutzername: z.string().trim().min(3, 'Benutzername: mindestens 3 Zeichen').max(50).regex(/^[a-zA-Z0-9._@+-]+$/, 'Benutzername: nur Buchstaben, Ziffern, . _ - @'),
  vorname: z.string().trim().min(1, 'Bitte den Vornamen angeben.').max(60),
  nachname: z.string().trim().min(1, 'Bitte den Nachnamen angeben.').max(60),
  email: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben.').max(120),
  telefon: z.string().trim().max(40).nullish(),
  nachricht: z.string().trim().max(500).nullish(),
  passwort: z.string().max(200).nullish(),
  ep3_konto: z.string().trim().max(120).nullish(),
  ep3_passwort: z.string().max(200).nullish(),
  datenschutz: z.literal(true, { errorMap: () => ({ message: 'Bitte der Verarbeitung der Daten zustimmen.' }) }),
  art: z.enum(['EXTERN', 'MITGLIED']).default('EXTERN'),
  anrede: z.enum(['Herr', 'Frau', 'Divers'], { errorMap: () => ({ message: 'Bitte die Anrede (Geschlecht) wählen.' }) }),
  strasse: z.string().trim().min(3, 'Bitte Straße und Hausnummer angeben.').max(80).regex(/\d/, 'Bitte die Hausnummer angeben.'),
  plz: z.string().trim().regex(/^\d{4,5}$/, 'Bitte eine gültige Postleitzahl angeben.'),
  ort: z.string().trim().min(2, 'Bitte den Ort angeben.').max(60),
  geburtsdatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Geburtsdatum im Format JJJJ-MM-TT').nullish(),
  mitgliedsnr: z.string().trim().max(20).nullish(),
});

/** Mitglieds-Registrierungen prüfen und freigeben (Kassenwart) */
export const P_REG = 'tco.registrierung:mitglied';
/** eigene Kontaktdaten externer Hallennutzer (Systemrolle HALLENNUTZER) */
export const P_MEINKONTO = 'tco.meinkonto:edit';

/** Benachrichtigung nach der Freischaltung (nicht kritisch) – Rückgabe: Zusatz für die Meldung */
async function freigabeMail(r: { email: string; anzeigename: string; ep3: boolean; rolle: string }, wer: string): Promise<string> {
  try {
    const v = await vereinLesen();
    if (!v.n8n_mail_url || !r.email) return '';
    const url = await portalUrl();
    const mitglied = r.rolle === ROLLE_MITGLIED;
    await mailSenden(v, {
      modus: 'senden', anwendung: 'Registrierung', objekt: 'REG', an: r.email, benutzer: wer, anhaenge: [],
      betreff: `${v.name}: Ihr Zugang ist freigeschaltet`,
      text: `Guten Tag ${r.anzeigename},\n\nIhr Zugang zum Portal ist freigeschaltet. Sie können sich jetzt${url ? ` unter ${url}` : ''} anmelden`
        + (r.ep3 ? ' – mit Ihrem gewählten Benutzernamen und Ihrem bisherigen EP3-Kennwort (sofern Sie kein neues gewählt haben).' : ' – mit Ihrem Benutzernamen und dem bei der Registrierung gewählten Kennwort.')
        + (mitglied ? '\n\nAls Mitglied sehen Sie unter „Meine Mitgliedschaft“ Ihre Daten, buchen Plätze und erfassen Ihren Clubhaus-Verzehr.' : '\n\nUnter „Platz buchen“ reservieren Sie Hallen- und Freiplätze.')
        + `\n\nViele Grüße\n${v.name}`,
    });
    return ' Benachrichtigung per E-Mail gesendet.';
  } catch (e) { return ` (E-Mail nicht gesendet: ${(e as Error).message})`; }
}

async function ablehnungMail(r: { email: string; anzeigename: string }, grund: string | null, wer: string): Promise<string> {
  try {
    const v = await vereinLesen();
    if (!v.n8n_mail_url || !r.email) return '';
    await mailSenden(v, {
      modus: 'senden', anwendung: 'Registrierung', objekt: 'REG', an: r.email, benutzer: wer, anhaenge: [],
      betreff: `${v.name}: Ihre Registrierung`,
      text: `Guten Tag ${r.anzeigename},\n\nIhre Registrierung konnte leider nicht freigeschaltet werden.`
        + (grund ? `\n\nBegründung: ${grund}` : '') + `\n\nBei Fragen wenden Sie sich bitte an den Verein.\n\nViele Grüße\n${v.name}`,
    });
    return ' Benachrichtigung per E-Mail gesendet.';
  } catch (e) { return ` (E-Mail nicht gesendet: ${(e as Error).message})`; }
}

/** Bestätigungslink an externe Hallennutzer (Registrierung und „Erneut senden“ im Mailprotokoll) */
async function bestaetigungsMail(v: Verein, url: string, r: { id: number; email: string; vorname: string; nachname: string; benutzername: string }, token: string, cc?: string) {
  await mailSenden(v, {
    modus: 'senden', anwendung: 'Registrierung', objekt: `REG-${r.id}`, an: r.email, cc: cc ?? '', benutzer: 'Portal', anhaenge: [],
    // der Link wird nie gespeichert: „Erneut senden“ erzeugt einen neuen
    wiederholung: { art: 'REG_BESTAETIGUNG', id: r.id },
    betreff: `${v.name}: Bitte bestätigen Sie Ihre Registrierung`,
    text: `Guten Tag ${r.vorname} ${r.nachname},\n\nvielen Dank für Ihre Registrierung (Benutzername ${r.benutzername}). `
      + `Bitte bestätigen Sie Ihre E-Mail-Adresse über diesen Link (${EMAIL_STUNDEN} Stunden gültig):\n\n${url}/registrierung-bestaetigen?token=${token}\n\n`
      + `Danach ist Ihr Zugang sofort freigeschaltet und Sie können Hallen- und Freiplätze buchen.\n\n`
      + `Haben Sie sich nicht registriert, ignorieren Sie diese E-Mail – ohne Bestätigung wird nichts angelegt.\n\nViele Grüße\n${v.name}`,
  });
}

/** Mailprotokoll → „Erneut senden“: neuer Bestätigungslink (der alte wird ungültig), solange die Registrierung auf die Bestätigung wartet */
export async function bestaetigungErneut(tx: Db, v: Verein, id: number, cc?: string): Promise<string> {
  const url = await portalUrl();
  if (!url) throw new BusinessError('Die Portal-Adresse fehlt (Administration → Einstellungen).');
  const [r] = await tx`select id, status, art, email_bestaetigt_am, email, vorname, nachname, benutzername from tco.registrierungen where id = ${id} for update`;
  if (!r) throw new BusinessError('Die Registrierung gibt es nicht mehr (unbestätigte werden nach 30 Tagen gelöscht).');
  // war der Link nicht zustellbar, wartet die Registrierung auf manuelle Freigabe (OFFEN) – sie geht zurück in die E-Mail-Bestätigung
  const wartet = r.status === 'EMAIL' || (r.status === 'OFFEN' && r.art === 'EXTERN' && !r.email_bestaetigt_am);
  if (!wartet) throw new BusinessError('Die Registrierung ist bereits bestätigt, freigegeben oder abgelehnt – ein Bestätigungslink ist nicht mehr nötig.');
  const token = randomBytes(32).toString('base64url');
  await tx`update tco.registrierungen set status = 'EMAIL', email_token_hash = ${sha256(token)}, email_bis = ${new Date(Date.now() + EMAIL_STUNDEN * 3600_000)} where id = ${id}`;
  await bestaetigungsMail(v, url, { id, email: r.email, vorname: r.vorname, nachname: r.nachname, benutzername: r.benutzername }, token, cc);
  return `Neuer Bestätigungslink an ${r.email} gesendet (${EMAIL_STUNDEN} Stunden gültig).`;
}

export async function platzRoutes(app: FastifyInstance) {
  const buchen = { preHandler: requireAuth(P_PLATZ.buchen) };
  const admin = { preHandler: requireAuth(P_PLATZ.admin) };
  // Rolle „Hallennutzer“ bei jedem Start auf den vorgesehenen Stand bringen (nur Einzelbuchung)
  await rolleSicherstellen(DB).catch((e) => app.log.error(e, 'Rolle HALLENNUTZER konnte nicht geprüft werden'));

  // ------------------------------------------------------------------ Registrierung (öffentlich, ohne Anmeldung)
  app.get('/platz/registrierung', async () => {
    const v = await vereinLesen();
    const [ep3] = await DB`select exists (select 1 from tco.kunden where pw_hash is not null) as ja`;
    return {
      verein: v.name, ep3: !!ep3?.ja, mitglied: true,
      hinweis: 'Vereinsmitglieder erhalten nach Prüfung durch den Verein Zugang zu Platzbuchung, Mitgliedsdaten und Verzehr. '
        + 'Externe Hallennutzer bestätigen ihre E-Mail-Adresse und können danach sofort Plätze buchen (Einzelbuchungen).',
    };
  });
  app.get('/platz/registrierung/frei', async (req) => {
    const { benutzername } = z.object({ benutzername: z.string().trim().min(3).max(50) }).parse(req.query);
    return { frei: await benutzernameFrei(DB, benutzername) };
  });
  /**
   * Registrierung in Schritten (#10), Schritt 2: Sind E-Mail (+ Geburtsdatum bei Mitgliedern) im Bestand bekannt? Bei einem Treffer
   * entfällt die Eingabe von Name und Anschrift. Zurück kommen nur Vorname und Anfangsbuchstabe des Nachnamens.
   */
  const bestandBody = z.object({
    art: z.enum(['EXTERN', 'MITGLIED']),
    email: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben.').max(120),
    geburtsdatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte das Geburtsdatum angeben.').nullish(),
  });
  app.post('/platz/registrierung/pruefen', async (req) => {
    regLimit(`${req.ip}|pruefen`, 20);   // eigenes Kontingent, damit die Suche die Registrierung nicht blockiert
    const b = bestandBody.parse(req.body);
    if (b.art === 'MITGLIED' && !b.geburtsdatum) throw new BusinessError('Bitte das Geburtsdatum angeben.');
    const t = await bestandFinden(DB, b.art, b.email, b.geburtsdatum);
    // kein Vorschlag für den Benutzernamen: er wird frei gewählt (und verriete sonst, ob die E-Mail schon als Anmeldename vergeben ist)
    return t ? { treffer: true, name: `${t.vorname} ${t.nachname.slice(0, 1)}.`.trim() } : { treffer: false };
  });
  app.post('/platz/registrierung', async (req) => {
    regLimit(req.ip, 15);
    // „ausBestand“: Name und Anschrift kommen aus dem Mitglieder- bzw. Kundenstamm (Treffer aus /pruefen, hier erneut geprüft)
    let zuidPerMail: string | null = null;
    let e: z.infer<typeof registrierung>;
    if ((req.body as { ausBestand?: unknown } | null)?.ausBestand === true) {
      const b = bestandBody.extend({
        benutzername: registrierung.shape.benutzername, passwort: z.string().min(1, 'Bitte ein Kennwort wählen.').max(200),
        datenschutz: registrierung.shape.datenschutz,
      }).parse(req.body);
      const t = await bestandFinden(DB, b.art, b.email, b.geburtsdatum);
      if (!t) throw new BusinessError('Die Angaben passen nicht mehr zu einem Eintrag im Verzeichnis. Bitte die Registrierung neu beginnen.');
      if (t.art === 'EXTERN') zuidPerMail = t.schluessel;
      e = {
        art: b.art, benutzername: b.benutzername, passwort: b.passwort, datenschutz: true, email: t.email, geburtsdatum: b.geburtsdatum ?? null,
        anrede: t.anrede as 'Herr', vorname: t.vorname, nachname: t.nachname, strasse: t.strasse, plz: t.plz, ort: t.ort, telefon: t.telefon,
      };
    } else {
      e = registrierung.parse(req.body);
    }
    if (!e.ep3_konto && !e.passwort) throw new BusinessError('Bitte ein Kennwort wählen oder das bestehende EP3-Konto angeben.');
    const v = await vereinLesen();
    const url = await portalUrl();
    const mail = !!v.n8n_mail_url && !!url;
    const r = await registrieren(DB, e, req.ip, { mail, zuidPerMail });
    req.log.info({ registrierung: r.id, art: r.art, benutzername: e.benutzername, ip: req.ip }, 'Registrierung eingegangen');
    if (!v.n8n_mail_url || !url) {
      // sichtbar im Mailprotokoll (Administration → Schnittstellen → Anbindungen): warum keine Bestätigungsmail kam
      await mailProtokoll({ anwendung: 'Registrierung', objekt: `REG-${r.id}`, an: e.email, betreff: 'Registrierung', status: 'nicht_gesendet',
        fehler: !v.n8n_mail_url ? 'n8n-Mailversand nicht eingerichtet (Webhook-URL fehlt)'
          : 'Portal-Adresse fehlt (Administration → Einstellungen) – keine E-Mail-Bestätigung möglich, Registrierung wartet auf manuelle Freigabe',
        benutzer: 'Registrierung' });
    }
    let text = r.text;
    try {
      if (r.token) {
        await bestaetigungsMail(v, url!, { id: r.id, email: e.email, vorname: e.vorname, nachname: e.nachname, benutzername: e.benutzername }, r.token);
      } else if (v.n8n_mail_url) {
        await mailSenden(v, {
          modus: 'senden', anwendung: 'Registrierung', objekt: `REG-${r.id}`, an: e.email, benutzer: 'Portal', anhaenge: [],
          betreff: `${v.name}: Ihre Registrierung ist eingegangen`,
          text: `Guten Tag ${e.vorname} ${e.nachname},\n\nvielen Dank für Ihre Registrierung (Benutzername ${e.benutzername}). `
            + (r.art === 'MITGLIED' ? 'Wir prüfen Ihre Mitgliedschaft' : 'Wir prüfen Ihre Angaben')
            + ' und benachrichtigen Sie, sobald Ihr Zugang freigeschaltet ist.\n\nViele Grüße\n' + v.name,
        });
      }
    } catch (err) {
      req.log.warn({ registrierung: r.id, err: (err as Error).message }, 'Registrierung: E-Mail nicht gesendet');
      if (r.token) {
        // Bestätigungslink nicht zustellbar: manuelle Freigabe wie bisher
        await DB`update tco.registrierungen set status = 'OFFEN', email_token_hash = null, email_bis = null where id = ${r.id}`;
        text = 'Vielen Dank! Ihre Registrierung wird vom Verein geprüft. Nach der Freigabe können Sie sich anmelden.';
      }
    }
    return { id: r.id, ep3: r.ep3, art: r.art, text };
  });
  /**
   * Schnellweg für Mitglieder: E-Mail + Geburtsdatum passen zu genau einem aktiven Mitglied ohne Benutzer → Einladungslink an die
   * beim Verein hinterlegte E-Mail (24 Std.). Der Besitz des Postfachs ersetzt die Prüfung durch den Kassenwart.
   */
  app.post('/platz/registrierung/schnell', async (req) => {
    regLimit(req.ip, 15);
    const b = z.object({ email: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben.').max(120), geburtsdatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte das Geburtsdatum angeben.') }).parse(req.body);
    const v = await vereinLesen();
    const treffer = await withChange({ userId: null, username: 'Registrierung', action: 'EINLADUNG' }, (tx) => schnellwegPruefen(tx, v, b.email, b.geburtsdatum));
    return treffer
      ? { treffer: true, text: `Wir haben Sie im Mitgliederverzeichnis gefunden und einen Link an ${b.email} gesendet (24 Stunden gültig). Darüber wählen Sie Benutzername und Kennwort – eine Freigabe durch den Verein ist nicht nötig.` }
      : { treffer: false, text: 'Zu dieser Kombination aus E-Mail und Geburtsdatum haben wir kein Mitglied ohne Zugang gefunden. Bitte registrieren Sie sich mit den vollständigen Angaben – der Verein prüft dann Ihre Mitgliedschaft.' };
  });
  /** Bestätigungslink aus der E-Mail: externe Registrierung freischalten (Rolle Hallennutzer) */
  app.post('/platz/registrierung/bestaetigen', async (req) => {
    regLimit(req.ip, 30);
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.body);
    const r = await withChange({ userId: null, username: 'Selbstregistrierung', action: 'REGISTRIERUNG_BESTAETIGT' }, async (tx) => {
      const x = await emailBestaetigen(tx, token);
      // Arbeitsvorrat (#232, V1): Der Zugang ist ohne Zutun des Vereins freigeschaltet – der Vorstand erfährt es hier
      await tcoHinweis(tx, {
        quelle: 'HN_NEU', objekt: x.benutzerId, bereich: 'Vorstand', recht: 'tco.platz:admin', art: 'Neuer Hallennutzer', icon: 'add-employee',
        titel: x.anzeigename, text: 'Hat sich selbst registriert und die E-Mail-Adresse bestätigt – der Zugang ist freigeschaltet.', pfad: '/tco/platzverwaltung',
      });
      return x;
    });
    await freigabeMail(r, 'Selbstregistrierung').catch(() => '');
    return { text: `Vielen Dank, Ihre E-Mail-Adresse ist bestätigt und Ihr Zugang freigeschaltet. Sie können sich jetzt mit Ihrem Benutzernamen anmelden.` };
  });

  // ------------------------------------------------------------------ Freigabe externer Registrierungen (Platzverwaltung)
  app.get('/platz/admin/registrierungen', admin, async (req) => {
    const q = z.object({ status: z.enum(['OFFEN', 'ALLE']).default('OFFEN') }).parse(req.query);
    return registrierungenLesen(DB, q.status, 'EXTERN');
  });
  app.post('/platz/admin/registrierungen/:id/bestaetigen', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({
      zuordnung: z.discriminatedUnion('art', [
        z.object({ art: z.literal('MITGLIED'), adrnr: z.string().min(1) }),
        z.object({ art: z.literal('EP3'), zuid: z.string().min(1) }),
        z.object({ art: z.literal('NEU') }),
      ]),
      bemerkung: z.string().max(500).nullish(),
    }).parse(req.body);
    const wer = req.user!.displayName || req.user!.username;
    const r = await change(req, (tx) => bestaetigen(tx, id, b, wer, { art: 'EXTERN' }), { action: 'REGISTRIERUNG_FREIGABE', reason: String(id) });
    return { text: r.text + await freigabeMail(r, wer) };
  });
  app.post('/platz/admin/registrierungen/:id/ablehnen', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ bemerkung: z.string().max(500).nullish() }).parse(req.body ?? {});
    const wer = req.user!.displayName || req.user!.username;
    const r = await change(req, (tx) => ablehnen(tx, id, b.bemerkung ?? null, wer, 'EXTERN'), { action: 'REGISTRIERUNG_ABLEHNUNG', reason: String(id) });
    return { text: r.text + await ablehnungMail(r, b.bemerkung ?? null, wer) };
  });

  // ------------------------------------------------------------------ Meine Daten (externe Hallennutzer, nur der eigene Kundenstammsatz)
  const meinkonto = { preHandler: requireAuth(P_MEINKONTO) };
  const eigenerKunde = async (uid: string) => (await DB`select zuid, zalias, vorname, nachname, strasse, plz, wohnort, email, telefonnummer, geschlecht
                                                          from tco.kunden where benutzer_id = ${uid} order by zalias limit 1`)[0] ?? null;
  /** eigene Stammdaten: Kundenstammsatz (externe) bzw. zugeordnetes Mitglied (Hallennutzer mit Mitgliedszuordnung) */
  const eigenesMitglied = async (uid: string) => (await DB`select m.adrnr, m.mitglnrn, m.anrede, m.geschlecht, m.vorname, m.nachname, m.strasse, m.plz, m.ort, m.email, m.telefon
                                                            from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = ${uid}`)[0] ?? null;
  const anredeAus = (g: unknown, anrede?: unknown) => {
    if (['Herr', 'Frau', 'Divers'].includes(String(anrede ?? ''))) return String(anrede);
    const x = String(g ?? '').toUpperCase();
    return ['M', '1'].includes(x) ? 'Herr' : ['W', 'F', '2'].includes(x) ? 'Frau' : x === 'D' ? 'Divers' : '';
  };
  app.get('/meinkonto', meinkonto, async (req) => {
    const uid = req.user!.id;
    const k = await eigenerKunde(uid);
    if (k) {
      return {
        quelle: 'KUNDE', benutzername: req.user!.username, kundennummer: k.zuid, anrede: anredeAus(k.geschlecht),
        vorname: k.vorname ?? '', nachname: k.nachname ?? '', strasse: k.strasse ?? '', plz: k.plz ?? '', ort: k.wohnort ?? '',
        email: (k.email ?? req.user!.email ?? '').trim(), telefon: k.telefonnummer ?? '',
      };
    }
    const m = await eigenesMitglied(uid);
    if (!m) throw new BusinessError('Ihrem Benutzer ist kein Kunden- oder Mitgliedsstammsatz zugeordnet. Bitte beim Verein melden.', 404);
    return {
      quelle: 'MITGLIED', benutzername: req.user!.username, kundennummer: m.mitglnrn || m.adrnr, anrede: anredeAus(m.geschlecht, m.anrede),
      vorname: m.vorname ?? '', nachname: m.nachname ?? '', strasse: m.strasse ?? '', plz: m.plz ?? '', ort: m.ort ?? '',
      email: (m.email ?? '').trim(), telefon: m.telefon ?? '',
    };
  });
  app.put('/meinkonto', meinkonto, async (req) => {
    const uid = req.user!.id;
    const d = z.object({
      anrede: registrierung.shape.anrede, vorname: registrierung.shape.vorname, nachname: registrierung.shape.nachname,
      strasse: registrierung.shape.strasse, plz: registrierung.shape.plz, ort: registrierung.shape.ort,
      email: registrierung.shape.email, telefon: z.string().trim().max(40).nullish(),
    }).parse(req.body);
    const k = await eigenerKunde(uid);
    const m = k ? null : await eigenesMitglied(uid);
    if (!k && !m) throw new BusinessError('Ihrem Benutzer ist kein Kunden- oder Mitgliedsstammsatz zugeordnet.', 404);
    await change(req, async (tx) => {
      if (k) {
        // nur der eigene Kunde (alle EP3-Aliasse derselben Kundennummer)
        await tx`update tco.kunden set vorname = ${d.vorname}, nachname = ${d.nachname}, strasse = ${d.strasse}, plz = ${d.plz}, wohnort = ${d.ort},
                                       email = ${d.email}, telefonnummer = ${d.telefon || null}, geschlecht = ${geschlechtVon(d.anrede)}
                  where zuid = ${k.zuid}`;
      } else {
        // nur das zugeordnete Mitglied – Kontaktdaten (Bank, Verträge, Kündigung: Meine Mitgliedschaft bzw. Verein)
        await tx`update tco.mitglieder set anrede = ${d.anrede}, geschlecht = ${d.anrede === 'Herr' ? '1' : d.anrede === 'Frau' ? '2' : null},
                                           vorname = ${d.vorname}, nachname = ${d.nachname}, strasse = ${d.strasse}, plz = ${d.plz}, ort = ${d.ort},
                                           email = ${d.email}, telefon = ${d.telefon || null}
                  where adrnr = ${m!.adrnr}`;
      }
      await tx`update core.users set email = ${d.email}, display_name = ${`${d.vorname} ${d.nachname}`} where id = ${uid}`;
      // Arbeitsvorrat (#232, V1): Kunde → Vorstand (Platzverwaltung), Mitglied → Kassenwart (Mitglieder)
      if (k) {
        await tcoHinweis(tx, {
          quelle: 'HN_KONTAKT', objekt: uid, bereich: 'Vorstand', recht: 'tco.platz:admin', art: 'Hallennutzer: Kontaktdaten geändert', icon: 'customer',
          titel: `${d.vorname} ${d.nachname}`, text: 'Name, Anschrift, E-Mail oder Telefon unter „Mein Konto“ geändert.', pfad: '/tco/platzverwaltung',
        });
      } else {
        await tcoHinweis(tx, {
          quelle: 'MG_KONTAKT', objekt: m!.adrnr, bereich: 'Kassenwart', recht: 'tco.mitglieder:display', art: 'Kontaktdaten geändert', icon: 'employee',
          titel: `${d.vorname} ${d.nachname} (Mitglied ${m!.adrnr})`, text: 'Name, Anschrift, E-Mail oder Telefon unter „Mein Konto“ geändert.', pfad: `/tco/mitglieder?adrnr=${m!.adrnr}`,
        });
      }
    }, { action: 'MEINE_DATEN' });
    return { text: 'Ihre Daten sind gespeichert.' };
  });

  // ------------------------------------------------------------------ Mitglieds-Registrierungen (Kassenwart)
  const kassenwart = { preHandler: requireAuth(P_REG) };
  app.get('/registrierungen/mitglieder', kassenwart, async (req) => {
    const q = z.object({ status: z.enum(['OFFEN', 'ALLE']).default('OFFEN') }).parse(req.query);
    return registrierungenLesen(DB, q.status, 'MITGLIED');
  });
  /** Auswahl: aktive Mitglieder ohne Benutzer */
  app.get('/registrierungen/mitglieder/kandidaten', kassenwart, async () => DB`
    select m.adrnr, trim(coalesce(m.nachname, '') || ', ' || coalesce(m.vorname, '')) as name, m.mitglnrn
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
     where m.eintritt is not null and (m.austritt is null or m.austritt >= current_date) and a.benutzer_id is null
     order by m.nachname, m.vorname`);
  app.post('/registrierungen/mitglieder/:id/freigeben', kassenwart, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({
      adrnr: z.string().min(1).nullish(),
      /** ohne Mitglied: als externer Hallennutzer freischalten */
      hallennutzer: z.boolean().default(false),
      bemerkung: z.string().max(500).nullish(),
    }).parse(req.body ?? {});
    if (!b.hallennutzer && !b.adrnr) throw new BusinessError('Bitte das Mitglied auswählen.');
    const wer = req.user!.displayName || req.user!.username;
    const r = await change(req, (tx) => bestaetigen(tx, id,
      { zuordnung: b.hallennutzer ? { art: 'NEU' } : { art: 'MITGLIED', adrnr: b.adrnr! }, bemerkung: b.bemerkung ?? null }, wer,
      { art: 'MITGLIED', rolle: b.hallennutzer ? ROLLE : ROLLE_MITGLIED }), { action: 'REGISTRIERUNG_FREIGABE', reason: String(id) });
    return { text: r.text + await freigabeMail(r, wer) };
  });
  app.post('/registrierungen/mitglieder/:id/ablehnen', kassenwart, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ bemerkung: z.string().max(500).nullish() }).parse(req.body ?? {});
    const wer = req.user!.displayName || req.user!.username;
    const r = await change(req, (tx) => ablehnen(tx, id, b.bemerkung ?? null, wer, 'MITGLIED'), { action: 'REGISTRIERUNG_ABLEHNUNG', reason: String(id) });
    return { text: r.text + await ablehnungMail(r, b.bemerkung ?? null, wer) };
  });

  // ------------------------------------------------------------------ EP3-Abgleich (Platzverwaltung)
  app.get('/platz/admin/ep3', admin, async () => ep3Abgleich(DB));
  app.post('/platz/admin/ep3/:zuid/verknuepfen', admin, async (req) => {
    const { zuid } = z.object({ zuid: z.string().min(1) }).parse(req.params);
    const b = z.object({ benutzer_id: z.string().uuid().nullish(), adrnr: z.string().min(1).nullish() }).parse(req.body ?? {});
    if (b.benutzer_id) return { text: await change(req, (tx) => ep3Verknuepfen(tx, zuid, b.benutzer_id!), { action: 'EP3_ZUORDNUNG', reason: zuid }) };
    if (b.adrnr) return { text: await change(req, (tx) => ep3Mitglied(tx, zuid, b.adrnr!), { action: 'EP3_ZUORDNUNG', reason: zuid }) };
    throw new BusinessError('Bitte einen Benutzer oder ein Mitglied wählen.');
  });
  app.post('/platz/admin/ep3/anlegen-alle', admin, async (req) => {
    const r = await change(req, (tx) => ep3BenutzerAnlegen(tx), { action: 'EP3_BENUTZER' });
    return { ...r, text: `${r.angelegt} Benutzer angelegt (${r.mitglieder} Mitgliedern zugeordnet${r.ohneKennwort ? `, ${r.ohneKennwort} ohne Kennwort` : ''}${r.uebersprungen ? `, ${r.uebersprungen} übersprungen` : ''}).${r.ohneBuchung ? ` ${r.ohneBuchung} Kunden ohne Buchung in den letzten 12 Monaten nicht übernommen.` : ''}` };
  });
  app.post('/platz/admin/ep3/:zuid/anlegen', admin, async (req) => {
    const { zuid } = z.object({ zuid: z.string().min(1) }).parse(req.params);
    return change(req, (tx) => ep3Anlegen(tx, zuid), { action: 'EP3_BENUTZER', reason: zuid });
  });

  // ------------------------------------------------------------------ Platz buchen (eigene Buchungen)
  app.get('/platz/tag', buchen, async (req) => {
    const i = await ich(req);
    const q = z.object({ datum }).parse(req.query);
    const j = jetzt();
    const verwalten = can(req, P_PLATZ.verwalten);
    return {
      datum: q.datum, heute: j.datum, jetzt: hhmm(j.min), ich: { name: i.name }, plaetze: await tagLesen(DB, q.datum, i, req.sitzung, verwalten),
      rechte: { verwalten },
      // Halle verschlossen (#11): Hinweis, wenn am Tag kein Hallenschlüssel ausgegeben ist
      hallenhinweis: (await hatSchluessel(DB, i.adrnr, q.datum)) ? null : HALLE_HINWEIS,
      // Preisklassen einer Einzelbuchung im Tagesverlauf (farbiger Strich neben der Uhrzeit)
      preiszonen: preiszonen(q.datum, await preiseLesen(DB)),
    };
  });

  /** Preisliste (Einzelbuchung) der Woche des Datums – zum Nachsehen aus „Platz buchen“, nur lesend */
  app.get('/platz/preisliste', buchen, async (req) => {
    const q = z.object({ datum }).parse(req.query);
    return { woche: preiswoche(q.datum, await preiseLesen(DB)) };
  });

  app.get('/platz/meine', buchen, async (req) => {
    const i = await ich(req);
    const q = z.object({ zeitraum: z.enum(['kommend', 'vergangen']).default('kommend') }).parse(req.query);
    return { ich: { name: i.name }, ...(await meineLesen(DB, i, q.zeitraum)) };
  });

  /**
   * Meine Hallenrechnungen (Platz buchen → Meine Buchungen → Rechnungen): Rechnungen des Mitglieds bzw. EP3-Kunden, jüngste zuerst.
   * Zuordnung wie bei den Buchungen: Adressnummer oder gleicher Kundenname. „Aktuell“ ist, was noch läuft: die noch nicht versendete
   * Rechnung („In Bearbeitung“) und offene; bezahlte und ausgebuchte sind „frühere“. Das PDF gibt es erst für gestellte Rechnungen.
   */
  const RG_STATUS: Record<string, string> = { '1': 'noch nicht versendet', '2': 'offen', '3': 'offen', '4': 'bezahlt', '5': 'teilbezahlt', '6': 'ausgebucht' };
  const meineRechnungen = async (i: { adrnr: string; kunde: string }, rgnr?: string, entwurf = false) => DB`
    select rgnr_txt as rgnr, jahr, betrag::float8 as betrag, status, coalesce(versendet, gedruckt, angelegt_am)::text as datum,
           bezahlt::text as bezahlt, doknr
      from tco.rgkopf
     where (${entwurf} or status <> '1') and (adrnr = ${i.adrnr} or (${i.kunde} <> '' and upper(trim(kunde)) = ${i.kunde}))
       ${rgnr ? DB`and rgnr_txt = ${rgnr}` : DB``}
     order by jahr desc, rgnr desc`;
  app.get('/platz/rechnungen', buchen, async (req) => {
    const i = await ich(req);
    const v = await vereinLesen();
    return {
      rechnungen: (await meineRechnungen(i, undefined, true)).map((r) => ({
        rgnr: r.rgnr as string, jahr: Number(r.jahr), betrag: Number(r.betrag), datum: r.datum as string | null, bezahlt: r.bezahlt as string | null,
        status: RG_STATUS[r.status as string] ?? 'offen', dokument: r.status !== '1' && !!r.doknr && plAktiv(v),
        aktuell: !['4', '6'].includes(r.status as string), entwurf: r.status === '1',
      })),
    };
  });
  /** Rechnung als PDF aus Paperless (jüngste Fassung) – nur eigene Rechnungen */
  app.get('/platz/rechnungen/:rgnr/pdf', buchen, async (req, reply) => {
    const { rgnr } = z.object({ rgnr: z.string().max(30) }).parse(req.params);
    const [r] = await meineRechnungen(await ich(req), rgnr);
    if (!r) throw new BusinessError('Rechnung nicht gefunden.', 404);
    const v = await vereinLesen();
    if (!r.doknr || !plAktiv(v)) throw new BusinessError('Zu dieser Rechnung ist kein Dokument abgelegt.', 404);
    const pl = paperless(v);
    const d = await pl.download(await pl.neuesteVersion(Number(r.doknr)));
    return reply.type(d.contentType).header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(`Rechnung_${rgnr}.pdf`)}`).send(d.data);
  });

  // ---- Abo-Bewerbung (#11): Bestätigung, Warteliste, Angebot – ändert nie eine Buchung; das Abo entsteht erst mit der Freigabe
  app.get('/platz/abowunsch', buchen, async (req) => rasterLesen(DB, await ich(req)));
  app.post('/platz/abowunsch', buchen, async (req) => {
    const i = await ich(req);
    const e = z.object({ platz_id: z.coerce.number().int().positive(), wochentag: z.coerce.number().int().min(1).max(7), von: uhr, bis: uhr }).parse(req.body);
    return { text: await change(req, (tx) => bewerben(tx, i, e), { action: 'ABO_BEWERBUNG', reason: `${e.wochentag} ${e.von}–${e.bis}` }) };
  });
  app.post('/platz/abowunsch/:id/:aktion', buchen, async (req) => {
    const i = await ich(req);
    const p = z.object({ id: z.coerce.number().int().positive(), aktion: z.enum(['bestaetigen', 'abgeben', 'zurueckziehen', 'annehmen', 'ablehnen']) }).parse(req.params);
    return { text: await change(req, (tx) => aktion(tx, i, p.id, p.aktion), { action: `ABO_${p.aktion.toUpperCase()}`, reason: String(p.id) }) };
  });
  const saison = z.object({
    name: z.string().trim().min(1, 'Bitte einen Namen für die Saison angeben.').max(60), von: datum, bis: datum, bestaetigen_bis: datum, nachruecken_ab: datum,
    annahme_tage: z.coerce.number().int().min(1).max(60).default(7),
    mail_pause_bis: datum.nullish().or(z.literal('').transform(() => null)),
  });
  app.get('/platz/admin/abosaison', admin, async () => verwaltungLesen(DB));
  app.post('/platz/admin/abosaison', admin, async (req) => {
    const e = saison.extend({ vorjahr_von: datum.nullish(), vorjahr_bis: datum.nullish(), mail: z.boolean().default(false) }).parse(req.body);
    return { text: await change(req, (tx) => saisonEroeffnen(tx, e), { action: 'ABO_SAISON', reason: e.name }) };
  });
  app.put('/platz/admin/abosaison/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const e = saison.parse(req.body);
    return { text: await change(req, (tx) => saisonAendern(tx, id, e), { action: 'ABO_SAISON', reason: e.name }) };
  });
  /** fällige Schritte sofort ausführen (läuft sonst stündlich von selbst) */
  app.post('/platz/admin/abosaison/lauf', admin, async (req) => {
    const o = z.object({ mail: z.boolean().default(false) }).parse(req.body ?? {});
    const r = await change(req, (tx) => aboLauf(tx, undefined, { mail: o.mail, manuell: true }), { action: 'ABO_LAUF' });
    return { ...r, text: `${r.erinnert} erinnert, ${r.verfallen} verfallen, ${r.angeboten} angeboten${o.mail ? '' : ' – ohne E-Mail'}.` };
  });
  app.post('/platz/admin/abowunsch/freigeben', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.body);
    return { text: await change(req, (tx) => freigeben(tx, id), { action: 'PLATZ_ABO', reason: `Abo-Wunsch ${id}` }) };
  });
  app.post('/platz/admin/abowunsch/abweisen', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.body);
    return { text: await change(req, (tx) => abweisen(tx, id), { action: 'ABO_ABGELEHNT', reason: String(id) }) };
  });
  app.post('/platz/admin/abowunsch/mail-erledigt', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive().nullish() }).parse(req.body ?? {});
    return { text: await change(req, (tx) => mailFehlerErledigen(tx, id ?? null), { action: 'ABO_MAIL_ERLEDIGT', reason: id ? String(id) : 'alle' }) };
  });
  // stündlich von selbst (nicht in Tests): Erinnerung, Verfall, Angebote
  if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
    setInterval(() => {
      if (!appAktiv('tco', 'Platz buchen')) return; // Funktionsschalter (#232, F1): abgeschaltete Apps laufen nicht von selbst
      withChange({ userId: null, username: 'system (Abo-Bewerbung)', action: 'ABO_LAUF' }, (tx) => aboLauf(tx)).catch((e) => app.log.warn(e, 'Abo-Lauf fehlgeschlagen'));
    }, 3_600_000).unref();
  }

  /** Preis und Regeln vorab prüfen (Buchungsdialog) */
  app.post('/platz/pruefen', buchen, async (req) => {
    await ich(req);
    const e = buchung.extend({ bid: z.string().nullish() }).parse(req.body);
    const p = await platzLesen(DB, e.platz_id);
    if (!p.aktiv) throw new BusinessError('Platz nicht gefunden.', 404);
    const von = minuten(e.von);
    const bis = e.bis === '24:00' ? 1440 : minuten(e.bis);
    let fehler = regelnPruefen({ platz: p, datum: e.datum, von, bis }, false);
    if (!fehler) {
      const b = (await belegungLesen(DB, [p], e.datum, e.datum, req.sitzung)).find((x) => (x.reserviert || x.bid !== e.bid) && x.von < bis && x.bis > von);
      if (b) fehler = b.fest ? `Von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr: ${b.fest.bezeichnung}.` : b.abo ? `Von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr für ein Abo reserviert.` : b.reserviert ? `Von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr wird gerade von jemand anderem gebucht.` : `Von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr bereits belegt.`;
    }
    return { fehler, preis: preisVon(p, e.datum, von, bis, '1', await preiseLesen(DB)) };
  });

  app.post('/platz/buchungen', buchen, async (req) => {
    const i = await ich(req);
    const e = buchung.parse(req.body);
    const r = await change(req, (tx) => einzelAnlegen(tx, i, e), { action: 'PLATZ_BUCHEN', reason: `${e.datum} ${e.von}–${e.bis}` });
    // Halle verschlossen (#11): ohne Hallenschlüssel am Tag den Hinweis an die Bestätigung hängen
    const [pl] = await DB`select art from tco.plaetze where id = ${e.platz_id}`;
    if (pl?.art === 'HALLE' && !(await hatSchluessel(DB, i.adrnr, e.datum))) return { ...r, hinweis: HALLE_HINWEIS };
    return r;
  });

  app.put('/platz/buchungen/:bid', buchen, async (req) => {
    const i = await ich(req);
    const { bid } = z.object({ bid: z.string().min(1) }).parse(req.params);
    const e = buchung.parse(req.body);
    return { text: await change(req, (tx) => einzelAendern(tx, i, bid, e), { action: 'PLATZ_AENDERN', reason: bid }) };
  });

  app.delete('/platz/buchungen/:bid', buchen, async (req) => {
    const i = await ich(req);
    const { bid } = z.object({ bid: z.string().min(1) }).parse(req.params);
    return { text: await change(req, (tx) => einzelStornieren(tx, i, bid), { action: 'PLATZ_STORNO', reason: bid }) };
  });

  /** #83: einzelnen Termin eines eigenen Abos mit Einzelabrechnung stornieren (Abo bleibt) */
  app.delete('/platz/buchungen/:bid/termine/:datum', buchen, async (req) => {
    const i = await ich(req);
    const { bid, datum } = z.object({ bid: z.string().min(1), datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.params);
    return { text: await change(req, (tx) => aboTerminStornieren(tx, i, bid, datum), { action: 'PLATZ_STORNO', reason: `Abo ${bid} ${datum}` }) };
  });

  // ------------------------------------------------------------------ Platz buchen für Admin/Hallenwart (#11)
  const verwalten = { preHandler: requireAuth(P_PLATZ.verwalten) };
  /** Mitglieder zur Auswahl „Buchung für …“ */
  app.get('/platz/verwalten/mitglieder', verwalten, async () => (await benutzerListe(DB)).mitglieder);
  /**
   * Einzelbuchung für ein Mitglied oder vereinsintern (ohne Rechnung) – wie die Serienbuchung „einmalig“; dazu Training,
   * Schnuppertraining, Sperrzeit oder Veranstaltung für einen Termin. Aus „Platz buchen“ (tco.platzbuchung:verwalten) und
   * aus der Belegung der Platzverwaltung (tco.platz:admin).
   */
  const fuerBuchen = (req: FastifyRequest) => {
    const e = buchung.extend({ adrnr: z.string().min(1).nullish(), intern: z.string().trim().max(60).nullish() }).parse(req.body);
    if (!e.adrnr && !e.intern) throw new BusinessError('Bitte ein Mitglied wählen oder einen Namen (vereinsintern) angeben.');
    return change(req, (tx) => serieBuchen(tx, {
      ab: e.datum, von: e.von, bis: e.bis, rhythmus: 'EINMALIG', anzahl: 1, plaetze: [e.platz_id],
      adrnr: e.adrnr ?? null, intern: e.adrnr ? null : e.intern ?? null, text: e.text ?? null, ueberspringen: false,
    }), { action: 'PLATZ_BUCHEN', reason: `${e.datum} ${e.von}–${e.bis} für ${e.adrnr ?? e.intern}` });
  };
  const festEintragen = (req: FastifyRequest) => {
    const e = buchung.extend({
      art: z.enum(['TRAINING', 'SCHNUPPER', 'SPERRE', 'VERANSTALTUNG']),
      bezeichnung: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben.').max(80),
    }).parse(req.body);
    return change(req, async (tx) => {
      const p = await platzLesen(tx, e.platz_id);
      const von = minuten(e.von);
      const bis = e.bis === '24:00' ? 1440 : minuten(e.bis);
      if (bis <= von) throw new BusinessError('Die Endzeit liegt vor der Startzeit.');
      const b = (await belegungLesen(tx, [p], e.datum, e.datum)).find((x) => x.von < bis && x.bis > von);
      if (b) {
        throw new BusinessError(`${p.name} ist am ${e.datum.split('-').reverse().join('.')} von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr bereits belegt`
          + `${b.fest ? ` („${b.fest.bezeichnung}“)` : b.reserviert ? ' (wird gerade gebucht)' : ` (${b.kunde || 'Buchung'})`}.`);
      }
      const wt = String(((new Date(`${e.datum}T12:00:00Z`).getUTCDay() + 6) % 7) + 1);
      return festeSpeichern(tx, null, {
        bezeichnung: e.bezeichnung, art: e.art, plaetze: [p.id], wochentage: wt, datum_von: e.datum, datum_bis: e.datum,
        zeit_von: e.von, zeit_bis: e.bis, hinweis: e.text?.trim() || null, aktiv: true,
      });
    }, { action: 'PLATZBELEGUNG' });
  };
  app.post('/platz/verwalten/buchung', verwalten, async (req) => fuerBuchen(req));
  app.post('/platz/verwalten/belegung', verwalten, async (req) => festEintragen(req));
  // Platzverwaltung → Belegung: freie Zeit anklicken und direkt eintragen (#11)
  app.post('/platz/admin/buchung', admin, async (req) => fuerBuchen(req));
  app.post('/platz/admin/belegung', admin, async (req) => festEintragen(req));
  // Platzverwaltung → Belegung: Termin ändern bzw. kopieren (#11)
  const zielTermin = buchung.extend({ alt_datum: datum });
  app.put('/platz/admin/buchung/:bid', admin, async (req) => {
    const { bid } = z.object({ bid: z.string().min(1) }).parse(req.params);
    const e = zielTermin.parse(req.body);
    return { text: await change(req, (tx) => verwaltungAendern(tx, bid, e.alt_datum, e), { action: 'PLATZ_AENDERN', reason: `${bid} ${e.alt_datum} → ${e.datum} ${e.von}–${e.bis}` }) };
  });
  app.post('/platz/admin/buchung/:bid/kopie', admin, async (req) => {
    const { bid } = z.object({ bid: z.string().min(1) }).parse(req.params);
    const e = zielTermin.parse(req.body);
    return change(req, (tx) => verwaltungKopieren(tx, bid, e.alt_datum, e), { action: 'PLATZ_BUCHEN', reason: `Kopie ${bid} ${e.alt_datum} → ${e.datum} ${e.von}–${e.bis}` });
  });
  /** feste Belegung eines einzelnen Tages ändern (wiederkehrende unter „Training & Sperrzeiten“) */
  app.put('/platz/admin/belegung/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const e = buchung.extend({
      art: z.enum(['TRAINING', 'SCHNUPPER', 'SPERRE', 'VERANSTALTUNG']),
      bezeichnung: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben.').max(80),
    }).parse(req.body);
    return change(req, async (tx) => {
      const [alt] = (await festeLesen(tx)).filter((f) => f.id === id);
      if (!alt) throw new BusinessError('Belegung nicht gefunden.', 404);
      if (alt.datum_von !== alt.datum_bis || alt.plaetze.length !== 1) {
        throw new BusinessError(`„${alt.bezeichnung}“ ist wiederkehrend bzw. für mehrere Plätze – bitte unter „Training & Sperrzeiten“ ändern (kopieren geht).`);
      }
      const p = await platzLesen(tx, e.platz_id);
      const von = minuten(e.von);
      const bis = e.bis === '24:00' ? 1440 : minuten(e.bis);
      if (bis <= von) throw new BusinessError('Die Endzeit liegt vor der Startzeit.');
      const b = (await belegungLesen(tx, [p], e.datum, e.datum)).find((x) => x.fest?.id !== id && x.von < bis && x.bis > von);
      if (b) {
        throw new BusinessError(`${p.name} ist am ${e.datum.split('-').reverse().join('.')} von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr bereits belegt`
          + `${b.fest ? ` („${b.fest.bezeichnung}“)` : b.reserviert ? ' (wird gerade gebucht)' : ` (${b.kunde || 'Buchung'})`}.`);
      }
      const wt = String(((new Date(`${e.datum}T12:00:00Z`).getUTCDay() + 6) % 7) + 1);
      const r = await festeSpeichern(tx, id, {
        bezeichnung: e.bezeichnung, art: e.art, plaetze: [p.id], wochentage: wt, datum_von: e.datum, datum_bis: e.datum,
        zeit_von: e.von, zeit_bis: e.bis, hinweis: e.text?.trim() || null, aktiv: alt.aktiv,
      });
      return { ...r, text: `„${e.bezeichnung}“ geändert: ${p.name} am ${e.datum.split('-').reverse().join('.')} von ${e.von} bis ${e.bis} Uhr.` };
    }, { action: 'PLATZBELEGUNG', reason: String(id) });
  });

  // ------------------------------------------------------------------ Platzverwaltung
  app.get('/platz/admin/plaetze', admin, async () => ({ plaetze: await plaetzeLesen(DB), arten: ARTEN }));

  app.post('/platz/admin/plaetze', admin, async (req) => {
    const p = platz.parse(req.body);
    const id = await change(req, (tx) => platzSpeichern(tx, null, p), { action: 'PLATZ_ANLEGEN', reason: p.name });
    return { id, text: `Platz „${p.name}“ angelegt.` };
  });

  app.put('/platz/admin/plaetze/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const p = platz.parse(req.body);
    await change(req, (tx) => platzSpeichern(tx, id, p), { action: 'PLATZ_AENDERN', reason: p.name });
    return { id, text: `Platz „${p.name}“ gespeichert.` };
  });

  /** Massenänderung (auch Einzelfeld direkt aus der Tabelle, z. B. Raster) */
  app.put('/platz/admin/plaetze-massen', admin, async (req) => {
    const e = z.object({
      ids: z.array(z.coerce.number().int().positive()).min(1, 'Bitte mindestens einen Platz wählen.'),
      felder: platz.omit({ name: true, aliase: true, sort: true }).partial(),
    }).parse(req.body);
    return { text: await change(req, (tx) => massenAendern(tx, e.ids, e.felder), { action: 'PLATZ_MASSEN', reason: Object.keys(e.felder).join(',') }) };
  });

  app.delete('/platz/admin/plaetze/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    await change(req, (tx) => platzLoeschen(tx, id), { action: 'PLATZ_LOESCHEN' });
    return { text: 'Platz gelöscht.' };
  });

  // ------------------------------------------------------------------ Feste Belegungen (Jugendtraining, Sperrzeiten)
  const fest = z.object({
    bezeichnung: z.string().max(80), art: z.enum(['TRAINING', 'SCHNUPPER', 'SPERRE', 'VERANSTALTUNG']),
    plaetze: z.array(z.coerce.number().int().positive()).default([]),
    wochentage: z.string().regex(/^[1-7]{1,7}$/, 'Bitte mindestens einen Wochentag wählen.'),
    datum_von: datum, datum_bis: datum, zeit_von: uhr, zeit_bis: uhr, hinweis: z.string().max(300).nullish().transform((x) => x ?? null),
    aktiv: z.boolean().default(true),
  });
  app.get('/platz/admin/feste', admin, async () => ({ liste: await festeLesen(DB), arten: BELEGUNG_ARTEN }));
  app.post('/platz/admin/feste', admin, async (req) => change(req, (tx) => festeSpeichern(tx, null, fest.parse(req.body)), { action: 'PLATZBELEGUNG' }));
  app.put('/platz/admin/feste/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    return change(req, (tx) => festeSpeichern(tx, id, fest.parse(req.body)), { action: 'PLATZBELEGUNG' });
  });
  app.delete('/platz/admin/feste/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    return { text: await change(req, (tx) => festeLoeschen(tx, id), { action: 'PLATZBELEGUNG' }) };
  });

  app.get('/platz/admin/tag', admin, async (req) => {
    const q = z.object({ datum }).parse(req.query);
    return { datum: q.datum, plaetze: await tagLesen(DB, q.datum, 'admin', req.sitzung) };
  });

  app.post('/platz/admin/storno', admin, async (req) => {
    const e = z.object({ bid: z.string().min(1), datum }).parse(req.body);
    return { text: await change(req, (tx) => verwaltungStornieren(tx, e.bid, e.datum), { action: 'PLATZ_STORNO', reason: e.bid }) };
  });

  app.get('/platz/admin/abos', admin, async () => abosLesen(DB));

  app.post('/platz/admin/abos/vorschau', admin, async (req) => aboVorschau(DB, abo.parse(req.body)));

  app.post('/platz/admin/abos', admin, async (req) => {
    const e = abo.extend({ ueberspringen: z.boolean().default(false) }).parse(req.body);
    return change(req, (tx) => aboAnlegen(tx, e, e.ueberspringen), { action: 'PLATZ_ABO', reason: `${e.adrnr} ${e.ab}–${e.bis_datum}` });
  });

  app.post('/platz/admin/abos/:bid/beenden', admin, async (req) => {
    const { bid } = z.object({ bid: z.string().min(1) }).parse(req.params);
    const { ab } = z.object({ ab: datum.default(() => addTage(jetzt().datum, 1)) }).parse(req.body ?? {});
    return { text: await change(req, (tx) => aboBeenden(tx, bid, ab), { action: 'PLATZ_ABO_ENDE', reason: bid }) };
  });

  app.get('/platz/admin/benutzer', admin, async () => benutzerListe(DB));

  // ------------------------------------------------------------------ Serienbuchung (Hallenwart)
  const serie = { preHandler: requireAuth(P_PLATZ.serie) };
  app.get('/platz/serie/stamm', serie, async () => {
    const plaetze = (await plaetzeLesen(DB, true)).map((p) => ({ id: p.id, name: p.name, art: p.art, raster: p.raster, zeit_von: p.zeit_von, zeit_bis: p.zeit_bis, abrechnen: p.abrechnen }));
    const { mitglieder } = await benutzerListe(DB);
    return { plaetze, mitglieder, rhythmen: RHYTHMEN, heute: jetzt().datum };
  });
  app.post('/platz/serie/pruefen', serie, async (req) => verfuegbarkeit(DB, serieAnfrage.parse(req.body)));
  app.post('/platz/serie', serie, async (req) => {
    const e = serieAnfrage.extend({
      plaetze: z.array(z.coerce.number().int().positive()).min(1, 'Bitte mindestens einen Platz wählen.'),
      adrnr: z.string().nullish(), intern: z.string().max(60).nullish(), text: z.string().max(200).nullish(),
      ueberspringen: z.boolean().default(false),
    }).parse(req.body);
    return change(req, (tx) => serieBuchen(tx, e), { action: 'PLATZ_SERIE', reason: `${e.rhythmus} ${e.ab} ${e.von}–${e.bis}` });
  });

  app.put('/platz/admin/benutzer', admin, async (req) => {
    const e = z.object({ benutzer_id: z.string().uuid(), adrnr: z.string().min(1).nullable() }).parse(req.body);
    await change(req, (tx) => benutzerZuordnen(tx, e.benutzer_id, e.adrnr), { action: 'PLATZ_BENUTZER' });
    return { text: e.adrnr ? 'Zuordnung gespeichert.' : 'Zuordnung entfernt.' };
  });
}
