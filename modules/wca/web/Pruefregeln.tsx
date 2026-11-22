import { useEffect, useState, type ReactNode } from 'react';
import { Button, CheckBox, DatePicker, Input, MessageStrip, ObjectStatus, Option, Select, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { REGELN } from '../server/logik/standard';
import type { Einstellungen, PersonVorgabe, Stufe, WortRegel } from '../server/typen';
import { Freigaben } from './Freigaben';
import { Personenvorgaben } from './Personenvorgaben';
import { ARTEN, eingabeZahl, KATEGORIEN, STUFEN, W, zahlEingabe } from './util';

export interface EinstellungenAntwort { einstellungen: Einstellungen; standard: Einstellungen; vorgaben: PersonVorgabe[]; personen: string[] }

const BUNDESLAENDER = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'];

/** Zahl mit Komma; der Text bleibt beim Tippen stehen („0,“), übernommen wird jede gültige Zahl */
export function ZahlFeld({ label, value, onChange, readonly, einheit, placeholder }: {
  label: string; value: number | null; onChange: (v: number | null) => void; readonly?: boolean; einheit?: string; placeholder?: string;
}) {
  const [t, setT] = useState(zahlEingabe(value));
  useEffect(() => { if (eingabeZahl(t) !== value) setT(zahlEingabe(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FieldBox label={einheit ? `${label} (${einheit})` : label}>
      <Input style={{ width: '100%' }} value={t} readonly={readonly} placeholder={placeholder} data-kein-autofill
             onInput={(e) => { setT(e.target.value); onChange(eingabeZahl(e.target.value)); }} />
    </FieldBox>
  );
}

function TextFeld({ label, value, onChange, readonly, zeilen, hinweis, wide = true }: {
  label: string; value: string; onChange: (v: string) => void; readonly?: boolean; zeilen?: number; hinweis?: ReactNode; wide?: boolean;
}) {
  return (
    <FieldBox label={label} wide={wide}>
      {zeilen ? <TextArea rows={zeilen} value={value} readonly={readonly} growing growingMaxRows={20} onInput={(e) => onChange(e.target.value)} />
        : <Input style={{ width: '100%' }} value={value} readonly={readonly} onInput={(e) => onChange(e.target.value)} />}
      {hinweis && <span className="portal-muted portal-small">{hinweis}</span>}
    </FieldBox>
  );
}

function Haken({ label, checked, onChange, readonly }: { label: string; checked: boolean; onChange: (v: boolean) => void; readonly?: boolean }) {
  return <CheckBox text={label} checked={checked} readonly={readonly} onChange={(e) => onChange(e.target.checked)} />;
}

function StufeWahl({ label, value, onChange, readonly, keine }: { label: string; value: Stufe | null; onChange: (v: Stufe | null) => void; readonly?: boolean; keine?: string }) {
  return (
    <FieldBox label={label}>
      <Select style={{ width: '100%' }} disabled={readonly} onChange={(e) => {
        const k = (e.detail.selectedOption as HTMLElement).dataset.k ?? '';
        onChange(k ? Number(k) as Stufe : null);
      }}>
        {keine && <Option data-k="" selected={value === null}>{keine}</Option>}
        {STUFEN.map((s) => <Option key={s.key} data-k={String(s.key)} selected={value === s.key}>{s.text}</Option>)}
      </Select>
    </FieldBox>
  );
}

/** App „Prüfregeln“: Schwellen, Listen, Regeln an/aus, Wortlisten und Personenvorgaben der Zeitenkontrolle */
export function Pruefregeln() {
  const can = useCan();
  const edit = can('wca.einstellungen:edit');
  const d = useLoad(() => api.get<EinstellungenAntwort>(`${W}/einstellungen`), []);
  const [e, setE] = useState<Einstellungen | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zuruecksetzen, setZuruecksetzen] = useState(false);
  useEffect(() => { if (d.data) setE(structuredClone(d.data.einstellungen)); }, [d.data]);

  const geaendert = !!e && !!d.data && JSON.stringify(e) !== JSON.stringify(d.data.einstellungen);
  const set = <K extends keyof Einstellungen>(k: K, v: Einstellungen[K]) => setE((alt) => (alt ? { ...alt, [k]: v } : alt));
  const zahlSet = (k: keyof Einstellungen) => (v: number | null) => { if (v !== null) set(k, v as never); };
  const wort = (id: string, teil: Partial<WortRegel>) => setE((alt) => (alt ? { ...alt, wortRegeln: { ...alt.wortRegeln, [id]: { ...alt.wortRegeln[id], ...teil } } } : alt));

  async function speichern() {
    if (!e) return;
    setBusy(true); setError(null);
    try {
      await api.put(`${W}/einstellungen`, e);
      toast('Prüfregeln gesichert');
      await d.reload();
    } catch (x) { setError((x as Error).message); } finally { setBusy(false); }
  }

  const ro = !edit;
  return (
    <AppPage title="WCA Prüfregeln" subtitle="Schwellen, Listen und Regeln der Zeitenkontrolle; Vorgaben je Person"
             actions={<ChangeHistoryButton objectType="WCA_EINST" objectKey="1" />}
             footer={edit && e ? (
               <>
                 <Button design="Emphasized" disabled={!geaendert} loading={busy} onClick={speichern}>Sichern</Button>
                 <Button disabled={busy} onClick={() => setZuruecksetzen(true)}>Auf Standard zurücksetzen</Button>
                 <Button disabled={!geaendert || busy} onClick={() => d.data && setE(structuredClone(d.data.einstellungen))}>Verwerfen</Button>
               </>
             ) : undefined}>
      {(d.error || error) && <MessageStrip design="Negative" onClose={() => setError(null)}>{d.error ?? error}</MessageStrip>}
      {geaendert && <MessageStrip design="Information" hideCloseButton>Ungesicherte Änderungen – unten „Sichern“.</MessageStrip>}
      {e && d.data && (
        <>
          <Section title="Vollständigkeit und Feiertage">
            <FormGrid>
              <ZahlFeld label="Toleranz je Tag" einheit="h" value={e.toleranz} onChange={zahlSet('toleranz')} readonly={ro} />
              <FieldBox label="Bundesland (Feiertage Deutschland)">
                <Select style={{ width: '100%' }} disabled={ro} onChange={(x) => set('bundesland', (x.detail.selectedOption as HTMLElement).dataset.k ?? 'BW')}>
                  {BUNDESLAENDER.map((b) => <Option key={b} data-k={b} selected={e.bundesland === b}>{b}</Option>)}
                </Select>
              </FieldBox>
              <FieldBox label="Account-Pflicht ab">
                <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={e.accountPflichtAb} readonly={ro} style={{ width: '100%' }}
                            placeholder="automatisch" onChange={(x) => set('accountPflichtAb', x.detail.value ?? '')} />
                <span className="portal-muted portal-small">leer = automatisch (ab dem Monat, seit dem kaum noch ohne Account gebucht wird)</span>
              </FieldBox>
              <TextFeld wide={false} label="Schlüsselmuster interner Projekte" value={e.internMuster} onChange={(v) => set('internMuster', v)} readonly={ro}
                        hinweis="? = ein Buchstabe oder eine Ziffer, * = beliebig; mehrere mit Komma" />
              <TextFeld label="Zusätzliche Feiertage" zeilen={3} value={e.feiertage} onChange={(v) => set('feiertage', v)} readonly={ro}
                        hinweis="je Zeile „Standort JJJJ-MM-TT Name“, * = alle Standorte, z. B. „DE 2026-12-24 Heiligabend“" />
            </FormGrid>
          </Section>

          <Section title="Kontierung und Plausibilität">
            <FormGrid>
              <TextFeld label="Error-Accounts" zeilen={3} value={e.errorAccounts} onChange={(v) => set('errorAccounts', v)} readonly={ro} hinweis="ein Account je Zeile" />
              <TextFeld label="Kunden-Aliasse" zeilen={4} value={e.aliasse} onChange={(v) => set('aliasse', v)} readonly={ro} hinweis="je Zeile „Kürzel = Kundenname“" />
              <ZahlFeld label="Tag mit vielen Stunden ab" einheit="h" value={e.langerTag} onChange={zahlSet('langerTag')} readonly={ro} />
              <ZahlFeld label="Lange Einzelbuchung ab" einheit="h" value={e.langeBuchung} onChange={zahlSet('langeBuchung')} readonly={ro} />
            </FormGrid>
          </Section>

          <Section title="Texte">
            <FormGrid>
              <ZahlFeld label="Kurzer Text: höchstens Wörter" value={e.duennWoerter} onChange={zahlSet('duennWoerter')} readonly={ro} />
              <ZahlFeld label="Kurzer Text: ab Stunden an einem Tag" einheit="h" value={e.duennH} onChange={zahlSet('duennH')} readonly={ro} />
              <ZahlFeld label="Gleicher Text: ab Tagen" value={e.wiederholungTage} onChange={zahlSet('wiederholungTage')} readonly={ro} />
              <ZahlFeld label="Gleicher Text: ab Stunden" einheit="h" value={e.wiederholungMinH} onChange={zahlSet('wiederholungMinH')} readonly={ro} />
              <TextFeld label="Regeltermine" zeilen={3} value={e.regeltermine} onChange={(v) => set('regeltermine', v)} readonly={ro}
                        hinweis="kommagetrennt; gelten nicht als „gleicher Text“ und nicht für das Regelwerk" />
              <TextFeld label="Weitere Allgemeinbegriffe" zeilen={2} value={e.allgemeinZusatz} onChange={(v) => set('allgemeinZusatz', v)} readonly={ro} hinweis="kommagetrennt" />
            </FormGrid>
          </Section>

          <Section title="Regelwerk für Rückmeldetexte">
            <FormGrid>
              <FieldBox label="Regelwerk"><Haken label="prüfen" checked={e.regelwerkAn} onChange={(v) => set('regelwerkAn', v)} readonly={ro} /></FieldBox>
              <FieldBox label="Gültig ab">
                <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={e.regelwerkAb} readonly={ro} style={{ width: '100%' }}
                            onChange={(x) => set('regelwerkAb', x.detail.value ?? '')} />
              </FieldBox>
              <ZahlFeld label="Mindestens Wörter" value={e.regelwerkMinWoerter} onChange={zahlSet('regelwerkMinWoerter')} readonly={ro} />
              <FieldBox label="ID am Anfang"><Haken label="Pflicht bei abrechenbaren Einträgen" checked={e.regelwerkIdBillable} onChange={(v) => set('regelwerkIdBillable', v)} readonly={ro} /></FieldBox>
            </FormGrid>
          </Section>

          <Section title="Regeln an/aus" count={REGELN.length} flush>
            <div className="portal-tabrahmen">
              <table className="portal-wca-tabelle">
                <thead><tr><th>Aktiv</th><th>Regel</th><th>Name</th><th>Art</th><th>Erkennung</th></tr></thead>
                <tbody>
                  {REGELN.map((r) => (
                    <tr key={r.id}>
                      <td><CheckBox checked={!e.aus[r.id]} readonly={ro} accessibleName={`${r.id} aktiv`}
                                    onChange={(x) => set('aus', { ...e.aus, [r.id]: !x.target.checked })} /></td>
                      <td><b>{r.id}</b></td>
                      <td>{r.name}</td>
                      <td className="portal-nowrap">{KATEGORIEN[r.kategorie]} · {ARTEN[r.art]}</td>
                      <td className="portal-wca-breit portal-small">{r.erkennung}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Wortlisten-Regeln" count={Object.keys(e.wortRegeln).length}>
            <p className="portal-muted portal-small">
              Wörter kommagetrennt; * am Ende = Wortanfang, sonst ganzes Wort; Leerzeichen = beliebige Leerzeichen; „re:“ am Anfang = regulärer Ausdruck.
            </p>
            <div className="portal-stack">
              {Object.entries(e.wortRegeln).map(([id, w]) => (
                <div key={id} className="portal-wca-wortregel">
                  <div className="portal-row">
                    <b>{id}</b> {w.name} {e.aus[id] && <ObjectStatus state="None">abgeschaltet</ObjectStatus>}
                  </div>
                  <FormGrid>
                    <TextFeld wide={false} label="Name" value={w.name} onChange={(v) => wort(id, { name: v })} readonly={ro} />
                    <FieldBox label="Rubrik">
                      <Select style={{ width: '100%' }} disabled={ro} onChange={(x) => wort(id, { art: (x.detail.selectedOption as HTMLElement).dataset.k as 'ns' | 'fr' })}>
                        <Option data-k="ns" selected={w.art === 'ns'}>Nichtssagend</Option>
                        <Option data-k="fr" selected={w.art === 'fr'}>Fragwürdig</Option>
                      </Select>
                    </FieldBox>
                    <StufeWahl label="Stufe bei nicht abrechenbaren" keine="gilt nicht" value={w.stufeIntern} onChange={(v) => wort(id, { stufeIntern: v })} readonly={ro} />
                    <StufeWahl label="Stufe bei abrechenbaren" value={w.stufeBillable} onChange={(v) => v && wort(id, { stufeBillable: v })} readonly={ro} />
                    <FieldBox label="Geltung"><Haken label="nur abrechenbare Einträge" checked={w.nurAbrechenbar} onChange={(v) => wort(id, { nurAbrechenbar: v })} readonly={ro} /></FieldBox>
                    <TextFeld label="Wörter" zeilen={3} value={w.woerter} onChange={(v) => wort(id, { woerter: v })} readonly={ro} />
                    <TextFeld label="Tipp" value={w.tipp} onChange={(v) => wort(id, { tipp: v })} readonly={ro} />
                  </FormGrid>
                </div>
              ))}
            </div>
          </Section>

          <Personenvorgaben daten={d.data} edit={edit} onGeaendert={() => d.reload()} />
          <Freigaben edit={edit} />
        </>
      )}
      <ConfirmDialog open={zuruecksetzen} title="Auf Standard zurücksetzen" confirmText="Zurücksetzen"
                     text="Alle Prüfregeln, Listen und Wortlisten auf die Standardwerte setzen? Gesichert wird erst mit „Sichern“. Personenvorgaben bleiben unverändert."
                     onConfirm={() => { setZuruecksetzen(false); if (d.data) setE(structuredClone(d.data.standard)); }} onCancel={() => setZuruecksetzen(false)} />
    </AppPage>
  );
}
