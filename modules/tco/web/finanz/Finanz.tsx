import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BusyIndicator, Button, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Select, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Attribute, Attributes } from '@core/components/Attributes';
import { Section } from '@core/components/Section';
import { ResponsiveTable, useKlein } from '@core/components/ResponsiveTable';
import { TCO, dat, eur } from '../util';
import { BalkenDiagramm, VerlaufDiagramm } from './Diagramme';

/**
 * Einnahmen & Ausgaben – Port von Z2UI5_CL_TCO_FINANZUEBERSICHT (Fachlogik ZCL_TCO_FINANZEN im Server).
 * Einnahmen/Ausgaben je Monat und je Geschäftsjahr, Kontostände aller Geldkonten, Gewinn und
 * Abgleich mit der Veränderung der Geldbestände, Konten mit Vorjahresvergleich, Liquidität,
 * Monatsverlauf über mehrere Jahre für gewählte Geldkonten.
 */

export const FZ = `${TCO}/finanz`;
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MON_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

type State = 'None' | 'Positive' | 'Negative' | 'Critical' | 'Information';
interface Monat { monat: number; einnahmen: number; ausgaben: number; ergebnis: number; kumuliert: number }
interface Jahr { jahr: number; einnahmen: number; ausgaben: number; ergebnis: number; geld_eb: number }
interface KontoWert { art: 'E' | 'A'; konto: string; name: string; wert: number; wert_vj: number }
interface Geld { konto: string; name: string; anfangsbestand: number; zugang: number; abgang: number; endbestand: number }
interface Ergebnis { jahr: number; einnahmen: number; ausgaben: number; gewinn: number; geld_ab: number; geld_eb: number; geld_delta: number; differenz: number; letzte_bu: string | null }
interface Liquiditaet {
  jahr: number; monat: number; geld: number; forderung: number; ford_stand: string; kredit: number; liquiditaet: number;
  /** nicht bezahlte Rechnungen (#28) */
  rechnungen?: { halle: number; verzehr: number; beitraege: number; summe: number; anzahl: number };
}
interface Uebersicht {
  jahr: number; monate: Monat[]; ergebnis: Ergebnis; geldkonten: Geld[]; jahre: Jahr[];
  einnahmen: KontoWert[]; ausgaben: KontoWert[]; liquiditaet: Liquiditaet; info: string | null;
}
interface Auswahl { jahre: number[]; geldkonten: { konto: string; name: string }[] }
interface Verlauf { jahr: number; monat: number; einnahmen: number; ausgaben: number; bestand: number; zukunft: boolean; offen?: number }

/** Farbe nach Vorzeichen (STATE_OF) */
const stateOf = (v: number): State => (v < -0.004 ? 'Negative' : v > 0.004 ? 'Positive' : 'None');
const Betrag = ({ v, state, fett }: { v: number; state?: State; fett?: boolean }) => (
  <ObjectStatus state={state ?? 'None'} style={{ whiteSpace: 'nowrap' }}>{fett ? <b>{eur(v)}</b> : eur(v)}</ObjectStatus>
);
const spalte = (header: string, accessor: string, cell: (row: Record<string, any>) => ReactNode, extra: Partial<AnalyticalTableColumnDefinition> = {}): AnalyticalTableColumnDefinition => ({
  Header: header, accessor, hAlign: 'End', minWidth: 110, Cell: ({ row }: Cell) => cell(row.original), ...extra,
});

export function Finanz() {
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const [aw, setAw] = useState<Auswahl | null>(null);
  const [d, setD] = useState<Uebersicht | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const klein = useKlein();

  const jahreLaden = () => api.get<Auswahl>(`${FZ}/jahre`).then(setAw).catch((e) => setError(e.message));
  const laden = async (j = jahr) => {
    setBusy(true);
    try { setD(await api.get<Uebersicht>(`${FZ}/uebersicht?jahr=${j}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { jahreLaden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { laden(jahr); }, [jahr]); // eslint-disable-line react-hooks/exhaustive-deps

  const e = d?.ergebnis;
  const stand = e ? (e.letzte_bu ? `Buchungen bis ${dat(e.letzte_bu)}` : `Keine Buchungen in ${jahr}`) : '';

  // ---- Tabellen
  const monate = useMemo(() => {
    if (!d) return [];
    const ges = d.monate.reduce((s, m) => ({ einnahmen: s.einnahmen + m.einnahmen, ausgaben: s.ausgaben + m.ausgaben }), { einnahmen: 0, ausgaben: 0 });
    return [
      ...d.monate.map((m) => ({ ...m, mtext: MONATE[m.monat - 1] ?? String(m.monat), gesamt: false })),
      { monat: 13, mtext: 'Gesamt', einnahmen: ges.einnahmen, ausgaben: ges.ausgaben, ergebnis: ges.einnahmen - ges.ausgaben, kumuliert: ges.einnahmen - ges.ausgaben, gesamt: true },
    ];
  }, [d]);
  const monatSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Monat', accessor: 'mtext', minWidth: 140, Cell: ({ row }: Cell) => <Text style={{ fontWeight: row.original.gesamt ? 'bold' : undefined }}>{row.original.mtext}</Text> },
    spalte('Einnahmen', 'einnahmen', (r) => <Betrag v={r.einnahmen} fett={r.gesamt} />),
    spalte('Ausgaben', 'ausgaben', (r) => <Betrag v={r.ausgaben} fett={r.gesamt} />),
    spalte('Ergebnis', 'ergebnis', (r) => <Betrag v={r.ergebnis} state={stateOf(r.ergebnis)} fett={r.gesamt} />),
    spalte('Kumuliert', 'kumuliert', (r) => <Betrag v={r.kumuliert} state={stateOf(r.kumuliert)} fett={r.gesamt} />),
  ];
  const jahrSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Geschäftsjahr', accessor: 'jahr', minWidth: 140, Cell: ({ row }: Cell) => (
      <span><Text style={{ fontWeight: 'bold' }}>{row.original.jahr}</Text>{row.original.jahr === new Date().getFullYear() && <span className="portal-muted portal-small"> laufendes Jahr</span>}</span>) },
    spalte('Einnahmen', 'einnahmen', (r) => <Betrag v={r.einnahmen} />),
    spalte('Ausgaben', 'ausgaben', (r) => <Betrag v={r.ausgaben} />),
    spalte('Gewinn', 'ergebnis', (r) => <Betrag v={r.ergebnis} state={stateOf(r.ergebnis)} fett />),
    spalte('Geldbestand 31.12.', 'geld_eb', (r) => <Betrag v={r.geld_eb} />, { minWidth: 140 }),
  ];
  const geldSpalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Konto', accessor: 'konto', width: 90, Cell: ({ value }: Cell) => <Text>{value}</Text> },
    { Header: 'Bezeichnung', accessor: 'name', minWidth: 180, Cell: ({ value }: Cell) => <Text>{value}</Text> },
    spalte('Anfangsbestand', 'anfangsbestand', (r) => <Betrag v={r.anfangsbestand} />),
    spalte('Zugang (Soll)', 'zugang', (r) => <Betrag v={r.zugang} />),
    spalte('Abgang (Haben)', 'abgang', (r) => <Betrag v={r.abgang} />),
    spalte('Kontostand', 'endbestand', (r) => <Betrag v={r.endbestand} state={r.endbestand < 0 ? 'Negative' : 'None'} fett />),
  ];
  // mehr Ausgaben = schlechter: Vorzeichen der Veränderung für Ausgaben umkehren
  const kontoSpalten = (einnahmen: boolean): AnalyticalTableColumnDefinition[] => [
    { Header: 'Konto', accessor: 'konto', width: 90, Cell: ({ value }: Cell) => <Text>{value}</Text> },
    { Header: 'Bezeichnung', accessor: 'name', minWidth: 180, Cell: ({ value }: Cell) => <Text>{value}</Text> },
    spalte(String(jahr - 1), 'wert_vj', (r) => <Betrag v={r.wert_vj} />),
    spalte(String(jahr), 'wert', (r) => <Betrag v={r.wert} fett />),
    spalte('Veränderung', 'delta', (r) => <Betrag v={r.wert - r.wert_vj} state={stateOf(einnahmen ? r.wert - r.wert_vj : r.wert_vj - r.wert)} />),
  ];

  const kpiFarbe = (v: number): State => (v < 0 ? 'Negative' : 'Positive');
  return (
    <AppPage title={`Einnahmen und Ausgaben ${jahr}`} subtitle={stand}
             actions={<>
               {!klein && <Label>Geschäftsjahr</Label>}
               <Select style={{ width: '7rem' }} onChange={(ev) => setJahr(Number((ev.detail.selectedOption as HTMLElement).dataset.j))}>
                 {(aw?.jahre ?? [jahr]).map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
               </Select>
               <Button icon="refresh" design="Transparent" tooltip="Aktualisieren" disabled={busy} onClick={() => { jahreLaden(); laden(); }} />
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {d?.info && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>{d.info}</MessageStrip>}
      <BusyIndicator active={busy && !d} delay={300} style={{ width: '100%', display: 'block' }}>
        {d && e && (
          <div className="portal-stack">
            {/* Kacheln (RENDER_TILE) */}
            <div style={{ display: 'grid', gridTemplateColumns: klein ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fit, minmax(13rem, 1fr))', gap: klein ? '0.5rem' : 'var(--portal-gap, 1rem)' }}>
              <Kpi titel="Einnahmen" sub={`Geschäftsjahr ${jahr}`} wert={e.einnahmen} state="Positive" fuss="Konten 8001 – 8999" />
              <Kpi titel="Ausgaben" sub={`Geschäftsjahr ${jahr}`} wert={e.ausgaben} state="Critical" fuss="Konten 2001 – 7999" />
              <Kpi titel="Gewinn" sub={`Einnahmen − Ausgaben ${jahr}`} wert={e.gewinn} state={kpiFarbe(e.gewinn)} fuss={stand} />
              <Kpi titel="Geldbestand" sub="Summe Geldkonten" wert={e.geld_eb} state="None" fuss={`Veränderung ${eur(e.geld_delta)}`} />
            </div>

            <MessageStrip design="Information" hideCloseButton>
              Abgleich Geldkonten: Anfangsbestand {eur(e.geld_ab)}, Kontostand {eur(e.geld_eb)}, Veränderung {eur(e.geld_delta)}. Gewinn {eur(e.gewinn)} –
              Differenz {eur(e.differenz)} (Tilgungen, Geldtransit, durchlaufende Posten).
            </MessageStrip>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))', gap: 'var(--portal-gap, 1rem)', alignItems: 'start' }}>
              {/* Kontostände Geldkonten + Liquidität (RENDER_GELD_CARD) */}
              <GeldKarte d={d} />
              {/* Grafik (RENDER_CHART) */}
              <Section title="Verlauf">
                <BalkenDiagramm schmal={klein} titel={`Einnahmen und Ausgaben je Monat ${jahr}`} name1="Einnahmen" name2="Ausgaben"
                                punkte={d.monate.map((m) => ({ label: MON_KURZ[m.monat - 1], val1: m.einnahmen, val2: m.ausgaben }))} />
              </Section>
            </div>

            <Monatsverlauf jahr={jahr} auswahl={aw} klein={klein} />

            <Section title={`Einnahmen und Ausgaben je Monat ${jahr}`} flush>
              <ResponsiveTable columns={monatSpalten} data={monate} visibleRows={monate.length} hervorheben={(r) => r.gesamt}
                               withRowHighlight highlightField={(r: Record<string, any>) => (r.gesamt ? 'Information' : 'None')} />
            </Section>

            <Section title="Einnahmen und Ausgaben je Geschäftsjahr" count={d.jahre.length} flush>
              <ResponsiveTable columns={jahrSpalten} data={d.jahre} visibleRows={d.jahre.length} />
            </Section>

            <Section title={`Geldkonten ${jahr}`} count={d.geldkonten.length} flush>
              <ResponsiveTable titelSpalten={2} columns={geldSpalten} data={d.geldkonten} visibleRows={Math.max(d.geldkonten.length, 1)} noDataText="Keine Geldkonten mit Bestand oder Bewegung" />
            </Section>

            <Section title="Einnahmen je Konto" count={d.einnahmen.length} flush>
              <ResponsiveTable titelSpalten={2} columns={kontoSpalten(true)} data={d.einnahmen} visibleRows={Math.max(d.einnahmen.length, 1)} noDataText={`Keine Einnahmen in ${jahr - 1}/${jahr}`} />
            </Section>

            <Section title="Ausgaben je Konto" count={d.ausgaben.length} flush>
              <ResponsiveTable titelSpalten={2} columns={kontoSpalten(false)} data={d.ausgaben} visibleRows={Math.max(d.ausgaben.length, 1)} noDataText={`Keine Ausgaben in ${jahr - 1}/${jahr}`} />
            </Section>

          </div>
        )}
      </BusyIndicator>
    </AppPage>
  );
}

/** Kennzahl-Kachel (GenericTile/NumericContent in SAP) */
function Kpi({ titel, sub, wert, state, fuss }: { titel: string; sub: string; wert: number; state: State; fuss: string }) {
  return (
    <Section title={titel}>
      <div className="portal-muted portal-small">{sub}</div>
      <div className={`portal-kpi__value portal-kpi__value--${state}`} style={{ margin: '0.25rem 0' }}>{eur(wert)}</div>
      <div className="portal-muted portal-small">{fuss}</div>
    </Section>
  );
}

/** Kontostände der Geldkonten mit Forderungen, Krediten und Liquidität */
function GeldKarte({ d }: { d: Uebersicht }) {
  const l = d.liquiditaet;
  const e = d.ergebnis;
  const zeile = (text: string, v: number, state: State = 'None', fett = false) => (
    <div className="portal-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', padding: '0.15rem 0', gap: '0.5rem' }}>
      {fett ? <Label style={{ fontWeight: 'bold', minWidth: 0 }} wrappingType="Normal">{text}</Label> : <Text style={{ minWidth: 0 }}>{text}</Text>}
      <Betrag v={v} state={state} fett={fett} />
    </div>
  );
  return (
    <Section title="Kontostände Geldkonten" status={<span className="portal-muted portal-small">{e.letzte_bu ? `Buchungen bis ${dat(e.letzte_bu)}` : `Keine Buchungen in ${d.jahr}`}</span>}>
      {d.geldkonten.map((g) => zeile(`${g.konto} ${g.name}`, g.endbestand, g.endbestand < 0 ? 'Negative' : 'None'))}
      {!d.geldkonten.length && <div className="portal-empty">Keine Geldkonten mit Bestand</div>}
      <div style={{ borderTop: '1px solid var(--sapList_BorderColor)', marginTop: '0.5rem', paddingTop: '0.5rem' }}>
        {zeile('Gesamt', e.geld_eb, 'None', true)}
      </div>
      <div style={{ marginTop: '0.75rem' }}>
        {zeile(l.ford_stand ? `+ Forderungen Clubhaus (${l.ford_stand})` : '+ Forderungen Clubhaus', l.forderung, 'Information')}
        {/* nicht bezahlte Rechnungen aus dem Portal (#28) */}
        {zeile(`+ Offene Rechnungen (${l.rechnungen?.anzahl ?? 0})`, l.rechnungen?.summe ?? 0, 'Information')}
        {l.rechnungen && l.rechnungen.summe !== 0 && (
          <div className="portal-muted portal-small" style={{ paddingLeft: '0.75rem' }}>
            Halle {eur(l.rechnungen.halle)} · Verzehr {eur(l.rechnungen.verzehr)} · Beitragsläufe {eur(l.rechnungen.beitraege)}
          </div>
        )}
        {zeile('+ Kredite (Darlehen)', l.kredit, l.kredit < 0 ? 'Negative' : 'None')}
      </div>
      <div style={{ borderTop: '1px solid var(--sapList_BorderColor)', marginTop: '0.5rem', paddingTop: '0.5rem' }}>
        {zeile(`Liquidität ${String(l.monat).padStart(2, '0')}/${l.jahr}`, l.liquiditaet, l.liquiditaet < 0 ? 'Negative' : 'Positive', true)}
      </div>
      <div className="portal-muted portal-small" style={{ marginTop: '0.5rem' }}>Anfangsbestand {d.jahr}: {eur(e.geld_ab)}</div>
    </Section>
  );
}

/** Monatsverlauf über mehrere Jahre für gewählte Geldkonten (ZCL_TCO_FINANZEN=>MONATSVERLAUF) */
function Monatsverlauf({ jahr, auswahl, klein }: { jahr: number; auswahl: Auswahl | null; klein: boolean }) {
  const [jahre, setJahre] = useState<number[]>([jahr - 1, jahr]);
  const [konten, setKonten] = useState<string[]>([]);
  const [v, setV] = useState<{ verlauf: Verlauf[]; anfangsbestand: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setJahre([jahr - 1, jahr]); }, [jahr]);
  useEffect(() => {
    if (!jahre.length) { setV({ verlauf: [], anfangsbestand: 0 }); return; }
    api.get<typeof v>(`${FZ}/verlauf?jahre=${jahre.join(',')}&konten=${konten.join(',')}`).then(setV).catch((e) => setError(e.message));
  }, [jahre, konten]); // eslint-disable-line react-hooks/exhaustive-deps
  const alleJahre = useMemo(() => {
    const s = new Set<number>([...(auswahl?.jahre ?? []), jahr, jahr - 1]);
    return [...s].sort((a, b) => b - a);
  }, [auswahl, jahr]);
  const punkte = (v?.verlauf ?? []).map((p) => ({ label: `${String(p.monat).padStart(2, '0')}/${p.jahr}`, einnahmen: p.einnahmen, ausgaben: p.ausgaben, bestand: p.bestand, zukunft: p.zukunft, offen: p.offen ?? 0 }));
  const letzte = [...(v?.verlauf ?? [])].reverse().find((p) => !p.zukunft) ?? v?.verlauf.at(-1);
  const summe = (k: 'einnahmen' | 'ausgaben') => (v?.verlauf ?? []).reduce((s, p) => s + p[k], 0);
  const filter = (
    <>
      <Label>Jahre</Label>
      <MultiComboBox style={{ width: klein ? '100%' : '12rem' }} placeholder="Jahre wählen"
                     onSelectionChange={(ev) => setJahre(ev.detail.items.map((i) => Number((i as HTMLElement).dataset.j)))}>
        {alleJahre.map((j) => <MultiComboBoxItem key={j} data-j={j} text={String(j)} selected={jahre.includes(j)} />)}
      </MultiComboBox>
      <Label>Geldkonten</Label>
      <MultiComboBox style={{ width: klein ? '100%' : '16rem' }} placeholder="alle Geldkonten"
                     onSelectionChange={(ev) => setKonten(ev.detail.items.map((i) => (i as HTMLElement).dataset.k!))}>
        {(auswahl?.geldkonten ?? []).map((k) => <MultiComboBoxItem key={k.konto} data-k={k.konto} text={`${k.konto} ${k.name}`} selected={konten.includes(k.konto)} />)}
      </MultiComboBox>
    </>
  );
  return (
    <Section title="Monatsverlauf Geldkonten" actions={klein ? undefined : filter}>
      {klein && <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '0.75rem' }}>{filter}</div>}
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {v && (
        <Attributes narrow>
          <Attribute label={`Anfangsbestand ${Math.min(...jahre)}`}>{eur(v.anfangsbestand)}</Attribute>
          <Attribute label="Einnahmen im Zeitraum">{eur(summe('einnahmen'))}</Attribute>
          <Attribute label="Ausgaben im Zeitraum">{eur(summe('ausgaben'))}</Attribute>
          <Attribute label={letzte ? `Kontostand ${String(letzte.monat).padStart(2, '0')}/${letzte.jahr}` : 'Kontostand'}>
            {letzte ? <ObjectStatus state={letzte.bestand < 0 ? 'Negative' : 'Positive'}>{eur(letzte.bestand)}</ObjectStatus> : null}
          </Attribute>
          {letzte && (letzte.offen ?? 0) !== 0 && (
            <Attribute label="inkl. offener Rechnungen">{eur(letzte.bestand + (letzte.offen ?? 0))} <span className="portal-muted">(offen {eur(letzte.offen ?? 0)})</span></Attribute>
          )}
        </Attributes>
      )}
      {punkte.length ? <VerlaufDiagramm punkte={punkte} schmal={klein} /> : <div className="portal-empty">Bitte mindestens ein Jahr wählen.</div>}
      <div className="portal-muted portal-small" style={{ marginTop: '0.5rem' }}>
        Einnahmen und Ausgaben werden über das Gegenkonto den gewählten Geldkonten zugeordnet; der Kontostand ist der Stand der gewählten Geldkonten zum Monatsende. Zukünftige Monate sind blass dargestellt.
      </div>
    </Section>
  );
}
