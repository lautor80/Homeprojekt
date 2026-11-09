import { BusinessError } from '../../../server/src/errors.js';
import { liste, paperless, type Db, type Verein } from './verein.js';
import { normName } from './mitglieder/logik.js';

/**
 * Zugriffsschutz für Paperless-Dokumente: Eine Dokument-ID darf nur durchgereicht werden,
 * wenn das Dokument zum jeweiligen Fachbereich gehört. Sonst könnte jeder mit einer
 * Anzeigeberechtigung beliebige Dokumente des Paperless-Mandanten lesen (Aufnahmeanträge
 * mit Bankdaten, Eingangsrechnungen, …).
 */
const verweigert = () => new BusinessError('Dieses Dokument gehört nicht zu diesem Bereich.', 404);

/**
 * Hallenrechnungen: Dokument der Rechnung oder eine Fassung davon.
 * Fassungen (Neudruck = neue Dateiversion) haben in Paperless eine eigene ID, die das Portal nicht speichert.
 * Sie werden über das Stammdokument geprüft: `root` muss zu einer Hallenrechnung gehören und die Fassung führen.
 * Ohne `root` hilft der Verweis der Fassung auf ihr Stammdokument bzw. der Titel „Hallenrechnung <Nr>“.
 */
export async function halleDokumentPruefen(db: Db, v: Verein, id: number, root?: number): Promise<void> {
  if (await halleStammdokument(db, id)) return;
  const pl = paperless(v);
  if (root && root !== id) {
    if (!(await halleStammdokument(db, root))) throw verweigert();
    const fassungen = await pl.versionen(root).catch(() => []);
    if (!fassungen.some((x) => x.id === id)) throw verweigert();
    return;
  }
  const d = await pl.dokument(id).catch(() => null);
  // gerade erst abgelegte Namensliste einer Sammelrechnung (noch an keiner Position)
  if (String(d?.title ?? '').startsWith('Sammelrechnung Namensliste')) return;
  // Fassung, die auf ihr Stammdokument verweist
  const stamm = Number(d?.root_document ?? 0);
  if (stamm && stamm !== id && await halleStammdokument(db, stamm)) return;
  const nr = /^Hallenrechnung\s+(\S+)/.exec(String(d?.title ?? ''))?.[1];
  if (!nr) throw verweigert();
  const [r] = await db`select 1 from tco.rgkopf where rgnr_txt = ${nr} limit 1`;
  if (!r) throw verweigert();
}

/** Dokument-ID steht an einer Hallenrechnung (Kopf) oder als Beleg an einer Position */
async function halleStammdokument(db: Db, id: number): Promise<boolean> {
  const [k] = await db`select 1 from tco.rgkopf where ltrim(doknr, '0') = ${String(id)} limit 1`;
  if (k) return true;
  const [p] = await db`select 1 from tco.rgpos where beleg_doc_id = ${id} limit 1`;
  return !!p;
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

/**
 * Mitglieder: Dokumente, deren Korrespondent ein Mitglied/Zahler des Vereins ist.
 * Liefert den Dokumenttyp (für die Prüfung auf Bankdaten).
 */
export async function mitgliedDokumentPruefen(db: Db, v: Verein, id: number): Promise<{ typ: string }> {
  const pl = paperless(v);
  const d = await pl.dokument(id).catch(() => null);
  if (!d?.correspondent) throw verweigert();
  // Namensvergleich wie korrespondentFinden (Umlaute, Reihenfolge Nachname/Vorname, Anrede)
  const name = normName(await pl.korrespondentName(Number(d.correspondent)));
  const personen = await db`select nachname, vorname from tco.mitglieder`;
  const passt = (m: Record<string, any>) => [`${m.nachname ?? ''} ${m.vorname ?? ''}`, `${m.vorname ?? ''} ${m.nachname ?? ''}`].some((x) => normName(x) === name);
  if (!name || !personen.some(passt)) throw verweigert();
  const typ = d.document_type ? (await pl.dokumenttypen()).find((t) => t.id === Number(d.document_type))?.name ?? '' : '';
  return { typ };
}
