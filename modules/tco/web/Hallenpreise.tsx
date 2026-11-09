import { useEffect, useMemo, useState } from 'react';
import {
  Button, DatePicker, FlexBox, Input, Label, MessageStrip, ObjectStatus, Option, Panel, SegmentedButton, SegmentedButtonItem,
  Select, Text, Title, Toolbar, ToolbarButton, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { SperrHinweis, useSperre } from '@core/sperre';
import { H, dat, eur } from './util';
import { Wochenplan, type Fenster, type Gruppe, type Produkt } from './HallenpreiseWochenplan';

interface Befund { art: 'Fehler' | 'Hinweis'; text: string }

const TAGE = ['MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG'];
const TAG_KURZ: Record<string, string> = { MONTAG: 'Mo', DIENSTAG: 'Di', MITTWOCH: 'Mi', DONNERSTAG: 'Do', FREITAG: 'Fr', SAMSTAG: 'Sa', SONNTAG: 'So' };
const TYPEN: Record<string, string> = { '1': 'Abo', '2': 'Einzelbuchung', '3': 'Hallenschlüssel', '4': 'Sonstiges' };
const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const num = (v: number | string) => (typeof v === 'number' ? v : Number(String(v).replace(/\./g, '').replace(',', '.')));

/** Gültig-bis: Vortag des nächsten Gültig-ab desselben Produkts */
function mitBis(p: Produkt[]): Produkt[] {
  return p.map((x) => {
    const naechste = p.filter((y) => y.prod_key === x.prod_key && y.valid_from > x.valid_from).map((y) => y.valid_from).sort()[0];
    if (!naechste) return { ...x, valid_to: '9999-12-31' };
    const d = new Date(`${naechste}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return { ...x, valid_to: d.toISOString().slice(0, 10) };
  });
}

const zelle = { padding: '0.15rem 0.35rem' } as const;

export function Hallenpreise() {
  const can = useCan();
  // Preismatrix als Ganzes sperren (alle Produkte/Zeitfenster werden gemeinsam gespeichert)
  const sperre = useSperre('HALLENPREIS', '*', can('tco.halle:preise'), { bezeichnung: 'Hallenpreise' });
  const edit = can('tco.halle:preise') && sperre.eigen;
  const [produkte, setProdukte] = useState<Produkt[]>([]);
  const [fenster, setFenster] = useState<Fenster[]>([]);
  const [gruppen, setGruppen] = useState<Gruppe[]>([]);
  const [konten, setKonten] = useState<{ konto: string; name: string }[]>([]);
  const [befunde, setBefunde] = useState<Befund[] | null>(null);
  const [geprueft, setGeprueft] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stichtag, setStichtag] = useState(new Date().toISOString().slice(0, 10));
  const [saison, setSaison] = useState<'WINTER' | 'SOMMER'>('WINTER');
  // Wochenplan (sieben Tage nebeneinander, Preise als Blöcke) oder die Tabellen Produkte / Zeitfenster / Preismatrix
  const [ansicht, setAnsicht] = useState<'PLAN' | 'TABELLEN'>('PLAN');

  const laden = () => api.get<{ produkte: Produkt[]; fenster: Fenster[]; gruppen: Gruppe[]; konten?: { konto: string; name: string }[] }>(`${H}/preise`).then((r) => {
    setProdukte(r.produkte); setFenster(r.fenster); setGruppen(r.gruppen); setKonten(r.konten ?? []); setBefunde(null); setGeprueft(null);
  }).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  const stand = JSON.stringify({ produkte, fenster });
  const geaendert = () => { setGeprueft(null); };
  const setP = (i: number, f: Partial<Produkt>) => { setProdukte((p) => p.map((x, j) => (j === i ? { ...x, ...f } : x))); geaendert(); };
  const setF = (i: number, f: Partial<Fenster>) => { setFenster((p) => p.map((x, j) => (j === i ? { ...x, ...f } : x))); geaendert(); };
  const payload = () => ({ produkte: produkte.map((p) => ({ ...p, preis: num(p.preis), erloeskonto: p.erloeskonto ?? '' })), fenster });

  async function pruefen() {
    setBusy(true); setError(null);
    try {
      const b = await api.post<Befund[]>(`${H}/preise/pruefen`, payload());
      setBefunde(b);
      setGeprueft(b.some((x) => x.art === 'Fehler') ? null : stand);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function speichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ text: string }>(`${H}/preise`, payload());
      toast(r.text, 5000);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  /** neuer Zeitraum: Produkt mit allen Fenstern ab einem Datum kopieren */
  function zeitraumKopieren(p: Produkt) {
    // Vorschlag: Monatserster nach dem jüngsten Zeitraum dieses Produkts – Datum in der Zeile anpassen
    const juengster = produkte.filter((x) => x.prod_key === p.prod_key).map((x) => x.valid_from).sort().pop()!;
    const heute = new Date().toISOString().slice(0, 10);
    const basis = juengster > heute ? juengster : heute;
    const d = new Date(`${basis.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (produkte.some((x) => x.prod_key === p.prod_key && x.valid_from === iso)) { setError(`Ab ${dat(iso)} beginnt bereits ein Zeitraum.`); return; }
    setProdukte((l) => [...l, { ...p, valid_from: iso }]);
    setFenster((l) => [...l, ...l.filter((f) => f.prod_key === p.prod_key && f.valid_from === p.valid_from).map((f) => ({ ...f, valid_from: iso }))]);
    geaendert();
    toast(`Neuer Zeitraum ab ${dat(iso)} angelegt – Datum und Preise jetzt pflegen`);
  }

  const pBis = useMemo(() => mitBis(produkte), [produkte]);
  const fensterSicht = fenster.map((f, i) => ({ f, i })).filter(({ f }) => !filterKey || f.prod_key === filterKey)
    .sort((a, b) => a.f.prod_key.localeCompare(b.f.prod_key) || a.f.valid_from.localeCompare(b.f.valid_from)
      || TAGE.indexOf(a.f.tag) - TAGE.indexOf(b.f.tag) || min(a.f.zeit_von) - min(b.f.zeit_von));
  const gruppeVon = (k: string) => gruppen.find((g) => g.keys.includes(k));

  // ---- Matrix: Stunden × Wochentage für den Stichtag
  const matrix = useMemo(() => {
    const gilt = (k: string) => pBis.find((p) => p.prod_key === k && p.valid_from <= stichtag && (p.valid_to ?? '9999') >= stichtag);
    const einzelKeys = gruppen.find((g) => g.gruppe === (saison === 'SOMMER' ? 'EINZEL_SOMMER' : 'EINZEL_WINTER'))?.keys ?? [];
    const aboKeys = gruppen.find((g) => g.gruppe === 'ABO')?.keys ?? [];
    let von = 7 * 60;
    let bis = 23 * 60;
    const aktiv = fenster.filter((f) => { const p = gilt(f.prod_key); return p && p.valid_from === f.valid_from; });
    for (const f of aktiv) { von = Math.min(von, Math.floor(min(f.zeit_von) / 60) * 60); bis = Math.max(bis, Math.ceil(min(f.zeit_bis) / 60) * 60); }
    const stunden: number[] = [];
    for (let h = von; h < bis; h += 60) stunden.push(h);
    const zelleText = (tag: string, h: number, keys: string[]) => {
      const treffer = aktiv.filter((f) => keys.includes(f.prod_key) && f.tag === tag && min(f.zeit_von) < h + 60 && min(f.zeit_bis) > h);
      const ks = [...new Set(treffer.map((f) => f.prod_key))];
      if (!ks.length) return null;
      if (ks.length > 1) return { text: `mehrere (${ks.join('/')})`, key: ks[0] };
      const p = gilt(ks[0])!;
      return { text: `${ks[0]} · ${eur(num(p.preis))}`, key: ks[0] };
    };
    return { stunden, zelle: (tag: string, h: number) => ({ abo: zelleText(tag, h, aboKeys), einzel: zelleText(tag, h, einzelKeys) }) };
  }, [pBis, fenster, gruppen, stichtag, saison]);

  const fehler = befunde?.filter((b) => b.art === 'Fehler') ?? [];
  return (
    <AppPage title="Hallenpreise" subtitle="Stundenpreise je Preisgruppe, Zeitraum und Wochentag – als Wochenplan oder in Tabellen"
             actions={<>
               {edit && <Button icon="validate" onClick={pruefen} disabled={busy}>Prüfen</Button>}
               {edit && <Button design="Emphasized" icon="save" disabled={busy || geprueft !== stand} onClick={speichern}>Speichern</Button>}
               <ChangeHistoryButton objectType="HALLENPREIS" objectKey={filterKey || '001'} />
             </>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <SperrHinweis s={sperre} />
      {befunde && (
        <MessageStrip design={fehler.length ? 'Negative' : 'Positive'} hideCloseButton style={{ marginBottom: '0.5rem' }}>
          {fehler.length
            ? `${fehler.length} Fehler, ${befunde.length - fehler.length} Hinweis(e). Speichern ist erst nach Korrektur und erneuter Prüfung möglich.`
            : `Keine Fehler, ${befunde.length} Hinweis(e). Speichern ist freigegeben.`}
          {befunde.map((b, i) => <div key={i}>{b.art}: {b.text}</div>)}
        </MessageStrip>
      )}
      {edit && befunde && geprueft !== stand && !fehler.length && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Eingaben geändert – vor dem Speichern erneut prüfen</MessageStrip>
      )}

      <SegmentedButton style={{ marginBottom: '0.75rem' }} onSelectionChange={(e) => setAnsicht((e.detail.selectedItems[0] as HTMLElement).dataset.a as typeof ansicht)}>
        <SegmentedButtonItem data-a="PLAN" icon="appointment-2" selected={ansicht === 'PLAN'}>Wochenplan</SegmentedButtonItem>
        <SegmentedButtonItem data-a="TABELLEN" icon="table-view" selected={ansicht === 'TABELLEN'}>Tabellen</SegmentedButtonItem>
      </SegmentedButton>
      {ansicht === 'PLAN' && (
        <Wochenplan produkte={produkte} fenster={fenster} gruppen={gruppen} edit={edit} setProdukte={setProdukte} setFenster={setFenster}
                    geaendert={geaendert} onFehler={setError} />
      )}
      {ansicht === 'TABELLEN' && <>
      <Panel fixed header={
        <Toolbar design="Transparent" style={{ width: '100%' }}>
          <Title level="H5">Produkte ({produkte.length})</Title>
          <ToolbarSpacer />
          {edit && <ToolbarButton icon="add" text="Produkt" onClick={() => { setProdukte((l) => [...l, { prod_key: '', valid_from: new Date().toISOString().slice(0, 10), text: '', preis: 0, typ: '2' }]); geaendert(); }} />}
        </Toolbar>
      }>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>{['Schlüssel', 'Preisgruppe', 'Gültig ab', 'Gültig bis', 'Bezeichnung', 'Typ', 'Erlöskonto', 'Preis (EUR/Std. bzw. Stück)', ''].map((h) => <th key={h} style={{ ...zelle, textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
          <tbody>
            {produkte.map((p, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                <td style={zelle}><Input style={{ width: '5rem' }} value={p.prod_key} readonly={!edit} maxlength={3} onChange={(e) => setP(i, { prod_key: e.target.value })} /></td>
                <td style={zelle}><Text>{gruppeVon(p.prod_key)?.text ?? '–'}</Text></td>
                <td style={zelle}><DatePicker style={{ width: '9.5rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={p.valid_from} readonly={!edit}
                                              onChange={(e) => { const alt = p.valid_from; setP(i, { valid_from: e.detail.value }); setFenster((l) => l.map((f) => (f.prod_key === p.prod_key && f.valid_from === alt ? { ...f, valid_from: e.detail.value } : f))); }} /></td>
                <td style={zelle}><Text>{pBis[i]?.valid_to === '9999-12-31' ? 'unbegrenzt' : dat(pBis[i]?.valid_to)}</Text></td>
                <td style={zelle}><Input style={{ width: '100%' }} value={p.text} readonly={!edit} onChange={(e) => setP(i, { text: e.target.value })} /></td>
                <td style={zelle}>
                  <Select style={{ width: '10rem' }} disabled={!edit} onChange={(e) => setP(i, { typ: (e.detail.selectedOption as HTMLElement).dataset.t! })}>
                    {Object.entries(TYPEN).map(([k, t]) => <Option key={k} data-t={k} selected={p.typ === k}>{t}</Option>)}
                  </Select>
                </td>
                <td style={zelle}>
                  <Select style={{ width: '13rem' }} disabled={!edit} onChange={(e) => setP(i, { erloeskonto: (e.detail.selectedOption as HTMLElement).dataset.k || null })}>
                    <Option data-k="" selected={!p.erloeskonto}>Standard (8003 Hallenmiete)</Option>
                    {konten.map((k) => <Option key={k.konto} data-k={k.konto} selected={p.erloeskonto === k.konto}>{k.konto} {k.name}</Option>)}
                  </Select>
                </td>
                <td style={zelle}><Input style={{ width: '7rem', textAlign: 'right' }} value={String(p.preis).replace('.', ',')} readonly={!edit} onChange={(e) => setP(i, { preis: e.target.value })} /></td>
                <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                  {edit && <Button design="Transparent" icon="duplicate" onClick={() => zeitraumKopieren(p)}>Neuer Zeitraum</Button>}
                  {edit && <Button design="Transparent" icon="delete" onClick={() => { setProdukte((l) => l.filter((_, j) => j !== i)); setFenster((l) => l.filter((f) => !(f.prod_key === p.prod_key && f.valid_from === p.valid_from))); geaendert(); }} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel fixed style={{ marginTop: '1rem' }} header={
        <Toolbar design="Transparent" style={{ width: '100%' }}>
          <Title level="H5">Zeitfenster ({fensterSicht.length})</Title>
          <ToolbarSpacer />
          <Label>Produkt</Label>
          <Select style={{ width: '14rem' }} onChange={(e) => setFilterKey((e.detail.selectedOption as HTMLElement).dataset.k!)}>
            <Option data-k="" selected={!filterKey}>alle</Option>
            {[...new Set(produkte.map((p) => p.prod_key))].sort().map((k) => <Option key={k} data-k={k} selected={filterKey === k}>{k} – {produkte.find((p) => p.prod_key === k)?.text}</Option>)}
          </Select>
          {edit && <ToolbarButton icon="add" text="Zeitfenster" onClick={() => {
            const p = produkte.find((x) => x.prod_key === filterKey) ?? produkte[0];
            if (!p) return;
            setFenster((l) => [...l, { prod_key: p.prod_key, valid_from: p.valid_from, tag: 'MONTAG', zeit_von: '07:00', zeit_bis: '23:00' }]);
            geaendert();
          }} />}
        </Toolbar>
      }>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead><tr>{['Produkt', 'Zeitraum ab', 'Wochentag', 'Von', 'Bis', ''].map((h) => <th key={h} style={{ ...zelle, textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
          <tbody>
            {fensterSicht.map(({ f, i }) => (
              <tr key={i} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                <td style={zelle}>
                  <Select style={{ width: '12rem' }} disabled={!edit} onChange={(e) => setF(i, { prod_key: (e.detail.selectedOption as HTMLElement).dataset.k! })}>
                    {[...new Set(produkte.map((p) => p.prod_key))].sort().map((k) => <Option key={k} data-k={k} selected={f.prod_key === k}>{k} – {produkte.find((p) => p.prod_key === k)?.text}</Option>)}
                  </Select>
                </td>
                <td style={zelle}>
                  <Select style={{ width: '9rem' }} disabled={!edit} onChange={(e) => setF(i, { valid_from: (e.detail.selectedOption as HTMLElement).dataset.v! })}>
                    {produkte.filter((p) => p.prod_key === f.prod_key).map((p) => <Option key={p.valid_from} data-v={p.valid_from} selected={p.valid_from === f.valid_from}>{dat(p.valid_from)}</Option>)}
                  </Select>
                </td>
                <td style={zelle}>
                  <Select style={{ width: '9rem' }} disabled={!edit} onChange={(e) => setF(i, { tag: (e.detail.selectedOption as HTMLElement).dataset.t! })}>
                    {TAGE.map((t) => <Option key={t} data-t={t} selected={f.tag === t}>{t.charAt(0) + t.slice(1).toLowerCase()}</Option>)}
                  </Select>
                </td>
                <td style={zelle}><Input style={{ width: '5.5rem' }} value={f.zeit_von} readonly={!edit} placeholder="HH:MM" onChange={(e) => setF(i, { zeit_von: e.target.value })} /></td>
                <td style={zelle}><Input style={{ width: '5.5rem' }} value={f.zeit_bis} readonly={!edit} placeholder="HH:MM" onChange={(e) => setF(i, { zeit_bis: e.target.value })} /></td>
                <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                  {edit && <Button design="Transparent" icon="copy" onClick={() => {
                    setFenster((l) => [...l, ...TAGE.filter((t) => t !== f.tag).map((tag) => ({ ...f, tag }))]);
                    geaendert();
                  }}>auf alle Tage</Button>}
                  {edit && <Button design="Transparent" icon="delete" onClick={() => { setFenster((l) => l.filter((_, j) => j !== i)); geaendert(); }} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel fixed style={{ marginTop: '1rem' }} header={
        <Toolbar design="Transparent" style={{ width: '100%' }}>
          <Title level="H5">Preismatrix</Title>
          <ToolbarSpacer />
          <Label>Stichtag</Label>
          <DatePicker style={{ width: '9.5rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={stichtag} onChange={(e) => setStichtag(e.detail.value)} />
          <SegmentedButton onSelectionChange={(e) => setSaison((e.detail.selectedItems[0] as HTMLElement).dataset.s as typeof saison)}>
            <SegmentedButtonItem data-s="WINTER" selected={saison === 'WINTER'}>Winter</SegmentedButtonItem>
            <SegmentedButtonItem data-s="SOMMER" selected={saison === 'SOMMER'}>Sommer (01.05.–15.09.)</SegmentedButtonItem>
          </SegmentedButton>
        </Toolbar>
      }>
        <Text style={{ color: 'var(--sapContent_LabelColor)' }}>Je Zelle oben Abo, unten Einzelbuchung. Leere Zellen haben keinen Preis (Buchungen dort ergeben einen Preisfehler).</Text>
        <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: '0.5rem' }}>
          <thead><tr><th style={zelle} />{TAGE.map((t) => <th key={t} style={{ ...zelle, textAlign: 'left' }}><Label>{TAG_KURZ[t]}</Label></th>)}</tr></thead>
          <tbody>
            {matrix.stunden.map((h) => (
              <tr key={h} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                <td style={{ ...zelle, whiteSpace: 'nowrap' }}><Label>{String(h / 60).padStart(2, '0')}:00</Label></td>
                {TAGE.map((t) => {
                  const z = matrix.zelle(t, h);
                  return (
                    <td key={t} style={{ ...zelle, fontSize: 'var(--sapFontSmallSize)' }}>
                      <div>{z.abo ? <ObjectStatus state="Information">{z.abo.text}</ObjectStatus> : <Text style={{ color: 'var(--sapNegativeTextColor)' }}>–</Text>}</div>
                      <div>{z.einzel ? <ObjectStatus>{z.einzel.text}</ObjectStatus> : <Text style={{ color: 'var(--sapNegativeTextColor)' }}>–</Text>}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <FlexBox style={{ marginTop: '0.5rem' }}><Text style={{ color: 'var(--sapContent_LabelColor)' }}>
        Gültig-bis wird automatisch abgeleitet (Vortag des nächsten Zeitraums). Angrenzende Fenster eines Produkts werden beim Speichern zusammengefasst.
      </Text></FlexBox>
      </>}
    </AppPage>
  );
}
