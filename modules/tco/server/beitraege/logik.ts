import { BusinessError } from '../../../../server/src/errors.js';
import { addTage, condense, dat, heute, runden, zahl } from '../format.js';
import type { Db } from '../verein.js';

/**
 * Beitragsstamm – Port von ZCL_TCO_BEITRAG und Z2UI5_CL_TCO_BEITRAEGE.
 *   tco.beitrag     Beitragsarten (Bezeichnung, Turnus, Erlöskonto, aktiv/inaktiv)
 *   tco.beitrag_pr  zeitabhängige Beträge je Beitragsart, lückenlos, letzter Zeitraum offen bis 31.12.9999
 *
 * Ein Vertrag (tco.vertraege) zahlt den Betrag, der am Stichtag für seine Art gilt. Nur mit
 * betrag_indiv gilt der Betrag am Vertrag. Inaktive Beitragsarten werden weiter eingezogen, können
 * aber keinen neuen Verträgen mehr zugeordnet werden.
 */

export const OFFEN = '9999-12-31';
export const START = '1900-01-01';

/** Turnusse wie im Auswahlfeld der SAP-App (Schlüssel = Wert in tco.vertraege.sollstellung) */
export const TURNUS: { key: string; text: string }[] = [
  { key: 'monatlich', text: 'monatlich' },
  { key: 'vierteljährl.', text: 'vierteljährlich' },
  { key: 'halbjährl.', text: 'halbjährlich' },
  { key: 'jährlich', text: 'jährlich' },
  { key: 'einmalig', text: 'einmalig' },
];

export interface Preis { art: string; gueltig_ab: string; gueltig_bis: string; betrag: number; aenam: string | null; aedat: string | null }
export interface Art {
  art: string; bezeichnung: string; turnus: string; erloeskonto: string; aktiv: boolean;
  ernam: string | null; erdat: string | null; aenam: string | null; aedat: string | null;
}
export interface ArtStichtag extends Art { betrag: number; gueltig_ab: string | null; naechst_ab: string | null; naechst_betr: number | null }

/** Art wie in SAP: ohne Leerzeichen (führende Nullen bleiben, wie im Bestand) */
export const artNorm = (a: unknown) => condense(String(a ?? ''));
const offen = (d: string | null | undefined) => (d ? d.slice(0, 10) : OFFEN);

/** numerische Sortierung (1, 3, 5, 90, 101 …), nicht-numerische Arten hinten alphabetisch */
export function artSort(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? Number(a) : Number.POSITIVE_INFINITY;
  const nb = /^\d+$/.test(b) ? Number(b) : Number.POSITIVE_INFINITY;
  return na - nb || a.localeCompare(b, 'de');
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

export async function artenRoh(db: Db): Promise<Art[]> {
  const r = await db`select art, coalesce(bezeichnung, '') as bezeichnung, coalesce(turnus, '') as turnus, coalesce(erloeskonto, '') as erloeskonto, aktiv,
                            ernam, erdat::text as erdat, aenam, aedat::text as aedat
                       from tco.beitrag`;
  return r.map((x) => ({ ...x, art: artNorm(x.art), bezeichnung: condense(x.bezeichnung), turnus: condense(x.turnus), erloeskonto: condense(x.erloeskonto) })) as unknown as Art[];
}

/** Zeiträume aller bzw. einer Beitragsart, aufsteigend nach gültig ab */
export async function preiseLesen(db: Db, art?: string): Promise<Preis[]> {
  const r = art === undefined
    ? await db`select art, gueltig_ab::text as gueltig_ab, gueltig_bis::text as gueltig_bis, coalesce(betrag, 0)::float8 as betrag, aenam, aedat::text as aedat
                 from tco.beitrag_pr order by art, gueltig_ab`
    : await db`select art, gueltig_ab::text as gueltig_ab, gueltig_bis::text as gueltig_bis, coalesce(betrag, 0)::float8 as betrag, aenam, aedat::text as aedat
                 from tco.beitrag_pr where art = ${artNorm(art)} order by gueltig_ab`;
  return r.map((x) => ({ art: artNorm(x.art), gueltig_ab: x.gueltig_ab, gueltig_bis: offen(x.gueltig_bis), betrag: Number(x.betrag), aenam: x.aenam, aedat: x.aedat }));
}

/** Betrag, der am Stichtag für die Beitragsart gilt (BETRAG_ERMITTELN) */
export function betragErmitteln(pr: Preis[], art: string, datum: string): { betrag: number; gefunden: boolean } {
  const a = artNorm(art);
  const p = pr.find((x) => x.art === a && x.gueltig_ab <= datum && x.gueltig_bis >= datum);
  return p ? { betrag: p.betrag, gefunden: true } : { betrag: 0, gefunden: false };
}

/** Betrag eines Vertrags am Stichtag: individueller Betrag oder Stamm; Art nicht im Stamm → Betrag am Vertrag (VERTRAGSBETRAG) */
export function vertragsbetrag(pr: Preis[], art: string, betrag: number, indiv: boolean, datum: string): number {
  if (indiv) return betrag;
  const b = betragErmitteln(pr, art, datum);
  return b.gefunden ? b.betrag : betrag;
}

/** Summe der Vertragsbeträge am Stichtag für Art und/oder Bezeichnung (SUMME_STICHTAG) */
export async function summeStichtag(db: Db, sel: { art?: string; artname?: string }, datum: string, pr?: Preis[]): Promise<number> {
  const preise = pr ?? (await preiseLesen(db));
  const a = artNorm(sel.art);
  const v = a
    ? await db`select art, artname, coalesce(betrag, 0)::float8 as betrag, betrag_indiv from tco.vertraege
                where art = ${a} and vertragbegin <= ${datum} and (vertragende is null or vertragende >= ${datum})`
    : await db`select art, artname, coalesce(betrag, 0)::float8 as betrag, betrag_indiv from tco.vertraege
                where artname = ${sel.artname ?? ''} and vertragbegin <= ${datum} and (vertragende is null or vertragende >= ${datum})`;
  let s = 0;
  for (const x of v) {
    if (sel.artname !== undefined && (x.artname ?? '') !== sel.artname) continue;
    s += vertragsbetrag(preise, x.art, Number(x.betrag), !!x.betrag_indiv, datum);
  }
  return runden(s);
}

/** Erlöskonto der Beitragsart (leer, wenn nicht gepflegt) */
export async function erloeskonto(db: Db, art: string): Promise<string> {
  const [a] = await db`select erloeskonto from tco.beitrag where art = ${artNorm(art)}`;
  return condense(String(a?.erloeskonto ?? ''));
}

/** Ist die Beitragsart für neue Verträge zugelassen? */
export async function istAktiv(db: Db, art: string): Promise<boolean> {
  const [a] = await db`select aktiv from tco.beitrag where art = ${artNorm(art)}`;
  return !!a?.aktiv;
}

/** Beitragsarten mit Betrag zum Stichtag und nächster Änderung (ARTEN_LESEN), numerisch sortiert */
export async function artenLesen(db: Db, nurAktive = false, stichtag = heute()): Promise<ArtStichtag[]> {
  const arten = await artenRoh(db);
  const pr = await preiseLesen(db);
  const out: ArtStichtag[] = [];
  for (const a of arten) {
    if (nurAktive && !a.aktiv) continue;
    const r: ArtStichtag = { ...a, betrag: 0, gueltig_ab: null, naechst_ab: null, naechst_betr: null };
    for (const p of pr.filter((x) => x.art === a.art)) {
      if (p.gueltig_ab <= stichtag && p.gueltig_bis >= stichtag) {
        r.betrag = p.betrag;
        r.gueltig_ab = p.gueltig_ab;
      } else if (p.gueltig_ab > stichtag && !r.naechst_ab) {
        r.naechst_ab = p.gueltig_ab;
        r.naechst_betr = p.betrag;
      }
    }
    out.push(r);
  }
  return out.sort((x, y) => artSort(x.art, y.art));
}

// ---------------------------------------------------------------------------
// Zeiträume bearbeiten (reine Funktionen, liefern eine neue Liste)
// ---------------------------------------------------------------------------

const sortiert = (pr: Preis[]) => [...pr].map((p) => ({ ...p })).sort((a, b) => a.gueltig_ab.localeCompare(b.gueltig_ab));

/** Neuen Betrag ab Datum einfügen; der betroffene Zeitraum wird geteilt (BETRAG_AB_EINFUEGEN) */
export function betragAbEinfuegen(pr: Preis[], art: string, ab: string, betrag: number): Preis[] {
  const a = artNorm(art);
  const l = sortiert(pr);
  const neu = (gueltig_ab: string, gueltig_bis: string): Preis => ({ art: a, gueltig_ab, gueltig_bis, betrag, aenam: null, aedat: null });
  // gleicher Beginn → nur Betrag ändern
  const gl = l.find((p) => p.gueltig_ab === ab);
  if (gl) { gl.betrag = betrag; return l; }
  if (!l.length) return [neu(ab, OFFEN)];
  // Beginn vor dem ersten Zeitraum → neuer erster Zeitraum bis zum Vortag des bisherigen ersten
  if (ab < l[0].gueltig_ab) return [neu(ab, addTage(l[0].gueltig_ab, -1)), ...l];
  // betroffenen Zeitraum teilen
  const i = l.findIndex((p) => p.gueltig_ab < ab && p.gueltig_bis >= ab);
  if (i >= 0) {
    const bis = l[i].gueltig_bis;
    l[i].gueltig_bis = addTage(ab, -1);
    l.splice(i + 1, 0, neu(ab, bis));
  }
  return l;
}

/** Zeitraum entfernen; der vorherige Zeitraum wird verlängert (ZEITRAUM_ENTFERNEN) */
export function zeitraumEntfernen(pr: Preis[], ab: string): Preis[] {
  const l = sortiert(pr);
  const i = l.findIndex((p) => p.gueltig_ab === ab);
  if (i < 0 || l.length <= 1) return l;
  const [del] = l.splice(i, 1);
  if (i > 0) l[i - 1].gueltig_bis = del.gueltig_bis;    // Vorgänger übernimmt das Ende
  else l[0].gueltig_ab = del.gueltig_ab;                 // erster entfernt → neuer erster beginnt beim alten Beginn
  return l;
}

/** Prüft Zeiträume: lückenlos, ohne Überschneidung, offenes Ende (PREISE_PRUEFEN); leer = in Ordnung */
export function preisePruefen(pr: Preis[]): string {
  if (!pr.length) return 'Es muss mindestens ein Zeitraum mit Betrag vorhanden sein.';
  const l = sortiert(pr);
  let prevBis = '';
  for (let i = 0; i < l.length; i++) {
    const p = l[i];
    const ab = dat(p.gueltig_ab);
    if (!p.gueltig_ab || !p.gueltig_bis) return 'Jeder Zeitraum braucht ein Von- und ein Bis-Datum.';
    if (p.gueltig_bis < p.gueltig_ab) return `Zeitraum ab ${ab}: Bis-Datum liegt vor dem Von-Datum.`;
    if (p.betrag < 0) return `Zeitraum ab ${ab}: Der Betrag darf nicht negativ sein.`;
    if (i > 0) {
      if (p.gueltig_ab <= prevBis) return `Zeitraum ab ${ab} überschneidet sich mit dem vorherigen Zeitraum.`;
      if (p.gueltig_ab !== addTage(prevBis, 1)) return `Vor dem Zeitraum ab ${ab} gibt es eine Lücke. Zeiträume müssen lückenlos sein.`;
    }
    prevBis = p.gueltig_bis;
  }
  if (prevBis !== OFFEN) return 'Der letzte Zeitraum muss offen sein (bis 31.12.9999).';
  return '';
}

/** Zeitraum-Zeilen für die Anzeige (PR_AUFBEREITEN) */
export function preiseAufbereiten(pr: Preis[], stichtag = heute()) {
  const l = sortiert(pr);
  return l.map((p) => ({
    ...p,
    ab_txt: datumTxt(p.gueltig_ab), bis_txt: datumTxt(p.gueltig_bis),
    info: p.gueltig_ab <= stichtag && p.gueltig_bis >= stichtag ? 'gilt heute' : p.gueltig_ab > stichtag ? 'geplant' : 'abgelaufen',
    state: p.gueltig_ab <= stichtag && p.gueltig_bis >= stichtag ? 'Positive' : p.gueltig_ab > stichtag ? 'Information' : 'None',
    loeschbar: l.length > 1,
  }));
}

/** Datum wie in der SAP-App: offen / Beginn / TT.MM.JJJJ */
export const datumTxt = (d: string | null) => (!d ? '' : d === OFFEN ? 'offen' : d === START ? 'Beginn' : dat(d));

// ---------------------------------------------------------------------------
// Sichern
// ---------------------------------------------------------------------------

export interface ArtEingabe { art: string; bezeichnung: string; turnus: string; erloeskonto: string; aktiv: boolean }

/**
 * Beitragsart und Zeiträume prüfen und sichern (SICHERN). Unveränderte Zeiträume behalten ihre Änderungsinfo.
 * Liefert zusätzlich den Hinweis auf bestehende Sollstellungspositionen ab dem frühesten geänderten Zeitraum.
 */
export async function sichern(tx: Db, e: ArtEingabe, prEingabe: Preis[], neu: boolean, benutzer: string): Promise<{ text: string; warnung: string | null }> {
  const art = artNorm(e.art);
  const bezeichnung = condense(e.bezeichnung);
  const turnus = condense(e.turnus);
  const konto = condense(e.erloeskonto);
  if (!art) throw new BusinessError('Bitte eine Beitragsart (Nummer) angeben.');
  if (!bezeichnung) throw new BusinessError('Bitte eine Bezeichnung angeben.');
  if (!turnus) throw new BusinessError('Bitte einen Turnus angeben.');
  if (!konto) throw new BusinessError('Das Erlöskonto ist Pflicht.');
  const [k] = await tx`select konto from tco.fikonten where konto = ${konto}`;
  if (!k) throw new BusinessError(`Das Erlöskonto ${konto} gibt es im Kontenstamm nicht.`);

  const [alt] = await tx`select art, ernam, erdat::text as erdat from tco.beitrag where art = ${art}`;
  if (neu && alt) throw new BusinessError(`Die Beitragsart ${art} gibt es bereits.`);
  if (neu) {
    const [va] = await tx`select art from tco.vertraege where art = ${art} limit 1`;
    if (va) throw new BusinessError(`Die Nummer ${art} wird bereits in Verträgen verwendet.`);
  }

  const pr = sortiert(prEingabe).map((p) => ({ ...p, art, betrag: runden(Number(p.betrag) || 0) }));
  const fehler = preisePruefen(pr);
  if (fehler) throw new BusinessError(fehler);

  // Hinweis bei Änderung von Zeiträumen, für die schon Sollstellungen bestehen (frühestes geändertes „gültig ab“)
  const altPr = await preiseLesen(tx, art);
  const geaendert: string[] = [];
  for (const a of altPr) {
    const n = pr.find((p) => p.gueltig_ab === a.gueltig_ab);
    if (!n || n.gueltig_bis !== a.gueltig_bis || n.betrag !== a.betrag) geaendert.push(a.gueltig_ab);
  }
  for (const n of pr) if (!altPr.some((a) => a.gueltig_ab === n.gueltig_ab)) geaendert.push(n.gueltig_ab);
  const abMin: string | null = geaendert.length ? geaendert.sort()[0] : null;

  const h = heute();
  if (alt) {
    await tx`update tco.beitrag set bezeichnung = ${bezeichnung}, turnus = ${turnus}, erloeskonto = ${konto}, aktiv = ${e.aktiv},
                                    aenam = ${benutzer}, aedat = ${h} where art = ${art}`;
  } else {
    await tx`insert into tco.beitrag (art, bezeichnung, turnus, erloeskonto, aktiv, ernam, erdat)
             values (${art}, ${bezeichnung}, ${turnus}, ${konto}, ${e.aktiv}, ${benutzer}, ${h})`;
  }
  // Zeiträume: unveränderte behalten die Änderungsinfo
  await tx`delete from tco.beitrag_pr where art = ${art}`;
  for (const p of pr) {
    const a = altPr.find((x) => x.gueltig_ab === p.gueltig_ab);
    const gleich = !!a && a.gueltig_bis === p.gueltig_bis && a.betrag === p.betrag;
    await tx`insert into tco.beitrag_pr (art, gueltig_ab, gueltig_bis, betrag, aenam, aedat)
             values (${art}, ${p.gueltig_ab}, ${p.gueltig_bis}, ${p.betrag}, ${gleich ? a!.aenam : benutzer}, ${gleich ? a!.aedat : h})`;
  }

  let text = `Beitrag ${art} "${bezeichnung}" gesichert.`;
  let warnung: string | null = null;
  if (!neu && abMin) {
    const per = abMin.slice(0, 4) + abMin.slice(5, 7);
    const [s] = await tx`select count(*)::int as n from tco.soll_pos where art = ${art} and sollper >= ${per}`;
    if (s.n > 0) {
      warnung = `Hinweis: Ab ${datumTxt(abMin)} gibt es bereits ${s.n} Sollstellungsposition(en). `
        + 'Bereits erzeugte Lastschriften bleiben unverändert, der neue Betrag gilt für künftige Läufe.';
    }
  }
  if (!e.aktiv) text += ' Der Beitrag ist inaktiv: laufende Verträge werden weiter eingezogen, neue Zuordnungen sind gesperrt.';
  return { text, warnung };
}

/** Schalter „Aktiv“ in der Übersicht: sofort sichern (AKTIV_UMSCHALTEN) */
export async function aktivUmschalten(tx: Db, art: string, aktiv: boolean, benutzer: string): Promise<string> {
  const a = artNorm(art);
  const [alt] = await tx`select bezeichnung from tco.beitrag where art = ${a}`;
  if (!alt) throw new BusinessError(`Beitragsart ${a} nicht gefunden.`);
  await tx`update tco.beitrag set aktiv = ${aktiv}, aenam = ${benutzer}, aedat = ${heute()} where art = ${a}`;
  const bez = condense(String(alt.bezeichnung ?? ''));
  return aktiv
    ? `Beitrag ${a} "${bez}" ist aktiv und kann wieder zugeordnet werden.`
    : `Beitrag ${a} "${bez}" ist inaktiv: laufende Verträge werden weiter eingezogen, neue Zuordnungen sind gesperrt.`;
}

// ---------------------------------------------------------------------------
// Vorschläge
// ---------------------------------------------------------------------------

/** Nächste freie numerische Art (< 90 Mitgliedschaft, 90–99 sonstige, ab 100 Spenden) */
export async function artVorschlag(db: Db, ab = 1, bis = 89): Promise<string> {
  const used = new Set<number>();
  for (const r of await db`select distinct art from tco.vertraege union select art from tco.beitrag`) {
    const s = artNorm(r.art);
    if (/^\d+$/.test(s)) used.add(Number(s));
  }
  for (let i = ab; i <= bis; i++) if (!used.has(i)) return String(i);
  return '';
}

/** Erlöskonto-Vorschlag nach bisheriger Logik der Sollstellung (90 → 8006, ab 100 → 8100, sonst 8002) */
export function erloeskontoVorschlag(art: string): string {
  const s = artNorm(art);
  if (!/^\d+$/.test(s)) return '8002';
  const n = Number(s);
  return n === 90 ? '8006' : n >= 100 ? '8100' : '8002';
}

/** Erlöskonten (8…) aus dem Kontenstamm, plus das aktuell eingetragene Konto (LISTEN_LESEN) */
export async function kontenLesen(db: Db, aktuell = ''): Promise<{ key: string; text: string }[]> {
  const r = await db`select konto, name from tco.fikonten order by konto`;
  return r.map((k) => ({ key: condense(String(k.konto)), name: String(k.name ?? '') }))
    .filter((k) => k.key.startsWith('8') || k.key === aktuell)
    .map((k) => ({ key: k.key, text: `${k.key} – ${k.name}` }));
}

/** Erster des Folgemonats (Vorschlag für „neuer Betrag gültig ab“) */
export function folgemonatErster(d = heute()): string {
  const j = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  return m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, '0')}-01`;
}

// ---------------------------------------------------------------------------
// Übersicht und Detail (Z2UI5_CL_TCO_BEITRAEGE)
// ---------------------------------------------------------------------------

export interface UebersichtZeile {
  art: string; bezeichnung: string; turnus: string; konto: string; betrag: number; seit: string; naechst: string;
  vertraege: number; aktiv: boolean; status: string; state: 'Positive' | 'Critical'; gruppe: string;
}

/** Gruppe nach Turnus wie in der SAP-App */
export function turnusGruppe(turnus: string): string {
  const t = turnus.toLowerCase();
  if (t.includes('monat')) return '1 · monatlich';
  if (t.includes('viertel')) return '2 · vierteljährlich';
  if (t.includes('halb')) return '3 · halbjährlich';
  if (t.includes('jähr') || t.includes('jahr')) return '4 · jährlich';
  return '5 · einmalig / sonstige';
}

/** laufende Verträge je Art (vertragende leer oder >= heute) */
async function laufendeJeArt(db: Db): Promise<Map<string, number>> {
  const r = await db`select art, count(*)::int as n from tco.vertraege where vertragende is null or vertragende >= current_date group by art`;
  return new Map(r.map((x) => [artNorm(x.art), Number(x.n)]));
}

export async function uebersicht(db: Db): Promise<{ leer: boolean; zeilen: UebersichtZeile[] }> {
  const arten = await artenLesen(db);
  const cnt = await laufendeJeArt(db);
  return {
    leer: !arten.length,
    zeilen: arten.map((a) => ({
      art: a.art, bezeichnung: a.bezeichnung, turnus: a.turnus, konto: a.erloeskonto, betrag: a.betrag,
      seit: datumTxt(a.gueltig_ab),
      naechst: a.naechst_ab ? `ab ${datumTxt(a.naechst_ab)}: ${zahl(a.naechst_betr ?? 0)} €` : '',
      vertraege: cnt.get(a.art) ?? 0, aktiv: a.aktiv,
      status: a.aktiv ? 'Aktiv' : 'Inaktiv', state: a.aktiv ? 'Positive' : 'Critical', gruppe: turnusGruppe(a.turnus),
    })),
  };
}

export interface VertragZeile {
  adrnr: string; vertragnr: string; name: string; mitglnr: string; vertragbegin: string | null; vertragende: string | null;
  betrag: number; betrag_indiv: boolean; betrag_heute: number; sollstellung: string; laeuft: boolean;
}

/** Verträge einer Beitragsart (laufende zuerst) mit dem heute geltenden Betrag */
export async function vertraegeLesen(db: Db, art: string, pr?: Preis[]): Promise<VertragZeile[]> {
  const a = artNorm(art);
  const preise = pr ?? (await preiseLesen(db, a));
  const h = heute();
  const r = await db`select v.adrnr, v.vertragnr, coalesce(v.mitglnr, '') as mitglnr, v.vertragbegin::text as vertragbegin, v.vertragende::text as vertragende,
                            coalesce(v.betrag, 0)::float8 as betrag, v.betrag_indiv, coalesce(v.sollstellung, '') as sollstellung,
                            coalesce(m.nachname, '') as nachname, coalesce(m.vorname, '') as vorname
                       from tco.vertraege v left join tco.mitglieder m on m.adrnr = v.adrnr
                      where v.art = ${a}
                      order by (v.vertragende is null or v.vertragende >= current_date) desc, m.nachname, m.vorname, v.vertragnr`;
  return r.map((x) => ({
    adrnr: x.adrnr, vertragnr: x.vertragnr, mitglnr: String(x.mitglnr).replace(/^0+(?=\d)/, ''),
    name: x.nachname || x.vorname ? `${x.nachname}, ${x.vorname}`.replace(/^, |, $/g, '') : `Adresse ${x.adrnr}`,
    vertragbegin: x.vertragbegin, vertragende: x.vertragende, betrag: Number(x.betrag), betrag_indiv: !!x.betrag_indiv,
    betrag_heute: vertragsbetrag(preise, a, Number(x.betrag), !!x.betrag_indiv, h), sollstellung: condense(String(x.sollstellung)),
    laeuft: !x.vertragende || x.vertragende >= h,
  }));
}

/** Daten für den Bearbeitungsdialog (POPUP_OEFFNEN) */
export async function detail(db: Db, art: string) {
  const a = artNorm(art);
  const [x] = await db`select art, coalesce(bezeichnung, '') as bezeichnung, coalesce(turnus, '') as turnus, coalesce(erloeskonto, '') as erloeskonto, aktiv,
                              ernam, erdat::text as erdat, aenam, aedat::text as aedat from tco.beitrag where art = ${a}`;
  if (!x) throw new BusinessError(`Beitragsart ${a} nicht gefunden.`);
  const pr = await preiseLesen(db, a);
  const vertraege = await vertraegeLesen(db, a, pr);
  const lauf = vertraege.filter((v) => v.laeuft).length;
  const indiv = vertraege.filter((v) => v.laeuft && v.betrag_indiv).length;
  const turnus = condense(String(x.turnus));
  const konto = condense(String(x.erloeskonto));
  const turnusse = TURNUS.some((t) => t.key === turnus) || !turnus ? TURNUS : [...TURNUS, { key: turnus, text: turnus }];
  return {
    neu: false,
    art: a, bezeichnung: condense(String(x.bezeichnung)), turnus, konto, aktiv: !!x.aktiv,
    ernam: x.ernam, erdat: x.erdat, aenam: x.aenam, aedat: x.aedat,
    vertraege_txt: `${lauf} laufende Verträge${indiv > 0 ? `, davon ${indiv} mit individuellem Betrag` : ''}`,
    vertraege,
    preise: preiseAufbereiten(pr),
    neu_ab: folgemonatErster(),
    turnusse, konten: await kontenLesen(db, konto),
  };
}

/** Vorbelegung für einen neuen Beitrag (POPUP_NEU) */
export async function vorschlagNeu(db: Db) {
  const art = await artVorschlag(db);
  const h = heute();
  return {
    neu: true, art, bezeichnung: '', turnus: 'halbjährl.', konto: erloeskontoVorschlag(art), aktiv: true,
    vertraege_txt: '', vertraege: [] as VertragZeile[], preise: [] as ReturnType<typeof preiseAufbereiten>,
    neu_ab: `${h.slice(0, 7)}-01`, turnusse: TURNUS, konten: await kontenLesen(db, erloeskontoVorschlag(art)),
  };
}

// ---------------------------------------------------------------------------
// Erstbefüllung aus den Verträgen (INITIAL_BEFUELLEN)
// ---------------------------------------------------------------------------

export async function initialBefuellen(tx: Db, test: boolean, benutzer: string): Promise<string[]> {
  const log: string[] = [];
  const [c] = await tx`select count(*)::int as n from tco.beitrag`;
  if (c.n > 0) throw new BusinessError('Der Beitragsstamm ist bereits aufgebaut.');
  const h = heute();

  const v = await tx`select art, coalesce(artname, '') as artname, coalesce(sollstellung, '') as sollstellung, coalesce(betrag, 0)::float8 as betrag,
                            vertragbegin::text as vertragbegin, vertragende::text as vertragende
                       from tco.vertraege order by art, vertragbegin desc nulls last`;
  // Betrag je Art: häufigster Betrag der laufenden Verträge, sonst der Betrag des jüngsten Vertrags
  const cnt = await tx`select art, coalesce(betrag, 0)::float8 as betrag, count(*)::int as cnt from tco.vertraege
                        where vertragende is null or vertragende >= current_date group by art, betrag
                        order by art, cnt desc, betrag desc`;
  const haeufigst = new Map<string, number>();
  for (const x of cnt) if (!haeufigst.has(artNorm(x.art))) haeufigst.set(artNorm(x.art), Number(x.betrag));

  const arten: { art: string; bezeichnung: string; turnus: string; konto: string; aktiv: boolean; betrag: number }[] = [];
  for (const x of v) {
    const art = artNorm(x.art);
    if (!art || arten.some((a) => a.art === art)) continue;
    const offen = haeufigst.has(art);
    const betrag = offen ? haeufigst.get(art)! : Number(x.betrag);
    const konto = erloeskontoVorschlag(art);
    arten.push({ art, bezeichnung: condense(x.artname), turnus: condense(x.sollstellung), konto, aktiv: offen, betrag });
    log.push(`Art ${art} ${condense(x.artname)}: ${zahl(betrag)} EUR, ${condense(x.sollstellung)}, Konto ${konto}${offen ? '' : ', INAKTIV (keine laufenden Verträge)'}`);
  }

  // Verträge mit abweichendem Betrag → individueller Betrag
  let indiv = 0, indivOffen = 0;
  const alle = await tx`select adrnr, vertragnr, art, coalesce(betrag, 0)::float8 as betrag, vertragende::text as vertragende from tco.vertraege`;
  for (const x of alle) {
    const a = arten.find((y) => y.art === artNorm(x.art));
    if (!a || a.betrag === Number(x.betrag)) continue;
    indiv++;
    if (!x.vertragende || x.vertragende >= h) {
      indivOffen++;
      log.push(`  individuell (laufend): Mitglied ${String(x.adrnr).replace(/^0+(?=\d)/, '')} Vertrag ${x.vertragnr} Art ${artNorm(x.art)} ${zahl(Number(x.betrag))} EUR`);
    }
    if (!test) await tx`update tco.vertraege set betrag_indiv = true where adrnr = ${x.adrnr} and vertragnr = ${x.vertragnr}`;
  }
  log.push(`${arten.length} Beitragsarten, ${indiv} Verträge mit individuellem Betrag (${indivOffen} laufend)`);

  if (!test) {
    for (const a of arten) {
      await tx`insert into tco.beitrag (art, bezeichnung, turnus, erloeskonto, aktiv, ernam, erdat) values (${a.art}, ${a.bezeichnung}, ${a.turnus}, ${a.konto}, ${a.aktiv}, ${benutzer}, ${h})`;
      await tx`insert into tco.beitrag_pr (art, gueltig_ab, gueltig_bis, betrag, aenam, aedat) values (${a.art}, ${START}, ${OFFEN}, ${a.betrag}, ${benutzer}, ${h})`;
    }
    log.push('Gesichert.');
  } else {
    log.push('Testlauf - nichts gesichert.');
  }
  return log;
}
