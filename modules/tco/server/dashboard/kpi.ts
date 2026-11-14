/**
 * Kennzahlen der Vereinsübersicht (Port der collect_*- und detail_*-Methoden aus Z2UI5_CL_TCO_REPORTING)
 * sowie der Beitragsstufenwechsel (bsw_*).
 */
import type { Db } from '../verein.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { addTage, dat, heute, runden, zahl } from '../format.js';
import { ergebnis } from './finanzen.js';
import { jugendStundenLesen, mitgliederStat, stunden, type KeyText } from './charts.js';

export type State = 'Positive' | 'Critical' | 'Negative' | 'None';
export type Trend = 'Up' | 'Down' | 'None';

export interface Kpi {
  key: string;
  title: string;
  subtitle: string;
  /** Anzeigewert, bereits formatiert (wie conv_amount / conv_hours in ABAP) */
  value: string;
  unit: string;
  /** Veränderung klein neben dem Wert, z. B. „(+3)“ */
  delta?: string;
  trend: Trend;
  state: State;
  /** Fußzeile der Kachel bzw. Zusatztext der Card */
  details: string;
  icon: string;
  /** Erzwungene Darstellung (sonst gilt der Umschalter Kacheln/Cards) */
  display?: 'TILE' | 'CARD';
  /** Detail-Popup vorhanden */
  hasDetail: boolean;
  /** Platzhalter – Datenquelle noch nicht angebunden */
  todo: boolean;
  /** Auswahl in der Kachel (z. B. Zeitraum Monat/Saison/Jahr) und die gewählte Variante */
  varianten?: { key: string; text: string }[];
  variante?: string;
}

export interface Bereich { key: string; title: string; kpis: Kpi[] }

/** Betrag wie conv_amount: deutsche Schreibweise mit zwei Nachkommastellen */
export const betrag = (v: number) => zahl(runden(v));
const ganz = (v: number) => Math.trunc(v).toLocaleString('de-DE');

const kpi = (k: Partial<Kpi> & Pick<Kpi, 'key' | 'title' | 'value'>): Kpi => ({
  subtitle: '', unit: '', trend: 'None', state: 'None', details: '', icon: '', hasDetail: false, todo: false, ...k,
});

// ---------------------------------------------------------------- Mitglieder

export async function collectMitglieder(db: Db, jahr: number): Promise<Kpi[]> {
  const h = heute();
  const hj = Number(h.slice(0, 4));
  const { anzahl, stat } = await mitgliederStat(db);
  const akt = stat.find((s) => s.jahr === hj);
  const veraenderung = akt?.gesamt ?? 0;          // 0, wenn im laufenden Jahr keine Ein-/Austritte
  const delta = veraenderung > 0 ? `(+${veraenderung})` : veraenderung < 0 ? `(-${Math.abs(veraenderung)})` : '(±0)';
  const gj = stat.find((s) => s.jahr === jahr) ?? { eintritt: 0, austritt: 0, gesamt: 0 };
  const wechsel = await jugendbeitragWechsel(db);
  return [
    // Abweichung zu ABAP: die Zahl ist angebunden (ZCL_TCO_MITGLIEDER), daher kein Platzhalter mehr;
    // die Fußzeile nennt Ein-/Austritte des laufenden Jahres statt „noch nicht angebunden“.
    kpi({
      key: 'MTG_GESAMT', title: 'Mitglieder gesamt', subtitle: `Stand ${dat(h)}`, value: ganz(anzahl), delta, unit: 'Personen',
      state: 'None', details: `${akt?.eintritt ?? 0} Eintritte / ${akt?.austritt ?? 0} Austritte ${hj}`, icon: 'group',
    }),
    kpi({
      key: 'MTG_EINTRITT', title: 'Eintritte', subtitle: `Jahr ${jahr}`, value: ganz(gj.eintritt), unit: 'Personen', state: 'Positive', trend: 'Up',
      details: `Saldo ${gj.gesamt} im Jahr ${jahr}`, icon: 'add-employee', display: 'CARD',
    }),
    kpi({
      key: 'MTG_AUSTRITT', title: 'Austritte', subtitle: `Jahr ${jahr}`, value: ganz(gj.austritt), unit: 'Personen',
      state: gj.austritt > gj.eintritt ? 'Critical' : 'None', trend: 'Down',
      details: `Saldo ${gj.gesamt} im Jahr ${jahr}`, icon: 'employee-rejections', display: 'CARD',
    }),
    kpi({
      key: 'MTG_JUBILAEUM', title: 'Beitragsstufenwechsel', subtitle: 'Mitglieder werden 18 Jahre und sind noch als Jugendliche geführt',
      value: ganz(wechsel.zeilen.length), unit: 'Mitglieder', state: 'None', details: 'Verträge zum Jahresende umstellen', icon: 'badge',
      display: 'CARD', hasDetail: true, todo: true,
    }),
  ];
}

// ---------------------------------------------------------------- Clubhaus

interface ClubSumme { ekbrutto: number; vkbrutto: number; reinigung: number; provision: number; forderung: number; einzahlungen: number; offene_posten: number; anzahl: number; waers: string }

async function clubhausSumme(db: Db, jahr: number): Promise<ClubSumme> {
  const [s] = await db`select coalesce(sum(ekbrutto), 0)::float8 as ekbrutto, coalesce(sum(vkbrutto), 0)::float8 as vkbrutto,
                              coalesce(sum(reinigung), 0)::float8 as reinigung, coalesce(sum(provision), 0)::float8 as provision,
                              coalesce(sum(forderung), 0)::float8 as forderung, coalesce(sum(einzahlungen), 0)::float8 as einzahlungen,
                              coalesce(sum(offene_posten), 0)::float8 as offene_posten, count(*)::int as anzahl, max(waers) as waers
                         from tco.forderungen where jahr = ${jahr}`;
  return { ...s, waers: s.waers || 'EUR' } as ClubSumme;
}

export async function collectClubhaus(db: Db, jahr: number): Promise<Kpi[]> {
  const s = await clubhausSumme(db, jahr);
  const quote = s.forderung > 0 ? `${Math.trunc((s.einzahlungen * 100) / s.forderung)} % der Forderungen` : 'keine Forderungen im Zeitraum';
  const roh = runden(s.vkbrutto - s.ekbrutto - s.reinigung - s.provision);
  return [
    kpi({ key: 'CLUB_FORD', title: 'Forderungen', subtitle: `gestellt ${jahr}`, value: betrag(s.forderung), unit: s.waers, state: 'None', details: `${s.anzahl} Rechnungen`, icon: 'sales-document' }),
    kpi({ key: 'CLUB_EINZ', title: 'Einzahlungen', subtitle: `eingegangen ${jahr}`, value: betrag(s.einzahlungen), unit: s.waers, state: 'Positive', details: quote, icon: 'payment-approval' }),
    kpi({
      key: 'CLUB_UMSATZ', title: 'Rohertrag', subtitle: 'VK abzgl. EK, Reinigung, Provision', value: betrag(roh), unit: s.waers,
      state: roh < 0 ? 'Negative' : 'Positive', trend: roh < 0 ? 'Down' : 'Up',
      details: `VK ${betrag(s.vkbrutto)} / EK ${betrag(s.ekbrutto)}`, icon: 'line-chart', hasDetail: true,
    }),
  ];
}

// ---------------------------------------------------------------- Finanzen

/**
 * Buchungen ohne Beleg: Buchungen (interne Nummer) im Zeitraum ohne zugeordnetes Paperless-Dokument;
 * Stornos und stornierte Buchungen zählen nicht.
 */
export async function ohneBeleg(db: Db, von: string, bis: string): Promise<number> {
  const [r] = await db`
    select count(distinct b.internenr)::int as n from tco.fibuchungen b
     where b.datum between ${von} and ${bis} and b.storno_zu is null
       and not exists (select 1 from tco.fibuchungen s where s.storno_zu = b.internenr)
       and not exists (select 1 from tco.fipapermap m where m.internenr = b.internenr)`;
  return r.n;
}

export async function collectFinanzen(db: Db, jahr: number): Promise<Kpi[]> {
  const e = await ergebnis(db, jahr);
  const h = heute();
  const monatVon = `${h.slice(0, 7)}-01`;
  const monatBis = addTage(addTage(monatVon, 31).slice(0, 7) + '-01', -1);
  const ohneMonat = await ohneBeleg(db, monatVon, monatBis);
  const ohneJahr = await ohneBeleg(db, `${jahr}-01-01`, `${jahr}-12-31`);
  // Gewinn zählt alle Erlös-/Aufwandsbuchungen; das „Ergebnis“ der Card „Saldo Konten“ nur die mit Geldkonto als Gegenkonto
  const abgleich = e.ohne_geld ? ` · davon ohne Geldkonto ${betrag(e.ohne_geld)} (nicht im Ergebnis „Saldo Konten“)` : '';
  return [
    kpi({
      key: 'FIN_OHNE_BELEG', title: 'Buchungen ohne Beleg', subtitle: `laufender Monat (${h.slice(5, 7)}/${h.slice(0, 4)})`, value: ganz(ohneMonat), unit: 'Buchungen',
      state: ohneMonat ? 'Critical' : 'Positive', details: `${ganz(ohneJahr)} ohne Beleg im Jahr ${jahr}`, icon: 'add-document',
    }),
    kpi({
      key: 'FIN_GEWINN', title: 'Gewinn', subtitle: `Einnahmen - Ausgaben ${jahr} (alle Buchungen)`, value: betrag(e.gewinn), unit: 'EUR',
      state: e.gewinn < 0 ? 'Negative' : 'Positive', details: `Einnahmen ${betrag(e.einnahmen)} / Ausgaben ${betrag(e.ausgaben)}${abgleich}`, icon: 'loan',
    }),
    // wird in der Oberfläche immer als analytische Card mit Diagramm gezeigt (FinCard)
    kpi({
      key: 'FIN_SALDO', title: 'Saldo Konten', subtitle: `Geldkonten ${jahr}`, value: betrag(e.geld_eb), unit: 'EUR',
      state: e.geld_eb < 0 ? 'Negative' : 'None', details: `Anfangsbestand ${betrag(e.geld_ab)} EUR`, icon: 'paid-leave',
    }),
  ];
}

// ---------------------------------------------------------------- Jugend

export async function collectJugend(db: Db, jahr: number): Promise<Kpi[]> {
  const h = heute();
  const monatVon = `${h.slice(0, 7)}-01`;
  const naechster = addTage(addTage(monatVon, 31).slice(0, 7) + '-01', -1);   // letzter Tag des laufenden Monats
  const stdMonat = (await jugendStundenLesen(db, monatVon, naechster)).reduce((a, s) => a + s.stunden, 0);
  const stdJahr = (await jugendStundenLesen(db, `${jahr}-01-01`, `${jahr}-12-31`)).reduce((a, s) => a + s.stunden, 0);
  return [
    kpi(await aktiveJugendliche(db, h)),
    kpi({
      key: 'JUG_TRAINING', title: 'Trainingsstunden', subtitle: `laufender Monat (${h.slice(5, 7)}/${h.slice(0, 4)})`, value: stunden(stdMonat), unit: 'Std',
      details: `${stunden(stdJahr)} Std im Jahr ${jahr}`, icon: 'sports-target',
    }),
    kpi({ key: 'JUG_ZUSCHUSS', title: 'Offene Zuschüsse', subtitle: 'Anträge in Bearbeitung', value: '0', unit: 'EUR', details: 'noch nicht angebunden', icon: 'request', todo: true }),
  ];
}

// ---------------------------------------------------------------- Halle

/**
 * Aktive Jugendliche: aktive Mitglieder (eingetreten, nicht ausgetreten) unter 18 Jahren am Stichtag;
 * dazu, wie viele davon bzw. insgesamt am Jugendtraining teilnehmen (laufender Vertrag Art 90).
 */
async function aktiveJugendliche(db: Db, h: string) {
  const grenze = `${Number(h.slice(0, 4)) - 18}${h.slice(4)}`;          // geboren nach diesem Tag = unter 18
  const [r] = await db`
    with aktiv as (select m.adrnr, m.geburtsdatum from tco.mitglieder m
                    where m.eintritt is not null and m.eintritt <= ${h} and (m.austritt is null or m.austritt >= ${h})),
         training as (select distinct v.adrnr from tco.vertraege v
                       where trim(coalesce(v.art, '')) = '90' and (v.vertragbegin is null or v.vertragbegin <= ${h}) and (v.vertragende is null or v.vertragende >= ${h}))
    select count(*) filter (where a.geburtsdatum > ${grenze}::date)::int as jugend,
           count(*) filter (where a.geburtsdatum > ${grenze}::date and t.adrnr is not null)::int as jugend_training,
           (select count(*)::int from training) as training,
           count(*) filter (where a.geburtsdatum is null)::int as ohne_geb
      from aktiv a left join training t on t.adrnr = a.adrnr`;
  return {
    key: 'JUG_MITGL', title: 'Aktive Jugendliche', subtitle: `unter 18 Jahren, Stand ${dat(h)}`, value: ganz(r.jugend), unit: 'Personen',
    details: `${ganz(r.jugend_training)} davon im Jugendtraining · ${ganz(r.training)} Trainingsteilnehmer gesamt${r.ohne_geb ? ` · ${ganz(r.ohne_geb)} Mitglieder ohne Geburtsdatum` : ''}`,
    icon: 'study-leave', state: 'Positive' as State,
  };
}

/** laufende Hallensaison (01.09.–30.04.); im Sommer die zuletzt abgeschlossene (#103: Saison ab September) */
export function hallenSaison(h: string): { von: string; bis: string; laufend: boolean } {
  const j = Number(h.slice(0, 4)), m = Number(h.slice(5, 7));
  const start = m >= 9 ? j : j - 1;
  const von = `${start}-09-01`, ende = `${start + 1}-04-30`;
  return { von, bis: h < ende ? h : ende, laufend: h <= ende };
}

/** Zeitraum der Belegungsquote: laufender Monat, Hallensaison oder Kalenderjahr – jeweils bis heute (#103) */
export const HAL_ZEITRAEUME = { MONAT: 'Monat', SAISON: 'Saison', JAHR: 'Jahr' } as const;
export type HalZeitraum = keyof typeof HAL_ZEITRAEUME;
export function hallenZeitraum(h: string, art: HalZeitraum): { von: string; bis: string; text: string } {
  if (art === 'MONAT') return { von: `${h.slice(0, 7)}-01`, bis: h, text: `laufender Monat (${dat(`${h.slice(0, 7)}-01`)}–${dat(h)})` };
  if (art === 'JAHR') return { von: `${h.slice(0, 4)}-01-01`, bis: h, text: `Kalenderjahr ${h.slice(0, 4)} (${dat(`${h.slice(0, 4)}-01-01`)}–${dat(h)})` };
  const s = hallenSaison(h);
  return { von: s.von, bis: s.bis, text: `${s.laufend ? 'laufende Saison' : 'Saison'} (${dat(s.von)}–${dat(s.bis)})` };
}

const minutenVon = (t: string) => { const [hh, mm] = t.split(':').map(Number); return (hh === 0 && mm === 0 ? 24 : hh) * 60 + mm; };
const wochentag = (d: string) => String(((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1);

/**
 * Belegungsquote der Halle: gebuchte Minuten (Einzel, Abo, Einzel aus Abo; ohne storniert/entfallen) und feste Belegungen
 * (Training, Veranstaltung) innerhalb der Buchungszeiten der Hallenplätze (Buchungsstart bis -ende, Wochentage)
 * im Verhältnis zur maximal buchbaren Zeit im Zeitraum.
 *
 * #103: „gültig ab“ eines Hallenplatzes zählt hier nicht – es ist meist das Anlagedatum in der Platzverwaltung und hat die
 * Kapazität früherer Zeiträume auf wenige Tage gekürzt. Nur „gültig bis“ (Platz aufgegeben) begrenzt die Kapazität.
 * Buchungen ohne Platz (aus SAP übernommen – ZTCO_BOOKINGS kennt keinen Platz – oder ältere EP3-Exporte) und mit unbekannter
 * Platzbezeichnung zählen mit, begrenzt auf die Buchungszeiten der Halle insgesamt; nur Buchungen auf Freiplätzen zählen nicht.
 */
export async function belegungsquote(db: Db, z: { von: string; bis: string }) {
  const plaetze = await db`select id, name, aliase, wochentage, zeit_von::text as von, zeit_bis::text as bis, gueltig_bis::text as gb
                             from tco.plaetze where art = 'HALLE' and aktiv`;
  let kapazitaet = 0;
  for (let d = z.von; d <= z.bis; d = addTage(d, 1)) {
    const wt = wochentag(d);
    for (const p of plaetze) if (d <= p.gb && p.wochentage.includes(wt)) kapazitaet += minutenVon(p.bis) - minutenVon(p.von);
  }
  const leer = { quote: null as number | null, belegt: 0, kapazitaet: 0, ohnePlatz: 0 };
  if (!plaetze.length || !kapazitaet) return leer;
  const namen = plaetze.flatMap((p) => [p.name, ...String(p.aliase ?? '').split(',')].map((x) => x.trim().toUpperCase()).filter(Boolean)
    .map((n) => ({ n, von: minutenVon(p.von), bis: minutenVon(p.bis) })));
  const zeit = new Map(namen.map((x) => [x.n, x]));
  // ohne bekannten Hallenplatz: Buchungszeiten der Halle insgesamt
  const halle = { von: Math.min(...namen.map((x) => x.von)), bis: Math.max(...namen.map((x) => x.bis)) };
  const frei = (await db`select name, aliase from tco.plaetze where art = 'FREI'`)
    .flatMap((p) => [p.name, ...String(p.aliase ?? '').split(',')].map((x: string) => x.trim().toUpperCase()).filter(Boolean));
  const buchungen = await db`select upper(trim(coalesce(platz, ''))) as platz, time_start::text as s, time_ende::text as e from tco.bookings
                              where datum between ${z.von} and ${z.bis} and status in ('1', '3', '5') and time_start is not null and time_ende is not null
                                and not (upper(trim(coalesce(platz, ''))) = any(${frei}))`;
  let belegt = 0;
  let ohnePlatz = 0;
  for (const b of buchungen) {
    const p = zeit.get(b.platz);
    if (!p) ohnePlatz++;
    const w = p ?? halle;
    belegt += Math.max(0, Math.min(minutenVon(b.e), w.bis) - Math.max(minutenVon(b.s), w.von));
  }
  // feste Belegungen (Training, Schnuppertraining, Veranstaltung); leere Platzliste = alle Hallenplätze
  const fest = await db`select id, quelle, ext_id, plaetze, wochentage, datum_von::text as dv, datum_bis::text as db, zeit_von::text as von, zeit_bis::text as bis
                          from tco.platzbelegungen where aktiv and art in ('TRAINING', 'SCHNUPPER', 'VERANSTALTUNG') and datum_bis >= ${z.von} and datum_von <= ${z.bis}`;
  // abgesagte Termine (Platzverwaltung) zählen nicht als belegt
  const ausfall = new Set((await db`select schluessel, platz_id, datum::text as datum from tco.platzbelegung_ausfall where datum between ${z.von} and ${z.bis}`)
    .map((a) => `${a.schluessel}|${a.platz_id}|${a.datum}`));
  for (const f of fest) {
    const k = f.quelle === 'EP3' && f.ext_id ? `EP3:${f.ext_id}` : String(f.id);
    const ziel = plaetze.filter((p) => !f.plaetze?.length || f.plaetze.includes(p.id));
    for (let d = f.dv > z.von ? f.dv : z.von; d <= (f.db < z.bis ? f.db : z.bis); d = addTage(d, 1)) {
      const wt = wochentag(d);
      if (!f.wochentage.includes(wt)) continue;
      for (const p of ziel) {
        if (d > p.gb || !p.wochentage.includes(wt) || ausfall.has(`${k}|${p.id}|${d}`)) continue;
        belegt += Math.max(0, Math.min(minutenVon(f.bis), minutenVon(p.bis)) - Math.max(minutenVon(f.von), minutenVon(p.von)));
      }
    }
  }
  belegt = Math.min(belegt, kapazitaet);
  return { quote: runden((belegt / kapazitaet) * 100), belegt, kapazitaet, ohnePlatz };
}

/** Belegungen ohne Abrechnung, unabhängig von der Ausschlussliste der Stammdaten (#103) */
const KEIN_ERLOES = /jugendtraining|hallens(ä|ae)uberung|hallenreinigung|reinigung|sperrung|gesperrt/i;
const RG_OFFEN: Record<string, string> = { 1: 'in Bearbeitung', 2: 'gedruckt', 3: 'versendet', 5: 'teilbezahlt' };

export interface HalleOffenZeile { bereich: string; text: string; anzahl: number; minuten: number; betrag: number }
/**
 * Offene Hallenstunden (#103): alles, was gebucht, aber noch nicht bezahlt ist –
 *   1. vergangene Buchungen ohne Rechnung, 2. künftige Buchungen ohne Rechnung (jeweils mit dem Preis ihres Termins
 *   aus den Hallenpreisen), 3. nicht bezahlte Rechnungen mit ihren Positionen (Stunden aus den Buchungspositionen,
 *   Betrag = offener Rechnungsbetrag abzüglich Teilzahlungen).
 * Abos zählen mit allen offenen Terminen der Serie in den Stunden und mit dem Abo-Preis im Betrag. Nicht enthalten:
 * stornierte/entfallene Buchungen, die Ausschlussliste der Stammdaten und Jugendtraining, Hallensäuberung, Sperrungen.
 */
export async function halleOffen(db: Db): Promise<{ zeilen: HalleOffenZeile[]; minuten: number; betrag: number; ohnePreis: number }> {
  const { vereinLesen } = await import('../verein.js');
  const { offeneBuchungen } = await import('../halle/daten.js');
  const v = await vereinLesen(db);
  const ausschluss = v.halle_ausschluss.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const ignoriert = (kunde: string | null, text?: string | null) => KEIN_ERLOES.test(kunde ?? '') || KEIN_ERLOES.test(text ?? '') || ausschluss.includes((kunde ?? '').toUpperCase());
  const buchungen = (await offeneBuchungen(db, v)).filter((b) => !ignoriert(b.kunde, b.text));
  const zeile = (bereich: string, text: string, l: typeof buchungen): HalleOffenZeile => ({
    bereich, text, anzahl: l.length,
    minuten: l.reduce((a, b) => a + b.dauer * (b.art === 'Abo' ? b.termine : 1), 0),
    betrag: runden(l.reduce((a, b) => a + (b.fehler ? 0 : b.betrag), 0)),
  });
  const zeilen: HalleOffenZeile[] = [
    zeile('Buchungen ohne Rechnung', 'bereits gespielt', buchungen.filter((b) => b.vergangen)),
    zeile('Buchungen ohne Rechnung', 'künftige Termine', buchungen.filter((b) => !b.vergangen)),
  ];
  // nicht bezahlte Rechnungen: Stunden aus den Buchungspositionen (Abo-Position = alle Termine der Serie)
  const rg = await db`
    select k.rgnr_txt, k.status, k.kunde, k.betrag::float8 as betrag,
           coalesce((select sum(z.betrag)::float8 from tco.rgtz z where z.rgnr_txt = k.rgnr_txt), 0) as gezahlt,
           coalesce((select sum(
                       case when p.dauer ~ '^[0-9]+$' then p.dauer::int else 0 end
                       * case when exists (select 1 from tco.bookings b where b.bid = p.bid and b.datum = p.datum and b.status = '3')
                                   and not exists (select 1 from tco.bookings_ch c where c.bid = p.bid and c.status_abw = '1')
                              then greatest((select count(*) from tco.bookings b where b.bid = p.bid and coalesce(b.status, '') not in ('2', '4')), 1)
                              else 1 end)
                       from tco.rgpos p where p.rgnr_txt = k.rgnr_txt and p.bid is not null), 0)::int as minuten
      from tco.rgkopf k where k.status in ('1', '2', '3', '5')`;
  for (const [st, text] of Object.entries(RG_OFFEN)) {
    const l = rg.filter((r) => r.status === st && !ignoriert(r.kunde));
    zeilen.push({ bereich: 'Rechnungen nicht bezahlt', text, anzahl: l.length, minuten: l.reduce((a, r) => a + Number(r.minuten), 0),
      betrag: runden(l.reduce((a, r) => a + Math.max(0, r.betrag - r.gezahlt), 0)) });
  }
  return {
    zeilen, minuten: zeilen.reduce((a, z) => a + z.minuten, 0), betrag: runden(zeilen.reduce((a, z) => a + z.betrag, 0)),
    ohnePreis: buchungen.filter((b) => b.fehler).length,
  };
}

export async function detailHalleOffen(db: Db): Promise<Detail> {
  const o = await halleOffen(db);
  return {
    title: 'Offene Hallenstunden – gebucht, aber noch nicht bezahlt',
    head: ['Bereich', 'Stand', 'Anzahl', 'Stunden', 'Betrag EUR'],
    info: 'Buchungen sind mit dem Preis ihres Termins aus den Hallenpreisen bewertet, Abos mit allen offenen Terminen in den Stunden und dem Abo-Preis im Betrag. '
      + 'Rechnungen zählen mit dem offenen Betrag (abzüglich Teilzahlungen) und den Stunden ihrer Buchungspositionen. '
      + 'Nicht enthalten: Stornos, die Ausschlussliste der Stammdaten, Jugendtraining, Hallensäuberung und Sperrungen.'
      + (o.ohnePreis ? ` ${o.ohnePreis} Buchung(en) ohne gültigen Hallenpreis sind nur mit Stunden enthalten.` : ''),
    zeilen: [
      ...o.zeilen.filter((z) => z.anzahl).map((z): DetailZeile => ({ cols: [z.bereich, z.text, ganz(z.anzahl), stunden(z.minuten / 60), betrag(z.betrag)], state: 'None' })),
      { cols: ['Gesamt', '', ganz(o.zeilen.reduce((a, z) => a + z.anzahl, 0)), stunden(o.minuten / 60), betrag(o.betrag)], state: o.minuten || o.betrag ? 'Critical' : 'Positive' },
    ],
  };
}

export async function collectHalle(db: Db, zeitraum: HalZeitraum = 'SAISON'): Promise<Kpi[]> {
  const h = heute();
  const z = hallenZeitraum(h, zeitraum);
  const q = await belegungsquote(db, z);
  const o = await halleOffen(db);
  const teil = (bereich: string) => o.zeilen.filter((x) => x.bereich === bereich);
  const [ohne, rg] = [teil('Buchungen ohne Rechnung'), teil('Rechnungen nicht bezahlt')];
  const std = (l: HalleOffenZeile[]) => stunden(l.reduce((a, x) => a + x.minuten, 0) / 60);
  return [
    kpi({
      key: 'HAL_BELEGUNG', title: 'Belegungsquote', subtitle: z.text,
      varianten: Object.entries(HAL_ZEITRAEUME).map(([key, text]) => ({ key, text })), variante: zeitraum,
      value: q.quote === null ? '–' : zahl(q.quote, 1), unit: '%',
      details: q.quote === null ? 'keine Hallenplätze mit Buchungszeiten gepflegt (Platzverwaltung)' : `${stunden(q.belegt / 60)} von ${stunden(q.kapazitaet / 60)} Std der Buchungszeiten belegt`,
      icon: 'calendar', state: q.quote === null ? 'None' : q.quote >= 60 ? 'Positive' : q.quote >= 30 ? 'Critical' : 'Negative',
    }),
    kpi({
      key: 'HAL_ABR', title: 'Offene Hallenstunden', subtitle: 'gebucht, noch nicht bezahlt (ohne Rechnung, künftig, Rechnung offen)',
      value: stunden(o.minuten / 60), unit: 'Std', hasDetail: true,
      details: `${betrag(o.betrag)} EUR · ohne Rechnung ${std([ohne[0]])} Std, künftig ${std([ohne[1]])} Std, Rechnungen offen ${std(rg)} Std`,
      icon: 'pending', state: o.minuten || o.betrag ? 'Critical' : 'Positive',
    }),
  ];
}

// ---------------------------------------------------------------- Details

export interface DetailZeile {
  cols: string[];
  state: State;
  /** Beitragsstufenwechsel: Schlüssel des Jugendvertrags */
  adrnr?: string;
  vertragnr?: string;
  betrag?: number;
}
export interface Detail {
  title: string;
  head: string[];
  info: string;
  /** Ausrichtung je Spalte (Begin/End) – wie im ABAP-Popup ab der dritten Spalte rechtsbündig */
  zeilen: DetailZeile[];
  /** BSW = Beitragsstufenwechsel mit Aktionen */
  mode?: 'BSW';
  stichtag?: string;
  stufen?: KeyText[];
}

export async function detailClubhausOp(db: Db, jahr: number): Promise<Detail> {
  const pos = await db`select jahr, monat, rechnung, forderung::float8 as forderung, einzahlungen::float8 as einzahlungen, offene_posten::float8 as offene_posten
                         from tco.forderungen where jahr = ${jahr} and coalesce(offene_posten, 0) <> 0 order by monat, rechnung`;
  const zeilen: DetailZeile[] = pos.map((p) => ({
    cols: [`${String(p.monat).padStart(2, '0')}/${p.jahr}`, p.rechnung ?? '', betrag(p.forderung ?? 0), betrag(p.einzahlungen ?? 0), betrag(p.offene_posten ?? 0)],
    state: p.offene_posten > 0 ? 'Negative' : 'Positive',
  }));
  return {
    title: `Offene Posten Clubhaus ${jahr}`, head: ['Monat', 'Rechnung', 'Forderung', 'Einzahlungen', 'Offen'], zeilen,
    info: zeilen.length ? `${zeilen.length} offene Rechnung(en).` : `Im Jahr ${jahr} sind keine offenen Posten vorhanden.`,
  };
}

export async function detailClubhausUmsatz(db: Db, jahr: number): Promise<Detail> {
  const mon = await db`select jahr, monat, coalesce(sum(vkbrutto), 0)::float8 as vkbrutto, coalesce(sum(ekbrutto), 0)::float8 as ekbrutto,
                              coalesce(sum(reinigung), 0)::float8 as reinigung, coalesce(sum(provision), 0)::float8 as provision
                         from tco.forderungen where jahr = ${jahr} group by jahr, monat order by monat`;
  const zeilen: DetailZeile[] = mon.map((m) => {
    const roh = runden(m.vkbrutto - m.ekbrutto - m.reinigung - m.provision);
    return {
      cols: [`${String(m.monat).padStart(2, '0')}/${m.jahr}`, betrag(m.vkbrutto), betrag(m.ekbrutto), betrag(m.reinigung + m.provision), betrag(roh)],
      state: roh < 0 ? 'Negative' : 'Positive',
    };
  });
  return { title: `Rohertrag Clubhaus ${jahr}`, head: ['Monat', 'VK brutto', 'EK brutto', 'Reinigung / Provision', 'Rohertrag'], zeilen, info: `${zeilen.length} Monat(e) mit Bewegungen.` };
}

// ---------------------------------------------------------------- Beitragsstufenwechsel

/** Vertragsart als Zahl (nur Ziffern), sonst null */
const artNr = (art: unknown) => (/^\d+$/.test(String(art ?? '').trim()) ? Number(String(art).trim()) : null);

/**
 * Alle Mitglieder mit laufendem Mitgliedsbeitrag Jugendliche (Art 3), die im kommenden Jahr 18 werden (gelb)
 * oder es bereits sind (rot). Das Jugendtraining (Art 90) spielt für die Auswahl keine Rolle.
 */
export async function jugendbeitragWechsel(db: Db): Promise<{ zeilen: DetailZeile[]; neu: number; alt: number }> {
  const h = heute();
  const jahr = Number(h.slice(0, 4));
  const bis = `${jahr - 17}-12-31`;            // spätester Geburtstag: 31.12. des Jahrgangs, der nächstes Jahr 18 wird
  const jug = await db`select distinct on (a.adrnr) a.adrnr, a.mitglnrn, a.nachname, a.vorname, a.geburtsdatum::text as geburtsdatum,
                              b.vertragnr, b.betrag::float8 as betrag, b.vertragende::text as vertragende
                         from tco.mitglieder a join tco.vertraege b on b.adrnr = a.adrnr
                        where trim(coalesce(b.art, '')) = '3' and b.vertragende is null
                          and a.geburtsdatum is not null and a.geburtsdatum <= ${bis}
                          and (a.austritt is null or a.austritt >= ${h})
                        order by a.adrnr, b.vertragbegin desc nulls last`;
  // Mitglieder mit laufendem oder künftigem Folgevertrag (Mitgliedschaft, Art < 90, nicht Jugend) sind umgestellt
  const ids = jug.map((j) => j.adrnr as string);
  const umgestellt = new Set<string>();
  if (ids.length) {
    const folge = await db`select adrnr, art from tco.vertraege where adrnr = any(${ids}) and trim(coalesce(art, '')) <> '3'
                             and (vertragende is null or vertragende >= ${h})`;
    for (const f of folge) { const n = artNr(f.art); if (n !== null && n < 90) umgestellt.add(f.adrnr); }
  }
  const rest = jug.filter((j) => !umgestellt.has(j.adrnr))
    .sort((a, b) => String(b.geburtsdatum).localeCompare(String(a.geburtsdatum)) || String(a.nachname ?? '').localeCompare(String(b.nachname ?? '')) || String(a.vorname ?? '').localeCompare(String(b.vorname ?? '')));
  let neu = 0, alt = 0;
  const zeilen: DetailZeile[] = rest.map((j) => {
    const jahr18 = Number(String(j.geburtsdatum).slice(0, 4)) + 18;
    if (jahr18 > jahr) neu++; else alt++;
    const hinweis = `${jahr18}${j.vertragende ? `, Vertrag endet ${dat(j.vertragende)}` : ''}`;
    return {
      cols: [`${j.nachname ?? ''}, ${j.vorname ?? ''}`, hinweis, dat(j.geburtsdatum), String(j.mitglnrn ?? '').replace(/^0+(?=\d)/, ''), betrag(j.betrag ?? 0)],
      state: jahr18 > jahr ? 'Critical' : 'Negative',
      adrnr: j.adrnr, vertragnr: j.vertragnr, betrag: Number(j.betrag ?? 0),
    };
  });
  return { zeilen, neu, alt };
}

/** Höhere Beitragsstufen: aktuell laufende Mitgliedschaftsverträge (Art < 90, nicht Jugend) mit dem Preis des jüngsten Vertrags je Art */
export async function bswStufenLaden(db: Db, betragMin: number): Promise<KeyText[]> {
  const h = heute();
  const arten = await db`select distinct on (trim(art)) trim(art) as art, artname, betrag::float8 as betrag, sollstellung
                           from tco.vertraege where trim(coalesce(art, '')) <> '3' and vertragbegin <= ${h}
                            and (vertragende is null or vertragende >= ${h})
                          order by trim(art), vertragbegin desc nulls last`;
  return arten
    .filter((a) => { const n = artNr(a.art); return n !== null && n < 90 && Number(a.betrag ?? 0) > betragMin; })
    .sort((a, b) => Number(a.betrag ?? 0) - Number(b.betrag ?? 0) || String(a.artname ?? '').localeCompare(String(b.artname ?? '')))
    .map((a) => ({ key: a.art, text: `${a.artname ?? ''} - ${betrag(a.betrag ?? 0)} EUR ${a.sollstellung ?? ''}`.trim() }));
}

export async function detailBeitragswechsel(db: Db): Promise<Detail> {
  const jahrNeu = Number(heute().slice(0, 4)) + 1;
  const w = await jugendbeitragWechsel(db);
  const betragMin = w.zeilen.reduce((m, z) => (m === 0 || (z.betrag ?? 0) < m ? z.betrag ?? 0 : m), 0);
  return {
    title: `Beitragsstufenwechsel ${jahrNeu} - Mitgliedsbeitrag Jugendliche`,
    head: ['Mitglied', '18 im Jahr', 'Geburtsdatum', 'Mitgliedsnr.', 'Jugendbeitrag'],
    zeilen: w.zeilen, mode: 'BSW', stichtag: `${jahrNeu - 1}-12-31`, stufen: await bswStufenLaden(db, betragMin),
    info: w.zeilen.length
      ? `${w.zeilen.length} Mitglieder mit Mitgliedsbeitrag Jugendliche: ${w.neu} werden ${jahrNeu} 18 (gelb), ${w.alt} sind ${jahrNeu - 1} oder früher 18 (rot).`
      : `Kein Mitglied, das ${jahrNeu} 18 wird oder bereits volljährig ist, hat noch den Mitgliedsbeitrag Jugendliche.`,
  };
}

/**
 * Jugendvertrag zum Stichtag beenden, neuen Vertrag ab Stichtag + 1 anlegen (Kopie des Jugendvertrags mit
 * Art/Bezeichnung/Preis/Turnus der neuen Beitragsstufe). Fehler als BusinessError – der Aufrufer rollt zurück.
 */
export async function bswVertragWechseln(tx: Db, d: { adrnr: string; vertragnr: string; artNeu: string; stichtag: string }): Promise<{ vertragnrNeu: string; stufe: string }> {
  const h = heute();
  const [alt] = await tx`select * from tco.vertraege where adrnr = ${d.adrnr} and vertragnr = ${d.vertragnr}`;
  if (!alt) throw new BusinessError(`Jugendvertrag ${d.vertragnr} zu Adressnr. ${d.adrnr} nicht gefunden.`);
  if (alt.vertragbegin && d.stichtag < alt.vertragbegin) throw new BusinessError(`Stichtag liegt vor dem Vertragsbeginn ${dat(alt.vertragbegin)}.`);
  if (alt.vertragende && alt.vertragende <= d.stichtag) throw new BusinessError(`Der Jugendvertrag endet bereits am ${dat(alt.vertragende)}.`);
  // Vorlage der neuen Beitragsstufe: jüngster laufender Vertrag dieser Art
  const [vorlage] = await tx`select art, artname, betrag, sollstellung from tco.vertraege
                              where trim(coalesce(art, '')) = ${d.artNeu.trim()} and vertragbegin <= ${h}
                                and (vertragende is null or vertragende >= ${h}) order by vertragbegin desc nulls last limit 1`;
  if (!vorlage) throw new BusinessError(`Beitragsstufe ${d.artNeu} nicht gefunden.`);
  // Neue Vertragsnummer je Mitglied: höchste numerische Vertragsnummer des Mitglieds + 1 (Stellenzahl beibehalten)
  const nrn = (await tx`select vertragnr from tco.vertraege where adrnr = ${d.adrnr}`).map((x) => String(x.vertragnr ?? '').trim()).filter((x) => /^\d{1,16}$/.test(x));
  let max = 0, len = 0;
  for (const n of nrn) if (Number(n) > max) { max = Number(n); len = n.length; }
  const nrNeu = String(max + 1).padStart(len, '0');
  const beginnNeu = addTage(d.stichtag, 1);
  // 1. Jugendvertrag zum Stichtag beenden
  await tx`update tco.vertraege set vertragende = ${d.stichtag} where adrnr = ${alt.adrnr} and vertragnr = ${alt.vertragnr}`;
  // 2. neuen Vertrag anlegen – ein bereits vorgemerktes späteres Vertragsende bleibt erhalten
  await tx`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, vertragende, betrag, zahler_adrnr, betrag_indiv)
           values (${alt.adrnr}, ${nrNeu}, ${vorlage.art}, ${vorlage.artname}, ${alt.mitglnr}, ${vorlage.sollstellung}, ${beginnNeu}, ${alt.vertragende},
                   ${vorlage.betrag}, ${alt.zahler_adrnr}, false)`;
  return { vertragnrNeu: nrNeu, stufe: `${vorlage.artname ?? ''} - ${betrag(Number(vorlage.betrag ?? 0))} EUR ${vorlage.sollstellung ?? ''}`.trim() };
}
