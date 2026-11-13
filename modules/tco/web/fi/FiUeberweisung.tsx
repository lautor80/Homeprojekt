import { useEffect, useState } from 'react';
import { Bar, BusyIndicator, Button, Dialog, Input, Label, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { usePdf } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import { F } from './typen';
import '../instandhaltung/instandhaltung.css';

/**
 * FI-Belege: Paperless-Belege mit Folgeaktion „Überweisung an Einreicher“ und leerem Feld „SAP“. Nach der Auswahl eines
 * Belegs: Vorschau des Dokuments und QR-Code (GiroCode) zur Überweisung an den Einreicher – Empfänger und IBAN aus dem
 * Mitgliederstamm, Betrag aus dem Beleg; Betrag und Verwendungszweck sind änderbar, der Code wird danach neu erzeugt.
 */
interface Beleg { id: number; titel: string; korrespondent: string; datum: string | null; betrag: number | null; einreicher: string | null; hochgeladen: string | null; erledigt: boolean }
interface Zahlung {
  titel: string; einreicher: string; empfaenger: string | null; iban: string | null; iban_text: string | null; bic: string | null; bank: string | null;
  betrag: number | null; zweck: string; qr: string | null; hinweis: string | null; inhalt: { label: string; wert: string }[];
}
const zahl = (n: number | null) => (n != null ? n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

export function UeberweisungDialog({ onClose }: { onClose: () => void }) {
  const [liste, setListe] = useState<Beleg[] | null>(null);
  const [wahl, setWahl] = useState<Beleg | null>(null);
  const [z, setZ] = useState<Zahlung | null>(null);
  const [betrag, setBetrag] = useState('');
  const [zweck, setZweck] = useState('');
  const [geaendert, setGeaendert] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { blobUrl, error: pdfFehler } = usePdf(wahl ? `${F}/ueberweisungen/${wahl.id}/pdf` : null);
  useEffect(() => { api.get<Beleg[]>(`${F}/ueberweisungen`).then(setListe).catch((e) => setError((e as Error).message)); }, []);

  /** QR-Code erzeugen: ohne Angaben mit dem Betrag des Belegs und dem vorgeschlagenen Verwendungszweck */
  async function erzeugen(b: Beleg, mit?: { betrag: string; zweck: string }) {
    setBusy(true); setError(null);
    try {
      const q = new URLSearchParams();
      if (mit?.betrag.trim()) q.set('betrag', mit.betrag.trim());
      if (mit) q.set('zweck', mit.zweck);
      const r = await api.get<Zahlung>(`${F}/ueberweisungen/${b.id}/zahlung${q.size ? `?${q}` : ''}`);
      setZ(r); setBetrag(zahl(r.betrag)); setZweck(r.zweck); setGeaendert(false);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function waehlen(b: Beleg) { setWahl(b); setZ(null); erzeugen(b); }
  const kopieren = (text: string, was: string) => navigator.clipboard?.writeText(text).then(() => toast(`${was} kopiert.`)).catch(() => undefined);

  return (
    <Dialog open headerText={wahl ? `Überweisung an Einreicher – ${wahl.titel || `Beleg ${wahl.id}`}` : 'Überweisungen an Einreicher'} resizable
            style={{ width: 'min(84rem, 98vw)', height: wahl ? '92vh' : undefined }} onClose={onClose}
            footer={<Bar startContent={wahl ? <Button icon="nav-back" onClick={() => { setWahl(null); setZ(null); }}>Zur Liste</Button> : undefined}
                         endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!wahl && (
        <>
          <Text className="portal-muted portal-small">
            Belege aus Paperless mit Folgeaktion „Überweisung an Einreicher“, deren Feld „SAP“ leer ist (noch keiner Buchung zugeordnet). Beleg wählen für Vorschau und QR-Code.
          </Text>
          {!liste ? (error ? null : <BusyIndicator active style={{ display: 'block', margin: '1rem 0' }} />) : (
            <div className="portal-ih__rahmen" style={{ marginTop: '0.5rem', maxHeight: '60vh', overflowY: 'auto' }}><table className="portal-ih__tabelle">
              <thead><tr><th>Datum</th><th>Beleg</th><th>Titel</th><th>Korrespondent</th><th style={{ textAlign: 'right' }}>Betrag</th><th>Einreicher</th><th>hochgeladen</th><th /></tr></thead>
              <tbody>
                {!liste.length && <tr><td colSpan={8} className="portal-muted">Keine offenen Belege mit „Überweisung an Einreicher“.</td></tr>}
                {liste.map((b) => (
                  <tr key={b.id} className="portal-ih__zeile" onClick={() => waehlen(b)}>
                    <td>{dat(b.datum)}</td><td>{b.id}</td><td>{b.titel}</td><td>{b.korrespondent}</td>
                    <td style={{ textAlign: 'right' }}>{b.betrag != null ? eur(Math.abs(b.betrag)) : '–'}</td>
                    <td>{b.einreicher ?? <span className="portal-muted">unbekannt</span>}{b.erledigt ? <span className="portal-muted"> · als überwiesen markiert</span> : null}</td>
                    <td>{dat(b.hochgeladen)}</td>
                    <td><Button design="Transparent" icon="qr-code" onClick={(e) => { e.stopPropagation(); waehlen(b); }}>Vorschau und QR-Code</Button></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </>
      )}
      {wahl && (
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', height: '100%' }}>
          <div style={{ flex: '3 1 28rem', minHeight: '24rem', display: 'flex', flexDirection: 'column' }}>
            {pdfFehler && <MessageStrip design="Negative" hideCloseButton>{pdfFehler}</MessageStrip>}
            {blobUrl ? <iframe title="Voransicht des Belegs" src={blobUrl} style={{ flex: 1, width: '100%', minHeight: '24rem', border: '1px solid var(--sapList_BorderColor)' }} />
              : !pdfFehler && <BusyIndicator active style={{ display: 'block', margin: '2rem auto' }} />}
          </div>
          <div style={{ flex: '2 1 22rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0 }}>
            {!z ? <BusyIndicator active style={{ display: 'block' }} /> : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 0.75rem', alignItems: 'center' }}>
                  <Label showColon>Einreicher</Label><Text>{z.einreicher || '–'}</Text>
                  <Label showColon>Empfänger</Label><Text>{z.empfaenger ?? '–'}</Text>
                  <Label showColon>IBAN</Label>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <Text>{z.iban_text ?? '–'}</Text>
                    {z.iban && <Button design="Transparent" icon="copy" tooltip="IBAN kopieren" onClick={() => kopieren(z.iban!, 'IBAN')} />}
                  </span>
                  <Label showColon>Wert (Euro)</Label>
                  <Input style={{ width: '10rem' }} value={betrag} placeholder="z. B. 49,90" onInput={(e) => { setBetrag(e.target.value); setGeaendert(true); }} />
                  <Label showColon>Verwendungszweck</Label>
                  <Input maxlength={140} value={zweck} onInput={(e) => { setZweck(e.target.value); setGeaendert(true); }} />
                </div>
                <div>
                  <Button design={geaendert ? 'Emphasized' : 'Default'} icon="refresh" loading={busy} disabled={busy} onClick={() => erzeugen(wahl, { betrag, zweck })}>QR-Code neu erzeugen</Button>
                  {geaendert && <Text className="portal-muted portal-small" style={{ marginInlineStart: '0.5rem' }}>Die Änderung ist noch nicht im Code.</Text>}
                </div>
                {z.hinweis && <MessageStrip design={z.qr ? 'Information' : 'Critical'} hideCloseButton>{z.hinweis}</MessageStrip>}
                {z.qr && (
                  <>
                    <div style={{ textAlign: 'center', opacity: geaendert ? 0.35 : 1 }}>
                      <img src={z.qr} alt="QR-Code für die Überweisung (GiroCode)" style={{ width: 'min(15rem, 70vw)', height: 'auto', background: '#fff', padding: '0.5rem', borderRadius: '0.5rem' }} />
                    </div>
                    <div className="portal-ih__rahmen" style={{ padding: '0.5rem 0.75rem' }}>
                      <Label>Im QR-Code hinterlegt</Label>
                      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.125rem 0.75rem', marginTop: '0.25rem' }}>
                        {z.inhalt.map((x) => <span key={x.label} style={{ display: 'contents' }}><span className="portal-muted">{x.label}</span><span style={{ wordBreak: 'break-word' }}>{x.wert}</span></span>)}
                      </div>
                      <div className="portal-muted portal-small" style={{ marginTop: '0.375rem' }}>
                        Mit der Banking-App scannen („Fotoüberweisung“ bzw. „QR-Code scannen“): Die Angaben werden in die Überweisung übernommen und dort vor der Freigabe noch einmal angezeigt.
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
