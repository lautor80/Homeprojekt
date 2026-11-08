import type { FastifyRequest } from 'fastify';
import { sql, type Tx } from './db.js';
import { BusinessError } from './errors.js';
import { auditObjects, activeModules } from './modules.js';

/**
 * Sperren gegen gleichzeitige Bearbeitung.
 *
 * - Objektsperre: Objekttyp + Schlüssel wie in den Änderungsbelegen (MITGLIED/0000000901, AUFTRAG/2024001 …),
 *   '*' sperrt alle Objekte eines Typs (z. B. Stammdatentabellen). Ein Verbund (sperrtAuch) sperrt abhängige
 *   Objekttypen mit (Mitglied → Schlüssel, Versandweg …).
 * - Zeitraumsperre: zusätzlich von/bis, z. B. PLATZZEIT/<platz> für eine ausgewählte, noch nicht gesicherte Buchung.
 *
 * Inhaber ist die Anmeldesitzung. Die Oberfläche verlängert ihre Sperren per Lebenszeichen; ohne Lebenszeichen
 * laufen sie nach DAUER_S Sekunden ab. Durchgesetzt wird in der Datenbank (core.sperre_pruefen im Änderungsbeleg-Trigger)
 * und für Zeiträume in der jeweiligen Fachlogik (zeitraumPruefen).
 */
export const DAUER_S = 120;

export interface SperrDef { type: string; text: string; permission: string; sperrtAuch?: string[] }

export function sperrDefs(): SperrDef[] {
  return [...auditObjects(), ...activeModules().flatMap((m) => m.sperrObjekte ?? [])];
}
export const sperrDef = (type: string) => sperrDefs().find((d) => d.type === type) ?? null;

export interface Inhaber { benutzer: string; seit: string; bezeichnung: string | null }
export class GesperrtError extends BusinessError {
  constructor(message: string, public inhaber: Inhaber) { super(message, 423); }
}

const zeitText = (d: Date | string) => new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const datumZeit = (s: string) => {
  const [d, t] = s.replace('T', ' ').split(' ');
  return `${d.split('-').reverse().join('.')} ${t.slice(0, 5)}`;
};

function meldung(s: { benutzer: string; erstellt: Date; bezeichnung: string | null; objekt: string; schluessel: string; von: string | null; bis: string | null }) {
  const was = s.bezeichnung ?? `${sperrDef(s.objekt)?.text ?? s.objekt} ${s.schluessel === '*' ? '' : s.schluessel}`.trim();
  // Zeitraum (z. B. Platzbuchung): ohne Namen – andere Mitglieder sollen nicht sehen, wer bucht
  if (s.von) return `${was} ${datumZeit(s.von)}–${String(s.bis).slice(11, 16)} Uhr wird gerade von jemand anderem gebucht.`;
  return `${was} wird gerade von ${s.benutzer} bearbeitet (gesperrt seit ${zeitText(s.erstellt)} Uhr).`;
}

const SP = (db: Tx) => db`id, objekt, schluessel, benutzer, bezeichnung, erstellt, to_char(von, 'YYYY-MM-DD HH24:MI') as von, to_char(bis, 'YYYY-MM-DD HH24:MI') as bis`;
const ts = (s: string | null | undefined) => (s ? s.replace('T', ' ').slice(0, 19) : null);

/** Sperre setzen oder (eigene) verlängern; bei fremder Sperre GesperrtError */
export async function sperren(o: {
  sitzung: string; benutzerId: string | null; benutzer: string; objekt: string; schluessel: string;
  von?: string | null; bis?: string | null; bezeichnung?: string | null;
}): Promise<{ id: number; ablauf: string }> {
  const def = sperrDef(o.objekt);
  const objekte = [o.objekt, ...(def?.sperrtAuch ?? [])];
  const von = ts(o.von);
  const bis = ts(o.bis);
  if ((von === null) !== (bis === null) || (von && bis && von >= bis)) throw new BusinessError('Ungültiger Zeitraum für die Sperre.');
  return sql.begin(async (tx) => {
    // je Objekttyp serialisieren, damit zwei gleichzeitige Anfragen nicht beide „frei“ sehen
    await tx`select pg_advisory_xact_lock(hashtext(${'sperre:' + o.objekt}))`;
    await tx`delete from core.sperren where ablauf < now() - interval '10 minutes'`;
    const [fremd] = von
      ? await tx`select ${SP(tx as unknown as Tx)} from core.sperren
                  where objekt = ${o.objekt} and schluessel = ${o.schluessel} and sitzung <> ${o.sitzung} and ablauf > now()
                    and von is not null and von < ${bis}::timestamp and bis > ${von}::timestamp
                  order by erstellt limit 1`
      : await tx`select ${SP(tx as unknown as Tx)} from core.sperren
                  where objekte && ${objekte}::text[] and von is null and sitzung <> ${o.sitzung} and ablauf > now()
                    and (schluessel = ${o.schluessel} or schluessel = '*' or ${o.schluessel} = '*')
                  order by erstellt limit 1`;
    if (fremd) {
      throw new GesperrtError(meldung(fremd as never), { benutzer: von ? '' : fremd.benutzer, seit: new Date(fremd.erstellt).toISOString(), bezeichnung: fremd.bezeichnung });
    }
    const [eigen] = await tx`select id from core.sperren
                              where sitzung = ${o.sitzung} and objekt = ${o.objekt} and schluessel = ${o.schluessel}
                                and von is not distinct from ${von}::timestamp and bis is not distinct from ${bis}::timestamp
                              limit 1`;
    if (eigen) {
      const [r] = await tx`update core.sperren set ablauf = now() + ${DAUER_S + ' seconds'}::interval, bezeichnung = coalesce(${o.bezeichnung ?? null}, bezeichnung)
                            where id = ${eigen.id} returning id, ablauf`;
      return { id: Number(r.id), ablauf: new Date(r.ablauf).toISOString() };
    }
    const [r] = await tx`insert into core.sperren (objekt, schluessel, objekte, von, bis, sitzung, benutzer_id, benutzer, bezeichnung, ablauf)
                         values (${o.objekt}, ${o.schluessel}, ${objekte}::text[], ${von}::timestamp, ${bis}::timestamp, ${o.sitzung}, ${o.benutzerId},
                                 ${o.benutzer}, ${o.bezeichnung ?? null}, now() + ${DAUER_S + ' seconds'}::interval)
                         returning id, ablauf`;
    return { id: Number(r.id), ablauf: new Date(r.ablauf).toISOString() };
  });
}

/** Lebenszeichen: eigene Sperren verlängern; zurück kommen die noch gehaltenen */
export async function verlaengern(sitzung: string, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const r = await sql`update core.sperren set ablauf = now() + ${DAUER_S + ' seconds'}::interval
                       where sitzung = ${sitzung} and id = any(${ids}::bigint[]) and ablauf > now() returning id`;
  return r.map((x) => Number(x.id));
}

export async function freigeben(sitzung: string, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const r = await sql`delete from core.sperren where sitzung = ${sitzung} and id = any(${ids}::bigint[])`;
  return r.count;
}

export const sitzungFreigeben = (sitzung: string) => sql`delete from core.sperren where sitzung = ${sitzung}`;

/**
 * Fachlogik: Zeitraum frei von fremden Sperren? (z. B. Platzbuchung anlegen). Ohne Sitzung (API, Hintergrund) keine Prüfung.
 */
export async function zeitraumPruefen(db: Tx | typeof sql, sitzung: string | null | undefined, objekt: string, schluessel: string, von: string, bis: string) {
  if (!sitzung) return;
  const [s] = await (db as Tx)`select ${SP(db as Tx)} from core.sperren
                    where objekt = ${objekt} and schluessel = ${schluessel} and sitzung <> ${sitzung} and ablauf > now()
                      and von is not null and von < ${ts(bis)}::timestamp and bis > ${ts(von)}::timestamp
                    order by erstellt limit 1`;
  if (s) throw new GesperrtError(`${meldung(s as never)} Bitte eine andere Zeit wählen.`,
    { benutzer: '', seit: new Date(s.erstellt).toISOString(), bezeichnung: s.bezeichnung });
}

/** fremde Zeitraumsperren (für die Belegungsanzeige) */
export async function zeitraeume(sitzung: string | null | undefined, objekt: string, schluessel: string[], tagVon: string, tagBis: string) {
  if (!schluessel.length) return [];
  return sql`select schluessel, to_char(von, 'YYYY-MM-DD"T"HH24:MI') as von, to_char(bis, 'YYYY-MM-DD"T"HH24:MI') as bis
               from core.sperren
              where objekt = ${objekt} and schluessel = any(${schluessel}::text[]) and ablauf > now() and von is not null
                and sitzung <> ${sitzung ?? ''} and von < (${tagBis}::date + 1) and bis > ${tagVon}::date`;
}

export async function alle() {
  return sql`select id, objekt, schluessel, bezeichnung, benutzer, erstellt, ablauf,
                    to_char(von, 'YYYY-MM-DD"T"HH24:MI') as von, to_char(bis, 'YYYY-MM-DD"T"HH24:MI') as bis
               from core.sperren where ablauf > now() order by erstellt`;
}

/** Sitzung der Anfrage (Hash des Tokens), nur bei Anmeldung per Oberfläche */
export const sitzungVon = (req: FastifyRequest) => req.sitzung ?? null;
