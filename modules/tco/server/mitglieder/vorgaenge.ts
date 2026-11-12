/**
 * Geführte Vorgänge der Mitgliederverwaltung (#154): Beitragswechsel, Abschluss Jugendtraining, Kündigung.
 *
 * Jeder Vorgang läuft in drei Schritten: Angaben erfassen (mit Vorschlägen aus Stamm und Fristen) → prüfen (dieselbe
 * Logik ohne Schreiben: Liste der geplanten Änderungen und Hinweise) → ausführen (in einer Transaktion, mit Notiz
 * am Mitglied und Änderungsbeleg); danach optional Unterlage erzeugen, in Paperless ablegen und per E-Mail senden
 * (Mitgliederinformation bzw. Kündigungsbestätigung).
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db, Verein } from '../verein.js';
import { plAktiv } from '../verein.js';
import { addTage, condense, dat, heute } from '../format.js';
import { kontaktLesen, mailSenden } from '../kommunikation.js';
import {
  ART_JUGEND, austrittSichern, betragAm, leer, mitgliedLesen, notizAnlegen, vertraegeLesen, vertragAendern, vertragNeu, vertragsarten,
  vertragsbeginn, vertragsZahler, verweis, type Vertrag,
} from './logik.js';
import { ART_TEXT, druckdatenLesen, unterlagePdf, type Art } from './pdf.js';
import { mailText, unterlageAblegen } from './dokumente.js';

export const VORGAENGE = ['BEITRAGSWECHSEL', 'JUGENDTRAINING', 'KUENDIGUNG'] as const;
export type VorgangTyp = (typeof VORGAENGE)[number];
export const VORGANG_TEXT: Record<VorgangTyp, string> = {
  BEITRAGSWECHSEL: 'Beitragswechsel', JUGENDTRAINING: 'Abschluss Jugendtraining', KUENDIGUNG: 'Kündigung',
};
/** Kündigungsfrist laut Mitgliederinformation: 4 Wochen */
export const FRIST_TAGE = 28;

const euro = (n: number) => `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const istJugend = (art: string) => leer(art) === ART_JUGEND;

/** frühestes Vertragsende nach Eingang der Kündigung und 4 Wochen Frist: Mitgliedschaft 31.12., Jugendtraining 30.09. */
export function fristEnde(eingang: string, jugend: boolean): string {
  const d = addTage(eingang, FRIST_TAGE);
  const j = Number(d.slice(0, 4));
  if (!jugend) return `${j}-12-31`;
  return d <= `${j}-09-30` ? `${j}-09-30` : `${j + 1}-09-30`;
}

/** Beginn eines Beitragswechsels: nächster Halbjahresbeginn (01.01./01.07.) nach heute */
export function wechselAb(h = heute()): string {
  return vertragsbeginn(addTage(h, 1), '') ?? h;
}

function alterAm(geburtsdatum: string | null, datum: string): number | null {
  if (!geburtsdatum) return null;
  let a = Number(datum.slice(0, 4)) - Number(geburtsdatum.slice(0, 4));
  if (datum.slice(5) < geburtsdatum.slice(5)) a--;
  return a;
}

// ---------------------------------------------------------------- Kontext für den Assistenten
export async function vorgangKontext(db: Db, adrnr: string, v: Verein) {
  const m = await mitgliedLesen(db, adrnr);
  const h = heute();
  const eigene = (await vertraegeLesen(db, m)).filter((x) => x.eigen);
  const { arten, turnusse } = await vertragsarten(db, wechselAb(h));
  const k = await kontaktLesen(db, adrnr);
  // Personen, die über dieses Mitglied zahlen (bei Kündigung zu beachten)
  const zahlende = await db`select adrnr, vorname, nachname from tco.mitglieder where adrnrkih = ${adrnr} and adrnr <> ${adrnr}
                              and (austritt is null or austritt >= ${h}) order by geburtsdatum nulls last`;
  return {
    person: {
      adrnr, name: condense(`${leer(m.vorname)} ${leer(m.nachname)}`), mitglnrn: leer(m.mitglnrn), geburtsdatum: m.geburtsdatum as string | null,
      alter: alterAm(m.geburtsdatum, h), eintritt: m.eintritt as string | null, austritt: m.austritt as string | null,
      mitglied: !!m.eintritt, email: k?.email ?? '',
    },
    vertraege: eigene,
    laufend: eigene.filter((x) => x.laeuft),
    arten, turnusse, zahler: await vertragsZahler(db),
    zahlende: zahlende.map((z) => ({ adrnr: z.adrnr as string, name: condense(`${leer(z.vorname)} ${leer(z.nachname)}`) })),
    vorschlag: {
      wechselAb: wechselAb(h),
      jugendAb: vertragsbeginn(h, ART_JUGEND) ?? h,
      eingang: h,
      endeMitgliedschaft: fristEnde(h, false),
      endeJugend: fristEnde(h, true),
    },
    fristTage: FRIST_TAGE,
    mail: !!v.n8n_mail_url && !!k?.email,
    paperless: plAktiv(v),
  };
}

// ---------------------------------------------------------------- Angaben je Vorgang
export interface Beitragswechsel { typ: 'BEITRAGSWECHSEL'; adrnr: string; vertragnr: string; art: string; ab: string; turnus?: string | null; betrag?: number | null; notiz?: string | null; unterlage?: boolean }
export interface Jugendtraining { typ: 'JUGENDTRAINING'; adrnr: string; art?: string | null; beginn: string; turnus?: string | null; betrag?: number | null; zahler?: string | null; notiz?: string | null; unterlage?: boolean }
export interface Kuendigung { typ: 'KUENDIGUNG'; adrnr: string; umfang: 'MITGLIEDSCHAFT' | 'VERTRAG'; vertragnr?: string | null; eingang: string; ende: string; grund?: string | null; unterlage?: boolean }
export type Vorgang = Beitragswechsel | Jugendtraining | Kuendigung;

export interface Plan {
  /** Kurzbeschreibung für Notiz und Änderungsbeleg */
  text: string;
  /** geplante bzw. ausgeführte Änderungen in Reihenfolge */
  schritte: string[];
  /** fachliche Hinweise (kein Fehler) */
  warnungen: string[];
  /** Unterlage, die im Anschluss erzeugt werden kann */
  unterlage: Art;
}

/**
 * Prüft einen Vorgang und führt ihn aus (ausfuehren = true, innerhalb einer Transaktion) bzw. beschreibt nur die
 * geplanten Änderungen (ausfuehren = false). Fehler als BusinessError.
 */
export async function vorgang(tx: Db, g: Vorgang, ausfuehren: boolean, benutzer: string): Promise<Plan> {
  const m = await mitgliedLesen(tx, g.adrnr);
  const name = condense(`${leer(m.vorname)} ${leer(m.nachname)}`);
  const eigene = (await vertraegeLesen(tx, m)).filter((x) => x.eigen);
  const p = g.typ === 'BEITRAGSWECHSEL' ? await wechsel(tx, g, m, eigene, ausfuehren)
    : g.typ === 'JUGENDTRAINING' ? await jugend(tx, g, m, eigene, ausfuehren)
      : await kuendigung(tx, g, m, eigene, ausfuehren);
  const notiz = condense(('notiz' in g ? g.notiz : g.typ === 'KUENDIGUNG' ? g.grund : '') ?? '');
  p.schritte.push(`Notiz am Mitglied ${name}: „${VORGANG_TEXT[g.typ]}: ${p.text}“`);
  if (ausfuehren) await notizAnlegen(tx, g.adrnr, `${VORGANG_TEXT[g.typ]} (geführter Vorgang) durch ${benutzer}: ${p.text}${notiz ? ` ${g.typ === 'KUENDIGUNG' ? 'Grund' : 'Notiz'}: ${notiz}` : ''}`, benutzer);
  if (g.unterlage) p.schritte.push(`${ART_TEXT[p.unterlage]} erzeugen, in der Mitgliederakte ablegen und per E-Mail senden`);
  return p;
}

async function wechsel(tx: Db, g: Beitragswechsel, m: Record<string, any>, eigene: Vertrag[], aus: boolean): Promise<Plan> {
  const alt = eigene.find((x) => x.vertragnr === leer(g.vertragnr));
  if (!alt) throw new BusinessError('Bitte den bisherigen Vertrag des Mitglieds wählen.');
  if (!alt.laeuft) throw new BusinessError(`Der Vertrag „${alt.artname}“ ist bereits beendet.`);
  if (alt.vertragbegin && g.ab <= alt.vertragbegin) throw new BusinessError(`Der Wechsel muss nach dem Beginn des bisherigen Vertrags (${dat(alt.vertragbegin)}) liegen.`);
  if (alt.vertragende && alt.vertragende < g.ab) throw new BusinessError(`Der bisherige Vertrag endet bereits am ${dat(alt.vertragende)}.`);
  if (m.austritt && m.austritt < g.ab) throw new BusinessError(`Das Mitglied tritt am ${dat(m.austritt)} aus – ein Wechsel danach ist nicht möglich.`);
  if (leer(g.art) === alt.art) throw new BusinessError('Bitte eine andere Beitragsart als die bisherige wählen.');
  const { arten } = await vertragsarten(tx, g.ab);
  const neu = arten.find((a) => a.art === leer(g.art));
  if (!neu) throw new BusinessError(`Die Beitragsart ${g.art} ist nicht (mehr) aktiv.`);
  const doppelt = eigene.find((x) => x.art === neu.art && x.vertragnr !== alt.vertragnr && (!x.vertragende || x.vertragende >= g.ab));
  if (doppelt) throw new BusinessError(`Ab ${dat(g.ab)} läuft bereits ein Vertrag „${doppelt.artname}“ (Nr. ${doppelt.vertragnr}).`);
  const betrag = g.betrag ?? (await betragAm(tx, neu.art, g.ab)) ?? neu.betrag;
  const turnus = leer(g.turnus) || neu.turnus || alt.sollstellung;
  const bis = addTage(g.ab, -1);
  const warnungen: string[] = [];
  if (!istJugend(neu.art) && !['01-01', '07-01'].includes(g.ab.slice(5))) warnungen.push('Mitgliedsbeiträge wechseln üblicherweise zum Halbjahr (01.01. oder 01.07.).');
  const alter = alterAm(m.geburtsdatum, g.ab);
  if (alter != null && alter < 18 && /erwachs/i.test(neu.name)) warnungen.push(`Am ${dat(g.ab)} ist ${leer(m.vorname)} erst ${alter} Jahre alt.`);
  if (betrag === alt.betrag) warnungen.push('Der neue Beitrag entspricht dem bisherigen.');
  const schritte = [
    `Vertrag „${alt.artname}“ (Nr. ${alt.vertragnr}, ${euro(alt.betrag)} ${alt.sollstellung}) endet am ${dat(bis)}`,
    `Neuer Vertrag „${neu.name}“ ab ${dat(g.ab)}: ${euro(betrag)} ${turnus}${alt.zahler_adrnr ? `, Zahler ${alt.zahler}` : ''}${alt.vertragende ? `, bis ${dat(alt.vertragende)}` : ''}`,
  ];
  if (aus) {
    await vertragAendern(tx, g.adrnr, alt.vertragnr, { ende: bis });
    const nr = await vertragNeu(tx, { adrnr: g.adrnr, art: neu.art, beginn: g.ab, ende: alt.vertragende, turnus, betrag, zahler: alt.zahler_adrnr || null });
    schritte[1] = schritte[1].replace('Neuer Vertrag', `Neuer Vertrag Nr. ${nr}`);
  }
  return { text: `${alt.artname} bis ${dat(bis)}, ${neu.name} ab ${dat(g.ab)} (${euro(betrag)} ${turnus}).`, schritte, warnungen, unterlage: '2' };
}

async function jugend(tx: Db, g: Jugendtraining, m: Record<string, any>, eigene: Vertrag[], aus: boolean): Promise<Plan> {
  const artNr = leer(g.art) || ART_JUGEND;
  const { arten } = await vertragsarten(tx, g.beginn);
  const art = arten.find((a) => a.art === artNr);
  if (!art) throw new BusinessError(`Die Vertragsart ${artNr} (Jugendtraining) ist nicht aktiv – bitte im Beitragsstamm prüfen.`);
  if (m.austritt && m.austritt < g.beginn) throw new BusinessError(`Die Person ist zum ${dat(m.austritt)} ausgetreten.`);
  const laufend = eigene.find((x) => x.art === art.art && (!x.vertragende || x.vertragende >= g.beginn));
  if (laufend) throw new BusinessError(`Es besteht bereits ein Vertrag „${laufend.artname}“ ab ${dat(laufend.vertragbegin)}${laufend.vertragende ? ` bis ${dat(laufend.vertragende)}` : ''}.`);
  const betrag = g.betrag ?? (await betragAm(tx, art.art, g.beginn)) ?? art.betrag;
  const turnus = leer(g.turnus) || art.turnus;
  const zahler = leer(g.zahler);
  const zl = zahler ? (await vertragsZahler(tx)).find((z) => z.adrnr === zahler) : null;
  if (zahler && !zl) throw new BusinessError('Der gewählte Zahler hat kein aktives SEPA-Mandat.');
  const warnungen: string[] = [];
  if (!m.eintritt) warnungen.push('Die Person ist kein Vereinsmitglied – die Teilnahme läuft als Nichtmitglied.');
  if (g.beginn.slice(8) !== '01') warnungen.push('Das Jugendtraining beginnt üblicherweise zum Monatsersten.');
  const alter = alterAm(m.geburtsdatum, g.beginn);
  if (alter != null && alter >= 18) warnungen.push(`Zu Beginn ist ${leer(m.vorname)} bereits ${alter} Jahre alt.`);
  if (!zahler && !verweis(m.adrnrkih) && leer(m.zahlungsart) === 'L' && !leer(m.iban1)) warnungen.push('Lastschrift ohne IBAN – bitte Bankverbindung oder Zahler prüfen.');
  const schritte = [`Neuer Vertrag „${art.name}“ ab ${dat(g.beginn)}: ${euro(betrag)} ${turnus}, unbefristet (kündbar zum 30.09.)${zl ? `, Zahler ${zl.text}` : ''}`];
  if (aus) {
    const nr = await vertragNeu(tx, { adrnr: g.adrnr, art: art.art, beginn: g.beginn, ende: null, turnus, betrag, zahler: zahler || null });
    schritte[0] = schritte[0].replace('Neuer Vertrag', `Neuer Vertrag Nr. ${nr}`);
  }
  return { text: `${art.name} ab ${dat(g.beginn)} (${euro(betrag)} ${turnus}).`, schritte, warnungen, unterlage: '2' };
}

async function kuendigung(tx: Db, g: Kuendigung, m: Record<string, any>, eigene: Vertrag[], aus: boolean): Promise<Plan> {
  if (g.ende < g.eingang) throw new BusinessError('Das Ende liegt vor dem Eingang der Kündigung.');
  const warnungen: string[] = [];
  const schritte: string[] = [];
  let text: string;
  if (g.umfang === 'MITGLIEDSCHAFT') {
    if (m.austritt) throw new BusinessError(`Die Mitgliedschaft ist bereits zum ${dat(m.austritt)} gekündigt.`);
    if (!m.eintritt) throw new BusinessError('Die Person ist kein Vereinsmitglied – bitte einzelne Verträge kündigen.');
    if (m.eintritt > g.ende) throw new BusinessError(`Das Ende liegt vor dem Eintritt am ${dat(m.eintritt)}.`);
    const frist = fristEnde(g.eingang, false);
    if (g.ende < frist) warnungen.push(`Fristgerecht wäre der ${dat(frist)} (4 Wochen zum Jahresende) – abweichendes Ende ${dat(g.ende)}.`);
    schritte.push(`Austritt zum ${dat(g.ende)} – SEPA-Mandat gilt bis dahin; der Portal-Benutzer wird nach dem Austritt gesperrt`);
    const teile: string[] = [];
    for (const vt of eigene.filter((x) => x.laeuft)) {
      if (vt.vertragbegin && vt.vertragbegin > g.ende) { warnungen.push(`Vertrag „${vt.artname}“ beginnt erst am ${dat(vt.vertragbegin)} – bitte prüfen.`); continue; }
      const jf = fristEnde(g.eingang, true);
      const bis = istJugend(vt.art) && jf < g.ende ? jf : g.ende;
      if (vt.vertragende && vt.vertragende <= bis) continue;
      schritte.push(`Vertrag „${vt.artname}“ (Nr. ${vt.vertragnr}) endet am ${dat(bis)}`);
      teile.push(`${vt.artname} bis ${dat(bis)}`);
      if (aus) await vertragAendern(tx, g.adrnr, vt.vertragnr, { ende: bis });
    }
    if (aus) await austrittSichern(tx, g.adrnr, g.ende);
    const zahlende = await tx`select vorname, nachname from tco.mitglieder where adrnrkih = ${g.adrnr} and adrnr <> ${g.adrnr}
                               and (austritt is null or austritt > ${g.ende})`;
    if (zahlende.length) {
      warnungen.push(`Über dieses Mitglied zahlen weiterhin: ${zahlende.map((z) => condense(`${leer(z.vorname)} ${leer(z.nachname)}`)).join(', ')} – `
        + 'deren Verträge separat kündigen oder Zahler umstellen (sonst SEPA-Mandat in „Bank & SEPA“ manuell aktiv lassen).');
    }
    text = `Mitgliedschaft gekündigt (Eingang ${dat(g.eingang)}) zum ${dat(g.ende)}${teile.length ? ` (${teile.join(', ')})` : ''}.`;
  } else {
    const vt = eigene.find((x) => x.vertragnr === leer(g.vertragnr));
    if (!vt) throw new BusinessError('Bitte den zu kündigenden Vertrag wählen.');
    if (!vt.laeuft) throw new BusinessError('Der Vertrag ist bereits beendet.');
    if (vt.vertragende && vt.vertragende <= g.ende) throw new BusinessError(`Der Vertrag endet bereits am ${dat(vt.vertragende)}.`);
    if (vt.vertragbegin && g.ende < vt.vertragbegin) throw new BusinessError(`Das Ende liegt vor dem Vertragsbeginn ${dat(vt.vertragbegin)}.`);
    const frist = fristEnde(g.eingang, istJugend(vt.art));
    if (g.ende < frist) warnungen.push(`Fristgerecht wäre der ${dat(frist)} – abweichendes Ende ${dat(g.ende)}.`);
    const mitgliedsbeitraege = eigene.filter((x) => x.laeuft && x.vertragnr !== vt.vertragnr && !istJugend(x.art) && (!x.vertragende || x.vertragende > g.ende));
    if (!istJugend(vt.art) && !mitgliedsbeitraege.length && m.eintritt && !m.austritt) {
      warnungen.push('Danach läuft kein Mitgliedsbeitrag mehr – soll die ganze Mitgliedschaft gekündigt werden?');
    }
    schritte.push(`Vertrag „${vt.artname}“ (Nr. ${vt.vertragnr}, ${euro(vt.betrag)} ${vt.sollstellung}) endet am ${dat(g.ende)}`);
    if (aus) await vertragAendern(tx, g.adrnr, vt.vertragnr, { ende: g.ende });
    text = `${vt.artname} gekündigt (Eingang ${dat(g.eingang)}) zum ${dat(g.ende)}.`;
  }
  return { text, schritte, warnungen, unterlage: '4' };
}

/**
 * Unterlage nach dem Vorgang: PDF erzeugen, in Paperless ablegen und per E-Mail (n8n) an die Person senden,
 * Kopie an den Verein. Fehler werden als Hinweise zurückgegeben (der Vorgang selbst ist bereits gesichert).
 */
export async function unterlageVersenden(db: Db, v: Verein, adrnr: string, art: Art, zusatz: string, benutzer: string) {
  const hinweise: string[] = [];
  const d = await druckdatenLesen(db, adrnr);
  const pdf = await unterlagePdf(v, art, d);
  const dateiname = `${ART_TEXT[art].replace(/[^A-Za-zÄÖÜäöüß]/g, '')}_${leer(d.m.nachname)}_${leer(d.m.vorname)}.pdf`;
  let abgelegt = false;
  if (plAktiv(v)) {
    await unterlageAblegen(v, art, d.m, pdf, benutzer).then((a) => { abgelegt = true; hinweise.push(...a.warnungen); })
      .catch((e) => hinweise.push(`Ablage in Paperless nicht möglich: ${(e as Error).message}`));
  } else hinweise.push('Paperless ist nicht eingerichtet – die Unterlage wurde nicht abgelegt.');
  const k = await kontaktLesen(db, adrnr);
  let gesendet = false;
  if (!v.n8n_mail_url) hinweise.push('Der Mailversand ist nicht eingerichtet – bitte die Unterlage herunterladen.');
  else if (!k?.email) hinweise.push('Keine E-Mail-Adresse hinterlegt – bitte die Unterlage herunterladen.');
  else {
    const { betreff, text } = mailText(v, art, k.vorname, []);
    await mailSenden(v, {
      modus: 'senden', anwendung: 'Mitglieder', objekt: adrnr, an: k.email, cc: v.email ?? '', betreff,
      text: `${text}\n\n---\n${zusatz}`, benutzer, anhaenge: [{ dateiname, mime: 'application/pdf', inhalt: pdf }],
    }).then(() => { gesendet = true; }).catch((e) => hinweise.push(`E-Mail nicht gesendet: ${(e as Error).message}`));
  }
  return { pdf: pdf.toString('base64'), dateiname, titel: ART_TEXT[art], abgelegt, gesendet, an: k?.email ?? '', hinweise };
}
