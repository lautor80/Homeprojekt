import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, DatePicker, Dialog, Input, Link, MessageStrip, ObjectStatus, Option, SegmentedButton, SegmentedButtonItem,
  Select, Tab, TabContainer, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { PdfDialog } from '@core/components/PdfDialog';
import { useKlein } from '@core/components/ResponsiveTable';
import { Empty, Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat } from '../util';
import { LinienDiagramm } from './Diagramm';
import { KontoDialog } from './KontoDialog';
import { monatKurz, PROJEKT_STATE, ProjekteTab } from './Projekte';
import {
  euro, HH, MON, MONATE, prozent, RECHEN_METHODEN, STATUS_STATE, zahlLesen, zahlText,
  type Init, type Methode, type PlanSicht, type Position, type SollIst, type Vorhaben,
} from './typen';
import './haushalt.css';

/**
 * Haushaltsplan (docs/haushaltsplan/konzept.md): Budget je Konto mit Vorschlag aus den Vorjahren, Fassungen mit Status,
 * Soll-Ist im laufenden Jahr, Liquiditätsvorschau und einmalige Vorhaben. Gerechnet wird im Server
 * (modules/tco/server/haushalt); FI wird nur gelesen.
 */

const isoHeute = () => new Date().toLocaleDateString('sv-SE');
const ARTEN = [['E', 'Einnahmen'], ['A', 'Ausgaben']] as const;

export function Haushaltsplan() {
  const can = useCan();
  const edit = can('tco.haushalt:edit'), admin = can('tco.haushalt:admin');
  const klein = useKlein();
  const [start] = useSearchParams();
  const [tab, setTab] = useState(() => start.get('tab') ?? 'plan');
  const [init, setInit] = useState<Init | null>(null);
  const [jahr, setJahr] = useState<number | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [s, setS] = useState<PlanSicht | null>(null);
  const [si, setSi] = useState<SollIst | null>(null);
  const [siJahr, setSiJahr] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [konto, setKonto] = useState<string | null>(null);
  const [pdf, setPdf] = useState(false);
  const [dialog, setDialog] = useState<null | 'beschliessen' | 'genehmigen' | 'nachtrag' | 'loeschen'>(null);
  const [datum, setDatum] = useState(isoHeute());
  const [text, setText] = useState('');
  const [vorhaben, setVorhaben] = useState<Partial<Vorhaben> & { betragText?: string } | null>(null);
  const [alle, setAlle] = useState<'BEHALTEN' | 'BESTE' | 'HOCH' | 'AVG3' | 'MED5' | 'TREND'>('BEHALTEN');
  const [auchManuelle, setAuchManuelle] = useState(false);
  const [neuKonto, setNeuKonto] = useState('');
  const [siArt, setSiArt] = useState<'E' | 'A'>('A');

  async function initLaden(waehle?: { jahr?: number; id?: number }) {
    try {
      const i = await api.get<Init>(`${HH}/init`);
      setInit(i);
      const j = waehle?.jahr ?? jahr ?? i.plaene.find((p) => p.jahr === i.jahr + 1)?.jahr ?? i.plaene.find((p) => p.jahr === i.jahr)?.jahr ?? i.plaene[0]?.jahr ?? i.jahr + 1;
      setJahr(j);
      const id = waehle?.id ?? (planId && i.plaene.some((p) => p.id === planId && p.jahr === j) ? planId : i.plaene.find((p) => p.jahr === j)?.id ?? null);
      setPlanId(id);
      if (siJahr === null) setSiJahr(i.plaene.some((p) => p.jahr === i.jahr) || !i.plaene.length ? i.jahr : Math.min(j, i.jahr));
    } catch (e) { setError((e as Error).message); }
  }
  async function planLaden(id = planId) {
    if (!id) { setS(null); return; }
    setBusy(true);
    try { setS(await api.get<PlanSicht>(`${HH}/plan/${id}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { initLaden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { planLaden(planId); }, [planId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab !== 'sollist' || siJahr === null) return;
    api.get<SollIst>(`${HH}/sollist?jahr=${siJahr}`).then(setSi).catch((e) => setError((e as Error).message));
  }, [tab, siJahr, s]);

  /** Aktion ausführen, Meldung zeigen, Plan neu lesen */
  async function tun(f: () => Promise<unknown>, danach?: (r: any) => void) {
    setError(null);
    setBusy(true);
    try {
      const r = await f() as { text?: string; id?: number };
      if (r?.text) toast(r.text);
      if (danach) danach(r); else await planLaden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  /** Im Arbeitsvorrat abgewählter Hinweis „Budget überschritten“: Vermerk mit Link zum Wiederanzeigen */
  const wiederAnzeigen = (schluessel: string) => si?.ausgeblendet?.includes(schluessel) && (
    <small className="portal-muted" style={{ display: 'block' }}>
      Hinweis ausgeblendet ·{' '}
      <Link onClick={() => tun(() => api.post(`${HH}/hinweis/ausblenden`, { schluessel, jahr: si.jahr, aus: false }),
        () => api.get<SollIst>(`${HH}/sollist?jahr=${si.jahr}`).then(setSi))}>wieder anzeigen</Link>
    </small>
  );
  const aenderbar = !!s?.aenderbar && edit;
  const jahre = useMemo(() => [...new Set([...(init?.jahre ?? []), ...(init?.plaene.map((p) => p.jahr) ?? [])])].sort((a, b) => b - a), [init]);
  const wechsel = (j: number) => { setJahr(j); setPlanId(init?.plaene.find((p) => p.jahr === j)?.id ?? null); };
  const position = (p: Position, b: Record<string, unknown>) => tun(() => api.put(`${HH}/plan/${s!.plan.id}/position`, { konto: p.konto, ...b }));

  // ---------------------------------------------------------------- Planung
  /** bis zu drei abgeschlossene Vorjahre, dann das Basisjahr (Hochrechnung, solange es läuft) */
  const istJahre = s ? s.jahre.filter((j) => j < s.basisjahr).slice(-3) : [];
  const laeuft = !!s && s.stand_monat < 12;
  const basisWert = (p: Position) => p.grundlage?.hoch?.wert ?? (p.grundlage && s && s.stand_monat >= 12 ? p.grundlage.ist[s.basisjahr] : null) ?? null;
  const spalten = istJahre.length + 7;

  function planZeile(p: Position) {
    const g = p.grundlage;
    const b = basisWert(p);
    const methoden: Methode[] = [...(g?.fach !== null && g?.fach !== undefined ? ['FACH' as const] : []), ...RECHEN_METHODEN.filter((m) => g?.werte[m] !== null && g?.werte[m] !== undefined), 'MANUELL'];
    const treffer = p.methode !== 'FACH' && p.methode !== 'MANUELL' ? g?.treffer[p.methode] ?? null : null;
    return (
      <tr key={p.konto}>
        <td className="name">{p.konto} {p.name}
          <small>
            {g?.wenig_historie && <ObjectStatus state="Information" title="Weniger als drei abgeschlossene Jahre: kein Trend, keine Trefferquote">wenig Historie</ObjectStatus>}
            {!g && 'keine Buchungen in den Vorjahren'}{p.notiz ? ` ${p.notiz}` : ''}
          </small>
        </td>
        {istJahre.map((j) => {
          const sonder = g?.sonder.find((x) => x.jahr === j);
          const aus = g?.ausreisser.find((x) => x.jahr === j);
          return (
            <td key={j} className="z">
              {sonder ? <ObjectStatus state="Critical" title={`Sondereffekt: ${sonder.grund} – zählt nicht in den Vorschlag`}>{euro(g!.ist[j])}</ObjectStatus>
                : aus ? <ObjectStatus state="Information" title={`Möglicher Ausreißer (${prozent(aus.abweichung)} zum Median) – in den Einzelheiten als Sondereffekt kennzeichnen`}>{euro(g!.ist[j])}</ObjectStatus>
                  : euro(g ? g.ist[j] : null)}
            </td>
          );
        })}
        <td className="z" title={g?.hoch && laeuft ? `Ist bis ${MONATE[s!.stand_monat - 1] ?? ''}: ${euro(g.ist_stand)}` : undefined}>{euro(b)}</td>
        <td>
          {aenderbar ? (
            <Select accessibleName={`Methode ${p.name}`} onChange={(e) => position(p, { methode: (e.detail.selectedOption as HTMLElement).dataset.m })}>
              {methoden.map((m) => <Option key={m} data-m={m} selected={m === p.methode}>{init!.methoden[m]}{m === g?.beste ? ' ★' : ''}</Option>)}
            </Select>
          ) : <Text>{p.methode_text}{p.methode === g?.beste ? ' ★' : ''}</Text>}
        </td>
        <td className="z">{treffer === null ? '–' : `${Math.round(treffer)} %`}</td>
        <td className="z">{euro(p.vorschlag)}</td>
        <td className="z">
          {aenderbar
            ? <Input key={`${p.konto}:${p.planwert}`} accessibleName={`Plan ${p.name}`} value={zahlText(p.planwert)} valueState={p.manuell ? 'Information' : 'None'}
                     onChange={(e) => { const v = zahlLesen(e.target.value); if (v !== null && v !== p.planwert) position(p, { planwert: e.target.value }); }} />
            : <b>{euro(p.planwert)}</b>}
        </td>
        <td className="z">{b ? prozent(((p.planwert - b) / b) * 100) : '–'}</td>
        <td><Button design="Transparent" icon="detail-view" tooltip="Einzelheiten: Grundlage, Sondereffekte, Monatsverlauf" accessibleName={`Einzelheiten ${p.name}`} onClick={() => setKonto(p.konto)} /></td>
      </tr>
    );
  }

  function planTabelle() {
    if (!s) return null;
    return (
      <div className="hh-roll">
        <table className="hh-tab">
          <thead>
            <tr>
              <th>Konto</th>
              {istJahre.map((j) => <th key={j} className="z">Ist {j}</th>)}
              <th className="z">{laeuft ? 'Hochr.' : 'Ist'} {s.basisjahr}</th>
              <th>Methode</th><th className="z">Treffer</th><th className="z">Vorschlag</th><th className="z">Plan {s.plan.jahr}</th><th className="z">zu {s.basisjahr}</th><th />
            </tr>
          </thead>
          <tbody>
            {ARTEN.map(([art, artText]) => {
              const pos = s.positionen.filter((p) => p.art === art);
              const vor = art === 'E' ? s.summen.vorhaben_e : s.summen.vorhaben_a;
              const plan = art === 'E' ? s.summen.einnahmen : s.summen.ausgaben, basis = art === 'E' ? s.summen.basis_e : s.summen.basis_a;
              return (
                <Fragment key={art}>
                  <tr className="hh-gruppe"><td colSpan={spalten}>{artText}</td></tr>
                  {s.bereiche.map((b) => {
                    const l = pos.filter((p) => p.bereich === b.bereich);
                    if (!l.length) return null;
                    return (
                      <Fragment key={b.bereich}>
                        <tr className="hh-bereich">
                          <td colSpan={istJahre.length + 1}>{b.text}</td>
                          <td className="z">{euro(l.reduce((a, p) => a + (basisWert(p) ?? 0), 0))}</td>
                          <td colSpan={3} /><td className="z">{euro(art === 'E' ? b.einnahmen : b.ausgaben)}</td><td colSpan={2} />
                        </tr>
                        {l.map(planZeile)}
                      </Fragment>
                    );
                  })}
                  {vor > 0 && (
                    <tr><td className="name" colSpan={istJahre.length + 5}>Einmalige Vorhaben<small>siehe Reiter Vorhaben</small></td><td className="z">{euro(vor)}</td><td colSpan={2} /></tr>
                  )}
                  {(art === 'E' ? s.summen.projekte_e : s.summen.projekte_a) !== 0 && (
                    <tr><td className="name" colSpan={istJahre.length + 5}>Projekte<small>eingerechnet laut Reiter Projekte</small></td><td className="z">{euro(art === 'E' ? s.summen.projekte_e : s.summen.projekte_a)}</td><td colSpan={2} /></tr>
                  )}
                  <tr className="hh-summe">
                    <td colSpan={istJahre.length + 1}>Summe {artText}</td><td className="z">{euro(basis)}</td><td colSpan={3} />
                    <td className="z">{euro(plan)}</td><td className="z">{basis ? prozent(((plan - basis) / basis) * 100) : '–'}</td><td />
                  </tr>
                </Fragment>
              );
            })}
            <tr className="hh-summe">
              <td colSpan={istJahre.length + 1}>Ergebnis (Einnahmen − Ausgaben)</td><td className="z">{euro(s.summen.basis_e - s.summen.basis_a)}</td><td colSpan={3} />
              <td className="z"><ObjectStatus state={s.summen.ergebnis < 0 ? 'Negative' : 'Positive'}><b>{euro(s.summen.ergebnis)}</b></ObjectStatus></td><td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  // ---------------------------------------------------------------- Kopf
  const liq = s?.liquiditaet;
  const fassungen = s?.fassungen ?? [];
  const mitProjekten = !!s && s.projekte.some((p) => p.einrechnen);
  const header = (
    <Filters>
      <Filter label="Geschäftsjahr" width="8rem">
        <Select style={{ width: '100%' }} onChange={(e) => wechsel(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
          {jahre.map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
        </Select>
      </Filter>
      {fassungen.length > 1 && (
        <Filter label="Fassung" width="16rem">
          <Select style={{ width: '100%' }} onChange={(e) => setPlanId(Number((e.detail.selectedOption as HTMLElement).dataset.id))}>
            {fassungen.map((f) => <Option key={f.id} data-id={f.id} selected={f.id === planId}>{f.fassung === 1 ? 'Fassung 1' : `${f.fassung - 1}. Nachtrag`} – {f.status_text}</Option>)}
          </Select>
        </Filter>
      )}
      {s && <>
        <HeaderKpi label="Einnahmen Plan" value={euro(s.summen.einnahmen)} />
        <HeaderKpi label="Ausgaben Plan" value={euro(s.summen.ausgaben)} />
        <HeaderKpi label={mitProjekten ? `Ergebnis Plan (ohne Projekte ${euro(s.summen.ohne.ergebnis)})` : 'Ergebnis Plan'} value={euro(s.summen.ergebnis)} state={s.summen.ergebnis < 0 ? 'Negative' : 'Positive'} />
        <HeaderKpi label={mitProjekten ? `Tiefster Geldbestand (ohne Projekte ${euro(s.summen.ohne.tiefster)})` : 'Tiefster Geldbestand'} value={euro(liq!.tiefster)} state={liq!.mindestreserve !== null && liq!.tiefster < liq!.mindestreserve ? 'Negative' : liq!.tiefster < 0 ? 'Negative' : 'None'} />
      </>}
    </Filters>
  );
  const p0 = s?.plan;
  const untertitel = p0 ? `${p0.fassung === 1 ? 'Fassung 1' : `${p0.fassung - 1}. Nachtrag`} · ${p0.status_text}${p0.beschlossen_am ? ` am ${dat(p0.status === 'GENEHMIGT' ? p0.genehmigt_am : p0.beschlossen_am)}` : ''} · Grundlage: ${s!.stand_text}`
    : 'Budget je Konto mit Vorschlag aus den Vorjahren, Soll-Ist und Liquidität';
  const juengste = !!p0 && fassungen[0]?.id === p0.id;

  return (
    <AppPage title={jahr ? `Haushaltsplan ${jahr}` : 'Haushaltsplan'} subtitle={untertitel} header={header}
             actions={<>
               {p0 && <ObjectStatus state={STATUS_STATE[p0.status]} inverted>{p0.status === 'ENTWURF' ? 'Entwurf' : p0.status === 'BESCHLOSSEN' ? 'Beschlossen' : 'Genehmigt'}</ObjectStatus>}
               {p0 && <Button icon="pdf-attachment" onClick={() => setPdf(true)}>PDF</Button>}
               {p0 && admin && p0.status === 'ENTWURF' && <Button design="Emphasized" icon="accept" onClick={() => { setDatum(isoHeute()); setDialog('beschliessen'); }}>Beschließen</Button>}
               {p0 && admin && p0.status === 'BESCHLOSSEN' && s!.cfg.genehmigung_mv && <Button icon="official-service" onClick={() => { setDatum(isoHeute()); setDialog('genehmigen'); }}>Genehmigung eintragen</Button>}
               {p0 && admin && p0.status !== 'ENTWURF' && juengste && <Button icon="add-document" onClick={() => { setText(''); setDialog('nachtrag'); }}>Nachtrag</Button>}
               {p0 && admin && p0.status === 'ENTWURF' && <Button design="Transparent" icon="delete" onClick={() => setDialog('loeschen')}>Entwurf löschen</Button>}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {init && !planId && jahr && (
        <Section title={`Für ${jahr} gibt es noch keinen Haushaltsplan`}>
          <Text>Beim Anlegen füllt das Portal alle bebuchten Einnahme- und Ausgabekonten mit einem Vorschlag aus den Buchungen der Vorjahre. Geändert wird nur, wo der Vorstand es besser weiß.</Text>
          <div className="portal-row" style={{ marginTop: '0.75rem' }}>
            {edit ? <Button design="Emphasized" icon="add" disabled={busy} onClick={() => tun(() => api.post<{ id: number }>(`${HH}/plan`, { jahr }), (r) => initLaden({ jahr, id: r.id }))}>Haushaltsplan {jahr} anlegen</Button>
              : <Text className="portal-muted">Zum Anlegen fehlt das Recht „Haushaltsplan planen“.</Text>}
          </div>
        </Section>
      )}
      {s && init && (
        <BusyIndicator active={busy} delay={300} style={{ display: 'block', width: '100%' }}>
          <div className="portal-busy-inhalt">
            {p0?.begruendung && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>Nachtrag: {p0.begruendung}</MessageStrip>}
            <TabContainer tabLayout="Inline" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
              <Tab data-key="plan" text="Planung" icon="edit" selected={tab === 'plan'}>
                {aenderbar && (
                  <div className="hh-leiste">
                    <label className="hh-feld"><span>Preissteigerung auf Ausgaben (%)</span>
                      <Input key={s.plan.preissteigerung} style={{ width: '9rem' }} value={zahlText(s.plan.preissteigerung)}
                             onChange={(e) => { const v = zahlLesen(e.target.value); if (v !== null && Number.isFinite(v)) tun(() => api.put(`${HH}/plan/${s.plan.id}`, { preissteigerung: v })); }} /></label>
                    <label className="hh-feld"><span>Methode für alle Konten</span>
                      <Select style={{ minWidth: '15rem' }} onChange={(e) => setAlle((e.detail.selectedOption as HTMLElement).dataset.m as typeof alle)}>
                        <Option data-m="BEHALTEN" selected={alle === 'BEHALTEN'}>je Konto wie gewählt</Option>
                        <Option data-m="BESTE" selected={alle === 'BESTE'}>je Konto die treffsicherste</Option>
                        {RECHEN_METHODEN.map((m) => <Option key={m} data-m={m} selected={alle === m}>{init.methoden[m]}</Option>)}
                      </Select></label>
                    <CheckBox text="auch von Hand geänderte Planwerte" checked={auchManuelle} onChange={(e) => setAuchManuelle(e.target.checked)} />
                    <Button icon="refresh" onClick={() => tun(() => api.post(`${HH}/plan/${s.plan.id}/berechnen`, { methode: alle, auchManuelle }))}>Vorschlag neu berechnen</Button>
                  </div>
                )}
                {s.fehlende.length > 0 && aenderbar && (
                  <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
                    Konten mit Buchungen, die im Plan fehlen: {s.fehlende.map((k) => `${k.konto} ${k.name}`).join(', ')} – „Vorschlag neu berechnen“ nimmt sie auf.
                  </MessageStrip>
                )}
                <Section title="Planwerte je Konto" count={s.positionen.length} flush
                         actions={aenderbar ? <>
                           <Select style={{ minWidth: '14rem' }} accessibleName="Konto aufnehmen" onChange={(e) => setNeuKonto((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
                             <Option data-k="" selected={!neuKonto}>Konto aufnehmen …</Option>
                             {init.konten.filter((k) => !s.positionen.some((p) => p.konto === k.konto)).map((k) => <Option key={k.konto} data-k={k.konto} selected={k.konto === neuKonto}>{k.konto} {k.name}</Option>)}
                           </Select>
                           <Button icon="add" disabled={!neuKonto} onClick={() => tun(() => api.post(`${HH}/plan/${s.plan.id}/position`, { konto: neuKonto })).then(() => setNeuKonto(''))}>Aufnehmen</Button>
                         </> : undefined}>
                  {s.positionen.length ? planTabelle() : <Empty>In den betrachteten Jahren gibt es keine Buchungen auf Einnahme- oder Ausgabekonten.</Empty>}
                </Section>
                <Section title="So entsteht der Vorschlag">
                  <ul className="hh-liste">
                    <li><b>Treffsicherheit:</b> Jede Methode wird rückwirkend geprüft – was hätte sie mit den damals vorliegenden Daten vorhergesagt, und wie nah lag das am tatsächlichen Wert? Die beste Methode ist je Konto vorbelegt (★).</li>
                    <li><b>Sondereffekte</b> (orange markierte Jahre) zählen nicht in die Berechnung, zum Beispiel eine einmalige Sanierung. Blau markierte Jahre schlägt das Portal als Ausreißer vor (mehr als {zahlText(s.cfg.ausreisser_prozent)} % neben dem Median) – entscheiden muss der Kassenwart in den Einzelheiten des Kontos.</li>
                    {laeuft && s.stand_monat > 0 && <li><b>Laufendes Jahr:</b> {s.basisjahr} ist nicht zu Ende. Das Ist bis {MONATE[s.stand_monat - 1]} wird mit dem üblichen Jahresverlauf des Kontos auf das ganze Jahr hochgerechnet.</li>}
                    <li><b>Fachdaten:</b> Wo eine Beitragsart eindeutig auf ein Erlöskonto zeigt, kommt der Planwert aus den laufenden Verträgen (Beitragsforecast) statt aus der Vergangenheit.</li>
                    <li><b>Preissteigerung:</b> Zuschlag auf Ausgaben, nicht auf Fachdaten und manuelle Werte. Vorschläge sind auf volle 10 € gerundet; blau umrandete Planwerte sind von Hand geändert.</li>
                    {s.hinweise.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                </Section>
              </Tab>

              <Tab data-key="sollist" text="Soll-Ist" icon="compare" selected={tab === 'sollist'}>
                <div className="hh-leiste">
                  <label className="hh-feld"><span>Geschäftsjahr</span>
                    <Select style={{ width: '8rem' }} onChange={(e) => setSiJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
                      {jahre.map((j) => <Option key={j} data-j={j} selected={j === siJahr}>{j}</Option>)}
                    </Select></label>
                  {si && <SegmentedButton onSelectionChange={(e) => setSiArt((e.detail.selectedItems[0] as HTMLElement).dataset.a as 'E' | 'A')}>
                    <SegmentedButtonItem data-a="A" selected={siArt === 'A'}>Ausgaben</SegmentedButtonItem>
                    <SegmentedButtonItem data-a="E" selected={siArt === 'E'}>Einnahmen</SegmentedButtonItem>
                  </SegmentedButton>}
                </div>
                {si && !si.plan && <Section><Empty>Für {si.jahr} gibt es keinen Haushaltsplan – ohne Plan kein Soll-Ist-Vergleich.</Empty></Section>}
                {si?.plan && <>
                  {si.vorlaeufig && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Der Plan {si.jahr} ist noch ein Entwurf – der Vergleich ist eine Vorschau. Überschreitungen erscheinen erst nach dem Beschluss im Arbeitsvorrat.</MessageStrip>}
                  <Section title={`${siArt === 'A' ? 'Ausgaben' : 'Einnahmen'} ${si.jahr}: Plan und Ist, aufgelaufen`} status={<Text className="portal-muted portal-small">{si.stand_text}</Text>}>
                    <LinienDiagramm titel={`${siArt === 'A' ? 'Ausgaben' : 'Einnahmen'} ${si.jahr} aufgelaufen, Plan und Ist`} schmal={klein}
                                    serien={[{ name: 'Plan', farbe: 2, gestrichelt: true, werte: si.verlauf[siArt].plan }, { name: 'Ist', farbe: 1, werte: si.verlauf[siArt].ist }]} />
                  </Section>
                  <Section title="Abweichungen je Konto" flush
                           status={<Text className="portal-muted portal-small">Toleranz {zahlText(si.cfg.toleranz_gelb)} % (beobachten) und {zahlText(si.cfg.toleranz_rot)} % (überschritten) · {si.ueberschritten} überschritten, {si.beobachten} beobachten</Text>}>
                    <div className="hh-roll">
                      <table className="hh-tab">
                        <thead><tr><th>Konto</th><th className="z">Plan {si.jahr}</th><th className="z">Ist</th><th className="z">Hochrechnung</th><th className="z">Abweichung</th><th className="z">in %</th><th>Bewertung</th><th className="z">auf Projekte gebucht</th></tr></thead>
                        <tbody>
                          {ARTEN.map(([art, artText]) => (
                            <Fragment key={art}>
                              <tr className="hh-gruppe"><td colSpan={8}>{artText}</td></tr>
                              {si.zeilen.filter((z) => z.art === art).map((z) => (
                                <tr key={z.konto}>
                                  <td className="name">{z.konto} {z.name}<small>{z.bereich_text}{z.geplant ? '' : ' · nicht im Plan'}</small></td>
                                  <td className="z">{euro(z.plan)}</td><td className="z">{euro(z.ist)}</td><td className="z">{euro(z.hochrechnung)}</td>
                                  <td className="z">{z.bewertung.abweichung > 0 ? '+' : ''}{euro(z.bewertung.abweichung)}</td><td className="z">{prozent(z.bewertung.prozent)}</td>
                                  <td><ObjectStatus state={z.bewertung.state}>{z.bewertung.text}</ObjectStatus>{wiederAnzeigen(`HH:${z.konto}`)}</td>
                                  <td className="z">{z.projekt ? euro(z.projekt) : ''}</td>
                                </tr>
                              ))}
                              <tr className="hh-summe">
                                <td>Summe {artText}</td><td className="z">{euro(si.summen[art].plan)}</td><td className="z">{euro(si.summen[art].ist)}</td><td className="z">{euro(si.summen[art].hochrechnung)}</td>
                                <td className="z">{euro(si.summen[art].bewertung.abweichung)}</td><td className="z">{prozent(si.summen[art].bewertung.prozent)}</td>
                                <td><ObjectStatus state={si.summen[art].bewertung.state}>{si.summen[art].bewertung.text}</ObjectStatus></td>
                                <td className="z">{euro(si.zeilen.filter((z) => z.art === art).reduce((a, z) => a + z.projekt, 0))}</td>
                              </tr>
                            </Fragment>
                          ))}
                          <tr className="hh-summe"><td>Ergebnis</td><td className="z">{euro(si.ergebnis.plan)}</td><td className="z">{euro(si.ergebnis.ist)}</td><td className="z">{euro(si.ergebnis.hochrechnung)}</td>
                            <td className="z">{euro(si.ergebnis.hochrechnung - si.ergebnis.plan)}</td><td colSpan={3} /></tr>
                        </tbody>
                      </table>
                    </div>
                  </Section>
                  {si.projekte.length > 0 && (
                    <Section title="Projekte: Budget und Ist" count={si.projekte.length} flush
                             status={<Text className="portal-muted portal-small">Ist aus den FI-Buchungen mit der Projektnummer – im Konto oben nicht mitgezählt</Text>}>
                      <div className="hh-roll">
                        <table className="hh-tab">
                          <thead><tr><th>Projekt</th><th>Status</th><th className="z">Budget gesamt</th><th className="z">Gebucht gesamt</th><th className="z">davon {si.jahr}: Plan</th><th className="z">Ist</th>
                            <th className="z">Abweichung</th><th className="z">in %</th><th>Bewertung</th></tr></thead>
                          <tbody>
                            {si.projekte.map((p) => (
                              <tr key={p.id}>
                                <td className="name">{p.bezeichnung}<small>{p.projektnr ? `Projekt ${p.projektnr}` : 'ohne Projektnummer – Buchungen lassen sich nicht zuordnen'} · {monatKurz(p.beginn)} – {monatKurz(p.ende)}</small></td>
                                <td><ObjectStatus state={PROJEKT_STATE[p.status]}>{p.status_text}</ObjectStatus></td>
                                <td className="z">{euro(p.budget)}</td><td className="z">{euro(p.ist)}</td><td className="z">{euro(p.plan_jahr)}</td><td className="z">{euro(p.ist_jahr)}</td>
                                <td className="z">{p.bewertung.abweichung > 0 ? '+' : ''}{euro(p.bewertung.abweichung)}</td><td className="z">{prozent(p.bewertung.prozent)}</td>
                                <td><ObjectStatus state={p.bewertung.state}>{p.bewertung.text}</ObjectStatus>{wiederAnzeigen(`HHPROJEKTBUDGET:${p.id}`)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Section>
                  )}
                </>}
              </Tab>

              <Tab data-key="liq" text="Liquidität" icon="line-chart" selected={tab === 'liq'}>
                {liq && <>
                  <div className="hh-leiste">
                    {([['anfangsbestand', `Geldbestand 01.01.${s.plan.jahr} (leer = berechnet)`, s.plan.anfangsbestand], ['tilgung', 'Tilgung im Jahr (leer = aus den Darlehenskonten)', s.plan.tilgung],
                      ['mindestreserve', 'Mindestreserve (leer = laut Einstellungen)', s.plan.mindestreserve]] as const).map(([feld, label, wert]) => (
                      <label key={feld} className="hh-feld"><span>{label}</span>
                        <Input key={`${feld}:${wert}`} style={{ width: '12rem' }} readonly={!aenderbar} value={zahlText(wert)}
                               onChange={(e) => tun(() => api.put(`${HH}/plan/${s.plan.id}`, { [feld]: e.target.value.trim() ? e.target.value : null }))} /></label>
                    ))}
                  </div>
                  <Section title={`Geldbestand ${s.plan.jahr} je Monatsende`}
                           status={<Text className="portal-muted portal-small">Anfangsbestand {euro(liq.anfang)} · Tilgung {euro(liq.tilgung.summe)} im Jahr{liq.tilgung.quelle === 'DARLEHEN' ? ' (aus den Darlehenskonten)' : ''}{mitProjekten ? ' · mit den eingerechneten Projekten (Darlehen als Zufluss, Tilgung als Abfluss)' : ''}</Text>}>
                    <LinienDiagramm titel={`Geldbestand ${s.plan.jahr} je Monatsende`} schmal={klein} serien={[
                      { name: 'Geldbestand laut Plan', farbe: 1, werte: liq.monate.map((m) => m.bestand) },
                      ...(liq.ist.some((x) => x !== null) ? [{ name: 'Geldbestand Ist', farbe: 3 as const, werte: liq.ist }] : []),
                      ...(liq.mindestreserve !== null ? [{ name: `Mindestreserve ${euro(liq.mindestreserve)}`, farbe: 2 as const, gestrichelt: true, werte: liq.monate.map(() => liq.mindestreserve) }] : []),
                    ]} />
                    <Text className="portal-muted portal-small">Anfangsbestand: {liq.anfang_herkunft.text}.{liq.mindestreserve === null ? ' Eine Mindestreserve ist nicht hinterlegt – der Geldbestand wird nicht bewertet.' : ''}</Text>
                  </Section>
                  <Section title="Monatswerte" flush status={<Text className="portal-muted portal-small">Planwerte verteilt nach dem Jahresverlauf der Vorjahre, Vorhaben in ihrem Monat</Text>}>
                    <div className="hh-roll">
                      <table className="hh-tab">
                        <thead><tr><th>Monat</th><th className="z">Einnahmen</th><th className="z">Ausgaben</th><th className="z">Tilgung</th><th className="z">Geldbestand</th><th>Bewertung</th></tr></thead>
                        <tbody>
                          {liq.monate.map((m) => (
                            <tr key={m.monat}>
                              <td>{MONATE[m.monat - 1]} {s.plan.jahr}</td><td className="z">{euro(m.einnahmen)}</td><td className="z">{euro(m.ausgaben)}</td><td className="z">{euro(m.tilgung)}</td>
                              <td className="z"><b>{euro(m.bestand)}</b></td>
                              <td>{m.ausreichend === null ? (m.bestand < 0 ? <ObjectStatus state="Negative">Geldbestand negativ</ObjectStatus> : '–')
                                : m.ausreichend ? <ObjectStatus state="Positive">ausreichend</ObjectStatus> : <ObjectStatus state="Negative">unter Mindestreserve</ObjectStatus>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Section>
                </>}
              </Tab>

              <Tab data-key="projekte" text="Projekte" additionalText={String(s.projekte.length)} icon="capital-projects" selected={tab === 'projekte'}>
                <ProjekteTab s={s} init={init} edit={edit} onGeaendert={() => planLaden()} />
              </Tab>

              <Tab data-key="vorhaben" text="Vorhaben" additionalText={String(s.vorhaben.length)} icon="add-product" selected={tab === 'vorhaben'}>
                <Section title="Einmalige Vorhaben" count={s.vorhaben.length} flush
                         status={<Text className="portal-muted portal-small">kleine Einmalposten ohne Genehmigung – größere Vorhaben mit Zeitspanne und Finanzierung gehören in den Reiter Projekte</Text>}
                         actions={aenderbar ? <Button icon="add" onClick={() => setVorhaben({ art: 'A', monat: 1, eingeplant: true, betragText: '' })}>Neues Vorhaben</Button> : undefined}>
                  {s.vorhaben.length ? (
                    <div className="hh-roll">
                      <table className="hh-tab">
                        <thead><tr><th>Einplanen</th><th>Vorhaben</th><th>Art</th><th>Monat</th><th>Konto</th><th>Projekt</th><th className="z">Betrag</th><th /></tr></thead>
                        <tbody>
                          {s.vorhaben.map((v) => (
                            <tr key={v.id}>
                              <td><CheckBox checked={v.eingeplant} disabled={!aenderbar} accessibleName={`${v.bezeichnung} einplanen`}
                                            onChange={(e) => tun(() => api.post(`${HH}/plan/${s.plan.id}/vorhaben`, { ...v, eingeplant: e.target.checked }))} /></td>
                              <td className="name">{v.bezeichnung}</td><td>{v.art === 'E' ? 'Einnahme' : 'Ausgabe'}</td><td>{MON[v.monat - 1]} {s.plan.jahr}</td>
                              <td>{v.konto ?? '–'}</td><td>{v.projekt ?? '–'}</td><td className="z">{euro(v.betrag)}</td>
                              <td>{aenderbar && <>
                                <Button design="Transparent" icon="edit" accessibleName="Vorhaben ändern" onClick={() => setVorhaben({ ...v, betragText: zahlText(v.betrag) })} />
                                <Button design="Transparent" icon="delete" accessibleName="Vorhaben löschen" onClick={() => tun(() => api.post(`${HH}/plan/${s.plan.id}/vorhaben/loeschen`, { id: v.id }))} />
                              </>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <Empty>Keine einmaligen Vorhaben erfasst – zum Beispiel eine Investition und der Zuschuss dazu.</Empty>}
                </Section>
              </Tab>
            </TabContainer>
          </div>
        </BusyIndicator>
      )}

      {s && init && konto && s.positionen.some((p) => p.konto === konto) && (
        <KontoDialog key={konto} s={s} init={init} edit={edit} p={s.positionen.find((p) => p.konto === konto)!} onClose={(g) => { setKonto(null); if (g) planLaden(); }} />
      )}

      {vorhaben && s && init && (
        <Dialog open headerText={vorhaben.id ? 'Vorhaben ändern' : 'Neues Vorhaben'} onClose={() => setVorhaben(null)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" disabled={!vorhaben.bezeichnung?.trim() || !vorhaben.betragText?.trim()}
                          onClick={() => tun(() => api.post(`${HH}/plan/${s.plan.id}/vorhaben`, { ...vorhaben, betrag: vorhaben.betragText, betragText: undefined })).then(() => setVorhaben(null))}>Sichern</Button>
                  <Button onClick={() => setVorhaben(null)}>Abbrechen</Button>
                </>} />}>
          <div className="hh-leiste" style={{ maxWidth: '36rem' }}>
            <label className="hh-feld" style={{ flex: '1 1 100%' }}><span>Bezeichnung</span><Input style={{ width: '100%' }} value={vorhaben.bezeichnung ?? ''} onInput={(e) => setVorhaben({ ...vorhaben, bezeichnung: e.target.value })} /></label>
            <label className="hh-feld"><span>Art</span>
              <Select onChange={(e) => setVorhaben({ ...vorhaben, art: (e.detail.selectedOption as HTMLElement).dataset.a as 'E' | 'A', konto: null })}>
                <Option data-a="A" selected={vorhaben.art === 'A'}>Ausgabe</Option><Option data-a="E" selected={vorhaben.art === 'E'}>Einnahme</Option>
              </Select></label>
            <label className="hh-feld"><span>Monat</span>
              <Select onChange={(e) => setVorhaben({ ...vorhaben, monat: Number((e.detail.selectedOption as HTMLElement).dataset.m) })}>
                {MONATE.map((m, i) => <Option key={m} data-m={i + 1} selected={vorhaben.monat === i + 1}>{m}</Option>)}
              </Select></label>
            <label className="hh-feld"><span>Betrag (€)</span><Input style={{ width: '9rem' }} value={vorhaben.betragText ?? ''} onInput={(e) => setVorhaben({ ...vorhaben, betragText: e.target.value })} /></label>
            <label className="hh-feld"><span>Konto (optional – für den Soll-Ist-Vergleich)</span>
              <Select style={{ minWidth: '16rem' }} onChange={(e) => setVorhaben({ ...vorhaben, konto: (e.detail.selectedOption as HTMLElement).dataset.k || null })}>
                <Option data-k="" selected={!vorhaben.konto}>– ohne Konto –</Option>
                {init.konten.filter((k) => k.art === vorhaben.art).map((k) => <Option key={k.konto} data-k={k.konto} selected={k.konto === vorhaben.konto}>{k.konto} {k.name}</Option>)}
              </Select></label>
            <label className="hh-feld"><span>Projekt (optional)</span><Input style={{ width: '9rem' }} value={vorhaben.projekt ?? ''} onInput={(e) => setVorhaben({ ...vorhaben, projekt: e.target.value })} /></label>
            <CheckBox text="einplanen" checked={vorhaben.eingeplant ?? true} onChange={(e) => setVorhaben({ ...vorhaben, eingeplant: e.target.checked })} />
          </div>
        </Dialog>
      )}

      {(dialog === 'beschliessen' || dialog === 'genehmigen') && p0 && (
        <Dialog open headerText={dialog === 'beschliessen' ? `Haushaltsplan ${p0.jahr} beschließen` : `Genehmigung der Mitgliederversammlung eintragen`} onClose={() => setDialog(null)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" onClick={() => { const d = dialog; setDialog(null); tun(() => api.post(`${HH}/plan/${p0.id}/${d}`, { datum }), () => initLaden({ jahr: p0.jahr, id: p0.id }).then(() => planLaden(p0.id))); }}>
                    {dialog === 'beschliessen' ? 'Beschließen' : 'Eintragen'}</Button>
                  <Button onClick={() => setDialog(null)}>Abbrechen</Button>
                </>} />}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '30rem' }}>
            <Text>{dialog === 'beschliessen'
              ? 'Mit dem Beschluss des Vorstands ist diese Fassung unveränderlich: Planwerte, Monatsverlauf und Vorhaben werden festgeschrieben. Spätere Änderungen laufen als Nachtrag (neue Fassung mit Begründung).'
              : 'Die Mitgliederversammlung hat den beschlossenen Haushaltsplan genehmigt. Am Inhalt ändert sich nichts.'}</Text>
            <label className="hh-feld"><span>{dialog === 'beschliessen' ? 'Beschluss vom' : 'Genehmigt am'}</span>
              <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={datum} onChange={(e) => setDatum(e.detail.value)} /></label>
          </div>
        </Dialog>
      )}
      {dialog === 'nachtrag' && p0 && (
        <Dialog open headerText={`Nachtrag zum Haushaltsplan ${p0.jahr}`} onClose={() => setDialog(null)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" disabled={!text.trim()} onClick={() => { setDialog(null); tun(() => api.post<{ id: number }>(`${HH}/plan/${p0.id}/nachtrag`, { begruendung: text }), (r) => initLaden({ jahr: p0.jahr, id: r.id })); }}>Nachtrag anlegen</Button>
                  <Button onClick={() => setDialog(null)}>Abbrechen</Button>
                </>} />}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: 'min(30rem, 80vw)' }}>
            <Text>Der Nachtrag ist eine neue Fassung im Entwurf mit allen Werten der beschlossenen Fassung. Die bisherige Fassung bleibt sichtbar und gilt, bis der Nachtrag beschlossen ist.</Text>
            <label className="hh-feld"><span>Begründung (Pflicht)</span><TextArea rows={3} value={text} onInput={(e) => setText(e.target.value)} /></label>
          </div>
        </Dialog>
      )}
      <ConfirmDialog open={dialog === 'loeschen'} title="Entwurf löschen" text={p0 ? `Den Entwurf des Haushaltsplans ${p0.jahr} (Fassung ${p0.fassung}) mit allen Planwerten und Vorhaben löschen?` : ''}
                     confirmText="Löschen" askReason danger onCancel={() => setDialog(null)}
                     onConfirm={(grund) => { const p = p0!; setDialog(null); tun(() => api.post(`${HH}/plan/${p.id}/loeschen`, { grund }), () => { setS(null); setPlanId(null); initLaden({ jahr: p.jahr }); }); }} />

      <PdfDialog url={pdf && p0 ? `${HH}/plan/${p0.id}/pdf` : null} title={p0 ? `Voransicht Haushaltsplan ${p0.jahr}` : ''} filename={p0 ? `Haushaltsplan_${p0.jahr}_Fassung_${p0.fassung}.pdf` : 'Haushaltsplan.pdf'}
                 onClose={() => setPdf(false)}
                 actions={edit && init?.paperless && p0 ? (
                   <Button design="Emphasized" icon="upload-to-cloud" disabled={busy} onClick={() => tun(async () => {
                     const r = await api.post<{ text: string; warnungen: string[] }>(`${HH}/plan/${p0.id}/paperless`);
                     if (r.warnungen.length) setError(r.warnungen.join('\n'));
                     setPdf(false);
                     return r;
                   }, () => undefined)}>In Paperless ablegen</Button>
                 ) : undefined} />
    </AppPage>
  );
}
