import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, Button, ComboBox, ComboBoxItem, Dialog, Input, Label, MessageStrip, ObjectStatus, RadioButton, SegmentedButton,
  SegmentedButtonItem, Text, TextArea, Title, Toolbar, ToolbarSpacer,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { TCO } from '../util';
import { AuswahlBox } from '@core/components/AuswahlBox';

/**
 * Zugänge zur Platzbuchung (Platzverwaltung):
 *  - Registrierungen: Freigabe mit Zuordnung (Mitglied / EP3-Kunde / neuer Kunde) oder Ablehnung.
 *    Jeder freigegebene Benutzer erhält ausschließlich die Rolle „Hallennutzer“ (nur Einzelbuchung).
 *  - EP3-Abgleich: EP3-Kunden ohne Portalzugang mit vorhandenen Benutzern/Mitgliedern zusammenbringen
 *    oder direkt als Hallennutzer anlegen (bisheriges EP3-Kennwort gilt weiter, wenn es importiert wurde).
 */
const PA = `${TCO}/platz/admin`;
type Aktion = (fn: () => Promise<unknown>, nachher?: () => unknown) => Promise<boolean>;

interface Vorschlag { art: 'MITGLIED' | 'EP3'; schluessel: string; name: string; grund: string; info: string }
interface Registrierung {
  id: number; benutzername: string; anzeigename: string; vorname: string | null; nachname: string | null; email: string; telefon: string | null;
  ep3_zuid: string | null; ep3_alias: string | null; ep3_name: string | null; nachricht: string | null; status: 'OFFEN' | 'BESTAETIGT' | 'ABGELEHNT';
  erstellt: string; bearbeitet_am: string | null; bearbeitet_von: string | null; bemerkung: string | null; vorschlaege: Vorschlag[];
}
interface Mitglied { adrnr: string; name: string }
interface Ep3Kunde {
  zuid: string; alias: string; name: string; email: string | null; status: string | null; kennwort: boolean; buchungen: number;
  benutzer: string | null; mitglied: string | null; treffer: { art: 'BENUTZER' | 'MITGLIED'; schluessel: string; name: string; grund: string }[];
}
const zeit = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const STATUS: Record<Registrierung['status'], { text: string; state: 'Critical' | 'Positive' | 'Negative' }> = {
  OFFEN: { text: 'offen', state: 'Critical' }, BESTAETIGT: { text: 'freigegeben', state: 'Positive' }, ABGELEHNT: { text: 'abgelehnt', state: 'Negative' },
};

export function Zugaenge({ aktion }: { aktion: Aktion }) {
  const [sicht, setSicht] = useState<'reg' | 'ep3'>('reg');
  const [offen, setOffen] = useState<number | null>(null);
  useEffect(() => { api.get<Registrierung[]>(`${PA}/registrierungen`).then((r) => setOffen(r.length)).catch(() => undefined); }, []);
  return (
    <>
      <Toolbar design="Transparent">
        <SegmentedButton onSelectionChange={(e) => setSicht((e.detail.selectedItems[0] as HTMLElement).dataset.s as 'reg' | 'ep3')}>
          <SegmentedButtonItem data-s="reg" selected={sicht === 'reg'}>Registrierungen{offen ? ` (${offen})` : ''}</SegmentedButtonItem>
          <SegmentedButtonItem data-s="ep3" selected={sicht === 'ep3'}>EP3-Abgleich</SegmentedButtonItem>
        </SegmentedButton>
        <ToolbarSpacer />
      </Toolbar>
      {sicht === 'reg' ? <Registrierungen aktion={aktion} onOffen={setOffen} /> : <Ep3Abgleich aktion={aktion} />}
    </>
  );
}

// ---------------------------------------------------------------- Registrierungen
function Registrierungen({ aktion, onOffen }: { aktion: Aktion; onOffen: (n: number) => void }) {
  const [liste, setListe] = useState<Registrierung[] | null>(null);
  const [alle, setAlle] = useState(false);
  const [frei, setFrei] = useState<Registrierung | null>(null);
  const [weg, setWeg] = useState<Registrierung | null>(null);
  const laden = () => api.get<Registrierung[]>(`${PA}/registrierungen?status=${alle ? 'ALLE' : 'OFFEN'}`).then((r) => { setListe(r); onOffen(r.filter((x) => x.status === 'OFFEN').length); });
  useEffect(() => { setListe(null); laden(); }, [alle]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Eingegangen', accessor: 'erstellt', width: 150, Cell: ({ value }: Cell) => zeit(value) },
    {
      Header: 'Person', id: 'person', minWidth: 220,
      Cell: ({ row }: Cell) => { const r = row.original as Registrierung; return <div style={{ lineHeight: 1.3 }}><Text>{r.anzeigename}</Text><br /><Label>{r.email}{r.telefon ? ` · ${r.telefon}` : ''}</Label></div>; },
    },
    { Header: 'Benutzername', accessor: 'benutzername', width: 150 },
    {
      Header: 'EP3-Konto', id: 'ep3', width: 180,
      Cell: ({ row }: Cell) => { const r = row.original as Registrierung; return r.ep3_zuid ? <ObjectStatus state="Positive" showDefaultIcon>{r.ep3_alias ?? r.ep3_zuid} (nachgewiesen)</ObjectStatus> : <Text className="portal-muted">–</Text>; },
    },
    {
      Header: 'Zuordnung', id: 'vorschlag', minWidth: 220,
      Cell: ({ row }: Cell) => {
        const r = row.original as Registrierung;
        if (r.status !== 'OFFEN') return <Text className="portal-muted">{r.bemerkung ?? ''}</Text>;
        if (!r.vorschlaege.length) return <Text className="portal-muted">kein Mitglied/EP3-Kunde gefunden</Text>;
        return <Text>{r.vorschlaege.slice(0, 2).map((v) => `${v.art === 'MITGLIED' ? 'Mitglied' : 'EP3'}: ${v.name} (${v.grund})`).join(' · ')}{r.vorschlaege.length > 2 ? ' …' : ''}</Text>;
      },
    },
    { Header: 'Status', accessor: 'status', width: 120, Cell: ({ value }: Cell) => <ObjectStatus state={STATUS[value as Registrierung['status']].state} inverted>{STATUS[value as Registrierung['status']].text}</ObjectStatus> },
    {
      Header: '', id: 'aktion', width: 210,
      Cell: ({ row }: Cell) => {
        const r = row.original as Registrierung;
        if (r.status !== 'OFFEN') return <Label>{r.bearbeitet_von}{r.bearbeitet_am ? `, ${zeit(r.bearbeitet_am)}` : ''}</Label>;
        return (
          <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
            <Button design="Emphasized" icon="accept" onClick={() => setFrei(r)}>Freigeben</Button>
            <Button design="Transparent" icon="decline" onClick={() => setWeg(r)}>Ablehnen</Button>
          </div>
        );
      },
    },
  ];
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Registrierungen ({liste?.length ?? 0})</Title>
        <ToolbarSpacer />
        <Button design="Transparent" icon={alle ? 'filter' : 'history'} onClick={() => setAlle(!alle)}>{alle ? 'Nur offene' : 'Auch erledigte'}</Button>
      </Toolbar>
      <AnalyticalTable columns={columns} data={liste ?? []} loading={!liste} visibleRows={Math.min(Math.max(liste?.length ?? 0, 3), 15)} rowHeight={52} noDataText="Keine Registrierungen" />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Freigegebene Benutzer erhalten ausschließlich die Systemrolle „Hallennutzer“ – nur eigene Einzelbuchungen. Weitere Rechte vergibt nur die Benutzerpflege.
        Mit nachgewiesenem EP3-Konto gilt das bisherige EP3-Kennwort weiter; sonst das bei der Registrierung gewählte.
      </MessageStrip>
      {frei && <FreigabeDialog r={frei} onClose={() => setFrei(null)} onDone={() => { setFrei(null); laden(); }} aktion={aktion} />}
      <ConfirmDialog open={!!weg} danger title="Registrierung ablehnen" confirmText="Ablehnen" text={`Registrierung von ${weg?.anzeigename ?? ''} (${weg?.email ?? ''}) ablehnen? Es wird kein Benutzer angelegt.`}
                     onCancel={() => setWeg(null)}
                     onConfirm={() => { const r = weg!; setWeg(null); aktion(() => api.post(`${PA}/registrierungen/${r.id}/ablehnen`, {}), laden); }} />
    </>
  );
}

function FreigabeDialog({ r, onClose, onDone, aktion }: { r: Registrierung; onClose: () => void; onDone: () => void; aktion: Aktion }) {
  const vorschlag = r.vorschlaege[0];
  const [art, setArt] = useState<'MITGLIED' | 'EP3' | 'NEU'>(vorschlag?.art ?? (r.ep3_zuid ? 'NEU' : 'NEU'));
  const [adrnr, setAdrnr] = useState(vorschlag?.art === 'MITGLIED' ? vorschlag.schluessel : '');
  const [zuid, setZuid] = useState(vorschlag?.art === 'EP3' ? vorschlag.schluessel : '');
  const [bemerkung, setBemerkung] = useState('');
  const [mitglieder, setMitglieder] = useState<Mitglied[]>([]);
  useEffect(() => { api.get<{ mitglieder: Mitglied[] }>(`${PA}/benutzer`).then((d) => setMitglieder(d.mitglieder)).catch(() => undefined); }, []);
  const ok = art === 'NEU' || (art === 'MITGLIED' && adrnr) || (art === 'EP3' && zuid);
  const zuordnung = art === 'MITGLIED' ? { art, adrnr } : art === 'EP3' ? { art, zuid } : { art };
  return createPortal(
    <Dialog open headerText={`Freigeben – ${r.anzeigename}`} style={{ width: 'min(36rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="accept" disabled={!ok} onClick={async () => { if (await aktion(() => api.post(`${PA}/registrierungen/${r.id}/bestaetigen`, { zuordnung, bemerkung: bemerkung || null }))) onDone(); }}>Freigeben</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-bk__form">
        <Text>
          Benutzer <b>{r.benutzername}</b> · {r.email}{r.telefon ? ` · ${r.telefon}` : ''}
          {r.ep3_zuid && <> · EP3-Konto <b>{r.ep3_alias ?? r.ep3_zuid}</b>{r.ep3_name ? ` (${r.ep3_name})` : ''} nachgewiesen</>}
        </Text>
        {r.nachricht && <MessageStrip design="Information" hideCloseButton>Mitteilung: {r.nachricht}</MessageStrip>}
        <Label showColon>Für wen bucht dieser Benutzer?</Label>
        <RadioButton name="zu" text="Mitglied des Vereins" checked={art === 'MITGLIED'} onChange={() => setArt('MITGLIED')} />
        {art === 'MITGLIED' && (
          <AuswahlBox wert={adrnr} placeholder="Mitglied suchen" style={{ width: '100%' }}
                      eintraege={mitglieder.map((m) => ({ key: m.adrnr, text: m.name, zusatz: m.adrnr }))} onWaehle={(k) => setAdrnr(k ?? '')} />
        )}
        <RadioButton name="zu" text="Bestehender EP3-Kunde (bisherige Hallenbuchungen gehören dazu)" checked={art === 'EP3'} onChange={() => setArt('EP3')} />
        {art === 'EP3' && (
          <Input value={zuid} placeholder="EP3-Kundennummer (ZUID)" style={{ width: '100%' }} onInput={(e) => setZuid(e.target.value)} />
        )}
        <RadioButton name="zu" text={r.ep3_zuid ? 'Nachgewiesenes EP3-Konto (kein Mitglied)' : 'Neuer Kunde ohne Mitgliedschaft (eigener Kundenstammsatz)'} checked={art === 'NEU'} onChange={() => setArt('NEU')} />
        {r.vorschlaege.length > 0 && (
          <div>
            <Label showColon>Gefunden</Label>
            {r.vorschlaege.map((v) => (
              <div key={`${v.art}-${v.schluessel}`} className="portal-row" style={{ justifyContent: 'space-between' }}>
                <Text>{v.name} <span className="portal-muted">· {v.info} · {v.grund}</span></Text>
                <Button design="Transparent" onClick={() => { setArt(v.art); if (v.art === 'MITGLIED') setAdrnr(v.schluessel); else setZuid(v.schluessel); }}>Übernehmen</Button>
              </div>
            ))}
          </div>
        )}
        <Label showColon>Bemerkung (intern)</Label>
        <TextArea rows={2} value={bemerkung} maxlength={500} onInput={(e) => setBemerkung(e.target.value)} />
        <MessageStrip design="Information" hideCloseButton>Der Benutzer erhält nur die Rolle „Hallennutzer“ (eigene Einzelbuchungen). Ist der Mailversand eingerichtet, wird die Person benachrichtigt.</MessageStrip>
      </div>
    </Dialog>,
    document.body,
  );
}

// ---------------------------------------------------------------- EP3-Abgleich
function Ep3Abgleich({ aktion }: { aktion: Aktion }) {
  const [liste, setListe] = useState<Ep3Kunde[] | null>(null);
  const [suche, setSuche] = useState('');
  const [nurOffen, setNurOffen] = useState(true);
  const [nurAktiv, setNurAktiv] = useState(true);
  const [start, setStart] = useState<{ username: string; startkennwort: string | null; text: string } | null>(null);
  const laden = () => api.get<Ep3Kunde[]>(`${PA}/ep3`).then(setListe);
  useEffect(() => { laden(); }, []);
  const zeilen = (liste ?? []).filter((k) => (!nurOffen || (!k.benutzer && !k.mitglied)) && (!nurAktiv || k.buchungen > 0) && (!suche || `${k.name} ${k.alias} ${k.email ?? ''}`.toLowerCase().includes(suche.toLowerCase())));

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'EP3-Kunde', id: 'kunde', minWidth: 200, Cell: ({ row }: Cell) => { const k = row.original as Ep3Kunde; return <div style={{ lineHeight: 1.3 }}><Text>{k.name || k.alias}</Text><br /><Label>{k.alias} · {k.zuid}{k.email ? ` · ${k.email}` : ''}</Label></div>; } },
    { Header: 'Status', accessor: 'status', width: 90 },
    { Header: 'Buchungen 12 Mon.', accessor: 'buchungen', width: 120, hAlign: 'End' },
    { Header: 'Kennwort', id: 'pw', width: 110, Cell: ({ row }: Cell) => ((row.original as Ep3Kunde).kennwort ? <ObjectStatus state="Positive">importiert</ObjectStatus> : <ObjectStatus state="None">fehlt</ObjectStatus>) },
    {
      Header: 'Portal', id: 'portal', minWidth: 320,
      Cell: ({ row }: Cell) => {
        const k = row.original as Ep3Kunde;
        if (k.benutzer || k.mitglied) return <ObjectStatus state="Positive" showDefaultIcon>{k.mitglied ? `Mitglied ${k.mitglied}` : ''}{k.mitglied && k.benutzer ? ' · ' : ''}{k.benutzer ? `Benutzer ${k.benutzer}` : ''}</ObjectStatus>;
        return (
          <div className="portal-row" style={{ flexWrap: 'wrap' }}>
            {k.treffer.map((t) => (
              <Button key={`${t.art}-${t.schluessel}`} design="Transparent" icon={t.art === 'BENUTZER' ? 'employee' : 'customer'} tooltip={t.grund}
                      onClick={() => aktion(() => api.post(`${PA}/ep3/${encodeURIComponent(k.zuid)}/verknuepfen`, t.art === 'BENUTZER' ? { benutzer_id: t.schluessel } : { adrnr: t.schluessel }), laden)}>
                {t.art === 'BENUTZER' ? 'Benutzer' : 'Mitglied'}: {t.name}
              </Button>
            ))}
            <Button design="Transparent" icon="add-employee" onClick={() => aktion(async () => { const r = await api.post<{ username: string; startkennwort: string | null; text: string }>(`${PA}/ep3/${encodeURIComponent(k.zuid)}/anlegen`, {}); if (r.startkennwort) setStart(r); return r; }, laden)}>
              Als Hallennutzer anlegen
            </Button>
          </div>
        );
      },
    },
  ];
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">EP3-Kunden ({zeilen.length})</Title>
        <ToolbarSpacer />
        <Button design="Emphasized" icon="add-employee" onClick={() => aktion(() => api.post(`${PA}/ep3/anlegen-alle`, {}), laden)}>Alle mit Buchung anlegen</Button>
        <Button design="Transparent" icon={nurAktiv ? 'calendar' : 'clear-filter'} onClick={() => setNurAktiv(!nurAktiv)}>{nurAktiv ? 'Nur mit Buchung (12 Monate)' : 'Auch ohne Buchung'}</Button>
        <Button design="Transparent" icon={nurOffen ? 'filter' : 'clear-filter'} onClick={() => setNurOffen(!nurOffen)}>{nurOffen ? 'Nur ohne Zuordnung' : 'Alle'}</Button>
        <Input placeholder="Suchen" value={suche} onInput={(e) => setSuche(e.target.value)} style={{ width: '14rem' }} />
      </Toolbar>
      <AnalyticalTable columns={columns} data={zeilen} loading={!liste} visibleRows={Math.min(Math.max(zeilen.length, 3), 20)} rowHeight={52} noDataText="Keine EP3-Kunden ohne Zuordnung" />
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Der Kundenimport legt für alle EP3-Kunden mit mindestens einer Buchung in den letzten 12 Monaten automatisch Hallennutzer an (sichtbar unter Administration → Benutzer): Anmeldename = E-Mail-Adresse (sonst EP3-Alias), Anzeigename „Nachname, Vorname“,
        Rolle Hallennutzer; Mitglieder werden über ZUID, E-Mail oder Name zugeordnet. Wurde das EP3-Kennwort importiert (Spalte PW), gilt es weiter – sonst muss es in der
        Benutzerpflege gesetzt werden. Hier bleiben nur Sonderfälle: Vorschläge zum Verknüpfen mit vorhandenen Benutzern/Mitgliedern oder einzelnes Anlegen.
      </MessageStrip>
      {start && (
        <ConfirmDialog open title="Startkennwort" confirmText="Schließen" onCancel={() => setStart(null)} onConfirm={() => setStart(null)}
                       text={`${start.text}\n\nBenutzer: ${start.username}\nStartkennwort: ${start.startkennwort}\n\nBitte sicher übermitteln – es wird nur einmal angezeigt.`} />
      )}
    </>
  );
}
