import { useEffect, useState } from 'react';
import { BusyIndicator, Button, MessageStrip, ObjectStatus, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import './mannschaftsmeldung.css';

/**
 * Mein Bereich → Mannschaftsmeldung: Für jede offene Abfrage gibt man je Mannschaft (Altersklasse) an, ob man fest spielt,
 * als Ersatz zur Verfügung steht oder nicht teilnimmt – für sich und die Personen der eigenen Familie. Gesichert wird je
 * Person; bis zur Frist lässt sich alles ändern. Abgeschlossene Abfragen stehen zum Nachsehen darunter.
 */
type Wahl = 1 | 2 | 3;
interface Person { adrnr: string; name: string; wahl: Record<number, Wahl>; bemerkung: string }
interface Abfrage {
  id: number; titel: string; saison: string; frist: string | null; hinweis: string; status: 'offen' | 'geschlossen' | 'entwurf'; bearbeitbar: boolean;
  mannschaften: { gruppe_id: number; name: string; pfad: string }[]; personen: Person[];
}
const M = `${TCO}/mannschaftsmeldung`;
export const WAHLEN: { w: Wahl; text: string; lang: string }[] = [
  { w: 1, text: '1 · fest', lang: 'fest teilnehmen' }, { w: 2, text: '2 · Ersatz', lang: 'als Ersatz' }, { w: 3, text: '3 · nicht', lang: 'nicht teilnehmen' },
];

function PersonKarte({ a, p, onGesichert }: { a: Abfrage; p: Person; onGesichert: () => void }) {
  const [wahl, setWahl] = useState<Record<number, Wahl | null>>(p.wahl);
  const [bem, setBem] = useState(p.bemerkung);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setWahl(p.wahl); setBem(p.bemerkung); }, [p]);
  const dirty = JSON.stringify(Object.entries(wahl).filter(([, v]) => v != null).sort()) !== JSON.stringify(Object.entries(p.wahl).sort()) || bem !== p.bemerkung;
  const offen = a.mannschaften.filter((m) => !wahl[m.gruppe_id]).length;

  async function sichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${M}/meine/${a.id}`, {
        adrnr: p.adrnr, bemerkung: bem, wahl: a.mannschaften.map((m) => ({ gruppe_id: m.gruppe_id, wahl: wahl[m.gruppe_id] ?? null })),
      });
      toast(r.text); onGesichert();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="portal-mm__person">
      <div className="portal-mm__kopf">
        <b>{p.name}</b>
        {offen ? <ObjectStatus state="Critical">{offen} offen</ObjectStatus> : <ObjectStatus state="Positive">vollständig</ObjectStatus>}
      </div>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <div className="portal-mm__liste">
        {a.mannschaften.map((m) => (
          <fieldset key={m.gruppe_id} className="portal-mm__zeile" disabled={!a.bearbeitbar || busy}>
            <legend className="portal-mm__mannschaft" title={m.pfad}>{m.name}</legend>
            <div className="portal-mm__wahl" role="radiogroup" aria-label={`${p.name}: ${m.name}`}>
              {WAHLEN.map((x) => (
                <label key={x.w} className={`portal-mm__opt portal-mm__opt--${x.w}${wahl[m.gruppe_id] === x.w ? ' portal-mm__opt--an' : ''}`}>
                  <input type="radio" name={`mm-${a.id}-${p.adrnr}-${m.gruppe_id}`} checked={wahl[m.gruppe_id] === x.w}
                         onChange={() => setWahl({ ...wahl, [m.gruppe_id]: x.w })} aria-label={x.lang} />
                  {x.text}
                </label>
              ))}
              {a.bearbeitbar && wahl[m.gruppe_id] != null && (
                <button type="button" className="portal-mm__leeren" aria-label={`${m.name}: Angabe entfernen`} onClick={() => setWahl({ ...wahl, [m.gruppe_id]: null })}>×</button>
              )}
            </div>
          </fieldset>
        ))}
      </div>
      <TextArea rows={2} disabled={!a.bearbeitbar || busy} value={bem} maxlength={500} placeholder="Bemerkung (optional), z. B. „im Juni im Urlaub“"
                onInput={(e) => setBem(e.target.value)} style={{ width: '100%', marginTop: '0.5rem' }} />
      {a.bearbeitbar && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          {dirty && <Button design="Transparent" disabled={busy} onClick={() => { setWahl(p.wahl); setBem(p.bemerkung); }}>Verwerfen</Button>}
          <Button design="Emphasized" icon="save" disabled={busy || !dirty} onClick={sichern}>Sichern</Button>
        </div>
      )}
    </div>
  );
}

export function MeineMannschaftsmeldung() {
  const [d, setD] = useState<{ abfragen: Abfrage[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<{ abfragen: Abfrage[] }>(`${M}/meine`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  return (
    <AppPage title="Mannschaftsmeldung" subtitle="Je Mannschaft angeben: 1 = fest teilnehmen · 2 = als Ersatz · 3 = nicht teilnehmen">
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      {!d ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : !d.abfragen.length ? (
        <MessageStrip design="Information" hideCloseButton>Zurzeit gibt es keine offene Mannschaftsmeldung. Der Sportwart gibt Bescheid, sobald die Abfrage für die nächste Saison startet.</MessageStrip>
      ) : d.abfragen.map((a) => (
        <Section key={a.id} title={`${a.titel}${a.saison && !a.titel.includes(a.saison) ? ` · ${a.saison}` : ''}`}
                 status={a.bearbeitbar ? <ObjectStatus state="Information" inverted>{a.frist ? `offen bis ${dat(a.frist)}` : 'offen'}</ObjectStatus>
                   : <ObjectStatus state="None" inverted>{a.status === 'offen' ? 'Frist abgelaufen' : 'abgeschlossen'}</ObjectStatus>}>
          {a.hinweis && <Text style={{ display: 'block', whiteSpace: 'pre-line', marginBottom: '0.75rem' }}>{a.hinweis}</Text>}
          {!a.bearbeitbar && <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>Änderungen bitte direkt beim Sportwart melden.</Text>}
          <div className="portal-mm__personen">
            {a.personen.map((p) => <PersonKarte key={p.adrnr} a={a} p={p} onGesichert={laden} />)}
          </div>
        </Section>
      ))}
    </AppPage>
  );
}
