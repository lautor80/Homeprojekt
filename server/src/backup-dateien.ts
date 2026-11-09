import crypto from 'node:crypto';
import { BusinessError } from './errors.js';
import { LIESMICH_ORDNER, manifestXml, tabelleXml, tabellenDatei, type XmlManifest } from './backup-xml.js';
import type { WebDav } from './lib/webdav.js';

/**
 * Dateiweise Übertragung einer Sicherung per WebDAV – ohne ZIP (Nextcloud-Export, Format „Einzelne XML-Dateien“).
 *
 * Je Lauf entsteht im Zielordner ein eigener Ordner (z. B. portal_2026-11-09_023000_automatisch) mit demselben
 * Aufbau wie das ZIP/XML-Format:
 *   daten/<bereich>/<tabelle>.xml   je Tabelle eine Datei, einzeln hochgeladen
 *   LIESMICH.txt, pruefsummen.sha256
 *   manifest.xml                    als LETZTE Datei – erst mit ihr gilt die Sicherung als vollständig
 * Nach dem Upload wird jeder Ordner aufgelistet und die Größe jeder Datei mit dem gesendeten Stand verglichen.
 * Schlägt etwas fehl, wird der in diesem Lauf angelegte Ordner wieder entfernt (kein halber Stand im Ziel).
 * Zurücksichern: Ordner als ZIP herunterladen und im Portal hochladen (manifest.xml darf in einem Unterordner liegen).
 */

export interface Uebertragen { ordner: string; dateien: number; bytes: number }
type Melde = (teil: number, detail: string) => void;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Größen im Ziel mit dem gesendeten Stand vergleichen (je Ordner eine Abfrage) */
export async function uebertragungPruefen(d: WebDav, wurzel: string, soll: Map<string, number>): Promise<void> {
  const jeOrdner = new Map<string, Map<string, number>>();
  for (const [pfad, groesse] of soll) {
    const i = pfad.lastIndexOf('/');
    const ordner = i < 0 ? '' : pfad.slice(0, i);
    if (!jeOrdner.has(ordner)) jeOrdner.set(ordner, new Map());
    jeOrdner.get(ordner)!.set(pfad.slice(i + 1), groesse);
  }
  const fehler: string[] = [];
  for (const [ordner, dateien] of jeOrdner) {
    const ist = new Map((await d.liste(ordner ? `${wurzel}/${ordner}` : wurzel)).filter((e) => !e.ordner).map((e) => [e.name, e.groesse]));
    for (const [name, groesse] of dateien) {
      const pfad = ordner ? `${ordner}/${name}` : name;
      if (!ist.has(name)) fehler.push(`${pfad} fehlt`);
      else if (ist.get(name) !== groesse) fehler.push(`${pfad}: ${ist.get(name)} statt ${groesse} Bytes`);
    }
  }
  if (fehler.length) {
    throw new BusinessError(`Die Übertragung in die Nextcloud ist unvollständig (${fehler.length} von ${soll.size} Dateien): ${fehler.slice(0, 5).join('; ')}${fehler.length > 5 ? ' …' : ''}`);
  }
}

/**
 * Sicherung dateiweise nach `<ziel>/<name>/` übertragen und prüfen.
 * `melde` bekommt den Fortschritt 0..1 (nach Datenmenge) und die aktuelle Datei.
 */
export async function dateienUebertragen(
  d: WebDav, ziel: string, name: string, inhalt: { manifest: XmlManifest; daten: Record<string, string> },
  melde: { hochladen: Melde; pruefen: Melde },
): Promise<Uebertragen> {
  const m = inhalt.manifest;
  await d.ordnerAnlegen(ziel);
  // eigener Ordner je Lauf – nie in einen vorhandenen schreiben
  let ordner = name;
  let neu = await d.ordnerAnlegen(`${ziel}/${ordner}`);
  for (let i = 2; !neu && i < 50; i++) { ordner = `${name}_${i}`; neu = await d.ordnerAnlegen(`${ziel}/${ordner}`); }
  if (!neu) throw new BusinessError(`Im Zielordner ${ziel} konnte kein neuer Ordner für die Sicherung angelegt werden.`);
  const wurzel = `${ziel}/${ordner}`;

  try {
    const soll = new Map<string, number>();
    const summen: string[] = [];
    const angelegt = new Set<string>();
    let bytes = 0;
    const sende = async (pfad: string, daten: Buffer) => {
      const i = pfad.lastIndexOf('/');
      const unter = i < 0 ? '' : pfad.slice(0, i);
      if (unter && !angelegt.has(unter)) { await d.ordnerAnlegen(`${wurzel}/${unter}`); angelegt.add(unter); }
      await d.hochladen(`${wurzel}/${pfad}`, daten);
      soll.set(pfad, daten.length);
      summen.push(`${crypto.createHash('sha256').update(daten).digest('hex')}  ${pfad}`);
      bytes += daten.length;
    };

    // 1. je Tabelle eine XML-Datei – einzeln erzeugt und sofort übertragen (kein großes Archiv im Speicher)
    const gesamt = Math.max(1, m.tabellen.reduce((s, t) => s + (inhalt.daten[t.name]?.length ?? 0), 0));
    let erledigt = 0;
    for (const [nr, t] of m.tabellen.entries()) {
      const pfad = tabellenDatei(t.name);
      melde.hochladen(erledigt / gesamt, `Datei ${nr + 1} von ${m.tabellen.length}: ${pfad}`);
      // dem Server zwischen zwei Tabellen Luft lassen (XML-Erzeugung läuft synchron)
      await new Promise((ok) => setImmediate(ok));
      const text = inhalt.daten[t.name] ?? '';
      await sende(pfad, Buffer.from(tabelleXml(t.name, t.spalten, text), 'utf8'));
      erledigt += text.length;
    }
    // 2. Begleitdateien; das Manifest zuletzt – es kennzeichnet die vollständige Sicherung
    melde.hochladen(1, 'LIESMICH.txt, pruefsummen.sha256, manifest.xml');
    await sende('LIESMICH.txt', Buffer.from(LIESMICH_ORDNER, 'utf8'));
    const manifest = Buffer.from(manifestXml(m), 'utf8');
    summen.push(`${crypto.createHash('sha256').update(manifest).digest('hex')}  manifest.xml`);
    const pruefsummen = Buffer.from(`${summen.join('\n')}\n`, 'utf8');
    await d.hochladen(`${wurzel}/pruefsummen.sha256`, pruefsummen);
    soll.set('pruefsummen.sha256', pruefsummen.length);
    bytes += pruefsummen.length;
    await d.hochladen(`${wurzel}/manifest.xml`, manifest);
    soll.set('manifest.xml', manifest.length);
    bytes += manifest.length;

    // 3. prüfen: jede Datei ist mit der gesendeten Größe im Ziel angekommen
    melde.pruefen(0.2, `${soll.size} Dateien (${mb(bytes)})`);
    await uebertragungPruefen(d, wurzel, soll);
    return { ordner, dateien: soll.size, bytes };
  } catch (e) {
    // keinen halben Stand im Ziel lassen (der Ordner wurde in diesem Lauf angelegt)
    await d.loeschen(wurzel, true).catch(() => undefined);
    throw e;
  }
}
