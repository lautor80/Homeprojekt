import { useState } from 'react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as CellInstance } from '@ui5/webcomponents-react';
import { useNavigate } from 'react-router-dom';
import { AnalyticalTable, Button, Input, Icon, MessageStrip, ObjectStatus } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';

export interface Kontakt {
  id: string;
  nummer: string;
  name: string;
  firma: string | null;
  email: string | null;
  telefon: string | null;
  notiz: string | null;
  aktiv: boolean;
}

export function KontakteList() {
  const can = useCan();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get<Kontakt[]>('/api/m/beispiel/kontakte' + qs({ q })), [q]);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Nummer', accessor: 'nummer', width: 110 },
    { Header: 'Name', accessor: 'name' },
    { Header: 'Firma', accessor: 'firma' },
    { Header: 'E-Mail', accessor: 'email' },
    { Header: 'Telefon', accessor: 'telefon', width: 150 },
    {
      Header: 'Status', accessor: 'aktiv', width: 110,
      Cell: ({ value }: CellInstance) =>
        value ? <ObjectStatus state="Positive">Aktiv</ObjectStatus> : <ObjectStatus state="Critical">Inaktiv</ObjectStatus>,
    },
  ];

  return (
    <AppPage
      title="Kontakte"
      subtitle={list.data ? `${list.data.length} Einträge` : undefined}
      actions={<>
        <Input
          placeholder="Name, Firma, Nummer, E-Mail"
          value={search}
          showClearIcon
          icon={<Icon name="search" />}
          onInput={(e) => setSearch(e.target.value)}
          onChange={() => setQ(search)}
        />
        {can('beispiel.kontakte:edit') && (
          <Button design="Emphasized" icon="add" onClick={() => navigate('/beispiel/kontakte/neu')}>Anlegen</Button>
        )}
      </>}
    >
      {list.error && <MessageStrip design="Negative">{list.error}</MessageStrip>}
      <AnalyticalTable
        columns={columns}
        data={list.data ?? []}
        loading={list.loading}
        sortable
        filterable
        visibleRowCountMode="Auto"
        style={{ height: 'calc(100vh - 220px)' }}
        noDataText="Keine Kontakte gefunden"
        onRowClick={(e) => navigate(`/beispiel/kontakte/${(e.detail.row.original as Kontakt).id}`)}
      />
    </AppPage>
  );
}
