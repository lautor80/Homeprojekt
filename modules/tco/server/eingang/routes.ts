import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import type { CustomFeld, Paperless } from '../../../../server/src/lib/paperless.js';
import { eingerichtet, paperlessFuer, verbindungLesen } from '../../../../server/src/lib/verbindungen.js';
import { DB } from '../verein.js';
import { V_MAILABRUF, V_NEXTCLOUD, mailabrufAnstossen } from '../verbindung.js';
import { tcoSchnittstelle } from '../hinweise.js';
import {
  FELDER, FELD_IDS, OPERATOREN, OPERATOR_IDS, PLATZHALTER, QUELLEN, QUELLE_IDS, bedingungPasst, extrahieren, musterFehler, platzhalter, regelPasst,
} from './logik.js';
import {
  abgleich, ausstehendeAktionen, dokumentAblegen, mailAktionAendern, offeneNeuBewerten, regelZuordnen, regelnFuerVorgang, dokumentIgnorieren, mailKontext, mailVerarbeiten, neuBewerten, regelnLesen, korrespondentenLesen, vorgangAntwort, vorgangIgnorieren,
  zieleAufloesen, mailDokumentAnlegen, mailLesen, mailPdf,
} from './verarbeitung.js';

/**
 * Dokumenteneingang: Regelwerk, Prüfliste und Protokoll (Oberfläche) sowie die Schnittstelle für n8n (API-Schlüssel).
 *  - display: Regeln, Korrespondenten und Protokoll ansehen
 *  - edit:    Regelwerk pflegen und Prüfliste bearbeiten (eine Rolle für beides)
 *  - melden:  nur für den API-Schlüssel von n8n – E-Mails liefern und deren Behandlung abholen
 */
export const P_EING = { display: 'tco.eingang:display', edit: 'tco.eingang:edit', melden: 'tco.eingang:melden' };

const wer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const idParam = z.object({ id: z.coerce.number().int().positive() });
const leer = (max: number) => z.string().max(max).nullish().transform((x) => x ?? '');

const eingang = z.object({
  postfach: z.string().trim().max(300).nullish().transform((x) => x ?? ''),
  ordner: z.string().max(300).nullish().transform((x) => x || null),
  uid: z.union([z.string().max(100), z.number()]).nullish().transform((x) => (x == null || x === '' ? null : String(x))),
  von: leer(1000), an: leer(4000), betreff: leer(2000),
  datum: z.string().max(100).nullish().transform((x) => x || null),
  message_id: leer(1000),
  in_reply_to: z.string().max(2000).nullish().transform((x) => x || null),
  references: z.string().max(20_000).nullish().transform((x) => x || null),
  auto: z.string().max(200).nullish().transform((x) => x || null),
  text: z.string().nullish().transform((x) => (x ?? '').slice(0, 200_000)),
  html: z.string().nullish().transform((x) => (x ?? '').slice(0, 500_000)),
  anhaenge: z.array(z.object({
    name: z.string().min(1).max(500),
    mime: z.string().max(200).nullish().transform((x) => x || null),
    inhalt: z.string(),
    text: z.string().nullish().transform((x) => (x ?? '').slice(0, 500_000)),
  })).max(40).default([]),
});

const vorlage = z.string().max(500).optional();
const paperlessRegel = z.object({
  titel: vorlage, korrespondent: vorlage, dokumenttyp: vorlage, speicherpfad: vorlage, tags: vorlage, datum: vorlage, notiz: vorlage,
  felder: z.record(z.string().max(500)).optional(), anlegen: z.boolean().optional(),
});
const mailAktion = z.object({
  art: z.enum(['keine', 'verschieben', 'loeschen']), ordner: z.string().trim().max(300).optional(), gelesen: z.boolean().optional(),
}).refine((m) => m.art !== 'verschieben' || !!m.ordner, 'Bitte den Zielordner der E-Mail angeben.');
const nextcloud = z.object({ pfad: z.string().max(500), dateiname: z.string().max(300).default('') });
const regelBody = z.object({
  name: z.string().trim().min(2, 'Bitte einen Namen angeben.').max(120),
  beschreibung: z.string().max(1000).default(''),
  status: z.enum(['aktiv', 'testlauf', 'aus']),
  prioritaet: z.coerce.number().int().min(0).max(9999),
  gilt_fuer: z.enum(['anhang', 'mail']),
  verknuepfung: z.enum(['und', 'oder']),
  bedingungen: z.array(z.object({ feld: z.enum(FELD_IDS), op: z.enum(OPERATOR_IDS), wert: z.string().max(2000), nicht: z.boolean().optional() }))
    .min(1, 'Bitte mindestens eine Bedingung angeben.').max(30),
  extraktion: z.array(z.object({
    name: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Feldname: nur Buchstaben, Ziffern und Unterstrich').max(40),
    quelle: z.enum(QUELLE_IDS), muster: z.string().min(1, 'Bitte ein Muster angeben.').max(500), pflicht: z.boolean().optional(),
  })).max(20).default([]),
  aktionen: z.object({
    paperless: paperlessRegel.extend({ aktiv: z.boolean() }).optional(),
    nextcloud: nextcloud.extend({ aktiv: z.boolean() }).optional(),
    zusammenfassen: z.object({ aktiv: z.boolean(), dateiname: z.string().max(300).default(''), reihenfolge: z.enum(['mail', 'name']).default('mail') }).optional(),
    mail: mailAktion.optional(),
    aufgabe: z.object({ aktiv: z.boolean(), titel: z.string().max(300), faellig_tage: z.number().int().min(0).max(365).nullish() }).optional(),
  }),
  automatik: z.enum(['immer', 'pruefen']),
});
type RegelEingabe = z.infer<typeof regelBody>;

function regelPruefen(r: RegelEingabe) {
  const fehler = musterFehler(r);
  if (fehler.length) throw new BusinessError(`Ungültiges Muster – ${fehler.join('; ')}`);
  if (r.gilt_fuer === 'mail' && r.bedingungen.some((b) => ['datei', 'mime', 'doktext'].includes(b.feld))) {
    throw new BusinessError('Regeln für die E-Mail selbst können nicht auf Dateiname, Dateityp oder Dokumenttext prüfen – dafür „je Anhang“ wählen.');
  }
}

const korrBody = z.object({
  name: z.string().trim().min(2, 'Bitte einen Namen angeben.').max(120),
  kurz: z.string().trim().max(40).default(''),
  adressen: z.string().max(4000).default(''),
});

const probe = z.object({
  postfach: leer(300), von: leer(1000), an: leer(4000), betreff: leer(2000), text: leer(100_000), html: leer(200_000),
  datei: leer(500), mime: leer(200), doktext: leer(200_000),
});

/** Dateitypen, die der Browser gefahrlos anzeigen darf – alles andere wird als Download geliefert */
/** Custom Fields aus Paperless für den Regeldialog: Name, Typ und – bei Auswahlfeldern – die Optionen */
async function customFelder(pl: Paperless) {
  try {
    const l = (await pl.liste('custom_fields')) as CustomFeld[];
    return l.map((f) => ({
      name: f.name, typ: f.data_type ?? 'string',
      optionen: (f.extra_data?.select_options ?? []).filter((o) => o != null).map((o) => (typeof o === 'string' ? o : o!.label)),
    })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  } catch { return []; }
}

const ANZEIGBAR = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/i;

export async function eingangRoutes(app: FastifyInstance) {
  const sehen = { preHandler: requireAuth(P_EING.display) };
  const pflegen = { preHandler: requireAuth(P_EING.edit) };
  const melden = { preHandler: requireAuth(P_EING.melden) };

  // ---------------------------------------------------------------- Stammdaten für die Oberfläche
  app.get('/eingang/stamm', sehen, async () => {
    const pl = await paperlessFuer('tco');
    const namen = async (f: () => Promise<{ name: string }[]>) => { try { return (await f()).map((x) => x.name).sort((a, b) => a.localeCompare(b, 'de')); } catch { return [] as string[]; } };
    const [nc, abruf] = await Promise.all([verbindungLesen(V_NEXTCLOUD), verbindungLesen(V_MAILABRUF)]);
    return {
      felder: FELDER, operatoren: OPERATOREN, quellen: QUELLEN, platzhalter: PLATZHALTER,
      paperless: {
        eingerichtet: !!pl,
        korrespondenten: pl ? await namen(() => pl.korrespondenten()) : [], dokumenttypen: pl ? await namen(() => pl.dokumenttypen()) : [],
        speicherpfade: pl ? await namen(() => pl.speicherpfade()) : [], tags: pl ? await namen(() => pl.tags()) : [],
        felder: pl ? await customFelder(pl) : [],
      },
      nextcloud: { eingerichtet: eingerichtet(nc) && !!nc.auth_user && !!nc.geheimnis },
      abruf: { eingerichtet: eingerichtet(abruf) },
    };
  });

  // ---------------------------------------------------------------- Regeln
  app.get('/eingang/regeln', sehen, async () => {
    const regeln = await regelnLesen();
    const treffer = await DB`
      select d.regel_id, count(*)::int as anzahl, to_char(max(v.eingang_am) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as letzter
        from tco.eing_dokumente d join tco.eing_vorgaenge v on v.id = d.vorgang_id
       where d.regel_id is not null and v.eingang_am > now() - interval '30 days'
       group by d.regel_id`;
    const index = new Map(treffer.map((t) => [Number(t.regel_id), t]));
    return regeln.map((r) => ({ ...r, treffer: (index.get(r.id)?.anzahl as number | undefined) ?? 0, letzter: (index.get(r.id)?.letzter as string | undefined) ?? null }));
  });

  app.post('/eingang/regeln', pflegen, async (req) => {
    const r = regelBody.parse(req.body);
    regelPruefen(r);
    const [neu] = await change(req, (tx) => tx`
      insert into tco.eing_regeln (name, beschreibung, status, prioritaet, gilt_fuer, verknuepfung, bedingungen, extraktion, aktionen, automatik, geaendert_von)
      values (${r.name}, ${r.beschreibung}, ${r.status}, ${r.prioritaet}, ${r.gilt_fuer}, ${r.verknuepfung}, ${tx.json(r.bedingungen as never)},
              ${tx.json(r.extraktion as never)}, ${tx.json(r.aktionen as never)}, ${r.automatik}, ${wer(req)})
      returning id`, { action: 'EINGANG_REGEL_NEU' });
    return { id: neu.id as number, text: `Regel „${r.name}“ angelegt.` };
  });

  app.put('/eingang/regeln/:id', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const r = regelBody.parse(req.body);
    regelPruefen(r);
    const n = await change(req, (tx) => tx`
      update tco.eing_regeln set name = ${r.name}, beschreibung = ${r.beschreibung}, status = ${r.status}, prioritaet = ${r.prioritaet},
             gilt_fuer = ${r.gilt_fuer}, verknuepfung = ${r.verknuepfung}, bedingungen = ${tx.json(r.bedingungen as never)},
             extraktion = ${tx.json(r.extraktion as never)}, aktionen = ${tx.json(r.aktionen as never)}, automatik = ${r.automatik},
             version = version + 1, geaendert_am = now(), geaendert_von = ${wer(req)}
       where id = ${id}`, { action: 'EINGANG_REGEL_AENDERN' });
    if (!n.count) throw new BusinessError('Die Regel gibt es nicht (mehr).', 404);
    return { text: `Regel „${r.name}“ gespeichert.` };
  });

  app.delete('/eingang/regeln/:id', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const n = await change(req, (tx) => tx`delete from tco.eing_regeln where id = ${id}`, { action: 'EINGANG_REGEL_LOESCHEN' });
    if (!n.count) throw new BusinessError('Die Regel gibt es nicht (mehr).', 404);
    return { text: 'Regel gelöscht.' };
  });

  /** Regel gegen eine Probe-E-Mail prüfen (nichts wird gespeichert oder abgelegt) */
  app.post('/eingang/regeln/test', sehen, async (req) => {
    const b = z.object({ regel: regelBody, probe }).parse(req.body);
    regelPruefen(b.regel);
    const p = b.probe;
    const { kontext, werte, korrespondent, mitglied } = await mailKontext({ postfach: p.postfach, von: p.von, an: p.an, betreff: p.betreff, datum: null, text: p.text, html: p.html }, p.datei ? 1 : 0);
    const datei = p.datei || `${p.betreff || 'E-Mail'}.pdf`;
    const k = b.regel.gilt_fuer === 'anhang' ? { ...kontext, datei: p.datei, mime: p.mime, doktext: p.doktext } : kontext;
    const { felder, fehlend } = extrahieren(b.regel.extraktion, k);
    const ziele = zieleAufloesen(b.regel.aktionen, platzhalter({ ...werte, datei }, felder), datei);
    return {
      passt: regelPasst(b.regel, k), bedingungen: b.regel.bedingungen.map((x) => bedingungPasst(x, k)),
      korrespondent: korrespondent?.name ?? null, mitglied: mitglied ? `${mitglied.nachname} ${mitglied.vorname}`.trim() : null,
      felder, fehlend, paperless: ziele.zuordnung, nextcloud: ziele.nextcloud,
    };
  });

  // ---------------------------------------------------------------- Korrespondenten
  app.get('/eingang/korrespondenten', sehen, async () => korrespondentenLesen());

  app.post('/eingang/korrespondenten', pflegen, async (req) => {
    const k = korrBody.parse(req.body);
    const [da] = await DB`select 1 from tco.eing_korrespondenten where lower(name) = ${k.name.toLowerCase()}`;
    if (da) throw new BusinessError(`Den Korrespondenten „${k.name}“ gibt es schon.`);
    const [neu] = await change(req, (tx) => tx`insert into tco.eing_korrespondenten (name, kurz, adressen) values (${k.name}, ${k.kurz}, ${k.adressen}) returning id`);
    return { id: neu.id as number, text: `Korrespondent „${k.name}“ angelegt.` };
  });

  app.put('/eingang/korrespondenten/:id', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const k = korrBody.parse(req.body);
    const [da] = await DB`select 1 from tco.eing_korrespondenten where lower(name) = ${k.name.toLowerCase()} and id <> ${id}`;
    if (da) throw new BusinessError(`Den Korrespondenten „${k.name}“ gibt es schon.`);
    const n = await change(req, (tx) => tx`update tco.eing_korrespondenten set name = ${k.name}, kurz = ${k.kurz}, adressen = ${k.adressen} where id = ${id}`);
    if (!n.count) throw new BusinessError('Den Korrespondenten gibt es nicht (mehr).', 404);
    return { text: `Korrespondent „${k.name}“ gespeichert.` };
  });

  app.delete('/eingang/korrespondenten/:id', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const n = await change(req, (tx) => tx`delete from tco.eing_korrespondenten where id = ${id}`);
    if (!n.count) throw new BusinessError('Den Korrespondenten gibt es nicht (mehr).', 404);
    return { text: 'Korrespondent gelöscht.' };
  });

  // ---------------------------------------------------------------- Prüfliste und Protokoll
  app.get('/eingang/vorgaenge', sehen, async (req) => {
    const f = z.object({
      status: z.enum(['offen', 'pruefen', 'fehler', 'abgelegt', 'ohne_regel', 'ignoriert']).or(z.literal('')).optional().transform((x) => x || null),
      suche: z.string().trim().max(120).optional().transform((x) => x || null),
    }).parse(req.query);
    const muster = f.suche ? `%${f.suche.replace(/[%_\\]/g, '\\$&')}%` : null;
    const MAX = 300;
    const rows = await DB`
      select v.id, v.postfach, v.von, v.von_name, v.betreff, to_char(v.datum at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as datum,
             to_char(v.eingang_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as eingang_am, v.status, v.hinweis, v.korrespondent,
             v.mitglied_adrnr, v.mail_aktion, v.mail_erledigt_am is not null as mail_erledigt
        from tco.eing_vorgaenge v
       where true
             ${f.status === 'offen' ? DB`and v.status in ('pruefen', 'fehler')` : f.status ? DB`and v.status = ${f.status}` : DB``}
             ${muster ? DB`and (v.von ilike ${muster} or v.von_name ilike ${muster} or v.betreff ilike ${muster} or v.korrespondent ilike ${muster}
                              or exists (select 1 from tco.eing_dokumente d where d.vorgang_id = v.id and d.datei ilike ${muster}))` : DB``}
       order by v.id desc limit ${MAX + 1}`;
    const liste = rows.slice(0, MAX);
    const docs = liste.length ? await DB`
      select id, vorgang_id, art, datei, mime, groesse, status, hinweis, regel_id, regel_name, zuordnung, paperless_id, nextcloud_pfad, inhalt is not null as vorhanden,
             to_char(bearbeitet_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as bearbeitet_am, bearbeitet_von
        from tco.eing_dokumente where vorgang_id = any(${liste.map((v) => String(v.id))}::text[]::bigint[]) order by id` : [];
    const jeVorgang = new Map<string, Record<string, unknown>[]>();
    for (const { vorgang_id, ...d } of docs) {
      const key = String(vorgang_id);
      jeVorgang.set(key, [...(jeVorgang.get(key) ?? []), { ...d, id: Number(d.id) }]);
    }
    const [zahlen] = await DB`select count(*) filter (where status = 'pruefen')::int as pruefen, count(*) filter (where status = 'fehler')::int as fehler from tco.eing_vorgaenge`;
    return {
      vorgaenge: liste.map((v) => ({ ...v, id: Number(v.id), dokumente: jeVorgang.get(String(v.id)) ?? [] })),
      gekuerzt: rows.length > MAX, offen: { pruefen: zahlen.pruefen as number, fehler: zahlen.fehler as number },
    };
  });

  /** Die E-Mail eines Vorgangs: Kopfdaten, Text, Anhänge – zu jeder E-Mail, auch nach dem Abschluss */
  app.get('/eingang/vorgaenge/:id/text', pflegen, async (req) => mailLesen(idParam.parse(req.params).id));

  /** Gesamter Inhalt der E-Mail als PDF (Vorschau) – in dieser Form wird sie auch in Paperless abgelegt */
  app.get('/eingang/vorgaenge/:id/mail.pdf', pflegen, async (req, reply) => {
    const { datei, pdf } = await mailPdf(idParam.parse(req.params).id);
    return reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(datei)}`).send(pdf);
  });

  /** Die E-Mail als PDF-Dokument in die Prüfliste stellen; abgelegt wird sie dort über POST /eingang/dokumente/:id/ablegen */
  app.post('/eingang/vorgaenge/:id/mail-dokument', pflegen, async (req) => mailDokumentAnlegen(idParam.parse(req.params).id));

  /** Datei eines offenen Dokuments ansehen (nach der Ablage liegt sie nur noch in Paperless) */
  app.get('/eingang/dokumente/:id/datei', pflegen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [d] = await DB`select art, datei, mime, inhalt from tco.eing_dokumente where id = ${id}`;
    if (!d?.inhalt) throw new BusinessError('Die Datei liegt nicht (mehr) im Portal.', 404);
    // die E-Mail selbst ist ein vom Portal erzeugtes Text-HTML; fremde Dateien nur anzeigen, wenn der Typ unbedenklich ist
    const eigen = d.art === 'mail';
    const mime = eigen ? 'text/html; charset=utf-8' : (d.mime as string | null) ?? 'application/octet-stream';
    const anzeigen = eigen || ANZEIGBAR.test(mime);
    const name = encodeURIComponent(d.datei as string);
    return reply
      .type(anzeigen ? mime : 'application/octet-stream')
      .header('content-disposition', `${anzeigen ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
      .header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(d.inhalt as string, 'base64'));
  });

  app.post('/eingang/dokumente/:id/ablegen', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({
      regel_id: z.number().int().positive().nullish(),
      paperless: paperlessRegel.nullish(),
      nextcloud: nextcloud.nullish(),
      mail: mailAktion.nullish(),
    }).parse(req.body);
    return dokumentAblegen(id, b, wer(req));
  });

  app.post('/eingang/dokumente/:id/ignorieren', pflegen, async (req) => dokumentIgnorieren(idParam.parse(req.params).id, wer(req)));
  app.post('/eingang/vorgaenge/:id/neu-bewerten', pflegen, async (req) => neuBewerten(idParam.parse(req.params).id, wer(req)));
  /** Prüfliste: Regeln mit Angabe, ob sie auf den Vorgang passen, und eine bestehende Regel von Hand zuordnen */
  app.get('/eingang/vorgaenge/:id/regeln', pflegen, async (req) => regelnFuerVorgang(idParam.parse(req.params).id));
  app.post('/eingang/vorgaenge/:id/regel', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const { regel_id } = z.object({ regel_id: z.number().int().positive() }).parse(req.body);
    return regelZuordnen(id, regel_id, wer(req));
  });
  /** ausstehende Behandlung der E-Mail ändern (null = E-Mail unverändert lassen) */
  app.put('/eingang/vorgaenge/:id/mail', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const { mail } = z.object({ mail: mailAktion.nullable() }).parse(req.body);
    return mailAktionAendern(id, mail, wer(req));
  });
  app.post('/eingang/vorgaenge/:id/ignorieren', pflegen, async (req) => vorgangIgnorieren(idParam.parse(req.params).id, wer(req)));

  /**
   * „Posteingang abrufen“: das Regelwerk erneut auf alle offenen Vorgänge anwenden und n8n anstoßen, alle E-Mails des
   * Posteingangs erneut zu liefern. Bekannte E-Mails bleiben unverändert, nur solche „ohne Regel“ werden neu bewertet.
   */
  app.post('/eingang/abruf', pflegen, async (req) => {
    const b = await offeneNeuBewerten(wer(req));
    const bewertet = b.vorgaenge
      ? `${b.dokumente} offene${b.dokumente === 1 ? 's Dokument' : ' Dokumente'} in ${b.vorgaenge} ${b.vorgaenge === 1 ? 'Vorgang' : 'Vorgängen'} neu bewertet.`
      : 'Keine offenen Dokumente in der Prüfliste.';
    const v = await verbindungLesen(V_MAILABRUF);
    if (!eingerichtet(v)) {
      return { abruf: false, text: `${bewertet} Kein Abruf aus dem Postfach: Die Anbindung „Maileingang jetzt abrufen (n8n)“ ist nicht eingerichtet (Administration → Schnittstellen → Anbindungen).` };
    }
    try {
      // überwacht (#232, V1): Scheitert der Anstoß, steht die Störung im Arbeitsvorrat, bis der nächste klappt
      const text = await tcoSchnittstelle(V_MAILABRUF, 'Maileingang jetzt abrufen (n8n)', () => mailabrufAnstossen(v, `Portal (${wer(req)})`));
      return { abruf: true, text: `${bewertet} ${text}` };
    } catch (e) {
      throw new BusinessError(`${bewertet} Abruf aus dem Postfach fehlgeschlagen: ${(e as Error).message}`);
    }
  });

  /** Vorgang verwerfen: liegt die E-Mail noch im Postfach, liest n8n sie beim nächsten „Posteingang abrufen“ neu ein (z. B. nach einer neuen Regel) */
  app.delete('/eingang/vorgaenge/:id', pflegen, async (req) => {
    const { id } = idParam.parse(req.params);
    const n = await DB`delete from tco.eing_vorgaenge where id = ${id}`;
    if (!n.count) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
    return { text: 'Vorgang verworfen – die E-Mail wird mit „Posteingang abrufen“ neu eingelesen, wenn sie noch im Postfach liegt.' };
  });

  // ---------------------------------------------------------------- Schnittstelle für n8n (API-Schlüssel mit tco.eingang:melden)
  /** Welche E-Mails des Postfachs sind neu, und für welche bekannten steht die Behandlung noch aus? */
  app.post('/eingang/abgleich', melden, async (req) => {
    const b = z.object({
      postfach: z.string().trim().max(300).nullish().transform((x) => x ?? ''),
      mails: z.array(z.object({
        message_id: z.string().max(1000),
        uid: z.union([z.string().max(100), z.number()]).nullish().transform((x) => (x == null ? null : String(x))),
      })).max(2000),
    }).parse(req.body);
    return abgleich(b.postfach, b.mails);
  });

  /** alle E-Mails, deren Behandlung (verschieben, gelesen, löschen) noch aussteht – optional je Postfach */
  app.get('/eingang/mailaktionen', melden, async (req) => {
    const q = z.object({ postfach: z.string().trim().max(300).optional().transform((x) => x || null) }).parse(req.query);
    return ausstehendeAktionen(q.postfach);
  });

  /** E-Mail samt Anhängen liefern; Antwort: Vorgang, Dokumente und – wenn alles abgelegt ist – die Behandlung der E-Mail */
  app.post('/eingang/mail', { ...melden, bodyLimit: 80 * 1024 * 1024 }, async (req) => mailVerarbeiten(eingang.parse(req.body)));

  /** n8n hat die E-Mail verschoben/markiert/gelöscht */
  app.post('/eingang/vorgaenge/:id/mail-erledigt', melden, async (req) => {
    const { id } = idParam.parse(req.params);
    const n = await DB`update tco.eing_vorgaenge set mail_erledigt_am = coalesce(mail_erledigt_am, now()) where id = ${id}`;
    if (!n.count) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
    return { ok: true };
  });

  /** Stand eines Vorgangs (n8n und Oberfläche) */
  app.get('/eingang/vorgaenge/:id', { preHandler: requireAuth() }, async (req, reply) => {
    if (!can(req, P_EING.display) && !can(req, P_EING.melden)) return reply.code(403).send({ message: `Keine Berechtigung (${P_EING.display}).` });
    return vorgangAntwort(idParam.parse(req.params).id, false);
  });
}
