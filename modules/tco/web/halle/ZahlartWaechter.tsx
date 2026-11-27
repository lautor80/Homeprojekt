import { useEffect, useState } from 'react';
import { Button, CheckBox, Dialog, FlexBox, Input, Label, MessageStrip, RadioButton, Text, Title } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { TCO } from '../util';

interface Stand {
  fragen: boolean; aktiv: boolean; zahlart: 'LASTSCHRIFT' | 'UEBERWEISUNG' | null;
  mitglied: { iban: string; kontoinhaber: string } | null;
  mandatstext: string; verein: string; glaeubigerId: string; vorankuendigung: number; name: string;
}

const SPAETER = 'tco.halle.zahlart.spaeter';
const spaeterGemerkt = () => { try { return sessionStorage.getItem(SPAETER) === '1'; } catch { return false; } };
const spaeterMerken = () => { try { sessionStorage.setItem(SPAETER, '1'); } catch { /* ohne Speicher: erscheint beim nächsten Laden wieder */ } };

/**
 * Wächter „Zahlart Hallenrechnungen“: Ist die Lastschrift für Hallenrechnungen eingeschaltet (Hallen-Lastschrift →
 * Einstellungen), fragt das Portal Hallenbucher und Mitglieder mit Hallenrechnungen einmal nach der Zahlart.
 * Lastschrift = SEPA-Mandat erteilen (Bankverbindung der Mitgliedschaft oder eine eigene), sonst weiter Überweisung.
 * „Später entscheiden“ blendet den Hinweis für diese Sitzung aus.
 */
export function ZahlartWaechter() {
  const [s, setS] = useState<Stand | null>(null);
  const [offen, setOffen] = useState(false);
  const [wahl, setWahl] = useState<'LASTSCHRIFT' | 'UEBERWEISUNG'>('LASTSCHRIFT');
  const [mitglied, setMitglied] = useState(true);
  const [inhaber, setInhaber] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [zustimmung, setZustimmung] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (spaeterGemerkt()) return;
    // ohne zugeordnete Person oder bei Störungen still bleiben
    api.get<Stand>(`${TCO}/halle/zahlart/ich`).then((x) => {
      setS(x);
      setOffen(x.fragen);
      setMitglied(!!x.mitglied);
      setInhaber(x.mitglied?.kontoinhaber || x.name || '');
    }).catch(() => setS(null));
  }, []);
  if (!s || !offen) return null;

  const eigen = wahl === 'LASTSCHRIFT' && !(mitglied && s.mitglied);
  async function speichern() {
    setBusy(true); setFehler(null);
    try {
      const r = await api.post<{ text: string }>(`${TCO}/halle/zahlart/ich`, {
        zahlart: wahl, mitglied: wahl === 'LASTSCHRIFT' && mitglied && !!s!.mitglied,
        kontoinhaber: eigen ? inhaber : null, iban: eigen ? iban : null, bic: eigen ? bic || null : null, zustimmung,
      });
      toast(r.text, 6000);
      setOffen(false);
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }
  function spaeter() { spaeterMerken(); setOffen(false); }

  return (
    <Dialog open headerText="Zahlart für deine Hallenrechnungen" style={{ width: 'min(38rem, 96vw)' }}
            onBeforeClose={(e) => { if (offen) e.preventDefault(); }}
            footer={<FussLeiste endContent={<>
              <Button design="Transparent" onClick={spaeter} disabled={busy}>Später entscheiden</Button>
              <Button design="Emphasized" icon="accept" loading={busy} disabled={wahl === 'LASTSCHRIFT' && !zustimmung} onClick={speichern}>
                {wahl === 'LASTSCHRIFT' ? 'Mandat erteilen' : 'Weiter per Überweisung'}
              </Button>
            </>} />}>
      <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
        Deine Hallenrechnungen kannst du ab sofort bequem per <b>SEPA-Lastschrift</b> bezahlen: Die Rechnung kündigt den Einzug an,
        frühestens {s.vorankuendigung} Tage später buchen wir den Betrag ab – du musst nichts mehr überweisen.
      </Text>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <FlexBox direction="Column" style={{ marginBottom: '0.5rem' }}>
        <RadioButton name="zahlart" text="Per SEPA-Lastschrift bezahlen" checked={wahl === 'LASTSCHRIFT'} onChange={() => setWahl('LASTSCHRIFT')} />
        <RadioButton name="zahlart" text="Weiter per Überweisung bezahlen" checked={wahl === 'UEBERWEISUNG'} onChange={() => setWahl('UEBERWEISUNG')} />
      </FlexBox>
      {wahl === 'LASTSCHRIFT' && (
        <>
          {s.mitglied && (
            <FlexBox direction="Column" style={{ margin: '0 0 0.5rem 1rem' }}>
              <RadioButton name="konto" text={`Konto meiner Mitgliedschaft (${s.mitglied.iban})`} checked={mitglied} onChange={() => setMitglied(true)} />
              <RadioButton name="konto" text="Ein anderes Konto" checked={!mitglied} onChange={() => setMitglied(false)} />
            </FlexBox>
          )}
          {eigen && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, auto) 1fr', gap: '0.4rem 0.75rem', alignItems: 'center', marginBottom: '0.5rem' }}>
              <Label required>Kontoinhaber</Label>
              <Input value={inhaber} maxlength={70} onInput={(e) => setInhaber(e.target.value)} style={{ width: '100%' }} />
              <Label required>IBAN</Label>
              <Input value={iban} maxlength={42} placeholder="DE00 0000 0000 0000 0000 00" onInput={(e) => setIban(e.target.value)} style={{ width: '100%' }} />
              <Label>BIC</Label>
              <Input value={bic} maxlength={11} placeholder="nur für Konten außerhalb des EWR nötig" onInput={(e) => setBic(e.target.value)} style={{ width: '100%' }} />
            </div>
          )}
          <Title level="H6" style={{ margin: '0.5rem 0 0.25rem' }}>SEPA-Lastschriftmandat</Title>
          <Text className="portal-small" style={{ display: 'block', whiteSpace: 'pre-line', maxHeight: '11rem', overflowY: 'auto', padding: '0.5rem',
            border: '1px solid var(--sapGroup_TitleBorderColor)', borderRadius: '0.5rem', marginBottom: '0.5rem' }}>
            {`Zahlungsempfänger: ${s.verein}, Gläubiger-ID ${s.glaeubigerId}\nDie Mandatsreferenz steht nach dem Bestätigen auf jeder Rechnung.\n\n${s.mandatstext}`}
          </Text>
          <CheckBox checked={zustimmung} onChange={(e) => setZustimmung(e.target.checked)} wrappingType="Normal"
                    text={`Ich erteile dem ${s.verein} dieses SEPA-Lastschriftmandat für meine Hallenrechnungen.`} />
        </>
      )}
      {wahl === 'UEBERWEISUNG' && (
        <Text className="portal-muted portal-small" style={{ display: 'block' }}>
          Du bekommst deine Rechnungen wie bisher mit Bankverbindung und QR-Code zum Überweisen. Möchtest du später doch per Lastschrift
          zahlen, melde dich bitte beim Verein.
        </Text>
      )}
    </Dialog>
  );
}
