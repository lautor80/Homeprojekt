import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, BusyIndicator, Button, Input, Link, MessageStrip, Option, Select, Switch, Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Filter, Filters } from '@core/components/Filters';
import { download } from '@core/components/PdfDialog';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { eur } from '../util';
import { Balken, EinAustritte, Saeulen } from './Diagramme';
import { FilterDialog, SpaltenDialog, VariantenDialog } from './Dialoge';
import { AN, sichtStandard, type Ergebnis, type Init, type Sicht, type Variante, type Zeile } from './typen';

/**
 * Mitglieder-Analyse (Port von Z2UI5_CL_TCO_MITGL_ANALYTIC): Grid-Tabelle mit serverseitiger
 * Gruppierung, Zwischensummen und Gesamtsumme, Filter-/Spalten-/Variantendialog, Kennzahlen,
 * Diagramme (Altersstruktur, Ein-/Austritte, Vertragsarten, Geschlecht, Orte) und CSV-Export.
 */
export function Analyse() {
  const navigate = useNavigate();
  const [init, setInit] = useState<Init | null>(null);
  const [sicht, setSicht] = useState<Sicht | null>(null);
  const [suche, setSuche] = useState('');
  const [variante, setVariante] = useState<Variante | null>(null);
  const [erg, setErg] = useState<Ergebnis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'filter' | 'spalten' | 'varianten' | null>(null);
  const [tab, setTab] = useState('tabelle');

  useEffect(() => {
    api.get<Init>(`${AN}/init`).then((i) => { setInit(i); setSicht(i.sicht); setSuche(i.sicht.search); setVariante(i.variante); }).catch((e) => setError(e.message));
  }, []);

  // Auswertung bei jeder Änderung der Sicht neu vom Server holen
  useEffect(() => {
    if (!sicht) return;
    let aktiv = true;
    setBusy(true);
    api.post<Ergebnis>(`${AN}/daten`, sicht).then((r) => aktiv && setErg(r)).catch((e) => aktiv && setError(e.message)).finally(() => aktiv && setBusy(false));
    return () => { aktiv = false; };
  }, [sicht]);

  const aendern = (p: Partial<Sicht>) => setSicht((s) => (s ? { ...s, ...p } : s));
  const suchen = () => aendern({ search: suche.trim() });
  const zuruecksetzen = () => { if (!init) return; setSuche(''); setVariante(null); setSicht(sichtStandard(init.spalten)); };

  const columns = useMemo<AnalyticalTableColumnDefinition[]>(() => {
    if (!init || !sicht) return [];
    return init.spalten.filter((s) => sicht.cols.includes(s.field)).map((s) => ({
      Header: s.label, accessor: s.field, width: s.width, hAlign: s.halign,
      Cell: ({ row, value }: Cell) => {
        const z = row.original as Zeile;
        if (z.rowtype === 'G' || z.rowtype === 'T') return <Text style={{ fontWeight: 'bold' }}>{value}</Text>;
        if (s.field === 'nachname' && z.adrnr && value) return <Link onClick={() => navigate(`/tco/mitglieder?adrnr=${encodeURIComponent(z.adrnr)}`)}>{value}</Link>;
        return <Text>{value}</Text>;
      },
    }));
  }, [init, sicht?.cols]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = erg?.rows ?? [];
  const kpi = erg?.kpi;
  const header = init && sicht ? (
    <Filters>
      <Filter label="Suche" width="16rem">
        <Input style={{ width: '100%' }} placeholder="Name, Ort oder Mitgliedsnummer" value={suche} showClearIcon
               onInput={(e) => { setSuche(e.target.value); if (!e.target.value) aendern({ search: '' }); }}
               onChange={suchen} />
      </Filter>
      <Filter label="Gruppierung" width="13rem">
        <Select style={{ width: '100%' }} onChange={(e) => aendern({ group_by: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
          {init.gruppen.map(([k, t]) => <Option key={k} data-k={k} selected={k === sicht.group_by}>{t}</Option>)}
        </Select>
      </Filter>
      <Filter label="Details">
        <Switch checked={sicht.details} onChange={(e) => aendern({ details: e.target.checked })} />
      </Filter>
      <Filter label="Variante">
        <Text style={{ lineHeight: '2.25rem' }}>{variante ? variante.name : '–'}</Text>
      </Filter>
    </Filters>
  ) : undefined;

  return (
    <AppPage title={erg?.titel ?? 'Mitglieder-Analyse'} subtitle="Auswertung über Mitglieder und Verträge: Gruppierung, Filter, Kennzahlen, Diagramme"
             header={header}
             actions={init && sicht ? <>
               <Button icon="filter" onClick={() => setDialog('filter')}>{erg?.filterCount ? `Filter (${erg.filterCount})` : 'Filter'}</Button>
               <Button icon="table-column" onClick={() => setDialog('spalten')}>Spalten</Button>
               <Button icon="save" onClick={() => setDialog('varianten')}>{variante ? `Variante: ${variante.name}` : 'Varianten'}</Button>
               <Button icon="excel-attachment" disabled={!erg} onClick={() => download(`${AN}/export?s=${encodeURIComponent(JSON.stringify(sicht))}`, `Mitglieder-Analyse_${new Date().toISOString().slice(0, 10)}.csv`).catch((e) => setError(e.message))}>CSV</Button>
               <Button icon="clear-filter" design="Transparent" onClick={zuruecksetzen}>Zurücksetzen</Button>
             </> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {!init && !error && <BusyIndicator active style={{ display: 'block', margin: '2rem auto' }} />}
      {kpi && (
        <div className="portal-section" style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem 2.5rem', padding: '0.75rem 1rem' }}>
          <Kennzahl label="Mitglieder" value={kpi.mitglieder.toLocaleString('de-DE')} />
          <Kennzahl label="davon aktiv" value={kpi.aktiv.toLocaleString('de-DE')} state="Positive" />
          <Kennzahl label="Durchschnittsalter" value={kpi.alter === null ? '–' : `${kpi.alter} Jahre`} />
          <Kennzahl label="Mitglied im Schnitt" value={kpi.jahre === null ? '–' : `${kpi.jahre} Jahre`} />
          <Kennzahl label={`Beitragsvolumen aus ${kpi.vertraege.toLocaleString('de-DE')} Verträgen`} value={eur(kpi.betrag)} />
        </div>
      )}
      {init && sicht && (
        <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
          <Tab data-key="tabelle" text="Trefferliste" icon="table-view" selected={tab === 'tabelle'}>
            <Section title="Mitglieder und Verträge" count={rows.length ? rows.length - 1 : 0} flush
                     status={sicht.group_by ? <Text className="portal-muted">gruppiert nach {init.gruppen.find((g) => g[0] === sicht.group_by)?.[1]}</Text> : undefined}>
              <AnalyticalTable columns={columns} data={rows} loading={busy} sortable={false}
                               visibleRows={Math.min(Math.max(rows.length, 3), 25)} noDataText="Keine Mitglieder zu dieser Auswahl"
                               withRowHighlight highlightField={(r: Record<string, any>) => r.highlight} />
            </Section>
            <MessageStrip hideCloseButton>
              Eine Zeile je Mitglied und sichtbarem Vertrag; Folgeverträge desselben Mitglieds stehen ohne Stammdaten darunter.
              Gruppenköpfe und die Gesamtsumme zählen jedes Mitglied nur einmal. Orange markiert: ausgetretene Mitglieder.
            </MessageStrip>
          </Tab>
          <Tab data-key="diagramme" text="Diagramme" icon="bar-chart" selected={tab === 'diagramme'}>
            {erg && <Diagramme erg={erg} />}
          </Tab>
        </TabContainer>
      )}
      {dialog === 'filter' && init && sicht && <FilterDialog init={init} filter={sicht.filter} onClose={(f) => { setDialog(null); if (f) aendern({ filter: f }); }} />}
      {dialog === 'spalten' && init && sicht && <SpaltenDialog spalten={init.spalten} cols={sicht.cols} onClose={(c) => { setDialog(null); if (c) aendern({ cols: c }); }} />}
      {dialog === 'varianten' && init && sicht && (
        <VariantenDialog varianten={init.varianten} aktuell={variante} sicht={{ ...sicht, search: suche.trim() }} onClose={(r) => {
          setDialog(null);
          if (!r) return;
          setInit({ ...init, varianten: r.varianten });
          if (r.geladen) { setVariante(r.geladen.variante); setSuche(r.geladen.sicht.search); setSicht(r.geladen.sicht); }
          else if (r.variante !== undefined) setVariante(r.variante);
          if (r.text) toast(r.text);
        }} />
      )}
    </AppPage>
  );
}

function Kennzahl({ label, value, state = 'None' }: { label: string; value: string; state?: 'None' | 'Positive' | 'Critical' | 'Negative' }) {
  return (
    <div>
      <div className="portal-filter__label">{label}</div>
      <div className={`portal-kpi__value portal-kpi__value--${state}`}>{value}</div>
    </div>
  );
}

function Diagramme({ erg }: { erg: Ergebnis }) {
  const d = erg.diagramme;
  const n = erg.kpi.mitglieder;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(28rem, 1fr))', gap: 'var(--portal-gap, 1rem)' }}>
      <Section title="Altersstruktur" count={n}>
        <Saeulen punkte={d.alter} />
      </Section>
      <Section title="Geschlecht" count={n}>
        <Saeulen punkte={d.geschlecht} hoehe={260} />
      </Section>
      <Section title="Eintritte und Austritte je Jahr" status={<Text className="portal-muted">letzte {d.jahre.length} Jahre mit Bewegung</Text>}>
        {d.jahre.length ? <EinAustritte punkte={d.jahre} /> : <Text>Keine Daten</Text>}
      </Section>
      <Section title="Beitragsarten (sichtbare Verträge)" count={erg.kpi.vertraege}>
        {d.vertragsarten.length ? <Balken punkte={d.vertragsarten.map((v) => ({ label: v.label, wert: v.anzahl, zusatz: `· ${eur(v.betrag)}` }))} /> : <Text>Keine Verträge in der Auswahl</Text>}
      </Section>
      <Section title="Orte" status={<Text className="portal-muted">die zehn häufigsten</Text>}>
        {d.orte.length ? <Balken punkte={d.orte} /> : <Text>Keine Daten</Text>}
      </Section>
    </div>
  );
}
