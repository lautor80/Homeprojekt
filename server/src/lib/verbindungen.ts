import { sql, type Tx } from '../db.js';
import { BusinessError } from '../errors.js';
import { Paperless, paperlessKonfiguriert } from './paperless.js';

/**
 * Zentrale Anbindungen (Administration → Anbindungen), Tabelle core.verbindungen.
 *
 * Der Kern meldet die Verbindung „paperless“ an; Module melden weitere Verbindungen über
 * ServerModule.verbindungen (z. B. n8n-Webhooks) und lesen die Werte mit verbindungLesen().
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
  return { id: def.id, url, auth_art, auth_user, header_name, geheimnis: auth_art === 'keine' ? null : geheimnis, einstellungen: e.einstellungen ?? alt.einstellungen ?? {} };
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
// Paperless-ngx: eine Verbindung für Kern und alle Module
// ---------------------------------------------------------------------------

export const PAPERLESS_DEF: VerbindungDef = {
  id: 'paperless', text: 'Paperless-ngx',
  beschreibung: 'Dokumentenablage für alle Module (Belege, Rechnungen, Mitgliederdokumente, Ablagefeld). Mehrere Adressen durch Komma: erst LAN, dann Internet – die erste erreichbare wird genutzt.',
  auth: ['token'],
  felder: { url: 'URL (mehrere durch Komma: erst LAN, dann Internet)', geheimnis: 'API-Token (Paperless → Profil)' },
  pruefen: async (v) => {
    if (!paperlessKonfiguriert({ url: v.url, token: v.geheimnis })) return { ok: false, text: 'URL und API-Token fehlen.' };
    const pl = new Paperless({ url: v.url, token: v.geheimnis });
    const url = await pl.baseUrl();
    const k = await pl.korrespondenten();
    return { ok: true, text: `Verbunden mit ${url} (${k.length} Korrespondenten).` };
  },
};

/** Paperless-Client aus der zentralen Verbindung; null, wenn nicht eingerichtet */
export async function paperlessZentral(db?: Tx): Promise<Paperless | null> {
  const v = await verbindungLesen('paperless', db);
  return paperlessKonfiguriert({ url: v.url, token: v.geheimnis }) ? new Paperless({ url: v.url, token: v.geheimnis }) : null;
}

/** Zugangsdaten für Module, die den Client selbst bauen (z. B. mit anderem Zeitlimit) */
export async function paperlessZugang(db?: Tx): Promise<{ url: string | null; token: string | null }> {
  const v = await verbindungLesen('paperless', db);
  return eingerichtet(v) ? { url: v.url, token: v.geheimnis } : { url: null, token: null };
}
