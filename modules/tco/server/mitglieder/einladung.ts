import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { BusinessError } from '../../../../server/src/errors.js';
import { hashPassword, sha256, validatePassword } from '../../../../server/src/auth.js';
import { portalUrl } from '../../../../server/src/kennwort.js';
import type { Db, Verein } from '../verein.js';
import { condense, dat, heute } from '../format.js';

const t = (x: unknown) => condense(String(x ?? ''));
import { mailSenden, type Wiederholung } from '../kommunikation.js';
import { C, kuerzen, LEFT } from '../pdf/layout.js';
import { Brief } from './pdf.js';
import { benutzerAnlegen, freierBenutzername, ROLLE_MITGLIED } from '../platz/registrierung.js';

/**
 * Einladung zum Vereinsportal (#10): persönlicher Link mit QR-Code für aktive Mitglieder ohne Benutzer.
 *  - Sammellauf (Administration → Benutzer und Rechte → Benutzer): per E-Mail (Link + QR-Code als Bild) oder als Brief (PDF, ein Blatt je Mitglied)
 *  - Schnellweg bei der Registrierung: E-Mail + Geburtsdatum passen zu genau einem Mitglied → Link an dessen hinterlegte E-Mail
 * Einlösen (öffentliche Seite /einladung): Benutzername und Kennwort wählen → sofort Benutzer mit Rolle MITGLIED, verknüpft
 * mit dem Mitglied. Der Link gilt einmal; gespeichert ist nur der Hash.
 */
export type Weg = 'MAIL' | 'BRIEF' | 'REGISTRIERUNG';

const aktivOhneBenutzer = (db: Db) => db`
  m.eintritt is not null and (m.austritt is null or m.austritt >= current_date)
  and not exists (select 1 from tco.mitgliedera a where a.adrnr = m.adrnr and a.benutzer_id is not null)`;

export async function kandidaten(db: Db) {
  return db`
    select m.adrnr, m.mitglnrn, m.vorname, m.nachname, nullif(trim(coalesce(m.email, '')), '') as email,
           m.strasse, m.plz, m.ort,
           (select to_char(e.erstellt at time zone 'Europe/Berlin', 'YYYY-MM-DD') from tco.einladungen e where e.adrnr = m.adrnr order by e.erstellt desc limit 1) as eingeladen_am,
           (select e.weg from tco.einladungen e where e.adrnr = m.adrnr order by e.erstellt desc limit 1) as eingeladen_per
      from tco.mitglieder m
     where ${aktivOhneBenutzer(db)}
     order by m.nachname, m.vorname`;
}

export async function einladungErzeugen(tx: Db, adrnr: string, weg: Weg, wer: string, stunden: number): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  // ältere, nicht eingelöste Einladungen verfallen
  await tx`update tco.einladungen set gueltig_bis = least(gueltig_bis, now()) where adrnr = ${adrnr} and verwendet_am is null`;
  await tx`insert into tco.einladungen (adrnr, token_hash, weg, gueltig_bis, erstellt_von)
           values (${adrnr}, ${sha256(token)}, ${weg}, ${new Date(Date.now() + stunden * 3600_000)}, ${wer})`;
  return token;
}

export const einladungsLink = (url: string, token: string) => `${url}/einladung?token=${token}`;

async function urlPflicht(): Promise<string> {
  const url = await portalUrl();
  if (!url) throw new BusinessError('Für Einladungen fehlt die Portal-Adresse (Administration → Einstellungen).');
  return url;
}

/** Platzhalter der Einladungsmail (Sammellauf): Betreff und Text lassen sich vor dem Versand anpassen (#105) */
export const EINLADUNG_PLATZHALTER = ['{Vorname}', '{Name}', '{Link}', '{GueltigBis}'];
export interface MailVorlage { betreff: string; text: string }
/** Vorschlag für den Sammellauf – entspricht dem festen Text, mit Platzhaltern statt der Werte */
export function einladungVorlage(v: Verein): MailVorlage {
  return mailText(v, { vorname: '{Vorname}' }, '{Link}', '{GueltigBis}');
}
const fuellen = (s: string, m: Record<string, any>, link: string, bis: string) => s.replace(/\{(Vorname|Name|Link|GueltigBis)\}/g, (_, k: string) =>
  (k === 'Vorname' ? t(m.vorname) : k === 'Name' ? t(`${m.vorname ?? ''} ${m.nachname ?? ''}`) : k === 'Link' ? link : bis));

function mailText(v: Verein, m: Record<string, any>, link: string, bis: string, vorlage?: MailVorlage | null) {
  if (vorlage) return { betreff: fuellen(vorlage.betreff, m, link, bis), text: fuellen(vorlage.text, m, link, bis) };
  return {
    betreff: `${v.name}: Ihr Zugang zum Vereinsportal`,
    text: `Hallo ${t(m.vorname)},\n\nim Vereinsportal des ${v.name} sehen und pflegen Sie Ihre Mitgliedsdaten, buchen Hallen- und Freiplätze, `
      + 'melden sich zu Veranstaltungen an und erfassen Ihren Clubhaus-Verzehr.\n\n'
      + `Ihr persönlicher Zugang ist vorbereitet. Über diesen Link (oder den QR-Code im Anhang) wählen Sie Benutzername und Kennwort – fertig:\n\n${link}\n\n`
      + `Der Link gilt bis ${bis} und nur für Sie. Bitte nicht weitergeben.\n\nViele Grüße\n${v.ansprechpartner || v.name}`,
  };
}

/** Briefe (ein Blatt je Mitglied) mit QR-Code im Vereinslayout */
async function briefe(v: Verein, liste: { m: Record<string, any>; link: string; bis: string }[]): Promise<Buffer> {
  const b = new Brief(v, 'Einladung zum Vereinsportal');
  const p = b.p;
  liste.forEach(({ m, link, bis }, i) => {
    if (i) p.newPage();
    const mnr = t(m.mitglnrn);
    b.kopfband('EINLADUNG ZUM VEREINSPORTAL', mnr ? `Mitglied Nr. ${mnr} · ${dat(heute())}` : dat(heute()));
    const name = t(`${m.anrede ?? ''} ${m.vorname ?? ''} ${m.nachname ?? ''}`);
    p.text(LEFT, 58, 'AN', { size: 7, color: C.grau });
    p.text(LEFT, 63, kuerzen(p, name, 9.5, 80), { size: 9.5, bold: true, color: C.ink });
    p.text(LEFT, 67.5, kuerzen(p, t(m.strasse), 9, 80), { size: 9, color: C.ink });
    p.text(LEFT, 72, kuerzen(p, t(`${m.plz ?? ''} ${m.ort ?? ''}`), 9, 80), { size: 9, color: C.ink });
    b.y = 88;
    b.absaetze([
      `Hallo ${t(m.vorname)},`,
      `im Vereinsportal des ${v.name} siehst und pflegst du deine Mitgliedsdaten, buchst Hallen- und Freiplätze, meldest dich zu Veranstaltungen an und erfasst deinen Clubhaus-Verzehr.`,
      'Dein persönlicher Zugang ist vorbereitet: Scanne den QR-Code mit dem Smartphone (oder gib den Link ein), wähle Benutzername und Kennwort – fertig. Eine weitere Prüfung durch den Verein ist nicht nötig.',
    ], C.ink, 120);
    const y = 92;
    p.qr(link, 150, y, 42);
    p.text(150, y + 47, 'Persönlicher Zugang', { size: 7, color: C.grau });
    b.y = Math.max(b.y, y + 50);
    b.ueberschrift('Link');
    b.absaetze([link], C.ink, 174);
    b.absaetze([`Gültig bis ${bis}. Der Code gilt nur für dich und nur einmal – bitte nicht weitergeben. Fragen? ${v.ansprechpartner || v.name}${v.email ? `, ${v.email}` : ''}.`], C.grau);
  });
  return b.fertig();
}

/** Sammellauf: Mitglieder mit E-Mail per Mail (sofern nicht „brief“), alle übrigen als Brief-PDF */
export async function einladen(tx: Db, v: Verein, o: { adrnrs: string[] | null; tage: number; brief: boolean; wer: string; vorlage?: MailVorlage | null; cc?: string | null }) {
  const url = await urlPflicht();
  const alle = await kandidaten(tx);
  const auswahl = o.adrnrs ? alle.filter((k) => o.adrnrs!.includes(k.adrnr)) : alle;
  if (!auswahl.length) throw new BusinessError('Keine Mitglieder ohne Benutzer ausgewählt.');
  const bis = new Date(Date.now() + o.tage * 86_400_000).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
  const post: { m: Record<string, any>; link: string; bis: string }[] = [];
  const r = { gesendet: 0, briefe: 0, fehler: [] as string[], pdf: null as string | null };
  for (const k of auswahl) {
    const [m] = await tx`select * from tco.mitglieder where adrnr = ${k.adrnr}`;
    const perMail = !o.brief && !!k.email && !!v.n8n_mail_url;
    const token = await einladungErzeugen(tx, k.adrnr, perMail ? 'MAIL' : 'BRIEF', o.wer, o.tage * 24);
    const link = einladungsLink(url, token);
    if (perMail) {
      try {
        await einladungsMail(v, m, k.email, link, bis, o.wer, { art: 'EINLADUNG', adrnr: k.adrnr, stunden: o.tage * 24, weg: 'MAIL' }, o.cc ?? undefined, o.vorlage);
        r.gesendet++;
        continue;
      } catch (e) {
        r.fehler.push(`${t(`${k.vorname} ${k.nachname}`)}: ${(e as Error).message} – als Brief`);
        await tx`update tco.einladungen set weg = 'BRIEF' where token_hash = ${sha256(token)}`;
      }
    }
    post.push({ m, link, bis });
  }
  if (post.length) {
    r.pdf = (await briefe(v, post)).toString('base64');
    r.briefe = post.length;
  }
  return r;
}

/** Schnellweg Registrierung: genau ein aktives Mitglied ohne Benutzer mit dieser E-Mail und diesem Geburtsdatum */
export async function schnellwegPruefen(tx: Db, v: Verein, email: string, geburtsdatum: string): Promise<boolean> {
  const treffer = await tx`select m.* from tco.mitglieder m
                            where lower(trim(coalesce(m.email, ''))) = ${email.trim().toLowerCase()} and m.geburtsdatum = ${geburtsdatum}::date
                              and ${aktivOhneBenutzer(tx)}`;
  if (treffer.length !== 1 || !v.n8n_mail_url) return false;
  const url = await portalUrl();
  if (!url) return false;
  const m = treffer[0];
  const token = await einladungErzeugen(tx, m.adrnr, 'REGISTRIERUNG', 'Registrierung', 24);
  const link = einladungsLink(url, token);
  const bis = new Date(Date.now() + 86_400_000).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
  const { betreff, text } = mailText(v, m, link, bis);
  const e = await mailSenden(v, { modus: 'senden', anwendung: 'Registrierung', objekt: m.adrnr, an: m.email.trim(), betreff, text, benutzer: 'Registrierung', anhaenge: [],
    wiederholung: { art: 'EINLADUNG', adrnr: m.adrnr, stunden: 24, weg: 'REGISTRIERUNG' } });
  if (e.status === 'fehler') throw new BusinessError('Die E-Mail konnte nicht gesendet werden. Bitte später erneut versuchen.');
  return true;
}

/** Einladungsmail mit Link und QR-Code (Sammellauf und „Erneut senden“ im Mailprotokoll) */
async function einladungsMail(v: Verein, m: Record<string, any>, an: string, link: string, bis: string, wer: string, w: Wiederholung, cc?: string, vorlage?: MailVorlage | null) {
  const { betreff, text } = mailText(v, m, link, bis, vorlage);
  const png = await QRCode.toBuffer(link, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 480 });
  const e = await mailSenden(v, {
    modus: 'senden', anwendung: 'Mitglieder', objekt: m.adrnr, an, cc: cc ?? '', betreff, text, benutzer: wer,
    anhaenge: [{ dateiname: 'Zugang-QR-Code.png', mime: 'image/png', inhalt: png, objekt: m.adrnr }], wiederholung: w,
  });
  if (e.status === 'fehler') throw new Error(e.fehler ?? 'Versand fehlgeschlagen');
}

/**
 * Mailprotokoll → „Erneut senden“: neuen Einladungslink erzeugen (ältere werden ungültig, der Link selbst wird nie gespeichert)
 * und an die beim Verein hinterlegte Adresse senden – nur solange das Mitglied aktiv ist und noch keinen Benutzer hat.
 */
export async function einladungErneut(tx: Db, v: Verein, w: { adrnr: string; stunden: number; weg: 'MAIL' | 'REGISTRIERUNG' }, wer: string, cc?: string): Promise<string> {
  const url = await urlPflicht();
  const [m] = await tx`select m.* from tco.mitglieder m where m.adrnr = ${w.adrnr} and ${aktivOhneBenutzer(tx)}`;
  if (!m) throw new BusinessError('Das Mitglied ist nicht mehr aktiv oder hat inzwischen einen Benutzer – eine Einladung ist nicht mehr nötig.');
  const an = String(m.email ?? '').trim();
  if (!an) throw new BusinessError('Für das Mitglied ist keine E-Mail-Adresse mehr hinterlegt.');
  const token = await einladungErzeugen(tx, w.adrnr, w.weg, wer, w.stunden);
  const bis = new Date(Date.now() + w.stunden * 3600_000).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
  await einladungsMail(v, m, an, einladungsLink(url, token), bis, wer, { art: 'EINLADUNG', ...w }, cc);
  return `Neuer Einladungslink an ${an} gesendet (gültig bis ${bis}); ältere Links sind ungültig.`;
}

async function gueltig(db: Db, token: string) {
  if (!token || token.length < 20) return null;
  const [e] = await db`select e.id, e.adrnr, m.vorname, m.nachname, nullif(trim(coalesce(m.email, '')), '') as email
                         from tco.einladungen e join tco.mitglieder m on m.adrnr = e.adrnr
                        where e.token_hash = ${sha256(token)} and e.verwendet_am is null and e.gueltig_bis > now()
                          and ${aktivOhneBenutzer(db)}`;
  return e ?? null;
}

export async function einladungLesen(db: Db, token: string) {
  const e = await gueltig(db, token);
  if (!e) return { gueltig: false as const };
  const alias = t(`${e.vorname ?? ''}.${e.nachname ?? ''}`).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9._-]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
  return { gueltig: true as const, vorname: e.vorname ?? '', nachname: e.nachname ?? '', benutzername: await freierBenutzername(db, e.email, alias || `mitglied.${e.adrnr}`, `m${e.adrnr}`) };
}

export async function einloesen(tx: Db, token: string, d: { benutzername: string; passwort: string }) {
  const e = await gueltig(tx, token);
  if (!e) throw new BusinessError('Der Link ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte beim Verein eine neue Einladung anfordern oder registrieren.', 410);
  const f = validatePassword(d.passwort);
  if (f) throw new BusinessError(f);
  const uid = await benutzerAnlegen(tx, {
    username: d.benutzername, displayName: t(`${e.nachname ?? ''}, ${e.vorname ?? ''}`).replace(/^, |, $/g, ''),
    email: e.email, passwortHash: await hashPassword(d.passwort), mussAendern: false, rolle: ROLLE_MITGLIED,
  });
  await tx`insert into tco.mitgliedera (adrnr, benutzer_id) values (${e.adrnr}, ${uid})
           on conflict (adrnr) do update set benutzer_id = excluded.benutzer_id`;
  await tx`update tco.einladungen set verwendet_am = now(), benutzer_id = ${uid} where id = ${e.id}`;
  await tx`update tco.einladungen set gueltig_bis = least(gueltig_bis, now()) where adrnr = ${e.adrnr} and verwendet_am is null`;
  return { username: d.benutzername, name: t(`${e.vorname ?? ''} ${e.nachname ?? ''}`) };
}
