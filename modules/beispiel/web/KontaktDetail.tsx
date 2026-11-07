import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BusyIndicator, Button, MessageStrip, Panel } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { CheckField, FormGrid, TextField } from '@core/components/FormFields';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import type { Kontakt } from './KontakteList';

const empty: Partial<Kontakt> = { name: '', firma: '', email: '', telefon: '', notiz: '', aktiv: true };

/** Objektseite: Anzeigen/Ändern mit Bearbeiten-Modus wie in Fiori. */
export function KontaktDetail() {
  const { id } = useParams();
  const isNew = id === 'neu';
  const navigate = useNavigate();
  const can = useCan();
  const mayEdit = can('beispiel.kontakte:edit');

  const [k, setK] = useState<Partial<Kontakt> | null>(isNew ? empty : null);
  const [orig, setOrig] = useState<Partial<Kontakt> | null>(null);
  const [editing, setEditing] = useState(isNew);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setEditing(isNew);
    setError(null);
    if (isNew) { setK(empty); return; }
    api.get<Kontakt>(`/api/m/beispiel/kontakte/${id}`)
      .then((d) => { setK(d); setOrig(d); })
      .catch((e) => setError(e.message));
  }, [id, isNew]);

  const set = (f: keyof Kontakt) => (v: string | boolean) => setK({ ...k!, [f]: v });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name: k!.name, firma: k!.firma, email: k!.email, telefon: k!.telefon, notiz: k!.notiz, aktiv: k!.aktiv };
      if (isNew) {
        const r = await api.post<{ id: string; nummer: string }>('/api/m/beispiel/kontakte', body);
        toast(`Kontakt ${r.nummer} angelegt`);
        navigate(`/beispiel/kontakte/${r.id}`, { replace: true });
      } else {
        await api.put(`/api/m/beispiel/kontakte/${id}`, body);
        setOrig(k);
        setEditing(false);
        toast('Kontakt gesichert');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(reason: string) {
    setConfirmDelete(false);
    try {
      await api.del(`/api/m/beispiel/kontakte/${id}`, { reason });
      toast('Kontakt gelöscht');
      navigate('/beispiel/kontakte');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!k) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : <BusyIndicator active style={{ margin: '2rem' }} />;
  const ro = !editing;

  return (
    <AppPage
      title={isNew ? 'Neuer Kontakt' : k.name || ''}
      subtitle={isNew ? undefined : `${k.nummer}${k.firma ? ' · ' + k.firma : ''}`}
      actions={!isNew && <>
        <ChangeHistoryButton objectType="KONTAKT" objectKey={k.nummer!} />
        <Button icon="pdf-attachment" onClick={() => window.open(`/api/m/beispiel/kontakte/${id}/pdf`, '_blank')}>PDF</Button>
        {mayEdit && !editing && <Button design="Emphasized" icon="edit" onClick={() => setEditing(true)}>Bearbeiten</Button>}
        {can('beispiel.kontakte:delete') && !editing && (
          <Button design="Transparent" icon="delete" onClick={() => setConfirmDelete(true)}>Löschen</Button>
        )}
      </>}
      footer={editing && <>
        <Button design="Emphasized" loading={busy} onClick={save}>Sichern</Button>
        <Button onClick={() => (isNew ? navigate('/beispiel/kontakte') : (setK(orig), setEditing(false), setError(null)))}>Abbrechen</Button>
      </>}
    >
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <Panel headerText="Allgemein" fixed>
        <FormGrid>
          <TextField label="Name" required value={k.name} readonly={ro} onChange={set('name')} />
          <TextField label="Firma" value={k.firma} readonly={ro} onChange={set('firma')} />
          <TextField label="E-Mail" type="Email" value={k.email} readonly={ro} onChange={set('email')} />
          <TextField label="Telefon" type="Tel" value={k.telefon} readonly={ro} onChange={set('telefon')} />
          <CheckField label="Aktiv" checked={!!k.aktiv} readonly={ro} onChange={set('aktiv')} />
        </FormGrid>
      </Panel>
      <Panel headerText="Notiz" fixed style={{ marginTop: '1rem' }}>
        <FormGrid columns={1}>
          <TextField label="Notiz" multiline value={k.notiz} readonly={ro} onChange={set('notiz')} />
        </FormGrid>
      </Panel>

      <ConfirmDialog
        open={confirmDelete}
        danger
        askReason
        title="Kontakt löschen"
        text={`Kontakt ${k.nummer} (${k.name}) endgültig löschen? Der Vorgang bleibt im Änderungsbeleg nachvollziehbar.`}
        confirmText="Löschen"
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </AppPage>
  );
}
