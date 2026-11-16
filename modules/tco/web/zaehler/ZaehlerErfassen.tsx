import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BusyIndicator, Button, MessageStrip } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { mitEinheit, vEinheit, Z } from './format';
import { StandFelder, WarnungBestaetigen, useStandErfassung, type Gespeichert } from './StandErfassen';
import type { ZaehlerZeile } from './typen';

/**
 * Zählerstand am Zähler erfassen (QR-Code „/tco/zaehler/erfassen?zaehler=<id>“): eine schlanke Seite fürs Handy –
 * Zähler vorbelegt, Stand eintippen, Foto, Sichern. Danach Erfolgsmeldung und „Nächster Zähler“ (nächster aktiver Zähler
 * in der Reihenfolge eines Rundgangs: Standort, Nummer).
 */
export function ZaehlerErfassen() {
  const can = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const zaehlerId = Number(params.get('zaehler')) || undefined;
  const { data, error, reload } = useLoad(() => api.get<{ zeilen: ZaehlerZeile[] }>(Z), []);
  const [erfolg, setErfolg] = useState<{ text: string; zaehlerId: number } | null>(null);
  const zeilen = data?.zeilen ?? [];
  const reihenfolge = zeilen.filter((z) => z.aktiv)
    .sort((a, b) => (a.standort ?? '').localeCompare(b.standort ?? '', 'de') || a.nummer.localeCompare(b.nummer));

  const s = useStandErfassung({
    zaehler: zeilen, zaehlerId,
    onGespeichert: (g: Gespeichert) => {
      const z = zeilen.find((x) => x.id === g.zaehlerId);
      setErfolg({
        zaehlerId: g.zaehlerId,
        text: `Zählerstand für ${z ? `${z.nummer} ${z.bezeichnung}` : 'den Zähler'} gesichert.${g.verbrauch !== null && z ? ` Verbrauch seit der vorigen Ablesung: ${mitEinheit(g.verbrauch, vEinheit(z))}.` : ''}`,
      });
      s.zuruecksetzen();
      reload();
    },
  });

  function naechster() {
    const ab = erfolg?.zaehlerId ?? s.zid;
    const i = reihenfolge.findIndex((z) => z.id === ab);
    const n = reihenfolge[(i + 1) % Math.max(1, reihenfolge.length)];
    setErfolg(null);
    if (!n) return;
    s.zuruecksetzen(n.id);
    setParams({ zaehler: String(n.id) }, { replace: true });
  }

  const z = s.z;
  return (
    <AppPage title="Zählerstand erfassen" subtitle={z ? `${z.nummer} · ${z.bezeichnung}${z.standort ? ` · ${z.standort}` : ''}` : 'Zähler wählen und Stand eintragen'}
             actions={can('tco.zaehler:display') ? <Button icon="measuring-point" design="Transparent" onClick={() => navigate('/tco/zaehler')}>Alle Zähler</Button> : undefined}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {erfolg && (
        <MessageStrip design="Positive" onClose={() => setErfolg(null)} style={{ marginBottom: '0.5rem' }}>{erfolg.text}</MessageStrip>
      )}
      {!data ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : (
        <Section>
          <div style={{ maxWidth: '34rem' }}>
            {zaehlerId && !zeilen.some((x) => x.id === zaehlerId) && (
              <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Der Zähler aus dem QR-Code ist nicht (mehr) vorhanden – bitte unten wählen.</MessageStrip>
            )}
            <StandFelder s={s} />
            <div className="portal-row" style={{ marginTop: '1rem' }}>
              <Button design="Emphasized" icon="save" disabled={s.gesperrt} loading={s.busy} onClick={() => s.speichern()}>Zählerstand sichern</Button>
              {reihenfolge.length > 1 && <Button icon="navigation-right-arrow" onClick={naechster}>Nächster Zähler</Button>}
            </div>
          </div>
        </Section>
      )}
      <WarnungBestaetigen s={s} />
    </AppPage>
  );
}
