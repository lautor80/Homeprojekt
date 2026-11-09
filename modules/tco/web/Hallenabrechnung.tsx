import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AblageDialog } from '@core/ablage';
import {
  AnalyticalTable, Bar, BusyIndicator, Button, DateRangePicker, Dialog, FlexBox, Icon, Input, Label, Link, List, ListItemCustom, Tag,
  ListItemGroup, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Panel, SegmentedButton, SegmentedButtonItem,
  Select, Switch, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import '@ui5/webcomponents-fiori/dist/illustrations/NoData.js';
import '@ui5/webcomponents-fiori/dist/illustrations/SimpleEmptyList.js';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { SperrHinweis, useSperre } from '@core/sperre';
import { IconAktionen, iconSpalte } from '@core/components/IconAktionen';
import { PdfDialog } from '@core/components/PdfDialog';
import { Section } from '@core/components/Section';
import { Attribute, Attributes } from '@core/components/Attributes';
import { ObjectHeader } from '@core/components/ObjectHeader';
import { MasterDetail } from '@core/components/MasterDetail';
import { Filter, Filters, HeaderKpi } from '@core/components/Filters';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import {
  H, PROBLEM_ICON, RG_STATE, RG_STATUS, dat, dateiLesen, eur, wtag, zeit,
  type Buchung, type PaperlessInfo, type Person, type PersonDetail, type Position, type Rechnung,
  bidText,
} from './util';
import { AutoDialog } from './AutoZuordnung';
import { SammelDialog } from './SammelRechnung';
import { SammelVersandDialog } from './SammelVersand';
import './halle.css';
import { MailDialog, MailtextDialog, PositionDialog, PositionTextDialog, VersionenDialog, WhatsAppDialog, ZahlungenDialog } from './HalleDialoge';

/** Filter bleiben beim Wechsel zwischen Seiten erhalten */
const merk = {
  status: ['1', '2', '3', '5'],
  von: '', bis: '', buchungen: true, suche: '', sort: 'buchungen' as 'buchungen' | 'name' | 'betrag', kunde: null as string | null,
};

type Confirm = { titel: string; text: string; grund?: boolean; danger?: boolean; ok: string; run: (grund: string) => Promise<void> } | null;

/** Symbol je Rechnungsstatus in der Personenliste (Farbe über CSS-Klasse) */
const RG_SYMBOL: Record<string, { icon: string; klasse: string }> = {
  '1': { icon: 'collections-insight', klasse: 'offen' },  // in Bearbeitung
  '2': { icon: 'collections-insight', klasse: 'offen' },  // gedruckt, noch nicht versendet
  '3': { icon: 'email', klasse: 'versendet' },
  '5': { icon: 'money-bills', klasse: 'teil' },
  '4': { icon: 'paid-leave', klasse: 'bezahlt' },
  '6': { icon: 'decline', klasse: 'ausgefallen' },
};

export function Hallenabrechnung() {
  const can = useCan();
  const navigate = useNavigate();
  const edit = can('tco.halle:edit');
  const versand = can('tco.halle:versand');
  const [status, setStatus] = useState(merk.status);
  const [von, setVon] = useState(merk.von);
  const [bis, setBis] = useState(merk.bis);
  const [mitBuchungen, setMitBuchungen] = useState(merk.buchungen);
  const [suche, setSuche] = useState(merk.suche);
  const [sort, setSort] = useState(merk.sort);
  const [kunde, setKunde] = useState<string | null>(merk.kunde);
  const [liste, setListe] = useState<{ personen: Person[]; gesamtOffen: number } | null>(null);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [rgnr, setRgnr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [csvAblage, setCsvAblage] = useState(false);

  // Dialoge
  const [pdf, setPdf] = useState<string | null>(null);
  const [posDlg, setPosDlg] = useState(false);
  const [mail, setMail] = useState<string[] | null>(null);
  const [wa, setWa] = useState<string[] | null>(null);
  const [mailtext, setMailtext] = useState<string | null>(null);
  const [zahlungen, setZahlungen] = useState<Rechnung | null>(null);
  const [versionen, setVersionen] = useState<PaperlessInfo | null>(null);
  const [auto, setAuto] = useState(false);
  const [sammel, setSammel] = useState(false);
  const [sammelVersand, setSammelVersand] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [protokoll, setProtokoll] = useState<Protokoll | null>(null);

  Object.assign(merk, { status, von, bis, buchungen: mitBuchungen, suche, sort, kunde });
  const selQs = qs({ status: status.join(','), von, bis, buchungen: mitBuchungen ? '1' : '0' });

  const ladeListe = useCallback(async () => {
    try {
      setListe(await api.get(`${H}/personen${selQs}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selQs]);

  const ladeDetail = useCallback(async (k: string | null) => {
    if (!k) { setDetail(null); return; }
    try {
      const d = await api.get<PersonDetail>(`${H}/person${selQs}&kunde=${encodeURIComponent(k)}`);
      setDetail(d);
      // Hinweise der Liste mit dem frisch ermittelten Stand der Person abgleichen
      setListe((l) => (l ? { ...l, personen: l.personen.map((p) => (p.kunde === d.kunde ? { ...p, probleme: d.probleme ?? [] } : p)) } : l));
      setRgnr((alt) => (alt && d.rechnungen.some((r) => r.rgnr_txt === alt) ? alt : d.rechnungen.length === 1 ? d.rechnungen[0].rgnr_txt : null));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selQs]);

  useEffect(() => { ladeListe(); }, [ladeListe]);
  useEffect(() => { ladeDetail(kunde); }, [kunde, ladeDetail]);

  const neuLaden = async () => { await Promise.all([ladeListe(), ladeDetail(kunde)]); };

  /** Aktion mit Meldung und Neuladen */
  const tun = async (fn: () => Promise<{ text?: string; warnungen?: string[] } | void>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && r.text) toast(r.text, 5000);
      if (r && r.warnungen?.length) setError(r.warnungen.join(' · '));
      await neuLaden();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --------------------------------------------------------------- Import
  async function csvImport(files: FileList | File[] | null) {
    if (!files?.length) return;
    const zeilen: Protokoll['zeilen'] = [];
    await tun(async () => {
      for (const f of Array.from(files)) {
        try {
          const r = await api.post<{ text: string }>(`${H}/import/datei`, { name: f.name, data: await dateiLesen(f) });
          zeilen.push({ quelle: f.name, ok: true, text: r.text });
        } catch (e) { zeilen.push({ quelle: f.name, ok: false, text: (e as Error).message }); }
      }
    });
    setProtokoll({ titel: 'Protokoll CSV-Import', zeilen });
  }

  const n8nImport = () => tun(async () => {
    const r = await api.post<{ datei: string; ok: boolean; text: string }[]>(`${H}/import/n8n`);
    setProtokoll({ titel: 'Protokoll EP3-Import', zeilen: r.map((x) => ({ quelle: x.datei, ok: x.ok, text: x.text })) });
  });

  // --------------------------------------------------------------- Personenliste
  const personen = useMemo(() => {
    const s = suche.trim().toLowerCase();
    const l = (liste?.personen ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.rechnungen.some((r) => r.rgnr_txt.includes(s)));
    const cmp: Record<typeof sort, (a: Person, b: Person) => number> = {
      buchungen: (a, b) => b.offeneBuchungen - a.offeneBuchungen || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      betrag: (a, b) => b.betrag - a.betrag,
    };
    return [...l].sort(cmp[sort]);
  }, [liste, suche, sort]);
  const gruppen = useMemo(() => [...new Set(personen.map((p) => p.gruppe))].sort(), [personen]);

  const rechnung = detail?.rechnungen.find((r) => r.rgnr_txt === rgnr) ?? null;

  const header = (
    <Filters>
      <Filter label="Status" width="18rem">
        <MultiComboBox style={{ width: '100%' }} placeholder="alle"
                       onSelectionChange={(e) => setStatus(e.detail.items.map((i) => (i as HTMLElement).dataset.key!))}>
          {Object.entries(RG_STATUS).map(([k, t]) => <MultiComboBoxItem key={k} data-key={k} text={`${k} – ${t}`} selected={status.includes(k)} />)}
        </MultiComboBox>
      </Filter>
      <Filter label="Druckdatum" width="15rem">
        <DateRangePicker style={{ width: '100%' }} placeholder="alle" formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd"
                         value={von ? `${von} - ${bis || von}` : ''}
                         onChange={(e) => {
                           const [a, b] = (e.detail.value || '').split(' - ');
                           setVon(a || ''); setBis(b || a || '');
                         }} />
      </Filter>
      <Filter label="Person / Rechnung" width="14rem">
        <Input style={{ width: '100%' }} icon={<span />} placeholder="Name oder Nummer" value={suche} showClearIcon onInput={(e) => setSuche(e.target.value)} />
      </Filter>
      <Filter label="Offene Buchungen">
        <Switch checked={mitBuchungen} onChange={(e) => setMitBuchungen(e.target.checked)} />
      </Filter>
      <HeaderKpi label="Gesamt offen" value={eur(liste?.gesamtOffen)} state={(liste?.gesamtOffen ?? 0) > 0 ? 'Critical' : 'None'} />
    </Filters>
  );

  return (
    <AppPage
      title="Hallenabrechnung"
      header={header}
      actions={<>
        {edit && <Button icon="download-from-cloud" onClick={n8nImport}>EP3 importieren</Button>}
        {edit && <Button icon="upload" onClick={() => setCsvAblage(true)}>CSV-Datei</Button>}
        {edit && <Button icon="add-process" onClick={() => setAuto(true)}>Automatisch zuordnen</Button>}
        {edit && <Button icon="create-form" onClick={() => setSammel(true)}>Rechnung ohne Buchung</Button>}
        {versand && <Button icon="paper-plane" tooltip="Rechnungen „In Bearbeitung“ gesammelt drucken und per E-Mail versenden" onClick={() => setSammelVersand(true)}>Sammelversand</Button>}
        <Button icon="lead" onClick={() => navigate('/tco/hallenpreise')}>Hallenpreise</Button>
      </>}
    >
      <AblageDialog open={csvAblage} titel="EP3-Export einlesen (CSV)" onClose={() => setCsvAblage(false)} accept=".csv,.txt,text/csv,text/plain"
                    feldTitel="CSV-Dateien hier ablegen" text="Buchungs- und Kundenexport aus EP3 hierher ziehen oder klicken zum Auswählen – das Ergebnis erscheint als Protokoll."
                    ziel={{ titel: 'Hallenabrechnung (CSV-Import)', annehmen: (f) => { csvImport(f); } }} />
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <BusyIndicator active={busy} delay={300} style={{ width: '100%', display: 'block' }}>
        {/* genau ein Kind: der BusyIndicator legt Kinder sonst als zentrierte Flex-Zeile aus (Liste rückte in die Mitte) */}
        <div className="portal-busy-inhalt">
        <MasterDetail
          masterWidth="26rem" gleicheHoehe
          emptyTitle="Keine Person ausgewählt" emptyText="Links eine Person wählen, um Buchungen und Rechnungen zu bearbeiten."
          onBack={() => { setKunde(null); setRgnr(null); }}
          masterHead={
            <FlexBox justifyContent="SpaceBetween" alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem' }}>
              <Title level="H5">Personen <span className="portal-muted">({personen.length})</span></Title>
              <SegmentedButton onSelectionChange={(e) => setSort((e.detail.selectedItems[0] as HTMLElement).dataset.key as typeof sort)}>
                <SegmentedButtonItem data-key="buchungen" selected={sort === 'buchungen'}>Buchungen</SegmentedButtonItem>
                <SegmentedButtonItem data-key="name" selected={sort === 'name'}>Name</SegmentedButtonItem>
                <SegmentedButtonItem data-key="betrag" selected={sort === 'betrag'}>Betrag</SegmentedButtonItem>
              </SegmentedButton>
            </FlexBox>
          }
          master={
            <List selectionMode="Single" noDataText={liste ? 'Keine Personen in der Selektion' : 'Wird geladen …'}
                  onItemClick={(e) => { setKunde((e.detail.item as HTMLElement).dataset.kunde ?? null); setRgnr(null); }}>
              {gruppen.map((g) => (
                <ListItemGroup key={g} headerText={g}>
                  {personen.filter((p) => p.gruppe === g).map((p) => (
                    <ListItemCustom key={p.kunde} data-kunde={p.kunde} selected={p.kunde === kunde}>
                      <div className="portal-hp">
                        <div className="portal-hp__kopf">
                          <span className="portal-hp__name">
                            {p.probleme?.length ? <Icon name={p.probleme.some((x) => x.schwere === 'Negative') ? 'message-error' : 'message-warning'}
                                                         className={`portal-hp__warn portal-hp__warn--${p.probleme.some((x) => x.schwere === 'Negative') ? 'Negative' : 'Critical'}`}
                                                         accessibleName="Problem bei der Rechnungserstellung" /> : null}
                            {p.name}
                          </span>
                          <span className="portal-hp__summe">{eur(p.betrag)}</span>
                        </div>
                        {/* Probleme direkt in der Liste – ohne die Detailsicht zu öffnen */}
                        {p.probleme?.map((x) => (
                          <div key={x.art} className={`portal-hp__problem portal-hp__problem--${x.schwere}`} title={x.text}>
                            <Icon name={PROBLEM_ICON[x.art]} className="portal-hp__symbol" />
                            <span>{x.text}</span>
                          </div>
                        ))}
                        {/* jede Rechnung der Person in der Selektion mit Status und offenem Betrag */}
                        {/* je Rechnung: Symbol nach Status (ohne Text), Rechnungsnummer, Betrag */}
                        {[...p.rechnungen].sort((a, b) => a.status.localeCompare(b.status) || b.rgnr_txt.localeCompare(a.rgnr_txt)).map((r) => {
                          const st = RG_SYMBOL[r.status] ?? RG_SYMBOL['1'];
                          return (
                            <div key={r.rgnr_txt} className={`portal-hp__rg portal-hp__rg--${st.klasse}`} title={RG_STATUS[r.status] ?? r.status}>
                              {r.status === '5' ? (
                                <Button design="Transparent" icon={st.icon} className="portal-hp__knopf" tooltip={`Teilbezahlt – Zahlungen anzeigen`}
                                        onClick={(e) => { e.stopPropagation(); setZahlungen({ rgnr_txt: r.rgnr_txt, betrag: r.betrag, gezahlt: r.betrag - r.offen } as Rechnung); }} />
                              ) : <Icon name={st.icon} className="portal-hp__symbol" />}
                              <span className="portal-hp__nr">{r.rgnr_txt}</span>
                              <span className="portal-hp__betrag">
                                {r.status === '5' ? <>{eur(r.offen)} <span className="portal-muted">von {eur(r.betrag)}</span></>
                                  : ['4', '6'].includes(r.status) ? eur(r.betrag) : eur(r.offen)}
                              </span>
                            </div>
                          );
                        })}
                        {p.offeneBuchungen > 0 && (
                          <div className="portal-hp__rg portal-hp__rg--offen" title={`${p.offeneBuchungen} Buchung(en) ohne Rechnung`}>
                            <Icon name="collections-insight" className="portal-hp__symbol" />
                            <span className="portal-hp__nr portal-muted">{p.offeneBuchungen}×</span>
                            <span className="portal-hp__betrag">{eur(p.betragBuchungen)}</span>
                          </div>
                        )}
                      </div>
                    </ListItemCustom>
                  ))}
                </ListItemGroup>
              ))}
            </List>
          }
          detail={detail ? (
            <PersonPanel
              d={detail} rgnr={rgnr} setRgnr={setRgnr} rechnung={rechnung} edit={edit} versand={versand} tun={tun}
              onSchliessen={() => { setKunde(null); setRgnr(null); }}
              onPdf={(nr) => setPdf(nr)} onPosition={() => setPosDlg(true)} onMail={(nrs) => setMail(nrs)} onWa={(nrs) => setWa(nrs)}
              onMailtext={(nr) => setMailtext(nr)} onZahlungen={setZahlungen} onVersionen={setVersionen} onConfirm={setConfirm}
            />
          ) : null}
        />
        </div>
      </BusyIndicator>

      <PdfDialog url={pdf ? `${H}/rechnungen/${encodeURIComponent(pdf)}/pdf` : null} title={`Druckvoransicht Rechnung ${pdf ?? ''}`}
                 filename={`Rechnung_${pdf}.pdf`} onClose={() => setPdf(null)}
                 actions={versand && pdf ? (
                   <Button design="Emphasized" icon="print" onClick={() => {
                     const nr = pdf;
                     setPdf(null);
                     tun(() => api.post(`${H}/rechnungen/${encodeURIComponent(nr)}/drucken`));
                   }}>Drucken und ablegen</Button>
                 ) : undefined} />
      <PositionDialog open={posDlg} rgnr={rgnr} onClose={() => setPosDlg(false)}
                      onSaved={(t) => { setPosDlg(false); toast(t, 5000); neuLaden(); }} />
      <MailDialog rgnrs={mail} detail={detail} onClose={() => setMail(null)} onDone={(t, w) => { setMail(null); toast(t, 5000); if (w?.length) setError(w.join(' · ')); neuLaden(); }} />
      <WhatsAppDialog rgnrs={wa} detail={detail} onClose={() => { setWa(null); neuLaden(); }} onDone={(t) => { setWa(null); toast(t, 5000); neuLaden(); }} />
      <MailtextDialog rgnr={mailtext} onClose={() => setMailtext(null)} />
      <ZahlungenDialog rechnung={zahlungen} onClose={() => setZahlungen(null)} />
      <ProtokollDialog p={protokoll} onClose={() => setProtokoll(null)} />
      <VersionenDialog info={versionen} onClose={() => setVersionen(null)} />
      <AutoDialog open={auto} onClose={() => setAuto(false)} onDone={(t) => { setAuto(false); toast(t, 6000); neuLaden(); }} />
      <SammelDialog open={sammel} onClose={() => setSammel(false)} onDone={(t) => { setSammel(false); toast(t, 6000); neuLaden(); }} />
      <SammelVersandDialog open={sammelVersand} onClose={() => setSammelVersand(false)} onDone={(t) => { setSammelVersand(false); toast(t, 6000); neuLaden(); }} />
      <ConfirmDialog open={!!confirm} title={confirm?.titel ?? ''} text={confirm?.text ?? ''} askReason={confirm?.grund}
                     danger={confirm?.danger} confirmText={confirm?.ok}
                     onCancel={() => setConfirm(null)}
                     onConfirm={(grund) => { const c = confirm!; setConfirm(null); tun(() => c.run(grund)); }} />
    </AppPage>
  );
}

// ===========================================================================
// Detailbereich einer Person
// ===========================================================================

function PersonPanel(props: {
  d: PersonDetail; rgnr: string | null; setRgnr: (r: string | null) => void; rechnung: Rechnung | null; edit: boolean; versand: boolean;
  tun: (fn: () => Promise<{ text?: string; warnungen?: string[] } | void>) => Promise<void>;
  onSchliessen: () => void; onPdf: (nr: string) => void; onPosition: () => void; onMail: (nrs: string[]) => void; onWa: (nrs: string[]) => void;
  onMailtext: (nr: string) => void; onZahlungen: (r: Rechnung) => void; onVersionen: (i: PaperlessInfo) => void; onConfirm: (c: Confirm) => void;
}) {
  const { d, rgnr, setRgnr, rechnung, edit, versand, tun } = props;
  const k = d.kontakt;
  const aenderbar = d.rechnungen.filter((r) => r.aenderbar);
  const vergangene = d.buchungen.filter((b) => b.vergangen);
  const [pos, setPos] = useState<Position[] | null>(null);
  const [pl, setPl] = useState<PaperlessInfo | null>(null);
  const [posText, setPosText] = useState<Position | null>(null);
  const [irrelevant, setIrrelevant] = useState<{ bid: string; datum: string; termine: number; time_start: string; time_ende: string }[] | null>(null);
  // gewählte (änderbare) Rechnung gegen gleichzeitige Bearbeitung sperren
  const sperre = useSperre('RECHNUNG', rechnung?.aenderbar ? rechnung.rgnr_txt : null, edit, { bezeichnung: rechnung ? `Hallenrechnung ${rechnung.rgnr_txt}` : undefined });
  const rgEdit = edit && sperre.eigen;

  useEffect(() => {
    setPos(null);
    setPl(null);
    if (!rgnr) return;
    api.get<{ positionen: Position[] }>(`${H}/rechnungen/${encodeURIComponent(rgnr)}`).then((r) => setPos(r.positionen)).catch(() => setPos([]));
    api.get<PaperlessInfo>(`${H}/rechnungen/${encodeURIComponent(rgnr)}/paperless`).then(setPl).catch(() => setPl(null));
  }, [rgnr, d]);

  const post = (url: string, body?: unknown) => () => api.post<{ text: string }>(url, body);
  const rgUrl = (nr: string) => `${H}/rechnungen/${encodeURIComponent(nr)}`;
  const zuordnen = (ziel: string, buchungen: Buchung[]) => tun(async () => {
    const r = await api.post<{ rgnr_txt: string; text: string }>(`${H}/zuordnen`, {
      rgnr: ziel, kunde: d.kunde, buchungen: buchungen.map((b) => ({ bid: b.bid, datum: b.datum })),
    });
    setRgnr(r.rgnr_txt);
    return r;
  });

  const rgMenu = (r: Rechnung) => [
    { text: 'Druckvoransicht', icon: 'show', onClick: () => props.onPdf(r.rgnr_txt) },
    { text: 'Drucken und in Paperless ablegen', icon: 'print', hidden: !versand, onClick: () => tun(post(`${rgUrl(r.rgnr_txt)}/drucken`)) },
    { text: `Per E-Mail senden${d.kanal === 'E' ? ' (bevorzugt)' : ''}`, icon: 'email', hidden: !versand, disabled: !k?.email, onClick: () => props.onMail([r.rgnr_txt]) },
    { text: `Per WhatsApp senden${d.kanal === 'W' ? ' (bevorzugt)' : ''}`, icon: 'discussion', hidden: !versand, disabled: !k?.mobil, onClick: () => props.onWa([r.rgnr_txt]) },
    { text: 'E-Mail-Text anzeigen', icon: 'document-text', onClick: () => props.onMailtext(r.rgnr_txt) },
    { text: 'Als versendet markieren', icon: 'paper-plane', hidden: !edit, disabled: ['3', '4', '6'].includes(r.status), onClick: () => tun(post(`${rgUrl(r.rgnr_txt)}/status`, { aktion: 'versendet' })) },
    {
      text: 'Gezahlt', icon: 'paid-leave', hidden: !edit, disabled: ['4', '6'].includes(r.status),
      onClick: () => props.onConfirm({
        titel: 'Rechnung als gezahlt abschließen', ok: 'Gezahlt',
        text: `Rechnung ${r.rgnr_txt} über ${eur(r.betrag)} als vollständig bezahlt abschließen?${r.offen > 0 && r.gezahlt > 0 ? ` Laut FI-Belegen sind noch ${eur(r.offen)} offen.` : ''}`,
        run: async () => { await post(`${rgUrl(r.rgnr_txt)}/status`, { aktion: 'bezahlt' })(); toast('Rechnung als gezahlt markiert und abgeschlossen'); },
      }),
    },
    {
      text: 'Wieder eröffnen', icon: 'unlocked', hidden: !edit || r.status !== '3',
      onClick: () => props.onConfirm({
        titel: `Rechnung ${r.rgnr_txt} wieder eröffnen`, ok: 'Wieder eröffnen', grund: true,
        text: 'Die versendete Rechnung wird wieder änderbar. Die Begründung wird als Notiz am Paperless-Dokument gespeichert.',
        run: async (grund) => {
          const x = await api.post<{ text: string }>(`${rgUrl(r.rgnr_txt)}/status`, { aktion: 'entsperren', begruendung: grund });
          toast(x.text);
        },
      }),
    },
  ];
  const rgCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Rechnung', accessor: 'rgnr_txt', width: 110, Cell: ({ row }: Cell) => <Text style={{ fontWeight: row.original.rgnr_txt === rgnr ? 'bold' : undefined }}>{row.original.rgnr_txt}</Text> },
    { Header: 'Pos.', accessor: 'anzahl', width: 60, hAlign: 'End' },
    {
      Header: 'Betrag', accessor: 'betrag', width: 150, hAlign: 'End',
      Cell: ({ row }: Cell) => {
        const r = row.original as Rechnung;
        return (
          <FlexBox direction="Column" alignItems="End">
            <Text>{eur(r.betrag)}</Text>
            {r.gezahlt > 0 && (
              <Text style={{ fontSize: 'var(--sapFontSmallSize)', color: 'var(--sapContent_LabelColor)' }}>
                {r.status === '4' ? 'vollständig gezahlt' : r.betrag - r.gezahlt < 0 ? `überzahlt ${eur(r.gezahlt - r.betrag)}` : `offen ${eur(r.offen)}`}
              </Text>
            )}
          </FlexBox>
        );
      },
    },
    { Header: 'Erstellt', accessor: 'angelegt_am', width: 95, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Gedruckt', accessor: 'gedruckt', width: 95, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Versendet', accessor: 'versendet', width: 95, Cell: ({ value }: Cell) => dat(value) },
    {
      Header: 'Paperless', accessor: 'doknr', width: 90,
      Cell: ({ row }: Cell) => (row.original.doknr ? (
        <Link onClick={async (e) => {
          e.stopPropagation();
          const i = await api.get<PaperlessInfo>(`${rgUrl(row.original.rgnr_txt)}/paperless`);
          if (i.versionen.length <= 1) window.open(`${H}/paperless/${i.versionen[0]?.id ?? row.original.doknr}/pdf`, '_blank');
          else props.onVersionen(i);
        }}>{row.original.doknr}</Link>
      ) : null),
    },
    {
      Header: 'Status', accessor: 'status', width: 140,
      Cell: ({ row }: Cell) => (
        <ObjectStatus state={RG_STATE[row.original.status]}>
          {RG_STATUS[row.original.status]}{row.original.wiedereroeffnet ? ' (wieder eröffnet)' : ''}
        </ObjectStatus>
      ),
    },
    {
      Header: 'Aktionen', id: 'aktion', disableSortBy: true,
      width: iconSpalte(Math.max(1, ...(d.rechnungen ?? []).map((r) => rgMenu(r).filter((x) => !x.hidden).length))),
      Cell: ({ row }: Cell) => <IconAktionen items={rgMenu(row.original)} />,
    },
  ];

  const posCols: AnalyticalTableColumnDefinition[] = [
    { Header: 'Pos.', accessor: 'rgpos', width: 60 },
    { Header: 'Art', accessor: 'art', width: 100, Cell: ({ value }: Cell) => <ArtLabel art={String(value)} /> },
    {
      Header: 'Beschreibung', accessor: 'beschreibung', minWidth: 200,
      Cell: ({ row, value }: Cell) => (
        <FlexBox alignItems="Center" style={{ gap: '0.25rem' }}>
          <Text>{String(value).split('\t').filter(Boolean).join(' · ')}</Text>
          {row.original.erloeskonto && <Tag design="Set2" colorScheme="10" hideStateIcon title="abweichendes Erlöskonto">Konto {row.original.erloeskonto}</Tag>}
          {row.original.beleg_doc_id && (
            <Button icon="attachment" design="Transparent" tooltip={`Beleg ansehen (DOKID ${String(row.original.beleg_doc_id).padStart(6, '0')})`}
                    onClick={() => window.open(`${H}/paperless/${row.original.beleg_doc_id}/pdf`, '_blank')} />
          )}
        </FlexBox>
      ),
    },
    { Header: 'Menge', accessor: 'anzahl', width: 80, hAlign: 'End', Cell: ({ value }: Cell) => Number(value).toLocaleString('de-DE', { maximumFractionDigits: 2 }) },
    { Header: 'Einzelpreis', accessor: 'ep', width: 110, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    {
      Header: 'Betrag', accessor: 'betrag', width: 110, hAlign: 'End',
      Cell: ({ row }: Cell) => <Text style={{ color: row.original.storno ? 'var(--sapNegativeTextColor)' : undefined }}>{eur(row.original.betrag)}{row.original.storno ? ' (storniert)' : ''}</Text>,
    },
    {
      Header: '', id: 'weg', width: iconSpalte(2), disableSortBy: true,
      Cell: ({ row }: Cell) => (rgEdit && rechnung?.aenderbar ? (
        <div style={{ display: 'flex', flexWrap: 'nowrap', justifyContent: 'flex-end', width: '100%' }}>
        {row.original.manuell && (
          <Button icon="edit" design="Transparent" tooltip="Text der Position ändern" accessibleName="Text der Position ändern"
                  onClick={() => setPosText(row.original as Position)} />
        )}
        <Button icon="delete" design="Transparent" tooltip="Position entfernen" accessibleName="Position entfernen" onClick={() => {
          const p = row.original as Position;
          const nr = rechnung!.rgnr_txt;
          const loeschen = (grund?: string) => tun(async () => api.del<{ text: string }>(`${rgUrl(nr)}/positionen/${p.rgpos}`, { begruendung: grund }));
          if (rechnung!.wiedereroeffnet) {
            props.onConfirm({
              titel: `Position ${p.rgpos} entfernen`, ok: 'Entfernen', danger: true, grund: true,
              text: 'Die Rechnung war bereits versendet. Die Begründung wird als Notiz am Paperless-Dokument gespeichert.',
              run: async (g) => { const x = await api.del<{ text: string }>(`${rgUrl(nr)}/positionen/${p.rgpos}`, { begruendung: g }); toast(x.text); },
            });
          } else loeschen();
        }} />
        </div>
      ) : null),
    },
  ];

  const bCols: AnalyticalTableColumnDefinition[] = [
    {
      Header: 'Buchung', accessor: 'bid', width: 120,
      Cell: ({ row }: Cell) => (
        <FlexBox direction="Column">
          <Text>{bidText(row.original.bid)}</Text>
          <BuchungsartLabel b={row.original as Buchung} />
        </FlexBox>
      ),
    },
    {
      Header: 'Termin', accessor: 'datum', minWidth: 190,
      Cell: ({ row }: Cell) => {
        const b = row.original as Buchung;
        return (
          <FlexBox direction="Column">
            <Text>{wtag(b.datum)}, {dat(b.datum)} · {zeit(b.time_start)}–{zeit(b.time_ende)} Uhr</Text>
            {b.text && <Text style={{ fontSize: 'var(--sapFontSmallSize)', color: 'var(--sapContent_LabelColor)' }}>{b.text}</Text>}
          </FlexBox>
        );
      },
    },
    { Header: 'Dauer', accessor: 'dauer', width: 75, hAlign: 'End', Cell: ({ value }: Cell) => `${value} min` },
    {
      Header: 'Betrag', accessor: 'betrag', width: 200, hAlign: 'End',
      Cell: ({ row }: Cell) => (
        <FlexBox direction="Column" alignItems="End">
          <Text>{eur(row.original.betrag)}</Text>
          {row.original.fehler && <Text style={{ color: 'var(--sapNegativeTextColor)', fontSize: 'var(--sapFontSmallSize)', whiteSpace: 'normal', textAlign: 'right' }}>{row.original.fehler}</Text>}
        </FlexBox>
      ),
    },
    {
      Header: 'Zuordnen zu', id: 'ziel', width: 210, disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const b = row.original as Buchung;
        if (!edit) return null;
        if (!b.vergangen) return <Text style={{ color: 'var(--sapContent_LabelColor)' }}>erst nach dem Termin</Text>;
        return (
          <Select style={{ width: '100%' }} onChange={(e) => {
            const ziel = (e.detail.selectedOption as HTMLElement).dataset.ziel!;
            if (ziel) zuordnen(ziel, [b]);
          }}>
            <Option data-ziel="" selected>Rechnung wählen …</Option>
            {aenderbar.map((r) => <Option key={r.rgnr_txt} data-ziel={r.rgnr_txt}>{r.rgnr_txt} ({RG_STATUS[r.status]})</Option>)}
            <Option data-ziel="NEU">+ Neue Rechnung anlegen</Option>
          </Select>
        );
      },
    },
    {
      Header: 'Aktionen', id: 'menu', width: iconSpalte(2), disableSortBy: true,
      Cell: ({ row }: Cell) => {
        const b = row.original as Buchung;
        const aktion = (a: string) => tun(post(`${H}/buchungen/aktion`, { bid: b.bid, datum: b.datum, aktion: a }));
        return edit ? (
          <IconAktionen items={[
            { text: 'Abo als Einzelbuchungen abrechnen', icon: 'split', hidden: b.art !== 'Abo', onClick: () => aktion('einzel') },
            { text: 'Wieder als Abo-Serie abrechnen', icon: 'combine', hidden: b.art !== 'Einzel' || b.status !== '1', onClick: () => aktion('serie') },
            {
              text: 'Buchung irrelevant setzen (wird nicht abgerechnet)', icon: 'hide', onClick: () => props.onConfirm({
                titel: 'Buchung irrelevant setzen', ok: 'Irrelevant',
                text: `Buchung ${bidText(b.bid)} (${dat(b.datum)}${b.art === 'Abo' ? ', ganze Abo-Serie' : ''}) wird nicht abgerechnet. Unter „Irrelevante Buchungen“ lässt sie sich wieder öffnen.`,
                run: async () => { const x = await api.post<{ text: string }>(`${H}/buchungen/aktion`, { bid: b.bid, datum: b.datum, aktion: 'irrelevant' }); toast(x.text); },
              }),
            },
          ]} />
        ) : null;
      },
    },
  ];

  return (
    <div className="portal-stack" style={{ gap: 0 }}>
      {/* Objektkopf */}
      <ObjectHeader
        title={d.name}
        icon="customer"
        subtitle={d.adrnr ? `Adressnummer ${d.adrnr}` : 'Kein Mitglied / EP3-Kunde zugeordnet'}
        status={<>
          <ObjectStatus state={d.offeneRechnungen ? 'Critical' : 'None'} inverted={!!d.offeneRechnungen}>{d.offeneRechnungen} offene Rechnung(en)</ObjectStatus>
          <ObjectStatus state="Information">{d.buchungen.length} offene Buchung(en)</ObjectStatus>
          {d.kanal === 'E' && <ObjectStatus icon={<Icon name="email" />} state="None">E-Mail bevorzugt</ObjectStatus>}
          {d.kanal === 'W' && <ObjectStatus icon={<Icon name="discussion" />} state="None">WhatsApp bevorzugt</ObjectStatus>}
        </>}
        actions={<Button icon="decline" design="Transparent" tooltip="Schließen" onClick={props.onSchliessen} />}
      >
        <Attributes>
          <Attribute label="Anschrift">{k && <>{k.strasse}<br />{k.plz} {k.ort}</>}</Attribute>
          <Attribute label="E-Mail">{k?.email && <Link href={`mailto:${k.email}`}>{k.email}</Link>}</Attribute>
          <Attribute label="Telefon">{k?.telefon && <Link href={`tel:${k.telefon}`}>{k.telefon}</Link>}</Attribute>
          <Attribute label="Bevorzugter Versand">
            {k && (
              <SegmentedButton onSelectionChange={(e) => {
                const kanal = (e.detail.selectedItems[0] as HTMLElement).dataset.k;
                if (kanal && edit) tun(post(`${H}/kanal`, { adrnr: k.adrnr, kanal }));
              }}>
                <SegmentedButtonItem data-k="E" disabled={!k.email || !edit} selected={d.kanal === 'E'}>E-Mail</SegmentedButtonItem>
                <SegmentedButtonItem data-k="W" disabled={!k.mobil || !edit} selected={d.kanal === 'W'}>WhatsApp</SegmentedButtonItem>
              </SegmentedButton>
            )}
          </Attribute>
          <Attribute label="Offene Buchungen">{d.buchungen.length} · {eur(d.betragBuchungen)}</Attribute>
          <Attribute label="Offene Rechnungen">{eur(d.offenRechnungen)}{d.gezahlt ? ` (bereits gezahlt ${eur(d.gezahlt)})` : ''}</Attribute>
          <Attribute label="Gesamtbetrag" strong>{eur(d.offenRechnungen + d.betragBuchungen)}</Attribute>
        </Attributes>
        {(d.probleme ?? []).map((x) => (
          <MessageStrip key={x.art} design={x.schwere} hideCloseButton style={{ marginTop: '0.75rem' }}>{x.text}</MessageStrip>
        ))}
      </ObjectHeader>

      {/* Rechnungen */}
      <Section title="Rechnungen" count={d.rechnungen.length} flush
               actions={<>
                 {versand && d.rechnungen.filter((r) => !['4', '6'].includes(r.status)).length > 1 && (
                   <Button icon="email" design="Transparent" disabled={!k?.email}
                           onClick={() => props.onMail(d.rechnungen.filter((r) => !['4', '6'].includes(r.status)).map((r) => r.rgnr_txt))}>Alle offenen per E-Mail</Button>
                 )}
                 {edit && <Button icon="add" design="Transparent" onClick={() => tun(async () => {
                   const r = await api.post<{ rgnr_txt: string }>(`${H}/rechnungen`, { kunde: d.kunde });
                   setRgnr(r.rgnr_txt);
                   return { text: `Rechnung ${r.rgnr_txt} angelegt` };
                 })}>Anlegen</Button>}
               </>}>
        <AnalyticalTable minRows={1} columns={rgCols} data={d.rechnungen} visibleRows={Math.max(d.rechnungen.length, 1)} rowHeight={48}
                         noDataText="Keine Rechnungen in der Selektion" sortable
                         onRowClick={(e) => setRgnr(e.detail.row.original.rgnr_txt)} />
      </Section>

      {/* Positionen */}
      {rechnung && (
        <Section title={`Positionen zu ${rechnung.rgnr_txt}`} count={pos?.length ?? 0} flush
                 status={<ObjectStatus state={RG_STATE[rechnung.status]} inverted>{RG_STATUS[rechnung.status]}</ObjectStatus>}
                 actions={<>
                   {rgEdit && rechnung.aenderbar && <Button icon="add" design="Transparent" onClick={props.onPosition}>Position hinzufügen</Button>}
                   {rgEdit && rechnung.aenderbar && (pos?.length ?? 0) > 1 && <Button icon="sort" design="Transparent" onClick={() => tun(post(`${rgUrl(rechnung.rgnr_txt)}/nummerieren`))}>Neu nummerieren</Button>}
                   <ChangeHistoryButton objectType="RECHNUNG" objectKey={rechnung.rgnr_txt} />
                 </>}>
          <SperrHinweis s={sperre} style={{ margin: '0.75rem 1rem 0.25rem', width: 'auto' }} />
          {!rechnung.aenderbar && <MessageStrip hideCloseButton style={{ margin: '0.75rem 1rem 0.25rem' }}>
            Die Rechnung ist {RG_STATUS[rechnung.status].toLowerCase()} und nimmt keine Positionen mehr auf.{rechnung.status === '3' ? ' Über das Menü „Wieder eröffnen“ wird sie änderbar.' : ''}
          </MessageStrip>}
          <AnalyticalTable minRows={1} columns={posCols} data={pos ?? []} loading={!pos} visibleRows={Math.max(pos?.length ?? 1, 1)}
                           noDataText="Keine Positionen" />
          {pl && (pl.doknr || pl.fehler) && <PaperlessBlock pl={pl} />}
        </Section>
      )}

      {/* Teilzahlungen: eigener Abschnitt, sobald zur Rechnung Zahlungen vorliegen */}
      {rechnung && rechnung.gezahlt > 0 && <TeilzahlungenAbschnitt rechnung={rechnung} />}

      {/* Offene Buchungen */}
      <Section title="Offene Buchungen" count={d.buchungen.length} flush
               actions={edit && vergangene.length > 0 && (!rechnung?.aenderbar || rgEdit) ? (
                 <Button icon="add-process" design="Emphasized"
                         onClick={() => zuordnen(rechnung?.aenderbar ? rechnung.rgnr_txt : 'NEU', vergangene)}>
                   {rechnung?.aenderbar ? `Vergangene zu ${rechnung.rgnr_txt} (${vergangene.length})` : `Vergangene auf neue Rechnung (${vergangene.length})`}
                 </Button>
               ) : undefined}>
        <AnalyticalTable minRows={1} columns={bCols} data={d.buchungen} visibleRows={Math.max(d.buchungen.length, 1)} rowHeight={56}
                         noDataText="Keine offenen Buchungen" sortable />
      </Section>

      {/* Irrelevante Buchungen */}
      <Panel collapsed headerText="Irrelevant gesetzte Buchungen"
             onToggle={(e) => { if (!(e.target as unknown as { collapsed: boolean }).collapsed && !irrelevant) api.get<typeof irrelevant>(`${H}/irrelevant?kunde=${encodeURIComponent(d.kunde)}`).then(setIrrelevant); }}>
        {(irrelevant ?? []).length === 0 ? <Text>Keine</Text> : (irrelevant ?? []).map((b) => (
          <FlexBox key={b.bid} alignItems="Center" style={{ gap: '1rem' }}>
            <Text>{bidText(b.bid)} · {dat(b.datum)} {zeit(b.time_start)}–{zeit(b.time_ende)} Uhr{b.termine > 1 ? ` · ${b.termine} Termine` : ''}</Text>
            {edit && <Button design="Transparent" icon="undo" onClick={() => tun(async () => {
              const r = await api.post<{ text: string }>(`${H}/buchungen/aktion`, { bid: b.bid, datum: b.datum, aktion: 'relevant' });
              setIrrelevant(null);
              return r;
            })}>Wieder offen</Button>}
          </FlexBox>
        ))}
      </Panel>
      <PositionTextDialog rgnr={rechnung?.rgnr_txt ?? null} position={posText} onClose={() => setPosText(null)}
                          onSaved={(t) => { setPosText(null); tun(async () => ({ text: t })); }} />
    </div>
  );
}

// ===========================================================================
// Bausteine: Protokoll, Buchungsart, Teilzahlungen, Paperless
// ===========================================================================

interface Protokoll { titel: string; zeilen: { quelle: string; ok: boolean; text: string }[] }
const zelle = { padding: '0.35rem 0.5rem', verticalAlign: 'top', borderTop: '1px solid var(--sapList_BorderColor)' } as const;

/** Protokolle immer als Tabelle: Quelle, Ergebnis, Meldungen (Teilsätze als eigene Zeilen) */
function ProtokollDialog({ p, onClose }: { p: Protokoll | null; onClose: () => void }) {
  if (!p) return null;
  return (
    <Dialog open headerText={p.titel} style={{ width: 'min(52rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>Schließen</Button>} />}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{['Quelle', 'Ergebnis', 'Meldung'].map((h) => <th key={h} style={{ ...zelle, borderTop: 'none', textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
        <tbody>
          {p.zeilen.flatMap((z, i) => {
            const teile = z.text.split(/\s·\s|;\s|\.\s(?=[A-ZÄÖÜ])/).map((t) => t.trim()).filter(Boolean);
            return teile.map((t, j) => (
              <tr key={`${i}-${j}`}>
                <td style={zelle}>{j === 0 && <Text>{z.quelle}</Text>}</td>
                <td style={zelle}>{j === 0 && <ObjectStatus state={z.ok ? 'Positive' : 'Negative'} showDefaultIcon>{z.ok ? 'ok' : 'Fehler'}</ObjectStatus>}</td>
                <td style={zelle}><Text>{t}</Text></td>
              </tr>
            ));
          })}
          {!p.zeilen.length && <tr><td style={zelle} colSpan={3}><Text>Keine Einträge.</Text></td></tr>}
        </tbody>
      </table>
    </Dialog>
  );
}

/** Art als farbiges Label: Abo blau, Einzel grün, Manuell grau, sonst neutral */
const ART_FARBE: Record<string, string> = { Abo: '6', Einzel: '8', Manuell: '10', Buchung: '7' };
function ArtLabel({ art, text }: { art: string; text?: string }) {
  return <Tag design="Set2" colorScheme={ART_FARBE[art] ?? '10'} hideStateIcon style={{ width: 'fit-content' }}>{text ?? art}</Tag>;
}
function BuchungsartLabel({ b }: { b: Buchung }) {
  return <ArtLabel art={b.art} text={b.art === 'Abo' ? `Abo · ${b.termine} Termin(e)` : 'Einzel'} />;
}

/** Teilzahlungen einer Rechnung – eigener Abschnitt im Detail, sobald Zahlungen vorliegen */
function TeilzahlungenAbschnitt({ rechnung }: { rechnung: Rechnung }) {
  const [z, setZ] = useState<{ fibeleg: string; betrag: number; datum: string | null; text: string | null }[] | null>(null);
  useEffect(() => {
    setZ(null);
    api.get<typeof z>(`${H}/rechnungen/${encodeURIComponent(rechnung.rgnr_txt)}/zahlungen`).then(setZ).catch(() => setZ([]));
  }, [rechnung.rgnr_txt, rechnung.gezahlt]);
  const rest = rechnung.betrag - rechnung.gezahlt;
  const voll = rechnung.status === '4' || rest === 0;
  return (
    <Section title={`${voll ? 'Zahlungen' : 'Teilzahlungen'} zu ${rechnung.rgnr_txt}`} count={z?.length ?? 0} flush
             status={<ObjectStatus state={rest > 0 ? 'Critical' : 'Positive'} inverted>
               {rest > 0 ? `offen ${eur(rest)}` : rest < 0 ? `überzahlt ${eur(-rest)}` : 'vollständig gezahlt'}
             </ObjectStatus>}>
      <div style={{ padding: '0.25rem 1rem 0.75rem' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>{['Datum', 'FI-Beleg', 'Text', 'Betrag'].map((h, i) => <th key={h} style={{ ...zelle, borderTop: 'none', textAlign: i === 3 ? 'right' : 'left' }}><Label>{h}</Label></th>)}</tr></thead>
          <tbody>
            {!z && <tr><td style={zelle} colSpan={4}><BusyIndicator active size="S" /></td></tr>}
            {(z ?? []).map((x) => (
              <tr key={x.fibeleg}>
                <td style={{ ...zelle, whiteSpace: 'nowrap' }}><Text>{dat(x.datum)}</Text></td>
                <td style={zelle}><Text>{x.fibeleg}</Text></td>
                <td style={zelle}><Text>{x.text ?? ''}</Text></td>
                <td style={{ ...zelle, textAlign: 'right' }}><Text>{eur(x.betrag)}</Text></td>
              </tr>
            ))}
            <tr>
              <td style={zelle} colSpan={3}><Text style={{ fontWeight: 'bold' }}>Gezahlt {eur(rechnung.gezahlt)} von {eur(rechnung.betrag)}</Text></td>
              <td style={{ ...zelle, textAlign: 'right' }}><Text style={{ fontWeight: 'bold', color: rest > 0 ? 'var(--sapCriticalTextColor)' : undefined }}>{rest < 0 ? `überzahlt ${eur(-rest)}` : `offen ${eur(rest)}`}</Text></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Paperless: Dokument, Freigabelink (gekürzt, kopierbar) und Notizen als Tabelle – je eigener Abschnitt */
function PaperlessBlock({ pl }: { pl: PaperlessInfo }) {
  const kurz = (u: string) => { try { const x = new URL(u); return `${x.host}/…${x.pathname.slice(-8)}`; } catch { return u.length > 40 ? `${u.slice(0, 28)}…${u.slice(-8)}` : u; } };
  return (
    <div style={{ padding: '0.75rem 1rem 1rem', display: 'grid', gap: '0.75rem' }}>
      {pl.fehler && <MessageStrip design="Critical" hideCloseButton>{pl.fehler}</MessageStrip>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '0.5rem 1.5rem' }}>
        {pl.ansicht && (
          <div>
            <Label showColon>Paperless-Dokument</Label><br />
            <Link href={pl.ansicht} target="_blank">Dokument {pl.doknr} öffnen</Link>
            {pl.versionen.length > 1 && <Text className="portal-muted"> · {pl.versionen.length} Fassungen</Text>}
          </div>
        )}
        {pl.link && (
          <div>
            <Label showColon>Freigabelink (30 Tage gültig)</Label><br />
            <Link href={pl.link} target="_blank" tooltip={pl.link}>{kurz(pl.link)}</Link>
            <Button design="Transparent" icon="copy" tooltip="Link kopieren" onClick={() => { navigator.clipboard?.writeText(pl.link!); toast('Freigabelink kopiert'); }} />
          </div>
        )}
      </div>
      {pl.notizen.length > 0 && (
        <div>
          <Label showColon>Paperless-Notizen</Label>
          <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: '0.25rem' }}>
            <thead><tr>{['Datum', 'Notiz'].map((h) => <th key={h} style={{ ...zelle, borderTop: 'none', textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
            <tbody>
              {pl.notizen.slice(0, 10).map((n) => (
                <tr key={n.id}><td style={{ ...zelle, whiteSpace: 'nowrap', width: '7rem' }}><Text>{dat(n.created)}</Text></td><td style={zelle}><Text>{n.note}</Text></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
