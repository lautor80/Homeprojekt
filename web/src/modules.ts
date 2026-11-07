import type { WebModule } from './platform';

// ---------------------------------------------------------------------------
// Verfügbare Fachmodule (Oberfläche). Neues Modul: hier importieren und eintragen.
// Angezeigt werden nur Module, die der Server als aktiv meldet (PORTAL_MODULES).
// ---------------------------------------------------------------------------
import beispiel from '@modules/beispiel/web';
import transport from '@modules/transport/web';
import tco from '@modules/tco/web';

const available: WebModule[] = [beispiel, transport, tco];

export function enabledModules(ids: string[]): WebModule[] {
  return available.filter((m) => ids.includes(m.id));
}
