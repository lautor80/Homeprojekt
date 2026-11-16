import { BusinessError } from '../../../../server/src/errors.js';
import { runden } from '../format.js';
import type { Db } from '../verein.js';
import { projektLesen, type Projekt } from '../haushalt/projekte.js';
import {
  arbeitWert, materialSumme, PlanungFehler, ressourcenSummen, terminieren, type RessourcenSummen, type VorgangEin,
} from './planung.js';

/**
 * Projekte – Termin- und Ressourcenplanung zu einem Projekt des Haushaltsplans (tco.hh_projekt).
 * Stammdaten, Kostenpositionen und Genehmigung gehören weiter dem Haushaltsplan (haushalt/projekte.ts); hier kommen
 * Vorgänge mit Abhängigkeiten, Arbeitseinsatz der Mitglieder und Material dazu.
 */

export interface Vorgang {
  id: number; nr: number; bezeichnung: string;
  /** von Hand gesetzter frühester Beginn */
  beginn_fix: string | null;
  dauer: number; fertig: number; verantwortlich: string | null; notiz: string | null;
  vorgaenger: { id: number; nr: number; abstand: number }[];
  /** gerechnet */
  beginn: string; ende: string; puffer: number; kritisch: boolean;
}
export interface Arbeit {
  id: number; vorgang_id: number | null; adrnr: string | null; name: string; taetigkeit: string | null;
  personen: number; stunden: number; satz: number | null;
  /** gerechnet: Satz der Zeile bzw. Vorgabe des Projekts, Personen × Stunden × Satz */
  satz_gilt: number; wert: number;
}
export interface Material {
  id: number; vorgang_id: number | null; bezeichnung: string; menge: number; einheit: string | null; preis: number; lieferant: string | null; beschafft: boolean;
  summe: number;
}
export interface Planung {
  stundensatz: number;
  vorgaenge: Vorgang[]; arbeit: Arbeit[]; material: Material[];
  /** aus den Vorgängen gerechnet; ohne Vorgänge die Laufzeit des Projekts */
  termin: { beginn: string; ende: string; tage: number; fertig: number };
  summen: RessourcenSummen;
  paperless: { id: number; am: string } | null;
}

const letzterTag = (monat: string) => { const [j, m] = monat.split('-').map(Number); return `${monat}-${String(new Date(Date.UTC(j, m, 0)).getUTCDate()).padStart(2, '0')}`; };

export async function planungLesen(db: Db, p: Projekt): Promise<Planung> {
  const [kopf] = await db`select stundensatz::float8 as stundensatz, antrag_paperless_id, antrag_paperless_am::text as am from tco.hh_projekt where id = ${p.id}`;
  const vg = await db`select id, bezeichnung, beginn::text as beginn, dauer, fertig, verantwortlich, notiz from tco.hh_projekt_vorgang where projekt_id = ${p.id} order by pos, id`;
  const ids = vg.map((v) => Number(v.id));
  const vor = ids.length ? await db`select vorgang_id, vorgaenger_id, abstand from tco.hh_projekt_vorgang_vor where vorgang_id = any(${ids}) order by vorgaenger_id` : [];
  const ar = await db`select id, vorgang_id, adrnr, name, taetigkeit, personen, stunden::float8 as stunden, satz::float8 as satz from tco.hh_projekt_arbeit where projekt_id = ${p.id} order by id`;
  const ma = await db`select id, vorgang_id, bezeichnung, menge::float8 as menge, einheit, preis::float8 as preis, lieferant, beschafft from tco.hh_projekt_material where projekt_id = ${p.id} order by id`;
  const stundensatz = Number(kopf?.stundensatz ?? 0);
  const ein: VorgangEin[] = vg.map((v) => ({
    key: String(v.id), bezeichnung: v.bezeichnung, beginn: v.beginn ?? null, dauer: Number(v.dauer),
    vorgaenger: vor.filter((x) => x.vorgang_id === v.id).map((x) => ({ key: String(x.vorgaenger_id), abstand: Number(x.abstand) })),
  }));
  const plan = terminieren(`${p.beginn}-01`, ein);
  const nr = new Map(ids.map((id, i) => [id, i + 1]));
  const vorgaenge: Vorgang[] = vg.map((v, i) => {
    const t = plan.termine.get(String(v.id))!;
    return {
      id: Number(v.id), nr: i + 1, bezeichnung: v.bezeichnung, beginn_fix: v.beginn ?? null, dauer: Number(v.dauer), fertig: Number(v.fertig),
      verantwortlich: v.verantwortlich ?? null, notiz: v.notiz ?? null,
      vorgaenger: vor.filter((x) => x.vorgang_id === v.id).map((x) => ({ id: Number(x.vorgaenger_id), nr: nr.get(Number(x.vorgaenger_id))!, abstand: Number(x.abstand) })).sort((a, b) => a.nr - b.nr),
      ...t,
    };
  });
  const arbeit: Arbeit[] = ar.map((a) => {
    const z = { adrnr: a.adrnr ?? null, name: a.name as string, personen: Number(a.personen), stunden: Number(a.stunden), satz: a.satz === null ? null : Number(a.satz) };
    return { id: Number(a.id), vorgang_id: a.vorgang_id === null ? null : Number(a.vorgang_id), taetigkeit: a.taetigkeit ?? null, ...z, satz_gilt: z.satz ?? stundensatz, wert: arbeitWert(z, stundensatz) };
  });
  const material: Material[] = ma.map((m) => {
    const z = { menge: Number(m.menge), preis: Number(m.preis), beschafft: !!m.beschafft };
    return { id: Number(m.id), vorgang_id: m.vorgang_id === null ? null : Number(m.vorgang_id), bezeichnung: m.bezeichnung, einheit: m.einheit ?? null, lieferant: m.lieferant ?? null, ...z, summe: materialSumme(z) };
  });
  const tage = vorgaenge.reduce((s, v) => s + Math.max(v.dauer, 1), 0);
  return {
    stundensatz, vorgaenge, arbeit, material,
    termin: vorgaenge.length
      ? { beginn: plan.beginn, ende: plan.ende, tage: plan.tage, fertig: Math.round(vorgaenge.reduce((s, v) => s + Math.max(v.dauer, 1) * v.fertig, 0) / tage) }
      : { beginn: `${p.beginn}-01`, ende: letzterTag(p.ende), tage: 0, fertig: 0 },
    summen: ressourcenSummen(arbeit, material, stundensatz),
    paperless: kopf?.antrag_paperless_id ? { id: Number(kopf.antrag_paperless_id), am: kopf.am } : null,
  };
}

export interface ProjektSicht { projekt: Projekt; planung: Planung }
export async function projektSicht(db: Db, id: number): Promise<ProjektSicht> {
  const projekt = await projektLesen(db, id);
  return { projekt, planung: await planungLesen(db, projekt) };
}

/** Kennzahlen der Planung je Projekt für die Übersicht (ein Lesen für alle) */
export async function planungKennzahlen(db: Db, projekte: Projekt[]): Promise<Map<number, { termin: Planung['termin']; summen: RessourcenSummen; vorgaenge: number }>> {
  const out = new Map<number, { termin: Planung['termin']; summen: RessourcenSummen; vorgaenge: number }>();
  for (const p of projekte) {
    const pl = await planungLesen(db, p);
    out.set(p.id, { termin: pl.termin, summen: pl.summen, vorgaenge: pl.vorgaenge.length });
  }
  return out;
}

export interface PlanungEingabe {
  stundensatz: number;
  /** key: beliebige Kennung der Zeile (bestehende ID oder Platzhalter) – darauf verweisen Vorgänger, Arbeit und Material */
  vorgaenge: { key: string; bezeichnung: string; beginn?: string | null; dauer: number; fertig: number; verantwortlich?: string | null; notiz?: string | null; vorgaenger: { key: string; abstand: number }[] }[];
  arbeit: { vorgang?: string | null; adrnr?: string | null; name: string; taetigkeit?: string | null; personen: number; stunden: number; satz?: number | null }[];
  material: { vorgang?: string | null; bezeichnung: string; menge: number; einheit?: string | null; preis: number; lieferant?: string | null; beschafft?: boolean }[];
}

const leer = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/**
 * Termin- und Ressourcenplanung eines Projekts als Ganzes sichern. Geprüft wird vorher, dass die Abhängigkeiten
 * aufgehen (kein Kreis). Ein abgeschlossenes Projekt wird nicht mehr geändert. Die Kostenpositionen bleiben unberührt.
 */
export async function planungSichern(tx: Db, id: number, e: PlanungEingabe): Promise<void> {
  const [p] = await tx`select status, beginn::text as beginn from tco.hh_projekt where id = ${id} for update`;
  if (!p) throw new BusinessError(`Projekt ${id} nicht gefunden.`, 404);
  if (p.status === 'ABGESCHLOSSEN') throw new BusinessError('Das Projekt ist abgeschlossen – die Planung wird nicht mehr geändert.');
  const keys = new Set(e.vorgaenge.map((v) => v.key));
  try {
    terminieren(String(p.beginn).slice(0, 10), e.vorgaenge.map((v) => ({ key: v.key, bezeichnung: v.bezeichnung, beginn: v.beginn || null, dauer: v.dauer, vorgaenger: v.vorgaenger })));
  } catch (f) {
    if (f instanceof PlanungFehler) throw new BusinessError(f.message);
    throw f;
  }
  for (const z of [...e.arbeit, ...e.material]) if (z.vorgang && !keys.has(z.vorgang)) throw new BusinessError('Eine Ressource verweist auf einen Vorgang, den es nicht (mehr) gibt.');
  const adrnrs = [...new Set(e.arbeit.map((a) => leer(a.adrnr)).filter(Boolean) as string[])];
  if (adrnrs.length) {
    const da = new Set((await tx`select adrnr from tco.mitglieder where adrnr = any(${adrnrs})`).map((m) => m.adrnr as string));
    const fehlt = adrnrs.find((a) => !da.has(a));
    if (fehlt) throw new BusinessError(`Das Mitglied ${fehlt} gibt es nicht.`);
  }
  await tx`update tco.hh_projekt set stundensatz = ${runden(e.stundensatz)} where id = ${id} and stundensatz is distinct from ${runden(e.stundensatz)}`;
  await tx`delete from tco.hh_projekt_arbeit where projekt_id = ${id}`;
  await tx`delete from tco.hh_projekt_material where projekt_id = ${id}`;
  await tx`delete from tco.hh_projekt_vorgang where projekt_id = ${id}`;
  const neu = new Map<string, number>();
  for (const [i, v] of e.vorgaenge.entries()) {
    const [r] = await tx`insert into tco.hh_projekt_vorgang (projekt_id, pos, bezeichnung, beginn, dauer, fertig, verantwortlich, notiz)
                         values (${id}, ${i + 1}, ${v.bezeichnung.trim()}, ${v.beginn || null}, ${v.dauer}, ${v.fertig}, ${leer(v.verantwortlich)}, ${leer(v.notiz)}) returning id`;
    neu.set(v.key, Number(r.id));
  }
  for (const v of e.vorgaenge) {
    const gesehen = new Set<string>();
    for (const x of v.vorgaenger) {
      if (gesehen.has(x.key)) continue;
      gesehen.add(x.key);
      await tx`insert into tco.hh_projekt_vorgang_vor (vorgang_id, vorgaenger_id, abstand) values (${neu.get(v.key)!}, ${neu.get(x.key)!}, ${x.abstand})`;
    }
  }
  for (const a of e.arbeit) {
    await tx`insert into tco.hh_projekt_arbeit (projekt_id, vorgang_id, adrnr, name, taetigkeit, personen, stunden, satz)
             values (${id}, ${a.vorgang ? neu.get(a.vorgang)! : null}, ${leer(a.adrnr)}, ${a.name.trim()}, ${leer(a.taetigkeit)}, ${leer(a.adrnr) ? 1 : a.personen}, ${a.stunden}, ${a.satz ?? null})`;
  }
  for (const m of e.material) {
    await tx`insert into tco.hh_projekt_material (projekt_id, vorgang_id, bezeichnung, menge, einheit, preis, lieferant, beschafft)
             values (${id}, ${m.vorgang ? neu.get(m.vorgang)! : null}, ${m.bezeichnung.trim()}, ${m.menge}, ${leer(m.einheit)}, ${runden(m.preis)}, ${leer(m.lieferant)}, ${!!m.beschafft})`;
  }
}

/** aktive Mitglieder für den Arbeitseinsatz */
export async function mitgliederLesen(db: Db): Promise<{ adrnr: string; name: string }[]> {
  return (await db`select adrnr, vorname, nachname from tco.mitglieder where austritt is null or austritt >= current_date order by nachname, vorname`)
    .map((r) => ({ adrnr: r.adrnr as string, name: `${r.nachname ?? ''}, ${r.vorname ?? ''}`.replace(/\s+/g, ' ').replace(/^, |, $/g, '').trim() }));
}
