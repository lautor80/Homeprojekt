import type { Verein } from '../verein.js';
import { liste, paperless } from '../verein.js';

/** Paperless-Belege für FI (GET_UNASSIGNEDDOCUMENTS, UPDATE_CUSTOM_FIELDS) */

export interface OffenerBeleg {
  id: number;
  titel: string;
  korrespondent: string;
  datum: string | null;
  betrag: number | null;
}

function betragAus(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/^[A-Z]{3}/, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

async function belegAus(v: Verein, d: Record<string, any>): Promise<OffenerBeleg> {
  const pl = paperless(v);
  return {
    id: d.id,
    titel: d.title ?? '',
    korrespondent: await pl.korrespondentName(d.correspondent),
    datum: (d.created_date ?? d.created ?? '').slice(0, 10) || null,
    betrag: betragAus(await pl.feldWert(d, v.fi_feld_betrag)),
  };
}

/** Nicht zugeordnete Belege: Typen aus den Einstellungen, Speicherpfad Buchhaltung, Feld „SAP“ leer */
export async function offeneBelege(v: Verein): Promise<OffenerBeleg[]> {
  const pl = paperless(v);
  const feld = await pl.feld(v.fi_feld_sap);
  if (!feld) throw new Error(`Custom Field „${v.fi_feld_sap}“ fehlt in Paperless`);
  const filter: Record<string, string> = {
    custom_field_query: JSON.stringify([feld.id, 'isnull', true]),
    ordering: '-created',
  };
  const typen = await pl.ids('document_types', liste(v.fi_beleg_typen));
  if (typen.length) filter.document_type__id__in = typen.join(',');
  const pfade = await pl.ids('storage_paths', liste(v.fi_beleg_pfad));
  if (pfade.length) filter.storage_path__id__in = pfade.join(',');
  const docs = await pl.dokumenteSuchen(filter);
  const out: OffenerBeleg[] = [];
  for (const d of docs) out.push(await belegAus(v, d));
  return out.sort((a, b) => a.korrespondent.localeCompare(b.korrespondent) || (b.datum ?? '').localeCompare(a.datum ?? ''));
}

export async function belegLesen(v: Verein, id: number): Promise<OffenerBeleg> {
  return belegAus(v, await paperless(v).dokument(id));
}

/**
 * Zuordnung an Paperless melden: Feld „Belegnummer“ = interne Nummer, Feld „SAP“ = true.
 * `nurWennLeer`: Belegnummer nur setzen, wenn noch keine eingetragen ist (Dauerbelege, Übernahme).
 * Liefert Warnungen statt sie zu verschlucken (E15).
 */
export async function zuordnungMelden(v: Verein, doks: number[], internenr: string, nurWennLeer = false): Promise<string[]> {
  const pl = paperless(v);
  const warn: string[] = [];
  for (const id of doks) {
    try {
      let felder: Record<string, string | number | null> = { [v.fi_feld_sap]: true as never };
      if (nurWennLeer) {
        const alt = await pl.feldWert(await pl.dokument(id), v.fi_feld_beleg);
        if (!alt) felder[v.fi_feld_beleg] = internenr;
      } else {
        felder = { [v.fi_feld_beleg]: internenr, ...felder };
      }
      warn.push(...(await pl.metadatenSetzen(id, { customFields: felder })).map((w) => `Beleg ${id}: ${w}`));
    } catch (e) {
      warn.push(`Paperless-Update für Beleg ${id} fehlgeschlagen: ${(e as Error).message}`);
    }
  }
  return warn;
}

/** Zuordnung aufgehoben: ist der Beleg keiner Buchung mehr zugeordnet, Felder in Paperless leeren */
export async function zuordnungLoesen(v: Verein, dok: number): Promise<string[]> {
  try {
    return await paperless(v).metadatenSetzen(dok, { customFields: { [v.fi_feld_beleg]: null, [v.fi_feld_sap]: null } });
  } catch (e) {
    return [`Paperless-Update für Beleg ${dok} fehlgeschlagen: ${(e as Error).message}`];
  }
}
