/**
 * Arbeitsvorrat der Vereinsübersicht: offene Vorgänge, die jemand im Verein erledigen muss.
 * Jeder Eintrag erscheint nur, wenn der Benutzer die zugehörige App bedienen darf.
 *
 * Gruppierung (bereich) nach Zuständigkeit im Verein:
 *  - Jugendwart:  alles rund um das Schnuppertraining – jede neue Anmeldung einzeln
 *  - Kassenwart:  heute erfasste Hallenbuchungen (mit den einzelnen Buchungen darunter), freigegebene Zeitnachweise der Trainer,
 *                 neue Mitgliedsanträge und Vertragswechsel – je Antrag
 *  - Vorstand:    neue Registrierungen und deren Freigabe
 *  - Hallenwart:  Halle aufsperren (Buchungen ohne Hallenschlüssel)
 *  - Clubhaus, Administration: wie bisher
 */
import type { FastifyRequest } from 'fastify';
import { can } from '../../../../server/src/auth.js';
import type { Db } from '../verein.js';
import { monatsname } from '../jt/logik.js';
import { ADRNR_ZU_BENUTZER, HALLENWART } from '../platz/schluessel.js';

export interface Aufgabe {
  key: string;
  bereich: string;
  titel: string;
  text: string;
  /** YYYY-MM-DD – Eingang des Vorgangs */
  datum: string | null;
  icon: string;
  state: 'Information' | 'Critical' | 'Negative';
  /** Portalpfad zum Bearbeiten */
  pfad: string;
  betrag?: number;
  /** Kästchen am Eintrag: bestätigt die Erledigung (POST auf url mit body), der Eintrag verschwindet danach */
  erledigen?: { text: string; url: string; body: Record<string, unknown> };
  /** Unterpunkte (z. B. die einzelnen Buchungen zu „Heute n Hallenbuchungen“) */
  kinder?: Aufgabe[];
}

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function arbeitsvorrat(db: Db, req: FastifyRequest): Promise<Aufgabe[]> {
  const out: Aufgabe[] = [];

  // Kassenwart: vom Trainer freigegebene, noch nicht (vollständig) bezahlte Zeitnachweise
  if (can(req, 'tco.jt:display')) {
    const rows = await db`
      select d.adrnr, d.monat, d.belegnr, coalesce(d.stunden, 0)::float8 as stunden, coalesce(d.betrag, 0)::float8 as betrag,
             coalesce(d.bezahlt_betrag, 0)::float8 as bezahlt_betrag,
             to_char(d.freigegeben_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am,
             coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), d.adrnr) as name,
             d.oeffnung_angefragt_am is not null as oeffnung, d.oeffnung_grund
        from tco.jt_doku d left join tco.mitglieder m on m.adrnr = d.adrnr
       where d.freigegeben_am is not null and (d.bezahlt_am is null or coalesce(d.bezahlt_betrag, 0) < coalesce(d.betrag, 0))
       order by d.freigegeben_am`;
    for (const r of rows) {
      const offen = Math.max(0, Number(r.betrag) - Number(r.bezahlt_betrag));
      out.push(r.oeffnung ? {
        key: `JT:${r.adrnr}:${r.monat}`, bereich: 'Kassenwart', icon: 'unlocked', state: 'Critical',
        titel: `${r.name} bittet um Öffnung von ${monatsname(r.monat)}`,
        text: r.oeffnung_grund ? `Grund: ${r.oeffnung_grund}` : 'Freigabe zurücknehmen, damit der Trainer korrigieren kann.',
        datum: r.am, pfad: `/tco/jugendtraining?monat=${r.monat}&tab=abr`, betrag: offen,
      } : {
        key: `JT:${r.adrnr}:${r.monat}`, bereich: 'Kassenwart', icon: 'family-care', state: 'Information',
        titel: `Zeitnachweis ${r.name} – ${monatsname(r.monat)} freigegeben`,
        text: `${Number(r.stunden).toLocaleString('de-DE')} Std., ${eur(offen)} € zur Zahlung${r.belegnr ? ` · ${r.belegnr}` : ''}`,
        datum: r.am, pfad: `/tco/jugendtraining?monat=${r.monat}&tab=abr`, betrag: offen,
      });
    }
  }

  // Clubhaus-Verzehr: offene Gastbelege (nicht kassiert) und überfällige Sammelabrechnungen
  if (can(req, 'tco.verzehr:display')) {
    const [g] = await db`select count(*)::int as n, coalesce(sum(betrag), 0)::float8 as betrag, to_char(min(datum), 'YYYY-MM-DD') as seit
                           from tco.vz_belege where art = 'GAST' and status = 'OFFEN' and datum < current_date`;
    if (g?.n) {
      out.push({
        key: 'VZ_GAST_OFFEN', bereich: 'Clubhaus', icon: 'meal', state: 'Critical',
        titel: `${g.n} Gastbeleg${g.n === 1 ? '' : 'e'} nicht kassiert`,
        text: `${eur(Number(g.betrag))} € aus vergangenen Abenden – an der Theke kassieren oder stornieren.`,
        datum: g.seit, pfad: '/tco/theke', betrag: Number(g.betrag),
      });
    }
    const [f] = await db`select count(*)::int as n, coalesce(sum(betrag), 0)::float8 as betrag, to_char(min(faellig), 'YYYY-MM-DD') as seit
                           from tco.vz_belege where art = 'SAMMEL' and status = 'GESTELLT' and faellig < current_date and zahlart <> 'LASTSCHRIFT'`;
    if (f?.n) {
      out.push({
        key: 'VZ_UEBERFAELLIG', bereich: 'Clubhaus', icon: 'receipt', state: 'Critical',
        titel: `${f.n} Verzehrabrechnung${f.n === 1 ? '' : 'en'} überfällig`,
        text: `${eur(Number(f.betrag))} € offen – Zahlungseingang prüfen oder erinnern.`,
        datum: f.seit, pfad: '/tco/verzehrbuch?tab=belege', betrag: Number(f.betrag),
      });
    }
    const [o] = await db`select count(distinct adrnr)::int as n, coalesce(sum(betrag), 0)::float8 as betrag from tco.vz_posten
                           where adrnr is not null and rgnr is null and storniert_am is null and datum < date_trunc('month', current_date)`;
    if (o?.n) {
      out.push({
        key: 'VZ_ABSCHLUSS', bereich: 'Clubhaus', icon: 'sales-order', state: 'Information',
        titel: 'Monatsabschluss Verzehr steht an',
        text: `${o.n} Mitglied${o.n === 1 ? '' : 'er'} mit ${eur(Number(o.betrag))} € offenem Verzehr aus Vormonaten.`,
        datum: null, pfad: '/tco/verzehrbuch?tab=abschluss', betrag: Number(o.betrag),
      });
    }
  }

  // Sicherung: täglicher Nextcloud-Export fehlgeschlagen bzw. seit über 36 Stunden ohne Erfolg
  if (can(req, 'core.backup:create')) {
    const [b] = await db`select aktiv, letzter_fehler, letzte_meldung, to_char(letzter_lauf at time zone 'Europe/Berlin', 'YYYY-MM-DD') as lauf,
                                (letzter_erfolg is null or letzter_erfolg < now() - interval '36 hours') as veraltet
                           from core.backup_export where id = 1`;
    if (b?.aktiv && (b.letzter_fehler || b.veraltet)) {
      out.push({
        key: 'BACKUP_EXPORT', bereich: 'Administration', icon: 'cloud', state: 'Negative',
        titel: b.letzter_fehler ? 'Nextcloud-Export der Sicherung fehlgeschlagen' : 'Keine aktuelle Sicherung in der Nextcloud',
        text: b.letzte_meldung ?? 'Der tägliche Export ist noch nicht gelaufen.', datum: b.lauf, pfad: '/admin/sicherung',
      });
    }
  }

  // Vorstand: Registrierungen von Mitgliedern – je Antrag mit Zuordnungsvorschlag, prüfen und freigeben
  if (can(req, 'tco.registrierung:mitglied')) {
    const { registrierungenLesen } = await import('../platz/registrierung.js');
    for (const r of (await registrierungenLesen(db, 'OFFEN', 'MITGLIED')) as (Record<string, any> & { vorschlaege: { art: string; name: string; info: string; grund: string }[] })[]) {
      const v = r.vorschlaege.find((x) => x.art === 'MITGLIED');
      out.push({
        key: `REG_MITGLIED:${r.id}`, bereich: 'Vorstand', icon: 'add-employee', state: v ? 'Information' : 'Critical',
        titel: `Registrierung ${r.anzeigename} als Mitglied`,
        text: v ? `Vorschlag: ${v.name} – ${v.info} (${v.grund}). Prüfen und freigeben.` : 'Kein passendes Mitglied gefunden – bitte prüfen, zuordnen oder ablehnen.',
        datum: new Date(r.erstellt).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10), pfad: `/tco/registrierungen?id=${r.id}`,
      });
    }
  }

  // Kassenwart: Mitgliedsanträge und Vertragswechsel (bestätigte Vertragsangebote) – je Antrag, warten auf Prüfung und Übernahme
  if (can(req, 'tco.antraege:edit')) {
    const rows = await db`
      select a.id, a.nummer, to_char(a.eingang at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am, a.daten,
             coalesce((select (v.daten->>'vertragsaenderung')::boolean from tco.vertragsangebote v where v.nummer = a.daten->>'angebot_nr'), false) as wechsel
        from tco.mitgliedsantraege a where a.status = 'EINGANG' order by a.eingang`;
    for (const r of rows) {
      const pers = ((r.daten?.personen ?? []) as { vorname?: string; nachname?: string }[]).map((p) => `${p.vorname ?? ''} ${p.nachname ?? ''}`.trim()).filter(Boolean);
      const name = pers.length > 1 ? `${pers[0]} und ${pers.length - 1} weitere` : pers[0] ?? r.nummer;
      out.push({
        key: `MITGLIEDSANTRAG:${r.id}`, bereich: 'Kassenwart', icon: r.wechsel ? 'request' : 'personnel-view', state: 'Critical',
        titel: r.wechsel ? `Vertragswechsel ${name}` : `Mitgliedsantrag ${name}`,
        text: r.wechsel ? `${r.nummer} · Vertragsangebot bestätigt – prüfen und übernehmen (Verträge werden ergänzt).`
          : `${r.nummer} · online eingegangen – prüfen und übernehmen (Mitglied, Vertrag, SEPA-Mandat und Benutzer werden angelegt).`,
        datum: r.am, pfad: '/tco/mitgliedsantraege',
      });
    }
  }

  // Jugendwart: Schnuppertraining (#86) – jede neue Anmeldung wartet auf Kontaktaufnahme
  if (can(req, 'tco.schnupper:edit')) {
    const rows = await db`
      select s.adrnr, s.nummer, to_char(s.eingang at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am, s.alter_jahre, s.stufe, s.mitteilung,
             coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), s.nummer) as name
        from tco.schnupper s left join tco.mitglieder m on m.adrnr = s.adrnr
       where s.status = 'NEU' order by s.eingang`;
    const STUFE: Record<string, string> = { NEU: 'neu im Tennis', ANFAENGER: 'Anfänger', FORTGESCHRITTEN: 'fortgeschritten' };
    for (const r of rows) {
      out.push({
        key: `SCHNUPPER:${r.adrnr}`, bereich: 'Jugendwart', icon: 'physical-activity', state: 'Critical',
        titel: `Anmeldung zum Schnuppertraining: ${r.name}`,
        text: [r.nummer, r.alter_jahre != null ? `${r.alter_jahre} Jahre` : '', STUFE[r.stufe] ?? '', r.mitteilung ? `„${String(r.mitteilung).slice(0, 120)}“` : '',
          'bitte Kontakt aufnehmen und einen Termin vereinbaren'].filter(Boolean).join(' · '),
        datum: r.am, pfad: '/tco/schnuppertraining',
      });
    }
  }

  // Hallenwart (#11): kommende Hallen-Einzelbuchungen (heute + 7 Tage) von Personen ohne Hallenschlüssel am Buchungstag – aufsperren
  if (can(req, 'tco.platzbuchung:verwalten')) {
    const rows = await db`
      select b.bid, b.datum::text as datum, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis,
             coalesce(nullif(trim(u.display_name), ''), initcap(b.kunde)) as name
        from tco.bookings b
        join tco.plaetze p on upper(trim(p.name)) = upper(trim(b.platz)) and p.art = 'HALLE'
        left join core.users u on u.id = b.benutzer_id
       where b.status = '1' and b.benutzer_id is not null
         and b.datum between current_date and current_date + 7
         and not exists (select 1 from tco.schluessel s
                          where s.adrnr = ${db.unsafe(ADRNR_ZU_BENUTZER('b.benutzer_id'))} and s.ausgabe is not null and s.ausgabe <= b.datum
                            and (s.ruecknahme is null or s.ruecknahme > b.datum))
         and not exists (select 1 from tco.halle_geklaert g where g.bid = b.bid and g.datum = b.datum)
       order by b.datum, b.time_start`;
    for (const r of rows) {
      const [j, m, t] = [r.datum.slice(0, 4), r.datum.slice(5, 7), r.datum.slice(8, 10)];
      out.push({
        key: `HALLENWART:${r.bid}:${r.datum}`, bereich: 'Hallenwart', icon: 'locked', state: 'Information',
        titel: `Halle aufsperren: ${t}.${m}.${j} ${r.von}–${r.bis} Uhr`,
        text: `${r.name} hat keinen Hallenschlüssel – meldet sich bei ${HALLENWART.name}.`,
        datum: r.datum, pfad: can(req, 'tco.platz:admin') ? `/tco/platzverwaltung?tab=belegung&datum=${r.datum}` : `/tco/platz-buchen?datum=${r.datum}`,
        erledigen: { text: 'mit dem Kunden geklärt', url: '/dashboard/arbeitsvorrat/halle-geklaert', body: { bid: r.bid, datum: r.datum } },
      });
    }
  }

  // Kassenwart: heute über Einzelbuchungen erfasste Hallenbuchungen – darunter die einzelnen Buchungen mit Absprung in die Buchungsmaske
  if (can(req, 'tco.halle:display') || can(req, 'tco.platzbuchung:verwalten')) {
    const maske = can(req, 'tco.platz:admin') ? (d: string) => `/tco/platzverwaltung?tab=belegung&datum=${d}`
      : can(req, 'tco.platzbuchung:verwalten') ? (d: string) => `/tco/platz-buchen?datum=${d}` : () => '/tco/halle';
    const rows = await db`
      select b.bid, b.datum::text as datum, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis,
             coalesce(nullif(trim(u.display_name), ''), initcap(b.kunde), '–') as name, b.preis::float8 as preis, coalesce(b.quelle, 'EP3') as quelle
        from tco.bookings b
        join tco.plaetze p on upper(trim(p.name)) = upper(trim(b.platz)) and p.art = 'HALLE'
        left join core.users u on u.id = b.benutzer_id
       where b.status = '1' and b.erstellt = current_date
       order by b.datum, b.time_start`;
    if (rows.length) {
      const tm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
      const summe = rows.reduce((x, r) => x + Number(r.preis ?? 0), 0);
      out.push({
        key: 'HALLE_HEUTE', bereich: 'Kassenwart', icon: 'appointment-2', state: 'Information',
        titel: `Heute ${rows.length} Hallenbuchung${rows.length === 1 ? '' : 'en'} als Einzelbuchung erfasst`,
        text: `Neu angelegte Einzelbuchungen der Halle (Portal und EP3) mit Erfassungsdatum heute · ${eur(summe)} €`,
        datum: null, pfad: maske(rows[0].datum), betrag: summe,
        kinder: rows.map((r) => ({
          key: `HALLE_HEUTE:${r.bid}:${r.datum}`, bereich: 'Kassenwart', icon: 'appointment', state: 'Information' as const,
          titel: `${tm(r.datum)} ${r.von}–${r.bis} Uhr · ${r.name}`,
          text: `${r.preis != null ? `${eur(Number(r.preis))} €` : 'ohne Preis'} · ${r.quelle === 'PORTAL' ? 'Portal' : 'EP3'}`,
          datum: r.datum, pfad: maske(r.datum), betrag: Number(r.preis ?? 0),
        })),
      });
    }
  }

  // Vorstand: Registrierungen externer Hallennutzer warten auf Bestätigung (nur ohne E-Mail-Bestätigung)
  if (can(req, 'tco.platz:admin')) {
    const [r] = await db`select count(*)::int as n, to_char(min(erstellt) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as seit
                           from tco.registrierungen where status = 'OFFEN' and art = 'EXTERN'`;
    if (r?.n) {
      out.push({
        key: 'REGISTRIERUNG', bereich: 'Vorstand', icon: 'add-employee', state: 'Critical',
        titel: `${r.n} Registrierung${r.n === 1 ? '' : 'en'} zu bestätigen`,
        text: 'Neue Hallennutzer warten auf Freigabe in der Platzverwaltung.',
        datum: r.seit, pfad: '/tco/platzverwaltung',
      });
    }
  }
  return out;
}
