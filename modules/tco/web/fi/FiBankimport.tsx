import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, Button, CheckBox, DatePicker, Dialog, FileUploader, FlexBox, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, Title,
} from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { dat, dateiLesen, eur } from '../util';
import { KontoBox, ZuordnenDialog } from './FiDialoge';
import { F, betragParse, betragText, heute, type BankDatei, type Konto, type OffeneRechnung, type Position } from './typen';

interface Row {
  uid: number;
  sel: boolean;
  neu: boolean;               // false = bereits gebucht
  datum: string;
  text: string;
  name: string;
  zweck: string;
  betrag: number;
  betragEingabe: string;      // manuell
  statusText: string;
  herkunft: string;
  art: 'regel' | 'historie' | 'keine' | 'hand';
  positionen: (Position & { eingabe: string })[];
  summenmodus: boolean;       // manuell: Betrag = Summe der Positionen
  belege: number[];
  belegText: string;
  notiz: string;
}

let uid = 1;
const pos = (gkonto = '', betrag = 0, text = '', rgnr: string | null = null) => ({ gkonto, betrag, text, rgnr, eingabe: betrag ? betragText(betrag) : '' });

/** Positionen mit berechnetem Restbetrag (Position 1 = Rest) bzw. Kopfbetrag im Summenmodus */
function berechnet(r: Row): { betrag: number; positionen: Position[] } {
  if (r.summenmodus) {
    const p = r.positionen.map((x) => ({ gkonto: x.gkonto, betrag: betragParse(x.eingabe) ?? 0, text: x.text || null, rgnr: x.rgnr }));
    return { betrag: Math.round(p.reduce((s, x) => s + x.betrag, 0) * 100) / 100, positionen: p };
  }
  const weitere = r.positionen.slice(1).map((x) => ({ gkonto: x.gkonto, betrag: betragParse(x.eingabe) ?? 0, text: x.text || null, rgnr: x.rgnr }));
  const rest = Math.round((r.betrag - weitere.reduce((s, x) => s + x.betrag, 0)) * 100) / 100;
  const erste = r.positionen[0];
  return { betrag: r.betrag, positionen: erste ? [{ gkonto: erste.gkonto, betrag: rest, text: erste.text || null, rgnr: erste.rgnr }, ...weitere] : [] };
}

export function BankimportDialog({ open, start, konten, bankkonten, manuellKonten, rechnungen, onClose, onDone }: {
  open: boolean; start: string; konten: Konto[]; bankkonten: string[]; manuellKonten: string[]; rechnungen: OffeneRechnung[];
  onClose: () => void; onDone: (text: string, warnungen: string[]) => void;
}) {
  const geldkonten = [...bankkonten, ...manuellKonten];
  const [konto, setKonto] = useState(start);
  const [datei, setDatei] = useState<BankDatei | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [gebuchtZeigen, setGebuchtZeigen] = useState(false);
  const [kontostand, setKontostand] = useState<{ betrag: number; letzteBuchung: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [belegFuer, setBelegFuer] = useState<Row | null>(null);
  const manuell = !bankkonten.includes(konto);

  useEffect(() => {
    if (!open) return;
    setKonto(geldkonten.includes(start) ? start : bankkonten[0] ?? manuellKonten[0] ?? '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDatei(null); setRows([]); setError(null); setKontostand(null);
    if (open && konto && !bankkonten.includes(konto)) {
      api.get<{ betrag: number; letzteBuchung: string | null }>(`${F}/kontostand${qs({ konto })}`).then(setKontostand);
    }
  }, [konto, open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function dateiLaden(f: File) {
    setBusy(true); setError(null);
    try {
      const d = await api.post<BankDatei>(`${F}/bank/lesen`, { konto, data: await dateiLesen(f) });
      setDatei(d);
      setRows(d.umsaetze.map((u) => ({
        uid: uid++, sel: u.status === 'neu', neu: u.status === 'neu', datum: u.datum, text: u.buchungsText, name: u.name, zweck: u.zweck,
        betrag: u.betrag, betragEingabe: betragText(u.betrag), statusText: u.statusText, herkunft: u.herkunft, art: u.art,
        positionen: u.positionen.length ? u.positionen.map((p, i) => pos(p.gkonto, i === 0 ? 0 : p.betrag, p.text ?? '', p.rgnr ?? null)) : [pos()],
        summenmodus: false, belege: u.belegVorschlag?.doks ?? [], belegText: u.belegVorschlag?.text ?? '', notiz: '',
      })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const upd = (u: number, f: (r: Row) => Row) => setRows((l) => l.map((r) => (r.uid === u ? f(r) : r)));
  const updPos = (u: number, i: number, p: Partial<Row['positionen'][number]>) =>
    upd(u, (r) => ({ ...r, art: 'hand', positionen: r.positionen.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
  const neueZeile = (vorlage?: Row) => setRows((l) => [...l, vorlage
    ? { ...vorlage, uid: uid++, belege: [], belegText: '', notiz: '', statusText: `Kopie von ${vorlage.text}` }
    : { uid: uid++, sel: true, neu: true, datum: heute(), text: '', name: '', zweck: '', betrag: 0, betragEingabe: '', statusText: 'manuelle Buchung',
        herkunft: '', art: 'hand', positionen: [pos()], summenmodus: false, belege: [], belegText: '', notiz: '' }]);

  const ausgewaehlt = rows.filter((r) => r.neu && r.sel);
  const summeNeu = Math.round(ausgewaehlt.reduce((s, r) => s + berechnet(r).betrag, 0) * 100) / 100;
  const saldoNeu = datei ? Math.round((datei.saldoFi + summeNeu) * 100) / 100 : kontostand ? Math.round((kontostand.betrag + summeNeu) * 100) / 100 : null;
  const differenz = datei?.endsaldo !== null && datei && saldoNeu !== null ? Math.round((datei.endsaldo! - saldoNeu) * 100) / 100 : null;
  const sichtbar = rows.filter((r) => r.neu || gebuchtZeigen);

  async function buchen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${F}/buchen`, {
        konto, iban: datei?.iban ?? null,
        umsaetze: ausgewaehlt.map((x) => {
          const b = berechnet(x);
          return { datum: x.datum, text: x.text, betrag: b.betrag, positionen: b.positionen, belege: x.belege, notiz: x.notiz || null };
        }),
      });
      onDone(datei?.endsaldo !== null && datei ? `${r.text} · Endsaldo Bank ${eur(datei.endsaldo)}` : r.text, r.warnungen);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const rgOptionen = useMemo(() => rechnungen.map((r) => ({ key: r.rgnr_txt, text: `${r.rgnr_txt} – ${r.kunde} · offen ${eur(r.offen)} von ${eur(r.betrag)}` })), [rechnungen]);

  const zeile = (r: Row) => {
    const b = berechnet(r);
    const fehlt = r.neu && b.positionen.some((p) => !p.gkonto);
    const rand = !r.neu ? 'var(--sapList_BorderColor)' : fehlt ? 'var(--sapCriticalColor)' : r.art === 'historie' ? 'var(--sapInformativeColor)' : 'var(--sapPositiveColor)';
    return (
      <div key={r.uid} style={{ borderLeft: `4px solid ${rand}`, padding: '0.5rem 0.75rem', marginBottom: '0.5rem', background: 'var(--sapList_Background)', opacity: r.neu ? 1 : 0.6 }}>
        <FlexBox style={{ gap: '0.75rem' }} alignItems="Start">
          <CheckBox checked={r.sel && r.neu} disabled={!r.neu} onChange={(e) => upd(r.uid, (x) => ({ ...x, sel: e.target.checked }))} />
          <div style={{ width: '7.5rem' }}>
            {manuell
              ? <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={r.datum} style={{ width: '7.5rem' }} onChange={(e) => upd(r.uid, (x) => ({ ...x, datum: e.detail.value }))} />
              : <Text>{dat(r.datum)}</Text>}
          </div>
          <div style={{ flex: 1, minWidth: '14rem' }}>
            {!manuell && <><Text style={{ fontWeight: 'bold' }}>{r.name || '–'}</Text><br /><Text style={{ color: 'var(--sapContent_LabelColor)' }}>{r.zweck}</Text><br /></>}
            {r.neu && <Input value={r.text} maxlength={60} placeholder="Buchungstext" style={{ width: '100%', marginTop: '0.25rem' }}
                             onInput={(e) => upd(r.uid, (x) => ({ ...x, text: e.target.value }))} />}
            {r.neu && <Input value={r.notiz} maxlength={255} placeholder="Notiz (optional)" style={{ width: '100%', marginTop: '0.25rem' }}
                             onInput={(e) => upd(r.uid, (x) => ({ ...x, notiz: e.target.value }))} />}
          </div>
          <div style={{ width: '9rem', textAlign: 'right' }}>
            {manuell && !r.summenmodus
              ? <Input value={r.betragEingabe} placeholder="+ Ein / − Aus" style={{ width: '9rem' }} onInput={(e) => {
                  const v = e.target.value;
                  upd(r.uid, (x) => ({ ...x, betragEingabe: v, betrag: betragParse(v) ?? 0 }));
                }} />
              : <ObjectStatus state={b.betrag > 0 ? 'Positive' : b.betrag < 0 ? 'Negative' : 'None'}>{eur(b.betrag)}</ObjectStatus>}
          </div>
          <div style={{ width: '24rem' }}>
            {r.neu ? r.positionen.map((p, i) => (
              <div key={i} style={{ marginBottom: '0.35rem' }}>
                <FlexBox style={{ gap: '0.25rem' }} alignItems="Center">
                  <KontoBox konten={konten} value={p.gkonto} ohne={konto} style={{ flex: 1 }} placeholder="Gegenkonto wählen …"
                            onChange={(k) => updPos(r.uid, i, { gkonto: k, rgnr: k === '8003' ? p.rgnr : null })} />
                  {r.positionen.length > 1 && (i > 0 || r.summenmodus
                    ? <Input value={p.eingabe} placeholder="Betrag" style={{ width: '6.5rem' }} onInput={(e) => updPos(r.uid, i, { eingabe: e.target.value })} />
                    : <Text style={{ width: '6.5rem', textAlign: 'right' }}>{betragText(b.positionen[0]?.betrag ?? 0)}</Text>)}
                  {r.positionen.length > 1 && <Button design="Transparent" icon="decline" onClick={() => upd(r.uid, (x) => ({ ...x, positionen: x.positionen.filter((_, j) => j !== i) }))} />}
                </FlexBox>
                {r.positionen.length > 1 && <Input value={p.text ?? ''} placeholder="Text der Position" maxlength={60} style={{ width: '100%', marginTop: '0.15rem' }}
                                                   onInput={(e) => updPos(r.uid, i, { text: e.target.value })} />}
                {p.gkonto === '8003' && (
                  <Select style={{ width: '100%', marginTop: '0.15rem' }} onChange={(e) => updPos(r.uid, i, { rgnr: (e.detail.selectedOption as HTMLElement).dataset.key || null })}>
                    <Option data-key="" selected={!p.rgnr}>Hallenrechnung wählen …</Option>
                    {rgOptionen.map((o) => <Option key={o.key} data-key={o.key} selected={o.key === p.rgnr}>{o.text}</Option>)}
                  </Select>
                )}
              </div>
            )) : <Text>{r.statusText}</Text>}
            {r.neu && (
              <FlexBox style={{ gap: '0.25rem' }} wrap="Wrap">
                <Button design="Transparent" icon="add" onClick={() => upd(r.uid, (x) => ({ ...x, art: 'hand', positionen: [...x.positionen, pos()] }))}>
                  {r.positionen.length > 1 ? 'Weitere Position' : 'Aufteilen'}
                </Button>
                {manuell && r.positionen.length > 1 && (
                  <Button design="Transparent" icon={r.summenmodus ? 'sum' : 'edit'} onClick={() => upd(r.uid, (x) => ({
                    ...x, summenmodus: !x.summenmodus,
                    positionen: x.summenmodus ? x.positionen : x.positionen.map((p, j) => (j === 0 ? { ...p, eingabe: betragText(berechnet(x).positionen[0]?.betrag ?? 0) } : p)),
                  }))}>{r.summenmodus ? 'Summenmodus aus' : 'Betrag aus Positionen'}</Button>
                )}
                {manuell && <Button design="Transparent" icon="copy" onClick={() => neueZeile(r)}>Kopieren</Button>}
                {manuell && <Button design="Transparent" icon="delete" onClick={() => setRows((l) => l.filter((x) => x.uid !== r.uid))}>Entfernen</Button>}
              </FlexBox>
            )}
          </div>
          <div style={{ width: '13rem' }}>
            {r.neu && (
              <Button design={r.belegText && r.belege.length ? 'Attention' : 'Default'} icon="attachment" onClick={() => setBelegFuer(r)}>
                {r.belege.length ? (r.belegText ? `Vorschlag ${r.belege.join(', ')}` : `Beleg ${r.belege.join(', ')}`) : 'Beleg'}
              </Button>
            )}
            <br />
            <Label wrappingType="Normal">{r.neu ? [r.statusText !== 'neu' ? r.statusText : '', r.herkunft, r.belegText].filter(Boolean).join(' · ') || 'neu' : ''}</Label>
          </div>
        </FlexBox>
      </div>
    );
  };

  return createPortal(<>
    <Dialog open={open} resizable onClose={onClose} style={{ width: '96vw', height: '94vh' }}
            headerText={manuell ? 'Kasse / Konto – Buchungen manuell erfassen' : 'Bankimport – neue Umsätze kontieren'}
            footer={<Bar startContent={<Text>{ausgewaehlt.length} Umsatz/Umsätze ausgewählt · {eur(summeNeu)}</Text>} endContent={<>
              <Button design="Emphasized" disabled={!ausgewaehlt.length} loading={busy} onClick={buchen}>
                {manuell ? 'Erfasste Buchungen buchen' : 'Ausgewählte Umsätze buchen'}
              </Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <FlexBox style={{ gap: '1rem', marginBottom: '0.75rem' }} alignItems="End" wrap="Wrap">
        <div>
          <Label>Konto (FI)</Label><br />
          <Select style={{ width: '18rem' }} onChange={(e) => setKonto((e.detail.selectedOption as HTMLElement).dataset.key!)}>
            {geldkonten.map((k) => (
              <Option key={k} data-key={k} selected={k === konto}>
                {k} – {konten.find((x) => x.konto === k)?.name ?? ''}{bankkonten.includes(k) ? ' (Bankdatei)' : ' (manuell)'}
              </Option>
            ))}
          </Select>
        </div>
        {!manuell && (
          <FileUploader accept=".csv,.txt" hideInput={false} placeholder="Umsatzexport der Bank (CSV) wählen …" style={{ width: '22rem' }}
                        onChange={(e) => { const f = e.detail.files?.[0]; if (f) dateiLaden(f); }}>
            <Button icon="upload">Bankdatei</Button>
          </FileUploader>
        )}
        {manuell && <Button icon="add" onClick={() => neueZeile()}>Buchung hinzufügen</Button>}
        {datei && <CheckBox text="Bereits gebuchte Umsätze einblenden" checked={gebuchtZeigen} onChange={(e) => setGebuchtZeigen(e.target.checked)} />}
      </FlexBox>

      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {(datei?.hinweise ?? []).map((h) => <MessageStrip key={h} design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>{h}</MessageStrip>)}
      {manuell && <MessageStrip hideCloseButton style={{ marginBottom: '0.5rem' }}>Für dieses Konto gibt es keine Bankdatei – Buchungen hier erfassen (+ Einzahlung / − Auszahlung).</MessageStrip>}

      {datei && (
        <FlexBox style={{ gap: '2rem', marginBottom: '0.75rem' }} wrap="Wrap">
          <div><Label>Datei</Label><br /><Text>{datei.info || '–'}</Text></div>
          <div><Label>Umsätze</Label><br /><Text>{dat(datei.von)} bis {dat(datei.bis)} · {datei.umsaetze.length} in der Datei · {datei.umsaetze.filter((u) => u.status === 'neu').length} neu · {datei.umsaetze.filter((u) => u.status !== 'neu').length} bereits gebucht</Text></div>
          <div><Label>Endsaldo Bank per {dat(datei.bis)}</Label><br /><Title level="H5">{datei.endsaldo === null ? '–' : eur(datei.endsaldo)}</Title></div>
          <div><Label>Saldo lt. FI inkl. ausgewählter Umsätze</Label><br /><Title level="H5">{eur(saldoNeu)}</Title></div>
          {differenz !== null && <div><Label>Differenz zur Bank</Label><br />
            <ObjectStatus state={differenz === 0 ? 'Positive' : 'Critical'} showDefaultIcon>{eur(differenz)}</ObjectStatus></div>}
        </FlexBox>
      )}
      {manuell && kontostand && (
        <FlexBox style={{ gap: '2rem', marginBottom: '0.75rem' }}>
          <div><Label>Kontostand aktuell{kontostand.letzteBuchung ? ` (letzte Buchung ${dat(kontostand.letzteBuchung)})` : ''}</Label><br /><Title level="H5">{eur(kontostand.betrag)}</Title></div>
          <div><Label>Kontostand neu inkl. erfasster Buchungen</Label><br /><Title level="H5">{eur(saldoNeu)}</Title></div>
        </FlexBox>
      )}

      {!datei && !manuell && !busy && <Text>Noch keine Bankdatei geladen</Text>}
      {manuell && !rows.length && <Text>Keine Buchung erfasst</Text>}
      {sichtbar.map(zeile)}
    </Dialog>
    <ZuordnenDialog open={!!belegFuer} ziele={[]} vorauswahl={belegFuer?.belege ?? []}
                    titel={belegFuer ? `Beleg zum Umsatz wählen – ${dat(belegFuer.datum)} ${belegFuer.text} ${eur(belegFuer.betrag)}` : ''}
                    onClose={() => setBelegFuer(null)}
                    onPick={(ids) => belegFuer && upd(belegFuer.uid, (x) => ({ ...x, belege: ids, belegText: '' }))} />
  </>, document.body);
}
