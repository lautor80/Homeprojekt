import { useMemo, useState } from 'react';
import { Input, ObjectStatus } from '@ui5/webcomponents-react';
import { Section } from '@core/components/Section';
import type { AuswEintrag, PersonAuswertung } from '../server/typen';
import { summen, type Sicht } from './ansicht';
import { proz, quote, type Spalte, summe, Tabelle, TYPEN, Verteilung, VerteilungLegende, zahl } from './util';

interface Topf {
  id: string;
  name: string;
  key: string;
  kunde: string;
  error: boolean;
  B: number; P: number; I: number; A: number;
  gesamt: number;
  personen: Map<string, number>;
  unter: Map<string, Topf>;
  eintraege: { e: AuswEintrag; i: number }[];
}
const neuerTopf = (id: string, name: string, key = '', kunde = '', error = false): Topf =>
  ({ id, name, key, kunde, error, B: 0, P: 0, I: 0, A: 0, gesamt: 0, personen: new Map(), unter: new Map(), eintraege: [] });
function buchen(t: Topf, e: AuswEintrag, i: number) {
  t[e.typ] += e.stunden;
  t.gesamt += e.stunden;
  t.personen.set(e.person, (t.personen.get(e.person) ?? 0) + e.stunden);
  t.eintraege.push({ e, i });
}
const accId = (e: AuswEintrag) => `${e.accName}|${e.kunde}`;
const treffer = (suche: string, ...felder: string[]) => {
  const worte = suche.toLowerCase().split(/\s+/).filter(Boolean);
  const t = felder.join(' ').toLowerCase();
  return worte.every((w) => t.includes(w));
};

/** Reiter „Billable“: Stunden nach Team und Person, Bereiche (Jira-Projekte) und Accounts */
export function ReiterBillable({ sicht }: { sicht: Sicht }) {
  const { personen } = sicht;
  const [sucheBer, setSucheBer] = useState('');
  const [sucheAcc, setSucheAcc] = useState('');

  const { bereiche, accounts } = useMemo(() => {
    const ber = new Map<string, Topf>();
    const acc = new Map<string, Topf>();
    for (const { e, i } of sicht.eintraege) {
      const bn = e.ber || '(ohne Bereich)';
      if (!ber.has(bn)) ber.set(bn, neuerTopf(bn, bn, e.berKey));
      const b = ber.get(bn)!;
      buchen(b, e, i);
      if (!b.unter.has(accId(e))) b.unter.set(accId(e), neuerTopf(accId(e), e.accName, e.accKey, e.kunde, e.errorAccount));
      buchen(b.unter.get(accId(e))!, e, i);
      if (!acc.has(accId(e))) acc.set(accId(e), neuerTopf(accId(e), e.accName, e.accKey, e.kunde, e.errorAccount));
      buchen(acc.get(accId(e))!, e, i);
    }
    return {
      bereiche: [...ber.values()].sort((x, y) => y.gesamt - x.gesamt),
      accounts: [...acc.values()].sort((x, y) => Number(y.error) - Number(x.error) || y.gesamt - x.gesamt),
    };
  }, [sicht.eintraege]);

  const stunden = <T extends { B: number; P: number; I: number; A: number }>(mitSumme: boolean): Spalte<T>[] => [
    { titel: 'Billable', rechts: true, wert: (z) => zahl(z.B), sort: (z) => z.B, summe: mitSumme ? summe((z) => z.B) : undefined },
    { titel: 'PreSales', rechts: true, wert: (z) => zahl(z.P), sort: (z) => z.P, summe: mitSumme ? summe((z) => z.P) : undefined },
    { titel: 'Intern', rechts: true, wert: (z) => zahl(z.I), sort: (z) => z.I, summe: mitSumme ? summe((z) => z.I) : undefined },
    { titel: 'Abw.', rechts: true, wert: (z) => zahl(z.A), sort: (z) => z.A, summe: mitSumme ? summe((z) => z.A) : undefined },
  ];

  const personSpalten: Spalte<PersonAuswertung>[] = [
    { titel: 'Person', wert: (p) => p.person, sort: (p) => p.person, summe: () => 'Summe' },
    ...stunden<PersonAuswertung>(true),
    { titel: 'Arbeitszeit', rechts: true, tooltip: 'Billable + PreSales + Intern', wert: (p) => zahl(p.B + p.P + p.I), sort: (p) => p.B + p.P + p.I, summe: summe((p) => p.B + p.P + p.I) },
    {
      titel: 'Quote', rechts: true, tooltip: 'Billable-Quote B / (B + P + I)', wert: (p) => proz(p.billableQuote), sort: (p) => p.billableQuote ?? -1,
      summe: (ps) => { const s = summen(ps); return proz(quote(s.B, s.P + s.I)); },
    },
    { titel: 'Verteilung', wert: (p) => <Verteilung {...p} /> },
  ];

  const bereichSpalten: Spalte<Topf>[] = [
    { titel: 'Bereich', wert: (t) => <>{t.name}{t.key && <span className="portal-muted"> ({t.key})</span>}</>, sort: (t) => t.name },
    ...stunden<Topf>(false),
    { titel: 'Gesamt', rechts: true, wert: (t) => zahl(t.gesamt), sort: (t) => t.gesamt },
    { titel: 'Accounts', rechts: true, wert: (t) => t.unter.size, sort: (t) => t.unter.size },
    { titel: 'Personen', rechts: true, wert: (t) => t.personen.size, sort: (t) => t.personen.size },
  ];
  const accountSpalten: Spalte<Topf>[] = [
    {
      titel: 'Account', sort: (t) => t.name, wert: (t) => (
        <>{t.name}{t.key && <span className="portal-muted"> ({t.key})</span>} {t.error && <ObjectStatus state="Negative" inverted>Error-Account</ObjectStatus>}</>
      ),
    },
    { titel: 'Kunde', wert: (t) => t.kunde, sort: (t) => t.kunde },
    ...stunden<Topf>(false),
    { titel: 'Gesamt', rechts: true, wert: (t) => zahl(t.gesamt), sort: (t) => t.gesamt },
    { titel: 'Personen', rechts: true, wert: (t) => t.personen.size, sort: (t) => t.personen.size },
  ];

  const bListe = bereiche.filter((t) => !sucheBer || treffer(sucheBer, t.name, t.key, ...[...t.unter.values()].flatMap((u) => [u.name, u.kunde, u.key])));
  const aListe = accounts.filter((t) => !sucheAcc || treffer(sucheAcc, t.name, t.kunde, t.key));

  return (
    <>
      <Section title="Stunden nach Team und Person" count={personen.length} flush status={<VerteilungLegende />}>
        <Tabelle<PersonAuswertung> spalten={personSpalten} zeilen={personen} schluessel={(p) => p.person} gruppe={(p) => p.team}
                                   sortierung={{ titel: 'Billable', ab: true }} leer="Keine Personen im Filter"
                                   gruppenKopf={(team, ps) => {
                                     const s = summen(ps);
                                     return <><b>{team}</b> <span className="portal-muted">· Billable {zahl(s.B)} h · PreSales {zahl(s.P)} h · Intern {zahl(s.I)} h · Abw. {zahl(s.A)} h · Quote {proz(quote(s.B, s.P + s.I))}</span></>;
                                   }} />
      </Section>

      <Section title="Bereiche" count={bListe.length} flush
               actions={<Input placeholder="Bereich, Schlüssel …" value={sucheBer} showClearIcon onInput={(e) => setSucheBer(e.target.value)} />}>
        <Tabelle<Topf> spalten={bereichSpalten} zeilen={bListe} schluessel={(t) => t.id} max={40} leer="Keine Bereiche"
                       detail={(t) => (
                         <div className="portal-wca-detailinhalt">
                           <Tabelle<Topf> klein spalten={accountSpalten} zeilen={[...t.unter.values()].sort((x, y) => y.gesamt - x.gesamt)} schluessel={(u) => u.id} />
                           <PersonenStunden personen={t.personen} />
                         </div>
                       )} />
      </Section>

      <Section title="Accounts" count={aListe.length} flush
               actions={<Input placeholder="Account, Kunde, Schlüssel …" value={sucheAcc} showClearIcon onInput={(e) => setSucheAcc(e.target.value)} />}>
        <Tabelle<Topf> spalten={accountSpalten} zeilen={aListe} schluessel={(t) => t.id} max={60} leer="Keine Accounts"
                       detail={(t) => (
                         <div className="portal-wca-detailinhalt">
                           <PersonenStunden personen={t.personen} />
                           <Tabelle<{ e: AuswEintrag; i: number }> klein zeilen={[...t.eintraege].sort((x, y) => y.e.stunden - x.e.stunden).slice(0, 60)}
                                                                   schluessel={(z) => String(z.i)} spalten={[
                             { titel: 'Person', wert: ({ e }) => e.person },
                             { titel: 'Bereich', wert: ({ e }) => e.ber },
                             { titel: 'Ticket', fest: true, wert: ({ e }) => e.key },
                             { titel: 'Art', wert: ({ e }) => TYPEN[e.typ] },
                             { titel: 'h', rechts: true, wert: ({ e }) => zahl(e.stunden) },
                             { titel: 'Text', breit: true, wert: ({ e }) => e.text },
                           ]} />
                         </div>
                       )} />
      </Section>
    </>
  );
}

function PersonenStunden({ personen }: { personen: Map<string, number> }) {
  return (
    <div className="portal-wca-tagliste">
      {[...personen].sort(([, x], [, y]) => y - x).map(([p, h]) => <span key={p}>{p}: {zahl(h)} h</span>)}
    </div>
  );
}
