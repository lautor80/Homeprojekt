import { useMemo } from 'react';
import { Section } from '@core/components/Section';
import type { Art, Kategorie, PersonAuswertung } from '../server/typen';
import { type Sicht } from './ansicht';
import { FundListe } from './FundListe';
import { RegelKarten } from './ReiterKontierung';
import { proz, type Spalte, Tabelle, zahl } from './util';

const TR: Kategorie[] = ['T', 'R'];

interface Haeufig { text: string; tage: number; h: number; personen: number }

/** Reiter „Texte“: Prüfmethoden, Funde Texte und Regelwerk, Textqualität je Person, häufigste Texte */
export function ReiterTexte({ sicht }: { sicht: Sicht }) {
  const { a, f, personen } = sicht;

  // Gruppen je Person und Rubrik ab Stufe (Nichtssagend, Fragwürdig)
  const rubrik = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of sicht.gruppen) {
      const arten = new Set(g.funde.filter((x) => x.kategorie === 'T' && x.stufe >= f.stufe).map((x) => x.art));
      for (const art of arten) m.set(`${g.person}|${art}`, (m.get(`${g.person}|${art}`) ?? 0) + 1);
    }
    return (p: string, art: Art) => m.get(`${p}|${art}`) ?? 0;
  }, [sicht.gruppen, f.stufe]);

  const haeufig = useMemo(() => {
    const m = new Map<string, { text: string; tage: Set<string>; h: number; personen: Set<string> }>();
    for (const { e } of sicht.eintraege) {
      if (e.typ === 'A' || !e.text.trim()) continue;
      const k = e.text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!m.has(k)) m.set(k, { text: e.text.trim(), tage: new Set(), h: 0, personen: new Set() });
      const x = m.get(k)!;
      for (const [t] of e.tage) x.tage.add(`${e.person}|${t}`);
      x.h += e.stunden;
      x.personen.add(e.person);
    }
    return [...m.values()].map((x): Haeufig => ({ text: x.text, tage: x.tage.size, h: x.h, personen: x.personen.size }))
      .sort((x, y) => y.tage - x.tage || y.h - x.h).slice(0, 25);
  }, [sicht.eintraege]);

  const qualitaet: Spalte<PersonAuswertung>[] = [
    { titel: 'Person', wert: (p) => p.person, sort: (p) => p.person },
    { titel: 'Team', wert: (p) => p.team, sort: (p) => p.team },
    { titel: 'Einträge', rechts: true, wert: (p) => p.eintraegeZeitraum, sort: (p) => p.eintraegeZeitraum },
    { titel: 'Unauffällig', rechts: true, wert: (p) => proz(p.texteUnauffaellig), sort: (p) => p.texteUnauffaellig ?? 2 },
    { titel: 'Nichtssagend', rechts: true, wert: (p) => rubrik(p.person, 'ns') || '', sort: (p) => rubrik(p.person, 'ns') },
    { titel: 'Fragwürdig', rechts: true, wert: (p) => rubrik(p.person, 'fr') || '', sort: (p) => rubrik(p.person, 'fr') },
    { titel: 'Regelwerk', rechts: true, wert: (p) => p.regelwerk[0] || '', sort: (p) => p.regelwerk[0] },
  ];

  const regeln = a.regeln.filter((r) => TR.includes(r.kategorie));
  return (
    <>
      <FundListe sicht={sicht} kategorien={TR} titel="Funde Texte und Regelwerk" />
      <Section title="Textqualität je Person" count={personen.length} flush>
        <Tabelle<PersonAuswertung> spalten={qualitaet} zeilen={personen.filter((p) => p.eintraegeZeitraum > 0)} schluessel={(p) => p.person}
                                   sortierung={{ titel: 'Unauffällig' }} leer="Keine Einträge im Zeitraum" />
      </Section>
      <Section title="Häufigste Texte" count={haeufig.length} flush>
        <Tabelle<Haeufig> zeilen={haeufig} schluessel={(x) => x.text} leer="Keine Texte im Zeitraum" spalten={[
          { titel: 'Text', breit: true, wert: (x) => `„${x.text}“` },
          { titel: 'Tage', rechts: true, wert: (x) => x.tage, sort: (x) => x.tage },
          { titel: 'h', rechts: true, wert: (x) => zahl(x.h), sort: (x) => x.h },
          { titel: 'Personen', rechts: true, wert: (x) => x.personen, sort: (x) => x.personen },
        ]} />
      </Section>
      <RegelKarten titel="Nichtssagend" regeln={regeln.filter((r) => r.art === 'ns')} />
      <RegelKarten titel="Fragwürdig" regeln={regeln.filter((r) => r.art === 'fr')} />
      <RegelKarten titel="Regelwerk" regeln={regeln.filter((r) => r.art === 're')} />
    </>
  );
}
