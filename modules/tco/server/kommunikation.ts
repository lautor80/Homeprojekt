import { aktuellerBenutzer } from '../../../server/src/kontext.js';
import type { Db, Verein } from './verein.js';
import { condense } from './format.js';
import { BusinessError } from '../../../server/src/errors.js';

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

export interface MailErgebnis { status: 'gesendet' | 'entwurf' | 'fehler'; message_id?: string; zeitpunkt?: string; fehler?: string; von?: string; hinweis?: string }

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
/**
 * n8n zeigt gespeicherte Geheimnisse in Zugangsdaten nie an, sondern den Platzhalter „__n8n_BLANK_VALUE_…“.
 * Wer ihn kopiert, trägt im Portal nicht den Schlüssel, sondern den Platzhalter ein – n8n lehnt dann jeden Aufruf ab.
 */
export const N8N_PLATZHALTER = /^__n8n_BLANK_VALUE_/;
export const N8N_PLATZHALTER_TEXT = 'Das ist nicht der Schlüssel, sondern der Platzhalter, den n8n statt gespeicherter Geheimnisse anzeigt '
  + '(„__n8n_BLANK_VALUE_…“). Bitte in n8n im Credential „Header Auth account“ einen neuen Wert eintragen und genau diesen Wert hier hinterlegen.';

/** Klartext für eine Ablehnung des Mail-Webhooks durch n8n (Header-Auth: fehlender und falscher Schlüssel ergeben beide 403) */
export function webhookFehler(status: number, text: string, mitSchluessel: boolean): string | null {
  if (/No authentication data defined/i.test(text)) {
    return 'Im n8n-Workflow ist am Webhook-Knoten keine Zugangsdatei ausgewählt (nach dem Import „Header Auth account“ neu wählen und speichern).';
  }
  if (status === 401 || status === 403) {
    return mitSchluessel
      ? 'n8n hat den Webhook-Schlüssel abgelehnt: Im n8n-Credential „Header Auth account“ muss der Name „X-TCO-Key“ lauten und der Wert '
        + 'exakt dem Webhook-Schlüssel im Portal entsprechen (Groß-/Kleinschreibung, keine Leerzeichen).'
      : 'n8n verlangt einen Webhook-Schlüssel – im Portal ist keiner hinterlegt (Stammdaten → Anbindungen → TCO Mailversand).';
  }
  if (status === 404) return 'n8n-Workflow "TCO Mailversand" ist nicht aktiv oder die URL stimmt nicht (Webhook 404)';
  return null;
}

/**
 * Wie eine fehlgeschlagene Mail erneut gesendet wird (Mailprotokoll → „Erneut senden“):
 * ohne Angabe wird die Nachricht samt Anhängen gespeichert und unverändert wiederholt.
 * Mails mit Zugangslinks oder Kennwörtern werden nie gespeichert: sie werden neu erzeugt (neuer Link) oder müssen neu ausgelöst werden.
 */
export type Wiederholung =
  | { art: 'REG_BESTAETIGUNG'; id: number }
  | { art: 'EINLADUNG'; adrnr: string; stunden: number; weg: 'MAIL' | 'REGISTRIERUNG' }
  | { art: 'NEU_AUSLOESEN'; hinweis: string };
/** Was nach erfolgreicher Wiederholung nachgezogen wird (wie beim ersten Versand) */
export type MailFolge = { art: 'HALLENRECHNUNG'; rgnrs: string[] } | { art: 'VERZEHR'; rgnr: string; an: string };

/** Versuch protokollieren (eigene Verbindung, damit der Eintrag auch bei zurückgerollter Transaktion bleibt); Fehler hier nie weiterreichen */
export async function mailProtokoll(e: { anwendung: string; objekt: string; an: string; betreff: string; absender?: string | null; von?: string | null;
  status: string; fehler?: string | null; benutzer?: string | null; nachricht?: unknown }): Promise<number | null> {
  try {
    const { DB } = await import('./verein.js');
    const [r] = await DB`insert into tco.mail_protokoll (anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer, nachricht)
             values (${e.anwendung}, ${e.objekt}, ${e.an}, ${e.betreff}, ${e.absender ?? null}, ${e.von ?? null}, ${e.status},
                     ${e.fehler ? String(e.fehler).slice(0, 1000) : null}, ${e.benutzer ?? null},
                     ${e.nachricht ? DB.json(e.nachricht as never) : null}) returning id`;
    await DB`delete from tco.mail_protokoll where zeit < now() - interval '180 days'`;
    // gespeicherte Inhalte (Datenschutz) nur 30 Tage
    await DB`update tco.mail_protokoll set nachricht = null where nachricht is not null and zeit < now() - interval '30 days'`;
    return Number(r.id);
  } catch { return null; /* Protokoll ist nur Diagnose */ }
}

type MailDaten = Parameters<typeof mailSenden>[1];

/** Was zum erneuten Senden gespeichert wird (nur bei Fehlern) */
function wiederholDaten(m: MailDaten): unknown {
  if (m.wiederholung) return { wiederholung: m.wiederholung };
  const ich = m.persoenlich === false || m.absender ? null : aktuellerBenutzer();
  return {
    folge: m.folge ?? null,
    mail: {
      modus: m.modus, anwendung: m.anwendung, objekt: m.objekt, an: m.an, cc: m.cc ?? '', bcc: m.bcc ?? '', betreff: m.betreff, text: m.text,
      html: !!m.html, antwort_an: m.antwort_an ?? '',
      // Absender wie beim ersten Versuch (wer gesendet hat), nicht wer wiederholt
      absender: m.absender ?? ich?.email ?? null, absender_name: m.absender ? m.absender_name ?? '' : ich?.email ? ich.displayName : null,
      persoenlich: m.persoenlich ?? null,
      anhaenge: m.anhaenge.map((a) => ({ ...a, inhalt: a.inhalt.toString('base64') })),
    },
  };
}

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
  /** fester Absender (sonst: angemeldeter Benutzer, Ersatz je Anwendung aus den Stammdaten) */
  absender?: string; absender_name?: string; antwort_an?: string;
  /** false = nie mit der Adresse des angemeldeten Benutzers senden (z. B. Systemmails) */
  persoenlich?: boolean;
  /** Erneut senden aus dem Mailprotokoll: Pflicht für Mails mit Zugangslinks/Kennwörtern (siehe Wiederholung) */
  wiederholung?: Wiederholung;
  folge?: MailFolge;
}): Promise<MailErgebnis & { protokoll?: number | null }> {
  const proto = { anwendung: m.anwendung, objekt: m.objekt, an: m.an, betreff: m.betreff, benutzer: m.benutzer };
  if (!v.n8n_mail_url) {
    await mailProtokoll({ ...proto, status: 'nicht_gesendet', fehler: 'n8n-Mailversand nicht eingerichtet (Webhook-URL fehlt)', nachricht: wiederholDaten(m) });
    throw new BusinessError('Der n8n-Mailversand ist nicht eingerichtet (Stammdaten → Anbindungen).');
  }
  try {
    const r = await mailSendenIntern(v as Verein & { n8n_mail_url: string }, m);
    const protokoll = await mailProtokoll({ ...proto, absender: r.absender, von: r.von ?? null, status: r.status, fehler: r.fehler ?? (r.hinweis || null),
      nachricht: r.status === 'fehler' ? wiederholDaten(m) : null });
    return { ...r, protokoll };
  } catch (e) {
    await mailProtokoll({ ...proto, status: 'fehler', fehler: (e as Error).message, nachricht: wiederholDaten(m) });
    throw e;
  }
}

async function mailSendenIntern(v: Verein & { n8n_mail_url: string }, m: Parameters<typeof mailSenden>[1]): Promise<MailErgebnis & { absender?: string; hinweis?: string }> {
  const groesse = m.anhaenge.reduce((s, a) => s + a.inhalt.length, 0);
  if (groesse > 10 * 1024 * 1024) throw new BusinessError(`Anhänge zu groß (${(groesse / 1024 / 1024).toFixed(1)} MB, höchstens 10 MB)`);
  // Absender: wer auf „Senden“ drückt (angemeldeter Benutzer mit E-Mail). Darf dessen Adresse in n8n nicht senden
  // (KONTEN), nimmt n8n den Ersatz je Anwendung aus den Stammdaten bzw. seinen Standard und setzt die Antwortadresse auf den Benutzer.
  const ich = m.persoenlich === false || m.absender ? null : aktuellerBenutzer();
  const ersatz = absenderFuer(v, m.anwendung);
  const abs = m.absender ? { email: m.absender, name: m.absender_name ?? '' }
    : ich?.email ? { email: ich.email, name: `${ich.displayName} | ${v.name}` } : ersatz ? { email: ersatz.email, name: ersatz.name ?? '' } : null;
  const body = {
    modus: m.modus, anwendung: m.anwendung, objekt: m.objekt, an: m.an, cc: m.cc ?? '', bcc: m.bcc ?? '', betreff: m.betreff,
    text: m.text, text_format: m.html ? 'html' : 'text', benutzer: m.benutzer, quelle: 'Portal',
    ...(abs ? { absender: abs.email, absender_name: abs.name || '' } : {}),
    ...(ersatz && abs?.email !== ersatz.email ? { absender_ersatz: ersatz.email, absender_ersatz_name: ersatz.name ?? '' } : {}),
    // feste Antwortadresse der Stammdaten nur, wenn nicht persönlich gesendet wird (sonst antwortet man dem Absender)
    antwort_an: m.antwort_an || (ich?.email ? '' : ersatz?.antwort_an) || '',
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
    throw new BusinessError(`n8n nicht erreichbar: ${(e as Error).message}`, 502);
  }
  const t = await res.text();
  if ((res.status === 401 || res.status === 403) && N8N_PLATZHALTER.test(v.n8n_mail_key ?? '')) throw new BusinessError(N8N_PLATZHALTER_TEXT, 502);
  const ablehnung = webhookFehler(res.status, t, !!v.n8n_mail_key);
  if (ablehnung) throw new BusinessError(ablehnung, 502);
  let r: MailErgebnis;
  try {
    r = JSON.parse(t);
  } catch {
    throw new BusinessError(`Unerwartete Antwort von n8n (HTTP ${res.status}): ${t.replace(/\s+/g, ' ').slice(0, 150)}`, 502);
  }
  if (!res.ok && !r.status) throw new BusinessError(`Unerwartete Antwort von n8n (HTTP ${res.status})`, 502);
  return { ...r, absender: abs?.email };
}
