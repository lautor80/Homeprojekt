import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, Bar, Button, CheckBox, FlexBox, Icon, Input, Label, Link, MessageStrip, ObjectStatus, Option, SegmentedButton,
  SegmentedButtonItem, Select, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { DocsDialog, ImportDialog, InfoDialog, MailDialog, XRechnungDialog, type Doc, type MailRow, type XRes } from './dialogs';
import { MenuButton, T, betrag, dat, type KeyText, type ListRow } from './util';

// Filter und Auswahl bleiben beim Wechsel ins Detail und zurück erhalten
const merk = {
  jahr: String(new Date().getFullYear()),
  fakt: 'ALL',
  status: 'OPEN' as 'ALL' | 'OPEN' | 'DONE',
  suche: '',
  ansicht: 'LIST' as 'LIST' | 'TREE',
  auswahl: new Set<string>(),
};

const FAKT: KeyText[] = [
  { key: 'ALL', text: 'Alle' },
  { key: '1', text: 'Seit Vortag' },
  { key: '30', text: 'Letzte 30 Tage' },
  { key: '90', text: 'Letzte 3 Monate' },
];

interface TreeRow {
  id: string;
  text: string;
  icon?: string;
  isPos: boolean;
  auftragsnr?: string;
  anlagedatum?: string | null;
  unternehmer?: string;
  route?: string;
  ladedatum?: string | null;
  rechnung?: string;
  rechnungState?: 'Positive' | 'Critical';
  einnahmen: number | null;
  ausgaben: number | null;
  saldo: number;
  subRows?: TreeRow[];
}

/**
 * Baumansicht: Ebene 1 = Auftragsart, Ebene 2 = Kunde, Ebene 3 = Aufträge (wie TREE_BUILD)
 *   Einnahmen = Rechnungsbetrag, Ausgaben = Frachtpreis EK, Saldo = Einnahmen - Ausgaben
 */
function baum(list: ListRow[]): { rows: TreeRow[]; saldo: number } {
  const arten = new Map<string, Map<string, ListRow[]>>();
  for (const r of list) {
    if (!arten.has(r.art)) arten.set(r.art, new Map());
    const k = arten.get(r.art)!;
    if (!k.has(r.kunde)) k.set(r.kunde, []);
    k.get(r.kunde)!.push(r);
  }
  let gesamt = 0;
  const rows: TreeRow[] = [...arten.entries()].sort(([a], [b]) => a.localeCompare(b, 'de')).map(([art, kunden]) => {
    let ein = 0;
    let aus = 0;
    let anz = 0;
    const sub = [...kunden.entries()].map(([kunde, pos]) => {
      const kEin = pos.reduce((s, p) => s + p.betrag, 0);
      const kAus = pos.reduce((s, p) => s + p.ek, 0);
      ein += kEin;
      aus += kAus;
      anz += pos.length;
      return {
        id: `${art}|${kunde}`,
        text: `${kunde || 'Ohne Kunde'} (${pos.length})`,
        icon: 'customer',
        isPos: false,
        einnahmen: kEin,
        ausgaben: kAus,
        saldo: kEin - kAus,
        subRows: [...pos].sort((a, b) => a.auftragsnr.localeCompare(b.auftragsnr)).map((p) => ({
          id: p.auftragsnr,
          text: p.auftragsnr,
          isPos: true,
          auftragsnr: p.auftragsnr,
          anlagedatum: p.anlagedatum,
          unternehmer: p.unternehmer,
          route: p.route,
          ladedatum: p.ladedatum,
          rechnung: p.faktura ? `Rechnung ${p.faktura} vom ${dat(p.fakturadatum)}` : 'Rechnung offen',
          rechnungState: p.faktura ? 'Positive' as const : 'Critical' as const,
          einnahmen: p.betrag || null,
          ausgaben: p.ek || null,
          saldo: p.betrag - p.ek,
        })),
      };
    }).sort((a, b) => a.text.localeCompare(b.text, 'de'));
    gesamt += ein - aus;
    return { id: art, text: `${art || 'Ohne Auftragsart'} (${anz})`, icon: 'shipping-status', isPos: false, einnahmen: ein, ausgaben: aus, saldo: ein - aus, subRows: sub };
  });
  return { rows, saldo: gesamt };
}

const Saldo = ({ v }: { v: number }) => <ObjectStatus state={v < 0 ? 'Negative' : 'Positive'}><b>{betrag(v)} EUR</b></ObjectStatus>;

export function AuftraegeListe() {
  const navigate = useNavigate();
  const can = useCan();
  const [jahre, setJahre] = useState<KeyText[]>([]);
  const [jahr, setJahr] = useState(merk.jahr);
  const [fakt, setFakt] = useState(merk.fakt);
  const [status, setStatus] = useState(merk.status);
  const [suche, setSuche] = useState(merk.suche);
  const [ansicht, setAnsicht] = useState(merk.ansicht);
  const [basis, setBasis] = useState<ListRow[]>([]);
  const [auswahl, setAuswahlState] = useState<Set<string>>(merk.auswahl);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [firmaFehlt, setFirmaFehlt] = useState(false);
  const [baumEbene, setBaumEbene] = useState<'auf' | 'zu' | null>(null);

  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [mails, setMails] = useState<{ art: 'T' | 'L' | 'R'; rows: MailRow[] } | null>(null);
  const [xr, setXr] = useState<XRes | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [info, setInfo] = useState<{ title: string; text: string } | null>(null);
  const treeRef = useRef<{ toggleAllRowsExpanded?: (v: boolean) => void } | null>(null);

  const setAuswahl = (s: Set<string>) => {
    merk.auswahl = s;
    setAuswahlState(s);
  };

  const ladeInit = useCallback(async () => {
    const r = await api.get<{ jahre: KeyText[]; firmaUnvollstaendig: boolean }>(`${T}/init`);
    setJahre([...r.jahre, { key: 'ALL', text: 'Alle Jahre' }]);
    setFirmaFehlt(r.firmaUnvollstaendig);
    if (!r.jahre.some((j) => j.key === merk.jahr) && merk.jahr !== 'ALL') {
      merk.jahr = r.jahre.length ? 'ALL' : merk.jahr;
      setJahr(merk.jahr);
    }
  }, []);

  const lade = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBasis(await api.get<ListRow[]>(`${T}/auftraege${qs({ jahr: merk.jahr, fakt: merk.fakt })}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    ladeInit().catch((e) => setError(e.message));
  }, [ladeInit]);
  useEffect(() => {
    merk.jahr = jahr;
    merk.fakt = fakt;
    lade();
  }, [jahr, fakt, lade]);
  useEffect(() => {
    merk.status = status;
    merk.suche = suche;
    merk.ansicht = ansicht;
  }, [status, suche, ansicht]);

  // Status- und Suchfilter (wie LIST_FILTER)
  const liste = useMemo(() => {
    const q = suche.trim().toUpperCase();
    return basis.filter((r) => {
      if (status === 'OPEN' && r.faktura) return false;
      if (status === 'DONE' && !r.faktura) return false;
      if (q && !`${r.auftragsnr} ${r.kennzeichen ?? ''} ${r.kunde} ${r.unternehmer} ${r.route} ${r.faktura ?? ''}`.toUpperCase().includes(q)) return false;
      return true;
    });
  }, [basis, status, suche]);

  const summe = useMemo(() => liste.reduce((s, r) => ({ ek: s.ek + r.ek, vk: s.vk + r.vk, betrag: s.betrag + r.betrag }), { ek: 0, vk: 0, betrag: 0 }), [liste]);
  const sel = useMemo(() => liste.filter((r) => auswahl.has(r.auftragsnr)), [liste, auswahl]);
  const offen = sel.filter((r) => !r.faktura).length;
  const tree = useMemo(() => baum(liste), [liste]);

  useEffect(() => {
    if (baumEbene && treeRef.current?.toggleAllRowsExpanded) treeRef.current.toggleAllRowsExpanded(baumEbene === 'auf');
  }, [baumEbene, tree]);

  // ---------------------------------------------------------------- Aktionen
  async function rechnungen(sammel: boolean) {
    try {
      const r = await api.post<{ fakturen: string[]; ignoriert: number }>(`${T}/rechnungen`, { auftraege: sel.map((s) => s.auftragsnr), sammel });
      setAuswahl(new Set());
      await lade();
      await ladeInit();
      if (r.ignoriert) toast(`Aufgrund bereits bestehender Rechnungen wurden ${r.ignoriert} Aufträge nicht bearbeitet.`);
      setDocs(r.fakturen.map((f) => ({ url: `${T}/pdf/R/${encodeURIComponent(f)}`, filename: `Rechnung_${f}.pdf` })));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function drucken(art: 'T' | 'L' | 'R') {
    if (!sel.length) return toast('Bitte mindestens einen Auftrag auswählen.');
    if (art === 'R') {
      const f = [...new Set(sel.filter((s) => s.faktura).map((s) => s.faktura!))];
      if (!f.length) return toast('Unter der Auswahl ist kein fakturierter Auftrag.');
      return setDocs(f.map((x) => ({ url: `${T}/pdf/R/${encodeURIComponent(x)}`, filename: `Rechnung_${x}.pdf` })));
    }
    setDocs(sel.map((s) => ({
      url: `${T}/pdf/${art}/${encodeURIComponent(s.auftragsnr)}`,
      filename: `${art === 'T' ? 'Transportauftrag' : 'Lieferschein'}_${s.auftragsnr}.pdf`,
    })));
  }

  async function versenden(art: 'T' | 'L' | 'R') {
    const s = art === 'R' ? sel.filter((x) => x.faktura) : sel;
    if (!s.length) return toast(art === 'R' ? 'Unter der Auswahl ist kein fakturierter Auftrag.' : 'Bitte mindestens einen Auftrag auswählen.');
    try {
      setMails({ art, rows: await api.post<MailRow[]>(`${T}/mails`, { art, auftraege: s.map((x) => x.auftragsnr) }) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function erechnung() {
    const offenNr = sel.filter((s) => !s.faktura).map((s) => s.auftragsnr);
    const fakturen = [...new Set(sel.filter((s) => s.faktura).map((s) => s.faktura!))];
    if (!fakturen.length) {
      return setInfo({ title: 'E-Rechnung', text: offenNr.length
        ? `Markiert ${offenNr.length === 1 ? 'ist' : 'sind'} nur nicht fakturierte Aufträge: ${offenNr.join(', ')}. Eine E-Rechnung gibt es erst nach der Rechnungserstellung.`
        : 'Bitte eine fakturierte Rechnung markieren.' });
    }
    if (fakturen.length > 1) {
      return setInfo({ title: 'E-Rechnung', text: `Es sind ${fakturen.length} Rechnungen markiert: ${sel.filter((s) => s.faktura).map((s) => `${s.faktura} (Auftrag ${s.auftragsnr})`).join(', ')}. Bitte nur eine Rechnung markieren.` });
    }
    try {
      const r = await api.get<XRes>(`${T}/xrechnung/${encodeURIComponent(fakturen[0])}`);
      const markiert = sel.filter((s) => s.faktura === fakturen[0]).length;
      if (r.anzahlAuftraege > markiert) {
        r.hinweise.unshift(`Rechnung ${r.faktura} ist eine Sammelrechnung über ${r.anzahlAuftraege} Aufträge - die E-Rechnung enthält wie die PDF-Rechnung alle ${r.anzahlAuftraege} Aufträge.`);
      }
      setXr(r);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function paperless() {
    const f = [...new Set(sel.filter((s) => s.faktura).map((s) => s.faktura!))];
    if (!f.length) return toast('Unter der Auswahl ist kein fakturierter Auftrag.');
    try {
      const r = await api.post<{ faktura: string; ok: boolean; message: string }[]>(`${T}/paperless`, { fakturen: f });
      setInfo({ title: 'Paperless', text: r.map((x) => `${x.faktura}: ${x.message}`).join('\n') });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---------------------------------------------------------------- Tabelle
  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Status', accessor: 'status', id: 'status', width: 110, disableGroupBy: false },
    {
      Header: 'Auftrag', accessor: 'auftragsnr', width: 120, disableGroupBy: true,
      Cell: ({ row }: Cell) => row.isGrouped ? null : <div><b>{row.original.auftragsnr}</b><br /><Text>{row.original.kennzeichen}</Text></div>,
    },
    { Header: 'Art', accessor: 'art', width: 85, responsiveMinWidth: 1350 },
    { Header: 'Angelegt', accessor: 'anlagedatum', width: 95, responsiveMinWidth: 1450, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Kunde', accessor: 'kunde', minWidth: 120 },
    { Header: 'Unternehmer', accessor: 'unternehmer', minWidth: 110, responsiveMinWidth: 1250 },
    { Header: 'Route', accessor: 'route', minWidth: 140 },
    { Header: 'Ladedatum', accessor: 'ladedatum', width: 95, responsiveMinWidth: 1150, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Fracht EK', accessor: 'ek', width: 105, hAlign: 'End', disableGroupBy: true, Cell: ({ row }: Cell) => row.isGrouped ? null : `${betrag(row.original.ek)} EUR` },
    { Header: 'Fracht VK', accessor: 'vk', width: 105, responsiveMinWidth: 1350, hAlign: 'End', disableGroupBy: true, Cell: ({ row }: Cell) => row.isGrouped ? null : `${betrag(row.original.vk)} EUR` },
    { Header: 'Betrag', accessor: 'betrag', width: 115, hAlign: 'End', disableGroupBy: true, Cell: ({ row }: Cell) => row.isGrouped ? null : <b>{betrag(row.original.betrag)} EUR</b> },
    {
      Header: 'Rechnung', accessor: 'faktura', width: 175, disableGroupBy: true,
      Cell: ({ row }: Cell) => row.isGrouped ? null : (
        <FlexBox direction="Column">
          <ObjectStatus state={row.original.faktura ? 'Positive' : 'Critical'}>
            {row.original.faktura ? `${row.original.faktura} vom ${dat(row.original.fakturadatum)}` : 'offen'}
          </ObjectStatus>
          {row.original.dokFehlen && <ObjectStatus state="Critical" icon={<Icon name="alert" />}>Dokumente fehlen</ObjectStatus>}
        </FlexBox>
      ),
    },
  ], []);

  const groupBy = useMemo(() => ['status'], []);
  const selectedRowIds = useMemo(() => Object.fromEntries([...auswahl].map((k) => [k, true])), [auswahl]);
  const tableOptions = useMemo(() => ({
    getRowId: (r: ListRow) => r.auftragsnr,
    autoResetExpanded: false,
    initialState: { groupBy: ['status'], expanded: { 'status:Offen': true, 'status:Fakturiert': true } },
  }), []);
  const anzGruppen = new Set(liste.map((r) => r.status)).size;

  const treeColumns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    {
      Header: 'Art / Kunde / Auftrag', accessor: 'text', minWidth: 300,
      Cell: ({ row }: Cell) => {
        const r = row.original as TreeRow;
        return (
          <FlexBox alignItems="Center" style={{ gap: '0.25rem' }}>
            {r.isPos && (
              <CheckBox checked={auswahl.has(r.auftragsnr!)} onChange={(e) => {
                const s = new Set(auswahl);
                if (e.target.checked) s.add(r.auftragsnr!); else s.delete(r.auftragsnr!);
                setAuswahl(s);
              }} />
            )}
            {r.icon && <Icon name={r.icon} style={{ marginRight: '0.25rem' }} />}
            <FlexBox direction="Column">
              {r.isPos ? <Link onClick={() => navigate(`/transport/auftraege/${r.auftragsnr}`)}>{r.text}</Link> : <Text><b>{r.text}</b></Text>}
              {r.rechnung && <ObjectStatus state={r.rechnungState} icon={<Icon name={r.rechnungState === 'Positive' ? 'receipt' : 'money-bills'} />}>{r.rechnung}</ObjectStatus>}
            </FlexBox>
          </FlexBox>
        );
      },
    },
    { Header: 'Angelegt', accessor: 'anlagedatum', width: 95, responsiveMinWidth: 1450, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Unternehmer', accessor: 'unternehmer', width: 180 },
    { Header: 'Route', accessor: 'route', width: 230 },
    { Header: 'Ladedatum', accessor: 'ladedatum', width: 100, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Einnahmen', accessor: 'einnahmen', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => (value ? betrag(value) : '') },
    { Header: 'Ausgaben', accessor: 'ausgaben', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => (value ? betrag(value) : '') },
    { Header: 'Saldo', accessor: 'saldo', width: 150, hAlign: 'End', Cell: ({ value }: Cell) => <Saldo v={value} /> },
  ], [auswahl, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ebene 1 (Auftragsart) ist beim Öffnen aufgeklappt
  const treeOptions = useMemo(() => ({
    autoResetExpanded: false,
    getRowId: (r: TreeRow) => r.id,
    initialState: { expanded: { Fracht: true, 'Holzträger': true } },
  }), []);
  const zeilenBaum = (rows: TreeRow[]): number => rows.reduce((n, r) => n + 1 + (r.subRows ? zeilenBaum(r.subRows) : 0), 0);

  // ---------------------------------------------------------------- Kopf
  const header = (
    <FlexBox wrap="Wrap" alignItems="End" style={{ gap: '1.5rem', padding: '0.25rem 0 0.5rem' }}>
      <FlexBox direction="Column">
        <Label>Geschäftsjahr</Label>
        <Select style={{ width: '12rem' }} onChange={(e) => setJahr(e.detail.selectedOption.dataset.key!)}>
          {jahre.map((j) => <Option key={j.key} data-key={j.key} selected={j.key === jahr}>{j.text}</Option>)}
          {!jahre.some((j) => j.key === jahr) && <Option data-key={jahr} selected>{jahr}</Option>}
        </Select>
      </FlexBox>
      <FlexBox direction="Column">
        <Label>Fakturadatum</Label>
        <Select style={{ width: '12rem' }} onChange={(e) => setFakt(e.detail.selectedOption.dataset.key!)}>
          {FAKT.map((f) => <Option key={f.key} data-key={f.key} selected={f.key === fakt}>{f.text}</Option>)}
        </Select>
      </FlexBox>
      <FlexBox direction="Column">
        <Label>Status</Label>
        <SegmentedButton onSelectionChange={(e) => setStatus((e.detail.selectedItems[0] as HTMLElement).dataset.key as typeof status)}>
          <SegmentedButtonItem data-key="ALL" selected={status === 'ALL'}>Alle</SegmentedButtonItem>
          <SegmentedButtonItem data-key="OPEN" selected={status === 'OPEN'}>Offen</SegmentedButtonItem>
          <SegmentedButtonItem data-key="DONE" selected={status === 'DONE'}>Fakturiert</SegmentedButtonItem>
        </SegmentedButton>
      </FlexBox>
      <FlexBox direction="Column">
        <Label>Suche</Label>
        <Input style={{ width: '18rem' }} placeholder="Auftrag, Kunde, Kennzeichen, Ort …" value={suche} showClearIcon
               icon={<Icon name="search" />} onInput={(e) => setSuche(e.target.value)} />
      </FlexBox>
      <FlexBox style={{ gap: '1.5rem', marginLeft: 'auto' }}>
        <FlexBox direction="Column"><Label>Frachtpreis EK</Label><Text>{betrag(summe.ek)} EUR</Text></FlexBox>
        <FlexBox direction="Column"><Label>Frachtpreis VK</Label><Text>{betrag(summe.vk)} EUR</Text></FlexBox>
        <FlexBox direction="Column"><Label>Rechnungsbetrag</Label><Text><b>{betrag(summe.betrag)} EUR</b></Text></FlexBox>
        {ansicht === 'TREE' && <FlexBox direction="Column"><Label>Saldo</Label><Saldo v={tree.saldo} /></FlexBox>}
      </FlexBox>
    </FlexBox>
  );

  const toolbar = (
    <Bar
      startContent={<>
        <Title level="H5">Aufträge ({liste.length})</Title>
      </>}
      endContent={<>
        <SegmentedButton onSelectionChange={(e) => setAnsicht((e.detail.selectedItems[0] as HTMLElement).dataset.key as typeof ansicht)}>
          <SegmentedButtonItem data-key="LIST" icon="list" selected={ansicht === 'LIST'} />
          <SegmentedButtonItem data-key="TREE" icon="tree" selected={ansicht === 'TREE'} />
        </SegmentedButton>
        {ansicht === 'TREE' && <>
          <Button icon="expand-all" design="Transparent" onClick={() => setBaumEbene('auf')} />
          <Button icon="collapse-all" design="Transparent" onClick={() => setBaumEbene('zu')} />
        </>}
        {(can('transport.auftraege:edit') || can('transport.import:execute')) && (
          <MenuButton text="Neu" icon="create" design="Emphasized" items={[
            ...(can('transport.auftraege:edit') ? [
              { text: 'Frachtauftrag', icon: 'shipping-status', onClick: () => navigate('/transport/auftraege/neu/F') },
              { text: 'Holzträgerauftrag', icon: 'product', onClick: () => navigate('/transport/auftraege/neu/H') },
            ] : []),
            ...(can('transport.import:execute') ? [{ text: 'Import aus SAP-Export …', icon: 'upload', onClick: () => setImportOpen(true) }] : []),
          ]} />
        )}
        {can('transport.rechnungen:create') && <>
          <Button icon="lead" disabled={offen < 1} onClick={() => rechnungen(false)}>Einzelrechnungen</Button>
          <Button icon="collections-insight" disabled={offen < 2} onClick={() => rechnungen(true)}>Sammelrechnung</Button>
        </>}
        <MenuButton text="Drucken" icon="print" disabled={!sel.length} items={[
          { text: 'Transportauftrag', icon: 'shipping-status', onClick: () => drucken('T') },
          { text: 'Lieferschein', icon: 'document-text', onClick: () => drucken('L') },
          { text: 'Rechnung', icon: 'lead', onClick: () => drucken('R') },
        ]} />
        <MenuButton text="Versenden" icon="email" disabled={!sel.length || !can('transport.versand:execute')} items={[
          { text: 'Transportauftrag versenden', onClick: () => versenden('T') },
          { text: 'Lieferschein versenden', onClick: () => versenden('L') },
          { text: 'Rechnung versenden', onClick: () => versenden('R') },
          { text: 'E-Rechnung (ZUGFeRD / XRechnung)', icon: 'attachment-text-file', onClick: erechnung },
          { text: 'Rechnung an Paperless senden', icon: 'cloud', onClick: paperless },
        ]} />
      </>}
    />
  );

  return (
    <AppPage title="Auftragsverwaltung" header={header}>
      {firmaFehlt && can('transport.stammdaten:edit') && (
        <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Firmendaten (Name, Bank) fehlen noch – sie werden für Rechnungen und E-Rechnungen benötigt:
          {' '}<Link onClick={() => navigate('/transport/stammdaten')}>Stammdaten öffnen</Link>
        </MessageStrip>
      )}
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {toolbar}
      {ansicht === 'LIST' ? (
        <AnalyticalTable
          columns={columns}
          data={liste}
          loading={loading}
          groupBy={groupBy}
          groupable
          sortable
          filterable
          selectionMode="Multiple"
          selectionBehavior="RowSelector"
          selectedRowIds={selectedRowIds}
          reactTableOptions={tableOptions}
          onRowSelect={(e) => setAuswahl(new Set(Object.keys(e.detail.selectedRowIds).filter((k) => e.detail.selectedRowIds[k] && !k.includes(':'))))}
          onRowClick={(e) => {
            const r = e.detail.row;
            if (!r.isGrouped && (e.target as HTMLElement).closest('[data-column-id-cell="__ui5wcr__internal_selection_column"]') === null) {
              navigate(`/transport/auftraege/${r.original.auftragsnr}`);
            }
          }}
          rowHeight={52}
          visibleRows={Math.max(liste.length + anzGruppen, 3)}
          noDataText="Keine Aufträge für die Auswahl"
        />
      ) : (
        <AnalyticalTable
          columns={treeColumns}
          data={tree.rows}
          isTreeTable
          loading={loading}
          tableInstance={treeRef as never}
          reactTableOptions={treeOptions}
          rowHeight={52}
          visibleRows={Math.max(zeilenBaum(tree.rows), 3)}
          noDataText="Keine Aufträge für die Auswahl"
        />
      )}

      <DocsDialog docs={docs} onClose={() => setDocs(null)} />
      <MailDialog art={mails?.art ?? 'T'} mails={mails?.rows ?? null} onClose={() => setMails(null)} />
      <XRechnungDialog data={xr} onClose={() => setXr(null)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)}
                    onDone={async (text) => { setImportOpen(false); await ladeInit(); await lade(); setInfo({ title: 'Import abgeschlossen', text }); }} />
      <InfoDialog title={info?.title ?? ''} text={info?.text ?? null} onClose={() => setInfo(null)} />
    </AppPage>
  );
}
