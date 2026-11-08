import { useEffect, useState, type CSSProperties } from 'react';
import { ComboBox, ComboBoxItem } from '@ui5/webcomponents-react';

/**
 * Suchbare Auswahl (ComboBox) ohne „Autovervollständigen beim Tippen“:
 * Die Standard-ComboBox übernimmt beim Tippen sofort den ersten passenden Eintrag (Typeahead + selection-change) –
 * bei Feldern, die direkt speichern oder Folgefelder füllen, wurde dadurch nach einem Buchstaben ein falscher Eintrag gewählt.
 * Hier wird erst übernommen, wenn ein Eintrag angeklickt bzw. mit Enter bestätigt wird oder der eingegebene Text
 * beim Verlassen genau einem Eintrag entspricht. Pfeiltasten blättern nur.
 */
export interface AuswahlEintrag { key: string; text: string; zusatz?: string }

export function AuswahlBox({ eintraege: eintraege0, wert, onWaehle, onSuche, placeholder, style, readonly, disabled, leerErlaubt = true, filter = 'Contains' }: {
  eintraege: AuswahlEintrag[];
  /** Schlüssel des gewählten Eintrags ('' = keiner) */
  wert: string | null | undefined;
  /** gewählter Schlüssel; null = geleert (nur mit leerErlaubt) */
  onWaehle: (key: string | null) => void;
  /** Suchtext für serverseitige Suche (optional) */
  onSuche?: (text: string) => void;
  placeholder?: string; style?: CSSProperties; readonly?: boolean; disabled?: boolean; leerErlaubt?: boolean;
  /** 'None' bei serverseitiger Suche */
  filter?: 'Contains' | 'StartsWith' | 'StartsWithPerTerm' | 'None';
}) {
  // gleichnamige Einträge (z. B. zwei Mitglieder „Luca Schneider“) eindeutig beschriften
  const anzahl = new Map<string, number>();
  for (const e of eintraege0) anzahl.set(e.text, (anzahl.get(e.text) ?? 0) + 1);
  const eintraege = eintraege0.map((e) => ((anzahl.get(e.text) ?? 0) > 1 ? { ...e, text: `${e.text} (${e.zusatz || e.key})` } : e));
  const textVon = (k: string | null | undefined) => (k ? eintraege.find((e) => e.key === k)?.text ?? '' : '');
  const [text, setText] = useState(textVon(wert));
  // Anzeige folgt dem gespeicherten Wert (z. B. nach dem Laden oder Speichern)
  useEffect(() => { setText(textVon(wert)); }, [wert, eintraege.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function bestaetigen(t: string) {
    const v = t.trim();
    if (!v) { if (leerErlaubt && wert) onWaehle(null); else setText(textVon(wert)); return; }
    const treffer = eintraege.filter((e) => e.text === v);
    const k = treffer.length === 1 ? treffer[0].key : eintraege.find((e) => e.text.toLowerCase() === v.toLowerCase())?.key;
    if (k) { if (k !== wert) onWaehle(k); setText(textVon(k) || v); }
    else setText(textVon(wert)); // kein eindeutiger Eintrag: alten Wert wieder anzeigen
  }

  return (
    <ComboBox value={text} placeholder={placeholder} style={style} readonly={readonly} disabled={disabled} filter={filter} noTypeahead showClearIcon={leerErlaubt}
              onInput={(e) => { setText(e.target.value); onSuche?.(e.target.value); }}
              onChange={(e) => bestaetigen(e.target.value)}>
      {eintraege.map((e) => <ComboBoxItem key={e.key} text={e.text} additionalText={e.zusatz} />)}
    </ComboBox>
  );
}
