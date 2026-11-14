/**
 * Vereinskalender: Einladungslink aus einer Veranstaltung versenden.
 *
 * Der Link führt auf die Veranstaltung im Portal (/tco/kalender?veranstaltung=<id>). An- und Abmelden kann sich nur, wer
 * angemeldet ist: Ohne Sitzung zeigt das Portal die Anmeldeseite und führt danach direkt zur Veranstaltung. Wer noch
 * keinen Zugang hat, registriert sich dort auf dem üblichen Weg (Mitglied: Abgleich mit dem Bestand bzw. Freigabe durch
 * den Verein) – der Link selbst gewährt nichts und enthält kein Geheimnis, er darf also auch weitergegeben werden.
 *
 * Empfänger sind die Mitglieder, für die die Veranstaltung gilt (ihre Gruppen samt Untergruppen, ohne Gruppe alle
 * aktiven Mitglieder) – wahlweise nur die ohne Rückmeldung. Je E-Mail-Adresse geht eine Nachricht hinaus (Familien mit
 * gemeinsamer Adresse bekommen eine, nicht eine je Person).
 */
import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import type { Db, Verein } from '../verein.js';
import { condense } from '../format.js';
import { mailSenden } from '../kommunikation.js';
import { mitUntergruppen } from '../gruppen/logik.js';
import { fuellen, mailtextVorlage, type MailVorlage } from '../mailtexte.js';
import type { Event, Status } from './logik.js';

export type An = 'OFFEN' | 'ALLE';
export interface Eingeladen { adrnr: string; vorname: string; name: string; email: string | null; zugang: boolean; status: Status | null }

/** Adresse der Veranstaltung im Portal – ohne Geheimnis, die Anmeldung prüft das Portal */
export const veranstaltungLink = (url: string, id: number) => `${url.replace(/\/+$/, '')}/tco/kalender?veranstaltung=${id}`;

/** Hinweis für Empfänger ohne Zugang: der übliche Weg über die Registrierung */
export const ZUGANG_HINWEIS = 'Noch kein Zugang zum Vereinsportal? Auf der Anmeldeseite, die der Link öffnet, wählen Sie „Zum Vereinsportal registrieren“. '
  + 'Sobald Ihr Zugang besteht, führt der Link direkt zur Veranstaltung.';

const zeit = (iso: string, mitUhr: boolean) => new Date(iso).toLocaleString('de-DE', mitUhr
  ? { timeZone: 'Europe/Berlin', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
  : { timeZone: 'Europe/Berlin', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
const tag = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

/** „Samstag, 12.06.2027, 14:00 Uhr“ – mit Ende, soweit angegeben */
export function terminText(e: Pick<Event, 'beginn' | 'ende' | 'ganztags'>): string {
  const von = e.ganztags ? zeit(e.beginn, false) : `${zeit(e.beginn, true)} Uhr`;
  if (!e.ende) return von;
  if (tag(e.ende) === tag(e.beginn)) {
    return e.ganztags ? von : `${von} bis ${new Date(e.ende).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })} Uhr`;
  }
  return `${von} bis ${e.ganztags ? zeit(e.ende, false) : `${zeit(e.ende, true)} Uhr`}`;
}

/** Mitglieder, für die die Veranstaltung gilt, mit E-Mail-Adresse, Zugang zum Portal und Rückmeldung */
export async function eingeladene(db: Db, e: Pick<Event, 'id' | 'gruppen'>): Promise<Eingeladen[]> {
  const ids = e.gruppen.length ? await mitUntergruppen(db, e.gruppen) : null;
  const rows = await db`
    select m.adrnr, m.vorname, m.nachname, nullif(trim(coalesce(m.email, '')), '') as email,
           exists (select 1 from tco.mitgliedera a where a.adrnr = m.adrnr and a.benutzer_id is not null) as zugang,
           (select a.status from tco.kal_anmeldungen a where a.event_id = ${e.id} and a.adrnr = m.adrnr) as status
      from tco.mitglieder m
     where (m.austritt is null or m.austritt >= current_date)
       ${ids ? db`and exists (select 1 from tco.kal_gruppe_mitglieder gm where gm.adrnr = m.adrnr and gm.gruppe_id = any(${ids}))` : db`and m.eintritt is not null`}
     order by m.nachname, m.vorname, m.adrnr`;
  return rows.map((r) => ({
    adrnr: r.adrnr as string, vorname: condense(String(r.vorname ?? '')), name: condense(`${r.vorname ?? ''} ${r.nachname ?? ''}`) || (r.adrnr as string),
    email: (r.email as string | null) ?? null, zugang: !!r.zugang, status: (r.status as Status | null) ?? null,
  }));
}

/** warum sich (noch) nicht einladen lässt – null, wenn nichts dagegen spricht */
export function einladungGesperrt(e: Event, jetzt = new Date()): string | null {
  if (e.abgesagt) return 'Die Veranstaltung ist abgesagt.';
  if (new Date(e.ende ?? e.beginn) < jetzt) return 'Die Veranstaltung ist vorbei.';
  return null;
}

/** Werte der Veranstaltung für die Platzhalter – {Vorname} und {Zugang} folgen je Empfänger */
function eventWerte(e: Event, link: string): Record<string, string> {
  return {
    Titel: e.titel, Termin: terminText(e), Ort: e.ort ? `Ort: ${e.ort}` : '',
    Anmeldeschluss: e.anmeldung && e.anmeldeschluss ? `Bitte melden Sie sich bis ${zeit(e.anmeldeschluss, true)} Uhr an oder ab.` : '',
    Link: link,
  };
}

/** Vorbelegung für den Dialog: Text des Vereins (Einstellungen → E-Mail-Texte) mit den Angaben der Veranstaltung */
export async function einladungVorschau(db: Db, v: Verein, e: Event) {
  const url = await portalUrl();
  const link = url ? veranstaltungLink(url, e.id) : null;
  const vorlage = await mailtextVorlage(db, v, 'kalender.einladung');
  const werte = eventWerte(e, link ?? '{Link}');
  const personen = await eingeladene(db, e);
  const verlauf = await db`select an, gesendet, fehler, gesendet_von, to_char(gesendet_am at time zone 'Europe/Berlin', 'YYYY-MM-DD"T"HH24:MI') as am
                             from tco.kal_einladungen where event_id = ${e.id} order by gesendet_am desc limit 5`;
  const grund = einladungGesperrt(e)
    ?? (!link ? 'Für den Link fehlt die Portal-Adresse (Administration → Einstellungen → Portal).' : null)
    ?? (!v.n8n_mail_url ? 'Der Mailversand ist nicht eingerichtet (Administration → Schnittstellen → E-Mail) – der Link lässt sich trotzdem kopieren und teilen.' : null);
  return {
    link, betreff: fuellen(vorlage.betreff, werte), text: fuellen(vorlage.text, werte), grund, senden: !grund,
    personen: personen.map((p) => ({ name: p.name, mail: !!p.email, zugang: p.zugang, offen: !p.status })),
    verlauf: verlauf.map((r) => ({ an: r.an as An, gesendet: Number(r.gesendet), fehler: Number(r.fehler), von: (r.gesendet_von as string | null) ?? '', am: r.am as string })),
  };
}

/** Empfänger je E-Mail-Adresse zusammenfassen (Familie mit gemeinsamer Adresse = eine Nachricht) */
export function jeAdresse(personen: Eingeladen[]): { an: string; adrnr: string; vorname: string; zugang: boolean }[] {
  const m = new Map<string, Eingeladen[]>();
  for (const p of personen) {
    if (!p.email) continue;
    const k = p.email.toLowerCase();
    m.set(k, [...(m.get(k) ?? []), p]);
  }
  return [...m.values()].map((l) => {
    const namen = [...new Set(l.map((p) => p.vorname).filter(Boolean))];
    return {
      an: l[0].email!, adrnr: l[0].adrnr, zugang: l.every((p) => p.zugang),
      vorname: namen.length > 1 ? `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}` : namen[0] ?? 'zusammen',
    };
  });
}

/**
 * Einladung senden. Betreff und Text kommen aus dem Dialog (dort änderbar); je Empfänger werden {Vorname} und {Zugang}
 * ersetzt. Der Link muss im Text stehen – sonst wäre es keine Einladung zur Anmeldung.
 */
export async function einladungSenden(db: Db, v: Verein, e: Event, o: { an: An; betreff: string; text: string; wer: string }) {
  const gesperrt = einladungGesperrt(e);
  if (gesperrt) throw new BusinessError(gesperrt);
  const url = await portalUrl();
  if (!url) throw new BusinessError('Für den Link fehlt die Portal-Adresse (Administration → Einstellungen → Portal).');
  if (!v.n8n_mail_url) throw new BusinessError('Der Mailversand ist nicht eingerichtet (Administration → Schnittstellen → E-Mail).');
  const link = veranstaltungLink(url, e.id);
  const werte = eventWerte(e, link);
  const vorlage: MailVorlage = { betreff: fuellen(o.betreff, werte), text: fuellen(o.text, werte) };
  if (!vorlage.betreff.trim()) throw new BusinessError('Bitte einen Betreff angeben.');
  if (!vorlage.text.includes(link)) throw new BusinessError(`Im Text fehlt der Link zur Veranstaltung ({Link} bzw. ${link}).`);

  const alle = await eingeladene(db, e);
  const gewaehlt = o.an === 'OFFEN' ? alle.filter((p) => !p.status) : alle;
  if (!gewaehlt.length) throw new BusinessError(o.an === 'OFFEN' ? 'Alle Eingeladenen haben sich bereits zurückgemeldet.' : 'Für diese Veranstaltung gibt es keine Mitglieder zum Einladen.');
  const ohneMail = gewaehlt.filter((p) => !p.email).map((p) => p.name);
  const r = { gesendet: 0, fehler: [] as string[], ohneMail, ohneZugang: 0 };
  for (const p of jeAdresse(gewaehlt)) {
    const persoenlich = { Vorname: p.vorname, Zugang: p.zugang ? '' : ZUGANG_HINWEIS };
    if (!p.zugang) r.ohneZugang++;
    try {
      const m = await mailSenden(v, {
        modus: 'senden', anwendung: 'Vereinskalender', objekt: p.adrnr, an: p.an, benutzer: o.wer, anhaenge: [],
        betreff: fuellen(vorlage.betreff, persoenlich), text: fuellen(vorlage.text, persoenlich),
      });
      if (m.status === 'fehler') throw new Error(m.fehler ?? 'Versand fehlgeschlagen');
      r.gesendet++;
    } catch (err) { r.fehler.push(`${p.an}: ${(err as Error).message}`); }
  }
  return r;
}

/** Versand festhalten (für „zuletzt eingeladen am …“ im Dialog) */
export async function einladungVermerken(tx: Db, e: Event, an: An, r: { gesendet: number; fehler: string[]; ohneMail: string[] }, wer: string): Promise<void> {
  await tx`insert into tco.kal_einladungen (event_id, an, gesendet, fehler, ohne_mail, gesendet_von)
           values (${e.id}, ${an}, ${r.gesendet}, ${r.fehler.length}, ${r.ohneMail.length}, ${wer})`;
}
