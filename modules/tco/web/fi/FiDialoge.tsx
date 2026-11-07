import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, Button, CheckBox, ComboBox, ComboBoxItem, ComboBoxItemGroup, Dialog, FlexBox, Input, Label, Link,
  List, ListItemStandard, MessageStrip, ObjectStatus, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { usePdf } from '@core/components/PdfDialog';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { useSession } from '@core/session';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import { F, betragFarbe, type Beleg, type Konto, type Zeile } from './typen';

const portal = (n: React.ReactNode) => createPortal(n, document.body);
const meldung = (r: { text?: string; warnungen?: string[] }) => {
  toast(r.text ?? 'Gespeichert');
  if (r.warnungen?.length) alertWarn(r.warnungen);
};
let warnHandler: ((w: string[]) => void) | null = null;
const alertWarn = (w: string[]) => warnHandler?.(w);
/** Paperless-Warnungen der letzten Aktion (E15: Fehler nicht verschlucken) */
export function useWarnungen() {
  const [w, setW] = useState<string[]>([]);
  useEffect(() => { warnHandler = setW; return () => { warnHandler = null; }; }, []);
  return { warnungen: w, schliessen: () => setW([]) };
}

// ---------------------------------------------------------------- Kontoauswahl
export function KontoBox({ konten, value, onChange, placeholder = 'Konto suchen …', alle, ohne, disabled, style }: {
  konten: Konto[]; value: string; onChange: (k: string) => void; placeholder?: string; alle?: boolean; ohne?: string;
  disabled?: boolean; style?: React.CSSProperties;
}) {
  const gruppen = useMemo(() => {
    const m = new Map<string, Konto[]>();
    for (const k of konten) if (k.konto !== ohne && (k.aktiv || k.konto === value)) m.set(k.gruppe, [...(m.get(k.gruppe) ?? []), k]);
    return [...m];
  }, [konten, ohne, value]);
  const text = (k: Konto) => `${k.konto} – ${k.name}`;
  const akt = konten.find((k) => k.konto === value);
  return (
    <ComboBox
      value={value ? (akt ? text(akt) : value) : alle ? '– alle Konten –' : ''}
      placeholder={placeholder}
      disabled={disabled}
      filter="Contains"
      style={style}
      onSelectionChange={(e) => {
        const t = (e.detail.item as HTMLElement & { text?: string } | null)?.text ?? '';
        onChange(t.startsWith('–') ? '' : t.split(' ')[0]);
      }}
      onChange={(e) => {
        const t = (e.target as unknown as { value: string }).value.trim();
        if (!t) onChange('');
        else if (/^\d+$/.test(t) && konten.some((k) => k.konto === t)) onChange(t);
      }}
    >
      {alle && <ComboBoxItem text="– alle Konten –" />}
      {gruppen.map(([g, ks]) => (
        <ComboBoxItemGroup key={g} headerText={g}>
          {ks.map((k) => <ComboBoxItem key={k.konto} text={text(k)} additionalText={k.aktiv ? '' : 'nicht in Verwendung'} />)}
        </ComboBoxItemGroup>
      ))}
    </ComboBox>
  );
}

// ---------------------------------------------------------------- PDF-Vorschau eines Paperless-Belegs
export function BelegVorschau({ id, hoehe = '60vh' }: { id: number | null; hoehe?: string }) {
  const { blobUrl, error } = usePdf(id ? `${F}/belege/${id}/pdf` : null);
  if (!id) return <FlexBox alignItems="Center" justifyContent="Center" style={{ height: hoehe, color: 'var(--sapContent_LabelColor)' }}>Keine Vorschau</FlexBox>;
  if (error) return <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>;
  return blobUrl
    ? <iframe title={`Beleg ${id}`} src={blobUrl} style={{ width: '100%', height: hoehe, border: '1px solid var(--sapList_BorderColor)' }} />
    : <FlexBox alignItems="Center" justifyContent="Center" style={{ height: hoehe }}>Beleg wird geladen …</FlexBox>;
}

// ---------------------------------------------------------------- Belege zuordnen (offene Paperless-Belege, per ID)
export function ZuordnenDialog({ open, ziele, titel, vorauswahl = [], onPick, onClose, onDone }: {
  open: boolean; ziele: string[]; titel: string; vorauswahl?: number[];
  /** Bankimport: Auswahl nur übernehmen, gebucht wird später */
  onPick?: (ids: number[], belege: Beleg[]) => void;
  onClose: () => void; onDone?: () => void;
}) {
  const [belege, setBelege] = useState<Beleg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [vorschau, setVorschau] = useState<number | null>(null);
  const [suche, setSuche] = useState('');
  const [idEingabe, setIdEingabe] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBelege(null); setError(null); setHinweis(null); setSuche(''); setIdEingabe('');
    setSel(new Set(vorauswahl)); setVorschau(vorauswahl[0] ?? null);
    api.get<Beleg[]>(`${F}/belege/offen`)
      .then(async (l) => {
        // vorausgewählte, nicht offene Belege (Dauerbeleg) ergänzen
        const fehlend = vorauswahl.filter((id) => !l.some((b) => b.id === id));
        const extra = await Promise.all(fehlend.map((id) => api.get<Beleg>(`${F}/belege/${id}`).catch(() => null)));
        setBelege([...(extra.filter(Boolean) as Beleg[]), ...l]);
      })
      .catch((e) => { setError(e.message); setBelege([]); });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function perId() {
    const id = Number(idEingabe.replace(/\D/g, ''));
    if (!id || idEingabe.replace(/\D/g, '').length > 6) { setHinweis('Bitte eine Paperless-ID (bis 6 Ziffern) eingeben'); return; }
    setHinweis(null);
    try {
      const b = belege?.find((x) => x.id === id) ?? await api.get<Beleg>(`${F}/belege/${id}`);
      setBelege((l) => (l?.some((x) => x.id === id) ? l : [b, ...(l ?? [])]));
      setSel((s) => new Set(s).add(id));
      setVorschau(id);
      setIdEingabe('');
      if (b.zugeordnet?.length) setHinweis(`Dokument ${id} ist bereits zugeordnet zu ${b.zugeordnet.join(', ')}`);
    } catch (e) {
      setHinweis((e as Error).message);
    }
  }

  async function zuordnen() {
    const ids = [...sel];
    if (onPick) { onPick(ids, (belege ?? []).filter((b) => sel.has(b.id))); onClose(); return; }
    setBusy(true);
    try {
      meldung(await api.post(`${F}/belege/zuordnen`, { internenr: ziele, doks: ids }));
      onDone?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const gefiltert = (belege ?? []).filter((b) => !suche || `${b.titel} ${b.korrespondent} ${b.id}`.toLowerCase().includes(suche.toLowerCase()));
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: '', id: 'sel', width: 50, disableSortBy: true,
      Cell: ({ row }: Cell) => <CheckBox checked={sel.has(row.original.id)} onChange={(e) => {
        const s = new Set(sel);
        if (e.target.checked) s.add(row.original.id); else s.delete(row.original.id);
        setSel(s);
      }} /> },
    { Header: 'Korrespondent', accessor: 'korrespondent', width: 150 },
    { Header: 'Titel', accessor: 'titel', minWidth: 160 },
    { Header: 'Datum', accessor: 'datum', width: 95, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'ID', accessor: 'id', width: 65 },
    { Header: 'Betrag', accessor: 'betrag', width: 95, hAlign: 'End', Cell: ({ value }: Cell) => (value === null ? '' : eur(value)) },
  ];

  return portal(
    <Dialog open={open} headerText={titel} onClose={onClose} resizable style={{ width: '94vw', height: '90vh' }}
            footer={<Bar startContent={<Text>{sel.size} Dokument(e) ausgewählt</Text>} endContent={<>
              <Button design="Emphasized" disabled={!sel.size && !onPick} loading={busy} onClick={zuordnen}>{onPick ? 'Übernehmen' : 'Zuordnen'}</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FlexBox style={{ gap: '1rem', height: '100%' }}>
        <div style={{ flex: '1 1 55%', minWidth: 0 }}>
          <FlexBox style={{ gap: '0.5rem', marginBottom: '0.5rem' }} wrap="Wrap" alignItems="Center">
            <Input placeholder="Titel oder Korrespondent suchen …" value={suche} onInput={(e) => setSuche(e.target.value)} style={{ width: '16rem' }} icon={null as never} />
            <Input placeholder="Paperless-Dokument-ID" value={idEingabe} style={{ width: '12rem' }}
                   onInput={(e) => setIdEingabe(e.target.value)} onChange={() => idEingabe && perId()} />
            <Button icon="add" onClick={perId}>Per ID hinzufügen</Button>
          </FlexBox>
          {hinweis && <MessageStrip design="Information" onClose={() => setHinweis(null)} style={{ marginBottom: '0.5rem' }}>{hinweis}</MessageStrip>}
          <AnalyticalTable
            columns={columns} data={gefiltert} loading={!belege} sortable
            visibleRows={Math.max(gefiltert.length, 3)}
            noDataText="Keine nicht zugeordneten Dokumente vorhanden – Beleg per ID hinzufügen"
            onRowClick={(e) => setVorschau(e.detail.row.original.id)}
            markNavigatedRow={(r) => r.original.id === vorschau}
          />
        </div>
        <div style={{ flex: '1 1 45%', minWidth: 0 }}>
          <BelegVorschau id={vorschau} hoehe="calc(90vh - 9rem)" />
        </div>
      </FlexBox>
    </Dialog>,
  );
}

// ---------------------------------------------------------------- Belege einer Buchung (Vorschau, Notizen, entfernen)
interface BuchungInfo {
  internenr: string; belege: number[]; storniertDurch: string | null;
  zeilen: { konto: string; konto_name: string; posnr: number; datum: string; text: string; betrag: number; gkonto: string; belnr: string; rgnr_txt: string | null }[];
  notizen: { id: string; notiz: string; erstellt_von: string; erstellt_am: string }[];
}

export function BelegeDialog({ internenr, edit, onClose, onChanged }: {
  internenr: string | null; edit: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [b, setB] = useState<BuchungInfo | null>(null);
  const [akt, setAkt] = useState<number | null>(null);
  const [notizen, setNotizen] = useState<{ notizen: { id: number; note: string; created: string; user?: any }[]; url: string } | null>(null);
  const [zuordnen, setZuordnen] = useState(false);
  const [entfernen, setEntfernen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const laden = () => internenr && api.get<BuchungInfo>(`${F}/buchung/${internenr}`).then((r) => {
    setB(r);
    setAkt((a) => (a && r.belege.includes(a) ? a : r.belege[0] ?? null));
  }).catch((e) => setError(e.message));
  useEffect(() => { setB(null); setError(null); setAkt(null); if (internenr) laden(); }, [internenr]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setNotizen(null);
    if (akt) api.get<typeof notizen>(`${F}/belege/${akt}/notizen`).then(setNotizen).catch(() => setNotizen(null));
  }, [akt]);

  const k = b?.zeilen[0];
  return portal(<>
    <Dialog open={!!internenr} headerText={`Belege zu Buchung ${internenr ?? ''} (${b?.belege.length ?? 0})`} onClose={onClose} resizable
            style={{ width: '92vw', height: '90vh' }}
            footer={<Bar endContent={<>
              {edit && <Button icon="attachment" onClick={() => setZuordnen(true)}>Beleg zuordnen</Button>}
              <Button onClick={onClose}>Schließen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      <FlexBox style={{ gap: '1rem', height: '100%' }}>
        <div style={{ flex: '0 0 20rem' }}>
          {k && (
            <div style={{ marginBottom: '1rem', lineHeight: 1.6 }}>
              <Title level="H6">{k.text}</Title>
              <Text>{dat(k.datum)} · Beleg {k.belnr || '–'} · Konto {k.konto} {k.konto_name}</Text><br />
              <ObjectStatus state={betragFarbe(k.konto, k.betrag)}>{eur(k.betrag)}</ObjectStatus>
              {b?.storniertDurch && <><br /><ObjectStatus state="Negative">storniert durch {b.storniertDurch}</ObjectStatus></>}
            </div>
          )}
          <List headerText="Paperless-Dokumente" noDataText="Keine Belege zugeordnet" selectionMode="Single"
                onItemClick={(e) => setAkt(Number((e.detail.item as HTMLElement).dataset.id))}>
            {(b?.belege ?? []).map((id) => (
              <ListItemStandard key={id} data-id={id} selected={id === akt} text={`Dokument ${id}`}
                                additionalText={edit ? 'entfernen' : ''} />
            ))}
          </List>
          {edit && akt && <Button design="Transparent" icon="delete" style={{ marginTop: '0.5rem' }} onClick={() => setEntfernen(akt)}>Beleg {akt} von der Buchung entfernen</Button>}
          {notizen && (
            <div style={{ marginTop: '1rem' }}>
              <FlexBox justifyContent="SpaceBetween" alignItems="Center">
                <Title level="H6">Notizen zu Dokument {akt} ({notizen.notizen.length})</Title>
                <Link href={notizen.url} target="_blank">In Paperless öffnen</Link>
              </FlexBox>
              {notizen.notizen.map((n) => (
                <div key={n.id} style={{ borderBottom: '1px solid var(--sapList_BorderColor)', padding: '0.4rem 0' }}>
                  <Text>{n.note}</Text><br />
                  <Label>{new Date(n.created).toLocaleString('de-DE')}{typeof n.user === 'object' && n.user?.username ? ` · ${n.user.username}` : ''}</Label>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}><BelegVorschau id={akt} hoehe="calc(90vh - 7rem)" /></div>
      </FlexBox>
    </Dialog>
    <ZuordnenDialog open={zuordnen} ziele={internenr ? [internenr] : []} titel={`Dokumente zuordnen – Buchung ${internenr}`}
                    onClose={() => setZuordnen(false)} onDone={() => { laden(); onChanged(); }} />
    <ConfirmDialog open={!!entfernen} danger askReason title={`Beleg ${entfernen} entfernen`}
                   text={`Die Zuordnung von Dokument ${entfernen} zu Buchung ${internenr} wird aufgehoben. Die Begründung wird als Notiz an der Buchung gespeichert.`}
                   confirmText="Entfernen" onCancel={() => setEntfernen(null)}
                   onConfirm={async (grund) => {
                     const d = entfernen;
                     setEntfernen(null);
                     try { meldung(await api.post(`${F}/belege/entfernen`, { internenr, dok: d, grund })); laden(); onChanged(); } catch (e) { setError((e as Error).message); }
                   }} />
  </>);
}

// ---------------------------------------------------------------- Storno
export function StornoDialog({ zeile, onClose, onDone }: { zeile: Zeile | null; onClose: () => void; onDone: (text: string) => void }) {
  const [grund, setGrund] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setGrund(''); setError(null); }, [zeile]);
  async function ok() {
    setBusy(true);
    try {
      const r = await api.post<{ text: string }>(`${F}/storno`, { internenr: zeile!.internenr, grund });
      onDone(r.text);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return portal(
    <Dialog open={!!zeile} headerText={`Buchung ${zeile?.internenr ?? ''} stornieren`} state="Negative" onClose={onClose}
            style={{ width: 'min(36rem, 95vw)' }}
            footer={<Bar endContent={<>
              <Button design="Negative" disabled={!grund.trim()} loading={busy} onClick={ok}>Stornieren</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {zeile && <>
        {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
        <Text>{dat(zeile.datum)} · {eur(zeile.betrag)} · {zeile.text}</Text><br />
        <Text>Gegenkonto: {zeile.gkonto} {zeile.gkontoName}</Text>
        <MessageStrip hideCloseButton style={{ margin: '0.75rem 0' }}>
          Es wird eine Gegenbuchung mit identischem Datum und Betrag erzeugt (alle Positionen der Buchung, Soll/Haben vertauscht).
          {zeile.rgnr_txt ? ` Die Zahlung zu Rechnung ${zeile.rgnr_txt} wird zurückgenommen.` : ''}
        </MessageStrip>
        <Label required>Stornogrund (wird an beiden Buchungen als Notiz gespeichert)</Label>
        <TextArea rows={3} value={grund} placeholder="z. B. Doppelbuchung, falsches Gegenkonto …" maxlength={200}
                  onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} />
      </>}
    </Dialog>,
  );
}

// ---------------------------------------------------------------- Notizen zur Buchung
export function NotizenDialog({ zeile, onClose, onChanged }: { zeile: Zeile | null; onClose: () => void; onChanged: () => void }) {
  const { me } = useSession();
  const ich = me.user.displayName || me.user.username;
  const [b, setB] = useState<BuchungInfo | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const laden = () => zeile?.internenr && api.get<BuchungInfo>(`${F}/buchung/${zeile.internenr}`).then(setB).catch((e) => setError(e.message));
  useEffect(() => { setB(null); setText(''); setError(null); laden(); }, [zeile]); // eslint-disable-line react-hooks/exhaustive-deps
  async function speichern() {
    try {
      await api.post(`${F}/notiz`, { internenr: zeile!.internenr, text });
      setText('');
      laden(); onChanged();
    } catch (e) { setError((e as Error).message); }
  }
  async function loeschen(id: string) {
    try { await api.del(`${F}/notiz`, { internenr: zeile!.internenr, id }); laden(); onChanged(); } catch (e) { setError((e as Error).message); }
  }
  return portal(
    <Dialog open={!!zeile} headerText={`Notizen zur Buchung ${zeile?.internenr ?? ''}`} onClose={onClose} style={{ width: 'min(40rem, 95vw)' }}
            footer={<Bar endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      {zeile && <Text>{dat(zeile.datum)} · {eur(zeile.betrag)} · {zeile.text}</Text>}
      {error && <MessageStrip design="Negative" hideCloseButton style={{ margin: '0.5rem 0' }}>{error}</MessageStrip>}
      <FlexBox style={{ gap: '0.5rem', margin: '0.75rem 0' }}>
        <Input value={text} maxlength={255} placeholder="Kurze Notiz zur Buchung …" style={{ flex: 1 }}
               onInput={(e) => setText(e.target.value)} onChange={() => text.trim() && speichern()} />
        <Button design="Emphasized" disabled={!text.trim()} onClick={speichern}>Speichern</Button>
      </FlexBox>
      {(b?.notizen ?? []).map((n) => (
        <FlexBox key={n.id} justifyContent="SpaceBetween" alignItems="Start" style={{ borderBottom: '1px solid var(--sapList_BorderColor)', padding: '0.5rem 0' }}>
          <div><Text>{n.notiz}</Text><br /><Label>{n.erstellt_von} · {new Date(n.erstellt_am).toLocaleString('de-DE')}</Label></div>
          {n.erstellt_von === ich && <Button design="Transparent" icon="delete" onClick={() => loeschen(n.id)}>Löschen</Button>}
        </FlexBox>
      ))}
      {b && !b.notizen.length && <Text>Noch keine Notizen</Text>}
    </Dialog>,
  );
}

// ---------------------------------------------------------------- Teilzahlungen
interface RgZahlung { rgnr_txt: string; kunde: string; betrag: number; gezahlt: number; offen: number; zahlungen: { beleg: string; datum: string | null; text: string; betrag: number }[] }
export function ZahlungenDialog({ rgnr, open, onClose }: { rgnr: string | null; open: boolean; onClose: () => void }) {
  const [l, setL] = useState<RgZahlung[] | null>(null);
  useEffect(() => { if (open) { setL(null); api.get<RgZahlung[]>(`${F}/zahlungen${qs({ rgnr })}`).then(setL); } }, [open, rgnr]);
  return portal(
    <Dialog open={open} headerText={rgnr ? `Zahlungen zu Rechnung ${rgnr}` : 'Teilzahlungen offener Hallenrechnungen'} onClose={onClose}
            style={{ width: 'min(48rem, 95vw)' }} footer={<Bar endContent={<Button onClick={onClose}>Schließen</Button>} />}>
      {l && !l.length && <Text>Keine Teilzahlungen vorhanden</Text>}
      {(l ?? []).map((r) => (
        <div key={r.rgnr_txt} style={{ marginBottom: '1rem' }}>
          <Title level="H6">{r.rgnr_txt} – {r.kunde} · Gesamt {eur(r.betrag)} · gezahlt {eur(r.gezahlt)} · {r.offen >= 0 ? `offen ${eur(r.offen)}` : `Überzahlung ${eur(-r.offen)}`}</Title>
          {r.zahlungen.map((z) => (
            <FlexBox key={z.beleg} justifyContent="SpaceBetween" style={{ padding: '0.25rem 0', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
              <Text>{z.beleg} · {dat(z.datum)} · {z.text}</Text><Text>{eur(z.betrag)}</Text>
            </FlexBox>
          ))}
        </div>
      ))}
    </Dialog>,
  );
}

// ---------------------------------------------------------------- Gegenkonto-Historie: Beleg einer früheren Zahlung übernehmen
interface Hist { internenr: string; konto: string; datum: string; text: string; belnr: string; betrag: number; belege: string }
export function GegenkontoDialog({ zeile, onClose, onDone }: { zeile: Zeile | null; onClose: () => void; onDone: () => void }) {
  const [l, setL] = useState<Hist[] | null>(null);
  const [nurBeleg, setNurBeleg] = useState(true);
  const [gleich, setGleich] = useState(true);
  const [wahl, setWahl] = useState<Hist | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setL(null); setWahl(null); setError(null);
    if (zeile?.gkonto && zeile.internenr) {
      api.get<Hist[]>(`${F}/gegenkonto${qs({ gkonto: zeile.gkonto, internenr: zeile.internenr })}`).then((h) => {
        setL(h);
        // ohne Treffer mit gleichem Betrag: Betragsfilter aus
        setGleich(h.some((x) => x.belege && Math.abs(x.betrag) === Math.abs(zeile.betrag)));
      }).catch((e) => setError(e.message));
    }
  }, [zeile]);
  const gefiltert = (l ?? []).filter((h) => (!nurBeleg || h.belege) && (!gleich || Math.abs(h.betrag) === Math.abs(zeile?.betrag ?? 0)));
  const ersterBeleg = wahl?.belege ? Number(wahl.belege.split(',')[0]) : null;
  async function verknuepfen() {
    try {
      meldung(await api.post(`${F}/belege/uebernehmen`, { internenr: zeile!.internenr, von: wahl!.internenr }));
      onDone(); onClose();
    } catch (e) { setError((e as Error).message); }
  }
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'interne Nr.', accessor: 'internenr', width: 110 },
    { Header: 'Beleg', accessor: 'belnr', width: 70 },
    { Header: 'Datum', accessor: 'datum', width: 95, Cell: ({ value }: Cell) => dat(value) },
    { Header: 'Beschreibung', accessor: 'text', minWidth: 160 },
    { Header: 'Konto', accessor: 'konto', width: 70 },
    { Header: 'Betrag', accessor: 'betrag', width: 100, hAlign: 'End', Cell: ({ value }: Cell) => eur(value) },
    { Header: 'Paperless', accessor: 'belege', width: 110 },
  ];
  return portal(
    <Dialog open={!!zeile} resizable style={{ width: '92vw', height: '88vh' }} onClose={onClose}
            headerText={`${zeile?.gkonto ?? ''} ${zeile?.gkontoName ?? ''} – letzte 12 Monate, Referenzbetrag ${eur(Math.abs(zeile?.betrag ?? 0))}`}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={!wahl?.belege} onClick={verknuepfen}>Beleg verknüpfen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
      <MessageStrip hideCloseButton style={{ marginBottom: '0.5rem' }}>
        Die Belege der gewählten Buchung werden zusätzlich mit Buchung {zeile?.internenr} verknüpft (z. B. Vertrag einer wiederkehrenden Zahlung).
      </MessageStrip>
      <FlexBox style={{ gap: '1rem', marginBottom: '0.5rem' }}>
        <CheckBox text="Nur Buchungen mit Paperless-Beleg" checked={nurBeleg} onChange={(e) => setNurBeleg(e.target.checked)} />
        <CheckBox text="Nur Buchungen mit identischem Betrag" checked={gleich} onChange={(e) => setGleich(e.target.checked)} />
      </FlexBox>
      <FlexBox style={{ gap: '1rem' }}>
        <div style={{ flex: '1 1 55%', minWidth: 0 }}>
          <AnalyticalTable columns={columns} data={gefiltert} loading={!l} visibleRows={Math.max(gefiltert.length, 3)}
                           noDataText="Keine passenden Buchungen" onRowClick={(e) => setWahl(e.detail.row.original as Hist)}
                           markNavigatedRow={(r) => r.original.internenr === wahl?.internenr} />
        </div>
        <div style={{ flex: '1 1 45%', minWidth: 0 }}><BelegVorschau id={ersterBeleg} hoehe="calc(88vh - 12rem)" /></div>
      </FlexBox>
    </Dialog>,
  );
}
