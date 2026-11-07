import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Button, DatePicker, FileUploader, FlexBox, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, Select, Tab, TabContainer, Text, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { PdfDialog } from '@core/components/PdfDialog';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat, dateiLesen, eur } from '../util';
import { Entgelte } from './Entgelte';

export const J = `${TCO}/jt`;
type State = 'None' | 'Information' | 'Critical' | 'Positive' | 'Negative';

interface Trainer { adrnr: string; name: string; steuernummer: string; satz: number | null }
interface Zeit { adrnr: string; datum: string; trainingsart: string; anzahl: number; satz: number; betrag: number }
interface Ferientag { datum: string; ferien: string | null; feiertag: string | null }
interface Abr {
  adrnr: string; trainer: string; stunden: number; betrag: number; satz: number | null; status: string; state: State;
  doc_id: number | null; belegnr: string | null; bezahlt_am: string | null; bezahlbar: boolean; mobil: boolean;
}
interface Monat {
  monat: string; titel: string; von: string; bis: string; arten: string[]; trainer: Trainer[]; zeiten: Zeit[]; ferien: Ferientag[];
  ferienJahr: { ferien: number; feiertage: number }; ferienFehler: string | null; abrechnung: Abr[]; paperless: boolean;
}
interface ImportErg { prot: { datum: string; trainer: string; anzahl: string; ergebnis: string; state: State }[]; text: string; state: State; ungueltig?: number }

const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WT_LANG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const zahl = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
const isoHeute = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addTage = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wtIdx = (iso: string) => (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7;
function kw(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - wtIdx(iso));
  const j = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - j.getTime()) / 86_400_000 - 3 + ((j.getUTCDay() + 6) % 7)) / 7);
}
function monatVerschieben(m: string, n: number) {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(4, 6)) - 1 + n, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const aktMonat = () => isoHeute().slice(0, 7).replace('-', '');

export function Jugendtraining() {
  const can = useCan();
  const edit = can('tco.jt:edit');
  const [monat, setMonat] = useState(aktMonat);
  const [m, setM] = useState<Monat | null>(null);
  const [adrnr, setAdrnr] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState('zeiten');
  const [error, setError] = useState<string | null>(null);
  const [imp, setImp] = useState<ImportErg | null>(null);

  const laden = (mon = monat) => api.get<Monat>(`${J}/monat?monat=${mon}`).then((r) => {
    setM(r);
    setAdrnr((a) => (a && r.abrechnung.some((x) => x.adrnr === a) ? a : r.trainer[0]?.adrnr ?? r.abrechnung[0]?.adrnr ?? ''));
  }).catch((e) => setError(e.message));
  useEffect(() => { setM(null); setImp(null); setSel(null); laden(monat); }, [monat]); // eslint-disable-line react-hooks/exhaustive-deps

  const zeiten = useMemo(() => (m?.zeiten ?? []).filter((z) => z.adrnr === adrnr), [m, adrnr]);
  const ferien = useMemo(() => new Map((m?.ferien ?? []).map((f) => [f.datum, f])), [m]);
  const abr = m?.abrechnung.find((a) => a.adrnr === adrnr);
  const summe = { std: zeiten.reduce((s, z) => s + z.anzahl, 0), eur: zeiten.reduce((s, z) => s + z.betrag, 0) };

  async function aktion(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); await laden(); } catch (e) { setError((e as Error).message); }
  }
  const setzen = (z: { datum: string; trainingsart: string; anzahl: number; altArt?: string }) =>
    aktion(() => api.post(`${J}/zeiten`, { adrnr, ...z }));
  const loeschen = (z: Zeit) => aktion(() => api.post(`${J}/zeiten/loeschen`, { adrnr, datum: z.datum, trainingsart: z.trainingsart }));

  function tagWaehlen(d: string) {
    setSel(d);
    setTab('zeiten');
    const f = ferien.get(d);
    if (f?.ferien) toast(`${dat(d)} liegt in den ${f.ferien}.`);
    if (f?.feiertag) toast(`${dat(d)} ist ein Feiertag: ${f.feiertag}.`);
    if (edit && adrnr && !zeiten.some((z) => z.datum === d)) setzen({ datum: d, trainingsart: 'Jugendtraining', anzahl: 0 });
  }

  const trainerOptionen = m?.abrechnung ?? [];
  return (
    <AppPage title="Abrechnung Jugendtraining"
             subtitle={abr ? `${abr.trainer} · ${zahl(summe.std)} Stunden · ${eur(summe.eur)}` : 'Trainingszeiten der Honorartrainer erfassen und abrechnen'}
             actions={<>
               <Button icon="navigation-left-arrow" design="Transparent" onClick={() => setMonat(monatVerschieben(monat, -1))} />
               <DatePicker formatPattern="MMMM yyyy" valueFormat="yyyyMM" value={monat} style={{ width: '11rem' }}
                           onChange={(e) => e.detail.value && setMonat(e.detail.value)} />
               <Button icon="navigation-right-arrow" design="Transparent" onClick={() => setMonat(monatVerschieben(monat, 1))} />
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {m && (
        <FlexBox wrap="Wrap" alignItems="Start" style={{ gap: '2rem', marginBottom: '1rem' }}>
          <Kalender m={m} zeiten={zeiten} ferien={ferien} sel={sel} onTag={tagWaehlen} />
          <Legende />
          <FlexBox direction="Column" style={{ gap: '0.25rem' }}>
            <Label>Trainer</Label>
            <Select style={{ width: '16rem' }} onChange={(e) => setAdrnr((e.detail.selectedOption as HTMLElement).dataset.k!)}>
              {!trainerOptionen.length && <Option data-k="">Kein Trainer angelegt</Option>}
              {trainerOptionen.map((t) => <Option key={t.adrnr} data-k={t.adrnr} selected={t.adrnr === adrnr}>{t.trainer}</Option>)}
            </Select>
            {abr && abr.satz !== null && <Text style={{ marginTop: '0.5rem' }}>Aktuelles Entgelt {eur(abr.satz)} je Stunde</Text>}
            {abr && abr.satz === null && m.trainer.some((t) => t.adrnr === adrnr) && <ObjectStatus state="Critical">Kein gültiges Entgelt – siehe „Entgelte“</ObjectStatus>}
          </FlexBox>
        </FlexBox>
      )}
      {m && (
        <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
          <Tab data-key="zeiten" text="Zeiten" additionalText={String(zeiten.length)} icon="list" selected={tab === 'zeiten'}>
            <Zeiten m={m} zeiten={zeiten} ferien={ferien} sel={sel} edit={edit && !!adrnr} onSetzen={setzen} onLoeschen={loeschen}
                    onNeu={() => tagWaehlen(sel ?? (isoHeute() >= m.von && isoHeute() <= m.bis ? isoHeute() : m.von))} />
          </Tab>
          <Tab data-key="woche" text="Wochenraster" icon="grid" selected={tab === 'woche'}>
            <Woche m={m} zeiten={zeiten} ferien={ferien} edit={edit && !!adrnr} adrnr={adrnr} onSetzen={setzen} onLoeschen={loeschen} onAktion={aktion} />
          </Tab>
          <Tab data-key="import" text="Import" icon="upload" selected={tab === 'import'}>
            <Import m={m} edit={edit} erg={imp} onErg={(r) => { setImp(r); laden(); }} onError={setError} onAktion={aktion} />
          </Tab>
          <Tab data-key="abr" text="Abrechnung" icon="receipt" selected={tab === 'abr'}>
            <Abrechnung m={m} edit={edit} onAktion={aktion} onError={setError} />
          </Tab>
          <Tab data-key="ent" text="Entgelte" icon="money-bills" selected={tab === 'ent'}>
            <Entgelte onChanged={() => laden()} />
          </Tab>
        </TabContainer>
      )}
    </AppPage>
  );
}

// ---------------------------------------------------------------- Kalender
function zelle(zeiten: Zeit[], d: string): { bg: string; fg: string; rand: string } {
  const z = zeiten.filter((x) => x.datum === d);
  if (z.length && z.some((x) => x.anzahl > 0)) return { bg: 'var(--sapSuccessBackground)', fg: 'var(--sapPositiveTextColor)', rand: 'var(--sapPositiveElementColor)' };
  if (z.length) return { bg: 'var(--sapWarningBackground)', fg: 'var(--sapCriticalTextColor)', rand: 'var(--sapCriticalElementColor)' };
  if (d === isoHeute()) return { bg: 'var(--sapInformationBackground)', fg: 'var(--sapInformativeTextColor)', rand: 'var(--sapInformativeElementColor)' };
  return { bg: 'transparent', fg: 'var(--sapTextColor)', rand: 'var(--sapList_BorderColor)' };
}

function Kalender({ m, zeiten, ferien, sel, onTag }: { m: Monat; zeiten: Zeit[]; ferien: Map<string, Ferientag>; sel: string | null; onTag: (d: string) => void }) {
  const wochen: string[] = [];
  for (let d = addTage(m.von, -wtIdx(m.von)); d <= m.bis; d = addTage(d, 7)) wochen.push(d);
  const zelleStil = { width: '2.4rem', height: '2.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' } as const;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 2.4rem)', gap: '0.25rem' }}>
      {['KW', ...WT].map((t) => <Label key={t} style={{ ...zelleStil, height: '1.2rem' }}>{t}</Label>)}
      {wochen.flatMap((mo) => [
        <Label key={`kw${mo}`} style={zelleStil}>{kw(mo)}</Label>,
        ...WT.map((_, i) => {
          const d = addTage(mo, i);
          if (d < m.von || d > m.bis) return <div key={d} style={zelleStil} />;
          const f = ferien.get(d);
          const c = zelle(zeiten, d);
          const markiert = c.bg === 'transparent' && (f?.feiertag ? 'rgba(214,0,0,.12)' : f?.ferien ? 'rgba(139,71,215,.14)' : null);
          return (
            <div key={d} role="button" tabIndex={0} onClick={() => onTag(d)} onKeyDown={(e) => e.key === 'Enter' && onTag(d)}
                 style={{
                   ...zelleStil, cursor: 'pointer', borderRadius: '0.5rem', fontSize: '0.875rem',
                   background: markiert || c.bg, color: c.fg, border: `1px solid ${c.rand}`,
                   boxShadow: [f?.feiertag ? 'inset 0 -0.1875rem 0 var(--sapIndicationColor_1)' : f?.ferien ? 'inset 0 -0.1875rem 0 var(--sapIndicationColor_7)' : '',
                     sel === d ? '0 0 0 2px var(--sapContent_FocusColor)' : ''].filter(Boolean).join(', ') || 'none',
                 }}>
              {Number(d.slice(8, 10))}
            </div>
          );
        }),
      ])}
    </div>
  );
}

function Legende() {
  return (
    <FlexBox direction="Column" style={{ gap: '0.3rem' }}>
      <ObjectStatus state="Positive">Stunden erfasst</ObjectStatus>
      <ObjectStatus state="Critical">Erfasst, ohne Dauer</ObjectStatus>
      <ObjectStatus state="Information">Heute</ObjectStatus>
      <ObjectStatus state="None">Kein Trainingstag</ObjectStatus>
      <ObjectStatus state="Indication07">Schulferien</ObjectStatus>
      <ObjectStatus state="Indication01">Feiertag</ObjectStatus>
    </FlexBox>
  );
}

// ---------------------------------------------------------------- Zeiten
function DauerInput({ wert, disabled, onSave, width = '6rem', hervor, placeholder = 'Std.' }: { wert: number; disabled?: boolean; onSave: (v: number | null) => void; width?: string; hervor?: boolean; placeholder?: string }) {
  const [v, setV] = useState(wert ? String(wert).replace('.', ',') : '');
  useEffect(() => { setV(wert ? String(wert).replace('.', ',') : ''); }, [wert]);
  const speichern = () => {
    const t = v.trim();
    const n = t === '' ? null : Number(t.replace(',', '.'));
    if (n === (wert || null)) return;
    if (n !== null && !Number.isFinite(n)) { setV(wert ? String(wert) : ''); return; }
    onSave(n);
  };
  return <Input value={v} disabled={disabled} style={{ width, textAlign: 'end', ...(hervor ? { boxShadow: 'inset 0 -0.1875rem 0 var(--sapIndicationColor_7)' } : {}) }}
                onInput={(e) => setV(e.target.value)} onChange={speichern} onKeyDown={(e) => e.key === 'Enter' && speichern()} placeholder={placeholder} />;
}

function Zeiten({ m, zeiten, ferien, sel, edit, onSetzen, onLoeschen, onNeu }: {
  m: Monat; zeiten: Zeit[]; ferien: Map<string, Ferientag>; sel: string | null; edit: boolean;
  onSetzen: (z: { datum: string; trainingsart: string; anzahl: number; altArt?: string }) => void; onLoeschen: (z: Zeit) => void; onNeu: () => void;
}) {
  const nFer = zeiten.filter((z) => ferien.get(z.datum)?.ferien).length;
  const nFtg = zeiten.filter((z) => ferien.get(z.datum)?.feiertag).length;
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Datum', accessor: 'datum', width: 130, Cell: ({ value }: Cell) => <Text style={{ fontWeight: value === sel ? 'bold' : undefined }}>{dat(value)}</Text> },
    { Header: 'Wochentag', id: 'wt', width: 110, accessor: (z: Record<string, any>) => WT_LANG[wtIdx(z.datum)] },
    { Header: 'Schulferien', id: 'fer', width: 150, accessor: (z: Record<string, any>) => ferien.get(z.datum)?.ferien ?? '', Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Critical">{value}</ObjectStatus> : '') },
    { Header: 'Feiertag', id: 'ftg', width: 190, accessor: (z: Record<string, any>) => ferien.get(z.datum)?.feiertag ?? '', Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Negative">{value}</ObjectStatus> : '') },
    {
      Header: 'Trainingsart', accessor: 'trainingsart', width: 210,
      Cell: ({ row }: Cell) => (
        <Select disabled={!edit} style={{ width: '12rem' }}
                onChange={(e) => onSetzen({ datum: row.original.datum, trainingsart: (e.detail.selectedOption as HTMLElement).dataset.k!, anzahl: row.original.anzahl, altArt: row.original.trainingsart })}>
          {m.arten.map((a) => <Option key={a} data-k={a} selected={a === row.original.trainingsart}>{a}</Option>)}
        </Select>
      ),
    },
    {
      Header: 'Dauer (Std.)', accessor: 'anzahl', width: 120, hAlign: 'End',
      Cell: ({ row }: Cell) => <DauerInput wert={row.original.anzahl} disabled={!edit}
                                           onSave={(v) => onSetzen({ datum: row.original.datum, trainingsart: row.original.trainingsart, anzahl: v ?? 0 })} />,
    },
    { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ row }: Cell) => (row.original.anzahl ? eur(row.original.betrag) : '') },
    { Header: '€/Std.', accessor: 'satz', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => (value ? eur(value) : <ObjectStatus state="Negative">fehlt</ObjectStatus>) },
    { Header: '', id: 'del', width: 60, disableSortBy: true, Cell: ({ row }: Cell) => (edit ? <Button icon="delete" design="Transparent" onClick={() => onLoeschen(row.original)} /> : null) },
  ];
  return (
    <>
      {(m.ferienFehler || nFer > 0 || nFtg > 0) && (
        <MessageStrip design={m.ferienFehler ? 'Negative' : 'Critical'} hideCloseButton style={{ marginBottom: '0.5rem' }}>
          {m.ferienFehler ? `Schulferien konnten nicht geprüft werden: ${m.ferienFehler}` : `Rückmeldungen in den Schulferien: ${nFer}, an Feiertagen: ${nFtg} – bitte prüfen.`}
        </MessageStrip>
      )}
      <Toolbar design="Transparent">
        <Title level="H5">Trainingszeiten</Title>
        <ToolbarSpacer />
        {edit && <Button icon="add" design="Transparent" onClick={onNeu}>Neue Position{sel ? ` (${dat(sel)})` : ''}</Button>}
      </Toolbar>
      <AnalyticalTable columns={columns} data={zeiten} visibleRows={Math.max(zeiten.length, 3)} noDataText="Keine Trainingszeiten im Monat – im Kalender einen Tag wählen oder importieren"
                       withRowHighlight highlightField={(r: Record<string, any>) => (r.datum === sel ? 'Information' : r.anzahl ? 'None' : 'Critical')} />
    </>
  );
}

// ---------------------------------------------------------------- Wochenraster
function Woche({ m, zeiten, ferien, edit, adrnr, onSetzen, onLoeschen, onAktion }: {
  m: Monat; zeiten: Zeit[]; ferien: Map<string, Ferientag>; edit: boolean; adrnr: string;
  onSetzen: (z: { datum: string; trainingsart: string; anzahl: number }) => void; onLoeschen: (z: Zeit) => void; onAktion: (fn: () => Promise<unknown>) => void;
}) {
  const wochen: string[] = [];
  for (let d = addTage(m.von, -wtIdx(m.von)); d <= m.bis; d = addTage(d, 7)) wochen.push(d);
  const start = isoHeute() >= m.von && isoHeute() <= m.bis ? isoHeute() : zeiten[0]?.datum ?? m.von;
  const [w, setW] = useState(() => Math.max(0, wochen.findIndex((x) => start >= x && start <= addTage(x, 6))));
  const [wtage, setWtage] = useState<number[]>([]);
  const [art, setArt] = useState('Jugendtraining');
  const mo = wochen[Math.min(w, wochen.length - 1)];
  const tage = WT.map((_, i) => addTage(mo, i));
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Trainingsart', accessor: 'art', width: 190 },
    ...tage.map((d, i) => ({
      Header: () => <span style={ferien.get(d)?.ferien ? { boxShadow: 'inset 0 -0.1875rem 0 var(--sapIndicationColor_7)', paddingBottom: 2 } : undefined}>
        {WT[i]} {d.slice(8, 10)}.{d.slice(5, 7)}.</span>,
      id: d, width: 100, hAlign: 'End' as const,
      Cell: ({ row }: Cell) => {
        const z = zeiten.find((x) => x.datum === d && x.trainingsart === row.original.art);
        const ausserhalb = d < m.von || d > m.bis;
        return <DauerInput wert={z?.anzahl ?? 0} disabled={!edit || ausserhalb} width="5rem" placeholder="" hervor={!!ferien.get(d)?.ferien}
                           onSave={(v) => (v === null ? z && onLoeschen(z) : onSetzen({ datum: d, trainingsart: row.original.art, anzahl: v }))} />;
      },
    })),
  ];
  return (
    <>
      <Toolbar design="Transparent">
        <Button icon="navigation-left-arrow" design="Transparent" disabled={w === 0} onClick={() => setW(w - 1)} />
        <Title level="H5">KW {kw(mo)}: {dat(mo)} bis {dat(addTage(mo, 6))}</Title>
        <Button icon="navigation-right-arrow" design="Transparent" disabled={w >= wochen.length - 1} onClick={() => setW(w + 1)} />
        <ToolbarSpacer />
        {edit && <>
          <MultiComboBox placeholder="Wochentage" style={{ width: '16rem' }}
                         onSelectionChange={(e) => setWtage(e.detail.items.map((x) => Number((x as HTMLElement).dataset.k)))}>
            {WT_LANG.map((t, i) => <MultiComboBoxItem key={t} data-k={i + 1} text={t} selected={wtage.includes(i + 1)} />)}
          </MultiComboBox>
          <Select style={{ width: '12rem' }} onChange={(e) => setArt((e.detail.selectedOption as HTMLElement).dataset.k!)}>
            {m.arten.map((a) => <Option key={a} data-k={a} selected={a === art}>{a}</Option>)}
          </Select>
          <Button icon="add" disabled={!wtage.length} onClick={() => onAktion(async () => {
            toast((await api.post<{ text: string }>(`${J}/zeiten/generieren`, { adrnr, monat: m.monat, wochentage: wtage, trainingsart: art })).text);
          })}>Trainingstage generieren</Button>
        </>}
      </Toolbar>
      <AnalyticalTable columns={columns} data={m.arten.map((a) => ({ art: a }))} visibleRows={m.arten.length} />
    </>
  );
}

// ---------------------------------------------------------------- Import
function Import({ m, edit, erg, onErg, onError, onAktion }: {
  m: Monat; edit: boolean; erg: ImportErg | null; onErg: (r: ImportErg) => void; onError: (t: string) => void; onAktion: (fn: () => Promise<unknown>) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  async function lauf(art: string, fn: () => Promise<ImportErg>) {
    setBusy(art);
    try {
      const r = await fn();
      onErg(r);
      if (r.ungueltig) toast(`${r.ungueltig} Rückmeldung(en) in Nextcloud mit unlesbarer Stundenangabe – bitte dort prüfen.`, 6000);
    } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  }
  const jahr = Number(m.monat.slice(0, 4));
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Datum', accessor: 'datum', width: 110, Cell: ({ value }: Cell) => dat(value) || '–' },
    { Header: 'Trainer', accessor: 'trainer', minWidth: 180 },
    { Header: 'Stunden', accessor: 'anzahl', width: 100, hAlign: 'End' },
    { Header: 'Ergebnis', accessor: 'ergebnis', minWidth: 240, Cell: ({ row }: Cell) => <ObjectStatus state={row.original.state}>{row.original.ergebnis}</ObjectStatus> },
  ];
  return (
    <>
      <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Übernommen werden ausschließlich Rückmeldungen mit einem Datum zwischen {dat(m.von)} und {dat(m.bis)}. Für einen anderen Monat zuerst oben den Monat wechseln.
      </MessageStrip>
      <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.75rem', marginBottom: '0.75rem' }}>
        {edit && <Button design="Emphasized" icon="download-from-cloud" loading={busy === 'nc'}
                         onClick={() => lauf('nc', () => api.post(`${J}/import/nextcloud`, { monat: m.monat }))}>Aus Nextcloud laden</Button>}
        {edit && (
          <FileUploader hideInput accept=".csv,text/csv" onChange={(e) => {
            const f = e.detail.files?.[0];
            if (f) lauf('csv', async () => api.post(`${J}/import`, { monat: m.monat, csv: await dateiLesen(f) }));
          }}>
            <Button icon="attachment" loading={busy === 'csv'}>CSV-Datei laden</Button>
          </FileUploader>
        )}
        {edit && <Button icon="synchronize" onClick={() => onAktion(async () => toast((await api.post<{ text: string }>(`${J}/ferien`, { jahr })).text))}>Ferien synchronisieren</Button>}
        <Text>{m.ferienFehler ? `Schulferien ${jahr}: nicht geladen` : `Schulferien ${jahr}: ${m.ferienJahr.ferien} Ferientage, ${m.ferienJahr.feiertage} Feiertage`}</Text>
      </FlexBox>
      {erg && <>
        <MessageStrip design={erg.state === 'None' ? 'Information' : erg.state} hideCloseButton style={{ marginBottom: '0.5rem' }}>{erg.text}</MessageStrip>
        <Title level="H5" style={{ margin: '0.5rem 0' }}>Importprotokoll</Title>
        <AnalyticalTable columns={columns} data={erg.prot} visibleRows={Math.max(erg.prot.length, 1)} noDataText="Keine Rückmeldungen im Monat" />
      </>}
    </>
  );
}

// ---------------------------------------------------------------- Abrechnung
function Abrechnung({ m, edit, onAktion, onError }: { m: Monat; edit: boolean; onAktion: (fn: () => Promise<unknown>) => void; onError: (t: string) => void }) {
  const [pdf, setPdf] = useState<{ url: string; titel: string; ablage?: string } | null>(null);
  const [zahl, setZahl] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const q = (a: string) => `adrnr=${a}&monat=${m.monat}`;
  async function ablegen(a: string) {
    setBusy(true);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${J}/nachweis/ablegen`, { adrnr: a, monat: m.monat });
      toast(r.text, 5000);
      if (r.warnungen.length) onError(r.warnungen.join('\n'));
      setPdf(null);
      onAktion(async () => undefined);
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  async function whatsapp(a: string) {
    const win = window.open('about:blank', '_blank');
    try {
      const r = await api.post<{ url: string }>(`${J}/nachweis/whatsapp`, { adrnr: a, monat: m.monat });
      if (win) win.location.href = r.url; else window.open(r.url, '_blank');
    } catch (e) { win?.close(); onError((e as Error).message); }
  }
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Trainer', accessor: 'trainer', minWidth: 170, Cell: ({ value }: Cell) => <Text style={{ fontWeight: 'bold' }}>{value}</Text> },
    { Header: 'Stunden', accessor: 'stunden', width: 90, hAlign: 'End', Cell: ({ value }: Cell) => value.toLocaleString('de-DE') },
    { Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Beleg', accessor: 'status', minWidth: 260, Cell: ({ row }: Cell) => <ObjectStatus state={row.original.state}>{row.original.status}</ObjectStatus> },
    {
      Header: 'Zeitnachweis', id: 'akt', width: 330, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const a: Abr = row.original;
        return (
          <FlexBox alignItems="Center" style={{ gap: '0.25rem' }}>
            <Button icon="print" design="Transparent" disabled={!a.stunden} onClick={() => setPdf({ url: `${J}/nachweis/pdf?${q(a.adrnr)}`, titel: `Zeitnachweis ${a.trainer} – ${m.titel}`, ablage: a.adrnr })}>Drucken</Button>
            <Button icon="attachment" design="Transparent" disabled={!a.doc_id} onClick={() => setPdf({ url: `${J}/nachweis/dokument?${q(a.adrnr)}`, titel: `${a.belegnr} (abgelegt)` })}>Beleg</Button>
            {edit && <Button icon="discussion" design="Transparent" disabled={!a.doc_id || !a.mobil} onClick={() => whatsapp(a.adrnr)}>WhatsApp</Button>}
          </FlexBox>
        );
      },
    },
    {
      Header: 'Bezahlt', id: 'bez', width: 270, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const a: Abr = row.original;
        if (a.bezahlt_am) return <ObjectStatus state="Positive" showDefaultIcon>{dat(a.bezahlt_am)}</ObjectStatus>;
        if (!edit) return null;
        return (
          <FlexBox alignItems="Center" style={{ gap: '0.25rem' }}>
            <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={zahl[a.adrnr] ?? isoHeute()} style={{ width: '9rem' }} disabled={!a.bezahlbar || !m.paperless}
                        onChange={(e) => setZahl({ ...zahl, [a.adrnr]: e.detail.value })} />
            <Button icon="paid-leave" design="Transparent" disabled={!a.bezahlbar || !m.paperless}
                    onClick={() => onAktion(async () => {
                      const r = await api.post<{ text: string; warnungen: string[] }>(`${J}/nachweis/bezahlt`, { adrnr: a.adrnr, monat: m.monat, datum: zahl[a.adrnr] ?? isoHeute() });
                      toast(r.text, 6000);
                    })}>Bezahlt</Button>
          </FlexBox>
        );
      },
    },
  ];
  return (
    <>
      {!m.paperless && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Paperless ist nicht eingerichtet – Zeitnachweise können nur angezeigt, aber nicht abgelegt oder als bezahlt gekennzeichnet werden.</MessageStrip>}
      <Toolbar design="Transparent">
        <Title level="H5">Trainerübersicht {m.titel}</Title>
        <ToolbarSpacer />
      </Toolbar>
      <AnalyticalTable columns={columns} data={m.abrechnung} visibleRows={Math.max(m.abrechnung.length, 3)} noDataText="Keine Trainer mit Trainer-Kennzeichen – siehe „Entgelte“" />
      <PdfDialog url={pdf?.url ?? null} title={pdf?.titel ?? ''} filename={`${pdf?.titel ?? 'Zeitnachweis'}.pdf`} onClose={() => setPdf(null)}
                 actions={edit && pdf?.ablage && m.paperless && <Button design="Emphasized" icon="upload-to-cloud" loading={busy} onClick={() => ablegen(pdf.ablage!)}>Nach Paperless übertragen</Button>} />
    </>
  );
}
