import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, Button, CheckBox, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { TCO } from '../util';
import bildSpielplan from './anleitung/schritt1.jpg';
import bildPrompt from './anleitung/schritt2.jpg';
import bildTabelle from './anleitung/schritt3.jpg';
import '../halle.css';
import './kalender.css';

/**
 * Vereinskalender – Massenanlage (#16): Spielplan als Text einfügen (z. B. aus STB.LIGA.NU), das Portal bereitet ihn
 * als Tabelle auf. Ablauf: Einfügen → Tabelle mit Filtern und Massenbearbeitung → Freigabe → Anlegen → Protokoll.
 */
const K = `${TCO}/kalender`;
export const MASSE_HINWEIS = 'Prompt in Claude nach Screenshot bei STB.LIGA.NU => Teile mir diesen Screenshot in Spalten auf';
const PROMPT = 'Teile mir diesen Screenshot in Spalten auf';

/** Kurze Anleitung zum Vorgehen – als HTML in den Dialog eingebettet, aufklappbar (#16) */
function Anleitung({ offen }: { offen: boolean }) {
  const [kopiert, setKopiert] = useState(false);
  const kopieren = () => navigator.clipboard?.writeText(PROMPT).then(() => { setKopiert(true); window.setTimeout(() => setKopiert(false), 2500); }).catch(() => undefined);
  return (
    <details className="portal-kal__anleitung" open={offen}>
      <summary>Anleitung: vom Spielplan bei STB.LIGA.NU zu den Veranstaltungen im Kalender</summary>
      <ol>
        <li>
          <b>Screenshot bei STB.LIGA.NU erstellen</b>
          <p>Den Spielplan des Vereins öffnen und die Tabelle mit den Terminen als Bild aufnehmen, z. B. mit Snagit oder dem Snipping Tool.</p>
          <img src={bildSpielplan} alt="Spielplan bei STB.LIGA.NU mit Datum, Nr., Halle, Platz, Liga, Heim- und Gastmannschaft" loading="lazy" />
        </li>
        <li>
          <b>In Claude einfügen und den Prompt nutzen</b>
          <p>Den Screenshot in Claude einfügen und dazu schreiben:</p>
          <p className="portal-kal__anleitung-prompt">
            <code>{PROMPT}</code>
            <button type="button" onClick={kopieren}>{kopiert ? 'kopiert' : 'Prompt kopieren'}</button>
          </p>
          <img src={bildPrompt} alt="Screenshot des Spielplans in Claude mit dem Prompt „Teile mir diesen Screenshot in Spalten auf“" loading="lazy" />
        </li>
        <li>
          <b>Tabelle kopieren</b>
          <p>Claude antwortet mit einer Tabelle. Alle Zeilen markieren, am besten mit der Kopfzeile, und mit Strg+C kopieren.</p>
          <img src={bildTabelle} alt="Von Claude erzeugte Tabelle, alle Zeilen markiert" loading="lazy" />
        </li>
        <li>
          <b>Hier einfügen</b>
          <p>In das Textfeld unten klicken und mit Strg+V einfügen. Bei Bedarf „Titel beginnt mit“ anpassen, z. B. „Sommerrunde“.</p>
        </li>
        <li>
          <b>Als Tabelle aufbereiten</b>
          <p>Das Portal zeigt die Termine als Tabelle. Dort prüfen, filtern und für die ausgewählten Zeilen Titel, Ort, Art, Gruppe, Dauer und Anmeldung in einem Schritt setzen. Es wird noch nichts angelegt.</p>
        </li>
        <li>
          <b>Übernehmen</b>
          <p>„Weiter zur Freigabe“ zeigt die Auswahl. Erst „Freigeben und anlegen“ legt die Veranstaltungen im Kalender an. Termine, die es schon gibt, werden nicht doppelt angelegt.</p>
        </li>
      </ol>
    </details>
  );
}

interface Vorschau {
  zeile: number; tag: string; datum: string; uhrzeit: string | null; nr: string; halle: string; platz: string; liga: string; heim: string; gast: string;
  fehler: string | null; titel: string; ort: string; kategorie: string; beginn_lokal: string; ganztags: boolean; beschreibung: string; gruppe: number | null;
}
interface Zeile extends Vorschau { an: boolean; dauer: string; anmeldung: boolean }
interface Vorhanden { titel: string; beginn: string }
interface Protokoll { quelle: string; ok: boolean; text: string }
type Phase = 'einfuegen' | 'tabelle' | 'freigabe' | 'protokoll';

const klein = () => window.matchMedia?.('(max-width: 700px)').matches ?? false;
const zeitpunkt = (lokal: string) => new Date(lokal);
const beginnText = (z: Zeile) => (z.beginn_lokal
  ? zeitpunkt(z.beginn_lokal).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', ...(z.ganztags ? {} : { hour: '2-digit', minute: '2-digit' } as const) })
  : '–');
const stunden = (v: string) => Number(v.trim().replace(',', '.'));

/** Tabelle aus der Zwischenablage (HTML) → Zeilen mit Tabulator, damit Spalten sicher erkannt werden */
function htmlTabelle(html: string): string | null {
  if (!/<table/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const zeilen = [...doc.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()).join('\t'));
  return zeilen.length ? zeilen.join('\n') : null;
}

export function MassenanlageDialog({ kategorien, gruppen, onClose, onDone }: {
  kategorien: Record<string, string>; gruppen: { id: number; name: string; aktiv: boolean }[]; onClose: () => void; onDone: (t: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('einfuegen');
  const [text, setText] = useState('');
  const [praefix, setPraefix] = useState('Winterhallenrunde');
  const [zeilen, setZeilen] = useState<Zeile[]>([]);
  const [ignoriert, setIgnoriert] = useState(0);
  const [vorhanden, setVorhanden] = useState<Vorhanden[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [protokoll, setProtokoll] = useState<Protokoll[]>([]);
  const [ergebnis, setErgebnis] = useState('');
  // Filter
  const [suche, setSuche] = useState('');
  const [fLiga, setFLiga] = useState('');
  const [nurKuenftige, setNurKuenftige] = useState(false);
  // Massenbearbeitung
  const leer = { titel: '', ort: '', kategorie: '', gruppe: '', dauer: '', anmeldung: '' };
  const [m, setM] = useState(leer);

  const gruppenName = (id: number | null) => (id ? gruppen.find((g) => g.id === id)?.name ?? `Gruppe ${id}` : 'alle Mitglieder');
  const doppelt = (z: Zeile) => !!z.beginn_lokal && vorhanden.some((v) => v.titel === z.titel.trim() && new Date(v.beginn).getTime() === zeitpunkt(z.beginn_lokal).getTime());
  const hinweis = (z: Zeile) => z.fehler ?? (!z.titel.trim() ? 'Titel fehlt' : doppelt(z) ? 'bereits im Kalender' : null);

  async function aufbereiten() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ zeilen: Vorschau[]; ignoriert: number }>(`${K}/masse/vorschau`, { text, praefix });
      if (!r.zeilen.length) { setError('Im Text wurde kein Termin erkannt – erwartet werden Zeilen mit Datum (TT.MM.JJJJ), getrennt durch Tabulator oder „|“.'); return; }
      // vorhandene Veranstaltungen im Zeitraum: gleiche Veranstaltung (Titel und Beginn) wird nicht vorgeschlagen
      const tage = r.zeilen.map((z) => z.datum).filter(Boolean).sort();
      const da = tage.length ? (await api.get<{ events: Vorhanden[] }>(`${K}?von=${tage[0]}&bis=${tage[tage.length - 1]}`)).events : [];
      const gibtEs = (z: Vorschau) => da.some((v) => v.titel === z.titel && new Date(v.beginn).getTime() === zeitpunkt(z.beginn_lokal).getTime());
      setVorhanden(da);
      setIgnoriert(r.ignoriert);
      setZeilen(r.zeilen.map((z) => ({ ...z, an: !z.fehler && !gibtEs(z), dauer: '', anmeldung: true })));
      setSuche(''); setFLiga(''); setNurKuenftige(false); setM(leer);
      setPhase('tabelle');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const ligen = useMemo(() => [...new Set(zeilen.map((z) => z.liga).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')), [zeilen]);
  const jetzt = Date.now();
  const sichtbar = zeilen.filter((z) => (!fLiga || z.liga === fLiga)
    && (!nurKuenftige || (!!z.beginn_lokal && zeitpunkt(z.beginn_lokal).getTime() >= jetzt))
    && (!suche.trim() || [z.titel, z.ort, z.beschreibung, z.liga, beginnText(z)].join(' ').toLowerCase().includes(suche.trim().toLowerCase())));
  const waehlbar = (z: Zeile) => !hinweis(z);
  const gewaehlt = zeilen.filter((z) => z.an && waehlbar(z));
  const sichtbarGewaehlt = sichtbar.filter((z) => z.an && waehlbar(z));
  const sichtbarWaehlbar = sichtbar.filter(waehlbar);
  const alle = sichtbarWaehlbar.length > 0 && sichtbarWaehlbar.every((z) => z.an);
  const setze = (nr: number, x: Partial<Zeile>) => setZeilen((l) => l.map((z) => (z.zeile === nr ? { ...z, ...x } : z)));
  const dauerFehler = m.dauer.trim() !== '' && !(stunden(m.dauer) > 0);
  const mGesetzt = !!(m.titel.trim() || m.ort.trim() || m.kategorie || m.gruppe || m.dauer.trim() || m.anmeldung);

  /** Massenbearbeitung: gefüllte Felder auf die ausgewählten (und angezeigten) Zeilen übernehmen */
  function anwenden() {
    const nrn = new Set(sichtbarGewaehlt.map((z) => z.zeile));
    setZeilen((l) => l.map((z) => (nrn.has(z.zeile) ? {
      ...z,
      ...(m.titel.trim() ? { titel: m.titel.trim() } : {}),
      ...(m.ort.trim() ? { ort: m.ort.trim() } : {}),
      ...(m.kategorie ? { kategorie: m.kategorie } : {}),
      ...(m.gruppe ? { gruppe: m.gruppe === '-' ? null : Number(m.gruppe) } : {}),
      ...(m.dauer.trim() ? { dauer: m.dauer.trim() } : {}),
      ...(m.anmeldung ? { anmeldung: m.anmeldung === 'an' } : {}),
    } : z)));
    setM(leer);
  }

  async function anlegen() {
    setBusy(true); setError(null);
    try {
      const events = gewaehlt.map((z) => {
        const beginn = zeitpunkt(z.beginn_lokal);
        const h = stunden(z.dauer);
        return {
          titel: z.titel.trim(), ort: z.ort.trim() || null, kategorie: z.kategorie, beschreibung: z.beschreibung || null,
          beginn: beginn.toISOString(), ende: z.dauer.trim() && h > 0 ? new Date(beginn.getTime() + h * 3_600_000).toISOString() : null,
          ganztags: z.ganztags, anmeldung: z.anmeldung, gruppen: z.gruppe ? [z.gruppe] : [],
        };
      });
      const r = await api.post<{ zeilen: Protokoll[]; text: string }>(`${K}/masse`, { events });
      setProtokoll(r.zeilen); setErgebnis(r.text);
      setPhase('protokoll');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const schliessen = () => { if (busy) return; if (phase === 'protokoll') onDone(ergebnis); else onClose(); };
  const fuss = phase === 'einfuegen' ? (
    <Bar endContent={<>
      <Button design="Emphasized" icon="table-view" disabled={busy || !text.trim()} onClick={aufbereiten}>Als Tabelle aufbereiten</Button>
      <Button onClick={onClose}>Abbrechen</Button>
    </>} />
  ) : phase === 'tabelle' ? (
    <Bar startContent={<Text className="portal-az__fuss"><b>{gewaehlt.length}</b> von {zeilen.length} Veranstaltung(en) ausgewählt</Text>}
         endContent={<>
           <Button design="Emphasized" icon="accept" disabled={!gewaehlt.length} onClick={() => setPhase('freigabe')}>Weiter zur Freigabe</Button>
           <Button onClick={() => setPhase('einfuegen')}>Zurück</Button>
         </>} />
  ) : phase === 'freigabe' ? (
    <Bar endContent={<>
      <Button design="Emphasized" icon="accept" disabled={busy} onClick={anlegen}>Freigeben und anlegen</Button>
      <Button disabled={busy} onClick={() => setPhase('tabelle')}>Zurück</Button>
    </>} />
  ) : <Bar endContent={<Button design="Emphasized" onClick={schliessen}>Schließen</Button>} />;

  const kopf = (mitAuswahl: boolean) => (
    <thead>
      <tr>
        {mitAuswahl && <th><CheckBox checked={alle} indeterminate={sichtbarGewaehlt.length > 0 && !alle} accessibleName="Alle angezeigten Zeilen auswählen"
                                     onChange={(e) => { const an = e.target.checked; const nrn = new Set(sichtbarWaehlbar.map((z) => z.zeile)); setZeilen((l) => l.map((z) => (nrn.has(z.zeile) ? { ...z, an } : z))); }} /></th>}
        <th><Label>Beginn</Label></th><th><Label>Titel</Label></th><th><Label>Ort</Label></th><th><Label>Art</Label></th>
        <th><Label>Gruppe</Label></th><th><Label>Begegnung</Label></th><th><Label>{mitAuswahl ? 'Hinweis' : 'Dauer / Anmeldung'}</Label></th>
      </tr>
    </thead>
  );
  const zusatz = (z: Zeile) => [z.dauer.trim() ? `${z.dauer.trim()} Std.` : 'ohne Ende', z.anmeldung ? 'mit Anmeldung' : 'ohne Anmeldung'].join(' · ');

  return createPortal(
    <Dialog open stretch={klein()} onClose={schliessen} className="portal-az__dialog"
            headerText={phase === 'protokoll' ? 'Protokoll Massenanlage' : phase === 'freigabe' ? 'Veranstaltungen freigeben' : 'Veranstaltungen in Masse anlegen'}
            style={klein() ? undefined : { width: 'min(84rem, 97vw)', height: '90vh' }} footer={fuss}>
      <div className="portal-az">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}

        {phase === 'einfuegen' && <>
          <MessageStrip design="Information" hideCloseButton>{MASSE_HINWEIS}</MessageStrip>
          <Anleitung offen={!text.trim()} />
          <div className="portal-kal__masse-kopf">
            <Label for="km-praefix" showColon>Titel beginnt mit</Label>
            <Input id="km-praefix" value={praefix} maxlength={60} onInput={(e) => setPraefix(e.target.value)} style={{ width: '16rem' }} />
            <Text className="portal-muted portal-small">Titel = „{praefix.trim() || '…'} Herren 40 VL“</Text>
          </div>
          <div onPaste={(e) => {
            const t = htmlTabelle(e.clipboardData.getData('text/html'));
            if (t) { e.preventDefault(); setText((alt) => (alt.trim() ? `${alt.replace(/\s+$/, '')}\n${t}` : t)); }
          }}>
            <TextArea rows={16} value={text} onInput={(e) => setText(e.target.value)}
                      placeholder={'Spielplan hier mit Strg+V einfügen – eine Zeile je Termin, Spalten durch Tabulator oder „|“ getrennt:\n\nTag | Datum | Uhrzeit | Nr. | Halle | Platz | Liga | Heimmannschaft | Gastmannschaft\nSa | 07.11.2026 | 17:00 | 161 | Halle Homburg | 1+2 | Herren 40 VL | TC Limbach 1 | TC Oberthal 1'} />
          </div>
          <Text className="portal-muted portal-small">
            Zuordnung: Titel = Präfix + Liga · Art = Mannschaft / Spieltag · Ort = Halle | Platz · Beginn = Datum und Uhrzeit ·
            Beschreibung = Heim – Gast und Spiel-Nr. · Gruppe = passende Mitgliedergruppe zur Liga (z. B. „Herren 40“). Es wird noch nichts angelegt.
          </Text>
        </>}

        {phase === 'tabelle' && <>
          <div className="portal-az__leiste">
            <Input placeholder="Suchen …" value={suche} showClearIcon onInput={(e) => setSuche(e.target.value)} style={{ width: '14rem' }} />
            <Select accessibleName="Liga" style={{ width: '14rem' }} onChange={(e) => setFLiga((e.detail.selectedOption as HTMLElement).dataset.l ?? '')}>
              <Option data-l="" selected={!fLiga}>Alle Ligen</Option>
              {ligen.map((l) => <Option key={l} data-l={l} selected={l === fLiga}>{l}</Option>)}
            </Select>
            <CheckBox text="Nur künftige Termine" checked={nurKuenftige} onChange={(e) => setNurKuenftige(e.target.checked)} />
            <Text className="portal-muted portal-small">{sichtbar.length} von {zeilen.length} Zeilen{ignoriert ? ` · ${ignoriert} Textzeile(n) ohne Datum übergangen` : ''}</Text>
          </div>

          <div className="portal-kal__masse-bearbeiten">
            <Label>Massenbearbeitung für {sichtbarGewaehlt.length} ausgewählte Zeile(n)</Label>
            <div className="portal-az__leiste">
              <Input placeholder="Titel" value={m.titel} maxlength={120} onInput={(e) => setM({ ...m, titel: e.target.value })} style={{ width: '14rem' }} />
              <Input placeholder="Ort" value={m.ort} maxlength={120} onInput={(e) => setM({ ...m, ort: e.target.value })} style={{ width: '12rem' }} />
              <Select accessibleName="Art" style={{ width: '12rem' }} onChange={(e) => setM({ ...m, kategorie: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
                <Option data-k="" selected={!m.kategorie}>Art unverändert</Option>
                {Object.entries(kategorien).map(([k, t]) => <Option key={k} data-k={k} selected={m.kategorie === k}>{t}</Option>)}
              </Select>
              <Select accessibleName="Gruppe" style={{ width: '14rem' }} onChange={(e) => setM({ ...m, gruppe: (e.detail.selectedOption as HTMLElement).dataset.g ?? '' })}>
                <Option data-g="" selected={!m.gruppe}>Gruppe unverändert</Option>
                <Option data-g="-" selected={m.gruppe === '-'}>ohne Gruppe (alle Mitglieder)</Option>
                {gruppen.filter((g) => g.aktiv).map((g) => <Option key={g.id} data-g={g.id} selected={m.gruppe === String(g.id)}>{g.name}</Option>)}
              </Select>
              <Input placeholder="Dauer (Std.)" value={m.dauer} valueState={dauerFehler ? 'Negative' : 'None'} onInput={(e) => setM({ ...m, dauer: e.target.value })} style={{ width: '8rem' }} />
              <Select accessibleName="Anmeldung" style={{ width: '12rem' }} onChange={(e) => setM({ ...m, anmeldung: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
                <Option data-a="" selected={!m.anmeldung}>Anmeldung unverändert</Option>
                <Option data-a="an" selected={m.anmeldung === 'an'}>mit An- und Abmeldung</Option>
                <Option data-a="aus" selected={m.anmeldung === 'aus'}>ohne Anmeldung</Option>
              </Select>
              <Button icon="multi-select" disabled={!sichtbarGewaehlt.length || !mGesetzt || dauerFehler} onClick={anwenden}>Auf Auswahl anwenden</Button>
            </div>
          </div>

          <div className="portal-sv__tabelle-rahmen">
            <table className="portal-sv__tabelle">
              {kopf(true)}
              <tbody>
                {sichtbar.map((z) => {
                  const h = hinweis(z);
                  return (
                    <tr key={z.zeile} className={`${z.an && !h ? 'portal-sv__zeile--an' : ''}${h ? ' portal-sv__zeile--gesperrt' : ''}`}>
                      <td><CheckBox checked={z.an && !h} disabled={!!h} accessibleName={`${z.titel} auswählen`} onChange={(e) => setze(z.zeile, { an: e.target.checked })} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}><Text>{beginnText(z)}</Text></td>
                      <td><Input value={z.titel} maxlength={120} accessibleName="Titel" onInput={(e) => setze(z.zeile, { titel: e.target.value })} style={{ width: '100%', minWidth: '14rem' }} /></td>
                      <td><Input value={z.ort} maxlength={120} accessibleName="Ort" onInput={(e) => setze(z.zeile, { ort: e.target.value })} style={{ width: '100%', minWidth: '12rem' }} /></td>
                      <td><Text>{kategorien[z.kategorie] ?? z.kategorie}</Text></td>
                      <td><Text>{gruppenName(z.gruppe)}</Text></td>
                      <td><Text>{z.beschreibung.split('\n')[0]}</Text><div><Text className="portal-muted portal-small">{zusatz(z)}</Text></div></td>
                      <td>{h ? <ObjectStatus state={z.fehler || !z.titel.trim() ? 'Negative' : 'Critical'} showDefaultIcon>{h}</ObjectStatus> : null}</td>
                    </tr>
                  );
                })}
                {!sichtbar.length && <tr><td colSpan={8}><Text className="portal-muted">Keine Zeile passt zum Filter.</Text></td></tr>}
              </tbody>
            </table>
          </div>
        </>}

        {phase === 'freigabe' && <>
          <MessageStrip design="Information" hideCloseButton>
            Mit der Freigabe werden <b>{gewaehlt.length}</b> Veranstaltung(en) im Vereinskalender angelegt. Mitglieder der zugeordneten Gruppen sehen sie sofort.
          </MessageStrip>
          <div className="portal-sv__tabelle-rahmen">
            <table className="portal-sv__tabelle">
              {kopf(false)}
              <tbody>
                {gewaehlt.map((z) => (
                  <tr key={z.zeile}>
                    <td style={{ whiteSpace: 'nowrap' }}><Text>{beginnText(z)}</Text></td>
                    <td><Text>{z.titel}</Text></td><td><Text>{z.ort}</Text></td><td><Text>{kategorien[z.kategorie] ?? z.kategorie}</Text></td>
                    <td><Text>{gruppenName(z.gruppe)}</Text></td><td><Text>{z.beschreibung.split('\n')[0]}</Text></td><td><Text>{zusatz(z)}</Text></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>}

        {phase === 'protokoll' && <>
          <MessageStrip design={protokoll.every((p) => p.ok) ? 'Positive' : 'Critical'} hideCloseButton>{ergebnis}</MessageStrip>
          <div className="portal-sv__tabelle-rahmen">
            <table className="portal-sv__tabelle">
              <thead><tr><th><Label>Veranstaltung</Label></th><th><Label>Ergebnis</Label></th><th><Label>Meldung</Label></th></tr></thead>
              <tbody>
                {protokoll.map((p, i) => (
                  <tr key={i}>
                    <td><Text>{p.quelle}</Text></td>
                    <td><ObjectStatus state={p.ok ? 'Positive' : 'Critical'} showDefaultIcon>{p.ok ? 'ok' : 'übersprungen'}</ObjectStatus></td>
                    <td><Text>{p.text}</Text></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>}
      </div>
    </Dialog>,
    document.body,
  );
}
