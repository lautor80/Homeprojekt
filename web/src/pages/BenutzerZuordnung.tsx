import { useEffect, useState } from 'react';
import {
  AnalyticalTable, Bar, BusyIndicator, Button, CheckBox, Dialog, Label, MessageStrip, ObjectStatus, Text, Title,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '../api';
import { toast } from '../toast';
import { AuswahlBox } from '../components/AuswahlBox';

/**
 * Zuordnung Benutzer ↔ Mitglied / EP3-Kunde (Fachmodul TC Oberthal) für die Benutzerpflege:
 * - im Benutzer-Dialog: Mitglied und EP3-Kunde wählen oder entfernen
 * - „Initiale Zuordnung“: Vorschläge für alle Benutzer ohne Zuordnung (E-Mail, Benutzername, Name) prüfen und übernehmen
 */
const MG = '/api/m/tco/mitglieder';
interface Zuordnung {
  mitglied: { adrnr: string; name: string; austritt: string | null } | null;
  ep3: { zuid: string; alias: string; name: string; ueber: 'MITGLIED' | 'BENUTZER' } | null;
}
interface Treffer {
  mitglieder: { adrnr: string; name: string; email: string | null; mitglnrn: string | null; benutzer: string | null }[];
  kunden: { zuid: string; zalias: string; name: string; email: string | null; benutzer: string | null; mitglied: string | null }[];
}

export function ZuordnungFelder({ benutzerId, darf, onGeaendert }: { benutzerId: string; darf: boolean; onGeaendert?: () => void }) {
  const [z, setZ] = useState<Zuordnung | null>(null);
  const [suche, setSuche] = useState('');
  const [t, setT] = useState<Treffer>({ mitglieder: [], kunden: [] });
  const [error, setError] = useState<string | null>(null);
  const laden = () => api.get<Zuordnung>(`${MG}/benutzer/${benutzerId}/zuordnung`).then(setZ).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, [benutzerId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!darf) return;
    const h = setTimeout(() => api.get<Treffer>(`${MG}/zuordnung-suche?suche=${encodeURIComponent(suche)}`).then(setT).catch(() => undefined), 250);
    return () => clearTimeout(h);
  }, [suche, darf]);
  async function setzen(body: { adrnr?: string | null; zuid?: string | null }) {
    setError(null);
    try { const r = await api.put<{ text: string }>(`${MG}/benutzer/${benutzerId}/zuordnung`, body); toast(r.text); await laden(); onGeaendert?.(); }
    catch (e) { setError((e as Error).message); }
  }
  if (!z) return <BusyIndicator active size="S" />;
  return (
    <div style={{ marginTop: '1rem', display: 'grid', gap: '0.5rem' }}>
      <Title level="H5">Mitglied und EP3-Kunde</Title>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
      <div className="portal-bz">
        <Label showColon>Mitglied</Label>
        <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
          {darf ? (
            <AuswahlBox style={{ flex: 1 }} wert={z.mitglied?.adrnr ?? ''} placeholder="Mitglied suchen (Name, E-Mail, Nummer)" filter="None" leerErlaubt={false}
                        eintraege={[...(z.mitglied && !t.mitglieder.some((m) => m.adrnr === z.mitglied!.adrnr) ? [{ key: z.mitglied.adrnr, text: `${z.mitglied.name} (${z.mitglied.adrnr})` }] : []),
                          ...t.mitglieder.map((m) => ({ key: m.adrnr, text: `${m.name} (${m.adrnr})`, zusatz: m.benutzer ? `Benutzer ${m.benutzer}` : m.email ?? '' }))]}
                        onSuche={setSuche} onWaehle={(k) => { if (k && k !== z.mitglied?.adrnr) setzen({ adrnr: k }); }} />
          ) : <Text>{z.mitglied ? `${z.mitglied.name} (${z.mitglied.adrnr})` : '–'}</Text>}
          {z.mitglied?.austritt && <ObjectStatus state="Critical">Austritt {z.mitglied.austritt.split('-').reverse().join('.')}</ObjectStatus>}
          {darf && z.mitglied && <Button design="Transparent" icon="decline" tooltip="Zuordnung entfernen" onClick={() => setzen({ adrnr: null })} />}
        </div>
        <Label showColon>EP3-Kunde</Label>
        <div className="portal-row" style={{ flexWrap: 'nowrap' }}>
          {darf ? (
            <AuswahlBox style={{ flex: 1 }} wert={z.ep3?.zuid ?? ''} placeholder="EP3-Kunde suchen (Name, E-Mail, Alias)" filter="None" leerErlaubt={false}
                        eintraege={[...(z.ep3 && !t.kunden.some((k) => k.zuid === z.ep3!.zuid) ? [{ key: z.ep3.zuid, text: `${z.ep3.name} – ${z.ep3.alias} (${z.ep3.zuid})` }] : []),
                          ...t.kunden.map((k) => ({ key: k.zuid, text: `${k.name || k.zalias} – ${k.zalias} (${k.zuid})`, zusatz: k.benutzer ? `Benutzer ${k.benutzer}` : k.mitglied ? `Mitglied ${k.mitglied}` : k.email ?? '' }))]}
                        onSuche={setSuche} onWaehle={(k) => { if (k && k !== z.ep3?.zuid) setzen({ zuid: k }); }} />
          ) : <Text>{z.ep3 ? `${z.ep3.name} – ${z.ep3.alias}` : '–'}</Text>}
          {darf && z.ep3 && <Button design="Transparent" icon="decline" tooltip="Zuordnung entfernen" onClick={() => setzen({ zuid: null })} />}
        </div>
      </div>
      <Text className="portal-muted portal-small">
        Mit Mitglied: „Meine Mitgliedschaft“ und Buchen für das Mitglied (Rolle Mitglied wird ergänzt). Mit EP3-Kunde: bisherige EP3-Hallenbuchungen
        gehören zu diesem Benutzer {z.mitglied ? '(über das Mitglied)' : ''}.
      </Text>
    </div>
  );
}

interface Vorschlag {
  benutzerId: string; username: string; name: string; email: string | null; rollen: string[];
  mitglied: { adrnr: string; name: string; grund: string } | null;
  ep3: { zuid: string; alias: string; name: string; grund: string } | null;
}

export function InitialeZuordnung({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [liste, setListe] = useState<Vorschlag[] | null>(null);
  const [aus, setAus] = useState<Set<string>>(new Set());
  const [rolle, setRolle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<Vorschlag[]>(`${MG}/benutzer-mapping`).then(setListe).catch((e) => setError(e.message)); }, []);
  const key = (v: Vorschlag, t: 'm' | 'e') => `${v.benutzerId}:${t}`;
  const an = (k: string) => !aus.has(k);
  const umschalten = (k: string) => setAus((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const gewaehlt = (liste ?? []).map((v) => ({ benutzerId: v.benutzerId, adrnr: v.mitglied && an(key(v, 'm')) ? v.mitglied.adrnr : null, zuid: v.ep3 && an(key(v, 'e')) ? v.ep3.zuid : null }))
    .filter((x) => x.adrnr || x.zuid);

  async function uebernehmen() {
    setBusy(true); setError(null);
    try { const r = await api.post<{ text: string }>(`${MG}/benutzer-mapping`, { liste: gewaehlt, rolleMitglied: rolle }); toast(r.text, 6000); onDone(); onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Benutzer', id: 'u', minWidth: 200, Cell: ({ row }: Cell) => <div style={{ lineHeight: 1.3 }}><Text>{row.original.name}</Text><br /><Label>{row.original.username}{row.original.email ? ` · ${row.original.email}` : ''}</Label></div> },
    { Header: 'Rollen', id: 'r', width: 150, Cell: ({ row }: Cell) => (row.original.rollen as string[]).join(', ') || '–' },
    {
      Header: 'Mitglied', id: 'm', minWidth: 220,
      Cell: ({ row }: Cell) => { const v = row.original as Vorschlag; return v.mitglied
        ? <CheckBox text={`${v.mitglied.name} (${v.mitglied.grund})`} checked={an(key(v, 'm'))} onChange={() => umschalten(key(v, 'm'))} />
        : <Text className="portal-muted">–</Text>; },
    },
    {
      Header: 'EP3-Kunde', id: 'e', minWidth: 220,
      Cell: ({ row }: Cell) => { const v = row.original as Vorschlag; return v.ep3
        ? <CheckBox text={`${v.ep3.name} – ${v.ep3.alias} (${v.ep3.grund})`} checked={an(key(v, 'e'))} onChange={() => umschalten(key(v, 'e'))} />
        : <Text className="portal-muted">–</Text>; },
    },
  ];
  return (
    <Dialog open headerText="Initiale Zuordnung: Benutzer ↔ Mitglied / EP3-Kunde" style={{ width: 'min(70rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" icon="accept" disabled={!gewaehlt.length || busy} onClick={uebernehmen}>{gewaehlt.length} Benutzer zuordnen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        <Text>
          Vorschläge für aktive Benutzer ohne Mitglied bzw. EP3-Kunde – eindeutige Treffer nach gleicher E-Mail, gleichem Benutzernamen oder gleichem Namen.
          Häkchen entfernen, um einen Vorschlag auszulassen. Einzelne Zuordnungen lassen sich jederzeit im Benutzer-Dialog ändern.
        </Text>
        <AnalyticalTable columns={columns} data={liste ?? []} loading={!liste} minRows={2} visibleRows={Math.min(Math.max(liste?.length ?? 0, 1), 14)} rowHeight={52}
                         noDataText="Keine Vorschläge – alle Benutzer sind zugeordnet oder es gibt keine eindeutigen Treffer" />
        <CheckBox text="Benutzern mit Mitglied die Rolle „Mitglied“ geben (Meine Mitgliedschaft + Einzelbuchung; ersetzt „Hallennutzer“)" checked={rolle} onChange={(e) => setRolle(e.target.checked)} />
      </div>
    </Dialog>
  );
}
