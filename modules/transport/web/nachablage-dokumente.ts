/**
 * Aufträge → „Neu ablegen“: welche PDFs für die markierten Aufträge entstehen und in welche Auftragsordner sie gehören.
 * Reine Funktion ohne Browser-APIs (Test: server/test/transport_nachablage.test.ts); ausgeführt in nachablage.ts.
 */
const T = '/api/m/transport';

export interface NachablageZeile { auftragsnr: string; fahrten: number; faktura: string | null }
export type NachablageArt = 'auftrag' | 'rechnung' | 'alles';

export function nachablageDokumente(sel: NachablageZeile[], alle: NachablageZeile[], art: NachablageArt): { url: string; filename: string; ablage: string[] }[] {
  const docs: { url: string; filename: string; ablage: string[] }[] = [];
  if (art !== 'rechnung') {
    for (const s of sel) {
      const ids = s.fahrten > 1 ? Array.from({ length: s.fahrten }, (_, i) => `${s.auftragsnr}-${i + 1}`) : [s.auftragsnr];
      for (const id of ids) docs.push({ url: `${T}/pdf/T/${encodeURIComponent(id)}`, filename: `Transportauftrag_${id}.pdf`, ablage: [s.auftragsnr] });
      docs.push({ url: `${T}/pdf/L/${encodeURIComponent(s.auftragsnr)}`, filename: `Lieferschein_${s.auftragsnr}.pdf`, ablage: [s.auftragsnr] });
    }
  }
  if (art !== 'auftrag') {
    for (const f of [...new Set(sel.filter((s) => s.faktura).map((s) => s.faktura!))]) {
      const nrs = [...new Set([...alle, ...sel].filter((s) => s.faktura === f).map((s) => s.auftragsnr))];
      docs.push({ url: `${T}/pdf/R/${encodeURIComponent(f)}`, filename: `Rechnung_${f}.pdf`, ablage: nrs });
    }
  }
  return docs;
}

