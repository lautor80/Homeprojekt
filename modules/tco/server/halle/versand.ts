import { BusinessError } from '../../../../server/src/errors.js';
import { PaperlessError } from '../../../../server/src/lib/paperless.js';
import { paperless, plAktiv, type Db, type Verein } from '../verein.js';
import { condense, dat, heute, eur } from '../format.js';
import { kontaktLesen, mailSenden, whatsappLink, type Kontakt, type MailAnhang } from '../kommunikation.js';
import { adrnrErmitteln, positionenLesen, statusSetzen } from './daten.js';
import { rechnungPdf } from './pdf.js';
import { kontextAktualisieren, uploadMeta, zuordnen } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';

export interface DruckErgebnis {
  pdf: Buffer;
  rgnr: string;
  docId: number | null;
  versionId: number | null;
  link: string | null;
  message: string;
  warnungen: string[];
}

/** schreibt in einer eigenen Transaktion mit Änderungsbeleg (change(req, …)) */
export type Schreiber = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;

const jetzt = () => {
  const d = new Date();
  return `${dat(heute())} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const korrespondentName = (k: Kontakt) => condense(`${k.nachname} ${k.vorname}`);

/** Notiz am Paperless-Dokument (still, Fehler werden nur gemeldet) */
export async function paperlessNotiz(v: Verein, doknr: string | number | null | undefined, text: string): Promise<string | null> {
  if (!doknr || !plAktiv(v)) return null;
  try {
    await paperless(v).notizAnlegen(Number(doknr), text);
    return null;
  } catch (e) {
    return `Paperless-Notiz nicht geschrieben: ${(e as Error).message}`;
  }
}

async function kopf(db: Db, rgnr: string) {
  const [k] = await db`select rgnr_txt, kunde, adrnr, status, betrag::float8 as betrag, angelegt_am::text, doknr
                         from tco.rgkopf where rgnr_txt = ${rgnr}`;
  if (!k) throw new BusinessError(`Rechnung ${rgnr} nicht gefunden`);
  return k as unknown as { rgnr_txt: string; kunde: string; adrnr: string | null; status: string; betrag: number; angelegt_am: string | null; doknr: string | null };
}

/** PDF erzeugen (ohne Ablage) */
export async function rechnungPdfErzeugen(db: Db, v: Verein, rgnr: string, w?: Schreiber) {
  const k = await kopf(db, rgnr);
  let adrnr = k.adrnr;
  if (!adrnr) {
    adrnr = await adrnrErmitteln(db, k.kunde);
    if (adrnr && w) await w((tx) => tx`update tco.rgkopf set adrnr = ${adrnr} where rgnr_txt = ${rgnr}`);
  }
  const kontakt = await kontaktLesen(db, adrnr);
  if (!kontakt) {
    throw new BusinessError(`Zu Rechnung ${rgnr} konnten keine Kundendaten ermittelt werden. Der EP3-Name „${k.kunde}“ passt zu keinem Mitglied und keinem EP3-Kunden.`);
  }
  const pos = await positionenLesen(db, rgnr);
  if (!pos.length) throw new BusinessError(`Rechnung ${rgnr} hat keine Positionen`);
  pos.forEach((p, i) => { p.rgpos = i + 1; });
  const pdf = await rechnungPdf(v, k, kontakt, pos);
  return { pdf, kopf: { ...k, adrnr }, kontakt };
}

/**
 * Drucken und in Paperless ablegen (RECHNUNG_DRUCKEN):
 * ohne DOKNR neues Dokument, sonst neue Dateiversion; Metadaten; Freigabelink (30 Tage) auf die jüngste Fassung.
 * Status 1 → 2 (höhere Status bleiben erhalten).
 */
export async function rechnungDrucken(db: Db, v: Verein, rgnr: string, w: Schreiber): Promise<DruckErgebnis> {
  const { pdf, kopf: k, kontakt } = await rechnungPdfErzeugen(db, v, rgnr, w);
  const warnungen: string[] = [];
  let docId: number | null = k.doknr ? Number(k.doknr) : null;
  let versionId: number | null = null;
  let link: string | null = null;
  let message: string;
  const filename = `${rgnr}_${k.kunde.replace(/[^\p{L}\p{N}]+/gu, '_')}.pdf`;

  if (!plAktiv(v)) {
    message = `Rechnung ${rgnr} gedruckt (Paperless ist nicht eingerichtet – keine Ablage)`;
  } else {
    const pl = paperless(v);
    try {
      let neu = !docId;
      if (docId) {
        try {
          const task = await pl.uploadVersion(docId, pdf, filename, `Neudruck ${jetzt()}`);
          versionId = await pl.warteAufDokument(task);
        } catch (e) {
          if (e instanceof PaperlessError && e.status === 404) {
            warnungen.push(`Paperless-Dokument ${docId} existiert nicht mehr – neues Dokument angelegt`);
            neu = true;
            docId = null;
          } else {
            throw new BusinessError(`Zu Paperless-Dokument ${docId} konnte keine neue Version angelegt werden (${(e as Error).message}). Status und Druckdatum der Rechnung bleiben unverändert.`);
          }
        }
      }
      const werte = { rgnr, kunde: korrespondentName(kontakt), betrag: k.betrag, angelegt_am: k.angelegt_am ?? heute(), heute: heute(), benutzer: '', verein: v.name };
      if (neu) {
        const z = await zuordnen(K.halleRechnung, 'tco', { ...werte, dokid: '' });
        const task = await pl.upload(pdf, filename, (await uploadMeta(pl, z)).meta);
        docId = await pl.warteAufDokument(task);
      }
      if (docId) {
        warnungen.push(...(await kontextAktualisieren(pl, K.halleRechnung, 'tco', docId, werte, { ohneNotiz: !neu })).warnungen);
        const ziel = versionId ?? await pl.neuesteVersion(docId);
        link = await pl.freigabelinkAnlegen(ziel, 30);
        message = neu
          ? `Rechnung ${rgnr} nach Paperless gedruckt (Dokument ${docId}), Freigabelink erstellt`
          : `Rechnung ${rgnr} erneut gedruckt – neue Version zu Paperless-Dokument ${docId}, Freigabelink erstellt`;
      } else {
        message = `Rechnung ${rgnr} wurde nach Paperless gedruckt. Die Dokument-ID lag nach 20 Sekunden noch nicht vor – Status und Druckdatum bleiben unverändert, bitte später erneut drucken.`;
        return { pdf, rgnr, docId: null, versionId: null, link: null, message, warnungen };
      }
    } catch (e) {
      if (e instanceof BusinessError) throw e;
      throw new BusinessError(`Rechnungsausgabe abgebrochen. ${(e as Error).message}`);
    }
  }
  await w((tx) => tx`update tco.rgkopf set gedruckt = ${heute()}, status = case when status = '1' then '2' else status end,
                            doknr = coalesce(${docId ? String(docId) : null}, doknr)
                      where rgnr_txt = ${rgnr}`);
  return { pdf, rgnr, docId, versionId, link, message, warnungen };
}

/** jüngste Fassung aus Paperless als Anhang */
async function anhangAusPaperless(v: Verein, docId: number, rgnr: string): Promise<MailAnhang> {
  const pl = paperless(v);
  const ver = await pl.neuesteVersion(docId);
  const d = await pl.download(ver);
  return { dateiname: `Rechnung_${rgnr}.pdf`, inhalt: d.data, paperless_root_id: docId, paperless_version_id: ver, objekt: rgnr };
}

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

export function mailTexte(v: Verein, vorname: string, rgnrs: string[], link?: string | null) {
  const mehrere = rgnrs.length > 1;
  const nr = rgnrs.join(', ');
  const anrede = vorname || 'zusammen';
  const betreff = mehrere ? `Rechnungen des TC Oberthal ${nr}` : `Rechnung des TC Oberthal ${nr}`;
  const text = [
    `Hallo ${anrede},`, '',
    `vielen Dank dass du die Tennishalle des TC Oberthal genutzt hast. ${mehrere ? 'Anbei erhältst du deine Abrechnungen mit den Rechnungsnummern' : 'Anbei erhältst du deine Abrechnung mit der Rechnungsnummer'} ${nr} mit der Bitte um Überweisung auf unser Vereinskonto.`, '',
    ...(link ? ['Deine Rechnung kannst du 30 Tage lang über folgenden Link herunterladen:', link, ''] : []),
    'Vielen Dank und beste Grüße',
    v.ansprechpartner ?? '',
  ].join('\n');
  return { betreff, text };
}

export function whatsappText(v: Verein, vorname: string) {
  return [
    `Hallo ${vorname || 'zusammen'},`, '',
    'vielen Dank, dass du die Tennishalle des TC Oberthal genutzt hast. Deine Abrechnung kannst du 30 Tage lang über folgenden Link herunterladen:', '',
    '[LINKS]', '',
    'Bitte überweise den Betrag auf unser Vereinskonto.', '',
    'Viele Grüße',
    v.ansprechpartner ?? '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// E-Mail
// ---------------------------------------------------------------------------

export async function mailVersand(db: Db, v: Verein, w: Schreiber, d: {
  rgnrs: string[]; an: string; cc?: string; betreff: string; text: string; neudruck: boolean; entwurf: boolean; benutzer: string;
}) {
  if (!d.rgnrs.length) throw new BusinessError('Bitte mindestens eine Rechnung auswählen');
  if (!d.an.trim()) throw new BusinessError('Für diese Person ist keine E-Mail-Adresse hinterlegt');
  const anhaenge: MailAnhang[] = [];
  const gedruckt: string[] = [];
  const docs = new Map<string, number | null>();
  for (const rgnr of d.rgnrs) {
    const k = await kopf(db, rgnr);
    if (d.neudruck || !k.doknr || !plAktiv(v)) {
      const r = await rechnungDrucken(db, v, rgnr, w);
      gedruckt.push(rgnr);
      docs.set(rgnr, r.docId);
      anhaenge.push({ dateiname: `Rechnung_${rgnr}.pdf`, inhalt: r.pdf, paperless_root_id: r.docId, paperless_version_id: r.versionId, objekt: rgnr });
    } else {
      docs.set(rgnr, Number(k.doknr));
      anhaenge.push(await anhangAusPaperless(v, Number(k.doknr), rgnr));
    }
  }
  let ergebnis;
  try {
    ergebnis = await mailSenden(v, {
      modus: d.entwurf ? 'entwurf' : 'senden', anwendung: 'HALLENRECHNUNG', objekt: d.rgnrs.join(','),
      an: d.an.trim(), cc: d.cc?.trim(), betreff: d.betreff, text: d.text, benutzer: d.benutzer, anhaenge,
      folge: d.entwurf ? undefined : { art: 'HALLENRECHNUNG', rgnrs: d.rgnrs },
    });
  } catch (e) {
    throw new BusinessError(`Versand fehlgeschlagen: ${(e as Error).message}${gedruckt.length ? ` (bereits gedruckt: ${gedruckt.join(', ')})` : ''}`);
  }
  const warn: string[] = [];
  for (const [rgnr, doc] of docs) {
    const w = await paperlessNotiz(v, doc, `E-Mail ${ergebnis.status} am ${jetzt()} an ${d.an}${d.cc ? ` (Cc ${d.cc})` : ''} durch ${d.benutzer} – Rechnung ${rgnr}${ergebnis.fehler ? `: ${ergebnis.fehler}` : ''}`);
    if (w) warn.push(w);
  }
  if (ergebnis.status === 'fehler') throw new BusinessError(`Versand fehlgeschlagen: ${ergebnis.fehler ?? 'unbekannter Fehler'}`);
  if (ergebnis.status === 'gesendet') await w(async (tx) => { for (const rgnr of d.rgnrs) await statusSetzen(tx, rgnr, 'versendet'); });
  const text = ergebnis.status === 'gesendet'
    ? `E-Mail an ${d.an} versendet (${d.rgnrs.join(', ')}), ${gedruckt.length} gedruckt/abgelegt`
    : `Entwurf im Postfach abgelegt (${d.rgnrs.join(', ')})`;
  return { status: ergebnis.status, text, warnungen: warn };
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

export async function whatsappVorbereiten(db: Db, v: Verein, w: Schreiber, d: { rgnrs: string[]; nummer: string; text: string; neudruck: boolean }) {
  const nr = d.nummer.replace(/[^0-9]/g, '');
  if (nr.length < 8) throw new BusinessError('Bitte eine gültige Mobilnummer angeben (z. B. +49 171 1234567)');
  if (!d.rgnrs.length) throw new BusinessError('Bitte mindestens eine Rechnung auswählen');
  if (!plAktiv(v)) throw new BusinessError('Für den WhatsApp-Versand wird Paperless (Freigabelinks) benötigt.');
  const pl = paperless(v);
  pl.freigabeExternPflicht(); // ausgehend: nie mit interner Adresse – vor dem Drucken prüfen
  const zeilen: string[] = [];
  const links: { rgnr: string; link: string; docId: number }[] = [];
  for (const rgnr of d.rgnrs) {
    const k = await kopf(db, rgnr);
    let link: string | null = null;
    let docId = k.doknr ? Number(k.doknr) : null;
    if (d.neudruck || !docId) {
      const r = await rechnungDrucken(db, v, rgnr, w);
      link = r.link;
      docId = r.docId;
    } else {
      link = await pl.freigabelink(await pl.neuesteVersion(docId), 30);
    }
    if (!link || !docId) {
      throw new BusinessError(`Zu Rechnung ${rgnr} liegt noch kein Freigabelink vor (Paperless verarbeitet das Dokument evtl. noch). Bitte in einer Minute erneut versuchen.`);
    }
    zeilen.push(`Rechnung ${rgnr} (${eur(k.betrag)}): ${link}`);
    links.push({ rgnr, link, docId });
  }
  const nachricht = d.text.includes('[LINKS]') ? d.text.replace('[LINKS]', zeilen.join('\n')) : `${d.text}\n\n${zeilen.join('\n')}`;
  return { url: whatsappLink(nr, pl.ausgehend(nachricht)), links, nachricht: pl.ausgehend(nachricht) };
}

export async function whatsappBestaetigen(db: Db, v: Verein, w: Schreiber, d: { links: { rgnr: string; link: string; docId: number }[]; nummer: string; benutzer: string }) {
  const warn: string[] = [];
  await w(async (tx) => { for (const l of d.links) await statusSetzen(tx, l.rgnr, 'versendet'); });
  for (const l of d.links) {
    const w = await paperlessNotiz(v, l.docId, `WhatsApp-Versand am ${jetzt()} an +${d.nummer.replace(/[^0-9]/g, '')} durch ${d.benutzer} – Rechnung ${l.rgnr}, Link ${l.link}`);
    if (w) warn.push(w);
  }
  return { text: `WhatsApp-Versand bestätigt (${d.links.map((l) => l.rgnr).join(', ')})`, warnungen: warn };
}
