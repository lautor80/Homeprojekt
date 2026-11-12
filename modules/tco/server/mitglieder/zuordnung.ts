import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense } from '../format.js';
import { benutzerZuordnen } from '../platz/logik.js';
import { buchungsrechtSichern, rolleSicherstellen, ROLLE, ROLLE_MITGLIED } from '../platz/registrierung.js';

/**
 * Zuordnung vorhandener Benutzer zu Mitglied und EP3-Kunde (Administration → Benutzer).
 * - Mitglied: tco.mitgliedera.benutzer_id (je Benutzer höchstens ein Mitglied)
 * - EP3-Kunde: bei Mitglied über tco.mitgliedera.zuid (EP3-Buchungen gehören dann zum Mitglied),
 *   sonst über tco.kunden.benutzer_id (Benutzer bucht als EP3-Kunde)
 * Initiales Mapping: Vorschläge für alle Benutzer ohne Zuordnung nach E-Mail, Benutzername und Name.
 */
const norm = (s: string | null | undefined) => condense(String(s ?? '')).toUpperCase()
  .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS');
/** „Nachname, Vorname“ und „Vorname Nachname“ → gleicher Schlüssel */
const namen = (anzeige: string) => {
  const a = norm(anzeige);
  const komma = /^(.+?),\s*(.+)$/.exec(a);
  return new Set([a, komma ? `${komma[2]} ${komma[1]}` : a].map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean));
};

export interface Zuordnung {
  mitglied: { adrnr: string; name: string; austritt: string | null } | null;
  ep3: { zuid: string; alias: string; name: string; ueber: 'MITGLIED' | 'BENUTZER' } | null;
}

export async function zuordnungLesen(db: Db, benutzerId: string): Promise<Zuordnung> {
  const [m] = await db`select a.adrnr, a.zuid, trim(coalesce(m.nachname, '') || ', ' || coalesce(m.vorname, '')) as name, m.austritt::text as austritt
                         from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = ${benutzerId}`;
  let ep3: Zuordnung['ep3'] = null;
  if (m?.zuid) {
    const [k] = await db`select zuid, zalias, trim(coalesce(vorname, '') || ' ' || coalesce(nachname, '')) as name from tco.kunden where zuid = ${m.zuid} order by zalias limit 1`;
    if (k) ep3 = { zuid: k.zuid, alias: k.zalias, name: k.name || k.zalias, ueber: 'MITGLIED' };
  }
  if (!ep3) {
    const [k] = await db`select zuid, zalias, trim(coalesce(vorname, '') || ' ' || coalesce(nachname, '')) as name from tco.kunden where benutzer_id = ${benutzerId} order by zalias limit 1`;
    if (k) ep3 = { zuid: k.zuid, alias: k.zalias, name: k.name || k.zalias, ueber: 'BENUTZER' };
  }
  return { mitglied: m ? { adrnr: m.adrnr, name: m.name, austritt: m.austritt } : null, ep3 };
}

/** Mitglied und/oder EP3-Kunde setzen (null = Zuordnung entfernen, undefined = unverändert) */
export async function zuordnungSetzen(tx: Db, benutzerId: string, z: { adrnr?: string | null; zuid?: string | null; rolleMitglied?: boolean }): Promise<string> {
  const texte: string[] = [];
  if (z.adrnr !== undefined) {
    await benutzerZuordnen(tx, benutzerId, z.adrnr);
    texte.push(z.adrnr ? `Mitglied ${z.adrnr} zugeordnet` : 'Mitgliedszuordnung entfernt');
    if (z.adrnr && z.rolleMitglied !== false) {
      // Mitglieder erhalten „Meine Mitgliedschaft“ und Einzelbuchung; Hallennutzer wird dabei ersetzt
      await rolleSicherstellen(tx);
      await tx`delete from core.user_roles where user_id = ${benutzerId} and role_id = ${ROLLE}`;
      const r = await tx`insert into core.user_roles (user_id, role_id) values (${benutzerId}, ${ROLLE_MITGLIED}) on conflict do nothing`;
      if (r.count) texte.push('Rolle Mitglied ergänzt');
      if (await buchungsrechtSichern(tx, benutzerId)) texte.push('Rolle Hallennutzer für Hallenbuchungen ergänzt');
    }
  }
  if (z.zuid !== undefined) {
    const [a] = await tx`select adrnr from tco.mitgliedera where benutzer_id = ${benutzerId}`;
    // bisherige EP3-Zuordnung dieses Benutzers lösen
    await tx`update tco.kunden set benutzer_id = null where benutzer_id = ${benutzerId}`;
    if (z.zuid) {
      const k = await tx`select zuid, benutzer_id::text from tco.kunden where zuid = ${z.zuid}`;
      if (!k.length) throw new BusinessError('EP3-Kunde nicht gefunden.');
      if (k.some((x) => x.benutzer_id && x.benutzer_id !== benutzerId)) throw new BusinessError('Dieser EP3-Kunde ist bereits einem anderen Benutzer zugeordnet.');
      const [anderes] = await tx`select adrnr from tco.mitgliedera where zuid = ${z.zuid} and (${a?.adrnr ?? null}::text is null or adrnr <> ${a?.adrnr ?? null})`;
      if (anderes) throw new BusinessError(`Dieser EP3-Kunde gehört bereits zu Mitglied ${anderes.adrnr}.`);
      if (a) await tx`update tco.mitgliedera set zuid = ${z.zuid} where adrnr = ${a.adrnr}`;
      else await tx`update tco.kunden set benutzer_id = ${benutzerId} where zuid = ${z.zuid}`;
      texte.push(`EP3-Kunde ${z.zuid} zugeordnet${a ? ` (über Mitglied ${a.adrnr})` : ''}`);
    } else {
      if (a) await tx`update tco.mitgliedera set zuid = null where adrnr = ${a.adrnr}`;
      texte.push('EP3-Zuordnung entfernt');
    }
  }
  return texte.length ? `${texte.join(', ')}.` : 'Keine Änderung.';
}

/** Auswahllisten für die Zuordnung (Suche über Name, E-Mail, Nummer/Alias) */
export async function zuordnungSuchen(db: Db, suche: string) {
  const q = `%${condense(suche).toLowerCase()}%`;
  const mitglieder = await db`
    select m.adrnr, trim(coalesce(m.nachname, '') || ', ' || coalesce(m.vorname, '')) as name, m.email, m.mitglnrn, u.username as benutzer
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr left join core.users u on u.id = a.benutzer_id
     where (m.austritt is null or m.austritt >= current_date - 365)
       and lower(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '') || ' ' || coalesce(m.email, '') || ' ' || coalesce(m.mitglnrn, '') || ' ' || m.adrnr) like ${q}
     order by m.nachname, m.vorname limit 40`;
  const kunden = await db`
    select distinct on (k.zuid) k.zuid, k.zalias, trim(coalesce(k.vorname, '') || ' ' || coalesce(k.nachname, '')) as name, k.email,
           coalesce(u.username, mu.username) as benutzer, a.adrnr as mitglied
      from tco.kunden k left join core.users u on u.id = k.benutzer_id
      left join tco.mitgliedera a on a.zuid = k.zuid left join core.users mu on mu.id = a.benutzer_id
     where coalesce(k.status, '') not in ('placeholder', 'deleted')
       and lower(coalesce(k.vorname, '') || ' ' || coalesce(k.nachname, '') || ' ' || coalesce(k.email, '') || ' ' || k.zalias || ' ' || k.zuid) like ${q}
     order by k.zuid, k.zalias limit 40`;
  return { mitglieder, kunden };
}

// ---------------------------------------------------------------------------
// Initiales Mapping
// ---------------------------------------------------------------------------
export interface MappingVorschlag {
  benutzerId: string; username: string; name: string; email: string | null; rollen: string[];
  mitglied: { adrnr: string; name: string; grund: string } | null;
  ep3: { zuid: string; alias: string; name: string; grund: string } | null;
}

export async function mappingVorschlaege(db: Db): Promise<MappingVorschlag[]> {
  const benutzer = await db`
    select u.id::text, u.username, u.display_name, lower(trim(coalesce(u.email, ''))) as email,
           coalesce(array_agg(ur.role_id order by ur.role_id) filter (where ur.role_id is not null), '{}') as rollen,
           exists (select 1 from tco.mitgliedera a where a.benutzer_id = u.id) as hat_mitglied,
           exists (select 1 from tco.kunden k where k.benutzer_id = u.id)
             or exists (select 1 from tco.mitgliedera a where a.benutzer_id = u.id and a.zuid is not null) as hat_ep3
      from core.users u left join core.user_roles ur on ur.user_id = u.id
     where u.active group by u.id order by lower(u.display_name)`;
  const mitglieder = await db`
    select m.adrnr, m.vorname, m.nachname, lower(trim(coalesce(m.email, ''))) as email, a.zuid
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
     where (m.austritt is null or m.austritt >= current_date) and a.benutzer_id is null`;
  const kunden = await db`
    select distinct on (k.zuid) k.zuid, k.zalias, k.vorname, k.nachname, lower(trim(coalesce(k.email, ''))) as email
      from tco.kunden k
     where k.benutzer_id is null and coalesce(k.status, '') not in ('placeholder', 'blocked', 'deleted', 'disabled')
       and not exists (select 1 from tco.mitgliedera a where a.zuid = k.zuid and a.benutzer_id is not null)
     order by k.zuid, k.zalias`;
  const nameVon = (v: string | null, n: string | null) => norm(`${v ?? ''} ${n ?? ''}`);
  const mitgliedNamen = new Map<string, typeof mitglieder>();
  for (const m of mitglieder) { const k = nameVon(m.vorname, m.nachname); mitgliedNamen.set(k, [...(mitgliedNamen.get(k) ?? []), m] as never); }
  const mitgliedMail = new Map<string, typeof mitglieder>();
  for (const m of mitglieder) if (m.email) mitgliedMail.set(m.email, [...(mitgliedMail.get(m.email) ?? []), m] as never);
  const vergeben = new Set<string>();
  const vergebenEp3 = new Set<string>();
  const out: MappingVorschlag[] = [];
  for (const u of benutzer) {
    if (u.hat_mitglied && u.hat_ep3) continue;
    const v: MappingVorschlag = { benutzerId: u.id, username: u.username, name: u.display_name, email: u.email || null, rollen: u.rollen, mitglied: null, ep3: null };
    let mitgliedZuid: string | null = null;
    if (!u.hat_mitglied) {
      // eindeutige Treffer: E-Mail (nicht bei Familienadresse), sonst Name
      const perMail = u.email ? (mitgliedMail.get(u.email) ?? []).filter((m) => !vergeben.has(m.adrnr)) : [];
      let treffer: { m: (typeof mitglieder)[number]; grund: string } | null = null;
      if (perMail.length === 1) treffer = { m: perMail[0], grund: 'gleiche E-Mail' };
      else {
        const kand = [...namen(u.display_name)].flatMap((n) => mitgliedNamen.get(n) ?? []).filter((m) => !vergeben.has(m.adrnr));
        const eindeutig = [...new Map(kand.map((m) => [m.adrnr, m])).values()];
        if (eindeutig.length === 1) treffer = { m: eindeutig[0], grund: perMail.length > 1 ? 'gleicher Name (E-Mail mehrfach)' : 'gleicher Name' };
      }
      if (treffer) {
        vergeben.add(treffer.m.adrnr);
        mitgliedZuid = treffer.m.zuid ?? null;
        v.mitglied = { adrnr: treffer.m.adrnr, name: condense(`${treffer.m.nachname ?? ''}, ${treffer.m.vorname ?? ''}`), grund: treffer.grund };
      }
    }
    if (!u.hat_ep3 && !mitgliedZuid) {
      const un = u.username.toLowerCase();
      const nm = namen(u.display_name);
      if (v.mitglied) nm.add(norm(v.mitglied.name.split(', ').reverse().join(' ')));
      const kand = kunden.filter((k) => !vergebenEp3.has(k.zuid));
      const k = kand.find((x) => u.email && x.email === u.email) ? { k: kand.find((x) => u.email && x.email === u.email)!, grund: 'gleiche E-Mail' }
        : kand.find((x) => x.zalias.toLowerCase() === un) ? { k: kand.find((x) => x.zalias.toLowerCase() === un)!, grund: 'gleicher Benutzername' }
          : (() => { const t = kand.filter((x) => nm.has(nameVon(x.vorname, x.nachname))); return t.length === 1 ? { k: t[0], grund: 'gleicher Name' } : null; })();
      if (k) {
        vergebenEp3.add(k.k.zuid);
        v.ep3 = { zuid: k.k.zuid, alias: k.k.zalias, name: condense(`${k.k.vorname ?? ''} ${k.k.nachname ?? ''}`) || k.k.zalias, grund: k.grund };
      }
    }
    if (v.mitglied || v.ep3) out.push(v);
  }
  return out;
}

export async function mappingUebernehmen(tx: Db, liste: { benutzerId: string; adrnr?: string | null; zuid?: string | null }[], rolleMitglied: boolean) {
  let mitglieder = 0;
  let ep3 = 0;
  for (const e of liste) {
    if (e.adrnr) { await zuordnungSetzen(tx, e.benutzerId, { adrnr: e.adrnr, rolleMitglied }); mitglieder++; }
    if (e.zuid) { await zuordnungSetzen(tx, e.benutzerId, { zuid: e.zuid }); ep3++; }
  }
  return `${mitglieder} Mitglied(er) und ${ep3} EP3-Kunde(n) zugeordnet.`;
}
