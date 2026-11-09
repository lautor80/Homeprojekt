import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, BusyIndicator, Button, Input, MessageStrip, ObjectStatus, Option, Panel, Select, Switch, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { eur } from '../util';
import { BT, type Uebersicht, type Zeile } from './typen';
import { BeitragDialog } from './BeitragDialog';

const FILTER: [string, string][] = [['A', 'Aktive'], ['I', 'Inaktive'], ['', 'Alle']];

/**
 * Beiträge (Beitragsstamm) – Port von Z2UI5_CL_TCO_BEITRAEGE.
 * Beitragsarten mit zeitabhängigen Beträgen; inaktive Beiträge werden weiter eingezogen,
 * sind aber für neue Verträge gesperrt. Erstbefüllung aus den Verträgen, solange der Stamm leer ist.
 */
export function Beitraege() {
  const can = useCan();
  const edit = can('tco.beitraege:edit');
  const [d, setD] = useState<Uebersicht | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnung, setWarnung] = useState<string | null>(null);
  const [suche, setSuche] = useState('');
  const [filter, setFilter] = useState('A');
  const [dlg, setDlg] = useState<string | null | undefined>(undefined); // undefined = zu, null = neu, sonst Art
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const laden = () => api.get<Uebersicht>(BT).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  async function aktion(fn: () => Promise<{ text?: string; warnung?: string | null; log?: string[] } | void>) {
    setError(null);
    setBusy(true);
    try {
      const r = await fn();
      if (r?.text) toast(r.text, 6000);
      if (r?.warnung) setWarnung(r.warnung);
      if (r?.log) setLog(r.log);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const zeilen = useMemo(() => {
    const s = suche.trim().toUpperCase();
    return (d?.zeilen ?? []).filter((z) => (filter === 'A' ? z.aktiv : filter === 'I' ? !z.aktiv : true))
      .filter((z) => !s || `${z.art} ${z.bezeichnung} ${z.konto}`.toUpperCase().includes(s));
  }, [d, suche, filter]);
  const gruppen = useMemo(() => [...new Set(zeilen.map((z) => z.gruppe))].sort(), [zeilen]);
  const laufend = zeilen.reduce((s, z) => s + z.vertraege, 0);

  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Turnus', accessor: 'gruppe', id: 'gruppe', width: 200, minWidth: 200, disableGroupBy: false, Cell: ({ value }: Cell) => <Text>{String(value).replace(/^\d · /, '')}</Text> },
    { Header: 'Art', accessor: 'art', width: 70 },
    { Header: 'Bezeichnung', accessor: 'bezeichnung', minWidth: 180 },
    { Header: 'Turnus', accessor: 'turnus', width: 120 },
    { Header: 'Erlöskonto', accessor: 'konto', width: 100 },
    { Header: 'Betrag heute', accessor: 'betrag', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => <Text style={{ fontWeight: 'bold' }}>{eur(value)}</Text> },
    { Header: 'gültig seit', accessor: 'seit', width: 110 },
    { Header: 'nächste Änderung', accessor: 'naechst', minWidth: 170, Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Information">{value}</ObjectStatus> : '') },
    { Header: 'laufende Verträge', accessor: 'vertraege', width: 130, hAlign: 'End' },
    {
      Header: 'Aktiv', accessor: 'aktiv', width: 110, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        return edit
          ? <Switch checked={z.aktiv} disabled={busy} onChange={(e) => aktion(() => api.post(`${BT}/${encodeURIComponent(z.art)}/aktiv`, { aktiv: e.target.checked }))} />
          : <ObjectStatus state={z.state}>{z.status}</ObjectStatus>;
      },
    },
    {
      Header: '', id: 'edit', width: 130, disableSortBy: true,
      Cell: ({ row }: Cell) => <Button icon={edit ? 'edit' : 'display'} design="Transparent" onClick={() => setDlg((row.original as Zeile).art)}>{edit ? 'Bearbeiten' : 'Anzeigen'}</Button>,
    },
  ].map((c) => (c.id === 'gruppe' ? c : { ...c, Aggregated: () => null })) as AnalyticalTableColumnDefinition[], [edit, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <Filters>
      <Filter label="Suche" width="18rem">
        <Input style={{ width: '100%' }} placeholder="Art, Bezeichnung oder Konto suchen" value={suche} showClearIcon onInput={(e) => setSuche(e.target.value)} />
      </Filter>
      <Filter label="Anzeige" width="10rem">
        <Select style={{ width: '100%' }} onChange={(e) => setFilter((e.detail.selectedOption as HTMLElement).dataset.f ?? '')}>
          {FILTER.map(([k, t]) => <Option key={k} data-f={k} selected={k === filter}>{t}</Option>)}
        </Select>
      </Filter>
      <HeaderKpi label="laufende Verträge" value={laufend} />
    </Filters>
  );

  return (
    <AppPage title="Mitgliedsbeiträge" subtitle="Beiträge und Beitragshöhen je Zeitraum" header={header}
             actions={<>
               {edit && <Button icon="add" design="Emphasized" disabled={!d || d.leer} onClick={() => setDlg(null)}>Neuer Beitrag</Button>}
               <Button icon="refresh" onClick={() => { setLog([]); setWarnung(null); laden(); }}>Aktualisieren</Button>
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {warnung && <MessageStrip design="Critical" onClose={() => setWarnung(null)} style={{ marginBottom: '0.5rem' }}>{warnung}</MessageStrip>}
      {!d && !error && <BusyIndicator active style={{ display: 'block', padding: '2rem' }} />}

      {log.length > 0 && (
        <Panel headerText="Protokoll Erstbefüllung" style={{ marginBottom: '0.5rem' }}>
          {log.map((l, i) => <Text key={i} style={{ display: 'block', whiteSpace: 'pre', fontFamily: l.startsWith('  ') ? 'monospace' : undefined }}>{l}</Text>)}
        </Panel>
      )}

      {d?.leer && (
        <Section title="Beitragsstamm aufbauen">
          <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>
            Der Beitragsstamm ist noch leer. Er kann einmalig aus den bestehenden Verträgen aufgebaut werden: je Beitragsart Bezeichnung,
            Turnus und der häufigste Betrag der laufenden Verträge. Verträge mit abweichendem Betrag werden als individuell markiert.
          </MessageStrip>
          {edit && (
            <div className="portal-row">
              <Button icon="database" design="Emphasized" disabled={busy} onClick={() => aktion(() => api.post(`${BT}/initial`, { test: false }))}>Beitragsstamm aus Verträgen aufbauen</Button>
              <Button icon="simulate" disabled={busy} onClick={() => aktion(() => api.post(`${BT}/initial`, { test: true }))}>Testlauf (nur Protokoll)</Button>
            </div>
          )}
        </Section>
      )}

      {d && !d.leer && (
        <Section title="Beitragsarten" count={zeilen.length} flush
                 status={<Text className="portal-muted portal-small">Inaktive Beiträge werden weiter eingezogen, sind aber für neue Verträge gesperrt.</Text>}>
          <AnalyticalTable minRows={1}
            key={`${filter}|${gruppen.join('|')}|${zeilen.length}`}
            columns={columns} data={zeilen} groupable sortable rowHeight={44}
            reactTableOptions={{ initialState: { groupBy: ['gruppe'], expanded: Object.fromEntries(gruppen.map((g) => [`gruppe:${g}`, true])) }, autoResetExpanded: false }}
            visibleRows={Math.max(zeilen.length + gruppen.length, 1)}
            noDataText={suche || filter ? 'Keine Beitragsart zu dieser Auswahl' : 'Keine Beitragsarten vorhanden'}
          />
        </Section>
      )}

      {dlg !== undefined && (
        <BeitragDialog art={dlg} edit={edit} onClose={(text, w) => {
          setDlg(undefined);
          if (text) { toast(text, 6000); setWarnung(w ?? null); laden(); }
        }} />
      )}
    </AppPage>
  );
}
