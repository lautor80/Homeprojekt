import { BusinessError } from '../../../server/src/errors.js';
import { aktuellerBenutzer } from '../../../server/src/kontext.js';
import { mailProtokoll } from '../../../server/src/lib/mail.js';
import {
  authHeader, eingerichtet, N8N_PLATZHALTER, N8N_PLATZHALTER_TEXT, verbindungLesen, type Verbindung, type VerbindungDef,
} from '../../../server/src/lib/verbindungen.js';

/**
 * E-Mail-Versand von Euroflex über Outlook 365 (#235): n8n-Workflow „Euroflex Mailversand“ (docs/n8n/euroflex-mailversand.json).
 *
 * Ein Aufruf ist ein Vorgang zu einem Auftrag: ein gemeinsamer Anhang-Vorrat und eine Liste von E-Mails. Zum Auftrag geht die
 * E-Mail an den Kunden und parallel – als eigene E-Mail mit gleichem Inhalt und gleichen Anhängen – an die feste zweite Adresse
 * aus der Anbindung. Gesendet wird aus dem Outlook-365-Postfach des angemeldeten Benutzers; die Anmeldung an Microsoft 365
 * liegt ausschließlich in n8n. Gilt nur für Euroflex – der Verein sendet weiter über „TCO Mailversand“ (server/src/lib/mail.ts).
 */

export const V_MAIL = 'transport.mail';
export const ANWENDUNG = 'Euroflex';
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const MAX_MB_STANDARD = 10;
const MAX_MB_GRENZE = 25;

export type Rolle = 'kunde' | 'kopie';

export interface MailEinstellungen {
  /** feste zweite Adresse: erhält jede E-Mail parallel als eigene E-Mail (leer = keine zweite E-Mail) */
  kopie_an: string;
  /** Benutzername (klein) → Outlook-365-Postfach */
  postfaecher: Map<string, string>;
  /** Höchstgröße aller Anhänge eines Vorgangs in MB */
  max_mb: number;
}

/** „benutzer=adresse, benutzer2=adresse2“ → Zuordnung; wirft bei ungültigen Einträgen */
export function postfaecherLesen(roh: unknown): Map<string, string> {
  const m = new Map<string, string>();
  for (const teil of String(roh ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)) {
    const i = teil.indexOf('=');
    const benutzer = (i < 0 ? '' : teil.slice(0, i)).trim().toLowerCase();
    const adresse = (i < 0 ? '' : teil.slice(i + 1)).trim();
    if (!benutzer || !EMAIL.test(adresse)) throw new BusinessError(`Postfach je Benutzer: „${teil}“ ist ungültig – erwartet wird benutzername=adresse.`);
    if (m.has(benutzer)) throw new BusinessError(`Postfach je Benutzer: „${benutzer}“ ist doppelt.`);
    m.set(benutzer, adresse);
  }
  return m;
}

export function einstellungenLesen(v: Pick<Verbindung, 'einstellungen'>): MailEinstellungen {
  const e = v.einstellungen ?? {};
  const max = Number(e.max_mb);
  let postfaecher = new Map<string, string>();
  try { postfaecher = postfaecherLesen(e.postfaecher); } catch { /* gespeicherte Werte sind geprüft; sonst ohne Zuordnung */ }
  return {
    kopie_an: String(e.kopie_an ?? '').trim(),
    postfaecher,
    max_mb: Number.isFinite(max) && max >= 1 ? Math.min(max, MAX_MB_GRENZE) : MAX_MB_STANDARD,
  };
}

/** Postfach, aus dem dieser Benutzer sendet: Zuordnung in der Anbindung, sonst die E-Mail-Adresse des Benutzers */
export function postfachFuer(e: MailEinstellungen, benutzer: { username: string; email: string | null } | null): string | null {
  if (!benutzer) return null;
  const zugeordnet = e.postfaecher.get(benutzer.username.trim().toLowerCase());
  if (zugeordnet) return zugeordnet;
  const eigene = (benutzer.email ?? '').trim();
  return EMAIL.test(eigene) ? eigene : null;
}

/** Klartext für eine Ablehnung des Webhooks durch n8n (Header-Auth: fehlender und falscher Schlüssel ergeben beide 403) */
function webhookFehler(status: number, text: string, mitSchluessel: boolean): string | null {
  if (/No authentication data defined/i.test(text)) {
    return 'Im n8n-Workflow „Euroflex Mailversand“ ist am Webhook-Knoten keine Zugangsdatei ausgewählt (nach dem Import „Header Auth“ wählen und speichern).';
  }
  if (status === 401 || status === 403) {
    return mitSchluessel
      ? 'n8n hat den Webhook-Schlüssel abgelehnt: In der n8n-Zugangsdatei am Webhook-Knoten muss der Name „X-Euroflex-Key“ lauten und der Wert exakt dem Webhook-Schlüssel im Portal entsprechen.'
      : 'n8n verlangt einen Webhook-Schlüssel – im Portal ist keiner hinterlegt (Administration → Anbindungen → Euroflex E-Mail-Versand).';
  }
  if (status === 404) return 'Der n8n-Workflow „Euroflex Mailversand“ ist nicht aktiv oder die URL stimmt nicht (Production-URL, nicht /webhook-test/).';
  return null;
}

async function aufrufen(v: Verbindung, body: unknown, timeout: number): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetch(v.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(v) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new BusinessError(`n8n nicht erreichbar: ${(e as Error).message}`, 502);
  }
  const text = await res.text();
  const mitSchluessel = !!(v.auth_art === 'header' && v.geheimnis);
  if ((res.status === 401 || res.status === 403) && N8N_PLATZHALTER.test(v.geheimnis ?? '')) throw new BusinessError(N8N_PLATZHALTER_TEXT, 502);
  const ablehnung = webhookFehler(res.status, text, mitSchluessel);
  if (ablehnung) throw new BusinessError(ablehnung, 502);
  let json: Record<string, unknown> | null = null;
  try { const j = JSON.parse(text); if (j && typeof j === 'object' && !Array.isArray(j)) json = j; } catch { /* keine JSON-Antwort */ }
  return { status: res.status, text, json };
}

/** Anbindung „Euroflex E-Mail-Versand“ (Administration → Anbindungen) */
export const TRANSPORT_VERBINDUNGEN: VerbindungDef[] = [{
  id: V_MAIL, text: 'Euroflex E-Mail-Versand (Outlook 365, n8n)',
  beschreibung: 'n8n-Workflow „Euroflex Mailversand“: E-Mails zum Auftrag mit ausgewählten Anhängen über Outlook 365, aus dem Postfach des angemeldeten Benutzers. '
    + 'Jede E-Mail geht parallel als eigene E-Mail an die feste zweite Adresse. Der Webhook-Schlüssel muss dem Wert der n8n-Zugangsdatei am Webhook-Knoten (Name X-Euroflex-Key) entsprechen. '
    + 'Der Test prüft Erreichbarkeit, Workflow, Schlüssel und das Postfach Ihres Benutzers, ohne eine E-Mail zu senden. Einrichtung: docs/n8n/EUROFLEX-MAILVERSAND.md.',
  auth: ['header', 'keine'],
  header_name: 'X-Euroflex-Key',
  felder: { url: 'Webhook-URL (z. B. http://n8n:5678/webhook/euroflex-mailversand)', geheimnis: 'Webhook-Schlüssel', header_name: 'Header-Name' },
  zusatz: [
    { key: 'kopie_an', text: 'Feste zweite Adresse (erhält jede E-Mail parallel als eigene E-Mail)', platzhalter: 'ablage@example.org' },
    { key: 'postfaecher', text: 'Postfach je Benutzer: benutzername=adresse, mehrere durch Komma (ohne Eintrag gilt die E-Mail-Adresse des Benutzers)', platzhalter: 'mmuster=m.muster@example.org, bbeispiel=b.beispiel@example.org' },
    { key: 'max_mb', text: `Höchstgröße der Anhänge je Vorgang in MB (Standard ${MAX_MB_STANDARD}, höchstens ${MAX_MB_GRENZE})`, platzhalter: String(MAX_MB_STANDARD) },
  ],
  einstellungen: (e) => {
    const kopie_an = String(e.kopie_an ?? '').trim();
    if (kopie_an && !EMAIL.test(kopie_an)) throw new BusinessError(`Feste zweite Adresse: „${kopie_an}“ ist keine gültige E-Mail-Adresse (genau eine Adresse).`);
    const postfaecher = [...postfaecherLesen(e.postfaecher)].map(([b, a]) => `${b}=${a}`).join(', ');
    const roh = String(e.max_mb ?? '').trim().replace(',', '.');
    let max_mb: number | '' = '';
    if (roh) {
      const n = Number(roh);
      if (!Number.isFinite(n) || n < 1 || n > MAX_MB_GRENZE) throw new BusinessError(`Höchstgröße der Anhänge: bitte eine Zahl von 1 bis ${MAX_MB_GRENZE} angeben.`);
      max_mb = n;
    }
    return { kopie_an, postfaecher, max_mb };
  },
  pruefen: async (v) => {
    if (!v.url) return { ok: false, text: 'Webhook-URL fehlt.' };
    const postfach = postfachFuer(einstellungenLesen(v), aktuellerBenutzer());
    const r = await aufrufen(v, { modus: 'pruefen', anwendung: ANWENDUNG, objekt: 'PRUEFEN', absender: postfach ?? '' }, 30_000);
    const key = v.auth_art === 'header' && v.geheimnis ? 'Webhook-Schlüssel akzeptiert' : 'ohne Webhook-Schlüssel angenommen';
    if (!r.json || typeof r.json.status !== 'string') {
      return { ok: false, text: `n8n erreichbar, aber die Antwort passt nicht zum Workflow „Euroflex Mailversand“ (HTTP ${r.status}): ${r.text.replace(/\s+/g, ' ').slice(0, 150)}` };
    }
    if (r.status === 400) return { ok: false, text: `n8n erreichbar, ${key} – aber der Workflow lehnt den Prüfaufruf ab: ${String(r.json.fehler ?? 'ohne Angabe')}` };
    if (r.json.status !== 'ok') return { ok: false, text: `n8n erreichbar, ${key} – aber Microsoft 365 lehnt das Postfach ${postfach ?? ''} ab: ${String(r.json.fehler ?? 'unbekannter Fehler')}` };
    return postfach
      ? { ok: true, text: `n8n erreichbar, Workflow aktiv, ${key}, Postfach ${postfach} erreichbar (es wurde keine E-Mail versendet).` }
      : { ok: true, text: `n8n erreichbar, Workflow aktiv, ${key}. Für Ihren Benutzer ist kein Postfach hinterlegt – die Anmeldung an Microsoft 365 wurde nicht geprüft.` };
  },
}];

/** Was der Dialog „E-Mail mit Anhängen…“ über den Versand wissen muss */
export async function mailInfo(): Promise<{ eingerichtet: boolean; postfach: string | null; kopieAn: string; maxMb: number }> {
  const v = await verbindungLesen(V_MAIL);
  const e = einstellungenLesen(v);
  return { eingerichtet: eingerichtet(v), postfach: postfachFuer(e, aktuellerBenutzer()), kopieAn: e.kopie_an, maxMb: e.max_mb };
}

/** „a@b, c@d“ → geprüfte Adressen; wirft bei ungültigen */
export function adressenPruefen(roh: string, feld: string): string[] {
  const liste = roh.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  for (const a of liste) if (!EMAIL.test(a)) throw new BusinessError(`${feld}: „${a}“ ist keine gültige E-Mail-Adresse.`);
  return [...new Set(liste)];
}

export interface VersandDatei { name: string; daten: Buffer; mime: string }
export interface VersandAuftrag {
  nr: string;
  modus: 'senden' | 'entwurf';
  an: string;
  cc: string;
  betreff: string;
  text: string;
  dateien: VersandDatei[];
  /** nur diese E-Mails senden (nach einem Teilerfolg: nur die fehlgeschlagene) */
  nur?: Rolle[];
  benutzer: string;
}
export interface VersandMail { rolle: Rolle; an: string; status: 'gesendet' | 'entwurf' | 'fehler'; fehler?: string }
export interface VersandErgebnis { status: 'gesendet' | 'entwurf' | 'teilweise' | 'fehler'; text: string; postfach: string; mails: VersandMail[] }

const ROLLE_TEXT: Record<Rolle, string> = { kunde: 'E-Mail an den Empfänger', kopie: 'E-Mail an die feste zweite Adresse' };

/** Anbindung eingerichtet und Postfach für den angemeldeten Benutzer vorhanden? Wirft sonst – vor dem Laden der Anhänge prüfen */
export async function versandBereit(): Promise<{ v: Verbindung; e: MailEinstellungen; postfach: string }> {
  const v = await verbindungLesen(V_MAIL);
  if (!eingerichtet(v)) throw new BusinessError('Der E-Mail-Versand über Outlook 365 ist nicht eingerichtet (Administration → Anbindungen → Euroflex E-Mail-Versand).');
  const e = einstellungenLesen(v);
  const postfach = postfachFuer(e, aktuellerBenutzer());
  if (!postfach) {
    throw new BusinessError('Für Ihren Benutzer ist kein Postfach hinterlegt: E-Mail-Adresse am Benutzer eintragen oder das Postfach in der Anbindung „Euroflex E-Mail-Versand“ zuordnen.');
  }
  return { v, e, postfach };
}

/** E-Mails zum Auftrag über den n8n-Workflow senden bzw. als Entwürfe im Postfach ablegen; jede E-Mail steht im E-Mail-Protokoll */
export async function euroflexMailSenden(a: VersandAuftrag): Promise<VersandErgebnis> {
  const { v, e, postfach } = await versandBereit();
  const an = adressenPruefen(a.an, 'Empfänger');
  const cc = adressenPruefen(a.cc, 'CC');
  if (!an.length) throw new BusinessError('Bitte einen Empfänger angeben.');
  const betreff = a.betreff.trim();
  if (!betreff) throw new BusinessError('Bitte einen Betreff angeben.');

  const groesse = a.dateien.reduce((s, d) => s + d.daten.length, 0);
  if (groesse > e.max_mb * 1024 * 1024) {
    throw new BusinessError(`Die Anhänge sind zusammen ${(groesse / 1024 / 1024).toFixed(1).replace('.', ',')} MB groß – erlaubt sind ${e.max_mb} MB je Vorgang (Administration → Anbindungen → Euroflex E-Mail-Versand).`);
  }

  const anhaenge = a.dateien.map((d, i) => ({ id: `a${i + 1}`, dateiname: d.name, mime: d.mime, inhalt_base64: d.daten.toString('base64') }));
  const ids = anhaenge.map((x) => x.id);
  const gemeinsam = { betreff, text: a.text, text_format: 'text', anhaenge: ids };
  const alle: { nr: number; rolle: Rolle; an: string[]; cc: string[] }[] = [{ nr: 1, rolle: 'kunde', an, cc }];
  if (e.kopie_an) alle.push({ nr: 2, rolle: 'kopie', an: [e.kopie_an], cc: [] });
  const mails = alle.filter((m) => !a.nur || a.nur.includes(m.rolle));
  if (!mails.length) throw new BusinessError('Es ist keine E-Mail zu senden (die feste zweite Adresse ist nicht eingetragen).');

  const proto = (m: { an: string[]; cc: string[] }) => ({
    anwendung: ANWENDUNG, objekt: a.nr, an: [...m.an, ...m.cc].join(', '), betreff, absender: postfach, von: postfach, benutzer: a.benutzer,
  });
  type Antwort = { nr?: number; status?: string; fehler?: string; message_id?: string };
  let antworten: Antwort[];
  try {
    const r = await aufrufen(v, {
      modus: a.modus, anwendung: ANWENDUNG, objekt: a.nr, benutzer: a.benutzer, absender: postfach, anhaenge,
      mails: mails.map((m) => ({ nr: m.nr, rolle: m.rolle, an: m.an, cc: m.cc, bcc: [], ...gemeinsam })),
    }, 180_000);
    if (!r.json || typeof r.json.status !== 'string') {
      throw new BusinessError(`Unerwartete Antwort von n8n (HTTP ${r.status}): ${r.text.replace(/\s+/g, ' ').slice(0, 150)}`, 502);
    }
    // HTTP 400: der Workflow hat den Aufruf als ungültig abgelehnt und nichts gesendet
    if (r.status === 400 || !Array.isArray(r.json.mails)) throw new BusinessError(`n8n hat den Aufruf abgelehnt: ${String(r.json.fehler ?? 'ohne Angabe')}`, 502);
    antworten = r.json.mails as Antwort[];
  } catch (x) {
    for (const m of mails) await mailProtokoll({ ...proto(m), status: 'fehler', fehler: (x as Error).message });
    throw x;
  }

  const ergebnis: VersandMail[] = [];
  for (const m of mails) {
    const s = antworten.find((x) => x.nr === m.nr);
    const gemeldet = s?.status;
    const status: VersandMail['status'] = gemeldet === 'gesendet' || gemeldet === 'entwurf' ? gemeldet : 'fehler';
    const fehler = status === 'fehler' ? String(s?.fehler ?? 'n8n hat zu dieser E-Mail kein Ergebnis gemeldet.') : undefined;
    await mailProtokoll({ ...proto(m), status, fehler: fehler ?? null, message_id: s?.message_id ?? null });
    ergebnis.push({ rolle: m.rolle, an: m.an.join(', '), status, ...(fehler ? { fehler } : {}) });
  }

  const gut = ergebnis.filter((m) => m.status !== 'fehler');
  const schlecht = ergebnis.filter((m) => m.status === 'fehler');
  const status: VersandErgebnis['status'] = !schlecht.length ? (a.modus === 'senden' ? 'gesendet' : 'entwurf') : gut.length ? 'teilweise' : 'fehler';
  const anzahl = (n: number) => (n === 1 ? '1 E-Mail' : `${n} E-Mails`);
  const anh = a.dateien.length === 1 ? '1 Anhang' : `${a.dateien.length} Anhängen`;
  const fehlertext = schlecht.map((m) => `${ROLLE_TEXT[m.rolle]} (${m.an}): ${m.fehler}`).join(' ');
  const text = status === 'gesendet' ? `${anzahl(gut.length)} mit ${anh} aus dem Postfach ${postfach} gesendet (${gut.map((m) => m.an).join(' · ')}).`
    : status === 'entwurf' ? `${anzahl(gut.length)} mit ${anh} als Entwurf im Postfach ${postfach} abgelegt (Ordner „Entwürfe“).`
    : status === 'teilweise' ? `Nur teilweise ${a.modus === 'senden' ? 'gesendet' : 'abgelegt'}: ${gut.map((m) => `${ROLLE_TEXT[m.rolle]} (${m.an})`).join(', ')} ist erledigt. Fehlgeschlagen: ${fehlertext}`
    : `Nicht ${a.modus === 'senden' ? 'gesendet' : 'abgelegt'}: ${fehlertext}`;
  return { status, text, postfach, mails: ergebnis };
}
