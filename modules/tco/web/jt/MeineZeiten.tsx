import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, DatePicker, Dialog, Icon, Input, Label, MessageStrip, ObjectStatus, Text, ToggleButton,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Empty, Section } from '@core/components/Section';
import { PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { TCO, dat, eur } from '../util';
import './meine.css';

/**
 * „Meine Trainingszeiten“ – Rückmeldung der Trainingszeiten durch den Trainer selbst, fürs Handy.
 * Der Server ermittelt den Trainer aus dem angemeldeten Benutzer; fremde Zeiten sind nicht erreichbar.
 * Erfassung wie in „Abrechnung Jugendtraining“: Datum, Trainingsart (Jugendtraining, Schnuppertraining, …), Dauer.
 */
const MZ = `${TCO}/jt/meine`;
type State = 'None' | 'Information' | 'Critical' | 'Positive' | 'Negative';

interface Zeit { adrnr: string; datum: string; trainingsart: string; anzahl: number; satz: number; betrag: number }
interface Ferientag { datum: string; ferien: string | null; feiertag: string | null }
interface Monat {
  monat: string; titel: string; von: string; bis: string; arten: string[]; ferien: Ferientag[];
  trainer: { name: string; satz: number | null }; zeiten: Zeit[]; stunden: number; betrag: number;
  status: { text: string; state: State }; nachweis: { belegnr: string | null; erstellt_am: string | null; bezahlt_am: string | null } | null; gesperrt: boolean;
  /** Freigabe durch den Trainer (Monatsabschluss) */
  freigabe: { am: string; von: string | null } | null;
  /** true = Monat kann freigegeben werden, sonst der Grund */
  freigebbar: true | string;
}
interface Nachweis { monat: string; titel: string; belegnr: string | null; erstellt_am: string | null; bezahlt_am: string | null; stunden: number; betrag: number; freigegeben_am: string | null }
interface Erfassung { datum: string; trainingsart: string; anzahl: string; altArt: string | null }

const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WT_LANG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const DAUERN = [0.5, 1, 1.5, 2, 3];
const zahl = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
const isoHeute = () => new Date().toLocaleDateString('sv-SE');
const wtIdx = (iso: string) => (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7;
const aktMonat = () => isoHeute().slice(0, 7).replace('-', '');
function monatVerschieben(m: string, n: number) {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(4, 6)) - 1 + n, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const klein = () => window.matchMedia?.('(max-width: 700px)').matches ?? false;

/** Auf dem Handy PDFs im neuen Tab öffnen (eingebettete PDFs zeigen mobile Browser oft nicht an) */
async function pdfOeffnen(url: string, onError: (t: string) => void) {
  const w = window.open('', '_blank');
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(JSON.parse((await r.text()) || '{}').message ?? `Fehler ${r.status}`);
    const blobUrl = URL.createObjectURL(await r.blob());
    if (w) w.location.href = blobUrl; else window.location.href = blobUrl;
  } catch (e) {
    w?.close();
    onError((e as Error).message);
  }
}

export function MeineZeiten() {
  const [monat, setMonat] = useState(aktMonat);
  const [m, setM] = useState<Monat | null>(null);
  const [archiv, setArchiv] = useState<Nachweis[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kein, setKein] = useState<string | null>(null);
  const [form, setForm] = useState<Erfassung | null>(null);
  const [tage, setTage] = useState(false);
  const [pdf, setPdf] = useState<{ url: string; titel: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [freigabe, setFreigabe] = useState(false);

  const laden = (mon = monat) => api.get<Monat>(`${MZ}/monat?monat=${mon}`)
    .then((r) => { setM(r); setKein(null); })
    .catch((e) => { if ((e as { status?: number }).status === 403) setKein(e.message); else setError(e.message); });
  useEffect(() => { setM(null); laden(monat); }, [monat]); // eslint-disable-line react-hooks/exhaustive-deps
  const archivLaden = () => api.get<Nachweis[]>(`${MZ}/nachweise`).then(setArchiv).catch(() => setArchiv([]));
  useEffect(() => { archivLaden(); }, []);

  const ferien = new Map<string, Ferientag>((m?.ferien ?? []).map((f) => [f.datum, f]));
  const offen = (m?.zeiten ?? []).filter((z) => !z.anzahl).length;

  async function aktion(fn: () => Promise<unknown>, meldung?: string) {
    setBusy(true); setError(null);
    try { await fn(); if (meldung) toast(meldung); await laden(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }

  const neu = () => {
    if (!m) return;
    const d = isoHeute() >= m.von && isoHeute() <= m.bis ? isoHeute() : m.von;
    setForm({ datum: d, trainingsart: 'Jugendtraining', anzahl: '', altArt: null });
  };
  const bearbeiten = (z: Zeit) => !m?.gesperrt && setForm({ datum: z.datum, trainingsart: z.trainingsart, anzahl: z.anzahl ? String(z.anzahl).replace('.', ',') : '', altArt: z.trainingsart });

  const pdfZeigen = (url: string, titel: string) => (klein() ? pdfOeffnen(url, setError) : setPdf({ url, titel }));

  if (kein) {
    return (
      <AppPage title="Meine Trainingszeiten">
        <div className="portal-mz"><MessageStrip design="Critical" hideCloseButton>{kein}</MessageStrip></div>
      </AppPage>
    );
  }

  return (
    <AppPage title="Meine Trainingszeiten" subtitle={m ? `${m.trainer.name}${m.trainer.satz ? ` · ${eur(m.trainer.satz)} je Stunde` : ''}` : undefined}>
      <div className="portal-mz">
        <div className="portal-mz__monat">
          <Button icon="navigation-left-arrow" design="Transparent" tooltip="Vormonat" onClick={() => setMonat(monatVerschieben(monat, -1))} />
          <div>
            <div className="portal-mz__monat-titel">{m?.titel ?? '…'}</div>
            {monat !== aktMonat() && <Button design="Transparent" onClick={() => setMonat(aktMonat())}>Zum aktuellen Monat</Button>}
          </div>
          <Button icon="navigation-right-arrow" design="Transparent" tooltip="Folgemonat" onClick={() => setMonat(monatVerschieben(monat, 1))} />
        </div>

        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
        {!m && !error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}

        {m && (
          <BusyIndicator active={busy} delay={300} style={{ display: 'block', width: '100%' }}>
            <div className="portal-busy-inhalt">
              {/* Kennzahlen */}
              <div className="portal-mz__kpis">
                <div className="portal-mz__kpi"><span className="portal-mz__kpi-label">Stunden</span><span className="portal-mz__kpi-wert">{zahl(m.stunden)}</span></div>
                <div className="portal-mz__kpi"><span className="portal-mz__kpi-label">Einsätze</span><span className="portal-mz__kpi-wert">{m.zeiten.length}</span></div>
                <div className="portal-mz__kpi"><span className="portal-mz__kpi-label">Betrag</span><span className="portal-mz__kpi-wert">{eur(m.betrag)}</span></div>
                <div className="portal-mz__status">
                  <ObjectStatus state={m.status.state} inverted={m.status.state !== 'None'}>{m.status.text}</ObjectStatus>
                  {offen > 0 && <ObjectStatus state="Critical">{offen} ohne Dauer</ObjectStatus>}
                </div>
              </div>

              {m.gesperrt && (
                <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>
                  {m.freigabe && !m.nachweis?.bezahlt_am
                    ? `Du hast diesen Monat am ${dat(m.freigabe.am.slice(0, 10))} freigegeben. Änderungen bitte über die Jugendleitung.`
                    : 'Dieser Monat ist abgerechnet und bezahlt. Änderungen bitte über die Jugendleitung.'}
                </MessageStrip>
              )}

              {!m.gesperrt && (
                <div className="portal-mz__aktionen">
                  <Button design="Emphasized" icon="add" onClick={neu}>Zeit erfassen</Button>
                  <Button icon="appointment-2" onClick={() => setTage(true)}>Trainingstage anlegen</Button>
                </div>
              )}

              <Section title="Trainingszeiten" count={m.zeiten.length} flush>
                {m.zeiten.length ? (
                  <div className="portal-mz__liste">
                    {m.zeiten.map((z) => {
                      const f = ferien.get(z.datum);
                      return (
                        <button key={`${z.datum}|${z.trainingsart}`} type="button" onClick={() => bearbeiten(z)}
                                className={`portal-mz__eintrag${z.anzahl ? '' : ' portal-mz__eintrag--offen'}${m.gesperrt ? ' portal-mz__eintrag--gesperrt' : ''}`}>
                          <div className="portal-mz__tag">
                            <span className="portal-mz__tag-nr">{Number(z.datum.slice(8, 10))}</span>
                            <span className="portal-mz__tag-wt">{WT[wtIdx(z.datum)]}</span>
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div className="portal-mz__art">{z.trainingsart}</div>
                            <div className="portal-mz__info">
                              <span>{dat(z.datum)}</span>
                              {f?.ferien && <ObjectStatus state="Indication07">{f.ferien}</ObjectStatus>}
                              {f?.feiertag && <ObjectStatus state="Indication01">{f.feiertag}</ObjectStatus>}
                            </div>
                          </div>
                          <div className="portal-mz__dauer">
                            {z.anzahl
                              ? <><div className="portal-mz__dauer-std">{zahl(z.anzahl)} Std.</div><div className="portal-mz__dauer-eur">{eur(z.betrag)}</div></>
                              : <ObjectStatus state="Critical">Dauer fehlt</ObjectStatus>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : <Empty>Für {m.titel} sind noch keine Zeiten erfasst.</Empty>}
              </Section>

              <Section title="Zeitnachweis" actions={undefined}>
                <div className="portal-row" style={{ justifyContent: 'space-between' }}>
                  <Text>
                    {m.nachweis
                      ? <>Abgelegt{m.nachweis.erstellt_am ? ` am ${dat(m.nachweis.erstellt_am)}` : ''}{m.nachweis.bezahlt_am ? `, bezahlt am ${dat(m.nachweis.bezahlt_am)}` : ''}{m.nachweis.belegnr ? ` · ${m.nachweis.belegnr}` : ''}</>
                      : 'Noch nicht abgelegt – nach Monatsende gibst du den Nachweis hier frei.'}
                  </Text>
                  {m.freigabe && (
                    <ObjectStatus state={m.nachweis?.bezahlt_am ? 'Positive' : 'Information'} inverted icon={<Icon name="approvals" />}>
                      Freigegeben {dat(m.freigabe.am.slice(0, 10))}
                    </ObjectStatus>
                  )}
                </div>
                {!m.freigabe && !m.gesperrt && m.freigebbar !== true && m.stunden > 0 && (
                  <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>{m.freigebbar}</Text>
                )}
                <div className="portal-mz__aktionen" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                  {!m.freigabe && !m.gesperrt && (
                    <Button design="Emphasized" icon="approvals" disabled={m.freigebbar !== true || busy} onClick={() => setFreigabe(true)}>Monat freigeben</Button>
                  )}
                  <Button icon="show" disabled={!m.stunden} onClick={() => pdfZeigen(`${MZ}/nachweis/pdf?monat=${m.monat}`, `Zeitnachweis ${m.titel} (aktueller Stand)`)}>Voransicht</Button>
                  <Button icon="pdf-attachment" disabled={!m.nachweis} onClick={() => pdfZeigen(`${MZ}/nachweis/dokument?monat=${m.monat}`, `Zeitnachweis ${m.titel}`)}>Abgelegter Nachweis</Button>
                </div>
              </Section>

              <Section title="Meine Zeitnachweise" count={archiv?.length ?? 0} flush>
                {archiv?.length ? (
                  <div className="portal-mz__liste">
                    {archiv.map((a) => (
                      <button key={a.monat} type="button" className="portal-mz__eintrag" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}
                              onClick={() => pdfZeigen(`${MZ}/nachweis/dokument?monat=${a.monat}`, `Zeitnachweis ${a.titel}`)}>
                        <div style={{ minWidth: 0 }}>
                          <div className="portal-mz__art">{a.titel}</div>
                          <div className="portal-mz__info">
                            <span>{zahl(a.stunden)} Std. · {eur(a.betrag)}</span>
                            {a.bezahlt_am ? <ObjectStatus state="Positive">bezahlt {dat(a.bezahlt_am)}</ObjectStatus>
                              : a.freigegeben_am ? <ObjectStatus state="Information">freigegeben {dat(a.freigegeben_am)}</ObjectStatus>
                                : <ObjectStatus state="Critical">offen</ObjectStatus>}
                          </div>
                        </div>
                        <Icon name="pdf-attachment" style={{ color: 'var(--sapContent_IconColor)' }} />
                      </button>
                    ))}
                  </div>
                ) : <Empty>{archiv ? 'Noch keine abgelegten Zeitnachweise.' : 'Wird geladen …'}</Empty>}
              </Section>
            </div>
          </BusyIndicator>
        )}
      </div>

      {form && m && (
        <ErfassungDialog m={m} f={form} setF={setForm} busy={busy} onClose={() => setForm(null)}
                         onSpeichern={async (anzahl) => {
                           if (await aktion(() => api.post(`${MZ}/zeiten`, { datum: form.datum, trainingsart: form.trainingsart, anzahl, altArt: form.altArt }), 'Gespeichert.')) setForm(null);
                         }}
                         onLoeschen={async () => {
                           if (form.altArt && await aktion(() => api.post(`${MZ}/zeiten/loeschen`, { datum: form.datum, trainingsart: form.altArt }), 'Gelöscht.')) setForm(null);
                         }} />
      )}
      {tage && m && <TageDialog m={m} busy={busy} onClose={() => setTage(false)}
                                onAnlegen={async (wochentage, trainingsart) => {
                                  let text = '';
                                  if (await aktion(async () => { text = (await api.post<{ text: string }>(`${MZ}/generieren`, { monat: m.monat, wochentage, trainingsart })).text; })) {
                                    toast(text); setTage(false);
                                  }
                                }} />}
      {freigabe && m && createPortal(
        <Dialog open headerText={`${m.titel} freigeben`} onClose={() => setFreigabe(false)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" icon="approvals" disabled={busy}
                          onClick={async () => {
                            let text = '';
                            const ok = await aktion(async () => {
                              const r = await api.post<{ text: string; warnungen: string[] }>(`${MZ}/freigeben`, { monat: m.monat });
                              text = r.text;
                            });
                            setFreigabe(false);
                            if (ok) { toast(text, 6000); archivLaden(); }
                          }}>Freigeben</Button>
                  <Button onClick={() => setFreigabe(false)}>Abbrechen</Button>
                </>} />}>
          <div className="portal-mz__form" style={{ maxWidth: '26rem' }}>
            <Text>
              Mit der Freigabe bestätigst du {zahl(m.stunden)} Stunden ({eur(m.betrag)}) für {m.titel}. Der Zeitnachweis wird abgelegt und
              an die Jugendleitung zur Zahlung weitergegeben. Danach kannst du die Zeiten des Monats nicht mehr ändern.
            </Text>
            <Text className="portal-muted portal-small">Nach der Zahlung erhältst du hier den Nachweis mit Zahlvermerk als neue Fassung.</Text>
          </div>
        </Dialog>,
        document.body,
      )}
      {pdf && <PdfDialog url={pdf.url} title={pdf.titel} filename={`${pdf.titel.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.pdf`} onClose={() => setPdf(null)} />}
    </AppPage>
  );
}

// ---------------------------------------------------------------- Erfassung (Datum, Trainingsart, Dauer)
function ErfassungDialog({ m, f, setF, busy, onClose, onSpeichern, onLoeschen }: {
  m: Monat; f: Erfassung; setF: (f: Erfassung) => void; busy: boolean; onClose: () => void;
  onSpeichern: (anzahl: number) => void; onLoeschen: () => void;
}) {
  const n = f.anzahl.trim() === '' ? 0 : Number(f.anzahl.replace(',', '.'));
  const gueltig = Number.isFinite(n) && n >= 0 && n <= 24;
  const fer = m.ferien.find((x) => x.datum === f.datum);
  const imMonat = f.datum >= m.von && f.datum <= m.bis;
  return createPortal(
    <Dialog open stretch={klein()} headerText={f.altArt ? 'Zeit ändern' : 'Zeit erfassen'} onClose={onClose}
            footer={<Bar endContent={<>
              {f.altArt && <Button design="Negative" icon="delete" disabled={busy} onClick={onLoeschen}>Löschen</Button>}
              <Button design="Emphasized" disabled={busy || !gueltig || !imMonat} onClick={() => onSpeichern(n)}>Speichern</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-mz__form">
        <div className="portal-mz__feld">
          <Label required>Datum</Label>
          <DatePicker formatPattern="EEEE, dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.datum} minDate={m.von} maxDate={m.bis} style={{ width: '100%' }}
                      disabled={!!f.altArt} onChange={(e) => e.detail.value && setF({ ...f, datum: e.detail.value })} />
          {fer?.ferien && <ObjectStatus state="Indication07">Schulferien: {fer.ferien}</ObjectStatus>}
          {fer?.feiertag && <ObjectStatus state="Indication01">Feiertag: {fer.feiertag}</ObjectStatus>}
          {!imMonat && <ObjectStatus state="Negative">Bitte ein Datum im {m.titel} wählen.</ObjectStatus>}
        </div>
        <div className="portal-mz__feld">
          <Label required>Trainingsart</Label>
          <div className="portal-mz__arten">
            {m.arten.map((a) => (
              <ToggleButton key={a} pressed={f.trainingsart === a} design={f.trainingsart === a ? 'Emphasized' : 'Default'}
                            onClick={() => setF({ ...f, trainingsart: a })}>{a}</ToggleButton>
            ))}
          </div>
        </div>
        <div className="portal-mz__feld">
          <Label required>Dauer in Stunden</Label>
          <div className="portal-mz__chips">
            {DAUERN.map((d) => (
              <ToggleButton key={d} pressed={n === d} onClick={() => setF({ ...f, anzahl: String(d).replace('.', ',') })}>{zahl(d)}</ToggleButton>
            ))}
          </div>
          <Input type="Text" placeholder="z. B. 1,5" value={f.anzahl} style={{ width: '100%' }}
                 valueState={gueltig ? 'None' : 'Negative'} onInput={(e) => setF({ ...f, anzahl: e.target.value })} />
          {gueltig && n > 0 && m.trainer.satz ? <Text className="portal-muted portal-small">≈ {eur(Math.round(n * m.trainer.satz * 100) / 100)} bei {eur(m.trainer.satz)} je Stunde</Text> : null}
          {!gueltig && <Text style={{ color: 'var(--sapNegativeTextColor)' }} className="portal-small">Bitte eine Dauer zwischen 0 und 24 Stunden angeben.</Text>}
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}

// ---------------------------------------------------------------- Trainingstage anlegen (Wochentage des Monats)
function TageDialog({ m, busy, onClose, onAnlegen }: { m: Monat; busy: boolean; onClose: () => void; onAnlegen: (wochentage: number[], art: string) => void }) {
  const [wt, setWt] = useState<number[]>([]);
  const [art, setArt] = useState('Jugendtraining');
  return createPortal(
    <Dialog open stretch={klein()} headerText={`Trainingstage im ${m.titel} anlegen`} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={busy || !wt.length} onClick={() => onAnlegen(wt, art)}>Anlegen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-mz__form">
        <Text>Legt für jeden gewählten Wochentag im Monat einen Eintrag an (ohne Dauer). Bereits erfasste Tage bleiben unverändert – die Dauer danach je Tag eintragen.</Text>
        <div className="portal-mz__feld">
          <Label required>Wochentage</Label>
          <div className="portal-mz__wtage">
            {WT.map((t, i) => (
              <ToggleButton key={t} tooltip={WT_LANG[i]} pressed={wt.includes(i + 1)} design={wt.includes(i + 1) ? 'Emphasized' : 'Default'}
                            onClick={() => setWt(wt.includes(i + 1) ? wt.filter((x) => x !== i + 1) : [...wt, i + 1])}>{t}</ToggleButton>
            ))}
          </div>
        </div>
        <div className="portal-mz__feld">
          <Label required>Trainingsart</Label>
          <div className="portal-mz__arten">
            {m.arten.map((a) => (
              <ToggleButton key={a} pressed={art === a} design={art === a ? 'Emphasized' : 'Default'} onClick={() => setArt(a)}>{a}</ToggleButton>
            ))}
          </div>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
