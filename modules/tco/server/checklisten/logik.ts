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
export interface Schritt extends Terminbezug { id: number; pos: number; titel: string; beschreibung: string | null; verantwortlich: string | null; termin_text: string }
export interface Erledigt { am: string; von: string | null; notiz: string | null }
export interface BezugSchritt { schritt_id: number; faellig: string | null; stand: Stand; erledigt: Erledigt | null }
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
  const schritte = await db<(Omit<Schritt, 'termin_text'> & { checkliste_id: number })[]>`
    select id, checkliste_id, pos, titel, beschreibung, verantwortlich, tage_vor, faellig
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
    const s = schritte.filter((x) => x.checkliste_id === c.id).map(({ checkliste_id: _c, ...x }) => ({ ...x, termin_text: terminText(x) }));
    const b = bezuege.filter((x) => x.checkliste_id === c.id).map(({ checkliste_id: _c, ...x }) => {
      const zeilen: BezugSchritt[] = s.map((sch) => {
        const e = erl.get(`${x.id}|${sch.id}`);
        const f = faelligAm(sch, x.termin);
        return { schritt_id: sch.id, faellig: f, stand: stand(!!e, f, stichtag), erledigt: e ? { am: e.erledigt_am, von: e.erledigt_von, notiz: e.notiz } : null };
      });
      return { ...x, schritte: zeilen, fortschritt: fortschritt(zeilen.map((z) => z.stand)) };
    });
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
export interface SchrittEingabe { titel: string; beschreibung?: string | null; verantwortlich?: string | null; tage_vor?: number | null; faellig?: string | null }

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
  await tx`
    insert into tco.cl_schritte (checkliste_id, pos, titel, beschreibung, verantwortlich, tage_vor, faellig)
    select ${n.id}, pos, titel, beschreibung, verantwortlich, tage_vor, faellig from tco.cl_schritte where checkliste_id = ${id} order by pos, id`;
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

export async function schrittAnlegen(tx: Db, checkliste: number, e: SchrittEingabe, wer: string): Promise<number> {
  schrittPruefen(e);
  const [c] = await tx`select 1 from tco.cl_checklisten where id = ${checkliste}`;
  if (!c) throw new BusinessError('Checkliste nicht gefunden.', 404);
  const [r] = await tx`
    insert into tco.cl_schritte (checkliste_id, pos, titel, beschreibung, verantwortlich, tage_vor, faellig)
    values (${checkliste}, (select coalesce(max(pos), 0) + 1 from tco.cl_schritte where checkliste_id = ${checkliste}),
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

export async function schrittLoeschen(tx: Db, id: number, wer: string) {
  const [r] = await tx`delete from tco.cl_schritte where id = ${id} returning checkliste_id`;
  if (!r) throw new BusinessError('Schritt nicht gefunden.', 404);
  await beruehren(tx, r.checkliste_id as number, wer);
}

/** Reihenfolge der Schritte einer Checkliste festlegen – `ids` muss genau ihre Schritte enthalten */
export async function schritteOrdnen(tx: Db, checkliste: number, ids: number[], wer: string) {
  const vorhanden = (await tx`select id from tco.cl_schritte where checkliste_id = ${checkliste}`).map((x) => x.id as number);
  if (vorhanden.length !== ids.length || new Set(ids).size !== ids.length || !ids.every((i) => vorhanden.includes(i))) {
    throw new BusinessError('Die Schritte haben sich inzwischen geändert – bitte neu laden.', 409);
  }
  const pos = ids.map((_, i) => i + 1);
  await tx`update tco.cl_schritte s set pos = x.pos from unnest(${ids}::int[], ${pos}::int[]) as x(id, pos) where s.id = x.id`;
  await beruehren(tx, checkliste, wer);
}

/** Schritte (auch aus verschiedenen Checklisten) ans Ende einer anderen Checkliste kopieren – ohne Stand */
export async function schritteKopieren(tx: Db, ids: number[], ziel: number, wer: string): Promise<number> {
  const [c] = await tx`select 1 from tco.cl_checklisten where id = ${ziel}`;
  if (!c) throw new BusinessError('Die Ziel-Checkliste gibt es nicht (mehr).', 404);
  const r = await tx`
    insert into tco.cl_schritte (checkliste_id, pos, titel, beschreibung, verantwortlich, tage_vor, faellig)
    select ${ziel}, (select coalesce(max(pos), 0) from tco.cl_schritte where checkliste_id = ${ziel}) + row_number() over (order by s.checkliste_id, s.pos, s.id),
           s.titel, s.beschreibung, s.verantwortlich, s.tage_vor, s.faellig
    from tco.cl_schritte s where s.id = any(${ids}) returning id`;
  if (!r.length) throw new BusinessError('Bitte mindestens einen Schritt wählen.');
  await beruehren(tx, ziel, wer);
  return r.length;
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

/** Schritt für einen Bezug abhaken bzw. wieder öffnen */
export async function abhaken(tx: Db, bezug: number, schritt: number, e: { erledigt: boolean; notiz?: string | null }, wer: string) {
  const [p] = await tx`
    select 1 from tco.cl_bezuege b join tco.cl_schritte s on s.checkliste_id = b.checkliste_id where b.id = ${bezug} and s.id = ${schritt}`;
  if (!p) throw new BusinessError('Schritt und Veranstaltung gehören nicht zur selben Checkliste.', 404);
  if (!e.erledigt) { await tx`delete from tco.cl_erledigt where bezug_id = ${bezug} and schritt_id = ${schritt}`; return; }
  await tx`
    insert into tco.cl_erledigt (bezug_id, schritt_id, erledigt_von, notiz) values (${bezug}, ${schritt}, ${wer}, ${leer(e.notiz)})
    on conflict (bezug_id, schritt_id) do update set notiz = excluded.notiz`;
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
