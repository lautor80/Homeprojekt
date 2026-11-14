import { createContext, useContext } from 'react';

export interface Me {
  user: {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    mustChangePassword: boolean;
    roles: string[];
  };
  permissions: string[];
  /** Funktionsschalter (#232, F1): was für alle abgeschaltet ist – Rechte und Knoten (Apps „a:<modul>:<App>“, Funktionen) */
  aus?: { rechte: string[]; ids: string[] };
  modules: string[];
  settings: Record<string, unknown>;
}

export interface Session {
  me: Me;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession außerhalb des SessionContext');
  return s;
}

/** Gleiche Logik wie im Server (permissions.ts). */
export function checkPermission(perms: string[], required?: string, abgeschaltet: string[] = []): boolean {
  if (!required) return true;
  // „a|b“: eine der Berechtigungen genügt
  if (required.includes('|')) return required.split('|').some((r) => checkPermission(perms, r.trim(), abgeschaltet));
  // Ein abgeschaltetes Recht hat niemand – auch nicht mit „*“
  if (abgeschaltet.includes(required)) return false;
  if (perms.includes('*') || perms.includes(required)) return true;
  return perms.includes(`${required.split(':')[0]}:*`);
}

/** Hook: darf der angemeldete Benutzer das? */
export function useCan() {
  const { me } = useSession();
  return (permission?: string) => checkPermission(me.permissions, permission, me.aus?.rechte);
}

/** Id einer App im Verzeichnis der Funktionen – Name wie im Menü (und im Rechtekatalog) */
export const appId = (modul: string, app: string) => `a:${modul}:${app}`;

/**
 * Hook: Ist die Funktion an? (Funktionsschalter, Administration → Einstellungen → Funktionen)
 * Id einer einzelnen Funktion (z. B. „tco.halle.ep3import“) oder einer App (appId). Abgeschaltetes wird nicht angezeigt.
 */
export function useFunktion() {
  const { me } = useSession();
  return (id: string) => !me.aus?.ids.includes(id);
}
