import { api } from '@core/api';
import type { AblageErgebnis } from '@core/ablage';
import { T } from './util';
import { ablegen } from './ordner';
import { emlLesen, istEml } from './eml';

/**
 * Dateien zu einem Auftrag ablegen – gemeinsam für die Objektseite (Dokumente, Ablagefeld der Navigation, Strg+V) und das
 * Hineinziehen auf eine Zeile der Auftragsliste: Paperless (Feld „Auftrag“, Euroflex-Zuordnung) und/oder Ablageordner auf diesem PC.
 * E-Mails (.eml) werden zerlegt: Anhänge wie einzelne Dateien, die E-Mail selbst nur in den Ablageordner.
 */
const lesen = (f: File) => new Promise<string>((ok, err) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => err(r.error);
  r.readAsDataURL(f);
});

export async function auftragAblegen(nr: string, eingang: File[], o: { paperless: boolean; ordner: boolean; danach?: () => void }): Promise<AblageErgebnis> {
  const files: File[] = [];
  const nurOrdner = new Set<File>();
  const mails: string[] = [];
  for (const f of eingang) {
    if (!istEml(f)) { files.push(f); continue; }
    const m = emlLesen(new Uint8Array(await f.arrayBuffer()));
    mails.push(`E-Mail „${m.betreff || f.name}“: ${m.anhaenge.length ? `${m.anhaenge.length} Anhang/Anhänge (${m.anhaenge.map((a) => a.name).join(', ')})` : 'keine Anhänge'}`);
    for (const a of m.anhaenge) files.push(new File([a.daten as BlobPart], a.name, { type: a.typ || 'application/octet-stream' }));
    if (o.ordner) { files.push(f); nurOrdner.add(f); }
  }
  if (!files.length) return { text: `${mails.join(' · ')} – nichts abzulegen${o.ordner ? '' : ' (kein Ablageordner für die E-Mail selbst)'}` };
  const ids: number[] = [];
  const texte: string[] = [];
  let lokal = 0;
  let lokalFehler = '';
  try {
    for (const f of files) {
      if (o.ordner) {
        try { if (await ablegen(nr, f.name, f)) lokal++; } catch (e) { lokalFehler = (e as Error).message; }
      }
      if (o.paperless && !nurOrdner.has(f)) {
        // id null: Paperless verarbeitet noch – Feld „Auftrag“ und Zuordnung trägt der Server nach
        const r = await api.post<{ id: number | null; text: string }>(`${T}/auftraege/${nr}/dokumente`, { datei: f.name, inhalt: await lesen(f) });
        if (r.id) ids.push(r.id);
        texte.push(r.text);
      }
    }
  } finally { o.danach?.(); }
  const ord = o.ordner ? (lokal ? ` · ${lokal} im Ablageordner gespeichert` : ` · Ablageordner: ${lokalFehler || 'kein Zugriff (im Auftrag unter Dokumente „Zugriff erlauben“)'}`) : '';
  const vorweg = mails.length ? `${mails.join(' · ')} – ` : '';
  return {
    text: vorweg + (o.paperless
      ? (texte.length === 1 ? texte[0] : `${texte.length} Datei(en) an Paperless übergeben${ids.length < texte.length ? ` (${texte.length - ids.length} werden noch verarbeitet und automatisch zugeordnet)` : ''} – Auftrag ${nr}`)
      : `${lokal} Datei(en) im Ablageordner von Auftrag ${nr} gespeichert`) + (o.paperless ? ord : ''),
    rueckgaengig: ids.length ? async () => { for (const id of ids) await api.del(`${T}/auftraege/${nr}/dokumente/${id}`); o.danach?.(); } : undefined,
  };
}
