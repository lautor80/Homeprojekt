import { useMemo, useState } from 'react';
import { AnalyticalTable, Bar, Button, DatePicker, Dialog, Input, MessageStrip, ObjectStatus, Option, Select, Text } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api, qs } from '../api';
import { AppPage } from '../components/AppPage';
import { Attribute, Attributes } from '../components/Attributes';
import { FieldBox } from '../components/FormFields';
import { useLoad } from '../components/useLoad';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useCan } from '../session';

/**
 * E-Mail-Protokoll (Administration): alle E-Mails des Portals als Tabelle mit Filter – gesammelt je Person, Empfänger oder Vorgang.
 * Zeigt, ob eine E-Mail (z. B. die Bestätigung einer Registrierung) übergeben wurde, mit welchem Absender und mit welchem Fehler.
 * Je Zeile „Erneut senden“ (Berechtigung core.mail:edit): dieselbe E-Mail noch einmal an den Empfänger, der Absender erhält eine Kopie (CC).
 */
interface Eintrag {
  id: number; zeit: string; anwendung: string | null; objekt: string | null; an: string | null; betreff: string | null;
  absender: string | null; von: string | null; status: string; fehler: string | null; benutzer: string | null; person: string;
  erneut: boolean; erneut_hinweis: string | null; erneut_neuer_link: boolean; cc: string | null;
  erneut_am: string | null; erneut_von: string | null; erneut_status: string | null;
}
interface Antwort { zeilen: Eintrag[]; anwendungen: string[]; gekuerzt: boolean }
/** Tabellenzeile: nur Texte, damit Spaltenfilter, Sortierung und Gruppierung auf dem Angezeigten arbeiten */
interface Zeile {
  id: number; zeit: string; person: string; an: string; anwendung: string; objekt: string; betreff: string; statusText: string;
  hinweis: string; absender: string; benutzer: string; eintrag: Eintrag;
}
type State = 'Positive' | 'Negative' | 'Critical' | 'Information' | 'None';

const STATUS: Record<string, { text: string; state: State }> = {
  gesendet: { text: 'gesendet', state: 'Positive' }, entwurf: { text: 'Entwurf', state: 'Information' },
  fehler: { text: 'Fehler', state: 'Negative' }, nicht_gesendet: { text: 'nicht gesendet', state: 'Critical' },
};
const statusState = (text: string): State => Object.values(STATUS).find((s) => s.text === text)?.state ?? 'None';
const GRUPPEN: { id: string; text: string }[] = [
  { id: '', text: '(keine)' }, { id: 'person', text: 'Person' }, { id: 'an', text: 'Empfänger' }, { id: 'objekt', text: 'Vorgang' },
  { id: 'anwendung', text: 'Anwendung' }, { id: 'statusText', text: 'Status' },
];

const tag = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const vorTagen = (n: number) => tag(new Date(Date.now() - n * 86400_000));
/** „JJJJ-MM-TT HH:MM:SS“ → „TT.MM.JJJJ HH:MM“ */
const zeitText = (z: string) => `${z.slice(8, 10)}.${z.slice(5, 7)}.${z.slice(0, 4)} ${z.slice(11, 16)}`;

const fehlgeschlagen = (e: Eintrag) => e.status === 'fehler' || e.status === 'nicht_gesendet';

function erneutText(e: Eintrag): string {
  if (e.erneut_am) {
    return `${e.erneut_status === 'fehler' ? 'Wiederholung fehlgeschlagen' : 'Erneut gesendet'} am ${zeitText(e.erneut_am)}${e.erneut_von ? ` von ${e.erneut_von}` : ''}`;
  }
  // warum eine fehlgeschlagene E-Mail nicht wiederholbar ist; bei gesendeten steht der Grund nur am Knopf
  return fehlgeschlagen(e) && e.erneut_hinweis ? e.erneut_hinweis : '';
}

/** Rückfrage vor dem erneuten Senden */
function frageText(e: Eintrag): string {
  return `Die E-Mail „${e.betreff ?? ''}“ wird erneut an ${e.an ?? ''} gesendet`
    + (e.cc ? `, eine Kopie (CC) geht an den Absender ${e.cc}.` : '.')
    + (e.erneut_neuer_link ? ' Dabei wird ein neuer Zugangslink erzeugt – ältere Links (auch auf gedruckten Briefen) werden ungültig; der neue Link steht auch in der Kopie.' : '');
}

function zeile(e: Eintrag): Zeile {
  return {
    id: e.id, zeit: e.zeit.slice(0, 16), person: e.person || '(unbekannt)', an: e.an ?? '', anwendung: e.anwendung ?? '', objekt: e.objekt ?? '',
    betreff: e.betreff ?? '', statusText: STATUS[e.status]?.text ?? e.status, hinweis: [e.fehler, erneutText(e)].filter(Boolean).join(' · '),
    absender: e.von ?? e.absender ?? '', benutzer: e.benutzer ?? '', eintrag: e,
  };
}

const LEER = { suche: '', anwendung: '', status: '', von: vorTagen(30), bis: '' };

export function MailProtokollPage() {
  const [f, setF] = useState(LEER);
  const [query, setQuery] = useState(LEER);
  const [gruppe, setGruppe] = useState('');
  const [detail, setDetail] = useState<Eintrag | null>(null);
  const darfSenden = useCan()('core.mail:edit');
  const [frage, setFrage] = useState<Eintrag | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const l = useLoad(() => api.get<Antwort>('/api/mail/uebersicht' + qs(query)), [query]);
  const daten = useMemo(() => (l.data?.zeilen ?? []).map(zeile), [l.data]);
  const suchen = (x = f) => { setF(x); setQuery({ ...x }); };
  async function erneut(e: Eintrag) {
    setFrage(null); setBusy(e.id); setMeldung(null);
    try {
      const r = await api.post<{ text: string; warnungen: string[] }>(`/api/mail/uebersicht/${e.id}/erneut`);
      setMeldung({ ok: true, text: [r.text, ...r.warnungen].join(' · ') });
    } catch (x) { setMeldung({ ok: false, text: (x as Error).message }); }
    finally { setBusy(null); l.reload(); }
  }
  const sendenKnopf = (e: Eintrag) => (
    <Button design="Transparent" icon="redo" loading={busy === e.id} disabled={!e.erneut || busy !== null}
            tooltip={e.erneut ? `Erneut an ${e.an ?? ''} senden${e.cc ? `, Kopie (CC) an ${e.cc}` : ''}` : e.erneut_hinweis ?? 'Nicht möglich'}
            onClick={(x) => { x.stopPropagation(); setDetail(null); setFrage(e); }}>Erneut senden</Button>
  );

  const spalten: AnalyticalTableColumnDefinition[] = [
    { Header: 'Zeit', accessor: 'zeit', width: 150, Cell: ({ value }: Cell) => (value ? zeitText(String(value)) : null) },
    { Header: 'Person', accessor: 'person', minWidth: 200 },
    { Header: 'Empfänger', accessor: 'an', minWidth: 200 },
    { Header: 'Anwendung', accessor: 'anwendung', width: 140 },
    { Header: 'Vorgang', accessor: 'objekt', width: 130 },
    { Header: 'Betreff', accessor: 'betreff', minWidth: 240 },
    { Header: 'Status', accessor: 'statusText', width: 130,
      Cell: ({ value }: Cell) => (value ? <ObjectStatus state={statusState(String(value))}>{String(value)}</ObjectStatus> : null) },
    { Header: 'Fehler / Hinweis', accessor: 'hinweis', minWidth: 240 },
    { Header: 'Absender', accessor: 'absender', minWidth: 180 },
    { Header: 'Ausgelöst von', accessor: 'benutzer', width: 140 },
    ...(darfSenden ? [{
      Header: '', id: 'aktion', width: 170, disableFilters: true, disableSortBy: true, disableGroupBy: true,
      Cell: ({ row }: Cell) => { const z = row.original as Zeile | undefined; return z?.eintrag ? sendenKnopf(z.eintrag) : null; },
    }] : []),
  ];
  // gruppiert: nur die Gruppenspalte zeigt in der Gruppenzeile etwas (Wert und Anzahl)
  const columns: AnalyticalTableColumnDefinition[] = gruppe ? spalten.map((c) => (c.accessor === gruppe ? { ...c, disableGroupBy: false } : { ...c, Aggregated: () => null })) : spalten;

  const fehler = daten.filter((z) => fehlgeschlagen(z.eintrag)).length;
  const filter = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '0.75rem', alignItems: 'end', padding: '0.5rem 0' }}>
      <FieldBox label="Suche (Name, Adresse, Vorgang, Betreff)">
        <Input value={f.suche} placeholder="z. B. Müller oder REG-12" showClearIcon
               onInput={(e) => setF({ ...f, suche: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') suchen(); }} />
      </FieldBox>
      <FieldBox label="Anwendung">
        <Select onChange={(e) => setF({ ...f, anwendung: (e.detail.selectedOption as HTMLElement).dataset.wert ?? '' })}>
          <Option data-wert="" selected={!f.anwendung}>(alle)</Option>
          {(l.data?.anwendungen ?? []).map((a) => <Option key={a} data-wert={a} selected={f.anwendung === a}>{a}</Option>)}
        </Select>
      </FieldBox>
      <FieldBox label="Status">
        <Select onChange={(e) => setF({ ...f, status: (e.detail.selectedOption as HTMLElement).dataset.wert ?? '' })}>
          <Option data-wert="" selected={!f.status}>(alle)</Option>
          {Object.entries(STATUS).map(([k, s]) => <Option key={k} data-wert={k} selected={f.status === k}>{s.text}</Option>)}
        </Select>
      </FieldBox>
      <FieldBox label="Von"><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.von} onChange={(e) => setF({ ...f, von: e.detail.value })} /></FieldBox>
      <FieldBox label="Bis"><DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f.bis} onChange={(e) => setF({ ...f, bis: e.detail.value })} /></FieldBox>
      <FieldBox label="Sammeln nach">
        <Select onChange={(e) => setGruppe((e.detail.selectedOption as HTMLElement).dataset.wert ?? '')}>
          {GRUPPEN.map((g) => <Option key={g.id} data-wert={g.id} selected={gruppe === g.id}>{g.text}</Option>)}
        </Select>
      </FieldBox>
      <div className="portal-row">
        <Button design="Emphasized" icon="search" onClick={() => suchen()}>Suchen</Button>
        <Button design="Transparent" icon="clear-filter" onClick={() => suchen(LEER)}>Zurücksetzen</Button>
      </div>
    </div>
  );

  return (
    <AppPage title="E-Mail-Protokoll"
             subtitle={`Alle E-Mails des Portals je Person, Empfänger oder Vorgang · ${daten.length} Einträge${fehler ? `, davon ${fehler} nicht gesendet` : ''}`}
             header={filter} actions={<Button icon="refresh" onClick={l.reload}>Aktualisieren</Button>}>
      {l.error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.5rem' }}>{l.error}</MessageStrip>}
      {meldung && <MessageStrip design={meldung.ok ? 'Positive' : 'Negative'} onClose={() => setMeldung(null)} style={{ marginBottom: '0.5rem' }}>{meldung.text}</MessageStrip>}
      <ConfirmDialog open={!!frage} title="E-Mail erneut senden" confirmText="Erneut senden" text={frage ? frageText(frage) : ''}
                     onConfirm={() => frage && erneut(frage)} onCancel={() => setFrage(null)} />
      {l.data?.gekuerzt && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Im Zeitraum gibt es mehr als 2000 E-Mails – durchsucht und angezeigt werden nur die neuesten 2000. Bitte den Zeitraum oder die Anwendung eingrenzen.
        </MessageStrip>
      )}
      <AnalyticalTable
        key={gruppe}
        columns={columns}
        data={daten}
        loading={l.loading}
        filterable
        sortable
        groupable
        reactTableOptions={gruppe ? { initialState: { groupBy: [gruppe] } } : undefined}
        scaleWidthMode="Smart"
        visibleRowCountMode="Auto"
        style={{ height: 'calc(100vh - 330px)', minHeight: 300 }}
        noDataText="Keine E-Mails im gewählten Filter (das Protokoll reicht 180 Tage zurück)"
        onRowClick={(e) => { const z = e.detail.row.original as Zeile | undefined; if (z?.eintrag) setDetail(z.eintrag); }}
      />
      <Dialog open={!!detail} headerText={detail ? `E-Mail vom ${zeitText(detail.zeit)}` : ''} onClose={() => setDetail(null)} style={{ width: 'min(760px, 96vw)' }}
              footer={
                <Bar endContent={
                  <>
                    {detail?.an && <Button design="Transparent" icon="filter" onClick={() => { const an = detail.an ?? ''; setDetail(null); suchen({ ...f, suche: an }); }}>Alle E-Mails an diese Adresse</Button>}
                    {detail?.objekt && <Button design="Transparent" icon="filter" onClick={() => { const o = detail.objekt ?? ''; setDetail(null); suchen({ ...f, suche: o }); }}>Alle E-Mails zum Vorgang</Button>}
                    {darfSenden && detail && sendenKnopf(detail)}
                    <Button design="Emphasized" onClick={() => setDetail(null)}>Schließen</Button>
                  </>
                } />
              }>
        {detail && (
          <Attributes>
            <Attribute label="Status"><ObjectStatus state={STATUS[detail.status]?.state ?? 'None'}>{STATUS[detail.status]?.text ?? detail.status}</ObjectStatus></Attribute>
            <Attribute label="Person" strong>{detail.person || '(unbekannt – Adresse gehört zu keinem Mitglied, Kunden oder Benutzer)'}</Attribute>
            <Attribute label="Empfänger">{detail.an || '–'}</Attribute>
            <Attribute label="Anwendung / Vorgang">{[detail.anwendung, detail.objekt].filter(Boolean).join(' · ') || '–'}</Attribute>
            <Attribute label="Betreff" wide>{detail.betreff || '–'}</Attribute>
            <Attribute label="Absender">{detail.von ?? detail.absender ?? '–'}{detail.von && detail.absender && detail.von !== detail.absender ? ` (gewünscht: ${detail.absender})` : ''}</Attribute>
            <Attribute label="Ausgelöst von">{detail.benutzer || '–'}</Attribute>
            {detail.fehler && <Attribute label="Fehler / Hinweis" wide><Text style={{ whiteSpace: 'pre-wrap' }}>{detail.fehler}</Text></Attribute>}
            {(erneutText(detail) || (!detail.erneut && detail.erneut_hinweis)) && (
              <Attribute label="Erneut senden" wide>{[erneutText(detail), !detail.erneut && !fehlgeschlagen(detail) ? detail.erneut_hinweis : null].filter(Boolean).join(' · ')}</Attribute>
            )}
          </Attributes>
        )}
      </Dialog>
    </AppPage>
  );
}
