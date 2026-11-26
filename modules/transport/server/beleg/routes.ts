import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { sql } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { funktionAktiv } from '../../../../server/src/funktionsschalter.js';
import { typAusInhalt } from '../../../../server/src/lib/dateityp.js';
import { bildart, bildText, pdfScanText, pdfText } from '../../../../server/src/lib/texterkennung.js';
import { isoDate, werteLesen } from '../data.js';
import { P_MW } from '../mailworkflows.js';
import { LAYOUTS, belegAbgleichen, ordernummernImBeleg, wirksameProfile, type AuftragKurz, type Kontakt } from './abgleich.js';
import { belegErkennen } from './erkennung.js';
import type { BelegLayout, BelegProfil, BelegVorschlag } from './typen.js';

/**
 * Euroflex „Auftrag aus Beleg“ (Belegerfassung): Ein Frachtauftrag des Kunden (PDF/Bild) wird gelesen und als Vorschlag für die
 * Erfassungsmaske geliefert. Doku: docs/euroflex-belegerfassung.md
 *  - transport.belegerfassung:create  Beleg hochladen und lesen lassen (Drag & Drop in Auftragsliste/Neuanlage)
 *  - transport.belegeingang:create    dasselbe für ein Dokument aus dem Posteingang
 *  - transport.leseprofile:edit       Leseprofile pflegen (Bezeichnung, aktiv, bevorzugter Kunde)
 * Keine dieser Routen legt einen Auftrag an oder legt eine Datei ab – gespeichert wird erst in der Maske durch den Benutzer.
 */
export const P_BELEG = {
  /** Auftrag aus Beleg: Datei lesen lassen und die Erfassungsmaske vorfüllen */
  erfassung: 'transport.belegerfassung:create',
  /** Auftrag aus einem Dokument des Posteingangs vorbereiten */
  eingang: 'transport.belegeingang:create',
  /** Leseprofile pflegen */
  profile: 'transport.leseprofile:edit',
} as const;

/** Funktionsschalter (Administration → Funktionen) */
export const F_BELEG = {
  erfassung: 'transport.beleg.erfassung',
  eingang: 'transport.beleg.eingang',
  profile: 'transport.beleg.profile',
} as const;

/** weniger lesbare Zeichen in der Textebene eines PDFs = vermutlich ein Scan → Seiten per Texterkennung lesen */
const MIN_ZEICHEN = 40;
/** so viel vom gelesenen Text geht zur Kontrolle an die Oberfläche */
const MAX_TEXT = 30_000;
const zeichen = (s: string) => s.replace(/\s+/g, '').length;

/** Text eines Belegs lesen: PDF über die Textebene (Scan: Texterkennung der Seiten), PNG/JPEG über die Texterkennung */
async function dateiText(daten: Buffer): Promise<string> {
  if (!daten.length) throw new BusinessError('Die Datei ist leer.');
  if (typAusInhalt(daten) === 'application/pdf') {
    // „%PDF-“ darf nach einem Vorspann stehen (Scanner) – die Leseprogramme erwarten es am Anfang
    const ab = daten.subarray(0, 1024).indexOf('%PDF-');
    const pdf = ab > 0 ? daten.subarray(ab) : daten;
    const t = (await pdfText(pdf)).trim();
    if (zeichen(t) >= MIN_ZEICHEN) return t;
    const s = (await pdfScanText(pdf)).trim();
    return zeichen(s) > zeichen(t) ? s : t;
  }
  if (bildart(daten)) return (await bildText(daten)).trim();
  throw new BusinessError('Dieser Dateityp kann nicht gelesen werden – bitte ein PDF oder ein Bild (PNG, JPEG) verwenden.');
}

/** Leseprofile aus der Tabelle – alle drei Layouts in fester Reihenfolge, fehlende Zeilen mit den Standardwerten */
async function profileLesen(): Promise<BelegProfil[]> {
  const rows = await sql`
    select p.layout, p.bezeichnung, p.aktiv, p.kunde, nullif(btrim(concat_ws(' ', k.kundenname, k.kundenname2)), '') as kunde_name
      from transport.beleg_profile p left join transport.adressen k on k.adrnr = p.kunde`;
  return wirksameProfile(rows.map((r): BelegProfil => ({
    layout: r.layout as BelegLayout, bezeichnung: r.bezeichnung as string, aktiv: r.aktiv as boolean,
    kunde: (r.kunde as number | null) ?? null, kunde_name: (r.kunde_name as string | null) ?? null,
  })), true);
}

/** Gelesener Text → Erkennung → Abgleich mit Kontakten, Wertelisten und vorhandenen Aufträgen. Liest nur, schreibt nichts. */
async function vorschlagAusText(roh: string): Promise<BelegVorschlag> {
  const text = roh.replace(/\u0000/g, '').trim();
  if (!zeichen(text)) throw new BusinessError('Im Beleg wurde kein Text erkannt – bitte den Auftrag von Hand erfassen.');
  // Funktion „Leseprofile pflegen“ abgeschaltet: alle Layouts aktiv, kein bevorzugter Kunde
  const profile = wirksameProfile(await profileLesen(), funktionAktiv(F_BELEG.profile));
  const aktiv = profile.filter((p) => p.aktiv).map((p) => p.layout);
  if (!aktiv.length) {
    throw new BusinessError('Alle Leseprofile sind abgeschaltet – bitte mindestens eines aktivieren (Administration → Einstellungen → Euroflex → Leseprofile).');
  }
  const e = belegErkennen(text, aktiv);
  const profil = profile.find((p) => p.layout === e.layout) ?? profile[profile.length - 1];

  const kontakte = (await sql`
    select adrnr, kundenname, kundenname2, strasse, plz, ort from transport.adressen
     where coalesce(kundenname, '') <> '' or coalesce(kundenname2, '') <> '' order by adrnr`)
    .map((r): Kontakt => ({
      adrnr: Number(r.adrnr), kundenname: r.kundenname as string | null, kundenname2: r.kundenname2 as string | null,
      strasse: r.strasse as string | null, plz: r.plz as string | null, ort: r.ort as string | null,
    }));
  const nummern = ordernummernImBeleg(e.ordernummer);
  const auftraege: AuftragKurz[] = nummern.length ? (await sql`
    select a.auftragsnr, a.anlagedatum, a.ordernummer, nullif(btrim(concat_ws(' ', k.kundenname, k.kundenname2)), '') as kunde
      from transport.auftraege a left join transport.adressen k on k.adrnr = a.kunde
     where lower(btrim(a.ordernummer)) = any(${nummern})
     order by a.auftragsnr desc limit 50`)
    .map((r): AuftragKurz => ({
      auftragsnr: r.auftragsnr as string, anlagedatum: isoDate(r.anlagedatum), ordernummer: r.ordernummer as string | null, kunde: (r.kunde as string | null) ?? null,
    })) : [];
  return belegAbgleichen(e, {
    kontakte, werte: await werteLesen(), auftraege,
    profil: { bezeichnung: profil.bezeichnung, kunde: profil.kunde },
    text: text.slice(0, MAX_TEXT),
  });
}

const layoutParam = z.object({ layout: z.enum(LAYOUTS as [BelegLayout, ...BelegLayout[]]) });

export async function belegRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Beleg lesen (Drag & Drop)
  /**
   * Beleg (PDF, PNG, JPEG) lesen und als Vorschlag für die Erfassungsmaske liefern. inhalt: Data-URL oder Base64.
   * Auch ein Beleg, der nicht nach einem Frachtauftrag aussieht, ergibt eine Antwort (istFrachtauftrag = false, Felder leer).
   */
  app.post('/auftraege/beleg/erkennen', { preHandler: requireAuth(P_BELEG.erfassung), bodyLimit: 25 * 1024 * 1024 }, async (req): Promise<BelegVorschlag> => {
    const b = z.object({
      name: z.string().trim().min(1, 'Der Dateiname fehlt.').max(500),
      inhalt: z.string().min(1, 'Die Datei ist leer.'),
    }).parse(req.body);
    const daten = Buffer.from(b.inhalt.replace(/^data:[^,]*,/, ''), 'base64');
    return vorschlagAusText(await dateiText(daten));
  });

  // ---------------------------------------------------------------- Dokument aus dem Posteingang
  /**
   * Dokument des Posteingangs als Vorschlag für einen neuen Auftrag. Der beim Eingang gelesene Text wird wiederverwendet;
   * fehlt er, wird die Datei neu gelesen – solange ihr Inhalt im Portal liegt. Am Dokument und am Vorgang ändert sich nichts.
   */
  app.post('/eingang/dokumente/:id/beleg', { preHandler: requireAuth(P_BELEG.eingang) }, async (req, reply) => {
    if (!can(req, P_MW.eingangEdit)) return reply.code(403).send({ message: `Keine Berechtigung (${P_MW.eingangEdit}).` });
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const [d] = await sql`select datei, inhalt, ocr_text from transport.eing_dokumente where id = ${id}`;
    if (!d) throw new BusinessError('Das Dokument gibt es nicht (mehr).', 404);
    let text = String(d.ocr_text ?? '').trim();
    if (!text) {
      if (!d.inhalt) {
        throw new BusinessError(`Die Datei „${d.datei as string}“ liegt nicht mehr im Portal und es ist kein gelesener Text gespeichert – `
          + 'bitte die Datei aus der Ablage in die Auftragsliste ziehen.', 404);
      }
      text = await dateiText(Buffer.from(d.inhalt as string, 'base64'));
    }
    return vorschlagAusText(text);
  });

  // ---------------------------------------------------------------- Leseprofile
  const pflege = { preHandler: requireAuth(P_BELEG.profile) };

  app.get('/beleg/profile', pflege, async (): Promise<BelegProfil[]> => profileLesen());

  app.put('/beleg/profile/:layout', pflege, async (req): Promise<BelegProfil> => {
    const { layout } = layoutParam.parse(req.params);
    const b = z.object({
      bezeichnung: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben.').max(80),
      aktiv: z.boolean(),
      kunde: z.coerce.number().int().positive().nullish().transform((v) => v ?? null),
    }).parse(req.body);
    await change(req, async (tx) => {
      if (b.kunde != null) {
        const [k] = await tx`select 1 from transport.adressen where adrnr = ${b.kunde}`;
        if (!k) throw new BusinessError(`Kontakt ${b.kunde} existiert nicht.`);
      }
      if (!b.aktiv) {
        const [andere] = await tx`select 1 from transport.beleg_profile where aktiv and layout <> ${layout} limit 1`;
        if (!andere) throw new BusinessError('Mindestens ein Leseprofil muss aktiv bleiben.');
      }
      await tx`insert into transport.beleg_profile (layout, bezeichnung, aktiv, kunde) values (${layout}, ${b.bezeichnung}, ${b.aktiv}, ${b.kunde})
               on conflict (layout) do update set bezeichnung = excluded.bezeichnung, aktiv = excluded.aktiv, kunde = excluded.kunde`;
    });
    return (await profileLesen()).find((p) => p.layout === layout)!;
  });
}
