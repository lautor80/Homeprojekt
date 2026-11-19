import { MessageStrip } from '@ui5/webcomponents-react';
import type { VerwaltungProps } from '../api';

/** Turniere – Verwaltung Modus „ko“ (Platzhalter) */
export function KoVerwaltung(_: VerwaltungProps) {
  return <MessageStrip hideCloseButton>Noch nicht verfügbar.</MessageStrip>;
}
