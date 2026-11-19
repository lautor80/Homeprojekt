import type { Paperless } from '../../../server/src/lib/paperless.js';

/**
 * Dokumente zum Auftrag über das Custom Field „Auftrag“ in Paperless.
 *
 * Ein Dokument gehört zu einem Auftrag, wenn es im Portal verknüpft ist (transport.auftrag_dokumente) oder wenn sein
 * Custom Field „Auftrag“ die Auftragsnummer enthält (mehrere Nummern durch Komma getrennt, z. B. bei Sammelrechnungen).
 * Die Liste im Auftrag zeigt beides zusammen. Die reinen Funktionen hier testet server/test/transport_paperless_auftrag.test.ts.
 */

/** Custom Field in Paperless, das ein Dokument mit Aufträgen verbindet (Text; mehrere Nummern durch Komma getrennt) */
export const AUFTRAG_FELD = 'Auftrag';

/** Auftragsnummern aus dem Feldwert („2026_0150, 2026_0153“) */
export function auftraegeImFeld(wert: unknown): string[] {
  if (wert === null || wert === undefined) return [];
  return [...new Set(String(wert).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Feldwert nennt genau diese Auftragsnummer (nicht nur als Teil einer längeren) */
export const feldPasst = (wert: unknown, nr: string) => auftraegeImFeld(wert).includes(nr.trim());

/** Auftragsnummer zum Feldwert hinzufügen, ohne vorhandene zu verlieren */
export function feldErgaenzen(wert: unknown, nr: string): string {
  const l = auftraegeImFeld(wert);
  return (l.includes(nr) ? l : [...l, nr]).join(', ');
}

/** Dokument-ID aus der Paperless-Meldung zu einer Dublette („… It is a duplicate of Rechnung (#123).“) */
export function duplikatVon(meldung: string): number | null {
  const m = /duplicate[^#]*#(\d+)/i.exec(meldung);
  return m ? Number(m[1]) : null;
}

/** Wert des Felds „Auftrag“ in einem Paperless-Dokument */
export function feldWertIn(doc: Record<string, any>, feldId: number | null): unknown {
  if (!feldId) return null;
  return (doc.custom_fields ?? []).find((x: { field: number }) => x.field === feldId)?.value ?? null;
}

export interface PortalDok { doc_id: number; titel: string | null; datei: string | null; erstellt_am: string | Date; erstellt_von: string | null }
export interface DokZeile {
  doc_id: number;
  titel: string | null;
  datei: string | null;
  /** im Portal verknüpft (seit) */
  erstellt_am: string | null;
  erstellt_von: string | null;
  /** Dokumentdatum in Paperless (JJJJ-MM-TT) */
  datum: string | null;
  /** portal = nur im Portal verknüpft, feld = nur über das Custom Field „Auftrag“, beide = beides */
  quelle: 'portal' | 'feld' | 'beide';
  /** Anzahl Notizen (Kommentare) in Paperless, null = unbekannt */
  notizen: number | null;
  /** Link in die Paperless-Oberfläche */
  link: string | null;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

/** Liste im Auftrag: Portal-Verknüpfungen und Paperless-Treffer über das Feld, jedes Dokument einmal, neueste zuerst */
export function zeilenZusammenfuehren(portal: PortalDok[], docs: Record<string, any>[], o: { nr: string; feldId: number | null; basis: string | null }): DokZeile[] {
  const nachId = new Map<number, Record<string, any>>();
  for (const d of docs) if (d && Number.isInteger(d.id)) nachId.set(d.id, d);
  const zeile = (id: number, p: PortalDok | null): DokZeile => {
    const d = nachId.get(id);
    const feld = d ? feldPasst(feldWertIn(d, o.feldId), o.nr) : false;
    return {
      doc_id: id,
      titel: p?.titel ?? d?.title ?? null,
      datei: p?.datei ?? d?.original_file_name ?? null,
      erstellt_am: p ? iso(p.erstellt_am) : null,
      erstellt_von: p?.erstellt_von ?? null,
      datum: d?.created ? String(d.created).slice(0, 10) : null,
      quelle: p ? (feld ? 'beide' : 'portal') : 'feld',
      notizen: d ? (Array.isArray(d.notes) ? d.notes.length : typeof d.notes === 'number' ? d.notes : null) : null,
      link: o.basis ? `${o.basis}/documents/${id}/details` : null,
    };
  };
  const out = portal.map((p) => zeile(p.doc_id, p));
  for (const d of docs) {
    if (out.some((z) => z.doc_id === d.id)) continue;
    if (feldPasst(feldWertIn(d, o.feldId), o.nr)) out.push(zeile(d.id, null));
  }
  const schluessel = (z: DokZeile) => z.datum ?? z.erstellt_am?.slice(0, 10) ?? '';
  return out.sort((a, b) => schluessel(b).localeCompare(schluessel(a)) || b.doc_id - a.doc_id);
}

/** Custom Field „Auftrag“ in Paperless anlegen, falls es fehlt; liefert seine ID */
export async function auftragFeldSichern(pl: Paperless): Promise<number> {
  const f = await pl.feld(AUFTRAG_FELD);
  return f ? f.id : (await pl.feldAnlegen(AUFTRAG_FELD, 'string')).id;
}

/** Paperless-Dokumente, deren Feld „Auftrag“ diese Nummer nennt (genau, nicht nur enthält) */
export async function dokumenteZumAuftrag(pl: Paperless, nr: string): Promise<{ feldId: number | null; docs: Record<string, any>[] }> {
  const f = await pl.feld(AUFTRAG_FELD);
  if (!f) return { feldId: null, docs: [] };
  const docs = await pl.dokumenteMitFeldText(AUFTRAG_FELD, nr);
  return { feldId: f.id, docs: docs.filter((d) => feldPasst(feldWertIn(d, f.id), nr)) };
}

/** Gehört das Paperless-Dokument über das Feld „Auftrag“ zu diesem Auftrag? */
export async function perFeldZugeordnet(pl: Paperless, nr: string, id: number): Promise<boolean> {
  const f = await pl.feld(AUFTRAG_FELD);
  if (!f) return false;
  try { return feldPasst(feldWertIn(await pl.dokument(id), f.id), nr); } catch { return false; }
}
