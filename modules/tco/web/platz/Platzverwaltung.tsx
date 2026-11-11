import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, Button, CheckBox, ComboBox, ComboBoxItem, DatePicker, Dialog, Input, Label, MessageStrip, ObjectStatus,
  Option, SegmentedButton, SegmentedButtonItem, Select, StepInput, Switch, Tab, TabContainer, Text, TextArea, Title, ToggleButton, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, ApiError } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { toast } from '@core/toast';
import { useCan } from '@core/session';
import { SperrHinweis, sperreSetzen, useSperre } from '@core/sperre';
import { useNavigate } from 'react-router-dom';
import { TCO, dat, eur } from '../util';
import { FEST_ARTEN, Kalender, hhmm, min, tagPlus, tagText, type Belegt, type FestArt, type TagPlatz } from './PlatzBuchen';
import { Zugaenge } from './Zugaenge';
import { FesteBelegungen } from './FesteBelegungen';
import './platz.css';
import { AuswahlBox } from '@core/components/AuswahlBox';

/**
 * Platzverwaltung: Plätze (Freiplätze/Halle) mit Gültigkeit, Öffnungszeiten, Zeitraster, Buchungsdauern,
 * Vorlauf und Stornofristen; Tagesbelegung mit Namen; Abos (nur hier im Portal); Benutzer ↔ Mitglied.
 */
const PA = `${TCO}/platz/admin`;

interface Platz {
  id: number; name: string; art: 'HALLE' | 'FREI'; aliase: string; sort: number; gueltig_von: string; gueltig_bis: string;
  wochentage: string; zeit_von: string; zeit_bis: string; raster: number; dauer_min: number; dauer_max: number;
  vorlauf_min: number; vorlauf_max: number; storno_frist: number; max_offen: number; abrechnen: boolean; aktiv: boolean; hinweis: string | null;
}
interface AboZeile { bid: string; platz: string; kunde: string; wochentag: string; erster: string; letzter: string; von: string; bis: string; termine: number; kommend: number; abgerechnet: number; text: string | null }
interface Benutzer { id: string; name: string; username: string; adrnr: string | null; mitglied: string | null }
interface Mitglied { adrnr: string; name: string }
interface Preis { betrag: number | null; kostenfrei: boolean; fehler: string | null; text: string }
interface Vorschau { platz: string; kunde: string; wochentag: string; termine: { datum: string; konflikt: string | null }[]; preis: Preis }

const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const isoHeute = () => new Date().toLocaleDateString('sv-SE');
const NEU: Omit<Platz, 'id'> = {
  name: '', art: 'FREI', aliase: '', sort: 0, gueltig_von: isoHeute(), gueltig_bis: '9999-12-31', wochentage: '1234567',
  zeit_von: '08:00', zeit_bis: '22:00', raster: 60, dauer_min: 60, dauer_max: 120, vorlauf_min: 0, vorlauf_max: 14,
  storno_frist: 24, max_offen: 0, abrechnen: false, aktiv: true, hinweis: null,
};
const zeiten = (schritt = 30) => { const o: string[] = []; for (let m = 0; m <= 1440; m += schritt) o.push(m === 1440 ? '24:00' : hhmm(m)); return o; };
const wtText = (w: string) => (w === '1234567' ? 'täglich' : [...w].map((x) => WT[Number(x) - 1]).join(', '));
const std = (m: number) => (m % 60 ? `${m} Min.` : `${m / 60} Std.`);

export function Platzverwaltung() {
  const [tab, setTab] = useState('plaetze');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function aktion(fn: () => Promise<{ text?: string } | unknown>, nachher?: () => unknown) {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      const t = (r as { text?: string } | undefined)?.text;
      if (t) toast(t, 5000);
      await nachher?.();
      return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }

  return (
    <AppPage title="Platzverwaltung" subtitle="Freiplätze und Halle: Plätze, Buchungsregeln, Belegung, Abos"
             actions={<ChangeHistoryButton objectType="PLATZ" objectKey="" />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
        <Tab data-key="plaetze" text="Plätze" icon="grid" selected={tab === 'plaetze'}>
          {tab === 'plaetze' && <Plaetze aktion={aktion} busy={busy} />}
        </Tab>
        <Tab data-key="belegung" text="Belegung" icon="calendar" selected={tab === 'belegung'}>
          {tab === 'belegung' && <Belegung aktion={aktion} busy={busy} />}
        </Tab>
        <Tab data-key="feste" text="Training & Sperrzeiten" icon="private" selected={tab === 'feste'}>
          {tab === 'feste' && <FesteTab aktion={aktion} />}
        </Tab>
        <Tab data-key="abos" text="Abos" icon="repost" selected={tab === 'abos'}>
          {tab === 'abos' && <Abos aktion={aktion} busy={busy} />}
        </Tab>
        <Tab data-key="benutzer" text="Benutzer" icon="employee" selected={tab === 'benutzer'}>
          {tab === 'benutzer' && <BenutzerZuordnung aktion={aktion} />}
        </Tab>
        <Tab data-key="zugaenge" text="Zugänge" icon="add-employee" selected={tab === 'zugaenge'}>
          {tab === 'zugaenge' && <Zugaenge aktion={aktion} />}
        </Tab>
      </TabContainer>
    </AppPage>
  );
}

type Aktion = (fn: () => Promise<unknown>, nachher?: () => unknown) => Promise<boolean>;

function FesteTab({ aktion }: { aktion: Aktion }) {
  const [plaetze, setPlaetze] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => { api.get<{ plaetze: Platz[] }>(`${PA}/plaetze`).then((r) => setPlaetze(r.plaetze.map((p) => ({ id: p.id, name: p.name })))); }, []);
  return <FesteBelegungen aktion={aktion} plaetze={plaetze} />;
}

// ---------------------------------------------------------------- Plätze
function Plaetze({ aktion, busy }: { aktion: Aktion; busy: boolean }) {
  const [plaetze, setPlaetze] = useState<Platz[] | null>(null);
  const [form, setForm] = useState<(Omit<Platz, 'id'> & { id?: number }) | null>(null);
  const [weg, setWeg] = useState(false);
  const [auswahl, setAuswahl] = useState<number[]>([]);
  const [massen, setMassen] = useState<{ basis: Omit<Platz, 'id'>; werte: Omit<Platz, 'id'>; geaendert: string[] } | null>(null);
  const laden = () => api.get<{ plaetze: Platz[] }>(`${PA}/plaetze`).then((r) => setPlaetze(r.plaetze));
  const sperre = useSperre('PLATZ', form?.id ? String(form.id) : null, true, { bezeichnung: `Platz ${form?.name ?? ''}` });
  const massenSperre = useMassenSperre(massen ? auswahl : [], plaetze);
  /** Einzelfeld direkt aus der Tabelle (z. B. Raster) über die Massenänderung speichern */
  const feldSetzen = (id: number, felder: Partial<Platz>) => aktion(() => api.put(`${PA}/plaetze-massen`, { ids: [id], felder }), laden);
  const kopieren = (p: Omit<Platz, 'id'> & { id?: number }) => {
    const { id: _id, ...rest } = p;
    let name = `${p.name} (Kopie)`;
    for (let i = 2; plaetze?.some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `${p.name} (Kopie ${i})`;
    setForm({ ...rest, name, aliase: '', sort: (plaetze?.length ?? 0) + 1 });
  };
  const massenStarten = () => {
    const erste = plaetze?.find((p) => auswahl.includes(p.id));
    if (!erste) return;
    const { id: _id, ...basis } = erste;
    setMassen({ basis, werte: basis, geaendert: [] });
  };
  useEffect(() => { laden(); }, []);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Platz', accessor: 'name', minWidth: 140, Cell: ({ row }: Cell) => <b>{row.original.name}</b> },
    { Header: 'Art', accessor: 'art', width: 90, Cell: ({ value }: Cell) => (value === 'HALLE' ? 'Halle' : 'Freiplatz') },
    { Header: 'Gültig', id: 'gueltig', width: 190, Cell: ({ row }: Cell) => `${dat(row.original.gueltig_von)} – ${row.original.gueltig_bis === '9999-12-31' ? 'unbegrenzt' : dat(row.original.gueltig_bis)}` },
    { Header: 'Öffnung', id: 'oeffnung', width: 190, Cell: ({ row }: Cell) => `${wtText(row.original.wochentage)} ${row.original.zeit_von}–${row.original.zeit_bis}` },
    {
      Header: 'Raster', accessor: 'raster', width: 120,
      Cell: ({ row }: Cell) => (
        // eigener Klickbereich: Auswahl im Dropdown öffnet nicht den Bearbeitungsdialog
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{ width: '100%' }}>
          <Select style={{ width: '100%' }} disabled={busy} accessibleName={`Raster ${row.original.name}`}
                  onChange={(e) => {
                    const r = Number((e.detail.selectedOption as HTMLElement).dataset.k);
                    if (r !== row.original.raster) feldSetzen(row.original.id, { raster: r });
                  }}>
            {[15, 30, 60].map((r) => <Option key={r} data-k={r} selected={row.original.raster === r}>{r} Min.</Option>)}
          </Select>
        </div>
      ),
    },
    { Header: 'Dauer', id: 'dauer', width: 130, Cell: ({ row }: Cell) => `${std(row.original.dauer_min)} – ${std(row.original.dauer_max)}` },
    { Header: 'Vorlauf', id: 'vorlauf', width: 140, Cell: ({ row }: Cell) => `${row.original.vorlauf_min} Std. – ${row.original.vorlauf_max} Tage` },
    { Header: 'Storno bis', accessor: 'storno_frist', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => `${value} Std. vorher` },
    { Header: 'Preis', accessor: 'abrechnen', width: 120, Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Information">Hallenpreise</ObjectStatus> : <ObjectStatus state="Positive">kostenfrei</ObjectStatus>) },
    { Header: 'Status', accessor: 'aktiv', width: 90, Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Positive">aktiv</ObjectStatus> : <ObjectStatus state="None">inaktiv</ObjectStatus>) },
    {
      Header: '', id: 'kopie', width: 56, disableSortBy: true,
      Cell: ({ row }: Cell) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Button design="Transparent" icon="copy" tooltip={`„${row.original.name}“ kopieren`} onClick={() => kopieren(row.original as Platz)} />
        </div>
      ),
    },
  ];

  const speichern = () => form && aktion(
    () => (form.id ? api.put(`${PA}/plaetze/${form.id}`, form) : api.post(`${PA}/plaetze`, form)),
    async () => { setForm(null); await laden(); },
  );

  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Plätze ({plaetze?.length ?? 0})</Title>
        <ToolbarSpacer />
        <Button icon="edit" disabled={!auswahl.length} onClick={massenStarten}>
          Massenänderung{auswahl.length ? ` (${auswahl.length})` : ''}
        </Button>
        <Button icon="add" design="Emphasized" onClick={() => setForm({ ...NEU, sort: (plaetze?.length ?? 0) + 1 })}>Platz anlegen</Button>
      </Toolbar>
      <AnalyticalTable minRows={1} columns={columns} data={plaetze ?? []} loading={!plaetze} visibleRows={Math.max(plaetze?.length ?? 0, 1)}
                       selectionMode="Multiple" selectionBehavior="RowSelector"
                       reactTableOptions={{ getRowId: (r: Platz) => String(r.id), autoResetSelectedRows: false }}
                       onRowSelect={(e) => setAuswahl(Object.keys(e.detail.selectedRowIds).filter((k) => e.detail.selectedRowIds[k]).map(Number))}
                       noDataText="Noch keine Plätze – z. B. „Halle“ (Hallenpreise) und „Platz 1“ … (kostenfrei) anlegen"
                       onRowClick={(e) => setForm({ ...(e.detail.row.original as Platz) })} />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Buchungen landen wie die EP3-Buchungen in der Hallenabrechnung. Plätze mit „Preise aus Hallenpreisen“ werden dort abgerechnet
        (Einzel- bzw. Abo-Preise), kostenfreie Plätze nicht. Über „Weitere Bezeichnungen“ belegen auch EP3-Buchungen den Platz.
      </MessageStrip>

      {form && createPortal(
        <Dialog open headerText={form.id ? `Platz „${form.name}“` : 'Platz anlegen'} style={{ width: 'min(52rem, 96vw)' }} onClose={() => setForm(null)}
                footer={<Bar startContent={form.id ? <>
                               <Button design="Transparent" icon="delete" disabled={!sperre.eigen} onClick={() => setWeg(true)}>Löschen</Button>
                               <Button design="Transparent" icon="copy" onClick={() => kopieren(form)}>Kopieren</Button>
                             </> : undefined}
                             endContent={<>
                               <Button design="Emphasized" disabled={busy || !sperre.eigen || !form.name.trim()} onClick={speichern}>Speichern</Button>
                               <Button onClick={() => setForm(null)}>Abbrechen</Button>
                             </>} />}>
          <SperrHinweis s={sperre} />
          <PlatzFormular f={form} setF={(x) => setForm({ ...form, ...x })} />
        </Dialog>,
        document.body,
      )}
      {massen && createPortal(
        <Dialog open headerText={`Massenänderung – ${auswahl.length} Platz/Plätze`} style={{ width: 'min(52rem, 96vw)' }} onClose={() => setMassen(null)}
                footer={<Bar startContent={<Text className="portal-muted">
                               {massen.geaendert.length ? `Wird gesetzt: ${massen.geaendert.map((k) => FELD_TEXT[k] ?? k).join(', ')}` : 'Noch nichts geändert'}
                             </Text>}
                             endContent={<>
                               <Button design="Emphasized" disabled={busy || !massenSperre.frei || !massen.geaendert.length}
                                       onClick={() => aktion(() => api.put(`${PA}/plaetze-massen`, {
                                         ids: auswahl,
                                         felder: Object.fromEntries(massen.geaendert.map((k) => [k, (massen.werte as Record<string, unknown>)[k]])),
                                       }), async () => { setMassen(null); await laden(); })}>
                                 Auf {auswahl.length} Platz/Plätze anwenden
                               </Button>
                               <Button onClick={() => setMassen(null)}>Abbrechen</Button>
                             </>} />}>
          {massenSperre.fehler.map((f) => <MessageStrip key={f} design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>{f}</MessageStrip>)}
          <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
            Vorbelegt mit den Werten von „{plaetze?.find((p) => auswahl.includes(p.id))?.name}“. Nur die Felder, die Sie hier ändern, werden für
            {' '}{plaetze?.filter((p) => auswahl.includes(p.id)).map((p) => p.name).join(', ')} übernommen. Bezeichnung, weitere Bezeichnungen und Reihenfolge bleiben je Platz erhalten.
          </MessageStrip>
          <PlatzFormular massen f={massen.werte} setF={(x) => {
            const werte = { ...massen.werte, ...x } as Omit<Platz, 'id'>;
            const basis = massen.basis as Record<string, unknown>;
            const neu = werte as Record<string, unknown>;
            const geaendert = MASSEN_FELDER.filter((k) => JSON.stringify(neu[k]) !== JSON.stringify(basis[k]));
            setMassen({ ...massen, werte, geaendert });
          }} />
        </Dialog>,
        document.body,
      )}
      <ConfirmDialog open={weg} danger title="Platz löschen" confirmText="Löschen"
                     text={`„${form?.name}“ löschen? Gibt es bereits Buchungen, bitte stattdessen auf „inaktiv“ setzen.`}
                     onCancel={() => setWeg(false)}
                     onConfirm={() => { setWeg(false); if (form?.id) aktion(() => api.del(`${PA}/plaetze/${form.id}`), async () => { setForm(null); await laden(); }); }} />
    </>
  );
}

/** Massenänderung: alle gewählten Plätze sperren, solange der Dialog offen ist */
function useMassenSperre(ids: number[], plaetze: Platz[] | null) {
  const [zustand, setZustand] = useState<{ frei: boolean; fehler: string[] }>({ frei: false, fehler: [] });
  const schluessel = ids.slice().sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!ids.length) { setZustand({ frei: false, fehler: [] }); return; }
    let ende = false;
    const freigaben: (() => void)[] = [];
    setZustand({ frei: false, fehler: [] });
    (async () => {
      const fehler: string[] = [];
      for (const id of ids) {
        const name = plaetze?.find((p) => p.id === id)?.name ?? String(id);
        try {
          freigaben.push(await sperreSetzen('PLATZ', String(id), { bezeichnung: `Platz ${name}` },
            () => { if (!ende) setZustand((z) => ({ frei: false, fehler: [...z.fehler, `Sperre für ${name} abgelaufen – Dialog bitte neu öffnen.`] })); }));
        } catch (e) {
          fehler.push(e instanceof ApiError && e.status === 423 ? e.message : `${name}: ${(e as Error).message}`);
        }
      }
      if (ende) { freigaben.forEach((f) => f()); return; }
      setZustand({ frei: !fehler.length, fehler });
    })();
    return () => { ende = true; freigaben.forEach((f) => f()); };
  }, [schluessel]); // eslint-disable-line react-hooks/exhaustive-deps
  return zustand;
}

function Zahl({ wert, onChange, min: mn = 0, max, schritt = 1, einheit }: { wert: number; onChange: (n: number) => void; min?: number; max?: number; schritt?: number; einheit: string }) {
  return (
    <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
      <StepInput value={wert} min={mn} max={max} step={schritt} style={{ width: '9rem' }} onChange={(e) => onChange(Number(e.target.value))} />
      <Text className="portal-muted">{einheit}</Text>
    </div>
  );
}

const MASSEN_FELDER = ['art', 'gueltig_von', 'gueltig_bis', 'wochentage', 'zeit_von', 'zeit_bis', 'raster', 'dauer_min', 'dauer_max',
  'vorlauf_min', 'vorlauf_max', 'storno_frist', 'max_offen', 'abrechnen', 'aktiv', 'hinweis'];
const FELD_TEXT: Record<string, string> = {
  art: 'Art', gueltig_von: 'Gültig ab', gueltig_bis: 'Gültig bis', wochentage: 'Wochentage', zeit_von: 'Öffnung ab', zeit_bis: 'Öffnung bis',
  raster: 'Raster', dauer_min: 'Mindestdauer', dauer_max: 'Höchstdauer', vorlauf_min: 'Vorlauf', vorlauf_max: 'Im Voraus', storno_frist: 'Stornofrist',
  max_offen: 'Kommende Buchungen', abrechnen: 'Preise', aktiv: 'Aktiv', hinweis: 'Hinweis',
};

function PlatzFormular({ f, setF, massen }: { f: Omit<Platz, 'id'>; setF: (x: Partial<Platz>) => void; massen?: boolean }) {
  const uhr = zeiten(f.raster);
  return (
    <FormGrid>
      {!massen && <FieldBox label="Bezeichnung" required><Input value={f.name} maxlength={60} onInput={(e) => setF({ name: e.target.value })} placeholder="z. B. Platz 3 oder Halle" /></FieldBox>}
      <FieldBox label="Art">
        <Select onChange={(e) => { const art = (e.detail.selectedOption as HTMLElement).dataset.k as 'HALLE'; setF({ art, abrechnen: art === 'HALLE' }); }}>
          <Option data-k="FREI" selected={f.art === 'FREI'}>Freiplatz</Option>
          <Option data-k="HALLE" selected={f.art === 'HALLE'}>Halle</Option>
        </Select>
      </FieldBox>
      <FieldBox label="Gültig ab" required>
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.gueltig_von} onChange={(e) => e.detail.value && setF({ gueltig_von: e.detail.value })} />
      </FieldBox>
      <FieldBox label="Gültig bis (leer = unbegrenzt)">
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.gueltig_bis === '9999-12-31' ? '' : f.gueltig_bis}
                    onChange={(e) => setF({ gueltig_bis: e.detail.value || '9999-12-31' })} />
      </FieldBox>
      <FieldBox label="Buchbar an" wide>
        <div className="portal-mz__wtage" style={{ maxWidth: '24rem' }}>
          {WT.map((t, i) => {
            const k = String(i + 1);
            const an = f.wochentage.includes(k);
            return <ToggleButton key={t} pressed={an} design={an ? 'Emphasized' : 'Default'}
                                 onClick={() => setF({ wochentage: an ? f.wochentage.replace(k, '') : [...f.wochentage, k].sort().join('') })}>{t}</ToggleButton>;
          })}
        </div>
      </FieldBox>
      <FieldBox label="Zeitraster">
        <Select onChange={(e) => setF({ raster: Number((e.detail.selectedOption as HTMLElement).dataset.k) })}>
          {[15, 30, 60].map((r) => <Option key={r} data-k={r} selected={f.raster === r}>{r} Minuten</Option>)}
        </Select>
      </FieldBox>
      <FieldBox label="Öffnungszeit">
        <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
          <Select style={{ width: '7rem' }} onChange={(e) => setF({ zeit_von: (e.detail.selectedOption as HTMLElement).dataset.k! })}>
            {uhr.slice(0, -1).map((z) => <Option key={z} data-k={z} selected={f.zeit_von === z}>{z}</Option>)}
          </Select>
          <Text>bis</Text>
          <Select style={{ width: '7rem' }} onChange={(e) => setF({ zeit_bis: (e.detail.selectedOption as HTMLElement).dataset.k! })}>
            {uhr.slice(1).map((z) => <Option key={z} data-k={z} selected={f.zeit_bis === z}>{z}</Option>)}
          </Select>
          <Text>Uhr</Text>
        </div>
      </FieldBox>
      <FieldBox label="Mindestdauer"><Zahl wert={f.dauer_min} min={f.raster} max={1440} schritt={f.raster} einheit="Minuten" onChange={(n) => setF({ dauer_min: n })} /></FieldBox>
      <FieldBox label="Höchstdauer"><Zahl wert={f.dauer_max} min={f.raster} max={1440} schritt={f.raster} einheit="Minuten" onChange={(n) => setF({ dauer_max: n })} /></FieldBox>
      <FieldBox label="Vorlauf mindestens"><Zahl wert={f.vorlauf_min} max={336} einheit="Stunden vor Beginn" onChange={(n) => setF({ vorlauf_min: n })} /></FieldBox>
      <FieldBox label="Im Voraus höchstens"><Zahl wert={f.vorlauf_max} max={400} einheit="Tage" onChange={(n) => setF({ vorlauf_max: n })} /></FieldBox>
      <FieldBox label="Ändern/Stornieren bis"><Zahl wert={f.storno_frist} max={336} einheit="Stunden vor Beginn" onChange={(n) => setF({ storno_frist: n })} /></FieldBox>
      <FieldBox label="Kommende Buchungen je Mitglied"><Zahl wert={f.max_offen} max={100} einheit="(0 = unbegrenzt)" onChange={(n) => setF({ max_offen: n })} /></FieldBox>
      <FieldBox label="Preise aus Hallenpreisen">
        <div className="portal-row"><Switch checked={f.abrechnen} onChange={(e) => setF({ abrechnen: e.target.checked })} />
          <Text className="portal-muted portal-small">{f.abrechnen ? 'Einzel-/Abo-Preise, Abrechnung über die Hallenabrechnung' : 'kostenfrei, keine Rechnung'}</Text></div>
      </FieldBox>
      <FieldBox label="Aktiv">
        <div className="portal-row"><Switch checked={f.aktiv} onChange={(e) => setF({ aktiv: e.target.checked })} />
          <Text className="portal-muted portal-small">{f.aktiv ? 'im Kalender buchbar' : 'ausgeblendet'}</Text></div>
      </FieldBox>
      {!massen && <FieldBox label="Weitere Bezeichnungen (z. B. aus EP3, kommagetrennt)"><Input value={f.aliase} onInput={(e) => setF({ aliase: e.target.value })} /></FieldBox>}
      {!massen && <FieldBox label="Reihenfolge"><Zahl wert={f.sort} max={999} einheit="" onChange={(n) => setF({ sort: n })} /></FieldBox>}
      <FieldBox label="Hinweis für Mitglieder" wide><TextArea value={f.hinweis ?? ''} rows={2} maxlength={500} onInput={(e) => setF({ hinweis: e.target.value })} /></FieldBox>
    </FormGrid>
  );
}

// ---------------------------------------------------------------- Belegung (mit Namen), 1 bis 7 Tage nebeneinander (#11)
const TAGE_WAHL = [1, 3, 5, 7] as const;
function Belegung({ aktion, busy }: { aktion: Aktion; busy: boolean }) {
  const [datum, setDatum] = useState(isoHeute);
  const [tage, setTage] = useState<number>(() => Number(localStorage.getItem('tco.platz.belegung.tage')) || 1);
  const [tagListe, setTagListe] = useState<{ datum: string; plaetze: TagPlatz[] }[] | null>(null);
  const [storno, setStorno] = useState<{ p: TagPlatz; b: Belegt; datum: string } | null>(null);
  const [eintrag, setEintrag] = useState<{ p: TagPlatz; datum: string; von: string } | null>(null);
  const daten = useMemo(() => Array.from({ length: tage }, (_, i) => tagPlus(datum, i)), [datum, tage]);
  const laden = () => Promise.all(daten.map((d) => api.get<{ datum: string; plaetze: TagPlatz[] }>(`${PA}/tag?datum=${d}`))).then(setTagListe);
  useEffect(() => { setTagListe(null); laden(); }, [daten]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem('tco.platz.belegung.tage', String(tage)); } catch { /* egal */ } }, [tage]);

  // mehrere Tage: je Tag und Platz eine Spalte (Spaltenkopf = Tag, bei mehreren Plätzen zusätzlich der Platz)
  const spalten = useMemo(() => {
    if (!tagListe) return null;
    const mehrerePlaetze = Math.max(...tagListe.map((t) => t.plaetze.length)) > 1;
    const zuDatum = new Map<number, { datum: string; p: TagPlatz }>();
    const plaetze: TagPlatz[] = [];
    tagListe.forEach((t, ti) => t.plaetze.forEach((p, pi) => {
      const id = ti * 1000 + pi + 1;
      const kopf = tage === 1 ? p.name : `${tagText(t.datum).slice(0, 2)} ${dat(t.datum).slice(0, 6)}${mehrerePlaetze ? ` · ${p.name}` : ''}`;
      zuDatum.set(id, { datum: t.datum, p });
      plaetze.push({ ...p, id, name: kopf });
    }));
    return { plaetze, zuDatum };
  }, [tagListe, tage]);

  const bisDatum = daten[daten.length - 1];
  return (
    <>
      <Toolbar design="Transparent">
        <Button icon="navigation-left-arrow" design="Transparent" tooltip={tage > 1 ? `${tage} Tage zurück` : 'Vortag'} onClick={() => setDatum(tagPlus(datum, -tage))} />
        <DatePicker formatPattern="EEEE, dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datum} style={{ width: '14rem' }}
                    onChange={(e) => e.detail.valid && e.detail.value && setDatum(e.detail.value)} />
        <Button icon="navigation-right-arrow" design="Transparent" tooltip={tage > 1 ? `${tage} Tage weiter` : 'Folgetag'} onClick={() => setDatum(tagPlus(datum, tage))} />
        {datum !== isoHeute() && <Button design="Transparent" onClick={() => setDatum(isoHeute())}>Heute</Button>}
        <SegmentedButton accessibleName="Anzahl Tage" onSelectionChange={(e) => setTage(Number((e.detail.selectedItems[0] as HTMLElement).dataset.n))}>
          {TAGE_WAHL.map((n) => <SegmentedButtonItem key={n} data-n={n} selected={tage === n}>{n === 1 ? '1 Tag' : `${n} Tage`}</SegmentedButtonItem>)}
        </SegmentedButton>
        <ToolbarSpacer />
        <Text className="portal-muted">
          {tage === 1 ? `Belegung ${tagText(datum)}` : `Belegung ${dat(datum)} – ${dat(bisDatum)}`} – freie Zeit anklicken zum Eintragen, Portalbuchung zum Stornieren
        </Text>
      </Toolbar>
      {spalten && spalten.plaetze.length > 0 && (
        <Kalender admin tag={{ datum }} plaetze={spalten.plaetze}
                  onFrei={(p, von) => { const z = spalten.zuDatum.get(p.id)!; setEintrag({ p: z.p, datum: z.datum, von }); }}
                  onEigen={(p, b) => { const z = spalten.zuDatum.get(p.id)!; setStorno({ p: z.p, b, datum: z.datum }); }} />
      )}
      {spalten && !spalten.plaetze.length && <MessageStrip hideCloseButton>Keine aktiven Plätze.</MessageStrip>}
      {eintrag && <EintragDialog {...eintrag} onClose={() => setEintrag(null)}
                                 onFertig={(text) => { setEintrag(null); toast(text, 5000); laden(); }} />}
      <ConfirmDialog open={!!storno} danger title="Termin stornieren" confirmText="Stornieren"
                     text={storno ? `${storno.p.name}, ${tagText(storno.datum)} ${storno.b.von}–${storno.b.bis} Uhr (${storno.b.art}, ${storno.b.kunde}) stornieren?${storno.b.art === 'Abo' ? ' Nur dieser Termin – die Serie beenden Sie unter „Abos“.' : ''}` : ''}
                     onCancel={() => setStorno(null)}
                     onConfirm={() => { const s = storno!; setStorno(null); if (!busy) aktion(() => api.post(`${PA}/storno`, { bid: s.b.bid, datum: s.datum }), laden); }} />
    </>
  );
}

// ---------------------------------------------------------------- Eintragen aus der Belegung (#11)
type EintragArt = 'MITGLIED' | FestArt;
const BEZEICHNUNG_VORGABE: Record<FestArt, string> = { TRAINING: 'Jugendtraining', SCHNUPPER: 'Schnuppertraining', SPERRE: 'Sperrzeit', VERANSTALTUNG: 'Veranstaltung' };

/** Freie Zeit in der Belegung: Buchung für ein Mitglied / vereinsintern oder Training, Schnuppertraining, Sperrzeit, Veranstaltung */
function EintragDialog({ p, datum, von, onClose, onFertig }: { p: TagPlatz; datum: string; von: string; onClose: () => void; onFertig: (text: string) => void }) {
  const [art, setArt] = useState<EintragArt>('MITGLIED');
  const ende = min(p.zeit_bis) || 1440;
  const bisListe = useMemo(() => { const o: string[] = []; for (let m = min(von) + p.raster; m <= ende; m += p.raster) o.push(m === 1440 ? '24:00' : hhmm(m)); return o; }, [von, p.raster, ende]);
  const [bis, setBis] = useState(() => bisListe.find((b) => min(b) - min(von) >= 60) ?? bisListe[0] ?? von);
  const [mitglieder, setMitglieder] = useState<Mitglied[]>([]);
  const [adrnr, setAdrnr] = useState<string | null>(null);
  const [intern, setIntern] = useState('');
  const [bezeichnung, setBezeichnung] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<{ mitglieder: Mitglied[] }>(`${PA}/benutzer`).then((r) => setMitglieder(r.mitglieder)).catch((e) => setError(e.message)); }, []);
  const fest = art !== 'MITGLIED';
  const ok = fest ? !!bezeichnung.trim() : !!adrnr || !!intern.trim();
  async function speichern() {
    setBusy(true); setError(null);
    try {
      const basis = { platz_id: p.id, datum, von, bis, text: text.trim() || null };
      const r = fest
        ? await api.post<{ text: string }>(`${PA}/belegung`, { ...basis, art, bezeichnung: bezeichnung.trim() })
        : await api.post<{ text: string }>(`${PA}/buchung`, { ...basis, adrnr, intern: adrnr ? null : intern.trim() || null });
      onFertig(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return createPortal(
    <Dialog open headerText={`${p.name} · ${tagText(datum)}`} style={{ width: 'min(36rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={busy || !ok} onClick={speichern}>{fest ? 'Eintragen' : 'Buchen'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-mz__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        <FormGrid>
          <FieldBox label="Eintragen als" required wide>
            <Select style={{ width: '100%' }} onChange={(e) => {
              const a = (e.detail.selectedOption as HTMLElement).dataset.a as EintragArt;
              setArt(a);
              if (a !== 'MITGLIED') setBezeichnung(BEZEICHNUNG_VORGABE[a]);
            }}>
              <Option data-a="MITGLIED" selected={art === 'MITGLIED'}>Buchung für ein Mitglied / eine Person</Option>
              {(Object.keys(FEST_ARTEN) as FestArt[]).map((a) => <Option key={a} data-a={a} selected={art === a}>{FEST_ARTEN[a]}</Option>)}
            </Select>
          </FieldBox>
          <FieldBox label="Von"><Text style={{ paddingTop: '0.5rem' }}>{von} Uhr</Text></FieldBox>
          <FieldBox label="Bis" required>
            <Select style={{ width: '100%' }} onChange={(e) => setBis((e.detail.selectedOption as HTMLElement).dataset.b!)}>
              {bisListe.map((b) => <Option key={b} data-b={b} selected={b === bis}>{b} Uhr</Option>)}
            </Select>
          </FieldBox>
          {!fest && (
            <>
              <FieldBox label="Mitglied" wide>
                <AuswahlBox wert={adrnr ?? ''} placeholder="Mitglied suchen" max={50} style={{ width: '100%' }}
                            eintraege={mitglieder.map((m) => ({ key: m.adrnr, text: m.name, zusatz: m.adrnr }))} onWaehle={(k) => setAdrnr(k)} />
              </FieldBox>
              {!adrnr && (
                <FieldBox label="oder Name (vereinsintern, ohne Rechnung)" wide>
                  <Input style={{ width: '100%' }} value={intern} maxlength={60} placeholder="z. B. Medenspiel Herren 40, Gastspieler Müller" onInput={(e) => setIntern(e.target.value)} />
                </FieldBox>
              )}
            </>
          )}
          {fest && (
            <FieldBox label="Bezeichnung" required wide>
              <Input style={{ width: '100%' }} value={bezeichnung} maxlength={80} onInput={(e) => setBezeichnung(e.target.value)} />
            </FieldBox>
          )}
          <FieldBox label={fest ? 'Hinweis im Kalender (z. B. Gruppe, Trainer)' : 'Notiz'} wide>
            <Input style={{ width: '100%' }} value={text} maxlength={200} onInput={(e) => setText(e.target.value)} />
          </FieldBox>
        </FormGrid>
        <Text className="portal-muted portal-small">
          {fest
            ? 'Feste Belegung nur für diesen Termin – für alle mit Bezeichnung sichtbar; wiederkehrende Zeiten unter „Training & Sperrzeiten“.'
            : 'Einzelbuchung wie die Serienbuchung „einmalig“: Mitglied mit Preis laut Hallenpreisen, vereinsintern ohne Rechnung. Abos über die Serienbuchung.'}
        </Text>
      </div>
    </Dialog>,
    document.body,
  );
}

// ---------------------------------------------------------------- Abos (nur hier im Portal)

function Abos({ aktion, busy }: { aktion: Aktion; busy: boolean }) {
  const can = useCan();
  const navigate = useNavigate();
  const [abos, setAbos] = useState<AboZeile[] | null>(null);
  const [ende, setEnde] = useState<{ bid: string; ab: string } | null>(null);
  const laden = () => api.get<AboZeile[]>(`${PA}/abos`).then(setAbos);
  useEffect(() => {
    laden();
  }, []);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Abo', accessor: 'bid', width: 110 },
    { Header: 'Mitglied', accessor: 'kunde', minWidth: 160 },
    { Header: 'Platz', accessor: 'platz', width: 110 },
    { Header: 'Termin', id: 'termin', width: 170, Cell: ({ row }: Cell) => `${row.original.wochentag}s ${row.original.von}–${row.original.bis}` },
    { Header: 'Zeitraum', id: 'zeitraum', width: 190, Cell: ({ row }: Cell) => `${dat(row.original.erster)} – ${dat(row.original.letzter)}` },
    { Header: 'Termine', accessor: 'termine', width: 80, hAlign: 'End' },
    { Header: 'kommend', accessor: 'kommend', width: 85, hAlign: 'End' },
    { Header: 'Abrechnung', accessor: 'abgerechnet', width: 120, Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Positive">abgerechnet</ObjectStatus> : <ObjectStatus state="Critical">offen</ObjectStatus>) },
    { Header: 'Notiz', accessor: 'text', minWidth: 120 },
    {
      Header: '', id: 'aktion', width: 110,
      Cell: ({ row }: Cell) => (row.original.kommend
        ? <Button design="Transparent" icon="stop" onClick={() => setEnde({ bid: row.original.bid, ab: isoHeute() })}>Beenden</Button> : null),
    },
  ];
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Abos ({abos?.length ?? 0})</Title>
        <ToolbarSpacer />
        {can('tco.platz:serie') && <Button icon="repost" design="Emphasized" onClick={() => navigate('/tco/serienbuchung')}>Abo anlegen (Serienbuchung)</Button>}
      </Toolbar>
      <AnalyticalTable minRows={1} columns={columns} data={abos ?? []} loading={!abos} visibleRows={Math.max(abos?.length ?? 0, 1)} noDataText="Noch keine Abos über das Portal angelegt" />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Abos legt der Hallenwart über die Serienbuchung an (auch mehrere Plätze, zweiwöchentlich oder monatlich). Mitglieder sehen ihre Abos mit Preis in „Platz buchen“, können sie aber nicht ändern;
        für andere erscheinen die Termine als „belegt“. Abgerechnet wird wie bei EP3-Abos einmal je Serie über die Hallenabrechnung.
      </MessageStrip>

      {ende && createPortal(
        <Dialog open headerText={`Abo ${ende.bid} beenden`} onClose={() => setEnde(null)}
                footer={<Bar endContent={<>
                  <Button design="Negative" disabled={busy} onClick={() => aktion(() => api.post(`${PA}/abos/${ende.bid}/beenden`, { ab: ende.ab }), async () => { setEnde(null); await laden(); })}>Termine stornieren</Button>
                  <Button onClick={() => setEnde(null)}>Abbrechen</Button>
                </>} />}>
          <div className="portal-mz__form">
            <Label>Alle noch nicht abgerechneten Termine stornieren ab</Label>
            <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={ende.ab} onChange={(e) => e.detail.value && setEnde({ ...ende, ab: e.detail.value })} />
          </div>
        </Dialog>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------- Benutzer ↔ Mitglied
function BenutzerZuordnung({ aktion }: { aktion: Aktion }) {
  const [d, setD] = useState<{ benutzer: Benutzer[]; mitglieder: Mitglied[] } | null>(null);
  const [suche, setSuche] = useState('');
  const laden = () => api.get<{ benutzer: Benutzer[]; mitglieder: Mitglied[] }>(`${PA}/benutzer`).then(setD);
  useEffect(() => { laden(); }, []);
  const liste = (d?.benutzer ?? []).filter((b) => !suche || `${b.name} ${b.username} ${b.mitglied ?? ''}`.toLowerCase().includes(suche.toLowerCase()));

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Benutzer', accessor: 'name', minWidth: 160 },
    { Header: 'Anmeldename', accessor: 'username', width: 160 },
    {
      Header: 'Mitglied (bucht in „Platz buchen“ als …)', id: 'mitglied', minWidth: 300,
      Cell: ({ row }: Cell) => (
        <div className="portal-row" style={{ flexWrap: 'nowrap', width: '100%' }}>
          <AuswahlBox wert={row.original.adrnr} placeholder="Mitglied suchen" style={{ width: '16rem' }} leerErlaubt={false}
                      eintraege={(d?.mitglieder ?? []).map((m) => ({ key: m.adrnr, text: m.name, zusatz: m.adrnr }))}
                      onWaehle={(adrnr) => { if (adrnr && adrnr !== row.original.adrnr) aktion(() => api.put(`${PA}/benutzer`, { benutzer_id: row.original.id, adrnr }), laden); }} />
          {row.original.adrnr && <Button design="Transparent" icon="decline" tooltip="Zuordnung entfernen"
                                         onClick={() => aktion(() => api.put(`${PA}/benutzer`, { benutzer_id: row.original.id, adrnr: null }), laden)} />}
        </div>
      ),
    },
  ];
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Benutzer ({liste.length})</Title>
        <ToolbarSpacer />
        <Input placeholder="Suchen" value={suche} onInput={(e) => setSuche(e.target.value)} style={{ width: '14rem' }} />
      </Toolbar>
      <AnalyticalTable minRows={1} columns={columns} data={liste} loading={!d} visibleRows={Math.min(Math.max(liste.length, 1), 15)} rowHeight={48} noDataText="Keine Benutzer" />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Gebucht wird immer für das Mitglied, dem der angemeldete Benutzer zugeordnet ist (dieselbe Zuordnung wie bei „Meine Trainingszeiten“).
        Zusätzlich braucht der Benutzer die Berechtigung „Platz buchen“ (Rollenpflege → Tennishalle).
      </MessageStrip>
    </>
  );
}
