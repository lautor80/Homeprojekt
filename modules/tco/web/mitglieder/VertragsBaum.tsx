import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Varianten, feld } from '@core/components/Varianten';
import { AnalyticalTable, Button, CheckBox, Icon, Input, Link, ObjectStatus, Text } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { dat, eur } from '../util';
import type { Person, Vertrag } from './typen';
import '../gruppen/gruppen.css';

/**
 * Vertragsbaum: alle Verträge des Mitglieds und aller verknüpften Personen (abweichender Zahler, Familie, Personen, die über
 * das Mitglied zahlen). Ebenen: Zahler → Personen, die über ihn zahlen → Verträge. Layout wie die Gruppenpflege
 * (Mitgliedergruppen): Leiste mit Suche, „Auch beendete“, Auf-/Zuklappen, Baumtabelle mit Spalten und Aktionen je Zeile.
 * Genutzt in der Mitglieder-App (Reiter „Verträge“) und in „Meine Mitgliedschaft“.
 */
interface Zeile<V extends Vertrag> {
  id: string; p?: Person; v?: V; subRows?: Zeile<V>[];
  /** Personenzeile: Summe der laufenden Verträge einschließlich der Personen darunter bzw. nur der eigenen */
  summe?: number; eigene?: number; laufend?: number;
}
type Tabelle = { toggleAllRowsExpanded?: (v: boolean) => void };

const status = (v: Vertrag) => (v.laeuft ? (v.vertragende ? 'gekündigt' : 'läuft') : 'beendet');

export function VertragsBaum<V extends Vertrag>({
  personen, vertraege, ich, ichText, onPerson, beginnZelle, endeZelle, zahlerZelle, vertragAktion, personAktion, aktionen, aktionenBreite = 200,
  vertragVorne, kompakt, endeTitel = 'Ende',
}: {
  /** Element vor dem Vertrag (z. B. Kästchen zur Auswahl im Kündigungsdialog) */
  vertragVorne?: (v: V) => ReactNode;
  /** Auswahl-Ansicht im Dialog: ohne Leiste, ohne Zahler- und Statusspalte */
  kompakt?: boolean;
  endeTitel?: string;
  personen: Person[];
  vertraege: V[];
  /** Adressnummer der Person, deren Seite das ist */
  ich: string;
  /** Anzeige statt des eigenen Namens, z. B. „ich“ */
  ichText?: string;
  /** Klick auf den Namen einer anderen Person (z. B. Mitglied öffnen) */
  onPerson?: (adrnr: string) => void;
  /** eigene Zelle für Beginn (#33: Mitgliederpflege, immer änderbar); null = Text */
  beginnZelle?: (v: V) => ReactNode | null;
  /** eigene Zelle für Ende bzw. Zahler (z. B. änderbar); null = Text */
  endeZelle?: (v: V) => ReactNode | null;
  zahlerZelle?: (v: V) => ReactNode | null;
  vertragAktion?: (v: V) => ReactNode;
  personAktion?: (p: Person) => ReactNode;
  /** Schaltflächen rechts in der Leiste */
  aktionen?: ReactNode;
  aktionenBreite?: number;
}) {
  const [suche, setSuche] = useState('');
  const [alle, setAlle] = useState(false);
  const tabelle = useRef<Tabelle | null>(null);
  const such = suche.trim().toLowerCase();
  const namen = useMemo(() => new Map(personen.map((p) => [p.adrnr, p.name])), [personen]);

  const baum = useMemo(() => {
    const passt = (...t: (string | null | undefined)[]) => !such || such.split(/\s+/).every((w) => t.some((x) => !!x && x.toLowerCase().includes(w)));
    const ids = new Set(personen.map((p) => p.adrnr));
    const besucht = new Set<string>();
    const bauen = (p: Person): Zeile<V> | null => {
      besucht.add(p.adrnr);
      const kinder = personen.filter((k) => k.zahlt_ueber === p.adrnr && !besucht.has(k.adrnr)).map(bauen).filter((z): z is Zeile<V> => !!z);
      const eigeneVt = vertraege.filter((v) => v.adrnr === p.adrnr);
      const personPasst = passt(p.name, p.mitglnrn, p.rolle);
      const vt = eigeneVt.filter((v) => (alle || v.laeuft) && (personPasst || passt(v.art, v.artname, v.vertragnr, v.zahler, v.sollstellung, status(v))));
      if (such && !personPasst && !vt.length && !kinder.length) return null;
      const eigene = eigeneVt.filter((v) => v.laeuft).reduce((s, v) => s + v.betrag, 0);
      return {
        id: `p${p.adrnr}`, p, eigene, laufend: eigeneVt.filter((v) => v.laeuft).length,
        summe: eigene + kinder.reduce((s, k) => s + (k.summe ?? 0), 0),
        subRows: [...vt.map((v) => ({ id: `v${v.adrnr}:${v.vertragnr}`, v })), ...kinder],
      };
    };
    // oberste Ebene: wer selbst zahlt oder über eine Person zahlt, die nicht zur Familie gehört
    const wurzeln = personen.filter((p) => !p.zahlt_ueber || !ids.has(p.zahlt_ueber) || p.zahlt_ueber === p.adrnr);
    const z = [...wurzeln, ...personen].flatMap((p) => (besucht.has(p.adrnr) ? [] : [bauen(p)])).filter((x): x is Zeile<V> => !!x);
    return z;
  }, [personen, vertraege, such, alle]);
  const anzahlZeilen = (z: Zeile<V>[]): number => z.reduce((n, x) => n + 1 + (x.subRows ? anzahlZeilen(x.subRows) : 0), 0);

  // Beim Laden, bei Suche und beim Umschalten „Auch beendete“ alles aufklappen
  useEffect(() => { tabelle.current?.toggleAllRowsExpanded?.(true); }, [such, alle, personen.length, vertraege.length]);

  const laufende = vertraege.filter((v) => v.laeuft);
  const summe = laufende.reduce((s, v) => s + v.betrag, 0);

  const columns: AnalyticalTableColumnDefinition[] = [
    {
      Header: 'Person / Vertrag', id: 'text', minWidth: 280,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile<V>;
        if (z.v) {
          const v = z.v;
          return (
            <div className="portal-gr__zelle">
              {vertragVorne?.(v)}
              <Icon name="document-text" />
              <Text>{v.artname ? `${v.art} – ${v.artname}` : v.art}</Text>
              <span className="portal-muted portal-small">Nr. {v.vertragnr}</span>
            </div>
          );
        }
        const p = z.p!;
        const selbst = p.adrnr === ich;
        return (
          <div className="portal-gr__zelle">
            <Icon name={personen.some((k) => k.zahlt_ueber === p.adrnr && k.adrnr !== p.adrnr) ? 'family-care' : 'employee'} />
            {selbst || !onPerson ? <Text><b>{selbst && ichText ? ichText : p.name}</b></Text> : <Link onClick={() => onPerson(p.adrnr)}><b>{p.name}</b></Link>}
            {p.mitglnrn && <span className="portal-muted portal-small">Nr. {p.mitglnrn}</span>}
            {!selbst && <span className="portal-muted portal-small">{p.rolle}</span>}
            {p.austritt && <ObjectStatus state="Negative">Austritt {dat(p.austritt)}</ObjectStatus>}
          </div>
        );
      },
    },
    { Header: 'Turnus', id: 'turnus', width: 120, responsiveMinWidth: 1000, Cell: ({ row }: Cell) => (row.original as Zeile<V>).v?.sollstellung ?? '' },
    {
      Header: 'Beginn', id: 'beginn', width: beginnZelle ? 170 : 105,
      Cell: ({ row }: Cell) => { const v = (row.original as Zeile<V>).v; return v ? beginnZelle?.(v) ?? dat(v.vertragbegin) : ''; },
    },
    {
      Header: endeTitel, id: 'ende', width: endeZelle ? 170 : 110,
      Cell: ({ row }: Cell) => {
        const v = (row.original as Zeile<V>).v;
        if (!v) return '';
        return endeZelle?.(v) ?? <Text>{v.vertragende ? dat(v.vertragende) : 'unbefristet'}</Text>;
      },
    },
    {
      Header: 'Betrag', id: 'betrag', width: 190, hAlign: 'End',
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile<V>;
        if (z.v) return <Text>{eur(z.v.betrag)}</Text>;
        // maßgeblich ist die Summe einschließlich der Personen, die über diese Person zahlen (laufende Verträge)
        return <Text title="Summe der laufenden Verträge">{z.summe === z.eigene ? eur(z.summe) : `${eur(z.summe)} · davon eigene ${eur(z.eigene)}`}</Text>;
      },
    },
    ...(kompakt ? [] : [{
      Header: 'Zahler', id: 'zahler', minWidth: 170,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile<V>;
        if (z.v) return zahlerZelle?.(z.v) ?? <Text>{z.v.zahler}</Text>;
        const p = z.p!;
        return <Text className="portal-muted">{p.zahlt_ueber ? `zahlt über ${namen.get(p.zahlt_ueber) ?? Number(p.zahlt_ueber)}` : 'zahlt selbst'}</Text>;
      },
    },
    {
      Header: 'Status', id: 'status', width: 120,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile<V>;
        if (!z.v) return <Text className="portal-muted">{z.laufend === 1 ? '1 Vertrag' : `${z.laufend} Verträge`}</Text>;
        const v = z.v;
        return <ObjectStatus state={v.laeuft ? (v.vertragende ? 'Critical' : 'Positive') : 'None'}>{status(v)}</ObjectStatus>;
      },
    }] as AnalyticalTableColumnDefinition[]),
    ...(vertragAktion || personAktion ? [{
      Header: '', id: 'aktionen', width: aktionenBreite, hAlign: 'End' as const,
      Cell: ({ row }: Cell) => {
        const z = row.original as Zeile<V>;
        return (z.v ? vertragAktion?.(z.v) : personAktion?.(z.p!)) ?? '';
      },
    }] : []),
  ];

  const tabellenOptionen = useMemo(() => ({ autoResetExpanded: false, getRowId: (r: Zeile<V>) => r.id }), []);

  return (
    <div className="portal-section">
      <div className="portal-row" style={{ marginBottom: '0.5rem', display: kompakt ? 'none' : undefined }}>
<Varianten repid="tco.mitglieder.vertraege" ansicht={{ suche, alle }} onAnwenden={(a) => { setSuche(feld(a, 'suche', suche)); setAlle(feld(a, 'alle', alle)); }} />
        <Input value={suche} placeholder="Person, Vertrag oder Zahler suchen" showClearIcon style={{ width: 'min(22rem, 100%)' }} onInput={(e) => setSuche(e.target.value)} />
        <CheckBox text="Auch beendete" checked={alle} onChange={(e) => setAlle(e.target.checked)} />
        <span className="portal-muted">
          {personen.length === 1 ? '1 Person' : `${personen.length} Personen`} · {laufende.length === 1 ? '1 laufender Vertrag' : `${laufende.length} laufende Verträge`} · {eur(summe)}
        </span>
        <div style={{ flex: 1 }} />
        {aktionen}
        <Button icon="expand-all" design="Transparent" tooltip="Alles aufklappen" onClick={() => tabelle.current?.toggleAllRowsExpanded?.(true)} />
        <Button icon="collapse-all" design="Transparent" tooltip="Alles zuklappen" onClick={() => tabelle.current?.toggleAllRowsExpanded?.(false)} />
      </div>
      <AnalyticalTable minRows={1} columns={columns} data={baum} isTreeTable tableInstance={tabelle as never} reactTableOptions={tabellenOptionen}
                       visibleRows={Math.max(anzahlZeilen(baum), 1)} noDataText={such ? 'Keine Person und kein Vertrag zu dieser Suche' : 'Keine Verträge'} />
    </div>
  );
}
