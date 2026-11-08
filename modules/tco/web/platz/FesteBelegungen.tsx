import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, Button, DatePicker, Dialog, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Select,
  Switch, Text, Title, ToggleButton, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { SperrHinweis, useSperre } from '@core/sperre';
import { TCO, dat } from '../util';

/**
 * Feste Platzbelegungen ohne Buchung: Jugendtraining, Sperrzeiten (z. B. Platzpflege), Veranstaltungen.
 * Sie erscheinen im Kalender für alle mit Bezeichnung und blockieren Buchungen. Aus EP3 übernommene Events sind nur lesbar.
 */
const PA = `${TCO}/platz/admin`;
type Aktion = (fn: () => Promise<unknown>, nachher?: () => unknown) => Promise<boolean>;
type Art = 'TRAINING' | 'SPERRE' | 'VERANSTALTUNG';
interface Fest {
  id: number; bezeichnung: string; art: Art; plaetze: number[]; wochentage: string; datum_von: string; datum_bis: string;
  zeit_von: string; zeit_bis: string; hinweis: string | null; aktiv: boolean; quelle: string; ext_id: string | null;
}
type Form = Omit<Fest, 'id' | 'quelle' | 'ext_id'> & { id?: number };
const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const ARTEN: Record<Art, string> = { TRAINING: 'Training', SPERRE: 'Sperrzeit', VERANSTALTUNG: 'Veranstaltung' };
const isoHeute = () => new Date().toLocaleDateString('sv-SE');
const zeiten = () => { const o: string[] = []; for (let m = 0; m <= 1440; m += 15) o.push(m === 1440 ? '24:00' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); return o; };
const wtText = (w: string) => (w === '1234567' ? 'täglich' : [...w].map((x) => WT[Number(x) - 1]).join(', '));

export function FesteBelegungen({ aktion, plaetze }: { aktion: Aktion; plaetze: { id: number; name: string }[] }) {
  const [liste, setListe] = useState<Fest[] | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [weg, setWeg] = useState<Fest | null>(null);
  const [alte, setAlte] = useState(false);
  const laden = () => api.get<{ liste: Fest[] }>(`${PA}/feste`).then((r) => setListe(r.liste));
  useEffect(() => { laden(); }, []);
  const heute = isoHeute();
  const zeilen = (liste ?? []).filter((f) => alte || f.datum_bis >= heute);
  const platzText = (ids: number[]) => (ids.length ? ids.map((i) => plaetze.find((p) => p.id === i)?.name ?? `#${i}`).join(', ') : 'alle Plätze');

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Bezeichnung', accessor: 'bezeichnung', minWidth: 180 },
    { Header: 'Art', accessor: 'art', width: 120, Cell: ({ value }: Cell) => ARTEN[value as Art] },
    { Header: 'Plätze', id: 'plaetze', minWidth: 160, Cell: ({ row }: Cell) => platzText(row.original.plaetze) },
    { Header: 'Zeitraum', id: 'zeitraum', width: 200, Cell: ({ row }: Cell) => (row.original.datum_von === row.original.datum_bis ? dat(row.original.datum_von) : `${dat(row.original.datum_von)} – ${dat(row.original.datum_bis)}`) },
    { Header: 'Tage', id: 'wt', width: 140, Cell: ({ row }: Cell) => (row.original.datum_von === row.original.datum_bis ? '–' : wtText(row.original.wochentage)) },
    { Header: 'Uhrzeit', id: 'zeit', width: 120, Cell: ({ row }: Cell) => `${row.original.zeit_von}–${row.original.zeit_bis}` },
    { Header: 'Quelle', accessor: 'quelle', width: 90, Cell: ({ value }: Cell) => (value === 'EP3' ? <ObjectStatus state="Information">EP3</ObjectStatus> : 'Portal') },
    { Header: 'Aktiv', accessor: 'aktiv', width: 80, Cell: ({ value }: Cell) => (value ? <ObjectStatus state="Positive">ja</ObjectStatus> : <ObjectStatus state="None">nein</ObjectStatus>) },
    {
      Header: '', id: 'aktion', width: 170,
      Cell: ({ row }: Cell) => (row.original.quelle === 'PORTAL' ? (
        <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
          <Button design="Transparent" icon="edit" onClick={() => { const { quelle: _q, ext_id: _e, ...f } = row.original as Fest; setForm(f); }} />
          <Button design="Transparent" icon="copy" tooltip="Kopieren" onClick={() => { const { id: _i, quelle: _q, ext_id: _e, ...f } = row.original as Fest; setForm({ ...f, bezeichnung: `${f.bezeichnung} (Kopie)` }); }} />
          <Button design="Transparent" icon="delete" onClick={() => setWeg(row.original)} />
        </div>
      ) : <Text className="portal-muted portal-small">in EP3 pflegen</Text>),
    },
  ];
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Training &amp; Sperrzeiten ({zeilen.length})</Title>
        <ToolbarSpacer />
        <Button design="Transparent" icon={alte ? 'filter' : 'history'} onClick={() => setAlte(!alte)}>{alte ? 'Nur aktuelle' : 'Auch vergangene'}</Button>
        <Button design="Emphasized" icon="add" onClick={() => setForm({ bezeichnung: 'Jugendtraining', art: 'TRAINING', plaetze: [], wochentage: '1', datum_von: heute, datum_bis: `${heute.slice(0, 4)}-09-30` > heute ? `${heute.slice(0, 4)}-09-30` : `${Number(heute.slice(0, 4)) + 1}-09-30`, zeit_von: '16:00', zeit_bis: '18:00', hinweis: null, aktiv: true })}>Neue Belegung</Button>
      </Toolbar>
      <AnalyticalTable columns={columns} data={zeilen} loading={!liste} minRows={1} visibleRows={Math.min(Math.max(zeilen.length, 3), 15)} rowHeight={44}
                       noDataText="Keine festen Belegungen – z. B. die Jugendtrainingszeiten hier anlegen" />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Feste Belegungen erscheinen im Buchungskalender für alle mit ihrer Bezeichnung und blockieren Buchungen (auch Serien und Abos).
        EP3-Events werden beim EP3-Import übernommen und dort gepflegt.
      </MessageStrip>
      {form && <FestDialog start={form} plaetze={plaetze} onClose={() => setForm(null)}
                           onSave={async (f) => { const ok = await aktion(() => (f.id ? api.put(`${PA}/feste/${f.id}`, f) : api.post(`${PA}/feste`, f)), laden); if (ok) setForm(null); }} />}
      <ConfirmDialog open={!!weg} danger title="Belegung löschen" confirmText="Löschen" text={`„${weg?.bezeichnung ?? ''}“ löschen? Die Zeiten werden wieder buchbar.`}
                     onCancel={() => setWeg(null)} onConfirm={() => { const f = weg!; setWeg(null); aktion(() => api.del(`${PA}/feste/${f.id}`), laden); }} />
    </>
  );
}

function FestDialog({ start, plaetze, onClose, onSave }: { start: Form; plaetze: { id: number; name: string }[]; onClose: () => void; onSave: (f: Form) => void }) {
  const [f, setF] = useState<Form>(start);
  const sperre = useSperre('PLATZBELEGUNG', f.id ? String(f.id) : null, true, { bezeichnung: f.bezeichnung });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const einmalig = f.datum_von === f.datum_bis;
  return createPortal(
    <Dialog open headerText={f.id ? `Belegung „${start.bezeichnung}“` : 'Neue feste Belegung'} style={{ width: 'min(44rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<><Button design="Emphasized" disabled={!sperre.eigen || !f.bezeichnung.trim()} onClick={() => onSave(f)}>Sichern</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      <SperrHinweis s={sperre} />
      <FormGrid>
        <FieldBox label="Bezeichnung" required><Input style={{ width: '100%' }} value={f.bezeichnung} maxlength={80} onInput={(e) => set('bezeichnung', e.target.value)} /></FieldBox>
        <FieldBox label="Art">
          <Select style={{ width: '100%' }} onChange={(e) => set('art', (e.detail.selectedOption as HTMLElement).dataset.a as Art)}>
            {(Object.keys(ARTEN) as Art[]).map((a) => <Option key={a} data-a={a} selected={a === f.art}>{ARTEN[a]}</Option>)}
          </Select>
        </FieldBox>
        <FieldBox label="Plätze (leer = alle)" wide>
          <MultiComboBox style={{ width: '100%' }} placeholder="alle Plätze"
                         onSelectionChange={(e) => set('plaetze', e.detail.items.map((i) => Number((i as HTMLElement).dataset.id)))}>
            {plaetze.map((p) => <MultiComboBoxItem key={p.id} data-id={p.id} text={p.name} selected={f.plaetze.includes(p.id)} />)}
          </MultiComboBox>
        </FieldBox>
        <FieldBox label="Von (Datum)" required>
          <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.datum_von}
                      onChange={(e) => e.detail.value && setF({ ...f, datum_von: e.detail.value, datum_bis: f.datum_bis < e.detail.value ? e.detail.value : f.datum_bis })} />
        </FieldBox>
        <FieldBox label="Bis (Datum)" required>
          <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.datum_bis} onChange={(e) => e.detail.value && set('datum_bis', e.detail.value)} />
        </FieldBox>
        {!einmalig && (
          <FieldBox label="Wochentage" required wide>
            <div className="portal-row">
              {WT.map((w, i) => {
                const k = String(i + 1);
                const an = f.wochentage.includes(k);
                return <ToggleButton key={k} pressed={an} onClick={() => set('wochentage', an ? f.wochentage.replace(k, '') : [...f.wochentage, k].sort().join(''))}>{w}</ToggleButton>;
              })}
            </div>
          </FieldBox>
        )}
        <FieldBox label="Uhrzeit von" required>
          <Select style={{ width: '100%' }} onChange={(e) => set('zeit_von', (e.detail.selectedOption as HTMLElement).dataset.z!)}>
            {zeiten().slice(0, -1).map((z) => <Option key={z} data-z={z} selected={z === f.zeit_von}>{z}</Option>)}
          </Select>
        </FieldBox>
        <FieldBox label="Uhrzeit bis" required>
          <Select style={{ width: '100%' }} onChange={(e) => set('zeit_bis', (e.detail.selectedOption as HTMLElement).dataset.z!)}>
            {zeiten().slice(1).map((z) => <Option key={z} data-z={z} selected={z === f.zeit_bis}>{z}</Option>)}
          </Select>
        </FieldBox>
        <FieldBox label="Hinweis im Kalender (optional)" wide>
          <Input style={{ width: '100%' }} value={f.hinweis ?? ''} maxlength={300} placeholder="z. B. Gruppe U12, Trainer Max" onInput={(e) => set('hinweis', e.target.value || null)} />
        </FieldBox>
        <FieldBox label="Aktiv"><Switch checked={f.aktiv} onChange={(e) => set('aktiv', e.target.checked)} /></FieldBox>
      </FormGrid>
      <Label style={{ display: 'block', marginTop: '0.5rem' }}>{einmalig ? `Einmalig am ${dat(f.datum_von)}` : `${wtText(f.wochentage)} vom ${dat(f.datum_von)} bis ${dat(f.datum_bis)}`}, {f.zeit_von}–{f.zeit_bis} Uhr</Label>
    </Dialog>,
    document.body,
  );
}
