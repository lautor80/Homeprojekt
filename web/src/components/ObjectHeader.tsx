import type { ReactNode } from 'react';
import { Avatar } from '@ui5/webcomponents-react';

interface Props {
  title: string;
  subtitle?: ReactNode;
  /** UI5-Icon im Avatar (oder Initialen über `initials`) */
  icon?: string;
  initials?: string;
  /** Statuszeile unter dem Titel: ObjectStatus, Tags, kurze Texte */
  status?: ReactNode;
  /** Kennzahlen/Attribute unterhalb (z. B. <Attributes>) */
  children?: ReactNode;
  /** Buttons rechts oben */
  actions?: ReactNode;
}

/**
 * Objektkopf im Stil der Fiori Object Page: Avatar, Titel, Untertitel,
 * Statuszeile und Aktionen; darunter optional Attribute.
 */
export function ObjectHeader({ title, subtitle, icon, initials, status, children, actions }: Props) {
  const mitAvatar = !!(icon || initials);
  // ohne Avatar rücken Text und Attribute an den linken Rand
  const volleBreite = mitAvatar ? undefined : { gridColumn: 'avatar-start / text-end' };
  return (
    <header className="portal-objhead">
      {mitAvatar && (
        <div className="portal-objhead__avatar">
          <Avatar icon={icon} initials={initials} size="M" shape="Square" colorScheme="Accent6" />
        </div>
      )}
      <div className="portal-objhead__text" style={volleBreite}>
        <h2 className="portal-objhead__title">{title}</h2>
        {subtitle && <div className="portal-objhead__subtitle">{subtitle}</div>}
        {status && <div className="portal-objhead__status">{status}</div>}
      </div>
      {actions && <div className="portal-objhead__actions">{actions}</div>}
      {children && <div className="portal-objhead__meta" style={volleBreite}>{children}</div>}
    </header>
  );
}
