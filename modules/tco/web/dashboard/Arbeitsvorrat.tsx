import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BusyIndicator, Button, Dialog, Input, Label, MessageStrip, Text } from '@ui5/webcomponents-react';
import { toast } from '@core/toast';
import { TCO } from '../util';
import { api } from '@core/api';
import { Section } from '@core/components/Section';
import { DASH } from './typen';
import { aufgabenGesehen } from '@core/arbeitsvorratGesehen';
import { ArbeitsvorratBaum, type Aufgabe, type AufgabenZusatz } from '@core/components/Arbeitsvorrat';
import { MitgliedWahl } from '../fi/FiUeberweisung';

const dat = (iso: string) => iso.split('-').reverse().join('.');

/**
 * Arbeitsvorrat der Vereinsübersicht (Ausschnitt TC Oberthal; alle Anwendungen zeigt die Startseite, #232 V2): offene Vorgänge (z. B. freigegebene Zeitnachweise der Trainer,
 * Registrierungen). Ein Klick öffnet die App, in der der Vorgang erledigt wird. Ohne Einträge unsichtbar.
 * Baumdarstellung: oberste Ebene je Rolle (Jugendwart, Kassenwart, Vorstand, Hallenwart, …) mit Anzahl, aufklappbar; der Zustand
 * (auf/zu) bleibt im Browser gespeichert. Einträge mit Unterpunkten (z. B. die einzelnen Hallenbuchungen von heute) klappen ihre
 * Details auf; der Pfeil rechts springt in die App, aus der der Hinweis stammt.
 */
export function Arbeitsvorrat({ neu, leerText }: { neu: number; leerText?: string }) {
  const [liste, setListe] = useState<Aufgabe[]>([]);
  const navigate = useNavigate();
  // was hier angezeigt wird, gilt als gesehen – der Hinweis „n neu“ am Menüeintrag verschwindet
  const laden = useCallback(() => api.get<Aufgabe[]>(`${DASH}/arbeitsvorrat`).then((l) => { setListe(l); aufgabenGesehen(l); }).catch(() => setListe([])), []);
  // immer aktuell: beim Öffnen, nach jeder Bestätigung, jede Minute und wenn das Fenster wieder nach vorn kommt
  useEffect(() => {
    laden();
    const t = setInterval(laden, 60_000);
    const sichtbar = () => { if (document.visibilityState === 'visible') laden(); };
    document.addEventListener('visibilitychange', sichtbar);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', sichtbar); };
  }, [neu, laden]);
  /** Kästchen am Eintrag: Erledigung bestätigen und die Übersicht sofort neu aufbauen */
  const erledigen = async (a: Aufgabe) => {
    if (!a.erledigen) return;
    setListe((l) => l.filter((x) => x.key !== a.key)); // sofort ausblenden, dann vom Server neu lesen
    try { const r = await api.post<{ text?: string }>(`${TCO}${a.erledigen.url}`, a.erledigen.body); toast(r.text ?? 'Erledigt.'); } catch (e) { toast((e as Error).message, 6000); }
    await laden();
  };
  if (!liste.length) {
    return leerText ? <Section title="Arbeitsvorrat" count={0}><span className="portal-muted">{leerText}</span></Section> : null;
  }
  return <ArbeitsvorratBaum liste={liste} onOeffnen={(a) => navigate(a.pfad)} onErledigen={erledigen} zusatz={zahlungZusatz} />;
}

/** Knopf „Zahlungsdaten“ am Eintrag „Überweisung an Einreicher“ – auch auf der Startseite (WebModule.arbeitsvorratZusatz) */
function ZahlungKnopf({ id, onUeberwiesen }: { id: number; onUeberwiesen?: () => void }) {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <Button design="Transparent" icon="qr-code" tooltip="Zahlungsdaten und QR-Code für die Banking-App" onClick={() => setOffen(true)}>Zahlungsdaten</Button>
      {offen && <ZahlungDialog id={id} onClose={() => setOffen(false)} onUeberwiesen={onUeberwiesen ? () => { setOffen(false); onUeberwiesen(); } : undefined} />}
    </>
  );
}
export const zahlungZusatz: AufgabenZusatz = (a, erledigt) => (a.zahlung ? <ZahlungKnopf id={a.zahlung.id} onUeberwiesen={a.erledigen ? erledigt : undefined} /> : null);

interface Zahlung {
  id: number; titel: string; einreicher: string; dok_id: number | null; am: string; adrnr: string | null; empfaenger: string | null; iban: string | null; iban_text: string | null;
  bic: string | null; bank: string | null; betrag: number | null; zweck: string; qr: string | null; epc: string | null; hinweis: string | null;
}

/**
 * Zahlungsdaten zu einem Beleg „Überweisung an Einreicher“: Empfänger und Bankverbindung aus dem Mitgliederstamm, Betrag und
 * Verwendungszweck zum Eintragen, dazu der QR-Code (GiroCode) zum Scannen mit der Banking-App.
 */
function ZahlungDialog({ id, onClose, onUeberwiesen }: { id: number; onClose: () => void; onUeberwiesen?: () => void }) {
  const [d, setD] = useState<Zahlung | null>(null);
  const [betrag, setBetrag] = useState('');
  const [zweck, setZweck] = useState<string | null>(null);
  const [adrnr, setAdrnr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Betrag und Verwendungszweck gehen in den QR-Code: kurz nach der Eingabe neu erzeugen
  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams();
      if (betrag.trim()) q.set('betrag', betrag.trim());
      if (zweck !== null) q.set('zweck', zweck);
      if (adrnr) q.set('adrnr', adrnr);
      api.get<Zahlung>(`${DASH}/arbeitsvorrat/upload-zahlung/${id}${q.size ? `?${q}` : ''}`).then((r) => { setD(r); setError(null); }).catch((e) => setError((e as Error).message));
    }, d ? 400 : 0);
    return () => clearTimeout(t);
  }, [id, betrag, zweck, adrnr]); // eslint-disable-line react-hooks/exhaustive-deps
  const kopieren = (text: string, was: string) => navigator.clipboard?.writeText(text).then(() => toast(`${was} kopiert.`)).catch(() => undefined);
  const zeile = (label: string, wert: string | null, kopie?: string) => (
    <>
      <Label showColon>{label}</Label>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', minWidth: 0 }}>
        <Text style={{ wordBreak: 'break-word' }}>{wert || '–'}</Text>
        {wert && <Button design="Transparent" icon="copy" tooltip={`${label} kopieren`} onClick={() => kopieren(kopie ?? wert, label)} />}
      </span>
    </>
  );
  return (
    <Dialog open headerText="Zahlungsdaten" style={{ width: 'min(34rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              {onUeberwiesen && <Button design="Emphasized" icon="accept" onClick={onUeberwiesen}>Überwiesen</Button>}
              <Button onClick={onClose}>Schließen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!d ? (error ? null : <BusyIndicator active style={{ display: 'block' }} />) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Text>{d.titel} · eingereicht von {d.einreicher} am {dat(d.am)}{d.dok_id ? ` · Paperless-Dokument ${d.dok_id}` : ''}</Text>
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 0.75rem', alignItems: 'center' }}>
            <Label showColon>Mitglied</Label>
            <MitgliedWahl wert={adrnr ?? d.adrnr} name={d.empfaenger} onWaehle={setAdrnr} />
            {zeile('Empfänger', d.empfaenger)}
            {zeile('IBAN', d.iban_text, d.iban ?? undefined)}
            {zeile('BIC', d.bic)}
            {d.bank ? zeile('Bank', d.bank) : null}
            <Label showColon>Betrag (Euro)</Label>
            <Input style={{ width: '10rem' }} placeholder="z. B. 49,90" value={betrag} onInput={(e) => setBetrag(e.target.value)} />
            <Label showColon>Verwendungszweck</Label>
            <Input maxlength={140} value={zweck ?? d.zweck} onInput={(e) => setZweck(e.target.value)} />
          </div>
          {d.hinweis && <MessageStrip design={d.qr ? 'Information' : 'Critical'} hideCloseButton>{d.hinweis}</MessageStrip>}
          {d.qr && (
            <div style={{ textAlign: 'center' }}>
              <img src={d.qr} alt="QR-Code für die Überweisung (GiroCode)" style={{ width: 'min(16rem, 70vw)', height: 'auto', background: '#fff', padding: '0.5rem', borderRadius: '0.5rem' }} />
              <div className="portal-muted portal-small">In der Banking-App „Fotoüberweisung“ bzw. „QR-Code scannen“ wählen – Empfänger, IBAN{d.betrag != null ? ', Betrag' : ''} und Verwendungszweck werden übernommen.</div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
