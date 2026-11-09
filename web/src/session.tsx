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
export function checkPermission(perms: string[], required?: string): boolean {
  if (!required) return true;
  // „a|b“: eine der Berechtigungen genügt
  if (required.includes('|')) return required.split('|').some((r) => checkPermission(perms, r.trim()));
  if (perms.includes('*') || perms.includes(required)) return true;
  return perms.includes(`${required.split(':')[0]}:*`);
}

/** Hook: darf der angemeldete Benutzer das? */
export function useCan() {
  const { me } = useSession();
  return (permission?: string) => checkPermission(me.permissions, permission);
}
