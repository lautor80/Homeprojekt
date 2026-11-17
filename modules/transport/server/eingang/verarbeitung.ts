/**
 * Euroflex Posteingang – Verarbeitung: E-Mail annehmen (n8n), Texterkennung, Zuordnung zum Auftrag, Ablage, Prüfliste.
 *
 * n8n liefert jede E-Mail aus dem Outlook-365-Postfach samt Anhängen (POST /eingang/mail). Das Portal legt einen Vorgang an
 * (Schlüssel Postfach + Message-ID – eine E-Mail wird nie doppelt verarbeitet), filtert Signatur-Logos und Kalenderdateien,
 * liest die Anhänge lokal (pdftotext/Tesseract), erzeugt die E-Mail selbst als PDF und ordnet sie nach Punkten einem Auftrag
 * zu (logik.ts). Eindeutige Treffer ab der Schwelle werden bei eingeschalteter Funktion „Automatisch ablegen“ sofort
 * abgelegt, alles andere steht in der Prüfliste.
 *
 * Ablage am Auftrag (Einstellung „Ablageziel“):
 *  - lokal:     Status „wartet“, der Inhalt bleibt im Portal, bis der Browser die Datei in den Ablageordner (Unterordner
 *               Eingang/) geschrieben und mit POST /eingang/dokumente/:id/uebernommen gemeldet hat – nie vorher gelöscht.
 *  - paperless: Kontext „auftrag.dokument“ (dokumente.ts), Verknüpfung in transport.auftrag_dokumente, Inhalt sofort gelöscht.
 * Fachliche Beschreibung: docs/euroflex-mailworkflows.md, Abschnitt „Eingang“.
 */
import crypto from 'node:crypto';
import { sql, withChange } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { funktionAktiv } from '../../../../server/src/funktionsschalter.js';
import { HINWEIS_DB, hinweisBeheben, hinweisMelden } from '../../../../server/src/lib/hinweise.js';
import { eingangZeit, einordnen } from '../../../../server/src/lib/maileingang.js';
import { bildart, bildText, pdfScanText, pdfText } from '../../../../server/src/lib/texterkennung.js';
import { authHeader, eingerichtet, verbindungLesen } from '../../../../server/src/lib/verbindungen.js';
import { htmlToPdf, istPdf } from '../../../../server/src/pdf.js';
import { auftragLesen, firmaLesen } from '../data.js';
import { dokumentAblegen, mimeTyp } from '../dokumente.js';
import { ANWENDUNG } from '../mailversand.js';
import { F_MW, workflowEinstellungen, type EingangEinstellungen } from '../mailworkflows.js';
import {
  absender, absenderTreffer, auftragsnummernFinden, bewerten, dateinameSicher, entscheiden, fundstellenNummer, fundstellenReferenz, fundText, htmlText, mailDateiname, mailHtml, messageIds,
  nummernVorrang, objektAuftrag, PUNKTE, referenzImText, relevanterAnhang, suchQuellen, speicherWarnung, V_MAILEINGANG, type Entscheidung, type Kandidat, type Treffer,
} from './logik.js';

/** Name für automatische Bearbeitung (n8n-Lieferung, Neubewertung ohne Benutzer) */
export const SYSTEM = 'Posteingang (automatisch)';
const MAX_TEXT = 200_000;
const MAX_OCR = 200_000;
/** größere Dateien werden nicht gelesen (Laufzeit) */
const MAX_OCR_BYTES = 15 * 1024 * 1024;

export interface EingangMail {
  postfach: string;
  graph_id: string | null;
  message_id: string;
  in_reply_to: string | null;
  references: string | null;
  /** Kopfzeile Auto-Submitted (optional) – Abwesenheitsnotizen werden nicht abgelegt */
  auto: string | null;
  von: string;
  an: string;
  betreff: string;
  datum: string | null;
  text: string;
  html: string;
  anhaenge: { name: string; mime: string | null; inhalt: string }[];
}

export type VorgangStatus = 'neu' | 'pruefen' | 'fehler' | 'abgelegt' | 'ignoriert';
export type DokStatus = 'neu' | 'wartet' | 'uebernommen' | 'abgelegt' | 'dublette' | 'ignoriert' | 'fehler';
/** Dokumente, die am Auftrag liegen (bzw. auf die Übernahme in den Ablageordner warten) */
const AM_AUFTRAG: DokStatus[] = ['wartet', 'uebernommen', 'abgelegt', 'dublette'];
const OFFEN: DokStatus[] = ['neu', 'fehler'];

export interface MailAntwort {
  vorgang: number;
  status: 'abgelegt' | 'pruefen' | 'ignoriert' | 'doppelt' | 'fehler';
  auftragsnr: string | null;
  aktion: { ordner: string };
}

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const tagBerlin = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
const zeitBerlin = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 16);
const meldung = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 1000);

/** Message-ID ohne spitze Klammern, klein; fehlt sie, ein stabiler Ersatz aus Absender, Betreff und Datum */
export function mailSchluessel(m: Pick<EingangMail, 'message_id' | 'von' | 'betreff' | 'datum'>): string {
  const id = m.message_id.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  return id || `ohne-id-${sha(`${m.von}|${m.betreff}|${m.datum ?? ''}`).slice(0, 32)}`;
}

/** Funktion „Automatisch ablegen“ an? */
function automatikAn(): boolean {
  // Funktionsschalter transport.eingang.automatik (Administration → Funktionen)
  return funktionAktiv(F_MW.eingangAutomatik);
}

const ordnerFuer = (e: EingangEinstellungen, status: string) => ({ ordner: status === 'abgelegt' ? e.ordnerZugeordnet : e.ordnerPruefen });

// ---------------------------------------------------------------- Texterkennung

/** Text eines Anhangs lokal lesen (PDF: Textebene, Bild: Tesseract); Fehler ergeben einen Hinweis, keinen Abbruch */
async function texterkennen(a: { datei: string; mime: string; daten: Buffer }): Promise<{ text: string; hinweis: string | null }> {
  if (a.daten.length > MAX_OCR_BYTES) return { text: '', hinweis: 'Texterkennung übersprungen (Datei größer als 15 MB).' };
  try {
    if (istPdf(a.mime, a.datei)) {
      const t = (await pdfText(a.daten)).trim();
      if (t) return { text: t, hinweis: null };
      // gescanntes PDF ohne Textebene: Seiten als Bild rendern und mit Tesseract lesen
      const s = (await pdfScanText(a.daten)).trim();
      return { text: s, hinweis: s ? 'Gescanntes PDF – Text per Texterkennung gelesen.' : 'PDF ohne Textebene – kein Text erkannt.' };
    }
    if (bildart(a.daten)) return { text: (await bildText(a.daten)).trim(), hinweis: null };
    return { text: '', hinweis: null };
  } catch (e) {
    return { text: '', hinweis: `Texterkennung: ${meldung(e)}` };
  }
}

// ---------------------------------------------------------------- Zuordnung

interface Suche {
  betreff: string;
  text: string;
  /** Absenderadresse (klein) */
  adresse: string;
  dateien: string[];
  /** erkannter Text je Dokument (Anhang) – für die Fundstelle mit Dateinamen */
  ocr: { datei: string; text: string }[];
  /** Treffer „Antwort auf eine eigene E-Mail“ – beim Eingang aus In-Reply-To/References, beim Neubewerten aus dem Vorgang */
  antwort: Treffer[];
}

/** Antwort auf eine E-Mail des Portals: In-Reply-To/References ↔ core.mail_protokoll.message_id (Anwendung Euroflex) */
async function antwortTreffer(inReplyTo: string | null, references: string | null): Promise<Treffer[]> {
  const ids = messageIds(inReplyTo, references);
  if (!ids.length) return [];
  const rows = await sql`select objekt from core.mail_protokoll where anwendung = ${ANWENDUNG} and message_id = any(${ids}) order by id desc`;
  const nummern = [...new Set(rows.map((r) => objektAuftrag(r.objekt as string | null)).filter((x): x is string => !!x))];
  if (!nummern.length) return [];
  const da = await sql`select auftragsnr from transport.auftraege where auftragsnr = any(${nummern})`;
  return da.map((r) => ({ auftragsnr: r.auftragsnr as string, art: 'antwort' as const, punkte: PUNKTE.antwort, grund: `Antwort auf eine E-Mail des Portals zu Auftrag ${r.auftragsnr}` }));
}

/**
 * Treffer suchen – zuerst Auftrags- und Rechnungsnummern (JJJJ_NNNN in Betreff, Mailtext, Dateinamen und Texterkennung der
 * Dokumente, mit allen Fundstellen in der Begründung), dann Order-/Ladenummern und Absender. Gibt es eine Nummer, zählen nur
 * noch die so gefundenen Aufträge (nummernVorrang). Zusammengerechnet wird in logik.ts.
 */
async function trefferSuchen(q: Suche): Promise<Treffer[]> {
  const treffer: Treffer[] = [...q.antwort];
  const quellen = suchQuellen(q);

  // 1. Auftragsnummer bzw. Rechnungsnummer (faktura), die es gibt
  const nummern = auftragsnummernFinden(...quellen.map(([, t]) => t));
  if (nummern.length) {
    const da = await sql`
      select auftragsnr, auftragsnr as nr, 'Auftragsnummer' as art from transport.auftraege where auftragsnr = any(${nummern})
      union all
      select auftragsnr, faktura, 'Rechnungsnummer' from transport.auftraege where faktura = any(${nummern})
      order by 1 desc limit 200`;
    for (const r of da) {
      const nr = r.nr as string;
      const auftrag = r.auftragsnr as string;
      const wo = fundText(fundstellenNummer(quellen, nr));
      treffer.push({
        auftragsnr: auftrag, art: 'nummer', punkte: PUNKTE.nummer,
        grund: r.art === 'Auftragsnummer' ? `Auftragsnummer ${nr} ${wo}` : `Rechnungsnummer ${nr} (Auftrag ${auftrag}) ${wo}`,
      });
    }
  }
  const sicher = treffer.length > 0;

  // 2. Order-, Lade- (Auftrag und Stops) und Rechnungsnummer in anderem Format: grob in der Datenbank vorfiltern, Wortgrenze hier
  const heuhaufen = sicher ? '' : quellen.map(([, t]) => t).join('\n').replace(/\s+/g, ' ').toLowerCase().slice(0, 2_000_000);
  if (heuhaufen.trim()) {
    const refs = await sql`
      select auftragsnr, art, wert from (
        select auftragsnr, 'Ordernummer' as art, ordernummer as wert from transport.auftraege where ordernummer is not null
        union all select auftragsnr, 'Ladenummer', ladenummer from transport.auftraege where ladenummer is not null
        union all select auftragsnr, 'Ladenummer', ladenummer from transport.stops where ladenummer is not null
        union all select auftragsnr, 'Rechnungsnummer', faktura from transport.auftraege where faktura is not null
      ) r
      where length(btrim(wert)) >= 4 and wert ~ '[0-9]' and strpos(${heuhaufen}, regexp_replace(lower(btrim(wert)), '\\s+', ' ', 'g')) > 0
      limit 500`;
    for (const r of refs) {
      const wert = String(r.wert).trim();
      if (!referenzImText(heuhaufen, wert)) continue;
      treffer.push({ auftragsnr: r.auftragsnr as string, art: 'referenz', punkte: PUNKTE.referenz, grund: `${r.art} ${wert} ${fundText(fundstellenReferenz(quellen, wert))}` });
    }
  }

  // Absender = E-Mail von Kunde, Unternehmer (auch weiterer Fahrten) oder Rechnungsempfänger eines offenen Auftrags
  if (q.adresse.includes('@')) {
    const offen = await sql`
      with adr as (
        select adrnr from transport.adressen
         where ${q.adresse} = any(regexp_split_to_array(lower(btrim(coalesce(email, ''))), '[\\s,;]+'))
      )
      select a.auftragsnr from transport.auftraege a
       where a.abgeschlossen_am is null
         and (a.faktura is null or a.fakturadatum >= current_date - 90)
         and (a.kunde in (select adrnr from adr) or a.unternehmer in (select adrnr from adr) or a.rechnungsempfaenger in (select adrnr from adr)
              or exists (select 1 from transport.fahrten f where f.auftragsnr = a.auftragsnr and f.unternehmer in (select adrnr from adr)))
       order by a.auftragsnr desc
       limit 200`;
    treffer.push(...absenderTreffer(offen.map((r) => r.auftragsnr as string), q.adresse));
  }
  // 3. Gibt es eine Nummer (oder ist es eine Antwort), bleiben nur diese Aufträge – der Absender kann dort noch Punkte geben
  return nummernVorrang(treffer);
}

async function zuordnen(q: Suche): Promise<{ kandidaten: Kandidat[]; ent: Entscheidung }> {
  const e = (await workflowEinstellungen()).eingang;
  const kandidaten = bewerten(await trefferSuchen(q));
  return { kandidaten, ent: entscheiden(kandidaten, e.schwelle, automatikAn()) };
}

// ---------------------------------------------------------------- Ablage

interface AblageErgebnis { abgelegt: number; wartet: number; dubletten: number; fehler: string[] }

/**
 * Offene Dokumente eines Vorgangs am Auftrag ablegen (Ablageziel aus den Einstellungen). dokIds = null: alle offenen.
 * Ein Vorgang gehört zu genau einem Auftrag – liegen schon Dokumente an einem anderen, wird abgelehnt.
 */
export async function ablegen(vorgangId: number | string, auftragsnr: string, dokIds: number[] | null, wer: string): Promise<AblageErgebnis> {
  const [v] = await sql`select id, auftragsnr from transport.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  const [auftrag] = await sql`select auftragsnr from transport.auftraege where auftragsnr = ${auftragsnr}`;
  if (!auftrag) throw new BusinessError(`Auftrag ${auftragsnr} nicht gefunden.`, 404);
  if (v.auftragsnr && v.auftragsnr !== auftragsnr) {
    const [schon] = await sql`select 1 from transport.eing_dokumente where vorgang_id = ${vorgangId} and status = any(${AM_AUFTRAG}) limit 1`;
    if (schon) throw new BusinessError(`Dokumente dieser E-Mail liegen bereits am Auftrag ${v.auftragsnr} – weitere können nur dort abgelegt werden.`);
  }
  await sql`update transport.eing_vorgaenge set auftragsnr = ${auftragsnr} where id = ${vorgangId}`;

  const docs = await sql`
    select id, datei, mime, sha256, inhalt from transport.eing_dokumente
     where vorgang_id = ${vorgangId} and status = any(${OFFEN}) ${dokIds ? sql`and id = any(${dokIds})` : sql``}
     order by id`;
  if (dokIds && docs.length !== new Set(dokIds).size) throw new BusinessError('Mindestens ein Dokument gehört nicht zu diesem Vorgang oder ist schon erledigt.');

  const e = (await workflowEinstellungen()).eingang;
  const erg: AblageErgebnis = { abgelegt: 0, wartet: 0, dubletten: 0, fehler: [] };
  let paperlessDaten: { firma: Awaited<ReturnType<typeof firmaLesen>>; a: Parameters<typeof dokumentAblegen>[1] } | null = null;
  for (const d of docs) {
    const id = d.id as string;
    const setzen = (status: DokStatus, s: { ziel?: string | null; paperless_id?: number | null; hinweis?: string | null; inhaltLoeschen?: boolean }) => sql`
      update transport.eing_dokumente set status = ${status}, ziel = ${s.ziel ?? null}, paperless_id = ${s.paperless_id ?? null}, hinweis = ${s.hinweis ?? null},
             inhalt = ${s.inhaltLoeschen ? null : sql`inhalt`}, bearbeitet_am = now(), bearbeitet_von = ${wer}
       where id = ${id}`;
    if (!d.inhalt) {
      await setzen('fehler', { hinweis: 'Der Inhalt liegt nicht mehr vor – die E-Mail muss neu eingelesen werden.' });
      erg.fehler.push(`${d.datei}: Inhalt fehlt`);
      continue;
    }
    // Dublette: dieselbe Datei liegt schon an diesem Auftrag (auch aus einer anderen E-Mail)
    const [dub] = d.sha256 ? await sql`
      select d.id from transport.eing_dokumente d join transport.eing_vorgaenge v on v.id = d.vorgang_id
       where v.auftragsnr = ${auftragsnr} and d.sha256 = ${d.sha256} and d.id <> ${id} and d.status = any(${AM_AUFTRAG.filter((s) => s !== 'dublette')})
       limit 1` : [];
    if (dub) {
      await setzen('dublette', { hinweis: `Liegt bereits am Auftrag ${auftragsnr} (Dokument ${dub.id}).`, inhaltLoeschen: true });
      erg.dubletten++;
      continue;
    }
    if (e.ablageziel === 'lokal') {
      await setzen('wartet', { ziel: 'lokal', hinweis: null });
      erg.wartet++;
      continue;
    }
    try {
      if (!paperlessDaten) {
        const a = await auftragLesen(auftragsnr);
        const name = (x: { kundenname: string; kundenname2: string | null } | null) => (x ? [x.kundenname, x.kundenname2].filter(Boolean).join(' ').trim() || null : null);
        paperlessDaten = {
          firma: await firmaLesen(),
          a: { auftragsnr, kunde: name(a.kundeAdr), unternehmer: name(a.unternehmerAdr), kennzeichen: a.kennzeichen, ordernummer: a.ordernummer, datum: new Date().toISOString().slice(0, 10), benutzer: wer },
        };
      }
      const p = await dokumentAblegen(paperlessDaten.firma, paperlessDaten.a, d.datei as string, d.inhalt as string);
      await withChange({ userId: null, username: wer, action: 'EINGANG_ABLEGEN' }, (tx) => tx`
        insert into transport.auftrag_dokumente (auftragsnr, doc_id, titel, datei, erstellt_von)
        values (${auftragsnr}, ${p.id}, ${p.titel}, ${p.datei}, ${wer}) on conflict do nothing`);
      await setzen('abgelegt', { ziel: 'paperless', paperless_id: p.id, hinweis: p.warnungen.join(' ') || null, inhaltLoeschen: true });
      erg.abgelegt++;
    } catch (x) {
      await setzen('fehler', { hinweis: meldung(x) });
      erg.fehler.push(`${d.datei}: ${meldung(x)}`);
    }
  }
  await abschliessen(vorgangId);
  await speicherPruefen();
  return erg;
}

/** Status des Vorgangs aus seinen Dokumenten; abgeschlossen (abgelegt/ignoriert) → Mailtext löschen */
export async function abschliessen(vorgangId: number | string): Promise<VorgangStatus> {
  const docs = await sql`select status from transport.eing_dokumente where vorgang_id = ${vorgangId}`;
  const s = docs.map((d) => d.status as DokStatus);
  const status: VorgangStatus = s.includes('fehler') ? 'fehler' : s.includes('neu') ? 'pruefen'
    : s.some((x) => AM_AUFTRAG.includes(x)) ? 'abgelegt' : 'ignoriert';
  const fertig = status === 'abgelegt' || status === 'ignoriert';
  const [v] = await sql`
    update transport.eing_vorgaenge set status = ${status},
           abgeschlossen_am = ${fertig ? sql`coalesce(abgeschlossen_am, now())` : null},
           text = ${fertig ? null : sql`text`}
     where id = ${vorgangId}
     returning von, betreff, hinweis`;
  await pruefHinweis(vorgangId, fertig ? null : { status, von: (v?.von as string) ?? '', betreff: (v?.betreff as string) ?? '', hinweis: (v?.hinweis as string | null) ?? null });
  return status;
}

/** Arbeitsvorrat: je E-Mail in der Prüfliste ein Hinweis, der mit dem Abschluss des Vorgangs von selbst verschwindet */
async function pruefHinweis(vorgangId: number | string, offen: { status: VorgangStatus; von: string; betreff: string; hinweis: string | null } | null): Promise<void> {
  try {
    if (!offen) return await hinweisBeheben('transport', 'EINGANG_PRUEFEN', String(vorgangId));
    await hinweisMelden(HINWEIS_DB, {
      modul: 'transport', quelle: 'EINGANG_PRUEFEN', objekt: String(vorgangId), bereich: 'Posteingang', recht: 'transport.eingang:edit',
      art: offen.status === 'fehler' ? 'Posteingang: Ablage fehlgeschlagen' : 'Posteingang: E-Mail prüfen',
      titel: `${offen.betreff || '(ohne Betreff)'} – ${offen.von}`, text: offen.hinweis ?? '', state: offen.status === 'fehler' ? 'Negative' : 'Critical',
      icon: offen.status === 'fehler' ? 'error' : 'inbox', pfad: '/transport/posteingang',
    });
  } catch { /* der Hinweis ist eine Zugabe – die Verarbeitung darf daran nicht scheitern */ }
}

// ---------------------------------------------------------------- Eingang (n8n)

async function antwortVon(vorgangId: number | string, doppelt: boolean): Promise<MailAntwort> {
  const [v] = await sql`select id, status, auftragsnr, mail_aktion from transport.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  const aktion = (v.mail_aktion as { ordner: string } | null) ?? ordnerFuer((await workflowEinstellungen()).eingang, v.status as string);
  const status = doppelt ? 'doppelt' : v.status === 'neu' ? 'pruefen' : (v.status as MailAntwort['status']);
  return { vorgang: Number(v.id), status, auftragsnr: (v.auftragsnr as string | null) ?? null, aktion };
}

interface NeuDok { art: 'anhang' | 'mail'; datei: string; mime: string; daten: Buffer; ocr: string; hinweis: string | null }

/** E-Mail von n8n annehmen, zuordnen und – wenn eindeutig – ablegen. Antwort laut Vertrag: Vorgang, Status, Auftrag, Ordner. */
export async function mailVerarbeiten(m: EingangMail): Promise<MailAntwort> {
  const postfach = m.postfach.trim().toLowerCase();
  const schluessel = mailSchluessel(m);
  const [alt] = await sql`select id from transport.eing_vorgaenge where postfach = ${postfach} and message_id = ${schluessel}`;
  if (alt) return antwortVon(alt.id as string, true);

  const e = (await workflowEinstellungen()).eingang;
  const ab = absender(m.von);
  const text = (m.text || htmlText(m.html)).slice(0, MAX_TEXT);
  const zeit = eingangZeit(m.datum);
  const hinweise: string[] = [];

  // Anhänge: Signatur-Logos, Kalender- und Signaturdateien herausfiltern
  const anhaenge = m.anhaenge.map((a) => {
    const daten = Buffer.from(a.inhalt.replace(/^data:[^,]*,/, ''), 'base64');
    const name = dateinameSicher(a.name, 'anhang');
    return { name, mime: a.mime || mimeTyp(name), daten, groesse: daten.length };
  }).filter(relevanterAnhang);

  // Abwesenheitsnotizen und Unzustellbar-Meldungen ohne Anhang werden nicht abgelegt
  const art = einordnen({ von: m.von, betreff: m.betreff, auto: m.auto });
  const ignorieren = art !== 'antwort' && !anhaenge.length;

  const dokumente: NeuDok[] = [];
  if (!ignorieren) {
    for (const a of anhaenge) {
      const t = e.ocr ? await texterkennen({ datei: a.name, mime: a.mime, daten: a.daten }) : { text: '', hinweis: null };
      dokumente.push({ art: 'anhang', datei: a.name, mime: a.mime, daten: a.daten, ocr: t.text.slice(0, MAX_OCR), hinweis: t.hinweis });
    }
    if (e.mailAlsPdf) {
      try {
        const html = mailHtml({ von: m.von, an: m.an, betreff: m.betreff, datum: zeitBerlin(zeit), text, anhaenge: anhaenge.map((a) => a.name) });
        dokumente.push({ art: 'mail', datei: mailDateiname(tagBerlin(zeit), m.betreff), mime: 'application/pdf', daten: await htmlToPdf(html), ocr: '', hinweis: null });
      } catch (x) {
        hinweise.push(`E-Mail nicht als PDF erzeugt: ${meldung(x)}`);
      }
    }
  }

  // Zuordnung
  const antwort = await antwortTreffer(m.in_reply_to, m.references);
  const { kandidaten, ent } = ignorieren
    ? { kandidaten: [] as Kandidat[], ent: null }
    : await zuordnen({ betreff: m.betreff, text, adresse: ab.adresse, dateien: anhaenge.map((a) => a.name), ocr: dokumente.filter((d) => d.ocr).map((d) => ({ datei: d.datei, text: d.ocr })), antwort });
  if (ignorieren) hinweise.unshift(`${art === 'unzustellbar' ? 'Unzustellbar-Meldung' : 'Abwesenheitsnotiz'} – nicht abgelegt.`);
  else if (!dokumente.length) hinweise.unshift('Keine Dokumente (keine Anhänge, E-Mail als PDF ist abgeschaltet) – nichts abzulegen.');
  if (ent?.hinweis && dokumente.length) hinweise.push(ent.hinweis);
  // „Antwort“-Treffer bleiben an den Kandidaten stehen (Neubewertung ohne Kopfzeilen); ohne Begründung kein Kandidat
  const kand = kandidaten.length ? kandidaten : antwort.length ? bewerten(antwort) : [];

  const status: VorgangStatus = ignorieren || !dokumente.length ? 'ignoriert' : 'neu';
  const [v] = await sql`
    insert into transport.eing_vorgaenge (postfach, message_id, graph_id, von, von_name, an, betreff, datum, status, hinweis, text,
                                          auftragsnr, punkte, begruendung, kandidaten, abgeschlossen_am)
    values (${postfach}, ${schluessel}, ${m.graph_id}, ${ab.adresse || m.von.slice(0, 500)}, ${ab.name || null}, ${m.an.slice(0, 2000)}, ${m.betreff.slice(0, 1000)},
            ${zeit}, ${status}, ${hinweise.join(' ') || null}, ${status === 'ignoriert' ? null : text || null},
            ${ent?.auftragsnr ?? null}, ${ent?.punkte ?? 0}, ${sql.json((ent?.begruendung ?? []) as never)}, ${sql.json(kand as never)},
            ${status === 'ignoriert' ? sql`now()` : null})
    on conflict (postfach, message_id) do nothing
    returning id`;
  if (!v) {
    const [da] = await sql`select id from transport.eing_vorgaenge where postfach = ${postfach} and message_id = ${schluessel}`;
    return antwortVon(da.id as string, true);
  }
  const vorgangId = v.id as string;

  for (const d of dokumente) {
    await sql`
      insert into transport.eing_dokumente (vorgang_id, art, datei, mime, groesse, sha256, inhalt, ocr_text, status, hinweis)
      values (${vorgangId}, ${d.art}, ${d.datei}, ${d.mime}, ${d.daten.length}, ${sha(d.daten)}, ${d.daten.toString('base64')}, ${d.ocr || null}, 'neu', ${d.hinweis})`;
  }

  let endstatus: VorgangStatus = status;
  if (status === 'neu') {
    if (ent?.status === 'abgelegt' && ent.auftragsnr) {
      await ablegen(vorgangId, ent.auftragsnr, null, SYSTEM);
      endstatus = (await sql`select status from transport.eing_vorgaenge where id = ${vorgangId}`)[0].status as VorgangStatus;
    } else {
      endstatus = await abschliessen(vorgangId);
    }
  }
  await sql`update transport.eing_vorgaenge set mail_aktion = ${sql.json(ordnerFuer(e, endstatus) as never)} where id = ${vorgangId}`;
  await speicherPruefen();
  return antwortVon(vorgangId, false);
}

// ---------------------------------------------------------------- Prüfliste

async function vorgangOffen(id: number) {
  const [v] = await sql`select id, status, auftragsnr, betreff, text, von, kandidaten from transport.eing_vorgaenge where id = ${id}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  return v;
}

/** Ablage von Hand: gewählte Dokumente am Auftrag ablegen; nicht gewählte bleiben offen in der Prüfliste */
export async function vonHandAblegen(id: number, auftragsnr: string, dokumente: number[], wer: string) {
  const v = await vorgangOffen(id);
  if (v.status === 'ignoriert') throw new BusinessError('Der Vorgang ist ignoriert.');
  const r = await ablegen(id, auftragsnr, dokumente, wer);
  const [n] = await sql`select status from transport.eing_vorgaenge where id = ${id}`;
  const teile = [
    r.abgelegt ? `${r.abgelegt} in Paperless abgelegt` : '',
    r.wartet ? `${r.wartet} warten auf die Übernahme in den Ablageordner (Unterordner Eingang/)` : '',
    r.dubletten ? `${r.dubletten} lagen schon am Auftrag (Dublette)` : '',
    r.fehler.length ? `Fehler: ${r.fehler.join('; ')}` : '',
  ].filter(Boolean);
  return { status: n.status as VorgangStatus, auftragsnr, ...r, text: `Auftrag ${auftragsnr}: ${teile.join(', ') || 'nichts abgelegt'}.` };
}

/** Vorgang ignorieren: offene Dokumente ignorieren und ihre Inhalte löschen (bereits Abgelegtes bleibt) */
export async function vorgangIgnorieren(id: number, wer: string) {
  const v = await vorgangOffen(id);
  if (v.status === 'abgelegt' || v.status === 'ignoriert') throw new BusinessError('Der Vorgang ist bereits abgeschlossen.');
  await sql`update transport.eing_dokumente set status = 'ignoriert', inhalt = null, bearbeitet_am = now(), bearbeitet_von = ${wer}
             where vorgang_id = ${id} and status = any(${OFFEN})`;
  await sql`update transport.eing_vorgaenge set bearbeitet_von = ${wer} where id = ${id}`;
  const status = await abschliessen(id);
  await speicherPruefen();
  return { status, text: status === 'ignoriert' ? 'Vorgang ignoriert.' : 'Offene Dokumente ignoriert – der Rest liegt am Auftrag.' };
}

/** Zuordnung neu berechnen (z. B. nachdem der Auftrag angelegt wurde); eindeutige Treffer werden bei Automatik abgelegt */
export async function neuBewerten(id: number, wer: string) {
  const v = await vorgangOffen(id);
  if (!['neu', 'pruefen', 'fehler'].includes(v.status as string)) throw new BusinessError('Nur offene Vorgänge (prüfen, Fehler) lassen sich neu bewerten.');
  const docs = await sql`select art, datei, ocr_text, status from transport.eing_dokumente where vorgang_id = ${id} order by id`;
  // liegen schon Dokumente am Auftrag, bleibt der Auftrag – nur die offenen werden erneut versucht
  const fest = docs.some((d) => AM_AUFTRAG.includes(d.status as DokStatus)) ? (v.auftragsnr as string | null) : null;
  if (fest) {
    const r = await ablegen(id, fest, null, wer);
    return { status: await abschliessen(id), auftragsnr: fest, punkte: null, text: `Erneut am Auftrag ${fest} abgelegt${r.fehler.length ? ` – Fehler: ${r.fehler.join('; ')}` : ''}.` };
  }
  const antwort: Treffer[] = ((v.kandidaten ?? []) as Kandidat[]).flatMap((k) => k.gruende.filter((g) => g.art === 'antwort')
    .map((g) => ({ auftragsnr: k.auftragsnr, art: 'antwort' as const, punkte: g.punkte, grund: g.grund })));
  const { kandidaten, ent } = await zuordnen({
    betreff: (v.betreff as string) ?? '', text: (v.text as string) ?? '', adresse: (v.von as string) ?? '',
    dateien: docs.filter((d) => d.art !== 'mail').map((d) => d.datei as string),
    ocr: docs.filter((d) => d.ocr_text).map((d) => ({ datei: d.datei as string, text: d.ocr_text as string })), antwort,
  });
  await sql`
    update transport.eing_vorgaenge set auftragsnr = ${ent.auftragsnr}, punkte = ${ent.punkte}, begruendung = ${sql.json(ent.begruendung as never)},
           kandidaten = ${sql.json(kandidaten as never)}, hinweis = ${ent.hinweis}, status = case when status = 'neu' then 'pruefen' else status end
     where id = ${id}`;
  if (ent.status === 'abgelegt' && ent.auftragsnr) {
    const r = await ablegen(id, ent.auftragsnr, null, wer);
    const [n] = await sql`select status from transport.eing_vorgaenge where id = ${id}`;
    return { status: n.status as VorgangStatus, auftragsnr: ent.auftragsnr, punkte: ent.punkte, text: `Am Auftrag ${ent.auftragsnr} abgelegt (${ent.punkte} Punkte)${r.fehler.length ? ` – Fehler: ${r.fehler.join('; ')}` : ''}.` };
  }
  return { status: 'pruefen' as VorgangStatus, auftragsnr: ent.auftragsnr, punkte: ent.punkte, text: ent.hinweis ?? 'Bitte prüfen.' };
}

/** alle offenen Vorgänge neu bewerten („Jetzt abrufen“) */
let letzterAbruf: Date | null = null;
/** Zeitpunkt der letzten Lieferung von n8n bzw. des letzten „Jetzt abrufen“ (ISO) */
export async function letzterAbrufLesen(): Promise<string | null> {
  const [r] = await sql`select max(eingang_am) as t from transport.eing_vorgaenge`;
  const t = r?.t ? new Date(r.t as string) : null;
  const neuester = [t, letzterAbruf].filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0];
  return neuester ? neuester.toISOString() : null;
}

export async function offeneNeuBewerten(wer: string): Promise<{ vorgaenge: number; abgelegt: number }> {
  letzterAbruf = new Date();
  const offen = await sql`select id from transport.eing_vorgaenge where status in ('neu', 'pruefen', 'fehler') order by id limit 500`;
  let abgelegt = 0;
  for (const o of offen) {
    try {
      const r = await neuBewerten(Number(o.id), wer);
      if (r.status === 'abgelegt') abgelegt++;
    } catch { /* einzelner Vorgang: bleibt in der Prüfliste */ }
  }
  return { vorgaenge: offen.length, abgelegt };
}

/** Browser hat die Datei in den Ablageordner (Unterordner Eingang/) geschrieben → Inhalt löschen */
export async function uebernommen(id: number, wer: string) {
  const [d] = await sql`select status from transport.eing_dokumente where id = ${id}`;
  if (!d) throw new BusinessError('Das Dokument gibt es nicht (mehr).', 404);
  if (d.status === 'uebernommen') return { status: 'uebernommen', text: 'Bereits übernommen.' };
  if (d.status !== 'wartet') throw new BusinessError('Das Dokument wartet nicht auf die Übernahme in den Ablageordner.');
  await sql`update transport.eing_dokumente set status = 'uebernommen', inhalt = null, bearbeitet_am = now(), bearbeitet_von = ${wer} where id = ${id}`;
  await speicherPruefen();
  return { status: 'uebernommen', text: 'In den Ablageordner übernommen.' };
}

// ---------------------------------------------------------------- Speicher

export async function speicherStand(): Promise<{ bytes: number; dateien: number; warnungMb: number; warnung: boolean }> {
  const [r] = await sql`select coalesce(sum(groesse), 0)::bigint as bytes, count(*)::int as dateien from transport.eing_dokumente where inhalt is not null`;
  const warnungMb = (await workflowEinstellungen()).eingang.speicherWarnungMb;
  const bytes = Number(r.bytes);
  return { bytes, dateien: Number(r.dateien), warnungMb, warnung: speicherWarnung(bytes, warnungMb) };
}

/** Hinweis im Arbeitsvorrat, solange noch nicht übernommene Dateien mehr als die Grenze belegen */
async function speicherPruefen(): Promise<void> {
  try {
    const s = await speicherStand();
    if (!s.warnung) return await hinweisBeheben('transport', 'EINGANG_SPEICHER');
    const mb = (s.bytes / 1024 / 1024).toFixed(0);
    await hinweisMelden(HINWEIS_DB, {
      modul: 'transport', quelle: 'EINGANG_SPEICHER', objekt: '', bereich: 'Posteingang', recht: 'transport.eingang:display',
      art: 'Posteingang: Speicher', titel: `${s.dateien} Dateien (${mb} MB) noch nicht übernommen`, state: 'Critical', icon: 'message-warning',
      text: `Mehr als ${s.warnungMb} MB: Aufträge mit verbundenem Ablageordner öffnen, damit die Dateien übernommen werden.`, pfad: '/transport/posteingang',
    });
  } catch { /* der Hinweis ist eine Zugabe – die Verarbeitung darf daran nicht scheitern */ }
}

// ---------------------------------------------------------------- „Jetzt abrufen“ (n8n)

/** n8n-Workflow „Euroflex Maileingang“ sofort starten; null = Anbindung nicht eingerichtet */
export async function abrufAnstossen(quelle: string): Promise<string | null> {
  const v = await verbindungLesen(V_MAILEINGANG);
  if (!eingerichtet(v)) return null;
  let res: Response;
  try {
    res = await fetch(v.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(v) },
      body: JSON.stringify({ quelle, anwendung: ANWENDUNG }), signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new BusinessError(`n8n nicht erreichbar: ${meldung(e)}`, 502);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new BusinessError('n8n hat den Webhook-Schlüssel abgelehnt (Administration → Schnittstellen → Euroflex Maileingang jetzt abrufen).', 502);
  }
  if (res.status === 404) throw new BusinessError('Webhook nicht gefunden – ist der Workflow „Euroflex Maileingang“ aktiv und die URL (Production-URL, nicht /webhook-test/) richtig?', 502);
  if (!res.ok) throw new BusinessError(`n8n: HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`, 502);
  return 'n8n ruft das Postfach jetzt ab; neue E-Mails erscheinen in wenigen Minuten.';
}
