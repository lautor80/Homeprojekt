/**
 * Kündigung durch das Mitglied mit Freigabe durch den Vorstand (#232).
 *
 *  1. Das Mitglied reicht die Kündigung in „Meine Mitgliedschaft“ ein (einreichen): geprüft wie bisher, aber an Verträgen
 *     und Mitgliedschaft ändert sich noch nichts. Status OFFEN, Eintrag im Arbeitsvorrat des Vorstands.
 *  2. Der Vorstand gibt frei (freigeben): Erst jetzt wird die Kündigung ausgeführt – mit dem Tag des Eingangs als
 *     Kündigungsdatum, damit die Frist nicht von der Bearbeitungszeit abhängt. Status FREIGEGEBEN.
 *  3. Die Kündigungsbestätigung wird erzeugt und zur Prüfung angezeigt (pdf) und danach an das Mitglied gesendet und in
 *     der Mitgliederakte abgelegt (senden). Status ABGESCHLOSSEN.
 *  Oder der Vorstand lehnt ab (ablehnen): nichts ändert sich, das Mitglied erfährt den Grund per E-Mail.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db, Verein } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { kontaktLesen, mailSenden } from '../kommunikation.js';
import { tcoHinweis } from '../hinweise.js';
import { leer, notizAnlegen } from './logik.js';
import { druckdatenLesen, unterlagePdf } from './pdf.js';
import { eigeneAdrnr, kuendigen, kuendigenMehrere, kuendigungBestaetigen, type Kuendigung } from './selbst.js';

export type KuendigungEingabe = Kuendigung & { vertraege?: { adrnr: string; vertragnr: string }[] };
export type KuendigungStatus = 'OFFEN' | 'FREIGEGEBEN' | 'ABGESCHLOSSEN' | 'ABGELEHNT';
interface Zeile {
  id: number; adrnr: string; benutzer_id: string | null; benutzer: string; art: 'MITGLIEDSCHAFT' | 'VERTRAG'; vertraege: { adrnr: string; vertragnr: string }[];
  mehrfach: boolean; grund: string | null; eingang: string; status: KuendigungStatus; text: string; betroffen: string; ende: string | null;
  bearbeitet_von: string | null; ablehnung: string | null; abgelegt: boolean; gesendet: boolean;
}
type Ergebnis = { text: string; adrnr: string; betroffen: string; ende: string };

/** Die Kündigung ausführen, wie sie eingereicht wurde: Mehrfachauswahl, einzelner Vertrag oder Mitgliedschaft */
function ausfuehren(tx: Db, a: { adrnr: string; vertraege: { adrnr: string; vertragnr: string }[]; mehrfach: boolean; grund: string | null; stichtag: string }, v: Verein, benutzer: string): Promise<Ergebnis> {
  const zeit = { adrnr: a.adrnr, stichtag: a.stichtag };
  if (a.mehrfach) return kuendigenMehrere(tx, '', a.vertraege, a.grund, v, benutzer, zeit);
  const [vt] = a.vertraege;
  return kuendigen(tx, '', vt ? { art: 'VERTRAG', adrnr: vt.adrnr, vertragnr: vt.vertragnr, grund: a.grund } : { art: 'MITGLIEDSCHAFT', grund: a.grund }, v, benutzer, zeit);
}

const PROBE = Symbol('probe');

/**
 * Was die Kündigung bewirken würde: ausgeführt und wieder zurückgenommen (Savepoint). So gelten beim Einreichen dieselben
 * Prüfungen und derselbe Wortlaut wie später bei der Freigabe – ohne dass sich etwas ändert.
 */
async function probe(tx: Db, a: Parameters<typeof ausfuehren>[1], v: Verein, benutzer: string): Promise<Ergebnis & { austritt: boolean }> {
  const halter: { r?: Ergebnis & { austritt: boolean } } = {};
  try {
    await tx.savepoint(async (sp) => {
      const x = await ausfuehren(sp as unknown as Db, a, v, benutzer);
      const [m] = await sp`select austritt from tco.mitglieder where adrnr = ${a.adrnr}`;
      halter.r = { ...x, austritt: !!m?.austritt };
      throw PROBE;
    });
  } catch (e) { if (e !== PROBE) throw e; }
  if (!halter.r) throw new BusinessError('Die Kündigung ließ sich nicht prüfen.');
  return halter.r;
}

/** Schritt 1: Das Mitglied reicht die Kündigung ein – es ändert sich noch nichts */
export async function einreichen(tx: Db, benutzerId: string, k: KuendigungEingabe, v: Verein, benutzer: string): Promise<{ id: number; text: string }> {
  const eigene = await eigeneAdrnr(tx, benutzerId);
  const [vorher] = await tx`select austritt from tco.mitglieder where adrnr = ${eigene}`;
  const vertraege = k.vertraege ? k.vertraege.map((x) => ({ adrnr: leer(x.adrnr), vertragnr: leer(x.vertragnr) }))
    : k.art === 'VERTRAG' ? [{ adrnr: leer(k.adrnr ?? eigene), vertragnr: leer(k.vertragnr) }] : [];
  // schon eingereicht? Solange der Vorstand nicht entschieden hat, nicht noch einmal
  const offene = (await tx`select art, vertraege from tco.kuendigungen where adrnr = ${eigene} and status = 'OFFEN'`) as unknown as Pick<Zeile, 'art' | 'vertraege'>[];
  if (offene.some((o) => o.art === 'MITGLIEDSCHAFT')) throw new BusinessError('Die Kündigung der Mitgliedschaft ist bereits eingereicht und wartet auf die Freigabe durch den Vorstand.');
  if (offene.some((o) => o.vertraege.some((x) => vertraege.some((y) => y.adrnr === x.adrnr && y.vertragnr === x.vertragnr)))) {
    throw new BusinessError('Diese Kündigung ist bereits eingereicht und wartet auf die Freigabe durch den Vorstand.');
  }
  const grund = condense(k.grund ?? '') || null;
  const a = { adrnr: eigene, vertraege, mehrfach: !!k.vertraege, grund, stichtag: heute() };
  const r = await probe(tx, a, v, benutzer);
  const art = r.austritt && !vorher?.austritt ? 'MITGLIEDSCHAFT' : 'VERTRAG';
  const [neu] = await tx`
    insert into tco.kuendigungen (adrnr, benutzer_id, benutzer, art, vertraege, mehrfach, grund, eingang, text, betroffen, ende)
    values (${eigene}, ${benutzerId}, ${benutzer}, ${art}, ${tx.json(vertraege as never)}, ${a.mehrfach}, ${grund}, ${a.stichtag}, ${r.text}, ${r.betroffen}, ${r.ende})
    returning id::int as id`;
  await notizAnlegen(tx, r.betroffen, `Kündigung über „Meine Mitgliedschaft“ eingereicht durch ${benutzer} – wartet auf die Freigabe durch den Vorstand: ${r.text}${grund ? ` Grund: ${grund}` : ''}`, 'Portal');
  return { id: neu.id as number, text: r.text };
}

async function zeile(db: Db, id: number, sperren = false): Promise<Zeile> {
  const [k] = (await db`
    select id::int as id, adrnr, benutzer_id::text as benutzer_id, benutzer, art, vertraege, mehrfach, grund, eingang::text as eingang, status, text, betroffen,
           ende::text as ende, bearbeitet_von, ablehnung, abgelegt, gesendet
      from tco.kuendigungen where id = ${id} ${sperren ? db`for update` : db``}`) as unknown as Zeile[];
  if (!k) throw new BusinessError('Diese Kündigung gibt es nicht (mehr).', 404);
  return k;
}

/** Ansicht für den Vorstand: wer kündigt was, mit welchem Grund – und wie weit die Bearbeitung ist */
export async function kuendigungLesen(db: Db, id: number) {
  const k = await zeile(db, id);
  const [m] = await db`select vorname, nachname, mitglnrn, email, austritt::text as austritt from tco.mitglieder where adrnr = ${k.adrnr}`;
  return {
    id: k.id, status: k.status, art: k.art, adrnr: k.adrnr, name: condense(`${m?.vorname ?? ''} ${m?.nachname ?? ''}`), mitglnrn: leer(m?.mitglnrn),
    email: leer(m?.email) || null, eingang: k.eingang, eingereicht_von: k.benutzer, grund: k.grund, text: k.text, ende: k.ende,
    bearbeitet_von: k.bearbeitet_von, ablehnung: k.ablehnung, abgelegt: k.abgelegt, gesendet: k.gesendet,
  };
}

/** Schritt 2: Freigabe – die Kündigung wird mit dem Tag des Eingangs ausgeführt */
export async function freigeben(tx: Db, id: number, v: Verein, wer: string): Promise<{ text: string }> {
  const k = await zeile(tx, id, true);
  if (k.status !== 'OFFEN') throw new BusinessError(k.status === 'ABGELEHNT' ? 'Diese Kündigung wurde abgelehnt.' : 'Diese Kündigung ist bereits freigegeben.', 409);
  const r = await ausfuehren(tx, { adrnr: k.adrnr, vertraege: k.vertraege, mehrfach: k.mehrfach, grund: k.grund, stichtag: k.eingang }, v, `${k.benutzer}, freigegeben von ${wer}`);
  await tx`update tco.kuendigungen set status = 'FREIGEGEBEN', text = ${r.text}, betroffen = ${r.betroffen}, ende = ${r.ende}, bearbeitet_am = now(), bearbeitet_von = ${wer} where id = ${id}`;
  // der Kassenwart erfährt es im Arbeitsvorrat (Hinweis, bis „gesehen“)
  await tcoHinweis(tx, {
    quelle: 'MG_KUENDIGUNG', objekt: `${k.adrnr}:${id}`, bereich: 'Kassenwart', recht: 'tco.mitglieder:display', art: 'Kündigung freigegeben', state: 'Critical', icon: 'employee',
    titel: `${k.benutzer} (Mitglied ${k.adrnr})`, text: `${r.text}${k.grund ? ` Grund: ${k.grund}` : ''} – freigegeben von ${wer}`, pfad: `/tco/mitglieder?adrnr=${k.adrnr}`,
  });
  return { text: r.text };
}

/** Schritt 3a: Kündigungsbestätigung zur Prüfung – erzeugt aus dem Stand nach der Freigabe, noch nicht abgelegt oder gesendet */
export async function bestaetigungPdf(db: Db, id: number, v: Verein): Promise<{ pdf: Buffer; dateiname: string }> {
  const k = await zeile(db, id);
  if (k.status !== 'FREIGEGEBEN' && k.status !== 'ABGESCHLOSSEN') throw new BusinessError('Die Kündigungsbestätigung gibt es erst nach der Freigabe.', 409);
  const d = await druckdatenLesen(db, k.betroffen);
  return { pdf: await unterlagePdf(v, '4', d), dateiname: `Kuendigungsbestaetigung_${leer(d.m.nachname)}_${leer(d.m.vorname)}.pdf` };
}

/**
 * Schritt 3b: Bestätigung in der Mitgliederakte ablegen und an das Mitglied senden. Ohne Transaktion (Paperless, E-Mail);
 * das Ergebnis schreibt der Aufrufer mit abschliessen() fest. Geht die E-Mail nicht hinaus, bleibt die Kündigung
 * FREIGEGEBEN im Arbeitsvorrat – erneut senden oder ohne E-Mail abschließen (Bestätigung herunterladen und zustellen).
 */
export async function bestaetigungSenden(db: Db, id: number, v: Verein, wer: string, ohneMail: boolean) {
  const k = await zeile(db, id);
  if (k.status !== 'FREIGEGEBEN') throw new BusinessError(k.status === 'ABGESCHLOSSEN' ? 'Die Kündigungsbestätigung ist bereits versendet.' : 'Die Kündigung ist noch nicht freigegeben.', 409);
  if (ohneMail) return { k, gesendet: false, abgelegt: k.abgelegt, hinweise: [] as string[], fertig: true };
  const r = await kuendigungBestaetigen(db, v, { adrnr: k.adrnr, betroffen: k.betroffen, text: k.text }, k.grund, { ablegen: !k.abgelegt, wer });
  return { k, gesendet: r.gesendet, abgelegt: r.abgelegt, hinweise: r.hinweise, fertig: r.gesendet };
}
export async function abschliessen(tx: Db, id: number, r: { gesendet: boolean; abgelegt: boolean; fertig: boolean }): Promise<void> {
  await tx`update tco.kuendigungen set abgelegt = ${r.abgelegt}, gesendet = ${r.gesendet},
                  status = ${r.fertig ? 'ABGESCHLOSSEN' : tx`status`}, abgeschlossen_am = ${r.fertig ? tx`now()` : tx`abgeschlossen_am`}
            where id = ${id} and status = 'FREIGEGEBEN'`;
}

/** Ablehnung: nichts ändert sich an Verträgen und Mitgliedschaft; Notiz am Mitglied */
export async function ablehnen(tx: Db, id: number, grund: string, wer: string): Promise<Zeile> {
  const k = await zeile(tx, id, true);
  if (k.status !== 'OFFEN') throw new BusinessError('Nur eine noch nicht freigegebene Kündigung lässt sich ablehnen.', 409);
  await tx`update tco.kuendigungen set status = 'ABGELEHNT', ablehnung = ${grund}, bearbeitet_am = now(), bearbeitet_von = ${wer} where id = ${id}`;
  await notizAnlegen(tx, k.betroffen, `Kündigung vom ${dat(k.eingang)} (${k.text}) von ${wer} nicht freigegeben. Grund: ${grund}`, wer);
  return k;
}

/** nach der Ablehnung: das Mitglied per E-Mail unterrichten – Fehler als Hinweis, die Ablehnung bleibt bestehen */
export async function ablehnungMitteilen(db: Db, v: Verein, k: Zeile, grund: string, wer: string): Promise<string[]> {
  const kontakt = await kontaktLesen(db, k.adrnr);
  if (!v.n8n_mail_url) return ['Der Mailversand ist nicht eingerichtet – bitte das Mitglied selbst unterrichten.'];
  if (!kontakt?.email) return ['Keine E-Mail-Adresse hinterlegt – bitte das Mitglied selbst unterrichten.'];
  try {
    await mailSenden(v, {
      modus: 'senden', anwendung: 'Mitglieder', objekt: k.betroffen, an: kontakt.email, cc: v.email ?? '', benutzer: wer, anhaenge: [],
      betreff: `${v.name}: Ihre Kündigung vom ${dat(k.eingang)}`,
      text: `Hallo ${kontakt.vorname ?? ''},\n\nIhre Kündigung vom ${dat(k.eingang)} konnten wir nicht freigeben.\n\nEingereicht: ${k.text}\nGrund: ${grund}\n\nBei Fragen melden Sie sich bitte beim Vorstand.\n\n${v.name}`,
    });
    return [];
  } catch (e) { return [`E-Mail an das Mitglied nicht gesendet: ${(e as Error).message}`]; }
}
