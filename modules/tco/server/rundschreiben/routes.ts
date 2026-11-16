import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, plAktiv, vereinLesen, type Db } from '../verein.js';
import { emailGesperrt, mailSenden } from '../kommunikation.js';
import { sperrText } from '../emailsperre.js';
import { gruppenLesen } from '../gruppen/logik.js';
import { ALTER, AUSWAHL_LEER, auswahlAus, auswahlWerte, einsetzen, empfaengerLesen, PLATZHALTER, WEG_TEXT, type Auswahl } from './empfaenger.js';
import {
  ANWENDUNG, erneutVormerken, nichtErreichtLesen, versandAnhalten, versandAusloesen, versandFortsetzen, versandStarten, versandWiederaufnehmen,
  ZAEHLER_LEER, zaehlerLesen,
} from './versand.js';
import { rundschreibenAblegen, rundschreibenPdf } from './pdf.js';

/**
 * App „Rundschreiben“: E-Mails an alle Mitglieder oder an Mitgliedergruppen – Vereinsinformation an Mitglieder, keine
 * Werbung an Dritte. Entwurf (Betreff, Text mit Platzhaltern, Anhänge, Empfängerauswahl), prüfbare Empfängerliste,
 * Testmail an sich selbst, Versand im Hintergrund mit Status je Empfänger, Protokoll.
 *
 * Berechtigungsobjekte:
 *  - tco.rundschreiben:display  Rundschreiben und Versandprotokoll ansehen (Namen und E-Mail-Adressen der Empfänger)
 *  - tco.rundschreiben:edit     Entwürfe anlegen, ändern, kopieren, löschen, Empfänger prüfen, Testmail an sich selbst
 *  - tco.rundschreiben:execute  senden, anhalten, fortsetzen, Fehlgeschlagene erneut senden, in Paperless ablegen
 */
export const P_RS = { display: 'tco.rundschreiben:display', edit: 'tco.rundschreiben:edit', execute: 'tco.rundschreiben:execute' };

/** Anhänge: PDF und Bilder, zusammen höchstens so groß (der zentrale Versand lässt 10 MB je E-Mail zu) */
export const ANHANG_MAX = 5 * 1024 * 1024;
export const ANHANG_ANZAHL = 5;

const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const pId = z.object({ id: z.coerce.number().int().positive() });
const pAnhang = pId.extend({ aid: z.coerce.number().int().positive() });
const adrnr = z.string().trim().min(1).max(20);
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const entwurfSchema = z.object({
  betreff: z.string().trim().max(200, 'Der Betreff darf höchstens 200 Zeichen haben.'),
  text: z.string().max(20_000, 'Der Text darf höchstens 20.000 Zeichen haben.'),
  antwort_an: z.string().trim().max(200).nullish().transform((x) => x || null)
    .refine((x) => !x || EMAIL.test(x), 'Die Antwortadresse ist keine gültige E-Mail-Adresse.'),
  auswahl: z.object({
    alle: z.boolean(), gruppen: z.array(z.number().int().positive()).max(200), alter: z.enum(ALTER), arten: z.array(z.string().max(20)).max(50),
    dazu: z.array(adrnr).max(2000), ohne: z.array(adrnr).max(2000),
  }),
});

/** angemeldet und mindestens eine der Berechtigungen */
function eine(...perms: string[]) {
  return [requireAuth(), async (req: FastifyRequest, reply: FastifyReply) => {
    if (!perms.some((p) => can(req, p))) return reply.code(403).send({ message: `Keine Berechtigung (${perms.join(' oder ')}).` });
  }];
}

function dateiart(b: Buffer): string | null {
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

async function kopfLesen(db: Db, id: number) {
  const [k] = await db`
    select id, betreff, text, antwort_an, auswahl, status, hinweis, kopie_von, erstellt_am::text as erstellt_am, erstellt_von,
           geaendert_am::text as geaendert_am, geaendert_von, gesendet_am::text as gesendet_am, gesendet_von, absender,
           fertig_am::text as fertig_am, paperless_id, paperless_am::text as paperless_am
      from tco.rundschreiben where id = ${id}`;
  if (!k) throw new BusinessError('Das Rundschreiben gibt es nicht (mehr).', 404);
  return { ...k, id: Number(k.id), auswahl: auswahlAus(k.auswahl) } as Record<string, unknown> & { id: number; status: string; betreff: string; text: string; antwort_an: string | null; auswahl: Auswahl };
}
async function entwurfLesen(db: Db, id: number) {
  const k = await kopfLesen(db, id);
  if (k.status !== 'ENTWURF') throw new BusinessError('Das Rundschreiben wurde bereits gesendet und lässt sich nicht mehr ändern – als Vorlage kopieren geht.', 409);
  return k;
}
const anhaengeLesen = (db: Db, id: number) =>
  db`select id, dateiname, mime, groesse from tco.rundschreiben_anhaenge where rundschreiben_id = ${id} order by id`;

export async function rundschreibenRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_RS.display) };
  const pflegen = { preHandler: requireAuth(P_RS.edit) };
  const senden = { preHandler: requireAuth(P_RS.execute) };
  const pruefen = { preHandler: eine(P_RS.edit, P_RS.execute) };

  // Nach einem Neustart: Rundschreiben im Versand weiterführen (einmalig, kein regelmäßiger Lauf)
  if (process.env.NODE_ENV !== 'test' && !process.env.TEST_DATABASE_URL) {
    setTimeout(() => { versandWiederaufnehmen(app.log).catch((e) => app.log.warn(e, 'Rundschreiben: Wiederaufnahme fehlgeschlagen')); }, 20_000).unref();
  }

  app.get('/rundschreiben', lesen, async () => {
    const liste = await DB`select id, betreff, status, hinweis, erstellt_am::text as erstellt_am, erstellt_von, geaendert_am::text as geaendert_am,
                                  gesendet_am::text as gesendet_am, gesendet_von, paperless_id
                             from tco.rundschreiben order by (status = 'ENTWURF') desc, coalesce(gesendet_am, geaendert_am) desc, id desc`;
    const zaehler = await zaehlerLesen(DB, liste.map((r) => Number(r.id)));
    const v = await vereinLesen();
    return {
      liste: liste.map((r) => ({ ...r, zaehler: zaehler.get(Number(r.id)) ?? ZAEHLER_LEER })),
      mail: !!v.n8n_mail_url, paperless: plAktiv(v),
    };
  });

  /** Was sich im Entwurf wählen lässt: Gruppenbaum, Beitragsarten, Personen zum Hinzufügen/Ausschließen, Platzhalter */
  app.get('/rundschreiben/auswahl', pflegen, async () => {
    const gruppen = (await gruppenLesen(DB)).filter((g) => g.aktiv).map((g) => ({ id: g.id, name: g.name, pfad: g.pfad, ebene: g.ebene, gesamt: g.gesamt }));
    return { gruppen, ...(await auswahlWerte(DB)), platzhalter: PLATZHALTER, anhang_max: ANHANG_MAX, anhang_anzahl: ANHANG_ANZAHL };
  });

  app.post('/rundschreiben', pflegen, async (req) => {
    const v = await vereinLesen();
    // Antwortadresse wie beim letzten Rundschreiben vorbelegen
    const [letzte] = await DB`select antwort_an from tco.rundschreiben where antwort_an is not null order by id desc limit 1`;
    const text = `{Anrede},\n\n\n\nViele Grüße\n${v.ansprechpartner || v.name}`;
    const [r] = await change(req, (tx) => tx`
      insert into tco.rundschreiben (betreff, text, antwort_an, auswahl, erstellt_von, geaendert_von)
      values ('', ${text}, ${(letzte?.antwort_an as string | null) ?? null}, ${tx.json({ ...AUSWAHL_LEER, alle: true } as never)}, ${benutzer(req)}, ${benutzer(req)}) returning id`);
    return { id: Number(r.id) };
  });

  app.get('/rundschreiben/:id', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    const k = await kopfLesen(DB, id);
    return { ...k, anhaenge: await anhaengeLesen(DB, id), zaehler: (await zaehlerLesen(DB, [id])).get(id) ?? ZAEHLER_LEER };
  });

  app.put('/rundschreiben/:id', pflegen, async (req) => {
    const { id } = pId.parse(req.params);
    const d = entwurfSchema.parse(req.body);
    await change(req, async (tx) => {
      await tx`select id from tco.rundschreiben where id = ${id} for update`;
      await entwurfLesen(tx, id);
      await tx`update tco.rundschreiben set betreff = ${d.betreff}, text = ${d.text}, antwort_an = ${d.antwort_an}, auswahl = ${tx.json(auswahlAus(d.auswahl) as never)},
                      geaendert_am = now(), geaendert_von = ${benutzer(req)} where id = ${id}`;
    });
    return { ok: true };
  });

  app.delete('/rundschreiben/:id', pflegen, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, async (tx) => {
      await tx`select id from tco.rundschreiben where id = ${id} for update`;
      await entwurfLesen(tx, id);
      await tx`delete from tco.rundschreiben where id = ${id}`;
    });
    return { ok: true };
  });

  /** Ein Rundschreiben (auch ein gesendetes) als Vorlage kopieren: Betreff, Text, Antwortadresse, Empfängerauswahl und Anhänge */
  app.post('/rundschreiben/:id/kopieren', pflegen, async (req) => {
    const { id } = pId.parse(req.params);
    const k = await kopfLesen(DB, id);
    const neu = await change(req, async (tx) => {
      const [r] = await tx`insert into tco.rundschreiben (betreff, text, antwort_an, auswahl, kopie_von, erstellt_von, geaendert_von)
                           values (${k.betreff}, ${k.text}, ${k.antwort_an}, ${tx.json(k.auswahl as never)}, ${id}, ${benutzer(req)}, ${benutzer(req)}) returning id`;
      await tx`insert into tco.rundschreiben_anhaenge (rundschreiben_id, dateiname, mime, groesse, inhalt)
               select ${r.id}, dateiname, mime, groesse, inhalt from tco.rundschreiben_anhaenge where rundschreiben_id = ${id} order by id`;
      return Number(r.id);
    });
    return { id: neu };
  });

  // ---------------------------------------------------------------- Anhänge
  app.post('/rundschreiben/:id/anhaenge', { ...pflegen, bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const { id } = pId.parse(req.params);
    const d = z.object({ dateiname: z.string().trim().min(1).max(150), data: z.string().min(1) }).parse(req.body);
    const inhalt = Buffer.from(d.data.replace(/^data:[^,]*,/, ''), 'base64');
    const mime = dateiart(inhalt);
    if (!mime) throw new BusinessError('Als Anhang gehen nur PDF-Dateien und Bilder (JPG, PNG).');
    const dateiname = d.dateiname.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    await change(req, async (tx) => {
      await tx`select id from tco.rundschreiben where id = ${id} for update`;
      await entwurfLesen(tx, id);
      const [s] = await tx`select count(*)::int as n, coalesce(sum(groesse), 0)::int as groesse from tco.rundschreiben_anhaenge where rundschreiben_id = ${id}`;
      if (s.n >= ANHANG_ANZAHL) throw new BusinessError(`Höchstens ${ANHANG_ANZAHL} Anhänge je Rundschreiben.`);
      if (s.groesse + inhalt.length > ANHANG_MAX) {
        throw new BusinessError(`Die Anhänge sind zusammen zu groß (${((s.groesse + inhalt.length) / 1024 / 1024).toFixed(1)} MB, höchstens ${ANHANG_MAX / 1024 / 1024} MB) – große Dateien besser verlinken.`);
      }
      await tx`insert into tco.rundschreiben_anhaenge (rundschreiben_id, dateiname, mime, groesse, inhalt) values (${id}, ${dateiname}, ${mime}, ${inhalt.length}, ${inhalt})`;
      await tx`update tco.rundschreiben set geaendert_am = now(), geaendert_von = ${benutzer(req)} where id = ${id}`;
    });
    return { anhaenge: await anhaengeLesen(DB, id) };
  });

  app.delete('/rundschreiben/:id/anhaenge/:aid', pflegen, async (req) => {
    const { id, aid } = pAnhang.parse(req.params);
    await change(req, async (tx) => {
      await tx`select id from tco.rundschreiben where id = ${id} for update`;
      await entwurfLesen(tx, id);
      await tx`delete from tco.rundschreiben_anhaenge where id = ${aid} and rundschreiben_id = ${id}`;
    });
    return { anhaenge: await anhaengeLesen(DB, id) };
  });

  app.get('/rundschreiben/:id/anhaenge/:aid', lesen, async (req, reply) => {
    const { id, aid } = pAnhang.parse(req.params);
    const [a] = await DB`select dateiname, mime, inhalt from tco.rundschreiben_anhaenge where id = ${aid} and rundschreiben_id = ${id}`;
    if (!a) throw new BusinessError('Den Anhang gibt es nicht (mehr).', 404);
    return reply.type(a.mime as string).header('content-disposition', `inline; filename="${encodeURIComponent(a.dateiname as string)}"`).send(Buffer.from(a.inhalt as Uint8Array));
  });

  // ---------------------------------------------------------------- Empfänger prüfen, Vorschau, Testmail
  /**
   * Empfängerliste eines Entwurfs aus dem aktuellen Bestand: je E-Mail-Adresse eine Zeile, Personen ohne Adresse,
   * Dubletten – dazu die Vorschau von Betreff und Text mit den Werten eines Empfängers (fuer = seine Adresse, sonst der erste).
   */
  app.get('/rundschreiben/:id/empfaenger', pruefen, async (req) => {
    const { id } = pId.parse(req.params);
    const { fuer } = z.object({ fuer: z.string().optional() }).parse(req.query);
    const k = await kopfLesen(DB, id);
    const v = await vereinLesen();
    const erg = await empfaengerLesen(DB, k.auswahl);
    // Vorab zeigen, welche Adressen der zentrale Versand ablehnen wird (im Mitgliederstamm als unzustellbar vermerkt)
    const sperren = await emailGesperrt(DB, erg.empfaenger.map((e) => e.email));
    const gesperrt = (email: string) => { const s = sperren.get(email.toLowerCase()); return s ? sperrText(s) : null; };
    const bsp = erg.empfaenger.find((e) => e.email.toLowerCase() === (fuer ?? '').toLowerCase()) ?? erg.empfaenger[0] ?? null;
    return {
      empfaenger: erg.empfaenger.map((e) => ({ email: e.email, namen: e.namen, anrede: e.anrede, personen: e.adrnrs.length, weg: e.weg, weg_text: WEG_TEXT[e.weg], unzustellbar: gesperrt(e.email) })),
      ohne_mail: erg.ohneMail,
      anzahl: { personen: erg.personen, mails: erg.empfaenger.length, ohne_mail: erg.ohneMail.length, dubletten: erg.dubletten, ausgeschlossen: erg.ausgeschlossen,
        unzustellbar: erg.empfaenger.filter((e) => gesperrt(e.email)).length },
      beispiel: bsp ? { an: bsp.email, namen: bsp.namen, betreff: einsetzen(k.betreff, bsp, v.name), text: einsetzen(k.text, bsp, v.name) } : null,
      mail: !!v.n8n_mail_url,
    };
  });

  /** Testmail an die eigene Adresse – mit den Platzhalterwerten des ersten Empfängers und allen Anhängen */
  app.post('/rundschreiben/:id/test', pflegen, async (req) => {
    const { id } = pId.parse(req.params);
    const an = (req.user?.email ?? '').trim();
    if (!an) throw new BusinessError('Für die Testmail fehlt Ihre E-Mail-Adresse (Benutzerverwaltung bzw. Benutzermenü → Mein Profil).');
    const k = await kopfLesen(DB, id);
    if (!k.betreff.trim() || !k.text.trim()) throw new BusinessError('Bitte zuerst Betreff und Text eingeben und sichern.');
    const v = await vereinLesen();
    if (!v.n8n_mail_url) throw new BusinessError('Der Mailversand ist nicht eingerichtet (Administration → Schnittstellen → E-Mail).');
    const erster = (await empfaengerLesen(DB, k.auswahl)).empfaenger[0];
    const werte = erster ?? { anrede: `Hallo ${benutzer(req)}`, vorname: benutzer(req), nachname: '' };
    const anhaenge = (await DB`select dateiname, mime, inhalt from tco.rundschreiben_anhaenge where rundschreiben_id = ${id} order by id`)
      .map((a) => ({ dateiname: a.dateiname as string, mime: a.mime as string, inhalt: Buffer.from(a.inhalt as Uint8Array) }));
    const r = await mailSenden(v, {
      modus: 'senden', anwendung: ANWENDUNG, objekt: `RS-${id}-TEST`, an, benutzer: benutzer(req), anhaenge,
      betreff: `[Test] ${einsetzen(k.betreff, werte, v.name)}`, text: einsetzen(k.text, werte, v.name), antwort_an: k.antwort_an || undefined,
      wiederholung: { art: 'NEU_AUSLOESEN', hinweis: 'Testmail eines Rundschreibens – in der App „Rundschreiben“ erneut auslösen.' },
    });
    if (r.status !== 'gesendet') throw new BusinessError(`Die Testmail wurde nicht gesendet: ${r.fehler || r.hinweis || r.status}`);
    return { text: `Testmail an ${an} gesendet${erster ? ` (Platzhalter wie für ${erster.namen})` : ''}.` };
  });

  // ---------------------------------------------------------------- Versand
  /** Senden: schreibt die Empfängerliste fest und startet den Versand im Hintergrund; mails = bestätigte Zahl der E-Mails */
  app.post('/rundschreiben/:id/senden', senden, async (req) => {
    const { id } = pId.parse(req.params);
    const d = z.object({ mails: z.number().int().positive('Bitte zuerst die Empfänger prüfen.') }).parse(req.body);
    const r = await change(req, (tx) => versandAusloesen(tx, id, { name: benutzer(req), email: (req.user?.email ?? '').trim() || null }, d.mails), { action: 'RUNDSCHREIBEN_SENDEN' });
    void versandStarten(id, app.log);
    return { ...r, text: `Der Versand an ${r.mails} E-Mail-Adresse${r.mails === 1 ? '' : 'n'} läuft im Hintergrund.` };
  });

  app.post('/rundschreiben/:id/anhalten', senden, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => versandAnhalten(tx, id, benutzer(req)));
    return { text: 'Der Versand wird angehalten.' };
  });

  app.post('/rundschreiben/:id/fortsetzen', senden, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => versandFortsetzen(tx, id));
    void versandStarten(id, app.log);
    return { text: 'Der Versand läuft weiter.' };
  });

  /** Fehlgeschlagene (alle oder die genannten Zeilen) erneut senden – mit der inzwischen berichtigten Adresse aus dem Stamm */
  app.post('/rundschreiben/:id/erneut', senden, async (req) => {
    const { id } = pId.parse(req.params);
    const d = z.object({ ids: z.array(z.number().int().positive()).max(5000).optional() }).parse(req.body ?? {});
    const r = await change(req, (tx) => erneutVormerken(tx, id, d.ids), { action: 'RUNDSCHREIBEN_ERNEUT' });
    void versandStarten(id, app.log);
    return { ...r, text: `${r.vorgemerkt} Empfänger werden erneut angeschrieben${r.nachgetragen ? ` (davon ${r.nachgetragen} mit nachgetragener Adresse)` : ''}.` };
  });

  // ---------------------------------------------------------------- Protokoll
  app.get('/rundschreiben/:id/protokoll', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    await kopfLesen(DB, id);
    const zeilen = await DB`select id::int as id, email, namen, cardinality(adrnrs) as personen, weg, status, fehler, versuche, gesendet_am::text as gesendet_am
                              from tco.rundschreiben_empfaenger where rundschreiben_id = ${id}
                             order by case status when 'FEHLER' then 0 when 'OHNE_MAIL' then 1 when 'SENDET' then 2 when 'OFFEN' then 3 else 4 end, lower(namen), id`;
    return { zeilen, zaehler: (await zaehlerLesen(DB, [id])).get(id) ?? ZAEHLER_LEER };
  });

  /** Nicht per E-Mail Erreichte mit Anschrift – für Brief oder Aushang */
  app.get('/rundschreiben/:id/nicht-erreicht.csv', lesen, async (req, reply) => {
    const { id } = pId.parse(req.params);
    const k = await kopfLesen(DB, id);
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const zeilen = [['Name', 'Straße', 'PLZ', 'Ort', 'E-Mail-Adresse', 'Grund'].map(q).join(';'),
      ...(await nichtErreichtLesen(DB, id)).map((n) => [n.name, n.strasse, n.plz, n.ort, n.email, n.grund].map(q).join(';'))];
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="Rundschreiben_${id}_nicht_erreicht.csv"`)
      .send(`﻿Rundschreiben ${id}: ${k.betreff} – nicht per E-Mail erreicht\n${zeilen.join('\n')}\n`);
  });

  /** Ausdruck: Text, nicht Erreichte mit Anschrift, Versandprotokoll */
  app.get('/rundschreiben/:id/pdf', lesen, async (req, reply) => {
    const { id } = pId.parse(req.params);
    const { pdf, titel } = await rundschreibenPdf(DB, id);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${encodeURIComponent(titel)}.pdf"`).send(pdf);
  });

  /** Gesendetes Rundschreiben (erneut) in Paperless ablegen */
  app.post('/rundschreiben/:id/paperless', senden, async (req) => {
    const { id } = pId.parse(req.params);
    const r = await rundschreibenAblegen(id, benutzer(req));
    if (!r.id) throw new BusinessError('Hochgeladen, die DOKID ist aber noch nicht verfügbar – bitte später erneut ablegen.');
    return { text: `„${r.titel}“ in Paperless abgelegt (DOKID ${String(r.id).padStart(6, '0')}).`, warnungen: r.warnungen };
  });
}
