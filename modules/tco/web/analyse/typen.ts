import { TCO } from '../util';

export const AN = `${TCO}/analyse`;

export interface Filter {
  status: '' | 'A' | 'X';
  geschlecht: string; altersgruppe: string; ort: string; plz: string; zahlungsart: string; zahlweise: string;
  eintritt_von: string; eintritt_bis: string; alter_von: string; alter_bis: string;
  vertragsart: string; vertrag_scope: '' | 'A' | 'B'; vertragsbest: '' | 'M' | 'O';
  sort_by: string; sort_desc: boolean;
}
export interface Sicht { filter: Filter; group_by: string; details: boolean; search: string; cols: string[] }

export interface Spalte { field: string; label: string; width: number; halign: 'Begin' | 'End'; visible: boolean }
export interface Variante { key: string; name: string; descr: string; global: boolean; isdef: boolean; text: string }
export interface Werte { orte: string[]; zahlungsarten: string[]; zahlweisen: string[]; vertragsarten: string[]; altersgruppen: string[]; geschlechter: string[] }
export interface Init {
  werte: Werte; spalten: Spalte[]; gruppen: [string, string][]; sortierungen: [string, string][];
  varianten: Variante[]; variante: Variante | null; sicht: Sicht;
}

export interface Zeile {
  rowtype: 'D' | 'V' | 'G' | 'T'; highlight: 'None' | 'Information' | 'Critical' | 'Positive'; adrnr: string;
  gruppe: string; mitglnr: string; nachname: string; vorname: string; geschlecht: string; plz: string; ort: string; status: string;
  zahlungsart: string; zahlweise: string; eintritt: string; austritt: string; altersgruppe: string; lebensalter: string; mitgliedsjahre: string;
  anzahl: string; vertraege_anzahl: string; vertraege_aktiv: string; vertraege_betrag: string;
  vertrag_art: string; vertrag_beginn: string; vertrag_ende: string; vertrag_betrag: string; vertrag_status: string;
}
export interface Kpi { mitglieder: number; aktiv: number; alter: number | null; jahre: number | null; betrag: number; vertraege: number }
export interface Diagramme {
  alter: { label: string; wert: number }[];
  geschlecht: { label: string; wert: number }[];
  jahre: { jahr: number; eintritte: number; austritte: number }[];
  vertragsarten: { label: string; anzahl: number; betrag: number }[];
  orte: { label: string; wert: number }[];
}
export interface Ergebnis { rows: Zeile[]; kpi: Kpi; diagramme: Diagramme; filterCount: number; titel: string }

export const FILTER_STANDARD: Filter = {
  status: 'A', geschlecht: '', altersgruppe: '', ort: '', plz: '', zahlungsart: '', zahlweise: '', eintritt_von: '', eintritt_bis: '',
  alter_von: '', alter_bis: '', vertragsart: '', vertrag_scope: 'A', vertragsbest: '', sort_by: 'NACHNAME', sort_desc: false,
};
export const sichtStandard = (spalten: Spalte[]): Sicht => ({
  filter: { ...FILTER_STANDARD }, group_by: '', details: true, search: '', cols: spalten.filter((s) => s.visible).map((s) => s.field),
});
