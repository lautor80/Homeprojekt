import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerModule } from '../../../server/src/module.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { sql, type Tx } from '../../../server/src/db.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { BusinessError } from '../../../server/src/errors.js';
import { tempoCsvLesen } from './logik/csv.js';
import { STANDARD_EINSTELLUNGEN, einstellungenErgaenzen } from './logik/standard.js';
import { auswerten, textNorm } from './logik/auswertung.js';
import type { Einstellungen, Freigabe, FreigabeSchluessel, ImportAntwort, ImportErgebnis, ImportZeile, PersonVorgabe, RohEintrag } from './typen.js';

/**
 * WCA Zeitenkontrolle: Tempo-Zeitexporte (Teamreport als CSV) importieren und die Zeitbuchungen prüfen –
 * Vollständigkeit je Person und Tag, Kontierung, Plausibilität, Textqualität und Regelwerk. Die Prüflogik liegt rein
 * (ohne Datenbank) in ./logik; hier nur Speicherung, Ersetzen je Person und Tag beim Import und die Routen.
 * Fachliche Beschreibung: docs/wca.md.
 */
export const P = {
  auswertung: 'wca.auswertung:display',
  importDisplay: 'wca.import:display',
  importEdit: 'wca.import:edit',
  einstellungenDisplay: 'wca.einstellungen:display',
  einstellungenEdit: 'wca.einstellungen:edit',
};

const B = 'WCA';
const A = 'Zeitenkontrolle';

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum JJJJ-MM-TT');
const datumOpt = datum.nullish().or(z.literal('')).transform((v) => v || null);
const stufe = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const text = (max: number) => z.string().max(max);
const grund = z.object({ reason: z.string().trim().min(1, 'Begründung ist Pflicht') });
const personParam = z.object({ person: z.string().trim().min(1).max(200) });
const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'Portal';

/** heutiges Datum (lokale Zeit) als JJJJ-MM-TT */
function heute(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** CSV aus Daten-URL (base64) oder Klartext */
const csvText = (s: string) => (/^data:[^,]*;base64,/.test(s) ? Buffer.from(s.replace(/^data:[^,]*;base64,/, ''), 'base64').toString('utf8') : s);

const r2 = (n: number) => Math.round(n * 100) / 100;
/** Lesen außerhalb einer Transaktion mit derselben Signatur wie tx */
const DB = sql as unknown as Tx;

// ------------------------------------------------------------------ Schemas

const wortRegel = z.object({
  name: text(200),
  art: z.enum(['ns', 'fr']),
  nurAbrechenbar: z.boolean(),
  stufeIntern: stufe.nullable(),
  stufeBillable: stufe,
  woerter: text(20000),
  tipp: text(2000),
});

/** Einstellungen wie in typen.ts; Unbekanntes wird verworfen, Fehlendes mit dem Standard ergänzt */
const einstellungenSchema = z.object({
  toleranz: z.number().min(0).max(24),
  bundesland: z.string().trim().toUpperCase().max(5),
  errorAccounts: text(20000),
  accountPflichtAb: datum.or(z.literal('')),
  regelwerkAn: z.boolean(),
  regelwerkAb: datum.or(z.literal('')),
  regelwerkMinWoerter: z.number().int().min(0).max(100),
  regelwerkIdBillable: z.boolean(),
  regelwerkOhneIdMuster: text(500),
  wiederholungTage: z.number().int().min(1).max(366),
  wiederholungMinH: z.number().min(0).max(10000),
  langerTag: z.number().min(0).max(24),
  langeBuchung: z.number().min(0).max(24),
  duennH: z.number().min(0).max(24),
  duennWoerter: z.number().int().min(0).max(100),
  aliasse: text(20000),
  allgemeinZusatz: text(20000),
  regeltermine: text(20000),
  feiertage: text(20000),
  internMuster: text(500),
  aus: z.record(z.string().max(50), z.boolean()),
  wortRegeln: z.record(z.string().regex(/^F_[A-Za-z0-9_]{1,40}$/, 'Id einer Wortregel: F_…'), wortRegel),
}).partial();

const vorgabeSchema = z.object({
  standort: z.string().trim().toUpperCase().max(10).nullish().transform((v) => v || null),
  sollTag: z.number().min(0).max(24).nullish().transform((v) => v ?? null),
  arbeitstage: z.array(z.number().int().min(0).max(6)).max(7).nullish()
    .transform((v) => (v ? [...new Set(v)].sort((a, b) => a - b) : null)),
  von: datumOpt,
  bis: datumOpt,
  ausblenden: z.boolean().default(false),
}).refine((v) => !v.von || !v.bis || v.bis >= v.von, { message: '„Bis“ liegt vor „Von“.', path: ['bis'] });

const importSchema = z.object({
  dateien: z.array(z.object({
    name: z.string().trim().min(1).max(300),
    csv: z.string(),
    geaendert: z.string().datetime({ offset: true }).or(z.number().transform((n) => new Date(n).toISOString())).nullish(),
  })).min(1, 'Keine Datei gewählt.').max(50),
  uebernehmen: z.boolean().default(false),
});

const auswertungQuery = z.object({
  stichtag: datum.optional().or(z.literal('').transform(() => undefined)),
  zeitraum: z.string().max(2000).regex(/^(\d{4}-\d{2}|\d{4}-W\d{2}|alle)(,(\d{4}-\d{2}|\d{4}-W\d{2}|alle))*$/, 'Zeitraum: JJJJ-MM, JJJJ-Www oder alle (mehrere mit Komma)')
    .optional().or(z.literal('').transform(() => undefined)),
});

const freigabeSchema = z.object({
  regel: z.string().trim().min(1).max(50),
  acc: z.string().max(1000).default(''),
  text: z.string().max(20000),
  person: z.string().max(200).default(''),
  meldung: z.string().max(2000).default(''),
}).refine((v) => textNorm(v.text) !== '', { message: 'Leere Texte lassen sich nicht freigeben.', path: ['text'] });

// ------------------------------------------------------------------ Lesen

async function freigabenLesen(): Promise<Freigabe[]> {
  const rows = await sql`select id, regel, acc, text, person, meldung, freigegeben_von as "freigegebenVon", freigegeben_am as "freigegebenAm"
                           from wca.freigabe order by freigegeben_am desc, regel`;
  return rows.map((r) => ({
    id: r.id, regel: r.regel, acc: r.acc, text: r.text, person: r.person, meldung: r.meldung, freigegebenVon: r.freigegebenVon,
    freigegebenAm: r.freigegebenAm instanceof Date ? r.freigegebenAm.toISOString() : String(r.freigegebenAm),
  }));
}

async function einstellungenLesen(db: Tx = DB): Promise<Einstellungen> {
  const [z1] = await db`select daten from wca.einstellungen where id = 1`;
  return einstellungenErgaenzen((z1?.daten ?? null) as Partial<Einstellungen> | null);
}

async function vorgabenLesen(): Promise<PersonVorgabe[]> {
  const rows = await sql`select person, standort, soll_tag::float8 as "sollTag", arbeitstage, von, bis, ausblenden
                           from wca.person order by person`;
  return rows.map((r) => ({
    person: r.person, standort: r.standort, sollTag: r.sollTag, arbeitstage: r.arbeitstage ?? null,
    von: r.von, bis: r.bis, ausblenden: r.ausblenden,
  }));
}

/** alle gespeicherten Rückmeldungen mit ihren Tagen – je Person und Tag gibt es nur noch die zuletzt importierte Datei */
async function eintraegeLesen(): Promise<RohEintrag[]> {
  const rows = await sql`
    select e.person, e.kat, e.proj, e.acc, e.team, e.ber, e.text, e.schluessel as key, e.zeile,
           json_agg(json_build_array(to_char(t.tag, 'YYYY-MM-DD'), t.stunden::float8) order by t.tag) as tage
      from wca.eintrag e
      join wca.import i on i.id = e.import_id
      join wca.eintrag_tag t on t.eintrag_id = e.id
     group by e.id, i.importiert_am
     order by i.importiert_am, e.import_id, e.zeile`;
  return rows.map((r) => ({
    person: r.person, kat: r.kat, proj: r.proj, acc: r.acc, team: r.team, ber: r.ber, text: r.text, key: r.key,
    zeile: r.zeile, tage: r.tage as [string, number][],
  }));
}

async function schluesselLesen() {
  const accKeys: Record<string, string> = {};
  const berKeys: Record<string, string> = {};
  for (const r of await sql`select art, name, schluessel from wca.schluessel`) (r.art === 'acc' ? accKeys : berKeys)[r.name] = r.schluessel;
  return { accKeys, berKeys };
}

// ------------------------------------------------------------------ Import

/** Buchungstage (Person × Datum), die diese Datei in der Datenbank ersetzt bzw. ersetzen würde */
async function ersetztZaehlen(db: Tx, erg: ImportErgebnis): Promise<number> {
  if (!erg.personen.length || !erg.tage.length) return 0;
  const [{ n }] = await db`
    select count(*)::int as n from (
      select distinct e.person, t.tag
        from wca.eintrag e join wca.eintrag_tag t on t.eintrag_id = e.id
       where e.person = any(${erg.personen}::text[]) and t.tag = any(${erg.tage}::date[])) x`;
  return n;
}

function kennzahlen(erg: ImportErgebnis) {
  return {
    von: erg.tage[0],
    bis: erg.tage[erg.tage.length - 1],
    personen: erg.personen.length,
    eintraege: erg.eintraege.length,
    stunden: r2(erg.eintraege.reduce((s, e) => s + e.tage.reduce((t, [, h]) => t + h, 0), 0)),
    warnungen: erg.warnungen,
  };
}

/** Datei übernehmen: ältere Buchungstage derselben Personen an den Tagen der Datei ersetzen, dann neu anlegen */
async function uebernehmen(tx: Tx, erg: ImportErgebnis, geaendert: string | null, wer: string): Promise<number> {
  const ersetzt = await ersetztZaehlen(tx, erg);
  if (erg.personen.length && erg.tage.length) {
    await tx`delete from wca.eintrag_tag t using wca.eintrag e
              where e.id = t.eintrag_id and e.person = any(${erg.personen}::text[]) and t.tag = any(${erg.tage}::date[])`;
    // Rückmeldungen ohne verbleibende Tage entfallen (der Import selbst bleibt stehen, ggf. mit 0 Einträgen)
    await tx`delete from wca.eintrag e
              where e.person = any(${erg.personen}::text[])
                and not exists (select 1 from wca.eintrag_tag t where t.eintrag_id = e.id)`;
  }
  const [imp] = await tx`
    insert into wca.import (datei, geaendert, von, bis, importiert_von)
    values (${erg.datei}, ${geaendert}, ${erg.tage[0] ?? null}, ${erg.tage[erg.tage.length - 1] ?? null}, ${wer})
    returning id`;

  const eintraege = erg.eintraege.filter((e) => e.tage.length).map((e) => ({ id: randomUUID(), e }));
  if (eintraege.length) {
    await tx`
      insert into wca.eintrag (id, import_id, zeile, person, kat, proj, acc, team, ber, schluessel, text)
      select x.id, ${imp.id}::uuid, x.zeile, x.person, x.kat, x.proj, x.acc, x.team, x.ber, x.schluessel, x.text
        from unnest(${eintraege.map((x) => x.id)}::uuid[], ${eintraege.map((x) => x.e.zeile)}::int[], ${eintraege.map((x) => x.e.person)}::text[],
                    ${eintraege.map((x) => x.e.kat ?? '')}::text[], ${eintraege.map((x) => x.e.proj ?? '')}::text[], ${eintraege.map((x) => x.e.acc ?? '')}::text[],
                    ${eintraege.map((x) => x.e.team ?? '')}::text[], ${eintraege.map((x) => x.e.ber ?? '')}::text[], ${eintraege.map((x) => x.e.key ?? '')}::text[],
                    ${eintraege.map((x) => x.e.text ?? '')}::text[])
             as x(id, zeile, person, kat, proj, acc, team, ber, schluessel, text)`;
    // Tage je Rückmeldung; derselbe Tag zweimal in einer Zeile kommt nicht vor, sicherheitshalber summiert
    const tage = new Map<string, { id: string; tag: string; h: number }>();
    for (const { id, e } of eintraege) {
      for (const [tag, h] of e.tage) {
        const k = `${id}|${tag}`;
        const alt = tage.get(k);
        if (alt) alt.h += h; else tage.set(k, { id, tag, h });
      }
    }
    const t = [...tage.values()].filter((x) => x.h !== 0);
    if (t.length) {
      await tx`
        insert into wca.eintrag_tag (eintrag_id, tag, stunden)
        select x.id, x.tag::date, x.stunden
          from unnest(${t.map((x) => x.id)}::uuid[], ${t.map((x) => x.tag)}::text[], ${t.map((x) => r2(x.h))}::numeric[])
               as x(id, tag, stunden)`;
    }
  }

  const schluessel = [
    ...Object.entries(erg.accKeys ?? {}).map(([name, s]) => ({ art: 'acc', name, s })),
    ...Object.entries(erg.berKeys ?? {}).map(([name, s]) => ({ art: 'ber', name, s })),
  ].filter((x) => x.name && x.s);
  if (schluessel.length) {
    await tx`
      insert into wca.schluessel (art, name, schluessel)
      select * from unnest(${schluessel.map((x) => x.art)}::text[], ${schluessel.map((x) => x.name)}::text[], ${schluessel.map((x) => x.s)}::text[])
      on conflict (art, name) do update set schluessel = excluded.schluessel`;
  }
  return ersetzt;
}

// ------------------------------------------------------------------ Modul

const mod: ServerModule = {
  id: 'wca',
  name: 'WCA Zeitenkontrolle',
  migrationsDir: path.join(APP_ROOT, 'modules', 'wca', 'server', 'migrations'),
  permissions: [
    { area: B, app: A, id: P.auswertung, text: 'Auswertung anzeigen: Vollständigkeit, Billable, Kontierungs- und Textprüfung je Person' },
    { area: B, app: A, id: P.importDisplay, text: 'Importe der Tempo-Zeitexporte anzeigen' },
    { area: B, app: A, id: P.importEdit, text: 'Tempo-Zeitexporte importieren und Importe löschen', requires: [P.importDisplay] },
    { area: B, app: A, id: P.einstellungenDisplay, text: 'Prüfregeln und Personenvorgaben anzeigen' },
    { area: B, app: A, id: P.einstellungenEdit, text: 'Prüfregeln und Personenvorgaben (Standort, Soll je Tag, Arbeitstage) ändern', requires: [P.einstellungenDisplay] },
  ],
  auditObjects: [
    { type: 'WCA_IMPORT', text: 'Tempo-Import (WCA)', permission: P.importDisplay },
    { type: 'WCA_EINST', text: 'Prüfregeln (WCA)', permission: P.einstellungenDisplay },
    { type: 'WCA_PERSON', text: 'Personenvorgabe (WCA)', permission: P.einstellungenDisplay },
    { type: 'WCA_FREIGABE', text: 'Freigegebener Text (WCA)', permission: P.einstellungenDisplay },
  ],

  routes(app) {
    // ------------------------------------------------------------------ Auswertung
    app.get('/auswertung', { preHandler: requireAuth(P.auswertung) }, async (req) => {
      const q = auswertungQuery.parse(req.query);
      const [eintraege, keys, einstellungen, vorgaben, [{ n, von, bis }], freigaben] = await Promise.all([
        eintraegeLesen(), schluesselLesen(), einstellungenLesen(), vorgabenLesen(),
        sql`select count(*)::int as n, min(von) as von, max(bis) as bis from wca.import`,
        sql`select regel, acc, text from wca.freigabe`,
      ]);
      // Datenbereich = Tagesspalten aller Importe (auch leere Tage am Ende zählen, z. B. für den Stichtag)
      return auswerten({
        eintraege, accKeys: keys.accKeys, berKeys: keys.berKeys, dateien: n, einstellungen, vorgaben,
        heute: heute(), stichtag: q.stichtag, zeitraum: q.zeitraum, datenBereich: { von: von ?? null, bis: bis ?? null },
        freigaben: freigaben as unknown as FreigabeSchluessel[],
      });
    });

    // ------------------------------------------------------------------ Import
    app.post('/import', { preHandler: requireAuth(P.importEdit), bodyLimit: 50 * 1024 * 1024 }, async (req): Promise<ImportAntwort> => {
      const b = importSchema.parse(req.body);
      const gelesen = b.dateien.map((d, i) => {
        try {
          return { i, d, erg: tempoCsvLesen(csvText(d.csv), d.name), fehler: null as string | null };
        } catch (e) {
          return { i, d, erg: null, fehler: (e as Error).message || 'Datei nicht lesbar' };
        }
      });
      const ergebnis: ImportAntwort['dateien'] = gelesen.map((g) => g.erg
        ? { datei: g.d.name, ...kennzahlen(g.erg), ersetzt: 0 }
        : { datei: g.d.name, fehler: g.fehler!, personen: 0, eintraege: 0, stunden: 0, ersetzt: 0, warnungen: [] });

      if (!b.uebernehmen) {
        for (const g of gelesen) if (g.erg) ergebnis[g.i].ersetzt = await ersetztZaehlen(DB, g.erg);
        return { uebernommen: false, dateien: ergebnis };
      }
      // Reihenfolge: ältere Datei zuerst, damit die neuere gewinnt (ohne Änderungsdatum zählt die Reihenfolge der Auswahl)
      const lesbar = gelesen.filter((g) => g.erg);
      if (!lesbar.length) throw new BusinessError(`Keine Datei lesbar: ${gelesen.map((g) => `${g.d.name}: ${g.fehler}`).join('; ')}`);
      if (lesbar.every((g) => g.d.geaendert)) lesbar.sort((x, y) => Date.parse(x.d.geaendert!) - Date.parse(y.d.geaendert!) || x.i - y.i);
      const wer = benutzer(req);
      await change(req, async (tx) => {
        for (const g of lesbar) ergebnis[g.i].ersetzt = await uebernehmen(tx, g.erg!, g.d.geaendert ?? null, wer);
      }, { action: 'WCA_IMPORT' });
      return { uebernommen: true, dateien: ergebnis };
    });

    app.get('/importe', { preHandler: requireAuth(P.importDisplay) }, async (): Promise<ImportZeile[]> => {
      const rows = await sql`
        select i.id, i.datei, i.von, i.bis, i.importiert_am as "importiertAm", i.importiert_von as "importiertVon",
               coalesce(x.personen, 0)::int as personen, coalesce(x.eintraege, 0)::int as eintraege, coalesce(x.stunden, 0)::float8 as stunden
          from wca.import i
          left join lateral (
            select count(distinct e.person) as personen, count(distinct e.id) as eintraege, sum(t.stunden) as stunden
              from wca.eintrag e join wca.eintrag_tag t on t.eintrag_id = e.id
             where e.import_id = i.id) x on true
         order by i.importiert_am desc, i.datei`;
      return rows.map((r) => ({
        id: r.id, datei: r.datei, von: r.von, bis: r.bis, personen: r.personen, eintraege: r.eintraege, stunden: r.stunden,
        importiertAm: r.importiertAm instanceof Date ? r.importiertAm.toISOString() : String(r.importiertAm), importiertVon: r.importiertVon,
      }));
    });

    app.delete('/importe/:id', { preHandler: requireAuth(P.importEdit) }, async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { reason } = grund.parse(req.body ?? {});
      await change(req, async (tx) => {
        const r = await tx`delete from wca.import where id = ${id}`;
        if (r.count === 0) throw new BusinessError('Import nicht gefunden.', 404);
      }, { action: 'LOESCHEN', reason });
      return { ok: true };
    });

    // ------------------------------------------------------------------ Einstellungen und Personenvorgaben
    app.get('/einstellungen', { preHandler: requireAuth(P.einstellungenDisplay) }, async () => {
      const [einstellungen, vorgaben, personen] = await Promise.all([
        einstellungenLesen(), vorgabenLesen(),
        sql`select person from wca.eintrag union select person from wca.person order by person`,
      ]);
      return { einstellungen, standard: STANDARD_EINSTELLUNGEN, vorgaben, personen: personen.map((r) => r.person as string) };
    });

    app.put('/einstellungen', { preHandler: requireAuth(P.einstellungenEdit) }, async (req) => {
      const teil = einstellungenSchema.parse(req.body ?? {}) as Partial<Einstellungen>;
      const voll = einstellungenErgaenzen(teil);
      await change(req, (tx) => tx`update wca.einstellungen set daten = ${tx.json(voll as never)} where id = 1`);
      return { ok: true, einstellungen: voll };
    });

    app.put('/personen/:person', { preHandler: requireAuth(P.einstellungenEdit) }, async (req) => {
      const { person } = personParam.parse(req.params);
      const v = vorgabeSchema.parse(req.body ?? {});
      await change(req, (tx) => tx`
        insert into wca.person (person, standort, soll_tag, arbeitstage, von, bis, ausblenden)
        values (${person}, ${v.standort}, ${v.sollTag}, ${v.arbeitstage}::int[], ${v.von}::date, ${v.bis}::date, ${v.ausblenden})
        on conflict (person) do update set
          standort = excluded.standort, soll_tag = excluded.soll_tag, arbeitstage = excluded.arbeitstage,
          von = excluded.von, bis = excluded.bis, ausblenden = excluded.ausblenden`);
      return { ok: true };
    });

    // ------------------------------------------------------------------ Freigaben (Text gilt für Regel + Account als in Ordnung)
    app.get('/freigaben', { preHandler: requireAuth(P.einstellungenDisplay) }, async () => freigabenLesen());

    app.post('/freigaben', { preHandler: requireAuth(P.einstellungenEdit) }, async (req) => {
      const v = freigabeSchema.parse(req.body ?? {});
      const acc = v.acc.trim();
      const norm = textNorm(v.text);
      await change(req, (tx) => tx`
        insert into wca.freigabe (regel, acc, text_norm, text, person, meldung, freigegeben_von)
        values (${v.regel}, ${acc}, ${norm}, ${v.text.trim()}, ${v.person}, ${v.meldung}, ${benutzer(req)})
        on conflict (regel, acc, text_norm) do nothing`, { action: 'WCA_FREIGABE' });
      return { ok: true };
    });

    app.delete('/freigaben/:id', { preHandler: requireAuth(P.einstellungenEdit) }, async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await change(req, async (tx) => {
        const r = await tx`delete from wca.freigabe where id = ${id}`;
        if (r.count === 0) throw new BusinessError('Freigabe nicht gefunden.', 404);
      });
      return { ok: true };
    });

    app.delete('/personen/:person', { preHandler: requireAuth(P.einstellungenEdit) }, async (req) => {
      const { person } = personParam.parse(req.params);
      await change(req, (tx) => tx`delete from wca.person where person = ${person}`);
      return { ok: true };
    });
  },
};

export default mod;
