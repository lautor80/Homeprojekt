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

/** Einreicher eines Uploads im Mitgliederstamm: über den Benutzer des Uploads, sonst über den eindeutigen Anzeigenamen */
export async function einreicherLesen(db: Db, f: { benutzer_id: string | null; einreicher: string }) {
  let benutzer = f.benutzer_id;
  if (!benutzer) {
    const u = await db`select id from core.users where lower(display_name) = lower(${f.einreicher}) or lower(username) = lower(${f.einreicher})`;
    if (u.length === 1) benutzer = u[0].id as string;
  }
  if (!benutzer) return null;
  const [m] = await db`select m.adrnr, m.vorname, m.nachname, m.iban1, m.bic1, m.bank1, m.abwkontoinh
                         from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr where a.benutzer_id = ${benutzer}`;
  return m ?? null;
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
export async function zahlungLesen(db: Db, id: number, betrag: number | null, zweck: string | null): Promise<ZahlungDaten> {
  const [f] = await db`select id, dok_id, titel, einreicher, benutzer_id, to_char(am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am
                         from tco.upload_folge where id = ${id} and folgeaktion ~* 'überweisung[[:space:]]+an[[:space:]]+einreicher'`;
  if (!f) throw new BusinessError('Den Eintrag gibt es nicht (mehr).', 404);
  return zahlungBauen(db, { id: Number(f.id), titel: f.titel as string, einreicher: f.einreicher as string, benutzer_id: (f.benutzer_id as string | null) ?? null,
    dok_id: (f.dok_id as number | null) ?? null, am: f.am as string }, betrag, zweck);
}

/** Zahlungsdaten und QR-Code zu einem Beleg: Empfänger und IBAN über den Einreicher im Mitgliederstamm */
export async function zahlungBauen(db: Db, f: { id: number; titel: string; einreicher: string; benutzer_id: string | null; dok_id: number | null; am: string },
  betrag: number | null, zweck: string | null): Promise<ZahlungDaten> {
  const m = f.einreicher || f.benutzer_id ? await einreicherLesen(db, { benutzer_id: f.benutzer_id, einreicher: f.einreicher }) : null;
  const text = feldText(zweck ?? `Erstattung ${f.titel}`, 140);
  const basis = { id: f.id, titel: f.titel, einreicher: f.einreicher, dok_id: f.dok_id, am: f.am, betrag, zweck: text };
  const leer = { empfaenger: null, iban: null, iban_text: null, bic: null, bank: null, adrnr: null, qr: null, epc: null, inhalt: [] };
  if (!f.einreicher && !f.benutzer_id) return { ...basis, ...leer, hinweis: 'Zu diesem Beleg ist kein Einreicher bekannt (nicht über den Dokumenten-Upload des Portals geladen).' };
  if (!m) return { ...basis, ...leer, hinweis: `Zu „${f.einreicher}“ gibt es kein Mitglied mit verknüpftem Portal-Benutzer – die Bankverbindung lässt sich nicht ermitteln.` };
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
