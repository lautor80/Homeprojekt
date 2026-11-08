import { useEffect, useMemo, useState } from 'react';
import {
  BusyIndicator, Button, CheckBox, Input, Label, MessageStrip, ObjectStatus, Option, Select, Switch, Tab, TabContainer, Text,
} from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { SperrHinweis, useSperre } from '@core/sperre';
import { dat, eur } from '../util';
import { GRUPPE_NEU, KO, type KontoZeile, type Uebersicht } from './typen';
import { Bestaende } from './Bestaende';

/**
 * Kontenstamm – Port von Z2UI5_CL_TCO_KONTEN.
 * Stammdaten der FI-Konten mit Übersicht der Buchungen je Jahr (Fenster von 6 Jahren) und
 * Pflege der Kontenverwendung je Geschäftsjahr. Kein Haken = Konto ist in diesem Jahr nicht
 * in den Kontenlisten der FI-Belege. Änderungen werden erst mit „Speichern“ wirksam.
 */

type Design = 'Information' | 'Positive' | 'Critical' | 'Negative';
const zelle = { padding: '0.25rem 0.5rem', verticalAlign: 'top' } as const;
const kopf = { ...zelle, textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--sapList_BorderColor)' } as const;
const schluessel = (z: KontoZeile) => z.key ?? z.konto;

/** Zeile gegenüber dem Datenbankstand geändert? (HAT_AENDERUNGEN) */
function geaendert(z: KontoZeile, db: Map<string, KontoZeile>): boolean {
  if (z.neu) return true;
  const a = db.get(z.konto);
  if (!a) return true;
  if (a.name !== z.name || a.kennzahl !== z.kennzahl || a.profitcenter !== z.profitcenter) return true;
  return z.jahre.some((j, i) => a.jahre[i]?.aktiv !== j.aktiv);
}

export function Konten() {
  const can = useCan();
  const darf = can('tco.konten:edit');
  const [d, setD] = useState<Uebersicht | null>(null);
  const [rows, setRows] = useState<KontoZeile[]>([]);
  const [suche, setSuche] = useState('');
  const [nurBebucht, setNurBebucht] = useState(false);
  const [nurAktuell, setNurAktuell] = useState(false);
  const [msg, setMsg] = useState<{ text: string; design: Design } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('konten');
  // Kontenstamm wird als Ganzes gespeichert → alle Konten sperren, solange der Reiter offen ist
  const sperre = useSperre('FIKONTO', '*', darf && tab === 'konten', { bezeichnung: 'Kontenstamm' });
  const edit = darf && tab === 'konten' && sperre.eigen;

  const kopie = (z: KontoZeile[]) => z.map((r) => ({ ...r, jahre: r.jahre.map((j) => ({ ...j })) }));

  async function laden(von?: number) {
    setBusy(true);
    try {
      const r = await api.get<Uebersicht>(`${KO}/uebersicht${qs({ von })}`);
      setD(r);
      setRows(kopie(r.zeilen));
    } catch (e) { setMsg({ text: (e as Error).message, design: 'Negative' }); } finally { setBusy(false); }
  }
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dbMap = useMemo(() => new Map((d?.zeilen ?? []).map((z) => [z.konto, z])), [d]);
  const hatAenderungen = rows.some((z) => geaendert(z, dbMap));
  const jahre = useMemo(() => (d ? Array.from({ length: d.bis - d.von + 1 }, (_, i) => d.von + i) : []), [d]);

  const setZeile = (key: string, patch: Partial<KontoZeile>) => setRows((l) => l.map((z) => (schluessel(z) === key ? { ...z, ...patch } : z)));
  const setJahr = (key: string, idx: number, aktiv: boolean) =>
    setRows((l) => l.map((z) => (schluessel(z) === key ? { ...z, jahre: z.jahre.map((j, i) => (i === idx ? { ...j, aktiv } : j)) } : z)));

  function blaettern(richtung: -1 | 1) {
    if (!d) return;
    if (hatAenderungen) { setMsg({ text: 'Es gibt ungespeicherte Änderungen. Bitte erst speichern oder Aktualisieren wählen.', design: 'Critical' }); return; }
    setMsg(null);
    laden(d.von + richtung);
  }

  function neuesKonto() {
    if (!d) return;
    setMsg(null);
    setRows((l) => [{
      konto: '', name: '', kennzahl: '', profitcenter: '', gruppe: GRUPPE_NEU, letzte: null, bebucht: true, aktAktiv: true,
      jahre: jahre.map((jahr) => ({ jahr, aktiv: true, anz: 0, saldo: 0 })), neu: true, key: `neu-${Date.now()}-${l.length}`,
    }, ...l]);
  }

  async function speichern() {
    const zeilen = rows.filter((z) => geaendert(z, dbMap)).map((z) => ({
      konto: z.konto, name: z.name, kennzahl: z.kennzahl, profitcenter: z.profitcenter, neu: !!z.neu,
      jahre: z.jahre.map((j) => ({ jahr: j.jahr, aktiv: j.aktiv })),
    }));
    if (!zeilen.length) { setMsg({ text: 'Keine Änderungen vorhanden.', design: 'Information' }); return; }
    setBusy(true);
    try {
      const r = await api.post<{ text: string }>(`${KO}/speichern`, { zeilen });
      toast(r.text, 5000);
      setMsg({ text: r.text, design: 'Positive' });
      await laden(d?.von);
    } catch (e) { setMsg({ text: (e as Error).message, design: 'Negative' }); } finally { setBusy(false); }
  }

  /** Vorschlag für eine Jahresspalte: nur in Jahr/Vorjahr bebuchte Konten, Geldkonten bleiben aktiv */
  async function vorschlag(idx: number) {
    try {
      const r = await api.get<{ aktiv: Record<string, boolean>; text: string }>(`${KO}/vorschlag?jahr=${jahre[idx]}`);
      setRows((l) => l.map((z) => {
        const an = z.neu ? (z.kennzahl === 'BA' || z.kennzahl === 'BK' || z.jahre[idx].aktiv) : (r.aktiv[z.konto] ?? true);
        return { ...z, jahre: z.jahre.map((j, i) => (i === idx ? { ...j, aktiv: an } : j)) };
      }));
      setMsg({ text: r.text, design: 'Information' });
    } catch (e) { setMsg({ text: (e as Error).message, design: 'Negative' }); }
  }

  // ---- Filter (FILTER_STRING) und Gruppierung
  const sichtbar = useMemo(() => {
    const term = suche.trim().toUpperCase();
    return rows.filter((z) => {
      if (term && !`${z.konto} ${z.name} ${z.profitcenter}`.toUpperCase().includes(term)) return false;
      if (nurBebucht && !z.bebucht) return false;
      if (nurAktuell && !z.aktAktiv) return false;
      return true;
    });
  }, [rows, suche, nurBebucht, nurAktuell]);
  const gruppen = useMemo(() => {
    const m = new Map<string, KontoZeile[]>();
    for (const z of sichtbar) m.set(z.gruppe, [...(m.get(z.gruppe) ?? []), z]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sichtbar]);

  const ges = rows.filter((z) => !z.neu).length;
  const aktCnt = rows.filter((z) => z.aktAktiv).length;
  const jahrCnt = jahre.map((_, i) => rows.filter((z) => z.jahre[i]?.aktiv).length);

  const header = (
    <Filters>
      <Filter label="Suche" width="18rem">
        <Input style={{ width: '100%' }} placeholder="Konto oder Bezeichnung suchen" value={suche} showClearIcon onInput={(e) => setSuche(e.target.value)} />
      </Filter>
      <Filter label="nur im Zeitraum bebuchte Konten">
        <Switch checked={nurBebucht} onChange={(e) => setNurBebucht(e.target.checked)} />
      </Filter>
      <Filter label={`Nur in ${d?.aktJahr ?? new Date().getFullYear()} verwendete Konten (${aktCnt}/${ges})`}>
        <Switch checked={nurAktuell} onChange={(e) => setNurAktuell(e.target.checked)} />
      </Filter>
      <HeaderKpi label="Konten" value={ges} />
    </Filters>
  );

  return (
    <AppPage title="Kontenstamm" subtitle="Kontenstamm und Kontenverwendung je Geschäftsjahr" header={header}
             actions={<>
               <Button icon="navigation-left-arrow" design="Transparent" tooltip="Ein Jahr zurück" disabled={!d || busy} onClick={() => blaettern(-1)} />
               <Text style={{ whiteSpace: 'nowrap' }}>{d ? `${d.von} – ${d.bis}` : ''}</Text>
               <Button icon="navigation-right-arrow" design="Transparent" tooltip="Ein Jahr vor" disabled={!d || busy} onClick={() => blaettern(1)} />
               {edit && <Button icon="add" disabled={!d || busy} onClick={neuesKonto}>Neues Konto</Button>}
               <Button icon="refresh" disabled={busy} onClick={() => { laden(d?.von); setMsg({ text: 'Daten neu gelesen, ungespeicherte Änderungen verworfen.', design: 'Information' }); }}>Aktualisieren</Button>
               {edit && <Button icon="save" design="Emphasized" disabled={busy || !hatAenderungen} onClick={speichern}>Speichern</Button>}
             </>}>
      {msg && <MessageStrip design={msg.design} onClose={() => setMsg(null)} style={{ marginBottom: '0.5rem' }}>{msg.text}</MessageStrip>}
      <SperrHinweis s={sperre} />
      <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
        <Tab data-key="konten" text="Konten und Verwendung" icon="list" selected={tab === 'konten'}>
          <BusyIndicator active={busy} delay={300} style={{ width: '100%', display: 'block' }}>
            <div className="portal-busy-inhalt">
            <Section title="Konten" count={sichtbar.length} flush
                     status={<span className="portal-muted portal-small">Kein Haken = Konto ist in diesem Jahr nicht in den Kontenlisten der FI-Belege.</span>}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={kopf}><Label>Konto</Label></th>
                      <th style={{ ...kopf, minWidth: '14rem' }}><Label>Bezeichnung</Label></th>
                      <th style={kopf}><Label>Kz.</Label></th>
                      <th style={kopf}><Label>Profit-Center</Label></th>
                      <th style={kopf}><Label>letzte Buchung</Label></th>
                      {jahre.map((j, i) => (
                        <th key={j} style={kopf}>
                          <span className="portal-row" style={{ flexWrap: 'nowrap' }}>
                            <Label>{`${j} · ${jahrCnt[i]}/${ges}`}</Label>
                            {edit && <Button icon="lightbulb" design="Transparent" tooltip={`Vorschlag ${j}: nur Konten verwenden, die in ${j - 1}/${j} bebucht wurden`} onClick={() => vorschlag(i)} />}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {gruppen.map(([gruppe, zeilen]) => (
                      <GruppenZeilen key={gruppe} gruppe={gruppe} zeilen={zeilen} edit={edit} profitcenter={d?.profitcenter ?? []} spalten={5 + jahre.length}
                                     onZeile={setZeile} onJahr={setJahr} />
                    ))}
                    {!gruppen.length && <tr><td colSpan={5 + jahre.length} className="portal-empty">Keine Konten zu dieser Auswahl</td></tr>}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        </BusyIndicator>
        </Tab>
        <Tab data-key="bestaende" text="Anfangsbestände Geldkonten" icon="wallet" selected={tab === 'bestaende'}>
          {tab === 'bestaende' && d && <Bestaende edit={darf} jahre={jahre} aktJahr={d.aktJahr} />}
        </Tab>
      </TabContainer>
    </AppPage>
  );
}

function GruppenZeilen({ gruppe, zeilen, edit, profitcenter, spalten, onZeile, onJahr }: {
  gruppe: string; zeilen: KontoZeile[]; edit: boolean; profitcenter: { key: string; text: string }[]; spalten: number;
  onZeile: (key: string, patch: Partial<KontoZeile>) => void; onJahr: (key: string, idx: number, aktiv: boolean) => void;
}) {
  return (
    <>
      <tr style={{ background: 'var(--sapList_GroupHeaderBackground)' }}>
        <td colSpan={spalten} style={{ ...zelle, borderTop: '1px solid var(--sapList_BorderColor)', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
          <Label style={{ fontWeight: 'bold', color: 'var(--sapList_GroupHeaderTextColor)' }}>{`${gruppe} (${zeilen.length})`}</Label>
        </td>
      </tr>
      {zeilen.map((z) => {
        const key = z.key ?? z.konto;
        // Zeilenmarkierung wie HIGHLIGHT in SAP: neu = Erfolg, nie bebucht = Information
        const rand = z.neu ? 'var(--sapPositiveColor)' : z.bebucht ? 'transparent' : 'var(--sapInformativeColor)';
        return (
          <tr key={key} style={{ borderTop: '1px solid var(--sapList_BorderColor)', boxShadow: `inset 3px 0 0 ${rand}` }}>
            <td style={zelle}>
              {z.neu
                ? <Input style={{ width: '5rem' }} placeholder="Nr." maxlength={4} value={z.konto} onChange={(e) => onZeile(key, { konto: e.target.value.trim() })} />
                : <Text style={{ fontWeight: 'bold' }}>{z.konto}</Text>}
            </td>
            <td style={zelle}><Input style={{ width: '100%' }} maxlength={30} value={z.name} readonly={!edit} onChange={(e) => onZeile(key, { name: e.target.value })} /></td>
            <td style={zelle}><Input style={{ width: '3.5rem' }} maxlength={2} value={z.kennzahl} readonly={!edit} onChange={(e) => onZeile(key, { kennzahl: e.target.value.toUpperCase() })} /></td>
            <td style={zelle}>
              <Select style={{ width: '10rem' }} disabled={!edit} onChange={(e) => onZeile(key, { profitcenter: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
                {profitcenter.map((p) => <Option key={p.key || '-'} data-k={p.key} selected={p.key === z.profitcenter}>{p.text}</Option>)}
              </Select>
            </td>
            <td style={{ ...zelle, whiteSpace: 'nowrap' }}><Text>{z.neu ? 'neu' : z.letzte ? dat(z.letzte) : 'nie bebucht'}</Text></td>
            {z.jahre.map((j, i) => (
              <td key={j.jahr} style={{ ...zelle, whiteSpace: 'nowrap' }}>
                <div>
                  <CheckBox text="verwenden" checked={j.aktiv} disabled={!edit} onChange={(e) => onJahr(key, i, e.target.checked)} />
                </div>
                <ObjectStatus state={j.anz > 0 ? (j.aktiv ? 'Positive' : 'Critical') : 'None'}>
                  {j.anz > 0 ? `${j.anz} Buch. · ${eur(j.saldo)}` : 'keine Buchungen'}
                </ObjectStatus>
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
}
