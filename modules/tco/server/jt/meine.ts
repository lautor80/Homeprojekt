import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, paperless, plAktiv, vereinLesen } from '../verein.js';
import { heute, runden } from '../format.js';
import {
  abrechnung, ARTEN, dokuLesen, ferienLesen, grenzen, istBezahlt, monatsname, saetzeLesen, satzAm, tageGenerieren, trainerLesen,
  zeitenLesen, zeitLoeschen, zeitSetzen, type Doku, type Trainer,
} from './logik.js';
import { nachweisAblegen, nachweisDaten, nachweisPdf } from './nachweis.js';
import { einheitenSetzen, schnupperFuerTrainer } from '../schnupper/logik.js';
import { P_SCHNUPPER } from '../schnupper/routes.js';

/**
 * „Meine Trainingszeiten“ – Rückmeldung durch die Trainer selbst (fürs Handy).
 *
 * Sicherheit: Der Trainer wird AUSSCHLIESSLICH aus dem angemeldeten Benutzer ermittelt
 * (tco.mitgliedera.benutzer_id). Keine Route nimmt eine Adressnummer entgegen; fremde Zeiten,
 * Beträge oder Nachweise sind damit weder lesbar noch änderbar. Bezahlte und freigegebene Monate sind gesperrt.
 *
 * Monatsabschluss: Nach Ende eines Monats gibt der Trainer seinen Zeitnachweis frei. Dabei wird der
 * Nachweis mit Stunden und Betrag in Paperless abgelegt (bzw. neue Version) und der Monat gesperrt;
 * die Jugendleitung sieht die Freigabe in „Abrechnung Jugendtraining“ und im Arbeitsvorrat (Startseite, Vereinsübersicht).
 */
export const P_JTM = { edit: 'tco.jtmeine:edit' };
/**
 * Schnuppertraining (#21): Übersicht der Kinder mit tco.schnupper:display, Teilnehmer einer Einheit auswählen mit
 * tco.schnupper:edit. Die Teilnahme wird je Tag und Trainer gespeichert und gleicht die Schnupper-Angaben ab.
 */
const SCHNUPPER = 'Schnuppertraining';

const monat = z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, 'Bitte einen Monat wählen.');
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const art = z.enum(ARTEN);

/** Trainer des angemeldeten Benutzers – sonst 403 */
export async function meinTrainer(req: FastifyRequest): Promise<Trainer> {
  const id = req.user?.id;
  if (!id) throw new BusinessError('Bitte mit einem persönlichen Benutzer anmelden.', 403);
  const [a] = await DB`select adrnr from tco.mitgliedera where benutzer_id = ${id} and trainer`;
  if (!a) throw new BusinessError('Ihr Benutzer ist keinem Trainer zugeordnet. Bitte bei der Jugendleitung melden (Zuordnung unter Abrechnung Jugendtraining → Entgelte).', 403);
  const t = (await trainerLesen(DB)).find((x) => x.adrnr === a.adrnr);
  if (!t) throw new BusinessError('Trainer nicht gefunden.', 403);
  return t;
}

const benutzerName = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const aktMonat = () => heute().slice(0, 7).replace('-', '');

/** Änderungen nur in noch nicht bezahlten und nicht freigegebenen Monaten */
async function monatOffen(adrnr: string, d: string) {
  const m = d.slice(0, 7).replace('-', '');
  const doku = await dokuLesen(DB, adrnr, m);
  if (doku?.freigegeben_am) {
    throw new BusinessError(`Der ${monatsname(m)} ist bereits freigegeben – Änderungen bitte über die Jugendleitung (Freigabe zurücknehmen).`);
  }
  const eigene = (await zeitenLesen(DB, m)).filter((z) => z.adrnr === adrnr);
  const betrag = runden(eigene.reduce((s, z) => s + z.betrag, 0));
  if (istBezahlt(doku, betrag)) {
    throw new BusinessError(`Der ${monatsname(m)} ist bereits abgerechnet und bezahlt – Änderungen bitte über die Jugendleitung.`);
  }
}

export async function meineZeitenRoutes(app: FastifyInstance) {
  const recht = { preHandler: requireAuth(P_JTM.edit) };

  app.get('/jt/meine/monat', recht, async (req) => {
    const t = await meinTrainer(req);
    const q = z.object({ monat }).parse(req.query);
    const { von, bis } = grenzen(q.monat);
    const s = await saetzeLesen(DB);
    const zeiten = (await zeitenLesen(DB, q.monat, s)).filter((x) => x.adrnr === t.adrnr).map(({ zalias: _z, ...x }) => x);
    const ferien = (await ferienLesen(DB, Number(q.monat.slice(0, 4)))).filter((f) => f.datum >= von && f.datum <= bis);
    const [abr] = await abrechnung(DB, q.monat, zeiten.map((x) => ({ ...x, zalias: '' })), [t]);
    const doku = await dokuLesen(DB, t.adrnr, q.monat);
    const betrag = runden(zeiten.reduce((x, z) => x + z.betrag, 0));
    return {
      monat: q.monat, titel: monatsname(q.monat), von, bis, arten: ARTEN, ferien,
      trainer: { name: t.name, satz: satzAm(s, t.adrnr, bis) || t.satz },
      zeiten, stunden: runden(zeiten.reduce((x, z) => x + z.anzahl, 0)), betrag,
      status: abr ? { text: abr.status.replace(/ · DOKID \d+$/, ''), state: abr.state } : { text: 'Keine Stunden', state: 'None' },
      nachweis: doku?.doc_id ? { belegnr: doku.belegnr, erstellt_am: doku.erstellt_am, bezahlt_am: doku.bezahlt_am } : null,
      freigabe: doku?.freigegeben_am ? { am: doku.freigegeben_am, von: doku.freigegeben_von, oeffnung_angefragt_am: doku.oeffnung_angefragt_am, oeffnung_grund: doku.oeffnung_grund } : null,
      vorzeitig: q.monat === aktMonat(),
      freigebbar: freigabeHindernis(q.monat, zeiten, doku, betrag),
      gesperrt: istBezahlt(doku, betrag) || !!doku?.freigegeben_am,
      // Schnuppertraining: nur mit Berechtigung (Übersicht der Kinder, Teilnehmer je Einheit)
      schnupper: can(req, P_SCHNUPPER.display) ? { edit: can(req, P_SCHNUPPER.edit) } : null,
    };
  });

  /** Kinder im Schnuppertraining mit Anzahl der Einheiten; dazu die eigenen Einheiten des Monats (Tag → Kinder) */
  app.get('/jt/meine/schnupper', recht, async (req) => {
    if (!can(req, P_SCHNUPPER.display)) throw new BusinessError(`Keine Berechtigung (${P_SCHNUPPER.display}).`, 403);
    const t = await meinTrainer(req);
    const q = z.object({ monat }).parse(req.query);
    const { von, bis } = grenzen(q.monat);
    return { ...(await schnupperFuerTrainer(DB, t.adrnr, von, bis)), edit: can(req, P_SCHNUPPER.edit) };
  });

  /** Archiv: alle Monate mit abgelegtem Zeitnachweis (nur eigene) */
  app.get('/jt/meine/nachweise', recht, async (req) => {
    const t = await meinTrainer(req);
    const rows = await DB`select monat, belegnr, to_char(erstellt_am, 'YYYY-MM-DD') as erstellt_am, to_char(bezahlt_am, 'YYYY-MM-DD') as bezahlt_am,
                                 coalesce(stunden, 0)::float8 as stunden, coalesce(betrag, 0)::float8 as betrag,
                                 to_char(freigegeben_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as freigegeben_am
                            from tco.jt_doku where adrnr = ${t.adrnr} and doc_id is not null order by monat desc limit 36`;
    return rows.map((r) => ({ monat: r.monat, titel: monatsname(r.monat), belegnr: r.belegnr, erstellt_am: r.erstellt_am, bezahlt_am: r.bezahlt_am, stunden: Number(r.stunden), betrag: Number(r.betrag), freigegeben_am: r.freigegeben_am }));
  });

  app.post('/jt/meine/zeiten', recht, async (req) => {
    const t = await meinTrainer(req);
    const b = z.object({
      datum, trainingsart: art, anzahl: z.coerce.number(), altArt: art.nullish(),
      /** Schnuppertraining: Kinder dieser Einheit (weglassen = unverändert) */
      teilnehmer: z.array(z.string().regex(/^[0-9]{1,10}$/)).max(60).optional(),
    }).parse(req.body);
    const { teilnehmer, ...zeit } = b;
    const mitTeilnehmern = b.trainingsart === SCHNUPPER && teilnehmer !== undefined;
    if (mitTeilnehmern && !can(req, P_SCHNUPPER.edit)) throw new BusinessError(`Keine Berechtigung (${P_SCHNUPPER.edit}) – Teilnehmer des Schnuppertrainings können nicht eingetragen werden.`, 403);
    await monatOffen(t.adrnr, b.datum);
    const wer = benutzerName(req);
    await change(req, async (tx) => {
      await zeitSetzen(tx, { adrnr: t.adrnr, ...zeit });
      if (mitTeilnehmern) await einheitenSetzen(tx, t, b.datum, teilnehmer, wer);
      // Trainingsart von Schnuppertraining auf eine andere geändert: Einheiten des Tages entfallen
      else if (b.altArt === SCHNUPPER && b.trainingsart !== SCHNUPPER) await einheitenSetzen(tx, t, b.datum, [], wer);
    }, { action: 'JT_RUECKMELDUNG' });
    return { ok: true };
  });

  app.post('/jt/meine/zeiten/loeschen', recht, async (req) => {
    const t = await meinTrainer(req);
    const b = z.object({ datum, trainingsart: art }).parse(req.body);
    await monatOffen(t.adrnr, b.datum);
    await change(req, async (tx) => {
      await zeitLoeschen(tx, t.adrnr, b.datum, b.trainingsart);
      if (b.trainingsart === SCHNUPPER) await einheitenSetzen(tx, t, b.datum, [], benutzerName(req));
    }, { action: 'JT_RUECKMELDUNG' });
    return { ok: true };
  });

  app.post('/jt/meine/generieren', recht, async (req) => {
    const t = await meinTrainer(req);
    const b = z.object({ monat, wochentage: z.array(z.number().int().min(1).max(7)), trainingsart: art.default('Jugendtraining') }).parse(req.body);
    await monatOffen(t.adrnr, grenzen(b.monat).von);
    const n = await change(req, (tx) => tageGenerieren(tx, t.adrnr, b.monat, b.wochentage, b.trainingsart), { action: 'JT_RUECKMELDUNG' });
    return { text: n ? `${n} Trainingstag(e) angelegt – bitte noch die Dauer eintragen.` : 'Alle gewählten Tage sind bereits erfasst.' };
  });

  /**
   * Monat freigeben: Zeitnachweis in Paperless ablegen (Betrag, Stunden, Belegnummer, Korrespondent, DOKID)
   * und den Monat für weitere Änderungen sperren. Nur abgeschlossene Monate, nur eigene Zeiten.
   */
  app.post('/jt/meine/freigeben', recht, async (req) => {
    const t = await meinTrainer(req);
    const b = z.object({ monat }).parse(req.body);
    const r = await monatFreigeben(req, t.adrnr, b.monat, 'TRAINER');
    return { text: `Zeitnachweis ${monatsname(b.monat)} freigegeben (${r.belegnr}). Die Jugendleitung wurde informiert – Änderungen sind jetzt nur noch über den Kassenwart möglich.`, warnungen: r.warnungen };
  });

  /** freigegebenen Monat wieder öffnen lassen: Anfrage an den Kassenwart (Arbeitsvorrat) */
  app.post('/jt/meine/oeffnung', recht, async (req) => {
    const t = await meinTrainer(req);
    const b = z.object({ monat, grund: z.string().trim().max(300).default('') }).parse(req.body);
    const doku = await dokuLesen(DB, t.adrnr, b.monat);
    if (!doku?.freigegeben_am) throw new BusinessError(`Der ${monatsname(b.monat)} ist nicht freigegeben.`);
    if (doku.bezahlt_am) throw new BusinessError(`Der ${monatsname(b.monat)} ist bereits bezahlt – bitte direkt beim Kassenwart melden.`);
    await change(req, async (tx) => {
      await tx`update tco.jt_doku set oeffnung_angefragt_am = now(), oeffnung_grund = ${b.grund || null} where adrnr = ${t.adrnr} and monat = ${b.monat}`;
    }, { action: 'JT_OEFFNUNG', reason: b.grund || 'Öffnung angefragt' });
    return { text: 'Anfrage an den Kassenwart gesendet. Sobald er den Monat öffnet, kannst du wieder ändern.' };
  });

  /** Voransicht des Zeitnachweises mit dem aktuellen Stand */
  app.get('/jt/meine/nachweis/pdf', recht, async (req, reply) => {
    const t = await meinTrainer(req);
    const q = z.object({ monat }).parse(req.query);
    const { kopf, zeilen } = await nachweisDaten(DB, t.adrnr, q.monat);
    const pdf = await nachweisPdf(await vereinLesen(), kopf, zeilen);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${kopf.belegnr}.pdf"`).send(pdf);
  });

  /** abgelegter Zeitnachweis (neueste Fassung aus Paperless) */
  app.get('/jt/meine/nachweis/dokument', recht, async (req, reply) => {
    const t = await meinTrainer(req);
    const q = z.object({ monat }).parse(req.query);
    const d = await dokuLesen(DB, t.adrnr, q.monat);
    if (!d?.doc_id) throw new BusinessError('Zu diesem Monat ist noch kein Zeitnachweis abgelegt.');
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet.');
    const pl = paperless(v);
    const f = await pl.download(await pl.neuesteVersion(d.doc_id));
    return reply.type(f.contentType).header('content-disposition', `inline; filename="${d.belegnr ?? f.filename}.pdf"`).send(f.data);
  });
}

/**
 * Monat freigeben (Trainer selbst oder Kassenwart stellvertretend): Zeitnachweis mit Betrag, Stunden und
 * Belegnummer in Paperless ablegen bzw. neue Version, Monat sperren, eine offene Öffnungsanfrage erledigt sich.
 */
export async function monatFreigeben(req: FastifyRequest, adrnr: string, m: string, durch: 'TRAINER' | 'KASSENWART') {
  const zeiten = (await zeitenLesen(DB, m)).filter((x) => x.adrnr === adrnr);
  const doku = await dokuLesen(DB, adrnr, m);
  const hindernis = freigabeHindernis(m, zeiten, doku, runden(zeiten.reduce((x, y) => x + y.betrag, 0)));
  if (hindernis !== true) throw new BusinessError(hindernis);
  const v = await vereinLesen();
  if (!plAktiv(v)) throw new BusinessError('Die Ablage ist derzeit nicht eingerichtet – bitte bei der Jugendleitung melden.');
  const { kopf, zeilen, alt } = await nachweisDaten(DB, adrnr, m);
  const pdf = await nachweisPdf(v, kopf, zeilen);
  const wer = benutzerName(req);
  const von = durch === 'KASSENWART' ? `${wer} (Kassenwart)` : wer;
  const r = await nachweisAblegen(DB, v, kopf, alt, pdf, wer, (fn) => change(req, async (tx) => {
    await fn(tx);
    await tx`update tco.jt_doku set freigegeben_am = now(), freigegeben_von = ${von}, oeffnung_angefragt_am = null, oeffnung_grund = null
              where adrnr = ${adrnr} and monat = ${m}`;
  }, { action: 'JT_FREIGABE', reason: `Freigabe Zeitnachweis ${monatsname(m)}${durch === 'KASSENWART' ? ' durch den Kassenwart' : ''}` }),
  { anlass: `${durch === 'KASSENWART' ? `Durch den Kassenwart (${wer}) freigegeben` : 'Vom Trainer freigegeben'}${m === aktMonat() ? ' vor Monatsende' : ''} (${kopf.stunden.toLocaleString('de-DE')} Std., ${kopf.betrag.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €)` });
  return { belegnr: kopf.belegnr, warnungen: r.warnungen };
}

/** true, wenn der Monat freigegeben werden kann – sonst der Grund. Der laufende Monat darf vorzeitig eingereicht werden. */
function freigabeHindernis(m: string, zeiten: { anzahl: number }[], doku: Doku | null, betrag: number): true | string {
  if (doku?.freigegeben_am) return `Der ${monatsname(m)} ist bereits freigegeben.`;
  if (istBezahlt(doku, betrag)) return `Der ${monatsname(m)} ist bereits bezahlt.`;
  if (m > aktMonat()) return `Der ${monatsname(m)} hat noch nicht begonnen.`;
  if (!zeiten.some((x) => x.anzahl > 0)) return `Für den ${monatsname(m)} sind keine Stunden erfasst.`;
  const offen = zeiten.filter((x) => !x.anzahl).length;
  if (offen) return `Bei ${offen} Trainingstag(en) fehlt noch die Dauer – bitte eintragen oder löschen.`;
  return true;
}
