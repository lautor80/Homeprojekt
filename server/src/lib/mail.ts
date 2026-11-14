import { sql, type Tx } from '../db.js';
import { BusinessError } from '../errors.js';
import { aktuellerBenutzer } from '../kontext.js';
import { ausgehendMehrere } from './paperless.js';
import { stoerungMelden } from './hinweise.js';
import { authHeader, eingerichtet, N8N_PLATZHALTER, N8N_PLATZHALTER_TEXT, paperlessAlle, verbindungLesen, type Verbindung, type VerbindungDef } from './verbindungen.js';

/**
 * E-Mail-Versand des Portals über den generischen n8n-Workflow „TCO Mailversand“ (Webhook, docs/n8n/tco-mailversand.json).
 * Zugang: zentrale Anbindung „mail“ (Administration → Schnittstellen → Anbindungen) – URL und Webhook-Schlüssel (Header X-TCO-Key);
 * in deren Einstellungen die Ersatzabsender je Anwendung. Jeder Versuch landet im Mailprotokoll core.mail_protokoll.
 *
 * Absender ist, wer auf „Senden“ drückt (Anfragekontext). Darf dessen Adresse in n8n nicht senden (KONTEN), nimmt n8n den
 * Ersatz je Anwendung bzw. seinen Standard und setzt die Antwortadresse auf den Benutzer.
 */

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

/**
 * Wie eine fehlgeschlagene Mail erneut gesendet wird (Mailprotokoll → „Erneut senden“):
 * ohne Angabe wird die Nachricht samt Anhängen gespeichert und unverändert wiederholt.
 * Mails mit Zugangslinks oder Kennwörtern werden nie gespeichert: NEU_AUSLOESEN nennt, wo man sie neu auslöst; andere Arten
 * erzeugen einen neuen Link – das übernimmt das Modul über ServerModule.mailWiederholen (z. B. REG_BESTAETIGUNG, EINLADUNG).
 */
export type Wiederholung = { art: 'NEU_AUSLOESEN'; hinweis: string } | ({ art: string } & Record<string, unknown>);
/** Was nach erfolgreicher Wiederholung nachgezogen wird (wie beim ersten Versand) – ausgeführt vom Modul über ServerModule.mailFolge */
export type MailFolge = { art: string } & Record<string, unknown>;

export interface MailAuftrag {
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
  /** fester Absender (sonst: angemeldeter Benutzer, Ersatz je Anwendung aus den Einstellungen der Anbindung) */
  absender?: string; absender_name?: string; antwort_an?: string;
  /** false = nie mit der Adresse des angemeldeten Benutzers senden (z. B. Systemmails) */
  persoenlich?: boolean;
  /** Erneut senden aus dem Mailprotokoll: Pflicht für Mails mit Zugangslinks/Kennwörtern (siehe Wiederholung) */
  wiederholung?: Wiederholung;
  folge?: MailFolge;
  /** Name der Organisation für „Anzeigename | Organisation“ (Standard: Einstellung org.name) */
  organisation?: string;
}

export const MAIL_ID = 'mail';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Ersatzabsender je Anwendung aus den Einstellungen der Anbindung */
export function absenderListe(v: Pick<Verbindung, 'einstellungen'>): MailAbsender[] {
  const l = (v.einstellungen as { absender?: unknown })?.absender;
  return Array.isArray(l) ? (l as MailAbsender[]).filter((x) => x && typeof x.email === 'string' && typeof x.anwendung === 'string') : [];
}

/** Absender für eine Anwendung (gleiche Anwendung, sonst „*“); null = Standard des n8n-Workflows */
export function absenderFuer(liste: MailAbsender[], anwendung: string): MailAbsender | null {
  const a = anwendung.trim().toLowerCase();
  return liste.find((x) => x.email && x.anwendung.trim().toLowerCase() === a) ?? liste.find((x) => x.email && x.anwendung.trim() === '*') ?? null;
}

/** Klartext für eine Ablehnung des Mail-Webhooks durch n8n (Header-Auth: fehlender und falscher Schlüssel ergeben beide 403) */
export function webhookFehler(status: number, text: string, mitSchluessel: boolean): string | null {
  if (/No authentication data defined/i.test(text)) {
    return 'Im n8n-Workflow ist am Webhook-Knoten keine Zugangsdatei ausgewählt (nach dem Import „Header Auth account“ neu wählen und speichern).';
  }
  if (status === 401 || status === 403) {
    return mitSchluessel
      ? 'n8n hat den Webhook-Schlüssel abgelehnt: Im n8n-Credential „Header Auth account“ muss der Name „X-TCO-Key“ lauten und der Wert '
        + 'exakt dem Webhook-Schlüssel im Portal entsprechen (Groß-/Kleinschreibung, keine Leerzeichen).'
      : 'n8n verlangt einen Webhook-Schlüssel – im Portal ist keiner hinterlegt (Administration → Schnittstellen → Anbindungen → Mailversand).';
  }
  if (status === 404) return 'n8n-Workflow "TCO Mailversand" ist nicht aktiv oder die URL stimmt nicht (Webhook 404)';
  return null;
}

function httpFehler(status: number, text: string, mitSchluessel: boolean): string {
  if (status === 404) return 'Webhook nicht gefunden – ist der Workflow in n8n aktiv und die URL (Production-URL, nicht /webhook-test/) richtig?';
  return webhookFehler(status, text, mitSchluessel) ?? `HTTP ${status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`;
}

/** Anbindung „mail“ (Administration → Schnittstellen → Anbindungen) */
export const MAIL_DEF: VerbindungDef = {
  id: MAIL_ID, text: 'E-Mail-Versand (n8n)',
  beschreibung: 'Generischer n8n-Workflow „TCO Mailversand“ für alle E-Mails des Portals (Kennwort-Links, Registrierung, Rechnungen, Mitglieder …). '
    + 'Der Webhook-Schlüssel muss dem Wert im n8n-Credential „Header Auth account“ (Name X-TCO-Key) entsprechen. Der Test prüft Erreichbarkeit, Workflow und Schlüssel, ohne eine E-Mail zu senden.',
  auth: ['header', 'keine'],
  header_name: 'X-TCO-Key',
  felder: { url: 'Webhook-URL (z. B. http://n8n:5678/webhook/tco-mailversand)', geheimnis: 'Webhook-Schlüssel', header_name: 'Header-Name' },
  einstellungen: (e) => {
    const roh = Array.isArray(e.absender) ? (e.absender as Record<string, unknown>[]) : [];
    const absender: MailAbsender[] = [];
    for (const x of roh) {
      if (!x) continue;
      const anwendung = String(x.anwendung ?? '').trim();
      const email = String(x.email ?? '').trim();
      if (!anwendung && !email) continue; // leere Zeile
      if (!anwendung) throw new BusinessError('Absender: bitte die Anwendung angeben (* = Standard).');
      if (anwendung.length > 40) throw new BusinessError('Absender: Anwendung zu lang.');
      if (!EMAIL.test(email)) throw new BusinessError(`Absender: ungültige E-Mail-Adresse „${email}“.`);
      const antwort_an = String(x.antwort_an ?? '').trim();
      if (antwort_an && !EMAIL.test(antwort_an)) throw new BusinessError(`Absender: ungültige Antwortadresse „${antwort_an}“.`);
      absender.push({ anwendung, email, name: String(x.name ?? '').trim().slice(0, 80) || null, antwort_an: antwort_an || null });
    }
    if (absender.length > 30) throw new BusinessError('Höchstens 30 Absender.');
    return { ...e, absender };
  },
  pruefen: async (v) => {
    if (!v.url) return { ok: false, text: 'Webhook-URL fehlt.' };
    const key = !!(v.auth_art === 'header' && v.geheimnis);
    const kopf = authHeader(v);
    const abrufen = async (init: RequestInit, timeout: number) => {
      let res: Response;
      try { res = await fetch(v.url, { ...init, signal: AbortSignal.timeout(timeout) }); } catch (e) { throw new BusinessError(`Nicht erreichbar: ${(e as Error).message}`); }
      return { res, text: await res.text() };
    };
    // nur anklopfen: n8n antwortet auf GET bei einem POST-Webhook mit „not registered for GET requests“
    const { res, text } = await abrufen({ method: 'GET', headers: kopf }, 10_000);
    if (!(/not registered for GET/i.test(text) || res.status === 405 || res.ok)) {
      return { ok: false, text: (res.status !== 404 && webhookFehler(res.status, text, key)) || httpFehler(res.status, text, key) };
    }
    // Schlüssel prüfen, ohne dass eine Mail entsteht: ungültiger Modus ohne Empfänger – n8n prüft erst die Anmeldung,
    // der Workflow lehnt den Aufruf danach mit HTTP 400 ab
    const p = await abrufen({
      method: 'POST', headers: { 'Content-Type': 'application/json', ...kopf },
      body: JSON.stringify({ modus: 'pruefen', anwendung: 'Verbindungstest', objekt: 'PRUEFEN', an: '', betreff: '', text: '', anhaenge: [] }),
    }, 15_000);
    const abgelehnt = N8N_PLATZHALTER.test(v.geheimnis ?? '') && (p.res.status === 401 || p.res.status === 403) ? N8N_PLATZHALTER_TEXT : webhookFehler(p.res.status, p.text, key);
    if (abgelehnt) return { ok: false, text: `n8n erreichbar, Workflow aktiv – aber: ${abgelehnt}` };
    if (p.res.status >= 500) return { ok: false, text: `n8n erreichbar, aber der Workflow meldet einen Fehler (HTTP ${p.res.status}): ${p.text.replace(/\s+/g, ' ').slice(0, 150)}` };
    return { ok: true, text: `n8n erreichbar, Workflow aktiv, ${key ? 'Webhook-Schlüssel akzeptiert' : 'ohne Webhook-Schlüssel angenommen'} (es wurde keine E-Mail versendet).` };
  },
};

export const mailVerbindung = (db?: Tx) => verbindungLesen(MAIL_ID, db);

/** true, wenn der Versand eingerichtet ist (Webhook-URL vorhanden) */
export async function mailVerfuegbar(db?: Tx): Promise<boolean> {
  return eingerichtet(await mailVerbindung(db));
}

// ---------------------------------------------------------------------------
// Mailprotokoll
// ---------------------------------------------------------------------------

/** Versuch protokollieren (eigene Verbindung, damit der Eintrag auch bei zurückgerollter Transaktion bleibt); Fehler hier nie weiterreichen */
export async function mailProtokoll(e: { anwendung: string; objekt: string; an: string; betreff: string; absender?: string | null; von?: string | null;
  status: string; fehler?: string | null; benutzer?: string | null; nachricht?: unknown; message_id?: string | null }): Promise<number | null> {
  try {
    // Message-ID ohne spitze Klammern, klein: daran werden Rückläufer und Antworten zugeordnet (lib/maileingang-db.ts)
    const mid = String(e.message_id ?? '').trim().replace(/^<|>$/g, '').toLowerCase() || null;
    const [r] = await sql`insert into core.mail_protokoll (anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer, nachricht, message_id)
             values (${e.anwendung}, ${e.objekt}, ${e.an}, ${e.betreff}, ${e.absender ?? null}, ${e.von ?? null}, ${e.status},
                     ${e.fehler ? String(e.fehler).slice(0, 1000) : null}, ${e.benutzer ?? null},
                     ${e.nachricht ? sql.json(e.nachricht as never) : null}, ${mid}) returning id`;
    // Arbeitsvorrat (#232, V1): Eine E-Mail, die nicht hinausging, steht unter „Administration“, bis jemand „gesehen“ bestätigt
    if (e.status === 'fehler' || e.status === 'nicht_gesendet') {
      await stoerungMelden({
        modul: 'core', quelle: 'MAIL_FEHLER', bereich: 'Administration', recht: 'core.mail:display', art: 'E-Mail nicht gesendet', icon: 'email',
        titel: `an ${e.an || '(ohne Empfänger)'}`.slice(0, 200), text: `${e.betreff} – ${e.fehler ?? 'ohne Fehlermeldung'}`.replace(/\s+/g, ' ').slice(0, 300), pfad: '/admin/mailprotokoll',
      });
    }
    await sql`delete from core.mail_protokoll where zeit < now() - interval '180 days'`;
    // gespeicherte Inhalte (Datenschutz) nur 30 Tage
    await sql`update core.mail_protokoll set nachricht = null where nachricht is not null and zeit < now() - interval '30 days'`;
    return Number(r.id);
  } catch { return null; /* Protokoll ist nur Diagnose */ }
}

/** Was zum erneuten Senden gespeichert wird (30 Tage; Zugangslinks und Kennwörter nie – dafür steht die Wiederholungsart) */
function wiederholDaten(m: MailAuftrag): unknown {
  if (m.wiederholung) return { wiederholung: m.wiederholung };
  const ich = m.persoenlich === false || m.absender ? null : aktuellerBenutzer();
  return {
    folge: m.folge ?? null,
    mail: {
      modus: m.modus, anwendung: m.anwendung, objekt: m.objekt, an: m.an, cc: m.cc ?? '', bcc: m.bcc ?? '', betreff: m.betreff, text: m.text,
      html: !!m.html, antwort_an: m.antwort_an ?? '',
      // Absender wie beim ersten Versuch (wer gesendet hat), nicht wer wiederholt
      absender: m.absender ?? ich?.email ?? null, absender_name: m.absender ? m.absender_name ?? '' : ich?.email ? ich.displayName : null,
      persoenlich: m.persoenlich ?? null, organisation: m.organisation ?? null,
      anhaenge: m.anhaenge.map((a) => ({ ...a, inhalt: a.inhalt.toString('base64') })),
    },
  };
}

async function organisationsName(): Promise<string> {
  const [r] = await sql`select value from core.settings where key = 'org.name'`;
  return typeof r?.value === 'string' ? r.value : '';
}

// ---------------------------------------------------------------------------
// Versand
// ---------------------------------------------------------------------------

export async function mailSenden(m: MailAuftrag): Promise<MailErgebnis & { protokoll?: number | null }> {
  const proto = { anwendung: m.anwendung, objekt: m.objekt, an: m.an, betreff: m.betreff, benutzer: m.benutzer };
  const v = await mailVerbindung();
  if (!eingerichtet(v)) {
    await mailProtokoll({ ...proto, status: 'nicht_gesendet', fehler: 'n8n-Mailversand nicht eingerichtet (Webhook-URL fehlt)', nachricht: wiederholDaten(m) });
    throw new BusinessError('Der n8n-Mailversand ist nicht eingerichtet (Administration → Schnittstellen → Anbindungen).');
  }
  try {
    // Ausgehend: Freigabelinks immer mit der externen Paperless-Adresse (auch in bearbeiteten oder erneut gesendeten Texten) –
    // je Link mit dem Paperless des Bereichs, zu dem seine Adresse gehört (#232, S5)
    m = { ...m, text: ausgehendMehrere(m.text, await paperlessAlle()) };
    const r = await mailSendenIntern(v, m);
    // Inhalt bzw. Anleitung zum Neuerzeugen auch bei Erfolg festhalten: E-Mail-Protokoll → „Erneut senden“ je Zeile (30 Tage, nie mit Zugangslinks)
    const protokoll = await mailProtokoll({ ...proto, absender: r.absender, von: r.von ?? null, status: r.status, fehler: r.fehler ?? (r.hinweis || null),
      nachricht: wiederholDaten(m), message_id: r.message_id ?? null });
    return { ...r, protokoll };
  } catch (e) {
    await mailProtokoll({ ...proto, status: 'fehler', fehler: (e as Error).message, nachricht: wiederholDaten(m) });
    throw e;
  }
}

async function mailSendenIntern(v: Verbindung, m: MailAuftrag): Promise<MailErgebnis & { absender?: string; hinweis?: string }> {
  const groesse = m.anhaenge.reduce((s, a) => s + a.inhalt.length, 0);
  if (groesse > 10 * 1024 * 1024) throw new BusinessError(`Anhänge zu groß (${(groesse / 1024 / 1024).toFixed(1)} MB, höchstens 10 MB)`);
  const ich = m.persoenlich === false || m.absender ? null : aktuellerBenutzer();
  const ersatz = absenderFuer(absenderListe(v), m.anwendung);
  const org = m.organisation ?? await organisationsName();
  const abs = m.absender ? { email: m.absender, name: m.absender_name ?? '' }
    : ich?.email ? { email: ich.email, name: org ? `${ich.displayName} | ${org}` : ich.displayName } : ersatz ? { email: ersatz.email, name: ersatz.name ?? '' } : null;
  const body = {
    modus: m.modus, anwendung: m.anwendung, objekt: m.objekt, an: m.an, cc: m.cc ?? '', bcc: m.bcc ?? '', betreff: m.betreff,
    text: m.text, text_format: m.html ? 'html' : 'text', benutzer: m.benutzer, quelle: 'Portal',
    ...(abs ? { absender: abs.email, absender_name: abs.name || '' } : {}),
    ...(ersatz && abs?.email !== ersatz.email ? { absender_ersatz: ersatz.email, absender_ersatz_name: ersatz.name ?? '' } : {}),
    // feste Antwortadresse der Einstellungen nur, wenn nicht persönlich gesendet wird (sonst antwortet man dem Absender)
    antwort_an: m.antwort_an || (ich?.email ? '' : ersatz?.antwort_an) || '',
    anhaenge: m.anhaenge.map((a) => ({
      dateiname: a.dateiname, mime: a.mime ?? 'application/pdf', inhalt_base64: a.inhalt.toString('base64'),
      paperless_root_id: a.paperless_root_id ?? null, paperless_version_id: a.paperless_version_id ?? null, objekt: a.objekt ?? m.objekt,
    })),
  };
  const key = !!(v.auth_art === 'header' && v.geheimnis);
  let res: Response;
  try {
    res = await fetch(v.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(v) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw new BusinessError(`n8n nicht erreichbar: ${(e as Error).message}`, 502);
  }
  const t = await res.text();
  if ((res.status === 401 || res.status === 403) && N8N_PLATZHALTER.test(v.geheimnis ?? '')) throw new BusinessError(N8N_PLATZHALTER_TEXT, 502);
  const ablehnung = webhookFehler(res.status, t, key);
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

// ---------------------------------------------------------------------------
// Erneut senden (Mailprotokoll)
// ---------------------------------------------------------------------------

interface GespeicherteMail {
  modus: 'senden' | 'entwurf'; anwendung: string; objekt: string; an: string; cc: string; bcc: string; betreff: string; text: string;
  html: boolean; antwort_an: string; absender: string | null; absender_name: string | null; persoenlich: boolean | null; organisation?: string | null;
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
  if ('wiederholung' in n && n.wiederholung.art === 'NEU_AUSLOESEN') return (n.wiederholung as { hinweis: string }).hinweis;
  return null;
}

/** Art der Wiederholung eines Protokolleintrags (für die Oberfläche: neuer Link ja/nein) */
export function wiederholungsArt(nachricht: unknown): string | null {
  return (nachricht as { wiederholung?: { art: string } } | null)?.wiederholung?.art ?? null;
}

export interface WiederholHooks {
  /** Modul erzeugt eine Mail mit neuem Link (cc: Kopie an diese Adresse); null = Art nicht zuständig */
  wiederholen: (tx: Tx, w: Wiederholung, wer: string, cc?: string) => Promise<string | null>;
  /** Modul zieht nach erfolgreicher Wiederholung nach; null = Art nicht zuständig */
  folge: (tx: Tx, f: MailFolge) => Promise<string[] | null>;
}

export async function mailWiederholen(tx: Tx, id: number, wer: string, hooks: WiederholHooks): Promise<{ text: string; warnungen: string[] }> {
  const [p] = await tx`select id, status, nachricht, erneut_status from core.mail_protokoll where id = ${id}`;
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
      if (w.art === 'NEU_AUSLOESEN') throw new BusinessError((w as { hinweis: string }).hinweis);
      const t = await hooks.wiederholen(tx, w, wer);
      if (t === null) throw new BusinessError(`Für diese E-Mail (${w.art}) gibt es keine Wiederholung mehr – bitte in der Anwendung neu auslösen.`);
      text = t;
    } else {
      const m = n.mail;
      const r = await mailSenden({
        modus: m.modus, anwendung: m.anwendung, objekt: m.objekt, an: m.an, cc: m.cc, bcc: m.bcc, betreff: m.betreff, text: m.text,
        html: m.html, antwort_an: m.antwort_an || undefined, benutzer: wer, organisation: m.organisation ?? undefined,
        // Absender wie beim ersten Versuch; hatte der keinen persönlichen, auch jetzt nicht den des Wiederholenden
        ...(m.absender ? { absender: m.absender, absender_name: m.absender_name ?? '' } : { persoenlich: false }),
        anhaenge: m.anhaenge.map((a) => ({ ...a, inhalt: Buffer.from(a.inhalt, 'base64') })),
        folge: n.folge ?? undefined,
      });
      if (r.status === 'fehler') throw new Error(r.fehler ?? 'n8n meldet einen Fehler');
      status = r.status;
      if (n.folge && r.status === 'gesendet') warnungen.push(...((await hooks.folge(tx, n.folge)) ?? [`Nachziehen für ${n.folge.art} nicht möglich – bitte in der Anwendung prüfen.`]));
      text = r.status === 'entwurf' ? `Entwurf an ${m.an} im Postfach abgelegt.` : `E-Mail an ${m.an} erneut gesendet${r.von ? ` (Absender ${r.von})` : ''}.`;
    }
  } catch (e) {
    // fehlgeschlagene Wiederholung festhalten (eigene Verbindung – die Transaktion wird zurückgerollt)
    await sql`update core.mail_protokoll set erneut_am = now(), erneut_von = ${wer}, erneut_status = 'fehler' where id = ${id}`.catch(() => undefined);
    throw e;
  }
  // gespeicherten Inhalt nach Erfolg löschen (Datenschutz); neue Mail steht als eigener Eintrag im Protokoll
  await tx`update core.mail_protokoll set erneut_am = now(), erneut_von = ${wer}, erneut_status = ${status}, nachricht = null where id = ${id}`;
  return { text, warnungen };
}

// ---------------------------------------------------------------------------
// Erneut senden je Zeile (App „E-Mail-Protokoll“) – auch bereits gesendete E-Mails, mit Kopie an den Absender
// ---------------------------------------------------------------------------

/** Warum ein Eintrag (gleich welchen Status) nicht erneut gesendet werden kann; null = kann */
export function erneutSperre(nachricht: unknown): string | null {
  const n = nachricht as Nachricht | null;
  if (!n) return 'Inhalt nicht gespeichert (vor dem Update gesendet oder älter als 30 Tage) – bitte in der Anwendung neu auslösen.';
  if ('wiederholung' in n && n.wiederholung.art === 'NEU_AUSLOESEN') return (n.wiederholung as { hinweis: string }).hinweis;
  return null;
}

/** Adressen zusammenführen (ohne Dubletten, Groß-/Kleinschreibung egal) */
export function ccMit(vorhanden: string | null | undefined, dazu: string | null | undefined): string {
  const liste = (vorhanden ?? '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
  const neu = (dazu ?? '').trim();
  if (neu && !liste.some((x) => x.toLowerCase().includes(neu.toLowerCase()))) liste.push(neu);
  return liste.join(', ');
}

/**
 * E-Mail eines Protokolleintrags erneut senden – auch wenn sie schon gesendet wurde und beliebig oft; cc = Kopie (Absender der ersten E-Mail).
 * Zugangslinks werden neu erzeugt (ältere ungültig). Nachgezogen (Rechnung „versendet“ …) wird nur, wenn der erste Versand
 * fehlgeschlagen war und noch nicht erfolgreich wiederholt wurde. Der gespeicherte Inhalt bleibt bis zum Ablauf der 30 Tage.
 */
export async function mailErneutSenden(tx: Tx, id: number, wer: string, hooks: WiederholHooks, cc: string | null): Promise<{ text: string; warnungen: string[] }> {
  const [p] = await tx`select id, status, nachricht, erneut_status from core.mail_protokoll where id = ${id}`;
  if (!p) throw new BusinessError('Den Protokolleintrag gibt es nicht (mehr).', 404);
  const grund = erneutSperre(p.nachricht);
  if (grund) throw new BusinessError(grund);
  const n = p.nachricht as Nachricht;
  const offen = WIEDERHOLBAR.includes(p.status) && p.erneut_status !== 'gesendet' && p.erneut_status !== 'entwurf';
  let text: string;
  let status = 'gesendet';
  const warnungen: string[] = [];
  try {
    if ('wiederholung' in n) {
      const t = await hooks.wiederholen(tx, n.wiederholung, wer, cc ?? undefined);
      if (t === null) throw new BusinessError(`Für diese E-Mail (${n.wiederholung.art}) gibt es keine Wiederholung mehr – bitte in der Anwendung neu auslösen.`);
      text = t;
    } else {
      const m = n.mail;
      const r = await mailSenden({
        modus: m.modus, anwendung: m.anwendung, objekt: m.objekt, an: m.an, cc: ccMit(m.cc, cc), bcc: m.bcc, betreff: m.betreff, text: m.text,
        html: m.html, antwort_an: m.antwort_an || undefined, benutzer: wer, organisation: m.organisation ?? undefined,
        ...(m.absender ? { absender: m.absender, absender_name: m.absender_name ?? '' } : { persoenlich: false }),
        anhaenge: m.anhaenge.map((a) => ({ ...a, inhalt: Buffer.from(a.inhalt, 'base64') })),
        folge: offen ? n.folge ?? undefined : undefined,
      });
      if (r.status === 'fehler') throw new Error(r.fehler ?? 'n8n meldet einen Fehler');
      status = r.status;
      if (offen && n.folge && r.status === 'gesendet') warnungen.push(...((await hooks.folge(tx, n.folge)) ?? [`Nachziehen für ${n.folge.art} nicht möglich – bitte in der Anwendung prüfen.`]));
      text = r.status === 'entwurf' ? `Entwurf an ${m.an} im Postfach abgelegt.` : `E-Mail an ${m.an} erneut gesendet${r.von ? ` (Absender ${r.von})` : ''}.`;
    }
  } catch (e) {
    // fehlgeschlagene Wiederholung festhalten (eigene Verbindung – die Transaktion wird zurückgerollt); eine frühere erfolgreiche bleibt stehen
    await sql`update core.mail_protokoll set erneut_am = now(), erneut_von = ${wer}, erneut_status = 'fehler'
               where id = ${id} and coalesce(erneut_status, '') not in ('gesendet', 'entwurf')`.catch(() => undefined);
    throw e;
  }
  await tx`update core.mail_protokoll set erneut_am = now(), erneut_von = ${wer}, erneut_status = ${status} where id = ${id}`;
  return { text: cc ? `${text} Kopie (CC) an ${cc}.` : text, warnungen };
}
