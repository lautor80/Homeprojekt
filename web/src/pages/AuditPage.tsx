import { useState } from 'react';
import { feld } from '../components/Varianten';
import { AnalyticalTable, Button, DatePicker, Input, MessageStrip, Option, Select } from '@ui5/webcomponents-react';
import { api, qs } from '../api';
import { AppPage } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import { FieldBox } from '../components/FormFields';
import { changeColumns, flattenDocs, type ChangeDoc } from '../components/ChangeHistory';

interface ObjType { type: string; text: string }

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

/** Freie Auswertung aller Änderungsbelege (z. B. für Kassenprüfer). */
export function AuditPage() {
  const types = useLoad(() => api.get<ObjType[]>('/api/audit/object-types'));
  const [f, setF] = useState({ objectType: '', objectKey: '', username: '', from: daysAgo(30), to: today() });
  const [query, setQuery] = useState(f);
  const docs = useLoad(() => api.get<ChangeDoc[]>('/api/audit' + qs(query)), [query]);

  const filter = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem', alignItems: 'end', padding: '0.5rem 0' }}>
      <FieldBox label="Objekt">
        <Select onChange={(e) => setF({ ...f, objectType: e.detail.selectedOption.dataset.type ?? '' })}>
          <Option data-type="" selected={!f.objectType}>(alle)</Option>
          {(types.data ?? []).map((t) => (
            <Option key={t.type} data-type={t.type} selected={f.objectType === t.type}>{t.text}</Option>
          ))}
        </Select>
      </FieldBox>
      <FieldBox label="Schlüssel"><Input value={f.objectKey} onInput={(e) => setF({ ...f, objectKey: e.target.value })} /></FieldBox>
      <FieldBox label="Benutzer"><Input value={f.username} onInput={(e) => setF({ ...f, username: e.target.value })} /></FieldBox>
      <FieldBox label="Von"><DatePicker formatPattern="yyyy-MM-dd" value={f.from} onChange={(e) => setF({ ...f, from: e.detail.value })} /></FieldBox>
      <FieldBox label="Bis"><DatePicker formatPattern="yyyy-MM-dd" value={f.to} onChange={(e) => setF({ ...f, to: e.detail.value })} /></FieldBox>
      <Button design="Emphasized" icon="search" onClick={() => setQuery({ ...f })}>Suchen</Button>
    </div>
  );

  return (
    <AppPage varianten={{ repid: 'core.audit', ansicht: { f, query }, onAnwenden: (a) => { setF(feld(a, 'f', f)); setQuery(feld(a, 'query', query)); } }} title="Änderungsbelege" subtitle="Wer hat was wann geändert (max. 500 Belege je Suche)" header={filter}>
      {docs.error && <MessageStrip design="Negative">{docs.error}</MessageStrip>}
      <AnalyticalTable
        columns={changeColumns(true)}
        data={docs.data ? flattenDocs(docs.data) : []}
        loading={docs.loading}
        filterable
        sortable
        groupable
        scaleWidthMode="Smart"
        visibleRowCountMode="Auto"
        style={{ height: 'calc(100vh - 330px)', minHeight: 300 }}
        noDataText="Keine Änderungsbelege im Zeitraum"
      />
    </AppPage>
  );
}
