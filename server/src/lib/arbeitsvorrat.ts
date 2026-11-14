/**
 * Arbeitsvorrat des Portals (#232, V2): offene Vorgänge aller Anwendungen an einer Stelle – auf der Startseite.
 *
 * Jedes Modul meldet seine Quellen an (ServerModule.arbeitsvorrat) und prüft dabei selbst, ob der Benutzer die
 * zugehörige App bedienen darf; ein eigenes Recht für den Arbeitsvorrat gibt es nicht. Der Kern steuert seine
 * eigenen Einträge bei (Administration). Abgeschaltete Funktionen liefern nichts, weil ihre Rechte fehlen (F1).
 *
 * Vorgabe: Jedes Ereignis, das jemand erledigen oder wissen muss, erscheint hier. Was heute noch fehlt, steht in
 * modules/tco/server/dashboard/ereignisquellen.ts und wird von server/test/arbeitsvorrat_absicherung.test.ts bewacht.
 */
import type { FastifyRequest } from 'fastify';
import { can } from '../auth.js';
import { sql } from '../db.js';
import { activeModules } from '../modules.js';

export interface Aufgabe {
  /** eindeutig über alle Module – beginnt mit einem Kürzel der Quelle (z. B. JT:, SCHADEN:, BACKUP_EXPORT) */
  key: string;
  /** Zuständigkeit, nach der gruppiert wird (z. B. Kassenwart, Hallenwart, Administration) */
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
  /** Kästchen am Eintrag: bestätigt die Erledigung (POST auf url mit body), der Eintrag verschwindet danach. url im Modul ohne /api/m/<modul>. */
  erledigen?: { text: string; url: string; body: Record<string, unknown> };
  /** Upload „Überweisung an Einreicher“ (TC Oberthal): Zahlungsdaten und QR-Code im Popup */
  zahlung?: { id: number };
  /** Unterpunkte (z. B. die einzelnen Buchungen zu „Heute n Hallenbuchungen“) */
  kinder?: Aufgabe[];
}

export interface AufgabenGruppe { modul: string; name: string; aufgaben: Aufgabe[] }

/** Einträge der Administration */
export async function kernAufgaben(req: FastifyRequest): Promise<Aufgabe[]> {
  const out: Aufgabe[] = [];
  // tägliche Sicherung in die Nextcloud: fehlgeschlagen oder seit über 36 Stunden keine erfolgreiche
  if (can(req, 'core.backup:create')) {
    const [b] = await sql`select aktiv, letzter_fehler, letzte_meldung, to_char(letzter_lauf at time zone 'Europe/Berlin', 'YYYY-MM-DD') as lauf,
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
  return out;
}

/** Adressen der Aufgabe für die Startseite: „Erledigt“-Aufrufe eines Moduls laufen unter /api/m/<modul> */
function absolut(modul: string, a: Aufgabe): Aufgabe {
  return {
    ...a,
    erledigen: a.erledigen ? { ...a.erledigen, url: `/api/m/${modul}${a.erledigen.url}` } : undefined,
    kinder: a.kinder?.map((k) => absolut(modul, k)),
  };
}

/** Arbeitsvorrat des angemeldeten Benutzers über alle Anwendungen – Gruppen ohne Einträge entfallen */
export async function arbeitsvorratLesen(req: FastifyRequest): Promise<AufgabenGruppe[]> {
  const gruppen: AufgabenGruppe[] = [{ modul: 'core', name: 'Portal', aufgaben: await kernAufgaben(req) }];
  for (const m of activeModules()) {
    if (!m.arbeitsvorrat) continue;
    // Eine Quelle, die scheitert, darf die Startseite nicht leeren – die anderen Anwendungen bleiben sichtbar
    try {
      gruppen.push({ modul: m.id, name: m.name, aufgaben: (await m.arbeitsvorrat(req)).map((a) => absolut(m.id, a)) });
    } catch (e) {
      req.log.error(e, `Arbeitsvorrat des Moduls ${m.id} nicht lesbar`);
      gruppen.push({ modul: m.id, name: m.name, aufgaben: [{
        key: `AV_FEHLER:${m.id}`, bereich: 'Administration', icon: 'error', state: 'Negative', datum: null, pfad: '/',
        titel: `Arbeitsvorrat ${m.name} nicht lesbar`, text: 'Die Einträge dieser Anwendung konnten nicht ermittelt werden – Details stehen im Server-Log.',
      }] });
    }
  }
  return gruppen.filter((g) => g.aufgaben.length > 0);
}
