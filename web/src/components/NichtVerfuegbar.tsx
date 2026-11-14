import { Button, MessageStrip } from '@ui5/webcomponents-react';
import { ApiError } from '../api';
import { CenterCard } from '../pages/AuthPages';

/** Antwort des Servers: Die Funktion ist abgeschaltet (Funktionsschalter, #232 F1; Administration → Einstellungen → Funktionen) */
export const istAbgeschaltet = (e: unknown): boolean => e instanceof ApiError && e.code === 'FUNKTION_AUS';

/**
 * Öffentliche Seite einer abgeschalteten Funktion (Mitgliedsantrag, Schnuppertraining, Registrierung …):
 * Hinweis statt eines Formulars, das beim Absenden scheitern würde. Bereits verschickte Links landen ebenfalls hier.
 */
export function NichtVerfuegbar({ orgName, logo, titel, onFertig }: { orgName: string; logo?: string; titel: string; onFertig: () => void }) {
  return (
    <CenterCard title={orgName} subtitle={titel} logo={logo}>
      <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
        Dieses Angebot steht zurzeit nicht zur Verfügung. Bitte wenden Sie sich direkt an {orgName}.
      </MessageStrip>
      <Button design="Emphasized" style={{ width: '100%' }} onClick={onFertig}>Zum Portal</Button>
    </CenterCard>
  );
}
