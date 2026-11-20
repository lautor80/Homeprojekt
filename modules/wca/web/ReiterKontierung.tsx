import { useMemo } from 'react';
import { Section } from '@core/components/Section';
import type { Kategorie, RegelInfo } from '../server/typen';
import { type Sicht } from './ansicht';
import { FundListe } from './FundListe';
import { ARTEN, Kachel, Kacheln, std, zahl } from './util';

const KP: Kategorie[] = ['K', 'P'];

/** Reiter „Kontierung“: Error-Accounts, Funde der Kategorien Kontierung und Plausibilität, Prüfregeln */
export function ReiterKontierung({ sicht }: { sicht: Sicht }) {
  const err = useMemo(() => {
    const m = new Map<string, { name: string; key: string; n: number; h: number; personen: Map<string, number> }>();
    for (const { e } of sicht.eintraege) {
      if (!e.errorAccount) continue;
      const k = `${e.accName}|${e.kunde}`;
      if (!m.has(k)) m.set(k, { name: e.kunde ? `${e.accName} | ${e.kunde}` : e.accName, key: e.accKey, n: 0, h: 0, personen: new Map() });
      const x = m.get(k)!;
      x.n++; x.h += e.stunden;
      x.personen.set(e.person, (x.personen.get(e.person) ?? 0) + e.stunden);
    }
    return [...m.values()].sort((x, y) => y.h - x.h);
  }, [sicht.eintraege]);

  return (
    <>
      <Kacheln>
        <Kachel titel="Error-Accounts im Zeitraum – umbuchen" wert={err.length ? std(err.reduce((s, x) => s + x.h, 0)) : '0'} state={err.length ? 'Negative' : 'Positive'}
                text={err.length ? undefined : 'Keine Error-Accounts im Zeitraum'}>
          {err.map((x) => (
            <div key={x.name} className="portal-small">
              <b>{x.name}</b>{x.key ? ` (${x.key})` : ''}: {x.n} Einträge, {zahl(x.h)} h – {[...x.personen].map(([p, h]) => `${p} ${zahl(h)} h`).join(', ')}
            </div>
          ))}
        </Kachel>
      </Kacheln>
      <FundListe sicht={sicht} kategorien={KP} titel="Funde Kontierung und Plausibilität" />
      <RegelKarten regeln={sicht.a.regeln.filter((r) => KP.includes(r.kategorie))} titel="So wird geprüft" />
    </>
  );
}

/** kurze Beschreibung der Prüfregeln mit Zähler im Zeitraum (ohne Stufenfilter) */
export function RegelKarten({ regeln, titel }: { regeln: RegelInfo[]; titel: string }) {
  return (
    <Section title={titel} count={regeln.length}>
      <div className="portal-wca-regeln">
        {regeln.map((r) => (
          <div key={r.id} className={`portal-wca-regel${r.aktiv ? '' : ' portal-wca-regel--aus'}`}>
            <div><b>{r.id}</b> {r.name} <span className="portal-muted portal-small">· {ARTEN[r.art] ?? r.art}{r.aktiv ? '' : ' · abgeschaltet'}</span></div>
            <div className="portal-small">{r.erkennung}</div>
            {r.tipp && <div className="portal-small portal-muted">Tipp: {r.tipp}</div>}
            <div className="portal-small"><b>{r.anzahl}×</b> · {zahl(r.stunden)} h</div>
          </div>
        ))}
      </div>
    </Section>
  );
}
