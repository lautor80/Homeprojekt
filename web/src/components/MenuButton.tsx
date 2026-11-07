import { useRef, useState } from 'react';
import { Button, Menu, MenuItem } from '@ui5/webcomponents-react';

export interface MenuEntry {
  text: string;
  icon?: string;
  disabled?: boolean;
  hidden?: boolean;
  onClick: () => void;
}

/** Button mit Menü (wie sap.m.MenuButton); ohne Text nur Symbol */
export function MenuButton({ text, icon, design, disabled, items }: {
  text?: string; icon?: string; design?: 'Emphasized' | 'Default' | 'Transparent'; disabled?: boolean; items: MenuEntry[];
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const sichtbar = items.filter((i) => !i.hidden);
  return (
    <>
      <Button ref={(el) => { ref.current = el as HTMLElement | null; }} icon={icon} endIcon={text ? 'slim-arrow-down' : undefined}
              design={design} disabled={disabled || !sichtbar.length} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        {text}
      </Button>
      <Menu open={open} opener={ref.current} onClose={() => setOpen(false)}
            onItemClick={(e) => {
              const i = Number((e.detail.item as HTMLElement).dataset.idx);
              setOpen(false);
              sichtbar[i]?.onClick();
            }}>
        {sichtbar.map((it, i) => (
          <MenuItem key={it.text} data-idx={i} text={it.text} icon={it.icon} disabled={it.disabled} />
        ))}
      </Menu>
    </>
  );
}
