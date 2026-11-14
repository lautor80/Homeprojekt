import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Button, Input, MessageStrip, ObjectStatus, Switch, Text } from '@ui5/webcomponents-react';
import { api, SITZUNG_PRUEFEN } from '../api';
import { AppPage } from '../components/AppPage';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { toast } from '../toast';

/**
 * Funktionsschalter (#232, F1; Administration → Einstellungen → Funktionen): Anwendungen, Bereiche, Apps und einzelne
 * Funktionen ein- und ausschalten. Abgeschaltet heißt für alle Benutzer – auch Administratoren – nicht mehr sichtbar
 * und nicht mehr nutzbar; Daten und Rollen bleiben erhalten. Das Verzeichnis liefert der Server (lib/funktionen.ts).
 */
interface Knoten {
  id: string;
  art: 'modul' | 'bereich' | 'app' | 'funktion';
  text: string;
  beschreibung?: string;
  hinweis?: string;
  /** Grund, warum sich der Knoten nicht abschalten lässt */
  fest?: string;
  /** eigener Schalter */
  aktiv: boolean;
  /** tatsächlich an – also auch nichts darüber abgeschaltet */
  wirksam: boolean;
  /** Apps außerhalb, die beim Abschalten mit ausfallen */
  folgen: string[];
  /** selbst an, aber Rechte fehlen, weil sie etwas Abgeschaltetes voraussetzen */
  betroffen?: 'ganz' | 'teilweise';
  kinder: Knoten[];
}
interface Stand { baum: Knoten[]; verwaist: string[] }

const ART: Record<Knoten['art'], string> = { modul: 'Anwendung', bereich: 'Bereich', app: 'App', funktion: 'Funktion' };
const alle = (k: Knoten[]): Knoten[] => k.flatMap((x) => [x, ...alle(x.kinder)]);

export function FunktionenPage() {
  const [stand, setStand] = useState<Stand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suche, setSuche] = useState('');
  /** aufgeklappte Knoten – Anwendungen sind es von Anfang an */
  const [offen, setOffen] = useState<Set<string> | null>(null);
  const [frage, setFrage] = useState<Knoten | null>(null);
  /** Schalter neu aufbauen, wenn eine Betätigung nicht übernommen wurde (Abbruch, Fehler) – sonst bliebe er optisch umgelegt */
  const [rev, setRev] = useState(0);

  useEffect(() => {
    api.get<Stand>('/api/funktionen')
      .then((s) => { setStand(s); setOffen(new Set(s.baum.map((k) => k.id))); })
      .catch((e) => setError((e as Error).message));
  }, []);

  async function schalten(k: Knoten, aktiv: boolean) {
    setFrage(null); setBusy(true); setError(null);
    try {
      setStand(await api.put<Stand>('/api/funktionen', { id: k.id, aktiv }));
      toast(`„${k.text}“ ist ${aktiv ? 'eingeschaltet' : 'abgeschaltet'}.`);
      // eigenes Menü sofort angleichen (App.tsx gleicht die Sitzung ab; der zweite Anstoß greift, falls der erste gedrosselt wurde)
      window.dispatchEvent(new Event(SITZUNG_PRUEFEN));
      window.setTimeout(() => window.dispatchEvent(new Event(SITZUNG_PRUEFEN)), 3500);
    } catch (e) { setError((e as Error).message); setRev((r) => r + 1); }
    finally { setBusy(false); }
  }
  const klappen = (id: string) => setOffen((o) => { const n = new Set(o ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const s = suche.trim().toLowerCase();
  /** bei einer Suche: Knoten, die selbst passen oder etwas Passendes enthalten */
  const sichtbar = useMemo(() => {
    if (!stand || !s) return null;
    const ids = new Set<string>();
    const passt = (k: Knoten): boolean => {
      const selbst = [k.text, k.beschreibung ?? '', k.id].some((t) => t.toLowerCase().includes(s));
      const darunter = k.kinder.map(passt).some(Boolean);
      if (selbst) for (const x of alle([k])) ids.add(x.id);
      if (selbst || darunter) ids.add(k.id);
      return selbst || darunter;
    };
    stand.baum.forEach(passt);
    return ids;
  }, [stand, s]);

  const abgeschaltet = stand ? alle(stand.baum).filter((k) => !k.aktiv).length : 0;

  function zeile(k: Knoten, tiefe: number, obenAus: string | null): ReactElement | null {
    if (sichtbar && !sichtbar.has(k.id)) return null;
    const auf = !!sichtbar || !!offen?.has(k.id);
    const an = k.aktiv && !obenAus;
    const gruppe = k.art === 'modul' || k.art === 'bereich';
    return (
      <div key={k.id}>
        <div className="portal-row" style={{ padding: '0.3rem 0', paddingLeft: `${tiefe * 1.5}rem`, borderTop: '1px solid var(--sapList_BorderColor)', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <span style={{ width: '2rem', flex: 'none' }}>
            {k.kinder.length > 0 && (
              <Button design="Transparent" icon={auf ? 'navigation-down-arrow' : 'navigation-right-arrow'} disabled={!!sichtbar}
                      tooltip={auf ? 'Zuklappen' : 'Aufklappen'} onClick={() => klappen(k.id)} />
            )}
          </span>
          <Switch key={`${k.id}:${rev}`} checked={an} disabled={busy || !!k.fest || !!obenAus} textOn="An" textOff="Aus" style={{ flex: 'none' }}
                  tooltip={k.fest ? `Nicht abschaltbar: ${k.fest}` : obenAus ? `Aus, weil „${obenAus}“ abgeschaltet ist` : an ? 'Abschalten' : 'Einschalten'}
                  onChange={(e) => (e.target.checked ? schalten(k, true) : setFrage(k))} />
          <div style={{ minWidth: 0, paddingTop: '0.35rem' }}>
            <div className="portal-row" style={{ gap: '0.5rem' }}>
              <Text style={{ fontWeight: gruppe ? 'bold' : 'normal', opacity: an ? 1 : 0.6 }}>{k.text}</Text>
              <Text className="portal-muted portal-small">{ART[k.art]}</Text>
              {k.fest && <ObjectStatus state="Information">{k.art === 'funktion' ? 'kein eigener Schalter' : 'nicht abschaltbar'}</ObjectStatus>}
              {!k.fest && !k.aktiv && <ObjectStatus state="Negative">abgeschaltet</ObjectStatus>}
              {k.aktiv && obenAus && <ObjectStatus state="Critical">aus durch „{obenAus}“</ObjectStatus>}
              {an && k.betroffen && <ObjectStatus state="Critical">{k.betroffen === 'ganz' ? 'nicht nutzbar' : 'teilweise nicht nutzbar'} – setzt Abgeschaltetes voraus</ObjectStatus>}
            </div>
            {k.beschreibung && <Text className="portal-muted portal-small" style={{ display: 'block' }}>{k.beschreibung}</Text>}
            {k.fest && <Text className="portal-muted portal-small" style={{ display: 'block' }}>{k.fest}</Text>}
          </div>
        </div>
        {auf && k.kinder.map((c) => zeile(c, tiefe + 1, obenAus ?? (k.aktiv ? null : k.text)))}
      </div>
    );
  }

  const darunter = frage ? alle(frage.kinder) : [];
  const frageText = frage ? [
    `„${frage.text}“ wird für alle Benutzer abgeschaltet – auch für Administratoren: nicht mehr im Menü, nicht mehr auf der Startseite, nicht mehr nutzbar.`,
    darunter.length ? `Mit abgeschaltet wird alles darunter (${darunter.filter((k) => k.art === 'app').length} Apps, ${darunter.filter((k) => k.art === 'funktion').length} einzelne Funktionen).` : '',
    frage.folgen.length ? `Dadurch ebenfalls nicht mehr nutzbar, weil sie Rechte davon voraussetzen: ${frage.folgen.join(', ')}.` : '',
    frage.hinweis ?? '',
    'Andere Apps, die Daten hieraus anzeigen, zeigen sie dann nicht mehr. Daten und Rollenzuordnungen bleiben erhalten; Einschalten stellt alles wieder her.',
  ].filter(Boolean).join('\n\n') : '';

  return (
    <AppPage title="Funktionen" subtitle="Anwendungen, Bereiche, Apps und einzelne Funktionen ein- und ausschalten – abgeschaltet heißt für alle nicht mehr sichtbar"
             header={(
               <div className="portal-row">
                 <Input value={suche} placeholder="Suchen (App, Funktion)" style={{ width: '20rem' }} onInput={(e) => setSuche(e.target.value)} />
                 <Text className="portal-muted">{abgeschaltet ? `${abgeschaltet} Schalter stehen auf „Aus“` : 'Alles ist eingeschaltet'}</Text>
               </div>
             )}
             actions={<>
               <Button design="Transparent" onClick={() => stand && setOffen(new Set(alle(stand.baum).map((k) => k.id)))}>Alle aufklappen</Button>
               <Button design="Transparent" onClick={() => stand && setOffen(new Set(stand.baum.map((k) => k.id)))}>Zuklappen</Button>
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
        Der Schalter legt fest, ob es eine Funktion in diesem Portal gibt. Wer sie nutzen darf, bestimmen weiterhin die Rollen
        (Administration → Benutzer und Rechte → Rollen). „Aus“ gilt für alles darunter und wirkt sofort für alle Benutzer.
      </MessageStrip>
      {!!stand?.verwaist.length && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Abgeschaltet, aber nicht mehr im Verzeichnis (umbenannt oder entfallen) – ohne Wirkung:{' '}
          {stand.verwaist.map((id) => (
            <Button key={id} design="Transparent" icon="decline" disabled={busy} tooltip="Eintrag entfernen"
                    onClick={() => schalten({ id, art: 'funktion', text: id, aktiv: false, wirksam: false, folgen: [], kinder: [] }, true)}>{id}</Button>
          ))}
        </MessageStrip>
      )}
      {stand && <div style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>{stand.baum.map((k) => zeile(k, 0, null))}</div>}
      {stand && sichtbar && sichtbar.size === 0 && <Text className="portal-muted">Nichts gefunden.</Text>}
      <ConfirmDialog open={!!frage} danger title="Funktion abschalten" confirmText="Abschalten" text={frageText}
                     onConfirm={() => frage && schalten(frage, false)} onCancel={() => { setFrage(null); setRev((r) => r + 1); }} />
    </AppPage>
  );
}
