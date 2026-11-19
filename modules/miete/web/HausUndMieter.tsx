import { useEffect, useState } from 'react';
import { Bar, Button, Dialog, MessageStrip, ObjectStatus, Tab, TabContainer } from '@ui5/webcomponents-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { CheckField, FormGrid, TextField } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import {
  aktuell, AuswahlFeld, dat, DatumFeld, eur, heute, GEMEINSAM, M, SCHLUESSEL, Tabelle, zahl, zahlText, ZahlFeld,
  type Einheit, type Kostenart, type Vertrag, type Zaehler,
} from './util';

const EDIT = 'miete.stammdaten:edit';

/** Haus, Wohnungen, Mietverhältnisse (mit Kaltmiete und Abschlag ab Stichtag) und Kostenarten mit Verteilerschlüssel */
export function HausUndMieter() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'mieter';
  return (
    <AppPage title="Haus und Mieter">
      <TabContainer onTabSelect={(e) => setParams({ tab: (e.detail.tab as HTMLElement).dataset.key ?? 'mieter' }, { replace: true })}>
        <Tab text="Mietverhältnisse" data-key="mieter" selected={tab === 'mieter'}><Mietverhaeltnisse /></Tab>
        <Tab text="Wohnungen" data-key="wohnungen" selected={tab === 'wohnungen'}><Wohnungen /></Tab>
        <Tab text="Kostenarten" data-key="kostenarten" selected={tab === 'kostenarten'}><Kostenarten /></Tab>
        <Tab text="Haus" data-key="haus" selected={tab === 'haus'}><Haus /></Tab>
      </TabContainer>
    </AppPage>
  );
}

// ------------------------------------------------------------------ Mietverhältnisse
function Mietverhaeltnisse() {
  const can = useCan();
  const vs = useLoad(() => api.get<Vertrag[]>(`${M}/vertraege`), []);
  const es = useLoad(() => api.get<Einheit[]>(`${M}/einheiten`), []);
  const [dialog, setDialog] = useState<Partial<Vertrag> | null>(null);
  const [kondition, setKondition] = useState<Vertrag | null>(null);
  return (
    <Section title="Mietverhältnisse" count={vs.data?.length} flush
      actions={can(EDIT) && <Button icon="add" design="Emphasized" disabled={!es.data?.length} onClick={() => setDialog({ beginn: heute(), personen: 1 })}>Mietverhältnis anlegen</Button>}>
      {vs.error && <MessageStrip design="Negative" hideCloseButton>{vs.error}</MessageStrip>}
      {es.data && !es.data.length && <MessageStrip design="Information" hideCloseButton>Zuerst unter „Wohnungen“ die Wohnungen des Hauses anlegen.</MessageStrip>}
      <Tabelle<Vertrag> schluessel={(v) => v.id} zeilen={vs.data ?? []} leer="Noch keine Mietverhältnisse" onZeile={can(EDIT) ? (v) => setDialog(v) : undefined} spalten={[
        { titel: 'Nr.', wert: (v) => v.nummer },
        { titel: 'Mieter', wert: (v) => v.name },
        { titel: 'Wohnung', wert: (v) => v.einheit },
        { titel: 'Zeitraum', wert: (v) => `${dat(v.beginn)} – ${v.ende ? dat(v.ende) : 'unbefristet'}` },
        { titel: 'Personen', rechts: true, wert: (v) => zahlText(v.personen) },
        { titel: 'Kaltmiete', rechts: true, wert: (v) => eur(aktuell(v)?.kaltmiete) },
        { titel: 'NK-Abschlag', rechts: true, wert: (v) => eur(aktuell(v)?.nk_abschlag) },
        { titel: 'Status', wert: (v) => (v.ende && v.ende < heute() ? <ObjectStatus>beendet</ObjectStatus> : v.beginn > heute() ? <ObjectStatus state="Information">künftig</ObjectStatus> : <ObjectStatus state="Positive">aktiv</ObjectStatus>) },
        { titel: '', wert: (v) => <Button design="Transparent" icon="lead" onClick={(e) => { e.stopPropagation(); setKondition(v); }}>Miete/Abschlag</Button> },
      ]} />
      {dialog && <VertragDialog v={dialog} einheiten={es.data ?? []} onClose={(neu) => { setDialog(null); if (neu) vs.reload(); }} />}
      {kondition && <KonditionenDialog v={(vs.data ?? []).find((x) => x.id === kondition.id) ?? kondition} edit={can(EDIT)} onClose={() => setKondition(null)} onGeaendert={vs.reload} />}
    </Section>
  );
}

function VertragDialog({ v, einheiten, onClose }: { v: Partial<Vertrag>; einheiten: Einheit[]; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState({
    einheit_id: v.einheit_id ?? einheiten.find((e) => !e.eigennutzung)?.id ?? null as number | null, name: v.name ?? '', email: v.email ?? '', telefon: v.telefon ?? '',
    anschrift: v.anschrift ?? '', beginn: v.beginn ?? heute(), ende: v.ende ?? '', personen: zahlText(v.personen ?? 1), notiz: v.notiz ?? '', kaltmiete: '', nk: '',
  });
  const [fehler, setFehler] = useState<string | null>(null);
  const [loeschen, setLoeschen] = useState(false);
  async function sichern() {
    try {
      const body = { einheit_id: f.einheit_id, name: f.name, email: f.email, telefon: f.telefon, anschrift: f.anschrift, beginn: f.beginn, ende: f.ende || null, personen: zahl(f.personen), notiz: f.notiz };
      if (v.id) await api.put(`${M}/vertraege/${v.id}`, body);
      else await api.post(`${M}/vertraege`, { ...body, kondition: { kaltmiete: zahl(f.kaltmiete), nk_abschlag: zahl(f.nk) } });
      toast('Mietverhältnis gesichert'); onClose(true);
    } catch (e) { setFehler((e as Error).message); }
  }
  async function entfernen(reason: string) {
    setLoeschen(false);
    try { await api.del(`${M}/vertraege/${v.id}`, { reason }); toast('Mietverhältnis gelöscht'); onClose(true); } catch (e) { setFehler((e as Error).message); }
  }
  return (
    <Dialog open headerText={v.id ? `Mietverhältnis ${v.nummer}` : 'Mietverhältnis anlegen'} style={{ width: 'min(44rem, 95vw)' }} onClose={() => onClose(false)}
      footer={<Bar startContent={v.id ? <Button design="Transparent" icon="delete" onClick={() => setLoeschen(true)}>Löschen</Button> : undefined}
        endContent={<><Button design="Emphasized" disabled={!f.name.trim() || !f.einheit_id || !f.beginn} onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <FormGrid>
        <TextField label="Mieter (Name)" required value={f.name} onChange={(x) => setF({ ...f, name: x })} />
        <AuswahlFeld label="Wohnung" required value={f.einheit_id} onChange={(x) => setF({ ...f, einheit_id: x })}
          optionen={einheiten.map((e) => ({ key: e.id, text: `${e.kuerzel} – ${e.bezeichnung}${e.eigennutzung ? ' (Eigennutzung)' : ''}` }))} />
        <DatumFeld label="Mietbeginn" required value={f.beginn} onChange={(x) => setF({ ...f, beginn: x })} />
        <DatumFeld label="Mietende (leer = unbefristet)" value={f.ende} onChange={(x) => setF({ ...f, ende: x })} />
        <ZahlFeld label="Personen" einheit="" value={f.personen} onChange={(x) => setF({ ...f, personen: x })} />
        <TextField label="E-Mail" type="Email" value={f.email} onChange={(x) => setF({ ...f, email: x })} />
        <TextField label="Telefon" type="Tel" value={f.telefon} onChange={(x) => setF({ ...f, telefon: x })} />
        {!v.id && <ZahlFeld label="Kaltmiete monatlich" required value={f.kaltmiete} onChange={(x) => setF({ ...f, kaltmiete: x })} />}
        {!v.id && <ZahlFeld label="Nebenkosten-Abschlag monatlich" required value={f.nk} onChange={(x) => setF({ ...f, nk: x })} />}
        <TextField label="Postanschrift (falls abweichend, z. B. nach Auszug)" wide multiline value={f.anschrift} onChange={(x) => setF({ ...f, anschrift: x })} />
        <TextField label="Notiz" wide value={f.notiz} onChange={(x) => setF({ ...f, notiz: x })} />
      </FormGrid>
      {v.id && <div style={{ marginTop: '0.75rem' }}><ChangeHistoryButton objectType="MIETVERTRAG" objectKey={String(v.id)} /></div>}
      <ConfirmDialog open={loeschen} danger askReason title="Mietverhältnis löschen" confirmText="Löschen"
        text="Nur möglich, solange es keine Mieteingänge und Abrechnungen gibt – sonst ein Mietende eintragen." onConfirm={entfernen} onCancel={() => setLoeschen(false)} />
    </Dialog>
  );
}

/** Miethöhe ab Stichtag: Mieterhöhung oder neuer Abschlag nach der Abrechnung */
function KonditionenDialog({ v, edit, onClose, onGeaendert }: { v: Vertrag; edit: boolean; onClose: () => void; onGeaendert: () => void }) {
  const a = aktuell(v);
  const [f, setF] = useState({ gueltig_ab: `${heute().slice(0, 7)}-01`, kaltmiete: zahlText(a?.kaltmiete), nk: zahlText(a?.nk_abschlag) });
  const [fehler, setFehler] = useState<string | null>(null);
  async function hinzu() {
    try { await api.post(`${M}/vertraege/${v.id}/konditionen`, { gueltig_ab: f.gueltig_ab, kaltmiete: zahl(f.kaltmiete), nk_abschlag: zahl(f.nk) }); toast('Gesichert'); onGeaendert(); } catch (e) { setFehler((e as Error).message); }
  }
  async function weg(id: number) {
    try { await api.del(`${M}/konditionen/${id}`); onGeaendert(); } catch (e) { setFehler((e as Error).message); }
  }
  return (
    <Dialog open headerText={`Miete und Abschlag – ${v.name}`} style={{ width: 'min(40rem, 95vw)' }} onClose={onClose}
      footer={<Bar endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <Tabelle schluessel={(k) => k.id} zeilen={[...v.konditionen].reverse()} spalten={[
        { titel: 'Gültig ab', wert: (k) => dat(k.gueltig_ab) },
        { titel: 'Kaltmiete', rechts: true, wert: (k) => eur(k.kaltmiete) },
        { titel: 'NK-Abschlag', rechts: true, wert: (k) => eur(k.nk_abschlag) },
        { titel: 'Gesamt', rechts: true, wert: (k) => eur(k.kaltmiete + k.nk_abschlag) },
        ...(edit ? [{ titel: '', wert: (k: Vertrag['konditionen'][number]) => <Button design="Transparent" icon="delete" tooltip="Löschen" disabled={v.konditionen.length <= 1} onClick={() => weg(k.id)} /> }] : []),
      ]} />
      {edit && <>
        <h4 style={{ margin: '1rem 0 0.5rem' }}>Neue Miethöhe ab Stichtag</h4>
        <FormGrid>
          <DatumFeld label="Gültig ab" required value={f.gueltig_ab} onChange={(x) => setF({ ...f, gueltig_ab: x })} />
          <ZahlFeld label="Kaltmiete" value={f.kaltmiete} onChange={(x) => setF({ ...f, kaltmiete: x })} />
          <ZahlFeld label="NK-Abschlag" value={f.nk} onChange={(x) => setF({ ...f, nk: x })} />
        </FormGrid>
        <Button style={{ marginTop: '0.5rem' }} icon="add" onClick={hinzu}>Übernehmen</Button>
      </>}
    </Dialog>
  );
}

// ------------------------------------------------------------------ Wohnungen
function Wohnungen() {
  const can = useCan();
  const es = useLoad(() => api.get<Einheit[]>(`${M}/einheiten`), []);
  const [dialog, setDialog] = useState<Partial<Einheit> | null>(null);
  const summeFl = (es.data ?? []).reduce((s, e) => s + e.flaeche, 0);
  return (
    <Section title="Wohnungen" count={es.data?.length} flush
      actions={can(EDIT) && <Button icon="add" design="Emphasized" onClick={() => setDialog({ flaeche: 0, personen: 0, eigennutzung: false, sort: ((es.data?.length ?? 0) + 1) * 10 })}>Wohnung anlegen</Button>}>
      {es.error && <MessageStrip design="Negative" hideCloseButton>{es.error}</MessageStrip>}
      <Tabelle<Einheit> schluessel={(e) => e.id} zeilen={es.data ?? []} leer="Noch keine Wohnungen – z. B. „EG“ und „OG“" onZeile={can(EDIT) ? (e) => setDialog(e) : undefined} spalten={[
        { titel: 'Kürzel', wert: (e) => e.kuerzel, summe: () => 'Summe' },
        { titel: 'Bezeichnung', wert: (e) => e.bezeichnung },
        { titel: 'Wohnfläche', rechts: true, wert: (e) => `${zahlText(e.flaeche)} m²`, summe: () => `${zahlText(summeFl)} m²` },
        { titel: 'Anteil', rechts: true, wert: (e) => (summeFl ? `${(e.flaeche / summeFl * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` : '') },
        { titel: 'Nutzung', wert: (e) => (e.eigennutzung ? <ObjectStatus state="Information">Eigennutzung ({zahlText(e.personen)} Pers.)</ObjectStatus> : <ObjectStatus>vermietet</ObjectStatus>) },
      ]} />
      {dialog && <EinheitDialog e={dialog} onClose={(neu) => { setDialog(null); if (neu) es.reload(); }} />}
    </Section>
  );
}

function EinheitDialog({ e, onClose }: { e: Partial<Einheit>; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState({ kuerzel: e.kuerzel ?? '', bezeichnung: e.bezeichnung ?? '', flaeche: zahlText(e.flaeche ?? 0), personen: zahlText(e.personen ?? 0), eigennutzung: e.eigennutzung ?? false, sort: e.sort ?? 0 });
  const [fehler, setFehler] = useState<string | null>(null);
  async function sichern() {
    try {
      const body = { ...f, flaeche: zahl(f.flaeche), personen: zahl(f.personen) };
      if (e.id) await api.put(`${M}/einheiten/${e.id}`, body); else await api.post(`${M}/einheiten`, body);
      toast('Wohnung gesichert'); onClose(true);
    } catch (x) { setFehler((x as Error).message); }
  }
  return (
    <Dialog open headerText={e.id ? `Wohnung ${e.kuerzel}` : 'Wohnung anlegen'} style={{ width: 'min(36rem, 95vw)' }} onClose={() => onClose(false)}
      footer={<Bar endContent={<><Button design="Emphasized" disabled={!f.kuerzel.trim() || !f.bezeichnung.trim()} onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <FormGrid>
        <TextField label="Kürzel" required value={f.kuerzel} onChange={(x) => setF({ ...f, kuerzel: x })} placeholder="EG" />
        <TextField label="Bezeichnung" required value={f.bezeichnung} onChange={(x) => setF({ ...f, bezeichnung: x })} placeholder="Erdgeschoss" />
        <ZahlFeld label="Wohnfläche" einheit="m²" value={f.flaeche} onChange={(x) => setF({ ...f, flaeche: x })} />
        <CheckField label="Eigennutzung (Vermieter wohnt selbst darin)" checked={f.eigennutzung} onChange={(x) => setF({ ...f, eigennutzung: x })} />
        {f.eigennutzung && <ZahlFeld label="Personen (für Schlüssel „Personen“)" einheit="" value={f.personen} onChange={(x) => setF({ ...f, personen: x })} />}
      </FormGrid>
      {e.id && <div style={{ marginTop: '0.75rem' }}><ChangeHistoryButton objectType="MIETEINHEIT" objectKey={e.kuerzel!} /></div>}
    </Dialog>
  );
}

// ------------------------------------------------------------------ Kostenarten
function Kostenarten() {
  const can = useCan();
  const ks = useLoad(() => api.get<Kostenart[]>(`${M}/kostenarten`), []);
  const es = useLoad(() => api.get<Einheit[]>(`${M}/einheiten`), []);
  const zs = useLoad(() => api.get<Zaehler[]>(`${M}/zaehler`), []);
  const [dialog, setDialog] = useState<Partial<Kostenart> | null>(null);
  const zaehler = (id: number | null) => zs.data?.find((z) => z.id === id)?.bezeichnung;
  return (
    <Section title="Kostenarten" count={ks.data?.length} flush
      actions={can(EDIT) && <Button icon="add" design="Emphasized" onClick={() => setDialog({ umlagefaehig: true, schluessel: 'flaeche', grundanteil: 0, anteile: {}, p35a: false, aktiv: true, sort: 300 })}>Kostenart anlegen</Button>}>
      {ks.error && <MessageStrip design="Negative" hideCloseButton>{ks.error}</MessageStrip>}
      <Tabelle<Kostenart> schluessel={(k) => k.id} zeilen={ks.data ?? []} onZeile={can(EDIT) ? (k) => setDialog(k) : undefined} spalten={[
        { titel: 'Kostenart', wert: (k) => k.bezeichnung },
        { titel: 'Umlage', wert: (k) => (k.umlagefaehig ? <ObjectStatus state="Positive">umlagefähig</ObjectStatus> : <ObjectStatus>nicht umlagefähig</ObjectStatus>) },
        { titel: 'Verteilerschlüssel', wert: (k) => <>{SCHLUESSEL.find((s) => s.key === k.schluessel)?.text}
          {k.schluessel === 'verbrauch' && <div className="portal-muted" style={{ fontSize: '0.75rem' }}>{zaehler(k.zaehler_id) ?? 'Hauptzähler fehlt'}{k.grundanteil ? `, ${k.grundanteil} % Grundkosten` : ''}{k.rest_einheit_id ? `, Rest an ${(es.data ?? []).find((e) => e.id === k.rest_einheit_id)?.kuerzel ?? '?'}` : ''}, Gemeinschaft {GEMEINSAM.find((g) => g.key === (k.gemeinsam_schluessel ?? 'flaeche'))?.text}</div>}
          {k.schluessel === 'anteil' && <div className="portal-muted" style={{ fontSize: '0.75rem' }}>{(es.data ?? []).map((e) => `${e.kuerzel} ${k.anteile[e.id] ?? 0} %`).join(', ')}</div>}</> },
        { titel: '§ 35a', wert: (k) => (k.p35a ? 'ja' : '') },
        { titel: 'Status', wert: (k) => (k.aktiv ? '' : <ObjectStatus state="Critical">inaktiv</ObjectStatus>) },
      ]} />
      {dialog && <KostenartDialog k={dialog} einheiten={es.data ?? []} zaehler={(zs.data ?? []).filter((z) => !z.haupt_id)} onClose={(neu) => { setDialog(null); if (neu) ks.reload(); }} />}
    </Section>
  );
}

function KostenartDialog({ k, einheiten, zaehler, onClose }: { k: Partial<Kostenart>; einheiten: Einheit[]; zaehler: Zaehler[]; onClose: (neu: boolean) => void }) {
  const [f, setF] = useState({
    bezeichnung: k.bezeichnung ?? '', umlagefaehig: k.umlagefaehig ?? true, schluessel: k.schluessel ?? 'flaeche', zaehler_id: k.zaehler_id ?? null as number | null,
    grundanteil: zahlText(k.grundanteil ?? 0), rest_einheit_id: k.rest_einheit_id ?? null as number | null, gemeinsam_schluessel: k.gemeinsam_schluessel ?? 'flaeche', anteile: Object.fromEntries(einheiten.map((e) => [e.id, zahlText(k.anteile?.[e.id] ?? 0)])) as Record<number, string>,
    p35a: k.p35a ?? false, sort: k.sort ?? 0, aktiv: k.aktiv ?? true,
  });
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => setFehler(null), [f.schluessel]);
  async function sichern() {
    try {
      const body = { ...f, grundanteil: zahl(f.grundanteil), anteile: Object.fromEntries(Object.entries(f.anteile).map(([id, p]) => [id, zahl(p)])) };
      if (k.id) await api.put(`${M}/kostenarten/${k.id}`, body); else await api.post(`${M}/kostenarten`, body);
      toast('Kostenart gesichert'); onClose(true);
    } catch (x) { setFehler((x as Error).message); }
  }
  const summeAnteile = Object.values(f.anteile).reduce((s, p) => s + zahl(p), 0);
  return (
    <Dialog open headerText={k.id ? `Kostenart ${k.bezeichnung}` : 'Kostenart anlegen'} style={{ width: 'min(40rem, 95vw)' }} onClose={() => onClose(false)}
      footer={<Bar endContent={<><Button design="Emphasized" disabled={!f.bezeichnung.trim()} onClick={sichern}>Sichern</Button><Button onClick={() => onClose(false)}>Abbrechen</Button></>} />}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <FormGrid>
        <TextField label="Bezeichnung" required value={f.bezeichnung} onChange={(x) => setF({ ...f, bezeichnung: x })} />
        <AuswahlFeld label="Verteilerschlüssel" value={f.schluessel} optionen={SCHLUESSEL} onChange={(x) => setF({ ...f, schluessel: x ?? 'flaeche' })} />
        <CheckField label="Umlagefähig (Betriebskosten nach BetrKV)" checked={f.umlagefaehig} onChange={(x) => setF({ ...f, umlagefaehig: x })} />
        <CheckField label="Haushaltsnahe Dienstleistung (§ 35a EStG) ausweisen" checked={f.p35a} onChange={(x) => setF({ ...f, p35a: x })} />
        {f.schluessel === 'verbrauch' && <AuswahlFeld label="Hauptzähler" required value={f.zaehler_id} leer="" onChange={(x) => setF({ ...f, zaehler_id: x })}
          optionen={zaehler.map((z) => ({ key: z.id, text: z.bezeichnung }))} />}
        {f.schluessel === 'verbrauch' && <ZahlFeld label="Grundkosten nach Wohnfläche" einheit="%" value={f.grundanteil} onChange={(x) => setF({ ...f, grundanteil: x })} />}
        {f.schluessel === 'verbrauch' && <AuswahlFeld label="Hauptzähler minus Unterzähler gehört" value={f.rest_einheit_id} leer="allen (gemeinsamer Verbrauch)"
          onChange={(x) => setF({ ...f, rest_einheit_id: x })} optionen={einheiten.map((e) => ({ key: e.id, text: `${e.kuerzel} (Differenzmessung)` }))} />}
        {f.schluessel === 'verbrauch' && <AuswahlFeld label="Gemeinsamen Verbrauch teilen" value={f.gemeinsam_schluessel} optionen={GEMEINSAM}
          onChange={(x) => setF({ ...f, gemeinsam_schluessel: x ?? 'flaeche' })} />}
        {f.schluessel === 'anteil' && einheiten.map((e) => <ZahlFeld key={e.id} label={`Anteil ${e.kuerzel}`} einheit="%" value={f.anteile[e.id] ?? '0'} onChange={(x) => setF({ ...f, anteile: { ...f.anteile, [e.id]: x } })} />)}
        <CheckField label="Aktiv (bei neuen Kosten wählbar)" checked={f.aktiv} onChange={(x) => setF({ ...f, aktiv: x })} />
      </FormGrid>
      {f.schluessel === 'verbrauch' && <MessageStrip design="Information" hideCloseButton style={{ marginTop: '0.75rem' }}>
        Verteilt nach dem Verbrauch der Unterzähler je Wohnung. Gemeinsamer Verbrauch – Gemeinschaftszähler (Zähler ohne Wohnung, z. B. Waschküche, Keller, Heizungsstrom;
        liegt er hinter dem Zähler einer Wohnung, wird er dort abgezogen) und was der Hauptzähler mehr anzeigt – wird nach Fläche, Personen oder zu gleichen Teilen geteilt.
        Bei einer Differenzmessung (nur eine Wohnung hat einen Unterzähler) gehört der Rest des Hauptzählers der anderen Wohnung.
        Grundkosten (z. B. 30 % bei Heizkosten) werden vorab nach Wohnfläche verteilt.
      </MessageStrip>}
      {f.schluessel === 'anteil' && Math.abs(summeAnteile - 100) > 0.01 && <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.75rem' }}>Die Anteile ergeben {zahlText(summeAnteile)} % statt 100 %.</MessageStrip>}
      {k.id && <div style={{ marginTop: '0.75rem' }}><ChangeHistoryButton objectType="KOSTENART" objectKey={k.bezeichnung!} /></div>}
    </Dialog>
  );
}

// ------------------------------------------------------------------ Haus
interface Objekt { bezeichnung: string; strasse: string | null; plz: string | null; ort: string | null; vermieter: string | null; vermieter_anschrift: string | null; iban: string | null; paperless_tag: string }
function Haus() {
  const can = useCan();
  const o = useLoad(() => api.get<Objekt>(`${M}/objekt`), []);
  const [f, setF] = useState<Objekt | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { if (o.data) setF(o.data); }, [o.data]);
  if (!f) return null;
  const ro = !can(EDIT);
  const set = (k: keyof Objekt) => (v: string) => setF({ ...f, [k]: v });
  async function sichern() {
    try { await api.put(`${M}/objekt`, f); toast('Haus gesichert'); o.reload(); } catch (e) { setFehler((e as Error).message); }
  }
  return (
    <Section title="Haus" actions={<>
      <ChangeHistoryButton objectType="MIETOBJEKT" objectKey="1" />
      {!ro && <Button design="Emphasized" onClick={sichern}>Sichern</Button>}
    </>}>
      {fehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      <FormGrid>
        <TextField label="Bezeichnung" required readonly={ro} value={f.bezeichnung} onChange={set('bezeichnung')} />
        <TextField label="Straße" readonly={ro} value={f.strasse} onChange={set('strasse')} />
        <TextField label="PLZ" readonly={ro} value={f.plz} onChange={set('plz')} />
        <TextField label="Ort" readonly={ro} value={f.ort} onChange={set('ort')} />
        <TextField label="Vermieter (Absender der Abrechnung)" readonly={ro} value={f.vermieter} onChange={set('vermieter')} />
        <TextField label="IBAN für Nachzahlungen" readonly={ro} value={f.iban} onChange={set('iban')} />
        <TextField label="Anschrift des Vermieters" wide multiline readonly={ro} value={f.vermieter_anschrift} onChange={set('vermieter_anschrift')} />
        <TextField label="Paperless-Schlagwort für neue Belege" readonly={ro} value={f.paperless_tag} onChange={set('paperless_tag')} placeholder="Nebenkosten" />
      </FormGrid>
      <p className="portal-muted" style={{ fontSize: '0.8rem' }}>
        Belege mit diesem Schlagwort, die noch keiner Kostenposition zugeordnet sind, stehen unter Laufende Kosten → „Aus Paperless übernehmen“.
        Zugang und Ablageregeln: Administration → Schnittstellen → Paperless → „Paperless-ngx Vermietung“.
      </p>
    </Section>
  );
}
