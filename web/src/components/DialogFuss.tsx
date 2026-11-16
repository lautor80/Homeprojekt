import type { ReactNode } from 'react';

/**
 * Fußzeile eines Dialogs mit mehr als zwei Knöpfen: bricht auf schmalen Bildschirmen um.
 * Die UI5-Bar schneidet ab, was nicht in eine Zeile passt – auf dem Telefon war dann „Abbrechen“
 * nicht mehr erreichbar und der Dialog ließ sich nicht schließen.
 */
export function DialogFuss({ children, slot }: { children: ReactNode; /** setzt der Dialog (footer={…}) – ohne ihn stünde die Fußzeile oben im Inhalt */ slot?: string }) {
  return <div slot={slot} className="portal-dialogfuss">{children}</div>;
}
