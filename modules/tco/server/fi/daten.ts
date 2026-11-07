import type { Db } from '../verein.js';
import { runden } from '../format.js';

/** Port von Z2UI5_CL_TCO_FIBUCHUNGEN_V4 – Lesen, Salden, Konten */

export interface Konto { konto: string; name: string; kennzahl: string | null; gruppe: string; aktiv: boolean }

export const RG_STATUS: Record<string, string> = {
  '1': 'In Bearbeitung', '2': 'Gedruckt', '3': 'Versendet', '4': 'Bezahlt', '5': 'Teilbezahlt', '6': 'Forderung ausgefallen',
};

/** Gruppierung der Kontoauswahl (KONTO_GRUPPE) */
export function kontoGruppe(konto: string, kennzahl: string | null): string {
  if (kennzahl === 'BA' || kennzahl === 'BK') return '1 · Bank-, Kassen- und Kreditkonten';
  const n = Number(konto);
  if (n >= 2000 && n <= 7999) return '2 · Aufwandskonten';
  if (n >= 8000 && n <= 8999) return '3 · Erlöskonten';
  return '4 · Anlage- und sonstige Konten';
}

/** Kontenplan mit Verwendung im Jahr (kein Eintrag in fikontojahr = aktiv) */
export async function kontenLesen(db: Db, jahr: number): Promise<Konto[]> {
  const rows = await db`
    select k.konto, coalesce(k.name, '') as name, k.kennzahl, coalesce(j.aktiv, true) as aktiv
      from tco.fikonten k left join tco.fikontojahr j on j.konto = k.konto and j.jahr = ${jahr}`;
  return rows
    .map((r) => ({ konto: r.konto, name: r.name, kennzahl: r.kennzahl, aktiv: r.aktiv, gruppe: kontoGruppe(r.konto, r.kennzahl) }))
    .sort((a, b) => a.gruppe.localeCompare(b.gruppe) || Number(a.konto) - Number(b.konto) || a.konto.localeCompare(b.konto));
}

/**
 * Anfangsbestand eines Kontos im Jahr: Anfangsbestand aus fibankab, sonst Endbestand des Vorjahres,
 * sonst fortgeschrieben aus dem jüngsten gepflegten Anfangsbestand plus allen Buchungen bis Jahresbeginn.
 */
export async function anfangsbestand(db: Db, konto: string, jahr: number): Promise<{ betrag: number; quelle: string }> {
  const [a] = await db`select anfangsbestand::float8 as a from tco.fibankab where konto = ${konto} and jahr = ${jahr} and anfangsbestand is not null`;
  if (a) return { betrag: a.a, quelle: `Anfangsbestand ${jahr}` };
  const [e] = await db`select endbestand::float8 as e from tco.fibankab where konto = ${konto} and jahr = ${jahr - 1} and endbestand is not null`;
  if (e) return { betrag: e.e, quelle: `Endbestand ${jahr - 1}` };
  const [j] = await db`
    select jahr, anfangsbestand::float8 as a from tco.fibankab
     where konto = ${konto} and jahr < ${jahr} and anfangsbestand is not null order by jahr desc limit 1`;
  const ab = j ? `${j.jahr}-01-01` : '0001-01-01';
  const [s] = await db`
    select coalesce(sum(coalesce(soll, 0) - coalesce(haben, 0)), 0)::float8 as s from tco.fibuchungen
     where konto = ${konto} and datum >= ${ab} and datum < ${`${jahr}-01-01`}`;
  return { betrag: runden((j?.a ?? 0) + s.s), quelle: j ? `Anfangsbestand ${j.jahr} fortgeschrieben` : 'Summe aller Buchungen' };
}

/** Kontostand zu einem Stichtag (einschließlich) – eine Rechnung für Liste, Bankabgleich und Kasse */
export async function kontostand(db: Db, konto: string, stichtag: string): Promise<number> {
  const jahr = Number(stichtag.slice(0, 4));
  const ab = await anfangsbestand(db, konto, jahr);
  const [s] = await db`
    select coalesce(sum(coalesce(soll, 0) - coalesce(haben, 0)), 0)::float8 as s from tco.fibuchungen
     where konto = ${konto} and datum >= ${`${jahr}-01-01`} and datum <= ${stichtag}`;
  return runden(ab.betrag + s.s);
}

/** Tagessalden eines Kontos im Jahr: Jahresanfang, Saldo je Tag mit Buchung, Saldo der letzten Buchung */
export async function salden(db: Db, konto: string, jahr: number) {
  const ab = await anfangsbestand(db, konto, jahr);
  const rows = await db`
    select datum::text as datum, sum(coalesce(soll, 0) - coalesce(haben, 0))::float8 as s from tco.fibuchungen
     where konto = ${konto} and jahr = ${jahr} group by datum order by datum`;
  const tag: Record<string, number> = {};
  let laufend = ab.betrag;
  for (const r of rows) {
    laufend = runden(laufend + r.s);
    tag[r.datum] = laufend;
  }
  return {
    jahresanfang: ab.betrag, quelle: ab.quelle, tag,
    aktuell: laufend, aktuellDatum: rows.length ? rows[rows.length - 1].datum : null,
  };
}

export interface Zeile {
  key: string;
  internenr: string | null;
  konto: string;
  posnr: number;
  datum: string;
  text: string;
  betrag: number;          // vorzeichenbehaftet aus Sicht des Kontos (Soll +, Haben −)
  gkonto: string | null;
  gkontoName: string;
  kontoName: string;
  belnr: string;
  rgnr_txt: string | null;
  split: string | null;    // „Split 1/3 · gesamt …“
  anhaenge: number;
  notizen: number;
  letzteNotiz: string | null;
  storniert: string | null;   // durch Stornobeleg
  stornoZu: string | null;    // ist Storno zu
  sammel: number;             // > 0: Sammelposition mit n Belegen
  hallenmiete: boolean;       // Rechnungszuordnung möglich
}

/** Buchungsliste für Zeitraum und Konto (leer = alle Konten) */
export async function buchungenLesen(db: Db, von: string, bis: string, konto: string | null): Promise<Zeile[]> {
  const rows = await db`
    select b.internenr, b.konto, b.posnr, b.datum::text as datum, coalesce(b.text, '') as text,
           (coalesce(b.soll, 0) - coalesce(b.haben, 0))::float8 as betrag, b.gkonto, coalesce(b.belnr, '') as belnr,
           b.rgnr_txt, b.storno_zu,
           coalesce(k.name, '') as konto_name, coalesce(g.name, '') as gkonto_name,
           (select count(*)::int from tco.fipapermap m where m.internenr = b.internenr) as anhaenge,
           (select count(*)::int from tco.finotiz n where n.internenr = b.internenr) as notizen,
           (select n.notiz from tco.finotiz n where n.internenr = b.internenr order by n.erstellt_am desc limit 1) as letzte_notiz,
           (select s.internenr from tco.fibuchungen s where s.storno_zu = b.internenr limit 1) as storniert,
           count(*) over (partition by b.internenr, b.konto)::int as pos_anz,
           row_number() over (partition by b.internenr, b.konto order by b.posnr)::int as pos_nr,
           (sum(coalesce(b.soll, 0) - coalesce(b.haben, 0)) over (partition by b.internenr, b.konto))::float8 as pos_summe
      from tco.fibuchungen b
      left join tco.fikonten k on k.konto = b.konto
      left join tco.fikonten g on g.konto = b.gkonto
     where b.datum between ${von} and ${bis} ${konto ? db`and b.konto = ${konto}` : db``}
     order by b.datum desc, b.internenr desc, b.konto, b.posnr`;

  // Hallenmiete: Konto 8003 oder Gegenkonto 8003 (Bankseite) – bei Splitbuchung je 8003-Position
  const zeilen: Zeile[] = rows.map((r) => ({
    key: `${r.internenr}|${r.konto}|${r.posnr}`,
    internenr: r.internenr, konto: r.konto, posnr: r.posnr, datum: r.datum, text: r.text,
    betrag: runden(r.betrag), gkonto: r.gkonto, gkontoName: r.gkonto_name, kontoName: r.konto_name,
    belnr: (r.belnr as string).split(',')[0], rgnr_txt: r.rgnr_txt || null,
    split: r.pos_anz > 1 ? `Split ${r.pos_nr}/${r.pos_anz} · gesamt ${runden(r.pos_summe).toFixed(2).replace('.', ',')}` : null,
    anhaenge: r.anhaenge, notizen: r.notizen, letzteNotiz: r.letzte_notiz, storniert: r.storniert, stornoZu: r.storno_zu,
    sammel: 0, hallenmiete: r.konto === '8003' || r.gkonto === '8003',
  }));
  return sammelpositionen(zeilen);
}

/**
 * Sammelpositionen: Zeilen mit Gegenkonto 8002/8006, die sich am selben Tag die ext. Belegnummer mit
 * mindestens einer weiteren internen Nummer teilen (alte Sollstellungsläufe, Linear-Sammeleinzüge).
 */
function sammelpositionen(z: Zeile[]): Zeile[] {
  const gruppen = new Map<string, Zeile[]>();
  for (const r of z) {
    if (!r.belnr || !['8002', '8006'].includes(r.gkonto ?? '')) continue;
    const k = `${r.datum}|${r.konto}|${r.belnr}`;
    gruppen.set(k, [...(gruppen.get(k) ?? []), r]);
  }
  const weg = new Set<string>();
  const neu: Zeile[] = [];
  for (const [k, g] of gruppen) {
    if (new Set(g.map((x) => x.internenr)).size < 2) continue;
    g.forEach((x) => weg.add(x.key));
    const f = g[0];
    neu.push({
      ...f, key: `S|${k}`, internenr: null, posnr: 0,
      text: `Sammelposition ${f.gkontoName || f.gkonto} (${g.length} Belege)`,
      betrag: runden(g.reduce((s, x) => s + x.betrag, 0)), gkonto: null, gkontoName: '', rgnr_txt: null, split: null,
      anhaenge: 0, notizen: 0, letzteNotiz: null, storniert: null, stornoZu: null, sammel: g.length, hallenmiete: false,
    });
  }
  return [...z.filter((r) => !weg.has(r.key)), ...neu]
    .sort((a, b) => b.datum.localeCompare(a.datum) || (b.internenr ?? '').localeCompare(a.internenr ?? ''));
}

/** Offene Hallenrechnungen für die Zuordnung (Status ≠ 4/6) mit gezahltem Betrag */
export async function offeneRechnungen(db: Db) {
  const rows = await db`
    select r.rgnr_txt, r.kunde, r.betrag::float8 as betrag, r.status,
           coalesce((select sum(t.betrag) from tco.rgtz t where t.rgnr_txt = r.rgnr_txt), 0)::float8 as gezahlt
      from tco.rgkopf r where r.status not in ('4', '6') order by r.rgnr_txt desc`;
  return rows.map((r) => ({ ...r, offen: runden(Math.max(r.betrag - r.gezahlt, 0)) }));
}

/** Teilzahlungen je Rechnung (Popover) – alle Rechnungen mit mindestens einer Teilzahlung oder die gewählte */
export async function zahlungen(db: Db, rgnr: string | null) {
  const rows = await db`
    select t.rgnr_txt, t.fibeleg, t.betrag::float8 as betrag, r.kunde, r.betrag::float8 as rg_betrag, r.status,
           (select b.datum::text from tco.fibuchungen b where b.internenr = t.fibeleg order by b.posnr limit 1) as datum,
           coalesce((select b.text from tco.fibuchungen b where b.internenr = t.fibeleg order by b.posnr limit 1),
                    concat_ws(' ', t.vorname, t.nachname)) as text
      from tco.rgtz t join tco.rgkopf r on r.rgnr_txt = t.rgnr_txt
     where ${rgnr ? db`t.rgnr_txt = ${rgnr}` : db`r.status <> '4'`}
     order by t.rgnr_txt, datum`;
  type Z = { beleg: string; datum: string | null; text: string; betrag: number };
  const map = new Map<string, { rgnr_txt: string; kunde: string; betrag: number; gezahlt: number; offen: number; zahlungen: Z[] }>();
  for (const r of rows) {
    const g = map.get(r.rgnr_txt) ?? { rgnr_txt: r.rgnr_txt, kunde: r.kunde, betrag: r.rg_betrag, gezahlt: 0, offen: 0, zahlungen: [] as Z[] };
    g.gezahlt = runden(g.gezahlt + r.betrag);
    g.offen = runden(g.betrag - g.gezahlt);
    g.zahlungen.push({ beleg: r.fibeleg, datum: r.datum, text: r.text, betrag: r.betrag });
    map.set(r.rgnr_txt, g);
  }
  return [...map.values()];
}

/** Gegenkonto-Historie: Buchungen mit gleichem Gegenkonto der letzten 12 Monate (eine Zeile je interner Nummer) */
export async function gegenkontoHistorie(db: Db, gkonto: string, ohne: string, ab: string) {
  return db`
    select distinct on (b.internenr) b.internenr, b.konto, b.datum::text as datum, coalesce(b.text, '') as text,
           split_part(coalesce(b.belnr, ''), ',', 1) as belnr,
           (coalesce(b.soll, 0) - coalesce(b.haben, 0))::float8 as betrag,
           coalesce((select string_agg(m.doknr, ', ' order by m.doknr) from tco.fipapermap m where m.internenr = b.internenr), '') as belege
      from tco.fibuchungen b
     where b.gkonto = ${gkonto} and b.internenr <> ${ohne} and b.datum >= ${ab}
     order by b.internenr desc, b.posnr`;
}
