import type { Adresse, Auftrag, Stop } from '../util';
import type { BelegAnschrift, BelegVorschlag, Feld } from './typen';

/**
 * Auftrag aus Beleg: Vorschlag der Erkennung (BelegVorschlag) in die Erfassungsmaske des Frachtauftrags übernehmen.
 * Reine Logik ohne React – getestet in server/test/transport_beleguebernahme.test.ts.
 *
 * Regel je Feld (verbindlich, docs/euroflex-belegerfassung.md):
 *  - „eindeutig“ → Wert kommt in die Maske (Kennzeichnung „aus Beleg“).
 *  - „unklar“    → Wert kommt NICHT in die Maske; Rückfrage mit den Kandidaten und ihrer Herkunft.
 *  - „fehlt“     → Feld bleibt leer; es steht in der Liste „nicht im Beleg gefunden – bitte von Hand nachtragen“.
 * Was der Benutzer schon eingetragen hat, wird nie still überschrieben: Weicht der Beleg ab, entsteht eine Rückfrage
 * („Konflikt“). Es wird nichts gespeichert – das macht der Benutzer in der Maske.
 */

export const KOPF_FELDER = ['kunde', 'ordernummer', 'leistungsdatum', 'frachtpreis_vk', 'gewicht', 'lademeter', 'fahrzeugtyp', 'ladegut', 'ladeweise',
  'palettentausch', 'besonderheiten'] as const;
export type KopfFeld = typeof KOPF_FELDER[number];
export const STOP_FELDER = ['firma', 'strasse', 'land', 'plzort', 'ladenummer', 'datum', 'zeit', 'firma_e', 'strasse_e', 'land_e', 'plzort_e', 'datum_e', 'zeit_e'] as const;
export type StopFeldName = typeof STOP_FELDER[number];
/** Feld der Maske: Kopffeld oder „stops.<Index>.<Feld>“ (Index 0 = erster Stop) */
export type FeldId = KopfFeld | `stops.${number}.${StopFeldName}`;

/** der Teil des Formularzustands von AuftragDetail, den der Beleg füllen kann */
export type Formular = Pick<Auftrag, KopfFeld> & { stops: Stop[] };
/** Wert eines Feldes im Formular */
export type Wert = string | number | null;

/** Vorbelegung der Neuanlage für Firma und Straße des Empfängers – zählt als leer (keine Eingabe des Benutzers) */
export const LAUT_LFS = 'laut LFS';

export const stopId = (stop: number, feld: StopFeldName): FeldId => `stops.${stop}.${feld}`;

function teile(id: FeldId): { stop: number; feld: StopFeldName } | null {
  const m = /^stops\.(\d+)\.([a-z_]+)$/.exec(id);
  return m ? { stop: Number(m[1]), feld: m[2] as StopFeldName } : null;
}

const leererStop = (pos: number): Stop => ({
  pos, firma: null, strasse: null, land: null, plzort: null, ladenummer: null, datum: null, zeit: null,
  firma_e: null, strasse_e: null, land_e: null, plzort_e: null, datum_e: null, zeit_e: null,
});

/** aktueller Wert eines Feldes im Formular */
export function feldLesen(form: Formular, id: FeldId): Wert {
  const t = teile(id);
  if (t) return form.stops[t.stop]?.[t.feld] ?? null;
  return form[id as KopfFeld] ?? null;
}

/** Feld im Formular setzen (neues Objekt; fehlt der Stop, wird er angelegt) */
export function feldSetzen<F extends Formular>(form: F, id: FeldId, wert: Wert): F {
  const t = teile(id);
  if (!t) {
    // Frachtpreis ist im Formular immer eine Zahl
    return { ...form, [id]: id === 'frachtpreis_vk' ? Number(wert ?? 0) || 0 : wert };
  }
  const stops = [...form.stops];
  for (let i = stops.length; i <= t.stop; i++) stops.push(leererStop(i + 1));
  stops[t.stop] = { ...stops[t.stop], [t.feld]: wert === null || wert === '' ? null : String(wert) };
  return { ...form, stops };
}

/** Zahl in deutscher Schreibweise ohne Tausenderpunkt, z. B. 24 → „24“, 13.6 → „13,6“ */
export function zahlText(n: number): string {
  return String(Math.round(n * 1000) / 1000).replace('.', ',');
}

const alsZahl = (w: Wert): number => (typeof w === 'number' ? w : Number(String(w ?? '').trim().replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')));

/** Wert aus dem Beleg in die Form des Formulars bringen (Gewicht als Text in t, Preis auf Cent, Texte ohne Rand) */
export function formWert(id: FeldId, w: string | number): Wert {
  switch (id) {
    case 'kunde': return Number(w);
    case 'frachtpreis_vk': return Math.round(Number(w) * 100) / 100;
    case 'lademeter': return Math.round(Number(w) * 1000) / 1000;
    case 'gewicht': return typeof w === 'number' ? zahlText(w) : w.trim();
    default: return String(w).trim();
  }
}

/** leer = noch nichts eingetragen (Frachtpreis 0 und die Vorbelegung „laut LFS“ zählen als leer) */
export function istLeer(id: FeldId, w: Wert): boolean {
  if (w === null || w === undefined) return true;
  if (id === 'frachtpreis_vk') return !alsZahl(w);
  const s = String(w).trim();
  if (!s) return true;
  const t = teile(id);
  return !!t && (t.feld === 'firma_e' || t.feld === 'strasse_e') && s === LAUT_LFS;
}

const ZAHLFELDER: readonly FeldId[] = ['kunde', 'frachtpreis_vk', 'lademeter', 'gewicht'];

/** gleicher Inhalt? Zahlen nach Wert („13,6“ = 13.6), Texte ohne Rücksicht auf Groß-/Kleinschreibung und Leerraum */
export function gleich(id: FeldId, a: Wert, b: Wert): boolean {
  if (a === null || b === null) return a === b;
  if (ZAHLFELDER.includes(id)) {
    const x = alsZahl(a);
    const y = alsZahl(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) < 0.0005;
  }
  const n = (w: Wert) => String(w).trim().replace(/\s+/g, ' ').toLowerCase();
  return n(a) === n(b);
}

/** Anzeige eines Formularwerts (Kontakt- und Wertelistennamen löst die Oberfläche selbst auf) */
export function wertText(id: FeldId, w: Wert): string {
  if (w === null || w === '') return '';
  const t = teile(id);
  if (id === 'leistungsdatum' || t?.feld === 'datum' || t?.feld === 'datum_e') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(w));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(w);
  }
  if (id === 'frachtpreis_vk') return `${alsZahl(w).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
  if (id === 'gewicht') return `${String(w).replace('.', ',')} t`;
  if (id === 'lademeter') return `${String(w).replace('.', ',')} m`;
  if (id === 'kunde') return `Kontakt ${w}`;
  return String(w);
}

// ---------------------------------------------------------------------------- Bezeichnungen wie in der Maske

const KOPF_TEXT: Record<KopfFeld, string> = {
  kunde: 'Kunde', ordernummer: 'Auftragsnr. Kunde', leistungsdatum: 'Leistungsdatum', frachtpreis_vk: 'Frachtpreis VK', gewicht: 'Gewicht',
  lademeter: 'Lademeter', fahrzeugtyp: 'Fahrzeugtyp', ladegut: 'Ladegut', ladeweise: 'Ladeweise', palettentausch: 'Palettentausch',
  besonderheiten: 'Besonderheiten',
};
const STOP_TEXT: Record<StopFeldName, string> = {
  firma: 'Absender: Firma', strasse: 'Absender: Straße', land: 'Absender: Land', plzort: 'Absender: PLZ Ort', ladenummer: 'Absender: Ladenummer',
  datum: 'Absender: Zeitvorgabe Laden (Datum)', zeit: 'Absender: Zeitvorgabe Laden (Uhrzeit / Zeitfenster)',
  firma_e: 'Empfänger: Firma', strasse_e: 'Empfänger: Straße', land_e: 'Empfänger: Land', plzort_e: 'Empfänger: PLZ Ort',
  datum_e: 'Empfänger: Zeitvorgabe Entladen (Datum)', zeit_e: 'Empfänger: Zeitvorgabe Entladen (Uhrzeit / Zeitfenster)',
};
/** Felder, die in der Maske unter einer Beschriftung stehen – fehlen beide, steht in der Liste nur die gemeinsame Beschriftung */
const STOP_PAARE: [StopFeldName, StopFeldName, string][] = [
  ['land', 'plzort', 'Absender: Land / PLZ Ort'],
  ['datum', 'zeit', 'Absender: Zeitvorgabe Laden'],
  ['land_e', 'plzort_e', 'Empfänger: Land / PLZ Ort'],
  ['datum_e', 'zeit_e', 'Empfänger: Zeitvorgabe Entladen'],
];
const stopName = (i: number) => (i === 0 ? 'Erster Stop' : i === 1 ? 'Zweiter Stop' : `Stop ${i + 1}`);

/** Bezeichnung eines Feldes wie in der Maske, z. B. „Auftragsnr. Kunde“ oder „Erster Stop – Empfänger: PLZ Ort“ */
export function feldBezeichnung(id: FeldId): string {
  const t = teile(id);
  return t ? `${stopName(t.stop)} – ${STOP_TEXT[t.feld]}` : KOPF_TEXT[id as KopfFeld];
}

// ---------------------------------------------------------------------------- Übernahme

export interface KandidatWert { wert: Wert; text: string; herkunft: string | null }

export interface Rueckfrage {
  id: FeldId;
  bezeichnung: string;
  /** unklar = der Beleg nennt mehrere Möglichkeiten; konflikt = im Feld steht schon etwas anderes als im Beleg */
  grund: 'unklar' | 'konflikt';
  hinweis: string | null;
  kandidaten: KandidatWert[];
  /** bei „konflikt“: was beim Lesen des Belegs schon im Feld stand */
  vorhanden: Wert;
}

export interface Fehlend { ids: FeldId[]; bezeichnung: string; hinweis: string | null }

export interface Uebernommen { id: FeldId; wert: Wert; herkunft: string | null }

export interface Uebernahme<F extends Formular = Formular> {
  /** Formular nach der Übernahme (nur eindeutige Werte in bis dahin leeren Feldern) */
  form: F;
  uebernommen: Uebernommen[];
  rueckfragen: Rueckfrage[];
  fehlend: Fehlend[];
}

/** Vorschlag in das Formular übernehmen. Sieht der Beleg nicht nach einem Frachtauftrag aus, bleibt alles, wie es war. */
export function belegUebernehmen<F extends Formular>(v: BelegVorschlag, form0: F): Uebernahme<F> {
  let form = form0;
  const uebernommen: Uebernommen[] = [];
  const rueckfragen: Rueckfrage[] = [];
  const fehlt = new Map<FeldId, string | null>();
  if (!v.istFrachtauftrag) return { form, uebernommen, rueckfragen, fehlend: [] };

  const feld = (id: FeldId, f: Feld<string> | Feld<number> | undefined) => {
    if (!f) return;
    const alt = feldLesen(form, id);
    const leer = istLeer(id, alt);
    const eindeutig = f.status === 'eindeutig' && f.wert !== null && f.wert !== undefined && String(f.wert).trim() !== '';
    if (eindeutig) {
      const neu = formWert(id, f.wert as string | number);
      if (leer) { form = feldSetzen(form, id, neu); uebernommen.push({ id, wert: neu, herkunft: f.herkunft }); }
      else if (gleich(id, alt, neu)) uebernommen.push({ id, wert: alt, herkunft: f.herkunft });
      else {
        rueckfragen.push({
          id, bezeichnung: feldBezeichnung(id), grund: 'konflikt', hinweis: f.hinweis, vorhanden: alt,
          kandidaten: [{ wert: neu, text: wertText(id, neu), herkunft: f.herkunft }],
        });
      }
      return;
    }
    if (f.status === 'unklar') {
      rueckfragen.push({
        id, bezeichnung: feldBezeichnung(id), grund: leer ? 'unklar' : 'konflikt', hinweis: f.hinweis, vorhanden: leer ? null : alt,
        kandidaten: (f.kandidaten as { wert: string | number; text: string; herkunft: string | null }[]).map((k) => {
          const wert = formWert(id, k.wert);
          return { wert, text: k.text || wertText(id, wert), herkunft: k.herkunft };
        }),
      });
      return;
    }
    // „fehlt“ – auch ein „eindeutig“ ohne Wert wird nicht geraten, sondern nachgetragen
    fehlt.set(id, f.hinweis);
  };

  for (const k of KOPF_FELDER) feld(k, v[k]);
  const stops = v.stops.slice(0, 2);
  stops.forEach((s, i) => { for (const f of STOP_FELDER) feld(stopId(i, f), s[f]); });

  // Liste der fehlenden Felder in der Reihenfolge der Maske; zusammengehörige Felder unter ihrer gemeinsamen Beschriftung
  const fehlend: Fehlend[] = [];
  const hinweise = (ids: FeldId[]) => [...new Set(ids.map((id) => fehlt.get(id)).filter((h): h is string => !!h))].join(' · ') || null;
  for (const k of KOPF_FELDER) if (fehlt.has(k)) fehlend.push({ ids: [k], bezeichnung: KOPF_TEXT[k], hinweis: fehlt.get(k) ?? null });
  stops.forEach((_, i) => {
    const offen = STOP_FELDER.filter((f) => fehlt.has(stopId(i, f)));
    if (!offen.length) return;
    if (offen.length === STOP_FELDER.length) {
      // gar nichts gefunden: ein zweiter Stop ist dann einfach nicht vorhanden, beim ersten genügt eine Zeile
      if (i === 0) fehlend.push({ ids: offen.map((f) => stopId(i, f)), bezeichnung: `${stopName(i)} – Absender und Empfänger`, hinweis: hinweise(offen.map((f) => stopId(i, f))) });
      return;
    }
    const erledigt = new Set<StopFeldName>();
    for (const f of STOP_FELDER) {
      if (!offen.includes(f) || erledigt.has(f)) continue;
      const paar = STOP_PAARE.find(([a, b]) => (a === f || b === f) && offen.includes(a) && offen.includes(b));
      const felder = paar ? [paar[0], paar[1]] : [f];
      felder.forEach((x) => erledigt.add(x));
      const ids = felder.map((x) => stopId(i, x));
      fehlend.push({ ids, bezeichnung: `${stopName(i)} – ${paar ? paar[2] : STOP_TEXT[f]}`, hinweis: hinweise(ids) });
    }
  });
  return { form, uebernommen, rueckfragen, fehlend };
}

/**
 * Rückfragen, die noch offen sind. entschieden = Felder, zu denen der Benutzer gewählt hat (Wert) oder seine Eingabe behält (null).
 * Ohne ausdrückliche Entscheidung gilt: „unklar“ ist erledigt, sobald im Feld etwas steht (von Hand eingetragen); ein „Konflikt“,
 * sobald das Feld nicht mehr den Wert von damals hat.
 */
export function offeneRueckfragen(rueckfragen: Rueckfrage[], form: Formular, entschieden: ReadonlyMap<FeldId, Wert>): Rueckfrage[] {
  return rueckfragen.filter((r) => {
    if (entschieden.has(r.id)) return false;
    const akt = feldLesen(form, r.id);
    return r.grund === 'unklar' ? istLeer(r.id, akt) : gleich(r.id, akt, r.vorhanden);
  });
}

/**
 * Kennzeichnung eines Feldes (oder mehrerer unter einer Beschriftung) in der Maske: „frage“ = offene Rückfrage,
 * „beleg“ = der Wert im Feld stammt aus dem Beleg (übernommen oder in einer Rückfrage gewählt) und wurde seitdem nicht geändert.
 */
export function belegMarke(u: Uebernahme, form: Formular, entschieden: ReadonlyMap<FeldId, Wert>, ids: FeldId[]): 'frage' | 'beleg' | null {
  if (offeneRueckfragen(u.rueckfragen, form, entschieden).some((r) => ids.includes(r.id))) return 'frage';
  for (const id of ids) {
    const akt = feldLesen(form, id);
    if (istLeer(id, akt)) continue;
    const quelle = u.uebernommen.find((x) => x.id === id)?.wert ?? entschieden.get(id) ?? null;
    if (quelle !== null && gleich(id, akt, quelle)) return 'beleg';
  }
  return null;
}

/** Anschrift laut Beleg als Vorbelegung für „Kontakt anlegen“ (Hausnummer am Ende der Straße wird abgetrennt) */
export function anschriftZuKontakt(b: BelegAnschrift): Partial<Adresse> {
  const k: Partial<Adresse> = { kundenname: b.name.trim() };
  const str = (b.strasse ?? '').trim();
  const m = /^(.*\D)\s+(\d+\s?[a-zA-Z]?(?:\s?[-/]\s?\d+\s?[a-zA-Z]?)?)$/.exec(str);
  if (m) { k.strasse = m[1].trim(); k.hausnummer = m[2].trim(); } else if (str) k.strasse = str;
  if (b.land?.trim()) k.land = b.land.trim().toUpperCase();
  if (b.plz?.trim()) k.plz = b.plz.trim();
  if (b.ort?.trim()) k.ort = b.ort.trim();
  return k;
}

/** Anschrift laut Beleg in einer Zeile */
export function anschriftText(b: BelegAnschrift): string {
  const ort = [b.land, b.plz, b.ort].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  return [b.name.trim(), (b.strasse ?? '').trim(), ort].filter(Boolean).join(', ');
}
