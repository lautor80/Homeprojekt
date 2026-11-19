import { useEffect, useState, type ReactNode } from 'react';
import { Option, Select, Text } from '@ui5/webcomponents-react';
import { ergebnisText, type LiveProps } from '../api';
import type { GesamtZeile, LigaGruppe, LigaLiveDaten, LigaRunde, TabellenZeile } from '../../../server/turnier/liga-logik';
import './liga.css';

/**
 * Turniere – Live-Ansicht Monats-Gruppenliga (öffentlich, Verwaltung, Beamer): Monat wählbar, Gruppenkarten mit Tabelle
 * (▲ Aufsteiger, ▼ Absteiger) und Spielen, Gesamtwertung über alle Monate nach Siegquote mit Gruppenverlauf.
 */
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
/** „Juni 2027“ aus 2027-06-01 */
export const monatText = (m: string | null | undefined) => (m ? `${MONATE[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}` : '');
export const RUNDE_STATUS_TEXT: Record<LigaRunde['status'], string> = { geplant: 'geplant', laeuft: 'läuft', abgeschlossen: 'abgeschlossen' };
export const MERKMAL_TEXT = { auf: '▲ Aufsteiger', ab: '▼ Absteiger', neu: 'neu' } as const;

const diff = ([x, y]: [number, number]) => `${x}:${y}`;
const prozent = (q: number) => `${Math.round(q * 100)} %`;

export function Kennzeichen({ k }: { k: TabellenZeile['kennzeichen'] }) {
  if (k === 'auf') return <span className="liga-auf" title="steigt auf">▲</span>;
  if (k === 'ab') return <span className="liga-ab" title="steigt ab">▼</span>;
  return null;
}

interface GruppenKarteProps {
  g: LigaGruppe;
  name: (id: number) => string;
  /** Spiele unter der Tabelle zeigen */
  mitSpielen?: boolean;
  /** Klick auf ein Spiel (Verwaltung: Ergebnis eintragen) */
  onSpiel?: (spielId: number) => void;
  /** zusätzliche Bedienelemente je Spiel (Verwaltung: „bemüht“) */
  spielExtra?: (s: LigaGruppe['spiele'][number]) => ReactNode;
  /** eigene Zeile hervorheben (persönlicher Link) */
  ich?: number;
  kopfExtra?: ReactNode;
}

/** Gruppe mit Tabelle (Platz, Name, Siege, Niederlagen, Sätze, Spiele) und optional den Spielen */
export function GruppenKarte({ g, name, mitSpielen, onSpiel, spielExtra, ich, kopfExtra }: GruppenKarteProps) {
  return (
    <div className="liga-gruppe">
      <div className="liga-gruppe__kopf"><span>Gruppe {g.gruppe}</span>{kopfExtra}</div>
      <div className="liga-tabelle-rahmen">
        <table className="liga-tabelle">
          <thead><tr><th>Pl.</th><th className="liga-name">Name</th><th title="Siege">S</th><th title="Niederlagen">N</th><th>Sätze</th><th className="liga-breit">Spiele</th><th className="liga-breit" title="offene Spiele">offen</th></tr></thead>
          <tbody>
            {g.tabelle.map((z) => (
              <tr key={z.teilnehmer_id} className={z.teilnehmer_id === ich ? 'liga-ich' : undefined}>
                <td>{z.platz}</td>
                <td className="liga-name">{name(z.teilnehmer_id)} <Kennzeichen k={z.kennzeichen} /></td>
                <td>{z.siege}</td><td>{z.niederlagen}</td><td>{diff(z.saetze)}</td>
                <td className="liga-breit">{diff(z.spielstand)}</td><td className="liga-breit">{z.offen || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mitSpielen && g.spiele.length > 0 && (
        <div className="liga-spiele">
          {g.spiele.map((s) => {
            const erg = s.wertung === 'offen' ? '' : ergebnisText(s);
            return (
              <div key={s.id} className={`liga-spiel${onSpiel ? ' liga-spiel--klick' : ''}`}
                onClick={onSpiel ? () => onSpiel(s.id) : undefined} role={onSpiel ? 'button' : undefined}>
                <span className="liga-spiel__paar">
                  <span className={s.sieger === 'a' ? 'liga-sieger' : undefined}>{name(s.a[0])}</span>
                  {' – '}
                  <span className={s.sieger === 'b' ? 'liga-sieger' : undefined}>{name(s.b[0])}</span>
                </span>
                <span className="liga-spiel__erg">{erg || <span className="liga-label">offen</span>}</span>
                {s.wertung === 'offen' && s.bemueht && !spielExtra && (
                  <span className="liga-chip" title="hat sich um einen Termin bemüht">
                    bemüht: {s.bemueht === 'beide' ? 'beide' : name(s.bemueht === 'a' ? s.a[0] : s.b[0])}
                  </span>
                )}
                {spielExtra?.(s)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Gesamtwertung: Quote, Siege, Niederlagen, Sätze, Spiele, Gruppe je Monat */
export function Gesamtwertung({ gesamt, verlauf, runden, name }: { gesamt: GesamtZeile[]; verlauf: LigaLiveDaten['verlauf']; runden: LigaRunde[]; name: (id: number) => string }) {
  if (!gesamt.length) return <Text className="portal-muted">Noch keine Wertung.</Text>;
  return (
    <div className="liga-tabelle-rahmen">
      <table className="liga-tabelle">
        <thead>
          <tr>
            <th>Pl.</th><th className="liga-name">Name</th><th title="Siegquote">Quote</th><th title="gewertete Spiele" className="liga-breit">Sp.</th>
            <th title="Siege">S</th><th title="Niederlagen">N</th><th>Sätze</th><th className="liga-breit">Spiele</th>
            <th className="liga-breit" title={`Gruppe je Monat (${runden.map((r) => monatText(r.monat)).join(', ')})`}>Gruppen</th>
          </tr>
        </thead>
        <tbody>
          {gesamt.map((z) => {
            const v = new Map((verlauf[z.teilnehmer_id] ?? []).map((x) => [x.nr, x.gruppe]));
            return (
              <tr key={z.teilnehmer_id}>
                <td>{z.platz}</td><td className="liga-name">{name(z.teilnehmer_id)}</td>
                <td>{z.spiele ? prozent(z.quote) : '–'}</td><td className="liga-breit">{z.spiele}</td>
                <td>{z.siege}</td><td>{z.niederlagen}</td><td>{diff(z.saetze)}</td><td className="liga-breit">{diff(z.spielstand)}</td>
                <td className="liga-breit">
                  <span className="liga-verlauf">{runden.map((r) => <span key={r.nr} title={monatText(r.monat)}>{v.get(r.nr) ?? '–'}</span>)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Auswahl des angezeigten Monats (Standard: aktueller) */
export function useMonatWahl(d: LigaLiveDaten | null | undefined) {
  const [nr, setNr] = useState<number | null>(null);
  useEffect(() => { setNr(null); }, [d?.aktuell]);
  const runde = d?.runden.find((r) => r.nr === (nr ?? d.aktuell)) ?? null;
  const auswahl = d && d.runden.length > 1 ? (
    <Select style={{ minWidth: '12rem' }} onChange={(e) => setNr(Number((e.detail.selectedOption as HTMLElement).dataset.nr))}>
      {[...d.runden].reverse().map((r) => (
        <Option key={r.nr} data-nr={r.nr} selected={r.nr === runde?.nr}>Monat {r.nr} · {monatText(r.monat)}</Option>
      ))}
    </Select>
  ) : null;
  return { runde, auswahl };
}

export function LigaLive({ live, gross }: LiveProps<LigaLiveDaten>) {
  const d = live.daten;
  const namen = new Map(live.teilnehmer.map((x) => [x.id, x.name]));
  const name = (id: number) => namen.get(id) ?? '?';
  const { runde, auswahl } = useMonatWahl(d);
  if (!d?.runden?.length) return <Text className="portal-muted">Die Gruppen stehen noch nicht fest.</Text>;
  return (
    <div className={`liga${gross ? ' liga--gross' : ''}`}>
      {runde && (
        <div className="liga-kopf">
          <span className="liga-kopf__titel">Monat {runde.nr} · {monatText(runde.monat)}</span>
          <span className="liga-label">{RUNDE_STATUS_TEXT[runde.status]}{runde.status === 'laeuft' ? ` · ${runde.offen} von ${runde.spiele} Spielen offen` : ''}</span>
          {!gross && auswahl}
        </div>
      )}
      {runde && (
        <div className="liga-gruppen">
          {runde.gruppen.map((g) => <GruppenKarte key={g.gruppe} g={g} name={name} mitSpielen={!gross} />)}
        </div>
      )}
      <div className="liga-kopf"><span className="liga-kopf__titel">Gesamtwertung</span><span className="liga-label">nach Siegquote über alle Monate</span></div>
      <Gesamtwertung gesamt={d.gesamt} verlauf={d.verlauf} runden={d.runden} name={name} />
    </div>
  );
}
