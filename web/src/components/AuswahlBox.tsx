import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ComboBox, ComboBoxItem } from '@ui5/webcomponents-react';

/**
 * Suchbare Auswahl (ComboBox) ohne „Autovervollständigen beim Tippen“:
 * Die Standard-ComboBox übernimmt beim Tippen sofort den ersten passenden Eintrag (Typeahead + selection-change) –
 * bei Feldern, die direkt speichern oder Folgefelder füllen, wurde dadurch nach einem Buchstaben ein falscher Eintrag gewählt.
 * Hier wird erst übernommen, wenn ein Eintrag angeklickt bzw. mit Enter bestätigt wird oder der eingegebene Text
 * beim Verlassen genau einem Eintrag entspricht. Pfeiltasten blättern nur.
 *
 * `max`: Bei langen Listen (z. B. 1.600 Kontakte) werden nur so viele Einträge als Elemente aufgebaut –
 * ohne Eingabe die ersten, beim Tippen die passenden (jedes Wort muss in Text oder Zusatz vorkommen).
 * Das Öffnen bleibt dadurch schnell; gesucht wird trotzdem über alle Einträge.
 */
export interface AuswahlEintrag { key: string; text: string; zusatz?: string }

export function AuswahlBox({ eintraege: eintraege0, wert, onWaehle, onSuche, placeholder, style, readonly, disabled, leerErlaubt = true, filter = 'Contains', max }: {
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
  /** höchstens so viele Einträge im Dropdown aufbauen (lange Listen) */
  max?: number;
}) {
  // gleichnamige Einträge (z. B. zwei Mitglieder „Luca Schneider“) eindeutig beschriften
  const eintraege = useMemo(() => {
    const anzahl = new Map<string, number>();
    for (const e of eintraege0) anzahl.set(e.text, (anzahl.get(e.text) ?? 0) + 1);
    return eintraege0.map((e) => ((anzahl.get(e.text) ?? 0) > 1 ? { ...e, text: `${e.text} (${e.zusatz || e.key})` } : e));
  }, [eintraege0]);
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

  const begrenzt = !!max && eintraege.length > max;
  const sichtbar = useMemo(() => {
    if (!begrenzt) return eintraege;
    const q = text.trim().toLowerCase();
    const worte = q && text !== textVon(wert) ? q.split(/\s+/) : [];
    const passt = worte.length ? eintraege.filter((e) => { const h = `${e.text} ${e.zusatz ?? ''}`.toLowerCase(); return worte.every((w) => h.includes(w)); }) : eintraege;
    const teil = passt.slice(0, max);
    const gewaehlt = wert ? eintraege.find((e) => e.key === wert) : undefined;
    return gewaehlt && !teil.includes(gewaehlt) && !worte.length ? [gewaehlt, ...teil] : teil;
  }, [begrenzt, eintraege, text, wert, max]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ComboBox value={text} placeholder={placeholder} style={style} readonly={readonly} disabled={disabled} filter={begrenzt ? 'None' : filter} noTypeahead showClearIcon={leerErlaubt}
              onInput={(e) => { setText(e.target.value); onSuche?.(e.target.value); }}
              onChange={(e) => bestaetigen(e.target.value)}>
      {sichtbar.map((e) => <ComboBoxItem key={e.key} text={e.text} additionalText={e.zusatz} />)}
    </ComboBox>
  );
}
