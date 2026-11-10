import { heute } from './format.js';
import { authHeader, type Verbindung, type VerbindungDef } from '../../../server/src/lib/verbindungen.js';
import { WebDav } from '../../../server/src/lib/webdav.js';

/**
 * Anbindungen des Vereinsmoduls (Administration → Anbindungen): n8n-Webhooks für Importe. Zugangsdaten zu Nextcloud oder
 * EP3 liegen in den n8n-Workflows; hier steht nur die Anmeldung am jeweiligen Webhook (Basic Auth wie in SM59).
 * Die Verbindungstests rufen die lesenden Endpunkte wirklich auf, übernehmen aber nichts.
 * Paperless und Mailversand meldet der Kern.
 */

export const V_EP3 = 'tco.ep3';
export const V_STUNDEN = 'tco.stunden';
export const V_FERIEN = 'tco.ferien';
export const V_NEXTCLOUD = 'tco.nextcloud';

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

const mitAnmeldung = (v: Verbindung) => v.auth_art === 'basic' && !!v.geheimnis;

export const TCO_VERBINDUNGEN: VerbindungDef[] = [
  {
    id: V_STUNDEN, text: 'Rückmeldungen Jugendtraining (n8n)',
    beschreibung: 'Liest die Stundenrückmeldungen der Trainer aus Nextcloud über den n8n-Webhook TCO_N8N_STUNDEN. Anmeldung am Webhook mit Benutzer und Passwort, sofern n8n sie verlangt.',
    auth: ['basic', 'header', 'keine'],
    felder: { url: 'Webhook-URL (z. B. http://n8n:5678/webhook/TCO_N8N_STUNDEN)' },
    pruefen: async (v) => {
      if (!v.url) return { ok: false, text: 'Webhook-URL fehlt.' };
      const u = new URL(v.url);
      u.searchParams.set('format', 'csv');
      const { res, text } = await abrufen(u.toString(), { headers: authHeader(v) });
      if (!res.ok) return { ok: false, text: httpFehler(res.status, text, mitAnmeldung(v)) };
      const zeilen = /^\s*\{/.test(text)
        ? (() => { try { return (JSON.parse(text).rueckmeldungen ?? []).length as number; } catch { return -1; } })()
        : Math.max(0, text.replace(/\r/g, '').trim().split('\n').length - 1);
      if (zeilen < 0) return { ok: false, text: 'Verbunden, aber die Antwort ist nicht lesbar.' };
      return { ok: true, text: `Verbunden: ${zeilen} Rückmeldung(en) aus Nextcloud gelesen (nichts übernommen).` };
    },
  },
  {
    id: V_FERIEN, text: 'Schulferien Saarland (n8n)',
    beschreibung: 'Ferien und Feiertage je Jahr über den n8n-Webhook ferien-saarland. Anmeldung wie bei den Rückmeldungen.',
    auth: ['basic', 'header', 'keine'],
    felder: { url: 'Webhook-URL (z. B. http://n8n:5678/webhook/ferien-saarland)' },
    pruefen: async (v) => {
      if (!v.url) return { ok: false, text: 'Webhook-URL fehlt.' };
      const u = new URL(v.url);
      const jahr = heute().slice(0, 4);
      u.searchParams.set('jahr', jahr);
      const { res, text } = await abrufen(u.toString(), { headers: authHeader(v) });
      if (!res.ok) return { ok: false, text: httpFehler(res.status, text, mitAnmeldung(v)) };
      try {
        const j = JSON.parse(text) as { ferientage?: unknown[]; feiertage?: unknown[]; fehler?: string };
        if (j.fehler) return { ok: false, text: j.fehler };
        return { ok: true, text: `Verbunden: ${j.ferientage?.length ?? 0} Ferientage und ${j.feiertage?.length ?? 0} Feiertage für ${jahr}.` };
      } catch { return { ok: false, text: 'Verbunden, aber die Antwort ist kein JSON.' }; }
    },
  },
  {
    id: V_EP3, text: 'EP3-Export Hallenbuchungen (n8n)',
    beschreibung: 'Übernahme der Hallenbuchungen und Kunden aus dem EP3-Buchungssystem über n8n. Der Test ruft den Export ab, übernimmt aber nichts.',
    auth: ['keine', 'basic', 'header'],
    felder: { url: 'Webhook-URL' },
    pruefen: async (v) => {
      if (!v.url) return { ok: false, text: 'Webhook-URL fehlt.' };
      const { res, text } = await abrufen(v.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(v) },
        body: JSON.stringify({ quelle: 'Verbindungstest Portal', test: true }),
      }, 120_000);
      if (!res.ok) return { ok: false, text: httpFehler(res.status, text, mitAnmeldung(v)) };
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
    },
  },
  {
    id: V_NEXTCLOUD, text: 'Nextcloud Dokumentenablage',
    beschreibung: 'Arbeitsablage des Dokumenteneingangs: Regeln können Dokumente zusätzlich zu Paperless in einen Ordner der Nextcloud legen (WebDAV). Anmeldung mit Benutzer und App-Passwort (Nextcloud → Einstellungen → Sicherheit).',
    auth: ['basic'],
    felder: { url: 'Adresse der Nextcloud (z. B. https://cloud.example.org)', auth_user: 'Benutzer', geheimnis: 'App-Passwort' },
    pruefen: async (v) => {
      if (!v.url || !v.auth_user || !v.geheimnis) return { ok: false, text: 'Adresse, Benutzer und App-Passwort fehlen.' };
      const eintraege = await new WebDav(v.url, v.auth_user, v.geheimnis, 20_000).liste('');
      return { ok: true, text: `Verbunden: ${eintraege.length} Einträge im Hauptordner von ${v.auth_user}.` };
    },
  },
];
