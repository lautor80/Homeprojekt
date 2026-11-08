import type { FastifyBaseLogger } from 'fastify';
import { sql, type Tx } from './db.js';
import { BusinessError } from './errors.js';
import { dateiAsync, dateiname, schaetzung, sichern, speichern, type Dateiformat } from './backup.js';
import { laufend, starten, type Job, type Phase } from './backup-job.js';
import { WebDav, WebDavFehler } from './lib/webdav.js';

/**
 * Täglicher Export einer vollständigen Portal-Sicherung in einen festen Nextcloud-Ordner (WebDAV).
 * Läuft einmal am Tag ab der eingestellten Uhrzeit (Zeitzone des Servers, Europe/Berlin), löscht
 * danach automatische Sicherungen im Zielordner, die älter als die Aufbewahrungsdauer sind.
 * Ergebnis und Fehler stehen in core.backup_export (Anzeige in Administration → Sicherung und im Arbeitsvorrat).
 */

export interface ExportCfg {
  aktiv: boolean; url: string; benutzer: string; passwort: string; ordner: string; uhrzeit: string; format: Dateiformat;
  datei_passwort: string; mit_aenderungsbelegen: boolean; aufbewahrung_tage: number;
}
export interface ExportStatus { letzter_lauf: string | null; letzter_erfolg: string | null; letzte_meldung: string | null; letzte_datei: string | null; letzte_dauer_s: number | null; letzter_fehler: boolean }

export async function cfgLesen(db: Tx = sql as unknown as Tx): Promise<ExportCfg & ExportStatus> {
  const [c] = await db`select aktiv, url, benutzer, passwort, ordner, uhrzeit, format, datei_passwort, mit_aenderungsbelegen, aufbewahrung_tage,
                              letzter_lauf, letzter_erfolg, letzte_meldung, letzte_datei, letzte_dauer_s, letzter_fehler
                         from core.backup_export where id = 1`;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return { ...(c as unknown as ExportCfg & ExportStatus), letzter_lauf: iso(c?.letzter_lauf), letzter_erfolg: iso(c?.letzter_erfolg) };
}

export function cfgPruefen(c: ExportCfg): string[] {
  const f: string[] = [];
  if (!/^https?:\/\/\S+$/i.test(c.url.trim())) f.push('Nextcloud-Adresse (https://…)');
  if (!c.benutzer.trim()) f.push('Benutzer');
  if (!c.passwort) f.push('App-Passwort');
  if (!c.ordner.trim() || c.ordner.includes('..')) f.push('Zielordner');
  if (c.format === 'portal' && c.datei_passwort && c.datei_passwort.length < 8) f.push('Datei-Passwort (mindestens 8 Zeichen)');
  return f;
}

const dav = (c: ExportCfg) => new WebDav(c.url, c.benutzer.trim(), c.passwort);
/** automatisch erzeugte Sicherungen im Zielordner (nur diese werden aufgeräumt) */
export const AUTO = /^portal_\d{4}-\d{2}-\d{2}_\d{6}_automatisch(?:_\d+)?\.(portal|zip)$/;

/** Verbindung prüfen: Ordner anlegen (falls nötig) und auflisten */
export async function verbindungTesten(c: ExportCfg) {
  const fehlt = cfgPruefen(c);
  if (fehlt.length) throw new BusinessError(`Bitte ergänzen: ${fehlt.join(', ')}.`);
  const d = dav(c);
  try {
    await d.ordnerAnlegen(c.ordner);
    const l = await d.liste(c.ordner);
    const auto = l.filter((e) => !e.ordner && AUTO.test(e.name));
    return { text: `Verbunden. Zielordner ${c.ordner} ist erreichbar (${l.length} Einträge, davon ${auto.length} automatische Sicherung(en)).` };
  } catch (e) {
    if (e instanceof WebDavFehler) throw new BusinessError(e.message);
    throw e;
  }
}

async function statusSetzen(s: Partial<ExportStatus>) {
  await sql`update core.backup_export set letzter_lauf = coalesce(${s.letzter_lauf ?? null}::timestamptz, letzter_lauf),
                                         letzter_erfolg = coalesce(${s.letzter_erfolg ?? null}::timestamptz, letzter_erfolg),
                                         letzte_meldung = ${s.letzte_meldung ?? null}, letzte_datei = coalesce(${s.letzte_datei ?? null}, letzte_datei),
                                         letzte_dauer_s = ${s.letzte_dauer_s ?? null}, letzter_fehler = ${s.letzter_fehler ?? false}
             where id = 1`;
}

/** Sicherung erzeugen, hochladen, alte automatische Sicherungen im Zielordner löschen */
export async function exportAusfuehren(c: ExportCfg, von: string, setze: (p: Phase, teil?: number, detail?: string) => void) {
  const fehlt = cfgPruefen(c);
  if (fehlt.length) throw new BusinessError(`Nextcloud-Export unvollständig eingerichtet: ${fehlt.join(', ')}.`);
  const start = Date.now();
  await statusSetzen({ letzter_lauf: new Date().toISOString(), letzte_meldung: 'läuft …' });
  try {
    const gesamt = Math.max(1, await schaetzung({ mitAenderungsbelegen: c.mit_aenderungsbelegen }));
    setze('lesen', 0);
    const inhalt = await sichern({
      mitAenderungsbelegen: c.mit_aenderungsbelegen, von, art: 'automatisch', notiz: `Nextcloud-Export nach ${c.ordner}`,
      fortschritt: (f) => setze('lesen', Math.min(0.99, f.zeilen / gesamt), `Tabelle ${f.nr} von ${f.anzahl}: ${f.tabelle}`),
    });
    setze('packen', 0.1, c.format === 'zip' ? 'ZIP mit XML' : c.datei_passwort ? 'komprimiert und verschlüsselt' : 'komprimiert');
    const pw = c.format === 'portal' ? c.datei_passwort || null : null;
    const b = await dateiAsync(inhalt, c.format, pw);
    const name = dateiname(inhalt.manifest, c.format);
    setze('hochladen', 0.1, `${name} (${(b.length / 1024 / 1024).toFixed(1)} MB)`);
    const d = dav(c);
    await d.ordnerAnlegen(c.ordner);
    await d.hochladen(`${c.ordner}/${name}`, b);
    setze('aufraeumen', 0.2);
    let geloescht = 0;
    if (c.aufbewahrung_tage > 0) {
      const grenze = Date.now() - c.aufbewahrung_tage * 86_400_000;
      for (const e of await d.liste(c.ordner)) {
        if (e.ordner || !AUTO.test(e.name) || e.name === name || !e.geaendert || new Date(e.geaendert).getTime() >= grenze) continue;
        await d.loeschen(`${c.ordner}/${e.name}`);
        geloescht++;
      }
    }
    const dauer = Math.round((Date.now() - start) / 1000);
    const zeilen = inhalt.manifest.tabellen.reduce((s, t) => s + t.zeilen, 0);
    const text = `${name} nach ${c.ordner} hochgeladen (${(b.length / 1024 / 1024).toFixed(1)} MB, ${zeilen.toLocaleString('de-DE')} Datensätze${pw ? ', verschlüsselt' : ''}, ${dauer} s)`
      + (geloescht ? `, ${geloescht} ältere Sicherung(en) gelöscht.` : '.');
    await statusSetzen({ letzter_erfolg: new Date().toISOString(), letzte_meldung: text, letzte_datei: name, letzte_dauer_s: dauer, letzter_fehler: false });
    return { name, groesse: b.length, geloescht, text };
  } catch (e) {
    const text = e instanceof WebDavFehler || e instanceof BusinessError ? e.message : `Unerwarteter Fehler: ${(e as Error).message}`;
    await statusSetzen({ letzte_meldung: text, letzte_dauer_s: Math.round((Date.now() - start) / 1000), letzter_fehler: true }).catch(() => undefined);
    throw new BusinessError(text);
  }
}

/** Export als Hintergrundauftrag (mit Fortschritt) */
export const exportStarten = (c: ExportCfg, von: string): Job => starten('nextcloud', von, (setze) => exportAusfuehren(c, von, setze));

/** Manuelle Sicherung als Hintergrundauftrag (mit Fortschritt), Ablage im Sicherungsordner */
export function sicherungStarten(o: { schemas: string[]; mitAenderungsbelegen: boolean; notiz: string; format: Dateiformat; passwort: string | null }, von: string): Job {
  return starten('sicherung', von, async (setze) => {
    const gesamt = Math.max(1, await schaetzung(o));
    setze('lesen', 0);
    const inhalt = await sichern({
      schemas: o.schemas, mitAenderungsbelegen: o.mitAenderungsbelegen, von, notiz: o.notiz,
      fortschritt: (f) => setze('lesen', Math.min(0.99, f.zeilen / gesamt), `Tabelle ${f.nr} von ${f.anzahl}: ${f.tabelle}`),
    });
    setze('packen', 0.1, o.format === 'zip' ? 'ZIP mit XML' : o.passwort ? 'komprimiert und verschlüsselt' : 'komprimiert');
    const b = await dateiAsync(inhalt, o.format, o.passwort);
    setze('speichern', 0.5);
    const r = await speichern(inhalt, o.passwort, o.format, b);
    const zeilen = inhalt.manifest.tabellen.reduce((s, t) => s + t.zeilen, 0);
    return {
      ...r,
      text: `Sicherung erstellt: ${inhalt.manifest.schemas.length} Bereich(e), ${inhalt.manifest.tabellen.length} Tabellen, ${zeilen.toLocaleString('de-DE')} Datensätze${o.passwort ? ', verschlüsselt' : ''}${o.format === 'zip' ? ', als ZIP mit XML' : ''}.`
        + (r.dauerhaft ? '' : ' Achtung: Der Sicherungsordner ist nicht dauerhaft – bitte die Datei herunterladen.'),
    };
  });
}

// ---------------------------------------------------------------- Zeitplan
const lokal = (d: Date) => ({ datum: d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }), zeit: d.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }) });

/** fällig: aktiv, Uhrzeit erreicht und heute noch nicht gelaufen */
export function faellig(c: ExportCfg & ExportStatus, jetzt = new Date()): boolean {
  if (!c.aktiv || cfgPruefen(c).length) return false;
  const h = lokal(jetzt);
  if (h.zeit < c.uhrzeit) return false;
  return !c.letzter_lauf || lokal(new Date(c.letzter_lauf)).datum !== h.datum;
}

let planer: ReturnType<typeof setInterval> | null = null;

/** jede Minute prüfen, ob der tägliche Export fällig ist (nur im Server-Prozess, nicht in Tests) */
export function planerStarten(log: FastifyBaseLogger) {
  if (planer) return;
  const pruefen = async () => {
    try {
      const c = await cfgLesen();
      if (!faellig(c) || laufend()) return;
      // mehrere Instanzen: den Tageslauf atomar beanspruchen – nur eine exportiert
      const heute = lokal(new Date()).datum;
      const [frei] = await sql`update core.backup_export set letzter_lauf = now()
                                where id = 1 and (letzter_lauf is null or (letzter_lauf at time zone 'Europe/Berlin')::date <> ${heute}::date)
                                returning id`;
      if (!frei) return;
      log.info('Täglicher Nextcloud-Export startet');
      const j = exportStarten(c, 'system (täglicher Nextcloud-Export)');
      while (!(j.phase === 'fertig' || j.phase === 'fehler')) await new Promise((r) => setTimeout(r, 2000));
      if (j.fehler) log.warn({ fehler: j.fehler }, 'Nextcloud-Export fehlgeschlagen'); else log.info(j.ergebnis, 'Nextcloud-Export fertig');
    } catch (e) {
      // z. B. läuft gerade eine manuelle Sicherung – beim nächsten Durchlauf erneut versuchen
      if (!(e instanceof BusinessError)) log.warn(e, 'Prüfung Nextcloud-Export fehlgeschlagen');
    }
  };
  planer = setInterval(pruefen, 60_000);
  planer.unref();
}
