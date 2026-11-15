/**
 * E-Mail-Adresse „unzustellbar“ im Mitgliederstamm (Migration 084).
 *
 * Ist ein Mitglied per E-Mail nicht erreichbar – der Mailserver lehnt die Adresse beim Senden dauerhaft ab, es kommt eine
 * Unzustellbarkeitsnachricht zurück oder jemand vermerkt es von Hand –, steht das am Mitglied (seit, Grund, Adresse, Quelle).
 * An die vermerkte Adresse sendet das Portal nicht mehr: Der zentrale Versand (server/src/lib/mail.ts) fragt vor jeder E-Mail
 * über ServerModule.mailGesperrt hier nach und lehnt ab bzw. lässt den Empfänger weg.
 *
 * Gesperrt ist die Adresse, nicht die Person: Wird die E-Mail-Adresse des Mitglieds geändert, entfällt der Vermerk von selbst
 * (Trigger in der Datenbank – gilt für jeden Schreibweg). Teilen sich mehrere Mitglieder eine Adresse (Familie), tragen alle den Vermerk.
 *
 * Andere Programme prüfen vorab mit emailUnzustellbar() (auch über kommunikation.ts erreichbar).
 */
import { withChange } from '../../../server/src/db.js';
import { BusinessError } from '../../../server/src/errors.js';
import { dat } from './format.js';
import { DB, type Db } from './verein.js';

export type EmailQuelle = 'VERSAND' | 'RUECKLAEUFER' | 'MANUELL';
export const EMAIL_QUELLE_TEXT: Record<EmailQuelle, string> = {
  VERSAND: 'beim Senden vom Mailserver abgelehnt', RUECKLAEUFER: 'Unzustellbarkeitsnachricht erhalten', MANUELL: 'von Hand vermerkt',
};

export interface EmailVermerk {
  /** Mitglied, an dem der Vermerk steht */
  adrnr: string;
  name: string;
  /** die unzustellbare Adresse (klein geschrieben) */
  adresse: string;
  /** JJJJ-MM-TT */
  seit: string;
  grund: string;
  quelle: EmailQuelle;
}

const klein = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const SPALTEN = (db: Db) => db`m.adrnr, btrim(concat_ws(' ', m.vorname, m.nachname)) as name, m.email_unzustellbar_adresse as adresse,
  to_char(m.email_unzustellbar_seit at time zone 'Europe/Berlin', 'YYYY-MM-DD') as seit, coalesce(m.email_unzustellbar_grund, '') as grund,
  coalesce(m.email_unzustellbar_quelle, 'MANUELL') as quelle`;

/** Vermerke zu Adressen (klein geschrieben); je Adresse der älteste */
export async function emailGesperrt(db: Db, emails: string[]): Promise<Map<string, EmailVermerk>> {
  const liste = [...new Set(emails.map(klein).filter(Boolean))];
  const out = new Map<string, EmailVermerk>();
  if (!liste.length) return out;
  const rows = await db`select ${SPALTEN(db)} from tco.mitglieder m
                         where m.email_unzustellbar_seit is not null and m.email_unzustellbar_adresse = any(${liste}::text[])
                         order by m.email_unzustellbar_seit, m.adrnr`;
  for (const r of rows as unknown as EmailVermerk[]) if (!out.has(r.adresse)) out.set(r.adresse, r);
  return out;
}

/** E-Mail-Adresse, unter der eine Person angeschrieben wird – wie kontaktLesen: eigene Adresse, sonst EP3-Kunde gleichen Namens */
async function kontaktAdresse(db: Db, adrnr: string): Promise<string> {
  const { kontaktLesen } = await import('./kommunikation.js');
  return klein((await kontaktLesen(db, adrnr))?.email);
}

/**
 * Vorabprüfung für andere Programme (Mahnlauf, Rundschreiben …): Ist diese Adresse bzw. die Adresse dieser Person als
 * unzustellbar vermerkt? Übergeben wird eine E-Mail-Adresse (enthält „@“) oder eine Adressnummer (Mitglied oder 99… = Hallenkunde).
 * null = nicht vermerkt. Der zentrale Versand lehnt vermerkte Adressen ohnehin ab (Status „fehler“, nichts geht an n8n).
 */
export async function emailUnzustellbar(db: Db, adrnrOderAdresse: string | null | undefined): Promise<EmailVermerk | null> {
  const x = (adrnrOderAdresse ?? '').trim();
  if (!x) return null;
  if (x.includes('@')) return (await emailGesperrt(db, [x])).get(klein(x)) ?? null;
  const [eigen] = await db`select ${SPALTEN(db)} from tco.mitglieder m where m.adrnr = ${x} and m.email_unzustellbar_seit is not null`;
  if (eigen) return eigen as unknown as EmailVermerk;
  // kein eigener Vermerk: Die Adresse kann bei einer anderen Person vermerkt sein (Familie mit gemeinsamer Adresse, Hallenkunde)
  const adresse = await kontaktAdresse(db, x);
  return adresse ? (await emailGesperrt(db, [adresse])).get(adresse) ?? null : null;
}

/** Mitglieder, die unter einer dieser Adressen angeschrieben werden (eigene Adresse; ohne eigene: EP3-Kunde gleichen Namens) */
async function mitgliederZuAdressen(db: Db, emails: string[]): Promise<{ adrnr: string; adresse: string }[]> {
  if (!emails.length) return [];
  const rows = await db`
    select m.adrnr, lower(btrim(m.email)) as adresse from tco.mitglieder m where lower(btrim(m.email)) = any(${emails}::text[])
    union
    select m.adrnr, lower(btrim(c.email)) from tco.mitglieder m
      join tco.kunden c on upper(btrim(coalesce(c.vorname, '') || ' ' || coalesce(c.nachname, ''))) = upper(btrim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '')))
     where btrim(coalesce(m.email, '')) = '' and coalesce(c.status, '') not in ('blocked', 'deleted') and lower(btrim(c.email)) = any(${emails}::text[])
     order by 1`;
  return rows as unknown as { adrnr: string; adresse: string }[];
}

const kurz = (s: string, n = 500) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Der Mailserver hat diese Adressen dauerhaft abgelehnt: bei allen Mitgliedern mit dieser Adresse vermerken.
 * Ein bestehender Vermerk zur selben Adresse bleibt unverändert (erster Grund und erstes Datum zählen).
 * Zurück kommen die Adressen, zu denen (jetzt oder schon vorher) ein Vermerk steht.
 */
export async function emailUnzustellbarMelden(tx: Db, emails: string[], grund: string, quelle: EmailQuelle): Promise<string[]> {
  const liste = [...new Set(emails.map(klein).filter(Boolean))];
  const vermerkt = new Set<string>();
  for (const p of await mitgliederZuAdressen(tx, liste)) {
    await tx`update tco.mitglieder
                set email_unzustellbar_seit = now(), email_unzustellbar_grund = ${kurz(grund) || null}, email_unzustellbar_adresse = ${p.adresse},
                    email_unzustellbar_quelle = ${quelle}
              where adrnr = ${p.adrnr} and (email_unzustellbar_seit is null or email_unzustellbar_adresse is distinct from ${p.adresse})`;
    vermerkt.add(p.adresse);
  }
  return [...vermerkt];
}

/** von Hand vermerken (Mitglieder-App): die Adresse, unter der das Mitglied angeschrieben wird */
export async function emailUnzustellbarSetzen(tx: Db, adrnr: string, grund: string): Promise<string> {
  const [m] = await tx`select adrnr from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError('Mitglied nicht gefunden.', 404);
  if (!grund.trim()) throw new BusinessError('Bitte einen Grund angeben.');
  const adresse = await kontaktAdresse(tx, adrnr);
  if (!adresse) throw new BusinessError('Zu diesem Mitglied ist keine E-Mail-Adresse bekannt.');
  await tx`update tco.mitglieder
              set email_unzustellbar_seit = now(), email_unzustellbar_grund = ${kurz(grund)}, email_unzustellbar_adresse = ${adresse}, email_unzustellbar_quelle = 'MANUELL'
            where adrnr = ${adrnr}`;
  return `${adresse} ist als unzustellbar vermerkt – das Portal sendet keine E-Mails mehr an diese Adresse.`;
}

/**
 * Vermerk zurücknehmen (Adresse ist doch erreichbar): bei diesem Mitglied und bei allen anderen mit derselben Adresse –
 * sonst bliebe die Adresse über das Familienmitglied gesperrt.
 */
export async function emailUnzustellbarAufheben(tx: Db, adrnr: string): Promise<string> {
  const [m] = await tx`select email_unzustellbar_adresse as adresse from tco.mitglieder where adrnr = ${adrnr} and email_unzustellbar_seit is not null`;
  if (!m) throw new BusinessError('Bei diesem Mitglied ist keine E-Mail-Adresse als unzustellbar vermerkt.');
  const r = await tx`update tco.mitglieder
                        set email_unzustellbar_seit = null, email_unzustellbar_grund = null, email_unzustellbar_adresse = null, email_unzustellbar_quelle = null
                      where email_unzustellbar_seit is not null and (adrnr = ${adrnr} or email_unzustellbar_adresse = ${m.adresse})`;
  return `Vermerk zurückgenommen – an ${m.adresse} wird wieder gesendet${r.count > 1 ? ` (auch bei ${r.count - 1} weiteren Person${r.count === 2 ? '' : 'en'} mit dieser Adresse)` : ''}.`;
}

/** Text für Ergebnis und E-Mail-Protokoll des zentralen Versands: „E-Mail-Adresse x ist <Text>“ */
export const sperrText = (v: Pick<EmailVermerk, 'seit' | 'grund'>): string =>
  `im Mitgliederstamm als unzustellbar vermerkt (seit ${dat(v.seit)}${v.grund ? `: ${kurz(v.grund, 160)}` : ''})`;

// ---------------------------------------------------------------- Anschluss an den Kern (ServerModule, server/src/lib/mailsperre.ts)

/** ServerModule.mailGesperrt: vermerkte Adressen unter den Empfängern einer E-Mail */
export async function mailGesperrt(emails: string[]): Promise<{ email: string; grund: string }[]> {
  return [...(await emailGesperrt(DB, emails)).values()].map((v) => ({ email: v.adresse, grund: sperrText(v) }));
}

/** ServerModule.mailUnzustellbar: dauerhafter Empfängerfehler beim Senden bzw. Rückläufer – mit Änderungsbeleg (Benutzer „system“) */
export async function mailUnzustellbar(m: { emails: string[]; grund: string; quelle: 'versand' | 'ruecklaeufer' }): Promise<string[]> {
  return withChange({ userId: null, username: 'system', action: 'EMAIL_UNZUSTELLBAR', reason: m.quelle === 'versand' ? 'Mailserver lehnt die Adresse ab' : 'Unzustellbarkeitsnachricht' },
    async (tx) => {
      // Der Versand läuft oft in der Transaktion des Aufrufers, die das Mitglied gerade selbst ändert: nicht auf dessen Sperre warten
      // (der Aufrufer wartet seinerseits auf den Versand). Dann bleibt es ohne Vermerk – der Rückläufer oder der nächste Versuch holt ihn nach.
      await tx`set local lock_timeout = '3s'`;
      return emailUnzustellbarMelden(tx, m.emails, m.grund, m.quelle === 'versand' ? 'VERSAND' : 'RUECKLAEUFER');
    });
}

/** Arbeitsvorrat/Liste: Anzahl der Mitglieder mit Vermerk und der älteste Vermerk */
export async function emailUnzustellbarAnzahl(db: Db): Promise<{ n: number; seit: string | null }> {
  const [r] = await db`select count(*)::int as n, to_char(min(email_unzustellbar_seit) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as seit
                         from tco.mitglieder where email_unzustellbar_seit is not null and (austritt is null or austritt >= current_date)`;
  return { n: Number(r?.n ?? 0), seit: (r?.seit as string | null) ?? null };
}
