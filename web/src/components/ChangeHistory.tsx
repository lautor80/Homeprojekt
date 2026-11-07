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

/** Button "Änderungshistorie" für eine Objektseite – zeigt alle Belege eines Objekts. */
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
        <AnalyticalTable
          columns={changeColumns(false)}
          data={docs ? flattenDocs(docs) : []}
          loading={!docs && !error}
          noDataText="Keine Änderungen vorhanden"
          visibleRows={12}
          scaleWidthMode="Smart"
        />
      </Dialog>, document.body)}
    </>
  );
}

