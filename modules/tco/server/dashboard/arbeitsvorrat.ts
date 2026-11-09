/**
 * Arbeitsvorrat der Vereinsübersicht: offene Vorgänge, die jemand im Verein erledigen muss.
 * Jeder Eintrag erscheint nur, wenn der Benutzer die zugehörige App bedienen darf.
 */
import type { FastifyRequest } from 'fastify';
import { can } from '../../../../server/src/auth.js';
import type { Db } from '../verein.js';
import { monatsname } from '../jt/logik.js';

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
}

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function arbeitsvorrat(db: Db, req: FastifyRequest): Promise<Aufgabe[]> {
  const out: Aufgabe[] = [];

  // Jugendtraining: vom Trainer freigegebene, noch nicht (vollständig) bezahlte Zeitnachweise
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
        key: `JT:${r.adrnr}:${r.monat}`, bereich: 'Jugendtraining', icon: 'unlocked', state: 'Critical',
        titel: `${r.name} bittet um Öffnung von ${monatsname(r.monat)}`,
        text: r.oeffnung_grund ? `Grund: ${r.oeffnung_grund}` : 'Freigabe zurücknehmen, damit der Trainer korrigieren kann.',
        datum: r.am, pfad: `/tco/jugendtraining?monat=${r.monat}&tab=abr`, betrag: offen,
      } : {
        key: `JT:${r.adrnr}:${r.monat}`, bereich: 'Jugendtraining', icon: 'family-care', state: 'Information',
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

  // Platzbuchung: Registrierungen neuer Hallennutzer warten auf Bestätigung
  if (can(req, 'tco.platz:admin')) {
    const [r] = await db`select count(*)::int as n, to_char(min(erstellt) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as seit
                           from tco.registrierungen where status = 'OFFEN'`;
    if (r?.n) {
      out.push({
        key: 'REGISTRIERUNG', bereich: 'Platzbuchung', icon: 'add-employee', state: 'Critical',
        titel: `${r.n} Registrierung${r.n === 1 ? '' : 'en'} zu bestätigen`,
        text: 'Neue Hallennutzer warten auf Freigabe in der Platzverwaltung.',
        datum: r.seit, pfad: '/tco/platzverwaltung',
      });
    }
  }
  return out;
}
