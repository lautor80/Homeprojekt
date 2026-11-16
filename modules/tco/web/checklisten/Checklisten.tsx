import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar, BusyIndicator, Button, CheckBox, DatePicker, Dialog, Input, MessageStrip, ObjectStatus, Option, Select, SuggestionItem, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { PdfDialog } from '@core/components/PdfDialog';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import './checklisten.css';

/**
 * Checklisten für Veranstaltungen: Kategorien, verantwortliche Person, Schritte mit Terminbezug. Eine Checkliste gilt für
 * eine oder mehrere Veranstaltungen des Vereinskalenders (oder freie Termine) – abgehakt wird je Veranstaltung.
 * Checklisten und einzelne Schritte lassen sich kopieren, jede Checkliste als PDF drucken.
 */
const CL = `${TCO}/checklisten`;

type Stand = 'ERLEDIGT' | 'UEBERFAELLIG' | 'BALD' | 'OFFEN';
interface Kategorie { id: number; name: string; aktiv: boolean; anzahl: number }
interface Schritt { id: number; pos: number; titel: string; beschreibung: string | null; verantwortlich: string | null; tage_vor: number | null; faellig: string | null; termin_text: string }
interface BezugSchritt { schritt_id: number; faellig: string | null; stand: Stand; erledigt: { am: string; von: string | null; notiz: string | null } | null }
interface Fortschritt { gesamt: number; erledigt: number; ueberfaellig: number; bald: number }
interface Bezug { id: number; event_id: number | null; titel: string; termin: string; ort: string | null; abgesagt: boolean; schritte: BezugSchritt[]; fortschritt: Fortschritt }
interface Checkliste {
  id: number; titel: string; beschreibung: string | null; kategorie_id: number | null; kategorie: string | null;
  verantwortlich: string | null; verantwortlich_id: string | null; geaendert_am: string; geaendert_von: string | null;
  schritte: Schritt[]; bezuege: Bezug[];
}
interface Event { id: number; titel: string; termin: string; ort: string | null; abgesagt: boolean }
interface Daten { checklisten: Checkliste[]; kategorien: Kategorie[]; personen: { id: string; name: string }[]; events: Event[]; stand_text: Record<Stand, string>; pflege: boolean }

const STATE: Record<Stand, 'Positive' | 'Negative' | 'Critical' | 'None'> = { ERLEDIGT: 'Positive', UEBERFAELLIG: 'Negative', BALD: 'Critical', OFFEN: 'None' };
const summe = (c: Checkliste): Fortschritt => c.bezuege.reduce((s, b) => ({
  gesamt: s.gesamt + b.fortschritt.gesamt, erledigt: s.erledigt + b.fortschritt.erledigt,
  ueberfaellig: s.ueberfaellig + b.fortschritt.ueberfaellig, bald: s.bald + b.fortschritt.bald,
}), { gesamt: 0, erledigt: 0, ueberfaellig: 0, bald: 0 });
const tagZeit = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function StandAnzeige({ f }: { f: Fortschritt }) {
  if (!f.gesamt) return <span className="portal-muted">–</span>;
  return (
    <span>
      {f.erledigt} von {f.gesamt}
      {f.ueberfaellig > 0 && <ObjectStatus state="Negative" inverted style={{ marginLeft: '0.5rem' }}>{f.ueberfaellig} überfällig</ObjectStatus>}
      {!f.ueberfaellig && f.bald > 0 && <ObjectStatus state="Critical" inverted style={{ marginLeft: '0.5rem' }}>{f.bald} bald fällig</ObjectStatus>}
      {f.erledigt === f.gesamt && <ObjectStatus state="Positive" inverted style={{ marginLeft: '0.5rem' }}>fertig</ObjectStatus>}
    </span>
  );
}

/** Eingabe der verantwortlichen Person: freier Text mit den Benutzern des Portals als Vorschlag */
function PersonFeld({ wert, personen, onChange, placeholder }: { wert: string; personen: Daten['personen']; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Input value={wert} showSuggestions placeholder={placeholder} onInput={(e) => onChange(e.target.value)} onChange={(e) => onChange(e.target.value)}>
      {personen.map((p) => <SuggestionItem key={p.id} text={p.name} />)}
    </Input>
  );
}

type KopfForm = { id?: number; titel: string; beschreibung: string; kategorie_id: number | null; verantwortlich: string };
type SchrittForm = { id?: number; titel: string; beschreibung: string; verantwortlich: string; art: 'OHNE' | 'TAGE' | 'DATUM'; tage: string; danach: boolean; faellig: string };
type BezugForm = { events: number[]; suche: string; termin: string; bezeichnung: string };

export function Checklisten() {
  const [d, setD] = useState<Daten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offen, setOffen] = useState<number | null>(null);
  const [bezugId, setBezugId] = useState<number | null>(null);
  const [filter, setFilter] = useState({ suche: '', kategorie: 0, person: '', nurOffen: false });
  const [markiert, setMarkiert] = useState<number[]>([]);
  const [kopf, setKopf] = useState<KopfForm | null>(null);
  const [schritt, setSchritt] = useState<SchrittForm | null>(null);
  const [bezug, setBezug] = useState<BezugForm | null>(null);
  const [kopie, setKopie] = useState<{ titel: string; bezuege: boolean } | null>(null);
  const [ziel, setZiel] = useState<number | null>(null);
  const [kategorien, setKategorien] = useState<{ neu: string } | null>(null);
  const [pdf, setPdf] = useState<string | null>(null);
  const [frage, setFrage] = useState<{ titel: string; text: string; tun: () => Promise<unknown> } | null>(null);

  const laden = useCallback(() => api.get<Daten>(CL).then(setD).catch((e) => setError(e.message)), []);
  useEffect(() => { laden(); }, [laden]);

  /** Aufruf mit Fehleranzeige; danach neu laden */
  async function tun<T>(fn: () => Promise<T>, danach?: (r: T) => void) {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      const t = (r as { text?: string } | null)?.text;
      if (t) toast(t);
      await laden();
      danach?.(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const c = useMemo(() => d?.checklisten.find((x) => x.id === offen) ?? null, [d, offen]);
  const b = useMemo(() => c?.bezuege.find((x) => x.id === bezugId) ?? c?.bezuege[0] ?? null, [c, bezugId]);
  const pflege = !!d?.pflege;
  const liste = useMemo(() => {
    if (!d) return [];
    const worte = filter.suche.toLowerCase().split(/\s+/).filter(Boolean);
    return d.checklisten.filter((x) => {
      if (filter.kategorie && x.kategorie_id !== filter.kategorie) return false;
      if (filter.person && (x.verantwortlich ?? '') !== filter.person && !x.schritte.some((s) => s.verantwortlich === filter.person)) return false;
      const f = summe(x);
      if (filter.nurOffen && !(f.gesamt > f.erledigt)) return false;
      const text = `${x.titel} ${x.beschreibung ?? ''} ${x.kategorie ?? ''} ${x.verantwortlich ?? ''} ${x.bezuege.map((y) => y.titel).join(' ')} ${x.schritte.map((s) => s.titel).join(' ')}`.toLowerCase();
      return worte.every((w) => text.includes(w));
    });
  }, [d, filter]);
  const verantwortliche = useMemo(() => [...new Set((d?.checklisten ?? []).flatMap((x) => [x.verantwortlich, ...x.schritte.map((s) => s.verantwortlich)]).filter(Boolean) as string[])].sort((a, z) => a.localeCompare(z, 'de')), [d]);

  const oeffnen = (id: number | null) => { setOffen(id); setBezugId(null); setMarkiert([]); setError(null); };

  // ---------------------------------------------------------------- Aktionen
  function kopfSichern() {
    if (!kopf) return;
    const person = d?.personen.find((p) => p.name === kopf.verantwortlich.trim());
    const body = { titel: kopf.titel, beschreibung: kopf.beschreibung, kategorie_id: kopf.kategorie_id, verantwortlich: kopf.verantwortlich, verantwortlich_id: person?.id ?? null };
    tun(() => (kopf.id ? api.put<{ text: string }>(`${CL}/${kopf.id}`, body) : api.post<{ id: number; text: string }>(CL, body)),
      (r) => { setKopf(null); const id = (r as { id?: number }).id; if (id) oeffnen(id); });
  }

  function schrittSichern() {
    if (!schritt || !c) return;
    const tage = Number(schritt.tage);
    if (schritt.art === 'TAGE' && (!Number.isInteger(tage) || tage < 0)) { setError('Bitte die Tage als ganze Zahl angeben.'); return; }
    if (schritt.art === 'DATUM' && !schritt.faellig) { setError('Bitte das Datum angeben.'); return; }
    const body = {
      titel: schritt.titel, beschreibung: schritt.beschreibung, verantwortlich: schritt.verantwortlich,
      tage_vor: schritt.art === 'TAGE' ? (schritt.danach ? -tage : tage) : null, faellig: schritt.art === 'DATUM' ? schritt.faellig : null,
    };
    tun(() => (schritt.id ? api.put(`${CL}/schritte/${schritt.id}`, body) : api.post(`${CL}/${c.id}/schritte`, body)), () => setSchritt(null));
  }

  function verschieben(i: number, um: number) {
    if (!c) return;
    const ids = c.schritte.map((s) => s.id);
    const j = i + um;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    tun(() => api.post(`${CL}/${c.id}/reihenfolge`, { schritte: ids }).then(() => null));
  }

  const schrittForm = (s?: Schritt): SchrittForm => ({
    id: s?.id, titel: s?.titel ?? '', beschreibung: s?.beschreibung ?? '', verantwortlich: s?.verantwortlich ?? '',
    art: s?.faellig ? 'DATUM' : s?.tage_vor != null ? 'TAGE' : 'OHNE', tage: s?.tage_vor != null ? String(Math.abs(s.tage_vor)) : '14', danach: (s?.tage_vor ?? 0) < 0, faellig: s?.faellig ?? '',
  });

  // ---------------------------------------------------------------- Ansichten
  const uebersicht = d && (
    <>
      <div className="portal-cl__leiste">
        <label className="portal-cl__feld"><span>Suchen</span>
          <Input style={{ width: '16rem' }} placeholder="Titel, Schritt, Veranstaltung" value={filter.suche} showClearIcon onInput={(e) => setFilter({ ...filter, suche: e.target.value })} /></label>
        <label className="portal-cl__feld"><span>Kategorie</span>
          <Select style={{ minWidth: '12rem' }} onChange={(e) => setFilter({ ...filter, kategorie: Number((e.detail.selectedOption as HTMLElement).dataset.k ?? 0) })}>
            <Option data-k="0" selected={!filter.kategorie}>Alle</Option>
            {d.kategorien.map((k) => <Option key={k.id} data-k={k.id} selected={filter.kategorie === k.id}>{k.name}</Option>)}
          </Select></label>
        <label className="portal-cl__feld"><span>Verantwortlich</span>
          <Select style={{ minWidth: '12rem' }} onChange={(e) => setFilter({ ...filter, person: (e.detail.selectedOption as HTMLElement).dataset.p ?? '' })}>
            <Option data-p="" selected={!filter.person}>Alle</Option>
            {verantwortliche.map((p) => <Option key={p} data-p={p} selected={filter.person === p}>{p}</Option>)}
          </Select></label>
        <CheckBox text="nur mit offenen Schritten" checked={filter.nurOffen} onChange={(e) => setFilter({ ...filter, nurOffen: e.target.checked })} />
      </div>
      <Section title="Checklisten" count={liste.length} flush>
        {liste.length === 0
          ? <div className="portal-empty" style={{ padding: '0.75rem 1rem' }}>{d.checklisten.length ? 'Keine Checkliste passt zur Auswahl.' : 'Noch keine Checkliste – mit „Neue Checkliste“ beginnen.'}</div>
          : (
            <div className="portal-tabrahmen">
              <table className="portal-cl__tab">
                <thead><tr><th>Checkliste</th><th>Kategorie</th><th>Verantwortlich</th><th>Schritte</th><th>Veranstaltungen</th><th>Stand</th></tr></thead>
                <tbody>
                  {liste.map((x) => {
                    const naechste = x.bezuege.find((y) => y.fortschritt.erledigt < y.fortschritt.gesamt) ?? x.bezuege[0];
                    return (
                      <tr key={x.id} className="klick" onClick={() => oeffnen(x.id)}>
                        <td><span className="portal-cl__titel">{x.titel}</span>{x.beschreibung && <span className="portal-cl__klein">{x.beschreibung.split('\n')[0]}</span>}</td>
                        <td>{x.kategorie ?? '–'}</td>
                        <td>{x.verantwortlich ?? '–'}</td>
                        <td>{x.schritte.length}</td>
                        <td>{x.bezuege.length === 0 ? <span className="portal-muted">Vorlage (ohne Termin)</span>
                          : <>{naechste.titel} · {dat(naechste.termin)}{x.bezuege.length > 1 && <span className="portal-cl__klein">und {x.bezuege.length - 1} weitere</span>}</>}</td>
                        <td><StandAnzeige f={summe(x)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Section>
    </>
  );

  const detail = d && c && (
    <>
      <Section title="Checkliste" actions={pflege && <Button design="Transparent" icon="edit" onClick={() => setKopf({ id: c.id, titel: c.titel, beschreibung: c.beschreibung ?? '', kategorie_id: c.kategorie_id, verantwortlich: c.verantwortlich ?? '' })}>Ändern</Button>}>
        <div className="portal-cl__zwei">
          <div className="portal-cl__feld"><span>Kategorie</span><Text>{c.kategorie ?? '–'}</Text></div>
          <div className="portal-cl__feld"><span>Verantwortlich</span><Text>{c.verantwortlich ?? '–'}</Text></div>
          <div className="portal-cl__feld"><span>Zuletzt geändert</span><Text>{tagZeit(c.geaendert_am)}{c.geaendert_von ? ` · ${c.geaendert_von}` : ''}</Text></div>
        </div>
        {c.beschreibung && <Text style={{ display: 'block', marginTop: '0.75rem', whiteSpace: 'pre-line' }}>{c.beschreibung}</Text>}
      </Section>

      <Section title="Gültig für" count={c.bezuege.length}
               actions={pflege && <Button design="Transparent" icon="add" onClick={() => setBezug({ events: [], suche: '', termin: '', bezeichnung: '' })}>Veranstaltung zuordnen</Button>}>
        {c.bezuege.length === 0
          ? <Text className="portal-muted">Noch keiner Veranstaltung zugeordnet – die Checkliste ist eine Vorlage. Abgehakt wird je Veranstaltung bzw. Termin.</Text>
          : (
            <div className="portal-cl__bezuege">
              {c.bezuege.map((x) => (
                <button key={x.id} type="button" className={`portal-cl__bezug${b?.id === x.id ? ' portal-cl__bezug--aktiv' : ''}`} onClick={() => setBezugId(x.id)}>
                  <b>{x.titel}</b>
                  <span>{dat(x.termin)}{x.event_id ? '' : ' · freier Termin'}{x.abgesagt ? ' · abgesagt' : ''}</span>
                  <span className="portal-cl__klein">{x.fortschritt.erledigt} von {x.fortschritt.gesamt} erledigt{x.fortschritt.ueberfaellig ? ` · ${x.fortschritt.ueberfaellig} überfällig` : ''}</span>
                  <span className="portal-cl__balken"><i style={{ width: `${x.fortschritt.gesamt ? (100 * x.fortschritt.erledigt) / x.fortschritt.gesamt : 0}%` }} /></span>
                </button>
              ))}
            </div>
          )}
      </Section>

      <Section title={b ? `Schritte – ${b.titel}, ${dat(b.termin)}` : 'Schritte'} count={c.schritte.length} flush
               actions={<>
                 {b && pflege && <Button design="Transparent" icon="decline" onClick={() => setFrage({
                   titel: 'Zuordnung entfernen', text: `„${b.titel}“ (${dat(b.termin)}) von dieser Checkliste lösen? Der Stand der Schritte für diese Veranstaltung geht verloren.`,
                   tun: () => api.del(`${CL}/bezuege/${b.id}`),
                 })}>Zuordnung entfernen</Button>}
                 {pflege && markiert.length > 0 && <Button design="Transparent" icon="copy" onClick={() => setZiel(0)}>{markiert.length} kopieren nach …</Button>}
                 {pflege && <Button design="Transparent" icon="add" onClick={() => setSchritt(schrittForm())}>Schritt</Button>}
               </>}>
        {c.schritte.length === 0
          ? <div className="portal-empty" style={{ padding: '0.75rem 1rem' }}>Noch keine Schritte.</div>
          : (
            <div className="portal-tabrahmen">
              <table className="portal-cl__tab">
                <thead>
                  <tr>
                    {pflege && <th className="schmal" title="Zum Kopieren markieren">Kopieren</th>}
                    {b && <th className="schmal">Erledigt</th>}
                    <th>Schritt</th><th>Verantwortlich</th><th>{b ? 'Fällig' : 'Termin'}</th>{b && <th>Stand</th>}{pflege && <th className="schmal" />}
                  </tr>
                </thead>
                <tbody>
                  {c.schritte.map((s, i) => {
                    const z = b?.schritte.find((x) => x.schritt_id === s.id);
                    return (
                      <tr key={s.id} className={z?.erledigt ? 'erledigt' : ''}>
                        {pflege && <td className="schmal mitte"><CheckBox accessibleName={`${s.titel} zum Kopieren markieren`} checked={markiert.includes(s.id)}
                          onChange={(e) => setMarkiert(e.target.checked ? [...markiert, s.id] : markiert.filter((m) => m !== s.id))} /></td>}
                        {b && <td className="schmal mitte"><CheckBox accessibleName={`${s.titel} erledigt`} checked={!!z?.erledigt} disabled={!pflege || busy}
                          onChange={(e) => { const erledigt = e.target.checked; tun(() => api.post(`${CL}/bezuege/${b.id}/schritte/${s.id}`, { erledigt }).then(() => null)); }} /></td>}
                        <td><span className="portal-cl__titel">{i + 1}. {s.titel}</span>{s.beschreibung && <span className="portal-cl__klein">{s.beschreibung}</span>}</td>
                        <td>{s.verantwortlich ?? <span className="portal-muted">{c.verantwortlich ?? '–'}</span>}</td>
                        <td>{b ? (z?.faellig ? dat(z.faellig) : '–') : (s.termin_text || '–')}{b && s.termin_text && !s.faellig && <span className="portal-cl__klein">{s.termin_text}</span>}</td>
                        {b && <td>{z && <ObjectStatus state={STATE[z.stand]} inverted={z.stand !== 'OFFEN'}>{d.stand_text[z.stand]}</ObjectStatus>}
                          {z?.erledigt && <span className="portal-cl__klein">{tagZeit(z.erledigt.am)}{z.erledigt.von ? ` · ${z.erledigt.von}` : ''}</span>}</td>}
                        {pflege && (
                          <td className="schmal">
                            <Button design="Transparent" icon="navigation-up-arrow" tooltip="Nach oben" accessibleName={`${s.titel} nach oben`} disabled={i === 0 || busy} onClick={() => verschieben(i, -1)} />
                            <Button design="Transparent" icon="navigation-down-arrow" tooltip="Nach unten" accessibleName={`${s.titel} nach unten`} disabled={i === c.schritte.length - 1 || busy} onClick={() => verschieben(i, 1)} />
                            <Button design="Transparent" icon="edit" tooltip="Ändern" accessibleName={`${s.titel} ändern`} onClick={() => setSchritt(schrittForm(s))} />
                            <Button design="Transparent" icon="delete" tooltip="Löschen" accessibleName={`${s.titel} löschen`} onClick={() => setFrage({
                              titel: 'Schritt löschen', text: `Schritt „${s.titel}“ löschen? Er entfällt für alle zugeordneten Veranstaltungen.`, tun: () => api.del(`${CL}/schritte/${s.id}`),
                            })} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Section>
    </>
  );

  const pdfUrl = (alle: boolean) => (c ? `${CL}/${c.id}/pdf${!alle && b ? `?bezug=${b.id}` : ''}` : null);
  const eventsFrei = useMemo(() => {
    if (!d || !c || !bezug) return [];
    const schon = new Set(c.bezuege.map((x) => x.event_id));
    const worte = bezug.suche.toLowerCase().split(/\s+/).filter(Boolean);
    return d.events.filter((e) => !schon.has(e.id) && worte.every((w) => `${e.titel} ${e.ort ?? ''} ${dat(e.termin)}`.toLowerCase().includes(w)));
  }, [d, c, bezug]);

  return (
    <AppPage title={c ? c.titel : 'Checklisten'}
             subtitle={c ? `${c.kategorie ?? 'ohne Kategorie'} · ${c.schritte.length} Schritte · ${c.bezuege.length ? `${c.bezuege.length} Veranstaltung${c.bezuege.length === 1 ? '' : 'en'}` : 'Vorlage'}` : 'Veranstaltungen vorbereiten: Schritte, Verantwortliche und Termine'}
             actions={c ? <>
               <Button icon="nav-back" onClick={() => oeffnen(null)}>Übersicht</Button>
               <Button icon="pdf-attachment" onClick={() => setPdf(pdfUrl(false))}>PDF</Button>
               {c.bezuege.length > 1 && <Button icon="pdf-attachment" design="Transparent" onClick={() => setPdf(pdfUrl(true))}>PDF alle Veranstaltungen</Button>}
               {pflege && <Button icon="copy" onClick={() => setKopie({ titel: `${c.titel} (Kopie)`, bezuege: false })}>Kopieren</Button>}
               {pflege && <Button icon="delete" design="Transparent" onClick={() => setFrage({
                 titel: 'Checkliste löschen', text: `Checkliste „${c.titel}“ mit allen Schritten und dem Stand je Veranstaltung löschen?`,
                 tun: () => api.del(`${CL}/${c.id}`).then((r) => { oeffnen(null); return r; }),
               })}>Löschen</Button>}
             </> : <>
               {pflege && <Button design="Emphasized" icon="add" onClick={() => setKopf({ titel: '', beschreibung: '', kategorie_id: null, verantwortlich: '' })}>Neue Checkliste</Button>}
               {pflege && <Button icon="tags" onClick={() => setKategorien({ neu: '' })}>Kategorien</Button>}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      <BusyIndicator active={!d} delay={300} style={{ display: 'block', width: '100%' }}>
        <div className="portal-busy-inhalt">{c ? detail : uebersicht}</div>
      </BusyIndicator>

      {/* ---------- Checkliste anlegen / ändern */}
      <Dialog open={!!kopf} headerText={kopf?.id ? 'Checkliste ändern' : 'Neue Checkliste'} onClose={() => setKopf(null)}
              footer={<Bar endContent={<><Button design="Emphasized" disabled={busy || !kopf?.titel.trim()} onClick={kopfSichern}>Sichern</Button><Button onClick={() => setKopf(null)}>Abbrechen</Button></>} />}>
        {kopf && d && (
          <div className="portal-cl__dialog">
            <label className="portal-cl__feld"><span>Titel</span><Input value={kopf.titel} maxlength={160} onInput={(e) => setKopf({ ...kopf, titel: e.target.value })} /></label>
            <div className="portal-cl__zwei">
              <label className="portal-cl__feld"><span>Kategorie</span>
                <Select onChange={(e) => setKopf({ ...kopf, kategorie_id: Number((e.detail.selectedOption as HTMLElement).dataset.k) || null })}>
                  <Option data-k="" selected={!kopf.kategorie_id}>ohne</Option>
                  {d.kategorien.filter((k) => k.aktiv || k.id === kopf.kategorie_id).map((k) => <Option key={k.id} data-k={k.id} selected={kopf.kategorie_id === k.id}>{k.name}</Option>)}
                </Select></label>
              <label className="portal-cl__feld"><span>Verantwortlich</span>
                <PersonFeld wert={kopf.verantwortlich} personen={d.personen} onChange={(v) => setKopf({ ...kopf, verantwortlich: v })} placeholder="Name – Benutzer werden vorgeschlagen" /></label>
            </div>
            <label className="portal-cl__feld"><span>Beschreibung</span><TextArea rows={4} value={kopf.beschreibung} onInput={(e) => setKopf({ ...kopf, beschreibung: e.target.value })} /></label>
          </div>
        )}
      </Dialog>

      {/* ---------- Schritt */}
      <Dialog open={!!schritt} headerText={schritt?.id ? 'Schritt ändern' : 'Neuer Schritt'} onClose={() => setSchritt(null)}
              footer={<Bar endContent={<><Button design="Emphasized" disabled={busy || !schritt?.titel.trim()} onClick={schrittSichern}>Sichern</Button><Button onClick={() => setSchritt(null)}>Abbrechen</Button></>} />}>
        {schritt && d && (
          <div className="portal-cl__dialog">
            <label className="portal-cl__feld"><span>Schritt</span><Input value={schritt.titel} maxlength={200} onInput={(e) => setSchritt({ ...schritt, titel: e.target.value })} /></label>
            <label className="portal-cl__feld"><span>Hinweise</span><TextArea rows={3} value={schritt.beschreibung} onInput={(e) => setSchritt({ ...schritt, beschreibung: e.target.value })} /></label>
            <label className="portal-cl__feld"><span>Verantwortlich (leer = wie die Checkliste)</span>
              <PersonFeld wert={schritt.verantwortlich} personen={d.personen} onChange={(v) => setSchritt({ ...schritt, verantwortlich: v })} /></label>
            <div className="portal-cl__zwei">
              <label className="portal-cl__feld"><span>Termin</span>
                <Select onChange={(e) => setSchritt({ ...schritt, art: ((e.detail.selectedOption as HTMLElement).dataset.a ?? 'OHNE') as SchrittForm['art'] })}>
                  <Option data-a="OHNE" selected={schritt.art === 'OHNE'}>ohne Termin</Option>
                  <Option data-a="TAGE" selected={schritt.art === 'TAGE'}>bezogen auf die Veranstaltung</Option>
                  <Option data-a="DATUM" selected={schritt.art === 'DATUM'}>festes Datum</Option>
                </Select></label>
              {schritt.art === 'TAGE' && (
                <label className="portal-cl__feld"><span>Tage</span>
                  <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
                    <Input type="Number" style={{ width: '6rem' }} value={schritt.tage} onInput={(e) => setSchritt({ ...schritt, tage: e.target.value })} />
                    <Select style={{ minWidth: '8rem' }} onChange={(e) => setSchritt({ ...schritt, danach: (e.detail.selectedOption as HTMLElement).dataset.d === '1' })}>
                      <Option data-d="0" selected={!schritt.danach}>vorher</Option>
                      <Option data-d="1" selected={schritt.danach}>danach</Option>
                    </Select>
                  </div></label>
              )}
              {schritt.art === 'DATUM' && (
                <label className="portal-cl__feld"><span>Fällig am</span>
                  <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={schritt.faellig} onChange={(e) => setSchritt({ ...schritt, faellig: e.detail.value })} /></label>
              )}
            </div>
            {schritt.art === 'TAGE' && <Text className="portal-muted">Die Fälligkeit ergibt sich je Veranstaltung aus ihrem Datum (0 Tage = am Tag selbst).</Text>}
          </div>
        )}
      </Dialog>

      {/* ---------- Veranstaltung / Termin zuordnen */}
      <Dialog open={!!bezug} headerText="Veranstaltung zuordnen" onClose={() => setBezug(null)}
              footer={<Bar endContent={<>
                <Button design="Emphasized" disabled={busy || !bezug || (!bezug.events.length && !bezug.termin)}
                        onClick={() => bezug && c && tun(() => api.post<{ text: string }>(`${CL}/${c.id}/bezuege`, { events: bezug.events, termin: bezug.termin || null, bezeichnung: bezug.bezeichnung }), () => setBezug(null))}>Zuordnen</Button>
                <Button onClick={() => setBezug(null)}>Abbrechen</Button>
              </>} />}>
        {bezug && (
          <div className="portal-cl__dialog">
            <Text>Die Checkliste gilt für jede gewählte Veranstaltung – mit eigenem Stand je Veranstaltung.</Text>
            <Input placeholder="Veranstaltung suchen" value={bezug.suche} showClearIcon onInput={(e) => setBezug({ ...bezug, suche: e.target.value })} />
            {eventsFrei.length === 0
              ? <Text className="portal-muted">Keine (weitere) Veranstaltung im Vereinskalender gefunden.</Text>
              : (
                <div className="portal-tabrahmen" style={{ maxHeight: '40vh' }}>
                  <table className="portal-cl__tab">
                    <thead><tr><th className="schmal" /><th>Veranstaltung</th><th>Datum</th><th>Ort</th></tr></thead>
                    <tbody>
                      {eventsFrei.map((e) => (
                        <tr key={e.id}>
                          <td className="schmal mitte"><CheckBox accessibleName={`${e.titel} wählen`} checked={bezug.events.includes(e.id)}
                            onChange={(ev) => setBezug({ ...bezug, events: ev.target.checked ? [...bezug.events, e.id] : bezug.events.filter((x) => x !== e.id) })} /></td>
                          <td>{e.titel}{e.abgesagt && <ObjectStatus state="Negative"> abgesagt</ObjectStatus>}</td><td>{dat(e.termin)}</td><td>{e.ort ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            <Text className="portal-muted">Oder ein freier Termin, der nicht im Vereinskalender steht:</Text>
            <div className="portal-cl__zwei">
              <label className="portal-cl__feld"><span>Datum</span>
                <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={bezug.termin} onChange={(e) => setBezug({ ...bezug, termin: e.detail.value })} /></label>
              <label className="portal-cl__feld"><span>Bezeichnung</span><Input value={bezug.bezeichnung} maxlength={160} onInput={(e) => setBezug({ ...bezug, bezeichnung: e.target.value })} /></label>
            </div>
          </div>
        )}
      </Dialog>

      {/* ---------- Checkliste kopieren */}
      <Dialog open={!!kopie} headerText="Checkliste kopieren" onClose={() => setKopie(null)}
              footer={<Bar endContent={<>
                <Button design="Emphasized" disabled={busy || !kopie?.titel.trim()}
                        onClick={() => kopie && c && tun(() => api.post<{ id: number; text: string }>(`${CL}/${c.id}/kopieren`, kopie), (r) => { setKopie(null); oeffnen(r.id); })}>Kopieren</Button>
                <Button onClick={() => setKopie(null)}>Abbrechen</Button>
              </>} />}>
        {kopie && (
          <div className="portal-cl__dialog">
            <label className="portal-cl__feld"><span>Titel der Kopie</span><Input value={kopie.titel} maxlength={160} onInput={(e) => setKopie({ ...kopie, titel: e.target.value })} /></label>
            <CheckBox text="Veranstaltungen und Termine mitnehmen (Stand beginnt neu)" checked={kopie.bezuege} onChange={(e) => setKopie({ ...kopie, bezuege: e.target.checked })} />
            <Text className="portal-muted">Kopiert werden Kategorie, Verantwortliche und alle Schritte – nie der Stand (abgehakt).</Text>
          </div>
        )}
      </Dialog>

      {/* ---------- Schritte in eine andere Checkliste kopieren */}
      <Dialog open={ziel !== null} headerText={`${markiert.length} Schritt${markiert.length === 1 ? '' : 'e'} kopieren nach …`} onClose={() => setZiel(null)}
              footer={<Bar endContent={<>
                <Button design="Emphasized" disabled={busy || !ziel}
                        onClick={() => ziel && tun(() => api.post<{ text: string }>(`${CL}/schritte/kopieren`, { schritte: markiert, ziel }), () => { setZiel(null); setMarkiert([]); })}>Kopieren</Button>
                <Button onClick={() => setZiel(null)}>Abbrechen</Button>
              </>} />}>
        {ziel !== null && d && (
          <div className="portal-cl__dialog">
            <label className="portal-cl__feld"><span>Ziel-Checkliste</span>
              <Select onChange={(e) => setZiel(Number((e.detail.selectedOption as HTMLElement).dataset.c ?? 0))}>
                <Option data-c="0" selected={!ziel}>bitte wählen</Option>
                {d.checklisten.map((x) => <Option key={x.id} data-c={x.id} selected={ziel === x.id}>{x.titel}{x.id === c?.id ? ' (diese)' : ''}{x.kategorie ? ` · ${x.kategorie}` : ''}</Option>)}
              </Select></label>
            <Text className="portal-muted">Die Schritte werden ans Ende der gewählten Checkliste angefügt – mit Hinweisen, Verantwortlichen und Terminbezug, ohne Stand.</Text>
          </div>
        )}
      </Dialog>

      {/* ---------- Kategorien */}
      <Dialog open={!!kategorien} headerText="Kategorien" onClose={() => setKategorien(null)} footer={<Bar endContent={<Button onClick={() => setKategorien(null)}>Schließen</Button>} />}>
        {kategorien && d && (
          <div className="portal-cl__dialog">
            {d.kategorien.length > 0 && (
              <div className="portal-tabrahmen" style={{ maxHeight: '45vh' }}>
                <table className="portal-cl__tab">
                  <thead><tr><th>Kategorie</th><th>Checklisten</th><th>Aktiv</th><th className="schmal" /></tr></thead>
                  <tbody>
                    {d.kategorien.map((k) => (
                      <tr key={k.id}>
                        <td className="mitte"><Input key={`${k.id}:${k.name}`} value={k.name} maxlength={80} accessibleName={`Name ${k.name}`}
                          onChange={(e) => { const name = e.target.value.trim(); if (name && name !== k.name) tun(() => api.post<{ text: string }>(`${CL}/kategorien`, { id: k.id, name, aktiv: k.aktiv })); }} /></td>
                        <td className="mitte">{k.anzahl}</td>
                        <td className="mitte"><CheckBox accessibleName={`${k.name} aktiv`} checked={k.aktiv} onChange={(e) => { const aktiv = e.target.checked; tun(() => api.post<{ text: string }>(`${CL}/kategorien`, { id: k.id, name: k.name, aktiv })); }} /></td>
                        <td className="schmal"><Button design="Transparent" icon="delete" tooltip={k.anzahl ? 'Wird verwendet – abschalten statt löschen' : 'Löschen'} accessibleName={`${k.name} löschen`} disabled={k.anzahl > 0 || busy}
                          onClick={() => tun(() => api.del<{ text: string }>(`${CL}/kategorien/${k.id}`))} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
              <Input style={{ flex: 1 }} placeholder="Neue Kategorie, z. B. Turnier, Vereinsfest, Arbeitseinsatz" value={kategorien.neu} maxlength={80} onInput={(e) => setKategorien({ neu: e.target.value })} />
              <Button icon="add" disabled={busy || !kategorien.neu.trim()} onClick={() => tun(() => api.post<{ text: string }>(`${CL}/kategorien`, { name: kategorien.neu }), () => setKategorien({ neu: '' }))}>Anlegen</Button>
            </div>
            <Text className="portal-muted">Abgeschaltete Kategorien bleiben an ihren Checklisten stehen, sind aber für neue nicht mehr wählbar.</Text>
          </div>
        )}
      </Dialog>

      <ConfirmDialog open={!!frage} title={frage?.titel ?? ''} text={frage?.text ?? ''} confirmText="Ja" danger
                     onConfirm={() => { const f = frage; setFrage(null); if (f) tun(f.tun); }} onCancel={() => setFrage(null)} />
      <PdfDialog url={pdf} title={c ? `Checkliste ${c.titel}` : 'Checkliste'} filename={`Checkliste ${c?.titel ?? ''}.pdf`} onClose={() => setPdf(null)} />
    </AppPage>
  );
}
