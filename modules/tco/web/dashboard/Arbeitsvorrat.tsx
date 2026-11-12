import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { Section } from '@core/components/Section';
import { DASH } from './typen';

export interface Aufgabe {
  key: string; bereich: string; titel: string; text: string; datum: string | null; icon: string;
  state: 'Information' | 'Critical' | 'Negative'; pfad: string; betrag?: number;
  /** Unterpunkte, z. B. die einzelnen Buchungen */
  kinder?: Aufgabe[];
}

const dat = (iso: string) => iso.split('-').reverse().join('.');
const RANG = { Negative: 3, Critical: 2, Information: 1 } as const;
const OFFEN_KEY = 'tco.arbeitsvorrat.offen';
function offenLesen(): string[] | null {
  try { const v = localStorage.getItem(OFFEN_KEY); return v ? JSON.parse(v) as string[] : null; } catch { return null; }
}

/**
 * Arbeitsvorrat der Vereinsübersicht: offene Vorgänge (z. B. freigegebene Zeitnachweise der Trainer,
 * Registrierungen). Ein Klick öffnet die App, in der der Vorgang erledigt wird. Ohne Einträge unsichtbar.
 * Baumdarstellung: oberste Ebene je Rolle (Jugendwart, Kassenwart, Vorstand, Hallenwart, …) mit Anzahl, aufklappbar; der Zustand
 * (auf/zu) bleibt im Browser gespeichert. Einträge mit Unterpunkten (z. B. die einzelnen Hallenbuchungen von heute) klappen ihre
 * Details auf; der Pfeil rechts springt in die App, aus der der Hinweis stammt.
 */
export function Arbeitsvorrat({ neu, leerText }: { neu: number; leerText?: string }) {
  const [liste, setListe] = useState<Aufgabe[]>([]);
  const navigate = useNavigate();
  useEffect(() => { api.get<Aufgabe[]>(`${DASH}/arbeitsvorrat`).then(setListe).catch(() => setListe([])); }, [neu]);
  if (!liste.length) {
    return leerText ? <Section title="Arbeitsvorrat" count={0}><span className="portal-muted">{leerText}</span></Section> : null;
  }
  return <Baum liste={liste} onOeffnen={(a) => navigate(a.pfad)} />;
}

function Eintrag({ a, onOeffnen, ebene = 1 }: { a: Aufgabe; onOeffnen: (a: Aufgabe) => void; ebene?: number }) {
  const [auf, setAuf] = useState(false);
  const kinder = a.kinder ?? [];
  return (
    <>
      <div className={`portal-av__eintrag portal-av__eintrag--kind portal-av__eintrag--${a.state}`} style={{ paddingLeft: `${1 + ebene * 1.25}rem` }}>
        {kinder.length
          ? <button type="button" className="portal-av__auf" aria-label={auf ? 'Details einklappen' : 'Details aufklappen'} aria-expanded={auf} onClick={() => setAuf(!auf)}>
              <Icon name={auf ? 'navigation-down-arrow' : 'navigation-right-arrow'} />
            </button>
          : <Icon name={a.icon} className="portal-av__icon" />}
        <button type="button" className="portal-av__inhalt portal-av__sprung" onClick={() => (kinder.length ? setAuf(!auf) : onOeffnen(a))}>
          <div className="portal-av__titel">{a.titel}</div>
          <div className="portal-av__text">{a.text}</div>
        </button>
        <div className="portal-av__datum">{a.datum ? dat(a.datum) : ''}</div>
        <button type="button" className="portal-av__auf" aria-label="App öffnen" title="App öffnen" onClick={() => onOeffnen(a)}>
          <Icon name="navigation-right-arrow" className="portal-av__pfeil" />
        </button>
      </div>
      {auf && kinder.map((k) => <Eintrag key={k.key} a={k} onOeffnen={onOeffnen} ebene={ebene + 1} />)}
    </>
  );
}

function Baum({ liste, onOeffnen }: { liste: Aufgabe[]; onOeffnen: (a: Aufgabe) => void }) {
  // Gruppen in der Reihenfolge des ersten Auftretens; Farbe = dringendster Eintrag
  const gruppen = useMemo(() => {
    const m = new Map<string, Aufgabe[]>();
    for (const a of liste) m.set(a.bereich, [...(m.get(a.bereich) ?? []), a]);
    return [...m.entries()].map(([bereich, eintraege]) => ({
      bereich, eintraege,
      state: eintraege.reduce<Aufgabe['state']>((s, a) => (RANG[a.state] > RANG[s] ? a.state : s), 'Information'),
    }));
  }, [liste]);
  // Standard: alles zugeklappt, nur bei einer einzigen Gruppe offen
  const [offen, setOffen] = useState<Set<string>>(() => new Set(offenLesen() ?? []));
  const umschalten = (b: string) => {
    const n = new Set(offen);
    if (n.has(b)) n.delete(b); else n.add(b);
    setOffen(n);
    try { localStorage.setItem(OFFEN_KEY, JSON.stringify([...n])); } catch { /* egal */ }
  };
  const auf = (b: string) => gruppen.length === 1 || offen.has(b);
  return (
    <Section title="Arbeitsvorrat" count={liste.length} flush>
      <div className="portal-av" role="tree">
        {gruppen.map((g) => (
          <div key={g.bereich} role="treeitem" aria-expanded={auf(g.bereich)}>
            <button type="button" className={`portal-av__eintrag portal-av__gruppe portal-av__eintrag--${g.state}`} onClick={() => umschalten(g.bereich)}>
              <Icon name={auf(g.bereich) ? 'navigation-down-arrow' : 'navigation-right-arrow'} className="portal-av__icon" />
              <div className="portal-av__inhalt"><div className="portal-av__titel">{g.bereich}</div></div>
              <span className="portal-av__anzahl">{g.eintraege.length}</span>
            </button>
            {auf(g.bereich) && <div role="group">{g.eintraege.map((a) => <Eintrag key={a.key} a={a} onOeffnen={onOeffnen} />)}</div>}
          </div>
        ))}
      </div>
    </Section>
  );
}
