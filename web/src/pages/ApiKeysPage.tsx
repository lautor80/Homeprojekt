import { useMemo, useState } from 'react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as CellInstance } from '@ui5/webcomponents-react';
import {
  AnalyticalTable, Bar, Button, DatePicker, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import { FieldBox, FormGrid, TextField } from '../components/FormFields';
import { ChangeHistoryButton, fmtDateTime } from '../components/ChangeHistory';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useCan } from '../session';
import { toast } from '../toast';
import { SperrHinweis, useSperre } from '../sperre';
import { PermissionEditor, type PermGroup } from '../components/PermissionEditor';

interface ApiKey {
  id: string; module: string; moduleName: string; name: string; prefix: string; permissions: string[];
  expires_on: string | null; active: boolean; status: 'Aktiv' | 'Gesperrt' | 'Abgelaufen';
  created_at: string; created_by: string; last_used_at: string | null; last_used_ip: string | null;
}
type Edit = { id?: string; module: string; name: string; permissions: string[]; expires_on: string | null; active?: boolean };

const statusState = { Aktiv: 'Positive', Gesperrt: 'Negative', Abgelaufen: 'Critical' } as const;
const datum = (v: string | null) => (v ? v.split('-').reverse().join('.') : '');

export function ApiKeysPage() {
  const can = useCan();
  const darfAendern = can('core.apikeys:edit');
  const keys = useLoad(() => api.get<ApiKey[]>('/api/admin/api-keys'));
  const catalog = useLoad(() => api.get<PermGroup[]>('/api/admin/permissions'));
  const modules = useMemo(() => (catalog.data ?? []).filter((g) => g.module !== 'core'), [catalog.data]);
  const [edit, setEdit] = useState<Edit | null>(null);
  const original = edit?.id ? (keys.data ?? []).find((k) => k.id === edit.id) : undefined;
  const sperre = useSperre('API_KEY', original ? `${original.module}/${original.name}` : null, darfAendern, { bezeichnung: `API-Schlüssel ${edit?.name ?? ''}` });
  const mayEdit = darfAendern && sperre.eigen;
  const [shown, setShown] = useState<{ key: string; module: string } | null>(null);
  const [confirm, setConfirm] = useState<'sperren' | 'entsperren' | 'rotate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const modulKatalog = modules.filter((g) => g.module === edit?.module);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const save = () => run(async () => {
    const body = { name: edit!.name, permissions: edit!.permissions, expires_on: edit!.expires_on || null };
    if (edit!.id) {
      await api.put(`/api/admin/api-keys/${edit!.id}`, body);
      toast('API-Schlüssel gesichert');
    } else {
      const r = await api.post<{ key: string }>('/api/admin/api-keys', { ...body, module: edit!.module });
      setShown({ key: r.key, module: edit!.module });
    }
    setEdit(null);
    keys.reload();
  });

  const action = (reason: string) => run(async () => {
    const was = confirm;
    setConfirm(null);
    if (was === 'rotate') {
      const r = await api.post<{ key: string }>(`/api/admin/api-keys/${edit!.id}/rotate`);
      setShown({ key: r.key, module: edit!.module });
    } else {
      await api.post(`/api/admin/api-keys/${edit!.id}/active`, { active: was === 'entsperren', reason });
      toast(was === 'sperren' ? 'API-Schlüssel gesperrt' : 'API-Schlüssel entsperrt');
    }
    setEdit(null);
    keys.reload();
  });

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Projekt / Modul', accessor: 'moduleName', id: 'modul', width: 170, disableGroupBy: false },
    { Header: 'Name', accessor: 'name', minWidth: 140 },
    { Header: 'Schlüssel', accessor: 'prefix', width: 210, Cell: ({ value }: CellInstance) => <Text>{value}…</Text> },
    { Header: 'Berechtigungen', accessor: (r: Record<string, any>) => r.permissions.length, id: 'perms', width: 140, hAlign: 'End' },
    { Header: 'Gültig bis', accessor: 'expires_on', width: 110, Cell: ({ value }: CellInstance) => datum(value) || 'unbegrenzt' },
    { Header: 'Zuletzt genutzt', accessor: 'last_used_at', width: 170, Cell: ({ value }: CellInstance) => (value ? fmtDateTime(value) : 'nie') },
    { Header: 'Status', accessor: 'status', width: 120,
      Cell: ({ value }: CellInstance) => <ObjectStatus state={statusState[value as ApiKey['status']]}>{value}</ObjectStatus> },
  ];
  const leer = () => null;
  columns.forEach((c) => { if (c.id !== 'modul') c.Aggregated = leer; });
  const data = keys.data ?? [];
  const gruppen = [...new Set(data.map((k) => k.moduleName))];
  const groups = gruppen.length;
  const expanded = Object.fromEntries(gruppen.map((g) => [`modul:${g}`, true]));

  return (
    <AppPage
      title="API-Schlüssel"
      subtitle="Zugriff für Fremdsysteme (z. B. n8n) – jeder Schlüssel gilt nur für ein Projekt/Modul"
      actions={mayEdit && (
        <Button design="Emphasized" icon="add" disabled={!modules.length}
                onClick={() => { setError(null); setEdit({ module: modules[0].module, name: '', permissions: [], expires_on: null }); }}>
          Anlegen
        </Button>
      )}
    >
      {keys.error && <MessageStrip design="Negative">{keys.error}</MessageStrip>}
      {error && !edit && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      <AnalyticalTable
        columns={columns}
        data={data}
        loading={keys.loading}
        sortable
        groupable
        key={gruppen.join('|')}
        reactTableOptions={{ initialState: { groupBy: ['modul'], expanded, sortBy: [{ id: 'name', desc: false }] }, autoResetExpanded: false }}
        visibleRows={data.length ? data.length + groups : 3}
        noDataText="Noch keine API-Schlüssel angelegt"
        onRowClick={(e) => {
          const r = e.detail.row;
          if (r.isGrouped) return;
          const k = r.original as ApiKey;
          setError(null);
          setEdit({ id: k.id, module: k.module, name: k.name, permissions: k.permissions, expires_on: k.expires_on, active: k.active });
        }}
      />

      <Dialog
        open={!!edit}
        headerText={edit?.id ? `API-Schlüssel ${edit.name}` : 'API-Schlüssel anlegen'}
        onClose={() => setEdit(null)}
        style={{ width: 'min(1000px, 96vw)' }}
        footer={
          <Bar
            startContent={edit?.id ? <ChangeHistoryButton objectType="API_KEY" objectKey={`${edit.module}/${edit.name}`} /> : undefined}
            endContent={<>
              {mayEdit && edit?.id && <Button icon="refresh" onClick={() => setConfirm('rotate')}>Neuer Schlüssel</Button>}
              {mayEdit && edit?.id && (edit.active
                ? <Button design="Negative" icon="locked" onClick={() => setConfirm('sperren')}>Sperren</Button>
                : <Button icon="unlocked" onClick={() => setConfirm('entsperren')}>Entsperren</Button>)}
              {mayEdit && <Button design="Emphasized" loading={busy} onClick={save}>{edit?.id ? 'Sichern' : 'Anlegen'}</Button>}
              <Button onClick={() => setEdit(null)}>{mayEdit ? 'Abbrechen' : 'Schließen'}</Button>
            </>}
          />
        }
      >
        {edit && (
          <>
            <SperrHinweis s={sperre} />
            {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
            <FormGrid>
              <FieldBox label="Projekt / Modul" required>
                <Select disabled={!!edit.id || !mayEdit} style={{ width: '100%' }}
                        onChange={(e) => setEdit({ ...edit, module: (e.detail.selectedOption as HTMLElement).dataset.id!, permissions: [] })}>
                  {modules.map((g) => <Option key={g.module} data-id={g.module} selected={g.module === edit.module}>{g.name}</Option>)}
                </Select>
              </FieldBox>
              <TextField label="Name (z. B. n8n, Webformular)" required value={edit.name} readonly={!mayEdit}
                         onChange={(v) => setEdit({ ...edit, name: v })} />
              <FieldBox label="Gültig bis (leer = unbegrenzt)">
                <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={edit.expires_on ?? ''} readonly={!mayEdit}
                            style={{ width: '100%' }} onChange={(e) => setEdit({ ...edit, expires_on: e.detail.value || null })} />
              </FieldBox>
            </FormGrid>
            <PermissionEditor catalog={modulKatalog} value={edit.permissions} readonly={!mayEdit}
                              onChange={(permissions) => setEdit({ ...edit, permissions })} />
          </>
        )}
      </Dialog>

      <SchluesselDialog shown={shown} onClose={() => setShown(null)} />

      <ConfirmDialog
        open={!!confirm}
        danger={confirm !== 'entsperren'}
        askReason={confirm !== 'rotate'}
        title={confirm === 'rotate' ? 'Neuen Schlüssel erzeugen' : confirm === 'sperren' ? 'API-Schlüssel sperren' : 'API-Schlüssel entsperren'}
        text={confirm === 'rotate'
          ? `Für „${edit?.name}“ wird ein neuer Schlüssel erzeugt. Der bisherige ist sofort ungültig und muss im Fremdsystem ersetzt werden.`
          : confirm === 'sperren' ? `„${edit?.name}“ sperren? Aufrufe mit diesem Schlüssel werden sofort abgewiesen.`
            : `„${edit?.name}“ wieder freigeben?`}
        confirmText={confirm === 'rotate' ? 'Erzeugen' : confirm === 'sperren' ? 'Sperren' : 'Entsperren'}
        onConfirm={action}
        onCancel={() => setConfirm(null)}
      />
    </AppPage>
  );
}

/** Zeigt einen neuen Schlüssel einmalig an – danach ist nur noch der Hash gespeichert. */
function SchluesselDialog({ shown, onClose }: { shown: { key: string; module: string } | null; onClose: () => void }) {
  const beispiel = shown
    ? `curl -H "Authorization: Bearer ${shown.key}" ${location.origin}/api/key\n\n` +
      `curl -H "Authorization: Bearer ${shown.key}" -H "Content-Type: application/json" \\\n` +
      `     -d '{ ... }' ${location.origin}/api/m/${shown.module}/...`
    : '';
  const kopieren = async () => {
    await navigator.clipboard?.writeText(shown!.key);
    toast('Schlüssel kopiert');
  };
  return (
    <Dialog
      open={!!shown}
      headerText="Neuer API-Schlüssel"
      state="Critical"
      style={{ width: 'min(760px, 95vw)' }}
      onClose={onClose}
      footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>Ich habe den Schlüssel gesichert</Button>} />}
    >
      <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '1rem' }}>
        Der Schlüssel wird nur jetzt angezeigt. Bitte direkt im Fremdsystem hinterlegen oder in einem Passwortmanager speichern.
      </MessageStrip>
      <Label>Schlüssel</Label>
      <div style={{ display: 'flex', gap: '0.5rem', margin: '0.25rem 0 1rem' }}>
        <Input readonly value={shown?.key ?? ''} style={{ flex: 1, fontFamily: 'monospace' }} />
        <Button icon="copy" onClick={kopieren}>Kopieren</Button>
      </div>
      <Label>Verwendung</Label>
      <TextArea readonly rows={5} value={beispiel} style={{ width: '100%', fontFamily: 'monospace', marginTop: '0.25rem' }} />
    </Dialog>
  );
}
