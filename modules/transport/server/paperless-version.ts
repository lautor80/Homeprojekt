import { PaperlessError, type Paperless } from '../../../server/src/lib/paperless.js';
import { duplikatVon } from './paperless-auftrag.js';

/**
 * Neudruck/erneuter Versand eines Belegs, der schon in Paperless liegt: neue Dateiversion am vorhandenen Dokument
 * (Paperless ≥ 3.0, update_version) statt eines zweiten Dokuments – wie bei den Hallenrechnungen von TC Oberthal.
 *
 * - version:      neue Version angelegt (versionId, falls Paperless sie schon gemeldet hat)
 * - unveraendert: Paperless lehnt die Datei als Dublette ab – die Datei ist identisch, das Dokument bleibt wie es ist
 * - neu:          kein Versionieren möglich (Dokument gelöscht oder Paperless ohne Versionen) → Aufrufer legt ein neues Dokument an
 * Andere Fehler (Paperless nicht erreichbar …) werden weitergereicht.
 */
export type VersionErgebnis = { art: 'version'; versionId: number | null } | { art: 'unveraendert' } | { art: 'neu'; grund: string };

/** Bezeichnung der Version in Paperless, z. B. „Neudruck 19.11.2026 18:05“ */
export function versionLabel(anlass: 'druck' | 'versand', jetzt = new Date()): string {
  const z = jetzt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  return `${anlass === 'druck' ? 'Neudruck' : 'Versand'} ${z}`;
}

export async function alsVersion(pl: Paperless, docId: number, pdf: Buffer, datei: string, label: string): Promise<VersionErgebnis> {
  try {
    const task = await pl.uploadVersion(docId, pdf, datei, label);
    return { art: 'version', versionId: await pl.warteAufDokument(task) };
  } catch (e) {
    if (!(e instanceof PaperlessError)) throw e;
    if (duplikatVon(e.message) !== null || /duplicate/i.test(e.message)) return { art: 'unveraendert' };
    if (e.status === 404 || e.status === 405) {
      // Dokument weg – oder Paperless kennt update_version noch nicht (vor 3.0)
      const da = await pl.dokument(docId).then(() => true, (x) => !(x instanceof PaperlessError && x.status === 404));
      return {
        art: 'neu',
        grund: da ? 'Paperless kennt noch keine Dateiversionen (ab Paperless 3.0) – neues Dokument angelegt'
          : `Paperless-Dokument ${docId} existiert nicht mehr – neues Dokument angelegt`,
      };
    }
    throw e;
  }
}
