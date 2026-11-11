import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bar, Button, CheckBox, Dialog, MessageStrip, Text } from '@ui5/webcomponents-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@core/api';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { PR } from './Praesentationen';

/**
 * Vereinsübersicht → „Zur Präsentation“ (#146, Option C): Kennzahlen, Diagramme und Tabellen eines Bereichs in den
 * Sammelkorb der App „Präsentationen“ legen.
 */
interface K { key: string; titel: string; bereich: string }
type Art = 'KPI' | 'DIAGRAMM' | 'TABELLE';

export function ZurPraesentation({ bereich }: { bereich: string }) {
  const can = useCan();
  const [offen, setOffen] = useState(false);
  if (!can('tco.praesentation:display')) return null;
  return (
    <>
      <Button design="Transparent" icon="ppt-attachment" tooltip="Inhalte dieses Bereichs in den Sammelkorb der Präsentation legen" onClick={() => setOffen(true)}>Zur Präsentation</Button>
      {offen && <Auswahl bereich={bereich} onClose={() => setOffen(false)} />}
    </>
  );
}

function Auswahl({ bereich, onClose }: { bereich: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [liste, setListe] = useState<{ art: Art; k: K }[] | null>(null);
  const [wahl, setWahl] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ kpis: K[]; diagramme: K[]; tabellen: K[] }>(`${PR}/katalog`).then((k) => setListe([
      ...k.kpis.filter((x) => x.bereich === bereich).map((x) => ({ art: 'KPI' as Art, k: x })),
      ...k.diagramme.filter((x) => x.bereich === bereich).map((x) => ({ art: 'DIAGRAMM' as Art, k: x })),
      ...k.tabellen.filter((x) => x.bereich === bereich).map((x) => ({ art: 'TABELLE' as Art, k: x })),
    ])).catch((e) => setError(e.message));
  }, [bereich]);
  const id = (a: Art, k: string) => `${a}:${k}`;
  async function hinzu(oeffnen: boolean) {
    setBusy(true);
    try {
      let n = 0;
      for (const x of liste ?? []) if (wahl.has(id(x.art, x.k.key))) { await api.post(`${PR}/korb`, { art: x.art, schluessel: x.k.key }); n++; }
      toast(`${n} Inhalt(e) zur Präsentation hinzugefügt.`, 4000);
      onClose();
      if (oeffnen) navigate('/tco/praesentationen');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const art = { KPI: 'Kennzahl', DIAGRAMM: 'Diagramm', TABELLE: 'Tabelle' };
  return createPortal(
    <Dialog open headerText={`Zur Präsentation – ${bereich}`} style={{ width: 'min(30rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={busy || !wahl.size} onClick={() => hinzu(false)}>Hinzufügen</Button>
              <Button disabled={busy || !wahl.size} onClick={() => hinzu(true)}>Hinzufügen und öffnen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      {liste && !liste.length && <Text>Für diesen Bereich gibt es keine Inhalte.</Text>}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {(liste ?? []).map((x) => (
          <CheckBox key={id(x.art, x.k.key)} text={`${art[x.art]}: ${x.k.titel}`} checked={wahl.has(id(x.art, x.k.key))}
                    onChange={(e) => setWahl((w) => { const n = new Set(w); if (e.target.checked) n.add(id(x.art, x.k.key)); else n.delete(id(x.art, x.k.key)); return n; })} />
        ))}
      </div>
    </Dialog>,
    document.body,
  );
}
