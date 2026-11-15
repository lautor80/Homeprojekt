/**
 * Rundschreiben: Versand im Hintergrund.
 *
 * Mit dem Senden wird die Empfängerliste festgeschrieben (tco.rundschreiben_empfaenger, je E-Mail-Adresse eine Zeile);
 * danach arbeitet ein Lauf im Serverprozess die Zeilen einzeln ab – jede Person bekommt ihre eigene E-Mail, nie stehen
 * mehrere Adressen in An/CC. Zwischen zwei E-Mails liegt eine Pause (Drosselung für den Mailserver).
 *
 * Kein Doppelversand: Eine Zeile wird vor dem Senden in einem Schritt von OFFEN auf SENDET gesetzt (nur wer sie so
 * bekommt, sendet) und danach auf GESENDET oder FEHLER. Bricht der Server mittendrin ab, ist für eine Zeile im Stand
 * SENDET ungewiss, ob die E-Mail hinausging: sie wird beim Wiederaufnehmen als Fehler gezeigt und nicht von selbst
 * wiederholt – lieber eine E-Mail zu wenig (sichtbar im Protokoll) als eine doppelt. Alle noch offenen Zeilen gehen
 * nach einem Neustart von selbst weiter.
 *
 * Jedes Ergebnis des zentralen Versands, das nicht „gesendet“ lautet (auch eine abgelehnte, als unzustellbar vermerkte
 * Adresse), gilt als „nicht erreicht“ – mit dem gelieferten Grund.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import { withChange } from '../../../../server/src/db.js';
import { appAktiv, funktionAktiv, modulId } from '../../../../server/src/funktionsschalter.js';
import { DB, plAktiv, vereinLesen, type Db } from '../verein.js';
import { mailSenden, type MailAnhang } from '../kommunikation.js';
import { adressenLesen, auswahlAus, einsetzen, empfaengerLesen, type Empfaenger } from './empfaenger.js';

export const F_VERSAND = 'tco.rundschreiben.versand';
export const ANWENDUNG = 'Rundschreiben';
/** so viele Fehlschläge in Folge halten den Versand an (Mailversand gestört) – die übrigen Empfänger bleiben offen */
export const ABBRUCH_NACH = 5;
export const UNTERBROCHEN = 'Versand unterbrochen (Neustart des Portals): Ob diese E-Mail hinausging, ist ungewiss – bitte im E-Mail-Protokoll prüfen und nur bei Bedarf erneut senden.';
const NEU_AUSLOESEN = 'Rundschreiben werden in der App „Rundschreiben“ erneut gesendet (Protokoll → „Fehlgeschlagene erneut senden“).';

export type Status = 'ENTWURF' | 'VERSAND' | 'ANGEHALTEN' | 'FERTIG';
const SYSTEM = { userId: null, username: 'system', action: 'RUNDSCHREIBEN_VERSAND' };

/** Pause zwischen zwei E-Mails in Millisekunden (RUNDSCHREIBEN_PAUSE_MS; Standard 1,5 s, in Tests keine) */
export function versandPause(): number {
  const n = Number(process.env.RUNDSCHREIBEN_PAUSE_MS ?? '');
  if (process.env.RUNDSCHREIBEN_PAUSE_MS && Number.isFinite(n) && n >= 0) return n;
  return process.env.TEST_DATABASE_URL ? 0 : 1500;
}

const versandErlaubt = () => funktionAktiv(F_VERSAND) && appAktiv('tco', ANWENDUNG) && funktionAktiv(modulId('tco'));

// ---------------------------------------------------------------- Lauf
const laeufe = new Map<number, Promise<void>>();

/** Lauf für ein Rundschreiben starten – läuft schon einer, bleibt es bei dem */
export function versandStarten(id: number, log?: { warn: (o: unknown, t: string) => void }): Promise<void> {
  const vorhanden = laeufe.get(id);
  if (vorhanden) return vorhanden;
  const p = versandLauf(id).catch((e) => { log?.warn(e, `Rundschreiben ${id}: Versand abgebrochen`); }).finally(() => { laeufe.delete(id); });
  laeufe.set(id, p);
  return p;
}
/** wartet, bis der laufende Versand eines Rundschreibens zu Ende ist (Tests) */
export const versandWarten = (id: number): Promise<void> => laeufe.get(id) ?? Promise.resolve();

async function anhalten(id: number, hinweis: string): Promise<void> {
  await withChange(SYSTEM, (tx) => tx`update tco.rundschreiben set status = 'ANGEHALTEN', hinweis = ${hinweis}, geaendert_am = now() where id = ${id} and status = 'VERSAND'`);
}

/** Zeilen eines Rundschreibens abarbeiten, bis nichts mehr offen ist oder der Versand angehalten wird */
export async function versandLauf(id: number): Promise<void> {
  const [rs] = await DB`select betreff, text, antwort_an, status, gesendet_von, absender, absender_name from tco.rundschreiben where id = ${id}`;
  if (!rs || rs.status !== 'VERSAND') return;
  const v = await vereinLesen();
  const anhaenge: MailAnhang[] = (await DB`select dateiname, mime, inhalt from tco.rundschreiben_anhaenge where rundschreiben_id = ${id} order by id`)
    .map((a) => ({ dateiname: a.dateiname as string, mime: a.mime as string, inhalt: Buffer.from(a.inhalt as Uint8Array), objekt: `RS-${id}` }));
  let reihe = 0;
  for (;;) {
    const [stand] = await DB`select status from tco.rundschreiben where id = ${id}`;
    if (stand?.status !== 'VERSAND') return;
    if (!versandErlaubt()) {
      await anhalten(id, 'Versand angehalten: Die Funktion „Rundschreiben senden“ ist abgeschaltet (Administration → Einstellungen → Funktionen).');
      return;
    }
    // Zeile übernehmen: nur wer sie von OFFEN auf SENDET setzt, sendet
    const [e] = await DB`
      update tco.rundschreiben_empfaenger set status = 'SENDET', versuche = versuche + 1, begonnen_am = now(), fehler = null
       where id = (select id from tco.rundschreiben_empfaenger where rundschreiben_id = ${id} and status = 'OFFEN' order by id limit 1 for update skip locked)
         and status = 'OFFEN'
      returning id, email, anrede, vorname, nachname`;
    if (!e) {
      await abschliessen(id);
      return;
    }
    let fehler: string | null = null;
    try {
      const werte = e as unknown as Pick<Empfaenger, 'anrede' | 'vorname' | 'nachname'>;
      const r = await mailSenden(v, {
        modus: 'senden', anwendung: ANWENDUNG, objekt: `RS-${id}`, an: e.email as string, benutzer: (rs.gesendet_von as string | null) ?? 'system', anhaenge,
        betreff: einsetzen(rs.betreff as string, werte, v.name), text: einsetzen(rs.text as string, werte, v.name),
        // Absender ist, wer den Versand ausgelöst hat (auch nach einem Neustart); ohne eigene Adresse der Ersatzabsender der Anwendung
        ...(rs.absender
          ? { absender: rs.absender as string, absender_name: (rs.absender_name as string | null) ?? '', antwort_an: (rs.antwort_an as string | null) || (rs.absender as string) }
          : { persoenlich: false, antwort_an: (rs.antwort_an as string | null) || undefined }),
        // Inhalt und Anhänge nicht je Empfänger im Mailprotokoll speichern; wiederholt wird hier, mit Status je Empfänger
        wiederholung: { art: 'NEU_AUSLOESEN', hinweis: NEU_AUSLOESEN },
      });
      if (r.status !== 'gesendet') fehler = r.fehler || r.hinweis || `Der Versand meldet „${r.status}“.`;
    } catch (err) {
      fehler = (err as Error).message || 'Versand fehlgeschlagen';
    }
    await DB`update tco.rundschreiben_empfaenger
                set status = ${fehler ? 'FEHLER' : 'GESENDET'}, fehler = ${fehler ? fehler.slice(0, 1000) : null}, gesendet_am = ${fehler ? null : new Date()}
              where id = ${e.id} and status = 'SENDET'`;
    reihe = fehler ? reihe + 1 : 0;
    if (reihe >= ABBRUCH_NACH) {
      await anhalten(id, `Versand angehalten: ${ABBRUCH_NACH} E-Mails in Folge sind fehlgeschlagen (zuletzt: ${fehler}). `
        + 'Bitte die Ursache beheben und den Versand fortsetzen – die übrigen Empfänger sind noch offen.');
      return;
    }
    const pause = versandPause();
    if (pause) await new Promise((ok) => setTimeout(ok, pause));
  }
}

/** nichts mehr offen: Rundschreiben abschließen und – soweit eingerichtet – in Paperless ablegen */
async function abschliessen(id: number): Promise<void> {
  const fertig = await withChange(SYSTEM, (tx) => tx`
    update tco.rundschreiben set status = 'FERTIG', hinweis = null, fertig_am = now(), geaendert_am = now()
     where id = ${id} and status = 'VERSAND'
       and not exists (select 1 from tco.rundschreiben_empfaenger e where e.rundschreiben_id = ${id} and e.status in ('OFFEN', 'SENDET'))
    returning id, paperless_id, gesendet_von`);
  if (!fertig.length || fertig[0].paperless_id) return;
  try {
    if (!plAktiv(await vereinLesen())) return;
    const { rundschreibenAblegen } = await import('./pdf.js');
    await rundschreibenAblegen(id, (fertig[0].gesendet_von as string | null) ?? 'system');
  } catch { /* Ablage lässt sich in der App nachholen („In Paperless ablegen“) */ }
}

/**
 * Nach einem Neustart: Rundschreiben im Versand weiterführen. Zeilen, die beim Abbruch gerade in Arbeit waren, werden
 * als Fehler gezeigt (Zustellung ungewiss) – nicht erneut gesendet.
 */
export async function versandWiederaufnehmen(log?: { warn: (o: unknown, t: string) => void; info: (o: unknown, t: string) => void }): Promise<number[]> {
  const offen = (await DB`select id from tco.rundschreiben where status = 'VERSAND' order by id`).map((r) => Number(r.id)).filter((id) => !laeufe.has(id));
  for (const id of offen) {
    await DB`update tco.rundschreiben_empfaenger set status = 'FEHLER', fehler = ${UNTERBROCHEN} where rundschreiben_id = ${id} and status = 'SENDET'`;
    log?.info({ rundschreiben: id }, 'Rundschreiben: Versand wird fortgesetzt');
    void versandStarten(id, log);
  }
  return offen;
}

// ---------------------------------------------------------------- Auslösen, Fortsetzen, Wiederholen
export interface Ausloeser { name: string; email: string | null }

/** Empfängerliste festschreiben und das Rundschreiben in den Versand geben; erwartet = Zahl der E-Mails aus der bestätigten Vorschau */
export async function versandAusloesen(tx: Db, id: number, wer: Ausloeser, erwartet: number): Promise<{ mails: number; ohneMail: number }> {
  const [rs] = await tx`select betreff, text, auswahl, status from tco.rundschreiben where id = ${id} for update`;
  if (!rs) throw new BusinessError('Das Rundschreiben gibt es nicht (mehr).', 404);
  if (rs.status !== 'ENTWURF') throw new BusinessError('Dieses Rundschreiben wurde bereits gesendet.', 409);
  if (!String(rs.betreff).trim()) throw new BusinessError('Bitte einen Betreff angeben.');
  if (!String(rs.text).trim()) throw new BusinessError('Bitte einen Text eingeben.');
  const v = await vereinLesen(tx);
  if (!v.n8n_mail_url) throw new BusinessError('Der Mailversand ist nicht eingerichtet (Administration → Schnittstellen → E-Mail).');
  const erg = await empfaengerLesen(tx, auswahlAus(rs.auswahl));
  if (!erg.empfaenger.length) throw new BusinessError('Kein Empfänger mit E-Mail-Adresse – bitte die Empfängerauswahl prüfen.');
  if (erg.empfaenger.length !== erwartet) {
    throw new BusinessError(`Die Empfängerliste hat sich geändert (jetzt ${erg.empfaenger.length} statt ${erwartet} E-Mails) – bitte die Empfänger noch einmal prüfen.`, 409);
  }
  const zeilen = [
    ...erg.empfaenger.map((e) => ({ email: e.email, adrnrs: e.adrnrs, namen: e.namen, anrede: e.anrede, vorname: e.vorname, nachname: e.nachname, weg: e.weg, status: 'OFFEN', fehler: null as string | null })),
    ...erg.ohneMail.map((o) => {
      const [vorname, ...rest] = o.name.split(' ');
      return { email: null, adrnrs: [o.adrnr], namen: o.name, anrede: `Hallo ${vorname}`, vorname, nachname: rest.join(' '), weg: '', status: 'OHNE_MAIL', fehler: o.grund };
    }),
  ];
  await tx`
    insert into tco.rundschreiben_empfaenger (rundschreiben_id, email, adrnrs, namen, anrede, vorname, nachname, weg, status, fehler)
    select ${id}, x.email, array(select jsonb_array_elements_text(x.adrnrs)), x.namen, x.anrede, x.vorname, x.nachname, x.weg, x.status, x.fehler
      from jsonb_to_recordset(${tx.json(zeilen as never)})
           as x(email text, adrnrs jsonb, namen text, anrede text, vorname text, nachname text, weg text, status text, fehler text)`;
  await tx`update tco.rundschreiben
              set status = 'VERSAND', hinweis = null, gesendet_am = now(), gesendet_von = ${wer.name}, absender = ${wer.email},
                  absender_name = ${wer.email ? `${wer.name} | ${v.name}` : null}, geaendert_am = now(), geaendert_von = ${wer.name}
            where id = ${id}`;
  return { mails: erg.empfaenger.length, ohneMail: erg.ohneMail.length };
}

/** angehaltenen Versand fortsetzen */
export async function versandFortsetzen(tx: Db, id: number): Promise<void> {
  const r = await tx`update tco.rundschreiben set status = 'VERSAND', hinweis = null, geaendert_am = now() where id = ${id} and status = 'ANGEHALTEN' returning id`;
  if (!r.length) throw new BusinessError('Der Versand ist nicht angehalten.', 409);
}

/** laufenden Versand anhalten – die gerade bearbeitete E-Mail geht noch hinaus */
export async function versandAnhalten(tx: Db, id: number, wer: string): Promise<void> {
  const r = await tx`update tco.rundschreiben set status = 'ANGEHALTEN', hinweis = ${`Versand angehalten von ${wer}.`}, geaendert_am = now()
                      where id = ${id} and status = 'VERSAND' returning id`;
  if (!r.length) throw new BusinessError('Der Versand läuft nicht.', 409);
}

/**
 * Fehlgeschlagene Empfänger erneut zum Versand vormerken. Wurde die Adresse im Mitgliederstamm inzwischen berichtigt
 * oder nachgetragen, gilt die neue – auch für Personen, die beim ersten Versand keine Adresse hatten. Eine Adresse, die
 * in diesem Rundschreiben schon eine Zeile hat, bekommt keine zweite E-Mail.
 */
export async function erneutVormerken(tx: Db, id: number, nur?: number[]): Promise<{ vorgemerkt: number; nachgetragen: number }> {
  const [rs] = await tx`select status from tco.rundschreiben where id = ${id} for update`;
  if (!rs) throw new BusinessError('Das Rundschreiben gibt es nicht (mehr).', 404);
  if (rs.status !== 'FERTIG' && rs.status !== 'ANGEHALTEN') throw new BusinessError('Erneut senden geht erst, wenn der Versand abgeschlossen oder angehalten ist.', 409);
  const alle = await tx`select id, email, adrnrs, status from tco.rundschreiben_empfaenger where rundschreiben_id = ${id} order by id for update`;
  const vergeben = new Set(alle.filter((z) => z.email).map((z) => String(z.email).toLowerCase()));
  const offen = alle.filter((z) => (z.status === 'FEHLER' || z.status === 'OHNE_MAIL') && (!nur || nur.includes(Number(z.id))));
  const aktuell = await adressenLesen(tx, [...new Set(offen.flatMap((z) => z.adrnrs as string[]))]);
  let vorgemerkt = 0, nachgetragen = 0;
  for (const z of offen) {
    const neu = [...new Set((z.adrnrs as string[]).map((a) => aktuell.get(a) ?? ''))];
    // nur übernehmen, wenn alle Personen der Zeile jetzt dieselbe, in diesem Rundschreiben noch nicht verwendete Adresse haben
    const adresse = neu.length === 1 && neu[0] && !vergeben.has(neu[0].toLowerCase()) ? neu[0] : null;
    if (z.status === 'OHNE_MAIL') {
      if (!adresse) continue;
      await tx`update tco.rundschreiben_empfaenger set email = ${adresse}, weg = 'EIGEN', status = 'OFFEN', fehler = null where id = ${z.id}`;
      vergeben.add(adresse.toLowerCase());
      nachgetragen++;
    } else {
      if (adresse) vergeben.add(adresse.toLowerCase());
      await tx`update tco.rundschreiben_empfaenger set email = ${adresse ?? (z.email as string)}, status = 'OFFEN', fehler = null where id = ${z.id}`;
    }
    vorgemerkt++;
  }
  if (!vorgemerkt) throw new BusinessError('Es gibt keinen fehlgeschlagenen Empfänger zum erneuten Senden.');
  await tx`update tco.rundschreiben set status = 'VERSAND', hinweis = null, geaendert_am = now() where id = ${id}`;
  return { vorgemerkt, nachgetragen };
}

// ---------------------------------------------------------------- Protokoll
export interface Zaehler { gesamt: number; offen: number; gesendet: number; fehler: number; ohne_mail: number }

export async function zaehlerLesen(db: Db, ids: number[]): Promise<Map<number, Zaehler>> {
  const out = new Map<number, Zaehler>();
  if (!ids.length) return out;
  for (const r of await db`
    select rundschreiben_id as id, count(*) filter (where status <> 'OHNE_MAIL')::int as gesamt, count(*) filter (where status in ('OFFEN', 'SENDET'))::int as offen,
           count(*) filter (where status = 'GESENDET')::int as gesendet, count(*) filter (where status = 'FEHLER')::int as fehler,
           count(*) filter (where status = 'OHNE_MAIL')::int as ohne_mail
      from tco.rundschreiben_empfaenger where rundschreiben_id = any(${ids}) group by rundschreiben_id`) {
    out.set(Number(r.id), { gesamt: r.gesamt, offen: r.offen, gesendet: r.gesendet, fehler: r.fehler, ohne_mail: r.ohne_mail });
  }
  return out;
}
export const ZAEHLER_LEER: Zaehler = { gesamt: 0, offen: 0, gesendet: 0, fehler: 0, ohne_mail: 0 };

export interface NichtErreicht { name: string; strasse: string; plz: string; ort: string; email: string; grund: string }

/** Personen, die das Rundschreiben nicht per E-Mail erreicht hat (Fehler oder ohne Adresse) – mit Anschrift für Brief oder Aushang */
export async function nichtErreichtLesen(db: Db, id: number): Promise<NichtErreicht[]> {
  const rows = await db`
    select coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), a.adrnr) as name, coalesce(m.strasse, '') as strasse, coalesce(m.plz, '') as plz,
           coalesce(m.ort, '') as ort, coalesce(e.email, '') as email,
           case when e.status = 'OHNE_MAIL' then coalesce(e.fehler, 'keine E-Mail-Adresse') else coalesce(e.fehler, 'nicht gesendet') end as grund
      from tco.rundschreiben_empfaenger e cross join lateral unnest(e.adrnrs) as a(adrnr) left join tco.mitglieder m on m.adrnr = a.adrnr
     where e.rundschreiben_id = ${id} and e.status in ('FEHLER', 'OHNE_MAIL')
     order by lower(m.nachname), lower(m.vorname), a.adrnr`;
  return rows.map((r) => ({ name: r.name as string, strasse: (r.strasse as string).trim(), plz: (r.plz as string).trim(), ort: (r.ort as string).trim(), email: r.email as string, grund: r.grund as string }));
}
