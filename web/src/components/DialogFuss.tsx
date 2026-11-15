import type { ReactNode } from 'react';

/**
 * Fußzeile eines Dialogs mit mehr als zwei Knöpfen: bricht auf schmalen Bildschirmen um.
 * Die UI5-Bar schneidet ab, was nicht in eine Zeile passt – auf dem Telefon war dann „Abbrechen“
 * nicht mehr erreichbar und der Dialog ließ sich nicht schließen.
 */
export function DialogFuss({ children }: { children: ReactNode }) {
  return <div className="portal-dialogfuss">{children}</div>;
}
