import { TCO } from '../util';

export const GR = `${TCO}/gruppen`;

export interface GruppenMitglied { adrnr: string; name: string; mitglnrn: string; rolle: string | null; ausgetreten: boolean }
export interface Gruppe {
  id: number; parent_id: number | null; name: string; beschreibung: string | null; aktiv: boolean;
  /** „Spielbetrieb › Mannschaften › Herren 40“ */
  pfad: string;
  /** 0 = oberste Ebene */
  ebene: number;
  /** direkt zugeordnete Mitglieder */
  mitglieder: GruppenMitglied[];
  /** Personen einschließlich aller Untergruppen */
  gesamt: number;
}
/** Die Gruppen kommen in Baumreihenfolge (Eltern vor Kindern) */
export interface GruppenDaten { gruppen: Gruppe[]; pflege: boolean }

/** IDs einer Gruppe und aller ihrer Untergruppen */
export function mitUntergruppen(gruppen: Gruppe[], id: number): Set<number> {
  const s = new Set([id]);
  // Baumreihenfolge: Kinder stehen hinter ihren Eltern – ein Durchlauf genügt
  for (const g of gruppen) if (g.parent_id != null && s.has(g.parent_id)) s.add(g.id);
  return s;
}
