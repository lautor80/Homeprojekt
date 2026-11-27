import { useEffect, useState } from 'react';
import {
  Button, CheckBox, ComboBox, ComboBoxItem, DatePicker, Dialog, FlexBox, Input, Label, Link, MessageStrip, ObjectStatus,
  Tab, TabContainer, Text, Title,
} from '@ui5/webcomponents-react';
import { ResponsiveTable } from '@core/components/ResponsiveTable';
import { FussLeiste } from '@core/components/DialogFuss';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { download } from '@core/components/PdfDialog';
import { einstellungLink } from '@core/einstellungen';
import { toast } from '@core/toast';
import { TCO, dat, eur } from '../util';

const L = `${TCO}/halle/lastschrift`;
type State = 'None' | 'Information' | 'Critical' | 'Positive' | 'Negative';
const STATUS: Record<string, { text: string; state: State }> = {
  E: { text: 'Datei erzeugt', state: 'Information' }, Z: { text: 'Zahlung eingegangen', state: 'Critical' },
  V: { text: 'Verbucht', state: 'Positive' }, S: { text: 'Storniert', state: 'Negative' },
};

interface Cfg { aktiv: boolean; vorankuendigung: number; gebuehr: number | null; gebuehr_konto: string }
interface Lauf { laufid: string; faellig: string; anz_pos: number; anz_tx: number; summe: number; status: string; zahl_datum: string | null; ernam: string; erdat: string; internenr: string | null; rueck: number }
interface Init { cfg: Cfg; fehlt: string[]; glaeubigerId: string; laeufe: Lauf[]; faellig: string }
interface Pos {
  key: string; rgnr: string; kunde: string; adrnr: string; betrag: number; status: string; einzug_ab: string | null; kontoinhaber: string; iban: string;
  mandatsref: string; sequenz: string; quelle: string; meldung: string; state: State;
}
interface Tx { kontoinhaber: string; iban: string; mandatsref: string; sequenz: string; betrag: number; zweck: string; rechnungen: string[] }
interface Meldung { zeile: number; zahlerNr: string; schwere: 'E' | 'W'; feld: string; text: string }
interface Zahlart {
  adrnr: string; name: string; zahlart: string; quelle: string | null; kontoinhaber: string; iban: string; mandatsref: string; mandatsdatum: string | null;
  status: string; erfasst_ueber: string; entschieden_am: string; entschieden_von: string; widerrufen_am: string | null; grund: string | null;
}

const maske = (iban: string) => (iban && iban.length > 6 && !iban.includes('•') ? `${iban.slice(0, 2)}•• •••• ${iban.slice(-4)}` : iban);
const fehlerText = (e: unknown) => (e as Error).message;

/**
 * App „Hallen-Lastschrift“ (Tennishalle): Hallenrechnungen per SEPA-Lastschrift einziehen – separater, manueller Lauf
 * (Vorschlag aller angekündigten Lastschrift-Rechnungen, Datei pain.008), Mandate der Hallenbucher, Einstellungen.
 * Verbucht wird die Sammelgutschrift im Bankimport der FI Belege; dort werden auch Rücklastschriften erkannt.
 */
export function HallenLastschrift() {
  const [init, setInit] = useState<Init | null>(null);
  const [tab, setTab] = useState('laeufe');
  const [ansicht, setAnsicht] = useState<'liste' | 'neu' | string>('liste');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const laden = () => api.get<Init>(`${L}/init`).then(setInit).catch((e) => setError(fehlerText(e)));
  useEffect(() => { laden(); }, []);

  if (ansicht === 'neu') return <NeuerLauf init={init} onZurueck={() => setAnsicht('liste')} onErzeugt={(id, t) => { setOk(t); laden(); setAnsicht(id); }} />;
  if (ansicht !== 'liste') return <LaufDetail laufid={ansicht} onZurueck={() => { laden(); setAnsicht('liste'); }} />;

  const laufCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Lauf', accessor: 'laufid', width: 70, Cell: ({ value }: Cell) => Number(value) },
    { Header: 'Fälligkeit', accessor: 'faellig', width: 110, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Rechnungen', accessor: 'anz_pos', width: 110, hAlign: 'End' },
    { Header: 'Lastschriften', accessor: 'anz_tx', width: 110, hAlign: 'End' },
    { Header: 'Summe', accessor: 'summe', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Status', accessor: 'status', width: 150, Cell: ({ value }: Cell) => <ObjectStatus state={STATUS[value]?.state}>{STATUS[value]?.text ?? value}</ObjectStatus> },
    { Header: 'Rücklastschriften', accessor: 'rueck', width: 140, hAlign: 'End', Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Negative">{value}</ObjectStatus> : '') },
    { Header: 'Verbucht', accessor: 'internenr', width: 170, responsiveMinWidth: 1100, Cell: ({ row }: Cell) => (row.original.internenr ? `${dat(row.original.zahl_datum)} · FI ${Number(row.original.internenr)}` : '') },
    { Header: 'Erstellt', accessor: 'erdat', width: 160, responsiveMinWidth: 1250, Cell: ({ row }: Cell) => `${dat(row.original.erdat)} ${row.original.ernam ?? ''}` },
  ];

  return (
    <AppPage title="Hallen-Lastschrift" subtitle="Hallenrechnungen per SEPA-Lastschrift – verbucht wird die Gutschrift im Bankimport der FI Belege"
             actions={tab === 'laeufe' ? <Button design="Emphasized" icon="add" disabled={!init || init.fehlt.length > 0} onClick={() => setAnsicht('neu')}>Neuer Lauf</Button> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {ok && <MessageStrip design="Positive" onClose={() => setOk(null)} style={{ marginBottom: '0.5rem' }}>{ok}</MessageStrip>}
      {init && init.fehlt.length > 0 && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Gläubigerdaten unvollständig: {init.fehlt.join(', ')} –{' '}
          <Link onClick={() => window.location.assign(einstellungLink('tco', 'beitragseinzug'))}>Einstellungen → Beitragseinzug</Link>.
        </MessageStrip>
      )}
      {init && !init.cfg.aktiv && (
        <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Die Lastschrift für Hallenrechnungen ist ausgeschaltet – Hallenbucher werden nicht nach der Zahlart gefragt (Reiter „Einstellungen“).
        </MessageStrip>
      )}
      <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
        <Tab data-key="laeufe" text={`Läufe (${init?.laeufe.length ?? 0})`} selected={tab === 'laeufe'}>
          <ResponsiveTable minRows={1} columns={laufCols} data={init?.laeufe ?? []} loading={!init} sortable
                           visibleRows={Math.max(init?.laeufe.length ?? 0, 1)} noDataText="Noch keine Lastschriftläufe"
                           onRowClick={(e) => setAnsicht(e.detail.row.original.laufid)} />
        </Tab>
        <Tab data-key="mandate" text="Zahlarten und Mandate" selected={tab === 'mandate'}>
          {tab === 'mandate' && <Mandate />}
        </Tab>
        <Tab data-key="cfg" text="Einstellungen" selected={tab === 'cfg'}>
          {init && <Einstellungen cfg={init.cfg} onGespeichert={laden} />}
        </Tab>
      </TabContainer>
    </AppPage>
  );
}

// ---------------------------------------------------------------- Einstellungen
function Einstellungen({ cfg, onGespeichert }: { cfg: Cfg; onGespeichert: () => void }) {
  const [c, setC] = useState(cfg);
  const [gebuehr, setGebuehr] = useState(cfg.gebuehr === null ? '' : String(cfg.gebuehr).replace('.', ','));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function speichern() {
    setBusy(true); setError(null);
    try {
      const g = gebuehr.trim() ? Number(gebuehr.replace(',', '.')) : null;
      toast((await api.put<{ text: string }>(`${L}/cfg`, { ...c, gebuehr: g })).text, 6000);
      onGespeichert();
    } catch (e) { setError(fehlerText(e)); } finally { setBusy(false); }
  }
  return (
    <div style={{ maxWidth: '44rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <CheckBox text="Lastschrift für Hallenrechnungen anbieten (Hallenbucher und Mitglieder mit Hallenrechnungen werden beim nächsten Aufruf nach der Zahlart gefragt)"
                wrappingType="Normal" checked={c.aktiv} onChange={(e) => setC({ ...c, aktiv: e.target.checked })} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(14rem, auto) 1fr', gap: '0.5rem 1rem', alignItems: 'center', margin: '0.75rem 0' }}>
        <Label>Vorabankündigung (Tage)</Label>
        <Input type="Number" value={String(c.vorankuendigung)} style={{ width: '6rem' }} onInput={(e) => setC({ ...c, vorankuendigung: Number(e.target.value) || 0 })} />
        <Label>Rücklastschriftgebühr (€)</Label>
        <Input value={gebuehr} placeholder="leer = tatsächliche Bankgebühr" style={{ width: '14rem' }} onInput={(e) => setGebuehr(e.target.value)} />
        <Label>Konto Bankgebühr / Gebührenposition</Label>
        <Input value={c.gebuehr_konto} style={{ width: '8rem' }} onInput={(e) => setC({ ...c, gebuehr_konto: e.target.value })} />
      </div>
      <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.75rem' }}>
        Die Rechnung ist die Vorabankündigung: Beim ersten Druck steht dort „Einzug frühestens am“ (Druckdatum + Vorabankündigung) mit Mandatsreferenz
        und Gläubiger-ID. Wird eine Lastschrift zurückgegeben, erkennt der Bankimport sie an der Lastschrift-Referenz: Erlös und Bankgebühr werden
        zurückgebucht, die Rechnung ist wieder offen („In Bearbeitung“, Zahlart Überweisung) und trägt die Gebühr als zusätzliche Position.
      </Text>
      <Button design="Emphasized" icon="save" loading={busy} onClick={speichern}>Speichern</Button>
    </div>
  );
}

// ---------------------------------------------------------------- Zahlarten und Mandate
function Mandate() {
  const [d, setD] = useState<{ zahlarten: Zahlart[]; personen: { adrnr: string; kunde: string }[]; bankKlar: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [widerruf, setWiderruf] = useState<Zahlart | null>(null);
  const [erfassen, setErfassen] = useState(false);
  const laden = () => api.get<typeof d>(`${L}/zahlarten`).then(setD).catch((e) => setError(fehlerText(e)));
  useEffect(() => { laden(); }, []);
  async function widerrufen(grund: string) {
    try { toast((await api.post<{ text: string }>(`${L}/zahlarten/${widerruf!.adrnr}/widerruf`, { grund })).text, 6000); setWiderruf(null); laden(); } catch (e) { setError(fehlerText(e)); setWiderruf(null); }
  }
  const cols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Person', accessor: 'name', minWidth: 170, Cell: ({ row }: Cell) => <div style={{ lineHeight: 1.3 }}><Text>{row.original.name}</Text><br /><Label>{row.original.adrnr.startsWith('99') ? 'Hallenbucher' : 'Mitglied'} {row.original.adrnr.replace(/^0+/, '')}</Label></div> },
    { Header: 'Zahlart', accessor: 'zahlart', width: 160, Cell: ({ row }: Cell) => (
      <ObjectStatus state={row.original.zahlart !== 'LASTSCHRIFT' ? 'None' : row.original.status === 'AKTIV' ? 'Positive' : 'Negative'}>
        {row.original.zahlart !== 'LASTSCHRIFT' ? 'Überweisung' : row.original.status === 'AKTIV' ? 'Lastschrift' : 'Mandat widerrufen'}
      </ObjectStatus>) },
    { Header: 'Konto', accessor: 'iban', minWidth: 200, Cell: ({ row }: Cell) => (row.original.zahlart === 'LASTSCHRIFT'
      ? <div style={{ lineHeight: 1.3 }}><Text>{maske(row.original.iban)}</Text><br /><Label>{row.original.kontoinhaber}{row.original.quelle === 'MITGLIED' ? ' · Konto der Mitgliedschaft' : ''}</Label></div> : '') },
    { Header: 'Mandat', accessor: 'mandatsref', width: 190, Cell: ({ row }: Cell) => (row.original.mandatsref ? `${row.original.mandatsref} · ${dat(row.original.mandatsdatum)}` : '') },
    { Header: 'Entschieden', accessor: 'entschieden_am', width: 200, responsiveMinWidth: 1100, Cell: ({ row }: Cell) => (
      <div style={{ lineHeight: 1.3 }}><Text>{dat(row.original.entschieden_am?.slice(0, 10))} {row.original.entschieden_am?.slice(11)}</Text><br />
        <Label>{row.original.erfasst_ueber === 'PORTAL' ? 'im Portal' : 'Verwaltung'}: {row.original.entschieden_von}</Label></div>) },
    { Header: '', id: 'aktion', width: 120, Cell: ({ row }: Cell) => (row.original.zahlart === 'LASTSCHRIFT' && row.original.status === 'AKTIV'
      ? <Button design="Transparent" icon="cancel" onClick={() => setWiderruf(row.original)}>Widerrufen</Button>
      : row.original.widerrufen_am ? <Label wrappingType="Normal">{dat(row.original.widerrufen_am)}: {row.original.grund}</Label> : '') },
  ];
  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FlexBox justifyContent="SpaceBetween" alignItems="Center" style={{ marginBottom: '0.5rem' }}>
        <Text className="portal-muted portal-small">Entscheidungen aus dem Portal und von der Verwaltung erfasste Mandate. Ohne Eintrag gilt Überweisung.</Text>
        <Button icon="add" onClick={() => setErfassen(true)}>Mandat erfassen</Button>
      </FlexBox>
      <ResponsiveTable minRows={1} columns={cols} data={d?.zahlarten ?? []} loading={!d} sortable filterable rowHeight={48}
                       visibleRows={Math.max(Math.min(d?.zahlarten.length ?? 0, 20), 1)} noDataText="Noch niemand hat eine Zahlart gewählt" />
      <ConfirmDialog open={!!widerruf} danger askReason title="Mandat widerrufen" confirmText="Widerrufen" onCancel={() => setWiderruf(null)} onConfirm={widerrufen}
                     text={`Mandat von ${widerruf?.name ?? ''} widerrufen? Künftige Rechnungen gehen per Überweisung; bereits angekündigte Lastschriften außerhalb eines Laufs werden auf Überweisung umgestellt und müssen neu versendet werden.`} />
      {erfassen && d && <MandatErfassen personen={d.personen} onClose={() => setErfassen(false)} onGespeichert={() => { setErfassen(false); laden(); }} />}
    </>
  );
}

function MandatErfassen({ personen, onClose, onGespeichert }: { personen: { adrnr: string; kunde: string }[]; onClose: () => void; onGespeichert: () => void }) {
  const [adrnr, setAdrnr] = useState('');
  const [inhaber, setInhaber] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [datum, setDatum] = useState(new Date().toISOString().slice(0, 10));
  const [mitglied, setMitglied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function speichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${L}/zahlarten`, { adrnr, zahlart: 'LASTSCHRIFT', mitglied, kontoinhaber: inhaber, iban, bic: bic || null, mandatsdatum: datum });
      toast(r.text, 6000);
      onGespeichert();
    } catch (e) { setError(fehlerText(e)); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText="Mandat erfassen (Papiermandat)" onClose={onClose} style={{ width: 'min(34rem, 96vw)' }}
            footer={<FussLeiste endContent={<><Button onClick={onClose}>Abbrechen</Button><Button design="Emphasized" loading={busy} disabled={!adrnr} onClick={speichern}>Speichern</Button></>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(8rem, auto) 1fr', gap: '0.5rem 0.75rem', alignItems: 'center' }}>
        <Label required>Person</Label>
        <ComboBox placeholder="Person mit Hallenrechnung …" style={{ width: '100%' }} onSelectionChange={(e) => {
          const a = (e.detail.item as HTMLElement | null)?.dataset.key ?? '';
          setAdrnr(a);
          const p = personen.find((x) => x.adrnr === a);
          if (p && !inhaber) setInhaber(p.kunde.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()));
        }}>
          {personen.map((p) => <ComboBoxItem key={p.adrnr} data-key={p.adrnr} text={`${p.kunde} (${p.adrnr.replace(/^0+/, '')})`} />)}
        </ComboBox>
        {!adrnr.startsWith('99') && adrnr && <><span /><CheckBox text="Bankverbindung und Mandat der Mitgliedschaft verwenden" checked={mitglied} onChange={(e) => setMitglied(e.target.checked)} /></>}
        {!mitglied && <>
          <Label required>Kontoinhaber</Label><Input value={inhaber} maxlength={70} onInput={(e) => setInhaber(e.target.value)} style={{ width: '100%' }} />
          <Label required>IBAN</Label><Input value={iban} maxlength={42} onInput={(e) => setIban(e.target.value)} style={{ width: '100%' }} />
          <Label>BIC</Label><Input value={bic} maxlength={11} onInput={(e) => setBic(e.target.value)} style={{ width: '100%' }} />
          <Label required>Unterschrieben am</Label>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datum} onChange={(e) => setDatum(e.detail.value)} />
        </>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Neuer Lauf
function Meldungen({ m }: { m: Meldung[] }) {
  if (!m.length) return <Text>Keine Prüfmeldungen</Text>;
  return <>{m.map((x, i) => (
    <MessageStrip key={i} design={x.schwere === 'E' ? 'Negative' : 'Critical'} hideCloseButton style={{ marginBottom: '0.25rem' }}>
      {x.zahlerNr ? `Zahler ${x.zahlerNr} – ` : ''}{x.feld}: {x.text}
    </MessageStrip>
  ))}</>;
}

function posColumns(o?: { ohne: Set<string>; toggle: (k: string) => void }): AnalyticalTableColumnDefinition[] {
  return [
    ...(o ? [{ Header: '', id: 'sel', width: 50, Cell: ({ row }: Cell) => <CheckBox checked={!o.ohne.has(row.original.key)} onChange={() => o.toggle(row.original.key)} /> }] : []),
    { Header: 'Rechnung', accessor: 'rgnr', width: 100 },
    { Header: 'Person', accessor: 'kunde', minWidth: 170 },
    { Header: 'Betrag', accessor: 'betrag', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Einzug ab', accessor: 'einzug_ab', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Konto', accessor: 'iban', minWidth: 170, Cell: ({ row }: Cell) => (row.original.iban ? `${maske(row.original.iban)} · ${row.original.kontoinhaber}` : '') },
    { Header: 'Mandat', accessor: 'mandatsref', width: 190, Cell: ({ row }: Cell) => (row.original.mandatsref ? `${row.original.mandatsref}${row.original.sequenz === 'FRST' ? ' (Erstlastschrift)' : ''}` : '') },
    ...(o ? [] : [{ Header: 'Grund', accessor: 'meldung', minWidth: 220, Cell: ({ row }: Cell) => <ObjectStatus state={row.original.state}>{row.original.meldung}</ObjectStatus> }]),
  ];
}

function NeuerLauf({ init, onZurueck, onErzeugt }: { init: Init | null; onZurueck: () => void; onErzeugt: (id: string, text: string) => void }) {
  const [faellig, setFaellig] = useState(init?.faellig ?? '');
  const [v, setV] = useState<{ pos: Pos[]; excl: Pos[]; tx: Tx[]; bankKlar: boolean } | null>(null);
  const [ohne, setOhne] = useState<Set<string>>(new Set());
  const [meldungen, setMeldungen] = useState<Meldung[]>([]);
  const [tab, setTab] = useState('pos');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function vorschlagen(f = faellig) {
    setBusy(true); setError(null); setMeldungen([]);
    try { setV(await api.post(`${L}/vorschlag`, { faellig: f })); setOhne(new Set()); setTab('pos'); } catch (e) { setError(fehlerText(e)); } finally { setBusy(false); }
  }
  useEffect(() => { if (faellig) vorschlagen(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function erzeugen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ ok: boolean; laufid?: string; meldungen: Meldung[]; text: string }>(`${L}/laeufe`, { faellig, ohne: [...ohne] });
      setMeldungen(r.meldungen);
      if (!r.ok) { setError(r.text); setTab('msg'); return; }
      let text = r.text;
      if (v?.bankKlar) await download(`${L}/laeufe/${Number(r.laufid)}/datei`, `TCO_Hallenlastschrift_${Number(r.laufid)}.xml`);
      else text += ' Die Datei kann nur mit der Berechtigung „Bankdaten von Personen“ heruntergeladen werden.';
      onErzeugt(r.laufid!, text);
    } catch (e) { setError(fehlerText(e)); } finally { setBusy(false); }
  }
  const aktiv = (v?.pos ?? []).filter((p) => !ohne.has(p.key));
  const summe = Math.round(aktiv.reduce((s, p) => s + p.betrag, 0) * 100) / 100;
  const toggle = (k: string) => setOhne((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const txCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Kontoinhaber', accessor: 'kontoinhaber', minWidth: 170 },
    { Header: 'IBAN', accessor: 'iban', width: 140, Cell: ({ value }: Cell) => maske(value) },
    { Header: 'Mandat', accessor: 'mandatsref', width: 170 },
    { Header: 'Art', accessor: 'sequenz', width: 120, Cell: ({ value }: Cell) => (value === 'FRST' ? 'Erstlastschrift' : 'Folgelastschrift') },
    { Header: 'Betrag', accessor: 'betrag', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Verwendungszweck', accessor: 'zweck', minWidth: 260, responsiveMinWidth: 1100 },
  ];
  return (
    <AppPage title="Neuer Lauf Hallen-Lastschrift" actions={<Button icon="nav-back" onClick={onZurueck}>Zurück</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FlexBox wrap="Wrap" alignItems="End" style={{ gap: '1.5rem', marginBottom: '1rem' }}>
        <FlexBox direction="Column"><Label>Fälligkeit (Einzugsdatum)</Label>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={faellig} style={{ width: '10rem' }}
                      onChange={(e) => { setFaellig(e.detail.value); setV(null); if (e.detail.value) vorschlagen(e.detail.value); }} />
        </FlexBox>
        <Text className="portal-muted portal-small" style={{ maxWidth: '36rem' }}>
          Vorgeschlagen werden gedruckte bzw. versendete Lastschrift-Rechnungen, deren angekündigter Einzug spätestens am Fälligkeitstag liegt.
        </Text>
      </FlexBox>
      {v && (
        <FlexBox alignItems="Center" justifyContent="SpaceBetween" style={{ gap: '1rem', marginBottom: '0.75rem' }} wrap="Wrap">
          <MessageStrip design={aktiv.length ? 'Information' : 'Critical'} hideCloseButton style={{ flex: 1 }}>
            {aktiv.length ? `${aktiv.length} Rechnungen, Summe ${eur(summe)}. ${v.excl.length} nicht einziehbar${ohne.size ? `, ${ohne.size} abgewählt` : ''}.`
              : `Zum ${dat(faellig)} ist keine Rechnung einziehbar (${v.excl.length} ausgeschlossen).`}
          </MessageStrip>
          <Button design="Emphasized" icon="download" disabled={!aktiv.length} loading={busy} onClick={erzeugen}>Lastschriftdatei erzeugen</Button>
        </FlexBox>
      )}
      {v && (
        <TabContainer onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
          <Tab data-key="pos" text={`Rechnungen (${v.pos.length})`} selected={tab === 'pos'}>
            <ResponsiveTable minRows={1} columns={posColumns({ ohne, toggle })} data={v.pos} visibleRows={Math.max(v.pos.length, 1)} noDataText="Keine Rechnung einziehbar" />
          </Tab>
          <Tab data-key="tx" text={`Lastschriften (${v.tx.length})`} selected={tab === 'tx'}>
            <ResponsiveTable minRows={1} columns={txCols} data={v.tx} visibleRows={Math.max(v.tx.length, 1)} noDataText="Keine Lastschriften" />
          </Tab>
          <Tab data-key="excl" text={`Nicht einziehbar (${v.excl.length})`} selected={tab === 'excl'}>
            <ResponsiveTable minRows={1} columns={posColumns()} data={v.excl} visibleRows={Math.max(v.excl.length, 1)} noDataText="Nichts ausgeschlossen" />
          </Tab>
          {meldungen.length > 0 && <Tab data-key="msg" text={`Prüfmeldungen (${meldungen.length})`} selected={tab === 'msg'}><Meldungen m={meldungen} /></Tab>}
        </TabContainer>
      )}
    </AppPage>
  );
}

// ---------------------------------------------------------------- Lauf
interface Detail {
  kopf: Lauf & { msgid: string; erzeit: string };
  pos: { rgnr: string; kunde: string; betrag: number; kontoinhaber: string; iban: string; mandatsref: string; sequenz: string; e2e_id: string; status: string;
    internenr: string | null; rueck_internenr: string | null; rueck_datum: string | null; rueck_gebuehr: number | null }[];
  bankKlar: boolean;
}

function LaufDetail({ laufid, onZurueck }: { laufid: string; onZurueck: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [storno, setStorno] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nr = Number(laufid);
  const laden = () => api.get<Detail>(`${L}/laeufe/${nr}`).then(setD).catch((e) => setError(fehlerText(e)));
  useEffect(() => { laden(); }, [laufid]); // eslint-disable-line react-hooks/exhaustive-deps
  async function stornieren(grund: string) {
    setStorno(false);
    try { toast((await api.post<{ text: string }>(`${L}/laeufe/${nr}/storno`, { grund })).text); laden(); } catch (e) { setError(fehlerText(e)); }
  }
  const k = d?.kopf;
  const cols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Rechnung', accessor: 'rgnr', width: 100 },
    { Header: 'Person', accessor: 'kunde', minWidth: 160 },
    { Header: 'Betrag', accessor: 'betrag', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Konto', accessor: 'iban', minWidth: 170, Cell: ({ row }: Cell) => `${maske(row.original.iban)} · ${row.original.kontoinhaber}` },
    { Header: 'Mandat', accessor: 'mandatsref', width: 170 },
    { Header: 'Lastschrift', accessor: 'e2e_id', width: 120 },
    { Header: 'Stand', id: 'stand', minWidth: 220, Cell: ({ row }: Cell) => {
      const p = row.original as Detail['pos'][number];
      if (p.rueck_internenr) return <ObjectStatus state="Negative">Rücklastschrift {dat(p.rueck_datum)} (FI {Number(p.rueck_internenr)}){p.rueck_gebuehr ? `, Gebühr ${eur(p.rueck_gebuehr)}` : ''}</ObjectStatus>;
      if (p.internenr) return <ObjectStatus state="Positive">Bezahlt (FI {Number(p.internenr)})</ObjectStatus>;
      return <ObjectStatus state="Information">Eingereicht</ObjectStatus>;
    } },
  ];
  return (
    <AppPage title={`Hallen-Lastschrift Lauf ${nr}`} subtitle={k ? `Fällig ${dat(k.faellig)} · ${k.anz_pos} Rechnungen · ${eur(k.summe)}` : undefined}
             actions={<>
               <Button icon="nav-back" onClick={onZurueck}>Zurück</Button>
               {k && k.status !== 'S' && <Button icon="download" disabled={!d?.bankKlar} tooltip={d?.bankKlar ? undefined : 'Die SEPA-Datei enthält IBANs im Klartext – Berechtigung „Bankdaten von Personen“ nötig'}
                                                 onClick={() => download(`${L}/laeufe/${nr}/datei`, `TCO_Hallenlastschrift_${nr}.xml`).catch((e) => setError(fehlerText(e)))}>Datei herunterladen</Button>}
               {k?.status === 'E' && <Button design="Transparent" icon="cancel" onClick={() => setStorno(true)}>Stornieren</Button>}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {k && <FlexBox style={{ gap: '1rem', marginBottom: '0.75rem' }} alignItems="Center">
        <ObjectStatus state={STATUS[k.status]?.state}>{STATUS[k.status]?.text ?? k.status}</ObjectStatus>
        <Text className="portal-muted portal-small">erstellt {dat(k.erdat)} {k.erzeit?.slice(0, 5)} von {k.ernam} · Nachricht {k.msgid}</Text>
      </FlexBox>}
      {k?.status === 'E' && <MessageStrip hideCloseButton style={{ marginBottom: '0.5rem' }}>
        Datei bei der Bank einreichen. Die Gutschrift wird im Bankimport der FI Belege erkannt und auf die Rechnungen verbucht.</MessageStrip>}
      <Title level="H6" style={{ margin: '0.5rem 0' }}>Rechnungen</Title>
      <ResponsiveTable minRows={1} columns={cols} data={d?.pos ?? []} loading={!d} visibleRows={Math.max(d?.pos.length ?? 0, 1)} noDataText="Keine Positionen" />
      <ConfirmDialog open={storno} danger askReason title="Lauf stornieren" confirmText="Stornieren" onCancel={() => setStorno(false)} onConfirm={stornieren}
                     text="Lauf stornieren? Nur, wenn die Datei nicht bei der Bank eingereicht wurde – die Rechnungen sind danach wieder für einen Lauf frei." />
    </AppPage>
  );
}
