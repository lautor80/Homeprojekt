import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BusyIndicator, Button, CheckBox, Dialog, Input, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FussLeiste } from '@core/components/DialogFuss';
import { TCO, dat } from '../util';
import { kommentarNoetig, stornierbar, stornoBereit, terminStatus, termineTitel, termineZeigen, type AboTermin } from './aboTermine';

interface AboTermine { bid: string; kunde: string; platz: string; einzelabrechnung: boolean; quelle: 'Portal' | 'EP3'; termine: AboTermin[] }

/**
 * Platzverwaltung → Abos → „Termine“ (Recht tco.platz:abotermine, Funktion tco.platz.abotermine): die Termine einer Abo-Serie
 * mit Status; jeder einzelne lässt sich stornieren, ohne das Abo zu beenden. Die Rückfrage steht in der Zeile selbst (kein
 * zweiter Dialog – im Hochformat bleibt alles sichtbar); abgerechnete Termine brauchen einen Kommentar.
 */
export function AboTermineDialog({ bid, datum, onClose, onGeaendert }: {
  bid: string;
  /** vorgewählter Termin (aus der Belegung geöffnet) */
  datum?: string | null;
  onClose: () => void;
  /** nach einem Storno: Liste bzw. Belegung neu laden */
  onGeaendert: (text: string) => void;
}) {
  const [d, setD] = useState<AboTermine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [vergangene, setVergangene] = useState(false);
  const [frage, setFrage] = useState<string | null>(null);
  const [kommentar, setKommentar] = useState('');
  const [busy, setBusy] = useState(false);
  const laden = () => api.get<AboTermine>(`${TCO}/platz/admin/abos/${encodeURIComponent(bid)}/termine`).then(setD).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, [bid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function stornieren(t: AboTermin) {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${TCO}/platz/admin/abos/${encodeURIComponent(bid)}/termine/storno`, { datum: t.datum, grund: kommentar.trim() || null });
      setMeldung(r.text); setFrage(null); setKommentar('');
      await laden();
      onGeaendert(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const liste = d ? termineZeigen(d.termine, vergangene, datum) : [];
  return createPortal(
    <Dialog open headerText={`Abo ${bid}${d ? ` · ${d.kunde}` : ''}`} style={{ width: 'min(40rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      <div className="portal-mz__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        {meldung && <MessageStrip design="Positive" onClose={() => setMeldung(null)}>{meldung}</MessageStrip>}
        {!d && !error && <BusyIndicator active />}
        {d && (
          <>
            <Text className="portal-muted">
              {d.platz} · {termineTitel(d.termine)} · {d.einzelabrechnung ? 'Abrechnung je Termin (Einzelabrechnung)' : 'Abrechnung als Serie'} · Herkunft {d.quelle}
            </Text>
            <Text className="portal-muted portal-small">
              Stornieren betrifft nur den gewählten Termin – das Abo läuft weiter. Die Zeit ist danach frei und zählt weder in den Statistiken noch in der Abrechnung.
            </Text>
            <CheckBox text="Auch vergangene Termine zeigen" checked={vergangene} onChange={(e) => setVergangene(e.target.checked)} />
            {!liste.length && <MessageStrip hideCloseButton>Keine kommenden Termine.</MessageStrip>}
            {liste.map((t) => {
              const s = terminStatus(t);
              const offen = frage === t.datum;
              return (
                <div key={t.datum} style={{ borderTop: '1px solid var(--sapList_BorderColor)', padding: '0.4rem 0', background: t.datum === datum ? 'var(--sapList_SelectionBackgroundColor)' : undefined }}>
                  <div className="portal-row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <div>
                      <Text style={{ fontWeight: 600, textDecoration: t.storniert ? 'line-through' : undefined }}>{t.wochentag.slice(0, 2)}, {dat(t.datum)} · {t.von}–{t.bis} Uhr</Text>
                      <div><ObjectStatus state={s.art}>{s.text}</ObjectStatus></div>
                    </div>
                    {stornierbar(t) && !offen && (
                      <Button design="Negative" icon="delete" disabled={busy} onClick={() => { setFrage(t.datum); setKommentar(''); setMeldung(null); }}>Termin stornieren</Button>
                    )}
                  </div>
                  {offen && (
                    <div style={{ display: 'grid', gap: '0.4rem', marginTop: '0.4rem' }}>
                      {kommentarNoetig(t) && (
                        <MessageStrip design="Critical" hideCloseButton>
                          Der Termin ist {t.rechnung ? `in der Rechnung ${t.rechnung} enthalten` : 'bereits abgerechnet'}: bitte einen Kommentar angeben und die Rechnung in der Hallenabrechnung prüfen.
                        </MessageStrip>
                      )}
                      <Input style={{ width: '100%' }} value={kommentar} maxlength={500} placeholder={kommentarNoetig(t) ? 'Kommentar (nötig)' : 'Kommentar (freiwillig), z. B. Absage wegen Krankheit'}
                             onInput={(e) => setKommentar(e.target.value)} />
                      <div className="portal-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                        <Button design="Negative" disabled={busy || !stornoBereit(t, kommentar)} onClick={() => stornieren(t)}>{dat(t.datum)} wirklich stornieren</Button>
                        <Button disabled={busy} onClick={() => setFrage(null)}>Nicht stornieren</Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
