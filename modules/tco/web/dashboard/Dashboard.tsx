import { useEffect, useRef, useState } from 'react';
import {
  BusyIndicator, Button, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, Option, SegmentedButton, SegmentedButtonItem, Select, Title,
} from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { ComboChart, LineChart, StackedBarChart } from './Chart';
import { DetailDialog } from './DetailDialog';
import { FinCard } from './FinCard';
import { KpiCard } from './KpiCard';
import { KpiTile } from './KpiTile';
import { DASH, type Auswahl, type Bereich, type Daten, type KeyText, type Kpi } from './typen';
import './dashboard.css';

type Display = 'TILE' | 'CARD';

const AUSWAHL_LEER: Auswahl = { jugJahre: [], halJahre: [], finJahre: [], finKonten: [], jugAnsicht: 'TRAINER' };

/** Mehrfachauswahl der Jahre für ein Diagramm */
function JahreWahl({ jahre, sel, onChange, width = '20rem' }: { jahre: KeyText[]; sel: string[]; onChange: (s: string[]) => void; width?: string }) {
  return (
    <MultiComboBox style={{ width }} placeholder="Jahre auswählen" onSelectionChange={(e) => onChange(e.detail.items.map((i) => (i as HTMLElement).dataset.key!))}>
      {jahre.map((j) => <MultiComboBoxItem key={j.key} data-key={j.key} text={j.text} selected={sel.includes(j.key)} />)}
    </MultiComboBox>
  );
}

/**
 * Vereinsübersicht – Port von Z2UI5_CL_TCO_REPORTING: Bereiche Mitglieder / Clubhaus / Finanzen / Jugend / Halle
 * mit KPI-Kacheln oder Cards, Geschäftsjahr, Refresh, je Bereich ein Diagramm und Detail-Popups.
 * Funktioniert ohne Props (Startseiteninhalt); `ohneTitel` lässt die Überschrift weg, wenn ein AppPage-Rahmen sie trägt.
 */
export function Dashboard({ ohneTitel }: { ohneTitel?: boolean } = {}) {
  const can = useCan();
  const edit = can('tco.dashboard:edit');
  const [jahr, setJahr] = useState<number | null>(new Date().getFullYear());
  const [display, setDisplay] = useState<Display>('TILE');
  const [auswahl, setAuswahl] = useState<Auswahl>(AUSWAHL_LEER);
  const [d, setD] = useState<Daten | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const jahrVorher = useRef<number | null>(null);

  const laden = async (j: number | null, a: Auswahl) => {
    setLaedt(true); setError(null);
    try {
      const q = qs({ jahr: j ?? undefined, jugJahre: a.jugJahre.join(','), halJahre: a.halJahre.join(','), finJahre: a.finJahre.join(','), finKonten: a.finKonten.join(','), jugAnsicht: a.jugAnsicht });
      const r = await api.get<Daten>(`${DASH}${q}`);
      setD(r);
      if (r.jahr !== j) setJahr(r.jahr);
    } catch (e) { setError((e as Error).message); } finally { setLaedt(false); }
  };
  useEffect(() => { laden(jahr, auswahl); }, [jahr, auswahl]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Wechsel des Geschäftsjahres: eine unveränderte Vorbelegung (nur das bisherige Jahr) folgt dem neuen Jahr, eine eigene Auswahl bleibt */
  const jahrWechseln = (neu: number) => {
    const alt = jahrVorher.current ?? jahr;
    const folgt = (s: string[]) => (alt !== null && s.length === 1 && s[0] === String(alt) ? [String(neu)] : s.length ? s : [String(neu)]);
    setAuswahl({ ...auswahl, jugJahre: folgt(auswahl.jugJahre), halJahre: folgt(auswahl.halJahre), finJahre: folgt(auswahl.finJahre) });
    jahrVorher.current = neu;
    setJahr(neu);
  };

  const kpiRender = (k: Kpi) => {
    const onDetail = k.hasDetail ? () => setDetail(k.key) : undefined;
    if (k.key === 'FIN_SALDO' && d) {
      return <FinCard key={k.key} kpi={k} fin={d.charts.finanzen}
                      onJahre={(s) => setAuswahl({ ...auswahl, finJahre: s })} onKonten={(s) => setAuswahl({ ...auswahl, finKonten: s })} />;
    }
    const mode: Display = k.display ?? display;
    return mode === 'CARD' ? <KpiCard key={k.key} kpi={k} onDetail={onDetail} /> : <KpiTile key={k.key} kpi={k} onPress={onDetail} />;
  };

  const diagramm = (b: Bereich) => {
    if (!d) return null;
    const c = d.charts;
    switch (b.key) {
      case 'MITGLIEDER':
        return <div className="portal-chartbox"><ComboChart {...c.mitgliederMonate} /><ComboChart {...c.mitgliederJahre} /></div>;
      case 'CLUBHAUS':
        return <div className="portal-chartbox"><LineChart title={c.clubhaus.title} name1={c.clubhaus.name1} name2={c.clubhaus.name2} data={c.clubhaus.data} /></div>;
      case 'JUGEND':
        return (
          <div className="portal-chartbox">
            <div className="portal-chartbox__sel">
              <Label>Jahre:</Label>
              <JahreWahl jahre={c.jugend.jahre} sel={c.jugend.jahreSel} onChange={(s) => setAuswahl({ ...auswahl, jugJahre: s })} />
              <SegmentedButton onSelectionChange={(e) => setAuswahl({ ...auswahl, jugAnsicht: (e.detail.selectedItems[0] as HTMLElement).dataset.a as Auswahl['jugAnsicht'] })}>
                <SegmentedButtonItem data-a="GESAMT" selected={c.jugend.ansicht === 'GESAMT'}>Gesamtstunden</SegmentedButtonItem>
                <SegmentedButtonItem data-a="TRAINER" selected={c.jugend.ansicht === 'TRAINER'}>je Trainer</SegmentedButtonItem>
              </SegmentedButton>
            </div>
            <StackedBarChart {...c.jugend} />
          </div>
        );
      case 'HALLE':
        return (
          <div className="portal-chartbox">
            <div className="portal-chartbox__sel">
              <Label>Jahre:</Label>
              <JahreWahl jahre={c.halle.jahre} sel={c.halle.jahreSel} onChange={(s) => setAuswahl({ ...auswahl, halJahre: s })} />
            </div>
            <StackedBarChart {...c.halle} />
            <LineChart title={c.halle.jahreVerlauf.title} name1={c.halle.jahreVerlauf.name1} data={c.halle.jahreVerlauf.data} values />
          </div>
        );
      default:
        return null;                                 // Finanzen: Diagramm ist in die Card „Saldo Konten“ integriert
    }
  };

  return (
    <div className="portal-dash">
      <div className="portal-dash__head" style={{ marginBottom: '1rem' }}>
        {!ohneTitel && <Title level="H2">Vereinsübersicht</Title>}
        <div className="portal-dash__head-right">
          <SegmentedButton onSelectionChange={(e) => setDisplay((e.detail.selectedItems[0] as HTMLElement).dataset.m as Display)}>
            <SegmentedButtonItem data-m="TILE" icon="grid" selected={display === 'TILE'}>Kacheln</SegmentedButtonItem>
            <SegmentedButtonItem data-m="CARD" icon="form" selected={display === 'CARD'}>Cards</SegmentedButtonItem>
          </SegmentedButton>
          <Label>Geschäftsjahr</Label>
          <Select style={{ width: '7.5rem' }} onChange={(e) => jahrWechseln(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
            {(d?.jahre ?? (jahr ? [jahr] : [])).map((j) => <Option key={j} data-j={j} selected={j === (d?.jahr ?? jahr)}>{String(j)}</Option>)}
          </Select>
          <Button icon="refresh" design="Transparent" tooltip="Kennzahlen neu laden" disabled={laedt} onClick={() => laden(jahr, auswahl)} />
        </div>
      </div>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {!d && laedt && <BusyIndicator active style={{ display: 'block', width: '100%', marginTop: '2rem' }} />}
      {d && d.bereiche.map((b) => (
        <Section key={b.key} title={b.title} status={laedt ? <BusyIndicator active size="S" style={{ display: 'block' }} /> : undefined}>
          <div className="portal-kpitiles">{b.kpis.map(kpiRender)}</div>
          {diagramm(b)}
        </Section>
      ))}
      {detail && d && (
        <DetailDialog kpiKey={detail} jahr={d.jahr} edit={edit}
                      onClose={(geaendert) => { setDetail(null); if (geaendert) laden(jahr, auswahl); }} />
      )}
    </div>
  );
}

/** Eigene Route /tco/uebersicht: Vereinsübersicht im Seitenrahmen */
export function DashboardPage() {
  return (
    <AppPage title="Vereinsübersicht" subtitle="Kennzahlen zu Mitgliedern, Clubhaus, Finanzen, Jugend und Halle">
      <Dashboard ohneTitel />
    </AppPage>
  );
}
