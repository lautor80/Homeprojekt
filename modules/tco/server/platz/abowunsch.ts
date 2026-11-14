/**
 * Abo-Bewerbung für die Halle (#11).
 *
 * Grundregel: Bewerbung, Bestätigung und Angebot sind eigene Datensätze (tco.abo_wunsch) und führen NIE zu einer Buchung.
 * Ein Abo (tco.bookings, Status 3) entsteht ausschließlich in `freigeben` – durch den Kassenwart.
 *
 * Ablauf je Saison (tco.abo_saison, Fristen einstellbar):
 *  1. Saison eröffnen: Die Abos des Vorjahres werden als Bestätigung „OFFEN“ vorgemerkt, die Abonnenten per E-Mail gebeten zu bestätigen.
 *  2. Bis „bestaetigen_bis“ (30.07.): bestätigen oder abgeben; Interessenten bewerben sich (auch für mehrere Stunden am Stück)
 *     und sehen Anzahl der Interessenten und ihre Position. Mitglieder stehen vor Nichtmitgliedern, sonst zählt der Eingang.
 *  3. Am Tag danach: Erinnerung per E-Mail. Ohne E-Mail-Adresse (oder wenn der Versand scheitert) entsteht eine Ausnahme im Arbeitsvorrat.
 *  4. Ab „nachruecken_ab“ (15.08.): unbestätigte Stunden verfallen; freie Stunden werden dem Ersten der Warteliste angeboten
 *     (Annahmefrist `annahme_tage`, danach der Nächste). Nachgerückt wird immer für die ganze Saison.
 *  5. Freigabe durch den Kassenwart: erst dann wird das Abo für die Saison angelegt.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import type { Db } from '../verein.js';
import { vereinLesen } from '../verein.js';
import { addTage, dat } from '../format.js';
import { minuten, preiseLesen, type Preise } from '../halle/preis.js';
import { mailSenden } from '../kommunikation.js';
import { mailtextFuellen } from '../mailtexte.js';
import { aboAnlegen, belegungLesen, hhmm, isoWochentag, jetzt, plaetzeLesen, preisVon, type Ich, type Platz } from './logik.js';
import { ADRNR_ZU_BENUTZER } from './schluessel.js';
import { festeLesen, festeTermine } from './belegungen.js';

/**
 * Feste Belegungen der Platzverwaltung (Jugendtraining, Sperren …) in der Saison: Stunden, die an mindestens der Hälfte der
 * Wochen geblockt sind, stehen für Abos nicht zur Verfügung. Schlüssel „platz|wochentag|stunde(min)“ → Bezeichnung.
 */
async function geblockt(db: Db, s: Saison, plaetze: Platz[], heute = jetzt().datum): Promise<Map<string, string>> {
  const von = heute > s.von ? heute : s.von;
  const out = new Map<string, string>();
  if (von > s.bis) return out;
  const wochen = Math.max(1, Math.floor((Date.parse(`${s.bis}T12:00:00Z`) - Date.parse(`${von}T12:00:00Z`)) / 604_800_000));
  const n = new Map<string, { n: number; text: string }>();
  for (const t of festeTermine(await festeLesen(db, von, s.bis, true), plaetze.map((p) => p.id), von, s.bis)) {
    for (let h = Math.floor(t.von / 60) * 60; h < t.bis; h += 60) {
      const k = `${t.platzId}|${isoWochentag(t.datum)}|${h}`;
      const e = n.get(k) ?? { n: 0, text: t.bezeichnung };
      e.n++;
      n.set(k, e);
    }
  }
  for (const [k, e] of n) if (e.n * 2 >= wochen) out.set(k, e.text);
  return out;
}
const istGeblockt = (g: Map<string, string>, f: Zeit) => { for (let h = Math.floor(f.von / 60) * 60; h < f.bis; h += 60) { const t = g.get(`${f.platz_id}|${f.wochentag}|${h}`); if (t) return t; } return null; };
/** Training wird nicht abgefragt – es steht als feste Belegung in der Platzverwaltung */
const istTraining = (name: string) => /training/i.test(name);

export const MAX_BEWERBUNGEN = 3;
const WT = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
/** belegen die Stunde: bestätigt, angeboten, angenommen, freigegeben – und „OFFEN“, solange der Abonnent noch bestätigen kann */
const BELEGT = ['OFFEN', 'BESTAETIGT', 'ANGEBOTEN', 'ANGENOMMEN', 'FREIGEGEBEN'];

export interface Saison { id: number; name: string; von: string; bis: string; bestaetigen_bis: string; nachruecken_ab: string; annahme_tage: number; erinnert_am: string | null; mail_pause_bis: string | null }
export interface Wunsch {
  id: number; saison_id: number; art: 'BESTAETIGUNG' | 'BEWERBUNG'; adrnr: string | null; name: string; mitglied: boolean; benutzer_id: string | null;
  platz_id: number; wochentag: number; von: number; bis: number; status: string; angelegt: string; angeboten_am: string | null; mail_fehler: string | null; abo_bid: string | null;
}
export interface SaisonEingabe { name: string; von: string; bis: string; bestaetigen_bis: string; nachruecken_ab: string; annahme_tage: number; mail_pause_bis?: string | null }

export const zeitText = (w: Pick<Wunsch, 'wochentag' | 'von' | 'bis'>) => `${WT[w.wochentag]} ${hhmm(w.von)}–${hhmm(w.bis)} Uhr`;

export async function saisonLesen(db: Db): Promise<Saison | null> {
  const [s] = await db`select id, name, von::text as von, bis::text as bis, bestaetigen_bis::text as bestaetigen_bis, nachruecken_ab::text as nachruecken_ab,
                              annahme_tage, erinnert_am::text as erinnert_am, mail_pause_bis::text as mail_pause_bis from tco.abo_saison where aktiv order by id desc limit 1`;
  return (s as Saison | undefined) ?? null;
}

async function wuensche(db: Db, saisonId: number): Promise<Wunsch[]> {
  return (await db`select id, saison_id, art, adrnr, name, mitglied, benutzer_id::text as benutzer_id, platz_id, wochentag, von, bis, status,
                          angelegt::text as angelegt, angeboten_am::text as angeboten_am, mail_fehler, abo_bid
                     from tco.abo_wunsch where saison_id = ${saisonId}
                    order by mitglied desc, angelegt, id`) as unknown as Wunsch[];
}
const trifft = (a: Pick<Wunsch, 'platz_id' | 'wochentag' | 'von' | 'bis'>, b: Pick<Wunsch, 'platz_id' | 'wochentag' | 'von' | 'bis'>) =>
  a.platz_id === b.platz_id && a.wochentag === b.wochentag && a.von < b.bis && a.bis > b.von;

type Zeit = Pick<Wunsch, 'platz_id' | 'wochentag' | 'von' | 'bis'>;
/** laufende Abos der Saison (Buchungen, Status 3, ab heute) – diese Stunden sind vergeben, auch ohne Wunsch-Datensatz */
async function laufendeAbos(db: Db, s: Saison, heute = jetzt().datum): Promise<(Zeit & { kunde: string })[]> {
  return (await db`
    select distinct p.id as platz_id, extract(isodow from b.datum)::int as wochentag, upper(trim(coalesce(b.kunde, ''))) as kunde,
           extract(hour from b.time_start)::int * 60 + extract(minute from b.time_start)::int as von,
           case when b.time_ende = time '00:00' then 1440 else extract(hour from b.time_ende)::int * 60 + extract(minute from b.time_ende)::int end as bis
      from tco.bookings b join tco.plaetze p on upper(trim(p.name)) = upper(trim(b.platz)) and p.art = 'HALLE'
     where b.status = '3' and b.datum between greatest(${s.von}::date, ${heute}::date) and ${s.bis}::date`) as unknown as (Zeit & { kunde: string })[];
}

/** erster Termin eines Abos: Saisonbeginn, unterjährig ab heute – jeweils der nächste passende Wochentag */
function ersterTermin(s: Saison, wochentag: number, heute = jetzt().datum): string {
  let ab = heute > s.von ? heute : s.von;
  while (isoWochentag(ab) !== wochentag) ab = addTage(ab, 1);
  return ab;
}
/**
 * Unterjährig (Saison läuft schon): Einheiten bis zum Saisonende × Einzelpreis der jeweiligen Stunde.
 * Vor Saisonbeginn gilt der Abo-Preis der Hallenabrechnung – dann null.
 */
type Einzel = { platzId: number; datum: string; von: number; bis: number }[];
/** Einzelbuchungen der Halle im Rest der Saison – ein Abo beginnt erst in der Woche nach der letzten Einzelbuchung auf seiner Zeit */
async function einzelLesen(db: Db, s: Saison, heute = jetzt().datum): Promise<Einzel> {
  const hallen = (await plaetzeLesen(db)).filter((p) => p.art === 'HALLE');
  const ab = heute > s.von ? heute : s.von;
  if (!hallen.length || ab > s.bis) return [];
  return (await belegungLesen(db, hallen, ab, s.bis)).filter((b) => b.status === '1' && !b.fest && !b.reserviert)
    .map((b) => ({ platzId: b.platzId, datum: b.datum, von: b.von, bis: b.bis }));
}
/** Beginn des Abos: nächster passender Wochentag – liegen auf der Zeit noch Einzelbuchungen, die Woche nach der letzten */
function beginn(s: Saison, w: Zeit, einzel: Einzel, heute = jetzt().datum): { ab: string; letzte: string | null } {
  const ab = ersterTermin(s, w.wochentag, heute);
  const letzte = einzel.filter((e) => e.platzId === w.platz_id && e.datum >= ab && isoWochentag(e.datum) === w.wochentag && e.von < w.bis && e.bis > w.von)
    .map((e) => e.datum).sort().pop() ?? null;
  return { ab: letzte ? addTage(letzte, 7) : ab, letzte };
}

export function unterjaehrig(s: Saison, w: Zeit, platz: Platz | undefined, preise: Preise, heute = jetzt().datum, einzel: Einzel = []): { ab: string; einheiten: number; betrag: number; termine: { datum: string; preis: number }[] } | null {
  if (heute <= s.von) return null;
  const termine: { datum: string; preis: number }[] = [];
  for (let d = beginn(s, w, einzel, heute).ab; d <= s.bis; d = addTage(d, 7)) termine.push({ datum: d, preis: preisVon(platz, d, w.von, w.bis, '1', preise).betrag ?? 0 });
  return { ab: termine[0]?.datum ?? heute, einheiten: termine.length, betrag: Math.round(termine.reduce((x, t) => x + t.preis, 0) * 100) / 100, termine };
}

function fristenPruefen(e: SaisonEingabe) {
  if (e.bis <= e.von) throw new BusinessError('Das Saisonende liegt vor dem Beginn.');
  if (e.nachruecken_ab <= e.bestaetigen_bis) throw new BusinessError('Das Nachrücken beginnt erst nach der Bestätigungsfrist.');
  if (e.nachruecken_ab > e.von) throw new BusinessError('Das Nachrücken muss vor dem Saisonbeginn liegen.');
}

async function emailVon(db: Db, w: Pick<Wunsch, 'adrnr' | 'benutzer_id'>): Promise<string | null> {
  const [r] = await db`select coalesce(
      (select nullif(trim(m.email), '') from tco.mitglieder m where m.adrnr = ${w.adrnr}),
      (select nullif(trim(u.email), '') from core.users u where u.id::text = ${w.benutzer_id})) as email`;
  return (r?.email as string | null) ?? null;
}

/** E-Mail an Abonnent bzw. Interessent; scheitert sie (keine Adresse, Versand nicht möglich), steht der Grund am Wunsch → Arbeitsvorrat */
async function benachrichtigen(db: Db, w: Wunsch, betreff: string, text: string, mail = true): Promise<boolean> {
  if (!mail) return false; // bewusst ohne E-Mail – keine Ausnahme im Arbeitsvorrat
  let fehler: string | null = null;
  const an = await emailVon(db, w);
  if (!an) fehler = 'keine E-Mail-Adresse gepflegt';
  else {
    try {
      const v = await vereinLesen();
      const url = await portalUrl().catch(() => null);
      // Anrede und Gruß: Einstellungen → E-Mail-Texte (Rahmen), sonst wie bisher; die Nachricht gibt der Vorgang vor (#232)
      const t = await mailtextFuellen(db, v, 'halle.abo', { Betreff: betreff, Name: w.name, Nachricht: text, Portal: url ? `Zum Portal: ${url}/tco/platz-buchen?ansicht=abo` : '' });
      await mailSenden(v, { modus: 'senden', anwendung: 'Abo-Bewerbung', objekt: String(w.id), an, benutzer: 'system', anhaenge: [], betreff: t.betreff, text: t.text });
    } catch (e) { fehler = `E-Mail nicht versendet: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300); }
  }
  // als erledigt gekennzeichnete Einträge melden keine Ausnahme mehr
  await db`update tco.abo_wunsch set mail_fehler = case when mail_ignorieren then null else ${fehler}::text end where id = ${w.id}`;
  return !fehler;
}

/** Saison eröffnen: Abos des Vorjahres (Halle) als offene Bestätigungen vormerken und die Abonnenten anschreiben */
export async function saisonEroeffnen(tx: Db, e: SaisonEingabe & { vorjahr_von?: string | null; vorjahr_bis?: string | null; mail?: boolean }): Promise<string> {
  fristenPruefen(e);
  await tx`update tco.abo_saison set aktiv = false where aktiv`;
  const [s] = await tx`insert into tco.abo_saison (name, von, bis, bestaetigen_bis, nachruecken_ab, annahme_tage, mail_pause_bis)
                       values (${e.name}, ${e.von}, ${e.bis}, ${e.bestaetigen_bis}, ${e.nachruecken_ab}, ${e.annahme_tage}, ${e.mail_pause_bis || null}) returning id`;
  // Läuft die Saison schon bzw. ist der Nachrück-Termin vorbei, gibt es nichts mehr zu bestätigen: die Abos sind gebucht, freie Stunden
  // können unterjährig beworben werden. Sonst würden die Vormerkungen beim nächsten Lauf sofort verfallen.
  if (!e.vorjahr_von || !e.vorjahr_bis || e.nachruecken_ab <= jetzt().datum) {
    return `Saison ${e.name} eröffnet. Der Nachrück-Termin ist bereits erreicht – es wurden keine Abos zur Bestätigung vorgemerkt; freie Stunden können ab sofort beworben werden.`;
  }
  const abos = await tx`
    select b.bid, p.id as platz_id, min(b.datum)::text as erster, min(b.kunde) as kunde, (array_agg(b.benutzer_id::text) filter (where b.benutzer_id is not null))[1] as benutzer_id,
           extract(hour from min(b.time_start))::int * 60 + extract(minute from min(b.time_start))::int as von,
           case when max(b.time_ende) = time '00:00' then 1440 else extract(hour from max(b.time_ende))::int * 60 + extract(minute from max(b.time_ende))::int end as bis
      from tco.bookings b join tco.plaetze p on upper(trim(p.name)) = upper(trim(b.platz)) and p.art = 'HALLE'
     where b.status = '3' and b.datum between ${e.vorjahr_von} and ${e.vorjahr_bis}
     group by b.bid, p.id order by min(b.datum), b.bid`;
  let n = 0;
  for (const a of abos) {
    if (!(Number(a.bis) > Number(a.von)) || istTraining(String(a.kunde ?? ''))) continue;
    // Zuordnung: über den buchenden Benutzer, sonst über den Namen des Mitglieds
    const [ub] = a.benutzer_id ? await tx`select ${tx.unsafe(ADRNR_ZU_BENUTZER('u.id'))} as adrnr from core.users u where u.id::text = ${a.benutzer_id}` : [];
    const [un] = ub?.adrnr ? [] : await tx`select m.adrnr from tco.mitglieder m where upper(trim(concat_ws(' ', m.vorname, m.nachname))) = ${String(a.kunde ?? '').trim().toUpperCase()} order by m.adrnr limit 1`;
    const adrnr = (ub?.adrnr ?? un?.adrnr ?? null) as string | null;
    const [mg] = adrnr ? await tx`select 1 from tco.mitglieder m where m.adrnr = ${adrnr} and m.eintritt is not null and (m.austritt is null or m.austritt >= current_date)` : [];
    const z = { adrnr, mitglied: !!mg };
    const name = String(a.kunde ?? '').toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
    const [w] = await tx`insert into tco.abo_wunsch (saison_id, art, adrnr, name, mitglied, benutzer_id, platz_id, wochentag, von, bis, status, vorjahr_bid)
                         values (${s.id}, 'BESTAETIGUNG', ${z?.adrnr ?? null}, ${name || 'Unbekannt'}, ${!!z?.mitglied}, ${a.benutzer_id ?? null}, ${a.platz_id},
                                 ${isoWochentag(a.erster)}, ${a.von}, ${a.bis}, 'OFFEN', ${a.bid}) returning id`;
    n++;
    const wunsch = (await wuensche(tx, s.id)).find((x) => x.id === w.id)!;
    await benachrichtigen(tx, wunsch, `Hallenabo ${e.name}: bitte bis ${dat(e.bestaetigen_bis)} bestätigen`,
      `dein Hallenabo ${zeitText(wunsch)} kannst du für die Saison ${e.name} (${dat(e.von)} bis ${dat(e.bis)}) behalten. Bitte bestätige es bis zum ${dat(e.bestaetigen_bis)} im Portal unter „Platz buchen → Abo“. Ohne Bestätigung wird die Stunde ab dem ${dat(e.nachruecken_ab)} dem ersten Interessenten der Warteliste angeboten.`, !!e.mail);
  }
  return `Saison ${e.name} eröffnet: ${n} Abo${n === 1 ? '' : 's'} des Vorjahres zur Bestätigung vorgemerkt${e.mail ? ' und per E-Mail angeschrieben' : ' (ohne E-Mail)'}.`;
}

export async function saisonAendern(tx: Db, id: number, e: SaisonEingabe): Promise<string> {
  fristenPruefen(e);
  const r = await tx`update tco.abo_saison set name = ${e.name}, von = ${e.von}, bis = ${e.bis}, bestaetigen_bis = ${e.bestaetigen_bis}, nachruecken_ab = ${e.nachruecken_ab},
                            annahme_tage = ${e.annahme_tage}, mail_pause_bis = ${e.mail_pause_bis || null} where id = ${id} returning id`;
  if (!r.length) throw new BusinessError('Saison nicht gefunden.', 404);
  return 'Fristen gespeichert.';
}

/** Raster für „Platz buchen → Abo“: je Hallenplatz, Wochentag und Stunde der Status aus Sicht des Benutzers */
const kostenText = (k: ReturnType<typeof unterjaehrig>) => (k ? `ab ${dat(k.ab)}: ${k.einheiten} Einheit${k.einheiten === 1 ? '' : 'en'} zum Einzelpreis = ${k.betrag.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : null);

export async function rasterLesen(db: Db, ich: Ich) {
  const s = await saisonLesen(db);
  const plaetze = (await plaetzeLesen(db, true)).filter((p) => p.art === 'HALLE');
  if (!s) return { saison: null, unterjaehrig: false, plaetze: [], felder: [], meine: [], maxBewerbungen: MAX_BEWERBUNGEN };
  const alle = await wuensche(db, s.id);
  const abos = await laufendeAbos(db, s);
  const einzel = await einzelLesen(db, s);
  const preise = await preiseLesen(db);
  const block = await geblockt(db, s, plaetze);
  const unterj = jetzt().datum > s.von;
  const felder: { platz_id: number; wochentag: number; von: number; bis: number; status: string; wartende: number; position: number | null; wunsch_id: number | null; preis: number | null; einheiten: number; gesamt: number; hinweis: string | null }[] = [];
  for (const p of plaetze) {
    for (let wt = 1; wt <= 7; wt++) {
      if (!p.wochentage.includes(String(wt))) continue;
      for (let von = minuten(p.zeit_von); von + 60 <= (p.zeit_bis === '24:00' ? 1440 : minuten(p.zeit_bis)); von += 60) {
        const f = { platz_id: p.id, wochentag: wt, von, bis: von + 60 };
        const hier = alle.filter((w) => trifft(w, f));
        const warten = hier.filter((w) => w.status === 'WARTET');
        const mein = hier.find((w) => w.adrnr === ich.adrnr && [...BELEGT, 'WARTET'].includes(w.status));
        const belegt = hier.find((w) => BELEGT.includes(w.status));
        const abo = abos.find((a) => trifft(a, f));
        const sperre = istGeblockt(block, f);
        // Preis je Einheit: vor der Saison der Abo-Preis, unterjährig der Einzelpreis der Stunde
        const preis = preisVon(p, ersterTermin(s, wt), von, von + 60, unterj ? '1' : '3', preise);
        // Gesamtwert: Einheiten bis zum Saisonende × Preis der jeweiligen Stunde (unterjährig Einzelpreis, vor der Saison Abo-Preis)
        let einheiten = 0, gesamt = 0;
        for (let d = beginn(s, f, einzel).ab; d <= s.bis; d = addTage(d, 7)) { einheiten++; gesamt += preisVon(p, d, von, von + 60, unterj ? '1' : '3', preise).betrag ?? 0; }
        felder.push({
          ...f, einheiten, gesamt: Math.round(gesamt * 100) / 100, wartende: warten.length, wunsch_id: mein?.id ?? null, preis: preis.kostenfrei ? 0 : preis.betrag, hinweis: !mein && sperre ? sperre : null,
          position: mein?.status === 'WARTET' ? warten.findIndex((w) => w.id === mein.id) + 1 : null,
          status: mein ? ({ OFFEN: 'offen', BESTAETIGT: 'bestaetigt', FREIGEGEBEN: 'freigegeben', ANGEBOTEN: 'angebot', ANGENOMMEN: 'angenommen', WARTET: 'bewerbung' } as Record<string, string>)[mein.status]
            : sperre ? 'gesperrt' : abo?.kunde === ich.kunde ? 'freigegeben' : belegt || abo ? 'vergeben' : 'frei',
        });
      }
    }
  }
  const meine = alle.filter((w) => w.adrnr === ich.adrnr && !['ZURUECKGEZOGEN'].includes(w.status)).map((w) => {
    const warten = alle.filter((x) => x.status === 'WARTET' && trifft(x, w));
    return { id: w.id, art: w.art, platz: plaetze.find((p) => p.id === w.platz_id)?.name ?? '', platz_id: w.platz_id, wochentag: w.wochentag, von: hhmm(w.von), bis: hhmm(w.bis), status: w.status,
      text: zeitText(w), wartende: warten.length, position: w.status === 'WARTET' ? warten.findIndex((x) => x.id === w.id) + 1 : null,
      annehmen_bis: w.status === 'ANGEBOTEN' && w.angeboten_am ? addTage(w.angeboten_am, s.annahme_tage) : null,
      kosten: ['WARTET', 'ANGEBOTEN', 'ANGENOMMEN'].includes(w.status) ? kostenText(unterjaehrig(s, w, plaetze.find((p) => p.id === w.platz_id), preise, undefined, einzel)) : null };
  });
  return { saison: s, unterjaehrig: jetzt().datum > s.von, plaetze: plaetze.map((p) => ({ id: p.id, name: p.name })), felder, meine, maxBewerbungen: MAX_BEWERBUNGEN };
}

/** Bewerbung auf eine oder mehrere Stunden am Stück – nur Warteliste, keine Buchung */
export async function bewerben(tx: Db, ich: Ich, e: { platz_id: number; wochentag: number; von: string; bis: string }): Promise<string> {
  const s = await saisonLesen(tx);
  if (!s) throw new BusinessError('Derzeit ist keine Abo-Saison zur Bewerbung geöffnet.');
  if (jetzt().datum > s.bis) throw new BusinessError('Die Saison ist beendet.');
  const p = (await plaetzeLesen(tx, true)).find((x) => x.id === e.platz_id) as Platz | undefined;
  if (!p || p.art !== 'HALLE') throw new BusinessError('Bewerbungen sind nur für die Halle möglich.');
  const von = minuten(e.von), bis = e.bis === '24:00' ? 1440 : minuten(e.bis);
  if (!(bis > von) || von % 60 || bis % 60) throw new BusinessError('Bitte volle Stunden wählen (z. B. 18:00 bis 20:00 Uhr).');
  if (von < minuten(p.zeit_von) || bis > (p.zeit_bis === '24:00' ? 1440 : minuten(p.zeit_bis)) || !p.wochentage.includes(String(e.wochentag))) throw new BusinessError('Zu dieser Zeit ist die Halle nicht geöffnet.');
  await tx`select pg_advisory_xact_lock(hashtext('tco.abo_wunsch'))`;
  const alle = await wuensche(tx, s.id);
  const meine = alle.filter((w) => w.adrnr === ich.adrnr && [...BELEGT, 'WARTET'].includes(w.status));
  const f = { platz_id: p.id, wochentag: e.wochentag, von, bis };
  const sperre = istGeblockt(await geblockt(tx, s, [p]), f);
  if (sperre) throw new BusinessError(`Diese Zeit ist fest belegt (${sperre}) und steht nicht für Abos zur Verfügung.`);
  if (meine.some((w) => trifft(w, f))) throw new BusinessError('Für diese Zeit haben Sie bereits ein Abo oder eine Bewerbung.');
  if (meine.filter((w) => w.status === 'WARTET').length >= MAX_BEWERBUNGEN) throw new BusinessError(`Es sind höchstens ${MAX_BEWERBUNGEN} offene Bewerbungen möglich.`);
  const [m] = await tx`select 1 from tco.mitglieder where adrnr = ${ich.adrnr} and eintritt is not null and (austritt is null or austritt >= current_date)`;
  await tx`insert into tco.abo_wunsch (saison_id, art, adrnr, name, mitglied, benutzer_id, platz_id, wochentag, von, bis, status)
           values (${s.id}, 'BEWERBUNG', ${ich.adrnr}, ${ich.name}, ${!!m}, ${ich.benutzerId}, ${p.id}, ${e.wochentag}, ${von}, ${bis}, 'WARTET')`;
  const warten = (await wuensche(tx, s.id)).filter((w) => w.status === 'WARTET' && trifft(w, f));
  const pos = warten.findIndex((w) => w.adrnr === ich.adrnr) + 1;
  const k = kostenText(unterjaehrig(s, f, p, await preiseLesen(tx), undefined, await einzelLesen(tx, s)));
  return `Bewerbung für ${zeitText(f)} auf ${p.name} gespeichert – Position ${pos} von ${warten.length}.${k ? ` Unterjährig ${k}.` : ''} Ein Abo entsteht erst mit der Freigabe durch den Kassenwart.`;
}

const UEBERGANG: Record<string, { von: string[]; nach: string; art: Wunsch['art']; text: string }> = {
  bestaetigen: { von: ['OFFEN'], nach: 'BESTAETIGT', art: 'BESTAETIGUNG', text: 'Abo bestätigt – die Freigabe erfolgt durch den Kassenwart.' },
  abgeben: { von: ['OFFEN', 'BESTAETIGT'], nach: 'ABGEGEBEN', art: 'BESTAETIGUNG', text: 'Abo abgegeben – die Stunde wird der Warteliste angeboten.' },
  zurueckziehen: { von: ['WARTET'], nach: 'ZURUECKGEZOGEN', art: 'BEWERBUNG', text: 'Bewerbung zurückgezogen.' },
  annehmen: { von: ['ANGEBOTEN'], nach: 'ANGENOMMEN', art: 'BEWERBUNG', text: 'Angebot angenommen – die Freigabe erfolgt durch den Kassenwart.' },
  ablehnen: { von: ['ANGEBOTEN'], nach: 'ABGELEHNT', art: 'BEWERBUNG', text: 'Angebot abgelehnt – die Stunde geht an den nächsten Interessenten.' },
};
export type Aktion = keyof typeof UEBERGANG;

/** eigene Bestätigung/Bewerbung fortschreiben – ändert nur den Wunsch, nie eine Buchung */
export async function aktion(tx: Db, ich: Ich, id: number, a: string): Promise<string> {
  const u = UEBERGANG[a];
  const [w] = await tx`select id, art, adrnr, status from tco.abo_wunsch where id = ${id} for update`;
  if (!u || !w || w.adrnr !== ich.adrnr) throw new BusinessError('Eintrag nicht gefunden.', 404);
  if (w.art !== u.art || !u.von.includes(w.status)) throw new BusinessError('Das ist in diesem Stand nicht (mehr) möglich.');
  await tx`update tco.abo_wunsch set status = ${u.nach}, entschieden = now(), mail_fehler = null where id = ${id}`;
  return u.text;
}

/**
 * Fällige Schritte (täglich, beliebig oft wiederholbar): Erinnerung nach der Bestätigungsfrist, ab dem Nachrück-Termin unbestätigte
 * Stunden verfallen lassen, abgelaufene Angebote zurücknehmen und freie Stunden dem Ersten der Warteliste anbieten.
 */
export async function aboLauf(db: Db, heute = jetzt().datum, o: { mail?: boolean; manuell?: boolean } = {}): Promise<{ erinnert: number; verfallen: number; angeboten: number }> {
  const r = { erinnert: 0, verfallen: 0, angeboten: 0 };
  const mail = o.mail !== false;
  const s = await saisonLesen(db);
  if (!s || heute > s.bis) return r;
  // E-Mail-Pause: der automatische Lauf ruht bis einschließlich des Datums (sonst liefen Fristen, ohne dass jemand davon erfährt)
  if (!o.manuell && s.mail_pause_bis && heute <= s.mail_pause_bis) return r;
  if (heute > s.bestaetigen_bis && !s.erinnert_am && heute < s.nachruecken_ab) {
    const [frei] = await db`update tco.abo_saison set erinnert_am = ${heute} where id = ${s.id} and erinnert_am is null returning id`;
    if (frei) {
      for (const w of (await wuensche(db, s.id)).filter((x) => x.art === 'BESTAETIGUNG' && x.status === 'OFFEN')) {
        await benachrichtigen(db, w, `Erinnerung: Hallenabo ${s.name} bitte bestätigen`,
          `dein Hallenabo ${zeitText(w)} für die Saison ${s.name} ist noch nicht bestätigt. Bitte bestätige es im Portal unter „Platz buchen → Abo“. Ohne Bestätigung wird die Stunde am ${dat(s.nachruecken_ab)} dem ersten Interessenten der Warteliste angeboten.`, mail);
        r.erinnert++;
      }
    }
  }
  if (heute < s.nachruecken_ab) return r;
  r.verfallen += (await db`update tco.abo_wunsch set status = 'VERFALLEN', entschieden = now(), mail_fehler = null
                            where saison_id = ${s.id} and ((art = 'BESTAETIGUNG' and status = 'OFFEN')
                               or (status = 'ANGEBOTEN' and angeboten_am + ${s.annahme_tage}::int < ${heute}::date)) returning id`).length;
  const alle = await wuensche(db, s.id);
  const abos = await laufendeAbos(db, s, heute);
  const einzel = await einzelLesen(db, s, heute);
  const plaetze = await plaetzeLesen(db);
  const preise = await preiseLesen(db);
  for (const w of alle.filter((x) => x.status === 'WARTET')) {
    if (alle.some((x) => x.id !== w.id && BELEGT.includes(x.status) && trifft(x, w)) || abos.some((a) => trifft(a, w))) continue;
    const [ok] = await db`update tco.abo_wunsch set status = 'ANGEBOTEN', angeboten_am = ${heute} where id = ${w.id} and status = 'WARTET' returning id`;
    if (!ok) continue;
    w.status = 'ANGEBOTEN';
    r.angeboten++;
    const k = kostenText(unterjaehrig(s, w, plaetze.find((p) => p.id === w.platz_id), preise, heute, einzel));
    await benachrichtigen(db, w, `Hallenabo ${s.name}: ${zeitText(w)} ist für dich frei`,
      `die Stunde ${zeitText(w)} wird dir als Abo ${k ? `für den Rest der Saison ${s.name} angeboten (${k})` : `für die ganze Saison ${s.name} (${dat(s.von)} bis ${dat(s.bis)}) angeboten`}. Bitte nimm das Angebot bis zum ${dat(addTage(heute, s.annahme_tage))} im Portal unter „Platz buchen → Abo“ an – sonst geht es an den nächsten Interessenten. Das Abo gilt erst nach der Freigabe durch den Kassenwart.`, mail);
  }
  return r;
}

/** Übersicht für den Kassenwart */
export async function verwaltungLesen(db: Db) {
  const s = await saisonLesen(db);
  if (!s) return { saison: null, wuensche: [] };
  const plaetze = await plaetzeLesen(db);
  const alle = await wuensche(db, s.id);
  const preise = await preiseLesen(db);
  const einzel = await einzelLesen(db, s);
  return {
    saison: s,
    wuensche: alle.map((w) => {
      const warten = alle.filter((x) => x.status === 'WARTET' && trifft(x, w));
      return { id: w.id, art: w.art, name: w.name, mitglied: w.mitglied, platz: plaetze.find((p) => p.id === w.platz_id)?.name ?? '', wochentag: w.wochentag, von: hhmm(w.von), bis: hhmm(w.bis),
        text: zeitText(w), status: w.status, angelegt: w.angelegt.slice(0, 10), mail_fehler: w.mail_fehler, abo_bid: w.abo_bid, wartende: warten.length,
        position: w.status === 'WARTET' ? warten.findIndex((x) => x.id === w.id) + 1 : null,
        kosten: ['WARTET', 'ANGEBOTEN', 'ANGENOMMEN'].includes(w.status) ? kostenText(unterjaehrig(s, w, plaetze.find((p) => p.id === w.platz_id), preise, undefined, einzel)) : null };
    }),
  };
}

/** Freigabe durch den Kassenwart – die EINZIGE Stelle, an der aus einem Wunsch ein Abo (Buchungen) wird */
export async function freigeben(tx: Db, id: number): Promise<string> {
  const s = await saisonLesen(tx);
  const [w] = await tx`select id, saison_id, adrnr, name, platz_id, wochentag, von, bis, status from tco.abo_wunsch where id = ${id} for update`;
  if (!s || !w || w.saison_id !== s.id) throw new BusinessError('Eintrag nicht gefunden.', 404);
  if (!['BESTAETIGT', 'ANGENOMMEN'].includes(w.status)) throw new BusinessError('Freigegeben wird nur, was der Abonnent bestätigt bzw. der Interessent angenommen hat.');
  if (!w.adrnr) throw new BusinessError(`${w.name} ist keinem Mitglied oder Portalnutzer zugeordnet – bitte das Abo in der Platzverwaltung anlegen.`);
  let ab = ersterTermin(s, w.wochentag);
  // Reservierung dieses Wunsches aufheben, bevor das Abo die Termine belegt
  await tx`update tco.abo_wunsch set status = 'FREIGEGEBEN', entschieden = now() where id = ${id}`;
  // Im Abozeitraum darf kein Termin durch eine Einzelbuchung blockiert sein: Das Abo beginnt in der Woche nach der letzten Einzelbuchung
  // auf dieser Zeit (neue kommen nicht hinzu – die Stunde war reserviert).
  const platz = (await plaetzeLesen(tx)).find((p) => p.id === w.platz_id);
  if (!platz) throw new BusinessError('Der Platz ist nicht mehr vorhanden.');
  const einzel = (await belegungLesen(tx, [platz], ab, s.bis))
    .filter((b) => b.status === '1' && !b.fest && !b.reserviert && isoWochentag(b.datum) === w.wochentag && b.von < w.bis && b.bis > w.von).map((b) => b.datum).sort();
  const erster = ab;
  if (einzel.length) ab = addTage(einzel[einzel.length - 1], 7);
  if (ab > s.bis) throw new BusinessError(einzel.length ? `Bis zum Saisonende ist die Zeit durch Einzelbuchungen belegt (zuletzt am ${dat(einzel[einzel.length - 1])}).` : 'Bis zum Saisonende gibt es keinen Termin mehr.');
  const spaeter = ab !== erster ? ` Beginn erst am ${dat(ab)}, weil bis ${dat(einzel[einzel.length - 1])} noch Einzelbuchungen bestehen.` : '';
  const r0 = await aboAnlegen(tx, { platz_id: w.platz_id, adrnr: w.adrnr, kunde: w.name, ab, bis_datum: s.bis, von: hhmm(w.von), bis: hhmm(w.bis), text: `Abo ${s.name}` }, true);
  const r = { ...r0, text: r0.text + spaeter };
  await tx`update tco.abo_wunsch set abo_bid = ${r.bid} where id = ${id}`;
  // unterjährig: jede Einheit bis zum Saisonende zum Einzelpreis der jeweiligen Stunde (Abo mit Einzelabrechnung)
  const k = unterjaehrig(s, w as unknown as Zeit, (await plaetzeLesen(tx)).find((p) => p.id === w.platz_id), await preiseLesen(tx));
  if (!k) return r.text;
  await tx`insert into tco.bookings_ch (bid, status_abw) values (${r.bid}, '1') on conflict (bid) do update set status_abw = '1'`;
  let summe = 0, n = 0;
  for (const t of k.termine) {
    const u = await tx`update tco.bookings set preis = ${t.preis} where bid = ${r.bid} and datum = ${t.datum} returning bid`;
    if (u.length) { summe += t.preis; n++; }
  }
  return `${r.text} Unterjährig: ${n} Einheit${n === 1 ? '' : 'en'} zum Einzelpreis = ${(Math.round(summe * 100) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €.`;
}

/** Kassenwart lehnt ab (z. B. Bestätigung trotz offener Rechnung) – die Stunde wird wieder frei */
export async function abweisen(tx: Db, id: number): Promise<string> {
  const r = await tx`update tco.abo_wunsch set status = 'ABGELEHNT', entschieden = now() where id = ${id} and status in ('OFFEN', 'BESTAETIGT', 'ANGEBOTEN', 'ANGENOMMEN', 'WARTET') returning name`;
  if (!r.length) throw new BusinessError('Das ist in diesem Stand nicht (mehr) möglich.');
  return `${r[0].name}: abgelehnt.`;
}

/** Ausnahme „nicht per E-Mail erreichbar“ erledigen: Fehler löschen und für diese Einträge künftig nicht mehr anzeigen (id leer = alle) */
export async function mailFehlerErledigen(tx: Db, id: number | null): Promise<string> {
  const r = await tx`update tco.abo_wunsch set mail_fehler = null, mail_ignorieren = true
                      where mail_fehler is not null and (${id}::int is null or id = ${id}::int) returning id`;
  return r.length === 1 ? 'Hinweis erledigt – wird nicht mehr angezeigt.' : `${r.length} Hinweise erledigt – sie werden nicht mehr angezeigt.`;
}
