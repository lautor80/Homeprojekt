import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BusyIndicator, Button, CheckBox, Icon, Label, Link, MessageStrip, ObjectStatus, Option, SegmentedButton, SegmentedButtonItem, Select, Text,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { PdfDialog } from '@core/components/PdfDialog';
import { useKlein } from '@core/components/ResponsiveTable';
import { Empty, Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat } from '../util';
import { AuftragWahl, kundeVon, useAuftraege } from './AuftragWahl';
import { OHNE_ADRESSE, absenderFiltern, filterGueltig, gleicherFilter, postfachBaum, type AbsenderFilter, type PostfachKnoten } from './absenderbaum';
import {
  EING, SCHWELLE_STANDARD, STATUS_TEXT, absender, antwortText, dateiUrl, groesse, istPdf, liste, treffer, zeitText,
  type EingangDokument, type EingangsPostfach, type Kandidat, type Vorgang, type VorgangStatus, type VorgangZeile,
} from './typen';

/**
 * App „Posteingang“ (Euroflex): E-Mails aus dem Outlook-Postfach, die n8n geliefert hat und die nicht automatisch am Auftrag
 * abgelegt wurden. Links die Liste mit dem Zuordnungsvorschlag, rechts (auf dem Handy darunter) die E-Mail – darin links die
 * Anhänge, daneben Begründung (mit Fundstellen der Auftrags-/Rechnungsnummer), Kandidaten, Text und den Aktionen „Ignorieren“, „Neu bewerten“, „Am Auftrag ablegen“.
 * Vertrag: docs/euroflex-mailworkflows.md, „Prüfliste und Ablage“.
 */
const FILTER: { key: VorgangStatus; text: string }[] = [
  { key: 'pruefen', text: 'Zu prüfen' },
  { key: 'fehler', text: 'Fehler' },
  { key: 'abgelegt', text: 'Automatisch abgelegt' },
  { key: 'ignoriert', text: 'Ignoriert' },
];
/** Dokumente, die noch abgelegt werden können (vorausgewählt) */
const OFFEN_DOK = (d: EingangDokument) => !['ignoriert', 'abgelegt', 'uebernommen', 'dublette', 'wartet'].includes(d.status);

interface ListeAntwort { zeilen: VorgangZeile[]; letzterAbruf: string | null; schwelle: number | null; postfaecher: EingangsPostfach[] }
/** postfach leer = alle Eingangspostfächer */
async function listeLaden(status: VorgangStatus, postfach = ''): Promise<ListeAntwort> {
  const r = await api.get<unknown>(`${EING}/vorgaenge?status=${status}${postfach ? `&postfach=${encodeURIComponent(postfach)}` : ''}`);
  const o = (r && typeof r === 'object' && !Array.isArray(r) ? r : {}) as { letzter_abruf?: string | null; schwelle?: number | null; postfaecher?: EingangsPostfach[] };
  return {
    zeilen: liste<VorgangZeile>(r, 'vorgaenge', 'zeilen', 'liste'), letzterAbruf: o.letzter_abruf ?? null, schwelle: o.schwelle ?? null,
    postfaecher: Array.isArray(o.postfaecher) ? o.postfaecher : [],
  };
}

export function Posteingang() {
  const can = useCan();
  const edit = can('transport.eingang:edit');
  const klein = useKlein(900);
  const [status, setStatus] = useState<VorgangStatus>('pruefen');
  // Eingangspostfach (info@, buchhaltung@ …), leer = alle; Auswahl nur, wenn es mehr als eines gibt
  const [postfach, setPostfach] = useState('');
  const [postfaecher, setPostfaecher] = useState<EingangsPostfach[]>([]);
  const [zeilen, setZeilen] = useState<VorgangZeile[] | null>(null);
  const [anzahl, setAnzahl] = useState<{ pruefen: number | null; fehler: number | null }>({ pruefen: null, fehler: null });
  const [letzterAbruf, setLetzterAbruf] = useState<string | null>(null);
  const [schwelle, setSchwelle] = useState(SCHWELLE_STANDARD);
  const [gewaehlt, setGewaehlt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stand, setStand] = useState(0);
  // Absenderbaum: Filter nach eigenem Postfach, Domain oder Adresse (gilt nur, solange es den Knoten in der aktuellen Liste gibt)
  const [absFilter, setAbsFilter] = useState<AbsenderFilter>(null);
  const baum = useMemo(() => postfachBaum(zeilen ?? [], postfaecher), [zeilen, postfaecher]);
  const filter = filterGueltig(baum, absFilter) ? absFilter : null;
  const sichtbar = useMemo(() => (zeilen ? absenderFiltern(zeilen, filter) : null), [zeilen, filter]);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // Aufträge für die Auswahl und den Kundennamen – nur wer ablegen darf, braucht sie
  const auftraege = useAuftraege(edit && can('transport.auftraege:display'));

  const laden = useCallback(async () => {
    try {
      // Zähler für „Zu prüfen“ und „Fehler“ immer; die gewählte Liste ist oft eine der beiden
      const [p, f] = await Promise.all([listeLaden('pruefen', postfach), listeLaden('fehler', postfach)]);
      const akt = status === 'pruefen' ? p : status === 'fehler' ? f : await listeLaden(status, postfach);
      setPostfaecher(p.postfaecher);
      setAnzahl({ pruefen: p.zeilen.length, fehler: f.zeilen.length });
      setZeilen(akt.zeilen);
      const abruf = akt.letzterAbruf ?? p.letzterAbruf;
      if (abruf) setLetzterAbruf(abruf);
      const s = akt.schwelle ?? p.schwelle;
      if (s) setSchwelle(s);
      setGewaehlt((g) => (g && akt.zeilen.some((z) => z.id === g) ? g : klein ? null : akt.zeilen[0]?.id ?? null));
    } catch (e) { setError((e as Error).message); setZeilen((z) => z ?? []); }
  }, [status, klein, postfach]);
  useEffect(() => { setZeilen(null); laden(); }, [laden]);

  async function abrufen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<unknown>(`${EING}/abruf`);
      toast(antwortText(r, 'Offene Vorgänge neu bewertet – neue E-Mails erscheinen nach dem Abruf durch n8n'), 5000);
      setLetzterAbruf(new Date().toISOString());
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); await laden(); setStand((s) => s + 1); }
  }

  function waehlen(id: number) {
    setGewaehlt(id);
    if (klein) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  function absenderWaehlen(f: AbsenderFilter) {
    setAbsFilter(f);
    const neu = absenderFiltern(zeilen ?? [], f);
    setGewaehlt((g) => (g && neu.some((z) => z.id === g) ? g : klein ? null : neu[0]?.id ?? null));
  }

  const zaehler = (k: VorgangStatus) => (k === 'pruefen' || k === 'fehler') && anzahl[k] !== null ? ` (${anzahl[k]})` : '';

  return (
    <AppPage title="Posteingang" subtitle="E-Mails aus Outlook den Aufträgen zuordnen und ablegen"
             actions={<>
               <Button design="Transparent" icon="refresh" tooltip="Liste neu laden" onClick={() => { laden(); setStand((s) => s + 1); }} />
               {edit && (
                 <Button design="Emphasized" icon="download" disabled={busy} onClick={abrufen}
                         tooltip="Offene Vorgänge neu bewerten und n8n neue E-Mails aus dem Postfach holen lassen">Posteingang abrufen</Button>
               )}
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', alignItems: 'center', marginBottom: '0.75rem' }}>
        <SegmentedButton onSelectionChange={(e) => { setGewaehlt(null); setStatus((e.detail.selectedItems[0] as HTMLElement).dataset.key as VorgangStatus); }}>
          {FILTER.map((f) => <SegmentedButtonItem key={f.key} data-key={f.key} selected={status === f.key}>{f.text}{zaehler(f.key)}</SegmentedButtonItem>)}
        </SegmentedButton>
        {postfaecher.length > 1 && (
          <Select accessibleName="Eingangspostfach" style={{ width: '14rem' }}
                  onChange={(e) => { setGewaehlt(null); setPostfach((e.detail.selectedOption as HTMLElement).dataset.k ?? ''); }}>
            <Option data-k="" selected={!postfach}>Alle Postfächer</Option>
            {postfaecher.map((p) => <Option key={p.adresse} data-k={p.adresse} selected={postfach === p.adresse} additionalText={p.bezeichnung !== p.adresse ? p.adresse : undefined}>{p.bezeichnung}</Option>)}
          </Select>
        )}
        <Text className="portal-muted portal-small" style={{ marginLeft: 'auto' }}>
          Letzter Abruf: {letzterAbruf ? zeitText(letzterAbruf) : '–'}
        </Text>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: klein ? 'minmax(0, 1fr)' : 'minmax(18rem, 26rem) minmax(0, 1fr)', gap: '1rem', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: 0 }}>
          {zeilen && zeilen.length > 0 && (
            <AbsenderBaum baum={baum} gesamt={zeilen.length} filter={filter} onFilter={absenderWaehlen} anfangsOffen={!klein} />
          )}
          <Liste zeilen={sichtbar} status={status} schwelle={schwelle} gewaehlt={gewaehlt} onWaehlen={waehlen}
                 postfaecher={postfaecher.length > 1 && !postfach ? postfaecher : []} />
        </div>
        <div ref={detailRef} style={{ minWidth: 0 }}>
          {gewaehlt ? (
            <Detail key={`${gewaehlt}-${stand}`} id={gewaehlt} edit={edit} schwelle={schwelle} auftraege={auftraege}
                    darfAblegen={edit && can('transport.auftraege:display')}
                    onGeaendert={() => { laden(); }} onFehler={setError} />
          ) : !klein && zeilen && zeilen.length > 0 ? (
            <Section><Empty>Links eine E-Mail auswählen.</Empty></Section>
          ) : null}
        </div>
      </div>
    </AppPage>
  );
}

// ---------------------------------------------------------------------------- Absenderbaum

/**
 * Baum eigenes Postfach (Info, Buchhaltung …) → Domain → Absenderadresse mit Anzahl der E-Mails in der aktuellen Ansicht;
 * Klick auf einen Knoten filtert die Liste. Die Ebene Postfach erscheint nur, wenn E-Mails aus mehr als einem Postfach da sind.
 */
function AbsenderBaum({ baum, gesamt, filter, onFilter, anfangsOffen }: {
  baum: PostfachKnoten[]; gesamt: number; filter: AbsenderFilter; onFilter: (f: AbsenderFilter) => void; anfangsOffen: boolean;
}) {
  const [offen, setOffen] = useState(anfangsOffen);
  // umgeschaltete Knoten: Postfächer sind anfangs auf-, Domains zugeklappt
  const [umgeschaltet, setUmgeschaltet] = useState<Set<string>>(new Set());
  const umschalten = (k: string) => setUmgeschaltet((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const mitPostfach = baum.length > 1;
  const pKey = (p: string) => `p:${p}`;
  const dKey = (p: string, d: string) => `d:${p}|${d}`;
  const aufgeklappt = (k: string, standard: boolean, imFilter: boolean) => imFilter || (standard !== umgeschaltet.has(k));
  const domains = baum.reduce((n, p) => n + p.domains.length, 0);

  const pfeil = (auf: boolean, k: string) => (
    <span role="button" aria-label={auf ? 'Zuklappen' : 'Aufklappen'} style={{ display: 'inline-flex', cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); umschalten(k); }}>
      <Icon name={auf ? 'navigation-down-arrow' : 'navigation-right-arrow'} style={SYMBOL} />
    </span>
  );
  const knoten = (f: AbsenderFilter, ebene: number, inhalt: React.ReactNode, key: string, vorne: React.ReactNode, aufklappen?: string) => {
    const aktiv = gleicherFilter(filter, f);
    const klick = () => { onFilter(f); if (aufklappen) setUmgeschaltet((s) => { const n = new Set(s); n.add(aufklappen); return n; }); };
    return (
      <div key={key} role="treeitem" aria-selected={aktiv} aria-level={ebene + 1} tabIndex={0}
           onClick={klick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); klick(); } }}
           style={{
             display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.3rem 0.5rem', paddingLeft: `${0.5 + ebene * 1.25}rem`,
             cursor: 'pointer', minWidth: 0, borderTop: '1px solid var(--sapList_BorderColor)',
             background: aktiv ? 'var(--sapList_SelectionBackgroundColor)' : undefined,
             boxShadow: aktiv ? 'inset 3px 0 0 var(--sapSelectedColor)' : undefined,
           }}>
        <span style={{ width: '1rem', flex: 'none', display: 'inline-flex', justifyContent: 'center' }}>{vorne}</span>
        {inhalt}
      </div>
    );
  };
  const anzahl = (n: number) => <Text className="portal-muted portal-small" style={{ whiteSpace: 'nowrap' }}>{n}</Text>;
  const zeile = (text: string, title?: string, fett = false) => (
    <Text style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: fett ? 'bold' : undefined }} title={title}>{text}</Text>
  );

  // Domains und Adressen eines Postfachs; ohne Postfach-Ebene ohne Einrückung und ohne Postfach im Filter
  const domainZweige = (p: PostfachKnoten, ebene: number) => p.domains.flatMap((d) => {
    const pf = mitPostfach ? p.postfach : undefined;
    const k = dKey(p.postfach, d.domain);
    const auf = aufgeklappt(k, false, !!filter?.adresse && filter.domain === d.domain && (!pf || filter.postfach === pf));
    return [
      knoten({ postfach: pf, domain: d.domain }, ebene,
        <>{zeile(d.domain === OHNE_ADRESSE ? d.domain : `@${d.domain}`, d.domain)}{anzahl(d.anzahl)}</>, k, pfeil(auf, k), auf ? undefined : k),
      ...(auf ? d.adressen.map((a) => knoten({ postfach: pf, domain: d.domain, adresse: a.adresse }, ebene + 1,
        <><div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {zeile(a.name || a.adresse, a.adresse)}
          {a.name && <Text className="portal-muted portal-small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.adresse}</Text>}
        </div>{anzahl(a.anzahl)}</>, `a:${p.postfach}|${a.adresse}`, <Icon name="email" style={SYMBOL} />)) : []),
    ];
  });

  return (
    <div className="portal-ad" role="tree" aria-label="Absender">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.75rem' }}>
        <Link onClick={() => setOffen(!offen)}>
          <Icon name={offen ? 'navigation-down-arrow' : 'navigation-right-arrow'} style={{ ...SYMBOL, verticalAlign: 'middle' }} />{' '}
          {mitPostfach ? `Postfächer und Absender (${baum.length} Postfächer)` : `Absender (${domains} ${domains === 1 ? 'Domain' : 'Domains'})`}
        </Link>
        {filter && <Link style={{ marginLeft: 'auto' }} onClick={() => onFilter(null)}>Filter aufheben</Link>}
      </div>
      {offen && (
        <div style={{ maxHeight: '24rem', overflow: 'auto' }}>
          {knoten(null, 0, <>{zeile(mitPostfach ? 'Alle Postfächer' : 'Alle Absender', undefined, true)}{anzahl(gesamt)}</>, '*', <Icon name="group" style={SYMBOL} />)}
          {mitPostfach
            ? baum.flatMap((p) => {
              const k = pKey(p.postfach);
              const auf = aufgeklappt(k, true, !!filter?.domain && filter.postfach === p.postfach);
              return [
                knoten({ postfach: p.postfach }, 1,
                  <>{zeile(p.bezeichnung, p.postfach, true)}{p.bezeichnung !== p.postfach && <Text className="portal-muted portal-small" style={{ whiteSpace: 'nowrap' }}>{p.postfach}</Text>}{anzahl(p.anzahl)}</>,
                  k, pfeil(auf, k)),
                ...(auf ? domainZweige(p, 2) : []),
              ];
            })
            : baum.flatMap((p) => domainZweige(p, 1))}
        </div>
      )}
    </div>
  );
}

/** Symbolgröße im Absenderbaum */
const SYMBOL = { width: '0.85rem', height: '0.85rem' };

// ---------------------------------------------------------------------------- Liste

function Liste({ zeilen, status, schwelle, gewaehlt, onWaehlen, postfaecher }: {
  zeilen: VorgangZeile[] | null; status: VorgangStatus; schwelle: number; gewaehlt: number | null; onWaehlen: (id: number) => void;
  /** mehrere Eingangspostfächer und kein Filter: Bezeichnung des Postfachs je E-Mail anzeigen */
  postfaecher: EingangsPostfach[];
}) {
  if (!zeilen) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  if (!zeilen.length) {
    return (
      <Section><Empty>{status === 'pruefen' ? 'Nichts zu prüfen – alle eingegangenen E-Mails sind zugeordnet.'
        : status === 'fehler' ? 'Keine E-Mails mit Fehler.' : 'Keine E-Mails in dieser Ansicht.'}</Empty></Section>
    );
  }
  return (
    <div className="portal-ad">
      {zeilen.map((z) => {
        const t = treffer(z, schwelle);
        const aktiv = z.id === gewaehlt;
        return (
          <div key={z.id} role="button" tabIndex={0} aria-pressed={aktiv}
               onClick={() => onWaehlen(z.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onWaehlen(z.id); } }}
               style={{
                 display: 'flex', flexDirection: 'column', gap: '0.25rem', padding: '0.6rem 0.75rem', cursor: 'pointer', minWidth: 0,
                 borderTop: '1px solid var(--sapList_BorderColor)',
                 background: aktiv ? 'var(--sapList_SelectionBackgroundColor)' : undefined,
                 boxShadow: aktiv ? 'inset 3px 0 0 var(--sapSelectedColor)' : undefined,
               }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', minWidth: 0 }}>
              <Text style={{ fontWeight: 'bold', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{absender(z)}</Text>
              <Text className="portal-muted portal-small" style={{ whiteSpace: 'nowrap' }}>{zeitText(z.datum)}</Text>
            </div>
            <Text style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{z.betreff || '(ohne Betreff)'}</Text>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <ObjectStatus state={t.state} inverted={t.state !== 'None'}>{t.text}</ObjectStatus>
              {postfaecher.length > 0 && z.postfach && (
                <Text className="portal-muted portal-small" title={z.postfach}>
                  <Icon name="inbox" style={{ width: '0.8rem', height: '0.8rem', verticalAlign: 'middle' }} /> {postfaecher.find((p) => p.adresse === z.postfach)?.bezeichnung ?? z.postfach}
                </Text>
              )}
              {z.anzahl_dokumente > 0 && (
                <Text className="portal-muted portal-small"><Icon name="attachment" style={{ width: '0.8rem', height: '0.8rem', verticalAlign: 'middle' }} /> {z.anzahl_dokumente}</Text>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------- Detail

function Detail({ id, edit, darfAblegen, schwelle: schwelleListe, auftraege, onGeaendert, onFehler }: {
  id: number; edit: boolean; darfAblegen: boolean; schwelle: number; auftraege: ReturnType<typeof useAuftraege>;
  onGeaendert: () => void; onFehler: (t: string) => void;
}) {
  const [v, setV] = useState<Vorgang | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nr, setNr] = useState('');
  const [auswahl, setAuswahl] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [frage, setFrage] = useState(false);
  const [pdf, setPdf] = useState<EingangDokument | null>(null);
  const [textOffen, setTextOffen] = useState(true);
  // Detail neben der Liste: unter etwa 1100 px Fensterbreite Anhänge über der E-Mail statt links daneben
  const schmal = useKlein(1100);

  const laden = useCallback(async () => {
    try {
      const x = await api.get<Vorgang>(`${EING}/vorgaenge/${id}`);
      const dok = Array.isArray(x.dokumente) ? x.dokumente : [];
      const kand = Array.isArray(x.kandidaten) ? x.kandidaten : [];
      setV({ ...x, dokumente: dok, kandidaten: kand, begruendung: Array.isArray(x.begruendung) ? x.begruendung : [] });
      setNr(x.auftragsnr ?? (kand.length === 1 ? kand[0].auftragsnr : ''));
      setAuswahl(new Set(dok.filter(OFFEN_DOK).map((d) => d.id)));
    } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { laden(); }, [laden]);

  if (error) return <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>;
  if (!v) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;

  const schwelle = v.schwelle ?? schwelleListe;
  const offen = v.status === 'pruefen' || v.status === 'fehler';
  const kandidaten = v.kandidaten ?? [];
  const begruendung = v.begruendung ?? [];
  const punkte = v.punkte ?? 0;
  const kunde = (n: string | null | undefined) => kandidaten.find((k) => k.auftragsnr === n)?.kunde ?? kundeVon(auftraege, n);
  const nrGueltig = !!nr && (!auftraege || !auftraege.length || auftraege.some((a) => a.auftragsnr === nr));

  async function aktion(f: () => Promise<unknown>, sonst: string, danach: 'neu' | 'liste') {
    setBusy(true); setError(null);
    try {
      toast(antwortText(await f(), sonst), 5000);
      onGeaendert();
      if (danach === 'neu') await laden();
    } catch (e) { onFehler((e as Error).message); } finally { setBusy(false); }
  }
  const ablegen = () => aktion(() => api.post(`${EING}/vorgaenge/${v.id}/ablegen`, { auftragsnr: nr, dokumente: [...auswahl] }),
    `${auswahl.size} Datei(en) am Auftrag ${nr} abgelegt`, 'neu');
  const neuBewerten = () => aktion(() => api.post(`${EING}/vorgaenge/${v.id}/neu-bewerten`), 'Zuordnung neu berechnet', 'neu');
  const ignorieren = () => aktion(() => api.post(`${EING}/vorgaenge/${v.id}/ignorieren`), 'E-Mail ignoriert', 'neu');

  const vorschau = (d: EingangDokument) => {
    if (istPdf(d)) setPdf(d);
    else window.open(dateiUrl(d.id), '_blank', 'noopener');
  };
  const umschalten = (d: EingangDokument, an: boolean) => {
    const s = new Set(auswahl);
    if (an) s.add(d.id); else s.delete(d.id);
    setAuswahl(s);
  };

  const zuordnungState = v.auftragsnr ? (punkte >= schwelle ? 'Positive' : 'Critical') : kandidaten.length ? 'Critical' : 'None';

  return (
    <Section title={v.betreff || '(ohne Betreff)'}
             status={<ObjectStatus state={v.status === 'fehler' ? 'Negative' : v.status === 'abgelegt' ? 'Positive' : v.status === 'pruefen' ? 'Critical' : 'None'}>{STATUS_TEXT[v.status] ?? v.status}</ObjectStatus>}>
      {/* links die Anhänge, rechts die E-Mail (Kopf, Zuordnung, Text, Aktionen); schmal untereinander, Anhänge zuerst */}
      <div style={{ display: 'grid', gridTemplateColumns: schmal ? 'minmax(0, 1fr)' : 'minmax(13rem, 17rem) minmax(0, 1fr)', gap: '1rem', alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0 }}>
        <Label>Anhänge und Dokumente ({v.dokumente.length})</Label>
        {!v.dokumente.length ? <Text className="portal-muted">Keine Anhänge.</Text> : v.dokumente.map((d) => (
          <DokumentKarte key={d.id} d={d} waehlbar={offen && darfAblegen && OFFEN_DOK(d)} gewaehlt={auswahl.has(d.id)}
                         onWahl={(an) => umschalten(d, an)} vorschau={edit ? () => vorschau(d) : null} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: 0 }}>
        <div className="portal-small" style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '0.15rem 0.75rem' }}>
          <Label>Von</Label><Text style={{ overflowWrap: 'anywhere' }}>{v.von_name ? `${v.von_name} <${v.von ?? ''}>` : v.von ?? '–'}</Text>
          {v.an && <><Label>An</Label><Text style={{ overflowWrap: 'anywhere' }}>{v.an}</Text></>}
          <Label>Datum</Label><Text>{v.datum ? `${dat(v.datum)} ${new Date(v.datum).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : '–'}</Text>
        </div>
        {v.hinweis && <MessageStrip hideCloseButton design={v.status === 'fehler' ? 'Negative' : 'Information'}>{v.hinweis}</MessageStrip>}

        {/* Zuordnung mit Trefferwert und Begründung */}
        <div style={{ border: '1px solid var(--sapList_BorderColor)', borderRadius: 'var(--portal-radius, 0.75rem)', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', alignItems: 'center' }}>
            <Text style={{ fontWeight: 'bold' }}>
              {v.auftragsnr ? `Zuordnung: Auftrag ${v.auftragsnr}${kunde(v.auftragsnr) ? ` – ${kunde(v.auftragsnr)}` : ''}`
                : kandidaten.length > 1 ? `Zuordnung nicht eindeutig: ${kandidaten.length} Kandidaten`
                  : kandidaten.length === 1 ? `Kandidat: Auftrag ${kandidaten[0].auftragsnr}${kunde(kandidaten[0].auftragsnr) ? ` – ${kunde(kandidaten[0].auftragsnr)}` : ''}`
                    : 'Kein passender Auftrag gefunden'}
            </Text>
            <ObjectStatus state={zuordnungState} inverted={zuordnungState !== 'None'}>Trefferwert {punkte} / Schwelle {schwelle}</ObjectStatus>
          </div>
          {begruendung.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
              {begruendung.map((b, i) => <li key={i}><Text className="portal-small">{b.grund} <span className="portal-muted">(+{b.punkte})</span></Text></li>)}
            </ul>
          )}
          {kandidaten.length > 0 && !(kandidaten.length === 1 && kandidaten[0].auftragsnr === v.auftragsnr) && (
            <Kandidaten kandidaten={kandidaten} gewaehlt={nr} kunde={kunde} waehlbar={offen && darfAblegen} onWaehlen={setNr} />
          )}
          {offen && darfAblegen && (
            <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 22rem)', gap: '0.5rem 0.75rem', alignItems: 'center' }}>
              <Label required>Auftrag</Label>
              <AuftragWahl wert={nr} onChange={setNr} auftraege={auftraege} disabled={busy} />
            </div>
          )}
          {offen && edit && !darfAblegen && <Text className="portal-muted portal-small">Zum Ablegen fehlt das Recht, Aufträge anzuzeigen.</Text>}
        </div>

        {v.text && (
          <div>
            <Link onClick={() => setTextOffen(!textOffen)}>{textOffen ? 'Text der E-Mail ausblenden' : 'Text der E-Mail anzeigen'}</Link>
            {textOffen && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: '0.5rem 0 0', maxHeight: '24rem', overflow: 'auto' }}>{v.text}</pre>}
          </div>
        )}

        {edit && offen && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <Button design="Transparent" icon="decline" disabled={busy} onClick={() => setFrage(true)}>Ignorieren</Button>
            <Button design="Transparent" icon="synchronize" disabled={busy} tooltip="Zuordnung neu berechnen (z. B. nachdem der Auftrag angelegt wurde)" onClick={neuBewerten}>Neu bewerten</Button>
            {darfAblegen && (
              <Button design="Emphasized" icon="accept" disabled={busy || !nrGueltig || !auswahl.size} onClick={ablegen}
                      tooltip={!nr ? 'Bitte einen Auftrag wählen' : !nrGueltig ? `Auftrag ${nr} gibt es nicht` : !auswahl.size ? 'Bitte mindestens eine Datei auswählen' : undefined}>
                Am Auftrag ablegen
              </Button>
            )}
          </div>
        )}
      </div>
      </div>
      <ConfirmDialog open={frage} title="E-Mail ignorieren" confirmText="Ignorieren" danger
                     text="Die E-Mail und ihre Anhänge werden nicht abgelegt; die Inhalte werden im Portal gelöscht. Die E-Mail selbst bleibt im Outlook-Postfach."
                     onCancel={() => setFrage(false)} onConfirm={() => { setFrage(false); ignorieren(); }} />
      {pdf && <PdfDialog url={dateiUrl(pdf.id)} title={pdf.datei} filename={pdf.datei || 'dokument.pdf'} onClose={() => setPdf(null)} />}
    </Section>
  );
}

function Kandidaten({ kandidaten, gewaehlt, kunde, waehlbar, onWaehlen }: {
  kandidaten: Kandidat[]; gewaehlt: string; kunde: (nr: string) => string | null; waehlbar: boolean; onWaehlen: (nr: string) => void;
}) {
  return (
    <div className="portal-ad">
      {kandidaten.map((k) => (
        <div key={k.auftragsnr} className="portal-ad__zeile">
          <Icon name={k.auftragsnr === gewaehlt ? 'accept' : 'shipping-status'} />
          <div style={{ minWidth: 0 }}>
            <Text><b>{k.auftragsnr}</b>{kunde(k.auftragsnr) ? ` – ${kunde(k.auftragsnr)}` : ''}</Text>
            <div className="portal-muted portal-small">
              {[k.datum ? dat(k.datum) : '', k.punkte != null ? `${k.punkte} Punkte` : ''].filter(Boolean).join(' · ')}
            </div>
            {/* je Grund eine Zeile – mit Herkunft (Betreff, Mailtext, Dateiname, PDF mit Textausschnitt) */}
            {(k.begruendung ?? []).map((b, i) => (
              <div key={i} className="portal-small" style={{ overflowWrap: 'anywhere' }}>{b.grund} <span className="portal-muted">(+{b.punkte})</span></div>
            ))}
          </div>
          {waehlbar && (k.auftragsnr === gewaehlt
            ? <Text className="portal-small">gewählt</Text>
            : <Button design="Transparent" onClick={() => onWaehlen(k.auftragsnr)}>Wählen</Button>)}
        </div>
      ))}
    </div>
  );
}

function DokumentKarte({ d, waehlbar, gewaehlt, onWahl, vorschau }: {
  d: EingangDokument; waehlbar: boolean; gewaehlt: boolean; onWahl: (an: boolean) => void; vorschau: (() => void) | null;
}) {
  const [mehr, setMehr] = useState(false);
  const ocr = (d.ocr_auszug ?? '').trim();
  const name = d.art === 'mail' ? `E-Mail als PDF (${d.datei})` : d.datei;
  // Inhalte gibt es nur, solange das Dokument nicht abgelegt, übernommen oder ignoriert ist
  const vorhanden = !['ignoriert', 'uebernommen', 'dublette'].includes(d.status) && !(d.status === 'abgelegt' && d.ziel === 'paperless');
  return (
    <div style={{
      border: `1px solid ${gewaehlt ? 'var(--sapSelectedColor)' : 'var(--sapList_BorderColor)'}`, borderRadius: 'var(--portal-radius, 0.75rem)',
      padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', minWidth: 0 }}>
        {waehlbar
          ? <CheckBox checked={gewaehlt} onChange={(e) => onWahl(e.target.checked)} accessibleName={`${name} ablegen`} />
          : <Icon name={istPdf(d) ? 'pdf-attachment' : 'document'} style={{ margin: '0 0.5rem' }} />}
        <Text style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name}</Text>
      </div>
      <Text className="portal-muted portal-small">
        {groesse(d.groesse)} · {STATUS_TEXT[d.status] ?? d.status}{d.ziel ? ` · Ziel ${d.ziel === 'lokal' ? 'Ablageordner' : d.ziel === 'paperless' ? 'Paperless' : d.ziel}` : ''}
      </Text>
      {ocr && (
        <Text className="portal-small" style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          <span className="portal-muted">OCR: </span>{mehr || ocr.length <= 160 ? ocr : `${ocr.slice(0, 160)} …`}
          {ocr.length > 160 && <> <Link onClick={() => setMehr(!mehr)}>{mehr ? 'weniger' : 'mehr'}</Link></>}
        </Text>
      )}
      {vorschau && vorhanden && <Link onClick={vorschau}>Vorschau</Link>}
    </div>
  );
}
