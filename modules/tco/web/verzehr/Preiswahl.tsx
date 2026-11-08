import { useState, type ReactNode } from 'react';
import { Button, Text, ToggleButton } from '@ui5/webcomponents-react';
import { eur } from '../util';
import { summe, wuensche, type Mengen, type Preisliste, type Rubrik } from './typen';

/**
 * Preisliste mit Mengenwahl (Plus/Minus je Produkt) und Warenkorb – gemeinsam für „Mein Verzehr“ und die Theke.
 * `gast` = Gästepreise verwenden (sofern hinterlegt).
 */
export function Preiswahl({ liste, mengen, setMengen, gast, aktion, aktionText, busy, zusatz }: {
  liste: Preisliste; mengen: Mengen; setMengen: (m: Mengen) => void; gast: boolean;
  aktion: () => void; aktionText: string; busy: boolean; zusatz?: ReactNode;
}) {
  const rubriken = (Object.keys(liste.rubriken) as Rubrik[]).filter((r) => liste.produkte.some((p) => p.rubrik === r));
  const [rubrik, setRubrik] = useState<Rubrik>(rubriken[0] ?? 'G');
  const preis = (p: Preisliste['produkte'][number]) => (gast && p.preis_gast != null ? p.preis_gast : p.preis);
  const setze = (key: string, n: number) => setMengen({ ...mengen, [key]: Math.max(0, Math.min(99, n)) });
  const gewaehlt = liste.produkte.filter((p) => (mengen[p.prod_key] ?? 0) > 0);
  const gesamt = summe(liste.produkte, mengen, gast);
  return (
    <>
      {rubriken.length > 1 && (
        <div className="portal-vz__rubriken">
          {rubriken.map((r) => (
            <ToggleButton key={r} pressed={rubrik === r} design={rubrik === r ? 'Emphasized' : 'Default'} onClick={() => setRubrik(r)}>
              {liste.rubriken[r]}{liste.produkte.some((p) => p.rubrik === r && (mengen[p.prod_key] ?? 0) > 0) ? ' •' : ''}
            </ToggleButton>
          ))}
        </div>
      )}
      <div className="portal-vz__produkte">
        {liste.produkte.filter((p) => p.rubrik === rubrik).map((p) => {
          const n = mengen[p.prod_key] ?? 0;
          return (
            <div key={p.prod_key} className={`portal-vz__produkt${n ? ' portal-vz__produkt--aktiv' : ''}`}>
              <div style={{ minWidth: 0 }}>
                <div className="portal-vz__produkt-name">{p.text}</div>
                <div className="portal-vz__produkt-preis">{eur(preis(p))}{gast && p.preis_gast != null && p.preis_gast !== p.preis ? ' (Gästepreis)' : ''}</div>
              </div>
              <div className="portal-vz__menge">
                <Button icon="less" design="Transparent" disabled={!n || busy} onClick={() => setze(p.prod_key, n - 1)} tooltip="eins weniger" accessibleName={`${p.text} eins weniger`} />
                <span className="portal-vz__menge-zahl">{n}</span>
                <Button icon="add" design={n ? 'Emphasized' : 'Default'} disabled={busy} onClick={() => setze(p.prod_key, n + 1)} tooltip="eins mehr" accessibleName={`${p.text} eins mehr`} />
              </div>
            </div>
          );
        })}
        {!liste.produkte.some((p) => p.rubrik === rubrik) && <Text className="portal-muted">Keine Produkte in dieser Rubrik.</Text>}
      </div>
      <div className="portal-vz__warenkorb">
        {gewaehlt.length ? gewaehlt.map((p) => (
          <div key={p.prod_key} className="portal-vz__zeile"><span>{mengen[p.prod_key]} × {p.text}</span><span>{eur(mengen[p.prod_key] * preis(p))}</span></div>
        )) : <Text className="portal-muted">Noch nichts gewählt – Produkte oben mit + hinzufügen.</Text>}
        <div className="portal-vz__zeile portal-vz__zeile--summe"><span>Summe</span><span>{eur(gesamt)}</span></div>
        {zusatz}
        <div className="portal-vz__aktionen">
          <Button design="Emphasized" icon="cart" disabled={!wuensche(mengen).length || busy} onClick={aktion}>{aktionText}</Button>
          <Button design="Transparent" disabled={!gewaehlt.length || busy} onClick={() => setMengen({})}>Leeren</Button>
        </div>
      </div>
    </>
  );
}
