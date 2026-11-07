import { useRef, useState } from 'react';
import { Button, Menu, MenuItem } from '@ui5/webcomponents-react';

export const T = '/api/m/transport';

export interface Stop {
  pos: number;
  firma: string | null; strasse: string | null; land: string | null; plzort: string | null; ladenummer: string | null;
  datum: string | null; zeit: string | null;
  firma_e: string | null; strasse_e: string | null; land_e: string | null; plzort_e: string | null;
  datum_e: string | null; zeit_e: string | null;
}
export interface Traeger { pos?: number; produkt: string | null; prod_txt: string | null; menge: number; preis: number }
export interface Adresse {
  adrnr?: number; kundenname: string; kundenname2: string | null; anrede: string | null; name: string | null; vorname: string | null;
  strasse: string | null; hausnummer: string | null; land: string | null; plz: string | null; ort: string | null;
  telefon: string | null; fax: string | null; email: string | null; gln: string | null; markt: string | null; ustid: string | null;
}
export interface Auftrag {
  auftragsnr?: string;
  anlagedatum: string | null; leistungsdatum: string | null;
  kunde: number | null; unternehmer: number | null; rechnungsempfaenger: number | null;
  ordernummer: string | null; frachtpreis_ek: number; frachtpreis_vk: number; rgbetrag?: number;
  steuerrelevant: boolean; dok_fehlen: boolean;
  kennzeichen: string | null; fahrzeugtyp: string | null; ladegut: string | null; gewicht: string | null;
  ladeweise: string | null; palettentausch: string | null; ladenummer: string | null; besonderheiten: string | null;
  faktura?: string | null; fakturadatum?: string | null;
  stops: Stop[]; traeger: Traeger[];
  kundeAdr?: Adresse | null; unternehmerAdr?: Adresse | null; reAdr?: Adresse | null;
  typ: 'F' | 'H';
}
export interface ListRow {
  auftragsnr: string; kennzeichen: string | null; art: string; anlagedatum: string | null; kunde: string; unternehmer: string;
  route: string; ladedatum: string | null; ek: number; vk: number; betrag: number; faktura: string | null;
  fakturadatum: string | null; status: 'Offen' | 'Fakturiert'; dokFehlen: boolean;
}
export interface KeyText { key: string; text: string; aktiv?: boolean }
export interface AdrDD { key: string; text: string; zusatz: string }
export type Werte = Record<'FAHRZEUGTYP' | 'LADEGUT' | 'LADEWEISE' | 'PALETTENTAUSCH', KeyText[]>;

/** 1.234,56 */
export function betrag(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** TT.MM.JJJJ */
export function dat(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** Datei aus einer API-Antwort herunterladen */
export async function download(url: string, filename: string) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(JSON.parse(t || '{}').message ?? `Fehler ${res.status}`);
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export interface MenuEntry {
  text: string;
  icon?: string;
  disabled?: boolean;
  onClick: () => void;
}

/** Button mit Menü (wie sap.m.MenuButton) */
export function MenuButton({ text, icon, design, disabled, items }: {
  text: string; icon?: string; design?: 'Emphasized' | 'Default' | 'Transparent'; disabled?: boolean; items: MenuEntry[];
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={(el) => { ref.current = el as HTMLElement | null; }} icon={icon} endIcon="slim-arrow-down"
              design={design} disabled={disabled} onClick={() => setOpen(true)}>
        {text}
      </Button>
      <Menu open={open} opener={ref.current} onClose={() => setOpen(false)}
            onItemClick={(e) => {
              const i = Number((e.detail.item as HTMLElement).dataset.idx);
              setOpen(false);
              items[i]?.onClick();
            }}>
        {items.map((it, i) => (
          <MenuItem key={it.text} data-idx={i} text={it.text} icon={it.icon} disabled={it.disabled} />
        ))}
      </Menu>
    </>
  );
}
