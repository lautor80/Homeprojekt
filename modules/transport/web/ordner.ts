/**
 * Ablageordner auf diesem PC (#121): Ausdrucke und hineingezogene Dateien landen je Auftrag in
 *   <gewählter Ordner>/<Jahr>/<Auftragsnummer>/
 * und werden von dort geöffnet. Technik: File System Access API (Chrome, Edge). Der Ordner wird einmal
 * gewählt (Aufträge → Ablageordner oder Einstellungen); der Verweis liegt im Browser (IndexedDB) – je Benutzer, PC und
 * Browser, nicht auf dem Server. Wer noch keinen eigenen Ordner festgelegt hat, nutzt den bisher gemeinsamen des PCs.
 * Nach einem Browser-Neustart fragt der Browser beim ersten Klick einmal nach dem Zugriff.
 */

import { benutzerId } from '@core/session';
import { anzeigePfad, auftragsPfad, ORDNER_ALT, ordnerSchluessel, ordnerWahl, sauber } from './ordner-schluessel';

type Recht = 'granted' | 'denied' | 'prompt';
interface Ordner extends FileSystemDirectoryHandle {
  queryPermission(o: { mode: 'readwrite' }): Promise<Recht>;
  requestPermission(o: { mode: 'readwrite' }): Promise<Recht>;
  values(): AsyncIterableIterator<FileSystemHandle>;
}

const DB = 'portal-euroflex';
const STORE = 'ablage';
/** Schlüssel des angemeldeten Benutzers – jeder legt seinen eigenen Ordner fest */
const eigener = () => ordnerSchluessel(benutzerId());

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

async function gewaehlt(): Promise<{ ordner: Ordner | null; quelle: 'EIGEN' | 'GEMEINSAM' | 'KEINER' }> {
  if (!ordnerMoeglich) return { ordner: null, quelle: 'KEINER' };
  try {
    const eigen = await idb<Ordner | false | undefined>('readonly', (s) => s.get(eigener()));
    const gemeinsam = eigener() === ORDNER_ALT ? undefined : await idb<Ordner | undefined>('readonly', (s) => s.get(ORDNER_ALT));
    return ordnerWahl(eigen, gemeinsam || undefined);
  } catch { return { ordner: null, quelle: 'KEINER' }; }
}
const gespeichert = async (): Promise<Ordner | null> => (await gewaehlt()).ordner;

/** Ordner auswählen (nur nach Klick) und merken; liefert den Ordnernamen */
export async function ordnerWaehlen(): Promise<string> {
  const h = await (window as unknown as { showDirectoryPicker(o: object): Promise<Ordner> })
    .showDirectoryPicker({ id: 'euroflex-ablage', mode: 'readwrite' });
  await idb('readwrite', (s) => s.put(h, eigener()));
  return h.name;
}

/** Für diesen Benutzer keinen Ordner mehr verwenden – auch nicht den bisher gemeinsamen des PCs */
export async function ordnerEntfernen() {
  if (eigener() === ORDNER_ALT) await idb('readwrite', (s) => s.delete(ORDNER_ALT));
  else await idb('readwrite', (s) => s.put(false, eigener()));
}

/** Name des gewählten Ordners und ob gerade Zugriff besteht */
export async function ordnerStatus(): Promise<{ name: string; zugriff: boolean; /** noch der gemeinsame Ordner des PCs, kein eigener */ gemeinsam: boolean } | null> {
  const { ordner: h, quelle } = await gewaehlt();
  if (!h) return null;
  return { name: h.name, zugriff: (await h.queryPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted', gemeinsam: quelle === 'GEMEINSAM' };
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

export { anzeigePfad };

/** Ordner des Auftrags (wird bei Bedarf angelegt) */
export async function auftragsOrdner(nr: string, { anfordern = false, anlegen = true } = {}): Promise<{ basis: string; ordner: Ordner } | null> {
  const h = await ordnerBereit(anfordern);
  if (!h) return null;
  try {
    const [jahrName, auftragName] = auftragsPfad(nr);
    const jahr = await h.getDirectoryHandle(jahrName, { create: anlegen });
    return { basis: h.name, ordner: (await jahr.getDirectoryHandle(auftragName, { create: anlegen })) as Ordner };
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

/** Unterordner im Ordner des Auftrags, z. B. „Eingang“ für Dateien aus dem Posteingang */
export const UNTERORDNER_EINGANG = 'Eingang';

/**
 * Datei in einen Unterordner des Auftragsordners speichern (Unterordner wird angelegt). Gibt es dort schon eine Datei gleichen
 * Namens, wird nicht überschrieben, sondern „Name (2).pdf“, „Name (3).pdf“ … gewählt – zwei Mails können gleichnamige Anhänge
 * haben. Liefert den Anzeigepfad oder null (kein Ordner/kein Zugriff).
 */
export async function ablegenUnterordner(nr: string, unterordner: string, datei: string, inhalt: Blob, anfordern = false,
  /** true: unter genau diesem Namen speichern und eine vorhandene Datei ersetzen („Erneut ablegen“) */ ueberschreiben = false): Promise<string | null> {
  const o = await auftragsOrdner(nr, { anfordern });
  if (!o) return null;
  const u = await o.ordner.getDirectoryHandle(sauber(unterordner), { create: true });
  const name = ueberschreiben ? (sauber(datei) || 'Datei') : await freierName(u, sauber(datei) || 'Datei');
  const fh = await u.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(inhalt);
  await w.close();
  return `${anzeigePfad(o.basis, nr)}/${sauber(unterordner)}/${name}`;
}

/** „Scan.pdf“ → „Scan (2).pdf“, solange der Name im Ordner schon vergeben ist */
async function freierName(ordner: FileSystemDirectoryHandle, name: string): Promise<string> {
  const punkt = name.lastIndexOf('.');
  const stamm = punkt > 0 ? name.slice(0, punkt) : name;
  const endung = punkt > 0 ? name.slice(punkt) : '';
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? name : `${stamm} (${i})${endung}`;
    try { await ordner.getFileHandle(n); } catch { return n; }
  }
  return `${stamm} (${Date.now()})${endung}`;
}

/** Datei aus einem Unterordner des Auftragsordners lesen (z. B. Eingang/); null = nicht vorhanden oder kein Zugriff */
export async function dateiLesenUnterordner(nr: string, unterordner: string, datei: string, anfordern = false): Promise<File | null> {
  const o = await auftragsOrdner(nr, { anfordern, anlegen: false });
  if (!o) return null;
  try { return await (await (await o.ordner.getDirectoryHandle(sauber(unterordner))).getFileHandle(datei)).getFile(); } catch { return null; }
}

export interface OrdnerEintrag extends OrdnerDatei { /** Unterordner (leer = direkt im Auftragsordner) */ unterordner: string }

/** Alle Dateien des Auftragsordners samt Unterordnern (eine Ebene, z. B. Eingang/); null = kein Zugriff/kein Ordner gewählt */
export async function ordnerInhalt(nr: string, anfordern = false): Promise<{ basis: string; dateien: OrdnerEintrag[] } | null> {
  const h = await ordnerBereit(anfordern);
  if (!h) return null;
  const o = await auftragsOrdner(nr, { anlegen: false });
  if (!o) return { basis: h.name, dateien: [] };
  const dateien: OrdnerEintrag[] = [];
  const lesen = async (ordner: Ordner, unterordner: string) => {
    for await (const e of ordner.values()) {
      if (e.kind === 'file') {
        const f = await (e as FileSystemFileHandle).getFile();
        dateien.push({ name: f.name, groesse: f.size, geaendert: f.lastModified, unterordner });
      } else if (!unterordner) await lesen(e as Ordner, e.name);
    }
  };
  await lesen(o.ordner, '');
  return { basis: o.basis, dateien: dateien.sort((a, b) => a.unterordner.localeCompare(b.unterordner, 'de') || b.geaendert - a.geaendert) };
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

/**
 * Warum gerade nicht in den Ablageordner gespeichert werden kann – als Meldung für den Bildschirm; null = der Ordner ist
 * bereit. Ohne eigenes Paperless ist der Ablageordner die einzige Ablage der Ausdrucke: ein Druck, der dort nicht ankommt,
 * darf nicht still bleiben.
 */
export async function ordnerHindernis(): Promise<string | null> {
  if (!ordnerMoeglich) return 'Dieser Browser kann keine Ordner auf dem PC beschreiben – bitte Microsoft Edge oder Google Chrome verwenden.';
  const st = await ordnerStatus();
  if (!st) return 'Es ist kein Ablageordner festgelegt – bitte unter Aufträge → „Ablageordner“ einen Ordner wählen.';
  if (!st.zugriff) return `Der Zugriff auf den Ablageordner „${st.name}“ ist nicht erteilt – bitte unter Aufträge → „Ablageordner“ auf „Zugriff erlauben“ klicken.`;
  return null;
}

/**
 * Datei in die Ordner mehrerer Aufträge speichern (Sammelrechnung: in jeden). Liefert die gespeicherten Pfade und – wenn
 * etwas fehlt – eine Meldung, warum.
 */
export async function ablegenIn(nrs: string[], datei: string, inhalt: Blob): Promise<{ pfade: string[]; hinweis: string | null }> {
  const pfade: string[] = [];
  let fehler = '';
  for (const nr of nrs) {
    try { const p = await ablegen(nr, datei, inhalt); if (p) pfade.push(p); } catch (e) { fehler = (e as Error).message; }
  }
  if (pfade.length === nrs.length) return { pfade, hinweis: null };
  const grund = fehler || (await ordnerHindernis()) || 'Der Auftragsordner ließ sich nicht anlegen.';
  return { pfade, hinweis: `${datei} wurde ${pfade.length ? `nur in ${pfade.length} von ${nrs.length} Auftragsordnern` : 'nicht im Ablageordner'} gespeichert: ${grund}` };
}
