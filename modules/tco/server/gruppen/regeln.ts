import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense } from '../format.js';
import { passtZurRegel, regelText, type RegelGeschlecht } from './alter.js';
import { ausUebergeordnetenEntfernen, gruppenLesen, mitUntergruppen, ueberUntergruppe } from './logik.js';

/**
 * Regelwerk der Mitgliedergruppen (#16): Regeln stellen sicher, dass die richtigen Personen in den richtigen Gruppen
 * sind (z. B. Kleinfeld 6–7 Jahre, Midfeld 8–10 Jahre). Das Regelwerk lässt sich von Hand anwenden (mit Vorschau)
 * oder regelmäßig durch einen Job (POST /gruppen/regeln/anwenden mit API-Schlüssel).
 *
 * Anwenden je Gruppe mit aktiven Regeln:
 *  - aktive Mitglieder, die zu einer Regel passen (Alter und – wenn verlangt – Geschlecht), werden aufgenommen (Kennzeichen „regel“);
 *  - Zuordnungen aus dem Regelwerk, die nicht mehr passen, entfallen;
 *  - mit „andere entfernen“ entfallen auch von Hand Zugeordnete, die nicht passen;
 *  - die Hierarchieregel gilt weiter: wer über eine Untergruppe dazugehört, wird nicht noch einmal aufgenommen.
 */
export interface Regel {
  id: number; gruppe_id: number; alter_von: number | null; alter_bis: number | null; jahrgang: boolean;
  /** '' = alle (gemischte Mannschaften), 'M' = männlich, 'W' = weiblich */
  geschlecht: RegelGeschlecht;
  andere_entfernen: boolean; aktiv: boolean;
}
export type RegelDaten = Omit<Regel, 'id'>;

export async function regelnLesen(db: Db): Promise<Regel[]> {
  return (await db`select id, gruppe_id, alter_von, alter_bis, jahrgang, geschlecht, andere_entfernen, aktiv from tco.kal_gruppen_regeln order by id`).map((r) => ({
    id: Number(r.id), gruppe_id: Number(r.gruppe_id), alter_von: r.alter_von == null ? null : Number(r.alter_von), alter_bis: r.alter_bis == null ? null : Number(r.alter_bis),
    jahrgang: !!r.jahrgang, geschlecht: (['M', 'W'].includes(r.geschlecht) ? r.geschlecht : '') as RegelGeschlecht, andere_entfernen: !!r.andere_entfernen, aktiv: !!r.aktiv,
  }));
}

/** Regelwerk sichern: als Ganzes (ersetzt alle Regeln) oder – mit `gruppeId` – nur das Regelwerk dieser einen Gruppe */
export async function regelnSpeichern(tx: Db, regeln: RegelDaten[], gruppeId?: number): Promise<number> {
  const gruppen = new Map((await tx`select id, name from tco.kal_gruppen`).map((g) => [Number(g.id), g.name as string]));
  regeln.forEach((r, i) => {
    const nr = `Regel ${i + 1}`;
    if (!gruppen.has(r.gruppe_id)) throw new BusinessError(`${nr}: Bitte eine Gruppe wählen.`);
    if (gruppeId && r.gruppe_id !== gruppeId) throw new BusinessError(`${nr} gehört nicht zum Regelwerk der Gruppe „${gruppen.get(gruppeId) ?? gruppeId}“.`);
    if (r.alter_von == null && r.alter_bis == null) throw new BusinessError(`${nr} („${gruppen.get(r.gruppe_id)}“): Bitte ein Alter von oder bis angeben.`);
    if (r.alter_von != null && r.alter_bis != null && r.alter_von > r.alter_bis) throw new BusinessError(`${nr} („${gruppen.get(r.gruppe_id)}“): „Alter von“ ist größer als „Alter bis“.`);
  });
  if (gruppeId && !gruppen.has(gruppeId)) throw new BusinessError('Gruppe nicht gefunden.', 404);
  if (gruppeId) await tx`delete from tco.kal_gruppen_regeln where gruppe_id = ${gruppeId}`;
  else await tx`delete from tco.kal_gruppen_regeln`;
  for (const r of regeln) {
    await tx`insert into tco.kal_gruppen_regeln (gruppe_id, alter_von, alter_bis, jahrgang, geschlecht, andere_entfernen, aktiv)
             values (${r.gruppe_id}, ${r.alter_von}, ${r.alter_bis}, ${r.jahrgang}, ${r.geschlecht}, ${r.andere_entfernen}, ${r.aktiv})`;
  }
  return regeln.length;
}

export interface RegelPerson { adrnr: string; name: string }
export interface RegelErgebnis {
  gruppe_id: number;
  /** Pfad der Gruppe, z. B. „Jugend › Kleinfeld“ */
  gruppe: string;
  /** Regeln der Gruppe als Text, z. B. „6–7 Jahre (Kalenderjahr zählt)“ */
  regel: string;
  aufgenommen: RegelPerson[];
  entfernt: RegelPerson[];
  /** passt, gehört aber schon über eine Untergruppe dazu */
  ueberUntergruppe: number;
  /** nach dem Lauf direkt zugeordnet */
  mitglieder: number;
}

/**
 * Regelwerk anwenden („Neu berechnen“); mit `simulation` wird nur ermittelt, was sich ändern würde.
 * Mit `gruppeId` nur für diesen Knoten: die Gruppe und alle ihre Untergruppen.
 */
export async function regelnAnwenden(tx: Db, o: { simulation: boolean; stichtag?: string; gruppeId?: number }): Promise<RegelErgebnis[]> {
  const knoten = o.gruppeId ? new Set(await mitUntergruppen(tx, [o.gruppeId])) : null;
  if (knoten && !knoten.size) throw new BusinessError('Gruppe nicht gefunden.', 404);
  const regeln = (await regelnLesen(tx)).filter((r) => r.aktiv && (!knoten || knoten.has(r.gruppe_id)));
  if (!regeln.length) return [];
  const stichtag = o.stichtag ?? (await tx`select current_date::text as d`)[0].d as string;
  const gruppen = new Map((await gruppenLesen(tx)).map((g) => [g.id, g]));
  // aktive Mitglieder wie in der Mitgliederliste: mit Eintritt, nicht ausgetreten
  const aktive = await tx`select adrnr, vorname, nachname, geburtsdatum::text as geburtsdatum, geschlecht from tco.mitglieder
                           where eintritt is not null and (austritt is null or austritt >= ${stichtag}::date)`;
  const namen = new Map((await tx`select adrnr, vorname, nachname from tco.mitglieder`).map((m) => [m.adrnr as string, condense(`${m.vorname ?? ''} ${m.nachname ?? ''}`) || (m.adrnr as string)]));
  // Mitgliedsstamm: 1 = männlich, 2 = weiblich
  const geschlecht = (m: { geschlecht?: unknown }): RegelGeschlecht => { const g = String(m.geschlecht ?? '').trim(); return g === '1' ? 'M' : g === '2' ? 'W' : ''; };
  const person = (adrnr: string): RegelPerson => ({ adrnr, name: namen.get(adrnr) ?? adrnr });
  const nachName = (a: RegelPerson, b: RegelPerson) => a.name.localeCompare(b.name, 'de');

  const out: RegelErgebnis[] = [];
  for (const gid of [...new Set(regeln.map((r) => r.gruppe_id))]) {
    const g = gruppen.get(gid);
    if (!g) continue;
    const eigene = regeln.filter((r) => r.gruppe_id === gid);
    const streng = eigene.some((r) => r.andere_entfernen);
    const passend = new Set(aktive.filter((m) => eigene.some((r) => passtZurRegel(m.geburtsdatum as string | null, r, stichtag, geschlecht(m)))).map((m) => m.adrnr as string));
    const aktuell = await tx`select adrnr, regel from tco.kal_gruppe_mitglieder where gruppe_id = ${gid}`;
    const drin = new Set(aktuell.map((x) => x.adrnr as string));
    const unter = await ueberUntergruppe(tx, gid, [...passend].filter((a) => !drin.has(a)));
    const hinzu = [...passend].filter((a) => !drin.has(a) && !unter.has(a));
    const weg = aktuell.filter((x) => !passend.has(x.adrnr as string) && (streng || !!x.regel)).map((x) => x.adrnr as string);
    if (!o.simulation) {
      for (const a of hinzu) await tx`insert into tco.kal_gruppe_mitglieder (gruppe_id, adrnr, regel) values (${gid}, ${a}, true) on conflict do nothing`;
      if (hinzu.length) await ausUebergeordnetenEntfernen(tx, gid, hinzu);
      if (weg.length) await tx`delete from tco.kal_gruppe_mitglieder where gruppe_id = ${gid} and adrnr = any(${weg})`;
    }
    out.push({
      gruppe_id: gid, gruppe: g.pfad, regel: eigene.map(regelText).join(' oder ') + (streng ? ' · andere entfernen' : ''),
      aufgenommen: hinzu.map(person).sort(nachName), entfernt: weg.map(person).sort(nachName),
      ueberUntergruppe: unter.size, mitglieder: drin.size + hinzu.length - weg.length,
    });
  }
  return out.sort((a, b) => a.gruppe.localeCompare(b.gruppe, 'de'));
}
