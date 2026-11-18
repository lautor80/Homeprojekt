import { nachablageDokumente, type NachablageArt, type NachablageZeile } from './nachablage-dokumente';
import { ablegenIn, dateiLesen, ordnerBereit, ordnerHindernis } from './ordner';
import { eingangInOrdner, uebernahmeText, LEER, type UebernahmeErgebnis } from './eingang/uebernahme';
import type { Doc } from './dialogs';

/**
 * Aufträge → „Neu ablegen“: markierte Aufträge noch einmal drucken und im Ablageordner speichern
 * (<Ordner>/<Jahr>/<Auftrag>/ – wird angelegt): Transportauftrag (je Fahrt) und Lieferschein bzw. die Rechnung (Sammelrechnung in
 * den Ordner jedes ihrer Aufträge). Dabei werden die per E-Mail zugeordneten Belege des Posteingangs nachgezogen (Eingang/):
 * wartende übernommen, Paperless-Belege nachgeladen, übernommene geprüft. Liefert die gespeicherten PDFs zur Vorschau (lokal).
 */
export { nachablageDokumente, type NachablageArt, type NachablageZeile };

export interface NachablageErgebnis { gespeichert: number; pdfs: number; vorschau: Doc[]; meldungen: string[]; eingang: UebernahmeErgebnis }

export async function nachAblegen(sel: NachablageZeile[], alle: NachablageZeile[], art: NachablageArt, o: { eingang: boolean; schritt?: (t: string) => void }): Promise<NachablageErgebnis> {
  // Zugriff jetzt erfragen (der Klick erlaubt die Rückfrage des Browsers); ohne Ordner geht nichts
  if (!(await ordnerBereit(true))) throw new Error((await ordnerHindernis()) ?? 'Kein Zugriff auf den Ablageordner.');
  const docs = nachablageDokumente(sel, alle, art);
  const erg: NachablageErgebnis = { gespeichert: 0, pdfs: docs.length, vorschau: [], meldungen: [], eingang: { ...LEER, fehlt: [], fehler: [] } };
  for (const [i, d] of docs.entries()) {
    o.schritt?.(`${d.filename} (${i + 1}/${docs.length})`);
    try {
      const res = await fetch(d.url, { credentials: 'same-origin' });
      if (!res.ok) {
        const t = await res.text();
        throw new Error((() => { try { return JSON.parse(t).message as string; } catch { return null; } })() ?? `Fehler ${res.status}`);
      }
      const b = await res.blob();
      const { pfade, hinweis } = await ablegenIn(d.ablage, d.filename, b);
      if (hinweis) erg.meldungen.push(hinweis);
      if (pfade.length) erg.gespeichert++;
      const f = pfade.length ? await dateiLesen(d.ablage[0], d.filename) : null;
      erg.vorschau.push({ url: URL.createObjectURL(f ?? b), filename: d.filename, lokal: true });
    } catch (e) { erg.meldungen.push(`${d.filename}: ${(e as Error).message}`); }
  }
  if (o.eingang) {
    for (const s of sel) {
      o.schritt?.(`E-Mail-Belege ${s.auftragsnr}`);
      try {
        const e = await eingangInOrdner(s.auftragsnr, null, { paperless: true, pruefen: true });
        erg.eingang.uebernommen += e.uebernommen; erg.eingang.paperless += e.paperless; erg.eingang.vorhanden += e.vorhanden;
        const t = uebernahmeText({ ...e, uebernommen: 0, paperless: 0 }, s.auftragsnr);
        if (t) erg.meldungen.push(t);
      } catch (e) {
        // ohne Recht auf den Posteingang (403) still überspringen
        if (!/403|Berechtigung|nicht berechtigt/i.test((e as Error).message)) erg.meldungen.push(`${s.auftragsnr}: E-Mail-Belege – ${(e as Error).message}`);
      }
    }
  }
  return erg;
}
