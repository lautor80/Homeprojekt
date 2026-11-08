import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, Button, CheckBox, ComboBox, ComboBoxItem, DatePicker, Dialog, Input, Label, MessageStrip, ObjectStatus,
  Option, Select, StepInput, Switch, Tab, TabContainer, Text, TextArea, Title, ToggleButton, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { toast } from '@core/toast';
import { useCan } from '@core/session';
import { useNavigate } from 'react-router-dom';
import { TCO, dat, eur } from '../util';
import { Kalender, hhmm, min, tagPlus, tagText, type Belegt, type TagPlatz } from './PlatzBuchen';
import './platz.css';

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
        <Tab data-key="abos" text="Abos" icon="repost" selected={tab === 'abos'}>
          {tab === 'abos' && <Abos aktion={aktion} busy={busy} />}
        </Tab>
        <Tab data-key="benutzer" text="Benutzer" icon="employee" selected={tab === 'benutzer'}>
          {tab === 'benutzer' && <BenutzerZuordnung aktion={aktion} />}
        </Tab>
      </TabContainer>
    </AppPage>
  );
}

type Aktion = (fn: () => Promise<unknown>, nachher?: () => unknown) => Promise<boolean>;

// ---------------------------------------------------------------- Plätze
function Plaetze({ aktion, busy }: { aktion: Aktion; busy: boolean }) {
  const [plaetze, setPlaetze] = useState<Platz[] | null>(null);
  const [form, setForm] = useState<(Omit<Platz, 'id'> & { id?: number }) | null>(null);
  const [weg, setWeg] = useState(false);
  const [auswahl, setAuswahl] = useState<number[]>([]);
  const [massen, setMassen] = useState<{ basis: Omit<Platz, 'id'>; werte: Omit<Platz, 'id'>; geaendert: string[] } | null>(null);
  const laden = () => api.get<{ plaetze: Platz[] }>(`${PA}/plaetze`).then((r) => setPlaetze(r.plaetze));
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
      <AnalyticalTable columns={columns} data={plaetze ?? []} loading={!plaetze} visibleRows={Math.max(plaetze?.length ?? 0, 3)}
                       selectionMode="MultiSelect" selectionBehavior="RowSelector"
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
                               <Button design="Transparent" icon="delete" onClick={() => setWeg(true)}>Löschen</Button>
                               <Button design="Transparent" icon="copy" onClick={() => kopieren(form)}>Kopieren</Button>
                             </> : undefined}
                             endContent={<>
                               <Button design="Emphasized" disabled={busy || !form.name.trim()} onClick={speichern}>Speichern</Button>
                               <Button onClick={() => setForm(null)}>Abbrechen</Button>
                             </>} />}>
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
                               <Button design="Emphasized" disabled={busy || !massen.geaendert.length}
                                       onClick={() => aktion(() => api.put(`${PA}/plaetze-massen`, {
                                         ids: auswahl,
                                         felder: Object.fromEntries(massen.geaendert.map((k) => [k, massen.werte[k as keyof typeof massen.werte]])),
                                       }), async () => { setMassen(null); await laden(); })}>
                                 Auf {auswahl.length} Platz/Plätze anwenden
                               </Button>
                               <Button onClick={() => setMassen(null)}>Abbrechen</Button>
                             </>} />}>
          <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
            Vorbelegt mit den Werten von „{plaetze?.find((p) => auswahl.includes(p.id))?.name}“. Nur die Felder, die Sie hier ändern, werden für
            {' '}{plaetze?.filter((p) => auswahl.includes(p.id)).map((p) => p.name).join(', ')} übernommen. Bezeichnung, weitere Bezeichnungen und Reihenfolge bleiben je Platz erhalten.
          </MessageStrip>
          <PlatzFormular massen f={massen.werte} setF={(x) => {
            const werte = { ...massen.werte, ...x };
            const geaendert = (Object.keys(werte) as (keyof typeof werte)[])
              .filter((k) => MASSEN_FELDER.includes(k as string) && JSON.stringify(werte[k]) !== JSON.stringify(massen.basis[k])) as string[];
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

// ---------------------------------------------------------------- Tagesbelegung (mit Namen)
function Belegung({ aktion, busy }: { aktion: Aktion; busy: boolean }) {
  const [datum, setDatum] = useState(isoHeute);
  const [tag, setTag] = useState<{ datum: string; plaetze: TagPlatz[] } | null>(null);
  const [storno, setStorno] = useState<{ p: TagPlatz; b: Belegt } | null>(null);
  const laden = () => api.get<{ datum: string; plaetze: TagPlatz[] }>(`${PA}/tag?datum=${datum}`).then(setTag);
  useEffect(() => { setTag(null); laden(); }, [datum]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Toolbar design="Transparent">
        <Button icon="navigation-left-arrow" design="Transparent" onClick={() => setDatum(tagPlus(datum, -1))} />
        <DatePicker formatPattern="EEEE, dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datum} style={{ width: '14rem' }}
                    onChange={(e) => e.detail.valid && e.detail.value && setDatum(e.detail.value)} />
        <Button icon="navigation-right-arrow" design="Transparent" onClick={() => setDatum(tagPlus(datum, 1))} />
        {datum !== isoHeute() && <Button design="Transparent" onClick={() => setDatum(isoHeute())}>Heute</Button>}
        <ToolbarSpacer />
        <Text className="portal-muted">Belegung {tagText(datum)} – Portalbuchung anklicken zum Stornieren</Text>
      </Toolbar>
      {tag && tag.plaetze.length > 0 && <Kalender admin tag={tag} plaetze={tag.plaetze} onEigen={(p, b) => setStorno({ p, b })} />}
      {tag && !tag.plaetze.length && <MessageStrip hideCloseButton>Keine aktiven Plätze.</MessageStrip>}
      <ConfirmDialog open={!!storno} danger title="Termin stornieren" confirmText="Stornieren"
                     text={storno ? `${storno.p.name}, ${tagText(datum)} ${storno.b.von}–${storno.b.bis} Uhr (${storno.b.art}, ${storno.b.kunde}) stornieren?${storno.b.art === 'Abo' ? ' Nur dieser Termin – die Serie beenden Sie unter „Abos“.' : ''}` : ''}
                     onCancel={() => setStorno(null)}
                     onConfirm={() => { const s = storno!; setStorno(null); if (!busy) aktion(() => api.post(`${PA}/storno`, { bid: s.b.bid, datum }), laden); }} />
    </>
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
      <AnalyticalTable columns={columns} data={abos ?? []} loading={!abos} visibleRows={Math.max(abos?.length ?? 0, 3)} noDataText="Noch keine Abos über das Portal angelegt" />
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
          <ComboBox value={row.original.mitglied ?? ''} placeholder="Mitglied suchen" style={{ width: '16rem' }}
                    onSelectionChange={(e) => {
                      const adrnr = (e.detail.item as HTMLElement | null)?.dataset.k;
                      if (adrnr && adrnr !== row.original.adrnr) aktion(() => api.put(`${PA}/benutzer`, { benutzer_id: row.original.id, adrnr }), laden);
                    }}>
            {(d?.mitglieder ?? []).map((m) => <ComboBoxItem key={m.adrnr} data-k={m.adrnr} text={m.name} />)}
          </ComboBox>
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
      <AnalyticalTable columns={columns} data={liste} loading={!d} visibleRows={Math.min(Math.max(liste.length, 3), 15)} rowHeight={48} noDataText="Keine Benutzer" />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Gebucht wird immer für das Mitglied, dem der angemeldete Benutzer zugeordnet ist (dieselbe Zuordnung wie bei „Meine Trainingszeiten“).
        Zusätzlich braucht der Benutzer die Berechtigung „Platz buchen“ (Rollenpflege → Tennishalle).
      </MessageStrip>
    </>
  );
}
