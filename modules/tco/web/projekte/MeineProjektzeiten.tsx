import { useEffect, useState } from 'react';
import { BusyIndicator, Button, DatePicker, Input, MessageStrip, ObjectStatus, Option, Select, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import { ZEIT_STATE, type Zeit } from './Projektplanung';
import '../haushalt/haushalt.css';

/**
 * Meine Daten → Meine Zeiten → Projekt: eigene, unbezahlte Arbeitsstunden auf ein Projekt melden. Der Server ermittelt
 * das Mitglied aus dem angemeldeten Benutzer; zur Auswahl stehen nur genehmigte und laufende Projekte, in denen man
 * eingeplant ist (oder die für alle offen sind). Der Projektverantwortliche bestätigt die Stunden.
 */
const MZ = `${TCO}/projekte/meine-zeiten`;
interface Daten {
  mitglied: { adrnr: string; name: string } | null; hinweis: string | null; zeiten: Zeit[];
  projekte: { id: number; bezeichnung: string; eingeplant: boolean; vorgaenge: { id: number; nr: number; bezeichnung: string }[] }[];
}
const std = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
const heute = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function MeineProjektzeiten() {
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ projekt: 0, vorgang: 0, datum: heute(), stunden: '2', taetigkeit: '' });
  useEffect(() => { api.get<Daten>(MZ).then(setD).catch((e) => setError((e as Error).message)); }, []);

  async function tun(fn: () => Promise<Daten & { text?: string }>, danach?: () => void) {
    setBusy(true); setError(null);
    try { const r = await fn(); if (r.text) toast(r.text, 4000); setD(r); danach?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!d) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  const projekt = d.projekte.find((p) => p.id === f.projekt) ?? d.projekte[0] ?? null;
  const bestaetigt = d.zeiten.filter((z) => z.status === 'BESTAETIGT').reduce((s, z) => s + z.stunden, 0);

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Section title="Stunden auf ein Projekt melden">
        {d.hinweis ? <Text className="portal-muted">{d.hinweis}</Text>
          : !projekt ? <Text className="portal-muted">Sie sind in keinem laufenden Projekt eingeplant. Wer mitarbeiten möchte, meldet sich beim Projektverantwortlichen – er plant Sie ein, dann können Sie hier Ihre Stunden melden.</Text>
            : (
              <>
                <div className="hh-leiste" style={{ paddingBottom: '0.5rem' }}>
                  <label className="hh-feld"><span>Datum</span><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.datum} maxDate={heute()} onChange={(e) => setF({ ...f, datum: e.detail.value })} /></label>
                  <label className="hh-feld" style={{ flex: '1 1 12rem' }}><span>Projekt</span>
                    <Select onChange={(e) => setF({ ...f, projekt: Number((e.detail.selectedOption as HTMLElement).dataset.p), vorgang: 0 })}>
                      {d.projekte.map((p) => <Option key={p.id} data-p={p.id} selected={p.id === projekt.id}>{p.bezeichnung}{p.eingeplant ? '' : ' (offen für alle)'}</Option>)}
                    </Select></label>
                  {projekt.vorgaenge.length > 0 && (
                    <label className="hh-feld" style={{ flex: '1 1 12rem' }}><span>Vorgang</span>
                      <Select onChange={(e) => setF({ ...f, vorgang: Number((e.detail.selectedOption as HTMLElement).dataset.v ?? 0) })}>
                        <Option data-v="0" selected={!f.vorgang}>– ohne –</Option>
                        {projekt.vorgaenge.map((v) => <Option key={v.id} data-v={v.id} selected={f.vorgang === v.id}>{v.nr}. {v.bezeichnung}</Option>)}
                      </Select></label>
                  )}
                  <label className="hh-feld"><span>Stunden</span><Input style={{ width: '6rem' }} value={f.stunden} accessibleName="Stunden" onInput={(e) => setF({ ...f, stunden: e.target.value })} /></label>
                  <label className="hh-feld" style={{ flex: '2 1 14rem' }}><span>Tätigkeit</span><Input style={{ width: '100%' }} value={f.taetigkeit} maxlength={300} placeholder="Was wurde gemacht?" onInput={(e) => setF({ ...f, taetigkeit: e.target.value })} /></label>
                  <Button design="Emphasized" icon="accept" disabled={busy || !f.stunden.trim() || !f.datum}
                          onClick={() => tun(() => api.post<Daten & { text: string }>(MZ, { projekt_id: projekt.id, vorgang_id: f.vorgang || null, datum: f.datum, stunden: f.stunden, taetigkeit: f.taetigkeit }), () => setF({ ...f, taetigkeit: '' }))}>Melden</Button>
                </div>
                <Text className="portal-muted">Die Stunden sind unbezahlt und zählen nach der Bestätigung durch den Projektverantwortlichen als Eigenleistung des Projekts. Mit Trainingszeiten haben sie nichts zu tun.</Text>
              </>
            )}
      </Section>
      <Section title="Meine Projektstunden" count={d.zeiten.length} flush>
        {d.zeiten.length === 0 ? <Empty>Noch keine Stunden gemeldet.</Empty> : (
          <div className="hh-roll">
            <table className="hh-tab">
              <thead><tr><th>Datum</th><th>Projekt</th><th>Vorgang</th><th className="z">Stunden</th><th>Tätigkeit</th><th>Status</th><th /></tr></thead>
              <tbody>
                {d.zeiten.map((z) => (
                  <tr key={z.id}>
                    <td>{dat(z.datum)}</td><td>{z.projekt}</td><td>{z.vorgang ?? '–'}</td><td className="z">{std(z.stunden)}</td>
                    <td className="name">{z.taetigkeit ?? ''}{z.grund && <small>Begründung: {z.grund}</small>}</td>
                    <td><ObjectStatus state={ZEIT_STATE[z.status]}>{z.status_text}</ObjectStatus></td>
                    <td>{z.status !== 'BESTAETIGT' && <Button design="Transparent" icon="delete" tooltip="Meldung zurückziehen" accessibleName="Meldung zurückziehen" disabled={busy}
                                                           onClick={() => tun(() => api.post<Daten & { text: string }>(`${MZ}/${z.id}/loeschen`))} />}</td>
                  </tr>
                ))}
                <tr className="hh-summe"><td colSpan={3}>Summe · davon bestätigt {std(bestaetigt)}</td><td className="z">{std(d.zeiten.reduce((s, z) => s + z.stunden, 0))}</td><td colSpan={3} /></tr>
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
