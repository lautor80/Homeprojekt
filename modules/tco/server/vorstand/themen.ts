/**
 * Vorstandssitzungen – Themenparkplatz: Themen sammeln, beschreiben, priorisieren und für einen Zeitraum vormerken.
 *
 *  - Ein Thema hat einen Einreicher (verantwortlich, wird Verantwortlicher des Tagesordnungspunkts), eine Priorität
 *    (1 hoch, 2 mittel, 3 niedrig), einen Zeitraum für die Besprechung (von–bis, Pflicht) und Anlagen (Dateien, Links).
 *  - Zuordnen: aus dem Thema wird ein Tagesordnungspunkt der Sitzung (Titel, Einreicher, Beschreibung, Anlagen kopiert).
 *  - Wieder parken: Punkt einer geplanten Sitzung ohne Protokoll wird entfernt, sonst „vertagt“; das Thema ist wieder frei.
 *    Wird ein zugeordneter Punkt anders vertagt oder gelöscht, ist das Thema ebenfalls wieder geparkt.
 *  - Vorschlag: Liegt das Datum einer Sitzung im Zeitraum eines geparkten Themas, wird es in der Sitzung vorgeschlagen;
 *    beim Anlegen mit „Tagesordnung vorschlagen“ wird es gleich eingeplant (nach Priorität).
 *  - Stand: GEPARKT · EINGEPLANT (Punkt offen) · BESPROCHEN (Punkt erledigt) · ABGESCHLOSSEN (ohne Sitzung erledigt/zurückgezogen)
 *  - Verlauf: Das Thema merkt sich die Kette seiner Tagesordnungspunkte (verlauf.ts) – parken und wieder aufnehmen setzt sie fort.
 *
 * Rechte: Themen einreichen und eigene ändern mit tco.vorstand:display; fremde Themen ändern, zuordnen und parken mit
 * tco.vorstand:edit.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import { dat } from '../format.js';
import type { Db } from '../verein.js';
import { linkPruefen } from './format.js';
import { ANLAGE_MAX, anlageAnlegen, linkAnlegen, topAnlegen } from './logik.js';
import { sitzungNr } from './regeln.js';
import { verlaufLesen, type VerlaufPunkt } from './verlauf.js';

export type ThemaStand = 'GEPARKT' | 'EINGEPLANT' | 'BESPROCHEN' | 'ABGESCHLOSSEN';
export const STAND_TEXT: Record<ThemaStand, string> = { GEPARKT: 'geparkt', EINGEPLANT: 'eingeplant', BESPROCHEN: 'besprochen', ABGESCHLOSSEN: 'abgeschlossen' };
export const PRIO_TEXT: Record<number, string> = { 1: 'hoch', 2: 'mittel', 3: 'niedrig' };
/** Anlagen je Thema zusammen */
export const THEMA_ANLAGEN_MAX = 30 * 1024 * 1024;

export interface ThemaAnlage { id: number; dateiname: string; mime: string; groesse: number; url: string | null; erstellt_am: string; erstellt_von: string | null }
export interface Thema {
  id: number; titel: string; beschreibung: string | null; prioritaet: 1 | 2 | 3; prioritaet_text: string;
  einreicher: string; eigenes: boolean; von: string; bis: string;
  stand: ThemaStand; stand_text: string; ueberfaellig: boolean;
  /** geparkt und der Besprechungszeitraum beginnt in höchstens 30 Tagen (BALD) bzw. hat schon begonnen (VERSPAETET) */
  frist: ThemaFrist;
  /** zugeordnete Sitzung (eingeplant/besprochen) bzw. zuletzt zugeordnete (geparkt) */
  sitzung: { id: number; nr: string; datum: string; status: string; top_id: number | null; vertagt: boolean } | null;
  abgeschlossen_am: string | null; abgeschlossen_von: string | null; abschluss_grund: string | null;
  anlagen: ThemaAnlage[];
  /** Kette der Tagesordnungspunkte (leer = noch nie in einer Sitzung) und – beim Lesen eines einzelnen Themas – deren Verlauf */
  kette: number | null; verlauf?: VerlaufPunkt[];
  erstellt_am: string; erstellt_von: string | null; geaendert_am: string; geaendert_von: string | null;
}
export interface ThemaEingabe { titel: string; beschreibung?: string | null; prioritaet: 1 | 2 | 3; einreicher?: string | null; von: string; bis: string }

const leer = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const zeit = (z: unknown) => (z ? new Date(z as string).toISOString() : null);

// ---------------------------------------------------------------- reine Regeln (ohne Datenbank)

/** Stand eines Themas aus Abschluss und zugeordnetem Tagesordnungspunkt */
export function themaStand(t: { abgeschlossen: boolean; top_status: 'OFFEN' | 'ERLEDIGT' | 'VERTAGT' | null }): ThemaStand {
  if (t.abgeschlossen) return 'ABGESCHLOSSEN';
  if (t.top_status === 'ERLEDIGT') return 'BESPROCHEN';
  if (t.top_status === 'OFFEN') return 'EINGEPLANT';
  return 'GEPARKT';
}

export type ThemaFrist = 'VERSPAETET' | 'BALD' | null;
/** Vorlauf, ab dem ein geparktes Thema als „bald fällig“ gilt (Tage vor Beginn des Zeitraums) */
export const FRIST_VORLAUF_TAGE = 30;
const plusTage = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * Frist eines geparkten Themas: Beginn des Zeitraums erreicht (≤ heute) = verspätet (rot);
 * Beginn in den nächsten 30 Tagen (≤ heute + 30) = bald (orange). Eingeplante und erledigte Themen haben keine Frist.
 */
export function themaFrist(t: { stand: ThemaStand; von: string }, stichtag: string): ThemaFrist {
  if (t.stand !== 'GEPARKT') return null;
  if (t.von <= stichtag) return 'VERSPAETET';
  if (t.von <= plusTage(stichtag, FRIST_VORLAUF_TAGE)) return 'BALD';
  return null;
}

/** Kennzahl für die Übersicht: geparkte Themen, davon verspätet und bald fällig */
export function themenZaehlen(l: { stand: ThemaStand; frist: ThemaFrist }[]) {
  const geparkt = l.filter((t) => t.stand === 'GEPARKT');
  return { geparkt: geparkt.length, verspaetet: geparkt.filter((t) => t.frist === 'VERSPAETET').length, bald: geparkt.filter((t) => t.frist === 'BALD').length };
}

/** Liegt die Sitzung im Zeitraum des Themas? (Daten als JJJJ-MM-TT) */
export const imZeitraum = (t: { von: string; bis: string }, datum: string) => t.von <= datum && datum <= t.bis;

/** Reihenfolge der Vorschläge: Priorität, dann früheres Zeitraum-Ende, dann älteres Thema */
export function vorschlagOrdnung(a: { prioritaet: number; bis: string; id: number }, b: { prioritaet: number; bis: string; id: number }) {
  return a.prioritaet - b.prioritaet || a.bis.localeCompare(b.bis) || a.id - b.id;
}

export function zeitraumPruefen(von: string, bis: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(von) || !/^\d{4}-\d{2}-\d{2}$/.test(bis)) throw new BusinessError('Bitte den Zeitraum für die Besprechung angeben (von und bis).');
  if (bis < von) throw new BusinessError('Das Ende des Zeitraums liegt vor dem Beginn.');
}

// ---------------------------------------------------------------- lesen

const THEMA_SQL = (db: Db) => db`
  th.*, t.status as top_status, t.sitzung_id as top_sitzung, coalesce(th.kette, t.kette, t.id) as kette_k,
  coalesce(t.sitzung_id, th.zuletzt_sitzung_id) as s_id,
  s.jahr as s_jahr, s.lfd as s_lfd, s.status as s_status,
  coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum)::text as s_datum`;
const THEMA_FROM = (db: Db) => db`
  tco.vs_themen th
  left join tco.vs_tops t on t.id = th.top_id
  left join tco.vs_sitzungen s on s.id = coalesce(t.sitzung_id, th.zuletzt_sitzung_id)
  left join tco.kal_events e on e.id = s.event_id`;

function themaAus(r: Record<string, unknown>, anlagen: ThemaAnlage[], userId: string | null, stichtag: string): Thema {
  const topStatus = (r.top_status as 'OFFEN' | 'ERLEDIGT' | 'VERTAGT' | null) ?? null;
  const stand = themaStand({ abgeschlossen: !!r.abgeschlossen_am, top_status: topStatus });
  const prio = Number(r.prioritaet) as 1 | 2 | 3;
  const bis = r.bis as string;
  return {
    id: Number(r.id), titel: r.titel as string, beschreibung: (r.beschreibung as string) ?? null, prioritaet: prio, prioritaet_text: PRIO_TEXT[prio],
    einreicher: r.einreicher as string, eigenes: !!userId && r.einreicher_user === userId, von: r.von as string, bis,
    stand, stand_text: STAND_TEXT[stand], ueberfaellig: stand === 'GEPARKT' && bis < stichtag, frist: themaFrist({ stand, von: r.von as string }, stichtag),
    sitzung: r.s_id ? {
      id: Number(r.s_id), nr: sitzungNr(Number(r.s_jahr), Number(r.s_lfd)), datum: r.s_datum as string, status: r.s_status as string,
      top_id: r.top_sitzung ? Number(r.top_id) : null, vertagt: topStatus === 'VERTAGT' || !r.top_id,
    } : null,
    abgeschlossen_am: zeit(r.abgeschlossen_am), abgeschlossen_von: (r.abgeschlossen_von as string) ?? null, abschluss_grund: (r.abschluss_grund as string) ?? null,
    anlagen, kette: r.kette_k == null ? null : Number(r.kette_k), erstellt_am: zeit(r.erstellt_am)!, erstellt_von: (r.erstellt_von as string) ?? null,
    geaendert_am: zeit(r.geaendert_am)!, geaendert_von: (r.geaendert_von as string) ?? null,
  };
}

async function anlagenLesen(db: Db, ids: number[]): Promise<Map<number, ThemaAnlage[]>> {
  const m = new Map<number, ThemaAnlage[]>();
  if (!ids.length) return m;
  for (const a of await db`select id, thema_id, dateiname, mime, groesse, url, erstellt_am, erstellt_von from tco.vs_themen_anlagen where thema_id = any(${ids}) order by id`) {
    const l = m.get(Number(a.thema_id)) ?? [];
    l.push({ id: Number(a.id), dateiname: a.dateiname as string, mime: a.mime as string, groesse: Number(a.groesse), url: (a.url as string) ?? null,
      erstellt_am: zeit(a.erstellt_am)!, erstellt_von: (a.erstellt_von as string) ?? null });
    m.set(Number(a.thema_id), l);
  }
  return m;
}

/** Themen des Parkplatzes; offen = geparkt oder eingeplant */
export async function themenLesen(db: Db, o: { offen?: boolean; ids?: number[]; userId?: string | null; stichtag: string }): Promise<Thema[]> {
  const rows = await db`
    select ${THEMA_SQL(db)} from ${THEMA_FROM(db)}
     where (${o.ids ?? null}::int[] is null or th.id = any(${o.ids ?? null}::int[]))
       and (${!!o.offen}::boolean = false or (th.abgeschlossen_am is null and (t.id is null or t.status <> 'ERLEDIGT')))
     order by (th.abgeschlossen_am is not null), (t.status is not distinct from 'ERLEDIGT'), th.prioritaet, th.bis, th.id`;
  const anl = await anlagenLesen(db, rows.map((r) => Number(r.id)));
  return rows.map((r) => themaAus(r, anl.get(Number(r.id)) ?? [], o.userId ?? null, o.stichtag));
}

export async function themaLesen(db: Db, id: number, userId: string | null, stichtag: string): Promise<Thema> {
  const [t] = await themenLesen(db, { ids: [id], userId, stichtag });
  if (!t) throw new BusinessError('Das Thema gibt es nicht (mehr).', 404);
  t.verlauf = t.kette == null ? [] : (await verlaufAlle(db, t.kette));
  return t;
}

/** Datum einer Sitzung (bei verknüpfter Veranstaltung deren Datum) */
async function sitzungDatum(db: Db, sitzungId: number): Promise<{ datum: string; status: string } | null> {
  const [s] = await db`select coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum)::text as datum, s.status
                         from tco.vs_sitzungen s left join tco.kal_events e on e.id = s.event_id where s.id = ${sitzungId}`;
  return s ? { datum: s.datum as string, status: s.status as string } : null;
}

/**
 * Themen für eine Sitzung: vorgeschlagen = geparkt und das Sitzungsdatum liegt im Zeitraum (nach Priorität);
 * weitere = übrige geparkte Themen (überfällige zuerst).
 */
export async function themenFuerSitzung(db: Db, sitzungId: number, userId: string | null, stichtag: string): Promise<{ vorgeschlagen: Thema[]; weitere: Thema[] }> {
  const s = await sitzungDatum(db, sitzungId);
  if (!s) return { vorgeschlagen: [], weitere: [] };
  const geparkt = (await themenLesen(db, { offen: true, userId, stichtag })).filter((t) => t.stand === 'GEPARKT');
  // gerade in dieser Sitzung wieder geparkt/vertagt: nicht erneut vorschlagen
  const hier = (t: Thema) => t.sitzung?.id === sitzungId;
  const vorgeschlagen = geparkt.filter((t) => imZeitraum(t, s.datum) && !hier(t)).sort(vorschlagOrdnung);
  const weitere = geparkt.filter((t) => !imZeitraum(t, s.datum) || hier(t))
    .sort((a, b) => Number(b.bis < s.datum) - Number(a.bis < s.datum) || vorschlagOrdnung(a, b));
  return { vorgeschlagen, weitere };
}

// ---------------------------------------------------------------- ändern

async function themaFuerAenderung(tx: Db, id: number, o: { userId: string | null; alle: boolean }) {
  const [t] = await tx`select th.*, tp.status as top_status from tco.vs_themen th left join tco.vs_tops tp on tp.id = th.top_id where th.id = ${id} for update of th`;
  if (!t) throw new BusinessError('Das Thema gibt es nicht (mehr).', 404);
  if (!o.alle && (!o.userId || t.einreicher_user !== o.userId)) throw new BusinessError('Nur der Einreicher oder wer Vorstandssitzungen pflegt, darf das Thema ändern.', 403);
  return t;
}

export async function themaAnlegen(tx: Db, e: ThemaEingabe, wer: { name: string; userId: string | null }): Promise<number> {
  zeitraumPruefen(e.von, e.bis);
  const [r] = await tx`
    insert into tco.vs_themen (titel, beschreibung, prioritaet, einreicher, einreicher_user, von, bis, erstellt_von, geaendert_von)
    values (${e.titel.trim()}, ${leer(e.beschreibung)}, ${e.prioritaet}, ${leer(e.einreicher) ?? wer.name}, ${wer.userId}, ${e.von}, ${e.bis}, ${wer.name}, ${wer.name})
    returning id`;
  return Number(r.id);
}

export async function themaAendern(tx: Db, id: number, e: ThemaEingabe, wer: { name: string; userId: string | null; alle: boolean }) {
  await themaFuerAenderung(tx, id, wer);
  zeitraumPruefen(e.von, e.bis);
  await tx`update tco.vs_themen set titel = ${e.titel.trim()}, beschreibung = ${leer(e.beschreibung)}, prioritaet = ${e.prioritaet},
                                    einreicher = coalesce(${leer(e.einreicher)}, einreicher), von = ${e.von}, bis = ${e.bis},
                                    geaendert_am = now(), geaendert_von = ${wer.name}
            where id = ${id}`;
}

/** abschließen ohne Sitzung (erledigt oder zurückgezogen) bzw. wieder öffnen */
export async function themaAbschliessen(tx: Db, id: number, zu: boolean, grund: string | null, wer: { name: string; userId: string | null; alle: boolean }) {
  const t = await themaFuerAenderung(tx, id, wer);
  if (zu && t.top_status === 'OFFEN') throw new BusinessError('Das Thema ist in einer Sitzung eingeplant – dort abschließen oder erst wieder parken.');
  await tx`update tco.vs_themen set abgeschlossen_am = case when ${zu} then now() end, abgeschlossen_von = ${zu ? wer.name : null}, abschluss_grund = ${zu ? leer(grund) : null},
                                    geaendert_am = now(), geaendert_von = ${wer.name} where id = ${id}`;
}

/** löschen nur, solange es nie einer Sitzung zugeordnet war */
export async function themaLoeschen(tx: Db, id: number, wer: { name: string; userId: string | null; alle: boolean }) {
  const t = await themaFuerAenderung(tx, id, wer);
  if (t.top_id || t.zuletzt_sitzung_id) throw new BusinessError('Das Thema war schon in einer Sitzung – statt löschen bitte abschließen.');
  await tx`delete from tco.vs_themen where id = ${id}`;
}

// ---------------------------------------------------------------- Anlagen

export async function themaAnlageAnlegen(tx: Db, id: number, a: { dateiname: string; mime: string; inhalt: Buffer } | { url: string; bezeichnung?: string | null },
  wer: { name: string; userId: string | null; alle: boolean }) {
  await themaFuerAenderung(tx, id, wer);
  if ('url' in a) {
    const url = linkPruefen(a.url);
    if (!url) throw new BusinessError('Bitte eine vollständige Web-Adresse angeben, z. B. https://www.tc-oberthal.de/…');
    const name = (a.bezeichnung ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || new URL(url).hostname.replace(/^www\./, '');
    await tx`insert into tco.vs_themen_anlagen (thema_id, dateiname, mime, groesse, url, erstellt_von) values (${id}, ${name}, 'text/uri-list', 0, ${url}, ${wer.name})`;
    return;
  }
  if (a.inhalt.length > ANLAGE_MAX) throw new BusinessError(`„${a.dateiname}“ ist zu groß (höchstens ${ANLAGE_MAX / 1024 / 1024} MB je Datei).`);
  const [s] = await tx`select coalesce(sum(groesse), 0)::bigint as g from tco.vs_themen_anlagen where thema_id = ${id}`;
  if (Number(s.g) + a.inhalt.length > THEMA_ANLAGEN_MAX) throw new BusinessError(`Die Anlagen des Themas wären zusammen größer als ${THEMA_ANLAGEN_MAX / 1024 / 1024} MB.`);
  const name = a.dateiname.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
  await tx`insert into tco.vs_themen_anlagen (thema_id, dateiname, mime, groesse, inhalt, erstellt_von) values (${id}, ${name}, ${a.mime}, ${a.inhalt.length}, ${a.inhalt}, ${wer.name})`;
}

export async function themaAnlageLoeschen(tx: Db, id: number, aid: number, wer: { name: string; userId: string | null; alle: boolean }) {
  await themaFuerAenderung(tx, id, wer);
  const r = await tx`delete from tco.vs_themen_anlagen where id = ${aid} and thema_id = ${id} returning id`;
  if (!r.length) throw new BusinessError('Die Anlage gibt es nicht (mehr).', 404);
}

// ---------------------------------------------------------------- Sitzung: zuordnen und wieder parken

/** Thema als Tagesordnungspunkt in die Sitzung übernehmen (Titel, Einreicher, Beschreibung, Anlagen) */
export async function themaZuordnen(tx: Db, sitzungId: number, themaId: number, wer: string): Promise<number> {
  const [t] = await tx`select th.*, tp.status as top_status from tco.vs_themen th left join tco.vs_tops tp on tp.id = th.top_id where th.id = ${themaId} for update of th`;
  if (!t) throw new BusinessError('Das Thema gibt es nicht (mehr).', 404);
  const stand = themaStand({ abgeschlossen: !!t.abgeschlossen_am, top_status: (t.top_status as 'OFFEN' | 'ERLEDIGT' | 'VERTAGT' | null) ?? null });
  if (stand !== 'GEPARKT') throw new BusinessError(`„${t.titel}“ ist nicht mehr geparkt (${STAND_TEXT[stand]}).`);
  // vorige Zuordnung (vertagter Punkt) merken
  const [alt] = t.top_id ? await tx`select sitzung_id, coalesce(kette, id) as kette from tco.vs_tops where id = ${t.top_id}` : [];
  // Verlauf: der neue Punkt setzt die Kette des Themas fort (bzw. die des vertagten Punkts)
  const kette = t.kette != null ? Number(t.kette) : alt ? Number(alt.kette) : null;
  const topId = await topAnlegen(tx, sitzungId, { titel: t.titel as string, verantwortlich: t.einreicher as string, text: (t.beschreibung as string) ?? null }, wer, { kette });
  for (const a of await tx`select dateiname, mime, inhalt, url from tco.vs_themen_anlagen where thema_id = ${themaId} order by id`) {
    if (a.url) await linkAnlegen(tx, sitzungId, { top_id: topId, url: a.url as string, bezeichnung: a.dateiname as string }, wer);
    else await anlageAnlegen(tx, sitzungId, { top_id: topId, dateiname: a.dateiname as string, mime: a.mime as string, inhalt: Buffer.from(a.inhalt as Uint8Array) }, wer);
  }
  await tx`update tco.vs_themen set top_id = ${topId}, zuletzt_sitzung_id = ${alt ? Number(alt.sitzung_id) : (t.zuletzt_sitzung_id as number | null) ?? null},
                                    kette = (select coalesce(kette, id) from tco.vs_tops where id = ${topId}),
                                    geaendert_am = now(), geaendert_von = ${wer} where id = ${themaId}`;
  return topId;
}

/** mehrere Themen zuordnen (z. B. alle Vorschläge); bereits nicht mehr geparkte werden übersprungen */
export async function themenZuordnen(tx: Db, sitzungId: number, ids: number[], wer: string): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const [t] = await tx`select th.abgeschlossen_am, tp.status as top_status from tco.vs_themen th left join tco.vs_tops tp on tp.id = th.top_id where th.id = ${id}`;
    if (!t || themaStand({ abgeschlossen: !!t.abgeschlossen_am, top_status: (t.top_status as 'OFFEN' | 'ERLEDIGT' | 'VERTAGT' | null) ?? null }) !== 'GEPARKT') continue;
    await themaZuordnen(tx, sitzungId, id, wer);
    n++;
  }
  return n;
}

/**
 * Wieder parken: Bei einer geplanten Sitzung ohne Protokoll (kein Text, keine Einträge) wird der Punkt samt kopierten Anlagen
 * entfernt, sonst als „vertagt“ markiert. Das Thema ist danach wieder geparkt (zuletzt in dieser Sitzung).
 */
export async function themaParken(tx: Db, themaId: number, wer: string): Promise<'ENTFERNT' | 'VERTAGT'> {
  const [t] = await tx`select th.id, th.top_id, tp.sitzung_id, tp.status, tp.text,
                              (select count(*) from tco.vs_eintraege x where x.top_id = tp.id)::int as eintraege, s.status as s_status
                         from tco.vs_themen th join tco.vs_tops tp on tp.id = th.top_id join tco.vs_sitzungen s on s.id = tp.sitzung_id
                        where th.id = ${themaId} for update of th`;
  if (!t) throw new BusinessError('Das Thema ist keiner Sitzung zugeordnet.');
  if (t.s_status === 'FREIGEGEBEN') throw new BusinessError('Das Protokoll ist freigegeben – das Thema kann dort nicht mehr geparkt werden.');
  if (t.status === 'ERLEDIGT') throw new BusinessError('Der Tagesordnungspunkt ist abgeschlossen – erst wieder öffnen.');
  const sid = Number(t.sitzung_id);
  const entfernen = t.s_status === 'GEPLANT' && !t.text && !Number(t.eintraege);
  // vertagt: Verknüpfung bleibt (Stand „geparkt“), damit die Folgesitzung den vertagten Punkt als Thema übernimmt statt ihn zu kopieren
  // Verlauf: die Kette bleibt am Thema, auch wenn der Punkt entfernt wird
  await tx`update tco.vs_themen set top_id = ${entfernen ? null : t.top_id}, zuletzt_sitzung_id = ${sid},
                                    kette = coalesce(kette, (select coalesce(kette, id) from tco.vs_tops where id = ${t.top_id})),
                                    geaendert_am = now(), geaendert_von = ${wer} where id = ${themaId}`;
  if (entfernen) {
    await tx`delete from tco.vs_anlagen where top_id = ${t.top_id}`;
    await tx`delete from tco.vs_tops where id = ${t.top_id}`;
  } else {
    await tx`update tco.vs_tops set status = 'VERTAGT' where id = ${t.top_id}`;
  }
  await tx`update tco.vs_sitzungen set geaendert_am = now(), geaendert_von = ${wer} where id = ${sid}`;
  return entfernen ? 'ENTFERNT' : 'VERTAGT';
}

/**
 * Beliebigen Tagesordnungspunkt in den Themenparkplatz verschieben: Gehört er schon zu einem Thema, wird dieses wieder
 * geparkt. Sonst entsteht ein Thema aus dem Punkt (Titel, Protokolltext als Beschreibung, Verantwortlicher als Einreicher,
 * Anlagen kopiert) mit Priorität und Zeitraum – und wird dann wie ein Thema geparkt (Punkt entfernt bzw. vertagt).
 */
export async function topParken(tx: Db, topId: number, e: { prioritaet: 1 | 2 | 3; von: string; bis: string }, wer: { name: string; userId: string | null }) {
  const [t] = await tx`select tp.id, tp.titel, tp.text, tp.verantwortlich, tp.status, tp.sitzung_id, coalesce(tp.kette, tp.id) as kette, s.status as s_status, th.id as thema_id
                         from tco.vs_tops tp join tco.vs_sitzungen s on s.id = tp.sitzung_id left join tco.vs_themen th on th.top_id = tp.id
                        where tp.id = ${topId} for update of tp`;
  if (!t) throw new BusinessError('Den Tagesordnungspunkt gibt es nicht (mehr).', 404);
  if (t.s_status === 'FREIGEGEBEN') throw new BusinessError('Das Protokoll ist freigegeben – der Punkt kann nicht mehr geparkt werden.');
  if (t.status === 'ERLEDIGT') throw new BusinessError('Der Tagesordnungspunkt ist abgeschlossen – erst wieder öffnen.');
  let themaId = t.thema_id == null ? null : Number(t.thema_id);
  if (!themaId) {
    zeitraumPruefen(e.von, e.bis);
    const einreicher = leer(t.verantwortlich as string | null) ?? wer.name;
    const [n] = await tx`
      insert into tco.vs_themen (titel, beschreibung, prioritaet, einreicher, einreicher_user, von, bis, top_id, kette, erstellt_von, geaendert_von)
      values (${t.titel as string}, ${leer(t.text as string | null)}, ${e.prioritaet}, ${einreicher}, ${einreicher === wer.name ? wer.userId : null},
              ${e.von}, ${e.bis}, ${topId}, ${Number(t.kette)}, ${wer.name}, ${wer.name})
      returning id`;
    themaId = Number(n.id);
    await tx`insert into tco.vs_themen_anlagen (thema_id, dateiname, mime, groesse, inhalt, url, erstellt_von)
             select ${themaId}, dateiname, mime, groesse, inhalt, url, coalesce(erstellt_von, ${wer.name}) from tco.vs_anlagen where top_id = ${topId} order by id`;
  }
  const ergebnis = await themaParken(tx, themaId, wer.name);
  return { thema_id: themaId, ergebnis, neu: t.thema_id == null };
}

/** neue Sitzung mit Vorlage: vorgeschlagene Themen gleich einplanen; Rückgabe: Anzahl */
export async function vorschlaegeEinplanen(tx: Db, sitzungId: number, wer: string): Promise<number> {
  const s = await sitzungDatum(tx, sitzungId);
  if (!s) return 0;
  const rows = await tx`
    select th.id, th.prioritaet, th.bis::text as bis from tco.vs_themen th left join tco.vs_tops tp on tp.id = th.top_id
     where th.abgeschlossen_am is null and (tp.id is null or tp.status = 'VERTAGT') and ${s.datum}::date between th.von and th.bis`;
  const ids = rows.map((r) => ({ id: Number(r.id), prioritaet: Number(r.prioritaet), bis: r.bis as string })).sort(vorschlagOrdnung).map((r) => r.id);
  return themenZuordnen(tx, sitzungId, ids, wer);
}

/** Thema, das zu einem Tagesordnungspunkt gehört (für vertagte Punkte der Vorsitzung) */
export async function themaZuTop(db: Db, topId: number): Promise<number | null> {
  const [r] = await db`select id from tco.vs_themen where top_id = ${topId}`;
  return r ? Number(r.id) : null;
}

/** Text für Hinweise: „VS 2026/04 vom 23.11.2026“ */
export const sitzungText = (s: { nr: string; datum: string }) => `${s.nr} vom ${dat(s.datum)}`;

/** Verlauf einer Kette (alle Punkte, chronologisch – auch wenn das Thema erst in einer Sitzung war) */
async function verlaufAlle(db: Db, kette: number): Promise<VerlaufPunkt[]> {
  return (await verlaufLesen(db, [kette], { auchEinzeln: true })).get(kette) ?? [];
}
