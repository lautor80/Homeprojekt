/**
 * Änderung der Mitgliedschaft aus „Meine Mitgliedschaft“ (Beitragswechsel, Jugendtraining) mit Freigabe durch den Vorstand –
 * wie die Kündigung (kuendigung.ts):
 *
 *  1. Das Mitglied reicht ein (einreichen): geprüft mit denselben Regeln wie bisher (selbstvorgang.ts), aber an den Verträgen
 *     ändert sich nichts. Termine (Wechsel ab, Trainingsbeginn) werden dabei festgelegt. Status OFFEN, Eintrag im
 *     Arbeitsvorrat des Vorstands, Push an alle mit tco.mitglieder:edit.
 *  2. Der Vorstand gibt frei (freigeben): Erst jetzt wird die Änderung ausgeführt (vorgaenge.ts) – Status FREIGEGEBEN.
 *  3. Unmittelbar danach geht die Mitgliederinformation per E-Mail an das Mitglied (bzw. an den Zahler der Person) und wird
 *     in der Mitgliederakte abgelegt (mitteilen) – Status ABGESCHLOSSEN. Ging die E-Mail nicht hinaus, bleibt der Antrag
 *     FREIGEGEBEN im Arbeitsvorrat: erneut senden oder ohne E-Mail abschließen.
 *  Oder der Vorstand lehnt ab (ablehnen): nichts ändert sich, das Mitglied erfährt den Grund per E-Mail.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db, Verein } from '../verein.js';
import { condense, dat } from '../format.js';
import { kontaktLesen, mailSenden } from '../kommunikation.js';
import { tcoHinweis } from '../hinweise.js';
import { fuellen, mailtextVorlage } from '../mailtexte.js';
import { notizAnlegen } from './logik.js';
import { selbstVorgang, type SelbstEingabe } from './selbstvorgang.js';
import { unterlageVersenden, vorgang, VORGANG_TEXT } from './vorgaenge.js';

export type AenderungTyp = 'BEITRAGSWECHSEL' | 'JUGENDTRAINING';
export type AenderungStatus = 'OFFEN' | 'FREIGEGEBEN' | 'ABGESCHLOSSEN' | 'ABGELEHNT';
interface Zeile {
  id: number; typ: AenderungTyp; adrnr: string; antragsteller: string; mail_an: string; benutzer_id: string | null; benutzer: string;
  vertragnr: string | null; art: string; artname: string; ab: string; text: string; schritte: string[]; eingang: string; status: AenderungStatus;
  bearbeitet_von: string | null; ablehnung: string | null; abgelegt: boolean; gesendet: boolean;
}

/** Schritt 1: einreichen – geprüft wie bisher, es ändert sich noch nichts */
export async function einreichen(tx: Db, benutzerId: string, e: SelbstEingabe, benutzer: string): Promise<{ id: number; text: string; schritte: string[]; warnungen: string[] }> {
  // dieselbe Prüfung wie beim sofortigen Ausführen (nur Angebotenes, feste Termine und Beträge) – ohne zu schreiben
  const plan = await selbstVorgang(tx, benutzerId, e, false, benutzer);
  if (e.typ === 'BEITRAGSWECHSEL') {
    const [offen] = await tx`select id from tco.mg_aenderungen where adrnr = ${e.adrnr} and typ = 'BEITRAGSWECHSEL' and status = 'OFFEN'`;
    if (offen) throw new BusinessError('Für diese Person ist bereits ein Beitragswechsel eingereicht und wartet auf die Freigabe durch den Vorstand.');
  }
  const p = plan.parameter;
  const [neu] = await tx`
    insert into tco.mg_aenderungen (typ, adrnr, antragsteller, mail_an, benutzer_id, benutzer, vertragnr, art, artname, ab, text, schritte)
    values (${e.typ}, ${e.adrnr}, ${plan.eigene}, ${plan.mailAn}, ${benutzerId}, ${benutzer}, ${p.vertragnr}, ${p.art}, ${p.artname}, ${p.ab},
            ${plan.text}, ${tx.json(plan.schritte.filter((s) => !s.startsWith('Notiz am Mitglied')) as never)})
    returning id::int as id`;
  await notizAnlegen(tx, e.adrnr, `${VORGANG_TEXT[e.typ]} über „Meine Mitgliedschaft“ eingereicht durch ${benutzer} – wartet auf die Freigabe durch den Vorstand: ${plan.text}`, 'Portal');
  return { id: neu.id as number, text: plan.text, schritte: plan.schritte, warnungen: plan.warnungen };
}

async function zeile(db: Db, id: number, sperren = false): Promise<Zeile> {
  const [a] = (await db`
    select id::int as id, typ, adrnr, antragsteller, mail_an, benutzer_id::text as benutzer_id, benutzer, vertragnr, art, artname, ab::text as ab, text, schritte,
           eingang::text as eingang, status, bearbeitet_von, ablehnung, abgelegt, gesendet
      from tco.mg_aenderungen where id = ${id} ${sperren ? db`for update` : db``}`) as unknown as Zeile[];
  if (!a) throw new BusinessError('Diesen Antrag gibt es nicht (mehr).', 404);
  return a;
}

/** Ansicht für den Vorstand */
export async function aenderungLesen(db: Db, id: number) {
  const a = await zeile(db, id);
  const [m] = await db`select vorname, nachname, mitglnrn from tco.mitglieder where adrnr = ${a.adrnr}`;
  const k = await kontaktLesen(db, a.mail_an);
  const [z] = a.mail_an !== a.adrnr ? await db`select vorname, nachname from tco.mitglieder where adrnr = ${a.mail_an}` : [];
  return {
    id: a.id, typ: a.typ, typ_text: VORGANG_TEXT[a.typ], status: a.status, adrnr: a.adrnr, name: condense(`${m?.vorname ?? ''} ${m?.nachname ?? ''}`),
    mitglnrn: (m?.mitglnrn as string | null)?.trim() || null, eingang: a.eingang, eingereicht_von: a.benutzer, artname: a.artname, ab: a.ab,
    text: a.text, schritte: a.schritte, email: k?.email || null, mail_an: z ? condense(`${z.vorname ?? ''} ${z.nachname ?? ''}`) : null,
    bearbeitet_von: a.bearbeitet_von, ablehnung: a.ablehnung, abgelegt: a.abgelegt, gesendet: a.gesendet,
  };
}

/** Schritt 2: Freigabe – die Änderung wird mit den beim Einreichen festgelegten Terminen ausgeführt */
export async function freigeben(tx: Db, id: number, wer: string) {
  const a = await zeile(tx, id, true);
  if (a.status !== 'OFFEN') throw new BusinessError(a.status === 'ABGELEHNT' ? 'Dieser Antrag wurde abgelehnt.' : 'Dieser Antrag ist bereits freigegeben.', 409);
  const benutzer = `${a.benutzer} über „Meine Mitgliedschaft“, freigegeben von ${wer}`;
  const plan = a.typ === 'BEITRAGSWECHSEL'
    ? await vorgang(tx, { typ: 'BEITRAGSWECHSEL', adrnr: a.adrnr, vertragnr: a.vertragnr ?? '', art: a.art, ab: a.ab }, true, benutzer, 'Portal')
    : await vorgang(tx, { typ: 'JUGENDTRAINING', adrnr: a.adrnr, art: a.art, beginn: a.ab, mehrfach: true }, true, benutzer, 'Portal');
  await tx`update tco.mg_aenderungen set status = 'FREIGEGEBEN', text = ${plan.text}, bearbeitet_am = now(), bearbeitet_von = ${wer} where id = ${id}`;
  // der Kassenwart erfährt es im Arbeitsvorrat (Hinweis, bis „gesehen“) – wie bisher beim sofortigen Ausführen
  await tcoHinweis(tx, {
    quelle: 'MG_VORGANG', objekt: `${a.adrnr}:${a.typ}:${id}`, bereich: 'Kassenwart', recht: 'tco.mitglieder:display', art: `${VORGANG_TEXT[a.typ]} durch das Mitglied`,
    icon: 'employee', titel: a.adrnr === a.antragsteller ? `${a.benutzer} (Mitglied ${a.adrnr})` : `${a.benutzer} für Mitglied ${a.adrnr}`,
    text: `${plan.text} – freigegeben von ${wer}`, pfad: `/tco/mitglieder?adrnr=${a.adrnr}`,
  });
  return { a, plan };
}

/**
 * Schritt 3: Mitgliederinformation ablegen und an das Mitglied senden (ohne Transaktion: Paperless, E-Mail). Das Ergebnis
 * schreibt der Aufrufer mit festhalten() fest. ohneMail: abschließen, ohne zu senden (Unterlage selbst zustellen).
 */
export async function mitteilen(db: Db, v: Verein, id: number, wer: string, o: { ohneMail?: boolean } = {}) {
  const a = await zeile(db, id);
  if (a.status !== 'FREIGEGEBEN') throw new BusinessError(a.status === 'ABGESCHLOSSEN' ? 'Die Mitgliederinformation ist bereits versendet.' : 'Der Antrag ist noch nicht freigegeben.', 409);
  if (o.ohneMail) return { gesendet: false, abgelegt: a.abgelegt, fertig: true, hinweise: [] as string[], unterlage: null };
  const zusatz = `${VORGANG_TEXT[a.typ]} vom ${dat(a.eingang)} – vom Vorstand freigegeben: ${a.text}`;
  // Mitgliederinformation (Art 2) mit den neuen Verträgen – wie beim Beitragswechsel/Jugendtraining in der Mitgliederverwaltung
  const u = await unterlageVersenden(db, v, a.adrnr, '2', zusatz, wer, a.mail_an);
  return { gesendet: u.gesendet, abgelegt: a.abgelegt || u.abgelegt, fertig: u.gesendet, hinweise: u.hinweise, unterlage: u };
}
export async function festhalten(tx: Db, id: number, r: { gesendet: boolean; abgelegt: boolean; fertig: boolean }) {
  await tx`update tco.mg_aenderungen set abgelegt = ${r.abgelegt}, gesendet = ${r.gesendet || tx`gesendet`},
                  status = ${r.fertig ? 'ABGESCHLOSSEN' : tx`status`}, abgeschlossen_am = ${r.fertig ? tx`now()` : tx`abgeschlossen_am`}
            where id = ${id} and status = 'FREIGEGEBEN'`;
}

/** Ablehnung: nichts ändert sich; Notiz am Mitglied */
export async function ablehnen(tx: Db, id: number, grund: string, wer: string): Promise<Zeile> {
  const a = await zeile(tx, id, true);
  if (a.status !== 'OFFEN') throw new BusinessError('Nur ein noch nicht freigegebener Antrag lässt sich ablehnen.', 409);
  await tx`update tco.mg_aenderungen set status = 'ABGELEHNT', ablehnung = ${grund}, bearbeitet_am = now(), bearbeitet_von = ${wer} where id = ${id}`;
  await notizAnlegen(tx, a.adrnr, `${VORGANG_TEXT[a.typ]} vom ${dat(a.eingang)} (${a.text}) von ${wer} nicht freigegeben. Grund: ${grund}`, wer);
  return a;
}

/** nach der Ablehnung: das Mitglied per E-Mail unterrichten – Fehler als Hinweis, die Ablehnung bleibt bestehen */
export async function ablehnungMitteilen(db: Db, v: Verein, a: Zeile, grund: string, wer: string): Promise<string[]> {
  const kontakt = await kontaktLesen(db, a.mail_an);
  if (!v.n8n_mail_url) return ['Der Mailversand ist nicht eingerichtet – bitte das Mitglied selbst unterrichten.'];
  if (!kontakt?.email) return ['Keine E-Mail-Adresse hinterlegt – bitte das Mitglied selbst unterrichten.'];
  try {
    const werte = { Vorname: kontakt.vorname ?? '', Eingang: dat(a.eingang), Vorgang: VORGANG_TEXT[a.typ], Eingereicht: a.text, Grund: grund };
    const vorlage = await mailtextVorlage(db, v, 'mitglied.aenderung.abgelehnt');
    await mailSenden(v, {
      modus: 'senden', anwendung: 'Mitglieder', objekt: a.adrnr, an: kontakt.email, cc: v.email ?? '', benutzer: wer, anhaenge: [],
      betreff: fuellen(vorlage.betreff, werte), text: fuellen(vorlage.text, werte),
    });
    return [];
  } catch (e) { return [`E-Mail an das Mitglied nicht gesendet: ${(e as Error).message}`]; }
}
