import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { MessageStrip, Tab, TabContainer, Text } from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage, Eingebettet } from '../components/AppPage';
import { useLoad } from '../components/useLoad';
import { enabledModules } from '../modules';
import { REITER_API as API, reiterSchluessel, SCHNITTSTELLEN_PFAD, schnittstellenAbschnitte } from '../schnittstellen';
import { Section } from '../components/Section';
import { useCan, useSession } from '../session';
import { ApiKeysPage } from './ApiKeysPage';
import { PaperlessMappingPage } from './PaperlessMappingPage';
import { Verbindung, type Gruppe } from './Verbindung';

/**
 * Administration → Schnittstellen (#232, S1): eine App, ein Reiter je Schnittstelle (Paperless, E-Mail, EP3 …). In jedem Reiter
 * steht je Bereich ein Block mit dem Zugang; im Reiter „Paperless“ darunter die Ablageregeln, im Reiter „API-Schlüssel“ der
 * Zugriff von außen. Die bisherigen Apps Anbindungen, Paperless-Zuordnung und API-Schlüssel gehen darin auf.
 * Welche Anbindung in welchen Reiter gehört, sagt der Server (VerbindungDef.reiter) – ein neuer Name ist ein neuer Reiter.
 */
/** Reihenfolge der bekannten Reiter; weitere folgen in der Reihenfolge, in der Module sie anmelden */
const REIHENFOLGE = ['Paperless', 'E-Mail', 'EP3', 'Trainerstunden', 'Schulferien', 'Nextcloud', 'SAP'];

export function SchnittstellenPage() {
  const can = useCan();
  const { me } = useSession();
  const abschnitte = schnittstellenAbschnitte(enabledModules(me.modules), can);
  const darfZugang = can('core.settings:edit');
  const darfApi = can('core.apikeys:display');
  const loaded = useLoad(() => (darfZugang ? api.get<{ gruppen: Gruppe[] }>('/api/verbindungen') : Promise.resolve({ gruppen: [] as Gruppe[] })));
  const gruppen = loaded.data?.gruppen ?? [];
  const namen = [...new Set([...gruppen.flatMap((g) => g.verbindungen.map((d) => d.reiter)), ...abschnitte.flatMap((g) => g.abschnitte.map((a) => a.reiter))])]
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
  /** Blöcke eines Reiters: Portal zuerst, dann die Anwendungen – jeweils Zugänge und Abschnitte */
  const bloecke = (name: string) => {
    const module = [...new Set([...gruppen.map((g) => g.modul), ...abschnitte.map((g) => g.modul)])];
    return module.map((modul) => ({
      modul, name: modul === 'core' ? 'Portal' : gruppen.find((g) => g.modul === modul)?.name ?? abschnitte.find((g) => g.modul === modul)!.name,
      zugaenge: gruppen.find((g) => g.modul === modul)?.verbindungen.filter((d) => d.reiter === name) ?? [],
      abschnitte: abschnitte.find((g) => g.modul === modul)?.abschnitte.filter((a) => a.reiter === name) ?? [],
    })).filter((b) => b.zugaenge.length + b.abschnitte.length > 0);
  };

  return (
    <AppPage title="Schnittstellen" subtitle="Ein Reiter je Schnittstelle – darin je Bereich der Zugang, dann Importe und Regeln">
      {loaded.error && <MessageStrip design="Negative" style={{ marginBottom: '1rem' }}>{loaded.error}</MessageStrip>}
      {reiter.length > 0 && (
        <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)} style={{ marginBottom: '1rem' }}>
          {reiter.map((r) => <Tab key={r.key} data-key={r.key} text={r.text} selected={aktiv?.key === r.key} />)}
        </TabContainer>
      )}
      {aktiv && aktiv.key !== API && (
        <div key={aktiv.key}>
          {bloecke(aktiv.text).map((b) => (
            <div key={b.modul}>
              {/* je Bereich ein Block: erst der Zugang, dann die Abschnitte des Moduls (Importe, Regeln, Felder) */}
              <div className="portal-schnitt__bereich">{b.name}</div>
              {b.zugaenge.map((d) => <Verbindung key={d.id} def={d} />)}
              {b.abschnitte.map((a) => { const A = a.component; return <Section key={a.id} title={a.text}><A /></Section>; })}
            </div>
          ))}
          {aktiv.text === 'Paperless' && darfZugang && (
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
