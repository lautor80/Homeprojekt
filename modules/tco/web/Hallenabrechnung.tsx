import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, BusyIndicator, Button, DateRangePicker, FlexBox, IllustratedMessage, Input, Label, Link, List, ListItemCustom,
  ListItemGroup, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Panel, SegmentedButton, SegmentedButtonItem,
  Select, Switch, Text, Title, Toolbar, ToolbarButton, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import '@ui5/webcomponents-fiori/dist/illustrations/NoData.js';
import '@ui5/webcomponents-fiori/dist/illustrations/SimpleEmptyList.js';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { MenuButton } from '@core/components/MenuButton';
import { PdfDialog } from '@core/components/PdfDialog';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import {
  H, RG_STATE, RG_STATUS, dat, dateiLesen, eur, wtag, zeit,
  type Buchung, type PaperlessInfo, type Person, type PersonDetail, type Position, type Rechnung,
  bidText,
} from './util';
import { AutoDialog, MailDialog, MailtextDialog, PositionDialog, VersionenDialog, WhatsAppDialog, ZahlungenDialog } from './HalleDialoge';

/** Filter bleiben beim Wechsel zwischen Seiten erhalten */
const merk = {
  status: ['1', '2', '3', '5'],
  von: '', bis: '', buchungen: true, suche: '', sort: 'buchungen' as 'buchungen' | 'name' | 'betrag', kunde: null as string | null,
};

type Confirm = { titel: string; text: string; grund?: boolean; danger?: boolean; ok: string; run: (grund: string) => Promise<void> } | null;

export function Hallenabrechnung() {
  const can = useCan();
  const navigate = useNavigate();
  const edit = can('tco.halle:edit');
  const versand = can('tco.halle:versand');
  const [status, setStatus] = useState(merk.status);
  const [von, setVon] = useState(merk.von);
  const [bis, setBis] = useState(merk.bis);
  const [mitBuchungen, setMitBuchungen] = useState(merk.buchungen);
  const [suche, setSuche] = useState(merk.suche);
  const [sort, setSort] = useState(merk.sort);
  const [kunde, setKunde] = useState<string | null>(merk.kunde);
  const [liste, setListe] = useState<{ personen: Person[]; gesamtOffen: number } | null>(null);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [rgnr, setRgnr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Dialoge
  const [pdf, setPdf] = useState<string | null>(null);
  const [posDlg, setPosDlg] = useState(false);
  const [mail, setMail] = useState<string[] | null>(null);
  const [wa, setWa] = useState<string[] | null>(null);
  const [mailtext, setMailtext] = useState<string | null>(null);
  const [zahlungen, setZahlungen] = useState<Rechnung | null>(null);
  const [versionen, setVersionen] = useState<PaperlessInfo | null>(null);
  const [auto, setAuto] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  Object.assign(merk, { status, von, bis, buchungen: mitBuchungen, suche, sort, kunde });
  const selQs = qs({ status: status.join(','), von, bis, buchungen: mitBuchungen ? '1' : '0' });

  const ladeListe = useCallback(async () => {
    try {
      setListe(await api.get(`${H}/personen${selQs}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selQs]);

  const ladeDetail = useCallback(async (k: string | null) => {
    if (!k) { setDetail(null); return; }
    try {
      const d = await api.get<PersonDetail>(`${H}/person${selQs}&kunde=${encodeURIComponent(k)}`);
      setDetail(d);
      setRgnr((alt) => (alt && d.rechnungen.some((r) => r.rgnr_txt === alt) ? alt : d.rechnungen.length === 1 ? d.rechnungen[0].rgnr_txt : null));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selQs]);

  useEffect(() => { ladeListe(); }, [ladeListe]);
  useEffect(() => { ladeDetail(kunde); }, [kunde, ladeDetail]);

  const neuLaden = async () => { await Promise.all([ladeListe(), ladeDetail(kunde)]); };

  /** Aktion mit Meldung und Neuladen */
  const tun = async (fn: () => Promise<{ text?: string; warnungen?: string[] } | void>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && r.text) toast(r.text, 5000);
      if (r && r.warnungen?.length) setError(r.warnungen.join(' · '));
      await neuLaden();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --------------------------------------------------------------- Import
  async function csvImport(files: FileList | null) {
    if (!files?.length) return;
    const texte: string[] = [];
    await tun(async () => {
      for (const f of Array.from(files)) {
        const r = await api.post<{ text: string }>(`${H}/import/datei`, { name: f.name, data: await dateiLesen(f) });
        texte.push(r.text);
      }
      return { text: texte.join(' · ') };
    });
    if (fileRef.current) fileRef.current.value = '';
  }

  const n8nImport = () => tun(async () => {
    const r = await api.post<{ datei: string; ok: boolean; text: string }[]>(`${H}/import/n8n`);
    const fehler = r.filter((x) => !x.ok);
    if (fehler.length) throw new Error(r.map((x) => x.text).join(' · '));
    return { text: r.map((x) => x.text).join(' · ') };
  });

  // --------------------------------------------------------------- Personenliste
  const personen = useMemo(() => {
    const s = suche.trim().toLowerCase();
    const l = (liste?.personen ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.rechnungen.some((r) => r.rgnr_txt.includes(s)));
    const cmp: Record<typeof sort, (a: Person, b: Person) => number> = {
      buchungen: (a, b) => b.offeneBuchungen - a.offeneBuchungen || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      betrag: (a, b) => b.betrag - a.betrag,
    };
    return [...l].sort(cmp[sort]);
  }, [liste, suche, sort]);
  const gruppen = useMemo(() => [...new Set(personen.map((p) => p.gruppe))].sort(), [personen]);

  const rechnung = detail?.rechnungen.find((r) => r.rgnr_txt === rgnr) ?? null;

  const header = (
    <FlexBox wrap="Wrap" alignItems="End" style={{ gap: '1rem 1.5rem' }}>
      <FlexBox direction="Column">
        <Label>Status</Label>
        <MultiComboBox style={{ width: '18rem' }} placeholder="alle"
                       onSelectionChange={(e) => setStatus(e.detail.items.map((i) => (i as HTMLElement).dataset.key!))}>
          {Object.entries(RG_STATUS).map(([k, t]) => <MultiComboBoxItem key={k} data-key={k} text={`${k} – ${t}`} selected={status.includes(k)} />)}
        </MultiComboBox>
      </FlexBox>
      <FlexBox direction="Column">
        <Label>Druckdatum</Label>
        <DateRangePicker style={{ width: '15rem' }} placeholder="alle" formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd"
                         value={von ? `${von} - ${bis || von}` : ''}
                         onChange={(e) => {
                           const [a, b] = (e.detail.value || '').split(' - ');
                           setVon(a || ''); setBis(b || a || '');
                         }} />
      </FlexBox>
      <FlexBox direction="Column">
        <Label>Person / Rechnung</Label>
        <Input style={{ width: '14rem' }} icon={<span />} placeholder="Name oder Nummer" value={suche} onInput={(e) => setSuche(e.target.value)} />
      </FlexBox>
      <FlexBox direction="Column">
        <Label>Offene Buchungen</Label>
        <Switch checked={mitBuchungen} onChange={(e) => setMitBuchungen(e.target.checked)} />
      </FlexBox>
      <FlexBox direction="Column" style={{ marginLeft: 'auto', textAlign: 'right' }}>
        <Label>Gesamt offen</Label>
        <Title level="H4">{eur(liste?.gesamtOffen)}</Title>
      </FlexBox>
    </FlexBox>
  );

  return (
    <AppPage
      title="Hallenabrechnung"
      header={header}
      actions={<>
        {edit && <Button icon="download-from-cloud" onClick={n8nImport}>EP3 importieren</Button>}
        {edit && <Button icon="upload" onClick={() => fileRef.current?.click()}>CSV-Datei</Button>}
        {edit && <Button icon="add-process" onClick={() => setAuto(true)}>Automatisch zuordnen</Button>}
        <Button icon="lead" onClick={() => navigate('/tco/hallenpreise')}>Hallenpreise</Button>
      </>}
    >
      <input ref={fileRef} type="file" accept=".csv,.txt" multiple hidden onChange={(e) => csvImport(e.target.files)} />
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <BusyIndicator active={busy} delay={300} style={{ width: '100%', display: 'block' }}>
        <FlexBox alignItems="Start" style={{ gap: '1rem' }}>
          {/* ------------------------------------------------ Personen */}
          <div style={{ width: '24rem', flexShrink: 0 }}>
            <Toolbar>
              <Title level="H5">Personen ({personen.length})</Title>
              <ToolbarSpacer />
              <SegmentedButton onSelectionChange={(e) => setSort((e.detail.selectedItems[0] as HTMLElement).dataset.key as typeof sort)}>
                <SegmentedButtonItem data-key="buchungen" selected={sort === 'buchungen'}>Buchungen</SegmentedButtonItem>
                <SegmentedButtonItem data-key="name" selected={sort === 'name'}>Name</SegmentedButtonItem>
                <SegmentedButtonItem data-key="betrag" selected={sort === 'betrag'}>Betrag</SegmentedButtonItem>
              </SegmentedButton>
            </Toolbar>
            <List selectionMode="Single" noDataText={liste ? 'Keine Personen in der Selektion' : 'Wird geladen …'}
                  onItemClick={(e) => { setKunde((e.detail.item as HTMLElement).dataset.kunde ?? null); setRgnr(null); }}>
              {gruppen.map((g) => (
                <ListItemGroup key={g} headerText={g}>
                  {personen.filter((p) => p.gruppe === g).map((p) => (
                    <ListItemCustom key={p.kunde} data-kunde={p.kunde} selected={p.kunde === kunde}>
                      <FlexBox justifyContent="SpaceBetween" alignItems="Center" style={{ width: '100%', padding: '0.4rem 0' }}>
                        <FlexBox direction="Column" style={{ minWidth: 0 }}>
                          <Text style={{ fontWeight: 'bold' }}>{p.name}</Text>
                          <Text style={{ fontSize: 'var(--sapFontSmallSize)', color: 'var(--sapContent_LabelColor)' }}>
                            {p.offeneBuchungen} Buchung(en) · {p.rechnungen.length} Rechnung(en)
                            {p.rechnungen.length ? ` · ${p.rechnungen.slice(0, 3).map((r) => r.rgnr_txt).join(', ')}${p.rechnungen.length > 3 ? ' …' : ''}` : ''}
                          </Text>
                        </FlexBox>
                        <Text style={{ whiteSpace: 'nowrap' }}>{eur(p.betrag)}</Text>
                      </FlexBox>
                    </ListItemCustom>
                  ))}
                </ListItemGroup>
              ))}
            </List>
          </div>

          {/* ------------------------------------------------ Detail */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {!detail ? (
              <IllustratedMessage name="SimpleEmptyList" titleText="Keine Person ausgewählt" subtitleText="Links eine Person wählen, um Buchungen und Rechnungen zu bearbeiten." />
            ) : (
              <PersonPanel
                d={detail} rgnr={rgnr} setRgnr={setRgnr} rechnung={rechnung} edit={edit} versand={versand} tun={tun}
                onSchliessen={() => { setKunde(null); setRgnr(null); }}
                onPdf={(nr) => setPdf(nr)} onPosition={() => setPosDlg(true)} onMail={(nrs) => setMail(nrs)} onWa={(nrs) => setWa(nrs)}
                onMailtext={(nr) => setMailtext(nr)} onZahlungen={setZahlungen} onVersionen={setVersionen} onConfirm={setConfirm}
              />
            )}
          </div>
        </FlexBox>
      </BusyIndicator>

      <PdfDialog url={pdf ? `${H}/rechnungen/${encodeURIComponent(pdf)}/pdf` : null} title={`Druckvoransicht Rechnung ${pdf ?? ''}`}
                 filename={`Rechnung_${pdf}.pdf`} onClose={() => setPdf(null)}
                 actions={versand && pdf ? (
                   <Button design="Emphasized" icon="print" onClick={() => {
                     const nr = pdf;
                     setPdf(null);
                     tun(() => api.post(`${H}/rechnungen/${encodeURIComponent(nr)}/drucken`));
                   }}>Drucken und ablegen</Button>
                 ) : undefined} />
      <PositionDialog open={posDlg} rgnr={rgnr} onClose={() => setPosDlg(false)}
                      onSaved={(t) => { setPosDlg(false); toast(t, 5000); neuLaden(); }} />
      <MailDialog rgnrs={mail} detail={detail} onClose={() => setMail(null)} onDone={(t, w) => { setMail(null); toast(t, 5000); if (w?.length) setError(w.join(' · ')); neuLaden(); }} />
      <WhatsAppDialog rgnrs={wa} detail={detail} onClose={() => { setWa(null); neuLaden(); }} onDone={(t) => { setWa(null); toast(t, 5000); neuLaden(); }} />
      <MailtextDialog rgnr={mailtext} onClose={() => setMailtext(null)} />
      <ZahlungenDialog rechnung={zahlungen} onClose={() => setZahlungen(null)} />
      <VersionenDialog info={versionen} onClose={() => setVersionen(null)} />
      <AutoDialog open={auto} onClose={() => setAuto(false)} onDone={(t) => { setAuto(false); toast(t, 6000); neuLaden(); }} />
      <ConfirmDialog open={!!confirm} title={confirm?.titel ?? ''} text={confirm?.text ?? ''} askReason={confirm?.grund}
                     danger={confirm?.danger} confirmText={confirm?.ok}
                     onCancel={() => setConfirm(null)}
                     onConfirm={(grund) => { const c = confirm!; setConfirm(null); tun(() => c.run(grund)); }} />
    </AppPage>
  );
}

// ===========================================================================
// Detailbereich einer Person
// ===========================================================================

function PersonPanel(props: {
  d: PersonDetail; rgnr: string | null; setRgnr: (r: string | null) => void; rechnung: Rechnung | null; edit: boolean; versand: boolean;
  tun: (fn: () => Promise<{ text?: string; warnungen?: string[] } | void>) => Promise<void>;
  onSchliessen: () => void; onPdf: (nr: string) => void; onPosition: () => void; onMail: (nrs: string[]) => void; onWa: (nrs: string[]) => void;
  onMailtext: (nr: string) => void; onZahlungen: (r: Rechnung) => void; onVersionen: (i: PaperlessInfo) => void; onConfirm: (c: Confirm) => void;
}) {
  const { d, rgnr, setRgnr, rechnung, edit, versand, tun } = props;
  const k = d.kontakt;
  const aenderbar = d.rechnungen.filter((r) => r.aenderbar);
  const vergangene = d.buchungen.filter((b) => b.vergangen);
  const [pos, setPos] = useState<Position[] | null>(null);
  const [pl, setPl] = useState<PaperlessInfo | null>(null);
  const [irrelevant, setIrrelevant] = useState<{ bid: string; datum: string; termine: number; time_start: string; time_ende: string }[] | null>(null);

  useEffect(() => {
    setPos(null);
    setPl(null);
    if (!rgnr) return;
    api.get<{ positionen: Position[] }>(`${H}/rechnungen/${encodeURIComponent(rgnr)}`).then((r) => setPos(r.positionen)).catch(() => setPos([]));
    api.get<PaperlessInfo>(`${H}/rechnungen/${encodeURIComponent(rgnr)}/paperless`).then(setPl).catch(() => setPl(null));
  }, [rgnr, d]);

  const post = (url: string, body?: unknown) => () => api.post<{ text: string }>(url, body);
  const rgUrl = (nr: string) => `${H}/rechnungen/${encodeURIComponent(nr)}`;
  const zuordnen = (ziel: string, buchungen: Buchung[]) => tun(async () => {
    const r = await api.post<{ rgnr_txt: string; text: string }>(`${H}/zuordnen`, {
      rgnr: ziel, kunde: d.kunde, buchungen: buchungen.map((b) => ({ bid: b.bid, datum: b.datum })),
    });
    setRgnr(r.rgnr_txt);
    return r;
  });

  const rgMenu = (r: Rechnung) => [
    { text: 'Druckvoransicht', icon: 'show', onClick: () => props.onPdf(r.rgnr_txt) },
    { text: 'Drucken und in Paperless ablegen', icon: 'print', hidden: !versand, onClick: () => tun(post(`${rgUrl(r.rgnr_txt)}/drucken`)) },
    { text: `Per E-Mail senden${d.kanal === 'E' ? ' (bevorzugt)' : ''}`, icon: 'email', hidden: !versand, disabled: !k?.email, onClick: () => props.onMail([r.rgnr_txt]) },
    { text: `Per WhatsApp senden${d.kanal === 'W' ? ' (bevorzugt)' : ''}`, icon: 'discussion', hidden: !versand, disabled: !k?.mobil, onClick: () => props.onWa([r.rgnr_txt]) },
    { text: 'E-Mail-Text anzeigen', icon: 'document-text', onClick: () => props.onMailtext(r.rgnr_txt) },
    { text: 'Als versendet markieren', icon: 'paper-plane', hidden: !edit, disabled: ['3', '4', '6'].includes(r.status), onClick: () => tun(post(`${rgUrl(r.rgnr_txt)}/status`, { aktion: 'versendet' })) },
    {
      text: 'Gezahlt', icon: 'paid-leave', hidden: !edit, disabled: ['4', '6'].includes(r.status),
      onClick: () => props.onConfirm({
        titel: 'Rechnung als gezahlt abschließen', ok: 'Gezahlt',
        text: `Rechnung ${r.rgnr_txt} über ${eur(r.betrag)} als vollständig bezahlt abschließen?${r.offen > 0 && r.gezahlt > 0 ? ` Laut FI-Belegen sind noch ${eur(r.offen)} offen.` : ''}`,
        run: async () => { await post(`${rgUrl(r.rgnr_txt)}/status`, { aktion: 'bezahlt' })(); toast('Rechnung als gezahlt markiert und abgeschlossen'); },
      }),
    },
    {
      text: 'Wieder eröffnen', icon: 'unlocked', hidden: !edit || r.status !== '3',
      onClick: () => props.onConfirm({
        titel: `Rechnung ${r.rgnr_txt} wieder eröffnen`, ok: 'Wieder eröffnen', grund: true,
        text: 'Die versendete Rechnung wird wieder änderbar. Die Begründung wird als Notiz am Paperless-Dokument gespeichert.',
        run: async (grund) => {
          const x = await api.post<{ text: string }>(`${rgUrl(r.rgnr_txt)}/status`, { aktion: 'entsperren', begruendung: grund });
          toast(x.text);
        },
      }),
    },
  ];
  const rgCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Rechnung', accessor: 'rgnr_txt', width: 110, Cell: ({ row }: Cell) => <Text style={{ fontWeight: row.original.rgnr_txt === rgnr ? 'bold' : undefined }}>{row.original.rgnr_txt}</Text> },
    { Header: 'Pos.', accessor: 'anzahl', width: 60, hAlign: 'End' },
    {
      Header: 'Betrag', accessor: 'betrag', width: 150, hAlign: 'End',
      Cell: ({ row }: Cell) => {
        const r = row.original as Rechnung;
        return (
          <FlexBox direction="Column" alignItems="End">
            <Text>{eur(r.betrag)}</Text>
            {r.gezahlt > 0 && (
              <Link onClick={(e) => { e.stopPropagation(); props.onZahlungen(r); }} style={{ fontSize: 'var(--sapFontSmallSize)' }}>
                {r.status === '4' ? 'vollständig gezahlt' : r.betrag - r.gezahlt < 0 ? `überzahlt ${eur(r.gezahlt - r.betrag)}` : `offen ${eur(r.offen)}`}
              </Link>
            )}
          </FlexBox>
        );
      },
    },
    { Header: 'Erstellt', accessor: 'angelegt_am', width: 95, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Gedruckt', accessor: 'gedruckt', width: 95, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Versendet', accessor: 'versendet', width: 95, Cell: ({ value }: Cell) => dat(value) },
    {
      Header: 'Paperless', accessor: 'doknr', width: 90,
      Cell: ({ row }: Cell) => (row.original.doknr ? (
        <Link onClick={async (e) => {
          e.stopPropagation();
          const i = await api.get<PaperlessInfo>(`${rgUrl(row.original.rgnr_txt)}/paperless`);
          if (i.versionen.length <= 1) window.open(`${H}/paperless/${i.versionen[0]?.id ?? row.original.doknr}/pdf`, '_blank');
          else props.onVersionen(i);
        }}>{row.original.doknr}</Link>
      ) : null),
    },
    {
      Header: 'Status', accessor: 'status', width: 140,
      Cell: ({ row }: Cell) => (
        <ObjectStatus state={RG_STATE[row.original.status]}>
          {RG_STATUS[row.original.status]}{row.original.wiedereroeffnet ? ' (wieder eröffnet)' : ''}
        </ObjectStatus>
      ),
    },
    { Header: '', id: 'aktion', width: 60, disableSortBy: true, Cell: ({ row }: Cell) => <MenuButton icon="overflow" design="Transparent" items={rgMenu(row.original)} /> },
  ];

  const posCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Pos.', accessor: 'rgpos', width: 60 },
    { Header: 'Art', accessor: 'art', width: 80 },
    { Header: 'Beschreibung', accessor: 'beschreibung', minWidth: 200, Cell: ({ value }: Cell) => <Text>{String(value).split('\t').filter(Boolean).join(' · ')}</Text> },
    { Header: 'Menge', accessor: 'anzahl', width: 80, hAlign: 'End', Cell: ({ value }: Cell) => Number(value).toLocaleString('de-DE', { maximumFractionDigits: 2 }) },
    { Header: 'Einzelpreis', accessor: 'ep', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    {
      Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End',
      Cell: ({ row }: Cell) => <Text style={{ color: row.original.storno ? 'var(--sapNegativeTextColor)' : undefined }}>{eur(row.original.betrag)}{row.original.storno ? ' (storniert)' : ''}</Text>,
    },
    {
      Header: '', id: 'weg', width: 60, disableSortBy: true,
      Cell: ({ row }: Cell) => (edit && rechnung?.aenderbar ? (
        <Button icon="delete" design="Transparent" onClick={() => {
          const p = row.original as Position;
          const nr = rechnung!.rgnr_txt;
          const loeschen = (grund?: string) => tun(async () => api.del<{ text: string }>(`${rgUrl(nr)}/positionen/${p.rgpos}`, { begruendung: grund }));
          if (rechnung!.wiedereroeffnet) {
            props.onConfirm({
              titel: `Position ${p.rgpos} entfernen`, ok: 'Entfernen', danger: true, grund: true,
              text: 'Die Rechnung war bereits versendet. Die Begründung wird als Notiz am Paperless-Dokument gespeichert.',
              run: async (g) => { const x = await api.del<{ text: string }>(`${rgUrl(nr)}/positionen/${p.rgpos}`, { begruendung: g }); toast(x.text); },
            });
          } else loeschen();
        }} />
      ) : null),
    },
  ];

  const bCols: AnalyticalTableColumnDefinition[] = [
    {
      Header: 'Buchung', accessor: 'bid', width: 120,
      Cell: ({ row }: Cell) => (
        <FlexBox direction="Column">
          <Text>{bidText(row.original.bid)}</Text>
          <ObjectStatus state={row.original.art === 'Abo' ? 'Information' : 'None'}>
            {row.original.art === 'Abo' ? `Abo · ${row.original.termine} Termin(e)` : 'Einzel'}
          </ObjectStatus>
        </FlexBox>
      ),
    },
    {
      Header: 'Termin', accessor: 'datum', minWidth: 190,
      Cell: ({ row }: Cell) => {
        const b = row.original as Buchung;
        return (
          <FlexBox direction="Column">
            <Text>{wtag(b.datum)}, {dat(b.datum)} · {zeit(b.time_start)}–{zeit(b.time_ende)} Uhr</Text>
            {b.text && <Text style={{ fontSize: 'var(--sapFontSmallSize)', color: 'var(--sapContent_LabelColor)' }}>{b.text}</Text>}
          </FlexBox>
        );
      },
    },
    { Header: 'Dauer', accessor: 'dauer', width: 75, hAlign: 'End', Cell: ({ value }: Cell) => `${value} min` },
    {
      Header: 'Betrag', accessor: 'betrag', width: 200, hAlign: 'End',
      Cell: ({ row }: Cell) => (
        <FlexBox direction="Column" alignItems="End">
          <Text>{eur(row.original.betrag)}</Text>
          {row.original.fehler && <Text style={{ color: 'var(--sapNegativeTextColor)', fontSize: 'var(--sapFontSmallSize)', whiteSpace: 'normal', textAlign: 'right' }}>{row.original.fehler}</Text>}
        </FlexBox>
      ),
    },
    {
      Header: 'Zuordnen zu', id: 'ziel', width: 210, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const b = row.original as Buchung;
        if (!edit) return null;
        if (!b.vergangen) return <Text style={{ color: 'var(--sapContent_LabelColor)' }}>erst nach dem Termin</Text>;
        return (
          <Select style={{ width: '100%' }} onChange={(e) => {
            const ziel = (e.detail.selectedOption as HTMLElement).dataset.ziel!;
            if (ziel) zuordnen(ziel, [b]);
          }}>
            <Option data-ziel="" selected>Rechnung wählen …</Option>
            {aenderbar.map((r) => <Option key={r.rgnr_txt} data-ziel={r.rgnr_txt}>{r.rgnr_txt} ({RG_STATUS[r.status]})</Option>)}
            <Option data-ziel="NEU">+ Neue Rechnung anlegen</Option>
          </Select>
        );
      },
    },
    {
      Header: '', id: 'menu', width: 60, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const b = row.original as Buchung;
        const aktion = (a: string) => tun(post(`${H}/buchungen/aktion`, { bid: b.bid, datum: b.datum, aktion: a }));
        return edit ? (
          <MenuButton icon="overflow" design="Transparent" items={[
            { text: 'Abo als Einzelbuchungen abrechnen', hidden: b.art !== 'Abo', onClick: () => aktion('einzel') },
            { text: 'Wieder als Abo-Serie abrechnen', hidden: b.art !== 'Einzel' || b.status !== '1', onClick: () => aktion('serie') },
            {
              text: 'Buchung irrelevant setzen', onClick: () => props.onConfirm({
                titel: 'Buchung irrelevant setzen', ok: 'Irrelevant',
                text: `Buchung ${bidText(b.bid)} (${dat(b.datum)}${b.art === 'Abo' ? ', ganze Abo-Serie' : ''}) wird nicht abgerechnet. Unter „Irrelevante Buchungen“ lässt sie sich wieder öffnen.`,
                run: async () => { const x = await api.post<{ text: string }>(`${H}/buchungen/aktion`, { bid: b.bid, datum: b.datum, aktion: 'irrelevant' }); toast(x.text); },
              }),
            },
          ]} />
        ) : null;
      },
    },
  ];

  const kv = (label: string, wert: React.ReactNode) => (
    <FlexBox direction="Column" style={{ minWidth: '9rem' }}>
      <Label>{label}</Label>
      <div>{wert || <Text>–</Text>}</div>
    </FlexBox>
  );

  return (
    <FlexBox direction="Column" style={{ gap: '1rem' }}>
      {/* Kopf */}
      <Panel fixed header={
        <Toolbar design="Transparent" style={{ width: '100%' }}>
          <Title level="H3">{d.name}</Title>
          <ObjectStatus state={d.offeneRechnungen ? 'Critical' : 'None'}>{d.offeneRechnungen} offene Rechnung(en)</ObjectStatus>
          <ToolbarSpacer />
          {d.adrnr && <Text>Adressnummer {d.adrnr}</Text>}
          <ToolbarButton icon="decline" design="Transparent" onClick={props.onSchliessen} />
        </Toolbar>
      }>
        <FlexBox wrap="Wrap" style={{ gap: '1rem 2rem' }}>
          {kv('Anschrift', k && <Text>{k.strasse}<br />{k.plz} {k.ort}</Text>)}
          {kv('E-Mail', k?.email && <Link href={`mailto:${k.email}`}>{k.email}</Link>)}
          {kv('Telefon', k?.telefon && <Link href={`tel:${k.telefon}`}>{k.telefon}</Link>)}
          {kv('Bevorzugter Versand', k && (
            <SegmentedButton onSelectionChange={(e) => {
              const kanal = (e.detail.selectedItems[0] as HTMLElement).dataset.k;
              if (kanal && edit) tun(post(`${H}/kanal`, { adrnr: k.adrnr, kanal }));
            }}>
              <SegmentedButtonItem data-k="E" disabled={!k.email || !edit} selected={d.kanal === 'E'}>E-Mail</SegmentedButtonItem>
              <SegmentedButtonItem data-k="W" disabled={!k.mobil || !edit} selected={d.kanal === 'W'}>WhatsApp</SegmentedButtonItem>
            </SegmentedButton>
          ))}
          {kv('Offene Buchungen', <Text>{d.buchungen.length} · {eur(d.betragBuchungen)}</Text>)}
          {kv('Offene Rechnungen', <Text>{eur(d.offenRechnungen)}{d.gezahlt ? ` (bereits gezahlt ${eur(d.gezahlt)})` : ''}</Text>)}
          {kv('Gesamtbetrag', <Text style={{ fontWeight: 'bold' }}>{eur(d.offenRechnungen + d.betragBuchungen)}</Text>)}
        </FlexBox>
        {!k && <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.75rem' }}>
          Zum EP3-Namen „{d.kunde}“ gibt es kein Mitglied und keinen EP3-Kunden. Für den Druck braucht die Rechnung eine Anschrift.
        </MessageStrip>}
      </Panel>

      {/* Rechnungen */}
      <Panel fixed header={
        <Toolbar design="Transparent" style={{ width: '100%' }}>
          <Title level="H5">Rechnungen ({d.rechnungen.length})</Title>
          <ToolbarSpacer />
          {versand && d.rechnungen.filter((r) => !['4', '6'].includes(r.status)).length > 1 && (
            <ToolbarButton icon="email" text="Alle offenen per E-Mail" disabled={!k?.email}
                           onClick={() => props.onMail(d.rechnungen.filter((r) => !['4', '6'].includes(r.status)).map((r) => r.rgnr_txt))} />
          )}
          {edit && <ToolbarButton icon="add" text="Anlegen" onClick={() => tun(async () => {
            const r = await api.post<{ rgnr_txt: string }>(`${H}/rechnungen`, { kunde: d.kunde });
            setRgnr(r.rgnr_txt);
            return { text: `Rechnung ${r.rgnr_txt} angelegt` };
          })} />}
        </Toolbar>
      }>
        <AnalyticalTable columns={rgCols} data={d.rechnungen} visibleRows={Math.max(d.rechnungen.length, 1)} rowHeight={48}
                         noDataText="Keine Rechnungen in der Selektion" sortable
                         onRowClick={(e) => setRgnr(e.detail.row.original.rgnr_txt)} />
      </Panel>

      {/* Positionen */}
      {rechnung && (
        <Panel fixed header={
          <Toolbar design="Transparent" style={{ width: '100%' }}>
            <Title level="H5">Positionen zu {rechnung.rgnr_txt} ({pos?.length ?? 0})</Title>
            <ObjectStatus state={RG_STATE[rechnung.status]}>{RG_STATUS[rechnung.status]}</ObjectStatus>
            <ToolbarSpacer />
            {edit && rechnung.aenderbar && <ToolbarButton icon="add" text="Position hinzufügen" onClick={props.onPosition} />}
            {edit && rechnung.aenderbar && (pos?.length ?? 0) > 1 && <ToolbarButton icon="sort" text="Neu nummerieren" onClick={() => tun(post(`${rgUrl(rechnung.rgnr_txt)}/nummerieren`))} />}
            <ChangeHistoryButton objectType="RECHNUNG" objectKey={rechnung.rgnr_txt} />
          </Toolbar>
        }>
          {!rechnung.aenderbar && <MessageStrip hideCloseButton style={{ marginBottom: '0.5rem' }}>
            Die Rechnung ist {RG_STATUS[rechnung.status].toLowerCase()} und nimmt keine Positionen mehr auf.{rechnung.status === '3' ? ' Über das Menü „Wieder eröffnen“ wird sie änderbar.' : ''}
          </MessageStrip>}
          <AnalyticalTable columns={posCols} data={pos ?? []} loading={!pos} visibleRows={Math.max(pos?.length ?? 1, 1)}
                           noDataText="Keine Positionen" />
          {pl && (pl.doknr || pl.fehler) && (
            <FlexBox wrap="Wrap" style={{ gap: '1rem 2rem', marginTop: '0.75rem' }}>
              {pl.fehler && <MessageStrip design="Critical" hideCloseButton>{pl.fehler}</MessageStrip>}
              {pl.link && kv('Paperless-Freigabelink (30 Tage)', <Link href={pl.link} target="_blank">{pl.link}</Link>)}
              {pl.ansicht && kv('Paperless-Dokument', <Link href={pl.ansicht} target="_blank">Dokument {pl.doknr} öffnen{pl.versionen.length > 1 ? ` (${pl.versionen.length} Fassungen)` : ''}</Link>)}
              {pl.notizen.length > 0 && kv('Paperless-Notizen', (
                <FlexBox direction="Column">
                  {pl.notizen.slice(0, 6).map((n) => <Text key={n.id} style={{ fontSize: 'var(--sapFontSmallSize)' }}>{dat(n.created)} · {n.note}</Text>)}
                </FlexBox>
              ))}
            </FlexBox>
          )}
        </Panel>
      )}

      {/* Offene Buchungen */}
      <Panel fixed header={
        <Toolbar design="Transparent" style={{ width: '100%' }}>
          <Title level="H5">Offene Buchungen ({d.buchungen.length})</Title>
          <ToolbarSpacer />
          {edit && vergangene.length > 0 && (
            <ToolbarButton icon="add-process" design="Emphasized"
                           text={rechnung?.aenderbar ? `Vergangene zu ${rechnung.rgnr_txt} (${vergangene.length})` : `Vergangene auf neue Rechnung (${vergangene.length})`}
                           onClick={() => zuordnen(rechnung?.aenderbar ? rechnung.rgnr_txt : 'NEU', vergangene)} />
          )}
        </Toolbar>
      }>
        <AnalyticalTable columns={bCols} data={d.buchungen} visibleRows={Math.max(d.buchungen.length, 1)} rowHeight={56}
                         noDataText="Keine offenen Buchungen" sortable />
      </Panel>

      {/* Irrelevante Buchungen */}
      <Panel collapsed headerText="Irrelevant gesetzte Buchungen"
             onToggle={(e) => { if (!(e.target as unknown as { collapsed: boolean }).collapsed && !irrelevant) api.get<typeof irrelevant>(`${H}/irrelevant?kunde=${encodeURIComponent(d.kunde)}`).then(setIrrelevant); }}>
        {(irrelevant ?? []).length === 0 ? <Text>Keine</Text> : (irrelevant ?? []).map((b) => (
          <FlexBox key={b.bid} alignItems="Center" style={{ gap: '1rem' }}>
            <Text>{bidText(b.bid)} · {dat(b.datum)} {zeit(b.time_start)}–{zeit(b.time_ende)} Uhr{b.termine > 1 ? ` · ${b.termine} Termine` : ''}</Text>
            {edit && <Button design="Transparent" icon="undo" onClick={() => tun(async () => {
              const r = await api.post<{ text: string }>(`${H}/buchungen/aktion`, { bid: b.bid, datum: b.datum, aktion: 'relevant' });
              setIrrelevant(null);
              return r;
            })}>Wieder offen</Button>}
          </FlexBox>
        ))}
      </Panel>
    </FlexBox>
  );
}
