import { useRef } from 'react';
import { Input, SuggestionItem } from '@ui5/webcomponents-react';
import type { Stop } from './util';

/** Ein Vorschlag: angezeigter Text (kommt ins Feld), Zusatz rechts, und was beim Übernehmen in die anderen Felder geht */
export interface StopVorschlag { text: string; zusatz?: string; felder: Partial<Stop> }

/**
 * Eingabefeld eines Stops mit Vorschlägen aus früheren Aufträgen (Funktion transport.stops.vorschlaege).
 * Gewählt per Maus oder Pfeiltasten + Enter: die übrigen Felder (z. B. Straße, Land, PLZ/Ort zur Firma) werden überschrieben.
 * Ganz abgetippt und das Feld verlassen: nur leere Felder werden ergänzt.
 */
export function StopFeld({ wert, max, breite, readonly, placeholder, vorschlaege, onWert, onFelder }: {
  wert: string; max: number; breite?: string; readonly?: boolean; placeholder?: string;
  vorschlaege: StopVorschlag[];
  onWert: (v: string) => void;
  /** übernimmt weitere Felder; nurLeere = nur ergänzen, nichts überschreiben */
  onFelder: (f: Partial<Stop>, nurLeere: boolean) => void;
}) {
  // UI5 meldet die Auswahl erst als Vorschau (selection-change), die endgültige Übernahme als change mit dem Text
  const vorschau = useRef<StopVorschlag | null>(null);
  const uebernehmen = (v: string) => {
    const gewaehlt = vorschau.current && vorschau.current.text === v ? vorschau.current : null;
    vorschau.current = null;
    if (gewaehlt) { onFelder(gewaehlt.felder, false); return; }
    const gleich = vorschlaege.find((x) => x.text.toLowerCase() === v.trim().toLowerCase());
    if (gleich) onFelder(gleich.felder, true);
  };
  return (
    <Input style={{ width: breite ?? '100%' }} maxlength={max} value={wert} readonly={readonly} placeholder={placeholder}
           showSuggestions={!readonly && vorschlaege.length > 0} data-kein-autofill
           onInput={(e) => { vorschau.current = null; onWert(e.target.value); }}
           onSelectionChange={(e) => {
             const idx = Number((e.detail.item as HTMLElement | null)?.dataset?.idx);
             vorschau.current = Number.isInteger(idx) ? vorschlaege[idx] ?? null : null;
           }}
           onChange={(e) => { onWert(e.target.value); uebernehmen(e.target.value); }}>
      {vorschlaege.map((x, k) => <SuggestionItem key={`${k}-${x.text}-${x.zusatz ?? ''}`} data-idx={k} text={x.text} additionalText={x.zusatz} />)}
    </Input>
  );
}
