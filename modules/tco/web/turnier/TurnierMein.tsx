import { useCallback, useEffect, useState } from 'react';
import { BusyIndicator, Button, Dialog, Link, MessageStrip, ObjectStatus, Text, Title } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { CenterCard } from '@core/pages/AuthPages';
import type { OeffentlichProps } from '@core/platform';
import { ergebnisText, lkText, STATUS_TEXT, TO, type ErgebnisEingabeWeb, type Runde, type ZugangDaten } from './api';
import { ErgebnisDialog } from './ErgebnisDialog';
import { MODUS_UI } from './modi';

/**
 * „Mein Turnier“ /turnier-mein?z=<schlüssel> (persönlicher Link aus der Anmeldung): eigene Daten und Spiele, Ergebnis
 * eintragen, abmelden; darunter die Ergänzung des Modus (z. B. Liga: Terminbemühung, Spaßturnier: Pause wünschen).
 */
type MeinSpiel = ZugangDaten['spiele'][number];
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monatText = (iso: string | null | undefined) => (iso ? `${MONATE[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');

/** Einordnung des Spiels: „Hauptrunde · Runde 2“, „Gruppe 3 · März 2027“, „Runde 4 · Platz 2“ */
function spielOrt(s: MeinSpiel, runden: Runde[]): string {
  const r = runden.find((x) => x.id === s.runde_id);
  switch (s.feld) {
    case 'haupt': return `Hauptrunde · Runde ${s.runde}`;
    case 'neben': return `Nebenrunde · Runde ${s.runde}`;
    case 'gruppe': return [s.gruppe != null ? `Gruppe ${s.gruppe}` : null, monatText(r?.monat) || `Runde ${s.runde}`].filter(Boolean).join(' · ');
    case 'runde': return [`Runde ${r?.nr ?? s.runde}`, s.platz != null ? `Platz ${s.platz}` : null].filter(Boolean).join(' · ');
  }
}

export function TurnierMein({ orgName, logo }: OeffentlichProps) {
  const [schluessel] = useState(() => new URLSearchParams(window.location.search).get('z') ?? '');
  const [d, setD] = useState<ZugangDaten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ladefehler, setLadefehler] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<MeinSpiel | null>(null);
  const [abmelden, setAbmelden] = useState(false);
  const [abgemeldet, setAbgemeldet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const Z = `${TO}/zugang/${encodeURIComponent(schluessel)}`;

  const laden = useCallback(() => {
    if (!schluessel) { setLadefehler('Der Link ist unvollständig.'); return; }
    api.get<ZugangDaten>(Z).then((x) => { setD(x); setLadefehler(null); }).catch((e) => setLadefehler(e.message));
  }, [Z, schluessel]);
  useEffect(() => { laden(); }, [laden]);

  async function speichern(e: ErgebnisEingabeWeb) {
    await api.post(`${Z}/ergebnis`, { ...e, spiel_id: ergebnis!.id });
    setErgebnis(null);
    laden();
  }
  async function abmeldenBestaetigt() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${Z}/abmelden`);
      setAbmelden(false);
      setAbgemeldet(r.text);
    } catch (e) { setError((e as Error).message); setAbmelden(false); } finally { setBusy(false); }
  }

  const live = d ? `/turnier-live?t=${encodeURIComponent(d.turnier.kennung)}` : null;
  if (abgemeldet) {
    return (
      <CenterCard title={orgName} subtitle={d?.turnier.name ?? 'Turnier'} logo={logo}>
        <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>{abgemeldet} Dein persönlicher Link gilt damit nicht mehr.</MessageStrip>
        {live && <Button style={{ width: '100%' }} onClick={() => { window.location.href = live; }}>Zur Live-Seite</Button>}
      </CenterCard>
    );
  }
  if (ladefehler) {
    return <CenterCard title={orgName} subtitle="Mein Turnier" logo={logo}><MessageStrip design="Negative" hideCloseButton>{ladefehler}</MessageStrip></CenterCard>;
  }
  if (!d) return <CenterCard title={orgName} subtitle="Mein Turnier" logo={logo}><BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /></CenterCard>;

  const t = d.turnier;
  const Mein = MODUS_UI[t.modus].Mein;
  const darfEintragen = (s: MeinSpiel) => t.status !== 'beendet' && s.wertung !== 'freilos' && s.a.length > 0 && s.b.length > 0
    && d.runden.find((r) => r.id === s.runde_id)?.status !== 'abgeschlossen';
  const ichName = `${d.ich.vorname} ${d.ich.nachname}`;
  // offene Spiele zuerst, danach die gespielten
  const spiele = [...d.spiele].sort((x, y) => Number(x.wertung !== 'offen') - Number(y.wertung !== 'offen'));
  const ausgelost = d.spiele.length > 0;

  return (
    <CenterCard title={orgName} subtitle={t.name} logo={logo} breit>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <Title level="H4">Hallo {d.ich.vorname}!</Title>
      <Text style={{ display: 'block', margin: '0.25rem 0 0.75rem' }}>
        {ichName} · {lkText(d.ich.lk)} · <ObjectStatus state={d.ich.status === 'gemeldet' ? 'Positive' : 'Critical'}>{d.ich.status === 'gemeldet' ? 'gemeldet' : 'Warteliste'}</ObjectStatus>
        <br /><span className="portal-muted">{t.modus_text} · Turnier: {STATUS_TEXT[t.status]}</span>
      </Text>
      {d.ich.status === 'warteliste' && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>
          Du stehst auf der Warteliste und rückst automatisch nach, sobald ein Platz frei wird.
        </MessageStrip>
      )}

      <Title level="H5" style={{ margin: '0.75rem 0 0.5rem' }}>Meine Spiele</Title>
      {!spiele.length ? (
        <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
          {t.status === 'anmeldung' || t.status === 'entwurf' ? 'Noch keine Spiele – die Auslosung folgt nach dem Meldeschluss.' : 'Für dich stehen derzeit keine Spiele an.'}
        </Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
          {spiele.map((s) => {
            const [ids, meine] = s.meine_seite === 'a' ? [s.a, s.namen_a] : [s.b, s.namen_b];
            const gegner = s.meine_seite === 'a' ? s.namen_b : s.namen_a;
            const partner = meine.filter((_, i) => ids[i] !== d.ich.id);
            const text = ergebnisText(s, s.meine_seite);
            const ausgang = s.wertung === 'offen' || s.wertung === 'freilos' || s.wertung === 'keine' || !s.sieger ? null
              : s.sieger === 'x' ? 'Unentschieden' : s.sieger === s.meine_seite ? 'Sieg' : 'Niederlage';
            return (
              <div key={s.id} style={{ border: '1px solid var(--sapList_BorderColor)', borderRadius: '0.5rem', padding: '0.5rem 0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '12rem' }}>
                  <Text className="portal-muted portal-small" style={{ display: 'block' }}>{spielOrt(s, d.runden)}</Text>
                  <Text style={{ display: 'block' }}>
                    {partner.length ? <>mit <b>{partner.join(' / ')}</b> </> : null}
                    gegen <b>{gegner.length ? gegner.join(' / ') : 'noch offen'}</b>
                  </Text>
                  <Text style={{ display: 'block' }}>
                    {s.wertung === 'offen' ? <span className="portal-muted">noch offen</span> : <>{text}{ausgang && <> · <ObjectStatus state={ausgang === 'Sieg' ? 'Positive' : ausgang === 'Niederlage' ? 'Negative' : 'None'}>{ausgang}</ObjectStatus></>}</>}
                  </Text>
                </div>
                {darfEintragen(s) && (
                  <Button design={s.wertung === 'offen' ? 'Emphasized' : 'Default'} icon="edit" onClick={() => setErgebnis(s)}>
                    {s.wertung === 'offen' ? 'Ergebnis eintragen' : 'Ändern'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {Mein && <div style={{ marginBottom: '0.75rem' }}><Mein daten={d} schluessel={schluessel} reload={laden} /></div>}

      <div className="portal-row" style={{ marginTop: '0.75rem' }}>
        {live && <Button design="Emphasized" icon="full-screen" onClick={() => { window.location.href = live; }}>Live-Seite</Button>}
        {!ausgelost && t.status !== 'beendet' && <Button design="Transparent" icon="decline" onClick={() => setAbmelden(true)}>Vom Turnier abmelden</Button>}
      </div>
      {ausgelost && t.status !== 'beendet' && (
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>Abmelden nach der Auslosung bitte direkt bei der Turnierleitung.</Text>
      )}
      <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
        Bitte gib diesen Link nicht weiter – mit ihm lassen sich deine Ergebnisse eintragen. <Link href={live ?? '#'}>Alle Spiele und Tabellen</Link>
      </Text>

      {ergebnis && (
        <ErgebnisDialog offen spiel={ergebnis} namenA={ergebnis.namen_a} namenB={ergebnis.namen_b}
                        art={ergebnis.feld === 'runde' ? 'spass' : 'einzel'} liga={t.modus === 'liga'}
                        onSpeichern={speichern} onSchliessen={() => setErgebnis(null)} />
      )}
      <Dialog open={abmelden} headerText="Vom Turnier abmelden" state="Negative" style={{ width: 'min(26rem, 96vw)' }} onClose={() => setAbmelden(false)}
              footer={<FussLeiste endContent={<>
                <Button design="Negative" loading={busy} onClick={abmeldenBestaetigt}>Abmelden</Button>
                <Button onClick={() => setAbmelden(false)}>Abbrechen</Button>
              </>} />}>
        <Text>Möchtest du dich wirklich von „{t.name}“ abmelden? Dein Platz geht an die erste Person auf der Warteliste; der persönliche Link gilt danach nicht mehr.</Text>
      </Dialog>
    </CenterCard>
  );
}
