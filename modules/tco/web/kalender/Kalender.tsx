import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, DateTimePicker, Dialog, FlexBox, Icon, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, SegmentedButton, SegmentedButtonItem, Select, Tab, TabContainer, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { Empty, Section } from '@core/components/Section';
import { download } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { TCO } from '../util';
import { MassenanlageDialog } from './Massenanlage';
import { EventTabelle } from './EventTabelle';
import './kalender.css';

/**
 * Vereinskalender: Veranstaltungen ankündigen und beschreiben, Mitglieder melden sich an bzw. ab.
 * Gruppen (Mannschaften) schränken Veranstaltungen ein und zeigen offene Rückmeldungen (Mannschaftsplanung).
 */
const K = `${TCO}/kalender`;
type Status = 'ZUSAGE' | 'ABSAGE' | 'VIELLEICHT';
interface Ev {
  id: number; titel: string; beschreibung: string | null; ort: string | null; kategorie: string; beginn: string; ende: string | null; ganztags: boolean;
  anmeldung: boolean; anmeldeschluss: string | null; max_teilnehmer: number | null; begleitung: boolean; teilnehmer_sichtbar: boolean;
  gruppen: number[]; gruppen_namen: string[]; abgesagt: boolean; erstellt_von: string | null;
  zusagen: number; begleitpersonen: number; absagen: number; vielleicht: number;
  mein_status: Status | null; meine_begleitung: number; mein_kommentar: string | null; offen: string | null; voll: boolean;
}
interface Daten { events: Ev[]; kategorien: Record<string, string>; mitglied: boolean; pflege: boolean; /** eigene Gruppen samt den Gruppen darüber */ meineGruppen: number[]; gruppen: { id: number; name: string; aktiv: boolean }[] }
interface Tn { adrnr: string; name: string; status: Status; begleitung: number; kommentar: string | null; geaendert_von: string | null }
interface Detail { event: Ev; teilnehmer: { zusagen: { name: string; begleitung: number }[]; liste: Tn[]; offen: { adrnr: string; name: string }[] } }
interface Gruppe { id: number; name: string; pfad: string; beschreibung: string | null; aktiv: boolean; mitglieder: { adrnr: string; name: string; rolle: string | null }[] }

const STATUS_TEXT: Record<Status, string> = { ZUSAGE: 'Zusage', ABSAGE: 'Absage', VIELLEICHT: 'Vielleicht' };
const STATUS_STATE: Record<Status, 'Positive' | 'Negative' | 'Critical'> = { ZUSAGE: 'Positive', ABSAGE: 'Negative', VIELLEICHT: 'Critical' };
const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const tagIso = (d: Date) => d.toLocaleDateString('sv-SE');
const datum = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const uhr = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const zeitText = (e: Ev) => {
  if (e.ganztags) return e.ende && tagIso(new Date(e.ende)) !== tagIso(new Date(e.beginn)) ? `${datum(e.beginn)} – ${datum(e.ende)} · ganztags` : `${datum(e.beginn)} · ganztags`;
  if (!e.ende) return `${datum(e.beginn)} · ${uhr(e.beginn)} Uhr`;
  return tagIso(new Date(e.ende)) === tagIso(new Date(e.beginn)) ? `${datum(e.beginn)} · ${uhr(e.beginn)}–${uhr(e.ende)} Uhr` : `${datum(e.beginn)} ${uhr(e.beginn)} – ${datum(e.ende)} ${uhr(e.ende)}`;
};
/** ISO → Wert für den DateTimePicker (lokale Zeit) und zurück */
// DateTimePicker: Anzeige über displayFormat, nicht über das veraltete formatPattern. Mit formatPattern + valueFormat
// arbeitet der Kalender im Popup im Anzeigeformat, „OK“ liest aber im valueFormat – die Auswahl wurde nicht übernommen (#16).
const lokal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const ausLokal = (v: string) => (v ? new Date(v).toISOString() : null);

export function Kalender() {
  const heute = new Date();
  const [monat, setMonat] = useState({ j: heute.getFullYear(), m: heute.getMonth() });
  const [ansicht, setAnsicht] = useState<'LISTE' | 'MONAT'>('LISTE');
  const [tab, setTab] = useState('kal');
  // zählt hoch, wenn Veranstaltungen geladen wurden – die Tabelle lädt dann ebenfalls neu
  const [version, setVersion] = useState(0);
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const [form, setForm] = useState<Partial<Ev> | null>(null);
  const [masse, setMasse] = useState(false);
  // Filter der Liste: vergangene Veranstaltungen, Gruppe, Art (#33)
  const [vergangene, setVergangene] = useState(false);
  const [fGruppe, setFGruppe] = useState('');
  const [fArt, setFArt] = useState('');
  // „Nur meine Gruppen“: voreingestellt an, abschaltbar. Wirkt für Benutzer, die alle Veranstaltungen sehen (Pflege) und
  // selbst Mitglied sind – Mitglieder ohne Pflegerecht sehen ohnehin nur Veranstaltungen ihrer Gruppen und die für alle.
  const [nurMeine, setNurMeine] = useState(true);

  const von = tagIso(new Date(monat.j, monat.m, 1));
  const bis = ansicht === 'MONAT' ? tagIso(new Date(monat.j, monat.m + 1, 0)) : tagIso(new Date(monat.j, monat.m + 3, 0));
  const laden = () => api.get<Daten>(`${K}?von=${von}&bis=${bis}`).then((x) => { setD(x); setVersion((v) => v + 1); }).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [von, bis]); // eslint-disable-line react-hooks/exhaustive-deps

  async function aktion(fn: () => Promise<{ text?: string } | void>) {
    setBusy(true); setError(null);
    try { const r = await fn(); if (r?.text) toast(r.text, 5000); await laden(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  const melden = (e: Ev, status: Status) => aktion(() => api.post(`${K}/${e.id}/rueckmeldung`, { status, begleitung: e.meine_begleitung, kommentar: e.mein_kommentar }));
  const schieben = (n: number) => setMonat(({ j, m }) => { const x = new Date(j, m + n, 1); return { j: x.getFullYear(), m: x.getMonth() }; });

  // Kopie als neue Veranstaltung: alle Angaben übernehmen, Termin wird im Dialog angepasst; Rückmeldungen werden nicht kopiert
  const kopieren = (e: Ev) => { setDetail(null); setForm({ ...e, id: undefined, abgesagt: false }); };

  // Gruppe: die gewählte Gruppe und ihre Untergruppen (Pfad „A › B“); „–“ = Veranstaltungen für alle Mitglieder
  const gruppeGewaehlt = d?.gruppen.find((g) => String(g.id) === fGruppe);
  const gruppenIds = gruppeGewaehlt ? new Set(d!.gruppen.filter((g) => g.id === gruppeGewaehlt.id || g.name.startsWith(`${gruppeGewaehlt.name} › `)).map((g) => g.id)) : null;
  const meineWaehlbar = !!d?.pflege && !!d?.mitglied;
  const meine = meineWaehlbar && nurMeine ? new Set(d!.meineGruppen) : null;
  const passt = (e: Ev) => (!fArt || e.kategorie === fArt)
    && (!meine || !e.gruppen.length || e.gruppen.some((g) => meine.has(g)))
    && (fGruppe === '-' ? !e.gruppen.length : !gruppenIds || e.gruppen.some((g) => gruppenIds.has(g)));
  const jetzt = Date.now();
  const gefiltert = d ? { ...d, events: d.events.filter(passt) } : null;
  const fuerListe = gefiltert ? { ...gefiltert, events: gefiltert.events.filter((e) => vergangene || new Date(e.ende ?? e.beginn).getTime() >= jetzt) } : null;
  const ausgeblendet = gefiltert && fuerListe ? gefiltert.events.length - fuerListe.events.length : 0;

  return (
    <AppPage title="Vereinskalender" subtitle="Veranstaltungen, Termine und Mannschaften – mit An- und Abmeldung">
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {d && !d.mitglied && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Dein Benutzer ist keinem Mitglied zugeordnet – An- und Abmelden ist nur für Mitglieder möglich.</MessageStrip>}
      <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
        <Tab data-key="kal" text="Kalender" icon="calendar" selected={tab === 'kal'}>
          <div className="portal-kal__leiste">
            <Button icon="navigation-left-arrow" design="Transparent" tooltip="zurück" onClick={() => schieben(-1)} />
            <Title level="H5" className="portal-kal__monat">{MONATE[monat.m]} {monat.j}{ansicht === 'LISTE' ? ` – ${MONATE[(monat.m + 2) % 12]}` : ''}</Title>
            <Button icon="navigation-right-arrow" design="Transparent" tooltip="weiter" onClick={() => schieben(1)} />
            <Button design="Transparent" onClick={() => setMonat({ j: heute.getFullYear(), m: heute.getMonth() })}>Heute</Button>
            <SegmentedButton onSelectionChange={(e) => setAnsicht((e.detail.selectedItems[0] as HTMLElement).dataset.a as 'LISTE' | 'MONAT')}>
              <SegmentedButtonItem data-a="LISTE" icon="list" selected={ansicht === 'LISTE'}>Liste</SegmentedButtonItem>
              <SegmentedButtonItem data-a="MONAT" icon="appointment-2" selected={ansicht === 'MONAT'}>Monat</SegmentedButtonItem>
            </SegmentedButton>
            <span style={{ flex: 1 }} />
            {d?.pflege && <Button icon="paste" tooltip="Mehrere Veranstaltungen aus eingefügtem Text anlegen (z. B. Spielplan)" onClick={() => setMasse(true)}>Mehrere anlegen</Button>}
            {d?.pflege && <Button design="Emphasized" icon="add" onClick={() => setForm({ kategorie: 'VERANSTALTUNG', anmeldung: true, teilnehmer_sichtbar: true, gruppen: [], ganztags: false, begleitung: false })}>Neue Veranstaltung</Button>}
          </div>
          {d && (
            <div className="portal-kal__leiste">
              <Select accessibleName="Gruppe" style={{ width: 'min(20rem, 100%)' }} onChange={(e) => setFGruppe((e.detail.selectedOption as HTMLElement).dataset.g ?? '')}>
                <Option data-g="" selected={!fGruppe}>Alle Gruppen</Option>
                <Option data-g="-" selected={fGruppe === '-'}>Ohne Gruppe (alle Mitglieder)</Option>
                {d.gruppen.map((g) => <Option key={g.id} data-g={g.id} selected={String(g.id) === fGruppe}>{g.name}</Option>)}
              </Select>
              <Select accessibleName="Art" style={{ width: 'min(14rem, 100%)' }} onChange={(e) => setFArt((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
                <Option data-k="" selected={!fArt}>Alle Arten</Option>
                {Object.entries(d.kategorien).map(([k, t]) => <Option key={k} data-k={k} selected={k === fArt}>{t}</Option>)}
              </Select>
              {meineWaehlbar && <CheckBox text="Nur meine Gruppen" checked={nurMeine} onChange={(e) => setNurMeine(e.target.checked)} />}
              {ansicht === 'LISTE' && <CheckBox text="Vergangene anzeigen" checked={vergangene} onChange={(e) => setVergangene(e.target.checked)} />}
              {(fGruppe || fArt) && <Button design="Transparent" icon="clear-filter" onClick={() => { setFGruppe(''); setFArt(''); }}>Filter zurücksetzen</Button>}
            </div>
          )}
          {!d || !gefiltert || !fuerListe ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
            <BusyIndicator active={busy} delay={300} style={{ display: 'block', width: '100%' }}>
              <div className="portal-busy-inhalt">
                {ansicht === 'LISTE'
                  ? <Liste d={fuerListe} onOeffnen={setDetail} onMelden={melden} onKopieren={kopieren} busy={busy}
                           leer={ausgeblendet ? `${ausgeblendet} vergangene Veranstaltung${ausgeblendet === 1 ? ' ist' : 'en sind'} ausgeblendet – „Vergangene anzeigen“ blendet sie ein.`
                             : fGruppe || fArt ? 'Keine Veranstaltung passt zu Gruppe und Art in diesem Zeitraum.'
                               : meine && d.events.length ? 'In diesem Zeitraum gibt es nur Veranstaltungen anderer Gruppen – „Nur meine Gruppen“ abwählen, um sie zu sehen.' : undefined} />
                  : <Monat d={gefiltert} j={monat.j} m={monat.m} onOeffnen={setDetail} />}
              </div>
            </BusyIndicator>
          )}
        </Tab>
        {d?.pflege && (
          <Tab data-key="tabelle" text="Tabelle" icon="table-view" selected={tab === 'tabelle'}>
            <EventTabelle aktiv={tab === 'tabelle'} version={version} kategorien={d.kategorien} gruppen={d.gruppen} onOeffnen={setDetail} onGeaendert={laden} onError={setError} />
          </Tab>
        )}
        {d?.pflege && (
          <Tab data-key="gruppen" text="Gruppen / Mannschaften" icon="group" selected={tab === 'gruppen'}>
            <Gruppen aktiv={tab === 'gruppen'} onError={setError} onGeaendert={laden} />
          </Tab>
        )}
      </TabContainer>
      {detail !== null && d && <DetailDialog id={detail} pflege={d.pflege} mitglied={d.mitglied} kategorien={d.kategorien} onClose={() => { setDetail(null); laden(); }}
                                             onBearbeiten={(e) => { setDetail(null); setForm(e); }} onKopieren={kopieren} onError={setError} />}
      {masse && d && <MassenanlageDialog kategorien={d.kategorien} gruppen={d.gruppen} onClose={() => setMasse(false)}
                                         onDone={(t) => { setMasse(false); if (t) toast(t, 5000); laden(); }} />}
      {form && d && <EventDialog e={form} d={d} onClose={() => setForm(null)} onGespeichert={(t) => { setForm(null); toast(t, 5000); laden(); }} />}
    </AppPage>
  );
}

function Liste({ d, onOeffnen, onMelden, onKopieren, busy, leer }: {
  d: Daten; onOeffnen: (id: number) => void; onMelden: (e: Ev, s: Status) => void; onKopieren: (e: Ev) => void; busy: boolean;
  /** Hinweis, wenn die Liste durch einen Filter leer ist */
  leer?: string;
}) {
  if (!d.events.length) return <Empty>{leer ?? 'In diesem Zeitraum sind keine Veranstaltungen eingetragen.'}</Empty>;
  const gruppen: [string, Ev[]][] = [];
  for (const e of d.events) {
    const k = `${MONATE[new Date(e.beginn).getMonth()]} ${new Date(e.beginn).getFullYear()}`;
    const g = gruppen.find((x) => x[0] === k);
    if (g) g[1].push(e); else gruppen.push([k, [e]]);
  }
  return (
    <>
      {gruppen.map(([titel, liste]) => (
        <Section key={titel} title={titel} count={liste.length} flush>
          <div className="portal-kal__liste">
            {liste.map((e) => {
              const b = new Date(e.beginn);
              return (
                <div key={e.id} className={`portal-kal__ev${e.abgesagt ? ' portal-kal__ev--abgesagt' : ''}`}>
                  <button type="button" className="portal-kal__datum" onClick={() => onOeffnen(e.id)} aria-label={`${e.titel} öffnen`}>
                    <span className="portal-kal__wt">{WT[(b.getDay() + 6) % 7]}</span>
                    <span className="portal-kal__tag">{b.getDate()}</span>
                    <span className="portal-kal__mon">{MONATE[b.getMonth()].slice(0, 3)}</span>
                  </button>
                  <button type="button" className="portal-kal__inhalt" onClick={() => onOeffnen(e.id)}>
                    <span className="portal-kal__titel">{e.titel}{e.abgesagt && <ObjectStatus state="Negative" inverted style={{ marginLeft: '0.5rem' }}>abgesagt</ObjectStatus>}</span>
                    <span className="portal-kal__info">
                      <span>{e.ganztags ? 'ganztags' : `${uhr(e.beginn)}${e.ende ? `–${uhr(e.ende)}` : ''} Uhr`}</span>
                      {e.ort && <span><Icon name="map" className="portal-kal__ico" />{e.ort}</span>}
                      <span>{d.kategorien[e.kategorie] ?? e.kategorie}</span>
                      {e.gruppen_namen.length > 0 && <span><Icon name="group" className="portal-kal__ico" />{e.gruppen_namen.join(', ')}</span>}
                    </span>
                    {e.anmeldung && (
                      <span className="portal-kal__info">
                        <span><strong>{e.zusagen + e.begleitpersonen}</strong>{e.max_teilnehmer ? ` / ${e.max_teilnehmer}` : ''} Zusagen</span>
                        {e.anmeldeschluss && !e.offen && <span>Anmeldung bis {datum(e.anmeldeschluss)}</span>}
                        {e.voll && <ObjectStatus state="Critical">ausgebucht</ObjectStatus>}
                      </span>
                    )}
                  </button>
                  <div className="portal-kal__aktion">
                    {e.mein_status && <ObjectStatus state={STATUS_STATE[e.mein_status]} showDefaultIcon>{STATUS_TEXT[e.mein_status]}</ObjectStatus>}
                    {e.anmeldung && d.mitglied && !e.offen && (
                      <FlexBox style={{ gap: '0.25rem' }}>
                        <Button design={e.mein_status === 'ZUSAGE' ? 'Positive' : 'Default'} icon="accept" disabled={busy || (e.voll && e.mein_status !== 'ZUSAGE')} onClick={() => onMelden(e, 'ZUSAGE')}>Dabei</Button>
                        <Button design={e.mein_status === 'ABSAGE' ? 'Negative' : 'Default'} icon="decline" disabled={busy} onClick={() => onMelden(e, 'ABSAGE')}>Nicht dabei</Button>
                      </FlexBox>
                    )}
                    {e.anmeldung && e.offen && !e.abgesagt && <Text className="portal-muted portal-small">{e.offen}</Text>}
                    {d.pflege && <Button icon="copy" design="Transparent" tooltip="Als neue Veranstaltung kopieren" accessibleName={`${e.titel} kopieren`} disabled={busy} onClick={() => onKopieren(e)} />}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      ))}
    </>
  );
}

function Monat({ d, j, m, onOeffnen }: { d: Daten; j: number; m: number; onOeffnen: (id: number) => void }) {
  const erster = new Date(j, m, 1);
  const tage: (Date | null)[] = Array((erster.getDay() + 6) % 7).fill(null);
  for (let t = 1; t <= new Date(j, m + 1, 0).getDate(); t++) tage.push(new Date(j, m, t));
  const h = tagIso(new Date());
  return (
    <>
    <div className="portal-kal__monatsraster">
      {WT.map((t) => <div key={t} className="portal-kal__kopf">{t}</div>)}
      {tage.map((t, i) => {
        if (!t) return <div key={`l${i}`} />;
        const iso = tagIso(t);
        const evs = d.events.filter((e) => tagIso(new Date(e.beginn)) <= iso && tagIso(new Date(e.ende ?? e.beginn)) >= iso);
        return (
          <div key={iso} className={`portal-kal__zelle${iso === h ? ' portal-kal__zelle--heute' : ''}`}>
            <span className="portal-kal__zelle-nr">{t.getDate()}</span>
            {evs.map((e) => (
              <button key={e.id} type="button" className={`portal-kal__chip portal-kal__chip--art-${e.kategorie} portal-kal__chip--${e.mein_status ?? 'OFFEN'}${e.abgesagt ? ' portal-kal__chip--abgesagt' : ''}`}
                      onClick={() => onOeffnen(e.id)} title={`${e.titel} · ${zeitText(e)} · ${d.kategorien[e.kategorie] ?? e.kategorie}${e.mein_status ? ` · ${STATUS_TEXT[e.mein_status]}` : ''}`}>
                {!e.ganztags && <b>{uhr(e.beginn)}</b>} {e.titel}
              </button>
            ))}
          </div>
        );
      })}
    </div>
    <div className="portal-kal__legende">
      {Object.entries(d.kategorien).map(([k, t]) => <span key={k} className={`portal-kal__legende-art portal-kal__chip--art-${k}`}>{t}</span>)}
      <span><span className="portal-kal__legende-punkt" style={{ background: '#36a41d' }} />Zusage</span>
      <span><span className="portal-kal__legende-punkt" style={{ background: '#e76500' }} />Vielleicht</span>
      <span><span className="portal-kal__legende-punkt" style={{ background: '#d20a0a' }} />Absage</span>
    </div>
    </>
  );
}

function DetailDialog({ id, pflege, mitglied, kategorien, onClose, onBearbeiten, onKopieren, onError }: {
  id: number; pflege: boolean; mitglied: boolean; kategorien: Record<string, string>; onClose: () => void; onBearbeiten: (e: Ev) => void; onKopieren: (e: Ev) => void; onError: (t: string) => void;
}) {
  const [x, setX] = useState<Detail | null>(null);
  const [mitglieder, setMitglieder] = useState<{ adrnr: string; name: string }[]>([]);
  const [r, setR] = useState<{ status: Status; begleitung: string; kommentar: string }>({ status: 'ZUSAGE', begleitung: '0', kommentar: '' });
  const [busy, setBusy] = useState(false);
  const laden = () => api.get<Detail>(`${K}/${id}`).then((v) => { setX(v); setR({ status: v.event.mein_status ?? 'ZUSAGE', begleitung: String(v.event.meine_begleitung ?? 0), kommentar: v.event.mein_kommentar ?? '' }); }).catch((e) => { onError(e.message); onClose(); });
  useEffect(() => { laden(); if (pflege) api.get<typeof mitglieder>(`${K}/pflege/mitglieder?event=${id}`).then(setMitglieder).catch(() => undefined); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function lauf(fn: () => Promise<{ text?: string }>) {
    setBusy(true);
    try { const t = await fn(); if (t?.text) toast(t.text, 4000); await laden(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  if (!x) return null;
  const e = x.event;
  const setzeFuer = (adrnr: string, status: Status | null) => lauf(() => api.post(`${K}/${id}/teilnehmer`, { adrnr, status }));
  return createPortal(
    <Dialog open headerText={e.titel} onClose={onClose} style={{ width: 'min(46rem, 96vw)' }}
            footer={<Bar startContent={pflege ? <>
                           <Button icon="edit" onClick={() => onBearbeiten(e)}>Bearbeiten</Button>
                           <Button icon="copy" onClick={() => onKopieren(e)}>Kopieren</Button>
                           <Button icon="excel-attachment" onClick={() => download(`${K}/${id}/csv`, `Teilnehmer_${e.titel.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.csv`)}>Teilnehmerliste</Button>
                           <Button icon="delete" design="Transparent" disabled={busy} onClick={() => lauf(async () => { const t = await api.del<{ text: string }>(`${K}/${id}`); onClose(); return t; })}>Löschen</Button>
                         </> : undefined}
                         endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      <div className="portal-kal__detail">
        {e.abgesagt && <MessageStrip design="Negative" hideCloseButton>Diese Veranstaltung ist abgesagt.</MessageStrip>}
        <div className="portal-kal__fakten">
          <span><Icon name="appointment" className="portal-kal__ico" />{zeitText(e)}</span>
          {e.ort && <span><Icon name="map" className="portal-kal__ico" />{e.ort}</span>}
          <span><Icon name="tag" className="portal-kal__ico" />{kategorien[e.kategorie] ?? e.kategorie}</span>
          {e.gruppen_namen.length > 0 && <span><Icon name="group" className="portal-kal__ico" />nur für {e.gruppen_namen.join(', ')}</span>}
          {e.anmeldeschluss && <span><Icon name="lateness" className="portal-kal__ico" />Anmeldeschluss {datum(e.anmeldeschluss)} {uhr(e.anmeldeschluss)}</span>}
        </div>
        {e.beschreibung && <div className="portal-kal__beschreibung">{e.beschreibung}</div>}

        {e.anmeldung && mitglied && (
          <section className="portal-kal__rm">
            <Label showColon>Meine Rückmeldung</Label>
            {e.offen ? <Text className="portal-muted">{e.offen}{e.mein_status ? ` Deine Rückmeldung: ${STATUS_TEXT[e.mein_status]}.` : ''}</Text> : (
              <>
                <SegmentedButton onSelectionChange={(ev) => setR({ ...r, status: (ev.detail.selectedItems[0] as HTMLElement).dataset.s as Status })}>
                  {(['ZUSAGE', 'VIELLEICHT', 'ABSAGE'] as Status[]).map((s) => <SegmentedButtonItem key={s} data-s={s} selected={r.status === s}>{STATUS_TEXT[s]}</SegmentedButtonItem>)}
                </SegmentedButton>
                <div className="portal-kal__rm-felder">
                  {e.begleitung && r.status !== 'ABSAGE' && <Input type="Number" value={r.begleitung} onInput={(ev) => setR({ ...r, begleitung: ev.target.value })} style={{ width: '9rem' }} placeholder="Begleitpersonen" accessibleName="Begleitpersonen" />}
                  <Input value={r.kommentar} maxlength={300} onInput={(ev) => setR({ ...r, kommentar: ev.target.value })} placeholder="Kommentar (optional)" style={{ flex: 1 }} />
                  <Button design="Emphasized" disabled={busy || (e.voll && r.status === 'ZUSAGE' && e.mein_status !== 'ZUSAGE')}
                          onClick={() => lauf(() => api.post(`${K}/${id}/rueckmeldung`, { status: r.status, begleitung: Number(r.begleitung) || 0, kommentar: r.kommentar || null }))}>Speichern</Button>
                </div>
              </>
            )}
          </section>
        )}

        {e.anmeldung && (
          <section>
            <Label showColon>
              {e.zusagen + e.begleitpersonen} Zusage(n){e.max_teilnehmer ? ` von ${e.max_teilnehmer} Plätzen` : ''}{pflege ? ` · ${e.absagen} Absage(n) · ${e.vielleicht} vielleicht` : ''}
            </Label>
            {!pflege && (x.teilnehmer.zusagen.length
              ? <div className="portal-kal__namen">{x.teilnehmer.zusagen.map((z) => <span key={z.name}>{z.name}{z.begleitung ? ` +${z.begleitung}` : ''}</span>)}</div>
              : <Text className="portal-muted portal-small">{e.teilnehmer_sichtbar ? 'Noch keine Zusagen.' : 'Die Teilnehmerliste ist nur für die Organisatoren sichtbar.'}</Text>)}
            {pflege && (
              <div className="portal-kal__tabelle">
                {x.teilnehmer.liste.map((t) => (
                  <div key={t.adrnr} className="portal-kal__tn">
                    <span>{t.name}{t.begleitung ? ` +${t.begleitung}` : ''}{t.kommentar && <span className="portal-muted"> – {t.kommentar}</span>}</span>
                    <Select style={{ width: '9rem' }} disabled={busy} onChange={(ev) => { const s = (ev.detail.selectedOption as HTMLElement).dataset.s; setzeFuer(t.adrnr, s === 'X' ? null : s as Status); }}>
                      {(['ZUSAGE', 'VIELLEICHT', 'ABSAGE'] as Status[]).map((s) => <Option key={s} data-s={s} selected={t.status === s}>{STATUS_TEXT[s]}</Option>)}
                      <Option data-s="X">entfernen</Option>
                    </Select>
                  </div>
                ))}
                {x.teilnehmer.offen.length > 0 && <>
                  <Label style={{ marginTop: '0.5rem' }}>Noch keine Rückmeldung ({x.teilnehmer.offen.length})</Label>
                  {x.teilnehmer.offen.map((t) => (
                    <div key={t.adrnr} className="portal-kal__tn portal-kal__tn--offen">
                      <span>{t.name}</span>
                      <FlexBox style={{ gap: '0.25rem' }}>
                        <Button icon="accept" design="Transparent" tooltip="Zusage eintragen" disabled={busy} onClick={() => setzeFuer(t.adrnr, 'ZUSAGE')} />
                        <Button icon="decline" design="Transparent" tooltip="Absage eintragen" disabled={busy} onClick={() => setzeFuer(t.adrnr, 'ABSAGE')} />
                      </FlexBox>
                    </div>
                  ))}
                </>}
                <AuswahlBox eintraege={mitglieder.filter((m) => !x.teilnehmer.liste.some((t) => t.adrnr === m.adrnr)).map((m) => ({ key: m.adrnr, text: m.name }))} wert="" placeholder={e.gruppen.length ? 'Mitglied der Gruppe eintragen …' : 'Mitglied eintragen …'} style={{ width: '100%', marginTop: '0.5rem' }}
                            onWaehle={(k) => { if (k) setzeFuer(k, 'ZUSAGE'); }} />
              </div>
            )}
          </section>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}

function EventDialog({ e, d, onClose, onGespeichert }: { e: Partial<Ev>; d: Daten; onClose: () => void; onGespeichert: (t: string) => void }) {
  const [f, setF] = useState({
    titel: e.titel ?? '', beschreibung: e.beschreibung ?? '', ort: e.ort ?? '', kategorie: e.kategorie ?? 'VERANSTALTUNG',
    beginn: lokal(e.beginn ?? null), ende: lokal(e.ende ?? null), ganztags: !!e.ganztags, anmeldung: e.anmeldung ?? true,
    anmeldeschluss: lokal(e.anmeldeschluss ?? null), max: e.max_teilnehmer ? String(e.max_teilnehmer) : '', begleitung: !!e.begleitung,
    sichtbar: e.teilnehmer_sichtbar ?? true, gruppen: e.gruppen ?? [], abgesagt: !!e.abgesagt,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function speichern() {
    setBusy(true); setError(null);
    try {
      const body = {
        titel: f.titel, beschreibung: f.beschreibung || null, ort: f.ort || null, kategorie: f.kategorie, beginn: ausLokal(f.beginn), ende: ausLokal(f.ende),
        ganztags: f.ganztags, anmeldung: f.anmeldung, anmeldeschluss: f.anmeldung ? ausLokal(f.anmeldeschluss) : null, max_teilnehmer: f.max ? Number(f.max) : null,
        begleitung: f.begleitung, teilnehmer_sichtbar: f.sichtbar, gruppen: f.gruppen, abgesagt: f.abgesagt,
      };
      const r = e.id ? await api.put<{ text: string }>(`${K}/${e.id}`, body) : await api.post<{ text: string }>(K, body);
      onGespeichert(r.text);
    } catch (x) { setError((x as Error).message); } finally { setBusy(false); }
  }
  return createPortal(
    <Dialog open headerText={e.id ? 'Veranstaltung bearbeiten' : 'Neue Veranstaltung'} onClose={onClose} style={{ width: 'min(42rem, 96vw)' }}
            footer={<Bar endContent={<><Button design="Emphasized" disabled={busy || !f.titel.trim() || !f.beginn} onClick={speichern}>Speichern</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      <div className="portal-kal__form">
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Label required>Titel</Label>
        <Input value={f.titel} maxlength={120} onInput={(x) => setF({ ...f, titel: x.target.value })} />
        <div className="portal-kal__zwei">
          <div><Label>Art</Label>
            <Select style={{ width: '100%' }} onChange={(x) => setF({ ...f, kategorie: (x.detail.selectedOption as HTMLElement).dataset.k! })}>
              {Object.entries(d.kategorien).map(([k, t]) => <Option key={k} data-k={k} selected={f.kategorie === k}>{t}</Option>)}
            </Select>
          </div>
          <div><Label>Ort</Label><Input value={f.ort} onInput={(x) => setF({ ...f, ort: x.target.value })} style={{ width: '100%' }} placeholder="z. B. Clubhaus" /></div>
        </div>
        <div className="portal-kal__zwei">
          <div><Label required>Beginn</Label><DateTimePicker value={f.beginn} valueFormat="yyyy-MM-dd'T'HH:mm" displayFormat="dd.MM.yyyy HH:mm" style={{ width: '100%' }} onChange={(x) => setF({ ...f, beginn: x.detail.value })} /></div>
          <div><Label>Ende</Label><DateTimePicker value={f.ende} valueFormat="yyyy-MM-dd'T'HH:mm" displayFormat="dd.MM.yyyy HH:mm" style={{ width: '100%' }} onChange={(x) => setF({ ...f, ende: x.detail.value })} /></div>
        </div>
        <CheckBox text="ganztägig" checked={f.ganztags} onChange={(x) => setF({ ...f, ganztags: x.target.checked })} />
        <Label>Beschreibung</Label>
        <TextArea rows={5} value={f.beschreibung} maxlength={5000} onInput={(x) => setF({ ...f, beschreibung: x.target.value })} placeholder="Ablauf, Kosten, Mitbringen, Ansprechpartner …" />
        <Label>Nur für Gruppen (leer = alle Mitglieder)</Label>
        <MultiComboBox placeholder="alle Mitglieder" onSelectionChange={(x) => setF({ ...f, gruppen: x.detail.items.map((i) => Number((i as HTMLElement).dataset.g)) })}>
          {d.gruppen.filter((g) => g.aktiv || f.gruppen.includes(g.id)).map((g) => <MultiComboBoxItem key={g.id} data-g={g.id} text={g.name} selected={f.gruppen.includes(g.id)} />)}
        </MultiComboBox>
        <CheckBox text="An- und Abmeldung" checked={f.anmeldung} onChange={(x) => setF({ ...f, anmeldung: x.target.checked })} />
        {f.anmeldung && (
          <>
            <div className="portal-kal__zwei">
              <div><Label>Anmeldeschluss</Label><DateTimePicker value={f.anmeldeschluss} valueFormat="yyyy-MM-dd'T'HH:mm" displayFormat="dd.MM.yyyy HH:mm" style={{ width: '100%' }} onChange={(x) => setF({ ...f, anmeldeschluss: x.detail.value })} /></div>
              <div><Label>Max. Teilnehmer</Label><Input type="Number" value={f.max} onInput={(x) => setF({ ...f, max: x.target.value })} style={{ width: '100%' }} placeholder="unbegrenzt" /></div>
            </div>
            <CheckBox text="Begleitpersonen erfassen" checked={f.begleitung} onChange={(x) => setF({ ...f, begleitung: x.target.checked })} />
            <CheckBox text="Mitglieder sehen, wer zugesagt hat" checked={f.sichtbar} onChange={(x) => setF({ ...f, sichtbar: x.target.checked })} />
          </>
        )}
        {e.id && <CheckBox text="Veranstaltung abgesagt" checked={f.abgesagt} onChange={(x) => setF({ ...f, abgesagt: x.target.checked })} />}
      </div>
    </Dialog>,
    document.body,
  );
}

function Gruppen({ aktiv, onError, onGeaendert }: { aktiv: boolean; onError: (t: string) => void; onGeaendert: () => void }) {
  const [liste, setListe] = useState<Gruppe[] | null>(null);
  const [mitglieder, setMitglieder] = useState<{ adrnr: string; name: string }[]>([]);
  const [neu, setNeu] = useState('');
  const [busy, setBusy] = useState(false);
  const laden = () => api.get<Gruppe[]>(`${K}/pflege/gruppen`).then(setListe).catch((e) => onError(e.message));
  useEffect(() => { if (aktiv) { laden(); api.get<typeof mitglieder>(`${K}/pflege/mitglieder`).then(setMitglieder).catch(() => undefined); } }, [aktiv]); // eslint-disable-line react-hooks/exhaustive-deps
  async function lauf(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await laden(); onGeaendert(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  if (!liste) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  return (
    <>
      <FlexBox style={{ gap: '0.5rem', margin: '0.75rem 0' }} alignItems="Center">
        <Input value={neu} placeholder="Neue Gruppe, z. B. Herren 40" onInput={(e) => setNeu(e.target.value)} style={{ width: '18rem' }} />
        <Button icon="add" design="Emphasized" disabled={busy || !neu.trim()} onClick={() => lauf(async () => { await api.post(`${K}/pflege/gruppen`, { name: neu }); setNeu(''); })}>Gruppe anlegen</Button>
      </FlexBox>
      {!liste.length && <Empty>Noch keine Gruppen – z. B. Mannschaften für die Mannschaftsplanung anlegen.</Empty>}
      {liste.length > 0 && <MessageStrip hideCloseButton design="Information" style={{ marginBottom: '0.5rem' }}>Kategorien, Untergruppen und das Verschieben im Baum pflegst du unter Mitglieder → Mitgliedergruppen.</MessageStrip>}
      <div className="portal-kal__gruppen">
        {liste.map((g) => (
          <Section key={g.id} title={g.pfad} count={g.mitglieder.length}
                   actions={<Button icon="delete" design="Transparent" tooltip="Gruppe löschen" disabled={busy} onClick={() => lauf(() => api.del(`${K}/pflege/gruppen/${g.id}`))} />}>
            {g.mitglieder.map((m) => (
              <div key={m.adrnr} className="portal-kal__tn">
                <span>{m.name}</span>
                <FlexBox style={{ gap: '0.25rem' }} alignItems="Center">
                  <Input value={m.rolle ?? ''} placeholder="Rolle" style={{ width: '9rem' }} onChange={(e) => lauf(() => api.post(`${K}/pflege/gruppen/${g.id}/mitglieder`, { adrnr: m.adrnr, rolle: e.target.value }))} />
                  <Button icon="decline" design="Transparent" tooltip="Aus der Gruppe entfernen" disabled={busy} onClick={() => lauf(() => api.post(`${K}/pflege/gruppen/${g.id}/mitglieder`, { adrnr: m.adrnr, entfernen: true }))} />
                </FlexBox>
              </div>
            ))}
            <AuswahlBox eintraege={mitglieder.filter((m) => !g.mitglieder.some((x) => x.adrnr === m.adrnr)).map((m) => ({ key: m.adrnr, text: m.name }))} wert=""
                        placeholder="Mitglied hinzufügen …" style={{ width: '100%', marginTop: '0.5rem' }}
                        onWaehle={(k) => { if (k) lauf(() => api.post(`${K}/pflege/gruppen/${g.id}/mitglieder`, { adrnr: k })); }} />
          </Section>
        ))}
      </div>
    </>
  );
}
