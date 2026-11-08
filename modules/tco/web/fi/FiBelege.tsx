import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Button, DateRangePicker, FlexBox, Label, Link, MessageStrip, ObjectStatus, Option, SegmentedButton,
  SegmentedButtonItem, Select, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { MenuButton } from '@core/components/MenuButton';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import {
  BelegeDialog, GegenkontoDialog, KontoBox, NotizenDialog, StornoDialog, ZahlungenDialog, ZuordnenDialog, useWarnungen,
} from './FiDialoge';
import { BankimportDialog } from './FiBankimport';
import { F, ZEITRAEUME, betragFarbe, zeitraum, type FiInit, type Liste, type Zeile } from './typen';

/** Filter bleiben beim Seitenwechsel erhalten; Start: aktueller Monat, Konto 1200 */
const merk = { zr: 'monat', von: zeitraum('monat')![0], bis: zeitraum('monat')![1], konto: '1200', tab: 'alle' as 'alle' | 'ohne' | 'mit' };

export function FiBelege() {
  const can = useCan();
  const buchen = can('tco.fi:buchen');
  const storno = can('tco.fi:storno');
  const [init, setInit] = useState<FiInit | null>(null);
  const [zr, setZr] = useState(merk.zr);
  const [von, setVon] = useState(merk.von);
  const [bis, setBis] = useState(merk.bis);
  const [konto, setKonto] = useState(merk.konto);
  const [tab, setTab] = useState(merk.tab);
  const [liste, setListe] = useState<Liste | null>(null);
  const [geladen, setGeladen] = useState<{ von: string; bis: string; konto: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { warnungen, schliessen } = useWarnungen();

  const [belege, setBelege] = useState<string | null>(null);
  const [zuordnen, setZuordnen] = useState<string[] | null>(null);
  const [stornoZ, setStornoZ] = useState<Zeile | null>(null);
  const [notizZ, setNotizZ] = useState<Zeile | null>(null);
  const [gkZ, setGkZ] = useState<Zeile | null>(null);
  const [zahlRg, setZahlRg] = useState<string | null | undefined>(undefined);
  const [bank, setBank] = useState(false);
  const [ok, setOk] = useState<string | null>(null);

  Object.assign(merk, { zr, von, bis, konto, tab });

  useEffect(() => {
    api.get<FiInit>(`${F}/init${qs({ jahr: Number(bis.slice(0, 4)) })}`).then((i) => {
      setInit(i);
      if (konto && !i.konten.some((k) => k.konto === konto)) setKonto('');
    }).catch((e) => setError(e.message));
  }, [bis.slice(0, 4)]); // eslint-disable-line react-hooks/exhaustive-deps

  const laden = useCallback(async (p = { von, bis, konto }) => {
    if (!p.von || !p.bis) { setError('Bitte einen vollständigen Zeitraum angeben'); return; }
    setLoading(true); setError(null);
    try {
      setListe(await api.get<Liste>(`${F}/buchungen${qs(p)}`));
      setGeladen(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [von, bis, konto]);
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const neuLaden = () => geladen && laden(geladen);

  const zeilen = liste?.zeilen ?? [];
  const ohne = zeilen.filter((z) => !z.anhaenge).length;
  const gefiltert = zeilen.filter((z) => tab === 'alle' || (tab === 'ohne' ? !z.anhaenge : z.anhaenge > 0));
  const tage = [...new Set(gefiltert.map((z) => z.datum))];
  const salden = liste?.salden;
  const kontoName = init?.konten.find((k) => k.konto === geladen?.konto)?.name;

  async function rechnungWaehlen(z: Zeile, rgnr: string) {
    if (!rgnr || !z.internenr) return;
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${F}/rechnung`, { internenr: z.internenr, konto: z.konto === '8003' ? z.konto : '8003', posnr: z.konto === '8003' ? z.posnr : 0, rgnr });
      setOk(r.text);
      if (r.warnungen.length) setError(r.warnungen.join('\n'));
      neuLaden();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Zuordnen markiert alle Zeilen mit gleicher ext. Belegnummer am selben Tag (Sammelbeleg), sonst die interne Nummer */
  const ziele = (z: Zeile) => [...new Set(zeilen.filter((x) => x.internenr && (z.belnr ? x.belnr === z.belnr && x.datum === z.datum && x.konto === z.konto : x.internenr === z.internenr)).map((x) => x.internenr!))];

  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    {
      Header: 'Datum', accessor: 'datum', id: 'datum', width: 150, disableGroupBy: false,
      Cell: ({ value, row }: Cell) => (row.isGrouped
        ? <Text style={{ fontWeight: 'bold' }}>{dat(value)} ({row.subRows.length})</Text>
        : dat(value)),
    },
    {
      Header: 'Beschreibung', accessor: 'text', minWidth: 220,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        return (
          <div style={{ lineHeight: 1.3, padding: '0.25rem 0' }}>
            <Text>{z.text}</Text>
            {(z.split || z.storniert || z.stornoZu) && <br />}
            {z.split && <Label>{z.split}</Label>}
            {z.storniert && <ObjectStatus state="Negative"> storniert durch {z.storniert}</ObjectStatus>}
            {z.stornoZu && <ObjectStatus state="Critical"> Storno zu {z.stornoZu}</ObjectStatus>}
          </div>
        );
      },
    },
    {
      Header: 'Gegenkonto', accessor: 'gkonto', width: 170, responsiveMinWidth: 1100,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (!z.gkonto) return '';
        return buchen && z.internenr
          ? <Link onClick={() => setGkZ(z)} wrappingType="Normal">{z.gkonto} {z.gkontoName}</Link>
          : <Text>{z.gkonto} {z.gkontoName}</Text>;
      },
    },
    {
      Header: 'Beleg', accessor: 'internenr', width: 115,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        return <div style={{ lineHeight: 1.3 }}><Text>{z.internenr ?? '–'}</Text><br /><Label>ext. {z.belnr || '–'}{geladen?.konto ? '' : ` · ${z.konto}`}</Label></div>;
      },
    },
    {
      Header: 'Betrag', accessor: 'betrag', width: 150, hAlign: 'End',
      Aggregated: ({ row }: Cell) => (salden && salden.tag[row.groupByVal] !== undefined
        ? <Text style={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>Saldo {eur(salden.tag[row.groupByVal])}</Text> : null),
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        return <ObjectStatus state={betragFarbe(z.konto, z.betrag)}>{eur(Math.abs(z.betrag))}</ObjectStatus>;
      },
    },
    {
      Header: 'Belege', accessor: 'anhaenge', width: 120,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.sammel) return <Label>{z.sammel} Buchungen</Label>;
        return (
          <FlexBox style={{ gap: '0.25rem' }}>
            <Button design={z.anhaenge ? 'Positive' : 'Negative'} icon="attachment" onClick={() => setBelege(z.internenr)}>{z.anhaenge}</Button>
            {buchen && <Button design="Transparent" icon="add-document" onClick={() => setZuordnen(ziele(z))} />}
          </FlexBox>
        );
      },
    },
    {
      Header: 'Rechnung', accessor: 'rgnr_txt', width: 210, responsiveMinWidth: 1250,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.rgnr_txt) return <Link onClick={() => setZahlRg(z.rgnr_txt)}>{z.rgnr_txt}</Link>;
        if (!z.hallenmiete || !z.internenr || z.storniert || z.stornoZu || !buchen || z.betrag === 0) return '';
        if ((z.konto === '8003' ? z.betrag > 0 : z.betrag < 0)) return ''; // nur Zahlungseingänge
        return (
          <Select style={{ width: '100%' }} onChange={(e) => rechnungWaehlen(z, (e.detail.selectedOption as HTMLElement).dataset.key ?? '')}>
            <Option data-key="" selected>Rechnung zuordnen …</Option>
            {(liste?.rechnungen ?? []).map((r) => (
              <Option key={r.rgnr_txt} data-key={r.rgnr_txt}>{r.rgnr_txt} – {r.kunde} · offen {eur(r.offen)}</Option>
            ))}
          </Select>
        );
      },
    },
    {
      Header: 'Notiz', accessor: 'notizen', width: 190, responsiveMinWidth: 1350,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (!z.internenr) return '';
        return (
          <FlexBox alignItems="Center" style={{ gap: '0.25rem', overflow: 'hidden' }}>
            <Button design="Transparent" icon="notes" onClick={() => setNotizZ(z)}>{z.notizen || ''}</Button>
            <Text maxLines={2} style={{ fontSize: 'var(--sapFontSmallSize)' }}>{z.letzteNotiz ?? ''}</Text>
          </FlexBox>
        );
      },
    },
    {
      Header: '', id: 'aktion', width: 60, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (!z.internenr) return '';
        return (
          <MenuButton icon="overflow" design="Transparent" items={[
            { text: 'Beleg zuordnen', icon: 'add-document', hidden: !buchen, onClick: () => setZuordnen(ziele(z)) },
            { text: 'Belege anzeigen', icon: 'attachment', onClick: () => setBelege(z.internenr) },
            { text: 'Beleg einer früheren Zahlung übernehmen', icon: 'history', hidden: !buchen || !z.gkonto, onClick: () => setGkZ(z) },
            { text: 'Notizen', icon: 'notes', onClick: () => setNotizZ(z) },
            { text: 'Stornieren', icon: 'undo', hidden: !storno, disabled: !!z.storniert || !!z.stornoZu, onClick: () => setStornoZ(z) },
          ]} />
        );
      },
    },
  ].map((c) => (c.id === 'datum' || c.Aggregated ? c : { ...c, Aggregated: () => null })) as AnalyticalTableColumnDefinition[], [salden, liste, buchen, storno, geladen]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <FlexBox direction="Column" style={{ gap: '0.5rem' }}>
      <FlexBox wrap="Wrap" alignItems="End" style={{ gap: '1rem' }}>
        <FlexBox direction="Column">
          <Label>Buchungszeitraum</Label>
          <FlexBox style={{ gap: '0.5rem' }}>
            <Select style={{ width: '12rem' }} onChange={(e) => {
              const k = (e.detail.selectedOption as HTMLElement).dataset.key!;
              setZr(k);
              const z = zeitraum(k);
              if (z) { setVon(z[0]); setBis(z[1]); }
            }}>
              {ZEITRAEUME.map((z) => <Option key={z.key} data-key={z.key} selected={z.key === zr}>{z.text}</Option>)}
            </Select>
            <DateRangePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" delimiter=" – " placeholder="Von – Bis" style={{ width: '15rem' }}
                             value={von && bis ? `${von} – ${bis}` : ''} readonly={zr !== 'frei'}
                             onChange={(e) => {
                               const [a, b] = e.detail.value.split(' – ');
                               if (a && b) { setVon(a); setBis(b); } else { setVon(''); setBis(''); }
                             }} />
          </FlexBox>
        </FlexBox>
        <FlexBox direction="Column">
          <Label>Konto</Label>
          <KontoBox konten={init?.konten ?? []} value={konto} alle onChange={setKonto} style={{ width: '20rem' }} />
        </FlexBox>
        <Button design="Emphasized" icon="search" onClick={() => laden()}>Go</Button>
        <div style={{ flex: 1 }} />
        {salden && (
          <FlexBox style={{ gap: '2rem' }}>
            <FlexBox direction="Column"><Label>Jahresanfang ({salden.quelle})</Label><Text>{eur(salden.jahresanfang)}</Text></FlexBox>
            <FlexBox direction="Column">
              <Label>Saldo aktuell{salden.aktuellDatum ? ` (${dat(salden.aktuellDatum)})` : ''}</Label>
              <ObjectStatus state={salden.aktuell < 0 ? 'Negative' : 'Positive'}><b>{eur(salden.aktuell)}</b></ObjectStatus>
            </FlexBox>
          </FlexBox>
        )}
      </FlexBox>
    </FlexBox>
  );

  const actions = <>
    {buchen && <Button icon="upload" onClick={() => setBank(true)}>Bankimport</Button>}
    {buchen && <Button icon="add" onClick={() => setBank(true)}>Manuelle Buchung</Button>}
    <Button icon="lead" onClick={() => setZahlRg(null)}>Teilzahlungen</Button>
    <ChangeHistoryButton objectType="FIBELEG" objectKey={stornoZ?.internenr ?? belege ?? ''} />
  </>;

  return (
    <AppPage title="FI-Belege" subtitle="Kontobewegungen, Belege aus Paperless, Bankimport und Storno" header={header} actions={actions}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {ok && <MessageStrip design="Positive" onClose={() => setOk(null)} style={{ marginBottom: '0.5rem' }}>{ok}</MessageStrip>}
      {warnungen.length > 0 && <MessageStrip design="Critical" onClose={schliessen} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{warnungen.join('\n')}</MessageStrip>}
      {init && !init.paperless && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Paperless ist nicht eingerichtet – Belege können nicht angezeigt oder zugeordnet werden (TC Oberthal → Stammdaten).</MessageStrip>}

      <FlexBox alignItems="Center" justifyContent="SpaceBetween" style={{ margin: '0.25rem 0 0.5rem', gap: '1rem' }} wrap="Wrap">
        <Title level="H5">{geladen?.konto ? `${geladen.konto} ${kontoName ?? ''}` : 'Alle Konten'} · {dat(geladen?.von)} – {dat(geladen?.bis)}</Title>
        <SegmentedButton onSelectionChange={(e) => setTab((e.detail.selectedItems[0] as HTMLElement).dataset.key as typeof tab)}>
          <SegmentedButtonItem data-key="alle" selected={tab === 'alle'}>Alle ({zeilen.length})</SegmentedButtonItem>
          <SegmentedButtonItem data-key="ohne" selected={tab === 'ohne'}>Ohne Belege ({ohne})</SegmentedButtonItem>
          <SegmentedButtonItem data-key="mit" selected={tab === 'mit'}>Mit Belegen ({zeilen.length - ohne})</SegmentedButtonItem>
        </SegmentedButton>
      </FlexBox>

      <AnalyticalTable
        key={`${geladen?.von}|${geladen?.bis}|${geladen?.konto}|${tab}|${tage.length}`}
        columns={columns}
        data={gefiltert}
        loading={loading}
        sortable
        groupable
        rowHeight={52}
        reactTableOptions={{
          initialState: { groupBy: ['datum'], sortBy: [{ id: 'datum', desc: true }], expanded: Object.fromEntries(tage.map((t) => [`datum:${t}`, true])) },
          autoResetExpanded: false,
        }}
        visibleRows={Math.max(gefiltert.length + tage.length, 3)}
        noDataText={geladen ? 'Keine Buchungen im Zeitraum' : 'Zeitraum und Konto wählen, dann „Go“'}
      />

      {init && (
        <BankimportDialog open={bank} start={konto} konten={init.konten} bankkonten={init.bankkonten} manuellKonten={init.manuellKonten}
                          rechnungen={liste?.rechnungen ?? []} onClose={() => setBank(false)}
                          onDone={(t, w) => { setOk(t); if (w.length) setError(w.join('\n')); neuLaden(); }} />
      )}
      <BelegeDialog internenr={belege} edit={buchen} onClose={() => setBelege(null)} onChanged={neuLaden} />
      <ZuordnenDialog open={!!zuordnen} ziele={zuordnen ?? []} titel={`Dokumente zuordnen – ${zuordnen?.length ?? 0} Buchung(en) markiert`}
                      onClose={() => setZuordnen(null)} onDone={neuLaden} />
      <StornoDialog zeile={stornoZ} onClose={() => setStornoZ(null)} onDone={(t) => { toast(t); setOk(t); neuLaden(); }} />
      <NotizenDialog zeile={notizZ} onClose={() => setNotizZ(null)} onChanged={neuLaden} />
      <GegenkontoDialog zeile={gkZ} onClose={() => setGkZ(null)} onDone={neuLaden} />
      <ZahlungenDialog open={zahlRg !== undefined} rgnr={zahlRg ?? null} onClose={() => setZahlRg(undefined)} />
    </AppPage>
  );
}
