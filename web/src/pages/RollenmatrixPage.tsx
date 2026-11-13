import { useState } from 'react';
import { feld } from '../components/Varianten';
import { Button, MessageStrip, SegmentedButton, SegmentedButtonItem, Text } from '@ui5/webcomponents-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import type { PermGroup } from '../components/PermissionEditor';
import { useCan, useSession } from '../session';
import { RollenMatrix, type MatrixAnsicht, type MatrixRolle } from './RollenMatrix';

/**
 * Administration → Benutzerverwaltung → Rollenmatrix (#46): Rechte aller Rollen in einer Matrix pflegen, mit Prüfungen
 * (Überlappungen, Funktionstrennung …) und Verprobung für einzelne oder mehrere Benutzer.
 */
export function RollenmatrixPage() {
  const can = useCan();
  const navigate = useNavigate();
  const istAdmin = useSession().me.user.roles.includes('ADMIN');
  const roles = useLoad(() => api.get<MatrixRolle[]>('/api/admin/roles'));
  const catalog = useLoad(() => api.get<PermGroup[]>('/api/admin/permissions'));
  const [ansicht, setAnsicht] = useState<MatrixAnsicht>('MATRIX');
  return (
    <AppPage varianten={{ repid: 'core.rollenmatrix', ansicht: { ansicht }, onAnwenden: (a) => { setAnsicht(feld(a, 'ansicht', ansicht)); } }} title="Rollenmatrix" subtitle="Rechte aller Rollen nebeneinander pflegen, prüfen und für Benutzer verproben"
             actions={<Button icon="role" onClick={() => navigate('/admin/rollen')}>Rollen (Liste)</Button>}>
      {(roles.error || catalog.error) && <MessageStrip design="Negative">{roles.error ?? catalog.error}</MessageStrip>}
      <SegmentedButton style={{ marginBottom: '0.5rem' }} onSelectionChange={(e) => setAnsicht((e.detail.selectedItems[0] as HTMLElement).dataset.a as MatrixAnsicht)}>
        <SegmentedButtonItem data-a="MATRIX" icon="grid" selected={ansicht === 'MATRIX'}>Matrix</SegmentedButtonItem>
        <SegmentedButtonItem data-a="PRUEFUNG" icon="validate" selected={ansicht === 'PRUEFUNG'}>Prüfung</SegmentedButtonItem>
        <SegmentedButtonItem data-a="VERPROBUNG" icon="employee-lookup" selected={ansicht === 'VERPROBUNG'}>Verprobung</SegmentedButtonItem>
      </SegmentedButton>
      {roles.data && catalog.data
        ? <RollenMatrix ansicht={ansicht} onAnsicht={setAnsicht} roles={roles.data} catalog={catalog.data}
                        darfAendern={can('core.roles:edit')} istAdmin={istAdmin} darfBenutzer={can('core.users:display')} onGesichert={roles.reload} />
        : <Text>Lade …</Text>}
    </AppPage>
  );
}
