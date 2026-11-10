import { useCallback, useEffect, useState } from 'react';
import { Bar, BusyIndicator, Button, Dialog, Input, Label, MessageStrip, ObjectStatus, Tab, TabContainer, Text, TextArea } from '@ui5/webcomponents-react';
import { api, qs } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { Empty, Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat } from '../util';
import { RegelDialog, Vorschlag, Wahl, Zielordner } from './RegelDialog';
import {
  EING, REGEL_STATUS, STATUS_STATE, STATUS_TEXT, kopf, leereRegel, mailText, zelle,
  type Dokument, type Korrespondent, type MailAktion, type MailArt, type Regel, type RegelEingabe, type Stamm, type Vorgang, type VorgangListe,
} from './typen';

/**
 * Dokumenteneingang: eingegangene E-Mails und ihre Anhänge nach Regeln ablegen.
 *  - Prüfliste: was keine Regel eindeutig abgelegt hat – ansehen, ablegen, ignorieren, Regel daraus erstellen
 *  - Protokoll: alle Vorgänge mit Ablageort (ohne Inhalte)
 *  - Regeln und Korrespondenten: das Regelwerk
 */
const zeitText = (z: string | null) => (z ? `${dat(z)} ${z.slice(11, 16)}` : '');
const groesse = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function Dokumenteneingang() {
  const can = useCan();
  const edit = can('tco.eingang:edit');
  const [tab, setTab] = useState(edit ? 'pruef' : 'proto');
  const [stamm, setStamm] = useState<Stamm | null>(null);
  const [regeln, setRegeln] = useState<Regel[]>([]);
  const [error, setError] = useState<string | null>(null);
  // nachher: Vorgang, der nach dem Speichern der Regel neu bewertet wird („Regel bearbeiten“ aus der Prüfliste)
  const [dialog, setDialog] = useState<{ id: number | null; start: RegelEingabe; nachher?: number } | null>(null);
  const [stand, setStand] = useState(0);

  const regelnLaden = useCallback(() => api.get<Regel[]>(`${EING}/regeln`).then(setRegeln).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    api.get<Stamm>(`${EING}/stamm`).then(setStamm).catch((e) => setError((e as Error).message));
    regelnLaden();
  }, [regelnLaden]);

  /** Regel aus einem Vorgang der Prüfliste vorbereiten: Absender (und Dateiendung) als Bedingungen, zunächst im Testlauf */
  function regelAus(v: Vorgang, d: Dokument | null) {
    const r = leereRegel();
    const endung = d ? /\.[A-Za-z0-9]{1,8}$/.exec(d.datei)?.[0] ?? '' : '';
    r.name = v.korrespondent || v.von_name || v.von || 'Neue Regel';
    r.gilt_fuer = d && d.art === 'anhang' ? 'anhang' : 'mail';
    r.bedingungen = [
      v.korrespondent ? { feld: 'korrespondent', op: 'ist', wert: v.korrespondent } : { feld: 'von', op: 'ist', wert: v.von ?? '' },
      ...(r.gilt_fuer === 'anhang' && endung ? [{ feld: 'datei', op: 'endet', wert: endung.toLowerCase() }] : []),
    ];
    if (r.gilt_fuer === 'mail' && r.aktionen.paperless) r.aktionen.paperless.titel = '{betreff}';
    setDialog({ id: null, start: r });
  }

  /** zugeordnete Regel aus der Prüfliste heraus anpassen; danach wird der Vorgang neu bewertet */
  function regelBearbeiten(v: Vorgang, regelId: number) {
    const r = regeln.find((x) => x.id === regelId);
    if (!r) { setError('Die Regel gibt es nicht (mehr).'); return; }
    const { id, version: _v, treffer: _t, letzter: _l, ...start } = r;
    setDialog({ id, start, nachher: v.id });
  }

  async function gespeichert(nachher?: number) {
    setDialog(null);
    regelnLaden();
    if (nachher) {
      try { toast(`Regel gespeichert. ${(await api.post<{ text: string }>(`${EING}/vorgaenge/${nachher}/neu-bewerten`)).text}`, 5000); }
      catch (e) { setError((e as Error).message); }
    }
    setStand((s) => s + 1);
  }

  return (
    <AppPage title="Dokumenteneingang" subtitle="E-Mails und Anhänge nach Regeln in Paperless und der Nextcloud ablegen">
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!stamm ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
          {edit ? (
            <Tab data-key="pruef" text="Prüfliste" icon="inbox" selected={tab === 'pruef'}>
              {tab === 'pruef' && <Vorgaenge key={`p${stand}`} offen edit regeln={regeln} stamm={stamm} onRegelAus={regelAus} onRegelBearbeiten={regelBearbeiten} />}
            </Tab>
          ) : null}
          <Tab data-key="proto" text="Protokoll" icon="history" selected={tab === 'proto'}>
            {tab === 'proto' && <Vorgaenge key={`a${stand}`} offen={false} edit={edit} regeln={regeln} stamm={stamm} onRegelAus={regelAus} onRegelBearbeiten={regelBearbeiten} />}
          </Tab>
          <Tab data-key="regeln" text="Regeln" icon="decision" selected={tab === 'regeln'}>
            {tab === 'regeln' && <Regeln regeln={regeln} edit={edit} onOeffnen={(id, start) => setDialog({ id, start })} onGeaendert={regelnLaden} />}
          </Tab>
          <Tab data-key="korr" text="Korrespondenten" icon="group" selected={tab === 'korr'}>
            {tab === 'korr' && <Korrespondenten edit={edit} />}
          </Tab>
        </TabContainer>
      )}
      {dialog && stamm && (
        <RegelDialog id={dialog.id} start={dialog.start} stamm={stamm} onClose={() => setDialog(null)}
                     onSaved={() => gespeichert(dialog.nachher)} />
      )}
    </AppPage>
  );
}

// ---------------------------------------------------------------------------- Prüfliste / Protokoll

function Vorgaenge({ offen, edit, regeln, stamm, onRegelAus, onRegelBearbeiten }: {
  offen: boolean; edit: boolean; regeln: Regel[]; stamm: Stamm; onRegelAus: (v: Vorgang, d: Dokument | null) => void;
  onRegelBearbeiten: (v: Vorgang, regelId: number) => void;
}) {
  const [d, setD] = useState<VorgangListe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(offen ? 'offen' : '');
  const [suche, setSuche] = useState('');
  const [busy, setBusy] = useState(false);
  const [ablage, setAblage] = useState<{ v: Vorgang; d: Dokument } | null>(null);
  const [mailtext, setMailtext] = useState<{ v: Vorgang; text: string } | null>(null);
  const [zuordnen, setZuordnen] = useState<Vorgang | null>(null);
  const [frage, setFrage] = useState<{ v: Vorgang; art: 'schliessen' | 'verwerfen' } | null>(null);

  const laden = useCallback(() => api.get<VorgangListe>(`${EING}/vorgaenge${qs({ status, suche })}`).then(setD).catch((e) => setError((e as Error).message)), [status, suche]);
  useEffect(() => { const t = setTimeout(laden, suche ? 300 : 0); return () => clearTimeout(t); }, [laden, suche]);

  async function aktion(f: () => Promise<{ text: string }>) {
    setBusy(true); setError(null);
    try { toast((await f()).text, 5000); } catch (e) { setError((e as Error).message); } finally { setBusy(false); await laden(); }
  }
  const dateiOeffnen = (dok: Dokument) => window.open(`${EING}/dokumente/${dok.id}/datei`, '_blank', 'noopener');
  async function textZeigen(v: Vorgang) {
    try { setMailtext({ v, text: (await api.get<{ text: string }>(`${EING}/vorgaenge/${v.id}/text`)).text }); } catch (e) { setError((e as Error).message); }
  }

  /** Regel, die einem offenen Dokument des Vorgangs zugeordnet ist (sonst einem beliebigen Dokument) */
  const zugeordnet = (v: Vorgang) => {
    const d = v.dokumente.find((x) => x.regel_id && ['pruefen', 'fehler', 'neu'].includes(x.status)) ?? v.dokumente.find((x) => x.regel_id);
    return d ? regeln.find((r) => r.id === d.regel_id) ?? null : null;
  };

  const ziel = (dok: Dokument) => {
    if (dok.paperless_id || dok.nextcloud_pfad) return [dok.paperless_id ? `Paperless ${dok.paperless_id}` : '', dok.nextcloud_pfad ? `Nextcloud ${dok.nextcloud_pfad}` : ''].filter(Boolean).join(' · ');
    const z = dok.zuordnung?.zuordnung;
    const n = dok.zuordnung?.nextcloud;
    const teile = [z ? [`„${z.title}“`, z.correspondent, z.documentType, z.storagePath, z.tags.join('/')].filter(Boolean).join(', ') : '', n ? `Nextcloud ${[n.pfad, n.dateiname].filter(Boolean).join('/')}` : ''];
    return teile.filter(Boolean).join(' · ') || '–';
  };

  return (
    <div style={{ paddingTop: '0.5rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <Wahl wert={status} style={{ width: '14rem' }} onChange={setStatus} optionen={offen
          ? [['offen', 'zu prüfen und Fehler'], ['pruefen', 'nur zu prüfen'], ['fehler', 'nur Fehler']]
          : [['', 'alle Vorgänge'], ['abgelegt', 'abgelegt'], ['offen', 'zu prüfen und Fehler'], ['ohne_regel', 'ohne Regel'], ['ignoriert', 'nicht abgelegt']]} />
        <Input placeholder="Suchen (Absender, Betreff, Datei)" value={suche} onInput={(e) => setSuche(e.target.value)} style={{ width: '18rem' }} />
        <Button design="Transparent" icon="refresh" tooltip="Aktualisieren" onClick={laden} />
        {edit && (
          <Button icon="download" disabled={busy} onClick={() => aktion(() => api.post<{ text: string }>(`${EING}/abruf`))}
                  tooltip={stamm.abruf.eingerichtet
                    ? 'Offene Vorgänge neu bewerten und n8n alle E-Mails des Posteingangs erneut liefern lassen (auch gelesene); E-Mails ohne Regel werden neu bewertet'
                    : 'Offene Vorgänge neu bewerten – für den Abruf aus dem Postfach fehlt die Anbindung „Maileingang jetzt abrufen (n8n)“'}>
            Posteingang abrufen
          </Button>
        )}
        {d && <Text className="portal-muted">{d.offen.pruefen} zu prüfen{d.offen.fehler ? `, ${d.offen.fehler} mit Fehler` : ''}</Text>}
      </div>
      {!d ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : d.vorgaenge.length === 0 ? (
        <Section><Empty>{offen ? 'Die Prüfliste ist leer – alle eingegangenen Dokumente sind abgelegt.' : 'Keine Vorgänge gefunden.'}</Empty></Section>
      ) : d.vorgaenge.map((v) => {
        const istOffen = v.status === 'pruefen' || v.status === 'fehler';
        return (
          <Section key={v.id} title={v.betreff || '(ohne Betreff)'} flush
                   status={<ObjectStatus state={STATUS_STATE[v.status] ?? 'None'}>{STATUS_TEXT[v.status] ?? v.status}</ObjectStatus>}
                   actions={edit ? <>
                     {istOffen && <Button design="Transparent" icon="email-read" disabled={busy} onClick={() => textZeigen(v)}>Mailtext</Button>}
                     {istOffen && <Button design="Transparent" icon="synchronize" disabled={busy} tooltip="Regelwerk erneut auf die offenen Dokumente anwenden"
                                          onClick={() => aktion(() => api.post<{ text: string }>(`${EING}/vorgaenge/${v.id}/neu-bewerten`))}>Neu bewerten</Button>}
                     {(istOffen || v.status === 'ohne_regel') && (zugeordnet(v)
                       ? <Button design="Transparent" icon="edit" tooltip={`Regel „${zugeordnet(v)!.name}“ anpassen; danach wird der Vorgang neu bewertet`}
                                 onClick={() => onRegelBearbeiten(v, zugeordnet(v)!.id)}>Regel bearbeiten</Button>
                       : <Button design="Transparent" icon="add-document" onClick={() => onRegelAus(v, v.dokumente[0] ?? null)}>Regel erstellen</Button>)}
                     {(istOffen || v.status === 'ohne_regel') && <Button design="Transparent" icon="chain-link" disabled={busy} tooltip="Eine bestehende Regel auswählen und anwenden"
                                                                        onClick={() => setZuordnen(v)}>Regel zuordnen</Button>}
                     {(istOffen || v.status === 'ohne_regel') && <Button design="Transparent" icon="decline" disabled={busy} onClick={() => setFrage({ v, art: 'schliessen' })}>Ohne Ablage schließen</Button>}
                     {v.status !== 'abgelegt' && <Button design="Transparent" icon="delete" disabled={busy} tooltip="Vorgang verwerfen – die E-Mail wird neu eingelesen" onClick={() => setFrage({ v, art: 'verwerfen' })} />}
                   </> : undefined}>
            <div style={{ padding: '0.25rem 1rem 0.5rem' }}>
              <Text className="portal-small">
                {v.von_name ? `${v.von_name} <${v.von ?? ''}>` : v.von} · {zeitText(v.datum)}{v.postfach ? ` · Postfach ${v.postfach}` : ''}
                {v.korrespondent ? ` · Korrespondent ${v.korrespondent}` : ''}{v.mitglied_adrnr ? ` · Mitglied ${v.mitglied_adrnr.replace(/^0+/, '')}` : ''}
              </Text>
              {(v.hinweis || v.mail_aktion) && (
                <Text className="portal-muted portal-small" style={{ display: 'block' }}>
                  {v.hinweis ?? ''}{v.hinweis && v.mail_aktion ? ' · ' : ''}{v.mail_aktion ? `E-Mail: ${mailText(v.mail_aktion)}${v.mail_erledigt ? ' (erledigt)' : v.status === 'abgelegt' ? ' (steht aus)' : ''}` : ''}
                </Text>
              )}
            </div>
            {v.dokumente.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr>{['Dokument', 'Status', 'Regel', offen ? 'Vorschlag' : 'Ablage', 'Hinweis', ''].map((h) => <th key={h} style={kopf}><Label>{h}</Label></th>)}</tr></thead>
                  <tbody>
                    {v.dokumente.map((dok) => {
                      const dokOffen = ['pruefen', 'fehler', 'neu'].includes(dok.status);
                      return (
                        <tr key={dok.id} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                          <td style={zelle}>
                            <Text>{dok.art === 'mail' ? 'E-Mail als PDF' : dok.datei}</Text>
                            <div><Text className="portal-muted portal-small">{groesse(dok.groesse)}</Text></div>
                          </td>
                          <td style={zelle}><ObjectStatus state={STATUS_STATE[dok.status] ?? 'None'}>{STATUS_TEXT[dok.status] ?? dok.status}</ObjectStatus></td>
                          <td style={zelle}><Text>{dok.regel_name ?? '–'}</Text></td>
                          <td style={zelle}><Text>{ziel(dok)}</Text></td>
                          <td style={zelle}>
                            <Text className="portal-small">{dok.hinweis ?? ''}</Text>
                            {dok.bearbeitet_am && <div><Text className="portal-muted portal-small">{zeitText(dok.bearbeitet_am)} {dok.bearbeitet_von ?? ''}</Text></div>}
                          </td>
                          <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                            {edit && dok.vorhanden && <Button design="Transparent" icon="show" tooltip="Dokument ansehen" onClick={() => dateiOeffnen(dok)} />}
                            {edit && dokOffen && <Button design="Emphasized" disabled={busy} onClick={() => setAblage({ v, d: dok })}>Ablegen …</Button>}
                            {edit && dokOffen && <Button design="Transparent" icon="decline" tooltip="Dieses Dokument nicht ablegen" disabled={busy}
                                                         onClick={() => aktion(() => api.post<{ text: string }>(`${EING}/dokumente/${dok.id}/ignorieren`))} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        );
      })}
      {d?.gekuerzt && <Text className="portal-muted portal-small">Es werden nur die neuesten 300 Vorgänge gezeigt – bitte die Suche eingrenzen.</Text>}
      {zuordnen && <ZuordnenDialog v={zuordnen} onClose={() => setZuordnen(null)} onDone={() => { setZuordnen(null); laden(); }}
                                   onBearbeiten={(id) => { const v = zuordnen; setZuordnen(null); onRegelBearbeiten(v, id); }} />}
      {ablage && <AblageDialog v={ablage.v} d={ablage.d} regeln={regeln} stamm={stamm} onClose={() => setAblage(null)} onDone={() => { setAblage(null); laden(); }} />}
      {mailtext && (
        <Dialog open headerText={mailtext.v.betreff || 'Mailtext'} style={{ width: 'min(50rem, 96vw)' }} onClose={() => setMailtext(null)}
                footer={<Bar endContent={<Button design="Transparent" onClick={() => setMailtext(null)}>Schließen</Button>} />}>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{mailtext.text || 'Der Mailtext liegt nicht (mehr) vor.'}</pre>
        </Dialog>
      )}
      <ConfirmDialog open={!!frage} danger={frage?.art === 'verwerfen'}
                     title={frage?.art === 'verwerfen' ? 'Vorgang verwerfen' : 'Ohne Ablage schließen'}
                     text={frage?.art === 'verwerfen'
                       ? 'Der Vorgang wird aus dem Portal gelöscht. Liegt die E-Mail noch im Postfach, liest n8n sie mit „Posteingang abrufen“ neu ein und das Regelwerk entscheidet erneut.'
                       : 'Die offenen Dokumente werden nicht abgelegt und im Portal gelöscht. Die E-Mail bleibt unverändert im Postfach.'}
                     confirmText={frage?.art === 'verwerfen' ? 'Verwerfen' : 'Schließen'}
                     onCancel={() => setFrage(null)}
                     onConfirm={() => {
                       const f = frage!;
                       setFrage(null);
                       aktion(() => (f.art === 'verwerfen' ? api.del<{ text: string }>(`${EING}/vorgaenge/${f.v.id}`) : api.post<{ text: string }>(`${EING}/vorgaenge/${f.v.id}/ignorieren`)));
                     }} />
    </div>
  );
}

/** Dokument der Prüfliste ablegen: mit einer Regel oder von Hand */
/** Bestehende Regel zuordnen: Regeln mit „passt / passt nicht“, Anwenden oder Bedingungen anpassen */
function ZuordnenDialog({ v, onClose, onDone, onBearbeiten }: { v: Vorgang; onClose: () => void; onDone: () => void; onBearbeiten: (regelId: number) => void }) {
  const [liste, setListe] = useState<{ id: number; name: string; status: string; gilt_fuer: string; passt: boolean; anwendbar: boolean }[] | null>(null);
  const [regelId, setRegelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<NonNullable<typeof liste>>(`${EING}/vorgaenge/${v.id}/regeln`).then((l) => {
      const sortiert = [...l].sort((a, b) => Number(b.passt) - Number(a.passt) || Number(b.anwendbar) - Number(a.anwendbar) || a.name.localeCompare(b.name, 'de'));
      setListe(sortiert);
      setRegelId(String(sortiert.find((r) => r.anwendbar)?.id ?? ''));
    }).catch((e) => setError((e as Error).message));
  }, [v.id]);
  const r = liste?.find((x) => String(x.id) === regelId) ?? null;

  async function anwenden() {
    if (!r) return;
    setBusy(true); setError(null);
    try { toast((await api.post<{ text: string }>(`${EING}/vorgaenge/${v.id}/regel`, { regel_id: r.id })).text, 6000); onDone(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText={`Regel zuordnen – ${v.betreff || '(ohne Betreff)'}`} style={{ width: 'min(40rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={busy || !r?.anwendbar} onClick={anwenden}>Zuordnen und anwenden</Button>
              <Button design="Transparent" icon="edit" disabled={!r} onClick={() => r && onBearbeiten(r.id)}>Regel bearbeiten …</Button>
              <Button design="Transparent" onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!liste ? <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /> : !liste.length ? <Text>Es gibt noch keine Regeln.</Text> : <>
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1rem', alignItems: 'center' }}>
          <Label>Regel</Label>
          <Wahl wert={regelId} style={{ width: '100%' }} onChange={setRegelId} optionen={liste.map((x): [string, string] => [String(x.id),
            `${x.name} – ${x.gilt_fuer === 'mail' ? 'E-Mail' : 'je Anhang'}${x.status === 'testlauf' ? ', Testlauf' : x.status === 'aus' ? ', aus' : ''} · ${x.passt ? 'passt' : 'passt nicht'}`])} />
        </div>
        {r && (
          <MessageStrip design={!r.anwendbar ? 'Negative' : r.passt ? 'Positive' : 'Critical'} hideCloseButton style={{ marginTop: '0.75rem' }}>
            {!r.anwendbar
              ? (r.status === 'aus' ? 'Die Regel ist ausgeschaltet.' : 'Die Regel gilt je Anhang, der Vorgang hat aber keine offenen Anhänge.')
              : r.passt
                ? 'Die Bedingungen der Regel passen auf diese E-Mail.'
                : 'Die Bedingungen passen nicht auf diese E-Mail. Die Regel wird trotzdem angewendet – damit sie künftig von selbst greift, „Regel bearbeiten …“ und die Bedingungen anpassen.'}
            {r.anwendbar && r.status === 'testlauf' ? ' Im Testlauf entsteht nur ein Vorschlag; die E-Mail bleibt unverändert.' : ''}
          </MessageStrip>
        )}
      </>}
    </Dialog>
  );
}

function AblageDialog({ v, d, regeln, stamm, onClose, onDone }: { v: Vorgang; d: Dokument; regeln: Regel[]; stamm: Stamm; onClose: () => void; onDone: () => void }) {
  const waehlbar = regeln.filter((r) => r.gilt_fuer === d.art && r.status !== 'aus' && (r.aktionen.paperless?.aktiv || r.aktionen.nextcloud?.aktiv));
  const vorschlag = d.zuordnung?.zuordnung ?? null;
  const [regelId, setRegelId] = useState<string>(d.regel_id && waehlbar.some((r) => r.id === d.regel_id) ? String(d.regel_id) : '');
  const [f, setF] = useState({
    titel: vorschlag?.title ?? d.datei.replace(/\.[^.]+$/, ''), korrespondent: vorschlag?.correspondent ?? v.korrespondent ?? '', dokumenttyp: vorschlag?.documentType ?? '',
    speicherpfad: vorschlag?.storagePath ?? '', tags: vorschlag?.tags.join(', ') ?? 'Maileingang', datum: vorschlag?.created ?? (v.datum ?? '').slice(0, 10),
  });
  const [mail, setMail] = useState<'regel' | MailArt>(regelId ? 'regel' : 'keine');
  const [ordner, setOrdner] = useState('');
  const [gelesen, setGelesen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hand = regelId === '';

  async function ablegen() {
    setBusy(true); setError(null);
    const aktion: MailAktion | null = mail === 'regel' ? null : { art: mail, ordner: mail === 'verschieben' ? ordner : undefined, gelesen };
    try {
      const r = await api.post<{ text: string }>(`${EING}/dokumente/${d.id}/ablegen`, hand
        ? { paperless: f, mail: aktion }
        : { regel_id: Number(regelId), mail: aktion });
      toast(r.text, 6000);
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText={`Ablegen – ${d.art === 'mail' ? 'E-Mail als PDF' : d.datei}`} style={{ width: 'min(42rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" loading={busy} disabled={busy} onClick={ablegen}>Ablegen</Button>
              <Button design="Transparent" onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!stamm.paperless.eingerichtet && <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>Paperless ist nicht eingerichtet (Administration → Anbindungen).</MessageStrip>}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1rem', alignItems: 'center' }}>
        <Label>Ablage nach</Label>
        <Wahl wert={regelId} style={{ width: '100%' }} onChange={(k) => { setRegelId(k); setMail(k ? 'regel' : 'keine'); }}
              optionen={[['', 'von Hand (Angaben unten)'], ...waehlbar.map((r): [string, string] => [String(r.id), `Regel „${r.name}“${r.status === 'testlauf' ? ' (Testlauf)' : ''}`])]} />
        {hand && <>
          <Label required>Titel</Label>
          <Input value={f.titel} style={{ width: '100%' }} onInput={(e) => setF({ ...f, titel: e.target.value })} />
          <Label>Korrespondent</Label>
          <Vorschlag wert={f.korrespondent} werte={stamm.paperless.korrespondenten} onChange={(x) => setF({ ...f, korrespondent: x })} />
          <Label>Dokumenttyp</Label>
          <Vorschlag wert={f.dokumenttyp} werte={stamm.paperless.dokumenttypen} onChange={(x) => setF({ ...f, dokumenttyp: x })} />
          <Label>Speicherpfad</Label>
          <Vorschlag wert={f.speicherpfad} werte={stamm.paperless.speicherpfade} onChange={(x) => setF({ ...f, speicherpfad: x })} />
          <Label>Tags (Komma)</Label>
          <Input value={f.tags} style={{ width: '100%' }} onInput={(e) => setF({ ...f, tags: e.target.value })} />
          <Label>Dokumentdatum</Label>
          <Input value={f.datum} style={{ width: '10rem' }} placeholder="JJJJ-MM-TT" onInput={(e) => setF({ ...f, datum: e.target.value })} />
        </>}
        <Label>E-Mail danach</Label>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <Wahl wert={mail} style={{ width: '15rem' }} onChange={(k) => setMail(k as 'regel' | MailArt)} optionen={[
            ...(hand ? [] : [['regel', 'wie in der Regel'] as [string, string]]),
            ['keine', 'im Posteingang lassen'], ['verschieben', 'in einen Ordner verschieben'], ['loeschen', 'in den Papierkorb']]} />
          {mail === 'verschieben' && <Zielordner wert={ordner} onChange={setOrdner} />}
          {mail !== 'regel' && <Button design={gelesen ? 'Emphasized' : 'Default'} icon="email-read" onClick={() => setGelesen(!gelesen)}>als gelesen markieren</Button>}
        </div>
      </div>
      <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.75rem' }}>
        Die E-Mail wird erst behandelt, wenn alle Dokumente des Vorgangs erledigt sind. Platzhalter wie {'{datei|ohneEndung}'} oder {'{mitglied}'} sind auch hier erlaubt.
      </Text>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Regeln

function Regeln({ regeln, edit, onOeffnen, onGeaendert }: { regeln: Regel[]; edit: boolean; onOeffnen: (id: number | null, start: RegelEingabe) => void; onGeaendert: () => void }) {
  const [loeschen, setLoeschen] = useState<Regel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eingabe = ({ id: _id, version: _v, treffer: _t, letzter: _l, ...r }: Regel): RegelEingabe => r;
  const bedText = (r: Regel) => r.bedingungen.map((b) => `${b.feld} ${b.nicht ? 'nicht ' : ''}${b.op} „${b.wert}“`).join(r.verknuepfung === 'oder' ? ' ODER ' : ' UND ');
  const aktText = (r: Regel) => [
    r.aktionen.paperless?.aktiv ? `Paperless${r.aktionen.paperless.dokumenttyp ? ` (${r.aktionen.paperless.dokumenttyp})` : ''}` : '',
    r.aktionen.nextcloud?.aktiv ? `Nextcloud ${r.aktionen.nextcloud.pfad}` : '',
    r.aktionen.mail && (r.aktionen.mail.art !== 'keine' || r.aktionen.mail.gelesen) ? `E-Mail ${mailText(r.aktionen.mail)}` : '',
    r.aktionen.aufgabe?.aktiv ? 'Aufgabe' : '',
  ].filter(Boolean).join(' → ') || 'keine';

  return (
    <div style={{ paddingTop: '0.5rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Section title="Regeln" count={regeln.length} flush actions={edit ? <Button icon="add" onClick={() => onOeffnen(null, leereRegel())}>Regel anlegen</Button> : undefined}>
        {regeln.length === 0 ? <Empty>Noch keine Regeln. Ohne Regel stehen Anhänge in der Prüfliste; E-Mails ohne Anhang bleiben unangetastet.</Empty> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>{['Prio', 'Regel', 'Gilt', 'Status', 'Bedingungen', 'Aktionen', 'Treffer 30 Tage', ''].map((h) => <th key={h} style={kopf}><Label>{h}</Label></th>)}</tr></thead>
              <tbody>
                {regeln.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                    <td style={zelle}><Text>{r.prioritaet}</Text></td>
                    <td style={zelle}><Text>{r.name}</Text>{r.beschreibung && <div><Text className="portal-muted portal-small">{r.beschreibung}</Text></div>}</td>
                    <td style={zelle}><Text>{r.gilt_fuer === 'anhang' ? 'je Anhang' : 'E-Mail'}</Text></td>
                    <td style={zelle}>
                      <ObjectStatus state={r.status === 'aktiv' ? 'Positive' : r.status === 'testlauf' ? 'Information' : 'None'}>{REGEL_STATUS[r.status]}</ObjectStatus>
                      {r.automatik === 'pruefen' && <div><Text className="portal-muted portal-small">immer prüfen</Text></div>}
                    </td>
                    <td style={zelle}><Text className="portal-small">{bedText(r)}</Text></td>
                    <td style={zelle}><Text className="portal-small">{aktText(r)}</Text></td>
                    <td style={zelle}><Text>{r.treffer}</Text>{r.letzter && <div><Text className="portal-muted portal-small">zuletzt {dat(r.letzter)}</Text></div>}</td>
                    <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                      {edit && <Button design="Transparent" icon="edit" tooltip="Regel ändern" onClick={() => onOeffnen(r.id, eingabe(r))} />}
                      {edit && <Button design="Transparent" icon="copy" tooltip="Regel kopieren" onClick={() => onOeffnen(null, { ...eingabe(r), name: `${r.name} (Kopie)`, status: 'testlauf' })} />}
                      {edit && <Button design="Transparent" icon="delete" tooltip="Regel löschen" onClick={() => setLoeschen(r)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <ConfirmDialog open={!!loeschen} danger title="Regel löschen" text={`Regel „${loeschen?.name ?? ''}“ löschen? Bereits abgelegte Dokumente bleiben unverändert.`} confirmText="Löschen"
                     onCancel={() => setLoeschen(null)}
                     onConfirm={async () => {
                       const r = loeschen!;
                       setLoeschen(null);
                       try { toast((await api.del<{ text: string }>(`${EING}/regeln/${r.id}`)).text); onGeaendert(); } catch (e) { setError((e as Error).message); }
                     }} />
    </div>
  );
}

// ---------------------------------------------------------------------------- Korrespondenten

function Korrespondenten({ edit }: { edit: boolean }) {
  const [liste, setListe] = useState<Korrespondent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<{ id: number | null; name: string; kurz: string; adressen: string } | null>(null);
  const [loeschen, setLoeschen] = useState<Korrespondent | null>(null);
  const [busy, setBusy] = useState(false);
  const laden = useCallback(() => api.get<Korrespondent[]>(`${EING}/korrespondenten`).then(setListe).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { laden(); }, [laden]);

  async function speichern() {
    if (!f) return;
    setBusy(true); setError(null);
    try {
      const body = { name: f.name, kurz: f.kurz, adressen: f.adressen };
      const r = f.id ? await api.put<{ text: string }>(`${EING}/korrespondenten/${f.id}`, body) : await api.post<{ text: string }>(`${EING}/korrespondenten`, body);
      toast(r.text);
      setF(null);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div style={{ paddingTop: '0.5rem' }}>
      {error && !f && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!liste ? <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} /> : (
        <Section title="Korrespondenten" count={liste.length} flush actions={edit ? <Button icon="add" onClick={() => setF({ id: null, name: '', kurz: '', adressen: '' })}>Korrespondent anlegen</Button> : undefined}>
          {liste.length === 0 ? <Empty>Ein Korrespondent fasst alle Absenderadressen und Domains eines Partners zusammen. Regeln prüfen dann nur noch „Korrespondent ist …“.</Empty> : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>{['Name', 'Kurzname', 'Adressen und Domains', ''].map((h) => <th key={h} style={kopf}><Label>{h}</Label></th>)}</tr></thead>
              <tbody>
                {liste.map((k) => (
                  <tr key={k.id} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                    <td style={zelle}><Text>{k.name}</Text></td>
                    <td style={zelle}><Text>{k.kurz}</Text></td>
                    <td style={zelle}><Text className="portal-small">{k.adressen.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).join(', ')}</Text></td>
                    <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                      {edit && <Button design="Transparent" icon="edit" tooltip="Ändern" onClick={() => setF({ ...k })} />}
                      {edit && <Button design="Transparent" icon="delete" tooltip="Löschen" onClick={() => setLoeschen(k)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
      {f && (
        <Dialog open headerText={f.id ? 'Korrespondent ändern' : 'Korrespondent anlegen'} style={{ width: 'min(36rem, 96vw)' }} onClose={() => setF(null)}
                footer={<Bar endContent={<>
                  <Button design="Emphasized" disabled={busy} onClick={speichern}>Speichern</Button>
                  <Button design="Transparent" onClick={() => setF(null)}>Abbrechen</Button>
                </>} />}>
          {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1rem', alignItems: 'center' }}>
            <Label required>Name</Label>
            <Input value={f.name} maxlength={120} style={{ width: '100%' }} onInput={(e) => setF({ ...f, name: e.target.value })} />
            <Label>Kurzname</Label>
            <Input value={f.kurz} maxlength={40} style={{ width: '12rem' }} placeholder="für Dateinamen" onInput={(e) => setF({ ...f, kurz: e.target.value })} />
            <Label>Adressen und Domains</Label>
            <TextArea rows={4} value={f.adressen} placeholder={'sumup.com\nrechnung@telekom.de'} onInput={(e) => setF({ ...f, adressen: e.target.value })} />
          </div>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.75rem' }}>
            Eine Adresse oder Domain je Zeile (oder durch Komma getrennt). Eine Domain gilt auch für ihre Subdomains; eine genaue Adresse hat Vorrang.
            Der Name wird als Platzhalter {'{korrespondent}'} verwendet – am besten so, wie der Korrespondent in Paperless heißt.
          </Text>
        </Dialog>
      )}
      <ConfirmDialog open={!!loeschen} danger title="Korrespondent löschen" text={`„${loeschen?.name ?? ''}“ löschen? Regeln, die auf diesen Korrespondenten prüfen, treffen danach nicht mehr zu.`} confirmText="Löschen"
                     onCancel={() => setLoeschen(null)}
                     onConfirm={async () => {
                       const k = loeschen!;
                       setLoeschen(null);
                       try { toast((await api.del<{ text: string }>(`${EING}/korrespondenten/${k.id}`)).text); await laden(); } catch (e) { setError((e as Error).message); }
                     }} />
    </div>
  );
}
