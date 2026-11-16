import { useEffect, useState } from 'react';
import { Button, CheckBox, Dialog, Input, MessageStrip, ObjectStatus, Option, Select, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { DialogFuss } from '@core/components/DialogFuss';
import { Empty, Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { dat } from '../util';
import { euro, HH, MON, zahlLesen, zahlText, type Init, type PlanSicht, type State } from './typen';

/**
 * Reiter „Projekte“ des Haushaltsplans: Projekte planen (Zeitspanne, Kosten, Finanzierung, Folgekosten), beantragen und
 * genehmigen, und in der gewählten Plan-Fassung ein- oder ausrechnen. Die Wirkung steht daneben: Ergebnis und tiefster
 * Geldbestand ohne und mit den gewählten Projekten, je Projekt sein Beitrag.
 */

type ProjektStatus = 'IDEE' | 'BEANTRAGT' | 'GENEHMIGT' | 'ABGELEHNT' | 'ZURUECKGESTELLT' | 'UMSETZUNG' | 'ABGESCHLOSSEN';
type Art = 'KOSTEN' | 'ZUSCHUSS' | 'SPENDE' | 'EIGENMITTEL' | 'DARLEHEN' | 'TILGUNG' | 'FOLGEKOSTEN' | 'EINSPARUNG';
type Verteilung = 'GLEICH' | 'MONAT' | 'HAND' | 'JAEHRLICH';
interface Position { art: Art; art_text?: string; bezeichnung: string | null; betrag: number; konto: string | null; verteilung: Verteilung; von: string | null; bis: string | null; monate: Record<string, number> }
export interface Projekt {
  id: number; projektnr: string | null; bezeichnung: string; beschreibung: string | null; verantwortlich: string | null; beginn: string; ende: string; bereich: string | null;
  status: ProjektStatus; status_text: string; status_am: string | null; status_von: string | null; status_grund: string | null;
  positionen: Position[];
  budget: { kosten: number; finanzierung: number; zuschuss: number; spende: number; eigenmittel: number; darlehen: number; luecke: number; folge_jahr: number };
  ist: { kosten: number; einnahmen: number; buchungen: number };
  bewertung: { state: State; text: string; prozent: number | null } | null;
  verlauf: { am: string; von: string; status: ProjektStatus; status_text: string; grund: string | null }[];
  uebergaenge: ProjektStatus[];
}
interface Liste { projekte: Projekt[]; darfGenehmigen: boolean; arten: Record<Art, string>; status: Record<ProjektStatus, string>; projektnummern: string[] }

export const PROJEKT_STATE: Record<ProjektStatus, State> = {
  IDEE: 'None', BEANTRAGT: 'Critical', GENEHMIGT: 'Positive', ABGELEHNT: 'Negative', ZURUECKGESTELLT: 'Information', UMSETZUNG: 'Positive', ABGESCHLOSSEN: 'None',
};
const AKTION: Record<ProjektStatus, string> = {
  IDEE: 'Zurück in den Entwurf', BEANTRAGT: 'Beantragen', GENEHMIGT: 'Genehmigen', ABGELEHNT: 'Ablehnen', ZURUECKGESTELLT: 'Zurückstellen', UMSETZUNG: 'Umsetzung beginnt', ABGESCHLOSSEN: 'Abschließen',
};
const ENTSCHEIDUNG: ProjektStatus[] = ['GENEHMIGT', 'ABGELEHNT', 'ZURUECKGESTELLT'];
const VERTEILUNG_TEXT: Record<Verteilung, string> = { GLEICH: 'gleichmäßig über die Laufzeit', MONAT: 'in einem Monat', HAND: 'von Hand je Monat', JAEHRLICH: 'jährlich wiederkehrend' };
const ARTEN: Art[] = ['KOSTEN', 'ZUSCHUSS', 'SPENDE', 'EIGENMITTEL', 'DARLEHEN', 'TILGUNG', 'FOLGEKOSTEN', 'EINSPARUNG'];
export const monatKurz = (m: string | null | undefined) => (m ? `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '');
const handText = (m: Record<string, number>) => Object.entries(m).sort().map(([k, v]) => `${k}: ${zahlText(v)}`).join('; ');
/** „2027-03: 4.500; 2027-04: 4.500“ → Monat → Betrag */
function handLesen(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const teil of s.split(/[;\n]/)) {
    const m = /^\s*(\d{4}-\d{2})\s*[:=]\s*(.+?)\s*$/.exec(teil);
    const v = m ? zahlLesen(m[2]) : null;
    if (m && v !== null && Number.isFinite(v)) out[m[1]] = v;
  }
  return out;
}

export function ProjekteTab({ s, init, edit, onGeaendert }: { s: PlanSicht; init: Init; edit: boolean; onGeaendert: () => void }) {
  const [l, setL] = useState<Liste | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offen, setOffen] = useState<Projekt | 'neu' | null>(null);
  const laden = () => api.get<Liste>(`${HH}/projekte`).then(setL).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  async function tun(f: () => Promise<unknown>) {
    setError(null);
    try { const r = await f() as { text?: string }; if (r?.text) toast(r.text); await laden(); onGeaendert(); } catch (e) { setError((e as Error).message); }
  }
  const aenderbar = edit && s.aenderbar;
  const o = s.summen.ohne, liq = s.liquiditaet;
  const imPlan = new Set(s.projekte.map((p) => p.id));
  const andere = (l?.projekte ?? []).filter((p) => !imPlan.has(p.id));
  const status = (st: ProjektStatus, text: string) => <ObjectStatus state={PROJEKT_STATE[st]}>{text}</ObjectStatus>;

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Section title={`Auswirkung auf den Haushaltsplan ${s.plan.jahr}`} flush
               status={<Text className="portal-muted portal-small">{s.aenderbar ? 'Simulation: Projekte ein- und ausrechnen' : 'mit dem Beschluss festgeschrieben'}</Text>}>
        <div className="hh-roll">
          <table className="hh-tab">
            <thead><tr><th /><th className="z">Einnahmen</th><th className="z">Ausgaben</th><th className="z">Ergebnis</th><th className="z">Geldbestand 31.12.</th><th className="z">Tiefster Geldbestand</th></tr></thead>
            <tbody>
              <tr><td>ohne Projekte</td><td className="z">{euro(o.einnahmen)}</td><td className="z">{euro(o.ausgaben)}</td><td className="z">{euro(o.ergebnis)}</td><td className="z">{euro(o.jahresende)}</td><td className="z">{euro(o.tiefster)} ({MON[o.tiefsterMonat - 1]})</td></tr>
              <tr className="hh-summe"><td>mit den gewählten Projekten</td><td className="z">{euro(s.summen.einnahmen)}</td><td className="z">{euro(s.summen.ausgaben)}</td>
                <td className="z"><ObjectStatus state={s.summen.ergebnis < 0 ? 'Negative' : 'Positive'}><b>{euro(s.summen.ergebnis)}</b></ObjectStatus></td>
                <td className="z">{euro(liq.monate[11].bestand)}</td>
                <td className="z"><ObjectStatus state={(liq.mindestreserve !== null && liq.tiefster < liq.mindestreserve) || liq.tiefster < 0 ? 'Negative' : 'None'}><b>{euro(liq.tiefster)}</b> ({MON[liq.tiefsterMonat - 1]})</ObjectStatus></td></tr>
              <tr><td>Unterschied</td><td className="z">{euro(s.summen.projekte_e)}</td><td className="z">{euro(s.summen.projekte_a)}</td><td className="z">{euro(s.summen.ergebnis - o.ergebnis)}</td>
                <td className="z">{euro(liq.monate[11].bestand - o.jahresende)}</td><td className="z">{euro(liq.tiefster - o.tiefster)}</td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`Projekte, die ${s.plan.jahr} wirken`} count={s.projekte.length} flush
               actions={edit ? <Button icon="add" onClick={() => setOffen('neu')}>Neues Projekt</Button> : undefined}>
        {s.projekte.length ? (
          <div className="hh-roll">
            <table className="hh-tab">
              <thead><tr><th>Einrechnen</th><th>Projekt</th><th>Status</th><th>Zeitspanne</th><th className="z">Einnahmen {s.plan.jahr}</th><th className="z">Ausgaben {s.plan.jahr}</th>
                <th className="z">Beitrag Ergebnis</th><th className="z">Beitrag Geldbestand 31.12.</th><th className="z">Beitrag tiefster Geldbestand</th><th /></tr></thead>
              <tbody>
                {s.projekte.map((p) => {
                  const voll = l?.projekte.find((x) => x.id === p.id);
                  return (
                    <tr key={p.id}>
                      <td><CheckBox checked={p.einrechnen} disabled={!aenderbar} accessibleName={`${p.bezeichnung} einrechnen`}
                                    onChange={(e) => tun(() => api.put(`${HH}/plan/${s.plan.id}/projekt`, { projekt_id: p.id, einrechnen: e.target.checked }))} /></td>
                      <td className="name">{p.bezeichnung}<small>{p.projektnr ? `Projekt ${p.projektnr} · ` : ''}{p.einrechnen === p.vorgabe ? 'Vorgabe nach dem Status' : p.einrechnen ? 'probeweise eingerechnet' : 'bewusst ausgerechnet'}
                        {(p.wirkung.sum.darlehen || p.wirkung.sum.tilgung) ? ` · Darlehen ${euro(p.wirkung.sum.darlehen)}, Tilgung ${euro(p.wirkung.sum.tilgung)} (nur Liquidität)` : ''}</small></td>
                      <td>{status(p.status, p.status_text)}</td>
                      <td>{monatKurz(p.beginn)} – {monatKurz(p.ende)}</td>
                      <td className="z">{euro(p.wirkung.sum.einnahmen)}</td><td className="z">{euro(p.wirkung.sum.ausgaben)}</td>
                      <td className="z">{euro(p.beitrag.ergebnis)}</td><td className="z">{euro(p.beitrag.jahresende)}</td><td className="z">{euro(p.beitrag.tiefster)}</td>
                      <td>{voll && <Button design="Transparent" icon="detail-view" accessibleName={`Projekt ${p.bezeichnung} öffnen`} onClick={() => setOffen(voll)} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty>Kein Projekt wirkt in {s.plan.jahr}. Ein Projekt erscheint hier, sobald seine Zeitspanne, seine Finanzierung oder seine Folgekosten das Jahr berühren.</Empty>}
        <Text className="portal-muted portal-small" style={{ display: 'block', padding: '0.5rem 1rem' }}>
          Vorgabe: genehmigte, laufende und abgeschlossene Projekte sind eingerechnet, Ideen und Anträge nicht. Der Beitrag zeigt, was sich ändert, wenn genau dieses Projekt ein- bzw. ausgerechnet wird.
          Darlehen und Tilgung wirken nur auf den Geldbestand, nicht auf das Ergebnis.
        </Text>
      </Section>

      <Section title="Alle Projekte" count={l?.projekte.length ?? 0} flush>
        {l?.projekte.length ? (
          <div className="hh-roll">
            <table className="hh-tab">
              <thead><tr><th>Projekt</th><th>Status</th><th>Zeitspanne</th><th className="z">Kosten</th><th className="z">Finanzierung</th><th className="z">Lücke</th><th className="z">Gebucht (FI)</th><th>Budget</th><th /></tr></thead>
              <tbody>
                {[...s.projekte.map((p) => l.projekte.find((x) => x.id === p.id)).filter((x): x is Projekt => !!x), ...andere].map((p) => (
                  <tr key={p.id}>
                    <td className="name">{p.bezeichnung}<small>{[p.projektnr && `Projekt ${p.projektnr}`, p.verantwortlich, p.status_grund && `„${p.status_grund}“`].filter(Boolean).join(' · ')}</small></td>
                    <td>{status(p.status, p.status_text)}</td><td>{monatKurz(p.beginn)} – {monatKurz(p.ende)}</td>
                    <td className="z">{euro(p.budget.kosten)}</td><td className="z">{euro(p.budget.finanzierung)}</td>
                    <td className="z">{p.budget.luecke > 0 ? <ObjectStatus state="Critical">{euro(p.budget.luecke)}</ObjectStatus> : euro(p.budget.luecke)}</td>
                    <td className="z">{p.projektnr ? euro(p.ist.kosten) : '–'}</td>
                    <td>{p.bewertung && p.ist.buchungen ? <ObjectStatus state={p.bewertung.state}>{p.bewertung.text}</ObjectStatus> : '–'}</td>
                    <td><Button design="Transparent" icon="detail-view" accessibleName={`Projekt ${p.bezeichnung} öffnen`} onClick={() => setOffen(p)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Noch keine Projekte – zum Beispiel eine Investition mit Zuschuss, Eigenmitteln und Darlehen.</Empty>}
      </Section>

      {offen && l && <ProjektDialog p={offen === 'neu' ? null : offen} l={l} init={init} edit={edit} jahr={s.plan.jahr}
                                    onClose={(g) => { setOffen(null); if (g) { laden(); onGeaendert(); } }} />}
    </>
  );
}

function ProjektDialog({ p, l, init, edit, jahr, onClose }: { p: Projekt | null; l: Liste; init: Init; edit: boolean; jahr: number; onClose: (geaendert: boolean) => void }) {
  type Zeile = Omit<Position, 'betrag' | 'monate'> & { betrag: string; hand: string };
  const frei = !p || p.status === 'IDEE' || p.status === 'ZURUECKGESTELLT' || l.darfGenehmigen;
  const aenderbar = edit && frei && p?.status !== 'ABGESCHLOSSEN';
  const [f, setF] = useState({
    projektnr: p?.projektnr ?? '', bezeichnung: p?.bezeichnung ?? '', beschreibung: p?.beschreibung ?? '', verantwortlich: p?.verantwortlich ?? '',
    beginn: p?.beginn ?? `${jahr}-01`, ende: p?.ende ?? `${jahr}-12`, bereich: p?.bereich ?? '',
  });
  const [pos, setPos] = useState<Zeile[]>(() => (p?.positionen ?? [{ art: 'KOSTEN', bezeichnung: null, betrag: 0, konto: null, verteilung: 'GLEICH', von: null, bis: null, monate: {} } as Position])
    .map((x) => ({ ...x, betrag: zahlText(x.betrag), hand: handText(x.monate) })));
  const [error, setError] = useState<string | null>(null);
  const [frage, setFrage] = useState<ProjektStatus | 'LOESCHEN' | null>(null);
  const setz = (i: number, n: Partial<Zeile>) => setPos(pos.map((x, k) => (k === i ? { ...x, ...n } : x)));
  async function tun(fn: () => Promise<unknown>) {
    setError(null);
    try { const r = await fn() as { text?: string }; if (r?.text) toast(r.text); onClose(true); } catch (e) { setError((e as Error).message); }
  }
  const sichern = () => tun(() => api.post(`${HH}/projekte`, {
    id: p?.id ?? null, ...f, bereich: f.bereich || null,
    positionen: pos.map((x) => ({ art: x.art, bezeichnung: x.bezeichnung, betrag: x.betrag, konto: x.konto || null, verteilung: x.verteilung, von: x.von || null, bis: x.bis || null, monate: x.verteilung === 'HAND' ? handLesen(x.hand) : {} })),
  }));
  const kontoArt = (a: Art) => (a === 'ZUSCHUSS' || a === 'SPENDE' ? 'E' : a === 'KOSTEN' || a === 'FOLGEKOSTEN' || a === 'EINSPARUNG' ? 'A' : '');

  return (
    <Dialog open headerText={p ? p.bezeichnung : 'Neues Projekt'} onClose={() => onClose(false)}
            footer={<DialogFuss>
              {aenderbar && <Button design="Emphasized" disabled={!f.bezeichnung.trim()} onClick={sichern}>Sichern</Button>}
              {p && p.uebergaenge.filter((u) => (ENTSCHEIDUNG.includes(u) ? l.darfGenehmigen : edit)).map((u) => (
                <Button key={u} design={u === 'GENEHMIGT' ? 'Positive' : u === 'ABGELEHNT' ? 'Negative' : 'Default'} onClick={() => setFrage(u)}>{AKTION[u]}</Button>
              ))}
              {p && edit && (p.status === 'IDEE' || p.status === 'ABGELEHNT') && <Button design="Transparent" icon="delete" onClick={() => setFrage('LOESCHEN')}>Löschen</Button>}
              <Button onClick={() => onClose(false)}>Schließen</Button>
            </DialogFuss>}>
      <div className="hh-dialog" style={{ width: 'min(64rem, 90vw)' }}>
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        {p && <Text><ObjectStatus state={PROJEKT_STATE[p.status]}>{p.status_text}</ObjectStatus>{p.status_von ? ` · ${p.status_von}, ${dat(p.status_am)}` : ''}{p.status_grund ? ` · „${p.status_grund}“` : ''}
          {!frei && edit ? ' · Ändern kann das Projekt jetzt nur, wer Projekte genehmigen darf.' : ''}</Text>}
        <div className="hh-leiste" style={{ paddingBottom: 0 }}>
          <label className="hh-feld" style={{ flex: '2 1 18rem' }}><span>Bezeichnung</span><Input style={{ width: '100%' }} readonly={!aenderbar} value={f.bezeichnung} onInput={(e) => setF({ ...f, bezeichnung: e.target.value })} /></label>
          <label className="hh-feld"><span>Verantwortlich</span><Input readonly={!aenderbar} value={f.verantwortlich} onInput={(e) => setF({ ...f, verantwortlich: e.target.value })} /></label>
          <label className="hh-feld"><span>Beginn (JJJJ-MM)</span><Input style={{ width: '7.5rem' }} readonly={!aenderbar} value={f.beginn} onInput={(e) => setF({ ...f, beginn: e.target.value })} /></label>
          <label className="hh-feld"><span>Ende (JJJJ-MM)</span><Input style={{ width: '7.5rem' }} readonly={!aenderbar} value={f.ende} onInput={(e) => setF({ ...f, ende: e.target.value })} /></label>
          <label className="hh-feld"><span>Tätigkeitsbereich</span>
            <Select disabled={!aenderbar} onChange={(e) => setF({ ...f, bereich: (e.detail.selectedOption as HTMLElement).dataset.b ?? '' })}>
              <Option data-b="" selected={!f.bereich}>–</Option>
              {['A', 'B', 'C', 'D'].map((b) => <Option key={b} data-b={b} selected={f.bereich === b}>{b}</Option>)}
            </Select></label>
          <label className="hh-feld"><span>Projektnummer der FI-Buchungen{l.projektnummern.length ? ` (vorhanden: ${l.projektnummern.slice(0, 8).join(', ')})` : ''}</span>
            <Input style={{ width: '10rem' }} readonly={!aenderbar} value={f.projektnr} onInput={(e) => setF({ ...f, projektnr: e.target.value })} /></label>
          <label className="hh-feld" style={{ flex: '1 1 100%' }}><span>Beschreibung</span><TextArea rows={2} readonly={!aenderbar} value={f.beschreibung} onInput={(e) => setF({ ...f, beschreibung: e.target.value })} /></label>
        </div>

        <div>
          <h4>Kosten, Finanzierung und Folgekosten</h4>
          <div className="hh-roll">
            <table className="hh-tab">
              <thead><tr><th>Art</th><th>Bezeichnung</th><th className="z">Betrag (€)</th><th>Konto</th><th>Verteilung</th><th>von (JJJJ-MM)</th><th>bis</th><th /></tr></thead>
              <tbody>
                {pos.map((x, i) => (
                  <tr key={i}>
                    <td><Select disabled={!aenderbar} style={{ minWidth: '11rem' }} onChange={(e) => {
                      const art = (e.detail.selectedOption as HTMLElement).dataset.a as Art;
                      setz(i, { art, konto: kontoArt(art) === kontoArt(x.art) ? x.konto : null, verteilung: art === 'FOLGEKOSTEN' || art === 'EINSPARUNG' ? 'JAEHRLICH' : x.verteilung === 'JAEHRLICH' ? 'GLEICH' : x.verteilung });
                    }}>{ARTEN.map((a) => <Option key={a} data-a={a} selected={x.art === a}>{l.arten[a]}</Option>)}</Select></td>
                    <td><Input style={{ width: '11rem' }} readonly={!aenderbar} value={x.bezeichnung ?? ''} onInput={(e) => setz(i, { bezeichnung: e.target.value })} /></td>
                    <td className="z">{x.verteilung === 'HAND' ? euro(Object.values(handLesen(x.hand)).reduce((a, b) => a + b, 0))
                      : <Input readonly={!aenderbar} value={x.betrag} onInput={(e) => setz(i, { betrag: e.target.value })} />}</td>
                    <td>{kontoArt(x.art) ? (
                      <Select disabled={!aenderbar} style={{ minWidth: '12rem' }} onChange={(e) => setz(i, { konto: (e.detail.selectedOption as HTMLElement).dataset.k || null })}>
                        <Option data-k="" selected={!x.konto}>– ohne –</Option>
                        {init.konten.filter((k) => k.art === kontoArt(x.art)).map((k) => <Option key={k.konto} data-k={k.konto} selected={k.konto === x.konto}>{k.konto} {k.name}</Option>)}
                      </Select>) : <Text className="portal-muted portal-small">{x.art === 'EIGENMITTEL' ? 'aus dem Geldbestand' : 'nur Liquidität'}</Text>}</td>
                    <td><Select disabled={!aenderbar} style={{ minWidth: '13rem' }} onChange={(e) => setz(i, { verteilung: (e.detail.selectedOption as HTMLElement).dataset.v as Verteilung })}>
                      {(Object.keys(VERTEILUNG_TEXT) as Verteilung[]).filter((v) => v !== 'JAEHRLICH' || x.art === 'FOLGEKOSTEN' || x.art === 'EINSPARUNG')
                        .map((v) => <Option key={v} data-v={v} selected={x.verteilung === v}>{VERTEILUNG_TEXT[v]}</Option>)}
                    </Select></td>
                    {x.verteilung === 'HAND'
                      ? <td colSpan={2}><Input style={{ width: '17rem' }} readonly={!aenderbar} placeholder="2027-03: 4.500; 2027-04: 4.500" value={x.hand} onInput={(e) => setz(i, { hand: e.target.value })} /></td>
                      : <>
                        <td><Input style={{ width: '6.5rem' }} readonly={!aenderbar} placeholder={x.verteilung === 'JAEHRLICH' ? 'nach Ende' : f.beginn} value={x.von ?? ''} onInput={(e) => setz(i, { von: e.target.value })} /></td>
                        <td>{x.verteilung === 'MONAT' ? '' : <Input style={{ width: '6.5rem' }} readonly={!aenderbar} placeholder={x.verteilung === 'JAEHRLICH' ? 'unbefristet' : f.ende} value={x.bis ?? ''} onInput={(e) => setz(i, { bis: e.target.value })} />}</td>
                      </>}
                    <td>{aenderbar && <Button design="Transparent" icon="delete" accessibleName="Position entfernen" onClick={() => setPos(pos.filter((_, k) => k !== i))} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="portal-row" style={{ marginTop: '0.5rem' }}>
            {aenderbar && <Button icon="add" onClick={() => setPos([...pos, { art: 'KOSTEN', bezeichnung: null, betrag: '', konto: null, verteilung: 'GLEICH', von: null, bis: null, hand: '' }])}>Position</Button>}
            {p && <Text className="portal-muted portal-small">Kosten {euro(p.budget.kosten)} · Finanzierung {euro(p.budget.finanzierung)} (Zuschuss {euro(p.budget.zuschuss)}, Spende {euro(p.budget.spende)}, Eigenmittel {euro(p.budget.eigenmittel)}, Darlehen {euro(p.budget.darlehen)})
              {p.budget.luecke > 0 ? ` · Lücke ${euro(p.budget.luecke)}` : ''}{p.budget.folge_jahr ? ` · danach ${euro(p.budget.folge_jahr)} je Jahr` : ''}{p.projektnr ? ` · gebucht ${euro(p.ist.kosten)} (${p.ist.buchungen} Buchungen)` : ''}</Text>}
          </div>
        </div>

        {p && p.verlauf.length > 0 && (
          <div>
            <h4>Verlauf der Genehmigung</h4>
            <ul className="hh-liste">{p.verlauf.map((v, i) => <li key={i}>{dat(v.am)} · {v.von}: {v.status_text}{v.grund ? ` – „${v.grund}“` : ''}</li>)}</ul>
          </div>
        )}
      </div>
      {p && frage && frage !== 'LOESCHEN' && (
        <ConfirmDialog open title={`${AKTION[frage]}: ${p.bezeichnung}`} confirmText={AKTION[frage]} askReason={frage === 'ABGELEHNT' || frage === 'ZURUECKGESTELLT'} danger={frage === 'ABGELEHNT'}
                       text={frage === 'GENEHMIGT' ? `Kosten ${euro(p.budget.kosten)}, Finanzierung ${euro(p.budget.finanzierung)}. Genehmigte Projekte werden in den Entwürfen des Haushaltsplans eingerechnet.`
                         : frage === 'BEANTRAGT' ? 'Der Antrag erscheint im Arbeitsvorrat derer, die Projekte genehmigen dürfen. Danach lässt sich das Projekt nur noch von ihnen ändern.' : `Neuer Status: ${l.status[frage]}.`}
                       onCancel={() => setFrage(null)} onConfirm={(grund) => { const z = frage; setFrage(null); tun(() => api.post(`${HH}/projekte/${p.id}/status`, { status: z, grund: grund || null })); }} />
      )}
      {p && frage === 'LOESCHEN' && (
        <ConfirmDialog open title="Projekt löschen" text={`Das Projekt „${p.bezeichnung}“ mit allen Positionen löschen?`} confirmText="Löschen" askReason danger
                       onCancel={() => setFrage(null)} onConfirm={(grund) => { setFrage(null); tun(() => api.post(`${HH}/projekte/${p.id}/loeschen`, { grund })); }} />
      )}
    </Dialog>
  );
}
