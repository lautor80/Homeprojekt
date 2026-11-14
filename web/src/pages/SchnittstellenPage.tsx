import { Fragment, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { MessageStrip, Tab, TabContainer, Text } from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage, Eingebettet } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import { useCan } from '../session';
import { ApiKeysPage } from './ApiKeysPage';
import { PaperlessMappingPage } from './PaperlessMappingPage';
import { Verbindung, type Gruppe } from './Verbindung';

/**
 * Administration → Schnittstellen (#232, S1): eine App, ein Reiter je Schnittstelle (Paperless, E-Mail, EP3 …). In jedem Reiter
 * steht je Bereich ein Block mit dem Zugang; im Reiter „Paperless“ darunter die Ablageregeln, im Reiter „API-Schlüssel“ der
 * Zugriff von außen. Die bisherigen Apps Anbindungen, Paperless-Zuordnung und API-Schlüssel gehen darin auf.
 * Welche Anbindung in welchen Reiter gehört, sagt der Server (VerbindungDef.reiter) – ein neuer Name ist ein neuer Reiter.
 */
export const SCHNITTSTELLEN_PFAD = '/admin/schnittstellen';
/** Reihenfolge der bekannten Reiter; weitere folgen in der Reihenfolge, in der Module sie anmelden */
const REIHENFOLGE = ['Paperless', 'E-Mail', 'EP3', 'Trainerstunden', 'Schulferien', 'Nextcloud'];
const API = 'api';
/** Schlüssel eines Reiters für die Adresse (?tab=paperless) */
export const reiterSchluessel = (reiter: string): string => reiter.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function SchnittstellenPage() {
  const can = useCan();
  const darfZugang = can('core.settings:edit');
  const darfApi = can('core.apikeys:display');
  const loaded = useLoad(() => (darfZugang ? api.get<{ gruppen: Gruppe[] }>('/api/verbindungen') : Promise.resolve({ gruppen: [] as Gruppe[] })));
  const gruppen = loaded.data?.gruppen ?? [];
  const namen = [...new Set(gruppen.flatMap((g) => g.verbindungen.map((d) => d.reiter)))]
    .sort((a, b) => (REIHENFOLGE.indexOf(a) + 1 || 99) - (REIHENFOLGE.indexOf(b) + 1 || 99));
  const reiter = [...namen.map((text) => ({ key: reiterSchluessel(text), text })), ...(darfApi ? [{ key: API, text: 'API-Schlüssel' }] : [])];
  // Reiter per Adresse aufrufbar, z. B. /admin/schnittstellen?tab=paperless
  const [tab, setTabState] = useState(() => new URLSearchParams(window.location.search).get('tab'));
  const setTab = (t: string) => {
    setTabState(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  };
  const aktiv = reiter.find((r) => r.key === tab) ?? reiter[0];

  return (
    <AppPage title="Schnittstellen" subtitle="Ein Reiter je Schnittstelle – darin je Bereich der Zugang, bei Paperless auch die Ablageregeln">
      {loaded.error && <MessageStrip design="Negative" style={{ marginBottom: '1rem' }}>{loaded.error}</MessageStrip>}
      {reiter.length > 0 && (
        <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)} style={{ marginBottom: '1rem' }}>
          {reiter.map((r) => <Tab key={r.key} data-key={r.key} text={r.text} selected={aktiv?.key === r.key} />)}
        </TabContainer>
      )}
      {aktiv && aktiv.key !== API && (
        <div key={aktiv.key}>
          {gruppen.filter((g) => g.verbindungen.some((d) => d.reiter === aktiv.text)).map((g) => (
            <Fragment key={g.modul}>
              {/* je Bereich ein Block – der Zugang gehört zum Bereich, nur der E-Mail-Versand des Portals gilt für alle */}
              <div className="portal-schnitt__bereich">{g.modul === 'core' ? 'Portal' : g.name}</div>
              {g.verbindungen.filter((d) => d.reiter === aktiv.text).map((d) => <Verbindung key={d.id} def={d} />)}
            </Fragment>
          ))}
          {aktiv.text === 'Paperless' && (
            <>
              <div className="portal-schnitt__bereich">Ablageregeln je Bereich</div>
              <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
                Was wohin abgelegt wird (Dokumenttyp, Speicherpfad, Korrespondent, Felder). Die Auswahllisten kommen aus dem Paperless des jeweiligen Bereichs.
              </Text>
              <Eingebettet><PaperlessMappingPage /></Eingebettet>
            </>
          )}
        </div>
      )}
      {aktiv?.key === API && <Eingebettet><ApiKeysPage /></Eingebettet>}
      {!loaded.loading && reiter.length === 0 && <MessageStrip design="Information" hideCloseButton>Für keine Schnittstelle liegt eine Berechtigung vor.</MessageStrip>}
    </AppPage>
  );
}

/** bisherige Adressen der drei Apps – springen in den passenden Reiter (Lesezeichen, Hinweise im Arbeitsvorrat) */
export function ZuAnbindungen() { return <Navigate to={SCHNITTSTELLEN_PFAD} replace />; }
export function ZuPaperlessZuordnung() { return <Navigate to={`${SCHNITTSTELLEN_PFAD}?tab=paperless`} replace />; }
export function ZuApiSchluessel() { return <Navigate to={`${SCHNITTSTELLEN_PFAD}?tab=${API}`} replace />; }
