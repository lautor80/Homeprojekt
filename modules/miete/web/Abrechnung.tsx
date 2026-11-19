import { useState } from 'react';
import { Button, Link, MessageStrip, ObjectStatus } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat, eur, JahrAuswahl, M, SCHLUESSEL, summe, Tabelle, type Einheit, type Schluessel } from './util';

interface Position { kostenart_id: number; bezeichnung: string; umlagefaehig: boolean; schluessel: Schluessel; gesamt: number; einheiten: Record<number, number>; hinweise: string[] }
interface APos { kostenart_id: number; bezeichnung: string; schluessel: Schluessel; gesamt: number; anteil: number; basis: string; p35a: boolean }
interface Fest { id: number; kosten: number; vorauszahlungen: number; ergebnis: number; erstellt_von: string; erstellt_am: string; versendet_am: string | null; paperless_id: number | null }
interface Abr {
  vertrag_id: number; nummer: string; name: string; einheit: string; von: string; bis: string; tage: number; positionen: APos[];
  kosten: number; vorauszahlungen: number; sollNk: number; ergebnis: number; p35a: number; neuerAbschlag: number; festgeschrieben: Fest | null;
}
interface Daten { jahr: number; frist: string; einheiten: Einheit[]; verteilung: { positionen: Position[]; hinweise: string[] }; abrechnungen: Abr[]; vermieter: number }

const EDIT = 'miete.abrechnung:edit';
const schluesselText = (s: Schluessel) => SCHLUESSEL.find((x) => x.key === s)?.text ?? s;
const ergebnisStatus = (v: number) => <ObjectStatus state={v > 0.005 ? 'Critical' : v < -0.005 ? 'Positive' : 'None'}>{v > 0.005 ? `Nachzahlung ${eur(v)}` : v < -0.005 ? `Guthaben ${eur(-v)}` : 'ausgeglichen'}</ObjectStatus>;

/**
 * Nebenkostenabrechnung je Kalenderjahr: Verteilung aller Kosten auf die Wohnungen, je Mietverhältnis die Abrechnung
 * gegen die geleisteten Abschläge. Festschreiben speichert den Stand; danach PDF und Ablage in Paperless.
 */
export function Abrechnung() {
  const can = useCan();
  const [jahr, setJahr] = useState(new Date().getFullYear() - 1);
  const d = useLoad(() => api.get<Daten>(`${M}/abrechnung?jahr=${jahr}`), [jahr]);
  const [oeffnen, setOeffnen] = useState<Abr | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const x = d.data;
  const abgeschlossen = `${jahr}-12-31` < new Date().toISOString().slice(0, 10);

  async function aktion(a: Abr, f: () => Promise<unknown>) {
    setBusy(a.vertrag_id);
    try { await f(); d.reload(); } catch (e) { toast((e as Error).message, 5000); } finally { setBusy(null); }
  }
  const festschreiben = (a: Abr) => aktion(a, async () => { await api.post(`${M}/abrechnung/festschreiben`, { jahr, vertrag_id: a.vertrag_id }); toast('Abrechnung festgeschrieben'); });
  const paperless = (a: Abr) => aktion(a, async () => { const r = await api.post<{ text: string; warnungen: string[] }>(`${M}/abrechnungen/${a.festgeschrieben!.id}/paperless`); toast([r.text, ...r.warnungen].join(' '), 5000); });
  const versendet = (a: Abr) => aktion(a, async () => { await api.post(`${M}/abrechnungen/${a.festgeschrieben!.id}/versendet`, { datum: new Date().toISOString().slice(0, 10) }); toast('Als versendet vermerkt'); });
  async function wiederOeffnen(reason: string) {
    const a = oeffnen!;
    setOeffnen(null);
    await aktion(a, async () => { await api.del(`${M}/abrechnungen/${a.festgeschrieben!.id}`, { reason }); toast('Abrechnung wieder geöffnet'); });
  }

  const einheiten = x?.einheiten ?? [];
  return (
    <AppPage title="Nebenkostenabrechnung" subtitle={x ? `Abrechnungszeitraum 01.01.${jahr} – 31.12.${jahr} · Frist ${dat(x.frist)}` : undefined}
      header={<Filters>
        <Filter label="Jahr"><JahrAuswahl jahr={jahr} onChange={setJahr} /></Filter>
        <HeaderKpi label="Kosten umlagefähig" value={eur((x?.verteilung.positionen ?? []).filter((p) => p.umlagefaehig).reduce((s, p) => s + p.gesamt, 0))} />
        <HeaderKpi label="Auf Mieter umgelegt" value={eur((x?.abrechnungen ?? []).reduce((s, a) => s + a.kosten, 0))} />
        <HeaderKpi label="Vermieteranteil" value={eur(x?.vermieter ?? 0)} />
      </Filters>}>
      {d.error && <MessageStrip design="Negative" hideCloseButton>{d.error}</MessageStrip>}
      {!abgeschlossen && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>Das Jahr {jahr} ist noch nicht abgeschlossen – Vorschau. Festschreiben geht erst ab dem 01.01.{jahr + 1}.</MessageStrip>}
      {(x?.verteilung.hinweise ?? []).map((h) => <MessageStrip key={h} design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>{h}</MessageStrip>)}

      <Section title="Verteilung auf die Wohnungen" flush>
        <Tabelle<Position> schluessel={(p) => p.kostenart_id} zeilen={x?.verteilung.positionen ?? []} leer="Keine Kosten in diesem Jahr" spalten={[
          { titel: 'Kostenart', wert: (p) => <>{p.bezeichnung}{!p.umlagefaehig && <div className="portal-muted" style={{ fontSize: '0.75rem' }}>nicht umlagefähig</div>}</>, summe: () => 'Summe' },
          { titel: 'Schlüssel', wert: (p) => schluesselText(p.schluessel) },
          { titel: 'Gesamt', rechts: true, wert: (p) => eur(p.gesamt), summe: summe((p) => p.gesamt) },
          ...einheiten.map((e) => ({ titel: `${e.kuerzel}${e.eigennutzung ? ' (eigen)' : ''}`, rechts: true, wert: (p: Position) => eur(p.einheiten[e.id] ?? 0), summe: summe((p: Position) => p.einheiten[e.id] ?? 0) })),
        ]} />
      </Section>

      {(x?.abrechnungen ?? []).map((a) => {
        const f = a.festgeschrieben;
        return (
          <Section key={a.vertrag_id} title={`${a.name} – ${a.einheit}`} status={<>{ergebnisStatus(f?.ergebnis ?? a.ergebnis)}
            {f ? <ObjectStatus state="Positive">festgeschrieben {dat(f.erstellt_am)}</ObjectStatus> : <ObjectStatus state="Information">Entwurf</ObjectStatus>}
            {f?.versendet_am && <ObjectStatus state="Positive">versendet {dat(f.versendet_am)}</ObjectStatus>}</>}
            actions={<>
              <ChangeHistoryButton objectType="NKABRECHNUNG" objectKey={`${jahr}/${a.vertrag_id}`} />
              {can(EDIT) && !f && <Button design="Emphasized" icon="locked" disabled={!abgeschlossen} loading={busy === a.vertrag_id} onClick={() => festschreiben(a)}>Festschreiben</Button>}
              {f && <Button icon="pdf-attachment" onClick={() => window.open(`${M}/abrechnungen/${f.id}/pdf`, '_blank')}>PDF</Button>}
              {f && can(EDIT) && !f.paperless_id && <Button icon="upload-to-cloud" loading={busy === a.vertrag_id} onClick={() => paperless(a)}>In Paperless ablegen</Button>}
              {f?.paperless_id && <Link onClick={() => window.open(`${M}/paperless/${f.paperless_id}/datei`, '_blank')}>Paperless {f.paperless_id}</Link>}
              {f && can(EDIT) && !f.versendet_am && <Button icon="paper-plane" onClick={() => versendet(a)}>Versendet</Button>}
              {f && can(EDIT) && <Button design="Transparent" icon="unlocked" onClick={() => setOeffnen(a)}>Wieder öffnen</Button>}
            </>} flush>
            <div className="portal-muted" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>
              {a.nummer} · Nutzungszeitraum {dat(a.von)} – {dat(a.bis)} ({a.tage} Tage){f && f.kosten !== a.kosten ? ` · Achtung: Neu berechnet ergäbe sich ${eur(a.kosten)} statt ${eur(f.kosten)} – Daten wurden nach dem Festschreiben geändert.` : ''}
            </div>
            <Tabelle<APos> schluessel={(p) => p.kostenart_id} zeilen={a.positionen} leer="Keine umlagefähigen Kosten" spalten={[
              { titel: 'Kostenart', wert: (p) => `${p.bezeichnung}${p.p35a ? ' *' : ''}`, summe: () => 'Kosten des Mieters' },
              { titel: 'Verteilerschlüssel / Anteil', wert: (p) => <>{schluesselText(p.schluessel)}<div className="portal-muted" style={{ fontSize: '0.75rem' }}>{p.basis}</div></> },
              { titel: 'Gesamtkosten', rechts: true, wert: (p) => eur(p.gesamt) },
              { titel: 'Anteil Mieter', rechts: true, wert: (p) => eur(p.anteil), summe: summe((p) => p.anteil) },
            ]} />
            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', padding: '0.5rem 0.75rem', justifyContent: 'flex-end' }}>
              <span>Vorauszahlungen geleistet: <b>{eur(a.vorauszahlungen)}</b> <span className="portal-muted">(Soll {eur(a.sollNk)})</span></span>
              <span>Ergebnis: <b>{ergebnisStatus(a.ergebnis)}</b></span>
              {a.p35a > 0 && <span>* davon § 35a EStG: {eur(a.p35a)}</span>}
              <span>Vorschlag neuer Abschlag: <b>{eur(a.neuerAbschlag)}</b> / Monat</span>
            </div>
          </Section>
        );
      })}
      <ConfirmDialog open={!!oeffnen} askReason title="Abrechnung wieder öffnen" confirmText="Wieder öffnen"
        text="Der festgeschriebene Stand wird verworfen und die Abrechnung neu berechnet. Ein bereits in Paperless abgelegtes PDF bleibt dort erhalten."
        onConfirm={wiederOeffnen} onCancel={() => setOeffnen(null)} />
    </AppPage>
  );
}
