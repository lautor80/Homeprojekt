import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, Icon, Title, Text } from '@ui5/webcomponents-react';
import { useCan, useSession } from '../session';
import { enabledModules } from '../modules';
import type { HomeTile } from '../platform';

const adminTiles: HomeTile[] = [
  { text: 'Benutzer', subtitle: 'Anlegen, sperren, Rollen zuordnen', icon: 'group', path: '/admin/benutzer', permission: 'core.users:display' },
  { text: 'Rollen', subtitle: 'Berechtigungen pflegen', icon: 'role', path: '/admin/rollen', permission: 'core.roles:display' },
  { text: 'Änderungsbelege', subtitle: 'Wer hat was wann geändert', icon: 'history', path: '/admin/aenderungsbelege', permission: 'core.audit:display' },
];

export function HomePage() {
  const { me } = useSession();
  const can = useCan();
  const navigate = useNavigate();
  const tiles = [...enabledModules(me.modules).flatMap((m) => m.tiles ?? []), ...adminTiles].filter((t) => can(t.permission));

  return (
    <div style={{ padding: '1.5rem 2rem' }}>
      <Title level="H2">Willkommen, {me.user.displayName}</Title>
      <Text style={{ color: 'var(--sapContent_LabelColor)' }}>{me.settings['org.name'] as string}</Text>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem', marginTop: '1.5rem' }}>
        {tiles.map((t) => (
          <Card key={t.path} header={
            <CardHeader interactive titleText={t.text} subtitleText={t.subtitle}
                        avatar={<Icon name={t.icon} style={{ color: 'var(--sapBrandColor)' }} />}
                        onClick={() => navigate(t.path)} />
          } />
        ))}
      </div>
    </div>
  );
}
