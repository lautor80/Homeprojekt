import { useEffect, useMemo, useState } from 'react';
import { BusyIndicator, CheckBox, Input, MessageStrip, Text, Title, Toolbar, ToolbarSpacer } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { Empty } from '@core/components/Section';
import { GR, type Gruppe, type GruppenDaten } from '../gruppen/typen';
import { MG, type Detail } from './typen';

export type BaumGruppe = Pick<Gruppe, 'id' | 'parent_id' | 'name' | 'ebene' | 'aktiv'>;

/**
 * Baum der Mitgliedergruppen mit Ankreuzfeld je Gruppe – im Mitgliedsstamm (Reiter „Gruppen“) und in „Meine Mitgliedschaft“.
 * Ein Mitglied kann mehreren parallelen Gruppen angehören. Gruppen, zu denen es über eine Untergruppe gehört (der Weg nach
 * oben), sind angekreuzt und gesperrt: Entlang einer Linie wird es nur in der untersten Gruppe geführt.
 */
export function GruppenAuswahl({ baum, zugeordnet: liste, edit, rolleAenderbar, setzen, leer }: {
  /** alle Gruppen in Baumreihenfolge */
  baum: BaumGruppe[];
  /** direkte Zuordnungen */
  zugeordnet: { id: number; rolle: string | null }[];
  edit: boolean;
  /** Rolle je Zuordnung änderbar (sonst nur Anzeige) */
  rolleAenderbar: boolean;
  setzen: (gruppe: number, body: { entfernen?: boolean; rolle?: string }) => void;
  leer: string;
}) {
  const zugeordnet = useMemo(() => new Map(liste.map((g) => [g.id, g.rolle])), [liste]);
  // Gruppen, zu denen das Mitglied über eine Untergruppe gehört
  const ueber = useMemo(() => {
    const s = new Set<number>();
    const je = new Map(baum.map((g) => [g.id, g]));
    for (const id of zugeordnet.keys()) {
      for (let p = je.get(id)?.parent_id ?? null, n = 0; p != null && n < 50; p = je.get(p)?.parent_id ?? null, n++) s.add(p);
    }
    return s;
  }, [baum, zugeordnet]);
  // inaktive Gruppen nur zeigen, wenn das Mitglied (oder eine Untergruppe) noch zugeordnet ist
  const zeilen = baum.filter((g) => g.aktiv || zugeordnet.has(g.id) || ueber.has(g.id));
  return (
    <>
      {!zeilen.length && <Empty>{leer}</Empty>}
      {zeilen.map((g) => {
        const drin = zugeordnet.has(g.id);
        const geerbt = !drin && ueber.has(g.id);
        const rolle = zugeordnet.get(g.id) ?? '';
        return (
          <div key={g.id} className="portal-row" style={{ paddingLeft: `${g.ebene * 1.75}rem`, minHeight: '2.75rem', borderBottom: '1px solid var(--sapList_BorderColor)', flexWrap: 'nowrap' }}>
            <CheckBox text={g.name} checked={drin || geerbt} disabled={!edit || geerbt || (!g.aktiv && !drin)}
                      onChange={(e) => setzen(g.id, e.target.checked ? {} : { entfernen: true })} />
            {!g.aktiv && <span className="portal-muted portal-small">inaktiv</span>}
            {geerbt && <span className="portal-muted portal-small">über Untergruppe</span>}
            <div style={{ flex: 1 }} />
            {drin && (edit && rolleAenderbar
              ? <Input value={rolle} placeholder="Rolle, z. B. Mannschaftsführer" maxlength={60} style={{ width: 'min(16rem, 45%)' }}
                       onChange={(e) => { const v = e.target.value.trim(); if (v !== rolle) setzen(g.id, { rolle: v }); }} />
              : <Text>{rolle}</Text>)}
          </div>
        );
      })}
    </>
  );
}

/** Reiter „Gruppen“ im Mitgliedsstamm */
export function GruppenTab({ d, edit, onAktion }: { d: Detail; edit: boolean; onAktion: (fn: () => Promise<{ text?: string } | void>) => void }) {
  const [daten, setDaten] = useState<GruppenDaten | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { api.get<GruppenDaten>(GR).then(setDaten).catch((e) => setFehler(e.message)); }, [d]);
  const adrnr = d.mitglied.adrnr;

  if (fehler) return <MessageStrip design="Negative" hideCloseButton>{fehler}</MessageStrip>;
  if (!daten) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Gruppen ({d.gruppen.length})</Title>
        <ToolbarSpacer />
      </Toolbar>
      <GruppenAuswahl baum={daten.gruppen} zugeordnet={d.gruppen} edit={edit} rolleAenderbar
                      leer="Es sind noch keine Mitgliedergruppen angelegt (Mitglieder → Mitgliedergruppen)."
                      setzen={(gruppe, body) => onAktion(() => api.post(`${MG}/m/${adrnr}/gruppen`, { gruppe, ...body }))} />
      {daten.gruppen.length > 0 && (
        <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
          Ein Mitglied kann mehreren parallelen Gruppen angehören. Wer in einer Untergruppe ist, gehört zwingend auch zu den
          Gruppen darüber und wird dort nicht noch einmal aufgenommen – beim Ankreuzen einer Untergruppe entfällt deshalb
          eine direkte Zuordnung zur Gruppe darüber.
        </MessageStrip>
      )}
    </>
  );
}
