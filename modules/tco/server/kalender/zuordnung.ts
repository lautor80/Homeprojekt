import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense } from '../format.js';
import { KATEGORIEN, type Kategorie } from './logik.js';

/**
 * Vereinskalender (#16): flache Tabelle aller Veranstaltungen – Massenbearbeitung und Regelwerk für die
 * Standardzuordnung zu einer Gruppe („Text abc in Spalte Titel => Gruppe Herren 40“).
 *
 * Regeln: Die erste passende aktive Regel (in der gepflegten Reihenfolge) bestimmt die Gruppe. Verglichen wird
 * ohne Rücksicht auf Groß-/Kleinschreibung und Mehrfach-Leerzeichen („enthält“).
 */
export const REGEL_FELDER = { titel: 'Titel (Liga / Mannschaft)', beschreibung: 'Beschreibung (Begegnung)', ort: 'Ort' } as const;
export type RegelFeld = keyof typeof REGEL_FELDER;
export interface EventRegel { id: number; feld: RegelFeld; text: string; gruppe_id: number; aktiv: boolean }
export type EventRegelDaten = Omit<EventRegel, 'id'>;

const norm = (s: string | null | undefined) => condense(s ?? '').toLowerCase();

export async function eventRegelnLesen(db: Db): Promise<EventRegel[]> {
  return (await db`select id, feld, text, gruppe_id, aktiv from tco.kal_event_regeln order by id`).map((r) => ({
    id: Number(r.id), feld: r.feld as RegelFeld, text: r.text as string, gruppe_id: Number(r.gruppe_id), aktiv: !!r.aktiv,
  }));
}

/** Regelwerk als Ganzes sichern (Reihenfolge = Rangfolge) */
export async function eventRegelnSpeichern(tx: Db, regeln: EventRegelDaten[]): Promise<number> {
  const gruppen = new Set((await tx`select id from tco.kal_gruppen`).map((g) => Number(g.id)));
  regeln.forEach((r, i) => {
    if (!condense(r.text)) throw new BusinessError(`Regel ${i + 1}: Bitte einen Text angeben.`);
    if (!gruppen.has(r.gruppe_id)) throw new BusinessError(`Regel ${i + 1} („${condense(r.text)}“): Bitte eine Gruppe wählen.`);
  });
  await tx`delete from tco.kal_event_regeln`;
  for (const r of regeln) {
    await tx`insert into tco.kal_event_regeln (feld, text, gruppe_id, aktiv) values (${r.feld}, ${condense(r.text)}, ${r.gruppe_id}, ${r.aktiv})`;
  }
  return regeln.length;
}

/** Gruppe nach dem Regelwerk: erste passende aktive Regel, sonst null */
export function gruppeNachRegeln(e: { titel?: string | null; beschreibung?: string | null; ort?: string | null }, regeln: EventRegelDaten[]): number | null {
  for (const r of regeln) {
    if (r.aktiv && norm(r.text) && norm(e[r.feld]).includes(norm(r.text))) return r.gruppe_id;
  }
  return null;
}

export interface RegelZeile { id: number; titel: string; beginn: string; bisher: string; neu: string }

/**
 * Regelwerk auf Veranstaltungen anwenden: Standardzuordnung für Veranstaltungen ohne Gruppe;
 * mit `ueberschreiben` auch für solche, die schon einer Gruppe zugeordnet sind. `ids` begrenzt auf eine Auswahl.
 */
export async function eventRegelnAnwenden(tx: Db, o: { ids?: number[]; ueberschreiben: boolean; simulation: boolean }): Promise<RegelZeile[]> {
  const regeln = await eventRegelnLesen(tx);
  if (!regeln.some((r) => r.aktiv)) throw new BusinessError('Es gibt keine aktive Regel – bitte zuerst das Regelwerk pflegen.');
  const namen = new Map((await tx`select id, name from tco.kal_gruppen`).map((g) => [Number(g.id), g.name as string]));
  const events = await tx`select id, titel, beschreibung, ort, beginn, gruppen from tco.kal_events
                           where ${o.ids ? tx`id = any(${o.ids})` : tx`true`} order by beginn, id`;
  const out: RegelZeile[] = [];
  for (const e of events) {
    const alt = ((e.gruppen as number[] | null) ?? []).map(Number);
    if (alt.length && !o.ueberschreiben) continue;
    const g = gruppeNachRegeln({ titel: e.titel, beschreibung: e.beschreibung, ort: e.ort }, regeln);
    if (!g || (alt.length === 1 && alt[0] === g)) continue;
    if (!o.simulation) await tx`update tco.kal_events set gruppen = ${[g]} where id = ${e.id}`;
    out.push({
      id: Number(e.id), titel: e.titel as string, beginn: new Date(e.beginn).toISOString(),
      bisher: alt.map((x) => namen.get(x) ?? `Gruppe ${x}`).join(', '), neu: namen.get(g) ?? `Gruppe ${g}`,
    });
  }
  return out;
}

export interface MassenAenderung { titel?: string; ort?: string | null; kategorie?: Kategorie; gruppen?: number[]; anmeldung?: boolean }

/** Massenbearbeitung: nur die angegebenen Felder werden bei allen gewählten Veranstaltungen gesetzt */
export async function eventsMasseAendern(tx: Db, ids: number[], d: MassenAenderung): Promise<number> {
  const werte: Record<string, unknown> = {};
  if (d.titel !== undefined) {
    if (!condense(d.titel)) throw new BusinessError('Bitte einen Titel angeben.');
    werte.titel = condense(d.titel);
  }
  if (d.ort !== undefined) werte.ort = condense(d.ort ?? '') || null;
  if (d.kategorie !== undefined) {
    if (!(d.kategorie in KATEGORIEN)) throw new BusinessError('Unbekannte Art.');
    werte.kategorie = d.kategorie;
  }
  if (d.gruppen !== undefined) {
    const gruppen = [...new Set(d.gruppen)];
    if (gruppen.length) {
      const [g] = await tx`select count(*)::int as n from tco.kal_gruppen where id = any(${gruppen})`;
      if (Number(g.n) !== gruppen.length) throw new BusinessError('Unbekannte Gruppe ausgewählt.');
    }
    werte.gruppen = gruppen;
  }
  if (d.anmeldung !== undefined) werte.anmeldung = d.anmeldung;
  if (!Object.keys(werte).length) throw new BusinessError('Bitte mindestens ein Feld für die Massenbearbeitung füllen.');
  const r = await tx`update tco.kal_events set ${tx(werte as never)} where id = any(${ids})`;
  return r.count;
}
