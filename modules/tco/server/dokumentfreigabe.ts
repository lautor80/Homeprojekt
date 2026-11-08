import { BusinessError } from '../../../server/src/errors.js';
import { liste, paperless, type Db, type Verein } from './verein.js';
import { korrName } from './mitglieder/dokumente.js';

/**
 * Zugriffsschutz für Paperless-Dokumente: Eine Dokument-ID darf nur durchgereicht werden,
 * wenn das Dokument zum jeweiligen Fachbereich gehört. Sonst könnte jeder mit einer
 * Anzeigeberechtigung beliebige Dokumente des Paperless-Mandanten lesen (Aufnahmeanträge
 * mit Bankdaten, Eingangsrechnungen, …).
 */
const verweigert = () => new BusinessError('Dieses Dokument gehört nicht zu diesem Bereich.', 404);

/** Hallenrechnungen: Dokument der Rechnung (oder eine Fassung davon, erkennbar am Titel „Hallenrechnung <Nr>“) */
export async function halleDokumentPruefen(db: Db, v: Verein, id: number): Promise<void> {
  const [k] = await db`select 1 from tco.rgkopf where ltrim(doknr, '0') = ${String(id)} limit 1`;
  if (k) return;
  const d = await paperless(v).dokument(id).catch(() => null);
  const nr = /^Hallenrechnung\s+(\S+)/.exec(String(d?.title ?? ''))?.[1];
  if (!nr) throw verweigert();
  const [r] = await db`select 1 from tco.rgkopf where rgnr_txt = ${nr} limit 1`;
  if (!r) throw verweigert();
}

/** FI-Belege: zugeordnete Belege oder Dokumente aus den konfigurierten Beleg-Dokumenttypen/-Ablagepfaden */
export async function fiDokumentPruefen(db: Db, v: Verein, id: number): Promise<void> {
  const [z] = await db`select 1 from tco.fipapermap where ltrim(doknr, '0') = ${String(id)} limit 1`;
  if (z) return;
  const pl = paperless(v);
  const d = await pl.dokument(id).catch(() => null);
  if (!d) throw verweigert();
  const typen = await pl.ids('document_types', liste(v.fi_beleg_typen));
  if (d.document_type && typen.includes(Number(d.document_type))) return;
  const pfade = await pl.ids('storage_paths', liste(v.fi_beleg_pfad));
  if (d.storage_path && pfade.includes(Number(d.storage_path))) return;
  throw verweigert();
}

/** Mitglieder: Dokumente, deren Korrespondent ein Mitglied/Zahler des Vereins ist */
export async function mitgliedDokumentPruefen(db: Db, v: Verein, id: number): Promise<void> {
  const pl = paperless(v);
  const d = await pl.dokument(id).catch(() => null);
  if (!d?.correspondent) throw verweigert();
  const name = await pl.korrespondentName(Number(d.correspondent));
  const personen = await db`select nachname, vorname from tco.mitglieder`;
  if (!personen.some((m) => korrName(m) === name)) throw verweigert();
}
