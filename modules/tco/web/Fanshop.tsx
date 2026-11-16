import { Link, MessageStrip, Title } from '@ui5/webcomponents-react';

/** Onlineshop des Vereins (externe Seite) – dieselbe Adresse steht am Menüpunkt in index.ts (`extern`) */
export const FANSHOP_URL = 'https://tc-oberthal.fan12.de/';

/**
 * Menüpunkt und Kachel „Fanshop“ öffnen den Shop direkt in einem neuen Tab. Diese Seite erscheint nur,
 * wenn jemand die Adresse /tco/fanshop selbst aufruft (Lesezeichen): ein Hinweis mit dem Link.
 */
export function Fanshop() {
  return (
    <div className="portal-section">
      <Title level="H3" style={{ marginBottom: '0.75rem' }}>Fanshop</Title>
      <MessageStrip design="Information" hideCloseButton>
        Der Onlineshop des Vereins ist eine externe Seite und öffnet sich in einem neuen Tab:{' '}
        <Link href={FANSHOP_URL} target="_blank">{FANSHOP_URL}</Link>
      </MessageStrip>
    </div>
  );
}
