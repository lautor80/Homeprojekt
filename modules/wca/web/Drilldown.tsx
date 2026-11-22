import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Icon, Option, Select } from '@ui5/webcomponents-react';
import type { PersonAuswertung, Stufe } from '../server/typen';
import { BAUM_FELDER, BAUM_STANDARD, baum, baumFelderLesen, type BaumFeld, type Knoten, type Sicht } from './ansicht';
import { proz, StufeStatus, zahl } from './util';

const SPEICHER = 'wca.baum.felder';

function felderLaden(): BaumFeld[] {
  try { return baumFelderLesen(JSON.parse(localStorage.getItem(SPEICHER) ?? 'null')); } catch { return [...BAUM_STANDARD]; }
}

/** Feldauswahl für den Baum: gewählte Felder als Ebenen in Reihenfolge (verschieben, entfernen), weitere hinzufügen */
function Gruppierung({ felder, onChange }: { felder: BaumFeld[]; onChange: (f: BaumFeld[]) => void }) {
  const frei = (Object.keys(BAUM_FELDER) as BaumFeld[]).filter((f) => !felder.includes(f));
  const tausch = (i: number, j: number) => { const n = [...felder]; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  const standard = felder.join() === BAUM_STANDARD.join();
  return (
    <div className="portal-row portal-wca-gruppierung" style={{ flexWrap: 'wrap', gap: '0.25rem 0.5rem' }}>
      <span className="portal-muted portal-small">Gruppierung:</span>
      {felder.map((f, i) => (
        <span key={f} className="portal-wca-gruppierung__feld">
          <Button design="Transparent" icon="navigation-left-arrow" tooltip="Eine Ebene nach oben" disabled={i === 0} onClick={() => tausch(i, i - 1)} />
          <span>{i + 1}. {BAUM_FELDER[f].text}</span>
          <Button design="Transparent" icon="navigation-right-arrow" tooltip="Eine Ebene nach unten" disabled={i === felder.length - 1} onClick={() => tausch(i, i + 1)} />
          <Button design="Transparent" icon="decline" tooltip="Ebene entfernen" disabled={felder.length === 1} onClick={() => onChange(felder.filter((x) => x !== f))} />
        </span>
      ))}
      {frei.length > 0 && (
        <Select key={felder.join()} style={{ width: '13rem' }} onChange={(e) => {
          const k = (e.detail.selectedOption as HTMLElement).dataset.k as BaumFeld | undefined;
          if (k) onChange([...felder, k]);
        }}>
          <Option data-k="" selected>+ Ebene hinzufügen …</Option>
          {frei.map((f) => <Option key={f} data-k={f}>{BAUM_FELDER[f].text}</Option>)}
        </Select>
      )}
      {!standard && <Button design="Transparent" icon="reset" onClick={() => onChange([...BAUM_STANDARD])}>Standard</Button>}
    </div>
  );
}

/** Drilldown je Person: Buchungen gruppiert nach frei wählbaren Feldern mit Stunden, Anteil, Buchungstagen und höchster Fundstufe */
export function Drilldown({ sicht, p }: { sicht: Sicht; p: PersonAuswertung }) {
  const [felder, setFelderRoh] = useState<BaumFeld[]>(felderLaden);
  const setFelder = (f: BaumFeld[]) => {
    setFelderRoh(f);
    try { localStorage.setItem(SPEICHER, JSON.stringify(f)); } catch { /* egal */ }
  };
  const knoten = useMemo(() => baum(sicht.eintraege.filter(({ e }) => e.person === p.person), felder), [sicht.eintraege, p.person, felder]);
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
  useEffect(() => { setOffen(new Set(knoten.map((k) => k.id))); }, [felder]); // eslint-disable-line react-hooks/exhaustive-deps
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
            {k.feld === 'taetigkeit' && k.text !== '(kein Text)' ? `„${k.text}“` : k.text}
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
        <b>Buchungen nach {felder.map((f) => BAUM_FELDER[f].text).join(' → ')} ({zahl(gesamt)} h)</b>
        {knoten.length > 0 && (
          <div className="portal-row">
            <Button design="Transparent" icon="expand-all" onClick={() => setOffen(new Set(alleIds(knoten)))}>Alle aufklappen</Button>
            <Button design="Transparent" icon="collapse-all" onClick={() => setOffen(new Set())}>Alle zuklappen</Button>
          </div>
        )}
      </div>
      <Gruppierung felder={felder} onChange={setFelder} />
      {knoten.length ? <div className="portal-wca-baum">{knoten.map((k) => zeile(k, 0))}</div> : <div className="portal-muted">keine Buchungen im Zeitraum</div>}
    </div>
  );
}
