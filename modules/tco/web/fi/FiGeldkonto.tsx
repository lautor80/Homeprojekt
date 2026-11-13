import { useEffect, useState } from 'react';
import { Bar, BusyIndicator, Button, CheckBox, DatePicker, Dialog, Input, Label, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import { F } from './typen';
import '../instandhaltung/instandhaltung.css';

/**
 * FI-Belege: Geldkonto bereits gebuchter Belege austauschen. Belege auf dem bisherigen Konto selektieren (optional nur mit
 * einem bestimmten Gegenkonto und Zeitraum), markieren und auf das neue Geldkonto umkontieren. Ohne Storno und ohne
 * Änderungsbeleg; Belege in abgeschlossenen Perioden lassen sich nicht markieren.
 */
interface Zeile { internenr: string; datum: string | null; text: string; betrag: number; gkonten: string[]; storno: boolean; geschlossen: boolean; erfasst_von: string | null }
interface Liste { konto: string; konto_name: string; zeilen: Zeile[]; gekuerzt: boolean; summe: number }

export function GeldkontoDialog({ onClose }: { onClose: (geaendert: boolean) => void }) {
  const [f, setF] = useState({ konto: '1210', gkonto: '8010', nach: '1200', von: '', bis: '' });
  const [d, setD] = useState<Liste | null>(null);
  const [wahl, setWahl] = useState<Set<string>>(new Set());
  const [bestaetigt, setBestaetigt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [geaendert, setGeaendert] = useState(false);

  async function laden() {
    if (!f.konto.trim()) return;
    setBusy(true); setError(null); setBestaetigt(false);
    try {
      const r = await api.get<Liste>(`${F}/geldkonto/kandidaten${qs({ konto: f.konto.trim(), gkonto: f.gkonto.trim(), von: f.von, bis: f.bis })}`);
      setD(r); setWahl(new Set());
    } catch (e) { setError((e as Error).message); setD(null); } finally { setBusy(false); }
  }
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const waehlbar = (d?.zeilen ?? []).filter((z) => !z.geschlossen);
  const gewaehlt = waehlbar.filter((z) => wahl.has(z.internenr));
  const summe = gewaehlt.reduce((s, z) => s + z.betrag, 0);
  const umschalten = (nr: string, an: boolean) => { const n = new Set(wahl); if (an) n.add(nr); else n.delete(nr); setWahl(n); setBestaetigt(false); };
  async function tauschen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${F}/geldkonto/tauschen`, { internenrn: gewaehlt.map((z) => z.internenr), von: d!.konto, nach: f.nach.trim() });
      toast(r.text, 7000); setGeaendert(true);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const ok = !!d && gewaehlt.length > 0 && !!f.nach.trim() && f.nach.trim() !== d.konto && bestaetigt && !busy;

  return (
    <Dialog open headerText="Geldkonto gebuchter Belege austauschen" style={{ width: 'min(72rem, 98vw)' }} onClose={() => onClose(geaendert)}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="accept" loading={busy} disabled={!ok} onClick={tauschen}>{gewaehlt.length} Beleg(e) auf Konto {f.nach || '…'} umkontieren</Button>
              <Button onClick={() => onClose(geaendert)}>Schließen</Button>
            </>} />}>
      <div className="portal-bk__form">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}><span style={{ whiteSpace: 'pre-line' }}>{error}</span></MessageStrip>}
        <MessageStrip design="Critical" hideCloseButton>
          Ausnahme vom Grundsatz „FI-Belege sind unveränderlich“: Die markierten Belege werden direkt umkontiert – ohne Storno und ohne Änderungsbeleg.
          Betrag, Datum, Text und Gegenkonto bleiben; die Bestände beider Konten ändern sich entsprechend. Abgeschlossene Perioden bleiben geschützt.
        </MessageStrip>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap' }}>
          <div><Label showColon>Bisheriges Konto</Label><br /><Input style={{ width: '7rem' }} maxlength={10} value={f.konto} onInput={(e) => setF({ ...f, konto: e.target.value })} /></div>
          <div><Label showColon>Gegenkonto (optional)</Label><br /><Input style={{ width: '7rem' }} maxlength={10} value={f.gkonto} onInput={(e) => setF({ ...f, gkonto: e.target.value })} /></div>
          <div><Label showColon>Datum von</Label><br /><DatePicker style={{ width: '9rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.von} onChange={(e) => setF({ ...f, von: e.detail.value })} /></div>
          <div><Label showColon>bis</Label><br /><DatePicker style={{ width: '9rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.bis} onChange={(e) => setF({ ...f, bis: e.detail.value })} /></div>
          <Button icon="search" disabled={busy || !f.konto.trim()} onClick={laden}>Belege suchen</Button>
          <div style={{ marginInlineStart: 'auto' }}><Label showColon required>Neues Geldkonto</Label><br /><Input style={{ width: '7rem' }} maxlength={10} value={f.nach} onInput={(e) => { setF({ ...f, nach: e.target.value }); setBestaetigt(false); }} /></div>
        </div>
        {!d ? (busy ? <BusyIndicator active /> : null) : (
          <>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <Text>{d.zeilen.length} Beleg(e) auf {d.konto} {d.konto_name}{d.gekuerzt ? ' (gekürzt auf 5.000)' : ''} · Summe {eur(d.summe)} · markiert: {gewaehlt.length} ({eur(summe)})</Text>
              <Button design="Transparent" disabled={!waehlbar.length} onClick={() => { setWahl(new Set(waehlbar.map((z) => z.internenr))); setBestaetigt(false); }}>alle markieren</Button>
              <Button design="Transparent" disabled={!wahl.size} onClick={() => { setWahl(new Set()); setBestaetigt(false); }}>keine</Button>
            </div>
            <div className="portal-ih__rahmen" style={{ maxHeight: '46vh', overflowY: 'auto' }}><table className="portal-ih__tabelle">
              <thead><tr><th>✓</th><th>Datum</th><th>Beleg</th><th>Buchungstext</th><th>Gegenkonto</th><th style={{ textAlign: 'right' }}>Betrag</th><th>erfasst von</th><th /></tr></thead>
              <tbody>
                {!d.zeilen.length && <tr><td colSpan={8} className="portal-muted">Keine Belege zu dieser Auswahl.</td></tr>}
                {d.zeilen.map((z) => (
                  <tr key={z.internenr} className={z.geschlossen ? 'portal-ih__inaktiv' : undefined}>
                    <td><CheckBox checked={wahl.has(z.internenr)} disabled={z.geschlossen} onChange={(e) => umschalten(z.internenr, e.target.checked)} /></td>
                    <td>{dat(z.datum)}</td><td>{z.internenr}</td><td>{z.text}</td><td>{z.gkonten.join(', ')}</td>
                    <td style={{ textAlign: 'right' }}>{eur(z.betrag)}</td><td>{z.erfasst_von ?? ''}</td>
                    <td>{z.geschlossen ? <ObjectStatus state="Critical">Periode abgeschlossen</ObjectStatus> : z.storno ? <span className="portal-muted">Storno – Gegenstück wird mit getauscht</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <CheckBox wrappingType="Normal" checked={bestaetigt} disabled={!gewaehlt.length} onChange={(e) => setBestaetigt(e.target.checked)}
                      text={`Ich habe die Auswahl geprüft: ${gewaehlt.length} Beleg(e) über ${eur(summe)} von Konto ${d.konto} auf Konto ${f.nach || '…'} umkontieren.`} />
          </>
        )}
      </div>
    </Dialog>
  );
}
