import { useCallback, useEffect, useState } from 'react';
import { BusyIndicator, FlexBox, MessageStrip } from '@ui5/webcomponents-react';
import { api, ApiError } from './api';
import { SessionContext, type Me } from './session';
import { ForcedPasswordPage, KennwortSetzenPage, LoginPage, SetupPage } from './pages/AuthPages';
import { allModules, enabledModules } from './modules';
import { Shell } from './shell/Shell';
import { applyBranding } from './branding';

type State =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'login'; settings: Record<string, unknown> }
  | { kind: 'ready'; me: Me }
  | { kind: 'error'; message: string }
  /** ohne Anmeldung: Einmal-Link (?kennwort=) oder öffentliche Modulseite (z. B. /beitritt) */
  | { kind: 'oeffentlich'; settings: Record<string, unknown> };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const { needsSetup } = await api.get<{ needsSetup: boolean }>('/api/setup/status');
      if (needsSetup) return setState({ kind: 'setup' });
      const q = new URLSearchParams(window.location.search);
      if (q.has('kennwort') || oeffentlicheSeite(window.location.pathname, null)) {
        const settings = await api.get<Record<string, unknown>>('/api/settings/public');
        if (q.has('kennwort') || oeffentlicheSeite(window.location.pathname, settings)) {
          applyBranding(settings);
          return setState({ kind: 'oeffentlich', settings });
        }
      }
      try {
        const me = await api.get<Me>('/api/auth/me');
        applyBranding(me.settings);
        setState({ kind: 'ready', me });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          const settings = await api.get<Record<string, unknown>>('/api/settings/public');
          applyBranding(settings);
          setState({ kind: 'login', settings });
        } else throw e;
      }
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    }
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {});
    window.history.replaceState(null, '', '/');
    await load();
  }, [load]);

  useEffect(() => { load(); }, [load]);

  switch (state.kind) {
    case 'loading':
      return <FlexBox justifyContent="Center" alignItems="Center" style={{ height: '100%' }}><BusyIndicator active /></FlexBox>;
    case 'error':
      return <MessageStrip design="Negative" hideCloseButton>Server nicht erreichbar: {state.message}</MessageStrip>;
    case 'setup':
      return <SetupPage onDone={load} />;
    case 'oeffentlich': {
      const orgName = (state.settings['org.name'] as string) ?? 'Portal';
      const logo = state.settings['org.logo'] as string | undefined;
      const fertig = () => { window.history.replaceState(null, '', '/'); load(); };
      const token = new URLSearchParams(window.location.search).get('kennwort');
      if (token) return <KennwortSetzenPage orgName={orgName} logo={logo} token={token} onDone={fertig} />;
      const Seite = oeffentlicheSeite(window.location.pathname, state.settings);
      return Seite ? <Seite orgName={orgName} logo={logo} onFertig={fertig} /> : null;
    }
    case 'login':
      return <LoginPage orgName={(state.settings['org.name'] as string) ?? 'Portal'} logo={state.settings['org.logo'] as string | undefined} onDone={load}
                        registrierung={(state.settings.registrierung as { pfad: string; titel: string; text: string } | null) ?? null} />;
    case 'ready':
      if (state.me.user.mustChangePassword) return <ForcedPasswordPage onDone={load} onLogout={logout} />;
      return (
        <SessionContext.Provider value={{ me: state.me, reload: load, logout }}>
          <Shell />
        </SessionContext.Provider>
      );
  }
}

/** öffentliche Seite eines aktiven Moduls zum Pfad (settings = null: nur prüfen, ob ein Modul den Pfad kennt) */
function oeffentlicheSeite(pfad: string, settings: Record<string, unknown> | null) {
  const ids = settings ? ((settings.module as string[] | undefined) ?? []) : null;
  const mods = ids ? enabledModules(ids) : allModules();
  for (const m of mods) {
    const s = m.oeffentlich?.find((x) => x.pfad === pfad.replace(/\/+$/, ''));
    if (s) return s.component;
  }
  return null;
}
