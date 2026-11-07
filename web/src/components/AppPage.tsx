import type { ReactElement, ReactNode } from 'react';
import { Children, Fragment, isValidElement } from 'react';
import { DynamicPage, DynamicPageHeader, DynamicPageTitle, Title, Text, Bar, Toolbar, ToolbarItem } from '@ui5/webcomponents-react';

interface Props {
  title: string;
  subtitle?: string;
  /** Buttons rechts im Titelbereich */
  actions?: ReactNode;
  /** Kopfbereich (z. B. Filter), wird beim Scrollen eingeklappt */
  header?: ReactElement;
  /** Fußleiste (z. B. Sichern/Abbrechen) */
  footer?: ReactNode;
  children: ReactNode;
}

/** Beliebige Elemente (Buttons, Suchfeld ...) als Toolbar-Einträge rechts im Titel. */
function toolbarItems(actions: ReactNode) {
  const flat = Children.toArray(actions).flatMap((c) =>
    isValidElement<{ children?: ReactNode }>(c) && c.type === Fragment ? Children.toArray(c.props.children) : [c]);
  return flat.filter(Boolean).map((c, i) => <ToolbarItem key={i}>{c}</ToolbarItem>);
}

/** Standard-Seitenrahmen im Fiori-Stil (DynamicPage). */
export function AppPage({ title, subtitle, actions, header, footer, children }: Props) {
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
