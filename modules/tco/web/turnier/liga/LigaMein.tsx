import { useEffect, useState } from 'react';
import { Button, MessageStrip, Text, Title } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { TO, type LiveDaten, type MeinProps } from '../api';
import type { LigaLiveDaten } from '../../../server/turnier/liga-logik';
import { GruppenKarte, monatText } from './LigaLive';
import './liga.css';

/**
 * Turniere – Ergänzung auf „Mein Turnier“ (Monats-Gruppenliga): eigene Gruppe im laufenden Monat mit Tabelle
 * (öffentliche Namen „Vorname N.“, keine Kontaktdaten) und je offenem eigenen Spiel der Knopf
 * „Ich habe mich um einen Termin bemüht“ – beim Monatsabschluss gewinnt kampflos, wer sich als Einzige/r bemüht hat.
 */
export function LigaMein({ daten, schluessel, reload }: MeinProps) {
  const t = daten.turnier;
  const ich = daten.ich.id;
  const [live, setLive] = useState<LiveDaten<LigaLiveDaten> | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    api.get<LiveDaten<LigaLiveDaten>>(`${TO}/oeffentlich/${encodeURIComponent(t.kennung)}/live`)
      .then((l) => { if (aktiv) setLive(l); })
      .catch(() => { /* ohne Live-Daten nur die Knöpfe */ });
    return () => { aktiv = false; };
  }, [t.kennung, daten]);

  const laufend = new Set(daten.runden.filter((r) => r.status === 'laeuft').map((r) => r.id));
  const offen = daten.spiele.filter((s) => s.feld === 'gruppe' && s.wertung === 'offen' && s.runde_id != null && laufend.has(s.runde_id));
  const d = live?.daten;
  const runde = d?.runden.find((r) => r.nr === d.aktuell) ?? null;
  const gruppe = runde?.gruppen.find((g) => g.tabelle.some((z) => z.teilnehmer_id === ich)) ?? null;
  const namen = new Map(live?.teilnehmer.map((x) => [x.id, x.name]) ?? []);

  async function bemueht(spielId: number) {
    setBusy(spielId); setFehler(null);
    try {
      const r = await api.post<{ text: string }>(`${TO}/liga/zugang/${schluessel}/bemueht`, { spiel_id: spielId });
      toast(r.text);
      reload();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(null); }
  }

  if (!gruppe && !offen.length) return null;
  return (
    <div className="liga">
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)}>{fehler}</MessageStrip>}
      {gruppe && runde && (
        <>
          <Title level="H5">Meine Gruppe · {monatText(runde.monat)}</Title>
          <GruppenKarte g={gruppe} name={(id) => namen.get(id) ?? '?'} ich={ich} />
        </>
      )}
      {offen.length > 0 && (
        <>
          <Title level="H5">Termin noch nicht gefunden?</Title>
          <Text className="portal-muted portal-small">
            Bis Monatsende nicht gespielte Spiele gewinnt kampflos, wer sich nachweislich um einen Termin bemüht hat. Haben sich beide
            (oder keiner) bemüht, bekommt niemand etwas. Bitte nur melden, wenn du wirklich Termine angeboten hast.
          </Text>
          {offen.map((s) => {
            const gegner = (s.meine_seite === 'a' ? s.namen_b : s.namen_a).join(' / ');
            const ichBemueht = s.bemueht === s.meine_seite || s.bemueht === 'beide';
            const erBemueht = s.bemueht === 'beide' || (s.bemueht != null && s.bemueht !== s.meine_seite);
            return (
              <div key={s.id} className="liga-zeile" style={{ border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem', padding: '0.5rem 0.75rem' }}>
                <span style={{ flex: 1, minWidth: '10rem' }}>
                  gegen <b>{gegner}</b>
                  {erBemueht && <span className="liga-label"> · {gegner} hat sich um einen Termin bemüht</span>}
                </span>
                {ichBemueht
                  ? <span className="liga-chip liga-chip--auf">Bemühen vermerkt</span>
                  : <Button icon="appointment" loading={busy === s.id} onClick={() => bemueht(s.id)}>Ich habe mich um einen Termin bemüht</Button>}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
