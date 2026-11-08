import { useEffect, useRef, useState } from 'react';
import { Button, MessageStrip } from '@ui5/webcomponents-react';
import { api, ApiError } from './api';

/**
 * Sperren gegen gleichzeitige Bearbeitung (Oberfläche).
 *
 *   const s = useSperre('MITGLIED', adrnr, darfAendern, { bezeichnung: `Mitglied ${name}` });
 *   const edit = darfAendern && s.eigen;          // nur mit eigener Sperre bearbeitbar
 *   <SperrHinweis s={s} />                         // Hinweis „wird gerade von … bearbeitet“
 *
 * Die Sperre wird beim Öffnen gesetzt, per Lebenszeichen gehalten und beim Schließen/Verlassen freigegeben.
 * Ohne Bedienung (Maus, Tastatur) für INAKTIV_MS werden die Sperren nicht mehr verlängert und laufen ab –
 * die Ansicht wechselt dann in die Anzeige mit „Bearbeitung fortsetzen“.
 */
const LEBENSZEICHEN_MS = 30_000;
const INAKTIV_MS = 15 * 60_000;

export type SperrZustand = 'aus' | 'laden' | 'eigen' | 'fremd' | 'inaktiv' | 'fehler';
export interface SperrStatus {
  zustand: SperrZustand;
  /** true, wenn bearbeitet werden darf (eigene Sperre oder keine Sperre angefordert) */
  eigen: boolean;
  text: string | null;
  inhaber: string | null;
  erneut: () => void;
}
export interface SperrOptionen { bezeichnung?: string; von?: string | null; bis?: string | null }

// ---------------------------------------------------------------------------
// Verwaltung aller Sperren dieses Fensters (ein Lebenszeichen für alle)
// ---------------------------------------------------------------------------
type Halter = { id: number; verloren: () => void };
const gehalten = new Map<number, Halter>();
let letzteAktivitaet = Date.now();
let gestartet = false;
let inaktivGemeldet = false;
const inaktivHoerer = new Set<() => void>();

function starten() {
  if (gestartet || typeof window === 'undefined') return;
  gestartet = true;
  const aktiv = () => { letzteAktivitaet = Date.now(); };
  for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(e, aktiv, { passive: true });
  window.setInterval(async () => {
    if (!gehalten.size) return;
    if (Date.now() - letzteAktivitaet > INAKTIV_MS) {
      if (!inaktivGemeldet) {
        inaktivGemeldet = true;
        const ids = [...gehalten.keys()];
        freigebenIds(ids);
        inaktivHoerer.forEach((f) => f());
      }
      return;
    }
    inaktivGemeldet = false;
    const ids = [...gehalten.keys()];
    try {
      const r = await api.post<{ aktiv: number[] }>('/api/sperren/verlaengern', { ids });
      for (const id of ids) if (!r.aktiv.includes(id)) { const h = gehalten.get(id); gehalten.delete(id); h?.verloren(); }
    } catch { /* Netz kurz weg: nächster Versuch */ }
  }, LEBENSZEICHEN_MS);
  // Fenster schließen/neu laden: Sperren sofort freigeben (keepalive überlebt das Entladen)
  window.addEventListener('pagehide', () => {
    if (!gehalten.size) return;
    fetch('/api/sperren/freigeben', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json', 'x-portal-request': '1' },
      body: JSON.stringify({ ids: [...gehalten.keys()] }),
    }).catch(() => undefined);
    gehalten.clear();
  });
}

function freigebenIds(ids: number[]) {
  ids.forEach((id) => gehalten.delete(id));
  if (ids.length) api.post('/api/sperren/freigeben', { ids }).catch(() => undefined);
}

/** Sperre direkt setzen (ohne Hook), z. B. für eine Auswahl; Rückgabe: Freigabe-Funktion */
export async function sperreSetzen(objekt: string, schluessel: string, o: SperrOptionen = {}, verloren: () => void = () => undefined): Promise<() => void> {
  starten();
  letzteAktivitaet = Date.now();
  const r = await api.post<{ id: number }>('/api/sperren', { objekt, schluessel, bezeichnung: o.bezeichnung ?? null, von: o.von ?? null, bis: o.bis ?? null });
  gehalten.set(r.id, { id: r.id, verloren });
  let frei = false;
  return () => { if (!frei) { frei = true; freigebenIds([r.id]); } };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useSperre(objekt: string, schluessel: string | null | undefined, aktiv: boolean, o: SperrOptionen = {}): SperrStatus {
  const [zustand, setZustand] = useState<SperrZustand>(aktiv && schluessel ? 'laden' : 'aus');
  const [text, setText] = useState<string | null>(null);
  const [inhaber, setInhaber] = useState<string | null>(null);
  const [lauf, setLauf] = useState(0);
  const opt = useRef(o);
  opt.current = o;

  useEffect(() => {
    if (!aktiv || !schluessel) { setZustand('aus'); setText(null); return; }
    let ende = false;
    let freigabe: (() => void) | null = null;
    setZustand((z) => (z === 'fremd' ? z : 'laden'));
    const inaktiv = () => {
      if (ende) return;
      freigabe = null;
      setZustand('inaktiv');
      setText('Die Bearbeitung wurde wegen Inaktivität beendet und die Sperre aufgehoben, damit andere weiterarbeiten können.');
    };
    inaktivHoerer.add(inaktiv);
    sperreSetzen(objekt, schluessel, opt.current, () => {
      if (ende) return;
      setZustand('fehler');
      setText('Die Sperre ist abgelaufen (Verbindung unterbrochen?). Bitte „Erneut sperren“ – nicht gesicherte Eingaben ggf. erneut erfassen.');
    }).then((f) => {
      if (ende) { f(); return; }
      freigabe = f;
      setZustand('eigen'); setText(null); setInhaber(null);
    }).catch((e) => {
      if (ende) return;
      if (e instanceof ApiError && e.status === 423) {
        setZustand('fremd');
        setText(e.message);
        setInhaber(e.message);
        // automatisch erneut versuchen, sobald der andere fertig ist
        window.setTimeout(() => { if (!ende) setLauf((x) => x + 1); }, 20_000);
      } else if (e instanceof ApiError && e.status === 403) {
        // ohne Sperrrecht: nicht blockieren, Server prüft beim Sichern
        setZustand('eigen'); setText(null);
      } else {
        setZustand('fehler'); setText(`Sperre konnte nicht gesetzt werden: ${(e as Error).message}`);
      }
    });
    return () => { ende = true; inaktivHoerer.delete(inaktiv); freigabe?.(); };
  }, [objekt, schluessel, aktiv, lauf, o.von, o.bis]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    zustand, text, inhaber,
    eigen: zustand === 'eigen' || zustand === 'aus',
    erneut: () => setLauf((x) => x + 1),
  };
}

/** Hinweis für fremd gesperrte/abgelaufene Bearbeitung; nichts bei eigener Sperre */
export function SperrHinweis({ s, style }: { s: SperrStatus; style?: React.CSSProperties }) {
  if (s.zustand !== 'fremd' && s.zustand !== 'inaktiv' && s.zustand !== 'fehler') return null;
  return (
    <MessageStrip design={s.zustand === 'fremd' ? 'Critical' : 'Information'} hideCloseButton style={{ marginBottom: '0.5rem', ...style }}>
      <span className="portal-sperre">
        <span>{s.zustand === 'fremd' ? `${s.text} Nur Anzeige.` : s.text}</span>
        <Button design="Transparent" icon={s.zustand === 'fremd' ? 'refresh' : 'edit'} onClick={s.erneut}>
          {s.zustand === 'inaktiv' ? 'Bearbeitung fortsetzen' : 'Erneut versuchen'}
        </Button>
      </span>
    </MessageStrip>
  );
}
