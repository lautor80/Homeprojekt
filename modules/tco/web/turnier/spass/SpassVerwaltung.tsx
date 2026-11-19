import { useEffect, useState } from 'react';
import { BusyIndicator, Button, CheckBox, FlexBox, Input, Label, Link, MessageStrip, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { toast } from '@core/toast';
import { ErgebnisDialog } from '../ErgebnisDialog';
import { STANDARD_EINSTELLUNGEN, T, vollname, type ErgebnisEingabeWeb, type LiveDaten, type SpassEinstellungen, type Spiel, type VerwaltungProps } from '../api';
import type { SpassLiveDaten, SpassPlatzDaten } from '../../../server/turnier/spass-logik';
import { Platzkarte, Rangliste, RUNDE_STATUS_TEXT, Uhr } from './SpassLive';
import './spass.css';

/**
 * Turniere – Verwaltung Spaßturnier (Reiter „Runden“): Einstellungen (Plätze, Minuten, Runden), Pausenwünsche für die
 * nächste Runde, Runde auslosen/starten/abschließen, Ergebnisse je Platz, QR-Code für die Eingabe am Platz, Rangliste.
 */
const QR_SPEICHER = (id: number) => `tco-turnier-spass-qr-${id}`;
interface Qr { link: string; qr: string; absolut: boolean }

function qrLesen(id: number): Qr | null {
  try { const s = localStorage.getItem(QR_SPEICHER(id)); return s ? JSON.parse(s) as Qr : null; } catch { return null; }
}
function qrMerken(id: number, q: Qr) {
  try { localStorage.setItem(QR_SPEICHER(id), JSON.stringify(q)); } catch { /* ohne Speicher: nur bis zum Neuladen sichtbar */ }
}

export function SpassVerwaltung({ detail, darfPflegen, reload }: VerwaltungProps) {
  const t = detail.turnier;
  const { data: live, error, reload: liveNeu } = useLoad(() => api.get<LiveDaten<SpassLiveDaten>>(`${T}/${t.id}/live`), [t.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<SpassPlatzDaten | null>(null);
  const [neuLosen, setNeuLosen] = useState(false);
  const [qr, setQr] = useState<Qr | null>(() => qrLesen(t.id));
  const [qrNeu, setQrNeu] = useState(false);

  // alle 30 s aktualisieren (Ergebnisse vom Platz-QR)
  useEffect(() => { const h = setInterval(liveNeu, 30_000); return () => clearInterval(h); }, [liveNeu]);

  const name = (id: number) => {
    const x = detail.teilnehmer.find((y) => y.id === id);
    return x ? vollname(x) : live?.teilnehmer.find((y) => y.id === id)?.name ?? '?';
  };
  const alles = () => { liveNeu(); reload(); };

  async function aktion(schluessel: string, fn: () => Promise<unknown>, meldung: string) {
    setBusy(schluessel); setFehler(null);
    try { await fn(); toast(meldung); alles(); } catch (e) { setFehler((e as Error).message); } finally { setBusy(null); }
  }

  const d = live?.daten;
  const r = d?.runde ?? null;
  const kannLosen = !r || r.status === 'abgeschlossen';
  const gemeldet = detail.teilnehmer.filter((x) => x.status === 'gemeldet');
  const wuensche = new Set(d?.pause_naechste ?? []);

  async function ergebnisSpeichern(e: ErgebnisEingabeWeb) {
    await api.post(`${T}/${t.id}/spiele/${ergebnis!.spiel_id}/ergebnis`, { wertung: 'gespielt', saetze: e.saetze });
    toast('Ergebnis gespeichert.');
    setErgebnis(null);
    alles();
  }
  const spielZu = (p: SpassPlatzDaten): Spiel => detail.spiele.find((s) => s.id === p.spiel_id)
    ?? { id: p.spiel_id, turnier_id: t.id, runde_id: r?.id ?? null, feld: 'runde', runde: r?.nr ?? 0, pos: p.platz, gruppe: null, platz: p.platz,
         a: p.a, b: p.b, saetze: p.saetze, wertung: p.wertung, sieger: p.sieger, bemueht: null, eingetragen_von: null, eingetragen_am: null };

  async function qrErzeugen() {
    setQrNeu(false);
    await aktion('qr', async () => {
      const q = await api.post<Qr>(`${T}/${t.id}/spass/qr`);
      qrMerken(t.id, q); setQr(q);
    }, 'Neuer Platz-Link erzeugt.');
  }

  return (
    <div className="spass">
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)}>{fehler}</MessageStrip>}
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}

      <Einstellungen detail={detail} darfPflegen={darfPflegen} reload={alles} />

      {!d ? !error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <>
          <Section title={r ? `Runde ${r.nr}${d.einstellungen.runden ? ` von ${d.einstellungen.runden}` : ''}` : 'Runden'}
                   status={r ? <Text className="portal-muted">{RUNDE_STATUS_TEXT[r.status]} · {r.minuten} Minuten</Text> : undefined}
                   actions={darfPflegen && <>
                     {kannLosen && !d.fertig && (
                       <Button design="Emphasized" icon="add" loading={busy === 'losen'}
                               onClick={() => aktion('losen', () => api.post(`${T}/${t.id}/spass/runde`), r ? 'Nächste Runde ausgelost.' : 'Erste Runde ausgelost.')}>
                         {r ? 'Nächste Runde auslosen' : 'Erste Runde auslosen'}
                       </Button>
                     )}
                     {r?.status === 'geplant' && <>
                       <Button design="Emphasized" icon="media-play" loading={busy === 'start'}
                               onClick={() => aktion('start', () => api.post(`${T}/${t.id}/spass/runde/${r.nr}/start`), `Runde ${r.nr} läuft – ${r.minuten} Minuten.`)}>
                         Runde starten
                       </Button>
                       <Button icon="restart" loading={busy === 'neu'} onClick={() => setNeuLosen(true)}>Neu losen</Button>
                     </>}
                     {r?.status === 'laeuft' && (
                       <Button design="Emphasized" icon="stop" loading={busy === 'ende'}
                               onClick={() => aktion('ende', () => api.post(`${T}/${t.id}/spass/runde/${r.nr}/abschliessen`), `Runde ${r.nr} abgeschlossen.`)}>
                         Runde abschließen
                       </Button>
                     )}
                   </>}>
            {!r && <MessageStrip hideCloseButton>Noch keine Runde ausgelost. Vor dem Auslosen die Pausenwünsche unten setzen; es werden {d.einstellungen.plaetze} Plätze belegt.</MessageStrip>}
            {d.fertig && kannLosen && <MessageStrip design="Positive" hideCloseButton>Alle {d.einstellungen.runden} Runden sind gespielt. Für weitere Runden die Rundenzahl in den Einstellungen erhöhen.</MessageStrip>}
            {r && (
              <>
                <div className="spass-kopf" style={{ marginBottom: '0.5rem' }}>
                  <Uhr endeUm={r.endeUm} stand={live!.stand} status={r.status} />
                  {r.status === 'laeuft' && r.plaetze.some((p) => p.wertung === 'offen') && (
                    <span className="spass-label">Offene Spiele bleiben beim Abschließen ungewertet.</span>
                  )}
                </div>
                <div className="spass-plaetze">
                  {r.plaetze.map((p) => (
                    <Platzkarte key={p.spiel_id} p={p} name={name}
                                aktion={darfPflegen && r.status !== 'geplant' && t.status !== 'beendet'
                                  ? <Button icon="edit" design="Transparent" onClick={() => setErgebnis(p)}>{p.wertung === 'offen' ? 'Ergebnis eintragen' : 'Ergebnis ändern'}</Button>
                                  : undefined} />
                  ))}
                </div>
                {r.pausen.length > 0 && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <div className="spass-label" style={{ marginBottom: '0.25rem' }}>Pause in Runde {r.nr}</div>
                    <div className="spass-pausen">
                      {r.pausen.map((id) => <span key={id} className="spass-chip">{name(id)}{r.pausen_gewuenscht.includes(id) ? ' (gewünscht)' : ''}</span>)}
                    </div>
                  </div>
                )}
              </>
            )}
            {d.runden.length > 1 && (
              <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.75rem' }}>
                Bisher: {d.runden.map((x) => `Runde ${x.nr}: ${x.gewertet} von ${x.spiele} gewertet`).join(' · ')}
              </Text>
            )}
          </Section>

          <Section title="Pause in der nächsten Runde" count={`${wuensche.size} von ${gemeldet.length}`}>
            <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>
              Wer hier angehakt ist, pausiert bei der nächsten Auslosung bewusst. Sonst bekommen Pausen die, die am häufigsten gespielt haben –
              so spielen alle möglichst gleich oft. Teilnehmende können das auch über ihren persönlichen Link selbst setzen.
            </Text>
            {!gemeldet.length ? <MessageStrip hideCloseButton>Noch keine Teilnehmenden gemeldet.</MessageStrip> : (
              <FlexBox wrap="Wrap" style={{ gap: '0 1rem' }}>
                {gemeldet.map((x) => (
                  <CheckBox key={x.id} text={vollname(x)} checked={wuensche.has(x.id)} disabled={!darfPflegen || busy === `p${x.id}`}
                            onChange={(e) => aktion(`p${x.id}`, () => api.put(`${T}/${t.id}/spass/pause`, { teilnehmer_id: x.id, pause: e.target.checked }),
                              e.target.checked ? `${x.vorname} pausiert in der nächsten Runde.` : `${x.vorname} spielt in der nächsten Runde mit.`)} />
                ))}
              </FlexBox>
            )}
          </Section>

          <Section title="QR-Code für die Plätze"
                   actions={darfPflegen && <Button icon="qr-code" loading={busy === 'qr'} onClick={() => (qr ? setQrNeu(true) : qrErzeugen())}>{qr ? 'Neuen Code erzeugen' : 'QR-Code erzeugen'}</Button>}>
            <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>
              Ausdrucken und an die Plätze hängen: Darüber tragen die Spielenden nach Ablauf der Zeit die Spiele je Team selbst ein
              (nur in der laufenden Runde). Ein neuer Code macht den alten ungültig.
            </Text>
            {qr ? (
              <FlexBox wrap="Wrap" alignItems="Center" style={{ gap: '1rem' }}>
                <img src={qr.qr} alt="QR-Code für die Eingabe am Platz" style={{ width: '11rem', height: '11rem', background: '#fff', padding: '0.5rem', borderRadius: '0.5rem' }} />
                <FlexBox direction="Column" style={{ gap: '0.25rem', minWidth: 0 }}>
                  <Link href={qr.link} target="_blank" wrappingType="Normal">{qr.link}</Link>
                  {!qr.absolut && <MessageStrip design="Critical" hideCloseButton>Die Portal-Adresse ist in den Einstellungen nicht eingetragen – der QR-Code enthält nur einen relativen Link.</MessageStrip>}
                </FlexBox>
              </FlexBox>
            ) : <MessageStrip hideCloseButton>Noch kein QR-Code in diesem Browser erzeugt.</MessageStrip>}
          </Section>

          <Section title="Rangliste" count={d.rangliste.length}>
            <Rangliste zeilen={d.rangliste} name={name} />
          </Section>
        </>
      )}

      {ergebnis && (
        <ErgebnisDialog offen spiel={spielZu(ergebnis)} art="spass" namenA={ergebnis.a.map(name)} namenB={ergebnis.b.map(name)}
                        onSpeichern={ergebnisSpeichern} onSchliessen={() => setErgebnis(null)} />
      )}
      <ConfirmDialog open={neuLosen} title="Runde neu losen" confirmText="Neu losen" onCancel={() => setNeuLosen(false)}
                     text={`Runde ${r?.nr ?? ''} wird gelöscht und mit den aktuellen Pausenwünschen neu ausgelost.`}
                     onConfirm={() => { setNeuLosen(false); if (r) aktion('neu', async () => { await api.del(`${T}/${t.id}/spass/runde/${r.nr}`); await api.post(`${T}/${t.id}/spass/runde`); }, `Runde ${r.nr} neu ausgelost.`); }} />
      <ConfirmDialog open={qrNeu} title="Neuen QR-Code erzeugen" confirmText="Erzeugen" onCancel={() => setQrNeu(false)} onConfirm={qrErzeugen}
                     text="Der bisherige QR-Code (auch ausgedruckte) funktioniert danach nicht mehr." />
    </div>
  );
}

/** Einstellungen Plätze / Minuten / Runden – gespeichert über PUT /turniere/:id mit allen Turnierfeldern */
function Einstellungen({ detail, darfPflegen, reload }: VerwaltungProps) {
  const t = detail.turnier;
  const e = { ...STANDARD_EINSTELLUNGEN.spass, ...(t.einstellungen as Partial<SpassEinstellungen>) };
  const [w, setW] = useState({ plaetze: String(e.plaetze), minuten: String(e.minuten), runden: String(e.runden) });
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { setW({ plaetze: String(e.plaetze), minuten: String(e.minuten), runden: String(e.runden) }); }, [e.plaetze, e.minuten, e.runden]);

  const zahl = (v: string, min: number, max: number) => (/^\d{1,3}$/.test(v.trim()) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  const n = { plaetze: zahl(w.plaetze, 1, 64), minuten: zahl(w.minuten, 1, 240), runden: zahl(w.runden, 0, 99) };
  const ok = n.plaetze !== null && n.minuten !== null && n.runden !== null;
  const geaendert = ok && (n.plaetze !== e.plaetze || n.minuten !== e.minuten || n.runden !== e.runden);

  async function speichern() {
    setBusy(true); setFehler(null);
    try {
      await api.put(`${T}/${t.id}`, {
        name: t.name, kennung: t.kennung, modus: t.modus, status: t.status, beschreibung: t.beschreibung, meldeschluss: t.meldeschluss,
        max_teilnehmer: t.max_teilnehmer, einstellungen: { ...t.einstellungen, ...n },
      });
      toast('Einstellungen gespeichert.');
      reload();
    } catch (x) { setFehler((x as Error).message); } finally { setBusy(false); }
  }
  const feld = (k: keyof typeof w, label: string, hinweis: string) => (
    <FlexBox direction="Column" style={{ gap: '0.25rem', minWidth: '8rem', flex: '1 1 8rem' }}>
      <Label showColon>{label}</Label>
      <Input type="Number" value={w[k]} disabled={!darfPflegen} onInput={(x) => setW({ ...w, [k]: x.target.value })}
             valueState={n[k] === null ? 'Negative' : 'None'} valueStateMessage={<div>{hinweis}</div>} />
    </FlexBox>
  );
  return (
    <Section title="Einstellungen"
             actions={darfPflegen && <Button design="Emphasized" icon="save" disabled={!geaendert} loading={busy} onClick={speichern}>Speichern</Button>}>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <FlexBox wrap="Wrap" style={{ gap: '0.5rem 1rem' }}>
        {feld('plaetze', 'Plätze', '1 bis 64')}
        {feld('minuten', 'Minuten je Runde', '1 bis 240')}
        {feld('runden', 'Runden (0 = offen)', '0 bis 99')}
      </FlexBox>
      <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
        Je Runde spielen höchstens 4 × Plätze Personen Doppel. Nach jeder Runde wird neu gelost: Partner möglichst nie doppelt, Gegner möglichst selten.
        Geänderte Minuten gelten ab der nächsten Auslosung.
      </Text>
    </Section>
  );
}
