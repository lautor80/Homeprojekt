import { BusinessError } from '../../../../server/src/errors.js';
import { hashPassword } from '../../../../server/src/auth.js';
import { maskIban } from '../../../../server/src/schutz.js';
import type { Db, Verein } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { kontaktLesen, mailSenden } from '../kommunikation.js';
import {
  ART_JUGEND, austrittSichern, bankSichern, detailLesen, emailGueltig, kopfSichern, leer, mitgliedLesen, notizAnlegen, vertragAendern, verweis,
} from './logik.js';
import { druckdatenLesen, unterlagePdf } from './pdf.js';
import { mailText, unterlageAblegen } from './dokumente.js';
import { plAktiv } from '../verein.js';
import { kennwortLinkSenden, portalUrl, unbekanntesKennwort } from '../../../../server/src/kennwort.js';
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

/** Mitgliedschaft und normale Verträge enden zum 31.12. des laufenden Jahres */
export const endeJahr = (h = heute()) => `${h.slice(0, 4)}-12-31`;
/** Jugendtraining endet zum nächsten 30.09. */
export function endeJugend(h = heute()): string {
  const jahr = Number(h.slice(0, 4));
  return h <= `${jahr}-09-30` ? `${jahr}-09-30` : `${jahr + 1}-09-30`;
}
const istJugend = (v: { art: string }) => leer(v.art) === ART_JUGEND;
/** Vertragsende bei Kündigung eines einzelnen Vertrags */
/** Mitgliedsbeitrag (kein Training, Schließfach, Spende …): mit dem eigenen Beitrag endet die Mitgliedschaft */
export const istMitgliedsbeitrag = (v: { art: string; artname?: string | null }) =>
  Number(leer(v.art)) < 90 && /mitglied|erwachsene|jugendliche|familie|aktiv|passiv/i.test(v.artname ?? '');
export const vertragsEnde = (v: { art: string }, h = heute()) => (istJugend(v) ? endeJugend(h) : endeJahr(h));

export async function meineLesen(db: Db, benutzerId: string) {
  const adrnr = await eigeneAdrnr(db, benutzerId);
  const d = await detailLesen(db, adrnr);
  const zahltSelbst = !d.bank.adrnrkih;
  return {
    mitglied: d.mitglied, titel: d.titel, trainer: d.trainer, kanal: d.kanal, spieler: d.spieler,
    bank: {
      zahlungsart_txt: d.bank.zahlungsart_txt, zahlungsweise_txt: d.bank.zahlungsweise_txt,
      iban: maskIban(d.bank.iban), bic: d.bank.bic ? `${d.bank.bic.slice(0, 4)}…` : '', bank: d.bank.bank,
      kontoinhaber: d.bank.kontoinhaber, zahler: d.bank.zahler ? d.bank.zahler.name : null, zahltSelbst, lastschrift: d.bank.zahlungsart === 'L',
      mandatsref: d.bank.mandatsref,
    },
    familie: d.familie,
    vertraege: d.vertraege.map((v) => ({ ...v, kuendbar: v.laeuft && !v.vertragende, endeBei: vertragsEnde(v), mitgliedsbeitrag: istMitgliedsbeitrag(v) })),
    // Vertragsbaum mit allen verknüpften Personen; kündbar sind nur eigene Verträge und die von Personen, die über mich zahlen
    vertraegeFamilie: d.vertraegeFamilie.map((v) => ({
      ...v, endeBei: vertragsEnde(v), mitgliedsbeitrag: istMitgliedsbeitrag(v),
      kuendbar: v.laeuft && !v.vertragende && d.vertraege.some((x) => x.adrnr === v.adrnr && x.vertragnr === v.vertragnr),
    })),
    kuendigung: { mitgliedschaft: endeJahr(), jugend: endeJugend(), heute: heute() },
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

export interface Kuendigung { art: 'MITGLIEDSCHAFT' | 'VERTRAG'; adrnr?: string | null; vertragnr?: string | null; grund?: string | null }

/**
 * Kündigung durch das Mitglied selbst. Kündigungsdatum = heute; Mitgliedschaft und Verträge enden zum 31.12. des laufenden
 * Jahres, Jugendtraining zum nächsten 30.09. (bei Kündigung der Mitgliedschaft spätestens zum Austritt).
 * Verträge auch für Personen, die über das Mitglied zahlen. Anschließend Kündigungsbestätigung (PDF) erzeugen, in der
 * Mitgliederakte ablegen (Paperless) und per E-Mail (n8n) an das Mitglied senden; der Vorstand erhält eine Kopie.
 */
export async function kuendigen(tx: Db, benutzerId: string, k: Kuendigung, v: Verein, benutzer: string): Promise<{ text: string; adrnr: string; betroffen: string; ende: string }> {
  const eigene = await eigeneAdrnr(tx, benutzerId);
  const h = heute();
  const d = await detailLesen(tx, eigene);
  let text: string;
  let betroffen = eigene;
  let ende: string;
  if (k.art === 'MITGLIEDSCHAFT') {
    if (d.mitglied.austritt) throw new BusinessError(`Die Mitgliedschaft ist bereits zum ${dat(d.mitglied.austritt)} gekündigt.`);
    ende = endeJahr(h);
    await austrittSichern(tx, eigene, ende);
    const teile: string[] = [];
    for (const vt of d.vertraege) {
      if (!vt.eigen || !vt.laeuft) continue;
      const bis = istJugend(vt) && endeJugend(h) < ende ? endeJugend(h) : ende;
      if (!vt.vertragende || vt.vertragende > bis) { await vertragAendern(tx, vt.adrnr, vt.vertragnr, { ende: bis }); teile.push(`${vt.artname || vt.art} bis ${dat(bis)}`); }
    }
    text = `Mitgliedschaft gekündigt am ${dat(h)} zum ${dat(ende)}${teile.length ? ` (${teile.join(', ')})` : ''}.`;
  } else {
    const vt = d.vertraege.find((x) => x.vertragnr === leer(k.vertragnr) && x.adrnr === leer(k.adrnr ?? eigene));
    if (!vt) throw new BusinessError('Der Vertrag gehört nicht zu Ihrer Mitgliedschaft.');
    if (!vt.laeuft) throw new BusinessError('Der Vertrag ist bereits beendet.');
    ende = vertragsEnde(vt, h);
    if (vt.vertragende && vt.vertragende <= ende) throw new BusinessError(`Der Vertrag endet bereits am ${dat(vt.vertragende)}.`);
    await vertragAendern(tx, vt.adrnr, vt.vertragnr, { ende });
    betroffen = vt.adrnr;
    text = `${vt.artname || 'Vertrag'}${vt.eigen ? '' : ` (${vt.person})`} gekündigt am ${dat(h)} zum ${dat(ende)}.`;
  }
  const grund = condense(k.grund ?? '');
  await notizAnlegen(tx, betroffen, `Kündigung über „Meine Mitgliedschaft“ durch ${benutzer}: ${text}${grund ? ` Grund: ${grund}` : ''}`, 'Portal');
  return { text, adrnr: eigene, betroffen, ende };
}

/**
 * Mehrere Verträge in einem Schritt kündigen (Dialog „Kündigen“ mit Mehrfachauswahl). Ist der eigene Mitgliedsbeitrag dabei,
 * endet die Mitgliedschaft (Austritt, alle eigenen Verträge enden); Verträge anderer Personen werden einzeln beendet.
 */
export async function kuendigenMehrere(tx: Db, benutzerId: string, liste: { adrnr: string; vertragnr: string }[], grund: string | null, v: Verein, benutzer: string) {
  const eigene = await eigeneAdrnr(tx, benutzerId);
  const d = await detailLesen(tx, eigene);
  const wahl = [...new Map(liste.map((x) => [`${leer(x.adrnr)}|${leer(x.vertragnr)}`, x])).values()].map((x) => {
    const vt = d.vertraege.find((y) => y.adrnr === leer(x.adrnr) && y.vertragnr === leer(x.vertragnr));
    if (!vt) throw new BusinessError('Ein gewählter Vertrag gehört nicht zu Ihrer Mitgliedschaft.');
    if (!vt.laeuft || vt.vertragende) throw new BusinessError(`${vt.artname || 'Der Vertrag'} ist bereits beendet oder gekündigt.`);
    return vt;
  });
  const austritt = !d.mitglied.austritt && wahl.some((vt) => vt.eigen && istMitgliedsbeitrag(vt));
  const ergebnisse: Awaited<ReturnType<typeof kuendigen>>[] = [];
  if (austritt) ergebnisse.push(await kuendigen(tx, benutzerId, { art: 'MITGLIEDSCHAFT', grund }, v, benutzer));
  for (const vt of wahl) {
    if (austritt && vt.eigen) continue; // endet mit der Mitgliedschaft
    ergebnisse.push(await kuendigen(tx, benutzerId, { art: 'VERTRAG', adrnr: vt.adrnr, vertragnr: vt.vertragnr, grund }, v, benutzer));
  }
  const personen = new Set(ergebnisse.map((r) => r.betroffen));
  return {
    text: ergebnisse.map((r) => r.text).join(' '), adrnr: eigene, betroffen: personen.size === 1 ? [...personen][0] : eigene,
    ende: ergebnisse.map((r) => r.ende).sort().at(-1)!,
  };
}

/** Kündigungsbestätigung drucken, ablegen und versenden (nach der Transaktion; Fehler werden als Hinweise zurückgegeben) */
export async function kuendigungBestaetigen(db: Db, v: Verein, r: { adrnr: string; betroffen: string; text: string }, grund: string | null) {
  const hinweise: string[] = [];
  const d = await druckdatenLesen(db, r.betroffen);
  const pdf = await unterlagePdf(v, '4', d);
  const dateiname = `Kuendigungsbestaetigung_${leer(d.m.nachname)}_${leer(d.m.vorname)}.pdf`;
  if (plAktiv(v)) {
    await unterlageAblegen(v, '4', d.m, pdf, 'Portal').then((a) => hinweise.push(...a.warnungen)).catch((e) => hinweise.push(`Ablage in Paperless nicht möglich: ${(e as Error).message}`));
  } else hinweise.push('Paperless ist nicht eingerichtet – die Bestätigung wurde nicht abgelegt.');
  const k = await kontaktLesen(db, r.adrnr);
  let gesendet = false;
  if (!v.n8n_mail_url) hinweise.push('Der Mailversand ist nicht eingerichtet – bitte die Bestätigung herunterladen.');
  else if (!k?.email) hinweise.push('Keine E-Mail-Adresse hinterlegt – bitte die Bestätigung herunterladen.');
  else {
    const { betreff, text } = mailText(v, '4', k.vorname, []);
    await mailSenden(v, {
      modus: 'senden', anwendung: 'Mitglieder', objekt: r.betroffen, an: k.email, cc: v.email ?? '', betreff,
      text: `${text}\n\n---\n${r.text}${grund ? `\nGrund: ${grund}` : ''}`, benutzer: 'Portal',
      anhaenge: [{ dateiname, mime: 'application/pdf', inhalt: pdf }],
    }).then(() => { gesendet = true; }).catch((e) => hinweise.push(`E-Mail nicht gesendet: ${(e as Error).message}`));
  }
  return { pdf: pdf.toString('base64'), dateiname, gesendet, hinweise };
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
export async function mitgliederBenutzerAnlegen(tx: Db, v: Verein, o: { mail: boolean; adrnr?: string }): Promise<{ angelegt: AngelegterBenutzer[]; hochgestuft: number; gesendet: number; uebersprungen: string[] }> {
  await rolleSicherstellen(tx);
  const mitglieder = await tx`
    select m.adrnr, m.vorname, m.nachname, lower(trim(coalesce(m.email, ''))) as email, a.zuid
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
     where m.eintritt is not null and (m.austritt is null or m.austritt >= current_date) and a.benutzer_id is null
       ${o.adrnr ? tx`and m.adrnr = ${o.adrnr}` : tx``}
     order by m.nachname, m.vorname, m.adrnr`;
  if (o.adrnr && !mitglieder.length) throw new BusinessError('Das Mitglied ist ausgetreten oder hat bereits einen Benutzer.');
  const r = { angelegt: [] as AngelegterBenutzer[], hochgestuft: 0, gesendet: 0, uebersprungen: [] as string[] };
  const { randomBytes } = await import('node:crypto');
  // E-Mail-Adressen, die mehrere Mitglieder teilen (Familien): Anmeldename dann vorname.nachname
  const mehrfach = new Set<string>();
  { const seen = new Set<string>(); for (const m of mitglieder) { if (!m.email) continue; if (seen.has(m.email)) mehrfach.add(m.email); seen.add(m.email); } }
  if (o.adrnr && mitglieder[0]?.email) {
    // Einzelanlage: gemeinsame Familienadresse auch gegen den Bestand prüfen
    const [x] = await tx`select count(*)::int as n from tco.mitglieder where lower(trim(coalesce(email, ''))) = ${mitglieder[0].email} and adrnr <> ${o.adrnr}
                          and (austritt is null or austritt >= current_date)`;
    if (x.n) mehrfach.add(mitglieder[0].email);
  }
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
    // Einmal-Link statt Startkennwort, wenn per E-Mail benachrichtigt wird und die Portal-Adresse bekannt ist
    const link = !(k && istBcrypt(k.pw_hash)) && o.mail && !!v.n8n_mail_url && !!m.email && !!(await portalUrl());
    if (k && istBcrypt(k.pw_hash)) hash = k.pw_hash;
    else if (link) hash = await unbekanntesKennwort();
    else { start = randomBytes(9).toString('base64url'); hash = await hashPassword(start); }
    try {
      const uid = await benutzerAnlegen(tx, { username, displayName: name, email: m.email || null, passwortHash: hash, mussAendern: !!start, rolle: ROLLE_MITGLIED });
      await tx`insert into tco.mitgliedera (adrnr, benutzer_id, zuid) values (${m.adrnr}, ${uid}, ${k?.zuid ?? null})
               on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id, zuid = coalesce(tco.mitgliedera.zuid, excluded.zuid)`;
      let hinweis = start ? 'Startkennwort' : 'EP3-Kennwort gilt weiter';
      if (link) {
        try {
          await kennwortLinkSenden(tx, uid, 'SETZEN', null, v.name);
          hinweis = 'Link zum Festlegen des Kennworts per E-Mail gesendet';
          r.gesendet++;
        } catch (e) {
          // Versand fehlgeschlagen: Startkennwort als Rückfall
          start = randomBytes(9).toString('base64url');
          await tx`update core.users set password_hash = ${await hashPassword(start)}, must_change_password = true where id = ${uid}`;
          hinweis = `E-Mail fehlgeschlagen (${(e as Error).message}) – Startkennwort unten`;
        }
      } else if (start && o.mail && v.n8n_mail_url && m.email) {
        try {
          await mailSenden(v, {
            modus: 'senden', anwendung: 'Mitglieder', objekt: m.adrnr, an: m.email, benutzer: 'Portal', anhaenge: [],
            wiederholung: { art: 'NEU_AUSLOESEN', hinweis: 'Enthält ein Startkennwort – bitte unter Administration → Benutzer einen Kennwort-Link senden.' },
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

// ---------------------------------------------------------------------------
// Einzelanlage: Kandidaten (Mitglieder und EP3-Kunden ohne Benutzer)
// ---------------------------------------------------------------------------
export async function benutzerKandidaten(db: Db, suche: string) {
  const q = `%${condense(suche).toLowerCase()}%`;
  const mitglieder = await db`
    select m.adrnr as schluessel, trim(coalesce(m.nachname, '') || ', ' || coalesce(m.vorname, '')) as name, m.email, m.mitglnrn,
           m.austritt::text as austritt
      from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
     where m.eintritt is not null and (m.austritt is null or m.austritt >= current_date) and a.benutzer_id is null
       and (lower(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '') || ' ' || coalesce(m.email, '') || ' ' || coalesce(m.mitglnrn, '')) like ${q})
     order by m.nachname, m.vorname limit 30`;
  const kunden = await db`
    select distinct on (k.zuid) k.zuid as schluessel, nullif(trim(coalesce(k.nachname, '') || ', ' || coalesce(k.vorname, '')), ',') as name, k.zalias, k.email,
           k.pw_hash is not null as kennwort
      from tco.kunden k
     where k.benutzer_id is null and coalesce(k.status, '') not in ('placeholder', 'blocked', 'deleted', 'disabled')
       and not exists (select 1 from tco.mitgliedera a where a.zuid = k.zuid and a.benutzer_id is not null)
       and lower(coalesce(k.vorname, '') || ' ' || coalesce(k.nachname, '') || ' ' || coalesce(k.email, '') || ' ' || k.zalias) like ${q}
     order by k.zuid, k.zalias limit 30`;
  return [
    ...mitglieder.map((m) => ({ art: 'MITGLIED' as const, schluessel: m.schluessel, name: m.name, info: `Mitglied ${m.mitglnrn || m.schluessel}${m.email ? ` · ${m.email}` : ''}${m.austritt ? ` · Austritt ${dat(m.austritt)}` : ''}` })),
    ...kunden.map((k) => ({ art: 'EP3' as const, schluessel: k.schluessel, name: k.name || k.zalias, info: `EP3 „${k.zalias}“${k.email ? ` · ${k.email}` : ''}${k.kennwort ? ' · EP3-Kennwort vorhanden' : ''}` })),
  ];
}

// ---------------------------------------------------------------------------
// Austritt → Benutzer sperren
// ---------------------------------------------------------------------------
/**
 * Benutzer von Mitgliedern, deren Austritt erreicht ist, sperren (Sitzungen beenden). Ausgenommen: Benutzer mit weiteren
 * Rollen außer MITGLIED/HALLENNUTZER (z. B. Vorstand) – dort wird nur die Rolle MITGLIED entzogen.
 * adrnr = nur dieses Mitglied (direkt nach Kündigung/Austritt), sonst alle (täglicher Lauf).
 */
export async function ausgetreteneSperren(tx: Db, adrnr?: string): Promise<{ gesperrt: string[]; rolleEntzogen: string[] }> {
  const rows = await tx`
    select u.id, u.username,
           exists (select 1 from core.user_roles ur where ur.user_id = u.id and ur.role_id not in (${ROLLE_MITGLIED}, ${ROLLE})) as weitere
      from tco.mitglieder m join tco.mitgliedera a on a.adrnr = m.adrnr join core.users u on u.id = a.benutzer_id
     where m.austritt is not null and m.austritt < current_date and u.active
       ${adrnr ? tx`and m.adrnr = ${adrnr}` : tx``}`;
  const r = { gesperrt: [] as string[], rolleEntzogen: [] as string[] };
  for (const u of rows) {
    if (u.weitere) {
      const x = await tx`delete from core.user_roles where user_id = ${u.id} and role_id = ${ROLLE_MITGLIED}`;
      if (x.count) r.rolleEntzogen.push(u.username);
      continue;
    }
    await tx`update core.users set active = false where id = ${u.id}`;
    await tx`delete from core.sessions where user_id = ${u.id}`;
    r.gesperrt.push(u.username);
  }
  return r;
}
