/**
 * Jobs (Administration → System → Jobs): Verzeichnis, Läufe mit Protokoll und Planer.
 *
 * Ein Job ist eine Funktion, die als einzelner Lauf ausgeführt wird – nach Plan oder von Hand („Jetzt ausführen“).
 * Kern-Jobs stehen in server/src/jobs-kern.ts, Module melden ihre Jobs über ServerModule.jobs an (Typen:
 * server/src/job-typen.ts, Pläne: server/src/job-plan.ts).
 *
 *  - core.jobs: eine Zeile je Job (beim Start angelegt, Standardplan), Plan und nächster planmäßiger Start.
 *  - core.job_laeufe / core.job_protokoll: ein Lauf je Ausführung mit seinen Protokollzeilen. Die Zeilen werden gepuffert
 *    und spätestens nach einer Sekunde geschrieben; jedes Schreiben erneuert das Lebenszeichen des Laufs.
 *  - Status: OK, WARNUNG (Protokollzeilen der Stufe „warnung“ oder „fehler“), FEHLER (Ausnahme), ABGEBROCHEN (Abbruch
 *    in der Administration oder Server-Neustart: Lebenszeichen älter als 5 Minuten). Hatte ein Lauf nach Plan nichts zu
 *    tun (ctx.leer()), wird er nicht aufbewahrt.
 *  - Planer: alle 30 Sekunden (nur im Server-Prozess, nicht in Tests). Fällige Jobs werden atomar beansprucht
 *    (update … where naechster_lauf = <gelesen>), höchstens ein Lauf je Job gleichzeitig (eindeutiger Index auf
 *    laufende Läufe) – auch mit mehreren Instanzen.
 *  - Abbruch: Flag in der Datenbank; der Server, auf dem der Lauf läuft, löst ihn beim nächsten Planerdurchlauf (bzw.
 *    sofort, wenn er selbst die Anfrage bekommt) über den AbortController aus.
 *  - Ein fehlgeschlagener Lauf nach Plan meldet eine Störung im Arbeitsvorrat (Quelle JOB, Objekt = Job-Id); sie schließt
 *    sich beim nächsten erfolgreichen Lauf.
 */
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Tx } from './db.js';
import { BusinessError } from './errors.js';
import { naechsterLauf, planPruefen, planText } from './job-plan.js';
import type { JobDef, JobKontext, JobPlan, JobStufe, LaufAusloeser, LaufStatus } from './job-typen.js';
import { KERN_JOBS } from './jobs-kern.js';
import { laeuft, stoerungMelden } from './lib/hinweise.js';
import { activeModules } from './modules.js';

/** Planer: Abstand der Prüfungen */
const TAKT_MS = 30_000;
/** ohne Lebenszeichen so lange gilt ein Lauf als abgebrochen (Server neu gestartet) */
export const VERWAIST_MIN = 5;
/** Protokollzeilen je Lauf höchstens (danach nur noch eine Zeile „weitere Zeilen ausgelassen“) */
const ZEILEN_MAX = 5000;
/** Absender der Läufe nach Plan */
export const PLANER_VON = { id: null, name: 'system (Jobplanung)' } as const;

export interface JobEintrag { modul: string; def: JobDef }

// ---------------------------------------------------------------- Verzeichnis
let verzeichnis: Map<string, JobEintrag> | null = null;
const testJobs: JobEintrag[] = [];
/** in diesem Prozess angelegte Zeilen (core.jobs) – neue Einträge (Testjobs) werden beim nächsten Zugriff angelegt */
let angelegt = false;

const imTest = () => !!(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' || process.env.TEST_DATABASE_URL);

/** alle Jobs: Kern und aktive Module. Doppelte Ids, fehlendes Präfix oder ein ungültiger Standardplan sind Programmierfehler. */
export function jobVerzeichnis(): Map<string, JobEintrag> {
  if (verzeichnis) return verzeichnis;
  const alle: JobEintrag[] = [
    ...KERN_JOBS.map((def) => ({ modul: 'core', def })),
    ...activeModules().flatMap((m) => (m.jobs ?? []).map((def) => ({ modul: m.id, def }))),
    ...testJobs,
  ];
  const map = new Map<string, JobEintrag>();
  for (const e of alle) {
    if (map.has(e.def.id)) throw new Error(`Job ${e.def.id} ist doppelt angemeldet (${map.get(e.def.id)!.modul} und ${e.modul}).`);
    if (!e.def.id.startsWith(`${e.modul}.`)) throw new Error(`Job ${e.def.id}: Id muss mit „${e.modul}.“ beginnen.`);
    try { planPruefen(e.def.standardPlan); } catch { throw new Error(`Job ${e.def.id}: Standardplan ungültig.`); }
    map.set(e.def.id, e);
  }
  return (verzeichnis = map);
}

/**
 * Nur für Tests: einen Job zusätzlich anmelden (Modul „test“, Id „test.…“). Außerhalb von Tests verboten – im Betrieb
 * melden Module ihre Jobs über ServerModule.jobs an.
 */
export function testJobRegistrieren(def: JobDef): void {
  if (!imTest()) throw new Error('testJobRegistrieren ist nur in Tests erlaubt.');
  testJobs.push({ modul: 'test', def });
  verzeichnis = null;
  angelegt = false;
  jobVerzeichnis();
}

export function jobEintrag(id: string): JobEintrag {
  const e = jobVerzeichnis().get(id);
  if (!e) throw new BusinessError('Diesen Job gibt es nicht.', 404);
  return e;
}

/** Zeilen in core.jobs anlegen (Standardplan) – beim Start und für später angemeldete Jobs; vorhandene bleiben unverändert */
export async function jobsAnlegen(): Promise<void> {
  if (angelegt) return;
  const jetzt = new Date();
  for (const { def } of jobVerzeichnis().values()) {
    const ein = def.standardEingeplant ?? true;
    await sql`insert into core.jobs (id, eingeplant, plan, naechster_lauf)
              values (${def.id}, ${ein}, ${sql.json(def.standardPlan as never)}, ${ein ? naechsterLauf(def.standardPlan, jetzt) : null})
              on conflict (id) do nothing`;
  }
  angelegt = true;
}

// ---------------------------------------------------------------- Sichten
export interface LaufSicht {
  id: number; jobId: string; jobText: string; ausloeser: LaufAusloeser; gestartetVon: string; gestartetAm: string;
  beendetAm: string | null; dauerSekunden: number | null; status: LaufStatus; ergebnis: string | null; warnungen: number; fehler: number;
}
export interface JobSicht {
  id: string; text: string; beschreibung: string; bereich: string; modul: string; eingeplant: boolean; plan: JobPlan;
  standardPlan: JobPlan; standardEingeplant: boolean; planText: string; naechsterLauf: string | null; laeuft: number | null;
  letzterLauf: LaufSicht | null; darfAusfuehren: boolean; geaendertAm: string | null; geaendertVon: string | null;
}
export interface ProtokollZeile { nr: number; zeit: string; stufe: JobStufe; text: string }

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

const laufSpalten = sql`l.id, l.job_id, l.ausloeser, l.gestartet_von, l.gestartet_am, l.beendet_am, l.status, l.ergebnis,
  (select count(*) from core.job_protokoll p where p.lauf_id = l.id and p.stufe = 'warnung')::int as warnungen,
  (select count(*) from core.job_protokoll p where p.lauf_id = l.id and p.stufe = 'fehler')::int as fehler`;

function laufSicht(r: Record<string, unknown>): LaufSicht {
  const start = new Date(r.gestartet_am as string);
  const ende = r.beendet_am ? new Date(r.beendet_am as string) : null;
  return {
    id: Number(r.id), jobId: r.job_id as string, jobText: jobVerzeichnis().get(r.job_id as string)?.def.text ?? (r.job_id as string),
    ausloeser: r.ausloeser as LaufAusloeser, gestartetVon: r.gestartet_von as string, gestartetAm: start.toISOString(),
    beendetAm: ende?.toISOString() ?? null, dauerSekunden: ende ? Math.round((ende.getTime() - start.getTime()) / 1000) : null,
    status: r.status as LaufStatus, ergebnis: (r.ergebnis as string | null) ?? null, warnungen: Number(r.warnungen), fehler: Number(r.fehler),
  };
}

/**
 * Alle Jobs mit Plan, nächstem Start, laufendem und letztem Lauf.
 * darf(recht): Berechtigungsprüfung des Benutzers – für „darfAusfuehren“ (core.jobs:execute und JobDef.recht).
 */
export async function jobSichten(darf: (recht: string) => boolean): Promise<JobSicht[]> {
  await jobsAnlegen();
  await verwaisteAbschliessen();
  const zeilen = new Map((await sql`select id, eingeplant, plan, naechster_lauf, geaendert_am, geaendert_von from core.jobs`).map((r) => [r.id as string, r]));
  const laufend = new Map((await sql`select id, job_id from core.job_laeufe where status = 'LAEUFT'`).map((r) => [r.job_id as string, Number(r.id)]));
  const letzte = new Map((await sql`select distinct on (l.job_id) ${laufSpalten} from core.job_laeufe l
                                     where l.status <> 'LAEUFT' order by l.job_id, l.gestartet_am desc, l.id desc`)
    .map((r) => [r.job_id as string, laufSicht(r)]));
  const out: JobSicht[] = [];
  for (const { modul, def } of jobVerzeichnis().values()) {
    const z = zeilen.get(def.id);
    const plan = (z?.plan as JobPlan | undefined) ?? def.standardPlan;
    out.push({
      id: def.id, text: def.text, beschreibung: def.beschreibung, bereich: def.bereich, modul,
      eingeplant: z ? !!z.eingeplant : def.standardEingeplant ?? true, plan,
      standardPlan: def.standardPlan, standardEingeplant: def.standardEingeplant ?? true, planText: planText(plan),
      naechsterLauf: z?.eingeplant ? iso(z.naechster_lauf) : null, laeuft: laufend.get(def.id) ?? null,
      letzterLauf: letzte.get(def.id) ?? null, darfAusfuehren: darf('core.jobs:execute') && (!def.recht || darf(def.recht)),
      geaendertAm: iso(z?.geaendert_am), geaendertVon: (z?.geaendert_von as string | null) ?? null,
    });
  }
  return out;
}

export async function jobSicht(id: string, darf: (recht: string) => boolean): Promise<JobSicht> {
  jobEintrag(id);
  return (await jobSichten(darf)).find((j) => j.id === id)!;
}

/** Plan setzen (ein-/ausplanen, Intervall oder Uhrzeit) – in der Transaktion mit Änderungsbeleg (tx aus change()) */
export async function planSetzen(tx: Tx, id: string, eingeplant: boolean, roh: unknown, von: string): Promise<void> {
  jobEintrag(id);
  await jobsAnlegen();
  const plan = planPruefen(roh);
  await tx`update core.jobs set eingeplant = ${eingeplant}, plan = ${sql.json(plan as never)},
                                naechster_lauf = ${eingeplant ? naechsterLauf(plan, new Date()) : null},
                                geaendert_am = now(), geaendert_von = ${von}
            where id = ${id}`;
}

export interface LaufFilter { job?: string; status?: string; von?: string; bis?: string; limit?: number }

/** Läufe, neueste zuerst; von/bis sind Kalendertage (Europe/Berlin), beide einschließlich */
export async function laeufeLesen(f: LaufFilter): Promise<LaufSicht[]> {
  await verwaisteAbschliessen();
  const limit = Math.max(1, Math.min(1000, f.limit ?? 200));
  const rows = await sql`select ${laufSpalten} from core.job_laeufe l
                          where true
                            ${f.job ? sql`and l.job_id = ${f.job}` : sql``}
                            ${f.status ? sql`and l.status = ${f.status}` : sql``}
                            ${f.von ? sql`and l.gestartet_am >= (${f.von}::date)::timestamp at time zone 'Europe/Berlin'` : sql``}
                            ${f.bis ? sql`and l.gestartet_am < (${f.bis}::date + 1)::timestamp at time zone 'Europe/Berlin'` : sql``}
                          order by l.gestartet_am desc, l.id desc
                          limit ${limit}`;
  return rows.map(laufSicht);
}

/** ein Lauf mit Protokoll; noch gepufferte Zeilen eines laufenden Laufs in diesem Prozess werden vorher geschrieben */
export async function laufLesen(id: number): Promise<{ lauf: LaufSicht; protokoll: ProtokollZeile[] }> {
  await aktiv.get(id)?.schreiben();
  const [r] = await sql`select ${laufSpalten} from core.job_laeufe l where l.id = ${id}`;
  if (!r) throw new BusinessError('Diesen Lauf gibt es nicht (mehr).', 404);
  const protokoll = await sql`select nr, zeit, stufe, text from core.job_protokoll where lauf_id = ${id} order by nr`;
  return { lauf: laufSicht(r), protokoll: protokoll.map((p) => ({ nr: Number(p.nr), zeit: iso(p.zeit)!, stufe: p.stufe as JobStufe, text: p.text as string })) };
}

// ---------------------------------------------------------------- Läufe
interface AktiverLauf { jobId: string; controller: AbortController; schreiben: () => Promise<void> }
/** Läufe, die in diesem Prozess gerade laufen */
const aktiv = new Map<number, AktiverLauf>();

/** Läufe ohne Lebenszeichen (Server neu gestartet) als abgebrochen abschließen */
export async function verwaisteAbschliessen(): Promise<void> {
  const hier = [...aktiv.keys()];
  await sql`update core.job_laeufe set status = 'ABGEBROCHEN', beendet_am = lebenszeichen,
                                       ergebnis = coalesce(ergebnis, 'Abgebrochen: Der Server wurde während des Laufs beendet oder neu gestartet.')
             where status = 'LAEUFT' and lebenszeichen < now() - make_interval(mins => ${VERWAIST_MIN})
               ${hier.length ? sql`and id <> all(${hier}::bigint[])` : sql``}`;
}

/** Lauf anlegen – 409, wenn der Job gerade läuft */
async function laufAnlegen(id: string, ausloeser: LaufAusloeser, von: string): Promise<number> {
  await verwaisteAbschliessen();
  try {
    const [r] = await sql`insert into core.job_laeufe (job_id, ausloeser, gestartet_von) values (${id}, ${ausloeser}, ${von}) returning id`;
    return Number(r.id);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new BusinessError('Dieser Job läuft gerade – bitte warten, bis der Lauf fertig ist.', 409);
    throw e;
  }
}

/** Lauf durchführen: Protokoll, Status, Störung im Arbeitsvorrat. Wirft nie (Fehler stehen im Lauf). */
async function laufDurchfuehren(laufId: number, e: JobEintrag, ausloeser: LaufAusloeser, von: { id: string | null; name: string }, log?: FastifyBaseLogger): Promise<LaufStatus> {
  const { def } = e;
  const manuell = ausloeser === 'MANUELL';
  const controller = new AbortController();
  let puffer: { nr: number; zeit: Date; stufe: JobStufe; text: string }[] = [];
  let nr = 0;
  let warnungen = 0;
  let fehlerZeilen = 0;
  let leer = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let schreibt: Promise<void> = Promise.resolve();

  const schreiben = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    const teil = puffer;
    puffer = [];
    // nacheinander schreiben, damit die Reihenfolge stimmt
    schreibt = schreibt.then(async () => {
      if (teil.length) {
        await sql`insert into core.job_protokoll ${sql(teil.map((z) => ({ lauf_id: laufId, nr: z.nr, zeit: z.zeit, stufe: z.stufe, text: z.text })))}`;
      }
      await sql`update core.job_laeufe set lebenszeichen = now() where id = ${laufId} and status = 'LAEUFT'`;
    }).catch((err) => log?.warn(err, `Job ${def.id}: Protokoll nicht geschrieben`));
    return schreibt;
  };
  aktiv.set(laufId, { jobId: def.id, controller, schreiben });

  const zeile = (text: string, stufe: JobStufe = 'info') => {
    if (stufe === 'warnung') warnungen++;
    if (stufe === 'fehler') fehlerZeilen++;
    if (nr > ZEILEN_MAX) return;
    nr++;
    puffer.push({ nr, zeit: new Date(), stufe, text: nr > ZEILEN_MAX ? 'Weitere Protokollzeilen ausgelassen.' : String(text).slice(0, 4000) });
    if (!timer) { timer = setTimeout(() => void schreiben(), 1000); timer.unref?.(); }
  };

  const ctx: JobKontext = {
    laufId, manuell, von, signal: controller.signal,
    log: zeile,
    leer: () => { leer = true; },
  };

  let status: LaufStatus;
  let ergebnis: string | null = null;
  try {
    if (manuell) zeile(`Von Hand gestartet (${von.name}).`);
    const r = await def.ausfuehren(ctx);
    ergebnis = r ? String(r).slice(0, 2000) : null;
    if (controller.signal.aborted) status = 'ABGEBROCHEN';
    else if (leer && !manuell) status = 'LEER';
    else status = warnungen || fehlerZeilen ? 'WARNUNG' : 'OK';
  } catch (err) {
    const text = String((err as Error)?.message ?? err).replace(/\s+/g, ' ').trim() || 'Unbekannter Fehler';
    if (controller.signal.aborted) {
      status = 'ABGEBROCHEN';
      ergebnis = 'Abgebrochen.';
      zeile(`Abgebrochen: ${text}`, 'warnung');
    } else {
      status = 'FEHLER';
      ergebnis = text.slice(0, 2000);
      zeile(text, 'fehler');
      if (!(err instanceof BusinessError)) log?.warn(err, `Job ${def.id} fehlgeschlagen`);
    }
  }
  if (status === 'ABGEBROCHEN' && !ergebnis) ergebnis = 'Abgebrochen.';

  try {
    if (status === 'LEER') {
      if (timer) clearTimeout(timer);
      await schreibt;
      await sql`delete from core.job_laeufe where id = ${laufId}`;
    } else {
      await schreiben();
      await sql`update core.job_laeufe set status = ${status}, ergebnis = ${ergebnis}, beendet_am = now(), lebenszeichen = now() where id = ${laufId}`;
    }
  } catch (err) {
    log?.warn(err, `Job ${def.id}: Lauf ${laufId} nicht abgeschlossen`);
  } finally {
    aktiv.delete(laufId);
  }

  // Arbeitsvorrat: fehlgeschlagener Lauf nach Plan → Störung; der nächste erfolgreiche Lauf schließt sie
  if (status === 'FEHLER' && !manuell) {
    await stoerungMelden({
      modul: 'core', quelle: 'JOB', objekt: def.id, bereich: 'Administration', recht: 'core.jobs:display', art: 'Job fehlgeschlagen',
      titel: def.text, text: (ergebnis ?? '').slice(0, 300), pfad: `/admin/jobs?job=${encodeURIComponent(def.id)}`,
    }, log ? { warn: (err, t) => log.warn(err as Error, t) } : undefined);
  } else if (status === 'OK' || status === 'WARNUNG') {
    await laeuft('core', 'JOB', def.id).catch(() => undefined);
  }
  return status;
}

/**
 * Job von Hand starten („Jetzt ausführen“): legt den Lauf an und gibt seine Nummer sofort zurück, der Lauf selbst geht
 * im Hintergrund weiter. 404 für unbekannte Jobs, 409, wenn er gerade läuft. Rechte prüft der Aufrufer.
 */
export async function jobStarten(id: string, von: { id: string | null; name: string }, log?: FastifyBaseLogger): Promise<number> {
  const e = jobEintrag(id);
  await jobsAnlegen();
  const laufId = await laufAnlegen(id, 'MANUELL', von.name);
  void laufDurchfuehren(laufId, e, 'MANUELL', von, log);
  return laufId;
}

/**
 * Job ausführen und auf das Ende warten (für Tests und Werkzeuge). Rückgabe: Lauf-Nummer und Status;
 * bei Status LEER (nach Plan nichts zu tun) gibt es den Lauf nicht mehr.
 */
export async function jobAusfuehren(id: string, o: { manuell?: boolean; von?: { id: string | null; name: string }; log?: FastifyBaseLogger } = {}): Promise<{ laufId: number; status: LaufStatus }> {
  const e = jobEintrag(id);
  await jobsAnlegen();
  const ausloeser: LaufAusloeser = o.manuell === false ? 'PLAN' : 'MANUELL';
  const von = o.von ?? PLANER_VON;
  const laufId = await laufAnlegen(id, ausloeser, von.name);
  const status = await laufDurchfuehren(laufId, e, ausloeser, von, o.log);
  return { laufId, status };
}

/**
 * Abbruch anfordern. Läuft der Lauf in diesem Prozess, wird er sofort benachrichtigt, sonst beim nächsten
 * Planerdurchlauf des Servers, auf dem er läuft. Ein Lauf ohne Lebenszeichen wird gleich als abgebrochen abgeschlossen.
 */
export async function laufAbbrechen(id: number, von: string): Promise<{ text: string }> {
  await verwaisteAbschliessen();
  const [l] = await sql`update core.job_laeufe set abbrechen = true where id = ${id} and status = 'LAEUFT' returning job_id`;
  if (!l) {
    const [da] = await sql`select status from core.job_laeufe where id = ${id}`;
    if (!da) throw new BusinessError('Diesen Lauf gibt es nicht (mehr).', 404);
    throw new BusinessError('Der Lauf ist bereits beendet.', 409);
  }
  const hier = aktiv.get(id);
  if (hier && !hier.controller.signal.aborted) {
    hier.controller.abort(new Error(`Abgebrochen von ${von}`));
  }
  const text = jobVerzeichnis().get(l.job_id as string)?.def.text ?? (l.job_id as string);
  return { text: `Abbruch von „${text}“ angefordert – der Lauf endet, sobald der Job den Abbruch bemerkt.` };
}

/** Abbruchwünsche für Läufe dieses Prozesses übernehmen und deren Lebenszeichen erneuern */
async function aktiveAbgleichen(): Promise<void> {
  const ids = [...aktiv.keys()];
  if (!ids.length) return;
  await sql`update core.job_laeufe set lebenszeichen = now() where id = any(${ids}::bigint[]) and status = 'LAEUFT'`;
  for (const r of await sql`select id from core.job_laeufe where id = any(${ids}::bigint[]) and abbrechen`) {
    const a = aktiv.get(Number(r.id));
    if (a && !a.controller.signal.aborted) a.controller.abort(new Error('Abbruch angefordert'));
  }
}

// ---------------------------------------------------------------- Planer
/** ein Durchlauf des Planers: fällige Jobs beanspruchen und starten (im Hintergrund) */
export async function planerDurchlauf(log?: FastifyBaseLogger): Promise<void> {
  await jobsAnlegen();
  await aktiveAbgleichen();
  await verwaisteAbschliessen();
  const jetzt = new Date();
  const faellig = await sql`select id, plan, naechster_lauf from core.jobs where eingeplant and naechster_lauf <= ${jetzt}`;
  for (const z of faellig) {
    const e = jobVerzeichnis().get(z.id as string);
    if (!e) continue; // Job eines abgeschalteten Moduls oder entfallen
    if ([...aktiv.values()].some((a) => a.jobId === e.def.id)) continue;
    let neu: Date;
    try { neu = naechsterLauf(planPruefen(z.plan), jetzt); } catch { continue; }
    // atomar beanspruchen: nur wer den gelesenen Stand noch vorfindet, startet den Lauf
    const [frei] = await sql`update core.jobs set naechster_lauf = ${neu}
                              where id = ${e.def.id} and date_trunc('milliseconds', naechster_lauf) = ${z.naechster_lauf as Date}
                              returning id`;
    if (!frei) continue;
    let laufId: number;
    try {
      laufId = await laufAnlegen(e.def.id, 'PLAN', PLANER_VON.name);
    } catch (err) {
      if (!(err instanceof BusinessError)) log?.warn(err, `Job ${e.def.id}: Lauf nicht angelegt`);
      continue; // läuft noch (z. B. von Hand gestartet) – der nächste planmäßige Start kommt
    }
    void laufDurchfuehren(laufId, e, 'PLAN', PLANER_VON, log);
  }
}

let planer: ReturnType<typeof setInterval> | null = null;

/** Planer starten (nur im Server-Prozess, nicht in Tests) */
export function planerStarten(log: FastifyBaseLogger): void {
  if (planer || imTest()) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await planerDurchlauf(log); } catch (e) { log.warn(e, 'Jobplanung: Durchlauf fehlgeschlagen'); } finally { busy = false; }
  };
  planer = setInterval(tick, TAKT_MS);
  planer.unref();
  void tick();
}

/** beim Beenden des Servers: Planer anhalten, laufende Läufe dieses Prozesses als abgebrochen abschließen */
export async function jobsBeenden(): Promise<void> {
  if (planer) { clearInterval(planer); planer = null; }
  const ids = [...aktiv.keys()];
  for (const a of aktiv.values()) a.controller.abort(new Error('Server wird beendet'));
  if (ids.length) {
    await sql`update core.job_laeufe set status = 'ABGEBROCHEN', beendet_am = now(), ergebnis = 'Abgebrochen: Der Server wurde beendet.'
               where id = any(${ids}::bigint[]) and status = 'LAEUFT'`.catch(() => undefined);
  }
}
