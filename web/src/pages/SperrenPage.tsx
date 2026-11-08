import { useEffect, useState } from 'react';
import { AnalyticalTable, Button, MessageStrip, Text } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '../api';
import { AppPage } from '../components/AppPage';
import { Section } from '../components/Section';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { toast } from '../toast';

/** Aktive Sperren aller Benutzer (vergleichbar SM12) – hängende Sperren aufheben */
interface Sperre {
  id: number; objekt: string; objektText: string; schluessel: string; bezeichnung: string | null; benutzer: string;
  erstellt: string; ablauf: string; von: string | null; bis: string | null;
}
const uhr = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const zeitraum = (v: string, b: string) => `${v.slice(8, 10)}.${v.slice(5, 7)}.${v.slice(0, 4)} ${v.slice(11, 16)}–${b.slice(11, 16)}`;

export function SperrenPage() {
  const [liste, setListe] = useState<Sperre[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weg, setWeg] = useState<Sperre | null>(null);
  const laden = () => api.get<Sperre[]>('/api/sperren').then(setListe).catch((e) => setError(e.message));
  useEffect(() => { laden(); const t = setInterval(laden, 15_000); return () => clearInterval(t); }, []);

  const columns: AnalyticalTableColumnDefinition[] = [
    { Header: 'Objekt', accessor: 'objektText', width: 170 },
    {
      Header: 'Schlüssel / Bezeichnung', id: 'was', minWidth: 240,
      Cell: ({ row }: Cell) => {
        const s = row.original as Sperre;
        return <Text>{[s.schluessel === '*' ? 'alle' : s.schluessel, s.bezeichnung, s.von && s.bis ? zeitraum(s.von, s.bis) : null].filter(Boolean).join(' · ')}</Text>;
      },
    },
    { Header: 'Benutzer', accessor: 'benutzer', width: 160 },
    { Header: 'Seit', accessor: 'erstellt', width: 140, Cell: ({ value }: Cell) => uhr(value) },
    { Header: 'Läuft ab', accessor: 'ablauf', width: 140, Cell: ({ value }: Cell) => uhr(value) },
    {
      Header: '', id: 'aktion', width: 120,
      Cell: ({ row }: Cell) => <Button design="Transparent" icon="unlocked" onClick={() => setWeg(row.original)}>Aufheben</Button>,
    },
  ];

  return (
    <AppPage title="Sperren" subtitle="Objekte, die gerade bearbeitet werden"
             actions={<Button icon="refresh" onClick={laden}>Aktualisieren</Button>}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
        Sperren entstehen beim Öffnen eines Objekts zur Bearbeitung (und bei der Auswahl einer Platzzeit) und verhindern gleichzeitige Änderungen.
        Sie werden beim Schließen freigegeben, laufen ohne Lebenszeichen nach 2 Minuten und ohne Bedienung nach 15 Minuten ab.
        Aufheben nur, wenn sicher niemand mehr daran arbeitet – nicht gesicherte Eingaben des Benutzers können dann nicht mehr gespeichert werden.
      </MessageStrip>
      <Section title="Aktive Sperren" count={liste?.length ?? 0} flush>
        <AnalyticalTable columns={columns} data={liste ?? []} loading={!liste} minRows={1} visibleRows={Math.min(Math.max(liste?.length ?? 0, 2), 20)}
                         noDataText="Keine aktiven Sperren" />
      </Section>
      <ConfirmDialog open={!!weg} danger title="Sperre aufheben" confirmText="Aufheben"
                     text={weg ? `Sperre von ${weg.benutzer} auf ${weg.objektText} ${weg.schluessel === '*' ? '' : weg.schluessel} aufheben?` : ''}
                     onCancel={() => setWeg(null)}
                     onConfirm={async () => {
                       const s = weg!; setWeg(null);
                       try { const r = await api.del<{ text: string }>(`/api/sperren/${s.id}`); toast(r.text); laden(); } catch (e) { setError((e as Error).message); }
                     }} />
    </AppPage>
  );
}
