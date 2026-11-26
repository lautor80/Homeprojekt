import { api } from '@core/api';
import { T } from '../util';
import { EING, antwortText } from '../eingang/typen';
import { eingangInOrdner } from '../eingang/uebernahme';
import { auftragAblegen } from '../auftragAblage';
import { ordnerMoeglich, ordnerStatus } from '../ordner';
import type { BelegProfil, BelegVorschlag } from './typen';
import type { BelegQuelle } from './vormerkung';

/**
 * Auftrag aus Beleg: Aufrufe des Servers (docs/euroflex-belegerfassung.md) und das Anhängen des Belegs an den neuen Auftrag.
 *  - POST /auftraege/beleg/erkennen { name, inhalt }   Recht transport.belegerfassung:create, Funktion transport.beleg.erfassung
 *  - POST /eingang/dokumente/:id/beleg                 Recht transport.belegeingang:create,   Funktion transport.beleg.eingang
 *  - GET /beleg/profile, PUT /beleg/profile/:layout    Recht transport.leseprofile:edit,      Funktion transport.beleg.profile
 */
export const R_BELEG = 'transport.belegerfassung:create';
export const F_BELEG = 'transport.beleg.erfassung';
export const R_BELEG_EINGANG = 'transport.belegeingang:create';
export const F_BELEG_EINGANG = 'transport.beleg.eingang';
export const R_LESEPROFILE = 'transport.leseprofile:edit';
export const F_LESEPROFILE = 'transport.beleg.profile';

/** Dateiauswahl der Ablagezone */
export const BELEG_ACCEPT = '.pdf,.png,.jpg,.jpeg';
export const KEIN_FRACHTAUFTRAG = 'Der Beleg sieht nicht nach einem Frachtauftrag aus – nichts übernommen.';

/** PDF, PNG oder JPG? (nach Endung, sonst nach Typ) */
export const istBelegDatei = (f: { name: string; type?: string | null }) =>
  /\.(pdf|png|jpe?g)$/i.test(f.name) || ['application/pdf', 'image/png', 'image/jpeg'].includes((f.type ?? '').toLowerCase());

const lesen = (f: File) => new Promise<string>((ok, err) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => err(r.error ?? new Error('Die Datei ließ sich nicht lesen.'));
  r.readAsDataURL(f);
});

/** hochgeladene Datei lesen lassen (nichts wird gespeichert) */
export async function belegErkennen(datei: File): Promise<BelegVorschlag> {
  if (!istBelegDatei(datei)) throw new Error(`„${datei.name}“ ist kein PDF und kein Bild (PNG, JPG).`);
  return api.post<BelegVorschlag>(`${T}/auftraege/beleg/erkennen`, { name: datei.name, inhalt: await lesen(datei) });
}

/** Anhang einer E-Mail aus dem Posteingang lesen lassen (die E-Mail bleibt unverändert) */
export const belegAusEingang = (dokument: number) => api.post<BelegVorschlag>(`${T}/eingang/dokumente/${dokument}/beleg`);

export const profileLaden = () => api.get<BelegProfil[]>(`${T}/beleg/profile`);
export const profilSpeichern = (p: BelegProfil) =>
  api.put<unknown>(`${T}/beleg/profile/${encodeURIComponent(p.layout)}`, { bezeichnung: p.bezeichnung.trim(), aktiv: p.aktiv, kunde: p.kunde });

export interface AnhangErgebnis { ok: boolean; text: string }

/**
 * Beleg nach dem Speichern an den neuen Auftrag hängen – über die vorhandenen Wege:
 *  - hochgeladene Datei: wie das Ablagefeld „Dokumente“ des Auftrags (auftragAblage.ts: Paperless mit Feld „Auftrag“ und/oder Ablageordner)
 *  - Anhang aus dem Posteingang: die E-Mail wird dem Auftrag zugeordnet wie mit „Ablage bestätigen“ (POST /eingang/vorgaenge/:id/ablegen);
 *    mit Ablageziel „lokal“ kommen die Dateien gleich in den Ablageordner (eingang/uebernahme.ts)
 * Wirft nie: Der Auftrag ist schon gespeichert – ein Fehler kommt als Text zurück.
 */
export async function belegAnhaengen(nr: string, q: BelegQuelle, o: { eingangUebertragen: boolean }): Promise<AnhangErgebnis> {
  try {
    if (q.eingang) {
      const r = await api.post<unknown>(`${EING}/vorgaenge/${q.eingang.vorgang}/ablegen`, { auftragsnr: nr });
      let text = antwortText(r, `E-Mail dem Auftrag ${nr} zugeordnet`);
      if (o.eingangUebertragen && ordnerMoeglich) {
        try {
          const e = await eingangInOrdner(nr, null, {});
          if (e.uebernommen) text += ` · ${e.uebernommen} Datei(en) in den Ablageordner übernommen`;
          if (e.fehler.length) text += ` · Dateien warten noch auf die Übernahme in den Ablageordner (${e.fehler.join('; ')})`;
        } catch (x) { text += ` · Dateien warten noch auf die Übernahme in den Ablageordner (${(x as Error).message})`; }
      }
      return { ok: true, text };
    }
    if (!q.datei) return { ok: true, text: '' };
    const [d, ordner] = await Promise.all([api.get<{ paperless: boolean }>(`${T}/auftraege/${nr}/dokumente`), ordnerStatus().catch(() => null)]);
    // ein Ablageordner ohne erteilten Zugriff ist kein Ziel – sonst gälte „0 Dateien abgelegt“ als Erfolg
    const ordnerBereit = !!ordner?.zugriff;
    if (!d.paperless && !ordnerBereit) {
      return { ok: false, text: ordner ? `Paperless ist nicht eingerichtet und der Zugriff auf den Ablageordner „${ordner.name}“ ist nicht erteilt.` : 'Weder Paperless noch ein Ablageordner ist eingerichtet.' };
    }
    const r = await auftragAblegen(nr, [q.datei], { paperless: d.paperless, ordner: ordnerBereit });
    return { ok: true, text: r.text };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}
