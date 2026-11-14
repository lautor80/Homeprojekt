import { sql, type Tx } from '../db.js';
import { BusinessError } from '../errors.js';
import { nurIntern, Paperless, paperlessKonfiguriert } from './paperless.js';

/**
 * Zentrale Anbindungen (Administration → Schnittstellen → Anbindungen), Tabelle core.verbindungen.
 *
 * Der Kern meldet den E-Mail-Versand an; Module melden ihre Verbindungen über ServerModule.verbindungen
 * (n8n-Webhooks, ihr Paperless – je Bereich ein eigenes, siehe paperlessDef) und lesen die Werte mit verbindungLesen().
 * Geheimnisse (Token, Header-Wert, Passwort) verlassen den Server nur maskiert; beim Speichern
 * bedeutet die Maske „unverändert“.
 */

export type AuthArt = 'keine' | 'token' | 'header' | 'basic';

export interface Verbindung {
  id: string;
  url: string;
  auth_art: AuthArt;
  auth_user: string | null;
  header_name: string | null;
  geheimnis: string | null;
  einstellungen: Record<string, unknown>;
}

export interface VerbindungDef {
  /** eindeutig; Modulverbindungen mit Präfix „<modul>.“ (z. B. tco.ep3) */
  id: string;
  text: string;
  beschreibung: string;
  /** zulässige Anmeldearten, die erste ist Standard */
  auth: AuthArt[];
  /** Beschriftungen für die Oberfläche */
  felder?: { url?: string; geheimnis?: string; auth_user?: string; header_name?: string };
  /** Vorschlag für den Header-Namen bei auth_art „header“ */
  header_name?: string;
  /** Verbindungstest mit den (gespeicherten oder aus dem Formular übernommenen) Werten – wirft oder liefert ok/text */
  pruefen?: (v: Verbindung) => Promise<{ ok: boolean; text: string }>;
  /** zusätzliche Textfelder der Oberfläche, gespeichert in einstellungen[key] */
  zusatz?: { key: string; text: string; platzhalter?: string }[];
  /** zusätzliche Einstellungen prüfen und bereinigen (wirft BusinessError); ohne Angabe werden sie unverändert übernommen */
  einstellungen?: (e: Record<string, unknown>) => Record<string, unknown>;
}

export interface VerbindungGruppe { modul: string; name: string; verbindungen: VerbindungDef[] }

export const MASKE = '********';

/** Platzhalter, den n8n in Credential-Feldern statt des gespeicherten Geheimnisses anzeigt – kein gültiger Wert */
export const N8N_PLATZHALTER = /^__n8n_BLANK_VALUE_/;
export const N8N_PLATZHALTER_TEXT = 'Das ist nicht der Schlüssel, sondern der Platzhalter, den n8n statt gespeicherter Geheimnisse anzeigt '
  + '(„__n8n_BLANK_VALUE_…“). Bitte den Wert in n8n neu eintippen und denselben Wert hier eintragen.';

const LEER = (id: string): Verbindung => ({ id, url: '', auth_art: 'keine', auth_user: null, header_name: null, geheimnis: null, einstellungen: {} });

const cache = new Map<string, { v: Verbindung; until: number }>();
export const verbindungenCacheLeeren = () => cache.clear();

/** gespeicherte Verbindung (ohne Eintrag: leer) */
export async function verbindungLesen(id: string, db: Tx = sql as unknown as Tx): Promise<Verbindung> {
  const c = cache.get(id);
  if (c && c.until > Date.now()) return c.v;
  const [r] = await db`select id, url, auth_art, auth_user, header_name, geheimnis, einstellungen from core.verbindungen where id = ${id}`;
  const v = r ? ({ ...(r as unknown as Verbindung), einstellungen: (r.einstellungen as Record<string, unknown>) ?? {} }) : LEER(id);
  cache.set(id, { v, until: Date.now() + 30_000 });
  return v;
}

export const eingerichtet = (v: Verbindung) => !!v.url.trim();

/** HTTP-Header für die Anmeldung an der Verbindung */
export function authHeader(v: Verbindung): Record<string, string> {
  switch (v.auth_art) {
    case 'token': return v.geheimnis ? { Authorization: `Token ${v.geheimnis.trim().replace(/^Token\s+/i, '')}` } : {};
    case 'header': return v.header_name && v.geheimnis ? { [v.header_name]: v.geheimnis } : {};
    case 'basic': return v.auth_user && v.geheimnis ? { Authorization: `Basic ${Buffer.from(`${v.auth_user}:${v.geheimnis}`, 'utf8').toString('base64')}` } : {};
    default: return {};
  }
}

/** Ausgabe für die Oberfläche: Geheimnis maskiert */
export function maskieren(v: Verbindung): Verbindung {
  return { ...v, geheimnis: v.geheimnis ? MASKE : '' };
}

export interface VerbindungEingabe {
  url?: string | null; auth_art?: AuthArt | null; auth_user?: string | null; header_name?: string | null;
  geheimnis?: string | null; einstellungen?: Record<string, unknown> | null;
}

/** Eingabe mit dem gespeicherten Stand zusammenführen (MASKE = Geheimnis unverändert) */
export function uebernehmen(def: VerbindungDef, alt: Verbindung, e: VerbindungEingabe): Verbindung {
  const auth_art = (e.auth_art ?? (def.auth.includes(alt.auth_art) ? alt.auth_art : def.auth[0])) as AuthArt;
  if (!def.auth.includes(auth_art)) throw new BusinessError(`Anmeldeart „${auth_art}“ ist für ${def.text} nicht vorgesehen.`);
  let geheimnis = e.geheimnis === undefined ? alt.geheimnis : e.geheimnis;
  if (geheimnis === MASKE) geheimnis = alt.geheimnis;
  geheimnis = geheimnis?.trim() || null;
  if (geheimnis && N8N_PLATZHALTER.test(geheimnis)) throw new BusinessError(N8N_PLATZHALTER_TEXT);
  const url = (e.url ?? alt.url ?? '').trim();
  if (url) {
    for (const u of url.split(',')) {
      if (!/^https?:\/\/\S+$/i.test(u.trim())) throw new BusinessError(`Ungültige Adresse „${u.trim()}“ – bitte mit http:// oder https:// angeben.`);
    }
  }
  const auth_user = auth_art === 'basic' ? ((e.auth_user ?? alt.auth_user) ?? '').trim() || null : null;
  const header_name = auth_art === 'header' ? ((e.header_name ?? alt.header_name ?? def.header_name) ?? '').trim() || null : null;
  if (auth_art === 'basic' && (!!auth_user !== !!geheimnis)) throw new BusinessError('Für die Anmeldung bitte Benutzer und Passwort angeben – oder beides leer lassen.');
  if (auth_art === 'header' && geheimnis && !header_name) throw new BusinessError('Bitte den Namen des Headers angeben (z. B. X-TCO-Key).');
  if (auth_art === 'basic' && e.auth_user !== undefined && (e.auth_user ?? '').trim() !== (alt.auth_user ?? '') && e.geheimnis === MASKE && alt.geheimnis) {
    throw new BusinessError('Nach dem Ändern des Benutzers bitte das Passwort neu eingeben.');
  }
  const einstellungen = e.einstellungen ? (def.einstellungen ? def.einstellungen(e.einstellungen) : e.einstellungen) : alt.einstellungen ?? {};
  return { id: def.id, url, auth_art, auth_user, header_name, geheimnis: auth_art === 'keine' ? null : geheimnis, einstellungen };
}

export async function verbindungSpeichern(tx: Tx, v: Verbindung, benutzer: string): Promise<void> {
  await tx`insert into core.verbindungen (id, url, auth_art, auth_user, header_name, geheimnis, einstellungen, geaendert_am, geaendert_von)
           values (${v.id}, ${v.url}, ${v.auth_art}, ${v.auth_user}, ${v.header_name}, ${v.geheimnis}, ${tx.json(v.einstellungen as never)}, now(), ${benutzer})
           on conflict (id) do update set url = excluded.url, auth_art = excluded.auth_art, auth_user = excluded.auth_user,
             header_name = excluded.header_name, geheimnis = excluded.geheimnis, einstellungen = excluded.einstellungen,
             geaendert_am = now(), geaendert_von = excluded.geaendert_von`;
  verbindungenCacheLeeren();
}

// ---------------------------------------------------------------------------
// Paperless-ngx: ein eigener Zugang je Bereich (#232, S5)
// ---------------------------------------------------------------------------

/**
 * Id der Paperless-Anbindung eines Bereichs. Vorgabe: Jeder Bereich hat sein eigenes Paperless, zwei Bereiche zeigen nie
 * auf dieselbe Adresse. TC Oberthal behält den bisherigen gemeinsamen Zugang – deshalb heißt seine Anbindung weiter
 * „paperless“ (kein Umzug der gespeicherten Werte, auch nicht nach dem Einspielen einer älteren Sicherung). Jeder andere
 * Bereich hat „<modul>.paperless“, z. B. transport.paperless für Euroflex.
 */
export const paperlessId = (modul: string): string => (modul === 'tco' ? 'paperless' : `${modul}.paperless`);
export const istPaperlessId = (id: string): boolean => id === 'paperless' || id.endsWith('.paperless');

/** Anbindung „Paperless-ngx <Bereich>“ – jedes Modul mit Dokumentenablage meldet seine an (ServerModule.verbindungen) */
export function paperlessDef(modul: string, bereich: string): VerbindungDef {
  return {
    id: paperlessId(modul), text: `Paperless-ngx ${bereich}`,
    beschreibung: `Dokumentenablage für ${bereich} – ein eigenes Paperless je Bereich, nie dieselbe Adresse wie ein anderer Bereich. Mehrere Adressen durch Komma: Für die Ablage nutzt das Portal die erste erreichbare, interne Adressen zuerst. `
      + 'Alles Ausgehende (Freigabelinks in E-Mails und WhatsApp-Nachrichten) bekommt immer die Adresse für Freigabelinks – ohne Eintrag die erste Adresse, die aus dem Internet erreichbar ist.',
    auth: ['token'],
    felder: { url: 'URL für die Ablage (mehrere durch Komma, z. B. LAN und Internet)', geheimnis: 'API-Token (Paperless → Profil)' },
    zusatz: [{ key: 'freigabe_url', text: 'Adresse für Freigabelinks (aus dem Internet erreichbar)', platzhalter: 'https://dokumente.example.org' }],
    einstellungen: (e) => {
      const f = String(e.freigabe_url ?? '').trim().replace(/\/+$/, '');
      if (f && !/^https?:\/\/[^\s,]+$/i.test(f)) throw new BusinessError('Adresse für Freigabelinks: bitte genau eine Adresse mit http:// oder https:// angeben (z. B. https://dokumente.example.org).');
      return f ? { freigabe_url: f } : {};
    },
    pruefen: async (v) => {
      if (!paperlessKonfiguriert({ url: v.url, token: v.geheimnis })) return { ok: false, text: 'URL und API-Token fehlen.' };
      await paperlessEindeutig(v);
      const pl = new Paperless({ url: v.url, token: v.geheimnis, freigabeUrl: freigabeUrl(v) });
      const url = await pl.baseUrl();
      const k = await pl.korrespondenten();
      const fb = pl.freigabeExtern();
      const hinweis = !fb ? ' Achtung: Es ist keine aus dem Internet erreichbare Adresse bekannt – E-Mails und WhatsApp-Nachrichten mit Freigabelink werden abgelehnt, bis die Adresse für Freigabelinks eingetragen ist.'
        : nurIntern(fb) ? ` Freigabelinks: ${fb} (nur im eigenen Netz erreichbar).`
          : ` Freigabelinks: ${fb}.`;
      return { ok: true, text: `Verbunden mit ${url} (${k.length} Korrespondenten).${hinweis}` };
    },
  };
}

/** eingestellte Adresse für Freigabelinks einer Paperless-Anbindung */
const freigabeUrl = (v: Verbindung): string | null => String(v.einstellungen?.freigabe_url ?? '').trim() || null;

/** Adressen einer Paperless-Anbindung zum Vergleichen: Rechner und Pfad, ohne http/https und Schrägstrich am Ende */
function adressen(v: Verbindung): string[] {
  return [...v.url.split(','), freigabeUrl(v) ?? ''].map((u) => u.trim()).filter(Boolean).map((u) => {
    try { const x = new URL(u); return `${x.host}${x.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch { return u.toLowerCase().replace(/\/+$/, ''); }
  });
}

/**
 * Vorgabe (#232, S5): Zwei Bereiche zeigen nie auf dasselbe Paperless. Vor dem Sichern und beim Verbindungstest geprüft –
 * gegen die Adressen für die Ablage und für Freigabelinks aller anderen Paperless-Anbindungen.
 */
export async function paperlessEindeutig(v: Verbindung, db: Tx = sql as unknown as Tx): Promise<void> {
  const eigene = adressen(v);
  if (!eigene.length) return;
  const andere = (await db`select id, url, einstellungen from core.verbindungen where (id = 'paperless' or id like ${'%.paperless'}) and id <> ${v.id}`) as unknown as Verbindung[];
  for (const a of andere) {
    const doppelt = adressen({ ...a, einstellungen: a.einstellungen ?? {} }).find((x) => eigene.includes(x));
    if (doppelt) {
      throw new BusinessError(`Die Adresse ${doppelt} ist schon bei der Anbindung „${a.id}“ eingetragen. Jeder Bereich braucht sein eigenes Paperless – zwei Bereiche zeigen nie auf dieselbe Adresse.`);
    }
  }
}

const client = (v: Verbindung): Paperless | null =>
  (paperlessKonfiguriert({ url: v.url, token: v.geheimnis }) ? new Paperless({ url: v.url, token: v.geheimnis, freigabeUrl: freigabeUrl(v) }) : null);

/** Paperless-Client eines Bereichs (modul = Id des Moduls); null, wenn für diesen Bereich nicht eingerichtet */
export async function paperlessFuer(modul: string, db?: Tx): Promise<Paperless | null> {
  return client(await verbindungLesen(paperlessId(modul), db));
}

/** alle eingerichteten Paperless-Zugänge – für Texte, die das Haus verlassen (Freigabelinks jedes Bereichs, lib/mail.ts) */
export async function paperlessAlle(db: Tx = sql as unknown as Tx): Promise<Paperless[]> {
  const ids = (await db`select id from core.verbindungen where id = 'paperless' or id like ${'%.paperless'} order by id`).map((r) => r.id as string);
  const out: Paperless[] = [];
  for (const id of ids) { const c = client(await verbindungLesen(id, db)); if (c) out.push(c); }
  return out;
}

/** Zugangsdaten eines Bereichs für Module, die den Client selbst bauen (z. B. mit anderem Zeitlimit) */
export async function paperlessZugang(modul: string, db?: Tx): Promise<{ url: string | null; token: string | null; freigabeUrl: string | null }> {
  const v = await verbindungLesen(paperlessId(modul), db);
  return eingerichtet(v) ? { url: v.url, token: v.geheimnis, freigabeUrl: freigabeUrl(v) } : { url: null, token: null, freigabeUrl: null };
}
