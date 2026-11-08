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
             coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), d.adrnr) as name
        from tco.jt_doku d left join tco.mitglieder m on m.adrnr = d.adrnr
       where d.freigegeben_am is not null and (d.bezahlt_am is null or coalesce(d.bezahlt_betrag, 0) < coalesce(d.betrag, 0))
       order by d.freigegeben_am`;
    for (const r of rows) {
      const offen = Math.max(0, Number(r.betrag) - Number(r.bezahlt_betrag));
      out.push({
        key: `JT:${r.adrnr}:${r.monat}`, bereich: 'Jugendtraining', icon: 'family-care', state: 'Information',
        titel: `Zeitnachweis ${r.name} – ${monatsname(r.monat)} freigegeben`,
        text: `${Number(r.stunden).toLocaleString('de-DE')} Std., ${eur(offen)} € zur Zahlung${r.belegnr ? ` · ${r.belegnr}` : ''}`,
        datum: r.am, pfad: `/tco/jugendtraining?monat=${r.monat}&tab=abr`, betrag: offen,
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
