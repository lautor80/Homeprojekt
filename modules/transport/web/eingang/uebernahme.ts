import { api } from '@core/api';
import { T } from '../util';
import { ablegenUnterordner, dateiLesenUnterordner, UNTERORDNER_EINGANG } from '../ordner';
import { eingangName } from '../ordner-schluessel';
import { dateiUrl, liste, type AuftragEingangDokument } from './typen';

/**
 * Belege aus dem Posteingang in den Ablageordner des Auftrags (<Ordner>/<Jahr>/<Auftrag>/Eingang/) bringen – gemeinsam für
 * Auftrag → Dokumente, Auftragsliste („Neu ablegen“) und Posteingang („In Auftragsordner übertragen“):
 *  - wartet (Ablageziel lokal): Inhalt vom Portal laden, in Eingang/ schreiben, Übernahme mit Dateinamen melden (Portal löscht den Inhalt)
 *  - abgelegt in Paperless (optional): fehlt die Datei in Eingang/, aus Paperless nachladen
 *  - übernommen (optional pruefen): prüfen, ob die Datei noch in Eingang/ liegt; fehlende werden gemeldet
 *  - übernommen (optional erneut, „Erneut ablegen“): liegt der Inhalt noch im Portal (Aufbewahrung nach der Übernahme), wird die
 *    Datei unter ihrem Namen neu in Eingang/ geschrieben (Ordner wird angelegt); sonst wie pruefen
 * Rechte: Laden wartender Inhalte transport.eingang:edit, Melden transport.auftraege:edit.
 */
export interface UebernahmeErgebnis {
  /** neu nach Eingang/ geschrieben (aus dem Portal bzw. aus Paperless) */
  uebernommen: number;
  /** schon übernommene, aus der Aufbewahrung erneut geschrieben */
  erneut: number;
  paperless: number;
  /** schon vorhanden (geprüft) */
  vorhanden: number;
  /** übernommen, aber nicht (mehr) im Ordner – nicht wiederherstellbar */
  fehlt: string[];
  fehler: string[];
}

export const LEER: UebernahmeErgebnis = { uebernommen: 0, erneut: 0, paperless: 0, vorhanden: 0, fehlt: [], fehler: [] };

async function laden(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const t = await res.text();
    throw new Error((() => { try { return JSON.parse(t).message; } catch { return null; } })() ?? `Fehler ${res.status}`);
  }
  return res.blob();
}

export async function eingangDokumente(nr: string): Promise<AuftragEingangDokument[]> {
  return liste<AuftragEingangDokument>(await api.get<unknown>(`${T}/auftraege/${nr}/eingang`), 'dokumente');
}

/** Belege eines Auftrags in den Ordner bringen; doks = schon geladene Liste (sonst wird sie geholt) */
export async function eingangInOrdner(nr: string, doks: AuftragEingangDokument[] | null, o: { anfordern?: boolean; paperless?: boolean; pruefen?: boolean; erneut?: boolean; nur?: number[] } = {}): Promise<UebernahmeErgebnis> {
  const e: UebernahmeErgebnis = { uebernommen: 0, erneut: 0, paperless: 0, vorhanden: 0, fehlt: [], fehler: [] };
  const alle = (doks ?? await eingangDokumente(nr)).filter((d) => !o.nur || o.nur.includes(d.id));
  let anfordern = !!o.anfordern; // nur beim ersten Zugriff fragen (direkt nach dem Klick)
  const imOrdner = async (name: string) => { const f = await dateiLesenUnterordner(nr, UNTERORDNER_EINGANG, name, anfordern); anfordern = false; return f; };
  for (const d of alle) {
    try {
      if (d.status === 'wartet' && d.ziel === 'lokal') {
        const pfad = await ablegenUnterordner(nr, UNTERORDNER_EINGANG, d.datei, await laden(dateiUrl(d.id)), anfordern);
        anfordern = false;
        if (!pfad) { e.fehler.push('Kein Zugriff auf den Ablageordner.'); break; }
        await api.post(`${T}/eingang/dokumente/${d.id}/uebernommen`, { ablage_name: pfad.split('/').pop() });
        e.uebernommen++;
      } else if (d.status === 'uebernommen' && o.erneut && d.vorhanden) {
        const pfad = await ablegenUnterordner(nr, UNTERORDNER_EINGANG, eingangName(d), await laden(dateiUrl(d.id)), anfordern, true);
        anfordern = false;
        if (!pfad) { e.fehler.push('Kein Zugriff auf den Ablageordner.'); break; }
        await api.post(`${T}/eingang/dokumente/${d.id}/uebernommen`, { ablage_name: pfad.split('/').pop() });
        e.erneut++;
      } else if (d.status === 'abgelegt' && d.paperless_id && o.paperless) {
        if (!o.erneut && await imOrdner(eingangName(d))) { e.vorhanden++; continue; }
        const pfad = await ablegenUnterordner(nr, UNTERORDNER_EINGANG, eingangName(d), await laden(`${T}/auftraege/${nr}/dokumente/${d.paperless_id}/datei`), anfordern, true);
        anfordern = false;
        if (!pfad) { e.fehler.push('Kein Zugriff auf den Ablageordner.'); break; }
        e.paperless++;
      } else if (d.status === 'uebernommen' && (o.pruefen || o.erneut)) {
        if (await imOrdner(eingangName(d))) e.vorhanden++; else e.fehlt.push(eingangName(d));
      }
    } catch (x) { e.fehler.push(`${d.datei}: ${(x as Error).message}`); }
  }
  return e;
}

/** Ergebnis als kurzer Text; leer = nichts zu tun */
export function uebernahmeText(e: UebernahmeErgebnis, nr?: string): string {
  const teile = [
    e.uebernommen ? `${e.uebernommen} E-Mail-Beleg(e) übernommen` : '',
    e.erneut ? `${e.erneut} erneut abgelegt` : '',
    e.paperless ? `${e.paperless} aus Paperless nachgeladen` : '',
    e.fehlt.length ? `${e.fehlt.length} nicht im Ordner (${e.fehlt.join(', ')}) – Inhalt im Portal nicht mehr aufbewahrt, bitte aus Outlook neu ablegen` : '',
    e.fehler.length ? `Fehler: ${e.fehler.join('; ')}` : '',
  ].filter(Boolean);
  return teile.length ? `${nr ? `${nr}: ` : ''}${teile.join(' · ')}` : '';
}
