import { sql } from '../db.js';
import type { Paperless, UploadMeta } from './paperless.js';

/**
 * Zentrale Paperless-Zuordnung („Mapping“) für alle Module.
 *
 * Jede Stelle, die ein Dokument nach Paperless bringt, ist ein *Kontext* (z. B. tco/fi.beleg,
 * transport/auftrag.dokument). Für jeden Kontext legt eine *Regel* fest, wie die Standardfelder
 * (Titel, Korrespondent, Dokumenttyp, Speicherpfad, Tags, Dokumentdatum, Notiz) und beliebige
 * Custom Fields gefüllt werden – als Vorlagen mit Platzhaltern wie `{kunde}` oder `{datei}`.
 *
 * Die Module liefern je Kontext die Platzhalter mit Beispielwerten und eine Standardregel
 * (bisheriges Verhalten). Abweichungen pflegt die Administration (core.paperless_mapping); die
 * gespeicherte Regel überlagert die Standardregel feldweise.
 *
 * Platzhalter: `{name}`; mit Modifikatoren `{name|upper}`, `{name|lower}`, `{name|datum}` (JJJJ-MM-TT →
 * TT.MM.JJJJ), `{name|kurz:40}`, `{name|pad:6}` (führende Nullen), `{name|ohneEndung}`.
 * Unbekannte oder leere Platzhalter ergeben einen leeren Text; Mehrfachleerzeichen werden zusammengefasst.
 * Enthält eine Custom-Field-Vorlage nur einen Platzhalter mit Zahlwert, wird die Zahl übergeben
 * (wichtig für Geldfelder in Paperless).
 */

export interface Platzhalter { name: string; text: string; beispiel: string | number }

export interface Regel {
  titel?: string;
  korrespondent?: string;
  dokumenttyp?: string;
  speicherpfad?: string;
  /** Tags, durch Komma getrennt (Vorlagen erlaubt) */
  tags?: string;
  /** Dokumentdatum (JJJJ-MM-TT), z. B. `{heute}` */
  datum?: string;
  notiz?: string;
  /** Custom Fields: Name des Felds in Paperless → Vorlage */
  felder?: Record<string, string>;
  /** fehlende Korrespondenten/Tags in Paperless anlegen (Standard: ja) */
  anlegen?: boolean;
}

export interface KontextDef {
  /** eindeutig im Modul, z. B. fi.beleg */
  id: string;
  text: string;
  /** Hinweis, wann die Ablage passiert */
  beschreibung?: string;
  platzhalter: Platzhalter[];
  standard: Regel;
  /** Felder, die der Benutzer an dieser Stelle selbst wählt – Regel ist nur Vorbelegung */
  benutzerwahl?: ('titel' | 'dokumenttyp' | 'korrespondent' | 'speicherpfad' | 'tags' | 'datum' | 'notiz')[];
}

export interface Zuordnung {
  title: string;
  created: string | undefined;
  correspondent: string;
  documentType: string;
  storagePath: string;
  tags: string[];
  notiz: string;
  customFields: Record<string, string | number | null>;
  anlegen: boolean;
}

export const REGEL_FELDER = ['titel', 'korrespondent', 'dokumenttyp', 'speicherpfad', 'tags', 'datum', 'notiz'] as const;

const condense = (s: string) => s.replace(/\s+/g, ' ').trim();
const datText = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso);

/** Vorlage auswerten; `roh` liefert den unveränderten Wert, wenn die Vorlage genau ein Platzhalter ist */
export function auswerten(vorlage: string | undefined, werte: Record<string, unknown>): { text: string; roh: unknown } {
  if (!vorlage) return { text: '', roh: undefined };
  const einzeln = /^\{([A-Za-z_][\w.]*)\}$/.exec(vorlage.trim());
  const roh = einzeln ? werte[einzeln[1]] : undefined;
  const text = condense(vorlage.replace(/\{([A-Za-z_][\w.]*)((?:\|[A-Za-z]+(?::[^|}]*)?)*)\}/g, (_m, name: string, mods: string) => {
    let v = werte[name];
    if (v === null || v === undefined) return '';
    let s = typeof v === 'number' ? String(v) : String(v);
    for (const mod of mods.split('|').filter(Boolean)) {
      const [m, arg] = mod.split(':');
      switch (m) {
        case 'upper': s = s.toUpperCase(); break;
        case 'lower': s = s.toLowerCase(); break;
        case 'datum': s = datText(s); break;
        case 'kurz': s = s.slice(0, Number(arg) || 60); break;
        case 'pad': s = s.padStart(Number(arg) || 6, '0'); break;
        case 'ohneEndung': s = s.replace(/\.[^.]+$/, ''); break;
        case 'betrag': s = typeof v === 'number' ? v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : s; break;
        default: break;
      }
    }
    v = s;
    return s;
  }));
  return { text, roh };
}

/** Regel anwenden: alle Zielfelder als Text (Namen, nicht IDs) */
export function anwenden(regel: Regel, werte: Record<string, unknown>): Zuordnung {
  const customFields: Record<string, string | number | null> = {};
  for (const [feld, vorlage] of Object.entries(regel.felder ?? {})) {
    if (!feld.trim()) continue;
    const { text, roh } = auswerten(vorlage, werte);
    customFields[feld.trim()] = typeof roh === 'number' ? roh : text || null;
  }
  const datum = auswerten(regel.datum, werte).text;
  return {
    title: auswerten(regel.titel, werte).text,
    created: /^\d{4}-\d{2}-\d{2}$/.test(datum) ? datum : undefined,
    correspondent: auswerten(regel.korrespondent, werte).text,
    documentType: auswerten(regel.dokumenttyp, werte).text,
    storagePath: auswerten(regel.speicherpfad, werte).text,
    tags: auswerten(regel.tags, werte).text.split(',').map((t) => t.trim()).filter(Boolean),
    notiz: auswerten(regel.notiz, werte).text,
    customFields,
    anlegen: regel.anlegen !== false,
  };
}

/** gespeicherte Regel feldweise über die Standardregel legen (leere Texte = Standard) */
export function zusammenfuehren(standard: Regel, eigene: Regel | null | undefined): Regel {
  if (!eigene) return { ...standard, felder: { ...(standard.felder ?? {}) } };
  const r: Regel = { ...standard, felder: { ...(standard.felder ?? {}) } };
  for (const k of REGEL_FELDER) if (typeof eigene[k] === 'string') r[k] = eigene[k];
  if (eigene.anlegen !== undefined) r.anlegen = eigene.anlegen;
  if (eigene.felder) r.felder = { ...eigene.felder };
  return r;
}

const cache = new Map<string, { regel: Regel | null; until: number }>();

export async function eigeneRegelLesen(modul: string, kontext: string): Promise<Regel | null> {
  const key = `${modul}/${kontext}`;
  const c = cache.get(key);
  if (c && c.until > Date.now()) return c.regel;
  const [r] = await sql`select regel from core.paperless_mapping where modul = ${modul} and kontext = ${kontext}`;
  const regel = (r?.regel as Regel | undefined) ?? null;
  cache.set(key, { regel, until: Date.now() + 30_000 });
  return regel;
}
export const mappingCacheLeeren = () => cache.clear();

/** wirksame Regel eines Kontexts (Standard + gespeicherte Abweichungen) */
export async function regelLesen(def: KontextDef, modul: string): Promise<Regel> {
  return zusammenfuehren(def.standard, await eigeneRegelLesen(modul, def.id));
}

/** Zuordnung für eine konkrete Ablage: Regel lesen, Platzhalter füllen */
export async function zuordnen(def: KontextDef, modul: string, werte: Record<string, unknown>, ueberschreiben?: Partial<Zuordnung>): Promise<Zuordnung> {
  const z = anwenden(await regelLesen(def, modul), werte);
  if (ueberschreiben) {
    for (const [k, v] of Object.entries(ueberschreiben)) {
      if (v === undefined || v === null || v === '') continue;
      if (k === 'customFields') Object.assign(z.customFields, v as Record<string, string | number | null>);
      else if (k === 'tags') z.tags = [...new Set([...z.tags, ...(v as string[])])];
      else (z as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return z;
}

/**
 * Zuordnung in Upload-Metadaten (IDs) übersetzen. Korrespondent und Tags werden bei Bedarf angelegt,
 * fehlende Dokumenttypen/Speicherpfade ergeben Warnungen.
 */
export async function uploadMeta(pl: Paperless, z: Zuordnung, mime?: string): Promise<{ meta: UploadMeta; warnungen: string[] }> {
  const warnungen: string[] = [];
  const meta: UploadMeta = { title: z.title || undefined, created: z.created, mime };
  if (z.correspondent) {
    const k = await pl.korrespondent(z.correspondent, z.anlegen);
    if (k) meta.correspondent = k; else warnungen.push(`Korrespondent „${z.correspondent}“ fehlt in Paperless`);
  }
  if (z.documentType) {
    const t = await pl.idByName('document_types', z.documentType);
    if (t) meta.documentType = t; else warnungen.push(`Dokumenttyp „${z.documentType}“ fehlt in Paperless`);
  }
  if (z.storagePath) {
    const t = await pl.idByName('storage_paths', z.storagePath);
    if (t) meta.storagePath = t; else warnungen.push(`Speicherpfad „${z.storagePath}“ fehlt in Paperless`);
  }
  const tags: number[] = [];
  for (const name of z.tags) {
    const t = await pl.tag(name, z.anlegen);
    if (t) tags.push(t); else warnungen.push(`Tag „${name}“ fehlt in Paperless`);
  }
  if (tags.length) meta.tags = tags;
  return { meta, warnungen };
}

/**
 * Datei nach Paperless bringen und alle Felder laut Zuordnung setzen (Standardfelder beim Upload,
 * Custom Fields und Notiz danach). Liefert die Dokument-ID (null = Paperless verarbeitet noch).
 */
export async function ablegen(pl: Paperless, z: Zuordnung, daten: Buffer, datei: string, o: { mime?: string; benutzer?: string; warteSekunden?: number } = {}) {
  const { meta, warnungen } = await uploadMeta(pl, z, o.mime);
  const task = await pl.upload(daten, datei, meta);
  const id = await pl.warteAufDokument(task, o.warteSekunden ?? 30);
  if (id) warnungen.push(...await nachtragen(pl, id, z, o.benutzer));
  return { id, warnungen, meta };
}

/** Custom Fields und Notiz an ein (neues oder bestehendes) Dokument schreiben */
export async function nachtragen(pl: Paperless, id: number, z: Zuordnung, benutzer?: string, mitStandardfeldern = false): Promise<string[]> {
  const warnungen: string[] = [];
  const felder = Object.fromEntries(Object.entries(z.customFields).filter(([, v]) => v !== null && v !== ''));
  if (Object.keys(felder).length || mitStandardfeldern) {
    warnungen.push(...await pl.metadatenSetzen(id, {
      customFields: Object.keys(felder).length ? felder : undefined,
      ...(mitStandardfeldern ? { title: z.title || undefined, correspondent: z.correspondent || undefined, documentType: z.documentType || undefined, storagePath: z.storagePath || undefined, created: z.created } : {}),
    }).catch((e) => [`Metadaten: ${(e as Error).message}`]));
  }
  if (z.notiz) await pl.notizAnlegen(id, benutzer ? `${z.notiz} (${benutzer})` : z.notiz).catch((e) => { warnungen.push(`Notiz: ${(e as Error).message}`); });
  return warnungen;
}

/** Vorschau mit den Beispielwerten des Kontexts */
export function vorschau(def: KontextDef, regel: Regel): Zuordnung {
  return anwenden(zusammenfuehren(def.standard, regel), Object.fromEntries(def.platzhalter.map((p) => [p.name, p.beispiel])));
}

/** häufige Platzhalter */
export const PH = {
  heute: { name: 'heute', text: 'heutiges Datum (JJJJ-MM-TT)', beispiel: '2026-11-08' },
  benutzer: { name: 'benutzer', text: 'angemeldeter Benutzer', beispiel: 'Max Muster' },
  datei: { name: 'datei', text: 'Dateiname', beispiel: 'Lieferschein_4711.pdf' },
  verein: { name: 'verein', text: 'Name des Vereins / der Firma', beispiel: 'TC Oberthal' },
} as const;

/**
 * Komplettablage über einen Kontext: Regel lesen, Platzhalter füllen, Datei hochladen, danach
 * Custom Fields/Notiz nachtragen – dabei steht `{dokid}` (Dokument-ID, 6-stellig) zur Verfügung.
 */
export async function kontextAblegen(pl: Paperless, def: KontextDef, modul: string, werte: Record<string, unknown>, daten: Buffer, datei: string,
  o: { mime?: string; benutzer?: string; ueberschreiben?: Partial<Zuordnung>; warteSekunden?: number } = {}) {
  const z = await zuordnen(def, modul, { ...werte, dokid: '' }, o.ueberschreiben);
  const { meta, warnungen } = await uploadMeta(pl, z, o.mime);
  const task = await pl.upload(daten, datei, meta);
  const id = await pl.warteAufDokument(task, o.warteSekunden ?? 30);
  let zuordnung = z;
  if (id) {
    zuordnung = await zuordnen(def, modul, { ...werte, dokid: String(id).padStart(6, '0') }, o.ueberschreiben);
    // Standardfelder nach dem Upload noch einmal setzen: Paperless-Zuordnungsregeln beim Einlesen
    // können Korrespondent/Typ/Pfad überschreiben – die Regel des Portals soll gelten
    warnungen.push(...await nachtragen(pl, id, zuordnung, o.benutzer, true));
  }
  return { id, warnungen, zuordnung };
}

/** Felder eines bestehenden Dokuments laut Kontext (neu) setzen – z. B. nach einer neuen Dateiversion */
export async function kontextAktualisieren(pl: Paperless, def: KontextDef, modul: string, id: number, werte: Record<string, unknown>,
  o: { benutzer?: string; ueberschreiben?: Partial<Zuordnung>; ohneNotiz?: boolean } = {}) {
  const z = await zuordnen(def, modul, { ...werte, dokid: String(id).padStart(6, '0') }, o.ueberschreiben);
  if (o.ohneNotiz) z.notiz = '';
  return { zuordnung: z, warnungen: await nachtragen(pl, id, z, o.benutzer, true) };
}

export const PH_DOKID: Platzhalter = { name: 'dokid', text: 'Paperless-Dokumentnummer (6-stellig, erst nach dem Upload)', beispiel: '004711' };
