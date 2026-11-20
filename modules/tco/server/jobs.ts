import type { JobDef, JobKontext } from '../../../server/src/job-typen.js';
import { appAktiv, funktionAktiv, modulId } from '../../../server/src/funktionsschalter.js';
import { F_EP3_IMPORT, F_ROLLENABGLEICH } from './funktionen.js';

/**
 * Jobs des Vereinsmoduls (Administration → System → Jobs): jeder automatische Lauf und jede Stapelfunktion, die ohne
 * Eingaben sinnvoll läuft – eingeplant nach Plan oder von Hand („Jetzt ausführen“), jeder Lauf mit Protokoll.
 *
 * Die Fachfunktionen werden erst im Lauf geladen (dynamischer Import): So bleibt die Datei frei von Datenbank und
 * Routen (server/test/tco_jobs.test.ts prüft die Definitionen ohne Datenbank), und es entsteht kein Importkreis über
 * index.ts. Der Test server/test/arbeitsvorrat_absicherung.test.ts leitet aus den Ids („id: 'tco.…'“) die
 * Ereignisquellen „job:<id>“ ab – sie stehen in dashboard/ereignisquellen.ts.
 *
 * Funktionsschalter: Nach Plan läuft nichts, was abgeschaltet ist (der Lauf wird als „leer“ verworfen). Von Hand nur, wo
 * es fachlich unbedenklich ist (Sperren ausgetretener Mitglieder); sonst endet der Lauf mit einer Protokollzeile.
 */

/** pino-artige Ausgaben der Fachfunktionen (log.info(obj, text)) ins Protokoll des Laufs umlenken */
interface Protokoll { info: (o: unknown, t?: string) => void; warn: (o: unknown, t?: string) => void }
function protokoll(ctx: JobKontext): Protokoll & { ende: () => void } {
  let offen = true;
  const text = (o: unknown, t?: string) => {
    if (typeof o === 'string') return o;
    const e = o as { err?: unknown; message?: unknown } | null;
    const grund = o instanceof Error ? o.message : e?.err instanceof Error ? e.err.message : typeof e?.err === 'string' ? e.err : null;
    return [t, grund].filter(Boolean).join(': ') || JSON.stringify(o);
  };
  // Meldungen, die erst nach dem Lauf eintreffen (z. B. ein im Hintergrund fortgesetzter Versand), gehen ins Server-Log
  const aus = (stufe: 'info' | 'warnung') => (o: unknown, t?: string) => {
    if (offen) ctx.log(text(o, t), stufe);
    else (stufe === 'info' ? console.info : console.warn)(`[Job] ${text(o, t)}`);
  };
  return { info: aus('info'), warn: aus('warnung'), ende: () => { offen = false; } };
}

/**
 * Abgeschaltet (Funktionsschalter): nach Plan verwerfen, von Hand mit Protokollzeile beenden. Rückgabe: Ergebnistext,
 * oder null, wenn der Lauf stattfinden darf.
 */
function abgeschaltet(ctx: JobKontext, grund: string | null): string | null {
  if (!grund) return null;
  if (!ctx.manuell) ctx.leer();
  const t = `${grund} – nichts ausgeführt.`;
  ctx.log(t, ctx.manuell ? 'warnung' : 'info');
  return t;
}
const SCHALTER = '(Administration → Einstellungen → Funktionen)';
const appAus = (app: string) => (appAktiv('tco', app) ? null : `Die App „${app}“ ist abgeschaltet ${SCHALTER}`);
const funktionAus = (id: string, name: string) => (funktionAktiv(id) ? null : `Die Funktion „${name}“ ist abgeschaltet ${SCHALTER}`);
/** nichts zu tun: Planläufe nicht aufbewahren, von Hand mit Ergebnis */
function nichts(ctx: JobKontext, t: string): string {
  ctx.leer();
  ctx.log(t);
  return t;
}
const db = () => import('../../../server/src/db.js');
const aenderung = (ctx: JobKontext, action: string, reason?: string) => ({ userId: ctx.von.id, username: ctx.von.name, action, reason });
const n = (z: number, eins: string, mehr: string) => `${z} ${z === 1 ? eins : mehr}`;

export const TCO_JOBS: JobDef[] = [
  // ---------------------------------------------------------------- bisher setInterval/setTimeout in den Routen
  {
    id: 'tco.platz.abolauf',
    text: 'Abo-Bewerbungen: Erinnerung, Verfall, Angebote',
    beschreibung: 'Fällige Schritte der Abo-Saison: Erinnerung nach der Bestätigungsfrist, unbestätigte Stunden verfallen lassen, freie Stunden '
      + 'der Warteliste anbieten – mit E-Mail, die E-Mail-Pause der Saison gilt. „Jetzt ausführen“ wirkt wie der Lauf nach Plan; '
      + 'ohne E-Mail bzw. trotz Pause: Platzverwaltung → Abo-Saison.',
    bereich: 'Tennishalle → Platzverwaltung',
    standardPlan: { art: 'intervall', minuten: 60 },
    recht: 'tco.platz:admin',
    ausfuehren: async (ctx) => {
      const aus = abgeschaltet(ctx, appAus('Platz buchen'));
      if (aus) return aus;
      const { aboLauf } = await import('./platz/abowunsch.js');
      const r = await (await db()).withChange(aenderung(ctx, 'ABO_LAUF'), (tx) => aboLauf(tx));
      if (!r.erinnert && !r.verfallen && !r.angeboten) return nichts(ctx, 'Nichts fällig (keine laufende Abo-Saison, E-Mail-Pause oder keine fälligen Schritte).');
      const t = `${r.erinnert} erinnert, ${r.verfallen} verfallen, ${r.angeboten} angeboten.`;
      ctx.log(t);
      return t;
    },
  },
  {
    id: 'tco.instandhaltung.lauf',
    text: 'Schadensmeldungen: Erinnerung bei Sicherheitsrisiko, Fotofrist',
    beschreibung: 'Erinnert Zuständige und Vorstand per E-Mail an Sicherheitsrisiken, die seit über 24 Stunden unverändert sind, und löscht Fotos '
      + 'erledigter Meldungen nach der Frist aus den Stammdaten. „Jetzt ausführen“ tut dasselbe sofort.',
    bereich: 'Instandhaltung → Schadensmeldungen',
    standardPlan: { art: 'intervall', minuten: 60 },
    recht: 'tco.instandhaltung:admin',
    ausfuehren: async (ctx) => {
      const aus = abgeschaltet(ctx, appAus('Schadensmeldungen'));
      if (aus) return aus;
      const { lauf } = await import('./instandhaltung/logik.js');
      const { mailsSenden } = await import('./instandhaltung/routes.js');
      const r = await (await db()).withChange(aenderung(ctx, 'IH_LAUF'), (tx) => lauf(tx));
      if (!r.erinnert.length && !r.fotosGeloescht && !r.mails.length) return nichts(ctx, 'Nichts fällig.');
      for (const nr of r.erinnert) ctx.log(`Meldung ${nr}: Sicherheitsrisiko seit über 24 Stunden ohne Statuswechsel – Erinnerung`);
      if (r.fotosGeloescht) ctx.log(`${n(r.fotosGeloescht, 'Foto', 'Fotos')} nach Ablauf der Frist gelöscht`);
      const log = protokoll(ctx);
      const gesendet = await mailsSenden(r.mails, { id: ctx.von.id, name: ctx.von.name }, log);
      log.ende();
      if (gesendet < r.mails.length) ctx.log(`${n(r.mails.length - gesendet, 'E-Mail', 'E-Mails')} nicht gesendet (Mailversand nicht eingerichtet oder fehlgeschlagen)`, 'warnung');
      return `${n(r.erinnert.length, 'Erinnerung', 'Erinnerungen')}, ${n(gesendet, 'E-Mail', 'E-Mails')}, ${n(r.fotosGeloescht, 'Foto', 'Fotos')} gelöscht.`;
    },
  },
  {
    id: 'tco.mitglieder.austritt',
    text: 'Benutzer ausgetretener Mitglieder sperren',
    beschreibung: 'Sperrt die Benutzer ausgetretener Mitglieder bzw. entzieht ihnen die Rolle „Mitglied“, wenn sie weitere Rollen haben; jede '
      + 'Sperre steht als Hinweis im Arbeitsvorrat. Trägt außerdem gekündigte Mitglieder aus allen Gruppen aus (Altfälle, Importe). Schutzfunktion: läuft auch, wenn nur die App „Mitglieder“ abgeschaltet ist, und von Hand immer.',
    bereich: 'Mitglieder → Mitglieder',
    standardPlan: { art: 'intervall', minuten: 360 },
    recht: 'core.users:edit',
    ausfuehren: async (ctx) => {
      // Funktionsschalter (#232, F1): nach Plan ruht der Lauf nur, wenn das ganze Vereinsmodul abgeschaltet ist
      if (!funktionAktiv(modulId('tco'))) {
        if (!ctx.manuell) return abgeschaltet(ctx, `Das Vereinsmodul ist abgeschaltet ${SCHALTER}`)!;
        ctx.log(`Das Vereinsmodul ist abgeschaltet ${SCHALTER} – von Hand wird trotzdem gesperrt (Schutzfunktion).`);
      }
      const { ausgetreteneSperrenMelden } = await import('./mitglieder/selbst.js');
      const r = await (await db()).withChange(aenderung(ctx, 'AUSTRITT_SPERRE'), (tx) => ausgetreteneSperrenMelden(tx));
      if (!r.gesperrt.length && !r.rolleEntzogen.length && !r.gruppen.length) return nichts(ctx, 'Kein Benutzer eines ausgetretenen Mitglieds mehr aktiv, kein gekündigtes Mitglied mehr in einer Gruppe.');
      for (const u of r.gesperrt) ctx.log(`${u}: gesperrt`);
      for (const u of r.rolleEntzogen) ctx.log(`${u}: Rolle „Mitglied“ entzogen (bleibt wegen weiterer Rollen aktiv)`);
      // Kündigung beendet alle Gruppenzuordnungen – der Lauf fängt Altfälle und Importe ab
      for (const g of r.gruppen) ctx.log(`Mitglied ${g.adrnr}: gekündigt, aus ${n(g.anzahl, 'Gruppe', 'Gruppen')} ausgetragen`);
      return `${n(r.gesperrt.length, 'Benutzer', 'Benutzer')} gesperrt, ${n(r.rolleEntzogen.length, 'Benutzer', 'Benutzern')} die Rolle „Mitglied“ entzogen, `
        + `${n(r.gruppen.length, 'gekündigtes Mitglied', 'gekündigte Mitglieder')} aus Gruppen ausgetragen.`;
    },
  },
  {
    id: 'tco.benutzer.rollenabgleich',
    text: 'Rollenabgleich der Vereinsbenutzer',
    beschreibung: 'Mitglieder erhalten die Rollen „Mitglied“ und „Hallennutzer“, Nichtmitglieder verlieren „Mitglied“. Wie der Knopf „Rollen prüfen“ '
      + 'in der Benutzerverwaltung; ruht, wenn die Funktion „Rollenabgleich der Vereinsbenutzer“ abgeschaltet ist (auch von Hand).',
    bereich: 'Mitglieder → Zugänge',
    standardPlan: { art: 'intervall', minuten: 360 },
    recht: 'core.users:edit',
    ausfuehren: async (ctx) => {
      const aus = abgeschaltet(ctx, funktionAktiv(modulId('tco')) ? funktionAus(F_ROLLENABGLEICH, 'Rollenabgleich der Vereinsbenutzer') : `Das Vereinsmodul ist abgeschaltet ${SCHALTER}`);
      if (aus) return aus;
      const { rollenAbgleich, rollenText } = await import('./mitglieder/rollen.js');
      const l = await (await db()).withChange(aenderung(ctx, 'ROLLENABGLEICH'), (tx) => rollenAbgleich(tx, { ausfuehren: true }));
      if (!l.length) return nichts(ctx, rollenText(l, true));
      for (const x of l) {
        ctx.log(`${x.username}: ${[x.ergaenzt.length && `erhält ${x.ergaenzt.join(', ')}`, x.entzogen.length && `verliert ${x.entzogen.join(', ')}`].filter(Boolean).join('; ')}`);
      }
      return rollenText(l, true);
    },
  },
  {
    id: 'tco.mahnung.automatik',
    text: 'Automatischer Mahnlauf',
    beschreibung: 'Prüft jede Minute, ob der Mahnlauf laut den Einstellungen des Mahnwesens fällig ist (Automatik an, Wochentag, Uhrzeit, höchstens '
      + 'einmal je Tag), und startet ihn im eingestellten Modus. „Jetzt ausführen“ startet ihn ohne Blick auf Wochentag und Uhrzeit – nie, '
      + 'wenn die Automatik in den Einstellungen aus ist, und nicht ein zweites Mal am selben Tag.',
    bereich: 'Finanzen → Mahnwesen',
    standardPlan: { art: 'intervall', minuten: 1 },
    recht: 'tco.mahnung:execute',
    ausfuehren: async (ctx) => {
      const { automatikStarten } = await import('./mahnung/lauf.js');
      const e = await automatikStarten({ wer: { id: ctx.von.id, name: ctx.von.name }, manuell: ctx.manuell });
      // nach Plan ist „nicht fällig“ der Normalfall (jede Minute) – solche Läufe werden nicht aufbewahrt
      if (!e.lauf) return nichts(ctx, e.grund);
      const r = e.lauf;
      ctx.log(`Mahnlauf ${r.id} (${r.modus === 'SENDEN' ? 'senden' : 'nur Vorschlag'}): ${r.text}`);
      if (r.fehler) ctx.log(`${n(r.fehler, 'Schuldner', 'Schuldner')} mit Fehler beim Versand – siehe App „Mahnwesen“, Lauf ${r.id}`, 'warnung');
      return r.text;
    },
  },
  {
    id: 'tco.rundschreiben.wiederaufnahme',
    text: 'Rundschreiben: unterbrochenen Versand fortsetzen',
    beschreibung: 'Setzt den Versand von Rundschreiben fort, an denen seit 10 Minuten niemand mehr arbeitet (Neustart oder Absturz des Portals). '
      + 'Die beim Abbruch gerade bearbeitete E-Mail wird nicht erneut gesendet, sondern als Fehler gezeigt. Der Versand selbst läuft im Hintergrund weiter.',
    bereich: 'Mitglieder → Rundschreiben',
    standardPlan: { art: 'intervall', minuten: 5 },
    recht: 'tco.rundschreiben:execute',
    ausfuehren: async (ctx) => {
      const aus = abgeschaltet(ctx, appAus('Rundschreiben') ?? funktionAus('tco.rundschreiben.versand', 'Rundschreiben senden'));
      if (aus) return aus;
      const { versandWiederaufnehmen } = await import('./rundschreiben/versand.js');
      const log = protokoll(ctx);
      const ids = await versandWiederaufnehmen(log, { ruheMinuten: 10 });
      log.ende();
      if (!ids.length) return nichts(ctx, 'Kein unterbrochener Versand.');
      return `Versand fortgesetzt: Rundschreiben ${ids.join(', ')}.`;
    },
  },

  // ---------------------------------------------------------------- Stapelfunktionen, bisher nur per Knopf (Vorgabe: nicht eingeplant)
  {
    id: 'tco.jt.ferien',
    text: 'Schulferien und Feiertage laden',
    beschreibung: 'Lädt die Schulferien und Feiertage des Saarlands für das laufende und das nächste Jahr über n8n (Schnittstelle „Schulferien“) '
      + 'und ersetzt die gespeicherten Tage je Jahr – wie „Ferien synchronisieren“ in der Abrechnung Jugendtraining.',
    bereich: 'Jugend → Abrechnung Jugendtraining',
    standardPlan: { art: 'taeglich', uhrzeit: '05:10', wochentage: [1] },
    standardEingeplant: false,
    recht: 'tco.jt:edit',
    ausfuehren: async (ctx) => {
      const aus = abgeschaltet(ctx, appAus('Abrechnung Jugendtraining'));
      if (aus) return aus;
      const { vereinLesen } = await import('./verein.js');
      const { ferienSynchronisieren } = await import('./jt/logik.js');
      const { heute } = await import('./format.js');
      const { withChange } = await db();
      const jahr = Number(heute().slice(0, 4));
      const ergebnis: string[] = [];
      for (const j of [jahr, jahr + 1]) {
        if (ctx.signal.aborted) break;
        try {
          const r = await withChange(aenderung(ctx, 'FERIEN_SYNC', String(j)), async (tx) => ferienSynchronisieren(tx, await vereinLesen(tx), j, ctx.von.name));
          ctx.log(`${j}: ${r.ferien} Ferientage, ${r.feiertage} Feiertage`);
          ergebnis.push(`${j}: ${r.ferien} Ferientage, ${r.feiertage} Feiertage`);
        } catch (e) {
          // das laufende Jahr muss klappen; für das nächste liefert die Quelle oft noch nichts
          if (j === jahr) throw e;
          ctx.log(`${j}: nicht geladen – ${(e as Error).message}`, /keine Ferientage/.test((e as Error).message) ? 'info' : 'warnung');
        }
      }
      return ergebnis.join(' · ');
    },
  },
  {
    id: 'tco.halle.ep3import',
    text: 'EP3-Import über n8n',
    beschreibung: 'Holt Kunden, Texte, Buchungen und Events aus EP3 über n8n (Standardzeitraum des Workflows) und übernimmt sie in die '
      + 'Hallenabrechnung – wie „Import über n8n“ dort. Ruht, wenn die Funktion „EP3-Import“ abgeschaltet ist.',
    bereich: 'Tennishalle → Hallenabrechnung',
    standardPlan: { art: 'taeglich', uhrzeit: '05:40', wochentage: [] },
    standardEingeplant: false,
    recht: 'tco.halle:edit',
    ausfuehren: async (ctx) => {
      const aus = abgeschaltet(ctx, appAus('Hallenabrechnung') ?? funktionAus(F_EP3_IMPORT, 'EP3-Import'));
      if (aus) return aus;
      const { vereinLesen } = await import('./verein.js');
      const { ep3Importieren, ep3UeberN8n, zeitraumDerBuchungen } = await import('./halle/ep3.js');
      const { dat } = await import('./format.js');
      const { withChange } = await db();
      const j = await ep3UeberN8n(await vereinLesen(), ctx.von.name, null);
      let ok = 0, fehler = 0;
      for (const [datei, inhalt] of [['Kunden', j.kunden_csv], ['Texte', j.texte_csv], ['Buchungen', j.bookings_csv], ['Events', j.events_csv]] as const) {
        if (!inhalt) continue;
        if (ctx.signal.aborted) { ctx.log(`Abgebrochen vor „${datei}“.`, 'warnung'); break; }
        try {
          const r = await withChange(aenderung(ctx, 'EP3_IMPORT', `n8n ${datei}`), (tx) => ep3Importieren(tx, inhalt));
          ctx.log(`${datei}: ${r.text}`, r.ok ? 'info' : 'warnung');
          if (r.personenNeu?.length) ctx.log(`${datei}: neue Personen ${r.personenNeu.join(', ')}`);
          if (r.ok) ok++; else fehler++;
        } catch (e) {
          ctx.log(`${datei}: ${(e as Error).message}`, 'warnung');
          fehler++;
        }
      }
      const zr = zeitraumDerBuchungen(j.bookings_csv);
      ctx.log(zr ? `Buchungen vom ${dat(zr.von)} bis ${dat(zr.bis)} geliefert` : 'keine Buchungen geliefert');
      return `${n(ok, 'Datei', 'Dateien')} übernommen${fehler ? `, ${fehler} mit Fehler` : ''}${zr ? ` (Buchungen ${dat(zr.von)}–${dat(zr.bis)})` : ''}.`;
    },
  },
  {
    id: 'tco.eingang.mailabruf',
    text: 'Posteingang abrufen',
    beschreibung: 'Wendet das Regelwerk erneut auf alle offenen Vorgänge des Dokumenteneingangs an und stößt n8n an, alle E-Mails des Posteingangs '
      + 'erneut zu liefern – wie „Posteingang abrufen“ im Dokumenteneingang. Den regelmäßigen Abruf macht sonst n8n selbst.',
    bereich: 'Dokumente → Dokumenteneingang',
    standardPlan: { art: 'taeglich', uhrzeit: '06:15', wochentage: [] },
    standardEingeplant: false,
    recht: 'tco.eingang:edit',
    ausfuehren: async (ctx) => {
      const aus = abgeschaltet(ctx, appAus('Dokumenteneingang'));
      if (aus) return aus;
      const { offeneNeuBewerten } = await import('./eingang/verarbeitung.js');
      const { eingerichtet, verbindungLesen } = await import('../../../server/src/lib/verbindungen.js');
      const { V_MAILABRUF, mailabrufAnstossen } = await import('./verbindung.js');
      const { tcoSchnittstelle } = await import('./hinweise.js');
      const b = await offeneNeuBewerten(ctx.von.name);
      const bewertet = b.vorgaenge
        ? `${n(b.dokumente, 'offenes Dokument', 'offene Dokumente')} in ${n(b.vorgaenge, 'Vorgang', 'Vorgängen')} neu bewertet.`
        : 'Keine offenen Dokumente in der Prüfliste.';
      ctx.log(bewertet);
      const v = await verbindungLesen(V_MAILABRUF);
      if (!eingerichtet(v)) {
        const t = 'Kein Abruf aus dem Postfach: Die Anbindung „Maileingang jetzt abrufen (n8n)“ ist nicht eingerichtet (Administration → Schnittstellen).';
        ctx.log(t, 'warnung');
        return `${bewertet} ${t}`;
      }
      // überwacht (#232, V1): Scheitert der Anstoß, steht die Störung im Arbeitsvorrat, bis der nächste klappt
      const text = await tcoSchnittstelle(V_MAILABRUF, 'Maileingang jetzt abrufen (n8n)', () => mailabrufAnstossen(v, `Portal (Job, ${ctx.von.name})`));
      ctx.log(text);
      return `${bewertet} ${text}`;
    },
  },
];
