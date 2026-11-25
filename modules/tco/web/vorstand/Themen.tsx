import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, DatePicker, Dialog, Icon, Input, Link, MessageStrip, ObjectStatus, SegmentedButton, SegmentedButtonItem,
  SuggestionItem, Text,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { ResponsiveTable } from '@core/components/ResponsiveTable';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { dat, dateiLesen } from '../util';
import { PRIO_STATE, THEMA_STATE, VS, zeitraum, type SitzungDetail, type Thema, type ThemenDaten } from './typen';
import { FormatEditor, FormatText } from './FormatText';
import { ThemaVerlauf, VerkettenDialog } from './Verlauf';

/**
 * Themenparkplatz der Vorstandssitzungen: Themen sammeln, beschreiben, priorisieren (hoch/mittel/niedrig), mit Anlagen und
 * einem Zeitraum für die Besprechung. Der Einreicher ist verantwortlich. In der Sitzung werden Themen zugeordnet (werden zum
 * Tagesordnungspunkt) oder wieder geparkt; fällt eine Sitzung in den Zeitraum, wird das Thema dort vorgeschlagen.
 */
const PRIOS: { p: 1 | 2 | 3; text: string }[] = [{ p: 1, text: 'hoch' }, { p: 2, text: 'mittel' }, { p: 3, text: 'niedrig' }];
const groesse = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
/** Zeilenhöhe der Themenübersicht: Platz für Titel, zwei Zeilen Beschreibung bzw. Stand mit Sitzung */
export const THEMEN_ZEILENHOEHE = 88;
const tagIsoLokal = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

/** Stand eines Themas als Kennzeichen, mit Sitzung */
export function ThemaStandAnzeige({ t, onSitzung }: { t: Thema; onSitzung?: (id: number) => void }) {
  return (
    <span className="portal-vs__zelle2">
      <span>
        <ObjectStatus state={THEMA_STATE[t.stand]} inverted>{t.stand_text}</ObjectStatus>
        {t.ueberfaellig && <ObjectStatus state="Negative" style={{ marginLeft: '0.4rem' }}>Zeitraum vorbei</ObjectStatus>}
        {!t.ueberfaellig && t.frist && (
          <ObjectStatus state={t.frist === 'VERSPAETET' ? 'Negative' : 'Critical'} icon={<Icon name="bookmark" />} style={{ marginLeft: '0.4rem' }}>
            {t.frist === 'VERSPAETET' ? 'verspätet' : 'beginnt bald'}
          </ObjectStatus>
        )}
      </span>
      {t.sitzung && (
        <span className="portal-muted">
          {t.stand === 'GEPARKT' ? (t.sitzung.vertagt ? 'zuletzt vertagt in ' : 'zuletzt in ') : ''}
          {onSitzung ? <Link onClick={() => onSitzung(t.sitzung!.id)}>{t.sitzung.nr} · {dat(t.sitzung.datum)}</Link> : `${t.sitzung.nr} · ${dat(t.sitzung.datum)}`}
        </span>
      )}
      {t.stand === 'ABGESCHLOSSEN' && t.abschluss_grund && <span className="portal-muted">{t.abschluss_grund}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- Übersicht (Reiter in den Vorstandssitzungen)

export function ThemenParkplatz({ onFehler }: { onFehler: (t: string) => void }) {
  const navigate = useNavigate();
  const [offen, setOffen] = useState(true);
  const [d, setD] = useState<ThemenDaten | null>(null);
  const [dialog, setDialog] = useState<number | 'neu' | null>(null);
  const laden = useCallback(() => api.get<ThemenDaten>(`${VS}/themen${qs({ offen: offen ? 1 : 0 })}`).then(setD).catch((e) => onFehler(e.message)), [offen, onFehler]);
  useEffect(() => { laden(); }, [laden]);

  const spalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Thema', accessor: 'titel', minWidth: 260, Cell: ({ row }: Cell) => (
      <span className="portal-vs__zelle2">
        <Link onClick={() => setDialog(row.original.id)}>{row.original.titel}</Link>
        {row.original.beschreibung && <span className="portal-muted portal-vs__kurz">{(row.original.beschreibung as string).replace(/[*_~`#>[\]()]/g, '').slice(0, 140)}</span>}
      </span>) },
    { Header: 'Priorität', accessor: 'prioritaet', width: 100, Cell: ({ row }: Cell) => <ObjectStatus state={PRIO_STATE[row.original.prioritaet]}>{row.original.prioritaet_text}</ObjectStatus> },
    { Header: 'Einreicher', accessor: 'einreicher', width: 160 },
    { Header: 'Zeitraum', accessor: 'bis', width: 170, Cell: ({ row }: Cell) => zeitraum(row.original.von, row.original.bis) },
    { Header: 'Stand', accessor: 'stand', width: 220, Cell: ({ row }: Cell) => <ThemaStandAnzeige t={row.original as Thema} onSitzung={(id) => navigate(`/tco/vorstand/${id}`)} /> },
    { Header: 'Anlagen', accessor: 'anlagen', width: 85, Cell: ({ row }: Cell) => (row.original.anlagen.length ? <span><Icon name="attachment" /> {row.original.anlagen.length}</span> : '–') },
  ];

  return (
    <Section flush plain>
      <div className="portal-vs__filter">
        <CheckBox text="nur offene (geparkt oder eingeplant)" checked={offen} onChange={(e) => setOffen(e.target.checked)} />
        <span style={{ flex: 1 }} />
        <Button design="Emphasized" icon="add" onClick={() => setDialog('neu')}>Thema parken</Button>
      </div>
      {!d ? <BusyIndicator active /> : (
        <ResponsiveTable columns={spalten} data={d.themen} noDataText="Keine Themen – „Thema parken“ sammelt Themen für kommende Sitzungen."
                         rowHeight={THEMEN_ZEILENHOEHE} visibleRows={Math.min(Math.max(d.themen.length, 3), 25)} />
      )}
      {dialog !== null && d && (
        <ThemaDialog id={dialog === 'neu' ? null : dialog} daten={d} onClose={() => setDialog(null)} onGeaendert={laden} />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- Dialog: einreichen, ändern, Anlagen, abschließen

type Form = { titel: string; beschreibung: string; prioritaet: 1 | 2 | 3; einreicher: string; von: string; bis: string };
type Neu = { dateien: { name: string; data: string; groesse: number }[]; links: { url: string; bezeichnung: string }[] };

export function ThemaDialog({ id, daten, onClose, onGeaendert }: {
  id: number | null; daten: Pick<ThemenDaten, 'vorstand' | 'ich' | 'pflege'>; onClose: () => void; onGeaendert: () => void;
}) {
  const navigate = useNavigate();
  const [t, setT] = useState<Thema | null>(null);
  const [f, setF] = useState<Form | null>(id ? null : ((): Form => {
    const h = new Date();
    const bis = new Date(h); bis.setMonth(bis.getMonth() + 3);
    return { titel: '', beschreibung: '', prioritaet: 2, einreicher: daten.ich, von: tagIsoLokal(h), bis: tagIsoLokal(bis) };
  })());
  const [neu, setNeu] = useState<Neu>({ dateien: [], links: [] });
  const [link, setLink] = useState<{ url: string; bezeichnung: string } | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [frage, setFrage] = useState<{ titel: string; text: string; grund?: boolean; danger?: boolean; tun: (g: string) => Promise<unknown> } | null>(null);
  const [verketten, setVerketten] = useState(false);
  const datei = useRef<HTMLInputElement>(null);

  const laden = useCallback(async () => {
    if (!id) return;
    try {
      const x = await api.get<Thema>(`${VS}/themen/${id}`);
      setT(x);
      setF((alt) => alt ?? { titel: x.titel, beschreibung: x.beschreibung ?? '', prioritaet: x.prioritaet, einreicher: x.einreicher, von: x.von, bis: x.bis });
    } catch (e) { setFehler((e as Error).message); }
  }, [id]);
  useEffect(() => { laden(); }, [laden]);

  const darf = !t || t.eigenes || daten.pflege;
  const rw = darf && (!t || t.stand !== 'ABGESCHLOSSEN');
  const ok = !!f && !!f.titel.trim() && /^\d{4}-\d{2}-\d{2}$/.test(f.von) && /^\d{4}-\d{2}-\d{2}$/.test(f.bis) && f.bis >= f.von;

  async function tun(fn: () => Promise<unknown>, schliessen = false) {
    setBusy(true); setFehler(null);
    try {
      const r = await fn();
      const text = (r as { text?: string } | null)?.text;
      if (text) toast(text);
      onGeaendert();
      if (schliessen) onClose(); else await laden();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  async function sichern() {
    if (!f) return;
    const body = { ...f, einreicher: f.einreicher.trim() || null };
    if (t) await tun(() => api.put(`${VS}/themen/${t.id}`, body), true);
    else await tun(() => api.post(`${VS}/themen`, { ...body, dateien: neu.dateien.map(({ name, data }) => ({ name, data })), links: neu.links }), true);
  }

  async function dateienGewaehlt(l: FileList | null) {
    if (!l?.length) return;
    const dateien = await Promise.all([...l].map(async (x) => ({ name: x.name, data: await dateiLesen(x), groesse: x.size })));
    if (t) await tun(() => api.post(`${VS}/themen/${t.id}/anlagen`, { dateien: dateien.map(({ name, data }) => ({ name, data })) }));
    else setNeu({ ...neu, dateien: [...neu.dateien, ...dateien] });
  }
  async function linkDazu() {
    if (!link?.url.trim()) return;
    if (t) await tun(() => api.post(`${VS}/themen/${t.id}/links`, { url: link.url, bezeichnung: link.bezeichnung || null }));
    else setNeu({ ...neu, links: [...neu.links, { url: link.url.trim(), bezeichnung: link.bezeichnung.trim() }] });
    setLink(null);
  }

  const titel = !id ? 'Thema parken' : t ? `Thema: ${t.titel}` : 'Thema';
  return (
    <Dialog open headerText={titel} onClose={onClose} style={{ width: 'min(48rem, 96vw)' }}
            footer={<Bar
              startContent={t ? <>
                {darf && t.stand !== 'EINGEPLANT' && (t.stand === 'ABGESCHLOSSEN'
                  ? <Button icon="undo" disabled={busy} onClick={() => tun(() => api.post(`${VS}/themen/${t.id}/abschliessen`, { abgeschlossen: false }))}>Wieder parken</Button>
                  : <Button icon="accept" disabled={busy} onClick={() => setFrage({ titel: 'Thema abschließen', grund: true, text: 'Das Thema wird ohne (weitere) Sitzung abgeschlossen – erledigt oder zurückgezogen. Bitte kurz begründen.', tun: (g) => tun(() => api.post(`${VS}/themen/${t.id}/abschliessen`, { abgeschlossen: true, grund: g })) })}>Abschließen</Button>)}
                {darf && !t.sitzung && <Button icon="delete" design="Transparent" tooltip="Thema löschen" disabled={busy} onClick={() => setFrage({ titel: 'Thema löschen', danger: true, text: `„${t.titel}“ samt Anlagen löschen?`, tun: () => tun(() => api.del(`${VS}/themen/${t.id}`), true) })} />}
                <ChangeHistoryButton objectType="VS_THEMA" objectKey={String(t.id)} />
              </> : undefined}
              endContent={<>
                {rw && <Button design="Emphasized" disabled={!ok || busy} onClick={sichern}>{t ? 'Sichern' : 'Parken'}</Button>}
                <Button onClick={onClose}>{rw ? 'Abbrechen' : 'Schließen'}</Button>
              </>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      {!f ? <BusyIndicator active /> : (<>
        {t && (
          <div className="portal-vs__thema-kopf">
            <ThemaStandAnzeige t={t} onSitzung={(sid) => { onClose(); navigate(`/tco/vorstand/${sid}`); }} />
            <span className="portal-muted">eingereicht {dat(tagIsoLokal(new Date(t.erstellt_am)))}{t.erstellt_von ? ` von ${t.erstellt_von}` : ''}</span>
          </div>
        )}
        {t && !darf && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Ändern kann nur der Einreicher oder wer Vorstandssitzungen pflegt.</MessageStrip>}
        {t?.stand === 'EINGEPLANT' && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Das Thema steht auf der Tagesordnung von {t.sitzung?.nr}. Änderungen hier ändern den Tagesordnungspunkt nicht.</MessageStrip>}
        <FormGrid>
          <FieldBox label="Thema" required wide><Input className="portal-vs__thema-titel" style={{ width: '100%' }} value={f.titel} readonly={!rw} maxlength={200} onInput={(e) => setF({ ...f, titel: e.target.value })} /></FieldBox>
          <FieldBox label="Priorität">
            <SegmentedButton accessibleName="Priorität" onSelectionChange={(e) => {
              const p = Number((e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.p) as 1 | 2 | 3;
              if (p && rw) setF({ ...f, prioritaet: p });
            }}>
              {PRIOS.map((x) => <SegmentedButtonItem key={x.p} data-p={x.p} selected={f.prioritaet === x.p} disabled={!rw}>{x.text}</SegmentedButtonItem>)}
            </SegmentedButton>
          </FieldBox>
          <FieldBox label="Einreicher (verantwortlich)">
            <Input value={f.einreicher} readonly={!rw} showSuggestions onInput={(e) => setF({ ...f, einreicher: e.target.value })}>
              {daten.vorstand.map((n) => <SuggestionItem key={n} text={n} />)}
            </Input>
          </FieldBox>
          <FieldBox label="Besprechen ab" required>
            <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.von} readonly={!rw} onChange={(e) => setF({ ...f, von: e.detail.value })} />
          </FieldBox>
          <FieldBox label="spätestens bis" required>
            <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.bis} readonly={!rw} valueState={f.bis && f.von && f.bis < f.von ? 'Negative' : 'None'}
                        onChange={(e) => setF({ ...f, bis: e.detail.value })} />
          </FieldBox>
          <FieldBox label="Beschreibung" wide>
            {rw
              ? <FormatEditor label="Beschreibung" rows={6} value={f.beschreibung} onChange={(v) => setF({ ...f, beschreibung: v })} placeholder="Worum geht es, was soll entschieden werden, Hintergrund …" />
              : f.beschreibung ? <FormatText text={f.beschreibung} className="portal-vs__text" /> : <Text className="portal-muted">–</Text>}
          </FieldBox>
          <FieldBox label="Anlagen" wide>
            <div className="portal-vs__thema-anlagen">
              {t?.anlagen.map((a) => (
                <span key={a.id} className="portal-vs__thema-anlage">
                  <Icon name={a.url ? 'chain-link' : 'attachment'} />
                  <Link href={a.url ?? `${VS}/themen/${t.id}/anlagen/${a.id}`} target="_blank">{a.dateiname}</Link>
                  {!a.url && <span className="portal-muted">{groesse(a.groesse)}</span>}
                  {rw && <Button design="Transparent" icon="decline" tooltip="Anlage entfernen" disabled={busy} onClick={() => tun(() => api.del(`${VS}/themen/${t.id}/anlagen/${a.id}`))} />}
                </span>
              ))}
              {!t && neu.dateien.map((a, i) => (
                <span key={`d${i}`} className="portal-vs__thema-anlage"><Icon name="attachment" />{a.name}<span className="portal-muted">{groesse(a.groesse)}</span>
                  <Button design="Transparent" icon="decline" tooltip="entfernen" onClick={() => setNeu({ ...neu, dateien: neu.dateien.filter((_, j) => j !== i) })} /></span>
              ))}
              {!t && neu.links.map((a, i) => (
                <span key={`l${i}`} className="portal-vs__thema-anlage"><Icon name="chain-link" />{a.bezeichnung || a.url}
                  <Button design="Transparent" icon="decline" tooltip="entfernen" onClick={() => setNeu({ ...neu, links: neu.links.filter((_, j) => j !== i) })} /></span>
              ))}
              {!(t?.anlagen.length || neu.dateien.length || neu.links.length) && <span className="portal-muted">keine</span>}
              {rw && (
                <span className="portal-vs__thema-knoepfe">
                  <Button design="Transparent" icon="attachment" disabled={busy} onClick={() => datei.current?.click()}>Datei</Button>
                  <Button design="Transparent" icon="chain-link" disabled={busy} onClick={() => setLink({ url: '', bezeichnung: '' })}>Link</Button>
                </span>
              )}
              {link && (
                <span className="portal-vs__thema-link">
                  <Input placeholder="https://…" value={link.url} onInput={(e) => setLink({ ...link, url: e.target.value })} style={{ flex: '2 1 14rem' }} />
                  <Input placeholder="Bezeichnung (optional)" value={link.bezeichnung} onInput={(e) => setLink({ ...link, bezeichnung: e.target.value })} style={{ flex: '1 1 10rem' }} />
                  <Button icon="add" disabled={!link.url.trim() || busy} onClick={linkDazu}>Hinzufügen</Button>
                  <Button design="Transparent" icon="decline" onClick={() => setLink(null)} />
                </span>
              )}
            </div>
            <input ref={datei} type="file" multiple hidden onChange={(e) => { dateienGewaehlt(e.target.files); e.target.value = ''; }} />
          </FieldBox>
          {t && (
            <FieldBox label="Verlauf in Sitzungen" wide>
              <div className="portal-vs__thema-verlauf">
                <ThemaVerlauf verlauf={t.verlauf ?? []} onSitzung={(sid) => { onClose(); navigate(`/tco/vorstand/${sid}`); }} />
                {daten.pflege && t.stand !== 'ABGESCHLOSSEN' && (
                  <Button design="Transparent" icon="connected" disabled={busy} onClick={() => setVerketten(true)}>Mit früherem Punkt verketten</Button>
                )}
              </div>
            </FieldBox>
          )}
        </FormGrid>
        <Text className="portal-muted" style={{ display: 'block', marginTop: '0.5rem' }}>
          Fällt eine Vorstandssitzung in den Zeitraum, wird das Thema dort vorgeschlagen – bei einer neuen Sitzung mit Tagesordnungsvorschlag gleich eingeplant.
        </Text>
      </>)}
      {verketten && t && <VerkettenDialog ziel={{ thema: t.id }} onClose={() => setVerketten(false)} onFertig={() => { setVerketten(false); onGeaendert(); laden(); }} />}
      <ConfirmDialog open={!!frage} title={frage?.titel ?? ''} text={frage?.text ?? ''} askReason={frage?.grund} danger={frage?.danger}
                     confirmText={frage?.danger ? 'Löschen' : 'OK'} onCancel={() => setFrage(null)}
                     onConfirm={async (g) => { const x = frage; setFrage(null); await x?.tun(g); }} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- in der Sitzung: Vorschläge und weitere geparkte Themen

export function ThemenInSitzung({ s, rw, stand, onGeaendert }: { s: SitzungDetail; rw: boolean; stand: string; onGeaendert: () => void }) {
  const [d, setD] = useState<{ vorgeschlagen: Thema[]; weitere: Thema[] } | null>(null);
  const [alle, setAlle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [dialog, setDialog] = useState<number | 'neu' | null>(null);
  const [daten, setDaten] = useState<ThemenDaten | null>(null);
  // neu laden, wenn sich die Sitzung ändert (stand = geaendert_am der Sitzung)
  const laden = useCallback(() => api.get<{ vorgeschlagen: Thema[]; weitere: Thema[] }>(`${VS}/sitzungen/${s.id}/themen`).then(setD).catch((e) => setFehler(e.message)), [s.id]);
  useEffect(() => { laden(); }, [laden, stand]);
  const oeffnen = async (x: number | 'neu') => {
    try { setDaten(daten ?? await api.get<ThemenDaten>(`${VS}/themen`)); setDialog(x); } catch (e) { setFehler((e as Error).message); }
  };

  async function zuordnen(ids: number[]) {
    setBusy(true); setFehler(null);
    try {
      const r = await api.post<{ text: string }>(`${VS}/sitzungen/${s.id}/themen`, { ids });
      toast(r.text);
      onGeaendert();
      await laden();
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  if (!d) return null;
  const zeile = (t: Thema, vorschlag: boolean) => (
    <div key={t.id} className={`portal-vs__parkthema${vorschlag ? ' portal-vs__parkthema--vorschlag' : ''}`}>
      <span className="portal-vs__zelle2">
        <Link onClick={() => oeffnen(t.id)}>{t.titel}</Link>
        <span className="portal-muted">
          <ObjectStatus state={PRIO_STATE[t.prioritaet]}>{t.prioritaet_text}</ObjectStatus> · {t.einreicher} · {zeitraum(t.von, t.bis)}
          {t.anlagen.length ? <> · <Icon name="attachment" /> {t.anlagen.length}</> : null}
          {t.ueberfaellig && <> · <ObjectStatus state="Negative">Zeitraum vorbei</ObjectStatus></>}
          {t.sitzung?.id === s.id && ' · hier geparkt'}
        </span>
      </span>
      {rw && <Button design={vorschlag ? 'Emphasized' : 'Transparent'} icon="add" disabled={busy} tooltip="als Tagesordnungspunkt übernehmen" onClick={() => zuordnen([t.id])}>Zuordnen</Button>}
    </div>
  );
  return (
    <Section title="Themenparkplatz" count={d.vorgeschlagen.length + d.weitere.length}
             actions={<Button design="Transparent" icon="add" tooltip="neues Thema parken" onClick={() => oeffnen('neu')}>Thema</Button>}>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)}>{fehler}</MessageStrip>}
      {d.vorgeschlagen.length > 0 && (<>
        <div className="portal-vs__parkkopf">
          <span><Icon name="lightbulb" /> Vorgeschlagen – Sitzung im Zeitraum ({d.vorgeschlagen.length})</span>
          {rw && d.vorgeschlagen.length > 1 && <Link onClick={() => zuordnen(d.vorgeschlagen.map((t) => t.id))}>alle zuordnen</Link>}
        </div>
        {d.vorgeschlagen.map((t) => zeile(t, true))}
      </>)}
      {!d.vorgeschlagen.length && <Empty>Kein geparktes Thema für diesen Termin.</Empty>}
      {d.weitere.length > 0 && (<>
        <Link className="portal-vs__klein" onClick={() => setAlle(!alle)}>{alle ? 'weitere geparkte Themen ausblenden' : `weitere geparkte Themen (${d.weitere.length})`}</Link>
        {alle && d.weitere.map((t) => zeile(t, false))}
      </>)}
      {dialog !== null && daten && <ThemaDialog id={dialog === 'neu' ? null : dialog} daten={daten} onClose={() => setDialog(null)} onGeaendert={() => { laden(); onGeaendert(); }} />}
    </Section>
  );
}

// ---------------------------------------------------------------- Auswahl: Themen aus dem Parkplatz in die Tagesordnung aufnehmen

export function ThemenAuswahlDialog({ sitzungId, onClose, onFertig }: { sitzungId: number; onClose: () => void; onFertig: () => void }) {
  const [d, setD] = useState<{ vorgeschlagen: Thema[]; weitere: Thema[] } | null>(null);
  const [wahl, setWahl] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ vorgeschlagen: Thema[]; weitere: Thema[] }>(`${VS}/sitzungen/${sitzungId}/themen`)
      .then((r) => { setD(r); setWahl(new Set(r.vorgeschlagen.map((t) => t.id))); })
      .catch((e) => setFehler(e.message));
  }, [sitzungId]);
  const umschalten = (id: number, an: boolean) => { const n = new Set(wahl); if (an) n.add(id); else n.delete(id); setWahl(n); };
  async function uebernehmen() {
    setBusy(true); setFehler(null);
    try {
      const r = await api.post<{ text: string }>(`${VS}/sitzungen/${sitzungId}/themen`, { ids: [...wahl] });
      toast(r.text);
      onFertig();
    } catch (e) { setFehler((e as Error).message); setBusy(false); }
  }
  const zeile = (t: Thema) => (
    <div key={t.id} className="portal-vs__parkthema">
      <CheckBox checked={wahl.has(t.id)} accessibleName={t.titel} onChange={(e) => umschalten(t.id, e.target.checked)} />
      <span className="portal-vs__zelle2" style={{ flex: 1 }}>
        <span>{t.titel}</span>
        <span className="portal-muted">
          <ObjectStatus state={PRIO_STATE[t.prioritaet]}>{t.prioritaet_text}</ObjectStatus> · {t.einreicher} · {zeitraum(t.von, t.bis)}
          {t.anlagen.length ? <> · <Icon name="attachment" /> {t.anlagen.length}</> : null}
          {t.ueberfaellig && <> · <ObjectStatus state="Negative">Zeitraum vorbei</ObjectStatus></>}
        </span>
      </span>
    </div>
  );
  return (
    <Dialog open headerText="Themen aus dem Parkplatz aufnehmen" onClose={onClose} style={{ width: 'min(40rem, 96vw)' }}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="add" disabled={!wahl.size || busy} onClick={uebernehmen}>{wahl.size > 1 ? `${wahl.size} Themen aufnehmen` : 'Aufnehmen'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      {!d ? <BusyIndicator active /> : (<>
        {!d.vorgeschlagen.length && !d.weitere.length && <Empty>Im Themenparkplatz liegt kein geparktes Thema.</Empty>}
        {d.vorgeschlagen.length > 0 && <div className="portal-vs__parkkopf"><span><Icon name="lightbulb" /> Vorgeschlagen – Sitzung im Zeitraum</span></div>}
        {d.vorgeschlagen.map(zeile)}
        {d.weitere.length > 0 && <div className="portal-vs__parkkopf" style={{ marginTop: '0.75rem' }}><span>Weitere geparkte Themen</span></div>}
        {d.weitere.map(zeile)}
        <Text className="portal-muted" style={{ display: 'block', marginTop: '0.5rem' }}>Jedes Thema wird ein Tagesordnungspunkt vor „Verschiedenes“ – mit Beschreibung, Einreicher und Anlagen.</Text>
      </>)}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Tagesordnungspunkt in den Parkplatz verschieben

export function TopParkenDialog({ top, onClose, onFertig }: { top: { id: number; titel: string; text: string | null; verantwortlich: string | null }; onClose: () => void; onFertig: () => void }) {
  const [f, setF] = useState<{ prioritaet: 1 | 2 | 3; von: string; bis: string }>(() => {
    const h = new Date(); const bis = new Date(h); bis.setMonth(bis.getMonth() + 3);
    return { prioritaet: 2, von: tagIsoLokal(h), bis: tagIsoLokal(bis) };
  });
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(f.von) && /^\d{4}-\d{2}-\d{2}$/.test(f.bis) && f.bis >= f.von;
  async function parken() {
    setBusy(true); setFehler(null);
    try {
      const r = await api.post<{ text: string }>(`${VS}/tops/${top.id}/parken`, f);
      toast(r.text);
      onFertig();
    } catch (e) { setFehler((e as Error).message); setBusy(false); }
  }
  return (
    <Dialog open headerText="In den Themenparkplatz verschieben" onClose={onClose} style={{ width: 'min(36rem, 96vw)' }}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="bookmark" disabled={!ok || busy} onClick={parken}>Parken</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
        „{top.titel}“ wird ein Thema im Parkplatz{top.verantwortlich ? ` (Einreicher: ${top.verantwortlich})` : ''}{top.text ? ', der Protokolltext wird zur Beschreibung' : ''}; Anlagen werden übernommen.
        Ohne Protokolltext und Einträge verschwindet der Punkt aus der Tagesordnung, sonst bleibt er als „vertagt“ stehen.
      </Text>
      <FormGrid>
        <FieldBox label="Priorität">
          <SegmentedButton accessibleName="Priorität" onSelectionChange={(e) => {
            const p = Number((e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.p) as 1 | 2 | 3;
            if (p) setF({ ...f, prioritaet: p });
          }}>
            {PRIOS.map((x) => <SegmentedButtonItem key={x.p} data-p={x.p} selected={f.prioritaet === x.p}>{x.text}</SegmentedButtonItem>)}
          </SegmentedButton>
        </FieldBox>
        <FieldBox label="Besprechen ab" required>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.von} onChange={(e) => setF({ ...f, von: e.detail.value })} />
        </FieldBox>
        <FieldBox label="spätestens bis" required>
          <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.bis} valueState={f.bis < f.von ? 'Negative' : 'None'} onChange={(e) => setF({ ...f, bis: e.detail.value })} />
        </FieldBox>
      </FormGrid>
    </Dialog>
  );
}
