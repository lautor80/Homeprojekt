import { useEffect, useMemo, useState } from 'react';
import {
  Button, CheckBox, ComboBox, ComboBoxItem, DatePicker, Icon, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, SegmentedButton, SegmentedButtonItem, Select, StepInput, Text,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO, dat, eur } from '../util';
import { hhmm, min, tagPlus } from './PlatzBuchen';
import './platz.css';
import { AuswahlBox } from '@core/components/AuswahlBox';

/**
 * Serienbuchung (Hallenwart): mehrere Plätze über mehrere Stunden, einmalig oder wiederholt
 * (wöchentlich, zweiwöchentlich, monatlich). Vorab Übersicht Termine × Plätze und Vorschläge,
 * welche Plätze gemeinsam frei sind (z. B. „Platz 1, 2, 5 – an allen Terminen frei“).
 */
const S = `${TCO}/platz/serie`;
type Rhythmus = 'EINMALIG' | 'WOECHENTLICH' | 'ZWEIWOECHENTLICH' | 'MONATLICH';
interface StammPlatz { id: number; name: string; art: 'HALLE' | 'FREI'; raster: number; zeit_von: string; zeit_bis: string; abrechnen: boolean }
interface Stamm { plaetze: StammPlatz[]; mitglieder: { adrnr: string; name: string }[]; rhythmen: Record<Rhythmus, string>; heute: string }
interface Preis { betrag: number | null; kostenfrei: boolean; fehler: string | null; text: string }
interface PlatzV { id: number; name: string; art: string; abrechnen: boolean; termine: (string | null)[]; frei: number; preis: Preis }
interface Kombi { plaetze: number[]; namen: string[]; frei: number; vollstaendig: boolean; text: string }
interface Pruefung { termine: { datum: string; wochentag: string }[]; rhythmus: string; plaetze: PlatzV[]; kombinationen: Kombi[] }

const zeiten = () => { const o: string[] = []; for (let m = 6 * 60; m <= 24 * 60; m += 30) o.push(m === 1440 ? '24:00' : hhmm(m)); return o; };
const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const wt = (iso: string) => WT[new Date(`${iso}T12:00:00Z`).getUTCDay()];

export function Serienbuchung() {
  const [stamm, setStamm] = useState<Stamm | null>(null);
  const [fuer, setFuer] = useState<'MITGLIED' | 'INTERN'>('MITGLIED');
  const [adrnr, setAdrnr] = useState('');
  const [intern, setIntern] = useState('');
  const [anzahl, setAnzahl] = useState(1);
  const [art, setArt] = useState<'' | 'HALLE' | 'FREI'>('');
  const [kandidaten, setKandidaten] = useState<number[]>([]);
  const [ab, setAb] = useState('');
  const [bisDatum, setBisDatum] = useState('');
  const [von, setVon] = useState('18:00');
  const [bis, setBis] = useState('20:00');
  const [rhythmus, setRhythmus] = useState<Rhythmus>('WOECHENTLICH');
  const [text, setText] = useState('');
  const [pruefung, setPruefung] = useState<Pruefung | null>(null);
  const [auswahl, setAuswahl] = useState<number[]>([]);
  const [ueberspringen, setUeberspringen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Stamm>(`${S}/stamm`).then((s) => { setStamm(s); setAb(tagPlus(s.heute, 1)); setBisDatum(tagPlus(s.heute, 7 * 12)); })
      .catch((e) => setError((e as Error).message));
  }, []);
  // jede Änderung der Anfrage macht die Prüfung ungültig
  useEffect(() => { setPruefung(null); setAuswahl([]); }, [anzahl, art, kandidaten, ab, bisDatum, von, bis, rhythmus]);

  const anfrage = () => ({
    ab, bis_datum: rhythmus === 'EINMALIG' ? null : bisDatum, von, bis, rhythmus, anzahl, art: art || null, plaetze: kandidaten,
  });
  async function pruefen() {
    setBusy(true); setError(null);
    try {
      const p = await api.post<Pruefung>(`${S}/pruefen`, anfrage());
      setPruefung(p);
      setAuswahl(p.kombinationen[0]?.plaetze ?? []);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function buchen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(S, {
        ...anfrage(), plaetze: auswahl, adrnr: fuer === 'MITGLIED' ? adrnr : null, intern: fuer === 'INTERN' ? intern : null,
        text: text.trim() || null, ueberspringen,
      });
      toast(r.text, 8000);
      setPruefung(null); setAuswahl([]);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const gewaehlt = useMemo(() => (pruefung?.plaetze ?? []).filter((p) => auswahl.includes(p.id)), [pruefung, auswahl]);
  const belegt = gewaehlt.reduce((s, p) => s + p.termine.filter(Boolean).length, 0);
  const anzahlBuchungen = gewaehlt.reduce((s, p) => s + p.frei, 0);
  const summe = fuer === 'INTERN' ? 0 : gewaehlt.reduce((s, p) => s + (p.preis.betrag ?? 0), 0);
  const kunde = fuer === 'MITGLIED' ? stamm?.mitglieder.find((m) => m.adrnr === adrnr)?.name : intern.trim();
  const dauer = (bis === '24:00' ? 1440 : min(bis)) - min(von);
  const plaetzeFilter = (stamm?.plaetze ?? []).filter((p) => !art || p.art === art);

  return (
    <AppPage title="Serienbuchung" subtitle="Hallenwart: mehrere Plätze, mehrere Stunden, einmalig oder als Abo">
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}

      <Section title="1 · Was wird gebraucht?">
        <FormGrid>
          <FieldBox label="Gebucht für" required>
            <SegmentedButton onSelectionChange={(e) => setFuer((e.detail.selectedItems[0] as HTMLElement).dataset.k as 'MITGLIED')}>
              <SegmentedButtonItem data-k="MITGLIED" selected={fuer === 'MITGLIED'} icon="person-placeholder">Mitglied</SegmentedButtonItem>
              <SegmentedButtonItem data-k="INTERN" selected={fuer === 'INTERN'} icon="group">Verein (ohne Rechnung)</SegmentedButtonItem>
            </SegmentedButton>
          </FieldBox>
          {fuer === 'MITGLIED'
            ? <FieldBox label="Mitglied" required>
                <AuswahlBox wert={adrnr} placeholder="Mitglied suchen"
                            eintraege={(stamm?.mitglieder ?? []).map((m) => ({ key: m.adrnr, text: m.name, zusatz: m.adrnr }))}
                            onWaehle={(k) => setAdrnr(k ?? '')} />
              </FieldBox>
            : <FieldBox label="Bezeichnung" required>
                <Input value={intern} maxlength={60} placeholder="z. B. Medenspiel Herren 40, Jugendtraining" onInput={(e) => setIntern(e.target.value)} />
              </FieldBox>}
          <FieldBox label="Anzahl Plätze" required>
            <StepInput value={anzahl} min={1} max={Math.max(1, plaetzeFilter.length)} onChange={(e) => setAnzahl(Number(e.target.value))} />
          </FieldBox>
          <FieldBox label="Platzart">
            <SegmentedButton onSelectionChange={(e) => { setArt((e.detail.selectedItems[0] as HTMLElement).dataset.k as ''); setKandidaten([]); }}>
              <SegmentedButtonItem data-k="" selected={art === ''}>Alle</SegmentedButtonItem>
              <SegmentedButtonItem data-k="HALLE" selected={art === 'HALLE'}>Halle</SegmentedButtonItem>
              <SegmentedButtonItem data-k="FREI" selected={art === 'FREI'}>Freiplätze</SegmentedButtonItem>
            </SegmentedButton>
          </FieldBox>
          <FieldBox label="Nur diese Plätze berücksichtigen (leer = alle)" wide>
            <MultiComboBox placeholder="alle passenden Plätze"
                           onSelectionChange={(e) => setKandidaten(e.detail.items.map((i) => Number((i as HTMLElement).dataset.id)))}>
              {plaetzeFilter.map((p) => <MultiComboBoxItem key={p.id} data-id={p.id} text={p.name} selected={kandidaten.includes(p.id)} />)}
            </MultiComboBox>
          </FieldBox>
        </FormGrid>
      </Section>

      <Section title="2 · Wann?">
        <FormGrid>
          <FieldBox label="Wiederholung" required wide>
            <SegmentedButton onSelectionChange={(e) => setRhythmus((e.detail.selectedItems[0] as HTMLElement).dataset.k as Rhythmus)}>
              {(Object.keys(stamm?.rhythmen ?? { EINMALIG: '', WOECHENTLICH: '', ZWEIWOECHENTLICH: '', MONATLICH: '' }) as Rhythmus[]).map((r) => (
                <SegmentedButtonItem key={r} data-k={r} selected={rhythmus === r}>
                  {{ EINMALIG: 'Einmalig', WOECHENTLICH: 'Wöchentlich', ZWEIWOECHENTLICH: '2-wöchentlich', MONATLICH: 'Monatlich' }[r]}
                </SegmentedButtonItem>
              ))}
            </SegmentedButton>
          </FieldBox>
          <FieldBox label={rhythmus === 'EINMALIG' ? 'Datum' : 'Erster Termin (legt den Wochentag fest)'} required>
            <DatePicker formatPattern="EEEE, dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={ab} onChange={(e) => e.detail.value && setAb(e.detail.value)} />
          </FieldBox>
          {rhythmus !== 'EINMALIG' && (
            <FieldBox label="Letzter Termin spätestens" required>
              <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={bisDatum} onChange={(e) => e.detail.value && setBisDatum(e.detail.value)} />
            </FieldBox>
          )}
          <FieldBox label="Uhrzeit" required>
            <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
              <Select style={{ width: '7rem' }} onChange={(e) => setVon((e.detail.selectedOption as HTMLElement).dataset.k!)}>
                {zeiten().slice(0, -1).map((z) => <Option key={z} data-k={z} selected={von === z}>{z}</Option>)}
              </Select>
              <Text>bis</Text>
              <Select style={{ width: '7rem' }} onChange={(e) => setBis((e.detail.selectedOption as HTMLElement).dataset.k!)}>
                {zeiten().slice(1).map((z) => <Option key={z} data-k={z} selected={bis === z}>{z}</Option>)}
              </Select>
              <Text className="portal-muted">{dauer > 0 ? `${dauer / 60} Std.` : 'Ende vor Beginn'}</Text>
            </div>
          </FieldBox>
          <FieldBox label="Notiz"><Input value={text} maxlength={200} onInput={(e) => setText(e.target.value)} /></FieldBox>
        </FormGrid>
        <div className="portal-row" style={{ marginTop: '1rem' }}>
          <Button design="Emphasized" icon="search" disabled={busy || dauer <= 0 || !ab} onClick={pruefen}>Verfügbarkeit prüfen</Button>
          {rhythmus === 'MONATLICH' && ab && <Text className="portal-muted">Monatlich = gleicher Wochentag im Monat (z. B. jeder 2. Dienstag), wie der erste Termin.</Text>}
        </div>
      </Section>

      {pruefung && (
        <>
          <Section title={`3 · Vorschläge für ${anzahl} Platz/Plätze`} count={pruefung.kombinationen.length}>
            <Text className="portal-muted">{pruefung.rhythmus}, {von}–{bis} Uhr · {pruefung.termine.length} Termin(e)
              {pruefung.termine.length > 1 ? ` (${dat(pruefung.termine[0].datum)} – ${dat(pruefung.termine[pruefung.termine.length - 1].datum)})` : ''}</Text>
            <div className="portal-sb__kombis">
              {pruefung.kombinationen.map((k, i) => {
                const aktiv = k.plaetze.length === auswahl.length && k.plaetze.every((id) => auswahl.includes(id));
                return (
                  <button key={i} type="button" className={`portal-sb__kombi${aktiv ? ' portal-sb__kombi--aktiv' : ''}${k.vollstaendig ? '' : ' portal-sb__kombi--teil'}`}
                          onClick={() => setAuswahl(k.plaetze)}>
                    <Icon name={k.vollstaendig ? 'accept' : 'alert'} />
                    <span><b>{k.namen.join(', ')}</b><br /><small>{k.text}</small></span>
                    {aktiv && <ObjectStatus state="Information" inverted>gewählt</ObjectStatus>}
                  </button>
                );
              })}
            </div>
            {!pruefung.kombinationen.some((k) => k.vollstaendig) && (
              <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.5rem' }}>
                Keine Kombination ist an allen Terminen frei. Plätze in der Übersicht selbst wählen und belegte Termine auslassen – oder Zeit/Zeitraum ändern.
              </MessageStrip>
            )}
          </Section>

          <Section title="4 · Übersicht Termine × Plätze" flush status={<Text className="portal-muted">Platz per Klick im Kopf an- oder abwählen</Text>}>
            <div className="portal-sb__matrix-scroll">
              <table className="portal-sb__matrix">
                <thead>
                  <tr>
                    <th>Termin</th>
                    {pruefung.plaetze.map((p) => {
                      const an = auswahl.includes(p.id);
                      return (
                        <th key={p.id} className={an ? 'portal-sb__an' : ''}>
                          <CheckBox text={p.name} checked={an} onChange={(e) => setAuswahl(e.target.checked ? [...auswahl, p.id] : auswahl.filter((x) => x !== p.id))} />
                          <div className="portal-sb__kopfinfo">{p.frei}/{pruefung.termine.length} frei · {p.preis.kostenfrei ? 'kostenfrei' : p.preis.betrag === null ? 'Preis ?' : eur(p.preis.betrag)}</div>
                        </th>
                      );
                    })}
                    <th>gewählt frei</th>
                  </tr>
                </thead>
                <tbody>
                  {pruefung.termine.map((t, i) => {
                    const freiGew = gewaehlt.filter((p) => !p.termine[i]).length;
                    return (
                      <tr key={t.datum}>
                        <td className="portal-sb__datum"><b>{wt(t.datum)}</b> {dat(t.datum)}</td>
                        {pruefung.plaetze.map((p) => {
                          const k = p.termine[i];
                          return (
                            <td key={p.id} className={`${k ? 'portal-sb__belegt' : 'portal-sb__frei'}${auswahl.includes(p.id) ? ' portal-sb__an' : ''}`} title={k ?? 'frei'}>
                              {k ? <><Icon name="decline" /> <span>{k.startsWith('belegt') ? 'belegt' : k}</span></> : <Icon name="accept" />}
                            </td>
                          );
                        })}
                        <td>
                          <ObjectStatus state={!auswahl.length ? 'None' : freiGew === auswahl.length ? 'Positive' : freiGew ? 'Critical' : 'Negative'}>
                            {auswahl.length ? `${freiGew} von ${auswahl.length}` : '–'}
                          </ObjectStatus>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="5 · Buchen">
            <div className="portal-sb__summe">
              <div><Label>Gebucht für</Label><Text>{kunde || '–'}{fuer === 'INTERN' ? ' (vereinsintern, ohne Rechnung)' : ''}</Text></div>
              <div><Label>Plätze</Label><Text>{gewaehlt.map((p) => p.name).join(', ') || '–'}</Text></div>
              <div><Label>Art</Label><Text>{rhythmus === 'EINMALIG' ? 'Einzelbuchung' : `Abo – ${pruefung.rhythmus}`}</Text></div>
              <div><Label>Buchungen</Label><Text>{anzahlBuchungen}{belegt ? ` (+ ${belegt} belegt)` : ''}</Text></div>
              <div><Label>{rhythmus === 'EINMALIG' ? 'Preis gesamt' : 'Abo-Preis je Serie (Summe)'}</Label><Text>{fuer === 'INTERN' ? 'ohne Rechnung' : eur(summe)}</Text></div>
            </div>
            {belegt > 0 && (
              <CheckBox text={`${belegt} belegte Termin(e) auslassen und die übrigen buchen`} checked={ueberspringen} onChange={(e) => setUeberspringen(e.target.checked)} />
            )}
            {gewaehlt.length !== anzahl && auswahl.length > 0 && (
              <MessageStrip design="Information" hideCloseButton style={{ margin: '0.5rem 0' }}>Gewählt sind {gewaehlt.length} statt {anzahl} Platz/Plätze.</MessageStrip>
            )}
            <div className="portal-row" style={{ marginTop: '0.75rem' }}>
              <Button design="Emphasized" icon="accept" disabled={busy || !auswahl.length || (fuer === 'MITGLIED' ? !adrnr : !intern.trim()) || (belegt > 0 && !ueberspringen)}
                      onClick={buchen}>
                {rhythmus === 'EINMALIG' ? 'Verbindlich buchen' : `${gewaehlt.length} Abo-Serie(n) anlegen`}
              </Button>
            </div>
          </Section>
        </>
      )}
    </AppPage>
  );
}
