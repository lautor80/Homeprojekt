import { useEffect, useMemo, useState } from 'react';
import { BusyIndicator, Button, Dialog, Label, MessageStrip, Option, Select, Text } from '@ui5/webcomponents-react';
import { DialogFuss } from '@core/components/DialogFuss';
import { api, qs } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import type { KoAuslosungInfo, KoLiveDaten, KoLiveSpiel } from '../../../server/turnier/ko-logik';
import { ErgebnisDialog } from '../ErgebnisDialog';
import {
  ergebnisText, lkText, STANDARD_EINSTELLUNGEN, T, vollname,
  type ErgebnisEingabeWeb, type KoEinstellungen, type LiveDaten, type Spiel, type VerwaltungProps,
} from '../api';
import { KoTableau } from './KoLive';
import './ko.css';

/**
 * Turniere – Verwaltung Modus „ko“: Einstellungen (Nebenrunde, Setzung, Anzahl Gesetzte), Vorschau der Setzliste mit
 * Freilosen, Auslosen/Auslosung aufheben und das Tableau mit Ergebniseingabe (Klick auf ein Spiel).
 */
const NEBENRUNDE: [KoEinstellungen['nebenrunde'], string][] = [
  ['keine', 'keine Nebenrunde'],
  ['erste_runde', 'Verlierer der 1. Runde (auch nach Freilos)'],
  ['alle', 'alle Ausgeschiedenen (Einstieg je Runde)'],
];
const SETZUNG: [KoEinstellungen['setzung'], string][] = [['lk', 'nach LK'], ['manuell', 'nach manueller Rangliste']];
const GESETZTE = [0, 2, 4, 8, 16];

interface Vorschau {
  anzahl: number; feld: number | null; freilose: number | null; hinweis: string | null;
  staerke: { id: number; rang: number; setzplatz: number | null; manuell: number | null; lk: number | null; freilos: boolean }[];
}

export function KoVerwaltung({ detail, darfPflegen, reload }: VerwaltungProps) {
  const t = detail.turnier;
  const gespeichert = { ...STANDARD_EINSTELLUNGEN.ko, ...(t.einstellungen as Partial<KoEinstellungen>) };
  const auslosung = (t.einstellungen as { auslosung?: KoAuslosungInfo }).auslosung;
  const [einst, setEinst] = useState<KoEinstellungen>(gespeichert);
  const [vorschau, setVorschau] = useState<Vorschau | null>(null);
  const [live, setLive] = useState<LiveDaten<KoLiveDaten> | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [frage, setFrage] = useState<'auslosen' | 'aufheben' | null>(null);
  const [gewaehlt, setGewaehlt] = useState<Spiel | null>(null);
  const [eingabe, setEingabe] = useState(false);

  const ausgelost = detail.spiele.some((s) => s.feld === 'haupt');
  const ergebnisse = detail.spiele.filter((s) => (s.feld === 'haupt' || s.feld === 'neben') && s.wertung !== 'offen' && s.wertung !== 'freilos').length;
  const geaendert = einst.nebenrunde !== gespeichert.nebenrunde || einst.setzung !== gespeichert.setzung || einst.gesetzte !== gespeichert.gesetzte;
  const namen = useMemo(() => new Map(detail.teilnehmer.map((x) => [x.id, vollname(x)])), [detail.teilnehmer]);
  const tnName = (id: number | undefined) => (id != null ? namen.get(id) ?? '?' : '–');

  // gespeicherte Einstellungen übernehmen, wenn das Turnier neu geladen wurde
  useEffect(() => { setEinst({ ...STANDARD_EINSTELLUNGEN.ko, ...(t.einstellungen as Partial<KoEinstellungen>) }); }, [t.einstellungen]);
  useEffect(() => {
    api.get<Vorschau>(`${T}/${t.id}/ko/vorschau${qs({ setzung: einst.setzung, gesetzte: einst.gesetzte })}`).then(setVorschau).catch((e) => setFehler(e.message));
  }, [t.id, einst.setzung, einst.gesetzte, detail]);
  useEffect(() => {
    if (!ausgelost) { setLive(null); return; }
    api.get<LiveDaten<KoLiveDaten>>(`${T}/${t.id}/live`).then(setLive).catch((e) => setFehler(e.message));
  }, [t.id, ausgelost, detail]);

  async function ausfuehren(f: () => Promise<unknown>, meldung: string) {
    setBusy(true); setFehler(null);
    try { await f(); toast(meldung); reload(); } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }
  const speichern = () => ausfuehren(() => api.put(`${T}/${t.id}`, {
    name: t.name, kennung: t.kennung, modus: t.modus, status: t.status, beschreibung: t.beschreibung,
    meldeschluss: t.meldeschluss, max_teilnehmer: t.max_teilnehmer,
    einstellungen: { nebenrunde: einst.nebenrunde, setzung: einst.setzung, gesetzte: einst.gesetzte },
  }), 'Einstellungen gespeichert.');
  const auslosen = () => ausfuehren(async () => {
    if (geaendert) await api.put(`${T}/${t.id}`, {
      name: t.name, kennung: t.kennung, modus: t.modus, status: t.status, beschreibung: t.beschreibung,
      meldeschluss: t.meldeschluss, max_teilnehmer: t.max_teilnehmer, einstellungen: { ...einst },
    });
    await api.post(`${T}/${t.id}/ko/auslosen`);
  }, 'Das Feld ist ausgelost.');
  const aufheben = () => ausfuehren(() => api.del(`${T}/${t.id}/ko/auslosung`), 'Die Auslosung ist aufgehoben.');

  function spielWaehlen(s: KoLiveSpiel) {
    if (!darfPflegen) return;
    const sp = detail.spiele.find((x) => x.id === s.id);
    if (!sp) return;
    setGewaehlt(sp);
    setEingabe(sp.wertung === 'offen');
  }
  async function ergebnisSpeichern(e: ErgebnisEingabeWeb) {
    if (!gewaehlt) return;
    await api.post(`${T}/${t.id}/spiele/${gewaehlt.id}/ergebnis`, e); // Fehler zeigt der Dialog an
    toast('Ergebnis gespeichert.');
    setGewaehlt(null); setEingabe(false);
    reload();
  }
  const zuruecksetzen = (s: Spiel) => ausfuehren(async () => {
    setGewaehlt(null);
    await api.del(`${T}/${t.id}/spiele/${s.id}/ergebnis`);
  }, 'Ergebnis zurückgesetzt.');

  const sel = <K extends keyof KoEinstellungen>(k: K, werte: [KoEinstellungen[K], string][], label: string, breite: string) => (
    <div>
      <Label>{label}</Label>
      <Select style={{ width: breite }} accessibleName={label} disabled={!darfPflegen || busy}
        onChange={(e) => {
          const i = Number((e.detail.selectedOption as HTMLElement).dataset.i);
          setEinst({ ...einst, [k]: werte[i][0] });
        }}>
        {werte.map(([w, txt], i) => <Option key={String(w)} data-i={i} selected={w === einst[k]}>{txt}</Option>)}
      </Select>
    </div>
  );

  return (
    <div className="portal-ko" style={{ gap: '0.75rem' }}>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)}>{fehler}</MessageStrip>}

      <Section title="Einstellungen" actions={darfPflegen && (
        <Button design={geaendert ? 'Emphasized' : 'Default'} icon="save" disabled={!geaendert || busy} onClick={speichern}>Speichern</Button>
      )}>
        <div className="portal-ko__einst">
          {sel('nebenrunde', NEBENRUNDE, 'Nebenrunde', '20rem')}
          {sel('setzung', SETZUNG, 'Setzung', '14rem')}
          {sel('gesetzte', GESETZTE.map((g) => [g, g ? `${g} Gesetzte` : 'keine Gesetzten'] as [number, string]), 'Anzahl Gesetzte', '10rem')}
        </div>
        {ausgelost && auslosung && auslosung.nebenrunde !== einst.nebenrunde && (
          <MessageStrip hideCloseButton style={{ marginTop: '0.75rem' }}>
            Das laufende Tableau wurde mit „{NEBENRUNDE.find(([w]) => w === auslosung.nebenrunde)?.[1]}“ ausgelost. Eine geänderte Nebenrunde gilt erst bei einer neuen Auslosung.
          </MessageStrip>
        )}
        <Text className="portal-muted" style={{ display: 'block', marginTop: '0.5rem' }}>
          Manuell eingetragene Setzplätze (bei den Teilnehmenden) haben Vorrang; freie Setzplätze bekommen die Stärksten. Freilose gehen an die
          Bestgesetzten, die übrigen Teilnehmenden werden gelost.
        </Text>
      </Section>

      <Section title={ausgelost ? 'Teilnehmende nach Stärke' : 'Setzliste (Vorschau)'} count={vorschau?.anzahl}
        status={vorschau?.feld ? <Text className="portal-muted" style={{ marginLeft: '0.5rem' }}>{vorschau.feld}er-Feld, {vorschau.freilose} Freilos{vorschau.freilose === 1 ? '' : 'e'}</Text> : undefined}
        actions={darfPflegen && (
          <>
            {ausgelost && <Button design="Transparent" icon="reset" disabled={busy || ergebnisse > 0} tooltip={ergebnisse ? 'Es gibt bereits Ergebnisse.' : undefined}
              onClick={() => setFrage('aufheben')}>Auslosung aufheben</Button>}
            <Button design={ausgelost ? 'Default' : 'Emphasized'} icon="journey-change" disabled={busy || ergebnisse > 0 || !vorschau?.feld || (vorschau?.anzahl ?? 0) < 2}
              onClick={() => setFrage('auslosen')}>{ausgelost ? 'Neu auslosen' : 'Auslosen'}</Button>
          </>
        )} flush>
        {vorschau?.hinweis && <MessageStrip design="Critical" hideCloseButton style={{ margin: '0.5rem' }}>{vorschau.hinweis}</MessageStrip>}
        {!vorschau ? <BusyIndicator active style={{ margin: '1rem' }} /> : !vorschau.staerke.length ? <Empty>Noch keine gemeldeten Teilnehmenden.</Empty> : (
          <div className="portal-ko__rahmen portal-tabrahmen" style={{ border: 0, borderRadius: 0 }}>
            <table className="portal-ko__setzliste">
              <thead><tr><th>Rang</th><th>Setzplatz</th><th>Name</th><th>LK</th><th>Freilos</th></tr></thead>
              <tbody>
                {vorschau.staerke.map((x) => (
                  <tr key={x.id}>
                    <td>{x.rang}</td>
                    <td>{x.setzplatz ? <b>{x.setzplatz}</b> : ''}{x.manuell ? <span className="portal-muted"> (manuell {x.manuell})</span> : ''}</td>
                    <td>{tnName(x.id)}</td>
                    <td>{lkText(x.lk)}</td>
                    <td>{x.freilos ? 'ja' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Tableau" actions={ausgelost && <Button design="Transparent" icon="refresh" tooltip="Aktualisieren" onClick={reload} />}>
        {!ausgelost ? <Empty>Noch nicht ausgelost.</Empty> : !live ? <BusyIndicator active /> : (
          <>
            {darfPflegen && <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.5rem' }}>Zum Eintragen oder Ändern eines Ergebnisses auf das Spiel klicken.</Text>}
            <KoTableau daten={live.daten} namen={namen} onSpiel={darfPflegen ? spielWaehlen : undefined} />
          </>
        )}
      </Section>

      {gewaehlt && eingabe && (
        <ErgebnisDialog offen spiel={gewaehlt} art="einzel" namenA={gewaehlt.a.map((i) => tnName(i))} namenB={gewaehlt.b.map((i) => tnName(i))}
          onSpeichern={ergebnisSpeichern} onSchliessen={() => { setGewaehlt(null); setEingabe(false); }} />
      )}
      {gewaehlt && !eingabe && (
        <Dialog open headerText="Ergebnis" onClose={() => setGewaehlt(null)}
          footer={<DialogFuss>
            <Button design="Emphasized" icon="edit" onClick={() => setEingabe(true)}>Ändern</Button>
            <Button design="Negative" icon="reset" disabled={busy} onClick={() => zuruecksetzen(gewaehlt)}>Zurücksetzen</Button>
            <Button onClick={() => setGewaehlt(null)}>Schließen</Button>
          </DialogFuss>}>
          <Text style={{ display: 'block', minWidth: 'min(380px, 80vw)' }}>
            {tnName(gewaehlt.a[0])} – {tnName(gewaehlt.b[0])}: <b>{ergebnisText(gewaehlt)}</b>
          </Text>
          <Text className="portal-muted" style={{ display: 'block', marginTop: '0.5rem' }}>
            Ein geänderter Sieger wird ins Folgespiel übernommen. Ist das Folgespiel schon gespielt, muss dort zuerst das Ergebnis zurückgesetzt werden.
          </Text>
        </Dialog>
      )}

      <ConfirmDialog open={frage === 'auslosen'} title={ausgelost ? 'Neu auslosen' : 'Auslosen'}
        text={`${vorschau?.anzahl ?? 0} Teilnehmende im ${vorschau?.feld ?? ''}er-Feld mit ${vorschau?.freilose ?? 0} Freilos(en) auslosen? `
          + `Setzung ${einst.setzung === 'lk' ? 'nach LK' : 'nach Rangliste'}, ${NEBENRUNDE.find(([w]) => w === einst.nebenrunde)?.[1]}.`
          + (ausgelost ? '\n\nDie bisherige Auslosung wird ersetzt.' : '\n\nDas Turnier wird auf „läuft“ gesetzt.')}
        confirmText={ausgelost ? 'Neu auslosen' : 'Auslosen'}
        onConfirm={() => { setFrage(null); auslosen(); }} onCancel={() => setFrage(null)} />
      <ConfirmDialog open={frage === 'aufheben'} danger title="Auslosung aufheben"
        text="Alle Spiele des Tableaus (Hauptfeld und Nebenrunde) werden gelöscht. Danach lässt sich neu auslosen."
        confirmText="Aufheben" onConfirm={() => { setFrage(null); aufheben(); }} onCancel={() => setFrage(null)} />
    </div>
  );
}
