import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, paperless, plAktiv, vereinLesen } from '../verein.js';
import { kontaktLesen, whatsappLink } from '../kommunikation.js';
import {
  abrechnung, ARTEN, entgeltAendern, entgeltLoeschen, entgeltNeu, entgelteLesen, ferienLesen, ferienSynchronisieren, grenzen,
  importieren, mitgliederSuchen, monatsname, rueckmeldungenAbrufen, saetzeLesen, tageGenerieren, trainerLesen, trainerSetzen,
  benutzerAuswahl, trainerBenutzerSetzen,
  zeitenLesen, zeitLoeschen, zeitSetzen,
} from './logik.js';
import { nachweisAblegen, nachweisDaten, nachweisPdf } from './nachweis.js';
import { dokuLesen } from './logik.js';

export const P_JT = {
  display: 'tco.jt:display',
  edit: 'tco.jt:edit',
  entgelte: 'tco.jt:entgelte',
};

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const monat = z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, 'Bitte einen Monat wählen.');
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const adrnr = z.string().min(1).max(20);
const art = z.enum(ARTEN);
const nm = z.object({ adrnr, monat });

/** CSV aus Daten-URL oder Klartext */
const csvText = (s: string) => (/^data:[^,]*;base64,/.test(s) ? Buffer.from(s.replace(/^data:[^,]*;base64,/, ''), 'base64').toString('utf8') : s);

export async function jtRoutes(app: FastifyInstance) {
  app.get('/jt/monat', { preHandler: requireAuth(P_JT.display) }, async (req) => {
    const q = z.object({ monat }).parse(req.query);
    const { von, bis } = grenzen(q.monat);
    const v = await vereinLesen();
    const jahr = Number(q.monat.slice(0, 4));
    let ferien = await ferienLesen(DB, jahr);
    let ferienFehler: string | null = null;
    if (!ferien.length) {
      if (v.n8n_ferien_url) {
        try {
          await change(req, (tx) => ferienSynchronisieren(tx, v, jahr, benutzer(req)));
          ferien = await ferienLesen(DB, jahr);
        } catch (e) { ferienFehler = (e as Error).message; }
      } else ferienFehler = 'Webhook für die Schulferien nicht eingerichtet';
    }
    const s = await saetzeLesen(DB);
    const trainer = await trainerLesen(DB);
    const zeiten = await zeitenLesen(DB, q.monat, s);
    return {
      monat: q.monat, titel: monatsname(q.monat), von, bis, arten: ARTEN, trainer, zeiten,
      ferien: ferien.filter((f) => f.datum >= von && f.datum <= bis), ferienJahr: { ferien: ferien.filter((f) => f.ferien).length, feiertage: ferien.filter((f) => f.feiertag).length },
      ferienFehler, abrechnung: await abrechnung(DB, q.monat, zeiten, trainer), paperless: plAktiv(v),
    };
  });

  // ---------------------------------------------------------------- Zeiten
  app.post('/jt/zeiten', { preHandler: requireAuth(P_JT.edit) }, async (req) => {
    const b = z.object({ adrnr, datum, trainingsart: art, anzahl: z.coerce.number(), altArt: z.string().nullish() }).parse(req.body);
    await change(req, (tx) => zeitSetzen(tx, b));
    return { ok: true };
  });

  app.post('/jt/zeiten/loeschen', { preHandler: requireAuth(P_JT.edit) }, async (req) => {
    const b = z.object({ adrnr, datum, trainingsart: z.string() }).parse(req.body);
    await change(req, (tx) => zeitLoeschen(tx, b.adrnr, b.datum, b.trainingsart));
    return { ok: true };
  });

  app.post('/jt/zeiten/generieren', { preHandler: requireAuth(P_JT.edit) }, async (req) => {
    const b = z.object({ adrnr, monat, wochentage: z.array(z.number().int().min(1).max(7)), trainingsart: art.default('Jugendtraining') }).parse(req.body);
    const n = await change(req, (tx) => tageGenerieren(tx, b.adrnr, b.monat, b.wochentage, b.trainingsart));
    return { text: n ? `${n} Trainingstag(e) angelegt – bitte noch die Dauer eintragen.` : 'Alle gewählten Tage sind bereits erfasst.' };
  });

  // ---------------------------------------------------------------- Import / Ferien
  const ferienMap = async (m: string) => new Map((await ferienLesen(DB, Number(m.slice(0, 4)))).filter((f) => f.ferien).map((f) => [f.datum, f.ferien!]));

  app.post('/jt/import', { preHandler: requireAuth(P_JT.edit), bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const b = z.object({ monat, csv: z.string().min(1, 'Die Datei ist leer.') }).parse(req.body);
    const f = await ferienMap(b.monat);
    return change(req, (tx) => importieren(tx, b.monat, csvText(b.csv), f), { action: 'JT_IMPORT' });
  });

  app.post('/jt/import/nextcloud', { preHandler: requireAuth(P_JT.edit) }, async (req) => {
    const b = z.object({ monat }).parse(req.body);
    const r = await rueckmeldungenAbrufen(await vereinLesen());
    const f = await ferienMap(b.monat);
    const imp = await change(req, (tx) => importieren(tx, b.monat, r.csv, f), { action: 'JT_IMPORT' });
    return { ...imp, ungueltig: r.ungueltig };
  });

  app.post('/jt/ferien', { preHandler: requireAuth(P_JT.edit) }, async (req) => {
    const b = z.object({ jahr: z.number().int().min(2000).max(2100) }).parse(req.body);
    const r = await change(req, async (tx) => ferienSynchronisieren(tx, await vereinLesen(tx), b.jahr, benutzer(req)));
    return { text: `Schulferien ${b.jahr} synchronisiert: ${r.ferien} Ferientage, ${r.feiertage} Feiertage.` };
  });

  // ---------------------------------------------------------------- Zeitnachweis
  app.get('/jt/nachweis/pdf', { preHandler: requireAuth(P_JT.display) }, async (req, reply) => {
    const q = nm.parse(req.query);
    const { kopf, zeilen } = await nachweisDaten(DB, q.adrnr, q.monat);
    const pdf = await nachweisPdf(await vereinLesen(), kopf, zeilen);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${kopf.belegnr}.pdf"`).send(pdf);
  });

  const ablegen = async (req: FastifyRequest, adr: string, m: string, gezahltAm?: string) => {
    const v = await vereinLesen();
    const { kopf, zeilen, alt } = await nachweisDaten(DB, adr, m, gezahltAm);
    const pdf = await nachweisPdf(v, kopf, zeilen);
    return nachweisAblegen(DB, v, kopf, alt, pdf, benutzer(req), (fn) => change(req, fn, { action: gezahltAm ? 'JT_BEZAHLT' : 'JT_NACHWEIS' }));
  };

  app.post('/jt/nachweis/ablegen', { preHandler: requireAuth(P_JT.edit) }, async (req) => {
    const b = nm.parse(req.body);
    return ablegen(req, b.adrnr, b.monat);
  });

  app.post('/jt/nachweis/bezahlt', { preHandler: requireAuth(P_JT.edit) }, async (req) => {
    const b = nm.extend({ datum }).parse(req.body);
    const d = await dokuLesen(DB, b.adrnr, b.monat);
    if (d?.bezahlt_am && d.bezahlt_betrag >= d.betrag && d.betrag > 0) {
      throw new BusinessError('Dieser Nachweis ist bereits als bezahlt gekennzeichnet – das Zahldatum kann nicht mehr geändert werden.');
    }
    const r = await ablegen(req, b.adrnr, b.monat, b.datum);
    return { ...r, text: `Als bezahlt am ${b.datum.split('-').reverse().join('.')} gekennzeichnet. ${r.text}` };
  });

  app.get('/jt/nachweis/dokument', { preHandler: requireAuth(P_JT.display) }, async (req, reply) => {
    const q = nm.parse(req.query);
    const d = await dokuLesen(DB, q.adrnr, q.monat);
    if (!d?.doc_id) throw new BusinessError('Zu diesem Monat ist kein Zeitnachweis abgelegt.');
    const pl = paperless(await vereinLesen());
    const f = await pl.download(await pl.neuesteVersion(d.doc_id));
    return reply.type(f.contentType).header('content-disposition', `inline; filename="${d.belegnr ?? f.filename}.pdf"`).send(f.data);
  });

  app.post('/jt/nachweis/whatsapp', { preHandler: requireAuth(P_JT.edit) }, async (req) => {
    const b = nm.parse(req.body);
    const d = await dokuLesen(DB, b.adrnr, b.monat);
    if (!d?.doc_id) throw new BusinessError('Bitte den Zeitnachweis zuerst nach Paperless übertragen.');
    const k = await kontaktLesen(DB, b.adrnr);
    if (!k?.mobil) throw new BusinessError('Für diesen Trainer ist keine Mobilnummer hinterlegt.');
    const v = await vereinLesen();
    const pl = paperless(v);
    const link = await pl.freigabelink(await pl.neuesteVersion(d.doc_id), 30);
    const text = `Hallo ${k.vorname},\n\nhier ist dein Zeitnachweis Jugendtraining ${monatsname(b.monat)}:\n${link}\n\nViele Grüße\n${v.name.replace(/ e\.V\.$/, '')}`;
    await pl.notizAnlegen(d.doc_id, `WhatsApp-Link an +${k.mobil} geöffnet – Portal ${benutzer(req)}, ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}, Link ${link}`).catch(() => undefined);
    return { url: whatsappLink(k.mobil, text) };
  });

  // ---------------------------------------------------------------- Entgelte und Trainer
  app.get('/jt/entgelte', { preHandler: requireAuth(P_JT.display) }, async () => ({
    entgelte: await entgelteLesen(DB), trainer: await trainerLesen(DB), mitglieder: await mitgliederSuchen(DB), benutzer: await benutzerAuswahl(DB),
  }));

  /** Portal-Benutzer für „Meine Trainingszeiten“ zuordnen */
  app.put('/jt/trainer/benutzer', { preHandler: requireAuth(P_JT.entgelte) }, async (req) => {
    const b = z.object({ adrnr, benutzer_id: z.string().uuid().nullable() }).parse(req.body);
    await change(req, (tx) => trainerBenutzerSetzen(tx, b.adrnr, b.benutzer_id));
    return { text: b.benutzer_id ? 'Benutzer zugeordnet – der Trainer kann seine Zeiten jetzt selbst zurückmelden.' : 'Zuordnung entfernt.' };
  });

  app.post('/jt/entgelte', { preHandler: requireAuth(P_JT.entgelte) }, async (req) => {
    const b = z.object({ adrnr, ab: datum, betrag: z.coerce.number() }).parse(req.body);
    const text = await change(req, (tx) => entgeltNeu(tx, b.adrnr, b.ab, b.betrag));
    return { text };
  });

  app.put('/jt/entgelte', { preHandler: requireAuth(P_JT.entgelte) }, async (req) => {
    const b = z.object({ adrnr, validToAlt: datum, valid_to: datum, betrag: z.coerce.number() }).parse(req.body);
    await change(req, (tx) => entgeltAendern(tx, b.adrnr, b.validToAlt, b));
    return { text: 'Entgelt geändert.' };
  });

  app.post('/jt/entgelte/loeschen', { preHandler: requireAuth(P_JT.entgelte) }, async (req) => {
    const b = z.object({ adrnr, valid_to: datum }).parse(req.body);
    await change(req, (tx) => entgeltLoeschen(tx, b.adrnr, b.valid_to));
    return { text: 'Entgelt gelöscht.' };
  });

  app.put('/jt/trainer', { preHandler: requireAuth(P_JT.entgelte) }, async (req) => {
    const b = z.object({ adrnr, aktiv: z.boolean(), steuernummer: z.string().trim().max(30).nullish() }).parse(req.body);
    await change(req, (tx) => trainerSetzen(tx, b.adrnr, b.aktiv, b.steuernummer === undefined ? undefined : b.steuernummer || null));
    return { text: b.aktiv ? 'Trainer gespeichert.' : 'Trainer-Kennzeichen entfernt.' };
  });
}
