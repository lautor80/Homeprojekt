/**
 * Schlanker WebDAV-Client für die Nextcloud (Dateien hochladen, Ordner anlegen, auflisten, löschen).
 * Basis: https://<server>/remote.php/dav/files/<benutzer>/ – wird aus der Nextcloud-Adresse abgeleitet,
 * eine vollständige WebDAV-Adresse (…/remote.php/…) wird unverändert übernommen.
 * Anmeldung per Benutzer + App-Passwort (Basic Auth).
 */

export interface DavEintrag { name: string; ordner: boolean; groesse: number; geaendert: string | null }

export class WebDavFehler extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function davBasis(url: string, benutzer: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (/\/remote\.php\//.test(u)) return u;
  return `${u}/remote.php/dav/files/${encodeURIComponent(benutzer)}`;
}

const segmente = (pfad: string) => pfad.split('/').map((s) => s.trim()).filter(Boolean);

export class WebDav {
  private readonly basis: string;
  private readonly auth: string;
  constructor(url: string, benutzer: string, passwort: string, private readonly timeoutMs = 10 * 60_000) {
    this.basis = davBasis(url, benutzer);
    this.auth = `Basic ${Buffer.from(`${benutzer}:${passwort}`).toString('base64')}`;
  }

  url(pfad: string): string {
    return `${this.basis}/${segmente(pfad).map(encodeURIComponent).join('/')}`;
  }

  private async anfrage(methode: string, pfad: string, o: { body?: Buffer | string; headers?: Record<string, string>; ordner?: boolean } = {}) {
    let res: Response;
    try {
      res = await fetch(this.url(pfad) + (o.ordner ? '/' : ''), {
        method: methode, headers: { Authorization: this.auth, ...o.headers }, body: o.body as BodyInit | undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new WebDavFehler(`Nextcloud nicht erreichbar: ${(e as Error).message}`, 0);
    }
    if (res.status === 401) throw new WebDavFehler('Die Nextcloud hat die Anmeldung abgelehnt – Benutzer bzw. App-Passwort prüfen.', 401);
    return res;
  }

  /** Ordner (mit allen übergeordneten) anlegen; bestehende bleiben unverändert */
  async ordnerAnlegen(pfad: string) {
    let akt = '';
    for (const s of segmente(pfad)) {
      akt = `${akt}/${s}`;
      const r = await this.anfrage('MKCOL', akt, { ordner: true });
      if (![201, 405].includes(r.status)) throw new WebDavFehler(`Ordner ${akt} konnte nicht angelegt werden (HTTP ${r.status}).`, r.status);
    }
  }

  async hochladen(pfad: string, daten: Buffer) {
    const r = await this.anfrage('PUT', pfad, { body: daten, headers: { 'Content-Type': 'application/octet-stream' } });
    if (![200, 201, 204].includes(r.status)) {
      throw new WebDavFehler(r.status === 507 ? 'Kein Speicherplatz mehr in der Nextcloud (HTTP 507).' : `Upload fehlgeschlagen (HTTP ${r.status}).`, r.status);
    }
  }

  async liste(pfad: string): Promise<DavEintrag[]> {
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';
    const r = await this.anfrage('PROPFIND', pfad, { body, headers: { Depth: '1', 'Content-Type': 'application/xml' }, ordner: true });
    if (r.status === 404) throw new WebDavFehler(`Ordner ${pfad} existiert nicht.`, 404);
    if (r.status !== 207) throw new WebDavFehler(`Ordner ${pfad} konnte nicht gelesen werden (HTTP ${r.status}).`, r.status);
    return davAntwort(await r.text(), this.url(pfad));
  }

  async loeschen(pfad: string) {
    const r = await this.anfrage('DELETE', pfad);
    if (![200, 204, 404].includes(r.status)) throw new WebDavFehler(`${pfad} konnte nicht gelöscht werden (HTTP ${r.status}).`, r.status);
  }
}

/** PROPFIND-Antwort (Multistatus) auswerten; der Ordner selbst wird ausgelassen */
export function davAntwort(xml: string, ordnerUrl: string): DavEintrag[] {
  const tag = (block: string, name: string) => new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(block)?.[1]?.trim() ?? null;
  const eigenerPfad = decodeURIComponent(new URL(ordnerUrl).pathname).replace(/\/+$/, '');
  const out: DavEintrag[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const block = m[1];
    const href = tag(block, 'href');
    if (!href) continue;
    const pfad = decodeURIComponent(href.startsWith('http') ? new URL(href).pathname : href).replace(/\/+$/, '');
    if (pfad === eigenerPfad) continue;
    const ordner = /<(?:[\w-]+:)?collection\s*\/?>/i.test(tag(block, 'resourcetype') ?? '');
    const lm = tag(block, 'getlastmodified');
    out.push({ name: pfad.split('/').pop() ?? '', ordner, groesse: Number(tag(block, 'getcontentlength') ?? 0), geaendert: lm ? new Date(lm).toISOString() : null });
  }
  return out;
}
