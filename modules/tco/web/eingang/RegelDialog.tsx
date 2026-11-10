import { useState, type CSSProperties, type ReactNode } from 'react';
import { Bar, Button, CheckBox, ComboBox, ComboBoxItem, Dialog, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { EING, MAIL_ORDNER, type Aktionen, type Extraktion, type MailArt, type PaperlessZiel, type RegelEingabe, type Stamm, type Zuordnung, type Zusammenfassen } from './typen';

/**
 * Regel des Dokumenteneingangs pflegen: Bedingungen, Extraktion per Muster, Ablage (Paperless, Nextcloud),
 * Behandlung der E-Mail – mit Probe gegen eine Beispiel-E-Mail (nichts wird gespeichert oder abgelegt).
 */
interface TestErgebnis {
  passt: boolean; bedingungen: boolean[]; korrespondent: string | null; mitglied: string | null; felder: Record<string, string>; fehlend: string[];
  paperless: Zuordnung | null; nextcloud: { pfad: string; dateiname: string } | null;
}

export function Wahl({ wert, optionen, onChange, style, disabled }: { wert: string; optionen: [string, string][]; onChange: (k: string) => void; style?: CSSProperties; disabled?: boolean }) {
  return (
    <Select style={style} disabled={disabled} onChange={(e) => onChange((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
      {optionen.map(([k, t]) => <Option key={k} data-k={k} selected={k === wert}>{t}</Option>)}
    </Select>
  );
}

/** Freitext mit Vorschlägen aus Paperless */
export function Vorschlag({ wert, werte, onChange, placeholder, disabled }: { wert: string; werte: string[]; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  return (
    <ComboBox value={wert} placeholder={placeholder} disabled={disabled} style={{ width: '100%' }}
              onInput={(e) => onChange((e.target as unknown as { value: string }).value)}
              onSelectionChange={(e) => { const t = (e.detail.item as HTMLElement & { text?: string } | null)?.text; if (t) onChange(t); }}>
      {werte.map((w) => <ComboBoxItem key={w} text={w} />)}
    </ComboBox>
  );
}

/** Zielordner im Postfach: Auswahl der bekannten Ordner (IMAP-Pfad für n8n) oder freie Eingabe */
export function Zielordner({ wert, onChange }: { wert: string; onChange: (pfad: string) => void }) {
  const bekannt = MAIL_ORDNER.some(([p]) => p === wert);
  const [frei, setFrei] = useState(!!wert && !bekannt);
  return (
    <>
      <Wahl wert={frei ? '*' : wert} style={{ width: '16rem' }} optionen={[['', 'Ordner wählen …'], ...MAIL_ORDNER.map(([p, n]): [string, string] => [p, n]), ['*', 'anderer Ordner …']]}
            onChange={(k) => { if (k === '*') { setFrei(true); onChange(bekannt ? '' : wert); } else { setFrei(false); onChange(k); } }} />
      {frei && <Input value={wert} placeholder="IMAP-Pfad, z. B. INBOX.Belege" style={{ width: '14rem' }} onInput={(e) => onChange(e.target.value)} />}
    </>
  );
}

const raster: CSSProperties = { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1rem', alignItems: 'center' };
const zeile: CSSProperties = { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.35rem' };

function Block({ titel, hinweis, children }: { titel: string; hinweis?: string; children: ReactNode }) {
  return (
    <div style={{ borderTop: '1px solid var(--sapList_BorderColor)', paddingTop: '0.75rem', marginTop: '0.75rem' }}>
      <div style={{ fontWeight: 'bold', marginBottom: hinweis ? '0.15rem' : '0.5rem' }}>{titel}</div>
      {hinweis && <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>{hinweis}</Text>}
      {children}
    </div>
  );
}

const TYP_TEXT: Record<string, string> = {
  string: 'Text', longtext: 'Text', monetary: 'Betrag', date: 'Datum', integer: 'Ganzzahl', float: 'Zahl', boolean: 'Ja/Nein', select: 'Auswahl',
  url: 'Link', documentlink: 'Dokumentverknüpfung',
};
const BEISPIEL: Record<string, string> = {
  monetary: '{feld.betrag} oder 12,50', date: '{datum} oder 31.12.2026', integer: '{feld.nr}', float: '{feld.wert}', boolean: 'ja oder nein', select: 'Option wählen',
};

/** Custom Fields in Paperless: Feld wählen und Wert oder Vorlage angeben (z. B. {feld.betrag}) */
function CustomFelder({ felder, verfuegbar, extraktion, onChange }: {
  felder: Record<string, string>; verfuegbar: Stamm['paperless']['felder']; extraktion: Extraktion[]; onChange: (f: Record<string, string>) => void;
}) {
  const [zeilen, setZeilen] = useState<[string, string][]>(() => Object.entries(felder));
  const setzen = (z: [string, string][]) => { setZeilen(z); onChange(Object.fromEntries(z.filter(([n]) => n.trim()))); };
  const vorlagen = [...extraktion.filter((x) => x.name).map((x) => `{feld.${x.name}}`), '{datum}', '{heute}', '{betreff}', '{korrespondent}'];
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <Label>Benutzerdefinierte Felder</Label>
      {!verfuegbar.length && <Text className="portal-muted portal-small" style={{ display: 'block' }}>In Paperless sind keine Custom Fields angelegt (oder Paperless ist nicht erreichbar).</Text>}
      {zeilen.map(([name, wert], i) => {
        const f = verfuegbar.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
        const werte = f?.typ === 'select' ? f.optionen : f?.typ === 'boolean' ? ['ja', 'nein'] : vorlagen;
        return (
          <div key={i} style={{ ...zeile, marginTop: '0.35rem' }}>
            <div style={{ width: '14rem' }}>
              <Vorschlag wert={name} werte={verfuegbar.map((x) => x.name)} placeholder="Feld in Paperless"
                         onChange={(v) => setzen(zeilen.map((z, j) => (j === i ? [v, z[1]] : z)))} />
            </div>
            <div style={{ flex: '1 1 14rem' }}>
              <Vorschlag wert={wert} werte={werte} placeholder={f ? BEISPIEL[f.typ] ?? '{feld.name}' : 'Wert oder Vorlage'}
                         onChange={(v) => setzen(zeilen.map((z, j) => (j === i ? [z[0], v] : z)))} />
            </div>
            <Text className="portal-muted portal-small" style={{ width: '6rem' }}>{f ? TYP_TEXT[f.typ] ?? f.typ : name ? 'unbekannt' : ''}</Text>
            <Button design="Transparent" icon="delete" tooltip="Feld entfernen" onClick={() => setzen(zeilen.filter((_, j) => j !== i))} />
          </div>
        );
      })}
      <Button design="Transparent" icon="add" onClick={() => setZeilen([...zeilen, ['', '']])}>Feld</Button>
    </div>
  );
}

export function RegelDialog({ id, start, stamm, onClose, onSaved }: {
  id: number | null; start: RegelEingabe; stamm: Stamm; onClose: () => void; onSaved: () => void;
}) {
  const [r, setR] = useState<RegelEingabe>(start);
  const [prio, setPrio] = useState(String(start.prioritaet));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState({ von: '', betreff: '', datei: '', text: '', doktext: '' });
  const [test, setTest] = useState<TestErgebnis | null>(null);
  const [hilfe, setHilfe] = useState(false);

  const a = r.aktionen;
  const setA = (teil: Partial<Aktionen>) => { setR({ ...r, aktionen: { ...r.aktionen, ...teil } }); setTest(null); };
  const pl: PaperlessZiel = a.paperless ?? { aktiv: false };
  const nc = a.nextcloud ?? { aktiv: false, pfad: '', dateiname: '' };
  const mail = a.mail ?? { art: 'keine' as MailArt, ordner: '', gelesen: false };
  const aufgabe = a.aufgabe ?? { aktiv: false, titel: '', faellig_tage: null };
  const zus: Zusammenfassen = a.zusammenfassen ?? { aktiv: false, dateiname: '{datum}_{kurz}_{datei|ohneEndung}', reihenfolge: 'mail' };
  const felder = Object.entries(stamm.felder).filter(([k]) => r.gilt_fuer === 'anhang' || !['datei', 'mime', 'doktext'].includes(k));

  const fertig = (): RegelEingabe => ({ ...r, prioritaet: Number(prio) || 0 });

  async function speichern() {
    setBusy(true); setError(null);
    try {
      const antwort = id ? await api.put<{ text: string }>(`${EING}/regeln/${id}`, fertig()) : await api.post<{ text: string }>(`${EING}/regeln`, fertig());
      toast(antwort.text, 4000);
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function testen() {
    setBusy(true); setError(null);
    try {
      setTest(await api.post<TestErgebnis>(`${EING}/regeln/test`, { regel: fertig(), probe }));
    } catch (e) { setError((e as Error).message); setTest(null); } finally { setBusy(false); }
  }

  return (
    <Dialog open headerText={id ? `Regel ändern – ${start.name}` : 'Regel anlegen'} style={{ width: 'min(60rem, 98vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={busy} onClick={speichern}>Speichern</Button>
              <Button design="Transparent" onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <div style={raster}>
        <Label required>Name</Label>
        <Input value={r.name} maxlength={120} style={{ width: '100%' }} onInput={(e) => setR({ ...r, name: e.target.value })} />
        <Label>Beschreibung</Label>
        <Input value={r.beschreibung} maxlength={1000} style={{ width: '100%' }} onInput={(e) => setR({ ...r, beschreibung: e.target.value })} />
        <Label>Einstellungen</Label>
        <div style={{ ...zeile, marginBottom: 0 }}>
          <Wahl wert={r.status} style={{ width: '9rem' }} onChange={(k) => setR({ ...r, status: k as RegelEingabe['status'] })}
                optionen={[['testlauf', 'Testlauf'], ['aktiv', 'aktiv'], ['aus', 'aus']]} />
          <Label>Priorität</Label>
          <Input value={prio} style={{ width: '5rem' }} onInput={(e) => setPrio(e.target.value)} />
          <Wahl wert={r.gilt_fuer} style={{ width: '13rem' }} onChange={(k) => { setR({ ...r, gilt_fuer: k as RegelEingabe['gilt_fuer'] }); setTest(null); }}
                optionen={[['anhang', 'gilt je Anhang'], ['mail', 'gilt für die E-Mail selbst']]} />
          <Wahl wert={r.automatik} style={{ width: '14rem' }} onChange={(k) => setR({ ...r, automatik: k as RegelEingabe['automatik'] })}
                optionen={[['immer', 'bei Treffer sofort ablegen'], ['pruefen', 'immer in die Prüfliste']]} />
        </div>
      </div>
      <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.4rem' }}>
        Kleinere Priorität wird zuerst geprüft; die erste passende Regel gewinnt. Im Testlauf wird nichts abgelegt – der Vorschlag steht in der Prüfliste.
      </Text>

      <Block titel="Bedingungen">
        <div style={zeile}>
          <Label>Es müssen</Label>
          <Wahl wert={r.verknuepfung} style={{ width: '16rem' }} onChange={(k) => { setR({ ...r, verknuepfung: k as RegelEingabe['verknuepfung'] }); setTest(null); }}
                optionen={[['und', 'alle Bedingungen zutreffen (UND)'], ['oder', 'eine Bedingung zutreffen (ODER)']]} />
        </div>
        {r.bedingungen.map((b, i) => {
          const setB = (teil: Partial<typeof b>) => { setR({ ...r, bedingungen: r.bedingungen.map((x, j) => (j === i ? { ...x, ...teil } : x)) }); setTest(null); };
          return (
            <div key={i} style={zeile}>
              <Wahl wert={b.feld} style={{ width: '15rem' }} optionen={felder} onChange={(k) => setB({ feld: k })} />
              <CheckBox text="nicht" checked={!!b.nicht} onChange={(e) => setB({ nicht: e.target.checked })} />
              <Wahl wert={b.op} style={{ width: '14rem' }} optionen={Object.entries(stamm.operatoren)} onChange={(k) => setB({ op: k })} />
              <Input value={b.wert} style={{ flex: '1 1 12rem' }} placeholder={b.feld === 'mitglied' ? 'ja oder nein' : 'Wert'} onInput={(e) => setB({ wert: e.target.value })} />
              {test && <ObjectStatus state={test.bedingungen[i] ? 'Positive' : 'Negative'}>{test.bedingungen[i] ? 'trifft zu' : 'trifft nicht zu'}</ObjectStatus>}
              <Button design="Transparent" icon="delete" tooltip="Bedingung entfernen" disabled={r.bedingungen.length < 2}
                      onClick={() => { setR({ ...r, bedingungen: r.bedingungen.filter((_, j) => j !== i) }); setTest(null); }} />
            </div>
          );
        })}
        <Button design="Transparent" icon="add" onClick={() => { setR({ ...r, bedingungen: [...r.bedingungen, { feld: 'betreff', op: 'enthaelt', wert: '' }] }); setTest(null); }}>Bedingung</Button>
      </Block>

      <Block titel="Felder aus dem Inhalt lesen" hinweis="Ein regulärer Ausdruck je Feld; die erste Klammergruppe ist der Wert, z. B. Rechnungsnummer:\s*(\S+). Verwendung in den Vorlagen als {feld.<name>}. Die Inhalte bleiben im Portal – es wird kein KI-Dienst aufgerufen.">
        {r.extraktion.map((x, i) => {
          const setX = (teil: Partial<typeof x>) => { setR({ ...r, extraktion: r.extraktion.map((y, j) => (j === i ? { ...y, ...teil } : y)) }); setTest(null); };
          return (
            <div key={i} style={zeile}>
              <Input value={x.name} placeholder="Feldname" style={{ width: '10rem' }} onInput={(e) => setX({ name: e.target.value })} />
              <Wahl wert={x.quelle} style={{ width: '12rem' }} optionen={Object.entries(stamm.quellen).filter(([k]) => r.gilt_fuer === 'anhang' || !['datei', 'doktext'].includes(k))} onChange={(k) => setX({ quelle: k })} />
              <Input value={x.muster} placeholder="Muster (Regex)" style={{ flex: '1 1 14rem' }} onInput={(e) => setX({ muster: e.target.value })} />
              <CheckBox text="Pflicht" checked={!!x.pflicht} onChange={(e) => setX({ pflicht: e.target.checked })} />
              {test && <Text className="portal-small">{test.felder[x.name] ? `= ${test.felder[x.name]}` : 'kein Treffer'}</Text>}
              <Button design="Transparent" icon="delete" tooltip="Feld entfernen" onClick={() => { setR({ ...r, extraktion: r.extraktion.filter((_, j) => j !== i) }); setTest(null); }} />
            </div>
          );
        })}
        <Button design="Transparent" icon="add" onClick={() => setR({ ...r, extraktion: [...r.extraktion, { name: '', quelle: r.gilt_fuer === 'anhang' ? 'doktext' : 'text', muster: '', pflicht: false }] })}>Feld</Button>
      </Block>

      {r.gilt_fuer === 'anhang' && (
        <Block titel="Anhänge zusammenfassen"
               hinweis="Alle Anhänge einer E-Mail, für die diese Regel greift, werden vor der Ablage zu einem PDF zusammengefügt (Bilder als eigene Seiten). Bei nur einem passenden Anhang bleibt er unverändert.">
          <CheckBox text="Passende Anhänge zu einem PDF zusammenfassen" checked={zus.aktiv} onChange={(e) => setA({ zusammenfassen: { ...zus, aktiv: e.target.checked } })} />
          {zus.aktiv && (
            <div style={{ ...raster, marginTop: '0.5rem' }}>
              <Label>Reihenfolge</Label>
              <Wahl wert={zus.reihenfolge} style={{ width: '16rem' }} onChange={(k) => setA({ zusammenfassen: { ...zus, reihenfolge: k as Zusammenfassen['reihenfolge'] } })}
                    optionen={[['mail', 'wie in der E-Mail'], ['name', 'nach Dateiname']]} />
              <Label>Dateiname</Label>
              <Input value={zus.dateiname} style={{ width: '100%' }} placeholder="{datum}_{kurz}_{datei|ohneEndung}"
                     onInput={(e) => setA({ zusammenfassen: { ...zus, dateiname: e.target.value } })} />
            </div>
          )}
        </Block>
      )}

      <Block titel="Ablage in Paperless" hinweis={stamm.paperless.eingerichtet ? undefined : 'Paperless ist noch nicht eingerichtet (Administration → Anbindungen).'}>
        <CheckBox text={r.gilt_fuer === 'mail' ? 'E-Mail als PDF in Paperless ablegen' : 'Anhang in Paperless ablegen'} checked={pl.aktiv} onChange={(e) => setA({ paperless: { ...pl, aktiv: e.target.checked } })} />
        {pl.aktiv && (
          <div style={{ ...raster, marginTop: '0.5rem' }}>
            <Label>Titel</Label>
            <Input value={pl.titel ?? ''} style={{ width: '100%' }} onInput={(e) => setA({ paperless: { ...pl, titel: e.target.value } })} />
            <Label>Korrespondent</Label>
            <Vorschlag wert={pl.korrespondent ?? ''} werte={['{korrespondent}', '{mitglied}', ...stamm.paperless.korrespondenten]} onChange={(v) => setA({ paperless: { ...pl, korrespondent: v } })} />
            <Label>Dokumenttyp</Label>
            <Vorschlag wert={pl.dokumenttyp ?? ''} werte={stamm.paperless.dokumenttypen} onChange={(v) => setA({ paperless: { ...pl, dokumenttyp: v } })} />
            <Label>Speicherpfad</Label>
            <Vorschlag wert={pl.speicherpfad ?? ''} werte={stamm.paperless.speicherpfade} onChange={(v) => setA({ paperless: { ...pl, speicherpfad: v } })} />
            <Label>Tags (Komma)</Label>
            <Input value={pl.tags ?? ''} style={{ width: '100%' }} placeholder={stamm.paperless.tags.slice(0, 6).join(', ')} onInput={(e) => setA({ paperless: { ...pl, tags: e.target.value } })} />
            <Label>Dokumentdatum</Label>
            <Input value={pl.datum ?? ''} style={{ width: '14rem' }} placeholder="{datum}" onInput={(e) => setA({ paperless: { ...pl, datum: e.target.value } })} />
            <Label>Notiz</Label>
            <Input value={pl.notiz ?? ''} style={{ width: '100%' }} onInput={(e) => setA({ paperless: { ...pl, notiz: e.target.value } })} />
            <CustomFelder felder={pl.felder ?? {}} verfuegbar={stamm.paperless.felder} extraktion={r.extraktion}
                          onChange={(f) => setA({ paperless: { ...pl, felder: f } })} />
          </div>
        )}
      </Block>

      <Block titel="Zusätzlich in die Nextcloud" hinweis={stamm.nextcloud.eingerichtet ? undefined : 'Die Nextcloud ist noch nicht eingerichtet (Administration → Anbindungen → Nextcloud Dokumentenablage).'}>
        <CheckBox text="Kopie in einen Ordner der Nextcloud legen" checked={nc.aktiv} onChange={(e) => setA({ nextcloud: { ...nc, aktiv: e.target.checked } })} />
        {nc.aktiv && (
          <div style={{ ...raster, marginTop: '0.5rem' }}>
            <Label>Ordner</Label>
            <Input value={nc.pfad} style={{ width: '100%' }} placeholder="Belege/{jahr}" onInput={(e) => setA({ nextcloud: { ...nc, pfad: e.target.value } })} />
            <Label>Dateiname</Label>
            <Input value={nc.dateiname} style={{ width: '100%' }} placeholder="{datum}_{kurz}_{datei}" onInput={(e) => setA({ nextcloud: { ...nc, dateiname: e.target.value } })} />
          </div>
        )}
      </Block>

      <Block titel="E-Mail danach" hinweis="Wird erst ausgeführt, wenn alle Dokumente der E-Mail abgelegt sind. „Löschen“ verschiebt in den Papierkorb des Postfachs.">
        <div style={zeile}>
          <Wahl wert={mail.art} style={{ width: '15rem' }} onChange={(k) => setA({ mail: { ...mail, art: k as MailArt } })}
                optionen={[['keine', 'im Posteingang lassen'], ['verschieben', 'in einen Ordner verschieben'], ['loeschen', 'in den Papierkorb']]} />
          {mail.art === 'verschieben' && <Zielordner wert={mail.ordner ?? ''} onChange={(o) => setA({ mail: { ...mail, ordner: o } })} />}
          <CheckBox text="als gelesen markieren" checked={!!mail.gelesen} onChange={(e) => setA({ mail: { ...mail, gelesen: e.target.checked } })} />
        </div>
      </Block>

      <Block titel="Folgeaufgabe" hinweis="Die Aufgabe wird n8n gemeldet; der Knoten „Aufgabe anlegen“ ist im Workflow zunächst deaktiviert.">
        <div style={zeile}>
          <CheckBox text="Aufgabe anlegen" checked={aufgabe.aktiv} onChange={(e) => setA({ aufgabe: { ...aufgabe, aktiv: e.target.checked } })} />
          {aufgabe.aktiv && <Input value={aufgabe.titel} placeholder="Titel, z. B. Beleg {feld.nr} prüfen" style={{ flex: '1 1 16rem' }} onInput={(e) => setA({ aufgabe: { ...aufgabe, titel: e.target.value } })} />}
        </div>
      </Block>

      <Block titel="Probe" hinweis="Regel gegen eine Beispiel-E-Mail prüfen. Nichts wird gespeichert oder abgelegt.">
        <div style={raster}>
          <Label>Absender</Label>
          <Input value={probe.von} style={{ width: '100%' }} placeholder="Name <adresse@example.org>" onInput={(e) => setProbe({ ...probe, von: e.target.value })} />
          <Label>Betreff</Label>
          <Input value={probe.betreff} style={{ width: '100%' }} onInput={(e) => setProbe({ ...probe, betreff: e.target.value })} />
          {r.gilt_fuer === 'anhang' && <>
            <Label>Dateiname</Label>
            <Input value={probe.datei} style={{ width: '100%' }} placeholder="Rechnung_4711.pdf" onInput={(e) => setProbe({ ...probe, datei: e.target.value })} />
            <Label>Dokumenttext</Label>
            <TextArea rows={2} value={probe.doktext} onInput={(e) => setProbe({ ...probe, doktext: e.target.value })} />
          </>}
          <Label>Mailtext</Label>
          <TextArea rows={2} value={probe.text} onInput={(e) => setProbe({ ...probe, text: e.target.value })} />
        </div>
        <div style={{ ...zeile, marginTop: '0.5rem' }}>
          <Button icon="play" disabled={busy} onClick={testen}>Testen</Button>
          <Button design="Transparent" icon="sys-help" onClick={() => setHilfe(!hilfe)}>Platzhalter</Button>
        </div>
        {test && (
          <MessageStrip design={test.passt ? 'Positive' : 'Critical'} hideCloseButton>
            {test.passt ? 'Die Regel trifft zu.' : 'Die Regel trifft nicht zu.'}
            {test.korrespondent ? ` Korrespondent: ${test.korrespondent}.` : ''}{test.mitglied ? ` Mitglied: ${test.mitglied}.` : ''}
            {test.fehlend.length ? ` Pflichtfeld ohne Treffer: ${test.fehlend.join(', ')} → Prüfliste.` : ''}
            {test.paperless ? ` Paperless: „${test.paperless.title}“${test.paperless.correspondent ? `, ${test.paperless.correspondent}` : ''}${test.paperless.documentType ? `, ${test.paperless.documentType}` : ''}${test.paperless.storagePath ? `, Pfad ${test.paperless.storagePath}` : ''}${test.paperless.tags.length ? `, Tags ${test.paperless.tags.join('/')}` : ''}${test.paperless.created ? `, ${test.paperless.created}` : ''}${Object.keys(test.paperless.customFields ?? {}).length ? `, Felder ${Object.entries(test.paperless.customFields ?? {}).map(([k, v]) => `${k} = ${v ?? '–'}`).join(', ')}` : ''}.` : ''}
            {test.nextcloud ? ` Nextcloud: ${[test.nextcloud.pfad, test.nextcloud.dateiname].filter(Boolean).join('/')}.` : ''}
          </MessageStrip>
        )}
        {hilfe && (
          <table style={{ borderCollapse: 'collapse', marginTop: '0.5rem' }}>
            <tbody>
              {stamm.platzhalter.map((p) => (
                <tr key={p.name}><td style={{ padding: '0.1rem 1rem 0.1rem 0' }}><code>{`{${p.name}}`}</code></td><td><Text className="portal-small">{p.text}</Text></td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>
    </Dialog>
  );
}
