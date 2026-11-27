import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, CheckBox, Dialog, FlexBox, Input, Label, Link, Option, Select, Text, Title } from '@ui5/webcomponents-react';
import { FussLeiste } from './DialogFuss';
import type { AnalyticalTableColumnDefinition } from '@ui5/webcomponents-react';
import {
  LEERER_STAND, ausTabelle, filterText, gleich, sichtbareSpalten, spalteSetzen, spaltenId, spaltenText, standLesen, tabellenAenderung, type TabellenStand,
} from './tabellenAnsicht';

export { LEERER_STAND, standLesen, type TabellenStand } from './tabellenAnsicht';

/**
 * Tabellen anpassen: Spalten ein-/ausblenden, Spaltenfilter setzen und Sortierung – der Stand gehört der Seite
 * (`stand`/`onStand`) und wandert dort in die Ansichtsvariante (Feld `spalten` in `ansicht`, siehe Varianten.tsx).
 *
 * Verwendung:
 *   const t = useTabellenAnsicht({ spalten: columns, stand, onStand: setStand, aktiv: can('…:edit'), pflicht: ['auftragsnr'] });
 *   <AnalyticalTable columns={t.spalten} {...t.tabelle} reactTableOptions={{ ...optionen, ...t.optionen }} />
 *   t.knopf (Button für die Symbolleiste), t.leiste (Zeile „Filter: …  Filter entfernen“)
 *
 * aktiv = false: Tabelle wie bisher (alle Spalten; Filter/Sortierung im Spaltenkopf nur, wo die Seite sie selbst einschaltet), kein Knopf, keine Leiste.
 */
export function useTabellenAnsicht({ spalten, stand, onStand, aktiv, pflicht = [], titel = 'Tabelle anpassen' }: {
  spalten: AnalyticalTableColumnDefinition[];
  stand: TabellenStand;
  onStand: (s: TabellenStand) => void;
  aktiv: boolean;
  /** Spalten, die sich nicht ausblenden lassen (Ids) */
  pflicht?: string[];
  titel?: string;
}) {
  const ref = useRef<Record<string, any> | null>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [dialog, setDialog] = useState(false);
  const ids = useMemo(() => spalten.map(spaltenId).filter(Boolean), [spalten]);
  const aktuell = useRef(stand);
  aktuell.current = stand;
  const melden = useRef(onStand);
  melden.current = onStand;

  // Stand aus einer Variante bereinigen (unbekannte Spalten, Filter auf ausgeblendeten Spalten …)
  useEffect(() => {
    if (!aktiv) return;
    const sauber = standLesen(stand, ids, pflicht);
    if (!gleich(sauber, stand)) melden.current(sauber);
  }, [stand, ids, aktiv]); // eslint-disable-line react-hooks/exhaustive-deps

  const sichtbar = useMemo(() => (aktiv ? sichtbareSpalten(spalten, stand, pflicht) : spalten), [spalten, stand, aktiv]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stand → Tabelle (Variante geladen, im Dialog geändert)
  useEffect(() => {
    const t = ref.current;
    if (!aktiv || !t?.setAllFilters || !t.state) return;
    const ist = ausTabelle(stand, t.state.filters, t.state.sortBy);
    if (JSON.stringify(ist.filter) !== JSON.stringify(stand.filter)) t.setAllFilters(stand.filter.map((f) => ({ ...f })));
    if (JSON.stringify(ist.sortierung) !== JSON.stringify(stand.sortierung) && t.setSortBy) t.setSortBy(stand.sortierung.map((s) => ({ ...s })));
  }, [stand, aktiv, sichtbar]);

  // Tabelle → Stand (Filter oder Sortierung im Spaltenkopf geändert). Maßgeblich ist ein Plugin der Tabelle (tableHooks): Es sieht
  // bei jedem Zeichnen den aktuellen Zustand. onSort/onFilter kommen, bevor die Tabelle ihren Zustand aktualisiert – darauf allein
  // ist kein Verlass (die Sortierung fehlte so in gespeicherten Varianten).
  const aktivRef = useRef(aktiv);
  aktivRef.current = aktiv;
  const zuletzt = useRef<{ filters?: unknown; sortBy?: unknown } | null>(null);
  const mitlesen = useRef(Object.assign((hooks: { useInstance: ((i: { state?: Record<string, unknown> }) => void)[] }) => {
    hooks.useInstance.push((instanz) => {
      const st = instanz.state ?? {};
      const neu = { filters: st.filters, sortBy: st.sortBy };
      const geaendert = tabellenAenderung(neu, zuletzt.current);
      zuletzt.current = neu;
      if (!geaendert || !aktivRef.current) return;
      // nicht während des Zeichnens der Tabelle melden (setState in fremdem Render), sondern direkt danach
      setTimeout(() => {
        const s = ausTabelle(aktuell.current, neu.filters, neu.sortBy);
        if (!gleich(s, aktuell.current)) melden.current(s);
      }, 0);
    });
  }, { pluginName: 'tabellenAnsichtMitlesen' })).current;
  const tabellenHooks = useRef([mitlesen]).current;
  const nachlesen = () => setTimeout(() => {
    const t = ref.current;
    if (!aktiv || !t?.state) return;
    const neu = ausTabelle(aktuell.current, t.state.filters, t.state.sortBy);
    if (!gleich(neu, aktuell.current)) melden.current(neu);
  }, 0);

  const knopf: ReactNode = aktiv ? (
    <>
      <Button design="Transparent" icon="action-settings" tooltip={`${titel}: Spalten ein-/ausblenden, Filter und Sortierung – mit der Variante speichern`}
              accessibleName={titel} onClick={() => setDialog(true)}>
        {stand.aus.length || stand.filter.length ? `Spalten (${stand.aus.length ? `${stand.aus.length} aus` : ''}${stand.aus.length && stand.filter.length ? ', ' : ''}${stand.filter.length ? `${stand.filter.length} Filter` : ''})` : 'Spalten'}
      </Button>
      {dialog && <AnpassenDialog titel={titel} spalten={spalten} stand={stand} pflicht={pflicht} onStand={(s) => melden.current(s)} onClose={() => setDialog(false)} />}
    </>
  ) : null;

  const leiste: ReactNode = aktiv && stand.filter.length ? (
    <div className="portal-muted" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', padding: '0.25rem 0' }}>
      <Text>Filter: {filterText(stand, spalten)}</Text>
      <Link onClick={() => melden.current({ ...stand, filter: [] })}>Filter entfernen</Link>
    </div>
  ) : null;

  return {
    spalten: sichtbar,
    /** Eigenschaften für die AnalyticalTable */
    tabelle: { tableInstance: ref as never, tableHooks: tabellenHooks as never[], onFilter: nachlesen, onSort: nachlesen, ...(aktiv ? { filterable: true, sortable: true } : {}) },
    /** in reactTableOptions übernehmen: Filter und Sortierung bleiben beim Neuladen der Daten stehen */
    optionen: { autoResetFilters: false, autoResetSortBy: false, autoResetGlobalFilter: false },
    knopf,
    leiste,
    /** Tabelleninstanz (z. B. toggleAllRowsExpanded im Baum) */
    ref,
  };
}

function AnpassenDialog({ titel, spalten, stand, pflicht, onStand, onClose }: {
  titel: string; spalten: AnalyticalTableColumnDefinition[]; stand: TabellenStand; pflicht: string[]; onStand: (s: TabellenStand) => void; onClose: () => void;
}) {
  const liste = spalten.map((c) => ({ id: spaltenId(c), text: spaltenText(c), filterbar: !(c as { disableFilters?: boolean }).disableFilters })).filter((c) => c.id);
  const [neuSpalte, setNeuSpalte] = useState('');
  const [neuWert, setNeuWert] = useState('');
  const sichtbar = (id: string) => !stand.aus.includes(id);
  const filterbar = liste.filter((c) => c.filterbar && sichtbar(c.id) && !stand.filter.some((f) => f.id === c.id));
  const spalteNeu = neuSpalte && filterbar.some((c) => c.id === neuSpalte) ? neuSpalte : filterbar[0]?.id ?? '';
  const filterSetzen = (id: string, value: string) => {
    const ohne = stand.filter.filter((f) => f.id !== id);
    onStand({ ...stand, filter: value.trim() ? [...ohne, { id, value }] : ohne });
  };
  const text = (id: string) => liste.find((c) => c.id === id)?.text ?? id;
  return (
    <Dialog open headerText={titel} style={{ width: 'min(34rem, 96vw)' }} onClose={onClose}
            footer={<FussLeiste startContent={<Button design="Transparent" icon="reset" onClick={() => onStand({ ...LEERER_STAND })}>Zurücksetzen</Button>}
                         endContent={<Button design="Emphasized" onClick={onClose}>Schließen</Button>} />}>
      <FlexBox direction="Column" style={{ gap: '1rem' }}>
        <section aria-label="Spalten">
          <FlexBox alignItems="Center" justifyContent="SpaceBetween">
            <Title level="H6">Spalten</Title>
            <Link onClick={() => onStand({ ...stand, aus: [] })}>Alle einblenden</Link>
          </FlexBox>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(13rem, 1fr))' }}>
            {liste.map((c) => (
              <CheckBox key={c.id} text={c.text} checked={sichtbar(c.id) || pflicht.includes(c.id)} disabled={pflicht.includes(c.id)}
                        onChange={(e) => onStand(spalteSetzen(stand, c.id, e.target.checked))} />
            ))}
          </div>
        </section>
        <section aria-label="Filter">
          <Title level="H6">Filter</Title>
          {!stand.filter.length && <Text className="portal-muted">Kein Filter gesetzt. Filter lassen sich auch im Spaltenkopf eingeben.</Text>}
          {stand.filter.map((f) => (
            <FlexBox key={f.id} alignItems="Center" style={{ gap: '0.5rem', marginTop: '0.25rem' }}>
              <Label style={{ width: '10rem' }} showColon>{text(f.id)}</Label>
              <Input style={{ flex: 1 }} value={f.value} accessibleName={`Filter ${text(f.id)}`} onInput={(e) => filterSetzen(f.id, e.target.value)} />
              <Button design="Transparent" icon="decline" tooltip="Filter entfernen" accessibleName={`Filter ${text(f.id)} entfernen`} onClick={() => filterSetzen(f.id, '')} />
            </FlexBox>
          ))}
          {filterbar.length > 0 && (
            <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
              <Select style={{ width: '10rem' }} accessibleName="Spalte für neuen Filter" onChange={(e) => setNeuSpalte((e.detail.selectedOption as HTMLElement).dataset.id ?? '')}>
                {filterbar.map((c) => <Option key={c.id} data-id={c.id} selected={c.id === spalteNeu}>{c.text}</Option>)}
              </Select>
              <Input style={{ flex: 1, minWidth: '8rem' }} placeholder="enthält …" value={neuWert} accessibleName="Filterwert"
                     onInput={(e) => setNeuWert(e.target.value)} />
              <Button icon="add-filter" disabled={!neuWert.trim() || !spalteNeu} onClick={() => { filterSetzen(spalteNeu, neuWert); setNeuWert(''); }}>Filter setzen</Button>
            </FlexBox>
          )}
        </section>
        <section aria-label="Sortierung">
          <FlexBox alignItems="Center" justifyContent="SpaceBetween">
            <Title level="H6">Sortierung</Title>
            {stand.sortierung.length > 0 && <Link onClick={() => onStand({ ...stand, sortierung: [] })}>Sortierung aufheben</Link>}
          </FlexBox>
          <Text className="portal-muted">
            {stand.sortierung.length ? stand.sortierung.map((s) => `${text(s.id)} ${s.desc ? 'absteigend' : 'aufsteigend'}`).join(', ') : 'Wie geliefert – Sortieren über den Spaltenkopf.'}
          </Text>
        </section>
        <Text className="portal-muted">Gespeichert wird das mit der Ansichtsvariante (Diskette oben rechts).</Text>
      </FlexBox>
    </Dialog>
  );
}
