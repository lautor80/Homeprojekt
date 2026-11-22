import { useState } from 'react';
import { Button, Input } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { toast } from '@core/toast';
import type { Freigabe } from '../server/typen';
import { type Spalte, Tabelle, W } from './util';

/** Freigegebene Texte (aus der Zeitenkontrolle „Freigeben“): je Regel und Account nicht mehr bemängelt; Freigabe zurücknehmen */
export function Freigaben({ edit }: { edit: boolean }) {
  const d = useLoad(() => api.get<Freigabe[]>(`${W}/freigaben`), []);
  const [suche, setSuche] = useState('');
  const [weg, setWeg] = useState<Freigabe | null>(null);
  const s = suche.trim().toLowerCase();
  const liste = (d.data ?? []).filter((f) => !s || [f.regel, f.text, f.acc, f.person].some((x) => x.toLowerCase().includes(s)));

  async function zuruecknehmen(f: Freigabe) {
    setWeg(null);
    try { await api.del(`${W}/freigaben/${f.id}`); toast(`Freigabe ${f.regel} zurückgenommen`); d.reload(); } catch (e) { toast((e as Error).message); }
  }

  const spalten: Spalte<Freigabe>[] = [
    { titel: 'Regel', fest: true, wert: (f) => <b>{f.regel}</b>, sort: (f) => f.regel },
    { titel: 'Text', breit: true, wert: (f) => <><div>„{f.text}“</div>{f.meldung && <div className="portal-muted portal-small">{f.meldung}</div>}</>, sort: (f) => f.text },
    { titel: 'Account', wert: (f) => f.acc.replace('|', ' · ') || <span className="portal-muted">ohne</span>, sort: (f) => f.acc },
    { titel: 'Freigegeben', wert: (f) => <><div>{new Date(f.freigegebenAm).toLocaleDateString('de-DE')}</div><div className="portal-muted portal-small">{[f.freigegebenVon, f.person && `bei ${f.person}`].filter(Boolean).join(' · ')}</div></>, sort: (f) => f.freigegebenAm },
    ...(edit ? [{ titel: '', fest: true, wert: (f: Freigabe) => <Button design="Transparent" icon="undo" tooltip="Freigabe zurücknehmen" onClick={() => setWeg(f)}>Zurücknehmen</Button> }] : []),
  ];

  return (
    <Section title="Freigegebene Texte" count={d.data?.length ?? 0} flush
             actions={<Input placeholder="Suche …" value={suche} showClearIcon onInput={(e) => setSuche(e.target.value)} style={{ width: '12rem' }} />}>
      <p className="portal-muted portal-small" style={{ padding: '0 1rem' }}>
        In der Zeitenkontrolle mit „Freigeben“ akzeptierte Texte. Ein Text gilt für die Regel und den Account (bei allen Personen und Tagen)
        als in Ordnung; Groß-/Kleinschreibung und Leerzeichen spielen keine Rolle.
      </p>
      <Tabelle<Freigabe> spalten={spalten} zeilen={liste} schluessel={(f) => f.id} leer="Keine Freigaben" />
      <ConfirmDialog open={!!weg} title="Freigabe zurücknehmen" confirmText="Zurücknehmen"
                     text={weg ? `${weg.regel} für „${weg.text}“ wird wieder bemängelt.` : ''}
                     onConfirm={() => weg && zuruecknehmen(weg)} onCancel={() => setWeg(null)} />
    </Section>
  );
}
