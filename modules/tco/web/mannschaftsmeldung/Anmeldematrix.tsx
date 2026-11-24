import { useEffect, useState } from 'react';
import { Bar, BusyIndicator, Button, CheckBox, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import './mannschaftsmeldung.css';

/**
 * Sport → Anmeldematrix: Abfragen der Mannschaftsmeldung anlegen (Titel, Saison, Frist, Hinweis, Mannschaften aus den
 * Mitgliedergruppen), öffnen und schließen. Die Matrix zeigt je Person (Mitglieder der gewählten Gruppen und alle mit
 * Angabe) und Mannschaft 1 = fest, 2 = Ersatz, 3 = nicht; unten die Summen je Mannschaft. Zellen von Mannschaften, deren
 * Gruppe die Person nicht zugeordnet ist, sind ausgegraut (dort kann sie nicht gemeldet werden; „ohne Angabe“ zählt sie
 * nicht mit). Mit Pflegerecht lässt sich jede mögliche Zelle ändern (z. B. Angaben auf Papier), auch nach der Frist. CSV für Excel.
 */
type Wahl = 1 | 2 | 3;
type Status = 'entwurf' | 'offen' | 'geschlossen';
interface AbfrageKopf { id: number; titel: string; saison: string; frist: string | null; hinweis: string; status: Status; mannschaften: number; personen: number }
interface Mannschaft { gruppe_id: number; name: string; pfad: string }
interface Zeile { adrnr: string; name: string; geburtsjahr: number | null; geschlecht: string; inGruppe: boolean; moeglich: number[]; wahl: Record<number, Wahl | undefined>; bemerkung: string; geaendert: string | null }
interface Matrix {
  abfrage: Omit<AbfrageKopf, 'mannschaften' | 'personen'>; mannschaften: Mannschaft[]; zeilen: Zeile[];
  summen: { gruppe_id: number; fest: number; ersatz: number; nicht: number; offen: number }[];
  anzahl: { personen: number; mitRueckmeldung: number };
}
interface GruppeWahl { id: number; name: string; pfad: string; ebene: number; regel: string | null; blatt: boolean; vorschlag: boolean }

const M = `${TCO}/mannschaftsmeldung`;
const STATUS: Record<Status, { text: string; state: 'None' | 'Positive' | 'Critical' | 'Information' }> = {
  entwurf: { text: 'Entwurf (für Mitglieder unsichtbar)', state: 'None' }, offen: { text: 'offen', state: 'Positive' }, geschlossen: { text: 'geschlossen', state: 'Critical' },
};
function naechsteSaison() {
  const d = new Date(), j = d.getFullYear(), m = d.getMonth() + 1;
  return m >= 4 && m <= 9 ? `Winter ${j}/${String(j + 1).slice(2)}` : `Sommer ${m >= 10 ? j + 1 : j}`;
}

function AbfrageDialog({ alt, onClose, onDone }: { alt: AbfrageKopf | null; onClose: () => void; onDone: (id: number) => void }) {
  const [gruppen, setGruppen] = useState<GruppeWahl[] | null>(null);
  const [f, setF] = useState({ titel: alt?.titel ?? `Mannschaftsmeldung ${naechsteSaison()}`, saison: alt?.saison ?? naechsteSaison(), frist: alt?.frist ?? '', hinweis: alt?.hinweis ?? '', status: alt?.status ?? 'entwurf' as Status });
  const [wahl, setWahl] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const g = await api.get<GruppeWahl[]>(`${M}/gruppen`);
        setGruppen(g);
        if (alt) setWahl(new Set((await api.get<Matrix>(`${M}/abfragen/${alt.id}`)).mannschaften.map((m) => m.gruppe_id)));
        else setWahl(new Set(g.filter((x) => x.vorschlag).map((x) => x.id)));
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  async function sichern() {
    if (!gruppen) return;
    setBusy(true); setError(null);
    try {
      const body = { ...f, frist: f.frist || null, gruppen: gruppen.filter((g) => wahl.has(g.id)).map((g) => g.id) };
      const r = alt ? await api.put<{ id: number; text: string }>(`${M}/abfragen/${alt.id}`, body) : await api.post<{ id: number; text: string }>(`${M}/abfragen`, body);
      toast(r.text, 6000); onDone(r.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText={alt ? 'Abfrage bearbeiten' : 'Neue Mannschaftsmeldung'} onClose={onClose} style={{ width: 'min(48rem, 96vw)' }}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={busy || !gruppen || !f.titel.trim()} onClick={sichern}>Sichern</Button>
              <Button design="Transparent" onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      <div className="portal-mm__felder">
        <div><Label for="mm-titel" showColon required>Titel</Label><Input id="mm-titel" value={f.titel} maxlength={120} onInput={(e) => setF({ ...f, titel: e.target.value })} /></div>
        <div><Label for="mm-saison" showColon>Saison</Label><Input id="mm-saison" value={f.saison} maxlength={40} onInput={(e) => setF({ ...f, saison: e.target.value })} /></div>
        <div><Label for="mm-frist" showColon>Rückmeldung bis</Label>
          <input id="mm-frist" type="date" className="portal-mm__feld" value={f.frist} onChange={(e) => setF({ ...f, frist: e.target.value })} /></div>
        <div><Label showColon>Status</Label>
          <Select accessibleName="Status" onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.s as Status })}>
            {(Object.keys(STATUS) as Status[]).map((s) => <Option key={s} data-s={s} selected={f.status === s}>{STATUS[s].text}</Option>)}
          </Select></div>
      </div>
      <Label for="mm-hinweis" showColon>Hinweis an die Mitglieder</Label>
      <TextArea id="mm-hinweis" rows={3} value={f.hinweis} maxlength={2000} placeholder="z. B. Termine der Spieltage, Ansprechpartner, Hinweis zu Jugend/Aktiven"
                onInput={(e) => setF({ ...f, hinweis: e.target.value })} style={{ width: '100%', marginBottom: '0.75rem' }} />
      <Label showColon>Mannschaften (Altersklassen) aus den Mitgliedergruppen – alle Mitglieder sehen alle gewählten</Label>
      {!gruppen ? <BusyIndicator active size="S" /> : (
        <div className="portal-mm__gruppen">
          {gruppen.map((g) => (
            <div key={g.id} style={{ paddingLeft: `${g.ebene * 1.25}rem` }}>
              <CheckBox text={g.name} checked={wahl.has(g.id)} accessibleName={g.pfad}
                        onChange={(e) => { const n = new Set(wahl); if (e.target.checked) n.add(g.id); else n.delete(g.id); setWahl(n); }} />
              {g.regel && <span className="portal-muted portal-small">{g.regel}</span>}
            </div>
          ))}
        </div>
      )}
      <Text className="portal-muted portal-small">{wahl.size} ausgewählt · Reihenfolge wie im Gruppenbaum{alt ? ' · Abgewählte Mannschaften verlieren ihre Angaben.' : ''}</Text>
    </Dialog>
  );
}

export function Anmeldematrix() {
  const edit = useCan()('tco.anmeldematrix:edit');
  const [liste, setListe] = useState<AbfrageKopf[] | null>(null);
  const [akt, setAkt] = useState<number | null>(null);
  const [m, setM] = useState<Matrix | null>(null);
  const [nurMit, setNurMit] = useState(false);
  const [suche, setSuche] = useState('');
  const [dialog, setDialog] = useState<'neu' | 'bearbeiten' | null>(null);
  const [loeschen, setLoeschen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listeLaden = async (wahl?: number) => {
    const l = await api.get<AbfrageKopf[]>(`${M}/abfragen`);
    setListe(l);
    setAkt(wahl ?? (l.find((x) => x.status === 'offen') ?? l[0])?.id ?? null);
  };
  useEffect(() => { listeLaden().catch((e) => setError(e.message)); }, []);
  const matrixLaden = () => (akt ? api.get<Matrix>(`${M}/abfragen/${akt}`).then(setM).catch((e) => setError(e.message)) : Promise.resolve(setM(null)));
  useEffect(() => { setM(null); matrixLaden(); }, [akt]);

  const kopf = liste?.find((x) => x.id === akt) ?? null;
  const worte = suche.toLowerCase().split(/\s+/).filter(Boolean);
  const zeilen = (m?.zeilen ?? []).filter((z) => (!nurMit || Object.keys(z.wahl).length > 0) && worte.every((w) => z.name.toLowerCase().includes(w)));

  async function zelle(z: Zeile, gruppe: number, wert: string) {
    if (!m || !akt) return;
    setBusy(true); setError(null);
    try {
      const neu = { ...z.wahl, [gruppe]: wert ? (Number(wert) as Wahl) : undefined };
      await api.post(`${M}/abfragen/${akt}/angabe`, { adrnr: z.adrnr, bemerkung: z.bemerkung, wahl: m.mannschaften.map((x) => ({ gruppe_id: x.gruppe_id, wahl: neu[x.gruppe_id] ?? null })) });
      await matrixLaden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function loeschenAusfuehren() {
    setLoeschen(false);
    if (!akt) return;
    try { const r = await api.del<{ text: string }>(`${M}/abfragen/${akt}`); toast(r.text); await listeLaden(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <AppPage title="Anmeldematrix" subtitle="Mannschaftsmeldung: je Mitglied und Mannschaft 1 = fest, 2 = Ersatz, 3 = nicht"
             actions={<>
               {edit && <Button icon="add" onClick={() => setDialog('neu')}>Neue Abfrage</Button>}
               {edit && kopf && <Button icon="edit" onClick={() => setDialog('bearbeiten')}>Bearbeiten</Button>}
               {kopf && <Button icon="excel-attachment" tooltip="Matrix als CSV für Excel" onClick={() => window.open(`${M}/abfragen/${kopf.id}/csv`, '_blank')}>CSV</Button>}
               {edit && kopf && <Button icon="delete" design="Transparent" tooltip="Abfrage löschen" onClick={() => setLoeschen(true)} />}
               {kopf && <ChangeHistoryButton objectType="MANNSCHAFTSMELDUNG" objectKey={String(kopf.id)} />}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {!liste ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : !liste.length ? (
        <MessageStrip design="Information" hideCloseButton>
          Noch keine Abfrage. {edit ? 'Mit „Neue Abfrage“ die Mannschaften (Altersklassen) aus den Mitgliedergruppen wählen, Frist setzen und auf „offen“ stellen – dann können alle Mitglieder unter Mein Bereich → Mannschaftsmeldung antworten.' : ''}
        </MessageStrip>
      ) : (
        <>
          <div className="portal-mm__leiste">
            <Select accessibleName="Abfrage" style={{ width: '22rem' }} onChange={(e) => setAkt(Number((e.detail.selectedOption as HTMLElement).dataset.id))}>
              {liste.map((a) => <Option key={a.id} data-id={a.id} selected={a.id === akt}>{a.titel}</Option>)}
            </Select>
            {kopf && <ObjectStatus state={STATUS[kopf.status].state} inverted>{STATUS[kopf.status].text}</ObjectStatus>}
            {kopf?.frist && <Text>Rückmeldung bis {dat(kopf.frist)}</Text>}
            <Input placeholder="Name suchen" value={suche} showClearIcon style={{ width: '14rem' }} onInput={(e) => setSuche(e.target.value)} />
            <CheckBox text="nur mit Angabe" checked={nurMit} onChange={(e) => setNurMit(e.target.checked)} />
            <Button design="Transparent" icon="refresh" tooltip="Aktualisieren" onClick={matrixLaden} />
            {m && <Text className="portal-muted portal-small">{m.anzahl.mitRueckmeldung} von {m.anzahl.personen} Personen haben geantwortet</Text>}
          </div>
          {!m ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : !m.mannschaften.length ? (
            <MessageStrip design="Critical" hideCloseButton>Die Abfrage hat noch keine Mannschaften – über „Bearbeiten“ auswählen.</MessageStrip>
          ) : (
            <div className="portal-tabrahmen portal-mm__rahmen">
              <table className="portal-mm__matrix">
                <thead>
                  <tr>
                    <th className="portal-mm__name">Name</th>
                    {m.mannschaften.map((x) => <th key={x.gruppe_id} title={x.pfad}>{x.name}</th>)}
                    <th>Bemerkung</th>
                  </tr>
                </thead>
                <tbody>
                  {zeilen.map((z) => (
                    <tr key={z.adrnr}>
                      <td className="portal-mm__name">
                        <b>{z.name}</b>
                        <div className="portal-muted portal-small">{[z.geburtsjahr, z.geschlecht === 'W' ? 'w' : z.geschlecht === 'M' ? 'm' : '', z.inGruppe ? '' : 'nicht in den Gruppen'].filter(Boolean).join(' · ')}</div>
                      </td>
                      {m.mannschaften.map((x) => {
                        const w = z.wahl[x.gruppe_id];
                        const ok = z.moeglich.includes(x.gruppe_id);
                        // nicht zugeordnet: ausgegraut; eine trotzdem vorhandene Angabe bleibt sichtbar und lässt sich entfernen
                        if (!ok && !w) return <td key={x.gruppe_id} className="portal-mm__zelle portal-mm__zelle--aus" title={`${x.name}: nicht zugeordnet`} aria-label={`${z.name}, ${x.name}: nicht zugeordnet`} />;
                        return (
                          <td key={x.gruppe_id} className={`portal-mm__zelle${w ? ` portal-mm__zelle--${w}` : ''}${ok ? '' : ' portal-mm__zelle--aus'}`}
                              title={ok ? undefined : `${x.name}: nicht zugeordnet – Angabe nur noch entfernbar`}>
                            {edit ? (
                              <select value={w ?? ''} disabled={busy} aria-label={`${z.name}, ${x.name}`} onChange={(e) => zelle(z, x.gruppe_id, e.target.value)}>
                                <option value="">–</option>
                                {ok && <><option value="1">1 fest</option><option value="2">2 Ersatz</option><option value="3">3 nicht</option></>}
                                {!ok && w && <option value={w}>{w}</option>}
                              </select>
                            ) : (w ?? '–')}
                          </td>
                        );
                      })}
                      <td className="portal-small">{z.bemerkung}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {([['fest', '1 · fest'], ['ersatz', '2 · Ersatz'], ['nicht', '3 · nicht'], ['offen', 'ohne Angabe']] as const).map(([k, t]) => (
                    <tr key={k}>
                      <th className="portal-mm__name">{t}</th>
                      {m.summen.map((s) => <td key={s.gruppe_id} className="portal-mm__summe">{s[k]}</td>)}
                      <td />
                    </tr>
                  ))}
                </tfoot>
              </table>
              {!zeilen.length && <Text className="portal-muted" style={{ display: 'block', padding: '0.75rem 1rem' }}>Keine Personen zu dieser Auswahl.</Text>}
            </div>
          )}
        </>
      )}
      {dialog && <AbfrageDialog alt={dialog === 'bearbeiten' ? kopf : null} onClose={() => setDialog(null)}
                                onDone={(id) => { setDialog(null); listeLaden(id).then(() => matrixLaden()); }} />}
      <ConfirmDialog open={loeschen} title="Abfrage löschen" danger confirmText="Löschen"
                     text={`„${kopf?.titel ?? ''}“ mit allen Angaben der Mitglieder löschen?`} onConfirm={loeschenAusfuehren} onCancel={() => setLoeschen(false)} />
    </AppPage>
  );
}
