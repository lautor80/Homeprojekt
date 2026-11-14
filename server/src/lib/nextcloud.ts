/**
 * Nextcloud: ein Zugang für das ganze Portal (#232, S2) – Anbindung „nextcloud“ unter Administration → Schnittstellen →
 * Nextcloud. Die Sicherung (täglicher Export) und die Dokumentenablage des Vereins lesen beide diesen einen Zugang;
 * ein geändertes App-Passwort wird nur noch an einer Stelle eingetragen. Was sie dort tun (Ordner, Uhrzeit), steht
 * weiter bei der jeweiligen Funktion.
 */
import type { Tx } from '../db.js';
import { verbindungLesen, verbindungSpeichern, type VerbindungDef } from './verbindungen.js';
import { WebDav } from './webdav.js';

export const NEXTCLOUD_ID = 'nextcloud';

export const NEXTCLOUD_DEF: VerbindungDef = {
  id: NEXTCLOUD_ID, text: 'Nextcloud', reiter: 'Nextcloud',
  beschreibung: 'Ein Zugang für alles, was das Portal in der Nextcloud ablegt (WebDAV): die tägliche Sicherung (Administration → System → Sicherung) und die Arbeitsablage des Dokumenteneingangs. '
    + 'Anmeldung mit Benutzer und App-Passwort (Nextcloud → Einstellungen → Sicherheit). Ordner, Uhrzeit und Aufbewahrung stehen bei der jeweiligen Funktion.',
  auth: ['basic'],
  felder: { url: 'Adresse der Nextcloud (z. B. https://cloud.example.org)', auth_user: 'Benutzer', geheimnis: 'App-Passwort' },
  pruefen: async (v) => {
    if (!v.url || !v.auth_user || !v.geheimnis) return { ok: false, text: 'Adresse, Benutzer und App-Passwort fehlen.' };
    const eintraege = await new WebDav(v.url, v.auth_user, v.geheimnis, 20_000).liste('');
    return { ok: true, text: `Verbunden: ${eintraege.length} Einträge im Hauptordner von ${v.auth_user}.` };
  },
};

export interface NextcloudZugang { url: string; benutzer: string; passwort: string }

export async function nextcloudZugang(db?: Tx): Promise<NextcloudZugang> {
  const v = await verbindungLesen(NEXTCLOUD_ID, db);
  return { url: v.url, benutzer: v.auth_user ?? '', passwort: v.geheimnis ?? '' };
}

/** Zugang sichern – z. B. wenn er beim Einrichten der Sicherung eingegeben wird; weitere Einstellungen der Anbindung bleiben */
export async function nextcloudZugangSpeichern(tx: Tx, z: NextcloudZugang, wer: string): Promise<void> {
  const alt = await verbindungLesen(NEXTCLOUD_ID, tx);
  await verbindungSpeichern(tx, {
    id: NEXTCLOUD_ID, url: z.url.trim(), auth_art: 'basic', auth_user: z.benutzer.trim() || null, header_name: null, geheimnis: z.passwort || null, einstellungen: alt.einstellungen ?? {},
  }, wer);
}
