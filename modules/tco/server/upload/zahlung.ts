/**
 * Dokumenten-Upload mit Folgeaktion „Überweisung an Einreicher“: Zahlungsdaten für den Kassenwart im Arbeitsvorrat –
 * Empfänger und Bankverbindung des Einreichers aus dem Mitgliederstamm, dazu ein QR-Code für die Banking-App
 * (EPC-QR-Code „GiroCode“, SEPA-Überweisung). Der Betrag steht nicht am Upload; er wird im Popup eingegeben und
 * in den Code übernommen – ohne Betrag fragt die Banking-App danach.
 */
import QRCode from 'qrcode';
import { BusinessError } from '../../../../server/src/errors.js';
import { ibanGueltig, normalisieren } from '../../../../server/src/lib/sepa.js';
import { epcText, feldText } from './epc.js';
import type { Db } from '../verein.js';
import { condense, ibanFormat } from '../format.js';

export { epcText };

/**
 * Einreicher im Mitgliederstamm finden: ausdrücklich gewähltes Mitglied (`adrnr`), sonst über den Benutzer des Uploads, sonst über
 * den Namen – als Anzeigename/Benutzername eines Portal-Benutzers mit verknüpftem Mitglied oder direkt als Name eines Mitglieds
 * („Vorname Nachname“ bzw. „Nachname, Vorname“). Nur eindeutige Treffer zählen.
 */
export async function einreicherLesen(db: Db, f: { benutzer_id: string | null; einreicher: string; adrnr?: string | null }) {
  const spalten = db`m.adrnr, m.vorname, m.nachname, m.iban1, m.bic1, m.bank1, m.abwkontoinh`;
  if (f.adrnr) {
    const [m] = await db`select ${spalten} from tco.mitglieder m where m.adrnr = ${f.adrnr}`;
    if (!m) throw new BusinessError('Das gewählte Mitglied gibt es nicht.', 404);
    return m;
  }
  let benutzer = f.benutzer_id;
  const name = condense(f.einreicher);
  if (!benutzer && name) {
    const u = await db`select id from core.users where lower(display_name) = lower(${name}) or lower(username) = lower(${name})`;
    if (u.length === 1) benutzer = u[0].id as string;
  }
  if (benutzer) {
    const [m] = await db`select ${spalten} from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = ${benutzer}`;
    if (m) return m;
  }
  if (!name) return null;
  const l = await db`select ${spalten} from tco.mitglieder m
                      where lower(trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, ''))) = lower(${name})
                         or lower(trim(coalesce(m.nachname, '') || ', ' || coalesce(m.vorname, ''))) = lower(${name})
                      order by (m.austritt is null or m.austritt >= current_date) desc, m.adrnr`;
  // gleichnamige Mitglieder lassen sich nicht unterscheiden – dann wird von Hand gewählt
  if (l.length === 1) return l[0];
  return null;
}

/** Mitglieder für die Auswahl des Empfängers (Live-Suche nach Name oder Mitgliedsnummer), aktive zuerst */
export async function mitgliederSuchen(db: Db, q: string): Promise<{ adrnr: string; name: string; info: string }[]> {
  const worte = condense(q).toLowerCase().split(' ').filter(Boolean).slice(0, 4);
  if (!worte.length) return [];
  const rows = await db`select adrnr, vorname, nachname, ort, iban1, (austritt is not null and austritt < current_date) as weg from tco.mitglieder
                         where ${worte.reduce((a, w) => db`${a} and lower(coalesce(vorname, '') || ' ' || coalesce(nachname, '') || ' ' || adrnr) like ${`%${w}%`}`, db`true`)}
                         order by weg, nachname, vorname, adrnr limit 25`;
  return rows.map((r) => ({
    adrnr: r.adrnr as string, name: condense(`${r.vorname ?? ''} ${r.nachname ?? ''}`),
    info: [r.ort ?? '', r.weg ? 'ausgetreten' : '', normalisieren(r.iban1 as string | null) ? '' : 'ohne IBAN'].filter(Boolean).join(' · '),
  }));
}

export interface ZahlungDaten {
  id: number; titel: string; einreicher: string; dok_id: number | null; am: string;
  empfaenger: string | null; iban: string | null; iban_text: string | null; bic: string | null; bank: string | null; adrnr: string | null;
  betrag: number | null; zweck: string;
  /** QR-Code als PNG (Daten-URL) und sein Inhalt; null, solange die Bankverbindung fehlt */
  qr: string | null; epc: string | null; hinweis: string | null;
  /** was im QR-Code hinterlegt ist – zum Anzeigen neben dem Code */
  inhalt: { label: string; wert: string }[];
}

/** Zahlungsdaten zu einem offenen Upload „Überweisung an Einreicher“ */
export async function zahlungLesen(db: Db, id: number, betrag: number | null, zweck: string | null, adrnr: string | null = null): Promise<ZahlungDaten> {
  const [f] = await db`select id, dok_id, titel, einreicher, benutzer_id, to_char(am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am
                         from tco.upload_folge where id = ${id} and folgeaktion ~* 'überweisung[[:space:]]+an[[:space:]]+einreicher'`;
  if (!f) throw new BusinessError('Den Eintrag gibt es nicht (mehr).', 404);
  return zahlungBauen(db, { id: Number(f.id), titel: f.titel as string, einreicher: f.einreicher as string, benutzer_id: (f.benutzer_id as string | null) ?? null,
    dok_id: (f.dok_id as number | null) ?? null, am: f.am as string }, betrag, zweck, adrnr);
}

/** Zahlungsdaten und QR-Code zu einem Beleg: Empfänger und IBAN über den Einreicher im Mitgliederstamm */
export async function zahlungBauen(db: Db, f: { id: number; titel: string; einreicher: string; benutzer_id: string | null; dok_id: number | null; am: string },
  betrag: number | null, zweck: string | null, adrnr: string | null = null): Promise<ZahlungDaten> {
  const m = f.einreicher || f.benutzer_id || adrnr ? await einreicherLesen(db, { benutzer_id: f.benutzer_id, einreicher: f.einreicher, adrnr }) : null;
  const text = feldText(zweck ?? `Erstattung ${f.titel}`, 140);
  const basis = { id: f.id, titel: f.titel, einreicher: f.einreicher, dok_id: f.dok_id, am: f.am, betrag, zweck: text };
  const leer = { empfaenger: null, iban: null, iban_text: null, bic: null, bank: null, adrnr: null, qr: null, epc: null, inhalt: [] };
  if (!m && !f.einreicher && !f.benutzer_id) return { ...basis, ...leer, hinweis: 'Zu diesem Beleg ist kein Einreicher angegeben – bitte das Mitglied wählen.' };
  if (!m) return { ...basis, ...leer, hinweis: `„${f.einreicher}“ ließ sich keinem Mitglied eindeutig zuordnen – bitte das Mitglied wählen.` };
  const empfaenger = condense((m.abwkontoinh as string | null) ?? '') || condense(`${m.vorname ?? ''} ${m.nachname ?? ''}`);
  const iban = normalisieren(m.iban1 as string | null);
  const person = { empfaenger, adrnr: m.adrnr as string, bic: normalisieren(m.bic1 as string | null) || null, bank: (m.bank1 as string | null) || null };
  if (!iban) return { ...basis, ...leer, ...person, hinweis: `Im Mitgliederstamm von ${empfaenger} ist keine IBAN hinterlegt.` };
  if (!ibanGueltig(iban)) return { ...basis, ...leer, ...person, iban, iban_text: ibanFormat(iban), hinweis: 'Die IBAN im Mitgliederstamm ist ungültig – kein QR-Code.' };
  const epc = epcText({ empfaenger, iban, bic: person.bic ?? '', betrag, zweck: text });
  const qr = await QRCode.toDataURL(epc, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  const inhalt = [
    { label: 'Empfänger', wert: feldText(empfaenger, 70) },
    { label: 'IBAN', wert: ibanFormat(iban) },
    ...(person.bic ? [{ label: 'BIC', wert: person.bic }] : []),
    { label: 'Betrag', wert: betrag != null ? `${betrag.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR` : 'nicht enthalten – die Banking-App fragt danach' },
    { label: 'Verwendungszweck', wert: text || 'leer' },
    { label: 'Art', wert: 'SEPA-Überweisung (EPC-QR-Code „GiroCode“, Version 002); kein Ausführungsdatum, keine Referenz, sonst keine Daten' },
  ];
  return { ...basis, ...person, iban, iban_text: ibanFormat(iban), qr, epc, inhalt, hinweis: betrag == null ? 'Ohne Betrag: Die Banking-App fragt beim Scannen danach.' : null };
}
