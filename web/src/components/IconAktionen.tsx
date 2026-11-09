import { Button } from '@ui5/webcomponents-react';
import type { MenuEntry } from './MenuButton';

/** Zeilenaktionen direkt als Symbole in der Tabellenspalte (statt „…“-Menü); die Erklärung steht im Tooltip */
export function IconAktionen({ items }: { items: (MenuEntry & { icon: string })[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 0 }}>
      {items.filter((i) => !i.hidden).map((i) => (
        <Button key={i.text} icon={i.icon} design="Transparent" tooltip={i.text} accessibleName={i.text} disabled={i.disabled}
                onClick={(e) => { e.stopPropagation(); i.onClick(); }} />
      ))}
    </div>
  );
}

/** Spaltenbreite für n Symbole */
export const iconSpalte = (n: number) => Math.max(1, n) * 36 + 12;
