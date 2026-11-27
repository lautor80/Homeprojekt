import { useEffect, useState } from 'react';
import { Button, Dialog, MessageStrip, Text, Title } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { TCO, dat, eur } from '../util';

interface SperrPosten { art: 'HALLE' | 'VERZEHR'; nr: string; betrag: number; faellig: string; stufe_name: string; gemahnt_am: string | null }
interface Stand { gesperrt: boolean; posten: SperrPosten[]; text: string | null; bestaetigt: boolean }

const ART: Record<SperrPosten['art'], string> = { HALLE: 'Hallenrechnung', VERZEHR: 'Verzehrabrechnung' };

/**
 * Wächter „Buchungssperre“ (Mahnwesen): Hat das angemeldete Mitglied angemahnte Rechnungen ab der Stufe mit dem Kennzeichen
 * „Buchungssperre“ offen, erscheint nach der Anmeldung ein Hinweis, der bestätigt werden muss (einmal je Sitzung; der Server
 * merkt sich die Bestätigung). Schließen ohne Bestätigung ist nicht möglich. Nach Zahlungseingang erscheint er nicht mehr.
 */
export function BuchungssperreWaechter() {
  const [s, setS] = useState<Stand | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    // ohne zugeordnetes Mitglied oder bei Störungen still bleiben – die Sperre prüft der Server beim Buchen ohnehin
    api.get<Stand>(`${TCO}/platz/buchungssperre`).then(setS).catch(() => setS(null));
  }, []);
  if (!s || !s.gesperrt || s.bestaetigt) return null;
  const summe = s.posten.reduce((x, p) => x + p.betrag, 0);
  async function bestaetigen() {
    setBusy(true); setFehler(null);
    try {
      await api.post(`${TCO}/platz/buchungssperre/bestaetigen`, {});
      setS((x) => (x ? { ...x, bestaetigt: true } : x));
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText="Buchungssperre: offene Rechnungen" state="Negative" style={{ width: 'min(36rem, 96vw)' }}
            onBeforeClose={(e) => { if (!s.bestaetigt) e.preventDefault(); }}
            footer={<FussLeiste endContent={<Button design="Emphasized" icon="accept" loading={busy} onClick={bestaetigen}>Zur Kenntnis genommen</Button>} />}>
      <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>
        <b>Du kannst vorübergehend keine neuen Hallenstunden buchen.</b>
      </MessageStrip>
      {fehler && <MessageStrip design="Critical" onClose={() => setFehler(null)} style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.75rem' }}>{s.text}</Text>
      <Title level="H6" style={{ marginBottom: '0.25rem' }}>Angemahnte Posten</Title>
      <ul style={{ margin: '0 0 0.75rem 1.25rem', padding: 0 }}>
        {s.posten.map((p) => (
          <li key={`${p.art}:${p.nr}`}>
            {ART[p.art]} <b>{p.nr}</b> – fällig {dat(p.faellig)}, offen <b>{eur(p.betrag)}</b>{p.stufe_name ? ` (${p.stufe_name}${p.gemahnt_am ? ` vom ${dat(p.gemahnt_am)}` : ''})` : ''}
          </li>
        ))}
      </ul>
      {s.posten.length > 1 && <Text style={{ display: 'block', marginBottom: '0.5rem' }}>Gesamt offen: <b>{eur(summe)}</b></Text>}
      <Text className="portal-muted portal-small" style={{ display: 'block' }}>
        Bereits gebuchte Termine bleiben bestehen und lassen sich weiterhin ändern oder stornieren; Freiplätze sind nicht betroffen.
        Die Bankverbindung steht in der Mahnung bzw. auf der Rechnung. Hast du bereits bezahlt, wird die Sperre mit dem Verbuchen des Zahlungseingangs aufgehoben.
      </Text>
    </Dialog>
  );
}
