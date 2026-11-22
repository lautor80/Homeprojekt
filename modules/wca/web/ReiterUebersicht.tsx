import { useMemo } from 'react';
import { Button, MessageStrip, ObjectStatus, TextArea } from '@ui5/webcomponents-react';
import { Attribute, Attributes } from '@core/components/Attributes';
import { Section } from '@core/components/Section';
import type { PersonAuswertung } from '../server/typen';
import { mitKategorie, summen, tageVon, unauffaellig, zeilen, type Filter, type Sicht, type Zeile } from './ansicht';
import { Drilldown } from './Drilldown';
import { FreigabeKnopf, tageText } from './FundListe';
import {
  arbeitstageText, dat, Kachel, Kacheln, kopieren, Pill, proz, quote, type Spalte, std, StufeStatus, stufeText, summe, Tabelle, Verteilung,
  VerteilungLegende, wtm, zahl,
} from './util';

interface TeamZeile extends ReturnType<typeof summen> { team: string; personen: number }

const offenStatus = (offen: number, ok: boolean) => <ObjectStatus state={ok ? 'Positive' : 'Critical'}>{ok ? 'ok' : zahl(offen)}</ObjectStatus>;
function zaehler(k: [number, number, number, number]) {
  if (!k[0]) return <span className="portal-muted">0</span>;
  return <>{k[3] > 0 && <><ObjectStatus state="Negative" inverted>{k[3]} hoch</ObjectStatus> </>}{k[0]}</>;
}

/** Reiter „Übersicht“: Kennzahlen, Teams, Personen nach Team mit Detail und Rückfrage-Text */
export function ReiterUebersicht({ sicht, setFilter }: { sicht: Sicht; setFilter: (f: Partial<Filter>) => void }) {
  const { a, f, personen } = sicht;
  const s = summen(personen);
  const regelwerkAn = a.regeln.some((r) => r.kategorie === 'R' && r.aktiv);

  // Kachel „Fehlerhafte Rückmeldungen“: nur Eintragsfunde, ab Stufe, alle Kategorien
  const fehlerhaft = useMemo(() => zeilen(sicht.gruppen.filter((g) => g.eintrag !== null), ['K', 'P', 'T', 'R'], f.stufe), [sicht.gruppen, f.stufe]);
  const einzel = fehlerhaft.reduce((n, z) => n + z.funde.length, 0);
  const kGruppen = mitKategorie(sicht.gruppen, ['K']);
  const kHoch = kGruppen.filter((g) => g.funde.some((x) => x.kategorie === 'K' && x.stufe === 3)).length;
  const err = sicht.eintraege.filter(({ e }) => e.errorAccount);
  const ns = sicht.gruppen.filter((g) => g.funde.some((x) => x.kategorie === 'T' && x.art === 'ns')).length;
  const fr = sicht.gruppen.filter((g) => g.funde.some((x) => x.kategorie === 'T' && x.art === 'fr')).length;
  const tu = unauffaellig(s);

  const teams: TeamZeile[] = useMemo(() => {
    const m = new Map<string, PersonAuswertung[]>();
    for (const p of personen) m.set(p.team, [...(m.get(p.team) ?? []), p]);
    return [...m].map(([team, ps]) => ({ team, personen: ps.length, ...summen(ps) }));
  }, [personen]);

  const teamSpalten: Spalte<TeamZeile>[] = [
    { titel: 'Team', wert: (t) => t.team, sort: (t) => t.team, summe: () => 'Summe' },
    { titel: 'Pers.', rechts: true, wert: (t) => t.personen, sort: (t) => t.personen, summe: summe((t) => t.personen) },
    { titel: 'Vollständig', rechts: true, wert: (t) => `${t.ok}/${t.n}`, sort: (t) => (t.n ? t.ok / t.n : 1), summe: (z) => `${z.reduce((x, t) => x + t.ok, 0)}/${z.reduce((x, t) => x + t.n, 0)}` },
    { titel: 'Soll', rechts: true, wert: (t) => zahl(t.soll), sort: (t) => t.soll, summe: summe((t) => t.soll) },
    { titel: 'Ist', rechts: true, wert: (t) => zahl(t.ist), sort: (t) => t.ist, summe: summe((t) => t.ist) },
    { titel: 'Offen', rechts: true, wert: (t) => offenStatus(t.offen, t.ok === t.n), sort: (t) => t.offen, summe: summe((t) => t.offen) },
    { titel: 'Billable', rechts: true, wert: (t) => zahl(t.B), sort: (t) => t.B, summe: summe((t) => t.B) },
    { titel: 'PreSales', rechts: true, wert: (t) => zahl(t.P), sort: (t) => t.P, summe: summe((t) => t.P) },
    { titel: 'Intern', rechts: true, wert: (t) => zahl(t.I), sort: (t) => t.I, summe: summe((t) => t.I) },
    { titel: 'Abw.', rechts: true, wert: (t) => zahl(t.A), sort: (t) => t.A, summe: summe((t) => t.A) },
    { titel: 'Quote', rechts: true, tooltip: 'Billable-Quote B / (B + P + I)', wert: (t) => proz(quote(t.B, t.P + t.I)), sort: (t) => quote(t.B, t.P + t.I) ?? -1 },
    { titel: 'Verteilung', wert: (t) => <Verteilung {...t} /> },
    { titel: 'Kontierung', rechts: true, wert: (t) => zaehler([t.k, 0, 0, t.kHoch]), sort: (t) => t.kHoch * 1000 + t.k },
    { titel: 'Texte ok', rechts: true, wert: (t) => proz(unauffaellig(t)), sort: (t) => unauffaellig(t) ?? 2 },
  ];

  const personSpalten: Spalte<PersonAuswertung>[] = [
    {
      titel: 'Person', sort: (p) => p.person, wert: (p) => (
        <span className="portal-wca-person">
          {p.person}
          {p.bis && <Pill state="Information">bis {dat(p.bis).slice(0, 6)}</Pill>}
          {p.teams.length > 1 && <Pill state="Information">Teamwechsel</Pill>}
          {!p.aktiv && <Pill>ohne Soll</Pill>}
        </span>
      ),
    },
    { titel: 'Std.', wert: (p) => p.standort, sort: (p) => p.standort, tooltip: 'Standort' },
    { titel: 'Soll', rechts: true, wert: (p) => zahl(p.soll), sort: (p) => p.soll },
    { titel: 'Ist', rechts: true, wert: (p) => zahl(p.ist), sort: (p) => p.ist },
    { titel: 'Offen', rechts: true, wert: (p) => offenStatus(p.offen, p.vollstaendig), sort: (p) => p.offen },
    { titel: 'Fehltage', rechts: true, wert: (p) => p.fehltage || '', sort: (p) => p.fehltage },
    { titel: 'Billable', rechts: true, wert: (p) => zahl(p.B), sort: (p) => p.B },
    { titel: 'PreSales', rechts: true, wert: (p) => zahl(p.P), sort: (p) => p.P },
    { titel: 'Intern', rechts: true, wert: (p) => zahl(p.I), sort: (p) => p.I },
    { titel: 'Abw.', rechts: true, wert: (p) => zahl(p.A), sort: (p) => p.A },
    { titel: 'Quote', rechts: true, wert: (p) => proz(p.billableQuote), sort: (p) => p.billableQuote ?? -1, tooltip: 'Billable-Quote B / (B + P + I)' },
    { titel: 'Verteilung', wert: (p) => <Verteilung {...p} /> },
    { titel: 'Kontierung', rechts: true, wert: (p) => zaehler(p.kontierung), sort: (p) => p.kontierung[3] * 1000 + p.kontierung[0] },
    { titel: 'Texte ok', rechts: true, wert: (p) => proz(p.texteUnauffaellig), sort: (p) => p.texteUnauffaellig ?? 2 },
    { titel: 'Regelwerk', rechts: true, wert: (p) => p.regelwerk[0] || '', sort: (p) => p.regelwerk[0] },
  ];

  return (
    <>
      <Kacheln>
        <Kachel titel="Vollständig gebucht" wert={`${s.ok} / ${s.n}`} state={s.ok === s.n ? 'Positive' : 'Critical'}
                text={`${zahl(s.offen)} h offen an ${s.fehltage} Personentagen · Soll ${zahl(s.soll)} h, Ist ${zahl(s.ist)} h`} />
        <Kachel titel="Billable-Stunden" wert={std(s.B)}
                text={`Quote ${proz(quote(s.B, s.P + s.I))} · PreSales ${zahl(s.P)} h · Intern ${zahl(s.I)} h · Abwesenheit ${zahl(s.A)} h`}>
          <Verteilung {...s} />
          <VerteilungLegende />
        </Kachel>
        <Kachel titel={`Fehlerhafte Rückmeldungen ab ${stufeText(f.stufe)}`} wert={`${fehlerhaft.length} / ${s.ent}`} state={fehlerhaft.length ? 'Critical' : 'Positive'}
                text={`zusammen ${einzel} Einzelfehler`} />
        <Kachel titel="Rückmeldungen mit Kontierungsfehler" wert={`${kHoch} hoch · ${kGruppen.length} gesamt`} state={kHoch ? 'Negative' : kGruppen.length ? 'Critical' : 'Positive'}
                text={err.length ? `${err.length} Einträge auf Error-Accounts (${zahl(err.reduce((x, { e }) => x + e.stunden, 0))} h)` : 'Keine Error-Accounts im Zeitraum'} />
        <Kachel titel="Texte unauffällig" wert={proz(tu)} state={tu === null || tu >= 0.9 ? 'Positive' : 'Critical'}
                text={`${ns} nichtssagend · ${fr} fragwürdig · ${s.ent} Einträge`} />
        {regelwerkAn && (
          <Kachel titel="Regelwerk-Verstöße" wert={String(s.r)} state={s.r ? 'Critical' : 'Positive'} text="Einträge mit Verstoß gegen das Rückmelde-Regelwerk" />
        )}
      </Kacheln>

      <Section title="Teams" count={teams.length} flush>
        <Tabelle<TeamZeile> spalten={teamSpalten} zeilen={teams} schluessel={(t) => t.team} leer="Keine Personen im Filter"
                            onZeile={(t) => setFilter({ team: f.team === t.team ? '' : t.team })} />
      </Section>

      <Section title="Personen nach Team" count={personen.length} flush>
        <Tabelle<PersonAuswertung> spalten={personSpalten} zeilen={personen} schluessel={(p) => p.person} gruppe={(p) => p.team}
                                   aufgeklappt={f.person ? [f.person] : undefined}
                                   gruppenKopf={(team, ps) => {
                                     const t = summen(ps);
                                     return <><b>{team}</b> <span className="portal-muted">· {t.ok} von {t.n} vollständig · {zahl(t.offen)} h offen</span></>;
                                   }}
                                   detail={(p) => <PersonDetail sicht={sicht} p={p} />} leer="Keine Personen im Filter" />
      </Section>
    </>
  );
}

/** Detail einer Person: Stammdaten, offene Tage, Funde, Rückfrage-Text */
export function PersonDetail({ sicht, p }: { sicht: Sicht; p: PersonAuswertung }) {
  const { f } = sicht;
  const eigene = sicht.gruppen.filter((g) => g.person === p.person);
  const offen = p.tageStatus.filter((t) => t.offen > 0 && (t.status === 'fehlt' || t.status === 'teilweise'));
  const kp = zeilen(eigene, ['K', 'P'], f.stufe).slice(0, 30);
  const tr = zeilen(eigene, ['T', 'R'], f.stufe).slice(0, 30);
  return (
    <div className="portal-wca-detailinhalt">
      {!p.aktiv && <MessageStrip hideCloseButton>Ohne Buchung und ohne Soll im Zeitraum.</MessageStrip>}
      <Attributes>
        <Attribute label="Team">{p.teams.join(', ')}</Attribute>
        <Attribute label="Standort">{p.standort}{p.standort !== p.standortAbgeleitet ? ` (abgeleitet ${p.standortAbgeleitet})` : ' (abgeleitet)'}</Attribute>
        <Attribute label="Soll je Tag">{std(p.sollTag)}</Attribute>
        <Attribute label="Arbeitstage">{arbeitstageText(p.arbeitstage)}</Attribute>
        <Attribute label="Im Team">{dat(p.von)} – {p.bis ? dat(p.bis) : 'offen'}</Attribute>
        <Attribute label="Letzte Buchung">{p.letzteBuchung ? wtm(p.letzteBuchung) : null}</Attribute>
        <Attribute label="Billable-Quote">{proz(p.billableQuote)}</Attribute>
      </Attributes>
      <div>
        <b>Offene Tage ({offen.length})</b>
        {offen.length ? (
          <div className="portal-wca-tagliste">
            {offen.slice(0, 40).map((t) => <span key={t.tag}>{wtm(t.tag)}: {zahl(t.offen)} h</span>)}
            {offen.length > 40 && <span className="portal-muted">… und {offen.length - 40} weitere</span>}
          </div>
        ) : <div className="portal-muted">keine</div>}
      </div>
      <Drilldown sicht={sicht} p={p} />
      <FundKurz titel="Kontierung und Plausibilität" liste={kp} sicht={sicht} />
      <FundKurz titel="Texte und Regelwerk" liste={tr} sicht={sicht} />
      <div>
        <div className="portal-row" style={{ justifyContent: 'space-between' }}>
          <b>Rückfrage-Text</b>
          <Button icon="copy" onClick={() => kopieren(p.rueckfrage, 'Rückfrage-Text kopiert')}>Kopieren</Button>
        </div>
        <TextArea readonly rows={Math.min(18, p.rueckfrage.split('\n').length + 1)} value={p.rueckfrage} style={{ width: '100%' }} />
      </div>
    </div>
  );
}

function FundKurz({ titel, liste, sicht }: { titel: string; liste: Zeile[]; sicht: Sicht }) {
  const { a, f } = sicht;
  return (
    <div>
      <b>{titel} ab {stufeText(f.stufe)} ({liste.length})</b>
      {liste.length ? (
        <ul className="portal-wca-fundkurz">
          {liste.map((z) => {
            const e = z.eintrag === null ? null : a.eintraege[z.eintrag];
            return (
              <li key={z.id}>
                <StufeStatus stufe={z.stufe} /> {tageText(tageVon(a, z))} · {zahl(z.stunden)} h{e ? ` · ${e.accName}${e.key ? ` (${e.key})` : ''}` : ''}
                {e?.text ? <> · „{e.text}“</> : null}
                {z.funde.map((x, i) => <div key={i} className="portal-muted portal-small">→ {x.regel}: {x.meldung} <FreigabeKnopf sicht={sicht} e={e} x={x} /></div>)}
              </li>
            );
          })}
        </ul>
      ) : <div className="portal-muted">keine</div>}
    </div>
  );
}
