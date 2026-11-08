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

export async function collectFinanzen(db: Db, jahr: number): Promise<Kpi[]> {
  const e = await ergebnis(db, jahr);
  return [
    kpi({ key: 'FIN_OHNE_BELEG', title: 'Buchungen ohne Beleg', subtitle: `Jahr ${jahr}`, value: '0', unit: 'Belege', details: 'noch nicht angebunden', icon: 'add-document', todo: true }),
    kpi({
      key: 'FIN_GEWINN', title: 'Gewinn', subtitle: `Einnahmen - Ausgaben ${jahr}`, value: betrag(e.gewinn), unit: 'EUR',
      state: e.gewinn < 0 ? 'Negative' : 'Positive', details: `Einnahmen ${betrag(e.einnahmen)} / Ausgaben ${betrag(e.ausgaben)}`, icon: 'loan',
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
    kpi({ key: 'JUG_MITGL', title: 'Aktive Jugendliche', subtitle: `Stand ${dat(h)}`, value: '0', unit: 'Personen', details: 'noch nicht angebunden', icon: 'study-leave', todo: true }),
    kpi({
      key: 'JUG_TRAINING', title: 'Trainingsstunden', subtitle: `laufender Monat (${h.slice(5, 7)}/${h.slice(0, 4)})`, value: stunden(stdMonat), unit: 'Std',
      details: `${stunden(stdJahr)} Std im Jahr ${jahr}`, icon: 'sports-target',
    }),
    kpi({ key: 'JUG_ZUSCHUSS', title: 'Offene Zuschüsse', subtitle: 'Anträge in Bearbeitung', value: '0', unit: 'EUR', details: 'noch nicht angebunden', icon: 'request', todo: true }),
  ];
}

// ---------------------------------------------------------------- Halle

export async function collectHalle(): Promise<Kpi[]> {
  return [
    kpi({ key: 'HAL_BELEGUNG', title: 'Belegungsquote', subtitle: 'laufende Saison', value: '0', unit: '%', details: 'noch nicht angebunden', icon: 'calendar', todo: true }),
    kpi({ key: 'HAL_ABR', title: 'Nicht abgerechnet', subtitle: 'Hallenzeiten', value: '0', unit: 'Std', details: 'noch nicht angebunden', icon: 'pending', todo: true }),
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
