/**
 * Anzeige für die Auftragsliste: Lade-/Entladetermin („Mi 18.11. 07:00–08:30“) und Texte zum Abrechnungsstatus.
 * Reine Funktionen ohne React – getestet in server/test/transport_abrechnung.test.ts.
 */

export interface Termin { datum: string | null; zeit: string | null }
export type AbrechnungStatus = 'angelegt' | 'abgerechnet' | 'ueberfaellig' | 'bezahlt';
export interface Abrechnung {
  status: AbrechnungStatus; faellig: string | null; tageUeberfaellig: number; bezahltAm: string | null; ohneRechnung: boolean;
}

const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** „Mi 18.11.“ */
export function kurzDatum(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const wt = WT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wt} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

/** „Mi 18.11. 07:00–08:30“ – ein Bindestrich zwischen zwei Uhrzeiten wird zum Halbgeviertstrich */
export function terminText(t: Termin | null | undefined): string {
  if (!t) return '';
  const zeit = (t.zeit ?? '').trim().replace(/(\d)\s*-\s*(\d)/g, '$1–$2');
  return [t.datum ? kurzDatum(t.datum) : '', zeit].filter(Boolean).join(' ');
}

const tt = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');

/** Zustand der drei Symbole angelegt · abgerechnet · bezahlt */
export type SymbolZustand = 'erledigt' | 'bezahlt' | 'offen' | 'ueberfaellig';

export function symbole(a: Abrechnung, faktura: string | null, fakturadatum: string | null, anlagedatum: string | null) {
  const angelegt = { zustand: 'erledigt' as SymbolZustand, text: anlagedatum ? `Angelegt am ${tt(anlagedatum)}` : 'Angelegt' };
  if (a.ohneRechnung) {
    return {
      symbole: [angelegt, { zustand: 'erledigt' as SymbolZustand, text: 'Ohne Rechnung abgeschlossen' }, { zustand: 'bezahlt' as SymbolZustand, text: `Ohne Rechnung abgeschlossen am ${tt(a.bezahltAm)} – gilt als bezahlt` }],
      hinweis: 'ohne Rechnung',
    };
  }
  const abgerechnet = faktura
    ? { zustand: 'erledigt' as SymbolZustand, text: `Abgerechnet: Rechnung ${faktura} vom ${tt(fakturadatum)}` }
    : { zustand: 'offen' as SymbolZustand, text: 'Noch nicht abgerechnet' };
  let bezahlt: { zustand: SymbolZustand; text: string };
  let hinweis = '';
  if (a.status === 'bezahlt') {
    bezahlt = { zustand: 'bezahlt', text: `Bezahlt am ${tt(a.bezahltAm)}` };
    hinweis = `bezahlt ${tt(a.bezahltAm).slice(0, 6)}`;
  } else if (a.status === 'ueberfaellig') {
    bezahlt = { zustand: 'ueberfaellig', text: `Zahlung überfällig seit ${a.tageUeberfaellig} Tagen (fällig ${tt(a.faellig)})` };
    hinweis = `${a.tageUeberfaellig} Tage überfällig`;
  } else {
    bezahlt = { zustand: 'offen', text: a.faellig ? `Noch nicht bezahlt, fällig ${tt(a.faellig)}` : 'Noch nicht bezahlt' };
    hinweis = a.faellig ? `fällig ${tt(a.faellig).slice(0, 6)}` : 'angelegt';
  }
  return { symbole: [angelegt, abgerechnet, bezahlt], hinweis };
}
