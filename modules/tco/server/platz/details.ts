/**
 * Platzverwaltung – Details eines Termins (Doppelklick in der Belegung): Termin, Person (Kunde, Spieler, Benutzer, Mitglied),
 * Preis und Abrechnung (Hallenrechnung), Abo-Serie, Anlage und Änderung, Notiz, Storno. Nur lesend; geändert wird wie bisher
 * über den Termin-Dialog.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { RG_STATUS } from '../halle/daten.js';

export const BUCHUNG_STATUS: Record<string, string> = { '1': 'Einzelbuchung', '2': 'storniert', '3': 'Abo-Termin', '4': 'entfallen' };

export interface BuchungDetails {
  bid: string; datum: string; von: string | null; bis: string | null; platz: string | null;
  status: string; status_text: string; art: 'Einzel' | 'Abo';
  kunde: string | null; spieler: string | null; text: string | null; beschreibung: string | null;
  preis: number | null; abgerechnet: boolean;
  quelle: 'PORTAL' | 'EP3'; erstellt: string | null; erstellt_um: string | null; erstellt_von: string | null; geaendert: string | null;
  storno_grund: string | null; storno_am: string | null;
  benutzer: { username: string; name: string; email: string | null } | null;
  mitglied: { adrnr: string; name: string; mitglnr: string | null; email: string | null; telefon: string | null } | null;
  rechnungen: { rgnr: string; status: string; datum: string | null; betrag: number | null }[];
  abo: { termine: number; kommend: number; storniert: number; abgerechnet: number; erster: string; letzter: string } | null;
}

export async function buchungDetails(db: Db, bid: string, datum: string): Promise<BuchungDetails> {
  const [b] = await db`
    select b.bid, b.datum::text, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis, b.platz,
           coalesce(b.status, '') as status, b.kunde, b.spieler, coalesce(t.text, b.text) as text, b.description,
           b.preis::float8 as preis, coalesce(b.assigned, '') = 'Y' as abgerechnet, b.quelle,
           b.erstellt::text as erstellt, to_char(b.erstellt_um at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as erstellt_um, b.erstellt_von,
           coalesce(to_char(b.portal_geaendert at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI'), b.geaendert::text) as geaendert,
           b.storno_grund, to_char(b.storno_portal at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as storno_am,
           u.username, u.display_name, u.email as benutzer_email, b.benutzer_id::text as benutzer_id
      from tco.bookings b
      left join tco.bookingstxt t on t.bid = b.bid
      left join core.users u on u.id = b.benutzer_id
     where b.bid = ${bid} and b.datum = ${datum}`;
  if (!b) throw new BusinessError('Buchung nicht gefunden.', 404);

  // Mitglied: über den Benutzer der Buchung, sonst über den EP3-Kunden (Name wie in der Buchung)
  const [m] = await db`
    select m.adrnr, trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '')) as name, m.mitglnrn, m.email,
           nullif(coalesce(nullif(trim(m.telefon6), ''), trim(m.telefon)), '') as telefon
      from tco.mitglieder m
     where m.adrnr = coalesce(
             (select mb.adrnr from tco.mitglied_benutzer mb where mb.benutzer_id = ${b.benutzer_id ?? null}::uuid),
             (select a.adrnr from tco.mitgliedera a join tco.kunden k on k.zuid = a.zuid
               where ${b.kunde ?? ''} <> '' and upper(trim(coalesce(k.vorname, '') || ' ' || coalesce(k.nachname, ''))) = upper(trim(${b.kunde ?? ''}))
               limit 1))`;

  const rechnungen = await db`
    select p.rgnr_txt as rgnr, coalesce(k.status, '') as status, k.angelegt_am::text as datum, p.preis::float8 as betrag
      from tco.rgpos p join tco.rgkopf k on k.rgnr_txt = p.rgnr_txt
     where p.bid = ${bid} and (p.datum is null or p.datum = ${datum})
     order by p.rgnr_txt`;

  const [abo] = b.status === '3' || (await db`select 1 from tco.bookings where bid = ${bid} and status = '3' limit 1`).length
    ? await db`
        select count(*) filter (where status = '3')::int as termine,
               count(*) filter (where status = '3' and datum >= current_date)::int as kommend,
               count(*) filter (where status in ('2', '4'))::int as storniert,
               count(*) filter (where assigned = 'Y')::int as abgerechnet,
               min(datum)::text as erster, max(datum)::text as letzter
          from tco.bookings where bid = ${bid}`
    : [];

  return {
    bid: b.bid, datum: b.datum, von: b.von, bis: b.bis === '00:00' ? '24:00' : b.bis, platz: b.platz,
    status: b.status, status_text: BUCHUNG_STATUS[b.status] ?? (b.status || 'unbekannt'), art: abo ? 'Abo' : 'Einzel',
    kunde: b.kunde, spieler: b.spieler, text: b.text, beschreibung: b.description,
    preis: b.preis, abgerechnet: b.abgerechnet,
    quelle: b.quelle === 'PORTAL' ? 'PORTAL' : 'EP3', erstellt: b.erstellt, erstellt_um: b.erstellt_um, erstellt_von: b.erstellt_von, geaendert: b.geaendert,
    storno_grund: b.storno_grund, storno_am: b.storno_am,
    benutzer: b.username ? { username: b.username, name: b.display_name, email: b.benutzer_email ?? null } : null,
    mitglied: m ? { adrnr: m.adrnr, name: m.name, mitglnr: m.mitglnrn ?? null, email: m.email ?? null, telefon: m.telefon ?? null } : null,
    rechnungen: rechnungen.map((r) => ({ rgnr: r.rgnr, status: r.status ? `${r.status} – ${RG_STATUS[r.status] ?? ''}`.replace(/ – $/, '') : '', datum: r.datum, betrag: r.betrag })),
    abo: abo ? { termine: abo.termine, kommend: abo.kommend, storniert: abo.storniert, abgerechnet: abo.abgerechnet, erster: abo.erster, letzter: abo.letzter } : null,
  };
}
