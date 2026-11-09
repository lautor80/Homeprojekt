import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, DatePicker, Dialog, Icon, Input, Label, MessageStrip, ObjectStatus, Text, TextArea, ToggleButton,
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
  freigabe: { am: string; von: string | null; oeffnung_angefragt_am: string | null; oeffnung_grund: string | null } | null;
  /** laufender Monat – Einreichen vor Monatsende */
  vorzeitig: boolean;
  /** true = Monat kann freigegeben werden, sonst der Grund */
  freigebbar: true | string;
}
interface Nachweis { monat: string; titel: string; belegnr: string | null; erstellt_am: string | null; bezahlt_am: string | null; stunden: number; betrag: number; freigegeben_am: string | null }
interface Erfassung { datum: string; trainingsart: string; anzahl: string; altArt: string | null }

const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WT_LANG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
/** Schnellwahl der Dauer – bis zu ganztägigen Einsätzen (z. B. Camp, Turnierbetreuung) */
const DAUERN = [1, 1.5, 2, 3, 4, 5, 6, 8];
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
  const [oeffnung, setOeffnung] = useState<string | null>(null);

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

              <MonatsKalender m={m} ferien={ferien} onTag={(d) => {
                if (m.gesperrt) return;
                const vorhanden = m.zeiten.filter((z) => z.datum === d);
                if (vorhanden.length === 1) bearbeiten(vorhanden[0]);
                else setForm({ datum: d, trainingsart: vorhanden.length ? m.arten.find((a) => !vorhanden.some((z) => z.trainingsart === a)) ?? 'Jugendtraining' : 'Jugendtraining', anzahl: '', altArt: null });
              }} />

              {m.gesperrt && (
                <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>
                  {m.freigabe && !m.nachweis?.bezahlt_am
                    ? m.freigabe.oeffnung_angefragt_am
                      ? `Freigegeben am ${dat(m.freigabe.am.slice(0, 10))} – deine Anfrage auf Öffnung vom ${dat(m.freigabe.oeffnung_angefragt_am.slice(0, 10))} liegt beim Kassenwart.`
                      : `Du hast diesen Monat am ${dat(m.freigabe.am.slice(0, 10))} freigegeben. Öffnen kann ihn nur noch der Kassenwart.`
                    : 'Dieser Monat ist abgerechnet und bezahlt. Änderungen bitte über den Kassenwart.'}
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
                    <Button design="Emphasized" icon="approvals" disabled={m.freigebbar !== true || busy} onClick={() => setFreigabe(true)}>
                      {m.vorzeitig ? 'Vorzeitig einreichen' : 'Monat freigeben'}
                    </Button>
                  )}
                  {m.freigabe && !m.nachweis?.bezahlt_am && !m.freigabe.oeffnung_angefragt_am && (
                    <Button icon="unlocked" disabled={busy} onClick={() => setOeffnung('')}>Öffnung anfragen</Button>
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
                          }}>{m.vorzeitig ? 'Vorzeitig einreichen' : 'Freigeben'}</Button>
                  <Button onClick={() => setFreigabe(false)}>Abbrechen</Button>
                </>} />}>
          <div className="portal-mz__form" style={{ maxWidth: '26rem' }}>
            <Text>
              Mit der Freigabe bestätigst du {zahl(m.stunden)} Stunden ({eur(m.betrag)}) für {m.titel}. Der Zeitnachweis wird abgelegt und
              an die Jugendleitung zur Zahlung weitergegeben.
            </Text>
            <MessageStrip design="Critical" hideCloseButton>
              {m.vorzeitig ? `Du reichst vor Monatsende ein. Trainingszeiten, die im ${m.titel} noch dazukommen, kannst du danach nicht mehr selbst erfassen. ` : ''}
              Danach kann der Monat nur noch durch den Kassenwart geöffnet werden.
            </MessageStrip>
            <Text className="portal-muted portal-small">Nach der Zahlung erhältst du hier den Nachweis mit Zahlvermerk als neue Fassung.</Text>
          </div>
        </Dialog>,
        document.body,
      )}
      {oeffnung !== null && m && createPortal(
        <Dialog open headerText={`Öffnung von ${m.titel} anfragen`} onClose={() => setOeffnung(null)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" icon="paper-plane" disabled={busy} onClick={async () => {
                    let text = '';
                    const ok = await aktion(async () => { text = (await api.post<{ text: string }>(`${MZ}/oeffnung`, { monat: m.monat, grund: oeffnung })).text; });
                    setOeffnung(null);
                    if (ok) toast(text, 6000);
                  }}>Anfrage senden</Button>
                  <Button onClick={() => setOeffnung(null)}>Abbrechen</Button>
                </>} />}>
          <div className="portal-mz__form" style={{ maxWidth: '26rem' }}>
            <Text>Der Kassenwart bekommt deine Anfrage im Arbeitsvorrat. Öffnet er den Monat, kannst du wieder Zeiten ändern und neu einreichen.</Text>
            <div className="portal-mz__feld">
              <Label>Was möchtest du ändern? (optional)</Label>
              <TextArea rows={3} value={oeffnung} maxlength={300} onInput={(e) => setOeffnung(e.target.value)} placeholder="z. B. Turnierbetreuung am 28. nachtragen" />
            </div>
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
  const setze = (x: number) => setF({ ...f, anzahl: String(Math.round(x * 4) / 4).replace('.', ',') });
  const [von, setVon] = useState('');
  const [bis, setBis] = useState('');
  const minuten = (t: string) => { const mm = /^(\d{1,2})[:.]?(\d{2})?$/.exec(t.trim()); return mm && Number(mm[1]) < 24 ? Number(mm[1]) * 60 + Number(mm[2] ?? 0) : null; };
  const vonBis = (() => { const a = minuten(von), b = minuten(bis); return a !== null && b !== null && b > a ? Math.round(((b - a) / 60) * 4) / 4 : null; })();
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
          <div className="portal-mz__stepper">
            <Button icon="less" disabled={n <= 0} accessibleName="eine halbe Stunde weniger" onClick={() => setze(Math.max(0, (Number.isFinite(n) ? n : 0) - 0.5))} />
            <div className="portal-mz__stepper-wert">
              <Input type="Text" inputMode="decimal" value={f.anzahl} placeholder="0" style={{ width: '100%', textAlign: 'center' }}
                     valueState={gueltig ? 'None' : 'Negative'} onInput={(e) => setF({ ...f, anzahl: e.target.value })} accessibleName="Dauer in Stunden" />
              <span>Std.</span>
            </div>
            <Button icon="add" accessibleName="eine halbe Stunde mehr" onClick={() => setze(Math.min(24, (Number.isFinite(n) ? n : 0) + 0.5))} />
          </div>
          <div className="portal-mz__chips">
            {DAUERN.map((d) => (
              <ToggleButton key={d} pressed={n === d} onClick={() => setze(d)}>{zahl(d)}</ToggleButton>
            ))}
          </div>
          <details className="portal-mz__vonbis">
            <summary>Aus Uhrzeit berechnen</summary>
            <div className="portal-mz__vonbis-felder">
              <Input type="Text" placeholder="von 09:00" value={von} onInput={(e) => setVon(e.target.value)} style={{ width: '100%' }} accessibleName="Beginn" />
              <Input type="Text" placeholder="bis 15:00" value={bis} onInput={(e) => setBis(e.target.value)} style={{ width: '100%' }} accessibleName="Ende" />
              <Button disabled={vonBis === null} onClick={() => vonBis !== null && setze(vonBis)}>Übernehmen{vonBis !== null ? ` (${zahl(vonBis)} Std.)` : ''}</Button>
            </div>
            <Text className="portal-muted portal-small">Pausen bitte abziehen – mehrere Einheiten am Tag einfach zusammenzählen oder je Trainingsart erfassen.</Text>
          </details>
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

// ---------------------------------------------------------------- Monatsübersicht mit Ferien und Feiertagen
function MonatsKalender({ m, ferien, onTag }: { m: Monat; ferien: Map<string, Ferientag>; onTag: (d: string) => void }) {
  const tage: (string | null)[] = [];
  for (let i = 0; i < wtIdx(m.von); i++) tage.push(null);
  for (let d = m.von; d <= m.bis; d = new Date(Date.parse(`${d}T12:00:00Z`) + 864e5).toISOString().slice(0, 10)) tage.push(d);
  const heute = isoHeute();
  const std = new Map<string, number>();
  const offen = new Set<string>();
  for (const z of m.zeiten) { std.set(z.datum, (std.get(z.datum) ?? 0) + z.anzahl); if (!z.anzahl) offen.add(z.datum); }
  // Ferienabschnitte und Feiertage des Monats als Liste
  const abschnitte: { text: string; von: string; bis: string; art: 'ferien' | 'feiertag' }[] = [];
  for (const f of [...ferien.values()].sort((a, b) => a.datum.localeCompare(b.datum))) {
    if (f.feiertag) abschnitte.push({ text: f.feiertag, von: f.datum, bis: f.datum, art: 'feiertag' });
    if (f.ferien) {
      const l = [...abschnitte].reverse().find((x) => x.art === 'ferien');
      const vortag = new Date(Date.parse(`${f.datum}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
      if (l && l.text === f.ferien && l.bis >= vortag) l.bis = f.datum; else abschnitte.push({ text: f.ferien, von: f.datum, bis: f.datum, art: 'ferien' });
    }
  }
  return (
    <Section title="Monatsübersicht" flush>
      <div className="portal-mz__kal">
        {WT.map((t) => <div key={t} className="portal-mz__kal-kopf">{t}</div>)}
        {tage.map((d, i) => {
          if (!d) return <div key={`l${i}`} />;
          const f = ferien.get(d);
          const h = std.get(d);
          const kl = ['portal-mz__kal-tag', f?.feiertag ? 'portal-mz__kal-tag--feiertag' : f?.ferien ? 'portal-mz__kal-tag--ferien' : '',
            wtIdx(d) >= 5 ? 'portal-mz__kal-tag--we' : '', d === heute ? 'portal-mz__kal-tag--heute' : '',
            offen.has(d) ? 'portal-mz__kal-tag--offen' : h ? 'portal-mz__kal-tag--erfasst' : ''].filter(Boolean).join(' ');
          return (
            <button key={d} type="button" className={kl} onClick={() => onTag(d)}
                    title={[WT_LANG[wtIdx(d)], f?.feiertag, f?.ferien, h ? `${zahl(h)} Std.` : offen.has(d) ? 'Dauer fehlt' : ''].filter(Boolean).join(' · ')}>
              <span className="portal-mz__kal-nr">{Number(d.slice(8, 10))}</span>
              <span className="portal-mz__kal-std">{h ? `${zahl(h)}h` : offen.has(d) ? '?' : ''}</span>
            </button>
          );
        })}
      </div>
      <div className="portal-mz__kal-legende">
        <span><i className="portal-mz__kal-punkt portal-mz__kal-punkt--erfasst" />Stunden erfasst</span>
        <span><i className="portal-mz__kal-punkt portal-mz__kal-punkt--offen" />Dauer fehlt</span>
        <span><i className="portal-mz__kal-punkt portal-mz__kal-punkt--ferien" />Schulferien</span>
        <span><i className="portal-mz__kal-punkt portal-mz__kal-punkt--feiertag" />Feiertag</span>
      </div>
      {abschnitte.length > 0 && (
        <div className="portal-mz__kal-liste">
          {abschnitte.map((a) => (
            <ObjectStatus key={`${a.art}${a.von}`} state={a.art === 'feiertag' ? 'Indication01' : 'Indication07'}>
              {a.von === a.bis ? dat(a.von) : `${dat(a.von).slice(0, 6)}–${dat(a.bis)}`} {a.text}
            </ObjectStatus>
          ))}
        </div>
      )}
    </Section>
  );
}
