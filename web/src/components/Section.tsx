import type { ReactNode } from 'react';

interface Props {
  title?: string;
  /** Anzahl hinter dem Titel, z. B. Zeilen einer Tabelle */
  count?: number | string;
  /** Symbole/Status direkt neben dem Titel */
  status?: ReactNode;
  /** Buttons rechts in der Titelzeile */
  actions?: ReactNode;
  /** Inhalt ohne Innenabstand (Tabellen, Listen) */
  flush?: boolean;
  /** Ohne Karte – nur Titelzeile und Inhalt */
  plain?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Abschnitt im Stil einer Fiori Object Page: weiße Karte mit Titelzeile,
 * optionaler Anzahl, Status und Aktionen. Ersetzt die Kombination
 * Panel + Toolbar + Title in den Modulseiten.
 */
export function Section({ title, count, status, actions, flush, plain, className, children }: Props) {
  const hatKopf = title || status || actions;
  return (
    <section className={`portal-section${plain ? ' portal-section--plain' : ''}${className ? ` ${className}` : ''}`}>
      {hatKopf && (
        <div className="portal-section__head">
          {title && (
            <h3 className="portal-section__title">
              {title}{count !== undefined && <span className="portal-section__count"> ({count})</span>}
            </h3>
          )}
          {status}
          {actions && <div className="portal-section__actions">{actions}</div>}
        </div>
      )}
      <div className={`portal-section__body${flush ? ' portal-section__body--flush' : ''}`}>{children}</div>
    </section>
  );
}

/** Hinweistext für leere Abschnitte */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="portal-empty">{children}</div>;
}
