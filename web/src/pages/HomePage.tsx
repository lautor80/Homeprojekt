import { useNavigate } from 'react-router-dom';
import { Icon } from '@ui5/webcomponents-react';
import { useCan, useFunktion, useSession } from '../session';
import { enabledModules } from '../modules';
import type { HomeTile, NavEntry } from '../platform';
import { Tile } from '../components/Tile';
import { navAufbauen } from '../shell/nav';
import { StartArbeitsvorrat } from '../arbeitsvorrat';


/**
 * Startseite im Stil des Fiori Launchpad: oben der Arbeitsvorrat aller Anwendungen, darunter Kacheln mit Absprung –
 * aufgebaut wie die Seitenleiste.
 *  Stufe 1 (z. B. „TC Oberthal“, „Administration“): Bereich mit eigener Überschrift
 *  Stufe 2 mit Untereinträgen (z. B. „Mitglieder“): Gruppe innerhalb des Bereichs
 *  Stufe 2/3 mit Ziel: Kachel
 * Untertitel und Kennzahlen kommen aus den Kacheln der Module (gleicher Pfad), sonst nur der Name.
 */
export function HomePage() {
  const { me } = useSession();
  const can = useCan();
  const an = useFunktion();
  const navigate = useNavigate();
  const modules = enabledModules(me.modules);

  // Zusatzangaben je Pfad aus den Modul-Kacheln
  const extra = new Map<string, HomeTile>();
  for (const m of modules) for (const t of m.tiles ?? []) if (can(t.permission)) extra.set(t.path, t);
  const kachel = (e: NavEntry): HomeTile => ({ ...extra.get(e.path!), text: e.text, icon: e.icon ?? extra.get(e.path!)?.icon ?? 'action', path: e.path! });

  const nav = navAufbauen(modules, can, an).filter((e) => e.path !== '/');
  // Einträge ohne Bereich (Stufe 1 direkt mit Ziel) in einem Bereich „Allgemein“ sammeln
  const lose = nav.filter((e) => !e.children && e.path);
  const bereiche = [
    ...(lose.length ? [{ text: 'Allgemein', icon: 'home', children: lose } as NavEntry] : []),
    ...nav.filter((e) => e.children?.length),
  ];

  const heute = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const vorname = me.user.vorname || me.user.displayName.split(/\s+/)[0] || me.user.displayName;
  const kacheln = (l: NavEntry[]) => (
    <div className="portal-tiles">
      {l.map((e) => <Tile key={e.path} tile={kachel(e)} onOpen={() => navigate(e.path!)} />)}
    </div>
  );

  return (
    <div className="portal-home">
      <div className="portal-home__head">
        <h1 className="portal-home__greeting">Hallo {vorname}</h1>
        <div className="portal-home__meta">{me.settings['org.name'] as string} · {heute}</div>
      </div>

      {/* Arbeitsvorrat aller Anwendungen (#232, V2) – ohne Einträge unsichtbar */}
      <StartArbeitsvorrat />

      {bereiche.map((b) => {
        const direkt = (b.children ?? []).filter((c) => !c.children && c.path);
        const gruppen = (b.children ?? []).filter((c) => c.children?.length);
        return (
          <section key={b.text} className="portal-bereich">
            <h2 className="portal-bereich__titel">
              {b.icon && <Icon name={b.icon} />}
              {b.text}
            </h2>
            {direkt.length > 0 && kacheln(direkt)}
            {gruppen.map((g) => (
              <div key={g.text} className="portal-bereich__gruppe">
                <h3 className="portal-group__title">
                  {g.icon && <Icon name={g.icon} />}
                  {g.text}
                </h3>
                {kacheln(g.children!.filter((c) => c.path))}
              </div>
            ))}
          </section>
        );
      })}

      {bereiche.length === 0 && (
        <div className="portal-section"><div className="portal-empty">Ihnen sind noch keine Anwendungen zugeordnet. Bitte wenden Sie sich an die Administration.</div></div>
      )}
    </div>
  );
}
