import { useEffect, useState } from 'react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as CellInstance } from '@ui5/webcomponents-react';
import { AnalyticalTable, Bar, Button, Dialog, Label, MessageStrip, ObjectStatus, Tag, Title, Toolbar, ToolbarSpacer } from '@ui5/webcomponents-react';
import { fmtDateTime } from '../components/ChangeHistory';
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
interface RolleBenutzer { id: string; username: string; displayName: string; email: string | null; active: boolean; lastLoginAt: string | null; rollen: number }

export function RolesPage() {
  const can = useCan();
  const darfAendern = can('core.roles:edit');
  const roles = useLoad(() => api.get<Role[]>('/api/admin/roles'));
  const catalog = useLoad(() => api.get<PermGroup[]>('/api/admin/permissions'));
  const [edit, setEdit] = useState<Edit | null>(null);
  const sperre = useSperre('ROLE', edit && !edit.isNew ? edit.id : null, darfAendern, { bezeichnung: `Rolle ${edit?.id ?? ''}` });
  const mayEdit = darfAendern && sperre.eigen;
  const [confirmDelete, setConfirmDelete] = useState<Role | null>(null);
  const darfEntziehen = can('core.users:edit');
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
    const r = confirmDelete!;
    setConfirmDelete(null);
    try {
      const x = await api.del<{ text: string }>(`/api/admin/roles/${r.id}`);
      setEdit(null);
      toast(x.text, 6000);
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
    ...(darfAendern ? [{
      Header: '', id: 'loeschen', width: 60, disableSortBy: true,
      Cell: ({ row }: CellInstance) => ((row.original as Role).system ? null
        : <Button design="Transparent" icon="delete" tooltip="Rolle löschen" onClick={(e) => { e.stopPropagation(); setError(null); setConfirmDelete(row.original as Role); }} />),
    }] : []),
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
                <Button design="Negative" icon="delete" onClick={() => setConfirmDelete(edit as Role)}>Löschen</Button>
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
              <MessageStrip hideCloseButton style={{ marginBottom: '1rem' }}>
                {edit.id === 'ADMIN' ? 'Systemrolle: besitzt alle Berechtigungen, nur Bezeichnung änderbar.'
                  : 'Systemrolle mit fest vorgegebenen Berechtigungen (wird vom Portal automatisch angelegt und bei der Benutzeranlage vergeben) – nicht änderbar oder löschbar; einzelnen Benutzern kann sie entzogen werden.'}
              </MessageStrip>
            )}
            <FormGrid>
              <TextField label="Rollen-ID (GROSS, z. B. KASSENWART)" required value={edit.id} readonly={!edit.isNew}
                         onChange={(v) => setEdit({ ...edit, id: v.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} />
              <TextField label="Bezeichnung" required value={edit.name} readonly={!mayEdit} onChange={(v) => setEdit({ ...edit, name: v })} />
              <TextField label="Beschreibung" wide value={edit.description} readonly={!mayEdit} onChange={(v) => setEdit({ ...edit, description: v })} />
            </FormGrid>
            {!edit.isNew && edit.id && (
              <RollenBenutzer rolle={edit.id} darf={darfEntziehen && sperre.eigen} onChanged={roles.reload} onError={setError} />
            )}
            {edit.id !== 'ADMIN' && catalog.data && (
              <PermissionEditor catalog={catalog.data} value={edit.permissions ?? []} readonly={readonlyPerms}
                                onChange={(permissions) => setEdit({ ...edit, permissions })} />
            )}
          </>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!confirmDelete}
        danger
        title="Rolle löschen"
        text={confirmDelete ? `Rolle ${confirmDelete.id} („${confirmDelete.name}“) löschen?${confirmDelete.userCount ? ` Sie wird ${confirmDelete.userCount} Benutzer(n) entzogen – diese verlieren die Berechtigungen der Rolle.` : ' Sie ist keinem Benutzer zugeordnet.'}` : ''}
        confirmText="Löschen"
        onConfirm={remove}
        onCancel={() => setConfirmDelete(null)}
      />
    </AppPage>
  );
}

/** Benutzer, denen die Rolle zugeordnet ist – einzeln oder markiert entziehen */
function RollenBenutzer({ rolle, darf, onChanged, onError }: { rolle: string; darf: boolean; onChanged: () => void; onError: (m: string | null) => void }) {
  const [liste, setListe] = useState<RolleBenutzer[] | null>(null);
  const [wahl, setWahl] = useState<string[]>([]);
  const [frage, setFrage] = useState<string[] | null>(null);
  const laden = () => api.get<RolleBenutzer[]>(`/api/admin/roles/${encodeURIComponent(rolle)}/users`).then((l) => { setListe(l); setWahl([]); }).catch((e) => onError(e.message));
  useEffect(() => { laden(); }, [rolle]); // eslint-disable-line react-hooks/exhaustive-deps

  async function entziehen(ids: string[]) {
    setFrage(null);
    try {
      const r = await api.post<{ text: string }>(`/api/admin/roles/${encodeURIComponent(rolle)}/entziehen`, { benutzer: ids });
      toast(r.text);
      await laden();
      onChanged();
    } catch (e) { onError((e as Error).message); }
  }
  const namen = (ids: string[]) => (liste ?? []).filter((u) => ids.includes(u.id)).map((u) => u.displayName || u.username);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Name', accessor: 'displayName', minWidth: 180 },
    { Header: 'Benutzer', accessor: 'username', width: 200 },
    { Header: 'E-Mail', accessor: 'email', minWidth: 180 },
    { Header: 'Rollen', accessor: 'rollen', width: 80, hAlign: 'End' },
    { Header: 'Status', accessor: 'active', width: 100, Cell: ({ value }: CellInstance) => (value ? <ObjectStatus state="Positive">aktiv</ObjectStatus> : <ObjectStatus state="Negative">gesperrt</ObjectStatus>) },
    { Header: 'Letzte Anmeldung', accessor: 'lastLoginAt', width: 170, Cell: ({ value }: CellInstance) => (value ? fmtDateTime(value) : '–') },
    ...(darf ? [{
      Header: '', id: 'weg', width: 120, disableSortBy: true,
      Cell: ({ row }: CellInstance) => <Button design="Transparent" icon="decline" onClick={() => setFrage([(row.original as RolleBenutzer).id])}>Entziehen</Button>,
    }] : []),
  ];
  return (
    <div style={{ margin: '0.5rem 0 1rem' }}>
      <Toolbar design="Transparent">
        <Title level="H5">Zugeordnete Benutzer ({liste?.length ?? 0})</Title>
        <ToolbarSpacer />
        {darf && <Button icon="decline" disabled={!wahl.length} onClick={() => setFrage(wahl)}>{wahl.length ? `${wahl.length} markierten entziehen` : 'Markierten entziehen'}</Button>}
      </Toolbar>
      <AnalyticalTable columns={columns} data={liste ?? []} loading={!liste} minRows={1} visibleRows={Math.min(Math.max(liste?.length ?? 0, 1), 8)}
                       selectionMode={darf ? 'Multiple' : 'None'} rowHeight={40}
                       onRowSelect={(e) => setWahl(Object.keys(e.detail.selectedRowIds ?? {}).filter((k) => (e.detail.selectedRowIds as Record<string, boolean>)[k]).map((k) => (liste ?? [])[Number(k)]?.id).filter(Boolean) as string[])}
                       noDataText="Diese Rolle ist keinem Benutzer zugeordnet" />
      {!darf && liste && liste.length > 0 && <Label>Zum Entziehen wird die Berechtigung „Benutzer anlegen und ändern“ benötigt.</Label>}
      <ConfirmDialog open={!!frage} danger title="Rolle entziehen" confirmText="Entziehen"
                     text={frage ? `Rolle ${rolle} entziehen: ${namen(frage).join(', ')}? Die Benutzer verlieren die Berechtigungen dieser Rolle (andere Rollen bleiben).` : ''}
                     onCancel={() => setFrage(null)} onConfirm={() => entziehen(frage!)} />
    </div>
  );
}
