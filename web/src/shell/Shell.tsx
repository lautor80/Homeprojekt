import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Avatar, Button, Dialog, IllustratedMessage, NavigationLayout, ShellBar, ShellBarBranding,
  SideNavigation, SideNavigationGroup, SideNavigationItem, SideNavigationSubItem, UserMenu, UserMenuAccount, UserMenuItem,
} from '@ui5/webcomponents-react';
import { useSession, useCan } from '../session';
import { coreRoutes } from './core';
import { useNavHinweise } from '../navhinweis';
import { navAufbauen } from './nav';
import { enabledModules } from '../modules';
import type { NavEntry, RouteDef } from '../platform';
import { ChangePasswordForm } from '../pages/AuthPages';
import { toast } from '../toast';
import { api } from '../api';
import { aktuelleErscheinung, erscheinungSetzen } from '../theme';
import { AblageProvider } from '../ablage';

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
}

function NoAccess() {
  return <IllustratedMessage name="UnableToLoad" titleText="Keine Berechtigung" subtitleText="Für diese Seite fehlt Ihnen die Berechtigung." />;
}

function NotFound() {
  return <IllustratedMessage name="PageNotFound" titleText="Seite nicht gefunden" />;
}

export function Shell() {
  const { me, logout } = useSession();
  const can = useCan();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(window.innerWidth < 900);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [dunkel, setDunkel] = useState(aktuelleErscheinung() === 'dunkel');
  const profileRef = useRef<HTMLElement | null>(null);
  // Weltenwandler: ohne neue Anmeldung zu anderen Benutzern mit dieser Rolle wechseln (Berechtigungstests)
  const [welten, setWelten] = useState<{ id: string; username: string; name: string; rollen: string; ursprung: boolean }[]>([]);
  const wandler = me.user.roles.includes('WELTENWANDLER');
  useEffect(() => {
    if (!wandler) { setWelten([]); return; }
    api.get<{ benutzer: typeof welten }>('/api/auth/weltenwandler').then((r) => setWelten(r.benutzer)).catch(() => setWelten([]));
  }, [wandler, me.user.id]);
  async function wechseln(id: string) {
    setMenuOpen(false);
    try {
      const r = await api.post<{ name: string }>('/api/auth/weltenwandler', { userId: id });
      sessionStorage.setItem('weltenwandler.meldung', `Gewechselt zu ${r.name}.`);
      window.location.assign('/');
    } catch (e) { toast((e as Error).message, 6000); }
  }
  useEffect(() => {
    const m = sessionStorage.getItem('weltenwandler.meldung');
    if (m) { sessionStorage.removeItem('weltenwandler.meldung'); toast(m, 4000); }
  }, []);

  const modules = enabledModules(me.modules);
  const orgName = (me.settings['org.name'] as string) || 'Portal';
  /** Kopf: Organisation, dahinter der angemeldete Benutzer – „TC Oberthal · Torsten Laub (TorstenLaub)“ */
  const kopfTitel = `${orgName} · ${me.user.displayName && me.user.displayName !== me.user.username
    ? `${me.user.displayName} (${me.user.username})` : me.user.username}`;
  const logo = me.settings['org.logo'] as string | undefined;

  // Navigation: Start, Fachmodule, Administration – gefiltert nach Berechtigung (gleiche Quelle wie die Startseite)
  const nav = useMemo(() => navAufbauen(modules, can), [me]); // eslint-disable-line react-hooks/exhaustive-deps

  const routes: RouteDef[] = [...coreRoutes, ...modules.flatMap((m) => m.routes)];
  const widgets = modules.flatMap((m) => m.sideWidgets ?? []).filter((w) => can(w.permission));
  const waechter = modules.flatMap((m) => m.waechter ?? []).filter((w) => can(w.permission));
  // Hinweise an Menüeinträgen („3 neu“) – am Eintrag selbst und, solange eingeklappt, an der Gruppe darüber
  const hinweise = useNavHinweise();
  const neu = (e: NavEntry): number => (e.path ? hinweise[e.path] ?? 0 : 0) + (e.children ?? []).reduce((n, c) => n + neu(c), 0);
  // roter Tag am Eintrag (CSS: [data-neu]::after); Tooltip nennt die Anzahl
  const tag = (e: NavEntry) => { const n = neu(e); return n ? { 'data-neu': n > 99 ? '99+' : String(n), tooltip: `${e.text} – ${n} neue Aufgabe${n === 1 ? '' : 'n'}` } : {}; };

  /** Auf dem Handy liegt die Navigation über dem Inhalt: nach der Auswahl wieder einklappen */
  const gehe = (path: string) => { navigate(path); if (window.innerWidth < 600) setCollapsed(true); };

  const isSelected = (path?: string) =>
    !!path && (path === '/' ? location.pathname === '/' : location.pathname === path || location.pathname.startsWith(path + '/'));

  // Stufe 2: Eintrag (direkt aufrufbar oder mit Stufe 3 aufklappbar), Stufe 3: Untereintrag
  const eingerueckt = collapsed ? undefined : { display: 'block', marginInlineStart: '1.5rem' };
  const sub = (e: NavEntry) => (
    <SideNavigationSubItem key={e.path ?? e.text} text={e.text} icon={e.icon} {...tag(e)} selected={isSelected(e.path)}
                           style={eingerueckt}
                           onClick={() => e.path && gehe(e.path)} />
  );
  // Stufe-2-Gruppen sind eingeklappt; nur die Gruppe mit der geöffneten Seite klappt automatisch auf.
  // Der Benutzer kann jede Gruppe selbst auf- und zuklappen (der Zustand bleibt bis zum Seitenwechsel in eine andere Gruppe).
  const enthaeltAktiv = (e: NavEntry): boolean => !!e.children?.some((c) => isSelected(c.path) || enthaeltAktiv(c));
  const item = (e: NavEntry, einruecken = false) => (
    <SideNavigationItem key={e.path ?? e.text} text={e.text} icon={e.icon} {...tag(e)} selected={!e.children && isSelected(e.path)}
                        style={einruecken ? eingerueckt : undefined}
                        expanded={e.children ? enthaeltAktiv(e) : undefined} unselectable={!!e.children}
                        onClick={() => !e.children && e.path && gehe(e.path)}>
      {e.children?.map(sub)}
    </SideNavigationItem>
  );

  return (
    <AblageProvider>
      {waechter.map((w, i) => <w.component key={i} />)}
      <NavigationLayout
        mode={collapsed ? 'Collapsed' : 'Expanded'}
        style={{ height: '100%' }}
        header={
          <ShellBar
            primaryTitle={kopfTitel}
            branding={
              <ShellBarBranding onClick={() => navigate('/')} logo={logo ? <img src={logo} alt="" /> : undefined}>
                {kopfTitel}
              </ShellBarBranding>
            }
            startButton={<Button icon="menu2" design="Transparent" tooltip="Navigation ein-/ausblenden" onClick={() => setCollapsed(!collapsed)} />}
            profile={<Avatar initials={initials(me.user.displayName)} ref={(el) => { profileRef.current = el as HTMLElement | null; }} />}
            onProfileClick={() => setMenuOpen(true)}
          />
        }
        sideContent={
          <div className={`portal-side${collapsed ? ' portal-side--eingeklappt' : ''}`}>
          <SideNavigation collapsed={collapsed} className="portal-side__nav">
            {nav.map((e) =>
              e.children ? (
                <SideNavigationGroup key={e.text} text={e.text} expanded>
                  {e.children.map((c) => item(c, !!e.einruecken))}
                </SideNavigationGroup>
              ) : (
                item(e)
              ),
            )}
          </SideNavigation>
          {widgets.length > 0 && (
            <div className={`portal-side__widgets${collapsed ? ' portal-side__widgets--eingeklappt' : ''}`}>
              {widgets.map((w, i) => <w.component key={i} collapsed={collapsed} />)}
            </div>
          )}
          </div>
        }
      >
        <div className="portal-content">
          <Routes>
            {routes.map((r) => {
              const C = r.component;
              const el: ReactElement = can(r.permission) ? <><Nutzung pfad={r.path} /><C /></> : <NoAccess />;
              return <Route key={r.path} path={r.path} element={el} />;
            })}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </NavigationLayout>

      <UserMenu
        open={menuOpen}
        opener={profileRef.current}
        onClose={() => setMenuOpen(false)}
        onSignOutClick={() => { setMenuOpen(false); logout(); }}
        onItemClick={(e) => { const id = (e.detail.item as HTMLElement | undefined)?.dataset?.wechsel; if (id) wechseln(id); }}
        accounts={
          <UserMenuAccount
            titleText={me.user.displayName}
            subtitleText={me.user.username}
            description={me.user.roles.join(', ')}
            avatarInitials={initials(me.user.displayName)}
            selected
          />
        }
      >
        {wandler && welten.some((w) => w.id !== me.user.id) && (
          <UserMenuItem icon="switch-views" text="Benutzer wechseln (Weltenwandler)">
            {welten.filter((w) => w.id !== me.user.id).map((w) => (
              <UserMenuItem key={w.id} icon={w.ursprung ? 'home' : 'person-placeholder'} text={`${w.name}${w.ursprung ? ' (Anmeldung)' : ''}`}
                            additionalText={w.rollen || w.username} data-wechsel={w.id} />
            ))}
          </UserMenuItem>
        )}
        <UserMenuItem icon="key" text="Passwort ändern" onClick={() => { setMenuOpen(false); setPwOpen(true); }} />
        <UserMenuItem icon={dunkel ? 'light-mode' : 'dark-mode'} text={dunkel ? 'Helles Design' : 'Dunkles Design'}
                      onClick={() => { const d = !dunkel; setDunkel(d); erscheinungSetzen(d ? 'dunkel' : 'hell'); setMenuOpen(false); }} />
      </UserMenu>

      <Dialog open={pwOpen} headerText="Passwort ändern" onClose={() => setPwOpen(false)} style={{ width: 'min(420px, 95vw)' }}>
        {pwOpen && <ChangePasswordForm onDone={() => { setPwOpen(false); toast('Passwort geändert'); }} />}
      </Dialog>
    </AblageProvider>
  );
}

/** Aufruf einer App für die Nutzungsstatistik melden (still, Fehler ohne Wirkung) */
function Nutzung({ pfad }: { pfad: string }) {
  useEffect(() => { api.post('/api/nutzung', { pfad }).catch(() => undefined); }, [pfad]);
  return null;
}
