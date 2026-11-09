import type { Verein } from './verein.js';
import { heute } from './format.js';
import { N8N_PLATZHALTER, N8N_PLATZHALTER_TEXT, webhookFehler } from './kommunikation.js';

/**
 * Verbindungstests für die Anbindungen in den Stammdaten. Lesende Endpunkte werden wirklich aufgerufen
 * (Rückmeldungen, Ferien, EP3-Export – im Portal wird nichts übernommen). Der Mailversand wird mit einem
 * ungültigen Aufruf geprüft (Anmeldung ja, Mail nein), damit keine E-Mail entsteht.
 */

/** Paperless wird zentral geprüft (Administration → Anbindungen) */
export const ENDPUNKTE = ['mail', 'ep3', 'stunden', 'ferien'] as const;
export type Endpunkt = (typeof ENDPUNKTE)[number];
export interface TestErgebnis { ok: boolean; text: string; dauer_ms: number }

const auth = (h: string | null | undefined): Record<string, string> => (h?.trim() ? { Authorization: h.trim() } : {});

async function abrufen(url: string, init: RequestInit, timeout = 30_000): Promise<{ res: Response; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  return { res, text: await res.text() };
}

function httpFehler(status: number, text: string, mitAnmeldung: boolean): string {
  if (status === 401 || status === 403) {
    return mitAnmeldung ? 'Anmeldung abgelehnt – Benutzer/Passwort stimmen nicht mit dem Webhook in n8n überein.'
      : 'Der Webhook verlangt eine Anmeldung – bitte Benutzer und Passwort eintragen.';
  }
  if (status === 404) return 'Webhook nicht gefunden – ist der Workflow in n8n aktiv und die URL (Production-URL, nicht /webhook-test/) richtig?';
  return `HTTP ${status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`;
}

async function pruefen(v: Verein, e: Endpunkt): Promise<{ ok: boolean; text: string }> {
  switch (e) {
    case 'mail': {
      if (!v.n8n_mail_url) return { ok: false, text: 'Webhook-URL fehlt.' };
      // nur anklopfen: n8n antwortet auf GET bei einem POST-Webhook mit „not registered for GET requests“
      const { res, text } = await abrufen(v.n8n_mail_url, { method: 'GET', headers: v.n8n_mail_key ? { 'X-TCO-Key': v.n8n_mail_key } : {} }, 10_000);
      if (!(/not registered for GET/i.test(text) || res.status === 405 || res.ok)) {
        return { ok: false, text: (res.status !== 404 && webhookFehler(res.status, text, !!v.n8n_mail_key)) || httpFehler(res.status, text, !!v.n8n_mail_key) };
      }
      // Schlüssel prüfen, ohne dass eine Mail entsteht: ungültiger Modus ohne Empfänger – n8n prüft erst die Anmeldung,
      // der Workflow lehnt den Aufruf danach mit HTTP 400 ab
      const p = await abrufen(v.n8n_mail_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(v.n8n_mail_key ? { 'X-TCO-Key': v.n8n_mail_key } : {}) },
        body: JSON.stringify({ modus: 'pruefen', anwendung: 'Verbindungstest', objekt: 'PRUEFEN', an: '', betreff: '', text: '', anhaenge: [] }),
      }, 15_000);
      const abgelehnt = N8N_PLATZHALTER.test(v.n8n_mail_key ?? '') && (p.res.status === 401 || p.res.status === 403)
        ? N8N_PLATZHALTER_TEXT : webhookFehler(p.res.status, p.text, !!v.n8n_mail_key);
      if (abgelehnt) return { ok: false, text: `n8n erreichbar, Workflow aktiv – aber: ${abgelehnt}` };
      if (p.res.status >= 500) return { ok: false, text: `n8n erreichbar, aber der Workflow meldet einen Fehler (HTTP ${p.res.status}): ${p.text.replace(/\s+/g, ' ').slice(0, 150)}` };
      return { ok: true, text: `n8n erreichbar, Workflow aktiv, ${v.n8n_mail_key ? 'Webhook-Schlüssel akzeptiert' : 'ohne Webhook-Schlüssel angenommen'} (es wurde keine E-Mail versendet).` };
    }
    case 'ep3': {
      if (!v.n8n_ep3_url) return { ok: false, text: 'Webhook-URL fehlt.' };
      const { res, text } = await abrufen(v.n8n_ep3_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(v.n8n_ep3_auth) },
        body: JSON.stringify({ quelle: 'Verbindungstest Portal', test: true }),
      }, 120_000);
      if (!res.ok) return { ok: false, text: httpFehler(res.status, text, !!v.n8n_ep3_auth) };
      try {
        const j = JSON.parse(text) as Record<string, string>;
        const n = (s?: string) => (s ? Math.max(0, s.trim().split('\n').length - 1) : 0);
        if (!j.bookings_csv && !j.kunden_csv) return { ok: false, text: 'Verbunden, aber n8n hat keine EP3-Daten geliefert.' };
        const kopf = (j.bookings_csv ?? '').split('\n')[0].split(/[;,]/).map((x) => x.trim().replace(/"/g, '').toUpperCase());
        const platz = ['PLATZ', 'SQUARE', 'SQUARE_NAME', 'COURT', 'SNAME', 'SID'].find((x) => kopf.includes(x));
        return {
          ok: true,
          text: `Verbunden: ${n(j.bookings_csv)} Buchungen, ${n(j.kunden_csv)} Kunden geliefert (nichts übernommen). `
            + (platz ? `Platz kommt aus Spalte ${platz}.` : `Achtung: keine Platzspalte im Export (Spalten: ${kopf.join(', ')}) – Sommer-Abos gelten als Außenplatz.`),
        };
      } catch { return { ok: false, text: 'Verbunden, aber die Antwort ist kein JSON.' }; }
    }
    case 'stunden': {
      if (!v.n8n_stunden_url) return { ok: false, text: 'Webhook-URL fehlt.' };
      const u = new URL(v.n8n_stunden_url);
      u.searchParams.set('format', 'csv');
      const { res, text } = await abrufen(u.toString(), { headers: auth(v.n8n_stunden_auth) });
      if (!res.ok) return { ok: false, text: httpFehler(res.status, text, !!v.n8n_stunden_auth) };
      const zeilen = /^\s*\{/.test(text)
        ? (() => { try { return (JSON.parse(text).rueckmeldungen ?? []).length as number; } catch { return -1; } })()
        : Math.max(0, text.replace(/\r/g, '').trim().split('\n').length - 1);
      if (zeilen < 0) return { ok: false, text: 'Verbunden, aber die Antwort ist nicht lesbar.' };
      return { ok: true, text: `Verbunden: ${zeilen} Rückmeldung(en) aus Nextcloud gelesen (nichts übernommen).` };
    }
    case 'ferien': {
      if (!v.n8n_ferien_url) return { ok: false, text: 'Webhook-URL fehlt.' };
      const u = new URL(v.n8n_ferien_url);
      const jahr = heute().slice(0, 4);
      u.searchParams.set('jahr', jahr);
      const { res, text } = await abrufen(u.toString(), { headers: auth(v.n8n_stunden_auth) });
      if (!res.ok) return { ok: false, text: httpFehler(res.status, text, !!v.n8n_stunden_auth) };
      try {
        const j = JSON.parse(text) as { ferientage?: unknown[]; feiertage?: unknown[]; fehler?: string };
        if (j.fehler) return { ok: false, text: j.fehler };
        return { ok: true, text: `Verbunden: ${j.ferientage?.length ?? 0} Ferientage und ${j.feiertage?.length ?? 0} Feiertage für ${jahr}.` };
      } catch { return { ok: false, text: 'Verbunden, aber die Antwort ist kein JSON.' }; }
    }
    default: return { ok: false, text: 'Unbekannter Endpunkt.' };
  }
}

export async function verbindungTesten(v: Verein, e: Endpunkt): Promise<TestErgebnis> {
  const start = Date.now();
  try {
    const r = await pruefen(v, e);
    return { ...r, dauer_ms: Date.now() - start };
  } catch (err) {
    const m = (err as Error).message;
    const ursache = (err as { cause?: { code?: string } }).cause?.code;
    const text = (err as Error).name === 'TimeoutError' ? 'Keine Antwort (Zeitüberschreitung).'
      : ursache === 'ECONNREFUSED' ? 'Verbindung abgelehnt – läuft der Dienst unter dieser Adresse/Port?'
        : ursache === 'ENOTFOUND' ? 'Servername nicht gefunden.'
          : m === 'fetch failed' ? `Nicht erreichbar${ursache ? ` (${ursache})` : ''}.` : m;
    return { ok: false, text, dauer_ms: Date.now() - start };
  }
}
