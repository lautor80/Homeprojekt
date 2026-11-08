import { BusinessError } from '../../../../server/src/errors.js';
import { hashPassword, validatePassword } from '../../../../server/src/auth.js';
import { compareSync } from '../../../../server/src/vendor/bcryptjs/index.js';
import type { Db } from '../verein.js';
import { condense } from '../format.js';
import { adrnrAusZuid } from '../kommunikation.js';

/**
 * Registrierung neuer Hallennutzer mit Freigabe durch die Platzverwaltung.
 *
 * - Jeder Registrierte wird nach der Freigabe ein Portalbenutzer mit GENAU der Rolle HALLENNUTZER, die nur
 *   „Platz buchen“ (eigene Einzelbuchungen) erlaubt. Die Rolle ist eine Systemrolle; ihre Berechtigungen
 *   werden hier bei jedem Start und vor jeder Freigabe erzwungen (rolleSicherstellen) und nach dem Anlegen geprüft.
 * - Bestehende EP3-Nutzer: Beim Registrieren kann das EP3-Konto (Benutzername/E-Mail + EP3-Kennwort) nachgewiesen
 *   werden; das Kennwort wird übernommen (bcrypt-Hash aus bs_users.pw, im Kundenimport Spalte PW). Die Zuordnung
 *   zum EP3-Kunden sorgt dafür, dass die bestehenden EP3-Buchungen als eigene erscheinen und abgerechnet werden.
 * - Freigabe: wahlweise Mitglied (tco.mitgliedera.benutzer_id), EP3-Kunde (tco.kunden.benutzer_id) oder neuer
 *   Kunde ohne Mitgliedschaft (eigener Kundenstammsatz, Adressnummer 99…).
 */
export const ROLLE = 'HALLENNUTZER';
export const ROLLE_RECHTE = ['tco.platzbuchung:edit'];
const GESPERRT = ['blocked', 'deleted', 'disabled'];

const istBcrypt = (h: string | null | undefined) => !!h && /^\$2[abxy]?\$\d\d\$/.test(h);
const name = (v?: string | null, n?: string | null) => condense(`${v ?? ''} ${n ?? ''}`);

/** Rolle HALLENNUTZER: vorhanden, Systemrolle, genau die vorgesehenen Berechtigungen */
export async function rolleSicherstellen(db: Db): Promise<void> {
  await db`insert into core.roles (id, name, description, system)
           values (${ROLLE}, 'Hallennutzer', 'Selbst registrierte Hallennutzer: nur eigene Einzelbuchungen (Platz buchen). Berechtigungen fest vorgegeben.', true)
           on conflict (id) do update set system = true`;
  await db`delete from core.role_permissions where role_id = ${ROLLE} and permission <> all(${ROLLE_RECHTE})`;
  for (const p of ROLLE_RECHTE) {
    await db`insert into core.role_permissions (role_id, permission) values (${ROLLE}, ${p}) on conflict do nothing`;
  }
}

/** Nach dem Anlegen: der Benutzer hat ausschließlich die Rolle HALLENNUTZER und damit genau ROLLE_RECHTE */
async function rechtePruefen(db: Db, benutzerId: string) {
  const rollen = (await db`select role_id from core.user_roles where user_id = ${benutzerId}`).map((r) => r.role_id as string);
  const rechte = (await db`select distinct rp.permission from core.user_roles ur join core.role_permissions rp on rp.role_id = ur.role_id
                            where ur.user_id = ${benutzerId} order by 1`).map((r) => r.permission as string);
  if (rollen.length !== 1 || rollen[0] !== ROLLE || rechte.join(',') !== [...ROLLE_RECHTE].sort().join(',')) {
    throw new BusinessError(`Sicherheitsprüfung fehlgeschlagen: Der neue Benutzer hätte mehr als die Einzelbuchung erhalten (${rollen.join(', ')} → ${rechte.join(', ')}). Vorgang abgebrochen.`, 500);
  }
}

// ---------------------------------------------------------------------------
// Registrieren (öffentlich)
// ---------------------------------------------------------------------------
export interface RegistrierungEingabe {
  benutzername: string; vorname: string; nachname: string; email: string; telefon?: string | null; nachricht?: string | null;
  passwort?: string | null;
  /** bestehendes EP3-Konto: Benutzername oder E-Mail und EP3-Kennwort */
  ep3_konto?: string | null; ep3_passwort?: string | null;
}

export async function benutzernameFrei(db: Db, benutzername: string): Promise<string | null> {
  const [u] = await db`select 1 from core.users where lower(username) = lower(${benutzername})`;
  if (u) return 'Dieser Benutzername ist bereits vergeben.';
  const [r] = await db`select 1 from tco.registrierungen where lower(benutzername) = lower(${benutzername}) and status = 'OFFEN'`;
  if (r) return 'Für diesen Benutzernamen liegt bereits eine Registrierung vor.';
  return null;
}

/** EP3-Konto per Kennwort nachweisen; null = nicht erkannt (Meldung bewusst unspezifisch) */
export async function ep3Nachweisen(db: Db, konto: string, passwort: string): Promise<{ zuid: string; zalias: string; email: string | null; vorname: string | null; nachname: string | null } | null> {
  const k = condense(konto).toLowerCase();
  if (!k || !passwort) return null;
  const kandidaten = await db`select zuid, zalias, email, vorname, nachname, pw_hash, status from tco.kunden
                               where pw_hash is not null and (lower(zalias) = ${k} or lower(coalesce(email, '')) = ${k})
                               order by case when coalesce(status, '') = any(${GESPERRT}) then 1 else 0 end, zuid desc`;
  for (const c of kandidaten) {
    if (GESPERRT.includes(c.status ?? '')) continue;
    if (istBcrypt(c.pw_hash) && compareSync(passwort, c.pw_hash)) return { zuid: c.zuid, zalias: c.zalias, email: c.email, vorname: c.vorname, nachname: c.nachname };
  }
  return null;
}

export async function registrieren(db: Db, e: RegistrierungEingabe, ip: string): Promise<{ id: number; ep3: boolean; text: string }> {
  const frei = await benutzernameFrei(db, e.benutzername);
  if (frei) throw new BusinessError(frei, 409);
  let hash: string;
  let zuid: string | null = null;
  if (e.ep3_konto) {
    const k = await ep3Nachweisen(db, e.ep3_konto, e.ep3_passwort ?? '');
    if (!k) throw new BusinessError('Das EP3-Konto konnte mit diesen Zugangsdaten nicht bestätigt werden. Bitte Benutzername/E-Mail und Kennwort aus dem EP3-Buchungssystem prüfen – oder ohne EP3-Konto registrieren.', 401);
    const [schon] = await db`select benutzer_id from tco.kunden where zuid = ${k.zuid} and benutzer_id is not null`;
    if (schon) throw new BusinessError('Zu diesem EP3-Konto gibt es bereits einen Portalzugang. Bitte damit anmelden oder beim Verein melden.', 409);
    const [offen] = await db`select 1 from tco.registrierungen where ep3_zuid = ${k.zuid} and status = 'OFFEN'`;
    if (offen) throw new BusinessError('Für dieses EP3-Konto liegt bereits eine Registrierung vor.', 409);
    zuid = k.zuid;
    // bisheriges Kennwort bleibt gültig (bcrypt-Hash wird übernommen); optional neues Kennwort
    if (e.passwort) {
      const f = validatePassword(e.passwort);
      if (f) throw new BusinessError(f);
      hash = await hashPassword(e.passwort);
    } else {
      hash = (await db`select pw_hash from tco.kunden where zuid = ${k.zuid} and pw_hash is not null limit 1`)[0].pw_hash;
    }
  } else {
    const f = validatePassword(e.passwort ?? '');
    if (f) throw new BusinessError(f);
    hash = await hashPassword(e.passwort!);
  }
  const [r] = await db`insert into tco.registrierungen (benutzername, anzeigename, vorname, nachname, email, telefon, passwort_hash, ep3_zuid, nachricht, ip)
                       values (${e.benutzername}, ${name(e.vorname, e.nachname)}, ${e.vorname}, ${e.nachname}, ${e.email.trim()}, ${e.telefon?.trim() || null},
                               ${hash}, ${zuid}, ${e.nachricht?.trim() || null}, ${ip}) returning id`;
  return {
    id: Number(r.id), ep3: !!zuid,
    text: zuid
      ? 'Vielen Dank! Ihr EP3-Konto wurde erkannt. Sobald der Verein die Registrierung freigegeben hat, können Sie sich mit dem gewählten Benutzernamen und Ihrem bisherigen EP3-Kennwort anmelden.'
      : 'Vielen Dank! Ihre Registrierung wird vom Verein geprüft. Nach der Freigabe erhalten Sie eine E-Mail und können sich anmelden.',
  };
}

// ---------------------------------------------------------------------------
// Verwaltung: offene Registrierungen mit Zuordnungsvorschlägen
// ---------------------------------------------------------------------------
export interface Vorschlag { art: 'MITGLIED' | 'EP3'; schluessel: string; name: string; grund: string; info: string }

async function vorschlaege(db: Db, p: { email: string | null; vorname: string | null; nachname: string | null; benutzername?: string | null }): Promise<Vorschlag[]> {
  const out: Vorschlag[] = [];
  const email = (p.email ?? '').trim().toLowerCase();
  const voll = name(p.vorname, p.nachname).toUpperCase();
  if (email) {
    for (const m of await db`select adrnr, vorname, nachname, austritt::text from tco.mitglieder where lower(trim(coalesce(email, ''))) = ${email} order by austritt nulls first`) {
      out.push({ art: 'MITGLIED', schluessel: m.adrnr, name: name(m.vorname, m.nachname), grund: 'gleiche E-Mail', info: `Mitglied ${m.adrnr}${m.austritt ? ` (ausgetreten ${m.austritt})` : ''}` });
    }
  }
  if (voll) {
    for (const m of await db`select adrnr, vorname, nachname, austritt::text from tco.mitglieder
                              where upper(trim(coalesce(vorname, '') || ' ' || coalesce(nachname, ''))) = ${voll} order by austritt nulls first`) {
      if (!out.some((o) => o.art === 'MITGLIED' && o.schluessel === m.adrnr)) {
        out.push({ art: 'MITGLIED', schluessel: m.adrnr, name: name(m.vorname, m.nachname), grund: 'gleicher Name', info: `Mitglied ${m.adrnr}${m.austritt ? ` (ausgetreten ${m.austritt})` : ''}` });
      }
    }
  }
  const kunden = await db`select zuid, zalias, email, vorname, nachname, status, pw_hash is not null as kennwort from tco.kunden
                           where benutzer_id is null and zuid not in (select zuid from tco.mitgliedera where zuid is not null)
                             and (lower(coalesce(email, '')) = ${email || '§'} or upper(trim(coalesce(vorname, '') || ' ' || coalesce(nachname, ''))) = ${voll || '§'}
                                  or lower(zalias) = ${(p.benutzername ?? '§').toLowerCase()})
                           order by zuid desc`;
  for (const k of kunden) {
    const grund = (k.email ?? '').trim().toLowerCase() === email && email ? 'gleiche E-Mail' : k.zalias.toLowerCase() === (p.benutzername ?? '').toLowerCase() ? 'gleicher Benutzername' : 'gleicher Name';
    out.push({ art: 'EP3', schluessel: k.zuid, name: name(k.vorname, k.nachname) || k.zalias, grund, info: `EP3 „${k.zalias}“${k.status ? ` · ${k.status}` : ''}${k.kennwort ? ' · Kennwort vorhanden' : ''}` });
  }
  return out;
}

export async function registrierungenLesen(db: Db, status: 'OFFEN' | 'ALLE' = 'OFFEN') {
  const rows = await db`
    select r.id, r.benutzername, r.anzeigename, r.vorname, r.nachname, r.email, r.telefon, r.ep3_zuid, r.nachricht, r.status,
           r.erstellt, r.bearbeitet_am, r.bearbeitet_von, r.bemerkung, k.zalias as ep3_alias,
           nullif(trim(coalesce(k.vorname, '') || ' ' || coalesce(k.nachname, '')), '') as ep3_name
      from tco.registrierungen r
      left join lateral (select zalias, vorname, nachname from tco.kunden where zuid = r.ep3_zuid order by zalias limit 1) k on true
     where ${status === 'ALLE' ? db`true` : db`r.status = 'OFFEN'`}
     order by r.status = 'OFFEN' desc, r.erstellt desc limit 300`;
  const out = [];
  for (const r of rows) {
    out.push({
      ...r, id: Number(r.id),
      vorschlaege: r.status === 'OFFEN' ? await vorschlaege(db, { email: r.email, vorname: r.vorname, nachname: r.nachname, benutzername: r.benutzername }) : [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Freigabe / Ablehnung
// ---------------------------------------------------------------------------
export interface Freigabe {
  /** Zuordnung: Mitglied (adrnr), EP3-Kunde (zuid) oder NEU (eigener Kundenstammsatz ohne Mitgliedschaft) */
  zuordnung: { art: 'MITGLIED'; adrnr: string } | { art: 'EP3'; zuid: string } | { art: 'NEU' };
  bemerkung?: string | null;
}

async function benutzerAnlegen(tx: Db, b: { username: string; displayName: string; email: string | null; passwortHash: string; mussAendern: boolean }): Promise<string> {
  const [exists] = await tx`select 1 from core.users where lower(username) = lower(${b.username})`;
  if (exists) throw new BusinessError(`Der Benutzername „${b.username}“ ist inzwischen vergeben.`, 409);
  await rolleSicherstellen(tx);
  const [u] = await tx`insert into core.users (username, display_name, email, password_hash, must_change_password)
                       values (${b.username}, ${b.displayName}, ${b.email}, ${b.passwortHash}, ${b.mussAendern}) returning id`;
  await tx`insert into core.user_roles (user_id, role_id) values (${u.id}, ${ROLLE})`;
  await rechtePruefen(tx, u.id);
  return u.id as string;
}

async function mitgliedZuordnen(tx: Db, benutzerId: string, adrnr: string) {
  const [m] = await tx`select adrnr from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError('Mitglied nicht gefunden.');
  const [andere] = await tx`select u.username from tco.mitgliedera a join core.users u on u.id = a.benutzer_id where a.adrnr = ${adrnr} and a.benutzer_id <> ${benutzerId}`;
  if (andere) throw new BusinessError(`Das Mitglied ist bereits dem Benutzer ${andere.username} zugeordnet.`);
  await tx`insert into tco.mitgliedera (adrnr, benutzer_id) values (${adrnr}, ${benutzerId})
           on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id`;
}

async function kundeZuordnen(tx: Db, benutzerId: string, zuid: string) {
  const k = await tx`select zuid, benutzer_id from tco.kunden where zuid = ${zuid}`;
  if (!k.length) throw new BusinessError('EP3-Kunde nicht gefunden.');
  if (k.some((x) => x.benutzer_id && x.benutzer_id !== benutzerId)) throw new BusinessError('Dieser EP3-Kunde ist bereits einem anderen Benutzer zugeordnet.');
  // ist der EP3-Kunde einem Mitglied zugeordnet, gilt das Mitglied
  const [mz] = await tx`select adrnr from tco.mitgliedera where zuid = ${zuid} limit 1`;
  if (mz) return mitgliedZuordnen(tx, benutzerId, mz.adrnr);
  await tx`update tco.kunden set benutzer_id = ${benutzerId} where zuid = ${zuid}`;
}

/** neuer Kundenstammsatz für Nutzer ohne Mitgliedschaft (ZUID 9xxxxxxx aus eigenem Nummernkreis, Adressnummer 99…) */
async function kundeAnlegen(tx: Db, benutzerId: string, p: { benutzername: string; vorname: string | null; nachname: string | null; email: string; telefon: string | null }) {
  const [{ n }] = await tx`select core.next_number('TCO_KUNDE', 0)::bigint as n`;
  const zuid = String(90_000_000 + Number(n));
  await tx`insert into tco.kunden (zuid, zalias, status, email, vorname, nachname, telefonnummer, benutzer_id)
           values (${zuid}, ${p.benutzername}, 'portal', ${p.email}, ${p.vorname}, ${p.nachname}, ${p.telefon}, ${benutzerId})`;
  return zuid;
}

export async function bestaetigen(tx: Db, id: number, f: Freigabe, bearbeiter: string): Promise<{ benutzerId: string; text: string; email: string; anzeigename: string; ep3: boolean }> {
  const [r] = await tx`select * from tco.registrierungen where id = ${id} for update`;
  if (!r) throw new BusinessError('Registrierung nicht gefunden.', 404);
  if (r.status !== 'OFFEN') throw new BusinessError(`Die Registrierung ist bereits ${r.status === 'BESTAETIGT' ? 'freigegeben' : 'abgelehnt'}.`);
  const uid = await benutzerAnlegen(tx, { username: r.benutzername, displayName: r.anzeigename, email: r.email, passwortHash: r.passwort_hash, mussAendern: false });
  let wohin: string;
  if (f.zuordnung.art === 'MITGLIED') {
    await mitgliedZuordnen(tx, uid, f.zuordnung.adrnr);
    // nachgewiesenes EP3-Konto am Mitglied vermerken, damit alte EP3-Buchungen zum Mitglied gehören
    if (r.ep3_zuid) await tx`update tco.mitgliedera set zuid = coalesce(zuid, ${r.ep3_zuid}) where adrnr = ${f.zuordnung.adrnr}`;
    wohin = `Mitglied ${f.zuordnung.adrnr}`;
  } else if (f.zuordnung.art === 'EP3') {
    await kundeZuordnen(tx, uid, f.zuordnung.zuid);
    wohin = `EP3-Kunde ${f.zuordnung.zuid}`;
  } else {
    const zuid = r.ep3_zuid ?? await kundeAnlegen(tx, uid, { benutzername: r.benutzername, vorname: r.vorname, nachname: r.nachname, email: r.email, telefon: r.telefon });
    if (r.ep3_zuid) await kundeZuordnen(tx, uid, r.ep3_zuid);
    wohin = r.ep3_zuid ? `EP3-Kunde ${zuid}` : `neuer Kunde ${adrnrAusZuid(zuid)}`;
  }
  await tx`update tco.registrierungen set status = 'BESTAETIGT', bearbeitet_am = now(), bearbeitet_von = ${bearbeiter}, bemerkung = ${f.bemerkung ?? null}, benutzer_id = ${uid}
           where id = ${id}`;
  return { benutzerId: uid, email: r.email, anzeigename: r.anzeigename, ep3: !!r.ep3_zuid, text: `${r.anzeigename} freigegeben (Benutzer ${r.benutzername}, Rolle Hallennutzer, ${wohin}).` };
}

export async function ablehnen(tx: Db, id: number, bemerkung: string | null, bearbeiter: string): Promise<string> {
  const [r] = await tx`update tco.registrierungen set status = 'ABGELEHNT', bearbeitet_am = now(), bearbeitet_von = ${bearbeiter}, bemerkung = ${bemerkung}
                       where id = ${id} and status = 'OFFEN' returning anzeigename`;
  if (!r) throw new BusinessError('Registrierung nicht gefunden oder bereits bearbeitet.', 404);
  return `Registrierung von ${r.anzeigename} abgelehnt.`;
}

// ---------------------------------------------------------------------------
// EP3-Abgleich: Kunden ohne Portalzugang mit vorhandenen Benutzern/Mitgliedern zusammenbringen
// ---------------------------------------------------------------------------
export async function ep3Abgleich(db: Db) {
  const kunden = await db`
    select distinct on (k.zuid) k.zuid, k.zalias, k.email, k.vorname, k.nachname, k.status, k.pw_hash is not null as kennwort, k.benutzer_id::text,
           u.username as benutzer, a.adrnr as mitglied_adrnr,
           (select count(*)::int from tco.bookings b
             where b.datum >= current_date - 365 and coalesce(b.status, '') not in ('2', '4')
               and upper(trim(b.kunde)) in (upper(trim(coalesce(k.vorname, '') || ' ' || coalesce(k.nachname, ''))), upper(trim(k.zalias)))) as buchungen
      from tco.kunden k
      left join core.users u on u.id = k.benutzer_id
      left join tco.mitgliedera a on a.zuid = k.zuid
     where coalesce(k.status, '') <> all(${GESPERRT}) and coalesce(k.status, '') <> 'placeholder'
     order by k.zuid, k.zalias`;
  const benutzer = await db`select u.id::text as id, u.username, u.display_name as name, lower(coalesce(u.email, '')) as email, a.adrnr,
                                     upper(trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, ''))) as mitglied_name, lower(trim(coalesce(m.email, ''))) as mitglied_email
                              from core.users u left join tco.mitgliedera a on a.benutzer_id = u.id left join tco.mitglieder m on m.adrnr = a.adrnr where u.active`;
  const out = [];
  for (const k of kunden) {
    const email = (k.email ?? '').trim().toLowerCase();
    const voll = name(k.vorname, k.nachname).toUpperCase();
    const treffer: { art: 'BENUTZER' | 'MITGLIED'; schluessel: string; name: string; grund: string }[] = [];
    for (const u of benutzer) {
      const grund = u.username.toLowerCase() === k.zalias.toLowerCase() ? 'gleicher Benutzername' : email && (u.email === email || u.mitglied_email === email) ? 'gleiche E-Mail'
        : voll && (condense(u.name).toUpperCase() === voll || u.mitglied_name === voll) ? 'gleicher Name' : null;
      if (grund) treffer.push({ art: 'BENUTZER', schluessel: u.id, name: `${u.name} (${u.username})${u.adrnr ? ` · Mitglied ${u.adrnr}` : ''}`, grund });
    }
    if (!k.mitglied_adrnr) {
      const ms = await db`select adrnr, vorname, nachname, lower(trim(coalesce(email, ''))) as email from tco.mitglieder
                           where (lower(trim(coalesce(email, ''))) = ${email || '§'} or upper(trim(coalesce(vorname, '') || ' ' || coalesce(nachname, ''))) = ${voll || '§'})
                             and (austritt is null or austritt >= current_date) order by adrnr`;
      for (const m of ms) treffer.push({ art: 'MITGLIED', schluessel: m.adrnr, name: `${name(m.vorname, m.nachname)} · Mitglied ${m.adrnr}`, grund: email && m.email === email ? 'gleiche E-Mail' : 'gleicher Name' });
    }
    out.push({
      zuid: k.zuid, alias: k.zalias, name: name(k.vorname, k.nachname), email: k.email, status: k.status, kennwort: k.kennwort, buchungen: k.buchungen,
      benutzer: k.benutzer, mitglied: k.mitglied_adrnr, treffer,
    });
  }
  return out;
}

/** EP3-Kunde einem vorhandenen Benutzer zuordnen (ist der Benutzer ein Mitglied, wird die ZUID am Mitglied vermerkt) */
export async function ep3Verknuepfen(tx: Db, zuid: string, benutzerId: string): Promise<string> {
  const [u] = await tx`select username from core.users where id = ${benutzerId}`;
  if (!u) throw new BusinessError('Benutzer nicht gefunden.');
  const [a] = await tx`select adrnr from tco.mitgliedera where benutzer_id = ${benutzerId}`;
  if (a) {
    await tx`update tco.mitgliedera set zuid = ${zuid} where adrnr = ${a.adrnr}`;
    await tx`update tco.kunden set benutzer_id = null where zuid = ${zuid}`;
    return `EP3-Kunde ${zuid} dem Mitglied ${a.adrnr} (Benutzer ${u.username}) zugeordnet.`;
  }
  await kundeZuordnen(tx, benutzerId, zuid);
  return `EP3-Kunde ${zuid} dem Benutzer ${u.username} zugeordnet.`;
}

/** EP3-Kunde dem Mitglied zuordnen (ohne Benutzer) */
export async function ep3Mitglied(tx: Db, zuid: string, adrnr: string): Promise<string> {
  const [m] = await tx`select adrnr from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError('Mitglied nicht gefunden.');
  await tx`insert into tco.mitgliedera (adrnr, zuid) values (${adrnr}, ${zuid}) on conflict (adrnr) do update set zuid = excluded.zuid`;
  return `EP3-Kunde ${zuid} dem Mitglied ${adrnr} zugeordnet.`;
}

/**
 * Aus einem EP3-Kunden direkt einen Hallennutzer anlegen (ohne Registrierung): Benutzername = EP3-Alias,
 * Kennwort = übernommener EP3-Hash. Ohne gespeichertes Kennwort wird ein Startkennwort vergeben, das einmalig angezeigt wird.
 */
export async function ep3Anlegen(tx: Db, zuid: string): Promise<{ username: string; startkennwort: string | null; text: string }> {
  const k = await tx`select * from tco.kunden where zuid = ${zuid} order by zalias`;
  if (!k.length) throw new BusinessError('EP3-Kunde nicht gefunden.');
  if (k.some((x) => x.benutzer_id)) throw new BusinessError('Dieser EP3-Kunde hat bereits einen Portalzugang.');
  const [mz] = await tx`select a.adrnr, a.benutzer_id from tco.mitgliedera a where a.zuid = ${zuid}`;
  if (mz?.benutzer_id) throw new BusinessError('Das zugehörige Mitglied hat bereits einen Benutzer.');
  const username = await freierBenutzername(tx, k[0].email, k[0].zalias, zuid);
  const mitHash = k.find((x) => istBcrypt(x.pw_hash));
  let startkennwort: string | null = null;
  let hash: string;
  if (mitHash) hash = mitHash.pw_hash;
  else {
    const { randomBytes } = await import('node:crypto');
    startkennwort = randomBytes(9).toString('base64url');
    hash = await hashPassword(startkennwort);
  }
  const uid = await benutzerAnlegen(tx, { username, displayName: name(k[0].vorname, k[0].nachname) || k[0].zalias, email: k[0].email?.trim() || null, passwortHash: hash, mussAendern: !mitHash });
  if (mz) await mitgliedZuordnen(tx, uid, mz.adrnr);
  else await tx`update tco.kunden set benutzer_id = ${uid} where zuid = ${zuid}`;
  return {
    username, startkennwort,
    text: `Benutzer ${username} angelegt (Rolle Hallennutzer${mz ? `, Mitglied ${mz.adrnr}` : ''})${mitHash ? ' – bisheriges EP3-Kennwort gilt weiter.' : ' – Startkennwort bitte sicher übermitteln, es wird beim ersten Anmelden geändert.'}`,
  };
}

/** Benutzername für einen EP3-Kunden: E-Mail-Adresse, sonst EP3-Alias; bei Kollision mit Zusatz */
async function freierBenutzername(tx: Db, email: string | null | undefined, alias: string, zuid: string): Promise<string> {
  const mail = (email ?? '').trim().toLowerCase();
  const kandidaten = [
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? mail : '',
    alias.replace(/[^a-zA-Z0-9._@+-]/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 50),
    `ep3.${zuid}`,
  ].filter((x) => x.length >= 3);
  for (const basis of kandidaten) {
    if (!(await tx`select 1 from core.users where lower(username) = lower(${basis})`).length) return basis;
  }
  const basis = kandidaten[0];
  for (let i = 2; ; i++) {
    const n = `${basis}.${i}`;
    if (!(await tx`select 1 from core.users where lower(username) = lower(${n})`).length) return n;
  }
}

/**
 * Nach dem Kundenimport: für alle aktiven EP3-Kunden ohne Portalzugang einen Hallennutzer anlegen.
 * Benutzername = E-Mail-Adresse (sonst EP3-Alias), Anzeigename „Nachname, Vorname“, Rolle HALLENNUTZER,
 * Kennwort = übernommener EP3-Hash (ohne Hash: Zufallskennwort, Änderung beim ersten Anmelden – Kennwort über Benutzerpflege setzen).
 * Zuordnung: Mitglied mit gleicher ZUID (Mitglied → Zusatzdaten), sonst gleiche E-Mail oder gleicher Name, sonst EP3-Kunde selbst.
 */
export async function ep3BenutzerAnlegen(tx: Db, zuids?: string[]): Promise<{ angelegt: number; mitglieder: number; ohneKennwort: number; uebersprungen: number }> {
  const kunden = await tx`
    select distinct on (k.zuid) k.zuid, k.zalias, k.email, k.vorname, k.nachname, k.pw_hash
      from tco.kunden k
     where coalesce(k.status, '') not in ('placeholder', 'blocked', 'deleted', 'disabled')
       and k.benutzer_id is null
       and not exists (select 1 from tco.mitgliedera a where a.zuid = k.zuid and a.benutzer_id is not null)
       ${zuids ? tx`and k.zuid = any(${zuids})` : tx``}
     order by k.zuid, k.zalias`;
  const r = { angelegt: 0, mitglieder: 0, ohneKennwort: 0, uebersprungen: 0 };
  if (!kunden.length) return r;
  await rolleSicherstellen(tx);
  const { randomBytes } = await import('node:crypto');
  for (const k of kunden) {
    const email = (k.email ?? '').trim().toLowerCase();
    const voll = name(k.vorname, k.nachname).toUpperCase();
    // Mitglied: ZUID, sonst E-Mail, sonst Name – nur wenn es noch keinen Benutzer hat
    const [m] = await tx`
      select m.adrnr from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
       where a.benutzer_id is null and (m.austritt is null or m.austritt >= current_date)
         and (a.zuid = ${k.zuid}
              or (${email} <> '' and lower(trim(coalesce(m.email, ''))) = ${email})
              or (${voll} <> '' and upper(trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, ''))) = ${voll}))
       order by (a.zuid = ${k.zuid}) desc nulls last, (lower(trim(coalesce(m.email, ''))) = ${email}) desc, m.adrnr
       limit 1`;
    const username = await freierBenutzername(tx, k.email, k.zalias, k.zuid);
    const anzeige = k.nachname || k.vorname ? condense(`${k.nachname ?? ''}, ${k.vorname ?? ''}`).replace(/^, |, $/g, '') : k.zalias;
    let hash: string;
    let mussAendern = false;
    if (istBcrypt(k.pw_hash)) hash = k.pw_hash;
    else { hash = await hashPassword(randomBytes(18).toString('base64url')); mussAendern = true; r.ohneKennwort++; }
    try {
      const uid = await benutzerAnlegen(tx, { username, displayName: anzeige, email: email || null, passwortHash: hash, mussAendern });
      if (m) {
        await tx`insert into tco.mitgliedera (adrnr, benutzer_id, zuid) values (${m.adrnr}, ${uid}, ${k.zuid})
                 on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id, zuid = coalesce(tco.mitgliedera.zuid, excluded.zuid)`;
        r.mitglieder++;
      } else {
        await tx`update tco.kunden set benutzer_id = ${uid} where zuid = ${k.zuid}`;
      }
      r.angelegt++;
    } catch (e) {
      if (e instanceof BusinessError && e.statusCode === 409) { r.uebersprungen++; continue; }
      throw e;
    }
  }
  return r;
}
