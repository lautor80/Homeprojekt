import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BusyIndicator, Button, CheckBox, ComboBox, ComboBoxItem, DatePicker, FlexBox, Input, Label, MessageStrip, ObjectPage, ObjectStatus,
  ObjectPageSection, ObjectPageSubSection, ObjectPageTitle, Option, Select, Switch, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { useCan } from '@core/session';
import { SperrHinweis, useSperre } from '@core/sperre';
import { toast } from '@core/toast';
import { DocsDialog, XRechnungDialog, type Doc, type XRes } from './dialogs';
import { AuftragDokumente } from './AuftragDokumente';
import { KontaktDialog, WertDialog } from './KontaktDialog';
import { MenuButton, T, betrag, dat, type AdrDD, type Adresse, type Auftrag, type Stop, type Traeger, type Werte } from './util';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { ablegen, auftragsOrdner, ordnerBereit } from './ordner';

/** Feld im Formularraster: Label links, Inhalt rechts (wie SimpleForm ResponsiveGridLayout) */
function F({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <>
      <Label showColon required={required} style={{ alignSelf: 'center', justifySelf: 'end', textAlign: 'right' }}>{label}</Label>
      <div style={{ minWidth: 0 }}>{children}</div>
    </>
  );
}
function Spalte({ titel, children }: { titel?: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      {titel && <Title level="H5" style={{ marginBottom: '0.5rem', paddingLeft: '0.25rem' }}>{titel}</Title>}
      {/* Beschriftung so breit wie nötig, Feld daneben – auch auf sehr breiten Bildschirmen nah beieinander */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, max-content) minmax(0, 1fr)', gap: '0.5rem 0.75rem', maxWidth: '36rem' }}>{children}</div>
    </div>
  );
}
function Spalten({ n, children }: { n: number; children: ReactNode }) {
  // Einzug, damit Spaltentitel (Auftrag, Absender …) nicht am Kartenrand kleben
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${n === 3 ? 300 : 380}px, 1fr))`, gap: '1.25rem 2.5rem', padding: '0.25rem 1rem' }}>{children}</div>;
}

const full = { width: '100%' };

function adrText(a: Adresse | null | undefined) {
  return {
    strasse: `${a?.strasse ?? ''} ${a?.hausnummer ?? ''}`.trim(),
    ort: `${a?.land ?? ''} ${a?.plz ?? ''} ${a?.ort ?? ''}`.replace(/\s+/g, ' ').trim(),
    telefon: a?.telefon ?? '',
    email: a?.email ?? '',
  };
}

/** Objektseite Auftrag – Fracht- oder Holzträgerauftrag (wie VIEW_DETAIL) */
export function AuftragDetail() {
  const { nr, typ: neuTyp } = useParams();
  const isNew = !!neuTyp;
  const navigate = useNavigate();
  const can = useCan();
  const darfAendern = can('transport.auftraege:edit');
  const sperre = useSperre('AUFTRAG', isNew ? null : nr, darfAendern, { bezeichnung: `Auftrag ${nr ?? ''}` });
  const darfBearbeiten = darfAendern && sperre.eigen;

  const [a, setA] = useState<Auftrag | null>(null);
  const [vorschau, setVorschau] = useState<string>('');
  const [adrDD, setAdrDD] = useState<AdrDD[]>([]);
  const [werte, setWerte] = useState<Werte | null>(null);
  const [adr, setAdr] = useState<Record<'kunde' | 'unternehmer' | 'rechnungsempfaenger', Adresse | null>>({ kunde: null, unternehmer: null, rechnungsempfaenger: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [xr, setXr] = useState<XRes | null>(null);
  const [ordnerStand, setOrdnerStand] = useState(0); // neu einlesen nach Druck/Ablage
  const [kontakt, setKontakt] = useState<'NEU' | 'EDIT' | null>(null);
  const [wertTyp, setWertTyp] = useState<string | null>(null);

  const ladeAdressen = useCallback(() => api.get<AdrDD[]>(`${T}/adressen`).then(setAdrDD), []);
  const ladeWerte = useCallback(() => api.get<Werte>(`${T}/werte`).then(setWerte), []);

  const lade = useCallback(async () => {
    setError(null);
    try {
      if (isNew) {
        const v = await api.get<Auftrag & { nummerVorschau: string }>(`${T}/neu/${neuTyp}`);
        setVorschau(v.nummerVorschau);
        setA({ ...v, kunde: null, unternehmer: null, rechnungsempfaenger: null, leistungsdatum: null, ordernummer: null,
          gewicht: null, lademeter: null, ladenummer: null, besonderheiten: null });
        setAdr({ kunde: null, unternehmer: null, rechnungsempfaenger: null });
      } else {
        const d = await api.get<Auftrag>(`${T}/auftraege/${nr}`);
        setA(d);
        setAdr({ kunde: d.kundeAdr ?? null, unternehmer: d.unternehmerAdr ?? null, rechnungsempfaenger: d.reAdr ?? null });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [isNew, neuTyp, nr]);

  useEffect(() => { lade(); }, [lade]);
  useEffect(() => { ladeAdressen(); ladeWerte(); }, [ladeAdressen, ladeWerte]);

  const typ = a?.typ ?? 'F';
  const showStops = typ === 'F';
  const showTraeger = typ === 'H' || (a?.traeger.some((t) => t.menge > 0) ?? false);
  const traegerSumme = useMemo(() => (a?.traeger ?? []).reduce((s, t) => s + t.menge * t.preis, 0), [a]);

  if (!a) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : <BusyIndicator active style={{ margin: '2rem' }} />;

  // Fakturierte Aufträge (#121): gesperrt bis auf „Dokumente fehlen“, Besonderheiten und Dokumente
  const fakturiert = !isNew && !!a.faktura;
  const mayEdit = darfBearbeiten && !fakturiert;

  const set = <K extends keyof Auftrag>(k: K, v: Auftrag[K]) => setA({ ...a, [k]: v });
  const setStop = (i: number, f: keyof Stop, v: string | null) => {
    const stops = [...a.stops];
    stops[i] = { ...stops[i], [f]: v || null };
    setA({ ...a, stops });
  };
  const setTr = (i: number, f: keyof Traeger, v: string | number) => {
    const traeger = [...a.traeger];
    traeger[i] = { ...traeger[i], [f]: v };
    setA({ ...a, traeger });
  };

  async function waehleAdresse(f: 'kunde' | 'unternehmer' | 'rechnungsempfaenger', key: string | undefined) {
    const n = key ? Number(key) : null;
    setA((x) => (x ? { ...x, [f]: n } : x));
    setAdr((x) => ({ ...x, [f]: null }));
    if (n) {
      const d = await api.get<Adresse>(`${T}/adressen/${n}`);
      setAdr((x) => ({ ...x, [f]: d }));
    }
  }

  /** "Kundenadresse als Absender übernehmen" (STOP_KUNDE_UEBERNEHMEN) */
  function kundeUebernehmen(i: number) {
    const k = adr.kunde;
    if (!k) return toast('Bitte zuerst einen Kunden zuordnen.');
    const stops = [...a!.stops];
    stops[i] = {
      ...stops[i], firma: k.kundenname, strasse: `${k.strasse ?? ''} ${k.hausnummer ?? ''}`.trim(), land: k.land,
      plzort: `${k.plz ?? ''} ${k.ort ?? ''}`.trim(),
    };
    setA({ ...a!, stops });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { ...a, typ };
      if (isNew) {
        await ordnerBereit(true); // Ablageordner: Zugriff jetzt (beim Klick) erfragen
        const r = await api.post<{ auftragsnr: string }>(`${T}/auftraege`, body);
        // Auftragsordner im Ablageordner anlegen (#121)
        const o = await auftragsOrdner(r.auftragsnr).catch(() => null);
        toast(`Auftrag ${r.auftragsnr} gespeichert.${o ? ` Ordner ${o.basis}/${r.auftragsnr.slice(0, 4)}/${r.auftragsnr} angelegt.` : ''}`);
        navigate(`/transport/auftraege/${r.auftragsnr}`, { replace: true });
      } else {
        await api.put(`${T}/auftraege/${nr}`, body);
        toast(`Auftrag ${nr} gespeichert.`);
        await lade();
      }
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  }

  async function drucken(art: 'T' | 'L' | 'R') {
    if (isNew) return toast('Bitte den Auftrag zuerst speichern.');
    await ordnerBereit(true); // Ablageordner: Zugriff jetzt (beim Klick) erfragen
    if (art === 'R') {
      // Rechnung: dieselbe Vorschau wie „Versenden → E-Rechnung“ in der Auftragsliste (#121)
      try {
        // PDF zusätzlich im Ablageordner des Auftrags speichern
        const f = a!.faktura!;
        fetch(`${T}/pdf/R/${encodeURIComponent(f)}`, { credentials: 'same-origin' })
          .then((res) => (res.ok ? res.blob() : null))
          .then((b) => (b ? ablegen(nr!, `Rechnung_${f}.pdf`, b) : null))
          .then((p) => { if (p) { toast(`Gespeichert: ${p}`); setOrdnerStand((v) => v + 1); } })
          .catch(() => undefined);
        const r = await api.get<XRes>(`${T}/xrechnung/${encodeURIComponent(a!.faktura!)}`);
        if (r.anzahlAuftraege > 1) {
          r.hinweise.unshift(`Rechnung ${r.faktura} ist eine Sammelrechnung über ${r.anzahlAuftraege} Aufträge - die E-Rechnung enthält wie die PDF-Rechnung alle ${r.anzahlAuftraege} Aufträge.`);
        }
        setXr(r);
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    const id = nr!;
    const name = art === 'T' ? 'Transportauftrag' : art === 'L' ? 'Lieferschein' : 'Rechnung';
    setDocs([{ url: `${T}/pdf/${art}/${encodeURIComponent(id)}`, filename: `${name}_${id}.pdf`, ablage: [nr!] }]);
  }

  // Kontakte dieses Auftrags (für "Kontakt bearbeiten")
  const kontakteAuftrag: AdrDD[] = [];
  for (const [rolle, n] of [['Kunde', a.kunde], ['Unternehmer', a.unternehmer], ['Abw. Rechnungsempfänger', a.rechnungsempfaenger]] as const) {
    if (!n) continue;
    const vorh = kontakteAuftrag.find((k) => k.key === String(n));
    if (vorh) { vorh.zusatz = `${rolle}, ${vorh.zusatz}`; continue; }
    const dd = adrDD.find((d) => d.key === String(n));
    kontakteAuftrag.push({ key: String(n), text: dd?.text ?? `Kontakt ${n}`, zusatz: dd?.zusatz ? `${rolle} · ${dd.zusatz}` : rolle });
  }

  const titel = isNew
    ? `Neuer ${typ === 'H' ? 'Holzträgerauftrag' : 'Frachtauftrag'} ${vorschau}`
    : `${typ === 'H' ? 'Holzträgerauftrag' : 'Frachtauftrag'} ${nr}`;
  const unter = isNew ? 'Noch nicht gespeichert (Nummer wird beim Speichern vergeben)'
    : a.faktura ? `Fakturiert mit ${a.faktura} am ${dat(a.fakturadatum)}` : 'Offen';

  // Anzeige: Name des gewählten Kontakts (der Schlüssel steht am Eintrag, nicht im Feld)
  const adrName = (f: 'kunde' | 'unternehmer' | 'rechnungsempfaenger') => {
    const n = a[f];
    if (!n) return '';
    return adrDD.find((d) => d.key === String(n))?.text ?? adr[f]?.kundenname ?? `Kontakt ${n}`;
  };
  const adrCombo = (f: 'kunde' | 'unternehmer' | 'rechnungsempfaenger') => (
    <AuswahlBox style={full} wert={a[f] ? String(a[f]) : ''} placeholder="Name oder Ort eingeben" readonly={!mayEdit} max={50}
                eintraege={adrDD.length ? adrDD : a[f] ? [{ key: String(a[f]), text: adrName(f) }] : []}
                onWaehle={(k) => waehleAdresse(f, k ?? undefined)} />
  );

  const beteiligter = (titelB: string, f: 'kunde' | 'unternehmer' | 'rechnungsempfaenger', mitTel = true) => {
    const t = adrText(adr[f]);
    return (
      <Spalte titel={titelB}>
        <F label="Name">{adrCombo(f)}</F>
        <F label="Straße"><Text>{t.strasse}</Text></F>
        <F label="Land/PLZ/Ort"><Text>{t.ort}</Text></F>
        {mitTel && <F label="Telefon"><Text>{t.telefon}</Text></F>}
        <F label="E-Mail"><Text>{t.email}</Text></F>
      </Spalte>
    );
  };

  const werteSelect = (typW: keyof Werte, f: 'fahrzeugtyp' | 'ladegut' | 'ladeweise' | 'palettentausch', neu = true) => (
    <FlexBox style={{ gap: '0.5rem' }}>
      <Select style={{ flex: 1 }} disabled={!mayEdit} onChange={(e) => set(f, e.detail.selectedOption.dataset.key || null)}>
        {!a[f] && <Option data-key="" selected />}
        {(werte?.[typW] ?? []).filter((w) => w.aktiv || w.key === a[f]).map((w) => (
          <Option key={w.key} data-key={w.key} selected={w.key === a[f]}>{w.text}</Option>
        ))}
        {a[f] && werte && !werte[typW].some((w) => w.key === a[f]) && <Option data-key={a[f]!} selected>{a[f]}</Option>}
      </Select>
      {neu && mayEdit && <Button icon="add" onClick={() => setWertTyp(typW)}>Neu</Button>}
    </FlexBox>
  );

  const stopForm = (i: number) => {
    const s = a.stops[i];
    const inp = (f: keyof Stop, max: number, w?: string, ph?: string) => (
      <Input style={{ width: w ?? '100%' }} maxlength={max} value={(s[f] as string) ?? ''} readonly={!mayEdit} placeholder={ph}
             onInput={(e) => setStop(i, f, e.target.value)} />
    );
    const datum = (f: 'datum' | 'datum_e') => (
      <DatePicker style={{ width: '10rem' }} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={s[f] ?? ''} readonly={!mayEdit}
                  onChange={(e) => setStop(i, f, e.detail.value)} />
    );
    return (
      <Spalten n={2}>
        <Spalte titel="Absender">
          <F label="Firma">{inp('firma', 30)}</F>
          <F label="Straße">{inp('strasse', 30)}</F>
          <F label="Land / PLZ Ort"><FlexBox style={{ gap: '0.5rem' }}>{inp('land', 3, '4rem')}{inp('plzort', 30)}</FlexBox></F>
          <F label="Ladenummer">{inp('ladenummer', 30)}</F>
          <F label="Zeitvorgabe Laden"><FlexBox style={{ gap: '0.5rem' }}>{datum('datum')}{inp('zeit', 30, undefined, 'Uhrzeit / Zeitfenster')}</FlexBox></F>
        </Spalte>
        <Spalte titel="Empfänger">
          <F label="Firma">{inp('firma_e', 30)}</F>
          <F label="Straße">{inp('strasse_e', 30)}</F>
          <F label="Land / PLZ Ort" required={!!s.firma_e}><FlexBox style={{ gap: '0.5rem' }}>{inp('land_e', 3, '4rem')}{inp('plzort_e', 30)}</FlexBox></F>
          <F label="Zeitvorgabe Entladen"><FlexBox style={{ gap: '0.5rem' }}>{datum('datum_e')}{inp('zeit_e', 30, undefined, 'Uhrzeit / Zeitfenster')}</FlexBox></F>
        </Spalte>
      </Spalten>
    );
  };

  return (
    <>
      <ObjectPage
        style={{ height: '100%' }}
        mode="Default"
        hidePinButton
        titleArea={
          <ObjectPageTitle
            header={<Title level="H3" wrappingType="Normal">{titel}</Title>}
            subHeader={<Text>{unter}</Text>}
            actionsBar={
              <FlexBox style={{ gap: '0.5rem' }} alignItems="Center">
                {darfBearbeiten && <Button design="Emphasized" icon="save" loading={busy} onClick={save}>Speichern</Button>}
                <MenuButton text="Drucken" icon="print" items={[
                  { text: 'Transportauftrag', onClick: () => drucken('T') },
                  { text: 'Lieferschein', onClick: () => drucken('L') },
                  { text: 'Rechnung', disabled: !a.faktura, onClick: () => drucken('R') },
                ]} />
                {!isNew && <ChangeHistoryButton objectType="AUFTRAG" objectKey={nr!} />}
                <Button icon="decline" design="Transparent" onClick={() => navigate('/transport/auftraege')} />
              </FlexBox>
            }
          />
        }
      >
        <ObjectPageSection id="beteiligte" titleText="Beteiligte" hideTitleText>
          <ObjectPageSubSection id="beteiligte-sub" titleText="Beteiligte"
            actions={can('transport.kontakte:edit') ? <>
              <Button icon="add-contact" design="Transparent" onClick={() => setKontakt('NEU')}>Kontakt anlegen</Button>
              <Button icon="edit" design="Transparent" onClick={() => kontakteAuftrag.length ? setKontakt('EDIT') : toast('Diesem Auftrag ist noch kein Kontakt zugeordnet.')}>Kontakt bearbeiten</Button>
            </> : undefined}>
            <SperrHinweis s={sperre} style={{ marginBottom: '1rem' }} />
            {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
            {!!a.faktura && (
              <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
                Der Auftrag ist fakturiert ({a.faktura} vom {dat(a.fakturadatum)}) und kann nicht mehr geändert werden –
                ausgenommen „Dokumente fehlen“, die Besonderheiten und die Zuordnung von Dokumenten.
              </MessageStrip>
            )}
            <Spalten n={3}>
              {beteiligter('Kunde', 'kunde')}
              {beteiligter('Unternehmer', 'unternehmer')}
              {beteiligter('Abweichender Rechnungsempfänger', 'rechnungsempfaenger', false)}
            </Spalten>
          </ObjectPageSubSection>
        </ObjectPageSection>

        <ObjectPageSection id="auftragsdaten" titleText="Auftragsdaten" hideTitleText>
          <ObjectPageSubSection id="auftragsdaten-sub" titleText="Auftragsdaten">
            <Spalten n={3}>
              <Spalte titel="Auftrag">
                <F label="Auftragsnummer"><Text>{isNew ? `${vorschau} (vorläufig)` : nr}</Text></F>
                <F label="Anlagedatum">
                  <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={a.anlagedatum ?? ''} readonly={!mayEdit}
                              onChange={(e) => set('anlagedatum', e.detail.value || null)} />
                </F>
                <F label="Leistungsdatum">
                  <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={a.leistungsdatum ?? ''} readonly={!mayEdit}
                              onChange={(e) => set('leistungsdatum', e.detail.value || null)} />
                </F>
                <F label="Auftragsnr. Kunde"><Input style={full} maxlength={40} value={a.ordernummer ?? ''} readonly={!mayEdit} onInput={(e) => set('ordernummer', e.target.value)} /></F>
                <F label="Frachtpreis EK"><BetragInput value={a.frachtpreis_ek} readonly={!mayEdit} onChange={(v) => set('frachtpreis_ek', v)} /></F>
                <F label="Frachtpreis VK"><BetragInput value={a.frachtpreis_vk} readonly={!mayEdit} onChange={(v) => set('frachtpreis_vk', v)} /></F>
              </Spalte>
              <Spalte titel="Fahrzeug und Ladung">
                <F label="Kennzeichen"><Input style={full} maxlength={20} value={a.kennzeichen ?? ''} readonly={!mayEdit} onInput={(e) => set('kennzeichen', e.target.value)} /></F>
                <F label="Fahrzeugtyp">{werteSelect('FAHRZEUGTYP', 'fahrzeugtyp')}</F>
                <F label="Ladegut">{werteSelect('LADEGUT', 'ladegut')}</F>
                <F label="Gewicht">
                  <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                    <Input style={{ width: '8rem' }} maxlength={4} value={a.gewicht ?? ''} readonly={!mayEdit} onInput={(e) => set('gewicht', e.target.value)} />
                    <Text>in T</Text>
                  </FlexBox>
                </F>
                <F label="Lademeter">
                  <FlexBox alignItems="Center" style={{ gap: '0.5rem' }}>
                    <Input style={{ width: '8rem' }} value={a.lademeter === null || a.lademeter === undefined ? '' : String(a.lademeter).replace('.', ',')} readonly={!mayEdit}
                           onInput={(e) => set('lademeter', e.target.value.trim() ? e.target.value : null)} />
                    <Text>in M</Text>
                  </FlexBox>
                </F>
                <F label="Ladeweise">{werteSelect('LADEWEISE', 'ladeweise')}</F>
                <F label="Palettentausch">{werteSelect('PALETTENTAUSCH', 'palettentausch', false)}</F>
              </Spalte>
              <Spalte titel="Rechnung">
                <F label="MwSt berechnen"><CheckBox checked={a.steuerrelevant} readonly={!mayEdit} onChange={(e) => set('steuerrelevant', e.target.checked)} /></F>
                {!isNew && <F label="Rechnungsbetrag"><Text><b>{betrag(a.rgbetrag)} EUR</b></Text></F>}
                <F label="Faktura">
                  {a.faktura
                    ? <ObjectStatus state="Positive">{a.faktura} vom {dat(a.fakturadatum)}</ObjectStatus>
                    : <ObjectStatus state="Critical">offen</ObjectStatus>}
                </F>
                <F label="Dokumente fehlen">
                  <Switch textOn="Ja" textOff="Nein" checked={a.dok_fehlen} disabled={!darfBearbeiten} onChange={(e) => set('dok_fehlen', e.target.checked)} />
                </F>
              </Spalte>
            </Spalten>
          </ObjectPageSubSection>
        </ObjectPageSection>

        {showStops ? (
          <ObjectPageSection id="stops" titleText="Stops" hideTitleText>
            {[0, 1].map((i) => (
              <ObjectPageSubSection key={i} id={`stop${i + 1}`} titleText={i === 0 ? 'Erster Stop' : 'Zweiter Stop'}
                actions={mayEdit ? <Button icon="copy" design="Transparent" onClick={() => kundeUebernehmen(i)}>Kundenadresse als Absender übernehmen</Button> : undefined}>
                {stopForm(i)}
              </ObjectPageSubSection>
            ))}
          </ObjectPageSection>
        ) : <></>}

        {showTraeger ? (
          <ObjectPageSection id="traeger" titleText="Holzträger" hideTitleText>
            <ObjectPageSubSection id="traeger-sub" titleText="Holzträger"
              actions={<FlexBox alignItems="Center" style={{ gap: '0.5rem' }}><Label>Summe:</Label><Text><b>{betrag(traegerSumme)} EUR</b></Text></FlexBox>}>
              <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: '40rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                    <th style={{ padding: '0.5rem', width: '8rem', fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>Menge</th>
                    <th style={{ fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>Produkt</th>
                    <th style={{ width: '11rem', textAlign: 'right', fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>Einzelpreis</th>
                    <th style={{ width: '11rem', textAlign: 'right', paddingRight: '0.5rem', fontWeight: 'normal', color: 'var(--sapContent_LabelColor)' }}>Gesamtpreis</th>
                  </tr>
                </thead>
                <tbody>
                  {a.traeger.map((t, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                      <td style={{ padding: '0.25rem 0.5rem' }}>
                        <Input style={{ width: '6rem', textAlign: 'right' }} type="Number" value={String(t.menge)} readonly={!mayEdit}
                               onInput={(e) => setTr(i, 'menge', Math.max(0, Math.trunc(Number(e.target.value) || 0)))} />
                      </td>
                      <td><Input style={full} maxlength={40} value={t.prod_txt ?? ''} readonly={!mayEdit} onInput={(e) => setTr(i, 'prod_txt', e.target.value)} /></td>
                      <td style={{ textAlign: 'right' }}><BetragInput value={t.preis} readonly={!mayEdit} onChange={(v) => setTr(i, 'preis', v)} /></td>
                      <td style={{ textAlign: 'right', paddingRight: '0.5rem' }}><b>{betrag(t.menge * t.preis)} EUR</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </ObjectPageSubSection>
          </ObjectPageSection>
        ) : <></>}

        {!isNew && nr ? (
          <ObjectPageSection id="dokumente" titleText="Dokumente" hideTitleText>
            <ObjectPageSubSection id="dokumente-sub" titleText="Dokumente">
              <AuftragDokumente nr={nr} edit={darfBearbeiten} ordnerStand={ordnerStand} />
            </ObjectPageSubSection>
          </ObjectPageSection>
        ) : <></>}

        <ObjectPageSection id="besonderheiten" titleText="Besonderheiten" hideTitleText>
          <ObjectPageSubSection id="besonderheiten-sub" titleText="Besonderheiten">
            <TextArea rows={8} growing style={full} value={a.besonderheiten ?? ''} readonly={!darfBearbeiten}
                      onInput={(e) => set('besonderheiten', e.target.value)} />
          </ObjectPageSubSection>
        </ObjectPageSection>
      </ObjectPage>

      <DocsDialog docs={docs} onClose={() => { setDocs(null); setOrdnerStand((v) => v + 1); }} />
      <XRechnungDialog data={xr} onClose={() => setXr(null)} />
      <KontaktDialog modus={kontakt} auswahl={kontakteAuftrag} onClose={() => setKontakt(null)}
                     onSaved={async () => {
                       setKontakt(null);
                       await ladeAdressen();
                       for (const f of ['kunde', 'unternehmer', 'rechnungsempfaenger'] as const) {
                         if (a[f]) waehleAdresse(f, String(a[f]));
                       }
                     }} />
      <WertDialog typ={wertTyp} onClose={() => setWertTyp(null)}
                  onSaved={async (t, key) => {
                    setWertTyp(null);
                    await ladeWerte();
                    const f = t === 'FAHRZEUGTYP' ? 'fahrzeugtyp' : t === 'LADEGUT' ? 'ladegut' : 'ladeweise';
                    setA((x) => (x ? { ...x, [f]: key } : x));
                  }} />
    </>
  );
}

/** Betragsfeld mit deutscher Eingabe (1.234,56) */
function BetragInput({ value, onChange, readonly }: { value: number; onChange: (v: number) => void; readonly?: boolean }) {
  const [txt, setTxt] = useState(betrag(value));
  useEffect(() => setTxt(betrag(value)), [value]);
  return (
    <Input style={{ width: '10rem', textAlign: 'right' }} value={txt} readonly={readonly} icon={<Text style={{ padding: '0 0.5rem' }}>EUR</Text>}
           onInput={(e) => setTxt(e.target.value)}
           onChange={(e) => {
             const n = Number(e.target.value.replace(/\./g, '').replace(',', '.'));
             if (Number.isFinite(n)) onChange(Math.round(n * 100) / 100);
             else setTxt(betrag(value));
           }} />
  );
}

