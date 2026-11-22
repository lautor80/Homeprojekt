import { useMemo } from 'react';
import { Button, ObjectStatus } from '@ui5/webcomponents-react';
import { Section } from '@core/components/Section';
import type { PersonAuswertung, TagStatus } from '../server/typen';
import { summen, type Sicht } from './ansicht';
import { arbeitstageText, dat, kopieren, type Spalte, summe, Tabelle, tm, tsv, wochentagNr, wt, wtm, zahl } from './util';

const STATUS: Record<TagStatus['status'], { text: string; state: 'None' | 'Positive' | 'Critical' | 'Negative' | 'Information' }> = {
  vollstaendig: { text: 'vollständig', state: 'Positive' },
  teilweise: { text: 'teilweise', state: 'Critical' },
  fehlt: { text: 'fehlt', state: 'Negative' },
  abwesend: { text: 'abwesend', state: 'Information' },
  feiertag: { text: 'Feiertag', state: 'None' },
  frei: { text: 'frei', state: 'None' },
  frei_gebucht: { text: 'frei, gebucht', state: 'Information' },
  ausserhalb: { text: 'außerhalb', state: 'None' },
  zukunft: { text: 'nach Stichtag', state: 'None' },
};
export const statusText = (s: TagStatus['status']) => STATUS[s].text;

/** Tage, die in Listen und Exporten erscheinen (Arbeitstage bis Stichtag, gebuchte freie Tage, Feiertage an Arbeitstagen) */
function gelistet(p: PersonAuswertung, t: TagStatus) {
  if (t.status === 'ausserhalb' || t.status === 'zukunft' || t.status === 'frei') return false;
  if (t.status === 'feiertag') return t.ist > 0 || p.arbeitstage.includes(wochentagNr(t.tag));
  return true;
}
const zaehle = (p: PersonAuswertung, s: TagStatus['status']) => p.tageStatus.filter((t) => t.status === s && gelistet(p, t)).length;

function zelle(t: TagStatus | undefined): { text: string; klasse: string } {
  if (!t) return { text: '', klasse: 'aus' };
  switch (t.status) {
    case 'ausserhalb': return { text: '', klasse: 'aus' };
    case 'zukunft': return { text: t.A > 0 ? 'A' : '', klasse: 'zukunft' };
    case 'feiertag': return { text: t.ist > 0 ? zahl(t.ist) : '', klasse: 'feiertag' };
    case 'frei': return { text: '', klasse: 'frei' };
    case 'frei_gebucht': return { text: zahl(t.ist), klasse: 'extra' };
    case 'abwesend': return { text: 'A', klasse: 'abwesend' };
    case 'vollstaendig': return { text: zahl(t.ist), klasse: 'ok' };
    case 'teilweise': return { text: zahl(t.ist), klasse: 'teil' };
    case 'fehlt': return { text: '–', klasse: 'fehlt' };
  }
}

function tageZwischen(von: string, bis: string): string[] {
  const out: string[] = [];
  const d = new Date(`${von}T12:00:00Z`);
  const ende = new Date(`${bis}T12:00:00Z`);
  while (d <= ende && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

/** Reiter „Vollständigkeit“: Tagesmatrix, Feiertage, Vollständigkeit je Person mit Tagesdetail, Exporte */
export function ReiterVollstaendigkeit({ sicht }: { sicht: Sicht }) {
  const { a, f, personen } = sicht;
  const tage = useMemo(() => tageZwischen(a.zeitraum.von, a.zeitraum.bis)
    .filter((t) => !a.zeitraum.teile || a.zeitraum.teile.some((z) => t >= z.von && t <= z.bis)), [a.zeitraum]);
  const feiertage = a.feiertage.filter((x) => sicht.standorte.includes(x.standort) || x.standort === '*');

  function exportieren(nurOffen: boolean) {
    const zeilen = personen.flatMap((p) => p.tageStatus
      .filter((t) => gelistet(p, t) && (!nurOffen || t.status === 'fehlt' || t.status === 'teilweise'))
      .map((t) => [p.team, p.person, dat(t.tag), wt(t.tag), statusText(t.status), t.soll, t.B, t.P, t.I, t.A, t.ist, t.offen, t.hinweis]));
    kopieren(tsv(['Team', 'Person', 'Tag', 'Wochentag', 'Status', 'Soll', 'Billable', 'PreSales', 'Intern', 'Abwesenheit', 'Gebucht', 'Offen', 'Hinweis'], zeilen),
      `${zeilen.length} Tage als Tabelle kopiert`);
  }

  const spalten: Spalte<PersonAuswertung>[] = [
    { titel: 'Person', wert: (p) => p.person, sort: (p) => p.person, summe: () => 'Summe' },
    { titel: 'Soll/Tag', rechts: true, wert: (p) => zahl(p.sollTag), sort: (p) => p.sollTag },
    { titel: 'Arbeitstage', fest: true, wert: (p) => arbeitstageText(p.arbeitstage) },
    { titel: 'Soll-Tage', rechts: true, wert: (p) => p.sollTage, sort: (p) => p.sollTage, summe: summe((p) => p.sollTage) },
    { titel: 'Vollständig', rechts: true, wert: (p) => zaehle(p, 'vollstaendig'), sort: (p) => zaehle(p, 'vollstaendig') },
    { titel: 'Teilweise', rechts: true, wert: (p) => zaehle(p, 'teilweise') || '', sort: (p) => zaehle(p, 'teilweise') },
    { titel: 'Fehlt', rechts: true, wert: (p) => zaehle(p, 'fehlt') || '', sort: (p) => zaehle(p, 'fehlt') },
    { titel: 'Abwesend', rechts: true, wert: (p) => zaehle(p, 'abwesend') || '', sort: (p) => zaehle(p, 'abwesend') },
    { titel: 'Feiertage', rechts: true, wert: (p) => zaehle(p, 'feiertag') || '', sort: (p) => zaehle(p, 'feiertag') },
    { titel: 'Soll', rechts: true, wert: (p) => zahl(p.soll), sort: (p) => p.soll, summe: summe((p) => p.soll) },
    { titel: 'Ist', rechts: true, wert: (p) => zahl(p.ist), sort: (p) => p.ist, summe: summe((p) => p.ist) },
    {
      titel: 'Offen', rechts: true, sort: (p) => p.offen, summe: summe((p) => p.offen),
      wert: (p) => <ObjectStatus state={p.vollstaendig ? 'Positive' : 'Critical'}>{p.vollstaendig ? 'ok' : zahl(p.offen)}</ObjectStatus>,
    },
    { titel: 'Letzte Buchung', fest: true, wert: (p) => wtm(p.letzteBuchung), sort: (p) => p.letzteBuchung ?? '' },
  ];

  return (
    <>
      <Section title="Tagesmatrix" count={personen.length} flush
               actions={<>
                 <Button icon="copy" onClick={() => exportieren(true)}>Fehl- und Teiltage kopieren</Button>
                 <Button icon="copy" onClick={() => exportieren(false)}>Alle Tage kopieren</Button>
               </>}>
        <div className="portal-wca-legende portal-small portal-muted" style={{ padding: '0.5rem 1rem' }}>
          <span><span className="portal-wca-punkt portal-wca-tag--ok" />vollständig</span>
          <span><span className="portal-wca-punkt portal-wca-tag--teil" />teilweise</span>
          <span><span className="portal-wca-punkt portal-wca-tag--fehlt" />fehlt (–)</span>
          <span><span className="portal-wca-punkt portal-wca-tag--abwesend" />abwesend (A)</span>
          <span><span className="portal-wca-punkt portal-wca-tag--feiertag" />Feiertag / frei</span>
          <span><span className="portal-wca-punkt portal-wca-tag--extra" />an freiem Tag gebucht</span>
        </div>
        {personen.length ? <Matrix personen={personen} tage={tage} /> : <div className="portal-empty">Keine Personen im Filter</div>}
      </Section>

      <Section title="Feiertage im Zeitraum" count={feiertage.length}>
        {feiertage.length ? (
          <div className="portal-wca-tagliste">
            {feiertage.map((x) => <span key={`${x.standort}${x.tag}`}><b>{x.standort}</b> {wtm(x.tag)} {x.name}{x.quelle !== 'berechnet' ? ` (${x.quelle})` : ''}</span>)}
          </div>
        ) : <div className="portal-muted">Keine Feiertage im Zeitraum.</div>}
      </Section>

      <Section title="Vollständigkeit je Person" count={personen.length} flush>
        <Tabelle<PersonAuswertung> spalten={spalten} zeilen={personen} schluessel={(p) => p.person} gruppe={(p) => p.team}
                                   aufgeklappt={f.person ? [f.person] : undefined} leer="Keine Personen im Filter"
                                   gruppenKopf={(team, ps) => {
                                     const s = summen(ps);
                                     return <><b>{team}</b> <span className="portal-muted">· {s.ok} von {s.n} vollständig · {zahl(s.offen)} h offen</span></>;
                                   }}
                                   detail={(p) => <TageTabelle p={p} />} />
      </Section>
    </>
  );
}

function Matrix({ personen, tage }: { personen: PersonAuswertung[]; tage: string[] }) {
  let team = '';
  return (
    <div className="portal-tabrahmen">
      <table className="portal-wca-matrix">
        <thead>
          <tr>
            <th className="portal-wca-matrix__name">Person</th>
            {tage.map((t) => <th key={t} className={wochentagNr(t) >= 5 ? 'portal-wca-matrix__we' : undefined}>{tm(t).slice(0, 2)}<br />{wt(t)}</th>)}
            <th className="portal-wca-rechts">Offen</th>
          </tr>
        </thead>
        <tbody>
          {personen.flatMap((p) => {
            const m = new Map(p.tageStatus.map((t) => [t.tag, t]));
            const zeilen = [];
            if (p.team !== team) {
              team = p.team;
              zeilen.push(<tr key={`g:${team}`} className="portal-wca-gruppe"><td className="portal-wca-matrix__name"><b>{team}</b></td><td colSpan={tage.length + 1} /></tr>);
            }
            zeilen.push(
              <tr key={p.person}>
                <td className="portal-wca-matrix__name">{p.person}</td>
                {tage.map((t) => {
                  const st = m.get(t);
                  const z = zelle(st);
                  return (
                    <td key={t} className={`portal-wca-tag--${z.klasse}`}
                        title={st ? `${wtm(t)}: ${statusText(st.status)} · gebucht ${zahl(st.ist)} h${st.soll ? ` · Soll ${zahl(st.soll)} h` : ''}${st.hinweis ? ` · ${st.hinweis}` : ''}` : undefined}>
                      {z.text}
                    </td>
                  );
                })}
                <td className="portal-wca-rechts portal-nowrap">{p.vollstaendig ? '' : zahl(p.offen)}</td>
              </tr>,
            );
            return zeilen;
          })}
        </tbody>
      </table>
    </div>
  );
}

function TageTabelle({ p }: { p: PersonAuswertung }) {
  const tage = p.tageStatus.filter((t) => gelistet(p, t));
  const sp: Spalte<TagStatus>[] = [
    { titel: 'Tag', fest: true, wert: (t) => wtm(t.tag), summe: () => 'Summe' },
    { titel: 'Status', wert: (t) => <ObjectStatus state={STATUS[t.status].state}>{statusText(t.status)}</ObjectStatus> },
    { titel: 'Soll', rechts: true, wert: (t) => zahl(t.soll), summe: summe((t) => t.soll) },
    { titel: 'Billable', rechts: true, wert: (t) => zahl(t.B), summe: summe((t) => t.B) },
    { titel: 'PreSales', rechts: true, wert: (t) => zahl(t.P), summe: summe((t) => t.P) },
    { titel: 'Intern', rechts: true, wert: (t) => zahl(t.I), summe: summe((t) => t.I) },
    { titel: 'Abwesenheit', rechts: true, wert: (t) => zahl(t.A), summe: summe((t) => t.A) },
    { titel: 'Gebucht', rechts: true, wert: (t) => zahl(t.ist), summe: summe((t) => t.ist) },
    { titel: 'Offen', rechts: true, wert: (t) => (t.offen ? zahl(t.offen) : ''), summe: summe((t) => t.offen) },
    { titel: 'Hinweis', wert: (t) => t.hinweis },
  ];
  return <Tabelle<TagStatus> spalten={sp} zeilen={tage} schluessel={(t) => t.tag} klein leer="Keine Tage im Zeitraum" />;
}
