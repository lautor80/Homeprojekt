/**
 * Mailprotokoll → „Erneut senden“ für fehlgeschlagene E-Mails.
 *
 * - Normale Mails: der beim Fehler gespeicherte Inhalt (samt Anhängen) wird unverändert erneut übergeben,
 *   mit demselben Absender wie beim ersten Versuch. Danach wird nachgezogen, was der erste Versand getan hätte
 *   (Hallenrechnung „versendet“, Verzehrbeleg „per Mail versendet“).
 * - Mails mit Zugangslinks werden nie gespeichert: es wird ein neuer Link erzeugt (Registrierung, Einladung),
 *   ältere werden ungültig. Mails mit Kennwort-Links/Startkennwörtern müssen in der Anwendung neu ausgelöst werden.
 */
import { BusinessError } from '../../../server/src/errors.js';
import { DB, type Db, type Verein } from './verein.js';
import { mailSenden, type MailAnhang, type MailFolge, type Wiederholung } from './kommunikation.js';
import { statusSetzen } from './halle/daten.js';
import { bestaetigungErneut } from './platz/routes.js';
import { einladungErneut } from './mitglieder/einladung.js';

interface GespeicherteMail {
  modus: 'senden' | 'entwurf'; anwendung: string; objekt: string; an: string; cc: string; bcc: string; betreff: string; text: string;
  html: boolean; antwort_an: string; absender: string | null; absender_name: string | null; persoenlich: boolean | null;
  anhaenge: (Omit<MailAnhang, 'inhalt'> & { inhalt: string })[];
}
type Nachricht = { wiederholung: Wiederholung } | { mail: GespeicherteMail; folge: MailFolge | null };

export const WIEDERHOLBAR = ['fehler', 'nicht_gesendet'];

/** Hinweis, warum ein Eintrag nicht erneut gesendet werden kann (null = kann) */
export function nichtWiederholbar(p: { status: string; nachricht: unknown; erneut_status: string | null }): string | null {
  if (!WIEDERHOLBAR.includes(p.status)) return null;
  if (p.erneut_status === 'gesendet' || p.erneut_status === 'entwurf') return null;
  const n = p.nachricht as Nachricht | null;
  if (!n) return 'Inhalt nicht gespeichert (älter als 30 Tage oder vor dem Update) – bitte in der Anwendung erneut senden.';
  if ('wiederholung' in n && n.wiederholung.art === 'NEU_AUSLOESEN') return n.wiederholung.hinweis;
  return null;
}

async function folgeNachziehen(tx: Db, f: MailFolge): Promise<string[]> {
  const warn: string[] = [];
  if (f.art === 'HALLENRECHNUNG') {
    for (const rgnr of f.rgnrs) {
      try { await statusSetzen(tx, rgnr, 'versendet'); } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        warn.push(`${rgnr}: ${e.message}`);
      }
    }
  } else if (f.art === 'VERZEHR') {
    await tx`update tco.vz_belege set versand_am = now(), versand_art = 'MAIL', email = coalesce(email, ${f.an}) where rgnr = ${f.rgnr}`;
  }
  return warn;
}

export async function mailWiederholen(tx: Db, v: Verein, id: number, wer: string): Promise<{ text: string; warnungen: string[] }> {
  const [p] = await tx`select id, status, nachricht, erneut_status from tco.mail_protokoll where id = ${id}`;
  if (!p) throw new BusinessError('Den Protokolleintrag gibt es nicht (mehr).', 404);
  if (!WIEDERHOLBAR.includes(p.status)) throw new BusinessError('Nur fehlgeschlagene E-Mails können erneut gesendet werden.');
  if (p.erneut_status === 'gesendet' || p.erneut_status === 'entwurf') throw new BusinessError('Diese E-Mail wurde bereits erneut gesendet.');
  const grund = nichtWiederholbar(p as never);
  if (grund) throw new BusinessError(grund);
  const n = p.nachricht as Nachricht;
  let text: string;
  let status = 'gesendet';
  const warnungen: string[] = [];
  try {
    if ('wiederholung' in n) {
      const w = n.wiederholung;
      if (w.art === 'REG_BESTAETIGUNG') text = await bestaetigungErneut(tx, v, w.id);
      else if (w.art === 'EINLADUNG') text = await einladungErneut(tx, v, w, wer);
      else throw new BusinessError(w.hinweis);
    } else {
      const m = n.mail;
      const r = await mailSenden(v, {
        modus: m.modus, anwendung: m.anwendung, objekt: m.objekt, an: m.an, cc: m.cc, bcc: m.bcc, betreff: m.betreff, text: m.text,
        html: m.html, antwort_an: m.antwort_an || undefined, benutzer: wer,
        // Absender wie beim ersten Versuch; hatte der keinen persönlichen, auch jetzt nicht den des Wiederholenden
        ...(m.absender ? { absender: m.absender, absender_name: m.absender_name ?? '' } : { persoenlich: false }),
        anhaenge: m.anhaenge.map((a) => ({ ...a, inhalt: Buffer.from(a.inhalt, 'base64') })),
        folge: n.folge ?? undefined,
      });
      if (r.status === 'fehler') throw new Error(r.fehler ?? 'n8n meldet einen Fehler');
      status = r.status;
      if (n.folge && r.status === 'gesendet') warnungen.push(...await folgeNachziehen(tx, n.folge));
      text = r.status === 'entwurf' ? `Entwurf an ${m.an} im Postfach abgelegt.` : `E-Mail an ${m.an} erneut gesendet${r.von ? ` (Absender ${r.von})` : ''}.`;
    }
  } catch (e) {
    // fehlgeschlagene Wiederholung festhalten (eigene Verbindung – die Transaktion wird zurückgerollt)
    await DB`update tco.mail_protokoll set erneut_am = now(), erneut_von = ${wer}, erneut_status = 'fehler' where id = ${id}`.catch(() => undefined);
    throw e;
  }
  // gespeicherten Inhalt nach Erfolg löschen (Datenschutz); neue Mail steht als eigener Eintrag im Protokoll
  await tx`update tco.mail_protokoll set erneut_am = now(), erneut_von = ${wer}, erneut_status = ${status}, nachricht = null where id = ${id}`;
  return { text, warnungen };
}
