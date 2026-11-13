import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BusyIndicator, Button, CheckBox, Dialog, Icon, Input, Label, MessageStrip, Text } from '@ui5/webcomponents-react';
import { toast } from '@core/toast';
import { TCO } from '../util';
import { api } from '@core/api';
import { Section } from '@core/components/Section';
import { DASH } from './typen';
import { aufgabenGesehen } from './AufgabenWaechter';
import { MitgliedWahl } from '../fi/FiUeberweisung';

export interface Aufgabe {
  key: string; bereich: string; titel: string; text: string; datum: string | null; icon: string;
  state: 'Information' | 'Critical' | 'Negative'; pfad: string; betrag?: number;
  /** Kästchen: Erledigung bestätigen, danach verschwindet der Eintrag */
  erledigen?: { text: string; url: string; body: Record<string, unknown> };
  /** Upload „Überweisung an Einreicher“: Zahlungsdaten und QR-Code im Popup */
  zahlung?: { id: number };
  /** Unterpunkte, z. B. die einzelnen Buchungen */
  kinder?: Aufgabe[];
}

const dat = (iso: string) => iso.split('-').reverse().join('.');
const RANG = { Negative: 3, Critical: 2, Information: 1 } as const;
const OFFEN_KEY = 'tco.arbeitsvorrat.offen';
function offenLesen(): string[] | null {
  try { const v = localStorage.getItem(OFFEN_KEY); return v ? JSON.parse(v) as string[] : null; } catch { return null; }
}

/**
 * Arbeitsvorrat der Vereinsübersicht: offene Vorgänge (z. B. freigegebene Zeitnachweise der Trainer,
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
  return <Baum liste={liste} onOeffnen={(a) => navigate(a.pfad)} onErledigen={erledigen} />;
}

function Eintrag({ a, onOeffnen, onErledigen, ebene = 1 }: { a: Aufgabe; onOeffnen: (a: Aufgabe) => void; onErledigen: (a: Aufgabe) => void; ebene?: number }) {
  const [auf, setAuf] = useState(false);
  const [zahlung, setZahlung] = useState(false);
  const kinder = a.kinder ?? [];
  return (
    <>
      <div className={`portal-av__eintrag portal-av__eintrag--kind portal-av__eintrag--${a.state}`} style={{ paddingLeft: `${1 + ebene * 1.25}rem` }}>
        {kinder.length
          ? <button type="button" className="portal-av__auf" aria-label={auf ? 'Details einklappen' : 'Details aufklappen'} aria-expanded={auf} onClick={() => setAuf(!auf)}>
              <Icon name={auf ? 'navigation-down-arrow' : 'navigation-right-arrow'} />
            </button>
          : <Icon name={a.icon} className="portal-av__icon" />}
        <button type="button" className="portal-av__inhalt portal-av__sprung" onClick={() => (kinder.length ? setAuf(!auf) : onOeffnen(a))}>
          <div className="portal-av__titel">{a.titel}</div>
          <div className="portal-av__text">{a.text}</div>
        </button>
        <div className="portal-av__datum">
          {a.zahlung && <Button design="Transparent" icon="qr-code" tooltip="Zahlungsdaten und QR-Code für die Banking-App" onClick={() => setZahlung(true)}>Zahlungsdaten</Button>}
          {a.erledigen ? <CheckBox text={a.erledigen.text} onChange={(e) => { if (e.target.checked) onErledigen(a); }} /> : a.datum ? dat(a.datum) : ''}
        </div>
        <button type="button" className="portal-av__auf" aria-label="App öffnen" title="App öffnen" onClick={() => onOeffnen(a)}>
          <Icon name="navigation-right-arrow" className="portal-av__pfeil" />
        </button>
      </div>
      {zahlung && a.zahlung && <ZahlungDialog id={a.zahlung.id} onClose={() => setZahlung(false)} onUeberwiesen={a.erledigen ? () => { setZahlung(false); onErledigen(a); } : undefined} />}
      {auf && kinder.map((k) => <Eintrag key={k.key} a={k} onOeffnen={onOeffnen} onErledigen={onErledigen} ebene={ebene + 1} />)}
    </>
  );
}

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

function Baum({ liste, onOeffnen, onErledigen }: { liste: Aufgabe[]; onOeffnen: (a: Aufgabe) => void; onErledigen: (a: Aufgabe) => void }) {
  // Gruppen in der Reihenfolge des ersten Auftretens; Farbe = dringendster Eintrag
  const gruppen = useMemo(() => {
    const m = new Map<string, Aufgabe[]>();
    for (const a of liste) m.set(a.bereich, [...(m.get(a.bereich) ?? []), a]);
    return [...m.entries()].map(([bereich, eintraege]) => ({
      bereich, eintraege,
      state: eintraege.reduce<Aufgabe['state']>((s, a) => (RANG[a.state] > RANG[s] ? a.state : s), 'Information'),
    }));
  }, [liste]);
  // Standard: alles zugeklappt, nur bei einer einzigen Gruppe offen
  const [offen, setOffen] = useState<Set<string>>(() => new Set(offenLesen() ?? []));
  const umschalten = (b: string) => {
    const n = new Set(offen);
    if (n.has(b)) n.delete(b); else n.add(b);
    setOffen(n);
    try { localStorage.setItem(OFFEN_KEY, JSON.stringify([...n])); } catch { /* egal */ }
  };
  const auf = (b: string) => gruppen.length === 1 || offen.has(b);
  return (
    <Section title="Arbeitsvorrat" count={liste.length} flush>
      <div className="portal-av" role="tree">
        {gruppen.map((g) => (
          <div key={g.bereich} role="treeitem" aria-expanded={auf(g.bereich)}>
            <button type="button" className={`portal-av__eintrag portal-av__gruppe portal-av__eintrag--${g.state}`} onClick={() => umschalten(g.bereich)}>
              <Icon name={auf(g.bereich) ? 'navigation-down-arrow' : 'navigation-right-arrow'} className="portal-av__icon" />
              <div className="portal-av__inhalt"><div className="portal-av__titel">{g.bereich}</div></div>
              <span className="portal-av__anzahl">{g.eintraege.length}</span>
            </button>
            {auf(g.bereich) && <div role="group">{g.eintraege.map((a) => <Eintrag key={a.key} a={a} onOeffnen={onOeffnen} onErledigen={onErledigen} />)}</div>}
          </div>
        ))}
      </div>
    </Section>
  );
}
