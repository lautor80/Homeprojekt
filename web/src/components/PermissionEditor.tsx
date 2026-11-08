import { useMemo, useState } from 'react';
import { Button, CheckBox, Input, Switch } from '@ui5/webcomponents-react';

/** Katalog wie GET /api/admin/permissions (server/src/permissions.ts → PermissionGroup) */
export interface PermDef { id: string; text: string; requires: string[] }
export interface PermApp { name: string; permissions: PermDef[] }
export interface PermArea { name: string; apps: PermApp[] }
export interface PermGroup { module: string; name: string; permissions: { id: string; text: string }[]; areas: PermArea[] }

interface Props {
  catalog: PermGroup[];
  value: string[];
  onChange: (v: string[]) => void;
  readonly?: boolean;
}

const zaehlen = (ids: string[], gesetzt: Set<string>) => ids.filter((i) => gesetzt.has(i)).length;

/**
 * Berechtigungen einer Rolle, gegliedert wie die Navigation: Modul → Menübereich → App → Aktivität.
 * - „Alle/Keine“ je Modul, Bereich und App
 * - Abhängigkeiten werden automatisch aufgelöst: Anhaken setzt die Voraussetzungen mit
 *   (z. B. „bearbeiten“ → „anzeigen“), Abwählen entfernt alles, was darauf aufbaut.
 */
export function PermissionEditor({ catalog, value, onChange, readonly }: Props) {
  const [suche, setSuche] = useState('');
  const [nurGesetzt, setNurGesetzt] = useState(false);
  const gesetzt = useMemo(() => new Set<string>(value), [value]);

  // Voraussetzungen und Umkehrung (wer baut auf mir auf?)
  const { benoetigt, abhaengige, texte } = useMemo(() => {
    const benoetigt = new Map<string, string[]>();
    const abhaengige = new Map<string, string[]>();
    const texte = new Map<string, string>();
    for (const g of catalog) for (const a of g.areas) for (const app of a.apps) for (const p of app.permissions) {
      benoetigt.set(p.id, p.requires);
      texte.set(p.id, `${app.name}: ${p.text}`);
      for (const r of p.requires) abhaengige.set(r, [...(abhaengige.get(r) ?? []), p.id]);
    }
    return { benoetigt, abhaengige, texte };
  }, [catalog]);

  /** Hülle über eine Beziehung (transitiv) */
  const huelle = (start: string[], rel: Map<string, string[]>) => {
    const out = new Set<string>();
    const stapel = [...start];
    while (stapel.length) {
      const id = stapel.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      stapel.push(...(rel.get(id) ?? []));
    }
    return out;
  };

  const setzen = (ids: string[], an: boolean) => {
    if (readonly) return;
    const neu = new Set<string>(gesetzt);
    if (an) for (const i of huelle(ids, benoetigt)) neu.add(i);
    else for (const i of huelle(ids, abhaengige)) neu.delete(i);
    onChange([...neu].sort());
  };

  const passt = (app: PermApp, p: PermDef, bereich: string, modul: string) => {
    if (nurGesetzt && !gesetzt.has(p.id)) return false;
    if (!suche.trim()) return true;
    const s = suche.trim().toLowerCase();
    return [p.text, p.id, app.name, bereich, modul].some((t) => t.toLowerCase().includes(s));
  };

  const alleIds = catalog.flatMap((g) => g.areas.flatMap((a) => a.apps.flatMap((app) => app.permissions.map((p) => p.id))));

  const alleKeine = (ids: string[]) => readonly ? null : (
    <span className="portal-perm__bulk">
      <Button design="Transparent" disabled={zaehlen(ids, gesetzt) === ids.length} onClick={() => setzen(ids, true)}>Alle</Button>
      <Button design="Transparent" disabled={zaehlen(ids, gesetzt) === 0} onClick={() => setzen(ids, false)}>Keine</Button>
    </span>
  );

  const zaehler = (ids: string[]) => {
    const n = zaehlen(ids, gesetzt);
    return <span className={`portal-perm__count${n ? ' portal-perm__count--on' : ''}`}>{n} / {ids.length}</span>;
  };

  return (
    <div className="portal-perm">
      <div className="portal-perm__toolbar">
        <Input placeholder="Berechtigung, App oder Bereich suchen" value={suche} showClearIcon style={{ width: 'min(22rem, 100%)' }}
               onInput={(e) => setSuche(e.target.value)} />
        <label className="portal-row portal-small portal-muted">
          <Switch checked={nurGesetzt} onChange={(e) => setNurGesetzt(e.target.checked)} /> nur zugeordnete
        </label>
        <span style={{ marginLeft: 'auto' }} className="portal-row">
          <span className="portal-muted portal-small">Gesamt</span> {zaehler(alleIds)}
        </span>
      </div>

      {catalog.map((g) => {
        const modulIds = g.areas.flatMap((a) => a.apps.flatMap((app) => app.permissions.map((p) => p.id)));
        const bereiche = g.areas
          .map((a) => ({ ...a, apps: a.apps.map((app) => ({ ...app, sichtbar: app.permissions.filter((p) => passt(app, p, a.name, g.name)) })).filter((app) => app.sichtbar.length) }))
          .filter((a) => a.apps.length);
        if (!bereiche.length) return null;
        return (
          <section key={g.module} className="portal-section portal-perm__module">
            <div className="portal-section__head">
              <h3 className="portal-section__title">{g.name}</h3>
              {zaehler(modulIds)}
              <div className="portal-section__actions">{alleKeine(modulIds)}</div>
            </div>
            {bereiche.map((a) => {
              const bereichIds = a.apps.flatMap((app) => app.permissions.map((p) => p.id));
              const einBereich = g.areas.length === 1 && a.name === g.name;
              return (
                <div key={a.name} className="portal-perm__area">
                  {!einBereich && (
                    <div className="portal-perm__area-head">
                      <span className="portal-perm__area-title">{a.name}</span>
                      {zaehler(bereichIds)}
                      {alleKeine(bereichIds)}
                    </div>
                  )}
                  {a.apps.map((app) => {
                    const appIds = app.permissions.map((p) => p.id);
                    const n = zaehlen(appIds, gesetzt);
                    return (
                      <div key={app.name} className={`portal-perm__app${n ? ' portal-perm__app--on' : ''}`}>
                        <div className="portal-perm__app-name">
                          <CheckBox text={app.name} readonly={readonly}
                                    checked={n === appIds.length} indeterminate={n > 0 && n < appIds.length}
                                    onChange={() => setzen(appIds, n < appIds.length)} />
                        </div>
                        <div className="portal-perm__acts">
                          {app.sichtbar.map((p) => (
                            <CheckBox key={p.id} text={p.text} readonly={readonly} wrappingType="Normal"
                                      title={[p.id, ...p.requires.map((r) => `setzt voraus: ${texte.get(r) ?? r}`)].join('\n')}
                                      checked={gesetzt.has(p.id)} onChange={(e) => setzen([p.id], e.target.checked)} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
