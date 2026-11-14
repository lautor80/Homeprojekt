import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Bar, Button, CheckBox, DatePicker, FlexBox, Label, Link, MessageStrip, ObjectStatus, Panel, Tab, TabContainer,
  Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { SperrHinweis, useSperre } from '@core/sperre';
import { FormGrid, TextField } from '@core/components/FormFields';
import { PdfDialog, download } from '@core/components/PdfDialog';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { einstellungLink } from '@core/einstellungen';
import { TCO, dat, eur } from '../util';

const S = `${TCO}/soll`;
type State = 'None' | 'Information' | 'Critical' | 'Positive' | 'Negative';
const STATUS: Record<string, { text: string; state: State }> = {
  E: { text: 'Datei erzeugt', state: 'Information' }, Z: { text: 'Zahlung eingegangen', state: 'Critical' },
  V: { text: 'Verbucht', state: 'Positive' }, S: { text: 'Storniert', state: 'Negative' },
};
const ARTEN: Record<string, string> = { MB: 'Mitgliedsbeitrag', JT: 'Jugendtraining', SP: 'Spende' };

interface Cfg { gl_name: string; iban: string; bic: string; gl_id: string; bankkonto: string; vorlauf: number; /** noch eine andere IBAN als beim Verein hinterlegt (#232, E3) */ abweichend?: boolean; iban_verein?: string }
interface Lauf {
  laufid: string; sollper: string; mit_mb: boolean; mit_jt: boolean; faellig: string; anz_pos: number; anz_tx: number; summe: number;
  status: string; zahl_datum: string | null; fi_datum: string | null; ernam: string; erdat: string; pl_doc_id: number | null; internenr: string | null;
}
interface Pos {
  key: string; adrnr: string; vertragnr: string; artname: string; beitragsart: string; betrag: number; konto: string; mitglnr: string;
  mitglied_name: string; zahler_adrnr: string; zahler_name: string; iban: string; mandatsref: string; meldung?: string; state?: State;
  grund?: string; e2e_id?: string; status?: string; internenr?: string | null; fi_posnr?: number | null;
}
interface Tx { zahler_name: string; iban: string; mandatsref: string; e2e_id: string; anzahl: number; betrag: number; positionen: string; zweck: string }
interface Meldung { zeile: number; zahlerNr: string; schwere: 'E' | 'W'; feld: string; text: string }
interface Init { cfg: Cfg; fehlt: string[]; laeufe: Lauf[]; vorschlag: { sollper: string; faellig: string; mitMb: boolean; mitJt: boolean; mitVz?: boolean } }

const monat = (sp: string) => `${sp.slice(4, 6)}/${sp.slice(0, 4)}`;
const maske = (iban: string) => (iban && iban.length > 6 ? `${iban.slice(0, 2)}•• •••• ${iban.slice(-4)}` : iban);
const artenText = (l: Pick<Lauf, 'mit_mb' | 'mit_jt'>) => [l.mit_mb && 'Beiträge/Spenden', l.mit_jt && 'Jugendtraining'].filter(Boolean).join(', ');

/** Tabelle ohne Scrollen, gruppiert, alle Gruppen offen */
function Gruppiert({ columns, data, by, noData }: { columns: AnalyticalTableColumnDefinition[]; data: Pos[]; by: string; noData: string }) {
  const gruppen = [...new Set(data.map((d) => String((d as unknown as Record<string, unknown>)[by] ?? '')))];
  return (
    <AnalyticalTable minRows={1}
      key={`${by}|${gruppen.join('|')}|${data.length}`}
      columns={columns.map((c) => (c.id === by || c.accessor === by ? { ...c, disableGroupBy: false } : { ...c, Aggregated: () => null }))}
      data={data} groupable sortable
      reactTableOptions={{ initialState: { groupBy: [by], expanded: Object.fromEntries(gruppen.map((g) => [`${by}:${g}`, true])) }, autoResetExpanded: false }}
      visibleRows={Math.max(data.length + gruppen.length, 1)} noDataText={noData}
    />
  );
}

export function Sollstellung() {
  const can = useCan();
  const edit = can('tco.soll:edit');
  const [init, setInit] = useState<Init | null>(null);
  const [ansicht, setAnsicht] = useState<'liste' | 'neu' | string>('liste');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const laden = () => api.get<Init>(`${S}/init`).then(setInit).catch((e) => setError(e.message));
  const zuGlaeubiger = () => { window.location.assign(einstellungLink('tco', 'beitragseinzug')); };
  useEffect(() => { laden(); }, []);

  const laufColumns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Lauf', accessor: 'laufid', width: 70, Cell: ({ value }: Cell) => Number(value) },
    { Header: 'Sollmonat', accessor: 'sollper', width: 95, Cell: ({ value }: Cell) => monat(value) },
    { Header: 'Beitragsarten', id: 'arten', accessor: (l: Record<string, any>) => artenText(l as Lauf), minWidth: 170 },
    { Header: 'Fälligkeit', accessor: 'faellig', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Positionen', accessor: 'anz_pos', width: 100, hAlign: 'End' },
    { Header: 'Lastschriften', accessor: 'anz_tx', width: 110, hAlign: 'End' },
    { Header: 'Summe', accessor: 'summe', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Status', accessor: 'status', width: 150, Cell: ({ value }: Cell) => <ObjectStatus state={STATUS[value]?.state}>{STATUS[value]?.text ?? value}</ObjectStatus> },
    { Header: 'Verbucht', accessor: 'internenr', width: 170, responsiveMinWidth: 1100, Cell: ({ row }: Cell) => (row.original.internenr ? `${dat(row.original.zahl_datum)} · FI ${Number(row.original.internenr)}` : '') },
    { Header: 'Erstellt', accessor: 'erdat', width: 160, responsiveMinWidth: 1250, Cell: ({ row }: Cell) => `${dat(row.original.erdat)} ${row.original.ernam ?? ''}` },
  ];

  if (ansicht === 'neu') return <NeueSollstellung init={init} onZurueck={() => setAnsicht('liste')} onErzeugt={(id, t) => { setOk(t); laden(); setAnsicht(id); }} />;
  if (ansicht !== 'liste') return <LaufDetail laufid={ansicht} onZurueck={() => { laden(); setAnsicht('liste'); }} />;

  return (
    <AppPage title="Sollstellungen" subtitle="Beitragseinzug per SEPA-Lastschrift – verbucht wird die Gutschrift im Bankimport der FI Belege"
             actions={<>
               {can('tco.soll:glaeubiger') && <Button design="Transparent" icon="action-settings" tooltip="Gläubigerdaten (Administration → Einstellungen → TC Oberthal → Beitragseinzug)" onClick={zuGlaeubiger} />}
               {edit && <Button design="Emphasized" icon="add" onClick={() => setAnsicht('neu')}>Neue Sollstellung</Button>}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {ok && <MessageStrip design="Positive" onClose={() => setOk(null)} style={{ marginBottom: '0.5rem' }}>{ok}</MessageStrip>}
      {init && init.fehlt.length > 0 && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Gläubigerdaten unvollständig: {init.fehlt.join(', ')}. Ohne diese Angaben kann keine Lastschriftdatei erzeugt werden –{' '}
          <Link onClick={zuGlaeubiger}>Administration → Einstellungen → TC Oberthal → Beitragseinzug</Link>.
        </MessageStrip>
      )}
      <Title level="H5" style={{ margin: '1rem 0 0.5rem' }}>Lastschriftläufe ({init?.laeufe.length ?? 0})</Title>
      <AnalyticalTable minRows={1} columns={laufColumns} data={init?.laeufe ?? []} loading={!init} sortable
                       visibleRows={Math.max(init?.laeufe.length ?? 0, 1)} noDataText="Noch keine Lastschriftläufe"
                       onRowClick={(e) => setAnsicht(e.detail.row.original.laufid)} />
    </AppPage>
  );
}

// ---------------------------------------------------------------- Gläubigerdaten
/**
 * Kapitel „Beitragseinzug“ der App Einstellungen (#232): Gläubigerdaten des Vereins für die SEPA-Lastschrift.
 * Bisher ein aufklappbarer Bereich über der Liste der Lastschriftläufe.
 */
export function GlaeubigerKapitel() {
  const can = useCan();
  const sperre = useSperre('SOLL_CFG', 'TCO', can('tco.soll:glaeubiger'), { bezeichnung: 'Gläubigerdaten' });
  const ro = !can('tco.soll:glaeubiger') || !sperre.eigen;
  const [c, setC] = useState<Cfg | null>(null);
  const [fehlt, setFehlt] = useState<string[]>([]);
  const [frage, setFrage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const laden = () => api.get<{ cfg: Cfg; fehlt: string[] }>(`${S}/cfg`).then((x) => { setC(x.cfg); setFehlt(x.fehlt); }).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null;
  const s = (k: keyof Cfg) => (v: string) => setC({ ...c, [k]: k === 'vorlauf' ? Number(v) || 0 : v });
  async function save() {
    setBusy(true); setError(null);
    try { toast((await api.put<{ text: string }>(`${S}/cfg`, { gl_name: c!.gl_name, gl_id: c!.gl_id, bankkonto: c!.bankkonto, vorlauf: c!.vorlauf })).text); await laden(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <SperrHinweis s={sperre} />
      {fehlt.length > 0 && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
        Gläubigerdaten unvollständig: {fehlt.join(', ')}. Ohne diese Angaben kann keine Lastschriftdatei erzeugt werden.</MessageStrip>}
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FormGrid>
        <TextField label="Name Gläubiger" required value={c.gl_name} onChange={s('gl_name')} readonly={ro} />
        <TextField label="Gläubiger-ID" required value={c.gl_id} onChange={s('gl_id')} readonly={ro} placeholder="DE98ZZZ09999999999" />
        <TextField label="Bankkonto FI" required value={c.bankkonto} onChange={s('bankkonto')} readonly={ro} />
        <TextField label="Vorlauf (Bankarbeitstage)" type="Number" value={String(c.vorlauf)} onChange={s('vorlauf')} readonly={ro} />
        {/* IBAN und BIC gehören dem Verein – hier nur zur Kontrolle, gepflegt wird an einer Stelle (#232, E3) */}
        <TextField label={c.abweichend ? 'IBAN für die Lastschrift (noch abweichend)' : 'IBAN (aus „Verein und Bank“)'} value={c.iban} onChange={() => undefined} readonly />
        <TextField label="BIC" value={c.bic} onChange={() => undefined} readonly />
      </FormGrid>
      <Text className="portal-muted" style={{ display: 'block', margin: '0.25rem 0 0.5rem' }}>
        IBAN und BIC pflegst du unter{' '}
        <Link onClick={() => { window.location.assign(einstellungLink('tco', 'verein')); }}>Einstellungen → TC Oberthal → Verein und Bank</Link>.
      </Text>
      {c.abweichend && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          In den Gläubigerdaten steht noch die IBAN {c.iban}, beim Verein {c.iban_verein || 'keine'}. Bis zur Entscheidung zieht die Lastschrift weiter über {c.iban} ein.
          Soll dieses Konto bleiben, trage es unter „Verein und Bank“ ein – dann stimmen beide überein. Soll das Konto des Vereins gelten:{' '}
          {!ro && c.iban_verein && <Button design="Transparent" disabled={busy} onClick={() => setFrage(true)}>Vereinskonto verwenden</Button>}
        </MessageStrip>
      )}
      <ConfirmDialog open={frage} title="Vereinskonto für die Lastschrift verwenden" confirmText="Vereinskonto verwenden"
                     text={`Die Lastschrift zieht ab jetzt über ${c.iban_verein ?? ''} ein statt über ${c.iban}. Die bisherige IBAN bleibt im Änderungsbeleg nachvollziehbar.`}
                     onCancel={() => setFrage(false)}
                     onConfirm={async () => {
                       setFrage(false); setBusy(true); setError(null);
                       try { toast((await api.post<{ text: string }>(`${S}/cfg/vereinskonto`)).text, 5000); await laden(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
                     }} />
      <Bar endContent={<>
        <ChangeHistoryButton objectType="SOLL_CFG" objectKey="TCO" />
        {!ro && <Button design="Emphasized" loading={busy} onClick={save}>Speichern</Button>}
      </>} />
    </>
  );
}

// ---------------------------------------------------------------- Spalten
function posColumns(mitAuswahl?: { ohne: Set<string>; toggle: (k: string) => void }, detail = false): AnalyticalTableColumnDefinition[] {
  return [
    ...(mitAuswahl ? [{
      Header: 'Einzug', id: 'sel', width: 75, disableSortBy: true,
      Cell: ({ row }: Cell) => <CheckBox checked={!mitAuswahl.ohne.has(row.original.key)} onChange={() => mitAuswahl.toggle(row.original.key)} />,
    }] : []),
    { Header: 'Zahler / Kontoinhaber', accessor: 'zahler_name', id: 'zahler_name', width: 220 },
    { Header: 'Mitglied', accessor: 'mitglied_name', minWidth: 170, Cell: ({ row }: Cell) => <div style={{ lineHeight: 1.3 }}><Text>{row.original.mitglied_name}</Text><br /><Label>Nr. {row.original.mitglnr || '–'}</Label></div> },
    { Header: 'Vertragsart', accessor: 'artname', width: 170, Cell: ({ row }: Cell) => <div style={{ lineHeight: 1.3 }}><Text>{row.original.artname}</Text><br /><Label>{ARTEN[row.original.beitragsart]}</Label></div> },
    { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Konto', accessor: 'konto', width: 75 },
    { Header: 'IBAN', accessor: 'iban', width: 130, responsiveMinWidth: 1150, Cell: ({ value }: Cell) => maske(value) },
    ...(detail
      ? [{ Header: 'FI-Beleg', accessor: 'internenr', width: 160, Cell: ({ row }: Cell) => (row.original.internenr ? `${Number(row.original.internenr)} · ${row.original.konto}/${String(row.original.fi_posnr ?? 0).padStart(3, '0')}` : '') }]
      : [{ Header: 'Hinweis', accessor: 'meldung', minWidth: 180, Cell: ({ row }: Cell) => (row.original.meldung ? <ObjectStatus state={row.original.state}>{row.original.meldung}</ObjectStatus> : '') }]),
  ];
}
const txColumns: AnalyticalTableColumnDefinition[] = [
  { Header: 'Zahler / Kontoinhaber', accessor: 'zahler_name', minWidth: 180 },
  { Header: 'IBAN', accessor: 'iban', width: 130, Cell: ({ value }: Cell) => maske(value) },
  { Header: 'Mandat', accessor: 'mandatsref', width: 140 },
  { Header: 'Lastschrift', accessor: 'e2e_id', width: 140 },
  { Header: 'Pos.', accessor: 'anzahl', width: 60, hAlign: 'End' },
  { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
  { Header: 'Verwendungszweck', accessor: 'zweck', minWidth: 260, responsiveMinWidth: 1200 },
];
function Meldungen({ m }: { m: Meldung[] }) {
  if (!m.length) return <Text>Keine Prüfmeldungen</Text>;
  return <>{m.map((x, i) => (
    <MessageStrip key={i} design={x.schwere === 'E' ? 'Negative' : 'Critical'} hideCloseButton style={{ marginBottom: '0.25rem' }}>
      {x.zahlerNr ? `Zahler ${x.zahlerNr} – ` : ''}{x.feld}: {x.text}
    </MessageStrip>
  ))}</>;
}

// ---------------------------------------------------------------- Neue Sollstellung
function NeueSollstellung({ init, onZurueck, onErzeugt }: { init: Init | null; onZurueck: () => void; onErzeugt: (id: string, text: string) => void }) {
  const bankKlar = useCan()('tco.bankdaten:display');
  const [sollper, setSollper] = useState(init?.vorschlag.sollper ?? '');
  const [faellig, setFaellig] = useState(init?.vorschlag.faellig ?? '');
  const [mitMb, setMitMb] = useState(init?.vorschlag.mitMb ?? false);
  const [mitJt, setMitJt] = useState(init?.vorschlag.mitJt ?? true);
  const [mitVz, setMitVz] = useState(init?.vorschlag.mitVz ?? true);
  const [v, setV] = useState<{ pos: Pos[]; excl: Pos[]; tx: Tx[] } | null>(null);
  const [ohne, setOhne] = useState<Set<string>>(new Set());
  const [meldungen, setMeldungen] = useState<Meldung[]>([]);
  const [tab, setTab] = useState('pos');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Parameter geändert → Vorschlag verwerfen (E6)
  const reset = () => { setV(null); setOhne(new Set()); setMeldungen([]); };
  async function monatWechsel(sp: string) {
    setSollper(sp); reset();
    try {
      const r = await api.get<{ faellig: string; mitMb: boolean }>(`${S}/faelligkeit?sollper=${sp}`);
      setFaellig(r.faellig); setMitMb(r.mitMb);
    } catch (e) { setError((e as Error).message); }
  }
  async function vorschlagen() {
    setBusy(true); setError(null); setMeldungen([]);
    try { setV(await api.post(`${S}/vorschlag`, { sollper, faellig, mitMb, mitJt, mitVz })); setTab('pos'); setOhne(new Set()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function erzeugen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ ok: boolean; laufid?: string; meldungen: Meldung[]; text: string }>(`${S}/laeufe`, { sollper, faellig, mitMb, mitJt, mitVz, ohne: [...ohne] });
      setMeldungen(r.meldungen);
      if (!r.ok) { setError(r.text); setTab('msg'); return; }
      // Die SEPA-Datei enthält die IBANs im Klartext – Download nur mit Bankdaten-Berechtigung
      if (bankKlar) await download(`${S}/laeufe/${Number(r.laufid)}/datei`, `TCO_Sollstellung_${Number(r.laufid)}_${sollper}.xml`);
      else r.text += ' Die Datei kann nur mit der Berechtigung „Bankdaten von Personen“ heruntergeladen werden.';
      const warn = r.meldungen.filter((m) => m.schwere === 'W').length;
      onErzeugt(r.laufid!, r.text + (warn ? ` ${warn} Warnung(en) – siehe Lauf.` : ''));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const aktiv = (v?.pos ?? []).filter((p) => !ohne.has(p.key));
  const summe = Math.round(aktiv.reduce((s, p) => s + p.betrag, 0) * 100) / 100;
  const txAnz = new Set(aktiv.map((p) => `${p.zahler_adrnr}|${p.mandatsref}|${p.iban}`)).size;
  const toggle = (k: string) => setOhne((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const cols = useMemo(() => posColumns({ ohne, toggle }), [ohne]); // eslint-disable-line react-hooks/exhaustive-deps
  const exclCols = useMemo(() => [{ Header: 'Grund', accessor: 'grund', id: 'grund', width: 220 } as AnalyticalTableColumnDefinition, ...posColumns()], []);

  return (
    <AppPage title="Neue Sollstellung" actions={<Button icon="nav-back" onClick={onZurueck}>Zurück</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {init && init.fehlt.length > 0 && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Gläubigerdaten unvollständig: {init.fehlt.join(', ')}</MessageStrip>}
      <FlexBox wrap="Wrap" alignItems="End" style={{ gap: '1.5rem', marginBottom: '1rem' }}>
        <FlexBox direction="Column"><Label>Sollmonat</Label>
          <DatePicker formatPattern="MM.yyyy" valueFormat="yyyyMM" value={sollper} style={{ width: '9rem' }} onChange={(e) => e.detail.value && monatWechsel(e.detail.value)} />
        </FlexBox>
        <FlexBox direction="Column"><Label>Fälligkeit (Einzugsdatum)</Label>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={faellig} style={{ width: '10rem' }} onChange={(e) => { setFaellig(e.detail.value); reset(); }} />
        </FlexBox>
        <FlexBox direction="Column"><Label>Beitragsarten</Label>
          <FlexBox>
            <CheckBox text="Mitgliedsbeiträge und Spenden (Januar/Juli)" checked={mitMb} onChange={(e) => { setMitMb(e.target.checked); reset(); }} />
            <CheckBox text="Jugendtraining (monatlich)" checked={mitJt} onChange={(e) => { setMitJt(e.target.checked); reset(); }} />
            <CheckBox text="Verzehrabrechnungen Clubhaus (offene Sammelabrechnungen mit Lastschrift)" checked={mitVz} onChange={(e) => { setMitVz(e.target.checked); reset(); }} />
          </FlexBox>
        </FlexBox>
        <Button design="Emphasized" icon="detail-view" loading={busy && !v} onClick={vorschlagen}>Vorschlag ermitteln</Button>
      </FlexBox>

      {v && (
        <FlexBox alignItems="Center" justifyContent="SpaceBetween" style={{ gap: '1rem', marginBottom: '0.75rem' }} wrap="Wrap">
          <MessageStrip design={aktiv.length ? 'Information' : 'Critical'} hideCloseButton style={{ flex: 1 }}>
            {aktiv.length
              ? `${aktiv.length} Positionen in ${txAnz} Lastschriften, Summe ${eur(summe)}. ${v.excl.length} Positionen ausgeschlossen${ohne.size ? `, ${ohne.size} abgewählt` : ''}.`
              : `Für ${monat(sollper)} sind keine Positionen fällig (${v.excl.length} ausgeschlossen).`}
          </MessageStrip>
          <Button design="Emphasized" icon="download" disabled={!aktiv.length} loading={busy} onClick={erzeugen}>Lastschriftdatei erzeugen</Button>
        </FlexBox>
      )}

      {v && (
        <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
          <Tab data-key="pos" text={`Positionen (${v.pos.length})`} selected={tab === 'pos'}>
            <Gruppiert columns={cols} data={v.pos} by="zahler_name" noData="Keine Positionen fällig" />
          </Tab>
          <Tab data-key="tx" text={`Lastschriften (${txAnz})`} selected={tab === 'tx'}>
            <AnalyticalTable minRows={1} columns={txColumns} data={v.tx} visibleRows={Math.max(v.tx.length, 1)} noDataText="Keine Lastschriften" />
          </Tab>
          <Tab data-key="excl" text={`Ausgeschlossen (${v.excl.length})`} selected={tab === 'excl'}>
            <Gruppiert columns={exclCols} data={v.excl} by="grund" noData="Nichts ausgeschlossen" />
          </Tab>
          {meldungen.length > 0 && <Tab data-key="msg" text={`Prüfmeldungen (${meldungen.length})`} selected={tab === 'msg'}><Meldungen m={meldungen} /></Tab>}
        </TabContainer>
      )}
    </AppPage>
  );
}

// ---------------------------------------------------------------- Detail eines Laufs
function LaufDetail({ laufid, onZurueck }: { laufid: string; onZurueck: () => void }) {
  const can = useCan();
  const sperre = useSperre('SOLLSTELLUNG', laufid, can('tco.soll:edit'), { bezeichnung: `Sollstellungslauf ${Number(laufid)}` });
  const edit = can('tco.soll:edit') && sperre.eigen;
  const bankKlar = can('tco.bankdaten:display');
  const [l, setL] = useState<{ kopf: Lauf & { msgid: string; erzeit: string }; pos: Pos[]; tx: Tx[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storno, setStorno] = useState(false);
  const [pdf, setPdf] = useState(false);
  const [busy, setBusy] = useState(false);
  const nr = Number(laufid);
  const laden = () => api.get<typeof l>(`${S}/laeufe/${nr}`).then(setL).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [laufid]); // eslint-disable-line react-hooks/exhaustive-deps
  const k = l?.kopf;
  const cols = useMemo(() => posColumns(undefined, true), []);

  async function paperless() {
    setBusy(true);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${S}/laeufe/${nr}/paperless`);
      toast(r.text);
      if (r.warnungen.length) setError(r.warnungen.join('\n'));
      setPdf(false); laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <AppPage title={`Lauf ${nr} – Sollmonat ${k ? monat(k.sollper) : ''}`}
             subtitle={k ? `${artenText(k)} · Fälligkeit ${dat(k.faellig)} · ${k.anz_pos} Positionen in ${k.anz_tx} Lastschriften · ${eur(k.summe)} · Nachricht ${k.msgid}` : ''}
             actions={<>
               <Button icon="nav-back" onClick={onZurueck}>Zurück</Button>
               <Button icon="print" onClick={() => setPdf(true)}>Druckvorschau</Button>
               {edit && k?.status !== 'S' && <Button icon="download" disabled={!bankKlar} tooltip={bankKlar ? undefined : 'Die SEPA-Datei enthält IBANs im Klartext – Berechtigung „Bankdaten von Personen“ nötig'} onClick={() => download(`${S}/laeufe/${nr}/datei`, `TCO_Sollstellung_${nr}_${k?.sollper}.xml`).catch((e) => setError(e.message))}>Datei herunterladen</Button>}
               {edit && k?.status === 'E' && <Button design="Negative" icon="undo" onClick={() => setStorno(true)}>Stornieren</Button>}
               <ChangeHistoryButton objectType="SOLLSTELLUNG" objectKey={laufid} />
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      <SperrHinweis s={sperre} />
      {k && (
        <FlexBox alignItems="Center" style={{ gap: '1rem', marginBottom: '0.75rem' }} wrap="Wrap">
          <ObjectStatus state={STATUS[k.status]?.state} showDefaultIcon>{STATUS[k.status]?.text}</ObjectStatus>
          {k.status === 'V' && <Text>Gutschrift am {dat(k.zahl_datum)} · verbucht am {dat(k.fi_datum)} · FI-Beleg {k.internenr ?? l?.pos[0]?.internenr}</Text>}
          {k.status === 'E' && <MessageStrip hideCloseButton style={{ flex: 1 }}>
            Nach der Gutschrift den Kontoauszug in <Link href="/tco/fi">FI Belege → Bankimport</Link> einlesen: Die Sammelgutschrift über {eur(k.summe)} wird
            diesem Lauf zugeordnet und je Position auf die Erlöskonten gebucht. Danach ist hier nichts mehr zu tun.
          </MessageStrip>}
          {k.pl_doc_id && <Label>In Paperless: DOKID {k.pl_doc_id}</Label>}
        </FlexBox>
      )}
      {l && (
        <TabContainer>
          <Tab text={`Positionen (${l.pos.length})`} selected>
            <Gruppiert columns={cols} data={l.pos} by="zahler_name" noData={k?.status === 'S' ? 'Lauf storniert – keine Positionen' : 'Keine Positionen'} />
          </Tab>
          <Tab text={`Lastschriften (${l.tx.length})`}>
            <AnalyticalTable minRows={1} columns={txColumns} data={l.tx} visibleRows={Math.max(l.tx.length, 1)} noDataText="Keine Lastschriften" />
          </Tab>
        </TabContainer>
      )}
      <ConfirmDialog open={storno} danger askReason title={`Lauf ${nr} stornieren`}
                     text={`Lauf ${nr} wirklich stornieren? Die Positionen werden gelöscht und können danach erneut eingezogen werden. Bereits an die Bank übermittelte Dateien bitte dort zurückziehen.`}
                     confirmText="Stornieren" onCancel={() => setStorno(false)}
                     onConfirm={async (grund) => {
                       setStorno(false);
                       try { toast((await api.post<{ text: string }>(`${S}/laeufe/${nr}/storno`, { grund })).text); laden(); } catch (e) { setError((e as Error).message); }
                     }} />
      <PdfDialog url={pdf ? `${S}/laeufe/${nr}/pdf` : null} title={`Sollstellung ${nr} – Voransicht`} filename={`Sollstellung_${nr}.pdf`}
                 onClose={() => setPdf(false)}
                 actions={edit && <Button design="Emphasized" icon="upload-to-cloud" loading={busy} onClick={paperless}>Nach Paperless übertragen</Button>} />
    </AppPage>
  );
}
