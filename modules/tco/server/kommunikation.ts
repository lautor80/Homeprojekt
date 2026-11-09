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

export interface MailAnhang {
  dateiname: string;
  inhalt: Buffer;
  mime?: string;
  paperless_root_id?: number | null;
  paperless_version_id?: number | null;
  objekt?: string;
}

export interface MailErgebnis { status: 'gesendet' | 'entwurf' | 'fehler'; message_id?: string; zeitpunkt?: string; fehler?: string }

export interface MailAbsender { anwendung: string; email: string; name?: string | null; antwort_an?: string | null }

/** Absender für eine Anwendung aus den Stammdaten (gleiche Anwendung, sonst „*“); null = Standard des n8n-Workflows */
export function absenderFuer(v: Pick<Verein, 'mail_absender'>, anwendung: string): MailAbsender | null {
  const l = Array.isArray(v.mail_absender) ? v.mail_absender : [];
  const a = anwendung.trim().toLowerCase();
  return l.find((x) => x.email && x.anwendung.trim().toLowerCase() === a) ?? l.find((x) => x.email && x.anwendung.trim() === '*') ?? null;
}

/**
 * E-Mail über den generischen n8n-Workflow „TCO Mailversand“ (Webhook tco-mailversand, docs/n8n/tco-mailversand.json).
 * Beliebig viele Anhänge; Absender/Antwortadresse je Anwendung aus den Stammdaten (n8n prüft gegen seine Erlaubnisliste).
 */
export async function mailSenden(v: Verein, m: {
  modus: 'senden' | 'entwurf';
  anwendung: string;
  objekt: string;
  an: string;
  cc?: string;
  bcc?: string;
  betreff: string;
  text: string;
  /** HTML statt Text */
  html?: boolean;
  benutzer: string;
  anhaenge: MailAnhang[];
  /** abweichender Absender (sonst je Anwendung aus den Stammdaten) */
  absender?: string; absender_name?: string; antwort_an?: string;
}): Promise<MailErgebnis> {
  if (!v.n8n_mail_url) throw new Error('Der n8n-Mailversand ist nicht eingerichtet (Stammdaten → Anbindungen).');
  const groesse = m.anhaenge.reduce((s, a) => s + a.inhalt.length, 0);
  if (groesse > 10 * 1024 * 1024) throw new Error(`Anhänge zu groß (${(groesse / 1024 / 1024).toFixed(1)} MB, höchstens 10 MB)`);
  const abs = m.absender ? { email: m.absender, name: m.absender_name ?? '', antwort_an: m.antwort_an ?? '' } : absenderFuer(v, m.anwendung);
  const body = {
    modus: m.modus, anwendung: m.anwendung, objekt: m.objekt, an: m.an, cc: m.cc ?? '', bcc: m.bcc ?? '', betreff: m.betreff,
    text: m.text, text_format: m.html ? 'html' : 'text', benutzer: m.benutzer, quelle: 'Portal',
    ...(abs ? { absender: abs.email, absender_name: abs.name || '' } : {}),
    antwort_an: m.antwort_an || abs?.antwort_an || '',
    anhaenge: m.anhaenge.map((a) => ({
      dateiname: a.dateiname, mime: a.mime ?? 'application/pdf', inhalt_base64: a.inhalt.toString('base64'),
      paperless_root_id: a.paperless_root_id ?? null, paperless_version_id: a.paperless_version_id ?? null, objekt: a.objekt ?? m.objekt,
    })),
  };
  let res: Response;
  try {
    res = await fetch(v.n8n_mail_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(v.n8n_mail_key ? { 'X-TCO-Key': v.n8n_mail_key } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw new Error(`n8n nicht erreichbar: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('n8n hat den Webhook-Schlüssel abgelehnt');
  if (res.status === 404) throw new Error('n8n-Workflow "TCO Mailversand" ist nicht aktiv (Webhook 404)');
  const t = await res.text();
  let r: MailErgebnis;
  try {
    r = JSON.parse(t);
  } catch {
    throw new Error(`Unerwartete Antwort von n8n (HTTP ${res.status})`);
  }
  if (!res.ok && !r.status) throw new Error(`Unerwartete Antwort von n8n (HTTP ${res.status})`);
  return r;
}
