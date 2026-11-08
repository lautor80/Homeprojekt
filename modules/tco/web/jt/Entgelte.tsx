import { useEffect, useMemo, useState } from 'react';
import {
  AnalyticalTable, Button, ComboBox, ComboBoxItem, DatePicker, FlexBox, Input, Label, MessageStrip, ObjectStatus,
  Option, Select, SegmentedButton, SegmentedButtonItem, Text, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat, eur } from '../util';

const J = `${TCO}/jt`;

interface Entgelt { adrnr: string; trainer: string; valid_from: string | null; valid_to: string; betrag: number; status: 'OLD' | 'CUR' | 'FUT'; status_txt: string; aktiv: boolean }
interface Trainer { adrnr: string; name: string; steuernummer: string; satz: number | null; benutzer_id: string | null; benutzer: string | null }
interface Daten { entgelte: Entgelt[]; trainer: Trainer[]; mitglieder: { adrnr: string; name: string; trainer: boolean }[]; benutzer: { id: string; name: string; username: string }[] }

const STATE = { OLD: 'None', CUR: 'Positive', FUT: 'Information' } as const;
const FILTER = [['OLD', 'Abgelaufen'], ['CUR', 'Aktuell'], ['FUT', 'Künftig'], ['ALL', 'Alle']] as const;
const isoHeute = () => new Date().toLocaleDateString('sv-SE');

/** Wert, der beim Verlassen des Feldes gespeichert wird */
function Feld({ wert, disabled, width, onSave }: { wert: string; disabled?: boolean; width: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(wert);
  useEffect(() => setV(wert), [wert]);
  return <Input value={v} disabled={disabled} style={{ width }} onInput={(e) => setV(e.target.value)} onChange={() => v !== wert && onSave(v)} />;
}

/**
 * teil = 'entgelte': Stundensätze je Trainer; teil = 'trainer': Trainerliste mit Steuernummer und
 * Portal-Benutzer für „Meine Trainingszeiten“ (eigener Reiter in der Abrechnung Jugendtraining).
 */
export function Entgelte({ onChanged, teil = 'entgelte' }: { onChanged: () => void; teil?: 'entgelte' | 'trainer' }) {
  const can = useCan();
  const edit = can('tco.jt:entgelte');
  const [d, setD] = useState<Daten | null>(null);
  const [filter, setFilter] = useState<string>('CUR');
  const [neu, setNeu] = useState({ adrnr: '', ab: isoHeute(), betrag: '' });
  const [neuTrainer, setNeuTrainer] = useState('');
  const [weg, setWeg] = useState<Entgelt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const laden = () => api.get<Daten>(`${J}/entgelte`).then((r) => {
    setD(r);
    setNeu((n) => ({ ...n, adrnr: n.adrnr && r.trainer.some((t) => t.adrnr === n.adrnr) ? n.adrnr : r.trainer[0]?.adrnr ?? '' }));
  }).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  async function aktion(fn: () => Promise<{ text: string }>) {
    setError(null);
    try { toast((await fn()).text, 5000); await laden(); onChanged(); } catch (e) { setError((e as Error).message); }
  }

  const n = useMemo(() => Object.fromEntries(['OLD', 'CUR', 'FUT'].map((k) => [k, d?.entgelte.filter((e) => e.status === k).length ?? 0])), [d]);
  const daten = (d?.entgelte ?? []).filter((e) => filter === 'ALL' || e.status === filter);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Trainer', accessor: 'trainer', minWidth: 180 },
    { Header: 'Gültig ab', accessor: 'valid_from', width: 110, Cell: ({ value }: Cell) => (value ? dat(value) : '–') },
    {
      Header: 'Gültig bis', accessor: 'valid_to', width: 170,
      Cell: ({ row }: Cell) => (edit
        ? <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={row.original.valid_to} style={{ width: '10rem' }}
                      onChange={(e) => e.detail.valid && e.detail.value && e.detail.value !== row.original.valid_to && aktion(() => api.put(`${J}/entgelte`, {
                        adrnr: row.original.adrnr, validToAlt: row.original.valid_to, valid_to: e.detail.value, betrag: row.original.betrag,
                      }))} />
        : row.original.valid_to === '9999-12-31' ? 'unbefristet' : dat(row.original.valid_to)),
    },
    {
      Header: '€ je Std.', accessor: 'betrag', width: 120, hAlign: 'End',
      Cell: ({ row }: Cell) => (edit
        ? <Feld wert={String(row.original.betrag).replace('.', ',')} width="6rem"
                onSave={(v) => aktion(() => api.put(`${J}/entgelte`, { adrnr: row.original.adrnr, validToAlt: row.original.valid_to, valid_to: row.original.valid_to, betrag: Number(v.replace(',', '.')) }))} />
        : eur(row.original.betrag)),
    },
    { Header: 'Status', accessor: 'status_txt', width: 150, Cell: ({ row }: Cell) => <ObjectStatus state={STATE[row.original.status as 'OLD']}>{row.original.status_txt}</ObjectStatus> },
    { Header: '', id: 'del', width: 60, disableSortBy: true, Cell: ({ row }: Cell) => (edit ? <Button icon="delete" design="Transparent" onClick={() => setWeg(row.original)} /> : null) },
  ];

  const trainerColumns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Trainer', accessor: 'name', minWidth: 180 },
    { Header: 'Aktuelles Entgelt', accessor: 'satz', width: 140, hAlign: 'End', Cell: ({ value }: Cell) => (value === null ? <ObjectStatus state="Critical">keins</ObjectStatus> : `${eur(value)}/Std.`) },
    {
      Header: 'Steuernummer (für den Zeitnachweis)', accessor: 'steuernummer', width: 280,
      Cell: ({ row }: Cell) => (edit
        ? <Feld wert={row.original.steuernummer} width="14rem" onSave={(v) => aktion(() => api.put(`${J}/trainer`, { adrnr: row.original.adrnr, aktiv: true, steuernummer: v }))} />
        : row.original.steuernummer || '–'),
    },
    {
      Header: 'Portal-Benutzer (Meine Trainingszeiten)', id: 'benutzer', width: 300, disableSortBy: true,
      Cell: ({ row }: Cell) => (edit
        ? (
          <Select style={{ width: '17rem' }}
                  onChange={(e) => {
                    const id = (e.detail.selectedOption as HTMLElement).dataset.k || null;
                    aktion(() => api.put<{ text: string }>(`${J}/trainer/benutzer`, { adrnr: row.original.adrnr, benutzer_id: id }));
                  }}>
            <Option data-k="" selected={!row.original.benutzer_id}>– kein Benutzer –</Option>
            {(d?.benutzer ?? []).map((u) => (
              <Option key={u.id} data-k={u.id} selected={u.id === row.original.benutzer_id}>{`${u.name} (${u.username})`}</Option>
            ))}
          </Select>
        )
        : row.original.benutzer || '–'),
    },
    {
      Header: '', id: 'aus', width: 210, disableSortBy: true,
      Cell: ({ row }: Cell) => (edit ? <Button icon="decline" design="Transparent" onClick={() => aktion(() => api.put(`${J}/trainer`, { adrnr: row.original.adrnr, aktiv: false }))}>Nicht mehr Trainer</Button> : null),
    },
  ];

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {teil === 'entgelte' && (
        <>
      <Toolbar design="Transparent">
        <Title level="H5">Trainerentgelte (Euro je Stunde)</Title>
        <SegmentedButton onSelectionChange={(e) => setFilter((e.detail.selectedItems[0] as HTMLElement).dataset.f!)} style={{ marginInlineStart: '1rem' }}>
          {FILTER.map(([k, t]) => <SegmentedButtonItem key={k} data-f={k} selected={filter === k}>{`${t} (${k === 'ALL' ? d?.entgelte.length ?? 0 : n[k]})`}</SegmentedButtonItem>)}
        </SegmentedButton>
        <ToolbarSpacer />
      </Toolbar>
      {edit && (
        <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem', margin: '0.25rem 0 0.75rem' }}>
          <Label>Neues Entgelt für</Label>
          <ComboBox value={d?.trainer.find((t) => t.adrnr === neu.adrnr)?.name ?? ''} style={{ width: '16rem' }} placeholder="Trainer wählen"
                    onSelectionChange={(e) => setNeu({ ...neu, adrnr: (e.detail.item as HTMLElement | null)?.dataset.k ?? '' })}>
            {(d?.trainer ?? []).map((t) => <ComboBoxItem key={t.adrnr} data-k={t.adrnr} text={t.name} />)}
          </ComboBox>
          <Label>gültig ab</Label>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={neu.ab} style={{ width: '9.5rem' }} onChange={(e) => setNeu({ ...neu, ab: e.detail.value })} />
          <Input value={neu.betrag} placeholder="€/Std." style={{ width: '6rem', textAlign: 'end' }} onInput={(e) => setNeu({ ...neu, betrag: e.target.value })} />
          <Button icon="add" disabled={!neu.adrnr || !neu.ab || !neu.betrag.trim()}
                  onClick={() => aktion(async () => {
                    const r = await api.post<{ text: string }>(`${J}/entgelte`, { adrnr: neu.adrnr, ab: neu.ab, betrag: Number(neu.betrag.replace(',', '.')) });
                    setNeu({ ...neu, betrag: '' });
                    return r;
                  })}>Anlegen</Button>
          <Text style={{ color: 'var(--sapContent_LabelColor)' }}>Der bis dahin gültige Satz wird am Vortag automatisch abgegrenzt.</Text>
        </FlexBox>
      )}
      <AnalyticalTable columns={columns} data={daten} loading={!d} visibleRows={Math.max(daten.length, 3)} noDataText="Keine Entgelte in dieser Auswahl" />

        </>
      )}
      {teil === 'trainer' && (
        <>
      <Toolbar design="Transparent">
        <Title level="H5">Trainer ({d?.trainer.length ?? 0})</Title>
        <ToolbarSpacer />
        {edit && <>
          <ComboBox value={d?.mitglieder.find((x) => x.adrnr === neuTrainer)?.name ?? ''} placeholder="Mitglied suchen" style={{ width: '16rem' }}
                    onSelectionChange={(e) => setNeuTrainer((e.detail.item as HTMLElement | null)?.dataset.k ?? '')}>
            {(d?.mitglieder ?? []).filter((x) => !x.trainer).map((x) => <ComboBoxItem key={x.adrnr} data-k={x.adrnr} text={x.name} />)}
          </ComboBox>
          <Button icon="add-employee" disabled={!neuTrainer} onClick={() => aktion(async () => {
            const r = await api.put<{ text: string }>(`${J}/trainer`, { adrnr: neuTrainer, aktiv: true });
            setNeuTrainer('');
            return r;
          })}>Als Trainer aufnehmen</Button>
        </>}
      </Toolbar>
      <AnalyticalTable columns={trainerColumns} data={d?.trainer ?? []} loading={!d} visibleRows={Math.max(d?.trainer.length ?? 0, 2)} noDataText="Noch keine Trainer" />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        „Meine Trainingszeiten“: Ist einem Trainer ein Portal-Benutzer zugeordnet und hat dieser die Berechtigung „Meine Trainingszeiten“
        (Rollenpflege → Jugend), meldet der Trainer seine Zeiten selbst zurück – ausschließlich für sich, ohne Einblick in andere Trainer.
      </MessageStrip>

        </>
      )}
      <ConfirmDialog open={!!weg} danger title="Entgelt löschen"
                     text={weg ? `Satz ${eur(weg.betrag)} von ${weg.trainer} bis ${weg.valid_to === '9999-12-31' ? 'unbefristet' : dat(weg.valid_to)} löschen?` : ''}
                     confirmText="Löschen" onCancel={() => setWeg(null)}
                     onConfirm={() => { const w = weg!; setWeg(null); aktion(() => api.post(`${J}/entgelte/loeschen`, { adrnr: w.adrnr, valid_to: w.valid_to })); }} />
    </>
  );
}
