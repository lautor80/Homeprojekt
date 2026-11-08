import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, BusyIndicator, Button, Label, MessageStrip, ObjectStatus, Option, Select, Switch, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { Section } from '@core/components/Section';
import { TCO, betrag as betragFmt, eur } from '../util';
import { BalkenDiagramm, type Punkt } from './Diagramm';

const FC = `${TCO}/forecast`;

type State = 'Negative' | 'Positive' | 'None';
interface Monat { monat: number; mtext: string; wert0: number; wert1: number; wert2: number; delta: number; state: State }
interface Knoten {
  key: string; ebene: 1 | 2 | 3; kategorie: string; text: string; anzahl: number; wert0: number; wert1: number; wert2: number; delta: number;
  state: State; preis: number | null; peinh: string;
}
interface Daten {
  jahr: number; jahr0: number; jahr2: number; jahre: number[]; info: string | null;
  summen: { sum1: number; sum2: number; delta: number; state: 'Negative' | 'Positive' };
  monate: Monat[]; chart: Punkt[]; knoten: Knoten[]; mitglieder: boolean;
}

const delta = (v: number, s: State) => <ObjectStatus state={s}>{eur(v)}</ObjectStatus>;

/**
 * Beitragsforecast – Port von Z2UI5_CL_TCO_BEITRAGSFORECAST.
 * Hochrechnung der Beitragseinnahmen des Basisjahres und des Folgejahres aus den laufenden Verträgen
 * (Turnus, Austritte, Beitragsänderungen im Beitragsstamm), Vorjahr als Vergleich; Diagramm, Monats- und Vertragsartensicht.
 */
export function Forecast() {
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const [mitglieder, setMitglieder] = useState(false);
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const laden = () => {
    setBusy(true);
    setError(null);
    return api.get<Daten>(`${FC}?jahr=${jahr}&mitglieder=${mitglieder ? 1 : 0}`).then(setD).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => { laden(); }, [jahr, mitglieder]); // eslint-disable-line react-hooks/exhaustive-deps

  const j0 = d?.jahr0 ?? jahr - 1, j1 = d?.jahr ?? jahr, j2 = d?.jahr2 ?? jahr + 1;

  const monatCols: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Monat', accessor: 'mtext', minWidth: 120 },
    { Header: String(j0), accessor: 'wert0', width: 130, hAlign: 'End', Cell: ({ value }: Cell) => <Text className="portal-muted">{betragFmt(value)}</Text> },
    { Header: String(j1), accessor: 'wert1', width: 130, hAlign: 'End', Cell: ({ value }: Cell) => betragFmt(value) },
    { Header: `${j2} (Forecast)`, accessor: 'wert2', width: 140, hAlign: 'End', Cell: ({ value }: Cell) => <Text style={{ fontWeight: 'bold' }}>{betragFmt(value)}</Text> },
    { Header: 'Veränderung', accessor: 'delta', width: 140, hAlign: 'End', Cell: ({ row }: Cell) => delta(row.original.delta, row.original.state) },
  ], [j0, j1, j2]);

  /** Baum Kategorie → Vertragsart → Mitglied als gruppierte Tabelle (Kategorie = Gruppe, Mitglieder eingerückt) */
  const knotenCols: AnalyticalTableColumnDefinition[] = useMemo(() => [
    {
      Header: 'Kategorie', accessor: 'kategorie', id: 'kategorie', width: 60, disableGroupBy: false,
      Cell: ({ value }: Cell) => <Text style={{ fontWeight: 'bold' }}>{value || 'Sonstige'}</Text>,
    },
    {
      Header: 'Vertragsart / Mitglied', accessor: 'text', minWidth: 220,
      Cell: ({ row }: Cell) => {
        const k = row.original as Knoten;
        return <Text style={{ paddingLeft: k.ebene === 3 ? '1.5rem' : 0, fontWeight: k.ebene === 2 && d?.mitglieder ? 'bold' : undefined }}>{k.ebene === 3 ? `· ${k.text}` : k.text}</Text>;
      },
    },
    { Header: 'Verträge', accessor: 'anzahl', width: 90, hAlign: 'End' },
    { Header: 'Beitragspreis', accessor: 'preis', width: 170, hAlign: 'End', Cell: ({ row }: Cell) => (row.original.preis === null ? '' : <Text>{betragFmt(row.original.preis)} <Label>{row.original.peinh}</Label></Text>) },
    { Header: String(j0), accessor: 'wert0', width: 130, hAlign: 'End', Cell: ({ value }: Cell) => <Text className="portal-muted">{betragFmt(value)}</Text> },
    { Header: String(j1), accessor: 'wert1', width: 130, hAlign: 'End', Cell: ({ value }: Cell) => betragFmt(value) },
    { Header: `${j2} (Forecast)`, accessor: 'wert2', width: 140, hAlign: 'End', Cell: ({ value }: Cell) => <Text style={{ fontWeight: 'bold' }}>{betragFmt(value)}</Text> },
    { Header: 'Veränderung', accessor: 'delta', width: 140, hAlign: 'End', Cell: ({ row }: Cell) => delta(row.original.delta, row.original.state) },
  ].map((c) => (c.id === 'kategorie' ? c : { ...c, Aggregated: () => null })) as AnalyticalTableColumnDefinition[], [j0, j1, j2, d?.mitglieder]);

  // Kategoriezeilen (Ebene 1) kommen als Gruppenkopf; ihre Summen stehen in der Zeile „Summe Kategorie“
  const knoten = useMemo(() => (d?.knoten ?? []).map((k) => (k.ebene === 1 ? { ...k, text: `Summe ${k.text}`, preis: null } : k))
    .sort((a, b) => a.kategorie.localeCompare(b.kategorie, 'de') || (a.ebene === 1 ? 1 : 0) - (b.ebene === 1 ? 1 : 0)), [d]);
  const kategorien = useMemo(() => [...new Set(knoten.map((k) => k.kategorie))], [knoten]);

  const header = (
    <Filters>
      <Filter label="Basisjahr" width="8rem">
        <Select style={{ width: '100%' }} onChange={(e) => setJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
          {(d?.jahre ?? [jahr]).map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
        </Select>
      </Filter>
      <Filter label="Mitglieder anzeigen">
        <Switch checked={mitglieder} onChange={(e) => setMitglieder(e.target.checked)} />
      </Filter>
      <HeaderKpi label={`Beiträge ${j1}`} value={eur(d?.summen.sum1)} />
      <HeaderKpi label={`Forecast ${j2}`} value={eur(d?.summen.sum2)} />
      <HeaderKpi label="Veränderung" value={eur(d?.summen.delta)} state={d ? d.summen.state : 'None'} />
    </Filters>
  );

  return (
    <AppPage title={`Beitragsforecast ${j1} / ${j2}`} subtitle="Hochrechnung der Beitragseinnahmen aus den laufenden Verträgen" header={header}
             actions={<Button icon="refresh" tooltip="Neu berechnen" disabled={busy} onClick={laden}>Neu berechnen</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {d?.info && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>{d.info}</MessageStrip>}
      {!d && !error && <BusyIndicator active style={{ display: 'block', padding: '2rem' }} />}
      {d && (
        <>
          <Section title="Verlauf">
            <BalkenDiagramm titel={`Beiträge je Monat – ${j1} gegen ${j2}`} name1={String(j1)} name2={`${j2} (Forecast)`} punkte={d.chart} />
          </Section>

          <Section title="Beiträge je Monat" flush>
            <AnalyticalTable columns={monatCols} data={d.monate} visibleRows={12} rowHeight={40} />
          </Section>

          <Section title="Beiträge je Vertragsart" count={d.knoten.filter((k) => k.ebene === 2).length} flush
                   status={<Text className="portal-muted portal-small">Stichtag je Monatserster: Januar alle Beiträge, Juli ohne Spende, übrige Monate Jugendtraining</Text>}>
            <AnalyticalTable
              key={`${jahr}|${mitglieder}|${knoten.length}`}
              columns={knotenCols} data={knoten} groupable rowHeight={40}
              reactTableOptions={{ initialState: { groupBy: ['kategorie'], expanded: Object.fromEntries(kategorien.map((k) => [`kategorie:${k}`, true])) }, autoResetExpanded: false }}
              visibleRows={Math.max(knoten.length + kategorien.length, 3)}
              withRowHighlight highlightField={(r: Record<string, any>) => (r.ebene === 1 ? 'Information' : 'None')}
              noDataText="Keine Verträge im Zeitraum"
            />
          </Section>
        </>
      )}
    </AppPage>
  );
}
