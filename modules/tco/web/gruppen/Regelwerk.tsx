import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bar, BusyIndicator, Button, CheckBox, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { GR, type Gruppe } from './typen';
import '../halle.css';

/**
 * Regelwerk der Mitgliedergruppen (#16): Regeln ordnen Mitglieder nach Alter einer Gruppe zu
 * (z. B. Kleinfeld 6–7 Jahre). Vorschau zeigt, was sich ändern würde; „Neu berechnen“ setzt es um.
 * Ein Job kann dasselbe regelmäßig über POST …/gruppen/regeln/anwenden ausführen.
 */
type Geschlecht = '' | 'M' | 'W';
interface Regel { gruppe_id: number; alter_von: number | null; alter_bis: number | null; jahrgang: boolean; geschlecht: Geschlecht; andere_entfernen: boolean; aktiv: boolean }
interface Zeile { key: number; gruppe_id: number; von: string; bis: string; jahrgang: boolean; geschlecht: Geschlecht; andere_entfernen: boolean; aktiv: boolean }
export interface Ergebnis {
  simulation: boolean; text: string;
  gruppen: { gruppe_id: number; gruppe: string; regel: string; aufgenommen: { adrnr: string; name: string }[]; entfernt: { adrnr: string; name: string }[]; ueberUntergruppe: number; mitglieder: number }[];
}

let lfd = 0;
const zeile = (r: Regel): Zeile => ({
  key: ++lfd, gruppe_id: r.gruppe_id, von: r.alter_von == null ? '' : String(r.alter_von), bis: r.alter_bis == null ? '' : String(r.alter_bis),
  jahrgang: r.jahrgang, geschlecht: r.geschlecht ?? '', andere_entfernen: r.andere_entfernen, aktiv: r.aktiv,
});
const ganz = (v: string) => (v.trim() === '' ? null : Number(v.trim()));
const zahlFehler = (v: string) => v.trim() !== '' && !/^\d{1,3}$/.test(v.trim());
const regel = (z: Zeile): Regel => ({ gruppe_id: z.gruppe_id, alter_von: ganz(z.von), alter_bis: ganz(z.bis), jahrgang: z.jahrgang, geschlecht: z.geschlecht, andere_entfernen: z.andere_entfernen, aktiv: z.aktiv });
const klein = () => window.matchMedia?.('(max-width: 700px)').matches ?? false;

const namen = (p: { name: string }[]) => (p.length ? p.map((x) => x.name).join(', ') : '–');

/** Ergebnis von Vorschau bzw. Neuberechnung je Gruppe als Tabelle */
export function ErgebnisTabelle({ ergebnis }: { ergebnis: Ergebnis }) {
  return (
    <>
      <MessageStrip design={ergebnis.simulation ? 'Information' : 'Positive'} hideCloseButton>{ergebnis.text}</MessageStrip>
      {ergebnis.gruppen.length > 0 && (
        <div className="portal-sv__tabelle-rahmen">
          <table className="portal-sv__tabelle">
            <thead><tr><th><Label>Gruppe</Label></th><th><Label>Regel</Label></th><th><Label>{ergebnis.simulation ? 'Wird aufgenommen' : 'Aufgenommen'}</Label></th>
              <th><Label>{ergebnis.simulation ? 'Wird entfernt' : 'Entfernt'}</Label></th><th className="portal-sv__zahl"><Label>Mitglieder danach</Label></th></tr></thead>
            <tbody>
              {ergebnis.gruppen.map((g) => (
                <tr key={g.gruppe_id}>
                  <td><Text>{g.gruppe}</Text></td>
                  <td><Text>{g.regel}</Text></td>
                  <td><Text>{namen(g.aufgenommen)}</Text>{g.ueberUntergruppe > 0 && <div><Text className="portal-muted portal-small">{g.ueberUntergruppe} bereits über eine Untergruppe enthalten</Text></div>}</td>
                  <td><Text>{namen(g.entfernt)}</Text></td>
                  <td className="portal-sv__zahl"><Text>{g.mitglieder}</Text></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * „Neu berechnen“: wendet das Regelwerk sofort an – auf den ganzen Baum oder auf einen Knoten (Gruppe mit ihren
 * Untergruppen) – und zeigt je Gruppe, wer aufgenommen und wer entfernt wurde.
 */
export function BerechnenDialog({ gruppe, onClose }: { gruppe: Gruppe | null; onClose: () => void }) {
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.post<Ergebnis>(`${GR}/regeln/anwenden`, { simulation: false, ...(gruppe ? { gruppe_id: gruppe.id } : {}) }).then(setErgebnis).catch((e) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const fertig = !!ergebnis || !!error;
  return createPortal(
    <Dialog open stretch={klein()} headerText={gruppe ? `Neu berechnen – ${gruppe.pfad}` : 'Neu berechnen – alle Gruppen'} onClose={() => fertig && onClose()}
            style={klein() ? undefined : { width: 'min(64rem, 96vw)' }}
            footer={<Bar endContent={<Button design="Emphasized" disabled={!fertig} onClick={onClose}>Schließen</Button>} />}>
      <div className="portal-az">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        {!fertig && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
        {ergebnis && <ErgebnisTabelle ergebnis={ergebnis} />}
      </div>
    </Dialog>,
    document.body,
  );
}

/** Regelwerk pflegen: alle Regeln oder – mit `gruppe` – nur das Regelwerk dieser einen Gruppe */
export function RegelwerkDialog({ gruppen, gruppe, onClose }: { gruppen: Gruppe[]; gruppe?: Gruppe | null; onClose: (geaendert: boolean) => void }) {
  const [zeilen, setZeilen] = useState<Zeile[] | null>(null);
  const [gesichert, setGesichert] = useState('[]');
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [angewendet, setAngewendet] = useState(false);

  const uebernehmen = (alle: Regel[]) => { const regeln = gruppe ? alle.filter((r) => r.gruppe_id === gruppe.id) : alle; const z = regeln.map(zeile); setZeilen(z); setGesichert(JSON.stringify(z.map(regel))); };
  useEffect(() => {
    api.get<{ regeln: Regel[] }>(`${GR}/regeln`).then((r) => uebernehmen(r.regeln)).catch((e) => { setError(e.message); setZeilen([]); });
  }, []);

  const liste = zeilen ?? [];
  const geaendert = JSON.stringify(liste.map(regel)) !== gesichert;
  const fehler = liste.some((z) => !z.gruppe_id || zahlFehler(z.von) || zahlFehler(z.bis) || (z.von.trim() === '' && z.bis.trim() === '')
    || (z.von.trim() !== '' && z.bis.trim() !== '' && Number(z.von) > Number(z.bis)));
  const setze = (key: number, x: Partial<Zeile>) => { setZeilen((l) => (l ?? []).map((z) => (z.key === key ? { ...z, ...x } : z))); setErgebnis(null); };

  async function lauf(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const sichern = () => lauf(async () => {
    const r = await api.put<{ regeln: Regel[] }>(`${GR}/regeln`, { regeln: liste.map(regel), ...(gruppe ? { gruppe_id: gruppe.id } : {}) });
    uebernehmen(r.regeln); setErgebnis(null); setAngewendet(true);
  });
  const anwenden = (simulation: boolean) => lauf(async () => {
    setErgebnis(await api.post<Ergebnis>(`${GR}/regeln/anwenden`, { simulation, ...(gruppe ? { gruppe_id: gruppe.id } : {}) }));
    if (!simulation) setAngewendet(true);
  });

  return createPortal(
    <Dialog open stretch={klein()} headerText={gruppe ? `Regelwerk – ${gruppe.pfad}` : 'Regelwerk der Mitgliedergruppen'} onClose={() => !busy && onClose(angewendet)} className="portal-az__dialog"
            style={klein() ? undefined : { width: 'min(72rem, 96vw)', height: '88vh' }}
            footer={<Bar startContent={geaendert ? <ObjectStatus state="Critical">Änderungen noch nicht gesichert</ObjectStatus> : undefined}
                         endContent={<>
                           <Button design="Emphasized" disabled={busy || !geaendert || fehler} onClick={sichern}>Regeln sichern</Button>
                           <Button icon="show" disabled={busy || geaendert || !liste.length} tooltip="Zeigt, was sich ändern würde – ohne etwas zu ändern" onClick={() => anwenden(true)}>Vorschau</Button>
                           <Button icon="synchronize" disabled={busy || geaendert || !liste.length} onClick={() => anwenden(false)}>Neu berechnen</Button>
                           <Button disabled={busy} onClick={() => onClose(angewendet)}>Schließen</Button>
                         </>} />}>
      <div className="portal-az">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        <MessageStrip design="Information" hideCloseButton>
          Jede Regel ordnet aktive Mitglieder nach Alter und Geschlecht einer Gruppe zu, z. B. Kleinfeld 6–7 Jahre oder Juniorinnen U15 weiblich. Beim Neuberechnen werden passende Mitglieder
          aufgenommen. Zuordnungen aus dem Regelwerk, die nicht mehr passen, entfallen. Von Hand Zugeordnete bleiben, außer bei „Andere entfernen“.
        </MessageStrip>
        {!zeilen && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
        {zeilen && (
          <div className="portal-sv__tabelle-rahmen">
            <table className="portal-sv__tabelle">
              <thead>
                <tr>
                  {!gruppe && <th><Label>Gruppe</Label></th>}<th><Label>Geschlecht</Label></th><th><Label>Alter von</Label></th><th><Label>Alter bis</Label></th>
                  <th><Label>Kalenderjahr zählt</Label></th><th><Label>Andere entfernen</Label></th><th><Label>Aktiv</Label></th><th />
                </tr>
              </thead>
              <tbody>
                {liste.map((z) => (
                  <tr key={z.key}>
                    {!gruppe && <td>
                      <Select accessibleName="Gruppe" valueState={z.gruppe_id ? 'None' : 'Negative'} style={{ width: 'min(24rem, 100%)', minWidth: '14rem' }}
                              onChange={(e) => setze(z.key, { gruppe_id: Number((e.detail.selectedOption as HTMLElement).dataset.g) || 0 })}>
                        <Option data-g="0" selected={!z.gruppe_id}>Gruppe wählen …</Option>
                        {gruppen.map((g) => <Option key={g.id} data-g={g.id} selected={g.id === z.gruppe_id}>{g.pfad}</Option>)}
                      </Select>
                    </td>}
                    <td>
                      <Select accessibleName="Geschlecht" style={{ width: '11rem' }} onChange={(e) => setze(z.key, { geschlecht: ((e.detail.selectedOption as HTMLElement).dataset.s ?? '') as Geschlecht })}>
                        <Option data-s="" selected={!z.geschlecht}>alle (gemischt)</Option>
                        <Option data-s="M" selected={z.geschlecht === 'M'}>männlich</Option>
                        <Option data-s="W" selected={z.geschlecht === 'W'}>weiblich</Option>
                      </Select>
                    </td>
                    <td><Input value={z.von} accessibleName="Alter von" valueState={zahlFehler(z.von) ? 'Negative' : 'None'} style={{ width: '5.5rem' }} onInput={(e) => setze(z.key, { von: e.target.value })} /></td>
                    <td><Input value={z.bis} accessibleName="Alter bis" valueState={zahlFehler(z.bis) ? 'Negative' : 'None'} style={{ width: '5.5rem' }} onInput={(e) => setze(z.key, { bis: e.target.value })} /></td>
                    <td><CheckBox checked={z.jahrgang} accessibleName="Kalenderjahr zählt" onChange={(e) => setze(z.key, { jahrgang: e.target.checked })} /></td>
                    <td><CheckBox checked={z.andere_entfernen} accessibleName="Andere entfernen" onChange={(e) => setze(z.key, { andere_entfernen: e.target.checked })} /></td>
                    <td><CheckBox checked={z.aktiv} accessibleName="Aktiv" onChange={(e) => setze(z.key, { aktiv: e.target.checked })} /></td>
                    <td><Button icon="delete" design="Transparent" tooltip="Regel löschen" onClick={() => { setZeilen(liste.filter((x) => x.key !== z.key)); setErgebnis(null); }} /></td>
                  </tr>
                ))}
                {!liste.length && <tr><td colSpan={8}><Text className="portal-muted">{gruppe ? 'Noch keine Regel für diese Gruppe – z. B. Alter 6 bis 7.' : 'Noch keine Regel – z. B. Gruppe „Kleinfeld“, Alter 6 bis 7.'}</Text></td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div>
          <Button icon="add" design="Transparent" disabled={!zeilen}
                  onClick={() => { setZeilen([...liste, { key: ++lfd, gruppe_id: gruppe?.id ?? 0, von: '', bis: '', jahrgang: false, geschlecht: '', andere_entfernen: false, aktiv: true }]); setErgebnis(null); }}>Regel hinzufügen</Button>
        </div>
        <Text className="portal-muted portal-small">
          <b>Geschlecht:</b> „alle (gemischt)“ nimmt jedes Geschlecht auf, z. B. für gemischte Mannschaften. Bei „männlich“ oder „weiblich“ passen nur Mitglieder,
          bei denen dieses Geschlecht im Mitgliedsstamm gepflegt ist.{' '}
          <b>Kalenderjahr zählt:</b> Das ganze Jahr zählt, in dem das Alter erreicht wird oder noch erreicht war. Bei 6–7 Jahren: Wer im Dezember 6 wird,
          gehört ab Januar dazu. Wer im März 8 wird, bleibt bis Jahresende. Ohne das Kennzeichen gilt das Alter am Tag der Ausführung.{' '}
          <b>Andere entfernen:</b> Auch von Hand oder selbst Zugeordnete, die nicht zur Regel passen, werden entfernt.{' '}
          <b>Job:</b> Für die regelmäßige Ausführung ruft ein Job (z. B. n8n, täglich) <code>POST /api/m/tco/gruppen/regeln/anwenden</code> mit einem
          API-Schlüssel mit der Berechtigung <code>tco.gruppen:edit</code> auf.
        </Text>

        {ergebnis && <ErgebnisTabelle ergebnis={ergebnis} />}
      </div>
    </Dialog>,
    document.body,
  );
}
