import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { ArbeitsvorratBaum, type Aufgabe } from './components/Arbeitsvorrat';
import { enabledModules } from './modules';
import { setNavHinweis } from './navhinweis';
import { EREIGNIS, START, aufgabenGesehen, gesehen, gesehenMerken, schluessel } from './arbeitsvorratGesehen';
import { useSession } from './session';
import { toast } from './toast';

/**
 * Arbeitsvorrat des Portals auf der Startseite (#232, V2): offene Vorgänge aller Anwendungen, je Anwendung ein Block.
 * Jeder Benutzer sieht die Einträge, deren App er bedienen darf. Dazu der Hinweis „n neu“ am Menüeintrag „Start“.
 */
interface Gruppe { modul: string; name: string; aufgaben: Aufgabe[] }
const lesen = async (): Promise<Gruppe[]> => (await api.get<{ gruppen: Gruppe[] }>('/api/arbeitsvorrat')).gruppen;

/** unsichtbar: zählt neue Einträge seit dem letzten Blick – beim Start, alle zwei Minuten und wenn das Fenster wieder nach vorn kommt */
export function ArbeitsvorratWaechter() {
  useEffect(() => {
    const pruefen = async () => {
      try {
        const keys = schluessel((await lesen()).flatMap((g) => g.aufgaben));
        // erster Aufruf in diesem Browser: der heutige Stand gilt als bekannt
        if (!gesehen()) gesehenMerken(keys);
        const bekannt = new Set(gesehen());
        setNavHinweis(START, keys.filter((k) => !bekannt.has(k)).length);
      } catch { /* offline – kein Hinweis */ }
    };
    pruefen();
    const t = setInterval(pruefen, 120_000);
    const sichtbar = () => { if (document.visibilityState === 'visible') pruefen(); };
    document.addEventListener('visibilitychange', sichtbar);
    window.addEventListener(EREIGNIS, pruefen);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', sichtbar); window.removeEventListener(EREIGNIS, pruefen); };
  }, []);
  return null;
}

/** Arbeitsvorrat auf der Startseite – ohne Einträge unsichtbar */
export function StartArbeitsvorrat() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [gruppen, setGruppen] = useState<Gruppe[]>([]);
  const laden = useCallback(() => lesen().then((g) => { setGruppen(g); aufgabenGesehen(g.flatMap((x) => x.aufgaben), true); }).catch(() => setGruppen([])), []);
  // immer aktuell: beim Öffnen, nach jeder Bestätigung, jede Minute und wenn das Fenster wieder nach vorn kommt
  useEffect(() => {
    laden();
    const t = setInterval(laden, 60_000);
    const sichtbar = () => { if (document.visibilityState === 'visible') laden(); };
    document.addEventListener('visibilitychange', sichtbar);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', sichtbar); };
  }, [laden]);
  /** Kästchen am Eintrag: Erledigung bestätigen und die Übersicht sofort neu aufbauen */
  const erledigen = async (a: Aufgabe) => {
    if (!a.erledigen) return;
    const ohne = (l: Aufgabe[]): Aufgabe[] => l.filter((x) => x.key !== a.key).map((x) => (x.kinder ? { ...x, kinder: ohne(x.kinder) } : x));
    setGruppen((g) => g.map((x) => ({ ...x, aufgaben: ohne(x.aufgaben) }))); // sofort ausblenden, dann vom Server neu lesen
    try { const r = await api.post<{ text?: string }>(a.erledigen.url, a.erledigen.body); toast(r.text ?? 'Erledigt.'); } catch (e) { toast((e as Error).message, 6000); }
    await laden();
  };
  const module = enabledModules(me.modules);
  return (
    <>
      {gruppen.filter((g) => g.aufgaben.length).map((g) => (
        <ArbeitsvorratBaum key={g.modul} liste={g.aufgaben} titel={gruppen.length > 1 ? `Arbeitsvorrat ${g.name}` : 'Arbeitsvorrat'}
                           speicher={`portal.arbeitsvorrat.offen.${g.modul}`} onOeffnen={(a) => navigate(a.pfad)} onErledigen={erledigen} onNeuLaden={laden}
                           zusatz={module.find((m) => m.id === g.modul)?.arbeitsvorratZusatz} />
      ))}
    </>
  );
}
