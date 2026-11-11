import { randomBytes } from 'node:crypto';
import { sha256 } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { addTage, condense, heute } from '../format.js';
import { emailGueltig, normName, vertragsarten } from '../mitglieder/logik.js';
import { alter, ALTER_JUGENDBEITRAG_BIS, ALTER_TRAINING_BIS, istFamilienbeitrag, istJugendbeitrag, kategorieVon, MAX_PERSONEN, MAX_TRAINING } from './logik.js';

/**
 * Vertragsangebot (#12): Der Vorstand bereitet den Mitgliedsantrag vor – Personen aus dem Mitgliederstamm (ohne Mitgliedschaft,
 * z. B. Interessenten, Schnupperer) oder neu erfasst, dazu Mitgliedschaft, Trainingseinheiten und Eintritt. Die Person erhält per
 * E-Mail nur einen Link mit Zufallsschlüssel (gespeichert wird nur dessen Hash; keine Daten in Mail oder Adresse). Zum Öffnen
 * fragt das Formular das Geburtsdatum ab (zweiter Faktor, höchstens 5 Fehlversuche), der Link gilt 30 Tage und nur einmal.
 * Angenommen wird über den normalen Antrag (/beitritt): IBAN und SEPA-Mandat, Zustimmungen – danach Eingang und Übernahme wie gewohnt;
 * Personen aus dem Stamm werden dabei zu Mitgliedern (derselbe Stammsatz, keine Dublette).
 */
export const ANGEBOT_TAGE = 30;
export const ANGEBOT_VERSUCHE = 5;

export interface AngebotPerson {
  adrnr?: string | null; anrede: string; vorname: string; nachname: string; geburtsdatum: string | null;
  email?: string | null; telefon?: string | null; art?: string | null; training: string[];
}
export interface AngebotDaten {
  personen: AngebotPerson[];
  strasse: string; plz: string; ort: string; email: string; telefon: string | null;
  erziehungsberechtigt: string | null; eintritt: string; bemerkung: string | null;
}
export interface AngebotEingabe {
  personen: { adrnr?: string | null; anrede?: string | null; vorname?: string | null; nachname?: string | null; geburtsdatum?: string | null; email?: string | null; art?: string | null; training?: string[] }[];
  eintritt: string; email?: string | null; erziehungsberechtigt?: string | null; bemerkung?: string | null;
}

const leer = (x: unknown) => (x === null || x === undefined ? '' : String(x).trim());

/** Personen im Mitgliederstamm ohne Mitgliedschaft (Interessenten, Schnupperer) – Auswahl für das Angebot */
export async function angebotKandidaten(db: Db, suche: string) {
  const q = `%${suche.trim().toLowerCase()}%`;
  const rows = await db`
    select m.adrnr, m.anrede, m.vorname, m.nachname, m.geburtsdatum::text as geburtsdatum, m.strasse, m.plz, m.ort, m.email,
           coalesce(nullif(m.telefon6, ''), m.telefon) as telefon, s.nummer as schnupper
      from tco.mitglieder m left join tco.schnupper s on s.adrnr = m.adrnr and s.status <> 'MITGLIED'
     where coalesce(m.mitglnrn, '') = '' and m.eintritt is null
       and (${suche.trim()} = '' or lower(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '') || ' ' || coalesce(m.ort, '') || ' ' || coalesce(m.email, '')) like ${q})
     order by m.nachname, m.vorname limit 50`;
  return rows.map((r) => ({
    adrnr: r.adrnr as string, name: condense(`${leer(r.vorname)} ${leer(r.nachname)}`), anrede: leer(r.anrede), vorname: leer(r.vorname), nachname: leer(r.nachname),
    geburtsdatum: r.geburtsdatum as string | null, ort: leer(r.ort), email: leer(r.email), schnupper: r.schnupper as string | null,
  }));
}

/** Angebot vorbereiten: Stammdaten übernehmen, Verträge nach den Regeln des Online-Antrags prüfen, Link erzeugen */
export async function angebotAnlegen(tx: Db, e: AngebotEingabe, wer: string): Promise<{ id: number; nummer: string; token: string; email: string; name: string; gueltigBis: string }> {
  if (!e.personen.length) throw new BusinessError('Bitte mindestens eine Person angeben.');
  if (e.personen.length > MAX_PERSONEN) throw new BusinessError(`Höchstens ${MAX_PERSONEN} Personen je Antrag.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.eintritt) || e.eintritt < heute()) throw new BusinessError('Der Eintritt kann frühestens heute sein.');
  const { arten } = await vertragsarten(tx, e.eintritt);
  const art = new Map(arten.map((a) => [a.art, { ...a, kategorie: kategorieVon(a.art, a.name) }]));
  const personen: AngebotPerson[] = [];
  let adresse: { strasse: string; plz: string; ort: string; telefon: string | null } = { strasse: '', plz: '', ort: '', telefon: null };
  for (const [i, x] of e.personen.entries()) {
    let p: AngebotPerson;
    if (x.adrnr) {
      const [m] = await tx`select adrnr, anrede, vorname, nachname, geburtsdatum::text as geburtsdatum, strasse, plz, ort, email, telefon, telefon6, mitglnrn, eintritt
                             from tco.mitglieder where adrnr = ${x.adrnr}`;
      if (!m) throw new BusinessError(`Stammsatz ${x.adrnr} nicht gefunden.`);
      if (leer(m.mitglnrn) || m.eintritt) {
        throw new BusinessError(`${condense(`${leer(m.vorname)} ${leer(m.nachname)}`)} ist bereits Mitglied – ein Vertragsangebot ist für Personen ohne Mitgliedschaft (Vertragsänderungen im Mitgliederstamm).`);
      }
      p = {
        adrnr: m.adrnr, anrede: ['Herr', 'Frau', 'Divers'].includes(leer(m.anrede)) ? leer(m.anrede) : '', vorname: leer(m.vorname), nachname: leer(m.nachname),
        geburtsdatum: m.geburtsdatum ?? null, email: leer(m.email) || null, telefon: leer(m.telefon6) || leer(m.telefon) || null, art: null, training: [],
      };
      if (i === 0) adresse = { strasse: leer(m.strasse), plz: leer(m.plz), ort: leer(m.ort), telefon: p.telefon ?? null };
    } else {
      if (!condense(x.vorname ?? '') || !condense(x.nachname ?? '')) throw new BusinessError(`Person ${i + 1}: Bitte Vor- und Nachname angeben oder eine Person aus dem Stamm wählen.`);
      p = {
        adrnr: null, anrede: ['Herr', 'Frau', 'Divers'].includes(leer(x.anrede)) ? leer(x.anrede) : '', vorname: condense(x.vorname ?? ''), nachname: condense(x.nachname ?? ''),
        geburtsdatum: x.geburtsdatum || null, email: leer(x.email) || null, telefon: null, art: null, training: [],
      };
    }
    // Verträge wie im Online-Antrag: Antragsteller genau eine Mitgliedschaft, weitere Personen über den Familienbeitrag
    const wer2 = e.personen.length > 1 ? `${p.vorname} ${p.nachname}: ` : '';
    const a = p.geburtsdatum ? alter(p.geburtsdatum, e.eintritt) : null;
    if (i === 0) {
      const m = art.get(x.art ?? '');
      if (!m || m.kategorie !== 'MITGLIEDSCHAFT') throw new BusinessError(`${wer2}Bitte eine Mitgliedschaft wählen.`);
      if (istJugendbeitrag(m.name) && a !== null && a > ALTER_JUGENDBEITRAG_BIS) throw new BusinessError(`${wer2}Ab 18 Jahren ist kein Jugendbeitrag möglich.`);
      if (e.personen.length > 1 && !istFamilienbeitrag(m.name)) throw new BusinessError('Weitere Personen sind nur mit dem Familienbeitrag möglich.');
      p.art = m.art;
    }
    const tr = (x.training ?? []).filter(Boolean);
    if (tr.length > MAX_TRAINING) throw new BusinessError(`${wer2}Höchstens ${MAX_TRAINING} Trainingseinheiten.`);
    for (const t of tr) if (art.get(t)?.kategorie !== 'TRAINING') throw new BusinessError(`${wer2}Unbekannte Trainingseinheit.`);
    if (tr.length && a !== null && a > ALTER_TRAINING_BIS) throw new BusinessError(`${wer2}Jugendtraining gibt es nur bis 21 Jahre.`);
    p.training = tr;
    personen.push(p);
  }
  const namen = personen.map((p) => normName(`${p.vorname} ${p.nachname}`));
  if (new Set(namen).size !== namen.length) throw new BusinessError('Eine Person ist doppelt im Angebot.');
  const email = leer(e.email) || personen[0].email || '';
  if (!emailGueltig(email)) throw new BusinessError('Bitte eine gültige E-Mail-Adresse für den Link angeben.');

  const daten: AngebotDaten = {
    personen, ...adresse, email, erziehungsberechtigt: condense(e.erziehungsberechtigt ?? '') || null, eintritt: e.eintritt,
    bemerkung: (e.bemerkung ?? '').trim() || null,
  };
  const jahr = heute().slice(0, 4);
  const [{ n }] = await tx`select core.next_number('TCO_ANGEBOT', ${Number(jahr)})::int as n`;
  const nummer = `VA-${jahr}-${String(n).padStart(4, '0')}`;
  const token = randomBytes(32).toString('base64url');
  const gueltigBis = addTage(heute(), ANGEBOT_TAGE);
  const [r] = await tx`insert into tco.vertragsangebote (nummer, token_hash, daten, email, gueltig_bis, erstellt_von)
                       values (${nummer}, ${sha256(token)}, ${tx.json(daten as never)}, ${email}, ${gueltigBis}, ${wer}) returning id`;
  return { id: Number(r.id), nummer, token, email, name: `${personen[0].vorname} ${personen[0].nachname}`, gueltigBis };
}

/** neuer Link (der alte wird ungültig), Gültigkeit wieder 30 Tage, Fehlversuche zurückgesetzt */
export async function angebotErneuern(tx: Db, id: number): Promise<{ nummer: string; token: string; email: string; name: string; gueltigBis: string }> {
  const token = randomBytes(32).toString('base64url');
  const gueltigBis = addTage(heute(), ANGEBOT_TAGE);
  const [r] = await tx`update tco.vertragsangebote set token_hash = ${sha256(token)}, gueltig_bis = ${gueltigBis}, versuche = 0, geoeffnet_am = null
                        where id = ${id} and status = 'OFFEN' returning nummer, email, daten`;
  if (!r) throw new BusinessError('Angebot nicht gefunden oder bereits angenommen/zurückgezogen.', 404);
  const p = (r.daten as AngebotDaten).personen[0];
  return { nummer: r.nummer, token, email: r.email, name: `${p.vorname} ${p.nachname}`, gueltigBis };
}

export async function angebotZurueckziehen(tx: Db, id: number): Promise<string> {
  const [r] = await tx`update tco.vertragsangebote set status = 'ZURUECKGEZOGEN' where id = ${id} and status = 'OFFEN' returning nummer`;
  if (!r) throw new BusinessError('Angebot nicht gefunden oder bereits angenommen/zurückgezogen.', 404);
  return `Vertragsangebot ${r.nummer} zurückgezogen – der Link ist ungültig.`;
}

export async function angeboteLesen(db: Db, alle: boolean) {
  const rows = await db`select id, nummer, status, daten, email, gueltig_bis::text as gueltig_bis, erstellt_am, erstellt_von, geoeffnet_am, antrag
                          from tco.vertragsangebote ${alle ? db`` : db`where status = 'OFFEN'`}
                         order by status = 'OFFEN' desc, erstellt_am desc limit 200`;
  const h = heute();
  return rows.map((r) => {
    const d = r.daten as AngebotDaten;
    return {
      id: Number(r.id), nummer: r.nummer, status: r.status === 'OFFEN' && r.gueltig_bis < h ? 'ABGELAUFEN' : r.status,
      email: r.email, gueltig_bis: r.gueltig_bis, erstellt_am: r.erstellt_am, erstellt_von: r.erstellt_von, geoeffnet_am: r.geoeffnet_am, antrag: r.antrag,
      eintritt: d.eintritt, personen: d.personen.map((p) => ({ name: `${p.vorname} ${p.nachname}`, stamm: !!p.adrnr, art: p.art ?? null, training: p.training })),
    };
  });
}

/** gültiges, offenes Angebot zum Link (für Update gesperrt) */
async function zumToken(tx: Db, token: string) {
  const [r] = await tx`select id, nummer, status, daten, gueltig_bis::text as gueltig_bis, geoeffnet_am, versuche
                         from tco.vertragsangebote where token_hash = ${sha256(token)} for update`;
  if (!r || r.status !== 'OFFEN' || r.gueltig_bis < heute()) throw new BusinessError('Der Link ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte beim Verein einen neuen Link anfordern.', 404);
  if (r.versuche >= ANGEBOT_VERSUCHE) throw new BusinessError('Der Link ist nach mehreren falschen Eingaben gesperrt. Bitte beim Verein einen neuen Link anfordern.', 423);
  return r as { id: number; nummer: string; daten: AngebotDaten; geoeffnet_am: string | null; versuche: number };
}

/**
 * Link öffnen: ohne bzw. mit falschem Geburtsdatum keine Daten (Fehlversuch wird gezählt – deshalb als Ergebnis, nicht als Fehler,
 * damit die Transaktion den Zähler sichert). Ohne hinterlegtes Geburtsdatum genügt der Link.
 */
export async function angebotOeffnen(tx: Db, token: string, geburtsdatum: string | null):
  Promise<{ geburtsdatumNoetig: true } | { fehler: string } | { nummer: string; daten: Omit<AngebotDaten, 'personen'> & { personen: Omit<AngebotPerson, 'adrnr'>[] } }> {
  const a = await zumToken(tx, token);
  const soll = a.daten.personen[0].geburtsdatum;
  if (soll) {
    if (!geburtsdatum) return { geburtsdatumNoetig: true };
    if (geburtsdatum !== soll) {
      await tx`update tco.vertragsangebote set versuche = versuche + 1 where id = ${a.id}`;
      const rest = ANGEBOT_VERSUCHE - a.versuche - 1;
      return { fehler: rest > 0 ? `Das Geburtsdatum passt nicht (noch ${rest} Versuch${rest === 1 ? '' : 'e'}).` : 'Das Geburtsdatum passt nicht – der Link ist jetzt gesperrt. Bitte beim Verein einen neuen Link anfordern.' };
    }
  }
  await tx`update tco.vertragsangebote set geoeffnet_am = coalesce(geoeffnet_am, now()) where id = ${a.id}`;
  const d = a.daten;
  return {
    nummer: a.nummer,
    daten: { ...d, eintritt: d.eintritt < heute() ? heute() : d.eintritt, personen: d.personen.map(({ adrnr: _a, ...p }) => p) },
  };
}

/**
 * Annahme über den Antrag: Angebot prüfen (geöffnet, d. h. Geburtsdatum bestätigt), Personen des Antrags über den Namen den
 * Stammsätzen zuordnen und das Angebot als angenommen kennzeichnen.
 */
export async function angebotAnnehmen(tx: Db, token: string, personen: { vorname: string; nachname: string }[], antrag: string)
  : Promise<{ nummer: string; adrnr: (string | null)[] }> {
  const a = await zumToken(tx, token);
  if (a.daten.personen[0].geburtsdatum && !a.geoeffnet_am) throw new BusinessError('Bitte das Vertragsangebot über den Link öffnen und das Geburtsdatum bestätigen.');
  const frei = new Map(a.daten.personen.filter((p) => p.adrnr).map((p) => [normName(`${p.vorname} ${p.nachname}`), p.adrnr as string]));
  const adrnr = personen.map((p) => {
    const k = normName(`${p.vorname} ${p.nachname}`);
    const x = frei.get(k) ?? null;
    frei.delete(k);
    return x;
  });
  await tx`update tco.vertragsangebote set status = 'ANGENOMMEN', antrag = ${antrag} where id = ${a.id}`;
  return { nummer: a.nummer, adrnr };
}
