import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Button, CheckBox, Icon, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Select, Text } from '@ui5/webcomponents-react';
import { api } from '../api';
import { toast } from '../toast';
import type { PermGroup } from '../components/PermissionEditor';
import './rollenmatrix.css';

/**
 * Rollenpflege als Matrix mit Prüfungen (#46): Zeilen = Berechtigungen (Modul → Bereich → App), Spalten = Rollen.
 * Änderungen mehrerer Rollen werden gesammelt und in einem Schritt gesichert. Die Prüfung läuft auf dem Server –
 * auch auf dem noch nicht gesicherten Stand – und meldet Überlappungen, überflüssige Zuordnungen, Funktionstrennung,
 * fehlende Voraussetzungen und unbekannte Rechte. Ein Klick auf einen Befund stellt die betroffenen Rollen nebeneinander.
 */
export interface MatrixRolle { id: string; name: string; description: string | null; system: boolean; nurAdmin?: boolean; permissions: string[]; userCount: number }
interface Befund { art: string; artText: string; stufe: 'FEHLER' | 'WARNUNG' | 'HINWEIS'; text: string; rollen: string[]; rechte: string[]; benutzer?: string[] }
interface Pruefung { befunde: Befund[]; fehler: number; warnungen: number; hinweise: number }
export type MatrixAnsicht = 'MATRIX' | 'PRUEFUNG' | 'VERPROBUNG';
interface Verprobung {
  id: string; name: string; username: string; aktiv: boolean; rollenJetzt: string[]; rollenProbe: string[];
  allesJetzt: boolean; allesProbe: boolean; anzahlJetzt: number; anzahlProbe: number;
  rechte: { id: string; text: string; app: string; rollen: string[] }[]; dazu: string[]; weg: string[]; apps: string[];
  befunde: { stufe: Befund['stufe']; text: string }[];
}
interface Benutzer { id: string; username: string; displayName: string; active: boolean; roles: string[] }
const STUFE = { FEHLER: { state: 'Negative', text: 'Fehler' }, WARNUNG: { state: 'Critical', text: 'Warnung' }, HINWEIS: { state: 'Information', text: 'Hinweis' } } as const;

export function RollenMatrix({ ansicht, onAnsicht, roles, catalog, darfAendern, istAdmin, darfBenutzer, onGesichert }: {
  ansicht: MatrixAnsicht; onAnsicht: (a: MatrixAnsicht) => void;
  roles: MatrixRolle[]; catalog: PermGroup[]; darfAendern: boolean; istAdmin: boolean;
  /** „Benutzer anzeigen“ – Voraussetzung für die Verprobung */
  darfBenutzer: boolean; onGesichert: () => void;
}) {
  // ADMIN (alle Rechte) steht nicht in der Matrix
  const rollen = useMemo(() => roles.filter((r) => !r.permissions.includes('*')), [roles]);
  /** geänderte Rollen: noch nicht gesicherter Stand */
  const [entwurf, setEntwurf] = useState<Record<string, string[]>>({});
  const [auswahl, setAuswahl] = useState<string[]>([]);
  const [suche, setSuche] = useState('');
  const [nurVergeben, setNurVergeben] = useState(false);
  const [nurUnterschiede, setNurUnterschiede] = useState(false);
  const [fokus, setFokus] = useState<Befund | null>(null);
  const [pruefung, setPruefung] = useState<Pruefung | null>(null);
  const [nurStufe, setNurStufe] = useState<Befund['stufe'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stand = (r: MatrixRolle) => entwurf[r.id] ?? r.permissions;
  const mengen = useMemo(() => new Map(rollen.map((r) => [r.id, new Set(entwurf[r.id] ?? r.permissions)])), [rollen, entwurf]);
  const original = useMemo(() => new Map(rollen.map((r) => [r.id, new Set(r.permissions)])), [rollen]);
  const aenderbar = (r: MatrixRolle) => darfAendern && !r.system && (!r.nurAdmin || istAdmin);
  const geaendert = Object.keys(entwurf).filter((id) => rollen.some((r) => r.id === id));

  // Voraussetzungen und Umkehrung wie im Rollendialog
  const { benoetigt, abhaengige, texte } = useMemo(() => {
    const texte = new Map<string, string>();
    const benoetigt = new Map<string, string[]>();
    const abhaengige = new Map<string, string[]>();
    for (const g of catalog) for (const a of g.areas) for (const app of a.apps) for (const p of app.permissions) {
      benoetigt.set(p.id, p.requires);
      texte.set(p.id, `${app.name}: ${p.text}`);
      for (const v of p.requires) abhaengige.set(v, [...(abhaengige.get(v) ?? []), p.id]);
    }
    return { benoetigt, abhaengige, texte };
  }, [catalog]);
  const huelle = (start: string, rel: Map<string, string[]>) => {
    const out = new Set<string>();
    const stapel = [start];
    while (stapel.length) { const id = stapel.pop()!; if (!out.has(id)) { out.add(id); stapel.push(...(rel.get(id) ?? [])); } }
    return out;
  };

  function setzen(r: MatrixRolle, recht: string, an: boolean) {
    const neu = new Set(stand(r));
    if (an) for (const i of huelle(recht, benoetigt)) neu.add(i);
    else for (const i of huelle(recht, abhaengige)) neu.delete(i);
    const liste = [...neu].sort();
    setEntwurf((e) => {
      const x = { ...e };
      // zurück auf dem gesicherten Stand → keine Änderung mehr
      if (liste.join('|') === [...r.permissions].sort().join('|')) delete x[r.id]; else x[r.id] = liste;
      return x;
    });
  }

  // Prüfung nach jeder Änderung (kurz verzögert); veraltete Antworten verwerfen
  const lauf = useRef(0);
  useEffect(() => {
    const nr = ++lauf.current;
    const t = setTimeout(() => {
      api.post<Pruefung>('/api/admin/roles/pruefung', { rollen: Object.entries(entwurf).map(([id, permissions]) => ({ id, permissions })) })
        .then((p) => { if (nr === lauf.current) setPruefung(p); }).catch((e) => { if (nr === lauf.current) setError(e.message); });
    }, 400);
    return () => clearTimeout(t);
  }, [entwurf, roles]);

  async function sichern() {
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ text: string }>('/api/admin/roles/matrix', {
        rollen: geaendert.map((id) => ({ id, vorher: rollen.find((x) => x.id === id)?.permissions ?? [], permissions: entwurf[id] })),
      });
      toast(r.text, 5000);
      setEntwurf({});
      onGesichert();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  // sichtbare Spalten: Vergleich aus einem Befund, sonst die Auswahl, sonst alle
  const spalten = fokus && fokus.rollen.length ? rollen.filter((r) => fokus.rollen.includes(r.id))
    : auswahl.length ? rollen.filter((r) => auswahl.includes(r.id)) : rollen;
  const hervor = new Set(fokus?.rechte ?? []);
  const begriffe = suche.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const zeigen = (id: string, texte: string[]) => {
    const hat = spalten.map((r) => mengen.get(r.id)!.has(id));
    if (nurVergeben && !hat.some(Boolean)) return false;
    if (nurUnterschiede && (hat.every(Boolean) || !hat.some(Boolean))) return false;
    return begriffe.every((b) => texte.some((t) => t.toLowerCase().includes(b)));
  };
  const befunde = (pruefung?.befunde ?? []).filter((b) => !nurStufe || b.stufe === nurStufe);
  const vergleichen = (b: Befund) => { setFokus(b); setNurUnterschiede(false); onAnsicht('MATRIX'); };

  const zaehler = pruefung && (
    <div className="portal-row" style={{ gap: '0.75rem' }}>
      {(['FEHLER', 'WARNUNG', 'HINWEIS'] as const).map((s) => {
        const n = s === 'FEHLER' ? pruefung.fehler : s === 'WARNUNG' ? pruefung.warnungen : pruefung.hinweise;
        return (
          <button key={s} type="button" className="portal-rm__zaehler" title={`${STUFE[s].text} anzeigen`}
                  onClick={() => { setNurStufe(nurStufe === s && ansicht === 'PRUEFUNG' ? null : s); onAnsicht('PRUEFUNG'); }}>
            <ObjectStatus state={n ? STUFE[s].state : 'None'} showDefaultIcon={!!n}>{n} {STUFE[s].text}{s !== 'FEHLER' && n !== 1 ? (s === 'WARNUNG' ? 'en' : 'e') : ''}</ObjectStatus>
          </button>
        );
      })}
      {geaendert.length > 0 && <Text className="portal-muted portal-small">Stand einschließlich der ungesicherten Änderungen</Text>}
    </div>
  );

  const leiste = (
    <div className="portal-row" style={{ gap: '0.75rem', marginBottom: '0.5rem', justifyContent: 'space-between' }}>
      {zaehler ?? <Text className="portal-muted">Prüfung läuft …</Text>}
      {darfAendern && (
        <div className="portal-row">
          {geaendert.length > 0 && <Text>{geaendert.length} Rolle{geaendert.length === 1 ? '' : 'n'} geändert: {geaendert.join(', ')}</Text>}
          <Button design="Emphasized" icon="save" disabled={!geaendert.length} loading={busy} onClick={sichern}>Sichern</Button>
          <Button design="Transparent" disabled={!geaendert.length || busy} onClick={() => setEntwurf({})}>Verwerfen</Button>
        </div>
      )}
    </div>
  );

  return (
    <div>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {leiste}

      {ansicht === 'PRUEFUNG' && (
        <>
          <div className="portal-row" style={{ marginBottom: '0.5rem' }}>
            <Text>{befunde.length} Befund{befunde.length === 1 ? '' : 'e'}{nurStufe ? ` (${STUFE[nurStufe].text})` : ''}</Text>
            {nurStufe && <Button design="Transparent" icon="clear-filter" onClick={() => setNurStufe(null)}>alle anzeigen</Button>}
            <Text className="portal-muted portal-small">Befunde verhindern das Sichern nicht. „Vergleichen“ stellt die betroffenen Rollen in der Matrix nebeneinander.</Text>
          </div>
          {!pruefung ? <Text>Prüfung läuft …</Text> : !befunde.length ? <MessageStrip design="Positive" hideCloseButton>Keine Befunde.</MessageStrip> : (
            <table className="portal-rm__befunde">
              <thead><tr>{['Stufe', 'Prüfung', 'Rollen', 'Befund', ''].map((h) => <th key={h}><Label>{h}</Label></th>)}</tr></thead>
              <tbody>{befunde.map((b, i) => (
                <tr key={i}>
                  <td><ObjectStatus state={STUFE[b.stufe].state} showDefaultIcon>{STUFE[b.stufe].text}</ObjectStatus></td>
                  <td>{b.artText}</td>
                  <td>{b.rollen.join(', ')}</td>
                  <td>{b.text}</td>
                  <td>{(b.rollen.length > 0 || b.rechte.length > 0) && <Button design="Transparent" icon="compare" onClick={() => vergleichen(b)}>{b.rollen.length ? 'Vergleichen' : 'Zeigen'}</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}

      {ansicht === 'VERPROBUNG' && (
        <Verproben rollen={rollen} alleRollen={roles} entwurf={entwurf} geaendert={geaendert} darfBenutzer={darfBenutzer} texte={texte}
                   onMatrix={(v) => vergleichen({ art: 'VERPROBUNG', artText: `Verprobung ${v.name}`, stufe: 'HINWEIS', rollen: v.rollenProbe, rechte: [...v.dazu, ...v.weg],
                     text: `Rollen in der Probe: ${v.rollenProbe.join(', ') || 'keine'}. Hervorgehoben sind die Rechte, die sich für ${v.name} ändern würden.` })} />
      )}

      {ansicht === 'MATRIX' && (
        <>
          {fokus && (
            <MessageStrip design={fokus.stufe === 'FEHLER' ? 'Negative' : fokus.stufe === 'WARNUNG' ? 'Critical' : 'Information'} hideCloseButton style={{ marginBottom: '0.5rem' }}>
              <b>{fokus.artText}:</b> {fokus.text}{' '}
              <Button design="Transparent" onClick={() => setFokus(null)}>Vergleich beenden</Button>
            </MessageStrip>
          )}
          <div className="portal-row" style={{ gap: '1rem', marginBottom: '0.5rem' }}>
            <Input data-kein-autofill icon={<Icon name="search" />} placeholder="Recht, App oder Bereich suchen" value={suche} showClearIcon style={{ width: '18rem' }}
                   onInput={(e) => setSuche(e.target.value)} />
            {!fokus && (
              <MultiComboBox data-kein-autofill placeholder="Rollen (leer = alle)" style={{ width: '22rem' }}
                             onSelectionChange={(e) => setAuswahl(e.detail.items.map((i) => (i as HTMLElement).dataset.r!))}>
                {rollen.map((r) => <MultiComboBoxItem key={r.id} data-r={r.id} text={r.id} additionalText={r.name} selected={auswahl.includes(r.id)} />)}
              </MultiComboBox>
            )}
            <CheckBox text="nur vergebene" checked={nurVergeben} onChange={(e) => setNurVergeben(e.target.checked)} />
            <CheckBox text="nur Unterschiede" checked={nurUnterschiede} onChange={(e) => setNurUnterschiede(e.target.checked)} />
            <Text className="portal-muted portal-small">{spalten.length} von {rollen.length} Rollen · ADMIN hat immer alle Rechte</Text>
          </div>
          <div className="portal-rm__rahmen">
            <table className="portal-rm">
              <thead>
                <tr>
                  <th className="portal-rm__ecke"><Label>Berechtigung</Label></th>
                  <th className="portal-rm__anz" title="In wie vielen Rollen steckt das Recht (alle Rollen, ohne ADMIN)"><Label>Rollen</Label></th>
                  {spalten.map((r) => (
                    <th key={r.id} className={`portal-rm__rolle${entwurf[r.id] ? ' portal-rm__rolle--neu' : ''}`}
                        title={`${r.name}${r.description ? `\n${r.description}` : ''}\n${r.userCount} Benutzer${aenderbar(r) ? '' : r.system ? '\nSystemrolle – nicht änderbar' : r.nurAdmin ? '\nnur durch Administratoren änderbar' : ''}`}>
                      <span className="portal-rm__rname">{r.id}</span>
                      {!aenderbar(r) && darfAendern && <Icon name="locked" style={{ width: '0.75rem', height: '0.75rem' }} />}
                      <span className="portal-rm__rzahl">{mengen.get(r.id)!.size} · {r.userCount} B.</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {catalog.map((g) => g.areas.map((a) => a.apps.map((app) => {
                  const zeilen = app.permissions.filter((p) => zeigen(p.id, [p.text, p.id, app.name, a.name, g.name]));
                  if (!zeilen.length) return null;
                  return (
                    <Fragment key={`${g.module}/${a.name}/${app.name}`}>
                      <tr className="portal-rm__gruppe"><td colSpan={2 + spalten.length}>{g.name} › {a.name} › <b>{app.name}</b></td></tr>
                      {zeilen.map((p) => {
                        const n = rollen.filter((r) => mengen.get(r.id)!.has(p.id)).length;
                        return (
                          <tr key={p.id} className={hervor.has(p.id) ? 'portal-rm__zeile--hervor' : undefined}>
                            <td className="portal-rm__recht" title={[p.id, ...p.requires.map((v) => `setzt voraus: ${v}`)].join('\n')}>{p.text}</td>
                            <td className="portal-rm__anz">{n || <span className="portal-muted">–</span>}</td>
                            {spalten.map((r) => {
                              const an = mengen.get(r.id)!.has(p.id);
                              const neu = an !== original.get(r.id)!.has(p.id);
                              const gesperrt = !aenderbar(r) || (!!r.nurAdmin && p.id.startsWith('core.'));
                              return (
                                <td key={r.id} className={`portal-rm__zelle${an ? ' portal-rm__zelle--an' : ''}${neu ? ' portal-rm__zelle--neu' : ''}`}>
                                  <input type="checkbox" checked={an} disabled={gesperrt} aria-label={`${r.id}: ${p.text}`}
                                         onChange={(e) => setzen(r, p.id, e.target.checked)} />
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })))}
                {/* Kennungen, die es im Katalog nicht (mehr) gibt – nur zum Entfernen */}
                {(() => {
                  const bekannt = new Set(benoetigt.keys());
                  const fremd = [...new Set(spalten.flatMap((r) => [...mengen.get(r.id)!].filter((p) => !bekannt.has(p))))].sort();
                  if (!fremd.length || begriffe.length) return null;
                  return (
                    <>
                      <tr className="portal-rm__gruppe"><td colSpan={2 + spalten.length}><b>Nicht im Katalog</b> (wirkungslos – bitte entfernen)</td></tr>
                      {fremd.map((id) => (
                        <tr key={id} className="portal-rm__zeile--hervor">
                          <td className="portal-rm__recht">{id}</td>
                          <td className="portal-rm__anz">{rollen.filter((r) => mengen.get(r.id)!.has(id)).length}</td>
                          {spalten.map((r) => (
                            <td key={r.id} className={`portal-rm__zelle${mengen.get(r.id)!.has(id) ? ' portal-rm__zelle--an' : ''}`}>
                              {mengen.get(r.id)!.has(id) && <input type="checkbox" checked disabled={!aenderbar(r)} aria-label={`${r.id}: ${id}`} onChange={() => setzen(r, id, false)} />}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </>
                  );
                })()}
              </tbody>
            </table>
          </div>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
            Ankreuzen setzt benötigte Rechte mit (z. B. „ändern“ → „anzeigen“), Entfernen nimmt abhängige Rechte mit heraus. Gelb = geändert, noch nicht gesichert. Bezeichnung, Deaktivierung und Benutzer einer Rolle pflegst du in der Liste.
          </Text>
        </>
      )}
    </div>
  );
}

/**
 * Verprobung (#46): Was dürften ausgewählte Benutzer mit dem Stand der Matrix (einschließlich ungesicherter Änderungen)
 * und optional probeweise zugeordneten Rollen – im Vergleich zu heute? Liest nur, gespeichert wird nichts.
 */
function Verproben({ rollen, alleRollen, entwurf, geaendert, darfBenutzer, texte, onMatrix }: {
  rollen: MatrixRolle[]; alleRollen: MatrixRolle[]; entwurf: Record<string, string[]>; geaendert: string[]; darfBenutzer: boolean;
  texte: Map<string, string>; onMatrix: (v: Verprobung) => void;
}) {
  const [benutzer, setBenutzer] = useState<Benutzer[] | null>(null);
  const [wahl, setWahl] = useState<string[]>([]);
  const [probeRollen, setProbeRollen] = useState<string[]>([]);
  const [modus, setModus] = useState<'ZUSAETZLICH' | 'ERSETZEN'>('ZUSAETZLICH');
  const [erg, setErg] = useState<Verprobung[] | null>(null);
  const [offen, setOffen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (darfBenutzer) api.get<Benutzer[]>('/api/admin/users').then(setBenutzer).catch((e) => setError(e.message)); }, [darfBenutzer]);

  const lauf = useRef(0);
  useEffect(() => {
    if (!wahl.length) { setErg(null); return; }
    const nr = ++lauf.current;
    const t = setTimeout(() => {
      api.post<Verprobung[]>('/api/admin/roles/verprobung', {
        benutzer: wahl, rollen: geaendert.map((id) => ({ id, permissions: entwurf[id] })),
        zuordnung: probeRollen.length || modus === 'ERSETZEN' ? { rollen: probeRollen, modus } : null,
      }).then((r) => { if (nr === lauf.current) { setErg(r); setError(null); } }).catch((e) => { if (nr === lauf.current) setError(e.message); });
    }, 300);
    return () => clearTimeout(t);
  }, [wahl, probeRollen, modus, entwurf]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!darfBenutzer) return <MessageStrip design="Information" hideCloseButton>Für die Verprobung wird zusätzlich die Berechtigung „Benutzer anzeigen“ benötigt.</MessageStrip>;
  const t = (p: string) => texte.get(p) ?? p;
  const umschalten = (id: string) => setOffen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const hinzu = (ids: string[]) => setWahl((w) => [...new Set([...w, ...ids])].slice(0, 200));
  const hoechste = (v: Verprobung) => (['FEHLER', 'WARNUNG', 'HINWEIS'] as const).find((s) => v.befunde.some((b) => b.stufe === s));
  return (
    <div>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
        Zeigt für die gewählten Benutzer, was sie mit dem Stand der Matrix dürften{geaendert.length ? <b> – einschließlich der ungesicherten Änderungen an {geaendert.join(', ')}</b> : ''} –
        und was sich gegenüber heute ändert. Optional mit probeweise zugeordneten Rollen. Es wird nichts gespeichert.
      </Text>
      <div className="portal-rm__probe">
        <div>
          <Label showColon>1 · Benutzer ({wahl.length})</Label>
          <MultiComboBox data-kein-autofill placeholder={benutzer ? 'Benutzer wählen (Name oder Anmeldename)' : 'Lade …'} style={{ width: '100%' }}
                         onSelectionChange={(e) => setWahl(e.detail.items.map((i) => (i as HTMLElement).dataset.u!))}>
            {(benutzer ?? []).map((u) => <MultiComboBoxItem key={u.id} data-u={u.id} text={u.displayName || u.username} additionalText={`${u.username}${u.active ? '' : ' (gesperrt)'}`} selected={wahl.includes(u.id)} />)}
          </MultiComboBox>
          <div className="portal-row" style={{ marginTop: '0.25rem' }}>
            <Select style={{ width: '16rem' }} onChange={(e) => {
              const r = (e.detail.selectedOption as HTMLElement).dataset.r;
              if (r) hinzu((benutzer ?? []).filter((u) => u.roles.includes(r)).map((u) => u.id));
            }}>
              <Option data-r="" selected>+ alle Benutzer der Rolle …</Option>
              {alleRollen.map((r) => <Option key={r.id} data-r={r.id}>{r.id} ({r.userCount})</Option>)}
            </Select>
            {wahl.length > 0 && <Button design="Transparent" icon="decline" onClick={() => setWahl([])}>Auswahl leeren</Button>}
          </div>
        </div>
        <div>
          <Label showColon>2 · Rollen probeweise zuordnen (optional)</Label>
          <MultiComboBox data-kein-autofill placeholder="keine – nur der Stand der Matrix" style={{ width: '100%' }}
                         onSelectionChange={(e) => setProbeRollen(e.detail.items.map((i) => (i as HTMLElement).dataset.r!))}>
            {rollen.map((r) => <MultiComboBoxItem key={r.id} data-r={r.id} text={r.id} additionalText={r.name} selected={probeRollen.includes(r.id)} />)}
          </MultiComboBox>
          <div className="portal-row" style={{ marginTop: '0.25rem' }}>
            <Select style={{ width: '18rem' }} onChange={(e) => setModus((e.detail.selectedOption as HTMLElement).dataset.m as typeof modus)}>
              <Option data-m="ZUSAETZLICH" selected={modus === 'ZUSAETZLICH'}>zusätzlich zu den bisherigen Rollen</Option>
              <Option data-m="ERSETZEN" selected={modus === 'ERSETZEN'}>statt der bisherigen Rollen</Option>
            </Select>
          </div>
        </div>
      </div>

      {!wahl.length ? <Text className="portal-muted">Bitte einen oder mehrere Benutzer wählen.</Text> : !erg ? <Text>Verprobung läuft …</Text> : (
        <table className="portal-rm__befunde">
          <thead><tr>{['', 'Benutzer', 'Rollen heute', 'Rollen in der Probe', 'Rechte', 'Änderung', 'Befunde', ''].map((h, i) => <th key={i}><Label>{h}</Label></th>)}</tr></thead>
          <tbody>{erg.map((v) => {
            const auf = offen.has(v.id);
            const st = hoechste(v);
            const rollenGleich = v.rollenJetzt.join() === v.rollenProbe.join();
            return (
              <Fragment key={v.id}>
                <tr>
                  <td><Button design="Transparent" icon={auf ? 'navigation-down-arrow' : 'navigation-right-arrow'} tooltip="Einzelheiten" onClick={() => umschalten(v.id)} /></td>
                  <td><b>{v.name}</b><br /><span className="portal-muted portal-small">{v.username}{v.aktiv ? '' : ' · gesperrt'}</span></td>
                  <td>{v.rollenJetzt.join(', ') || '–'}</td>
                  <td>{rollenGleich ? <span className="portal-muted">unverändert</span> : v.rollenProbe.join(', ') || '–'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{v.allesProbe ? 'alle' : v.anzahlProbe}{v.anzahlJetzt !== v.anzahlProbe && !v.allesProbe ? <span className="portal-muted"> (heute {v.allesJetzt ? 'alle' : v.anzahlJetzt})</span> : ''} · {v.apps.length} Apps</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!v.dazu.length && !v.weg.length ? <span className="portal-muted">keine</span> : <>
                      {v.dazu.length > 0 && <ObjectStatus state="Positive">+{v.dazu.length}</ObjectStatus>}{' '}
                      {v.weg.length > 0 && <ObjectStatus state="Negative">−{v.weg.length}</ObjectStatus>}
                    </>}
                  </td>
                  <td>{st ? <ObjectStatus state={STUFE[st].state} showDefaultIcon>{v.befunde.length} {v.befunde.length === 1 ? 'Befund' : 'Befunde'}</ObjectStatus> : <span className="portal-muted">keine</span>}</td>
                  <td><Button design="Transparent" icon="grid" tooltip="Rollen der Probe in der Matrix nebeneinander zeigen" disabled={!v.rollenProbe.length} onClick={() => onMatrix(v)}>Matrix</Button></td>
                </tr>
                {auf && (
                  <tr>
                    <td />
                    <td colSpan={7} className="portal-rm__detail">
                      {v.befunde.map((b, i) => <div key={i}><ObjectStatus state={STUFE[b.stufe].state} showDefaultIcon>{STUFE[b.stufe].text}</ObjectStatus> {b.text}</div>)}
                      {v.dazu.length > 0 && <div><b>Kommt dazu ({v.dazu.length}):</b><ul>{v.dazu.map((p) => <li key={p} className="portal-rm__plus">{t(p)}</li>)}</ul></div>}
                      {v.weg.length > 0 && <div><b>Fällt weg ({v.weg.length}):</b><ul>{v.weg.map((p) => <li key={p} className="portal-rm__minus">{t(p)}</li>)}</ul></div>}
                      <div><b>Rechte in der Probe ({v.allesProbe ? 'alle' : v.rechte.length}) mit Herkunft:</b>
                        {v.allesProbe ? <span> Administrator – alle Rechte.</span> : !v.rechte.length ? <span> keine</span> : (
                          <table className="portal-rm__herkunft"><tbody>
                            {v.rechte.map((r) => <tr key={r.id}><td className="portal-muted">{r.app}</td><td>{r.text}</td><td>{r.rollen.join(', ')}{r.rollen.length > 1 && <span className="portal-muted"> (mehrfach)</span>}</td></tr>)}
                          </tbody></table>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}</tbody>
        </table>
      )}
    </div>
  );
}
