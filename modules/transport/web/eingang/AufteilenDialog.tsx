import { useEffect, useState } from 'react';
import { BusyIndicator, Button, Dialog, Link, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { FussLeiste } from '@core/components/DialogFuss';
import { EING, antwortText, dateiUrl, type Seite, type Seitenart } from './typen';

/**
 * Posteingang → Dokument → „Aufteilen…“: ein PDF, in dem Rechnung, Ablieferbelege und der eigene Transportauftrag zusammenhängen,
 * je Seite einordnen. Der Server schlägt die Einordnung vor (GET …/seiten); nach dem Bestätigen entstehen „… – Rechnung.pdf“ und
 * „… – Ablieferbelege.pdf“, die Seiten des Transportauftrags entfallen, das Original bleibt im Portal.
 */
const ARTEN: { key: Seitenart; text: string }[] = [
  { key: 'R', text: 'Rechnung' },
  { key: 'A', text: 'Ablieferbeleg' },
  { key: 'T', text: 'Transportauftrag (entfällt)' },
];

export function AufteilenDialog({ id, datei, onClose, onFertig }: { id: number; datei: string; onClose: () => void; onFertig: (text: string) => void }) {
  const [seiten, setSeiten] = useState<Seite[] | null>(null);
  const [arten, setArten] = useState<Seitenart[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let aktiv = true;
    api.get<{ seiten: Seite[] }>(`${EING}/dokumente/${id}/seiten`)
      .then((r) => { if (aktiv) { const s = Array.isArray(r.seiten) ? r.seiten : []; setSeiten(s); setArten(s.map((x) => x.art)); } })
      .catch((e) => { if (aktiv) { setFehler((e as Error).message); setSeiten([]); } });
    return () => { aktiv = false; };
  }, [id]);

  const verschieden = new Set(arten).size > 1;
  const zahl = (a: Seitenart) => arten.filter((x) => x === a).length;
  async function aufteilen() {
    setBusy(true); setFehler(null);
    try {
      onFertig(antwortText(await api.post(`${EING}/dokumente/${id}/aufteilen`, { arten }), 'Aufgeteilt'));
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText={`Aufteilen: ${datei}`} style={{ width: 'min(44rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste endContent={<>
              <Button design="Emphasized" disabled={busy || !seiten?.length || !verschieden} onClick={aufteilen}
                      tooltip={verschieden ? undefined : 'Alle Seiten haben dieselbe Art – es gibt nichts aufzuteilen'}>Aufteilen</Button>
              <Button disabled={busy} onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {fehler && <MessageStrip design="Negative" hideCloseButton>{fehler}</MessageStrip>}
        {!seiten ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : seiten.length > 0 && (
          <>
            <Text className="portal-small portal-muted">
              Je Seite die Art wählen. Es entstehen {zahl('R') ? `„Rechnung“ (${zahl('R')} S.)` : 'keine Rechnung'}{zahl('A') ? ` und „Ablieferbelege“ (${zahl('A')} S.)` : ''}
              {zahl('T') ? `; ${zahl('T')} Seite(n) Transportauftrag entfallen` : ''}. Das Original bleibt unverändert im Portal.
            </Text>
            {seiten.map((s, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '5.5rem minmax(11rem, 15rem) minmax(0, 1fr)', gap: '0.5rem', alignItems: 'center' }}>
                <Link href={`${dateiUrl(id)}#page=${i + 1}`} target="_blank">Seite {i + 1}</Link>
                <Select disabled={busy} accessibleName={`Art der Seite ${i + 1}`}
                        onChange={(e) => { const k = (e.detail.selectedOption as HTMLElement).dataset.k as Seitenart; setArten((a) => a.map((x, j) => (j === i ? k : x))); }}>
                  {ARTEN.map((a) => <Option key={a.key} data-k={a.key} selected={arten[i] === a.key}>{a.text}</Option>)}
                </Select>
                <Text className="portal-small" style={{ color: s.sicher ? undefined : 'var(--sapCriticalTextColor)', overflowWrap: 'anywhere' }}>{s.sicher ? '' : 'Bitte prüfen: '}{s.grund}</Text>
              </div>
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}
