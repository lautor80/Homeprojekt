import { useEffect, useState, type ReactNode } from 'react';
import {
  AnalyticalTable, Bar, Button, ComboBox, ComboBoxItem, DatePicker, Input, FileUploader, FlexBox, Label, MessageStrip, ObjectStatus, Panel, SegmentedButton,
  SegmentedButtonItem, Tab, TabContainer, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { useCan, useSession } from '@core/session';
import { toast } from '@core/toast';
import { SperrHinweis, useSperre } from '@core/sperre';
import { TCO, dateiLesen } from './util';

type Verein = Record<string, string | number | null>;

export function TcoStammdaten() {
  const can = useCan();
  return (
    <AppPage title="Stammdaten TC Oberthal" subtitle="Vereinsdaten für Ausdrucke, Anbindungen und Übernahme aus SAP">
      <TabContainer contentBackgroundDesign="Transparent">
        <Tab text="Verein und Anbindungen" selected><VereinTab /></Tab>
        {can('tco.import:execute') ? <Tab text="Übernahme aus SAP"><ImportTab /></Tab> : null}
      </TabContainer>
    </AppPage>
  );
}

interface Test { ok: boolean; text: string; dauer_ms?: number }

/** Prüfknopf je Endpunkt: sendet die aktuellen Formularwerte (Geheimnisse maskiert = gespeicherter Wert) */
function Testen({ endpunkt, v }: { endpunkt: string; v: Verein }) {
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<Test | null>(null);
  return (
    <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.75rem', marginTop: '0.5rem' }}>
      <Button icon="connected" disabled={busy} onClick={async () => {
        setBusy(true); setR(null);
        try { setR(await api.post<Test>(`${TCO}/verein/test/${endpunkt}`, v)); } catch (e) { setR({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
      }}>{busy ? 'Prüfe …' : 'Verbindung prüfen'}</Button>
      {r && <ObjectStatus state={r.ok ? 'Positive' : 'Negative'} showDefaultIcon>{r.text}{r.dauer_ms != null ? ` (${(r.dauer_ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s)` : ''}</ObjectStatus>}
    </FlexBox>
  );
}

function Endpunkt({ titel, hinweis, endpunkt, v, ro, children }: { titel: string; hinweis: string; endpunkt: string; v: Verein; ro: boolean; children: ReactNode }) {
  return (
    <div style={{ borderTop: '1px solid var(--sapGroup_TitleBorderColor)', padding: '0.75rem 0' }}>
      <Title level="H6">{titel}</Title>
      <Text style={{ display: 'block', margin: '0.15rem 0 0.5rem', color: 'var(--sapContent_LabelColor)' }}>{hinweis}</Text>
      <FormGrid>{children}</FormGrid>
      {!ro && <Testen endpunkt={endpunkt} v={v} />}
    </div>
  );
}

/** Absender je Anwendung für den n8n-Mailversand – n8n prüft die Adressen gegen seine Konten (KONTEN) */
interface Absender { anwendung: string; email: string; name?: string | null; antwort_an?: string | null }
const ANWENDUNGEN = ['*', 'Benutzer', 'Registrierung', 'Mitgliedsantrag', 'Mitglieder', 'Hallenrechnung', 'Verzehr', 'Platzbuchung'];
function MailAbsender({ liste, ro, onChange }: { liste: Absender[]; ro: boolean; onChange: (l: Absender[]) => void }) {
  const set = (i: number, p: Partial<Absender>) => onChange(liste.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const zelle = { padding: '0.2rem 0.4rem' } as const;
  return (
    <div style={{ padding: '0 0 0.75rem' }}>
      <Title level="H6">Ersatzabsender je Anwendung</Title>
      <Text style={{ display: 'block', margin: '0.15rem 0 0.5rem', color: 'var(--sapContent_LabelColor)' }}>
        Gesendet wird mit der Adresse dessen, der auf „Senden“ drückt – sofern es dafür im n8n-Workflow ein SMTP-Konto gibt (KONTEN:
        torsten.laub@ und benjamin.hartyniuk@tc-oberthal.de). Sonst und bei Mails ohne Anmeldung (Registrierung, Antrag, Passwort vergessen)
        gilt dieser Ersatz je Anwendung („*“ = alle übrigen), ohne Eintrag der Standard des Workflows. Antworten gehen dann an den Bearbeiter.
      </Text>
      {liste.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>{['Anwendung', 'Absender-E-Mail', 'Absendername', 'Antworten an', ''].map((h) => <th key={h} style={{ ...zelle, textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
          <tbody>
            {liste.map((a, i) => (
              <tr key={i}>
                <td style={zelle}>
                  <ComboBox value={a.anwendung} readonly={ro} style={{ width: '11rem' }} onInput={(e) => set(i, { anwendung: e.target.value })} onChange={(e) => set(i, { anwendung: e.target.value })}>
                    {ANWENDUNGEN.map((x) => <ComboBoxItem key={x} text={x} />)}
                  </ComboBox>
                </td>
                <td style={zelle}><Input value={a.email} readonly={ro} type="Email" style={{ width: '100%' }} onInput={(e) => set(i, { email: e.target.value })} /></td>
                <td style={zelle}><Input value={a.name ?? ''} readonly={ro} style={{ width: '100%' }} onInput={(e) => set(i, { name: e.target.value })} /></td>
                <td style={zelle}><Input value={a.antwort_an ?? ''} readonly={ro} type="Email" style={{ width: '100%' }} onInput={(e) => set(i, { antwort_an: e.target.value })} /></td>
                <td style={zelle}>{!ro && <Button design="Transparent" icon="delete" tooltip="Entfernen" onClick={() => onChange(liste.filter((_, j) => j !== i))} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!ro && <Button design="Transparent" icon="add" onClick={() => onChange([...liste, { anwendung: liste.length ? '' : '*', email: '', name: '', antwort_an: '' }])}>Absender hinzufügen</Button>}
    </div>
  );
}

/** Letzte E-Mail-Versuche über n8n und Testmail – zeigt, ob ein Aufruf bei n8n ankam und mit welchem Ergebnis */
interface Proto { id: number; zeit: string; anwendung: string; objekt: string; an: string; betreff: string; absender: string | null; von: string | null; status: string; fehler: string | null; benutzer: string | null;
  erneut: boolean; erneut_hinweis: string | null; erneut_neuer_link: boolean; erneut_am: string | null; erneut_von: string | null; erneut_status: string | null }
function MailProtokoll() {
  const { me } = useSession();
  const [liste, setListe] = useState<Proto[] | null>(null);
  const [an, setAn] = useState(me.user.email ?? '');
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [erneutBusy, setErneutBusy] = useState<number | null>(null);
  const laden = () => api.get<Proto[]>(`${TCO}/verein/mailprotokoll`).then(setListe).catch(() => setListe([]));
  useEffect(() => { laden(); }, []);
  async function test() {
    setBusy(true); setMeldung(null);
    try { const r = await api.post<{ text: string }>(`${TCO}/verein/testmail`, { an }); setMeldung({ ok: true, text: r.text }); }
    catch (e) { setMeldung({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); laden(); }
  }
  const [frage, setFrage] = useState<Proto | null>(null);
  async function erneut(p: Proto) {
    setFrage(null);
    setErneutBusy(p.id); setMeldung(null);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`${TCO}/verein/mailprotokoll/${p.id}/erneut`);
      setMeldung({ ok: true, text: [r.text, ...r.warnungen].join(' · ') });
    } catch (e) { setMeldung({ ok: false, text: (e as Error).message }); }
    finally { setErneutBusy(null); laden(); }
  }
  const STATUS: Record<string, ['Positive' | 'Negative' | 'Critical' | 'Information', string]> = {
    gesendet: ['Positive', 'gesendet'], entwurf: ['Information', 'Entwurf'], fehler: ['Negative', 'Fehler'], nicht_gesendet: ['Critical', 'nicht gesendet'],
  };
  const zelle = { padding: '0.2rem 0.4rem', verticalAlign: 'top' } as const;
  return (
    <div style={{ padding: '0 0 0.75rem' }}>
      <Title level="H6">Mailprotokoll und Testmail</Title>
      <div className="portal-row" style={{ gap: '0.5rem', margin: '0.4rem 0' }}>
        <Input value={an} type="Email" placeholder="Empfänger der Testmail" style={{ width: '18rem' }} onInput={(e) => setAn(e.target.value)} />
        <Button icon="paper-plane" loading={busy} disabled={!an.includes('@')} onClick={test}>Testmail senden</Button>
        <Button design="Transparent" icon="refresh" onClick={laden}>Aktualisieren</Button>
      </div>
      <ConfirmDialog open={!!frage} title="Neuen Zugangslink senden" confirmText="Erneut senden"
                     text={`Für ${frage?.an ?? ''} wird ein neuer Zugangslink erzeugt und gesendet. Ältere Links – auch auf bereits gedruckten Briefen – werden ungültig.`}
                     onConfirm={() => frage && erneut(frage)} onCancel={() => setFrage(null)} />
      {meldung && <MessageStrip design={meldung.ok ? 'Positive' : 'Negative'} onClose={() => setMeldung(null)} style={{ marginBottom: '0.4rem' }}>{meldung.text}</MessageStrip>}
      {!liste?.length ? <Text className="portal-muted">Noch keine Versandversuche protokolliert.</Text> : (
        <div style={{ maxHeight: '18rem', overflowY: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{['Zeit', 'Anwendung', 'An', 'Betreff', 'Absender', 'Status', ''].map((h) => <th key={h} style={{ ...zelle, textAlign: 'left' }}><Label>{h}</Label></th>)}</tr></thead>
            <tbody>
              {liste.map((p) => (
                <tr key={p.id} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                  <td style={{ ...zelle, whiteSpace: 'nowrap' }}><Text>{p.zeit.slice(8, 10)}.{p.zeit.slice(5, 7)}. {p.zeit.slice(11, 16)}</Text></td>
                  <td style={zelle}><Text>{p.anwendung} {p.objekt}</Text></td>
                  <td style={zelle}><Text>{p.an}</Text></td>
                  <td style={zelle}><Text>{p.betreff}</Text></td>
                  <td style={zelle}><Text>{p.von ?? p.absender ?? '–'}</Text></td>
                  <td style={zelle}>
                    <ObjectStatus state={(STATUS[p.status] ?? ['None', p.status])[0] as 'Positive'}>{(STATUS[p.status] ?? ['None', p.status])[1]}</ObjectStatus>
                    {p.fehler && <><br /><Text className="portal-muted portal-small">{p.fehler}</Text></>}
                    {p.erneut_am && (
                      <><br /><Text className="portal-small" style={{ color: p.erneut_status === 'fehler' ? 'var(--sapNegativeTextColor)' : 'var(--sapPositiveTextColor)' }}>
                        {p.erneut_status === 'fehler' ? 'Wiederholung fehlgeschlagen' : 'Erneut gesendet'} am {p.erneut_am.slice(8, 10)}.{p.erneut_am.slice(5, 7)}. {p.erneut_am.slice(11, 16)}{p.erneut_von ? ` von ${p.erneut_von}` : ''}
                      </Text></>
                    )}
                  </td>
                  <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                    {p.erneut && (
                      <Button icon="redo" design="Transparent" loading={erneutBusy === p.id} disabled={erneutBusy !== null}
                              tooltip={p.erneut_neuer_link ? 'Neuen Zugangslink erzeugen und senden' : 'Dieselbe E-Mail (mit Anhängen) erneut senden'}
                              onClick={() => (p.erneut_neuer_link ? setFrage(p) : erneut(p))}>Erneut senden</Button>
                    )}
                    {p.erneut_hinweis && <Text className="portal-muted portal-small" style={{ whiteSpace: 'normal', display: 'block', maxWidth: '16rem' }}>{p.erneut_hinweis}</Text>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VereinTab() {
  const can = useCan();
  const sperre = useSperre('TCO_VEREIN', '1', can('tco.stammdaten:edit'), { bezeichnung: 'Vereinsdaten' });
  const ro = !can('tco.stammdaten:edit') || !sperre.eigen;
  const [v, setV] = useState<Verein | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get<Verein>(`${TCO}/verein`).then(setV).catch((e) => setError(e.message)); }, []);
  if (!v) return error ? <MessageStrip design="Negative">{error}</MessageStrip> : null;
  const s = (k: string) => (x: string) => setV({ ...v, [k]: x });
  const t = (k: string) => (v[k] ?? '') as string;

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.put(`${TCO}/verein`, v);
      toast('Vereinsdaten gesichert');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <SperrHinweis s={sperre} />
      <Panel headerText="Verein (Rechnungssteller)" fixed>
        <FormGrid>
          <TextField label="Name (auch Empfänger im GiroCode)" required value={t('name')} onChange={s('name')} readonly={ro} />
          <TextField label="Straße" value={t('strasse')} onChange={s('strasse')} readonly={ro} />
          <TextField label="PLZ / Ort" value={t('plz_ort')} onChange={s('plz_ort')} readonly={ro} />
          <TextField label="Ansprechpartner (Rechnung, Mailtexte)" value={t('ansprechpartner')} onChange={s('ansprechpartner')} readonly={ro} />
          <TextField label="Steuernummer" value={t('steuernr')} onChange={s('steuernr')} readonly={ro} />
          <TextField label="E-Mail" value={t('email')} onChange={s('email')} readonly={ro} />
          <TextField label="Bank" value={t('bank')} onChange={s('bank')} readonly={ro} />
          <TextField label="IBAN" value={t('iban')} onChange={s('iban')} readonly={ro} />
          <TextField label="BIC" value={t('bic')} onChange={s('bic')} readonly={ro} />
          <TextField label="Zahlungsziel Hallenrechnung (Tage)" type="Number" value={String(v.zahlungsziel_tage ?? 8)} onChange={s('zahlungsziel_tage')} readonly={ro} />
          <TextField label="Ansprechpartner in Mitglieder-Mails (eine Zeile je Person: Name – Aufgabe – Telefon)" multiline wide
                     value={t('mg_ansprechpartner')} onChange={s('mg_ansprechpartner')} readonly={ro} />
          <FieldBox label="Logo für das Kopfband (weiß auf Orange)">
            <FlexBox alignItems="Center" style={{ gap: '0.75rem', background: '#E2701F', padding: '0.5rem', borderRadius: '0.5rem', width: 'fit-content' }}>
              <img alt="Logo" src={(v.logo as string) || '/api/m/tco/logo'} style={{ height: '3rem' }} />
            </FlexBox>
            {!ro && (
              <FlexBox style={{ gap: '0.5rem' }}>
                <FileUploader hideInput accept="image/png,image/jpeg" onChange={async (e) => { const f = e.detail.files?.[0]; if (f) setV({ ...v, logo: await dateiLesen(f) }); }}>
                  <Button icon="upload">Eigenes Logo</Button>
                </FileUploader>
                {v.logo && <Button design="Transparent" icon="reset" onClick={() => setV({ ...v, logo: null })}>Vereinslogo</Button>}
              </FlexBox>
            )}
          </FieldBox>
        </FormGrid>
      </Panel>

      <Panel headerText="Paperless-ngx" fixed style={{ marginTop: '1rem' }}>
        <FormGrid>
          <TextField label="URL (mehrere durch Komma: erst LAN, dann Internet)" value={t('paperless_url')} onChange={s('paperless_url')} readonly={ro} />
          <TextField label="API-Token" type="Password" value={t('paperless_token')} onChange={s('paperless_token')} readonly={ro} />
        </FormGrid>
        {!ro && <Testen endpunkt="paperless" v={v} />}
      </Panel>

      <Panel headerText="n8n-Webhooks" fixed style={{ marginTop: '1rem' }}>
        <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
          Zugangsdaten zu Nextcloud, EP3 oder dem Mailserver liegen in den n8n-Workflows, nicht im Portal. Hier wird nur die Anmeldung am
          jeweiligen Webhook eingetragen – Benutzer und Passwort wie in der SAP-Destination (SM59, „Basic Authentication“), sofern der
          Webhook in n8n eine Anmeldung verlangt. Die Prüfung nutzt die eingegebenen Werte, auch ungesichert.
        </MessageStrip>
        <Endpunkt titel="Rückmeldungen Jugendtraining (SM59: TCO_N8N_STUNDEN)" endpunkt="stunden" v={v} ro={ro}
                  hinweis="Liest die Stundenrückmeldungen aus Nextcloud. Gilt auch für den Ferien-Webhook.">
          <TextField label="Webhook-URL" value={t('n8n_stunden_url')} onChange={s('n8n_stunden_url')} readonly={ro} placeholder="http://…:5678/webhook/…" />
          <TextField label="Benutzer (Basic Auth)" value={t('n8n_stunden_user')} onChange={s('n8n_stunden_user')} readonly={ro} placeholder="z. B. torsten.laub@tc-oberthal.de" />
          <TextField label="Passwort" type="Password" value={t('n8n_stunden_pw')} onChange={s('n8n_stunden_pw')} readonly={ro} />
        </Endpunkt>
        <Endpunkt titel="Schulferien Saarland (ferien-saarland)" endpunkt="ferien" v={v} ro={ro}
                  hinweis="Anmeldung wie bei den Rückmeldungen.">
          <TextField label="Webhook-URL" value={t('n8n_ferien_url')} onChange={s('n8n_ferien_url')} readonly={ro} />
        </Endpunkt>
        <Endpunkt titel="EP3 Import Hallenrechnungen" endpunkt="ep3" v={v} ro={ro}
                  hinweis="Der Test ruft den EP3-Export ab, übernimmt aber nichts.">
          <TextField label="Webhook-URL" value={t('n8n_ep3_url')} onChange={s('n8n_ep3_url')} readonly={ro} />
          <TextField label="Benutzer (Basic Auth, optional)" value={t('n8n_ep3_user')} onChange={s('n8n_ep3_user')} readonly={ro} />
          <TextField label="Passwort" type="Password" value={t('n8n_ep3_pw')} onChange={s('n8n_ep3_pw')} readonly={ro} />
        </Endpunkt>
        <Endpunkt titel="TCO Mailversand" endpunkt="mail" v={v} ro={ro}
                  hinweis="Der Test prüft nur, ob der Workflow aktiv ist – es wird keine E-Mail versendet.">
          <TextField label="Webhook-URL" value={t('n8n_mail_url')} onChange={s('n8n_mail_url')} readonly={ro} />
          <TextField label="Webhook-Schlüssel (Header X-TCO-Key)" type="Password" value={t('n8n_mail_key')} onChange={s('n8n_mail_key')} readonly={ro} />
        </Endpunkt>
        <MailAbsender liste={(v.mail_absender as unknown as Absender[] | null) ?? []} ro={ro}
                      onChange={(l) => setV({ ...v, mail_absender: l as unknown as string })} />
        <MailProtokoll />
        {v.n8n_stunden_pw && !v.n8n_stunden_user && (
          <MessageStrip hideCloseButton design="Critical" style={{ marginTop: '0.5rem' }}>
            Für die Rückmeldungen ist noch ein früher direkt eingetragener Authorization-Header hinterlegt. Er gilt weiter, bis Benutzer und Passwort eingetragen werden.
          </MessageStrip>
        )}
      </Panel>

      <Panel headerText="Hallenabrechnung" fixed style={{ marginTop: '1rem' }}>
        <FormGrid>
          <FieldBox label="Buchungen abrechnen ab (Datum nach)">
            <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={t('halle_stichtag')} readonly={ro} onChange={(e) => setV({ ...v, halle_stichtag: e.detail.value })} />
          </FieldBox>
          <TextField label="EP3-Namen ohne Abrechnung (durch Komma getrennt)" value={t('halle_ausschluss')} onChange={s('halle_ausschluss')} readonly={ro} />
          <TextField label="Plätze mit Abo-Abrechnung auch im Sommer 01.05.–30.09. (EP3-Platzname oder -Nummer, durch Komma)" value={t('halle_plaetze')} onChange={s('halle_plaetze')} readonly={ro} placeholder="Halle" />
        </FormGrid>
      </Panel>

      <Panel headerText="FI Belege" fixed style={{ marginTop: '1rem' }}>
        <FormGrid>
          <TextField label="Konten mit Bankdatei (CSV-Umsatzexport)" value={t('fi_bankkonten')} onChange={s('fi_bankkonten')} readonly={ro} placeholder="1200,654" />
          <TextField label="Kasse und Konten ohne Bankdatei (manuelle Buchung)" value={t('fi_manuell_konten')} onChange={s('fi_manuell_konten')} readonly={ro} placeholder="1000,1210,1220" />
          <TextField label="Paperless-Dokumenttypen offener Belege" value={t('fi_beleg_typen')} onChange={s('fi_beleg_typen')} readonly={ro} />
          <TextField label="Paperless-Speicherpfad offener Belege" value={t('fi_beleg_pfad')} onChange={s('fi_beleg_pfad')} readonly={ro} />
          <TextField label="Custom Field interne Belegnummer (Name oder ID)" value={t('fi_feld_beleg')} onChange={s('fi_feld_beleg')} readonly={ro} />
          <TextField label="Custom Field „SAP“ zugeordnet (Name oder ID)" value={t('fi_feld_sap')} onChange={s('fi_feld_sap')} readonly={ro} />
          <TextField label="Custom Field Betrag (Name oder ID)" value={t('fi_feld_betrag')} onChange={s('fi_feld_betrag')} readonly={ro} />
        </FormGrid>
      </Panel>

      <Bar style={{ marginTop: '1rem' }} endContent={<>
        <ChangeHistoryButton objectType="TCO_VEREIN" objectKey="1" />
        {!ro && <Button design="Emphasized" loading={busy} onClick={save}>Sichern</Button>}
      </>} />
    </>
  );
}

interface Ergebnis { datei: string; tabelle: string | null; saetze: number; neu: number; fehler: string[]; ignoriert: string[]; geschrieben?: number }

function ImportTab() {
  const [files, setFiles] = useState<{ name: string; data: string }[]>([]);
  const [modus, setModus] = useState<'neu' | 'aktualisieren'>('neu');
  const [rows, setRows] = useState<Ergebnis[]>([]);
  const [bestand, setBestand] = useState<{ tabelle: string; saetze: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fertig, setFertig] = useState(false);

  const ladeBestand = () => api.get<typeof bestand>(`${TCO}/import/tabellen`).then(setBestand).catch(() => undefined);
  useEffect(() => { ladeBestand(); }, []);

  async function add(list: FileList | null) {
    if (!list?.length) return;
    const neu = [...files];
    for (const f of Array.from(list)) {
      const data = await dateiLesen(f);
      const i = neu.findIndex((x) => x.name === f.name);
      if (i >= 0) neu[i] = { name: f.name, data }; else neu.push({ name: f.name, data });
    }
    setFiles(neu);
    setFertig(false);
    setBusy(true); setError(null);
    try { setRows(await api.post(`${TCO}/import/pruefen`, { dateien: neu, modus })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function ausfuehren() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<Ergebnis[]>(`${TCO}/import/ausfuehren`, { dateien: files, modus });
      setRows(r);
      setFertig(true);
      toast(`${r.reduce((s, x) => s + (x.geschrieben ?? 0), 0)} Sätze übernommen`, 5000);
      ladeBestand();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Datei', accessor: 'datei', minWidth: 180 },
    { Header: 'Tabelle', accessor: 'tabelle', width: 140, Cell: ({ value }: Cell) => (value ? `tco.${value}` : '–') },
    { Header: 'Sätze', accessor: 'saetze', width: 90, hAlign: 'End' },
    { Header: 'davon neu', accessor: 'neu', width: 100, hAlign: 'End' },
    { Header: 'übernommen', accessor: 'geschrieben', width: 110, hAlign: 'End' },
    {
      Header: 'Hinweise', id: 'hinweis', minWidth: 260,
      Cell: ({ row }: Cell) => {
        const r = row.original as Ergebnis;
        if (r.fehler.length) return <ObjectStatus state="Negative">{r.fehler.join(' · ')}</ObjectStatus>;
        return <Text>{r.ignoriert.length ? `nicht übernommene Spalten: ${r.ignoriert.join(', ').toUpperCase()}` : 'ok'}</Text>;
      },
    },
  ];

  return (
    <>
      <MessageStrip hideCloseButton style={{ marginBottom: '0.75rem' }}>
        Die ZIP-Datei aus dem SAP-Report ZTCO_PORTAL_EXPORT (alle Tabellen) oder einzelne CSV-Dateien aus ZTCO_ARCHIVE hier auswählen.
        Die Tabelle ergibt sich aus dem Dateinamen (z. B. ZTCO_RGKOPF.CSV, BANKAB.CSV); erst wird geprüft, dann mit „Übernehmen“ geschrieben. „Nur neue Sätze“ lässt vorhandene Daten unverändert; „Vorhandene aktualisieren“ überschreibt sie mit dem SAP-Stand.
      </MessageStrip>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <FlexBox alignItems="Center" style={{ gap: '1rem', marginBottom: '0.75rem' }}>
        <FileUploader multiple hideInput accept=".csv,.CSV,.zip,.ZIP,text/csv,application/zip" onChange={(e) => add(e.detail.files)}>
          <Button icon="add-document">ZIP- oder CSV-Dateien wählen</Button>
        </FileUploader>
        <SegmentedButton onSelectionChange={(e) => setModus((e.detail.selectedItems[0] as HTMLElement).dataset.m as typeof modus)}>
          <SegmentedButtonItem data-m="neu" selected={modus === 'neu'}>Nur neue Sätze</SegmentedButtonItem>
          <SegmentedButtonItem data-m="aktualisieren" selected={modus === 'aktualisieren'}>Vorhandene aktualisieren</SegmentedButtonItem>
        </SegmentedButton>
        <Button design="Emphasized" icon="upload" loading={busy} disabled={!files.length || fertig || rows.every((r) => !r.tabelle)} onClick={ausfuehren}>Übernehmen</Button>
        {files.length > 0 && <Button design="Transparent" onClick={() => { setFiles([]); setRows([]); setFertig(false); }}>Auswahl leeren</Button>}
      </FlexBox>
      <AnalyticalTable minRows={1} columns={columns} data={rows} visibleRows={Math.max(rows.length, 1)} noDataText="Noch keine Dateien ausgewählt" loading={busy} />
      <Panel headerText="Aktueller Bestand" fixed style={{ marginTop: '1rem' }}>
        <FlexBox wrap="Wrap" style={{ gap: '0.25rem 1.5rem' }}>
          {bestand.map((b) => (
            <FlexBox key={b.tabelle} style={{ width: '13rem' }} justifyContent="SpaceBetween">
              <Label>{b.tabelle}</Label><Text>{b.saetze.toLocaleString('de-DE')}</Text>
            </FlexBox>
          ))}
        </FlexBox>
      </Panel>
    </>
  );
}
