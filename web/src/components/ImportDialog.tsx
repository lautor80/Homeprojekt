import type { ReactNode } from 'react';
import { Bar, Button, Dialog } from '@ui5/webcomponents-react';

/**
 * Importe: gleiche Stelle, gleicher Knopf, gleicher Rahmen (#232, S4).
 *
 * Laufende Importe bleiben in der Fach-App, dort wo man das Ergebnis braucht – aber immer als Knopf „Importieren“
 * oben rechts (ImportKnopf) und in einem Dialog mit demselben Ablauf (ImportDialog):
 *   1 Quelle wählen → 2 Prüfen → 3 Übernehmen → 4 Protokoll
 * Der Inhalt des Dialogs gehört der Fach-App (Ablagefeld, Vorschau, Protokoll); der Rahmen zeigt, wo man gerade steht.
 * Einmalige Übernahmen (SAP) stehen unter Administration → Schnittstellen.
 */
export const IMPORT_SCHRITTE = ['Quelle wählen', 'Prüfen', 'Übernehmen', 'Protokoll'] as const;
export type ImportSchritt = 1 | 2 | 3 | 4;

/** Der eine Knopf für alle Importe – steht in den Aktionen der Seite (oben rechts) */
export function ImportKnopf({ onClick, tooltip, disabled }: { onClick: () => void; tooltip?: string; disabled?: boolean }) {
  return <Button icon="upload" tooltip={tooltip} disabled={disabled} onClick={onClick}>Importieren</Button>;
}

/** Schrittleiste – auch für Importe mit eigenem Dialog, damit alle denselben Ablauf zeigen */
export function ImportSchritte({ schritt }: { schritt?: ImportSchritt }) {
  return (
    <ol className="portal-import__schritte" aria-label="Ablauf des Imports">
      {IMPORT_SCHRITTE.map((s, i) => (
        <li key={s} className={`portal-import__schritt${schritt === i + 1 ? ' portal-import__schritt--aktiv' : ''}${schritt && i + 1 < schritt ? ' portal-import__schritt--fertig' : ''}`}
            aria-current={schritt === i + 1 ? 'step' : undefined}>
          <span className="portal-import__nr">{i + 1}</span>{s}
        </li>
      ))}
    </ol>
  );
}

export function ImportDialog({ open, was, schritt, breit, onClose, children }: {
  open: boolean;
  /** was importiert wird – steht hinter „Importieren:“ in der Kopfzeile */
  was: string;
  schritt?: ImportSchritt;
  /** für Vorschauen mit breiten Tabellen */
  breit?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <Dialog open headerText={`Importieren: ${was}`} onClose={onClose} style={{ width: breit ? 'min(76rem, 98vw)' : 'min(52rem, 96vw)' }}
            footer={<Bar endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      <ImportSchritte schritt={schritt} />
      <div className="portal-import__inhalt">{children}</div>
    </Dialog>
  );
}
