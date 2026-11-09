/**
 * Schlanker WebDAV-Client für die Nextcloud (Dateien hochladen, Ordner anlegen, auflisten, löschen).
 * Basis: https://<server>/remote.php/dav/files/<benutzer>/ – wird aus der Nextcloud-Adresse abgeleitet,
 * eine vollständige WebDAV-Adresse (…/remote.php/…) wird unverändert übernommen.
 * Auch eine aus dem Browser kopierte Adresse der Dateien-App (…/index.php/apps/files/…?dir=…) wird auf die
 * Nextcloud-Adresse gekürzt. Anmeldung per Benutzer + App-Passwort (Basic Auth).
 * Uploads werden bei vorübergehenden Störungen (Netz, 423 gesperrt, 429, 502–504) bis zu dreimal versucht.
 */

export interface DavEintrag { name: string; ordner: boolean; groesse: number; geaendert: string | null }

export class WebDavFehler extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function davBasis(url: string, benutzer: string): string {
  let u = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (/\/remote\.php\//.test(u)) return u;
  // aus dem Browser kopiert: https://cloud…/index.php/apps/files/… bzw. …/apps/files/… → nur die Nextcloud-Adresse
  u = u.replace(/\/(index\.php|apps\/files)(\/.*)?$/, '');
  return `${u}/remote.php/dav/files/${encodeURIComponent(benutzer)}`;
}

const segmente = (pfad: string) => pfad.split('/').map((s) => s.trim()).filter(Boolean);
/** vorübergehende Störungen, bei denen ein erneuter Versuch sinnvoll ist (0 = Netz/Zeitüberschreitung) */
const VORUEBERGEHEND = new Set([0, 423, 429, 502, 503, 504]);
const warten = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export class WebDav {
  private readonly basis: string;
  private readonly auth: string;
  constructor(url: string, benutzer: string, passwort: string, private readonly timeoutMs = 10 * 60_000, private readonly pauseMs = 1500) {
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

  /** Ordner (mit allen übergeordneten) anlegen; bestehende bleiben unverändert. Ergebnis: letzter Ordner neu angelegt? */
  async ordnerAnlegen(pfad: string): Promise<boolean> {
    let akt = '';
    let neu = false;
    for (const s of segmente(pfad)) {
      akt = `${akt}/${s}`;
      const r = await this.anfrage('MKCOL', akt, { ordner: true });
      if (![201, 405].includes(r.status)) throw new WebDavFehler(`Ordner ${akt} konnte nicht angelegt werden (HTTP ${r.status}).`, r.status);
      neu = r.status === 201;
    }
    return neu;
  }

  /** Datei hochladen (ersetzt eine vorhandene); bei vorübergehenden Störungen bis zu `versuche` Anläufe */
  async hochladen(pfad: string, daten: Buffer, versuche = 3) {
    for (let v = 1; ; v++) {
      try {
        const r = await this.anfrage('PUT', pfad, { body: daten, headers: { 'Content-Type': 'application/octet-stream' } });
        if ([200, 201, 204].includes(r.status)) return;
        throw new WebDavFehler(
          r.status === 507 ? 'Kein Speicherplatz mehr in der Nextcloud (HTTP 507).'
            : r.status === 413 ? `Die Datei ${segmente(pfad).pop()} (${(daten.length / 1024 / 1024).toFixed(1)} MB) ist für die Nextcloud bzw. den vorgeschalteten Proxy zu groß (HTTP 413).`
              : `Upload von ${segmente(pfad).pop()} fehlgeschlagen (HTTP ${r.status}).`, r.status);
      } catch (e) {
        if (!(e instanceof WebDavFehler) || !VORUEBERGEHEND.has(e.status) || v >= versuche) throw e;
        await warten(this.pauseMs * v);
      }
    }
  }

  async liste(pfad: string): Promise<DavEintrag[]> {
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';
    const r = await this.anfrage('PROPFIND', pfad, { body, headers: { Depth: '1', 'Content-Type': 'application/xml' }, ordner: true });
    if (r.status === 404) throw new WebDavFehler(`Ordner ${pfad} existiert nicht.`, 404);
    if (r.status !== 207) throw new WebDavFehler(`Ordner ${pfad} konnte nicht gelesen werden (HTTP ${r.status}).`, r.status);
    return davAntwort(await r.text(), this.url(pfad));
  }

  /** Datei oder (mit `ordner`) Ordner samt Inhalt löschen */
  async loeschen(pfad: string, ordner = false) {
    const r = await this.anfrage('DELETE', pfad, { ordner });
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
