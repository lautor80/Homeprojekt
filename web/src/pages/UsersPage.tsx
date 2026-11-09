import { useEffect, useState } from 'react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as CellInstance } from '@ui5/webcomponents-react';
import {
  AnalyticalTable, Bar, Button, CheckBox, Dialog, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus,
  SegmentedButton, SegmentedButtonItem, Switch, Text,
} from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import { CheckField, FieldBox, FormGrid, TextField } from '../components/FormFields';
import { ChangeHistoryButton, fmtDateTime } from '../components/ChangeHistory';
import { useCan, useSession } from '../session';
import { toast } from '../toast';
import { SperrHinweis, useSperre } from '../sperre';
import { InitialeZuordnung, ZuordnungFelder } from './BenutzerZuordnung';
import { AuswahlBox } from '../components/AuswahlBox';

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
  const [filter, setFilter] = useState<'ALLE' | 'AKTIV' | 'GESPERRT'>('AKTIV');
  const [mapping, setMapping] = useState(false);
  const [einzeln, setEinzeln] = useState(false);
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

  async function aktivSetzen(u: User, aktiv: boolean) {
    setError(null);
    try {
      const r = await api.post<{ text: string }>(`/api/admin/users/${u.id}/aktiv`, { aktiv });
      toast(r.text);
    } catch (e) { setError((e as Error).message); }
    users.reload();
  }
  const anzahl = { ALLE: users.data?.length ?? 0, AKTIV: users.data?.filter((u) => u.active).length ?? 0, GESPERRT: users.data?.filter((u) => !u.active).length ?? 0 };
  const sichtbar = (users.data ?? []).filter((u) => filter === 'ALLE' || (filter === 'AKTIV') === u.active);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Benutzer', accessor: 'username', width: 140 },
    { Header: 'Name', accessor: 'displayName' },
    { Header: 'E-Mail', accessor: 'email' },
    { Header: 'Rollen', accessor: (u: Record<string, any>) => u.roles.join(', '), id: 'roles' },
    {
      Header: 'Status', accessor: 'active', width: 150,
      Cell: ({ row }: CellInstance) => {
        const u = row.original as User;
        const status = u.active ? <ObjectStatus state="Positive">Aktiv</ObjectStatus> : <ObjectStatus state="Negative">Gesperrt</ObjectStatus>;
        if (!darfAendern || u.id === me.user.id) return status;
        return (
          // Klick auf den Schalter öffnet nicht den Bearbeiten-Dialog
          <div className="portal-row" style={{ flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Switch checked={u.active} tooltip={u.active ? 'Sperren' : 'Entsperren'} onChange={(e) => aktivSetzen(u, e.target.checked)} />
            {status}
          </div>
        );
      },
    },
    { Header: 'Letzte Anmeldung', accessor: 'lastLoginAt', width: 180, Cell: ({ value }: CellInstance) => (value ? fmtDateTime(value) : '–') },
  ];

  return (
    <AppPage
      title="Benutzer"
      subtitle={users.data ? `${users.data.length} Benutzer` : undefined}
      actions={mayEdit && (<>
        {mitTco && <Button icon="chain-link" onClick={() => setMapping(true)}>Initiale Zuordnung</Button>}
        {mitTco && <Button icon="add-employee" onClick={() => { setError(null); setEinzeln(true); }}>Aus Mitglied/EP3 anlegen</Button>}
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
      {error && !edit && !mg && !einzeln && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <SegmentedButton style={{ marginBottom: '0.5rem' }} onSelectionChange={(e) => setFilter((e.detail.selectedItems[0] as HTMLElement).dataset.f as typeof filter)}>
        <SegmentedButtonItem data-f="ALLE" selected={filter === 'ALLE'}>Alle ({anzahl.ALLE})</SegmentedButtonItem>
        <SegmentedButtonItem data-f="AKTIV" selected={filter === 'AKTIV'}>Aktiv ({anzahl.AKTIV})</SegmentedButtonItem>
        <SegmentedButtonItem data-f="GESPERRT" selected={filter === 'GESPERRT'}>Gesperrt ({anzahl.GESPERRT})</SegmentedButtonItem>
      </SegmentedButton>
      {mapping && <InitialeZuordnung onClose={() => setMapping(false)} onDone={() => users.reload()} />}
      {einzeln && <EinzelAnlage onClose={() => setEinzeln(false)} onDone={() => users.reload()} />}
      <AnalyticalTable
        columns={columns}
        data={sichtbar}
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
                  data-kein-autofill
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
            {mitTco && !edit.isNew && edit.id && (
              <ZuordnungFelder benutzerId={edit.id} darf={mayEdit}
                               onGeaendert={async () => {
                                 // Zuordnung kann die Rolle „Mitglied“ ergänzen – Rollen im Dialog nachziehen, damit Sichern sie nicht wieder entfernt
                                 const l = await api.get<User[]>('/api/admin/users');
                                 const u = l.find((x) => x.id === edit.id);
                                 if (u) setEdit((e) => (e ? { ...e, roles: u.roles } : e));
                                 users.reload();
                               }} />
            )}
          </>
        )}
      </Dialog>

      {pwFor && <Dialog
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
      </Dialog>}
    </AppPage>
  );
}

/** einzelnen Benutzer aus einem Mitglied (Rolle Mitglied) oder EP3-Kunden (Rolle Hallennutzer) anlegen */
interface Kandidat { art: 'MITGLIED' | 'EP3'; schluessel: string; name: string; info: string }
function EinzelAnlage({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [suche, setSuche] = useState('');
  const [liste, setListe] = useState<Kandidat[]>([]);
  const [wahl, setWahl] = useState<Kandidat | null>(null);
  const [mail, setMail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<{ text: string; username: string | null; startkennwort: string | null } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api.get<Kandidat[]>(`/api/m/tco/mitglieder/benutzer-kandidaten?suche=${encodeURIComponent(suche)}`).then(setListe).catch((e) => setError(e.message)), 250);
    return () => clearTimeout(t);
  }, [suche]);
  async function anlegen() {
    if (!wahl) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string; username: string | null; startkennwort: string | null }>('/api/m/tco/mitglieder/benutzer-einzeln', { art: wahl.art, schluessel: wahl.schluessel, mail });
      setErgebnis(r); toast(r.text, 6000); onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText="Benutzer aus Mitglied oder EP3-Kunde anlegen" style={{ width: 'min(40rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={ergebnis ? <Button design="Emphasized" onClick={onClose}>Schließen</Button> : <>
              <Button design="Emphasized" icon="add-employee" disabled={!wahl || busy} onClick={anlegen}>Anlegen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        {ergebnis ? (
          <>
            <MessageStrip design="Positive" hideCloseButton>{ergebnis.text}</MessageStrip>
            {ergebnis.startkennwort && (
              <MessageStrip design="Critical" hideCloseButton>
                Anmeldename <b>{ergebnis.username}</b> · Startkennwort <code>{ergebnis.startkennwort}</code> – bitte sicher weitergeben, es wird nur einmal angezeigt und muss bei der ersten Anmeldung geändert werden.
              </MessageStrip>
            )}
          </>
        ) : (
          <>
            <Label showColon>Mitglied oder EP3-Kunde (ohne Benutzer)</Label>
            <AuswahlBox style={{ width: '100%' }} placeholder="Name, E-Mail oder Mitgliedsnummer" filter="None" wert={wahl ? `${wahl.art}:${wahl.schluessel}` : ''}
                        eintraege={liste.map((k) => ({ key: `${k.art}:${k.schluessel}`, text: k.name, zusatz: k.info }))}
                        onSuche={(t) => { setSuche(t); setWahl(null); }}
                        onWaehle={(k) => setWahl(liste.find((x) => `${x.art}:${x.schluessel}` === k) ?? null)} />
            {wahl && (
              <MessageStrip design="Information" hideCloseButton>
                {wahl.art === 'MITGLIED'
                  ? `${wahl.name}: Benutzer mit Rolle „Mitglied“ (Meine Mitgliedschaft + Einzelbuchung). Anmeldename = E-Mail-Adresse; Kennwort aus EP3 (falls vorhanden) oder Startkennwort.`
                  : `${wahl.name}: Benutzer mit Rolle „Hallennutzer“ (nur Einzelbuchung). Anmeldename = E-Mail bzw. EP3-Alias; EP3-Kennwort gilt weiter, sonst Startkennwort.`}
              </MessageStrip>
            )}
            {wahl?.art === 'MITGLIED' && <CheckBox text="Startkennwort per E-Mail senden (wenn der Mailversand eingerichtet ist)" checked={mail} onChange={(e) => setMail(e.target.checked)} />}
            <Text className="portal-muted portal-small">Aufgeführt werden aktive Mitglieder und EP3-Kunden, die noch keinen Benutzer haben. Ausgetretene Mitglieder werden nach dem Austrittsdatum automatisch gesperrt.</Text>
          </>
        )}
      </div>
    </Dialog>
  );
}
