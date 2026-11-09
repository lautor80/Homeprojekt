import { createPortal } from 'react-dom';
import { useState } from 'react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as CellInstance } from '@ui5/webcomponents-react';
import { AnalyticalTable, Bar, Button, Dialog, MessageStrip, Tag } from '@ui5/webcomponents-react';
import { api } from '../api';

export interface ChangeDoc {
  id: string;
  objectType: string;
  objectKey: string;
  tableName: string;
  changeInd: 'I' | 'U' | 'D';
  action: string | null;
  reason: string | null;
  username: string;
  changedAt: string;
  items: { field: string; oldValue: string | null; newValue: string | null }[];
}

export const changeIndText = { I: 'Angelegt', U: 'Geändert', D: 'Gelöscht' } as const;
const changeIndDesign = { I: 'Positive', U: 'Information', D: 'Negative' } as const;

export const fmtDateTime = (v: string) =>
  new Date(v).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });

/** Belege in Tabellenzeilen auflösen: eine Zeile je geändertem Feld. */
export function flattenDocs(docs: ChangeDoc[]) {
  return docs.flatMap((d) => {
    const base = {
      docId: d.id, changedAt: d.changedAt, username: d.username, objectType: d.objectType,
      objectKey: d.objectKey, changeInd: d.changeInd, action: d.action, reason: d.reason,
    };
    if (!d.items.length) return [{ ...base, field: '', oldValue: '', newValue: '' }];
    return d.items.map((i) => ({ ...base, field: i.field, oldValue: i.oldValue ?? '', newValue: i.newValue ?? '' }));
  });
}

type Row = ReturnType<typeof flattenDocs>[number];

export const changeColumns = (withObject: boolean): AnalyticalTableColumnDefinition[] => [
  { Header: 'Zeitpunkt', accessor: 'changedAt', width: 170, Cell: ({ value }: CellInstance) => fmtDateTime(value) },
  { Header: 'Benutzer', accessor: 'username', width: 120 },
  ...(withObject
    ? [
        { Header: 'Objekt', accessor: 'objectType', width: 130 },
        { Header: 'Schlüssel', accessor: 'objectKey', width: 140 },
      ]
    : []),
  {
    Header: 'Änderung', accessor: 'changeInd', width: 110,
    Cell: ({ row }: CellInstance) => (
      <Tag design={changeIndDesign[(row.original as Row).changeInd]} hideStateIcon>
        {(row.original as Row).action ?? changeIndText[(row.original as Row).changeInd]}
      </Tag>
    ),
  },
  { Header: 'Feld', accessor: 'field', width: 150 },
  { Header: 'Alter Wert', accessor: 'oldValue' },
  { Header: 'Neuer Wert', accessor: 'newValue' },
  { Header: 'Begründung', accessor: 'reason' },
];

/**
 * Belege als Baum: zuerst nach Tag, dann nach Benutzer gruppiert (neueste zuerst), darunter die geänderten Felder.
 * Liefert Daten (subRows) und den aufgeklappten Anfangszustand.
 */
export function gruppiertNachTagUndBenutzer(docs: ChangeDoc[]) {
  const zeilen = flattenDocs(docs).sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  const tage = new Map<string, Map<string, Row[]>>();
  for (const z of zeilen) {
    const tag = new Date(z.changedAt).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    const je = tage.get(tag) ?? new Map<string, Row[]>();
    je.set(z.username, [...(je.get(z.username) ?? []), z]);
    tage.set(tag, je);
  }
  const expanded: Record<string, boolean> = {};
  const data = [...tage].map(([tag, benutzer], i) => {
    expanded[String(i)] = true;
    const n = [...benutzer.values()].reduce((a, l) => a + l.length, 0);
    return {
      gruppe: `${tag} – ${n} Änderung${n === 1 ? '' : 'en'}`, ebene: 0,
      subRows: [...benutzer].map(([user, l], j) => {
        expanded[`${i}.${j}`] = true;
        return { gruppe: `${user} (${l.length})`, ebene: 1, subRows: l.map((z) => ({ ...z, gruppe: '', ebene: 2 })) };
      }),
    };
  });
  return { data, expanded };
}

const baumSpalten: AnalyticalTableColumnDefinition[] = [
  {
    Header: 'Tag / Benutzer', accessor: 'gruppe', width: 230,
    Cell: ({ row }: CellInstance) => {
      const o = row.original as { gruppe: string; ebene: number; changedAt?: string };
      return o.ebene === 2 ? <span className="portal-muted">{new Date(o.changedAt!).toLocaleTimeString('de-DE')}</span>
        : <span style={{ fontWeight: o.ebene === 0 ? 'bold' : 600 }}>{o.gruppe}</span>;
    },
  },
  ...changeColumns(false).filter((c) => !['changedAt', 'username'].includes(String(c.accessor))),
];

/** Button "Änderungshistorie" für eine Objektseite – zeigt alle Belege eines Objekts, gruppiert nach Tag und Benutzer. */
export function ChangeHistoryButton({ objectType, objectKey }: { objectType: string; objectKey: string }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<ChangeDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setOpen(true);
    setDocs(null);
    setError(null);
    try {
      setDocs(await api.get<ChangeDoc[]>(`/api/audit/object/${encodeURIComponent(objectType)}/${encodeURIComponent(objectKey)}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Button icon="history" design="Transparent" onClick={show}>
        Änderungshistorie
      </Button>
      {createPortal(<Dialog
        open={open}
        onClose={() => setOpen(false)}
        headerText={`Änderungshistorie ${objectKey}`}
        style={{ width: 'min(1100px, 95vw)' }}
        resizable
        footer={<Bar endContent={<Button onClick={() => setOpen(false)}>Schließen</Button>} />}
      >
        {error && <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip>}
        {(() => {
          const g = docs ? gruppiertNachTagUndBenutzer(docs) : { data: [], expanded: {} };
          return (
            <AnalyticalTable minRows={1} key={docs ? 'daten' : 'leer'}
              columns={baumSpalten}
              data={g.data}
              isTreeTable
              reactTableOptions={{ initialState: { expanded: g.expanded } } as never}
              loading={!docs && !error}
              noDataText="Keine Änderungen vorhanden"
              visibleRows={14}
              scaleWidthMode="Smart"
            />
          );
        })()}
      </Dialog>, document.body)}
    </>
  );
}

