import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { addTage, condense, dat } from '../format.js';
import { minuten, preisBerechnen, preiseLesen, type Preise } from '../halle/preis.js';

/**
 * Platzbuchung (Freiplätze und Halle) – grob nach dem EP3-Buchungssystem:
 * Plätze mit Gültigkeit, Öffnungszeiten, Zeitraster, Mindest-/Höchstdauer, Vorlauf und Stornofrist.
 *
 * Buchungen stehen wie die EP3-Buchungen in tco.bookings (Status 1 Einzel, 2 storniert, 3 Abo),
 * damit die Hallenabrechnung sie mit abrechnet. Portalbuchungen tragen quelle = 'PORTAL',
 * den buchenden Benutzer (benutzer_id) und eine BID aus eigenem Nummernkreis (9 + 9 Stellen),
 * die mit EP3-Nummern nicht kollidiert. Kostenfreie Plätze werden mit ASSIGNED = 'X' (ohne Rechnung) angelegt.
 */

export const QUELLE = 'PORTAL';
export const ARTEN = { HALLE: 'Halle', FREI: 'Freiplatz' } as const;

export interface Platz {
  id: number; name: string; art: 'HALLE' | 'FREI'; aliase: string; sort: number;
  gueltig_von: string; gueltig_bis: string; wochentage: string; zeit_von: string; zeit_bis: string;
  raster: number; dauer_min: number; dauer_max: number; vorlauf_min: number; vorlauf_max: number;
  storno_frist: number; max_offen: number; abrechnen: boolean; aktiv: boolean; hinweis: string | null;
}

export interface Ich { benutzerId: string; adrnr: string; name: string; kunde: string }

export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const gross = (s: string | null | undefined) => condense(s ?? '').toUpperCase();
/** ISO-Wochentag 1 = Montag … 7 = Sonntag */
export const isoWochentag = (iso: string) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
const WT_LANG = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const wochentagText = (iso: string) => WT_LANG[isoWochentag(iso)];
const tageZwischen = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** aktuelle Zeit in Oberthal (Europe/Berlin) – unabhängig von der Zeitzone des Servers */
export function jetzt(d = new Date()): { datum: string; min: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { datum: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
/** Minuten von jetzt bis zum Termin (negativ = vorbei) */
export const minutenBis = (datum: string, min: number, j = jetzt()) => tageZwischen(j.datum, datum) * 1440 + min - j.min;

// ---------------------------------------------------------------------------
// Plätze
// ---------------------------------------------------------------------------

export async function plaetzeLesen(db: Db, nurAktiv = false): Promise<Platz[]> {
  const rows = await db`
    select id, name, art, aliase, sort, gueltig_von::text, gueltig_bis::text, wochentage,
           to_char(zeit_von, 'HH24:MI') as zeit_von, to_char(zeit_bis, 'HH24:MI') as zeit_bis,
           raster, dauer_min, dauer_max, vorlauf_min, vorlauf_max, storno_frist, max_offen, abrechnen, aktiv, hinweis
      from tco.plaetze ${nurAktiv ? db`where aktiv` : db``}
     order by sort, name`;
  return rows as unknown as Platz[];
}

export async function platzLesen(db: Db, id: number): Promise<Platz> {
  const p = (await plaetzeLesen(db)).find((x) => x.id === id);
  if (!p) throw new BusinessError('Platz nicht gefunden.', 404);
  return p;
}

export type PlatzEingabe = Omit<Platz, 'id'>;

export function platzPruefen(p: PlatzEingabe) {
  if (!p.name.trim()) throw new BusinessError('Bitte eine Bezeichnung angeben.');
  if (p.gueltig_von > p.gueltig_bis) throw new BusinessError('„Gültig ab“ liegt nach „Gültig bis“.');
  if (!/^[1-7]{1,7}$/.test(p.wochentage)) throw new BusinessError('Bitte mindestens einen Wochentag wählen.');
  const von = minuten(p.zeit_von);
  const bis = minuten(p.zeit_bis);
  if (von >= bis) throw new BusinessError('Die Öffnungszeit endet vor ihrem Beginn.');
  if (von % p.raster || bis % p.raster) throw new BusinessError(`Öffnungszeiten müssen auf das Zeitraster von ${p.raster} Minuten fallen.`);
  if (p.dauer_min % p.raster || p.dauer_max % p.raster) throw new BusinessError(`Buchungsdauern müssen ein Vielfaches des Zeitrasters (${p.raster} Minuten) sein.`);
  if (p.dauer_min > p.dauer_max) throw new BusinessError('Die Mindestdauer ist größer als die Höchstdauer.');
  if (p.dauer_min > bis - von) throw new BusinessError('Die Mindestdauer ist länger als die Öffnungszeit.');
}

export async function platzSpeichern(tx: Db, id: number | null, p: PlatzEingabe): Promise<number> {
  platzPruefen(p);
  const name = condense(p.name);
  const [doppelt] = await tx`select id from tco.plaetze where upper(name) = ${name.toUpperCase()} and id is distinct from ${id}`;
  if (doppelt) throw new BusinessError(`Ein Platz „${name}“ existiert bereits.`);
  const aliase = p.aliase.split(',').map((x) => condense(x)).filter(Boolean).join(', ');
  const werte = {
    name, art: p.art, aliase, sort: p.sort, gueltig_von: p.gueltig_von, gueltig_bis: p.gueltig_bis, wochentage: [...new Set(p.wochentage)].sort().join(''),
    zeit_von: p.zeit_von, zeit_bis: p.zeit_bis, raster: p.raster, dauer_min: p.dauer_min, dauer_max: p.dauer_max,
    vorlauf_min: p.vorlauf_min, vorlauf_max: p.vorlauf_max, storno_frist: p.storno_frist, max_offen: p.max_offen,
    abrechnen: p.abrechnen, aktiv: p.aktiv, hinweis: p.hinweis?.trim() || null,
  };
  if (id === null) {
    const [r] = await tx`insert into tco.plaetze ${tx(werte)} returning id`;
    return r.id as number;
  }
  const [alt] = await tx`select name from tco.plaetze where id = ${id}`;
  if (!alt) throw new BusinessError('Platz nicht gefunden.', 404);
  await tx`update tco.plaetze set ${tx(werte)} where id = ${id}`;
  // Umbenennen: bestehende Portalbuchungen ziehen mit (EP3-Buchungen behalten ihre Bezeichnung – dafür gibt es die Aliase)
  if (alt.name !== name) await tx`update tco.bookings set platz = ${name} where quelle = ${QUELLE} and platz = ${alt.name}`;
  return id;
}

export async function platzLoeschen(tx: Db, id: number) {
  const p = await platzLesen(tx, id);
  const [b] = await tx`select 1 from tco.bookings where quelle = ${QUELLE} and platz = ${p.name} limit 1`;
  if (b) throw new BusinessError(`Für „${p.name}“ gibt es bereits Buchungen – bitte statt Löschen auf „inaktiv“ setzen.`);
  await tx`delete from tco.plaetze where id = ${id}`;
}

/** Namen, unter denen Buchungen dem Platz zugeordnet werden (Bezeichnung + Aliase) */
const namenVon = (p: Platz) => [p.name, ...p.aliase.split(',')].map(gross).filter(Boolean);

/** Ist der Platz an dem Tag geöffnet? Sonst Begründung */
export function geschlossen(p: Platz, datum: string): string | null {
  if (!p.aktiv) return 'Platz ist nicht aktiv';
  if (datum < p.gueltig_von) return `buchbar ab ${dat(p.gueltig_von)}`;
  if (datum > p.gueltig_bis) return `buchbar bis ${dat(p.gueltig_bis)}`;
  if (!p.wochentage.includes(String(isoWochentag(datum)))) return `${wochentagText(datum)}s geschlossen`;
  return null;
}

// ---------------------------------------------------------------------------
// Belegung
// ---------------------------------------------------------------------------

export interface Belegung {
  bid: string; datum: string; von: number; bis: number; kunde: string; status: string; platz: string; platzId: number;
  benutzer_id: string | null; quelle: string | null; assigned: string; text: string | null;
}

/** aktive Buchungen (nicht storniert/entfallen) der Plätze im Zeitraum */
export async function belegungLesen(db: Db, plaetze: Platz[], von: string, bis: string): Promise<Belegung[]> {
  const zu = new Map<string, number>();
  for (const p of plaetze) for (const n of namenVon(p)) if (!zu.has(n)) zu.set(n, p.id);
  if (!zu.size) return [];
  // EP3-Buchungen ohne Platzangabe gehören zur Halle, wenn es genau einen aktiven Hallenplatz gibt
  const hallen = await db`select name from tco.plaetze where art = 'HALLE' and aktiv`;
  const ohnePlatz = hallen.length === 1 ? plaetze.find((p) => p.name === hallen[0].name) : undefined;
  const rows = await db`
    select b.bid, b.datum::text, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis, b.kunde,
           b.status, b.platz, b.benutzer_id::text, b.quelle, coalesce(b.assigned, '') as assigned, coalesce(t.text, b.text) as text
      from tco.bookings b
      left join tco.bookingstxt t on t.bid = b.bid
     where b.datum between ${von} and ${bis}
       and coalesce(b.status, '') not in ('2', '4')
       and b.time_start is not null and b.time_ende is not null
       and (upper(trim(b.platz)) = any(${[...zu.keys()]}) ${ohnePlatz ? db`or coalesce(trim(b.platz), '') = ''` : db``})
     order by b.datum, b.time_start`;
  return rows.map((r) => {
    const e = minuten(r.bis) || 1440; // Ende 00:00 = Mitternacht
    return {
      bid: r.bid, datum: r.datum, von: minuten(r.von), bis: e, kunde: r.kunde ?? '', status: r.status ?? '', platz: r.platz,
      platzId: (r.platz?.trim() ? zu.get(gross(r.platz)) : ohnePlatz?.id)!, benutzer_id: r.benutzer_id, quelle: r.quelle, assigned: r.assigned, text: r.text,
    };
  });
}

/** gehört die Buchung dem Mitglied? Portal: buchender Benutzer; EP3: gleicher Kundenname */
export const istEigen = (b: Pick<Belegung, 'benutzer_id' | 'quelle' | 'kunde'>, ich: Ich) =>
  b.benutzer_id === ich.benutzerId || (b.quelle !== QUELLE && !!ich.kunde && gross(b.kunde) === ich.kunde);

// ---------------------------------------------------------------------------
// Preis
// ---------------------------------------------------------------------------

export interface Preis { betrag: number | null; kostenfrei: boolean; fehler: string | null; text: string }

export function preisVon(p: Platz | undefined, datum: string, von: number, bis: number, status: '1' | '3', preise: Preise): Preis {
  if (p && !p.abrechnen) return { betrag: 0, kostenfrei: true, fehler: null, text: 'kostenfrei' };
  const r = preisBerechnen({ datum, time_start: hhmm(von), time_ende: hhmm(bis), status }, preise);
  if (r.fehler) return { betrag: null, kostenfrei: false, fehler: r.fehler, text: 'Preis laut Hallenabrechnung' };
  return { betrag: r.betrag, kostenfrei: false, fehler: null, text: status === '3' ? 'Abo-Preis laut Hallenpreisen' : 'Einzelpreis laut Hallenpreisen' };
}

// ---------------------------------------------------------------------------
// Mitglied des angemeldeten Benutzers
// ---------------------------------------------------------------------------

export async function ichLesen(db: Db, benutzerId: string): Promise<Ich | null> {
  const [m] = await db`select a.adrnr, m.vorname, m.nachname from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr
                        where a.benutzer_id = ${benutzerId}`;
  if (!m) return null;
  const name = condense(`${m.vorname ?? ''} ${m.nachname ?? ''}`);
  return { benutzerId, adrnr: m.adrnr, name, kunde: name.toUpperCase() };
}

/** Benutzer ↔ Mitglied (dieselbe Zuordnung wie bei „Meine Trainingszeiten“) */
export async function benutzerZuordnen(tx: Db, benutzerId: string, adrnr: string | null) {
  const [u] = await tx`select display_name from core.users where id = ${benutzerId}`;
  if (!u) throw new BusinessError('Benutzer nicht gefunden.');
  if (adrnr) {
    const [m] = await tx`select vorname, nachname from tco.mitglieder where adrnr = ${adrnr}`;
    if (!m) throw new BusinessError('Mitglied nicht gefunden.');
    const [belegt] = await tx`select u.display_name from tco.mitgliedera a join core.users u on u.id = a.benutzer_id
                               where a.adrnr = ${adrnr} and a.benutzer_id <> ${benutzerId}`;
    if (belegt) throw new BusinessError(`${condense(`${m.vorname ?? ''} ${m.nachname ?? ''}`)} ist bereits dem Benutzer ${belegt.display_name} zugeordnet.`);
  }
  await tx`update tco.mitgliedera set benutzer_id = null where benutzer_id = ${benutzerId}`;
  if (adrnr) {
    await tx`insert into tco.mitgliedera (adrnr, benutzer_id) values (${adrnr}, ${benutzerId})
             on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id`;
    // Abos, die die Platzverwaltung vor der Zuordnung für das Mitglied angelegt hat, gehören jetzt dem Benutzer
    const ich = await ichLesen(tx, benutzerId);
    if (ich) await tx`update tco.bookings set benutzer_id = ${benutzerId} where quelle = ${QUELLE} and benutzer_id is null and upper(kunde) = ${ich.kunde}`;
  }
}

// ---------------------------------------------------------------------------
// Prüfen und Buchen
// ---------------------------------------------------------------------------

interface Slot { platz: Platz; datum: string; von: number; bis: number }

/** Regeln eines Termins; admin = Verwaltung (ohne Dauer-/Vorlaufgrenzen) */
export function regelnPruefen(s: Slot, admin: boolean, j = jetzt()): string | null {
  const { platz: p, datum, von, bis } = s;
  const zu = geschlossen(p, datum);
  if (zu) return `${p.name}: ${zu}`;
  const auf = minuten(p.zeit_von);
  const ende = minuten(p.zeit_bis);
  if (von >= bis) return 'Das Ende liegt vor dem Beginn.';
  if (von < auf || bis > ende) return `${p.name} ist von ${p.zeit_von} bis ${p.zeit_bis} Uhr buchbar.`;
  if ((von - auf) % p.raster || (bis - von) % p.raster) return `Bitte im ${p.raster}-Minuten-Raster buchen.`;
  if (admin) return null;
  if (bis - von < p.dauer_min) return `Mindestdauer ${p.dauer_min} Minuten.`;
  if (bis - von > p.dauer_max) return `Höchstdauer ${p.dauer_max} Minuten.`;
  const vor = minutenBis(datum, von, j);
  if (vor < 0) return 'Der Termin liegt in der Vergangenheit.';
  if (vor < p.vorlauf_min * 60) return `Buchungen sind bis ${p.vorlauf_min} Stunde(n) vor Beginn möglich.`;
  if (tageZwischen(j.datum, datum) > p.vorlauf_max) return `Buchungen sind höchstens ${p.vorlauf_max} Tage im Voraus möglich (bis ${dat(addTage(j.datum, p.vorlauf_max))}).`;
  return null;
}

/** Sperre je Platz und Tag gegen gleichzeitige Doppelbuchung */
async function sperren(tx: Db, platzId: number, datum: string) {
  await tx`select pg_advisory_xact_lock(hashtext(${`tco.platz|${platzId}|${datum}`}))`;
}

async function konflikt(tx: Db, s: Slot, ohneBid?: string): Promise<string | null> {
  const b = (await belegungLesen(tx, [s.platz], s.datum, s.datum))
    .find((x) => x.bid !== ohneBid && x.von < s.bis && x.bis > s.von);
  return b ? `${s.platz.name} ist am ${dat(s.datum)} von ${hhmm(b.von)} bis ${hhmm(b.bis)} Uhr bereits belegt.` : null;
}

const beschreibung = (s: Slot) => `${dat(s.datum)} von ${hhmm(s.von)} bis ${hhmm(s.bis)} Uhr`;

async function neueBid(tx: Db): Promise<string> {
  const [{ n }] = await tx`select core.next_number('TCO_PLATZ', 0)::bigint as n`;
  return `9${String(n).padStart(9, '0')}`;
}

export interface BuchungEingabe { platz_id: number; datum: string; von: string; bis: string; text?: string | null }

async function slotAus(tx: Db, e: BuchungEingabe): Promise<Slot> {
  const platz = await platzLesen(tx, e.platz_id);
  return { platz, datum: e.datum, von: minuten(e.von), bis: e.bis === '24:00' ? 1440 : minuten(e.bis) };
}

/** Einzelbuchung des Mitglieds anlegen */
export async function einzelAnlegen(tx: Db, ich: Ich, e: BuchungEingabe): Promise<{ bid: string; text: string }> {
  const s = await slotAus(tx, e);
  await sperren(tx, s.platz.id, s.datum);
  const f = regelnPruefen(s, false) ?? await konflikt(tx, s);
  if (f) throw new BusinessError(f);
  if (s.platz.max_offen > 0) {
    const j = jetzt();
    const [{ n }] = await tx`select count(distinct (bid, datum))::int as n from tco.bookings
                              where benutzer_id = ${ich.benutzerId} and platz = ${s.platz.name} and status = '1'
                                and (datum > ${j.datum} or (datum = ${j.datum} and time_ende > ${hhmm(j.min)}::time))`;
    if (n >= s.platz.max_offen) throw new BusinessError(`Auf ${s.platz.name} sind höchstens ${s.platz.max_offen} kommende Buchung(en) gleichzeitig möglich.`);
  }
  const preis = preisVon(s.platz, s.datum, s.von, s.bis, '1', await preiseLesen(tx));
  const bid = await neueBid(tx);
  await tx`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, description, preis, erstellt, assigned, text, platz, benutzer_id, quelle)
           values (${bid}, ${s.datum}, ${hhmm(s.von)}, ${hhmm(s.bis)}, ${ich.kunde}, '1', ${beschreibung(s)}, ${preis.betrag}, ${jetzt().datum},
                   ${s.platz.abrechnen ? '' : 'X'}, ${e.text?.trim() || null}, ${s.platz.name}, ${ich.benutzerId}, ${QUELLE})`;
  return { bid, text: `${s.platz.name} am ${beschreibung(s)} gebucht.` };
}

/** eigene Portal-Einzelbuchung lesen und Änderbarkeit prüfen */
async function eigeneEinzel(tx: Db, ich: Ich, bid: string) {
  const [b] = await tx`select bid, datum::text, to_char(time_start, 'HH24:MI') as von, to_char(time_ende, 'HH24:MI') as bis, status, platz,
                              coalesce(assigned, '') as assigned
                         from tco.bookings where bid = ${bid} and benutzer_id = ${ich.benutzerId} and quelle = ${QUELLE}`;
  // fremde Buchungen: gleiche Meldung wie „nicht vorhanden“ – keine Rückschlüsse auf andere Mitglieder
  if (!b) throw new BusinessError('Buchung nicht gefunden.', 404);
  if (b.status === '3') throw new BusinessError('Abos werden über die Platzverwaltung geändert.');
  if (b.status !== '1') throw new BusinessError('Die Buchung ist bereits storniert.');
  if (b.assigned === 'Y') throw new BusinessError('Die Buchung ist bereits abgerechnet.');
  const platz = (await plaetzeLesen(tx)).find((p) => p.name === b.platz);
  const frist = (platz?.storno_frist ?? 0) * 60;
  if (minutenBis(b.datum, minuten(b.von)) < frist) {
    throw new BusinessError(frist ? `Ändern und Stornieren ist nur bis ${platz!.storno_frist} Stunde(n) vor Beginn möglich.` : 'Der Termin hat bereits begonnen.');
  }
  return b as { bid: string; datum: string; von: string; bis: string; platz: string };
}

export async function einzelAendern(tx: Db, ich: Ich, bid: string, e: BuchungEingabe): Promise<string> {
  const alt = await eigeneEinzel(tx, ich, bid);
  const s = await slotAus(tx, e);
  await sperren(tx, s.platz.id, s.datum);
  const f = regelnPruefen(s, false) ?? await konflikt(tx, s, bid);
  if (f) throw new BusinessError(f);
  const preis = preisVon(s.platz, s.datum, s.von, s.bis, '1', await preiseLesen(tx));
  await tx`update tco.bookings
              set datum = ${s.datum}, time_start = ${hhmm(s.von)}, time_ende = ${hhmm(s.bis)}, platz = ${s.platz.name},
                  description = ${beschreibung(s)}, preis = ${preis.betrag}, geaendert = ${jetzt().datum},
                  assigned = ${s.platz.abrechnen ? '' : 'X'}, text = ${e.text?.trim() || null}
            where bid = ${bid} and datum = ${alt.datum}`;
  return `Buchung geändert: ${s.platz.name} am ${beschreibung(s)}.`;
}

export async function einzelStornieren(tx: Db, ich: Ich, bid: string): Promise<string> {
  const b = await eigeneEinzel(tx, ich, bid);
  await tx`update tco.bookings set status = '2', geaendert = ${jetzt().datum} where bid = ${bid} and datum = ${b.datum}`;
  return `Buchung am ${dat(b.datum)} von ${b.von} bis ${b.bis} Uhr storniert.`;
}

// ---------------------------------------------------------------------------
// Tagesansicht (Kalender): eigene Buchungen mit Details, fremde nur „belegt“
// ---------------------------------------------------------------------------

export interface TagPlatz {
  id: number; name: string; art: string; hinweis: string | null; zeit_von: string; zeit_bis: string; raster: number;
  dauer_min: number; dauer_max: number; vorlauf_min: number; vorlauf_max: number; storno_frist: number; abrechnen: boolean;
  geschlossen: string | null;
  belegt: { von: string; bis: string; eigen: boolean; bid?: string; art?: 'Einzel' | 'Abo'; betrag?: number | null; aenderbar?: boolean; kunde?: string; text?: string | null }[];
}

export async function tagLesen(db: Db, datum: string, sicht: Ich | 'admin'): Promise<TagPlatz[]> {
  const plaetze = (await plaetzeLesen(db, true)).filter((p) => p.gueltig_bis >= datum);
  const bel = await belegungLesen(db, plaetze, datum, datum);
  const preise = await preiseLesen(db);
  const j = jetzt();
  return plaetze.map((p) => ({
    id: p.id, name: p.name, art: p.art, hinweis: p.hinweis, zeit_von: p.zeit_von, zeit_bis: p.zeit_bis, raster: p.raster,
    dauer_min: p.dauer_min, dauer_max: p.dauer_max, vorlauf_min: p.vorlauf_min, vorlauf_max: p.vorlauf_max, storno_frist: p.storno_frist,
    abrechnen: p.abrechnen, geschlossen: geschlossen(p, datum),
    belegt: bel.filter((b) => b.platzId === p.id).map((b) => {
      const zeit = { von: hhmm(b.von), bis: hhmm(b.bis) };
      const art = b.status === '3' ? 'Abo' as const : 'Einzel' as const;
      if (sicht === 'admin') return { ...zeit, eigen: false, bid: b.bid, art, kunde: b.kunde, text: b.text };
      // fremde Buchung: nur Zeitraum – kein Name, keine Nummer, kein Text
      if (!istEigen(b, sicht)) return { ...zeit, eigen: false };
      return {
        ...zeit, eigen: true, bid: b.bid, art, text: b.text,
        betrag: preisVon(p, b.datum, b.von, b.bis, art === 'Abo' ? '3' : '1', preise).betrag,
        aenderbar: b.quelle === QUELLE && art === 'Einzel' && b.assigned !== 'Y' && minutenBis(b.datum, b.von, j) >= p.storno_frist * 60,
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Meine Buchungen (Einzel und Abo)
// ---------------------------------------------------------------------------

export interface MeineEinzel {
  bid: string; datum: string; von: string; bis: string; platz: string; platz_id: number | null; art: string; status: string;
  preis: Preis; aenderbar: boolean; aenderbar_bis: string | null; quelle: string; text: string | null; abgerechnet: boolean;
}
export interface MeinAbo {
  bid: string; platz: string; wochentag: string; von: string; bis: string; erster: string; letzter: string;
  termine: number; kommend: number; naechster: string | null; preis: Preis; text: string | null; quelle: string;
}

export async function meineLesen(db: Db, ich: Ich, zeitraum: 'kommend' | 'vergangen'): Promise<{ einzel: MeineEinzel[]; abos: MeinAbo[] }> {
  const j = jetzt();
  const plaetze = await plaetzeLesen(db);
  const zuPlatz = (name: string | null) => plaetze.find((p) => namenVon(p).includes(gross(name)));
  const rows = await db`
    select b.bid, b.datum::text, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis, b.status, b.platz,
           b.quelle, coalesce(b.assigned, '') as assigned, coalesce(t.text, b.text) as text, b.benutzer_id::text, b.kunde
      from tco.bookings b
      left join tco.bookingstxt t on t.bid = b.bid
     where (b.benutzer_id = ${ich.benutzerId} or (b.quelle is distinct from ${QUELLE} and upper(trim(b.kunde)) = ${ich.kunde}))
       and b.time_start is not null and b.time_ende is not null
       and coalesce(b.status, '') in ('1', '2', '3')
       and b.datum between ${addTage(j.datum, -400)} and ${addTage(j.datum, 400)}
     order by b.datum, b.time_start`;
  const preise = await preiseLesen(db);
  const istKommend = (r: Record<string, unknown>) => minutenBis(String(r.datum), minuten(String(r.bis)), j) > 0;

  const einzel: MeineEinzel[] = [];
  const aboRows = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!istEigen(r as never, ich)) continue;
    if (r.status === '3') { aboRows.set(r.bid, [...(aboRows.get(r.bid) ?? []), r] as never); continue; }
    if (istKommend(r) !== (zeitraum === 'kommend')) continue;
    if (r.status === '2' && zeitraum === 'vergangen') continue;
    const p = zuPlatz(r.platz);
    const von = minuten(r.von);
    const frist = (p?.storno_frist ?? 0) * 60;
    const aenderbar = r.status === '1' && r.quelle === QUELLE && r.assigned !== 'Y' && minutenBis(r.datum, von, j) >= frist;
    const fristEnde = new Date(Date.parse(`${r.datum}T00:00:00Z`) + (von - frist) * 60_000);
    einzel.push({
      bid: r.bid, datum: r.datum, von: r.von, bis: r.bis, platz: r.platz ?? '–', platz_id: p?.id ?? null,
      art: p ? ARTEN[p.art] : '', status: r.status,
      preis: r.status === '2' ? { betrag: 0, kostenfrei: false, fehler: null, text: 'storniert' } : preisVon(p, r.datum, von, minuten(r.bis), '1', preise),
      aenderbar, aenderbar_bis: aenderbar && frist ? `${dat(fristEnde.toISOString().slice(0, 10))} ${fristEnde.toISOString().slice(11, 16)} Uhr` : null,
      quelle: r.quelle === QUELLE ? 'Portal' : 'EP3', text: r.text, abgerechnet: r.assigned === 'Y',
    });
  }
  if (zeitraum === 'vergangen') einzel.reverse();

  const abos: MeinAbo[] = [];
  for (const [bid, termine] of aboRows) {
    const kommende = termine.filter((t) => istKommend(t));
    if ((zeitraum === 'kommend') !== (kommende.length > 0)) continue;
    const t0 = termine[0];
    const p = zuPlatz(t0.platz);
    abos.push({
      bid, platz: t0.platz ?? '–', wochentag: wochentagText(t0.datum), von: t0.von, bis: t0.bis,
      erster: t0.datum, letzter: termine[termine.length - 1].datum, termine: termine.length, kommend: kommende.length,
      naechster: kommende[0]?.datum ?? null, preis: preisVon(p, t0.datum, minuten(t0.von), minuten(t0.bis), '3', preise),
      text: t0.text, quelle: t0.quelle === QUELLE ? 'Portal' : 'EP3',
    });
  }
  return { einzel, abos };
}

// ---------------------------------------------------------------------------
// Abos (nur Platzverwaltung im Portal)
// ---------------------------------------------------------------------------

export interface AboEingabe { platz_id: number; adrnr: string; ab: string; bis_datum: string; von: string; bis: string; text?: string | null }
export interface AboTermin { datum: string; konflikt: string | null }

export async function aboVorschau(db: Db, e: AboEingabe) {
  const platz = await platzLesen(db, e.platz_id);
  const [m] = await db`select vorname, nachname from tco.mitglieder where adrnr = ${e.adrnr}`;
  if (!m) throw new BusinessError('Mitglied nicht gefunden.');
  if (e.bis_datum < e.ab) throw new BusinessError('Das Ende der Serie liegt vor dem Beginn.');
  if (tageZwischen(e.ab, e.bis_datum) > 366) throw new BusinessError('Ein Abo umfasst höchstens ein Jahr.');
  const von = minuten(e.von);
  const bis = e.bis === '24:00' ? 1440 : minuten(e.bis);
  const daten: string[] = [];
  for (let d = e.ab; d <= e.bis_datum; d = addTage(d, 7)) daten.push(d);
  const bel = await belegungLesen(db, [platz], e.ab, e.bis_datum);
  const termine: AboTermin[] = daten.map((d) => {
    const f = regelnPruefen({ platz, datum: d, von, bis }, true);
    if (f) return { datum: d, konflikt: f };
    const b = bel.find((x) => x.datum === d && x.von < bis && x.bis > von);
    return { datum: d, konflikt: b ? `belegt ${hhmm(b.von)}–${hhmm(b.bis)} Uhr (${b.status === '3' ? 'Abo' : 'Einzel'}, ${b.kunde || 'ohne Namen'})` : null };
  });
  const preis = preisVon(platz, e.ab, von, bis, '3', await preiseLesen(db));
  return { platz: platz.name, kunde: condense(`${m.vorname ?? ''} ${m.nachname ?? ''}`), wochentag: wochentagText(e.ab), termine, preis };
}

export async function aboAnlegen(tx: Db, e: AboEingabe, ueberspringen: boolean): Promise<{ bid: string; text: string }> {
  await sperren(tx, e.platz_id, 'abo');
  const v = await aboVorschau(tx, e);
  const frei = v.termine.filter((t) => !t.konflikt);
  const belegt = v.termine.filter((t) => t.konflikt);
  if (belegt.length && !ueberspringen) {
    throw new BusinessError(`${belegt.length} Termin(e) nicht frei: ${belegt.slice(0, 5).map((t) => `${dat(t.datum)} (${t.konflikt})`).join('; ')}${belegt.length > 5 ? ' …' : ''}`);
  }
  if (!frei.length) throw new BusinessError('Kein freier Termin in diesem Zeitraum.');
  const platz = await platzLesen(tx, e.platz_id);
  const [lnk] = await tx`select benutzer_id::text from tco.mitgliedera where adrnr = ${e.adrnr}`;
  const bid = await neueBid(tx);
  const von = minuten(e.von);
  const bis = e.bis === '24:00' ? 1440 : minuten(e.bis);
  for (const t of frei) {
    await tx`insert into tco.bookings (bid, datum, time_start, time_ende, kunde, status, description, preis, erstellt, assigned, text, platz, benutzer_id, quelle)
             values (${bid}, ${t.datum}, ${hhmm(von)}, ${hhmm(bis)}, ${v.kunde.toUpperCase()}, '3', ${beschreibung({ platz, datum: t.datum, von, bis })},
                     ${v.preis.betrag}, ${jetzt().datum}, ${platz.abrechnen ? '' : 'X'}, ${e.text?.trim() || null}, ${platz.name}, ${lnk?.benutzer_id ?? null}, ${QUELLE})`;
  }
  return { bid, text: `Abo ${bid} für ${v.kunde} angelegt: ${frei.length} Termin(e) ${v.wochentag}s ${hhmm(von)}–${hhmm(bis)} Uhr auf ${platz.name}${belegt.length ? `, ${belegt.length} belegte Termin(e) ausgelassen` : ''}.` };
}

export async function abosLesen(db: Db) {
  const rows = await db`
    select b.bid, min(b.platz) as platz, min(b.kunde) as kunde, min(b.datum)::text as erster, max(b.datum)::text as letzter,
           to_char(min(b.time_start), 'HH24:MI') as von, to_char(max(b.time_ende), 'HH24:MI') as bis,
           count(*) filter (where b.status = '3')::int as termine, count(*) filter (where b.status = '3' and b.datum >= current_date)::int as kommend,
           count(*) filter (where b.assigned = 'Y')::int as abgerechnet, min(b.text) as text
      from tco.bookings b
     where b.quelle = ${QUELLE} and b.bid in (select bid from tco.bookings where quelle = ${QUELLE} and status = '3')
     group by b.bid
     order by min(b.datum) desc`;
  return rows.map((r) => ({ ...r, wochentag: wochentagText(r.erster) }));
}

/** Abo ab einem Datum beenden (offene Termine stornieren) */
export async function aboBeenden(tx: Db, bid: string, ab: string): Promise<string> {
  const r = await tx`update tco.bookings set status = '2', geaendert = ${jetzt().datum}
                      where bid = ${bid} and quelle = ${QUELLE} and status = '3' and datum >= ${ab} and coalesce(assigned, '') <> 'Y'
                      returning datum`;
  if (!r.length) throw new BusinessError('Keine offenen Abo-Termine ab diesem Datum.');
  return `Abo ${bid}: ${r.length} Termin(e) ab ${dat(ab)} storniert.`;
}

/** Verwaltung: einzelnen Portal-Termin stornieren (ohne Fristen) */
export async function verwaltungStornieren(tx: Db, bid: string, datum: string): Promise<string> {
  const [b] = await tx`select quelle, status, coalesce(assigned, '') as assigned from tco.bookings where bid = ${bid} and datum = ${datum}`;
  if (!b) throw new BusinessError('Buchung nicht gefunden.', 404);
  if (b.quelle !== QUELLE) throw new BusinessError('EP3-Buchungen bitte im EP3-Buchungssystem stornieren (der nächste Import überschreibt sie sonst).');
  if (b.assigned === 'Y') throw new BusinessError('Die Buchung ist bereits abgerechnet.');
  if (!['1', '3'].includes(b.status)) throw new BusinessError('Die Buchung ist bereits storniert.');
  await tx`update tco.bookings set status = '2', geaendert = ${jetzt().datum} where bid = ${bid} and datum = ${datum}`;
  return `Buchung ${bid} am ${dat(datum)} storniert.`;
}

/** Verwaltung: Benutzer mit Mitgliedszuordnung und Mitglieder zur Auswahl */
export async function benutzerListe(db: Db) {
  const benutzer = await db`
    select u.id::text as id, u.display_name as name, u.username, a.adrnr,
           nullif(trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '')), '') as mitglied
      from core.users u
      left join tco.mitgliedera a on a.benutzer_id = u.id
      left join tco.mitglieder m on m.adrnr = a.adrnr
     where u.active
     order by u.display_name`;
  const mitglieder = await db`
    select adrnr, trim(coalesce(vorname, '') || ' ' || coalesce(nachname, '')) as name
      from tco.mitglieder where austritt is null or austritt >= current_date
     order by nachname, vorname`;
  return { benutzer, mitglieder };
}
