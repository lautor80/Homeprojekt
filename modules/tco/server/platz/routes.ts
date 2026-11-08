import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB } from '../verein.js';
import { addTage } from '../format.js';
import {
  aboAnlegen, aboBeenden, massenAendern, abosLesen, aboVorschau, belegungLesen, benutzerListe, benutzerZuordnen, einzelAendern, einzelAnlegen,
  einzelStornieren, hhmm, ichLesen, jetzt, meineLesen, platzLesen, platzLoeschen, plaetzeLesen, platzSpeichern, preisVon, regelnPruefen,
  tagLesen, verwaltungStornieren, ARTEN, type Ich,
} from './logik.js';
import { minuten, preiseLesen } from '../halle/preis.js';
import { RHYTHMEN, serieBuchen, verfuegbarkeit } from './serie.js';
import {
  ablehnen, benutzernameFrei, bestaetigen, ep3Abgleich, ep3Anlegen, ep3BenutzerAnlegen, ep3Mitglied, ep3Verknuepfen, registrieren, registrierungenLesen, rolleSicherstellen,
} from './registrierung.js';
import { vereinLesen } from '../verein.js';
import { BELEGUNG_ARTEN, festeLesen, festeLoeschen, festeSpeichern } from './belegungen.js';
import { mailSenden } from '../kommunikation.js';

/**
 * Platzbuchung (Freiplätze und Halle).
 *
 * „Platz buchen“ (tco.platzbuchung:edit): Das Mitglied wird AUSSCHLIESSLICH aus dem angemeldeten Benutzer
 * ermittelt (tco.mitgliedera.benutzer_id). Eigene Buchungen mit Preis anzeigen, anlegen, ändern, stornieren;
 * fremde Buchungen erscheinen nur als „belegt“ (ohne Name, Nummer, Text). Abos sind nur lesbar.
 *
 * „Platzverwaltung“ (tco.platz:admin): Plätze und Buchungsregeln, Belegung mit Namen, Abos, Benutzerzuordnung.
 */
export const P_PLATZ = { buchen: 'tco.platzbuchung:edit', admin: 'tco.platz:admin', serie: 'tco.platz:serie' };

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
});

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
      verein: v.name, ep3: !!ep3?.ja,
      hinweis: 'Nach der Freigabe durch den Verein können Sie Hallen- und Freiplätze für sich buchen (Einzelbuchungen). Abos vergibt der Hallenwart.',
    };
  });
  app.get('/platz/registrierung/frei', async (req) => {
    const { benutzername } = z.object({ benutzername: z.string().trim().min(3).max(50) }).parse(req.query);
    return { frei: await benutzernameFrei(DB, benutzername) };
  });
  app.post('/platz/registrierung', async (req) => {
    regLimit(req.ip, 15);
    const e = registrierung.parse(req.body);
    if (!e.ep3_konto && !e.passwort) throw new BusinessError('Bitte ein Kennwort wählen oder das bestehende EP3-Konto angeben.');
    const r = await registrieren(DB, e, req.ip);
    req.log.info({ registrierung: r.id, benutzername: e.benutzername, ip: req.ip }, 'Registrierung eingegangen');
    return r;
  });

  // ------------------------------------------------------------------ Freigabe (Platzverwaltung)
  app.get('/platz/admin/registrierungen', admin, async (req) => {
    const q = z.object({ status: z.enum(['OFFEN', 'ALLE']).default('OFFEN') }).parse(req.query);
    return registrierungenLesen(DB, q.status);
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
    const r = await change(req, (tx) => bestaetigen(tx, id, b, wer), { action: 'REGISTRIERUNG_FREIGABE', reason: String(id) });
    // Benachrichtigung, wenn der Mailversand eingerichtet ist (nicht kritisch)
    let mail = '';
    try {
      const v = await vereinLesen();
      if (v.n8n_mail_url && r.email) {
        await mailSenden(v, {
          modus: 'senden', anwendung: 'Platzbuchung', objekt: `REG-${id}`, an: r.email, benutzer: wer, anhaenge: [],
          betreff: `${v.name}: Ihr Zugang zur Platzbuchung ist freigeschaltet`,
          text: `Guten Tag ${r.anzeigename},

Ihre Registrierung für die Platzbuchung wurde freigegeben. Sie können sich jetzt im Portal anmelden`
            + (r.ep3 ? ' – mit Ihrem gewählten Benutzernamen und Ihrem bisherigen EP3-Kennwort.' : ' – mit Ihrem Benutzernamen und dem bei der Registrierung gewählten Kennwort.')
            + `

Viele Grüße
${v.name}`,
        });
        mail = ' Benachrichtigung per E-Mail gesendet.';
      }
    } catch (e) { mail = ` (E-Mail nicht gesendet: ${(e as Error).message})`; }
    return { text: r.text + mail };
  });
  app.post('/platz/admin/registrierungen/:id/ablehnen', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ bemerkung: z.string().max(500).nullish() }).parse(req.body ?? {});
    return { text: await change(req, (tx) => ablehnen(tx, id, b.bemerkung ?? null, req.user!.displayName || req.user!.username), { action: 'REGISTRIERUNG_ABLEHNUNG', reason: String(id) }) };
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
    return { datum: q.datum, heute: j.datum, jetzt: hhmm(j.min), ich: { name: i.name }, plaetze: await tagLesen(DB, q.datum, i, req.sitzung) };
  });

  app.get('/platz/meine', buchen, async (req) => {
    const i = await ich(req);
    const q = z.object({ zeitraum: z.enum(['kommend', 'vergangen']).default('kommend') }).parse(req.query);
    return { ich: { name: i.name }, ...(await meineLesen(DB, i, q.zeitraum)) };
  });

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
      if (b) fehler = b.fest ? `Von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr: ${b.fest.bezeichnung}.` : b.reserviert ? `Von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr wird gerade von jemand anderem gebucht.` : `Von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr bereits belegt.`;
    }
    return { fehler, preis: preisVon(p, e.datum, von, bis, '1', await preiseLesen(DB)) };
  });

  app.post('/platz/buchungen', buchen, async (req) => {
    const i = await ich(req);
    const e = buchung.parse(req.body);
    return change(req, (tx) => einzelAnlegen(tx, i, e), { action: 'PLATZ_BUCHEN', reason: `${e.datum} ${e.von}–${e.bis}` });
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
    bezeichnung: z.string().max(80), art: z.enum(['TRAINING', 'SPERRE', 'VERANSTALTUNG']),
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
