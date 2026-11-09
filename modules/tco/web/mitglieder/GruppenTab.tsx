import { useEffect, useMemo, useState } from 'react';
import { BusyIndicator, CheckBox, Input, MessageStrip, Text, Title, Toolbar, ToolbarSpacer } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { Empty } from '@core/components/Section';
import { GR, type GruppenDaten } from '../gruppen/typen';
import { MG, type Detail } from './typen';

/**
 * Reiter „Gruppen“ im Mitgliedsstamm: der Baum der Mitgliedergruppen mit Ankreuzfeld je Gruppe.
 * Ein Mitglied kann mehreren Gruppen angehören; je Zuordnung ist eine Rolle möglich (z. B. Mannschaftsführer).
 */
export function GruppenTab({ d, edit, onAktion }: { d: Detail; edit: boolean; onAktion: (fn: () => Promise<{ text?: string } | void>) => void }) {
  const [daten, setDaten] = useState<GruppenDaten | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { api.get<GruppenDaten>(GR).then(setDaten).catch((e) => setFehler(e.message)); }, [d]);
  const adrnr = d.mitglied.adrnr;
  const zugeordnet = useMemo(() => new Map(d.gruppen.map((g) => [g.id, g.rolle])), [d.gruppen]);
  // Gruppen, zu denen das Mitglied über eine Untergruppe gehört
  const ueber = useMemo(() => {
    const s = new Set<number>();
    const je = new Map((daten?.gruppen ?? []).map((g) => [g.id, g]));
    for (const id of zugeordnet.keys()) {
      for (let p = je.get(id)?.parent_id ?? null, n = 0; p != null && n < 50; p = je.get(p)?.parent_id ?? null, n++) s.add(p);
    }
    return s;
  }, [daten, zugeordnet]);

  if (fehler) return <MessageStrip design="Negative" hideCloseButton>{fehler}</MessageStrip>;
  if (!daten) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  // inaktive Gruppen nur zeigen, wenn das Mitglied (oder eine Untergruppe) noch zugeordnet ist
  const zeilen = daten.gruppen.filter((g) => g.aktiv || zugeordnet.has(g.id) || ueber.has(g.id));
  const setzen = (gruppe: number, body: object) => onAktion(() => api.post(`${MG}/m/${adrnr}/gruppen`, { gruppe, ...body }));
  return (
    <>
      <Toolbar design="Transparent">
        <Title level="H5">Gruppen ({zugeordnet.size})</Title>
        <ToolbarSpacer />
      </Toolbar>
      {!zeilen.length && <Empty>Es sind noch keine Mitgliedergruppen angelegt (Mitglieder → Mitgliedergruppen).</Empty>}
      {zeilen.map((g) => {
        const drin = zugeordnet.has(g.id);
        return (
          <div key={g.id} className="portal-row" style={{ paddingLeft: `${g.ebene * 1.75}rem`, minHeight: '2.75rem', borderBottom: '1px solid var(--sapList_BorderColor)', flexWrap: 'nowrap' }}>
            <CheckBox text={g.name} checked={drin} disabled={!edit}
                      onChange={(e) => setzen(g.id, e.target.checked ? {} : { entfernen: true })} />
            {!g.aktiv && <span className="portal-muted portal-small">inaktiv</span>}
            {!drin && ueber.has(g.id) && <span className="portal-muted portal-small">über Untergruppe</span>}
            <div style={{ flex: 1 }} />
            {drin && (edit
              ? <Input value={zugeordnet.get(g.id) ?? ''} placeholder="Rolle, z. B. Mannschaftsführer" maxlength={60} style={{ width: 'min(16rem, 45%)' }}
                       onChange={(e) => { const v = e.target.value.trim(); if (v !== (zugeordnet.get(g.id) ?? '')) setzen(g.id, { rolle: v }); }} />
              : <Text>{zugeordnet.get(g.id) ?? ''}</Text>)}
          </div>
        );
      })}
      {zeilen.length > 0 && (
        <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
          Ein Mitglied kann mehreren Gruppen angehören. Wer in einer Untergruppe ist, zählt auch zu den Gruppen darüber
          (z. B. im Vereinskalender und im Filter der Mitgliederliste).
        </MessageStrip>
      )}
    </>
  );
}
