import { useEffect, useState } from 'react';
import { Bar, Button, Dialog, Input, Label, MessageStrip, SegmentedButton, SegmentedButtonItem, Text } from '@ui5/webcomponents-react';
import { satzSieger } from '../../server/turnier/wertung';
import { einzelAuswerten, ErgebnisFehler, spassAuswerten, type ErgebnisEingabeWeb, type Satz, type Spiel } from './api';

/**
 * Ergebnis eintragen (Verwaltung, „Mein Turnier“, Platz-QR).
 * art 'einzel': bis zu 3 Sätze (dritter = Match-Tiebreak, erst bei 1:1 nötig), Wertung gespielt/Aufgabe/kampflos
 * (Liga zusätzlich „nicht gespielt“); art 'spass': Spiele je Team. Prüft vor dem Senden mit einzelAuswerten/spassAuswerten
 * (dieselbe Prüfung wie der Server) und zeigt Fehler direkt im Dialog an.
 */
export interface ErgebnisDialogProps {
  offen: boolean;
  spiel: Spiel;
  /** Anzeigenamen je Seite (Doppel: zwei Namen) */
  namenA: string[];
  namenB: string[];
  art: 'einzel' | 'spass';
  /** Liga: Wertung „nicht gespielt“ anbieten */
  liga?: boolean;
  /** wirft bei Fehler (Meldung wird im Dialog angezeigt) */
  onSpeichern: (e: ErgebnisEingabeWeb) => Promise<void>;
  onSchliessen: () => void;
}

type WertungWahl = ErgebnisEingabeWeb['wertung'];
const WERTUNG_TEXT: Record<WertungWahl, string> = { gespielt: 'gespielt', aufgabe: 'Aufgabe', wo: 'kampflos (w.o.)', keine: 'nicht gespielt' };
/** Eingabe je Satz als Text (leere Felder erlaubt) */
type Zeile = [string, string];
const LEER: Zeile[] = [['', ''], ['', ''], ['', '']];

const zahl = (v: string): number | null => (/^\d{1,2}$/.test(v.trim()) ? Number(v.trim()) : null);
const namen = (l: string[]) => (l.length ? l.join(' / ') : '–');

/** Zeilen → Sätze; leere Zeilen am Ende fallen weg, halb ausgefüllte ergeben einen Hinweis */
function saetzeLesen(z: Zeile[]): { saetze: Satz[]; fehler: string | null } {
  const saetze: Satz[] = [];
  let ende = false;
  for (let i = 0; i < z.length; i++) {
    const [x, y] = z[i];
    if (!x.trim() && !y.trim()) { ende = true; continue; }
    const a = zahl(x), b = zahl(y);
    if (a == null || b == null) return { saetze, fehler: `${i === 2 ? 'Match-Tiebreak' : `Satz ${i + 1}`}: bitte beide Zahlen eingeben.` };
    if (ende) return { saetze, fehler: `Bitte die Sätze der Reihe nach eintragen (Satz ${i} fehlt).` };
    saetze.push([a, b]);
  }
  return { saetze, fehler: null };
}

/** nach zwei Sätzen 1:1? → Match-Tiebreak nötig */
function einsZuEins(z: Zeile[]) {
  const s1 = zahl(z[0][0]) != null && zahl(z[0][1]) != null ? satzSieger([zahl(z[0][0])!, zahl(z[0][1])!]) : null;
  const s2 = zahl(z[1][0]) != null && zahl(z[1][1]) != null ? satzSieger([zahl(z[1][0])!, zahl(z[1][1])!]) : null;
  return !!s1 && !!s2 && s1 !== s2;
}

const feldStil = { width: '3.75rem', minWidth: '3.75rem', textAlign: 'center' as const };

export function ErgebnisDialog({ offen, spiel, namenA, namenB, art, liga, onSpeichern, onSchliessen }: ErgebnisDialogProps) {
  const [wertung, setWertung] = useState<WertungWahl>('gespielt');
  const [zeilen, setZeilen] = useState<Zeile[]>(LEER);
  const [sieger, setSieger] = useState<'a' | 'b' | null>(null);
  const [spass, setSpass] = useState<Zeile>(['', '']);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // beim Öffnen mit vorhandenem Ergebnis vorbelegen
  useEffect(() => {
    if (!offen) return;
    const w = spiel.wertung;
    setWertung(w === 'aufgabe' || w === 'wo' || (w === 'keine' && liga) ? w : 'gespielt');
    const s = spiel.saetze ?? [];
    setZeilen(LEER.map((_, i) => (s[i] ? [String(s[i][0]), String(s[i][1])] : ['', ''])) as Zeile[]);
    setSpass(s[0] ? [String(s[0][0]), String(s[0][1])] : ['', '']);
    setSieger(spiel.sieger === 'a' || spiel.sieger === 'b' ? spiel.sieger : null);
    setFehler(null);
    setBusy(false);
  }, [offen, spiel.id]); // eslint-disable-line react-hooks/exhaustive-deps — nur beim Öffnen bzw. für ein anderes Spiel

  // Live-Prüfung → fertige Eingabe oder Hinweis
  let eingabe: ErgebnisEingabeWeb | null = null;
  let hinweis: string | null = null;
  let siegerText: string | null = null;
  try {
    if (art === 'spass') {
      const a = zahl(spass[0]), b = zahl(spass[1]);
      if (a == null || b == null) hinweis = 'Bitte die gewonnenen Spiele beider Teams eingeben.';
      else {
        const e = spassAuswerten(a, b);
        eingabe = { wertung: 'gespielt', saetze: [[a, b]] };
        siegerText = e.sieger === 'x' ? 'Unentschieden' : `Sieg ${namen(e.sieger === 'a' ? namenA : namenB)}`;
      }
    } else if (wertung === 'keine') {
      eingabe = { wertung: 'keine', saetze: null, sieger: null };
      siegerText = 'Keine Wertung – niemand bekommt den Sieg.';
    } else if (wertung === 'wo') {
      const e = einzelAuswerten('wo', null, sieger);
      eingabe = { wertung: 'wo', saetze: null, sieger };
      siegerText = `Kampfloser Sieg ${namen(e.sieger === 'a' ? namenA : namenB)} (zählt 6:0 6:0)`;
    } else {
      const { saetze, fehler: f } = saetzeLesen(zeilen);
      if (f) hinweis = f;
      else if (!saetze.length && wertung === 'gespielt') hinweis = 'Bitte das Ergebnis Satz für Satz eintragen.';
      else {
        const e = einzelAuswerten(wertung, saetze, sieger);
        eingabe = { wertung, saetze, sieger: wertung === 'aufgabe' ? sieger : null };
        siegerText = `Sieg ${namen(e.sieger === 'a' ? namenA : namenB)} (Sätze ${e.saetze[0]}:${e.saetze[1]})`;
      }
    }
  } catch (err) {
    if (!(err instanceof ErgebnisFehler)) throw err;
    hinweis = err.message;
  }

  async function speichern() {
    if (!eingabe) return;
    setBusy(true); setFehler(null);
    try { await onSpeichern(eingabe); } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  const setZ = (i: number, j: 0 | 1, v: string) => setZeilen(zeilen.map((z, k) => (k === i ? (j === 0 ? [v, z[1]] : [z[0], v]) : z)) as Zeile[]);
  const mtb = einsZuEins(zeilen);
  const wahl: WertungWahl[] = liga ? ['gespielt', 'aufgabe', 'wo', 'keine'] : ['gespielt', 'aufgabe', 'wo'];
  const zahlFeld = (wert: string, set: (v: string) => void, label: string, deaktiviert?: boolean) => (
    <Input type="Number" value={wert} style={feldStil} disabled={deaktiviert} accessibleName={label}
           onInput={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 2))}
           onKeyDown={(e) => { if (e.key === 'Enter' && eingabe) speichern(); }} />
  );

  return (
    <Dialog open={offen} headerText="Ergebnis eintragen" style={{ width: 'min(30rem, 98vw)' }} onClose={onSchliessen}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="save" disabled={!eingabe} loading={busy} onClick={speichern}>Speichern</Button>
              <Button onClick={onSchliessen}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form" style={{ gap: '0.75rem' }}>
        {fehler && <MessageStrip design="Negative" hideCloseButton>{fehler}</MessageStrip>}

        {art === 'einzel' && (
          <div>
            <Label showColon>Wertung</Label>
            <SegmentedButton style={{ width: '100%', marginTop: '0.25rem' }}
                             onSelectionChange={(e) => { const w = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.w as WertungWahl | undefined; if (w) setWertung(w); }}>
              {wahl.map((w) => <SegmentedButtonItem key={w} data-w={w} selected={wertung === w}>{WERTUNG_TEXT[w]}</SegmentedButtonItem>)}
            </SegmentedButton>
          </div>
        )}

        {art === 'spass' ? (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              <tr>
                <td style={{ padding: '0.25rem 0.5rem 0.25rem 0' }}><Text><b>{namen(namenA)}</b></Text></td>
                <td style={{ width: '4rem' }}>{zahlFeld(spass[0], (v) => setSpass([v, spass[1]]), `Spiele ${namen(namenA)}`)}</td>
              </tr>
              <tr>
                <td style={{ padding: '0.25rem 0.5rem 0.25rem 0' }}><Text><b>{namen(namenB)}</b></Text></td>
                <td>{zahlFeld(spass[1], (v) => setSpass([spass[0], v]), `Spiele ${namen(namenB)}`)}</td>
              </tr>
            </tbody>
          </table>
        ) : wertung === 'keine' ? (
          <Text>Das Spiel wurde nicht ausgetragen und keine Seite hat sich nachweislich um einen Termin bemüht – niemand bekommt etwas.</Text>
        ) : (
          <>
            {wertung !== 'wo' && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th />
                      {['1. Satz', '2. Satz', 'Match-TB'].map((h, i) => (
                        <th key={h} className="portal-small portal-muted" style={{ fontWeight: 'normal', padding: '0 0.15rem', opacity: i === 2 && !mtb && wertung === 'gespielt' ? 0.5 : 1 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {([0, 1] as const).map((j) => (
                      <tr key={j}>
                        <td style={{ padding: '0.25rem 0.5rem 0.25rem 0', maxWidth: '9rem' }}><Text><b>{namen(j === 0 ? namenA : namenB)}</b></Text></td>
                        {[0, 1, 2].map((i) => (
                          <td key={i} style={{ padding: '0 0.15rem' }}>
                            {zahlFeld(zeilen[i][j], (v) => setZ(i, j, v), `${i === 2 ? 'Match-Tiebreak' : `Satz ${i + 1}`} ${namen(j === 0 ? namenA : namenB)}`,
                              i === 2 && !mtb && !zeilen[2][0] && !zeilen[2][1])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.25rem' }}>
                  2 Gewinnsätze; bei 1:1 Sätzen entscheidet der Match-Tiebreak bis 10.{wertung === 'aufgabe' ? ' Bei Aufgabe den abgebrochenen Satz mit dem Stand eintragen.' : ''}
                </Text>
              </div>
            )}
            {(wertung === 'aufgabe' || wertung === 'wo') && (
              <div>
                <Label showColon required>Wer gewinnt?</Label>
                <SegmentedButton style={{ width: '100%', marginTop: '0.25rem' }}
                                 onSelectionChange={(e) => { const s = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.s; setSieger(s === 'a' || s === 'b' ? s : null); }}>
                  <SegmentedButtonItem data-s="a" selected={sieger === 'a'}>{namen(namenA)}</SegmentedButtonItem>
                  <SegmentedButtonItem data-s="b" selected={sieger === 'b'}>{namen(namenB)}</SegmentedButtonItem>
                </SegmentedButton>
              </div>
            )}
          </>
        )}

        {hinweis
          ? <MessageStrip design="Critical" hideCloseButton>{hinweis}</MessageStrip>
          : siegerText && <MessageStrip design="Positive" hideCloseButton>{siegerText}</MessageStrip>}
      </div>
    </Dialog>
  );
}
