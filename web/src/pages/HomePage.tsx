import { useNavigate } from 'react-router-dom';
import { Icon } from '@ui5/webcomponents-react';
import { useCan, useSession } from '../session';
import { enabledModules } from '../modules';
import type { HomeTile } from '../platform';
import { Tile } from '../components/Tile';

const adminTiles: HomeTile[] = [
  { text: 'Benutzer', subtitle: 'Anlegen, sperren, Rollen zuordnen', icon: 'group', path: '/admin/benutzer', permission: 'core.users:display' },
  { text: 'Rollen', subtitle: 'Berechtigungen pflegen', icon: 'role', path: '/admin/rollen', permission: 'core.roles:display' },
  { text: 'API-Schlüssel', subtitle: 'Zugriff für Fremdsysteme', icon: 'key', path: '/admin/api-schluessel', permission: 'core.apikeys:display' },
  { text: 'Änderungsbelege', subtitle: 'Wer hat was wann geändert', icon: 'history', path: '/admin/aenderungsbelege', permission: 'core.audit:display' },
  { text: 'Einstellungen', subtitle: 'Organisation, Logo, Farbe', icon: 'action-settings', path: '/admin/einstellungen', permission: 'core.settings:edit' },
];

function gruss(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Gute Nacht';
  if (h < 11) return 'Guten Morgen';
  if (h < 18) return 'Guten Tag';
  return 'Guten Abend';
}

/** Startseite im Stil des Fiori Launchpad: je Modul eine Gruppe mit Kacheln. */
export function HomePage() {
  const { me } = useSession();
  const can = useCan();
  const navigate = useNavigate();

  const gruppen = [
    ...enabledModules(me.modules).map((m) => ({ id: m.id, name: m.name, icon: m.icon, tiles: (m.tiles ?? []).filter((t) => can(t.permission)) })),
    { id: 'admin', name: 'Administration', icon: 'action-settings', tiles: adminTiles.filter((t) => can(t.permission)) },
  ].filter((g) => g.tiles.length > 0);

  const heute = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const vorname = me.user.displayName.split(/\s+/)[0] ?? me.user.displayName;

  return (
    <div className="portal-home">
      <div className="portal-home__head">
        <h1 className="portal-home__greeting">{gruss()}, {vorname}</h1>
        <div className="portal-home__meta">{me.settings['org.name'] as string} · {heute}</div>
      </div>

      {enabledModules(me.modules).filter((m) => m.home && can(m.home.permission)).map((m) => {
        const Home = m.home!.component;
        return <section key={`home-${m.id}`} className="portal-group"><Home /></section>;
      })}

      {gruppen.map((g) => (
        <section key={g.id} className="portal-group">
          <h2 className="portal-group__title">
            {g.icon && <Icon name={g.icon} />}
            {g.name}
          </h2>
          <div className="portal-tiles">
            {g.tiles.map((t) => <Tile key={t.path} tile={t} onOpen={() => navigate(t.path)} />)}
          </div>
        </section>
      ))}

      {gruppen.length === 0 && (
        <div className="portal-section"><div className="portal-empty">Ihnen sind noch keine Anwendungen zugeordnet. Bitte wenden Sie sich an die Administration.</div></div>
      )}
    </div>
  );
}
