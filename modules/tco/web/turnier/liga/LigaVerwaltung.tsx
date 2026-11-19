import { useEffect, useState } from 'react';
import { Bar, BusyIndicator, Button, Dialog, Input, Label, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { toast } from '@core/toast';
import { ErgebnisDialog } from '../ErgebnisDialog';
import { STANDARD_EINSTELLUNGEN, T, vollname, type ErgebnisEingabeWeb, type LigaEinstellungen, type LiveDaten, type Spiel, type VerwaltungProps } from '../api';
import type { LigaGruppe, LigaLiveDaten, Vorschau } from '../../../server/turnier/liga-logik';
import { Gesamtwertung, GruppenKarte, MERKMAL_TEXT, monatText, RUNDE_STATUS_TEXT, useMonatWahl } from './LigaLive';
import './liga.css';

/**
 * Turniere – Verwaltung Monats-Gruppenliga (Reiter „Gruppen und Monate“): Einstellungen (Gruppengröße, Setzung,
 * Startmonat, Anzahl Monate), Vorschau der nächsten Einteilung mit Auf-/Absteigern und Neueinsteigern, Monat starten
 * und abschließen (offene Spiele: kampflos für die Seite, die sich bemüht hat, sonst keine Wertung), Ergebnisse und
 * „bemüht“ je Spiel, Person in eine andere Gruppe schieben (vor dem ersten Ergebnis), Gesamtwertung.
 */
type LigaSpiel = LigaGruppe['spiele'][number];
const BEMUEHT_TEXT = { '': 'bemüht: –', a: 'bemüht: links', b: 'bemüht: rechts', beide: 'bemüht: beide' } as const;

export function LigaVerwaltung({ detail, darfPflegen, reload }: VerwaltungProps) {
  const t = detail.turnier;
  const { data: live, error, reload: liveNeu } = useLoad(() => api.get<LiveDaten<LigaLiveDaten>>(`${T}/${t.id}/live`), [t.id]);
  const { data: vorschau, reload: vorschauNeu } = useLoad(() => api.get<Vorschau>(`${T}/${t.id}/liga/vorschau`), [t.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [frage, setFrage] = useState<null | 'start' | 'abschluss' | 'oeffnen'>(null);
  const [ergebnis, setErgebnis] = useState<Spiel | null>(null);
  const [schieben, setSchieben] = useState(false);

  const e0 = { ...STANDARD_EINSTELLUNGEN.liga, ...(t.einstellungen as Partial<LigaEinstellungen>) };
  const [einst, setEinst] = useState({ gruppengroesse: String(e0.gruppengroesse), setzung: e0.setzung, start: e0.start ?? '', runden: String(e0.runden ?? '') });
  useEffect(() => {
    setEinst({ gruppengroesse: String(e0.gruppengroesse), setzung: e0.setzung, start: e0.start ?? '', runden: String(e0.runden ?? '') });
  }, [t.einstellungen]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = live?.daten;
  const { runde, auswahl } = useMonatWahl(d);
  const letzte = d?.runden.at(-1) ?? null;

  const name = (id: number) => {
    const x = detail.teilnehmer.find((y) => y.id === id);
    return x ? vollname(x) : live?.teilnehmer.find((y) => y.id === id)?.name ?? '?';
  };
  const alles = () => { liveNeu(); vorschauNeu(); reload(); };

  async function aktion(schluessel: string, fn: () => Promise<unknown>, meldung: string | ((r: any) => string)) {
    setBusy(schluessel); setFehler(null);
    try {
      const r = await fn();
      toast(typeof meldung === 'string' ? meldung : meldung(r));
      alles();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(null); }
  }

  const startOk = /^\d{4}-(0[1-9]|1[0-2])$/.test(einst.start.trim());
  const rundenZahl = Number(einst.runden);
  const einstOk = startOk && Number.isInteger(rundenZahl) && rundenZahl >= 1 && rundenZahl <= 24;
  function einstSpeichern() {
    aktion('einst', () => api.put(`${T}/${t.id}`, {
      name: t.name, kennung: t.kennung, modus: t.modus, status: t.status, beschreibung: t.beschreibung, meldeschluss: t.meldeschluss, max_teilnehmer: t.max_teilnehmer,
      einstellungen: { ...t.einstellungen, gruppengroesse: Number(einst.gruppengroesse) === 5 ? 5 : 4, setzung: einst.setzung, start: einst.start.trim(), runden: rundenZahl },
    }), 'Einstellungen gespeichert.');
  }

  // Monatsabschluss: Vorschau der automatischen Wertung
  const offeneLetzte = letzte?.gruppen.flatMap((g) => g.spiele).filter((s) => s.wertung === 'offen') ?? [];
  const kampflos = offeneLetzte.filter((s) => s.bemueht === 'a' || s.bemueht === 'b').length;

  async function bemueht(s: LigaSpiel, wert: string) {
    await aktion(`b${s.id}`, () => api.put(`${T}/${t.id}/liga/spiele/${s.id}/bemueht`, { bemueht: wert || null }), 'Gespeichert.');
  }
  async function ergebnisSpeichern(e: ErgebnisEingabeWeb) {
    await api.post(`${T}/${t.id}/spiele/${ergebnis!.id}/ergebnis`, e);
    toast('Ergebnis gespeichert.');
    setErgebnis(null);
    alles();
  }

  const darfEintragen = darfPflegen && t.status !== 'beendet';
  const spielExtra = (s: LigaSpiel) => {
    if (!runde || runde.status !== 'laeuft' || s.wertung !== 'offen' || !darfEintragen) {
      return s.wertung === 'offen' && s.bemueht ? <span className="liga-chip">{BEMUEHT_TEXT[s.bemueht]}</span> : null;
    }
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <Select style={{ width: '10rem' }} disabled={busy === `b${s.id}`} onChange={(e) => bemueht(s, (e.detail.selectedOption as HTMLElement).dataset.w ?? '')}>
          {(['', 'a', 'b', 'beide'] as const).map((w) => (
            <Option key={w} data-w={w} selected={(s.bemueht ?? '') === w}>
              {w === 'a' ? `bemüht: ${name(s.a[0])}` : w === 'b' ? `bemüht: ${name(s.b[0])}` : BEMUEHT_TEXT[w]}
            </Option>
          ))}
        </Select>
      </span>
    );
  };

  const vorschauZeigen = vorschau && (!letzte || letzte.status === 'abgeschlossen');

  return (
    <div className="liga">
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)}>{fehler}</MessageStrip>}
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}

      <Section title="Einstellungen" actions={darfPflegen && <Button icon="save" disabled={!einstOk} loading={busy === 'einst'} onClick={einstSpeichern}>Speichern</Button>}>
        <div className="liga-einst">
          <div>
            <Label for="liga-gg">Gruppengröße</Label>
            <Select id="liga-gg" disabled={!darfPflegen} onChange={(e) => setEinst({ ...einst, gruppengroesse: (e.detail.selectedOption as HTMLElement).dataset.v! })}>
              <Option data-v="4" selected={einst.gruppengroesse === '4'}>4er-Gruppen</Option>
              <Option data-v="5" selected={einst.gruppengroesse === '5'}>5er-Gruppen</Option>
            </Select>
          </div>
          <div>
            <Label for="liga-setz">Setzung</Label>
            <Select id="liga-setz" disabled={!darfPflegen} onChange={(e) => setEinst({ ...einst, setzung: (e.detail.selectedOption as HTMLElement).dataset.v as 'lk' | 'manuell' })}>
              <Option data-v="lk" selected={einst.setzung === 'lk'}>nach LK</Option>
              <Option data-v="manuell" selected={einst.setzung === 'manuell'}>manuelle Reihenfolge</Option>
            </Select>
          </div>
          <div>
            <Label for="liga-start" required>Startmonat (JJJJ-MM)</Label>
            <Input id="liga-start" value={einst.start} placeholder="2027-05" disabled={!darfPflegen || !!letzte} valueState={einst.start && !startOk ? 'Negative' : 'None'}
              onInput={(e) => setEinst({ ...einst, start: e.target.value })} />
          </div>
          <div>
            <Label for="liga-runden" required>Anzahl Monate</Label>
            <Input id="liga-runden" type="Number" value={einst.runden} disabled={!darfPflegen} onInput={(e) => setEinst({ ...einst, runden: e.target.value })} />
          </div>
        </div>
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          Wenige Personen: bis 6 eine Gruppe, 7 = 4 + 3, 11 = 4 + 4 + 3; sonst nur 4er- und 5er-Gruppen (abweichende Gruppen unten).
          Neueinsteiger werden zum nächsten Monat nach Stärke einsortiert.
        </Text>
      </Section>

      {letzte && (
        <Section title={`Monat ${letzte.nr} · ${monatText(letzte.monat)}`}
          status={<Text className="portal-muted">{RUNDE_STATUS_TEXT[letzte.status]}{letzte.status === 'laeuft' ? ` · ${letzte.offen} von ${letzte.spiele} Spielen offen` : ''}</Text>}
          actions={darfEintragen && (letzte.status === 'laeuft' ? <>
            <Button icon="move" onClick={() => setSchieben(true)}>Person verschieben</Button>
            <Button design="Emphasized" icon="locked" loading={busy === 'abschluss'} onClick={() => setFrage('abschluss')}>Monat abschließen</Button>
          </> : <Button icon="unlocked" loading={busy === 'oeffnen'} onClick={() => setFrage('oeffnen')}>Wieder öffnen</Button>)}>
          <Text className="portal-muted portal-small">
            Klick auf ein Spiel: Ergebnis eintragen. „bemüht“: wer sich nachweislich um einen Termin bemüht hat – beim Monatsabschluss gewinnt diese Seite kampflos;
            haben sich beide oder keiner bemüht, bekommt niemand etwas.
          </Text>
        </Section>
      )}

      {vorschauZeigen && (
        <Section title={`Nächster Monat: ${vorschau.nr}${vorschau.monat ? ` · ${monatText(vorschau.monat)}` : ''}`}
          actions={darfEintragen && <Button design="Emphasized" icon="media-play" disabled={!vorschau.moeglich} loading={busy === 'start'} onClick={() => setFrage('start')}>Monat starten</Button>}>
          {vorschau.hinweis && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>{vorschau.hinweis}</MessageStrip>}
          <div className="liga-gruppen">
            {vorschau.gruppen.map((g) => (
              <div key={g.gruppe} className="liga-gruppe">
                <div className="liga-gruppe__kopf"><span>Gruppe {g.gruppe}</span><span className="liga-label">{g.personen.length} Personen</span></div>
                {g.personen.map((p, i) => (
                  <div key={p.id} className="liga-zeile">
                    <span className="liga-label" style={{ minWidth: '1.25rem' }}>{i + 1}.</span>
                    <span style={{ flex: 1 }}>{name(p.id)}</span>
                    {p.merkmal && <span className={`liga-chip liga-chip--${p.merkmal}`}>{MERKMAL_TEXT[p.merkmal]}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      )}

      {!live && !error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
      {runde && (
        <Section title="Gruppen" actions={auswahl}>
          <div className="liga-gruppen">
            {runde.gruppen.map((g) => (
              <GruppenKarte key={g.gruppe} g={g} name={name} mitSpielen spielExtra={spielExtra}
                onSpiel={darfEintragen ? (sid) => setErgebnis(detail.spiele.find((s) => s.id === sid) ?? null) : undefined} />
            ))}
          </div>
        </Section>
      )}

      {d && d.runden.length > 0 && (
        <Section title="Gesamtwertung" status={<Text className="portal-muted portal-small">nach Siegquote, dann Siege, Satz- und Spieldifferenz</Text>}>
          <Gesamtwertung gesamt={d.gesamt} verlauf={d.verlauf} runden={d.runden} name={name} />
        </Section>
      )}

      <ConfirmDialog open={frage === 'start'} title="Monat starten"
        text={vorschau ? `Monat ${vorschau.nr}${vorschau.monat ? ` (${monatText(vorschau.monat)})` : ''} mit ${vorschau.gruppen.length} Gruppen starten? Die Spiele „jeder gegen jeden“ werden angelegt.` : ''}
        confirmText="Starten" onCancel={() => setFrage(null)}
        onConfirm={() => { setFrage(null); aktion('start', () => api.post(`${T}/${t.id}/liga/runde`), 'Monat gestartet.'); }} />
      <ConfirmDialog open={frage === 'abschluss'} title="Monat abschließen"
        text={`${offeneLetzte.length} Spiele sind noch offen. Davon werden ${kampflos} kampflos für die Seite gewertet, die sich um einen Termin bemüht hat; ${offeneLetzte.length - kampflos} zählen für niemanden. Danach können die Teilnehmenden keine Ergebnisse mehr eintragen.`}
        confirmText="Abschließen" onCancel={() => setFrage(null)}
        onConfirm={() => { setFrage(null); aktion('abschluss', () => api.post(`${T}/${t.id}/liga/runde/${letzte!.nr}/abschliessen`), (r: { kampflos: number; keine: number }) => `Monat abgeschlossen: ${r.kampflos} kampflos, ${r.keine} ohne Wertung.`); }} />
      <ConfirmDialog open={frage === 'oeffnen'} title="Monat wieder öffnen"
        text="Die beim Abschluss automatisch gewerteten Spiele werden wieder offen. Fortfahren?"
        confirmText="Öffnen" onCancel={() => setFrage(null)}
        onConfirm={() => { setFrage(null); aktion('oeffnen', () => api.post(`${T}/${t.id}/liga/runde/${letzte!.nr}/oeffnen`), 'Monat wieder geöffnet.'); }} />

      {ergebnis && (
        <ErgebnisDialog offen spiel={ergebnis} namenA={ergebnis.a.map(name)} namenB={ergebnis.b.map(name)} art="einzel" liga
          onSpeichern={ergebnisSpeichern} onSchliessen={() => setErgebnis(null)} />
      )}
      {schieben && letzte && (
        <SchiebenDialog gruppen={letzte.gruppen} name={name} onClose={() => setSchieben(false)}
          onSchieben={(tid, gruppe) => aktion('schieben', async () => {
            await api.put(`${T}/${t.id}/liga/runde/${letzte.nr}/einteilung`, { teilnehmer_id: tid, gruppe });
            setSchieben(false);
          }, 'Einteilung geändert – die Spiele beider Gruppen wurden neu angelegt.')} />
      )}
    </div>
  );
}

/** Person in eine andere Gruppe schieben (nur solange beide Gruppen ohne Ergebnis sind – prüft der Server) */
function SchiebenDialog({ gruppen, name, onClose, onSchieben }: { gruppen: LigaGruppe[]; name: (id: number) => string; onClose: () => void; onSchieben: (tid: number, gruppe: number) => void }) {
  const personen = gruppen.flatMap((g) => g.tabelle.map((z) => ({ id: z.teilnehmer_id, gruppe: g.gruppe }))).sort((a, b) => name(a.id).localeCompare(name(b.id), 'de'));
  const [tid, setTid] = useState<number | null>(personen[0]?.id ?? null);
  const [gruppe, setGruppe] = useState<number>(1);
  const aktuell = personen.find((p) => p.id === tid)?.gruppe;
  return (
    <Dialog open headerText="Person verschieben" style={{ width: 'min(28rem, 96vw)' }} onClose={onClose}
      footer={<Bar endContent={<>
        <Button design="Emphasized" disabled={!tid || gruppe === aktuell} onClick={() => tid && onSchieben(tid, gruppe)}>Verschieben</Button>
        <Button onClick={onClose}>Abbrechen</Button>
      </>} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Label>Person</Label>
        <Select onChange={(e) => setTid(Number((e.detail.selectedOption as HTMLElement).dataset.id))}>
          {personen.map((p) => <Option key={p.id} data-id={p.id} selected={p.id === tid}>{name(p.id)} (Gruppe {p.gruppe})</Option>)}
        </Select>
        <Label>in Gruppe</Label>
        <Select onChange={(e) => setGruppe(Number((e.detail.selectedOption as HTMLElement).dataset.g))}>
          {gruppen.map((g) => <Option key={g.gruppe} data-g={g.gruppe} selected={g.gruppe === gruppe}>Gruppe {g.gruppe}</Option>)}
        </Select>
        <Text className="portal-muted portal-small">Nur möglich, solange in beiden Gruppen noch kein Ergebnis eingetragen ist. Die Spiele beider Gruppen werden neu angelegt.</Text>
      </div>
    </Dialog>
  );
}
