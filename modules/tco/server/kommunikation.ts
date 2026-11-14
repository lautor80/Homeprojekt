import type { Db, Verein } from './verein.js';
import { condense } from './format.js';

/**
 * Port von ZCL_TCO_KOMMUNIKATION: Kontaktdaten je Adressnummer, Mobilnummer,
 * WhatsApp-Link, bevorzugter Versandweg und E-Mail-Versand über n8n.
 */

export interface Kontakt {
  adrnr: string;
  anrede: string;
  vorname: string;
  nachname: string;
  strasse: string;
  plz: string;
  ort: string;
  email: string;
  telefon: string;
  /** internationale Ziffernfolge ohne + (z. B. 491711234567) */
  mobil: string;
  geschlecht: string;
}

/**
 * Telefonnummer → internationale Ziffernfolge (0171-1234567 → 491711234567).
 * Deutsche Nummern nur als Mobilfunk (015x/016x/017x), ausländische nur mit + oder 00.
 */
export function mobilnummer(tel: string | null | undefined): string {
  const raw = (tel ?? '').replace(/[^0-9+]/g, '');
  if (raw.length < 6) return '';
  let nr: string;
  let int = false;
  if (raw.startsWith('+')) { nr = raw.slice(1); int = true; }
  else if (raw.startsWith('00')) { nr = raw.slice(2); int = true; }
  else if (raw.startsWith('0')) nr = `49${raw.slice(1)}`;
  else if (raw.startsWith('49') && raw.length >= 12 && raw.length <= 13) nr = raw;
  else return '';
  nr = nr.replace(/\+/g, '');
  if (!/^\d+$/.test(nr)) return '';
  if (nr.length > 3 && nr.startsWith('490')) nr = `49${nr.slice(3)}`;
  if (nr.startsWith('49')) {
    return nr.length >= 12 && nr.length <= 13 && ['15', '16', '17'].includes(nr.slice(2, 4)) ? nr : '';
  }
  return int && nr.length >= 8 && nr.length <= 15 ? nr : '';
}

export const whatsappLink = (nr: string, text: string) => `https://wa.me/${nr}?text=${encodeURIComponent(text)}`;

/** ZUID aus Adressnummer 99xxxxxxxx */
export const zuidAusAdrnr = (adrnr: string) => String(Number(adrnr.slice(2)));
export const adrnrAusZuid = (zuid: string) => `99${String(Number(zuid)).padStart(8, '0')}`;

export async function kontaktLesen(db: Db, adrnr: string | null | undefined): Promise<Kontakt | null> {
  if (!adrnr) return null;
  const k: Kontakt = { adrnr, anrede: '', vorname: '', nachname: '', strasse: '', plz: '', ort: '', email: '', telefon: '', mobil: '', geschlecht: '' };
  if (adrnr.startsWith('99')) {
    const [c] = await db`select * from tco.kunden where zuid = ${zuidAusAdrnr(adrnr)} order by zalias limit 1`;
    if (!c) return null;
    Object.assign(k, {
      vorname: c.vorname ?? '', nachname: c.nachname ?? '', strasse: c.strasse ?? '', plz: c.plz ?? '', ort: c.wohnort ?? '',
      email: (c.email ?? '').trim(), telefon: (c.telefonnummer ?? '').trim(), geschlecht: c.geschlecht ?? '',
    });
  } else {
    const [m] = await db`select * from tco.mitglieder where adrnr = ${adrnr}`;
    if (!m) return null;
    Object.assign(k, {
      anrede: m.anrede ?? '', vorname: m.vorname ?? '', nachname: m.nachname ?? '', strasse: m.strasse ?? '', plz: m.plz ?? '',
      ort: m.ort ?? '', email: (m.email ?? '').trim(), telefon: (m.telefon ?? '').trim(), geschlecht: m.geschlecht ?? '',
    });
    k.mobil = mobilnummer(m.telefon6);
    if (!k.telefon && k.mobil) k.telefon = (m.telefon6 ?? '').trim();
    // fehlende E-Mail/Mobilnummer aus dem EP3-Kundenstamm (gleicher Name) ergänzen
    if (!k.email || !k.mobil) {
      const name = condense(`${k.vorname} ${k.nachname}`).toUpperCase();
      const kd = await db`select email, telefonnummer from tco.kunden
                           where coalesce(status, '') not in ('blocked', 'deleted')
                             and upper(trim(coalesce(vorname, '') || ' ' || coalesce(nachname, ''))) = ${name}
                           order by length(zuid) desc, zuid desc`;
      for (const c of kd) {
        if (!k.email && c.email) k.email = c.email.trim();
        if (!k.mobil && mobilnummer(c.telefonnummer)) {
          k.mobil = mobilnummer(c.telefonnummer);
          if (!k.telefon) k.telefon = c.telefonnummer.trim();
        }
        if (k.email && k.mobil) break;
      }
    }
  }
  if (!k.mobil) k.mobil = mobilnummer(k.telefon);
  return k;
}

/** gespeicherter Versandweg, sofern verfügbar; sonst E-Mail vor WhatsApp */
export async function kanalLesen(db: Db, k: Kontakt | null): Promise<'E' | 'W' | ''> {
  if (!k) return '';
  const [p] = await db`select kanal from tco.kommpref where adrnr = ${k.adrnr}`;
  if (p?.kanal === 'E' && k.email) return 'E';
  if (p?.kanal === 'W' && k.mobil) return 'W';
  return k.email ? 'E' : k.mobil ? 'W' : '';
}

// ---------------------------------------------------------------------------
// E-Mail-Versand: zentral im Kern (server/src/lib/mail.ts, Anbindung „mail“ unter Administration → Schnittstellen → Anbindungen).
// Hier bleiben nur die bisherigen Einstiege mit dem Verein als erstem Parameter, damit die Aufrufer unverändert bleiben.
// ---------------------------------------------------------------------------
import {
  absenderFuer as absenderAus, mailProtokoll, mailSenden as kernMailSenden, webhookFehler,
  type MailAbsender, type MailAnhang, type MailAuftrag, type MailErgebnis, type MailFolge, type Wiederholung,
} from '../../../server/src/lib/mail.js';
import { N8N_PLATZHALTER, N8N_PLATZHALTER_TEXT } from '../../../server/src/lib/verbindungen.js';

export { mailProtokoll, webhookFehler, N8N_PLATZHALTER, N8N_PLATZHALTER_TEXT };
export type { MailAbsender, MailAnhang, MailErgebnis, MailFolge, Wiederholung };

/** Absender für eine Anwendung (Verein.mail_absender kommt aus der zentralen Anbindung); null = Standard des n8n-Workflows */
export function absenderFuer(v: Pick<Verein, 'mail_absender'>, anwendung: string): MailAbsender | null {
  return absenderAus(Array.isArray(v.mail_absender) ? v.mail_absender : [], anwendung);
}

/** E-Mail über den n8n-Workflow „TCO Mailversand“ – Absendername „Anzeigename | Vereinsname“ */
export function mailSenden(v: Pick<Verein, 'name'>, m: Omit<MailAuftrag, 'organisation'>): Promise<MailErgebnis & { protokoll?: number | null }> {
  return kernMailSenden({ ...m, organisation: v.name });
}
