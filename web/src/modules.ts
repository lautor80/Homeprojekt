import type { WebModule } from './platform';

// ---------------------------------------------------------------------------
// Verfügbare Fachmodule (Oberfläche). Neues Modul: hier importieren und eintragen.
// Angezeigt werden nur Module, die der Server als aktiv meldet (PORTAL_MODULES).
// ---------------------------------------------------------------------------
import beispiel from '@modules/beispiel/web';

const available: WebModule[] = [beispiel];

export function enabledModules(ids: string[]): WebModule[] {
  return available.filter((m) => ids.includes(m.id));
}
