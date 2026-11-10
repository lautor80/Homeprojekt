import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { can, change, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import { activeModules, sensitiveFields } from '../modules.js';
import type { Schutzart } from '../schutz.js';

/**
 * Tabellenansicht (Administration → Tabellenansicht, wie SE16): alle Tabellen und Sichten der Schemas
 * „core“ und der aktiven Module mit Struktur und Inhalt – nur lesend.
 *
 *   GET  /api/admin/tabellen                         Tabellen mit Beschreibung, Zeilen (geschätzt), Spaltenzahl
 *   GET  /api/admin/tabellen/:schema/:tabelle         Spalten (Typ, Pflicht, Vorschlagswert, Schlüssel, Schutz)
 *   POST /api/admin/tabellen/:schema/:tabelle/daten   Selektion: Felder, Filter, Sortierung, Gruppierung mit Summen
 *   POST /api/admin/tabellen/:schema/:tabelle/loeschen   markierte Sätze löschen → Papierkorb (core.tabellen:delete, #34)
 *   GET  /api/admin/tabellen/papierkorb                  gelöschte Sätze der letzten 7 Tage
 *   POST /api/admin/tabellen/papierkorb/wiederherstellen Sätze zurückschreiben; …/papierkorb/entfernen endgültig löschen
 *
 * Schutz: Geheimnisse (Kennwort-Hashes, Tokens, Zugangsschlüssel, Passwörter) verlassen den Server nie –
 * auch nicht über Filter, Sortierung oder Gruppierung, denn alle drei arbeiten auf dem maskierten Ausdruck.
 * Bankdaten (Feldschutz der Module) erscheinen ohne deren Berechtigung maskiert; in Änderungsbelegen ebenso.
 * Jede Abfrage läuft in einer lesenden Transaktion mit Zeitlimit.
 */
export const P_TABELLEN = 'core.tabellen:display';
export const P_TABELLEN_LOESCHEN = 'core.tabellen:delete';
/** Papierkorb: so lange lassen sich gelöschte Sätze wiederherstellen */
export const AUFBEWAHRUNG_TAGE = 7;
/** nie über die Tabellenansicht löschbar: Papierkorb selbst und Änderungsbelege (Nachvollziehbarkeit) */
const NICHT_LOESCHBAR = new Set(['core.tabellen_papierkorb', 'core.change_header', 'core.change_item']);

const MAX_ZEILEN = 5000;
const MAX_ZELLE = 2000;
const GEHEIM = /(hash|token|passw|kennw|secret|_auth$|^n8n_.*_key$)/i;
// Papierkorb: die gesicherte Zeile enthält ggf. Kennwort-Hashes und Bankdaten – in der Ansicht nie im Klartext
const GEHEIM_SPALTEN = new Set(['core.sperren.sitzung', 'core.tabellen_papierkorb.zeile']);

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const istGeheim = (schema: string, tabelle: string, spalte: string) => GEHEIM.test(spalte) || GEHEIM_SPALTEN.has(`${schema}.${tabelle}.${spalte}`);

/** Maskierung in SQL – dieselben Regeln wie server/src/schutz.ts */
function maskeSql(x: string, art: Schutzart): string {
  const v = `upper(regexp_replace(${x}, '\\s', '', 'g'))`;
  const leer = `coalesce(${x}, '') = ''`;
  if (art === 'iban') return `case when ${leer} then ${x} when length(${v}) <= 6 then repeat('•', length(${v})) else left(${v}, 2) || repeat('•', length(${v}) - 6) || right(${v}, 4) end`;
  if (art === 'bic') return `case when ${leer} then ${x} else left(${v}, 4) || repeat('•', greatest(length(${v}) - 4, 0)) end`;
  return `case when ${leer} then ${x} else regexp_replace(trim(${x}), '(\\S)\\S*', '\\1••', 'g') end`;
}

function schemas(): string[] {
  return ['core', ...activeModules().map((m) => m.id)];
}

interface Spalte {
  name: string; typ: string; basistyp: string; pflicht: boolean; vorschlag: string | null; beschreibung: string | null;
  schluessel: number | null; schutz: 'GEHEIM' | Schutzart | null; numerisch: boolean;
}

async function spaltenLesen(schema: string, tabelle: string): Promise<Spalte[]> {
  if (!schemas().includes(schema)) throw new BusinessError('Tabelle nicht gefunden.', 404);
  const rows = await sql`
    select a.attname as name, format_type(a.atttypid, a.atttypmod) as typ, t.typname as basistyp, t.typcategory as kategorie,
           a.attnotnull as pflicht, pg_get_expr(d.adbin, d.adrelid) as vorschlag, col_description(c.oid, a.attnum) as beschreibung,
           array_position(i.indkey::int2[], a.attnum) as schluessel
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      left join pg_index i on i.indrelid = c.oid and i.indisprimary
     where n.nspname = ${schema} and c.relname = ${tabelle} and c.relkind in ('r', 'p', 'v', 'm')
     order by a.attnum`;
  if (!rows.length) throw new BusinessError('Tabelle nicht gefunden.', 404);
  const schutz = new Map<string, Schutzart>();
  for (const f of sensitiveFields()) if (f.table === `${schema}.${tabelle}`) for (const [k, v] of Object.entries(f.fields)) schutz.set(k, v);
  return rows.map((r) => ({
    name: r.name, typ: r.typ, basistyp: r.basistyp, pflicht: r.pflicht, vorschlag: r.vorschlag, beschreibung: r.beschreibung,
    schluessel: r.schluessel === null ? null : Number(r.schluessel) + 1,
    schutz: istGeheim(schema, tabelle, r.name) ? 'GEHEIM' : schutz.get(r.name) ?? null,
    numerisch: r.kategorie === 'N',
  }));
}

/** Sichtbarer Ausdruck einer Spalte (maskiert, falls geschützt) – Grundlage für Anzeige, Filter, Sortierung, Gruppierung */
function ausdruck(req: FastifyRequest, schema: string, tabelle: string, s: Spalte): string {
  const c = `t.${ident(s.name)}`;
  if (s.schutz === 'GEHEIM') return `case when ${c} is null then null else '•••'::text end`;
  if (s.schutz) {
    const perm = sensitiveFields().find((f) => f.table === `${schema}.${tabelle}`)?.permission;
    return perm && can(req, perm) ? c : maskeSql(`${c}::text`, s.schutz);
  }
  // Änderungsbelege: alte/neue Werte geschützter Felder wie in der Änderungshistorie maskieren
  if (schema === 'core' && tabelle === 'change_item' && (s.name === 'old_value' || s.name === 'new_value')) {
    const faelle: string[] = [`when t.field ~* ${lit(GEHEIM.source)} then case when ${c} is null then null else '•••' end`];
    for (const f of sensitiveFields()) {
      if (can(req, f.permission)) continue;
      for (const [feld, art] of Object.entries(f.fields)) faelle.push(`when h.table_name = ${lit(f.table)} and t.field = ${lit(feld)} then ${maskeSql(c, art)}`);
    }
    return `(select case ${faelle.join(' ')} else ${c} end from core.change_header h where h.id = t.header_id)`;
  }
  if (s.basistyp === 'bytea') return `case when ${c} is null then null else '[' || octet_length(${c}) || ' Bytes]' end`;
  return c;
}

const OPS = ['EQ', 'NE', 'LT', 'LE', 'GT', 'GE', 'BT', 'CP', 'NP', 'IN', 'NULL', 'NNULL'] as const;
const datenBody = z.object({
  felder: z.array(z.string()).default([]),
  filter: z.array(z.object({
    spalte: z.string(), op: z.enum(OPS), wert: z.string().default(''), bis: z.string().default(''),
  })).max(30).default([]),
  sortierung: z.array(z.object({ spalte: z.string(), absteigend: z.boolean().default(false) })).max(5).default([]),
  gruppierung: z.object({
    nach: z.array(z.string()).max(5).default([]),
    summen: z.array(z.object({ fn: z.enum(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT_DISTINCT']), spalte: z.string() })).max(10).default([]),
  }).nullish(),
  limit: z.number().int().min(1).max(MAX_ZEILEN).default(500),
  offset: z.number().int().min(0).default(0),
});

const pkSpalten = (spalten: Spalte[]) => spalten.filter((s) => s.schluessel).sort((x, y) => x.schluessel! - y.schluessel!);

/** Löschen erlaubt? echte Tabelle (keine Sicht), Primärschlüssel ohne geheime Spalte, nicht Papierkorb/Änderungsbelege */
async function loeschbar(schema: string, tabelle: string, spalten: Spalte[]): Promise<boolean> {
  if (NICHT_LOESCHBAR.has(`${schema}.${tabelle}`)) return false;
  const pk = pkSpalten(spalten);
  if (!pk.length || pk.some((s) => s.schutz === 'GEHEIM')) return false;
  const [r] = await sql`select c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${schema} and c.relname = ${tabelle}`;
  return r?.relkind === 'r' || r?.relkind === 'p';
}

/** abgelaufene Papierkorb-Einträge entfernen (bei jedem Zugriff auf Papierkorb oder Löschen) */
const aufraeumen = () => sql`delete from core.tabellen_papierkorb where geloescht_am < now() - make_interval(days => ${AUFBEWAHRUNG_TAGE})`;

/** Bedingung „Primärschlüssel in den übergebenen Werten“ (Spalten mit ihrem Typ, Werte als Text-Arrays) */
function pkBedingung(pk: Spalte[], werte: string[][], params: unknown[], alias = 't') {
  const arrays = pk.map((s, i) => { params.push(werte.map((w) => w[i])); return `$${params.length}::text[]::${s.typ}[]`; });
  return `(${pk.map((s) => `${alias}.${ident(s.name)}`).join(', ')}) in (select * from unnest(${arrays.join(', ')}))`;
}

const fehlerText = (e: unknown, sonst: string) => {
  const code = (e as { code?: string }).code ?? '';
  const detail = (e as { detail?: string }).detail ?? '';
  if (code === '23503') return `${sonst}: Der Satz wird noch von einer anderen Tabelle verwendet bzw. verweist auf einen fehlenden Satz${detail ? ` (${detail})` : ''}.`;
  if (code === '23505') return `${sonst}: Ein Satz mit diesem Schlüssel ist bereits vorhanden${detail ? ` (${detail})` : ''}.`;
  if (code === '57014') return `${sonst}: Zeitlimit überschritten.`;
  return `${sonst}: ${(e as Error).message}`;
};

export async function tabellenRoutes(app: FastifyInstance) {
  const loeschen = { preHandler: requireAuth(P_TABELLEN_LOESCHEN) };

  // ---------------------------------------------------------------- Papierkorb (#34)
  app.get('/api/admin/tabellen/papierkorb', loeschen, async () => {
    await aufraeumen();
    return sql`
      select id::int, vorgang::text, schema_name as schema, tabelle, schluessel, geloescht_am, geloescht_von, grund,
             geloescht_am + make_interval(days => ${AUFBEWAHRUNG_TAGE}) as verfaellt_am
        from core.tabellen_papierkorb order by id desc limit 2000`;
  });

  app.post('/api/admin/tabellen/papierkorb/wiederherstellen', loeschen, async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).min(1).max(2000) }).parse(req.body);
    await aufraeumen();
    const ergebnis = await change(req, async (tx) => {
      await tx.unsafe(`set local statement_timeout = '20s'`);
      // jüngste zuerst: wurde erst das Kind, dann der Elternsatz gelöscht, kommt der Elternsatz zuerst zurück
      const eintraege = await tx`select id::int, schema_name, tabelle, zeile from core.tabellen_papierkorb where id = any(${ids}) order by id desc`;
      const out: { id: number; ok: boolean; text: string }[] = [];
      for (const e of eintraege) {
        try {
          if (!schemas().includes(e.schema_name)) throw new BusinessError('Schema nicht (mehr) aktiv');
          const cols = (await tx`
            select a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = ${e.schema_name} and c.relname = ${e.tabelle} and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
             order by a.attnum`).map((r) => ident(r.attname as string));
          if (!cols.length) throw new BusinessError('Tabelle gibt es nicht mehr');
          const ziel = `${ident(e.schema_name)}.${ident(e.tabelle)}`;
          await tx.savepoint((sp) => sp.unsafe(
            `insert into ${ziel} (${cols.join(', ')}) overriding system value select ${cols.join(', ')} from jsonb_populate_record(null::${ziel}, $1::jsonb)`,
            [JSON.stringify(e.zeile)]));
          await tx`delete from core.tabellen_papierkorb where id = ${e.id}`;
          out.push({ id: e.id, ok: true, text: 'wiederhergestellt' });
        } catch (x) {
          if (!(x instanceof BusinessError) && !(x as { code?: string }).code) throw x;
          out.push({ id: e.id, ok: false, text: fehlerText(x, 'Nicht wiederhergestellt') });
        }
      }
      return out;
    }, { action: 'TABELLE_WIEDERHERSTELLEN', reason: `${ids.length} Satz/Sätze aus dem Papierkorb` });
    const ok = ergebnis.filter((x) => x.ok).length;
    return { zeilen: ergebnis, text: `${ok} von ${ergebnis.length} Satz/Sätzen wiederhergestellt.` };
  });

  app.post('/api/admin/tabellen/papierkorb/entfernen', loeschen, async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).min(1).max(2000) }).parse(req.body);
    const r = await change(req, (tx) => tx`delete from core.tabellen_papierkorb where id = any(${ids})`, { action: 'PAPIERKORB_LEEREN' });
    return { text: `${r.count} Eintrag/Einträge endgültig entfernt.` };
  });

  // ---------------------------------------------------------------- markierte Sätze löschen (#34)
  app.post('/api/admin/tabellen/:schema/:tabelle/loeschen', loeschen, async (req) => {
    const { schema, tabelle } = z.object({ schema: z.string(), tabelle: z.string() }).parse(req.params);
    const b = z.object({
      schluessel: z.array(z.array(z.string())).min(1, 'Bitte mindestens einen Satz markieren.').max(1000, 'Höchstens 1.000 Sätze auf einmal.'),
      grund: z.string().trim().max(300).nullish(),
    }).parse(req.body);
    const spalten = await spaltenLesen(schema, tabelle);
    if (!(await loeschbar(schema, tabelle, spalten))) {
      throw new BusinessError(NICHT_LOESCHBAR.has(`${schema}.${tabelle}`) ? `${schema}.${tabelle} lässt sich hier nicht löschen.`
        : `${schema}.${tabelle} hat keinen verwendbaren Primärschlüssel oder ist eine Sicht – Löschen ist nicht möglich.`);
    }
    const pk = pkSpalten(spalten);
    if (b.schluessel.some((k) => k.length !== pk.length)) throw new BusinessError('Schlüssel passt nicht zur Tabelle.');
    const ziel = `${ident(schema)}.${ident(tabelle)}`;
    await aufraeumen();
    try {
      return await change(req, async (tx) => {
        await tx.unsafe(`set local statement_timeout = '20s'`);
        // Verweise mit ON DELETE CASCADE / SET NULL / SET DEFAULT würden andere Tabellen still mitändern – die landen nicht im
        // Papierkorb. Daher: solche abhängigen Einträge vorher melden statt mitlöschen.
        const fks = await tx`
          select cn.nspname as schema, cc.relname as tabelle, k.confdeltype as art,
                 array(select a.attname from unnest(k.conkey) with ordinality u(n, i) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.i) as von,
                 array(select a.attname from unnest(k.confkey) with ordinality u(n, i) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.i) as nach
            from pg_constraint k
            join pg_class c on c.oid = k.confrelid join pg_namespace n on n.oid = c.relnamespace
            join pg_class cc on cc.oid = k.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
           where k.contype = 'f' and k.confdeltype in ('c', 'n', 'd') and n.nspname = ${schema} and c.relname = ${tabelle}`;
        const abhaengig: string[] = [];
        for (const f of fks) {
          const params: unknown[] = [];
          const join = (f.von as string[]).map((v, i) => `k.${ident(v)} = t.${ident((f.nach as string[])[i])}`).join(' and ');
          const [{ n }] = await tx.unsafe(
            `select count(*)::int as n from ${ident(f.schema)}.${ident(f.tabelle)} k join ${ziel} t on ${join} where ${pkBedingung(pk, b.schluessel, params)}`, params as never[]);
          if (n > 0) abhaengig.push(`${f.schema}.${f.tabelle} (${n}, würde ${f.art === 'c' ? 'mitgelöscht' : 'geleert'})`);
        }
        if (abhaengig.length) {
          throw new BusinessError(`Nicht gelöscht – es gibt abhängige Einträge: ${abhaengig.join(', ')}. Bitte zuerst dort löschen; nur so lässt sich alles wiederherstellen.`);
        }
        const params: unknown[] = [];
        const bed = pkBedingung(pk, b.schluessel, params);
        params.push(req.user?.username ?? 'unbekannt', b.grund || null, schema, tabelle);
        const n = params.length;
        const pkJson = `jsonb_build_object(${pk.map((s) => `${lit(s.name)}, d.zeile -> ${lit(s.name)}`).join(', ')})`;
        const r = await tx.unsafe(`
          with d as (delete from ${ziel} t where ${bed} returning to_jsonb(t.*) as zeile),
               v as (select gen_random_uuid() as vorgang)
          insert into core.tabellen_papierkorb (vorgang, schema_name, tabelle, schluessel, zeile, geloescht_von, grund)
          select v.vorgang, $${n - 1}, $${n}, ${pkJson}, d.zeile, $${n - 3}, $${n - 2} from d, v
          returning vorgang::text`, params as never[]);
        return {
          geloescht: r.length, vorgang: r[0]?.vorgang ?? null,
          text: r.length
            ? `${r.length} Satz/Sätze aus ${schema}.${tabelle} gelöscht – ${AUFBEWAHRUNG_TAGE} Tage im Papierkorb wiederherstellbar.`
            : 'Keiner der markierten Sätze war (noch) vorhanden.',
        };
      }, { action: 'TABELLE_LOESCHEN', reason: `${schema}.${tabelle}${b.grund ? `: ${b.grund}` : ''}` });
    } catch (e) {
      if (e instanceof BusinessError) throw e;
      if ((e as { code?: string }).code) throw new BusinessError(fehlerText(e, 'Nicht gelöscht'));
      throw e;
    }
  });

  const darf = { preHandler: requireAuth(P_TABELLEN) };

  app.get('/api/admin/tabellen', darf, async () => {
    return sql`
      select n.nspname as schema, c.relname as tabelle, obj_description(c.oid, 'pg_class') as beschreibung,
             case c.relkind when 'v' then 'Sicht' when 'm' then 'Sicht (materialisiert)' else 'Tabelle' end as art,
             greatest(c.reltuples, 0)::bigint as zeilen,
             (select count(*)::int from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as spalten,
             pg_total_relation_size(c.oid)::bigint as bytes
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${schemas()}) and c.relkind in ('r', 'p', 'v', 'm')
       order by n.nspname, c.relname`;
  });

  app.get('/api/admin/tabellen/:schema/:tabelle', darf, async (req) => {
    const { schema, tabelle } = z.object({ schema: z.string(), tabelle: z.string() }).parse(req.params);
    const spalten = await spaltenLesen(schema, tabelle);
    const [{ n }] = await sql.unsafe(`select count(*)::bigint as n from ${ident(schema)}.${ident(tabelle)}`);
    return { schema, tabelle, zeilen: Number(n), spalten };
  });

  app.post('/api/admin/tabellen/:schema/:tabelle/daten', darf, async (req) => {
    const { schema, tabelle } = z.object({ schema: z.string(), tabelle: z.string() }).parse(req.params);
    const b = datenBody.parse(req.body ?? {});
    const spalten = await spaltenLesen(schema, tabelle);
    const nachName = new Map(spalten.map((s) => [s.name, s]));
    const sp = (name: string) => {
      const s = nachName.get(name);
      if (!s) throw new BusinessError(`Spalte „${name}“ gibt es in ${schema}.${tabelle} nicht.`);
      return s;
    };
    const ausdr = (name: string) => ausdruck(req, schema, tabelle, sp(name));
    const params: string[] = [];
    const p = (v: string) => { params.push(v); return `$${params.length}`; };

    // Selektionsbedingungen (wie SE16: =, ≠, <, ≤, >, ≥, Intervall, Muster mit * und +, Liste, leer)
    const bed: string[] = [];
    for (const f of b.filter) {
      const x = ausdr(f.spalte);
      const muster = (w: string) => w.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%').replace(/\+/g, '_');
      switch (f.op) {
        case 'EQ': bed.push(`${x} = ${p(f.wert)}`); break;
        case 'NE': bed.push(`${x} is distinct from ${p(f.wert)}`); break;
        case 'LT': bed.push(`${x} < ${p(f.wert)}`); break;
        case 'LE': bed.push(`${x} <= ${p(f.wert)}`); break;
        case 'GT': bed.push(`${x} > ${p(f.wert)}`); break;
        case 'GE': bed.push(`${x} >= ${p(f.wert)}`); break;
        case 'BT': bed.push(`${x} between ${p(f.wert)} and ${p(f.bis)}`); break;
        case 'CP': bed.push(`(${x})::text ilike ${p(f.wert.includes('*') || f.wert.includes('+') ? muster(f.wert) : `%${muster(f.wert)}%`)}`); break;
        case 'NP': bed.push(`coalesce((${x})::text, '') not ilike ${p(f.wert.includes('*') || f.wert.includes('+') ? muster(f.wert) : `%${muster(f.wert)}%`)}`); break;
        case 'IN': {
          const werte = f.wert.split(/[;\n]/).map((w) => w.trim()).filter(Boolean);
          if (!werte.length) throw new BusinessError(`Liste für „${f.spalte}“ ist leer (Werte mit ; trennen).`);
          bed.push(`(${x})::text = any(${p(`{${werte.map((w) => `"${w.replace(/["\\]/g, '\\$&')}"`).join(',')}}`)}::text[])`); break;
        }
        case 'NULL': bed.push(`(${x} is null or (${x})::text = '')`); break;
        case 'NNULL': bed.push(`(${x} is not null and (${x})::text <> '')`); break;
      }
    }
    const where = bed.length ? `where ${bed.join(' and ')}` : '';
    const von = `from ${ident(schema)}.${ident(tabelle)} t ${where}`;
    const zelle = (x: string) => `left((${x})::text, ${MAX_ZELLE})`;

    const g = b.gruppierung;
    let daten: string; let anzahl: string; let ausgabe: { name: string; text: string; numerisch: boolean }[];
    let schluessel: Spalte[] = [];
    if (g && (g.nach.length > 0 || g.summen.length > 0)) {
      // innen die (ggf. maskierten) Ausdrücke, außen gruppieren und verdichten – Gruppierung nur über sichtbare Werte
      const innen = [...g.nach.map((n, i) => `${ausdr(n)} as ${ident(`g${i}`)}`), ...g.summen.map((s, i) => `${ausdr(s.spalte)} as ${ident(`s${i}`)}`)];
      const sel = g.nach.map((_, i) => `${zelle(ident(`g${i}`))} as ${ident(`g${i}`)}`);
      ausgabe = g.nach.map((n) => ({ name: n, text: n, numerisch: sp(n).numerisch }));
      sel.push(`count(*)::text as ${ident('anzahl')}`);
      ausgabe.push({ name: 'anzahl', text: 'Anzahl', numerisch: true });
      const FN_TEXT = { SUM: 'Summe', AVG: 'Durchschnitt', MIN: 'Minimum', MAX: 'Maximum', COUNT_DISTINCT: 'Anzahl verschiedene' };
      g.summen.forEach((s, i) => {
        const spalte = sp(s.spalte);
        if ((s.fn === 'SUM' || s.fn === 'AVG') && (!spalte.numerisch || spalte.schutz)) {
          throw new BusinessError(`${FN_TEXT[s.fn]} geht nur über Zahlenfelder („${s.spalte}“ ist ${spalte.typ}).`);
        }
        const x = ident(`s${i}`);
        const agg = s.fn === 'COUNT_DISTINCT' ? `count(distinct ${x})` : s.fn === 'AVG' ? `round(avg(${x})::numeric, 2)` : `${s.fn.toLowerCase()}(${x})`;
        sel.push(`${zelle(agg)} as ${ident(`a${i}`)}`);
        ausgabe.push({ name: `${s.fn}:${s.spalte}`, text: `${FN_TEXT[s.fn]} ${s.spalte}`, numerisch: s.fn === 'MIN' || s.fn === 'MAX' ? spalte.numerisch : true });
      });
      const gruppe = g.nach.length ? `group by ${g.nach.map((_, i) => ident(`g${i}`)).join(', ')}` : '';
      // Sortierung über Gruppierungsfelder, Anzahl oder Kennzahlen (Name wie in der Ausgabe)
      const sortAlias = (name: string) => {
        const gi = g.nach.indexOf(name);
        if (gi >= 0) return ident(`g${gi}`);
        if (name === 'anzahl') return 'count(*)';
        const ai = g.summen.findIndex((s) => `${s.fn}:${s.spalte}` === name);
        if (ai >= 0) { const s = g.summen[ai]; const x = ident(`s${ai}`); return s.fn === 'COUNT_DISTINCT' ? `count(distinct ${x})` : `${s.fn === 'AVG' ? 'avg' : s.fn.toLowerCase()}(${x})`; }
        throw new BusinessError(`Nach „${name}“ kann in der Gruppierung nicht sortiert werden.`);
      };
      const sortierung = b.sortierung.length ? b.sortierung : g.nach.map((spalte) => ({ spalte, absteigend: false }));
      const order = sortierung.length ? `order by ${sortierung.map((s) => `${sortAlias(s.spalte)} ${s.absteigend ? 'desc' : 'asc'} nulls last`).join(', ')}` : '';
      const quelle = `(select ${innen.join(', ')} ${von}) x`;
      daten = `select ${sel.join(', ')} from ${quelle} ${gruppe} ${order} limit ${b.limit + 1} offset ${b.offset}`;
      anzahl = gruppe ? `select count(*)::bigint as n from (select 1 from ${quelle} ${gruppe}) y` : 'select 1::bigint as n';
    } else {
      const felder = b.felder.length ? b.felder : spalten.map((s) => s.name);
      ausgabe = felder.map((n) => ({ name: n, text: n, numerisch: sp(n).numerisch }));
      // Primärschlüssel je Zeile (ungekürzt) für „Löschen“ – nur Tabellen mit Schlüssel ohne geheime Spalten
      schluessel = await loeschbar(schema, tabelle, spalten) ? pkSpalten(spalten) : [];
      const select = [...felder.map((n, i) => `${zelle(ausdr(n))} as ${ident(`f${i}`)}`), ...schluessel.map((s, i) => `t.${ident(s.name)}::text as ${ident(`k${i}`)}`)].join(', ');
      // Sortierung: gewählte Felder, sonst Primärschlüssel
      const sortierung = b.sortierung.length ? b.sortierung
        : spalten.filter((s) => s.schluessel).sort((x, y) => x.schluessel! - y.schluessel!).map((s) => ({ spalte: s.name, absteigend: false }));
      const order = sortierung.length ? `order by ${sortierung.map((s) => `${ausdr(s.spalte)} ${s.absteigend ? 'desc' : 'asc'} nulls last`).join(', ')}` : '';
      daten = `select ${select} ${von} ${order} limit ${b.limit + 1} offset ${b.offset}`;
      anzahl = `select count(*)::bigint as n ${von}`;
    }

    try {
      return await sql.begin('read only', async (tx) => {
        await tx.unsafe(`set local statement_timeout = '20s'`);
        const zeilen = await tx.unsafe(daten, params);
        const [{ n }] = await tx.unsafe(anzahl, anzahl.startsWith('select 1::') ? [] : params);
        const mehr = zeilen.length > b.limit;
        const werte = zeilen.slice(0, b.limit).map((z) => Object.values(z) as (string | null)[]);
        return {
          spalten: ausgabe,
          zeilen: werte.map((w) => w.slice(0, ausgabe.length)),
          // Schlüssel je Zeile für das Löschen (null: Tabelle nicht löschbar oder gruppiert)
          schluesselSpalten: schluessel.length ? schluessel.map((s) => s.name) : null,
          schluessel: schluessel.length ? werte.map((w) => w.slice(ausgabe.length) as string[]) : null,
          gesamt: Number(n), mehr,
        };
      });
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      // Eingabefehler (Datum/Zahl ungültig), Zeitlimit u. ä. verständlich zurückgeben
      if (code === '57014') throw new BusinessError('Die Abfrage hat das Zeitlimit von 20 Sekunden überschritten – bitte die Selektion einschränken.');
      if (/^(22|42)/.test(code)) throw new BusinessError(`Selektion ungültig: ${(e as Error).message}`);
      throw e;
    }
  });
}
