import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BusyIndicator, Button, Dialog, Input, Link, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { toast } from '@core/toast';
import { dat } from '../util';
import { abstimmung, TOP_STATUS_TEXT, VS, type PunktWahl, type VerlaufPunkt } from './typen';
import { FormatText } from './FormatText';

/**
 * Verlauf eines Themas über mehrere Sitzungen: Zusammenhängende Tagesordnungspunkte sind verkettet (vertagt und übernommen,
 * geparkt und wieder aufgenommen, gleichnamig fortgesetzt oder von Hand verkettet). Bei jedem Punkt steht, wie das Thema in
 * früheren Sitzungen behandelt wurde – Protokolltext, Beschlüsse, Aufgaben und Infos.
 */
const STATUS_STATE: Record<VerlaufPunkt['status'], 'Positive' | 'Critical' | 'Information'> = { ERLEDIGT: 'Positive', VERTAGT: 'Critical', OFFEN: 'Information' };

/** Eine Behandlung im Verlauf */
function VerlaufEintrag({ v, onSitzung, aktuell }: { v: VerlaufPunkt; onSitzung: (id: number) => void; aktuell?: boolean }) {
  return (
    <li className={`portal-vs__vpunkt${aktuell ? ' portal-vs__vpunkt--hier' : ''}`}>
      <div className="portal-vs__vkopf">
        {aktuell ? <b>{v.sitzung_nr}</b> : <Link onClick={() => onSitzung(v.sitzung_id)}>{v.sitzung_nr}</Link>}
        <span>{dat(v.datum)}</span>
        <ObjectStatus state={STATUS_STATE[v.status]}>{TOP_STATUS_TEXT[v.status]}</ObjectStatus>
        {v.sitzung_status !== 'FREIGEGEBEN' && <span className="portal-muted">Protokoll: {v.sitzung_status_text}</span>}
        {v.titel && <span className="portal-muted portal-vs__vtitel">„{v.titel}“{v.verantwortlich ? ` · ${v.verantwortlich}` : ''}</span>}
      </div>
      {v.text && <FormatText text={v.text} kompakt className="portal-vs__vtext" />}
      {v.eintraege.map((e) => (
        <div key={e.id} className="portal-vs__vzeile">
          <span className="portal-vs__art">{e.art === 'BESCHLUSS' ? `Beschluss ${e.nr}` : e.art === 'AUFGABE' ? 'Aufgabe' : 'Info'}</span>
          <span>
            <FormatText text={e.text} kompakt className={e.erledigt_am ? 'portal-vs__erledigt' : undefined} />
            {e.art === 'BESCHLUSS' && (abstimmung(e) || e.ergebnis) && <span className="portal-muted"> {abstimmung(e)}{e.ergebnis ? ` · ${e.ergebnis === 'ANGENOMMEN' ? 'angenommen' : 'abgelehnt'}` : ''}</span>}
            {e.art === 'AUFGABE' && <span className="portal-muted"> {[e.verantwortlich, e.faellig && `bis ${dat(e.faellig)}`, e.erledigt_am ? 'erledigt' : 'offen'].filter(Boolean).join(' · ')}</span>}
          </span>
        </div>
      ))}
      {!v.text && !v.eintraege.length && <span className="portal-muted portal-vs__klein">ohne Protokolltext</span>}
    </li>
  );
}

/** Verlauf bei einem Tagesordnungspunkt: frühere Behandlungen aufgeklappt, spätere als Hinweis */
export function TopVerlauf({ vorher, nachher, rw, onLoesen }: { vorher: VerlaufPunkt[]; nachher: VerlaufPunkt[]; rw: boolean; onLoesen: () => void }) {
  const navigate = useNavigate();
  if (!vorher.length && !nachher.length) return null;
  const zu = (id: number) => navigate(`/tco/vorstand/${id}`);
  return (
    <details className="portal-vs__verlauf" open={vorher.length > 0}>
      <summary>
        <span className="portal-vs__vsum">
          Verlauf: {vorher.length ? `bisher in ${vorher.length} Sitzung${vorher.length === 1 ? '' : 'en'}` : ''}
          {vorher.length && nachher.length ? ' · ' : ''}{nachher.length ? `später in ${nachher.length} Sitzung${nachher.length === 1 ? '' : 'en'}` : ''}
        </span>
        {rw && <Button design="Transparent" icon="disconnected" tooltip="Verkettung dieses Punkts lösen" onClick={(e) => { e.preventDefault(); onLoesen(); }} />}
      </summary>
      {vorher.length > 0 && <ol className="portal-vs__vliste">{vorher.map((v) => <VerlaufEintrag key={v.top_id} v={v} onSitzung={zu} />)}</ol>}
      {nachher.length > 0 && (
        <div className="portal-vs__klein">
          Weiter behandelt in: {nachher.map((v, i) => <span key={v.top_id}>{i ? ', ' : ''}<Link onClick={() => zu(v.sitzung_id)}>{v.sitzung_nr}</Link> ({dat(v.datum)}, {TOP_STATUS_TEXT[v.status]})</span>)}
        </div>
      )}
    </details>
  );
}

/** Verlauf eines Themas (Themenparkplatz): alle Behandlungen chronologisch */
export function ThemaVerlauf({ verlauf, onSitzung }: { verlauf: VerlaufPunkt[]; onSitzung: (id: number) => void }) {
  if (!verlauf.length) return <Text className="portal-muted">Noch in keiner Sitzung behandelt.</Text>;
  return <ol className="portal-vs__vliste">{verlauf.map((v) => <VerlaufEintrag key={v.top_id} v={v} onSitzung={onSitzung} />)}</ol>;
}

/**
 * Verketten: Punkt einer anderen Sitzung wählen (gleichnamige zuerst, dann vertagte, dann die jüngsten).
 * ziel = Tagesordnungspunkt oder Thema, das verkettet wird.
 */
export function VerkettenDialog({ ziel, onClose, onFertig }: { ziel: { top: number } | { thema: number }; onClose: () => void; onFertig: () => void }) {
  const [suche, setSuche] = useState('');
  const [punkte, setPunkte] = useState<PunktWahl[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = 'top' in ziel ? { top: ziel.top } : { thema: ziel.thema };

  useEffect(() => {
    const t = setTimeout(() => {
      api.get<{ punkte: PunktWahl[] }>(`${VS}/punkte${qs({ ...key, suche: suche.trim() || undefined })}`).then((r) => setPunkte(r.punkte)).catch((e) => setFehler(e.message));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suche, 'top' in ziel ? ziel.top : ziel.thema]);

  async function waehlen(p: PunktWahl) {
    setBusy(true); setFehler(null);
    try {
      const url = 'top' in ziel ? `${VS}/tops/${ziel.top}/verketten` : `${VS}/themen/${ziel.thema}/verketten`;
      const r = await api.post<{ text: string }>(url, { mit: p.id });
      toast(r.text);
      onFertig();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText="Mit einem früheren Punkt verketten" onClose={onClose} style={{ width: 'min(40rem, 96vw)' }}
            footer={<Bar endContent={<Button onClick={onClose}>Abbrechen</Button>} />}>
      <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.5rem' }}>
        Gehört der Punkt zu einem Thema, das schon in einer anderen Sitzung besprochen wurde, hier den Punkt dort wählen.
        Danach steht der gesamte Verlauf bei jedem Punkt des Themas.
      </Text>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <Input placeholder="Suchen (Titel oder Protokolltext) …" value={suche} onInput={(e) => setSuche(e.target.value)} style={{ width: '100%' }} />
      {!punkte ? <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /> : (
        <ul className="portal-vs__vwahl">
          {!punkte.length && <li className="portal-muted">Keine passenden Punkte.</li>}
          {punkte.map((p) => (
            <li key={p.id}>
              <Button design={p.gleichnamig ? 'Emphasized' : 'Default'} icon="connected" disabled={busy} onClick={() => waehlen(p)}>Verketten</Button>
              <span className="portal-vs__zelle2">
                <span>{p.titel}{p.gleichnamig && <ObjectStatus state="Information" style={{ marginLeft: '0.4rem' }}>gleicher Titel</ObjectStatus>}</span>
                <span className="portal-muted">{p.sitzung_nr} · {dat(p.datum)} · {TOP_STATUS_TEXT[p.status]}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
