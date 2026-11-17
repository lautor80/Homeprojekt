import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { funktionAktiv } from '../../../../server/src/funktionsschalter.js';
import { mailVerfuegbar } from '../../../../server/src/lib/mail.js';
import { DB, vereinLesen } from '../verein.js';
import { addTage, heute, runden } from '../format.js';
import { kontaktLesen } from '../kommunikation.js';
import { CFG_SCHEMA, F_MAHN_AUTOMATIK, naechsterLauf, P_MAHN, planen, SCHRITT_TEXT, ART_TEXT, MAX_STUFEN, notizText, vorschlagAbgleichen, type OffenerPosten, type PostenArt, type VorschlagZeile } from './logik.js';
import { automatikPruefen, cfgLesen, cfgSichern, historieLesen, jetztText, laufAusfuehren, laufFreigeben, laufVerwerfen, mahnNotiz, sperrenLesen, standLesen, type Wer } from './lauf.js';

/**
 * App „Mahnwesen“ (Finanzen): fällige Posten mit Stufe und nächstem Schritt, Vorschau des nächsten Laufs, Lauf von Hand,
 * Vorschlag freigeben, Läufe mit Ergebnis je Posten, Liste „nicht per E-Mail erreichbar“, Mahnsperren, Einstellungen.
 * Der automatische Lauf startet hier im Hintergrund (jede Minute geprüft, nicht in Tests).
 */
export { P_MAHN };

const wer = (req: FastifyRequest): Wer => ({ id: req.user?.id ?? null, name: req.user?.displayName || req.user?.username || 'unbekannt' });
const pId = z.object({ id: z.coerce.number().int().positive() });
const ART = z.enum(['HALLE', 'VERZEHR']);
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');

let planer: ReturnType<typeof setInterval> | null = null;

const laufSpalten = () => DB`l.id, l.art, l.modus, l.status, to_char(l.stichtag, 'YYYY-MM-DD') as stichtag, l.gestartet_am, l.gestartet_von, l.beendet_am, l.freigegeben_am, l.freigegeben_von,
  l.zurueckgestellt, l.meldung,
  (select count(*)::int from tco.mahn_posten p where p.lauf_id = l.id) as posten,
  (select count(distinct schuldner)::int from tco.mahn_posten p where p.lauf_id = l.id) as schuldner,
  (select count(distinct schuldner)::int from tco.mahn_posten p where p.lauf_id = l.id and p.status = 'GESENDET') as gesendet,
  (select count(distinct schuldner)::int from tco.mahn_posten p where p.lauf_id = l.id and p.status = 'NICHT_ERREICHBAR') as nicht_erreichbar,
  (select count(distinct schuldner)::int from tco.mahn_posten p where p.lauf_id = l.id and p.status = 'FEHLER') as fehler,
  (select count(*)::int from tco.mahn_posten p where p.lauf_id = l.id and p.status = 'ENTFALLEN') as entfallen,
  (select coalesce(sum(betrag), 0)::float8 from tco.mahn_posten p where p.lauf_id = l.id and p.status in ('VORSCHLAG', 'GESENDET')) as betrag`;

const postenEinesLaufs = (id: number) => DB`
  select id, art, nr, schuldner, name, betrag::float8 as betrag, to_char(faellig, 'YYYY-MM-DD') as faellig, stufe, stufe_name, gebuehr::float8 as gebuehr,
         to_char(frist, 'YYYY-MM-DD') as frist, status, weg, an, meldung, erledigt_am, erledigt_von
    from tco.mahn_posten where lauf_id = ${id} order by name, schuldner, faellig, id`;

/**
 * Offener Vorschlag mit aktuellem Zahlungsstand: inzwischen bezahlte bzw. gesperrte Posten sind markiert und zählen in
 * Schuldnern und Betrag nicht mehr mit (beim Senden entfallen sie ohnehin).
 */
async function vorschlagAktuell(vl: Record<string, unknown>, stand: OffenerPosten[]) {
  const ab = vorschlagAbgleichen(await postenEinesLaufs(vl.id as number) as unknown as (VorschlagZeile & Record<string, unknown>)[], stand, await sperrenLesen(DB), heute());
  return { ...vl, schuldner: ab.schuldner, betrag: ab.betrag, zeilen: ab.zeilen };
}

export async function mahnungRoutes(app: FastifyInstance) {
  // Automatik: jede Minute prüfen, ob der Lauf fällig ist (nur im Server-Prozess, nicht in Tests). Ohne eingeschaltete
  // Automatik in den Einstellungen geschieht nichts – nach der Installation ist sie aus.
  if (!planer && !process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test' && !process.env.TEST_DATABASE_URL) {
    planer = setInterval(() => { automatikPruefen(app.log).catch((e) => app.log.warn(e, 'Mahnlauf: Prüfung fehlgeschlagen')); }, 60_000);
    planer.unref();
  }

  const lesen = { preHandler: requireAuth(P_MAHN.display) };
  const ausfuehren = { preHandler: requireAuth(P_MAHN.execute) };
  const admin = { preHandler: requireAuth(P_MAHN.admin) };

  /** Übersicht: alle offenen Posten mit Stufe und nächstem Schritt, Vorschau des nächsten Laufs, offener Vorschlag, Automatik */
  app.get('/mahnung', lesen, async () => {
    const { cfg, stand } = await standLesen(DB);
    const plan = planen(stand, cfg);
    const [vl] = await DB`select ${laufSpalten()} from tco.mahn_lauf l where l.status = 'VORSCHLAG' order by l.id desc limit 1`;
    const [laeuft] = await DB`select id from tco.mahn_lauf where status = 'LAEUFT' limit 1`;
    // Kontaktdaten für Brief und Anruf zu den nicht erreichten Schuldnern
    const unerreichbar = [];
    const kontakte = new Map<string, Awaited<ReturnType<typeof kontaktLesen>>>();
    for (const p of stand.filter((x) => x.schritt === 'UNERREICHBAR')) {
      if (!kontakte.has(p.schuldner)) kontakte.set(p.schuldner, p.schuldner.startsWith('K:') ? null : await kontaktLesen(DB, p.schuldner));
      const k = kontakte.get(p.schuldner);
      unerreichbar.push({ ...p, kontakt: k ? { anschrift: [k.strasse, `${k.plz} ${k.ort}`.trim()].filter(Boolean).join(', '), telefon: k.telefon, email: k.email } : null });
    }
    const summe = (l: { betrag: number }[]) => runden(l.reduce((s, p) => s + p.betrag, 0));
    const faellig = stand.filter((p) => p.schritt !== 'NICHT_FAELLIG');
    return {
      posten: stand.map((p) => ({ ...p, art_txt: ART_TEXT[p.art], schritt_txt: SCHRITT_TEXT[p.schritt] })),
      kennzahlen: {
        offen: stand.length, offen_betrag: summe(stand), faellig: faellig.length, faellig_betrag: summe(faellig),
        gemahnt: stand.filter((p) => p.stufe > 0).length, klaeren: stand.filter((p) => p.schritt === 'KLAEREN').length,
      },
      plan: { mails: plan.mails, zurueckgestellt: plan.zurueckgestellt.length, summe: summe(plan.mails.map((m) => ({ betrag: m.summe }))), frist: addTage(heute(), cfg.frist_tage) },
      vorschlag: vl ? await vorschlagAktuell(vl, stand) : null,
      unerreichbar,
      automatik: {
        aktiv: cfg.aktiv, funktion: funktionAktiv(F_MAHN_AUTOMATIK), modus: cfg.modus, wochentage: cfg.wochentage, uhrzeit: cfg.uhrzeit,
        naechster: funktionAktiv(F_MAHN_AUTOMATIK) ? naechsterLauf(cfg) : null, letzter_lauf: cfg.letzter_lauf,
      },
      stufen: cfg.stufen, mindestbetrag: cfg.mindestbetrag, max_je_lauf: cfg.max_je_lauf, mail: await mailVerfuegbar(), laeuft: !!laeuft,
    };
  });

  /** Lauf von Hand: Vorschlag erzeugen oder sofort senden */
  app.post('/mahnung/lauf', ausfuehren, async (req) => {
    const d = z.object({ modus: z.enum(['VORSCHLAG', 'SENDEN']) }).parse(req.body);
    return laufAusfuehren({ art: 'MANUELL', modus: d.modus, wer: wer(req) });
  });

  app.get('/mahnung/laeufe', lesen, async () => DB`select ${laufSpalten()} from tco.mahn_lauf l order by l.id desc limit 200`);

  app.get('/mahnung/laeufe/:id', lesen, async (req) => {
    const { id } = pId.parse(req.params);
    const [l] = await DB`select ${laufSpalten()} from tco.mahn_lauf l where l.id = ${id}`;
    if (!l) throw new BusinessError('Lauf nicht gefunden.', 404);
    return { ...l, zeilen: await postenEinesLaufs(id) };
  });

  /** Vorschlag freigeben: jetzt senden – jeder Posten wird vorher erneut gegen den Zahlungsstand geprüft */
  app.post('/mahnung/laeufe/:id/freigeben', ausfuehren, async (req) => laufFreigeben(pId.parse(req.params).id, wer(req)));

  app.post('/mahnung/laeufe/:id/verwerfen', ausfuehren, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => laufVerwerfen(tx, id, wer(req)), { action: 'MAHN_VERWERFEN' });
    return { ok: true, text: 'Vorschlag verworfen – es wurde nichts gesendet.' };
  });

  /** einzelnen Posten aus dem Vorschlag nehmen */
  app.post('/mahnung/posten/:id/verwerfen', ausfuehren, async (req) => {
    const { id } = pId.parse(req.params);
    const w = wer(req);
    const r = await change(req, (tx) => tx`update tco.mahn_posten set status = 'VERWORFEN', meldung = 'aus dem Vorschlag genommen', gebuehr = 0, erledigt_am = now(), erledigt_von = ${w.name}
                                            where id = ${id} and status = 'VORSCHLAG' returning id`, { action: 'MAHN_VERWERFEN' });
    if (!r.length) throw new BusinessError('Dieser Posten steht nicht (mehr) in einem offenen Vorschlag.', 409);
    return { ok: true };
  });

  /** nicht per E-Mail erreicht: Zustellung auf anderem Weg vermerken (Brief, Anruf) – die Stufe gilt damit als zugestellt */
  app.post('/mahnung/posten/:id/zugestellt', ausfuehren, async (req) => {
    const { id } = pId.parse(req.params);
    const d = z.object({ weg: z.enum(['BRIEF', 'TELEFON', 'PERSOENLICH']), bemerkung: z.string().trim().max(300).optional() }).parse(req.body);
    const w = wer(req);
    const cfg = await cfgLesen(DB);
    const r = await change(req, async (tx) => {
      const [p] = await tx`select art, nr, stufe from tco.mahn_posten where id = ${id} and status in ('NICHT_ERREICHBAR', 'FEHLER') for update`;
      if (!p) return null;
      const [schon] = await tx`select id from tco.mahn_posten where art = ${p.art} and nr = ${p.nr} and stufe = ${p.stufe} and status in ('VORSCHLAG', 'GESENDET') limit 1`;
      if (schon) throw new BusinessError('Diese Stufe ist für den Posten bereits zugestellt bzw. vorgeschlagen.', 409);
      return tx`update tco.mahn_posten set status = 'GESENDET', weg = ${d.weg}, meldung = ${d.bemerkung || null}, frist = ${addTage(heute(), cfg.frist_tage)}::date,
                       erledigt_am = now(), erledigt_von = ${w.name} where id = ${id} returning id`;
    }, { action: 'MAHN_ZUGESTELLT' });
    if (!r) throw new BusinessError('Dieser Posten ist nicht (mehr) als „nicht erreichbar“ vermerkt.', 409);
    // Protokoll am Paperless-Dokument (Funktion „Mahnungen in Paperless protokollieren“)
    const [p] = await DB`select art, nr, stufe_name, betrag::float8 as betrag, gebuehr::float8 as gebuehr, to_char(frist, 'YYYY-MM-DD') as frist from tco.mahn_posten where id = ${id}`;
    const warnung = p ? await mahnNotiz(await vereinLesen(DB), p.art, p.nr, notizText({
      stufe_name: p.stufe_name, ergebnis: 'ZUGESTELLT', zeitpunkt: jetztText(), wer: w.name, weg: d.weg, betrag: p.betrag, gebuehr: p.gebuehr, frist: p.frist, meldung: d.bemerkung || null,
    })) : null;
    return { ok: true, text: `Zustellung vermerkt – die Stufe gilt als zugestellt.${warnung ? ` ${warnung}` : ''}` };
  });

  /** nicht erreicht: im nächsten Lauf erneut per E-Mail versuchen (z. B. nachdem das Postfach wieder erreichbar ist) */
  app.post('/mahnung/posten/:id/erneut', ausfuehren, async (req) => {
    const { id } = pId.parse(req.params);
    const r = await change(req, (tx) => tx`update tco.mahn_posten set status = 'FEHLER', meldung = left('erneut versuchen – ' || coalesce(meldung, ''), 500)
                                            where id = ${id} and status = 'NICHT_ERREICHBAR' returning id`, { action: 'MAHN_ERNEUT' });
    if (!r.length) throw new BusinessError('Dieser Posten ist nicht (mehr) als „nicht erreichbar“ vermerkt.', 409);
    return { ok: true, text: 'Der nächste Lauf versucht es erneut.' };
  });

  /** Mahnhistorie eines Postens: alle Stufen und Versuche, auch entfallene und verworfene */
  app.get('/mahnung/historie', lesen, async (req) => {
    const q = z.object({ art: ART, nr: z.string().min(1).max(40) }).parse(req.query);
    return DB`select p.id, p.lauf_id, p.stufe, p.stufe_name, p.status, p.weg, p.an, p.meldung, p.betrag::float8 as betrag, p.gebuehr::float8 as gebuehr,
                     to_char(p.frist, 'YYYY-MM-DD') as frist, coalesce(p.erledigt_am, p.angelegt_am) as am, p.erledigt_von, l.art as lauf_art, l.modus as lauf_modus
                from tco.mahn_posten p join tco.mahn_lauf l on l.id = p.lauf_id
               where p.art = ${q.art} and p.nr = ${q.nr} order by p.id`;
  });

  // ---------------------------------------------------------------- Mahnsperren
  app.get('/mahnung/sperren', lesen, async (req) => sperrenLesen(DB, !z.object({ alle: z.string().optional() }).parse(req.query).alle));

  /** Schuldner für eine Sperre suchen: Mitglieder und Hallenkunden nach Name */
  app.get('/mahnung/schuldner', lesen, async (req) => {
    const q = `%${z.object({ q: z.string().trim().min(2).max(60) }).parse(req.query).q.replace(/[%_\\]/g, '')}%`;
    return DB`
      (select adrnr as schluessel, trim(concat_ws(' ', vorname, nachname)) as name, 'Mitglied' as art from tco.mitglieder
        where concat_ws(' ', vorname, nachname) ilike ${q} or concat_ws(' ', nachname, vorname) ilike ${q} order by nachname, vorname limit 15)
      union all
      (select '99' || lpad(zuid, 8, '0'), trim(concat_ws(' ', vorname, nachname)), 'Hallenkunde' from tco.kunden
        where zuid ~ '^[0-9]+$' and (concat_ws(' ', vorname, nachname) ilike ${q} or concat_ws(' ', nachname, vorname) ilike ${q}) order by nachname, vorname limit 15)`;
  });

  app.post('/mahnung/sperren', ausfuehren, async (req) => {
    const d = z.object({
      ebene: z.enum(['RECHNUNG', 'SCHULDNER']), art: ART.nullish(), schluessel: z.string().trim().min(1).max(80), name: z.string().trim().max(120).default(''),
      grund: z.string().trim().min(3, 'Bitte einen Grund angeben').max(300), bis: datum.nullish().transform((x) => x || null),
    }).parse(req.body);
    if (d.ebene === 'RECHNUNG' && !d.art) throw new BusinessError('Bitte die Art des Postens angeben.');
    if (d.bis && d.bis < heute()) throw new BusinessError('Das Ablaufdatum liegt in der Vergangenheit.');
    if ((await sperrenLesen(DB)).some((s) => s.ebene === d.ebene && s.schluessel === d.schluessel && (d.ebene === 'SCHULDNER' || s.art === d.art))) {
      throw new BusinessError('Dafür gibt es bereits eine aktive Mahnsperre – bitte zuerst aufheben.', 409);
    }
    const w = wer(req);
    const [r] = await change(req, (tx) => tx`insert into tco.mahn_sperre (ebene, art, schluessel, name, grund, bis, angelegt_von)
      values (${d.ebene}, ${d.ebene === 'RECHNUNG' ? d.art ?? null : null}, ${d.schluessel}, ${d.name}, ${d.grund}, ${d.bis}, ${w.name}) returning id`, { action: 'MAHNSPERRE', reason: d.grund });
    return { id: r.id as number, text: 'Mahnsperre gesetzt.' };
  });

  app.post('/mahnung/sperren/:id/aufheben', ausfuehren, async (req) => {
    const { id } = pId.parse(req.params);
    const w = wer(req);
    const r = await change(req, (tx) => tx`update tco.mahn_sperre set aufgehoben_am = now(), aufgehoben_von = ${w.name} where id = ${id} and aufgehoben_am is null returning id`, { action: 'MAHNSPERRE_AUFHEBEN' });
    if (!r.length) throw new BusinessError('Diese Mahnsperre ist bereits aufgehoben.', 409);
    return { ok: true, text: 'Mahnsperre aufgehoben.' };
  });

  // ---------------------------------------------------------------- Einstellungen (Administration → Einstellungen → TC Oberthal → Mahnwesen)
  app.get('/mahnung/einstellungen', admin, async () => {
    const cfg = await cfgLesen(DB);
    const [v] = await DB`select zahlungsziel_tage, email from tco.verein where id = 1`;
    return {
      ...cfg, wochentage: cfg.wochentage.split(',').filter(Boolean).map(Number), arten: cfg.arten.split(',').filter(Boolean) as PostenArt[],
      verein_zahlungsziel: v?.zahlungsziel_tage ?? 14, verein_email: v?.email ?? '', max_stufen: MAX_STUFEN,
      funktion: funktionAktiv(F_MAHN_AUTOMATIK), naechster: funktionAktiv(F_MAHN_AUTOMATIK) ? naechsterLauf(cfg) : null, mail: await mailVerfuegbar(),
    };
  });

  app.put('/mahnung/einstellungen', admin, async (req) => {
    const p = CFG_SCHEMA.safeParse(req.body);
    if (!p.success) throw new BusinessError(p.error.issues[0]?.message ?? 'Die Eingaben sind unvollständig.');
    const d = p.data;
    await change(req, (tx) => cfgSichern(tx, d), { action: 'MAHN_EINSTELLUNGEN' });
    const cfg = await cfgLesen(DB);
    return { ok: true, naechster: naechsterLauf(cfg), text: d.aktiv ? `Automatik eingeschaltet (${d.modus === 'SENDEN' ? 'sendet automatisch' : 'erzeugt nur einen Vorschlag'}).` : 'Gesichert – die Automatik ist aus.' };
  });
}
