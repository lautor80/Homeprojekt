import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BusyIndicator, Button, DatePicker, Dialog, Input, Label, Link, MessageStrip, ObjectStatus, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ResponsiveTable } from '@core/components/ResponsiveTable';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { dat } from '../util';
import { MODUS_TEXT, STATUS_TEXT, T, type Modus, type Turnier, type TurnierStatus } from './api';

/**
 * Turniere (Sport → Turniere): Übersicht aller Turniere mit Modus, Status, Meldestand und Meldeschluss;
 * „Neues Turnier“ legt ein Turnier im Entwurf an und öffnet die Detailseite.
 */
interface Zeile {
  id: number; kennung: string; name: string; modus: Modus; status: TurnierStatus; meldeschluss: string | null;
  max_teilnehmer: number | null; created_at: string; gemeldet: number; warteliste: number;
}

export const STATUS_STATE: Record<TurnierStatus, 'None' | 'Information' | 'Positive' | 'Critical'> = {
  entwurf: 'None', anmeldung: 'Information', laeuft: 'Positive', beendet: 'Critical',
};

/** Kennung aus dem Namen: Kleinbuchstaben, Ziffern, Bindestrich; Umlaute umschreiben („Clubmeisterschaft Jüngste 2027“ → „clubmeisterschaft-juengste-2027“) */
export function kennungVorschlag(name: string): string {
  return name.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '');
}
const KENNUNG_OK = /^[a-z0-9][a-z0-9-]{1,59}$/;

export function Turniere() {
  const navigate = useNavigate();
  const darfPflegen = useCan()('tco.turnier:edit');
  const { data, error } = useLoad(() => api.get<Zeile[]>(T), []);
  const [neu, setNeu] = useState(false);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Turnier', accessor: 'name', minWidth: 200,
      Cell: ({ row }: Cell) => <Link onClick={() => navigate(`/tco/turniere/${row.original.id}`)}>{row.original.name}</Link> },
    { Header: 'Modus', accessor: 'modus', minWidth: 170, Cell: ({ value }: Cell) => MODUS_TEXT[value as Modus] },
    { Header: 'Status', accessor: 'status', width: 140,
      Cell: ({ value }: Cell) => <ObjectStatus state={STATUS_STATE[value as TurnierStatus]}>{STATUS_TEXT[value as TurnierStatus]}</ObjectStatus> },
    { Header: 'Gemeldet', accessor: 'gemeldet', width: 100, hAlign: 'End',
      Cell: ({ row }: Cell) => `${row.original.gemeldet}${row.original.max_teilnehmer ? ` / ${row.original.max_teilnehmer}` : ''}` },
    { Header: 'Warteliste', accessor: 'warteliste', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => (value ? String(value) : '–') },
    { Header: 'Meldeschluss', accessor: 'meldeschluss', width: 120, Cell: ({ value }: Cell) => (value ? dat(value) : '–') },
  ];

  return (
    <AppPage title="Turniere" subtitle="KO-Turnier mit Nebenrunde, Monats-Gruppenliga, Doppel-/Mixed-Spaßturnier"
             actions={darfPflegen ? <Button design="Emphasized" icon="add" onClick={() => setNeu(true)}>Neues Turnier</Button> : undefined}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!data ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : (
        <Section title="Turniere" count={data.length} flush>
          <ResponsiveTable columns={columns} data={data} visibleRows={Math.min(Math.max(data.length, 1), 25)}
                           onRowClick={(e) => navigate(`/tco/turniere/${e.detail.row.original.id}`)}
                           noDataText={darfPflegen ? 'Noch keine Turniere – oben „Neues Turnier“ wählen.' : 'Noch keine Turniere.'} />
        </Section>
      )}
      {neu && <TurnierStammDialog onClose={() => setNeu(false)} onGespeichert={(id) => navigate(`/tco/turniere/${id}`)} />}
    </AppPage>
  );
}

/**
 * Turnier anlegen (ohne `turnier`) oder Stammdaten ändern. Beim Ändern gehen alle Felder aus dem Server-Schema mit,
 * die Einstellungen des Modus unverändert (sie pflegt der Reiter des Modus).
 */
export function TurnierStammDialog({ turnier, onClose, onGespeichert }: { turnier?: Turnier; onClose: () => void; onGespeichert: (id: number) => void }) {
  const [f, setF] = useState({
    name: turnier?.name ?? '', kennung: turnier?.kennung ?? '', modus: (turnier?.modus ?? 'ko') as Modus, status: (turnier?.status ?? 'entwurf') as TurnierStatus,
    meldeschluss: turnier?.meldeschluss ?? '', max_teilnehmer: turnier?.max_teilnehmer != null ? String(turnier.max_teilnehmer) : '', beschreibung: turnier?.beschreibung ?? '',
  });
  /** Kennung folgt dem Namen, bis sie von Hand geändert wurde (beim Ändern nie automatisch) */
  const [kennungFrei, setKennungFrei] = useState(!turnier);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (kennungFrei) setF((x) => ({ ...x, kennung: kennungVorschlag(x.name) })); }, [f.name, kennungFrei]);

  const max = f.max_teilnehmer.trim() ? Number(f.max_teilnehmer) : null;
  const maxOk = max == null || (Number.isInteger(max) && max >= 2 && max <= 256);
  const ok = !!f.name.trim() && KENNUNG_OK.test(f.kennung) && maxOk;

  async function sichern() {
    setBusy(true); setError(null);
    const body = {
      name: f.name.trim(), kennung: f.kennung, modus: f.modus, status: f.status, beschreibung: f.beschreibung.trim() || null,
      meldeschluss: f.meldeschluss || null, max_teilnehmer: max,
      // Einstellungen unverändert; bei Moduswechsel die Standardwerte des neuen Modus (setzt der Server)
      einstellungen: turnier && turnier.modus === f.modus ? turnier.einstellungen : {},
    };
    try {
      if (turnier) { await api.put(`${T}/${turnier.id}`, body); onGespeichert(turnier.id); }
      else { const r = await api.post<{ id: number }>(T, body); onGespeichert(r.id); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText={turnier ? 'Turnier bearbeiten' : 'Neues Turnier'} style={{ width: 'min(32rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<>
              <Button design="Emphasized" icon="save" disabled={!ok} loading={busy} onClick={sichern}>{turnier ? 'Sichern' : 'Anlegen'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label showColon required>Name</Label>
        <Input value={f.name} maxlength={120} placeholder="z. B. Clubmeisterschaft 2027" onInput={(e) => setF({ ...f, name: e.target.value })} />
        <Label showColon required>Kennung (für die öffentlichen Links)</Label>
        <Input value={f.kennung} maxlength={60} valueState={f.kennung && !KENNUNG_OK.test(f.kennung) ? 'Negative' : 'None'}
               valueStateMessage={<div>Kleinbuchstaben, Ziffern und Bindestrich, mindestens 2 Zeichen.</div>}
               onInput={(e) => { setKennungFrei(false); setF({ ...f, kennung: e.target.value.toLowerCase() }); }} />
        <Text className="portal-muted portal-small">Anmeldung unter /turnier?t={f.kennung || '…'}{turnier ? ' – ändert sich die Kennung, gelten bereits verteilte Links nicht mehr.' : ''}</Text>
        <Label showColon required>Modus</Label>
        <Select onChange={(e) => setF({ ...f, modus: (e.detail.selectedOption as HTMLElement).dataset.m as Modus })}>
          {(Object.keys(MODUS_TEXT) as Modus[]).map((m) => <Option key={m} data-m={m} selected={f.modus === m}>{MODUS_TEXT[m]}</Option>)}
        </Select>
        {turnier && <>
          <Label showColon>Status</Label>
          <Select onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.s as TurnierStatus })}>
            {(Object.keys(STATUS_TEXT) as TurnierStatus[]).map((s) => <Option key={s} data-s={s} selected={f.status === s}>{STATUS_TEXT[s]}</Option>)}
          </Select>
        </>}
        <Label showColon>Meldeschluss</Label>
        <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.meldeschluss} onChange={(e) => setF({ ...f, meldeschluss: e.detail.value })} />
        <Label showColon>Max. Teilnehmende (leer = unbegrenzt; danach Warteliste)</Label>
        <Input type="Number" value={f.max_teilnehmer} valueState={maxOk ? 'None' : 'Negative'} valueStateMessage={<div>Zwischen 2 und 256.</div>}
               onInput={(e) => setF({ ...f, max_teilnehmer: e.target.value })} />
        <Label showColon>Beschreibung (erscheint auf dem Anmeldeformular)</Label>
        <TextArea rows={4} value={f.beschreibung} maxlength={2000} placeholder="Termine, Ort, Startgeld, Zählweise …" onInput={(e) => setF({ ...f, beschreibung: e.target.value })} />
      </div>
    </Dialog>
  );
}
