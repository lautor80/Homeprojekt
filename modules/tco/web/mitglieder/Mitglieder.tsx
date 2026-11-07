import { useEffect, useState } from 'react';
import {
  Button, DatePicker, FlexBox, Input, List, ListItemStandard, MessageStrip, Option, Select, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { MG, type Liste, type Status } from './typen';
import { MitgliedDetail } from './Detail';
import { NeuDialog } from './NeuDialog';

const STATUS_TEXT: Record<Status, string> = { AKTIV: 'Aktive Mitglieder', AUSGETRETEN: 'Ausgetreten', KUNDEN: 'EP3-Kunden', ELTERN: 'Zahler / Eltern', ALLE: 'Alle Personen' };
const DATUM_TEXT: Record<string, string> = { EINGETRETEN: 'Eintritt', AUSGETRETEN: 'Austritt', ERFASST: 'Erfasst' };

export function Mitglieder() {
  const can = useCan();
  const edit = can('tco.mitglieder:edit');
  const [status, setStatus] = useState<Status>('AKTIV');
  const [suche, setSuche] = useState('');
  const [datumTyp, setDatumTyp] = useState('EINGETRETEN');
  const [von, setVon] = useState('');
  const [bis, setBis] = useState('');
  const [liste, setListe] = useState<Liste | null>(null);
  const [adrnr, setAdrnr] = useState<string | null>(() => new URLSearchParams(window.location.search).get('adrnr'));
  const [neu, setNeu] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const laden = () => {
    const q = new URLSearchParams({ status, datumTyp, ...(von ? { von } : {}), ...(bis ? { bis } : {}), ...(suche.trim() ? { suche: suche.trim() } : {}) });
    return api.get<Liste>(`${MG}/liste?${q}`).then(setListe).catch((e) => setError(e.message));
  };
  useEffect(() => { const t = setTimeout(laden, suche ? 250 : 0); return () => clearTimeout(t); }, [status, datumTyp, von, bis, suche]); // eslint-disable-line react-hooks/exhaustive-deps

  const waehlen = (a: string | null) => {
    setAdrnr(a);
    const u = new URL(window.location.href);
    if (a) u.searchParams.set('adrnr', a); else u.searchParams.delete('adrnr');
    window.history.replaceState(null, '', u);
  };

  return (
    <AppPage title="Mitglieder" subtitle={liste ? `${liste.anzahl.AKTIV} aktive Mitglieder · ${liste.anzahl.ALLE} Personen` : ''}
             actions={edit ? <Button icon="add-employee" design="Emphasized" onClick={() => setNeu(true)}>Neues Mitglied</Button> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      <FlexBox alignItems="Start" style={{ gap: '1rem' }} wrap="Wrap">
        <div style={{ flex: '0 0 21rem', maxWidth: '21rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <Select style={{ width: '100%', gridColumn: '1 / -1' }} onChange={(e) => setStatus((e.detail.selectedOption as HTMLElement).dataset.s as Status)}>
              {(Object.keys(STATUS_TEXT) as Status[]).map((s) => (
                <Option key={s} data-s={s} selected={s === status}>{`${STATUS_TEXT[s]}${liste ? ` (${liste.anzahl[s]})` : ''}`}</Option>
              ))}
            </Select>
            <Input style={{ width: '100%', gridColumn: '1 / -1' }} placeholder="Name oder Mitgliedsnummer" value={suche}
                   showClearIcon onInput={(e) => setSuche(e.target.value)} />
            <Select style={{ width: '100%', gridColumn: '1 / -1' }} onChange={(e) => setDatumTyp((e.detail.selectedOption as HTMLElement).dataset.t!)}>
              {Object.entries(DATUM_TEXT).map(([k, t]) => <Option key={k} data-t={k} selected={k === datumTyp}>{`${t} von … bis`}</Option>)}
            </Select>
            <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" placeholder="von" value={von} onChange={(e) => setVon(e.detail.value)} />
            <DatePicker style={{ width: '100%' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" placeholder="bis" value={bis} onChange={(e) => setBis(e.detail.value)} />
          </div>
          <Toolbar design="Transparent">
            <Title level="H5">{STATUS_TEXT[status]} ({liste?.zeilen.length ?? 0})</Title>
            <ToolbarSpacer />
            {(suche || von || bis || status !== 'AKTIV') && (
              <Button design="Transparent" icon="reset" onClick={() => { setSuche(''); setVon(''); setBis(''); setStatus('AKTIV'); setDatumTyp('EINGETRETEN'); }}>Zurücksetzen</Button>
            )}
          </Toolbar>
          <List onItemClick={(e) => waehlen((e.detail.item as HTMLElement).dataset.a!)} noDataText="Keine Personen zu dieser Auswahl">
            {liste?.zeilen.map((z) => (
              <ListItemStandard key={z.adrnr} data-a={z.adrnr} type="Active" selected={z.adrnr === adrnr}
                                icon={z.state === 'Positive' ? 'employee' : z.zahler ? 'employee-rejections' : 'money-bills'}
                                description={z.info} additionalText={z.status_txt} additionalTextState={z.state}>{z.name}</ListItemStandard>
            ))}
          </List>
        </div>
        <div style={{ flex: '1 1 44rem', minWidth: 0 }}>
          {adrnr
            ? <MitgliedDetail key={adrnr} adrnr={adrnr} edit={edit} onChanged={laden} onOpen={waehlen} />
            : <MessageStrip hideCloseButton>Bitte links ein Mitglied auswählen.</MessageStrip>}
        </div>
      </FlexBox>
      {neu && (
        <NeuDialog onClose={(a, text) => {
          setNeu(false);
          if (a) { if (text) toast(text, 6000); laden(); waehlen(a); }
        }} />
      )}
    </AppPage>
  );
}
