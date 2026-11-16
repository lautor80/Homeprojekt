import { BusinessError } from '../../../../server/src/errors.js';
import { addTage, heute } from '../format.js';
import type { Db } from '../verein.js';

/**
 * Checklisten für Veranstaltungen.
 *
 * Eine Checkliste hat eine Kategorie, eine verantwortliche Person und Schritte. Abgehakt wird je Bezug – das ist eine
 * Veranstaltung des Vereinskalenders oder ein freier Termin. Dieselbe Checkliste gilt so für eine oder mehrere
 * Veranstaltungen, jede mit eigenem Stand. Die Fälligkeit eines Schritts ist relativ zum Termin des Bezugs
 * („14 Tage vorher“), ein festes Datum oder offen. Checklisten und einzelne Schritte lassen sich kopieren.
 */

// ---------------------------------------------------------------- reine Funktionen

export type Stand = 'ERLEDIGT' | 'UEBERFAELLIG' | 'BALD' | 'OFFEN';
export const STAND_TEXT: Record<Stand, string> = { ERLEDIGT: 'erledigt', UEBERFAELLIG: 'überfällig', BALD: 'bald fällig', OFFEN: 'offen' };
/** ab so vielen Tagen vor der Fälligkeit gilt ein Schritt als „bald fällig“ */
export const BALD_TAGE = 7;

export interface Terminbezug { tage_vor: number | null; faellig: string | null }

/** Fälligkeit eines Schritts für einen Termin: festes Datum geht vor, sonst Termin minus Tage; ohne beides offen */
export function faelligAm(s: Terminbezug, termin: string | null): string | null {
  if (s.faellig) return s.faellig;
  if (s.tage_vor === null || s.tage_vor === undefined || !termin) return null;
  return addTage(termin, -s.tage_vor);
}

/** „14 Tage vorher“, „am Tag der Veranstaltung“, „3 Tage danach“, „bis 01.03.2027“ */
export function terminText(s: Terminbezug): string {
  if (s.faellig) return `bis ${s.faellig.slice(8, 10)}.${s.faellig.slice(5, 7)}.${s.faellig.slice(0, 4)}`;
  if (s.tage_vor === null || s.tage_vor === undefined) return '';
  if (s.tage_vor === 0) return 'am Tag der Veranstaltung';
  const n = Math.abs(s.tage_vor);
  return `${n} Tag${n === 1 ? '' : 'e'} ${s.tage_vor > 0 ? 'vorher' : 'danach'}`;
}

export function stand(erledigt: boolean, faellig: string | null, stichtag: string): Stand {
  if (erledigt) return 'ERLEDIGT';
  if (!faellig) return 'OFFEN';
  if (faellig < stichtag) return 'UEBERFAELLIG';
  return faellig <= addTage(stichtag, BALD_TAGE) ? 'BALD' : 'OFFEN';
}

export interface Fortschritt { gesamt: number; erledigt: number; ueberfaellig: number; bald: number }
export function fortschritt(staende: Stand[]): Fortschritt {
  return {
    gesamt: staende.length, erledigt: staende.filter((s) => s === 'ERLEDIGT').length,
    ueberfaellig: staende.filter((s) => s === 'UEBERFAELLIG').length, bald: staende.filter((s) => s === 'BALD').length,
  };
}

/** Schritte lassen sich in so vielen Stufen schachteln (Schritt → Unterschritt → …) */
export const MAX_STUFEN = 5;

export interface BaumKnoten { id: number; parent_id: number | null; pos: number }
export interface BaumZeile<T> { knoten: T; ebene: number; blatt: boolean; nr: string }

/**
 * Flache Liste in Baumreihenfolge bringen: jede Zeile mit Stufe (1 = oberste), Gliederungsnummer („2.1.3“) und der
 * Angabe, ob sie ein Blatt ist (keine Unterschritte). Verwaiste Knoten (Elternteil fehlt) stehen auf der obersten Stufe.
 */
export function baumOrdnen<T extends BaumKnoten>(liste: T[]): BaumZeile<T>[] {
  const ids = new Set(liste.map((x) => x.id));
  const kinder = new Map<number | null, T[]>();
  for (const x of liste) {
    const p = x.parent_id !== null && ids.has(x.parent_id) ? x.parent_id : null;
    kinder.set(p, [...(kinder.get(p) ?? []), x]);
  }
  for (const k of kinder.values()) k.sort((a, b) => a.pos - b.pos || a.id - b.id);
  const out: BaumZeile<T>[] = [];
  const gehe = (p: number | null, ebene: number, vor: string) => (kinder.get(p) ?? []).forEach((x, i) => {
    const nr = `${vor}${i + 1}`;
    out.push({ knoten: x, ebene, blatt: !(kinder.get(x.id)?.length), nr });
    gehe(x.id, ebene + 1, `${nr}.`);
  });
  gehe(null, 1, '');
  return out;
}

/** Stand einer Gruppe aus den Ständen ihrer Blätter: alle erledigt → erledigt, sonst das Dringendste */
export function gruppenStand(blaetter: Stand[]): Stand {
  if (blaetter.length && blaetter.every((s) => s === 'ERLEDIGT')) return 'ERLEDIGT';
  return blaetter.includes('UEBERFAELLIG') ? 'UEBERFAELLIG' : blaetter.includes('BALD') ? 'BALD' : 'OFFEN';
}

/** Titel einer Kopie: „… (Kopie)“, „… (Kopie 2)“ – der erste, den es noch nicht gibt */
export function kopieTitel(titel: string, vorhandene: string[]): string {
  const basis = titel.replace(/ \(Kopie(?: \d+)?\)$/, '');
  const belegt = new Set(vorhandene.map((t) => t.toLowerCase()));
  for (let i = 1; ; i++) {
    const t = `${basis} (Kopie${i > 1 ? ` ${i}` : ''})`;
    if (!belegt.has(t.toLowerCase())) return t;
  }
}

// ---------------------------------------------------------------- Lesen

export interface Kategorie { id: number; name: string; aktiv: boolean; anzahl: number }
export interface Schritt extends Terminbezug {
  id: number; pos: number; titel: string; beschreibung: string | null; verantwortlich: string | null; termin_text: string;
  /** Hierarchie: übergeordneter Schritt, Stufe 1–5, Gliederungsnummer („2.1“), Blatt = ohne Unterschritte (nur Blätter werden abgehakt) */
  parent_id: number | null; ebene: number; nr: string; blatt: boolean;
}
export interface Erledigt { am: string; von: string | null; notiz: string | null }
export interface BezugSchritt {
  schritt_id: number; faellig: string | null; stand: Stand; erledigt: Erledigt | null;
  /** nur bei Schritten mit Unterschritten: Fortschritt über ihre Blätter – Stand und Fälligkeit (frühester offener Unterschritt) ergeben sich daraus */
  gruppe?: Fortschritt;
}
export interface Bezug {
  id: number; event_id: number | null; titel: string; termin: string; ort: string | null; abgesagt: boolean;
  schritte: BezugSchritt[]; fortschritt: Fortschritt;
}
export interface Checkliste {
  id: number; titel: string; beschreibung: string | null; kategorie_id: number | null; kategorie: string | null;
  verantwortlich: string | null; verantwortlich_id: string | null; kopie_von: number | null;
  erstellt_am: string; erstellt_von: string | null; geaendert_am: string; geaendert_von: string | null;
  schritte: Schritt[]; bezuege: Bezug[];
}

export async function kategorienLesen(db: Db): Promise<Kategorie[]> {
  return await db<Kategorie[]>`
    select k.id, k.name, k.aktiv, (select count(*)::int from tco.cl_checklisten c where c.kategorie_id = k.id) as anzahl
    from tco.cl_kategorien k order by lower(k.name)`;
}

/** Checklisten mit Schritten, Bezügen und Stand je Bezug; `ids` = nur diese */
export async function checklistenLesen(db: Db, ids?: number[], stichtag = heute()): Promise<Checkliste[]> {
  const alle = !ids;
  const liste = ids ?? [];
  const kopf = await db<Omit<Checkliste, 'schritte' | 'bezuege'>[]>`
    select c.id, c.titel, c.beschreibung, c.kategorie_id, k.name as kategorie, c.verantwortlich, c.verantwortlich_id, c.kopie_von,
           c.erstellt_am, c.erstellt_von, c.geaendert_am, c.geaendert_von
    from tco.cl_checklisten c left join tco.cl_kategorien k on k.id = c.kategorie_id
    where ${alle} or c.id = any(${liste}) order by lower(c.titel), c.id`;
  if (!kopf.length) return [];
  const cids = kopf.map((c) => c.id);
  const schritte = await db<(Omit<Schritt, 'termin_text' | 'ebene' | 'nr' | 'blatt'> & { checkliste_id: number })[]>`
    select id, checkliste_id, parent_id, pos, titel, beschreibung, verantwortlich, tage_vor, faellig
    from tco.cl_schritte where checkliste_id = any(${cids}) order by checkliste_id, pos, id`;
  const bezuege = await db<{ id: number; checkliste_id: number; event_id: number | null; titel: string; termin: string; ort: string | null; abgesagt: boolean }[]>`
    select b.id, b.checkliste_id, b.event_id,
           coalesce(e.titel, nullif(b.bezeichnung, ''), 'Termin') as titel,
           coalesce((e.beginn at time zone 'Europe/Berlin')::date, b.termin) as termin, e.ort, coalesce(e.abgesagt, false) as abgesagt
    from tco.cl_bezuege b left join tco.kal_events e on e.id = b.event_id
    where b.checkliste_id = any(${cids}) order by 5, b.id`;
  const bids = bezuege.map((b) => b.id);
  const erledigt = bids.length ? await db<{ bezug_id: number; schritt_id: number; erledigt_am: string; erledigt_von: string | null; notiz: string | null }[]>`
    select bezug_id, schritt_id, erledigt_am, erledigt_von, notiz from tco.cl_erledigt where bezug_id = any(${bids})` : [];
  const erl = new Map(erledigt.map((e) => [`${e.bezug_id}|${e.schritt_id}`, e]));
  return kopf.map((c) => {
    // Baumreihenfolge; je Schritt die Blätter darunter (für den Stand der Gruppen)
    const s: Schritt[] = baumOrdnen(schritte.filter((x) => x.checkliste_id === c.id))
      .map(({ knoten: { checkliste_id: _c, ...x }, ebene, blatt, nr }) => ({ ...x, ebene, blatt, nr, termin_text: terminText(x) }));
    const blaetter = new Map<number, number[]>();
    for (const [i, sch] of s.entries()) {
      if (sch.blatt) continue;
      const ids: number[] = [];
      for (let k = i + 1; k < s.length && s[k].ebene > sch.ebene; k++) if (s[k].blatt) ids.push(s[k].id);
      blaetter.set(sch.id, ids);
    }
    const b = bezuege.filter((x) => x.checkliste_id === c.id).map(({ checkliste_id: _c, ...x }) => {
      const blatt = new Map<number, BezugSchritt>();
      for (const sch of s.filter((y) => y.blatt)) {
        const e = erl.get(`${x.id}|${sch.id}`);
        const f = faelligAm(sch, x.termin);
        blatt.set(sch.id, { schritt_id: sch.id, faellig: f, stand: stand(!!e, f, stichtag), erledigt: e ? { am: e.erledigt_am, von: e.erledigt_von, notiz: e.notiz } : null });
      }
      const zeilen: BezugSchritt[] = s.map((sch) => {
        if (sch.blatt) return blatt.get(sch.id)!;
        const unter = blaetter.get(sch.id)!.map((id) => blatt.get(id)!);
        const offen = unter.filter((z) => z.stand !== 'ERLEDIGT' && z.faellig).map((z) => z.faellig!).sort();
        return { schritt_id: sch.id, faellig: offen[0] ?? null, stand: gruppenStand(unter.map((z) => z.stand)), erledigt: null, gruppe: fortschritt(unter.map((z) => z.stand)) };
      });
      // der Fortschritt einer Veranstaltung zählt nur, was abgehakt wird: die Blätter
      return { ...x, schritte: zeilen, fortschritt: fortschritt([...blatt.values()].map((z) => z.stand)) };
    });
    return { ...c, schritte: s, bezuege: b };
    return { ...c, schritte: s, bezuege: b };
  });
}

export async function checklisteLesen(db: Db, id: number): Promise<Checkliste> {
  const [c] = await checklistenLesen(db, [id]);
  if (!c) throw new BusinessError('Checkliste nicht gefunden.', 404);
  return c;
}

/** Veranstaltungen des Kalenders zur Auswahl: ab 30 Tage zurück, nicht abgesagte zuerst nach Datum */
export async function eventsZurAuswahl(db: Db) {
  return await db<{ id: number; titel: string; termin: string; ort: string | null; abgesagt: boolean }[]>`
    select id, titel, (beginn at time zone 'Europe/Berlin')::date as termin, ort, abgesagt
    from tco.kal_events where beginn >= now() - interval '30 days' order by beginn, id limit 500`;
}

/** aktive Benutzer als Vorschlag für die verantwortliche Person */
export async function personenLesen(db: Db) {
  return await db<{ id: string; name: string }[]>`
    select id, display_name as name from core.users where active order by lower(display_name)`;
}

// ---------------------------------------------------------------- Schreiben

export interface KopfEingabe { titel: string; beschreibung?: string | null; kategorie_id?: number | null; verantwortlich?: string | null; verantwortlich_id?: string | null }
export interface SchrittEingabe { titel: string; beschreibung?: string | null; verantwortlich?: string | null; tage_vor?: number | null; faellig?: string | null; /** nur beim Anlegen: als Unterschritt dieses Schritts */ parent_id?: number | null }

const leer = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

async function beruehren(tx: Db, id: number, wer: string) {
  await tx`update tco.cl_checklisten set geaendert_am = now(), geaendert_von = ${wer} where id = ${id}`;
}

async function kategoriePruefen(tx: Db, id: number | null | undefined) {
  if (id == null) return;
  const [k] = await tx`select 1 from tco.cl_kategorien where id = ${id}`;
  if (!k) throw new BusinessError('Die Kategorie gibt es nicht (mehr).');
}

/** Name zur Benutzer-ID nachtragen bzw. ID verwerfen, wenn der Name von Hand geändert wurde */
async function verantwortlich(tx: Db, e: KopfEingabe): Promise<{ name: string | null; id: string | null }> {
  const name = leer(e.verantwortlich);
  if (!e.verantwortlich_id) return { name, id: null };
  const [u] = await tx`select display_name from core.users where id = ${e.verantwortlich_id}`;
  if (!u) return { name, id: null };
  return !name || name === u.display_name ? { name: u.display_name as string, id: e.verantwortlich_id } : { name, id: null };
}

export async function checklisteAnlegen(tx: Db, e: KopfEingabe, wer: string): Promise<number> {
  await kategoriePruefen(tx, e.kategorie_id);
  const v = await verantwortlich(tx, e);
  const [r] = await tx`
    insert into tco.cl_checklisten (titel, beschreibung, kategorie_id, verantwortlich, verantwortlich_id, erstellt_von, geaendert_von)
    values (${e.titel.trim()}, ${leer(e.beschreibung)}, ${e.kategorie_id ?? null}, ${v.name}, ${v.id}, ${wer}, ${wer}) returning id`;
  return r.id as number;
}

export async function checklisteAendern(tx: Db, id: number, e: KopfEingabe, wer: string) {
  await kategoriePruefen(tx, e.kategorie_id);
  const v = await verantwortlich(tx, e);
  const r = await tx`
    update tco.cl_checklisten set titel = ${e.titel.trim()}, beschreibung = ${leer(e.beschreibung)}, kategorie_id = ${e.kategorie_id ?? null},
           verantwortlich = ${v.name}, verantwortlich_id = ${v.id}, geaendert_am = now(), geaendert_von = ${wer}
    where id = ${id} returning id`;
  if (!r.length) throw new BusinessError('Checkliste nicht gefunden.', 404);
}

export async function checklisteLoeschen(tx: Db, id: number) {
  const r = await tx`delete from tco.cl_checklisten where id = ${id} returning id`;
  if (!r.length) throw new BusinessError('Checkliste nicht gefunden.', 404);
}

/**
 * Checkliste mit allen Schritten kopieren. Der Stand (abgehakt) wird nie kopiert. `bezuege`: die Veranstaltungen und
 * Termine mitnehmen (dieselbe Liste für dieselben Veranstaltungen, neu begonnen) – Vorgabe: ohne, die Kopie ist eine Vorlage.
 */
export async function checklisteKopieren(tx: Db, id: number, o: { titel?: string | null; bezuege?: boolean }, wer: string): Promise<number> {
  const [c] = await tx`select * from tco.cl_checklisten where id = ${id}`;
  if (!c) throw new BusinessError('Checkliste nicht gefunden.', 404);
  const titel = leer(o.titel) ?? kopieTitel(c.titel as string, (await tx`select titel from tco.cl_checklisten`).map((x) => x.titel as string));
  const [n] = await tx`
    insert into tco.cl_checklisten (titel, beschreibung, kategorie_id, verantwortlich, verantwortlich_id, kopie_von, erstellt_von, geaendert_von)
    values (${titel}, ${c.beschreibung}, ${c.kategorie_id}, ${c.verantwortlich}, ${c.verantwortlich_id}, ${id}, ${wer}, ${wer}) returning id`;
  const wurzeln = (await tx`select id from tco.cl_schritte where checkliste_id = ${id} and parent_id is null order by pos, id`).map((x) => x.id as number);
  for (const [i, w] of wurzeln.entries()) await teilbaumKopieren(tx, w, n.id as number, null, i + 1);
  if (o.bezuege) {
    await tx`
      insert into tco.cl_bezuege (checkliste_id, event_id, termin, bezeichnung)
      select ${n.id}, event_id, termin, bezeichnung from tco.cl_bezuege where checkliste_id = ${id} order by id`;
  }
  return n.id as number;
}

function schrittPruefen(e: SchrittEingabe) {
  if (e.tage_vor != null && e.faellig) throw new BusinessError('Bitte entweder „Tage vor dem Termin“ oder ein festes Datum angeben, nicht beides.');
}

/** Stufe eines Schritts (1 = oberste) und seine Checkliste */
async function stufeVon(tx: Db, id: number): Promise<{ checkliste: number; ebene: number } | null> {
  const [r] = await tx`
    with recursive hoch as (
      select id, parent_id, checkliste_id, 1 as n from tco.cl_schritte where id = ${id}
      union all select s.id, s.parent_id, s.checkliste_id, h.n + 1 from tco.cl_schritte s join hoch h on s.id = h.parent_id
    ) select max(n)::int as ebene, (select checkliste_id from tco.cl_schritte where id = ${id}) as checkliste from hoch`;
  return r?.checkliste == null ? null : { checkliste: Number(r.checkliste), ebene: Number(r.ebene) };
}
/** IDs des Schritts und aller Schritte darunter; `hoehe` = Stufen des Teilbaums (1 = nur der Schritt selbst) */
async function teilbaum(tx: Db, id: number): Promise<{ ids: number[]; hoehe: number }> {
  const rows = await tx`
    with recursive runter as (
      select id, 1 as n from tco.cl_schritte where id = ${id}
      union all select s.id, r.n + 1 from tco.cl_schritte s join runter r on s.parent_id = r.id
    ) select id, n from runter`;
  return { ids: rows.map((r) => Number(r.id)), hoehe: Math.max(1, ...rows.map((r) => Number(r.n))) };
}
/** Teilbaum (Schritt mit allen Unterschritten) kopieren – ohne Stand */
async function teilbaumKopieren(tx: Db, quelle: number, checkliste: number, parent: number | null, pos: number): Promise<number> {
  const [n] = await tx`
    insert into tco.cl_schritte (checkliste_id, parent_id, pos, titel, beschreibung, verantwortlich, tage_vor, faellig)
    select ${checkliste}, ${parent}, ${pos}, titel, beschreibung, verantwortlich, tage_vor, faellig from tco.cl_schritte where id = ${quelle} returning id`;
  let anzahl = 1;
  const kinder = (await tx`select id from tco.cl_schritte where parent_id = ${quelle} order by pos, id`).map((x) => x.id as number);
  for (const [i, k] of kinder.entries()) anzahl += await teilbaumKopieren(tx, k, checkliste, n.id as number, i + 1);
  return anzahl;
}
/** Geschwister (gleiche Checkliste, gleicher übergeordneter Schritt) fortlaufend nummerieren */
async function nummerieren(tx: Db, ids: number[]) {
  if (!ids.length) return;
  const pos = ids.map((_, i) => i + 1);
  await tx`update tco.cl_schritte s set pos = x.pos from unnest(${ids}::int[], ${pos}::int[]) as x(id, pos) where s.id = x.id`;
}
const geschwister = async (tx: Db, checkliste: number, parent: number | null, ohne = 0) =>
  (await tx`select id from tco.cl_schritte where checkliste_id = ${checkliste} and parent_id is not distinct from ${parent} and id <> ${ohne} order by pos, id`).map((x) => x.id as number);

export async function schrittAnlegen(tx: Db, checkliste: number, e: SchrittEingabe, wer: string): Promise<number> {
  schrittPruefen(e);
  const [c] = await tx`select 1 from tco.cl_checklisten where id = ${checkliste}`;
  if (!c) throw new BusinessError('Checkliste nicht gefunden.', 404);
  const parent = e.parent_id ?? null;
  if (parent !== null) {
    const p = await stufeVon(tx, parent);
    if (!p || p.checkliste !== checkliste) throw new BusinessError('Der übergeordnete Schritt gehört nicht zu dieser Checkliste.');
    if (p.ebene >= MAX_STUFEN) throw new BusinessError(`Schritte lassen sich höchstens in ${MAX_STUFEN} Stufen schachteln.`);
    // der übergeordnete Schritt wird zur Gruppe – sein eigener Haken entfällt, es zählen die Unterschritte
    await tx`delete from tco.cl_erledigt where schritt_id = ${parent}`;
  }
  const [r] = await tx`
    insert into tco.cl_schritte (checkliste_id, parent_id, pos, titel, beschreibung, verantwortlich, tage_vor, faellig)
    values (${checkliste}, ${parent}, (select coalesce(max(pos), 0) + 1 from tco.cl_schritte where checkliste_id = ${checkliste} and parent_id is not distinct from ${parent}),
            ${e.titel.trim()}, ${leer(e.beschreibung)}, ${leer(e.verantwortlich)}, ${e.tage_vor ?? null}, ${e.faellig || null}) returning id`;
  await beruehren(tx, checkliste, wer);
  return r.id as number;
}

export async function schrittAendern(tx: Db, id: number, e: SchrittEingabe, wer: string) {
  schrittPruefen(e);
  const [r] = await tx`
    update tco.cl_schritte set titel = ${e.titel.trim()}, beschreibung = ${leer(e.beschreibung)}, verantwortlich = ${leer(e.verantwortlich)},
           tage_vor = ${e.tage_vor ?? null}, faellig = ${e.faellig || null}
    where id = ${id} returning checkliste_id`;
  if (!r) throw new BusinessError('Schritt nicht gefunden.', 404);
  await beruehren(tx, r.checkliste_id as number, wer);
}

/** Schritt löschen – mit allen Unterschritten */
export async function schrittLoeschen(tx: Db, id: number, wer: string) {
  const [r] = await tx`delete from tco.cl_schritte where id = ${id} returning checkliste_id`;
  if (!r) throw new BusinessError('Schritt nicht gefunden.', 404);
  await beruehren(tx, r.checkliste_id as number, wer);
}

/** Reihenfolge einer Geschwisterreihe festlegen – `ids` muss genau die Schritte unter demselben übergeordneten Schritt enthalten */
export async function schritteOrdnen(tx: Db, checkliste: number, ids: number[], wer: string) {
  const fehler = () => new BusinessError('Die Schritte haben sich inzwischen geändert – bitte neu laden.', 409);
  if (!ids.length || new Set(ids).size !== ids.length) throw fehler();
  const [erster] = await tx`select parent_id from tco.cl_schritte where id = ${ids[0]} and checkliste_id = ${checkliste}`;
  if (!erster) throw fehler();
  const vorhanden = await geschwister(tx, checkliste, erster.parent_id as number | null);
  if (vorhanden.length !== ids.length || !ids.every((i) => vorhanden.includes(i))) throw fehler();
  await nummerieren(tx, ids);
  await beruehren(tx, checkliste, wer);
}

/**
 * Schritte (auch aus verschiedenen Checklisten) ans Ende einer anderen Checkliste kopieren – mit ihren Unterschritten,
 * ohne Stand. Ist ein Schritt samt einem seiner Unterschritte gewählt, wird der Unterschritt nicht doppelt kopiert.
 */
export async function schritteKopieren(tx: Db, ids: number[], ziel: number, wer: string): Promise<number> {
  const [c] = await tx`select 1 from tco.cl_checklisten where id = ${ziel}`;
  if (!c) throw new BusinessError('Die Ziel-Checkliste gibt es nicht (mehr).', 404);
  const gewaehlt = await tx`select id, checkliste_id, pos from tco.cl_schritte where id = any(${ids}) order by checkliste_id, pos, id`;
  if (!gewaehlt.length) throw new BusinessError('Bitte mindestens einen Schritt wählen.');
  const drin = new Set<number>();
  const wurzeln: number[] = [];
  for (const g of gewaehlt) {
    if (drin.has(Number(g.id))) continue;
    // liegt ein gewählter Schritt unter einem anderen gewählten, kommt er mit dessen Teilbaum
    const [oben] = await tx`
      with recursive hoch as (select parent_id from tco.cl_schritte where id = ${g.id} union all select s.parent_id from tco.cl_schritte s join hoch h on s.id = h.parent_id)
      select 1 from hoch where parent_id = any(${ids}) limit 1`;
    if (oben) continue;
    wurzeln.push(Number(g.id));
    for (const x of (await teilbaum(tx, Number(g.id))).ids) drin.add(x);
  }
  const [{ pos }] = await tx`select coalesce(max(pos), 0)::int as pos from tco.cl_schritte where checkliste_id = ${ziel} and parent_id is null`;
  let anzahl = 0;
  for (const [i, w] of wurzeln.entries()) anzahl += await teilbaumKopieren(tx, w, ziel, null, Number(pos) + i + 1);
  await beruehren(tx, ziel, wer);
  return anzahl;
}

/** Veranstaltungen des Kalenders zuordnen (bereits zugeordnete bleiben) */
export async function eventsZuordnen(tx: Db, checkliste: number, events: number[], wer: string): Promise<number> {
  const [c] = await tx`select 1 from tco.cl_checklisten where id = ${checkliste}`;
  if (!c) throw new BusinessError('Checkliste nicht gefunden.', 404);
  const r = await tx`
    insert into tco.cl_bezuege (checkliste_id, event_id)
    select ${checkliste}, e.id from tco.kal_events e
    where e.id = any(${events}) and not exists (select 1 from tco.cl_bezuege b where b.checkliste_id = ${checkliste} and b.event_id = e.id)
    returning id`;
  await beruehren(tx, checkliste, wer);
  return r.length;
}

export async function terminZuordnen(tx: Db, checkliste: number, e: { termin: string; bezeichnung?: string | null }, wer: string): Promise<number> {
  const [c] = await tx`select 1 from tco.cl_checklisten where id = ${checkliste}`;
  if (!c) throw new BusinessError('Checkliste nicht gefunden.', 404);
  const [r] = await tx`insert into tco.cl_bezuege (checkliste_id, termin, bezeichnung) values (${checkliste}, ${e.termin}, ${leer(e.bezeichnung)}) returning id`;
  await beruehren(tx, checkliste, wer);
  return r.id as number;
}

export async function bezugLoeschen(tx: Db, id: number, wer: string) {
  const [r] = await tx`delete from tco.cl_bezuege where id = ${id} returning checkliste_id`;
  if (!r) throw new BusinessError('Zuordnung nicht gefunden.', 404);
  await beruehren(tx, r.checkliste_id as number, wer);
}

/** Schritt für einen Bezug abhaken bzw. wieder öffnen – bei einem Schritt mit Unterschritten gilt es für alle Blätter darunter */
export async function abhaken(tx: Db, bezug: number, schritt: number, e: { erledigt: boolean; notiz?: string | null }, wer: string) {
  const [p] = await tx`
    select 1 from tco.cl_bezuege b join tco.cl_schritte s on s.checkliste_id = b.checkliste_id where b.id = ${bezug} and s.id = ${schritt}`;
  if (!p) throw new BusinessError('Schritt und Veranstaltung gehören nicht zur selben Checkliste.', 404);
  const alle = (await teilbaum(tx, schritt)).ids;
  const blaetter = (await tx`select s.id from tco.cl_schritte s where s.id = any(${alle}) and not exists (select 1 from tco.cl_schritte k where k.parent_id = s.id)`).map((x) => Number(x.id));
  if (!e.erledigt) { await tx`delete from tco.cl_erledigt where bezug_id = ${bezug} and schritt_id = any(${blaetter})`; return; }
  const einzeln = blaetter.length === 1 && blaetter[0] === schritt;
  for (const b of blaetter) {
    // beim Abhaken einer Gruppe bleiben bereits erledigte Unterschritte, wie sie sind (Datum, Name, Notiz)
    await tx`
      insert into tco.cl_erledigt (bezug_id, schritt_id, erledigt_von, notiz) values (${bezug}, ${b}, ${wer}, ${leer(e.notiz)})
      on conflict (bezug_id, schritt_id) do ${einzeln ? tx`update set notiz = excluded.notiz` : tx`nothing`}`;
  }
}

export async function kategorieSpeichern(tx: Db, e: { id?: number | null; name: string; aktiv?: boolean }): Promise<number> {
  const name = e.name.trim();
  const [d] = await tx`select id from tco.cl_kategorien where lower(name) = lower(${name}) and id <> ${e.id ?? 0}`;
  if (d) throw new BusinessError(`Die Kategorie „${name}“ gibt es schon.`);
  if (e.id) {
    const [r] = await tx`update tco.cl_kategorien set name = ${name}, aktiv = ${e.aktiv ?? true} where id = ${e.id} returning id`;
    if (!r) throw new BusinessError('Kategorie nicht gefunden.', 404);
    return r.id as number;
  }
  const [r] = await tx`insert into tco.cl_kategorien (name, aktiv) values (${name}, ${e.aktiv ?? true}) returning id`;
  return r.id as number;
}

/** Kategorie löschen – nur, solange keine Checkliste sie verwendet (sonst abschalten) */
export async function kategorieLoeschen(tx: Db, id: number) {
  const [{ n }] = await tx`select count(*)::int as n from tco.cl_checklisten where kategorie_id = ${id}`;
  if (n) throw new BusinessError(`Die Kategorie wird von ${n} Checkliste${n === 1 ? '' : 'n'} verwendet – bitte abschalten statt löschen.`);
  const r = await tx`delete from tco.cl_kategorien where id = ${id} returning id`;
  if (!r.length) throw new BusinessError('Kategorie nicht gefunden.', 404);
}

// ---------------------------------------------------------------- Baum: Verschieben

/** Checkliste in eine andere Kategorie verschieben (null = ohne Kategorie) */
export async function kategorieSetzen(tx: Db, id: number, kategorie: number | null, wer: string) {
  await kategoriePruefen(tx, kategorie);
  const r = await tx`update tco.cl_checklisten set kategorie_id = ${kategorie}, geaendert_am = now(), geaendert_von = ${wer} where id = ${id} returning id`;
  if (!r.length) throw new BusinessError('Checkliste nicht gefunden.', 404);
}

/**
 * Schritt mit seinen Unterschritten verschieben – in eine andere Checkliste, unter einen anderen Schritt und/oder an eine
 * andere Stelle: vor den Schritt `vor` (auf dessen Stufe), sonst ans Ende unter `unter`, sonst ans Ende der obersten Stufe.
 * Wechselt der Schritt die Checkliste, entfällt sein Stand (er gehörte zu den Veranstaltungen der alten Checkliste).
 */
export async function schrittVerschieben(tx: Db, id: number, ziel: number, vor: number | null, wer: string, unter: number | null = null) {
  const s = await stufeVon(tx, id);
  if (!s) throw new BusinessError('Schritt nicht gefunden.', 404);
  const [c] = await tx`select 1 from tco.cl_checklisten where id = ${ziel}`;
  if (!c) throw new BusinessError('Die Ziel-Checkliste gibt es nicht (mehr).', 404);
  const baum = await teilbaum(tx, id);
  let parent: number | null = unter;
  if (vor !== null) {
    const [v] = await tx`select parent_id from tco.cl_schritte where id = ${vor} and checkliste_id = ${ziel}`;
    if (!v || vor === id) throw new BusinessError('Die Schritte haben sich inzwischen geändert – bitte neu laden.', 409);
    parent = v.parent_id as number | null;
  }
  let ebene = 1;
  if (parent !== null) {
    if (baum.ids.includes(parent)) throw new BusinessError('Ein Schritt lässt sich nicht unter sich selbst oder einen seiner Unterschritte verschieben.');
    const p = await stufeVon(tx, parent);
    if (!p || p.checkliste !== ziel) throw new BusinessError('Der übergeordnete Schritt gehört nicht zur Ziel-Checkliste.', 409);
    ebene = p.ebene + 1;
  }
  if (ebene + baum.hoehe - 1 > MAX_STUFEN) throw new BusinessError(`Schritte lassen sich höchstens in ${MAX_STUFEN} Stufen schachteln – an dieser Stelle wären es ${ebene + baum.hoehe - 1}.`);
  const [alt] = await tx`select parent_id from tco.cl_schritte where id = ${id}`;
  const reihe = await geschwister(tx, ziel, parent, id);
  reihe.splice(vor === null ? reihe.length : reihe.indexOf(vor), 0, id);
  if (s.checkliste !== ziel) {
    await tx`delete from tco.cl_erledigt where schritt_id = any(${baum.ids})`;
    await tx`update tco.cl_schritte set checkliste_id = ${ziel} where id = any(${baum.ids})`;
    await beruehren(tx, s.checkliste, wer);
  }
  // der neue übergeordnete Schritt wird zur Gruppe – sein eigener Haken entfällt
  if (parent !== null) await tx`delete from tco.cl_erledigt where schritt_id = ${parent}`;
  await tx`update tco.cl_schritte set parent_id = ${parent} where id = ${id}`;
  await nummerieren(tx, reihe);
  await nummerieren(tx, await geschwister(tx, s.checkliste, alt.parent_id as number | null));
  await beruehren(tx, ziel, wer);
}

// ---------------------------------------------------------------- Import aus der Zwischenablage (Tabelle)

export const IMPORT_SPALTEN = ['Kategorie', 'Checkliste', 'Schritt', 'Verantwortlich', 'Termin', 'Hinweise'] as const;
type ImportSpalte = typeof IMPORT_SPALTEN[number];
export interface ImportZeile { zeile: number; kategorie: string; checkliste: string; /** Schritt, bei Unterschritten der ganze Weg „Aufbau > Zelt > Heringe“ */ schritt: string; /** der Weg in Teilen */ pfad: string[]; verantwortlich: string; hinweise: string; tage_vor: number | null; faellig: string | null }
export interface ImportGelesen { zeilen: ImportZeile[]; fehler: string[]; kopfzeile: boolean }

/** Termin einer Importzeile: leer, Zahl (Tage vorher; negativ = danach), „14 Tage vorher/danach“, „am Tag“, Datum TT.MM.JJJJ oder JJJJ-MM-TT */
export function importTermin(text: string): Terminbezug | null {
  const t = text.trim().toLowerCase();
  if (!t || t === '-' || t === '–') return { tage_vor: null, faellig: null };
  let m = /^(?:bis\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) || new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) !== iso ? null : { tage_vor: null, faellig: iso };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Number.isNaN(Date.parse(`${t}T12:00:00Z`)) ? null : { tage_vor: null, faellig: t };
  if (/^-?\d{1,3}$/.test(t)) return { tage_vor: Number(t), faellig: null };
  if (/^am tag/.test(t)) return { tage_vor: 0, faellig: null };
  m = /^(\d{1,3})\s*(tage?|wochen?)\s*(vorher|davor|vor|danach|nachher|nach)$/.exec(t);
  if (m) {
    const n = Number(m[1]) * (m[2].startsWith('woche') ? 7 : 1);
    return { tage_vor: /^(danach|nachher|nach)$/.test(m[3]) ? -n : n, faellig: null };
  }
  return null;
}

/**
 * Tabelle aus der Zwischenablage lesen (aus Excel kopiert: Spalten durch Tabulator getrennt; ersatzweise Semikolon).
 * Spalten in der Reihenfolge Kategorie · Checkliste · Schritt · Verantwortlich · Termin · Hinweise – oder beliebig, wenn die
 * erste Zeile die Spaltennamen enthält. Leere Zellen bei Kategorie und Checkliste übernehmen den Wert der Zeile darüber.
 * Unterschritte stehen in der Spalte Schritt als Weg mit „>“: „Aufbau > Zelt > Heringe“ (höchstens fünf Stufen).
 */
export function importLesen(text: string): ImportGelesen {
  const roh = text.replace(/\r\n?/g, '\n').split('\n').map((z, i) => ({ nr: i + 1, z })).filter((x) => x.z.trim());
  const fehler: string[] = [];
  if (!roh.length) return { zeilen: [], fehler: ['Die Zwischenablage enthält keine Zeilen.'], kopfzeile: false };
  const trenner = roh.some((x) => x.z.includes('\t')) ? '\t' : ';';
  const zellen = (z: string) => z.split(trenner).map((c) => c.trim().replace(/^"(.*)"$/s, '$1').replace(/""/g, '"').trim());
  const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöüß]/g, '');
  const NAMEN: Record<string, ImportSpalte> = {
    kategorie: 'Kategorie', checkliste: 'Checkliste', event: 'Checkliste', veranstaltung: 'Checkliste', thema: 'Checkliste',
    schritt: 'Schritt', aufgabe: 'Schritt', punkt: 'Schritt', verantwortlich: 'Verantwortlich', wer: 'Verantwortlich', zuständig: 'Verantwortlich',
    termin: 'Termin', fällig: 'Termin', faellig: 'Termin', wann: 'Termin', hinweise: 'Hinweise', hinweis: 'Hinweise', beschreibung: 'Hinweise', bemerkung: 'Hinweise',
  };
  const erste = zellen(roh[0].z).map((c) => NAMEN[norm(c)]);
  const kopfzeile = erste.filter(Boolean).length >= 2 && erste.includes('Schritt');
  const spalte = new Map<ImportSpalte, number>();
  if (kopfzeile) erste.forEach((n, i) => { if (n && !spalte.has(n)) spalte.set(n, i); });
  else IMPORT_SPALTEN.forEach((n, i) => spalte.set(n, i));
  const zeilen: ImportZeile[] = [];
  let kategorie = '', checkliste = '';
  for (const { nr, z } of roh.slice(kopfzeile ? 1 : 0)) {
    const c = zellen(z);
    const wert = (n: ImportSpalte) => (spalte.has(n) ? c[spalte.get(n)!] ?? '' : '');
    // neue Checkliste ohne Kategorie in der Zeile: die Kategorie gilt weiter (verbundene Zellen)
    if (wert('Kategorie')) kategorie = wert('Kategorie');
    if (wert('Checkliste')) checkliste = wert('Checkliste');
    const schritt = wert('Schritt');
    if (!checkliste) { fehler.push(`Zeile ${nr}: Es fehlt die Checkliste.`); continue; }
    if (checkliste.length > 160 || kategorie.length > 80 || schritt.length > 200) { fehler.push(`Zeile ${nr}: Ein Text ist zu lang (Kategorie 80, Checkliste 160, Schritt 200 Zeichen).`); continue; }
    const pfad = schritt.split('>').map((t) => t.trim()).filter(Boolean);
    if (pfad.length > MAX_STUFEN) { fehler.push(`Zeile ${nr}: „${schritt}“ hat ${pfad.length} Stufen – erlaubt sind höchstens ${MAX_STUFEN}.`); continue; }
    const termin = importTermin(wert('Termin'));
    if (!termin) { fehler.push(`Zeile ${nr}: Termin „${wert('Termin')}“ nicht erkannt – erlaubt sind z. B. 14, „14 Tage vorher“, „3 Tage danach“, „am Tag“ oder ein Datum (TT.MM.JJJJ).`); continue; }
    zeilen.push({ zeile: nr, kategorie, checkliste, schritt: pfad.join(' > '), pfad, verantwortlich: wert('Verantwortlich').slice(0, 120), hinweise: wert('Hinweise').slice(0, 2000), ...termin });
  }
  if (!zeilen.length && !fehler.length) fehler.push('Keine Datenzeile gefunden.');
  return { zeilen, fehler, kopfzeile };
}

export interface ImportErgebnis { kategorien: string[]; checklisten: string[]; ergaenzt: string[]; schritte: number }

/**
 * Gelesene Zeilen übernehmen (`schreiben` = false: nur zeigen, was geschähe). Kategorien und Checklisten werden am Namen
 * erkannt (Groß-/Kleinschreibung egal): fehlende werden angelegt, an bestehende Checklisten werden die Schritte angefügt.
 * Bei einem Weg („Aufbau > Zelt“) wird der übergeordnete Schritt am Titel gesucht und sonst angelegt; der letzte Teil
 * ist immer ein neuer Schritt.
 */
export async function importAusfuehren(tx: Db, zeilen: ImportZeile[], wer: string, schreiben: boolean): Promise<ImportErgebnis> {
  const kat = new Map((await tx`select id, name from tco.cl_kategorien`).map((k) => [(k.name as string).toLowerCase(), k.id as number]));
  const cl = new Map((await tx`select id, titel from tco.cl_checklisten order by id desc`).map((c) => [(c.titel as string).toLowerCase(), c.id as number]));
  const e: ImportErgebnis = { kategorien: [], checklisten: [], ergaenzt: [], schritte: 0 };
  let ersatz = -1;   // Platzhalter-IDs in der Vorschau
  /** in diesem Import gefundene bzw. angelegte Schritte: Checkliste|übergeordnet|titel → ID */
  const gruppen = new Map<string, number>();
  for (const z of zeilen) {
    let k: number | null = null;
    if (z.kategorie) {
      k = kat.get(z.kategorie.toLowerCase()) ?? null;
      if (k === null) {
        k = schreiben ? await kategorieSpeichern(tx, { name: z.kategorie }) : ersatz--;
        kat.set(z.kategorie.toLowerCase(), k);
        e.kategorien.push(z.kategorie);
      }
    }
    let c = cl.get(z.checkliste.toLowerCase());
    if (c === undefined) {
      c = schreiben ? await checklisteAnlegen(tx, { titel: z.checkliste, kategorie_id: k }, wer) : ersatz--;
      cl.set(z.checkliste.toLowerCase(), c);
      e.checklisten.push(z.checkliste);
    } else if (z.schritt && !e.checklisten.some((t) => t.toLowerCase() === z.checkliste.toLowerCase()) && !e.ergaenzt.some((t) => t.toLowerCase() === z.checkliste.toLowerCase())) {
      e.ergaenzt.push(z.checkliste);
    }
    if (!z.pfad.length) continue;
    // Weg hinab: übergeordnete Schritte am Titel finden oder anlegen
    let parent: number | null = null;
    for (const teil of z.pfad.slice(0, -1)) {
      const k = `${c}|${parent ?? 0}|${teil.toLowerCase()}`;
      let id: number | undefined = gruppen.get(k);
      if (id === undefined && c > 0) {
        const da: { id: number }[] = await tx<{ id: number }[]>`select id from tco.cl_schritte where checkliste_id = ${c} and parent_id is not distinct from ${parent} and lower(titel) = lower(${teil}) order by pos, id limit 1`;
        if (da[0]) id = Number(da[0].id);
      }
      if (id === undefined) id = schreiben ? await schrittAnlegen(tx, c, { titel: teil, parent_id: parent }, wer) : ersatz--;
      gruppen.set(k, id);
      parent = id;
    }
    const titel = z.pfad.at(-1)!;
    const neu: number = schreiben
      ? await schrittAnlegen(tx, c, { titel, beschreibung: z.hinweise, verantwortlich: z.verantwortlich, tage_vor: z.tage_vor, faellig: z.faellig, parent_id: parent }, wer)
      : ersatz--;
    // eine spätere Zeile darf diesen Schritt als übergeordneten nennen („Aufbau“, dann „Aufbau > Zelt“)
    gruppen.set(`${c}|${parent ?? 0}|${titel.toLowerCase()}`, neu);
    e.schritte++;
  }
  return e;
}
