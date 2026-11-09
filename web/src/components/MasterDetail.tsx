import type { CSSProperties, ReactNode } from 'react';
import { Button, IllustratedMessage } from '@ui5/webcomponents-react';

interface Props {
  /** Kopf der Liste (Suche, Sortierung, Anzahl) */
  masterHead?: ReactNode;
  /** die Liste selbst (ui5 List o. ä.) */
  master: ReactNode;
  /** Objektbereich; null → Hinweis „bitte auswählen“ */
  detail: ReactNode | null;
  /** Breite der Liste, Standard 24rem */
  masterWidth?: string;
  /** Texte für den leeren Objektbereich */
  emptyTitle?: string;
  emptyText?: string;
  /** Auf schmalen Bildschirmen: zurück zur Liste */
  onBack?: () => void;
  /** Liste und Objekt gleich hoch (Bildschirmhöhe), jeweils eigener Bildlauf */
  gleicheHoehe?: boolean;
}

/**
 * Zwei Spalten wie im Fiori Flexible Column Layout: Liste links (bleibt beim
 * Scrollen stehen), Objekt rechts. Auf schmalen Bildschirmen wird nur eine
 * Spalte gezeigt, mit „Zurück“-Knopf im Objektbereich.
 */
export function MasterDetail({ masterHead, master, detail, masterWidth, emptyTitle = 'Nichts ausgewählt', emptyText = 'Links einen Eintrag wählen.', onBack, gleicheHoehe }: Props) {
  const offen = detail !== null && detail !== undefined;
  return (
    <div className={`portal-md${offen ? ' portal-md--detail-open' : ''}${gleicheHoehe ? ' portal-md--gleich' : ''}`} style={masterWidth ? ({ '--portal-md-width': masterWidth } as CSSProperties) : undefined}>
      <aside className="portal-md__master">
        {masterHead && <div className="portal-md__master-head">{masterHead}</div>}
        <div className="portal-md__master-list">{master}</div>
      </aside>
      <div className="portal-md__detail">
        {offen && onBack && (
          <div className="portal-md__back" style={{ marginBottom: '0.5rem' }}>
            <Button icon="nav-back" design="Transparent" onClick={onBack}>Zur Liste</Button>
          </div>
        )}
        {offen ? detail : (
          <div className="portal-section">
            <IllustratedMessage name="SimpleEmptyList" titleText={emptyTitle} subtitleText={emptyText} />
          </div>
        )}
      </div>
    </div>
  );
}
