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
 */

export interface PaperlessConfig {
  /** eine oder mehrere Basis-URLs, durch Komma getrennt */
  url: string | null | undefined;
  token: string | null | undefined;
  /** Zeitlimit je Anfrage in ms (Standard 30 s) */
  timeoutMs?: number;
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
}

const cache = new Map<string, { url: string; until: number }>();

export function paperlessKonfiguriert(c: PaperlessConfig): boolean {
  return !!(c.url && c.url.trim() && c.token && c.token.trim());
}

export class Paperless {
  private readonly urls: string[];
  private readonly token: string;
  private readonly timeout: number;

  constructor(cfg: PaperlessConfig) {
    if (!paperlessKonfiguriert(cfg)) {
      throw new PaperlessError('Paperless ist nicht eingerichtet (URL und API-Token in den Stammdaten).');
    }
    this.urls = cfg.url!.split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
    this.token = cfg.token!.trim().replace(/^Token\s+/i, '');
    this.timeout = cfg.timeoutMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Basis-URL und HTTP
  // -------------------------------------------------------------------------

  async baseUrl(): Promise<string> {
    if (this.urls.length === 1) return this.urls[0];
    const key = this.urls.join(',');
    const c = cache.get(key);
    if (c && c.until > Date.now()) return c.url;
    for (const u of this.urls) {
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

  private async liste(art: 'correspondents' | 'document_types' | 'storage_paths' | 'custom_fields' | 'tags') {
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

  async korrespondenten(): Promise<{ id: number; name: string }[]> {
    return this.liste('correspondents');
  }

  // -------------------------------------------------------------------------
  // Dokumente
  // -------------------------------------------------------------------------

  /** Datei hochladen – liefert die Task-UUID */
  async upload(pdf: Buffer, filename: string, meta: UploadMeta = {}): Promise<string> {
    const form = new FormData();
    form.append('document', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
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

  async dokument(id: number): Promise<Record<string, any>> {
    return this.json('GET', `api/documents/${id}/`);
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
        const f = (await this.liste('custom_fields')).find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
        if (!f) { warn.push(`Custom Field „${name}“ fehlt in Paperless`); continue; }
        let v: unknown = value;
        if (f.data_type === 'monetary' && typeof value === 'number') v = `EUR${value.toFixed(2)}`;
        neu.set(f.id, v);
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

  /** Freigabelinks eines Dokuments, jüngster zuerst; abgelaufene werden ausgelassen */
  async freigabelinks(id: number): Promise<string[]> {
    const base = await this.baseUrl();
    const r = await this.json<{ slug: string; expiration: string | null; created: string }[]>('GET', `api/documents/${id}/share_links/`);
    const now = Date.now();
    return (r ?? [])
      .filter((l) => !l.expiration || Date.parse(l.expiration) > now)
      .sort((a, b) => b.created.localeCompare(a.created))
      .map((l) => `${base}/share/${l.slug}`);
  }

  async freigabelinkAnlegen(id: number, tage = 30): Promise<string> {
    const base = await this.baseUrl();
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
