import { sql } from './db.js';
import { BusinessError } from './errors.js';
import { cfgLesen, cfgPruefen, exportNachPlan, exportStarten } from './backup-export.js';
import type { JobDef } from './job-typen.js';
import type { Phase } from './backup-job.js';

/** Aufbewahrung der Läufe in Tagen (Job „core.jobs.aufraeumen“) */
export const LAEUFE_AUFBEWAHRUNG_TAGE = 90;

const PHASE: Partial<Record<Phase, string>> = {
  lesen: 'Daten werden gelesen', packen: 'Datei wird gepackt', hochladen: 'Upload in die Nextcloud',
  dateien: 'Dateien werden einzeln in die Nextcloud übertragen', pruefen: 'Übertragung wird geprüft', aufraeumen: 'Alte Sicherungen werden aufgeräumt',
};

/** Jobs des Kerns (Administration → System → Jobs) */
export const KERN_JOBS: JobDef[] = [
  {
    id: 'core.backup.nextcloud',
    text: 'Nextcloud-Export der Sicherung',
    beschreibung: 'Prüft jede Minute, ob der tägliche Export laut Einrichtung (Administration → System → Sicherung) fällig ist, und exportiert dann eine vollständige Sicherung in die Nextcloud. „Jetzt ausführen“ exportiert sofort, unabhängig von Uhrzeit und Schalter.',
    bereich: 'System → Sicherung',
    standardPlan: { art: 'intervall', minuten: 1 },
    recht: 'core.backup:create',
    async ausfuehren(ctx) {
      let c;
      if (ctx.manuell) {
        c = await cfgLesen();
        const fehlt = cfgPruefen(c);
        if (fehlt.length) throw new BusinessError(`Nextcloud-Export unvollständig eingerichtet: ${fehlt.join(', ')}.`);
      } else {
        c = await exportNachPlan(ctx.log);
        if (!c) return ctx.leer();
      }
      ctx.log(`Export nach ${c.ordner} startet (${c.format === 'dateien' ? 'dateiweise' : c.format === 'zip' ? 'ZIP mit XML' : 'Portal-Datei'}).`);
      const j = exportStarten(c, ctx.von.name);
      let phase: Phase = j.phase;
      let abbruchGemeldet = false;
      while (j.phase !== 'fertig' && j.phase !== 'fehler') {
        await new Promise((r) => setTimeout(r, 500));
        if (j.phase !== phase) {
          phase = j.phase;
          if (PHASE[phase]) ctx.log(`${PHASE[phase]}${j.detail ? ` – ${j.detail}` : ''}`);
        }
        if (ctx.signal.aborted && !abbruchGemeldet) {
          abbruchGemeldet = true;
          ctx.log('Abbruch angefordert – ein begonnener Export läuft zu Ende, damit kein halber Stand in der Nextcloud bleibt.', 'warnung');
        }
      }
      if (j.fehler) throw new BusinessError(j.fehler);
      return String((j.ergebnis as { text?: string } | null)?.text ?? 'Export fertig.');
    },
  },
  {
    id: 'core.jobs.aufraeumen',
    text: 'Laufprotokolle aufräumen',
    beschreibung: `Löscht Läufe und ihre Protokolle, die älter als ${LAEUFE_AUFBEWAHRUNG_TAGE} Tage sind.`,
    bereich: 'System → Jobs',
    standardPlan: { art: 'taeglich', uhrzeit: '03:20', wochentage: [] },
    async ausfuehren(ctx) {
      const weg = await sql`delete from core.job_laeufe
                             where gestartet_am < now() - make_interval(days => ${LAEUFE_AUFBEWAHRUNG_TAGE}) and status <> 'LAEUFT'
                             returning id`;
      ctx.log(`${weg.length} Lauf/Läufe älter als ${LAEUFE_AUFBEWAHRUNG_TAGE} Tage gelöscht.`);
      return weg.length ? `${weg.length} alte(r) Lauf/Läufe gelöscht` : 'nichts zu löschen';
    },
  },
];
