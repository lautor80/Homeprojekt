/**
 * Instandhaltung (#205): Listenvarianten der Meldungsübersicht je Benutzer (Filter je Spalte, Suche, Sortierung, offene/alle).
 * Gespeichert wie die Varianten der Mitglieder-Analyse in tco.rpt_variant (REPID IH_MELDUNGEN, uname = Benutzername bzw. „*“ global).
 * Eine Variante je Benutzer kann Standard sein; sie wird beim Öffnen geladen (eigene vor globaler).
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';

const REPID = 'IH_MELDUNGEN';

export interface Ansicht { alle: boolean; suche: string; filter: Record<string, string>; sort: { k: string; ab: boolean } | null }
export interface Variante { key: string; name: string; global: boolean; standard: boolean }

export function ansichtLesen(content: string | null): Ansicht | null {
  if (!content) return null;
  try {
    const c = JSON.parse(content) as Partial<Ansicht>;
    return {
      alle: !!c.alle, suche: typeof c.suche === 'string' ? c.suche : '',
      filter: c.filter && typeof c.filter === 'object' ? Object.fromEntries(Object.entries(c.filter).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {},
      sort: c.sort && typeof c.sort.k === 'string' ? { k: c.sort.k, ab: !!c.sort.ab } : null,
    };
  } catch { return null; }
}

export async function variantenLesen(db: Db, user: string): Promise<(Variante & { ansicht: Ansicht })[]> {
  const rows = await db`select uname, variant, isdef, content from tco.rpt_variant where repid = ${REPID} and (uname = ${user} or uname = '*')
                         order by case when uname = '*' then 1 else 0 end, variant`;
  return rows.flatMap((r) => {
    const ansicht = ansichtLesen(r.content);
    return ansicht ? [{ key: `${r.uname}/${r.variant}`, name: r.variant, global: r.uname === '*', standard: r.isdef === 'X', ansicht }] : [];
  });
}

/** Standardvariante: die eigene, sonst eine globale */
export async function varianteStandard(db: Db, user: string) {
  const l = await variantenLesen(db, user);
  return l.find((v) => v.standard && !v.global) ?? l.find((v) => v.standard && v.global) ?? null;
}

export async function varianteSichern(tx: Db, user: string, v: { name: string; standard: boolean; global: boolean }, ansicht: Ansicht): Promise<Variante> {
  const name = v.name.trim();
  if (!name || name.length > 30 || name.includes('/')) throw new BusinessError('Der Variantenname darf höchstens 30 Zeichen lang sein und keinen Schrägstrich enthalten.');
  const uname = v.global ? '*' : user;
  const changed = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  await tx`insert into tco.rpt_variant (repid, uname, variant, descr, isdef, changed, content)
           values (${REPID}, ${uname}, ${name}, '', ${v.standard ? 'X' : ''}, ${changed}, ${JSON.stringify(ansicht)})
           on conflict (repid, uname, variant) do update set isdef = excluded.isdef, changed = excluded.changed, content = excluded.content`;
  if (v.standard) await tx`update tco.rpt_variant set isdef = '' where repid = ${REPID} and uname = ${uname} and variant <> ${name} and isdef = 'X'`;
  return { key: `${uname}/${name}`, name, global: v.global, standard: v.standard };
}

export async function varianteLoeschen(tx: Db, user: string, key: string): Promise<string> {
  const [uname, ...rest] = key.split('/');
  const variant = rest.join('/');
  if (uname !== user && uname !== '*') throw new BusinessError('Diese Variante gehört einem anderen Benutzer.');
  const r = await tx`delete from tco.rpt_variant where repid = ${REPID} and uname = ${uname} and variant = ${variant}`;
  if (!r.count) throw new BusinessError('Variante nicht gefunden.', 404);
  return variant;
}
