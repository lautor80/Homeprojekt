import { Fragment, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Bar, BusyIndicator, Button, DatePicker, Dialog, Icon, Input, Label, MessageStrip, ObjectStatus, Option, SegmentedButton,
  SegmentedButtonItem, Select, Text, ToggleButton,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { useSperre } from '@core/sperre';
import { useCan } from '@core/session';
import { TCO, dat, eur } from '../util';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { PdfDialog } from '@core/components/PdfDialog';
import '../jt/meine.css';
import './platz.css';
import { AboBewerbung } from './AboBewerbung';
// Farben der Preise wie im Wochenplan der Hallenpreise (portal-hpw__f0 … f4)
import '../hallenpreise.css';

/**
 * „Platz buchen“ – Freiplätze und Halle, fürs Handy und das Portal.
 * Kalender: je Platz eine Spalte; eigene Buchungen mit Preis, fremde nur „belegt“.
 * Meine Buchungen: Einzelbuchungen (anlegen, ändern, stornieren) und Abos (Anlage über die Platzverwaltung; bei Abos mit
 * Einzelabrechnung storniert der Nutzer einzelne Termine selbst, #83).
 */
const PB = `${TCO}/platz`;

export type FestArt = 'TRAINING' | 'SCHNUPPER' | 'SPERRE' | 'VERANSTALTUNG';
export const FEST_ARTEN: Record<FestArt, string> = { TRAINING: 'Training', SCHNUPPER: 'Schnuppertraining', SPERRE: 'Sperrzeit', VERANSTALTUNG: 'Veranstaltung' };
export interface Belegt {
  von: string; bis: string; eigen: boolean; reserviert?: boolean;
  /** id/einmalig/portal nur in der Platzverwaltung (#11): einzelne Termine ändern, alle kopieren */
  fest?: { art: FestArt; bezeichnung: string; hinweis: string | null; id?: number; einmalig?: boolean; portal?: boolean };
  bid?: string; art?: 'Einzel' | 'Abo'; betrag?: number | null; aenderbar?: boolean; kunde?: string; text?: string | null;
  /** Platzverwaltung: Portalbuchung (änderbar) bzw. bereits abgerechnet */
  portal?: boolean; abgerechnet?: boolean;
  /** Platzverwaltung (#11): Anlage der Buchung – Zeitpunkt (ältere nur Datum), angelegt von, Benutzer der Buchung, geändert am */
  angelegt?: { am: string | null; um: string | null; von: string | null; benutzer: string | null; geaendert: string | null };
}
export interface TagPlatz {
  id: number; name: string; art: 'HALLE' | 'FREI'; hinweis: string | null; zeit_von: string; zeit_bis: string; raster: number;
  dauer_min: number; dauer_max: number; vorlauf_min: number; vorlauf_max: number; storno_frist: number; abrechnen: boolean;
  geschlossen: string | null; belegt: Belegt[];
}
/** Preisklasse im Tagesverlauf (Einzelbuchung): Zeitraum mit einem Stundenpreis */
export interface Preiszone { prodKey: string; text: string; von: string; bis: string; stundenpreis: number; /** Farbe wie in den Hallenpreisen (0–4) */ farbe: number }
interface Tag {
  datum: string; heute: string; jetzt: string; ich: { name: string }; plaetze: TagPlatz[]; preiszonen?: Preiszone[];
  /** Halle verschlossen (#11): Hinweis, solange am Tag kein Hallenschlüssel ausgegeben ist */
  hallenhinweis?: string | null;
  /** Admin/Hallenwart (tco.platzbuchung:verwalten, #11): Namen sehen, für andere buchen, Training & Co. eintragen */
  rechte?: { verwalten: boolean };
}

/** Preisklassen für die Legende: je Preis einmal, in der Reihenfolge und mit den Farben der Hallenpreise */
export function preisklassen(zonen: Preiszone[]): Pick<Preiszone, 'prodKey' | 'text' | 'stundenpreis' | 'farbe'>[] {
  const je = new Map<string, Preiszone>();
  for (const z of zonen) if (!je.has(z.prodKey)) je.set(z.prodKey, z);
  return [...je.values()].sort((a, b) => a.prodKey.localeCompare(b.prodKey))
    .map((z) => ({ prodKey: z.prodKey, text: z.text, stundenpreis: z.stundenpreis, farbe: z.farbe }));
}
interface PreisTeil { text: string; von: string; bis: string; minuten: number; stundenpreis: number; betrag: number }
interface Preis { betrag: number | null; kostenfrei: boolean; fehler: string | null; text: string; teile?: PreisTeil[] }
interface Einzel {
  bid: string; datum: string; von: string; bis: string; platz: string; platz_id: number | null; art: string; status: string;
  preis: Preis; aenderbar: boolean; aenderbar_bis: string | null; quelle: string; text: string | null; abgerechnet: boolean;
}
interface Abo {
  bid: string; platz: string; wochentag: string; von: string; bis: string; erster: string; letzter: string;
  termine: number; kommend: number; naechster: string | null; preis: Preis; text: string | null; quelle: string;
  /** #83: Abo mit Einzelabrechnung – kommende Termine einzeln stornierbar */
  einzelabrechnung: boolean; storniert: number; kommende_termine: AboTermin[];
}
interface AboTermin { datum: string; von: string; bis: string; storniert: boolean; stornierbar: boolean; stornierbar_bis: string | null; abgerechnet: boolean }
interface Meine { ich: { name: string }; einzel: Einzel[]; abos: Abo[] }
interface Rechnung { rgnr: string; jahr: number; betrag: number; datum: string | null; bezahlt: string | null; status: string; dokument: boolean; aktuell: boolean; entwurf: boolean }
interface Entwurf { bid?: string; platz_id: number; datum: string; von: string; dauer: number; text: string }

export const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const isoHeute = () => new Date().toLocaleDateString('sv-SE');
export function tagPlus(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const WT_LANG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
export const tagText = (iso: string) => `${WT_LANG[new Date(`${iso}T12:00:00Z`).getUTCDay()]}, ${dat(iso)}`;
const klein = () => window.matchMedia?.('(max-width: 700px)').matches ?? false;
const preisText = (p: Preis | { betrag?: number | null; kostenfrei?: boolean }) =>
  (p.kostenfrei ? 'kostenfrei' : p.betrag === null || p.betrag === undefined ? 'Preis folgt' : eur(p.betrag));
/** „1 Std. 30 Min.“ → kompakt für Buttons: „1:30 Std.“ */
const dauerKurz = (m: number) => (m % 60 ? (m < 60 ? `${m} Min.` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} Std.`) : `${m / 60} Std.`);
const minText = (m: number) => (m % 60 ? (m < 60 ? `${m} Min.` : `${Math.floor(m / 60)} Std. ${m % 60} Min.`) : `${m / 60} Std.`);

/** Wie der Preis zustande kommt: je Preisklasse Zeitraum, Dauer × Stundenpreis = Betrag */
export function PreisAufschluesselung({ preis, kompakt = false }: { preis: Preis; kompakt?: boolean }) {
  const t = preis.teile ?? [];
  if (preis.kostenfrei || !t.length) return null;
  const mehrere = t.length > 1;
  return (
    <div className={`portal-pb__aufschl${kompakt ? ' portal-pb__aufschl--kompakt' : ''}`}>
      {mehrere && !kompakt && <div className="portal-pb__aufschl-titel">Gebucht über {t.length} Preisklassen:</div>}
      {t.map((x, i) => (
        <div key={i} className="portal-pb__aufschl-zeile">
          <span className="portal-pb__aufschl-zeit">{x.von}–{x.bis}</span>
          <span className="portal-pb__aufschl-text">{x.text}</span>
          <span className="portal-pb__aufschl-rechnung">{minText(x.minuten)} × {eur(x.stundenpreis)}/Std.</span>
          <span className="portal-pb__aufschl-betrag">{eur(x.betrag)}</span>
        </div>
      ))}
      {mehrere && (
        <div className="portal-pb__aufschl-zeile portal-pb__aufschl-summe">
          <span className="portal-pb__aufschl-zeit" /><span className="portal-pb__aufschl-text">Gesamt</span><span className="portal-pb__aufschl-rechnung" />
          <span className="portal-pb__aufschl-betrag">{eur(preis.betrag)}</span>
        </div>
      )}
    </div>
  );
}

const dauerText = (m: number) => (m % 60 ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)} Std. ` : ''}${m % 60} Min.` : `${m / 60} Std.`);

export function PlatzBuchen() {
  const [ansicht, setAnsicht] = useState<'kalender' | 'meine' | 'abo'>(() => (new URLSearchParams(window.location.search).get('ansicht') === 'abo' ? 'abo' : 'kalender'));
  // Absprung aus dem Arbeitsvorrat: ?datum=JJJJ-MM-TT
  const [datum, setDatum] = useState(() => { const d = new URLSearchParams(window.location.search).get('datum'); return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : isoHeute(); });
  const [tag, setTag] = useState<Tag | null>(null);
  const [filter, setFilter] = useState<'ALLE' | 'HALLE' | 'FREI'>('ALLE');
  const [meine, setMeine] = useState<Meine | null>(null);
  const [art, setArt] = useState<'einzel' | 'abo' | 'rechnung'>('einzel');
  // Meine Rechnungen: jüngste obenan, ältere als Baum nach Jahren
  const [rechnungen, setRechnungen] = useState<Rechnung[] | null>(null);
  const [rgPdf, setRgPdf] = useState<Rechnung | null>(null);
  useEffect(() => {
    if (ansicht === 'meine' && art === 'rechnung') api.get<{ rechnungen: Rechnung[] }>(`${PB}/rechnungen`).then((r) => setRechnungen(r.rechnungen)).catch(fehler);
  }, [ansicht, art]); // eslint-disable-line react-hooks/exhaustive-deps
  const rgZeile = (r: Rechnung) => (
    <div key={r.rgnr} className="portal-mz__eintrag portal-mz__eintrag--gesperrt portal-pb__rechnung">
      <Icon name="receipt" />
      <div style={{ minWidth: 0 }}>
        <div className="portal-mz__art">Rechnung {r.rgnr}</div>
        <div className="portal-mz__info">
          <span>{r.datum ? dat(r.datum) : ''}</span>
          <ObjectStatus state={r.status === 'bezahlt' ? 'Positive' : r.status === 'ausgebucht' ? 'None' : 'Critical'}>{r.status}{r.bezahlt ? ` am ${dat(r.bezahlt)}` : ''}</ObjectStatus>
          {r.dokument
            ? <Button design="Transparent" icon="pdf-attachment" onClick={() => setRgPdf(r)}>Rechnung öffnen</Button>
            : <span>{r.entwurf ? 'Dokument folgt mit dem Versand' : 'kein Dokument abgelegt'}</span>}
        </div>
      </div>
      <div className="portal-mz__dauer"><div className="portal-mz__dauer-min">{eur(r.betrag)}</div></div>
    </div>
  );
  const [zeitraum, setZeitraum] = useState<'kommend' | 'vergangen'>('kommend');
  const [entwurf, setEntwurf] = useState<Entwurf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kein, setKein] = useState<string | null>(null);
  const [preisliste, setPreisliste] = useState(false);
  const [aboOffen, setAboOffen] = useState<string | null>(null);
  const [aboStorno, setAboStorno] = useState<{ abo: Abo; t: AboTermin } | null>(null);

  const fehler = (e: unknown) => { const x = e as { status?: number; message: string }; if (x.status === 403) setKein(x.message); else setError(x.message); };
  const tagLaden = (d = datum) => api.get<Tag>(`${PB}/tag?datum=${d}`).then(setTag).catch(fehler);
  const meineLaden = () => api.get<Meine>(`${PB}/meine?zeitraum=${zeitraum}`).then(setMeine).catch(fehler);
  useEffect(() => { setTag(null); tagLaden(datum); }, [datum]); // eslint-disable-line react-hooks/exhaustive-deps
  // „vorbei“ und gerade ausgewählte Zeiten anderer laufen mit: Tagesansicht alle 30 Sekunden still neu laden (nicht während des Buchens)
  useEffect(() => { if (entwurf) return; const t = setInterval(() => tagLaden(datum), 30_000); return () => clearInterval(t); }, [datum, entwurf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ansicht === 'meine') { setMeine(null); meineLaden(); } }, [ansicht, zeitraum]); // eslint-disable-line react-hooks/exhaustive-deps

  const neuLaden = async () => { await Promise.all([tagLaden(), ansicht === 'meine' ? meineLaden() : null]); };
  const verwalten = !!tag?.rechte?.verwalten;
  const arten = new Set((tag?.plaetze ?? []).map((p) => p.art));
  const plaetze = (tag?.plaetze ?? []).filter((p) => filter === 'ALLE' || p.art === filter);
  // Preisklassen nur zeigen, wenn ein kostenpflichtiger Platz zu sehen ist
  const zonen = plaetze.some((p) => p.abrechnen && !p.geschlossen) ? tag?.preiszonen ?? [] : [];

  if (kein) {
    return (
      <AppPage title="Platz buchen">
        <div className="portal-mz"><MessageStrip design="Critical" hideCloseButton>{kein}</MessageStrip></div>
      </AppPage>
    );
  }

  const bearbeiten = (b: { bid: string; datum: string; von: string; bis: string; text: string | null }, platzId: number) =>
    setEntwurf({ bid: b.bid, platz_id: platzId, datum: b.datum, von: b.von, dauer: min(b.bis) - min(b.von), text: b.text ?? '' });

  return (
    <AppPage title="Platz buchen" subtitle={tag ? `${tag.ich.name} · Freiplätze und Halle` : undefined}>
      <div className="portal-pb">
        <SegmentedButton className="portal-pb__umschalter" onSelectionChange={(e) => setAnsicht((e.detail.selectedItems[0] as HTMLElement).dataset.k as 'kalender')}>
          <SegmentedButtonItem data-k="kalender" icon="calendar" selected={ansicht === 'kalender'}>Kalender</SegmentedButtonItem>
          <SegmentedButtonItem data-k="meine" icon="customer" selected={ansicht === 'meine'}>Meine Buchungen</SegmentedButtonItem>
          <SegmentedButtonItem data-k="abo" icon="repost" selected={ansicht === 'abo'}>Abo-Bewerbung</SegmentedButtonItem>
        </SegmentedButton>

        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}

        {ansicht === 'kalender' && (
          <>
            <div className="portal-mz__monat">
              <Button icon="navigation-left-arrow" design="Transparent" tooltip="Vortag" onClick={() => setDatum(tagPlus(datum, -1))} />
              <div>
                <div className="portal-mz__monat-titel">{tagText(datum)}</div>
                <div className="portal-row" style={{ justifyContent: 'center' }}>
                  <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datum} style={{ width: '9.5rem' }}
                              onChange={(e) => e.detail.valid && e.detail.value && setDatum(e.detail.value)} />
                  {datum !== isoHeute() && <Button design="Transparent" onClick={() => setDatum(isoHeute())}>Heute</Button>}
                </div>
              </div>
              <Button icon="navigation-right-arrow" design="Transparent" tooltip="Folgetag" onClick={() => setDatum(tagPlus(datum, 1))} />
            </div>

            {arten.size > 1 && (
              <div className="portal-mz__chips" style={{ justifyContent: 'center', marginBottom: '0.75rem' }}>
                {([['ALLE', 'Alle Plätze'], ['HALLE', 'Halle'], ['FREI', 'Freiplätze']] as const).map(([k, t]) => (
                  <ToggleButton key={k} pressed={filter === k} design={filter === k ? 'Emphasized' : 'Default'} onClick={() => setFilter(k)}>{t}</ToggleButton>
                ))}
              </div>
            )}

            {tag?.hallenhinweis && plaetze.some((p) => p.art === 'HALLE') && (
              <MessageStrip design="Critical" hideCloseButton className="portal-pb__hallenhinweis" style={{ marginBottom: '0.75rem' }}>
                <b>Halle verschlossen:</b> {tag.hallenhinweis}
              </MessageStrip>
            )}
            <div className="portal-pb__legende">
              <span><i className="portal-pb__punkt portal-pb__punkt--frei" />frei – antippen zum Buchen{verwalten ? ' oder Training eintragen' : ''}</span>
              <span><i className="portal-pb__punkt portal-pb__punkt--eigen" />meine Buchung</span>
              {verwalten ? <>
                <span><i className="portal-pb__punkt portal-pb__punkt--belegt" />Buchung (mit Name)</span>
                <span><i className="portal-pb__punkt portal-pb__punkt--training" />Training / Veranstaltung</span>
                <span><i className="portal-pb__punkt portal-pb__punkt--schnupper" />Schnuppertraining</span>
                <span><i className="portal-pb__punkt portal-pb__punkt--sperre" />Sperrzeit</span>
              </> : <span><i className="portal-pb__punkt portal-pb__punkt--belegt" />belegt / Training / Sperrzeit</span>}
              <span><i className="portal-pb__punkt portal-pb__punkt--reserviert" />wird gerade gebucht</span>
              <span><i className="portal-pb__punkt portal-pb__punkt--vorbei" />vorbei / nicht buchbar</span>
            </div>

            {zonen.length > 0 && (
              <div className="portal-pb__legende portal-pb__legende--preise">
                <span>Preis je Stunde (Farbe der Zeitspalte):</span>
                {preisklassen(zonen).map((k) => (
                  <span key={k.prodKey}><i className={`portal-pb__zonenpunkt portal-hpw__f${k.farbe}`} />{k.text} · {eur(k.stundenpreis)}</span>
                ))}
                <Button design="Transparent" icon="lead" onClick={() => setPreisliste(true)}>Preisliste</Button>
              </div>
            )}

            {!tag && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
            {tag && !plaetze.length && <Empty>Es sind noch keine Plätze eingerichtet.</Empty>}
            {tag && plaetze.length > 0 && (
              <Kalender tag={tag} plaetze={plaetze} preiszonen={zonen} namen={verwalten}
                        onFrei={(p, von) => setEntwurf({ platz_id: p.id, datum: tag.datum, von, dauer: p.dauer_min, text: '' })}
                        onEigen={(p, b) => b.bid && b.aenderbar && bearbeiten({ bid: b.bid, datum: tag.datum, von: b.von, bis: b.bis, text: b.text ?? null }, p.id)} />
            )}
          </>
        )}

        {ansicht === 'abo' && <AboBewerbung />}

        {ansicht === 'meine' && (
          <>
            <div className="portal-mz__aktionen">
              <SegmentedButton onSelectionChange={(e) => setArt((e.detail.selectedItems[0] as HTMLElement).dataset.k as 'einzel')}>
                <SegmentedButtonItem data-k="einzel" selected={art === 'einzel'}>Einzelbuchung</SegmentedButtonItem>
                <SegmentedButtonItem data-k="abo" selected={art === 'abo'}>Abo</SegmentedButtonItem>
                <SegmentedButtonItem data-k="rechnung" selected={art === 'rechnung'}>Rechnungen</SegmentedButtonItem>
              </SegmentedButton>
              <SegmentedButton style={{ display: art === 'rechnung' ? 'none' : undefined }} onSelectionChange={(e) => setZeitraum((e.detail.selectedItems[0] as HTMLElement).dataset.k as 'kommend')}>
                <SegmentedButtonItem data-k="kommend" selected={zeitraum === 'kommend'}>Kommend</SegmentedButtonItem>
                <SegmentedButtonItem data-k="vergangen" selected={zeitraum === 'vergangen'}>Vergangen</SegmentedButtonItem>
              </SegmentedButton>
            </div>
            {art === 'rechnung' && (!rechnungen ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
              <>
                <Section title="Aktuelle Rechnung" flush>
                  {rechnungen.some((r) => r.aktuell)
                    ? <div className="portal-mz__liste">{rechnungen.filter((r) => r.aktuell).map(rgZeile)}</div>
                    : <Empty>{rechnungen.length ? 'Derzeit ist keine Rechnung offen.' : 'Es gibt noch keine Rechnung.'}</Empty>}
                </Section>
                {rechnungen.some((r) => !r.aktuell) && (
                  <Section title="Frühere Rechnungen" count={rechnungen.filter((r) => !r.aktuell).length} flush>
                    {[...new Set(rechnungen.filter((r) => !r.aktuell).map((r) => r.jahr))].map((jahr, n) => {
                      const liste = rechnungen.filter((r) => !r.aktuell && r.jahr === jahr);
                      return (
                        <details key={jahr} className="portal-pb__rgjahr" open={n === 0}>
                          <summary><b>{jahr}</b><span className="portal-muted"> · {liste.length === 1 ? '1 Rechnung' : `${liste.length} Rechnungen`} · {eur(liste.reduce((s, r) => s + r.betrag, 0))}</span></summary>
                          <div className="portal-mz__liste">{liste.map(rgZeile)}</div>
                        </details>
                      );
                    })}
                  </Section>
                )}
              </>
            ))}
            {art !== 'rechnung' && !meine && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
            {meine && art === 'einzel' && (
              <Section title="Einzelbuchungen" count={meine.einzel.length} flush>
                {meine.einzel.length ? (
                  <div className="portal-mz__liste">
                    {meine.einzel.map((b) => (
                      <button key={`${b.bid}|${b.datum}`} type="button"
                              className={`portal-mz__eintrag${b.aenderbar ? '' : ' portal-mz__eintrag--gesperrt'}${b.status === '2' ? ' portal-pb__storniert' : ''}`}
                              onClick={() => b.aenderbar && b.platz_id && bearbeiten(b, b.platz_id)}>
                        <div className="portal-mz__tag">
                          <span className="portal-mz__tag-nr">{Number(b.datum.slice(8, 10))}</span>
                          <span className="portal-mz__tag-wt">{tagText(b.datum).slice(0, 2)}</span>
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div className="portal-mz__art">{b.platz} · {b.von}–{b.bis} Uhr</div>
                          <div className="portal-mz__info">
                            <span>{dat(b.datum)}</span>
                            {b.art && <span>{b.art}</span>}
                            {b.status === '2' && <ObjectStatus state="Negative">storniert</ObjectStatus>}
                            {b.quelle === 'EP3' && <ObjectStatus state="Information">aus EP3</ObjectStatus>}
                            {b.abgerechnet && <ObjectStatus state="Positive">abgerechnet</ObjectStatus>}
                            {b.aenderbar_bis && <span>änderbar bis {b.aenderbar_bis}</span>}
                            {b.text && <span>„{b.text}“</span>}
                          </div>
                          {b.status !== '2' && <PreisAufschluesselung preis={b.preis} kompakt />}
                        </div>
                        <div className="portal-mz__dauer">
                          <div className="portal-mz__dauer-std">{b.status === '2' ? '–' : preisText(b.preis)}</div>
                          {b.preis.fehler && <div className="portal-mz__dauer-eur">{b.preis.text}</div>}
                          {b.aenderbar && <Icon name="edit" style={{ color: 'var(--sapContent_IconColor)' }} />}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : <Empty>{zeitraum === 'kommend' ? 'Keine kommenden Einzelbuchungen – im Kalender einen freien Platz antippen.' : 'Keine vergangenen Einzelbuchungen.'}</Empty>}
              </Section>
            )}
            {meine && art === 'abo' && (
              <>
                <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>
                  Ein neues Abo beantragst du unter „Abo-Bewerbung“ – es gilt nach der Freigabe durch den Kassenwart.
                  Bei Abos mit Einzelabrechnung kannst du einzelne Termine selbst stornieren – das Abo bleibt bestehen.
                </MessageStrip>
                <Section title="Abos" count={meine.abos.length} flush>
                  {meine.abos.length ? (
                    <div className="portal-mz__liste">
                      {meine.abos.map((a) => (
                        <Fragment key={a.bid}>
                        <div className="portal-mz__eintrag portal-mz__eintrag--gesperrt" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                          <div style={{ minWidth: 0 }}>
                            <div className="portal-mz__art">{a.wochentag}s {a.von}–{a.bis} Uhr · {a.platz}</div>
                            <div className="portal-mz__info">
                              <span>{dat(a.erster)} – {dat(a.letzter)}</span>
                              <span>{a.termine} Termine{a.kommend ? `, ${a.kommend} kommend` : ''}</span>
                              {a.naechster && <ObjectStatus state="Information">nächster {dat(a.naechster)}</ObjectStatus>}
                              {a.quelle === 'EP3' && <ObjectStatus state="Information">aus EP3</ObjectStatus>}
                              {a.einzelabrechnung && <ObjectStatus state="Information">Einzelabrechnung</ObjectStatus>}
                              {a.storniert > 0 && <ObjectStatus state="Negative">{a.storniert} storniert</ObjectStatus>}
                              {a.text && <span>„{a.text}“</span>}
                            </div>
                            <PreisAufschluesselung preis={a.preis} kompakt />
                            {a.einzelabrechnung && a.kommende_termine.length > 0 && (
                              <Button design="Transparent" icon={aboOffen === a.bid ? 'navigation-up-arrow' : 'navigation-down-arrow'}
                                      onClick={() => setAboOffen(aboOffen === a.bid ? null : a.bid)}>
                                {aboOffen === a.bid ? 'Termine ausblenden' : 'Termine anzeigen / einzeln stornieren'}
                              </Button>
                            )}
                          </div>
                          <div className="portal-mz__dauer">
                            <div className="portal-mz__dauer-std">{preisText(a.preis)}</div>
                            <div className="portal-mz__dauer-eur">{a.preis.kostenfrei ? '' : a.einzelabrechnung ? 'je Termin' : 'Abo-Preis'}</div>
                          </div>
                        </div>
                        {aboOffen === a.bid && a.kommende_termine.map((t) => (
                          <div key={t.datum} className={`portal-mz__eintrag portal-pb__abo-termin${t.storniert ? ' portal-pb__storniert' : ''}`}>
                            <div className="portal-mz__tag">
                              <span className="portal-mz__tag-nr">{Number(t.datum.slice(8, 10))}</span>
                              <span className="portal-mz__tag-wt">{tagText(t.datum).slice(0, 2)}</span>
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div className="portal-mz__art">{dat(t.datum)} · {t.von}–{t.bis} Uhr</div>
                              <div className="portal-mz__info">
                                {t.storniert && <ObjectStatus state="Negative">storniert</ObjectStatus>}
                                {t.abgerechnet && <ObjectStatus state="Positive">abgerechnet</ObjectStatus>}
                                {t.stornierbar_bis && <span>stornierbar bis {t.stornierbar_bis}</span>}
                                {!t.storniert && !t.stornierbar && !t.abgerechnet && <span>Stornofrist abgelaufen</span>}
                              </div>
                            </div>
                            <div className="portal-mz__dauer">
                              {t.stornierbar && <Button design="Transparent" icon="cancel" onClick={() => setAboStorno({ abo: a, t })}>Stornieren</Button>}
                            </div>
                          </div>
                        ))}
                        </Fragment>
                      ))}
                    </div>
                  ) : <Empty>{zeitraum === 'kommend' ? 'Keine laufenden Abos.' : 'Keine abgelaufenen Abos.'}</Empty>}
                </Section>
              </>
            )}
          </>
        )}
      </div>

      {preisliste && <PreislisteDialog datum={datum} onClose={() => setPreisliste(false)} />}
      {rgPdf && <PdfDialog url={`${PB}/rechnungen/${encodeURIComponent(rgPdf.rgnr)}/pdf`} title={`Rechnung ${rgPdf.rgnr}`} filename={`Rechnung_${rgPdf.rgnr}.pdf`} onClose={() => setRgPdf(null)} />}
      {aboStorno && (
        <AboTerminStorno abo={aboStorno.abo} termin={aboStorno.t} onClose={() => setAboStorno(null)}
                         onFertig={async (text) => { toast(text); setAboStorno(null); await neuLaden(); }} />
      )}
      {entwurf && (
        <BuchungDialog entwurf={entwurf} verwalten={verwalten} onClose={() => { setEntwurf(null); tagLaden(); }}
                       onFertig={async (text) => { toast(text, text.includes('verschlossen') ? 12000 : 3000); setEntwurf(null); await neuLaden(); }} />
      )}
    </AppPage>
  );
}

// ---------------------------------------------------------------- #83: einzelnen Abo-Termin stornieren (Abo bleibt)
function AboTerminStorno({ abo, termin, onClose, onFertig }: { abo: Abo; termin: AboTermin; onClose: () => void; onFertig: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const los = async () => {
    setBusy(true); setFehler(null);
    try { onFertig((await api.del<{ text: string }>(`${PB}/buchungen/${encodeURIComponent(abo.bid)}/termine/${termin.datum}`)).text); }
    catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open headerText="Abo-Termin stornieren" onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Negative" disabled={busy} onClick={los}>Termin stornieren</Button>
              <Button design="Transparent" onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <Text>
        Termin am {tagText(termin.datum)} von {termin.von} bis {termin.bis} Uhr ({abo.platz}) stornieren?
        Nur dieser Termin entfällt und wird nicht berechnet – dein Abo {abo.wochentag}s bleibt bestehen.
      </Text>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Preisliste der Woche (nur lesend, Darstellung wie Hallenpreise)
const WOCHENTAG_KURZ = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
function PreislisteDialog({ datum, onClose }: { datum: string; onClose: () => void }) {
  const can = useCan();
  const navigate = useNavigate();
  const [woche, setWoche] = useState<{ datum: string; zonen: Preiszone[] }[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { api.get<{ woche: { datum: string; zonen: Preiszone[] }[] }>(`${PB}/preisliste?datum=${datum}`).then((r) => setWoche(r.woche)).catch((e) => setFehler(e.message)); }, [datum]);
  const alle = (woche ?? []).flatMap((t) => t.zonen);
  const von0 = Math.min(7 * 60, ...alle.map((z) => Math.floor(min(z.von) / 60) * 60));
  const bis0 = Math.max(22 * 60, ...alle.map((z) => Math.ceil((min(z.bis) || 1440) / 60) * 60));
  const REM = 2.25;
  const y = (m: number) => `${((m - von0) / 60) * REM}rem`;
  const h = (m: number) => `${(m / 60) * REM}rem`;
  const stunden: number[] = [];
  for (let m = von0; m <= bis0; m += 60) stunden.push(m);
  return createPortal(
    <Dialog open stretch={klein()} headerText={woche ? `Preisliste Halle – Woche vom ${dat(woche[0].datum)}` : 'Preisliste Halle'} onClose={onClose} style={{ width: 'min(64rem, 96vw)' }}
            footer={<Bar endContent={<>
              {can('tco.halle:display') && <Button icon="lead" onClick={() => navigate('/tco/hallenpreise')}>Hallenpreise öffnen</Button>}
              <Button design="Emphasized" onClick={onClose}>Schließen</Button>
            </>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton>{fehler}</MessageStrip>}
      {!woche && !fehler && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
      {woche && !alle.length && <Empty>Für diese Woche sind keine Hallenpreise hinterlegt.</Empty>}
      {woche && alle.length > 0 && (
        <>
          <div className="portal-pb__legende" style={{ justifyContent: 'flex-start' }}>
            <span>Einzelbuchung, Preis je Stunde:</span>
            {preisklassen(alle).map((k) => <span key={k.prodKey}><i className={`portal-pb__zonenpunkt portal-hpw__f${k.farbe}`} />{k.text} · {eur(k.stundenpreis)}</span>)}
          </div>
          <div className="portal-hpw__plan">
            <div className="portal-hpw__kopf">
              <div />
              {woche.map((t, i) => <div key={t.datum} className="portal-hpw__tag" style={t.datum === datum ? { color: 'var(--sapSelectedColor, #0064d9)' } : undefined}>{WOCHENTAG_KURZ[i]} {dat(t.datum).slice(0, 6)}</div>)}
            </div>
            <div className="portal-hpw__raster" style={{ height: h(bis0 - von0) }}>
              <div className="portal-hpw__zeiten">
                {stunden.map((m) => <div key={m} className="portal-hpw__stunde" style={{ top: y(m) }}>{hhmm(m)}</div>)}
              </div>
              {woche.map((t) => (
                <div key={t.datum} className="portal-hpw__spalte">
                  {stunden.slice(0, -1).map((m) => <div key={m} className="portal-hpw__linie" style={{ top: y(m) }} />)}
                  {t.zonen.map((z) => {
                    const a = min(z.von), b = min(z.bis) || 1440;
                    return (
                      <div key={z.von} className={`portal-hpw__block portal-hpw__f${z.farbe}${b - a <= 60 ? ' portal-hpw__block--kurz' : ''}`} style={{ top: y(a), height: h(b - a) }}>
                        <b>{z.von}–{z.bis}</b>
                        <b>{z.text}</b>
                        {b - a > 60 && <span>{eur(z.stundenpreis)} je Stunde</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <Text className="portal-muted portal-small">Preise für Einzelbuchungen in der Halle. Freiplätze sind kostenfrei; Zeiten ohne Block haben keinen hinterlegten Preis.</Text>
        </>
      )}
    </Dialog>,
    document.body,
  );
}

// ---------------------------------------------------------------- Tageskalender: Plätze × Uhrzeit
const REM_JE_STD = 3.5;
export function Kalender({ tag, plaetze, onFrei, onEigen, onKopieren, admin, preiszonen, namen }: {
  tag: { datum: string; heute?: string; jetzt?: string }; plaetze: TagPlatz[];
  onFrei?: (p: TagPlatz, von: string) => void; onEigen?: (p: TagPlatz, b: Belegt) => void; admin?: boolean;
  /** Platzverwaltung (#11): Kopier-Knopf je Buchung bzw. Belegung */
  onKopieren?: (p: TagPlatz, b: Belegt) => void;
  /** Admin/Hallenwart in „Platz buchen“: Namen fremder Buchungen, Training & Co. farbig (#11) */
  namen?: boolean;
  /** Preisklassen im Tagesverlauf: Zeitspalte farbig hinterlegt, Rand links und rechts der Uhrzeit */
  preiszonen?: Preiszone[];
}) {
  const offen = plaetze.filter((p) => !p.geschlossen);
  const start = Math.floor(Math.min(...(offen.length ? offen : plaetze).map((p) => min(p.zeit_von))) / 60) * 60;
  const ende = Math.ceil(Math.max(...(offen.length ? offen : plaetze).map((p) => min(p.zeit_bis))) / 60) * 60;
  // Maßstab (#11): jedes Rasterfeld mindestens 1,5rem hoch, damit „Frei“ hineinpasst und kein Feld ein anderes verdeckt
  // (15-Minuten-Raster ⇒ 6rem je Stunde, 30 Minuten und mehr ⇒ 3,5rem wie bisher)
  const kleinstesRaster = Math.min(60, ...offen.map((p) => p.raster).filter((r) => r > 0));
  const remJeStd = Math.max(REM_JE_STD, (1.5 * 60) / kleinstesRaster);
  const y = (m: number) => `${((m - start) / 60) * remJeStd}rem`;
  const h = (m: number) => `${(m / 60) * remJeStd}rem`;
  // Minuten seit Tagesbeginn, ab denen gebucht werden kann (vorbei + Mindestvorlauf); −∞/∞ für ganze Tage
  const tageBis = tag.heute ? Math.round((Date.parse(`${tag.datum}T12:00:00Z`) - Date.parse(`${tag.heute}T12:00:00Z`)) / 86_400_000) : 0;
  const jetztMin = min(tag.jetzt ?? '00:00');
  const grenze = (p: TagPlatz) => {
    if (admin || !tag.heute) return -Infinity;
    if (tageBis > p.vorlauf_max) return Infinity;
    return jetztMin + p.vorlauf_min * 60 - tageBis * 1440;
  };
  const vorbeiBis = admin || !tag.heute ? -Infinity : tageBis < 0 ? Infinity : tageBis === 0 ? jetztMin : -Infinity;
  const stunden: number[] = [];
  for (let m = start; m < ende; m += 60) stunden.push(m);
  // mit Preisklassen ist die Zeitspalte breiter: farbiger Rand links und rechts der Uhrzeit
  const spalten = `${preiszonen?.length ? '4rem' : '3rem'} repeat(${plaetze.length}, minmax(${plaetze.length > 2 ? '7.5rem' : '9rem'}, 1fr))`;

  return (
    <div className="portal-pb__scroll">
      <div className="portal-pb__kopf" style={{ gridTemplateColumns: spalten }}>
        <div />
        {plaetze.map((p) => (
          <div key={p.id} className="portal-pb__platzkopf" title={p.hinweis ?? undefined}>
            <div className="portal-pb__platzname">{p.name}</div>
            <div className="portal-pb__platzinfo">{p.art === 'HALLE' ? 'Halle' : 'Freiplatz'}{p.abrechnen ? '' : ' · kostenfrei'}</div>
          </div>
        ))}
      </div>
      <div className="portal-pb__raster" style={{ gridTemplateColumns: spalten, height: h(ende - start) }}>
        <div className={`portal-pb__zeiten${preiszonen?.length ? ' portal-pb__zeiten--preise' : ''}`}>
          {(preiszonen ?? []).map((z) => {
            const von = Math.max(min(z.von), start);
            const bis = Math.min(min(z.bis) || 1440, ende);
            return bis > von
              ? <div key={z.von} className={`portal-pb__zone portal-hpw__f${z.farbe}`} style={{ top: y(von), height: h(bis - von) }}
                     title={`${z.von}–${z.bis} Uhr: ${z.text} · ${eur(z.stundenpreis)} je Stunde`} />
              : null;
          })}
          {stunden.map((m) => <div key={m} className="portal-pb__stunde" style={{ top: y(m) }}>{hhmm(m)}</div>)}
        </div>
        {plaetze.map((p) => {
          const auf = min(p.zeit_von);
          const zu = min(p.zeit_bis);
          const ab = grenze(p);
          const slots: number[] = [];
          // Platzverwaltung (admin mit onFrei): jede freie Rasterzeit anklickbar, ohne Mindestdauer und Vorlauf (#11)
          const minDauer = admin ? p.raster : p.dauer_min;
          if (!p.geschlossen && (!admin || onFrei)) {
            for (let m = auf; m + minDauer <= zu; m += p.raster) {
              const frei = !p.belegt.some((b) => min(b.von) < m + p.raster && (min(b.bis) || 1440) > m);
              if (frei && m >= ab) slots.push(m);
            }
          }
          // grauer Bereich: vorbei bzw. wegen Vorlauf nicht mehr (oder noch nicht) buchbar
          const grauBis = p.geschlossen ? start : Math.min(Math.max(ab, start), ende);
          const grauText = ab === Infinity ? `buchbar höchstens ${p.vorlauf_max} Tage im Voraus`
            : tageBis < 0 || (tageBis === 0 && !p.vorlauf_min) ? 'vorbei' : 'nicht mehr buchbar';
          const grauGanz = grauBis >= ende;
          return (
            <div key={p.id} className="portal-pb__spalte">
              {stunden.map((m) => <div key={m} className="portal-pb__linie" style={{ top: y(m) }} />)}
              {p.geschlossen
                ? <div className="portal-pb__zu" style={{ top: 0, height: '100%' }}><span>{p.geschlossen}</span></div>
                : <>
                    {auf > start && <div className="portal-pb__zu" style={{ top: 0, height: h(auf - start) }} />}
                    {zu < ende && <div className="portal-pb__zu" style={{ top: y(zu), height: h(ende - zu) }} />}
                    {grauBis > start && (
                      <div className={`portal-pb__vorbei${grauGanz ? ' portal-pb__vorbei--ganz' : ''}`} style={{ top: 0, height: h(grauBis - start) }}>
                        {(grauGanz || grauBis - start >= 60) && <span>{grauText}</span>}
                      </div>
                    )}
                  </>}
              {slots.map((m) => (
                <button key={m} type="button" className="portal-pb__frei" style={{ top: y(m), height: h(p.raster) }}
                        aria-label={`${p.name} ab ${hhmm(m)} Uhr ${admin ? 'eintragen' : 'buchen'}`} onClick={() => onFrei?.(p, hhmm(m))}>
                  <span>{hhmm(m)}</span>
                  <span className="portal-pb__frei-text">Frei</span>
                </button>
              ))}
              {p.belegt.map((b, i) => {
                const von = Math.max(min(b.von), start);
                const bis = min(b.bis) || 1440;
                const alt = bis <= vorbeiBis; // für normale Nutzer: vergangene Stunde grau, nicht änderbar
                // Training/Sperrzeit: in „Platz buchen“ grau wie „belegt“ (die Bezeichnung bleibt), in der Platzverwaltung farbig
                const cls = (b.fest ? (admin || namen ? `portal-pb__block--training${b.fest.art === 'SPERRE' ? ' portal-pb__block--sperre' : b.fest.art === 'SCHNUPPER' ? ' portal-pb__block--schnupper' : ''}` : 'portal-pb__block--belegt') : b.eigen ? 'portal-pb__block--eigen' : b.reserviert ? 'portal-pb__block--reserviert' : admin ? `portal-pb__block--admin${b.art === 'Abo' ? ' portal-pb__block--abo' : ''}` : 'portal-pb__block--belegt')
                  + (alt ? ' portal-pb__block--vorbei' : '');
                // Platzverwaltung: Buchungen und Belegungen (Training & Co.) anklickbar – ändern, kopieren, stornieren (#11)
                const klickbar = !b.reserviert && (b.fest ? admin && !!b.fest.id && !!onEigen : (b.eigen && b.aenderbar && !alt) || (admin && !!b.bid));
                const kopierbar = !!onKopieren && !b.reserviert && (!!b.bid || !!b.fest);
                return (
                  <Fragment key={i}>
                  {kopierbar && (
                    <button type="button" className="portal-pb__kopie" style={{ top: y(von) }} title="Termin kopieren"
                            aria-label={`${b.fest ? b.fest.bezeichnung : b.kunde ?? 'Termin'} ${b.von}–${b.bis} kopieren`} onClick={() => onKopieren!(p, b)}>
                      <Icon name="copy" />
                    </button>
                  )}
                  <button type="button" className={`portal-pb__block ${cls}${kopierbar ? ' portal-pb__block--kopierbar' : ''}`} disabled={!klickbar}
                          style={{ top: y(von), height: h(Math.max(bis - von, 15)) }} onClick={() => klickbar && onEigen?.(p, b)}>
                    <span className="portal-pb__block-zeit">{b.von}–{b.bis}</span>
                    {b.eigen && <span className="portal-pb__block-text">{b.art === 'Abo' ? 'Mein Abo' : 'Meine Buchung'} · {preisText(b)}</span>}
                    {b.fest && <span className="portal-pb__block-text" title={b.fest.hinweis ?? undefined}>{b.fest.bezeichnung}</span>}
                    {b.fest?.hinweis && <span className="portal-pb__block-text portal-pb__block-notiz">{b.fest.hinweis}</span>}
                    {b.reserviert && <span className="portal-pb__block-text">Wird gerade gebucht{admin && b.kunde ? ` · ${b.kunde}` : ''}</span>}
                    {!b.fest && !b.reserviert && !b.eigen && !admin && <span className="portal-pb__block-text">{b.kunde ? `${b.art === 'Abo' ? 'Abo · ' : ''}${b.kunde}` : 'Belegt'}</span>}
                    {!b.fest && !b.reserviert && admin && <span className="portal-pb__block-text">{b.art === 'Abo' ? 'Abo · ' : ''}{b.kunde || '–'}</span>}
                    {(b.eigen || admin || namen) && b.text && <span className="portal-pb__block-text portal-pb__block-notiz">{b.text}</span>}
                  </button>
                  </Fragment>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Buchen / Ändern
/** Admin/Hallenwart (#11): wofür der freie Termin eingetragen wird */
type Fuer = 'ICH' | 'MITGLIED' | FestArt;
const FEST_VORGABE: Record<FestArt, string> = { TRAINING: 'Jugendtraining', SCHNUPPER: 'Schnuppertraining', SPERRE: 'Sperrzeit', VERANSTALTUNG: 'Veranstaltung' };

function BuchungDialog({ entwurf, verwalten, onClose, onFertig }: { entwurf: Entwurf; verwalten?: boolean; onClose: () => void; onFertig: (text: string) => void }) {
  const [e, setE] = useState<Entwurf>(entwurf);
  // nur bei neuen Terminen: für mich (wie bisher), für ein Mitglied/vereinsintern oder als Training, Schnuppertraining, Sperrzeit, Veranstaltung
  const [fuer, setFuer] = useState<Fuer>('ICH');
  const [adrnr, setAdrnr] = useState<string | null>(null);
  const [intern, setIntern] = useState('');
  const [bezeichnung, setBezeichnung] = useState('');
  const [mitglieder, setMitglieder] = useState<{ adrnr: string; name: string }[]>([]);
  const ich = fuer === 'ICH';
  const festArt = !ich && fuer !== 'MITGLIED' ? fuer : null;
  useEffect(() => {
    if (verwalten && fuer === 'MITGLIED' && !mitglieder.length) {
      api.get<{ adrnr: string; name: string }[]>(`${PB}/verwalten/mitglieder`).then(setMitglieder).catch((x) => setMeldung((x as Error).message));
    }
  }, [verwalten, fuer]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tag, setTag] = useState<Tag | null>(null);
  const [pruefung, setPruefung] = useState<{ fehler: string | null; preis: Preis } | null>(null);
  const [busy, setBusy] = useState(false);
  const [storno, setStorno] = useState(false);
  const [meldung, setMeldung] = useState<string | null>(null);

  useEffect(() => { api.get<Tag>(`${PB}/tag?datum=${e.datum}`).then(setTag).catch((x) => setMeldung((x as Error).message)); }, [e.datum]);
  const p = tag?.plaetze.find((x) => x.id === e.platz_id) ?? null;
  const bis = hhmm(min(e.von) + e.dauer);
  // gewählte Zeit sofort für andere sperren – auch solange die Buchung noch nicht gesichert ist
  const sperre = useSperre('PLATZZEIT', String(e.platz_id), true, { von: `${e.datum}T${e.von}`, bis: `${e.datum}T${bis}`, bezeichnung: p?.name ?? 'Platz' });
  useEffect(() => {
    setPruefung(null);
    if (!p || !ich) return;
    const t = setTimeout(() => {
      api.post<{ fehler: string | null; preis: Preis }>(`${PB}/pruefen`, { platz_id: e.platz_id, datum: e.datum, von: e.von, bis, bid: e.bid ?? null })
        .then(setPruefung).catch((x) => setMeldung((x as Error).message));
    }, 200);
    return () => clearTimeout(t);
  }, [e.platz_id, e.datum, e.von, e.dauer, p?.id, sperre.zustand, ich]); // eslint-disable-line react-hooks/exhaustive-deps

  const beginne = useMemo(() => {
    if (!p) return [] as string[];
    const out: string[] = [];
    for (let m = min(p.zeit_von); m + p.dauer_min <= min(p.zeit_bis); m += p.raster) out.push(hhmm(m));
    if (!out.includes(e.von)) out.unshift(e.von);
    return out;
  }, [p, e.von]);
  const dauern = useMemo(() => {
    if (!p) return [e.dauer];
    const out: number[] = [];
    // für andere bzw. Training & Co.: ohne Mindest-/Höchstdauer, bis zum Ende der Öffnungszeit
    if (!ich) for (let d = p.raster; min(e.von) + d <= min(p.zeit_bis); d += p.raster) out.push(d);
    else for (let d = p.dauer_min; d <= p.dauer_max; d += p.raster) out.push(d);
    return out.length ? out : [e.dauer];
  }, [p, e.dauer, e.von, ich]);

  async function ausfuehren(fn: () => Promise<{ text: string; hinweis?: string }>) {
    setBusy(true); setMeldung(null);
    try { const r = await fn(); onFertig(r.hinweis ? `${r.text} ${r.hinweis}` : r.text); } catch (x) { setMeldung((x as Error).message); } finally { setBusy(false); }
  }
  const body = { platz_id: e.platz_id, datum: e.datum, von: e.von, bis, text: e.text.trim() || null };
  const speichern = () => ausfuehren(() => {
    if (e.bid) return api.put<{ text: string }>(`${PB}/buchungen/${e.bid}`, body);
    if (fuer === 'MITGLIED') return api.post<{ text: string }>(`${PB}/verwalten/buchung`, { ...body, adrnr, intern: adrnr ? null : intern.trim() || null });
    if (festArt) return api.post<{ text: string }>(`${PB}/verwalten/belegung`, { ...body, art: festArt, bezeichnung: bezeichnung.trim() });
    return api.post<{ text: string; hinweis?: string }>(`${PB}/buchungen`, body);
  });
  const bereit = ich ? !!pruefung && !pruefung.fehler : fuer === 'MITGLIED' ? !!adrnr || !!intern.trim() : !!bezeichnung.trim();

  return createPortal(
    <Dialog open stretch={klein()} headerText={e.bid ? 'Buchung ändern' : festArt ? `${FEST_ARTEN[festArt]} eintragen` : 'Platz buchen'} onClose={onClose}
            footer={<Bar endContent={<>
              {e.bid && <Button design="Negative" icon="cancel" disabled={busy} onClick={() => setStorno(true)}>Stornieren</Button>}
              <Button design="Emphasized" disabled={busy || !bereit || sperre.zustand !== 'eigen'} onClick={speichern}>{e.bid ? 'Speichern' : festArt ? 'Eintragen' : 'Verbindlich buchen'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-mz__form">
        {meldung && <MessageStrip design="Negative" onClose={() => setMeldung(null)}>{meldung}</MessageStrip>}
        {ich && !e.bid && p?.art === 'HALLE' && tag?.hallenhinweis && (
          <MessageStrip design="Critical" hideCloseButton><b>Halle verschlossen:</b> {tag.hallenhinweis}</MessageStrip>
        )}
        {(sperre.zustand === 'fremd' || sperre.zustand === 'fehler' || sperre.zustand === 'inaktiv') && (
          <MessageStrip design="Critical" hideCloseButton>
            {sperre.zustand === 'fremd' ? `${sperre.text} Bitte eine andere Zeit oder einen anderen Platz wählen.` : sperre.text}
            {sperre.zustand !== 'fremd' && <> <Button design="Transparent" icon="refresh" onClick={sperre.erneut}>Erneut reservieren</Button></>}
          </MessageStrip>
        )}
        {verwalten && !e.bid && (
          <div className="portal-mz__feld">
            <Label required>Eintragen als</Label>
            <Select style={{ width: '100%' }} onChange={(x) => {
              const f = (x.detail.selectedOption as HTMLElement).dataset.f as Fuer;
              setFuer(f);
              if (f !== 'ICH' && f !== 'MITGLIED') setBezeichnung(FEST_VORGABE[f]);
            }}>
              <Option data-f="ICH" selected={fuer === 'ICH'}>Buchung für mich</Option>
              <Option data-f="MITGLIED" selected={fuer === 'MITGLIED'}>Buchung für ein Mitglied / eine Person</Option>
              {(Object.keys(FEST_ARTEN) as FestArt[]).map((a) => <Option key={a} data-f={a} selected={fuer === a}>{FEST_ARTEN[a]}</Option>)}
            </Select>
          </div>
        )}
        {verwalten && fuer === 'MITGLIED' && (
          <>
            <div className="portal-mz__feld">
              <Label>Mitglied</Label>
              <AuswahlBox wert={adrnr ?? ''} placeholder="Mitglied suchen" max={50} style={{ width: '100%' }}
                          eintraege={mitglieder.map((m) => ({ key: m.adrnr, text: m.name, zusatz: m.adrnr }))} onWaehle={(k) => setAdrnr(k)} />
            </div>
            {!adrnr && (
              <div className="portal-mz__feld">
                <Label>oder Name (vereinsintern, ohne Rechnung)</Label>
                <Input value={intern} maxlength={60} style={{ width: '100%' }} placeholder="z. B. Vorstand, Gastspieler Müller" onInput={(x) => setIntern(x.target.value)} />
              </div>
            )}
          </>
        )}
        {festArt && (
          <div className="portal-mz__feld">
            <Label required>Bezeichnung</Label>
            <Input value={bezeichnung} maxlength={80} style={{ width: '100%' }} onInput={(x) => setBezeichnung(x.target.value)} />
          </div>
        )}
        <div className="portal-mz__feld">
          <Label required>Datum</Label>
          <DatePicker formatPattern="EEEE, dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={e.datum} style={{ width: '100%' }}
                      onChange={(x) => x.detail.valid && x.detail.value && setE({ ...e, datum: x.detail.value })} />
        </div>
        <div className="portal-mz__feld">
          <Label required>Platz</Label>
          <Select style={{ width: '100%' }} onChange={(x) => setE({ ...e, platz_id: Number((x.detail.selectedOption as HTMLElement).dataset.id) })}>
            {(tag?.plaetze ?? []).map((x) => (
              <Option key={x.id} data-id={x.id} selected={x.id === e.platz_id}>{x.name}{x.geschlossen ? ` (${x.geschlossen})` : ''}</Option>
            ))}
          </Select>
          {p?.hinweis && <Text className="portal-muted portal-small">{p.hinweis}</Text>}
        </div>
        <div className="portal-mz__feld">
          <Label required>Beginn</Label>
          <Select style={{ width: '100%' }} onChange={(x) => setE({ ...e, von: (x.detail.selectedOption as HTMLElement).dataset.v! })}>
            {beginne.map((v) => <Option key={v} data-v={v} selected={v === e.von}>{v} Uhr</Option>)}
          </Select>
        </div>
        <div className="portal-mz__feld">
          <Label required>Dauer</Label>
          {/* eigene Buttons statt ToggleButton: zweizeilig (Dauer + Endzeit), brechen nicht ab und umbrechen auf dem Handy */}
          <div className="portal-pb__dauern" role="radiogroup" aria-label="Dauer">
            {dauern.map((d) => (
              <button key={d} type="button" role="radio" aria-checked={e.dauer === d} title={dauerText(d)}
                      className={`portal-pb__dauer${e.dauer === d ? ' portal-pb__dauer--an' : ''}`} onClick={() => setE({ ...e, dauer: d })}>
                <span className="portal-pb__dauer-wert">{dauerKurz(d)}</span>
                <span className="portal-pb__dauer-bis">bis {hhmm(Math.min(min(e.von) + d, 1440))}</span>
              </button>
            ))}
          </div>
          <Text className="portal-muted portal-small">{e.von}–{bis} Uhr · {dauerText(e.dauer)}</Text>
        </div>
        <div className="portal-mz__feld">
          <Label>{festArt ? 'Hinweis im Kalender (z. B. Gruppe, Trainer)' : 'Notiz (z. B. Spielpartner)'}</Label>
          <Input value={e.text} maxlength={200} style={{ width: '100%' }} onInput={(x) => setE({ ...e, text: x.target.value })} />
        </div>

        {!ich && (
          <MessageStrip hideCloseButton design="Information">
            {fuer === 'MITGLIED'
              ? 'Einzelbuchung wie in der Serienbuchung: für ein Mitglied mit Preis laut Hallenpreisen, vereinsintern ohne Rechnung.'
              : 'Wird als feste Belegung für diesen Termin angelegt – für alle mit Bezeichnung sichtbar, Pflege unter Platzverwaltung → Training & Sperrzeiten.'}
          </MessageStrip>
        )}
        {ich && <div className="portal-pb__preis">
          {(!pruefung || sperre.zustand === 'laden') && <BusyIndicator active size="S" />}
          {pruefung?.fehler && <ObjectStatus state="Negative" showDefaultIcon>{pruefung.fehler}</ObjectStatus>}
          {pruefung && !pruefung.fehler && (
            <>
              <div style={{ minWidth: 0, flex: 1 }}>
                <ObjectStatus state={sperre.zustand === 'eigen' ? 'Positive' : 'Critical'} showDefaultIcon style={{ display: 'block', marginBottom: '0.25rem' }}>
                  {sperre.zustand === 'eigen' ? 'für dich reserviert' : sperre.zustand === 'fremd' ? 'wird gerade gebucht' : 'frei'}
                </ObjectStatus>
                <div className="portal-pb__preis-wert">{preisText(pruefung.preis)}</div>
                <div className="portal-muted portal-small">{pruefung.preis.kostenfrei ? 'Freiplatz ohne Gebühr' : pruefung.preis.fehler ? 'Preis ermittelt die Hallenabrechnung' : pruefung.preis.text}</div>
                <PreisAufschluesselung preis={pruefung.preis} />
              </div>
            </>
          )}
        </div>}
        {p && (
          <Text className="portal-muted portal-small">
            Buchbar {p.vorlauf_min ? `bis ${p.vorlauf_min} Std. vor Beginn, ` : ''}höchstens {p.vorlauf_max} Tage im Voraus.
            {p.storno_frist ? ` Ändern und Stornieren bis ${p.storno_frist} Std. vor Beginn.` : ' Ändern und Stornieren bis zum Beginn.'}
          </Text>
        )}
        {p?.abrechnen && (
          <Text className="portal-muted portal-small">
            Die Bezahlung erfolgt per Rechnung: Gebuchte Stunden werden gesammelt abgerechnet, die Rechnung erhältst du per E-Mail.
          </Text>
        )}
      </div>
      {storno && createPortal(
        <Dialog open headerText="Buchung stornieren" onClose={() => setStorno(false)}
                footer={<Bar endContent={<>
                  <Button design="Negative" disabled={busy} onClick={() => ausfuehren(() => api.del<{ text: string }>(`${PB}/buchungen/${e.bid}`))}>Stornieren</Button>
                  <Button onClick={() => setStorno(false)}>Abbrechen</Button>
                </>} />}>
          <Text>Buchung am {dat(entwurf.datum)} von {entwurf.von} bis {hhmm(min(entwurf.von) + entwurf.dauer)} Uhr wirklich stornieren?</Text>
        </Dialog>,
        document.body,
      )}
    </Dialog>,
    document.body,
  );
}
