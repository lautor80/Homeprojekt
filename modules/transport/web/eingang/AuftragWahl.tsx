import { useEffect, useState } from 'react';
import { Input, SuggestionItem } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { T, type ListRow } from '../util';

/**
 * Auftragsauswahl im Posteingang: Eingabe der Auftragsnummer mit Vorschlägen aus der Auftragsliste (GET /auftraege, wie in
 * der App Aufträge). Gesucht wird in Auftragsnummer, Kunde, Kennzeichen und Unternehmer. Die Liste wird einmal je Seite geladen.
 */
let cache: Promise<ListRow[]> | null = null;
export function auftraegeLaden(neu = false): Promise<ListRow[]> {
  if (!cache || neu) cache = api.get<ListRow[]>(`${T}/auftraege`).catch((e) => { cache = null; throw e; });
  return cache;
}

/** Aufträge für die Auswahl (null = noch nicht geladen); aktiv = false lädt nichts (z. B. ohne Recht) */
export function useAuftraege(aktiv: boolean): ListRow[] | null {
  const [l, setL] = useState<ListRow[] | null>(null);
  useEffect(() => {
    if (!aktiv) return;
    let ende = false;
    auftraegeLaden().then((x) => { if (!ende) setL(x); }).catch(() => { if (!ende) setL([]); });
    return () => { ende = true; };
  }, [aktiv]);
  return l;
}

const normal = (s: string) => s.toLowerCase().replace(/[-/]/g, '_');

export function AuftragWahl({ wert, onChange, auftraege, disabled }: {
  wert: string; onChange: (nr: string) => void; auftraege: ListRow[] | null; disabled?: boolean;
}) {
  const q = normal(wert.trim());
  const treffer = !auftraege ? [] : (q
    ? auftraege.filter((a) => normal(a.auftragsnr).includes(q) || normal(a.kunde).includes(q)
      || (a.kennzeichen ?? '').toLowerCase().includes(q) || a.unternehmerNamen.toLowerCase().includes(q))
    : auftraege.filter((a) => a.status === 'Offen')).slice(0, 30);
  // die Vorschläge zeigen die Auftragsnummer; ausgewählt steht nur sie im Feld
  const setzen = (v: string) => onChange(v.trim().split(/\s+/)[0] ?? '');
  return (
    <Input value={wert} showSuggestions disabled={disabled} style={{ width: '100%' }} data-kein-autofill
           placeholder={auftraege ? 'Auftragsnummer oder Kunde suchen' : 'Aufträge werden geladen …'}
           onInput={(e) => onChange(e.target.value)} onChange={(e) => setzen(e.target.value)}>
      {treffer.map((a) => (
        <SuggestionItem key={a.auftragsnr} text={a.auftragsnr}
                        additionalText={[a.kunde, a.route, a.status !== 'Offen' ? a.status : ''].filter(Boolean).join(' · ')} />
      ))}
    </Input>
  );
}

/** Kunde zu einer Auftragsnummer aus der geladenen Liste */
export const kundeVon = (auftraege: ListRow[] | null, nr: string | null | undefined) =>
  (nr && auftraege?.find((a) => a.auftragsnr === nr)?.kunde) || null;
