/**
 * Ablageordner auf diesem PC (#121): Ausdrucke und hineingezogene Dateien landen je Auftrag in
 *   <gewählter Ordner>/<Jahr>/<Auftragsnummer>/
 * und werden von dort geöffnet. Technik: File System Access API (Chrome, Edge). Der Ordner wird einmal
 * in den Stammdaten gewählt; der Verweis liegt im Browser (IndexedDB) – je PC und Browser, nicht auf dem Server.
 * Nach einem Browser-Neustart fragt der Browser beim ersten Klick einmal nach dem Zugriff.
 */

type Recht = 'granted' | 'denied' | 'prompt';
interface Ordner extends FileSystemDirectoryHandle {
  queryPermission(o: { mode: 'readwrite' }): Promise<Recht>;
  requestPermission(o: { mode: 'readwrite' }): Promise<Recht>;
  values(): AsyncIterableIterator<FileSystemHandle>;
}

const DB = 'portal-euroflex';
const STORE = 'ablage';
const KEY = 'ordner';

export const ordnerMoeglich = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function db(): Promise<IDBDatabase> {
  return new Promise((ok, err) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => err(r.error);
  });
}
async function idb<T>(modus: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((ok, err) => {
    const r = f(d.transaction(STORE, modus).objectStore(STORE));
    r.onsuccess = () => ok(r.result as T);
    r.onerror = () => err(r.error);
  });
}

async function gespeichert(): Promise<Ordner | null> {
  if (!ordnerMoeglich) return null;
  try { return (await idb<Ordner | undefined>('readonly', (s) => s.get(KEY))) ?? null; } catch { return null; }
}

/** Ordner auswählen (nur nach Klick) und merken; liefert den Ordnernamen */
export async function ordnerWaehlen(): Promise<string> {
  const h = await (window as unknown as { showDirectoryPicker(o: object): Promise<Ordner> })
    .showDirectoryPicker({ id: 'euroflex-ablage', mode: 'readwrite' });
  await idb('readwrite', (s) => s.put(h, KEY));
  return h.name;
}

export async function ordnerEntfernen() {
  await idb('readwrite', (s) => s.delete(KEY));
}

/** Name des gewählten Ordners und ob gerade Zugriff besteht */
export async function ordnerStatus(): Promise<{ name: string; zugriff: boolean } | null> {
  const h = await gespeichert();
  if (!h) return null;
  return { name: h.name, zugriff: (await h.queryPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted' };
}

/**
 * Ordner mit Schreibrecht; `anfordern` nur direkt nach einem Klick (der Browser fragt dann ggf. nach).
 * null = kein Ordner gewählt, Browser kann es nicht oder Zugriff nicht erteilt.
 */
export async function ordnerBereit(anfordern = false): Promise<Ordner | null> {
  const h = await gespeichert();
  if (!h) return null;
  try {
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && anfordern) p = await h.requestPermission({ mode: 'readwrite' });
    return p === 'granted' ? h : null;
  } catch {
    return null;
  }
}

const sauber = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim();
const jahrVon = (nr: string) => (/^\d{4}/.test(nr) ? nr.slice(0, 4) : 'Sonstige');

/** Anzeigepfad, z. B. „Aufträge/2026/2026_1314/Rechnung_2026_6200.pdf“ */
export function anzeigePfad(basis: string, nr: string, datei?: string) {
  return [basis, jahrVon(nr), sauber(nr), datei ? sauber(datei) : ''].filter(Boolean).join('/');
}

/** Ordner des Auftrags (wird bei Bedarf angelegt) */
export async function auftragsOrdner(nr: string, { anfordern = false, anlegen = true } = {}): Promise<{ basis: string; ordner: Ordner } | null> {
  const h = await ordnerBereit(anfordern);
  if (!h) return null;
  try {
    const jahr = await h.getDirectoryHandle(jahrVon(nr), { create: anlegen });
    return { basis: h.name, ordner: (await jahr.getDirectoryHandle(sauber(nr), { create: anlegen })) as Ordner };
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError') return null;
    throw e;
  }
}

/** Datei im Ordner des Auftrags speichern (überschreibt gleichnamige); liefert den Anzeigepfad oder null */
export async function ablegen(nr: string, datei: string, inhalt: Blob, anfordern = false): Promise<string | null> {
  const o = await auftragsOrdner(nr, { anfordern });
  if (!o) return null;
  const fh = await o.ordner.getFileHandle(sauber(datei), { create: true });
  const w = await fh.createWritable();
  await w.write(inhalt);
  await w.close();
  return anzeigePfad(o.basis, nr, datei);
}

/** Datei aus dem Ordner des Auftrags lesen */
export async function dateiLesen(nr: string, datei: string): Promise<File | null> {
  const o = await auftragsOrdner(nr, { anlegen: false });
  if (!o) return null;
  try { return await (await o.ordner.getFileHandle(sauber(datei))).getFile(); } catch { return null; }
}

export interface OrdnerDatei { name: string; groesse: number; geaendert: number }

/** Dateien im Ordner des Auftrags, neueste zuerst; null = kein Zugriff/kein Ordner gewählt */
export async function dateienImOrdner(nr: string): Promise<{ basis: string; dateien: OrdnerDatei[] } | null> {
  const h = await ordnerBereit(false);
  if (!h) return null;
  const o = await auftragsOrdner(nr, { anlegen: false });
  if (!o) return { basis: h.name, dateien: [] };
  const dateien: OrdnerDatei[] = [];
  for await (const e of o.ordner.values()) {
    if (e.kind !== 'file') continue;
    const f = await (e as FileSystemFileHandle).getFile();
    dateien.push({ name: f.name, groesse: f.size, geaendert: f.lastModified });
  }
  return { basis: o.basis, dateien: dateien.sort((a, b) => b.geaendert - a.geaendert) };
}
