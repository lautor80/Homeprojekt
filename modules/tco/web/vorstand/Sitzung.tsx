import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BusyIndicator, Button, DatePicker, Dialog, Icon, Input, Label, Link, MessageStrip, ObjectStatus, Option, RadioButton, SegmentedButton, SegmentedButtonItem,
  Select, SuggestionItem, Text,
} from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { PdfDialog } from '@core/components/PdfDialog';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { dat, dateiLesen } from '../util';
import {
  abstimmung, tagIso, uhrzeit, VS,
  type Eintrag, type EventWahl, type SitzungDetail, type Status, type Teilnahme, type Top, type Uebersicht,
} from './typen';
import { FormatEditor, FormatText } from './FormatText';
import { ThemenAuswahlDialog, ThemenInSitzung, TopParkenDialog } from './Themen';
import { TopVerlauf, VerkettenDialog } from './Verlauf';
import './vorstand.css';

/**
 * Eine Vorstandssitzung: Kopf und Status, verknüpfte Veranstaltung, Teilnehmer (Vorstand und Gäste) mit Beschlussfähigkeit,
 * Anlagen, Tagesordnung mit Protokolltext, Beschlüssen (fortlaufende Nummer), Aufgaben und Infos. Freigegebene Protokolle
 * sind schreibgeschützt – nur Aufgaben lassen sich weiter abhaken.
 */
const SCHRITTE: { s: Status; text: string }[] = [
  { s: 'GEPLANT', text: 'Geplant' }, { s: 'LAEUFT', text: 'Sitzung läuft' }, { s: 'ENTWURF', text: 'Protokoll im Entwurf' }, { s: 'FREIGEGEBEN', text: 'Freigegeben' },
];
const TEILNAHME: { s: Teilnahme; text: string }[] = [{ s: 'ANWESEND', text: 'da' }, { s: 'ENTSCHULDIGT', text: 'entsch.' }, { s: 'FEHLT', text: 'fehlt' }];
const RUECK: Record<string, string> = { ZUSAGE: 'Zusage', ABSAGE: 'Absage', VIELLEICHT: 'vielleicht' };
/** Rechnername einer Verknüpfung (für die Zeile der Anlage) */
const linkZiel = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const groesse = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const initialen = (n: string) => n.split(/[,\s]+/).filter(Boolean).slice(0, 2).reverse().map((x) => x[0]?.toUpperCase()).join('');

type KopfForm = { titel: string; art: 'VORSTAND' | 'ERWEITERT'; datum: string; beginn: string; ende: string; ort: string; leitung: string; protokoll_von: string; bemerkung: string };
type TopForm = { id?: number; titel: string; verantwortlich: string; text: string; status: Top['status'] };
type EintragForm = { id?: number; top_id: number; art: Eintrag['art']; text: string; ja: string; nein: string; enthaltung: string; ergebnis: '' | 'ANGENOMMEN' | 'ABGELEHNT'; verantwortlich: string; faellig: string };
const zahlOderNull = (s: string) => (s.trim() === '' ? null : Number(s));

export function Sitzung() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [s, setS] = useState<SitzungDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kopf, setKopf] = useState<KopfForm | null>(null);
  const [top, setTop] = useState<TopForm | null>(null);
  const [eintrag, setEintrag] = useState<EintragForm | null>(null);
  const [gast, setGast] = useState<{ name: string; rolle: string } | null>(null);
  /** Verknüpfung (URL) als Anlage hinzufügen: zur Sitzung (top_id null) oder zum Tagesordnungspunkt */
  const [link, setLink] = useState<{ top_id: number | null; url: string; bezeichnung: string } | null>(null);
  const [ev, setEv] = useState<EventWahl[] | null>(null);
  const [frage, setFrage] = useState<{ titel: string; text: string; grund?: boolean; danger?: boolean; tun: (grund: string) => Promise<unknown> } | null>(null);
  const [pdf, setPdf] = useState<string | null>(null);
  /** Themenparkplatz: Themen aufnehmen (Auswahl) bzw. Tagesordnungspunkt parken */
  const [ausPark, setAusPark] = useState(false);
  const [parkTop, setParkTop] = useState<Top | null>(null);
  /** Verlauf: Tagesordnungspunkt mit einem Punkt einer anderen Sitzung verketten */
  const [verketten, setVerketten] = useState<number | null>(null);
  const datei = useRef<HTMLInputElement>(null);
  const anlageZiel = useRef<number | null>(null);

  const laden = useCallback(() => api.get<SitzungDetail>(`${VS}/sitzungen/${id}`).then(setS).catch((e) => setError(e.message)), [id]);
  useEffect(() => { laden(); }, [laden]);
  // Tagesordnung: Kopfzeile steht unter dem Seitentitel fest, nur die Punkte rollen – dazu die Höhe des (festen) Seitentitels
  const geladen = !!s;
  useEffect(() => {
    if (!geladen) return;
    const titel = document.querySelector('ui5-dynamic-page-title') as HTMLElement | null;
    const wurzel = document.documentElement.style;
    const setzen = () => {
      const r = titel?.getBoundingClientRect();
      wurzel.setProperty('--vs-titel', `${Math.round(r?.height ?? 0)}px`);
      wurzel.setProperty('--vs-oben', `${Math.round((r?.top ?? 0) + (r?.height ?? 0))}px`);
    };
    setzen();
    const ro = titel ? new ResizeObserver(setzen) : null;
    if (titel) ro!.observe(titel);
    window.addEventListener('resize', setzen);
    return () => { ro?.disconnect(); window.removeEventListener('resize', setzen); wurzel.removeProperty('--vs-titel'); wurzel.removeProperty('--vs-oben'); };
  }, [geladen]);

  /** Aufruf mit Fehleranzeige, danach neu laden */
  async function tun<T>(fn: () => Promise<T>, danach?: (r: T) => void) {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      const t = (r as { text?: string } | null)?.text;
      if (t) toast(t);
      danach?.(r);
      await laden();
      return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }

  if (!s) {
    return (
      <AppPage title="Vorstandssitzung" actions={<Button icon="nav-back" design="Transparent" onClick={() => navigate('/tco/vorstand')}>Zur Übersicht</Button>}>
        {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
      </AppPage>
    );
  }

  const rw = s.pflege && s.status !== 'FREIGEGEBEN';
  const status = (neu: Status, grund = '') => tun(() => api.post(`${VS}/sitzungen/${s.id}/status`, { status: neu, grund: grund || null }));
  const vsListe = s.teilnehmer.filter((t) => t.art === 'VORSTAND');
  const gaeste = s.teilnehmer.filter((t) => t.art === 'GAST');
  const offen = vsListe.filter((t) => t.status === 'OFFEN').length;
  const bf = s.beschlussfaehig;
  // Vorschläge für Verantwortliche immer „Vorname Nachname“ (die Teilnehmerliste führt „Nachname, Vorname“)
  const namen = s.teilnehmer.map((t) => (t.name.includes(',') ? t.name.split(',').map((x) => x.trim()).reverse().join(' ') : t.name));

  async function hochladen(l: FileList | null) {
    if (!l?.length || !s) return;
    const top_id = anlageZiel.current;
    const dateien = await Promise.all([...l].map(async (f) => ({ name: f.name, data: await dateiLesen(f) })));
    await tun(() => api.post(`${VS}/sitzungen/${s.id}/anlagen`, { top_id, dateien }));
  }
  const anlageWaehlen = (topId: number | null) => { anlageZiel.current = topId; datei.current?.click(); };
  const anlageLink = (a: { id: number; dateiname: string; url: string | null }) => (
    <Link key={a.id} href={a.url ?? `${VS}/sitzungen/${s.id}/anlagen/${a.id}`} target="_blank" tooltip={a.url ?? undefined}>{a.dateiname}</Link>
  );
  const schieben = (i: number, um: number) => {
    const ids = s.tops.map((t) => t.id);
    const j = i + um;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    tun(() => api.post(`${VS}/sitzungen/${s.id}/reihenfolge`, { tops: ids }));
  };
  const kopfOeffnen = () => setKopf({
    titel: s.titel, art: s.art, datum: s.datum, beginn: s.beginn ?? '', ende: s.ende ?? '', ort: s.ort ?? '', leitung: s.leitung ?? '',
    protokoll_von: s.protokoll_von ?? '', bemerkung: s.bemerkung ?? '',
  });
  const eintragNeu = (t: Top, art: Eintrag['art']) => setEintrag({ top_id: t.id, art, text: '', ja: '', nein: '', enthaltung: '', ergebnis: '', verantwortlich: art === 'AUFGABE' ? t.verantwortlich ?? '' : '', faellig: '' });
  const eintragAendern = (e: Eintrag) => setEintrag({
    id: e.id, top_id: e.top_id, art: e.art, text: e.text, ja: e.ja == null ? '' : String(e.ja), nein: e.nein == null ? '' : String(e.nein),
    enthaltung: e.enthaltung == null ? '' : String(e.enthaltung), ergebnis: e.ergebnis ?? '', verantwortlich: e.verantwortlich ?? '', faellig: e.faellig ?? '',
  });

  const aktionen = (
    <>
      <Button icon="nav-back" design="Transparent" onClick={() => navigate('/tco/vorstand')}>Zur Übersicht</Button>
      <Button icon="pdf-attachment" onClick={() => setPdf(`${VS}/sitzungen/${s.id}/pdf`)}>Protokoll (PDF)</Button>
      {rw && <Button icon="edit" onClick={kopfOeffnen}>Kopfdaten</Button>}
      {s.pflege && s.status === 'GEPLANT' && <Button design="Emphasized" icon="media-play" disabled={busy} onClick={() => status('LAEUFT')}>Sitzung beginnen</Button>}
      {s.pflege && s.status === 'LAEUFT' && <Button design="Emphasized" icon="stop" disabled={busy} onClick={() => status('ENTWURF')}>Sitzung beenden</Button>}
      {s.pflege && s.status === 'ENTWURF' && <Button icon="undo" disabled={busy} onClick={() => status('LAEUFT')}>Wieder öffnen</Button>}
      {s.freigabe && s.status === 'ENTWURF' && (
        <Button design="Emphasized" icon="approvals" disabled={busy} onClick={() => setFrage({ titel: 'Protokoll freigeben', text: 'Nach der Freigabe ist das Protokoll schreibgeschützt; Aufgaben lassen sich weiter abhaken.', tun: () => status('FREIGEGEBEN') })}>Freigeben</Button>
      )}
      {s.freigabe && s.status === 'FREIGEGEBEN' && (
        <Button icon="unlocked" disabled={busy} onClick={() => setFrage({ titel: 'Freigabe zurücknehmen', text: 'Das Protokoll wird wieder zum Entwurf und lässt sich ändern. Bitte den Grund angeben (Änderungsbeleg).', grund: true, tun: (g) => status('ENTWURF', g) })}>Freigabe zurücknehmen</Button>
      )}
      {s.pflege && (s.status === 'GEPLANT' || s.status === 'ENTWURF') && (
        <Button icon="delete" design="Transparent" tooltip="Sitzung löschen" onClick={() => setFrage({ titel: 'Sitzung löschen', danger: true, text: `${s.nr} „${s.titel}“ mit Tagesordnung, Beschlüssen und Anlagen löschen? Die Veranstaltung im Kalender bleibt.`, tun: async () => { await api.del(`${VS}/sitzungen/${s.id}`); toast('Sitzung gelöscht.'); navigate('/tco/vorstand'); } })} />
      )}
      <ChangeHistoryButton objectType="VS_SITZUNG" objectKey={String(s.id)} />
    </>
  );

  return (
    <AppPage title={s.titel} subtitle={`${s.nr} · ${s.art_text} · ${dat(s.datum)}${s.beginn ? ` · ${s.beginn}${s.ende ? `–${s.ende}` : ''} Uhr` : ''}${s.ort ? ` · ${s.ort}` : ''}`} actions={aktionen}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <ol className="portal-vs__status" aria-label="Status">
        {SCHRITTE.map((x, i) => {
          const akt = SCHRITTE.findIndex((y) => y.s === s.status);
          return <li key={x.s} className={i < akt ? 'portal-vs__status--fertig' : i === akt ? 'portal-vs__status--aktiv' : ''} aria-current={i === akt ? 'step' : undefined}>{i < akt ? '✓ ' : ''}{x.text}</li>;
        })}
        {s.importiert && <li className="portal-vs__status--import">aus Markdown übernommen</li>}
        {s.freigegeben_am && <li className="portal-vs__status--info">freigegeben am {dat(tagIso(s.freigegeben_am))} von {s.freigegeben_von}</li>}
      </ol>

      <input ref={datei} type="file" multiple hidden onChange={(e) => { hochladen(e.target.files); e.target.value = ''; }} />
      <div className="portal-vs__spalten">
        <div className="portal-vs__links">
          {/* ---- Veranstaltung */}
          <Section title="Veranstaltung" actions={rw ? <Button design="Transparent" icon="edit" onClick={() => api.get<Uebersicht>(VS).then((u) => setEv(u.events)).catch((e) => setError(e.message))}>{s.event ? 'Ändern' : 'Verknüpfen'}</Button> : undefined}>
            {s.event ? (
              <div className="portal-vs__event">
                <div className="portal-vs__kal" aria-hidden="true">
                  <span>{new Date(s.event.beginn).toLocaleDateString('de-DE', { month: 'short', timeZone: 'Europe/Berlin' }).replace('.', '').toUpperCase()}</span>
                  <b>{new Date(s.event.beginn).toLocaleDateString('de-DE', { day: 'numeric', timeZone: 'Europe/Berlin' }).replace('.', '')}</b>
                </div>
                <div>
                  <Link onClick={() => navigate(`/tco/kalender?veranstaltung=${s.event!.id}`)}>{s.event.titel}</Link>
                  <div className="portal-muted">Vereinskalender · {uhrzeit(s.event.beginn)} Uhr{s.event.ort ? ` · ${s.event.ort}` : ''}</div>
                  <div>{s.event.abgesagt ? <ObjectStatus state="Negative">abgesagt</ObjectStatus> : <Text>{s.event.zusagen} zugesagt · {s.event.absagen} abgesagt</Text>}</div>
                </div>
              </div>
            ) : <Empty>Keine Veranstaltung verknüpft – Datum, Zeit und Ort stehen in den Kopfdaten.</Empty>}
          </Section>

          {/* ---- Teilnehmer */}
          <Section title="Teilnehmer" count={s.teilnehmer.length}
                   status={bf.ok == null ? undefined : <ObjectStatus state={bf.ok ? 'Positive' : 'Negative'} inverted style={{ marginLeft: '0.5rem' }}>{bf.ok ? 'beschlussfähig' : 'nicht beschlussfähig'} {bf.anwesend}/{bf.gesamt}</ObjectStatus>}
                   actions={rw ? <>
                     {offen > 0 && <Button design="Transparent" onClick={() => tun(() => api.post(`${VS}/sitzungen/${s.id}/teilnahme`, { status: 'ANWESEND' }))}>Offene: alle da</Button>}
                     <Button design="Transparent" icon="synchronize" tooltip="Vorstand neu einlesen, Absagen aus dem Kalender übernehmen" onClick={() => tun(() => api.post(`${VS}/sitzungen/${s.id}/vorstand`))} />
                   </> : undefined}>
            {!vsListe.length && <Empty>Keine Vorstandsmitglieder – Vorstandsgruppe in der Übersicht prüfen.</Empty>}
            {[...vsListe, ...gaeste].map((t) => (
              <div key={t.id} className="portal-vs__person">
                <span className={`portal-vs__ini${t.art === 'GAST' ? ' portal-vs__ini--gast' : ''}`} aria-hidden="true">{initialen(t.name)}</span>
                <span className="portal-vs__pname">
                  <span>{t.name}</span>
                  <span className="portal-muted">{[t.art === 'GAST' ? 'Gast' : null, t.rolle, t.rueckmeldung ? `Kalender: ${RUECK[t.rueckmeldung] ?? t.rueckmeldung}` : null].filter(Boolean).join(' · ') || ' '}</span>
                </span>
                {rw ? (
                  <SegmentedButton accessibleName={`Teilnahme ${t.name}`} onSelectionChange={(e) => {
                    const neu = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.s as Teilnahme | undefined;
                    if (neu && neu !== t.status) tun(() => api.put(`${VS}/teilnehmer/${t.id}`, { status: neu }));
                  }}>
                    {TEILNAHME.map((x) => <SegmentedButtonItem key={x.s} data-s={x.s} selected={t.status === x.s}>{x.text}</SegmentedButtonItem>)}
                  </SegmentedButton>
                ) : <ObjectStatus state={t.status === 'ANWESEND' ? 'Positive' : t.status === 'OFFEN' ? 'None' : 'Critical'}>{{ OFFEN: 'offen', ANWESEND: 'anwesend', ENTSCHULDIGT: 'entschuldigt', FEHLT: 'fehlt' }[t.status]}</ObjectStatus>}
                {rw && t.art === 'GAST' && <Button design="Transparent" icon="decline" tooltip="Gast entfernen" onClick={() => tun(() => api.del(`${VS}/teilnehmer/${t.id}`))} />}
              </div>
            ))}
            {rw && <Button design="Transparent" icon="add" onClick={() => setGast({ name: '', rolle: '' })}>Gast</Button>}
            <div className="portal-muted portal-vs__klein">Protokoll: {s.protokoll_von ?? '–'} · Leitung: {s.leitung ?? '–'}</div>
          </Section>

          {/* ---- Anlagen zur Sitzung */}
          <Section title="Anlagen" count={s.anlagen.length} actions={s.pflege && s.status !== 'FREIGEGEBEN' ? <>
            <Button design="Transparent" icon="attachment" onClick={() => anlageWaehlen(null)}>Datei</Button>
            <Button design="Transparent" icon="chain-link" onClick={() => setLink({ top_id: null, url: '', bezeichnung: '' })}>Link</Button>
          </> : undefined}>
            {!s.anlagen.length && <Empty>Keine Anlagen.</Empty>}
            {s.anlagen.map((a) => (
              <div key={a.id} className="portal-vs__anlage">
                <Icon name={a.url ? 'chain-link' : a.mime === 'application/pdf' ? 'pdf-attachment' : a.mime.startsWith('image/') ? 'picture' : 'document'} />
                {anlageLink(a)}
                <span className="portal-muted">{a.top_id ? `TOP ${s.tops.find((t) => t.id === a.top_id)?.nr ?? ''}` : 'Sitzung'} · {a.url ? linkZiel(a.url) : groesse(a.groesse)}</span>
                {rw && <Button design="Transparent" icon="delete" tooltip="Anlage löschen" onClick={() => setFrage({ titel: 'Anlage löschen', danger: true, text: `„${a.dateiname}“ löschen?`, tun: () => tun(() => api.del(`${VS}/sitzungen/${s.id}/anlagen/${a.id}`)) })} />}
              </div>
            ))}
          </Section>

          {/* ---- Themenparkplatz: Vorschläge (Sitzung im Zeitraum) und weitere geparkte Themen */}
          {s.status !== 'FREIGEGEBEN' && <ThemenInSitzung s={s} rw={rw} stand={s.geaendert_am} onGeaendert={laden} />}
        </div>

        {/* ---- Tagesordnung und Protokoll */}
        <div className="portal-vs__rechts">
          {s.bemerkung && <Section title="Vorbemerkung"><FormatText text={s.bemerkung} className="portal-vs__text" /></Section>}
          <Section title="Tagesordnung und Protokoll" count={s.tops.length} className="portal-vs__agenda"
                   actions={rw ? <>
                     <Button design="Transparent" icon="bookmark" tooltip="Themen aus dem Themenparkplatz in die Tagesordnung aufnehmen" onClick={() => setAusPark(true)}>Aus dem Parkplatz</Button>
                     <Button design="Transparent" icon="add" onClick={() => setTop({ titel: '', verantwortlich: '', text: '', status: 'OFFEN' })}>Tagesordnungspunkt</Button>
                   </> : undefined}>
            {!s.tops.length && <Empty>Noch keine Tagesordnungspunkte.</Empty>}
            {s.tops.map((t, i) => (
              <article key={t.id} className={`portal-vs__top portal-vs__top--${t.status.toLowerCase()}`}>
                <header className="portal-vs__tkopf">
                  <span className="portal-vs__tnr">TOP {t.nr}</span>
                  <span className="portal-vs__ttitel">{t.titel}</span>
                  {t.thema_id && <ObjectStatus state="Indication05" icon={<Icon name="bookmark" />} title="aus dem Themenparkplatz">Parkplatz</ObjectStatus>}
                  {t.verlauf_vorher.length > 0 && <ObjectStatus state="Information" icon={<Icon name="history" />} title="wurde schon in früheren Sitzungen behandelt">fortgesetzt</ObjectStatus>}
                  {t.verantwortlich && <span className="portal-muted">{t.verantwortlich}</span>}
                  {t.status !== 'OFFEN' && <ObjectStatus state={t.status === 'ERLEDIGT' ? 'Positive' : 'Critical'} inverted>{t.status === 'ERLEDIGT' ? 'erledigt' : 'vertagt'}</ObjectStatus>}
                  {rw && (
                    <span className="portal-vs__tknoepfe">
                      <Button design="Transparent" icon="navigation-up-arrow" tooltip="nach oben" disabled={i === 0 || busy} onClick={() => schieben(i, -1)} />
                      <Button design="Transparent" icon="navigation-down-arrow" tooltip="nach unten" disabled={i === s.tops.length - 1 || busy} onClick={() => schieben(i, 1)} />
                      <Button design="Transparent" icon="edit" tooltip="Ändern / Protokolltext" onClick={() => setTop({ id: t.id, titel: t.titel, verantwortlich: t.verantwortlich ?? '', text: t.text ?? '', status: t.status })} />
                      <Button design="Transparent" icon="connected" tooltip="Mit einem Punkt einer früheren Sitzung verketten (Verlauf)" disabled={busy} onClick={() => setVerketten(t.id)} />
                      {t.status !== 'ERLEDIGT' && (
                        <Button design="Transparent" icon="bookmark" tooltip="In den Themenparkplatz verschieben" disabled={busy}
                                onClick={() => (t.thema_id ? tun(() => api.post(`${VS}/themen/${t.thema_id}/parken`)) : setParkTop(t))} />
                      )}
                      <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={() => setFrage({ titel: 'Tagesordnungspunkt löschen', danger: true, text: `TOP ${t.nr} „${t.titel}“ mit Beschlüssen und Aufgaben löschen?`, tun: () => tun(() => api.del(`${VS}/tops/${t.id}`)) })} />
                    </span>
                  )}
                </header>
                <TopVerlauf titel={t.titel} vorher={t.verlauf_vorher} nachher={t.verlauf_nachher} rw={rw}
                            onLoesen={() => setFrage({ titel: 'Verkettung lösen', text: `TOP ${t.nr} „${t.titel}“ aus dem Verlauf lösen? Die übrigen Punkte bleiben untereinander verkettet.`, tun: () => tun(() => api.del(`${VS}/tops/${t.id}/verketten`)) })} />
                {t.text ? <FormatText text={t.text} className="portal-vs__text" /> : rw ? <Link className="portal-vs__klein" onClick={() => setTop({ id: t.id, titel: t.titel, verantwortlich: t.verantwortlich ?? '', text: '', status: t.status })}>Protokolltext erfassen …</Link> : null}
                {t.eintraege.map((e) => (
                  <div key={e.id} className={`portal-vs__eintrag portal-vs__eintrag--${e.art.toLowerCase()}`}>
                    <span className="portal-vs__art">{e.art === 'BESCHLUSS' ? `Beschluss ${e.nr}` : e.art === 'AUFGABE' ? 'Aufgabe' : 'Info'}</span>
                    <span className="portal-vs__etext">
                      <FormatText text={e.text} kompakt className={e.erledigt_am ? 'portal-vs__erledigt' : undefined} />
                      {e.art === 'BESCHLUSS' && (abstimmung(e) || e.ergebnis) && (
                        <span className="portal-muted">{abstimmung(e)}{e.ergebnis && <ObjectStatus state={e.ergebnis === 'ANGENOMMEN' ? 'Positive' : 'Negative'} style={{ marginLeft: '0.4rem' }}>{e.ergebnis === 'ANGENOMMEN' ? 'angenommen' : 'abgelehnt'}</ObjectStatus>}</span>
                      )}
                      {e.art === 'AUFGABE' && (
                        <span className="portal-muted">{[e.verantwortlich, e.faellig && `bis ${dat(e.faellig)}`, e.erledigt_am && `erledigt ${dat(tagIso(e.erledigt_am))}${e.erledigt_von ? ` (${e.erledigt_von})` : ''}`].filter(Boolean).join(' · ') || ' '}</span>
                      )}
                    </span>
                    {e.art === 'AUFGABE' && s.pflege && (
                      <Button design="Transparent" icon={e.erledigt_am ? 'undo' : 'accept'} tooltip={e.erledigt_am ? 'wieder öffnen' : 'erledigt'}
                              onClick={() => tun(() => api.post(`${VS}/aufgaben/${e.id}/erledigt`, { erledigt: !e.erledigt_am }))} />
                    )}
                    {rw && <Button design="Transparent" icon="edit" tooltip="Ändern" onClick={() => eintragAendern(e)} />}
                    {rw && <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={() => setFrage({ titel: 'Eintrag löschen', danger: true, text: `${e.art === 'BESCHLUSS' ? `Beschluss ${e.nr} löschen? Die Nummer wird nicht neu vergeben.` : 'Eintrag löschen?'}`, tun: () => tun(() => api.del(`${VS}/eintraege/${e.id}`)) })} />}
                  </div>
                ))}
                {s.anlagen.some((a) => a.top_id === t.id) && (
                  <div className="portal-vs__tanlagen"><Icon name="attachment" /> {s.anlagen.filter((a) => a.top_id === t.id).map(anlageLink)}</div>
                )}
                {rw && (
                  <div className="portal-vs__tfuss">
                    <Button design="Transparent" icon="add" onClick={() => eintragNeu(t, 'BESCHLUSS')}>Beschluss</Button>
                    <Button design="Transparent" icon="add" onClick={() => eintragNeu(t, 'AUFGABE')}>Aufgabe</Button>
                    <Button design="Transparent" icon="add" onClick={() => eintragNeu(t, 'INFO')}>Info</Button>
                    <Button design="Transparent" icon="attachment" onClick={() => anlageWaehlen(t.id)}>Anlage</Button>
                    <Button design="Transparent" icon="chain-link" onClick={() => setLink({ top_id: t.id, url: '', bezeichnung: '' })}>Link</Button>
                    <span style={{ flex: 1 }} />
                    {t.status === 'OFFEN' && (t.thema_id
                      ? <Button design="Transparent" icon="bookmark" tooltip="nicht dazu gekommen: zurück in den Themenparkplatz" onClick={() => tun(() => api.post(`${VS}/themen/${t.thema_id}/parken`))}>Wieder parken</Button>
                      : <Button design="Transparent" onClick={() => tun(() => api.put(`${VS}/tops/${t.id}`, { ...t, status: 'VERTAGT' }))}>Vertagen</Button>)}
                    {t.status !== 'ERLEDIGT'
                      ? <Button onClick={() => tun(() => api.put(`${VS}/tops/${t.id}`, { ...t, status: 'ERLEDIGT' }))}>Abschließen</Button>
                      : <Button design="Transparent" onClick={() => tun(() => api.put(`${VS}/tops/${t.id}`, { ...t, status: 'OFFEN' }))}>Wieder öffnen</Button>}
                  </div>
                )}
              </article>
            ))}
          </Section>
        </div>
      </div>

      {/* ---- Dialoge */}
      {kopf && (
        <Dialog open headerText="Kopfdaten" onClose={() => setKopf(null)} style={{ width: 'min(44rem, 96vw)' }}
                footer={<FussLeiste endContent={<><Button design="Emphasized" disabled={!kopf.titel.trim() || busy} onClick={async () => { if (await tun(() => api.put(`${VS}/sitzungen/${s.id}`, kopf))) setKopf(null); }}>Sichern</Button><Button onClick={() => setKopf(null)}>Abbrechen</Button></>} />}>
          <FormGrid>
            <FieldBox label="Titel" required><Input value={kopf.titel} onInput={(e) => setKopf({ ...kopf, titel: e.target.value })} /></FieldBox>
            <FieldBox label="Art">
              <Select onChange={(e) => setKopf({ ...kopf, art: (e.detail.selectedOption as HTMLElement).dataset.a as KopfForm['art'] })}>
                <Option data-a="VORSTAND" selected={kopf.art === 'VORSTAND'}>Vorstandssitzung</Option>
                <Option data-a="ERWEITERT" selected={kopf.art === 'ERWEITERT'}>Erweiterte Vorstandssitzung</Option>
              </Select>
            </FieldBox>
            {s.event && <MessageStrip design="Information" hideCloseButton style={{ gridColumn: '1 / -1' }}>Datum, Zeit und Ort kommen aus der verknüpften Veranstaltung – im Vereinskalender ändern.</MessageStrip>}
            <FieldBox label="Datum"><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={kopf.datum} readonly={!!s.event} onChange={(e) => setKopf({ ...kopf, datum: e.detail.value })} /></FieldBox>
            <FieldBox label="Ort"><Input value={kopf.ort} readonly={!!s.event} onInput={(e) => setKopf({ ...kopf, ort: e.target.value })} /></FieldBox>
            <FieldBox label="Beginn (HH:MM)"><Input value={kopf.beginn} maxlength={5} readonly={!!s.event} onInput={(e) => setKopf({ ...kopf, beginn: e.target.value })} /></FieldBox>
            <FieldBox label="Ende (HH:MM)"><Input value={kopf.ende} maxlength={5} onInput={(e) => setKopf({ ...kopf, ende: e.target.value })} /></FieldBox>
            <FieldBox label="Sitzungsleitung"><Input value={kopf.leitung} showSuggestions onInput={(e) => setKopf({ ...kopf, leitung: e.target.value })}>{namen.map((n) => <SuggestionItem key={n} text={n} />)}</Input></FieldBox>
            <FieldBox label="Protokoll"><Input value={kopf.protokoll_von} showSuggestions onInput={(e) => setKopf({ ...kopf, protokoll_von: e.target.value })}>{namen.map((n) => <SuggestionItem key={n} text={n} />)}</Input></FieldBox>
            <FieldBox label="Vorbemerkung" wide><FormatEditor label="Vorbemerkung" rows={3} value={kopf.bemerkung} onChange={(v) => setKopf({ ...kopf, bemerkung: v })} /></FieldBox>
          </FormGrid>
        </Dialog>
      )}

      {top && (
        <Dialog open headerText={top.id ? 'Tagesordnungspunkt' : 'Neuer Tagesordnungspunkt'} onClose={() => setTop(null)} style={{ width: 'min(50rem, 96vw)' }}
                footer={<FussLeiste endContent={<><Button design="Emphasized" disabled={!top.titel.trim() || busy} onClick={async () => {
                  const ok = await tun(() => (top.id ? api.put(`${VS}/tops/${top.id}`, top) : api.post(`${VS}/sitzungen/${s.id}/tops`, top)));
                  if (ok) setTop(null);
                }}>Sichern</Button><Button onClick={() => setTop(null)}>Abbrechen</Button></>} />}>
          <FormGrid>
            <FieldBox label="Titel" required><Input value={top.titel} onInput={(e) => setTop({ ...top, titel: e.target.value })} /></FieldBox>
            <FieldBox label="Bericht / verantwortlich"><Input value={top.verantwortlich} showSuggestions onInput={(e) => setTop({ ...top, verantwortlich: e.target.value })}>{namen.map((n) => <SuggestionItem key={n} text={n} />)}</Input></FieldBox>
            <FieldBox label="Protokolltext" wide><FormatEditor label="Protokolltext" rows={12} value={top.text} onChange={(v) => setTop({ ...top, text: v })} placeholder="Was wurde besprochen? Beschlüsse und Aufgaben werden darunter einzeln erfasst." /></FieldBox>
          </FormGrid>
        </Dialog>
      )}

      {eintrag && (
        <Dialog open headerText={`${eintrag.id ? '' : 'Neue '}${eintrag.art === 'BESCHLUSS' ? 'Beschluss' : eintrag.art === 'AUFGABE' ? 'Aufgabe' : 'Info'}`} onClose={() => setEintrag(null)} style={{ width: 'min(44rem, 96vw)' }}
                footer={<FussLeiste endContent={<><Button design="Emphasized" disabled={!eintrag.text.trim() || busy} onClick={async () => {
                  const body = { art: eintrag.art, text: eintrag.text, ja: zahlOderNull(eintrag.ja), nein: zahlOderNull(eintrag.nein), enthaltung: zahlOderNull(eintrag.enthaltung),
                    ergebnis: eintrag.ergebnis || null, verantwortlich: eintrag.verantwortlich, faellig: eintrag.faellig || null };
                  const ok = await tun(() => (eintrag.id ? api.put(`${VS}/eintraege/${eintrag.id}`, body) : api.post(`${VS}/tops/${eintrag.top_id}/eintraege`, body)));
                  if (ok) setEintrag(null);
                }}>Sichern</Button><Button onClick={() => setEintrag(null)}>Abbrechen</Button></>} />}>
          <FormGrid>
            <FieldBox label={eintrag.art === 'BESCHLUSS' ? 'Wortlaut des Beschlusses' : eintrag.art === 'AUFGABE' ? 'Was ist zu tun?' : 'Text'} required wide>
              <FormatEditor label={eintrag.art === 'BESCHLUSS' ? 'Wortlaut des Beschlusses' : 'Text'} rows={4} value={eintrag.text} onChange={(v) => setEintrag({ ...eintrag, text: v })} />
            </FieldBox>
            {eintrag.art === 'BESCHLUSS' && (<>
              <FieldBox label="Ja"><Input type="Number" value={eintrag.ja} onInput={(e) => setEintrag({ ...eintrag, ja: e.target.value })} /></FieldBox>
              <FieldBox label="Nein"><Input type="Number" value={eintrag.nein} onInput={(e) => setEintrag({ ...eintrag, nein: e.target.value })} /></FieldBox>
              <FieldBox label="Enthaltung"><Input type="Number" value={eintrag.enthaltung} onInput={(e) => setEintrag({ ...eintrag, enthaltung: e.target.value })} /></FieldBox>
              <FieldBox label="Ergebnis">
                <Select onChange={(e) => setEintrag({ ...eintrag, ergebnis: (e.detail.selectedOption as HTMLElement).dataset.r as EintragForm['ergebnis'] })}>
                  <Option data-r="" selected={!eintrag.ergebnis}>aus den Stimmen</Option>
                  <Option data-r="ANGENOMMEN" selected={eintrag.ergebnis === 'ANGENOMMEN'}>angenommen</Option>
                  <Option data-r="ABGELEHNT" selected={eintrag.ergebnis === 'ABGELEHNT'}>abgelehnt</Option>
                </Select>
              </FieldBox>
              {!eintrag.id && <Text className="portal-muted" style={{ gridColumn: '1 / -1' }}>Die Beschlussnummer wird beim Sichern fortlaufend je Jahr vergeben.</Text>}
            </>)}
            {eintrag.art === 'AUFGABE' && (<>
              <FieldBox label="Verantwortlich"><Input value={eintrag.verantwortlich} showSuggestions onInput={(e) => setEintrag({ ...eintrag, verantwortlich: e.target.value })}>{namen.map((n) => <SuggestionItem key={n} text={n} />)}</Input></FieldBox>
              <FieldBox label="Fällig bis"><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={eintrag.faellig} onChange={(e) => setEintrag({ ...eintrag, faellig: e.detail.value })} /></FieldBox>
            </>)}
          </FormGrid>
        </Dialog>
      )}

      {gast && (
        <Dialog open headerText="Gast" onClose={() => setGast(null)} style={{ width: 'min(30rem, 96vw)' }}
                footer={<FussLeiste endContent={<><Button design="Emphasized" disabled={!gast.name.trim() || busy} onClick={async () => { if (await tun(() => api.post(`${VS}/sitzungen/${s.id}/gaeste`, gast))) setGast(null); }}>Eintragen</Button><Button onClick={() => setGast(null)}>Abbrechen</Button></>} />}>
          <FormGrid columns={1}>
            <FieldBox label="Name" required><Input value={gast.name} onInput={(e) => setGast({ ...gast, name: e.target.value })} /></FieldBox>
            <FieldBox label="Funktion / Anlass"><Input value={gast.rolle} placeholder="z. B. Jugendtrainer, zu TOP 4" onInput={(e) => setGast({ ...gast, rolle: e.target.value })} /></FieldBox>
          </FormGrid>
        </Dialog>
      )}

      {link && (
        <Dialog open headerText={`Link hinzufügen${link.top_id ? ` – TOP ${s.tops.find((t) => t.id === link.top_id)?.nr ?? ''}` : ''}`} onClose={() => setLink(null)} style={{ width: 'min(36rem, 96vw)' }}
                footer={<FussLeiste endContent={<><Button design="Emphasized" disabled={!link.url.trim() || busy} onClick={async () => {
                  const ok = await tun(() => api.post(`${VS}/sitzungen/${s.id}/links`, link));
                  if (ok) setLink(null);
                }}>Hinzufügen</Button><Button onClick={() => setLink(null)}>Abbrechen</Button></>} />}>
          <FormGrid>
            <FieldBox label="Adresse (URL)" required wide><Input value={link.url} placeholder="https://…" onInput={(e) => setLink({ ...link, url: e.target.value })} /></FieldBox>
            <FieldBox label="Bezeichnung" wide><Input value={link.bezeichnung} maxlength={200} placeholder="leer = Name der Website" onInput={(e) => setLink({ ...link, bezeichnung: e.target.value })} /></FieldBox>
          </FormGrid>
        </Dialog>
      )}

      {ev && <VeranstaltungDialog s={s} events={ev} onClose={() => setEv(null)} onSetzen={async (b) => { if (await tun(() => api.post(`${VS}/sitzungen/${s.id}/veranstaltung`, b))) setEv(null); }} />}

      {ausPark && <ThemenAuswahlDialog sitzungId={s.id} onClose={() => setAusPark(false)} onFertig={() => { setAusPark(false); laden(); }} />}
      {parkTop && <TopParkenDialog top={parkTop} onClose={() => setParkTop(null)} onFertig={() => { setParkTop(null); laden(); }} />}
      {verketten && <VerkettenDialog ziel={{ top: verketten }} onClose={() => setVerketten(null)} onFertig={() => { setVerketten(null); laden(); }} />}
      <ConfirmDialog open={!!frage} title={frage?.titel ?? ''} text={frage?.text ?? ''} askReason={frage?.grund} danger={frage?.danger}
                     confirmText={frage?.danger ? 'Löschen' : 'OK'} onCancel={() => setFrage(null)}
                     onConfirm={async (g) => { const f = frage; setFrage(null); try { await f?.tun(g); } catch (e) { setError((e as Error).message); } }} />
      {pdf && <PdfDialog url={pdf} title={`Protokoll ${s.nr}`} filename={`Protokoll ${s.nr.replace('/', '-')} ${s.titel}.pdf`} onClose={() => setPdf(null)} />}
    </AppPage>
  );
}

function VeranstaltungDialog({ s, events, onClose, onSetzen }: { s: SitzungDetail; events: EventWahl[]; onClose: () => void; onSetzen: (b: { event_id?: number | null; anlegen?: boolean }) => void }) {
  const frei = events.filter((e) => !e.sitzung_id || e.sitzung_id === s.id);
  const [wahl, setWahl] = useState<'VORHANDEN' | 'NEU' | 'LOESEN'>(frei.length ? 'VORHANDEN' : 'NEU');
  const [id, setId] = useState<number | null>(s.event?.id ?? frei.find((e) => tagIso(e.beginn) === s.datum)?.id ?? frei[0]?.id ?? null);
  return (
    <Dialog open headerText="Veranstaltung" onClose={onClose} style={{ width: 'min(40rem, 96vw)' }}
            footer={<FussLeiste endContent={<><Button design="Emphasized" disabled={wahl === 'VORHANDEN' && !id} onClick={() => onSetzen(wahl === 'VORHANDEN' ? { event_id: id } : wahl === 'NEU' ? { anlegen: true } : {})}>Übernehmen</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      <div className="portal-vs__radios">
        <RadioButton name="vs-ev" text="vorhandene Veranstaltung verknüpfen" disabled={!frei.length} checked={wahl === 'VORHANDEN'} onChange={() => setWahl('VORHANDEN')} />
        {wahl === 'VORHANDEN' && (
          <Select onChange={(e) => setId(Number((e.detail.selectedOption as HTMLElement).dataset.e))} style={{ marginLeft: '2rem', width: 'calc(100% - 2rem)' }}>
            {frei.map((e) => <Option key={e.id} data-e={e.id} selected={id === e.id}>{dat(tagIso(e.beginn))} {uhrzeit(e.beginn)} · {e.titel}{e.ort ? ` · ${e.ort}` : ''}</Option>)}
          </Select>
        )}
        <RadioButton name="vs-ev" text={`neu im Vereinskalender anlegen (${dat(s.datum)}${s.beginn ? `, ${s.beginn} Uhr` : ''}, Gruppe Vorstand)`} checked={wahl === 'NEU'} onChange={() => setWahl('NEU')} />
        {s.event && <RadioButton name="vs-ev" text="Verknüpfung lösen (Datum, Zeit und Ort bleiben in der Sitzung)" checked={wahl === 'LOESEN'} onChange={() => setWahl('LOESEN')} />}
      </div>
      <Label style={{ display: 'block', marginTop: '0.75rem' }} wrappingType="Normal">Mit einer Veranstaltung kommen Datum, Uhrzeit und Ort aus dem Vereinskalender; Absagen dort werden als „entschuldigt“ übernommen.</Label>
    </Dialog>
  );
}
