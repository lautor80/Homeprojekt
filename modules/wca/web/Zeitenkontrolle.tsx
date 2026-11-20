import { useMemo, useState, type ReactNode } from 'react';
import { BusyIndicator, DatePicker, Input, MessageStrip, Option, Select, Tab, TabContainer } from '@ui5/webcomponents-react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Filter as FilterFeld, Filters } from '@core/components/Filters';
import { ImportKnopf } from '@core/components/ImportDialog';
import { Empty, Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import type { Auswertung, Stufe } from '../server/typen';
import { FILTER_START, sichtBerechnen, zeilen, type Filter } from './ansicht';
import { Beschreibung } from './Beschreibung';
import { ReiterBillable } from './ReiterBillable';
import { ReiterKontierung } from './ReiterKontierung';
import { ReiterRegeln } from './ReiterRegeln';
import { ReiterTexte } from './ReiterTexte';
import { ReiterUebersicht } from './ReiterUebersicht';
import { ReiterVollstaendigkeit } from './ReiterVollstaendigkeit';
import { dat, STUFEN, W, wtm } from './util';
import { WcaImport } from './WcaImport';

/** Auswahlliste mit leerem Eintrag „Alle“ */
function Auswahl({ wert, optionen, onChange, alle = 'Alle', breite = '12rem' }: {
  wert: string; optionen: { key: string; text: string }[]; onChange: (v: string) => void; alle?: string | null; breite?: string;
}) {
  return (
    <Select style={{ width: breite, maxWidth: '100%' }} onChange={(e) => onChange((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
      {alle !== null && <Option data-k="" selected={!wert}>{alle}</Option>}
      {optionen.map((o) => <Option key={o.key} data-k={o.key} selected={o.key === wert}>{o.text}</Option>)}
    </Select>
  );
}

const REITER = ['uebersicht', 'vollstaendigkeit', 'billable', 'kontierung', 'texte', 'regeln', 'beschreibung'] as const;
type Reiter = typeof REITER[number];

/**
 * WCA Zeitenkontrolle: importierte Tempo-Zeitexporte eines Teams prüfen – Vollständigkeit, Billable, Kontierung, Texte.
 * Zeitraum und Stichtag rechnet der Server; Team, Standort, Stufe, Person und Suche filtern hier.
 */
export function Zeitenkontrolle() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tab: Reiter = (REITER as readonly string[]).includes(params.get('tab') ?? '') ? params.get('tab') as Reiter : 'uebersicht';
  const [zeitraum, setZeitraum] = useState('');
  const [stichtag, setStichtag] = useState('');
  const [filter, setFilterRoh] = useState<Filter>(FILTER_START);
  const setFilter = (f: Partial<Filter>) => setFilterRoh((alt) => ({ ...alt, ...f }));
  const [imp, setImp] = useState(false);

  const d = useLoad(() => api.get<Auswertung>(`${W}/auswertung${qs({ stichtag, zeitraum })}`), [stichtag, zeitraum]);
  const a = d.data;
  const sicht = useMemo(() => (a ? sichtBerechnen(a, filter) : null), [a, filter]);
  const anzahlK = useMemo(() => (sicht ? zeilen(sicht.gruppen, ['K', 'P'], filter.stufe).length : 0), [sicht, filter.stufe]);
  const anzahlT = useMemo(() => (sicht ? zeilen(sicht.gruppen, ['T', 'R'], filter.stufe).length : 0), [sicht, filter.stufe]);

  const leer = !!a && !a.stand.dateien;
  const untertitel = a && !leer
    ? `${a.stand.dateien} ${a.stand.dateien === 1 ? 'Datei' : 'Dateien'} · ${dat(a.stand.minTag)}–${dat(a.stand.maxTag)} · ${sicht?.teams.length ?? 0} Teams · ${sicht?.alleSichtbar.length ?? 0} Personen · Stichtag ${wtm(a.stichtag)}`
    : 'Tempo-Zeitexporte prüfen';

  const kopf = a && sicht && !leer ? (
    <Filters>
      <FilterFeld label="Zeitraum">
        <Auswahl alle={null} breite="15rem" wert={a.zeitraum.id} optionen={a.zeitraeume.map((z) => ({ key: z.id, text: z.text }))} onChange={setZeitraum} />
      </FilterFeld>
      <FilterFeld label="Stichtag">
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={a.stichtag} style={{ width: '10rem' }}
                    minDate={a.stand.minTag ?? undefined} maxDate={a.stand.maxTag ?? undefined}
                    onChange={(e) => { if (e.detail.valid !== false && e.detail.value) setStichtag(e.detail.value); }} />
      </FilterFeld>
      <FilterFeld label="Team">
        <Auswahl wert={filter.team} optionen={sicht.teams.map((t) => ({ key: t, text: t }))} onChange={(team) => setFilter({ team, person: '' })} />
      </FilterFeld>
      <FilterFeld label="Standort">
        <Auswahl breite="7rem" wert={filter.standort} optionen={sicht.standorte.map((s) => ({ key: s, text: s }))} onChange={(standort) => setFilter({ standort })} />
      </FilterFeld>
      <FilterFeld label="Stufe ab">
        <Auswahl alle={null} breite="8rem" wert={String(filter.stufe)} optionen={STUFEN.map((s) => ({ key: String(s.key), text: s.text }))}
                 onChange={(v) => setFilter({ stufe: Number(v) as Stufe })} />
      </FilterFeld>
      <FilterFeld label="Person">
        <Auswahl breite="15rem" wert={filter.person}
                 optionen={[...sicht.alleSichtbar].filter((p) => !filter.team || p.team === filter.team)
                   .sort((x, y) => x.team.localeCompare(y.team, 'de') || x.person.localeCompare(y.person, 'de'))
                   .map((p) => ({ key: p.person, text: filter.team ? p.person : `${p.person} (${p.team})` }))}
                 onChange={(person) => setFilter({ person })} />
      </FilterFeld>
      <FilterFeld label="Suche">
        <Input placeholder="Name …" value={filter.suche} showClearIcon style={{ width: '10rem' }} onInput={(e) => setFilter({ suche: e.target.value })} />
      </FilterFeld>
    </Filters>
  ) : undefined;

  const reiter = (key: Reiter, text: string, inhalt: () => ReactNode) => (
    <Tab key={key} text={text} data-key={key} selected={tab === key}>{tab === key && sicht ? inhalt() : null}</Tab>
  );

  return (
    <AppPage title="Zeitenkontrolle" subtitle={untertitel} header={kopf}
             actions={can('wca.import:edit') ? <ImportKnopf tooltip="Tempo-Teamreports (CSV) importieren" onClick={() => setImp(true)} /> : undefined}>
      {d.error && <MessageStrip design="Negative" hideCloseButton>{d.error}</MessageStrip>}
      {!a && d.loading && <BusyIndicator active style={{ width: '100%', padding: '2rem' }} />}
      {leer && (
        <Section>
          <Empty>Noch keine Zeitexporte importiert.{can('wca.import:edit') ? ' Über „Importieren“ die Teamreports aus Tempo (CSV) einlesen.' : ''}</Empty>
        </Section>
      )}
      {sicht && !leer && (
        <BusyIndicator active={d.loading} delay={300} style={{ width: '100%', display: 'block' }}>
          <TabContainer onTabSelect={(e) => setParams({ tab: (e.detail.tab as HTMLElement).dataset.key ?? 'uebersicht' }, { replace: true })}>
            {reiter('uebersicht', 'Übersicht', () => <ReiterUebersicht sicht={sicht} setFilter={setFilter} />)}
            {reiter('vollstaendigkeit', 'Vollständigkeit', () => <ReiterVollstaendigkeit sicht={sicht} />)}
            {reiter('billable', 'Billable', () => <ReiterBillable sicht={sicht} />)}
            {reiter('kontierung', `Kontierung (${anzahlK})`, () => <ReiterKontierung sicht={sicht} />)}
            {reiter('texte', `Texte (${anzahlT})`, () => <ReiterTexte sicht={sicht} />)}
            {reiter('regeln', 'Regeln', () => <ReiterRegeln regeln={sicht.a.regeln} />)}
            {reiter('beschreibung', 'Beschreibung', () => <Beschreibung regeln={sicht.a.regeln} />)}
          </TabContainer>
        </BusyIndicator>
      )}
      {imp && <WcaImport onClose={() => setImp(false)} onUebernommen={() => d.reload()} />}
    </AppPage>
  );
}
