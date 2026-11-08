import { api } from '@core/api';
import type { AblageErgebnis, AblageZiel } from '@core/ablage';
import { dateiLesen } from '../util';
import { F } from './typen';

interface Antwort { id: number | null; text: string; warnungen: string[]; zugeordnet: string[] }

/**
 * Ablageziel FI: Datei(en) als FI-Beleg nach Paperless. Mit Buchung(en) sofort zugeordnet
 * (Rückgängig = Zuordnung wieder entfernen), ohne Buchung als offener Beleg für den Bankimport.
 */
export function fiBelegZiel(internenr: string[], titel: string, nachher?: (ids: number[]) => void): AblageZiel {
  return {
    titel,
    annehmen: async (files): Promise<AblageErgebnis> => {
      const ids: number[] = [];
      const texte: string[] = [];
      for (const f of files) {
        const r = await api.post<Antwort>(`${F}/belege/hochladen`, { datei: f.name, inhalt: await dateiLesen(f), internenr });
        if (r.id) ids.push(r.id);
        texte.push(r.text, ...r.warnungen);
      }
      nachher?.(ids);
      const text = files.length === 1 ? texte.join(' · ') : `${ids.length} von ${files.length} Datei(en) abgelegt bei ${titel}`;
      return {
        text,
        rueckgaengig: internenr.length && ids.length ? async () => {
          for (const id of ids) for (const n of internenr) {
            await api.post(`${F}/belege/entfernen`, { internenr: n, dok: id, grund: 'Ablage rückgängig gemacht' });
          }
          nachher?.([]);
        } : undefined,
      };
    },
  };
}
