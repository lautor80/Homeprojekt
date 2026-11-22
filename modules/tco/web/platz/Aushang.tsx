import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Bar, Button, Dialog, Link, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { TCO } from '../util';

/**
 * Aushang in „Platz buchen“: Hinweise des Vereins mit Bildern (z. B. Hallenverschmutzung). Beim Aufruf öffnen sich die
 * fälligen Hinweise nacheinander (kritisch zuerst); ist eine Bestätigung verlangt, lässt sich der Dialog nur über
 * „Zur Kenntnis genommen“ schließen. Ein schmaler Streifen oben führt zu allen geltenden Hinweisen zum Nachlesen.
 * Steht noch der Hinweis zur Buchungssperre offen, wartet der Aushang, bis er bestätigt ist.
 */
export type Stil = 'INFO' | 'WARNUNG' | 'KRITISCH';
export interface AushangBild { id: number; dateiname: string }
export interface AushangAnzeige { id: number; titel: string; text: string; stil: Stil; bestaetigen: boolean; gueltig_bis: string | null; bilder: AushangBild[]; bestaetigt?: boolean }

export const STIL: Record<Stil, { text: string; dialog: 'Information' | 'Critical' | 'Negative'; strip: 'Information' | 'Critical' | 'Negative'; icon: string }> = {
  INFO: { text: 'Information', dialog: 'Information', strip: 'Information', icon: 'message-information' },
  WARNUNG: { text: 'Warnung', dialog: 'Critical', strip: 'Critical', icon: 'message-warning' },
  KRITISCH: { text: 'Wichtig', dialog: 'Negative', strip: 'Negative', icon: 'message-error' },
};
export const bildUrl = (aushang: number, bild: number) => `${TCO}/platz/aushaenge/${aushang}/bilder/${bild}`;

/** Absätze, Zeilenumbrüche und **fett** – sonst keine Formatierung */
function fliesstext(text: string): ReactNode {
  return text.split(/\n{2,}/).map((absatz, i) => (
    <p key={i} style={{ margin: '0 0 0.75rem', whiteSpace: 'pre-wrap' }}>
      {absatz.split(/(\*\*[^*]+\*\*)/).map((t, k) => (/^\*\*[^*]+\*\*$/.test(t) ? <b key={k}>{t.slice(2, -2)}</b> : <Fragment key={k}>{t}</Fragment>))}
    </p>
  ));
}

/** Inhalt eines Aushangs: Text und Bilder (Klick vergrößert) – auch für die Vorschau in der Verwaltung */
export function AushangInhalt({ a }: { a: AushangAnzeige }) {
  const [gross, setGross] = useState<AushangBild | null>(null);
  return (
    <div>
      {fliesstext(a.text)}
      {a.bilder.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${a.bilder.length === 1 ? '100%' : '9rem'}, 1fr))`, gap: '0.5rem' }}>
          {a.bilder.map((b) => (
            <button key={b.id} type="button" onClick={() => setGross(b)} title="Vergrößern"
                    style={{ padding: 0, border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem', overflow: 'hidden', background: 'none', cursor: 'zoom-in' }}>
              <img src={bildUrl(a.id, b.id)} alt={b.dateiname} loading="lazy"
                   style={{ display: 'block', width: '100%', height: a.bilder.length === 1 ? 'auto' : '9rem', maxHeight: '22rem', objectFit: 'cover' }} />
            </button>
          ))}
        </div>
      )}
      {gross && (
        <Dialog open headerText={gross.dateiname} style={{ width: 'min(64rem, 98vw)' }} onClose={() => setGross(null)}
                footer={<Bar endContent={<Button onClick={() => setGross(null)}>Schließen</Button>} />}>
          <img src={bildUrl(a.id, gross.id)} alt={gross.dateiname} style={{ display: 'block', maxWidth: '100%', maxHeight: '80vh', margin: '0 auto' }} />
        </Dialog>
      )}
    </div>
  );
}

/** Dialog eines Aushangs; schließen nur ohne offene Bestätigungspflicht */
function AushangDialog({ a, position, onFertig }: { a: AushangAnzeige; position?: string; onFertig: (bestaetigt: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const pflicht = a.bestaetigen && !a.bestaetigt;
  async function melden(bestaetigt: boolean) {
    setBusy(true); setFehler(null);
    try {
      await api.post(`${TCO}/platz/aushaenge/${a.id}/gesehen`, { bestaetigt });
      onFertig(bestaetigt);
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open headerText={a.titel} state={STIL[a.stil].dialog} style={{ width: 'min(40rem, 96vw)' }}
            onBeforeClose={(e) => { if (pflicht) e.preventDefault(); }}
            onClose={() => { if (!pflicht) void melden(false); }}
            footer={<Bar startContent={position ? <Text className="portal-muted portal-small">{position}</Text> : undefined}
                         endContent={pflicht
                           ? <Button design="Emphasized" icon="accept" loading={busy} onClick={() => melden(true)}>Zur Kenntnis genommen</Button>
                           : <Button design="Emphasized" loading={busy} onClick={() => melden(false)}>Schließen</Button>} />}>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <AushangInhalt a={a} />
    </Dialog>
  );
}

/** in „Platz buchen“ oben einbinden: öffnet fällige Hinweise und zeigt den Streifen zum Nachlesen */
export function AushangInPlatzBuchen() {
  const [liste, setListe] = useState<AushangAnzeige[]>([]);
  const [warteschlange, setWarteschlange] = useState<number[]>([]);
  const [frei, setFrei] = useState(false);
  const [nachlesen, setNachlesen] = useState<number | null>(null);

  useEffect(() => {
    api.get<{ aktuell: AushangAnzeige[]; oeffnen: number[] }>(`${TCO}/platz/aushaenge`)
      .then((r) => { setListe(r.aktuell); setWarteschlange(r.oeffnen); }).catch(() => { /* ohne Aushang weiterbuchen */ });
  }, []);
  // erst, wenn kein Hinweis zur Buchungssperre mehr offen ist (der kommt zuerst und muss bestätigt werden)
  useEffect(() => {
    if (frei || !warteschlange.length) return;
    let aus = false;
    const pruefen = () => api.get<{ gesperrt: boolean; bestaetigt: boolean }>(`${TCO}/platz/buchungssperre`)
      .then((s) => { if (!aus && (!s.gesperrt || s.bestaetigt)) setFrei(true); }).catch(() => { if (!aus) setFrei(true); });
    void pruefen();
    const t = setInterval(pruefen, 3000);
    return () => { aus = true; clearInterval(t); };
  }, [frei, warteschlange.length]);

  const erledigt = (id: number, bestaetigt: boolean) => setListe((l) => l.map((x) => (x.id === id ? { ...x, bestaetigt: x.bestaetigt || bestaetigt } : x)));
  const aktuell = frei ? liste.find((a) => a.id === warteschlange[0]) : undefined;
  const offen = liste.find((a) => a.id === nachlesen);
  if (!liste.length) return null;
  const staerkster = liste[0];

  return (
    <>
      <MessageStrip design={STIL[staerkster.stil].strip} hideCloseButton style={{ marginBottom: '0.75rem' }}>
        <b>{liste.length === 1 ? 'Hinweis des Vereins:' : `${liste.length} Hinweise des Vereins:`}</b>{' '}
        {liste.map((a, i) => (
          <Fragment key={a.id}>{i > 0 && ' · '}<Link onClick={() => setNachlesen(a.id)}>{a.titel}</Link></Fragment>
        ))}
      </MessageStrip>
      {aktuell && (
        <AushangDialog key={`auto-${aktuell.id}`} a={aktuell} position={warteschlange.length > 1 ? `noch ${warteschlange.length - 1} weitere${warteschlange.length === 2 ? 'r' : ''}` : undefined}
                       onFertig={(b) => { erledigt(aktuell.id, b); setWarteschlange((w) => w.slice(1)); }} />
      )}
      {!aktuell && offen && <AushangDialog key={`lesen-${offen.id}`} a={offen} onFertig={(b) => { erledigt(offen.id, b); setNachlesen(null); }} />}
    </>
  );
}
