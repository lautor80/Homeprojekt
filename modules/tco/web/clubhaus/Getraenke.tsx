import { useEffect, useMemo, useState } from 'react';
import { AnalyticalTable, Button, DatePicker, FlexBox, Input, Label, MessageStrip, Option, Select, Title, Toolbar } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import { CH } from './Clubhaus';

interface Getraenk { prod_key: string; valid_from: string; valid_to: string; text: string; preis: number; menge: number }
const heute = () => new Date().toLocaleDateString('sv-SE');

/** Getränkestamm: Flaschen je Kiste und VK je Flasche, zeitabhängig (tco.produkte ab Schlüssel 100) */
export function Getraenke({ edit }: { edit: boolean }) {
  const [l, setL] = useState<Getraenk[] | null>(null);
  const [f, setF] = useState({ prod_key: '', text: '', menge: '', preis: '', ab: heute() });
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Getraenk[]>(`${CH}/getraenke`).then(setL).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);
  const aktuell = useMemo(() => {
    const m = new Map<string, Getraenk>();
    for (const g of l ?? []) if (!m.has(g.prod_key) || (g.valid_from <= heute() && g.valid_to >= heute())) m.set(g.prod_key, g);
    return [...m.values()];
  }, [l]);
  const waehlen = (key: string) => {
    const g = aktuell.find((x) => x.prod_key === key);
    setF({ prod_key: key, text: g?.text ?? '', menge: g ? String(g.menge).replace('.', ',') : '', preis: g ? String(g.preis).replace('.', ',') : '', ab: heute() });
  };
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Schlüssel', accessor: 'prod_key', width: 90 },
    { Header: 'Getränk', accessor: 'text', minWidth: 200 },
    { Header: 'Gültig ab', accessor: 'valid_from', width: 110, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Gültig bis', accessor: 'valid_to', width: 110, Cell: ({ value }: Cell) => (value === '9999-12-31' ? 'unbefristet' : dat(value)) },
    { Header: 'Flaschen je Kiste', accessor: 'menge', width: 140, hAlign: 'End', Cell: ({ value }: Cell) => value.toLocaleString('de-DE') },
    { Header: 'VK je Flasche', accessor: 'preis', width: 120, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'VK je Kiste', id: 'kiste', width: 120, hAlign: 'End', accessor: (g: Record<string, any>) => g.menge * g.preis, Cell: ({ value }: Cell) => eur(value) },
  ];
  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {edit && (
        <FlexBox wrap="Wrap" alignItems="End" style={{ gap: '0.75rem', margin: '0.5rem 0 1rem' }}>
          <FlexBox direction="Column"><Label>Getränk</Label>
            <Select style={{ width: '16rem' }} onChange={(e) => waehlen((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
              <Option data-k="" selected={!f.prod_key}>Neues Getränk …</Option>
              {aktuell.map((g) => <Option key={g.prod_key} data-k={g.prod_key} selected={g.prod_key === f.prod_key}>{g.text}</Option>)}
            </Select>
          </FlexBox>
          <FlexBox direction="Column"><Label>Bezeichnung</Label><Input value={f.text} style={{ width: '16rem' }} onInput={(e) => setF({ ...f, text: e.target.value })} /></FlexBox>
          <FlexBox direction="Column"><Label>Flaschen je Kiste</Label><Input value={f.menge} style={{ width: '8rem' }} onInput={(e) => setF({ ...f, menge: e.target.value })} /></FlexBox>
          <FlexBox direction="Column"><Label>VK je Flasche (€)</Label><Input value={f.preis} style={{ width: '8rem' }} onInput={(e) => setF({ ...f, preis: e.target.value })} /></FlexBox>
          <FlexBox direction="Column"><Label>gültig ab</Label>
            <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.ab} style={{ width: '10rem' }} onChange={(e) => setF({ ...f, ab: e.detail.value })} />
          </FlexBox>
          <Button design="Emphasized" icon="save" disabled={!f.text.trim() || !f.menge || !f.preis}
                  onClick={async () => {
                    setError(null);
                    try {
                      const r = await api.post<{ text: string }>(`${CH}/getraenke`, { prod_key: f.prod_key || null, text: f.text, menge: Number(f.menge.replace(',', '.')), preis: Number(f.preis.replace(',', '.')), ab: f.ab });
                      toast(r.text, 5000); laden();
                    } catch (e) { setError((e as Error).message); }
                  }}>{f.prod_key ? 'Preis ab Datum speichern' : 'Getränk anlegen'}</Button>
        </FlexBox>
      )}
      <Toolbar design="Transparent"><Title level="H5">Getränke ({aktuell.length})</Title></Toolbar>
      <AnalyticalTable minRows={1} columns={columns} data={l ?? []} loading={!l} visibleRows={Math.max(l?.length ?? 0, 1)} groupable
                       noDataText="Noch keine Getränke (Schlüssel ab 100 in der Produkttabelle)" />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Ein neuer Preis ab einem Datum grenzt den bisherigen Satz am Vortag ab. Maßgeblich für den VK in der Forderungsliste ist das Rechnungsdatum.
      </MessageStrip>
    </>
  );
}
