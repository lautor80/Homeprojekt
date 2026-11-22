import { useMemo, useState, type ReactNode } from 'react';
import { Button, Icon } from '@ui5/webcomponents-react';
import type { PersonAuswertung, Stufe } from '../server/typen';
import { baum, type Knoten, type Sicht } from './ansicht';
import { proz, StufeStatus, zahl } from './util';

/** Drilldown je Person: Kategorie → Projekt (Account) → Tätigkeit mit Stunden, Anteil, Buchungstagen und höchster Fundstufe */
export function Drilldown({ sicht, p }: { sicht: Sicht; p: PersonAuswertung }) {
  const knoten = useMemo(() => baum(sicht.eintraege.filter(({ e }) => e.person === p.person)), [sicht.eintraege, p.person]);
  const gesamt = knoten.reduce((s, k) => s + k.stunden, 0);
  // höchste Fundstufe je Eintrag (über alle Kategorien, ab der gewählten Stufe)
  const stufeJe = useMemo(() => {
    const m = new Map<number, Stufe>();
    for (const g of sicht.gruppen) {
      if (g.person !== p.person || g.eintrag === null) continue;
      const s = g.funde.filter((f) => f.stufe >= sicht.f.stufe).reduce((x, f) => Math.max(x, f.stufe), 0);
      if (s) m.set(g.eintrag, s as Stufe);
    }
    return m;
  }, [sicht.gruppen, sicht.f.stufe, p.person]);
  const [offen, setOffen] = useState<Set<string>>(() => new Set(knoten.map((k) => k.id)));
  const umschalten = (id: string) => setOffen((alt) => { const n = new Set(alt); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const alleIds = (ks: Knoten[]): string[] => ks.flatMap((k) => (k.kinder.length ? [k.id, ...alleIds(k.kinder)] : []));

  function zeile(k: Knoten, ebene: number): ReactNode {
    const auf = offen.has(k.id);
    const stufe = k.eintraege.reduce((x, i) => Math.max(x, stufeJe.get(i) ?? 0), 0) as Stufe | 0;
    return (
      <div key={k.id}>
        <div className={`portal-wca-baum__zeile portal-wca-baum__e${ebene}`} style={{ paddingLeft: `${ebene * 1.25}rem` }}>
          {k.kinder.length
            ? <Button design="Transparent" icon={auf ? 'navigation-down-arrow' : 'navigation-right-arrow'} tooltip={auf ? 'Zuklappen' : 'Aufklappen'} onClick={() => umschalten(k.id)} />
            : <Icon name="circle-task" className="portal-wca-baum__blatt" />}
          <span className="portal-wca-baum__text">
            {ebene === 2 ? `„${k.text}“` : k.text}
            {k.zusatz && <span className="portal-muted portal-small"> · {k.zusatz}</span>}
            {stufe ? <> <StufeStatus stufe={stufe} /></> : null}
          </span>
          <span className="portal-wca-baum__zahl">{zahl(k.stunden)} h</span>
          <span className="portal-wca-baum__zahl portal-muted">{proz(gesamt ? k.stunden / gesamt : null)}</span>
          <span className="portal-wca-baum__zahl portal-muted">{k.tage} {k.tage === 1 ? 'Tag' : 'Tage'}</span>
        </div>
        {auf && k.kinder.map((c) => zeile(c, ebene + 1))}
      </div>
    );
  }

  return (
    <div>
      <div className="portal-row" style={{ justifyContent: 'space-between' }}>
        <b>Buchungen nach Kategorie, Projekt und Tätigkeit ({zahl(gesamt)} h)</b>
        {knoten.length > 0 && (
          <div className="portal-row">
            <Button design="Transparent" icon="expand-all" onClick={() => setOffen(new Set(alleIds(knoten)))}>Alle aufklappen</Button>
            <Button design="Transparent" icon="collapse-all" onClick={() => setOffen(new Set())}>Alle zuklappen</Button>
          </div>
        )}
      </div>
      {knoten.length ? <div className="portal-wca-baum">{knoten.map((k) => zeile(k, 0))}</div> : <div className="portal-muted">keine Buchungen im Zeitraum</div>}
    </div>
  );
}
