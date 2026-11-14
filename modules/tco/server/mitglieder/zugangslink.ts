import { BusinessError } from '../../../../server/src/errors.js';
import { portalUrl, tokenErzeugen } from '../../../../server/src/kennwort.js';
import type { Db, Verein } from '../verein.js';
import { condense } from '../format.js';
import { mailSenden } from '../kommunikation.js';
import { einladungErzeugen, einladungsLink } from './einladung.js';

/**
 * Zugangslinks an ausgewählte Personen (#105, Administration → Benutzer und Rechte → Benutzer → „Einladen & Zugangslinks“):
 *  - Namen per Kopieren & Einfügen (eine Person je Zeile, Tabellen mit „|“ oder Tabulator, kommagetrennte Namenslisten)
 *  - Abgleich mit Benutzern (Anzeigename, Benutzername, verknüpftes Mitglied bzw. EP3-Kunde); wer keinen Benutzer hat, aber
 *    aktives Mitglied ist, erhält statt des Kennwort-Links die Einladung zum Vereinsportal
 *  - Betreff und Text vorgeschlagen und frei änderbar (Platzhalter), optional ein PDF als Anhang für alle
 * Der Kennwort-Link ist ein Einmal-Link (Zweck SETZEN) mit wählbarer Gültigkeit; gespeichert wird nur sein Hash.
 */

export interface Empfaenger {
  /** U:<Benutzer-ID> oder M:<Adressnummer> */
  key: string;
  art: 'BENUTZER' | 'EINLADUNG';
  name: string;
  benutzername: string | null;
  email: string | null;
}

/** Vergleichsschlüssel: klein, ohne Akzente/Umlaute, ß → ss, Bindestriche und mehrfache Leerzeichen vereinheitlicht */
export const namensSchluessel = (s: string) => condense(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9@.\- ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Eingefügten Text in Namen zerlegen: je Zeile die erste Spalte (Trenner „|“ oder Tabulator), HTML-Reste, Kopfzeilen
 * („User“, „Name“, „--“) und reine Zahlen fallen weg. Eine Zelle mit mehreren kommagetrennten Namen wird aufgeteilt,
 * wenn jeder Teil aus mindestens zwei Wörtern besteht; sonst gilt „Nachname, Vorname“.
 */
export function namenLesen(text: string): string[] {
  const out: string[] = [];
  for (const roh of text.replace(/<[^>]*>/g, '\n').split(/\r?\n/)) {
    const zelle = condense(roh.split(/\t|\|/)[0] ?? '');
    if (!zelle || /^[-–—:\s]+$/.test(zelle) || /^\d+$/.test(zelle) || /^(user|benutzer|name|namen|person|personen|mitglied)$/i.test(zelle)) continue;
    const teile = zelle.split(/[;,]/).map((x) => condense(x)).filter(Boolean);
    if (teile.length > 1 && teile.every((x) => x.includes(' '))) out.push(...teile);
    else if (teile.length === 2) out.push(`${teile[1]} ${teile[0]}`);
    else out.push(...teile);
  }
  return [...new Set(out)];
}

/** Namen mit Benutzern und Mitgliedern abgleichen; je Eingabe alle Treffer (mehrere = mehrdeutig, keiner = nicht gefunden) */
export async function abgleichen(db: Db, namen: string[]): Promise<{ eingabe: string; treffer: Empfaenger[] }[]> {
  const benutzer = await db`
    select u.id::text, u.username, u.display_name, nullif(trim(coalesce(u.email, '')), '') as email,
           (select nullif(trim(coalesce(m.email, '')), '') from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = u.id limit 1) as m_email,
           (select array_agg(n) from (
              select trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '')) as n from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = u.id
              union select trim(coalesce(k.vorname, '') || ' ' || coalesce(k.nachname, '')) from tco.kunden k where k.benutzer_id = u.id
              union select trim(k.zalias) from tco.kunden k where k.benutzer_id = u.id) x where n <> '') as namen
      from core.users u where u.active`;
  const mitglieder = await db`
    select m.adrnr, trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '')) as name, nullif(trim(coalesce(m.email, '')), '') as email
      from tco.mitglieder m
     where m.eintritt is not null and (m.austritt is null or m.austritt >= current_date)
       and not exists (select 1 from tco.mitgliedera a where a.adrnr = m.adrnr and a.benutzer_id is not null)`;
  const index = new Map<string, Empfaenger[]>();
  const merke = (schluessel: string, e: Empfaenger) => {
    const k = namensSchluessel(schluessel);
    if (!k) return;
    const l = index.get(k) ?? [];
    if (!l.some((x) => x.key === e.key)) l.push(e);
    index.set(k, l);
  };
  for (const u of benutzer) {
    const e: Empfaenger = { key: `U:${u.id}`, art: 'BENUTZER', name: anzeige(u.display_name), benutzername: u.username, email: u.email ?? u.m_email ?? null };
    merke(u.username, e);
    merke(u.display_name, e);
    // „Nachname, Vorname“ → „Vorname Nachname“
    const [n, v] = String(u.display_name).split(',').map((x) => x.trim());
    if (v) merke(`${v} ${n}`, e);
    for (const x of (u.namen as string[] | null) ?? []) merke(x, e);
  }
  for (const m of mitglieder) {
    merke(m.name, { key: `M:${m.adrnr}`, art: 'EINLADUNG', name: m.name, benutzername: null, email: m.email });
  }
  return namen.map((eingabe) => {
    const k = namensSchluessel(eingabe);
    const umgekehrt = k.split(' ').length === 2 ? k.split(' ').reverse().join(' ') : '';
    const treffer = [...(index.get(k) ?? []), ...((umgekehrt && index.get(umgekehrt)) || [])];
    return { eingabe, treffer: treffer.filter((e, i) => treffer.findIndex((x) => x.key === e.key) === i) };
  });
}

const anzeige = (dn: string) => { const [n, v] = String(dn ?? '').split(',').map((x) => x.trim()); return v ? `${v} ${n}` : String(dn ?? ''); };

export const PLATZHALTER = ['{Vorname}', '{Name}', '{Benutzername}', '{Link}', '{GueltigBis}'];

export function vorlage(v: Pick<Verein, 'name' | 'ansprechpartner'>) {
  return {
    betreff: `${v.name}: Ihr Zugang zum Vereinsportal`,
    text: 'Hallo {Vorname},\n\n'
      + `für das Vereinsportal des ${v.name} gibt es einen Neustart: Bitte vergeben Sie über diesen persönlichen Link ein neues Kennwort `
      + '(bzw. wählen Sie Benutzername und Kennwort, falls Sie noch keinen Zugang haben):\n\n{Link}\n\n'
      + 'Ihr Benutzername: {Benutzername}\n\n'
      + 'Der Link gilt bis {GueltigBis}, nur einmal und nur für Sie – bitte nicht weitergeben. '
      + 'Im Anhang finden Sie ggf. eine kurze Anleitung.\n\n'
      + `Viele Grüße\n${v.ansprechpartner || v.name}`,
  };
}

const ersetzen = (s: string, w: Record<string, string>) => s.replace(/\{(Vorname|Name|Benutzername|Link|GueltigBis)\}/g, (_, k: string) => w[k] ?? '');

export interface Versand { betreff: string; text: string; tage: number; pdf: { dateiname: string; inhalt: Buffer } | null; wer: string; /** Kopie an den Versender */ cc?: string | null }

/** Einen Empfänger anschreiben: Link erzeugen (Kennwort setzen bzw. Einladung), Platzhalter füllen, Mail senden */
export async function zugangSenden(tx: Db, v: Verein, key: string, o: Versand): Promise<{ name: string; an: string; art: Empfaenger['art'] }> {
  const url = await portalUrl();
  if (!url) throw new BusinessError('Für Zugangslinks fehlt die Portal-Adresse (Administration → Einstellungen).');
  if (!o.text.includes('{Link}')) throw new BusinessError('Der Text muss den Platzhalter {Link} enthalten.');
  const stunden = o.tage * 24;
  const bis = new Date(Date.now() + stunden * 3600_000).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
  let w: Record<string, string>;
  let an: string;
  let art: Empfaenger['art'];
  let objekt: string;
  if (key.startsWith('U:')) {
    const id = key.slice(2);
    const [u] = await tx`
      select u.id::text, u.username, u.display_name, nullif(trim(coalesce(u.email, '')), '') as email,
             (select m.vorname from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = u.id limit 1) as m_vorname,
             (select nullif(trim(coalesce(m.email, '')), '') from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = u.id limit 1) as m_email,
             (select k.vorname from tco.kunden k where k.benutzer_id = u.id limit 1) as k_vorname
        from core.users u where u.id::text = ${id} and u.active`;
    if (!u) throw new BusinessError('Benutzer nicht gefunden oder gesperrt.');
    an = u.email ?? u.m_email ?? '';
    if (!an) throw new BusinessError(`Für ${anzeige(u.display_name)} ist keine E-Mail-Adresse hinterlegt.`);
    const token = await tokenErzeugen(tx, u.id, 'SETZEN', null, stunden);
    const name = anzeige(u.display_name);
    w = { Vorname: condense(u.m_vorname || u.k_vorname || name.split(' ')[0] || ''), Name: name, Benutzername: u.username, Link: `${url}/?kennwort=${token}`, GueltigBis: bis };
    art = 'BENUTZER';
    objekt = u.username;
  } else if (key.startsWith('M:')) {
    const adrnr = key.slice(2);
    const [m] = await tx`select m.* from tco.mitglieder m where m.adrnr = ${adrnr} and m.eintritt is not null and (m.austritt is null or m.austritt >= current_date)
                           and not exists (select 1 from tco.mitgliedera a where a.adrnr = m.adrnr and a.benutzer_id is not null)`;
    if (!m) throw new BusinessError('Mitglied nicht aktiv oder hat inzwischen einen Benutzer.');
    an = String(m.email ?? '').trim();
    const name = condense(`${m.vorname ?? ''} ${m.nachname ?? ''}`);
    if (!an) throw new BusinessError(`Für ${name} ist keine E-Mail-Adresse hinterlegt.`);
    const token = await einladungErzeugen(tx, adrnr, 'MAIL', o.wer, stunden);
    w = { Vorname: condense(m.vorname ?? ''), Name: name, Benutzername: 'wählen Sie beim ersten Aufruf des Links selbst', Link: einladungsLink(url, token), GueltigBis: bis };
    art = 'EINLADUNG';
    objekt = adrnr;
  } else throw new BusinessError('Unbekannter Empfänger.');
  const e = await mailSenden(v, {
    modus: 'senden', anwendung: 'Benutzer', objekt, an, cc: o.cc ?? '', betreff: ersetzen(o.betreff, w), text: ersetzen(o.text, w), benutzer: o.wer,
    anhaenge: o.pdf ? [{ dateiname: o.pdf.dateiname, mime: 'application/pdf', inhalt: o.pdf.inhalt, objekt }] : [],
    // enthält einen persönlichen Link: nie speichern, sondern neu auslösen
    wiederholung: { art: 'NEU_AUSLOESEN', hinweis: 'Enthält einen persönlichen Zugangslink – bitte neu auslösen: Administration → Benutzer und Rechte → Benutzer → „Einladen & Zugangslinks“.' },
  });
  if (e.status === 'fehler') throw new BusinessError(e.fehler ?? 'Versand fehlgeschlagen');
  return { name: w.Name, an, art };
}
