import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../../../server/src/db.js';
import { can, changeCtx, requireAuth } from '../../../server/src/auth.js';
import { belegeImHintergrund, versendeteBelege } from './archiv.js';
import { BusinessError } from '../../../server/src/errors.js';
import { funktionAktiv } from '../../../server/src/funktionsschalter.js';
import { auftragLesen, fahrtenFuerVersand, firmaLesen, kaeufer, type Adresse } from './data.js';
import { dokumentPdf } from './pdf/erzeugen.js';
import { xrechnungErzeugen } from './xrechnung.js';
import { DATEITYPEN, endung, mimeTyp, paperlessFirma } from './dokumente.js';
import { euroflexMailSenden, mailInfo, versandBereit, type VersandDatei } from './mailversand.js';
import { DOKUMENTARTEN, F_MW, P_MW, versandRegeln, type VersandRegeln, workflowEinstellungen } from './mailworkflows.js';
import {
  artenOrdnen, emlBauen, emlDateiname, mailsPlanen, modusFuer, regelSchluessel,
  type Art, type Empfaenger, type GeplanteMail, type MailtextVorlage, type Modus, type VersandDokument,
  zusatzVerteilen,
} from './sammelversand-logik.js';

/**
 * Sammelversand „Versenden…“ aus Auftragsliste und Auftragsdetail über den n8n-Workflow „Euroflex Mailversand“.
 * Vertrag: docs/euroflex-mailworkflows.md, Abschnitt „Ausgang (Sammelversand)“; Regeln: sammelversand-logik.ts.
 *
 * Der Server erzeugt die PDFs selbst (wie GET /pdf/:art/:id) und ruft je E-Mail euroflexMailSenden auf – damit gelten Postfach je
 * Benutzer, feste Kopieadresse und E-Mail-Protokoll wie beim Einzelversand. „Ausführen“ und „EML“ rechnen die Vorschau neu und
 * übernehmen aus der Anfrage nur An, CC, Betreff und Text je E-Mail.
 */

const P_VERSAND = 'transport.versand:execute';
const ERLAUBT = [...DATEITYPEN, 'xml', 'zip'];

const auswahlSchema = z.object({
  auftraege: z.array(z.string().trim().min(1).max(40)).min(1, 'Bitte mindestens einen Auftrag auswählen.').max(200),
  arten: z.array(z.enum(['T', 'L', 'R'])).min(1, 'Bitte mindestens eine Dokumentart wählen.'),
  xrechnung: z.boolean().default(false),
});
const ausfuehrenSchema = auswahlSchema.extend({
  mails: z.array(z.object({
    schluessel: z.string().max(200),
    an: z.string().trim().max(500).default(''),
    cc: z.string().trim().max(500).default(''),
    betreff: z.string().trim().max(200).default(''),
    text: z.string().max(20_000).default(''),
  })).min(1, 'Es ist keine E-Mail ausgewählt.').max(500),
  zusatz: z.array(z.object({
    name: z.string().trim().min(1).max(200), mime: z.string().max(200).default(''), inhalt_base64: z.string().min(1, 'Die Datei ist leer.'),
  })).max(30).default([]),
  paperless: z.array(z.coerce.number().int().positive()).max(30).default([]),
  /** Erweiterung zum Vertrag: true = alle E-Mails nur als Entwurf (Schalter „In Outlook-Entwürfe legen“) */
  nur_entwurf: z.boolean().default(false),
});
type Auswahl = z.infer<typeof auswahlSchema>;

const empfaenger = (a: Adresse | null): Empfaenger | null => (a ? {
  adrnr: a.adrnr, kundenname: a.kundenname, email: a.email, land: a.land, anrede: a.anrede, vorname: a.vorname, name: a.name,
} : null);
const benutzerName = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const fehlerText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** „senden“ nur mit Funktion „Automatisch senden“ und Recht transport.versandsenden:execute – der Server prüft, die Oberfläche zeigt an */
const sendenErlaubt = (req: FastifyRequest) => funktionAktiv(F_MW.versandAutomatisch) && can(req, P_MW.versandSenden);

/** Dokumente der Auswahl in fester Reihenfolge: Aufträge wie ausgewählt, je Auftrag T je Fahrt, L, R */
async function dokumenteSammeln(b: Auswahl): Promise<VersandDokument[]> {
  const arten = artenOrdnen(b.arten);
  const docs: VersandDokument[] = [];
  for (const nr of [...new Set(b.auftraege)]) {
    const a = await auftragLesen(nr);
    for (const art of arten) {
      if (art === 'T') {
        // je Fahrt ein Transportauftrag an deren Unternehmer (Nummer „Auftrag-Fahrt“ bei mehreren Fahrten)
        const fahrten = await fahrtenFuerVersand(nr);
        const pos = [1, ...a.fahrten.map((f) => f.pos)];
        fahrten.forEach((f, i) => docs.push({
          auftragsnr: nr, art, ...(fahrten.length > 1 ? { fahrt: pos[i] ?? i + 1 } : {}), kennung: f.kennung, faktura: a.faktura,
          empfaenger: empfaenger(f.auftrag.unternehmerAdr),
        }));
      } else if (art === 'L') {
        docs.push({ auftragsnr: nr, art, kennung: nr, faktura: a.faktura, empfaenger: empfaenger(a.kundeAdr) });
      } else if (a.faktura) {
        // Rechnung nur bei fakturierten Aufträgen: an den Rechnungsempfänger, sonst an den Kunden
        docs.push({ auftragsnr: nr, art, kennung: a.faktura, faktura: a.faktura, empfaenger: empfaenger(kaeufer(a)) });
      }
    }
  }
  return docs;
}

interface Anlagen { dateien: VersandDatei[]; hinweise: string[] }

/** PDFs (und XRechnung) je Dokument – innerhalb einer Anfrage nur einmal erzeugt */
function anlagenErzeuger(xrechnung: boolean) {
  const cache = new Map<string, Promise<Anlagen>>();
  const eins = (d: VersandDokument): Promise<Anlagen> => {
    const k = `${d.art}:${d.kennung}`;
    let p = cache.get(k);
    if (!p) {
      p = (async () => {
        const { pdf, name } = await dokumentPdf(d.art, d.kennung);
        const res: Anlagen = { dateien: [{ name, daten: pdf, mime: 'application/pdf' }], hinweise: [] };
        if (d.art === 'R' && xrechnung) {
          const x = await xrechnungErzeugen(d.kennung);
          if (x.xml) res.dateien.push({ name: x.filename, daten: Buffer.from(x.xml, 'utf8'), mime: 'application/xml' });
          else res.hinweise.push(`XRechnung ${d.kennung} nicht angehängt: ${x.hinweise.join(' ')}`);
        }
        return res;
      })();
      cache.set(k, p);
    }
    return p;
  };
  return async (m: GeplanteMail): Promise<Anlagen> => {
    const res: Anlagen = { dateien: [], hinweise: [] };
    for (const d of m.dokumente) {
      const a = await eins(d);
      res.dateien.push(...a.dateien);
      res.hinweise.push(...a.hinweise);
    }
    return res;
  };
}

interface VorschauMail {
  schluessel: string; auftragsnr: string; fahrt?: number; rolle: GeplanteMail['rolle']; empfaenger_name: string | null;
  an: string; cc: string; betreff: string; text: string; arten: Art[]; anhaenge: { name: string; groesse: number }[]; modus: Modus;
  fehler?: string; hinweis?: string;
  /** festes Absender-Postfach und BCC der Dokumentart (Funktion „Versand: Absender je Dokumentart und BCC“) */
  absender?: string; bcc?: string;
}

/** Absender/BCC einer E-Mail: Regel ihrer ersten Art – alle Arten einer E-Mail haben dieselbe (mailsPlanen, gruppe) */
const regelFuer = (m: GeplanteMail, regeln: VersandRegeln) => regeln[m.arten[0]] ?? { absender: null, bcc: [] };
async function vorschauRechnen(req: FastifyRequest, b: Auswahl, nurEntwurf: boolean) {
  const vorlagen = (await sql`select art, sprache, text from transport.mailtexte`) as unknown as MailtextVorlage[];
  const regeln = await versandRegeln();
  const geplant = mailsPlanen(await dokumenteSammeln(b), vorlagen, {
    rechnungEinzeln: !!(regeln.R.absender || regeln.R.bcc.length),
    gruppe: (a) => regelSchluessel(regeln[a]),
  });
  const { versand } = await workflowEinstellungen();
  const erlaubt = sendenErlaubt(req);
  const anlagen = anlagenErzeuger(b.xrechnung);
  const mails: { plan: GeplanteMail; vorschau: VorschauMail; anlagen: Anlagen | null }[] = [];
  for (const m of geplant) {
    let a: Anlagen | null = null;
    let fehler: string | undefined;
    try { a = await anlagen(m); } catch (e) { fehler = `Dokument konnte nicht erzeugt werden: ${fehlerText(e)}`; }
    if (!fehler && !m.an) fehler = 'Empfänger fehlt';
    const regel = regelFuer(m, regeln);
    // weitere Auftragsdateien gehen an den Empfänger; die BCC-Adresse bekommt dann eine eigene E-Mail nur mit den Belegen
    const hinweise = [...(a?.hinweise ?? []), ...(regel.bcc.length ? [`Mit weiteren Dateien bekommt ${regel.bcc.join(', ')} eine eigene E-Mail nur mit den Belegen (ohne BCC an der E-Mail an den Empfänger).`] : [])];
    mails.push({
      plan: m,
      anlagen: a,
      vorschau: {
        schluessel: m.schluessel, auftragsnr: m.auftragsnr, ...(m.fahrt ? { fahrt: m.fahrt } : {}), rolle: m.rolle,
        empfaenger_name: m.empfaenger?.kundenname ?? null, an: m.an, cc: '', betreff: m.betreff, text: m.text, arten: m.arten,
        anhaenge: (a?.dateien ?? []).map((d) => ({ name: d.name, groesse: d.daten.length })),
        modus: modusFuer(m.arten, versand, erlaubt, nurEntwurf),
        ...(fehler ? { fehler } : {}),
        ...(hinweise.length ? { hinweis: hinweise.join(' ') } : {}),
        ...(regel.absender ? { absender: regel.absender } : {}),
        ...(regel.bcc.length ? { bcc: regel.bcc.join(', ') } : {}),
      },
    });
  }
  return { mails, senden_erlaubt: erlaubt, regeln };
}

/** Dateien aus dem Ablageordner (Browser, Base64) und Paperless-Dokumente des einen Auftrags */
async function zusatzLaden(b: z.infer<typeof ausfuehrenSchema>): Promise<VersandDatei[]> {
  const dateien: VersandDatei[] = b.zusatz.map((d) => {
    const name = d.name.split(/[\\/]/).pop()!.trim();
    if (!ERLAUBT.includes(endung(name))) throw new BusinessError(`„${name}“: Dateityp wird als Anhang nicht unterstützt (erlaubt: ${ERLAUBT.join(', ')}).`);
    const daten = Buffer.from(d.inhalt_base64.replace(/^data:[^,]*,/, ''), 'base64');
    if (!daten.length) throw new BusinessError(`„${name}“ ist leer.`);
    return { name, daten, mime: d.mime.trim() || mimeTyp(name) };
  });
  const ids = [...new Set(b.paperless)];
  if (ids.length) {
    const auftraege = [...new Set(b.auftraege)];
    if (auftraege.length !== 1) throw new BusinessError('Paperless-Dokumente lassen sich nur beim Versand eines einzelnen Auftrags anhängen.');
    const nr = auftraege[0];
    // nur Dokumente, die diesem Auftrag zugeordnet sind (wie GET /auftraege/:nr/dokumente/:id/datei)
    const rows = await sql`select doc_id, titel, datei from transport.auftrag_dokumente where auftragsnr = ${nr} and doc_id = any(${ids}::int[])`;
    const fehlt = ids.filter((id) => !rows.some((r) => r.doc_id === id));
    if (fehlt.length) throw new BusinessError(`Dokument ${fehlt.join(', ')} ist dem Auftrag ${nr} nicht zugeordnet.`);
    const pl = paperlessFirma(await firmaLesen());
    for (const id of ids) {
      const row = rows.find((r) => r.doc_id === id)!;
      const d = await pl.download(id);
      const pdf = /pdf/i.test(d.contentType);
      const name = row.datei && (!pdf || /\.pdf$/i.test(row.datei)) ? row.datei as string : d.filename;
      dateien.push({ name, daten: d.data, mime: pdf ? 'application/pdf' : d.contentType.split(';')[0].trim() || mimeTyp(name) });
    }
  }
  return dateien;
}

export async function sammelversandRoutes(app: FastifyInstance) {
  /** Vorauswahl der Dokumentarten und Stand der Anbindung – eigenes Recht statt GET /workflow-einstellungen (stammdaten) */
  app.get('/versand/einstellungen', { preHandler: requireAuth(P_VERSAND) }, async (req) => {
    const { versand } = await workflowEinstellungen();
    const info = await mailInfo();
    const regeln = await versandRegeln();
    return {
      vorauswahl: DOKUMENTARTEN.filter((a) => versand[a].vorauswahl),
      modus: Object.fromEntries(DOKUMENTARTEN.map((a) => [a, versand[a].modus])) as Record<Art, Modus>,
      senden_erlaubt: sendenErlaubt(req),
      eingerichtet: info.eingerichtet, postfach: info.postfach, kopie_an: info.kopieAn, max_mb: info.maxMb,
      // Absender/BCC je Dokumentart (rechnung = R, für ältere Oberflächen)
      absender: regeln, rechnung: regeln.R,
    };
  });

  app.post('/versand/vorschau', { preHandler: requireAuth(P_VERSAND) }, async (req) => {
    const b = auswahlSchema.parse(req.body);
    const r = await vorschauRechnen(req, b, false);
    return { mails: r.mails.map((m) => m.vorschau), senden_erlaubt: r.senden_erlaubt };
  });

  app.post('/versand/ausfuehren', { preHandler: requireAuth(P_VERSAND), bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const b = ausfuehrenSchema.parse(req.body);
    // Einrichtung und Postfach zuerst – erst danach Dokumente erzeugen und Dateien holen. Nur Rechnungen: das Postfach des
    // Rechnungsversands genügt, der Benutzer braucht kein eigenes
    // Einrichtung und Postfach zuerst. Haben alle gewählten Arten ein festes Absender-Postfach, braucht der Benutzer kein eigenes
    const regelnVorab = await versandRegeln();
    const arten = artenOrdnen(b.arten);
    const alleFest = arten.length > 0 && arten.every((a) => !!regelnVorab[a].absender);
    await versandBereit(alleFest ? regelnVorab[arten[0]].absender : undefined);
    const zusatz = await zusatzLaden(b);
    const plan = await vorschauRechnen(req, b, b.nur_entwurf);
    const ergebnisse: { schluessel: string; status: 'entwurf' | 'gesendet' | 'fehler'; text: string }[] = [];
    const versendet: ReturnType<typeof versendeteBelege> = [];
    for (const w of b.mails) {
      const m = plan.mails.find((x) => x.plan.schluessel === w.schluessel);
      if (!m) { ergebnisse.push({ schluessel: w.schluessel, status: 'fehler', text: 'Diese E-Mail gehört nicht (mehr) zur Auswahl – bitte die Vorschau neu laden.' }); continue; }
      if (!w.an) { ergebnisse.push({ schluessel: w.schluessel, status: 'fehler', text: 'Empfänger fehlt – übersprungen.' }); continue; }
      if (!m.anlagen) { ergebnisse.push({ schluessel: w.schluessel, status: 'fehler', text: m.vorschau.fehler ?? 'Dokument konnte nicht erzeugt werden.' }); continue; }
      try {
        const regel = regelFuer(m.plan, plan.regeln);
        const v = zusatzVerteilen(m.anlagen.dateien, zusatz, regel.bcc);
        const betreff = w.betreff || m.plan.betreff;
        const r = await euroflexMailSenden({
          nr: m.plan.auftragsnr, modus: m.vorschau.modus, an: w.an, cc: w.cc, betreff, text: w.text,
          dateien: v.dateien, benutzer: benutzerName(req), absender: regel.absender, bcc: v.bcc,
        });
        // maßgeblich ist die E-Mail an den Empfänger; scheitert nur die Kopie an die feste zweite Adresse, steht das im Text
        const haupt = r.mails.find((x) => x.rolle === 'kunde');
        const status = haupt && haupt.status !== 'fehler' ? haupt.status : 'fehler';
        let text = r.text;
        // weitere Dateien und BCC: eigene E-Mail nur mit den Belegen an die BCC-Adresse (ohne Kopie an die feste zweite Adresse)
        if (v.beleg && status !== 'fehler') {
          try {
            const b2 = await euroflexMailSenden({
              nr: m.plan.auftragsnr, modus: m.vorschau.modus, an: v.beleg.an, cc: '', betreff, text: w.text,
              dateien: v.beleg.dateien, benutzer: benutzerName(req), absender: regel.absender, bcc: [], nur: ['kunde'],
            });
            text += ` Belege an ${v.beleg.an}: ${b2.text}`;
          } catch (e) {
            text += ` Belege an ${v.beleg.an} fehlgeschlagen: ${fehlerText(e)}`;
          }
        }
        ergebnisse.push({ schluessel: w.schluessel, status, text });
        if (status !== 'fehler') versendet.push(...versendeteBelege(m.anlagen.dateien));
      } catch (e) {
        ergebnisse.push({ schluessel: w.schluessel, status: 'fehler', text: fehlerText(e) });
      }
    }
    // versendete Belege automatisch in Paperless (Hintergrund; nur mit eingerichtetem Paperless)
    await belegeImHintergrund(versendet, { anlass: 'versand', ctx: changeCtx(req), benutzer: benutzerName(req), log: req.log });
    return { ergebnisse };
  });

  /** Rückfallweg ohne Anbindung: je E-Mail eine EML-Datei (Entwurf, X-Unsent: 1) – Aufbau wie MailEntwurf.emlErzeugen */
  app.post('/versand/eml', { preHandler: requireAuth(P_VERSAND), bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const b = ausfuehrenSchema.parse(req.body);
    const zusatz = await zusatzLaden(b);
    const plan = await vorschauRechnen(req, b, true);
    const vergeben = new Set<string>();
    const versendet: ReturnType<typeof versendeteBelege> = [];
    const dateien: { schluessel: string; name: string; inhalt_base64: string }[] = [];
    for (const w of b.mails) {
      const m = plan.mails.find((x) => x.plan.schluessel === w.schluessel);
      if (!m) throw new BusinessError('Eine E-Mail gehört nicht (mehr) zur Auswahl – bitte die Vorschau neu laden.');
      if (!m.anlagen) throw new BusinessError(`${m.plan.auftragsnr}: ${m.vorschau.fehler ?? 'Dokument konnte nicht erzeugt werden.'}`);
      const betreff = w.betreff || m.plan.betreff;
      const regel = regelFuer(m.plan, plan.regeln);
      const v = zusatzVerteilen(m.anlagen.dateien, zusatz, regel.bcc);
      const von = regel.absender ? { von: regel.absender } : {};
      const eml = emlBauen({ an: w.an, cc: w.cc, betreff, text: w.text, anhaenge: v.dateien, ...von, ...(v.bcc.length ? { bcc: v.bcc.join(', ') } : {}) });
      dateien.push({ schluessel: w.schluessel, name: emlDateiname(betreff, vergeben), inhalt_base64: Buffer.from(eml, 'utf8').toString('base64') });
      // weitere Dateien und BCC: zweite E-Mail-Datei nur mit den Belegen an die BCC-Adresse
      if (v.beleg) {
        const b2 = emlBauen({ an: v.beleg.an, betreff, text: w.text, anhaenge: v.beleg.dateien, ...von });
        dateien.push({ schluessel: w.schluessel, name: emlDateiname(`${betreff} (Belege)`, vergeben), inhalt_base64: Buffer.from(b2, 'utf8').toString('base64') });
      }
      versendet.push(...versendeteBelege(m.anlagen.dateien));
    }
    // E-Mail-Dateien zum Versenden: Belege wie beim Versand automatisch in Paperless
    await belegeImHintergrund(versendet, { anlass: 'versand', ctx: changeCtx(req), benutzer: benutzerName(req), log: req.log });
    return { dateien };
  });
}
