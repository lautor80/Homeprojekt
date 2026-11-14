import { useEffect, useMemo, useState } from 'react';
import { feld } from '../components/Varianten';
import { AnalyticalTable, Bar, Button, BusyIndicator, CheckBox, Dialog, Link, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { Section } from '../components/Section';
import { useSession } from '../session';
import { enabledModules } from '../modules';
import { coreNav } from '../shell/core';
import type { NavEntry } from '../platform';

/**
 * Nutzungsstatistik (Administration → Protokolle → Statistik): Anmeldungen je Benutzer und Monat, Aufrufe je App.
 * Apps werden über die Navigation benannt (Pfad → Menütext). Neuester Monat zuerst; Administratoren
 * lassen sich ausblenden. Klick auf eine Zahl zeigt, welche Benutzer welche App aufgerufen haben.
 */
interface Daten {
  monate: string[]; seit: string | null;
  anmeldungen: { id: string; username: string; name: string; monate: Record<string, number>; gesamt: number }[];
  apps: { pfad: string; monate: Record<string, number>; gesamt: number; benutzer: number }[];
}
interface Detail { id: string; username: string; name: string; pfad: string; anzahl: number; zuletzt: string }
/** Auswahl einer Zelle: App und/oder Benutzer, optional Monat */
interface Zelle { titel: string; pfad?: string; user?: string; monat?: string }
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
  const [ohneAdmin, setOhneAdmin] = useState(true);
  const [zelle, setZelle] = useState<Zelle | null>(null);
  const [details, setDetails] = useState<Detail[] | null>(null);
  const basis = `monate=${monate}&ohneAdmin=${ohneAdmin ? 1 : 0}`;
  useEffect(() => { setD(null); api.get<Daten>(`/api/statistik?${basis}`).then(setD).catch((e) => setError(e.message)); }, [basis]);
  useEffect(() => {
    if (!zelle) { setDetails(null); return; }
    setDetails(null);
    const p = new URLSearchParams();
    if (zelle.pfad) p.set('pfad', zelle.pfad);
    if (zelle.user) p.set('user', zelle.user);
    if (zelle.monat) p.set('monat', zelle.monat);
    api.get<Detail[]>(`/api/statistik/details?${basis}&${p}`).then(setDetails).catch((e) => { setError(e.message); setZelle(null); });
  }, [zelle, basis]);
  const namen = useMemo(() => appNamen([coreNav.home, ...enabledModules(me.modules).flatMap((m) => m.nav), coreNav.admin]), [me.modules]);

  const appName = (pfad: string) => namen.get(pfad) ?? pfad;
  /** Zahl als Link: öffnet die Aufschlüsselung Benutzer × App für die Zeile (und den Monat) */
  const zahl = (wahl: (r: Record<string, any>) => Zelle) => ({ value, row }: Cell) => (value
    ? <Link onClick={() => setZelle(wahl(row.original))}>{Number(value).toLocaleString('de-DE')}</Link>
    : <span className="portal-muted">·</span>);
  const monatsSpalten = (wahl: (r: Record<string, any>, m?: string) => Zelle) => (d?.monate ?? []).map((m): AnalyticalTableColumnDefinition => ({
    Header: monatKurz(m), id: m, width: 70, hAlign: 'End', accessor: (r: Record<string, any>) => r.monate[m] ?? 0,
    Cell: zahl((r) => wahl(r, m)),
  }));
  const proBenutzer = (r: Record<string, any>, m?: string): Zelle => ({ titel: `${r.name}${m ? ` · ${monatKurz(m)}` : ''}`, user: r.id, monat: m });
  const proApp = (r: Record<string, any>, m?: string): Zelle => ({ titel: `${appName(r.pfad)}${m ? ` · ${monatKurz(m)}` : ''}`, pfad: r.pfad, monat: m });
  const benutzerSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Benutzer', accessor: 'name', minWidth: 180, Cell: ({ row }: Cell) => <span>{row.original.name} <span className="portal-muted">({row.original.username})</span></span> },
    { Header: 'Gesamt', accessor: 'gesamt', width: 80, hAlign: 'End', Cell: zahl((r) => proBenutzer(r)) },
    ...monatsSpalten(proBenutzer),
  ];
  const appSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'App', id: 'app', minWidth: 200, accessor: (r: Record<string, any>) => appName(r.pfad), Cell: ({ row, value }: Cell) => <span>{value} <span className="portal-muted">{row.original.pfad}</span></span> },
    { Header: 'Aufrufe', accessor: 'gesamt', width: 85, hAlign: 'End', Cell: zahl((r) => proApp(r)) },
    { Header: 'Benutzer', accessor: 'benutzer', width: 85, hAlign: 'End', Cell: zahl((r) => proApp(r)) },
    ...monatsSpalten(proApp),
  ];
  const detailSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Benutzer', accessor: 'name', minWidth: 160, Cell: ({ row }: Cell) => <span>{row.original.name} <span className="portal-muted">({row.original.username})</span></span> },
    { Header: 'App', id: 'app', minWidth: 180, accessor: (r: Record<string, any>) => appName(r.pfad) },
    { Header: 'Aufrufe', accessor: 'anzahl', width: 85, hAlign: 'End' },
    { Header: 'Zuletzt', accessor: 'zuletzt', width: 140, Cell: ({ value }: Cell) => (value ? `${String(value).slice(8, 10)}.${String(value).slice(5, 7)}.${String(value).slice(0, 4)} ${String(value).slice(11)}` : '') },
  ];
  const summe = (l: { gesamt: number }[]) => l.reduce((s, x) => s + x.gesamt, 0);

  return (
    <AppPage varianten={{ repid: 'core.statistik', ansicht: { monate, ohneAdmin }, onAnwenden: (a) => { setMonate(feld(a, 'monate', monate)); setOhneAdmin(feld(a, 'ohneAdmin', ohneAdmin)); } }} title="Statistik" subtitle="Anmeldungen je Benutzer und Monat, Aufrufe je App"
             actions={<>
               <CheckBox text="Administratoren ausblenden" checked={ohneAdmin} onChange={(e) => setOhneAdmin(e.target.checked)} />
               <Select style={{ width: '11rem' }} onChange={(e) => setMonate(Number((e.detail.selectedOption as HTMLElement).dataset.m))}>
                 {[3, 6, 12, 24].map((m) => <Option key={m} data-m={m} selected={m === monate}>letzte {m} Monate</Option>)}
               </Select>
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>
            {d.seit ? `Erfasst seit ${d.seit.split('-').reverse().join('.')}.` : 'Noch keine Daten erfasst.'} Ein App-Aufruf zählt höchstens einmal je Benutzer und Minute. Klick auf eine Zahl zeigt, welche Benutzer welche App aufgerufen haben.
          </Text>
          <Section title="Anmeldungen je Benutzer und Monat" count={d.anmeldungen.length} status={<Text className="portal-muted">{summe(d.anmeldungen).toLocaleString('de-DE')} Anmeldungen</Text>} flush>
            <AnalyticalTable minRows={1} columns={benutzerSpalten} data={d.anmeldungen} visibleRows={Math.min(Math.max(d.anmeldungen.length, 1), 20)} noDataText="Keine Anmeldungen im Zeitraum" />
          </Section>
          <Section title="Aufrufe je App" count={d.apps.length} status={<Text className="portal-muted">{summe(d.apps).toLocaleString('de-DE')} Aufrufe</Text>} flush>
            <AnalyticalTable minRows={1} columns={appSpalten} data={d.apps} visibleRows={Math.min(Math.max(d.apps.length, 1), 25)} noDataText="Keine Aufrufe im Zeitraum" />
          </Section>
        </>
      )}
      {zelle && (
        <Dialog open headerText={`App-Aufrufe: ${zelle.titel}`} style={{ width: 'min(48rem, 96vw)' }} onClose={() => setZelle(null)}
                footer={<Bar endContent={<Button design="Emphasized" onClick={() => setZelle(null)}>Schließen</Button>} />}>
          {!details ? <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /> : (
            <AnalyticalTable minRows={1} columns={detailSpalten} data={details} visibleRows={Math.min(Math.max(details.length, 1), 15)}
                             noDataText="Keine App-Aufrufe (Anmeldungen ohne geöffnete App)" />
          )}
        </Dialog>
      )}
    </AppPage>
  );
}
