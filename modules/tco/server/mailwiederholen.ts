/**
 * Mailprotokoll → „Erneut senden“ (zentral in server/src/lib/mail.ts): Beiträge des Vereinsmoduls.
 *
 * - Mails mit Zugangslinks werden nie gespeichert; hier wird ein neuer Link erzeugt (Registrierung, Einladung), ältere werden ungültig.
 * - Nach erfolgreicher Wiederholung einer normalen Mail wird nachgezogen, was der erste Versand getan hätte
 *   (Hallenrechnung „versendet“, Verzehrbeleg „per Mail versendet“).
 */
import { BusinessError } from '../../../server/src/errors.js';
import type { Tx } from '../../../server/src/db.js';
import type { MailFolge, Wiederholung } from '../../../server/src/lib/mail.js';
import { vereinLesen } from './verein.js';
import { statusSetzen } from './halle/daten.js';
import { bestaetigungErneut } from './platz/routes.js';
import { einladungErneut } from './mitglieder/einladung.js';

export async function mailWiederholen(tx: Tx, w: Wiederholung, wer: string): Promise<string | null> {
  if (w.art === 'REG_BESTAETIGUNG') return bestaetigungErneut(tx, await vereinLesen(tx), Number(w.id));
  if (w.art === 'EINLADUNG') {
    return einladungErneut(tx, await vereinLesen(tx), { adrnr: String(w.adrnr), stunden: Number(w.stunden), weg: w.weg === 'MAIL' ? 'MAIL' : 'REGISTRIERUNG' }, wer);
  }
  return null;
}

export async function mailFolge(tx: Tx, f: MailFolge): Promise<string[] | null> {
  if (f.art === 'HALLENRECHNUNG') {
    const warn: string[] = [];
    for (const rgnr of (f.rgnrs as string[] | undefined) ?? []) {
      try { await statusSetzen(tx, rgnr, 'versendet'); } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        warn.push(`${rgnr}: ${e.message}`);
      }
    }
    return warn;
  }
  if (f.art === 'VERZEHR') {
    await tx`update tco.vz_belege set versand_am = now(), versand_art = 'MAIL', email = coalesce(email, ${String(f.an)}) where rgnr = ${String(f.rgnr)}`;
    return [];
  }
  return null;
}
