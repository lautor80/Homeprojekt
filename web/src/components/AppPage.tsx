import type { ReactElement, ReactNode } from 'react';
import { Children, createContext, Fragment, isValidElement, useContext } from 'react';
import { Varianten, type VariantenProps } from './Varianten';
import { DynamicPage, DynamicPageHeader, DynamicPageTitle, Title, Text, Bar, Toolbar, ToolbarItem } from '@ui5/webcomponents-react';

interface Props {
  title: string;
  subtitle?: string;
  /** Buttons rechts im Titelbereich */
  actions?: ReactNode;
  /** Ansichtsvarianten der App (Auswahl sichern/abrufen) – stehen vor den Buttons im Titelbereich */
  varianten?: VariantenProps<any>;
  /** Kopfbereich (z. B. Filter), wird beim Scrollen eingeklappt */
  header?: ReactElement;
  /** Fußleiste (z. B. Sichern/Abbrechen) */
  footer?: ReactNode;
  children: ReactNode;
}

/** Beliebige Elemente (Buttons, Suchfeld ...) als Toolbar-Einträge rechts im Titel. */
function toolbarItems(actions: ReactNode) {
  // Fragmente (auch verschachtelt, z. B. Varianten + Buttons der App) in einzelne Einträge auflösen
  const aufloesen = (n: ReactNode): ReactNode[] => Children.toArray(n).flatMap((c) =>
    (isValidElement<{ children?: ReactNode }>(c) && c.type === Fragment ? aufloesen(c.props.children) : [c]));
  const flat = aufloesen(actions);
  return flat.filter(Boolean).map((c, i) => <ToolbarItem key={i}>{c}</ToolbarItem>);
}

/**
 * Eingebettet (#232, S1): Eine App, die als Reiter in einer anderen App steht (z. B. API-Schlüssel in „Schnittstellen“), zeigt
 * statt des eigenen Seitenrahmens nur Untertitel, Buttons, Inhalt und Fußleiste – Titel und Rahmen gehören der äußeren App.
 */
const EingebettetContext = createContext(false);
export function Eingebettet({ children }: { children: ReactNode }) {
  return <EingebettetContext.Provider value>{children}</EingebettetContext.Provider>;
}

/** Standard-Seitenrahmen im Fiori-Stil (DynamicPage). */
export function AppPage({ title, subtitle, actions: actions0, varianten, header, footer, children }: Props) {
  const actions = varianten ? <><Varianten {...varianten} />{actions0}</> : actions0;
  if (useContext(EingebettetContext)) {
    return (
      <div className="portal-eingebettet">
        {(subtitle || actions) && (
          <div className="portal-eingebettet__kopf">
            <Text className="portal-muted">{subtitle ?? ''}</Text>
            {actions ? <Toolbar design="Transparent" style={{ width: 'auto' }}>{toolbarItems(actions)}</Toolbar> : null}
          </div>
        )}
        {header}
        {children}
        {footer ? <Bar style={{ marginTop: '1rem' }} endContent={<>{footer}</>} /> : null}
      </div>
    );
  }
  return (
    <DynamicPage
      style={{ height: '100%' }}
      hidePinButton
      showFooter={!!footer}
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H2">{title}</Title>}
          snappedHeading={<Title level="H3">{title}</Title>}
          subheading={subtitle ? <Text>{subtitle}</Text> : undefined}
          actionsBar={actions ? <Toolbar design="Transparent">{toolbarItems(actions)}</Toolbar> : undefined}
        />
      }
      headerArea={header ? <DynamicPageHeader>{header}</DynamicPageHeader> : undefined}
      footerArea={footer ? <Bar design="FloatingFooter" endContent={<>{footer}</>} /> : undefined}
    >
      <div style={{ padding: '0 0 1rem' }}>{children}</div>
    </DynamicPage>
  );
}
