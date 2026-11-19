import { api } from '@core/api';
import { toast } from '@core/toast';
import { T } from './util';

/** Funktion „Belege automatisch in Paperless ablegen“ (Funktionsschalter) */
export const F_ARCHIV = 'transport.paperless.automatisch';

export interface Beleg { art: 'T' | 'L' | 'R'; kennung: string }

/** Beleg aus der Server-Adresse eines PDFs (`…/pdf/T/2026_0153-2`); lokale Dateien und andere Adressen: null */
export function belegAusUrl(url: string): Beleg | null {
  const m = /\/pdf\/(T|L|R)\/([^/?#]+)$/.exec(url);
  return m ? { art: m[1] as Beleg['art'], kennung: decodeURIComponent(m[2]) } : null;
}

/**
 * Gedruckte bzw. als E-Mail-Datei versendete Belege an den Server melden – er legt sie im Hintergrund in Paperless ab
 * (nur mit eingerichtetem Paperless, erneut nur nach einer Änderung am Auftrag). Drucken wartet nicht darauf.
 */
export function belegeAblegen(belege: (Beleg | null)[], anlass: 'druck' | 'versand') {
  const liste = belege.filter((b): b is Beleg => !!b);
  if (!liste.length) return;
  api.post<{ geplant: number }>(`${T}/archiv`, { belege: liste, anlass })
    .then((r) => { if (r.geplant) toast(r.geplant === 1 ? 'Beleg wird in Paperless abgelegt.' : `${r.geplant} Belege werden in Paperless abgelegt.`, 2500); })
    .catch((e) => toast(`Paperless-Ablage: ${(e as Error).message}`, 8000));
}
