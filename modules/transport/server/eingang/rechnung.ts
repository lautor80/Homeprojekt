/**
 * Euroflex Posteingang – Eingangsrechnungen: PDF seitenweise lesen, einordnen, aufteilen und den Rechnungsempfänger prüfen;
 * Reklamation (Bitte um Rechnungskorrektur) als Entwurf im Eingangspostfach. Die Regeln stehen in rechnungspruefung.ts (reine
 * Logik), hier die Anbindung an Texterkennung/PDF-Werkzeuge (poppler-utils), Firmendaten und E-Mail-Versand.
 * Fachliche Beschreibung: docs/euroflex-mailworkflows.md, Abschnitt „Eingangsrechnungen“.
 */
import { sql } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { pdfHatERechnung, pdfSeitenAuswahl, pdfSeitenTexte } from '../../../../server/src/lib/texterkennung.js';
import { firmaLesen } from '../data.js';
import { euroflexMailSenden } from '../mailversand.js';
import type { EingangEinstellungen } from '../mailworkflows.js';
import {
  aufteilung, aufteilungText, firmierungPruefen, reklamationMail, seitenEinordnen, teilDateiname,
  type Aufteilung, type FirmaAngaben, type Firmierung, type FruehereFirmierung, type Seite, type Seitenart,
} from './rechnungspruefung.js';

export type Rolle = 'rechnung' | 'ablieferbeleg' | 'transportauftrag' | 'original';
export interface Teil { rolle: 'rechnung' | 'ablieferbeleg'; datei: string; daten: Buffer; ocr: string; seiten: Seite[]; pruefung: Firmierung | null }
export interface Analyse {
  /** Text je Seite */
  texte: string[];
  gescannt: number;
  seiten: Seite[];
  auf: Aufteilung;
  /** Rolle des ganzen Dokuments (ohne Aufteilung) */
  rolle: Rolle | null;
  /** Firmierungsprüfung der Rechnungsseiten – bei einer Aufteilung zusätzlich am Teil „Rechnung“ */
  pruefung: Firmierung | null;
  /** leer = nicht aufgeteilt */
  teile: Teil[];
  hinweis: string | null;
}
export interface AnalyseOptionen {
  aufteilen: boolean;
  pruefen: boolean;
  firma: FirmaAngaben | null;
  fruehere: FruehereFirmierung[];
  /** Aufteilung von Hand: Art je Seite – dann wird ohne Rückfrage geteilt und jeder Fehler gemeldet */
  arten?: Seitenart[];
}

const MAX_TEIL_TEXT = 200_000;
export const UNKLAR_HINWEIS = 'Rechnung, Ablieferbelege bzw. Transportauftrag stecken in einer Datei, die Aufteilung ist nicht eindeutig – bitte über „Aufteilen…“ prüfen.';

/** Optionen aus Einstellungen und Firmendaten; ohne Firmendaten keine Firmierungsprüfung */
export async function analyseOptionen(e: EingangEinstellungen): Promise<AnalyseOptionen> {
  let firma: FirmaAngaben | null = null;
  if (e.firmierungPruefen) {
    try {
      const [f] = await sql`select name, strasse, plz, ort, ustid from transport.firma where id = 1`;
      firma = f ? { name: (f.name as string) ?? '', strasse: (f.strasse as string) ?? '', plz: (f.plz as string) ?? '', ort: (f.ort as string) ?? '', ustid: (f.ustid as string) ?? '' } : null;
    } catch { firma = null; }
  }
  return { aufteilen: e.rechnungAufteilen, pruefen: e.firmierungPruefen && !!firma, firma, fruehere: e.fruehereFirmierungen };
}

/**
 * PDF seitenweise lesen und einordnen; bei eindeutiger Mischung (bzw. von Hand) die Teile erzeugen. null = das PDF lässt sich
 * nicht seitenweise lesen (defekt, geschützt, zu viele Seiten, Werkzeuge fehlen) – dann bleibt es, wie es ist.
 */
export async function pdfAnalysieren(datei: string, daten: Buffer, o: AnalyseOptionen): Promise<Analyse | null> {
  const st = await pdfSeitenTexte(daten);
  if (!st) {
    if (o.arten) throw new BusinessError('Das PDF lässt sich nicht seitenweise lesen (defekt, geschützt oder mehr als 40 Seiten).');
    return null;
  }
  if (o.arten && o.arten.length !== st.seiten.length) throw new BusinessError(`Das PDF hat ${st.seiten.length} Seiten – bitte jede Seite einordnen.`);
  const seiten: Seite[] = o.arten ? o.arten.map((art) => ({ art, sicher: true, grund: 'von Hand eingeordnet' })) : seitenEinordnen(st.seiten);
  const auf = aufteilung(seiten);
  const text = (nr: number[]) => nr.map((n) => st.seiten[n - 1]).join('\n').trim();
  const pruefung = o.pruefen && o.firma && auf.rechnung.length ? firmierungPruefen(text(auf.rechnung), o.firma, o.fruehere) : null;
  const erg: Analyse = { texte: st.seiten, gescannt: st.gescannt, seiten, auf, rolle: auf.rolle, pruefung, teile: [], hinweis: null };

  // nur Ablieferbelege (oder ein beliebiges anderes Dokument): nichts zu trennen
  const relevant = auf.rechnung.length > 0 || auf.transportauftrag.length > 0;
  if (o.arten && !auf.noetig) throw new BusinessError('Alle Seiten haben dieselbe Art – es gibt nichts aufzuteilen.');
  if (!auf.noetig || !relevant) return erg;
  if (!o.arten && !o.aufteilen) return erg;
  if (!o.arten && !auf.sicher) return { ...erg, hinweis: UNKLAR_HINWEIS };
  if (await pdfHatERechnung(daten)) {
    if (o.arten) throw new BusinessError('Das PDF enthält eine E-Rechnung (ZUGFeRD/XRechnung) und wird nicht aufgeteilt – das Original ist die Rechnung.');
    return { ...erg, hinweis: 'E-Rechnung (ZUGFeRD/XRechnung) – wird nicht aufgeteilt.' };
  }
  try {
    const teile: Teil[] = [];
    const teil = async (rolle: Teil['rolle'], nr: number[], p: Firmierung | null) => {
      if (!nr.length) return;
      teile.push({
        rolle, datei: teilDateiname(datei, rolle), daten: await pdfSeitenAuswahl(daten, nr), ocr: text(nr).slice(0, MAX_TEIL_TEXT),
        seiten: nr.map((n) => seiten[n - 1]), pruefung: p,
      });
    };
    await teil('rechnung', auf.rechnung, pruefung);
    await teil('ablieferbeleg', auf.ablieferbelege, null);
    return { ...erg, teile, hinweis: aufteilungText(auf) };
  } catch (e) {
    if (o.arten) throw e;
    return { ...erg, hinweis: `Nicht aufgeteilt: ${String((e as Error)?.message ?? e).slice(0, 300)}` };
  }
}

/** ein Bild (Foto, Scan als PNG/JPEG) wie eine einzelne Seite einordnen und – als Rechnung – die Firmierung prüfen */
export function bildAnalysieren(text: string, o: AnalyseOptionen): Pick<Analyse, 'rolle' | 'pruefung' | 'seiten'> {
  const seiten = seitenEinordnen([text]);
  const auf = aufteilung(seiten);
  return { seiten, rolle: auf.rolle, pruefung: o.pruefen && o.firma && auf.rechnung.length ? firmierungPruefen(text, o.firma, o.fruehere) : null };
}

/** Sätze für den Hinweis des Vorgangs: jede offene Rechnung, deren Empfänger nicht stimmt oder unklar ist */
export async function firmierungHinweise(vorgangId: number | string): Promise<string[]> {
  const rows = await sql`
    select datei, pruefung from transport.eing_dokumente
     where vorgang_id = ${vorgangId} and status in ('neu', 'fehler') and pruefung is not null and pruefung->>'ergebnis' <> 'ok' order by id`;
  return rows.map((r) => `„${r.datei}“: ${(r.pruefung as Firmierung).text}`);
}

/**
 * Reklamation als Entwurf: E-Mail an den Absender mit der Bitte, die Rechnung auf die aktuelle Firmierung neu auszustellen –
 * abgelegt im Ordner „Entwürfe“ des Eingangspostfachs (bzw. des Postfachs des Benutzers), mit der beanstandeten Rechnung im
 * Anhang. Gesendet wird nie automatisch.
 */
export async function reklamationEntwurf(vorgangId: number | string, wer: string): Promise<{ text: string }> {
  const [v] = await sql`select id, postfach, von, betreff, auftragsnr from transport.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  const docs = await sql`
    select datei, mime, inhalt, pruefung from transport.eing_dokumente
     where vorgang_id = ${vorgangId} and rolle is distinct from 'original' and pruefung->>'ergebnis' = 'alt' order by id`;
  if (!docs.length) throw new BusinessError('In dieser E-Mail ist keine Rechnung an eine frühere Firmierung erkannt.');
  const an = String(v.von ?? '').trim();
  if (!an.includes('@')) throw new BusinessError('Der Absender hat keine E-Mail-Adresse – bitte die Reklamation von Hand schreiben.');
  const firma = await firmaLesen();
  if (!firma.name.trim()) throw new BusinessError('In den Stammdaten (Firma) fehlt der Firmenname.');
  const mail = reklamationMail({ betreff: (v.betreff as string) ?? '', firma, alt: ((docs[0].pruefung as Firmierung).alt ?? null) });
  const dateien = docs.filter((d) => d.inhalt).map((d) => ({ name: d.datei as string, mime: (d.mime as string) || 'application/pdf', daten: Buffer.from(d.inhalt as string, 'base64') }));
  const r = await euroflexMailSenden({
    nr: (v.auftragsnr as string | null) ?? `EINGANG-${v.id}`, modus: 'entwurf', an, cc: '', betreff: mail.betreff, text: mail.text, dateien,
    nur: ['kunde'], benutzer: wer, absender: String(v.postfach ?? '').includes('@') ? (v.postfach as string) : null,
  });
  if (r.status !== 'entwurf') throw new BusinessError(`Reklamation nicht angelegt: ${r.text}`, 502);
  await sql`update transport.eing_vorgaenge set reklamation_am = now(), reklamation_von = ${wer} where id = ${vorgangId}`;
  return { text: `Reklamation an ${an} als Entwurf im Postfach ${r.postfach} abgelegt (Ordner „Entwürfe“) – bitte prüfen und senden.` };
}
