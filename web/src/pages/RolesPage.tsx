import { useState } from 'react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as CellInstance } from '@ui5/webcomponents-react';
import { AnalyticalTable, Bar, Button, Dialog, MessageStrip, Tag } from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import { FormGrid, TextField } from '../components/FormFields';
import { ChangeHistoryButton } from '../components/ChangeHistory';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useCan } from '../session';
import { toast } from '../toast';
import { SperrHinweis, useSperre } from '../sperre';
import { PermissionEditor, type PermGroup } from '../components/PermissionEditor';

interface Role { id: string; name: string; description: string | null; system: boolean; permissions: string[]; userCount: number }
type Edit = Partial<Role> & { isNew: boolean };

export function RolesPage() {
  const can = useCan();
  const darfAendern = can('core.roles:edit');
  const roles = useLoad(() => api.get<Role[]>('/api/admin/roles'));
  const catalog = useLoad(() => api.get<PermGroup[]>('/api/admin/permissions'));
  const [edit, setEdit] = useState<Edit | null>(null);
  const sperre = useSperre('ROLE', edit && !edit.isNew ? edit.id : null, darfAendern, { bezeichnung: `Rolle ${edit?.id ?? ''}` });
  const mayEdit = darfAendern && sperre.eigen;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readonlyPerms = !mayEdit || !!edit?.system;

  /** „12 Berechtigungen in 5 Apps“ für die Liste */
  const appNamen = new Map<string, string>();
  for (const g of catalog.data ?? []) for (const a of g.areas) for (const app of a.apps) for (const p of app.permissions) appNamen.set(p.id, `${g.module}/${a.name}/${app.name}`);
  const umfang = (perms: string[]) => {
    if (perms.includes('*')) return 'alle';
    const apps = new Set(perms.map((p) => appNamen.get(p)).filter(Boolean));
    return `${perms.length} in ${apps.size} App${apps.size === 1 ? '' : 's'}`;
  };

  async function save() {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: edit.name, description: edit.description ?? null, permissions: edit.permissions ?? [] };
      if (edit.isNew) await api.post('/api/admin/roles', { ...body, id: edit.id });
      else await api.put(`/api/admin/roles/${edit.id}`, body);
      setEdit(null);
      toast('Rolle gesichert');
      roles.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    try {
      await api.del(`/api/admin/roles/${edit!.id}`);
      setEdit(null);
      toast('Rolle gelöscht');
      roles.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Rolle', accessor: 'id', width: 160 },
    { Header: 'Bezeichnung', accessor: 'name' },
    { Header: 'Beschreibung', accessor: 'description' },
    { Header: 'Berechtigungen', accessor: (r: Record<string, any>) => umfang(r.permissions), id: 'perms', width: 170 },
    { Header: 'Benutzer', accessor: 'userCount', width: 100 },
    { Header: '', accessor: 'system', width: 90, Cell: ({ value }: CellInstance) => (value ? <Tag hideStateIcon>System</Tag> : null) },
  ];

  return (
    <AppPage
      title="Rollen"
      subtitle="Berechtigung = Objekt + Aktivität, z. B. „Kontakte anzeigen“"
      actions={mayEdit && (
        <Button design="Emphasized" icon="add" onClick={() => { setError(null); setEdit({ isNew: true, permissions: [] }); }}>Anlegen</Button>
      )}
    >
      {roles.error && <MessageStrip design="Negative">{roles.error}</MessageStrip>}
      <AnalyticalTable
        columns={columns}
        data={roles.data ?? []}
        loading={roles.loading}
        sortable
        visibleRowCountMode="Auto"
        style={{ height: 'calc(100vh - 220px)' }}
        onRowClick={(e) => { setError(null); setEdit({ ...(e.detail.row.original as Role), isNew: false }); }}
      />

      <Dialog
        open={!!edit}
        headerText={edit?.isNew ? 'Rolle anlegen' : `Rolle ${edit?.id ?? ''}`}
        onClose={() => setEdit(null)}
        style={{ width: 'min(1100px, 96vw)' }}
        footer={
          <Bar
            startContent={!edit?.isNew && edit?.id ? <ChangeHistoryButton objectType="ROLE" objectKey={edit.id} /> : undefined}
            endContent={<>
              {mayEdit && !edit?.isNew && !edit?.system && (
                <Button design="Negative" icon="delete" onClick={() => setConfirmDelete(true)}>Löschen</Button>
              )}
              {mayEdit && <Button design="Emphasized" loading={busy} onClick={save}>Sichern</Button>}
              <Button onClick={() => setEdit(null)}>{mayEdit ? 'Abbrechen' : 'Schließen'}</Button>
            </>}
          />
        }
      >
        {edit && (
          <>
            <SperrHinweis s={sperre} />
            {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
            {edit.system && (
              <MessageStrip hideCloseButton style={{ marginBottom: '1rem' }}>Systemrolle: besitzt alle Berechtigungen, nur Bezeichnung änderbar.</MessageStrip>
            )}
            <FormGrid>
              <TextField label="Rollen-ID (GROSS, z. B. KASSENWART)" required value={edit.id} readonly={!edit.isNew}
                         onChange={(v) => setEdit({ ...edit, id: v.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} />
              <TextField label="Bezeichnung" required value={edit.name} readonly={!mayEdit} onChange={(v) => setEdit({ ...edit, name: v })} />
              <TextField label="Beschreibung" wide value={edit.description} readonly={!mayEdit} onChange={(v) => setEdit({ ...edit, description: v })} />
            </FormGrid>
            {!edit.system && catalog.data && (
              <PermissionEditor catalog={catalog.data} value={edit.permissions ?? []} readonly={readonlyPerms}
                                onChange={(permissions) => setEdit({ ...edit, permissions })} />
            )}
          </>
        )}
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Rolle löschen"
        text={`Rolle ${edit?.id} löschen? Zugeordnete Benutzer verlieren diese Berechtigungen.`}
        confirmText="Löschen"
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </AppPage>
  );
}
