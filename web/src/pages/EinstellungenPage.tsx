import { useSearchParams } from 'react-router-dom';
import { Icon, MessageStrip } from '@ui5/webcomponents-react';
import { AppPage } from '../components/AppPage';
import { kapitelGruppen } from '../einstellungen';
import { enabledModules } from '../modules';
import { useCan, useSession } from '../session';

/**
 * Administration → Einstellungen (#232, E1): eine App für alle Einstellungen. Links die Kapitel je Anwendung (Portal,
 * TC Oberthal, Euroflex …), rechts das gewählte Kapitel. Das Kapitel steht in der Adresse (?kapitel=tco.verein), damit
 * die Fach-Apps direkt hineinspringen können.
 */
export function EinstellungenPage() {
  const { me } = useSession();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const gruppen = kapitelGruppen(enabledModules(me.modules), can);
  const alle = gruppen.flatMap((g) => g.kapitel.map((k) => ({ g, k, key: `${g.modul}.${k.id}` })));
  const gewaehlt = alle.find((x) => x.key === params.get('kapitel')) ?? alle[0];
  if (!gewaehlt) {
    return <AppPage title="Einstellungen"><MessageStrip design="Information" hideCloseButton>Für keines der Kapitel liegt eine Berechtigung vor.</MessageStrip></AppPage>;
  }
  const Kapitel = gewaehlt.k.component;
  return (
    <AppPage title="Einstellungen" subtitle={`${gewaehlt.g.name} › ${gewaehlt.k.text}`}>
      <div className="portal-einst">
        <nav className="portal-einst__kapitel" aria-label="Kapitel der Einstellungen">
          {gruppen.map((g) => (
            <div key={g.modul} className="portal-einst__block">
              <div className="portal-einst__gruppe">{g.name}</div>
              {g.kapitel.map((k) => {
                const key = `${g.modul}.${k.id}`;
                const aktiv = key === gewaehlt.key;
                return (
                  <button key={key} type="button" className={`portal-einst__eintrag${aktiv ? ' portal-einst__eintrag--aktiv' : ''}`}
                          aria-current={aktiv ? 'page' : undefined} onClick={() => setParams({ kapitel: key })}>
                    <Icon name={k.icon ?? 'action-settings'} />
                    <span>{k.text}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        {/* key: beim Wechsel des Kapitels neu aufbauen – jedes Kapitel lädt und sperrt für sich */}
        <div className="portal-einst__inhalt"><Kapitel key={gewaehlt.key} /></div>
      </div>
    </AppPage>
  );
}
