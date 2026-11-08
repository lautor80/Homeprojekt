import type { ReactNode } from 'react';

/**
 * Raster aus beschrifteten Werten (Beschriftung klein über dem Wert),
 * wie die Anzeige eines Formulars in der Fiori Object Page.
 */
export function Attributes({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={`portal-attrs${narrow ? ' portal-attrs--narrow' : ''}`}>{children}</div>;
}

/** Ein beschrifteter Wert; leer → „–“ */
export function Attribute({ label, children, strong, wide }: { label: string; children?: ReactNode; strong?: boolean; wide?: boolean }) {
  const leer = children === null || children === undefined || children === '' || children === false;
  return (
    <div className="portal-attr" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="portal-attr__label">{label}</div>
      <div className={`portal-attr__value${strong ? ' portal-attr__value--strong' : ''}${leer ? ' portal-attr__value--empty' : ''}`}>
        {leer ? '–' : children}
      </div>
    </div>
  );
}
