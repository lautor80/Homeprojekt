import { useEffect, useMemo, useState } from 'react';
import {
  Button, CheckBox, ComboBox, ComboBoxItem, Input, Label, List, ListItemGroup, ListItemStandard, MessageStrip, ObjectStatus, Tab, TabContainer, Text, Title,
} from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { MasterDetail } from '../components/MasterDetail';
import { ObjectHeader } from '../components/ObjectHeader';
import { Section } from '../components/Section';
import { ChangeHistoryButton } from '../components/ChangeHistory';
import { toast } from '../toast';

/**
 * Paperless-Zuordnung: je Ablagekontext (FI-Beleg, Mitglied, Auftrag, Rechnung …) die Regeln, wie Titel,
 * Korrespondent, Dokumenttyp, Speicherpfad, Tags, Datum, Notiz und Custom Fields gefüllt werden –
 * Vorlagen mit Platzhaltern, Vorschau mit Beispielwerten, Auswahllisten aus Paperless.
 */
type Feld = 'titel' | 'korrespondent' | 'dokumenttyp' | 'speicherpfad' | 'tags' | 'datum' | 'notiz';
interface Regel { titel?: string; korrespondent?: string; dokumenttyp?: string; speicherpfad?: string; tags?: string; datum?: string; notiz?: string; felder?: Record<string, string>; anlegen?: boolean }
interface Platzhalter { name: string; text: string; beispiel: string | number }
interface Zuordnung { title: string; created?: string; correspondent: string; documentType: string; storagePath: string; tags: string[]; notiz: string; customFields: Record<string, string | number | null>; anlegen: boolean }
interface Kontext {
  id: string; text: string; beschreibung?: string; platzhalter: Platzhalter[]; standard: Regel; benutzerwahl?: Feld[];
  eigene: Regel | null; wirksam: Regel; vorschau: Zuordnung; geaendert: boolean;
}
interface Modul { modul: string; name: string; kontexte: Kontext[] }
interface Listen { paperless: boolean; fehler?: string; dokumenttypen: string[]; speicherpfade: string[]; tags: string[]; korrespondenten: string[]; felder: { name: string; typ: string }[] }

const FELDER: { key: Feld; text: string; hinweis: string; liste?: keyof Listen }[] = [
  { key: 'titel', text: 'Titel', hinweis: 'Titel des Dokuments in Paperless' },
  { key: 'korrespondent', text: 'Korrespondent', hinweis: 'Name; wird bei Bedarf in Paperless angelegt', liste: 'korrespondenten' },
  { key: 'dokumenttyp', text: 'Dokumenttyp', hinweis: 'muss in Paperless existieren', liste: 'dokumenttypen' },
  { key: 'speicherpfad', text: 'Speicherpfad', hinweis: 'muss in Paperless existieren', liste: 'speicherpfade' },
  { key: 'tags', text: 'Tags', hinweis: 'mehrere durch Komma; werden bei Bedarf angelegt', liste: 'tags' },
  { key: 'datum', text: 'Dokumentdatum', hinweis: 'JJJJ-MM-TT, z. B. {heute}' },
  { key: 'notiz', text: 'Notiz', hinweis: 'wird als Notiz an das Dokument angehängt (leer = keine)' },
];
const MODS = ['|upper', '|lower', '|datum', '|kurz:40', '|pad:6', '|ohneEndung', '|betrag'];

export function PaperlessMappingPage() {
  const [module, setModule] = useState<Modul[] | null>(null);
  const [auswahl, setAuswahl] = useState<{ modul: string; kontext: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<{ module: Modul[] }>('/api/paperless/mapping').then((r) => setModule(r.module)).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  const k = module?.find((m) => m.modul === auswahl?.modul)?.kontexte.find((x) => x.id === auswahl?.kontext) ?? null;
  const anz = module?.reduce((s, m) => s + m.kontexte.length, 0) ?? 0;
  const geaendert = module?.reduce((s, m) => s + m.kontexte.filter((x) => x.geaendert).length, 0) ?? 0;

  return (
    <AppPage title="Paperless-Zuordnung" subtitle={module ? `${anz} Ablagekontexte · ${geaendert} mit eigener Regel` : ''}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <MasterDetail masterWidth="24rem" emptyTitle="Kein Kontext ausgewählt" emptyText="Links einen Ablagekontext wählen, um die Regel zu bearbeiten."
                    onBack={() => setAuswahl(null)}
                    masterHead={<Title level="H5">Ablagekontexte</Title>}
                    master={
                      <List onItemClick={(e) => { const el = e.detail.item as HTMLElement; setAuswahl({ modul: el.dataset.m!, kontext: el.dataset.k! }); }}
                            noDataText={module ? 'Keine Module mit Paperless-Ablage aktiv' : 'Wird geladen …'}>
                        {module?.map((m) => (
                          <ListItemGroup key={m.modul} headerText={m.name}>
                            {m.kontexte.map((x) => (
                              <ListItemStandard key={x.id} data-m={m.modul} data-k={x.id} type="Active" selected={auswahl?.modul === m.modul && auswahl.kontext === x.id}
                                                icon={x.geaendert ? 'edit' : 'document'} description={x.vorschau.title || '–'}
                                                additionalText={x.geaendert ? 'eigene Regel' : 'Standard'} additionalTextState={x.geaendert ? 'Information' : 'None'}>
                                {x.text}
                              </ListItemStandard>
                            ))}
                          </ListItemGroup>
                        ))}
                      </List>
                    }
                    detail={k && auswahl ? <KontextDetail key={`${auswahl.modul}/${k.id}`} modul={auswahl.modul} modulName={module!.find((m) => m.modul === auswahl.modul)!.name} k={k} onSaved={laden} /> : null} />
    </AppPage>
  );
}

function KontextDetail({ modul, modulName, k, onSaved }: { modul: string; modulName: string; k: Kontext; onSaved: () => void }) {
  const [regel, setRegel] = useState<Regel>({ ...k.wirksam, felder: { ...(k.wirksam.felder ?? {}) } });
  const [listen, setListen] = useState<Listen | null>(null);
  const [vorschau, setVorschau] = useState<Zuordnung>(k.vorschau);
  const [tab, setTab] = useState('felder');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [neuesFeld, setNeuesFeld] = useState('');

  useEffect(() => { api.get<Listen>(`/api/paperless/mapping/${modul}/listen`).then(setListen).catch(() => setListen(null)); }, [modul]);
  useEffect(() => {
    const t = setTimeout(() => api.post<Zuordnung>(`/api/paperless/mapping/${modul}/${k.id}/vorschau`, regel).then(setVorschau).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [regel, modul, k.id]);

  const set = (f: Feld, v: string) => setRegel({ ...regel, [f]: v });
  const standard = useMemo(() => JSON.stringify({ ...k.standard, felder: k.standard.felder ?? {} }) === JSON.stringify({ ...regel, felder: regel.felder ?? {} }), [regel, k.standard]);
  const benutzerwahl = new Set(k.benutzerwahl ?? []);

  async function speichern() {
    setBusy(true); setError(null);
    try { const r = await api.put<{ text: string }>(`/api/paperless/mapping/${modul}/${k.id}`, regel); toast(r.text, 5000); onSaved(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function zuruecksetzen() {
    setBusy(true); setError(null);
    try { const r = await api.del<{ text: string }>(`/api/paperless/mapping/${modul}/${k.id}`); toast(r.text); setRegel({ ...k.standard, felder: { ...(k.standard.felder ?? {}) } }); onSaved(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const einfuegen = (f: Feld | `feld:${string}`, text: string) => {
    if (f.startsWith('feld:')) { const name = f.slice(5); setRegel({ ...regel, felder: { ...(regel.felder ?? {}), [name]: `${regel.felder?.[name] ?? ''}${text}` } }); }
    else set(f as Feld, `${regel[f as Feld] ?? ''}${text}`);
  };
  const [aktiv, setAktiv] = useState<Feld | `feld:${string}`>('titel');

  const feldEingabe = (f: Feld, liste?: keyof Listen) => {
    const werte = liste && listen ? (listen[liste] as string[]) : [];
    const gewaehlt = benutzerwahl.has(f);
    return (
      <div key={f} className="portal-pm__feld">
        <Label showColon>{FELDER.find((x) => x.key === f)!.text}</Label>
        <div className="portal-pm__eingabe">
          {werte.length && !gewaehlt
            ? <ComboBox value={regel[f] ?? ''} placeholder={gewaehlt ? 'wählt der Benutzer' : 'Vorlage oder Wert aus Paperless'} style={{ width: '100%' }}
                        onInput={(e) => set(f, (e.target as unknown as { value: string }).value)} onFocus={() => setAktiv(f)}
                        onSelectionChange={(e) => { const t = (e.detail.item as HTMLElement & { text?: string } | null)?.text; if (t) set(f, t); }}>
                {werte.map((w) => <ComboBoxItem key={w} text={w} />)}
              </ComboBox>
            : <Input value={regel[f] ?? ''} disabled={gewaehlt} placeholder={gewaehlt ? 'wählt der Benutzer an dieser Stelle' : ''} style={{ width: '100%' }}
                     onInput={(e) => set(f, e.target.value)} onFocus={() => setAktiv(f)} />}
          <span className="portal-pm__ergebnis">
            {gewaehlt ? <span className="portal-muted">Benutzerauswahl</span>
              : f === 'tags' ? (vorschau.tags.join(', ') || '–')
                : f === 'titel' ? (vorschau.title || '–') : f === 'korrespondent' ? (vorschau.correspondent || '–') : f === 'dokumenttyp' ? (vorschau.documentType || '–')
                  : f === 'speicherpfad' ? (vorschau.storagePath || '–') : f === 'datum' ? (vorschau.created || '–') : (vorschau.notiz || '–')}
          </span>
        </div>
        <span className="portal-muted portal-small">{FELDER.find((x) => x.key === f)!.hinweis}</span>
      </div>
    );
  };

  return (
    <div>
      <ObjectHeader title={k.text} icon="document" subtitle={`${modulName} · Kontext ${k.id}`}
                    status={<>{k.geaendert ? <ObjectStatus state="Information" inverted>eigene Regel</ObjectStatus> : <ObjectStatus state="None" inverted>Standardregel</ObjectStatus>}
                      {listen && !listen.paperless && <ObjectStatus state="Critical">Paperless für {modulName} nicht eingerichtet – keine Auswahllisten</ObjectStatus>}
                      {listen?.fehler && <ObjectStatus state="Critical">{listen.fehler}</ObjectStatus>}</>}
                    actions={<>
                      <Button design="Emphasized" icon="save" disabled={busy} onClick={speichern}>Speichern</Button>
                      <Button icon="reset" disabled={busy || (standard && !k.geaendert)} onClick={zuruecksetzen}>Auf Standard zurücksetzen</Button>
                      <ChangeHistoryButton objectType="PAPERLESS_MAPPING" objectKey={`${modul}/${k.id}`} />
                    </>}>
        {k.beschreibung && <Text>{k.beschreibung}</Text>}
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginTop: '0.5rem' }}>{error}</MessageStrip>}
      </ObjectHeader>

      <div className="portal-section">
        <TabContainer tabLayout="Inline" contentBackgroundDesign="Transparent" onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key!)}>
          <Tab data-key="felder" text="Standardfelder" selected={tab === 'felder'}>
            <div className="portal-pm__raster">
              <div>
                {FELDER.map((f) => feldEingabe(f.key, f.liste))}
                <CheckBox text="Fehlende Korrespondenten und Tags in Paperless anlegen" checked={regel.anlegen !== false} onChange={(e) => setRegel({ ...regel, anlegen: e.target.checked })} />
              </div>
              <Platzhalterliste k={k} onEinfuegen={(t) => einfuegen(aktiv, t)} />
            </div>
          </Tab>
          <Tab data-key="custom" text={`Custom Fields (${Object.keys(regel.felder ?? {}).length})`} selected={tab === 'custom'}>
            <div className="portal-pm__raster">
              <div>
                {Object.entries(regel.felder ?? {}).map(([name, vorlage]) => (
                  <div key={name} className="portal-pm__feld">
                    <Label showColon>{name}{listen?.felder.find((f) => f.name === name)?.typ ? <span className="portal-muted"> ({listen.felder.find((f) => f.name === name)!.typ})</span> : null}</Label>
                    <div className="portal-pm__eingabe">
                      <Input value={vorlage} style={{ width: '100%' }} onFocus={() => setAktiv(`feld:${name}`)}
                             onInput={(e) => setRegel({ ...regel, felder: { ...(regel.felder ?? {}), [name]: e.target.value } })} />
                      <span className="portal-pm__ergebnis">{String(vorschau.customFields[name] ?? '–')}</span>
                      <Button design="Transparent" icon="decline" tooltip="Feld entfernen" onClick={() => { const f = { ...(regel.felder ?? {}) }; delete f[name]; setRegel({ ...regel, felder: f }); }} />
                    </div>
                    {listen && listen.paperless && !listen.felder.some((f) => f.name === name) && <ObjectStatus state="Critical">Feld existiert in Paperless nicht</ObjectStatus>}
                  </div>
                ))}
                <div className="portal-pm__feld">
                  <Label showColon>Weiteres Custom Field</Label>
                  <div className="portal-pm__eingabe">
                    {listen?.felder.length
                      ? <ComboBox value={neuesFeld} placeholder="Feld in Paperless wählen oder Name eingeben" style={{ width: '100%' }}
                                  onInput={(e) => setNeuesFeld((e.target as unknown as { value: string }).value)}
                                  onSelectionChange={(e) => setNeuesFeld((e.detail.item as HTMLElement & { text?: string } | null)?.text ?? '')}>
                          {listen.felder.filter((f) => !regel.felder?.[f.name]).map((f) => <ComboBoxItem key={f.name} text={f.name} additionalText={f.typ} />)}
                        </ComboBox>
                      : <Input value={neuesFeld} placeholder="Name des Felds in Paperless" style={{ width: '100%' }} onInput={(e) => setNeuesFeld(e.target.value)} />}
                    <Button icon="add" disabled={!neuesFeld.trim() || !!regel.felder?.[neuesFeld.trim()]}
                            onClick={() => { setRegel({ ...regel, felder: { ...(regel.felder ?? {}), [neuesFeld.trim()]: '' } }); setAktiv(`feld:${neuesFeld.trim()}`); setNeuesFeld(''); }}>Hinzufügen</Button>
                  </div>
                  <span className="portal-muted portal-small">Geldfelder: Vorlage nur aus einem Zahl-Platzhalter, z. B. {'{betrag}'} – dann wird der Betrag als Zahl übergeben.</span>
                </div>
              </div>
              <Platzhalterliste k={k} onEinfuegen={(t) => einfuegen(aktiv, t)} />
            </div>
          </Tab>
          <Tab data-key="vorschau" text="Vorschau" selected={tab === 'vorschau'}>
            <Section title="Ergebnis mit Beispielwerten">
              <table className="portal-pm__tabelle">
                <tbody>
                  <tr><th>Titel</th><td>{vorschau.title || '–'}</td></tr>
                  <tr><th>Korrespondent</th><td>{vorschau.correspondent || '–'}</td></tr>
                  <tr><th>Dokumenttyp</th><td>{vorschau.documentType || '–'}</td></tr>
                  <tr><th>Speicherpfad</th><td>{vorschau.storagePath || '–'}</td></tr>
                  <tr><th>Tags</th><td>{vorschau.tags.join(', ') || '–'}</td></tr>
                  <tr><th>Dokumentdatum</th><td>{vorschau.created || '–'}</td></tr>
                  <tr><th>Notiz</th><td>{vorschau.notiz || '–'}</td></tr>
                  {Object.entries(vorschau.customFields).map(([n, v]) => <tr key={n}><th>{n}</th><td>{v === null ? '–' : typeof v === 'number' ? `${v} (Zahl)` : v}</td></tr>)}
                </tbody>
              </table>
              <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>Beispielwerte der Platzhalter – die echte Ablage nutzt die Werte des jeweiligen Objekts.</Text>
            </Section>
          </Tab>
        </TabContainer>
      </div>
    </div>
  );
}

function Platzhalterliste({ k, onEinfuegen }: { k: Kontext; onEinfuegen: (t: string) => void }) {
  return (
    <aside className="portal-pm__ph">
      <Title level="H6">Platzhalter</Title>
      <Text className="portal-muted portal-small">Klick fügt den Platzhalter in das zuletzt gewählte Feld ein.</Text>
      <div className="portal-pm__ph-liste">
        {k.platzhalter.map((p) => (
          <button key={p.name} type="button" className="portal-pm__ph-eintrag" onClick={() => onEinfuegen(`{${p.name}}`)} title={p.text}>
            <code>{`{${p.name}}`}</code><span>{p.text}</span><small>z. B. {String(p.beispiel)}</small>
          </button>
        ))}
      </div>
      <Title level="H6" style={{ marginTop: '0.75rem' }}>Modifikatoren</Title>
      <div className="portal-pm__mods">{MODS.map((m) => <code key={m}>{m}</code>)}</div>
      <Text className="portal-muted portal-small">z. B. {'{datei|ohneEndung}'}, {'{angelegt_am|datum}'}, {'{dokid|pad:6}'}, {'{kunde|upper|kurz:30}'}</Text>
    </aside>
  );
}
