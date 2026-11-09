import { useEffect, useMemo, useState } from 'react';
import { AnalyticalTable, BusyIndicator, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { Section } from '../components/Section';
import { useSession } from '../session';
import { enabledModules } from '../modules';
import { coreNav } from '../shell/core';
import type { NavEntry } from '../platform';

/**
 * Nutzungsstatistik (Administration → Statistik): Anmeldungen je Benutzer und Monat, Aufrufe je App.
 * Apps werden über die Navigation benannt (Pfad → Menütext).
 */
interface Daten {
  monate: string[]; seit: string | null;
  anmeldungen: { id: string; username: string; name: string; monate: Record<string, number>; gesamt: number }[];
  apps: { pfad: string; monate: Record<string, number>; gesamt: number; benutzer: number }[];
}
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const monatKurz = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

function appNamen(eintraege: NavEntry[], pfad = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of eintraege) {
    const name = pfad ? `${pfad} › ${e.text}` : e.text;
    if (e.path) out.set(e.path, e.text);
    for (const [k, v] of appNamen(e.children ?? [], name)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

export function StatistikPage() {
  const { me } = useSession();
  const [monate, setMonate] = useState(12);
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setD(null); api.get<Daten>(`/api/statistik?monate=${monate}`).then(setD).catch((e) => setError(e.message)); }, [monate]);
  const namen = useMemo(() => appNamen([coreNav.home, ...enabledModules(me.modules).flatMap((m) => m.nav), coreNav.admin]), [me.modules]);

  const monatsSpalten = (d?.monate ?? []).map((m): AnalyticalTableColumnDefinition => ({
    Header: monatKurz(m), id: m, width: 70, hAlign: 'End', accessor: (r: Record<string, any>) => r.monate[m] ?? 0,
    Cell: ({ value }: Cell) => (value ? value.toLocaleString('de-DE') : <span className="portal-muted">·</span>),
  }));
  const benutzerSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Benutzer', accessor: 'name', minWidth: 180, Cell: ({ row }: Cell) => <span>{row.original.name} <span className="portal-muted">({row.original.username})</span></span> },
    { Header: 'Gesamt', accessor: 'gesamt', width: 80, hAlign: 'End' },
    ...monatsSpalten,
  ];
  const appSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'App', id: 'app', minWidth: 200, accessor: (r: Record<string, any>) => namen.get(r.pfad) ?? r.pfad, Cell: ({ row, value }: Cell) => <span>{value} <span className="portal-muted">{row.original.pfad}</span></span> },
    { Header: 'Aufrufe', accessor: 'gesamt', width: 85, hAlign: 'End' },
    { Header: 'Benutzer', accessor: 'benutzer', width: 85, hAlign: 'End' },
    ...monatsSpalten,
  ];
  const summe = (l: { gesamt: number }[]) => l.reduce((s, x) => s + x.gesamt, 0);

  return (
    <AppPage title="Statistik" subtitle="Anmeldungen je Benutzer und Monat, Aufrufe je App"
             actions={<Select style={{ width: '11rem' }} onChange={(e) => setMonate(Number((e.detail.selectedOption as HTMLElement).dataset.m))}>
               {[3, 6, 12, 24].map((m) => <Option key={m} data-m={m} selected={m === monate}>letzte {m} Monate</Option>)}
             </Select>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>
            {d.seit ? `Erfasst seit ${d.seit.split('-').reverse().join('.')}.` : 'Noch keine Daten erfasst.'} Ein App-Aufruf zählt höchstens einmal je Benutzer und Minute.
          </Text>
          <Section title="Anmeldungen je Benutzer und Monat" count={d.anmeldungen.length} status={<Text className="portal-muted">{summe(d.anmeldungen).toLocaleString('de-DE')} Anmeldungen</Text>} flush>
            <AnalyticalTable minRows={1} columns={benutzerSpalten} data={d.anmeldungen} visibleRows={Math.min(Math.max(d.anmeldungen.length, 1), 20)} noDataText="Keine Anmeldungen im Zeitraum" />
          </Section>
          <Section title="Aufrufe je App" count={d.apps.length} status={<Text className="portal-muted">{summe(d.apps).toLocaleString('de-DE')} Aufrufe</Text>} flush>
            <AnalyticalTable minRows={1} columns={appSpalten} data={d.apps} visibleRows={Math.min(Math.max(d.apps.length, 1), 25)} noDataText="Keine Aufrufe im Zeitraum" />
          </Section>
        </>
      )}
    </AppPage>
  );
}
