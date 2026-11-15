/**
 * Push-Nachrichten aufs Handy (Web-Push) – Browserseite: Service Worker anmelden, Erlaubnis einholen, Gerät beim
 * Push-Dienst an- und abmelden. Die Einstellungen (Geräte, Arten) liegen am Server (/api/push), der Dialog dazu in
 * shell/PushDialog.tsx.
 *
 * Auf dem iPhone/iPad gibt es Push nur, wenn das Portal über „Teilen → Zum Home-Bildschirm“ als App abgelegt und von
 * dort geöffnet wurde (ab iOS 16.4) – im Safari-Tab fehlt die Technik (pushMoeglich() ist dann false).
 */
import { api } from './api';

export interface PushArt { id: string; gruppe: string; text: string; an: boolean }
export interface PushGeraet { id: number; name: string; erstellt_am: string; zuletzt_am: string | null; endpoint: string }
export interface PushStand { schluessel: string; geraete: PushGeraet[]; arten: PushArt[]; text?: string }

const SW = '/sw.js';
/** Benutzer, für den dieses Gerät eingeschaltet wurde – nur er wird nach der Anmeldung wieder angemeldet */
const MERKER = 'portal.push.benutzer';

export const pushMoeglich = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const istIos = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const alsAppGeoeffnet = (): boolean => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

const bytes = (text: string): ArrayBuffer => {
  const roh = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(roh.length);
  for (let i = 0; i < roh.length; i++) out[i] = roh.charCodeAt(i);
  return out.buffer as ArrayBuffer;
};
const b64url = (b: ArrayBuffer | null): string => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

/** kurze Bezeichnung des Geräts für die Liste „Meine Geräte“ */
export function geraeteName(): string {
  const ua = navigator.userAgent;
  const geraet = /iPhone/.test(ua) ? 'iPhone' : istIos() ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${geraet} · ${browser}`;
}

/** Anmeldung dieses Browsers beim Push-Dienst – null, wenn Push hier aus ist */
export async function pushAbo(): Promise<PushSubscription | null> {
  if (!pushMoeglich()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SW);
  return reg ? reg.pushManager.getSubscription() : null;
}

const melden = (abo: PushSubscription): Promise<PushStand> => {
  const j = abo.toJSON();
  return api.post<PushStand>('/api/push/geraet', { endpoint: j.endpoint, keys: j.keys, name: geraeteName() });
};

/** Push auf diesem Gerät einschalten: Erlaubnis des Browsers, Anmeldung beim Push-Dienst, Gerät am Server speichern */
export async function pushEinschalten(schluessel: string, benutzerId: string): Promise<PushStand> {
  if (!pushMoeglich()) throw new Error('Dieser Browser unterstützt keine Push-Nachrichten.');
  const erlaubt = await Notification.requestPermission();
  if (erlaubt !== 'granted') throw new Error('Benachrichtigungen sind für das Portal nicht erlaubt. Bitte in den Einstellungen des Geräts bzw. Browsers erlauben.');
  const reg = await navigator.serviceWorker.register(SW);
  await navigator.serviceWorker.ready;
  let abo = await reg.pushManager.getSubscription();
  // Anmeldung mit einem anderen Schlüssel (z. B. nach einer Rücksicherung): neu anmelden
  if (abo && b64url(abo.options.applicationServerKey) !== schluessel) { await abo.unsubscribe(); abo = null; }
  abo ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(schluessel) });
  const stand = await melden(abo);
  try { localStorage.setItem(MERKER, benutzerId); } catch { /* ohne Merker: nach der nächsten Anmeldung erneut einschalten */ }
  return stand;
}

/** Push auf diesem Gerät ausschalten */
export async function pushAusschalten(): Promise<PushStand | null> {
  try { localStorage.removeItem(MERKER); } catch { /* egal */ }
  const abo = await pushAbo();
  if (!abo) return null;
  const endpoint = abo.endpoint;
  await abo.unsubscribe().catch(() => undefined);
  return api.post<PushStand>('/api/push/geraet/abmelden', { endpoint });
}

/**
 * Nach der Anmeldung: Hat dieser Benutzer Push auf diesem Gerät eingeschaltet, die Anmeldung am Server auffrischen
 * (der Push-Dienst kann sie erneuert haben; nach einer Abmeldung war das Gerät dort ausgetragen). Still.
 */
export async function pushAuffrischen(benutzerId: string): Promise<void> {
  try {
    if (localStorage.getItem(MERKER) !== benutzerId || Notification.permission !== 'granted') return;
    const abo = await pushAbo();
    if (abo) await melden(abo);
  } catch { /* Push ist Beigabe */ }
}

/** Beim Abmelden: Das Gerät bekommt nichts mehr für diesen Benutzer, bis er sich hier wieder anmeldet. Still. */
export async function pushBeiAbmeldung(): Promise<void> {
  try {
    const abo = await pushAbo();
    if (abo) await api.post('/api/push/geraet/abmelden', { endpoint: abo.endpoint });
  } catch { /* Abmelden geht vor */ }
}
