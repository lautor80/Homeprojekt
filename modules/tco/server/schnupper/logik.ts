import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense, heute } from '../format.js';
import { emailGueltig, leer, normName } from '../mitglieder/logik.js';
import { mobilnummer } from '../kommunikation.js';

/**
 * Schnuppertraining (#86): öffentliche Anmeldung ohne Portalzugang. Die Person wird im Mitgliederstamm angelegt
 * (ohne Mitgliedsnummer und Eintritt – zählt damit nirgends als Mitglied) und erhält die Kategorie „Schnuppertraining“
 * über den Datensatz in tco.schnupper. Beim Beitritt übernimmt der Mitgliedsantrag denselben Stammsatz.
 */
export const EINHEITEN_KOSTENLOS = 2;
export const STUFEN = { NEU: 'Neu (noch nie gespielt)', ANFAENGER: 'Anfänger', FORTGESCHRITTEN: 'Fortgeschritten' } as const;
export type Stufe = keyof typeof STUFEN;
export const TAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;
export const ZEITEN = ['vormittags', 'nachmittags', 'abends'] as const;
export const STATUS = {
  NEU: 'Neu', KONTAKTIERT: 'Kontaktiert', TERMIN: 'Termin vereinbart', ABSOLVIERT: 'Schnuppern absolviert', MITGLIED: 'Mitglied geworden', ABGESAGT: 'Abgesagt',
} as const;
export type SchnupperStatus = keyof typeof STATUS;
/** Status, in denen die Person noch die Kategorie „Schnuppertraining“ trägt */
export const OFFEN: SchnupperStatus[] = ['NEU', 'KONTAKTIERT', 'TERMIN', 'ABSOLVIERT'];
export const ALTER_MIN = 3, ALTER_MAX = 99, ALTER_VOLLJAEHRIG = 18;

export const INFO_TEXT = `Wir bieten ${EINHEITEN_KOSTENLOS} Einheiten Schnuppertraining kostenlos an. Danach bieten wir dir an, einer Trainingsgruppe beizutreten. `
  + 'Einer unserer Vereinstrainer meldet sich bei dir. Deine Kontaktdaten nutzen wir nur für die Kontaktaufnahme zum Schnuppertraining.';

export interface Termine { tage: string[]; zeiten: string[]; text?: string | null }
export interface Anmeldung {
  vorname: string; nachname: string; alter: number; gespielt: boolean; stufe: Stufe;
  email?: string | null; mobil?: string | null;
  termine: Termine;
  erziehungsberechtigt?: string | null;
  mitteilung?: string | null;
  einwilligung: boolean;
}

export function schnupperInfo(verein: string) {
  return { verein, einheiten: EINHEITEN_KOSTENLOS, text: INFO_TEXT, stufen: STUFEN, tage: TAGE, zeiten: ZEITEN, alterMin: ALTER_MIN, alterMax: ALTER_MAX, volljaehrig: ALTER_VOLLJAEHRIG };
}

export function pruefen(d: Anmeldung): void {
  if (!condense(d.vorname) || !condense(d.nachname)) throw new BusinessError('Bitte Vor- und Nachname angeben.');
  if (!Number.isInteger(d.alter) || d.alter < ALTER_MIN || d.alter > ALTER_MAX) throw new BusinessError(`Bitte ein Alter zwischen ${ALTER_MIN} und ${ALTER_MAX} Jahren angeben.`);
  if (!(d.stufe in STUFEN)) throw new BusinessError('Bitte die Spielstärke wählen.');
  const email = leer(d.email), mobil = leer(d.mobil);
  if (!email && !mobil) throw new BusinessError('Bitte eine E-Mail-Adresse oder Handynummer angeben, damit sich ein Trainer melden kann.');
  if (email && !emailGueltig(email)) throw new BusinessError('Die E-Mail-Adresse ist ungültig.');
  if (mobil && mobil.replace(/\D/g, '').length < 6) throw new BusinessError('Die Handynummer ist ungültig.');
  if (d.termine.tage.some((t) => !(TAGE as readonly string[]).includes(t)) || d.termine.zeiten.some((z) => !(ZEITEN as readonly string[]).includes(z))) {
    throw new BusinessError('Ungültige Terminauswahl.');
  }
  if (!d.termine.tage.length && !condense(d.termine.text ?? '')) throw new BusinessError('Bitte mögliche Tage für das Schnuppertraining angeben.');
  if (d.alter < ALTER_VOLLJAEHRIG && !condense(d.erziehungsberechtigt ?? '')) throw new BusinessError('Für Kinder und Jugendliche bitte den Namen der/des Erziehungsberechtigten angeben.');
  if (!d.einwilligung) throw new BusinessError('Bitte der Nutzung der Kontaktdaten für die Kontaktaufnahme zustimmen.');
}

/** Anmeldung speichern: Stammsatz (Kategorie Schnuppertraining) und Schnupper-Angaben */
export async function anmeldungAnlegen(tx: Db, d: Anmeldung, ip: string): Promise<{ adrnr: string; nummer: string }> {
  pruefen(d);
  const vn = condense(d.vorname), nn = condense(d.nachname);
  const email = leer(d.email) || null, mobil = condense(d.mobil ?? '') || null;
  // erneute Anmeldung derselben Person (offen): nicht doppelt anlegen
  const ziffern = (x: unknown) => leer(x).replace(/\D/g, '');
  const gleich = (await tx`select s.nummer, m.email, m.telefon6 from tco.schnupper s join tco.mitglieder m on m.adrnr = s.adrnr
                            where s.status = any(${OFFEN}) and lower(m.vorname) = lower(${vn}) and lower(m.nachname) = lower(${nn})`)
    .find((x) => (email && leer(x.email).toLowerCase() === email.toLowerCase()) || (mobil && ziffern(x.telefon6) === ziffern(mobil)));
  if (gleich) throw new BusinessError(`Du bist bereits zum Schnuppertraining angemeldet (${gleich.nummer}). Ein Trainer meldet sich bei dir.`);

  const [mx] = await tx`select coalesce(max(adrnr::bigint), 0) as n from tco.mitglieder where adrnr ~ '^[0-9]{1,10}$' and adrnr not like '99%'`;
  const adrnr = String(Number(mx.n) + 1).padStart(10, '0');
  const jahr = heute().slice(0, 4);
  const [{ n }] = await tx`select core.next_number('TCO_SCHNUPPER', ${Number(jahr)})::int as n`;
  const nummer = `ST-${jahr}-${String(n).padStart(4, '0')}`;
  await tx`insert into tco.mitglieder ${tx({
    adrnr, vorname: vn, nachname: nn, alphabet: nn.slice(0, 1).toUpperCase(), email, telefon6: mobil,
    checkbox1: 'N', checkbox2: 'N', checkbox3: 'N',
  })}`;
  const termine = { tage: TAGE.filter((t) => d.termine.tage.includes(t)), zeiten: ZEITEN.filter((z) => d.termine.zeiten.includes(z)), text: condense(d.termine.text ?? '') || null };
  await tx`insert into tco.schnupper (adrnr, nummer, alter_jahre, gespielt, stufe, termine, erziehungsberechtigt, mitteilung, einwilligung_am, ip)
           values (${adrnr}, ${nummer}, ${d.alter}, ${d.gespielt}, ${d.stufe}, ${tx.json(termine as never)},
                   ${d.alter < ALTER_VOLLJAEHRIG ? condense(d.erziehungsberechtigt ?? '') : null}, ${condense(d.mitteilung ?? '') || null}, now(), ${ip})`;
  return { adrnr, nummer };
}

export interface SchnupperZeile {
  adrnr: string; nummer: string; status: SchnupperStatus; status_txt: string; eingang: string;
  vorname: string; nachname: string; email: string; mobil: string; alter: number | null; gespielt: boolean; stufe: Stufe; stufe_txt: string;
  termine: Termine; erziehungsberechtigt: string | null; mitteilung: string | null;
  einheit1: string | null; einheit2: string | null; trainer: string | null; notiz: string | null; antrag: string | null;
  bearbeitet_am: string | null; bearbeitet_von: string | null; mitglnrn: string;
  /** Handynummer international für WhatsApp (leer, wenn keine Mobilnummer) */
  whatsapp: string;
}

export async function schnupperLesen(db: Db, filter: 'OFFEN' | 'ALLE'): Promise<SchnupperZeile[]> {
  const rows = await db`select s.adrnr, s.nummer, s.status, s.eingang, s.alter_jahre, s.gespielt, s.stufe, s.termine, s.erziehungsberechtigt, s.mitteilung,
                               s.einheit1::text, s.einheit2::text, s.trainer, s.notiz, s.antrag, s.bearbeitet_am, s.bearbeitet_von,
                               m.vorname, m.nachname, m.email, m.telefon6, m.mitglnrn
                          from tco.schnupper s join tco.mitglieder m on m.adrnr = s.adrnr
                         ${filter === 'OFFEN' ? db`where s.status = any(${OFFEN})` : db``}
                         order by (s.status = 'NEU') desc, s.eingang desc limit 500`;
  return rows.map((r) => ({
    adrnr: r.adrnr, nummer: r.nummer, status: r.status, status_txt: STATUS[r.status as SchnupperStatus] ?? r.status, eingang: r.eingang,
    vorname: leer(r.vorname), nachname: leer(r.nachname), email: leer(r.email), mobil: leer(r.telefon6), alter: r.alter_jahre,
    gespielt: r.gespielt, stufe: r.stufe, stufe_txt: STUFEN[r.stufe as Stufe] ?? r.stufe, termine: { tage: [], zeiten: [], ...(r.termine ?? {}) },
    erziehungsberechtigt: r.erziehungsberechtigt, mitteilung: r.mitteilung, einheit1: r.einheit1, einheit2: r.einheit2, trainer: r.trainer,
    notiz: r.notiz, antrag: r.antrag, bearbeitet_am: r.bearbeitet_am, bearbeitet_von: r.bearbeitet_von, mitglnrn: leer(r.mitglnrn),
    whatsapp: mobilnummer(r.telefon6),
  }));
}

export interface Bearbeitung {
  status: SchnupperStatus; einheit1?: string | null; einheit2?: string | null; trainer?: string | null; notiz?: string | null;
}

/** Status und Verlauf pflegen (Trainer); „Mitglied geworden“ setzt nur die Übernahme des Mitgliedsantrags */
export async function schnupperSichern(tx: Db, adrnr: string, b: Bearbeitung, wer: string): Promise<string> {
  const [s] = await tx`select s.nummer, s.status, m.eintritt from tco.schnupper s join tco.mitglieder m on m.adrnr = s.adrnr where s.adrnr = ${adrnr} for update of s`;
  if (!s) throw new BusinessError('Schnupper-Anmeldung nicht gefunden.', 404);
  if (s.status === 'MITGLIED') throw new BusinessError(`${s.nummer}: Die Person ist bereits Mitglied – keine Änderung mehr möglich.`);
  if (b.status === 'MITGLIED') throw new BusinessError('„Mitglied geworden“ wird mit der Übernahme des Mitgliedsantrags gesetzt.');
  if (b.einheit1 && b.einheit2 && b.einheit2 < b.einheit1) throw new BusinessError('Die 2. Einheit liegt vor der 1. Einheit.');
  if (b.einheit2 && !b.einheit1) throw new BusinessError('Bitte zuerst das Datum der 1. Einheit angeben.');
  // Einheiten absolviert → Status mindestens „absolviert“, sobald beide Einheiten eingetragen sind
  const status: SchnupperStatus = b.einheit2 && ['NEU', 'KONTAKTIERT', 'TERMIN'].includes(b.status) ? 'ABSOLVIERT' : b.status;
  await tx`update tco.schnupper set status = ${status}, einheit1 = ${b.einheit1 || null}, einheit2 = ${b.einheit2 || null},
             trainer = ${condense(b.trainer ?? '') || null}, notiz = ${(b.notiz ?? '').trim() || null}, bearbeitet_am = now(), bearbeitet_von = ${wer}
           where adrnr = ${adrnr}`;
  return `${s.nummer}: ${STATUS[status]} gesichert.`;
}

/** Vorbelegung des Mitgliedsantrags über den Beitrittslink (/beitritt?schnupper=<token>) – nur offene Schnupperer */
export async function beitrittVorbelegung(db: Db, token: string) {
  const [r] = await db`select s.adrnr, s.nummer, s.erziehungsberechtigt, m.vorname, m.nachname, m.email, m.telefon6
                         from tco.schnupper s join tco.mitglieder m on m.adrnr = s.adrnr
                        where s.token = ${token} and s.status = any(${OFFEN}) and m.eintritt is null`;
  if (!r) throw new BusinessError('Der Link ist ungültig oder bereits verwendet.', 404);
  return { nummer: r.nummer as string, vorname: leer(r.vorname), nachname: leer(r.nachname), email: leer(r.email), mobil: leer(r.telefon6), erziehungsberechtigt: leer(r.erziehungsberechtigt) };
}

/** offener Schnupperer zum Token (Beitrittslink) */
export async function adrnrZumToken(db: Db, token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const [r] = await db`select s.adrnr from tco.schnupper s join tco.mitglieder m on m.adrnr = s.adrnr
                        where s.token = ${token} and s.status = any(${OFFEN}) and m.eintritt is null`;
  return r?.adrnr ?? null;
}

/**
 * Schnupperer (noch nicht Mitglied, auch abgesagte) zu einer Person des Mitgliedsantrags: über den Beitrittslink (nur
 * Antragsteller) oder gleichen Vor- und Nachnamen. Ausgeschlossen sind bereits in diesem Antrag vergebene Stammsätze.
 */
export async function schnupperFuerPerson(db: Db, p: { vorname: string; nachname: string }, tokenAdrnr: string | null, vergeben: Set<string>) {
  const kandidaten = await db`select s.adrnr, s.nummer, m.vorname, m.nachname, m.email, m.telefon6
                                from tco.schnupper s join tco.mitglieder m on m.adrnr = s.adrnr
                               where s.status <> 'MITGLIED' and m.eintritt is null and coalesce(m.mitglnrn, '') = ''
                               order by (s.status = 'ABGESAGT'), s.eingang`;
  const name = normName(`${p.vorname} ${p.nachname}`);
  const k = (tokenAdrnr ? kandidaten.find((x) => x.adrnr === tokenAdrnr && !vergeben.has(x.adrnr)) : undefined)
    ?? kandidaten.find((x) => !vergeben.has(x.adrnr) && normName(`${leer(x.vorname)} ${leer(x.nachname)}`) === name);
  return k ? { adrnr: k.adrnr as string, nummer: k.nummer as string, email: leer(k.email), mobil: leer(k.telefon6) } : null;
}

/** Beitritt: Schnupperer wurde mit dem Mitgliedsantrag Mitglied (Kategorie wechselt) */
export async function alsMitgliedMarkieren(tx: Db, adrnr: string, antrag: string, wer: string) {
  await tx`update tco.schnupper set status = 'MITGLIED', antrag = ${antrag}, bearbeitet_am = now(), bearbeitet_von = ${wer} where adrnr = ${adrnr}`;
}
