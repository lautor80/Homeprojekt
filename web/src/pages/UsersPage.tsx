import { useEffect, useRef, useState } from 'react';
import { feld } from '../components/Varianten';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as CellInstance } from '@ui5/webcomponents-react';
import {
  AnalyticalTable, Bar, Button, CheckBox, Dialog, Icon, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus,
  Option, SegmentedButton, SegmentedButtonItem, Select, StepInput, Switch, Text, TextArea,
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

type Edit = Partial<User> & { password?: string; isNew: boolean; einmalLink?: boolean };

/** Ergebnis der Massenanlage „Mitglieder als Benutzer“ (Fachmodul TC Oberthal) */
interface MgAnlage {
  text: string; hochgestuft: number; gesendet: number; uebersprungen: string[];
  angelegt: { adrnr: string; name: string; username: string; email: string | null; startkennwort: string | null; hinweis: string }[];
}

export function UsersPage() {
  const can = useCan();
  const { me } = useSession();
  const darfAendern = can('core.users:edit');
  /** Dialog „Einladen & Zugangslinks“: QR-Einladung für Mitglieder ohne Benutzer oder Zugangslinks an Personen aus einer Liste (#105) */
  const [einladen, setEinladen] = useState<false | 'QR' | 'LISTE'>(false);
  const mitTco = me.modules.includes('tco');
  const [mg, setMg] = useState<'frage' | MgAnlage | null>(null);
  const [mgMail, setMgMail] = useState(true);
  const [filter, setFilter] = useState<'ALLE' | 'AKTIV' | 'GESPERRT'>('AKTIV');
  /** Freitextsuche (live) und Benutzerart: Mitglieder (Rolle MITGLIED), Hallennutzer (Rolle HALLENNUTZER), übrige */
  const [suche, setSuche] = useState('');
  const [art, setArt] = useState<'ALLE' | 'MITGLIED' | 'HALLENNUTZER' | 'SONSTIGE'>('ALLE');
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
  const [loeschen, setLoeschen] = useState<User | null>(null);

  /** Benutzer löschen – der Server lehnt ab, sobald Buchungen vorhanden sind */
  async function benutzerLoeschen() {
    if (!loeschen) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.del<{ text: string }>(`/api/admin/users/${loeschen.id}`);
      setLoeschen(null);
      setEdit(null);
      toast(r.text);
      users.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      const body = { displayName: edit.displayName, email: edit.email ?? '', roles: edit.roles ?? [], active: edit.active ?? true };
      let text = 'Benutzer gesichert';
      if (edit.isNew) {
        const r = await api.post<{ text?: string }>('/api/admin/users', { ...body, username: edit.username, password: edit.einmalLink ? '' : edit.password, einmalLink: !!edit.einmalLink });
        if (r.text) text = r.text;
      } else await api.put(`/api/admin/users/${edit.id}`, body);
      setEdit(null);
      toast(text, 6000);
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

  async function linkSenden() {
    if (!pwFor) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ text: string }>(`/api/admin/users/${pwFor.id}/kennwort-link`);
      setPwFor(null);
      toast(r.text, 6000);
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
  const artVon = (u: User) => (u.roles.includes('MITGLIED') ? 'MITGLIED' : u.roles.includes('HALLENNUTZER') ? 'HALLENNUTZER' : 'SONSTIGE');
  const begriffe = suche.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const passt = (u: User) => begriffe.every((b) => `${u.username} ${u.displayName} ${u.email ?? ''} ${u.roles.join(' ')}`.toLowerCase().includes(b));
  const vorStatus = (users.data ?? []).filter((u) => (art === 'ALLE' || artVon(u) === art) && passt(u));
  const anzahl = { ALLE: vorStatus.length, AKTIV: vorStatus.filter((u) => u.active).length, GESPERRT: vorStatus.filter((u) => !u.active).length };
  const anzahlArt = (a: typeof art) => (users.data ?? []).filter((u) => (filter === 'ALLE' || (filter === 'AKTIV') === u.active) && (a === 'ALLE' || artVon(u) === a) && passt(u)).length;
  const sichtbar = vorStatus.filter((u) => filter === 'ALLE' || (filter === 'AKTIV') === u.active);

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
    <AppPage varianten={{ repid: 'core.users', ansicht: { filter, suche, art }, onAnwenden: (a) => { setFilter(feld(a, 'filter', filter)); setSuche(feld(a, 'suche', suche)); setArt(feld(a, 'art', art)); } }}
      title="Benutzer"
      subtitle={users.data ? `${users.data.length} Benutzer` : undefined}
      actions={mayEdit && (<>
        {mitTco && <Button icon="chain-link" onClick={() => setMapping(true)}>Initiale Zuordnung</Button>}
        {mitTco && <Button icon="add-employee" onClick={() => { setError(null); setEinzeln(true); }}>Aus Mitglied/EP3 anlegen</Button>}
        {mitTco && <Button icon="group" onClick={() => setMg('frage')}>Mitglieder als Benutzer anlegen</Button>}
        {mitTco && <Button icon="qr-code" tooltip="Mitglieder ohne Benutzer einladen (QR-Code) oder ausgewählten Personen einen Link zum Setzen des Kennworts senden" onClick={() => setEinladen('QR')}>Einladen & Zugangslinks</Button>}
        <Button design="Emphasized" icon="add" onClick={() => { setError(null); setEdit({ isNew: true, active: true, roles: [] }); }}>
          Anlegen
        </Button>
      </>)}
    >
      {einladen === 'QR' && <EinladungDialog onClose={() => setEinladen(false)} onModus={() => setEinladen('LISTE')} />}
      {einladen === 'LISTE' && <ZugangslinkDialog onClose={() => setEinladen(false)} onModus={() => setEinladen('QR')} />}
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
      <div className="portal-row" style={{ gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.5rem', alignItems: 'center' }}>
        <Input data-kein-autofill icon={<Icon name="search" />} placeholder="Suchen: Name, Benutzer, E-Mail, Rolle" value={suche} style={{ width: '20rem' }}
               onInput={(e) => setSuche(e.target.value)} showClearIcon />
        <SegmentedButton onSelectionChange={(e) => setArt((e.detail.selectedItems[0] as HTMLElement).dataset.a as typeof art)}>
          <SegmentedButtonItem data-a="ALLE" selected={art === 'ALLE'}>Alle ({anzahlArt('ALLE')})</SegmentedButtonItem>
          <SegmentedButtonItem data-a="MITGLIED" selected={art === 'MITGLIED'}>Mitglieder ({anzahlArt('MITGLIED')})</SegmentedButtonItem>
          <SegmentedButtonItem data-a="HALLENNUTZER" selected={art === 'HALLENNUTZER'}>Hallennutzer ({anzahlArt('HALLENNUTZER')})</SegmentedButtonItem>
          <SegmentedButtonItem data-a="SONSTIGE" selected={art === 'SONSTIGE'}>Sonstige ({anzahlArt('SONSTIGE')})</SegmentedButtonItem>
        </SegmentedButton>
        <SegmentedButton onSelectionChange={(e) => setFilter((e.detail.selectedItems[0] as HTMLElement).dataset.f as typeof filter)}>
          <SegmentedButtonItem data-f="ALLE" selected={filter === 'ALLE'}>Alle ({anzahl.ALLE})</SegmentedButtonItem>
          <SegmentedButtonItem data-f="AKTIV" selected={filter === 'AKTIV'}>Aktiv ({anzahl.AKTIV})</SegmentedButtonItem>
          <SegmentedButtonItem data-f="GESPERRT" selected={filter === 'GESPERRT'}>Gesperrt ({anzahl.GESPERRT})</SegmentedButtonItem>
        </SegmentedButton>
      </div>
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
                {mayEdit && !edit?.isNew && edit?.id !== me.user.id && (
                  <Button icon="delete" design="Negative" onClick={() => { setError(null); setLoeschen(edit as User); }}>Löschen</Button>
                )}
                {mayEdit && !edit?.isNew && (
                  <Button icon="key"onClick={() => { setNewPw(''); setError(null); setPwFor(edit as User); }}>Passwort zurücksetzen</Button>
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
                <>
                  <CheckField label="Einmal-Link per E-Mail" checked={!!edit.einmalLink}
                              onChange={(v) => setEdit({ ...edit, einmalLink: v })} />
                  {!edit.einmalLink && (
                    <TextField label="Startpasswort (mind. 10 Zeichen)" required type="Password" value={edit.password}
                               onChange={(v) => setEdit({ ...edit, password: v })} />
                  )}
                </>
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

      {loeschen && <Dialog
        open
        headerText={`Benutzer löschen: ${loeschen.username}`}
        state="Negative"
        onClose={() => setLoeschen(null)}
        footer={<Bar endContent={<>
          <Button design="Negative" icon="delete" loading={busy} onClick={benutzerLoeschen}>Endgültig löschen</Button>
          <Button onClick={() => setLoeschen(null)}>Abbrechen</Button>
        </>} />}
      >
        {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
        <Text>
          {loeschen.displayName || loeschen.username} wird mit Rollen und Sitzungen gelöscht; die Zuordnung zu Mitglied bzw. EP3-Kunde wird gelöst.
          Das geht nur, solange über den Benutzer noch keine Buchungen erfolgt sind – sonst bitte sperren. Die Änderungshistorie bleibt erhalten.
        </Text>
      </Dialog>}

      {pwFor && <Dialog
        open={!!pwFor}
        headerText={`Passwort zurücksetzen: ${pwFor?.username ?? ''}`}
        onClose={() => setPwFor(null)}
        footer={<Bar endContent={<>
          <Button design="Emphasized" disabled={newPw.length < 10} loading={busy} onClick={resetPassword}>Zurücksetzen</Button>
          <Button disabled={!pwFor?.email} loading={busy} onClick={linkSenden}>Einmal-Link senden</Button>
          <Button onClick={() => setPwFor(null)}>Abbrechen</Button>
        </>} />}
      >
        {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
        <TextField label="Neues Startpasswort (mind. 10 Zeichen)" type="Password" value={newPw} onChange={setNewPw} />
        <p className="portal-muted portal-small" style={{ margin: '0.75rem 0 0' }}>
          {pwFor?.email
            ? `Alternativ: „Einmal-Link senden“ – ${pwFor.email} erhält einen Link (48 Std. gültig), über den der Benutzer selbst ein Kennwort festlegt. Kein Kennwort im Klartext.`
            : 'Für einen Einmal-Link ist beim Benutzer keine E-Mail-Adresse hinterlegt.'}
        </p>
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

/**
 * Einladung zum Vereinsportal: persönlicher Link mit QR-Code für aktive Mitglieder ohne Benutzer – per E-Mail
 * oder als Brief (PDF). Wer den Link einlöst, erhält sofort einen Benutzer mit Rolle „Mitglied“.
 */
interface EinladungKandidat { adrnr: string; mitglnrn: string | null; vorname: string | null; nachname: string | null; email: string | null; eingeladen_am: string | null; eingeladen_per: string | null }
function EinladungDialog({ onClose, onModus }: { onClose: () => void; onModus: () => void }) {
  const [liste, setListe] = useState<EinladungKandidat[] | null>(null);
  const [wahl, setWahl] = useState<Set<string>>(new Set());
  const [brief, setBrief] = useState(false);
  const [nurNeue, setNurNeue] = useState(true);
  /** Mitglieder ohne E-Mail-Adresse ausblenden (sie bekämen einen Brief) */
  const [nurMail, setNurMail] = useState(false);
  // E-Mail: Vorschlag, vor dem Versand änderbar; Kopie an den Versender (#105)
  const [betreff, setBetreff] = useState('');
  const [text, setText] = useState('');
  const [platzhalter, setPlatzhalter] = useState<string[]>([]);
  const [mailOffen, setMailOffen] = useState(false);
  const [cc, setCc] = useState(false);
  const [ccAdresse, setCcAdresse] = useState<string | null>(null);
  const [suche, setSuche] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<{ text: string; pdf: string | null; fehler: string[] } | null>(null);
  useEffect(() => {
    api.get<EinladungKandidat[]>('/api/m/tco/mitglieder/einladungen').then((l) => {
      setListe(l);   // bewusst ohne Vorauswahl (#105)
    }).catch((e) => setError(e.message));
    api.get<{ betreff: string; text: string; platzhalter: string[]; cc: string | null }>('/api/m/tco/mitglieder/einladungen/vorlage')
      .then((v) => { setBetreff(v.betreff); setText(v.text); setPlatzhalter(v.platzhalter); setCcAdresse(v.cc); }).catch((e) => setError(e.message));
  }, []);
  const begriffe = suche.toLowerCase().split(/\s+/).filter(Boolean);
  const sichtbar = (liste ?? []).filter((k) => (!nurNeue || !k.eingeladen_am) && (!nurMail || !!k.email)
    && begriffe.every((b) => `${k.nachname ?? ''} ${k.vorname ?? ''} ${k.mitglnrn ?? ''} ${k.email ?? ''}`.toLowerCase().includes(b)));
  const umschalten = (a: string) => setWahl((w) => { const n = new Set(w); if (n.has(a)) n.delete(a); else n.add(a); return n; });
  async function los() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string; pdf: string | null; fehler: string[] }>('/api/m/tco/mitglieder/einladungen', { adrnrs: [...wahl], brief, betreff, text, cc: cc && !brief });
      setErgebnis(r);
      toast(r.text, 8000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function pdfLaden(b64: string) {
    const a = document.createElement('a');
    a.href = `data:application/pdf;base64,${b64}`;
    a.download = `Einladungen_Vereinsportal_${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
  }
  const mitMail = [...wahl].filter((a) => liste?.find((k) => k.adrnr === a)?.email).length;
  return (
    <Dialog open headerText="Einladen & Zugangslinks" style={{ width: 'min(52rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={ergebnis ? <>
              {ergebnis.pdf && <Button design="Emphasized" icon="download" onClick={() => pdfLaden(ergebnis.pdf!)}>Briefe (PDF) herunterladen</Button>}
              <Button onClick={onClose}>Schließen</Button>
            </> : <>
              <Button design="Emphasized" icon="qr-code" loading={busy} disabled={!wahl.size || !betreff.trim() || !text.includes('{Link}')} onClick={los}>{wahl.size} einladen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <ModusWahl modus="QR" onModus={onModus} />
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {ergebnis ? (
        <>
          <MessageStrip design="Positive" hideCloseButton>{ergebnis.text}</MessageStrip>
          {ergebnis.fehler.map((f) => <MessageStrip key={f} design="Critical" hideCloseButton style={{ marginTop: '0.25rem' }}>{f}</MessageStrip>)}
        </>
      ) : !liste ? <Text>Lade …</Text> : (
        <>
          <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
            Jedes ausgewählte Mitglied erhält einen persönlichen Link mit QR-Code (30 Tage gültig, einmal verwendbar). Mit E-Mail-Adresse per Mail{brief ? ' – hier: alle als Brief' : ''}, ohne als Brief (PDF zum Drucken).
            Wer den Link einlöst, wählt Benutzername und Kennwort und erhält sofort die Rolle „Mitglied“ – ohne Freigabe.
          </Text>
          <div className="portal-row" style={{ gap: '1rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <Input data-kein-autofill icon={<Icon name="search" />} placeholder="Suchen: Name, Nr., E-Mail" value={suche} style={{ width: '16rem' }}
                   onInput={(e) => setSuche(e.target.value)} showClearIcon />
            <CheckBox text="nur noch nicht eingeladene" checked={nurNeue} onChange={(e) => setNurNeue(e.target.checked)} />
            <CheckBox text="nur mit E-Mail-Adresse" checked={nurMail} onChange={(e) => {
              setNurMail(e.target.checked);
              // ausgeblendete Mitglieder ohne E-Mail nicht versehentlich mit einladen
              if (e.target.checked) setWahl((w) => new Set([...w].filter((a) => liste?.find((k) => k.adrnr === a)?.email)));
            }} />
            <CheckBox text="alle als Brief (statt E-Mail)" checked={brief} onChange={(e) => setBrief(e.target.checked)} />
            <Button design="Transparent" onClick={() => setWahl((w) => new Set([...(begriffe.length ? w : []), ...sichtbar.map((k) => k.adrnr)]))}>alle wählen</Button>
            <Button design="Transparent" onClick={() => setWahl((w) => (begriffe.length ? new Set([...w].filter((a) => !sichtbar.some((k) => k.adrnr === a))) : new Set()))}>keine</Button>
          </div>
          <div style={{ maxHeight: '45vh', overflowY: 'auto', border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem' }}>
            {sichtbar.map((k) => (
              <div key={k.adrnr} className="portal-row" style={{ padding: '0.15rem 0.5rem', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                <CheckBox checked={wahl.has(k.adrnr)} onChange={() => umschalten(k.adrnr)}
                          text={`${k.nachname ?? ''}, ${k.vorname ?? ''}${k.mitglnrn ? ` (Nr. ${k.mitglnrn})` : ''}`} />
                <Label style={{ marginLeft: 'auto' }}>{k.email ?? 'ohne E-Mail → Brief'}{k.eingeladen_am ? ` · eingeladen ${k.eingeladen_am.split('-').reverse().join('.')} (${k.eingeladen_per === 'MAIL' ? 'Mail' : k.eingeladen_per === 'BRIEF' ? 'Brief' : 'Registrierung'})` : ''}</Label>
              </div>
            ))}
            {!sichtbar.length && begriffe.length > 0 && <Text style={{ display: 'block', padding: '0.75rem' }}>Kein Mitglied passt zur Suche „{suche}“.</Text>}
            {!sichtbar.length && !begriffe.length && <Text style={{ display: 'block', padding: '0.75rem' }}>Alle aktiven Mitglieder haben bereits einen Benutzer bzw. eine Einladung.</Text>}
          </div>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
            {wahl.size} ausgewählt: {brief ? 0 : mitMail} per E-Mail, {brief ? wahl.size : wahl.size - mitMail} als Brief. Eine neue Einladung macht ältere ungültig.
          </Text>
          <div className="portal-row" style={{ marginTop: '0.5rem', gap: '1rem' }}>
            <Button design="Transparent" icon={mailOffen ? 'navigation-down-arrow' : 'navigation-right-arrow'} onClick={() => setMailOffen(!mailOffen)}>E-Mail-Text ansehen und anpassen</Button>
            <CheckBox text={`Kopie (CC) jeder E-Mail an mich${ccAdresse ? ` – ${ccAdresse}` : ' (keine E-Mail-Adresse bei meinem Benutzer hinterlegt)'}`}
                      checked={cc && !brief} disabled={!ccAdresse || brief} onChange={(e) => setCc(e.target.checked)} />
          </div>
          {mailOffen && (
            <div style={{ marginTop: '0.25rem' }}>
              <Input value={betreff} onInput={(e) => setBetreff(e.target.value)} style={{ width: '100%', marginBottom: '0.25rem' }} accessibleName="Betreff" placeholder="Betreff" />
              <TextArea rows={10} value={text} onInput={(e) => setText(e.target.value)} style={{ width: '100%' }} accessibleName="Text der E-Mail" />
              <Text className="portal-small" style={{ display: 'block', marginTop: '0.25rem', color: text.includes('{Link}') ? 'var(--sapContent_LabelColor)' : 'var(--sapNegativeTextColor)' }}>
                Platzhalter: {platzhalter.join(' ')} – {'{Link}'} ist Pflicht (persönlicher Link je Mitglied). Der QR-Code hängt als Bild an. Briefe behalten ihren festen Text.
              </Text>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

/** Umschalter oben im Dialog „Einladen & Zugangslinks“ */
function ModusWahl({ modus, onModus }: { modus: 'QR' | 'LISTE'; onModus: () => void }) {
  return (
    <SegmentedButton style={{ marginBottom: '0.75rem' }} onSelectionChange={(e) => { if ((e.detail.selectedItems[0] as HTMLElement).dataset.m !== modus) onModus(); }}>
      <SegmentedButtonItem data-m="QR" icon="qr-code" selected={modus === 'QR'}>Mitglieder ohne Benutzer einladen</SegmentedButtonItem>
      <SegmentedButtonItem data-m="LISTE" icon="paste" selected={modus === 'LISTE'}>Zugangslink an Personen aus Liste</SegmentedButtonItem>
    </SegmentedButton>
  );
}

/**
 * Zugangslinks an ausgewählte Personen (#105): Namen einfügen (z. B. Tabelle „User | Anzahl“ oder kommagetrennt), mit Benutzern
 * und Mitgliedern abgleichen, Text vorgeschlagen und änderbar, optional ein PDF als Anhang. Benutzer erhalten einen
 * Einmal-Link zum Setzen des Kennworts, Mitglieder ohne Benutzer die Einladung zum Vereinsportal.
 */
interface ZEmpf { key: string; art: 'BENUTZER' | 'EINLADUNG'; name: string; benutzername: string | null; email: string | null }
interface ZZeile { eingabe: string; treffer: ZEmpf[] }
const Z = '/api/m/tco/mitglieder/zugang';
function ZugangslinkDialog({ onClose, onModus }: { onClose: () => void; onModus: () => void }) {
  const [eingabe, setEingabe] = useState('');
  const [zeilen, setZeilen] = useState<ZZeile[] | null>(null);
  // je Eingabezeile der gewählte Empfänger ('' = nicht senden)
  const [wahl, setWahl] = useState<Record<string, string>>({});
  const [betreff, setBetreff] = useState('');
  const [text, setText] = useState('');
  const [platzhalter, setPlatzhalter] = useState<string[]>([]);
  const [tage, setTage] = useState(14);
  const [pdf, setPdf] = useState<{ name: string; data: string } | null>(null);
  const datei = useRef<HTMLInputElement>(null);
  const [cc, setCc] = useState(false);
  const [ccAdresse, setCcAdresse] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<{ text: string; zeilen: { key: string; ok: boolean; name: string; an: string; text: string }[] } | null>(null);
  useEffect(() => {
    api.get<{ betreff: string; text: string; platzhalter: string[]; cc: string | null }>(`${Z}/vorlage`)
      .then((v) => { setBetreff(v.betreff); setText(v.text); setPlatzhalter(v.platzhalter); setCcAdresse(v.cc); }).catch((e) => setError(e.message));
  }, []);
  async function abgleichen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<ZZeile[]>(`${Z}/abgleich`, { text: eingabe });
      setZeilen(r);
      // eindeutige Treffer mit E-Mail vorbelegen
      setWahl(Object.fromEntries(r.map((z) => [z.eingabe, z.treffer.length === 1 && z.treffer[0].email ? z.treffer[0].key : ''])));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function pdfWaehlen(f: File | undefined) {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setError('Die PDF-Datei ist größer als 10 MB.'); return; }
    const r = new FileReader();
    r.onload = () => setPdf({ name: f.name, data: String(r.result) });
    r.readAsDataURL(f);
  }
  const empfaenger = [...new Set(Object.values(wahl).filter(Boolean))];
  async function senden() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<NonNullable<typeof ergebnis>>(`${Z}/senden`, { empfaenger, betreff, text, tage, pdf, cc });
      setErgebnis(r);
      toast(r.text, 8000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const treffer = (key: string) => zeilen?.flatMap((z) => z.treffer).find((t) => t.key === key);
  const zelle = { padding: '0.3rem 0.5rem', borderTop: '1px solid var(--sapList_BorderColor)', verticalAlign: 'middle' } as const;
  return (
    <Dialog open headerText="Einladen & Zugangslinks" style={{ width: 'min(60rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={ergebnis ? <Button onClick={onClose}>Schließen</Button> : <>
              <Button design="Emphasized" icon="paper-plane" loading={busy} disabled={!empfaenger.length || !text.includes('{Link}') || !betreff.trim()} onClick={senden}>
                {empfaenger.length} E-Mail{empfaenger.length === 1 ? '' : 's'} senden
              </Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <ModusWahl modus="LISTE" onModus={onModus} />
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {ergebnis ? (
        <>
          <MessageStrip design={ergebnis.zeilen.every((z) => z.ok) ? 'Positive' : 'Critical'} hideCloseButton style={{ marginBottom: '0.5rem' }}>{ergebnis.text}</MessageStrip>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{['Person', 'E-Mail', 'Ergebnis'].map((h) => <th key={h} style={{ ...zelle, borderTop: 'none', textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
            <tbody>{ergebnis.zeilen.map((z) => (
              <tr key={z.key}>
                <td style={zelle}><Text>{z.name || treffer(z.key)?.name || z.key}</Text></td>
                <td style={zelle}><Text>{z.an || treffer(z.key)?.email || '–'}</Text></td>
                <td style={zelle}><ObjectStatus state={z.ok ? 'Positive' : 'Negative'} showDefaultIcon>{z.text}</ObjectStatus></td>
              </tr>
            ))}</tbody>
          </table>
        </>
      ) : (
        <>
          <Label showColon>1 · Personen einfügen (eine je Zeile, Tabelle aus der Zwischenablage oder kommagetrennt)</Label>
          <TextArea rows={5} value={eingabe} placeholder={'Simone Wilhelm\nKonstantin Born\nAdrian Schuler, Claus Baltes'} style={{ width: '100%' }}
                    onInput={(e) => setEingabe(e.target.value)} />
          <Button icon="synchronize" disabled={!eingabe.trim() || busy} onClick={abgleichen} style={{ margin: '0.25rem 0 0.75rem' }}>Abgleichen</Button>
          {zeilen && (
            <div style={{ maxHeight: '30vh', overflowY: 'auto', border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem', marginBottom: '0.75rem' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr>{['Eingabe', 'Empfänger', 'E-Mail', 'Link'].map((h) => <th key={h} style={{ ...zelle, borderTop: 'none', textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
                <tbody>{zeilen.map((z) => {
                  const t = treffer(wahl[z.eingabe] ?? '');
                  return (
                    <tr key={z.eingabe}>
                      <td style={zelle}><Text>{z.eingabe}</Text></td>
                      <td style={zelle}>
                        {!z.treffer.length ? <ObjectStatus state="Negative" showDefaultIcon>nicht gefunden</ObjectStatus> : (
                          <Select style={{ width: '100%' }} onChange={(e) => setWahl({ ...wahl, [z.eingabe]: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
                            <Option data-k="" selected={!wahl[z.eingabe]}>– nicht senden –</Option>
                            {z.treffer.map((x) => (
                              <Option key={x.key} data-k={x.key} selected={wahl[z.eingabe] === x.key}>
                                {x.name}{x.benutzername ? ` (${x.benutzername})` : ' (Mitglied ohne Benutzer)'}
                              </Option>
                            ))}
                          </Select>
                        )}
                        {z.treffer.length > 1 && !wahl[z.eingabe] && <Text className="portal-muted portal-small">{z.treffer.length} Treffer – bitte wählen</Text>}
                      </td>
                      <td style={zelle}>{t ? (t.email ? <Text>{t.email}</Text> : <ObjectStatus state="Negative">keine E-Mail</ObjectStatus>) : <Text>–</Text>}</td>
                      <td style={zelle}>{t && <Text>{t.art === 'BENUTZER' ? 'Kennwort setzen' : 'Einladung'}</Text>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
          <Label showColon>2 · E-Mail (Vorschlag, frei änderbar)</Label>
          <Input value={betreff} onInput={(e) => setBetreff(e.target.value)} style={{ width: '100%', margin: '0.25rem 0' }} accessibleName="Betreff" placeholder="Betreff" />
          <TextArea rows={10} value={text} onInput={(e) => setText(e.target.value)} style={{ width: '100%' }} accessibleName="Text der E-Mail" />
          <Text className={`portal-small ${text.includes('{Link}') ? 'portal-muted' : ''}`} style={{ display: 'block', margin: '0.25rem 0 0.75rem', color: text.includes('{Link}') ? undefined : 'var(--sapNegativeTextColor)' }}>
            Platzhalter: {platzhalter.join(' ')} – {'{Link}'} ist Pflicht (persönlicher Link je Empfänger).
          </Text>
          <Label showColon>3 · Gültigkeit und Anhang</Label>
          <div className="portal-row" style={{ gap: '1rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.25rem' }}>
            <StepInput value={tage} min={1} max={60} style={{ width: '8rem' }} accessibleName="Gültigkeit in Tagen" onChange={(e) => setTage(Number(e.target.value) || 14)} />
            <Text>Tage gültig, einmal verwendbar</Text>
            <input ref={datei} type="file" accept="application/pdf,.pdf" style={{ display: 'none' }} onChange={(e) => { pdfWaehlen(e.target.files?.[0]); e.target.value = ''; }} />
            <Button icon="pdf-attachment" onClick={() => datei.current?.click()}>{pdf ? 'Anderes PDF' : 'PDF anhängen'}</Button>
            {pdf && <><Text>{pdf.name}</Text><Button design="Transparent" icon="decline" tooltip="Anhang entfernen" onClick={() => setPdf(null)} /></>}
          </div>
          <CheckBox text={`Kopie (CC) jeder E-Mail an mich${ccAdresse ? ` – ${ccAdresse}` : ' (keine E-Mail-Adresse bei meinem Benutzer hinterlegt)'}`}
                    checked={cc} disabled={!ccAdresse} onChange={(e) => setCc(e.target.checked)} style={{ marginTop: '0.25rem' }} />
        </>
      )}
    </Dialog>
  );
}
