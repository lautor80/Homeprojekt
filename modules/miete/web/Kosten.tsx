import { useState } from 'react';
import { Bar, Button, Dialog, Input, Icon, Link, MessageStrip, ObjectStatus } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { jahrAufMonat, jahrAufZeitraum, monate, monatZeitraum, type JahreswertModus } from './jahreswert';
import { AuswahlFeld, dat, DatumFeld, eur, heute, JahrAuswahl, M, summe, Tabelle, zahl, zahlText, ZahlFeld, type Einheit, type Kostenart } from './util';

interface Kosten {
  id: number; kostenart_id: number; kostenart: string; umlagefaehig: boolean; datum: string; von: string | null; bis: string | null; betrag: number;
  lieferant: string | null; belegnr: string | null; einheit_id: number | null; paperless_id: number | null; notiz: string | null;
}
interface PlDok { id: number; titel: string; datum: string; korrespondent: string; dateiname: string }

const EDIT = 'miete.kosten:edit';
const oeffnen = (id: number) => window.open(`${M}/paperless/${id}/datei`, '_blank');

/** Laufende Kosten des Hauses mit Leistungszeitraum und Beleg in Paperless */
export function LaufendeKosten() {
  const can = useCan();
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const liste = useLoad(() => api.get<Kosten[]>(`${M}/kosten?jahr=${jahr}`), [jahr]);
  const arten = useLoad(() => api.get<Kostenart[]>(`${M}/kostenarten`), []);
  const einheiten = useLoad(() => api.get<Einheit[]>(`${M}/einheiten`), []);
  const pl = useLoad(() => api.get<{ eingerichtet: boolean; tag: string }>(`${M}/paperless/status`), []);
  const [dialog, setDialog] = useState<Partial<Kosten> | null>(null);
  const [loeschen, setLoeschen] = useState<Kosten | null>(null);
  const [eingang, setEingang] = useState(false);
  const k = liste.data ?? [];

  async function entfernen(reason: string) {
    const x = loeschen!;
    setLoeschen(null);
    try { await api.del(`${M}/kosten/${x.id}`, { reason }); toast('Kostenposition gelöscht'); liste.reload(); } catch (e) { toast((e as Error).message); }
  }

  return (
    <AppPage title="Laufende Kosten" subtitle={`${k.length} Positionen ${jahr}`}
      actions={<>
        {can(EDIT) && <Button icon="add" design="Emphasized" onClick={() => setDialog({ datum: heute() })}>Kosten erfassen</Button>}
        {can(EDIT) && pl.data?.eingerichtet && <Button icon="inbox" onClick={() => setEingang(true)}>Aus Paperless übernehmen</Button>}
      </>}
      header={<Filters>
        <Filter label="Jahr"><JahrAuswahl jahr={jahr} onChange={setJahr} /></Filter>
        <HeaderKpi label="Umlagefähig" value={eur(k.filter((x) => x.umlagefaehig).reduce((s, x) => s + x.betrag, 0))} />
        <HeaderKpi label="Nicht umlagefähig" value={eur(k.filter((x) => !x.umlagefaehig).reduce((s, x) => s + x.betrag, 0))} />
        <HeaderKpi label="Ohne Beleg" value={String(k.filter((x) => !x.paperless_id).length)} state={k.some((x) => !x.paperless_id) ? 'Critical' : 'None'} />
      </Filters>}>
      {liste.error && <MessageStrip design="Negative" hideCloseButton>{liste.error}</MessageStrip>}
      {pl.data && !pl.data.eingerichtet && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Paperless ist für die Vermietung noch nicht eingerichtet: Administration → Schnittstellen → Paperless → „Paperless-ngx Vermietung“.
      </MessageStrip>}
      <Section title="Kosten" count={k.length} flush>
        <Tabelle<Kosten> schluessel={(x) => x.id} zeilen={k} leer="Noch keine Kosten in diesem Jahr" onZeile={can(EDIT) ? (x) => setDialog(x) : undefined} spalten={[
          { titel: 'Datum', fest: true, wert: (x) => dat(x.datum), summe: () => 'Summe' },
          { titel: 'Kostenart', wert: (x) => <>{x.kostenart}{!x.umlagefaehig && <div className="portal-muted" style={{ fontSize: '0.75rem' }}>nicht umlagefähig</div>}</> },
          { titel: 'Leistungszeitraum', fest: true, wert: (x) => (x.von ? `${dat(x.von)} – ${dat(x.bis)}` : '') },
          { titel: 'Lieferant', wert: (x) => x.lieferant ?? '' },
          { titel: 'Betrag', rechts: true, wert: (x) => eur(x.betrag), summe: summe((x) => x.betrag) },
          { titel: 'Beleg', wert: (x) => (x.paperless_id
            ? <Link onClick={(e) => { e.stopPropagation(); oeffnen(x.paperless_id!); }}>Paperless {x.paperless_id}</Link>
            : <ObjectStatus state="Critical">fehlt</ObjectStatus>) },
          ...(can(EDIT) ? [{ titel: '', wert: (x: Kosten) => <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={(e) => { e.stopPropagation(); setLoeschen(x); }} /> }] : []),
        ]} />
      </Section>
      {dialog && <KostenDialog k={dialog} arten={(arten.data ?? []).filter((a) => a.aktiv || a.id === dialog.kostenart_id)} einheiten={einheiten.data ?? []}
        paperless={!!pl.data?.eingerichtet} onClose={(neu) => { setDialog(null); if (neu) liste.reload(); }} />}
      {eingang && <EingangDialog onClose={() => setEingang(false)} onUebernehmen={(d) => { setEingang(false); setDialog({ datum: d.datum || heute(), lieferant: d.korrespondent || null, paperless_id: d.id, notiz: d.titel }); }} />}
      <ConfirmDialog open={!!loeschen} danger askReason title="Kostenposition löschen" confirmText="Löschen"
        text={loeschen ? `${loeschen.kostenart} vom ${dat(loeschen.datum)} über ${eur(loeschen.betrag)} löschen? Der Beleg in Paperless bleibt erhalten.` : ''}
        onConfirm={entfernen} onCancel={() => setLoeschen(null)} />
    </AppPage>
  );
}

function KostenDialog({ k, arten, einheiten, paperless, onClose }: { k: Partial<Kosten>; arten: Kostenart[]; einheiten: Einheit[]; paperless: boolean; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState({
    kostenart_id: k.kostenart_id ?? null as number | null, datum: k.datum ?? heute(), von: k.von ?? '', bis: k.bis ?? '', betrag: zahlText(k.betrag),
    lieferant: k.lieferant ?? '', belegnr: k.belegnr ?? '', einheit_id: k.einheit_id ?? null as number | null, paperless_id: k.paperless_id ?? null as number | null, notiz: k.notiz ?? '',
  });
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suche, setSuche] = useState(false);
  const [datei, setDatei] = useState<File | null>(null);
  const art = arten.find((a) => a.id === f.kostenart_id);
  // Hilfe: Betrag aus einem Jahreswert (wird nicht gespeichert)
  const [jw, setJw] = useState('');
  const [modus, setModus] = useState<JahreswertModus>('zeitraum');
  type Form = typeof f;
  /** Betrag (und beim Monat den Leistungszeitraum) aus dem Jahreswert neu rechnen */
  const rechne = (nf: Form, j = jw, m = modus, zeitraumSetzen = false): Form => {
    const wert = zahl(j);
    if (!wert) return nf;
    if (m === 'monat') {
      const z = zeitraumSetzen || !nf.von || !nf.bis ? monatZeitraum(nf.von || nf.datum || heute()) : { von: nf.von, bis: nf.bis };
      return { ...nf, ...z, betrag: zahlText(jahrAufMonat(wert)) };
    }
    const b = jahrAufZeitraum(wert, nf.von, nf.bis);
    return b === null ? nf : { ...nf, betrag: zahlText(b) };
  };
  const n = monate(f.von, f.bis);

  async function sichern() {
    setBusy(true); setFehler(null);
    try {
      const body = { ...f, betrag: zahl(f.betrag), von: f.von || null, bis: f.bis || null };
      const id = k.id ?? (await api.post<{ id: number }>(`${M}/kosten`, body)).id;
      if (k.id) await api.put(`${M}/kosten/${k.id}`, body);
      if (datei) {
        const inhalt = await new Promise<string>((ok, err) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => err(r.error); r.readAsDataURL(datei); });
        const r = await api.post<{ text: string; warnungen: string[] }>(`${M}/kosten/${id}/beleg`, { datei: datei.name, inhalt });
        toast([r.text, ...r.warnungen].join(' '), 5000);
      } else toast('Kosten gesichert');
      onClose(true);
    } catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  }

  /** Jahresbetrag: Leistungszeitraum auf das Kalenderjahr des Belegs setzen */
  const ganzesJahr = () => { const j = (f.datum || heute()).slice(0, 4); setF(rechne({ ...f, von: `${j}-01-01`, bis: `${j}-12-31` })); };

  return (
    <Dialog open headerText={k.id ? 'Kosten ändern' : 'Kosten erfassen'} style={{ width: 'min(44rem, 95vw)' }} onClose={() => onClose(false)}
      footer={<Bar endContent={<>
        <Button design="Emphasized" loading={busy} disabled={!f.kostenart_id || !f.datum} onClick={sichern}>Sichern</Button>
        <Button onClick={() => onClose(false)}>Abbrechen</Button>
      </>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <FormGrid>
        <AuswahlFeld label="Kostenart" required value={f.kostenart_id} leer="" onChange={(v) => setF({ ...f, kostenart_id: v })}
          optionen={arten.map((a) => ({ key: a.id, text: `${a.bezeichnung}${a.umlagefaehig ? '' : ' (nicht umlagefähig)'}` }))} />
        <ZahlFeld label="Betrag" required value={f.betrag} onChange={(v) => setF({ ...f, betrag: v })} />
        <DatumFeld label="Beleg-/Zahlungsdatum" required value={f.datum} onChange={(v) => setF({ ...f, datum: v })} />
        <TextField label="Lieferant / Behörde" value={f.lieferant} onChange={(v) => setF({ ...f, lieferant: v })} />
        <DatumFeld label="Leistungszeitraum von" value={f.von} onChange={(v) => setF(rechne({ ...f, von: v }))} />
        <DatumFeld label="Leistungszeitraum bis" value={f.bis} onChange={(v) => setF(rechne({ ...f, bis: v }))} />
        {art?.schluessel === 'direkt' && <AuswahlFeld label="Wohnung" value={f.einheit_id} leer="(nach Wohnfläche)" onChange={(v) => setF({ ...f, einheit_id: v })}
          optionen={einheiten.map((e) => ({ key: e.id, text: `${e.kuerzel} – ${e.bezeichnung}` }))} />}
        <TextField label="Belegnummer" value={f.belegnr} onChange={(v) => setF({ ...f, belegnr: v })} />
        <TextField label="Notiz" wide value={f.notiz} onChange={(v) => setF({ ...f, notiz: v })} />
      </FormGrid>
      <div style={{ marginTop: '0.5rem' }}><Button design="Transparent" icon="calendar" onClick={ganzesJahr}>Ganzes Kalenderjahr</Button>
        <span className="portal-muted" style={{ fontSize: '0.8rem' }}> Mit Leistungszeitraum wird der Betrag tageweise auf die Monate verteilt (z. B. Jahresbescheid Grundsteuer).</span></div>

      <h4 style={{ margin: '1rem 0 0.5rem' }}>Betrag aus Jahreswert</h4>
      <FormGrid>
        <ZahlFeld label="Jahreswert" value={jw} onChange={(v) => { setJw(v); setF(rechne(f, v)); }} />
        <AuswahlFeld<JahreswertModus> label="Umrechnen auf" value={modus} onChange={(v) => { const m = v ?? 'zeitraum'; setModus(m); setF(rechne(f, jw, m, true)); }}
          optionen={[{ key: 'zeitraum', text: 'Leistungszeitraum (je Monat 1/12)' }, { key: 'monat', text: 'einen Monat (1/12, Zeitraum = Monat)' }]} />
      </FormGrid>
      {zahl(jw) > 0 && <p className="portal-muted" style={{ fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
        {modus === 'monat' ? `${zahlText(zahl(jw))} € ÷ 12 = ${zahlText(jahrAufMonat(zahl(jw)))} € für den Monat ${f.von ? dat(f.von).slice(3) : ''}.`
          : n === null ? 'Leistungszeitraum von–bis angeben, dann wird der Betrag errechnet.'
          : `${zahlText(zahl(jw))} € ÷ 12 × ${zahlText(Math.round(n * 100) / 100)} Monate = ${zahlText(jahrAufZeitraum(zahl(jw), f.von, f.bis))} € (angebrochene Monate tageweise).`}
        {' '}Der Jahreswert selbst wird nicht gespeichert – gesichert wird der Betrag.</p>}

      <h4 style={{ margin: '1rem 0 0.5rem' }}>Beleg in Paperless</h4>
      {!paperless && <MessageStrip design="Information" hideCloseButton>Paperless ist für die Vermietung noch nicht eingerichtet.</MessageStrip>}
      {paperless && <FormGrid>
        <FieldBox label="Verknüpftes Dokument">
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {f.paperless_id ? <Link onClick={() => oeffnen(f.paperless_id!)}>Dokument {f.paperless_id}</Link> : <span className="portal-muted">keins</span>}
            <Button icon="search" onClick={() => setSuche(true)}>Suchen</Button>
            {f.paperless_id && <Button design="Transparent" icon="decline" tooltip="Verknüpfung lösen" onClick={() => setF({ ...f, paperless_id: null })} />}
          </div>
        </FieldBox>
        <FieldBox label="Oder Datei hochladen (beim Sichern)">
          <input type="file" accept="application/pdf,image/*" onChange={(e) => setDatei(e.target.files?.[0] ?? null)} />
        </FieldBox>
      </FormGrid>}
      {k.id && <div style={{ marginTop: '0.75rem' }}><ChangeHistoryButton objectType="MIETKOSTEN" objectKey={String(k.id)} /></div>}
      {suche && <SucheDialog onClose={() => setSuche(false)} onWahl={(d) => { setSuche(false); setF({ ...f, paperless_id: d.id, lieferant: f.lieferant || d.korrespondent, datum: k.id ? f.datum : (d.datum || f.datum) }); }} />}
    </Dialog>
  );
}

function DokListe({ docs, onWahl, knopf }: { docs: PlDok[]; onWahl: (d: PlDok) => void; knopf: string }) {
  return (
    <Tabelle<PlDok> schluessel={(d) => d.id} zeilen={docs} leer="Keine Dokumente gefunden" spalten={[
      { titel: 'Nr.', wert: (d) => <Link onClick={() => oeffnen(d.id)}>{d.id}</Link> },
      { titel: 'Datum', wert: (d) => dat(d.datum) },
      { titel: 'Titel', wert: (d) => d.titel },
      { titel: 'Korrespondent', wert: (d) => d.korrespondent },
      { titel: '', wert: (d) => <Button design="Transparent" onClick={() => onWahl(d)}>{knopf}</Button> },
    ]} />
  );
}

/** Dokument in Paperless suchen (Titel/Inhalt oder Nummer) */
function SucheDialog({ onClose, onWahl }: { onClose: () => void; onWahl: (d: PlDok) => void }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const docs = useLoad(() => api.get<PlDok[]>(`${M}/paperless/suche?q=${encodeURIComponent(q)}`), [q]);
  return (
    <Dialog open headerText="Dokument in Paperless suchen" style={{ width: 'min(48rem, 95vw)' }} onClose={onClose}
      footer={<Bar endContent={<Button onClick={onClose}>Abbrechen</Button>} />}>
      <Input placeholder="Titel, Inhalt oder Dokumentnummer" value={text} showClearIcon icon={<Icon name="search" />} style={{ width: '100%', marginBottom: '0.75rem' }}
        onInput={(e) => setText(e.target.value)} onChange={() => setQ(text)} />
      {docs.error && <MessageStrip design="Negative" hideCloseButton>{docs.error}</MessageStrip>}
      <DokListe docs={docs.data ?? []} onWahl={onWahl} knopf="Verknüpfen" />
    </Dialog>
  );
}

/** Belege mit dem Schlagwort des Hauses, die noch keiner Kostenposition zugeordnet sind */
function EingangDialog({ onClose, onUebernehmen }: { onClose: () => void; onUebernehmen: (d: PlDok) => void }) {
  const d = useLoad(() => api.get<{ tag: string; dokumente: PlDok[]; hinweis?: string }>(`${M}/paperless/eingang`), []);
  return (
    <Dialog open headerText="Neue Belege aus Paperless" style={{ width: 'min(48rem, 95vw)' }} onClose={onClose}
      footer={<Bar endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      {d.error && <MessageStrip design="Negative" hideCloseButton>{d.error}</MessageStrip>}
      {d.data && <p className="portal-muted" style={{ marginTop: 0 }}>
        {d.data.tag ? `Dokumente mit dem Schlagwort „${d.data.tag}“, die noch nicht zugeordnet sind. Das Schlagwort steht unter Haus und Mieter → Haus.` : 'Unter Haus und Mieter → Haus ist kein Paperless-Schlagwort eingetragen.'}
      </p>}
      {d.data?.hinweis && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>{d.data.hinweis}</MessageStrip>}
      <DokListe docs={d.data?.dokumente ?? []} onWahl={onUebernehmen} knopf="Übernehmen" />
    </Dialog>
  );
}
