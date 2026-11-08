import { useState } from 'react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as CellInstance } from '@ui5/webcomponents-react';
import {
  AnalyticalTable, Bar, Button, CheckBox, Dialog, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Text,
} from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import { CheckField, FieldBox, FormGrid, TextField } from '../components/FormFields';
import { ChangeHistoryButton, fmtDateTime } from '../components/ChangeHistory';
import { useCan, useSession } from '../session';
import { toast } from '../toast';
import { SperrHinweis, useSperre } from '../sperre';

interface User {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  roles: string[];
}
interface Role { id: string; name: string }

type Edit = Partial<User> & { password?: string; isNew: boolean };

/** Ergebnis der Massenanlage „Mitglieder als Benutzer“ (Fachmodul TC Oberthal) */
interface MgAnlage {
  text: string; hochgestuft: number; gesendet: number; uebersprungen: string[];
  angelegt: { adrnr: string; name: string; username: string; email: string | null; startkennwort: string | null; hinweis: string }[];
}

export function UsersPage() {
  const can = useCan();
  const { me } = useSession();
  const darfAendern = can('core.users:edit');
  const mitTco = me.modules.includes('tco');
  const [mg, setMg] = useState<'frage' | MgAnlage | null>(null);
  const [mgMail, setMgMail] = useState(true);
  const users = useLoad(() => api.get<User[]>('/api/admin/users'));
  const roles = useLoad(() => (can('core.roles:display') ? api.get<Role[]>('/api/admin/roles') : Promise.resolve([] as Role[])));
  const [edit, setEdit] = useState<Edit | null>(null);
  const sperre = useSperre('USER', edit && !edit.isNew ? edit.username : null, darfAendern, { bezeichnung: `Benutzer ${edit?.username ?? ''}` });
  const mayEdit = darfAendern && sperre.eigen;
  const [pwFor, setPwFor] = useState<User | null>(null);
  const [newPw, setNewPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      const body = { displayName: edit.displayName, email: edit.email ?? '', roles: edit.roles ?? [], active: edit.active ?? true };
      if (edit.isNew) await api.post('/api/admin/users', { ...body, username: edit.username, password: edit.password });
      else await api.put(`/api/admin/users/${edit.id}`, body);
      setEdit(null);
      toast('Benutzer gesichert');
      users.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!pwFor) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/admin/users/${pwFor.id}/password`, { password: newPw });
      setPwFor(null);
      toast('Passwort zurückgesetzt – muss bei der nächsten Anmeldung geändert werden');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Benutzer', accessor: 'username', width: 140 },
    { Header: 'Name', accessor: 'displayName' },
    { Header: 'E-Mail', accessor: 'email' },
    { Header: 'Rollen', accessor: (u: Record<string, any>) => u.roles.join(', '), id: 'roles' },
    {
      Header: 'Status', accessor: 'active', width: 110,
      Cell: ({ row }: CellInstance) =>
        (row.original as User).active ? <ObjectStatus state="Positive">Aktiv</ObjectStatus> : <ObjectStatus state="Negative">Gesperrt</ObjectStatus>,
    },
    { Header: 'Letzte Anmeldung', accessor: 'lastLoginAt', width: 180, Cell: ({ value }: CellInstance) => (value ? fmtDateTime(value) : '–') },
  ];

  return (
    <AppPage
      title="Benutzer"
      subtitle={users.data ? `${users.data.length} Benutzer` : undefined}
      actions={mayEdit && (<>
        {mitTco && <Button icon="group" onClick={() => setMg('frage')}>Mitglieder als Benutzer anlegen</Button>}
        <Button design="Emphasized" icon="add" onClick={() => { setError(null); setEdit({ isNew: true, active: true, roles: [] }); }}>
          Anlegen
        </Button>
      </>)}
    >
      {mg && (
        <Dialog open headerText="Mitglieder als Benutzer anlegen" style={{ width: 'min(52rem, 96vw)' }} onClose={() => setMg(null)}
                footer={<Bar endContent={mg === 'frage' ? <>
                  <Button design="Emphasized" icon="group" loading={busy} onClick={async () => {
                    setBusy(true); setError(null);
                    try { const r = await api.post<MgAnlage>('/api/m/tco/mitglieder/benutzer-anlegen', { mail: mgMail }); setMg(r); toast(r.text, 8000); users.reload(); }
                    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
                  }}>Jetzt anlegen</Button>
                  <Button onClick={() => setMg(null)}>Abbrechen</Button>
                </> : <>
                  {mg.angelegt.some((a) => a.startkennwort) && (
                    <Button icon="download" onClick={() => {
                      const zeilen = [['Adressnummer', 'Name', 'Anmeldename', 'E-Mail', 'Startkennwort', 'Hinweis'],
                        ...mg.angelegt.map((a) => [a.adrnr, a.name, a.username, a.email ?? '', a.startkennwort ?? '', a.hinweis])];
                      const csv = zeilen.map((z) => z.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\r\n');
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
                      a.download = `startkennwoerter_${new Date().toISOString().slice(0, 10)}.csv`;
                      a.click();
                    }}>Liste mit Startkennwörtern herunterladen</Button>
                  )}
                  <Button design="Emphasized" onClick={() => setMg(null)}>Schließen</Button>
                </>} />}>
          {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
          {mg === 'frage' ? (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <Text>
                Für jedes aktive Mitglied ohne Benutzer wird ein Benutzer mit der Systemrolle <b>Mitglied</b> angelegt („Meine Mitgliedschaft“ und Einzelbuchung):
                Anmeldename = E-Mail-Adresse (bei gemeinsamer Familienadresse vorname.nachname), Anzeigename „Nachname, Vorname“.
                Vorhandene Hallennutzer, die zu einem Mitglied gehören, werden dem Mitglied zugeordnet und zu Mitgliedern hochgestuft; ein importiertes
                EP3-Kennwort gilt weiter. Alle anderen erhalten ein Startkennwort, das bei der ersten Anmeldung geändert werden muss.
              </Text>
              <CheckBox text="Startkennwörter per E-Mail an die Mitglieder senden (wenn der Mailversand eingerichtet ist)" checked={mgMail} onChange={(e) => setMgMail(e.target.checked)} />
              <Text className="portal-muted">Startkennwörter, die nicht versendet werden konnten, erscheinen anschließend in einer Liste zum Herunterladen – bitte sicher weitergeben.</Text>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <MessageStrip design="Positive" hideCloseButton>{mg.text}</MessageStrip>
              {mg.uebersprungen.map((u) => <MessageStrip key={u} design="Critical" hideCloseButton>{u}</MessageStrip>)}
              {mg.angelegt.length > 0 && (
                <div style={{ maxHeight: '40vh', overflow: 'auto' }}>
                  <table className="portal-tabelle" style={{ width: '100%', fontSize: '0.875rem' }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>Name</th><th style={{ textAlign: 'left' }}>Anmeldename</th><th style={{ textAlign: 'left' }}>Startkennwort</th><th style={{ textAlign: 'left' }}>Hinweis</th></tr></thead>
                    <tbody>{mg.angelegt.map((a) => <tr key={a.adrnr}><td>{a.name}</td><td>{a.username}</td><td><code>{a.startkennwort ?? '–'}</code></td><td><Label>{a.hinweis}</Label></td></tr>)}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </Dialog>
      )}
      {users.error && <MessageStrip design="Negative">{users.error}</MessageStrip>}
      <AnalyticalTable
        columns={columns}
        data={users.data ?? []}
        loading={users.loading}
        filterable
        sortable
        visibleRowCountMode="Auto"
        style={{ height: 'calc(100vh - 220px)' }}
        onRowClick={(e) => { setError(null); setEdit({ ...(e.detail.row.original as User), isNew: false }); }}
      />

      <Dialog
        open={!!edit}
        headerText={edit?.isNew ? 'Benutzer anlegen' : `Benutzer ${edit?.username ?? ''}`}
        onClose={() => setEdit(null)}
        style={{ width: 'min(640px, 95vw)' }}
        footer={
          <Bar
            startContent={!edit?.isNew && edit?.username ? <ChangeHistoryButton objectType="USER" objectKey={edit.username} /> : undefined}
            endContent={
              <>
                {mayEdit && !edit?.isNew && (
                  <Button icon="key" onClick={() => { setNewPw(''); setError(null); setPwFor(edit as User); }}>Passwort zurücksetzen</Button>
                )}
                {mayEdit && <Button design="Emphasized" loading={busy} onClick={save}>Sichern</Button>}
                <Button onClick={() => setEdit(null)}>{mayEdit ? 'Abbrechen' : 'Schließen'}</Button>
              </>
            }
          />
        }
      >
        {edit && (
          <>
            <SperrHinweis s={sperre} />
            {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
            <FormGrid>
              <TextField label="Benutzername" required value={edit.username} readonly={!edit.isNew || !mayEdit}
                         onChange={(v) => setEdit({ ...edit, username: v })} />
              <TextField label="Name" required value={edit.displayName} readonly={!mayEdit}
                         onChange={(v) => setEdit({ ...edit, displayName: v })} />
              <TextField label="E-Mail" type="Email" value={edit.email} readonly={!mayEdit}
                         onChange={(v) => setEdit({ ...edit, email: v })} />
              {edit.isNew ? (
                <TextField label="Startpasswort (mind. 10 Zeichen)" required type="Password" value={edit.password}
                           onChange={(v) => setEdit({ ...edit, password: v })} />
              ) : (
                <CheckField label="Aktiv" checked={!!edit.active} readonly={!mayEdit} onChange={(v) => setEdit({ ...edit, active: v })} />
              )}
              <FieldBox label="Rollen" wide>
                <MultiComboBox
                  readonly={!mayEdit}
                  style={{ width: '100%' }}
                  onSelectionChange={(e) => setEdit({ ...edit, roles: e.detail.items.map((i) => i.dataset.id!) })}
                >
                  {(roles.data ?? []).map((r) => (
                    <MultiComboBoxItem key={r.id} data-id={r.id} text={`${r.name} (${r.id})`} selected={edit.roles?.includes(r.id)} />
                  ))}
                </MultiComboBox>
              </FieldBox>
            </FormGrid>
          </>
        )}
      </Dialog>

      <Dialog
        open={!!pwFor}
        headerText={`Passwort zurücksetzen: ${pwFor?.username ?? ''}`}
        onClose={() => setPwFor(null)}
        footer={<Bar endContent={<>
          <Button design="Emphasized" disabled={newPw.length < 10} loading={busy} onClick={resetPassword}>Zurücksetzen</Button>
          <Button onClick={() => setPwFor(null)}>Abbrechen</Button>
        </>} />}
      >
        {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
        <TextField label="Neues Startpasswort (mind. 10 Zeichen)" type="Password" value={newPw} onChange={setNewPw} />
      </Dialog>
    </AppPage>
  );
}
