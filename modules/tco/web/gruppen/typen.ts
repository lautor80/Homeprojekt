import { TCO } from '../util';

export const GR = `${TCO}/gruppen`;

export interface GruppenMitglied { adrnr: string; name: string; mitglnrn: string; rolle: string | null; ausgetreten: boolean }
export interface Gruppe {
  id: number; parent_id: number | null; name: string; beschreibung: string | null; aktiv: boolean;
  /** Position innerhalb der Ebene; null = ohne Position (nach Name hinter den übrigen) */
  position: number | null;
  /** aktive Regeln des Regelwerks als Text; null = keine Regel */
  regel: string | null;
  /** „Spielbetrieb › Mannschaften › Herren 40“ */
  pfad: string;
  /** 0 = oberste Ebene */
  ebene: number;
  /** direkt zugeordnete Mitglieder */
  mitglieder: GruppenMitglied[];
  /** Personen einschließlich aller Untergruppen */
  gesamt: number;
}
/** Mitglied im Dialog „Mitglieder aufnehmen“: Geschlecht, Jahrgang und Alter (heute) für die Filter; ohne Geburtsdatum null */
export interface AufnahmeMitglied { adrnr: string; name: string; geschlecht: 'M' | 'W' | ''; jahrgang: number | null; alter: number | null }
/** Die Gruppen kommen in Baumreihenfolge (Eltern vor Kindern) */
export interface GruppenDaten {
  gruppen: Gruppe[];
  /** Gruppen und Mitglieder pflegen (tco.gruppen:edit oder tco.kalender:edit) */
  pflege: boolean;
  /** Regelwerk pflegen und anwenden (nur tco.gruppen:edit) */
  regelwerk?: boolean;
}

/** IDs einer Gruppe und aller ihrer Untergruppen */
export function mitUntergruppen(gruppen: Gruppe[], id: number): Set<number> {
  const s = new Set([id]);
  // Baumreihenfolge: Kinder stehen hinter ihren Eltern – ein Durchlauf genügt
  for (const g of gruppen) if (g.parent_id != null && s.has(g.parent_id)) s.add(g.id);
  return s;
}
