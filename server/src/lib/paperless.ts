/**
 * Paperless-ngx REST-Client (Port von ZCL_TCO_PAPERLESS), von allen Modulen nutzbar.
 *
 *  - Upload (post_document) und neue Dateiversion (update_version, Paperless ≥ 3.0)
 *  - Warten auf die Verarbeitung (tasks → related_document)
 *  - Metadaten setzen: Titel, Korrespondent (wird bei Bedarf angelegt), Dokumenttyp,
 *    Speicherpfad, Custom Fields (Name → Wert)
 *  - Notizen lesen/schreiben, Freigabelinks lesen/anlegen, Versionen, Download
 *
 * Mehrere Basis-URLs (z. B. LAN und Internet) werden der Reihe nach probiert;
 * die erste erreichbare wird 60 s lang gemerkt (wie DETERMINE_BASE_URL).
 *
 * Zwei Rollen der Adressen:
 *  - Ablage (API, Upload, Download, Link in die Paperless-Oberfläche): interne Adressen zuerst,
 *    unabhängig von der Reihenfolge der Eingabe – baseUrl().
 *  - Ausgehend (Freigabelinks in E-Mail, WhatsApp, mailto): immer die externe Adresse –
 *    die „Adresse für Freigabelinks“ (freigabeUrl), sonst die erste Basis-URL, die nicht nur im
 *    eigenen Netz gilt. ausgehend() schreibt Links in fertigen Texten um und lehnt ab, wenn keine
 *    externe Adresse bekannt ist; freigabeExternPflicht() prüft das vor dem Erzeugen.
 */
import { BusinessError } from '../errors.js';

export interface PaperlessConfig {
  /** eine oder mehrere Basis-URLs, durch Komma getrennt */
  url: string | null | undefined;
  token: string | null | undefined;
  /** Zeitlimit je Anfrage in ms (Standard 30 s) */
  timeoutMs?: number;
  /** aus dem Internet erreichbare Adresse für Freigabelinks (z. B. https://dokumente.example.org) */
  freigabeUrl?: string | null;
}

/** Adresse gilt nur im eigenen Netz: LAN-/Loopback-IP, localhost, Rechner- oder Containername ohne Domain */
export function nurIntern(url: string): boolean {
  let h: string;
  try { h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return true; }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || /^f[cd]/.test(h) || h.startsWith('fe80');
  if (!h.includes('.') || h === 'localhost') return true;
  return /\.(localhost|local|lan|internal|intranet|home|box|home\.arpa)$/.test(h);
}

export class PaperlessError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface PaperlessNote { id: number; note: string; created: string; user?: { username?: string } | number | null }
export interface PaperlessVersion { id: number; label: string | null; added: string | null; isRoot: boolean }
export interface UploadMeta {
  title?: string;
  created?: string; // JJJJ-MM-TT
  correspondent?: number;
  documentType?: number;
  storagePath?: number;
  tags?: number[];
  /** MIME-Typ der Datei (Standard application/pdf) */
  mime?: string;
}

const cache = new Map<string, { url: string; until: number }>();

export function paperlessKonfiguriert(c: PaperlessConfig): boolean {
  return !!(c.url && c.url.trim() && c.token && c.token.trim());
}

export const FREIGABE_ADRESSE_FEHLT = 'Für Freigabelinks ist keine aus dem Internet erreichbare Paperless-Adresse eingetragen – der Link wäre nur im eigenen Netz zu öffnen. '
  + 'Bitte unter Administration → Anbindungen → Paperless-ngx die „Adresse für Freigabelinks“ eintragen (z. B. https://dokumente.example.org).';

export class Paperless {
  private readonly urls: string[];
  private readonly token: string;
  private readonly timeout: number;
  private readonly freigabe: string | null;

  constructor(cfg: PaperlessConfig) {
    if (!paperlessKonfiguriert(cfg)) {
      throw new PaperlessError('Paperless ist nicht eingerichtet (URL und API-Token in den Stammdaten).');
    }
    this.urls = cfg.url!.split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
    this.token = cfg.token!.trim().replace(/^Token\s+/i, '');
    this.timeout = cfg.timeoutMs ?? 30_000;
    this.freigabe = (cfg.freigabeUrl ?? '').trim().replace(/\/+$/, '') || null;
  }

  // -------------------------------------------------------------------------
  // Basis-URL und HTTP
  // -------------------------------------------------------------------------

  async baseUrl(): Promise<string> {
    if (this.urls.length === 1) return this.urls[0];
    const key = this.urls.join(',');
    const c = cache.get(key);
    if (c && c.until > Date.now()) return c.url;
    // Ablage: interne Adressen zuerst (kurzer Weg, kein Umweg über das Internet), in der eingegebenen Reihenfolge
    const kandidaten = [...this.urls.filter((u) => nurIntern(u)), ...this.urls.filter((u) => !nurIntern(u))];
    for (const u of kandidaten) {
      try {
        const r = await fetch(`${u}/api/`, { headers: this.headers(), signal: AbortSignal.timeout(2000) });
        if (r.status < 500) {
          cache.set(key, { url: u, until: Date.now() + 60_000 });
          return u;
        }
      } catch { /* nächste URL */ }
    }
    return this.urls[this.urls.length - 1];
  }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Token ${this.token}`, Accept: 'application/json; version=9', ...extra };
  }

  private async request(method: string, pfad: string, body?: unknown, raw = false): Promise<Response> {
    const base = await this.baseUrl();
    const isForm = body instanceof FormData;
    let res: Response;
    try {
      res = await fetch(`${base}/${pfad.replace(/^\//, '')}`, {
        method,
        headers: this.headers(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (e) {
      throw new PaperlessError(`Paperless nicht erreichbar: ${(e as Error).message}`);
    }
    if (raw) return res;
    if (res.status === 401 || res.status === 403) {
      throw new PaperlessError(`Paperless lehnt die Anmeldung ab (HTTP ${res.status}) – API-Token prüfen.`, res.status);
    }
    if (!res.ok) {
      const t = (await res.text()).slice(0, 300);
      throw new PaperlessError(`Paperless-Fehler HTTP ${res.status}: ${t}`, res.status);
    }
    return res;
  }

  private async json<T>(method: string, pfad: string, body?: unknown): Promise<T> {
    const res = await this.request(method, pfad, body);
    const t = await res.text();
    return (t ? JSON.parse(t) : null) as T;
  }

  /** Alle Seiten einer Liste lesen */
  private async alle<T>(pfad: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = pfad + (pfad.includes('?') ? '&' : '?') + 'page_size=100';
    const base = await this.baseUrl();
    while (next) {
      const r: { results: T[]; next: string | null } = await this.json('GET', next.startsWith('http') ? next.slice(base.length) : next);
      out.push(...r.results);
      next = r.next;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Stammdaten (Korrespondenten, Typen, Speicherpfade, Custom Fields)
  // -------------------------------------------------------------------------

  private stammCache = new Map<string, { id: number; name: string; data_type?: string }[]>();

  async liste(art: 'correspondents' | 'document_types' | 'storage_paths' | 'custom_fields' | 'tags') {
    let l = this.stammCache.get(art);
    if (!l) {
      l = await this.alle<{ id: number; name: string; data_type?: string }>(`api/${art}/`);
      this.stammCache.set(art, l);
    }
    return l;
  }

  async idByName(art: 'correspondents' | 'document_types' | 'storage_paths' | 'custom_fields' | 'tags', name: string): Promise<number | null> {
    const n = name.trim().toLowerCase();
    const hit = (await this.liste(art)).find((x) => x.name.trim().toLowerCase() === n);
    return hit?.id ?? null;
  }

  /** Korrespondent suchen, bei Bedarf anlegen (ohne automatische Zuordnung) */
  async korrespondent(name: string, anlegen = true): Promise<number | null> {
    const id = await this.idByName('correspondents', name);
    if (id || !anlegen) return id;
    const r = await this.json<{ id: number; name: string }>('POST', 'api/correspondents/', {
      name: name.trim(), matching_algorithm: 0, match: '', is_insensitive: true,
    });
    this.stammCache.get('correspondents')?.push(r);
    return r.id;
  }

  async dokumenttypen(): Promise<{ id: number; name: string }[]> {
    return this.liste('document_types');
  }

  async korrespondenten(): Promise<{ id: number; name: string }[]> {
    return this.liste('correspondents');
  }

  async tags(): Promise<{ id: number; name: string }[]> {
    return this.liste('tags');
  }

  async speicherpfade(): Promise<{ id: number; name: string }[]> {
    return this.liste('storage_paths');
  }

  /** Tag suchen, bei Bedarf anlegen (ohne automatische Zuordnung) */
  async tag(name: string, anlegen = true): Promise<number | null> {
    const id = await this.idByName('tags', name);
    if (id || !anlegen) return id;
    const r = await this.json<{ id: number; name: string }>('POST', 'api/tags/', {
      name: name.trim(), matching_algorithm: 0, match: '', is_insensitive: true,
    });
    this.stammCache.get('tags')?.push(r);
    return r.id;
  }

  // -------------------------------------------------------------------------
  // Dokumente
  // -------------------------------------------------------------------------

  /** Datei hochladen – liefert die Task-UUID */
  async upload(pdf: Buffer, filename: string, meta: UploadMeta = {}): Promise<string> {
    const form = new FormData();
    form.append('document', new Blob([new Uint8Array(pdf)], { type: meta.mime ?? 'application/pdf' }), filename);
    if (meta.title) form.append('title', meta.title);
    if (meta.created) form.append('created', meta.created);
    if (meta.correspondent) form.append('correspondent', String(meta.correspondent));
    if (meta.documentType) form.append('document_type', String(meta.documentType));
    if (meta.storagePath) form.append('storage_path', String(meta.storagePath));
    for (const t of meta.tags ?? []) form.append('tags', String(t));
    const res = await this.request('POST', 'api/documents/post_document/', form);
    return (await res.text()).trim().replace(/"/g, '');
  }

  /** Neue Dateiversion zu einem Dokument – liefert die Task-UUID */
  async uploadVersion(docId: number, pdf: Buffer, filename: string, label?: string): Promise<string> {
    const form = new FormData();
    form.append('document', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
    if (label) form.append('version_label', label);
    const res = await this.request('POST', `api/documents/${docId}/update_version/`, form);
    return (await res.text()).trim().replace(/"/g, '');
  }

  /**
   * Auf die Verarbeitung warten (wie GET_DOCID_BY_TASK: bis zu n Versuche im Sekundentakt).
   * Liefert die Dokument-ID oder null; bei Fehlschlag (z. B. Duplikat) eine PaperlessError.
   */
  async warteAufDokument(taskId: string, versuche = 20, pauseMs = 1000): Promise<number | null> {
    for (let i = 0; i < versuche; i++) {
      const r = await this.json<{ status: string; related_document: string | number | null; result: string | null }[]>(
        'GET', `api/tasks/?task_id=${encodeURIComponent(taskId)}`);
      const t = r?.[0];
      if (t?.status === 'SUCCESS' && t.related_document) return Number(t.related_document);
      if (t?.status === 'FAILURE') throw new PaperlessError(`Paperless konnte das Dokument nicht verarbeiten: ${t.result ?? ''}`.trim());
      await new Promise((ok) => setTimeout(ok, pauseMs));
    }
    return null;
  }

  /** Custom Field per Name oder per ID („3“) */
  async feld(nameOderId: string): Promise<{ id: number; name: string; data_type?: string } | null> {
    const l = await this.liste('custom_fields');
    if (/^\d+$/.test(nameOderId.trim())) {
      const id = Number(nameOderId);
      return l.find((x) => x.id === id) ?? { id, name: nameOderId };
    }
    return l.find((x) => x.name.trim().toLowerCase() === nameOderId.trim().toLowerCase()) ?? null;
  }

  /** Custom Field mit allen Angaben (z. B. Auswahlwerte eines Select-Felds) */
  async feldDetails(name: string): Promise<{ id: number; name: string; data_type?: string; extra_data?: { select_options?: (string | { id: string; label: string })[] } } | null> {
    return ((await this.liste('custom_fields')) as Record<string, any>[]).find((x) => String(x.name).trim().toLowerCase() === name.trim().toLowerCase()) as never ?? null;
  }

  /** Custom Field anlegen (z. B. Textfeld „Folgeaktion“) */
  async feldAnlegen(name: string, dataType: 'string' | 'select' = 'string'): Promise<{ id: number; name: string; data_type: string }> {
    const r = await this.json<{ id: number; name: string; data_type: string }>('POST', 'api/custom_fields/', { name: name.trim(), data_type: dataType });
    this.stammCache.get('custom_fields')?.push(r);
    return r;
  }

  /** Wert eines Custom Fields aus einem Dokument (Feld per Name oder ID) */
  async feldWert(doc: Record<string, any>, nameOderId: string): Promise<unknown> {
    const f = await this.feld(nameOderId);
    return f ? (doc.custom_fields ?? []).find((x: { field: number }) => x.field === f.id)?.value ?? null : null;
  }

  /** Dokumente suchen (Paperless-Filterparameter), alle Seiten */
  async dokumenteSuchen(filter: Record<string, string>): Promise<Record<string, any>[]> {
    const q = new URLSearchParams(filter).toString();
    return this.alle<Record<string, any>>(`api/documents/?${q}`);
  }

  /** IDs zu Namen (Dokumenttypen, Speicherpfade …); unbekannte Namen entfallen */
  async ids(art: 'correspondents' | 'document_types' | 'storage_paths' | 'tags', namen: string[]): Promise<number[]> {
    const out: number[] = [];
    for (const n of namen) {
      const id = await this.idByName(art, n);
      if (id) out.push(id);
    }
    return out;
  }

  async korrespondentName(id: number | null | undefined): Promise<string> {
    if (!id) return '';
    return (await this.liste('correspondents')).find((x) => x.id === id)?.name ?? '';
  }

  async dokument(id: number): Promise<Record<string, any>> {
    return this.json('GET', `api/documents/${id}/`);
  }

  /** Dokument löschen (Papierkorb) und – soweit möglich – den Papierkorb für dieses Dokument leeren */
  async loeschen(id: number): Promise<void> {
    await this.request('DELETE', `api/documents/${id}/`);
    await this.request('POST', 'api/trash/', { documents: [id], action: 'empty' }, true).catch(() => undefined);
  }

  async existiert(id: number): Promise<boolean> {
    const r = await this.request('GET', `api/documents/${id}/`, undefined, true);
    return r.ok;
  }

  /** Metadaten setzen; Namen werden in IDs übersetzt, Custom Fields per Name */
  async metadatenSetzen(id: number, m: {
    title?: string; correspondent?: string; documentType?: string; storagePath?: string;
    customFields?: Record<string, string | number | null>; created?: string;
  }): Promise<string[]> {
    const warn: string[] = [];
    const patch: Record<string, unknown> = {};
    if (m.title) patch.title = m.title;
    if (m.created) patch.created = m.created;
    if (m.correspondent) patch.correspondent = await this.korrespondent(m.correspondent);
    if (m.documentType) {
      const t = await this.idByName('document_types', m.documentType);
      if (t) patch.document_type = t; else warn.push(`Dokumenttyp „${m.documentType}“ fehlt in Paperless`);
    }
    if (m.storagePath) {
      const t = await this.idByName('storage_paths', m.storagePath);
      if (t) patch.storage_path = t; else warn.push(`Speicherpfad „${m.storagePath}“ fehlt in Paperless`);
    }
    if (m.customFields) {
      const doc = await this.dokument(id);
      const vorhanden: { field: number; value: unknown }[] = doc.custom_fields ?? [];
      const neu = new Map(vorhanden.map((f) => [f.field, f.value]));
      for (const [name, value] of Object.entries(m.customFields)) {
        const f = await this.feld(name);
        if (!f) { warn.push(`Custom Field „${name}“ fehlt in Paperless`); continue; }
        const w = customFeldWert(f as CustomFeld, value);
        if (w.warnung) warn.push(w.warnung);
        if (w.ok) neu.set(f.id, w.wert);
      }
      patch.custom_fields = [...neu].map(([field, value]) => ({ field, value }));
    }
    if (Object.keys(patch).length) await this.json('PATCH', `api/documents/${id}/`, patch);
    return warn;
  }

  async notizen(id: number): Promise<PaperlessNote[]> {
    const r = await this.json<PaperlessNote[] | { results: PaperlessNote[] }>('GET', `api/documents/${id}/notes/`);
    return Array.isArray(r) ? r : r?.results ?? [];
  }

  async notizAnlegen(id: number, text: string): Promise<void> {
    await this.json('POST', `api/documents/${id}/notes/`, { note: text });
  }

  /**
   * Externe Adresse für alles, was das Haus verlässt: die eingestellte Adresse für Freigabelinks
   * (bewusste Angabe – gilt auch, wenn sie intern ist, z. B. reiner LAN-Betrieb), sonst die erste Basis-URL,
   * die auch außerhalb des eigenen Netzes gilt. null = keine bekannt.
   */
  freigabeExtern(): string | null {
    return this.freigabe ?? this.urls.find((u) => !nurIntern(u)) ?? null;
  }

  /** vor dem Erzeugen ausgehender Nachrichten: ohne externe Adresse abbrechen, bevor etwas abgelegt oder versendet wird */
  freigabeExternPflicht(): string {
    const e = this.freigabeExtern();
    if (!e) throw new BusinessError(FREIGABE_ADRESSE_FEHLT);
    return e;
  }

  /** Adresse, mit der Freigabelinks gebildet werden: die externe, ersatzweise (nur für die Ablage/Anzeige) die des Servers */
  async freigabeBasis(): Promise<string> {
    return this.freigabeExtern() ?? this.baseUrl();
  }

  /**
   * Text, der das Haus verlässt (E-Mail, WhatsApp, mailto): Freigabelinks tragen immer die externe Adresse.
   * Links auf eine der eigenen oder eine nur intern erreichbare Adresse werden umgeschrieben (auch in früher
   * erzeugten oder von Hand bearbeiteten Texten); ohne externe Adresse wird der Text abgelehnt.
   */
  ausgehend(text: string): string {
    const extern = this.freigabeExtern();
    return text.replace(/\bhttps?:\/\/[^\s<>"'()]+?\/share\/[A-Za-z0-9_-]+/g, (link) => {
      const i = link.lastIndexOf('/share/');
      const basis = link.slice(0, i);
      if (basis === extern) return link;
      if (!this.urls.includes(basis) && !nurIntern(basis)) return link; // fremder, öffentlich erreichbarer Link
      if (!extern) throw new BusinessError(FREIGABE_ADRESSE_FEHLT);
      return extern + link.slice(i);
    });
  }

  /** Freigabelinks eines Dokuments, jüngster zuerst; abgelaufene werden ausgelassen */
  async freigabelinks(id: number): Promise<string[]> {
    const base = await this.freigabeBasis();
    const r = await this.json<{ slug: string; expiration: string | null; created: string }[]>('GET', `api/documents/${id}/share_links/`);
    const now = Date.now();
    return (r ?? [])
      .filter((l) => !l.expiration || Date.parse(l.expiration) > now)
      .sort((a, b) => b.created.localeCompare(a.created))
      .map((l) => `${base}/share/${l.slug}`);
  }

  async freigabelinkAnlegen(id: number, tage = 30): Promise<string> {
    const base = await this.freigabeBasis();
    const ablauf = new Date(Date.now() + tage * 86_400_000).toISOString().slice(0, 10);
    const r = await this.json<{ slug: string }>('POST', 'api/share_links/', {
      document: id, expiration: `${ablauf}T23:59:59`, file_version: 'original',
    });
    return `${base}/share/${r.slug}`;
  }

  /** gültigen Freigabelink liefern, sonst neuen anlegen */
  async freigabelink(id: number, tage = 30): Promise<string> {
    return (await this.freigabelinks(id))[0] ?? this.freigabelinkAnlegen(id, tage);
  }

  /** Versionen eines Dokuments (Stammdokument zuerst) */
  async versionen(id: number): Promise<PaperlessVersion[]> {
    const d = await this.dokument(id);
    const v: PaperlessVersion[] = (d.versions ?? []).map((x: any) => ({
      id: Number(x.id), label: x.version_label ?? x.label ?? null, added: x.added ?? x.created ?? null, isRoot: Number(x.id) === id,
    }));
    if (!v.some((x) => x.id === id)) v.push({ id, label: 'Original', added: d.added ?? d.created ?? null, isRoot: true });
    return v.sort((a, b) => a.id - b.id);
  }

  async neuesteVersion(id: number): Promise<number> {
    const v = await this.versionen(id);
    return v[v.length - 1]?.id ?? id;
  }

  async download(id: number, original = false): Promise<{ data: Buffer; contentType: string; filename: string }> {
    const res = await this.request('GET', `api/documents/${id}/download/${original ? '?original=true' : ''}`);
    const cd = res.headers.get('content-disposition') ?? '';
    const fn = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/pdf',
      filename: fn ? decodeURIComponent(fn) : `dokument_${id}.pdf`,
    };
  }

  /** Link zur Paperless-Oberfläche */
  async ansichtUrl(id: number): Promise<string> {
    return `${await this.baseUrl()}/documents/${id}/details`;
  }
}

export interface CustomFeld { id: number; name: string; data_type?: string; extra_data?: { select_options?: (string | { id: string; label: string } | null)[] | null } | null }

/** Zahl aus „1.234,56“, „1234.56“, „EUR12,50“, „12,50 €“ */
function zahl(v: string): number | null {
  let t = v.replace(/[€\s]|EUR/gi, '');
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? n : null;
}

/**
 * Wert für ein Custom Field in die Form bringen, die Paperless je Feldtyp erwartet (Geld „EUR12.50“, Datum JJJJ-MM-TT,
 * Ganzzahl, Kommazahl, Ja/Nein, Auswahl per Options-ID). Unlesbare Werte werden nicht gesetzt (ok: false) und gemeldet.
 */
export function customFeldWert(f: CustomFeld, value: string | number | null): { ok: boolean; wert: unknown; warnung?: string } {
  if (value === null || value === '') return { ok: true, wert: null };
  const text = String(value).trim();
  const falsch = (art: string) => ({ ok: false, wert: null, warnung: `Custom Field „${f.name}“: „${text}“ ist kein gültiger Wert (${art}).` });
  switch (f.data_type) {
    case 'monetary': {
      const waehrung = /^([A-Z]{3})/.exec(text)?.[1] ?? 'EUR';
      const n = typeof value === 'number' ? value : zahl(text);
      return n === null ? falsch('Betrag') : { ok: true, wert: `${waehrung}${n.toFixed(2)}` };
    }
    case 'float': {
      const n = typeof value === 'number' ? value : zahl(text);
      return n === null ? falsch('Zahl') : { ok: true, wert: n };
    }
    case 'integer': {
      const n = typeof value === 'number' ? value : zahl(text);
      return n === null || !Number.isInteger(n) ? falsch('Ganzzahl') : { ok: true, wert: n };
    }
    case 'date': {
      const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
      const iso = de ? `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}` : text.slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? { ok: true, wert: iso } : falsch('Datum');
    }
    case 'boolean': {
      if (/^(ja|true|1|wahr|x)$/i.test(text)) return { ok: true, wert: true };
      if (/^(nein|false|0|falsch)$/i.test(text)) return { ok: true, wert: false };
      return falsch('Ja/Nein');
    }
    case 'select': {
      const optionen = f.extra_data?.select_options ?? [];
      for (let i = 0; i < optionen.length; i++) {
        const o = optionen[i];
        if (o == null) continue;
        const label = typeof o === 'string' ? o : o.label;
        const id = typeof o === 'string' ? i : o.id;
        if (label.trim().toLowerCase() === text.toLowerCase() || String(id) === text) return { ok: true, wert: id };
      }
      return falsch(`Auswahl: ${optionen.filter((o) => o != null).map((o) => (typeof o === 'string' ? o : o!.label)).join(', ')}`);
    }
    default:
      return { ok: true, wert: typeof value === 'number' ? value : text };
  }
}

