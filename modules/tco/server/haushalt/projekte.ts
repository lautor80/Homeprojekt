import { BusinessError } from '../../../../server/src/errors.js';
import type { Aufgabe } from '../../../../server/src/lib/arbeitsvorrat.js';
import { heute as heuteText, runden } from '../format.js';
import type { Db } from '../verein.js';
import { kontenStamm } from '../abschluss/logik.js';
import { kontoart } from '../finanz/logik.js';
import {
  budget, einrechnenVorgabe, ENTSCHEIDUNG, POSITION_TEXT, STATUS_TEXT, UEBERGAENGE, wirktIm, wirkung,
  type Budget, type PositionArt, type ProjektPosition, type ProjektStatus, type Verteilung, type Wirkung,
} from './projekt.js';
import { bewerten, type Bewertung } from './vorschlag.js';

/**
 * Haushaltsplan – Projekte: Stammdaten, Genehmigung, Wirkung auf einen Plan und Soll-Ist je Projekt.
 * Ist-Kosten kommen aus den FI-Buchungen mit der Projektnummer des Projekts (tco.fibuchungen.projekt); FI wird nur gelesen.
 */

export const P_PROJEKT = { approve: 'tco.projekte:approve' };

export interface Projekt {
  id: number; projektnr: string | null; bezeichnung: string; beschreibung: string | null; verantwortlich: string | null;
  /** JJJJ-MM */
  beginn: string; ende: string; bereich: string | null;
  status: ProjektStatus; status_text: string; status_am: string | null; status_von: string | null; status_grund: string | null;
  positionen: (ProjektPosition & { id: number; art_text: string })[];
  budget: Budget;
  /** aus FI: Buchungen mit der Projektnummer, Ausgaben und Einnahmen über die ganze Laufzeit */
  ist: { kosten: number; einnahmen: number; buchungen: number };
  bewertung: Bewertung | null;
  verlauf: { am: string; von: string; status: ProjektStatus; status_text: string; grund: string | null }[];
  /** nächste zulässige Status */
  uebergaenge: ProjektStatus[];
}

const ym = (d: unknown) => String(d ?? '').slice(0, 7);
const erster = (m: string | null | undefined) => (m ? `${m.slice(0, 7)}-01` : null);

/** Projektnummern aller Projekte des Haushaltsplans – ihre Buchungen sind Projektbuchungen */
export async function projektnummern(db: Db): Promise<string[]> {
  return (await db`select projektnr from tco.hh_projekt where coalesce(trim(projektnr), '') <> ''`).map((r) => String(r.projektnr).trim());
}

/** Ist je Projektnummer aus FI: Ausgabekonten Soll − Haben, Einnahmekonten Haben − Soll (Kontoart wie in „Einnahmen und Ausgaben“) */
async function istLesen(db: Db, nummern: string[]): Promise<Map<string, { kosten: number; einnahmen: number; buchungen: number; jahre: Map<number, { kosten: number; einnahmen: number }> }>> {
  const out = new Map<string, { kosten: number; einnahmen: number; buchungen: number; jahre: Map<number, { kosten: number; einnahmen: number }> }>();
  if (!nummern.length) return out;
  const stamm = await kontenStamm(db);
  const rows = await db`
    select trim(projekt) as projekt, konto, coalesce(jahr, extract(year from datum)::int) as jahr, count(*)::int as n,
           coalesce(sum(soll), 0)::float8 as soll, coalesce(sum(haben), 0)::float8 as haben
      from tco.fibuchungen where trim(projekt) = any(${nummern}) group by 1, 2, 3`;
  for (const r of rows) {
    const art = kontoart(String(r.konto).trim(), stamm.get(r.konto)?.kennzahl ?? null);
    if (art !== 'E' && art !== 'A') continue;
    let e = out.get(r.projekt);
    if (!e) { e = { kosten: 0, einnahmen: 0, buchungen: 0, jahre: new Map() }; out.set(r.projekt, e); }
    let j = e.jahre.get(Number(r.jahr));
    if (!j) { j = { kosten: 0, einnahmen: 0 }; e.jahre.set(Number(r.jahr), j); }
    const w = art === 'A' ? r.soll - r.haben : r.haben - r.soll;
    if (art === 'A') { e.kosten = runden(e.kosten + w); j.kosten = runden(j.kosten + w); } else { e.einnahmen = runden(e.einnahmen + w); j.einnahmen = runden(j.einnahmen + w); }
    e.buchungen += Number(r.n);
  }
  return out;
}

export async function projekteLesen(db: Db, cfg: { toleranz_gelb: number; toleranz_rot: number } = { toleranz_gelb: 5, toleranz_rot: 10 }): Promise<Projekt[]> {
  const pr = await db`select id, projektnr, bezeichnung, beschreibung, verantwortlich, beginn::text as beginn, ende::text as ende, bereich, status,
                             status_am::text as status_am, status_von, status_grund from tco.hh_projekt order by beginn, id`;
  if (!pr.length) return [];
  const pos = await db`select id, projekt_id, art, bezeichnung, betrag::float8 as betrag, konto, verteilung, von::text as von, bis::text as bis, monate
                         from tco.hh_projekt_position order by projekt_id, id`;
  const ver = await db`select projekt_id, am::text as am, von, status, grund from tco.hh_projekt_verlauf order by am, id`;
  const ist = await istLesen(db, pr.map((p) => String(p.projektnr ?? '').trim()).filter(Boolean));
  return pr.map((p) => {
    const positionen = pos.filter((x) => x.projekt_id === p.id).map((x) => ({
      id: Number(x.id), art: x.art as PositionArt, art_text: POSITION_TEXT[x.art as PositionArt], bezeichnung: x.bezeichnung ?? null, betrag: Number(x.betrag),
      konto: x.konto ?? null, verteilung: x.verteilung as Verteilung, von: x.von ? ym(x.von) : null, bis: x.bis ? ym(x.bis) : null,
      monate: (x.monate ?? {}) as Record<string, number>,
    }));
    const b = budget(positionen);
    const i = ist.get(String(p.projektnr ?? '').trim());
    const status = p.status as ProjektStatus;
    return {
      id: Number(p.id), projektnr: p.projektnr ?? null, bezeichnung: p.bezeichnung, beschreibung: p.beschreibung ?? null, verantwortlich: p.verantwortlich ?? null,
      beginn: ym(p.beginn), ende: ym(p.ende), bereich: p.bereich ?? null, status, status_text: STATUS_TEXT[status],
      status_am: p.status_am ?? null, status_von: p.status_von ?? null, status_grund: p.status_grund ?? null, positionen, budget: b,
      ist: { kosten: i?.kosten ?? 0, einnahmen: i?.einnahmen ?? 0, buchungen: i?.buchungen ?? 0 },
      // Ist-Kosten gegen das Projektbudget – bewertet wie ein Ausgabenkonto
      bewertung: i || b.kosten ? bewerten('A', b.kosten, i?.kosten ?? 0, cfg.toleranz_gelb, cfg.toleranz_rot) : null,
      verlauf: ver.filter((v) => v.projekt_id === p.id).map((v) => ({ am: v.am, von: v.von, status: v.status as ProjektStatus, status_text: STATUS_TEXT[v.status as ProjektStatus], grund: v.grund ?? null })),
      uebergaenge: UEBERGAENGE[status],
    };
  });
}

export async function projektLesen(db: Db, id: number): Promise<Projekt> {
  const p = (await projekteLesen(db)).find((x) => x.id === id);
  if (!p) throw new BusinessError(`Projekt ${id} nicht gefunden.`, 404);
  return p;
}

export interface ProjektEingabe {
  id?: number | null; projektnr?: string | null; bezeichnung: string; beschreibung?: string | null; verantwortlich?: string | null;
  beginn: string; ende: string; bereich?: string | null; positionen: ProjektPosition[];
}

/** Ab „beantragt“ ändert nur noch, wer genehmigen darf – sonst ließe sich ein genehmigtes Budget still verändern */
const FREI: ProjektStatus[] = ['IDEE', 'ZURUECKGESTELLT'];

/** Projekt mit seinen Positionen anlegen bzw. ändern */
export async function projektSichern(tx: Db, e: ProjektEingabe, benutzer: string, darfGenehmigen: boolean): Promise<number> {
  if (!/^\d{4}-\d{2}$/.test(e.beginn) || !/^\d{4}-\d{2}$/.test(e.ende)) throw new BusinessError('Bitte Beginn und Ende als Monat angeben (JJJJ-MM).');
  if (e.ende < e.beginn) throw new BusinessError('Das Ende des Projekts liegt vor dem Beginn.');
  const nr = e.projektnr?.trim() || null;
  const stamm = await kontenStamm(tx);
  for (const p of e.positionen) {
    const konto = p.konto?.trim();
    if (konto) {
      const art = kontoart(konto, stamm.get(konto)?.kennzahl ?? null);
      if (!stamm.has(konto)) throw new BusinessError(`Konto ${konto} gibt es im Kontenstamm nicht.`);
      const soll = p.art === 'ZUSCHUSS' || p.art === 'SPENDE' ? 'E' : p.art === 'KOSTEN' || p.art === 'FOLGEKOSTEN' || p.art === 'EINSPARUNG' ? 'A' : '';
      if (soll && art !== soll) throw new BusinessError(`${POSITION_TEXT[p.art]}: Konto ${konto} ist kein ${soll === 'E' ? 'Einnahme' : 'Ausgabe'}konto.`);
    }
    if (!(p.betrag >= 0)) throw new BusinessError('Beträge der Positionen dürfen nicht negativ sein (eine Einsparung ist eine eigene Art).');
    if (p.verteilung === 'JAEHRLICH' && p.art !== 'FOLGEKOSTEN' && p.art !== 'EINSPARUNG') throw new BusinessError('„Jährlich wiederkehrend“ gibt es nur für Folgekosten und Einsparungen.');
    if (p.von && p.bis && p.bis < p.von) throw new BusinessError('Bei einer Position liegt „bis“ vor „von“.');
  }
  let id = e.id ?? null;
  if (id) {
    const [alt] = await tx`select status from tco.hh_projekt where id = ${id} for update`;
    if (!alt) throw new BusinessError(`Projekt ${id} nicht gefunden.`, 404);
    if (!FREI.includes(alt.status) && !darfGenehmigen) {
      throw new BusinessError(`Das Projekt ist ${STATUS_TEXT[alt.status as ProjektStatus]} – ändern kann es jetzt nur, wer Projekte genehmigen darf.`);
    }
    await tx`update tco.hh_projekt set projektnr = ${nr}, bezeichnung = ${e.bezeichnung.trim()}, beschreibung = ${e.beschreibung?.trim() || null},
                    verantwortlich = ${e.verantwortlich?.trim() || null}, beginn = ${erster(e.beginn)}, ende = ${erster(e.ende)}, bereich = ${e.bereich || null} where id = ${id}`;
    await tx`delete from tco.hh_projekt_position where projekt_id = ${id}`;
  } else {
    const [n] = await tx`insert into tco.hh_projekt (projektnr, bezeichnung, beschreibung, verantwortlich, beginn, ende, bereich, status_von, angelegt_von)
                         values (${nr}, ${e.bezeichnung.trim()}, ${e.beschreibung?.trim() || null}, ${e.verantwortlich?.trim() || null}, ${erster(e.beginn)}, ${erster(e.ende)},
                                 ${e.bereich || null}, ${benutzer}, ${benutzer}) returning id`;
    id = Number(n.id);
    await tx`insert into tco.hh_projekt_verlauf (projekt_id, von, status) values (${id}, ${benutzer}, 'IDEE')`;
  }
  for (const p of e.positionen) {
    const monate = p.verteilung === 'HAND' ? Object.fromEntries(Object.entries(p.monate ?? {}).filter(([m, b]) => /^\d{4}-\d{2}$/.test(m) && Number(b)).map(([m, b]) => [m, runden(Number(b))])) : {};
    const betrag = p.verteilung === 'HAND' ? runden(Object.values(monate).reduce((a, b) => a + b, 0)) : runden(p.betrag);
    await tx`insert into tco.hh_projekt_position (projekt_id, art, bezeichnung, betrag, konto, verteilung, von, bis, monate)
             values (${id}, ${p.art}, ${p.bezeichnung?.trim() || null}, ${betrag}, ${p.konto?.trim() || null}, ${p.verteilung}, ${erster(p.von)}, ${erster(p.bis)}, ${tx.json(monate)})`;
  }
  return id;
}

/** Status setzen: beantragen, entscheiden (genehmigen, ablehnen, zurückstellen – mit dem Recht dazu), umsetzen, abschließen */
export async function projektStatus(tx: Db, id: number, ziel: ProjektStatus, grund: string | null, benutzer: string, darfGenehmigen: boolean): Promise<Projekt> {
  const [p] = await tx`select status, bezeichnung from tco.hh_projekt where id = ${id} for update`;
  if (!p) throw new BusinessError(`Projekt ${id} nicht gefunden.`, 404);
  const von = p.status as ProjektStatus;
  if (!UEBERGAENGE[von].includes(ziel)) throw new BusinessError(`Das Projekt ist ${STATUS_TEXT[von]} – „${STATUS_TEXT[ziel]}“ ist von dort nicht möglich.`);
  if (ENTSCHEIDUNG.includes(ziel) && !darfGenehmigen) throw new BusinessError('Über einen Projektantrag entscheidet, wer das Recht „Projekte genehmigen“ hat.', 403);
  if ((ziel === 'ABGELEHNT' || ziel === 'ZURUECKGESTELLT') && !grund?.trim()) throw new BusinessError('Bitte die Entscheidung begründen.');
  if (ziel === 'BEANTRAGT') {
    const [n] = await tx`select count(*)::int as n from tco.hh_projekt_position where projekt_id = ${id} and art = 'KOSTEN'`;
    if (!n.n) throw new BusinessError('Ein Antrag braucht mindestens eine Kostenposition.');
  }
  await tx`update tco.hh_projekt set status = ${ziel}, status_am = now(), status_von = ${benutzer}, status_grund = ${grund?.trim() || null} where id = ${id}`;
  await tx`insert into tco.hh_projekt_verlauf (projekt_id, von, status, grund) values (${id}, ${benutzer}, ${ziel}, ${grund?.trim() || null})`;
  return projektLesen(tx, id);
}

/** Löschen nur, solange nichts entschieden und das Projekt in keinem beschlossenen Plan festgeschrieben ist */
export async function projektLoeschen(tx: Db, id: number): Promise<string> {
  const [p] = await tx`select status, bezeichnung from tco.hh_projekt where id = ${id} for update`;
  if (!p) throw new BusinessError(`Projekt ${id} nicht gefunden.`, 404);
  if (p.status !== 'IDEE' && p.status !== 'ABGELEHNT') throw new BusinessError(`Das Projekt ist ${STATUS_TEXT[p.status as ProjektStatus]} und kann nicht gelöscht werden.`);
  const [fest] = await tx`select count(*)::int as n from tco.hh_plan_projekt pp join tco.hh_plan pl on pl.id = pp.plan_id where pp.projekt_id = ${id} and pl.status <> 'ENTWURF'`;
  if (fest.n) throw new BusinessError('Das Projekt ist in einem beschlossenen Haushaltsplan festgehalten und kann nicht gelöscht werden.');
  await tx`delete from tco.hh_plan_projekt where projekt_id = ${id}`;
  await tx`delete from tco.hh_projekt where id = ${id}`;
  return p.bezeichnung;
}

// ---------------------------------------------------------------------------
// Wirkung auf einen Plan (Simulation)
// ---------------------------------------------------------------------------

export interface PlanProjekt {
  id: number; bezeichnung: string; projektnr: string | null; status: ProjektStatus; status_text: string; beginn: string; ende: string;
  einrechnen: boolean;
  /** Vorgabe nach dem Status; `gewaehlt` = am Plan ausdrücklich gesetzt */
  vorgabe: boolean; gewaehlt: boolean;
  /** festgeschrieben mit dem Beschluss des Plans */
  fest: boolean;
  wirkung: Wirkung;
}

/**
 * Projekte, die im Planjahr wirken, mit ihrer Wirkung und der Entscheidung „einrechnen“. In einem beschlossenen Plan
 * gilt, was beim Beschluss festgeschrieben wurde – spätere Änderungen am Projekt verändern die Fassung nicht.
 */
export async function planProjekte(db: Db, plan: { id: number; jahr: number; status: string }): Promise<PlanProjekt[]> {
  const wahl = await db`select projekt_id, einrechnen, fest from tco.hh_plan_projekt where plan_id = ${plan.id}`;
  const alle = await projekteLesen(db);
  const out: PlanProjekt[] = [];
  if (plan.status !== 'ENTWURF') {
    for (const w of wahl) {
      const f = w.fest as (Omit<PlanProjekt, 'einrechnen' | 'vorgabe' | 'gewaehlt' | 'fest'>) | null;
      if (!f) continue;
      out.push({ ...f, id: Number(w.projekt_id), einrechnen: !!w.einrechnen, vorgabe: !!w.einrechnen, gewaehlt: true, fest: true });
    }
    return out.sort((a, b) => a.beginn.localeCompare(b.beginn) || a.id - b.id);
  }
  for (const p of alle) {
    const w = wirkung(p, plan.jahr);
    if (!wirktIm(w)) continue;
    const g = wahl.find((x) => Number(x.projekt_id) === p.id);
    const vorgabe = einrechnenVorgabe(p.status);
    out.push({
      id: p.id, bezeichnung: p.bezeichnung, projektnr: p.projektnr, status: p.status, status_text: p.status_text, beginn: p.beginn, ende: p.ende,
      einrechnen: g ? !!g.einrechnen : vorgabe, vorgabe, gewaehlt: !!g, fest: false, wirkung: w,
    });
  }
  return out;
}

/** „Einrechnen“ am Plan setzen (null = wieder die Vorgabe nach dem Status) – nur im Entwurf, das prüft der Aufrufer */
export async function planProjektSetzen(tx: Db, planId: number, projektId: number, einrechnen: boolean | null): Promise<void> {
  const [p] = await tx`select 1 from tco.hh_projekt where id = ${projektId}`;
  if (!p) throw new BusinessError(`Projekt ${projektId} nicht gefunden.`, 404);
  if (einrechnen === null) { await tx`delete from tco.hh_plan_projekt where plan_id = ${planId} and projekt_id = ${projektId}`; return; }
  await tx`insert into tco.hh_plan_projekt (plan_id, projekt_id, einrechnen) values (${planId}, ${projektId}, ${einrechnen})
           on conflict (plan_id, projekt_id) do update set einrechnen = excluded.einrechnen`;
}

/** Beim Beschluss: für jedes im Planjahr wirkende Projekt festhalten, ob und mit welchen Werten es eingerechnet ist */
export async function planProjekteFestschreiben(tx: Db, plan: { id: number; jahr: number; status: string }): Promise<void> {
  for (const p of await planProjekte(tx, plan)) {
    const { einrechnen, vorgabe: _v, gewaehlt: _g, fest: _f, id, ...rest } = p;
    await tx`insert into tco.hh_plan_projekt (plan_id, projekt_id, einrechnen, fest) values (${plan.id}, ${id}, ${einrechnen}, ${tx.json(rest as never)})
             on conflict (plan_id, projekt_id) do update set einrechnen = excluded.einrechnen, fest = excluded.fest`;
  }
}

/** Nachtrag: die Auswahl der Vorfassung übernehmen (als Entwurf wieder frei, ohne festgeschriebene Werte) */
export async function planProjekteKopieren(tx: Db, vonPlan: number, nachPlan: number): Promise<void> {
  await tx`insert into tco.hh_plan_projekt (plan_id, projekt_id, einrechnen) select ${nachPlan}, projekt_id, einrechnen from tco.hh_plan_projekt where plan_id = ${vonPlan}`;
}

// ---------------------------------------------------------------------------
// Soll-Ist je Projekt und Arbeitsvorrat
// ---------------------------------------------------------------------------

export interface ProjektSollIst {
  id: number; bezeichnung: string; projektnr: string | null; status: ProjektStatus; status_text: string; beginn: string; ende: string;
  /** Budget und Ist über die ganze Laufzeit */
  budget: number; ist: number; einnahmen_plan: number; einnahmen_ist: number;
  /** Anteil des Jahres: geplant laut Verteilung, gebucht laut FI */
  plan_jahr: number; ist_jahr: number;
  bewertung: Bewertung;
}

/** Projekte, die im Jahr laufen oder gebucht wurden: Ist-Kosten aus FI gegen das Projektbudget, bewertet wie ein Konto */
export async function projekteSollIst(db: Db, jahr: number, cfg: { toleranz_gelb: number; toleranz_rot: number }): Promise<ProjektSollIst[]> {
  const alle = await projekteLesen(db, cfg);
  const ist = await istLesen(db, alle.map((p) => String(p.projektnr ?? '').trim()).filter(Boolean));
  const out: ProjektSollIst[] = [];
  for (const p of alle) {
    if (p.status === 'ABGELEHNT') continue;
    const w = wirkung(p, jahr);
    const i = ist.get(String(p.projektnr ?? '').trim());
    const ij = i?.jahre.get(jahr);
    const kostenJahr = runden(p.positionen.filter((x) => x.art === 'KOSTEN').reduce((a, x) => a + wirkung({ beginn: p.beginn, ende: p.ende, positionen: [x] }, jahr).sum.ausgaben, 0));
    if (!wirktIm(w) && !ij) continue;
    out.push({
      id: p.id, bezeichnung: p.bezeichnung, projektnr: p.projektnr, status: p.status, status_text: p.status_text, beginn: p.beginn, ende: p.ende,
      budget: p.budget.kosten, ist: p.ist.kosten, einnahmen_plan: runden(p.budget.zuschuss + p.budget.spende), einnahmen_ist: p.ist.einnahmen,
      plan_jahr: kostenJahr, ist_jahr: ij?.kosten ?? 0,
      bewertung: bewerten('A', p.budget.kosten, p.ist.kosten, cfg.toleranz_gelb, cfg.toleranz_rot),
    });
  }
  return out;
}

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Arbeitsvorrat: beantragte Projekte für alle, die genehmigen dürfen; überschrittene Projektbudgets für den Kassenwart.
 * `genehmiger` / `leser` sagen, was der Benutzer sehen darf.
 */
export async function projektAufgaben(db: Db, o: { genehmiger: boolean; leser: boolean; ueberwachung: boolean }, cfg: { toleranz_gelb: number; toleranz_rot: number }, heute = heuteText()): Promise<Aufgabe[]> {
  const out: Aufgabe[] = [];
  const alle = o.genehmiger || o.leser ? await projekteLesen(db, cfg) : [];
  if (o.genehmiger) {
    for (const p of alle.filter((x) => x.status === 'BEANTRAGT')) {
      out.push({
        key: `HHPROJEKT:${p.id}`, bereich: 'Vorstand', icon: 'capital-projects', state: 'Critical',
        titel: `Projektantrag: ${p.bezeichnung}`,
        text: `Kosten ${eur(p.budget.kosten)} € · Finanzierung ${eur(p.budget.finanzierung)} € · ${p.beginn.slice(5)}/${p.beginn.slice(0, 4)} bis ${p.ende.slice(5)}/${p.ende.slice(0, 4)}`
          + `${p.status_von ? ` · beantragt von ${p.status_von}` : ''} – genehmigen, ablehnen oder zurückstellen`,
        datum: p.status_am?.slice(0, 10) ?? heute, pfad: '/tco/haushalt?tab=projekte', betrag: p.budget.kosten,
      });
    }
  }
  if (o.leser && o.ueberwachung) {
    for (const p of alle.filter((x) => (x.status === 'GENEHMIGT' || x.status === 'UMSETZUNG') && x.bewertung?.stufe === 'UEBERSCHRITTEN')) {
      out.push({
        key: `HHPROJEKTBUDGET:${p.id}`, bereich: 'Kassenwart', icon: 'capital-projects', state: 'Negative',
        titel: `Projektbudget überschritten: ${p.bezeichnung}`,
        text: `Budget ${eur(p.budget.kosten)} € · gebucht ${eur(p.ist.kosten)} € (Projekt ${p.projektnr})`,
        datum: heute, pfad: '/tco/haushalt?tab=sollist', betrag: runden(p.ist.kosten - p.budget.kosten),
      });
    }
  }
  return out;
}

/** Vorschläge für die Projektnummer: Stamm tco.projekte und bereits gebuchte Nummern, die noch kein Projekt des Haushaltsplans sind */
export async function projektnummernVorschlag(db: Db): Promise<string[]> {
  const r = await db`select nr from (select trim(projektnr) as nr from tco.projekte union select trim(projekt) from tco.fibuchungen where coalesce(trim(projekt), '') <> '') x
                      where coalesce(nr, '') <> '' order by nr`;
  return r.map((x) => String(x.nr));
}
