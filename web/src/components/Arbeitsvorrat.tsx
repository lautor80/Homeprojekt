import { useMemo, useState, type ReactNode } from 'react';
import { CheckBox, Icon } from '@ui5/webcomponents-react';
import { Section } from './Section';

/**
 * Arbeitsvorrat (#232, V2): Baumdarstellung offener Vorgänge – auf der Startseite für alle Anwendungen und in der
 * Vereinsübersicht für TC Oberthal. Oberste Ebene je Zuständigkeit (Kassenwart, Hallenwart, Administration …) mit Anzahl,
 * aufklappbar; der Zustand (auf/zu) bleibt im Browser gespeichert. Einträge mit Unterpunkten klappen ihre Details auf;
 * der Pfeil rechts springt in die App, aus der der Eintrag stammt.
 */
export interface Aufgabe {
  key: string; bereich: string; titel: string; text: string; datum: string | null; icon: string;
  state: 'Information' | 'Critical' | 'Negative'; pfad: string; betrag?: number;
  /** Kästchen: Erledigung bestätigen, danach verschwindet der Eintrag */
  erledigen?: { text: string; url: string; body: Record<string, unknown> };
  /** Upload „Überweisung an Einreicher“ (TC Oberthal): Zahlungsdaten und QR-Code im Popup */
  zahlung?: { id: number };
  /** Unterpunkte, z. B. die einzelnen Buchungen */
  kinder?: Aufgabe[];
}

/** Zusatz eines Moduls am Eintrag (z. B. Knopf „Zahlungsdaten“) – erledigt() bestätigt den Eintrag */
export type AufgabenZusatz = (a: Aufgabe, erledigt: () => void) => ReactNode;

interface Aktionen { onOeffnen: (a: Aufgabe) => void; onErledigen: (a: Aufgabe) => void; zusatz?: AufgabenZusatz }

const dat = (iso: string) => iso.split('-').reverse().join('.');
const RANG = { Negative: 3, Critical: 2, Information: 1 } as const;
function offenLesen(speicher: string): string[] | null {
  try { const v = localStorage.getItem(speicher); return v ? JSON.parse(v) as string[] : null; } catch { return null; }
}

function Eintrag({ a, ebene = 1, ...akt }: { a: Aufgabe; ebene?: number } & Aktionen) {
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
        <button type="button" className="portal-av__inhalt portal-av__sprung" onClick={() => (kinder.length ? setAuf(!auf) : akt.onOeffnen(a))}>
          <div className="portal-av__titel">{a.titel}</div>
          <div className="portal-av__text">{a.text}</div>
        </button>
        <div className="portal-av__datum">
          {akt.zusatz?.(a, () => akt.onErledigen(a))}
          {a.erledigen ? <CheckBox text={a.erledigen.text} onChange={(e) => { if (e.target.checked) akt.onErledigen(a); }} /> : a.datum ? dat(a.datum) : ''}
        </div>
        <button type="button" className="portal-av__auf" aria-label="App öffnen" title="App öffnen" onClick={() => akt.onOeffnen(a)}>
          <Icon name="navigation-right-arrow" className="portal-av__pfeil" />
        </button>
      </div>
      {auf && kinder.map((k) => <Eintrag key={k.key} a={k} ebene={ebene + 1} {...akt} />)}
    </>
  );
}

export function ArbeitsvorratBaum({ liste, titel = 'Arbeitsvorrat', speicher = 'tco.arbeitsvorrat.offen', ...akt }: { liste: Aufgabe[]; titel?: string; speicher?: string } & Aktionen) {
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
  const [offen, setOffen] = useState<Set<string>>(() => new Set(offenLesen(speicher) ?? []));
  const umschalten = (b: string) => {
    const n = new Set(offen);
    if (n.has(b)) n.delete(b); else n.add(b);
    setOffen(n);
    try { localStorage.setItem(speicher, JSON.stringify([...n])); } catch { /* egal */ }
  };
  const auf = (b: string) => gruppen.length === 1 || offen.has(b);
  return (
    <Section title={titel} count={liste.length} flush>
      <div className="portal-av" role="tree">
        {gruppen.map((g) => (
          <div key={g.bereich} role="treeitem" aria-expanded={auf(g.bereich)}>
            <button type="button" className={`portal-av__eintrag portal-av__gruppe portal-av__eintrag--${g.state}`} onClick={() => umschalten(g.bereich)}>
              <Icon name={auf(g.bereich) ? 'navigation-down-arrow' : 'navigation-right-arrow'} className="portal-av__icon" />
              <div className="portal-av__inhalt"><div className="portal-av__titel">{g.bereich}</div></div>
              <span className="portal-av__anzahl">{g.eintraege.length}</span>
            </button>
            {auf(g.bereich) && <div role="group">{g.eintraege.map((a) => <Eintrag key={a.key} a={a} {...akt} />)}</div>}
          </div>
        ))}
      </div>
    </Section>
  );
}
