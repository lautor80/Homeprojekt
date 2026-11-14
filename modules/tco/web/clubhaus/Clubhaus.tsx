import { useEffect, useMemo, useState } from 'react';
import { feld } from '@core/components/Varianten';
import {
  AnalyticalTable, Button, FlexBox, Label, List, ListItemStandard, MessageStrip, ObjectStatus, Option, Panel, SegmentedButton,
  SegmentedButtonItem, Select, Tab, TabContainer, Text, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { FormGrid, TextField } from '@core/components/FormFields';
import { PdfDialog } from '@core/components/PdfDialog';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { einstellungLink } from '@core/einstellungen';
import { TCO, dat, eur } from '../util';
import { AbsatzDiagramm, EinnahmenDiagramm } from './Diagramme';
import { Getraenke } from './Getraenke';
import { RechnungDialog } from './RechnungDialog';

export const CH = `${TCO}/clubhaus`;
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MON_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

interface Cfg { konto_einnahmen: string; konto_ware: string; reinigung: number; provision: number; wirt: string; feld_json: string }
export interface RgKopf { rgnr: string; datum: string; brutto: number; positionen: number; belege: string[] }
interface Ford { jahr: number; monat: number; ekbrutto: number; vkbrutto: number; reinigung: number; provision: number; forderung: number; einzahlungen: number; offene_posten: number; doc_id: number | null }
interface Init { jahr: number; jahre: number[]; cfg: Cfg; paperless: boolean; rechnungen: RgKopf[]; forderungen: Ford[] }

const monatText = (f: Ford) => (f.monat === 0 ? `Eingangsübertrag ${f.jahr}` : f.monat === 13 ? `Endübertrag ${f.jahr}` : MONATE[f.monat - 1]);

export function Clubhaus() {
  const can = useCan();
  const edit = can('tco.clubhaus:edit');
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const [d, setD] = useState<Init | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rg, setRg] = useState<string | null | undefined>(undefined); // undefined = zu, null = neu
  const [tab, setTab] = useState('ford');
  const laden = (j = jahr) => api.get<Init>(`${CH}/init?jahr=${j}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { setD(null); laden(jahr); }, [jahr]); // eslint-disable-line react-hooks/exhaustive-deps

  async function aktion(fn: () => Promise<{ text: string } | void>) {
    setError(null);
    try { const r = await fn(); if (r?.text) toast(r.text, 5000); await laden(); } catch (e) { setError((e as Error).message); }
  }

  const offen = d?.rechnungen.filter((r) => !r.belege.length).length ?? 0;
  return (
    <AppPage varianten={{ repid: 'tco.clubhaus', ansicht: { jahr, tab }, onAnwenden: (a) => { setJahr(feld(a, 'jahr', jahr)); setTab(feld(a, 'tab', tab)); } }} title={`Clubhausabrechnung ${jahr}`} subtitle={d ? `Getränkerechnungen, Forderungsliste gegenüber ${d.cfg.wirt} und Getränkeabsatz` : ''}
             actions={<>
               {edit && <Button design="Transparent" icon="action-settings" tooltip="Einstellungen (Administration → Einstellungen → TC Oberthal → Clubhaus)" onClick={() => { window.location.assign(einstellungLink('tco', 'clubhaus')); }} />}
               <Label>Jahr</Label>
               <Select style={{ width: '7rem' }} onChange={(e) => setJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
                 {(d?.jahre ?? [jahr]).map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
               </Select>
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {d && (
        <FlexBox alignItems="Start" style={{ gap: '1rem' }} wrap="Wrap">
          <div style={{ flex: '0 0 19rem', maxWidth: '19rem' }}>
            {/* Titel und Buttons umbrechen statt den Titel abzuschneiden */}
            <div className="portal-ch__kopf">
              <Title level="H5" wrappingType="Normal">Rechnungen ({d.rechnungen.length})</Title>
              <div className="portal-ch__knoepfe">
                {edit && d.paperless && <Button icon="chain-link" design="Transparent" disabled={!offen}
                                                 onClick={() => aktion(() => api.post(`${CH}/belege/alle`, { jahr }))}>Belege zuordnen</Button>}
                {edit && <Button icon="add-document" design="Emphasized" onClick={() => setRg(null)}>Neu</Button>}
              </div>
            </div>
            <List onItemClick={(e) => setRg((e.detail.item as HTMLElement).dataset.rg!)} noDataText={`Keine Getränkerechnungen ${jahr}`}>
              {d.rechnungen.map((r) => (
                <ListItemStandard key={r.rgnr} data-rg={r.rgnr} type="Active" icon={r.belege.length ? 'pdf-attachment' : 'sales-document'}
                                  description={`${dat(r.datum)}${r.belege.length ? ` · ${r.belege.length === 1 ? 'Beleg' : 'Belege'} ${r.belege.join(', ')}` : ' · ohne Beleg'}`}
                                  additionalText={eur(r.brutto)}>{r.rgnr}</ListItemStandard>
              ))}
            </List>
          </div>
          <div style={{ flex: '1 1 40rem', minWidth: 0 }}>
            <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
              <Tab data-key="ford" text="Forderungsliste" icon="lead-outdated" selected={tab === 'ford'}>
                <Forderungen d={d} edit={edit} onAktion={aktion} onError={setError} />
              </Tab>
              <Tab data-key="abs" text="Getränkeabsatz" icon="bar-chart" selected={tab === 'abs'}>
                {tab === 'abs' && <Absatz />}
              </Tab>
              <Tab data-key="getr" text="Getränke und Preise" icon="lab" selected={tab === 'getr'}>
                {tab === 'getr' && <Getraenke edit={edit} />}
              </Tab>
            </TabContainer>
          </div>
        </FlexBox>
      )}
      {rg !== undefined && d && (
        <RechnungDialog rgnr={rg} jahr={jahr} edit={edit} paperless={d.paperless}
                        onClose={(geaendert) => { setRg(undefined); if (geaendert) laden(); }} />
      )}
    </AppPage>
  );
}

// ---------------------------------------------------------------- Forderungsliste
function Forderungen({ d, edit, onAktion, onError }: { d: Init; edit: boolean; onAktion: (fn: () => Promise<{ text: string } | void>) => void; onError: (t: string) => void }) {
  const aktMonat = d.jahr === new Date().getFullYear() ? new Date().getMonth() + 1 : 12;
  const [monat, setMonat] = useState(aktMonat);
  const [pdf, setPdf] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setMonat(aktMonat), [d.jahr]); // eslint-disable-line react-hooks/exhaustive-deps
  const zeilen = d.forderungen;
  const f = zeilen.find((x) => x.monat === monat);
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Monat', id: 'monat', width: 160, accessor: (x: Record<string, any>) => monatText(x as Ford),
      Cell: ({ row, value }: Cell) => <Text style={{ fontWeight: row.original.monat === monat ? 'bold' : undefined }}>{value}</Text> },
    ...([['ekbrutto', 'EK-Brutto'], ['vkbrutto', 'VK-Brutto'], ['reinigung', 'Reinigung'], ['provision', 'Provision'], ['forderung', 'Forderung'], ['einzahlungen', 'Einzahlungen']] as const)
      .map(([k, t]) => ({
        Header: t, accessor: k, minWidth: 88, hAlign: 'End' as const, ...(k === 'ekbrutto' ? { responsiveMinWidth: 1500 } : {}),
        Cell: ({ row, value }: Cell) => (row.original.monat >= 1 && row.original.monat <= 12 ? <Text style={{ fontWeight: k === 'forderung' ? 'bold' : undefined }}>{eur(value)}</Text> : ''),
      })),
    {
      Header: 'Offene Posten', accessor: 'offene_posten', minWidth: 110, hAlign: 'End',
      Cell: ({ value }: Cell) => <ObjectStatus state={value > 0.004 ? 'Negative' : value < -0.004 ? 'Critical' : 'Positive'}><b>{eur(value)}</b></ObjectStatus>,
    },
  ];
  async function ablegen() {
    setBusy(true);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${CH}/paperless`, { jahr: d.jahr, monat });
      toast(r.text, 5000);
      if (r.warnungen.length) onError(r.warnungen.join('\n'));
      setPdf(false);
      onAktion(async () => undefined);
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  const punkte = zeilen.filter((x) => x.monat >= 1 && x.monat <= 12).map((x) => ({ label: MON_KURZ[x.monat - 1], einnahme: -x.einzahlungen, op: x.offene_posten }));
  return (
    <>
      <div className="portal-ch__kopf">
        <div className="portal-ch__knoepfe">
          <Label>Monat</Label>
          <Select style={{ width: '10rem' }} onChange={(e) => setMonat(Number((e.detail.selectedOption as HTMLElement).dataset.m))}>
            {MONATE.map((m, i) => <Option key={m} data-m={i + 1} selected={i + 1 === monat}>{m}</Option>)}
          </Select>
          {f?.doc_id && <Text>Abgelegt: DOKID {String(f.doc_id).padStart(6, '0')}</Text>}
        </div>
        <div className="portal-ch__knoepfe">
          {edit && <Button icon="simulate" design="Emphasized" onClick={() => onAktion(() => api.post(`${CH}/berechnen`, { jahr: d.jahr, monat }))}>
            Ab {MONATE[monat - 1]} berechnen</Button>}
          <Button icon="print" onClick={() => setPdf(true)}>Drucken</Button>
        </div>
      </div>
      <AnalyticalTable minRows={1} columns={columns} data={zeilen} visibleRows={zeilen.length}
                       onRowClick={(e) => { const m = e.detail.row.original.monat; if (m >= 1 && m <= 12) setMonat(m); }}
                       withRowHighlight highlightField={(x: Record<string, any>) => (x.monat === monat ? 'Information' : 'None')} />
      <MessageStrip hideCloseButton style={{ margin: '0.5rem 0' }}>
        Forderung = VK der eingekauften Getränke − Reinigung ({eur(d.cfg.reinigung)} je Montag) − Provision ({d.cfg.provision} %). Einzahlungen kommen aus FI-Konto {d.cfg.konto_einnahmen}.
        Nach dem Speichern einer Rechnung wird automatisch nachgerechnet; nach neuen Einzahlungen in FI bitte „berechnen“.
      </MessageStrip>
      <Panel headerText={`Einnahmen und offene Posten ${d.jahr}`} style={{ marginTop: '0.5rem' }}>
        <EinnahmenDiagramm punkte={punkte} />
      </Panel>
      <PdfDialog url={pdf ? `${CH}/pdf?jahr=${d.jahr}&monat=${monat}` : null} title={`Clubhausabrechnung bis ${MONATE[monat - 1]} ${d.jahr}`}
                 filename={`Clubhausabrechnung_${d.jahr}_${String(monat).padStart(2, '0')}.pdf`} onClose={() => setPdf(false)}
                 actions={edit && d.paperless && <Button design="Emphasized" icon="upload-to-cloud" loading={busy} onClick={ablegen}>In Paperless ablegen</Button>} />
    </>
  );
}

// ---------------------------------------------------------------- Getränkeabsatz
interface AbsRow { jahr: number; produkt: string; vkmenge: number; vkpreis: number; anzahl: number; flaschen: number; ek_ges: number; vk_ges: number; provision: number; ergebnis: number }
const KENNZAHLEN: [string, string][] = [
  ['MENGE', 'Absatzmenge'], ['EK_GES', 'Einkaufswert gesamt'], ['EK_AVG', 'EK-Preis Durchschnitt'], ['VK_GES', 'Verkaufswert gesamt'],
  ['VK_AVG', 'VK-Preis je Einheit'], ['PROV', 'Provision gesamt'], ['PROV_STK', 'Provision je Einheit'], ['ERG_GES', 'Ergebnis gesamt'], ['ERG_STK', 'Ergebnis je Einheit'],
];

function Absatz() {
  const [a, setA] = useState<{ rows: AbsRow[]; jahre: number[]; fehlt: string[] } | null>(null);
  const [einheit, setEinheit] = useState<'KISTE' | 'FLASCHE'>('KISTE');
  const [kz, setKz] = useState('MENGE');
  useEffect(() => { api.get<typeof a>(`${CH}/absatz`).then(setA); }, []);
  const sum = (l: AbsRow[]) => l.reduce((s, r) => ({ ...s, anzahl: s.anzahl + r.anzahl, flaschen: s.flaschen + r.flaschen, ek_ges: s.ek_ges + r.ek_ges, vk_ges: s.vk_ges + r.vk_ges, provision: s.provision + r.provision, ergebnis: s.ergebnis + r.ergebnis }),
    { anzahl: 0, flaschen: 0, ek_ges: 0, vk_ges: 0, provision: 0, ergebnis: 0 } as Pick<AbsRow, 'anzahl' | 'flaschen' | 'ek_ges' | 'vk_ges' | 'provision' | 'ergebnis'>);
  const wert = (s: ReturnType<typeof sum>) => {
    const b = einheit === 'FLASCHE' ? s.flaschen : s.anzahl;
    const div = (x: number) => (b ? x / b : 0);
    return ({ MENGE: b, EK_GES: s.ek_ges, EK_AVG: div(s.ek_ges), VK_GES: s.vk_ges, VK_AVG: div(s.vk_ges), PROV: s.provision, PROV_STK: div(s.provision), ERG_GES: s.ergebnis, ERG_STK: div(s.ergebnis) } as Record<string, number>)[kz];
  };
  const dec = kz === 'MENGE' ? 0 : 2;
  const fmt = (v: number) => v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const tabelle = useMemo(() => {
    if (!a) return [];
    const produkte = [...new Set(a.rows.map((r) => r.produkt))].sort((x, y) => x.localeCompare(y, 'de'));
    const zeile = (name: string, info: string, l: AbsRow[]) => {
      const z: Record<string, any> = { produkt: name, info, gesamt: wert(sum(l)) };
      for (const j of a.jahre) { const lj = l.filter((r) => r.jahr === j); z[`j${j}`] = lj.length ? wert(sum(lj)) : null; }
      return z;
    };
    const rows = produkte.map((p) => {
      const l = a.rows.filter((r) => r.produkt === p);
      return zeile(p, `${l[0].vkmenge.toLocaleString('de-DE')} Flaschen/Kiste · VK ${eur(l[0].vkpreis)}`, l);
    });
    if (rows.length) rows.push({ ...zeile('Gesamt', `${produkte.length} Produkte`, a.rows), gesamtzeile: true });
    return rows;
  }, [a, einheit, kz]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return <Text>Lädt …</Text>;
  const zelle = (v: number | null, fett?: boolean) => (v === null ? '–' : <ObjectStatus state={v < 0 ? 'Negative' : 'None'}>{fett ? <b>{fmt(v)}</b> : fmt(v)}</ObjectStatus>);
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Produkt', accessor: 'produkt', minWidth: 220, Cell: ({ row }: Cell) => <div style={{ lineHeight: 1.3 }}><Text style={{ fontWeight: 'bold' }}>{row.original.produkt}</Text><br /><Label>{row.original.info}</Label></div> },
    ...a.jahre.map((j) => ({ Header: String(j), accessor: `j${j}`, minWidth: 80, hAlign: 'End' as const, Cell: ({ row, value }: Cell) => zelle(value, row.original.gesamtzeile) })),
    { Header: 'Gesamt', accessor: 'gesamt', minWidth: 100, hAlign: 'End', Cell: ({ value }: Cell) => zelle(value, true) },
  ];
  const punkte = a.jahre.map((j) => { const s = sum(a.rows.filter((r) => r.jahr === j)); const m = einheit === 'FLASCHE' ? s.flaschen : s.anzahl; return { jahr: j, menge: m, preis: m ? s.ek_ges / m : 0 }; });
  return (
    <>
      {a.fehlt.length > 0 && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Ohne Getränkestammsatz und daher nicht bewertet: {a.fehlt.join(', ')}</MessageStrip>}
      <div className="portal-ch__kopf">
        <Title level="H5" wrappingType="Normal">{KENNZAHLEN.find((k) => k[0] === kz)![1]}{kz === 'MENGE' ? ` in ${einheit === 'KISTE' ? 'Kisten' : 'Flaschen'}` : ' (EUR)'}</Title>
        <div className="portal-ch__knoepfe">
        <SegmentedButton onSelectionChange={(e) => setEinheit((e.detail.selectedItems[0] as HTMLElement).dataset.e as 'KISTE')}>
          <SegmentedButtonItem data-e="KISTE" selected={einheit === 'KISTE'}>Kisten</SegmentedButtonItem>
          <SegmentedButtonItem data-e="FLASCHE" selected={einheit === 'FLASCHE'}>Flaschen</SegmentedButtonItem>
        </SegmentedButton>
        <Select style={{ width: '14rem' }} onChange={(e) => setKz((e.detail.selectedOption as HTMLElement).dataset.k!)}>
          {KENNZAHLEN.map(([k, t]) => <Option key={k} data-k={k} selected={k === kz}>{t}</Option>)}
        </Select>
        </div>
      </div>
      <AnalyticalTable minRows={1} columns={columns} data={tabelle} visibleRows={Math.max(tabelle.length, 1)} noDataText="Keine Getränkerechnungen"
                       withRowHighlight highlightField={(r: Record<string, any>) => (r.gesamtzeile ? 'Information' : 'None')} />
      <Panel headerText="Entwicklung Absatz und durchschnittlicher EK-Preis" style={{ marginTop: '0.75rem' }}>
        <AbsatzDiagramm punkte={punkte} einheit={einheit === 'KISTE' ? 'Kisten' : 'Flaschen'} />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Einstellungen
/** Kapitel „Clubhaus“ der App Einstellungen (#232, E1) – bisher Reiter „Einstellungen“ der Clubhausabrechnung */
export function ClubhausKapitel() {
  const can = useCan();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Init>(`${CH}/init?jahr=${new Date().getFullYear()}`).then((d) => setCfg(d.cfg)).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, []);
  if (!cfg) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null;
  return <Einstellungen cfg={cfg} edit={can('tco.clubhaus:edit')} onSaved={laden} />;
}

/**
 * Abschnitt im Reiter „Paperless“ der App Schnittstellen (#232): das Feld, aus dem die Clubhausabrechnung gelesen wird.
 * Gesichert wird die ganze Konfiguration des Clubhauses – die übrigen Angaben bleiben, wie sie geladen wurden.
 */
export function ClubhausPaperless() {
  const can = useCan();
  const edit = can('tco.clubhaus:edit');
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const laden = () => api.get<Init>(`${CH}/init?jahr=${new Date().getFullYear()}`).then((d) => setCfg(d.cfg)).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cfg) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null;
  async function sichern(c: Cfg) {
    setBusy(true); setError(null);
    try {
      toast((await api.put<{ text: string }>(`${CH}/cfg`, { ...c, reinigung: Number(String(c.reinigung).replace(',', '.')), provision: Number(String(c.provision).replace(',', '.')) })).text, 5000);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FormGrid>
        <TextField label="Custom Field „JSON“ der Clubhausabrechnung (Name oder ID)" value={cfg.feld_json} onChange={(v) => setCfg({ ...cfg, feld_json: v })} readonly={!edit} />
      </FormGrid>
      {edit && <Toolbar design="Transparent"><ToolbarSpacer /><Button design="Emphasized" disabled={busy} onClick={() => sichern(cfg)}>Speichern</Button></Toolbar>}
    </>
  );
}

function Einstellungen({ cfg, edit, onSaved }: { cfg: Cfg; edit: boolean; onSaved: () => void }) {
  const [c, setC] = useState(cfg);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setC(cfg), [cfg]);
  const s = (k: keyof Cfg) => (v: string) => setC({ ...c, [k]: v });
  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FormGrid>
        <TextField label="Clubhauswirtin / Pächter" value={c.wirt} onChange={s('wirt')} readonly={!edit} />
        <TextField label="FI-Konto Einzahlungen" value={c.konto_einnahmen} onChange={s('konto_einnahmen')} readonly={!edit} />
        <TextField label="FI-Konto Getränke-Wareneingang" value={c.konto_ware} onChange={s('konto_ware')} readonly={!edit} />
        <TextField label="Reinigungspauschale je Montag (€)" value={String(c.reinigung)} onChange={s('reinigung')} readonly={!edit} />
        <TextField label="Provision (% vom VK)" value={String(c.provision)} onChange={s('provision')} readonly={!edit} />
      </FormGrid>
      {edit && <Toolbar design="Transparent"><ToolbarSpacer />
        <Button design="Emphasized" onClick={async () => {
          setError(null);
          try { toast((await api.put<{ text: string }>(`${CH}/cfg`, { ...c, reinigung: Number(String(c.reinigung).replace(',', '.')), provision: Number(String(c.provision).replace(',', '.')) })).text, 5000); onSaved(); }
          catch (e) { setError((e as Error).message); }
        }}>Speichern</Button>
      </Toolbar>}
    </>
  );
}
