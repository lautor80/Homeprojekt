import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AnalyticalTable, BusyIndicator, Button, CheckBox, FlexBox, Icon, Input, Link, MessageStrip, ObjectStatus, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { Empty } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { Dlg } from '../mitglieder/Dialoge';
import { BerechnenDialog, RegelwerkDialog } from './Regelwerk';
import './gruppen.css';
import { GR, mitUntergruppen, type AufnahmeMitglied, type Gruppe, type GruppenDaten, type GruppenMitglied } from './typen';

/**
 * Mitgliedergruppen: Mitglieder nach Kategorien gruppieren (z. B. Spielbetrieb → Mannschaftsspieler → Herren 40,
 * reine Hallennutzer, ohne Teilnahme am Spielbetrieb). Pflege im Baum: Gruppen beliebig tief schachteln,
 * Mitglieder aufnehmen (ein Mitglied kann in mehreren Gruppen sein), Rolle je Zuordnung.
 * Dieselben Gruppen stehen im Mitgliedsstamm (Reiter „Gruppen“) und im Vereinskalender (Veranstaltung nur für Gruppen).
 */
interface Zeile { id: string; text: string; g: Gruppe; m?: GruppenMitglied; subRows?: Zeile[] }
interface Form { id: number | null; parent_id: number | null; name: string; beschreibung: string; aktiv: boolean; position: string }
type Tabelle = { toggleAllRowsExpanded?: (v: boolean) => void; toggleRowExpanded?: (id: string, v?: boolean) => void };

const zeilenId = (g: Gruppe) => `g${g.id}`;
/** was gerade gezogen wird: eine Gruppe oder ein Mitglied aus einer Gruppe */
type Gezogen = { art: 'G'; id: number } | { art: 'M'; adrnr: string; von: number };
const ZIEL = 'portal-gr__ziel';

export function Gruppen() {
  const can = useCan();
  const navigate = useNavigate();
  const zumMitglied = can('tco.mitglieder:display');
  const [d, setD] = useState<GruppenDaten | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suche, setSuche] = useState('');
  const [mitZeigen, setMitZeigen] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [aufnehmen, setAufnehmen] = useState<Gruppe | null>(null);
  const [weg, setWeg] = useState<Gruppe | null>(null);
  // Regelwerk: true = gesamtes Regelwerk, Gruppe = Regelwerk dieser Gruppe; Neu berechnen: 'ALLE' oder ein Knoten
  const [regelwerk, setRegelwerk] = useState<Gruppe | true | null>(null);
  const [berechnen, setBerechnen] = useState<Gruppe | 'ALLE' | null>(null);
  const tabelle = useRef<Tabelle | null>(null);
  const pflege = !!d?.pflege;

  const laden = () => api.get<GruppenDaten>(GR).then(setD).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function lauf(fn: () => Promise<{ text?: string } | void>) {
    setError(null);
    setBusy(true);
    try {
      const r = await fn();
      if (r?.text) toast(r.text, 4000);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const gruppen = d?.gruppen ?? [];
  const such = suche.trim().toLowerCase();

  // Baum aus der flachen Liste (Baumreihenfolge); mit Suchtext bleiben Treffer und ihre übergeordneten Gruppen
  const baum = useMemo(() => {
    const passt = (t: string | null | undefined) => !!t && t.toLowerCase().includes(such);
    const bauen = (parent: number | null, alles: boolean): Zeile[] => gruppen.filter((g) => g.parent_id === parent).flatMap((g) => {
      const selbst = alles || !such || passt(g.name) || passt(g.beschreibung);
      const kinder = bauen(g.id, selbst);
      const mitglieder = g.mitglieder.filter((m) => selbst || passt(m.name) || passt(m.mitglnrn) || passt(m.rolle));
      if (!selbst && !kinder.length && !mitglieder.length) return [];
      const blaetter: Zeile[] = mitZeigen || (such && !selbst)
        ? mitglieder.map((m) => ({ id: `${zeilenId(g)}:${m.adrnr}`, text: m.name, g, m }))
        : [];
      return [{ id: zeilenId(g), text: g.name, g, subRows: [...kinder, ...blaetter] }];
    });
    return bauen(null, false);
  }, [gruppen, such, mitZeigen]);
  const anzahlZeilen = (z: Zeile[]): number => z.reduce((n, x) => n + 1 + (x.subRows ? anzahlZeilen(x.subRows) : 0), 0);

  // Beim ersten Laden die Gliederung zeigen (Gruppen mit Untergruppen aufgeklappt); bei einer Suche alle Treffer
  const geladen = !!d;
  useEffect(() => {
    if (!geladen) return;
    for (const g of gruppen) if (gruppen.some((k) => k.parent_id === g.id)) tabelle.current?.toggleRowExpanded?.(zeilenId(g), true);
  }, [geladen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (such) tabelle.current?.toggleAllRowsExpanded?.(true); }, [such, baum]);

  // ---------------------------------------------------------------- Ziehen und Ablegen
  // Gruppe auf Gruppe = unterordnen (auf das Feld über dem Baum = oberste Ebene), Mitglied auf Gruppe = verschieben
  const gezogen = useRef<Gezogen | null>(null);
  const darfAuf = (ziel: Gruppe | null) => {
    const z = gezogen.current;
    if (!z) return false;
    if (z.art === 'M') return !!ziel && ziel.id !== z.von;
    const g = gruppen.find((x) => x.id === z.id);
    if (!g || g.parent_id === (ziel?.id ?? null)) return false;
    return !ziel || !mitUntergruppen(gruppen, z.id).has(ziel.id);
  };
  const ziehStart = (e: DragEvent<HTMLElement>, was: Gezogen, text: string) => {
    gezogen.current = was;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', text);
  };
  const ablage = (ziel: Gruppe | null) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => { if (darfAuf(ziel)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add(ZIEL); } },
    onDragLeave: (e: DragEvent<HTMLElement>) => e.currentTarget.classList.remove(ZIEL),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.currentTarget.classList.remove(ZIEL);
      const z = gezogen.current;
      gezogen.current = null;
      if (!z) return;
      if (z.art === 'M') {
        if (ziel) lauf(() => api.post(`${GR}/${ziel.id}/mitglieder/verschieben`, { adrnr: z.adrnr, von: z.von }));
      } else {
        const g = gruppen.find((x) => x.id === z.id);
        if (g) lauf(() => api.post(GR, { id: g.id, name: g.name, beschreibung: g.beschreibung, aktiv: g.aktiv, parent_id: ziel?.id ?? null }));
      }
      if (ziel) tabelle.current?.toggleRowExpanded?.(zeilenId(ziel), true);
    },
  });
  const ziehbar = pflege && !busy;

  const personen = useMemo(() => new Set(gruppen.flatMap((g) => g.mitglieder.map((m) => m.adrnr))).size, [gruppen]);

  const columns: AnalyticalTableColumnDefinition[] = useMemo(() => [
    {
      Header: 'Gruppe / Mitglied', accessor: 'text', minWidth: 300,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.m) {
          const m = z.m;
          return (
            <div className="portal-gr__zelle" draggable={ziehbar} onDragStart={(e) => ziehStart(e, { art: 'M', adrnr: m.adrnr, von: z.g.id }, m.name)} onDragEnd={() => { gezogen.current = null; }}>
              <Icon name="employee" />
              {zumMitglied ? <Link onClick={() => navigate(`/tco/mitglieder?adrnr=${encodeURIComponent(m.adrnr)}`)}>{m.name}</Link> : <Text>{m.name}</Text>}
              {m.mitglnrn && <span className="portal-muted portal-small">Nr. {m.mitglnrn}</span>}
              {m.ausgetreten && <ObjectStatus state="Negative">ausgetreten</ObjectStatus>}
            </div>
          );
        }
        return (
          <div className="portal-gr__zelle" draggable={ziehbar} onDragStart={(e) => ziehStart(e, { art: 'G', id: z.g.id }, z.g.name)} onDragEnd={() => { gezogen.current = null; }}
               {...(pflege ? ablage(z.g) : {})}>
            <Icon name={z.g.ebene === 0 ? 'folder' : 'group'} />
            <Text><b>{z.g.name}</b></Text>
            {z.g.beschreibung && <span className="portal-muted portal-small">{z.g.beschreibung}</span>}
            {z.g.regel && <ObjectStatus state="Information" title={`Regelwerk: Mitglieder werden automatisch abgeleitet – ${z.g.regel}`}>{z.g.regel}</ObjectStatus>}
            {!z.g.aktiv && <ObjectStatus state="Critical">inaktiv</ObjectStatus>}
          </div>
        );
      },
    },
    {
      Header: 'Rolle', id: 'rolle', width: 200,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (!z.m) return '';
        const m = z.m;
        if (!pflege) return <Text>{m.rolle ?? ''}</Text>;
        return (
          <Input value={m.rolle ?? ''} placeholder="z. B. Mannschaftsführer" maxlength={60} style={{ width: '100%' }} disabled={busy}
                 onChange={(e) => { const v = e.target.value.trim(); if (v !== (m.rolle ?? '')) lauf(() => api.post(`${GR}/${z.g.id}/mitglieder`, { adrnrs: [m.adrnr], rolle: v })); }} />
        );
      },
    },
    {
      Header: 'Mitglieder', id: 'anzahl', width: 170, hAlign: 'End',
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.m) return '';
        const direkt = z.g.mitglieder.length;
        // maßgeblich ist die Gesamtzahl: Mitglieder der Untergruppen gehören zwingend zur Gruppe
        return <Text>{z.g.gesamt === direkt ? direkt : `${z.g.gesamt} · davon direkt ${direkt}`}</Text>;
      },
    },
    ...(pflege ? [{
      Header: '', id: 'aktionen', width: 250, hAlign: 'End' as const,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile;
        if (z.m) {
          const m = z.m;
          return <Button icon="decline" design="Transparent" tooltip={`${m.name} aus „${z.g.name}“ entfernen`} disabled={busy}
                         onClick={() => lauf(() => api.post(`${GR}/${z.g.id}/mitglieder`, { adrnrs: [m.adrnr], entfernen: true }))} />;
        }
        return (
          <FlexBox justifyContent="End">
            <Button icon="synchronize" design="Transparent" tooltip={`Neu berechnen: Regelwerk auf „${z.g.name}“ und die Untergruppen anwenden`} disabled={busy} onClick={() => setBerechnen(z.g)} />
            <Button icon="activities" design="Transparent" tooltip="Regelwerk der Gruppe (Mitglieder automatisch ableiten)" disabled={busy} onClick={() => setRegelwerk(z.g)} />
            <Button icon="add-employee" design="Transparent" tooltip="Mitglieder aufnehmen" disabled={busy} onClick={() => setAufnehmen(z.g)} />
            <Button icon="add-folder" design="Transparent" tooltip="Untergruppe anlegen" disabled={busy}
                    onClick={() => setForm({ id: null, parent_id: z.g.id, name: '', beschreibung: '', aktiv: true, position: '' })} />
            <Button icon="edit" design="Transparent" tooltip="Gruppe ändern oder verschieben" disabled={busy}
                    onClick={() => setForm({ id: z.g.id, parent_id: z.g.parent_id, name: z.g.name, beschreibung: z.g.beschreibung ?? '', aktiv: z.g.aktiv, position: z.g.position == null ? '' : String(z.g.position) })} />
            <Button icon="delete" design="Transparent" tooltip="Gruppe löschen" disabled={busy} onClick={() => setWeg(z.g)} />
          </FlexBox>
        );
      },
    }] : []),
  ], [pflege, busy, zumMitglied, gruppen]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabellenOptionen = useMemo(() => ({ autoResetExpanded: false, getRowId: (r: Zeile) => r.id }), []);

  return (
    <AppPage title="Mitgliedergruppen"
             subtitle={d ? `${gruppen.length} Gruppe${gruppen.length === 1 ? '' : 'n'} · ${personen} zugeordnete${personen === 1 ? 's Mitglied' : ' Mitglieder'}` : ''}
             actions={pflege ? <>
               <Button icon="activities" tooltip="Regeln, nach denen Mitglieder ihren Gruppen zugeordnet werden (z. B. nach Alter)" onClick={() => setRegelwerk(true)}>Regelwerk</Button>
               <Button icon="synchronize" tooltip="Regelwerk auf den gesamten Baum anwenden: Gruppenzuordnung aller Mitglieder nach Alter und Geschlecht neu berechnen" disabled={busy} onClick={() => setBerechnen('ALLE')}>Neu berechnen</Button>
               <Button icon="add" design="Emphasized" onClick={() => setForm({ id: null, parent_id: null, name: '', beschreibung: '', aktiv: true, position: '' })}>Neue Gruppe</Button>
             </> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}
      {!d ? (!error && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />) : (
        <div className="portal-section">
          <div className="portal-row" style={{ marginBottom: '0.5rem' }}>
            <Input value={suche} placeholder="Gruppe, Mitglied oder Rolle suchen" showClearIcon style={{ width: 'min(22rem, 100%)' }} onInput={(e) => setSuche(e.target.value)} />
            <CheckBox text="Mitglieder anzeigen" checked={mitZeigen} onChange={(e) => setMitZeigen(e.target.checked)} />
            <div style={{ flex: 1 }} />
            <Button icon="expand-all" design="Transparent" tooltip="Alles aufklappen" onClick={() => tabelle.current?.toggleAllRowsExpanded?.(true)} />
            <Button icon="collapse-all" design="Transparent" tooltip="Alles zuklappen" onClick={() => tabelle.current?.toggleAllRowsExpanded?.(false)} />
          </div>
          {pflege && gruppen.length > 0 && (
            <div className="portal-gr__oben" {...ablage(null)}>
              Ziehen und Ablegen: Gruppe auf eine andere Gruppe ziehen = unterordnen, auf dieses Feld = oberste Ebene. Mitglied auf eine Gruppe ziehen = dorthin verschieben.
            </div>
          )}
          {!gruppen.length ? (
            <Empty>
              Noch keine Gruppen. Lege zuerst die Kategorien an – z. B. „Spielbetrieb“ mit den Untergruppen „Mannschaftsspieler“ und
              „Ohne Teilnahme am Spielbetrieb“ oder „Reine Hallennutzer“ – und ordne dann die Mitglieder zu.
            </Empty>
          ) : (
            <AnalyticalTable minRows={1} columns={columns} data={baum} isTreeTable tableInstance={tabelle as never} reactTableOptions={tabellenOptionen}
                             visibleRows={Math.max(anzahlZeilen(baum), 1)} noDataText="Keine Gruppe und kein Mitglied zu dieser Suche" />
          )}
        </div>
      )}

      {regelwerk && <RegelwerkDialog gruppen={gruppen} gruppe={regelwerk === true ? null : regelwerk} onClose={(geaendert) => { setRegelwerk(null); if (geaendert) lauf(async () => undefined); }} />}
      {berechnen && <BerechnenDialog gruppe={berechnen === 'ALLE' ? null : berechnen} onClose={() => { setBerechnen(null); lauf(async () => undefined); }} />}
      {form && <GruppeDialog form={form} gruppen={gruppen} onClose={(text) => { setForm(null); if (text) lauf(async () => ({ text })); }} />}
      {aufnehmen && <AufnehmenDialog gruppe={aufnehmen} gruppen={gruppen} onClose={(text) => { setAufnehmen(null); if (text) lauf(async () => ({ text })); }} />}
      <ConfirmDialog open={!!weg} title="Gruppe löschen" danger confirmText="Löschen"
                     text={weg ? `Gruppe „${weg.pfad}“ löschen?${weg.mitglieder.length ? ` Die Zuordnung von ${weg.mitglieder.length} Mitglied${weg.mitglieder.length === 1 ? '' : 'ern'} entfällt.` : ''}` : ''}
                     onCancel={() => setWeg(null)}
                     onConfirm={() => { const g = weg!; setWeg(null); lauf(() => api.del<{ text: string }>(`${GR}/${g.id}`)); }} />
    </AppPage>
  );
}

// ---------------------------------------------------------------- Gruppe anlegen / ändern / verschieben
function GruppeDialog({ form, gruppen, onClose }: { form: Form; gruppen: Gruppe[]; onClose: (text?: string) => void }) {
  const [f, setF] = useState(form);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ziel beim Verschieben: nicht die Gruppe selbst und keine ihrer Untergruppen
  const gesperrt = f.id ? mitUntergruppen(gruppen, f.id) : new Set<number>();
  const ziele = gruppen.filter((g) => !gesperrt.has(g.id));
  const positionFehler = f.position.trim() !== '' && !/^\d{1,4}$/.test(f.position.trim());
  async function sichern() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ text: string }>(GR, {
        id: f.id, parent_id: f.parent_id, name: f.name, beschreibung: f.beschreibung, aktiv: f.aktiv, position: f.position.trim() === '' ? null : Number(f.position.trim()),
      });
      onClose(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dlg titel={f.id ? 'Gruppe ändern' : f.parent_id ? 'Untergruppe anlegen' : 'Gruppe anlegen'} onClose={() => onClose()} breite="min(560px, 95vw)"
         fuss={<Button design="Emphasized" disabled={busy || !f.name.trim() || positionFehler} onClick={sichern}>Sichern</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      <FormGrid columns={1}>
        <TextField label="Name" required value={f.name} placeholder="z. B. Mannschaftsspieler, Herren 40, Reine Hallennutzer" onChange={(name) => setF({ ...f, name })} />
        <FieldBox label="Übergeordnete Gruppe">
          <Select style={{ width: '100%' }} onChange={(e) => setF({ ...f, parent_id: Number((e.detail.selectedOption as HTMLElement).dataset.g) || null })}>
            <Option data-g="" selected={f.parent_id == null}>– oberste Ebene –</Option>
            {ziele.map((g) => <Option key={g.id} data-g={g.id} selected={g.id === f.parent_id}>{g.pfad}</Option>)}
          </Select>
        </FieldBox>
        <FieldBox label="Position in der Ebene">
          <Input value={f.position} placeholder="z. B. 10 – leer = nach Name hinter den übrigen" valueState={positionFehler ? 'Negative' : 'None'} style={{ width: '100%' }}
                 onInput={(e) => setF({ ...f, position: e.target.value })} />
        </FieldBox>
        <FieldBox label="Beschreibung">
          <TextArea rows={3} maxlength={500} value={f.beschreibung} onInput={(e) => setF({ ...f, beschreibung: e.target.value })} />
        </FieldBox>
        {f.id && <CheckBox text="Aktiv (inaktive Gruppen stehen im Kalender nicht mehr zur Auswahl)" checked={f.aktiv} onChange={(e) => setF({ ...f, aktiv: e.target.checked })} />}
      </FormGrid>
    </Dlg>
  );
}

// ---------------------------------------------------------------- Mitglieder aufnehmen (Mehrfachauswahl)
const MAX_TREFFER = 150;
/** leer oder keine Zahl = Grenze nicht gesetzt */
const zahl = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

function AufnehmenDialog({ gruppe, gruppen, onClose }: { gruppe: Gruppe; gruppen: Gruppe[]; onClose: (text?: string) => void }) {
  const [alle, setAlle] = useState<AufnahmeMitglied[] | null>(null);
  const [suche, setSuche] = useState('');
  // Filter: Geschlecht, Alter (volle Jahre, heute) und Jahrgang – z. B. männlich und ab 40 Jahre für „Herren 40“
  const [geschlecht, setGeschlecht] = useState<'' | 'M' | 'W' | '-'>('');
  const [grenzen, setGrenzen] = useState({ alterVon: '', alterBis: '', jgVon: '', jgBis: '' });
  const [wahl, setWahl] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<AufnahmeMitglied[]>(`${GR}/mitglieder`).then(setAlle).catch((e) => setError(e.message)); }, []);
  // Nicht zur Auswahl: wer schon in der Gruppe ist – direkt oder über eine Untergruppe (wird nicht noch einmal aufgenommen)
  const zweig = mitUntergruppen(gruppen, gruppe.id);
  const schon = new Set(gruppen.filter((g) => zweig.has(g.id)).flatMap((g) => g.mitglieder.map((m) => m.adrnr)));
  const ueberUnter = schon.size - gruppe.mitglieder.length;
  const such = suche.trim().toLowerCase();
  const alterVon = zahl(grenzen.alterVon), alterBis = zahl(grenzen.alterBis), jgVon = zahl(grenzen.jgVon), jgBis = zahl(grenzen.jgBis);
  const gefiltert = !!geschlecht || alterVon != null || alterBis != null || jgVon != null || jgBis != null;
  // Mitglieder ohne Geburtsdatum fallen bei einem Alters- oder Jahrgangsfilter heraus
  const zwischen = (wert: number | null, von: number | null, bis: number | null) =>
    (von == null && bis == null) || (wert != null && (von == null || wert >= von) && (bis == null || wert <= bis));
  const treffer = (alle ?? []).filter((m) => !schon.has(m.adrnr)
    && (!such || m.name.toLowerCase().includes(such))
    && (!geschlecht || (geschlecht === '-' ? !m.geschlecht : m.geschlecht === geschlecht))
    && zwischen(m.alter, alterVon, alterBis) && zwischen(m.jahrgang, jgVon, jgBis));
  const alleGewaehlt = treffer.length > 0 && treffer.every((m) => wahl.has(m.adrnr));
  function alleWaehlen() {
    const s = new Set(wahl);
    for (const m of treffer) if (alleGewaehlt) s.delete(m.adrnr); else s.add(m.adrnr);
    setWahl(s);
  }
  async function sichern() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ text: string }>(`${GR}/${gruppe.id}/mitglieder`, { adrnrs: [...wahl] });
      onClose(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const grenze = (k: keyof typeof grenzen, placeholder: string) => (
    <Input type="Number" value={grenzen[k]} placeholder={placeholder} accessibleName={placeholder} style={{ width: '6.5rem', minWidth: '6.5rem' }} data-kein-autofill
           onInput={(e) => setGrenzen({ ...grenzen, [k]: e.target.value })} />
  );
  return (
    <Dlg titel={`Mitglieder aufnehmen – ${gruppe.pfad}`} onClose={() => onClose()} breite="min(560px, 95vw)"
         fuss={<Button design="Emphasized" disabled={busy || !wahl.size} onClick={sichern}>{wahl.size ? `${wahl.size} aufnehmen` : 'Aufnehmen'}</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      {ueberUnter > 0 && (
        <MessageStrip hideCloseButton design="Information" style={{ marginBottom: '0.75rem' }}>
          {ueberUnter === 1 ? '1 Mitglied gehört' : `${ueberUnter} Mitglieder gehören`} bereits über Untergruppen zu „{gruppe.name}“ und {ueberUnter === 1 ? 'steht' : 'stehen'} deshalb nicht zur Auswahl.
        </MessageStrip>
      )}
      <Input value={suche} placeholder="Name suchen" showClearIcon style={{ width: '100%' }} onInput={(e) => setSuche(e.target.value)} />
      <FlexBox wrap="Wrap" alignItems="Center" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
        <Select accessibleName="Geschlecht" style={{ width: '10rem' }} onChange={(e) => setGeschlecht(((e.detail.selectedOption as HTMLElement).dataset.g ?? '') as typeof geschlecht)}>
          <Option data-g="" selected={geschlecht === ''}>Geschlecht: alle</Option>
          <Option data-g="M" selected={geschlecht === 'M'}>männlich</Option>
          <Option data-g="W" selected={geschlecht === 'W'}>weiblich</Option>
          <Option data-g="-" selected={geschlecht === '-'}>ohne Angabe</Option>
        </Select>
        {grenze('alterVon', 'Alter ab')}
        {grenze('alterBis', 'Alter bis')}
        {grenze('jgVon', 'Jahrgang ab')}
        {grenze('jgBis', 'Jahrgang bis')}
      </FlexBox>
      {!alle ? <BusyIndicator active style={{ display: 'block', padding: '1.5rem 0' }} /> : (
        <>
          <FlexBox justifyContent="SpaceBetween" alignItems="Center" style={{ marginTop: '0.5rem' }}>
            <span className="portal-muted portal-small">{treffer.length} Treffer</span>
            {treffer.length > 0 && <Link onClick={alleWaehlen}>{alleGewaehlt ? 'Auswahl der Treffer aufheben' : `Alle ${treffer.length} Treffer auswählen`}</Link>}
          </FlexBox>
          <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '50vh', overflowY: 'auto' }}>
            {treffer.slice(0, MAX_TREFFER).map((m) => (
              <CheckBox key={m.adrnr} text={m.jahrgang != null ? `${m.name} · Jg. ${m.jahrgang} (${m.alter} J.)` : m.name} checked={wahl.has(m.adrnr)} onChange={(e) => {
                const s = new Set(wahl);
                if (e.target.checked) s.add(m.adrnr); else s.delete(m.adrnr);
                setWahl(s);
              }} />
            ))}
            {!treffer.length && <Empty>{such || gefiltert ? 'Kein Mitglied zu dieser Suche.' : 'Alle Mitglieder sind bereits in dieser Gruppe.'}</Empty>}
            {treffer.length > MAX_TREFFER && <span className="portal-muted portal-small">{treffer.length - MAX_TREFFER} weitere – bitte die Suche eingrenzen.</span>}
          </div>
        </>
      )}
    </Dlg>
  );
}
