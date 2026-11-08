import { BusinessError } from '../../../../server/src/errors.js';
import { hashPassword } from '../../../../server/src/auth.js';
import { maskIban } from '../../../../server/src/schutz.js';
import type { Db, Verein } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { mailSenden } from '../kommunikation.js';
import {
  austrittSichern, bankSichern, detailLesen, emailGueltig, kopfSichern, leer, mitgliedLesen, notizAnlegen, vertragAendern, verweis,
} from './logik.js';
import { benutzerAnlegen, freierBenutzername, istBcrypt, rolleSicherstellen, ROLLE, ROLLE_MITGLIED } from '../platz/registrierung.js';

/**
 * „Meine Mitgliedschaft“ – Selbstauskunft und -pflege für Mitglieder (Berechtigung tco.meinedaten:edit).
 *
 * Das Mitglied ergibt sich AUSSCHLIESSLICH aus dem angemeldeten Benutzer (tco.mitgliedera.benutzer_id).
 * Änderbar: Anschrift, Telefon, Mobil, E-Mail, Bildrechte; eigene Bankverbindung (nur wenn das Mitglied selbst zahlt).
 * Kündigung: Mitgliedschaft (Austritt) oder einzelne Verträge – auch für Personen, die über das Mitglied zahlen –
 * jeweils zum Jahresende; Vorstand wird per Notiz und (wenn eingerichtet) E-Mail informiert.
 * Name, Geburtsdatum, Eintritt und Zahler ändert weiterhin nur die Mitgliederverwaltung.
 */
export const P_SELBST = 'tco.meinedaten:edit';

export async function eigeneAdrnr(db: Db, benutzerId: string): Promise<string> {
  const [a] = await db`select adrnr from tco.mitgliedera where benutzer_id = ${benutzerId}`;
  if (!a) throw new BusinessError('Ihr Benutzer ist keinem Mitglied zugeordnet. Bitte beim Vorstand melden.', 403);
  return a.adrnr as string;
}

/** mögliche Kündigungstermine: Jahresende des laufenden und des folgenden Jahres */
export function kuendigungsTermine(h = heute()): string[] {
  const jahr = Number(h.slice(0, 4));
  return [`${jahr}-12-31`, `${jahr + 1}-12-31`];
}

export async function meineLesen(db: Db, benutzerId: string) {
  const adrnr = await eigeneAdrnr(db, benutzerId);
  const d = await detailLesen(db, adrnr);
  const zahltSelbst = !d.bank.adrnrkih;
  return {
    mitglied: d.mitglied, titel: d.titel, trainer: d.trainer, kanal: d.kanal,
    bank: {
      zahlungsart_txt: d.bank.zahlungsart_txt, zahlungsweise_txt: d.bank.zahlungsweise_txt,
      iban: maskIban(d.bank.iban), bic: d.bank.bic ? `${d.bank.bic.slice(0, 4)}…` : '', bank: d.bank.bank,
      kontoinhaber: d.bank.kontoinhaber, zahler: d.bank.zahler ? d.bank.zahler.name : null, zahltSelbst, lastschrift: d.bank.zahlungsart === 'L',
      mandatsref: d.bank.mandatsref,
    },
    familie: d.familie,
    vertraege: d.vertraege.map((v) => ({ ...v, kuendbar: v.laeuft && (v.eigen || true) })),
    kuendigungsTermine: kuendigungsTermine(),
    gekuendigt: !!d.mitglied.austritt,
  };
}

export interface Kontakt { strasse: string; plz: string; ort: string; telefon: string; mobil: string; email: string; bildrechte: boolean }

export async function kontaktSichern(tx: Db, benutzerId: string, k: Kontakt): Promise<string> {
  const adrnr = await eigeneAdrnr(tx, benutzerId);
  const m = await mitgliedLesen(tx, adrnr);
  if (!emailGueltig(k.email.trim())) throw new BusinessError('Die E-Mail-Adresse ist ungültig.');
  if (!condense(k.strasse) || !condense(k.plz) || !condense(k.ort)) throw new BusinessError('Bitte Straße, PLZ und Ort angeben.');
  await kopfSichern(tx, adrnr, {
    anrede: leer(m.anrede), vorname: leer(m.vorname), nachname: leer(m.nachname), geburtsdatum: m.geburtsdatum, eintritt: m.eintritt,
    datenschutz: leer(m.checkbox1) === 'J',
    strasse: k.strasse, plz: k.plz, ort: k.ort, telefon: k.telefon, mobil: k.mobil, email: k.email, bildrechte: k.bildrechte,
  });
  // E-Mail auch am Benutzer nachziehen (Anmeldung per E-Mail)
  if (k.email.trim()) await tx`update core.users set email = ${k.email.trim()} where id = ${benutzerId}`;
  return 'Kontaktdaten gesichert.';
}

export async function bankAendern(tx: Db, benutzerId: string, b: { iban: string; bic: string; bank: string }): Promise<string> {
  const adrnr = await eigeneAdrnr(tx, benutzerId);
  const m = await mitgliedLesen(tx, adrnr);
  if (verweis(m.adrnrkih)) throw new BusinessError('Ihre Beiträge werden über eine andere Person eingezogen. Änderungen der Bankverbindung bitte über den Vorstand.');
  if (leer(m.zahlungsart) !== 'L') throw new BusinessError('Eine Bankverbindung wird nur bei Lastschrift geführt. Für die Umstellung bitte an den Vorstand wenden.');
  await bankSichern(tx, adrnr, { zahlungsart: 'L', zahlungsweise: leer(m.zahlungsweise), iban: b.iban, bic: b.bic, bank: b.bank, abwkontoinh: leer(m.abwkontoinh), adrnrkih: '' });
  await notizAnlegen(tx, adrnr, `Bankverbindung über „Meine Mitgliedschaft“ geändert (neue IBAN ${maskIban(b.iban.replace(/\s+/g, ''))}).`, 'Portal');
  return 'Bankverbindung gesichert. Der Einzug erfolgt ab der nächsten Sollstellung vom neuen Konto.';
}

export interface Kuendigung { art: 'MITGLIEDSCHAFT' | 'VERTRAG'; adrnr?: string | null; vertragnr?: string | null; zum: string; grund?: string | null }

/** Kündigung durch das Mitglied selbst; Verträge auch für Personen, die über das Mitglied zahlen */
export async function kuendigen(tx: Db, benutzerId: string, k: Kuendigung, v: Verein, benutzer: string): Promise<string> {
  const eigene = await eigeneAdrnr(tx, benutzerId);
  if (!kuendigungsTermine().includes(k.zum)) throw new BusinessError('Eine Kündigung ist nur zum Jahresende möglich.');
  const d = await detailLesen(tx, eigene);
  let text: string;
  let betroffen = eigene;
  if (k.art === 'MITGLIEDSCHAFT') {
    if (d.mitglied.austritt) throw new BusinessError(`Die Mitgliedschaft ist bereits zum ${dat(d.mitglied.austritt)} gekündigt.`);
    await austrittSichern(tx, eigene, k.zum);
    for (const vt of d.vertraege) {
      if (vt.eigen && vt.laeuft && (!vt.vertragende || vt.vertragende > k.zum)) await vertragAendern(tx, vt.adrnr, vt.vertragnr, { ende: k.zum });
    }
    text = `Mitgliedschaft zum ${dat(k.zum)} gekündigt.`;
  } else {
    const vt = d.vertraege.find((x) => x.vertragnr === leer(k.vertragnr) && x.adrnr === leer(k.adrnr ?? eigene));
    if (!vt) throw new BusinessError('Der Vertrag gehört nicht zu Ihrer Mitgliedschaft.');
    if (!vt.laeuft) throw new BusinessError('Der Vertrag ist bereits beendet.');
    if (vt.vertragende && vt.vertragende <= k.zum) throw new BusinessError(`Der Vertrag endet bereits am ${dat(vt.vertragende)}.`);
    await vertragAendern(tx, vt.adrnr, vt.vertragnr, { ende: k.zum });
    betroffen = vt.adrnr;
    text = `${vt.artname || 'Vertrag'}${vt.eigen ? '' : ` (${vt.person})`} zum ${dat(k.zum)} gekündigt.`;
  }
  const grund = condense(k.grund ?? '');
  await notizAnlegen(tx, betroffen, `Kündigung über „Meine Mitgliedschaft“ durch ${benutzer}: ${text}${grund ? ` Grund: ${grund}` : ''}`, 'Portal');
  // Vorstand informieren (nicht kritisch)
  if (v.n8n_mail_url && v.email) {
    mailSenden(v, {
      modus: 'senden', anwendung: 'Mitglieder', objekt: betroffen, an: v.email, benutzer: 'Portal', anhaenge: [],
      betreff: `Kündigung über das Portal: ${d.titel}`,
      text: `${d.titel} (${eigene}) hat über „Meine Mitgliedschaft“ gekündigt:\n\n${text}${grund ? `\nGrund: ${grund}` : ''}\n\nDie Daten wurden bereits im Mitgliederstamm hinterlegt (Austritt/Vertragsende, SEPA-Mandat befristet).`,
    }).catch(() => undefined);
  }
  return `${text} Der Vorstand wurde informiert.`;
}

// ---------------------------------------------------------------------------
// Administration → Benutzer: alle aktiven Mitglieder als Benutzer anlegen
// ---------------------------------------------------------------------------
export interface AngelegterBenutzer { adrnr: string; name: string; username: string; email: string | null; startkennwort: string | null; hinweis: string }

/**
 * Für jedes aktive Mitglied ohne Benutzer: Benutzer mit Rolle MITGLIED (Anmeldename = E-Mail, sonst vorname.nachname,
 * Anzeigename „Nachname, Vorname“). Hat ein verknüpfter EP3-Kunde bereits einen Portalbenutzer, wird dieser dem Mitglied
 * zugeordnet und von Hallennutzer auf Mitglied hochgestuft; ein importiertes EP3-Kennwort gilt weiter.
 * Ohne Kennwort entsteht ein Startkennwort (Pflichtänderung); es wird per E-Mail gesendet (wenn eingerichtet) oder zurückgegeben.
 */
export async function mitgliederBenutzerAnlegen(tx: Db, v: Verein, o: { mail: boolean }): Promise<{ angelegt: AngelegterBenutzer[]; hochgestuft: number; gesendet: number; uebersprungen: string[] }> {
  await rolleSicherstellen(tx);
  const mitglieder = await tx`
    select m.adrnr, m.vorname, m.nachname, lower(trim(coalesce(m.email, ''))) as email, a.zuid
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
     where m.eintritt is not null and (m.austritt is null or m.austritt >= current_date) and a.benutzer_id is null
     order by m.nachname, m.vorname, m.adrnr`;
  const r = { angelegt: [] as AngelegterBenutzer[], hochgestuft: 0, gesendet: 0, uebersprungen: [] as string[] };
  const { randomBytes } = await import('node:crypto');
  // E-Mail-Adressen, die mehrere Mitglieder teilen (Familien): Anmeldename dann vorname.nachname
  const mehrfach = new Set<string>();
  { const seen = new Set<string>(); for (const m of mitglieder) { if (!m.email) continue; if (seen.has(m.email)) mehrfach.add(m.email); seen.add(m.email); } }
  for (const m of mitglieder) {
    const name = condense(`${leer(m.nachname)}, ${leer(m.vorname)}`).replace(/^, |, $/g, '');
    const voll = condense(`${leer(m.vorname)} ${leer(m.nachname)}`).toUpperCase();
    // EP3-Kunde mit Portalbenutzer (gleiche ZUID, E-Mail oder Name)?
    const [k] = await tx`
      select k.zuid, k.benutzer_id::text, k.pw_hash from tco.kunden k
       where (k.zuid = ${m.zuid ?? '§'} or (${m.email} <> '' and lower(trim(coalesce(k.email, ''))) = ${m.email})
              or upper(trim(coalesce(k.vorname, '') || ' ' || coalesce(k.nachname, ''))) = ${voll || '§'})
         and coalesce(k.status, '') not in ('placeholder', 'blocked', 'deleted', 'disabled')
       order by (k.zuid = ${m.zuid ?? '§'}) desc, (k.benutzer_id is not null) desc, (k.pw_hash is not null) desc, k.zuid desc limit 1`;
    if (k?.benutzer_id) {
      // vorhandener Hallennutzer wird zum Mitglied
      const [bereits] = await tx`select adrnr from tco.mitgliedera where benutzer_id = ${k.benutzer_id}`;
      if (bereits) { r.uebersprungen.push(`${name}: EP3-Benutzer gehört bereits zu Mitglied ${bereits.adrnr}`); continue; }
      await tx`insert into tco.mitgliedera (adrnr, benutzer_id, zuid) values (${m.adrnr}, ${k.benutzer_id}, ${k.zuid})
               on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id, zuid = coalesce(tco.mitgliedera.zuid, excluded.zuid)`;
      await tx`update tco.kunden set benutzer_id = null where zuid = ${k.zuid}`;
      await tx`update core.user_roles set role_id = ${ROLLE_MITGLIED} where user_id = ${k.benutzer_id} and role_id = ${ROLLE}`;
      r.hochgestuft++;
      continue;
    }
    const alias = (m.email && !mehrfach.has(m.email) ? '' : condense(`${leer(m.vorname)}.${leer(m.nachname)}`).toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9._-]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, ''));
    const username = await freierBenutzername(tx, m.email && !mehrfach.has(m.email) ? m.email : null, alias || `mitglied.${m.adrnr}`, `m${m.adrnr}`);
    let hash: string;
    let start: string | null = null;
    if (k && istBcrypt(k.pw_hash)) hash = k.pw_hash;
    else { start = randomBytes(9).toString('base64url'); hash = await hashPassword(start); }
    try {
      const uid = await benutzerAnlegen(tx, { username, displayName: name, email: m.email || null, passwortHash: hash, mussAendern: !!start, rolle: ROLLE_MITGLIED });
      await tx`insert into tco.mitgliedera (adrnr, benutzer_id, zuid) values (${m.adrnr}, ${uid}, ${k?.zuid ?? null})
               on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id, zuid = coalesce(tco.mitgliedera.zuid, excluded.zuid)`;
      let hinweis = start ? 'Startkennwort' : 'EP3-Kennwort gilt weiter';
      if (start && o.mail && v.n8n_mail_url && m.email) {
        try {
          await mailSenden(v, {
            modus: 'senden', anwendung: 'Mitglieder', objekt: m.adrnr, an: m.email, benutzer: 'Portal', anhaenge: [],
            betreff: `${v.name}: Ihr Zugang zum Mitgliederportal`,
            text: `Guten Tag ${leer(m.vorname)} ${leer(m.nachname)},\n\nfür Sie wurde ein Zugang zum Mitgliederportal angelegt.\n\nAnmeldename: ${username}\nStartkennwort: ${start}\n\nBitte melden Sie sich an und vergeben Sie ein eigenes Kennwort. Unter „Meine Mitgliedschaft“ sehen und pflegen Sie Ihre Daten, unter „Platz buchen“ reservieren Sie Hallen- und Freiplätze.\n\nViele Grüße\n${v.name}`,
          });
          hinweis = 'Startkennwort per E-Mail gesendet';
          start = null;
          r.gesendet++;
        } catch (e) { hinweis = `E-Mail fehlgeschlagen (${(e as Error).message}) – Startkennwort unten`; }
      }
      r.angelegt.push({ adrnr: m.adrnr, name, username, email: m.email || null, startkennwort: start, hinweis });
    } catch (e) {
      if (e instanceof BusinessError && e.statusCode === 409) { r.uebersprungen.push(`${name}: ${e.message}`); continue; }
      throw e;
    }
  }
  return r;
}
