import type { CSSProperties, ReactNode } from 'react';

/**
 * Fußzeile eines Dialogs mit mehr als zwei Knöpfen: bricht auf schmalen Bildschirmen um.
 * Die UI5-Bar schneidet ab, was nicht in eine Zeile passt – auf dem Telefon war dann „Abbrechen“
 * nicht mehr erreichbar und der Dialog ließ sich nicht schließen.
 */
export function DialogFuss({ children, slot }: { children: ReactNode; /** setzt der Dialog (footer={…}) – ohne ihn stünde die Fußzeile oben im Inhalt */ slot?: string }) {
  return <div slot={slot} className="portal-dialogfuss">{children}</div>;
}

const da = (x: ReactNode) => x !== null && x !== undefined && x !== false && x !== '';

/**
 * Ersatz für die UI5-`Bar` als Knopfleiste – portalweit, mit denselben Eigenschaften (`startContent` links, `endContent`
 * rechts): als Dialogfuß (`footer={<FussLeiste … />}`) und als Leiste im Inhalt (z. B. „Sichern“ unter einem Formular).
 * Anders als die Bar bricht sie um, statt abzuschneiden: Auf dem Telefon bleiben alle Knöpfe sichtbar und erreichbar,
 * auch bei drei und mehr Knöpfen oder langen Beschriftungen. Für neue Dialoge bitte immer diese Leiste (oder `DialogFuss`)
 * verwenden, nie die Bar.
 */
export function FussLeiste({ startContent, endContent, children, slot, style, className }: {
  startContent?: ReactNode;
  endContent?: ReactNode;
  /** Mitte (selten) */
  children?: ReactNode;
  /** setzt der Dialog (footer={…}); ohne ihn ist es eine Leiste im Inhalt */
  slot?: string;
  style?: CSSProperties;
  className?: string;
  /** nur zur Verträglichkeit mit der Bar – ohne Wirkung */
  design?: string;
}) {
  return (
    <div slot={slot} style={style} className={`portal-dialogfuss${slot ? '' : ' portal-dialogfuss--inhalt'}${className ? ` ${className}` : ''}`}>
      {da(startContent) && <div className="portal-dialogfuss__start">{startContent}</div>}
      {da(children) && <div className="portal-dialogfuss__mitte">{children}</div>}
      {da(endContent) && <div className="portal-dialogfuss__ende">{endContent}</div>}
    </div>
  );
}
